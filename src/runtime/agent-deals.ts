import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { TextEncoder } from "util";

import { schnorr } from "@noble/curves/secp256k1";
import { nip19 } from "nostr-tools";

import {
	AGENT_DEAL_DELIVERY_NOTE,
	AGENT_DEAL_EVENT_SCHEMA_VERSION,
	type AgentDealChainState,
	type AgentDealSignatureVerifier,
	type SignedAgentDealEvent,
	type UnsignedAgentDealEvent,
	agentDealCanonicalPayload,
	agentDealEventHash,
	verifyAgentDealChain,
} from "../protocol/agent-deals";
import {
	COLLABORATION_CONTEXT_SCHEMA_VERSION,
	type CollaborationContextMetadata,
	TYPED_INBOX_EVENT_SCHEMA_VERSION,
	type NegotiationInboxEvent,
	type TypedInboxEvent,
} from "../protocol/collaboration";
import type { PersistentAgentReference } from "../protocol/persistent-agents";
import {
	type NegotiationEvent,
	type NegotiationEventType,
	type NegotiationTerms,
	TRUST_RECEIPT_SCHEMA_VERSION,
	type TrustReceipt,
	type TrustReceiptType,
	validateTrustReceipt,
} from "../protocol/trust";
import type { RuntimePaths } from "./runtime-persistence";
import { signTrustReceiptPayload, verifyTrustReceiptSignature } from "./trust-routing";

const textEncoder = new TextEncoder();

const npubToPublicKey = (npub: string): Uint8Array => {
	const decoded = nip19.decode(npub);
	if (decoded.type !== "npub") throw new Error("expected an npub");
	const hex = typeof decoded.data === "string" ? decoded.data : Buffer.from(decoded.data as Uint8Array).toString("hex");
	return new Uint8Array(Buffer.from(hex, "hex"));
};

const nsecToPrivateKey = (nsec: string): Uint8Array => {
	const decoded = nip19.decode(nsec);
	if (decoded.type !== "nsec") throw new Error("expected an nsec");
	return decoded.data as Uint8Array;
};

export const verifyAgentDealSignature: AgentDealSignatureVerifier = ({ canonicalPayload, signature, signerNpub }) => {
	try {
		return schnorr.verify(new Uint8Array(Buffer.from(signature, "hex")), textEncoder.encode(canonicalPayload), npubToPublicKey(signerNpub));
	} catch {
		return false;
	}
};

export const verifyDealEvents = (events: readonly unknown[]): Promise<AgentDealChainState> =>
	verifyAgentDealChain(events, verifyAgentDealSignature);

export const signAgentDealEvent = (unsigned: UnsignedAgentDealEvent, nsec: string): SignedAgentDealEvent => {
	const privateKey = nsecToPrivateKey(nsec);
	const signerPublicKey = Buffer.from(schnorr.getPublicKey(privateKey)).toString("hex");
	if (Buffer.from(npubToPublicKey(unsigned.signerNpub)).toString("hex") !== signerPublicKey) {
		throw new Error("signing key does not match signerNpub");
	}
	const eventHash = agentDealEventHash(unsigned);
	const signature = Buffer.from(schnorr.sign(textEncoder.encode(agentDealCanonicalPayload(unsigned)), privateKey)).toString("hex");
	return { ...unsigned, eventHash, signature };
};

const randomToken = (bytes = 8): string => randomBytes(bytes).toString("hex");

export const newAgentDealId = (): string => `ctx_deal_${randomToken(10)}`;
const newNegotiationEventId = (): string => `negotiation_evt_${randomToken(10)}`;
const newInboxEventId = (): string => `inbox_evt_deal_${randomToken(10)}`;

// ---------------------------------------------------------------------------------------------
// Local deal records

