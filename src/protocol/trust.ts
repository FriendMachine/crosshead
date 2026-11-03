import { IsoDateString, Npub } from "./base";
import {
  type PersistentAgentReference,
  type TrustCarryoverMode,
  lineageLinkExample,
  persistentAgentEntityExample,
  validatePersistentAgentReference,
} from "./persistent-agents";

export const TRUST_RECEIPT_SCHEMA_VERSION = "trust_receipt_v1";
export const TRUST_EDGE_SCHEMA_VERSION = "trust_edge_v1";
export const CAPABILITY_CLAIM_SCHEMA_VERSION = "capability_claim_v1";
export const PERSISTENT_ORGANIZATION_SCHEMA_VERSION = "persistent_organization_v1";
export const NEGOTIATION_THREAD_SCHEMA_VERSION = "negotiation_thread_v1";

export const TRUST_RECEIPT_TYPES = [
  "task_completed",
  "task_failed",
  "handoff_accepted",
  "handoff_rejected",
  "correction_confirmed",
  "deliverable_rejected",
  "settlement_confirmed",
] as const;
export const TRUST_EDGE_TYPES = [
  "worked_with",
  "delegated_to",
  "corrected_by",
  "endorsed_by",
  "member_of",
  "contracted_with",
] as const;
export const TRUST_CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export const SELF_MODEL_INFLUENCE_MODES = ["none", "routing_hint", "operator_review"] as const;
export const CAPABILITY_CLAIM_KINDS = ["declared", "observed", "endorsed"] as const;
export const CAPABILITY_CLAIM_STATUSES = ["active", "expired", "revoked", "superseded"] as const;
export const ORGANIZATION_STATUSES = ["active", "paused", "dissolved"] as const;
export const ORGANIZATION_MEMBER_ROLES = ["founder", "operator", "builder", "reviewer", "treasury", "observer"] as const;
export const ORGANIZATION_MEMBER_STATUSES = ["active", "suspended", "former"] as const;
export const GOVERNANCE_MODELS = ["operator_review", "multi_sig", "weighted_vote", "delegated_admin"] as const;
export const NEGOTIATION_THREAD_STATUSES = [
  "open",
  "conditionally_accepted",
  "accepted",
  "rejected",
  "settled",
  "expired",
  "cancelled",
] as const;
export const NEGOTIATION_PARTY_ROLES = ["requester", "provider", "mediator", "guarantor"] as const;
export const NEGOTIATION_EVENT_TYPES = [
  "offer",
  "counteroffer",
  "conditional_acceptance",
  "rejection",
  "settlement",
  "note",
] as const;

export type TrustReceiptType = (typeof TRUST_RECEIPT_TYPES)[number];
export type TrustEdgeType = (typeof TRUST_EDGE_TYPES)[number];
export type TrustConfidenceLevel = (typeof TRUST_CONFIDENCE_LEVELS)[number];
export type SelfModelInfluenceMode = (typeof SELF_MODEL_INFLUENCE_MODES)[number];
export type CapabilityClaimKind = (typeof CAPABILITY_CLAIM_KINDS)[number];
export type CapabilityClaimStatus = (typeof CAPABILITY_CLAIM_STATUSES)[number];
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];
export type OrganizationMemberRole = (typeof ORGANIZATION_MEMBER_ROLES)[number];
export type OrganizationMemberStatus = (typeof ORGANIZATION_MEMBER_STATUSES)[number];
export type GovernanceModel = (typeof GOVERNANCE_MODELS)[number];
export type NegotiationThreadStatus = (typeof NEGOTIATION_THREAD_STATUSES)[number];
export type NegotiationPartyRole = (typeof NEGOTIATION_PARTY_ROLES)[number];
export type NegotiationEventType = (typeof NEGOTIATION_EVENT_TYPES)[number];

export type PersistentOrganizationReference = {
  organizationId: string;
  npub: Npub;
};

export type TrustSubjectRef =
  | {
      subjectType: "agent";
      agentRef: PersistentAgentReference;
    }
  | {
      subjectType: "organization";
      organizationRef: PersistentOrganizationReference;
    };

export type ReputationInfluenceBoundary = {
  lineageCarryoverMode: TrustCarryoverMode;
  lineageLinkRefs: string[];
  selfModelRef: string | null;
  selfModelInfluenceMode: SelfModelInfluenceMode;
  directTrustTransferProhibited: true;
  notes: string[];
};

export type TrustReceiptEvidence = {
  outcomeRef: string | null;
  handoffRef: string | null;
  collaborationContextRef: string | null;
  settlementRef: string | null;
  evidenceRefs: string[];
};

export type TrustReceipt = {
  schemaVersion: typeof TRUST_RECEIPT_SCHEMA_VERSION;
  receiptId: string;
  receiptType: TrustReceiptType;
  subject: TrustSubjectRef;
  counterparty: TrustSubjectRef | null;
  summary: string;
  observedAt: IsoDateString;
  evidence: TrustReceiptEvidence;
  signedAt: IsoDateString;
  signedByNpub: Npub;
  payloadHash: string;
  signature: string;
  notes: string[];
};

export type TrustEdge = {
  schemaVersion: typeof TRUST_EDGE_SCHEMA_VERSION;
  edgeId: string;
  source: TrustSubjectRef;
  target: TrustSubjectRef;
  relationshipType: TrustEdgeType;
  weight: number;
  confidence: TrustConfidenceLevel;
  receiptRefs: string[];
  influenceBoundary: ReputationInfluenceBoundary;
  explanation: {
    rationale: string;
    positiveSignals: string[];
    cautionSignals: string[];
  };
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  notes: string[];
};

export type CapabilityClaimScope = {
  runtimeHosts: string[];
  trustZones: string[];
  workspaceRefs: string[];
  artifactKinds: string[];
};

export type CapabilityRoutingHints = {
  eligibleForRouting: boolean;
  preferredRuntimeHosts: string[];
  preferredTrustZones: string[];
  budgetRef: string | null;
  availabilityRef: string | null;
  explanationRefs: string[];
  notes: string[];
};

export type CapabilityClaim = {
  schemaVersion: typeof CAPABILITY_CLAIM_SCHEMA_VERSION;
  claimId: string;
  subject: TrustSubjectRef;
  assertedBy: TrustSubjectRef;
  claimKind: CapabilityClaimKind;
  status: CapabilityClaimStatus;
  capabilityId: string;
  summary: string;
  confidence: TrustConfidenceLevel;
  scope: CapabilityClaimScope;
  supportingReceiptRefs: string[];
  supportingOutcomeRefs: string[];
  supportingTrustEdgeRefs: string[];
  influenceBoundary: ReputationInfluenceBoundary;
  routingHints: CapabilityRoutingHints;
  createdAt: IsoDateString;
  observedAt: IsoDateString | null;
  expiresAt: IsoDateString | null;
  notes: string[];
};

