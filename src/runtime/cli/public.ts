import { OnlyBotsLocalRuntimeDaemon, parseArgs, truncateForPresentation } from "../local-runtime";

const formatPublicDiscoveryStateForDisplay = (result: Record<string, unknown>): string => {
	const summary =
		result.summary && typeof result.summary === "object" && !Array.isArray(result.summary)
			? (result.summary as Record<string, unknown>)
			: null;
	const items = Array.isArray(result.items) ? (result.items as Array<Record<string, unknown>>) : [];
	const lines = [
		`total: ${Number(summary?.total ?? 0)}`,
		`returned: ${Number(summary?.returned ?? items.length)}`,
		`latest_only: ${summary?.latest_only === false ? "no" : "yes"}`,
		`invalid_skipped: ${Number(summary?.invalid_skipped ?? 0)}`,
	];
	if (items.length > 0) {
		lines.push("items:");
		lines.push(
			...items.flatMap((item) => {
		const payload =
		  item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)
			? (item.payload as Record<string, unknown>)
			: null;
		const detail: string[] = [
		  `- ${String(item.primary_id ?? "unknown")} ${String(item.event_type ?? "unknown")} ${truncateForPresentation(String(payload?.summary ?? ""), 120)}`,
		  `  author: ${String(item.author_npub ?? "unknown")} published_at: ${String(item.published_at ?? "unknown")}`,
		];
		if (payload?.eventType === "capability_advertisement") {
		  detail.push(
			`  capabilities: ${Array.isArray(payload.capabilityIds) ? payload.capabilityIds.join(", ") : "none"}`
		  );
		}
		if (payload?.eventType === "availability_heartbeat") {
		  detail.push(
			`  status: ${String(payload.availabilityStatus ?? "unknown")} claimed_jobs=${String(payload.claimedJobs ?? "none")} max_concurrent=${String(payload.maxConcurrentJobs ?? "none")}`
		  );
		}
		if (payload?.eventType === "task_offer") {
		  detail.push(
			`  task: ${String(payload.taskRef ?? "none")} price=${payload.price ? JSON.stringify(payload.price) : "unspecified"} status=${String(payload.listingStatus ?? "") } targets=${Array.isArray(payload.targetAgentNpubs) ? payload.targetAgentNpubs.join(", ") : "none"}`
		  );
		}
		if (payload?.eventType === "task_claim") {
		  detail.push(
			`  offer: ${String(payload.offerId ?? "none")} state=${String(payload.claimState ?? "unknown")} context=${String(payload.collaborationContextRef ?? "none")}`
		  );
		}
		return detail;
			})
		);
	}
	return lines.join("\n");
};

const formatPublicDiscoveryPublishForDisplay = (result: Record<string, unknown>): string => {
	const payload =
		result.payload && typeof result.payload === "object" && !Array.isArray(result.payload)
			? (result.payload as Record<string, unknown>)
			: null;
	const relayEvent =
		result.relay_event && typeof result.relay_event === "object" && !Array.isArray(result.relay_event)
			? (result.relay_event as Record<string, unknown>)
			: null;
	const publishResult =
		result.publish_result && typeof result.publish_result === "object" && !Array.isArray(result.publish_result)
			? (result.publish_result as Record<string, unknown>)
			: null;
	return [
		`event_type: ${String(payload?.eventType ?? "unknown")}`,
		`primary_id: ${String(payload?.advertisementId ?? payload?.presenceId ?? payload?.offerId ?? payload?.claimId ?? "unknown")}`,
		`relay_event_id: ${String(relayEvent?.id ?? "unknown")}`,
		`relay_kind: ${String(relayEvent?.kind ?? "unknown")}`,
		`inserted: ${publishResult?.inserted === true ? "yes" : "no"}`,
		`published_relays: ${
			publishResult?.external_publish &&
			typeof publishResult.external_publish === "object" &&
			Array.isArray((publishResult.external_publish as Record<string, unknown>).published_relays)
		? ((publishResult.external_publish as Record<string, unknown>).published_relays as unknown[]).join(", ")
		: "none"
		}`,
	].join("\n");
};

