import { IsoDateString, Npub } from "./base";

export const COLLABORATION_CONTEXT_SCHEMA_VERSION = "collaboration_context_v1";
export const TYPED_INBOX_EVENT_SCHEMA_VERSION = "typed_inbox_event_v1";
export const COLLABORATION_MESSAGE_ENVELOPE_SCHEMA_VERSION = "collaboration_message_envelope_v1";

export const COLLABORATION_MESSAGE_TYPES = ["chat", "inbox_event"] as const;
export const COLLABORATION_CONTEXT_TRUST_ZONES = [
  "public",
  "network_trusted",
  "workspace_private",
  "agent_sealed",
  "human_visible",
  "machine_only",
  "ephemeral",
  "auditable",
] as const;
export const COLLABORATION_PARTICIPANT_ROLES = [
  "originator",
  "owner",
  "assignee",
  "reviewer",
  "operator",
  "observer",
] as const;
export const COLLABORATION_EVENT_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const COLLABORATION_TASK_STATUSES = [
  "offered",
  "claimed",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "aborted",
] as const;
export const TYPED_INBOX_EVENT_TYPES = [
  "assignment",
  "claim",
  "ack",
  "reject",
  "completion",
  "failure",
  "handoff_created",
  "handoff_completed",
  "operator_governance",
] as const;
export const COLLABORATION_CLAIM_STATES = ["accepted", "tentative"] as const;
export const COLLABORATION_HANDOFF_COMPLETION_STATES = ["accepted", "completed", "corrected"] as const;
export const COLLABORATION_GOVERNANCE_ACTIONS = [
  "pause_context",
  "budget_ceiling_change",
  "tool_restriction",
  "memory_scope_change",
  "participant_removal",
] as const;

export type CollaborationMessageType = (typeof COLLABORATION_MESSAGE_TYPES)[number];
export type CollaborationContextTrustZone = (typeof COLLABORATION_CONTEXT_TRUST_ZONES)[number];
export type CollaborationParticipantRole = (typeof COLLABORATION_PARTICIPANT_ROLES)[number];
export type CollaborationEventPriority = (typeof COLLABORATION_EVENT_PRIORITIES)[number];
export type CollaborationTaskStatus = (typeof COLLABORATION_TASK_STATUSES)[number];
export type TypedInboxEventType = (typeof TYPED_INBOX_EVENT_TYPES)[number];
export type CollaborationClaimState = (typeof COLLABORATION_CLAIM_STATES)[number];
export type CollaborationHandoffCompletionState = (typeof COLLABORATION_HANDOFF_COMPLETION_STATES)[number];
export type CollaborationGovernanceAction = (typeof COLLABORATION_GOVERNANCE_ACTIONS)[number];

export type CollaborationParticipant = {
  npub: Npub;
  agentId: string | null;
  runtimeHost: string | null;
  role: CollaborationParticipantRole;
  displayName: string | null;
};

export type CollaborationContextPolicy = {
  primaryTrustZone: CollaborationContextTrustZone;
  additionalTrustZones: CollaborationContextTrustZone[];
  memoryScope: string[];
  requireReviewFor: string[];
  toolRestrictions: string[];
  operatorMayPause: true;
};

export type CollaborationContextBudget = {
  currency: "sats";
  maxBudgetSats: number | null;
  shadowMode: boolean;
};

export type CollaborationTaskOwnership = {
  taskRef: string;
  title: string;
  ownerNpub: Npub | null;
  claimedByNpub: Npub | null;
  status: CollaborationTaskStatus;
  workspaceRef: string | null;
};

export type CollaborationContextMetadata = {
  schemaVersion: typeof COLLABORATION_CONTEXT_SCHEMA_VERSION;
  contextId: string;
  title: string;
  createdAt: IsoDateString;
  createdBy: Npub;
  participants: CollaborationParticipant[];
  policy: CollaborationContextPolicy;
  budget: CollaborationContextBudget;
  taskOwnership: CollaborationTaskOwnership;
  artifactRefs: string[];
  handoffRefs: string[];
  outcomeRefs: string[];
  notes: string[];
};

export type CollaborationActorRef = {
  npub: Npub;
  agentId: string | null;
  runtimeHost: string | null;
  role: CollaborationParticipantRole | null;
};

