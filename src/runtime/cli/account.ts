import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { writeManagedFile } from "../adapter-utils";
import { HostedOnlyBotsRequestError, normalizeApiBase, type AccountLinkStatus } from "../hosted-client";
import { OnlyBotsLocalRuntimeDaemon, parseArgs } from "../local-runtime";
import { isLocalOnlyRuntimeProfile } from "../local-hot-memory";
import { loadProfile, loadRuntimeConfig, resolveRuntimePaths, type RuntimePaths } from "../runtime-persistence";

const USAGE = [
	"Usage: crosshead account link [--profile <name> | --profiles <a,b> | --all-profiles] [--no-browser] [--no-wait] [--timeout <seconds>] [--json]",
	"       crosshead account link --resume <request-id> [--timeout <seconds>] [--json]",
].join("\n");
const AGENT_ID = /^agent_[a-z0-9][a-z0-9_-]{2,127}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const STATUSES = new Set(["pending", "approved", "denied", "expired"]);
// Tests shorten the floor; the service's own interval still applies above it.
const MIN_INTERVAL_MS = Math.max(50, Number(process.env.CROSSHEAD_ACCOUNT_LINK_MIN_INTERVAL_MS) || 2_000);
const MAX_INTERVAL_MS = 30_000;
const FALLBACK_WINDOW_MS = 10 * 60_000;

/** Exit codes scripts and agents can branch on. */
export const ACCOUNT_LINK_EXIT = { linked: 0, declined: 1, pending: 2, partial: 3 } as const;

type Flags = Record<string, string | boolean>;
type Skipped = { profile: string; reason: string };
type Pending = {
	requestId: string; pollSecret: string; profile: string; serviceBaseUrl: string; userCode: string;
	verificationUrl: string | null; verificationUrlBase: string; expiresAt: string; intervalSeconds: number; profiles: string[];
};

/** Server text is shown in terminals and agent transcripts; drop control characters. */
const clean = (value: unknown, max = 200): string =>
	String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "").slice(0, max);

const stringFlag = (flags: Flags, key: string): string | undefined => {
	const value = flags[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") throw new Error(`--${key} needs a value.\n${USAGE}`);
	return value.trim();
};

const pendingDir = (paths: RuntimePaths): string => path.join(paths.state, "account-links");
const pendingFile = (paths: RuntimePaths, requestId: string): string => {
	if (!REQUEST_ID.test(requestId)) throw new Error("Invalid account link request id");
	return path.join(pendingDir(paths), `${requestId}.json`);
};

/** Remove saved poll secrets for requests that can no longer be approved. */
const pruneExpired = (paths: RuntimePaths): void => {
	const dir = pendingDir(paths);
	if (!existsSync(dir)) return;
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		try {
			const saved = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Partial<Pending>;
			const expires = Date.parse(String(saved.expiresAt));
			if (!Number.isFinite(expires) || expires + 60_000 < Date.now()) rmSync(path.join(dir, file), { force: true });
		} catch { rmSync(path.join(dir, file), { force: true }); }
	}
};

const profileNames = (paths: RuntimePaths): string[] =>
	existsSync(paths.profiles) ? readdirSync(paths.profiles).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort() : [];

const selectedProfiles = (paths: RuntimePaths, flags: Flags): { names: string[]; preferred: string | null } => {
	const preferred = loadRuntimeConfig(paths).defaultProfile ?? null;
	if (flags["all-profiles"]) return { names: profileNames(paths), preferred };
	const list = stringFlag(flags, "profiles");
	if (list) return { names: [...new Set(list.split(",").map((name) => name.trim()).filter(Boolean))], preferred: null };
	const single = stringFlag(flags, "profile") ?? preferred;
	if (!single) throw new Error("Choose a profile with --profile, or run crosshead quickstart first.");
	return { names: [single], preferred: single };
};

/** Only open a page on the profile's own service, at the approval path, for this code. */
const approvalUrl = (raw: unknown, serviceBaseUrl: string, userCode: string, withCode: boolean): string | null => {
	try {
		const url = new URL(String(raw));
		const service = new URL(serviceBaseUrl);
		const expectedPath = `${service.pathname.replace(/\/+$/, "")}/account/link`;
		if (url.origin !== service.origin || url.pathname !== expectedPath || url.username || url.password || url.hash) return null;
		if (withCode ? [...url.searchParams.keys()].join() !== "code" || url.searchParams.get("code") !== userCode : url.search !== "") return null;
		return url.toString();
	} catch { return null; }
};

