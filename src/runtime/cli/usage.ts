import { readdirSync } from "node:fs";
import { parseArgs } from "../adapter-utils";
import { isRuntimeProfileName } from "../runtime-env";
import { inspectWorkspaceHooks } from "../workspace-hooks";
import { isRuntimeProfileForBinding } from "../runtime-profile-validation";
import { loadProfile, loadRuntimeConfig, resolveRuntimePaths } from "../runtime-persistence";
import { readUsage, setUsageEnabled, type UsageTotals } from "../token-usage";

const usageHelp = "crosshead usage [on|off] [--profile <name>] [--home <path>] [--json]\n" +
	"crosshead usage --all-profiles [--home <path>] [--json]";

const formatTotals = (totals: UsageTotals): string =>
	`${totals.totalTokens.toLocaleString("en-US")} tokens (${totals.inputTokens.toLocaleString("en-US")} input, ${totals.outputTokens.toLocaleString("en-US")} output)`;

export const usageFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const [action] = positionals;
	if (action === "help" || flags.help === true) return usageHelp;
	if (positionals.length > 1 || (action && action !== "on" && action !== "off")) throw new Error(usageHelp);
	if (flags.profile === true || flags.home === true) throw new Error(usageHelp);
	const allProfiles = flags["all-profiles"] === true;
	if (allProfiles && action) throw new Error("Choose one profile when changing token counting.");

	const paths = resolveRuntimePaths(typeof flags.home === "string" ? flags.home : undefined);
	const explicit = typeof flags.profile === "string" ? flags.profile : null;
	let names: string[];
	if (allProfiles) {
		try {
			names = readdirSync(paths.profiles).filter(name => name.endsWith(".json")).map(name => name.slice(0, -5)).sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			names = [];
		}
	} else {
		const bindings = explicit === null ? inspectWorkspaceHooks(paths.home, process.cwd()).bindings : [];
		const bound = [...new Set(bindings.map(binding => binding.profile))];
		if (bound.length > 1) throw new Error("This workspace uses multiple Crosshead profiles. Choose one with --profile.");
		const profileName = explicit ?? bound[0] ?? loadRuntimeConfig(paths).defaultProfile;
		if (!profileName) throw new Error("No Crosshead profile configured. Run crosshead quickstart or pass --profile.");
		names = [profileName];
	}
	const profiles = names.flatMap(name => {
		const profile = isRuntimeProfileName(name) ? loadProfile(paths, name) : null;
		if (isRuntimeProfileForBinding(profile, name)) return [profile];
		if (!allProfiles) throw new Error(`Unknown or invalid Crosshead profile: ${name}`);
		return [];
	});

	if (action) {
		const profile = profiles[0]!;
		const since = await setUsageEnabled(paths, profile, action === "on");
		const enabled = since !== null;
		const result = { profile: profile.name, enabled, enabledAt: enabled ? new Date(since).toISOString() : null };
		return flags.json
			? JSON.stringify(result, null, 2)
			: `Local token counting for ${profile.name} is ${enabled ? "on" : "off"}.`;
	}

	const now = Date.now();
	const reports = await Promise.all(profiles.map(profile => readUsage(paths, profile, now)));
	if (flags.json) return JSON.stringify({ schemaVersion: 1, asOf: new Date(now).toISOString(), timezone: "UTC", profiles: reports }, null, 2);
	if (!reports.length) return "No Crosshead profiles configured.";
	return [
		"Local token usage (UTC)",
		...reports.flatMap(report => [
			`\n${report.profile} · counting ${report.enabled ? "on" : "off"}`,
			...report.periods.flatMap(period => [
				`  ${period.name === "today" ? "Today" : period.name === "7d" ? "Last 7 days" : "Last 30 days"}  ${formatTotals(period.totals)}`,
				...period.groups.map(group =>
					`    ${group.harness} / ${group.model}${group.subagent ? " (subagent)" : ""} · ${formatTotals(group)} · ` +
					`${group.cachedInputTokens.toLocaleString("en-US")} cache read, ${group.cacheWriteInputTokens.toLocaleString("en-US")} cache write, ` +
					`${group.reasoningOutputTokens.toLocaleString("en-US")} reasoning`),
			]),
		]),
	].join("\n");
};