type TypedInboxEventBase = {
  schemaVersion: typeof TYPED_INBOX_EVENT_SCHEMA_VERSION;
  eventId: string;
  eventType: TypedInboxEventType;
  contextId: string;
  summary: string;
  priority: CollaborationEventPriority;
  createdAt: IsoDateString;
  actor: CollaborationActorRef;
  taskRef: string | null;
  artifactRefs: string[];
  handoffRefs: string[];
  outcomeRefs: string[];
};

export type AssignmentInboxEvent = TypedInboxEventBase & {
  eventType: "assignment";
  assignment: {
    assigneeNpub: Npub;
    dueAt: IsoDateString | null;
    claimExpiresAt: IsoDateString | null;
  };
};

export type ClaimInboxEvent = TypedInboxEventBase & {
  eventType: "claim";
  claim: {
    claimedByNpub: Npub;
    state: CollaborationClaimState;
    note: string | null;
  };
};

export type AckInboxEvent = TypedInboxEventBase & {
  eventType: "ack";
  ack: {
    acknowledgedEventId: string;
    note: string | null;
  };
};

export type RejectInboxEvent = TypedInboxEventBase & {
  eventType: "reject";
  reject: {
    rejectedEventId: string;
    reason: string;
  };
};

export type CompletionInboxEvent = TypedInboxEventBase & {
  eventType: "completion";
  completion: {
    resultSummary: string;
    deliveredArtifactRefs: string[];
  };
};

export type FailureInboxEvent = TypedInboxEventBase & {
  eventType: "failure";
  failure: {
    failureCode: string;
    retryable: boolean;
    reason: string;
  };
};

export type HandoffCreatedInboxEvent = TypedInboxEventBase & {
  eventType: "handoff_created";
  handoffCreated: {
    handoffId: string;
    targetRuntimeHost: string | null;
  };
};

export type HandoffCompletedInboxEvent = TypedInboxEventBase & {
  eventType: "handoff_completed";
  handoffCompleted: {
    handoffId: string;
    completionState: CollaborationHandoffCompletionState;
    outcomeRef: string | null;
  };
};

export type OperatorGovernanceInboxEvent = TypedInboxEventBase & {
  eventType: "operator_governance";
  operatorGovernance: {
    action: CollaborationGovernanceAction;
    note: string;
    affectedParticipantNpub: Npub | null;
  };
};

export type TypedInboxEvent =
  | AssignmentInboxEvent
  | ClaimInboxEvent
  | AckInboxEvent
  | RejectInboxEvent
  | CompletionInboxEvent
  | FailureInboxEvent
  | HandoffCreatedInboxEvent
  | HandoffCompletedInboxEvent
  | OperatorGovernanceInboxEvent;

export type CollaborationMessageEnvelope = {
  schemaVersion: typeof COLLABORATION_MESSAGE_ENVELOPE_SCHEMA_VERSION;
  messageType: "inbox_event";
  plaintext: string;
  collaborationContext: CollaborationContextMetadata;
  inboxEvent: TypedInboxEvent;
};

export type ParsedCollaborationMessageContent =
  | {
      messageType: "chat";
      plaintext: string;
      collaborationContext: null;
      inboxEvent: null;
    }
  | {
      messageType: "inbox_event";
      plaintext: string;
      collaborationContext: CollaborationContextMetadata;
      inboxEvent: TypedInboxEvent;
  };

const EXAMPLE_ORIGINATOR_NPUB = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const EXAMPLE_ASSIGNEE_NPUB = "npub1rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr";

const CONTEXT_ID_PATTERN = /^ctx_[a-z0-9][a-z0-9_-]{2,127}$/;
const EVENT_ID_PATTERN = /^inbox_evt_[a-z0-9][a-z0-9_-]{2,127}$/;
const NPUB_PATTERN = /^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const isIsoDateString = (value: unknown): value is IsoDateString =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

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

const validateOptionalIsoDateString = (value: unknown, field: string, errors: string[]): void => {
  if (value !== null && value !== undefined && !isIsoDateString(value)) {
    errors.push(`${field} must be an ISO date string or null`);
  }
};

const validateNpub = (value: unknown, field: string, errors: string[]): void => {
  if (!isNonEmptyString(value) || !NPUB_PATTERN.test(value)) {
    errors.push(`${field} must be an npub identifier`);
  }
};

