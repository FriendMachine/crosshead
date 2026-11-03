import type { IsoDateString, Npub } from "./base";
import type { PersistentAgentReference } from "./persistent-agents";
import {
	type GovernanceModel,
	type NegotiationEvent,
	type NegotiationEventType,
	type NegotiationParty,
	type NegotiationTerms,
	type NegotiationThread,
	type NegotiationThreadStatus,
	type OrganizationMemberRole,
	type OrganizationMemberStatus,
	type PersistentOrganization,
	type PersistentOrganizationMember,
	type TrustSubjectRef,
	GOVERNANCE_MODELS,
	NEGOTIATION_EVENT_TYPES,
	NEGOTIATION_THREAD_SCHEMA_VERSION,
	NEGOTIATION_THREAD_STATUSES,
	ORGANIZATION_MEMBER_ROLES,
	ORGANIZATION_MEMBER_STATUSES,
	PERSISTENT_ORGANIZATION_SCHEMA_VERSION,
	validateNegotiationThread,
	validatePersistentOrganization,
} from "./trust";

export const ORGANIZATION_MEMBERSHIP_CHANGE_TYPES = [
	"add_member",
	"remove_member",
	"change_role",
	"change_status",
] as const;

export const NEGOTIATION_DECISION_POSTURES = [
	"offer_pending",
	"countered",
	"conditional_review",
	"accepted",
	"rejected",
	"settled",
] as const;

export type OrganizationMembershipChangeType = (typeof ORGANIZATION_MEMBERSHIP_CHANGE_TYPES)[number];
export type NegotiationDecisionPosture = (typeof NEGOTIATION_DECISION_POSTURES)[number];

export type OrganizationDraftInput = {
	organizationId: string;
	npub: Npub;
	displayName: string;
	summary: string;
	founderAgentRefs: PersistentAgentReference[];
	createdAt: IsoDateString;
	governanceModel?: GovernanceModel;
	membershipPolicy?: string[];
	decisionPolicyRefs?: string[];
	sharedPolicyRefs?: string[];
	budgetPolicyRefs?: string[];
	settlementApprovalThresholdSats?: number | null;
	auditRefs?: string[];
	budgetRef?: string | null;
	settlementRefs?: string[];
	shadowBillingAllowed?: boolean;
	publicCapabilityClaimRefs?: string[];
	collaborationContextRefs?: string[];
	trustEdgeRefs?: string[];
	notes?: string[];
};

export type OrganizationMembershipChange =
	| {
			changeType: "add_member";
			changedAt: IsoDateString;
			actor: TrustSubjectRef | null;
			reason: string | null;
			member: PersistentOrganizationMember;
	  }
	| {
			changeType: "remove_member";
			changedAt: IsoDateString;
			actor: TrustSubjectRef | null;
			reason: string | null;
			agentId: string;
	  }
	| {
			changeType: "change_role";
			changedAt: IsoDateString;
			actor: TrustSubjectRef | null;
			reason: string | null;
			agentId: string;
			role: OrganizationMemberRole;
	  }
	| {
			changeType: "change_status";
			changedAt: IsoDateString;
			actor: TrustSubjectRef | null;
			reason: string | null;
			agentId: string;
			status: OrganizationMemberStatus;
	  };

export type PersistentOrganizationInspection = {
	organizationId: string;
	npub: Npub;
	displayName: string;
	summary: string;
	status: PersistentOrganization["status"];
	governanceModel: GovernanceModel;
	activeMemberCount: number;
	founderCount: number;
	roleCounts: Record<OrganizationMemberRole, number>;
	statusCounts: Record<OrganizationMemberStatus, number>;
	membership: Array<{
		agentId: string;
		npub: Npub;
		lineageRoot: string;
		role: OrganizationMemberRole;
		status: OrganizationMemberStatus;
		joinedAt: IsoDateString;
		delegatedCapabilityClaimRefs: string[];
		trustEdgeRefs: string[];
		notes: string[];
	}>;
	governance: {
		membershipPolicy: string[];
		decisionPolicyRefs: string[];
		sharedPolicyRefs: string[];
		budgetPolicyRefs: string[];
		settlementApprovalThresholdSats: number | null;
		auditRefs: string[];
	};
	treasury: {
		budgetRef: string | null;
		settlementRefs: string[];
		shadowBillingAllowed: boolean;
		notes: string[];
	};
	warnings: string[];
};

