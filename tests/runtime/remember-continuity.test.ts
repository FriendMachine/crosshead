import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import { RuntimeLifecycleManager } from "../../src/runtime/lifecycle-engine";
import { stopHotSyncManagers } from "../../src/runtime/hot-sync-manager";
import { buildContinuityGovernorState } from "../../src/runtime/continuity-governor";
import { buildDefaultContinuityPolicy } from "../../src/runtime/continuity-policy";
import { renderHotCheckpoints, selectHotCheckpoints, updateHotCheckpoints } from "../../src/runtime/hot-continuity";
import { HOT_SYNC_VERSION, validHotSyncDocument } from "../../src/protocol/hot-sync";

describe("explicit remember continuity", () => {
  it.each([true, false])("retains explicitly supplied requirements after restart (local-only=%s)", async localOnly => {
    const state = mkdtempSync(path.join(tmpdir(), "xhd-remember-"));
    const key = generateSecretKey();
    const npub = nip19.npubEncode(getPublicKey(key)), nsec = nip19.nsecEncode(key);
    vi.stubEnv("CROSSHEAD_HOT_SYNC_ENABLED", "true");
    vi.stubEnv("CROSSHEAD_CAPTURE_SOURCE_EVIDENCE", "0");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const make = () => new RuntimeLifecycleManager({
      paths: { state }, hotWriteDebounceMs: 0,
      loadDefaultProfileName: () => "default",
      loadProfile: () => ({ name: "default", apiBase: localOnly ? "http://127.0.0.1:0" : "https://crosshead.sh", npub,
        memoryMode: "assist", features: { coldSync: false, autoWarmPromotion: false } }),
      loadSecret: () => ({ nsec, session: null }), saveSecret: () => {},
      loadHealth: () => ({ queueDepth: 0, lastSuccessfulSyncAt: null, lastError: null }), saveHealth: () => {},
      loadContinuityGovernorState: () => buildContinuityGovernorState(buildDefaultContinuityPolicy(), []), writeLog: () => {},
    });
    const content = "Canonical-code: trim ASCII space at ends only; collapse underscore runs to one hyphen; lowercase ASCII A-Z only. Preserve internal spaces and non-ASCII letters. Empty becomes unknown. Output is a STRING.";
    let manager = make();
    try {
      await manager.handleEvent({ eventId: "remember", runtime: "codex", type: "operator.command", workspaceId: "repo:/fixture", sessionId: "investigate",
        payload: { command: "remember", content, entryType: "fact" } });
      const second = "Codex session ended unexpectedly; preserve the receipt rule: never replay accepted payments.";
      await manager.handleEvent({ eventId: "remember-second", runtime: "codex", type: "operator.command", workspaceId: "repo:/fixture", sessionId: "investigate",
        payload: { command: "remember", content: second, entryType: "fact" } });
      await manager.handleEvent({ eventId: "completed", runtime: "codex", type: "turn.completed", workspaceId: "repo:/fixture", sessionId: "investigate",
        payload: { summary: "Display labels replace underscores with spaces and preserve case." } });
      await manager.handleEvent({ eventId: "ended", runtime: "codex", type: "session.ended", workspaceId: "repo:/fixture", sessionId: "investigate",
        payload: { summary: "Codex session ended." } });
      await manager.flushDueItems(true);
      const events = readFileSync(path.join(state, "lifecycle-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(events.find(event => event.type === "operator.command").payload.content).toBe(content);
      await manager.stop();
      await stopHotSyncManagers(state);
      manager = make();
      for (const runtime of ["codex", "claude-code"]) {
        const result = await manager.handleEvent({ eventId: `fresh-${runtime}`, runtime, type: "turn.started", workspaceId: "repo:/fixture", sessionId: `fresh-${runtime}`,
          payload: { goal: "Implement the canonical-code rule." } });
        expect(JSON.stringify(result.contextPack)).toContain(content);
        expect(JSON.stringify(result.contextPack)).toContain(second);
      }
      const foreign = await manager.handleEvent({ eventId: "foreign", runtime: "codex", type: "turn.started", workspaceId: "repo:/other", payload: { goal: "Continue" } });
      expect(JSON.stringify(foreign.contextPack)).not.toContain(content);
    } finally {
      await manager.stop();
      await stopHotSyncManagers(state);
      vi.unstubAllEnvs(); vi.unstubAllGlobals();
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("delivers a memory that fits the context budget once, without treating it as a task request", () => {
    const lines = Array.from({ length: 65 }, (_, i) => `Requirement ${i}: input value ${i} maps to result ${i + 1}.`);
    const summary = lines.join("\n") + "\nEmpty input returns a string.";
    const checkpoint = { runtime: "codex", workspaceId: "repo:/fixture", sessionId: "source", turnId: "remember-event", origin: "remember" as const,
      goal: "", summary, occurredAt: "2026-11-09T01:00:00Z" };
    const stored = updateHotCheckpoints([], checkpoint);
    const rendered = renderHotCheckpoints(selectHotCheckpoints({ continuityCheckpoints: stored }, "Implement fixture", "repo:/fixture"));
    for (const line of lines) expect(rendered).toContain(line);
    expect(rendered).toContain("Explicitly saved memory");
    expect(rendered).not.toContain("Prior task request");
    expect(rendered.length).toBeLessThanOrEqual(4200);
    const document = { version: HOT_SYNC_VERSION, namespace: "default", scope: "codex", epoch: 0,
      checkpoints: [{ ...checkpoint, id: "remember-event", deviceId: "device" }] };
    expect(validHotSyncDocument(document)).toBe(true);
    expect(validHotSyncDocument({ ...document, checkpoints: [{ ...document.checkpoints[0], origin: "arbitrary" }] })).toBe(false);
  });
});
