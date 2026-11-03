import { IsoDateString, Npub } from "./base";
import { type PersistentAgentReference, validatePersistentAgentReference } from "./persistent-agents";

export const AGENT_PASSPORT_SCHEMA_VERSION = "agent_passport_v1";

export const PASSPORT_TRUST_ZONE_IDS = ["personal", "shared", "public", "client"] as const;
export const PASSPORT_RUNTIME_HOSTS = ["codex", "claude-code", "pi"] as const;
export const PASSPORT_OUTPUT_HONESTY_LEVELS = ["runtime_enforced", "best_effort", "advisory"] as const;
export const PASSPORT_OUTPUT_SOURCES = ["onlybots_runtime", "managed_host_config", "prompt_file", "operator_process"] as const;
export const PASSPORT_MEMORY_TIERS = ["hot", "warm", "cold", "self_model", "project_model", "user_model"] as const;
export const PASSPORT_WORKSPACE_POLICIES = [
  "operator_private",
  "team_shared",
  "public_visible",
  "client_restricted",
] as const;
export const PASSPORT_RESPONSE_LENGTHS = ["brief", "balanced", "detailed"] as const;
export const PASSPORT_COMPILED_PROVENANCE_FIELDS = [
  "passport_version",
  "generated_at",
  "compiler_version",
  "source_passport_hash",
  "trust_zone_id",
  "target_host",
] as const;

export type PassportTrustZoneId = (typeof PASSPORT_TRUST_ZONE_IDS)[number];
export type PassportRuntimeHost = (typeof PASSPORT_RUNTIME_HOSTS)[number];
export type PassportOutputHonesty = (typeof PASSPORT_OUTPUT_HONESTY_LEVELS)[number];
export type PassportOutputSource = (typeof PASSPORT_OUTPUT_SOURCES)[number];
export type PassportMemoryTier = (typeof PASSPORT_MEMORY_TIERS)[number];
export type PassportWorkspacePolicy = (typeof PASSPORT_WORKSPACE_POLICIES)[number];
export type PassportResponseLength = (typeof PASSPORT_RESPONSE_LENGTHS)[number];
export type PassportCompiledProvenanceField = (typeof PASSPORT_COMPILED_PROVENANCE_FIELDS)[number];

export type PassportMemoryScope = {
  allowedWorkspaces: string[];
  allowedTrustZones: PassportTrustZoneId[];
  portableMemoryTiers: PassportMemoryTier[];
  allowCrossWorkspaceContext: boolean;
};

export type PassportTrustZone = {
  trustZoneId: PassportTrustZoneId;
  displayName: string;
  summary: string;
  workspacePolicy: PassportWorkspacePolicy;
  memoryScope: PassportMemoryScope;
  auditExpectations: string[];
  outputAdjustments: string[];
};

export type PassportCompiledArtifact = {
  artifactId: string;
  surface: string;
  pathHint: string;
  honesty: PassportOutputHonesty;
  sourceOfTruth: PassportOutputSource;
  notes: string[];
};

export type PassportTargetTrustZonePolicy = {
  trustZoneId: PassportTrustZoneId;
  compiledArtifacts: PassportCompiledArtifact[];
  notes: string[];
};

export type PassportCompilationTarget = {
  targetHost: PassportRuntimeHost;
  defaultTrustZone: PassportTrustZoneId;
  trustZonePolicies: PassportTargetTrustZonePolicy[];
  hostLimitations: string[];
};

