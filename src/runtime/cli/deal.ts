import { mkdirSync, writeFileSync } from "fs";
import path from "path";

import { describeAgentDealNextStep, type AgentDealChainState, type SignedAgentDealEvent } from "../../protocol/agent-deals";
import { validateTypedInboxEvent } from "../../protocol/collaboration";
import {
	buildDealTerms,
	buildHandoffCreatedMessage,
	buildNegotiationMessage,
	buildNextDealEvent,
	dealRole,
	deliveryNotes,
	dealHandoffBinding,
	latestSignerNpub,
	listAgentDeals,
	loadAgentDeal,
	mergeIncomingDealEvents,
	mintAgentDealReceipt,
	newAgentDealId,
	newLocalAgentDeal,
	requireAgentDeal,
	saveAgentDeal,
	verifyDealEvents,
	unsentOwnEvents,
	type LocalAgentDealRecord,
} from "../agent-deals";
import { verifyHandoffCapsule } from "../handoff-capsules";
import { buildCapturedContinuityContext, normalizeCapturedContextToContinuityIr, type ContinuityRuntime } from "../continuity-ir";
import { OnlyBotsLocalRuntimeDaemon, parseArgs } from "../local-runtime";
import { resolveRuntimePaths } from "../runtime-persistence";

export const dealHelpLines = [
	"crosshead deal propose --to <npub> --role requester|provider --summary <text> --price <credits> [--acceptance <a;b>] [--capabilities <csv>] [--turnaround-hours <n>] [--offer-event-id <id>] [--account <npub|org:id>] [--deal-id <ctx_id>] [--json]",
	"crosshead deal counter --deal <id> --price <credits> [--summary <text>] [--acceptance <a;b>] [--account <npub|org:id>] [--json]",
	"crosshead deal accept --deal <id> [--summary <text>] [--account <npub|org:id>] [--json]",
	"crosshead deal fund --deal <id> [--json]",
	"crosshead deal refund --deal <id> [--json]",
	"crosshead deal reject --deal <id> --reason <text> [--json]",
	"crosshead deal sync [--json]",
	"crosshead deal list [--json]",
	"crosshead deal show --deal <id> [--json]",
	"crosshead deal handoff --deal <id> --brief <text> [--target claude-code|codex] [--source claude-code|codex] [--json]",
	"crosshead deal start --deal <id> [--target claude-code|codex] [--workspace-root <path>] [--json]",
	"crosshead deal deliver --deal <id> --summary <text> [--artifact-refs <csv>] [--json]",
	"crosshead deal complete --deal <id> [--summary <text>] [--json]",
	"crosshead deal confirm --deal <id> [--json]",
];

type Flags = Record<string, string | boolean>;