const validateOptionalNpub = (value: unknown, field: string, errors: string[]): void => {
  if (value !== null && value !== undefined) {
    validateNpub(value, field, errors);
  }
};

const validateParticipantRole = (value: unknown, field: string, errors: string[]): void => {
  if (!COLLABORATION_PARTICIPANT_ROLES.includes(value as CollaborationParticipantRole)) {
    errors.push(`${field} must be one of ${COLLABORATION_PARTICIPANT_ROLES.join(", ")}`);
  }
};

const validateActor = (value: unknown, field: string, errors: string[]): void => {
  if (!isRecord(value)) {
    errors.push(`${field} must be an object`);
    return;
  }
  validateNpub(value.npub, `${field}.npub`, errors);
  validateOptionalString(value.agentId, `${field}.agentId`, errors);
  validateOptionalString(value.runtimeHost, `${field}.runtimeHost`, errors);
  if (value.role !== null && value.role !== undefined) {
    validateParticipantRole(value.role, `${field}.role`, errors);
  }
};

const validateParticipant = (value: unknown, field: string, errors: string[]): void => {
  if (!isRecord(value)) {
    errors.push(`${field} must be an object`);
    return;
  }
  validateNpub(value.npub, `${field}.npub`, errors);
  validateOptionalString(value.agentId, `${field}.agentId`, errors);
  validateOptionalString(value.runtimeHost, `${field}.runtimeHost`, errors);
  validateParticipantRole(value.role, `${field}.role`, errors);
  validateOptionalString(value.displayName, `${field}.displayName`, errors);
};

const validateContextPolicy = (value: unknown, errors: string[]): void => {
  if (!isRecord(value)) {
    errors.push("policy must be an object");
    return;
  }
  if (!COLLABORATION_CONTEXT_TRUST_ZONES.includes(value.primaryTrustZone as CollaborationContextTrustZone)) {
    errors.push(`policy.primaryTrustZone must be one of ${COLLABORATION_CONTEXT_TRUST_ZONES.join(", ")}`);
  }
  if (!Array.isArray(value.additionalTrustZones)) {
    errors.push("policy.additionalTrustZones must be an array");
  } else {
    for (const entry of value.additionalTrustZones) {
      if (!COLLABORATION_CONTEXT_TRUST_ZONES.includes(entry as CollaborationContextTrustZone)) {
        errors.push(`policy.additionalTrustZones entries must be one of ${COLLABORATION_CONTEXT_TRUST_ZONES.join(", ")}`);
      }
    }
  }
  validateStringArray(value.memoryScope, "policy.memoryScope", errors);
  validateStringArray(value.requireReviewFor, "policy.requireReviewFor", errors);
  validateStringArray(value.toolRestrictions, "policy.toolRestrictions", errors);
  if (value.operatorMayPause !== true) {
    errors.push("policy.operatorMayPause must be true");
  }
};

const validateContextBudget = (value: unknown, errors: string[]): void => {
  if (!isRecord(value)) {
    errors.push("budget must be an object");
    return;
  }
  if (value.currency !== "sats") {
    errors.push("budget.currency must be sats");
  }
  if (
    value.maxBudgetSats !== null &&
    value.maxBudgetSats !== undefined &&
    (!Number.isInteger(value.maxBudgetSats) || Number(value.maxBudgetSats) < 0)
  ) {
    errors.push("budget.maxBudgetSats must be a non-negative integer or null");
  }
  if (typeof value.shadowMode !== "boolean") {
    errors.push("budget.shadowMode must be a boolean");
  }
};

const validateTaskOwnership = (value: unknown, errors: string[]): void => {
  if (!isRecord(value)) {
    errors.push("taskOwnership must be an object");
    return;
  }
  if (!isNonEmptyString(value.taskRef)) {
    errors.push("taskOwnership.taskRef is required");
  }
  if (!isNonEmptyString(value.title)) {
    errors.push("taskOwnership.title is required");
  }
  validateOptionalNpub(value.ownerNpub, "taskOwnership.ownerNpub", errors);
  validateOptionalNpub(value.claimedByNpub, "taskOwnership.claimedByNpub", errors);
  if (!COLLABORATION_TASK_STATUSES.includes(value.status as CollaborationTaskStatus)) {
    errors.push(`taskOwnership.status must be one of ${COLLABORATION_TASK_STATUSES.join(", ")}`);
  }
  validateOptionalString(value.workspaceRef, "taskOwnership.workspaceRef", errors);
};