export type NegotiationDraftInput = {
	threadId: string;
	workSummary: string;
	openedAt: IsoDateString;
	requester: NegotiationParty;
	provider: NegotiationParty;
	initialEvent: NegotiationEvent;
	collaborationContextRef?: string | null;
	trustReceiptRefs?: string[];
	outcomeRef?: string | null;
	notes?: string[];
};

export type NegotiationDecisionSurface = {
	threadId: string;
	status: NegotiationThreadStatus;
	latestEventType: NegotiationEventType;
	posture: NegotiationDecisionPosture;
	workSummary: string;
	collaborationContextRef: string | null;
	currentTerms: NegotiationTerms | null;
	trustReceiptCount: number;
	positiveSignals: string[];
	cautionSignals: string[];
	blockers: string[];
	recommendedNextActions: string[];
};

export type NegotiationThreadInspection = {
	threadId: string;
	status: NegotiationThreadStatus;
	openedAt: IsoDateString;
	closedAt: IsoDateString | null;
	collaborationContextRef: string | null;
	workSummary: string;
	partySummaries: Array<{
		role: NegotiationParty["role"];
		subject: string;
		contactAgentId: string | null;
	}>;
	currentTerms: NegotiationTerms | null;
	latestEventId: string;
	latestEventType: NegotiationEventType;
	eventCount: number;
	trustReceiptCount: number;
	decisionSurface: NegotiationDecisionSurface;
};

const GOVERNANCE_MODEL_SET = new Set<GovernanceModel>(GOVERNANCE_MODELS);
const MEMBER_ROLE_SET = new Set<OrganizationMemberRole>(ORGANIZATION_MEMBER_ROLES);
const MEMBER_STATUS_SET = new Set<OrganizationMemberStatus>(ORGANIZATION_MEMBER_STATUSES);
const NEGOTIATION_STATUS_SET = new Set<NegotiationThreadStatus>(NEGOTIATION_THREAD_STATUSES);
const NEGOTIATION_EVENT_TYPE_SET = new Set<NegotiationEventType>(NEGOTIATION_EVENT_TYPES);

const clone = <T>(value: T): T => structuredClone(value);

const dedupeStrings = (values: string[]): string[] =>
	Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));

const describeTrustSubject = (value: TrustSubjectRef | null): string => {
	if (!value) {
		return "unknown";
	}
	return value.subjectType === "agent"
		? `agent:${value.agentRef.agentId}`
		: `organization:${value.organizationRef.organizationId}`;
};

const appendAuditNote = (
	notes: string[],
	input: {
		changedAt: IsoDateString;
		actor: TrustSubjectRef | null;
		changeType: OrganizationMembershipChangeType;
		reason: string | null;
		target: string;
	}
): string[] => {
	const reasonSuffix = input.reason && input.reason.trim().length > 0 ? ` reason=${input.reason.trim()}` : "";
	return dedupeStrings([
		...notes,
		`${input.changedAt} ${input.changeType} ${input.target} by ${describeTrustSubject(input.actor)}${reasonSuffix}`,
	]);
};

const buildEmptyRoleCounts = (): Record<OrganizationMemberRole, number> =>
	Object.fromEntries(ORGANIZATION_MEMBER_ROLES.map((role) => [role, 0])) as Record<OrganizationMemberRole, number>;

const buildEmptyStatusCounts = (): Record<OrganizationMemberStatus, number> =>
	Object.fromEntries(ORGANIZATION_MEMBER_STATUSES.map((status) => [status, 0])) as Record<OrganizationMemberStatus, number>;

const assertValidOrganization = (organization: PersistentOrganization): PersistentOrganization => {
	const errors = validatePersistentOrganization(organization);
	if (errors.length > 0) {
		throw new Error(errors.join("\n"));
	}
	return organization;
};

const assertValidNegotiation = (thread: NegotiationThread): NegotiationThread => {
	const errors = validateNegotiationThread(thread);
	if (errors.length > 0) {
		throw new Error(errors.join("\n"));
	}
	return thread;
};

