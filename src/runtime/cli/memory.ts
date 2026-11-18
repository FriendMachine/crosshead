import { LocalRuntimeClient } from "../local-client";
import { HOT_SCOPE_ALL } from "../../protocol/memory";
import { searchHotCheckpoints } from "../hot-continuity";
import { isLocalOnlyRuntimeProfile, readLocalHotMemory } from "../local-hot-memory";
import { loadProfile, resolveRuntimePaths } from "../runtime-persistence";
import { workspaceDirectoryPath } from "../workspace-identity";
import { isRuntimeProfileName } from "../runtime-env";
import { workspaceHotCheckpointBodies } from "../workspace-memory";
import { OnlyBotsLocalRuntimeDaemon, buildMemorySearchPresentation, formatHotMemoryForDisplay, formatMemorySearchPresentation, formatWarmMemoryEntryForDisplay, formatWarmMemoryEvaluation, parseArgs, summarizeRecentWarmMemoryOutcomes, truncateForPresentation } from "../local-runtime";

export const memoryFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];
	const profileName = typeof flags.profile === "string" ? flags.profile : undefined;
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);

	if (subcommand === "sync" || (subcommand === "hot" && positionals[1] === "reset")) {
		if (subcommand === "hot" && typeof flags.scope !== "string") throw new Error("memory hot reset requires --scope <scope from memory sync>");
		const result = await new LocalRuntimeClient({home:typeof flags.home === "string" ? flags.home : undefined}).hotSyncControl({profileName,action:subcommand === "hot" ? "reset" : "status",scope:flags.scope});
		return JSON.stringify(result, null, 2);
	}
	if (subcommand === "hot" && flags.inspect) {
		return JSON.stringify(await new LocalRuntimeClient({home:typeof flags.home === "string" ? flags.home : undefined}).hotSyncControl({profileName,action:"inspect",scope:flags.scope}), null, 2);
	}
	if (subcommand === "hot") {
		// Default the operator view to the cross-body union; allow --scope <name> to focus one body.
		const hotScope = typeof flags.scope === "string" && flags.scope.length > 0 ? flags.scope : HOT_SCOPE_ALL;
		const hot = await daemon.readHotMemory(profileName, hotScope);
		if (flags.debug) {
			return JSON.stringify(hot, null, 2);
		}
		if (flags.json) {
			if (Array.isArray(hot.scopes)) {
				return JSON.stringify({ scope: hot.scope ?? HOT_SCOPE_ALL, scopes: hot.scopes }, null, 2);
			}
			return JSON.stringify(
				{
					scope: typeof hot.scope === "string" ? hot.scope : null,
					content: typeof hot.content === "string" ? hot.content : "",
					etag: typeof hot.etag === "string" ? hot.etag : null,
				},
				null,
				2
			);
		}
		return formatHotMemoryForDisplay(hot);
	}

	if (subcommand === "warm") {
		const warm = await daemon.listWarmMemory(profileName, {
			type: typeof flags.type === "string" ? flags.type : undefined,
			status: typeof flags.status === "string" ? flags.status : undefined,
			includeSystemMemory: flags["include-system"] === true || flags.includeSystem === true,
		});
		if (flags.debug) {
			return JSON.stringify(warm, null, 2);
		}
		const entries = Array.isArray(warm.entries) ? (warm.entries as Array<Record<string, unknown>>) : [];
		if (flags.json) {
			return JSON.stringify(
				{
					entries: entries.map((entry) => ({
						id: typeof entry.id === "string" ? entry.id : null,
						type: typeof entry.type === "string" ? entry.type : null,
						status: typeof entry.status === "string" ? entry.status : null,
						confidence:
							typeof entry.validityConfidence === "number"
								? entry.validityConfidence
								: typeof entry.validity_confidence === "number"
									? entry.validity_confidence
									: null,
						tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [],
						inspection:
							entry.inspection && typeof entry.inspection === "object" && !Array.isArray(entry.inspection)
								? entry.inspection
								: null,
						content:
							typeof entry.content === "string" ? truncateForPresentation(entry.content, 220) : "",
						createdAt:
							typeof entry.updatedAt === "string"
								? entry.updatedAt
								: typeof entry.createdAt === "string"
									? entry.createdAt
									: null,
					})),
				},
				null,
				2
			);
		}
		return entries.length === 0
			? "No warm-memory entries found"
			: entries.map((entry) => formatWarmMemoryEntryForDisplay(entry)).join("\n\n");
	}

	if (subcommand === "evaluate") {
		const report = await daemon.evaluateWarmMemory(
			{
				apply: flags.apply === true,
				limit: typeof flags.limit === "string" ? Number(flags.limit) : undefined,
				include_system: flags["include-system"] === true || flags.includeSystem === true,
			},
			profileName
		);
		const activity = await daemon.readActivity(typeof flags.lines === "string" ? Number(flags.lines) : 200);
		const recentOutcomes = summarizeRecentWarmMemoryOutcomes(activity);
		if (flags.debug) {
			return JSON.stringify(
				{
					report,
					recentRuntimeOutcomes: recentOutcomes,
					activity,
				},
				null,
				2
			);
		}
		if (flags.json) {
			return JSON.stringify(
				{
					...report,
					recentRuntimeOutcomes: recentOutcomes,
				},
				null,
				2
			);
		}
		return formatWarmMemoryEvaluation(report, recentOutcomes);
	}

	if (subcommand === "search" || subcommand === "search-workspace") {
		const query = positionals.slice(1).join(" ").trim();
		if (query.length === 0) {
			throw new Error(`memory ${subcommand} requires a query`);
		}
		const topK = typeof flags["top-k"] === "string" ? Number(flags["top-k"]) : 10;
		let result: Record<string, unknown>;
		if (subcommand === "search-workspace") {
			const workspaceRoot = flags["workspace-root"];
			if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) {
				throw new Error("memory search-workspace requires --workspace-root <directory>");
			}
			if (!isRuntimeProfileName(profileName)) {
				throw new Error("memory search-workspace requires an explicit --profile <name>");
			}
			if (flags.home !== undefined && (typeof flags.home !== "string" || !flags.home.trim())) {
				throw new Error("memory search-workspace --home requires a directory");
			}
			const workspaceId = `repo:${workspaceDirectoryPath(workspaceRoot)}`;
			const paths = resolveRuntimePaths(typeof flags.home === "string" ? flags.home : undefined);
			const profile = loadProfile(paths, profileName);
			if (!profile) throw new Error(`Unknown runtime profile: ${profileName}`);
			// For hosted profiles the attached daemon owns the sync policy. A separate
			// route keeps older daemons from treating this as an ordinary hosted read.
			const hot = isLocalOnlyRuntimeProfile(profile)
				? readLocalHotMemory(paths.state, HOT_SCOPE_ALL, profile)
				: await new LocalRuntimeClient({ home: paths.home }).readProfileLocalHotMemory(profileName);
			const continuityCheckpoints = workspaceHotCheckpointBodies(hot, workspaceId);
			const results = searchHotCheckpoints({ continuityCheckpoints }, query, topK || 10, workspaceId);
			result = { scope: "local_hot_memory", workspaceId, query, count: results.length, results };
		} else {
			result = await daemon.searchMemory(
				{
					query,
					top_k: topK,
					include_system: flags["include-system"] === true || flags.includeSystem === true,
				},
				profileName
			);
		}
		if (result.scope === "local_hot_memory") {
			if (flags.json || flags.debug) return JSON.stringify(result, null, 2);
			const matches = Array.isArray(result.results) ? result.results as Array<Record<string, unknown>> : [];
			return [
				`Local hot memory · ${matches.length} matches`,
				...matches.map((entry) => `${entry.source ?? entry.kind}: ${entry.text}`),
			].join("\n");
		}
		const presentation = buildMemorySearchPresentation(
			query,
			topK,
			result
		);
		if (flags.debug) {
			return JSON.stringify(
				{
					presentation,
					raw: result,
				},
				null,
				2
			);
		}
		if (flags.json) {
			return JSON.stringify(presentation, null, 2);
		}
		return formatMemorySearchPresentation(presentation);
	}

	if (subcommand === "export") {
		const result = await daemon.exportMemory(profileName);
		return JSON.stringify(result, null, 2);
	}

	if (subcommand === "mode") {
		const mode = positionals[1];
		if (mode !== "off" && mode !== "manual" && mode !== "assist" && mode !== "auto") {
			throw new Error("memory mode requires one of: off, manual, assist, auto");
		}
		const profile = await daemon.setMemoryMode(mode, profileName);
		return `Set memory mode for ${profile.name} to ${profile.memoryMode}`;
	}

	throw new Error("memory subcommand must be one of: hot, warm, evaluate, search, search-workspace, export, mode");
};

export const workspaceFromCli = async (argv: string[]): Promise<string> => {
	const {positionals, flags} = parseArgs(argv);
	if (positionals[0] !== "link" || typeof flags.name !== "string" || typeof flags["workspace-root"] !== "string") throw new Error("workspace link requires --name <shared-label> --workspace-root <path>");
	return JSON.stringify(await new LocalRuntimeClient({home:typeof flags.home === "string" ? flags.home : undefined}).hotSyncControl({action:"link",name:flags.name,root:flags["workspace-root"],profileName:flags.profile}), null, 2);
};
