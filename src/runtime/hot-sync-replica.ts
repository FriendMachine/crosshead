import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { writeJsonFile } from "./runtime-persistence";
import { canonicalHotSync, mergeHotSync, signHotSync, verifyHotSync } from "./hot-sync-signing";
import { HOT_SYNC_VERSION, hotSyncCounter, hotSyncName, type HotSyncCheckpoint, type HotSyncDocument, type HotSyncEnvelope, type HotSyncSnapshot } from "../protocol/hot-sync";
export interface HotSyncTransport {
	read(namespace: string, scope: string, known?: HotSyncSnapshot): Promise<HotSyncSnapshot>;
	write(snapshot: HotSyncSnapshot, content: HotSyncEnvelope): Promise<HotSyncSnapshot>;
	reset(snapshot: HotSyncSnapshot): Promise<HotSyncSnapshot>;
}
export const HOT_SYNC_LOCAL_BYTES = 64 * 1024 * 1024;
export const hotSyncTenantDirectory = (stateDir: string, origin: string, npub: string): string => path.join(stateDir, "hot-sync", createHash("sha256").update(JSON.stringify([origin, npub])).digest("hex"));
/** One quota covers snapshots, outboxes and profile/workspace metadata. */
export function writeHotSyncState(file: string, value: unknown): void {
	const dir=path.dirname(file),bytes=Buffer.byteLength(JSON.stringify(value,null,2));
	const otherBytes=existsSync(dir)?readdirSync(dir).filter(n=>n.endsWith(".json")&&path.join(dir,n)!==file).reduce((sum,n)=>sum+statSync(path.join(dir,n)).size,0):0;
	if(bytes+otherBytes>HOT_SYNC_LOCAL_BYTES)throw new Error("Hot-sync local quota exceeded; existing captures are preserved");
	writeJsonFile(file,value);
}
type RecordState = {
	version: 2;
	origin: string;
	npub: string;
	base: HotSyncEnvelope;
	pending: HotSyncEnvelope[];
	revision: number;
	pendingReset: boolean;
	lastSyncedAt: string | null;
	error: string | null;
	discardedByReset: number;
};
export type HotSyncInspection = RecordState & {
	local: HotSyncEnvelope;
	dirty: boolean;
	pendingCount: number;
	oldestPendingAt: string | null;
};
/** Retention only affects the view and acknowledged base; pending records stay durable. */
export function retainHotSync(document: HotSyncDocument): HotSyncDocument {
	let chars = 0;
	const corrected = new Set(document.checkpoints.flatMap(c => c.supersedes ?? []));
	const checkpoints = [...document.checkpoints].sort((a, b) => Number(corrected.has(a.id)) - Number(corrected.has(b.id)) ||
		Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.id.localeCompare(b.id)).filter(c => {
		const size = c.goal.length + c.summary.length + JSON.stringify(c.evidence ?? "").length;
		if (chars + size > 30000)
			return false;
		chars += size;
		return true;
	}).slice(0, 12).sort((a, b) => a.id.localeCompare(b.id));
	return { ...document, checkpoints };
}
function appendCheckpoint(document: HotSyncDocument, checkpoint: HotSyncCheckpoint): HotSyncDocument {
	if (document.checkpoints.some(c => c.id === checkpoint.id))
		return document;
	return { ...document, seen: { ...document.seen, [checkpoint.deviceId]: Math.max(document.seen?.[checkpoint.deviceId] ?? 0, checkpoint.sequence ?? 0) }, checkpoints: [...document.checkpoints, checkpoint] };
}
export class HotSyncReplica {
	private readonly file: string;
	private syncing: Promise<void> | null = null;
	private cached: {
		stamp: string;
		record: RecordState;
		inspection?: HotSyncInspection;
	} | null = null;
	private stamp(): string { const s = statSync(this.file); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
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
		const key = createHash("sha256").update(JSON.stringify([config.namespace, config.scope])).digest("hex");
		this.file = path.join(hotSyncTenantDirectory(config.stateDir, config.origin, config.npub), `${key}.json`);
	}
	private empty(): HotSyncDocument { return { version: HOT_SYNC_VERSION, namespace: this.config.namespace, scope: this.config.scope, epoch: 0, checkpoints: [] }; }
	private load(): RecordState {
		const c = this.config;
		if (!existsSync(this.file))
			return { version: 2, origin: c.origin, npub: c.npub, base: signHotSync(this.empty(), c.nsec), pending: [], revision: 0, pendingReset: false, lastSyncedAt: null, error: null, discardedByReset: 0 };
		const stamp = this.stamp();
		if (this.cached?.stamp === stamp)
			return this.cached.record;
		if (statSync(this.file).size > HOT_SYNC_LOCAL_BYTES)
			throw new Error("Hot-sync local quota exceeded");
		const r = JSON.parse(readFileSync(this.file, "utf8")) as RecordState;
		if (r.version !== 2 || r.origin !== c.origin || r.npub !== c.npub || !hotSyncCounter(r.revision) || !Array.isArray(r.pending) ||
			!verifyHotSync(r.base, c.npub, c.namespace, c.scope, r.base?.document?.epoch) ||
			!r.pending.every(e => verifyHotSync(e, c.npub, c.namespace, c.scope, r.base.document.epoch) && e.document.checkpoints.length === 1))
			throw new Error("Invalid local hot-sync record");
		this.cached = { stamp, record: r };
		return r;
	}
	private save(r: RecordState): void {
		writeHotSyncState(this.file, r);
		this.cached = { stamp: this.stamp(), record: r };
	}
	inspect(): HotSyncInspection {
		const r = this.load();
		if (this.cached?.record === r && this.cached.inspection)
			return structuredClone(this.cached.inspection);
		let document = r.base.document;
		for (const envelope of r.pending)
			document = retainHotSync(appendCheckpoint(document, envelope.document.checkpoints[0]!));
		const inspection = { ...r, local: signHotSync(document, this.config.nsec), dirty: r.pendingReset || r.pending.length > 0, pendingCount: r.pending.length, oldestPendingAt: r.pending[0]?.document.checkpoints[0]?.occurredAt ?? null };
		if (this.cached?.record === r)
			this.cached.inspection = inspection;
		return structuredClone(inspection);
	}
	capture(checkpoint: HotSyncCheckpoint): void {
		const r = this.load();
		if (r.pendingReset)
			throw new Error("Hot-memory reset is pending; retry capture after reset");
		if ([...r.base.document.checkpoints, ...r.pending.flatMap(e => e.document.checkpoints)].some(c => c.id === checkpoint.id))
			return;
		const sequence = Math.max(r.base.document.seen?.[checkpoint.deviceId] ?? 0, ...r.pending.map(e => e.document.seen?.[checkpoint.deviceId] ?? 0)) + 1;
		const record = { ...checkpoint, sequence };
		if (checkpoint.goal.length + checkpoint.summary.length + JSON.stringify(checkpoint.evidence ?? "").length > 30000)
			throw new Error("Checkpoint exceeds the hot-memory budget");
		const envelope = signHotSync({ ...this.empty(), epoch: r.base.document.epoch, seen: { [checkpoint.deviceId]: sequence }, checkpoints: [record] }, this.config.nsec);
		// Verify the eventual single-record view fits too, before acknowledging capture.
		signHotSync(retainHotSync(appendCheckpoint(r.base.document, record)), this.config.nsec);
		this.save({ ...r, pending: [...r.pending, envelope] });
	}
	resetLocally(): void {
		const r = this.load();
		this.save({ ...r, base: signHotSync({ ...r.base.document, checkpoints: [] }, this.config.nsec), pending: [], pendingReset: true, discardedByReset: r.pending.length });
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
			let remote = await this.transport.read(c.namespace, c.scope, { namespace: c.namespace, scope: c.scope, epoch: r.base.document.epoch, revision: r.revision, content: r.base });
			this.validate(remote);
			if (resetting && remote.epoch === r.base.document.epoch)
				remote = await this.transport.reset(remote);
			this.validate(remote);
			r = this.load();
			if (r.pendingReset && !resetting)
				return;
			if (remote.epoch < r.base.document.epoch || (remote.epoch === r.base.document.epoch && remote.revision < r.revision))
				throw new Error("Remote hot-sync rollback rejected");
			if (remote.epoch > r.base.document.epoch || r.pendingReset) {
				this.save({ ...r, base: remote.content ?? signHotSync({ ...this.empty(), epoch: remote.epoch }, c.nsec), pending: [], revision: remote.revision, pendingReset: false, lastSyncedAt: new Date().toISOString(), error: null, discardedByReset: r.discardedByReset + r.pending.length });
				return;
			}
			let merged = retainHotSync(remote.content ? mergeHotSync(r.base.document, remote.content.document) : r.base.document);
			// One bounded batch per visit makes progress fair across active scopes.
			const batch = r.pending.slice(0, 1);
			for (const envelope of batch) {
				const checkpoint = envelope.document.checkpoints[0]!;
				// Keep the newly accepted checkpoint even when its device clock is old.
				let prior = retainHotSync(merged).checkpoints.filter(c => c.id !== checkpoint.id);
				while (prior.length >= 12 || [...prior, checkpoint].reduce((n, c) => n + c.goal.length + c.summary.length + JSON.stringify(c.evidence ?? "").length, 0) > 30000)
					prior.pop();
				merged = appendCheckpoint({ ...merged, checkpoints: prior }, checkpoint);
			}
			const content = signHotSync(merged, c.nsec);
			let accepted = remote;
			if (batch.length || (remote.content && canonicalHotSync(remote.content.document) !== canonicalHotSync(merged)))
				accepted = await this.transport.write(remote, content);
			this.validate(accepted);
			if (accepted !== remote && (accepted.epoch !== remote.epoch || accepted.revision <= remote.revision || canonicalHotSync(accepted.content?.document) !== canonicalHotSync(content.document)))
				throw new Error("Invalid hot-sync acknowledgment");
			r = this.load();
			if (r.pendingReset)
				return;
			const acknowledged = new Set(batch.map(e => e.document.checkpoints[0]!.id));
			this.save({ ...r, base: accepted.content ?? content, pending: r.pending.filter(e => !acknowledged.has(e.document.checkpoints[0]!.id)), revision: accepted.revision, lastSyncedAt: new Date().toISOString(), error: null });
		}
		catch (error) {
			const r = this.load();
			this.save({ ...r, error: "sync_failed" });
			throw error;
		}
	}
}
