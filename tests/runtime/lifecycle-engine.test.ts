import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildContinuityGovernorState } from "../../src/runtime/continuity-governor";
import { buildDefaultContinuityPolicy } from "../../src/runtime/continuity-policy";
import {
  readRuntimeDreamReviewHudSnapshot,
  readRuntimeInboxHudSnapshot,
  RuntimeLifecycleManager,
  type RuntimeLifecycleHealthState,
  type RuntimeLifecycleMemoryMode,
  type RuntimeLifecycleProfile,
  type RuntimeLifecycleSecret,
} from "../../src/runtime/lifecycle-engine";

// Unit tests for the lifecycle manager. These exercise the offline code paths
// (dedup, mode gating, governor pausing, persistence, locking, timers) — paths
// that talk to the hosted API are covered by the runtime integration tests.

const FIXED_NOW = new Date("2026-06-01T12:00:00.000Z");

type Harness = {
  stateDir: string;
  manager: RuntimeLifecycleManager;
  savedHealth: RuntimeLifecycleHealthState[];
  logs: Array<{ event: string; payload: Record<string, unknown> }>;
  setPaused: (paused: boolean, reasons?: string[]) => void;
};

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const buildHarness = (memoryMode: RuntimeLifecycleMemoryMode): Harness => {
  const home = mkdtempSync(path.join(os.tmpdir(), "onlybots-lifecycle-engine-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const stateDir = path.join(home, "state");

  const profile: RuntimeLifecycleProfile = {
    name: "default",
    apiBase: "http://127.0.0.1:9",
    npub: "npub1lifecycletest",
    memoryMode,
    features: { coldSync: false, autoWarmPromotion: false },
  };
  const secret: RuntimeLifecycleSecret = { nsec: "nsec1unused", session: null };

  let health: RuntimeLifecycleHealthState = {
    queueDepth: 0,
    lastSuccessfulSyncAt: null,
    lastError: null,
  };
  const savedHealth: RuntimeLifecycleHealthState[] = [];
  const logs: Array<{ event: string; payload: Record<string, unknown> }> = [];

  let governorState = buildContinuityGovernorState(buildDefaultContinuityPolicy(FIXED_NOW), [], FIXED_NOW);

  const manager = new RuntimeLifecycleManager({
    paths: { state: stateDir },
    loadDefaultProfileName: () => "default",
    loadProfile: (name) => (name === "default" ? profile : null),
    loadSecret: (name) => (name === "default" ? secret : null),
    saveSecret: () => {},
    loadHealth: () => health,
    saveHealth: (next) => {
      health = next;
      savedHealth.push(next);
    },
    loadContinuityGovernorState: () => governorState,
    writeLog: (event, payload) => {
      logs.push({ event, payload });
    },
    now: () => FIXED_NOW,
  });

  return {
    stateDir,
    manager,
    savedHealth,
    logs,
    setPaused: (paused, reasons = ["budget review pending"]) => {
      governorState = { ...governorState, paused, pauseReasons: paused ? reasons : [] };
    },
  };
};

describe("RuntimeLifecycleManager", () => {
  it("records events and mode_skip actions for memoryMode off, and persists them to activity", async () => {
    const { manager, stateDir } = buildHarness("off");

    const response = await manager.handleEvent({
      eventId: "evt-1",
      runtime: "claude-code",
      type: "turn.completed",
      sessionId: "sess-1",
      turnId: "turn-1",
      payload: { summary: "did things" },
    });

    expect(response.event.eventId).toBe("evt-1");
    expect(response.actions.some((action) => action.type === "mode_skip" && action.status === "skipped")).toBe(true);

    const activity = await manager.readActivity();
    expect(activity.events.map((event) => event.eventId)).toContain("evt-1");
    expect(activity.actions.some((action) => action.eventId === "evt-1" && action.type === "mode_skip")).toBe(true);

    // Events and actions are durable JSONL files under the state dir.
    expect(existsSync(path.join(stateDir, "lifecycle-events.jsonl"))).toBe(true);
    expect(existsSync(path.join(stateDir, "memory-actions.jsonl"))).toBe(true);
    const eventsRaw = readFileSync(path.join(stateDir, "lifecycle-events.jsonl"), "utf8").trim();
    expect(eventsRaw.split("\n")).toHaveLength(1);
  });

  it("refuses to append lifecycle events through a symlink", async () => {
    const { manager, stateDir } = buildHarness("off");
    mkdirSync(stateDir, { recursive: true });
    const outside = path.join(path.dirname(stateDir), "outside-events.jsonl");
    writeFileSync(outside, "unchanged\n");
    symlinkSync(outside, path.join(stateDir, "lifecycle-events.jsonl"));

    await expect(manager.handleEvent({
      eventId: "evt-symlink",
      runtime: "codex",
      type: "turn.completed",
    })).rejects.toThrow();
    expect(readFileSync(outside, "utf8")).toBe("unchanged\n");
  });

  it("deduplicates events by eventId and records a duplicate_event action", async () => {
    const { manager } = buildHarness("off");

    await manager.handleEvent({ eventId: "evt-dup", runtime: "codex", type: "turn.completed" });
    const second = await manager.handleEvent({ eventId: "evt-dup", runtime: "codex", type: "turn.completed" });

    expect(second.actions.some((action) => action.type === "duplicate_event" && action.status === "skipped")).toBe(true);

    const activity = await manager.readActivity();
    expect(activity.events.filter((event) => event.eventId === "evt-dup")).toHaveLength(1);
  });

  it("serializes concurrent handleEvent calls so duplicates cannot race past the dedup check", async () => {
    const { manager } = buildHarness("off");

    const [first, second] = await Promise.all([
      manager.handleEvent({ eventId: "evt-race", runtime: "codex", type: "turn.completed" }),
      manager.handleEvent({ eventId: "evt-race", runtime: "codex", type: "turn.completed" }),
    ]);

    const duplicateActions = [...first.actions, ...second.actions].filter(
      (action) => action.type === "duplicate_event"
    );
    expect(duplicateActions).toHaveLength(1);

    const activity = await manager.readActivity();
    expect(activity.events.filter((event) => event.eventId === "evt-race")).toHaveLength(1);
  });

  it("skips runtime-managed memory work while the continuity governor is paused", async () => {
    const harness = buildHarness("auto");
    harness.setPaused(true, ["operator requested freeze"]);

    const response = await harness.manager.handleEvent({
      eventId: "evt-paused",
      runtime: "codex",
      type: "turn.completed",
      payload: { summary: "did things" },
    });

    const skip = response.actions.find((action) => action.type === "mode_skip");
    expect(skip).toBeTruthy();
    expect(skip?.reason).toContain("Continuity governor paused");
    expect(skip?.reason).toContain("operator requested freeze");
  });

  it("tracks queue health on every handled event", async () => {
    const { manager, savedHealth } = buildHarness("off");

    await manager.handleEvent({ eventId: "evt-health", runtime: "codex", type: "turn.completed" });

    expect(savedHealth.length).toBeGreaterThan(0);
    const last = savedHealth[savedHealth.length - 1]!;
    expect(last.queueDepth).toBe(0);
    expect(last.backpressure).toBe(false);
  });

  it("starts a single worker timer, tolerates double start, and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = buildHarness("off");
      const setIntervalSpy = vi.spyOn(global, "setInterval");

      manager.start();
      manager.start();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      // The periodic flush over an empty queue must be a no-op, not an error.
      await vi.advanceTimersByTimeAsync(20_000);

      await manager.stop();
      await manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes an empty queue without error and without touching the network", async () => {
    const { manager } = buildHarness("auto");
    await expect(manager.flushDueItems(true)).resolves.toBeUndefined();
  });
});

describe("runtime HUD snapshot readers", () => {
  it("returns null when no HUD store exists", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "onlybots-hud-snapshot-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    expect(readRuntimeInboxHudSnapshot(home, "default")).toBeNull();
    expect(readRuntimeDreamReviewHudSnapshot(home, "default")).toBeNull();
  });

  it("round-trips a stored inbox HUD snapshot for the requested profile", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "onlybots-hud-snapshot-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const snapshot = {
      profileName: "default",
      fetchedAt: "2026-06-01T12:00:00.000Z",
      fetchError: null,
      summary: null,
      items: [],
    };
    writeFileSync(
      path.join(home, "inbox-hud.json"),
      JSON.stringify({
        schemaVersion: "runtime_inbox_hud_v1",
        profiles: { default: { snapshot, lastAnnouncedActiveIds: [], lastAnnouncedAt: null } },
      })
    );
    expect(readRuntimeInboxHudSnapshot(home, "default")).toMatchObject({ profileName: "default" });
    expect(readRuntimeInboxHudSnapshot(home, "other")).toBeNull();
  });
});