const deriveNegotiationStatus = (
	currentStatus: NegotiationThreadStatus,
	event: NegotiationEvent
): NegotiationThreadStatus => {
	if (!NEGOTIATION_STATUS_SET.has(currentStatus) || !NEGOTIATION_EVENT_TYPE_SET.has(event.eventType)) {
		throw new Error("invalid negotiation transition input");
	}
	if (["settled", "rejected", "expired", "cancelled"].includes(currentStatus)) {
		throw new Error(`cannot append ${event.eventType} to terminal negotiation status ${currentStatus}`);
	}
	switch (event.eventType) {
		case "offer":
		case "counteroffer":
			return "open";
		case "conditional_acceptance":
			return event.conditionRefs.length > 0 ? "conditionally_accepted" : "accepted";
		case "rejection":
			return "rejected";
		case "settlement":
			if (!event.settlementRef) {
				throw new Error("settlement events require settlementRef");
			}
			return "settled";
		case "note":
			return currentStatus;
		default:
			throw new Error(`unsupported negotiation event type ${event.eventType satisfies never}`);
	}
};

const mergeCurrentTerms = (
	currentTerms: NegotiationTerms | null,
	event: NegotiationEvent,
	status: NegotiationThreadStatus
): NegotiationTerms | null => {
	if (event.terms) {
		return clone(event.terms);
	}
	if (event.eventType === "settlement" && currentTerms) {
		return {
			...clone(currentTerms),
			settlementRef: event.settlementRef,
		};
	}
	if (status === "rejected") {
		return currentTerms ? clone(currentTerms) : null;
	}
	return currentTerms ? clone(currentTerms) : null;
};

const describeTerms = (terms: NegotiationTerms | null): string[] => {
	if (!terms) {
		return [];
	}
	const signals: string[] = [];
	if (typeof terms.priceSats === "number") {
		signals.push(`price ${terms.priceSats} sats is explicit`);
	}
	if (typeof terms.turnaroundHours === "number") {
		signals.push(`turnaround ${terms.turnaroundHours}h is explicit`);
	}
	if (terms.requiredCapabilityClaimRefs.length > 0) {
		signals.push(`requires ${terms.requiredCapabilityClaimRefs.length} capability claim refs`);
	}
	if (terms.requiredAccessRefs.length > 0) {
		signals.push(`requires ${terms.requiredAccessRefs.length} access refs`);
	}
	if (terms.dependencyRefs.length > 0) {
		signals.push(`tracks ${terms.dependencyRefs.length} explicit dependencies`);
	}
	return signals;
};

export const buildPersistentOrganizationDraft = (input: OrganizationDraftInput): PersistentOrganization =>
	assertValidOrganization({
		schemaVersion: PERSISTENT_ORGANIZATION_SCHEMA_VERSION,
		organizationRef: {
			organizationId: input.organizationId,
			npub: input.npub,
		},
		createdAt: input.createdAt,
		status: "active",
		identity: {
			displayName: input.displayName,
			summary: input.summary,
		},
		founderAgentRefs: clone(input.founderAgentRefs),
		membership: input.founderAgentRefs.map((memberAgentRef) => ({
			memberAgentRef: clone(memberAgentRef),
			role: "founder",
			status: "active",
			joinedAt: input.createdAt,
			delegatedCapabilityClaimRefs: [],
			trustEdgeRefs: [],
			notes: ["Founding organization member."],
		})),
		governance: {
			governanceModel: input.governanceModel ?? "operator_review",
			membershipPolicy: dedupeStrings(input.membershipPolicy ?? []),
			decisionPolicyRefs: dedupeStrings(input.decisionPolicyRefs ?? []),
			sharedPolicyRefs: dedupeStrings(input.sharedPolicyRefs ?? []),
			budgetPolicyRefs: dedupeStrings(input.budgetPolicyRefs ?? []),
			settlementApprovalThresholdSats:
				typeof input.settlementApprovalThresholdSats === "number" ? input.settlementApprovalThresholdSats : null,
			auditRefs: dedupeStrings(input.auditRefs ?? []),
		},
		treasury: {
			budgetRef: input.budgetRef ?? null,
			settlementRefs: dedupeStrings(input.settlementRefs ?? []),
			shadowBillingAllowed: input.shadowBillingAllowed ?? true,
			notes: [],
		},
		publicCapabilityClaimRefs: dedupeStrings(input.publicCapabilityClaimRefs ?? []),
		collaborationContextRefs: dedupeStrings(input.collaborationContextRefs ?? []),
		trustEdgeRefs: dedupeStrings(input.trustEdgeRefs ?? []),
		notes: dedupeStrings(input.notes ?? []),
	});

