import { createHash } from "crypto";

import { canonicalJson } from "./agent-deals";
import type { Npub } from "./base";
import type { ContinuityClaim } from "./continuity-claims";

/**
 * Peer verification: an agent the claim owner appointed (its own key, outside the owner's trust zone) is obliged to try
 * to falsify a continuity claim, then signs what it found. The server checks the signature, the appointment and that the
 * verdict is about the claim as it stands, then promotes or rejects the claim. The verifier also signs a trust receipt
 * about the agent that made the claim.
 */
export const PEER_VERIFICATION_VERDICT_SCHEMA_VERSION = "crosshead.peer_verification_verdict.v1" as const;
export const PEER_VERIFICATION_OUTCOMES = ["upheld", "refuted", "inconclusive"] as const;
export type PeerVerificationOutcome = (typeof PEER_VERIFICATION_OUTCOMES)[number];
/** The verifier's obligation. Only "falsify" exists: a verifier looks for the observation that would make the claim false. */
export const PEER_VERIFICATION_MANDATES = ["falsify"] as const;
export type PeerVerificationMandate = (typeof PEER_VERIFICATION_MANDATES)[number];

export const PEER_VERIFICATION_LIMITS = {
	maxAttempts: 16,
	maxEvidenceRefs: 32,
	maxTextChars: 2_000,
	maxRefChars: 512,
} as const;

/** One attempt to show the claim is false: what would be true if it were, how it was checked, and what was seen. */
export type PeerFalsificationAttempt = {
	hypothesis: string;
	method: string;
	observation: string;
	/** True when the observation shows the claim is false. */
	falsified: boolean;
};

export type UnsignedPeerVerificationVerdict = {
	schemaVersion: typeof PEER_VERIFICATION_VERDICT_SCHEMA_VERSION;
	verdictId: string;
	claimId: string;
	claimOwnerNpub: Npub;
	/** The agent the verdict is about: the claim's owner. */
	subjectNpub: Npub;
	claimDigest: string;
	verifierNpub: Npub;
	mandate: PeerVerificationMandate;
	outcome: PeerVerificationOutcome;
	falsificationAttempts: PeerFalsificationAttempt[];
	evidenceRefs: string[];
	summary: string;
	issuedAt: string;
};

export type PeerVerificationVerdict = UnsignedPeerVerificationVerdict & {
	payloadHash: string;
	signature: string;
};

const VERDICT_ID_PATTERN = /^peer_verdict_[a-f0-9]{32}$/;
/** Claim IDs in canonical form only: Postgres accepts other spellings of one UUID, which would dodge per-claim locks and IDs. */
export const CANONICAL_CLAIM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NPUB_PATTERN = /^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{128}$/;
const VERDICT_KEYS = [
	"schemaVersion", "verdictId", "claimId", "claimOwnerNpub", "subjectNpub", "claimDigest", "verifierNpub", "mandate",
	"outcome", "falsificationAttempts", "evidenceRefs", "summary", "issuedAt", "payloadHash", "signature",
];

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * The agent a verdict and its receipt are about: always the claim's owner. A claim's scope agent is chosen by the owner
 * and not checked, so using it would let an owner have receipts written about an agent that never made the claim.
 */
export const peerVerificationSubjectNpub = (claim: Pick<ContinuityClaim, "npub">): Npub => claim.npub as Npub;

/** The receipt ID a verdict's receipt must carry, so a receipt cannot reuse the ID of an unrelated one. */
export const peerVerificationReceiptId = (verdictId: string, receiptType: "claim_verified" | "claim_refuted"): string =>
	`trust_receipt_${receiptType}_${verdictId.slice("peer_verdict_".length)}`;

/**
 * Digest of what a claim asserts. A verdict names it, so a verdict cannot be applied to a claim whose content changed
 * after the verifier looked, or to a claim marked stale since. Status, authority, other timestamps and evidence are
 * excluded: they change as the claim is worked on, and the verifier inspects the evidence it cites itself.
 */
export const peerVerificationClaimDigest = (
	claim: Pick<ContinuityClaim, "id" | "npub" | "kind" | "subject" | "statement" | "scope" | "verificationPlan"> & { staleAt?: Date | string | null }
): string =>
	`sha256:${sha256Hex(canonicalJson({
		id: claim.id,
		npub: claim.npub,
		kind: claim.kind,
		// A revision is included only when declared, so digests of claims without one (and verdicts on them) are unchanged.
		subject: { type: claim.subject.type, ref: claim.subject.ref, ...(claim.subject.revision ? { revision: claim.subject.revision } : {}) },
		statement: claim.statement,
		scope: {
			workspaceId: claim.scope?.workspaceId ?? null,
			repo: claim.scope?.repo ?? null,
			taskId: claim.scope?.taskId ?? null,
			environment: claim.scope?.environment ?? null,
			agentNpub: claim.scope?.agentNpub ?? null,
			tags: [...(claim.scope?.tags ?? [])].sort(),
		},
		requiredEvidence: [...(claim.verificationPlan?.requiredEvidence ?? [])].sort(),
		// Marking a claim stale (say, after a rollback) changes the digest, so verdicts made before that no longer apply.
		staleAt: claim.staleAt ? new Date(claim.staleAt).toISOString() : null,
	}))}`;

/** The bytes a verifier signs: the canonical JSON of every field except the hash and signature. */
export const peerVerificationCanonicalPayload = (verdict: UnsignedPeerVerificationVerdict | PeerVerificationVerdict): string => {
	const { payloadHash: _hash, signature: _signature, ...unsigned } = verdict as PeerVerificationVerdict;
	return canonicalJson(unsigned);
};