/** Opens the approval page without waiting on, or failing because of, the browser. */
const openBrowser = (url: string): boolean => {
	const command = process.platform === "darwin" ? ["open", url]
		: process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url]
		: process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? ["xdg-open", url] : null;
	if (!command) return false;
	try {
		const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: "ignore", shell: false });
		child.on("error", () => undefined);
		child.unref();
		return true;
	} catch { return false; }
};

const isUnavailable = (error: unknown): boolean =>
	error instanceof HostedOnlyBotsRequestError && error.status === 404 && error.code === "not_available";

const transient = (error: unknown): boolean =>
	!(error instanceof HostedOnlyBotsRequestError) || error.status === 429 || error.status >= 500;

const agentsFailed = (status: AccountLinkStatus): boolean =>
	status.agents.some((agent) => !agent.linked || agent.organization === "failed");

const exitCodeFor = (status: AccountLinkStatus): number =>
	status.status === "approved" ? (agentsFailed(status) ? ACCOUNT_LINK_EXIT.partial : ACCOUNT_LINK_EXIT.linked)
		: status.status === "pending" ? ACCOUNT_LINK_EXIT.pending : ACCOUNT_LINK_EXIT.declined;

const describeStatus = (status: AccountLinkStatus, skipped: Skipped[], resume: string): string => {
	const lines: string[] = [];
	if (status.status === "approved") {
		const who = clean(status.account?.email ?? status.account?.display_name ?? "your account", 120);
		lines.push(status.organization ? `Linked to ${who} in ${clean(status.organization.name, 120)}.` : `Linked to ${who}.`);
		for (const agent of status.agents) {
			const name = clean(agent.agent_id ?? `${String(agent.npub).slice(0, 16)}…`, 130);
			const error = agent.error ? clean(agent.error) : null;
			const org = agent.organization === "attached" ? `added to the organization, paid from ${agent.funding_source === "organization" ? "organization credits" : "its own balance"}`
				: agent.organization === "already_member" ? "already in the organization"
				: agent.organization === "failed" ? `not added to the organization: ${error ?? "unknown error"}`
				: null;
			lines.push(`  ${name}: ${agent.linked ? "linked" : `not linked${error ? `: ${error}` : ""}`}${org ? `; ${org}` : ""}`);
		}
		lines.push("If you didn't approve this, unlink these agents in the console under Account settings.");
	} else if (status.status === "denied") {
		lines.push("The request was denied in the console. Nothing was linked.");
	} else if (status.status === "expired") {
		lines.push("The request expired before it was approved. Run crosshead account link again.");
	} else {
		lines.push(`Still waiting for approval. Resume with: ${resume}`);
	}
	for (const entry of skipped) lines.push(`  Skipped ${entry.profile}: ${entry.reason}`);
	return lines.join("\n");
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const validStatus = (status: AccountLinkStatus, requestId: string): AccountLinkStatus => {
	if (!status || status.request_id !== requestId || !STATUSES.has(status.status) || !Array.isArray(status.agents)) {
		throw new Error("The service returned an unexpected account link status.");
	}
	return status;
};

const waitForDecision = async (
	daemon: OnlyBotsLocalRuntimeDaemon, pending: Pending, timeoutSeconds: number | null
): Promise<AccountLinkStatus> => {
	const expires = Date.parse(pending.expiresAt);
	const deadline = Math.min(
		Number.isFinite(expires) ? expires + 5_000 : Date.now() + FALLBACK_WINDOW_MS,
		timeoutSeconds ? Date.now() + timeoutSeconds * 1000 : Infinity,
	);
	const interval = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, (Number(pending.intervalSeconds) || 3) * 1000));
	let backoff = interval;
	let last: unknown = null;
	for (;;) {
		try {
			const status = validStatus(await daemon.getAccountLinkStatus(pending.requestId, pending.pollSecret, pending.profile), pending.requestId);
			if (status.status !== "pending" || Date.now() >= deadline) return status;
			backoff = interval;
		} catch (error) {
			if (!transient(error)) throw error;
			last = error;
			const retryAfter = error instanceof HostedOnlyBotsRequestError ? error.retryAfterMs : 0;
			backoff = Math.min(MAX_INTERVAL_MS, Math.max(backoff * 2, retryAfter));
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			if (last) throw new Error(`Couldn't reach the service to check the request: ${(last as Error).message}`);
			return { request_id: pending.requestId, status: "pending", expires_at: pending.expiresAt, account: null, organization: null, agents: [] };
		}
		await sleep(Math.min(backoff, remaining));
		last = null;
	}
};

