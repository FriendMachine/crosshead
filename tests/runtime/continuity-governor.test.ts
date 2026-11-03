import { describe, expect, it } from "vitest";

import {
  applyContinuityGovernorPatch,
  buildContinuityGovernorState,
  continuityGovernorPatchAffectedRuleIds,
  removeContinuityGovernorPatch,
  resolveContinuityGovernorPatchHistory,
} from "../../src/runtime/continuity-governor";
import { buildDefaultContinuityPolicy } from "../../src/runtime/continuity-policy";

describe("continuity governor", () => {
  it("merges pause, budget, review, and memory-scope patches deterministically", () => {
    const base = buildDefaultContinuityPolicy();
    const createdAt = new Date("2026-04-09T15:00:00.000Z");

    const { patch: budgetPatch } = applyContinuityGovernorPatch(
      base,
      [],
      {
        patchType: "budget_ceiling",
        actor: "operator:test",
        reason: "Clamp automatic write volume during rollout",
        budgetCeiling: {
          maxBudgetSats: 200,
          maxWarmWritesPerTurn: 2,
        },
      },
      createdAt
    );
    const { patch: reviewPatch } = applyContinuityGovernorPatch(
      base,
      [budgetPatch],
      {
        patchType: "review_gate",
        actor: "operator:test",
        reviewGate: {
          requireReviewFor: ["external_publish"],
          selfModificationMode: "disallowed",
          writeThreshold: "explicit_only",
        },
      },
      new Date("2026-04-09T15:00:01.000Z")
    );
    const { patch: memoryScopePatch } = applyContinuityGovernorPatch(
      base,
      [budgetPatch, reviewPatch],
      {
        patchType: "memory_scope",
        actor: "operator:test",
        memoryScope: {
          includeWarmMemory: false,
          includeLayeredContext: false,
        },
      },
      new Date("2026-04-09T15:00:02.000Z")
    );
    const { state } = applyContinuityGovernorPatch(
      base,
      [budgetPatch, reviewPatch, memoryScopePatch],
      {
        patchType: "pause",
        actor: "operator:test",
        pause: {
          message: "Pause runtime automation while the operator inspects drift",
        },
      },
      new Date("2026-04-09T15:00:03.000Z")
    );

    expect(state.paused).toBe(true);
    expect(state.pauseReasons).toContain("Pause runtime automation while the operator inspects drift");
    expect(state.effectivePolicy.governance.budgetCeilings.maxBudgetSats).toBe(200);
    expect(state.effectivePolicy.governance.budgetCeilings.maxWarmWritesPerTurn).toBe(2);
    expect(state.effectivePolicy.governance.budgetCeilings.maxColdItemsPerBatch).toBe(24);
    expect(state.effectivePolicy.governance.selfModificationMode).toBe("disallowed");
    expect(state.effectivePolicy.memory.writeThreshold).toBe("explicit_only");
    expect(state.effectivePolicy.governance.requireReviewFor).toContain("external_publish");
    expect(state.memoryScope.includeHotMemory).toBe(true);
    expect(state.memoryScope.includeWarmMemory).toBe(false);
    expect(state.memoryScope.includeColdMemory).toBe(true);
    expect(state.memoryScope.includeLayeredContext).toBe(false);
    expect(state.activePatches.map((patch) => patch.patchType)).toEqual([
      "budget_ceiling",
      "review_gate",
      "memory_scope",
      "pause",
    ]);
    expect(continuityGovernorPatchAffectedRuleIds(reviewPatch)).toEqual([
      "memory_write_threshold",
      "human_review_gates",
      "self_modification",
    ]);
  });

  it("removes active patches while keeping auditable history", () => {
    const base = buildDefaultContinuityPolicy();
    const { patch } = applyContinuityGovernorPatch(base, [], {
      patchType: "pause",
      actor: "operator:test",
      reason: "Suspend queue flush during an incident",
      pause: {
        message: "Hold background writes",
      },
    });

    const { patch: removedPatch, state } = removeContinuityGovernorPatch(
      base,
      [patch],
      patch.patchId,
      "Incident resolved",
      new Date("2026-04-09T15:05:00.000Z")
    );

    expect(removedPatch.status).toBe("removed");
    expect(removedPatch.removedReason).toBe("Incident resolved");
    expect(state.paused).toBe(false);
    expect(state.activePatches).toHaveLength(0);

    const restoredHistory = resolveContinuityGovernorPatchHistory(JSON.parse(JSON.stringify(state.patchHistory)));
    expect(restoredHistory).toHaveLength(1);
    expect(restoredHistory[0]?.status).toBe("removed");
    expect(restoredHistory[0]?.removedReason).toBe("Incident resolved");
  });

  it("records rejected patches instead of silently ignoring invalid input", () => {
    const base = buildDefaultContinuityPolicy();
    const { patch, state } = applyContinuityGovernorPatch(base, [], {
      patchType: "budget_ceiling",
      actor: "operator:test",
      budgetCeiling: {},
    });

    expect(patch.status).toBe("rejected");
    expect(patch.acceptance.accepted).toBe(false);
    expect(patch.acceptance.reasons[0]).toContain("budget_ceiling patch requires at least one ceiling field");
    expect(state.patchHistory).toHaveLength(1);
    expect(buildContinuityGovernorState(base, state.patchHistory).patchHistory[0]?.status).toBe("rejected");
  });
});
