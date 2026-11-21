import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { AgentDealChainError, agentDealEventHash, verifyAgentDealChain } from "../../src/protocol/agent-deals";
import { validateTypedInboxEvent } from "../../src/protocol/collaboration";
import { validateTrustReceipt } from "../../src/protocol/trust";
import {
	buildDealTerms,
	buildNegotiationMessage,
	buildNextDealEvent,
	deliveryNotes,
	mergeIncomingDealEvents,
	mintAgentDealReceipt,
	newAgentDealId,
	newLocalAgentDeal,
	signAgentDealEvent,
	verifyAgentDealSignature,
	verifyDealEvents,
	type LocalAgentDealRecord,
} from "../../src/runtime/agent-deals";
import { verifyTrustReceiptSignature } from "../../src/runtime/trust-routing";

const agent = (name: string) => {
	const secret = generateSecretKey();
	const npub = nip19.npubEncode(getPublicKey(secret));
	return { nsec: nip19.nsecEncode(secret), ref: { agentId: `agent_${name}`, npub, lineageRoot: `agent_${name}` } };
};

const requester = agent("requester");
const provider = agent("provider");
const outsider = agent("outsider");

const startDeal = async () => {
	const record = newLocalAgentDeal(newAgentDealId(), "default", requester.ref.npub);
	const offer = await buildNextDealEvent({
		record,
		agentRef: requester.ref,
		nsec: requester.nsec,
		eventType: "offer",
		summary: "Review the parser",
		terms: buildDealTerms({ priceCredits: 500, acceptanceCriteria: ["no regressions"], requiredCapabilityIds: ["code.review"] }),
		genesis: { parties: { requesterNpub: requester.ref.npub, providerNpub: provider.ref.npub }, offerRef: null, workSummary: "Review the parser" },
	});
	record.events.push(offer.signed);
	return record;
};

const append = async (record: LocalAgentDealRecord, who: typeof requester, input: Omit<Parameters<typeof buildNextDealEvent>[0], "record" | "agentRef" | "nsec">) => {
	const built = await buildNextDealEvent({ record, agentRef: who.ref, nsec: who.nsec, ...input });
	record.events.push(built.signed);
	return built.state;
};

