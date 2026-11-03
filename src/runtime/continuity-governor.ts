import { randomUUID } from "crypto";

import {
  CONTINUITY_HUMAN_REVIEW_GATES,
  CONTINUITY_MEMORY_WRITE_THRESHOLDS,
  CONTINUITY_SELF_MODIFICATION_MODES,
  CONTINUITY_TOOL_APPROVAL_MODES,
  resolveContinuityPolicy,
  type ContinuityHumanReviewGate,
  type ContinuityMemoryWriteThreshold,
  type ContinuityPolicy,
  type ContinuityPolicyEnforcementClass,
  type ContinuityPolicyRuleId,
  type ContinuitySelfModificationMode,
  type ContinuityToolApprovalMode,
} from "./continuity-policy";

export const CONTINUITY_GOVERNOR_PATCH_SCHEMA_VERSION = "continuity_governor_patch_v1";
export const CONTINUITY_GOVERNOR_PATCH_TYPES = ["pause", "budget_ceiling", "review_gate", "memory_scope"] as const;

export type ContinuityGovernorPatchType = (typeof CONTINUITY_GOVERNOR_PATCH_TYPES)[number];
export type ContinuityGovernorPatchStatus = "active" | "removed" | "rejected";

export type ContinuityGovernorMemoryScope = {
  includeHotMemory: boolean;
  includeWarmMemory: boolean;
  includeColdMemory: boolean;
  includeLayeredContext: boolean;
};

export type ContinuityGovernorPatchPayload =
  | {
      pause: {
        message: string | null;
      };
      budgetCeiling?: never;
      reviewGate?: never;
      memoryScope?: never;
    }
  | {
      pause?: never;
      budgetCeiling: {
        maxBudgetSats?: number;
        maxWarmWritesPerTurn?: number;
        maxColdItemsPerBatch?: number;
      };
      reviewGate?: never;
      memoryScope?: never;
    }
  | {
      pause?: never;
      budgetCeiling?: never;
      reviewGate: {
        requireReviewFor: ContinuityHumanReviewGate[];
        toolApprovalMode: ContinuityToolApprovalMode | null;
        selfModificationMode: ContinuitySelfModificationMode | null;
        writeThreshold: ContinuityMemoryWriteThreshold | null;
      };
      memoryScope?: never;
    }
  | {
      pause?: never;
      budgetCeiling?: never;
      reviewGate?: never;
      memoryScope: Partial<ContinuityGovernorMemoryScope>;
    };

export type ContinuityGovernorPatchRecord = {
  patchId: string;
  schemaVersion: typeof CONTINUITY_GOVERNOR_PATCH_SCHEMA_VERSION;
  patchType: ContinuityGovernorPatchType;
  actor: string;
  reason: string | null;
  createdAt: string;
  status: ContinuityGovernorPatchStatus;
  degraded: boolean;
  acceptance: {
    accepted: boolean;
    reasons: string[];
  };
  payload: ContinuityGovernorPatchPayload;
  removedAt: string | null;
  removedReason: string | null;
};

export type ContinuityGovernorMergeSemantics = {
  ordering: "createdAt_then_patchId";
  pause: "any_active";
  budgetCeiling: "minimum";
  reviewGate: "union_plus_strictest";
  memoryScope: "restrictive_and";
};

export type ContinuityGovernorState = {
  paused: boolean;
  pauseReasons: string[];
  memoryScope: ContinuityGovernorMemoryScope;
  effectivePolicy: ContinuityPolicy;
  activePatches: ContinuityGovernorPatchRecord[];
  patchHistory: ContinuityGovernorPatchRecord[];
  mergeSemantics: ContinuityGovernorMergeSemantics;
};

export class ContinuityGovernorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuityGovernorValidationError";
  }
}

const PATCH_TYPE_SET = new Set<ContinuityGovernorPatchType>(CONTINUITY_GOVERNOR_PATCH_TYPES);
const REVIEW_GATE_SET = new Set<ContinuityHumanReviewGate>(CONTINUITY_HUMAN_REVIEW_GATES);
const WRITE_THRESHOLD_SET = new Set<ContinuityMemoryWriteThreshold>(CONTINUITY_MEMORY_WRITE_THRESHOLDS);
const TOOL_APPROVAL_SET = new Set<ContinuityToolApprovalMode>(CONTINUITY_TOOL_APPROVAL_MODES);
const SELF_MODIFICATION_SET = new Set<ContinuitySelfModificationMode>(CONTINUITY_SELF_MODIFICATION_MODES);

