import { OnlyBotsLocalRuntimeDaemon, parseArgs, truncateForPresentation } from "../local-runtime";

const formatInboxStateForDisplay = (result: Record<string, unknown>): string => {
	const summary =
		result.summary && typeof result.summary === "object" && !Array.isArray(result.summary)
			? (result.summary as Record<string, unknown>)
			: null;
	const items = Array.isArray(result.items) ? (result.items as Array<Record<string, unknown>>) : [];
	const compactId = (value: unknown): string => {
		if (typeof value !== "string" || value.trim().length === 0) {
			return "none";
		}
		return value.length <= 24 ? value : `${value.slice(0, 12)}...${value.slice(-8)}`;
	};
	const compactList = (value: unknown, maxLength: number = 72): string => {
		if (!Array.isArray(value)) {
			return "none";
		}
		const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
		if (entries.length === 0) {
			return "none";
		}
		return truncateForPresentation(entries.join(", "), maxLength);
	};
	const lines = [
		`total: ${Number(summary?.total ?? 0)}`,
		`active: ${Number(summary?.active ?? 0)}`,
		`unread: ${Number(summary?.unread ?? 0)}`,
		`acknowledged: ${Number(summary?.acknowledged ?? 0)}`,
		`terminal: ${Number(summary?.terminal ?? 0)}`,
		`dead_letter: ${Number(summary?.deadLetter ?? 0)}`,
		`highest_active_priority: ${typeof summary?.highestActivePriority === "string" ? summary.highestActivePriority : "none"}`,
		`returned_items: ${items.length}`,
	];
	if (items.length > 0) {
		lines.push("items:");
		lines.push(
			...items.flatMap((item) => {
		const inboxEvent =
		  item.inboxEvent && typeof item.inboxEvent === "object" && !Array.isArray(item.inboxEvent)
			? (item.inboxEvent as Record<string, unknown>)
			: null;
		const collaborationContext =
		  item.collaborationContext && typeof item.collaborationContext === "object" && !Array.isArray(item.collaborationContext)
			? (item.collaborationContext as Record<string, unknown>)
			: null;
		const taskOwnership =
		  collaborationContext?.taskOwnership &&
		  typeof collaborationContext.taskOwnership === "object" &&
		  !Array.isArray(collaborationContext.taskOwnership)
			? (collaborationContext.taskOwnership as Record<string, unknown>)
			: null;
		const budget =
		  collaborationContext?.budget && typeof collaborationContext.budget === "object" && !Array.isArray(collaborationContext.budget)
			? (collaborationContext.budget as Record<string, unknown>)
			: null;
		const policy =
		  collaborationContext?.policy && typeof collaborationContext.policy === "object" && !Array.isArray(collaborationContext.policy)
			? (collaborationContext.policy as Record<string, unknown>)
			: null;
		const summaryText =
		  typeof inboxEvent?.summary === "string"
			? inboxEvent.summary
			: typeof item.plaintext === "string"
			  ? item.plaintext
			  : "";
		const output = [
		  `- ${String(item.id ?? "unknown")} ${String(item.status ?? "unknown")}/${String(item.priority ?? "none")}/${String(inboxEvent?.eventType ?? "item")} ${truncateForPresentation(summaryText, 120)}`,
		];
		if (collaborationContext) {
		  output.push(
			`  context: ${String(collaborationContext.contextId ?? "none")} task: ${String(taskOwnership?.taskRef ?? item.taskRef ?? "none")}`
		  );
		  output.push(
			`  ownership: ${String(taskOwnership?.status ?? "unknown")} owner=${compactId(taskOwnership?.ownerNpub)} claimed=${compactId(taskOwnership?.claimedByNpub)}`
		  );
		  output.push(
			`  budget: ${typeof budget?.maxBudgetSats === "number" ? budget.maxBudgetSats : "none"} sats shadow=${budget?.shadowMode === true ? "yes" : "no"} trust=${typeof policy?.primaryTrustZone === "string" ? policy.primaryTrustZone : "none"}`
		  );
		  output.push(
			`  review: ${compactList(policy?.requireReviewFor)} tools: ${compactList(policy?.toolRestrictions)}`
		  );
		}
		return output;
			})
		);
	}
	return lines.join("\n");
};

const formatInboxMutationForDisplay = (result: Record<string, unknown>): string => {
	const item = result.item && typeof result.item === "object" && !Array.isArray(result.item) ? (result.item as Record<string, unknown>) : null;
	const returnPath =
		result.returnPath && typeof result.returnPath === "object" && !Array.isArray(result.returnPath)
			? (result.returnPath as Record<string, unknown>)
			: null;
	return [
		`inbox_id: ${String(item?.id ?? "unknown")}`,
		`status: ${String(item?.status ?? "unknown")}`,
		`return_path_attempted: ${returnPath?.attempted === true ? "yes" : "no"}`,
		`return_path_delivered: ${returnPath?.delivered === true ? "yes" : "no"}`,
		`return_path_event_id: ${typeof returnPath?.eventId === "string" ? returnPath.eventId : "none"}`,
		typeof returnPath?.error === "string" ? `return_path_error: ${returnPath.error}` : null,
	]
		.filter((value): value is string => value !== null)
		.join("\n");
};

