import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { writeJsonFile } from "./runtime-persistence";
import { canonicalHotSync, hotSyncConflictIds, hotSyncSupersededIds, mergeHotSync, signHotSync, verifyHotSync } from "./hot-sync-signing";
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
	const dir = path.dirname(file), bytes = Buffer.byteLength(JSON.stringify(value, null, 2));
	const otherBytes = existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".json") && path.join(dir, n) !== file).reduce((sum, n) => sum + statSync(path.join(dir, n)).size, 0) : 0;
	if (bytes + otherBytes > HOT_SYNC_LOCAL_BYTES)
		throw new Error("Hot-sync local quota exceeded; existing captures are preserved");
	writeJsonFile(file, value);
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
export function retainHotSync(document: HotSyncDocument, requiredIds: Set<string> = new Set()): HotSyncDocument {
	const conflictIds = hotSyncConflictIds(document), supersededIds = hotSyncSupersededIds(document);
	const required = (c: HotSyncCheckpoint) => requiredIds.has(c.conflictOf ?? c.id);
	const size = (c: HotSyncCheckpoint) => c.goal.length + c.summary.length + JSON.stringify(c.evidence ?? "").length;
	const mandatory = document.checkpoints.filter(required);
	if (mandatory.length > 12 || mandatory.reduce((sum, c) => sum + size(c), 0) > 30000)
		throw new Error("Pending conflict group exceeds the hot-memory budget; captures remain pending");
	let chars = 0;
	const checkpoints: HotSyncCheckpoint[] = [];
	for (const c of [...document.checkpoints].sort((a, b) => Number(required(b)) - Number(required(a)) ||
		Number(supersededIds.has(a.id)) - Number(supersededIds.has(b.id)) || Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.id.localeCompare(b.id))) {
		if (checkpoints.length === 12 || chars + size(c) > 30000)
			continue;
		chars += size(c);
		checkpoints.push(c);
	}
	checkpoints.sort((a, b) => a.id.localeCompare(b.id));
	const retainedReferences = (ids: Set<string>) => [...new Set(checkpoints.flatMap(c => [c.id, ...(c.conflictOf ? [c.conflictOf] : [])]).filter(id => ids.has(id)))].sort();
	// The latest CAS revision is authoritative for acknowledged history. Retire
	// watermarks when no retained checkpoint needs them; stale bases are never unioned back.
	const seen: Record<string, number> = Object.create(null);
	for (const c of checkpoints)
		if (c.sequence)
			seen[c.deviceId] = Math.max(seen[c.deviceId] ?? 0, document.seen?.[c.deviceId] ?? 0, c.sequence);
	const { seen: _seen, withheld: _withheld, superseded: _superseded, ...rest } = document;
	const withheld = retainedReferences(conflictIds), superseded = retainedReferences(supersededIds);
	return { ...rest, checkpoints, ...(Object.keys(seen).length ? { seen } : {}), ...(withheld.length ? { withheld } : {}), ...(superseded.length ? { superseded } : {}) };
}
/** Only unacknowledged captures are merged into the authoritative remote view. */
function appendCheckpoint(document: HotSyncDocument, checkpoint: HotSyncCheckpoint): HotSyncDocument {
	// A watermark cannot acknowledge a different pending event or erase a divergent
	// same-ID claim. Merge stable identities/variants before applying retention.
	const merged = mergeHotSync({ ...document, seen: undefined }, { ...document, seen: undefined, checkpoints: [checkpoint] });
	return { ...merged, seen: { ...document.seen, [checkpoint.deviceId]: Math.max(document.seen?.[checkpoint.deviceId] ?? 0, checkpoint.sequence ?? 0) } };
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
		const captureBytes = (c: HotSyncCheckpoint) => canonicalHotSync({ ...c, id: c.conflictOf ?? c.id, conflictOf: undefined, sequence: undefined });
		if ([...r.base.document.checkpoints, ...r.pending.flatMap(e => e.document.checkpoints)].some(c => captureBytes(c) === captureBytes(checkpoint)))
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
		this.save({ ...r, base: signHotSync({ ...this.empty(), epoch: r.base.document.epoch }, this.config.nsec), pending: [], pendingReset: true, discardedByReset: r.pending.length });
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
			// Persist verified conflict evidence even if a pending upload cannot fit or fails.
			// The durable outbox stays separate, so this does not acknowledge local captures.
			if (remote.revision > r.revision) {
				r = { ...r, base: remote.content ?? signHotSync({ ...this.empty(), epoch: remote.epoch }, c.nsec), revision: remote.revision };
				this.save(r);
			}
			let merged = retainHotSync(remote.content?.document ?? { ...this.empty(), epoch: remote.epoch });
			// One bounded batch per visit makes progress fair across active scopes.
			const batch = r.pending.slice(0, 1);
			for (const envelope of batch) {
				const checkpoint = envelope.document.checkpoints[0]!;
				merged = retainHotSync(appendCheckpoint(merged, checkpoint), new Set([checkpoint.conflictOf ?? checkpoint.id]));
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
			const acknowledged = new Set(batch.map(e => e.signature));
			this.save({ ...r, base: accepted.content ?? content, pending: r.pending.filter(e => !acknowledged.has(e.signature)), revision: accepted.revision, lastSyncedAt: new Date().toISOString(), error: null });
		}
		catch (error) {
			const r = this.load();
			this.save({ ...r, error: "sync_failed" });
			throw error;
		}
	}
}
