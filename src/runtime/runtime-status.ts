import { existsSync } from "fs";
import path from "path";
import { daemonOwnerIsLive, probeRuntimeDaemonHealth, readDaemonOwnershipState } from "./daemon-ownership";

import { HostedOnlyBotsClient, type HostedSession } from "./hosted-client";
import {
	readRuntimeDreamReviewHudSnapshot,
	readRuntimeInboxHudSnapshot,
} from "./lifecycle-engine";
import {
	inspectContinuityPolicy,
	type ContinuityPolicy,
	type ContinuityPolicyHostCapabilities,
	type ContinuityPolicyInspection,
	type ContinuityPolicySource,
} from "./continuity-policy";
import {
	buildContinuityGovernorState,
	continuityGovernorPatchAffectedRuleIds,
	type ContinuityGovernorMemoryScope,
	type ContinuityGovernorPatchRecord,
	type ContinuityGovernorState,
} from "./continuity-governor";
import { nowIso } from "./adapter-utils";
import {
	configFile,
	continuityGovernorFile,
	ensureRuntimeHomeLayout,
	lifecycleEventsFile,
	listAdapterRecords,
	loadAdapterSnapshot,
	loadContinuityGovernorFileState,
	loadContinuityPolicyState,
	loadCoreSnapshot,
	loadDaemonState,
	loadHealthState,
	loadProfile,
	loadRuntimeConfig,
	loadSecret,
	readJsonLines,
	secretFile,
	saveSecret,
	type RuntimePaths,
	RUNTIME_ADAPTER_NAMES,
} from "./runtime-persistence";
import type {
	RuntimeAdapterName,
	RuntimeAdapterRecord,
	RuntimeContinuityInspection,
	RuntimeDoctorCheck,
	RuntimeDoctorReport,
	RuntimeStatus,
} from "./local-runtime";

const isSessionFresh = (session: HostedSession | null): boolean => {
	if (!session) {
		return false;
	}
	const expiry = new Date(session.expiresAt);
	return !Number.isNaN(expiry.getTime()) && expiry.getTime() > Date.now() + 1_000;
};

const summarizeLifecycle = (paths: RuntimePaths): RuntimeStatus["lifecycle"] => {
	const events = readJsonLines<Record<string, unknown>>(lifecycleEventsFile(paths), 100);
	const lastEvent = events.length > 0 ? events[events.length - 1]! : null;
	const lastCompletedTurn =
		[...events]
			.reverse()
			.find((event) => event.type === "turn.completed" || event.type === "turn.failed") ?? null;

	return {
		lastEvent: lastEvent
			? {
					type: typeof lastEvent.type === "string" ? lastEvent.type : "unknown",
					sessionId: typeof lastEvent.sessionId === "string" ? lastEvent.sessionId : null,
					turnId: typeof lastEvent.turnId === "string" ? lastEvent.turnId : null,
					occurredAt: typeof lastEvent.occurredAt === "string" ? lastEvent.occurredAt : nowIso(),
					summary:
						lastEvent.payload && typeof lastEvent.payload === "object" && !Array.isArray(lastEvent.payload)
							? typeof (lastEvent.payload as Record<string, unknown>).summary === "string"
								? ((lastEvent.payload as Record<string, unknown>).summary as string)
								: typeof (lastEvent.payload as Record<string, unknown>).result === "string"
									? ((lastEvent.payload as Record<string, unknown>).result as string)
									: typeof (lastEvent.payload as Record<string, unknown>).goal === "string"
										? ((lastEvent.payload as Record<string, unknown>).goal as string)
										: null
							: null,
				}
			: null,
		lastCompletedTurn: lastCompletedTurn
			? {
					turnId: typeof lastCompletedTurn.turnId === "string" ? lastCompletedTurn.turnId : null,
					occurredAt: typeof lastCompletedTurn.occurredAt === "string" ? lastCompletedTurn.occurredAt : nowIso(),
					summary:
						lastCompletedTurn.payload && typeof lastCompletedTurn.payload === "object" && !Array.isArray(lastCompletedTurn.payload)
							? typeof (lastCompletedTurn.payload as Record<string, unknown>).summary === "string"
								? ((lastCompletedTurn.payload as Record<string, unknown>).summary as string)
								: typeof (lastCompletedTurn.payload as Record<string, unknown>).result === "string"
									? ((lastCompletedTurn.payload as Record<string, unknown>).result as string)
									: typeof (lastCompletedTurn.payload as Record<string, unknown>).goal === "string"
										? ((lastCompletedTurn.payload as Record<string, unknown>).goal as string)
										: null
							: null,
					status: lastCompletedTurn.type === "turn.failed" ? "failed" : "completed",
				}
			: null,
	};
};

