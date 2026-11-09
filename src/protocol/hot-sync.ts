import { createHash } from "node:crypto";
/** Versioned hot-sync wire contract. Counters are safe nonnegative integers. */
export const HOT_SYNC_PROTOCOL_VERSION = 2;
export const HOT_SYNC_VERSION = "crosshead_hot_sync_v1";
export const HOT_SYNC_MAX_BYTES = 128 * 1024;
export const HOT_SYNC_MAX_SCOPES = 128;
export const HOT_SYNC_PAGE_SIZE = 64;
export type HotSyncCheckpoint = {
	id: string;
	deviceId: string;
	sequence?: number;
	runtime: string;
	workspaceId: string;
	occurredAt: string;
	goal: string;
	summary: string;
	origin?: "remember";
	sessionId?: string | null;
	turnId?: string | null;
	evidence?: unknown;
	supersedes?: string[];
	conflictsWith?: string[];
	conflictOf?: string;
};
export type HotSyncDocument = {
	version: typeof HOT_SYNC_VERSION;
	namespace: string;
	scope: string;
	epoch: number;
	checkpoints: HotSyncCheckpoint[];
	seen?: Record<string, number>;
	/** Suppression survives pruning of the checkpoint that declared it. */
	withheld?: string[];
	superseded?: string[];
};
export type HotSyncEnvelope = {
	version: "crosshead_signed_memory_v2";
	signedBy: string;
	document: HotSyncDocument;
	signature: string;
};
export type HotSyncSnapshot = {
	updated_at?: string | null;
	namespace: string;
	scope: string;
	epoch: number;
	revision: number;
	content: HotSyncEnvelope | null;
};
export const hotSyncName = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(value) && value !== "all";
export const hotSyncCounter = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2147483647;
export function validHotSyncDocument(value: unknown): value is HotSyncDocument {
	if (!value || typeof value !== "object")
		return false;
	const d = value as HotSyncDocument;
	return d.version === HOT_SYNC_VERSION && hotSyncName(d.namespace) && hotSyncName(d.scope) &&
		hotSyncCounter(d.epoch) && [d.withheld, d.superseded].every(ids => ids === undefined || Array.isArray(ids) && ids.length <= 256 && ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 128)) && (d.seen === undefined || typeof d.seen === "object" && d.seen !== null && !Array.isArray(d.seen) && Object.keys(d.seen).length <= 128 && Object.values(d.seen).every(hotSyncCounter)) && Array.isArray(d.checkpoints) && d.checkpoints.length <= 256 &&
		d.checkpoints.every(c => c && typeof c.id === "string" && c.id.length > 0 && c.id.length <= 128 &&
			[c.deviceId, c.runtime, c.workspaceId, c.goal, c.summary, c.occurredAt].every(v => typeof v === "string") &&
			Number.isFinite(Date.parse(c.occurredAt)) && (c.sequence === undefined || hotSyncCounter(c.sequence)) &&
			(c.supersedes === undefined || Array.isArray(c.supersedes) && c.supersedes.length <= 256 && c.supersedes.every(id => typeof id === "string")) &&
			(c.conflictsWith === undefined || Array.isArray(c.conflictsWith) && c.conflictsWith.length <= 256 && c.conflictsWith.every(id => typeof id === "string")) &&
			(c.conflictOf === undefined || typeof c.conflictOf === "string") &&
			(c.origin === undefined || c.origin === "remember")) &&
		new Set(d.checkpoints.map(c => c.id)).size === d.checkpoints.length;
}
/** Conditional cache identity includes the authenticated owner and document boundary. */
export function hotSyncEtag(npub: string, snapshot: Pick<HotSyncSnapshot, "namespace" | "scope" | "epoch" | "revision">): string {
	return `"${createHash("sha256").update(JSON.stringify([npub, snapshot.namespace, snapshot.scope, snapshot.epoch, snapshot.revision])).digest("hex")}"`;
}