export const applyOrganizationMembershipChange = (
	organization: PersistentOrganization,
	change: OrganizationMembershipChange
): PersistentOrganization => {
	const next = clone(organization);
	const index = next.membership.findIndex((entry) => entry.memberAgentRef.agentId === ("member" in change ? change.member.memberAgentRef.agentId : change.agentId));
	if (change.changeType === "add_member") {
		const memberAgentId = change.member.memberAgentRef.agentId;
		if (index >= 0) {
			const existing = next.membership[index]!;
			if (existing.status !== "former") {
				throw new Error(`organization already includes active member ${memberAgentId}`);
			}
			next.membership[index] = {
				...clone(change.member),
				notes: appendAuditNote(change.member.notes, {
					changedAt: change.changedAt,
					actor: change.actor,
					changeType: change.changeType,
					reason: change.reason,
					target: memberAgentId,
				}),
			};
		} else {
			next.membership.push({
				...clone(change.member),
				notes: appendAuditNote(change.member.notes, {
					changedAt: change.changedAt,
					actor: change.actor,
					changeType: change.changeType,
					reason: change.reason,
					target: memberAgentId,
				}),
			});
		}
		next.notes = appendAuditNote(next.notes, {
			changedAt: change.changedAt,
			actor: change.actor,
			changeType: change.changeType,
			reason: change.reason,
			target: memberAgentId,
		});
		return assertValidOrganization(next);
	}

	if (index < 0) {
		throw new Error(`organization member ${change.agentId} not found`);
	}

	const member = next.membership[index]!;
	if (change.changeType === "remove_member") {
		const remainingActiveFounders = next.membership.filter(
			(entry) => entry.role === "founder" && entry.status === "active" && entry.memberAgentRef.agentId !== change.agentId
		);
		if (member.role === "founder" && member.status === "active" && remainingActiveFounders.length === 0) {
			throw new Error("cannot remove the last active founder from an organization");
		}
		member.status = "former";
		member.notes = appendAuditNote(member.notes, {
			changedAt: change.changedAt,
			actor: change.actor,
			changeType: change.changeType,
			reason: change.reason,
			target: change.agentId,
		});
		next.notes = appendAuditNote(next.notes, {
			changedAt: change.changedAt,
			actor: change.actor,
			changeType: change.changeType,
			reason: change.reason,
			target: change.agentId,
		});
		return assertValidOrganization(next);
	}

	if (change.changeType === "change_role") {
		member.role = change.role;
		member.notes = appendAuditNote(member.notes, {
			changedAt: change.changedAt,
			actor: change.actor,
			changeType: change.changeType,
			reason: change.reason,
			target: change.agentId,
		});
		next.notes = appendAuditNote(next.notes, {
			changedAt: change.changedAt,
			actor: change.actor,
			changeType: change.changeType,
			reason: change.reason,
			target: change.agentId,
		});
		return assertValidOrganization(next);
	}

	member.status = change.status;
	member.notes = appendAuditNote(member.notes, {
		changedAt: change.changedAt,
		actor: change.actor,
		changeType: change.changeType,
		reason: change.reason,
		target: change.agentId,
	});
	next.notes = appendAuditNote(next.notes, {
		changedAt: change.changedAt,
		actor: change.actor,
		changeType: change.changeType,
		reason: change.reason,
		target: change.agentId,
	});
	return assertValidOrganization(next);
};

