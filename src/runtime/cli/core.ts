import { OnlyBotsLocalRuntimeDaemon, RuntimeAdapterName, RuntimeChannel, RuntimeMemoryMode, SetupRuntimeProfileOptions, applyRuntimeManifest, buildRuntimeDoctorDirect, buildRuntimeStatusDirect, checkForRuntimeUpdates, describeVersionDelta, formatRuntimeActivity, formatRuntimeDoctor, formatRuntimeReleaseUpdate, formatRuntimeStatus, formatRuntimeUpdateCheck, generateRuntimeIdentity, installRuntimeCore, parseArgs, readRuntimeLogs, resolveAdapterTargetVersion, rollbackRuntimeAdapterVersion, rollbackRuntimeCoreVersion, setupRuntimeProfile, startDetachedRuntimeDaemon, stopDetachedRuntimeDaemon, uninstallRuntimeCore, updateManagedRuntimeRelease, updateRuntimeAdapterVersion, updateRuntimeCatalogInstall } from "../local-runtime";
import path from "path";
import { RUNTIME_ADAPTER_NAMES, ensureRuntimeHomeLayout, loadAdapterRecord, loadRuntimeConfig, resolveRuntimeHome } from "../runtime-persistence";
import { billingFromCli } from "./billing";
import { maintainRuntimeBeforeLaunch, runtimeUpdatePolicy } from "../runtime-auto-update";
import { DEFAULT_CHECKOUT_CREDIT_UNITS } from "../billing-remediation";

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
	if (flags.pin || flags.auto || flags.policy) {
		if (flags.pin && flags.auto) throw new Error("Choose --pin or --auto");
		return JSON.stringify(runtimeUpdatePolicy(home, flags.pin ? "pinned" : flags.auto ? "auto" : undefined), null, 2);
	}
	const paths = ensureRuntimeHomeLayout(home);
	const config = loadRuntimeConfig(paths);
	const channel = typeof flags.channel === "string" ? (flags.channel as RuntimeChannel) : config.channel;
	const versionOverride = typeof flags.version === "string" ? flags.version : undefined;
	const target = positionals[0];

	if (target && RUNTIME_ADAPTER_NAMES.includes(target as RuntimeAdapterName)) {
		const adapterName = target as RuntimeAdapterName;
		const adapter = loadAdapterRecord(paths, adapterName);
		const targetVersion = resolveAdapterTargetVersion(adapterName, channel, versionOverride);
		await updateRuntimeAdapterVersion(paths.home, adapterName, targetVersion);
		return [
			`Updated ${adapterName}`,
			`channel: ${channel}`,
			`version: ${describeVersionDelta(adapter?.version ?? "absent", targetVersion)}`,
		].join("\n");
	}

	if (typeof flags["base-url"] === "string" || typeof flags.baseUrl === "string" || (!versionOverride && typeof flags.channel !== "string")) {
		const result = await updateManagedRuntimeRelease(paths.home, {
			baseUrl: typeof flags["base-url"] === "string" ? flags["base-url"] : typeof flags.baseUrl === "string" ? flags.baseUrl : undefined,
			trustedSha256: typeof flags.sha256 === "string" ? flags.sha256 : undefined,
			restart: !flags["no-restart"],
		});
		if (runtimeUpdatePolicy(paths.home).mode === "pinned") runtimeUpdatePolicy(paths.home, "pinned");
		return formatRuntimeReleaseUpdate(result);
	}

	const updated = await updateRuntimeCatalogInstall(paths.home, channel, versionOverride);
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
	if (target && RUNTIME_ADAPTER_NAMES.includes(target as RuntimeAdapterName)) {
		await rollbackRuntimeAdapterVersion(resolveRuntimeHome(home), target as RuntimeAdapterName, targetVersion);
		return `Rolled back ${target} to ${targetVersion}`;
	}
	await rollbackRuntimeCoreVersion(resolveRuntimeHome(home), targetVersion);
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
	makeDefault: true,
});

export const setupProfileFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const profile = await setupRuntimeProfile({
		...parseSetupCliOptions(flags),
		npub: String(flags.npub ?? ""),
		nsec: String(flags.nsec ?? ""),
	});
	return `Configured runtime profile ${profile.name} for ${profile.npub}`;
};

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
	const report = await buildRuntimeDoctorDirect(
		typeof flags.home === "string" ? flags.home : undefined,
		typeof flags.profile === "string" ? flags.profile : undefined
	);
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
