import { describe, expect, it } from "vitest";

import {
  RUNTIME_CONTINUITY_REFLECTION_DEFAULTS,
  buildRuntimeContinuityOutcome,
} from "../../src/runtime/continuity-outcomes";

describe("runtime continuity outcomes", () => {
  it("builds canonical turn and session-stop outcomes with stable trigger metadata", () => {
    const turnOutcome = buildRuntimeContinuityOutcome({
      eventId: "event-turn-1",
      runtime: "codex",
      profileName: "default",
      workspaceId: "repo:/tmp/runtime",
      sessionId: "session-1",
      turnId: "turn-1",
      type: "turn.completed",
      occurredAt: "2026-04-16T12:00:00.000Z",
      payload: {
        packId: "pack-1",
        goal: "Ship the runtime continuity scheduler safely",
        summary: "Finished the initial runtime continuity scheduler contract.",
        taskSucceeded: true,
        transcript: [{ role: "assistant", content: "Finished the initial runtime continuity scheduler contract." }],
      },
      metadata: {},
    });
    expect(turnOutcome).not.toBeNull();
    expect(turnOutcome?.trigger).toBe("turn_checkpoint");
    expect(turnOutcome?.minimumReflectionPayload).toBe(true);
    expect(turnOutcome?.packId).toBe("pack-1");
    expect(turnOutcome?.goal).toBe("Ship the runtime continuity scheduler safely");

    const sessionOutcome = buildRuntimeContinuityOutcome({
      eventId: "event-session-1",
      runtime: "codex",
      profileName: "default",
      workspaceId: "repo:/tmp/runtime",
      sessionId: "session-1",
      turnId: "turn-1",
      type: "session.ended",
      occurredAt: "2026-04-16T12:02:00.000Z",
      payload: {
        packId: "pack-1",
        goal: "Ship the runtime continuity scheduler safely",
        summary: "Session ended after the checkpoint was captured for later reflection.",
        taskSucceeded: true,
      },
      metadata: {},
    });
    expect(sessionOutcome).not.toBeNull();
    expect(sessionOutcome?.trigger).toBe("session_stop");
    expect(sessionOutcome?.fastPathEligible).toBe(true);
    expect(sessionOutcome?.minimumReflectionPayload).toBe(true);
    expect(sessionOutcome?.dedupeKey).toContain("session.ended");

    expect(RUNTIME_CONTINUITY_REFLECTION_DEFAULTS.quietWindowMinutes).toBe(10);
    expect(RUNTIME_CONTINUITY_REFLECTION_DEFAULTS.sessionStopFastPathMinutes).toBe(2);
    expect(RUNTIME_CONTINUITY_REFLECTION_DEFAULTS.minNewOutcomesPerReflect).toBe(2);
    expect(RUNTIME_CONTINUITY_REFLECTION_DEFAULTS.continuousCatchUpWindowMinutes).toBe(45);
    expect(RUNTIME_CONTINUITY_REFLECTION_DEFAULTS.continuousCatchUpMaxMinutes).toBe(60);
  });

  it("ignores non-outcome events and marks incomplete reflection payloads explicitly", () => {
    const noOutcome = buildRuntimeContinuityOutcome({
      eventId: "event-start-1",
      runtime: "codex",
      profileName: "default",
      workspaceId: "repo:/tmp/runtime",
      sessionId: "session-1",
      turnId: "turn-1",
      type: "turn.started",
      occurredAt: "2026-04-16T12:00:00.000Z",
      payload: {
        goal: "Prepare runtime context",
      },
      metadata: {},
    });
    expect(noOutcome).toBeNull();

    const incompleteOutcome = buildRuntimeContinuityOutcome({
      eventId: "event-session-2",
      runtime: "codex",
      profileName: "default",
      workspaceId: "repo:/tmp/runtime",
      sessionId: "session-2",
      turnId: null,
      type: "session.ended",
      occurredAt: "2026-04-16T12:30:00.000Z",
      payload: {
        summary: "Session ended before any context pack was retained.",
      },
      metadata: {},
    });
    expect(incompleteOutcome).not.toBeNull();
    expect(incompleteOutcome?.minimumReflectionPayload).toBe(false);
    expect(incompleteOutcome?.summary).toBe("Session ended before any context pack was retained.");
  });

  it("preserves structured continuity signals so reflection does not have to infer them from the summary", () => {
    const outcome = buildRuntimeContinuityOutcome({
      eventId: "event-structured-1",
      runtime: "codex",
      profileName: "default",
      workspaceId: "repo:/tmp/runtime",
      sessionId: "session-structured-1",
      turnId: "turn-structured-1",
      type: "turn.completed",
      occurredAt: "2026-04-18T10:00:00.000Z",
      payload: {
        packId: "pack-structured-1",
        goal: "Carry explicit continuity evidence into scheduled reflection",
        summary: "Deploy verification completed.",
        taskSucceeded: true,
        newFacts: ["Verify production after deploy before announcing completion."],
        demonstratedKnowledge: ["Can trace Cloud Run revisions with glab."],
        unresolvedRisks: ["Release notes still need operator review."],
        recentCorrections: ["Skill registration is disabled by default."],
        orientationDelta: ["Keep continuity writes inspectable and proposal-first."],
        preferredEnvironments: ["Codex with managed runtime hooks enabled."],
      },
      metadata: {},
    });

    expect(outcome).not.toBeNull();
    expect(outcome?.signals.newFacts).toEqual(["Verify production after deploy before announcing completion."]);
    expect(outcome?.signals.demonstratedKnowledge).toEqual(["Can trace Cloud Run revisions with glab."]);
    expect(outcome?.signals.unresolvedRisks).toEqual(["Release notes still need operator review."]);
    expect(outcome?.signals.preferredEnvironments).toEqual(["Codex with managed runtime hooks enabled."]);
    expect(outcome?.signalQuality.explicitSignalCount).toBe(6);
    expect(outcome?.signalQuality.usedSummaryFallback).toBe(false);
  });
});