export const validateCollaborationContextMetadata = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["collaborationContext must be an object"];
  }
  if (value.schemaVersion !== COLLABORATION_CONTEXT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${COLLABORATION_CONTEXT_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.contextId) || !CONTEXT_ID_PATTERN.test(value.contextId)) {
    errors.push("contextId must match /^ctx_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  if (!isNonEmptyString(value.title)) {
    errors.push("title is required");
  }
  if (!isIsoDateString(value.createdAt)) {
    errors.push("createdAt must be an ISO date string");
  }
  validateNpub(value.createdBy, "createdBy", errors);
  if (!Array.isArray(value.participants) || value.participants.length === 0) {
    errors.push("participants must be a non-empty array");
  } else {
    value.participants.forEach((entry, index) => validateParticipant(entry, `participants[${index}]`, errors));
  }
  validateContextPolicy(value.policy, errors);
  validateContextBudget(value.budget, errors);
  validateTaskOwnership(value.taskOwnership, errors);
  validateStringArray(value.artifactRefs, "artifactRefs", errors);
  validateStringArray(value.handoffRefs, "handoffRefs", errors);
  validateStringArray(value.outcomeRefs, "outcomeRefs", errors);
  validateStringArray(value.notes, "notes", errors);
  return errors;
};

const validateTypedInboxEventBase = (value: Record<string, unknown>, errors: string[]): void => {
  if (value.schemaVersion !== TYPED_INBOX_EVENT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${TYPED_INBOX_EVENT_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.eventId) || !EVENT_ID_PATTERN.test(value.eventId)) {
    errors.push("eventId must match /^inbox_evt_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  if (!TYPED_INBOX_EVENT_TYPES.includes(value.eventType as TypedInboxEventType)) {
    errors.push(`eventType must be one of ${TYPED_INBOX_EVENT_TYPES.join(", ")}`);
  }
  if (!isNonEmptyString(value.contextId) || !CONTEXT_ID_PATTERN.test(value.contextId)) {
    errors.push("contextId must match the collaboration context id format");
  }
  if (!isNonEmptyString(value.summary)) {
    errors.push("summary is required");
  }
  if (!COLLABORATION_EVENT_PRIORITIES.includes(value.priority as CollaborationEventPriority)) {
    errors.push(`priority must be one of ${COLLABORATION_EVENT_PRIORITIES.join(", ")}`);
  }
  if (!isIsoDateString(value.createdAt)) {
    errors.push("createdAt must be an ISO date string");
  }
  validateActor(value.actor, "actor", errors);
  validateOptionalString(value.taskRef, "taskRef", errors);
  validateStringArray(value.artifactRefs, "artifactRefs", errors);
  validateStringArray(value.handoffRefs, "handoffRefs", errors);
  validateStringArray(value.outcomeRefs, "outcomeRefs", errors);
};

export const validateTypedInboxEvent = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["typedInboxEvent must be an object"];
  }
  validateTypedInboxEventBase(value, errors);

  switch (value.eventType) {
    case "assignment":
      if (!isRecord(value.assignment)) {
        errors.push("assignment is required for assignment events");
      } else {
        validateNpub(value.assignment.assigneeNpub, "assignment.assigneeNpub", errors);
        validateOptionalIsoDateString(value.assignment.dueAt, "assignment.dueAt", errors);
        validateOptionalIsoDateString(value.assignment.claimExpiresAt, "assignment.claimExpiresAt", errors);
      }
      break;
    case "claim":
      if (!isRecord(value.claim)) {
        errors.push("claim is required for claim events");
      } else {
        validateNpub(value.claim.claimedByNpub, "claim.claimedByNpub", errors);
        if (!COLLABORATION_CLAIM_STATES.includes(value.claim.state as CollaborationClaimState)) {
          errors.push(`claim.state must be one of ${COLLABORATION_CLAIM_STATES.join(", ")}`);
        }
        validateOptionalString(value.claim.note, "claim.note", errors);
      }
      break;
    case "ack":
      if (!isRecord(value.ack)) {
        errors.push("ack is required for ack events");
      } else {
        validateOptionalString(value.ack.note, "ack.note", errors);
        if (!isNonEmptyString(value.ack.acknowledgedEventId)) {
          errors.push("ack.acknowledgedEventId is required");
        }
      }
      break;
    case "reject":
      if (!isRecord(value.reject)) {
        errors.push("reject is required for reject events");
      } else {
        if (!isNonEmptyString(value.reject.rejectedEventId)) {
          errors.push("reject.rejectedEventId is required");
        }
        if (!isNonEmptyString(value.reject.reason)) {
          errors.push("reject.reason is required");
        }
      }
      break;
    case "completion":
      if (!isRecord(value.completion)) {
        errors.push("completion is required for completion events");
      } else {
        if (!isNonEmptyString(value.completion.resultSummary)) {
          errors.push("completion.resultSummary is required");
        }
        validateStringArray(value.completion.deliveredArtifactRefs, "completion.deliveredArtifactRefs", errors);
      }
      break;
    case "failure":
      if (!isRecord(value.failure)) {
        errors.push("failure is required for failure events");
      } else {
        if (!isNonEmptyString(value.failure.failureCode)) {
          errors.push("failure.failureCode is required");
        }
        if (typeof value.failure.retryable !== "boolean") {
          errors.push("failure.retryable must be a boolean");
        }
        if (!isNonEmptyString(value.failure.reason)) {
          errors.push("failure.reason is required");
        }
      }
      break;
    case "handoff_created":
      if (!isRecord(value.handoffCreated)) {
        errors.push("handoffCreated is required for handoff_created events");
      } else {
        if (!isNonEmptyString(value.handoffCreated.handoffId)) {
          errors.push("handoffCreated.handoffId is required");
        }
        validateOptionalString(value.handoffCreated.targetRuntimeHost, "handoffCreated.targetRuntimeHost", errors);
      }
      break;
    case "handoff_completed":
      if (!isRecord(value.handoffCompleted)) {
        errors.push("handoffCompleted is required for handoff_completed events");
      } else {
        if (!isNonEmptyString(value.handoffCompleted.handoffId)) {
          errors.push("handoffCompleted.handoffId is required");
        }
        if (
          !COLLABORATION_HANDOFF_COMPLETION_STATES.includes(
            value.handoffCompleted.completionState as CollaborationHandoffCompletionState
          )
        ) {
          errors.push(
            `handoffCompleted.completionState must be one of ${COLLABORATION_HANDOFF_COMPLETION_STATES.join(", ")}`
          );
        }
        validateOptionalString(value.handoffCompleted.outcomeRef, "handoffCompleted.outcomeRef", errors);
      }
      break;
    case "operator_governance":
      if (!isRecord(value.operatorGovernance)) {
        errors.push("operatorGovernance is required for operator_governance events");
      } else {
        if (
          !COLLABORATION_GOVERNANCE_ACTIONS.includes(value.operatorGovernance.action as CollaborationGovernanceAction)
        ) {
          errors.push(
            `operatorGovernance.action must be one of ${COLLABORATION_GOVERNANCE_ACTIONS.join(", ")}`
          );
        }
        if (!isNonEmptyString(value.operatorGovernance.note)) {
          errors.push("operatorGovernance.note is required");
        }
        validateOptionalNpub(
          value.operatorGovernance.affectedParticipantNpub,
          "operatorGovernance.affectedParticipantNpub",
          errors
        );
      }
      break;
    default:
      break;
  }

  return errors;
};

