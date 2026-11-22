import { createHash } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
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
type Approval = { version: typeof VERSION; taskId: string; goal: string; sha256: string };

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const archivePackId = (value: unknown): string | null =>
	typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : null;

export function renderArchiveRecall(snapshot: ArchiveRecallSnapshot): string {
	return [HEADER, ...snapshot.sources.map(({ id, content }) => `[${id}]\n${content}`)].join("\n\n");
}

export function readArchiveRecallSnapshot(
	value: unknown,
	workspaceId: string,
	goal?: string,
): ArchiveRecallSnapshot | null {
	const pack = object(value);
	const recall = object(pack?.recall);
	if (pack?.workspaceId !== workspaceId || (goal !== undefined && pack.goal !== goal.trim()) ||
			recall?.policy !== "bounded" || !Array.isArray(pack.fragments) ||
			pack.fragments.length > MAX_FRAGMENTS + 1 || !Array.isArray(recall.sources) || !Array.isArray(recall.decisions)) {
		return null;
	}
	const sources: ArchiveSource[] = [];
	for (const item of pack.fragments) {
		const fragment = object(item);
		if (fragment?.kind === "hot_memory") continue;
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
export const archiveRecallDigest = (owner: ArchiveRecallOwner, snapshot: ArchiveRecallSnapshot): string =>
	digest([ownerKey(owner), snapshot]);

export const archiveRecallApprovalDigest = (owner: ArchiveRecallOwner, snapshot: ArchiveRecallSnapshot, goal: string): string =>
	digest([archiveRecallDigest(owner, snapshot), goal.trim()]);

const approvalDirectory = (stateDir: string, owner: ArchiveRecallOwner, workspaceId: string): string =>
	path.join(stateDir, "archive-recall", digest([ownerKey(owner), workspaceId]));
const approvalFile = (directory: string, taskId: string): string => path.join(directory, `${digest(taskId)}.json`);

export function approveArchiveRecall(
	stateDir: string,
	owner: ArchiveRecallOwner,
	snapshot: ArchiveRecallSnapshot,
	goal: string,
	expectedDigest: string,
): void {
	if (expectedDigest !== archiveRecallApprovalDigest(owner, snapshot, goal)) {
		throw new Error("Archive recall digest changed. Preview the exact records again before approving.");
	}
	writeJsonFile(approvalFile(approvalDirectory(stateDir, owner, snapshot.workspaceId), snapshot.taskId), {
		version: VERSION,
		taskId: snapshot.taskId,
		goal: goal.trim(),
		sha256: archiveRecallDigest(owner, snapshot),
	} satisfies Approval);
}

export function revokeArchiveRecall(stateDir: string, owner: ArchiveRecallOwner, workspaceId: string, taskId: string): void {
	rmSync(approvalFile(approvalDirectory(stateDir, owner, workspaceId), taskId), { force: true });
}

export function listArchiveRecallApprovals(stateDir: string, owner: ArchiveRecallOwner, workspaceId: string): Approval[] {
	const directory = approvalDirectory(stateDir, owner, workspaceId);
	let filenames: string[];
	try {
		filenames = readdirSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return filenames.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort().flatMap(name => {
		const value = object(parseJsonFile(path.join(directory, name), null));
		if (value?.version !== VERSION || typeof value.taskId !== "string" ||
				name !== path.basename(approvalFile(directory, value.taskId)) ||
				typeof value.goal !== "string" || value.goal.length > MAX_ARCHIVE_RECALL_GOAL_CHARS || !value.goal.trim() ||
				typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) return [];
		return [{ version: VERSION, taskId: value.taskId, goal: value.goal, sha256: value.sha256 }];
	});
}

const STOP_WORDS = new Set("again and can could for from have into look need please recall remember resume should task that the their this use want was were what when where which will with would you your".split(" "));
const terms = (text: string) =>
	new Set((text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(term => !STOP_WORDS.has(term)));
const declinesHistory = (goal: string): boolean =>
	/\bself[- ]contained\b|\bno (?:saved|historical|prior|earlier) [^.\n]{0,90}\b(?:needed|apply)\b|\bdo not (?:retrieve|load|consult|use) (?:any )?(?:saved|historical|prior|earlier) (?:memory|context|requirements)\b|\busing only the provided specification\b/i.test(goal);

export function findArchiveRecallApproval(
	stateDir: string,
	owner: ArchiveRecallOwner,
	workspaceId: string,
	goal: string,
): Approval | null {
	if (!goal.trim() || goal.length > MAX_ARCHIVE_RECALL_GOAL_CHARS || declinesHistory(goal)) return null;
	const approvals = listArchiveRecallApprovals(stateDir, owner, workspaceId);
	const exact = approvals.filter(approval => approval.goal === goal.trim());
	if (exact.length) return exact.length === 1 ? exact[0]! : null;
	const requestTerms = terms(goal);
	const matches = approvals.filter(approval => {
		const approvedTerms = terms(approval.goal);
		const overlap = [...approvedTerms].filter(term => requestTerms.has(term)).length;
		return overlap >= 2 && overlap * 2 >= approvedTerms.size;
	});
	return matches.length === 1 ? matches[0]! : null;
}

export function verifyArchiveRecall(
	owner: ArchiveRecallOwner,
	approval: Approval,
	snapshot: ArchiveRecallSnapshot,
): boolean {
	return approval.taskId === snapshot.taskId && approval.sha256 === archiveRecallDigest(owner, snapshot);
}
