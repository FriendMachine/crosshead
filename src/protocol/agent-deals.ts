import { createHash } from "crypto";

import type { Npub } from "./base";
import type { PersistentAgentReference } from "./persistent-agents";
import {
  type NegotiationEvent,
  type NegotiationTerms,
  type NegotiationThreadStatus,
  validateNegotiationEvent,
} from "./trust";
import { validatePersistentAgentReference } from "./persistent-agents";

export const AGENT_DEAL_EVENT_SCHEMA_VERSION = "crosshead_deal_event_v1";
export const AGENT_DEAL_DELIVERY_NOTE = "deal:delivery";
export const AGENT_DEAL_MAX_EVENTS = 64;

const DEAL_ID_PATTERN = /^ctx_[a-z0-9][a-z0-9_-]{2,127}$/;
const NPUB_PATTERN = /^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;
const ACCOUNT_PATTERN = /^(npub1[023456789acdefghjklmnpqrstuvwxyz]{58}|org:[a-z0-9][a-z0-9_-]{1,127})$/;

export type AgentDealParties = {
  requesterNpub: Npub;
  providerNpub: Npub;
};

/** One negotiation step, signed by its author's agent key and chained to the previous step. */
export type SignedAgentDealEvent = {
  schemaVersion: typeof AGENT_DEAL_EVENT_SCHEMA_VERSION;
  dealId: string;
  sequence: number;
  previousEventHash: string | null;
  /** Present on sequence 0 only. */
  parties: AgentDealParties | null;
  /** Public offer event ID or listing d-tag. Present on sequence 0 only. */
  offerRef: string | null;
  /** Present on sequence 0 only. */
  workSummary: string | null;
  /**
   * The signer's own ledger account for this deal: the requester's paying account or the provider's receiving
   * account (`npub1…` or `org:<id>`). Omitted or null keeps the default. The value in force is the latest one each
   * party signed on or before the agreement.
   */
  account?: string | null;
  event: NegotiationEvent;
  signerNpub: Npub;
  eventHash: string;
  signature: string;
};

export type UnsignedAgentDealEvent = Omit<SignedAgentDealEvent, "eventHash" | "signature">;

export type AgentDealAgreement = {
  /** The offer or counteroffer whose terms were accepted. */
  offerEventHash: string;
  acceptanceEventHash: string;
  terms: NegotiationTerms;
  /** Agreed price in ledger credit units (the historical `priceSats` field). */
  priceCredits: number;
  /** Accounts each party named on or before the agreement; null means the default. */
  requesterAccount: string | null;
  providerAccount: string | null;
};

export type AgentDealChainState = {
  dealId: string;
  parties: AgentDealParties;
  offerRef: string | null;
  workSummary: string;
  status: NegotiationThreadStatus;
  currentTerms: NegotiationTerms | null;
  agreement: AgentDealAgreement | null;
  delivery: { eventHash: string; summary: string; artifactRefs: string[] } | null;
  settlementRef: string | null;
  agentRefs: Partial<Record<Npub, PersistentAgentReference>>;
  headEventHash: string;
  nextSequence: number;
};

export type AgentDealSignatureVerifier = (input: {
  canonicalPayload: string;
  signature: string;
  signerNpub: Npub;
}) => boolean | Promise<boolean>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Key-sorted JSON. Arrays keep their order; `undefined` members are dropped like JSON.stringify. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

export const agentDealCanonicalPayload = (event: UnsignedAgentDealEvent | SignedAgentDealEvent): string => {
  const { eventHash: _hash, signature: _signature, ...unsigned } = event as SignedAgentDealEvent;
  return canonicalJson(unsigned);
};

export const agentDealEventHash = (event: UnsignedAgentDealEvent | SignedAgentDealEvent): string =>
  `sha256:${createHash("sha256").update(agentDealCanonicalPayload(event), "utf8").digest("hex")}`;

export const isAgentDealId = (value: unknown): value is string => typeof value === "string" && DEAL_ID_PATTERN.test(value);

const termsEqual = (left: NegotiationTerms | null, right: NegotiationTerms | null): boolean =>
  canonicalJson(left) === canonicalJson(right);

