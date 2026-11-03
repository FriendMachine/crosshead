import { isRfc3339DateTime, type IsoDateString, type Npub } from "./base";
import {
  ENGINE_ATTACHMENT_SCHEMA_VERSION,
  type EngineAttachment,
  validateEngineAttachment,
} from "./engine-attachments";

export const PERSISTENT_AGENT_ENTITY_VERSION = "persistent_agent_entity_v1";
export const LINEAGE_LINK_VERSION = "lineage_link_v1";
export const INHERITANCE_BOUNDARY_VERSION = "inheritance_boundary_v1";

export type PersistentAgentStatus = "active" | "inactive" | "forked" | "archived" | "suspended";
export type RuntimeAttachmentStatus = "active" | "paused" | "ended";
export type TrustCarryoverMode = "none" | "bounded" | "operator_review";
export type InheritanceMode = "inherit" | "reset";
export type DerivedInheritanceMode = "derive" | "reset";
export type ReferenceInheritanceMode = "reference_only" | "reset";

export type PersistentAgentReference = {
  agentId: string;
  npub: Npub;
  lineageRoot: string;
};

export type RuntimeAttachment = {
  attachmentId: string;
  runtimeHost: string;
  workspaceId: string | null;
  sessionId: string | null;
  attachedAt: IsoDateString;
  status: RuntimeAttachmentStatus;
  passportRef: string | null;
  continuityStateRef: string | null;
  notes: string[];
};

export type PersistentAgentEntity = {
  schemaVersion: typeof PERSISTENT_AGENT_ENTITY_VERSION;
  agentRef: PersistentAgentReference;
  createdAt: IsoDateString;
  status: PersistentAgentStatus;
  policyRef: string | null;
  projectModelRefs: string[];
  selfModelRef: string | null;
  passportRef: string | null;
  currentRuntimeAttachments: RuntimeAttachment[];
  currentEngineAttachment: EngineAttachment | null;
  engineAttachmentHistory: EngineAttachment[];
  notes: string[];
};

export type LineageLink = {
  schemaVersion: typeof LINEAGE_LINK_VERSION;
  linkId: string;
  parentAgentId: string;
  childAgentId: string;
  lineageRoot: string;
  forkReason: string;
  inheritedRefs: string[];
  excludedRefs: string[];
  trustCarryoverMode: TrustCarryoverMode;
  inheritanceBoundaryRef: string | null;
  signedAt: IsoDateString;
  signedByNpub: Npub;
  payloadHash: string;
  signature: string;
  notes: string[];
};

export type PersistentAgentInheritanceBoundary = {
  schemaVersion: typeof INHERITANCE_BOUNDARY_VERSION;
  boundaryId: string;
  parentAgentId: string;
  childAgentId: string;
  lineageRoot: string;
  policyMode: InheritanceMode;
  policyRef: string | null;
  selfModelMode: InheritanceMode;
  selfModelRef: string | null;
  projectModelMode: InheritanceMode;
  projectModelRefs: string[];
  hotMemoryMode: "reset";
  warmMemoryMode: ReferenceInheritanceMode;
  coldMemoryMode: ReferenceInheritanceMode;
  inheritedRefs: string[];
  excludedRefs: string[];
  passportMode: DerivedInheritanceMode;
  derivedPassportRef: string | null;
  runtimeAttachmentMode: "reset";
  engineAttachmentMode: "reset";
  trustCarryoverMode: TrustCarryoverMode;
  signedAt: IsoDateString;
  signedByNpub: Npub;
  payloadHash: string;
  signature: string;
  notes: string[];
};

export type ContinuityIdentityReference = {
  agentId: string;
  npub: Npub;
  lineageRoot: string;
};

const AGENT_ID_PATTERN = /^agent_[a-z0-9][a-z0-9_-]{2,127}$/;
const LINEAGE_ID_PATTERN = /^lineage_[a-z0-9][a-z0-9_-]{2,127}$/;
const INHERITANCE_BOUNDARY_ID_PATTERN = /^inheritance_boundary_[a-z0-9][a-z0-9_-]{2,127}$/;
const ATTACHMENT_ID_PATTERN = /^attach_[a-z0-9][a-z0-9_-]{2,127}$/;
const NPUB_PATTERN = /^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const SCHNORR_SIGNATURE_PATTERN = /^[0-9a-f]{128}$/i;

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

