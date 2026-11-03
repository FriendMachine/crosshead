import { isRfc3339DateTime, type IsoDateString } from "./base";

export const ENGINE_ATTACHMENT_SCHEMA_VERSION = "engine_attachment_v1";
export const ENGINE_PORTABILITY_DIAGNOSTICS_VERSION = "engine_portability_diagnostics_v1";

export const ENGINE_IDENTITY_STABILITY_STATES = [
  "unattached",
  "initial_attachment",
  "mostly_self",
  "bounded_drift",
  "high_risk",
] as const;

export type EngineIdentityStability = (typeof ENGINE_IDENTITY_STABILITY_STATES)[number];

export type EngineAttachment = {
  schemaVersion: typeof ENGINE_ATTACHMENT_SCHEMA_VERSION;
  attachmentId: string;
  provider: string | null;
  modelFamily: string | null;
  modelId: string | null;
  runtimeHost: string;
  hostVersion: string | null;
  promptTransport: string | null;
  attachedAt: IsoDateString;
  detachedAt: IsoDateString | null;
  portabilityNotes: string[];
  continuityFidelityNotes: string[];
  compensationHints: string[];
};

export type EnginePortabilityDiagnostics = {
  schemaVersion: typeof ENGINE_PORTABILITY_DIAGNOSTICS_VERSION;
  currentAttachmentId: string | null;
  previousAttachmentId: string | null;
  historyCount: number;
  stability: EngineIdentityStability;
  summary: string;
  reasons: string[];
  portabilityNotes: string[];
  compensationHints: string[];
};

const ENGINE_ATTACHMENT_ID_PATTERN = /^engine_attach_[a-z0-9][a-z0-9_-]{2,127}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const isIsoDateString = (value: unknown): value is IsoDateString =>
  isRfc3339DateTime(value);

const validateStringArray = (value: unknown, field: string, errors: string[]): string[] => {
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    errors.push(`${field} must be an array of non-empty strings`);
    return [];
  }
  return value as string[];
};

const validateOptionalString = (value: unknown, field: string, errors: string[]): void => {
  if (value !== null && value !== undefined && !isNonEmptyString(value)) {
    errors.push(`${field} must be a non-empty string or null`);
  }
};

