import { readFileSync } from "fs";
import path from "path";
import { writeJsonFile } from "./runtime-persistence";

// When each hot checkpoint was last delivered to a session. Local only, never
// synced: retention on this machine prefers checkpoints that are still being
// used over ones that are merely recent. The synced replica stays
// deterministic across devices and does not read this.
const MAX_ENTRIES = 256;
const useFile = (stateDir: string): string => path.join(stateDir, "hot-checkpoint-use.json");

/** Identity of a checkpoint that survives re-rendering and evidence merges. */
export const hotCheckpointUseKey = (entry: { workspaceId: string | null; runtime: string; origin?: string; sessionId: string | null; turnId: string | null; goal: string }): string =>
  JSON.stringify([entry.workspaceId, entry.runtime, entry.origin ?? null, entry.sessionId, entry.turnId, entry.goal.slice(0, 200)]);

export const readHotUse = (stateDir: string): Map<string, number> => {
  try {
    const value = JSON.parse(readFileSync(useFile(stateDir), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
    return new Map(Object.entries(value as Record<string, unknown>).flatMap(([key, at]) =>
      typeof at === "number" && Number.isFinite(at) ? [[key, at] as [string, number]] : []));
  } catch { return new Map(); }
};

export const recordHotUse = (stateDir: string, keys: string[], at: number = Date.now()): void => {
  if (!keys.length) return;
  try {
    const uses = readHotUse(stateDir);
    for (const key of keys) { uses.delete(key); uses.set(key, at); }
    writeJsonFile(useFile(stateDir), Object.fromEntries([...uses.entries()].sort((a, b) => a[1] - b[1]).slice(-MAX_ENTRIES)));
  } catch { /* Use only ranks retention; a lost write keeps age order. */ }
};
