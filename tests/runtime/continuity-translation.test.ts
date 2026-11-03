import { describe, expect, it } from "vitest";

import { claudeCodeContinuityTranslationContract } from "../../src/runtime/claude-code-adapter";
import { codexContinuityTranslationContract } from "../../src/runtime/codex-adapter";
import { validateContinuityIr } from "../../src/runtime/continuity-ir";
import {
  claudeCodeContinuityFixture,
  codexContinuityFixture,
  comparableContinuitySections,
} from "./continuity-translation.fixtures";

describe("continuity translation contracts", () => {
  it("normalizes equivalent Codex and Claude Code capture data into the same canonical continuity concepts", () => {
    const codexCapture = codexContinuityTranslationContract.captureContext(codexContinuityFixture());
    const claudeCapture = claudeCodeContinuityTranslationContract.captureContext(claudeCodeContinuityFixture());

    const codexTranslation = codexContinuityTranslationContract.normalizeToContinuityIr(codexCapture, "claude-code");
    const claudeTranslation = claudeCodeContinuityTranslationContract.normalizeToContinuityIr(claudeCapture, "claude-code");

    expect(validateContinuityIr(codexTranslation.ir)).toEqual([]);
    expect(validateContinuityIr(claudeTranslation.ir)).toEqual([]);
    expect(comparableContinuitySections(codexTranslation.ir)).toEqual(comparableContinuitySections(claudeTranslation.ir));

    expect(codexTranslation.fidelity.categories).toContain("private_host_layout");
    expect(codexTranslation.fidelity.categories).toContain("tool_invocation_ids");
    expect(claudeTranslation.fidelity.categories).toContain("host_specific_settings");
  });

  it("materializes a cross-runtime translation into Claude Code prompt surfaces with explicit warnings", () => {
    const codexCapture = codexContinuityTranslationContract.captureContext(codexContinuityFixture());
    const translation = codexContinuityTranslationContract.normalizeToContinuityIr(codexCapture, "claude-code");
    const materialized = codexContinuityTranslationContract.materializeFromContinuityIr(translation, "claude-code");

    expect(materialized.targetRuntime).toBe("claude-code");
    expect(materialized.delivery.primary).toBe("--append-system-prompt");
    expect(materialized.delivery.managedSurface).toContain(".claude/settings.json");
    expect(materialized.startupContext).toContain("Task: Define the continuity IR and signed handoff translation contract.");
    expect(materialized.startupContext).toContain("Why transfer:");
    expect(materialized.continuationPlan.carriedForward).toContain("task objective");
    expect(materialized.continuationPlan.manualReestablishment.length).toBeGreaterThan(0);
    expect(materialized.warnings).toContain("downgraded engineAttachment.runtimeHost");
  });
});
