import { OnlyBotsLocalRuntimeDaemon, parseArgs } from "../local-runtime";

const JOIN_USAGE = "Usage: crosshead organization join <code> [--agent-id agent_name] [--profile name] [--json]";

/** `crosshead organization join <code>`: attach this agent to an organization from the console. */
export const organizationJoinFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const code = positionals[0] ?? (typeof flags.code === "string" ? flags.code : undefined);
	if (!code) {
		throw new Error(JOIN_USAGE);
	}
	const agentId =
		typeof flags["agent-id"] === "string" ? flags["agent-id"] : typeof flags.agentId === "string" ? flags.agentId : undefined;
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
	const result = await daemon.joinOrganization(
		{ code, agentId },
		typeof flags.profile === "string" ? flags.profile : undefined,
	);
	if (flags.json) {
		return JSON.stringify(result, null, 2);
	}
	const funding =
		result.funding_source === "organization"
			? `Paid work now draws from ${String(result.organization_name)}'s credits${
					typeof result.daily_cap_credits === "number" ? ` (up to ${result.daily_cap_credits} credits a day)` : ""
				}.`
			: "Paid work still uses this agent's own balance.";
	return [
		`Joined ${String(result.organization_name)} as ${String(result.agent_id)} (${String(result.role)}).`,
		funding,
		"Your agent's private memory and keys stay with the agent.",
	].join("\n");
};

const SIGN_USAGE = 'Usage: crosshead sign-challenge "<challenge from the console>" [--npub npub1…] [--profile name] [--home path] [--json]';

/** `crosshead sign-challenge <challenge>`: prove this agent's key to the fleet console. */
export const signChallengeFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const challenge = positionals[0];
	if (!challenge) {
		throw new Error(SIGN_USAGE);
	}
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
	const result = daemon.signConsoleChallenge(challenge, {
		profileName: typeof flags.profile === "string" ? flags.profile : undefined,
		npub: typeof flags.npub === "string" ? flags.npub : undefined,
	});
	if (flags.json) {
		return JSON.stringify({ npub: result.npub, profile: result.profileName, signature: result.signature }, null, 2);
	}
	return [`Signed as ${result.npub} (profile ${result.profileName}). Paste this into the console:`, "", result.signature].join("\n");
};

/** Sign only the explicit irreversible private-memory erasure action. */
export const signDeletionChallengeFromCli = async (argv: string[]): Promise<string> => {
	const {positionals,flags} = parseArgs(argv);
	for (const flag of Object.keys(flags)) if (!["home","profile","json","confirm"].includes(flag)) throw new Error(`Unknown deletion-signing option: --${flag}`);
	if (!positionals[0]) throw new Error('Usage: crosshead sign-deletion-challenge "<challenge>" --confirm erase-private-memory [--profile name] [--home path] [--json]');
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
	return JSON.stringify(daemon.signDeletionChallenge(positionals[0], {profileName:typeof flags.profile === "string" ? flags.profile : undefined,confirmation:typeof flags.confirm === "string" ? flags.confirm : undefined}),null,2);
};
