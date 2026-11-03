import { randomUUID } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import path from "path";

import type { IsoDateString } from "../protocol/base";
import type { NegotiationEvent, NegotiationTerms, NegotiationThread, OrganizationMemberRole, OrganizationMemberStatus, PersistentOrganization, TrustSubjectRef } from "../protocol/trust";
import type { OrganizationDraftInput } from "../protocol/economic-governance";
import type { PersistentAgentReference } from "../protocol/persistent-agents";
import { applyOrganizationMembershipChange, appendNegotiationEvent, buildNegotiationThreadDraft, buildPersistentOrganizationDraft, explainNegotiationDecision, inspectNegotiationThread, inspectPersistentOrganization } from "../protocol/economic-governance";

const parseArgs = (args: string[]): { positionals: string[]; flags: Record<string, string | boolean> } => {
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index]!;
		if (!value.startsWith("--")) {
			positionals.push(value);
			continue;
		}
		const key = value.slice(2);
		const next = args[index + 1];
		if (!next || next.startsWith("--")) {
			flags[key] = true;
			continue;
		}
		flags[key] = next;
		index += 1;
	}
	return { positionals, flags };
};

const nowIso = (): IsoDateString => new Date().toISOString();

const csv = (value: string | boolean | undefined): string[] =>
	typeof value === "string"
		? value
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0)
		: [];

const readFlagString = (
	flags: Record<string, string | boolean>,
	...keys: string[]
): string | undefined => {
	for (const key of keys) {
		const value = flags[key];
		if (typeof value === "string") {
			return value;
		}
	}
	return undefined;
};

const readFlagBoolean = (
	flags: Record<string, string | boolean>,
	...keys: string[]
): boolean | undefined => {
	for (const key of keys) {
		const value = flags[key];
		if (typeof value === "boolean") {
			return value;
		}
		if (typeof value === "string") {
			const normalized = value.trim().toLowerCase();
			if (["true", "1", "yes", "y", "on"].includes(normalized)) {
				return true;
			}
			if (["false", "0", "no", "n", "off"].includes(normalized)) {
				return false;
			}
			throw new Error(`invalid boolean value for --${key}: ${value}`);
		}
	}
	return undefined;
};

