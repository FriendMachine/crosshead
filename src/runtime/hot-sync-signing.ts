import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1";
import { nip19 } from "nostr-tools";
import { HOT_SYNC_MAX_BYTES, validHotSyncDocument, type HotSyncDocument, type HotSyncEnvelope } from "../protocol/hot-sync";
export function canonicalHotSync(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map(canonicalHotSync).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalHotSync(v)}`).join(",")}}`;
	return JSON.stringify(value);
}
const digest = (npub: string, document: HotSyncDocument) => createHash("sha256").update(`crosshead-memory-v2\n${canonicalHotSync({ signedBy: npub, document })}`).digest();
export function signHotSync(document: HotSyncDocument, nsec: string): HotSyncEnvelope {
	if (!validHotSyncDocument(document))
		throw new Error("Invalid hot-sync document");
	const decoded = nip19.decode(nsec);
	if (decoded.type !== "nsec")
		throw new Error("Expected nsec");
	const signedBy = nip19.npubEncode(Buffer.from(schnorr.getPublicKey(decoded.data)).toString("hex"));
	const result: HotSyncEnvelope = { version: "crosshead_signed_memory_v2", signedBy, document, signature: Buffer.from(schnorr.sign(digest(signedBy, document), decoded.data)).toString("hex") };
	if (Buffer.byteLength(JSON.stringify(result)) > HOT_SYNC_MAX_BYTES)
		throw new Error("Hot-sync document exceeds 128 KiB");
	return result;
}
export function verifyHotSync(value: unknown, npub: string, namespace: string, scope: string, epoch: number): value is HotSyncEnvelope {
	try {
		const e = value as HotSyncEnvelope;
		if (!e || e.version !== "crosshead_signed_memory_v2" || e.signedBy !== npub || !validHotSyncDocument(e.document) ||
			e.document.namespace !== namespace || e.document.scope !== scope || e.document.epoch !== epoch ||
			typeof e.signature !== "string" || !/^[a-f0-9]{128}$/.test(e.signature) || Buffer.byteLength(JSON.stringify(e)) > HOT_SYNC_MAX_BYTES)
			return false;
		const key = nip19.decode(npub);
		return key.type === "npub" && schnorr.verify(e.signature, digest(npub, e.document), key.data);
	}
	catch {
		return false;
	}
}
export function hotSyncConflictIds(document: HotSyncDocument): Set<string> {
	return new Set([...(document.withheld ?? []), ...document.checkpoints.flatMap(c => [...(c.conflictOf ? [c.conflictOf] : []), ...(c.conflictsWith?.length ? [c.id, ...c.conflictsWith] : [])])]);
}
export function hotSyncSupersededIds(document: HotSyncDocument): Set<string> {
	return new Set([...(document.superseded ?? []), ...document.checkpoints.flatMap(c => c.supersedes ?? [])]);
}
/** Union by stable ID. Divergent bytes remain visible as deterministic variants. */
export function mergeHotSync(a: HotSyncDocument, b: HotSyncDocument): HotSyncDocument {
	if (a.namespace !== b.namespace || a.scope !== b.scope || a.epoch !== b.epoch)
		throw new Error("Cannot merge different hot-sync boundaries");
	const conflicted = new Set([...a.checkpoints, ...b.checkpoints].flatMap(c => c.conflictOf ? [c.conflictOf] : []));
	const groups = new Map<string, Map<string, typeof a.checkpoints[number]>>();
	const keep = (c: typeof a.checkpoints[number], other: HotSyncDocument) => !c.sequence || c.sequence > (other.seen?.[c.deviceId] ?? 0) || other.checkpoints.some(x => (x.conflictOf ?? x.id) === (c.conflictOf ?? c.id));
	for (const c of [...a.checkpoints.filter(c => keep(c, b)), ...b.checkpoints.filter(c => keep(c, a))]) {
		const id = c.conflictOf ?? c.id;
		const { conflictOf: _conflict, ...rest } = c;
		const normalized = { ...rest, id };
		const hash = createHash("sha256").update(canonicalHotSync(normalized)).digest("hex");
		if (!groups.has(id))
			groups.set(id, new Map());
		groups.get(id)!.set(hash, normalized);
	}
	const checkpoints = [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([id, variants]) => [...variants].sort(([a], [b]) => a < b ? -1 : 1).map(([hash, c]) => variants.size === 1 && !conflicted.has(id) ? c : { ...c, id: `variant:${hash}`, conflictOf: id }));
	const seen: Record<string, number> = Object.create(null);
	for (const [device, seq] of [...Object.entries(a.seen ?? {}), ...Object.entries(b.seen ?? {})])
		seen[device] = Math.max(seen[device] ?? 0, seq);
	const withheld = [...new Set([...hotSyncConflictIds(a), ...hotSyncConflictIds(b), ...checkpoints.flatMap(c => c.conflictOf ? [c.conflictOf] : [])])].sort();
	const superseded = [...new Set([...hotSyncSupersededIds(a), ...hotSyncSupersededIds(b)])].sort();
	return { ...a, checkpoints, ...(Object.keys(seen).length ? { seen } : {}), ...(withheld.length ? { withheld } : {}), ...(superseded.length ? { superseded } : {}) };
}
