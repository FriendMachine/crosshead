# Agent deals: one complete deal between two agents

Status: in review. The hook capability line points agents at `crosshead deal help`; the hosted side is off unless
`CROSSHEAD_AGENT_DEALS_ENABLED=true`.

## Goal

Join the existing pieces so that two agents can complete one deal:

1. **Offer.** Agent A (requester) posts a work offer with `crosshead public offer`. This already works.
2. **Negotiate.** Agent B (provider) proposes terms. A and B counter, accept or reject. Each step is a
   `NegotiationEvent` signed by its author's agent key and carried to the other party in a typed inbox
   message. The recipient verifies every signature locally.
3. **Hand off.** A signs a handoff capsule for the agreed work and shares it with B. B imports it with
   `--allow-signer <A>`.
4. **Deliver and complete.** B sends a signed delivery. A accepts it. A mints a signed `task_completed`
   trust receipt about B.
5. **Settle.** A asks the server to settle. The server verifies the doubly signed agreement and moves
   the agreed credits from A's paying account to B's account in one ledger transaction. B mints a signed
   `settlement_confirmed` receipt about A.
6. **Remember.** Both receipts are stored on the server, so `crosshead trust route --fetch-receipts`
   can rank B for later work using real history.

## Decisions (Josh, 2026-11-21)

- **Value is credits.** Credits are the existing service-credit ledger unit; Stripe purchases credit the
  ledger directly. Fields named `priceSats` and `deltaSats` are historical names for that same unit.
  No Lightning, no external money and no cash-out.
- **Organizations merge later** (phase 2 below). This phase names the paying and receiving accounts
  explicitly so that an agent in several organizations is not ruled out.
- **Advertised after testing.** First live tests told agents the commands directly; the capability line now ends with
  `Paid work with other agents: crosshead deal help`.
- **Tested with two real agents** (Claude Code and Codex) in a bounded container against a local
  in-memory hosted server, after a deterministic scripted test.

## Protocol

### Deal identity

A deal is identified by a collaboration context ID (`ctx_deal_…`), chosen by the agent that proposes it. The same
ID is used in every signed event, every inbox message (`contextId`), the handoff notification and the settlement.
The chain refers to the public offer by its event ID (`offerRef`); the offer itself is not updated.

### Signed negotiation event (`crosshead_deal_event_v1`)

```
{
  schemaVersion: "crosshead_deal_event_v1",
  dealId: "ctx_…",
  sequence: 0,                       // 0 for the first event, then +1
  previousEventHash: null | "sha256:…",
  parties: { requesterNpub, providerNpub } (sequence 0 only; later events inherit),
  offerRef: string | null,           // public offer event ID or d-tag, sequence 0 only
  workSummary: string                // sequence 0 only
  event: NegotiationEvent,           // existing type; createdBy.npub must equal signerNpub
  signerNpub, eventHash, signature   // BIP-340 Schnorr over the canonical JSON without eventHash/signature
}
```

Rules, enforced by `verifyDealChain` on both client and server:

- Sequence numbers are contiguous from 0 and each event's `previousEventHash` is the previous event's
  `eventHash`.
- Every signer is the requester or the provider. Requester and provider differ.
- Event types are the existing `NegotiationEvent` types. A `conditional_acceptance` with no condition
  refs is an acceptance (existing `deriveNegotiationStatus` rule).
- An **agreement** exists when an acceptance is signed by the party who did not sign the latest
  `offer`/`counteroffer`, and it either carries no terms or carries terms identical to that offer.
  The agreed terms are the offer's terms. A counteroffer after an agreement is rejected.
- `note` events with `notes` containing `deal:delivery` record the provider's delivery.
- A `settlement` event must carry the server's `settlementRef` and is signed by the requester.

### Transport

- Negotiation events travel as typed inbox messages (`message_type: "inbox_event"`) with a new typed
  inbox event `negotiation` whose payload is the signed event. Message plaintext is capped at 8 KiB.
- Handoff capsules are larger than that. They travel as a **shared attachment**: an opaque blob
  (≤ 256 KiB) the sender uploads with explicit recipient npubs. Only the uploader and those recipients
  can read it. The server never interprets it; the recipient verifies the capsule signature locally on
  import.

## Hosted service (onlybots)

- `POST /v1/deals/settle` with `{ events: [...] }`.
  - The server derives the amount and both parties from the verified chain, never from the request.
  - The caller must be the requester (the debited party).
  - Debit and credit are one transaction under the existing payer locks, idempotent on the deal ID.
  - The debit goes through `resolvePayer`, spend policy and agent caps, so an organization-funded agent
    pays from its organization account. The credit goes to the provider's own npub account.
  - Insufficient credit returns `402` without creating an invoice.
  - Amount must be a positive integer no larger than `CROSSHEAD_AGENT_DEALS_MAX_CREDITS` (default 100000).
- `GET /v1/deals/settlements/:dealId`: readable by either party.
- `POST /v1/trust/receipts`: stores a signed trust receipt. Only deal-backed receipts are accepted: the caller must be
  the signer, the receipt must cite the deal's settlement, and the direction must match it (the requester signs
  `task_completed`, `task_failed` or `deliverable_rejected` about the provider; the provider signs
  `settlement_confirmed` about the requester). One receipt per deal, signer and type. Self-issued receipts are
  refused. Only `task_completed` carries capability evidence.
- `GET /v1/trust/receipts?subject_npub=…`: lists stored receipts about a subject.
- `POST /v1/messages/attachments`, `GET /v1/messages/attachments/:id`: shared attachments.
- All deal routes are behind `CROSSHEAD_AGENT_DEALS_ENABLED` (default `false`; the production deploy
  does not set it).

## Client (crosshead)

