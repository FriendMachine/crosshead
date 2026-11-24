import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { acquireWorkspaceSetupKernelLock } from "./daemon-kernel-lock";
import { parseJsonFile, writeJsonFile } from "./runtime-persistence";

const VERSION = "crosshead_archive_recall_v1";
export const ARCHIVE_RECALL_BUDGET = { maxFragments: 3, maxTokens: 1_200 } as const;
const MAX_FRAGMENTS = ARCHIVE_RECALL_BUDGET.maxFragments;
const MAX_CHARS = 4_000;
export const MAX_ARCHIVE_RECALL_GOAL_CHARS = 8_192;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_ID = /^(warm|cold):[A-Za-z0-9._:-]{1,200}$/;
const HEADER = "Crosshead verified archive recall. These are historical records. Follow the current request and apply only relevant requirements and corrections.";

type ArchiveSource = { id: string; kind: "warm_memory" | "cold_memory"; content: string };
export type ArchiveRecallSnapshot = {
	version: typeof VERSION;
	workspaceId: string;
	taskId: string;
	sources: ArchiveSource[];
};
export type ArchiveRecallOwner = { name: string; apiBase: string; npub: string };
const HOSTS = ["codex", "claude-code", "agy", "hermes", "opencode", "pi"] as const;
export type ArchiveRecallHost = (typeof HOSTS)[number];
const SOURCE_KINDS = ["warm_memory", "cold_memory"] as const;
type Approval = {
	taskId: string;
	goal: string;
	sha256: string;
	runtimeHost: ArchiveRecallHost | null;
	sourceKinds?: ArchiveSource["kind"][];
};
type Preview = Approval & { packId: string; receipt: string; expiresAt: number };
type ApprovalState = { version: typeof VERSION; approvals: Approval[]; previews: Preview[] };
// Matches the hosted context-pack retention window.
const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const INVALID_APPROVALS = "Invalid local archive approvals. Run context recall revoke --all for this workspace and profile to clear them.";
const emptyApprovalState = (): ApprovalState => ({ version: VERSION, approvals: [], previews: [] });