const MEMORY_SCOPE_DEFAULTS: ContinuityGovernorMemoryScope = {
  includeHotMemory: true,
  includeWarmMemory: true,
  includeColdMemory: true,
  includeLayeredContext: true,
};

const MERGE_SEMANTICS: ContinuityGovernorMergeSemantics = {
  ordering: "createdAt_then_patchId",
  pause: "any_active",
  budgetCeiling: "minimum",
  reviewGate: "union_plus_strictest",
  memoryScope: "restrictive_and",
};

const WRITE_THRESHOLD_RANK: Record<ContinuityMemoryWriteThreshold, number> = {
  explicit_only: 0,
  proposal_first: 1,
  auto: 2,
};

const TOOL_APPROVAL_RANK: Record<ContinuityToolApprovalMode, number> = {
  operator_confirmed: 0,
  trusted_only: 1,
  host_default: 2,
};

const SELF_MODIFICATION_RANK: Record<ContinuitySelfModificationMode, number> = {
  disallowed: 0,
  review_required: 1,
  workspace_only: 2,
};

const ENFORCEMENT_RANK: Record<ContinuityPolicyEnforcementClass, number> = {
  advisory: 0,
  best_effort: 1,
  enforced: 2,
};

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

const requireString = (value: unknown, fieldName: string, allowEmpty = false): string => {
  if (typeof value !== "string") {
    throw new ContinuityGovernorValidationError(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) {
    throw new ContinuityGovernorValidationError(`${fieldName} must not be empty`);
  }
  return trimmed;
};

const optionalString = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return requireString(value, "value");
};

const optionalNamedString = (value: unknown, fieldName: string, allowEmpty = false): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return requireString(value, fieldName, allowEmpty);
};

const optionalTimestamp = (value: unknown, fieldName: string): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return requireString(value, fieldName);
};

const optionalInteger = (value: unknown, fieldName: string): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ContinuityGovernorValidationError(`${fieldName} must be an integer >= 0`);
  }
  return value as number;
};

const optionalBoolean = (value: unknown, fieldName: string): boolean | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ContinuityGovernorValidationError(`${fieldName} must be a boolean`);
  }
  return value;
};

const normalizeEnum = <T extends string>(value: unknown, accepted: Set<T>, fieldName: string): T => {
  if (typeof value !== "string" || !accepted.has(value as T)) {
    throw new ContinuityGovernorValidationError(`${fieldName} must be one of: ${Array.from(accepted).join(", ")}`);
  }
  return value as T;
};

const normalizeReviewGateList = (value: unknown, fieldName: string): ContinuityHumanReviewGate[] => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ContinuityGovernorValidationError(`${fieldName} must be an array`);
  }
  return value.map((entry, index) => normalizeEnum(entry, REVIEW_GATE_SET, `${fieldName}[${index}]`));
};

const clonePolicy = (policy: ContinuityPolicy): ContinuityPolicy => resolveContinuityPolicy(JSON.parse(JSON.stringify(policy)));

const maxEnforcement = (
  left: ContinuityPolicyEnforcementClass,
  right: ContinuityPolicyEnforcementClass
): ContinuityPolicyEnforcementClass => (ENFORCEMENT_RANK[left] >= ENFORCEMENT_RANK[right] ? left : right);

const stricterWriteThreshold = (
  left: ContinuityMemoryWriteThreshold,
  right: ContinuityMemoryWriteThreshold
): ContinuityMemoryWriteThreshold => (WRITE_THRESHOLD_RANK[left] <= WRITE_THRESHOLD_RANK[right] ? left : right);

const stricterToolApproval = (
  left: ContinuityToolApprovalMode,
  right: ContinuityToolApprovalMode
): ContinuityToolApprovalMode => (TOOL_APPROVAL_RANK[left] <= TOOL_APPROVAL_RANK[right] ? left : right);

