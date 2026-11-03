import { createHash, randomUUID } from "crypto";
import { TextEncoder } from "util";

import { schnorr } from "@noble/curves/secp256k1";
import { nip19, verifyEvent } from "nostr-tools";

import type { CapabilityClaim, CapabilityClaimKind, CapabilityClaimStatus, TrustConfidenceLevel, TrustEdge, TrustReceipt, TrustReceiptType, TrustSubjectRef } from "../protocol/trust";
import type { CollaborationContextTrustZone } from "../protocol/collaboration";
import type { PersistentAgentReference } from "../protocol/persistent-agents";
import { parsePublicDiscoveryRelayEvent, type PublicDiscoveryEvent, type PublicDiscoveryEventType } from "../protocol/public-discovery";
import type { NostrEvent } from "../protocol/relay";
import { CAPABILITY_CLAIM_SCHEMA_VERSION, TRUST_EDGE_SCHEMA_VERSION, TRUST_RECEIPT_SCHEMA_VERSION, validateCapabilityClaim, validateTrustEdge, validateTrustReceipt } from "../protocol/trust";
import type { HandoffOutcomeEvent, HandoffStoredRecord } from "./handoff-capsules";

const textEncoder = new TextEncoder();

const stableStringify = (value: unknown): string => {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
};

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const sanitizeToken = (value: string, fallback: string): string => {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return normalized.length > 0 ? normalized : fallback;
};

const hashSuffix = (value: string): string => sha256Hex(value).slice(0, 12);