export const evaluateAdapterAutomation = (adapter: RuntimeAdapterRecord): RuntimeDoctorCheck => {
	const managedFiles = new Set(adapter.managedFiles);
	const hasManagedFile = (predicate: (filePath: string) => boolean): boolean =>
		[...managedFiles].some((filePath) => predicate(filePath));
	const basename = (name: string) => (filePath: string): boolean => path.basename(filePath) === name;

	if (adapter.name === "codex") {
		const requirements = [
			{ label: "repo-local codex launcher", ok: hasManagedFile(basename("codex")) },
			{ label: "Codex hook wrapper", ok: (hasManagedFile(basename("crosshead-codex-hook")) || hasManagedFile(basename("onlybots-codex-hook"))) },
			{ label: "Codex hooks.json", ok: hasManagedFile((filePath) => path.basename(filePath) === "hooks.json") },
		];
		const missing = requirements.filter((entry) => !entry.ok).map((entry) => entry.label);
		return {
			id: "adapter_codex_automation",
			ok: adapter.status !== "failed" && missing.length === 0,
			message:
				adapter.status === "failed"
					? `Codex automatic integration is broken: ${adapter.lastError ?? "adapter attach failed"}.`
					: missing.length === 0
						? "Codex automatic integration is healthy through the repo-local launcher and managed hooks."
						: `Codex automatic integration is degraded; missing ${missing.join(", ")}.`,
		};
	}

	if (adapter.name === "claude-code") {
		const requirements = [
			{ label: "repo-local claude launcher", ok: hasManagedFile(basename("claude")) },
			{ label: "Claude hook wrapper", ok: (hasManagedFile(basename("crosshead-claude-code-hook")) || hasManagedFile(basename("onlybots-claude-code-hook"))) },
			{
				label: "project Claude settings hooks",
				ok: hasManagedFile((filePath) => path.basename(filePath) === "settings.json" && filePath.includes(`${path.sep}.claude${path.sep}`)),
			},
		];
		const missing = requirements.filter((entry) => !entry.ok).map((entry) => entry.label);
		return {
			id: "adapter_claude_code_automation",
			ok: adapter.status !== "failed" && missing.length === 0,
			message:
				adapter.status === "failed"
					? `Claude Code automatic integration is broken: ${adapter.lastError ?? "adapter attach failed"}.`
					: missing.length === 0
						? "Claude Code automatic integration is healthy through repo-local project hooks and the managed claude launcher."
						: `Claude Code automatic integration is degraded; missing ${missing.join(", ")}.`,
		};
	}

	if (adapter.name === "pi") {
		const installed = hasManagedFile((filePath) => path.basename(filePath) === "pi-adapter.json");
		return {
			id: "adapter_pi_automation",
			ok: adapter.status !== "failed" && installed,
			message:
				adapter.status === "failed"
					? `Pi automatic integration is broken: ${adapter.lastError ?? "adapter attach failed"}.`
					: installed
						? "Pi automatic integration is healthy through the embedded runtime binding."
						: "Pi automatic integration is degraded; embedded adapter config is missing.",
		};
	}

	return {
		id: `adapter_${adapter.name}_automation`,
		ok: adapter.status !== "failed",
		message:
			adapter.status === "failed"
				? `${adapter.name} integration is broken: ${adapter.lastError ?? "adapter attach failed"}.`
				: `${adapter.name} adapter is attached.`,
	};
};