export const validateSignedAgentDealEvent = (value: unknown, fieldName = "dealEvent"): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return [`${fieldName} must be an object`];
  }
  if (value.schemaVersion !== AGENT_DEAL_EVENT_SCHEMA_VERSION) {
    errors.push(`${fieldName}.schemaVersion must be ${AGENT_DEAL_EVENT_SCHEMA_VERSION}`);
  }
  if (!isAgentDealId(value.dealId)) {
    errors.push(`${fieldName}.dealId must match ${DEAL_ID_PATTERN}`);
  }
  if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 0) {
    errors.push(`${fieldName}.sequence must be a non-negative integer`);
  }
  const genesis = value.sequence === 0;
  if (genesis) {
    if (value.previousEventHash !== null) errors.push(`${fieldName}.previousEventHash must be null on sequence 0`);
    if (!isRecord(value.parties)) {
      errors.push(`${fieldName}.parties are required on sequence 0`);
    } else {
      for (const key of ["requesterNpub", "providerNpub"] as const) {
        if (typeof value.parties[key] !== "string" || !NPUB_PATTERN.test(value.parties[key] as string)) {
          errors.push(`${fieldName}.parties.${key} must be an npub`);
        }
      }
      if (value.parties.requesterNpub === value.parties.providerNpub) {
        errors.push(`${fieldName}.parties must name two different agents`);
      }
    }
    if (typeof value.workSummary !== "string" || value.workSummary.trim().length === 0) {
      errors.push(`${fieldName}.workSummary is required on sequence 0`);
    }
    if (value.offerRef !== null && (typeof value.offerRef !== "string" || value.offerRef.trim().length === 0)) {
      errors.push(`${fieldName}.offerRef must be a non-empty string or null`);
    }
  } else {
    if (typeof value.previousEventHash !== "string" || !HASH_PATTERN.test(value.previousEventHash)) {
      errors.push(`${fieldName}.previousEventHash must be a sha256 hash`);
    }
    if (value.parties !== null) errors.push(`${fieldName}.parties must be null after sequence 0`);
    if (value.offerRef !== null) errors.push(`${fieldName}.offerRef must be null after sequence 0`);
    if (value.workSummary !== null) errors.push(`${fieldName}.workSummary must be null after sequence 0`);
  }
  if (value.account !== undefined && value.account !== null && (typeof value.account !== "string" || !ACCOUNT_PATTERN.test(value.account))) {
    errors.push(`${fieldName}.account must be an npub or org:<id>`);
  }
  errors.push(...validateNegotiationEvent(value.event, `${fieldName}.event`));
  if (typeof value.signerNpub !== "string" || !NPUB_PATTERN.test(value.signerNpub)) {
    errors.push(`${fieldName}.signerNpub must be an npub`);
  }
  if (isRecord(value.event) && isRecord(value.event.createdBy)) {
    const createdBy = value.event.createdBy;
    if (createdBy.subjectType !== "agent" || !isRecord(createdBy.agentRef) || createdBy.agentRef.npub !== value.signerNpub) {
      errors.push(`${fieldName}.event.createdBy must be the signing agent`);
    }
  }
  if (typeof value.eventHash !== "string" || !HASH_PATTERN.test(value.eventHash)) {
    errors.push(`${fieldName}.eventHash must be a sha256 hash`);
  }
  if (typeof value.signature !== "string" || !SIGNATURE_PATTERN.test(value.signature)) {
    errors.push(`${fieldName}.signature must be a 64-byte hex Schnorr signature`);
  }
  return errors;
};

export class AgentDealChainError extends Error {}

/**
 * Verifies a whole deal chain and derives its state. Throws AgentDealChainError on the first
 * structural, hash, signature or transition problem. Never trusts any derived field in the input.
 */
