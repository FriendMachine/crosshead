import { OnlyBotsLocalRuntimeDaemon, RuntimeAdapterName, RuntimeChannel, RuntimeMemoryMode, SetupRuntimeProfileOptions, applyRuntimeManifest, buildRuntimeDoctorDirect, buildRuntimeStatusDirect, checkForRuntimeUpdates, describeVersionDelta, formatRuntimeActivity, formatRuntimeDoctor, formatRuntimeReleaseUpdate, formatRuntimeStatus, formatRuntimeUpdateCheck, generateRuntimeIdentity, installRuntimeCore, parseArgs, readRuntimeLogs, resolveAdapterTargetVersion, rollbackRuntimeAdapterVersion, rollbackRuntimeCoreVersion, setupRuntimeProfile, startDetachedRuntimeDaemon, stopDetachedRuntimeDaemon, uninstallRuntimeCore, adoptUnpackedRuntimeRelease, updateManagedRuntimeRelease, updateRuntimeAdapterVersion, updateRuntimeCatalogInstall } from "../local-runtime";
import path from "path";
import { RUNTIME_ADAPTER_NAMES, ensureRuntimeHomeLayout, loadAdapterRecord, loadRuntimeConfig, resolveRuntimeHome } from "../runtime-persistence";
import { billingFromCli } from "./billing";
import { assertNoLiveRuntimeHosts, maintainRuntimeBeforeLaunch, maintainRuntimeWhenIdle, runtimeUpdatePolicy, withRuntimeUpdateLock } from "../runtime-auto-update";
import { DEFAULT_CHECKOUT_CREDIT_UNITS } from "../billing-remediation";
import { inspectHostHookRegistrations } from "../host-hook-doctor";
import { inspectWorkspaceHooks, workspaceBindingStatus } from "../workspace-hooks";

export const installCoreFromCli = async (argv: string[], cliScriptPath: string, daemonScriptPath: string): Promise<string> => {
	const { flags } = parseArgs(argv);
	const paths = await installRuntimeCore({
		home: typeof flags.home === "string" ? flags.home : undefined,
		channel: typeof flags.channel === "string" ? (flags.channel as RuntimeChannel) : undefined,
		writeWrappers: true,
		cliScriptPath,
		daemonScriptPath,
	});
	return `Installed Crosshead runtime core in ${paths.home}`;
};

export const checkUpdatesFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const result = await checkForRuntimeUpdates(
		typeof flags.home === "string" ? flags.home : undefined,
		typeof flags.channel === "string" ? (flags.channel as RuntimeChannel) : undefined
	);
	return flags.json ? JSON.stringify(result, null, 2) : formatRuntimeUpdateCheck(result);
};

export const applyFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const result = await applyRuntimeManifest(
		typeof flags.home === "string" ? flags.home : undefined,
		typeof flags.manifest === "string" ? flags.manifest : undefined
	);
	return [
		`Applied runtime manifest ${result.manifestPath}`,
		`channel: ${result.channel}`,
		`core: ${result.coreVersion}`,
		`adapters: ${
			Object.keys(result.adapters).length === 0
				? "none"
				: Object.entries(result.adapters)
						.map(([name, version]) => `${name}@${version}`)
						.join(", ")
		}`,
		`profile: ${result.profileName ?? "none"}`,
	].join("\n");
};

