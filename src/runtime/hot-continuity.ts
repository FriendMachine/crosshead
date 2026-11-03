import { compactContinuitySummary } from "./summary-compaction";
import { normalizeTaskEvidence, renderTaskEvidence, taskEvidenceChars, type TaskEvidence } from "./task-evidence";

// Capture and delivery have separate bounds. Keep exact findings, including list/code
// formatting, until a real size limit requires compaction. No model call is needed.
export const HOT_FINDING_LIMIT = 6000;
const HOT_REQUEST_LIMIT = 6000;
export const HOT_CONTEXT_LIMIT = 4200;
const MAX_CHECKPOINTS = 12;
const MAX_HISTORY_CHARS = 30000;

export type HotContinuityCheckpoint = {
  runtime: string;
  workspaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  goal: string;
  goalTruncated?: boolean;
  summary: string;
  occurredAt: string;
  evidence?: TaskEvidence;
};
export type SelectedHotCheckpoint = HotContinuityCheckpoint & {
  // A read-time view over retained checkpoints, not a second persisted ledger.
  earlierFindings?: Array<{ runtime: string; occurredAt: string; summary: string }>;
};

const record = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return null; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
};
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const timestamp = (value: string): number => Date.parse(value) || 0;

export const captureHotFinding = (value: string): string => {
  const clean = value.trim();
  return clean.length <= HOT_FINDING_LIMIT ? clean : compactContinuitySummary(clean, HOT_FINDING_LIMIT);
};

export const readHotCheckpoints = (value: unknown): HotContinuityCheckpoint[] =>
  (Array.isArray(value) ? value : []).flatMap((entry) => {
    const item = record(entry);
    if (!item || !text(item.summary) || !text(item.runtime)) return [];
    const evidence = normalizeTaskEvidence(item.evidence);
    return [{
      runtime: text(item.runtime), workspaceId: text(item.workspaceId) || null,
      sessionId: text(item.sessionId) || null, turnId: text(item.turnId) || null,
      goal: text(item.goal).slice(0, HOT_REQUEST_LIMIT),
      ...(item.goalTruncated === true || text(item.goal).length > HOT_REQUEST_LIMIT ? { goalTruncated: true } : {}),
      summary: captureHotFinding(text(item.summary)),
      occurredAt: text(item.occurredAt),
      ...(evidence ? { evidence } : {}),
    }];
  });

export const updateHotCheckpoints = (
  previous: unknown, next: HotContinuityCheckpoint
): HotContinuityCheckpoint[] => {
  const sameTurn = (entry: HotContinuityCheckpoint): boolean =>
    entry.runtime === next.runtime && entry.workspaceId === next.workspaceId &&
    (next.turnId ? entry.turnId === next.turnId && entry.sessionId === next.sessionId :
      Boolean(next.sessionId && entry.sessionId === next.sessionId && entry.goal === next.goal));
  const old = readHotCheckpoints(previous);
  const prior = old.slice().reverse().find(entry => sameTurn(entry) || (
    entry.workspaceId === next.workspaceId && Boolean(next.goal.trim()) && entry.goal.trim() === next.goal.trim()
  ));
  const freshEvidence = normalizeTaskEvidence(next.evidence);
  // Stop may follow compaction, after the source has left the host transcript.
  // Keep earlier evidence; repeated quotes dedupe by bytes, while conflicting
  // versions remain visible. Observation recency alone cannot establish authority.
  const evidence = freshEvidence?.sources.length ? normalizeTaskEvidence({ ...freshEvidence,
    sources: [...freshEvidence.sources, ...(prior?.evidence?.sources ?? []).filter(s => !freshEvidence.sources.some(n => n.sha256 === s.sha256))],
  }) : prior?.evidence ?? freshEvidence;
  const entries = old.filter((entry) => !sameTurn(entry));
  entries.push({ ...next, goal: next.goal.slice(0, HOT_REQUEST_LIMIT),
    ...(next.goalTruncated || next.goal.length > HOT_REQUEST_LIMIT ? { goalTruncated: true } : {}),
    summary: captureHotFinding(next.summary), ...(evidence ? { evidence } : {}) });
  const bounded: HotContinuityCheckpoint[] = [];
  let size = 0;
  for (const entry of entries.reverse()) {
    const chars = entry.goal.length + entry.summary.length + taskEvidenceChars(entry.evidence);
    if (bounded.length >= MAX_CHECKPOINTS || size + chars > MAX_HISTORY_CHARS) break;
    bounded.push(entry);
    size += chars;
  }
  return bounded.reverse();
};

const STOP_WORDS = new Set(("a an and are as at be been but by can do for from had has have i if in into is it its may of on or our should that the their then there these they this to was we were will with would you your").split(" "));
const terms = (value: string): Set<string> => new Set(
  value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}_-]+/gu)?.filter(
    (term) => term.length > 2 && !STOP_WORDS.has(term)
  ) ?? []
);