export const messagesFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];
	const profileName = typeof flags.profile === "string" ? flags.profile : undefined;
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
	const csv = (value: string | boolean | undefined): string[] | undefined =>
		typeof value === "string"
			? value
		  .split(",")
		  .map((entry) => entry.trim())
		  .filter((entry) => entry.length > 0)
			: undefined;
	const bool = (value: string | boolean | undefined): boolean | undefined => {
		if (typeof value === "boolean") {
			return value;
		}
		if (value === "true") {
			return true;
		}
		if (value === "false") {
			return false;
		}
		return undefined;
	};
	const inboxId =
		typeof flags["inbox-id"] === "string"
			? flags["inbox-id"]
			: typeof flags.inboxId === "string"
		? flags.inboxId
		: undefined;
	const messageEventId =
		typeof flags["message-event-id"] === "string"
			? flags["message-event-id"]
			: typeof flags.messageEventId === "string"
		? flags.messageEventId
		: undefined;

	if (subcommand === "state") {
		const result = await daemon.inspectInboxState(
			{
		statuses: typeof flags.statuses === "string" ? flags.statuses : undefined,
		priorities: typeof flags.priorities === "string" ? flags.priorities : undefined,
		context_id:
		  typeof flags["context-id"] === "string"
			? flags["context-id"]
			: typeof flags.contextId === "string"
			  ? flags.contextId
			  : undefined,
		message_type:
		  typeof flags["message-type"] === "string"
			? flags["message-type"]
			: typeof flags.messageType === "string"
			  ? flags.messageType
			  : undefined,
		unread_only: bool(flags["unread-only"]),
		include_terminal: bool(flags["include-terminal"]),
		limit: typeof flags.limit === "string" ? Number(flags.limit) : undefined,
			},
			profileName
		);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatInboxStateForDisplay(result);
	}

	if (subcommand === "replay") {
		if (!inboxId && !messageEventId) {
			throw new Error("messages replay requires --inbox-id <id> or --message-event-id <id>");
		}
		const result = await daemon.replayInboxItem(
			{
		inboxId,
		messageEventId,
		note: typeof flags.note === "string" ? flags.note : undefined,
			},
			profileName
		);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : JSON.stringify(result, null, 2);
	}

	if (subcommand === "ack") {
		if (!inboxId && !messageEventId) {
			throw new Error("messages ack requires --inbox-id <id> or --message-event-id <id>");
		}
		const result = await daemon.acknowledgeInboxItem(
			{
		inboxId,
		messageEventId,
		actorRuntimeHost:
		  typeof flags["actor-runtime-host"] === "string"
			? flags["actor-runtime-host"]
			: typeof flags.actorRuntimeHost === "string"
			  ? flags.actorRuntimeHost
			  : undefined,
		note: typeof flags.note === "string" ? flags.note : undefined,
			},
			profileName
		);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatInboxMutationForDisplay(result);
	}

	if (subcommand === "resolve") {
		if (!inboxId && !messageEventId) {
			throw new Error("messages resolve requires --inbox-id <id> or --message-event-id <id>");
		}
		const resolution = typeof flags.resolution === "string" ? flags.resolution : "";
		if (!["completed", "failed", "rejected"].includes(resolution)) {
			throw new Error("messages resolve requires --resolution completed|failed|rejected");
		}
		const result = await daemon.resolveInboxItem(
			{
		inboxId,
		messageEventId,
		actorRuntimeHost:
		  typeof flags["actor-runtime-host"] === "string"
			? flags["actor-runtime-host"]
			: typeof flags.actorRuntimeHost === "string"
			  ? flags.actorRuntimeHost
			  : undefined,
		resolution,
		note: typeof flags.note === "string" ? flags.note : undefined,
		priority: typeof flags.priority === "string" ? flags.priority : undefined,
		artifactRefs: csv(flags["artifact-refs"]),
		handoffRefs: csv(flags["handoff-refs"]),
		outcomeRefs: csv(flags["outcome-refs"]),
		deliveredArtifactRefs: csv(flags["delivered-artifact-refs"]),
		resultSummary:
		  typeof flags["result-summary"] === "string"
			? flags["result-summary"]
			: typeof flags.resultSummary === "string"
			  ? flags.resultSummary
			  : undefined,
		failureCode:
		  typeof flags["failure-code"] === "string"
			? flags["failure-code"]
			: typeof flags.failureCode === "string"
			  ? flags.failureCode
			  : undefined,
		retryable: bool(flags.retryable),
		reason: typeof flags.reason === "string" ? flags.reason : undefined,
			},
			profileName
		);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatInboxMutationForDisplay(result);
	}

	throw new Error("messages subcommand must be one of: state, replay, ack, resolve");
};