const stricterSelfModification = (
  left: ContinuitySelfModificationMode,
  right: ContinuitySelfModificationMode
): ContinuitySelfModificationMode => (SELF_MODIFICATION_RANK[left] <= SELF_MODIFICATION_RANK[right] ? left : right);

const normalizePatchPayload = (
  patchType: ContinuityGovernorPatchType,
  root: Record<string, unknown>
): ContinuityGovernorPatchPayload => {
  if (patchType === "pause") {
    const pause = asRecord(readKey(root, "pause"));
    return {
      pause: {
        message: optionalString(readKey(pause, "message")),
      },
    };
  }

  if (patchType === "budget_ceiling") {
    const budget = asRecord(readKey(root, "budgetCeiling", "budget_ceiling"));
    const payload = {
      maxBudgetSats: optionalInteger(readKey(budget, "maxBudgetSats", "max_budget_sats"), "budgetCeiling.maxBudgetSats"),
      maxWarmWritesPerTurn: optionalInteger(
        readKey(budget, "maxWarmWritesPerTurn", "max_warm_writes_per_turn"),
        "budgetCeiling.maxWarmWritesPerTurn"
      ),
      maxColdItemsPerBatch: optionalInteger(
        readKey(budget, "maxColdItemsPerBatch", "max_cold_items_per_batch"),
        "budgetCeiling.maxColdItemsPerBatch"
      ),
    };
    if (
      payload.maxBudgetSats === undefined &&
      payload.maxWarmWritesPerTurn === undefined &&
      payload.maxColdItemsPerBatch === undefined
    ) {
      throw new ContinuityGovernorValidationError("budget_ceiling patch requires at least one ceiling field");
    }
    return {
      budgetCeiling: payload,
    };
  }

  if (patchType === "review_gate") {
    const review = asRecord(readKey(root, "reviewGate", "review_gate"));
    const requireReviewFor = normalizeReviewGateList(
      readKey(review, "requireReviewFor", "require_review_for"),
      "reviewGate.requireReviewFor"
    );
    const toolApprovalMode =
      readKey(review, "toolApprovalMode", "tool_approval_mode") === undefined
        ? null
        : normalizeEnum(readKey(review, "toolApprovalMode", "tool_approval_mode"), TOOL_APPROVAL_SET, "reviewGate.toolApprovalMode");
    const selfModificationMode =
      readKey(review, "selfModificationMode", "self_modification_mode") === undefined
        ? null
        : normalizeEnum(
            readKey(review, "selfModificationMode", "self_modification_mode"),
            SELF_MODIFICATION_SET,
            "reviewGate.selfModificationMode"
          );
    const writeThreshold =
      readKey(review, "writeThreshold", "write_threshold") === undefined
        ? null
        : normalizeEnum(readKey(review, "writeThreshold", "write_threshold"), WRITE_THRESHOLD_SET, "reviewGate.writeThreshold");

    if (
      requireReviewFor.length === 0 &&
      toolApprovalMode === null &&
      selfModificationMode === null &&
      writeThreshold === null
    ) {
      throw new ContinuityGovernorValidationError("review_gate patch requires at least one review-related field");
    }
    return {
      reviewGate: {
        requireReviewFor,
        toolApprovalMode,
        selfModificationMode,
        writeThreshold,
      },
    };
  }

  const memoryScope = asRecord(readKey(root, "memoryScope", "memory_scope"));
  const payload: Partial<ContinuityGovernorMemoryScope> = {
    includeHotMemory: optionalBoolean(readKey(memoryScope, "includeHotMemory", "include_hot_memory"), "memoryScope.includeHotMemory"),
    includeWarmMemory: optionalBoolean(
      readKey(memoryScope, "includeWarmMemory", "include_warm_memory"),
      "memoryScope.includeWarmMemory"
    ),
    includeColdMemory: optionalBoolean(
      readKey(memoryScope, "includeColdMemory", "include_cold_memory"),
      "memoryScope.includeColdMemory"
    ),
    includeLayeredContext: optionalBoolean(
      readKey(memoryScope, "includeLayeredContext", "include_layered_context"),
      "memoryScope.includeLayeredContext"
    ),
  };
  if (
    payload.includeHotMemory === undefined &&
    payload.includeWarmMemory === undefined &&
    payload.includeColdMemory === undefined &&
    payload.includeLayeredContext === undefined
  ) {
    throw new ContinuityGovernorValidationError("memory_scope patch requires at least one scope field");
  }
  return {
    memoryScope: payload,
  };
};