export const selectHotCheckpoints = (
  snapshot: unknown, goal: string | null, workspaceId?: string | null
): SelectedHotCheckpoint[] => {
  const candidates: HotContinuityCheckpoint[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    const item = record(value);
    if (!item) return;
    const owner = text(item.workspaceId) || text(item.workspace_id);
    if (workspaceId && owner && owner !== workspaceId) return;
    candidates.push(...readHotCheckpoints(item.continuityCheckpoints).filter(
      (entry) => !workspaceId || !entry.workspaceId || entry.workspaceId === workspaceId
    ));
    if (Array.isArray(item.scopes)) for (const scope of item.scopes) visit(scope, depth + 1);
    for (const key of ["content", "hotMemoryContent", "hot_memory_content", "hotMemory", "hot_memory"]) {
      if (item[key]) visit(item[key], depth + 1);
    }
  };
  visit(snapshot, 0);
  // A new finding does not revoke earlier source observations. Merge evidence
  // across host bodies and keep distinct earlier findings visibly historical.
  // Request identity is exact: case and whitespace can be contract literals.
  const groups = new Map<string, HotContinuityCheckpoint[]>();
  for (const entry of candidates.reverse().sort((a, b) => timestamp(b.occurredAt) - timestamp(a.occurredAt))) {
    const identity = entry.goal || JSON.stringify([entry.runtime, entry.sessionId, entry.turnId, entry.occurredAt, entry.summary]);
    const key = JSON.stringify([entry.workspaceId, identity]);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const unique: SelectedHotCheckpoint[] = [...groups.values()].map(entries => {
    const latest = entries[0]!;
    const evidenceEntries = entries.flatMap(entry => entry.evidence ? [entry.evidence] : []);
    const evidence = evidenceEntries.length ? normalizeTaskEvidence({ version: 1,
      coverage: evidenceEntries.some(e => e.coverage === "bounded") ? "bounded" : "unavailable",
      omitted: Math.max(...evidenceEntries.map(e => e.omitted)), sources: evidenceEntries.flatMap(e => e.sources),
    }) : undefined;
    const seen = new Set([latest.summary]);
    const earlierFindings = entries.slice(1).filter(entry => {
      if (seen.has(entry.summary)) return false;
      seen.add(entry.summary); return true;
    }).slice(0, 3).map(({ runtime, occurredAt, summary }) => ({ runtime, occurredAt, summary }));
    return { ...latest, ...(evidence ? { evidence } : {}), ...(earlierFindings.length ? { earlierFindings } : {}) };
  });
  const query = terms(goal ?? "");
  const documents = unique.map((entry) => terms(`${entry.goal}\n${entry.summary}\n${entry.earlierFindings?.map(f => f.summary).join("\n") ?? ""}\n${entry.evidence?.sources.map(s => `${s.source}\n${s.text}`).join("\n") ?? ""}`));
  const scored = unique.map((entry, index) => {
    let score = 0;
    for (const term of query) {
      if (!documents[index]!.has(term)) continue;
      const frequency = documents.filter((doc) => doc.has(term)).length;
      // Shared prompt boilerplate carries little weight; task-specific terms dominate.
      score += Math.log(1 + unique.length / frequency) / frequency;
    }
    return { entry, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const first = scored[0];
  if (!first) return [];
  return scored.filter((entry, index) => index === 0 || (entry.score > 0 && entry.score >= first.score * 0.6))
    .slice(0, 2).map(({ entry }) => entry);
};

export const renderHotCheckpoints = (entries: SelectedHotCheckpoint[], maxLength = HOT_CONTEXT_LIMIT): string => {
  if (entries.length === 0) return "";
  let remaining = maxLength;
  const parts: string[] = [];
  const guidance = "Prior findings. Follow current instructions; reconcile conflicting sources. Observation time alone does not establish authority.";
  remaining -= guidance.length + 1;
  for (const [index, entry] of entries.entries()) {
    const heading = `Hot memory findings (${entry.runtime}):\n`;
    // Every selected task gets room; one large history must not silently erase
    // another selected amendment or task. Unused space flows to later entries.
    const available = Math.floor(remaining / (entries.length - index)) - heading.length - 1;
    if (available < 160) break;
    // The assistant's final response is not the user's contract. Carry the
    // original request independently so user-only restrictions survive omission.
    const requestText = entry.goal.slice(0, Math.max(0, Math.floor(available * 0.4) - 70));
    const request = requestText ? `Prior task request:\n${requestText}${entry.goalTruncated || requestText.length < entry.goal.length ? "\n[request incomplete]" : ""}\n` : "";
    const historyReserve = entry.earlierFindings?.length ? Math.min(900, Math.floor((available - request.length) * 0.25)) : 0;
    const evidence = entry.evidence?.sources.length ? renderTaskEvidence(entry.evidence, Math.max(0, available - request.length - historyReserve - 650), entry.goal) : "";
    const findingBudget = available - request.length - historyReserve - (evidence ? evidence.length + 16 : 0);
    const summary = entry.summary.length <= findingBudget ? entry.summary : compactContinuitySummary(entry.summary, findingBudget);
    const historyBudget = entry.earlierFindings?.length ? available - request.length - summary.length - (evidence ? evidence.length + 16 : 0) : 0;
    let history = "";
    if (historyBudget > 100) {
      history = "\nEarlier agent findings (may be superseded; bounded excerpts):";
      for (const prior of entry.earlierFindings ?? []) {
	const prefix = `\n${prior.runtime} at ${prior.occurredAt}: `;
	const space = historyBudget - history.length - prefix.length - 24;
	if (space < 60) break;
	history += prefix + prior.summary.slice(0, space) + (prior.summary.length > space ? " [finding incomplete]" : "");
      }
    }
    const finding = `${request}${evidence ? `${evidence}\nAgent finding: ${summary}` : summary}${history}`.slice(0, available);
    parts.push(`${heading}${finding}`);
    remaining -= heading.length + finding.length + 1;
  }
  return `${guidance}\n${parts.join("\n")}`;
};
