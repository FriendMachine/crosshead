import { readFileSync } from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

import {
  CONTINUITY_IR_VERSION,
  buildCapturedContinuityContext,
  buildContinuityFidelityReport,
  normalizeCapturedContextToContinuityIr,
  validateContinuityIr,
} from "../../src/runtime/continuity-ir";

describe("continuity IR", () => {
  it("validates a normalized continuity IR", () => {
    const captured = buildCapturedContinuityContext({
      runtime: "codex",
      workspaceRoot: "/tmp/onlybots-erd",
      workspaceId: "repo:onlybots-erd",
      sessionId: "session-1",
      turnId: "turn-1",
      prompt: "Continue the signed handoff work.",
      transcript: [{ role: "user", content: "Continue the signed handoff work." }],
      task: {
        objective: "Continue the signed handoff work.",
        openLoops: ["document fidelity loss"],
      },
      reasoning: {
        currentTheory: "The IR should preserve task state while degrading host-only transport details.",
      },
      memory: {
        hotSummary: "The task is about signed handoff capsules.",
      },
      delegation: {
        whyTransfer: "The next runtime may have a better execution surface.",
      },
    });

    const translation = normalizeCapturedContextToContinuityIr(captured, "claude-code");
    expect(validateContinuityIr(translation.ir)).toEqual([]);
    expect(translation.ir.engineAttachment.schemaVersion).toBe("engine_attachment_v1");
    expect(translation.ir.engineAttachment.attachmentId).toContain("engine_attach_");
    expect(translation.ir.engineAttachment.compensationHints[0]).toContain("codex to claude-code");
  });

  it("reports schema errors for malformed IR values", () => {
    const errors = validateContinuityIr({
      irVersion: "wrong",
      task: { objective: "", status: "nope" },
    });
    expect(errors).toContain(`irVersion must be ${CONTINUITY_IR_VERSION}`);
    expect(errors).toContain("task.objective must be a non-empty string");
    expect(errors).toContain("task.status must be a valid continuity task status");
    expect(errors).toContain("identity must be present");
  });

  it("grades fidelity loss consistently", () => {
    const high = buildContinuityFidelityReport({
      sourceRuntime: "codex",
      targetRuntime: "claude-code",
      fieldEffects: [
        {
          field: "host.codexHome",
          action: "omitted",
          category: "private_host_layout",
          reason: "Host-local path redacted.",
        },
      ],
      redactions: [
        {
          field: "host.codexHome",
          reason: "host_private_path",
          description: "Host-local path redacted.",
        },
      ],
      opaqueAttachments: [],
    });
    expect(high.level).toBe("high");

    const partial = buildContinuityFidelityReport({
      sourceRuntime: "codex",
      targetRuntime: "claude-code",
      fieldEffects: [
        {
          field: "task.objective",
          action: "omitted",
          category: "ephemeral_runtime_state",
          reason: "Objective missing.",
        },
      ],
      redactions: [],
      opaqueAttachments: [],
    });
    expect(partial.level).toBe("partial");

    const minimal = buildContinuityFidelityReport({
      sourceRuntime: "codex",
      targetRuntime: "claude-code",
      fieldEffects: [
        {
          field: "task.objective",
          action: "omitted",
          category: "ephemeral_runtime_state",
          reason: "Objective missing.",
        },
        {
          field: "reasoningState.currentTheory",
          action: "omitted",
          category: "ephemeral_runtime_state",
          reason: "Theory missing.",
        },
      ],
      redactions: [],
      opaqueAttachments: [],
    });
    expect(minimal.level).toBe("minimal");
  });

  it("checks in the published continuity IR schema artifact", () => {
    const schemaPath = path.resolve(process.cwd(), "schemas/continuity-ir.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      $id?: string;
      properties?: { irVersion?: { const?: string } };
      required?: string[];
    };

    expect(schema.$id).toContain("continuity-ir");
    expect(schema.properties?.irVersion?.const).toBe(CONTINUITY_IR_VERSION);
    expect(schema.required).toContain("task");
    expect(schema.required).toContain("reasoningState");
    expect(schema.required).toContain("provenance");
  });
});