export const validatePersistentAgentReference = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["agentRef must be an object"];
  }
  if (!isNonEmptyString(value.agentId) || !AGENT_ID_PATTERN.test(value.agentId)) {
    errors.push("agentRef.agentId must match /^agent_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  if (!isNonEmptyString(value.npub) || !NPUB_PATTERN.test(value.npub)) {
    errors.push("agentRef.npub must be an npub identifier");
  }
  if (!isNonEmptyString(value.lineageRoot) || !AGENT_ID_PATTERN.test(value.lineageRoot)) {
    errors.push("agentRef.lineageRoot must match the agent id format");
  }
  return errors;
};

export const validateRuntimeAttachment = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["runtimeAttachment must be an object"];
  }
  if (!isNonEmptyString(value.attachmentId) || !ATTACHMENT_ID_PATTERN.test(value.attachmentId)) {
    errors.push("runtimeAttachment.attachmentId must match /^attach_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  if (!isNonEmptyString(value.runtimeHost)) {
    errors.push("runtimeAttachment.runtimeHost is required");
  }
  if (value.workspaceId !== null && value.workspaceId !== undefined && !isNonEmptyString(value.workspaceId)) {
    errors.push("runtimeAttachment.workspaceId must be a non-empty string or null");
  }
  if (value.sessionId !== null && value.sessionId !== undefined && !isNonEmptyString(value.sessionId)) {
    errors.push("runtimeAttachment.sessionId must be a non-empty string or null");
  }
  if (!isIsoDateString(value.attachedAt)) {
    errors.push("runtimeAttachment.attachedAt must be an ISO date string");
  }
  if (!["active", "paused", "ended"].includes(String(value.status))) {
    errors.push("runtimeAttachment.status must be active, paused, or ended");
  }
  if (value.passportRef !== null && value.passportRef !== undefined && !isNonEmptyString(value.passportRef)) {
    errors.push("runtimeAttachment.passportRef must be a non-empty string or null");
  }
  if (
    value.continuityStateRef !== null &&
    value.continuityStateRef !== undefined &&
    !isNonEmptyString(value.continuityStateRef)
  ) {
    errors.push("runtimeAttachment.continuityStateRef must be a non-empty string or null");
  }
  validateStringArray(value.notes, "runtimeAttachment.notes", errors);
  return errors;
};

export const validatePersistentAgentEntity = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["persistentAgentEntity must be an object"];
  }
  if (value.schemaVersion !== PERSISTENT_AGENT_ENTITY_VERSION) {
    errors.push(`schemaVersion must be ${PERSISTENT_AGENT_ENTITY_VERSION}`);
  }
  errors.push(...validatePersistentAgentReference(value.agentRef));
  if (!isIsoDateString(value.createdAt)) {
    errors.push("createdAt must be an ISO date string");
  }
  if (!["active", "inactive", "forked", "archived", "suspended"].includes(String(value.status))) {
    errors.push("status must be active, inactive, forked, archived, or suspended");
  }
  if (value.policyRef !== null && value.policyRef !== undefined && !isNonEmptyString(value.policyRef)) {
    errors.push("policyRef must be a non-empty string or null");
  }
  validateStringArray(value.projectModelRefs, "projectModelRefs", errors);
  if (value.selfModelRef !== null && value.selfModelRef !== undefined && !isNonEmptyString(value.selfModelRef)) {
    errors.push("selfModelRef must be a non-empty string or null");
  }
  if (value.passportRef !== null && value.passportRef !== undefined && !isNonEmptyString(value.passportRef)) {
    errors.push("passportRef must be a non-empty string or null");
  }
  if (!Array.isArray(value.currentRuntimeAttachments)) {
    errors.push("currentRuntimeAttachments must be an array");
  } else {
    const attachmentIds = new Set<string>();
    for (const attachment of value.currentRuntimeAttachments) {
      errors.push(...validateRuntimeAttachment(attachment));
      if (isRecord(attachment) && isNonEmptyString(attachment.attachmentId)) {
	if (attachmentIds.has(attachment.attachmentId)) {
	  errors.push("currentRuntimeAttachments attachmentId values must be unique");
	}
	attachmentIds.add(attachment.attachmentId);
      }
    }
  }
  if (value.currentEngineAttachment !== null && value.currentEngineAttachment !== undefined) {
    errors.push(...validateEngineAttachment(value.currentEngineAttachment));
  }
  if (!Array.isArray(value.engineAttachmentHistory)) {
    errors.push("engineAttachmentHistory must be an array");
  } else {
    for (const attachment of value.engineAttachmentHistory) {
      errors.push(...validateEngineAttachment(attachment));
    }
  }
  validateStringArray(value.notes, "notes", errors);
  return errors;
};

