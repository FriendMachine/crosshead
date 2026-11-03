import { describe, expect, it } from "vitest";

import {
  buildDefaultContinuityPolicy,
  inspectContinuityPolicy,
  resolveContinuityPolicy,
  ContinuityPolicyValidationError,
} from "../../src/runtime/continuity-policy";

describe("continuity policy", () => {
  it("defaults cleanly and reports honest host degradation when requested enforcement exceeds host control", () => {
    const policy = resolveContinuityPolicy({
      enforcement: {
        tool_approval: "enforced",
        self_modification: "enforced",
        trust_zones: "enforced",
      },
      authority: {
        hotMemory: "merge",
      },
    });

    const inspection = inspectContinuityPolicy({
      source: "stored_policy",
      policy,
      hosts: [
        {
          host: "codex",
          automationHealthy: true,
          runtimeControlsMemory: true,
          canEnforceTrustZones: false,
          canInterceptToolUse: false,
          canRestrictSelfModification: false,
          canRequireHumanReview: false,
          canEnforceBudgetCeilings: true,
        },
      ],
    });

    expect(inspection.degraded).toBe(true);
    expect(inspection.sharedRuntime.rules.find((rule) => rule.ruleId === "memory_hot_write")?.effective).toBe("enforced");
    expect(inspection.hosts[0]?.rules.find((rule) => rule.ruleId === "tool_approval")?.effective).toBe("advisory");
    expect(inspection.hosts[0]?.rules.find((rule) => rule.ruleId === "trust_zones")?.effective).toBe("best_effort");
    expect(inspection.authority.find((entry) => entry.tier === "hot_memory")?.effectiveMode).toBe("authoritative_local");
    expect(inspection.unresolvedConflicts.some((conflict) => conflict.id === "tool_approval")).toBe(true);
    expect(inspection.unresolvedConflicts.some((conflict) => conflict.id === "hot_memory")).toBe(true);
  });

  it("rejects invalid policy fields", () => {
    expect(() =>
      resolveContinuityPolicy({
        memory: {
          writeThreshold: "never",
        },
      })
    ).toThrow(ContinuityPolicyValidationError);
  });

  it("builds stable v1 defaults", () => {
    const policy = buildDefaultContinuityPolicy(new Date("2026-04-09T00:00:00.000Z"));
    expect(policy.policyVersion).toBe("continuity_policy_v1");
    expect(policy.memory.writeThreshold).toBe("auto");
    expect(policy.authority.warmMemory).toBe("authoritative_remote");
    expect(policy.governance.budgetCeilings.maxWarmWritesPerTurn).toBeGreaterThan(0);
  });
});