export const updateFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const home = typeof flags.home === "string" ? flags.home : undefined;
	if (flags["check-on-launch"]) return maintainRuntimeBeforeLaunch(home, Number(flags["host-pid"]));
	if (flags["check-idle"]) return maintainRuntimeWhenIdle(home);
	if (flags["adopt-unpacked"] !== undefined) {
		// The install script runs this over an existing installation. Running the
		// script is an explicit request, so open host sessions do not block it.
		const releaseId = flags["adopt-unpacked"];
		if (typeof releaseId !== "string") throw new Error("--adopt-unpacked requires a release ID");
		return formatRuntimeReleaseUpdate(await withRuntimeUpdateLock(home, async () => {
			// Read the policy first: an unreadable one must fail before anything changes.
			const manual = runtimeUpdatePolicy(home).mode === "manual";
			const adopted = await adoptUnpackedRuntimeRelease(home, releaseId, {
				restart: !flags["no-restart"],
				baseUrl: typeof flags["base-url"] === "string" ? flags["base-url"] : undefined,
			});
			if (manual) runtimeUpdatePolicy(home, "manual");
			return adopted;
		}));
	}
	if (flags.manual || flags.pin || flags.auto || flags.policy) {
		if (flags.auto && (flags.manual || flags.pin)) throw new Error("Choose --auto or --manual");
		const mode = flags.manual || flags.pin ? "manual" : flags.auto ? "auto" : undefined;
		const policy = mode ? await withRuntimeUpdateLock(home, () => runtimeUpdatePolicy(home, mode)) : runtimeUpdatePolicy(home);
		return JSON.stringify(policy, null, 2);
	}
	const paths = ensureRuntimeHomeLayout(home);
	const config = loadRuntimeConfig(paths);
	const channel = typeof flags.channel === "string" ? (flags.channel as RuntimeChannel) : config.channel;
	const versionOverride = typeof flags.version === "string" ? flags.version : undefined;
	const target = positionals[0];
	const mutate = <T>(action: () => Promise<T>): Promise<T> => withRuntimeUpdateLock(paths.home, () => {
		assertNoLiveRuntimeHosts(paths.home, flags.force === true);
		return action();
	});

	if (target && RUNTIME_ADAPTER_NAMES.includes(target as RuntimeAdapterName)) {
		const adapterName = target as RuntimeAdapterName;
		const adapter = loadAdapterRecord(paths, adapterName);
		const targetVersion = resolveAdapterTargetVersion(adapterName, channel, versionOverride);
		await mutate(() => updateRuntimeAdapterVersion(paths.home, adapterName, targetVersion));
		return [
			`Updated ${adapterName}`,
			`channel: ${channel}`,
			`version: ${describeVersionDelta(adapter?.version ?? "absent", targetVersion)}`,
		].join("\n");
	}

	if (typeof flags["base-url"] === "string" || typeof flags.baseUrl === "string" || (!versionOverride && typeof flags.channel !== "string")) {
		const result = await mutate(async () => {
			const updated = await updateManagedRuntimeRelease(paths.home, {
				baseUrl: typeof flags["base-url"] === "string" ? flags["base-url"] : typeof flags.baseUrl === "string" ? flags.baseUrl : undefined,
				trustedSha256: typeof flags.sha256 === "string" ? flags.sha256 : undefined,
				restart: !flags["no-restart"],
				beforeApply: () => assertNoLiveRuntimeHosts(paths.home, flags.force === true),
			});
			if (runtimeUpdatePolicy(paths.home).mode === "manual") runtimeUpdatePolicy(paths.home, "manual");
			return updated;
		});
		return formatRuntimeReleaseUpdate(result);
	}

	const updated = await mutate(() => updateRuntimeCatalogInstall(paths.home, channel, versionOverride));
	return [
		"Updated runtime install metadata",
		`channel: ${channel}`,
		`core: ${describeVersionDelta(config.coreVersion, updated.coreVersion)}`,
		`adapters: ${
			updated.adapters.length === 0 ? "none installed" : updated.adapters.map((adapter) => `${adapter.name}@${adapter.version}`).join(", ")
		}`,
	].join("\n");
};

export const rollbackFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const home = typeof flags.home === "string" ? flags.home : undefined;
	const targetVersion = typeof flags.to === "string" ? flags.to : undefined;
	if (!targetVersion) {
		throw new Error("rollback requires --to <version>");
	}
	const target = positionals[0];
	const runtimeHome = resolveRuntimeHome(home);
	const mutate = <T>(action: () => Promise<T>): Promise<T> => withRuntimeUpdateLock(runtimeHome, () => {
		assertNoLiveRuntimeHosts(runtimeHome, flags.force === true);
		return action();
	});
	if (target && RUNTIME_ADAPTER_NAMES.includes(target as RuntimeAdapterName)) {
		await mutate(() => rollbackRuntimeAdapterVersion(runtimeHome, target as RuntimeAdapterName, targetVersion));
		return `Rolled back ${target} to ${targetVersion}`;
	}
	await mutate(() => rollbackRuntimeCoreVersion(runtimeHome, targetVersion));
	return `Rolled back runtime core to ${targetVersion}`;
};