export const validateLineageLink = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["lineageLink must be an object"];
  }
  if (value.schemaVersion !== LINEAGE_LINK_VERSION) {
    errors.push(`schemaVersion must be ${LINEAGE_LINK_VERSION}`);
  }
  if (!isNonEmptyString(value.linkId) || !LINEAGE_ID_PATTERN.test(value.linkId)) {
    errors.push("linkId must match /^lineage_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  if (!isNonEmptyString(value.parentAgentId) || !AGENT_ID_PATTERN.test(value.parentAgentId)) {
    errors.push("parentAgentId must match the agent id format");
  }
  if (!isNonEmptyString(value.childAgentId) || !AGENT_ID_PATTERN.test(value.childAgentId)) {
    errors.push("childAgentId must match the agent id format");
  }
  if (value.parentAgentId === value.childAgentId) {
    errors.push("parentAgentId and childAgentId must differ");
  }
  if (!isNonEmptyString(value.lineageRoot) || !AGENT_ID_PATTERN.test(value.lineageRoot)) {
    errors.push("lineageRoot must match the agent id format");
  }
  if (!isNonEmptyString(value.forkReason)) {
    errors.push("forkReason is required");
  }
  validateStringArray(value.inheritedRefs, "inheritedRefs", errors);
  validateStringArray(value.excludedRefs, "excludedRefs", errors);
  if (!["none", "bounded", "operator_review"].includes(String(value.trustCarryoverMode))) {
    errors.push("trustCarryoverMode must be none, bounded, or operator_review");
  }
  if (
    value.inheritanceBoundaryRef !== null &&
    value.inheritanceBoundaryRef !== undefined &&
    !isNonEmptyString(value.inheritanceBoundaryRef)
  ) {
    errors.push("inheritanceBoundaryRef must be a non-empty string or null");
  }
  if (!isIsoDateString(value.signedAt)) {
    errors.push("signedAt must be an ISO date string");
  }
  if (!isNonEmptyString(value.signedByNpub) || !NPUB_PATTERN.test(value.signedByNpub)) {
    errors.push("signedByNpub must be an npub identifier");
  }
  if (!isNonEmptyString(value.payloadHash) || !SHA256_PATTERN.test(value.payloadHash)) {
    errors.push("payloadHash must be a sha256:<hex> digest");
  }
  if (!isNonEmptyString(value.signature) || !SCHNORR_SIGNATURE_PATTERN.test(value.signature)) {
    errors.push("signature must be a 64-byte hex Schnorr signature");
  }
  validateStringArray(value.notes, "notes", errors);
  return errors;
};