/** `crosshead account link`: link local agents to a person's account through one console approval. */
export const accountFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	if (positionals[0] !== "link") throw new Error(USAGE);
	const home = typeof flags.home === "string" ? flags.home : undefined;
	const paths = resolveRuntimePaths(home);
	const daemon = new OnlyBotsLocalRuntimeDaemon(home);
	const timeoutValue = stringFlag(flags, "timeout");
	const timeout = timeoutValue === undefined ? null : Number(timeoutValue);
	if (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error("Choose --timeout <seconds> greater than 0");
	pruneExpired(paths);

	const finish = (pending: Pending, status: AccountLinkStatus, skipped: Skipped[]) => {
		const resume = `crosshead account link --resume ${pending.requestId}`;
		if (status.status !== "pending") rmSync(pendingFile(paths, pending.requestId), { force: true });
		process.exitCode = exitCodeFor(status);
		const safe = {
			...status,
			account: status.account ? { display_name: status.account.display_name ? clean(status.account.display_name, 120) : null, email: status.account.email ? clean(status.account.email, 120) : null } : null,
			organization: status.organization ? { id: clean(status.organization.id, 80), name: clean(status.organization.name, 120) } : null,
			agents: status.agents.map((agent) => ({ ...agent, agent_id: agent.agent_id ? clean(agent.agent_id, 130) : null, error: agent.error ? clean(agent.error) : null })),
		};
		if (flags.json) return JSON.stringify({ ...safe, profiles: pending.profiles, skipped, ...(status.status === "pending" ? { resume_command: resume } : {}) }, null, 2);
		return describeStatus(safe, skipped, resume);
	};

	const resumeId = stringFlag(flags, "resume");
	if (resumeId) {
		const file = pendingFile(paths, resumeId);
		if (!existsSync(file)) throw new Error(`No pending account link request ${resumeId} on this machine. It may have expired; run crosshead account link again.`);
		const pending = JSON.parse(readFileSync(file, "utf8")) as Pending;
		const profile = loadProfile(paths, pending.profile);
		if (!profile || normalizeApiBase(profile.apiBase).serviceBaseUrl !== pending.serviceBaseUrl) {
			throw new Error(`Profile ${pending.profile} no longer points at ${pending.serviceBaseUrl}. Run crosshead account link again.`);
		}
		try {
			return finish(pending, await waitForDecision(daemon, pending, timeout), []);
		} catch (error) {
			if (error instanceof HostedOnlyBotsRequestError && (error.status === 404 || error.status === 410)) {
				rmSync(file, { force: true });
				throw new Error("The service no longer has this request. Run crosshead account link again.");
			}
			throw error;
		}
	}

	const { names, preferred } = selectedProfiles(paths, flags);
	const skipped: Skipped[] = [];
	const seen = new Set<string>();
	const groups = new Map<string, Array<{ name: string; agentId?: string }>>();
	for (const name of names) {
		const profile = loadProfile(paths, name) as (ReturnType<typeof loadProfile> & { agentId?: unknown }) | null;
		if (!profile) { skipped.push({ profile: name, reason: "profile not found" }); continue; }
		if (typeof profile.apiBase !== "string" || isLocalOnlyRuntimeProfile(profile)) { skipped.push({ profile: name, reason: "local-only profile with no hosted account" }); continue; }
		if (seen.has(profile.npub)) { skipped.push({ profile: name, reason: "same agent key as another selected profile" }); continue; }
		let serviceBaseUrl: string;
		try { serviceBaseUrl = normalizeApiBase(profile.apiBase).serviceBaseUrl; }
		catch (error) { skipped.push({ profile: name, reason: (error as Error).message }); continue; }
		seen.add(profile.npub);
		const agentId = typeof profile.agentId === "string" && AGENT_ID.test(profile.agentId) ? profile.agentId : undefined;
		const group = groups.get(serviceBaseUrl) ?? [];
		group.push({ name, ...(agentId ? { agentId } : {}) });
		groups.set(serviceBaseUrl, group);
	}
	if (groups.size === 0) throw new Error(["No profiles can be linked.", ...skipped.map((entry) => `  ${entry.profile}: ${entry.reason}`)].join("\n"));

	// One approval covers one service: prefer the default profile's service, then the largest group.
	const ordered = [...groups.entries()].sort(([, a], [, b]) =>
		Number(b.some((entry) => entry.name === preferred)) - Number(a.some((entry) => entry.name === preferred)) || b.length - a.length);
	const [serviceBaseUrl, candidates] = ordered[0]!;
	for (const [other, members] of ordered.slice(1)) {
		skipped.push({ profile: members.map((entry) => entry.name).join(","), reason: `uses ${other}; run again with --profiles ${members.map((entry) => entry.name).join(",")}` });
	}

	const clientLabel = clean(hostname(), 80);
	let pending: Pending | null = null;
	const joined: string[] = [];
	for (const candidate of candidates) {
		try {
			if (!pending) {
				const created = await daemon.createAccountLinkRequest({ clientLabel, agentId: candidate.agentId, displayName: candidate.name }, candidate.name);
				if (!REQUEST_ID.test(String(created.request_id)) || !USER_CODE.test(String(created.user_code)) || typeof created.poll_secret !== "string") {
					throw new Error("The service returned an unexpected account link request.");
				}
				const base = approvalUrl(created.verification_url_base, serviceBaseUrl, created.user_code, false) ?? `${serviceBaseUrl}/account/link`;
				pending = {
					requestId: created.request_id, pollSecret: created.poll_secret, profile: candidate.name, serviceBaseUrl,
					userCode: created.user_code, verificationUrl: approvalUrl(created.verification_url, serviceBaseUrl, created.user_code, true),
					verificationUrlBase: base, expiresAt: String(created.expires_at), intervalSeconds: Number(created.interval_seconds), profiles: [],
				};
				writeManagedFile(pendingFile(paths, pending.requestId), JSON.stringify(pending), paths.home);
			} else {
				await daemon.joinAccountLinkRequest(pending.requestId, pending.pollSecret, { agentId: candidate.agentId, displayName: candidate.name }, candidate.name);
			}
			joined.push(candidate.name);
		} catch (error) {
			if (!pending && isUnavailable(error)) {
				throw new Error(`${serviceBaseUrl} doesn't support linking from the CLI yet. Link agents in the console instead: ${serviceBaseUrl}/account/settings`);
			}
			const reason = error instanceof HostedOnlyBotsRequestError && pending
				? error.status === 404 ? "the request was not found or its secret was rejected"
					: error.status === 410 ? "the request expired or was already decided"
					: error.status === 409 ? "the request already has the maximum number of agents"
					: clean(error.message)
				: `couldn't sign in or start the request: ${clean((error as Error).message)}`;
			skipped.push({ profile: candidate.name, reason });
		}
	}
	if (!pending) throw new Error(["No profiles could start a link request.", ...skipped.map((entry) => `  ${entry.profile}: ${entry.reason}`)].join("\n"));
	pending.profiles = joined;
	writeManagedFile(pendingFile(paths, pending.requestId), JSON.stringify(pending), paths.home);

	const resume = `crosshead account link --resume ${pending.requestId}`;
	const openUrl = pending.verificationUrl ?? pending.verificationUrlBase;
	const opened = flags["no-browser"] || flags.browser === "false" ? false : openBrowser(openUrl);
	const intro = {
		status: "pending" as const, request_id: pending.requestId, user_code: pending.userCode, verification_url: openUrl,
		verification_url_base: pending.verificationUrlBase, expires_at: pending.expiresAt, profiles: joined, skipped,
		browser_opened: opened, resume_command: resume,
	};
	const warning = "Approve only in your own browser session. Whoever approves this code becomes the owner of these agents; don't share it.";
	if (flags["no-wait"]) {
		return flags.json ? JSON.stringify({ ...intro, warning }, null, 2) : [
			`Approve in the console: ${openUrl}`,
			`Or open ${pending.verificationUrlBase} and enter code ${pending.userCode}.`,
			`Agents: ${joined.join(", ")}. The code expires at ${pending.expiresAt}.`,
			warning,
			`Then run: ${resume}`,
			...skipped.map((entry) => `  Skipped ${entry.profile}: ${entry.reason}`),
		].join("\n");
	}
	process.stderr.write(flags.json ? `${JSON.stringify({ ...intro, warning })}\n` : [
		`${opened ? "Opened" : "Open"} ${openUrl}`,
		`Or go to ${pending.verificationUrlBase} and enter code ${pending.userCode}.`,
		`Agents to link: ${joined.join(", ")}. ${warning}`,
		`Waiting for approval… (if interrupted: ${resume})`,
		"",
	].join("\n"));
	return finish(pending, await waitForDecision(daemon, pending, timeout), skipped);
};
