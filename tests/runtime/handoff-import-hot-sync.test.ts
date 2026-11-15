import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { RuntimeLifecycleManager } from "../../src/runtime/lifecycle-engine";
import { getHotSyncManager, stopHotSyncManagers } from "../../src/runtime/hot-sync-manager";
import { buildContinuityGovernorState } from "../../src/runtime/continuity-governor";
import { buildDefaultContinuityPolicy } from "../../src/runtime/continuity-policy";
import { HANDOFF_IMPORT_COMMAND } from "../../src/runtime/handoff-import";
import { selectHotCheckpoints } from "../../src/runtime/hot-continuity";

// The case the handoff work is for: a hosted profile (hot sync on) on a machine that cannot reach the service.
describe("imported handoffs on an offline hosted profile", () => {
  it("replaces the synced copy on re-import, and pins the import for the next prompt", async () => {
    const state = mkdtempSync(path.join(tmpdir(), "xhd-handoff-sync-"));
    const key = generateSecretKey();
    const npub = nip19.npubEncode(getPublicKey(key)), nsec = nip19.nsecEncode(key);
    vi.stubEnv("CROSSHEAD_HOT_SYNC_ENABLED", "true");
    vi.stubEnv("CROSSHEAD_CAPTURE_SOURCE_EVIDENCE", "0");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const apiBase = "https://crosshead.sh";
    const manager = new RuntimeLifecycleManager({
      paths: { state }, hotWriteDebounceMs: 0,
      loadDefaultProfileName: () => "default",
      loadProfile: () => ({ name: "default", apiBase, npub, memoryMode: "assist", features: { coldSync: false, autoWarmPromotion: false } }),
      loadSecret: () => ({ nsec, session: null }), saveSecret: () => {},
      loadHealth: () => ({ queueDepth: 0, lastSuccessfulSyncAt: null, lastError: null }), saveHealth: () => {},
      loadContinuityGovernorState: () => buildContinuityGovernorState(buildDefaultContinuityPolicy(), []), writeLog: () => {},
    });
    const workspaceId = "repo:/fixture";
    const imported = (n: number) => manager.handleEvent({
      eventId: `handoff-import-abc-${n}`, runtime: "claude-code", type: "operator.command", workspaceId, sessionId: "handoff-import",
      payload: { command: HANDOFF_IMPORT_COMMAND, goal: "Imported handoff from codex (created 2026-11-15): finish the ledger migration",
        content: `Imported handoff from codex, signed by this profile's key. Checksum fails on empty rows (copy ${n}).`, handoffTurnId: "handoff-abc" },
    });
    try {
      await manager.handleEvent({ eventId: "older", runtime: "claude-code", type: "turn.completed", workspaceId, sessionId: "older", turnId: "t1",
        payload: { goal: "Fix the auth token refresh bug", summary: "Auth token refresh fixed by retrying once on 401." } });
      for (const n of [1, 2, 3]) expect((await imported(n)).actions.some((action) => action.type === "hot_write")).toBe(true);

      const synced = getHotSyncManager({ stateDir: state, origin: apiBase, npub, nsec, profileName: "default" });
      const content = JSON.parse(String(synced.readWorkspace("claude-code", workspaceId).content ?? "{}"));
      const imports = (content.continuityCheckpoints ?? []).filter((c: { turnId?: string }) => c.turnId === "handoff-abc");
      expect(imports).toHaveLength(1);
      expect(imports[0].summary).toContain("copy 3");

      const next = await manager.handleEvent({ eventId: "next", runtime: "claude-code", type: "turn.started", workspaceId, sessionId: "next",
        payload: { goal: "Look at the auth token refresh again" } });
      const context = JSON.stringify(next.contextPack);
      expect(context).toContain("Auth token refresh fixed");
      expect(context).toContain("copy 3");
      expect(context).not.toContain("Explicitly saved memory");
    } finally {
      await manager.stop();
      await stopHotSyncManagers(state);
      vi.unstubAllEnvs(); vi.unstubAllGlobals();
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("pins only an import dated near now, so a fast clock elsewhere cannot pin it indefinitely", () => {
    const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
    const snapshot = (importOffset: number) => ({ continuityCheckpoints: [
      { runtime: "codex", workspaceId: "repo:/w", sessionId: "s", turnId: "t1", goal: "Fix the auth token refresh bug", summary: "Auth fixed.", occurredAt: at(-60_000) },
      { runtime: "codex", workspaceId: "repo:/w", sessionId: "handoff-import", turnId: "handoff-abc", goal: "Imported handoff from codex: ledger", summary: "Imported handoff text.", occurredAt: at(importOffset) },
    ] });
    const pinned = (importOffset: number) => selectHotCheckpoints(snapshot(importOffset), "auth token refresh", "repo:/w").some((entry) => entry.turnId === "handoff-abc");
    expect(pinned(-1000)).toBe(true);
    expect(pinned(60 * 60 * 1000)).toBe(false);
    expect(pinned(-8 * 24 * 60 * 60 * 1000)).toBe(false);
  });
});
