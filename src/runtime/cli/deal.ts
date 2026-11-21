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
	"crosshead deal propose --to <npub> --role requester|provider --summary <text> --price <credits> [--acceptance <a;b>] [--capabilities <csv>] [--turnaround-hours <n>] [--offer-event-id <id>] [--deal-id <ctx_id>] [--json]",
	"crosshead deal counter --deal <id> --price <credits> [--summary <text>] [--acceptance <a;b>] [--json]",
	"crosshead deal accept --deal <id> [--summary <text>] [--json]",
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
				return await step(record, {
					record,
					agentRef: self,
					nsec: session.nsec,
					eventType: "offer",
					summary: str(flags, "message") ?? summary,
					terms,
					genesis: {
						parties: role === "requester" ? { requesterNpub: self.npub, providerNpub: to } : { requesterNpub: to, providerNpub: self.npub },
						offerRef: str(flags, "offer-event-id", "offer-ref") ?? null,
						workSummary: summary,
					},
				});
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
				return await step(record, { record, agentRef: self, nsec: session.nsec, eventType: "counteroffer", summary: str(flags, "summary") ?? `Counteroffer: ${terms.priceSats} credits`, terms });
			}
			case "accept": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "accept"));
				const state = await stateOf(record);
				if (!state?.currentTerms) throw new Error("there is no offer to accept");
				return await step(record, { record, agentRef: self, nsec: session.nsec, eventType: "conditional_acceptance", summary: str(flags, "summary") ?? `Accepted: ${state.currentTerms.priceSats} credits`, terms: state.currentTerms, conditionRefs: [] });
			}
			case "reject": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "reject"));
				const reason = required(flags, "reason", "reject");
				return await step(record, { record, agentRef: self, nsec: session.nsec, eventType: "rejection", summary: str(flags, "summary") ?? `Rejected: ${reason}`, reason });
			}
			case "deliver": {
				const record = requireAgentDeal(paths, session.profileName, required(flags, "deal", "deliver"));
				const state = await stateOf(record);
				if (!state || dealRole(state, self.npub) !== "provider") throw new Error("only the provider delivers");
				return await step(record, {
					record,
					agentRef: self,
					nsec: session.nsec,
					eventType: "note",
					summary: required(flags, "summary", "deliver"),
					notes: deliveryNotes(listFlag(str(flags, "artifact-refs"), /,/)),
				});
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
				record.handoff = { attachmentId, capsuleId, sentAt: new Date().toISOString(), receivedAt: null, importedAt: null, importResult: null };
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
				// 3. Receipt about the provider's work.
				await publishReceipt(record, state, "task_completed", settlementId, str(flags, "summary") ?? `Completed deal: ${state.workSummary}`.slice(0, 300));
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
			handoffRef: record.handoff?.capsuleId ?? null,
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