export type LocalAgentDealRecord = {
	schemaVersion: "crosshead_local_deal_v1";
	dealId: string;
	profileName: string;
	selfNpub: string;
	events: SignedAgentDealEvent[];
	/** Valid events that arrived before the events they follow. */
	pendingEvents: SignedAgentDealEvent[];
	processedInboxIds: string[];
	/** Hashes of this agent's own events that the server accepted for delivery. */
	sentEventHashes?: string[];
	handoff: {
		attachmentId: string;
		capsuleId: string | null;
		sentAt: string | null;
		receivedAt: string | null;
		importedAt: string | null;
		importResult: string | null;
		/** This agent's local handoff record: the created capsule (requester) or the imported one (provider). */
		localHandoffId?: string | null;
		runtime?: "codex" | "claude-code" | null;
		/** `handoff_outcome:<handoffId>:<outcomeId>` once this agent recorded the outcome. */
		outcomeRef?: string | null;
	} | null;
	/** Server escrow state for this deal, as last read (`held`, `settled` or `refunded`). */
	hold?: Record<string, unknown> | null;
	/** True once the server recorded the provider's signed delivery (provider side). */
	deliveryRegistered?: boolean;
	/** Public listing steps: the provider's claim on the offer and the requester's sold revision. */
	publicListing?: { claimEventId?: string | null; soldEventId?: string | null; error?: string | null };
	settlement: Record<string, unknown> | null;
	receipts: Array<{ receiptId: string; receiptType: TrustReceiptType; subjectNpub: string; published: boolean; error: string | null }>;
	lastError: string | null;
	updatedAt: string;
};

const dealsDir = (paths: RuntimePaths, profileName: string): string => path.join(paths.state, "deals", profileName);

const dealFile = (paths: RuntimePaths, profileName: string, dealId: string): string => {
	if (!/^ctx_[a-z0-9][a-z0-9_-]{2,127}$/.test(dealId)) throw new Error(`invalid deal id: ${dealId}`);
	return path.join(dealsDir(paths, profileName), `${dealId}.json`);
};

export const loadAgentDeal = (paths: RuntimePaths, profileName: string, dealId: string): LocalAgentDealRecord | null => {
	const file = dealFile(paths, profileName, dealId);
	if (!existsSync(file)) return null;
	return JSON.parse(readFileSync(file, "utf8")) as LocalAgentDealRecord;
};

export const requireAgentDeal = (paths: RuntimePaths, profileName: string, dealId: string): LocalAgentDealRecord => {
	const record = loadAgentDeal(paths, profileName, dealId);
	if (!record) throw new Error(`Unknown deal ${dealId} for profile ${profileName}. Run \`crosshead deal sync\` first if the other party started it.`);
	return record;
};

export const saveAgentDeal = (paths: RuntimePaths, record: LocalAgentDealRecord): void => {
	const dir = dealsDir(paths, record.profileName);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = dealFile(paths, record.profileName, record.dealId);
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, file);
};

export const listAgentDeals = (paths: RuntimePaths, profileName: string): LocalAgentDealRecord[] => {
	const dir = dealsDir(paths, profileName);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as LocalAgentDealRecord)
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};

export const newLocalAgentDeal = (dealId: string, profileName: string, selfNpub: string): LocalAgentDealRecord => ({
	schemaVersion: "crosshead_local_deal_v1",
	dealId,
	profileName,
	selfNpub,
	events: [],
	pendingEvents: [],
	processedInboxIds: [],
	sentEventHashes: [],
	handoff: null,
	settlement: null,
	receipts: [],
	lastError: null,
	updatedAt: new Date().toISOString(),
});

// ---------------------------------------------------------------------------------------------
// Building events

export const buildDealTerms = (input: {
	priceCredits: number;
	turnaroundHours?: number | null;
	acceptanceCriteria?: string[];
	requiredCapabilityIds?: string[];
	expiresAt?: string | null;
}): NegotiationTerms => {
	if (!Number.isSafeInteger(input.priceCredits) || input.priceCredits <= 0) {
		throw new Error("--price must be a positive whole number of credits");
	}
	return {
		currency: "sats",
		priceSats: input.priceCredits,
		turnaroundHours: input.turnaroundHours ?? null,
		requiredCapabilityClaimRefs: (input.requiredCapabilityIds ?? []).map((id) => `capability:${id}`),
		requiredAccessRefs: [],
		dependencyRefs: [],
		acceptanceCriteria: input.acceptanceCriteria ?? [],
		settlementRef: null,
		expiresAt: input.expiresAt ?? null,
	};
};

