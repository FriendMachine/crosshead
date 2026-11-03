import { createHash } from "crypto";

// Wire format shared with the hosted service: recall tags written on captured
// turns and the archived-turn envelope. Recall selection stays server-side.
export const RECALL_TIMEOUT_MS = 4000;
export const recallGoalTag = (goal: string): string => `recall-goal:${createHash("sha256").update(goal.trim()).digest("hex")}`;
// Retain a searchable description as well as the equality-only digest. It is
// evidence from the captured turn, never an instruction or a new authority.
export const recallDescriptionTag = (goal: string): string => `recall-description:${encodeURIComponent(goal.trim())}`;
export const recallDescription = (tags: string[]): string => {
  const tag = tags.find(value => value.startsWith("recall-description:"));
  try { return tag ? decodeURIComponent(tag.slice("recall-description:".length)) : ""; } catch { return ""; }
};
export const recallTaskTag = (taskId: string): string => `recall-task:${encodeURIComponent(taskId.trim())}`;
export const recallWorkspaceTag = (workspaceId: string): string =>
  `recall-workspace:${createHash("sha256").update(workspaceId).digest("hex")}`;

export type ArchivedTurn = { schema: "crosshead_archived_turn_v1"; workspaceId: string; sessionId: string | null; taskId?: string | null; goal: string; content: string };
export const encodeArchivedTurn = (input: Omit<ArchivedTurn, "schema">): string =>
  JSON.stringify({ schema: "crosshead_archived_turn_v1", workspaceId: input.workspaceId,
    sessionId: input.sessionId, taskId: input.taskId?.trim() || null, goal: input.goal.trim(), content: input.content });
export const decodeArchivedTurn = (content: string, workspaceId: string | null | undefined): ArchivedTurn | null => {
  if (!workspaceId) return null;
  try {
    const value = JSON.parse(content);
    return value?.schema === "crosshead_archived_turn_v1" && value.workspaceId === workspaceId &&
      typeof value.goal === "string" && typeof value.content === "string" ? value : null;
  } catch { return null; }
};