export const inspectPersistentOrganization = (organization: PersistentOrganization): PersistentOrganizationInspection => {
	assertValidOrganization(organization);
	const roleCounts = buildEmptyRoleCounts();
	const statusCounts = buildEmptyStatusCounts();
	for (const member of organization.membership) {
		roleCounts[member.role] += 1;
		statusCounts[member.status] += 1;
	}
	const warnings: string[] = [];
	if (statusCounts.active === 0) {
		warnings.push("organization has no active members");
	}
	if (roleCounts.founder === 0) {
		warnings.push("organization has no founder members");
	}
	if (!organization.treasury.budgetRef) {
		warnings.push("organization does not point at a shared budget reference");
	}
	if (organization.governance.sharedPolicyRefs.length === 0) {
		warnings.push("organization does not declare shared policy refs");
	}
	return {
		organizationId: organization.organizationRef.organizationId,
		npub: organization.organizationRef.npub,
		displayName: organization.identity.displayName,
		summary: organization.identity.summary,
		status: organization.status,
		governanceModel: organization.governance.governanceModel,
		activeMemberCount: statusCounts.active,
		founderCount: roleCounts.founder,
		roleCounts,
		statusCounts,
		membership: organization.membership.map((member) => ({
			agentId: member.memberAgentRef.agentId,
			npub: member.memberAgentRef.npub,
			lineageRoot: member.memberAgentRef.lineageRoot,
			role: member.role,
			status: member.status,
			joinedAt: member.joinedAt,
			delegatedCapabilityClaimRefs: clone(member.delegatedCapabilityClaimRefs),
			trustEdgeRefs: clone(member.trustEdgeRefs),
			notes: clone(member.notes),
		})),
		governance: {
			membershipPolicy: clone(organization.governance.membershipPolicy),
			decisionPolicyRefs: clone(organization.governance.decisionPolicyRefs),
			sharedPolicyRefs: clone(organization.governance.sharedPolicyRefs),
			budgetPolicyRefs: clone(organization.governance.budgetPolicyRefs),
			settlementApprovalThresholdSats: organization.governance.settlementApprovalThresholdSats,
			auditRefs: clone(organization.governance.auditRefs),
		},
		treasury: {
			budgetRef: organization.treasury.budgetRef,
			settlementRefs: clone(organization.treasury.settlementRefs),
			shadowBillingAllowed: organization.treasury.shadowBillingAllowed,
			notes: clone(organization.treasury.notes),
		},
		warnings,
	};
};

export const buildNegotiationThreadDraft = (input: NegotiationDraftInput): NegotiationThread => {
	if (input.initialEvent.eventType !== "offer") {
		throw new Error("negotiation init requires an initial offer event");
	}
	return assertValidNegotiation({
		schemaVersion: NEGOTIATION_THREAD_SCHEMA_VERSION,
		threadId: input.threadId,
		status: "open",
		openedAt: input.openedAt,
		closedAt: null,
		workSummary: input.workSummary,
		collaborationContextRef: input.collaborationContextRef ?? null,
		parties: [clone(input.requester), clone(input.provider)],
		currentTerms: input.initialEvent.terms ? clone(input.initialEvent.terms) : null,
		events: [clone(input.initialEvent)],
		trustReceiptRefs: dedupeStrings(input.trustReceiptRefs ?? []),
		outcomeRef: input.outcomeRef ?? null,
		notes: dedupeStrings(input.notes ?? []),
	});
};

export const appendNegotiationEvent = (
	thread: NegotiationThread,
	event: NegotiationEvent
): NegotiationThread => {
	const next = clone(thread);
	const nextStatus = deriveNegotiationStatus(next.status, event);
	next.events.push(clone(event));
	next.status = nextStatus;
	next.currentTerms = mergeCurrentTerms(next.currentTerms, event, nextStatus);
	if (nextStatus === "settled" || nextStatus === "rejected") {
		next.closedAt = event.createdAt;
	} else if (next.closedAt && !["expired", "cancelled"].includes(nextStatus)) {
		next.closedAt = null;
	}
	if (event.settlementRef) {
		next.notes = dedupeStrings([
			...next.notes,
			`${event.createdAt} settlement_ref ${event.settlementRef} linked by ${describeTrustSubject(event.createdBy)}`,
		]);
	}
	return assertValidNegotiation(next);
};