export type AgentPassport = {
  passportVersion: typeof AGENT_PASSPORT_SCHEMA_VERSION;
  passportId: string;
  agentRef: PersistentAgentReference;
  identity: {
    displayName: string;
  };
  persona: {
    summary: string;
    style: string[];
  };
  operatorPreferences: {
    collaborationStyle: string[];
    reviewExpectations: string[];
    preferredResponseLength: PassportResponseLength;
  };
  continuityPolicyRef: string | null;
  memoryScope: PassportMemoryScope;
  capabilities: {
    declared: string[];
    strengths: string[];
    limitations: string[];
  };
  handoffPreferences: {
    preferredTargets: PassportRuntimeHost[];
    requiresCapabilities: string[];
    escalationHints: string[];
  };
  enginePortability: {
    identityIsNotEngineBound: boolean;
    currentEngineAttachmentRef: string | null;
    portabilityNotes: string[];
  };
  trustZones: PassportTrustZone[];
  enforcement: {
    sourceOfTruth: "onlybots_runtime";
    compilationTargets: PassportCompilationTarget[];
    runtimeAuthorityNotes: string[];
  };
  provenance: {
    createdAt: IsoDateString;
    updatedAt: IsoDateString;
    compilerVersion: string | null;
    sourcePassportHash: string | null;
    requiredCompiledFields: PassportCompiledProvenanceField[];
  };
  signature: {
    scheme: "nostr_schnorr";
    signedBy: Npub;
    signedAt: IsoDateString | null;
  };
  notes: string[];
};

export type AgentPassportDraftOptions = {
  agentRef: PersistentAgentReference;
  displayName?: string;
  continuityPolicyRef?: string | null;
  currentEngineAttachmentRef?: string | null;
  compilerVersion?: string | null;
  allowedWorkspaces?: string[];
  createdAt?: IsoDateString;
};

const PASSPORT_ID_PATTERN = /^passport_[a-z0-9][a-z0-9_-]{2,127}$/;
const ARTIFACT_ID_PATTERN = /^artifact_[a-z0-9][a-z0-9_-]{2,127}$/;
const NPUB_PATTERN = /^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/i;

const TRUST_ZONE_SET = new Set<PassportTrustZoneId>(PASSPORT_TRUST_ZONE_IDS);
const RUNTIME_HOST_SET = new Set<PassportRuntimeHost>(PASSPORT_RUNTIME_HOSTS);
const HONESTY_SET = new Set<PassportOutputHonesty>(PASSPORT_OUTPUT_HONESTY_LEVELS);
const OUTPUT_SOURCE_SET = new Set<PassportOutputSource>(PASSPORT_OUTPUT_SOURCES);
const MEMORY_TIER_SET = new Set<PassportMemoryTier>(PASSPORT_MEMORY_TIERS);
const WORKSPACE_POLICY_SET = new Set<PassportWorkspacePolicy>(PASSPORT_WORKSPACE_POLICIES);
const RESPONSE_LENGTH_SET = new Set<PassportResponseLength>(PASSPORT_RESPONSE_LENGTHS);
const PROVENANCE_FIELD_SET = new Set<PassportCompiledProvenanceField>(PASSPORT_COMPILED_PROVENANCE_FIELDS);
const REQUIRED_PROVENANCE_FIELDS = new Set<PassportCompiledProvenanceField>([
  "passport_version",
  "generated_at",
  "compiler_version",
  "source_passport_hash",
  "trust_zone_id",
  "target_host",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const isIsoDateString = (value: unknown): value is IsoDateString =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

const validateStringArray = (value: unknown, fieldName: string, errors: string[]): string[] => {
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    errors.push(`${fieldName} must be an array of non-empty strings`);
    return [];
  }
  return value as string[];
};

const validateEnumArray = <T extends string>(
  value: unknown,
  fieldName: string,
  accepted: Set<T>,
  errors: string[]
): T[] => {
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry) || !accepted.has(entry as T))) {
    errors.push(`${fieldName} must be an array containing only: ${Array.from(accepted).join(", ")}`);
    return [];
  }
  return value as T[];
};

