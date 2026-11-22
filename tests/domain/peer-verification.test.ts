import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { peerVerificationSatisfiesEvidence, type ContinuityClaim } from "../../src/protocol/continuity-claims";
import { FEATURE_GATE_DEFINITIONS } from "../../src/protocol/features";
import { peerVerificationClaimDigest, validatePeerVerificationVerdict } from "../../src/protocol/peer-verification";
import { validateTrustReceipt } from "../../src/protocol/trust";
import { buildPeerVerificationVerdict, mintPeerVerificationReceipt, verifyPeerVerificationVerdict } from "../../src/runtime/peer-verification";
import { verifyTrustReceiptSignature } from "../../src/runtime/trust-routing";

const agent = (name: string) => {
	const secret = generateSecretKey();
	const npub = nip19.npubEncode(getPublicKey(secret));
	return { nsec: nip19.nsecEncode(secret), ref: { agentId: `agent_${name}`, npub, lineageRoot: `agent_${name}` } };
};

const claimBy = (owner: string, statement = "The retry fix is merged as abc123 and CI passed."): ContinuityClaim => ({
	id: "4b8e7a52-5d0b-4f61-9d33-2d6b6f0f6a01",
	npub: owner as never,
	kind: "implementation",
	status: "open",
	subject: { type: "implementation", ref: "mr:84" },
	statement,
	scope: { workspaceId: "repo:onlybots", repo: null, taskId: null, environment: null, agentNpub: null, tags: ["b", "a"] },
	authority: "runtime",
	verificationPlan: { requiredEvidence: ["git_commit"], description: null, checklist: [] },
	freshness: {},
	supersedes: [],
	supersededBy: null,
	verifiedAt: null,
	rejectedAt: null,
	staleAt: null,
	idempotencyKey: null,
	metadata: {},
	createdAt: new Date(),
	updatedAt: new Date(),
});

const held = { hypothesis: "abc123 is not on main", method: "git branch --contains abc123", observation: "main contains abc123", falsified: false };
const broke = { hypothesis: "CI did not pass", method: "read pipeline 3098", observation: "the test job failed", falsified: true };

describe("peer verification verdicts", () => {
	const worker = agent("worker");
	const verifier = agent("verifier");

	it("signs a verdict the server can check, and rejects any edit to it", () => {
		const verdict = buildPeerVerificationVerdict({ claim: claimBy(worker.ref.npub), verifierNpub: verifier.ref.npub, nsec: verifier.nsec, outcome: "upheld", falsificationAttempts: [held], summary: "Could not falsify." });
		expect(verifyPeerVerificationVerdict(verdict)).toEqual({ valid: true, errors: [] });
		expect(verifyPeerVerificationVerdict({ ...verdict, outcome: "refuted" }).valid).toBe(false);
		expect(verifyPeerVerificationVerdict({ ...verdict, summary: "edited" }).errors).toContain("payloadHash does not match the verdict");
		const forged = buildPeerVerificationVerdict({ claim: claimBy(worker.ref.npub), verifierNpub: verifier.ref.npub, nsec: agent("other").nsec, outcome: "upheld", falsificationAttempts: [held], summary: "x" });
		expect(verifyPeerVerificationVerdict(forged).errors).toContain("signature does not verify for verifierNpub");
	});

	it("enforces the falsifier mandate", () => {
		const build = (outcome: "upheld" | "refuted", attempts: typeof held[]) => () =>
			buildPeerVerificationVerdict({ claim: claimBy(worker.ref.npub), verifierNpub: verifier.ref.npub, nsec: verifier.nsec, outcome, falsificationAttempts: attempts, summary: "s" });
		expect(build("upheld", [])).toThrow(/at least one falsification attempt/);
		expect(build("upheld", [held, broke])).toThrow(/none that falsified/);
		expect(build("refuted", [held])).toThrow(/falsified the claim/);
		expect(build("refuted", [held, broke])).not.toThrow();
		expect(() => buildPeerVerificationVerdict({ claim: claimBy(verifier.ref.npub), verifierNpub: verifier.ref.npub, nsec: verifier.nsec, outcome: "upheld", falsificationAttempts: [held], summary: "s" }))
			.toThrow(/cannot verify its own claim/);
		expect(validatePeerVerificationVerdict({})).not.toEqual([]);
	});

	it("binds the verdict to the claim's content but not to its status or evidence", () => {
		const claim = claimBy(worker.ref.npub);
		expect(peerVerificationClaimDigest({ ...claim, status: "stale", authority: "ci" })).toBe(peerVerificationClaimDigest(claim));
		expect(peerVerificationClaimDigest({ ...claim, scope: { ...claim.scope, tags: ["a", "b"] } })).toBe(peerVerificationClaimDigest(claim));
		expect(peerVerificationClaimDigest(claimBy(worker.ref.npub, "Something else."))).not.toBe(peerVerificationClaimDigest(claim));
	});

	it("mints a signed receipt about the worker that cites the verdict", async () => {
		const refuted = buildPeerVerificationVerdict({ claim: claimBy(worker.ref.npub), verifierNpub: verifier.ref.npub, nsec: verifier.nsec, outcome: "refuted", falsificationAttempts: [broke], summary: "CI failed." });
		const receipt = await mintPeerVerificationReceipt({ verdict: refuted, verifier: verifier.ref as never, nsec: verifier.nsec });
		expect(validateTrustReceipt(receipt)).toEqual([]);
		expect(await verifyTrustReceiptSignature(receipt)).toBe(true);
		expect(receipt).toMatchObject({ receiptType: "claim_refuted", signedByNpub: verifier.ref.npub, evidence: { collaborationContextRef: refuted.claimId, outcomeRef: `peer_verdict:${refuted.verdictId}` } });
		expect(receipt.subject).toMatchObject({ subjectType: "agent", agentRef: { npub: worker.ref.npub } });
		const inconclusive = buildPeerVerificationVerdict({ claim: claimBy(worker.ref.npub), verifierNpub: verifier.ref.npub, nsec: verifier.nsec, outcome: "inconclusive", falsificationAttempts: [], summary: "Could not reach CI." });
		await expect(mintPeerVerificationReceipt({ verdict: inconclusive, verifier: verifier.ref as never, nsec: verifier.nsec })).rejects.toThrow(/inconclusive/);
	});

	it("stands in for evidence up to deploy traces, never for prod smoke or operator sign-off", () => {
		expect(["git_commit", "ci_pipeline", "deploy_trace", "task_master"].every(peerVerificationSatisfiesEvidence)).toBe(true);
		expect(peerVerificationSatisfiesEvidence("prod_smoke")).toBe(false);
		expect(peerVerificationSatisfiesEvidence("operator_signoff")).toBe(false);
	});

	it("is gated off in production", () => {
		expect(FEATURE_GATE_DEFINITIONS.find((gate) => gate.id === "peer_verification")?.default_state_by_environment).toMatchObject({ production: "off", lab: "internal" });
	});
});