export const buildNextDealEvent = async (input: {
	record: LocalAgentDealRecord;
	agentRef: PersistentAgentReference;
	nsec: string;
	eventType: NegotiationEventType;
	summary: string;
	terms?: NegotiationTerms | null;
	conditionRefs?: string[];
	reason?: string | null;
	settlementRef?: string | null;
	notes?: string[];
	/** This agent's paying (requester) or receiving (provider) account; omit to keep the default. */
	account?: string | null;
	genesis?: { parties: { requesterNpub: string; providerNpub: string }; offerRef: string | null; workSummary: string };
}): Promise<{ signed: SignedAgentDealEvent; state: AgentDealChainState }> => {
	const sequence = input.record.events.length;
	if (sequence === 0 && !input.genesis) throw new Error("the first deal event needs parties and a work summary");
	const previous = sequence > 0 ? input.record.events[sequence - 1]! : null;
	const event: NegotiationEvent = {
		eventId: newNegotiationEventId(),
		eventType: input.eventType,
		createdAt: new Date().toISOString(),
		createdBy: { subjectType: "agent", agentRef: input.agentRef },
		summary: input.summary,
		terms: input.terms ?? null,
		conditionRefs: input.conditionRefs ?? [],
		reason: input.reason ?? null,
		settlementRef: input.settlementRef ?? null,
		notes: input.notes ?? [],
	};
	const unsigned: UnsignedAgentDealEvent = {
		schemaVersion: AGENT_DEAL_EVENT_SCHEMA_VERSION,
		dealId: input.record.dealId,
		sequence,
		previousEventHash: previous ? previous.eventHash : null,
		parties: sequence === 0 ? input.genesis!.parties : null,
		offerRef: sequence === 0 ? input.genesis!.offerRef : null,
		workSummary: sequence === 0 ? input.genesis!.workSummary : null,
		...(input.account ? { account: input.account } : {}),
		event,
		signerNpub: input.agentRef.npub,
	};
	const signed = signAgentDealEvent(unsigned, input.nsec);
	// Verify the would-be chain before anything is saved or sent.
	const state = await verifyDealEvents([...input.record.events, signed]);
	return { signed, state };
};

export const deliveryNotes = (artifactRefs: string[]): string[] => [
	AGENT_DEAL_DELIVERY_NOTE,
	...artifactRefs.map((ref) => `artifact:${ref}`),
];

/**
 * Adds incoming events. Events at the next sequence are appended after the extended chain verifies;
 * later events wait in pendingEvents; earlier or conflicting events are reported and dropped.
 */
export const mergeIncomingDealEvents = async (
	record: LocalAgentDealRecord,
	incoming: SignedAgentDealEvent[]
): Promise<{ appended: number; rejected: string[] }> => {
	const rejected: string[] = [];
	let appended = 0;
	const pool = [...record.pendingEvents, ...incoming];
	record.pendingEvents = [];
	let progressed = true;
	while (progressed) {
		progressed = false;
		for (const candidate of [...pool]) {
			const nextSequence = record.events.length;
			if (candidate.sequence < nextSequence) {
				pool.splice(pool.indexOf(candidate), 1);
				if (record.events[candidate.sequence]?.eventHash !== candidate.eventHash) {
					rejected.push(`event ${candidate.sequence} conflicts with the local chain`);
				}
				continue;
			}
			if (candidate.sequence !== nextSequence) continue;
			pool.splice(pool.indexOf(candidate), 1);
			try {
				await verifyDealEvents([...record.events, candidate]);
				record.events.push(candidate);
				appended += 1;
				progressed = true;
			} catch (error) {
				rejected.push(error instanceof Error ? error.message : String(error));
			}
		}
	}
	record.pendingEvents = pool.filter((event) => event.sequence > record.events.length - 1);
	return { appended, rejected };
};

// ---------------------------------------------------------------------------------------------
// Messages