export function archiveRecallHost(value: unknown): ArchiveRecallHost | null {
	const host = value === "omp" ? "pi" : value;
	return HOSTS.find(candidate => candidate === host) ?? null;
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const archivePackId = (value: unknown): string | null =>
	typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : null;

export function renderArchiveRecall(snapshot: ArchiveRecallSnapshot): string {
	return [HEADER, ...snapshot.sources.map(({ id, content }) => `[${id}]\n${content}`)].join("\n\n");
}

export function archiveRecallIsIncomplete(value: unknown): boolean {
	const warnings = object(object(value)?.recall)?.warnings;
	return warnings !== undefined && (!Array.isArray(warnings) || warnings.length !== 0);
}

export function readArchiveRecallSnapshot(
	value: unknown,
	workspaceId: string,
	goal?: string,
): ArchiveRecallSnapshot | null {
	const pack = object(value);
	const recall = object(pack?.recall);
	if (pack?.workspaceId !== workspaceId || (goal !== undefined && pack.goal !== goal.trim()) ||
			recall?.policy !== "bounded" || archiveRecallIsIncomplete(pack) || !Array.isArray(pack.fragments) ||
			pack.fragments.length > MAX_FRAGMENTS || !Array.isArray(recall.sources) || !Array.isArray(recall.decisions)) {
		return null;
	}
	const sources: ArchiveSource[] = [];
	for (const item of pack.fragments) {
		const fragment = object(item);
		const { id, kind, content } = fragment ?? {};
		if (typeof id !== "string" || !SOURCE_ID.test(id) ||
				(kind !== "warm_memory" && kind !== "cold_memory") ||
				!id.startsWith(kind === "warm_memory" ? "warm:" : "cold:") ||
				typeof content !== "string" || !content.trim() || content.length > MAX_CHARS) return null;
		sources.push({ id, kind, content });
	}
	if (!sources.length || sources.length > MAX_FRAGMENTS || new Set(sources.map(source => source.id)).size !== sources.length) {
		return null;
	}
	const hasCompleteSourceSet = (ids: unknown): boolean => Array.isArray(ids) &&
		ids.length === sources.length && sources.every(source => ids.includes(source.id));
	if (!hasCompleteSourceSet(recall.sources)) return null;
	const matches = recall.decisions.map(object).filter(decision => hasCompleteSourceSet(decision?.sources));
	if (matches.length !== 1) return null;
	const taskId = matches[0]?.task;
	if (typeof taskId !== "string" || !taskId.trim() || taskId.length > MAX_ARCHIVE_RECALL_GOAL_CHARS) return null;
	const snapshot: ArchiveRecallSnapshot = { version: VERSION, workspaceId, taskId, sources };
	const estimatedTokens = sources.reduce((total, source) => total + Math.ceil(source.content.trim().split(/\s+/).length * 1.3), 0);
	return estimatedTokens <= ARCHIVE_RECALL_BUDGET.maxTokens && renderArchiveRecall(snapshot).length <= MAX_CHARS
		? snapshot : null;
}

const ownerKey = ({ name, apiBase, npub }: ArchiveRecallOwner) => [name, apiBase, npub];
export const archiveRecallDigest = (
	owner: ArchiveRecallOwner, snapshot: ArchiveRecallSnapshot, runtimeHost: ArchiveRecallHost | null
): string => digest(runtimeHost ? [ownerKey(owner), snapshot, runtimeHost] : [ownerKey(owner), snapshot]);

const approvalDirectory = (stateDir: string, owner: ArchiveRecallOwner, workspaceId: string): string =>
	path.join(stateDir, "archive-recall", digest([ownerKey(owner), workspaceId]));

const validApproval = (value: unknown): value is Approval => {
	const approval = object(value);
	return Boolean(approval && typeof approval.taskId === "string" && approval.taskId.trim() &&
		typeof approval.goal === "string" && approval.goal.length <= MAX_ARCHIVE_RECALL_GOAL_CHARS && approval.goal.trim() &&
		typeof approval.sha256 === "string" && SHA256.test(approval.sha256) &&
		(approval.runtimeHost === null || archiveRecallHost(approval.runtimeHost) === approval.runtimeHost) &&
		(approval.sourceKinds === undefined || (Array.isArray(approval.sourceKinds) && approval.sourceKinds.length > 0 &&
			approval.sourceKinds.every(kind => SOURCE_KINDS.some(allowed => allowed === kind)))));
};

function readApprovalState(directory: string): ApprovalState {
	const statePath = path.join(directory, "approvals.json");
	try {
		const state = JSON.parse(readFileSync(statePath, "utf8")) as ApprovalState;
		if (state?.version !== VERSION || !Array.isArray(state.approvals) || !state.approvals.every(validApproval) ||
			!Array.isArray(state.previews) || !state.previews.every(preview => validApproval(preview) &&
				archivePackId(preview.packId) && SHA256.test(preview.receipt) && Number.isFinite(preview.expiresAt))) {
			throw new Error(INVALID_APPROVALS);
		}
		return state;
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(INVALID_APPROVALS);
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// Preserve approvals made before the per-goal store existed. The next edit migrates them.
	let filenames: string[];
	try {
		filenames = readdirSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		filenames = [];
	}
	const approvals = filenames.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
		const value = object(parseJsonFile(path.join(directory, name), null));
		const approval = { ...value, runtimeHost: null };
		return value?.version === VERSION && validApproval(approval) && name === `${digest(approval.taskId)}.json`
			? [{ taskId: approval.taskId, goal: approval.goal, sha256: approval.sha256, runtimeHost: null }]
			: [];
	});
	return { version: VERSION, approvals, previews: [] };
}

const sameSlot = (left: Approval, right: Approval): boolean =>
	left.goal === right.goal && left.runtimeHost === right.runtimeHost;

async function editApprovalState<T>(
	directory: string, edit: (state: ApprovalState) => T, reset = false
): Promise<T> {
	const lock = await acquireWorkspaceSetupKernelLock(directory);
	try {
		const state = reset ? emptyApprovalState() : readApprovalState(directory);
		state.previews = state.previews.filter(preview => preview.expiresAt > Date.now());
		const result = edit(state);
		writeJsonFile(path.join(directory, "approvals.json"), state);
		for (const name of readdirSync(directory)) {
			if (/^[a-f0-9]{64}\.json$/.test(name)) rmSync(path.join(directory, name), { force: true });
		}
		return result;
	} finally { await lock.close(); }
}