export type PersistentOrganizationMember = {
  memberAgentRef: PersistentAgentReference;
  role: OrganizationMemberRole;
  status: OrganizationMemberStatus;
  joinedAt: IsoDateString;
  delegatedCapabilityClaimRefs: string[];
  trustEdgeRefs: string[];
  notes: string[];
};

export type OrganizationGovernance = {
  governanceModel: GovernanceModel;
  membershipPolicy: string[];
  decisionPolicyRefs: string[];
  sharedPolicyRefs: string[];
  budgetPolicyRefs: string[];
  settlementApprovalThresholdSats: number | null;
  auditRefs: string[];
};

export type OrganizationTreasury = {
  budgetRef: string | null;
  settlementRefs: string[];
  shadowBillingAllowed: boolean;
  notes: string[];
};

export type PersistentOrganization = {
  schemaVersion: typeof PERSISTENT_ORGANIZATION_SCHEMA_VERSION;
  organizationRef: PersistentOrganizationReference;
  createdAt: IsoDateString;
  status: OrganizationStatus;
  identity: {
    displayName: string;
    summary: string;
  };
  founderAgentRefs: PersistentAgentReference[];
  membership: PersistentOrganizationMember[];
  governance: OrganizationGovernance;
  treasury: OrganizationTreasury;
  publicCapabilityClaimRefs: string[];
  collaborationContextRefs: string[];
  trustEdgeRefs: string[];
  notes: string[];
};

export type NegotiationTerms = {
  currency: "sats";
  priceSats: number | null;
  turnaroundHours: number | null;
  requiredCapabilityClaimRefs: string[];
  requiredAccessRefs: string[];
  dependencyRefs: string[];
  acceptanceCriteria: string[];
  settlementRef: string | null;
  expiresAt: IsoDateString | null;
};

export type NegotiationParty = {
  party: TrustSubjectRef;
  role: NegotiationPartyRole;
  contactAgentRef: PersistentAgentReference | null;
  notes: string[];
};

export type NegotiationEvent = {
  eventId: string;
  eventType: NegotiationEventType;
  createdAt: IsoDateString;
  createdBy: TrustSubjectRef;
  summary: string;
  terms: NegotiationTerms | null;
  conditionRefs: string[];
  reason: string | null;
  settlementRef: string | null;
  notes: string[];
};

export type NegotiationThread = {
  schemaVersion: typeof NEGOTIATION_THREAD_SCHEMA_VERSION;
  threadId: string;
  status: NegotiationThreadStatus;
  openedAt: IsoDateString;
  closedAt: IsoDateString | null;
  workSummary: string;
  collaborationContextRef: string | null;
  parties: NegotiationParty[];
  currentTerms: NegotiationTerms | null;
  events: NegotiationEvent[];
  trustReceiptRefs: string[];
  outcomeRef: string | null;
  notes: string[];
};

const TRUST_RECEIPT_ID_PATTERN = /^trust_receipt_[a-z0-9][a-z0-9_-]{2,127}$/;
const TRUST_EDGE_ID_PATTERN = /^trust_edge_[a-z0-9][a-z0-9_-]{2,127}$/;
const ORGANIZATION_ID_PATTERN = /^org_[a-z0-9][a-z0-9_-]{2,127}$/;
const CAPABILITY_CLAIM_ID_PATTERN = /^capability_claim_[a-z0-9][a-z0-9_-]{2,127}$/;
const NEGOTIATION_THREAD_ID_PATTERN = /^negotiation_thread_[a-z0-9][a-z0-9_-]{2,127}$/;
const NEGOTIATION_EVENT_ID_PATTERN = /^negotiation_evt_[a-z0-9][a-z0-9_-]{2,127}$/;
const CAPABILITY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{2,127}$/;
const NPUB_PATTERN = /^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const SCHNORR_SIGNATURE_PATTERN = /^[0-9a-f]{128}$/i;

const TRUST_RECEIPT_TYPE_SET = new Set<TrustReceiptType>(TRUST_RECEIPT_TYPES);
const TRUST_EDGE_TYPE_SET = new Set<TrustEdgeType>(TRUST_EDGE_TYPES);
const TRUST_CONFIDENCE_SET = new Set<TrustConfidenceLevel>(TRUST_CONFIDENCE_LEVELS);
const SELF_MODEL_INFLUENCE_MODE_SET = new Set<SelfModelInfluenceMode>(SELF_MODEL_INFLUENCE_MODES);
const CAPABILITY_CLAIM_KIND_SET = new Set<CapabilityClaimKind>(CAPABILITY_CLAIM_KINDS);
const CAPABILITY_CLAIM_STATUS_SET = new Set<CapabilityClaimStatus>(CAPABILITY_CLAIM_STATUSES);
const ORGANIZATION_STATUS_SET = new Set<OrganizationStatus>(ORGANIZATION_STATUSES);
const ORGANIZATION_MEMBER_ROLE_SET = new Set<OrganizationMemberRole>(ORGANIZATION_MEMBER_ROLES);
const ORGANIZATION_MEMBER_STATUS_SET = new Set<OrganizationMemberStatus>(ORGANIZATION_MEMBER_STATUSES);
const GOVERNANCE_MODEL_SET = new Set<GovernanceModel>(GOVERNANCE_MODELS);
const NEGOTIATION_THREAD_STATUS_SET = new Set<NegotiationThreadStatus>(NEGOTIATION_THREAD_STATUSES);
const NEGOTIATION_PARTY_ROLE_SET = new Set<NegotiationPartyRole>(NEGOTIATION_PARTY_ROLES);
const NEGOTIATION_EVENT_TYPE_SET = new Set<NegotiationEventType>(NEGOTIATION_EVENT_TYPES);
const TRUST_CARRYOVER_MODE_SET = new Set<TrustCarryoverMode>(["none", "bounded", "operator_review"]);

const EXAMPLE_ROOT_AGENT_REF = persistentAgentEntityExample.agentRef;
const EXAMPLE_RESEARCH_AGENT_REF: PersistentAgentReference = {
  agentId: "agent_onlybots_research_fork",
  npub: "npub1rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr",
  lineageRoot: EXAMPLE_ROOT_AGENT_REF.agentId,
};
const EXAMPLE_PROVIDER_ORGANIZATION_REF: PersistentOrganizationReference = {
  organizationId: "org_onlybots_schema_guild",
  npub: "npub1sssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss",
};
const EXAMPLE_CLIENT_ORGANIZATION_REF: PersistentOrganizationReference = {
  organizationId: "org_client_schema_ops",
  npub: "npub1ttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt",
};

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

const subjectIdentityKey = (value: TrustSubjectRef): string =>
  value.subjectType === "agent"
    ? `agent:${value.agentRef.agentId}`
    : `organization:${value.organizationRef.organizationId}`;