describe("agent deal chains", () => {
	it("reaches agreement, delivery and settlement only through the right signers", async () => {
		const record = await startDeal();
		let state = await append(record, provider, { eventType: "counteroffer", summary: "600 please", terms: buildDealTerms({ priceCredits: 600, acceptanceCriteria: ["no regressions"], requiredCapabilityIds: ["code.review"] }) });
		expect(state.status).toBe("open");
		state = await append(record, requester, { eventType: "conditional_acceptance", summary: "ok", terms: state.currentTerms, conditionRefs: [] });
		expect(state.status).toBe("accepted");
		expect(state.agreement?.priceCredits).toBe(600);
		state = await append(record, provider, { eventType: "note", summary: "Reviewed; 3 findings", notes: deliveryNotes(["pr:12"]) });
		expect(state.delivery?.artifactRefs).toEqual(["pr:12"]);
		state = await append(record, requester, { eventType: "settlement", summary: "Paid", settlementRef: "deal_settlement_x" });
		expect(state.status).toBe("settled");
		expect(state.settlementRef).toBe("deal_settlement_x");
	});

	it("rejects self-acceptance, changed terms, outsiders and tampering", async () => {
		const record = await startDeal();
		await expect(append(record, requester, { eventType: "conditional_acceptance", summary: "self", terms: (await verifyDealEvents(record.events)).currentTerms })).rejects.toThrow(/other party/);
		await expect(
			append(record, provider, { eventType: "conditional_acceptance", summary: "cheaper", terms: buildDealTerms({ priceCredits: 1, acceptanceCriteria: ["no regressions"], requiredCapabilityIds: ["code.review"] }) })
		).rejects.toThrow(/repeat the offered terms/);
		await expect(append(record, outsider, { eventType: "note", summary: "hi" })).rejects.toThrow(/not a party/);

		const tampered = JSON.parse(JSON.stringify(record.events));
		tampered[0].event.terms.priceSats = 1;
		await expect(verifyDealEvents(tampered)).rejects.toThrow(AgentDealChainError);

		// Re-hashing the tampered content does not help without the key.
		tampered[0].eventHash = agentDealEventHash(tampered[0]);
		await expect(verifyDealEvents(tampered)).rejects.toThrow(/signature/);
	});

	it("refuses delivery before agreement and settlement by the provider", async () => {
		const record = await startDeal();
		await expect(append(record, provider, { eventType: "note", summary: "early", notes: deliveryNotes([]) })).rejects.toThrow(/before agreement/);
		const state = await append(record, provider, { eventType: "conditional_acceptance", summary: "ok", terms: (await verifyDealEvents(record.events)).currentTerms, conditionRefs: [] });
		await expect(append(record, provider, { eventType: "settlement", summary: "pay me", settlementRef: "x" })).rejects.toThrow(/only the requester/);
		await expect(append(record, provider, { eventType: "counteroffer", summary: "more", terms: buildDealTerms({ priceCredits: 900 }) })).rejects.toThrow(/after agreement/);
		expect(state.status).toBe("accepted");
	});

	it("merges events that arrive out of order and drops conflicting ones", async () => {
		const source = await startDeal();
		const terms = (await verifyDealEvents(source.events)).currentTerms;
		await append(source, provider, { eventType: "conditional_acceptance", summary: "ok", terms, conditionRefs: [] });
		await append(source, provider, { eventType: "note", summary: "done", notes: deliveryNotes([]) });

		const mirror = newLocalAgentDeal(source.dealId, "default", provider.ref.npub);
		const late = await mergeIncomingDealEvents(mirror, [source.events[2]!]);
		expect(late.appended).toBe(0);
		expect(mirror.pendingEvents).toHaveLength(1);
		const rest = await mergeIncomingDealEvents(mirror, [source.events[1]!, source.events[0]!]);
		expect(rest.appended).toBe(3);
		expect(mirror.events.map((event) => event.sequence)).toEqual([0, 1, 2]);

		const forged = signAgentDealEvent({ ...source.events[1]!, event: { ...source.events[1]!.event, summary: "different" } }, provider.nsec);
		const conflict = await mergeIncomingDealEvents(mirror, [forged]);
		expect(conflict.rejected[0]).toMatch(/conflicts/);
	});

	it("builds valid negotiation messages and verifiable receipts about the other party", async () => {
		const record = await startDeal();
		const state = await verifyDealEvents(record.events);
		const message = buildNegotiationMessage({ signed: record.events[0]!, state, agentRef: requester.ref });
		expect(message.recipient_npub).toBe(provider.ref.npub);
		expect(validateTypedInboxEvent(message.inbox_event)).toEqual([]);

		const wrongContext = JSON.parse(JSON.stringify(message.inbox_event));
		wrongContext.contextId = "ctx_other_deal";
		expect(validateTypedInboxEvent(wrongContext)).toContain("negotiation.dealEvent.dealId must equal contextId");

		await append(record, provider, { eventType: "conditional_acceptance", summary: "ok", terms: state.currentTerms, conditionRefs: [] });
		const accepted = await verifyDealEvents(record.events);
		const receipt = await mintAgentDealReceipt({ state: accepted, receiptType: "task_completed", signer: requester.ref, nsec: requester.nsec, settlementRef: "s1", handoffRef: null, summary: "good work" });
		expect(validateTrustReceipt(receipt)).toEqual([]);
		expect(await verifyTrustReceiptSignature(receipt)).toBe(true);
		expect(receipt.subject).toEqual({ subjectType: "agent", agentRef: provider.ref });
		expect(receipt.evidence.evidenceRefs).toContain("capability:code.review");
	});

	it("verifies signatures with the protocol verifier", async () => {
		const record = await startDeal();
		await expect(verifyAgentDealChain(record.events, () => false)).rejects.toThrow(/signature/);
		await expect(verifyAgentDealChain(record.events, verifyAgentDealSignature)).resolves.toMatchObject({ status: "open" });
	});
});