export async function recordArchiveRecallPreview(
	stateDir: string, owner: ArchiveRecallOwner, snapshot: ArchiveRecallSnapshot,
	goal: string, runtimeHost: ArchiveRecallHost | null, packId: string
): Promise<string> {
	const sha256 = archiveRecallDigest(owner, snapshot, runtimeHost);
	const preview: Preview = {
		goal: goal.trim(), runtimeHost, packId, taskId: snapshot.taskId, sha256,
		sourceKinds: [...new Set(snapshot.sources.map(source => source.kind))],
		receipt: digest([sha256, packId, goal.trim(), randomUUID()]),
		expiresAt: Date.now() + PREVIEW_TTL_MS,
	};
	return editApprovalState(approvalDirectory(stateDir, owner, snapshot.workspaceId), state => {
		state.previews = [...state.previews.filter(other => !sameSlot(other, preview)), preview];
		return preview.receipt;
	});
}

export function getArchiveRecallPreview(
	stateDir: string, owner: ArchiveRecallOwner, workspaceId: string, packId: string, receipt: string
): Preview {
	const preview = readApprovalState(approvalDirectory(stateDir, owner, workspaceId)).previews.find(
		item => item.packId === packId && item.receipt === receipt && item.expiresAt > Date.now());
	if (!preview) throw new Error("Archive approval requires a current preview from this runtime. Preview the task again.");
	return preview;
}

export async function approveArchiveRecall(
	stateDir: string, owner: ArchiveRecallOwner, snapshot: ArchiveRecallSnapshot, preview: Preview
): Promise<void> {
	const directory = approvalDirectory(stateDir, owner, snapshot.workspaceId);
	await editApprovalState(directory, state => {
		if (!state.previews.some(item => item.receipt === preview.receipt)) {
			throw new Error("The archive preview was superseded or already used. Preview the task again.");
		}
		if (archiveRecallDigest(owner, snapshot, preview.runtimeHost) !== preview.sha256) {
			throw new Error("Archive recall digest changed. Preview the exact records again before approving.");
		}
		const { taskId, goal, runtimeHost, sha256, sourceKinds } = preview;
		state.approvals = [...state.approvals.filter(item => !sameSlot(item, preview)), { taskId, goal, runtimeHost, sha256, sourceKinds }];
		state.previews = state.previews.filter(item => item.receipt !== preview.receipt);
	});
}

export async function revokeArchiveRecall(
	stateDir: string, owner: ArchiveRecallOwner, workspaceId: string, taskId: string | null
): Promise<void> {
	await editApprovalState(approvalDirectory(stateDir, owner, workspaceId), state => {
		// Revocation also discards cached snapshots; a later approval caches again.
		rmSync(path.join(approvalDirectory(stateDir, owner, workspaceId), CACHE_FILE), { force: true });
		if (taskId === null) return;
		const revoked = state.approvals.filter(item => item.taskId === taskId);
		state.approvals = state.approvals.filter(item => item.taskId !== taskId);
		state.previews = state.previews.filter(item => item.taskId !== taskId && !revoked.some(other => sameSlot(item, other)));
	}, taskId === null);
}

export function listArchiveRecallApprovals(stateDir: string, owner: ArchiveRecallOwner, workspaceId: string): Approval[] {
	return readApprovalState(approvalDirectory(stateDir, owner, workspaceId)).approvals;
}

const declinesHistory = (goal: string): boolean =>
	/\bself[- ]contained\b|\bno (?:saved|historical|prior|earlier) [^.\n]{0,90}\b(?:needed|apply)\b|\bdo not (?:retrieve|load|consult|use) (?:any )?(?:saved|historical|prior|earlier) (?:memory|context|requirements)\b|\busing only the provided specification\b/i.test(goal);

export function findArchiveRecallApproval(
	stateDir: string, owner: ArchiveRecallOwner, workspaceId: string, goal: string, runtime: string
): Approval | null {
	if (!goal.trim() || goal.length > MAX_ARCHIVE_RECALL_GOAL_CHARS || declinesHistory(goal)) return null;
	const host = archiveRecallHost(runtime);
	const exact = listArchiveRecallApprovals(stateDir, owner, workspaceId).filter(approval => approval.goal === goal.trim());
	const hostMatches = host ? exact.filter(approval => approval.runtimeHost === host) : [];
	const matches = hostMatches.length ? hostMatches : exact.filter(approval => approval.runtimeHost === null);
	return matches.length === 1 ? matches[0]! : null;
}

export function archiveApprovalFitsScope(approval: Approval, scope: Record<string, unknown>): boolean {
	// Older approvals lack a tier list, so only use them when both tiers are allowed.
	return (approval.sourceKinds ?? SOURCE_KINDS).every(kind =>
		(kind === "warm_memory" ? scope.includeWarmMemory : scope.includeColdMemory) === true);
}