const buildContinuityHostCapabilities = (adapter: RuntimeAdapterRecord): ContinuityPolicyHostCapabilities | null => {
	if (!RUNTIME_ADAPTER_NAMES.includes(adapter.name as RuntimeAdapterName)) {
		return null;
	}
	const automation = evaluateAdapterAutomation(adapter);
	if (adapter.name === "codex") {
		return {
			host: "codex",
			automationHealthy: automation.ok,
			runtimeControlsMemory: true,
			canEnforceTrustZones: false,
			canInterceptToolUse: false,
			canRestrictSelfModification: false,
			canRequireHumanReview: false,
			canEnforceBudgetCeilings: true,
		};
	}
	if (adapter.name === "claude-code") {
		return {
			host: "claude-code",
			automationHealthy: automation.ok,
			runtimeControlsMemory: true,
			canEnforceTrustZones: false,
			canInterceptToolUse: false,
			canRestrictSelfModification: false,
			canRequireHumanReview: false,
			canEnforceBudgetCeilings: true,
		};
	}
	return {
		host: "pi",
		automationHealthy: automation.ok,
		runtimeControlsMemory: true,
		canEnforceTrustZones: automation.ok,
		canInterceptToolUse: false,
		canRestrictSelfModification: false,
		canRequireHumanReview: false,
		canEnforceBudgetCeilings: true,
	};
};

const listContinuityHostCapabilities = (paths: RuntimePaths): ContinuityPolicyHostCapabilities[] =>
	listAdapterRecords(paths)
		.map((adapter) => buildContinuityHostCapabilities(adapter))
		.filter((entry): entry is ContinuityPolicyHostCapabilities => entry !== null);

const relevantContinuityConflictKeys = (
	inspection: ContinuityPolicyInspection,
	patch: ContinuityGovernorPatchRecord
): Set<string> => {
	const affectedRules = new Set(continuityGovernorPatchAffectedRuleIds(patch));
	if (affectedRules.size === 0) {
		return new Set();
	}
	return new Set(
		inspection.unresolvedConflicts
			.filter((conflict) => conflict.scope === "rule" && affectedRules.has(conflict.id as never))
			.map((conflict) => `${conflict.host}:${conflict.id}:${conflict.requested}:${conflict.effective}`)
	);
};

const annotateContinuityGovernorState = (input: {
	basePolicy: ContinuityPolicy;
	baseSource: ContinuityPolicySource;
	hostCapabilities: ContinuityPolicyHostCapabilities[];
	validationErrors: string[];
	governorState: ContinuityGovernorState;
}): ContinuityGovernorState => {
	const degradedPatchIds = new Set<string>();

	for (const [index, patch] of input.governorState.activePatches.entries()) {
		const priorPolicy =
			index === 0
				? input.basePolicy
				: buildContinuityGovernorState(input.basePolicy, input.governorState.activePatches.slice(0, index)).effectivePolicy;
		const nextPolicy = buildContinuityGovernorState(
			input.basePolicy,
			input.governorState.activePatches.slice(0, index + 1)
		).effectivePolicy;
		const priorInspection = inspectContinuityPolicy({
			source: input.baseSource,
			policy: priorPolicy,
			validationErrors: input.validationErrors,
			hosts: input.hostCapabilities,
		});
		const nextInspection = inspectContinuityPolicy({
			source: input.baseSource,
			policy: nextPolicy,
			validationErrors: input.validationErrors,
			hosts: input.hostCapabilities,
		});
		const priorKeys = relevantContinuityConflictKeys(priorInspection, patch);
		const nextKeys = relevantContinuityConflictKeys(nextInspection, patch);
		if ([...nextKeys].some((key) => !priorKeys.has(key))) {
			degradedPatchIds.add(patch.patchId);
		}
	}

	return {
		...input.governorState,
		activePatches: input.governorState.activePatches.map((patch) => ({
			...patch,
			degraded: degradedPatchIds.has(patch.patchId),
		})),
		patchHistory: input.governorState.patchHistory.map((patch) => ({
			...patch,
			degraded: patch.status === "active" ? degradedPatchIds.has(patch.patchId) : false,
		})),
	};
};