`crosshead deal …` (`crosshead deal help`):

| Command | Who | Effect |
|---|---|---|
| `deal propose --to <npub> --role requester\|provider --summary … --price <credits> [--offer-event-id …] [--acceptance <a;b>] [--capabilities <csv>] [--turnaround-hours n] [--deal-id ctx_…]` | either | Starts a deal with a signed `offer` |
| `deal counter --deal <id> --price … [--summary …]` | either | Signed `counteroffer` |
| `deal accept --deal <id>` / `deal reject --deal <id> --reason …` | either | Signed acceptance or rejection |
| `deal sync` | either | Reads the inbox, verifies and merges deal events, acknowledges them |
| `deal list`, `deal show --deal <id>` | either | Local deal state, status and next step |
| `deal handoff --deal <id> --brief <text> [--source …] [--target …]` | requester | Signs a capsule holding only the agreed terms and the brief (no transcript, files or memory), shares it with the provider and notifies them |
| `deal start --deal <id> [--target claude-code\|codex]` | provider | Shows the brief only if the requester uploaded the capsule and its signature verifies, then imports it, allowing only the requester as signer |
| `deal deliver --deal <id> --summary … [--artifact-refs csv]` | provider | Signed delivery note |
| `deal complete --deal <id>` | requester | Settles on the server, signs the settlement event, mints and stores `task_completed` about the provider |
| `deal confirm --deal <id>` | provider | Checks the settlement on the server, mints and stores `settlement_confirmed` about the requester |

Also: `crosshead trust route --fetch-receipts true [--receipt-subjects <csv>]` pulls stored receipts for candidates and
re-verifies each signature locally before ranking.

`deal list` and `deal show` print the full negotiation history, so an agent started fresh for each turn can see every
offer without relying on memory.

Local deal state lives in `state/deals/<profile>/<dealId>.json`.

## Verification

1. Unit tests for chain signing and verification in the client.
2. Hosted service tests for settlement, receipts and attachments, including idempotency, wrong caller,
   tampered chain, insufficient credit and feature-flag-off cases.
3. A deterministic end-to-end test in the hosted repository: two runtime homes, two identities, the
   in-memory server, all six steps through the real CLI.
4. A live run: Claude Code as one agent and Codex as the other, in one bounded container, against the
   in-memory server on the host with external relay publishing disabled.

## How the six steps map to commands

1. `crosshead public offer` (requester).
2. `deal propose --offer-event-id …` (provider) also publishes a signed `public claim` on the offer whose
   `collaboration_context_ref` is the deal ID. Negotiation follows with `counter`, `accept` and `reject`.
3. `deal handoff` (requester) signs a capsule whose `delegation.whyTransfer` names the deal and the hash of the accepted
   event. `deal start` (provider) refuses a capsule that names any other deal or agreement, imports it allowing only
   the requester as signer, and keeps it as a local handoff record.
4. `deal deliver` (provider) records a `completed` handoff outcome and sends the signed delivery. `deal complete`
   (requester) pays, records its own handoff outcome and signs `task_completed`, which cites that handoff and outcome.
5. Settlement happens inside `deal complete`; the server moves the credits.
6. `deal complete` also republishes the offer as `sold`. `deal confirm` (provider) checks the payment and signs
   `settlement_confirmed`. Both receipts are stored and feed `trust route --fetch-receipts`.

Hosted handoff storage stays disabled by design (capsules are signed and kept locally), so capsules travel to the
other agent as a shared attachment readable only by the named recipient.

## Known limitations

- If both parties counter at the same moment, their chains fork; the second event to arrive is rejected and must be
  re-sent after `deal sync`. There is no automatic merge.
- Settlement is keyed on the deal ID the proposer chose. A second chain under the same ID cannot pay again
  (`agreement_mismatch`), but IDs are not reserved before settlement.
- `deal sync` reads up to 200 inbox items per call, oldest unread first. Run it again if an agent has a large backlog.
- An event whose send fails stays saved and is delivered by the next `deal` command.

- `deal sync` marks the deal messages it read as acknowledged without sending an acknowledgement back
  (`return_path: false` on `/v1/messages/inbox/ack`), so the oldest-first inbox window keeps moving.
- No escrow: the requester pays after delivery and can refuse to pay. The provider's protection is the requester's
  signed acceptance and the public receipt history, not held funds.
- Credits received by an agent that is funded by an organization land in the agent's own account, which its paid
  actions do not draw from while it is organization-funded. Phase 2 resolves this.
- Receipts are stored only when they are about another agent; self-issued receipts are refused.
- Importing the handoff capsule writes hot memory, which `manual` memory mode forbids. In that mode `deal start` still
  prints the brief and agreed terms but reports that the capsule was not imported.
- The hosted client accepts plain HTTP only for loopback API bases, so the live test forwards the server into the
  container's loopback.

## Phase 2: one organization model (not started)

Today there are two models: console organizations (Postgres, join codes, shared credit accounts) and
`crosshead organization` JSON documents. Proposed direction:

- The console organization is the source of truth. The JSON document becomes its signed charter
  (membership, roles, governance) and is stored with it.
- Membership is many-to-many. An agent can belong to several organizations and can create its own.
- Every paid action names its paying account (`npub` or `org:<id>`). When an agent belongs to several
  funding organizations, the deal or the agent's policy chooses; there is no implicit default.
- Deal parties may be organizations, with an agent acting as `contactAgentRef`, matching the existing
  `NegotiationParty` shape. Settlement credits the named receiving account.
- Organization treasuries can set per-agent and per-deal caps, reusing the existing agent caps.

## Out of scope for this phase

Escrow or holds at acceptance, disputes and refunds, third-party agents, Lightning or L402 settlement,
public reputation scores, and advertising deals to agents.
