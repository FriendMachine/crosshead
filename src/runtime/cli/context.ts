import { OnlyBotsLocalRuntimeDaemon, formatContextPackInspection, formatContinuityInspection, formatDreamInspection, formatDreamReviewResult, formatDreamRunResult, formatJudgmentInspection, formatObligationInspection, formatSelfModelReviewResult, parseArgs, parseJsonFlag } from "../local-runtime";

export const contextFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
	const profileName = typeof flags.profile === "string" ? flags.profile : undefined;

	if (subcommand === "pack") {
		const goal =
			typeof flags.goal === "string"
				? flags.goal
				: positionals.slice(1).join(" ").trim();
		if (goal.length === 0) {
			throw new Error("context pack requires --goal <text> or a positional goal");
		}
		const result = await daemon.prepareContextPack(
			{
				goal,
				sessionId:
					typeof flags["session-id"] === "string"
						? flags["session-id"]
						: typeof flags.sessionId === "string"
							? flags.sessionId
							: undefined,
				workspaceId:
					typeof flags["workspace-id"] === "string"
						? flags["workspace-id"]
						: typeof flags.workspaceId === "string"
							? flags.workspaceId
							: undefined,
				transcript: parseJsonFlag(flags["transcript-json"]),
				budget: {
					maxFragments: typeof flags["max-fragments"] === "string" ? Number(flags["max-fragments"]) : undefined,
					maxTokens: typeof flags["max-tokens"] === "string" ? Number(flags["max-tokens"]) : undefined,
					pricingHint:
						typeof flags["pricing-usd-per-1k"] === "string"
							? {
									usdPer1kTokens: Number(flags["pricing-usd-per-1k"]),
									model: typeof flags.model === "string" ? flags.model : undefined,
								}
							: undefined,
				},
			},
			profileName
		);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatContextPackInspection(result);
	}

	if (subcommand === "inspect") {
		let packId =
			typeof flags["pack-id"] === "string"
				? flags["pack-id"]
				: typeof flags.packId === "string"
					? flags.packId
					: "";
		if (flags.latest && !packId) {
			const selectedProfile = profileName ?? (await daemon.status()).defaultProfile;
			const activity = await daemon.readActivity(500);
			const latest = [...activity.actions].reverse().find(action => action.profileName === selectedProfile &&
				action.type === "context_pack" && action.status === "completed" && typeof action.details.packId === "string");
			packId = typeof latest?.details.packId === "string" ? latest.details.packId : "";
			if (!packId) throw new Error("No recent hosted context pack is available for this profile.");
		}
		if (packId.trim().length === 0) {
			throw new Error("context inspect requires --pack-id <id> or --latest");
		}
		const result = await daemon.inspectContextPack(packId, profileName);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatContextPackInspection(result);
	}

	if (subcommand === "judgment") {
		const result = await daemon.inspectContinuityJudgment(profileName);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatJudgmentInspection(result);
	}

	if (subcommand === "continuity") {
		const result = await daemon.inspectContinuity(profileName);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatContinuityInspection(result);
	}

	if (subcommand === "dreams") {
		const nested = positionals[1];
		if (nested === "inspect") {
			const result = await daemon.inspectDreams(
				{
					proposalId:
						typeof flags["proposal-id"] === "string"
							? flags["proposal-id"]
							: typeof flags.proposalId === "string"
								? flags.proposalId
								: undefined,
					runId:
						typeof flags["run-id"] === "string"
							? flags["run-id"]
							: typeof flags.runId === "string"
								? flags.runId
								: undefined,
					status: typeof flags.status === "string" ? flags.status : undefined,
				},
				profileName
			);
			return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatDreamInspection(result);
		}

		if (nested === "run") {
			const trigger = typeof flags.trigger === "string" ? flags.trigger : "operator";
			if (trigger !== "operator" && trigger !== "scheduled") {
				throw new Error("context dreams run requires --trigger operator|scheduled");
			}
			const result = await daemon.runDreamJob(
				{
					trigger,
					maxOutcomes:
						typeof flags["max-outcomes"] === "string"
							? Number(flags["max-outcomes"])
							: typeof flags.maxOutcomes === "string"
								? Number(flags.maxOutcomes)
								: undefined,
					note: typeof flags.note === "string" ? flags.note : undefined,
				},
				profileName
			);
			return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatDreamRunResult(result);
		}

		if (nested === "review") {
			const proposalId =
				typeof flags["proposal-id"] === "string"
					? flags["proposal-id"]
					: typeof flags.proposalId === "string"
						? flags.proposalId
						: "";
			const decision = typeof flags.decision === "string" ? flags.decision : "";
			const targetProposalId =
				typeof flags["target-proposal-id"] === "string"
					? flags["target-proposal-id"]
					: typeof flags.targetProposalId === "string"
						? flags.targetProposalId
						: undefined;
			if (proposalId.trim().length === 0) {
				throw new Error("context dreams review requires --proposal-id <id>");
			}
			if (!["approve", "reject", "supersede", "merge"].includes(decision)) {
				throw new Error("context dreams review requires --decision <approve|reject|supersede|merge>");
			}
			if ((decision === "supersede" || decision === "merge") && (!targetProposalId || targetProposalId.trim().length === 0)) {
				throw new Error("context dreams review requires --target-proposal-id <id> for supersede or merge");
			}
			const result = await daemon.reviewDreamProposal(
				{
					proposalId,
					decision,
					targetProposalId,
					note: typeof flags.note === "string" ? flags.note : undefined,
				},
				profileName
			);
			return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatDreamReviewResult(result);
		}

		throw new Error("context dreams requires: inspect, run, review");
	}

	if (subcommand === "obligations") {
		const nested = positionals[1];
		if (nested === "inspect" || nested === "list" || nested === undefined) {
			const statuses =
				typeof flags.status === "string"
					? flags.status
							.split(",")
							.map((value) => value.trim())
							.filter((value) => value.length > 0)
					: undefined;
			const limit =
				typeof flags.limit === "string" && Number.isFinite(Number(flags.limit)) ? Number(flags.limit) : undefined;
			const result = await daemon.inspectObligations({ statuses, limit }, profileName);
			return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatObligationInspection(result);
		}
		throw new Error("context obligations requires: inspect");
	}

	if (subcommand === "self-model") {
		const nested = positionals[1];
		if (nested !== "review") {
			throw new Error("context self-model requires: review");
		}
		const entryId =
			typeof flags["entry-id"] === "string"
				? flags["entry-id"]
				: typeof flags.entryId === "string"
					? flags.entryId
					: "";
		const decision = typeof flags.decision === "string" ? flags.decision : "";
		if (entryId.trim().length === 0) {
			throw new Error("context self-model review requires --entry-id <id>");
		}
		if (!["approve", "reject", "supersede"].includes(decision)) {
			throw new Error("context self-model review requires --decision <approve|reject|supersede>");
		}
		const preferredRuntimeHostsRaw =
			typeof flags["preferred-runtime-hosts"] === "string"
				? flags["preferred-runtime-hosts"]
				: typeof flags.preferredRuntimeHosts === "string"
					? flags.preferredRuntimeHosts
					: undefined;
		const preferredRuntimeHosts =
			typeof preferredRuntimeHostsRaw === "string"
				? preferredRuntimeHostsRaw
						.split(",")
						.map((entry) => entry.trim())
						.filter((entry) => entry.length > 0)
				: undefined;
		const portabilityNote =
			typeof flags["portability-note"] === "string"
				? flags["portability-note"]
				: typeof flags.portabilityNote === "string"
					? flags.portabilityNote
					: undefined;
		const result = await daemon.reviewSelfModel(
			{
				entryId,
				decision,
				summary: typeof flags.summary === "string" ? flags.summary : undefined,
				section: typeof flags.section === "string" ? flags.section : undefined,
				note: typeof flags.note === "string" ? flags.note : undefined,
				preferredRuntimeHosts,
				portabilityNotes: portabilityNote ? [portabilityNote] : undefined,
			},
			profileName
		);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatSelfModelReviewResult(result);
	}

	throw new Error("context requires one of: pack, inspect, judgment, dreams, self-model");
};