const normalizePersistentAgentId = (value: string): string =>
	value.startsWith("agent_") ? value : `agent_${sanitizeToken(value, "default")}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const dedupeStrings = (values: string[]): string[] =>
	Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));

const decodeNsecPrivateKey = (nsec: string): Uint8Array => {
	const decoded = nip19.decode(nsec);
	if (decoded.type !== "nsec") {
		throw new Error("nsec must be a valid NIP-19 secret key");
	}
	return decoded.data;
};

const decodeNpubPublicKey = (npub: string): Uint8Array => {
	const decoded = nip19.decode(npub);
	if (decoded.type !== "npub") {
		throw new Error("npub must be a valid NIP-19 public key");
	}
	const hex = typeof decoded.data === "string" ? decoded.data : Buffer.from(decoded.data).toString("hex");
	return new Uint8Array(Buffer.from(hex, "hex"));
};

const buildReceiptPayload = (receipt: Omit<TrustReceipt, "payloadHash" | "signature">): string =>
	stableStringify(receipt);

const signTrustReceiptPayload = async (
	receipt: Omit<TrustReceipt, "payloadHash" | "signature">,
	nsec: string
): Promise<{ payloadHash: string; signature: string }> => {
	const canonical = buildReceiptPayload(receipt);
	const signatureBytes = await schnorr.sign(textEncoder.encode(canonical), decodeNsecPrivateKey(nsec));
	return {
		payloadHash: `sha256:${sha256Hex(canonical)}`,
		signature: Buffer.from(signatureBytes).toString("hex"),
	};
};

export const verifyTrustReceiptSignature = async (receipt: TrustReceipt): Promise<boolean> => {
	const payload: Omit<TrustReceipt, "payloadHash" | "signature"> = {
		schemaVersion: receipt.schemaVersion,
		receiptId: receipt.receiptId,
		receiptType: receipt.receiptType,
		subject: receipt.subject,
		counterparty: receipt.counterparty,
		summary: receipt.summary,
		observedAt: receipt.observedAt,
		evidence: receipt.evidence,
		signedAt: receipt.signedAt,
		signedByNpub: receipt.signedByNpub,
		notes: receipt.notes,
	};
	const canonical = buildReceiptPayload(payload);
	const expectedPayloadHash = `sha256:${sha256Hex(canonical)}`;
	if (receipt.payloadHash !== expectedPayloadHash) {
		return false;
	}
	try {
		return await schnorr.verify(
			new Uint8Array(Buffer.from(receipt.signature, "hex")),
			textEncoder.encode(canonical),
			decodeNpubPublicKey(receipt.signedByNpub)
		);
	} catch {
		return false;
	}
};

const buildAgentSubject = (agentRef: PersistentAgentReference): TrustSubjectRef => ({
	subjectType: "agent",
	agentRef: {
		agentId: normalizePersistentAgentId(agentRef.agentId),
		npub: agentRef.npub,
		lineageRoot: normalizePersistentAgentId(agentRef.lineageRoot),
	},
});

const normalizeAgentRef = (input: {
	agentId: string | null | undefined;
	npub: string | null | undefined;
	lineageRoot: string | null | undefined;
}): PersistentAgentReference | null => {
	if (!isNonEmptyString(input.npub)) {
		return null;
	}
	const agentId =
		isNonEmptyString(input.agentId)
			? normalizePersistentAgentId(input.agentId)
			: normalizePersistentAgentId(`npub_${sanitizeToken(input.npub.slice(0, 16), "unknown")}`);
	const lineageRoot =
		isNonEmptyString(input.lineageRoot) ? normalizePersistentAgentId(input.lineageRoot) : agentId;
	return {
		agentId,
		npub: input.npub,
		lineageRoot,
	};
};

const subjectKey = (subject: TrustSubjectRef): string =>
	subject.subjectType === "agent"
		? `agent:${subject.agentRef.npub}`
		: `organization:${subject.organizationRef.organizationId}:${subject.organizationRef.npub}`;

const compactSubjectToken = (subject: TrustSubjectRef): string => {
	const base =
		subject.subjectType === "agent"
			? `agent_${sanitizeToken(subject.agentRef.agentId, "agent")}`
			: `org_${sanitizeToken(subject.organizationRef.organizationId, "organization")}`;
	return `${base.slice(0, 48)}_${hashSuffix(subjectKey(subject))}`;
};

const describeSubject = (subject: TrustSubjectRef): string =>
	subject.subjectType === "agent"
		? `${subject.agentRef.agentId} (${subject.agentRef.npub})`
		: `${subject.organizationRef.organizationId} (${subject.organizationRef.npub})`;

const buildInfluenceBoundary = (notes: string[] = []) => ({
	lineageCarryoverMode: "none" as const,
	lineageLinkRefs: [] as string[],
	selfModelRef: null,
	selfModelInfluenceMode: "none" as const,
	directTrustTransferProhibited: true as const,
	notes: dedupeStrings([
		"Lineage and self-model data do not mint trust weight; only direct receipt evidence contributes.",
		...notes,
	]),
});

const outcomeKindToReceiptType = (kind: HandoffOutcomeEvent["kind"]): TrustReceiptType => {
	switch (kind) {
		case "accepted":
			return "handoff_accepted";
		case "rejected":
			return "handoff_rejected";
		case "completed":
			return "task_completed";
		case "failed":
			return "task_failed";
		case "corrected":
			return "correction_confirmed";
	}
};

const normalizeReceiptSummary = (record: HandoffStoredRecord, outcome: HandoffOutcomeEvent | null): string => {
	if (isNonEmptyString(outcome?.summary)) {
		return outcome.summary.trim();
	}
	if (outcome?.kind === "completed") {
		return `Completed delegated handoff ${record.handoffId}.`;
	}
	if (outcome?.kind === "failed") {
		return `Failed delegated handoff ${record.handoffId}.`;
	}
	if (outcome?.kind === "corrected") {
		return `Corrected delegated handoff ${record.handoffId}.`;
	}
	if (outcome?.kind === "accepted") {
		return `Accepted handoff ${record.handoffId}.`;
	}
	if (outcome?.kind === "rejected") {
		return `Rejected handoff ${record.handoffId}.`;
	}
	if (record.state === "acknowledged") {
		return `Accepted handoff ${record.handoffId}.`;
	}
	if (record.state === "rejected") {
		return `Rejected handoff ${record.handoffId}.`;
	}
	return `Recorded handoff ${record.handoffId}.`;
};

const extractOutcomeCapabilityIds = (record: HandoffStoredRecord): string[] =>
	dedupeStrings(record.capsule.continuityIr.delegation.requestedCapabilities ?? []);

const extractHandoffWorkspaceRefs = (record: HandoffStoredRecord, outcome: HandoffOutcomeEvent | null): string[] =>
	dedupeStrings(
		[
			record.capsule.continuityIr.operationalContext.workspaceId,
			outcome?.reporterWorkspaceId ?? null,
		].filter((value): value is string => isNonEmptyString(value))
	);

const buildObservedCapabilityRefs = (record: HandoffStoredRecord): string[] =>
	extractOutcomeCapabilityIds(record).map((capabilityId) => `capability:${capabilityId}`);

const buildRuntimeEvidenceRefs = (record: HandoffStoredRecord, outcome: HandoffOutcomeEvent | null): string[] =>
	dedupeStrings(
		[
			`handoff:${record.handoffId}`,
			`runtime:${outcome?.reporterRuntime ?? record.capsule.targetRuntime}`,
			...extractHandoffWorkspaceRefs(record, outcome).map((workspaceRef) => `workspace:${workspaceRef}`),
			...buildObservedCapabilityRefs(record),
		].filter((value): value is string => isNonEmptyString(value))
	);

export type MintHandoffTrustReceiptInput = {
	currentAgentRef: PersistentAgentReference;
	currentAgentNsec: string;
	currentAgentNpub?: string | null;
	record: HandoffStoredRecord;
	outcomeId?: string | null;
	signedAt?: string;
	now?: () => Date;
};

export type MintedTrustReceiptResult = {
	receipt: TrustReceipt;
	verification: {
		valid: boolean;
		errors: string[];
	};
	source: {
		handoffId: string;
		outcomeId: string | null;
		observedCapabilityIds: string[];
		counterparty: TrustSubjectRef | null;
	};
};

export const mintTrustReceiptFromHandoffRecord = async (
	input: MintHandoffTrustReceiptInput
): Promise<MintedTrustReceiptResult> => {
	const requestedOutcomeId = input.outcomeId?.trim() ?? null;
	const currentSubject = buildAgentSubject(input.currentAgentRef);
	const selectedOutcome =
		requestedOutcomeId
			? (input.record.outcomes ?? []).find((entry) => entry.outcomeId === requestedOutcomeId) ?? null
			: (input.record.outcomes ?? []).slice().sort((left, right) => right.reportedAt.localeCompare(left.reportedAt))[0] ?? null;

	if (requestedOutcomeId && !selectedOutcome) {
		throw new Error(`handoff outcome ${requestedOutcomeId} is unknown`);
	}

	const sourceAgentRef = normalizeAgentRef({
		agentId: input.record.capsule.continuityIr.identity.agentId,
		npub: input.record.capsule.signature.signedBy,
		lineageRoot: input.record.capsule.continuityIr.identity.lineageRoot,
	});
	const counterparty =
		sourceAgentRef && sourceAgentRef.npub !== input.currentAgentRef.npub ? buildAgentSubject(sourceAgentRef) : null;
	const observedCapabilityIds = extractOutcomeCapabilityIds(input.record);
	const signedAt = input.signedAt ?? (input.now?.() ?? new Date()).toISOString();
	const observedAt = selectedOutcome?.reportedAt ?? input.record.receipt?.receivedAt ?? input.record.updatedAt;
	const receiptType =
		selectedOutcome !== null
			? outcomeKindToReceiptType(selectedOutcome.kind)
			: input.record.state === "acknowledged"
				? "handoff_accepted"
				: input.record.state === "rejected"
					? "handoff_rejected"
					: "handoff_accepted";

	const unsignedReceipt: Omit<TrustReceipt, "payloadHash" | "signature"> = {
		schemaVersion: TRUST_RECEIPT_SCHEMA_VERSION,
		receiptId: `trust_receipt_${sanitizeToken(`${input.record.handoffId}_${selectedOutcome?.outcomeId ?? input.record.state}`, "handoff")}_${hashSuffix(
			`${input.currentAgentRef.npub}:${input.record.handoffId}:${selectedOutcome?.outcomeId ?? input.record.state}`
		)}`,
		receiptType,
		subject: currentSubject,
		counterparty,
		summary: normalizeReceiptSummary(input.record, selectedOutcome),
		observedAt,
		evidence: {
			outcomeRef:
				selectedOutcome?.continuityOutcomeEventId ??
				(selectedOutcome ? `handoff_outcome:${input.record.handoffId}:${selectedOutcome.outcomeId}` : null),
			handoffRef: input.record.handoffId,
			collaborationContextRef: null,
			settlementRef: null,
			evidenceRefs: buildRuntimeEvidenceRefs(input.record, selectedOutcome),
		},
		signedAt,
		signedByNpub: input.currentAgentNpub ?? input.currentAgentRef.npub,
		notes: dedupeStrings(
			[
				`Derived from live handoff outcome ${selectedOutcome?.outcomeId ?? input.record.state}.`,
				selectedOutcome?.details ?? null,
				selectedOutcome?.nextAction ? `next_action:${selectedOutcome.nextAction}` : null,
				selectedOutcome?.changedDirection ? "changed_direction:true" : null,
				selectedOutcome?.taskSucceeded === false ? "task_succeeded:false" : null,
				...(selectedOutcome?.signals.projectDirection ?? []).map((entry) => `project_direction:${entry}`),
				...(selectedOutcome?.signals.openQuestions ?? []).map((entry) => `open_question:${entry}`),
				...(selectedOutcome?.signals.recentCorrections ?? []).map((entry) => `recent_correction:${entry}`),
			].filter((value): value is string => isNonEmptyString(value))
		),
	};

	const signed = await signTrustReceiptPayload(unsignedReceipt, input.currentAgentNsec);
	const receipt: TrustReceipt = {
		...unsignedReceipt,
		payloadHash: signed.payloadHash,
		signature: signed.signature,
	};

	const errors = [...validateTrustReceipt(receipt)];
	if (!(await verifyTrustReceiptSignature(receipt))) {
		errors.push("trust receipt signature is invalid");
	}

	return {
		receipt,
		verification: {
			valid: errors.length === 0,
			errors,
		},
		source: {
			handoffId: input.record.handoffId,
			outcomeId: selectedOutcome?.outcomeId ?? null,
			observedCapabilityIds,
			counterparty,
		},
	};
};

export type TrustPublicDiscoveryObservation = {
	relayEventId: string | null;
	authorNpub: string;
	publishedAt: string;
	eventType: PublicDiscoveryEventType;
	primaryId: string;
	payload: PublicDiscoveryEvent;
};

const normalizePublicDiscoveryObservation = (value: unknown): TrustPublicDiscoveryObservation | null => {
	if (!isRecord(value)) {
		return null;
	}
	const raw = isRecord(value.rawEvent) ? value.rawEvent : isRecord(value.raw_event) ? value.raw_event : null;
	if (!raw) return null;
	// Verify a fresh plain object. nostr-tools caches verification on a symbol;
	// accepting a mutated previously verified object would bypass checks.
	const relayEvent: NostrEvent = {
		id: String(raw.id ?? ""), pubkey: String(raw.pubkey ?? ""),
		created_at: Number(raw.created_at), kind: Number(raw.kind),
		tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => Array.isArray(tag) ? tag.map(String) : []) : [],
		content: String(raw.content ?? ""), sig: String(raw.sig ?? ""),
	};
	try { if (!verifyEvent(relayEvent)) return null; }
	catch { return null; }
	let parsed: ReturnType<typeof parsePublicDiscoveryRelayEvent>;
	try { parsed = parsePublicDiscoveryRelayEvent(relayEvent); }
	catch { return null; }
	if (!parsed) return null;
	return {
		relayEventId: parsed.relayEvent.id,
		authorNpub: nip19.npubEncode(parsed.relayEvent.pubkey),
		publishedAt: parsed.payload.publishedAt,
		eventType: parsed.payload.eventType,
		primaryId: parsed.primaryId,
		payload: parsed.payload,
	};
};

const extractArray = <T>(value: unknown, mapper: (entry: unknown) => T | null): T[] => {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map(mapper).filter((entry): entry is T => entry !== null);
};

export const extractTrustReceipts = (value: unknown): TrustReceipt[] => {
	if (Array.isArray(value)) {
		return value.flatMap((entry) => extractTrustReceipts(entry));
	}
	if (!isRecord(value)) {
		return [];
	}
	if (value.schemaVersion === TRUST_RECEIPT_SCHEMA_VERSION) {
		return [value as TrustReceipt];
	}
	if (isRecord(value.receipt) && value.receipt.schemaVersion === TRUST_RECEIPT_SCHEMA_VERSION) {
		return [value.receipt as TrustReceipt];
	}
	if (Array.isArray(value.receipts)) {
		return value.receipts.flatMap((entry) => extractTrustReceipts(entry));
	}
	if (isRecord(value.graph) && Array.isArray(value.graph.receipts)) {
		return value.graph.receipts.flatMap((entry) => extractTrustReceipts(entry));
	}
	return [];
};

export const extractTrustEdges = (value: unknown): TrustEdge[] => {
	if (Array.isArray(value)) {
		return value.flatMap((entry) => extractTrustEdges(entry));
	}
	if (!isRecord(value)) {
		return [];
	}
	if (value.schemaVersion === TRUST_EDGE_SCHEMA_VERSION) {
		return [value as TrustEdge];
	}
	if (Array.isArray(value.trustEdges)) {
		return value.trustEdges.flatMap((entry) => extractTrustEdges(entry));
	}
	if (Array.isArray(value.trust_edges)) {
		return value.trust_edges.flatMap((entry) => extractTrustEdges(entry));
	}
	if (isRecord(value.graph) && Array.isArray(value.graph.trustEdges)) {
		return value.graph.trustEdges.flatMap((entry) => extractTrustEdges(entry));
	}
	return [];
};

export const extractCapabilityClaims = (value: unknown): CapabilityClaim[] => {
	if (Array.isArray(value)) {
		return value.flatMap((entry) => extractCapabilityClaims(entry));
	}
	if (!isRecord(value)) {
		return [];
	}
	if (value.schemaVersion === CAPABILITY_CLAIM_SCHEMA_VERSION) {
		return [value as CapabilityClaim];
	}
	if (Array.isArray(value.capabilityClaims)) {
		return value.capabilityClaims.flatMap((entry) => extractCapabilityClaims(entry));
	}
	if (Array.isArray(value.capability_claims)) {
		return value.capability_claims.flatMap((entry) => extractCapabilityClaims(entry));
	}
	if (isRecord(value.graph) && Array.isArray(value.graph.capabilityClaims)) {
		return value.graph.capabilityClaims.flatMap((entry) => extractCapabilityClaims(entry));
	}
	return [];
};

export const extractPublicDiscoveryObservations = (value: unknown): TrustPublicDiscoveryObservation[] => {
	if (Array.isArray(value)) {
		return extractArray(value, normalizePublicDiscoveryObservation);
	}
	if (!isRecord(value)) {
		return [];
	}
	if (Array.isArray(value.items)) {
		return extractArray(value.items, normalizePublicDiscoveryObservation);
	}
	if (Array.isArray(value.publicDiscoveryItems)) {
		return extractArray(value.publicDiscoveryItems, normalizePublicDiscoveryObservation);
	}
	if (Array.isArray(value.public_discovery_items)) {
		return extractArray(value.public_discovery_items, normalizePublicDiscoveryObservation);
	}
	const single = normalizePublicDiscoveryObservation(value);
	return single ? [single] : [];
};

type VerifiedReceiptInspection = {
	receipt: TrustReceipt;
	valid: boolean;
	errors: string[];
	observedCapabilityIds: string[];
	runtimeHosts: string[];
	workspaceRefs: string[];
};

const extractEvidenceRefs = (receipt: TrustReceipt, prefix: string): string[] =>
	receipt.evidence.evidenceRefs
		.filter((entry) => entry.startsWith(`${prefix}:`))
		.map((entry) => entry.slice(prefix.length + 1))
		.filter((entry) => entry.length > 0);

const inspectReceipt = async (receipt: TrustReceipt): Promise<VerifiedReceiptInspection> => {
	const errors = [...validateTrustReceipt(receipt)];
	if (!(await verifyTrustReceiptSignature(receipt))) {
		errors.push("trust receipt signature is invalid");
	}
	return {
		receipt,
		valid: errors.length === 0,
		errors,
		observedCapabilityIds: dedupeStrings(extractEvidenceRefs(receipt, "capability")),
		runtimeHosts: dedupeStrings(extractEvidenceRefs(receipt, "runtime")),
		workspaceRefs: dedupeStrings(extractEvidenceRefs(receipt, "workspace")),
	};
};

const trustWeightForReceipt = (receiptType: TrustReceiptType): number => {
	switch (receiptType) {
		case "task_completed":
			return 30;
		case "handoff_accepted":
			return 12;
		case "correction_confirmed":
			return 8;
		case "settlement_confirmed":
			return 20;
		case "task_failed":
			return -28;
		case "handoff_rejected":
			return -18;
		case "deliverable_rejected":
			return -24;
	}
};

const confidenceForWeight = (weight: number, receiptCount: number): TrustConfidenceLevel => {
	if (Math.abs(weight) >= 25 || receiptCount >= 2) {
		return "high";
	}
	if (Math.abs(weight) >= 12) {
		return "medium";
	}
	return "low";
};

const relationshipForReceipt = (receipt: TrustReceipt): TrustEdge["relationshipType"] => {
	if (receipt.receiptType === "correction_confirmed") {
		return "corrected_by";
	}
	if (receipt.receiptType === "settlement_confirmed") {
		return "contracted_with";
	}
	return receipt.evidence.handoffRef ? "delegated_to" : "worked_with";
};

const selectEdgeDirection = (receipt: TrustReceipt): { source: TrustSubjectRef; target: TrustSubjectRef } | null => {
	if (!receipt.counterparty) {
		return null;
	}
	if (receipt.receiptType === "correction_confirmed") {
		return {
			source: receipt.subject,
			target: receipt.counterparty,
		};
	}
	return {
		source: receipt.counterparty,
		target: receipt.subject,
	};
};

const buildEdgeId = (source: TrustSubjectRef, target: TrustSubjectRef, relationshipType: TrustEdge["relationshipType"]): string =>
	`trust_edge_${sanitizeToken(`${compactSubjectToken(source)}_${relationshipType}_${compactSubjectToken(target)}`, "edge").slice(0, 96)}_${hashSuffix(
		`${subjectKey(source)}:${relationshipType}:${subjectKey(target)}`
	)}`;

type EdgeAccumulator = {
	source: TrustSubjectRef;
	target: TrustSubjectRef;
	relationshipType: TrustEdge["relationshipType"];
	weight: number;
	receiptRefs: string[];
	positiveSignals: string[];
	cautionSignals: string[];
	observedAt: string[];
};

const buildEdgeRationale = (relationshipType: TrustEdge["relationshipType"], weight: number): string => {
	if (relationshipType === "corrected_by") {
		return weight >= 0
			? "Correction-aware collaboration established through signed receipt evidence."
			: "Correction evidence is negative or inconsistent and requires operator review.";
	}
	if (relationshipType === "delegated_to") {
		return weight >= 0
			? "Delegation history is backed by signed handoff outcomes."
			: "Delegation history includes failed or rejected handoff outcomes.";
	}
	if (relationshipType === "contracted_with") {
		return "Contractual or settlement evidence is backed by signed receipts.";
	}
	return weight >= 0
		? "Working relationship is backed by direct signed receipt evidence."
		: "Working relationship includes negative receipt evidence and should be treated cautiously.";
};

const accumulateTrustEdges = (receipts: VerifiedReceiptInspection[], nowIso: string): TrustEdge[] => {
	const accumulators = new Map<string, EdgeAccumulator>();
	for (const inspection of receipts) {
		if (!inspection.valid) {
			continue;
		}
		const direction = selectEdgeDirection(inspection.receipt);
		if (!direction) {
			continue;
		}
		const relationshipType = relationshipForReceipt(inspection.receipt);
		const key = `${subjectKey(direction.source)}:${relationshipType}:${subjectKey(direction.target)}`;
		const weight = trustWeightForReceipt(inspection.receipt.receiptType);
		const current = accumulators.get(key) ?? {
			source: direction.source,
			target: direction.target,
			relationshipType,
			weight: 0,
			receiptRefs: [],
			positiveSignals: [],
			cautionSignals: [],
			observedAt: [],
		};
		current.weight += weight;
		current.receiptRefs.push(inspection.receipt.receiptId);
		current.observedAt.push(inspection.receipt.observedAt);
		if (weight >= 0) {
			current.positiveSignals.push(inspection.receipt.summary);
		} else {
			current.cautionSignals.push(inspection.receipt.summary);
		}
		accumulators.set(key, current);
	}

	return Array.from(accumulators.values()).map((entry) => {
		const createdAt = [...entry.observedAt].sort()[0] ?? nowIso;
		const updatedAt = [...entry.observedAt].sort().slice(-1)[0] ?? createdAt;
		const edge: TrustEdge = {
			schemaVersion: TRUST_EDGE_SCHEMA_VERSION,
			edgeId: buildEdgeId(entry.source, entry.target, entry.relationshipType),
			source: entry.source,
			target: entry.target,
			relationshipType: entry.relationshipType,
			weight: Math.max(-100, Math.min(100, Math.trunc(entry.weight))),
			confidence: confidenceForWeight(entry.weight, entry.receiptRefs.length),
			receiptRefs: dedupeStrings(entry.receiptRefs),
			influenceBoundary: buildInfluenceBoundary(),
			explanation: {
				rationale: buildEdgeRationale(entry.relationshipType, entry.weight),
				positiveSignals: dedupeStrings(entry.positiveSignals).slice(0, 6),
				cautionSignals: dedupeStrings(entry.cautionSignals).slice(0, 6),
			},
			createdAt,
			updatedAt,
			notes: [
				"Derived from canonical trust receipts rather than standalone lineage or self-model hints.",
			],
		};
		return validateTrustEdge(edge).length === 0 ? edge : { ...edge, weight: 0 };
	});
};

const defaultClaimSummary = (claimKind: CapabilityClaimKind, capabilityId: string, subject: TrustSubjectRef): string => {
	const target = subject.subjectType === "agent" ? subject.agentRef.agentId : subject.organizationRef.organizationId;
	if (claimKind === "declared") {
		return `${target} publicly declares capability ${capabilityId}.`;
	}
	if (claimKind === "observed") {
		return `${target} demonstrated capability ${capabilityId} in signed outcome evidence.`;
	}
	return `${target} is endorsed for capability ${capabilityId}.`;
};

const buildClaimId = (
	subject: TrustSubjectRef,
	capabilityId: string,
	claimKind: CapabilityClaimKind,
	suffix?: string
): string =>
	`capability_claim_${sanitizeToken(`${claimKind}_${compactSubjectToken(subject)}_${capabilityId}`, "claim").slice(0, 96)}_${hashSuffix(
		`${claimKind}:${subjectKey(subject)}:${capabilityId}:${suffix ?? ""}`
	)}`;

type ClaimAccumulator = {
	subject: TrustSubjectRef;
	capabilityId: string;
	receipts: VerifiedReceiptInspection[];
	runtimeHosts: string[];
	workspaceRefs: string[];
};

const deriveObservedClaims = (receipts: VerifiedReceiptInspection[], edges: TrustEdge[], nowIso: string): CapabilityClaim[] => {
	const groups = new Map<string, ClaimAccumulator>();
	for (const receipt of receipts) {
		if (!receipt.valid || receipt.observedCapabilityIds.length === 0) {
			continue;
		}
		for (const capabilityId of receipt.observedCapabilityIds) {
			const key = `${subjectKey(receipt.receipt.subject)}:${capabilityId}`;
			const current = groups.get(key) ?? {
				subject: receipt.receipt.subject,
				capabilityId,
				receipts: [],
				runtimeHosts: [],
				workspaceRefs: [],
			};
			current.receipts.push(receipt);
			current.runtimeHosts.push(...receipt.runtimeHosts);
			current.workspaceRefs.push(...receipt.workspaceRefs);
			groups.set(key, current);
		}
	}

	return Array.from(groups.values()).map((entry) => {
		const positiveReceipts = entry.receipts.filter((receipt) =>
			["task_completed", "handoff_accepted", "correction_confirmed", "settlement_confirmed"].includes(receipt.receipt.receiptType)
		);
		const negativeReceipts = entry.receipts.filter((receipt) =>
			["task_failed", "handoff_rejected", "deliverable_rejected"].includes(receipt.receipt.receiptType)
		);
		const allReceiptRefs = entry.receipts.map((receipt) => receipt.receipt.receiptId);
		const supportingTrustEdgeRefs = edges
			.filter((edge) => edge.receiptRefs.some((receiptRef) => allReceiptRefs.includes(receiptRef)))
			.map((edge) => edge.edgeId);
		const latestObservedAt = entry.receipts.map((receipt) => receipt.receipt.observedAt).sort().slice(-1)[0] ?? nowIso;
		const earliestObservedAt = entry.receipts.map((receipt) => receipt.receipt.observedAt).sort()[0] ?? latestObservedAt;
		const status: CapabilityClaimStatus =
			positiveReceipts.length === 0 && negativeReceipts.length > 0 ? "revoked" : "active";
		const confidence: TrustConfidenceLevel =
			positiveReceipts.some((receipt) => receipt.receipt.receiptType === "task_completed") || positiveReceipts.length >= 2
				? "high"
				: positiveReceipts.length > 0 || negativeReceipts.length > 1
					? "medium"
					: "low";
		const claim: CapabilityClaim = {
			schemaVersion: CAPABILITY_CLAIM_SCHEMA_VERSION,
			claimId: buildClaimId(entry.subject, entry.capabilityId, "observed", latestObservedAt),
			subject: entry.subject,
			assertedBy: entry.subject,
			claimKind: "observed",
			status,
			capabilityId: entry.capabilityId,
			summary:
				status === "active"
					? defaultClaimSummary("observed", entry.capabilityId, entry.subject)
					: `${defaultClaimSummary("observed", entry.capabilityId, entry.subject)} Recent signed outcomes include failures or rejections.`,
			confidence,
			scope: {
				runtimeHosts: dedupeStrings(entry.runtimeHosts),
				trustZones: [],
				workspaceRefs: dedupeStrings(entry.workspaceRefs),
				artifactKinds: [],
			},
			supportingReceiptRefs: dedupeStrings(allReceiptRefs),
			supportingOutcomeRefs: dedupeStrings(
				entry.receipts
					.map((receipt) => receipt.receipt.evidence.outcomeRef)
					.filter((value): value is string => isNonEmptyString(value))
			),
			supportingTrustEdgeRefs: dedupeStrings(supportingTrustEdgeRefs),
			influenceBoundary: buildInfluenceBoundary(),
			routingHints: {
				eligibleForRouting: status === "active",
				preferredRuntimeHosts: dedupeStrings(entry.runtimeHosts),
				preferredTrustZones: [],
				budgetRef: null,
				availabilityRef: null,
				explanationRefs: dedupeStrings(allReceiptRefs),
				notes:
					status === "active"
						? ["Observed capability derived from signed receipt evidence."]
						: ["Observed capability is currently revoked by negative signed receipt evidence."],
			},
			createdAt: earliestObservedAt,
			observedAt: latestObservedAt,
			expiresAt: null,
			notes: dedupeStrings([
				...negativeReceipts.map((receipt) => `negative_signal:${receipt.receipt.summary}`),
				...positiveReceipts.map((receipt) => `positive_signal:${receipt.receipt.summary}`),
			]),
		};
		return claim;
	});
};

const candidateSubjectFromObservation = (observation: TrustPublicDiscoveryObservation): TrustSubjectRef => {
	const payload = observation.payload;
	const agentRef = normalizeAgentRef({
		agentId: payload.agentId,
		npub: observation.authorNpub,
		lineageRoot: payload.lineageRoot,
	});
	if (!agentRef) {
		throw new Error("public discovery observation is missing author identity");
	}
	return buildAgentSubject(agentRef);
};

const deriveDeclaredClaims = (observations: TrustPublicDiscoveryObservation[]): CapabilityClaim[] => {
	const claims = new Map<string, CapabilityClaim>();
	for (const observation of observations) {
		if (observation.payload.eventType !== "capability_advertisement") {
			continue;
		}
		const payload = observation.payload;
		const subject = candidateSubjectFromObservation(observation);
		const claimRefs = payload.capabilityClaimRefs ?? [];
		payload.capabilityIds.forEach((capabilityId, index) => {
			const claimId =
				claimRefs.length === payload.capabilityIds.length && isNonEmptyString(claimRefs[index])
					? claimRefs[index]!
					: buildClaimId(subject, capabilityId, "declared", observation.primaryId);
			const claim: CapabilityClaim = {
				schemaVersion: CAPABILITY_CLAIM_SCHEMA_VERSION,
				claimId,
				subject,
				assertedBy: subject,
				claimKind: "declared",
				status: "active",
				capabilityId,
				summary: observation.payload.summary || defaultClaimSummary("declared", capabilityId, subject),
				confidence: "medium",
				scope: {
					runtimeHosts: dedupeStrings(payload.scope.runtimeHosts),
					trustZones: dedupeStrings(payload.scope.trustZones as string[]) as CollaborationContextTrustZone[],
					workspaceRefs: dedupeStrings(payload.scope.workspaceRefs),
					artifactKinds: [],
				},
				supportingReceiptRefs: [],
				supportingOutcomeRefs: [],
				supportingTrustEdgeRefs: [],
				influenceBoundary: buildInfluenceBoundary(),
				routingHints: {
					eligibleForRouting: true,
					preferredRuntimeHosts: dedupeStrings(payload.scope.runtimeHosts),
					preferredTrustZones: dedupeStrings(payload.scope.trustZones as string[]) as CollaborationContextTrustZone[],
					budgetRef: null,
					availabilityRef: payload.availabilityRef ?? null,
					explanationRefs: [observation.primaryId],
					notes: ["Derived from live public capability advertisement."],
				},
				createdAt: observation.publishedAt,
				observedAt: observation.publishedAt,
				expiresAt: null,
				notes: dedupeStrings(payload.notes),
			};
			claims.set(`${subjectKey(subject)}:${capabilityId}:${claim.claimKind}`, claim);
		});
	}
	return Array.from(claims.values());
};

type BudgetPosture = {
	status: "within_budget" | "over_budget" | "unknown";
	reference: string | null;
};

const parseBudgetRefCeiling = (value: string | null): number | null => {
	if (!value) {
		return null;
	}
	const match = /(?:budget:max_sats:|budget:max:)(\d+)/i.exec(value);
	if (!match) {
		return null;
	}
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) ? parsed : null;
};

const buildBudgetPosture = (claimBudgetRefs: Array<string | null>, requestedBudgetSats: number | null | undefined): BudgetPosture => {
	const ref = claimBudgetRefs.find((value) => isNonEmptyString(value)) ?? null;
	if (requestedBudgetSats === null || requestedBudgetSats === undefined) {
		return {
			status: "unknown",
			reference: ref,
		};
	}
	const ceiling = parseBudgetRefCeiling(ref);
	if (ceiling === null) {
		return {
			status: "unknown",
			reference: ref,
		};
	}
	return {
		status: requestedBudgetSats <= ceiling ? "within_budget" : "over_budget",
		reference: ref,
	};
};

type CandidateAvailability = {
	status: "available" | "busy" | "draining" | "offline" | "unknown";
	observationRef: string | null;
	claimedJobs: number | null;
	maxConcurrentJobs: number | null;
};

const selectAvailability = (observations: TrustPublicDiscoveryObservation[], subject: TrustSubjectRef): CandidateAvailability => {
	const availability = observations
		.filter((observation) => observation.payload.eventType === "availability_heartbeat")
		.filter((observation) => subjectKey(candidateSubjectFromObservation(observation)) === subjectKey(subject))
		.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))[0];
	if (!availability || availability.payload.eventType !== "availability_heartbeat") {
		return {
			status: "unknown",
			observationRef: null,
			claimedJobs: null,
			maxConcurrentJobs: null,
		};
	}
	return {
		status: availability.payload.availabilityStatus,
		observationRef: availability.primaryId,
		claimedJobs: availability.payload.claimedJobs,
		maxConcurrentJobs: availability.payload.maxConcurrentJobs,
	};
};

export type TrustGraphInspection = {
	receipts: Array<{
		receipt: TrustReceipt;
		valid: boolean;
		errors: string[];
		observedCapabilityIds: string[];
	}>;
	trustEdges: TrustEdge[];
	capabilityClaims: CapabilityClaim[];
	publicDiscoveryItems: TrustPublicDiscoveryObservation[];
	warnings: string[];
};

export type TrustGraphInspectionInput = {
	trustReceipts?: TrustReceipt[];
	capabilityClaims?: CapabilityClaim[];
	trustEdges?: TrustEdge[];
	publicDiscoveryItems?: TrustPublicDiscoveryObservation[];
	now?: () => Date;
};

export const inspectTrustGraph = async (input: TrustGraphInspectionInput): Promise<TrustGraphInspection> => {
	const receipts = await Promise.all((input.trustReceipts ?? []).map((receipt) => inspectReceipt(receipt)));
	const warnings = receipts
		.filter((receipt) => !receipt.valid)
		.map((receipt) => `${receipt.receipt.receiptId}: ${receipt.errors.join("; ")}`);
	const nowIso = (input.now?.() ?? new Date()).toISOString();
	const derivedEdges = accumulateTrustEdges(receipts, nowIso);
	const providedEdges = (input.trustEdges ?? []).filter((edge) => validateTrustEdge(edge).length === 0);
	const observations = input.publicDiscoveryItems ?? [];
	const derivedClaims = [
		...deriveDeclaredClaims(observations),
		...deriveObservedClaims(receipts, [...providedEdges, ...derivedEdges], nowIso),
	];
	const providedClaims = (input.capabilityClaims ?? []).filter((claim) => validateCapabilityClaim(claim).length === 0);
	return {
		receipts: receipts.map((receipt) => ({
			receipt: receipt.receipt,
			valid: receipt.valid,
			errors: receipt.errors,
			observedCapabilityIds: receipt.observedCapabilityIds,
		})),
		trustEdges: [...providedEdges, ...derivedEdges],
		capabilityClaims: [...providedClaims, ...derivedClaims],
		publicDiscoveryItems: observations,
		warnings,
	};
};

export type CapabilityRoutingRequest = {
	requiredCapabilityIds: string[];
	preferredRuntimeHosts?: string[];
	requiredTrustZones?: string[];
	budgetSats?: number | null;
	includeUnavailable?: boolean;
	topK?: number;
};

export type CapabilityRoutingCandidate = {
	subject: TrustSubjectRef;
	displayName: string | null;
	availability: CandidateAvailability;
	budgetPosture: BudgetPosture;
	eligibleForRouting: boolean;
	score: {
		total: number;
		declared: number;
		observed: number;
		endorsed: number;
		trust: number;
		availability: number;
		runtime: number;
		trustZone: number;
		budget: number;
		penalties: number;
	};
	matchedCapabilities: {
		declared: string[];
		observed: string[];
		endorsed: string[];
		revoked: string[];
		missing: string[];
	};
	supportingReceiptRefs: string[];
	supportingTrustEdgeRefs: string[];
	supportingClaimRefs: string[];
	explanation: {
		positiveSignals: string[];
		cautionSignals: string[];
		blockingReasons: string[];
	};
};

export type CapabilityRoutingExplanation = {
	query: CapabilityRoutingRequest;
	graph: TrustGraphInspection;
	candidates: CapabilityRoutingCandidate[];
};

export const explainCapabilityRouting = async (
	input: TrustGraphInspectionInput & { routing: CapabilityRoutingRequest }
): Promise<CapabilityRoutingExplanation> => {
	const graph = await inspectTrustGraph(input);
	const requiredCapabilityIds = dedupeStrings(input.routing.requiredCapabilityIds ?? []);
	const preferredRuntimeHosts = dedupeStrings(input.routing.preferredRuntimeHosts ?? []);
	const requiredTrustZones = dedupeStrings(input.routing.requiredTrustZones ?? []);
	const includeUnavailable = input.routing.includeUnavailable === true;
	const topK = typeof input.routing.topK === "number" && input.routing.topK > 0 ? Math.trunc(input.routing.topK) : 10;

	const claimBySubject = new Map<string, CapabilityClaim[]>();
	for (const claim of graph.capabilityClaims) {
		const bucket = claimBySubject.get(subjectKey(claim.subject)) ?? [];
		bucket.push(claim);
		claimBySubject.set(subjectKey(claim.subject), bucket);
	}

	const subjects = new Map<string, { subject: TrustSubjectRef; displayName: string | null }>();
	for (const claim of graph.capabilityClaims) {
		const key = subjectKey(claim.subject);
		if (!subjects.has(key)) {
			subjects.set(key, {
				subject: claim.subject,
				displayName: null,
			});
		}
	}
	for (const observation of graph.publicDiscoveryItems) {
		const subject = candidateSubjectFromObservation(observation);
		const key = subjectKey(subject);
		const displayName = observation.payload.displayName ?? null;
		if (!subjects.has(key) || displayName) {
			subjects.set(key, {
				subject,
				displayName,
			});
		}
	}

	const candidates = Array.from(subjects.values())
		.map((entry) => {
			const subjectClaims = claimBySubject.get(subjectKey(entry.subject)) ?? [];
			const activeClaims = subjectClaims.filter((claim) => claim.status === "active");
			const revokedClaims = subjectClaims.filter((claim) => claim.status === "revoked");
			const declaredMatches = activeClaims
				.filter((claim) => claim.claimKind === "declared" && requiredCapabilityIds.includes(claim.capabilityId))
				.map((claim) => claim.capabilityId);
			const observedMatches = activeClaims
				.filter((claim) => claim.claimKind === "observed" && requiredCapabilityIds.includes(claim.capabilityId))
				.map((claim) => claim.capabilityId);
			const endorsedMatches = activeClaims
				.filter((claim) => claim.claimKind === "endorsed" && requiredCapabilityIds.includes(claim.capabilityId))
				.map((claim) => claim.capabilityId);
			const revokedMatches = revokedClaims
				.filter((claim) => requiredCapabilityIds.includes(claim.capabilityId))
				.map((claim) => claim.capabilityId);
			const activeCoverage = new Set([...declaredMatches, ...observedMatches, ...endorsedMatches]);
			const missing = requiredCapabilityIds.filter((capabilityId) => !activeCoverage.has(capabilityId));

			const relatedEdges = graph.trustEdges.filter((edge) => subjectKey(edge.target) === subjectKey(entry.subject));
			const availability = selectAvailability(graph.publicDiscoveryItems, entry.subject);
			const budgetPosture = buildBudgetPosture(
				activeClaims.map((claim) => claim.routingHints.budgetRef),
				input.routing.budgetSats
			);

			const runtimeFit =
				preferredRuntimeHosts.length === 0
					? 0
					: activeClaims.some((claim) =>
								preferredRuntimeHosts.some((host) =>
									claim.scope.runtimeHosts.includes(host) || claim.routingHints.preferredRuntimeHosts.includes(host)
								)
							)
						? 6
						: -6;
			const trustZoneFit =
				requiredTrustZones.length === 0
					? 0
					: activeClaims.some((claim) => requiredTrustZones.every((zone) => claim.scope.trustZones.includes(zone)))
						? 6
						: -6;
			const availabilityScore =
				availability.status === "available"
					? 10
					: availability.status === "busy"
						? -3
						: availability.status === "draining"
							? -12
							: availability.status === "offline"
								? -18
								: 0;
			const budgetScore =
				budgetPosture.status === "within_budget" ? 5 : budgetPosture.status === "over_budget" ? -12 : 0;
			const trustScore = Math.max(
				-30,
				Math.min(
					30,
					relatedEdges.reduce((total, edge) => total + edge.weight, 0)
				)
			);
			const declaredScore = declaredMatches.length * 16;
			const observedScore = observedMatches.length * 28;
			const endorsedScore = endorsedMatches.length * 22;
			const penalties = missing.length * 24 + revokedMatches.length * 18;
			const total =
				declaredScore +
				observedScore +
				endorsedScore +
				trustScore +
				availabilityScore +
				runtimeFit +
				trustZoneFit +
				budgetScore -
				penalties;

			const blockingReasons: string[] = [];
			if (missing.length > 0) {
				blockingReasons.push(`missing required capabilities: ${missing.join(", ")}`);
			}
			if (!includeUnavailable && (availability.status === "offline" || availability.status === "draining")) {
				blockingReasons.push(`availability is ${availability.status}`);
			}
			if (budgetPosture.status === "over_budget") {
				blockingReasons.push("candidate exceeds the requested budget posture");
			}
			const cautionSignals = dedupeStrings([
				...revokedMatches.map((capabilityId) => `revoked observed evidence for ${capabilityId}`),
				...(runtimeFit < 0 ? ["preferred runtime hosts are not demonstrated by active claims"] : []),
				...(trustZoneFit < 0 ? ["required trust zones are not covered by active claims"] : []),
				...(availability.status === "busy" ? ["candidate is currently busy"] : []),
				...(budgetPosture.status === "unknown" && input.routing.budgetSats !== null && input.routing.budgetSats !== undefined
					? ["budget posture is unknown; no explicit budget refs were provided"]
					: []),
				...relatedEdges.flatMap((edge) => edge.explanation.cautionSignals),
			]);
			const positiveSignals = dedupeStrings([
				...observedMatches.map((capabilityId) => `observed signed outcome evidence for ${capabilityId}`),
				...declaredMatches.map((capabilityId) => `declared public capability advertisement for ${capabilityId}`),
				...endorsedMatches.map((capabilityId) => `endorsed capability claim for ${capabilityId}`),
				...(availability.status === "available" ? ["current availability heartbeat is available"] : []),
				...(budgetPosture.status === "within_budget" ? ["candidate remains within the requested budget posture"] : []),
				...relatedEdges.flatMap((edge) => edge.explanation.positiveSignals),
			]);

			return {
				subject: entry.subject,
				displayName: entry.displayName,
				availability,
				budgetPosture,
				eligibleForRouting: blockingReasons.length === 0,
				score: {
					total,
					declared: declaredScore,
					observed: observedScore,
					endorsed: endorsedScore,
					trust: trustScore,
					availability: availabilityScore,
					runtime: runtimeFit,
					trustZone: trustZoneFit,
					budget: budgetScore,
					penalties,
				},
				matchedCapabilities: {
					declared: dedupeStrings(declaredMatches),
					observed: dedupeStrings(observedMatches),
					endorsed: dedupeStrings(endorsedMatches),
					revoked: dedupeStrings(revokedMatches),
					missing: dedupeStrings(missing),
				},
				supportingReceiptRefs: dedupeStrings(
					activeClaims.flatMap((claim) => claim.supportingReceiptRefs).concat(revokedClaims.flatMap((claim) => claim.supportingReceiptRefs))
				),
				supportingTrustEdgeRefs: dedupeStrings(relatedEdges.map((edge) => edge.edgeId)),
				supportingClaimRefs: dedupeStrings(subjectClaims.map((claim) => claim.claimId)),
				explanation: {
					positiveSignals,
					cautionSignals,
					blockingReasons,
				},
			} satisfies CapabilityRoutingCandidate;
		})
		.sort((left, right) => {
			if (left.eligibleForRouting !== right.eligibleForRouting) {
				return left.eligibleForRouting ? -1 : 1;
			}
			if (right.score.total !== left.score.total) {
				return right.score.total - left.score.total;
			}
			return subjectKey(left.subject).localeCompare(subjectKey(right.subject));
		})
		.slice(0, topK);

	return {
		query: {
			requiredCapabilityIds,
			preferredRuntimeHosts,
			requiredTrustZones,
			budgetSats: input.routing.budgetSats ?? null,
			includeUnavailable,
			topK,
		},
		graph,
		candidates,
	};
};