export const explainNegotiationDecision = (thread: NegotiationThread): NegotiationDecisionSurface => {
	assertValidNegotiation(thread);
	const latestEvent = thread.events[thread.events.length - 1];
	if (!latestEvent) {
		throw new Error("negotiation thread must contain at least one event");
	}
	const positiveSignals = [
		...describeTerms(thread.currentTerms),
		...(thread.trustReceiptRefs.length > 0 ? [`trust receipt refs: ${thread.trustReceiptRefs.length}`] : []),
		...(thread.collaborationContextRef ? [`collaboration context attached: ${thread.collaborationContextRef}`] : []),
	];
	const cautionSignals: string[] = [];
	const blockers: string[] = [];
	const recommendedNextActions: string[] = [];
	const terms = thread.currentTerms;
	if (terms && terms.expiresAt) {
		cautionSignals.push(`terms expire at ${terms.expiresAt}`);
	}
	if (terms && terms.settlementRef === null && thread.status !== "settled") {
		cautionSignals.push("settlement ref is not linked yet");
	}
	let posture: NegotiationDecisionPosture;
	switch (thread.status) {
		case "settled":
			posture = "settled";
			positiveSignals.push(`settled via ${latestEvent.settlementRef ?? "linked settlement ref"}`);
			recommendedNextActions.push("Record the resulting delivery outcome and trust receipt.");
			break;
		case "rejected":
			posture = "rejected";
			if (latestEvent.reason) {
				blockers.push(latestEvent.reason);
			} else {
				blockers.push("latest event rejected the current negotiation terms");
			}
			recommendedNextActions.push("Open a new thread or issue a fresh offer with materially different terms.");
			break;
		case "conditionally_accepted":
			posture = "conditional_review";
			blockers.push(...latestEvent.conditionRefs);
			recommendedNextActions.push("Resolve the listed conditions before treating the work as accepted.");
			break;
		case "accepted":
			posture = "accepted";
			positiveSignals.push("current terms have been accepted without remaining explicit conditions");
			recommendedNextActions.push("Link a settlement ref or collaboration context before execution begins.");
			break;
		case "open":
		default:
			posture = latestEvent.eventType === "counteroffer" ? "countered" : "offer_pending";
			if (latestEvent.conditionRefs.length > 0) {
				blockers.push(...latestEvent.conditionRefs);
			}
			recommendedNextActions.push(
				latestEvent.eventType === "counteroffer"
					? "Review the counteroffer and either accept it conditionally, reject it, or counter again."
					: "Inspect the current offer terms and decide whether to counter, conditionally accept, or reject."
			);
			break;
	}
	if (terms && terms.requiredCapabilityClaimRefs.length === 0) {
		cautionSignals.push("current terms do not cite any capability claim refs");
	}
	if (terms && terms.requiredAccessRefs.length === 0) {
		cautionSignals.push("current terms do not cite any access refs");
	}
	return {
		threadId: thread.threadId,
		status: thread.status,
		latestEventType: latestEvent.eventType,
		posture,
		workSummary: thread.workSummary,
		collaborationContextRef: thread.collaborationContextRef,
		currentTerms: terms ? clone(terms) : null,
		trustReceiptCount: thread.trustReceiptRefs.length,
		positiveSignals: dedupeStrings(positiveSignals),
		cautionSignals: dedupeStrings(cautionSignals),
		blockers: dedupeStrings(blockers),
		recommendedNextActions: dedupeStrings(recommendedNextActions),
	};
};

export const inspectNegotiationThread = (thread: NegotiationThread): NegotiationThreadInspection => {
	assertValidNegotiation(thread);
	const latestEvent = thread.events[thread.events.length - 1];
	if (!latestEvent) {
		throw new Error("negotiation thread must contain at least one event");
	}
	return {
		threadId: thread.threadId,
		status: thread.status,
		openedAt: thread.openedAt,
		closedAt: thread.closedAt,
		collaborationContextRef: thread.collaborationContextRef,
		workSummary: thread.workSummary,
		partySummaries: thread.parties.map((party) => ({
			role: party.role,
			subject: describeTrustSubject(party.party),
			contactAgentId: party.contactAgentRef?.agentId ?? null,
		})),
		currentTerms: thread.currentTerms ? clone(thread.currentTerms) : null,
		latestEventId: latestEvent.eventId,
		latestEventType: latestEvent.eventType,
		eventCount: thread.events.length,
		trustReceiptCount: thread.trustReceiptRefs.length,
		decisionSurface: explainNegotiationDecision(thread),
	};
};