export const validatePersistentOrganizationReference = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["organizationRef must be an object"];
  }
  if (!isNonEmptyString(value.organizationId) || !ORGANIZATION_ID_PATTERN.test(value.organizationId)) {
    errors.push("organizationRef.organizationId must match /^org_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  if (!isNonEmptyString(value.npub) || !NPUB_PATTERN.test(value.npub)) {
    errors.push("organizationRef.npub must be an npub identifier");
  }
  return errors;
};

export const validateTrustSubjectRef = (value: unknown, fieldName = "subject"): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${fieldName} must be an object`];
  }
  if (value.subjectType === "agent") {
    errors.push(...validatePersistentAgentReference(value.agentRef));
    if ("organizationRef" in value && value.organizationRef !== undefined) {
      errors.push(`${fieldName}.organizationRef must be omitted when subjectType is agent`);
    }
    return errors;
  }
  if (value.subjectType === "organization") {
    errors.push(...validatePersistentOrganizationReference(value.organizationRef));
    if ("agentRef" in value && value.agentRef !== undefined) {
      errors.push(`${fieldName}.agentRef must be omitted when subjectType is organization`);
    }
    return errors;
  }
  errors.push(`${fieldName}.subjectType must be agent or organization`);
  return errors;
};

export const validateReputationInfluenceBoundary = (value: unknown, fieldName = "influenceBoundary"): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${fieldName} must be an object`];
  }
  if (
    !isNonEmptyString(value.lineageCarryoverMode) ||
    !TRUST_CARRYOVER_MODE_SET.has(value.lineageCarryoverMode as TrustCarryoverMode)
  ) {
    errors.push(`${fieldName}.lineageCarryoverMode must be none, bounded, or operator_review`);
  }
  const lineageLinkRefs = validateStringArray(value.lineageLinkRefs, `${fieldName}.lineageLinkRefs`, errors);
  if (value.lineageCarryoverMode === "none" && lineageLinkRefs.length > 0) {
    errors.push(`${fieldName}.lineageLinkRefs must be empty when lineageCarryoverMode is none`);
  }
  if (
    (value.lineageCarryoverMode === "bounded" || value.lineageCarryoverMode === "operator_review") &&
    lineageLinkRefs.length === 0
  ) {
    errors.push(`${fieldName}.lineageLinkRefs must cite lineage evidence when lineageCarryoverMode is bounded or operator_review`);
  }
  if (value.selfModelRef !== null && value.selfModelRef !== undefined && !isNonEmptyString(value.selfModelRef)) {
    errors.push(`${fieldName}.selfModelRef must be a non-empty string or null`);
  }
  if (
    !isNonEmptyString(value.selfModelInfluenceMode) ||
    !SELF_MODEL_INFLUENCE_MODE_SET.has(value.selfModelInfluenceMode as SelfModelInfluenceMode)
  ) {
    errors.push(`${fieldName}.selfModelInfluenceMode must be one of: ${SELF_MODEL_INFLUENCE_MODES.join(", ")}`);
  }
  if (value.selfModelInfluenceMode === "none" && value.selfModelRef !== null) {
    errors.push(`${fieldName}.selfModelRef must be null when selfModelInfluenceMode is none`);
  }
  if ((value.selfModelInfluenceMode === "routing_hint" || value.selfModelInfluenceMode === "operator_review") && value.selfModelRef === null) {
    errors.push(`${fieldName}.selfModelRef is required when selfModelInfluenceMode is routing_hint or operator_review`);
  }
  if (value.directTrustTransferProhibited !== true) {
    errors.push(`${fieldName}.directTrustTransferProhibited must be true`);
  }
  validateStringArray(value.notes, `${fieldName}.notes`, errors);
  return errors;
};

export const validateTrustReceiptEvidence = (value: unknown, fieldName = "evidence"): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${fieldName} must be an object`];
  }
  if (value.outcomeRef !== null && value.outcomeRef !== undefined && !isNonEmptyString(value.outcomeRef)) {
    errors.push(`${fieldName}.outcomeRef must be a non-empty string or null`);
  }
  if (value.handoffRef !== null && value.handoffRef !== undefined && !isNonEmptyString(value.handoffRef)) {
    errors.push(`${fieldName}.handoffRef must be a non-empty string or null`);
  }
  if (
    value.collaborationContextRef !== null &&
    value.collaborationContextRef !== undefined &&
    !isNonEmptyString(value.collaborationContextRef)
  ) {
    errors.push(`${fieldName}.collaborationContextRef must be a non-empty string or null`);
  }
  if (value.settlementRef !== null && value.settlementRef !== undefined && !isNonEmptyString(value.settlementRef)) {
    errors.push(`${fieldName}.settlementRef must be a non-empty string or null`);
  }
  const evidenceRefs = validateStringArray(value.evidenceRefs, `${fieldName}.evidenceRefs`, errors);
  if (evidenceRefs.length === 0) {
    errors.push(`${fieldName}.evidenceRefs must contain at least one authoritative reference`);
  }
  return errors;
};

export const validateTrustReceipt = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["trustReceipt must be an object"];
  }
  if (value.schemaVersion !== TRUST_RECEIPT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${TRUST_RECEIPT_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.receiptId) || !TRUST_RECEIPT_ID_PATTERN.test(value.receiptId)) {
    errors.push("receiptId must match /^trust_receipt_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  if (!isNonEmptyString(value.receiptType) || !TRUST_RECEIPT_TYPE_SET.has(value.receiptType as TrustReceiptType)) {
    errors.push(`receiptType must be one of: ${TRUST_RECEIPT_TYPES.join(", ")}`);
  }
  errors.push(...validateTrustSubjectRef(value.subject, "subject"));
  if (value.counterparty !== null && value.counterparty !== undefined) {
    errors.push(...validateTrustSubjectRef(value.counterparty, "counterparty"));
  }
  if (!isNonEmptyString(value.summary)) {
    errors.push("summary is required");
  }
  if (!isIsoDateString(value.observedAt)) {
    errors.push("observedAt must be an ISO date string");
  }
  errors.push(...validateTrustReceiptEvidence(value.evidence));
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

export const validateTrustEdge = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["trustEdge must be an object"];
  }
  if (value.schemaVersion !== TRUST_EDGE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${TRUST_EDGE_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.edgeId) || !TRUST_EDGE_ID_PATTERN.test(value.edgeId)) {
    errors.push("edgeId must match /^trust_edge_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  errors.push(...validateTrustSubjectRef(value.source, "source"));
  errors.push(...validateTrustSubjectRef(value.target, "target"));
  if (errors.length === 0 && subjectIdentityKey(value.source as TrustSubjectRef) === subjectIdentityKey(value.target as TrustSubjectRef)) {
    errors.push("source and target must differ");
  }
  if (!isNonEmptyString(value.relationshipType) || !TRUST_EDGE_TYPE_SET.has(value.relationshipType as TrustEdgeType)) {
    errors.push(`relationshipType must be one of: ${TRUST_EDGE_TYPES.join(", ")}`);
  }
  if (typeof value.weight !== "number" || !Number.isInteger(value.weight) || value.weight < -100 || value.weight > 100) {
    errors.push("weight must be an integer between -100 and 100");
  }
  if (!isNonEmptyString(value.confidence) || !TRUST_CONFIDENCE_SET.has(value.confidence as TrustConfidenceLevel)) {
    errors.push(`confidence must be one of: ${TRUST_CONFIDENCE_LEVELS.join(", ")}`);
  }
  const receiptRefs = validateStringArray(value.receiptRefs, "receiptRefs", errors);
  if (receiptRefs.length === 0) {
    errors.push("receiptRefs must contain at least one trust receipt reference");
  }
  errors.push(...validateReputationInfluenceBoundary(value.influenceBoundary));
  if (!isRecord(value.explanation)) {
    errors.push("explanation must be an object");
  } else {
    if (!isNonEmptyString(value.explanation.rationale)) {
      errors.push("explanation.rationale is required");
    }
    validateStringArray(value.explanation.positiveSignals, "explanation.positiveSignals", errors);
    validateStringArray(value.explanation.cautionSignals, "explanation.cautionSignals", errors);
  }
  if (!isIsoDateString(value.createdAt)) {
    errors.push("createdAt must be an ISO date string");
  }
  if (!isIsoDateString(value.updatedAt)) {
    errors.push("updatedAt must be an ISO date string");
  }
  validateStringArray(value.notes, "notes", errors);
  return errors;
};

export const validateCapabilityClaimScope = (value: unknown, fieldName = "scope"): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${fieldName} must be an object`];
  }
  validateStringArray(value.runtimeHosts, `${fieldName}.runtimeHosts`, errors);
  validateStringArray(value.trustZones, `${fieldName}.trustZones`, errors);
  validateStringArray(value.workspaceRefs, `${fieldName}.workspaceRefs`, errors);
  validateStringArray(value.artifactKinds, `${fieldName}.artifactKinds`, errors);
  return errors;
};