export const loadEffectiveContinuityGovernorState = (
	paths: RuntimePaths,
	policyState: { source: ContinuityPolicySource; policy: ContinuityPolicy; validationErrors: string[] } = loadContinuityPolicyState(paths)
): {
	baseSource: ContinuityPolicySource;
	basePolicy: ContinuityPolicy;
	baseValidationErrors: string[];
	governorValidationErrors: string[];
	governorState: ContinuityGovernorState;
	hostCapabilities: ContinuityPolicyHostCapabilities[];
} => {
	const governorFileState = loadContinuityGovernorFileState(paths);
	const hostCapabilities = listContinuityHostCapabilities(paths);
	const governorState = annotateContinuityGovernorState({
		basePolicy: policyState.policy,
		baseSource: policyState.source,
		hostCapabilities,
		validationErrors: [...policyState.validationErrors, ...governorFileState.validationErrors],
		governorState: buildContinuityGovernorState(policyState.policy, governorFileState.patchHistory),
	});

	return {
		baseSource: policyState.source,
		basePolicy: policyState.policy,
		baseValidationErrors: policyState.validationErrors,
		governorValidationErrors: governorFileState.validationErrors,
		governorState,
		hostCapabilities,
	};
};

export const buildContinuityInspection = (paths: RuntimePaths): RuntimeContinuityInspection => {
	const policyState = loadContinuityPolicyState(paths);
	const effective = loadEffectiveContinuityGovernorState(paths, policyState);
	const validationErrors = [...effective.baseValidationErrors, ...effective.governorValidationErrors];
	const baseInspection = inspectContinuityPolicy({
		source: effective.baseSource,
		policy: effective.basePolicy,
		validationErrors: effective.baseValidationErrors,
		hosts: effective.hostCapabilities,
	});
	const effectiveInspection = inspectContinuityPolicy({
		source: effective.baseSource,
		policy: effective.governorState.effectivePolicy,
		validationErrors,
		hosts: effective.hostCapabilities,
	});

	return {
		...effectiveInspection,
		effectiveSource: effective.governorState.activePatches.length > 0 ? "governor_patched" : "base_policy",
		base: {
			source: effective.baseSource,
			validationErrors: effective.baseValidationErrors,
			policy: effective.basePolicy,
			inspection: baseInspection,
		},
		governor: {
			...effective.governorState,
			file: continuityGovernorFile(paths),
			validationErrors: effective.governorValidationErrors,
		},
	};
};

export const applyGovernorMemoryScope = (
	payload: Record<string, unknown>,
	scope: ContinuityGovernorMemoryScope
): Record<string, unknown> => {
	const allowedScope =
		payload.allowedScope && typeof payload.allowedScope === "object" && !Array.isArray(payload.allowedScope)
			? (payload.allowedScope as Record<string, unknown>)
			: payload.allowed_scope && typeof payload.allowed_scope === "object" && !Array.isArray(payload.allowed_scope)
				? (payload.allowed_scope as Record<string, unknown>)
				: {};

	const include = (key: keyof ContinuityGovernorMemoryScope): boolean => {
		const requested = allowedScope[key];
		return (typeof requested === "boolean" ? requested : true) && scope[key];
	};

	return {
		...payload,
		allowedScope: {
			includeHotMemory: include("includeHotMemory"),
			includeWarmMemory: include("includeWarmMemory"),
			includeColdMemory: include("includeColdMemory"),
			includeLayeredContext: include("includeLayeredContext"),
		},
	};
};

