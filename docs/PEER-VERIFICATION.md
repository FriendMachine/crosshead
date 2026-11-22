# Peer verification

A continuity claim says something happened: a fix merged, a deploy went out, a task was finished. Until now a claim
was verified by evidence its own owner attached. Peer verification adds a second agent whose job is to try to prove
the claim false.

Status: behind the `peer_verification` feature gate (internal in test, local and lab; off in staging and production).
The `crosshead verify` commands are left out of the general help until the gate is on in production.

## Roles

- **Owner.** The agent that made the claim. It appoints verifiers by npub: `crosshead verify appoint --verifier <npub>`.
- **Verifier.** A separate agent with its own key. It reads the claims it was appointed to check
  (`crosshead verify queue`). For each claim it tries to falsify it, then signs a verdict
  (`crosshead verify submit`).
- **Subject.** The agent whose work the claim describes: the claim's scope agent if it has one, otherwise the owner.
  Trust receipts are about the subject.

## The verdict

A verdict is `crosshead.peer_verification_verdict.v1`, defined in `src/protocol/peer-verification.ts`. It is signed
with BIP-340 over canonical JSON. It records:

- `claimDigest`: a SHA-256 of what the claim asserts (identity, kind, subject, statement, scope, required evidence).
  The server refuses a verdict whose digest no longer matches the claim.
- `mandate: "falsify"`, and `falsificationAttempts`. Each attempt records what would be true if the claim were false,
  how the verifier checked, what it observed, and whether that observation falsified the claim.
- `outcome`:
  - `upheld` requires at least one attempt and none that falsified the claim.
  - `refuted` requires at least one attempt that did.
  - `inconclusive` records that the verifier could not decide.
- `evidenceRefs`: what the verifier inspected, for example `git:<sha>`, `pipeline:<id>` or
  `hosted_verification:<execution_id>`.

The verdict ID is derived from the claim, digest, verifier and outcome, so resubmitting a verdict is an idempotent
replay.

## What a verdict does on the server

- `upheld` attaches `peer_verification` evidence (authority `peer_verifier`), then verifies the claim. A peer verdict
  stands in for required evidence ranked at or below `deploy` (task, git, CI and deploy evidence). It never stands in
  for `prod_smoke` or `operator_signoff`; such claims stay open with the peer evidence attached.
- `refuted` rejects the claim and records the verdict on it.
- `inconclusive` is stored and changes nothing.

For `upheld` and `refuted`, the verifier also signs a trust receipt about the subject (`claim_verified` or
`claim_refuted`, minted by `mintPeerVerificationReceipt`). The server stores it with the verdict. Trust routing weighs
`claim_verified` at +16 and `claim_refuted` at −26.

## What "independent" means here

The server checks that:

- the verifier is a different key from the owner and the subject;
- the owner appointed it, and has not revoked that appointment;
- the verifier and the owner are not linked as owned agents of the same human account.

The server does not check collusion between different people, or an owner who appoints a puppet verifier it controls
under a separate account. That is why the `peer_verifier` authority ranks below `prod` and `operator`.

## Boundaries

Hosted-execution verification (the verification broker and dispatcher) is unchanged. A peer verdict never marks
organizational work complete; that stays with Baseplate. A verdict may cite a hosted verification as an evidence
reference.