const parseSetupCliOptions = (
	flags: Record<string, string | boolean>
): Omit<SetupRuntimeProfileOptions, "npub" | "nsec"> => ({
	home: typeof flags.home === "string" ? flags.home : undefined,
	profileName: String(flags.profile ?? "default"),
	apiBase: String(flags["api-base"] ?? flags.apiBase ?? ""),
	memoryMode: (flags["memory-mode"] as RuntimeMemoryMode | undefined) ?? "assist",
	workspaceScope: (flags["workspace-scope"] as "repo" | "workspace" | "global" | undefined) ?? "repo",
	makeDefault: flags["no-default"] !== true,
	createOnly: flags["create-only"] === true,
});

export const setupProfileFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const profile = await setupRuntimeProfile({
		...parseSetupCliOptions(flags),
		npub: String(flags.npub ?? ""),
		nsec: String(flags.nsec ?? ""),
	});
	if (flags.json) {
		return JSON.stringify({
			profile: profile.name, npub: profile.npub, apiBase: profile.apiBase, memoryMode: profile.memoryMode,
			...(profile.registrationDeferred ? { registrationDeferred: true, registrationDeferredReason: profile.registrationDeferredReason ?? null } : {}),
		}, null, 2);
	}
	return [`Configured runtime profile ${profile.name} for ${profile.npub}`, ...registrationDeferredLines(profile)].join("\n");
};

export const registrationDeferredLines = (profile: { apiBase: string; registrationDeferred?: boolean; registrationDeferredReason?: string }): string[] =>
	profile.registrationDeferred
		? [`registration: deferred; ${profile.apiBase} could not be reached${profile.registrationDeferredReason ? ` (${profile.registrationDeferredReason})` : ""}. Local capture and recall work now, and the profile signs in on its first successful request; crosshead doctor shows whether it has.`]
		: [];

export const keygenFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const identity = generateRuntimeIdentity();
	if (!flags.setup) {
		return flags.json
			? JSON.stringify(identity, null, 2)
			: [`Generated Nostr identity`, `npub: ${identity.npub}`, `nsec: ${identity.nsec}`].join("\n");
	}

	const setupOptions = parseSetupCliOptions(flags);
	if (!setupOptions.apiBase) {
		throw new Error("keygen --setup requires --api-base <url>");
	}

	const profile = await setupRuntimeProfile({
		...setupOptions,
		npub: identity.npub,
		nsec: identity.nsec,
	});
	const result = {
		generatedIdentity: true,
		profile: profile.name,
		npub: profile.npub,
		apiBase: profile.apiBase,
		memoryMode: profile.memoryMode,
		workspaceScope: profile.workspaceScope,
		secureStoreMode: profile.secureStoreMode,
		...(profile.registrationDeferred ? { registrationDeferred: true, registrationDeferredReason: profile.registrationDeferredReason ?? null } : {}),
	};
	return flags.json
		? JSON.stringify(result, null, 2)
		: [
		`Configured runtime profile ${profile.name} with a generated Nostr identity`,
		`npub: ${profile.npub}`,
		`api_base: ${profile.apiBase}`,
		`memory_mode: ${profile.memoryMode}`,
		`workspace_scope: ${profile.workspaceScope}`,
		`secure_store: ${profile.secureStoreMode}`,
		...registrationDeferredLines(profile),
			].join("\n");
};