const str = (flags: Flags, ...keys: string[]): string | undefined => {
	for (const key of keys) {
		const value = flags[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
};

const required = (flags: Flags, key: string, hint: string): string => {
	const value = str(flags, key);
	if (!value) throw new Error(`deal ${hint} requires --${key}`);
	return value;
};

const listFlag = (value: string | undefined, separator: RegExp): string[] =>
	value ? value.split(separator).map((entry) => entry.trim()).filter((entry) => entry.length > 0) : [];

const parsePrice = (flags: Flags): number => {
	const raw = required(flags, "price", "offers");
	if (!/^\d+$/.test(raw)) throw new Error("--price must be a positive whole number of credits");
	return Number(raw);
};

const parseOptionalInt = (value: string | undefined, name: string): number | null => {
	if (value === undefined) return null;
	if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a whole number`);
	return Number(value);
};

const summarize = (record: LocalAgentDealRecord, state: AgentDealChainState | null): Record<string, unknown> => {
	if (!state) {
		return { dealId: record.dealId, status: "unknown", events: record.events.length, pendingEvents: record.pendingEvents.length, lastError: record.lastError };
	}
	const role = dealRole(state, record.selfNpub);
	return {
		dealId: record.dealId,
		role,
		counterpartyNpub: role === "requester" ? state.parties.providerNpub : state.parties.requesterNpub,
		status: state.status,
		workSummary: state.workSummary,
		offerRef: state.offerRef,
		currentTerms: state.currentTerms
			? {
				priceCredits: state.currentTerms.priceSats,
				turnaroundHours: state.currentTerms.turnaroundHours,
				acceptanceCriteria: state.currentTerms.acceptanceCriteria,
				requiredCapabilities: state.currentTerms.requiredCapabilityClaimRefs,
			}
			: null,
		agreedPriceCredits: state.agreement?.priceCredits ?? null,
		latestEvent: (() => {
			const last = record.events[record.events.length - 1];
			return last ? { type: last.event.eventType, by: last.signerNpub === record.selfNpub ? "you" : "counterparty", summary: last.event.summary, at: last.event.createdAt } : null;
		})(),
		history: record.events.map((event) => ({
			sequence: event.sequence,
			type: event.event.eventType,
			by: event.signerNpub === record.selfNpub ? "you" : "counterparty",
			priceCredits: event.event.terms?.priceSats ?? null,
			summary: event.event.summary.length > 160 ? `${event.event.summary.slice(0, 157)}...` : event.event.summary,
		})),
		delivery: state.delivery,
		handoff: record.handoff,
		publicListing: record.publicListing ?? null,
		escrow: record.hold ? { status: record.hold.status, amountCredits: record.hold.amount_credits, deadline: record.hold.deadline, delivered: Boolean(record.hold.delivered_at) } : null,
		settlement: record.settlement ?? (state.settlementRef ? { settlementRef: state.settlementRef } : null),
		receipts: record.receipts,
		events: record.events.length,
		pendingEvents: record.pendingEvents.length,
		nextStep: describeAgentDealNextStep(state, record.selfNpub, latestSignerNpub(record)),
		lastError: record.lastError,
	};
};

const render = (value: Record<string, unknown> | Record<string, unknown>[], json: boolean): string => {
	if (json) return JSON.stringify(value, null, 2);
	const rows = Array.isArray(value) ? value : [value];
	if (rows.length === 0) return "No deals.";
	return rows
		.map((row) => {
			const lines = [`Deal ${String(row.dealId)} · ${String(row.status)}${row.role ? ` · you are the ${String(row.role)}` : ""}`];
			if (row.workSummary) lines.push(`  Work: ${String(row.workSummary)}`);
			if (row.counterpartyNpub) lines.push(`  Counterparty: ${String(row.counterpartyNpub)}`);
			const terms = row.currentTerms as Record<string, unknown> | null | undefined;
			if (terms) {
				lines.push(`  Terms: ${String(terms.priceCredits)} credits${terms.turnaroundHours !== null ? `, ${String(terms.turnaroundHours)}h` : ""}`);
				const criteria = terms.acceptanceCriteria as string[];
				if (criteria?.length) lines.push(`  Acceptance: ${criteria.join("; ")}`);
			}
			const history = row.history as Array<Record<string, unknown>> | undefined;
			if (history && history.length > 0) {
				lines.push("  History:");
				for (const entry of history) {
					lines.push(`    ${String(entry.sequence)}. ${String(entry.type)} by ${String(entry.by)}${entry.priceCredits !== null ? ` (${String(entry.priceCredits)} credits)` : ""}: ${String(entry.summary)}`);
				}
			}
			const delivery = row.delivery as Record<string, unknown> | null | undefined;
			if (delivery) lines.push(`  Delivery: ${String(delivery.summary)}`);
			const escrow = row.escrow as Record<string, unknown> | null | undefined;
			if (escrow) lines.push(`  Escrow: ${String(escrow.status)} ${String(escrow.amountCredits)} credits${escrow.status === "held" ? ` until ${String(escrow.deadline)}` : ""}${escrow.delivered ? " (delivery recorded)" : ""}`);
			const settlement = row.settlement as Record<string, unknown> | null | undefined;
			if (settlement) {
				const amount = settlement.amount_credits !== undefined ? ` (${String(settlement.amount_credits)} credits)` : "";
				lines.push(`  Settlement: ${String(settlement.settlement_id ?? settlement.settlementId ?? settlement.settlementRef)}${amount}`);
			}
			const handoff = row.handoff as Record<string, unknown> | null | undefined;
			if (handoff) {
				const state = handoff.importedAt
					? `imported (${String(handoff.importResult)})`
					: handoff.receivedAt
						? "received; run `crosshead deal start` to read the brief"
						: handoff.sentAt
							? "sent to the provider"
							: "pending";
				lines.push(`  Handoff: ${String(handoff.capsuleId ?? handoff.attachmentId)} ${state}`);
			}
			if (row.nextStep) lines.push(`  Next: ${String(row.nextStep)}`);
			if (row.lastError) lines.push(`  Last error: ${String(row.lastError)}`);
			for (const [key, label] of [["sent", "Sent"], ["note", "Note"]] as const) {
				if (row[key]) lines.push(`  ${label}: ${String(row[key])}`);
			}
			return lines.join("\n");
		})
		.join("\n\n");
};

export const dealFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];
	const json = flags.json === true;
	const home = typeof flags.home === "string" ? flags.home : undefined;
	const paths = resolveRuntimePaths(home);
	if (!subcommand || subcommand === "help") return dealHelpLines.join("\n");
	const daemon = new OnlyBotsLocalRuntimeDaemon(home);
	const session = await daemon.openAgentSession(str(flags, "profile"));
	const self = session.agentRef;
	try {
		const stateOf = async (record: LocalAgentDealRecord): Promise<AgentDealChainState | null> =>
			record.events.length > 0 ? await verifyDealEvents(record.events) : null;

		const sendEvent = async (record: LocalAgentDealRecord, signed: SignedAgentDealEvent, state: AgentDealChainState): Promise<void> => {
			const message = buildNegotiationMessage({ signed, state, agentRef: self });
			const errors = validateTypedInboxEvent(message.inbox_event);
			if (errors.length > 0) throw new Error(`deal message is invalid: ${errors.join("; ")}`);
			// Save first: a failed send is retried by the next deal command, but a lost signed event cannot be recovered.
			record.events.push(signed);
			saveAgentDeal(paths, record);
			await deliver(record, signed, state);
		};

		const deliver = async (record: LocalAgentDealRecord, signed: SignedAgentDealEvent, state: AgentDealChainState): Promise<void> => {
			try {
				await session.client.sendMessage(buildNegotiationMessage({ signed, state, agentRef: self }));
			} catch (error) {
				record.lastError = `event ${signed.sequence} is saved but not delivered yet; the next deal command retries it (${error instanceof Error ? error.message : String(error)})`;
				saveAgentDeal(paths, record);
				throw new Error(record.lastError);
			}
			record.sentEventHashes = [...(record.sentEventHashes ?? []), signed.eventHash];
			if (record.lastError?.includes("not delivered yet")) record.lastError = null;
			saveAgentDeal(paths, record);
		};

		// Deliver any of this agent's events that an earlier command saved but could not send, oldest first.
		for (const record of listAgentDeals(paths, session.profileName)) {
			const pending = unsentOwnEvents(record);
			if (pending.length === 0) continue;
			const state = await verifyDealEvents(record.events);
			try {
				for (const signed of pending) await deliver(record, signed, state);
			} catch {
				// Recorded in lastError; reading or other deals must not be blocked by one undelivered event.
			}
		}

		const step = async (
			record: LocalAgentDealRecord,
			build: Parameters<typeof buildNextDealEvent>[0]
		): Promise<string> => {
			const { signed, state } = await buildNextDealEvent(build);
			await sendEvent(record, signed, state);
			return render({ ...summarize(record, state), sent: `${signed.event.eventType} to ${dealRole(state, self.npub) === "requester" ? state.parties.providerNpub : state.parties.requesterNpub}` }, json);
		};

		// Public listing steps reuse `crosshead public`, so listings get the same validation and signing.
		const runPublic = async (args: string[]): Promise<Record<string, unknown>> => {
			const { publicFromCli } = await import("./public");
			const full = [...args, "--profile", session.profileName, "--json"];
			if (home) full.push("--home", home);
			return JSON.parse(await publicFromCli(full)) as Record<string, unknown>;
		};
		const lookupOffer = async (eventId: string): Promise<{ authorNpub: string; payload: Record<string, unknown> } | null> => {
			const result = await runPublic(["state", "--event-id", eventId, "--event-type", "task_offer"]);
			const items = Array.isArray(result.items) ? (result.items as Array<Record<string, unknown>>) : [];
			const item = items.find((candidate) => candidate.event_id === eventId || candidate.eventId === eventId) ?? items[0];
			const payload = item?.payload as Record<string, unknown> | undefined;
			return item && payload ? { authorNpub: String(item.author_npub ?? ""), payload } : null;
		};
		const publishedEventId = (result: Record<string, unknown>): string | null =>
			String((result.relay_event as Record<string, unknown> | undefined)?.id ?? (result.event as Record<string, unknown> | undefined)?.id ?? "") || null;

		const fundDeal = async (record: LocalAgentDealRecord): Promise<void> => {
			const result = await session.client.holdAgentDeal({ events: record.events });
			record.hold = (result.hold as Record<string, unknown>) ?? result;
			saveAgentDeal(paths, record);
		};
		const registerDelivery = async (record: LocalAgentDealRecord): Promise<void> => {
			try {
				const result = await session.client.recordAgentDealDelivery({ events: record.events });
				record.hold = (result.hold as Record<string, unknown>) ?? record.hold;
				record.deliveryRegistered = true;
			} catch (error) {
				record.lastError = `delivery not yet recorded with the server; \`crosshead deal sync\` retries it (${error instanceof Error ? error.message : String(error)})`;
			}
			saveAgentDeal(paths, record);
		};

		switch (subcommand) {
			case "propose": {
				const to = required(flags, "to", "propose");
				const role = required(flags, "role", "propose");
				if (role !== "requester" && role !== "provider") throw new Error("--role must be requester or provider (your role in the deal)");
				if (to === self.npub) throw new Error("--to must be another agent");
				const dealId = str(flags, "deal-id") ?? newAgentDealId();
				if (loadAgentDeal(paths, session.profileName, dealId)) throw new Error(`deal ${dealId} already exists`);
				const summary = required(flags, "summary", "propose");
				const record = newLocalAgentDeal(dealId, session.profileName, self.npub);
				const terms = buildDealTerms({
					priceCredits: parsePrice(flags),
					turnaroundHours: parseOptionalInt(str(flags, "turnaround-hours"), "turnaround-hours"),
					acceptanceCriteria: listFlag(str(flags, "acceptance"), /;/),
					requiredCapabilityIds: listFlag(str(flags, "capabilities"), /,/),
				});
				const offerEventId = str(flags, "offer-event-id", "offer-ref") ?? null;
				const output = await step(record, {
					record,
					agentRef: self,
					nsec: session.nsec,
					eventType: "offer",
					summary: str(flags, "message") ?? summary,
					terms,
					account: str(flags, "account") ?? null,
					genesis: {
						parties: role === "requester" ? { requesterNpub: self.npub, providerNpub: to } : { requesterNpub: to, providerNpub: self.npub },
						offerRef: offerEventId,
						workSummary: summary,
					},
				});
				// Step 2: a provider answering a public offer also claims it publicly, pointing at this deal.
				if (role === "provider" && offerEventId) {
					try {
						const offer = await lookupOffer(offerEventId);
						if (!offer || offer.authorNpub !== to) throw new Error("the offer was not found or is not by --to");
						const claim = await runPublic([
							"claim", "--claim-id", `claim_${dealId.replace(/^ctx_/, "")}`, "--offer-id", String(offer.payload.offerId),
							"--offer-event-id", offerEventId, "--summary", `Proposed terms in deal ${dealId}`,
							"--claim-state", "claimed", "--collaboration-context-ref", dealId,
						]);
						record.publicListing = { ...record.publicListing, claimEventId: publishedEventId(claim) };
					} catch (error) {
						record.publicListing = { ...record.publicListing, error: `public claim not published: ${error instanceof Error ? error.message : String(error)}` };
					}
					saveAgentDeal(paths, record);
				}
				return output;
			}
			case "counter": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "counter"));
				const state = await stateOf(record);
				const base = state?.currentTerms;
				const terms = buildDealTerms({
					priceCredits: parsePrice(flags),
					turnaroundHours: str(flags, "turnaround-hours") !== undefined ? parseOptionalInt(str(flags, "turnaround-hours"), "turnaround-hours") : base?.turnaroundHours ?? null,
					acceptanceCriteria: str(flags, "acceptance") !== undefined ? listFlag(str(flags, "acceptance"), /;/) : base?.acceptanceCriteria ?? [],
					requiredCapabilityIds: (base?.requiredCapabilityClaimRefs ?? []).map((ref) => ref.replace(/^capability:/, "")),
				});
				return await step(record, { record, agentRef: self, nsec: session.nsec, eventType: "counteroffer", summary: str(flags, "summary") ?? `Counteroffer: ${terms.priceSats} credits`, terms, account: str(flags, "account") ?? null });
			}
			case "accept": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "accept"));
				const state = await stateOf(record);
				if (!state?.currentTerms) throw new Error("there is no offer to accept");
				return await step(record, { record, agentRef: self, nsec: session.nsec, eventType: "conditional_acceptance", summary: str(flags, "summary") ?? `Accepted: ${state.currentTerms.priceSats} credits`, terms: state.currentTerms, conditionRefs: [], account: str(flags, "account") ?? null });
			}
			case "reject": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "reject"));
				const reason = required(flags, "reason", "reject");
				return await step(record, { record, agentRef: self, nsec: session.nsec, eventType: "rejection", summary: str(flags, "summary") ?? `Rejected: ${reason}`, reason });
			}
			case "fund": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "fund"));
				const state = await stateOf(record);
				if (!state || dealRole(state, self.npub) !== "requester") throw new Error("only the requester funds a deal");
				if (!state.agreement) throw new Error("the deal is not agreed yet");
				await fundDeal(record);
				return render(summarize(record, state), json);
			}
			case "refund": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "refund"));
				const state = await stateOf(record);
				if (!state || dealRole(state, self.npub) !== "requester") throw new Error("only the requester asks for a refund");
				const result = await session.client.refundAgentDeal({ events: record.events });
				record.hold = (result.hold as Record<string, unknown>) ?? result;
				saveAgentDeal(paths, record);
				return render(summarize(record, state), json);
			}
			case "deliver": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "deliver"));
				const state = await stateOf(record);
				if (!state || dealRole(state, self.npub) !== "provider") throw new Error("only the provider delivers");
				const summaryText = required(flags, "summary", "deliver");
				const artifactRefs = listFlag(str(flags, "artifact-refs"), /,/);
				// Step 4: the provider reports the handoff it worked from as completed.
				if (record.handoff?.localHandoffId && !record.handoff.outcomeRef) {
					const updated = await daemon.recordHandoffOutcome({
						handoffId: record.handoff.localHandoffId, kind: "completed", reporterRuntime: record.handoff.runtime ?? "codex",
						summary: summaryText.slice(0, 500), taskSucceeded: true,
					}, session.profileName);
					const outcomes = (updated.outcomes as Array<{ outcomeId: string }>) ?? [];
					record.handoff.outcomeRef = `handoff_outcome:${record.handoff.localHandoffId}:${outcomes[outcomes.length - 1]?.outcomeId}`;
					saveAgentDeal(paths, record);
				}
				if (record.handoff?.localHandoffId) artifactRefs.push(`handoff:${record.handoff.localHandoffId}`);
				const delivered = await step(record, {
					record,
					agentRef: self,
					nsec: session.nsec,
					eventType: "note",
					summary: summaryText,
					notes: deliveryNotes(artifactRefs),
				});
				// Record the delivery with the server so the held credits cannot be refunded as undelivered.
				await registerDelivery(record);
				return delivered;
			}
			case "sync": {
				const inbox = await session.client.inspectInboxState({ messageType: "inbox_event", includeTerminal: true, limit: 200 });
				const items = Array.isArray(inbox.items) ? (inbox.items as Array<Record<string, unknown>>) : [];
				const touched = new Map<string, LocalAgentDealRecord>();
				const report: Record<string, unknown>[] = [];
				const grouped = new Map<string, Array<{ inboxId: string; event: Record<string, unknown> }>>();
				const toAcknowledge: string[] = [];
				for (const item of items) {
					const event = item.inboxEvent as Record<string, unknown> | null;
					const inboxId = String(item.id ?? "");
					if (!event || !inboxId || !["negotiation", "handoff_created"].includes(String(event.eventType))) continue;
					if (item.status === "unread") toAcknowledge.push(inboxId);
					const contextId = String(event.contextId ?? "");
					const list = grouped.get(contextId) ?? [];
					list.push({ inboxId, event });
					grouped.set(contextId, list);
				}
				for (const [dealId, entries] of grouped) {
					let record = loadAgentDeal(paths, session.profileName, dealId);
					const fresh = entries.filter((entry) => !record?.processedInboxIds.includes(entry.inboxId));
					if (fresh.length === 0) continue;
					const incoming = fresh
						.filter((entry) => entry.event.eventType === "negotiation")
						.map((entry) => (entry.event.negotiation as { dealEvent: SignedAgentDealEvent }).dealEvent);
					if (!record) {
						const genesis = incoming.find((event) => event.sequence === 0);
						if (!genesis || (genesis.parties?.requesterNpub !== self.npub && genesis.parties?.providerNpub !== self.npub)) continue;
						record = newLocalAgentDeal(dealId, session.profileName, self.npub);
					}
					const merged = await mergeIncomingDealEvents(record, incoming);
					const state = await stateOf(record);
					for (const entry of fresh.filter((candidate) => candidate.event.eventType === "handoff_created")) {
						const attachment = ((entry.event.artifactRefs as string[]) ?? []).find((ref) => ref.startsWith("attachment:"));
						if (attachment && state && (entry.event.actor as Record<string, unknown>)?.npub === state.parties.requesterNpub) {
							record.handoff = {
								attachmentId: attachment.slice("attachment:".length),
								capsuleId: ((entry.event.handoffCreated as Record<string, unknown>)?.handoffId as string) ?? null,
								sentAt: null,
								receivedAt: new Date().toISOString(),
								importedAt: null,
								importResult: null,
							};
						}
					}
					record.processedInboxIds.push(...fresh.map((entry) => entry.inboxId));
					record.lastError = merged.rejected.length > 0 ? merged.rejected.join("; ") : null;
					saveAgentDeal(paths, record);
					touched.set(dealId, record);
					report.push({ ...summarize(record, state), note: `${merged.appended} new event(s)${merged.rejected.length ? `, ${merged.rejected.length} rejected` : ""}` });
				}
				// A provider whose delivery did not reach the server records it now.
				for (const pending of listAgentDeals(paths, session.profileName)) {
					const pendingState = await stateOf(pending).catch(() => null);
					if (pendingState?.delivery && !pending.deliveryRegistered && dealRole(pendingState, self.npub) === "provider") {
						await registerDelivery(pending).catch(() => undefined);
					}
				}
				// Acknowledge what was read so the oldest-first inbox window keeps moving. The deal itself already tells
				// the sender what happened, so no automatic acknowledgement message is sent back.
				for (const inboxId of toAcknowledge) {
					await session.client.acknowledgeInboxItem({ inbox_id: inboxId, return_path: false, note: "read by crosshead deal sync" }).catch(() => undefined);
				}
				if (report.length === 0) return json ? JSON.stringify({ updated: [] }, null, 2) : "No new deal messages.";
				return render(report, json);
			}
			case "list": {
				const records = listAgentDeals(paths, session.profileName);
				const rows: Record<string, unknown>[] = [];
				for (const record of records) rows.push(summarize(record, await stateOf(record).catch(() => null)));
				return render(rows, json);
			}
			case "show": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "show"));
				const state = await stateOf(record);
				return json && flags.events === true
					? JSON.stringify({ ...summarize(record, state), chain: record.events }, null, 2)
					: render(summarize(record, state), json);
			}
			case "handoff": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "handoff"));
				const state = await stateOf(record);
				if (!state || dealRole(state, self.npub) !== "requester") throw new Error("only the requester sends the handoff");
				if (!state.agreement) throw new Error("the deal is not agreed yet");
				const brief = required(flags, "brief", "handoff");
				// Fund before sending work, so the provider can see the credits are held for it.
				if (!record.hold || record.hold.status !== "held") await fundDeal(record);
				const source = (str(flags, "source") ?? "claude-code") as ContinuityRuntime;
				const target = (str(flags, "target") ?? (source === "codex" ? "claude-code" : "codex")) as ContinuityRuntime;
				// Only the agreed terms and the explicit brief go into the capsule: no transcript, files or memory.
				const captured = buildCapturedContinuityContext({
					runtime: source,
					workspaceRoot: process.cwd(),
					workspaceId: `deal:${state.dealId}`,
					sessionId: `deal-${state.dealId}`,
					prompt: brief,
					identity: { agentId: self.agentId, npub: self.npub, lineageRoot: self.lineageRoot },
					task: { objective: state.workSummary, status: "in_progress", openLoops: state.agreement.terms.acceptanceCriteria, priority: null },
					reasoning: { nextAction: brief },
					// Step 3: the capsule names the exact agreement it carries out; the provider checks this on import.
					delegation: { whyTransfer: dealHandoffBinding(state), requestedCapabilities: state.agreement.terms.requiredCapabilityClaimRefs.map((ref) => ref.replace(/^capability:/, "")), recommendedTarget: target },
				});
				const translation = normalizeCapturedContextToContinuityIr(captured, target);
				const created = await daemon.createHandoff({ translation }, session.profileName);
				const capsule = created.capsule as Record<string, unknown>;
				const capsuleId = String(capsule.capsuleId);
				const upload = await session.client.uploadMessageAttachment({
					recipient_npubs: [state.parties.providerNpub],
					content: JSON.stringify(capsule),
					media_type: "application/vnd.crosshead.handoff-capsule+json",
				});
				const attachmentId = String(upload.attachment_id ?? (upload.attachment as Record<string, unknown> | undefined)?.attachment_id ?? "");
				if (!attachmentId) throw new Error("attachment upload returned no attachment_id");
				await session.client.sendMessage(buildHandoffCreatedMessage({ state, agentRef: self, attachmentId, capsuleId, targetRuntimeHost: target }));
				const localHandoffId = String((created.handoff as Record<string, unknown> | undefined)?.handoffId ?? capsuleId);
				record.handoff = { attachmentId, capsuleId, sentAt: new Date().toISOString(), receivedAt: null, importedAt: null, importResult: null, localHandoffId, runtime: source };
				saveAgentDeal(paths, record);
				return render({ ...summarize(record, state), sent: `handoff ${capsuleId} to ${state.parties.providerNpub}` }, json);
			}
			case "start": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "start"));
				const state = await stateOf(record);
				if (!state || dealRole(state, self.npub) !== "provider") throw new Error("only the provider starts the work");
				if (!state.agreement) throw new Error("the deal is not agreed yet");
				const lines = [
					`Deal ${state.dealId}: ${state.workSummary}`,
					`Agreed price: ${state.agreement.priceCredits} credits`,
					...(state.agreement.terms.acceptanceCriteria.length > 0 ? [`Acceptance criteria: ${state.agreement.terms.acceptanceCriteria.join("; ")}`] : []),
				];
				try {
					const holdView = await session.client.readAgentDealHold(state.dealId);
					record.hold = (holdView.hold as Record<string, unknown>) ?? holdView;
					saveAgentDeal(paths, record);
					lines.push(`Funding: ${String(record.hold.amount_credits)} credits held for you until ${String(record.hold.deadline)}`);
				} catch {
					lines.push("Funding: not held yet. Wait until the requester funds the deal before doing paid work.");
				}
				if (record.handoff) {
					const attachment = await session.client.readMessageAttachment(record.handoff.attachmentId);
					const content = String(attachment.content ?? "");
					// Trust the brief only if the requester uploaded it and signed the capsule.
					let parsedCapsule: unknown = null;
					try { parsedCapsule = JSON.parse(content); } catch { parsedCapsule = null; }
					const capsuleCheck = parsedCapsule ? await verifyHandoffCapsule(parsedCapsule) : null;
					const problem =
						attachment.owner_npub !== state.parties.requesterNpub ? "the attachment was not uploaded by the requester"
						: !capsuleCheck?.valid ? `the capsule does not verify (${(capsuleCheck?.errors ?? ["not JSON"]).join("; ")})`
						: capsuleCheck.signedBy !== state.parties.requesterNpub ? "the capsule is not signed by the requester"
						: (parsedCapsule as { continuityIr?: { delegation?: { whyTransfer?: unknown } } }).continuityIr?.delegation?.whyTransfer !== dealHandoffBinding(state)
							? "the capsule is for a different deal or agreement"
						: null;
					if (problem) {
						record.handoff.importedAt = null;
						record.handoff.importResult = `rejected: ${problem}`;
						record.lastError = `handoff rejected: ${problem}`;
						saveAgentDeal(paths, record);
						lines.push(`Handoff rejected: ${problem}. Work from the agreed terms above, or ask the requester to resend.`);
						lines.push("When done: crosshead deal deliver --deal " + state.dealId + " --summary \"<what you delivered>\"");
						return json ? JSON.stringify({ ...summarize(record, state), brief: lines }, null, 2) : lines.join("\n");
					}
					const dir = path.join(paths.state, "deals", session.profileName, "capsules");
					mkdirSync(dir, { recursive: true, mode: 0o700 });
					const capsuleFile = path.join(dir, `${state.dealId}.json`);
					writeFileSync(capsuleFile, content, { mode: 0o600 });
					const { handoffFromCli } = await import("./handoff");
					const target = str(flags, "target") ?? "claude-code";
					const importArgs = ["import", "--file", capsuleFile, "--target", target, "--allow-signer", state.parties.requesterNpub, "--profile", session.profileName, "--json"];
					if (home) importArgs.push("--home", home);
					const workspaceRoot = str(flags, "workspace-root");
					if (workspaceRoot) importArgs.push("--workspace-root", workspaceRoot);
					const previousExitCode = process.exitCode;
					const imported = JSON.parse(await handoffFromCli(importArgs)) as Record<string, unknown>;
					process.exitCode = previousExitCode;
					record.handoff.importedAt = new Date().toISOString();
					record.handoff.runtime = target === "codex" ? "codex" : "claude-code";
					// Keep the verified capsule as this agent's own handoff record, whatever host memory did with it.
					const kept = await daemon.storeReceivedHandoff(parsedCapsule);
					record.handoff.localHandoffId = String(kept.handoffId);
					const verification = imported.verification as { errors?: unknown } | undefined;
					const reasons = Array.isArray(verification?.errors) ? (verification!.errors as unknown[]).map(String) : [];
					// The brief is still shown below: a refused import only means it was not added to host memory.
					record.handoff.importResult = imported.accepted === true
						? "accepted"
						: `not imported into host memory: ${reasons.join("; ") || String(imported.reason ?? "unknown reason")}`;
					saveAgentDeal(paths, record);
					const capsule = JSON.parse(content) as { continuityIr?: { operationalContext?: { currentPrompt?: string | null } } };
					lines.push(`Handoff from the requester: ${record.handoff.importResult}`);
					const brief = capsule.continuityIr?.operationalContext?.currentPrompt;
					if (brief) lines.push(`Brief: ${brief}`);
				} else {
					lines.push("No handoff has arrived. Run `crosshead deal sync`, or start from the agreed terms.");
				}
				lines.push("When done: crosshead deal deliver --deal " + state.dealId + " --summary \"<what you delivered>\"");
				return json ? JSON.stringify({ ...summarize(record, state), brief: lines }, null, 2) : lines.join("\n");
			}
			case "complete": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "complete"));
				let state = await stateOf(record);
				if (!state || dealRole(state, self.npub) !== "requester") throw new Error("only the requester completes and pays");
				if (!state.agreement) throw new Error("the deal is not agreed yet");
				if (!state.delivery) throw new Error("the provider has not delivered yet; run `crosshead deal sync`");
				// 1. Settle on the server. Idempotent on the deal ID, so a retry after a crash is safe.
				if (!record.settlement) {
					const settled = await session.client.settleAgentDeal({ events: record.events });
					record.settlement = (settled.settlement as Record<string, unknown>) ?? settled;
					saveAgentDeal(paths, record);
				}
				const settlementId = String(record.settlement.settlement_id ?? record.settlement.settlementId);
				// 2. Record the settlement in the signed chain and tell the provider.
				if (state.status !== "settled") {
					const built = await buildNextDealEvent({
						record,
						agentRef: self,
						nsec: session.nsec,
						eventType: "settlement",
						summary: str(flags, "summary") ?? `Paid ${state.agreement.priceCredits} credits`,
						settlementRef: settlementId,
					});
					await sendEvent(record, built.signed, built.state);
					state = built.state;
				}
				// 3. Step 4: the requester records the outcome of its handoff, and its receipt cites that outcome.
				if (record.handoff?.localHandoffId && !record.handoff.outcomeRef) {
					const updated = await daemon.recordHandoffOutcome({
						handoffId: record.handoff.localHandoffId, kind: "completed", reporterRuntime: record.handoff.runtime ?? "claude-code",
						summary: `Accepted the delivery and paid ${state.agreement!.priceCredits} credits (${settlementId})`, taskSucceeded: true,
					}, session.profileName);
					const outcomes = (updated.outcomes as Array<{ outcomeId: string }>) ?? [];
					record.handoff.outcomeRef = `handoff_outcome:${record.handoff.localHandoffId}:${outcomes[outcomes.length - 1]?.outcomeId}`;
					saveAgentDeal(paths, record);
				}
				await publishReceipt(record, state, "task_completed", settlementId, str(flags, "summary") ?? `Completed deal: ${state.workSummary}`.slice(0, 300));
				// 4. Step 2: mark the public offer sold, keeping its identity and original publication time.
				if (state.offerRef && !record.publicListing?.soldEventId) {
					try {
						const offer = await lookupOffer(state.offerRef);
						if (!offer || offer.authorNpub !== self.npub) throw new Error("the offer was not found or is not yours");
						const p = offer.payload;
						// Relays keep the newest revision by whole seconds and break ties by event ID, so the sold revision
						// must be at least one second newer than the one it replaces.
						const previous = Date.parse(String(p.updatedAt ?? p.publishedAt));
						const soldAt = new Date(Math.max(Date.now(), (Number.isFinite(previous) ? Math.floor(previous / 1000) * 1000 : 0) + 1000)).toISOString();
						const price = p.price as { amount?: string; currency?: string; frequency?: string } | null | undefined;
						const args = [
							"offer", "--offer-id", String(p.offerId), "--task-ref", String(p.taskRef), "--summary", String(p.summary),
							"--listing-status", "sold", "--published-at", String(p.publishedAt), "--updated-at", soldAt,
							"--collaboration-context-ref", state.dealId,
						];
						if (p.title) args.push("--title", String(p.title));
						if (p.description) args.push("--description", String(p.description));
						if (p.location) args.push("--location", String(p.location));
						if (Array.isArray(p.requiredCapabilityIds) && p.requiredCapabilityIds.length > 0) args.push("--required-capability-ids", (p.requiredCapabilityIds as string[]).join(","));
						if (price?.amount && price.currency) {
							args.push("--price", price.amount, "--currency", price.currency);
							if (price.frequency) args.push("--frequency", price.frequency);
						}
						record.publicListing = { ...record.publicListing, soldEventId: publishedEventId(await runPublic(args)) };
					} catch (error) {
						record.publicListing = { ...record.publicListing, error: `offer not marked sold: ${error instanceof Error ? error.message : String(error)}` };
					}
				}
				saveAgentDeal(paths, record);
				return render(summarize(record, state), json);
			}
			case "confirm": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "confirm"));
				const state = await stateOf(record);
				if (!state || dealRole(state, self.npub) !== "provider") throw new Error("only the provider confirms payment");
				if (!state.settlementRef) throw new Error("no settlement yet; run `crosshead deal sync`");
				const settlement = await session.client.readAgentDealSettlement(state.dealId);
				const view = (settlement.settlement as Record<string, unknown>) ?? settlement;
				const settlementId = String(view.settlement_id ?? view.settlementId ?? "");
				if (settlementId !== state.settlementRef) throw new Error(`the server settlement ${settlementId} does not match the signed settlement event ${state.settlementRef}`);
				if (view.payee_npub !== self.npub || Number(view.amount_credits) !== state.agreement?.priceCredits) {
					throw new Error("the server settlement does not match the agreed payee or price");
				}
				record.settlement = view;
				await publishReceipt(record, state, "settlement_confirmed", settlementId, `Paid ${state.agreement!.priceCredits} credits as agreed`);
				saveAgentDeal(paths, record);
				return render(summarize(record, state), json);
			}
			default:
				throw new Error(`Unknown deal command: ${subcommand}\n${dealHelpLines.join("\n")}`);
		}
	} finally {
		await session.persist().catch(() => undefined);
	}

	async function publishReceipt(
		record: LocalAgentDealRecord,
		state: AgentDealChainState,
		receiptType: "task_completed" | "settlement_confirmed",
		settlementId: string,
		summary: string
	): Promise<void> {
		const existing = record.receipts.find((entry) => entry.receiptType === receiptType);
		if (existing?.published) return;
		const receipt = await mintAgentDealReceipt({
			state,
			receiptType,
			signer: session.agentRef,
			nsec: session.nsec,
			settlementRef: settlementId,
			handoffRef: record.handoff?.localHandoffId ?? record.handoff?.capsuleId ?? null,
			outcomeRef: receiptType === "task_completed" ? record.handoff?.outcomeRef ?? null : null,
			summary,
		});
		const entry = { receiptId: receipt.receiptId, receiptType, subjectNpub: receipt.subject.subjectType === "agent" ? receipt.subject.agentRef.npub : "", published: false, error: null as string | null };
		try {
			await session.client.publishTrustReceipt(receipt);
			entry.published = true;
		} catch (error) {
			entry.error = error instanceof Error ? error.message : String(error);
		}
		record.receipts = [...record.receipts.filter((candidate) => candidate.receiptType !== receiptType), entry];
	}
};
