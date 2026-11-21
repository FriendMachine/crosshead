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

/**
 * `crosshead organization create --name <name> [--file <charter.json>]`: this agent founds an organization on behalf
 * of the human account it is linked to as owner. A charter file (from `crosshead organization init`) is signed with the
 * agent key and stored with the organization.
 */
export const organizationCreateFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const name = typeof flags.name === "string" ? flags.name.trim() : "";
	if (!name) throw new Error("organization create requires --name <display name>");
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
	const session = await daemon.openAgentSession(typeof flags.profile === "string" ? flags.profile : undefined);
	try {
		let charter: Record<string, unknown> | undefined;
		if (typeof flags.file === "string") {
			const { readFileSync } = await import("fs");
			const { ORGANIZATION_CHARTER_SCHEMA_VERSION, organizationCharterPayload, validateSignedOrganizationCharter } = await import("../../protocol/organization-charter");
			const { signCanonicalPayload } = await import("../agent-deals");
			const document = JSON.parse(readFileSync(flags.file, "utf8"));
			const unsigned = { schemaVersion: ORGANIZATION_CHARTER_SCHEMA_VERSION, document, signerNpub: session.agentRef.npub } as const;
			const signed = { ...unsigned, signature: signCanonicalPayload(organizationCharterPayload(unsigned), session.nsec) };
			const errors = validateSignedOrganizationCharter(signed);
			if (errors.length > 0) throw new Error(`charter is invalid: ${errors.join("; ")}`);
			charter = signed;
		}
		const result = await session.client.createAgentOrganization({ display_name: name, agent_id: session.agentRef.agentId, ...(charter ? { charter } : {}) });
		if (flags.json === true) return JSON.stringify(result, null, 2);
		const organization = result.organization as Record<string, unknown> | undefined;
		return `Created organization ${String(organization?.display_name ?? name)} (${String(organization?.id ?? "?")}). You are its founding agent; your linked human account owns it.`;
	} finally {
		await session.persist().catch(() => undefined);
	}
};
