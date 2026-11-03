export const CONTINUITY_POLICY_SCHEMA_VERSION = "continuity_policy_v1";

export const CONTINUITY_POLICY_RULE_IDS = [
  "risk_tolerance",
  "execution_bias",
  "cost_sensitivity",
  "memory_hot_write",
  "memory_write_threshold",
  "warm_promotion_sensitivity",
  "tool_approval",
  "self_modification",
  "human_review_gates",
  "trust_zones",
  "budget_ceilings",
] as const;

export const CONTINUITY_HUMAN_REVIEW_GATES = [
  "self_modification",
  "external_publish",
  "budget_override",
  "cross_workspace_write",
] as const;

export const CONTINUITY_ENFORCEMENT_CLASSES = ["enforced", "best_effort", "advisory"] as const;
export const CONTINUITY_MEMORY_HOT_WRITE_MODES = ["off", "debounced"] as const;
export const CONTINUITY_MEMORY_WRITE_THRESHOLDS = ["explicit_only", "proposal_first", "auto"] as const;
export const CONTINUITY_TOOL_APPROVAL_MODES = ["host_default", "operator_confirmed", "trusted_only"] as const;
export const CONTINUITY_SELF_MODIFICATION_MODES = ["review_required", "disallowed", "workspace_only"] as const;
export const CONTINUITY_TRUST_ZONE_SCOPES = ["workspace", "profile", "global"] as const;
export const CONTINUITY_AUTHORITY_MODES = [
  "authoritative_remote",
  "authoritative_local",
  "merge",
  "ephemeral_overlay",
] as const;

export type ContinuityPolicyRuleId = (typeof CONTINUITY_POLICY_RULE_IDS)[number];
export type ContinuityHumanReviewGate = (typeof CONTINUITY_HUMAN_REVIEW_GATES)[number];
export type ContinuityPolicyEnforcementClass = (typeof CONTINUITY_ENFORCEMENT_CLASSES)[number];
export type ContinuityMemoryHotWriteMode = (typeof CONTINUITY_MEMORY_HOT_WRITE_MODES)[number];
export type ContinuityMemoryWriteThreshold = (typeof CONTINUITY_MEMORY_WRITE_THRESHOLDS)[number];
export type ContinuityToolApprovalMode = (typeof CONTINUITY_TOOL_APPROVAL_MODES)[number];
export type ContinuitySelfModificationMode = (typeof CONTINUITY_SELF_MODIFICATION_MODES)[number];
export type ContinuityTrustZoneScope = (typeof CONTINUITY_TRUST_ZONE_SCOPES)[number];
export type ContinuityAuthorityMode = (typeof CONTINUITY_AUTHORITY_MODES)[number];
export type ContinuityPolicySource = "runtime_default" | "stored_policy" | "manifest_policy" | "fallback_default";
export type ContinuityPolicyHost = "runtime" | "codex" | "claude-code" | "pi";
export type ContinuityAuthorityTierId = "hot_memory" | "warm_memory" | "cold_memory" | "runtime_overlay";

export type ContinuityPolicy = {
  policyVersion: typeof CONTINUITY_POLICY_SCHEMA_VERSION;
  policyId: string;
  updatedAt: string;
  riskTolerance: number;
  executionBias: number;
  costSensitivity: number;
  memory: {
    hotWriteMode: ContinuityMemoryHotWriteMode;
    writeThreshold: ContinuityMemoryWriteThreshold;
    warmPromotionSensitivity: number;
    trustZoneScope: ContinuityTrustZoneScope;
    allowCrossWorkspaceContext: boolean;
  };
  governance: {
    toolApprovalMode: ContinuityToolApprovalMode;
    selfModificationMode: ContinuitySelfModificationMode;
    requireReviewFor: ContinuityHumanReviewGate[];
    budgetCeilings: {
      maxBudgetSats: number;
      maxWarmWritesPerTurn: number;
      maxColdItemsPerBatch: number;
    };
  };
  authority: {
    hotMemory: ContinuityAuthorityMode;
    warmMemory: ContinuityAuthorityMode;
    coldMemory: ContinuityAuthorityMode;
    runtimeOverlay: ContinuityAuthorityMode;
  };
  enforcement: Record<ContinuityPolicyRuleId, ContinuityPolicyEnforcementClass>;
};