const normalizeStoredPatchRecord = (value: unknown, fieldName: string): ContinuityGovernorPatchRecord => {
  const root = asRecord(value);
  if (!root) {
    throw new ContinuityGovernorValidationError(`${fieldName} must be an object`);
  }

  const schemaVersion = requireString(readKey(root, "schemaVersion", "schema_version"), `${fieldName}.schemaVersion`);
  if (schemaVersion !== CONTINUITY_GOVERNOR_PATCH_SCHEMA_VERSION) {
    throw new ContinuityGovernorValidationError(
      `${fieldName}.schemaVersion must be ${CONTINUITY_GOVERNOR_PATCH_SCHEMA_VERSION}`
    );
  }

  const status = requireString(readKey(root, "status"), `${fieldName}.status`);
  if (status !== "active" && status !== "removed" && status !== "rejected") {
    throw new ContinuityGovernorValidationError(`${fieldName}.status must be one of: active, removed, rejected`);
  }

  const acceptance = asRecord(readKey(root, "acceptance"));
  if (!acceptance) {
    throw new ContinuityGovernorValidationError(`${fieldName}.acceptance must be an object`);
  }
  const acceptanceReasons = readKey(acceptance, "reasons");
  if (!Array.isArray(acceptanceReasons) || !acceptanceReasons.every((entry) => typeof entry === "string")) {
    throw new ContinuityGovernorValidationError(`${fieldName}.acceptance.reasons must be an array of strings`);
  }

  const patchType = normalizeEnum(readKey(root, "patchType", "patch_type"), PATCH_TYPE_SET, `${fieldName}.patchType`);
  const payload = normalizePatchPayload(patchType, asRecord(readKey(root, "payload")) ?? root);

  return {
    patchId: requireString(readKey(root, "patchId", "patch_id"), `${fieldName}.patchId`),
    schemaVersion: CONTINUITY_GOVERNOR_PATCH_SCHEMA_VERSION,
    patchType,
    actor: requireString(readKey(root, "actor"), `${fieldName}.actor`),
    reason: optionalNamedString(readKey(root, "reason"), `${fieldName}.reason`, true),
    createdAt: requireString(readKey(root, "createdAt", "created_at"), `${fieldName}.createdAt`),
    status,
    degraded: optionalBoolean(readKey(root, "degraded"), `${fieldName}.degraded`) ?? false,
    acceptance: {
      accepted:
        typeof readKey(acceptance, "accepted") === "boolean"
          ? (readKey(acceptance, "accepted") as boolean)
          : (() => {
              throw new ContinuityGovernorValidationError(`${fieldName}.acceptance.accepted must be a boolean`);
            })(),
      reasons: acceptanceReasons as string[],
    },
    payload,
    removedAt: optionalTimestamp(readKey(root, "removedAt", "removed_at"), `${fieldName}.removedAt`),
    removedReason: optionalNamedString(
      readKey(root, "removedReason", "removed_reason"),
      `${fieldName}.removedReason`,
      true
    ),
  };
};

export const resolveContinuityGovernorPatchHistory = (value: unknown): ContinuityGovernorPatchRecord[] => {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ContinuityGovernorValidationError("governor patch history must be an array");
  }
  return value.map((entry, index) => normalizeStoredPatchRecord(entry, `patchHistory[${index}]`));
};

export const continuityGovernorPatchAffectedRuleIds = (
  patch: ContinuityGovernorPatchRecord
): ContinuityPolicyRuleId[] => {
  if (patch.patchType === "budget_ceiling" && "budgetCeiling" in patch.payload) {
    return ["budget_ceilings"];
  }

  if (patch.patchType !== "review_gate" || !("reviewGate" in patch.payload) || !patch.payload.reviewGate) {
    return [];
  }

  const affected: ContinuityPolicyRuleId[] = ["memory_write_threshold", "human_review_gates"];
  if (patch.payload.reviewGate.toolApprovalMode) {
    affected.push("tool_approval");
  }
  if (patch.payload.reviewGate.selfModificationMode) {
    affected.push("self_modification");
  }
  return affected;
};

