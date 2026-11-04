import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeJsonFile } from "./runtime-persistence";
import { canonicalHotSync, mergeHotSync, signHotSync, verifyHotSync } from "./hot-sync-signing";
import { HOT_SYNC_VERSION, hotSyncCounter, hotSyncName, type HotSyncCheckpoint, type HotSyncEnvelope, type HotSyncSnapshot } from "../protocol/hot-sync";
export interface HotSyncTransport {
	read(namespace: string, scope: string): Promise<HotSyncSnapshot>;
	write(snapshot: HotSyncSnapshot, content: HotSyncEnvelope): Promise<HotSyncSnapshot>;
	reset(snapshot: HotSyncSnapshot): Promise<HotSyncSnapshot>;
}
type RecordState = {
	version: 1;
	origin: string;
	npub: string;
	local: HotSyncEnvelope;
	revision: number;
	dirty: boolean;
	pendingReset: boolean;
	lastSyncedAt: string | null;
	error: string | null;
};
export class HotSyncReplica {
	private readonly file: string;
	private syncing: Promise<void> | null = null;
	constructor(private readonly config: {
		stateDir: string;
		origin: string;
		npub: string;
		nsec: string;
		namespace: string;
		scope: string;
	}, private readonly transport: HotSyncTransport) {
		if (!hotSyncName(config.namespace) || !hotSyncName(config.scope))
			throw new Error("Invalid hot-sync boundary");
		const key = createHash("sha256").update(JSON.stringify([config.origin, config.npub, config.namespace, config.scope])).digest("hex");
		this.file = path.join(config.stateDir, "hot-sync", `${key}.json`);
	}
	private load(): RecordState {
		const c = this.config;
		if (!existsSync(this.file))
			return { version: 1, origin: c.origin, npub: c.npub, local: signHotSync({ version: HOT_SYNC_VERSION, namespace: c.namespace, scope: c.scope, epoch: 0, checkpoints: [] }, c.nsec), revision: 0, dirty: false, pendingReset: false, lastSyncedAt: null, error: null };
		const r = JSON.parse(readFileSync(this.file, "utf8")) as RecordState;
		if (r.version !== 1 || r.origin !== c.origin || r.npub !== c.npub || !hotSyncCounter(r.revision) ||
			!verifyHotSync(r.local, c.npub, c.namespace, c.scope, r.local?.document?.epoch))
			throw new Error("Invalid local hot-sync record");
		return r;
	}
	private save(r: RecordState): void { writeJsonFile(this.file, r); }
	inspect(): RecordState { return this.load(); }
	capture(checkpoint: HotSyncCheckpoint): void {
		const r = this.load();
		if (r.pendingReset)
			throw new Error("Hot-memory reset is pending; retry capture after reset");
		if (r.local.document.checkpoints.some(c => c.id === checkpoint.id))
			return;
		const sequence = (r.local.document.seen?.[checkpoint.deviceId] ?? 0) + 1;
		const doc = { ...r.local.document, seen: { ...r.local.document.seen, [checkpoint.deviceId]: sequence }, checkpoints: [...r.local.document.checkpoints, { ...checkpoint, sequence }] };
		this.save({ ...r, local: signHotSync(doc, this.config.nsec), dirty: true });
	}
	resetLocally(): void {
		const r = this.load();
		this.save({ ...r, local: signHotSync({ ...r.local.document, checkpoints: [] }, this.config.nsec), pendingReset: true, dirty: true });
	}
	sync(): Promise<void> {
		if (!this.syncing)
			this.syncing = this.synchronize().finally(() => { this.syncing = null; });
		return this.syncing;
	}
	private validate(remote: HotSyncSnapshot): void {
		const c = this.config;
		if (remote.namespace !== c.namespace || remote.scope !== c.scope || !hotSyncCounter(remote.epoch) || !hotSyncCounter(remote.revision) ||
			(remote.content !== null && !verifyHotSync(remote.content, c.npub, c.namespace, c.scope, remote.epoch)))
			throw new Error("Invalid remote hot-sync record");
	}
	private async synchronize(): Promise<void> {
		const c = this.config;
		try {
			let r = this.load();
			const resetting = r.pendingReset;
			let remote = await this.transport.read(c.namespace, c.scope);
			this.validate(remote);
			if (resetting && remote.epoch === r.local.document.epoch)
				remote = await this.transport.reset(remote);
			this.validate(remote);
			r = this.load();
			if (r.pendingReset && !resetting)
				return;
			if (remote.epoch < r.local.document.epoch || (remote.epoch === r.local.document.epoch && remote.revision < r.revision))
				throw new Error("Remote hot-sync rollback rejected");
			if (remote.epoch > r.local.document.epoch || r.pendingReset) {
				// Reset is authoritative: older-epoch data must never be resurrected.
				this.save({ ...r, local: signHotSync(remote.content?.document ?? { ...r.local.document, epoch: remote.epoch, checkpoints: [] }, c.nsec), revision: remote.revision, dirty: false, pendingReset: false, lastSyncedAt: new Date().toISOString(), error: null });
				return;
			}
			const merged = remote.content ? mergeHotSync(r.local.document, remote.content.document) : r.local.document;
			const content = signHotSync(merged, c.nsec);
			this.save({ ...r, local: content, revision: remote.revision, dirty: true });
			if (remote.content && canonicalHotSync(remote.content.document) === canonicalHotSync(merged)) {
				this.save({ ...this.load(), dirty: false, lastSyncedAt: new Date().toISOString(), error: null });
				return;
			}
			const accepted = await this.transport.write(remote, content);
			this.validate(accepted);
			if (accepted.epoch !== remote.epoch || accepted.revision <= remote.revision || canonicalHotSync(accepted.content?.document) !== canonicalHotSync(content.document))
				throw new Error("Invalid hot-sync acknowledgment");
			r = this.load();
			if (r.pendingReset)
				return;
			let latest = mergeHotSync(content.document, r.local.document);
			if (canonicalHotSync(latest) === canonicalHotSync(content.document)) {
				// Only acknowledged checkpoints can leave the bounded hot window. The
				// seen vector prevents an older snapshot from resurrecting pruned IDs.
				let chars = 0;
				const checkpoints = [...latest.checkpoints].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.id.localeCompare(b.id)).filter((c, index) => {
					const size = c.goal.length + c.summary.length + JSON.stringify(c.evidence ?? "").length;
					if (index >= 12 || chars + size > 30000)
						return false;
					chars += size;
					return true;
				}).sort((a, b) => a.id.localeCompare(b.id));
				latest = { ...latest, checkpoints };
			}
			this.save({ ...r, local: signHotSync(latest, c.nsec), revision: accepted.revision, dirty: canonicalHotSync(latest) !== canonicalHotSync(content.document), lastSyncedAt: new Date().toISOString(), error: null });
		}
		catch (error) {
			const r = this.load();
			this.save({ ...r, error: "sync_failed" });
			throw error;
		}
	}
}