export type ContinuityPolicyHostCapabilities = {
  host: ContinuityPolicyHost;
  automationHealthy: boolean;
  runtimeControlsMemory: boolean;
  canEnforceTrustZones: boolean;
  canInterceptToolUse: boolean;
  canRestrictSelfModification: boolean;
  canRequireHumanReview: boolean;
  canEnforceBudgetCeilings: boolean;
};

export type ContinuityPolicyRuleEvaluation = {
  ruleId: ContinuityPolicyRuleId;
  requested: ContinuityPolicyEnforcementClass;
  effective: ContinuityPolicyEnforcementClass;
  honored: boolean;
  reason: string;
};

export type ContinuityPolicyAuthorityEvaluation = {
  tier: ContinuityAuthorityTierId;
  requestedMode: ContinuityAuthorityMode;
  effectiveMode: ContinuityAuthorityMode;
  honored: boolean;
  owner: "local_runtime" | "hosted_api" | "append_only_evidence" | "ephemeral_local";
  reason: string;
};

export type ContinuityPolicyConflict = {
  scope: "rule" | "authority";
  host: ContinuityPolicyHost | "global";
  id: string;
  requested: string;
  effective: string;
  reason: string;
};

export type ContinuityPolicySummary = {
  enforced: number;
  bestEffort: number;
  advisory: number;
};

export type ContinuityPolicyHostReport = {
  host: ContinuityPolicyHost;
  automationHealthy: boolean;
  degraded: boolean;
  summary: ContinuityPolicySummary;
  rules: ContinuityPolicyRuleEvaluation[];
  unresolvedConflicts: ContinuityPolicyConflict[];
  notes: string[];
};

export type ContinuityPolicyInspection = {
  source: ContinuityPolicySource;
  validationErrors: string[];
  policy: ContinuityPolicy;
  sharedRuntime: ContinuityPolicyHostReport;
  hosts: ContinuityPolicyHostReport[];
  authority: ContinuityPolicyAuthorityEvaluation[];
  unresolvedConflicts: ContinuityPolicyConflict[];
  degraded: boolean;
};

export class ContinuityPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuityPolicyValidationError";
  }
}

const ENFORCEMENT_RANK: Record<ContinuityPolicyEnforcementClass, number> = {
  advisory: 0,
  best_effort: 1,
  enforced: 2,
};

const RULE_SET = new Set<ContinuityPolicyRuleId>(CONTINUITY_POLICY_RULE_IDS);
const REVIEW_GATE_SET = new Set<ContinuityHumanReviewGate>(CONTINUITY_HUMAN_REVIEW_GATES);
const ENFORCEMENT_SET = new Set<ContinuityPolicyEnforcementClass>(CONTINUITY_ENFORCEMENT_CLASSES);
const HOT_WRITE_MODE_SET = new Set<ContinuityMemoryHotWriteMode>(CONTINUITY_MEMORY_HOT_WRITE_MODES);
const WRITE_THRESHOLD_SET = new Set<ContinuityMemoryWriteThreshold>(CONTINUITY_MEMORY_WRITE_THRESHOLDS);
const TOOL_APPROVAL_SET = new Set<ContinuityToolApprovalMode>(CONTINUITY_TOOL_APPROVAL_MODES);
const SELF_MODIFICATION_SET = new Set<ContinuitySelfModificationMode>(CONTINUITY_SELF_MODIFICATION_MODES);
const TRUST_ZONE_SET = new Set<ContinuityTrustZoneScope>(CONTINUITY_TRUST_ZONE_SCOPES);
const AUTHORITY_MODE_SET = new Set<ContinuityAuthorityMode>(CONTINUITY_AUTHORITY_MODES);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const readKey = (record: Record<string, unknown> | null, ...keys: string[]): unknown => {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }
  return undefined;
};