const collectRuntimeIntegrityIssues = (paths: RuntimePaths): RuntimeStatus["integrity"]["issues"] => {
	const issues: RuntimeStatus["integrity"]["issues"] = [];
	const config = loadRuntimeConfig(paths);
	if (!loadCoreSnapshot(paths, config.coreVersion)) {
		issues.push({
			id: "core_snapshot_missing",
			severity: "warning",
			message: `Core snapshot for ${config.coreVersion} is missing.`,
		});
	}

	for (const adapter of listAdapterRecords(paths)) {
		const missingFiles = adapter.managedFiles.filter((filePath) => !existsSync(filePath));
		if (missingFiles.length > 0) {
			issues.push({
				id: `adapter_${adapter.name}_missing_files`,
				severity: "error",
				message: `${adapter.name} record references missing managed files: ${missingFiles.join(", ")}`,
			});
		}
		if (RUNTIME_ADAPTER_NAMES.includes(adapter.name as RuntimeAdapterName)) {
			const snapshot = loadAdapterSnapshot(paths, adapter.name as RuntimeAdapterName, adapter.version);
			if (!snapshot) {
				issues.push({
					id: `adapter_${adapter.name}_snapshot_missing`,
					severity: "warning",
					message: `${adapter.name} snapshot for ${adapter.version} is missing.`,
				});
				continue;
			}
			const snapshotFiles = [...snapshot.managedFiles].sort();
			const recordFiles = [...adapter.managedFiles].sort();
			if (JSON.stringify(snapshotFiles) !== JSON.stringify(recordFiles)) {
				issues.push({
					id: `adapter_${adapter.name}_metadata_drift`,
					severity: "error",
					message: `${adapter.name} managed file metadata drifted from the stored snapshot for ${adapter.version}.`,
				});
			}
			if (snapshot.runtimeVersion !== adapter.runtimeVersion) {
				issues.push({
					id: `adapter_${adapter.name}_runtime_version_drift`,
					severity: "error",
					message: `${adapter.name} runtime version ${adapter.runtimeVersion} disagrees with snapshot ${snapshot.runtimeVersion}.`,
				});
			}
		}
	}

	return issues;
};

export const buildRuntimeStatus = async (paths: RuntimePaths, profileName?: string): Promise<RuntimeStatus> => {
	const config = loadRuntimeConfig(paths);
	const daemon = readDaemonOwnershipState(paths) ?? loadDaemonState(paths);
	const health = loadHealthState(paths);
	const selectedProfileName = profileName ?? config.defaultProfile ?? null;
	const profile = selectedProfileName ? loadProfile(paths, selectedProfileName) : null;
	const secret = selectedProfileName ? loadSecret(paths, selectedProfileName) : null;
	const reachable = await probeRuntimeDaemonHealth(daemon);
	const lifecycle = summarizeLifecycle(paths);
	const inbox = selectedProfileName ? readRuntimeInboxHudSnapshot(paths.state, selectedProfileName) : null;
	const dreamReview = selectedProfileName ? readRuntimeDreamReviewHudSnapshot(paths.state, selectedProfileName) : null;
	const integrityIssues = collectRuntimeIntegrityIssues(paths);
	const continuity = buildContinuityInspection(paths);

	return {
		coreVersion: config.coreVersion,
		channel: config.channel,
		home: paths.home,
		defaultProfile: config.defaultProfile,
		daemon: {
			running: daemon.status === "running" && daemonOwnerIsLive(daemon),
			reachable,
			port: daemon.port,
			startedAt: daemon.startedAt,
			lastHeartbeat: daemon.lastHeartbeat,
			lastError: daemon.lastError,
		},
		profile: profile
			? {
					name: profile.name,
					npub: profile.npub,
					apiBase: profile.apiBase,
					memoryMode: profile.memoryMode,
					workspaceScope: profile.workspaceScope,
					authValid: isSessionFresh(secret?.session ?? null),
					authExpiresAt: secret?.session?.expiresAt ?? null,
					secureStoreMode: profile.secureStoreMode,
				}
			: null,
		adapters: listAdapterRecords(paths),
		queueDepth: health.queueDepth,
		pendingHotWrites: health.pendingHotWrites,
		pendingColdBatches: health.pendingColdBatches,
		retryingItems: health.retryingItems,
		backpressure: health.backpressure,
		lastSuccessfulSyncAt: health.lastSuccessfulSyncAt,
		lastError: health.lastError,
		lifecycle,
		inbox,
		dreamReview,
		integrity: {
			ok: integrityIssues.every((issue) => issue.severity !== "error"),
			issues: integrityIssues,
		},
		continuity,
	};
};