export const statusFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const status = await buildRuntimeStatusDirect(
		typeof flags.home === "string" ? flags.home : undefined,
		typeof flags.profile === "string" ? flags.profile : undefined
	);
	if (flags.billing || flags["include-billing"]) {
		const billing = JSON.parse(
			await billingFromCli([
				"status",
				...(typeof flags.home === "string" ? ["--home", flags.home] : []),
				...(typeof flags.profile === "string" ? ["--profile", flags.profile] : []),
				"--json",
			])
		);
		return flags.json
			? JSON.stringify({ ...status, billing }, null, 2)
			: `${formatRuntimeStatus(status)}\nbilling: available=${billing.available_credits} service_credits pending=${billing.pending_credits}${
					billing.low_credit
						? `\nbilling_warning: low credits; run crosshead billing checkout --credits ${DEFAULT_CHECKOUT_CREDIT_UNITS}`
						: ""
				}`;
	}
	return flags.json ? JSON.stringify(status, null, 2) : formatRuntimeStatus(status);
};

export const doctorFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const home = typeof flags.home === "string" ? flags.home : undefined;
	const daemonReport = await buildRuntimeDoctorDirect(home, typeof flags.profile === "string" ? flags.profile : undefined);
	// Inside a Claude Code session, CLAUDE_PROJECT_DIR is the project whose settings it loaded.
	const workspaceRoot =
		typeof flags["workspace-root"] === "string" ? flags["workspace-root"] : process.env.CLAUDE_PROJECT_DIR || process.cwd();
	const workspaceHooks = inspectWorkspaceHooks(home, workspaceRoot);
	const hookChecks = workspaceHooks.error || workspaceHooks.workspaceError
		? [{ id: "workspace_hooks", ok: false, message: [workspaceHooks.error, workspaceHooks.workspaceError].filter(Boolean).join("; ") }]
		: workspaceHooks.scope === "legacy"
		? inspectHostHookRegistrations(home, workspaceRoot)
		: workspaceHooks.bindings.length
			? workspaceHooks.bindings.map((binding) => ({
				id: `${binding.host.replace("-", "_")}_hooks`,
				ok: binding.configured && binding.memoryMode !== null,
				message: `profile=${binding.profile}; ${workspaceBindingStatus(binding, workspaceHooks.workspace)}. ${binding.file}`,
			}))
			: [{ id: "workspace_hooks", ok: true, message: "No automatic Crosshead hooks apply in this directory." }];
	const checks = [...daemonReport.checks, ...hookChecks];
	const report = { ...daemonReport, ok: checks.every((check) => check.ok), checks, workspaceHooks };
	return flags.json ? JSON.stringify(report, null, 2) : formatRuntimeDoctor(report);
};

export const logsFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const lines = readRuntimeLogs(
		typeof flags.home === "string" ? flags.home : undefined,
		typeof flags.lines === "string" ? Number(flags.lines) : 50
	);
	return lines.join("\n");
};

export const eventsFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
	const activity = await daemon.readActivity(typeof flags.lines === "string" ? Number(flags.lines) : 50);
	return flags.json ? JSON.stringify(activity, null, 2) : formatRuntimeActivity(activity);
};

export const startFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const workerConfigFlag = flags["organizational-worker-config"];
	if (
		workerConfigFlag !== undefined &&
		(typeof workerConfigFlag !== "string" ||
			workerConfigFlag.length === 0 ||
			!path.isAbsolute(workerConfigFlag))
	) {
		throw new Error("--organizational-worker-config requires an absolute path");
	}
	const state = await startDetachedRuntimeDaemon({
		home: typeof flags.home === "string" ? flags.home : undefined,
		port: typeof flags.port === "string" ? Number(flags.port) : undefined,
		organizationalWorkerConfigPath: workerConfigFlag
			? path.resolve(workerConfigFlag as string)
			: undefined,
	});
	return `Started onlybotsd on port ${state.port}`;
};

export const stopFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	await stopDetachedRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
	return "Stopped onlybotsd";
};

export const uninstallFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	await uninstallRuntimeCore(typeof flags.home === "string" ? flags.home : undefined);
	return "Uninstalled Crosshead runtime core";
};