const writeJsonFile = (filePath: string, value: unknown): void => {
	writeFileSync(path.resolve(filePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const readJsonDocument = <T>(filePath: string): T => JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as T;

const persistDocument = (
	value: unknown,
	flags: Record<string, string | boolean>,
	defaultInputPath?: string
): { text: string; wrote: string | null } => {
	const outputPath =
		typeof flags.output === "string"
			? flags.output
			: flags.write === true && defaultInputPath
				? defaultInputPath
				: typeof flags.file === "string" && !defaultInputPath
					? flags.file
					: null;
	if (outputPath) {
		writeJsonFile(outputPath, value);
		return { text: JSON.stringify({ wrote: true, file: path.resolve(outputPath) }, null, 2), wrote: path.resolve(outputPath) };
	}
	return { text: JSON.stringify(value, null, 2), wrote: null };
};

const formatOrganizationInspection = (inspection: ReturnType<typeof inspectPersistentOrganization>): string =>
	[
		`${inspection.displayName} (${inspection.organizationId})`,
		`status: ${inspection.status} governance=${inspection.governanceModel} active_members=${inspection.activeMemberCount}`,
		`roles: ${Object.entries(inspection.roleCounts)
			.map(([role, count]) => `${role}=${count}`)
			.join(" ")}`,
		`member_statuses: ${Object.entries(inspection.statusCounts)
			.map(([status, count]) => `${status}=${count}`)
			.join(" ")}`,
		`shared_policy_refs: ${inspection.governance.sharedPolicyRefs.join(", ") || "none"}`,
		`budget_policy_refs: ${inspection.governance.budgetPolicyRefs.join(", ") || "none"}`,
		`budget_ref: ${inspection.treasury.budgetRef ?? "none"} shadow_billing=${inspection.treasury.shadowBillingAllowed ? "yes" : "no"}`,
		...(inspection.warnings.length > 0 ? [`warnings: ${inspection.warnings.join(" | ")}`] : []),
	].join("\n");

const formatNegotiationInspection = (inspection: ReturnType<typeof inspectNegotiationThread>): string =>
	[
		`${inspection.threadId} ${inspection.status}`,
		`work: ${inspection.workSummary}`,
		`latest_event: ${inspection.latestEventType} (${inspection.latestEventId}) events=${inspection.eventCount}`,
		`parties: ${inspection.partySummaries.map((party) => `${party.role}:${party.subject}`).join(" | ")}`,
		`context: ${inspection.collaborationContextRef ?? "none"} trust_receipts=${inspection.trustReceiptCount}`,
		`decision: ${inspection.decisionSurface.posture}`,
	].join("\n");

const formatNegotiationDecision = (decision: ReturnType<typeof explainNegotiationDecision>): string =>
	[
		`${decision.threadId} ${decision.posture}`,
		`status: ${decision.status} latest_event=${decision.latestEventType}`,
		`positive: ${decision.positiveSignals.join(" | ") || "none"}`,
		`cautions: ${decision.cautionSignals.join(" | ") || "none"}`,
		`blockers: ${decision.blockers.join(" | ") || "none"}`,
		`next: ${decision.recommendedNextActions.join(" | ") || "none"}`,
	].join("\n");

const buildPersistentAgentRef = (
	agentId: string,
	npub: string,
	lineageRoot?: string | null
): PersistentAgentReference => ({
	agentId,
	npub,
	lineageRoot: lineageRoot && lineageRoot.trim().length > 0 ? lineageRoot : agentId,
});

const parseActorSubject = (
	flags: Record<string, string | boolean>,
	prefix: string
): TrustSubjectRef | null => {
	const agentId = readFlagString(flags, `${prefix}-agent-id`, `${prefix}AgentId`);
	const agentNpub = readFlagString(flags, `${prefix}-agent-npub`, `${prefix}AgentNpub`);
	if (agentId && agentNpub) {
		return {
			subjectType: "agent",
			agentRef: buildPersistentAgentRef(
				agentId,
				agentNpub,
				readFlagString(flags, `${prefix}-lineage-root`, `${prefix}LineageRoot`)
			),
		};
	}
	const organizationId = readFlagString(flags, `${prefix}-organization-id`, `${prefix}OrganizationId`);
	const organizationNpub = readFlagString(flags, `${prefix}-organization-npub`, `${prefix}OrganizationNpub`);
	if (organizationId && organizationNpub) {
		return {
			subjectType: "organization",
			organizationRef: {
				organizationId,
				npub: organizationNpub,
			},
		};
	}
	return null;
};

const parseNegotiationParty = (
	flags: Record<string, string | boolean>,
	prefix: "requester" | "provider"
) => {
	const subject = parseActorSubject(flags, prefix);
	if (!subject) {
		throw new Error(`negotiation init requires --${prefix}-agent-* or --${prefix}-organization-* flags`);
	}
	const role = prefix === "requester" ? "requester" : "provider";
	const contactAgentId = readFlagString(flags, `${prefix}-contact-agent-id`, `${prefix}ContactAgentId`);
	const contactAgentNpub = readFlagString(flags, `${prefix}-contact-agent-npub`, `${prefix}ContactAgentNpub`);
	return {
		party: subject,
		role,
		contactAgentRef:
			contactAgentId && contactAgentNpub
				? buildPersistentAgentRef(
						contactAgentId,
						contactAgentNpub,
						readFlagString(flags, `${prefix}-contact-lineage-root`, `${prefix}ContactLineageRoot`)
				  )
				: null,
		notes: csv(flags[`${prefix}-notes`]),
	} as const;
};

const parseTerms = (flags: Record<string, string | boolean>): NegotiationTerms => ({
	currency: "sats",
	priceSats:
		typeof flags["price-sats"] === "string"
			? Number(flags["price-sats"])
			: typeof flags.priceSats === "string"
				? Number(flags.priceSats)
				: null,
	turnaroundHours:
		typeof flags["turnaround-hours"] === "string"
			? Number(flags["turnaround-hours"])
			: typeof flags.turnaroundHours === "string"
				? Number(flags.turnaroundHours)
				: null,
	requiredCapabilityClaimRefs: csv(flags["required-capability-claim-refs"] ?? flags.requiredCapabilityClaimRefs),
	requiredAccessRefs: csv(flags["required-access-refs"] ?? flags.requiredAccessRefs),
	dependencyRefs: csv(flags["dependency-refs"] ?? flags.dependencyRefs),
	acceptanceCriteria: csv(flags["acceptance-criteria"] ?? flags.acceptanceCriteria),
	settlementRef:
		typeof flags["settlement-ref"] === "string"
			? flags["settlement-ref"]
			: typeof flags.settlementRef === "string"
				? flags.settlementRef
				: null,
	expiresAt:
		typeof flags["expires-at"] === "string"
			? flags["expires-at"]
			: typeof flags.expiresAt === "string"
				? flags.expiresAt
				: null,
});

const TERM_FLAG_KEYS = [
	"price-sats",
	"priceSats",
	"turnaround-hours",
	"turnaroundHours",
	"required-capability-claim-refs",
	"requiredCapabilityClaimRefs",
	"required-access-refs",
	"requiredAccessRefs",
	"dependency-refs",
	"dependencyRefs",
	"acceptance-criteria",
	"acceptanceCriteria",
	"settlement-ref",
	"settlementRef",
	"expires-at",
	"expiresAt",
] as const;

const buildEventTerms = (
	flags: Record<string, string | boolean>,
	fallbackTerms: NegotiationTerms | null
): NegotiationTerms => {
	const parsed = parseTerms(flags);
	if (!fallbackTerms) {
		return parsed;
	}
	const hasOverrides = TERM_FLAG_KEYS.some((key) => Object.prototype.hasOwnProperty.call(flags, key));
	if (!hasOverrides) {
		return structuredClone(fallbackTerms);
	}
	return {
		currency: fallbackTerms.currency,
		priceSats: parsed.priceSats ?? fallbackTerms.priceSats,
		turnaroundHours: parsed.turnaroundHours ?? fallbackTerms.turnaroundHours,
		requiredCapabilityClaimRefs:
			Object.prototype.hasOwnProperty.call(flags, "required-capability-claim-refs") ||
			Object.prototype.hasOwnProperty.call(flags, "requiredCapabilityClaimRefs")
				? parsed.requiredCapabilityClaimRefs
				: structuredClone(fallbackTerms.requiredCapabilityClaimRefs),
		requiredAccessRefs:
			Object.prototype.hasOwnProperty.call(flags, "required-access-refs") ||
			Object.prototype.hasOwnProperty.call(flags, "requiredAccessRefs")
				? parsed.requiredAccessRefs
				: structuredClone(fallbackTerms.requiredAccessRefs),
		dependencyRefs:
			Object.prototype.hasOwnProperty.call(flags, "dependency-refs") ||
			Object.prototype.hasOwnProperty.call(flags, "dependencyRefs")
				? parsed.dependencyRefs
				: structuredClone(fallbackTerms.dependencyRefs),
		acceptanceCriteria:
			Object.prototype.hasOwnProperty.call(flags, "acceptance-criteria") ||
			Object.prototype.hasOwnProperty.call(flags, "acceptanceCriteria")
				? parsed.acceptanceCriteria
				: structuredClone(fallbackTerms.acceptanceCriteria),
		settlementRef:
			Object.prototype.hasOwnProperty.call(flags, "settlement-ref") ||
			Object.prototype.hasOwnProperty.call(flags, "settlementRef")
				? parsed.settlementRef
				: fallbackTerms.settlementRef,
		expiresAt:
			Object.prototype.hasOwnProperty.call(flags, "expires-at") ||
			Object.prototype.hasOwnProperty.call(flags, "expiresAt")
				? parsed.expiresAt
				: fallbackTerms.expiresAt,
	};
};

const parseEvent = (
	flags: Record<string, string | boolean>,
	eventType: NegotiationEvent["eventType"],
	defaultCreatedBy: TrustSubjectRef,
	fallbackTerms: NegotiationTerms | null = null
): NegotiationEvent => {
	const createdBy = parseActorSubject(flags, "created-by") ?? defaultCreatedBy;
	const summary =
		typeof flags.summary === "string"
			? flags.summary
			: typeof flags.note === "string"
				? flags.note
				: "";
	if (summary.trim().length === 0) {
		throw new Error(`negotiation ${eventType} requires --summary <text>`);
	}
	const eventId =
		typeof flags["event-id"] === "string"
			? flags["event-id"]
			: typeof flags.eventId === "string"
				? flags.eventId
				: `negotiation_evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
	return {
		eventId,
		eventType,
		createdAt:
			typeof flags["created-at"] === "string"
				? flags["created-at"]
				: typeof flags.createdAt === "string"
					? flags.createdAt
					: nowIso(),
		createdBy,
		summary: summary.trim(),
		terms:
			["offer", "counteroffer", "conditional_acceptance"].includes(eventType)
				? buildEventTerms(flags, fallbackTerms)
				: null,
		conditionRefs: csv(flags["condition-refs"] ?? flags.conditionRefs),
		reason:
			typeof flags.reason === "string"
				? flags.reason
				: eventType === "rejection"
					? "rejected without explicit reason"
					: null,
		settlementRef:
			typeof flags["settlement-ref"] === "string"
				? flags["settlement-ref"]
				: typeof flags.settlementRef === "string"
					? flags.settlementRef
					: null,
		notes: csv(flags.notes),
	};
};

export const organizationFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];

	if (subcommand === "init") {
		const organizationId =
			typeof flags["organization-id"] === "string"
				? flags["organization-id"]
				: typeof flags.organizationId === "string"
					? flags.organizationId
					: "";
		const npub =
			typeof flags["organization-npub"] === "string"
				? flags["organization-npub"]
				: typeof flags.organizationNpub === "string"
					? flags.organizationNpub
					: "";
		const displayName =
			typeof flags["display-name"] === "string"
				? flags["display-name"]
				: typeof flags.displayName === "string"
					? flags.displayName
					: "";
		const summary = typeof flags.summary === "string" ? flags.summary : "";
		const founderAgentIds = csv(flags["founder-agent-ids"] ?? flags.founderAgentIds);
		const founderAgentNpubs = csv(flags["founder-agent-npubs"] ?? flags.founderAgentNpubs);
		const founderLineageRoots = csv(flags["founder-lineage-roots"] ?? flags.founderLineageRoots);
		if (!organizationId || !npub || !displayName || !summary) {
			throw new Error("organization init requires --organization-id, --organization-npub, --display-name, and --summary");
		}
		if (founderAgentIds.length === 0 || founderAgentIds.length !== founderAgentNpubs.length) {
			throw new Error("organization init requires matching --founder-agent-ids and --founder-agent-npubs csv lists");
		}
		const organization = buildPersistentOrganizationDraft({
			organizationId,
			npub,
			displayName,
			summary,
			createdAt:
				typeof flags["created-at"] === "string"
					? flags["created-at"]
					: typeof flags.createdAt === "string"
						? flags.createdAt
						: nowIso(),
			founderAgentRefs: founderAgentIds.map((agentId, index) =>
				buildPersistentAgentRef(agentId, founderAgentNpubs[index]!, founderLineageRoots[index] ?? agentId)
			),
			governanceModel: readFlagString(flags, "governance-model", "governanceModel") as
				| OrganizationDraftInput["governanceModel"]
				| undefined,
			membershipPolicy: csv(flags["membership-policy"] ?? flags.membershipPolicy),
			decisionPolicyRefs: csv(flags["decision-policy-refs"] ?? flags.decisionPolicyRefs),
			sharedPolicyRefs: csv(flags["shared-policy-refs"] ?? flags.sharedPolicyRefs),
			budgetPolicyRefs: csv(flags["budget-policy-refs"] ?? flags.budgetPolicyRefs),
			settlementApprovalThresholdSats:
				typeof flags["settlement-approval-threshold-sats"] === "string"
					? Number(flags["settlement-approval-threshold-sats"])
					: typeof flags.settlementApprovalThresholdSats === "string"
						? Number(flags.settlementApprovalThresholdSats)
						: null,
			auditRefs: csv(flags["audit-refs"] ?? flags.auditRefs),
			budgetRef:
				typeof flags["budget-ref"] === "string"
					? flags["budget-ref"]
					: typeof flags.budgetRef === "string"
						? flags.budgetRef
						: null,
			settlementRefs: csv(flags["settlement-refs"] ?? flags.settlementRefs),
			shadowBillingAllowed: readFlagBoolean(flags, "shadow-billing-allowed", "shadowBillingAllowed") ?? true,
			publicCapabilityClaimRefs: csv(flags["public-capability-claim-refs"] ?? flags.publicCapabilityClaimRefs),
			collaborationContextRefs: csv(flags["collaboration-context-refs"] ?? flags.collaborationContextRefs),
			trustEdgeRefs: csv(flags["trust-edge-refs"] ?? flags.trustEdgeRefs),
			notes: csv(flags.notes),
		});
		const result = persistDocument(organization, flags);
		return flags.json ? result.text : result.wrote ? `Wrote organization draft to ${result.wrote}` : formatOrganizationInspection(inspectPersistentOrganization(organization));
	}

	if (!["inspect", "policy-inspect", "budget-inspect", "member-add", "member-remove", "member-role", "member-status"].includes(subcommand ?? "")) {
		throw new Error(
			"organization requires one of: init, inspect, policy-inspect, budget-inspect, member-add, member-remove, member-role, member-status"
		);
	}
	const filePath = typeof flags.file === "string" ? flags.file : "";
	if (filePath.trim().length === 0) {
		throw new Error(`organization ${subcommand} requires --file <path>`);
	}
	const organization = readJsonDocument<PersistentOrganization>(filePath);

	if (subcommand === "inspect") {
		const inspection = inspectPersistentOrganization(organization);
		return flags.json ? JSON.stringify(inspection, null, 2) : formatOrganizationInspection(inspection);
	}
	if (subcommand === "policy-inspect") {
		const inspection = inspectPersistentOrganization(organization);
		return flags.json ? JSON.stringify(inspection.governance, null, 2) : JSON.stringify(inspection.governance, null, 2);
	}
	if (subcommand === "budget-inspect") {
		const inspection = inspectPersistentOrganization(organization);
		return flags.json ? JSON.stringify(inspection.treasury, null, 2) : JSON.stringify(inspection.treasury, null, 2);
	}

	const changedAt =
		typeof flags["changed-at"] === "string"
			? flags["changed-at"]
			: typeof flags.changedAt === "string"
				? flags.changedAt
				: nowIso();
	const actor = parseActorSubject(flags, "actor");
	const reason = typeof flags.reason === "string" ? flags.reason : null;
	let next: PersistentOrganization;
	if (subcommand === "member-add") {
		const memberAgentId =
			typeof flags["member-agent-id"] === "string"
				? flags["member-agent-id"]
				: typeof flags.memberAgentId === "string"
					? flags.memberAgentId
					: "";
		const memberNpub =
			typeof flags["member-npub"] === "string"
				? flags["member-npub"]
				: typeof flags.memberNpub === "string"
					? flags.memberNpub
					: "";
		const role =
			typeof flags.role === "string" ? (flags.role as OrganizationMemberRole) : "builder";
		if (!memberAgentId || !memberNpub) {
			throw new Error("organization member-add requires --member-agent-id and --member-npub");
		}
		next = applyOrganizationMembershipChange(organization, {
			changeType: "add_member",
			changedAt,
			actor,
			reason,
			member: {
				memberAgentRef: buildPersistentAgentRef(
					memberAgentId,
					memberNpub,
					typeof flags["member-lineage-root"] === "string"
						? flags["member-lineage-root"]
						: typeof flags.memberLineageRoot === "string"
							? flags.memberLineageRoot
							: undefined
				),
				role,
				status:
					typeof flags.status === "string" ? (flags.status as OrganizationMemberStatus) : "active",
				joinedAt:
					typeof flags["joined-at"] === "string"
						? flags["joined-at"]
						: typeof flags.joinedAt === "string"
							? flags.joinedAt
							: changedAt,
				delegatedCapabilityClaimRefs: csv(flags["delegated-capability-claim-refs"] ?? flags.delegatedCapabilityClaimRefs),
				trustEdgeRefs: csv(flags["trust-edge-refs"] ?? flags.trustEdgeRefs),
				notes: csv(flags.notes),
			},
		});
	} else if (subcommand === "member-remove") {
		const agentId =
			typeof flags["agent-id"] === "string"
				? flags["agent-id"]
				: typeof flags.agentId === "string"
					? flags.agentId
					: "";
		if (!agentId) {
			throw new Error("organization member-remove requires --agent-id <id>");
		}
		next = applyOrganizationMembershipChange(organization, {
			changeType: "remove_member",
			changedAt,
			actor,
			reason,
			agentId,
		});
	} else if (subcommand === "member-role") {
		const agentId =
			typeof flags["agent-id"] === "string"
				? flags["agent-id"]
				: typeof flags.agentId === "string"
					? flags.agentId
					: "";
		const role =
			typeof flags.role === "string" ? (flags.role as OrganizationMemberRole) : "";
		if (!agentId || !role) {
			throw new Error("organization member-role requires --agent-id <id> and --role <role>");
		}
		next = applyOrganizationMembershipChange(organization, {
			changeType: "change_role",
			changedAt,
			actor,
			reason,
			agentId,
			role,
		});
	} else {
		const agentId =
			typeof flags["agent-id"] === "string"
				? flags["agent-id"]
				: typeof flags.agentId === "string"
					? flags.agentId
					: "";
		const status =
			typeof flags.status === "string" ? (flags.status as OrganizationMemberStatus) : "";
		if (!agentId || !status) {
			throw new Error("organization member-status requires --agent-id <id> and --status <status>");
		}
		next = applyOrganizationMembershipChange(organization, {
			changeType: "change_status",
			changedAt,
			actor,
			reason,
			agentId,
			status,
		});
	}
	const result = persistDocument(next, flags, filePath);
	return flags.json ? result.text : result.wrote ? `Wrote updated organization to ${result.wrote}` : formatOrganizationInspection(inspectPersistentOrganization(next));
};

export const negotiationFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];

	if (subcommand === "init") {
		const threadId =
			typeof flags["thread-id"] === "string"
				? flags["thread-id"]
				: typeof flags.threadId === "string"
					? flags.threadId
					: "";
		const workSummary =
			typeof flags["work-summary"] === "string"
				? flags["work-summary"]
				: typeof flags.workSummary === "string"
					? flags.workSummary
					: "";
		if (!threadId || !workSummary) {
			throw new Error("negotiation init requires --thread-id and --work-summary");
		}
		const requester = parseNegotiationParty(flags, "requester");
		const provider = parseNegotiationParty(flags, "provider");
		const initialEvent = parseEvent(flags, "offer", requester.party);
		const thread = buildNegotiationThreadDraft({
			threadId,
			workSummary,
			openedAt:
				typeof flags["opened-at"] === "string"
					? flags["opened-at"]
					: typeof flags.openedAt === "string"
						? flags.openedAt
						: nowIso(),
			requester,
			provider,
			initialEvent,
			collaborationContextRef:
				typeof flags["collaboration-context-ref"] === "string"
					? flags["collaboration-context-ref"]
					: typeof flags.collaborationContextRef === "string"
						? flags.collaborationContextRef
						: null,
			trustReceiptRefs: csv(flags["trust-receipt-refs"] ?? flags.trustReceiptRefs),
			outcomeRef:
				typeof flags["outcome-ref"] === "string"
					? flags["outcome-ref"]
					: typeof flags.outcomeRef === "string"
						? flags.outcomeRef
						: null,
			notes: csv(flags.notes),
		});
		const result = persistDocument(thread, flags);
		return flags.json ? result.text : result.wrote ? `Wrote negotiation thread to ${result.wrote}` : formatNegotiationInspection(inspectNegotiationThread(thread));
	}

	if (!["inspect", "explain", "counter", "conditional-accept", "reject", "settle"].includes(subcommand ?? "")) {
		throw new Error("negotiation requires one of: init, inspect, explain, counter, conditional-accept, reject, settle");
	}
	const filePath = typeof flags.file === "string" ? flags.file : "";
	if (filePath.trim().length === 0) {
		throw new Error(`negotiation ${subcommand} requires --file <path>`);
	}
	const thread = readJsonDocument<NegotiationThread>(filePath);
	if (subcommand === "inspect") {
		const inspection = inspectNegotiationThread(thread);
		return flags.json ? JSON.stringify(inspection, null, 2) : formatNegotiationInspection(inspection);
	}
	if (subcommand === "explain") {
		const decision = explainNegotiationDecision(thread);
		return flags.json ? JSON.stringify(decision, null, 2) : formatNegotiationDecision(decision);
	}

	const defaultCreatedBy = thread.events[thread.events.length - 1]?.createdBy ?? thread.parties[0]?.party;
	if (!defaultCreatedBy) {
		throw new Error("negotiation thread is missing a default createdBy subject");
	}
	const eventType =
		subcommand === "counter"
			? "counteroffer"
			: subcommand === "conditional-accept"
				? "conditional_acceptance"
				: subcommand === "reject"
					? "rejection"
					: "settlement";
	const event = parseEvent(flags, eventType, defaultCreatedBy, thread.currentTerms);
	const next = appendNegotiationEvent(thread, event);
	const result = persistDocument(next, flags, filePath);
	return flags.json ? result.text : result.wrote ? `Wrote updated negotiation thread to ${result.wrote}` : formatNegotiationInspection(inspectNegotiationThread(next));
};
