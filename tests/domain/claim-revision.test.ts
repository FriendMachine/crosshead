import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/protocol/agent-deals";
import {
  continuityClaimEvidenceMatchesRevision, normalizeContinuityClaimRevision, type ContinuityClaim,
} from "../../src/protocol/continuity-claims";
import { peerVerificationClaimDigest } from "../../src/protocol/peer-verification";

const A = "a".repeat(40), B = "b".repeat(40), T = "c".repeat(40);
const claim = (revision?: object): ContinuityClaim => ({
  id: "4b8e7a52-5d0b-4f61-9d33-2d6b6f0f6a01", npub: "npub1owner" as never, kind: "implementation", status: "open",
  subject: { type: "implementation", ref: "mr:84", ...(revision ? { revision: revision as never } : {}) },
  statement: "The retry fix is merged and CI passed.",
  scope: { workspaceId: "repo:onlybots", repo: null, taskId: null, environment: null, agentNpub: null, tags: ["b", "a"] },
  authority: "runtime", verificationPlan: { requiredEvidence: ["git_commit", "ci_pipeline"], description: null, checklist: [] },
  freshness: {}, supersedes: [], supersededBy: null, verifiedAt: null, rejectedAt: null, staleAt: null,
  idempotencyKey: null, metadata: {}, createdAt: new Date(), updatedAt: new Date(),
});

describe("claim revisions", () => {
  it("normalizes a revision and rejects abbreviations and unknown fields", () => {
    expect(normalizeContinuityClaimRevision(undefined)).toBeNull();
    expect(normalizeContinuityClaimRevision({ commitSha: A.toUpperCase(), repo: " group/app ", targetRef: "main" }))
      .toEqual({ commitSha: A, repo: "group/app", targetRef: "main" });
    expect(normalizeContinuityClaimRevision({ commitSha: "abc123" })).toMatchObject({ error: expect.stringContaining("full") });
    expect(normalizeContinuityClaimRevision({ commitSha: A, treeSha: "xyz" })).toMatchObject({ error: expect.stringContaining("treeSha") });
    expect(normalizeContinuityClaimRevision({ commitSha: A, extra: 1 })).toMatchObject({ error: expect.stringContaining("extra") });
    expect(normalizeContinuityClaimRevision([A])).toMatchObject({ error: expect.any(String) });
  });

  it("counts revision-bearing evidence only for the declared commit or tree", () => {
    const revision = { commitSha: A, treeSha: T };
    expect(continuityClaimEvidenceMatchesRevision(revision, { kind: "git_commit", metadata: { commitSha: A } })).toEqual({ matches: true });
    expect(continuityClaimEvidenceMatchesRevision(revision, { kind: "ci_pipeline", metadata: { commitSha: B } }))
      .toMatchObject({ matches: false, reason: expect.stringContaining(B) });
    expect(continuityClaimEvidenceMatchesRevision(revision, { kind: "ci_pipeline", metadata: { commitSha: B, treeSha: T } })).toEqual({ matches: true });
    expect(continuityClaimEvidenceMatchesRevision(revision, { kind: "deploy_trace", metadata: {} }))
      .toMatchObject({ matches: false, reason: expect.stringContaining("names no commit") });
    expect(continuityClaimEvidenceMatchesRevision(revision, { kind: "operator_signoff", metadata: {} })).toEqual({ matches: true });
    expect(continuityClaimEvidenceMatchesRevision(null, { kind: "ci_pipeline", metadata: { commitSha: B } })).toEqual({ matches: true });
  });

  it("leaves peer-verdict digests of claims without a revision unchanged, and binds those with one", () => {
    const plain = claim();
    // The digest formula before revisions existed.
    const before = `sha256:${createHash("sha256").update(canonicalJson({
      id: plain.id, npub: plain.npub, kind: plain.kind, subject: { type: plain.subject.type, ref: plain.subject.ref },
      statement: plain.statement,
      scope: { workspaceId: "repo:onlybots", repo: null, taskId: null, environment: null, agentNpub: null, tags: ["a", "b"] },
      requiredEvidence: ["ci_pipeline", "git_commit"], staleAt: null,
    }), "utf8").digest("hex")}`;
    expect(peerVerificationClaimDigest(plain)).toBe(before);
    const bound = peerVerificationClaimDigest(claim({ commitSha: A }));
    expect(bound).not.toBe(before);
    expect(peerVerificationClaimDigest(claim({ commitSha: B }))).not.toBe(bound);
  });
});