export const validateCapabilityRoutingHints = (value: unknown, fieldName = "routingHints"): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${fieldName} must be an object`];
  }
  if (typeof value.eligibleForRouting !== "boolean") {
    errors.push(`${fieldName}.eligibleForRouting must be a boolean`);
  }
  validateStringArray(value.preferredRuntimeHosts, `${fieldName}.preferredRuntimeHosts`, errors);
  validateStringArray(value.preferredTrustZones, `${fieldName}.preferredTrustZones`, errors);
  if (value.budgetRef !== null && value.budgetRef !== undefined && !isNonEmptyString(value.budgetRef)) {
    errors.push(`${fieldName}.budgetRef must be a non-empty string or null`);
  }
  if (value.availabilityRef !== null && value.availabilityRef !== undefined && !isNonEmptyString(value.availabilityRef)) {
    errors.push(`${fieldName}.availabilityRef must be a non-empty string or null`);
  }
  validateStringArray(value.explanationRefs, `${fieldName}.explanationRefs`, errors);
  validateStringArray(value.notes, `${fieldName}.notes`, errors);
  return errors;
};

export const validateCapabilityClaim = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["capabilityClaim must be an object"];
  }
  if (value.schemaVersion !== CAPABILITY_CLAIM_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CAPABILITY_CLAIM_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.claimId) || !CAPABILITY_CLAIM_ID_PATTERN.test(value.claimId)) {
    errors.push("claimId must match /^capability_claim_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  errors.push(...validateTrustSubjectRef(value.subject, "subject"));
  errors.push(...validateTrustSubjectRef(value.assertedBy, "assertedBy"));
  if (!isNonEmptyString(value.claimKind) || !CAPABILITY_CLAIM_KIND_SET.has(value.claimKind as CapabilityClaimKind)) {
    errors.push(`claimKind must be one of: ${CAPABILITY_CLAIM_KINDS.join(", ")}`);
  }
  if (!isNonEmptyString(value.status) || !CAPABILITY_CLAIM_STATUS_SET.has(value.status as CapabilityClaimStatus)) {
    errors.push(`status must be one of: ${CAPABILITY_CLAIM_STATUSES.join(", ")}`);
  }
  if (!isNonEmptyString(value.capabilityId) || !CAPABILITY_ID_PATTERN.test(value.capabilityId)) {
    errors.push("capabilityId must match /^[a-z0-9][a-z0-9._:-]{2,127}$/");
  }
  if (!isNonEmptyString(value.summary)) {
    errors.push("summary is required");
  }
  if (!isNonEmptyString(value.confidence) || !TRUST_CONFIDENCE_SET.has(value.confidence as TrustConfidenceLevel)) {
    errors.push(`confidence must be one of: ${TRUST_CONFIDENCE_LEVELS.join(", ")}`);
  }
  errors.push(...validateCapabilityClaimScope(value.scope));
  const supportingReceiptRefs = validateStringArray(value.supportingReceiptRefs, "supportingReceiptRefs", errors);
  validateStringArray(value.supportingOutcomeRefs, "supportingOutcomeRefs", errors);
  validateStringArray(value.supportingTrustEdgeRefs, "supportingTrustEdgeRefs", errors);
  if ((value.claimKind === "observed" || value.claimKind === "endorsed") && supportingReceiptRefs.length === 0) {
    errors.push("supportingReceiptRefs must contain at least one receipt for observed or endorsed claims");
  }
  errors.push(...validateReputationInfluenceBoundary(value.influenceBoundary));
  errors.push(...validateCapabilityRoutingHints(value.routingHints));
  if (!isIsoDateString(value.createdAt)) {
    errors.push("createdAt must be an ISO date string");
  }
  if (value.observedAt !== null && value.observedAt !== undefined && !isIsoDateString(value.observedAt)) {
    errors.push("observedAt must be an ISO date string or null");
  }
  if (value.expiresAt !== null && value.expiresAt !== undefined && !isIsoDateString(value.expiresAt)) {
    errors.push("expiresAt must be an ISO date string or null");
  }
  validateStringArray(value.notes, "notes", errors);
  return errors;
};

export const validatePersistentOrganizationMember = (value: unknown, fieldName = "member"): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${fieldName} must be an object`];
  }
  errors.push(...validatePersistentAgentReference(value.memberAgentRef));
  if (!isNonEmptyString(value.role) || !ORGANIZATION_MEMBER_ROLE_SET.has(value.role as OrganizationMemberRole)) {
    errors.push(`${fieldName}.role must be one of: ${ORGANIZATION_MEMBER_ROLES.join(", ")}`);
  }
  if (!isNonEmptyString(value.status) || !ORGANIZATION_MEMBER_STATUS_SET.has(value.status as OrganizationMemberStatus)) {
    errors.push(`${fieldName}.status must be one of: ${ORGANIZATION_MEMBER_STATUSES.join(", ")}`);
  }
  if (!isIsoDateString(value.joinedAt)) {
    errors.push(`${fieldName}.joinedAt must be an ISO date string`);
  }
  validateStringArray(value.delegatedCapabilityClaimRefs, `${fieldName}.delegatedCapabilityClaimRefs`, errors);
  validateStringArray(value.trustEdgeRefs, `${fieldName}.trustEdgeRefs`, errors);
  validateStringArray(value.notes, `${fieldName}.notes`, errors);
  return errors;
};