export const publicFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];
	const profileName = typeof flags.profile === "string" ? flags.profile : undefined;
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
	const csv = (value: string | boolean | undefined): string | undefined =>
		typeof value === "string" && value.trim().length > 0 ? value : undefined;

	if (subcommand === "schema") {
		const result = await daemon.readPublicDiscoverySchema(profileName);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : JSON.stringify(result, null, 2);
	}

	if (subcommand === "state") {
		const result = await daemon.inspectPublicDiscovery(
			{
		event_type:
		  typeof flags["event-type"] === "string"
			? flags["event-type"]
			: typeof flags.eventType === "string"
			  ? flags.eventType
			  : undefined,
		authors: csv(flags.authors),
		primary_id:
		  typeof flags["primary-id"] === "string"
			? flags["primary-id"]
			: typeof flags.primaryId === "string"
			  ? flags.primaryId
			  : undefined,
		event_id:
		  typeof flags["event-id"] === "string"
			? flags["event-id"]
			: typeof flags.eventId === "string"
			  ? flags.eventId
			  : undefined,
		capability_id:
		  typeof flags["capability-id"] === "string"
			? flags["capability-id"]
			: typeof flags.capabilityId === "string"
			  ? flags.capabilityId
			  : undefined,
		offer_id:
		  typeof flags["offer-id"] === "string"
			? flags["offer-id"]
			: typeof flags.offerId === "string"
			  ? flags.offerId
			  : undefined,
		task_ref:
		  typeof flags["task-ref"] === "string"
			? flags["task-ref"]
			: typeof flags.taskRef === "string"
			  ? flags.taskRef
			  : undefined,
		agent_id:
		  typeof flags["agent-id"] === "string"
			? flags["agent-id"]
			: typeof flags.agentId === "string"
			  ? flags.agentId
			  : undefined,
		status: csv(flags.status),
		since: csv(flags.since),
		until: csv(flags.until),
		latest_only:
		  typeof flags["latest-only"] === "string"
			? flags["latest-only"]
			: typeof flags.latestOnly === "string"
			  ? flags.latestOnly
			  : undefined,
		include_raw:
		  typeof flags["include-raw"] === "string"
			? flags["include-raw"]
			: typeof flags.includeRaw === "string"
			  ? flags.includeRaw
			  : undefined,
		limit: csv(flags.limit),
			},
			profileName
		);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatPublicDiscoveryStateForDisplay(result);
	}

	const eventType =
		subcommand === "advertise"
			? "capability_advertisement"
			: subcommand === "availability"
		? "availability_heartbeat"
		: subcommand === "offer"
		  ? "task_offer"
		  : subcommand === "claim"
			? "task_claim"
			: null;
	if (!eventType) {
		throw new Error("public requires one of: schema, state, advertise, availability, offer, claim");
	}

  for (const name of ["price", "currency", "frequency"]) {
    if (flags[name] !== undefined && (typeof flags[name] !== "string" || !String(flags[name]).trim())) throw new Error(`--${name} requires a value`);
  }
  if (flags["budget-sats"] !== undefined || flags.budgetSats !== undefined) throw new Error("use --price and --currency for NIP-99 listings");
  const result = await daemon.publishPublicDiscoveryEvent(
		{
      profileName,
      title: csv(flags.title), description: csv(flags.description), location: csv(flags.location),
      price: csv(flags.price), currency: csv(flags.currency), frequency: csv(flags.frequency),
      listing_status: csv(flags["listing-status"]), published_at: csv(flags["published-at"]), updated_at: csv(flags["updated-at"]),
			eventType,
			summary: typeof flags.summary === "string" ? flags.summary : undefined,
			note: typeof flags.note === "string" ? flags.note : undefined,
			notes: typeof flags.notes === "string" ? flags.notes : undefined,
			advertisement_id:
		typeof flags["advertisement-id"] === "string"
		  ? flags["advertisement-id"]
		  : typeof flags.advertisementId === "string"
			? flags.advertisementId
			: undefined,
			capability_ids:
		typeof flags["capability-ids"] === "string"
		  ? flags["capability-ids"]
		  : typeof flags.capabilityIds === "string"
			? flags.capabilityIds
			: undefined,
			capability_claim_refs:
		typeof flags["capability-claim-refs"] === "string"
		  ? flags["capability-claim-refs"]
		  : typeof flags.capabilityClaimRefs === "string"
			? flags.capabilityClaimRefs
			: undefined,
			runtime_hosts:
		typeof flags["runtime-hosts"] === "string"
		  ? flags["runtime-hosts"]
		  : typeof flags.runtimeHosts === "string"
			? flags.runtimeHosts
			: undefined,
			trust_zones:
		typeof flags["trust-zones"] === "string"
		  ? flags["trust-zones"]
		  : typeof flags.trustZones === "string"
			? flags.trustZones
			: undefined,
			workspace_refs:
		typeof flags["workspace-refs"] === "string"
		  ? flags["workspace-refs"]
		  : typeof flags.workspaceRefs === "string"
			? flags.workspaceRefs
			: undefined,
			presence_id:
		typeof flags["presence-id"] === "string"
		  ? flags["presence-id"]
		  : typeof flags.presenceId === "string"
			? flags.presenceId
			: undefined,
			status: typeof flags.status === "string" ? flags.status : undefined,
			claimed_jobs:
		typeof flags["claimed-jobs"] === "string"
		  ? flags["claimed-jobs"]
		  : typeof flags.claimedJobs === "string"
			? flags.claimedJobs
			: undefined,
			max_concurrent_jobs:
		typeof flags["max-concurrent-jobs"] === "string"
		  ? flags["max-concurrent-jobs"]
		  : typeof flags.maxConcurrentJobs === "string"
			? flags.maxConcurrentJobs
			: undefined,
			next_heartbeat_due_at:
		typeof flags["next-heartbeat-due-at"] === "string"
		  ? flags["next-heartbeat-due-at"]
		  : typeof flags.nextHeartbeatDueAt === "string"
			? flags.nextHeartbeatDueAt
			: undefined,
			availability_ref:
		typeof flags["availability-ref"] === "string"
		  ? flags["availability-ref"]
		  : typeof flags.availabilityRef === "string"
			? flags.availabilityRef
			: undefined,
			current_task_refs:
		typeof flags["current-task-refs"] === "string"
		  ? flags["current-task-refs"]
		  : typeof flags.currentTaskRefs === "string"
			? flags.currentTaskRefs
			: undefined,
			offer_id:
		typeof flags["offer-id"] === "string"
		  ? flags["offer-id"]
		  : typeof flags.offerId === "string"
			? flags.offerId
			: undefined,
			task_ref:
		typeof flags["task-ref"] === "string"
		  ? flags["task-ref"]
		  : typeof flags.taskRef === "string"
			? flags.taskRef
			: undefined,
			required_capability_ids:
		typeof flags["required-capability-ids"] === "string"
		  ? flags["required-capability-ids"]
		  : typeof flags.requiredCapabilityIds === "string"
			? flags.requiredCapabilityIds
			: undefined,
			required_capability_claim_refs:
		typeof flags["required-capability-claim-refs"] === "string"
		  ? flags["required-capability-claim-refs"]
		  : typeof flags.requiredCapabilityClaimRefs === "string"
			? flags.requiredCapabilityClaimRefs
			: undefined,
			target_agent_npubs:
		typeof flags["target-agent-npubs"] === "string"
		  ? flags["target-agent-npubs"]
		  : typeof flags.targetAgentNpubs === "string"
			? flags.targetAgentNpubs
			: undefined,
			collaboration_context_ref:
		typeof flags["collaboration-context-ref"] === "string"
		  ? flags["collaboration-context-ref"]
		  : typeof flags.collaborationContextRef === "string"
			? flags.collaborationContextRef
			: undefined,
			expires_at:
		typeof flags["expires-at"] === "string"
		  ? flags["expires-at"]
		  : typeof flags.expiresAt === "string"
			? flags.expiresAt
			: undefined,
			claim_id:
		typeof flags["claim-id"] === "string"
		  ? flags["claim-id"]
		  : typeof flags.claimId === "string"
			? flags.claimId
			: undefined,
			offer_event_id:
		typeof flags["offer-event-id"] === "string"
		  ? flags["offer-event-id"]
		  : typeof flags.offerEventId === "string"
			? flags.offerEventId
			: undefined,
			claim_state:
		typeof flags["claim-state"] === "string"
		  ? flags["claim-state"]
		  : typeof flags.claimState === "string"
			? flags.claimState
			: undefined,
		},
		profileName
	);
	return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatPublicDiscoveryPublishForDisplay(result);
};
