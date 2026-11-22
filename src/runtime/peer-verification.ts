import { createHash } from "crypto";
import { TextEncoder } from "util";

import { schnorr } from "@noble/curves/secp256k1";
import { nip19 } from "nostr-tools";

import type { Npub } from "../protocol/base";
import type { ContinuityClaim } from "../protocol/continuity-claims";
import {
	PEER_VERIFICATION_VERDICT_SCHEMA_VERSION,
	peerVerificationCanonicalPayload,
	peerVerificationClaimDigest,
	peerVerificationPayloadHash,
	peerVerificationReceiptId,
	peerVerificationReceiptType,
	peerVerificationSubjectNpub,
	peerVerificationVerdictId,
	validatePeerVerificationVerdict,
	type PeerFalsificationAttempt,
	type PeerVerificationOutcome,
	type PeerVerificationVerdict,
	type UnsignedPeerVerificationVerdict,
} from "../protocol/peer-verification";
import type { PersistentAgentReference } from "../protocol/persistent-agents";
import { TRUST_RECEIPT_SCHEMA_VERSION, validateTrustReceipt, type TrustReceipt } from "../protocol/trust";
import { signTrustReceiptPayload, verifyTrustReceiptSignature } from "./trust-routing";

const textEncoder = new TextEncoder();

const npubToPublicKey = (npub: string): Uint8Array => {
	const decoded = nip19.decode(npub);
	if (decoded.type !== "npub") throw new Error("expected an npub");
	const data = decoded.data as unknown;
	return typeof data === "string" ? new Uint8Array(Buffer.from(data, "hex")) : (data as Uint8Array);
};

const nsecToPrivateKey = (nsec: string): Uint8Array => {
	const decoded = nip19.decode(nsec);
	if (decoded.type !== "nsec") throw new Error("expected an nsec");
	return decoded.data as Uint8Array;
};

/** A stable agent reference for an npub that has no richer reference to hand (receipt subjects need one). */
export const agentRefForNpub = (npub: string): PersistentAgentReference => {
	const id = `agent_${createHash("sha256").update(npub, "utf8").digest("hex").slice(0, 24)}`;
	return { agentId: id, npub: npub as Npub, lineageRoot: id };
};

/** Builds and signs a verdict about `claim` as the verifier holding `nsec`. Throws if the verdict breaks the falsifier rules. */
export const buildPeerVerificationVerdict = (input: {
	claim: Pick<ContinuityClaim, "id" | "npub" | "kind" | "subject" | "statement" | "scope" | "verificationPlan"> & { staleAt?: Date | string | null };
	verifierNpub: string;
	nsec: string;
	outcome: PeerVerificationOutcome;
	falsificationAttempts: PeerFalsificationAttempt[];
	evidenceRefs?: string[];
	summary: string;
	issuedAt?: Date;
}): PeerVerificationVerdict => {
	const claimDigest = peerVerificationClaimDigest(input.claim);
	const unsigned: UnsignedPeerVerificationVerdict = {
		schemaVersion: PEER_VERIFICATION_VERDICT_SCHEMA_VERSION,
		verdictId: peerVerificationVerdictId(input.claim.id, claimDigest, input.verifierNpub, input.outcome),
		claimId: input.claim.id,
		claimOwnerNpub: input.claim.npub,
		subjectNpub: peerVerificationSubjectNpub(input.claim),
		claimDigest,
		verifierNpub: input.verifierNpub as Npub,
		mandate: "falsify",
		outcome: input.outcome,
		falsificationAttempts: input.falsificationAttempts,
		evidenceRefs: input.evidenceRefs ?? [],
		summary: input.summary,
		issuedAt: (input.issuedAt ?? new Date()).toISOString(),
	};
	const canonical = peerVerificationCanonicalPayload(unsigned);
	const signature = Buffer.from(schnorr.sign(textEncoder.encode(canonical), nsecToPrivateKey(input.nsec))).toString("hex");
	const verdict: PeerVerificationVerdict = { ...unsigned, payloadHash: peerVerificationPayloadHash(unsigned), signature };
	const errors = validatePeerVerificationVerdict(verdict);
	if (errors.length > 0) throw new Error(`invalid verdict: ${errors.join("; ")}`);
	return verdict;
};

