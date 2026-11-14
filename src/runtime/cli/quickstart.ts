import { installCodexFromCli } from "../codex-adapter";
import { installClaudeCodeFromCli } from "../claude-code-adapter";
import { installPiFromCli } from "../pi-adapter";
import { installOmpFromCli } from "../omp-adapter";
import { nativeHostFromCli } from "../native-host-adapter";
import { parseArgs } from "../local-runtime";
import { ensureRuntimeHomeLayout, loadProfile, loadRuntimeConfig } from "../runtime-persistence";
import { billingFromCli } from "./billing";
import { installCoreFromCli, keygenFromCli, statusFromCli } from "./core";
import { DEFAULT_CHECKOUT_CREDIT_UNITS } from "../billing-remediation";
import { realpathSync } from "node:fs";
import path from "node:path";
import { readDaemonOwnershipState, readRuntimeDaemonHealth } from "../daemon-ownership";
import { startDetachedRuntimeDaemon, stopDetachedRuntimeDaemon } from "../local-runtime";
import { resolveRuntimePaths } from "../runtime-persistence";

export type QuickstartCliPaths = {
	cliScriptPath: string;
	daemonScriptPath: string;
	codexBridgeScriptPath: string;
	codexHookScriptPath: string;
	claudeCodeBridgeScriptPath: string;
	claudeCodeHookScriptPath: string;
};

type QuickstartAdapter = "codex" | "claude-code" | "pi" | "omp" | "hermes" | "opencode" | "none";

type QuickstartStep = {
	id: string;
	ok: boolean;
	detail: string;
};

const flagPair = (name: string, value: string | undefined): string[] => (value ? [name, value] : []);

const boolFlagDisabled = (flags: Record<string, string | boolean>, name: string): boolean =>
	flags[name] === true || flags[name] === "true";

const selectedAdapter = (flags: Record<string, string | boolean>): QuickstartAdapter => {
	const raw = typeof flags.adapter === "string" ? flags.adapter : typeof flags.host === "string" ? flags.host : "pi";
	if (raw === "codex" || raw === "claude-code" || raw === "pi" || raw === "omp" || raw === "hermes" || raw === "opencode" || raw === "none") {
		return raw;
	}
	throw new Error("--adapter must be one of: codex, claude-code, pi, omp, hermes, opencode, none");
};

const installAdapter = async (input: {
	adapter: QuickstartAdapter;
	args: string[];
	paths: QuickstartCliPaths;
}): Promise<string> => {
	if (input.adapter === "none") {
		return "Skipped adapter install";
	}
	if (input.adapter === "hermes" || input.adapter === "opencode") return nativeHostFromCli(input.adapter, input.args);
	if (input.adapter === "codex") {
		return installCodexFromCli(input.args, input.paths.codexBridgeScriptPath, input.paths.codexHookScriptPath);
	}
	if (input.adapter === "claude-code") {
		return installClaudeCodeFromCli(input.args, input.paths.claudeCodeBridgeScriptPath, input.paths.claudeCodeHookScriptPath);
	}
	if (input.adapter === "omp") {
		return installOmpFromCli(input.args);
	}
	return installPiFromCli(input.args);
};

const formatQuickstart = (result: Record<string, unknown>): string => {
	const steps = Array.isArray(result.steps) ? (result.steps as QuickstartStep[]) : [];
	const lines = [
		"Crosshead quickstart",
		`home: ${result.home}`,
		`profile: ${result.profile}`,
		`adapter: ${result.adapter}`,
		...steps.map((step) => `${step.ok ? "ok" : "warn"} ${step.id}: ${step.detail}`),
		"first_value:",
		`  ${result.firstValueCommand}`,
		"billing:",
		`  ${result.billingCommand}`,
		"payment_boundary: agents may create/show checkout links or invoices, but a human submits payment.",
	];
	if (typeof result.checkoutUrl === "string" && result.checkoutUrl.length > 0) {
		lines.push(`checkout_url: ${result.checkoutUrl}`);
	}
	return lines.join("\n");
};

const canonicalScript = (scriptPath: string): string => {
	try {
		return realpathSync(scriptPath);
	} catch {
		return path.resolve(scriptPath);
	}
};

/**
 * Starts the daemon, or reuses a healthy one so quickstart for a second host
 * shares it. A daemon still running another release (for example after the
 * installer updated the runtime) is restarted on the installed release through
 * the ownership-checked stop/start path; if that is not safe, the mismatch is
 * reported instead. `--port` is honored on start and restart, and a running
 * daemon on another port is reported rather than silently kept.
 */
