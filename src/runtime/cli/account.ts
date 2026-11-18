import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { writeManagedFile } from "../adapter-utils";
import { HostedOnlyBotsRequestError, type AccountLinkStatus } from "../hosted-client";
import { OnlyBotsLocalRuntimeDaemon, parseArgs } from "../local-runtime";
import { isLocalOnlyRuntimeProfile } from "../local-hot-memory";
import { loadProfile, loadRuntimeConfig, resolveRuntimePaths, type RuntimePaths } from "../runtime-persistence";

const USAGE = [
	"Usage: crosshead account link [--profile <name> | --profiles <a,b> | --all-profiles] [--no-browser] [--no-wait] [--json]",
	"       crosshead account link --resume <request-id> [--json]",
].join("\n");
const AGENT_ID = /^agent_[a-z0-9][a-z0-9_-]{2,127}$/;

type Flags = Record<string, string | boolean>;
type Skipped = { profile: string; reason: string };
type Pending = { requestId: string; pollSecret: string; profile: string; apiBase: string; userCode: string; verificationUrl: string; verificationUrlBase: string; expiresAt: string; intervalSeconds: number; profiles: string[] };

const pendingDir = (paths: RuntimePaths): string => path.join(paths.state, "account-links");
const pendingFile = (paths: RuntimePaths, requestId: string): string => {
	if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new Error("Invalid request id");
	return path.join(pendingDir(paths), `${requestId}.json`);
};

const profileNames = (paths: RuntimePaths): string[] =>
	existsSync(paths.profiles) ? readdirSync(paths.profiles).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort() : [];

const selectedProfiles = (paths: RuntimePaths, flags: Flags): string[] => {
	if (flags["all-profiles"]) return profileNames(paths);
	if (typeof flags.profiles === "string") return [...new Set(flags.profiles.split(",").map((name) => name.trim()).filter(Boolean))];
	const single = typeof flags.profile === "string" ? flags.profile : loadRuntimeConfig(paths).defaultProfile;
	if (!single) throw new Error("Choose a profile with --profile, or run crosshead quickstart first.");
	return [single];
};

/** Opens the approval page without waiting on, or failing because of, the browser. */
const openBrowser = (url: string): boolean => {
	const command = process.platform === "darwin" ? ["open", url]
		: process.platform === "win32" ? ["cmd", "/c", "start", "", url]
		: process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? ["xdg-open", url] : null;
	if (!command) return false;
	try {
		const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: "ignore" });
		child.on("error", () => undefined);
		child.unref();
		return true;
	} catch { return false; }
};

const unavailable = (error: unknown): boolean =>
	error instanceof HostedOnlyBotsRequestError && (error.status === 404 && (error.code === "not_available" || error.code === null || error.code === "not_found"));