export const verifyAgentDealChain = async (
  events: readonly unknown[],
  verifySignature: AgentDealSignatureVerifier
): Promise<AgentDealChainState> => {
  if (!Array.isArray(events) || events.length === 0) {
    throw new AgentDealChainError("deal chain must contain at least one event");
  }
  if (events.length > AGENT_DEAL_MAX_EVENTS) {
    throw new AgentDealChainError(`deal chain exceeds ${AGENT_DEAL_MAX_EVENTS} events`);
  }
  let state: AgentDealChainState | null = null;
  let lastOffer: { signerNpub: Npub; eventHash: string; terms: NegotiationTerms } | null = null;
  const namedAccounts: { requester: string | null; provider: string | null } = { requester: null, provider: null };
  const seenEventIds = new Set<string>();

  for (const [index, raw] of events.entries()) {
    const errors = validateSignedAgentDealEvent(raw, `events[${index}]`);
    if (errors.length > 0) {
      throw new AgentDealChainError(errors.join("; "));
    }
    const signed = raw as SignedAgentDealEvent;
    if (signed.sequence !== index) {
      throw new AgentDealChainError(`events[${index}].sequence must be ${index}`);
    }
    if (agentDealEventHash(signed) !== signed.eventHash) {
      throw new AgentDealChainError(`events[${index}].eventHash does not match its content`);
    }
    if (!(await verifySignature({ canonicalPayload: agentDealCanonicalPayload(signed), signature: signed.signature, signerNpub: signed.signerNpub }))) {
      throw new AgentDealChainError(`events[${index}] signature does not verify for ${signed.signerNpub}`);
    }
    if (seenEventIds.has(signed.event.eventId)) {
      throw new AgentDealChainError(`events[${index}].event.eventId repeats an earlier event`);
    }
    seenEventIds.add(signed.event.eventId);
    const agentRefErrors = signed.event.createdBy.subjectType === "agent" ? validatePersistentAgentReference(signed.event.createdBy.agentRef) : ["not an agent"];
    if (agentRefErrors.length > 0) {
      throw new AgentDealChainError(`events[${index}].event.createdBy: ${agentRefErrors.join("; ")}`);
    }

    if (index === 0) {
      const parties = signed.parties!;
      if (signed.signerNpub !== parties.requesterNpub && signed.signerNpub !== parties.providerNpub) {
        throw new AgentDealChainError("the first event must be signed by the requester or the provider");
      }
      if (signed.event.eventType !== "offer") {
        throw new AgentDealChainError("the first event must be an offer");
      }
      state = {
        dealId: signed.dealId,
        parties,
        offerRef: signed.offerRef,
        workSummary: signed.workSummary!,
        status: "open",
        currentTerms: null,
        agreement: null,
        delivery: null,
        settlementRef: null,
        agentRefs: {},
        headEventHash: signed.eventHash,
        nextSequence: 0,
      };
    } else {
      if (signed.dealId !== state!.dealId) {
        throw new AgentDealChainError(`events[${index}].dealId differs from the first event`);
      }
      if (signed.previousEventHash !== state!.headEventHash) {
        throw new AgentDealChainError(`events[${index}].previousEventHash does not match events[${index - 1}]`);
      }
      if (signed.signerNpub !== state!.parties.requesterNpub && signed.signerNpub !== state!.parties.providerNpub) {
        throw new AgentDealChainError(`events[${index}] is signed by an agent that is not a party`);
      }
      if (signed.event.eventType === "offer") {
        throw new AgentDealChainError(`events[${index}]: only the first event may be an offer; use counteroffer`);
      }
    }
    const current = state!;
    const knownRef = current.agentRefs[signed.signerNpub];
    if (knownRef && canonicalJson(knownRef) !== canonicalJson((signed.event.createdBy as { agentRef: PersistentAgentReference }).agentRef)) {
      throw new AgentDealChainError(`events[${index}] changes the signer's agent reference`);
    }
    current.agentRefs[signed.signerNpub] = (signed.event.createdBy as { agentRef: PersistentAgentReference }).agentRef;
    if (signed.account !== undefined && signed.account !== null) {
      if (current.agreement) {
        throw new AgentDealChainError(`events[${index}]: accounts are fixed at agreement and cannot change afterwards`);
      }
      if (signed.account.startsWith("npub1") && signed.account !== signed.signerNpub) {
        throw new AgentDealChainError(`events[${index}]: an agent can only name its own npub as an account`);
      }
      namedAccounts[signed.signerNpub === current.parties.requesterNpub ? "requester" : "provider"] = signed.account;
    }

    if (["settled", "rejected", "expired", "cancelled"].includes(current.status)) {
      throw new AgentDealChainError(`events[${index}] follows terminal status ${current.status}`);
    }
    const event = signed.event;
    switch (event.eventType) {
      case "offer":
      case "counteroffer": {
        if (current.agreement) {
          throw new AgentDealChainError(`events[${index}]: terms cannot change after agreement`);
        }
        if (!event.terms || typeof event.terms.priceSats !== "number" || event.terms.priceSats <= 0) {
          throw new AgentDealChainError(`events[${index}]: offers must name a positive integer price`);
        }
        lastOffer = { signerNpub: signed.signerNpub, eventHash: signed.eventHash, terms: event.terms };
        current.currentTerms = event.terms;
        current.status = "open";
        break;
      }
      case "conditional_acceptance": {
        if (current.agreement) {
          throw new AgentDealChainError(`events[${index}]: the deal is already agreed`);
        }
        if (!lastOffer || lastOffer.signerNpub === signed.signerNpub) {
          throw new AgentDealChainError(`events[${index}]: only the other party can accept the latest offer`);
        }
        if (event.terms && !termsEqual(event.terms, lastOffer.terms)) {
          throw new AgentDealChainError(`events[${index}]: an acceptance must repeat the offered terms exactly; use counteroffer to change them`);
        }
        if (event.conditionRefs.length > 0) {
          current.status = "conditionally_accepted";
          break;
        }
        current.status = "accepted";
        current.agreement = {
          offerEventHash: lastOffer.eventHash,
          acceptanceEventHash: signed.eventHash,
          terms: lastOffer.terms,
          priceCredits: lastOffer.terms.priceSats as number,
          requesterAccount: namedAccounts.requester,
          providerAccount: namedAccounts.provider,
        };
        break;
      }
      case "rejection":
        current.status = "rejected";
        break;
      case "note": {
        if (event.notes.includes(AGENT_DEAL_DELIVERY_NOTE)) {
          if (!current.agreement) {
            throw new AgentDealChainError(`events[${index}]: delivery before agreement`);
          }
          if (signed.signerNpub !== current.parties.providerNpub) {
            throw new AgentDealChainError(`events[${index}]: only the provider can deliver`);
          }
          current.delivery = {
            eventHash: signed.eventHash,
            summary: event.summary,
            artifactRefs: event.notes.filter((note) => note.startsWith("artifact:")).map((note) => note.slice("artifact:".length)),
          };
        }
        break;
      }
      case "settlement": {
        if (!current.agreement) {
          throw new AgentDealChainError(`events[${index}]: settlement before agreement`);
        }
        if (signed.signerNpub !== current.parties.requesterNpub) {
          throw new AgentDealChainError(`events[${index}]: only the requester records settlement`);
        }
        current.settlementRef = event.settlementRef;
        current.status = "settled";
        break;
      }
      default:
        throw new AgentDealChainError(`events[${index}]: unsupported event type`);
    }
    current.headEventHash = signed.eventHash;
    current.nextSequence = index + 1;
  }
  return state!;
};

/** What a party should do next, for CLI output. */
export const describeAgentDealNextStep = (state: AgentDealChainState, selfNpub: Npub, latestSignerNpub: Npub): string => {
  const role = selfNpub === state.parties.requesterNpub ? "requester" : selfNpub === state.parties.providerNpub ? "provider" : "observer";
  switch (state.status) {
    case "open":
      return latestSignerNpub === selfNpub ? "waiting for the other party to accept, counter or reject" : "accept, counter or reject the latest offer";
    case "conditionally_accepted":
      return "resolve the listed conditions, then send an acceptance without conditions";
    case "accepted":
      if (!state.delivery) {
        return role === "requester" ? "send the work with `deal handoff`, then wait for delivery" : "do the work, then send it with `deal deliver`";
      }
      return role === "requester" ? "review the delivery, then pay with `deal complete`" : "waiting for the requester to complete and pay";
    case "settled":
      return role === "provider" ? "confirm payment with `deal confirm`" : "done";
    default:
      return "no further steps";
  }
};