export const validateEngineAttachment = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["engineAttachment must be an object"];
  }
  if (value.schemaVersion !== ENGINE_ATTACHMENT_SCHEMA_VERSION) {
    errors.push(`engineAttachment.schemaVersion must be ${ENGINE_ATTACHMENT_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.attachmentId) || !ENGINE_ATTACHMENT_ID_PATTERN.test(value.attachmentId)) {
    errors.push("engineAttachment.attachmentId must match /^engine_attach_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  validateOptionalString(value.provider, "engineAttachment.provider", errors);
  validateOptionalString(value.modelFamily, "engineAttachment.modelFamily", errors);
  validateOptionalString(value.modelId, "engineAttachment.modelId", errors);
  if (!isNonEmptyString(value.runtimeHost)) {
    errors.push("engineAttachment.runtimeHost is required");
  }
  validateOptionalString(value.hostVersion, "engineAttachment.hostVersion", errors);
  validateOptionalString(value.promptTransport, "engineAttachment.promptTransport", errors);
  if (!isIsoDateString(value.attachedAt)) {
    errors.push("engineAttachment.attachedAt must be an ISO date string");
  }
  if (value.detachedAt !== null && value.detachedAt !== undefined && !isIsoDateString(value.detachedAt)) {
    errors.push("engineAttachment.detachedAt must be an ISO date string or null");
  }
  validateStringArray(value.portabilityNotes, "engineAttachment.portabilityNotes", errors);
  validateStringArray(value.continuityFidelityNotes, "engineAttachment.continuityFidelityNotes", errors);
  validateStringArray(value.compensationHints, "engineAttachment.compensationHints", errors);
  return errors;
};

export const validateEnginePortabilityDiagnostics = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["enginePortabilityDiagnostics must be an object"];
  }
  if (value.schemaVersion !== ENGINE_PORTABILITY_DIAGNOSTICS_VERSION) {
    errors.push(`enginePortabilityDiagnostics.schemaVersion must be ${ENGINE_PORTABILITY_DIAGNOSTICS_VERSION}`);
  }
  validateOptionalString(value.currentAttachmentId, "enginePortabilityDiagnostics.currentAttachmentId", errors);
  validateOptionalString(value.previousAttachmentId, "enginePortabilityDiagnostics.previousAttachmentId", errors);
  if (!Number.isInteger(value.historyCount) || Number(value.historyCount) < 0) {
    errors.push("enginePortabilityDiagnostics.historyCount must be a non-negative integer");
  }
  if (!ENGINE_IDENTITY_STABILITY_STATES.includes(value.stability as EngineIdentityStability)) {
    errors.push(
      `enginePortabilityDiagnostics.stability must be one of ${ENGINE_IDENTITY_STABILITY_STATES.join(", ")}`
    );
  }
  if (!isNonEmptyString(value.summary)) {
    errors.push("enginePortabilityDiagnostics.summary is required");
  }
  validateStringArray(value.reasons, "enginePortabilityDiagnostics.reasons", errors);
  validateStringArray(value.portabilityNotes, "enginePortabilityDiagnostics.portabilityNotes", errors);
  validateStringArray(value.compensationHints, "enginePortabilityDiagnostics.compensationHints", errors);
  return errors;
};

const uniqueStrings = (values: Array<string | null | undefined>): string[] =>
  [...new Set(values.map((value) => (typeof value === "string" ? value.trim() : "")).filter((value) => value.length > 0))];

export const buildEngineAttachment = (input: {
  attachmentId: string;
  provider?: string | null;
  modelFamily?: string | null;
  modelId?: string | null;
  runtimeHost: string;
  hostVersion?: string | null;
  promptTransport?: string | null;
  attachedAt: IsoDateString;
  detachedAt?: IsoDateString | null;
  portabilityNotes?: string[];
  continuityFidelityNotes?: string[];
  compensationHints?: string[];
}): EngineAttachment => {
  const attachment: EngineAttachment = {
    schemaVersion: ENGINE_ATTACHMENT_SCHEMA_VERSION,
    attachmentId: input.attachmentId,
    provider: input.provider ?? null,
    modelFamily: input.modelFamily ?? null,
    modelId: input.modelId ?? null,
    runtimeHost: input.runtimeHost,
    hostVersion: input.hostVersion ?? null,
    promptTransport: input.promptTransport ?? null,
    attachedAt: input.attachedAt,
    detachedAt: input.detachedAt ?? null,
    portabilityNotes: uniqueStrings(input.portabilityNotes ?? []),
    continuityFidelityNotes: uniqueStrings(input.continuityFidelityNotes ?? []),
    compensationHints: uniqueStrings(input.compensationHints ?? []),
  };
  const validationErrors = validateEngineAttachment(attachment);
  if (validationErrors.length > 0) {
    throw new Error(`engine attachment is invalid:\n${validationErrors.join("\n")}`);
  }
  return attachment;
};

export const deriveEnginePortabilityDiagnostics = (
  current: EngineAttachment | null,
  history: EngineAttachment[]
): EnginePortabilityDiagnostics => {
  const sortedHistory = [...history].sort((left, right) => left.attachedAt.localeCompare(right.attachedAt));
  const previous = sortedHistory.length > 0 ? sortedHistory[sortedHistory.length - 1]! : null;

  if (!current) {
    return {
      schemaVersion: ENGINE_PORTABILITY_DIAGNOSTICS_VERSION,
      currentAttachmentId: null,
      previousAttachmentId: previous?.attachmentId ?? null,
      historyCount: sortedHistory.length,
      stability: "unattached",
      summary: "No current engine attachment is recorded for this agent.",
      reasons: ["There is no active model or runtime attachment to compare."],
      portabilityNotes: [],
      compensationHints: [],
    };
  }

  const reasons: string[] = [];
  const compensationHints = uniqueStrings(current.compensationHints);
  let stability: EngineIdentityStability = "mostly_self";

  if (!previous) {
    stability = "initial_attachment";
    reasons.push("No prior engine attachment history is available yet.");
  } else {
    if (previous.provider !== current.provider) {
      stability = "high_risk";
      reasons.push("Provider changed between the previous and current engine attachments.");
      compensationHints.push(
        "Re-check self-model assumptions and recent continuity outcomes before assuming equivalent behavior."
      );
    }
    if (previous.modelFamily !== current.modelFamily) {
      stability = "high_risk";
      reasons.push("Model family changed between the previous and current engine attachments.");
      compensationHints.push("Treat the next handoff as a fresh portability review instead of a like-for-like transfer.");
    } else if (previous.modelId !== current.modelId && stability !== "high_risk") {
      stability = "bounded_drift";
      reasons.push("Model id changed within the same family.");
    }
    if (previous.runtimeHost !== current.runtimeHost && stability !== "high_risk") {
      stability = "bounded_drift";
      reasons.push("Runtime host changed, so tool posture and prompt transport may differ.");
      compensationHints.push("Validate host-specific tool approvals and startup context before unattended execution.");
    }
    if (previous.promptTransport !== current.promptTransport && stability !== "high_risk") {
      stability = "bounded_drift";
      reasons.push("Prompt transport changed across attachments.");
      compensationHints.push("Inspect downgraded prompt-surface fields before assuming fidelity is unchanged.");
    }
  }

  if (sortedHistory.length >= 3 && stability !== "high_risk") {
    stability = "bounded_drift";
    reasons.push("Frequent recent engine changes reduce continuity confidence even when the family stays similar.");
  }

  if (reasons.length === 0) {
    reasons.push("Provider, model family, runtime host, and prompt transport match the previous attachment.");
  }

  const summary =
    stability === "initial_attachment"
      ? "This is the first recorded engine attachment for the agent, so portability risk is not yet benchmarked against prior history."
      : stability === "mostly_self"
        ? "The current engine attachment remains close to the previous one, so the agent should remain mostly itself with normal prompt-level drift."
        : stability === "bounded_drift"
          ? "The current engine attachment introduces bounded portability drift that should be reviewed before unattended work."
          : stability === "high_risk"
            ? "The current engine attachment materially changes provider or model-family assumptions, so identity may remain stable while execution fidelity is high risk."
            : "No current engine attachment is recorded.";

  return {
    schemaVersion: ENGINE_PORTABILITY_DIAGNOSTICS_VERSION,
    currentAttachmentId: current.attachmentId,
    previousAttachmentId: previous?.attachmentId ?? null,
    historyCount: sortedHistory.length,
    stability,
    summary,
    reasons,
    portabilityNotes: uniqueStrings(current.portabilityNotes),
    compensationHints: uniqueStrings(compensationHints),
  };
};