const describeStatus = (status: AccountLinkStatus, skipped: Skipped[]): string => {
	const lines: string[] = [];
	if (status.status === "approved") {
		const who = status.account?.email ?? status.account?.display_name ?? "your account";
		lines.push(status.organization ? `Linked to ${who} in ${status.organization.name}.` : `Linked to ${who}.`);
		for (const agent of status.agents) {
			const name = agent.agent_id ?? `${agent.npub.slice(0, 16)}…`;
			const org = agent.organization === "attached" ? `added to the organization${agent.funding_source === "organization" ? ", paid from organization credits" : ", paid from its own balance"}`
				: agent.organization === "already_member" ? "already in the organization"
				: agent.organization === "failed" ? `not added to the organization: ${agent.error ?? "unknown error"}`
				: null;
			lines.push(`  ${name}: ${agent.linked ? "linked" : `not linked${agent.error ? `: ${agent.error}` : ""}`}${org ? `; ${org}` : ""}`);
		}
	} else if (status.status === "denied") {
		lines.push("The request was denied in the console. Nothing was linked.");
	} else if (status.status === "expired") {
		lines.push("The request expired before it was approved. Run crosshead account link again.");
	} else {
		lines.push("Still waiting for approval.");
	}
	for (const entry of skipped) lines.push(`  Skipped ${entry.profile}: ${entry.reason}`);
	return lines.join("\n");
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForDecision = async (daemon: OnlyBotsLocalRuntimeDaemon, pending: Pending, timeoutSeconds: number | null): Promise<AccountLinkStatus> => {
	const deadline = Math.min(Date.parse(pending.expiresAt) + 5_000, timeoutSeconds ? Date.now() + timeoutSeconds * 1000 : Infinity);
	const interval = Math.max(2, pending.intervalSeconds || 3) * 1000;
	for (;;) {
		let status: AccountLinkStatus;
		try {
			status = await daemon.getAccountLinkStatus(pending.requestId, pending.pollSecret, pending.profile);
		} catch (error) {
			if (error instanceof HostedOnlyBotsRequestError && error.status === 429) {
				await sleep(Math.max(interval, error.retryAfterMs));
				continue;
			}
			throw error;
		}
		if (status.status !== "pending" || Date.now() >= deadline) return status;
		await sleep(interval);
	}
};

/** `crosshead account link`: link local agents to a person's account through one console approval. */
export const accountFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	if (positionals[0] !== "link") throw new Error(USAGE);
	const home = typeof flags.home === "string" ? flags.home : undefined;
	const paths = resolveRuntimePaths(home);
	const daemon = new OnlyBotsLocalRuntimeDaemon(home);
	const timeout = typeof flags.timeout === "string" ? Number(flags.timeout) : null;
	if (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error("Choose --timeout <seconds> greater than 0");

	const finish = (pending: Pending, status: AccountLinkStatus, skipped: Skipped[]) => {
		if (status.status !== "pending") rmSync(pendingFile(paths, pending.requestId), { force: true });
		const resume = `crosshead account link --resume ${pending.requestId}`;
		if (flags.json) return JSON.stringify({ ...status, skipped, ...(status.status === "pending" ? { resume_command: resume } : {}) }, null, 2);
		return describeStatus(status, skipped) + (status.status === "pending" ? `\nResume with: ${resume}` : "");
	};

	if (typeof flags.resume === "string") {
		const file = pendingFile(paths, flags.resume);
		if (!existsSync(file)) throw new Error(`No pending account link request ${flags.resume} on this machine.`);
		const pending = JSON.parse(readFileSync(file, "utf8")) as Pending;
		return finish(pending, await waitForDecision(daemon, pending, timeout), []);
	}

	const skipped: Skipped[] = [];
	const candidates: Array<{ name: string; apiBase: string; agentId?: string }> = [];
	for (const name of selectedProfiles(paths, flags)) {
		const profile = loadProfile(paths, name);
		if (!profile) { skipped.push({ profile: name, reason: "profile not found" }); continue; }
		if (isLocalOnlyRuntimeProfile(profile)) { skipped.push({ profile: name, reason: "local-only profile with no hosted account" }); continue; }
		const agentId = typeof (profile as { agentId?: unknown }).agentId === "string" && AGENT_ID.test((profile as { agentId: string }).agentId)
			? (profile as { agentId: string }).agentId : undefined;
		candidates.push({ name, apiBase: profile.apiBase.replace(/\/+$/, ""), ...(agentId ? { agentId } : {}) });
	}
	if (candidates.length === 0) throw new Error(["No profiles can be linked.", ...skipped.map((entry) => `  ${entry.profile}: ${entry.reason}`)].join("\n"));

	// One request covers one service; profiles for another service are reported, not mixed in.
	const apiBase = candidates[0]!.apiBase;
	const clientLabel = hostname().slice(0, 80);
	let pending: Pending | null = null;
	const joined: string[] = [];
	for (const candidate of candidates) {
		if (candidate.apiBase !== apiBase) { skipped.push({ profile: candidate.name, reason: `uses ${candidate.apiBase}; run again with --profile ${candidate.name}` }); continue; }
		try {
			if (!pending) {
				const created = await daemon.createAccountLinkRequest({ clientLabel, agentId: candidate.agentId, displayName: candidate.name }, candidate.name);
				pending = {
					requestId: created.request_id, pollSecret: created.poll_secret, profile: candidate.name, apiBase,
					userCode: created.user_code, verificationUrl: created.verification_url, verificationUrlBase: created.verification_url_base,
					expiresAt: created.expires_at, intervalSeconds: created.interval_seconds, profiles: [],
				};
			} else {
				await daemon.joinAccountLinkRequest(pending.requestId, pending.pollSecret, { agentId: candidate.agentId, displayName: candidate.name }, candidate.name);
			}
			joined.push(candidate.name);
		} catch (error) {
			if (unavailable(error)) {
				throw new Error(`${apiBase} doesn't support linking from the CLI yet. Link agents in the console instead: ${apiBase}/account/settings`);
			}
			skipped.push({ profile: candidate.name, reason: `couldn't sign in or join the request: ${(error as Error).message}` });
		}
	}
	if (!pending) throw new Error(["No profiles could start a link request.", ...skipped.map((entry) => `  ${entry.profile}: ${entry.reason}`)].join("\n"));
	pending.profiles = joined;
	writeManagedFile(pendingFile(paths, pending.requestId), JSON.stringify(pending), paths.home);

	const opened = flags["no-browser"] || flags.browser === "false" ? false : openBrowser(pending.verificationUrl);
	const intro = {
		request_id: pending.requestId, user_code: pending.userCode, verification_url: pending.verificationUrl,
		verification_url_base: pending.verificationUrlBase, expires_at: pending.expiresAt, profiles: joined, skipped, browser_opened: opened,
		resume_command: `crosshead account link --resume ${pending.requestId}`,
	};
	if (flags["no-wait"]) {
		return flags.json ? JSON.stringify({ status: "pending", ...intro }, null, 2) : [
			`Approve in the console: ${pending.verificationUrl}`,
			`Or open ${pending.verificationUrlBase} and enter code ${pending.userCode}.`,
			`Agents: ${joined.join(", ")}. The code expires at ${pending.expiresAt}.`,
			`Then run: ${intro.resume_command}`,
		].join("\n");
	}
	if (flags.json) {
		process.stderr.write(`${JSON.stringify({ status: "pending", ...intro })}\n`);
	} else {
		process.stderr.write([
			`${opened ? "Opened" : "Open"} ${pending.verificationUrl}`,
			`Or go to ${pending.verificationUrlBase} and enter code ${pending.userCode}.`,
			`Agents to link: ${joined.join(", ")}. Waiting for approval…`,
			"",
		].join("\n"));
	}
	return finish(pending, await waitForDecision(daemon, pending, timeout), skipped);
};
