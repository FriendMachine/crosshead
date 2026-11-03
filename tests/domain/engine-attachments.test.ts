import { describe, expect, it } from "vitest";

import {
  ENGINE_ATTACHMENT_SCHEMA_VERSION,
  ENGINE_PORTABILITY_DIAGNOSTICS_VERSION,
  buildEngineAttachment,
  deriveEnginePortabilityDiagnostics,
  validateEngineAttachment,
  validateEnginePortabilityDiagnostics,
} from "../../src/protocol/engine-attachments";

describe("engine attachment contracts", () => {
  it("validates shared engine attachments and bounded-drift diagnostics", () => {
    const previous = buildEngineAttachment({
      attachmentId: "engine_attach_codex_gpt5_prev",
      provider: "openai",
      modelFamily: "gpt-5",
      modelId: "gpt-5.4",
      runtimeHost: "codex",
      hostVersion: "0.3.0",
      promptTransport: "additionalContext",
      attachedAt: "2026-04-18T00:00:00.000Z",
      detachedAt: "2026-04-18T01:00:00.000Z",
      portabilityNotes: ["Keep operator expectations explicit across host drift."],
      continuityFidelityNotes: ["Prompt ergonomics can drift across hosts."],
      compensationHints: ["Re-check tool posture before unattended work."],
    });
    const current = buildEngineAttachment({
      attachmentId: "engine_attach_claude_gpt5_curr",
      provider: "openai",
      modelFamily: "gpt-5",
      modelId: "gpt-5.5",
      runtimeHost: "claude-code",
      hostVersion: "0.3.1",
      promptTransport: "--append-system-prompt",
      attachedAt: "2026-04-18T02:00:00.000Z",
      portabilityNotes: ["Keep operator expectations explicit across host drift."],
      continuityFidelityNotes: ["Prompt ergonomics can drift across hosts."],
      compensationHints: ["Re-check tool posture before unattended work."],
    });

    const diagnostics = deriveEnginePortabilityDiagnostics(current, [previous]);

    expect(current.schemaVersion).toBe(ENGINE_ATTACHMENT_SCHEMA_VERSION);
    expect(validateEngineAttachment(current)).toEqual([]);
    expect(diagnostics.schemaVersion).toBe(ENGINE_PORTABILITY_DIAGNOSTICS_VERSION);
    expect(validateEnginePortabilityDiagnostics(diagnostics)).toEqual([]);
    expect(diagnostics.stability).toBe("bounded_drift");
    expect(diagnostics.reasons.some((reason) => reason.includes("Model id changed"))).toBe(true);
    expect(diagnostics.reasons.some((reason) => reason.includes("Runtime host changed"))).toBe(true);
  });

  it("escalates portability risk across provider or model-family changes", () => {
    const previous = buildEngineAttachment({
      attachmentId: "engine_attach_claude_prev",
      provider: "anthropic",
      modelFamily: "claude-sonnet-4",
      modelId: "claude-sonnet-4-20260301",
      runtimeHost: "claude-code",
      hostVersion: "0.3.0",
      promptTransport: "--append-system-prompt",
      attachedAt: "2026-04-17T00:00:00.000Z",
      detachedAt: "2026-04-17T23:59:59.000Z",
      portabilityNotes: ["Provider and family changes need explicit review."],
      continuityFidelityNotes: [],
      compensationHints: [],
    });
    const current = buildEngineAttachment({
      attachmentId: "engine_attach_codex_curr",
      provider: "openai",
      modelFamily: "gpt-5",
      modelId: "gpt-5.4",
      runtimeHost: "codex",
      hostVersion: "0.3.0",
      promptTransport: "additionalContext",
      attachedAt: "2026-04-18T00:00:00.000Z",
      portabilityNotes: ["Provider and family changes need explicit review."],
      continuityFidelityNotes: [],
      compensationHints: [],
    });

    const diagnostics = deriveEnginePortabilityDiagnostics(current, [previous]);

    expect(diagnostics.stability).toBe("high_risk");
    expect(diagnostics.reasons).toContain("Provider changed between the previous and current engine attachments.");
    expect(diagnostics.reasons).toContain("Model family changed between the previous and current engine attachments.");
    expect(diagnostics.compensationHints.some((hint) => hint.includes("fresh portability review"))).toBe(true);
  });

  it("rejects ambiguous and calendar-impossible attachment timestamps", () => {
    const base = buildEngineAttachment({
      attachmentId: "engine_attach_timestamp_test",
      runtimeHost: "codex",
      attachedAt: "2026-08-24T11:30:00Z",
    });
    expect(validateEngineAttachment({ ...base, attachedAt: "0" })).toContain(
      "engineAttachment.attachedAt must be an ISO date string"
    );
    expect(
      validateEngineAttachment({
	...base,
	detachedAt: "2026-02-30T00:00:00Z",
      })
    ).toContain("engineAttachment.detachedAt must be an ISO date string or null");
  });
});
