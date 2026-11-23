import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { updateHotCheckpoints, type HotContinuityCheckpoint } from "../../src/runtime/hot-continuity";
import { hotCheckpointUseKey, readHotUse, recordHotUse } from "../../src/runtime/hot-use";
import { retainHotSync } from "../../src/runtime/hot-sync-replica";
import { HOT_SYNC_VERSION, type HotSyncCheckpoint } from "../../src/protocol/hot-sync";

const at = (minute: number): string => new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString();
const entry = (i: number, overrides: Partial<HotContinuityCheckpoint> = {}): HotContinuityCheckpoint => ({
  runtime: "codex", workspaceId: "repo:/w", sessionId: `s${i}`, turnId: `t${i}`, goal: `Task ${i}`, summary: `Finding ${i}`, occurredAt: at(i), ...overrides,
});
const fill = (count: number, first: HotContinuityCheckpoint[] = [], lastUsed?: (e: HotContinuityCheckpoint) => number): HotContinuityCheckpoint[] => {
  let stored: HotContinuityCheckpoint[] = [];
  for (const item of first) stored = updateHotCheckpoints(stored, item, lastUsed);
  for (let i = 100; i < 100 + count; i += 1) stored = updateHotCheckpoints(stored, entry(i), lastUsed);
  return stored;
};

describe("local hot retention", () => {
  it("keeps the latest explicit saves when newer work would evict them by age", () => {
    const saves = [1, 2, 3, 4].map(i => entry(i, { origin: "remember", goal: "", summary: `Saved fact ${i}` }));
    const stored = fill(12, saves);
    expect(stored).toHaveLength(12);
    const kept = stored.filter(e => e.origin === "remember").map(e => e.summary);
    expect(kept).toEqual(["Saved fact 2", "Saved fact 3", "Saved fact 4"]);
    // The newest capture is always kept, and stored order stays chronological.
    expect(stored.at(-1)?.goal).toBe("Task 111");
    expect(stored.map(e => e.occurredAt)).toEqual([...stored.map(e => e.occurredAt)].sort());
  });

  it("caps protected saves across workspaces", () => {
    const saves = Array.from({ length: 12 }, (_, i) => entry(i, { origin: "remember", goal: "", workspaceId: `repo:/w${i % 4}`, summary: `Saved ${i}` }));
    const stored = fill(12, saves);
    expect(stored.filter(e => e.origin === "remember")).toHaveLength(6);
  });

  it("prefers history that is still being delivered over idle newer history", () => {
    const used = entry(5, { goal: "Parcel batching contract" });
    const stored = fill(12, [used], e => e.turnId === "t5" ? Date.parse(at(500)) : 0);
    expect(stored.some(e => e.turnId === "t5")).toBe(true);
    expect(stored.some(e => e.turnId === "t100")).toBe(false);
    expect(fill(12, [used]).some(e => e.turnId === "t5")).toBe(false);
  });

  it("records use locally, bounded", () => {
    const state = mkdtempSync(path.join(tmpdir(), "crosshead-hot-use-"));
    try {
      recordHotUse(state, [hotCheckpointUseKey(entry(1))], 1000);
      recordHotUse(state, Array.from({ length: 300 }, (_, i) => `k${i}`), 2000);
      const uses = readHotUse(state);
      expect(uses.size).toBe(256);
      expect(uses.get("k299")).toBe(2000);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });
});

describe("replica retention", () => {
  const sync = (i: number, overrides: Partial<HotSyncCheckpoint> = {}): HotSyncCheckpoint => ({
    id: `c${String(i).padStart(3, "0")}`, deviceId: "d", runtime: "codex", workspaceId: "repo:/w", occurredAt: at(i), goal: `Task ${i}`, summary: `Finding ${i}`, ...overrides,
  });
  it("keeps the latest explicit saves deterministically", () => {
    const checkpoints = [...[1, 2, 3, 4].map(i => sync(i, { origin: "remember" })), ...Array.from({ length: 12 }, (_, i) => sync(100 + i))];
    const document = { version: HOT_SYNC_VERSION, namespace: "n", scope: "s", epoch: 0, checkpoints } as const;
    const kept = retainHotSync({ ...document, checkpoints: [...checkpoints] });
    expect(kept.checkpoints).toHaveLength(12);
    expect(kept.checkpoints.filter(c => c.origin === "remember").map(c => c.id)).toEqual(["c002", "c003", "c004"]);
    expect(retainHotSync({ ...document, checkpoints: [...checkpoints].reverse() }).checkpoints.map(c => c.id)).toEqual(kept.checkpoints.map(c => c.id));
  });
});