const buildPatchRecord = (input: {
  patchType: ContinuityGovernorPatchType;
  actor: string;
  reason: string | null;
  createdAt: string;
  payload: ContinuityGovernorPatchPayload;
  accepted: boolean;
  reasons: string[];
  status: ContinuityGovernorPatchStatus;
}): ContinuityGovernorPatchRecord => ({
  patchId: `cgp_${randomUUID()}`,
  schemaVersion: CONTINUITY_GOVERNOR_PATCH_SCHEMA_VERSION,
  patchType: input.patchType,
  actor: input.actor,
  reason: input.reason,
  createdAt: input.createdAt,
  status: input.status,
  degraded: false,
  acceptance: {
    accepted: input.accepted,
    reasons: input.reasons,
  },
  payload: input.payload,
  removedAt: null,
  removedReason: null,
});

export const applyContinuityGovernorPatch = (
  basePolicy: ContinuityPolicy,
  patchHistory: ContinuityGovernorPatchRecord[],
  input: unknown,
  now: Date = new Date()
): { patch: ContinuityGovernorPatchRecord; state: ContinuityGovernorState } => {
  const root = asRecord(input);
  if (!root) {
    const rejected = buildPatchRecord({
      patchType: "pause",
      actor: "operator",
      reason: null,
      createdAt: now.toISOString(),
      payload: { pause: { message: null } },
      accepted: false,
      reasons: ["governor patch body must be an object"],
      status: "rejected",
    });
    return {
      patch: rejected,
      state: buildContinuityGovernorState(basePolicy, [...patchHistory, rejected], now),
    };
  }

  try {
    const patchType = normalizeEnum(
      readKey(root, "patchType", "patch_type"),
      PATCH_TYPE_SET,
      "patchType"
    );
    const actor = requireString(readKey(root, "actor") ?? "operator", "actor");
    const reason = readKey(root, "reason") === undefined ? null : requireString(readKey(root, "reason"), "reason", true);
    const payload = normalizePatchPayload(patchType, root);
    const patch = buildPatchRecord({
      patchType,
      actor,
      reason,
      createdAt: now.toISOString(),
      payload,
      accepted: true,
      reasons: ["patch accepted"],
      status: "active",
    });
    return {
      patch,
      state: buildContinuityGovernorState(basePolicy, [...patchHistory, patch], now),
    };
  } catch (error) {
    const rejected = buildPatchRecord({
      patchType: "pause",
      actor: typeof readKey(root, "actor") === "string" ? String(readKey(root, "actor")) : "operator",
      reason: typeof readKey(root, "reason") === "string" ? String(readKey(root, "reason")) : null,
      createdAt: now.toISOString(),
      payload: { pause: { message: null } },
      accepted: false,
      reasons: [error instanceof Error ? error.message : String(error)],
      status: "rejected",
    });
    return {
      patch: rejected,
      state: buildContinuityGovernorState(basePolicy, [...patchHistory, rejected], now),
    };
  }
};

export const removeContinuityGovernorPatch = (
  basePolicy: ContinuityPolicy,
  patchHistory: ContinuityGovernorPatchRecord[],
  patchId: string,
  removedReason: string | null = null,
  now: Date = new Date()
): { patch: ContinuityGovernorPatchRecord; state: ContinuityGovernorState } => {
  const target = patchHistory.find((patch) => patch.patchId === patchId);
  if (!target) {
    throw new ContinuityGovernorValidationError(`Unknown governor patch: ${patchId}`);
  }
  if (target.status !== "active") {
    throw new ContinuityGovernorValidationError(`Governor patch ${patchId} is not active`);
  }

  const updatedHistory = patchHistory.map((patch) =>
    patch.patchId === patchId
      ? {
          ...patch,
          status: "removed" as const,
          removedAt: now.toISOString(),
          removedReason,
        }
      : patch
  );
  const updatedPatch = updatedHistory.find((patch) => patch.patchId === patchId)!;
  return {
    patch: updatedPatch,
    state: buildContinuityGovernorState(basePolicy, updatedHistory, now),
  };
};