export const ensureQuickstartDaemon = async (input: {
	home?: string;
	daemonScriptPath: string;
	port?: string;
}): Promise<QuickstartStep> => {
	const requestedPort = input.port === undefined ? undefined : Number(input.port);
	if (requestedPort !== undefined && (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535)) {
		throw new Error("--port must be an integer between 0 and 65535");
	}
	const state = readDaemonOwnershipState(resolveRuntimePaths(input.home));
	const health = state ? await readRuntimeDaemonHealth(state) : null;
	if (!state || !health) {
		const started = await startDetachedRuntimeDaemon({ home: input.home, port: requestedPort, daemonScriptPath: input.daemonScriptPath });
		return { id: "daemon", ok: true, detail: `Started onlybotsd on port ${started.port}` };
	}
	const installed = canonicalScript(input.daemonScriptPath);
	const running = health.daemonScriptPath ? canonicalScript(health.daemonScriptPath) : null;
	if (running === installed) {
		if (requestedPort !== undefined && requestedPort !== 0 && requestedPort !== state.port) {
			return {
				id: "daemon",
				ok: false,
				detail: `onlybotsd already running on port ${state.port}; --port ${requestedPort} was not applied. Run crosshead stop, then crosshead start --port ${requestedPort}.`,
			};
		}
		return { id: "daemon", ok: true, detail: `onlybotsd already running on port ${state.port}` };
	}
	const runningLabel = running ?? "a release that predates release reporting";
	if (state.organizationalWorkerConfigPath) {
		return {
			id: "daemon",
			ok: false,
			detail: `onlybotsd on port ${state.port} runs ${runningLabel}, but ${installed} is installed. It hosts an organizational worker, which needs an explicit operator restart: run crosshead stop, then crosshead start.`,
		};
	}
	try {
		await stopDetachedRuntimeDaemon(input.home);
		const restarted = await startDetachedRuntimeDaemon({
			home: input.home,
			port: requestedPort ?? state.port ?? undefined,
			daemonScriptPath: input.daemonScriptPath,
		});
		return { id: "daemon", ok: true, detail: `Restarted onlybotsd on port ${restarted.port}: it was running ${runningLabel}; now ${installed}` };
	} catch (error) {
		return {
			id: "daemon",
			ok: false,
			detail: `onlybotsd on port ${state.port} runs ${runningLabel}, but ${installed} is installed, and it could not be restarted safely (${error instanceof Error ? error.message : String(error)}). Run crosshead stop, then crosshead start.`,
		};
	}
};