export const buildDealCollaborationContext = (state: AgentDealChainState, createdBy: string): CollaborationContextMetadata => ({
	schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
	contextId: state.dealId,
	title: state.workSummary.slice(0, 120),
	createdAt: new Date().toISOString(),
	createdBy,
	participants: [
		{ npub: state.parties.requesterNpub, agentId: state.agentRefs[state.parties.requesterNpub]?.agentId ?? null, runtimeHost: null, role: "originator", displayName: null },
		{ npub: state.parties.providerNpub, agentId: state.agentRefs[state.parties.providerNpub]?.agentId ?? null, runtimeHost: null, role: "assignee", displayName: null },
	],
	policy: {
		primaryTrustZone: "network_trusted",
		additionalTrustZones: [],
		memoryScope: [],
		requireReviewFor: [],
		toolRestrictions: [],
		operatorMayPause: true,
	},
	budget: { currency: "sats", maxBudgetSats: state.agreement?.priceCredits ?? state.currentTerms?.priceSats ?? null, shadowMode: false },
	taskOwnership: {
		taskRef: `deal:${state.dealId}`,
		title: state.workSummary.slice(0, 120),
		ownerNpub: state.parties.requesterNpub,
		claimedByNpub: state.parties.providerNpub,
		status: state.status === "settled" ? "completed" : state.agreement ? "in_progress" : "offered",
		workspaceRef: null,
	},
	artifactRefs: [],
	handoffRefs: [],
	outcomeRefs: [],
	notes: [],
});

const actorFor = (agentRef: PersistentAgentReference, state: AgentDealChainState) => ({
	npub: agentRef.npub,
	agentId: agentRef.agentId,
	runtimeHost: null,
	role: (agentRef.npub === state.parties.requesterNpub ? "originator" : "assignee") as "originator" | "assignee",
});

export const buildNegotiationMessage = (input: {
	signed: SignedAgentDealEvent;
	state: AgentDealChainState;
	agentRef: PersistentAgentReference;
}): Record<string, unknown> => {
	const inboxEvent: NegotiationInboxEvent = {
		schemaVersion: TYPED_INBOX_EVENT_SCHEMA_VERSION,
		eventId: newInboxEventId(),
		eventType: "negotiation",
		contextId: input.state.dealId,
		summary: `${input.signed.event.eventType}: ${input.signed.event.summary}`.slice(0, 500),
		priority: "medium",
		createdAt: new Date().toISOString(),
		actor: actorFor(input.agentRef, input.state),
		taskRef: `deal:${input.state.dealId}`,
		artifactRefs: [],
		handoffRefs: [],
		outcomeRefs: [],
		negotiation: { dealEvent: input.signed },
	};
	return buildInboxMessage(input.state, input.agentRef, inboxEvent);
};

export const buildHandoffCreatedMessage = (input: {
	state: AgentDealChainState;
	agentRef: PersistentAgentReference;
	attachmentId: string;
	capsuleId: string;
	targetRuntimeHost: string | null;
}): Record<string, unknown> => {
	const inboxEvent: TypedInboxEvent = {
		schemaVersion: TYPED_INBOX_EVENT_SCHEMA_VERSION,
		eventId: newInboxEventId(),
		eventType: "handoff_created",
		contextId: input.state.dealId,
		summary: `Work handoff for deal ${input.state.dealId}`,
		priority: "medium",
		createdAt: new Date().toISOString(),
		actor: actorFor(input.agentRef, input.state),
		taskRef: `deal:${input.state.dealId}`,
		artifactRefs: [`attachment:${input.attachmentId}`],
		handoffRefs: [input.capsuleId],
		outcomeRefs: [],
		handoffCreated: { handoffId: input.capsuleId, targetRuntimeHost: input.targetRuntimeHost },
	};
	return buildInboxMessage(input.state, input.agentRef, inboxEvent);
};

const buildInboxMessage = (state: AgentDealChainState, agentRef: PersistentAgentReference, inboxEvent: TypedInboxEvent): Record<string, unknown> => {
	const recipient = agentRef.npub === state.parties.requesterNpub ? state.parties.providerNpub : state.parties.requesterNpub;
	return {
		recipient_npub: recipient,
		plaintext: inboxEvent.summary,
		message_type: "inbox_event",
		collaboration_context: buildDealCollaborationContext(state, agentRef.npub),
		inbox_event: inboxEvent,
	};
};

// ---------------------------------------------------------------------------------------------
// Trust receipts

const hashSuffix = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);

/**
 * Mints a receipt about the other party. `task_completed` is signed by the requester about the
 * provider; `settlement_confirmed` is signed by the provider about the requester.
 */