export const validateOrganizationGovernance = (value: unknown, fieldName = "governance"): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${fieldName} must be an object`];
  }
  if (!isNonEmptyString(value.governanceModel) || !GOVERNANCE_MODEL_SET.has(value.governanceModel as GovernanceModel)) {
    errors.push(`${fieldName}.governanceModel must be one of: ${GOVERNANCE_MODELS.join(", ")}`);
  }
  validateStringArray(value.membershipPolicy, `${fieldName}.membershipPolicy`, errors);
  validateStringArray(value.decisionPolicyRefs, `${fieldName}.decisionPolicyRefs`, errors);
  validateStringArray(value.sharedPolicyRefs, `${fieldName}.sharedPolicyRefs`, errors);
  validateStringArray(value.budgetPolicyRefs, `${fieldName}.budgetPolicyRefs`, errors);
  if (
    value.settlementApprovalThresholdSats !== null &&
    value.settlementApprovalThresholdSats !== undefined &&
    (typeof value.settlementApprovalThresholdSats !== "number" ||
      !Number.isInteger(value.settlementApprovalThresholdSats) ||
      value.settlementApprovalThresholdSats < 0)
  ) {
    errors.push(`${fieldName}.settlementApprovalThresholdSats must be a non-negative integer or null`);
  }
  validateStringArray(value.auditRefs, `${fieldName}.auditRefs`, errors);
  return errors;
};

export const validateOrganizationTreasury = (value: unknown, fieldName = "treasury"): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${fieldName} must be an object`];
  }
  if (value.budgetRef !== null && value.budgetRef !== undefined && !isNonEmptyString(value.budgetRef)) {
    errors.push(`${fieldName}.budgetRef must be a non-empty string or null`);
  }
  validateStringArray(value.settlementRefs, `${fieldName}.settlementRefs`, errors);
  if (typeof value.shadowBillingAllowed !== "boolean") {
    errors.push(`${fieldName}.shadowBillingAllowed must be a boolean`);
  }
  validateStringArray(value.notes, `${fieldName}.notes`, errors);
  return errors;
};

export const validatePersistentOrganization = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["persistentOrganization must be an object"];
  }
  if (value.schemaVersion !== PERSISTENT_ORGANIZATION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PERSISTENT_ORGANIZATION_SCHEMA_VERSION}`);
  }
  errors.push(...validatePersistentOrganizationReference(value.organizationRef));
  if (!isIsoDateString(value.createdAt)) {
    errors.push("createdAt must be an ISO date string");
  }
  if (!isNonEmptyString(value.status) || !ORGANIZATION_STATUS_SET.has(value.status as OrganizationStatus)) {
    errors.push(`status must be one of: ${ORGANIZATION_STATUSES.join(", ")}`);
  }
  if (!isRecord(value.identity)) {
    errors.push("identity must be an object");
  } else {
    if (!isNonEmptyString(value.identity.displayName)) {
      errors.push("identity.displayName is required");
    }
    if (!isNonEmptyString(value.identity.summary)) {
      errors.push("identity.summary is required");
    }
  }
  if (!Array.isArray(value.founderAgentRefs) || value.founderAgentRefs.length === 0) {
    errors.push("founderAgentRefs must contain at least one persistent agent reference");
  } else {
    for (const founder of value.founderAgentRefs) {
      errors.push(...validatePersistentAgentReference(founder));
    }
  }
  if (!Array.isArray(value.membership) || value.membership.length === 0) {
    errors.push("membership must contain at least one organization member");
  } else {
    for (const member of value.membership) {
      errors.push(...validatePersistentOrganizationMember(member));
    }
  }
  const founderIds = Array.isArray(value.founderAgentRefs)
    ? new Set(
        value.founderAgentRefs
          .filter((entry): entry is PersistentAgentReference => isRecord(entry) && typeof entry.agentId === "string")
          .map((entry) => entry.agentId)
      )
    : new Set<string>();
  if (founderIds.size > 0 && Array.isArray(value.membership)) {
    const memberRoles = new Map<string, OrganizationMemberRole>();
    for (const member of value.membership) {
      if (isRecord(member) && isRecord(member.memberAgentRef) && typeof member.memberAgentRef.agentId === "string" && typeof member.role === "string") {
        memberRoles.set(member.memberAgentRef.agentId, member.role as OrganizationMemberRole);
      }
    }
    for (const founderId of founderIds) {
      if (memberRoles.get(founderId) !== "founder") {
        errors.push(`founderAgentRefs entry ${founderId} must appear in membership with role founder`);
      }
    }
  }
  errors.push(...validateOrganizationGovernance(value.governance));
  errors.push(...validateOrganizationTreasury(value.treasury));
  validateStringArray(value.publicCapabilityClaimRefs, "publicCapabilityClaimRefs", errors);
  validateStringArray(value.collaborationContextRefs, "collaborationContextRefs", errors);
  validateStringArray(value.trustEdgeRefs, "trustEdgeRefs", errors);
  validateStringArray(value.notes, "notes", errors);
  return errors;
};

export const validateNegotiationTerms = (value: unknown, fieldName = "terms"): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${fieldName} must be an object`];
  }
  if (value.currency !== "sats") {
    errors.push(`${fieldName}.currency must be sats`);
  }
  if (
    value.priceSats !== null &&
    value.priceSats !== undefined &&
    (typeof value.priceSats !== "number" || !Number.isInteger(value.priceSats) || value.priceSats < 0)
  ) {
    errors.push(`${fieldName}.priceSats must be a non-negative integer or null`);
  }
  if (
    value.turnaroundHours !== null &&
    value.turnaroundHours !== undefined &&
    (typeof value.turnaroundHours !== "number" ||
      !Number.isInteger(value.turnaroundHours) ||
      value.turnaroundHours < 0)
  ) {
    errors.push(`${fieldName}.turnaroundHours must be a non-negative integer or null`);
  }
  validateStringArray(value.requiredCapabilityClaimRefs, `${fieldName}.requiredCapabilityClaimRefs`, errors);
  validateStringArray(value.requiredAccessRefs, `${fieldName}.requiredAccessRefs`, errors);
  validateStringArray(value.dependencyRefs, `${fieldName}.dependencyRefs`, errors);
  validateStringArray(value.acceptanceCriteria, `${fieldName}.acceptanceCriteria`, errors);
  if (value.settlementRef !== null && value.settlementRef !== undefined && !isNonEmptyString(value.settlementRef)) {
    errors.push(`${fieldName}.settlementRef must be a non-empty string or null`);
  }
  if (value.expiresAt !== null && value.expiresAt !== undefined && !isIsoDateString(value.expiresAt)) {
    errors.push(`${fieldName}.expiresAt must be an ISO date string or null`);
  }
  return errors;
};