export const validateCollaborationMessageEnvelope = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["collaborationMessageEnvelope must be an object"];
  }
  if (value.schemaVersion !== COLLABORATION_MESSAGE_ENVELOPE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${COLLABORATION_MESSAGE_ENVELOPE_SCHEMA_VERSION}`);
  }
  if (value.messageType !== "inbox_event") {
    errors.push("messageType must be inbox_event");
  }
  if (!isNonEmptyString(value.plaintext)) {
    errors.push("plaintext is required");
  }
  errors.push(...validateCollaborationContextMetadata(value.collaborationContext));
  errors.push(...validateTypedInboxEvent(value.inboxEvent));
  if (
    isRecord(value.collaborationContext) &&
    isRecord(value.inboxEvent) &&
    value.collaborationContext.contextId !== value.inboxEvent.contextId
  ) {
    errors.push("inboxEvent.contextId must match collaborationContext.contextId");
  }
  return errors;
};

export const serializeCollaborationMessageEnvelope = (value: CollaborationMessageEnvelope): string => {
  const errors = validateCollaborationMessageEnvelope(value);
  if (errors.length > 0) {
    throw new Error(`invalid collaboration message envelope:\n${errors.join("\n")}`);
  }
  return JSON.stringify(value);
};

export const parseCollaborationMessageContent = (content: string): ParsedCollaborationMessageContent => {
  if (!content || content.trim().length === 0) {
    return {
      messageType: "chat",
      plaintext: content,
      collaborationContext: null,
      inboxEvent: null,
    };
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    const errors = validateCollaborationMessageEnvelope(parsed);
    if (errors.length > 0 || !isRecord(parsed)) {
      throw new Error("not a valid collaboration envelope");
    }
    return {
      messageType: "inbox_event",
      plaintext: String(parsed.plaintext),
      collaborationContext: parsed.collaborationContext as CollaborationContextMetadata,
      inboxEvent: parsed.inboxEvent as TypedInboxEvent,
    };
  } catch {
    return {
      messageType: "chat",
      plaintext: content,
      collaborationContext: null,
      inboxEvent: null,
    };
  }
};

export const collaborationContextExample: CollaborationContextMetadata = {
  schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
  contextId: "ctx_auth_refactor",
  title: "Auth flow refactor and validation",
  createdAt: "2026-04-19T00:00:00Z",
  createdBy: EXAMPLE_ORIGINATOR_NPUB,
  participants: [
    {
      npub: EXAMPLE_ORIGINATOR_NPUB,
      agentId: "agent_default",
      runtimeHost: "codex",
      role: "originator",
      displayName: "Crosshead Codex",
    },
    {
      npub: EXAMPLE_ASSIGNEE_NPUB,
      agentId: "agent_research",
      runtimeHost: "claude-code",
      role: "assignee",
      displayName: "Crosshead Claude Research",
    },
  ],
  policy: {
    primaryTrustZone: "workspace_private",
    additionalTrustZones: ["auditable", "machine_only"],
    memoryScope: ["hot", "warm", "handoff_capsules"],
    requireReviewFor: ["schema_changes", "prod_writes"],
    toolRestrictions: ["no_external_network_write"],
    operatorMayPause: true,
  },
  budget: {
    currency: "sats",
    maxBudgetSats: 2500,
    shadowMode: true,
  },
  taskOwnership: {
    taskRef: "task-master:95",
    title: "Define typed collaboration inbox events",
    ownerNpub: EXAMPLE_ORIGINATOR_NPUB,
    claimedByNpub: EXAMPLE_ASSIGNEE_NPUB,
    status: "claimed",
    workspaceRef: "repo:example-org/example-repo",
  },
  artifactRefs: ["artifact:spec-draft-1"],
  handoffRefs: ["handoff_123"],
  outcomeRefs: ["outcome_456"],
  notes: ["Structured collaboration context carried over existing message APIs."],
};

export const assignmentInboxEventExample: AssignmentInboxEvent = {
  schemaVersion: TYPED_INBOX_EVENT_SCHEMA_VERSION,
  eventId: "inbox_evt_assignment_01",
  eventType: "assignment",
  contextId: "ctx_auth_refactor",
  summary: "Take ownership of the auth refactor task and report back with a typed outcome.",
  priority: "high",
  createdAt: "2026-04-19T00:02:00Z",
  actor: {
    npub: EXAMPLE_ORIGINATOR_NPUB,
    agentId: "agent_default",
    runtimeHost: "codex",
    role: "originator",
  },
  taskRef: "task-master:95",
  artifactRefs: ["artifact:spec-draft-1"],
  handoffRefs: ["handoff_123"],
  outcomeRefs: [],
  assignment: {
    assigneeNpub: EXAMPLE_ASSIGNEE_NPUB,
    dueAt: "2026-04-19T01:00:00Z",
    claimExpiresAt: "2026-04-19T00:20:00Z",
  },
};

export const collaborationMessageEnvelopeExample: CollaborationMessageEnvelope = {
  schemaVersion: COLLABORATION_MESSAGE_ENVELOPE_SCHEMA_VERSION,
  messageType: "inbox_event",
  plaintext: "Assignment: define typed inbox events for Task 95 and preserve current message API compatibility.",
  collaborationContext: collaborationContextExample,
  inboxEvent: assignmentInboxEventExample,
};