export const mintAgentDealReceipt = async (input: {
	state: AgentDealChainState;
	receiptType: Extract<TrustReceiptType, "task_completed" | "settlement_confirmed" | "deliverable_rejected">;
	signer: PersistentAgentReference;
	nsec: string;
	settlementRef: string | null;
	handoffRef: string | null;
	/** The handoff outcome the signer recorded; defaults to the signed delivery. */
	outcomeRef?: string | null;
	summary: string;
}): Promise<TrustReceipt> => {
	const { state } = input;
	const otherNpub = input.signer.npub === state.parties.requesterNpub ? state.parties.providerNpub : state.parties.requesterNpub;
	const otherRef = state.agentRefs[otherNpub];
	if (!otherRef) throw new Error("the other party has not signed any event in this deal");
	const signedAt = new Date().toISOString();
	// Only the requester's receipt about delivered work evidences the provider's capabilities; paying is not a skill.
	const capabilityRefs = input.receiptType === "task_completed"
		? (state.agreement?.terms.requiredCapabilityClaimRefs ?? []).filter((ref) => ref.startsWith("capability:"))
		: [];
	const unsigned: Omit<TrustReceipt, "payloadHash" | "signature"> = {
		schemaVersion: TRUST_RECEIPT_SCHEMA_VERSION,
		receiptId: `trust_receipt_deal_${input.receiptType}_${hashSuffix(`${state.dealId}:${input.receiptType}:${input.signer.npub}`)}`,
		receiptType: input.receiptType,
		subject: { subjectType: "agent", agentRef: otherRef },
		counterparty: { subjectType: "agent", agentRef: input.signer },
		summary: input.summary,
		observedAt: signedAt,
		evidence: {
			outcomeRef: input.outcomeRef ?? (state.delivery ? `deal_delivery:${state.delivery.eventHash}` : null),
			handoffRef: input.handoffRef,
			collaborationContextRef: state.dealId,
			settlementRef: input.settlementRef,
			evidenceRefs: [
				`deal:${state.dealId}`,
				...(state.agreement ? [`deal_agreement:${state.agreement.acceptanceEventHash}`, `price_credits:${state.agreement.priceCredits}`] : []),
				...capabilityRefs,
				...(state.delivery ? [`deal_delivery:${state.delivery.eventHash}`] : []),
			],
		},
		signedAt,
		signedByNpub: input.signer.npub,
		notes: [`Signed by the ${input.signer.npub === state.parties.requesterNpub ? "requester" : "provider"} of agent deal ${state.dealId}.`],
	};
	const signed = await signTrustReceiptPayload(unsigned, input.nsec);
	const receipt: TrustReceipt = { ...unsigned, ...signed };
	const errors = validateTrustReceipt(receipt);
	if (errors.length > 0 || !(await verifyTrustReceiptSignature(receipt))) {
		throw new Error(`minted receipt is invalid: ${errors.join("; ") || "signature does not verify"}`);
	}
	return receipt;
};

export const dealRole = (state: AgentDealChainState, npub: string): "requester" | "provider" => {
	if (npub === state.parties.requesterNpub) return "requester";
	if (npub === state.parties.providerNpub) return "provider";
	throw new Error("this profile is not a party to the deal");
};

export const latestSignerNpub = (record: LocalAgentDealRecord): string =>
	record.events[record.events.length - 1]?.signerNpub ?? record.selfNpub;

/** This agent's own signed events that were saved but not yet delivered, oldest first. */
export const unsentOwnEvents = (record: LocalAgentDealRecord): SignedAgentDealEvent[] => {
	const sent = new Set(record.sentEventHashes ?? record.events.filter((event) => event.signerNpub === record.selfNpub).map((event) => event.eventHash));
	return record.events.filter((event) => event.signerNpub === record.selfNpub && !sent.has(event.eventHash));
};

/** The text a deal handoff capsule carries in `delegation.whyTransfer`, binding it to one agreement. */
export const dealHandoffBinding = (state: AgentDealChainState): string =>
	`crosshead deal ${state.dealId} agreement ${state.agreement?.acceptanceEventHash ?? "none"}`;

/** Signs an arbitrary canonical payload with the agent key (BIP-340 Schnorr over the payload bytes). */
export const signCanonicalPayload = (canonicalPayload: string, nsec: string): string =>
	Buffer.from(schnorr.sign(textEncoder.encode(canonicalPayload), nsecToPrivateKey(nsec))).toString("hex");