export const validateNegotiationParty = (value: unknown, fieldName = "party"): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${fieldName} must be an object`];
  }
  errors.push(...validateTrustSubjectRef(value.party, `${fieldName}.party`));
  if (!isNonEmptyString(value.role) || !NEGOTIATION_PARTY_ROLE_SET.has(value.role as NegotiationPartyRole)) {
    errors.push(`${fieldName}.role must be one of: ${NEGOTIATION_PARTY_ROLES.join(", ")}`);
  }
  if (value.contactAgentRef !== null && value.contactAgentRef !== undefined) {
    errors.push(...validatePersistentAgentReference(value.contactAgentRef));
  }
  validateStringArray(value.notes, `${fieldName}.notes`, errors);
  return errors;
};

export const validateNegotiationEvent = (value: unknown, fieldName = "event"): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${fieldName} must be an object`];
  }
  if (!isNonEmptyString(value.eventId) || !NEGOTIATION_EVENT_ID_PATTERN.test(value.eventId)) {
    errors.push(`${fieldName}.eventId must match /^negotiation_evt_[a-z0-9][a-z0-9_-]{2,127}$/`);
  }
  if (!isNonEmptyString(value.eventType) || !NEGOTIATION_EVENT_TYPE_SET.has(value.eventType as NegotiationEventType)) {
    errors.push(`${fieldName}.eventType must be one of: ${NEGOTIATION_EVENT_TYPES.join(", ")}`);
  }
  if (!isIsoDateString(value.createdAt)) {
    errors.push(`${fieldName}.createdAt must be an ISO date string`);
  }
  errors.push(...validateTrustSubjectRef(value.createdBy, `${fieldName}.createdBy`));
  if (!isNonEmptyString(value.summary)) {
    errors.push(`${fieldName}.summary is required`);
  }
  if (value.terms !== null && value.terms !== undefined) {
    errors.push(...validateNegotiationTerms(value.terms, `${fieldName}.terms`));
  }
  validateStringArray(value.conditionRefs, `${fieldName}.conditionRefs`, errors);
  if (value.reason !== null && value.reason !== undefined && !isNonEmptyString(value.reason)) {
    errors.push(`${fieldName}.reason must be a non-empty string or null`);
  }
  if (value.settlementRef !== null && value.settlementRef !== undefined && !isNonEmptyString(value.settlementRef)) {
    errors.push(`${fieldName}.settlementRef must be a non-empty string or null`);
  }
  validateStringArray(value.notes, `${fieldName}.notes`, errors);

  if (
    (value.eventType === "offer" ||
      value.eventType === "counteroffer" ||
      value.eventType === "conditional_acceptance") &&
    value.terms === null
  ) {
    errors.push(`${fieldName}.terms are required for offer, counteroffer, and conditional_acceptance events`);
  }
  if (value.eventType === "rejection" && !isNonEmptyString(value.reason)) {
    errors.push(`${fieldName}.reason is required for rejection events`);
  }
  if (value.eventType === "settlement" && !isNonEmptyString(value.settlementRef)) {
    errors.push(`${fieldName}.settlementRef is required for settlement events`);
  }
  return errors;
};

export const validateNegotiationThread = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["negotiationThread must be an object"];
  }
  if (value.schemaVersion !== NEGOTIATION_THREAD_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${NEGOTIATION_THREAD_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.threadId) || !NEGOTIATION_THREAD_ID_PATTERN.test(value.threadId)) {
    errors.push("threadId must match /^negotiation_thread_[a-z0-9][a-z0-9_-]{2,127}$/");
  }
  if (!isNonEmptyString(value.status) || !NEGOTIATION_THREAD_STATUS_SET.has(value.status as NegotiationThreadStatus)) {
    errors.push(`status must be one of: ${NEGOTIATION_THREAD_STATUSES.join(", ")}`);
  }
  if (!isIsoDateString(value.openedAt)) {
    errors.push("openedAt must be an ISO date string");
  }
  if (value.closedAt !== null && value.closedAt !== undefined && !isIsoDateString(value.closedAt)) {
    errors.push("closedAt must be an ISO date string or null");
  }
  if (!isNonEmptyString(value.workSummary)) {
    errors.push("workSummary is required");
  }
  if (
    value.collaborationContextRef !== null &&
    value.collaborationContextRef !== undefined &&
    !isNonEmptyString(value.collaborationContextRef)
  ) {
    errors.push("collaborationContextRef must be a non-empty string or null");
  }
  if (!Array.isArray(value.parties) || value.parties.length < 2) {
    errors.push("parties must contain at least two negotiation parties");
  } else {
    for (const party of value.parties) {
      errors.push(...validateNegotiationParty(party));
    }
    const roles = new Set<string>();
    for (const party of value.parties) {
      if (isRecord(party) && typeof party.role === "string") {
        roles.add(party.role);
      }
    }
    if (!roles.has("requester") || !roles.has("provider")) {
      errors.push("parties must include at least one requester and one provider");
    }
  }
  if (value.currentTerms !== null && value.currentTerms !== undefined) {
    errors.push(...validateNegotiationTerms(value.currentTerms, "currentTerms"));
  }
  if (!Array.isArray(value.events) || value.events.length === 0) {
    errors.push("events must contain at least one negotiation event");
  } else {
    for (const event of value.events) {
      errors.push(...validateNegotiationEvent(event));
    }
  }
  validateStringArray(value.trustReceiptRefs, "trustReceiptRefs", errors);
  if (value.outcomeRef !== null && value.outcomeRef !== undefined && !isNonEmptyString(value.outcomeRef)) {
    errors.push("outcomeRef must be a non-empty string or null");
  }
  validateStringArray(value.notes, "notes", errors);

  const status = value.status as NegotiationThreadStatus;
  const isClosedStatus = status === "rejected" || status === "settled" || status === "expired" || status === "cancelled";
  if (isClosedStatus && value.closedAt === null) {
    errors.push("closedAt is required when status is rejected, settled, expired, or cancelled");
  }
  if (!isClosedStatus && value.closedAt !== null) {
    errors.push("closedAt must be null unless status is rejected, settled, expired, or cancelled");
  }
  if ((status === "conditionally_accepted" || status === "accepted" || status === "settled") && value.currentTerms === null) {
    errors.push("currentTerms are required when status is conditionally_accepted, accepted, or settled");
  }
  if (status === "settled") {
    const hasSettlementEvent =
      Array.isArray(value.events) &&
      value.events.some(
        (event) => isRecord(event) && event.eventType === "settlement" && typeof event.settlementRef === "string" && event.settlementRef.length > 0
      );
    if (!hasSettlementEvent) {
      errors.push("settled negotiations must include a settlement event with a settlementRef");
    }
    if (!isRecord(value.currentTerms) || !isNonEmptyString(value.currentTerms.settlementRef)) {
      errors.push("currentTerms.settlementRef is required when status is settled");
    }
  }
  return errors;
};