export const quickstartFromCli = async (argv: string[], paths: QuickstartCliPaths): Promise<string> => {
	const { flags } = parseArgs(argv);
	const home = typeof flags.home === "string" ? flags.home : undefined;
	const profileName = typeof flags.profile === "string" ? flags.profile : "default";
	const apiBase =
		typeof flags["api-base"] === "string" ? flags["api-base"] : typeof flags.apiBase === "string" ? flags.apiBase : undefined;
	const memoryMode = typeof flags["memory-mode"] === "string" ? flags["memory-mode"] : "assist";
	const workspaceScope = typeof flags["workspace-scope"] === "string" ? flags["workspace-scope"] : "repo";
	const adapter = selectedAdapter(flags);
	if (flags["dry-run"]) {
		const preview = { applied: false, scope: "legacy", adapter, profile: profileName,
			home: resolveRuntimePaths(home).home, workspaceRoot: typeof flags["workspace-root"] === "string" ? path.resolve(flags["workspace-root"]) : process.cwd(),
			memoryMode, workspaceScope };
		return flags.json ? JSON.stringify(preview, null, 2)
			: `Legacy setup preview for ${adapter}, profile ${profileName}, in ${preview.home}. Use --scope project to configure selected projects.`;
	}
	const coreArgs = [...flagPair("--home", home), ...flagPair("--channel", typeof flags.channel === "string" ? flags.channel : undefined)];
	const profileArgs = [
		...flagPair("--home", home),
		"--profile",
		profileName,
		...flagPair("--api-base", apiBase),
		"--memory-mode",
		memoryMode,
		"--workspace-scope",
		workspaceScope,
	];
	const adapterArgs = [
		...flagPair("--hermes-home", typeof flags["hermes-home"] === "string" ? flags["hermes-home"] : undefined),
		...flagPair("--hermes-bin", typeof flags["hermes-bin"] === "string" ? flags["hermes-bin"] : undefined),
		...flagPair("--opencode-home", typeof flags["opencode-home"] === "string" ? flags["opencode-home"] : undefined),
		...flagPair("--home", home),
		"--profile",
		profileName,
		...flagPair("--version", typeof flags.version === "string" ? flags.version : undefined),
		...flagPair("--codex-home", typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined),
		...flagPair("--codex-bin", typeof flags["codex-bin"] === "string" ? flags["codex-bin"] : undefined),
		...flagPair("--claude-home", typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined),
		...flagPair("--workspace-root", typeof flags["workspace-root"] === "string" ? flags["workspace-root"] : undefined),
		...flagPair("--claude-bin", typeof flags["claude-bin"] === "string" ? flags["claude-bin"] : undefined),
		...flagPair("--hook-mode", typeof flags["hook-mode"] === "string" ? flags["hook-mode"] : undefined),
		...flagPair("--omp-bin", typeof flags["omp-bin"] === "string" ? flags["omp-bin"] : undefined),
		...(boolFlagDisabled(flags, "no-envrc") ? ["--no-envrc"] : []),
	];
	const steps: QuickstartStep[] = [];

	const installOutput = await installCoreFromCli(coreArgs, paths.cliScriptPath, paths.daemonScriptPath);
	const runtimePaths = ensureRuntimeHomeLayout(home);
	steps.push({ id: "runtime_core", ok: true, detail: installOutput });

	const config = loadRuntimeConfig(runtimePaths);
	const existingProfile = loadProfile(runtimePaths, profileName);
	if (!existingProfile) {
		if (!apiBase) {
			throw new Error("quickstart requires --api-base <url> when the selected profile does not exist");
		}
		const profileOutput = await keygenFromCli([...profileArgs, "--setup", "--json"]);
		const parsed = JSON.parse(profileOutput) as { npub?: string; apiBase?: string };
		steps.push({
			id: "profile",
			ok: true,
			detail: `configured ${profileName} for ${parsed.apiBase ?? apiBase} with generated runtime identity ${parsed.npub ?? "unknown"}`,
		});
	} else {
		steps.push({
			id: "profile",
			ok: true,
			detail: `using existing ${profileName} for ${existingProfile.apiBase}`,
		});
	}

	const adapterOutput = await installAdapter({ adapter, args: adapterArgs, paths });
	steps.push({
		id: "adapter",
		ok: adapter !== "none",
		detail: adapter === "omp" ? `${adapterOutput}; OMP uses the Pi embedded adapter path` : adapterOutput,
	});

	if (!boolFlagDisabled(flags, "no-start")) {
		steps.push(
			await ensureQuickstartDaemon({
				home,
				daemonScriptPath: paths.daemonScriptPath,
				port: typeof flags.port === "string" ? flags.port : undefined,
			})
		);
	} else {
		steps.push({ id: "daemon", ok: false, detail: "skipped by --no-start" });
	}

	let runtimeStatus: Record<string, unknown> | null = null;
	try {
		runtimeStatus = JSON.parse(await statusFromCli([...flagPair("--home", home), "--profile", profileName, "--json"])) as Record<string, unknown>;
		const daemon = runtimeStatus.daemon && typeof runtimeStatus.daemon === "object" ? (runtimeStatus.daemon as Record<string, unknown>) : {};
		steps.push({
			id: "status",
			ok: true,
			detail: `daemon_running=${daemon.running === true} adapters=${Array.isArray(runtimeStatus.adapters) ? runtimeStatus.adapters.length : 0}`,
		});
	} catch (error) {
		steps.push({ id: "status", ok: false, detail: error instanceof Error ? error.message : String(error) });
	}

	let billingStatus: Record<string, unknown> | null = null;
	try {
		billingStatus = JSON.parse(
			await billingFromCli(["status", ...flagPair("--home", home), "--profile", profileName, "--json"])
		) as Record<string, unknown>;
		steps.push({
			id: "billing",
			ok: billingStatus.low_credit !== true,
			detail:
				billingStatus.low_credit === true
					? `billing reachable but available credits are low; run crosshead billing checkout --credits ${DEFAULT_CHECKOUT_CREDIT_UNITS}`
					: "billing reachable",
		});
	} catch (error) {
		steps.push({ id: "billing", ok: false, detail: error instanceof Error ? error.message : String(error) });
	}

	let checkout: Record<string, unknown> | null = null;
	if (boolFlagDisabled(flags, "create-checkout")) {
		const credits =
			typeof flags.credits === "string"
				? flags.credits
				: typeof flags["checkout-credits"] === "string"
					? flags["checkout-credits"]
					: String(DEFAULT_CHECKOUT_CREDIT_UNITS);
		checkout = JSON.parse(
			await billingFromCli(["checkout", ...flagPair("--home", home), "--profile", profileName, "--credits", credits, "--json"])
		) as Record<string, unknown>;
		steps.push({
			id: "checkout_link",
			ok: typeof checkout.url === "string" && checkout.url.length > 0,
			detail: "created hosted payment link; human payment submission still required",
		});
	}

	const result = {
		command: "quickstart",
		home: runtimePaths.home,
		coreVersion: config.coreVersion,
		profile: profileName,
		adapter,
		steps,
		status: runtimeStatus,
		billing: billingStatus,
		checkout,
		checkoutUrl: typeof checkout?.url === "string" ? checkout.url : null,
		firstValueCommand: `crosshead memory hot --home ${runtimePaths.home} --profile ${profileName}`,
		billingCommand: `crosshead billing status --home ${runtimePaths.home} --profile ${profileName}`,
		paymentBoundary: "Agents may create/show checkout links or invoices, but a human must submit payment.",
	};
	return flags.json ? JSON.stringify(result, null, 2) : formatQuickstart(result);
};

/** Only an argument-free invocation opts into the terminal onboarding wizard. */
export const shouldGuideQuickstart = (args: string[], terminal: boolean): boolean => terminal && args.length === 0;