/** Structure, falsifier rules, payload hash, derived verdict ID and the verifier's Schnorr signature. */
export const verifyPeerVerificationVerdict = (value: unknown): { valid: boolean; errors: string[] } => {
	const errors = validatePeerVerificationVerdict(value);
	if (errors.length > 0) return { valid: false, errors };
	const verdict = value as PeerVerificationVerdict;
	if (verdict.payloadHash !== peerVerificationPayloadHash(verdict)) errors.push("payloadHash does not match the verdict");
	if (verdict.verdictId !== peerVerificationVerdictId(verdict.claimId, verdict.claimDigest, verdict.verifierNpub, verdict.outcome)) {
		errors.push("verdictId does not match the claim, digest, verifier and outcome");
	}
	let signatureOk = false;
	try {
		signatureOk = schnorr.verify(
			new Uint8Array(Buffer.from(verdict.signature, "hex")),
			textEncoder.encode(peerVerificationCanonicalPayload(verdict)),
			npubToPublicKey(verdict.verifierNpub)
		);
	} catch {
		signatureOk = false;
	}
	if (!signatureOk) errors.push("signature does not verify for verifierNpub");
	return { valid: errors.length === 0, errors };
};

/**
 * The verifier's trust receipt about the agent the claim describes: `claim_verified` for an upheld verdict,
 * `claim_refuted` for a refuted one. It names the claim as its collaboration context and cites the verdict.
 */
export const mintPeerVerificationReceipt = async (input: {
	verdict: PeerVerificationVerdict;
	verifier: PersistentAgentReference;
	subject?: PersistentAgentReference;
	nsec: string;
}): Promise<TrustReceipt> => {
	const { verdict } = input;
	const receiptType = peerVerificationReceiptType(verdict.outcome);
	if (!receiptType) throw new Error("inconclusive verdicts do not produce a receipt");
	if (input.verifier.npub !== verdict.verifierNpub) throw new Error("the receipt signer must be the verifier");
	const subject = input.subject ?? agentRefForNpub(verdict.subjectNpub);
	if (subject.npub !== verdict.subjectNpub) throw new Error("the receipt subject must be the verdict's subject");
	const unsigned: Omit<TrustReceipt, "payloadHash" | "signature"> = {
		schemaVersion: TRUST_RECEIPT_SCHEMA_VERSION,
		receiptId: peerVerificationReceiptId(verdict.verdictId, receiptType),
		receiptType,
		subject: { subjectType: "agent", agentRef: subject },
		counterparty: { subjectType: "agent", agentRef: input.verifier },
		summary: verdict.summary,
		observedAt: verdict.issuedAt,
		evidence: {
			outcomeRef: `peer_verdict:${verdict.verdictId}`,
			handoffRef: null,
			collaborationContextRef: verdict.claimId,
			settlementRef: null,
			evidenceRefs: [`peer_verdict:${verdict.verdictId}`, `claim_digest:${verdict.claimDigest}`, ...verdict.evidenceRefs].slice(0, 34),
		},
		signedAt: new Date().toISOString(),
		signedByNpub: verdict.verifierNpub,
		notes: [`Peer verification of continuity claim ${verdict.claimId}: ${verdict.outcome} after ${verdict.falsificationAttempts.length} falsification attempt(s).`],
	};
	const receipt: TrustReceipt = { ...unsigned, ...(await signTrustReceiptPayload(unsigned, input.nsec)) };
	const errors = validateTrustReceipt(receipt);
	if (errors.length > 0 || !(await verifyTrustReceiptSignature(receipt))) {
		throw new Error(`minted receipt is invalid: ${errors.join("; ") || "signature does not verify"}`);
	}
	return receipt;
};