export const validatePersistentAgentInheritanceBoundary = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["inheritanceBoundary must be an object"];
  }
  if (value.schemaVersion !== INHERITANCE_BOUNDARY_VERSION) {
    errors.push(`schemaVersion must be ${INHERITANCE_BOUNDARY_VERSION}`);
  }
  if (!isNonEmptyString(value.boundaryId) || !INHERITANCE_BOUNDARY_ID_PATTERN.test(value.boundaryId)) {
    errors.push("boundaryId must match /^inheritance_boundary_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  if (!isNonEmptyString(value.parentAgentId) || !AGENT_ID_PATTERN.test(value.parentAgentId)) {
    errors.push("parentAgentId must match the agent id format");
  }
  if (!isNonEmptyString(value.childAgentId) || !AGENT_ID_PATTERN.test(value.childAgentId)) {
    errors.push("childAgentId must match the agent id format");
  }
  if (value.parentAgentId === value.childAgentId) {
    errors.push("parentAgentId and childAgentId must differ");
  }
  if (!isNonEmptyString(value.lineageRoot) || !AGENT_ID_PATTERN.test(value.lineageRoot)) {
    errors.push("lineageRoot must match the agent id format");
  }
  if (!["inherit", "reset"].includes(String(value.policyMode))) {
    errors.push("policyMode must be inherit or reset");
  }
  if (value.policyRef !== null && value.policyRef !== undefined && !isNonEmptyString(value.policyRef)) {
    errors.push("policyRef must be a non-empty string or null");
  }
  if (!["inherit", "reset"].includes(String(value.selfModelMode))) {
    errors.push("selfModelMode must be inherit or reset");
  }
  if (value.selfModelRef !== null && value.selfModelRef !== undefined && !isNonEmptyString(value.selfModelRef)) {
    errors.push("selfModelRef must be a non-empty string or null");
  }
  if (!["inherit", "reset"].includes(String(value.projectModelMode))) {
    errors.push("projectModelMode must be inherit or reset");
  }
  validateStringArray(value.projectModelRefs, "projectModelRefs", errors);
  if (value.hotMemoryMode !== "reset") {
    errors.push("hotMemoryMode must be reset");
  }
  if (!["reference_only", "reset"].includes(String(value.warmMemoryMode))) {
    errors.push("warmMemoryMode must be reference_only or reset");
  }
  if (!["reference_only", "reset"].includes(String(value.coldMemoryMode))) {
    errors.push("coldMemoryMode must be reference_only or reset");
  }
  const inheritedRefs = validateStringArray(value.inheritedRefs, "inheritedRefs", errors);
  const excludedRefs = validateStringArray(value.excludedRefs, "excludedRefs", errors);
  if (inheritedRefs.some((ref) => excludedRefs.includes(ref))) {
    errors.push("inheritedRefs and excludedRefs must not overlap");
  }
  if (!["derive", "reset"].includes(String(value.passportMode))) {
    errors.push("passportMode must be derive or reset");
  }
  if (value.derivedPassportRef !== null && value.derivedPassportRef !== undefined && !isNonEmptyString(value.derivedPassportRef)) {
    errors.push("derivedPassportRef must be a non-empty string or null");
  }
  if (value.passportMode === "derive" && !isNonEmptyString(value.derivedPassportRef)) {
    errors.push("derivedPassportRef is required when passportMode is derive");
  }
  if (value.runtimeAttachmentMode !== "reset") {
    errors.push("runtimeAttachmentMode must be reset");
  }
  if (value.engineAttachmentMode !== "reset") {
    errors.push("engineAttachmentMode must be reset");
  }
  if (!["none", "bounded", "operator_review"].includes(String(value.trustCarryoverMode))) {
    errors.push("trustCarryoverMode must be none, bounded, or operator_review");
  }
  if (!isIsoDateString(value.signedAt)) {
    errors.push("signedAt must be an ISO date string");
  }
  if (!isNonEmptyString(value.signedByNpub) || !NPUB_PATTERN.test(value.signedByNpub)) {
    errors.push("signedByNpub must be an npub identifier");
  }
  if (!isNonEmptyString(value.payloadHash) || !SHA256_PATTERN.test(value.payloadHash)) {
    errors.push("payloadHash must be a sha256:<hex> digest");
  }
  if (!isNonEmptyString(value.signature) || !SCHNORR_SIGNATURE_PATTERN.test(value.signature)) {
    errors.push("signature must be a 64-byte hex Schnorr signature");
  }
  validateStringArray(value.notes, "notes", errors);
  return errors;
};

export const toContinuityIdentityReference = (
  agentRef: PersistentAgentReference
): ContinuityIdentityReference => ({
  agentId: agentRef.agentId,
  npub: agentRef.npub,
  lineageRoot: agentRef.lineageRoot,
});

export const persistentAgentEntityExample: PersistentAgentEntity = {
  schemaVersion: PERSISTENT_AGENT_ENTITY_VERSION,
  agentRef: {
    agentId: "agent_onlybots_default",
    npub: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqw0x2r",
    lineageRoot: "agent_onlybots_default",
  },
  createdAt: "2026-04-15T00:00:00Z",
  status: "active",
  policyRef: "continuity_policy_v1:sha256:policy_default",
  projectModelRefs: ["project_model_onlybots_main"],
  selfModelRef: "self_model_onlybots_primary",
  passportRef: "agent_passport_v1:sha256:passport_default",
  currentRuntimeAttachments: [
    {
      attachmentId: "attach_codex_primary",
      runtimeHost: "codex",
      workspaceId: "repo:onlybots-erd",
      sessionId: "codex-session-42",
      attachedAt: "2026-04-15T00:00:00Z",
      status: "active",
      passportRef: "agent_passport_v1:sha256:passport_default",
      continuityStateRef: "continuity_state:agent_onlybots_default",
      notes: ["Managed Codex runtime attachment for active repo work."],
    },
  ],
  currentEngineAttachment: {
    schemaVersion: ENGINE_ATTACHMENT_SCHEMA_VERSION,
    attachmentId: "engine_attach_codex_gpt5_primary",
    provider: "openai",
    modelFamily: "gpt-5",
    modelId: "gpt-5.4",
    runtimeHost: "codex",
    hostVersion: "0.3.0",
    promptTransport: "additionalContext",
    attachedAt: "2026-04-15T00:00:00Z",
    detachedAt: null,
    portabilityNotes: ["Agent identity persists even if the engine attachment changes."],
    continuityFidelityNotes: ["Prompting style and tool ergonomics may drift across engines."],
    compensationHints: ["Inspect portability diagnostics before treating cross-model behavior as equivalent."],
  },
  engineAttachmentHistory: [
    {
      schemaVersion: ENGINE_ATTACHMENT_SCHEMA_VERSION,
      attachmentId: "engine_attach_claude_sonnet_previous",
      provider: "anthropic",
      modelFamily: "claude-sonnet-4",
      modelId: "claude-sonnet-4-20260301",
      runtimeHost: "claude-code",
      hostVersion: "0.3.0",
      promptTransport: "append_system_prompt",
      attachedAt: "2026-04-10T00:00:00Z",
      detachedAt: "2026-04-14T23:59:59Z",
      portabilityNotes: ["Cross-host transport changed from Claude prompt append to Codex additional context."],
      continuityFidelityNotes: ["Approval posture and tool ergonomics drifted across the host change."],
      compensationHints: ["Treat cross-host handoffs as bounded-drift until the current engine is re-benchmarked."],
    },
  ],
  notes: ["Canonical persistent agent entity shared across continuity, passport, and handoff layers."],
};