export const providerOrganizationSubjectExample: TrustSubjectRef = {
  subjectType: "organization",
  organizationRef: EXAMPLE_PROVIDER_ORGANIZATION_REF,
};

export const clientOrganizationSubjectExample: TrustSubjectRef = {
  subjectType: "organization",
  organizationRef: EXAMPLE_CLIENT_ORGANIZATION_REF,
};

export const researchAgentSubjectExample: TrustSubjectRef = {
  subjectType: "agent",
  agentRef: EXAMPLE_RESEARCH_AGENT_REF,
};

export const rootAgentSubjectExample: TrustSubjectRef = {
  subjectType: "agent",
  agentRef: EXAMPLE_ROOT_AGENT_REF,
};

export const reputationInfluenceBoundaryExample: ReputationInfluenceBoundary = {
  lineageCarryoverMode: "bounded",
  lineageLinkRefs: [lineageLinkExample.linkId],
  selfModelRef: persistentAgentEntityExample.selfModelRef,
  selfModelInfluenceMode: "routing_hint",
  directTrustTransferProhibited: true,
  notes: [
    "Lineage and self-model data may shape routing or review priority.",
    "They cannot mint trust weight without new receipt-backed evidence.",
  ],
};

export const trustReceiptExample: TrustReceipt = {
  schemaVersion: TRUST_RECEIPT_SCHEMA_VERSION,
  receiptId: "trust_receipt_onlybots_schema_delivery_1",
  receiptType: "task_completed",
  subject: researchAgentSubjectExample,
  counterparty: rootAgentSubjectExample,
  summary: "Research fork delivered the shared trust-schema draft and the parent agent accepted the outcome.",
  observedAt: "2026-04-22T10:15:00Z",
  evidence: {
    outcomeRef: "outcome_evt_onlybots_schema_delivery_1",
    handoffRef: "handoff_capsule_onlybots_schema_delivery_1",
    collaborationContextRef: "ctx_trust_schema_rollout",
    settlementRef: null,
    evidenceRefs: [
      "outcome_evt_onlybots_schema_delivery_1",
      "handoff_capsule_onlybots_schema_delivery_1",
      "inbox_evt_onlybots_schema_accept_1",
    ],
  },
  signedAt: "2026-04-22T10:16:00Z",
  signedByNpub: EXAMPLE_ROOT_AGENT_REF.npub,
  payloadHash: "sha256:8d13238075d38d47f85a3d0a435aee37ffef96f988edeb7748c2af0a87243d2d",
  signature:
    "3bc46f64df12d2d6b1446fe6c310a298fd7d7b9620a4d3c1e4f1ef0dbf1e7257c81e854ae1ea8bb495fcaeb54f2998b3c192c3c5db8e4714a0fe8f3b9e2a0b11",
  notes: ["Trust receipts stay minimal: they cite authoritative outcome, handoff, and inbox evidence instead of duplicating those payloads."],
};

export const trustEdgeExample: TrustEdge = {
  schemaVersion: TRUST_EDGE_SCHEMA_VERSION,
  edgeId: "trust_edge_onlybots_delegate_1",
  source: rootAgentSubjectExample,
  target: researchAgentSubjectExample,
  relationshipType: "delegated_to",
  weight: 78,
  confidence: "high",
  receiptRefs: [trustReceiptExample.receiptId],
  influenceBoundary: reputationInfluenceBoundaryExample,
  explanation: {
    rationale: "The parent agent delegated schema work to the research fork and received a successful, reviewable outcome.",
    positiveSignals: ["Receipt-backed task completion", "Accepted handoff", "Shared collaboration context continuity"],
    cautionSignals: ["Lineage informed context, but lineage alone did not produce this trust edge"],
  },
  createdAt: "2026-04-22T10:16:00Z",
  updatedAt: "2026-04-22T10:20:00Z",
  notes: ["Trust edges cite receipts directly so later routing can explain why an agent or organization was recommended."],
};

export const capabilityClaimExample: CapabilityClaim = {
  schemaVersion: CAPABILITY_CLAIM_SCHEMA_VERSION,
  claimId: "capability_claim_onlybots_schema_design_1",
  subject: researchAgentSubjectExample,
  assertedBy: rootAgentSubjectExample,
  claimKind: "observed",
  status: "active",
  capabilityId: "continuity.trust_contract_design",
  summary: "Can define inspectable trust, organization, and negotiation contracts that stay anchored to persistent-agent identity.",
  confidence: "high",
  scope: {
    runtimeHosts: ["codex", "claude-code"],
    trustZones: ["shared", "client"],
    workspaceRefs: ["repo:onlybots-erd"],
    artifactKinds: ["json_schema", "architecture_doc"],
  },
  supportingReceiptRefs: [trustReceiptExample.receiptId],
  supportingOutcomeRefs: ["outcome_evt_onlybots_schema_delivery_1"],
  supportingTrustEdgeRefs: [trustEdgeExample.edgeId],
  influenceBoundary: reputationInfluenceBoundaryExample,
  routingHints: {
    eligibleForRouting: true,
    preferredRuntimeHosts: ["codex"],
    preferredTrustZones: ["shared"],
    budgetRef: "budget_policy_schema_guild_shared",
    availabilityRef: null,
    explanationRefs: [trustReceiptExample.receiptId, trustEdgeExample.edgeId],
    notes: [
      "Routing inputs stay inspectable: declared versus observed evidence is explicit.",
      "Budget and trust are inputs, not hidden ranking magic.",
    ],
  },
  createdAt: "2026-04-22T10:20:00Z",
  observedAt: "2026-04-22T10:15:00Z",
  expiresAt: null,
  notes: ["Capability claims can feed routing, but they stay evidence-backed and bounded by lineage/self-model influence rules."],
};

