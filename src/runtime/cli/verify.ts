import { readFileSync } from "fs";

import { peerVerificationClaimDigest, PEER_VERIFICATION_OUTCOMES, type PeerFalsificationAttempt, type PeerVerificationOutcome } from "../../protocol/peer-verification";
import type { ContinuityClaim } from "../../protocol/continuity-claims";
import { OnlyBotsLocalRuntimeDaemon, parseArgs } from "../local-runtime";
import { buildPeerVerificationVerdict, mintPeerVerificationReceipt } from "../peer-verification";

/** Peer verification is in testing and deliberately absent from the general help text. */
export const verifyHelpLines = [
	"crosshead verify appoint --verifier <npub> [--json]      appoint an agent to try to falsify your continuity claims",
	"crosshead verify revoke --verifier <npub> [--json]",
	"crosshead verify verifiers [--json]",
	"crosshead verify queue [--json]                         claims you were appointed to check",
	"crosshead verify submit --claim <id> --outcome upheld|refuted|inconclusive --summary <text> (--attempts <json> | --attempts-file <path>) [--evidence-refs <csv>] [--json]",
	"  attempts: [{\"hypothesis\": \"what would be true if the claim were false\", \"method\": \"how you checked\", \"observation\": \"what you saw\", \"falsified\": false}]",
];

type Flags = Record<string, string | boolean>;

const str = (flags: Flags, key: string): string | undefined => {
	const value = flags[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const required = (flags: Flags, key: string, command: string): string => {
	const value = str(flags, key);
	if (!value) throw new Error(`verify ${command} requires --${key}`);
	return value;
};

const parseAttempts = (flags: Flags): PeerFalsificationAttempt[] => {
	const file = str(flags, "attempts-file");
	const raw = file ? readFileSync(file, "utf8") : str(flags, "attempts");
	if (!raw) throw new Error("verify submit requires --attempts <json> or --attempts-file <path>: record each attempt to falsify the claim");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("--attempts must be a JSON array");
	}
	if (!Array.isArray(parsed)) throw new Error("--attempts must be a JSON array");
	return parsed as PeerFalsificationAttempt[];
};

/** Queue items carry the claim as JSON; dates arrive as strings, which the digest does not use. */
const claimFromQueueItem = (item: Record<string, unknown>): ContinuityClaim => item.claim as ContinuityClaim;

export const verifyFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];
	const json = flags.json === true;
	if (!subcommand || subcommand === "help") return verifyHelpLines.join("\n");
	const home = typeof flags.home === "string" ? flags.home : undefined;
	const daemon = new OnlyBotsLocalRuntimeDaemon(home);
	const session = await daemon.openAgentSession(str(flags, "profile"));
	const out = (value: Record<string, unknown>, text: string): string => (json ? JSON.stringify(value, null, 2) : text);
	try {
		switch (subcommand) {
			case "appoint": {
				const result = await session.client.appointPeerVerifier(required(flags, "verifier", "appoint"));
				return out(result, `Appointed ${required(flags, "verifier", "appoint")} to try to falsify your continuity claims.`);
			}
			case "revoke": {
				const result = await session.client.revokePeerVerifier(required(flags, "verifier", "revoke"));
				return out(result, `Revoked ${required(flags, "verifier", "revoke")}.`);
			}
			case "verifiers": {
				const result = await session.client.listPeerVerifiers();
				const items = Array.isArray(result.verifiers) ? (result.verifiers as Array<Record<string, unknown>>) : [];
				return out(result, items.length ? items.map((item) => `${String(item.verifier_npub)} · appointed ${String(item.appointed_at)}`).join("\n") : "No verifiers appointed.");
			}
			case "queue": {
				const result = await session.client.peerVerificationQueue();
				const items = Array.isArray(result.items) ? (result.items as Array<Record<string, unknown>>) : [];
				return out(result, items.length
					? items.map((item) => {
						const claim = claimFromQueueItem(item);
						return `${claim.id} · ${claim.kind} · ${claim.status} · owner ${claim.npub}\n  ${claim.statement}`;
					}).join("\n")
					: "Nothing to verify.");
			}
			case "submit": {
				const claimId = required(flags, "claim", "submit");
				const outcome = required(flags, "outcome", "submit") as PeerVerificationOutcome;
				if (!PEER_VERIFICATION_OUTCOMES.includes(outcome)) throw new Error(`--outcome must be one of: ${PEER_VERIFICATION_OUTCOMES.join(", ")}`);
				const queue = await session.client.peerVerificationQueue();
				const items = Array.isArray(queue.items) ? (queue.items as Array<Record<string, unknown>>) : [];
				const item = items.find((candidate) => claimFromQueueItem(candidate).id === claimId);
				if (!item) throw new Error(`claim ${claimId} is not in your verification queue`);
				const claim = claimFromQueueItem(item);
				// Sign only what was computed locally from the claim text; refuse if the server describes a different claim.
				if (item.claim_digest !== peerVerificationClaimDigest(claim)) throw new Error("the server's claim digest does not match the claim it returned");
				const verdict = buildPeerVerificationVerdict({
					claim,
					verifierNpub: session.agentRef.npub,
					nsec: session.nsec,
					outcome,
					falsificationAttempts: parseAttempts(flags),
					evidenceRefs: (str(flags, "evidence-refs") ?? "").split(",").map((ref) => ref.trim()).filter(Boolean),
					summary: required(flags, "summary", "submit"),
				});
				const receipt = outcome === "inconclusive" ? undefined : await mintPeerVerificationReceipt({ verdict, verifier: session.agentRef as never, nsec: session.nsec });
				const result = await session.client.submitPeerVerdict({ verdict, ...(receipt ? { receipt } : {}) });
				const claimAfter = (result.claim as Record<string, unknown> | undefined) ?? {};
				return out(result, `Verdict ${verdict.verdictId}: ${outcome}. Claim ${claimId} is now ${String(claimAfter.status ?? "unchanged")}.`);
			}
			default:
				throw new Error(`unknown verify command: ${subcommand}\n${verifyHelpLines.join("\n")}`);
		}
	} finally {
		await session.persist().catch(() => undefined);
	}
};