export const buildDoctorReport = async (paths: RuntimePaths, profileName?: string): Promise<RuntimeDoctorReport> => {
	const status = await buildRuntimeStatus(paths, profileName);
	const checks: RuntimeDoctorCheck[] = [];
	checks.push({
		id: "config",
		ok: true,
		message: `Runtime config loaded from ${configFile(paths)}`,
	});
	checks.push({
		id: "wrappers",
		ok: existsSync(path.join(paths.bin, "onlybotsctl")) && existsSync(path.join(paths.bin, "onlybotsd")),
		message: "Managed wrapper scripts are installed under the active runtime home’s bin directory",
	});
	checks.push({
		id: "secure_store",
		ok: status.profile !== null ? existsSync(secretFile(paths, status.profile.name)) : true,
		message: status.profile ? "Profile secrets are stored in the file-based secure store." : "No profile configured yet.",
	});

	if (status.profile) {
		const secret = loadSecret(paths, status.profile.name);
		const hosted = new HostedOnlyBotsClient({
			apiBase: status.profile.apiBase,
			npub: status.profile.npub,
			nsec: secret?.nsec ?? "",
			session: secret?.session ?? null,
		});
		const apiReachable = await hosted.ping().catch(() => false);
		checks.push({
			id: "api_base",
			ok: apiReachable,
			message: apiReachable ? "Hosted API base is reachable." : "Hosted API base is unreachable; runtime is degraded.",
		});

		let authValid = false;
		if (secret) {
			try {
				const session = await hosted.ensureSession();
				saveSecret(paths, status.profile.name, {
					nsec: secret.nsec,
					session,
				});
				authValid = isSessionFresh(session);
			} catch {
				authValid = false;
			}
		}
		checks.push({
			id: "auth",
			ok: authValid,
			message: authValid ? "Hosted auth session is valid." : "Hosted auth session is missing or expired.",
		});
	}

	checks.push({
		id: "daemon",
		ok: status.daemon.running && status.daemon.reachable,
		message:
			status.daemon.running && status.daemon.reachable
				? "Local daemon is reachable."
				: "Local daemon is not running or not reachable.",
	});
	checks.push({
		id: "queue",
		ok: !status.backpressure,
		message: status.backpressure
			? `Local queue is under backpressure with ${status.queueDepth} pending items.`
			: `Local queue is healthy with ${status.queueDepth} pending items.`,
	});
	checks.push({
		id: "integrity",
		ok: status.integrity.ok,
		message:
			status.integrity.issues.length === 0
				? "Runtime metadata and managed files are consistent."
				: status.integrity.issues.map((issue) => issue.message).join(" | "),
	});
	checks.push({
		id: "continuity_policy",
		ok: !status.continuity.degraded,
		message:
			status.continuity.validationErrors.length > 0
				? status.continuity.validationErrors.join(" | ")
				: status.continuity.unresolvedConflicts.length === 0
					? "Continuity policy is consistent with runtime authority defaults and active host enforcement."
					: status.continuity.unresolvedConflicts
							.map((conflict) => `${conflict.host}:${conflict.id} requested=${conflict.requested} effective=${conflict.effective}`)
							.join(" | "),
	});

	const adapterChecks = status.adapters.map((adapter) => evaluateAdapterAutomation(adapter));
	checks.push(...adapterChecks);

	return {
		ok: checks.every((check) => check.ok),
		checks,
	};
};

export const buildRuntimeStatusDirect = async (home?: string, profileName?: string): Promise<RuntimeStatus> =>
	buildRuntimeStatus(ensureRuntimeHomeLayout(home), profileName);

export const buildRuntimeDoctorDirect = async (home?: string, profileName?: string): Promise<RuntimeDoctorReport> =>
	buildDoctorReport(ensureRuntimeHomeLayout(home), profileName);