export const lineageLinkExample: LineageLink = {
  schemaVersion: LINEAGE_LINK_VERSION,
  linkId: "lineage_onlybots_fork_1",
  parentAgentId: "agent_onlybots_default",
  childAgentId: "agent_onlybots_research_fork",
  lineageRoot: "agent_onlybots_default",
  forkReason: "Create a research-focused fork with narrower memory inheritance.",
  inheritedRefs: ["continuity_policy_v1:sha256:policy_default", "self_model_onlybots_primary"],
  excludedRefs: ["project_model_client_private"],
  trustCarryoverMode: "bounded",
  inheritanceBoundaryRef: "inheritance_boundary_onlybots_fork_1",
  signedAt: "2026-04-15T00:05:00Z",
  signedByNpub: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqw0x2r",
  payloadHash: "sha256:4d88360eb29ca7c57536f1c94548f986b8d89eb715c0fa6300d6411b6fe84f8f",
  signature:
    "68f3a7f8d4b910c9c912d3380b56c48135f6138d9d56e4f4cde2c2758d4df1b38dfad237f385642eb49bcb30288b53118e6d2fcbcb46a3564e5663e8e8b31d48",
  notes: ["Carry forward policy and self-model references, but do not clone project-private material."],
};

export const persistentAgentInheritanceBoundaryExample: PersistentAgentInheritanceBoundary = {
  schemaVersion: INHERITANCE_BOUNDARY_VERSION,
  boundaryId: "inheritance_boundary_onlybots_fork_1",
  parentAgentId: "agent_onlybots_default",
  childAgentId: "agent_onlybots_research_fork",
  lineageRoot: "agent_onlybots_default",
  policyMode: "inherit",
  policyRef: "continuity_policy_v1:sha256:policy_default",
  selfModelMode: "inherit",
  selfModelRef: "self_model_onlybots_primary",
  projectModelMode: "inherit",
  projectModelRefs: ["project_model_onlybots_main"],
  hotMemoryMode: "reset",
  warmMemoryMode: "reference_only",
  coldMemoryMode: "reference_only",
  inheritedRefs: [
    "continuity_policy_v1:sha256:policy_default",
    "self_model_onlybots_primary",
    "project_model_onlybots_main",
  ],
  excludedRefs: ["project_model_client_private"],
  passportMode: "derive",
  derivedPassportRef: "agent_passport_v1:local:agent_onlybots_research_fork",
  runtimeAttachmentMode: "reset",
  engineAttachmentMode: "reset",
  trustCarryoverMode: "bounded",
  signedAt: "2026-04-15T00:05:00Z",
  signedByNpub: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqw0x2r",
  payloadHash: "sha256:5aafe306d2801db6a0a5bce36dc92f92a7330a574c3bcf1d53b6497644f2c166",
  signature:
    "4d5c0f3a614e8be97293943d13d4e80ed2a98b13d9d5f378dff64ce1a4f4f597fb257190c9fd3ed31c9373ffadc8370fa8c9f3fd8f42ceac2ff6a3b878d80dd5",
  notes: [
    "Policy, self-model, and selected project-model refs were inherited by reference.",
    "Hot memory, runtime attachments, and engine attachment reset so the child can diverge safely.",
  ],
};