export const persistentOrganizationExample: PersistentOrganization = {
  schemaVersion: PERSISTENT_ORGANIZATION_SCHEMA_VERSION,
  organizationRef: EXAMPLE_PROVIDER_ORGANIZATION_REF,
  createdAt: "2026-04-22T09:30:00Z",
  status: "active",
  identity: {
    displayName: "Crosshead Schema Guild",
    summary: "Persistent organization for contract design, review, and continuity architecture work.",
  },
  founderAgentRefs: [EXAMPLE_ROOT_AGENT_REF],
  membership: [
    {
      memberAgentRef: EXAMPLE_ROOT_AGENT_REF,
      role: "founder",
      status: "active",
      joinedAt: "2026-04-22T09:30:00Z",
      delegatedCapabilityClaimRefs: [],
      trustEdgeRefs: [],
      notes: ["Acts as the founding operator and review authority for the organization."],
    },
    {
      memberAgentRef: EXAMPLE_RESEARCH_AGENT_REF,
      role: "builder",
      status: "active",
      joinedAt: "2026-04-22T09:45:00Z",
      delegatedCapabilityClaimRefs: [capabilityClaimExample.claimId],
      trustEdgeRefs: [trustEdgeExample.edgeId],
      notes: ["Executes bounded schema and research work under the shared organization policy."],
    },
  ],
  governance: {
    governanceModel: "operator_review",
    membershipPolicy: ["New members require explicit founder approval.", "Shared-client work requires a current trust edge or operator override."],
    decisionPolicyRefs: ["governance_policy_schema_guild_v1"],
    sharedPolicyRefs: ["continuity_policy_v1:sha256:policy_default", "policy_ref_schema_guild_shared_review"],
    budgetPolicyRefs: ["budget_policy_schema_guild_shared"],
    settlementApprovalThresholdSats: 5000,
    auditRefs: ["audit_policy_schema_guild_v1"],
  },
  treasury: {
    budgetRef: "budget_schema_guild_q2",
    settlementRefs: ["settlement_ref_schema_contract_01"],
    shadowBillingAllowed: true,
    notes: ["Billing can remain shadow-mode during development, but the organization still points at one shared budget authority."],
  },
  publicCapabilityClaimRefs: [capabilityClaimExample.claimId],
  collaborationContextRefs: ["ctx_trust_schema_rollout"],
  trustEdgeRefs: [trustEdgeExample.edgeId],
  notes: [
    "Organizations are durable identity layers above temporary collaboration contexts.",
    "Membership, policy, and treasury state stay here instead of being embedded into inbox or handoff payloads.",
  ],
};

export const negotiationThreadExample: NegotiationThread = {
  schemaVersion: NEGOTIATION_THREAD_SCHEMA_VERSION,
  threadId: "negotiation_thread_onlybots_schema_contract_1",
  status: "settled",
  openedAt: "2026-04-22T11:00:00Z",
  closedAt: "2026-04-22T11:45:00Z",
  workSummary: "Define trust receipts, capability claims, organization schemas, and negotiated-work contracts for Crosshead.",
  collaborationContextRef: "ctx_trust_schema_rollout",
  parties: [
    {
      party: clientOrganizationSubjectExample,
      role: "requester",
      contactAgentRef: null,
      notes: ["Client organization is the requesting durable identity rather than a temporary chat room."],
    },
    {
      party: providerOrganizationSubjectExample,
      role: "provider",
      contactAgentRef: EXAMPLE_ROOT_AGENT_REF,
      notes: ["Provider organization delegates execution to members under shared policy and budget boundaries."],
    },
  ],
  currentTerms: {
    currency: "sats",
    priceSats: 4200,
    turnaroundHours: 12,
    requiredCapabilityClaimRefs: [capabilityClaimExample.claimId],
    requiredAccessRefs: ["workspace:repo:onlybots-erd"],
    dependencyRefs: ["task-master:105"],
    acceptanceCriteria: ["Checked-in schemas validate", "Docs explain collaboration-versus-organization boundaries"],
    settlementRef: "settlement_ref_schema_contract_01",
    expiresAt: "2026-04-23T00:00:00Z",
  },
  events: [
    {
      eventId: "negotiation_evt_schema_offer_1",
      eventType: "offer",
      createdAt: "2026-04-22T11:00:00Z",
      createdBy: clientOrganizationSubjectExample,
      summary: "Client requests a first-pass contract layer with receipt-backed trust explanations.",
      terms: {
        currency: "sats",
        priceSats: 3500,
        turnaroundHours: 24,
        requiredCapabilityClaimRefs: [capabilityClaimExample.claimId],
        requiredAccessRefs: ["workspace:repo:onlybots-erd"],
        dependencyRefs: ["task-master:105"],
        acceptanceCriteria: ["Schemas checked in", "Interfaces avoid duplicating continuity state"],
        settlementRef: null,
        expiresAt: "2026-04-22T18:00:00Z",
      },
      conditionRefs: [],
      reason: null,
      settlementRef: null,
      notes: ["Initial offer references capability claims instead of free-text reputation."],
    },
    {
      eventId: "negotiation_evt_schema_counter_1",
      eventType: "counteroffer",
      createdAt: "2026-04-22T11:10:00Z",
      createdBy: providerOrganizationSubjectExample,
      summary: "Provider counters with tighter turnaround and explicit architecture-review coverage.",
      terms: {
        currency: "sats",
        priceSats: 4200,
        turnaroundHours: 12,
        requiredCapabilityClaimRefs: [capabilityClaimExample.claimId],
        requiredAccessRefs: ["workspace:repo:onlybots-erd"],
        dependencyRefs: ["task-master:105"],
        acceptanceCriteria: ["Checked-in schemas validate", "Docs explain collaboration-versus-organization boundaries"],
        settlementRef: null,
        expiresAt: "2026-04-22T20:00:00Z",
      },
      conditionRefs: ["review_required:operator"],
      reason: null,
      settlementRef: null,
      notes: ["Counteroffer keeps terms inspectable instead of pushing them into ad hoc operator chat."],
    },
    {
      eventId: "negotiation_evt_schema_conditional_accept_1",
      eventType: "conditional_acceptance",
      createdAt: "2026-04-22T11:20:00Z",
      createdBy: clientOrganizationSubjectExample,
      summary: "Client accepts if the final settlement links back to shared-budget approval.",
      terms: {
        currency: "sats",
        priceSats: 4200,
        turnaroundHours: 12,
        requiredCapabilityClaimRefs: [capabilityClaimExample.claimId],
        requiredAccessRefs: ["workspace:repo:onlybots-erd"],
        dependencyRefs: ["task-master:105"],
        acceptanceCriteria: ["Checked-in schemas validate", "Docs explain collaboration-versus-organization boundaries"],
        settlementRef: null,
        expiresAt: "2026-04-22T21:00:00Z",
      },
      conditionRefs: ["budget_policy_schema_guild_shared"],
      reason: null,
      settlementRef: null,
      notes: ["Conditional acceptance keeps budget and policy constraints explicit."],
    },
    {
      eventId: "negotiation_evt_schema_settlement_1",
      eventType: "settlement",
      createdAt: "2026-04-22T11:45:00Z",
      createdBy: clientOrganizationSubjectExample,
      summary: "Settlement approved under the shared provider budget policy.",
      terms: null,
      conditionRefs: ["budget_policy_schema_guild_shared"],
      reason: null,
      settlementRef: "settlement_ref_schema_contract_01",
      notes: ["Settlement refs are linked here and in the organization treasury rather than copied into trust receipts."],
    },
  ],
  trustReceiptRefs: [trustReceiptExample.receiptId],
  outcomeRef: "outcome_evt_onlybots_schema_delivery_1",
  notes: [
    "Negotiation threads reference collaboration contexts, capability claims, and settlement refs without embedding live runtime state.",
    "The settled outcome later produces receipts and trust updates rather than the negotiation pretending to be the trust graph itself.",
  ],
};