export const validatePassportMemoryScope = (value: unknown, fieldName = "memoryScope"): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${fieldName} must be an object`];
  }
  validateStringArray(value.allowedWorkspaces, `${fieldName}.allowedWorkspaces`, errors);
  validateEnumArray(value.allowedTrustZones, `${fieldName}.allowedTrustZones`, TRUST_ZONE_SET, errors);
  validateEnumArray(value.portableMemoryTiers, `${fieldName}.portableMemoryTiers`, MEMORY_TIER_SET, errors);
  if (typeof value.allowCrossWorkspaceContext !== "boolean") {
    errors.push(`${fieldName}.allowCrossWorkspaceContext must be a boolean`);
  }
  return errors;
};

export const validatePassportTrustZone = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["trustZone must be an object"];
  }
  if (!isNonEmptyString(value.trustZoneId) || !TRUST_ZONE_SET.has(value.trustZoneId as PassportTrustZoneId)) {
    errors.push(`trustZone.trustZoneId must be one of: ${PASSPORT_TRUST_ZONE_IDS.join(", ")}`);
  }
  if (!isNonEmptyString(value.displayName)) {
    errors.push("trustZone.displayName is required");
  }
  if (!isNonEmptyString(value.summary)) {
    errors.push("trustZone.summary is required");
  }
  if (!isNonEmptyString(value.workspacePolicy) || !WORKSPACE_POLICY_SET.has(value.workspacePolicy as PassportWorkspacePolicy)) {
    errors.push(`trustZone.workspacePolicy must be one of: ${PASSPORT_WORKSPACE_POLICIES.join(", ")}`);
  }
  errors.push(...validatePassportMemoryScope(value.memoryScope, "trustZone.memoryScope"));
  validateStringArray(value.auditExpectations, "trustZone.auditExpectations", errors);
  validateStringArray(value.outputAdjustments, "trustZone.outputAdjustments", errors);
  return errors;
};

export const validatePassportCompiledArtifact = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["compiledArtifact must be an object"];
  }
  if (!isNonEmptyString(value.artifactId) || !ARTIFACT_ID_PATTERN.test(value.artifactId)) {
    errors.push("compiledArtifact.artifactId must match /^artifact_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  if (!isNonEmptyString(value.surface)) {
    errors.push("compiledArtifact.surface is required");
  }
  if (!isNonEmptyString(value.pathHint)) {
    errors.push("compiledArtifact.pathHint is required");
  }
  if (!isNonEmptyString(value.honesty) || !HONESTY_SET.has(value.honesty as PassportOutputHonesty)) {
    errors.push(`compiledArtifact.honesty must be one of: ${PASSPORT_OUTPUT_HONESTY_LEVELS.join(", ")}`);
  }
  if (!isNonEmptyString(value.sourceOfTruth) || !OUTPUT_SOURCE_SET.has(value.sourceOfTruth as PassportOutputSource)) {
    errors.push(`compiledArtifact.sourceOfTruth must be one of: ${PASSPORT_OUTPUT_SOURCES.join(", ")}`);
  }
  if (value.honesty === "runtime_enforced" && value.sourceOfTruth !== "onlybots_runtime") {
    errors.push("compiledArtifact.runtime_enforced artifacts must declare onlybots_runtime as the source of truth");
  }
  validateStringArray(value.notes, "compiledArtifact.notes", errors);
  return errors;
};

export const validatePassportTargetTrustZonePolicy = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["targetTrustZonePolicy must be an object"];
  }
  if (!isNonEmptyString(value.trustZoneId) || !TRUST_ZONE_SET.has(value.trustZoneId as PassportTrustZoneId)) {
    errors.push(`targetTrustZonePolicy.trustZoneId must be one of: ${PASSPORT_TRUST_ZONE_IDS.join(", ")}`);
  }
  if (!Array.isArray(value.compiledArtifacts) || value.compiledArtifacts.length === 0) {
    errors.push("targetTrustZonePolicy.compiledArtifacts must be a non-empty array");
  } else {
    for (const artifact of value.compiledArtifacts) {
      errors.push(...validatePassportCompiledArtifact(artifact));
    }
  }
  validateStringArray(value.notes, "targetTrustZonePolicy.notes", errors);
  return errors;
};

export const validatePassportCompilationTarget = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["compilationTarget must be an object"];
  }
  if (!isNonEmptyString(value.targetHost) || !RUNTIME_HOST_SET.has(value.targetHost as PassportRuntimeHost)) {
    errors.push(`compilationTarget.targetHost must be one of: ${PASSPORT_RUNTIME_HOSTS.join(", ")}`);
  }
  if (!isNonEmptyString(value.defaultTrustZone) || !TRUST_ZONE_SET.has(value.defaultTrustZone as PassportTrustZoneId)) {
    errors.push(`compilationTarget.defaultTrustZone must be one of: ${PASSPORT_TRUST_ZONE_IDS.join(", ")}`);
  }
  if (!Array.isArray(value.trustZonePolicies) || value.trustZonePolicies.length === 0) {
    errors.push("compilationTarget.trustZonePolicies must be a non-empty array");
  } else {
    const seen = new Set<string>();
    for (const policy of value.trustZonePolicies) {
      errors.push(...validatePassportTargetTrustZonePolicy(policy));
      if (isRecord(policy) && isNonEmptyString(policy.trustZoneId)) {
        if (seen.has(policy.trustZoneId)) {
          errors.push(`compilationTarget.trustZonePolicies contains duplicate trustZoneId ${policy.trustZoneId}`);
        }
        seen.add(policy.trustZoneId);
      }
    }
    if (isNonEmptyString(value.defaultTrustZone) && !seen.has(value.defaultTrustZone)) {
      errors.push("compilationTarget.defaultTrustZone must appear in trustZonePolicies");
    }
  }
  validateStringArray(value.hostLimitations, "compilationTarget.hostLimitations", errors);
  return errors;
};

export const validateAgentPassport = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["agentPassport must be an object"];
  }
  if (value.passportVersion !== AGENT_PASSPORT_SCHEMA_VERSION) {
    errors.push(`passportVersion must be ${AGENT_PASSPORT_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.passportId) || !PASSPORT_ID_PATTERN.test(value.passportId)) {
    errors.push("passportId must match /^passport_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  errors.push(...validatePersistentAgentReference(value.agentRef));

  if (!isRecord(value.identity) || !isNonEmptyString(value.identity.displayName)) {
    errors.push("identity.displayName is required");
  }
  if (!isRecord(value.persona)) {
    errors.push("persona must be an object");
  } else {
    if (!isNonEmptyString(value.persona.summary)) {
      errors.push("persona.summary is required");
    }
    validateStringArray(value.persona.style, "persona.style", errors);
  }
  if (!isRecord(value.operatorPreferences)) {
    errors.push("operatorPreferences must be an object");
  } else {
    validateStringArray(value.operatorPreferences.collaborationStyle, "operatorPreferences.collaborationStyle", errors);
    validateStringArray(value.operatorPreferences.reviewExpectations, "operatorPreferences.reviewExpectations", errors);
    if (
      !isNonEmptyString(value.operatorPreferences.preferredResponseLength) ||
      !RESPONSE_LENGTH_SET.has(value.operatorPreferences.preferredResponseLength as PassportResponseLength)
    ) {
      errors.push(
        `operatorPreferences.preferredResponseLength must be one of: ${PASSPORT_RESPONSE_LENGTHS.join(", ")}`
      );
    }
  }
  if (
    value.continuityPolicyRef !== null &&
    value.continuityPolicyRef !== undefined &&
    !isNonEmptyString(value.continuityPolicyRef)
  ) {
    errors.push("continuityPolicyRef must be a non-empty string or null");
  }
  errors.push(...validatePassportMemoryScope(value.memoryScope));

  if (!isRecord(value.capabilities)) {
    errors.push("capabilities must be an object");
  } else {
    validateStringArray(value.capabilities.declared, "capabilities.declared", errors);
    validateStringArray(value.capabilities.strengths, "capabilities.strengths", errors);
    validateStringArray(value.capabilities.limitations, "capabilities.limitations", errors);
  }
  if (!isRecord(value.handoffPreferences)) {
    errors.push("handoffPreferences must be an object");
  } else {
    validateEnumArray(value.handoffPreferences.preferredTargets, "handoffPreferences.preferredTargets", RUNTIME_HOST_SET, errors);
    validateStringArray(value.handoffPreferences.requiresCapabilities, "handoffPreferences.requiresCapabilities", errors);
    validateStringArray(value.handoffPreferences.escalationHints, "handoffPreferences.escalationHints", errors);
  }
  if (!isRecord(value.enginePortability)) {
    errors.push("enginePortability must be an object");
  } else {
    if (value.enginePortability.identityIsNotEngineBound !== true) {
      errors.push("enginePortability.identityIsNotEngineBound must be true");
    }
    if (
      value.enginePortability.currentEngineAttachmentRef !== null &&
      value.enginePortability.currentEngineAttachmentRef !== undefined &&
      !isNonEmptyString(value.enginePortability.currentEngineAttachmentRef)
    ) {
      errors.push("enginePortability.currentEngineAttachmentRef must be a non-empty string or null");
    }
    validateStringArray(value.enginePortability.portabilityNotes, "enginePortability.portabilityNotes", errors);
  }

  const declaredTrustZones = new Set<PassportTrustZoneId>();
  if (!Array.isArray(value.trustZones) || value.trustZones.length === 0) {
    errors.push("trustZones must be a non-empty array");
  } else {
    for (const trustZone of value.trustZones) {
      errors.push(...validatePassportTrustZone(trustZone));
      if (isRecord(trustZone) && isNonEmptyString(trustZone.trustZoneId) && TRUST_ZONE_SET.has(trustZone.trustZoneId as PassportTrustZoneId)) {
        if (declaredTrustZones.has(trustZone.trustZoneId as PassportTrustZoneId)) {
          errors.push(`trustZones contains duplicate trustZoneId ${trustZone.trustZoneId}`);
        }
        declaredTrustZones.add(trustZone.trustZoneId as PassportTrustZoneId);
      }
    }
  }

  if (!isRecord(value.enforcement)) {
    errors.push("enforcement must be an object");
  } else {
    if (value.enforcement.sourceOfTruth !== "onlybots_runtime") {
      errors.push("enforcement.sourceOfTruth must be onlybots_runtime");
    }
    if (!Array.isArray(value.enforcement.compilationTargets) || value.enforcement.compilationTargets.length === 0) {
      errors.push("enforcement.compilationTargets must be a non-empty array");
    } else {
      for (const target of value.enforcement.compilationTargets) {
        errors.push(...validatePassportCompilationTarget(target));
        if (isRecord(target)) {
          if (
            isNonEmptyString(target.defaultTrustZone) &&
            declaredTrustZones.size > 0 &&
            !declaredTrustZones.has(target.defaultTrustZone as PassportTrustZoneId)
          ) {
            errors.push(`compilationTarget.defaultTrustZone ${target.defaultTrustZone} is not declared in trustZones`);
          }
          if (Array.isArray(target.trustZonePolicies)) {
            for (const policy of target.trustZonePolicies) {
              if (
                isRecord(policy) &&
                isNonEmptyString(policy.trustZoneId) &&
                declaredTrustZones.size > 0 &&
                !declaredTrustZones.has(policy.trustZoneId as PassportTrustZoneId)
              ) {
                errors.push(`compilationTarget.trustZonePolicy ${policy.trustZoneId} is not declared in trustZones`);
              }
            }
          }
        }
      }
    }
    validateStringArray(value.enforcement.runtimeAuthorityNotes, "enforcement.runtimeAuthorityNotes", errors);
  }

  if (!isRecord(value.provenance)) {
    errors.push("provenance must be an object");
  } else {
    if (!isIsoDateString(value.provenance.createdAt)) {
      errors.push("provenance.createdAt must be an ISO date string");
    }
    if (!isIsoDateString(value.provenance.updatedAt)) {
      errors.push("provenance.updatedAt must be an ISO date string");
    }
    if (
      value.provenance.compilerVersion !== null &&
      value.provenance.compilerVersion !== undefined &&
      !isNonEmptyString(value.provenance.compilerVersion)
    ) {
      errors.push("provenance.compilerVersion must be a non-empty string or null");
    }
    if (
      value.provenance.sourcePassportHash !== null &&
      value.provenance.sourcePassportHash !== undefined &&
      !isNonEmptyString(value.provenance.sourcePassportHash)
    ) {
      errors.push("provenance.sourcePassportHash must be a non-empty string or null");
    }
    const requiredFields = validateEnumArray(
      value.provenance.requiredCompiledFields,
      "provenance.requiredCompiledFields",
      PROVENANCE_FIELD_SET,
      errors
    );
    for (const field of REQUIRED_PROVENANCE_FIELDS) {
      if (!requiredFields.includes(field)) {
        errors.push(`provenance.requiredCompiledFields must include ${field}`);
      }
    }
  }

  if (!isRecord(value.signature)) {
    errors.push("signature must be an object");
  } else {
    if (value.signature.scheme !== "nostr_schnorr") {
      errors.push("signature.scheme must be nostr_schnorr");
    }
    if (!isNonEmptyString(value.signature.signedBy) || !NPUB_PATTERN.test(value.signature.signedBy)) {
      errors.push("signature.signedBy must be an npub identifier");
    }
    if (value.signature.signedAt !== null && value.signature.signedAt !== undefined && !isIsoDateString(value.signature.signedAt)) {
      errors.push("signature.signedAt must be an ISO date string or null");
    }
    if (isRecord(value.agentRef) && isNonEmptyString(value.agentRef.npub) && value.signature.signedBy !== value.agentRef.npub) {
      errors.push("signature.signedBy must match agentRef.npub");
    }
  }

  validateStringArray(value.notes, "notes", errors);

  if (isRecord(value.memoryScope) && declaredTrustZones.size > 0) {
    const allowedZones = Array.isArray(value.memoryScope.allowedTrustZones)
      ? (value.memoryScope.allowedTrustZones as string[])
      : [];
    for (const zoneId of allowedZones) {
      if (!declaredTrustZones.has(zoneId as PassportTrustZoneId)) {
        errors.push(`memoryScope.allowedTrustZones contains undeclared zone ${zoneId}`);
      }
    }
  }

  return errors;
};

const buildTrustZoneMemoryScope = (
  allowedWorkspaces: string[],
  trustZoneId: PassportTrustZoneId,
  portableMemoryTiers: PassportMemoryTier[]
): PassportMemoryScope => ({
  allowedWorkspaces,
  allowedTrustZones: [trustZoneId],
  portableMemoryTiers,
  allowCrossWorkspaceContext: false,
});

export const createDefaultPassportTrustZones = (allowedWorkspaces: string[] = ["repo:onlybots-erd"]): PassportTrustZone[] => [
  {
    trustZoneId: "personal",
    displayName: "Personal",
    summary: "Operator-owned workstation or repo where the agent can retain the richest continuity context.",
    workspacePolicy: "operator_private",
    memoryScope: buildTrustZoneMemoryScope(allowedWorkspaces, "personal", [
      "hot",
      "warm",
      "cold",
      "self_model",
      "project_model",
      "user_model",
    ]),
    auditExpectations: ["Record provenance for compiled outputs and runtime-managed mutations."],
    outputAdjustments: ["Allow richer context references while keeping prompt files explicitly advisory."],
  },
  {
    trustZoneId: "shared",
    displayName: "Shared",
    summary: "Team workspace where continuity is portable but should stay bounded to shared project knowledge.",
    workspacePolicy: "team_shared",
    memoryScope: buildTrustZoneMemoryScope(allowedWorkspaces, "shared", [
      "hot",
      "warm",
      "cold",
      "self_model",
      "project_model",
    ]),
    auditExpectations: ["Prefer inspectable managed sections and shared-policy references over opaque prompt prose."],
    outputAdjustments: ["Keep handoff and review expectations explicit for multi-operator visibility."],
  },
  {
    trustZoneId: "public",
    displayName: "Public",
    summary: "Public-facing or demo workspace where the passport should minimize private carryover and maximize explainability.",
    workspacePolicy: "public_visible",
    memoryScope: buildTrustZoneMemoryScope(allowedWorkspaces, "public", ["hot", "warm", "self_model"]),
    auditExpectations: ["Emit conservative provenance and avoid embedding private operator or client references."],
    outputAdjustments: ["Prefer sanitized capability and persona summaries over detailed internal memory cues."],
  },
  {
    trustZoneId: "client",
    displayName: "Client",
    summary: "Client-specific environment that requires narrow workspace scope, explicit review posture, and portable auditability.",
    workspacePolicy: "client_restricted",
    memoryScope: buildTrustZoneMemoryScope(allowedWorkspaces, "client", [
      "hot",
      "warm",
      "cold",
      "self_model",
      "project_model",
      "user_model",
    ]),
    auditExpectations: ["Keep trust-zone-specific outputs attributable and review-sensitive."],
    outputAdjustments: ["Bias toward explicit review expectations and tighter memory portability notes."],
  },
];

const buildHostArtifacts = (host: PassportRuntimeHost): PassportCompiledArtifact[] => {
  if (host === "codex") {
    return [
      {
        artifactId: "artifact_codex_wrapper",
        surface: "managed_wrapper",
        pathHint: "~/.onlybots/bin/onlybots-codex",
        honesty: "runtime_enforced",
        sourceOfTruth: "onlybots_runtime",
        notes: ["Runtime-managed lifecycle hooks and memory automation flow through the Crosshead wrapper."],
      },
      {
        artifactId: "artifact_codex_hooks",
        surface: "hooks_json",
        pathHint: "~/.codex/hooks.json",
        honesty: "runtime_enforced",
        sourceOfTruth: "onlybots_runtime",
        notes: ["Crosshead owns the managed hook wiring, but not Codex tool execution itself."],
      },
      {
        artifactId: "artifact_codex_agents",
        surface: "AGENTS.md",
        pathHint: "$WORKSPACE/AGENTS.md",
        honesty: "advisory",
        sourceOfTruth: "prompt_file",
        notes: ["Compiled prompt content can describe policy, but it cannot enforce host behavior on its own."],
      },
    ];
  }
  if (host === "claude-code") {
    return [
      {
        artifactId: "artifact_claude_wrapper",
        surface: "managed_wrapper",
        pathHint: "~/.onlybots/bin/onlybots-claude-code",
        honesty: "runtime_enforced",
        sourceOfTruth: "onlybots_runtime",
        notes: ["Crosshead manages the runtime-attached lifecycle path when the wrapper is used."],
      },
      {
        artifactId: "artifact_claude_settings",
        surface: ".claude/settings.json",
        pathHint: "$WORKSPACE/.claude/settings.json",
        honesty: "best_effort",
        sourceOfTruth: "managed_host_config",
        notes: ["Managed host config helps wire Crosshead in, but Claude Code still owns actual tool execution."],
      },
      {
        artifactId: "artifact_claude_md",
        surface: "CLAUDE.md",
        pathHint: "$WORKSPACE/CLAUDE.md",
        honesty: "advisory",
        sourceOfTruth: "prompt_file",
        notes: ["Prompt guidance remains descriptive unless paired with runtime-owned controls."],
      },
    ];
  }
  return [
    {
      artifactId: "artifact_pi_profile",
      surface: "pi-passport.json",
      pathHint: "~/.onlybots/config/embedded/pi-passport.json",
      honesty: "runtime_enforced",
      sourceOfTruth: "onlybots_runtime",
      notes: ["Crosshead owns the embedded Pi passport profile under the shared runtime."],
    },
    {
      artifactId: "artifact_pi_agents",
      surface: "AGENTS.md",
      pathHint: "$WORKSPACE/AGENTS.md",
      honesty: "advisory",
      sourceOfTruth: "prompt_file",
      notes: ["Prompt output stays advisory unless the runtime can back it with actual behavior."],
    },
  ];
};

const buildTrustZonePolicyNotes = (trustZoneId: PassportTrustZoneId): string[] => {
  switch (trustZoneId) {
    case "personal":
      return ["Allow the richest runtime-managed context while keeping host-owned behavior explicitly labeled."];
    case "shared":
      return ["Prefer managed sections, shared policy refs, and concise team-visible review expectations."];
    case "public":
      return ["Reduce private carryover and emphasize sanitized summaries plus inspectable provenance."];
    case "client":
      return ["Bias toward conservative memory scope, explicit review posture, and client-visible audit trails."];
  }
};

export const createDefaultPassportCompilationTargets = (
  trustZoneIds: PassportTrustZoneId[] = [...PASSPORT_TRUST_ZONE_IDS]
): PassportCompilationTarget[] =>
  PASSPORT_RUNTIME_HOSTS.map((host) => ({
    targetHost: host,
    defaultTrustZone: "personal",
    trustZonePolicies: trustZoneIds.map((trustZoneId) => ({
      trustZoneId,
      compiledArtifacts: buildHostArtifacts(host),
      notes: buildTrustZonePolicyNotes(trustZoneId),
    })),
    hostLimitations:
      host === "pi"
        ? [
            "Pi support remains narrower than Codex and Claude Code until full passport compile flows land.",
            "Prompt files remain advisory without runtime-owned controls.",
          ]
        : [
            `${host} prompt files cannot enforce tool approval or self-modification on their own.`,
            `${host} trust-zone behavior is only as strong as the runtime-managed attachment path behind it.`,
          ],
  }));

export const buildDraftAgentPassport = (options: AgentPassportDraftOptions): AgentPassport => {
  const createdAt = options.createdAt ?? "2026-04-15T00:00:00Z";
  const allowedWorkspaces = options.allowedWorkspaces ?? ["repo:onlybots-erd"];
  const trustZones = createDefaultPassportTrustZones(allowedWorkspaces);
  return {
    passportVersion: AGENT_PASSPORT_SCHEMA_VERSION,
    passportId: `passport_${options.agentRef.agentId.replace(/^agent_/, "")}`,
    agentRef: options.agentRef,
    identity: {
      displayName: options.displayName ?? "Crosshead Default Agent",
    },
    persona: {
      summary: "Portable Crosshead agent passport for runtime-managed continuity and honest host compilation.",
      style: ["concise", "evidence-first", "operator-readable"],
    },
    operatorPreferences: {
      collaborationStyle: ["direct", "inspectable", "no hidden control claims"],
      reviewExpectations: ["surface degraded controls explicitly", "prefer managed boundaries over silent overwrite"],
      preferredResponseLength: "brief",
    },
    continuityPolicyRef: options.continuityPolicyRef ?? "continuity_policy_v1:sha256:policy_default",
    memoryScope: {
      allowedWorkspaces,
      allowedTrustZones: trustZones.map((entry) => entry.trustZoneId),
      portableMemoryTiers: ["hot", "warm", "cold", "self_model", "project_model"],
      allowCrossWorkspaceContext: false,
    },
    capabilities: {
      declared: ["coding", "handoffs", "memory_sync", "runtime_supervision"],
      strengths: ["cross-runtime continuity", "operator-facing explainability", "signed handoff provenance"],
      limitations: ["host-owned tool approval", "host-owned self-modification", "prompt-only enforcement"],
    },
    handoffPreferences: {
      preferredTargets: ["codex", "claude-code"],
      requiresCapabilities: ["repo_execution", "tool_use"],
      escalationHints: [
        "Prefer Codex or Claude Code when the task needs repository execution.",
        "Keep portability notes explicit when the next host cannot enforce the same control surface.",
      ],
    },
    enginePortability: {
      identityIsNotEngineBound: true,
      currentEngineAttachmentRef: options.currentEngineAttachmentRef ?? null,
      portabilityNotes: [
        "The passport is attached to the persistent agent, not whichever model or host is active right now.",
      ],
    },
    trustZones,
    enforcement: {
      sourceOfTruth: "onlybots_runtime",
      compilationTargets: createDefaultPassportCompilationTargets(trustZones.map((entry) => entry.trustZoneId)),
      runtimeAuthorityNotes: [
        "Only the shared Crosshead runtime can honestly claim runtime_enforced output labels.",
        "Managed prompt files remain advisory unless a paired runtime control path exists.",
      ],
    },
    provenance: {
      createdAt,
      updatedAt: createdAt,
      compilerVersion: options.compilerVersion ?? null,
      sourcePassportHash: null,
      requiredCompiledFields: [...PASSPORT_COMPILED_PROVENANCE_FIELDS],
    },
    signature: {
      scheme: "nostr_schnorr",
      signedBy: options.agentRef.npub,
      signedAt: null,
    },
    notes: ["Passport schema v1 is host-neutral and intentionally honest about enforcement limits."],
  };
};

export const agentPassportExample: AgentPassport = buildDraftAgentPassport({
  agentRef: {
    agentId: "agent_onlybots_default",
    npub: "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqw0x2r",
    lineageRoot: "agent_onlybots_default",
  },
  displayName: "Crosshead Default Agent",
  continuityPolicyRef: "continuity_policy_v1:sha256:policy_default",
  currentEngineAttachmentRef: "engine_attach_codex_gpt5_primary",
  compilerVersion: "0.3.0",
  allowedWorkspaces: ["repo:onlybots-erd"],
  createdAt: "2026-04-15T00:00:00Z",
});