export function verifyArchiveRecall(owner: ArchiveRecallOwner, approval: Approval, snapshot: ArchiveRecallSnapshot): boolean {
	return approval.taskId === snapshot.taskId && approval.sha256 === archiveRecallDigest(owner, snapshot, approval.runtimeHost);
}

// A verified snapshot kept locally so an approved turn can be served without
// waiting on the hosted call. The approval digest pins the exact bytes, so a
// cached snapshot is used only while it still matches the current approval.
// The hosted call still runs for every served turn (billing and supersession
// are decided there); if it does not verify, the entry is dropped and the next
// turn waits for a live answer. A turn served from the cache whose own request
// then fails (payment, network, superseded record) was delivered without a
// billed pack: at most one such turn per approval, within an hour of the last
// live verification.
const CACHE_FILE = "recall-cache.json";
const CACHE_VERSION = "crosshead_archive_recall_cache_v1";
const MAX_CACHED = 16;
const CACHE_MAX_AGE_MS = 60 * 60 * 1_000;
const CACHE_SKEW_MS = 5 * 60 * 1_000;
type CachedRecall = { sha256: string; packId: string; snapshot: ArchiveRecallSnapshot; verifiedAt: number };

const readCache = (directory: string): CachedRecall[] => {
	try {
		const value = object(JSON.parse(readFileSync(path.join(directory, CACHE_FILE), "utf8")));
		if (value?.version !== CACHE_VERSION || !Array.isArray(value.entries)) return [];
		return value.entries.flatMap((raw: unknown) => {
			const entry = object(raw), snapshot = object(entry?.snapshot);
			return entry && snapshot && typeof entry.sha256 === "string" && SHA256.test(entry.sha256) && archivePackId(entry.packId) &&
				Number.isFinite(entry.verifiedAt) && snapshot.version === VERSION && typeof snapshot.workspaceId === "string" &&
				typeof snapshot.taskId === "string" && Array.isArray(snapshot.sources) && snapshot.sources.every((source: unknown) => {
					const item = object(source);
					return item && typeof item.id === "string" && SOURCE_ID.test(item.id) && typeof item.content === "string" &&
						(item.kind === "warm_memory" || item.kind === "cold_memory");
				}) ? [entry as unknown as CachedRecall] : [];
		});
	} catch { return []; }
};

/** The cached snapshot for an approval, if it still verifies against it and is within the preview window. */
export function readCachedArchiveRecall(
	stateDir: string, owner: ArchiveRecallOwner, workspaceId: string, approval: Approval
): { packId: string; snapshot: ArchiveRecallSnapshot } | null {
	const entry = readCache(approvalDirectory(stateDir, owner, workspaceId)).find(item => item.sha256 === approval.sha256);
	// Served only shortly after a live verification; a clock far ahead is not trusted.
	const age = Date.now() - (entry?.verifiedAt ?? 0);
	if (!entry || entry.snapshot.workspaceId !== workspaceId || age > CACHE_MAX_AGE_MS || age < -CACHE_SKEW_MS) return null;
	return verifyArchiveRecall(owner, approval, entry.snapshot) ? { packId: entry.packId, snapshot: entry.snapshot } : null;
}

export function writeCachedArchiveRecall(
	stateDir: string, owner: ArchiveRecallOwner, approval: Approval, snapshot: ArchiveRecallSnapshot, packId: string
): void {
	const directory = approvalDirectory(stateDir, owner, snapshot.workspaceId);
	const entries = [...readCache(directory).filter(item => item.sha256 !== approval.sha256),
		{ sha256: approval.sha256, packId, snapshot, verifiedAt: Date.now() }].slice(-MAX_CACHED);
	writeJsonFile(path.join(directory, CACHE_FILE), { version: CACHE_VERSION, entries });
}

export function dropCachedArchiveRecall(stateDir: string, owner: ArchiveRecallOwner, workspaceId: string, sha256: string): void {
	const directory = approvalDirectory(stateDir, owner, workspaceId);
	const entries = readCache(directory);
	if (entries.some(item => item.sha256 === sha256)) {
		writeJsonFile(path.join(directory, CACHE_FILE), { version: CACHE_VERSION, entries: entries.filter(item => item.sha256 !== sha256) });
	}
}