const requireNonEmptyString = (value: unknown, fieldName: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContinuityPolicyValidationError(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
};

const normalizeNumber = (value: unknown, fallback: number, fieldName: string, minimum = 0, maximum = 1): number => {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ContinuityPolicyValidationError(`${fieldName} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
};

const normalizeInteger = (value: unknown, fallback: number, fieldName: string, minimum = 0): number => {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new ContinuityPolicyValidationError(`${fieldName} must be an integer >= ${minimum}`);
  }
  return value as number;
};

const normalizeBoolean = (value: unknown, fallback: boolean, fieldName: string): boolean => {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ContinuityPolicyValidationError(`${fieldName} must be a boolean`);
  }
  return value;
};

const normalizeEnum = <T extends string>(
  value: unknown,
  fallback: T,
  fieldName: string,
  accepted: Set<T>
): T => {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string" || !accepted.has(value as T)) {
    throw new ContinuityPolicyValidationError(`${fieldName} must be one of: ${Array.from(accepted).join(", ")}`);
  }
  return value as T;
};

const normalizeStringArray = <T extends string>(
  value: unknown,
  fieldName: string,
  accepted: Set<T>
): T[] => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ContinuityPolicyValidationError(`${fieldName} must be an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !accepted.has(entry as T)) {
      throw new ContinuityPolicyValidationError(
        `${fieldName}[${index}] must be one of: ${Array.from(accepted).join(", ")}`
      );
    }
    return entry as T;
  });
};

const defaultEnforcement = (): Record<ContinuityPolicyRuleId, ContinuityPolicyEnforcementClass> => ({
  risk_tolerance: "advisory",
  execution_bias: "advisory",
  cost_sensitivity: "advisory",
  memory_hot_write: "enforced",
  memory_write_threshold: "enforced",
  warm_promotion_sensitivity: "enforced",
  tool_approval: "advisory",
  self_modification: "advisory",
  human_review_gates: "advisory",
  trust_zones: "best_effort",
  budget_ceilings: "best_effort",
});

export const buildDefaultContinuityPolicy = (now: Date = new Date()): ContinuityPolicy => ({
  policyVersion: CONTINUITY_POLICY_SCHEMA_VERSION,
  policyId: "runtime-default",
  updatedAt: now.toISOString(),
  riskTolerance: 0.25,
  executionBias: 0.8,
  costSensitivity: 0.7,
  memory: {
    hotWriteMode: "debounced",
    writeThreshold: "auto",
    warmPromotionSensitivity: 0.84,
    trustZoneScope: "workspace",
    allowCrossWorkspaceContext: false,
  },
  governance: {
    toolApprovalMode: "operator_confirmed",
    selfModificationMode: "review_required",
    requireReviewFor: ["self_modification", "external_publish", "cross_workspace_write"],
    budgetCeilings: {
      maxBudgetSats: 500,
      maxWarmWritesPerTurn: 4,
      maxColdItemsPerBatch: 24,
    },
  },
  authority: {
    hotMemory: "authoritative_local",
    warmMemory: "authoritative_remote",
    coldMemory: "merge",
    runtimeOverlay: "ephemeral_overlay",
  },
  enforcement: defaultEnforcement(),
});

