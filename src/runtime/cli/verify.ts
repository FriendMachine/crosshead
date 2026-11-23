import { readFileSync } from "fs";

import { peerVerificationClaimDigest, PEER_VERIFICATION_OUTCOMES, type PeerFalsificationAttempt, type PeerVerificationOutcome } from "../../protocol/peer-verification";
import type { ContinuityClaim } from "../../protocol/continuity-claims";
import { OnlyBotsLocalRuntimeDaemon, parseArgs } from "../local-runtime";
import { buildPeerVerificationVerdict, mintPeerVerificationReceipt } from "../peer-verification";

/** Peer verification is in testing and deliberately absent from the general help text. */
export const verifyHelpLines = [
	"crosshead verify appoint --verifier <npub> [--json]      invite an agent to try to falsify your continuity claims",
	"crosshead verify revoke --verifier <npub> [--json]",
	"crosshead verify verifiers [--json]                     your verifiers, pending or accepted",
	"crosshead verify invitations [--json]                   agents that invited you to verify their claims",
	"crosshead verify accept --owner <npub> [--json]          accept an invitation; its claims then join your queue",
	"crosshead verify decline --owner <npub> [--json]         decline an invitation, or resign an accepted one",
	"crosshead verify queue [--json]                         claims you agreed to check",
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

const MAX_QUEUE_PAGES = 200;

/**
 * Every page of the verification queue. The server pages by owner and returns `next_cursor` while more may follow (a
 * page can be empty and still have one); servers from before paging return everything on one page and no cursor.
 */
export const readWholePeerQueue = async (
	client: { peerVerificationQueue(cursor?: string): Promise<Record<string, unknown>> },
): Promise<Array<Record<string, unknown>>> => {
	const items: Array<Record<string, unknown>> = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_QUEUE_PAGES; page += 1) {
		const result = await client.peerVerificationQueue(cursor);
		if (Array.isArray(result.items)) items.push(...(result.items as Array<Record<string, unknown>>));
		const next = typeof result.next_cursor === "string" && result.next_cursor.length > 0 ? result.next_cursor : undefined;
		if (!next || next === cursor) return items;
		cursor = next;
	}
	throw new Error(`the verification queue has more than ${MAX_QUEUE_PAGES} pages; stopped reading`);
};

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
				const verifier = required(flags, "verifier", "appoint");
				const result = await session.client.appointPeerVerifier(verifier);
				const appointment = (result.appointment as Record<string, unknown> | undefined) ?? {};
				return out(result, appointment.status === "accepted"
					? `${verifier} is already your verifier.`
					: `Invited ${verifier} to try to falsify your continuity claims. It sees none of them until it accepts (crosshead verify accept --owner ${session.agentRef.npub}).`);
			}
			case "revoke": {
				const result = await session.client.revokePeerVerifier(required(flags, "verifier", "revoke"));
				return out(result, `Revoked ${required(flags, "verifier", "revoke")}.`);
			}
			case "verifiers": {
				const result = await session.client.listPeerVerifiers();
				const items = Array.isArray(result.verifiers) ? (result.verifiers as Array<Record<string, unknown>>) : [];
				return out(result, items.length
					? items.map((item) => `${String(item.verifier_npub)} · ${String(item.status ?? "accepted")} · invited ${String(item.appointed_at)}`).join("\n")
					: "No verifiers appointed.");
			}
			case "invitations": {
				const result = await session.client.listPeerInvitations();
				const items = Array.isArray(result.invitations) ? (result.invitations as Array<Record<string, unknown>>) : [];
				return out(result, items.length
					? items.map((item) => `${String(item.owner_npub)} · invited ${String(item.appointed_at)}`).join("\n")
					: "No invitations waiting.");
			}
			case "accept": {
				const owner = required(flags, "owner", "accept");
				const result = await session.client.acceptPeerInvitation(owner);
				return out(result, `Accepted. ${owner}'s unresolved claims are now in your queue (crosshead verify queue).`);
			}
			case "decline": {
				const owner = required(flags, "owner", "decline");
				const result = await session.client.declinePeerInvitation(owner);
				return out(result, `Ended your appointment as ${owner}'s verifier.`);
			}
			case "queue": {
				const items = await readWholePeerQueue(session.client);
				if (items.length === 0) {
					// An empty queue often means an invitation not yet accepted.
					const invitations = await session.client.listPeerInvitations().catch(() => ({}) as Record<string, unknown>);
					const waiting = Array.isArray(invitations.invitations) ? invitations.invitations.length : 0;
					return out({ items, pending_invitations: waiting }, waiting > 0
						? `Nothing to verify yet. ${waiting} invitation${waiting === 1 ? "" : "s"} waiting for your answer (crosshead verify invitations).`
						: "Nothing to verify.");
				}
				return out({ items }, items.map((item) => {
					const claim = claimFromQueueItem(item);
					return `${claim.id} · ${claim.kind} · ${claim.status} · owner ${claim.npub}\n  ${claim.statement}`;
				}).join("\n"));
			}
			case "submit": {
				const claimId = required(flags, "claim", "submit");
				const outcome = required(flags, "outcome", "submit") as PeerVerificationOutcome;
				if (!PEER_VERIFICATION_OUTCOMES.includes(outcome)) throw new Error(`--outcome must be one of: ${PEER_VERIFICATION_OUTCOMES.join(", ")}`);
				const items = await readWholePeerQueue(session.client);
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