export const peerVerificationPayloadHash = (verdict: UnsignedPeerVerificationVerdict | PeerVerificationVerdict): string =>
	`sha256:${sha256Hex(peerVerificationCanonicalPayload(verdict))}`;

/**
 * Derived from claim, digest, verifier and outcome: a resubmitted verdict is a replay, and an inconclusive verdict
 * does not block a later conclusive one from the same verifier.
 */
export const peerVerificationVerdictId = (claimId: string, claimDigest: string, verifierNpub: string, outcome: PeerVerificationOutcome): string =>
	`peer_verdict_${sha256Hex(`${claimId}\n${claimDigest}\n${verifierNpub}\n${outcome}`).slice(0, 32)}`;

/** Receipt type a verdict produces; inconclusive verdicts produce none. */
export const peerVerificationReceiptType = (outcome: PeerVerificationOutcome): "claim_verified" | "claim_refuted" | null =>
	outcome === "upheld" ? "claim_verified" : outcome === "refuted" ? "claim_refuted" : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, field: string, errors: string[], max: number = PEER_VERIFICATION_LIMITS.maxTextChars): void => {
	if (typeof value !== "string" || value.trim().length === 0) errors.push(`${field} must be a non-empty string`);
	else if (value.length > max) errors.push(`${field} must be at most ${max} characters`);
};

/** Structural checks, including the falsifier rules. Signature checks live in the runtime (`verifyPeerVerificationVerdict`). */
export const validatePeerVerificationVerdict = (value: unknown): string[] => {
	if (!isRecord(value)) return ["verdict must be an object"];
	const errors: string[] = [];
	const extra = Object.keys(value).filter((key) => !VERDICT_KEYS.includes(key));
	if (extra.length > 0) errors.push(`unknown verdict fields: ${extra.join(", ")}`);
	if (value.schemaVersion !== PEER_VERIFICATION_VERDICT_SCHEMA_VERSION) errors.push(`schemaVersion must be ${PEER_VERIFICATION_VERDICT_SCHEMA_VERSION}`);
	if (typeof value.verdictId !== "string" || !VERDICT_ID_PATTERN.test(value.verdictId)) errors.push("verdictId must be a peer_verdict_ id");
	if (typeof value.claimId !== "string" || !CANONICAL_CLAIM_ID_PATTERN.test(value.claimId)) errors.push("claimId must be a lowercase, hyphenated UUID");
	for (const field of ["claimOwnerNpub", "subjectNpub", "verifierNpub"] as const) {
		if (typeof value[field] !== "string" || !NPUB_PATTERN.test(value[field] as string)) errors.push(`${field} must be an npub`);
	}
	if (typeof value.claimDigest !== "string" || !DIGEST_PATTERN.test(value.claimDigest)) errors.push("claimDigest must be sha256:<hex>");
	if (!PEER_VERIFICATION_MANDATES.includes(value.mandate as PeerVerificationMandate)) errors.push("mandate must be falsify");
	if (!PEER_VERIFICATION_OUTCOMES.includes(value.outcome as PeerVerificationOutcome)) errors.push(`outcome must be one of: ${PEER_VERIFICATION_OUTCOMES.join(", ")}`);
	text(value.summary, "summary", errors);
	if (typeof value.issuedAt !== "string" || Number.isNaN(Date.parse(value.issuedAt))) errors.push("issuedAt must be an ISO timestamp");
	if (typeof value.payloadHash !== "string" || !DIGEST_PATTERN.test(value.payloadHash)) errors.push("payloadHash must be sha256:<hex>");
	if (typeof value.signature !== "string" || !SIGNATURE_PATTERN.test(value.signature)) errors.push("signature must be a 64-byte hex Schnorr signature");

	const refs = value.evidenceRefs;
	if (!Array.isArray(refs) || refs.length > PEER_VERIFICATION_LIMITS.maxEvidenceRefs) {
		errors.push(`evidenceRefs must be an array of at most ${PEER_VERIFICATION_LIMITS.maxEvidenceRefs} strings`);
	} else {
		refs.forEach((ref, index) => text(ref, `evidenceRefs[${index}]`, errors, PEER_VERIFICATION_LIMITS.maxRefChars));
	}

	const attempts = value.falsificationAttempts;
	if (!Array.isArray(attempts) || attempts.length > PEER_VERIFICATION_LIMITS.maxAttempts) {
		errors.push(`falsificationAttempts must be an array of at most ${PEER_VERIFICATION_LIMITS.maxAttempts} attempts`);
		return errors;
	}
	attempts.forEach((attempt, index) => {
		if (!isRecord(attempt)) {
			errors.push(`falsificationAttempts[${index}] must be an object`);
			return;
		}
		for (const field of ["hypothesis", "method", "observation"] as const) text(attempt[field], `falsificationAttempts[${index}].${field}`, errors);
		if (typeof attempt.falsified !== "boolean") errors.push(`falsificationAttempts[${index}].falsified must be true or false`);
	});
	const falsified = attempts.filter((attempt) => isRecord(attempt) && attempt.falsified === true).length;
	// The falsifier mandate: a claim is upheld only after at least one serious attempt to break it found nothing,
	// and refuted only by a recorded observation that breaks it.
	if (value.outcome === "upheld" && (attempts.length === 0 || falsified > 0)) {
		errors.push("an upheld verdict needs at least one falsification attempt and none that falsified the claim");
	}
	if (value.outcome === "refuted" && falsified === 0) {
		errors.push("a refuted verdict needs at least one attempt that falsified the claim");
	}
	if (value.subjectNpub !== value.claimOwnerNpub) errors.push("subjectNpub must be the claim owner");
	if (value.claimOwnerNpub === value.verifierNpub || value.subjectNpub === value.verifierNpub) {
		errors.push("a verifier cannot verify its own claim or its own work");
	}
	return errors;
};