export const buildContinuityGovernorState = (
  basePolicy: ContinuityPolicy,
  patchHistory: ContinuityGovernorPatchRecord[],
  _now: Date = new Date()
): ContinuityGovernorState => {
  const effectivePolicy = clonePolicy(basePolicy);
  const memoryScope: ContinuityGovernorMemoryScope = { ...MEMORY_SCOPE_DEFAULTS };
  const activePatches = [...patchHistory]
    .filter((patch) => patch.status === "active")
    .sort((left, right) => {
      const createdAt = left.createdAt.localeCompare(right.createdAt);
      return createdAt !== 0 ? createdAt : left.patchId.localeCompare(right.patchId);
    });
  const pauseReasons: string[] = [];

  for (const patch of activePatches) {
    if ("pause" in patch.payload && patch.payload.pause) {
      pauseReasons.push(patch.payload.pause.message ?? patch.reason ?? patch.patchId);
      continue;
    }
    if ("budgetCeiling" in patch.payload && patch.payload.budgetCeiling) {
      const payload = patch.payload.budgetCeiling;
      if (payload.maxBudgetSats !== undefined) {
        effectivePolicy.governance.budgetCeilings.maxBudgetSats = Math.min(
          effectivePolicy.governance.budgetCeilings.maxBudgetSats,
          payload.maxBudgetSats
        );
      }
      if (payload.maxWarmWritesPerTurn !== undefined) {
        effectivePolicy.governance.budgetCeilings.maxWarmWritesPerTurn = Math.min(
          effectivePolicy.governance.budgetCeilings.maxWarmWritesPerTurn,
          payload.maxWarmWritesPerTurn
        );
      }
      if (payload.maxColdItemsPerBatch !== undefined) {
        effectivePolicy.governance.budgetCeilings.maxColdItemsPerBatch = Math.min(
          effectivePolicy.governance.budgetCeilings.maxColdItemsPerBatch,
          payload.maxColdItemsPerBatch
        );
      }
      continue;
    }
    if ("reviewGate" in patch.payload && patch.payload.reviewGate) {
      const payload = patch.payload.reviewGate;
      effectivePolicy.governance.requireReviewFor = Array.from(
        new Set([...effectivePolicy.governance.requireReviewFor, ...payload.requireReviewFor])
      );
      effectivePolicy.enforcement.human_review_gates = maxEnforcement(
        effectivePolicy.enforcement.human_review_gates,
        "best_effort"
      );
      effectivePolicy.memory.writeThreshold = stricterWriteThreshold(
        effectivePolicy.memory.writeThreshold,
        payload.writeThreshold ?? "proposal_first"
      );
      if (payload.toolApprovalMode) {
        effectivePolicy.governance.toolApprovalMode = stricterToolApproval(
          effectivePolicy.governance.toolApprovalMode,
          payload.toolApprovalMode
        );
        effectivePolicy.enforcement.tool_approval = maxEnforcement(effectivePolicy.enforcement.tool_approval, "best_effort");
      }
      if (payload.selfModificationMode) {
        effectivePolicy.governance.selfModificationMode = stricterSelfModification(
          effectivePolicy.governance.selfModificationMode,
          payload.selfModificationMode
        );
        effectivePolicy.enforcement.self_modification = maxEnforcement(
          effectivePolicy.enforcement.self_modification,
          "best_effort"
        );
      }
      continue;
    }
    if ("memoryScope" in patch.payload && patch.payload.memoryScope) {
      const payload = patch.payload.memoryScope;
      if (payload.includeHotMemory !== undefined) {
        memoryScope.includeHotMemory = memoryScope.includeHotMemory && payload.includeHotMemory;
      }
      if (payload.includeWarmMemory !== undefined) {
        memoryScope.includeWarmMemory = memoryScope.includeWarmMemory && payload.includeWarmMemory;
      }
      if (payload.includeColdMemory !== undefined) {
        memoryScope.includeColdMemory = memoryScope.includeColdMemory && payload.includeColdMemory;
      }
      if (payload.includeLayeredContext !== undefined) {
        memoryScope.includeLayeredContext = memoryScope.includeLayeredContext && payload.includeLayeredContext;
      }
    }
  }

  return {
    paused: pauseReasons.length > 0,
    pauseReasons,
    memoryScope,
    effectivePolicy,
    activePatches,
    patchHistory,
    mergeSemantics: MERGE_SEMANTICS,
  };
};