export const resolveContinuityPolicy = (input: unknown, now: Date = new Date()): ContinuityPolicy => {
  const defaults = buildDefaultContinuityPolicy(now);
  const root = asRecord(input);
  if (!root) {
    return defaults;
  }

  const memory = asRecord(readKey(root, "memory"));
  const governance = asRecord(readKey(root, "governance"));
  const authority = asRecord(readKey(root, "authority"));
  const enforcement = asRecord(readKey(root, "enforcement"));

  const resolvedEnforcement: Record<ContinuityPolicyRuleId, ContinuityPolicyEnforcementClass> = { ...defaults.enforcement };
  if (enforcement) {
    for (const ruleId of CONTINUITY_POLICY_RULE_IDS) {
      resolvedEnforcement[ruleId] = normalizeEnum(
        enforcement[ruleId],
        defaults.enforcement[ruleId],
        `enforcement.${ruleId}`,
        ENFORCEMENT_SET
      );
    }
    for (const key of Object.keys(enforcement)) {
      if (!RULE_SET.has(key as ContinuityPolicyRuleId)) {
        throw new ContinuityPolicyValidationError(`enforcement.${key} is not a supported continuity rule`);
      }
    }
  }

  const resolveAuthorityMode = (
    fieldName: string,
    fallback: ContinuityAuthorityMode,
    record: Record<string, unknown> | null
  ): ContinuityAuthorityMode => {
    const raw = readKey(record, fieldName, `${fieldName}_mode`, fieldName.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`));
    if (raw && asRecord(raw)) {
      return normalizeEnum(readKey(asRecord(raw), "mode"), fallback, `authority.${fieldName}.mode`, AUTHORITY_MODE_SET);
    }
    return normalizeEnum(raw, fallback, `authority.${fieldName}`, AUTHORITY_MODE_SET);
  };

  return {
    policyVersion: requireNonEmptyString(
      readKey(root, "policyVersion", "policy_version") ?? defaults.policyVersion,
      "policyVersion"
    ) as typeof CONTINUITY_POLICY_SCHEMA_VERSION,
    policyId: requireNonEmptyString(readKey(root, "policyId", "policy_id") ?? defaults.policyId, "policyId"),
    updatedAt: requireNonEmptyString(readKey(root, "updatedAt", "updated_at") ?? defaults.updatedAt, "updatedAt"),
    riskTolerance: normalizeNumber(
      readKey(root, "riskTolerance", "risk_tolerance"),
      defaults.riskTolerance,
      "riskTolerance"
    ),
    executionBias: normalizeNumber(
      readKey(root, "executionBias", "execution_bias"),
      defaults.executionBias,
      "executionBias"
    ),
    costSensitivity: normalizeNumber(
      readKey(root, "costSensitivity", "cost_sensitivity"),
      defaults.costSensitivity,
      "costSensitivity"
    ),
    memory: {
      hotWriteMode: normalizeEnum(
        readKey(memory, "hotWriteMode", "hot_write_mode"),
        defaults.memory.hotWriteMode,
        "memory.hotWriteMode",
        HOT_WRITE_MODE_SET
      ),
      writeThreshold: normalizeEnum(
        readKey(memory, "writeThreshold", "write_threshold"),
        defaults.memory.writeThreshold,
        "memory.writeThreshold",
        WRITE_THRESHOLD_SET
      ),
      warmPromotionSensitivity: normalizeNumber(
        readKey(memory, "warmPromotionSensitivity", "warm_promotion_sensitivity"),
        defaults.memory.warmPromotionSensitivity,
        "memory.warmPromotionSensitivity"
      ),
      trustZoneScope: normalizeEnum(
        readKey(memory, "trustZoneScope", "trust_zone_scope"),
        defaults.memory.trustZoneScope,
        "memory.trustZoneScope",
        TRUST_ZONE_SET
      ),
      allowCrossWorkspaceContext: normalizeBoolean(
        readKey(memory, "allowCrossWorkspaceContext", "allow_cross_workspace_context"),
        defaults.memory.allowCrossWorkspaceContext,
        "memory.allowCrossWorkspaceContext"
      ),
    },
    governance: {
      toolApprovalMode: normalizeEnum(
        readKey(governance, "toolApprovalMode", "tool_approval_mode"),
        defaults.governance.toolApprovalMode,
        "governance.toolApprovalMode",
        TOOL_APPROVAL_SET
      ),
      selfModificationMode: normalizeEnum(
        readKey(governance, "selfModificationMode", "self_modification_mode"),
        defaults.governance.selfModificationMode,
        "governance.selfModificationMode",
        SELF_MODIFICATION_SET
      ),
      requireReviewFor: normalizeStringArray(
        readKey(governance, "requireReviewFor", "require_review_for"),
        "governance.requireReviewFor",
        REVIEW_GATE_SET
      ),
      budgetCeilings: {
        maxBudgetSats: normalizeInteger(
          readKey(asRecord(readKey(governance, "budgetCeilings", "budget_ceilings")), "maxBudgetSats", "max_budget_sats"),
          defaults.governance.budgetCeilings.maxBudgetSats,
          "governance.budgetCeilings.maxBudgetSats"
        ),
        maxWarmWritesPerTurn: normalizeInteger(
          readKey(
            asRecord(readKey(governance, "budgetCeilings", "budget_ceilings")),
            "maxWarmWritesPerTurn",
            "max_warm_writes_per_turn"
          ),
          defaults.governance.budgetCeilings.maxWarmWritesPerTurn,
          "governance.budgetCeilings.maxWarmWritesPerTurn"
        ),
        maxColdItemsPerBatch: normalizeInteger(
          readKey(
            asRecord(readKey(governance, "budgetCeilings", "budget_ceilings")),
            "maxColdItemsPerBatch",
            "max_cold_items_per_batch"
          ),
          defaults.governance.budgetCeilings.maxColdItemsPerBatch,
          "governance.budgetCeilings.maxColdItemsPerBatch"
        ),
      },
    },
    authority: {
      hotMemory: resolveAuthorityMode("hotMemory", defaults.authority.hotMemory, authority),
      warmMemory: resolveAuthorityMode("warmMemory", defaults.authority.warmMemory, authority),
      coldMemory: resolveAuthorityMode("coldMemory", defaults.authority.coldMemory, authority),
      runtimeOverlay: resolveAuthorityMode("runtimeOverlay", defaults.authority.runtimeOverlay, authority),
    },
    enforcement: resolvedEnforcement,
  };
};

const downgradeEnforcement = (
  requested: ContinuityPolicyEnforcementClass,
  maximumSupported: ContinuityPolicyEnforcementClass
): ContinuityPolicyEnforcementClass =>
  ENFORCEMENT_RANK[requested] <= ENFORCEMENT_RANK[maximumSupported] ? requested : maximumSupported;

const summarizeRules = (rules: ContinuityPolicyRuleEvaluation[]): ContinuityPolicySummary => ({
  enforced: rules.filter((rule) => rule.effective === "enforced").length,
  bestEffort: rules.filter((rule) => rule.effective === "best_effort").length,
  advisory: rules.filter((rule) => rule.effective === "advisory").length,
});

const maxSupportedEnforcementForRule = (
  ruleId: ContinuityPolicyRuleId,
  capabilities: ContinuityPolicyHostCapabilities
): ContinuityPolicyEnforcementClass => {
  switch (ruleId) {
    case "memory_hot_write":
    case "memory_write_threshold":
    case "warm_promotion_sensitivity":
      if (capabilities.runtimeControlsMemory && capabilities.automationHealthy) {
        return "enforced";
      }
      return capabilities.runtimeControlsMemory ? "best_effort" : "advisory";
    case "trust_zones":
      if (capabilities.canEnforceTrustZones) {
        return "enforced";
      }
      return capabilities.runtimeControlsMemory ? "best_effort" : "advisory";
    case "tool_approval":
      return capabilities.canInterceptToolUse ? "best_effort" : "advisory";
    case "self_modification":
      return capabilities.canRestrictSelfModification ? "best_effort" : "advisory";
    case "human_review_gates":
      return capabilities.canRequireHumanReview ? "best_effort" : "advisory";
    case "budget_ceilings":
      return capabilities.canEnforceBudgetCeilings ? "best_effort" : "advisory";
    default:
      return "advisory";
  }
};

const hostRuleReason = (
  ruleId: ContinuityPolicyRuleId,
  capabilities: ContinuityPolicyHostCapabilities,
  effective: ContinuityPolicyEnforcementClass
): string => {
  if (ruleId === "memory_hot_write") {
    return effective === "enforced"
      ? `${capabilities.host} routes automatic hot-memory writes through onlybotsd.`
      : `${capabilities.host} may bypass automatic hot-memory hooks when lifecycle events do not reach onlybotsd.`;
  }
  if (ruleId === "memory_write_threshold") {
    return effective === "enforced"
      ? `${capabilities.host} durable write thresholds are enforced inside runtime-managed warm and cold write paths.`
      : `${capabilities.host} durable write thresholds are only advisory unless the shared runtime sees the lifecycle event.`;
  }
  if (ruleId === "warm_promotion_sensitivity") {
    return effective === "enforced"
      ? `${capabilities.host} automatic warm promotion is gated by runtime-owned sensitivity thresholds.`
      : `${capabilities.host} warm-promotion sensitivity becomes advisory when automation is not fully attached.`;
  }
  if (ruleId === "tool_approval") {
    return capabilities.host === "pi"
      ? "Pi runs through the shared runtime but tool-level approval is not yet a hard gate in the embedded executor."
      : `${capabilities.host} can emit tool events, but the host still decides which tools run.`;
  }
  if (ruleId === "self_modification") {
    return capabilities.host === "pi"
      ? "Pi can be wrapped by Crosshead, but v1 does not hard-block self-modifying behavior inside the executor."
      : `${capabilities.host} does not let Crosshead hard-stop self-modifying edits once the host is executing.`;
  }
  if (ruleId === "human_review_gates") {
    return capabilities.host === "pi"
      ? "Pi can surface review gates through runtime inspection, but v1 does not yet block execution until an operator approves."
      : `${capabilities.host} review gates are surfaced honestly, but the host does not stop itself on Crosshead policy alone.`;
  }
  if (ruleId === "trust_zones") {
    return effective === "enforced"
      ? `${capabilities.host} trust-zone boundaries are enforced through the managed runtime attachment and workspace manifest.`
      : `${capabilities.host} trust zones are scoped for Crosshead-managed context, but the host can still touch out-of-band workspace state.`;
  }
  if (ruleId === "budget_ceilings") {
    return effective === "advisory"
      ? `${capabilities.host} budget ceilings are visible but not host-enforced in v1.`
      : `${capabilities.host} budget ceilings currently cap runtime-managed write volume, not every downstream spend or tool side effect.`;
  }
  if (ruleId === "risk_tolerance") {
    return "Risk tolerance is a behavioral hint that the runtime records but does not deterministically enforce.";
  }
  if (ruleId === "execution_bias") {
    return "Execution bias informs future planning surfaces, but v1 does not hard-govern model behavior with it.";
  }
  return "Cost sensitivity is inspectable policy metadata, but v1 does not meter every hosted or host-local cost surface.";
};

export const evaluateContinuityPolicyForHost = (
  policy: ContinuityPolicy,
  capabilities: ContinuityPolicyHostCapabilities
): ContinuityPolicyHostReport => {
  const rules = CONTINUITY_POLICY_RULE_IDS.map((ruleId) => {
    const requested = policy.enforcement[ruleId];
    const effective = downgradeEnforcement(requested, maxSupportedEnforcementForRule(ruleId, capabilities));
    return {
      ruleId,
      requested,
      effective,
      honored: requested === effective,
      reason: hostRuleReason(ruleId, capabilities, effective),
    } satisfies ContinuityPolicyRuleEvaluation;
  });

  const unresolvedConflicts = rules
    .filter((rule) => !rule.honored)
    .map((rule) => ({
      scope: "rule",
      host: capabilities.host,
      id: rule.ruleId,
      requested: rule.requested,
      effective: rule.effective,
      reason: rule.reason,
    }) satisfies ContinuityPolicyConflict);

  const notes = [
    capabilities.automationHealthy
      ? `${capabilities.host} automation is attached and can honor runtime-managed lifecycle rules.`
      : `${capabilities.host} automation is degraded or missing; onlybotsd can only govern events that still arrive.`,
  ];
  if (!capabilities.canInterceptToolUse) {
    notes.push(`${capabilities.host} cannot claim hard tool approval enforcement in v1.`);
  }
  if (!capabilities.canRestrictSelfModification) {
    notes.push(`${capabilities.host} cannot claim hard self-modification enforcement in v1.`);
  }

  return {
    host: capabilities.host,
    automationHealthy: capabilities.automationHealthy,
    degraded: unresolvedConflicts.some((conflict) => conflict.requested !== conflict.effective),
    summary: summarizeRules(rules),
    rules,
    unresolvedConflicts,
    notes,
  };
};

export const evaluateContinuityAuthority = (
  policy: ContinuityPolicy
): { authority: ContinuityPolicyAuthorityEvaluation[]; conflicts: ContinuityPolicyConflict[] } => {
  const authority: ContinuityPolicyAuthorityEvaluation[] = [
    {
      tier: "hot_memory",
      requestedMode: policy.authority.hotMemory,
      effectiveMode: policy.authority.hotMemory === "authoritative_local" ? "authoritative_local" : "authoritative_local",
      honored: policy.authority.hotMemory === "authoritative_local",
      owner: "local_runtime",
      reason: "Hot memory is a local-authoritative overlay for the active runtime session.",
    },
    {
      tier: "warm_memory",
      requestedMode: policy.authority.warmMemory,
      effectiveMode: "authoritative_remote",
      honored: policy.authority.warmMemory === "authoritative_remote",
      owner: "hosted_api",
      reason: "Warm memory remains remote-authoritative so server dedupe, supersession, and moderation stay canonical.",
    },
    {
      tier: "cold_memory",
      requestedMode: policy.authority.coldMemory,
      effectiveMode: "merge",
      honored: policy.authority.coldMemory === "merge",
      owner: "append_only_evidence",
      reason: "Cold memory is append-only evidence, so concurrent writes compose as merge-style accumulation.",
    },
    {
      tier: "runtime_overlay",
      requestedMode: policy.authority.runtimeOverlay,
      effectiveMode: "ephemeral_overlay",
      honored: policy.authority.runtimeOverlay === "ephemeral_overlay",
      owner: "ephemeral_local",
      reason: "Runtime overlays are local scratch state until they are promoted or discarded.",
    },
  ];

  const conflicts = authority
    .filter((entry) => !entry.honored)
    .map((entry) => ({
      scope: "authority",
      host: "global",
      id: entry.tier,
      requested: entry.requestedMode,
      effective: entry.effectiveMode,
      reason: entry.reason,
    }) satisfies ContinuityPolicyConflict);

  return { authority, conflicts };
};

export const inspectContinuityPolicy = (input: {
  source: ContinuityPolicySource;
  policy: ContinuityPolicy;
  validationErrors?: string[];
  hosts?: ContinuityPolicyHostCapabilities[];
}): ContinuityPolicyInspection => {
  const sharedRuntime = evaluateContinuityPolicyForHost(input.policy, {
    host: "runtime",
    automationHealthy: true,
    runtimeControlsMemory: true,
    canEnforceTrustZones: false,
    canInterceptToolUse: false,
    canRestrictSelfModification: false,
    canRequireHumanReview: false,
    canEnforceBudgetCeilings: true,
  });
  const hosts = (input.hosts ?? []).map((host) => evaluateContinuityPolicyForHost(input.policy, host));
  const authorityInspection = evaluateContinuityAuthority(input.policy);
  const validationErrors = input.validationErrors ?? [];
  const unresolvedConflicts = [
    ...authorityInspection.conflicts,
    ...sharedRuntime.unresolvedConflicts,
    ...hosts.flatMap((host) => host.unresolvedConflicts),
    ...validationErrors.map((error, index) => ({
      scope: "rule",
      host: "global",
      id: `validation_${index + 1}`,
      requested: "valid_policy",
      effective: "fallback_default",
      reason: error,
    }) satisfies ContinuityPolicyConflict),
  ];

  return {
    source: input.source,
    validationErrors,
    policy: input.policy,
    sharedRuntime,
    hosts,
    authority: authorityInspection.authority,
    unresolvedConflicts,
    degraded: unresolvedConflicts.length > 0,
  };
};

export const automaticHotWritesEnabled = (policy: ContinuityPolicy): boolean => policy.memory.hotWriteMode === "debounced";

export const automaticWarmCommitDecision = (
  policy: ContinuityPolicy,
  input: {
    explicit: boolean;
    explicitApproval: boolean;
    autoModeEnabled: boolean;
    candidateConfidence: number;
    committedCount: number;
  }
): { commit: boolean; reason: string } => {
  if (input.explicit || input.explicitApproval) {
    return {
      commit: true,
      reason: "Continuity policy allows explicit or operator-approved durable writes immediately.",
    };
  }
  if (!input.autoModeEnabled) {
    return {
      commit: false,
      reason: "Automatic warm promotion is disabled by the current memory mode.",
    };
  }
  if (policy.memory.writeThreshold !== "auto") {
    return {
      commit: false,
      reason: `Continuity policy requires ${policy.memory.writeThreshold} durable write posture before automatic warm commits.`,
    };
  }
  if (input.committedCount >= policy.governance.budgetCeilings.maxWarmWritesPerTurn) {
    return {
      commit: false,
      reason: `Continuity policy capped automatic warm commits at ${policy.governance.budgetCeilings.maxWarmWritesPerTurn} for this event.`,
    };
  }
  if (input.candidateConfidence < policy.memory.warmPromotionSensitivity) {
    return {
      commit: false,
      reason: `Candidate confidence ${input.candidateConfidence.toFixed(2)} is below the continuity policy threshold ${policy.memory.warmPromotionSensitivity.toFixed(2)}.`,
    };
  }
  return {
    commit: true,
    reason: "Continuity policy allows automatic warm promotion for this candidate.",
  };
};

export const automaticColdBatchDecision = (
  policy: ContinuityPolicy,
  input: {
    explicitApproval: boolean;
    autoModeEnabled: boolean;
    itemCount: number;
  }
): { allowed: boolean; reason: string; maxItems: number } => {
  const maxItems = Math.max(0, policy.governance.budgetCeilings.maxColdItemsPerBatch);
  if (maxItems === 0) {
    return {
      allowed: false,
      reason: "Continuity policy disabled automatic cold-memory batching.",
      maxItems,
    };
  }
  if (input.explicitApproval) {
    return {
      allowed: true,
      reason: "Continuity policy allows operator-approved cold-memory batching.",
      maxItems,
    };
  }
  if (!input.autoModeEnabled) {
    return {
      allowed: false,
      reason: "Automatic cold-memory batching is disabled by the current memory mode.",
      maxItems,
    };
  }
  if (policy.memory.writeThreshold !== "auto") {
    return {
      allowed: false,
      reason: `Continuity policy requires ${policy.memory.writeThreshold} durable write posture before cold-memory batching.`,
      maxItems,
    };
  }
  return {
    allowed: input.itemCount > 0,
    reason: "Continuity policy allows automatic cold-memory batching.",
    maxItems,
  };
};
