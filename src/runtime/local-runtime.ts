import { getHotSyncManager, hotSyncEnabled, stopHotSyncManagers } from "./hot-sync-manager";
import { shellQuote, writeManagedFile } from "./adapter-utils";
import { renderAgentMarkText } from "../protocol/agent-mark";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	lstatSync,
	readFileSync,
	realpathSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { createServer, IncomingMessage, Server as HttpServer, ServerResponse } from "http";
import os from "os";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { spawn } from "child_process";
import { schnorr } from "@noble/curves/secp256k1";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import * as tar from "tar";

import { OperatorRuntimePolicyBroker, type OperatorWorkspaceManifest } from "./operator-policy";
import { HOSTED_PI_CONTROLLER_ADAPTER, HOSTED_PI_CONTROLLER_MANIFEST, hostedControllerProcessIsLive, type HostedControllerProcess } from "./hosted-pi-controller-manifest";
import { acquireRuntimeDaemonOwnership, daemonOwnerIsLive, probeRuntimeDaemonHealth, readDaemonOwnershipState, type RuntimeDaemonOwnership } from "./daemon-ownership";
import { HostedOnlyBotsClient, type HostedSession } from "./hosted-client";
import { isLocalOnlyRuntimeProfile, readLocalHotMemory } from "./local-hot-memory";
import {
	RuntimeLifecycleManager,
	type RuntimeLifecycleActivity,
	type RuntimeDreamReviewHudState,
	type RuntimeLifecycleEventRequest,
	type RuntimeLifecycleEventResponse,
	type RuntimeLifecycleHealthState,
	type RuntimeInboxHudState,
	updateRuntimeDreamReviewHudSnapshotFromInspection,
} from "./lifecycle-engine";
import {
	CONTINUITY_POLICY_SCHEMA_VERSION,
	buildDefaultContinuityPolicy,
	resolveContinuityPolicy,
	type ContinuityPolicy,
	type ContinuityPolicyInspection,
	type ContinuityPolicySource,
} from "./continuity-policy";
import {
	applyContinuityGovernorPatch as applyGovernorPatchMutation,
	removeContinuityGovernorPatch as removeGovernorPatchMutation,
	resolveContinuityGovernorPatchHistory,
	type ContinuityGovernorPatchRecord,
	type ContinuityGovernorState,
} from "./continuity-governor";
import {
	compilePassport,
	explainPassportRouting,
	formatPassportCompileResult,
	formatPassportImportResult,
	formatPassportRoutingExplanation,
	formatPassportVerifyResult,
	importPassportFromHost,
	verifyPassportCompilation,
} from "./passport-compiler";
import { mintTrustReceiptFromHandoffRecord } from "./trust-routing";
import {
	createSignedHandoffCapsule,
	inspectHandoffCapsule,
	verifyHandoffCapsule,
	type HandoffStoredRecord,
} from "./handoff-capsules";
import type { WarmMemoryEvaluationReport } from "../protocol/warm-memory-curation";
import type { CollaborationContextTrustZone } from "../protocol/collaboration";
import {
	AGENT_PASSPORT_SCHEMA_VERSION,
	buildDraftAgentPassport,
	PASSPORT_RUNTIME_HOSTS,
	PASSPORT_TRUST_ZONE_IDS,
	type AgentPassport,
	type PassportRuntimeHost,
	type PassportTrustZoneId,
	validateAgentPassport,
} from "../protocol/passports";
import type {
	LineageLink,
	PersistentAgentEntity,
	PersistentAgentInheritanceBoundary,
	TrustCarryoverMode,
} from "../protocol/persistent-agents";
import {
	buildPersistentAgentInspection,
	forkPersistentAgent,
	materializePersistentAgentEntity,
	inspectPersistentAgentLineage,
	type PersistentAgentInspection,
	type PersistentAgentLineageInspection,
	type RuntimePersistentAgentAdapter,
	type RuntimePersistentAgentProfile,
} from "./persistent-agent-fork";
import { buildEngineAttachment, type EngineAttachment } from "../protocol/engine-attachments";
import { HOT_SCOPE_ALL } from "../protocol/memory";
import {
	PUBLIC_DISCOVERY_AVAILABILITY_STATUSES,
	PUBLIC_DISCOVERY_EVENT_TYPES,
	PUBLIC_DISCOVERY_TASK_CLAIM_STATES,
	buildPublicDiscoveryRelayDraft,
	type PublicDiscoveryEvent,
} from "../protocol/public-discovery";
import { normalizePersistentAgentId, sanitizePersistentAgentToken } from "./persistent-agent-utils";
import { resolveOnlyBotsHome } from "./runtime-env";
import {
	adapterFile,
	adapterSnapshotDir,
	adapterSnapshotFile,
	continuityGovernorFile,
	continuityPolicyFile,
	coreSnapshotFile,
	daemonFile,
	ensureRuntimeHomeLayout,
	resolveRuntimePaths,
	healthFile,
	listAdapterRecords,
	listPersistentAgentEntities,
	listPersistentAgentInheritanceBoundaries,
	listPersistentAgentLineageLinks,
	loadAdapterRecord,
	loadAdapterSnapshot,
	loadContinuityGovernorFileState,
	loadContinuityPolicyState,
	loadCoreSnapshot,
	loadDaemonState,
	loadHealthState,
	loadPersistentAgentEntity,
	loadPersistentAgentPassport,
	loadProfile,
	loadRuntimeConfig,
	loadSecret,
	logFile,
	parseJsonFile,
	persistentAgentBoundaryFile,
	persistentAgentEntityFile,
	persistentAgentLineageFile,
	persistentAgentPassportFile,
	profileFile,
	RUNTIME_INSTALL_MARKER_VERSION,
	removeRuntimeAdapterRecord,
	resolveRuntimeHome,
	runtimeInstallMarkerFile,
	safeJson,
	sanitizeLogValue,
	saveAdapterRecord,
	saveAdapterSnapshot,
	saveContinuityGovernorPatchHistory,
	saveContinuityPolicy,
	saveCoreSnapshot,
	saveDaemonState,
	saveHealthState,
	savePersistentAgentEntity,
	savePersistentAgentInheritanceBoundary,
	savePersistentAgentLineageLink,
	savePersistentAgentPassport,
	saveProfile,
	saveRuntimeConfig,
	saveSecret,
	tailFileLines,
	upsertRuntimeAdapterRecord,
	writeJsonFile,
	writeRuntimeInstallMarker,
	writeRuntimeLog,
} from "./runtime-persistence";
import { nowIso } from "./adapter-utils";
import {
	cloneOrganizationalWorkerReadiness,
	normalizeOrganizationalWorkerReadiness,
	organizationalWorkerCapabilityNames,
	OrganizationalWorkerCapabilityUnavailableError,
	type OrganizationalWorkerCapability,
	type OrganizationalWorkerCapabilities,
	type OrganizationalWorkerReadiness,
} from "./organizational-worker-readiness";
import { isConstructedOrganizationalWorkerLocalApi } from "./organizational-worker-brand";
import type {
	OrganizationalWorkerFederationStatusObserver,
	OrganizationalWorkerFederationStatusRequest,
} from "./organizational-worker-federation-protocol";
export {
	ensureRuntimeHomeLayout,
	ONLYBOTS_RUNTIME_CORE_VERSION,
	removeRuntimeAdapterRecord,
	resolveRuntimeHome,
	upsertRuntimeAdapterRecord,
} from "./runtime-persistence";
import { isSessionWriteStale, ONLYBOTS_RUNTIME_CORE_VERSION, RUNTIME_ADAPTER_NAMES } from "./runtime-persistence";
import { handleRuntimeDaemonRequest } from "./runtime-http";
import {
	applyGovernorMemoryScope,
	buildContinuityInspection,
	buildDoctorReport,
	buildRuntimeStatus,
	loadEffectiveContinuityGovernorState,
} from "./runtime-status";
import type { RuntimePaths } from "./runtime-persistence";
export type { RuntimePaths } from "./runtime-persistence";


export type RuntimeMemoryMode = "off" | "manual" | "assist" | "auto";
export type RuntimeChannel = "stable" | "beta" | "canary";

export type RuntimeProfile = {
	name: string;
	apiBase: string;
	npub: string;
	agentId?: string | null;
	lineageRoot?: string | null;
	memoryMode: RuntimeMemoryMode;
	workspaceScope: "repo" | "workspace" | "global";
	features: {
		feedback: boolean;
		relay: boolean;
		coldSync: boolean;
		autoWarmPromotion: boolean;
	};
	secureStoreMode: "file";
	createdAt: string;
	updatedAt: string;
};

export type RuntimeSecretState = {
	nsec: string;
	session: HostedSession | null;
};

export type RuntimeAdapterRecord = {
	name: string;
	version: string;
	runtimeVersion: string;
	status: "installed" | "attached" | "failed" | "partial";
	profileName: string | null;
	hostHome: string | null;
	managedFiles: string[];
	lastError: string | null;
	installedAt: string;
	updatedAt: string;
	controllerConnectionId?: string;
	controllerProcess?: HostedControllerProcess;
};

export type RuntimeDaemonState = {
	ownerId?: string;
	ownerProcess?: HostedControllerProcess;
	status: "running" | "stopped";
	port: number | null;
	controlToken: string;
	pid: number | null;
	organizationalWorkerConfigPath: string | null;
	startedAt: string | null;
	lastHeartbeat: string | null;
	lastError: string | null;
};

export type RuntimeHealthState = {
	queueDepth: number;
	pendingHotWrites: number;
	pendingColdBatches: number;
	retryingItems: number;
	backpressure: boolean;
	lastSuccessfulSyncAt: string | null;
	lastError: string | null;
};

export type RuntimeConfig = {
	coreVersion: string;
	channel: RuntimeChannel;
	defaultProfile: string | null;
	installedAt: string;
	updatedAt: string;
};

export type RuntimeAdapterName = "codex" | "claude-code" | "pi";

export type OnlyBotsRuntimeManifest = {
	channel?: RuntimeChannel;
	core_version?: string;
	adapters?: Partial<Record<RuntimeAdapterName, string>>;
	memory_mode?: RuntimeMemoryMode;
	workspace_scope?: "repo" | "workspace" | "global";
	features?: Partial<RuntimeProfile["features"]>;
	continuity_policy?: unknown;
};

type RuntimeReleaseChannelEntry = {
	coreVersion: string;
	adapters: Record<RuntimeAdapterName, string>;
	migrationNotes: string[];
};

export type RuntimeCoreSnapshot = {
	version: string;
	channel: RuntimeChannel;
	capturedAt: string;
	source: "install" | "update" | "rollback" | "apply";
	adapters: Partial<Record<RuntimeAdapterName, string>>;
};

export type RuntimeAdapterSnapshot = {
	name: RuntimeAdapterName;
	version: string;
	runtimeVersion: string;
	hostHome: string | null;
	profileName: string | null;
	managedFiles: string[];
	capturedAt: string;
	source: "install" | "update" | "rollback" | "apply";
};


export type RuntimeStatus = {
	hotSync?: Record<string, unknown>;
	coreVersion: string;
	channel: RuntimeChannel;
	home: string;
	defaultProfile: string | null;
	daemon: {
		running: boolean;
		reachable: boolean;
		port: number | null;
		startedAt: string | null;
		lastHeartbeat: string | null;
		lastError: string | null;
	};
	profile: {
		name: string;
		npub: string;
		apiBase: string;
		memoryMode: RuntimeMemoryMode;
		workspaceScope: string;
		authValid: boolean;
		authExpiresAt: string | null;
		secureStoreMode: "file";
	} | null;
	adapters: RuntimeAdapterRecord[];
	queueDepth: number;
	pendingHotWrites: number;
	pendingColdBatches: number;
	retryingItems: number;
	backpressure: boolean;
	lastSuccessfulSyncAt: string | null;
	lastError: string | null;
	lifecycle: {
		lastEvent: {
			type: string;
			sessionId: string | null;
			turnId: string | null;
			occurredAt: string;
			summary: string | null;
		} | null;
		lastCompletedTurn: {
			turnId: string | null;
			occurredAt: string;
			summary: string | null;
			status: "completed" | "failed";
		} | null;
	};
	inbox: RuntimeInboxHudState | null;
	dreamReview: RuntimeDreamReviewHudState | null;
	integrity: {
		ok: boolean;
		issues: Array<{
			id: string;
			severity: "warning" | "error";
			message: string;
		}>;
	};
	continuity: RuntimeContinuityInspection;
};

export type RuntimeContinuityInspection = ContinuityPolicyInspection & {
	effectiveSource: "base_policy" | "governor_patched";
	base: {
		source: ContinuityPolicySource;
		validationErrors: string[];
		policy: ContinuityPolicy;
		inspection: ContinuityPolicyInspection;
	};
	governor: ContinuityGovernorState & {
		file: string;
		validationErrors: string[];
	};
};

export type RuntimeContinuityPatchMutation = {
	patch: ContinuityGovernorPatchRecord;
	continuity: RuntimeContinuityInspection;
};

export type RuntimeDoctorCheck = {
	id: string;
	ok: boolean;
	message: string;
};

export type RuntimeDoctorReport = {
	ok: boolean;
	checks: RuntimeDoctorCheck[];
};

export type RuntimeAttachRequest = {
	adapterName: string;
	adapterVersion: string;
	runtimeVersion: string;
	profileName: string;
	hostHome?: string | null;
	managedFiles?: string[];
	manifest?: OperatorWorkspaceManifest;
	controllerConnectionId?: string;
	expectedControllerConnectionId?: string | null;
	controllerProcess?: HostedControllerProcess;
};

export type RuntimeAttachResponse = {
	accepted: boolean;
	adapter: RuntimeAdapterRecord;
	compatibility: {
		compatible: boolean;
		reason: string | null;
	};
	mountPolicyAudit: Record<string, unknown> | null;
};

export type RuntimeDetachRequest = {
	adapterName: string;
	profileName: string;
	expectedUpdatedAt: string;
	controllerConnectionId: string;
};

export type InstallRuntimeCoreOptions = {
	home?: string;
	channel?: RuntimeChannel;
	coreVersion?: string;
	writeWrappers?: boolean;
	cliScriptPath?: string;
	daemonScriptPath?: string;
};

export type SetupRuntimeProfileOptions = {
	home?: string;
	profileName: string;
	apiBase: string;
	npub: string;
	nsec: string;
	memoryMode?: RuntimeMemoryMode;
	workspaceScope?: "repo" | "workspace" | "global";
	features?: Partial<RuntimeProfile["features"]>;
	makeDefault?: boolean;
};

type GeneratedRuntimeIdentity = {
	npub: string;
	nsec: string;
};

type ManagedAdapterReinstallSpec =
	| {
			name: "codex";
			profileName: string;
			hostHome: string | null;
			codexBinary: string | null;
		}
	| {
			name: "claude-code";
			profileName: string;
			hostHome: string | null;
			workspaceRoot: string | null;
			claudeBinary: string | null;
		}
	| {
			name: "pi";
			profileName: string;
		};

type InstalledRuntimeRelease = {
	releaseId: string | null;
	cliScriptPath: string | null;
	daemonScriptPath: string | null;
};

type DownloadedRuntimeRelease = {
	baseUrl: string;
	releaseId: string;
	releaseUrl: string;
	releaseSha256: string;
	releaseRoot: string;
	cliScriptPath: string;
	daemonScriptPath: string;
	localRuntimeModulePath: string;
	codexAdapterModulePath: string;
	claudeCodeAdapterModulePath: string;
	piAdapterModulePath: string;
};

type RuntimeReleaseUpdateResult = {
	previousReleaseId: string | null;
	releaseId: string;
	releaseUrl: string;
	baseUrl: string;
	coreVersion: string;
	adapters: Array<{
		name: RuntimeAdapterName;
		version: string;
	}>;
	daemonRestarted: boolean;
	daemonPort: number | null;
};

export type StartRuntimeDaemonOptions = {
	home?: string;
	port?: number;
	detached?: boolean;
	daemonScriptPath?: string;
	organizationalWorkerConfigPath?: string;
};

type Awaitable<T> = T | Promise<T>;

export interface OrganizationalWorkerDaemonApi {
	readonly capabilityCeiling: Readonly<OrganizationalWorkerCapabilities>;
	issueFederationBinding(value: unknown): unknown;
	inspectFederationBinding(input: {
		organizationId: string;
		agentId: string;
		bindingRef: string;
	}): unknown;
	acceptAssignment(value: unknown): Awaitable<{ accepted: boolean } & Record<string, unknown>>;
	executeAssignment(assignmentId: string): unknown;
	requestCancellation(value: unknown): unknown;
	recoverInterrupted(): unknown;
	resumePreEffect(assignmentId: string): unknown;
	flushOutbox(assignmentId?: string): unknown;
	inspectAssignment(assignmentId: string): Awaitable<unknown | null>;
	listAssignments(): Awaitable<unknown[]>;
	inspectDelivery?(): Awaitable<unknown>;
	synchronizeDelivery?(): Awaitable<unknown>;
	shutdown?(): Awaitable<void>;
}

const organizationalWorkerCapabilityMethods: Record<
	OrganizationalWorkerCapability,
	readonly (keyof OrganizationalWorkerDaemonApi)[]
> = {
	federationBindings: ["issueFederationBinding", "inspectFederationBinding"],
	assignmentInspection: ["inspectAssignment", "listAssignments"],
	assignmentAcceptance: ["acceptAssignment"],
	execution: ["executeAssignment", "resumePreEffect"],
	cancellation: ["requestCancellation"],
	recovery: ["recoverInterrupted"],
	outboxDelivery: ["flushOutbox"],
};

const validateOrganizationalWorkerApi = (
	api: OrganizationalWorkerDaemonApi | null,
	readiness: OrganizationalWorkerReadiness
): void => {
	if (!api) return;
	const candidate = api as unknown as Record<string, unknown>;
	const ceiling = candidate.capabilityCeiling;
	if (!ceiling || typeof ceiling !== "object" || Array.isArray(ceiling)) {
		throw new Error(
			"an organizational worker API requires an exact capability ceiling"
		);
	}
	const ceilingRecord = ceiling as Record<string, unknown>;
	const ceilingKeys = Object.keys(ceilingRecord).sort();
	const expectedKeys = [...organizationalWorkerCapabilityNames].sort();
	if (
		ceilingKeys.length !== expectedKeys.length ||
		ceilingKeys.some((key, index) => key !== expectedKeys[index]) ||
		organizationalWorkerCapabilityNames.some(
			(capability) => typeof ceilingRecord[capability] !== "boolean"
		)
	) {
		throw new Error(
			"an organizational worker API requires an exact capability ceiling"
		);
	}
	for (const capability of organizationalWorkerCapabilityNames) {
		if (readiness.capabilities[capability] && ceilingRecord[capability] !== true) {
			throw new Error(
				`organizational worker readiness exceeds the API ceiling for ${capability}`
			);
		}
	}
	for (const capability of organizationalWorkerCapabilityNames) {
		if (!readiness.capabilities[capability]) continue;
		for (const method of organizationalWorkerCapabilityMethods[capability]) {
			if (typeof candidate[method] !== "function") {
				throw new Error(
					`organizational worker API is missing a method required by ${capability}`
				);
			}
		}
	}
};

const GOVERNED_SYNTHETIC_LIFECYCLE_RUNTIME =
	"pi-embedded-synthetic-repository-v1";

const claimsGovernedSyntheticLifecycleProfile = (
	manifest: OperatorWorkspaceManifest
): boolean =>
	manifest.runtimeId === GOVERNED_SYNTHETIC_LIFECYCLE_RUNTIME ||
	manifest.runtimeVersion === GOVERNED_SYNTHETIC_LIFECYCLE_RUNTIME;

/**
 * This profile deliberately requests no lifecycle authority. Recognizing it
 * can only make the audit honest about the lack of an OS sandbox; it cannot
 * approve a mount, secret, raw environment key, or executable surface.
 */
const isExactGovernedSyntheticLifecycleAttach = (
	request: RuntimeAttachRequest
): boolean => {
	const manifest = request.manifest;
	if (!manifest) return false;
	const expectedKeys = [
		"extraMounts",
		"ipcMounts",
		"manifestVersion",
		"rawSecretEnvKeys",
		"readOnlyMounts",
		"requestedAt",
		"requestedSecretRefs",
		"runClass",
		"runtimeId",
		"runtimeVersion",
		"scratchMounts",
		"stateMounts",
		"tenantId",
		"workspaceId",
		"workspaceRoot",
	].sort();
	const actualKeys = Object.keys(manifest).sort();
	return (
		request.adapterName === "pi" &&
		request.hostHome === null &&
		actualKeys.length === expectedKeys.length &&
		actualKeys.every((key, index) => key === expectedKeys[index]) &&
		manifest.manifestVersion === "1" &&
		manifest.tenantId === "local-organizational-worker" &&
		manifest.workspaceId.startsWith("organizational-work:") &&
		manifest.workspaceId.length > "organizational-work:".length &&
		manifest.runClass === "one_shot" &&
		manifest.runtimeId === GOVERNED_SYNTHETIC_LIFECYCLE_RUNTIME &&
		manifest.runtimeVersion === GOVERNED_SYNTHETIC_LIFECYCLE_RUNTIME &&
		Array.isArray(manifest.readOnlyMounts) &&
		manifest.readOnlyMounts.length === 0 &&
		Array.isArray(manifest.scratchMounts) &&
		manifest.scratchMounts.length === 0 &&
		Array.isArray(manifest.stateMounts) &&
		manifest.stateMounts.length === 0 &&
		Array.isArray(manifest.ipcMounts) &&
		manifest.ipcMounts.length === 0 &&
		Array.isArray(manifest.extraMounts) &&
		manifest.extraMounts.length === 0 &&
		Array.isArray(manifest.requestedSecretRefs) &&
		manifest.requestedSecretRefs.length === 0 &&
		Array.isArray(manifest.rawSecretEnvKeys) &&
		manifest.rawSecretEnvKeys.length === 0
	);
};

/** A controller connection declares no worker authority. Even a single extra
 * mount, secret or field prevents use of this metadata-only profile. */
const isExactHostedControllerAttach = (request: RuntimeAttachRequest): boolean => {
	const manifest = request.manifest;
	if (!manifest || request.adapterName !== HOSTED_PI_CONTROLLER_ADAPTER ||
		request.adapterVersion !== ONLYBOTS_RUNTIME_CORE_VERSION || request.runtimeVersion !== ONLYBOTS_RUNTIME_CORE_VERSION ||
		!request.controllerConnectionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.controllerConnectionId) ||
		!request.controllerProcess || Object.keys(request.controllerProcess).sort().join(",") !== "bootId,pid,startedAtTicks" ||
		!hostedControllerProcessIsLive(request.controllerProcess) ||
		request.hostHome !== null || !Array.isArray(request.managedFiles) || request.managedFiles.length) return false;
	const keys = ["manifestVersion", "tenantId", "workspaceId", "runClass", "runtimeId", "runtimeVersion",
		"workspaceRoot", "readOnlyMounts", "scratchMounts", "stateMounts", "ipcMounts", "extraMounts",
		"requestedSecretRefs", "rawSecretEnvKeys", "requestedAt"].sort();
	const actual = Object.keys(manifest).sort();
	return actual.length === keys.length && actual.every((key, index) => key === keys[index]) &&
		manifest.manifestVersion === "1" && manifest.tenantId === "local-hosted-controller" &&
		manifest.workspaceId === "hosted-controller:pi" && manifest.runClass === "one_shot" &&
		manifest.runtimeId === HOSTED_PI_CONTROLLER_MANIFEST && manifest.runtimeVersion === HOSTED_PI_CONTROLLER_MANIFEST &&
		[manifest.readOnlyMounts, manifest.scratchMounts, manifest.stateMounts, manifest.ipcMounts,
			manifest.extraMounts, manifest.requestedSecretRefs, manifest.rawSecretEnvKeys]
			.every(entries => Array.isArray(entries) && entries.length === 0);
};

export type LocalRuntimeDaemonOptions = {
	/** Close composed resources after local requests quiesce, before releasing the home. */
	runtimeCleanup?: () => Promise<void>;
	hotWriteDebounceMs?: number;
	coldBatchWindowMs?: number;
	backgroundIntervalMs?: number;
	maxQueueDepth?: number;
	maxQueueAttempts?: number;
	organizationalWorker?: OrganizationalWorkerDaemonApi;
	organizationalWorkerReadiness?: OrganizationalWorkerReadiness;
	organizationalWorkerFederationStatusObserver?: OrganizationalWorkerFederationStatusObserver;
	organizationalWorkerConfigPath?: string;
};

export type LocalRuntimeRequest = {
	method: string;
	path: string;
	body?: Record<string, unknown>;
	query?: Record<string, string>;
	token?: string | null;
};





const RUNTIME_MANIFEST_FILE = "crosshead.runtime.json";

const RUNTIME_RELEASE_CATALOG: Record<RuntimeChannel, RuntimeReleaseChannelEntry> = {
	stable: {
		coreVersion: "0.3.0",
		adapters: {
			codex: "0.3.0",
			"claude-code": "0.3.0",
			pi: "0.3.0",
		},
		migrationNotes: ["Stable channel prioritizes reproducibility over the newest host shims."],
	},
	beta: {
		coreVersion: "0.3.1-beta.1",
		adapters: {
			codex: "0.3.1-beta.1",
			"claude-code": "0.3.1-beta.1",
			pi: "0.3.1-beta.1",
		},
		migrationNotes: ["Beta channel includes newer adapter shims and manifest handling improvements."],
	},
	canary: {
		coreVersion: "0.3.2-canary.1",
		adapters: {
			codex: "0.3.2-canary.1",
			"claude-code": "0.3.2-canary.1",
			pi: "0.3.2-canary.1",
		},
		migrationNotes: ["Canary channel is intended for early validation before promoting a release downstream."],
	},
};

export const parseArgs = (args: string[]): { positionals: string[]; flags: Record<string, string | boolean> } => {
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index]!;
		if (!value.startsWith("--")) {
			positionals.push(value);
			continue;
		}
		const key = value.slice(2);
		const next = args[index + 1];
		if (!next || next.startsWith("--")) {
			flags[key] = true;
			continue;
		}
		flags[key] = next;
		index += 1;
	}
	return { positionals, flags };
};

const normalizeBaseUrl = (value: string): string => {
	const parsed = new URL(value);
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error("Runtime update base URL must be an HTTPS URL without credentials, query, or fragment");
	}
	return parsed.toString().replace(/\/+$/, "");
};

const decodeGeneratedShellWord = (value: string): string | null => {
	if (value.startsWith("'") && value.endsWith("'")) {
		const body = value.slice(1, -1);
		if (body.includes("'") && !body.includes(`'"'"'`)) return null;
		return body.split(`'"'"'`).join("'");
	}
	if (value.startsWith('"') && value.endsWith('"')) {
		const body = value.slice(1, -1);
		if (/[`$]/.test(body) || /\\(?![\\"])/.test(body)) return null;
		return body.replace(/\\([\\"])/g, "$1");
	}
	return null;
};

export const parseWrapperScriptTarget = (filePath: string): string | null => {
	if (!existsSync(filePath)) {
		return null;
	}
	const content = readFileSync(filePath, "utf8");
	const executablePrefixes = ["node ", `${shellQuote(process.execPath)} `];
	const line = content.split(/\r?\n/).find((entry) => executablePrefixes.some((prefix) => entry.startsWith(prefix)));
	if (!line) return null;
	const prefix = executablePrefixes.find((candidate) => line.startsWith(candidate));
	if (!prefix) return null;
	const match = line.slice(prefix.length).match(/^((?:'[^']*(?:'"'"'[^']*)*')|(?:"(?:[^"\\]|\\.)*"))\s+"\$@"$/);
	return match ? decodeGeneratedShellWord(match[1]!) : null;
};

const deriveReleaseIdFromScriptPath = (scriptPath: string | null): string | null => {
	if (!scriptPath) {
		return null;
	}
	const normalized = scriptPath.replace(/\\/g, "/");
	const match = normalized.match(/\/lib\/runtime\/([^/]+)\//);
	return match?.[1] ?? null;
};

const validateInstalledReleaseScript = (
	paths: RuntimePaths,
	scriptPath: string | null,
	fileName: "cli.js" | "daemon.js"
): { releaseId: string; scriptPath: string } | null => {
	const releaseId = deriveReleaseIdFromScriptPath(scriptPath);
	if (!scriptPath || !releaseId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)) return null;
	const expected = path.join(paths.libRuntime, releaseId, "dist", "runtime", fileName);
	if (path.resolve(scriptPath) !== expected || !existsSync(expected)) return null;
	const stat = lstatSync(expected);
	return stat.isFile() && !stat.isSymbolicLink() ? { releaseId, scriptPath: expected } : null;
};

export const inspectInstalledRuntimeRelease = (paths: RuntimePaths): InstalledRuntimeRelease => {
	const manifest = parseJsonFile<{ releaseId?: unknown; cliScriptPath?: unknown; daemonScriptPath?: unknown } | null>(
		path.join(paths.state, "installed-release.json"), null
	);
	const manifestCli = typeof manifest?.cliScriptPath === "string"
		? validateInstalledReleaseScript(paths, manifest.cliScriptPath, "cli.js") : null;
	const manifestDaemon = typeof manifest?.daemonScriptPath === "string"
		? validateInstalledReleaseScript(paths, manifest.daemonScriptPath, "daemon.js") : null;
	if (manifest && typeof manifest.releaseId === "string" && manifestCli?.releaseId === manifest.releaseId &&
		manifestDaemon?.releaseId === manifest.releaseId) {
		return { releaseId: manifest.releaseId, cliScriptPath: manifestCli.scriptPath, daemonScriptPath: manifestDaemon.scriptPath };
	}
	const cli = validateInstalledReleaseScript(paths, parseWrapperScriptTarget(path.join(paths.bin, "onlybotsctl")), "cli.js");
	const daemon = validateInstalledReleaseScript(paths, parseWrapperScriptTarget(path.join(paths.bin, "onlybotsd")), "daemon.js");
	return {
		releaseId: cli?.releaseId === daemon?.releaseId ? cli?.releaseId ?? null : null,
		cliScriptPath: cli?.scriptPath ?? null,
		daemonScriptPath: daemon?.scriptPath ?? null,
	};
};

const INSTALLER_SCRIPT_MAX_BYTES = 128 * 1024;
const RUNTIME_RELEASE_MAX_BYTES = 64 * 1024 * 1024;
const RUNTIME_RELEASE_MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const RUNTIME_RELEASE_MAX_ENTRIES = 20_000;
const GITHUB_RELEASE_REDIRECT_HOSTS = new Set(["release-assets.githubusercontent.com"]);

type FetchRedirectPolicy = {
	allowedHosts: ReadonlySet<string>;
	maxRedirects: number;
};

const fetchBuffer = async (
	url: string,
	maxBytes: number,
	timeoutMs: number,
	redirectPolicy?: FetchRedirectPolicy
): Promise<Buffer> => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		let currentUrl = new URL(url);
		let redirects = 0;
		let response: Response;
		while (true) {
			response = await fetch(currentUrl, {
				redirect: "manual",
				signal: controller.signal,
			});
			if (response.status < 300 || response.status > 399) break;
			const location = response.headers.get("location");
			if (!redirectPolicy || !location || redirects >= redirectPolicy.maxRedirects) {
				await response.body?.cancel();
				throw new Error("Release download returned a disallowed redirect");
			}
			let nextUrl: URL;
			try {
				nextUrl = new URL(location, currentUrl);
			} catch {
				await response.body?.cancel();
				throw new Error("Release download returned an invalid redirect");
			}
			if (
				nextUrl.protocol !== "https:" ||
				nextUrl.port !== "" ||
				nextUrl.username !== "" ||
				nextUrl.password !== "" ||
				!redirectPolicy.allowedHosts.has(nextUrl.hostname)
			) {
				await response.body?.cancel();
				throw new Error("Release download redirected outside the trusted GitHub asset origin");
			}
			await response.body?.cancel();
			currentUrl = nextUrl;
			redirects += 1;
		}
		if (!response.ok) {
			throw new Error(`Failed to fetch release metadata or artifact: ${response.status} ${response.statusText}`);
		}
		const contentLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(contentLength) && contentLength > maxBytes) {
			throw new Error(`Response from ${url} exceeds the ${maxBytes}-byte limit`);
		}
		if (!response.body) {
			return Buffer.alloc(0);
		}
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		const reader = response.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw new Error(`Response from ${url} exceeds the ${maxBytes}-byte limit`);
			}
			chunks.push(Buffer.from(value));
		}
		return Buffer.concat(chunks, totalBytes);
	} finally {
		clearTimeout(timeout);
	}
};

export const fetchRuntimeReleaseArtifact = async (releaseUrl: string): Promise<Buffer> => {
	const parsed = new URL(releaseUrl);
	return fetchBuffer(
		releaseUrl,
		RUNTIME_RELEASE_MAX_BYTES,
		120_000,
		parsed.hostname === "github.com"
			? { allowedHosts: GITHUB_RELEASE_REDIRECT_HOSTS, maxRedirects: 3 }
			: undefined
	);
};

const fetchText = async (url: string): Promise<string> =>
	(await fetchBuffer(url, INSTALLER_SCRIPT_MAX_BYTES, 30_000)).toString("utf8");

const parseInstallerReleaseMetadata = (
	script: string
): { releaseId: string; releaseUrl: string; releaseSha256: string } => {
	const releaseId = script.match(/^RELEASE_ID="([^"]+)"$/m)?.[1] ?? null;
	const releaseUrl = script.match(/^CROSSHEAD_RELEASE_URL="([^"]+)"$/m)?.[1]
		?? script.match(/^RELEASE_URL="([^"]+)"$/m)?.[1] ?? null;
	const releaseSha256 = script.match(/^RELEASE_SHA256="([a-f0-9]{64})"$/m)?.[1] ?? null;
	if (!releaseId || !releaseUrl || !releaseSha256) {
		throw new Error("Installer script did not expose valid release id, URL, and SHA-256 metadata");
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId) || releaseId === "." || releaseId === "..") {
		throw new Error("Installer script exposed an invalid release id");
	}
	return { releaseId, releaseUrl, releaseSha256 };
};

export const isAllowedRuntimeReleaseUrl = (baseUrl: string, releaseId: string, releaseUrl: URL): boolean => {
	if (releaseUrl.username || releaseUrl.password) return false;
	const hostedUrls = ["crosshead-runtime.tgz", "onlybots-runtime.tgz"].map(name =>
		new URL(`${baseUrl}/install/releases/${name}`).toString());
	if (hostedUrls.includes(releaseUrl.toString())) return true;
	const version = releaseId.match(/^([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)-[a-f0-9]{12}$/)?.[1];
	if (!version) return false;
	return releaseUrl.toString() ===
		`https://github.com/FriendMachine/crosshead/releases/download/v${version}/crosshead-runtime-install-${version}.tgz`;
};

const validateRuntimeReleaseArchive = async (tarballPath: string): Promise<void> => {
	let entries = 0;
	let extractedBytes = 0;
	let validationError: string | null = null;
	await tar.t({
		file: tarballPath,
		onentry: (entry) => {
			if (validationError) {
				return;
			}
			entries += 1;
			extractedBytes += entry.size;
			const normalized = entry.path.replace(/\\/g, "/");
			const segments = normalized.split("/");
			if (
				entries > RUNTIME_RELEASE_MAX_ENTRIES ||
				extractedBytes > RUNTIME_RELEASE_MAX_EXTRACTED_BYTES ||
				path.posix.isAbsolute(normalized) ||
				segments.includes("..") ||
				(entry.type !== "File" && entry.type !== "Directory")
			) {
				validationError = "Runtime release archive contains unsafe or excessive entries";
			}
		},
	});
	if (validationError) {
		throw new Error(validationError);
	}
};

const runCommand = async (command: string, args: string[], cwd: string): Promise<void> =>
	await new Promise<void>((resolve, reject) => {
		const env = { ...process.env };
		delete env.NODE_OPTIONS;
		delete env.NODE_PATH;
		env.PATH = [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter);
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stdout.resume();
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(stderr.trim().length > 0 ? stderr.trim() : `${command} exited with code ${code ?? "unknown"}`));
		});
	});

export const generateRuntimeIdentity = (): GeneratedRuntimeIdentity => {
	const privateKey = generateSecretKey();
	return {
		npub: nip19.npubEncode(getPublicKey(privateKey)),
		nsec: nip19.nsecEncode(privateKey),
	};
};
























const uniqueStrings = (values: Array<string | null | undefined>): string[] =>
	[...new Set(values.map((value) => (typeof value === "string" ? value.trim() : "")).filter((value) => value.length > 0))];







const ensureProfileAgentIdentity = (paths: RuntimePaths, profile: RuntimeProfile): RuntimeProfile => {
	const agentId = normalizePersistentAgentId(profile.agentId ?? profile.name);
	const lineageRoot = normalizePersistentAgentId(profile.lineageRoot ?? agentId);
	if (profile.agentId === agentId && profile.lineageRoot === lineageRoot) {
		return profile;
	}
	const updated: RuntimeProfile = {
		...profile,
		agentId,
		lineageRoot,
		updatedAt: nowIso(),
	};
	saveProfile(paths, updated);
	return updated;
};

const toRuntimePersistentAgentProfile = (profile: RuntimeProfile): RuntimePersistentAgentProfile => ({
	name: profile.name,
	npub: profile.npub,
	apiBase: profile.apiBase,
	agentId: profile.agentId ?? null,
	lineageRoot: profile.lineageRoot ?? null,
	memoryMode: profile.memoryMode,
	workspaceScope: profile.workspaceScope,
	features: profile.features,
	secureStoreMode: profile.secureStoreMode,
	createdAt: profile.createdAt,
	updatedAt: profile.updatedAt,
});

const toRuntimePersistentAgentAdapters = (adapters: RuntimeAdapterRecord[]): RuntimePersistentAgentAdapter[] =>
	adapters.map((adapter) => ({
		name: adapter.name,
		status: adapter.status,
		profileName: adapter.profileName,
		hostHome: adapter.hostHome,
		managedFiles: adapter.managedFiles,
		installedAt: adapter.installedAt,
		updatedAt: adapter.updatedAt,
	}));

const ensurePersistentAgentForProfile = (
	paths: RuntimePaths,
	profile: RuntimeProfile,
	options: { continuityPolicyRef?: string | null } = {}
): { profile: RuntimeProfile; entity: PersistentAgentEntity } => {
	const normalizedProfile = ensureProfileAgentIdentity(paths, profile);
	const existing = loadPersistentAgentEntity(paths, normalizedProfile.agentId ?? normalizedProfile.name);
	const entity = materializePersistentAgentEntity({
		profile: toRuntimePersistentAgentProfile(normalizedProfile),
		adapters: toRuntimePersistentAgentAdapters(listAdapterRecords(paths)),
		continuityPolicyRef: options.continuityPolicyRef ?? null,
		existingEntity: existing,
		passportRef: existing?.passportRef ?? null,
	});
	savePersistentAgentEntity(paths, entity);
	return {
		profile: normalizedProfile,
		entity,
	};
};





const recordInstalledStateSnapshots = (
	paths: RuntimePaths,
	source: RuntimeCoreSnapshot["source"] | RuntimeAdapterSnapshot["source"]
): void => {
	const config = loadRuntimeConfig(paths);
	const adapters = listAdapterRecords(paths);
	saveCoreSnapshot(paths, {
		version: config.coreVersion,
		channel: config.channel,
		capturedAt: nowIso(),
		source,
		adapters: Object.fromEntries(adapters.map((adapter) => [adapter.name, adapter.version])) as Partial<
			Record<RuntimeAdapterName, string>
		>,
	});
	for (const adapter of adapters) {
		if (!RUNTIME_ADAPTER_NAMES.includes(adapter.name as RuntimeAdapterName)) {
			continue;
		}
		saveAdapterSnapshot(paths, {
			name: adapter.name as RuntimeAdapterName,
			version: adapter.version,
			runtimeVersion: adapter.runtimeVersion,
			hostHome: adapter.hostHome,
			profileName: adapter.profileName,
			managedFiles: adapter.managedFiles,
			capturedAt: nowIso(),
			source,
		});
	}
};






const createShellWrapper = (scriptPath: string, home: string): string => `#!/usr/bin/env bash
set -euo pipefail
unset NODE_OPTIONS NODE_PATH
export CROSSHEAD_HOME=${shellQuote(home)}
${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"
`;

// Replace wrappers atomically. `crosshead update` rewrites the wrapper that is
// running it, and bash reads scripts incrementally: rewriting the same file
// makes bash resume at a stale offset in the new text once node exits.
// Renaming a new file over it leaves the running shell on the old file.
const writeWrapper = (filePath: string, scriptPath: string, home: string): void => {
	const staged = `${filePath}.${process.pid}.tmp`;
	try {
		writeFileSync(staged, createShellWrapper(scriptPath, home), { encoding: "utf8", mode: 0o755 });
		chmodSync(staged, 0o755);
		renameSync(staged, filePath);
	} catch (error) {
		rmSync(staged, { force: true });
		throw error;
	}
};

export const installRuntimeCore = async (options: InstallRuntimeCoreOptions = {}): Promise<RuntimePaths> => {
	const paths = ensureRuntimeHomeLayout(options.home);
	writeRuntimeInstallMarker(paths);
	const config: RuntimeConfig = {
		coreVersion: options.coreVersion ?? ONLYBOTS_RUNTIME_CORE_VERSION,
		channel: options.channel ?? "stable",
		defaultProfile: loadRuntimeConfig(paths).defaultProfile,
		installedAt: loadRuntimeConfig(paths).installedAt,
		updatedAt: nowIso(),
	};
	saveRuntimeConfig(paths, config);

	const daemonState = loadDaemonState(paths);
	saveDaemonState(paths, {
		...daemonState,
		controlToken: daemonState.controlToken || randomUUID(),
	});
	saveHealthState(paths, loadHealthState(paths));
	if (!existsSync(continuityPolicyFile(paths))) {
		saveContinuityPolicy(paths, buildDefaultContinuityPolicy());
	}
	if (!existsSync(continuityGovernorFile(paths))) {
		saveContinuityGovernorPatchHistory(paths, []);
	}

	if (options.writeWrappers !== false && options.cliScriptPath && options.daemonScriptPath) {
		for (const name of ["crosshead", "xhd", "onlybotsctl"]) {
			writeWrapper(path.join(paths.bin, name), options.cliScriptPath, paths.home);
		}
		writeWrapper(path.join(paths.bin, "crossheadd"), options.daemonScriptPath, paths.home);
		writeWrapper(path.join(paths.bin, "onlybotsd"), options.daemonScriptPath, paths.home);
		const releaseId = deriveReleaseIdFromScriptPath(options.cliScriptPath);
		if (releaseId && deriveReleaseIdFromScriptPath(options.daemonScriptPath) === releaseId) {
			writeJsonFile(path.join(paths.state, "installed-release.json"), {
				releaseId,
				cliScriptPath: options.cliScriptPath,
				daemonScriptPath: options.daemonScriptPath,
				recordedAt: nowIso(),
			});
		}
	}

	writeRuntimeLog(paths, "runtime.install", {
		coreVersion: config.coreVersion,
		channel: config.channel,
	});
	saveCoreSnapshot(paths, {
		version: config.coreVersion,
		channel: config.channel,
		capturedAt: nowIso(),
		source: "install",
		adapters: Object.fromEntries(listAdapterRecords(paths).map((adapter) => [adapter.name, adapter.version])) as Partial<
			Record<RuntimeAdapterName, string>
		>,
	});
	return paths;
};

export const uninstallRuntimeCore = async (home?: string): Promise<void> => {
	const resolvedHome = resolveRuntimeHome(home);
	if (!existsSync(resolvedHome)) return;
	const canonicalHome = realpathSync(resolvedHome);
	const unsafe = canonicalHome === path.parse(canonicalHome).root || canonicalHome === os.homedir() ||
		canonicalHome === process.cwd() || !path.relative(canonicalHome, process.cwd()).startsWith("..");
	if (unsafe) throw new Error(`Refusing to uninstall unsafe runtime home: ${canonicalHome}`);
	const paths = resolveRuntimePaths(resolvedHome);
	const marker = parseJsonFile<{ version?: unknown; installId?: unknown; canonicalHome?: unknown } | null>(
		runtimeInstallMarkerFile(paths), null
	);
	if (marker?.version !== RUNTIME_INSTALL_MARKER_VERSION || typeof marker.installId !== "string" ||
		marker.canonicalHome !== canonicalHome) {
		throw new Error(`Refusing to uninstall ${canonicalHome}: valid Crosshead installation marker is missing`);
	}
	const daemon = readDaemonOwnershipState(paths);
	if (daemonOwnerIsLive(daemon)) await stopDetachedRuntimeDaemon(paths.home);
	rmSync(canonicalHome, { recursive: true, force: true });
	if (resolvedHome !== canonicalHome) {
		try { if (lstatSync(resolvedHome).isSymbolicLink()) rmSync(resolvedHome, { force: true }); }
		catch { /* The alias may disappear with its target. */ }
	}
};

export const setupRuntimeProfile = async (options: SetupRuntimeProfileOptions): Promise<RuntimeProfile> => {
	try {
		const decodedNpub = nip19.decode(options.npub);
		const decodedNsec = nip19.decode(options.nsec);
		if (
			decodedNpub.type !== "npub" ||
			decodedNsec.type !== "nsec" ||
			nip19.npubEncode(decodedNpub.data) !== options.npub ||
			nip19.nsecEncode(decodedNsec.data) !== options.nsec ||
			nip19.npubEncode(getPublicKey(decodedNsec.data)) !== options.npub
		) {
			throw new Error("invalid runtime identity");
		}
	} catch {
		throw new Error("runtime profile npub/nsec must be a valid matching NIP-19 key pair");
	}
	const paths = ensureRuntimeHomeLayout(options.home);
	writeRuntimeInstallMarker(paths);
	const secret = loadSecret(paths, options.profileName);
	const localOnlyProfile = isLocalOnlyRuntimeProfile({ apiBase: options.apiBase });
	const session = localOnlyProfile
		? null
		: await new HostedOnlyBotsClient({
				apiBase: options.apiBase,
				npub: options.npub,
				nsec: options.nsec,
				session: secret?.session ?? null,
			}).ensureSession();

	const profile: RuntimeProfile = {
		name: options.profileName,
		apiBase: options.apiBase,
		npub: options.npub,
		agentId: normalizePersistentAgentId(options.profileName),
		lineageRoot: normalizePersistentAgentId(options.profileName),
		memoryMode: options.memoryMode ?? "assist",
		workspaceScope: options.workspaceScope ?? "repo",
		features: {
			feedback: options.features?.feedback ?? true,
			relay: options.features?.relay ?? false,
			coldSync: options.features?.coldSync ?? true,
			autoWarmPromotion: options.features?.autoWarmPromotion ?? false,
		},
		secureStoreMode: "file",
		createdAt: loadProfile(paths, options.profileName)?.createdAt ?? nowIso(),
		updatedAt: nowIso(),
	};
	saveProfile(paths, profile);
	saveSecret(paths, options.profileName, {
		nsec: options.nsec,
		session,
	});
	const config = loadRuntimeConfig(paths);
	if (options.makeDefault !== false || !config.defaultProfile) {
		saveRuntimeConfig(paths, {
			...config,
			defaultProfile: options.profileName,
			updatedAt: nowIso(),
		});
	}
	writeRuntimeLog(paths, "profile.setup", {
		profileName: profile.name,
		npub: profile.npub,
		apiBase: profile.apiBase,
		memoryMode: profile.memoryMode,
	});
	return profile;
};

const installManagedAdapter = async (
	adapterName: RuntimeAdapterName,
	options: {
		home: string;
		version: string;
		profileName?: string | null;
		hostHome?: string | null;
	}
): Promise<string> => {
	if (adapterName === "codex") {
		const { installCodexAdapter, loadCodexAdapterConfig } = await import("./codex-adapter");
		let installedConfig: { codexBinary: string } | null = null;
		try {
			installedConfig = loadCodexAdapterConfig(options.home, options.hostHome ?? undefined);
		} catch {
			installedConfig = null;
		}
		const result = await installCodexAdapter({
			home: options.home,
			hostHome: options.hostHome ?? undefined,
			profileName: options.profileName ?? "default",
			adapterVersion: options.version,
			codexBinary: installedConfig?.codexBinary,
			bridgeScriptPath: resolveCodexBridgeScriptPath(),
			hookScriptPath: resolveCodexHookScriptPath(),
		});
		return `Updated codex to ${result.adapter.version}`;
	}
	if (adapterName === "claude-code") {
		const { installClaudeCodeAdapter, loadClaudeCodeAdapterConfig } = await import("./claude-code-adapter");
		let installedConfig: { claudeBinary: string; workspaceRoot: string } | null = null;
		try {
			installedConfig = loadClaudeCodeAdapterConfig(options.home, options.hostHome ?? undefined);
		} catch {
			installedConfig = null;
		}
		const result = await installClaudeCodeAdapter({
			home: options.home,
			hostHome: options.hostHome ?? undefined,
			workspaceRoot: installedConfig?.workspaceRoot,
			profileName: options.profileName ?? "default",
			adapterVersion: options.version,
			claudeBinary: installedConfig?.claudeBinary,
			bridgeScriptPath: resolveClaudeBridgeScriptPath(),
			hookScriptPath: resolveClaudeHookScriptPath(),
		});
		return `Updated claude-code to ${result.adapter.version}`;
	}
	const { installPiAdapter } = await import("./pi-adapter");
	const result = await installPiAdapter({
		home: options.home,
		profileName: options.profileName ?? "default",
		adapterVersion: options.version,
	});
	return `Updated pi to ${result.adapter.version}`;
};

export const checkForRuntimeUpdates = async (
	home?: string,
	channelOverride?: RuntimeChannel
): Promise<{
	home: string;
	channel: RuntimeChannel;
	currentCoreVersion: string;
	latestCoreVersion: string;
	coreUpdateAvailable: boolean;
	adapters: Array<{
		name: RuntimeAdapterName;
		currentVersion: string;
		latestVersion: string;
		updateAvailable: boolean;
		compatible: boolean;
		reason: string | null;
	}>;
	migrationNotes: string[];
	manifestPath: string | null;
}> => {
	const paths = ensureRuntimeHomeLayout(home);
	const config = loadRuntimeConfig(paths);
	const channel = channelOverride ?? config.channel;
	const channelEntry = catalogEntryForChannel(channel);
	const adapters = listAdapterRecords(paths)
		.filter((adapter) => RUNTIME_ADAPTER_NAMES.includes(adapter.name as RuntimeAdapterName))
		.map((adapter) => {
			const adapterName = adapter.name as RuntimeAdapterName;
			const latestVersion = channelEntry.adapters[adapterName];
			const reason = compatibilityReason(channelEntry.coreVersion, latestVersion);
			return {
				name: adapterName,
				currentVersion: adapter.version,
				latestVersion,
				updateAvailable: compareVersions(latestVersion, adapter.version) > 0,
				compatible: reason === null,
				reason,
			};
		});
	const manifestPath = existsSync(defaultRuntimeManifestPath()) ? defaultRuntimeManifestPath() : null;
	return {
		home: paths.home,
		channel,
		currentCoreVersion: config.coreVersion,
		latestCoreVersion: channelEntry.coreVersion,
		coreUpdateAvailable: compareVersions(channelEntry.coreVersion, config.coreVersion) > 0,
		adapters,
		migrationNotes: channelEntry.migrationNotes,
		manifestPath,
	};
};

const collectManagedAdapterReinstallSpecs = async (paths: RuntimePaths): Promise<ManagedAdapterReinstallSpec[]> => {
	const specs: ManagedAdapterReinstallSpec[] = [];
	const records = listAdapterRecords(paths).filter((adapter) => RUNTIME_ADAPTER_NAMES.includes(adapter.name as RuntimeAdapterName));
	for (const adapter of records) {
		const profileName = adapter.profileName ?? loadRuntimeConfig(paths).defaultProfile ?? "default";
		if (adapter.name === "codex") {
			const { loadCodexAdapterConfig } = await import("./codex-adapter");
			let codexBinary: string | null = null;
			try {
				codexBinary = loadCodexAdapterConfig(paths.home, adapter.hostHome ?? undefined).codexBinary;
			} catch {
				codexBinary = null;
			}
			specs.push({
				name: "codex",
				profileName,
				hostHome: adapter.hostHome ?? null,
				codexBinary,
			});
			continue;
		}
		if (adapter.name === "claude-code") {
			const { loadClaudeCodeAdapterConfig } = await import("./claude-code-adapter");
			let workspaceRoot: string | null = null;
			let claudeBinary: string | null = null;
			try {
				const config = loadClaudeCodeAdapterConfig(paths.home, adapter.hostHome ?? undefined);
				workspaceRoot = config.workspaceRoot;
				claudeBinary = config.claudeBinary;
			} catch {
				workspaceRoot = null;
				claudeBinary = null;
			}
			specs.push({
				name: "claude-code",
				profileName,
				hostHome: adapter.hostHome ?? null,
				workspaceRoot,
				claudeBinary,
			});
			continue;
		}
		specs.push({
			name: "pi",
			profileName,
		});
	}
	return specs;
};

export const resolveReleaseUpdateBaseUrl = (paths: RuntimePaths, explicitBaseUrl?: string): string => {
	void paths;
	const official = "https://crosshead.sh";
	if (explicitBaseUrl && normalizeBaseUrl(explicitBaseUrl.trim()) !== official) {
		throw new Error("Custom runtime update origins are disabled; releases are fetched only from https://crosshead.sh");
	}
	return official;
};

const downloadRuntimeRelease = async (
	paths: RuntimePaths,
	explicitBaseUrl?: string,
	trustedSha256?: string
): Promise<DownloadedRuntimeRelease> => {
	const baseUrl = resolveReleaseUpdateBaseUrl(paths, explicitBaseUrl);
	if (!trustedSha256 || !/^[a-f0-9]{64}$/.test(trustedSha256)) {
		throw new Error("Runtime installation requires --sha256 <trusted release digest> from an independent release channel");
	}
	const installerScript = await fetchText(`${baseUrl}/install`);
	const { releaseId, releaseUrl, releaseSha256 } = parseInstallerReleaseMetadata(installerScript);
	if (trustedSha256 !== releaseSha256) {
		throw new Error("Trusted runtime release SHA-256 does not match the official release metadata");
	}
	let parsedReleaseUrl: URL;
	try {
		parsedReleaseUrl = new URL(releaseUrl);
	} catch {
		throw new Error("Installer script exposed an invalid runtime release URL");
	}
	if (!isAllowedRuntimeReleaseUrl(baseUrl, releaseId, parsedReleaseUrl)) {
		throw new Error("Installer script runtime release URL did not match an official release origin");
	}
	const releaseRoot = path.join(paths.libRuntime, releaseId);
	const cliScriptPath = path.join(releaseRoot, "dist", "runtime", "cli.js");
	const daemonScriptPath = path.join(releaseRoot, "dist", "runtime", "daemon.js");
	const localRuntimeModulePath = path.join(releaseRoot, "dist", "runtime", "local-runtime.js");
	const codexAdapterModulePath = path.join(releaseRoot, "dist", "runtime", "codex-adapter.js");
	const claudeCodeAdapterModulePath = path.join(releaseRoot, "dist", "runtime", "claude-code-adapter.js");
	const piAdapterModulePath = path.join(releaseRoot, "dist", "runtime", "pi-adapter.js");

	// Never trust an existing release directory merely because its name matches
	// server metadata. Re-download and verify the operator-trusted digest before
	// any file from that directory can be required or launched.
	const tarball = await fetchRuntimeReleaseArtifact(releaseUrl);
	const actualSha256 = createHash("sha256").update(tarball).digest("hex");
	if (actualSha256 !== releaseSha256) {
		throw new Error("Runtime release SHA-256 verification failed");
	}
	const releaseParent = path.dirname(releaseRoot);
	mkdirSync(releaseParent, { recursive: true });
	const tempDir = mkdtempSync(path.join(releaseParent, ".crosshead-runtime-release-"));
	const stageRoot = path.join(tempDir, "release");
	try {
		const tarballPath = path.join(tempDir, "crosshead-runtime.tgz");
		writeFileSync(tarballPath, tarball);
		await validateRuntimeReleaseArchive(tarballPath);
		mkdirSync(stageRoot, { recursive: true });
		await tar.x({
			cwd: stageRoot,
			file: tarballPath,
			preserveOwner: false,
		});
		for (const requiredPath of [
			"package.json",
			"package-lock.json",
			"dist/runtime/cli.js",
			"dist/runtime/daemon.js",
			"dist/runtime/local-runtime.js",
		]) {
			if (!existsSync(path.join(stageRoot, requiredPath))) {
				throw new Error(`Runtime release is missing required file ${requiredPath}`);
			}
		}
		const npmExecutable = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
		if (!existsSync(npmExecutable)) throw new Error(`Runtime update cannot find npm beside ${process.execPath}`);
		await runCommand(npmExecutable, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stageRoot);
		rmSync(releaseRoot, { recursive: true, force: true });
		renameSync(stageRoot, releaseRoot);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}

	return {
		baseUrl,
		releaseId,
		releaseUrl,
		releaseSha256,
		releaseRoot,
		cliScriptPath,
		daemonScriptPath,
		localRuntimeModulePath,
		codexAdapterModulePath,
		claudeCodeAdapterModulePath,
		piAdapterModulePath,
	};
};

export const inspectPublishedRuntimeRelease = async (home?: string): Promise<{ installed: string | null; available: string }> => {
	const paths = ensureRuntimeHomeLayout(home);
	const baseUrl = resolveReleaseUpdateBaseUrl(paths);
	const script = (await fetchBuffer(`${baseUrl}/install`, INSTALLER_SCRIPT_MAX_BYTES, 5000)).toString("utf8");
	return { installed: inspectInstalledRuntimeRelease(paths).releaseId, available: parseInstallerReleaseMetadata(script).releaseId };
};

const reapplyManagedRuntimeRelease = async (
	paths: RuntimePaths,
	release: DownloadedRuntimeRelease,
	specs: ManagedAdapterReinstallSpec[]
): Promise<{
	coreVersion: string;
	adapters: Array<{ name: RuntimeAdapterName; version: string }>;
}> => {
	const config = loadRuntimeConfig(paths);
	const nextRuntime = require(release.localRuntimeModulePath) as {
		installRuntimeCore: typeof installRuntimeCore;
		ONLYBOTS_RUNTIME_CORE_VERSION: string;
	};
	await nextRuntime.installRuntimeCore({
		home: paths.home,
		channel: config.channel,
		writeWrappers: true,
		cliScriptPath: release.cliScriptPath,
		daemonScriptPath: release.daemonScriptPath,
	});

	const adapters: Array<{ name: RuntimeAdapterName; version: string }> = [];
	for (const spec of specs) {
		if (spec.name === "codex") {
			const nextCodex = require(release.codexAdapterModulePath) as {
				installCodexAdapter: (options: Record<string, unknown>) => Promise<{ adapter: RuntimeAdapterRecord }>;
			};
			const result = await nextCodex.installCodexAdapter({
				home: paths.home,
				hostHome: spec.hostHome ?? undefined,
				profileName: spec.profileName,
				codexBinary: spec.codexBinary ?? undefined,
				bridgeScriptPath: path.join(release.releaseRoot, "dist", "runtime", "codex-bridge.js"),
				hookScriptPath: path.join(release.releaseRoot, "dist", "runtime", "codex-hook.js"),
			});
			adapters.push({
				name: "codex",
				version: result.adapter.version,
			});
			continue;
		}
		if (spec.name === "claude-code") {
			const nextClaude = require(release.claudeCodeAdapterModulePath) as {
				installClaudeCodeAdapter: (options: Record<string, unknown>) => Promise<{ adapter: RuntimeAdapterRecord }>;
			};
			const result = await nextClaude.installClaudeCodeAdapter({
				home: paths.home,
				hostHome: spec.hostHome ?? undefined,
				workspaceRoot: spec.workspaceRoot ?? undefined,
				profileName: spec.profileName,
				claudeBinary: spec.claudeBinary ?? undefined,
				bridgeScriptPath: path.join(release.releaseRoot, "dist", "runtime", "claude-code-bridge.js"),
				hookScriptPath: path.join(release.releaseRoot, "dist", "runtime", "claude-code-hook.js"),
			});
			adapters.push({
				name: "claude-code",
				version: result.adapter.version,
			});
			continue;
		}
		const nextPi = require(release.piAdapterModulePath) as {
			installPiAdapter: (options: Record<string, unknown>) => Promise<{ adapter: RuntimeAdapterRecord }>;
		};
		const result = await nextPi.installPiAdapter({
			home: paths.home,
			profileName: spec.profileName,
		});
		adapters.push({
			name: "pi",
			version: result.adapter.version,
		});
	}

	return {
		coreVersion: nextRuntime.ONLYBOTS_RUNTIME_CORE_VERSION,
		adapters,
	};
};

const restartRuntimeDaemonIfNeeded = async (
	paths: RuntimePaths,
	release: DownloadedRuntimeRelease,
	enabled: boolean
): Promise<{ restarted: boolean; port: number | null }> => {
	const daemonState = loadDaemonState(paths);
	const shouldRestart = enabled && daemonState.status === "running";
	if (!shouldRestart) {
		return {
			restarted: false,
			port: daemonState.port,
		};
	}
	const nextRuntime = require(release.localRuntimeModulePath) as {
		startDetachedRuntimeDaemon: typeof startDetachedRuntimeDaemon;
	};
	const preferredPort = daemonState.port ?? undefined;
	await stopDetachedRuntimeDaemon(paths.home);
	const restarted = await nextRuntime.startDetachedRuntimeDaemon({
		home: paths.home,
		port: preferredPort,
		daemonScriptPath: release.daemonScriptPath,
		organizationalWorkerConfigPath:
			daemonState.organizationalWorkerConfigPath ?? undefined,
	});
	return {
		restarted: true,
		port: restarted.port ?? null,
	};
};

export const formatRuntimeReleaseUpdate = (result: RuntimeReleaseUpdateResult): string => {
	const lines = [
		"Updated Crosshead runtime release",
		`source: ${result.baseUrl}`,
		`release: ${describeVersionDelta(result.previousReleaseId ?? "unmanaged", result.releaseId)}`,
		`core: ${result.coreVersion}`,
	];
	lines.push(
		`adapters: ${
			result.adapters.length === 0 ? "none installed" : result.adapters.map((adapter) => `${adapter.name}@${adapter.version}`).join(", ")
		}`
	);
	lines.push(
		`daemon: ${result.daemonRestarted ? `restarted${result.daemonPort ? ` on :${result.daemonPort}` : ""}` : "unchanged"}`
	);
	lines.push(`release_url: ${result.releaseUrl}`);
	return lines.join("\n");
};

export const updateManagedRuntimeRelease = async (
	home?: string,
	options: {
		baseUrl?: string;
		trustedSha256?: string;
		restart?: boolean;
	} = {}
): Promise<RuntimeReleaseUpdateResult> => {
	const paths = ensureRuntimeHomeLayout(home);
	const previousRelease = inspectInstalledRuntimeRelease(paths);
	const specs = await collectManagedAdapterReinstallSpecs(paths);
	const release = await downloadRuntimeRelease(paths, options.baseUrl, options.trustedSha256);
	// A release must not leave launchers pointing at a half-applied installation.
	// Keep credentials, memory and queued writes outside this file-level rollback.
	const protectedFiles = new Set([
		path.join(paths.config, "runtime.json"),
		path.join(paths.bin, "crosshead"), path.join(paths.bin, "xhd"),
		path.join(paths.bin, "onlybotsctl"), path.join(paths.bin, "crossheadd"), path.join(paths.bin, "onlybotsd"),
		...RUNTIME_ADAPTER_NAMES.flatMap(name => [
			path.join(paths.adapters, `${name}.json`),
			...(loadAdapterRecord(paths, name)?.managedFiles ?? []),
		]),
	]);
	for (const directory of [paths.versionsCore, ...RUNTIME_ADAPTER_NAMES.map(name => path.join(paths.versionsAdapters, name))]) {
		if (existsSync(directory)) for (const file of readdirSync(directory)) protectedFiles.add(path.join(directory, file));
	}
	const backup = [...protectedFiles].map(file => {
		if (!existsSync(file)) return { file, bytes: null, mode: 0o600 };
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error(`Refusing to update through non-regular managed file: ${file}`);
		}
		return { file, bytes: readFileSync(file), mode: stat.mode & 0o777 };
	});
	const priorDaemon = loadDaemonState(paths);
	let restartAttempted = false;
	try {
		const reapplied = await reapplyManagedRuntimeRelease(paths, release, specs);
		restartAttempted = options.restart !== false && priorDaemon.status === "running";
		const daemon = await restartRuntimeDaemonIfNeeded(paths, release, options.restart !== false);
		return {
			previousReleaseId: previousRelease.releaseId,
			releaseId: release.releaseId,
			releaseUrl: release.releaseUrl,
			baseUrl: release.baseUrl,
			coreVersion: reapplied.coreVersion,
			adapters: reapplied.adapters,
			daemonRestarted: daemon.restarted,
			daemonPort: daemon.port,
		};
	} catch (error) {
		for (const entry of backup) {
			if (entry.bytes === null) rmSync(entry.file, { force: true });
			else {
				writeManagedFile(entry.file, entry.bytes, path.dirname(entry.file));
				chmodSync(entry.file, entry.mode);
			}
		}
		if (restartAttempted && previousRelease.daemonScriptPath) {
			await stopDetachedRuntimeDaemon(paths.home);
			await startDetachedRuntimeDaemon({ home: paths.home, daemonScriptPath: previousRelease.daemonScriptPath, port: priorDaemon.port ?? undefined,
				organizationalWorkerConfigPath: priorDaemon.organizationalWorkerConfigPath ?? undefined });
		}
		throw error;
	}
};

export const updateRuntimeCatalogInstall = async (
	home: string,
	channel: RuntimeChannel,
	versionOverride?: string
): Promise<{
	coreVersion: string;
	adapters: Array<{ name: RuntimeAdapterName; version: string }>;
}> => {
	const paths = ensureRuntimeHomeLayout(home);
	const targetVersion = resolveCoreTargetVersion(channel, versionOverride);
	await updateRuntimeCoreVersion(paths.home, channel, targetVersion);
	const adapters: Array<{ name: RuntimeAdapterName; version: string }> = [];
	for (const adapter of listAdapterRecords(paths)) {
		if (!RUNTIME_ADAPTER_NAMES.includes(adapter.name as RuntimeAdapterName)) {
			continue;
		}
		const adapterName = adapter.name as RuntimeAdapterName;
		const adapterTargetVersion = resolveAdapterTargetVersion(adapterName, channel, versionOverride);
		await updateRuntimeAdapterVersion(paths.home, adapterName, adapterTargetVersion);
		adapters.push({
			name: adapterName,
			version: adapterTargetVersion,
		});
	}
	return {
		coreVersion: targetVersion,
		adapters,
	};
};

const updateRuntimeCoreVersion = async (home: string, channel: RuntimeChannel, targetVersion: string): Promise<void> => {
	const paths = ensureRuntimeHomeLayout(home);
	ensureCoreCompatibilityForTarget(paths, targetVersion);
	recordInstalledStateSnapshots(paths, "update");
	await installRuntimeCore({
		home,
		channel,
		coreVersion: targetVersion,
		writeWrappers: true,
		cliScriptPath: resolveCliScriptPath(),
		daemonScriptPath: resolveDaemonScriptPath(),
	});
	recordInstalledStateSnapshots(paths, "update");
};

export const updateRuntimeAdapterVersion = async (
	home: string,
	adapterName: RuntimeAdapterName,
	targetVersion: string
): Promise<void> => {
	const paths = ensureRuntimeHomeLayout(home);
	ensureAdapterCompatibilityForTarget(paths, adapterName, targetVersion);
	recordInstalledStateSnapshots(paths, "update");
	const existing = loadAdapterRecord(paths, adapterName);
	await installManagedAdapter(adapterName, {
		home,
		version: targetVersion,
		profileName: existing?.profileName ?? loadRuntimeConfig(paths).defaultProfile ?? "default",
		hostHome: existing?.hostHome,
	});
	recordInstalledStateSnapshots(paths, "update");
};

export const rollbackRuntimeCoreVersion = async (home: string, targetVersion: string): Promise<void> => {
	const paths = ensureRuntimeHomeLayout(home);
	const snapshot = loadCoreSnapshot(paths, targetVersion);
	if (!snapshot) {
		throw new Error(`No core snapshot is available for ${targetVersion}`);
	}
	ensureCoreCompatibilityForTarget(paths, targetVersion);
	recordInstalledStateSnapshots(paths, "rollback");
	await installRuntimeCore({
		home,
		channel: snapshot.channel,
		coreVersion: snapshot.version,
		writeWrappers: true,
		cliScriptPath: resolveCliScriptPath(),
		daemonScriptPath: resolveDaemonScriptPath(),
	});
	recordInstalledStateSnapshots(paths, "rollback");
};

export const rollbackRuntimeAdapterVersion = async (home: string, adapterName: RuntimeAdapterName, targetVersion: string): Promise<void> => {
	const paths = ensureRuntimeHomeLayout(home);
	const snapshot = loadAdapterSnapshot(paths, adapterName, targetVersion);
	if (!snapshot) {
		throw new Error(`No ${adapterName} snapshot is available for ${targetVersion}`);
	}
	ensureAdapterCompatibilityForTarget(paths, adapterName, targetVersion);
	recordInstalledStateSnapshots(paths, "rollback");
	await installManagedAdapter(adapterName, {
		home,
		version: snapshot.version,
		profileName: snapshot.profileName,
		hostHome: snapshot.hostHome,
	});
	recordInstalledStateSnapshots(paths, "rollback");
};

export const applyRuntimeManifest = async (home?: string, manifestPath?: string): Promise<{
	manifestPath: string;
	coreVersion: string;
	channel: RuntimeChannel;
	adapters: Partial<Record<RuntimeAdapterName, string>>;
	profileName: string | null;
}> => {
	const paths = ensureRuntimeHomeLayout(home);
	const { path: resolvedManifestPath, manifest } = loadRuntimeManifestFile(manifestPath);
	const config = loadRuntimeConfig(paths);
	const channel = manifest.channel ?? config.channel;
	const targetCoreVersion = manifest.core_version ?? resolveCoreTargetVersion(channel);
	const targetAdapters = manifest.adapters ?? {};

	for (const [adapterName, adapterVersion] of Object.entries(targetAdapters)) {
		if (!adapterVersion) {
			continue;
		}
		const reason = compatibilityReason(targetCoreVersion, adapterVersion);
		if (reason) {
			throw new Error(`Manifest is incompatible for ${adapterName}: ${reason}`);
		}
	}

	recordInstalledStateSnapshots(paths, "apply");
	await installRuntimeCore({
		home: paths.home,
		channel,
		coreVersion: targetCoreVersion,
		writeWrappers: true,
		cliScriptPath: resolveCliScriptPath(),
		daemonScriptPath: resolveDaemonScriptPath(),
	});

	const appliedAdapters: Partial<Record<RuntimeAdapterName, string>> = {};
	for (const adapterName of RUNTIME_ADAPTER_NAMES) {
		const targetVersion = targetAdapters[adapterName];
		if (!targetVersion) {
			continue;
		}
		const existing = loadAdapterRecord(paths, adapterName);
		await installManagedAdapter(adapterName, {
			home: paths.home,
			version: targetVersion,
			profileName: existing?.profileName ?? config.defaultProfile ?? "default",
			hostHome: existing?.hostHome,
		});
		appliedAdapters[adapterName] = targetVersion;
	}

	const updatedProfile = updateProfileFromManifest(paths, manifest);
	if (manifest.continuity_policy !== undefined) {
		saveContinuityPolicy(paths, resolveContinuityPolicy(manifest.continuity_policy));
	}
	recordInstalledStateSnapshots(paths, "apply");
	return {
		manifestPath: resolvedManifestPath,
		coreVersion: targetCoreVersion,
		channel,
		adapters: appliedAdapters,
		profileName: updatedProfile?.name ?? config.defaultProfile,
	};
};




const compatibilityReason = (coreVersion: string, adapterVersion: string): string | null => {
	const [coreMajor] = coreVersion.split(".");
	const [adapterMajor] = adapterVersion.split(".");
	return coreMajor === adapterMajor ? null : `Adapter ${adapterVersion} is incompatible with core ${coreVersion}`;
};

const parseVersionParts = (
	version: string
): { major: number; minor: number; patch: number; prerelease: string | null } => {
	const [main, prerelease] = version.split("-", 2);
	const [major, minor, patch] = main.split(".").map((value) => Number(value));
	return {
		major: Number.isFinite(major) ? major : 0,
		minor: Number.isFinite(minor) ? minor : 0,
		patch: Number.isFinite(patch) ? patch : 0,
		prerelease: prerelease ?? null,
	};
};

const compareVersions = (left: string, right: string): number => {
	const a = parseVersionParts(left);
	const b = parseVersionParts(right);
	if (a.major !== b.major) {
		return a.major - b.major;
	}
	if (a.minor !== b.minor) {
		return a.minor - b.minor;
	}
	if (a.patch !== b.patch) {
		return a.patch - b.patch;
	}
	if (a.prerelease === b.prerelease) {
		return 0;
	}
	if (a.prerelease === null) {
		return 1;
	}
	if (b.prerelease === null) {
		return -1;
	}
	return a.prerelease.localeCompare(b.prerelease);
};

const defaultRuntimeManifestPath = (manifestPath?: string): string =>
	path.resolve(manifestPath ?? (existsSync(path.join(process.cwd(), RUNTIME_MANIFEST_FILE)) || !existsSync(path.join(process.cwd(), "onlybots.runtime.json")) ? path.join(process.cwd(), RUNTIME_MANIFEST_FILE) : path.join(process.cwd(), "onlybots.runtime.json")));

const loadRuntimeManifestFile = (manifestPath?: string): { path: string; manifest: OnlyBotsRuntimeManifest } => {
	const resolvedPath = defaultRuntimeManifestPath(manifestPath);
	if (!existsSync(resolvedPath)) {
		throw new Error(`Runtime manifest not found: ${resolvedPath}`);
	}
	const manifest = parseJsonFile<OnlyBotsRuntimeManifest>(resolvedPath, {} as never);
	return {
		path: resolvedPath,
		manifest,
	};
};

const catalogEntryForChannel = (channel: RuntimeChannel): RuntimeReleaseChannelEntry => RUNTIME_RELEASE_CATALOG[channel];

export const resolveAdapterTargetVersion = (
	adapterName: RuntimeAdapterName,
	channel: RuntimeChannel,
	overrideVersion?: string
): string => overrideVersion ?? catalogEntryForChannel(channel).adapters[adapterName];

const resolveCoreTargetVersion = (channel: RuntimeChannel, overrideVersion?: string): string =>
	overrideVersion ?? catalogEntryForChannel(channel).coreVersion;

const handoffRecordFile = (paths: RuntimePaths, handoffId: string): string => {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(handoffId)) {
		throw new Error("handoff id is invalid");
	}
	return path.join(paths.stateHandoffs, `${handoffId}.json`);
};

const saveLocalHandoffRecord = (paths: RuntimePaths, record: HandoffStoredRecord): void => {
	writeJsonFile(handoffRecordFile(paths, record.handoffId), record);
};

const loadLocalHandoffRecord = async (paths: RuntimePaths, handoffId: string): Promise<HandoffStoredRecord> => {
	const file = handoffRecordFile(paths, handoffId);
	if (!existsSync(file)) throw new Error(`Local handoff ${handoffId} was not found; import a signed capsule file instead`);
	const record = parseJsonFile<HandoffStoredRecord | null>(file, null);
	if (!record?.capsule) throw new Error(`Local handoff ${handoffId} is corrupt`);
	const validation = await verifyHandoffCapsule(record.capsule);
	if (!validation.valid || record.handoffId !== record.capsule.capsuleId) {
		throw new Error(`Local handoff ${handoffId} failed verification: ${validation.errors.join("; ")}`);
	}
	return {
		...record,
		validation,
		inspection: await inspectHandoffCapsule(record.capsule),
		outcomes: Array.isArray(record.outcomes) ? record.outcomes : [],
	};
};

const updateProfileFromManifest = (paths: RuntimePaths, manifest: OnlyBotsRuntimeManifest): RuntimeProfile | null => {
	const config = loadRuntimeConfig(paths);
	if (!config.defaultProfile) {
		return null;
	}
	const profile = loadProfile(paths, config.defaultProfile);
	if (!profile) {
		return null;
	}
	const updated: RuntimeProfile = {
		...profile,
		memoryMode: manifest.memory_mode ?? profile.memoryMode,
		workspaceScope: manifest.workspace_scope ?? profile.workspaceScope,
		features: {
			...profile.features,
			...(manifest.features ?? {}),
		},
		updatedAt: nowIso(),
	};
	saveProfile(paths, updated);
	return updated;
};

export const describeVersionDelta = (current: string, target: string): string =>
	current === target ? `${current} (current)` : `${current} -> ${target}`;

const ensureCoreCompatibilityForTarget = (paths: RuntimePaths, targetCoreVersion: string): void => {
	for (const adapter of listAdapterRecords(paths)) {
		const reason = compatibilityReason(targetCoreVersion, adapter.version);
		if (reason) {
			throw new Error(`Cannot update core: ${adapter.name} ${adapter.version} would become incompatible. ${reason}`);
		}
	}
};

const ensureAdapterCompatibilityForTarget = (paths: RuntimePaths, adapterName: RuntimeAdapterName, targetAdapterVersion: string): void => {
	const config = loadRuntimeConfig(paths);
	const reason = compatibilityReason(config.coreVersion, targetAdapterVersion);
	if (reason) {
		throw new Error(`Cannot update ${adapterName}: ${reason}`);
	}
};

const resolveCliScriptPath = (): string => path.resolve(__dirname, "cli.js");
const resolveDaemonScriptPath = (): string => path.resolve(__dirname, "daemon.js");
const resolveCodexBridgeScriptPath = (): string => path.resolve(__dirname, "codex-bridge.js");
const resolveCodexHookScriptPath = (): string => path.resolve(__dirname, "codex-hook.js");
const resolveClaudeBridgeScriptPath = (): string => path.resolve(__dirname, "claude-code-bridge.js");
const resolveClaudeHookScriptPath = (): string => path.resolve(__dirname, "claude-code-hook.js");

const CONSOLE_CHALLENGE_PATTERN = /^(onlybots_link_[A-Za-z0-9_-]{20,128}|onlybots_org_attach_v1:[A-Za-z0-9_.:-]{20,400})$/;

export class OnlyBotsLocalRuntimeDaemon {
	private server: HttpServer | null = null;
	private ownership: RuntimeDaemonOwnership | null = null;
	private readonly runtimeCleanup: () => Promise<void>;
	private startPromise: Promise<RuntimeDaemonState> | null = null;
	private stopPromise: Promise<void> | null = null;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private readonly paths: RuntimePaths;
	private readonly lifecycleManager: RuntimeLifecycleManager;
	private readonly organizationalWorker: OrganizationalWorkerDaemonApi | null;
	private readonly organizationalWorkerFederationStatusObserver: OrganizationalWorkerFederationStatusObserver | null;
	private readonly workerReadiness: OrganizationalWorkerReadiness;
	private readonly organizationalWorkerConfigPath: string | null;

	constructor(home?: string, options: LocalRuntimeDaemonOptions = {}) {
		this.paths = resolveRuntimePaths(home);
		this.runtimeCleanup = options.runtimeCleanup ?? (async () => {});
		this.organizationalWorker = options.organizationalWorker ?? null;
		this.organizationalWorkerFederationStatusObserver =
			options.organizationalWorkerFederationStatusObserver ?? null;
		if (
			options.organizationalWorkerConfigPath !== undefined &&
			!path.isAbsolute(options.organizationalWorkerConfigPath)
		) {
			throw new Error("organizational worker config path must be absolute");
		}
		this.organizationalWorkerConfigPath = options.organizationalWorkerConfigPath
			? path.resolve(options.organizationalWorkerConfigPath)
			: null;
		this.workerReadiness = normalizeOrganizationalWorkerReadiness(
			options.organizationalWorkerReadiness,
			this.organizationalWorker !== null,
			isConstructedOrganizationalWorkerLocalApi(this.organizationalWorker)
		);
		validateOrganizationalWorkerApi(this.organizationalWorker, this.workerReadiness);
		this.lifecycleManager = new RuntimeLifecycleManager({
			paths: {
				state: this.paths.state,
			},
			loadDefaultProfileName: () => loadRuntimeConfig(this.paths).defaultProfile,
			loadProfile: (name) => {
				const profile = loadProfile(this.paths, name);
				return profile
					? {
							name: profile.name,
							apiBase: profile.apiBase,
							npub: profile.npub,
							memoryMode: profile.memoryMode,
							features: {
								coldSync: profile.features.coldSync,
								autoWarmPromotion: profile.features.autoWarmPromotion,
							},
						}
					: null;
			},
			loadSecret: (name) => loadSecret(this.paths, name),
			saveSecret: (name, secret) => saveSecret(this.paths, name, secret),
			loadHealth: () => loadHealthState(this.paths) as RuntimeLifecycleHealthState,
			saveHealth: (state) => saveHealthState(this.paths, state as RuntimeHealthState),
			loadContinuityGovernorState: () => loadEffectiveContinuityGovernorState(this.paths).governorState,
			writeLog: (event, payload) => writeRuntimeLog(this.paths, event, payload),
			hotWriteDebounceMs: options.hotWriteDebounceMs,
			coldBatchWindowMs: options.coldBatchWindowMs,
			workerIntervalMs: options.backgroundIntervalMs,
			maxQueueDepth: options.maxQueueDepth,
			maxQueueAttempts: options.maxQueueAttempts,
		});
	}

	private syncDreamReviewHud(profileName: string, result: Record<string, unknown>): void {
		const inspection =
			result.inspection && typeof result.inspection === "object" && !Array.isArray(result.inspection)
				? result.inspection
				: result;
		updateRuntimeDreamReviewHudSnapshotFromInspection(this.paths.state, profileName, inspection);
	}

	async start(port: number = 0, ownership?: RuntimeDaemonOwnership): Promise<RuntimeDaemonState> {
		if (this.server || this.startPromise) throw new Error("Local runtime daemon is already running or starting");
		if (this.stopPromise) throw new Error("Local runtime daemon is stopping");
		const operation = this.startDaemon(port, ownership);
		this.startPromise = operation;
		try {
			return await operation;
		} finally {
			if (this.startPromise === operation) this.startPromise = null;
		}
	}

	private async startDaemon(port: number, acquired?: RuntimeDaemonOwnership): Promise<RuntimeDaemonState> {
		const ownership = acquired ?? await acquireRuntimeDaemonOwnership(this.paths.home);
		ownership.claim(this.paths);
		this.ownership = ownership;
		let server: HttpServer | null = null;
		try {
			// Layout repairs and composition side effects occur only with ownership.
			ensureRuntimeHomeLayout(this.paths.home);
			const daemonState = loadDaemonState(this.paths);
			server = createServer(async (request, response) => handleRuntimeDaemonRequest(this, this.paths, request, response));
			await new Promise<void>((resolve, reject) => {
				server!.once("error", reject);
				server!.listen(port, "127.0.0.1", () => resolve());
			});
			const address = server.address();
			const boundPort = typeof address === "object" && address ? address.port : null;
			if (!boundPort || !ownership.alive()) throw new Error("Failed to bind owned daemon port");
			saveDaemonState(this.paths, {
				...daemonState, ownerId: ownership.ownerId, ownerProcess: ownership.ownerProcess,
				controlToken: randomUUID(), status: "running", port: boundPort, pid: process.pid,
				organizationalWorkerConfigPath: this.organizationalWorkerConfigPath,
				startedAt: nowIso(), lastHeartbeat: nowIso(), lastError: null,
			});
			this.server = server;
			if (hotSyncEnabled()) for (const file of readdirSync(this.paths.profiles).filter(name => name.endsWith(".json"))) {
				const name = file.slice(0, -5), profile = loadProfile(this.paths, name), secret = loadSecret(this.paths, name);
				if (profile && secret && !isLocalOnlyRuntimeProfile(profile)) getHotSyncManager({stateDir:this.paths.state,origin:profile.apiBase,npub:profile.npub,nsec:secret.nsec,profileName:name});
			}
			this.lifecycleManager.start();
			this.heartbeatTimer = setInterval(() => {
				try {
					const current = readDaemonOwnershipState(this.paths);
					if (!ownership.isCurrent(current)) throw new Error("Daemon ownership was lost");
					saveDaemonState(this.paths, { ...current!, lastHeartbeat: nowIso() });
				} catch {
					void this.stop().catch(() => undefined);
				}
			}, 1_000);
			writeRuntimeLog(this.paths, "daemon.start", { port: boundPort, ownerId: ownership.ownerId });
			return loadDaemonState(this.paths);
		} catch (error) {
			if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
			const failures = await this.quiesceRuntime(server);
			this.server = null;
			try {
				const current = readDaemonOwnershipState(this.paths);
				if (ownership.isCurrent(current)) saveDaemonState(this.paths, {
					...current!, status: "stopped", port: null, pid: null,
					lastHeartbeat: nowIso(), lastError: "Daemon startup failed",
				});
			} finally { this.ownership = null; await ownership.close(); }
			if (failures.length) throw new AggregateError([error, ...failures], "Daemon startup and cleanup failed");
			throw error;
		}
	}

	/** Every HTTP route, including health and federation, requires this owner. */
	ownsRuntimeHome(): boolean {
		try {
			const state = readDaemonOwnershipState(this.paths);
			return state?.status === "running" && this.ownership?.isCurrent(state) === true;
		} catch { return false; }
	}

	async stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		const operation = this.stopDaemon();
		this.stopPromise = operation;
		try {
			await operation;
		} finally {
			if (this.stopPromise === operation) this.stopPromise = null;
		}
	}

	private async stopDaemon(): Promise<void> {
		if (this.startPromise) await this.startPromise.catch(() => undefined);
		const ownership = this.ownership;
		if (!ownership) return;
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		const failures = await this.quiesceRuntime(this.server);
		this.server = null;
		try {
			const current = readDaemonOwnershipState(this.paths);
			if (ownership.isCurrent(current)) {
				saveDaemonState(this.paths, { ...current!, status: "stopped", port: null, pid: null, lastHeartbeat: nowIso(),
					lastError: failures.length ? "Daemon shutdown cleanup failed" : null });
				writeRuntimeLog(this.paths, "daemon.stop", { ownerId: ownership.ownerId });
			}
		} finally { this.ownership = null; await ownership.close(); }
		if (failures.length) throw failures[0];
	}

	private async quiesceRuntime(server: HttpServer | null): Promise<unknown[]> {
		const closeServer = server?.listening ? new Promise<void>((resolve, reject) =>
			server.close((error) => error ? reject(error) : resolve())) : Promise.resolve();
		// All cleanup attempts finish before releasing ownership. One failure must
		// not leave a listener or background lifecycle writer in another owner's home.
		const failures: unknown[] = [];
		// Observe close rejection immediately, but quiesce requests before the
		// final lifecycle flush so an in-flight handler cannot enqueue afterward.
		const closed = closeServer.catch(error => { failures.push(error); });
		try { await this.organizationalWorker?.shutdown?.(); } catch (error) { failures.push(error); }
		await closed;
		try { await this.lifecycleManager.stop(); } catch (error) { failures.push(error); }
		try { await stopHotSyncManagers(this.paths.state); } catch (error) { failures.push(error); }
		try { await this.runtimeCleanup(); } catch (error) { failures.push(error); }
		return failures;
	}

	async status(profileName?: string): Promise<RuntimeStatus> {
		return buildRuntimeStatus(this.paths, profileName);
	}

	async doctor(profileName?: string): Promise<RuntimeDoctorReport> {
		return buildDoctorReport(this.paths, profileName);
	}

	organizationalWorkerAvailable(): boolean {
		return this.organizationalWorkerSupports("assignmentAcceptance");
	}

	inspectOrganizationalWorkerReadiness(): OrganizationalWorkerReadiness {
		return cloneOrganizationalWorkerReadiness(this.workerReadiness);
	}

	organizationalWorkerSupports(capability: OrganizationalWorkerCapability): boolean {
		return this.organizationalWorker !== null && this.workerReadiness.capabilities[capability];
	}

	organizationalWorkerFederationStatusObserverAvailable(): boolean {
		return this.organizationalWorkerFederationStatusObserver !== null;
	}

	observeOrganizationalWorkerFederationStatus(
		request: OrganizationalWorkerFederationStatusRequest
	) {
		if (!this.organizationalWorkerFederationStatusObserver) {
			throw new Error("organizational worker federation status observer is unavailable");
		}
		return this.organizationalWorkerFederationStatusObserver.observe(request);
	}

	private requireOrganizationalWorker(
		capability: OrganizationalWorkerCapability
	): OrganizationalWorkerDaemonApi {
		if (!this.organizationalWorkerSupports(capability)) {
			throw new OrganizationalWorkerCapabilityUnavailableError(
				capability,
				this.inspectOrganizationalWorkerReadiness()
			);
		}
		return this.organizationalWorker!;
	}

	issueOrganizationalWorkerFederationBinding(value: unknown) {
		return this.requireOrganizationalWorker("federationBindings").issueFederationBinding(value);
	}

	inspectOrganizationalWorkerFederationBinding(input: {
		organizationId: string;
		agentId: string;
		bindingRef: string;
	}) {
		return this.requireOrganizationalWorker("federationBindings").inspectFederationBinding(input);
	}

	acceptOrganizationalWorkerAssignment(value: unknown) {
		return this.requireOrganizationalWorker("assignmentAcceptance").acceptAssignment(value);
	}

	executeOrganizationalWorkerAssignment(assignmentId: string) {
		return this.requireOrganizationalWorker("execution").executeAssignment(assignmentId);
	}

	cancelOrganizationalWorkerAssignment(value: unknown) {
		return this.requireOrganizationalWorker("cancellation").requestCancellation(value);
	}

	recoverOrganizationalWorkerAssignments() {
		return this.requireOrganizationalWorker("recovery").recoverInterrupted();
	}

	resumeOrganizationalWorkerAssignment(assignmentId: string) {
		return this.requireOrganizationalWorker("execution").resumePreEffect(assignmentId);
	}

	flushOrganizationalWorkerOutbox(assignmentId?: string) {
		return this.requireOrganizationalWorker("outboxDelivery").flushOutbox(assignmentId);
	}

	inspectOrganizationalWorkerAssignment(assignmentId: string) {
		return this.requireOrganizationalWorker("assignmentInspection").inspectAssignment(assignmentId);
	}

	listOrganizationalWorkerAssignments() {
		return this.requireOrganizationalWorker("assignmentInspection").listAssignments();
	}

	inspectOrganizationalWorkerDelivery() {
		const worker = this.requireOrganizationalWorker("assignmentInspection");
		if (!worker.inspectDelivery) {
			throw new Error("organizational worker delivery inspection is unavailable");
		}
		return worker.inspectDelivery();
	}

	synchronizeOrganizationalWorkerDelivery() {
		const worker = this.requireOrganizationalWorker("assignmentAcceptance");
		if (!worker.synchronizeDelivery) {
			throw new Error("organizational worker delivery synchronization is unavailable");
		}
		return worker.synchronizeDelivery();
	}

	async submitLifecycleEvent(request: RuntimeLifecycleEventRequest): Promise<RuntimeLifecycleEventResponse> {
		return this.lifecycleManager.handleEvent(request);
	}

	async flushBackgroundWork(force: boolean = true): Promise<void> {
		await this.lifecycleManager.flushDueItems(force);
	}

	async readActivity(lines: number = 50): Promise<RuntimeLifecycleActivity> {
		return this.lifecycleManager.readActivity(lines);
	}

	async prepareContextPack(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const continuity = loadEffectiveContinuityGovernorState(this.paths);
		const result = await client.prepareContextPack(applyGovernorMemoryScope(payload, continuity.governorState.memoryScope));
		await this.persistSession(resolvedProfileName, secret, client);
		await this.lifecycleManager.recordContextPackResult(resolvedProfileName, result, "command");
		return result;
	}

	async inspectContextPack(packId: string, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({
			profileName,
		});
		const result = await client.inspectContextPack(packId);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async inspectContinuityJudgment(profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({
			profileName,
		});
		const result = await client.inspectContinuityJudgment();
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async inspectContinuity(profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({
			profileName,
		});
		const result = await client.inspectContinuity();
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async inspectBillingAccount(profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({
			profileName,
		});
		const result = await client.getBillingAccount();
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async joinOrganization(request: { code: string; agentId?: string }, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({ profileName });
		const result = await client.joinOrganization({
			code: request.code,
			...(request.agentId ? { agent_id: request.agentId } : {}),
		});
		await this.persistSession(resolvedProfileName, secret, client);
		writeRuntimeLog(this.paths, "organization.join", {
			profileName: resolvedProfileName,
			organizationId: result.organization_id ?? null,
		});
		return result;
	}

	/**
	 * Signs a fleet console challenge (npub link or organization attachment) with this
	 * agent's key. Only Crosshead console challenges are accepted, so the command can't be
	 * used to sign arbitrary messages such as Nostr event ids.
	 */
	signConsoleChallenge(
		challenge: string,
		options: { profileName?: string; npub?: string } = {},
	): { npub: string; signature: string; profileName: string } {
		const text = challenge.trim();
		if (!CONSOLE_CHALLENGE_PATTERN.test(text)) {
			throw new Error("That isn't a Crosshead console challenge. Copy the full text that starts with onlybots_link_ or onlybots_org_attach_v1:");
		}
		const attachNpub = text.startsWith("onlybots_org_attach_v1:") ? text.split(":")[3] : null;
		const wantedNpub = options.npub?.trim() || attachNpub;
		if (options.npub && attachNpub && options.npub.trim() !== attachNpub) {
			throw new Error(`This challenge is for ${attachNpub}, not ${options.npub.trim()}.`);
		}
		const config = loadRuntimeConfig(this.paths);
		// With an npub and no explicit profile, use whichever profile on this machine holds that key.
		const resolvedProfileName =
			options.profileName ??
			(wantedNpub ? this.profileNameForNpub(wantedNpub) : null) ??
			config.defaultProfile;
		if (!resolvedProfileName) {
			throw new Error("No runtime profile is configured");
		}
		const { profile, secret } = this.loadProfileClient(resolvedProfileName);
		const decoded = nip19.decode(secret.nsec);
		if (decoded.type !== "nsec") {
			throw new Error("runtime secret is not a valid nsec");
		}
		if (wantedNpub && wantedNpub !== profile.npub) {
			throw new Error(
				options.profileName
					? `This challenge is for ${wantedNpub}, but profile ${resolvedProfileName} is ${profile.npub}.`
					: `No Crosshead profile on this machine has the key for ${wantedNpub}. Run this on the machine where that agent runs, or pass --home for its Crosshead folder.`,
			);
		}
		const signature = Buffer.from(schnorr.sign(new TextEncoder().encode(text), decoded.data)).toString("hex");
		writeRuntimeLog(this.paths, "console.challenge_signed", { profileName: resolvedProfileName, kind: attachNpub ? "organization_attach" : "npub_link" });
		return { npub: profile.npub, signature, profileName: resolvedProfileName };
	}

	async createBillingCheckout(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const result = await client.createBillingCheckout({
			credit_units: Number(payload.credit_units),
			...(typeof payload.success_url === "string" ? { success_url: payload.success_url } : {}),
			...(typeof payload.cancel_url === "string" ? { cancel_url: payload.cancel_url } : {}),
		});
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async createBillingDepositInvoice(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const result = await client.createBillingDepositInvoice(Number(payload.amount_sats));
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async listBillingInvoices(request: Record<string, unknown> = {}, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const result = await client.listBillingInvoices({
			...(typeof payload.status === "string" ? { status: payload.status } : {}),
			...(typeof payload.created_after === "string" ? { created_after: payload.created_after } : {}),
			...(typeof payload.created_before === "string" ? { created_before: payload.created_before } : {}),
			...(typeof payload.paid_after === "string" ? { paid_after: payload.paid_after } : {}),
			...(typeof payload.paid_before === "string" ? { paid_before: payload.paid_before } : {}),
			...(typeof payload.limit === "number" ? { limit: payload.limit } : {}),
		});
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async inspectBillingInvoice(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const invoiceId = typeof payload.invoice_id === "string" ? payload.invoice_id.trim() : "";
		const paymentHash = typeof payload.payment_hash === "string" ? payload.payment_hash.trim() : "";
		const result = invoiceId
			? await client.getBillingInvoice(invoiceId)
			: await client.getBillingInvoiceByPaymentHash(paymentHash);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async inspectDreams(
		request: { proposalId?: string; runId?: string; status?: string } = {},
		profileName?: string
	): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({
			profileName,
		});
		const result = await client.inspectDreams(request);
		this.syncDreamReviewHud(resolvedProfileName, result);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async runDreamJob(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const result = await client.runDreamJob(payload);
		this.syncDreamReviewHud(resolvedProfileName, result);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async inspectObligations(
		request: { statuses?: string[]; includeTerminal?: boolean; limit?: number } = {},
		profileName?: string
	): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({
			profileName,
		});
		const result = await client.inspectObligations(request);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async reviewDreamProposal(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const result = await client.reviewDreamProposal(payload);
		this.syncDreamReviewHud(resolvedProfileName, result);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async reviewSelfModel(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const result = await client.reviewSelfModel(payload);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async createHandoff(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		if (!payload.translation || typeof payload.translation !== "object" || Array.isArray(payload.translation)) {
			throw new Error("handoff create requires a translation payload");
		}
		const profile = loadProfile(this.paths, resolvedProfileName);
		if (!profile) throw new Error(`Runtime profile not found: ${resolvedProfileName}`);
		const record = await createSignedHandoffCapsule({
			translation: payload.translation as never,
			signedBy: profile.npub,
			signingNsec: secret.nsec,
			maxBytes: typeof payload.maxBytes === "number" ? payload.maxBytes : undefined,
		});
		saveLocalHandoffRecord(this.paths, record);
		const result = {
			handoff: record,
			capsule: record.capsule,
			verification: record.validation,
			inspection: record.inspection,
		};
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async verifyHandoff(request: Record<string, unknown>, _profileName?: string): Promise<Record<string, unknown>> {
		return await verifyHandoffCapsule(request.capsule) as unknown as Record<string, unknown>;
	}

	async inspectHandoff(request: Record<string, unknown>, _profileName?: string): Promise<Record<string, unknown>> {
		return await inspectHandoffCapsule(request.capsule) as unknown as Record<string, unknown>;
	}

	async readHandoff(handoffId: string, _profileName?: string): Promise<Record<string, unknown>> {
		return await loadLocalHandoffRecord(this.paths, handoffId) as unknown as Record<string, unknown>;
	}

	async acknowledgeHandoff(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		void profileName;
		const handoffId = typeof request.handoffId === "string" ? request.handoffId :
			typeof request.handoff_id === "string" ? request.handoff_id : "";
		if (!handoffId) throw new Error("handoff_id is required");
		const record = await loadLocalHandoffRecord(this.paths, handoffId);
		const accepted = request.accepted === true || request.status === "acknowledged";
		const rejected = request.accepted === false || request.status === "rejected";
		if (!accepted && !rejected) throw new Error("accepted boolean or status is required");
		const receipt = request.receipt && typeof request.receipt === "object" && !Array.isArray(request.receipt)
			? request.receipt as HandoffStoredRecord["receipt"] : record.receipt;
		const updated: HandoffStoredRecord = {
			...record,
			updatedAt: nowIso(),
			state: accepted ? "acknowledged" : "rejected",
			note: typeof request.note === "string" ? request.note : null,
			receipt,
		};
		saveLocalHandoffRecord(this.paths, updated);
		return updated as unknown as Record<string, unknown>;
	}

	async recordHandoffOutcome(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		void profileName;
		const handoffId = typeof request.handoffId === "string" ? request.handoffId :
			typeof request.handoff_id === "string" ? request.handoff_id : "";
		if (!handoffId) throw new Error("handoff_id is required");
		const kind = request.kind;
		if (!["accepted", "rejected", "completed", "failed", "corrected"].includes(String(kind))) {
			throw new Error("handoff outcome kind must be accepted, rejected, completed, failed, or corrected");
		}
		const reporterRuntime = request.reporterRuntime ?? request.reporter_runtime;
		if (reporterRuntime !== "codex" && reporterRuntime !== "claude-code") {
			throw new Error("handoff outcome reporterRuntime must be codex or claude-code");
		}
		const record = await loadLocalHandoffRecord(this.paths, handoffId);
		const updated: HandoffStoredRecord = {
			...record,
			updatedAt: nowIso(),
			outcomes: [...record.outcomes, {
				outcomeId: randomUUID(), kind: kind as never, reportedAt: nowIso(), reporterRuntime,
				reporterSessionId: typeof request.reporterSessionId === "string" ? request.reporterSessionId : null,
				reporterWorkspaceId: typeof request.reporterWorkspaceId === "string" ? request.reporterWorkspaceId : null,
				summary: typeof request.summary === "string" ? request.summary : null,
				details: typeof request.details === "string" ? request.details : null,
				taskSucceeded: typeof request.taskSucceeded === "boolean" ? request.taskSucceeded : null,
				changedDirection: request.changedDirection === true || kind === "corrected",
				nextAction: typeof request.nextAction === "string" ? request.nextAction : null,
				resultingHandoffId: typeof request.resultingHandoffId === "string" ? request.resultingHandoffId : null,
				continuityOutcomeEventId: typeof request.continuityOutcomeEventId === "string" ? request.continuityOutcomeEventId : null,
				signals: request.signals && typeof request.signals === "object" && !Array.isArray(request.signals)
					? request.signals as never
					: { projectDirection: [], openQuestions: [], rejectedAlternatives: [], unresolvedRisks: [], demonstratedKnowledge: [], recentCorrections: [], orientation: [], redundancyMarkers: [] },
			}],
		};
		saveLocalHandoffRecord(this.paths, updated);
		return updated as unknown as Record<string, unknown>;
	}

	async mintHandoffTrustReceipt(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const readStringValue = (...values: unknown[]): string | undefined => {
			for (const value of values) {
				if (typeof value === "string" && value.trim().length > 0) {
					return value.trim();
				}
			}
			return undefined;
		};
		const handoffId = readStringValue(request.handoffId, request.handoff_id, request.id);
		if (!handoffId) {
			throw new Error("handoff_id is required to mint a trust receipt");
		}
		const outcomeId = readStringValue(request.outcomeId, request.outcome_id);
		const signedAt = readStringValue(request.signedAt, request.signed_at);
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({
			profileName,
		});
		const record = await loadLocalHandoffRecord(this.paths, handoffId);
		const inspection = await this.inspectPersistentAgent(undefined, resolvedProfileName);
		const result = await mintTrustReceiptFromHandoffRecord({
			currentAgentRef: inspection.agent.agentRef,
			currentAgentNsec: secret.nsec,
			currentAgentNpub: inspection.agent.agentRef.npub,
			record: record as any,
			outcomeId: outcomeId ?? null,
			signedAt: signedAt ?? undefined,
		});
		await this.persistSession(resolvedProfileName, secret, client);
		return result as unknown as Record<string, unknown>;
	}

	async inspectPersistentAgent(agentId?: string, profileName?: string): Promise<PersistentAgentInspection> {
		const config = loadRuntimeConfig(this.paths);
		const resolvedProfileName = profileName ?? config.defaultProfile;
		let profile: RuntimeProfile | null = null;
		if (resolvedProfileName) {
			const loaded = loadProfile(this.paths, resolvedProfileName);
			if (loaded) {
				profile = ensureProfileAgentIdentity(this.paths, loaded);
			}
		}

		const continuityPolicyState = loadContinuityPolicyState(this.paths);
		const effectiveAgentId =
			agentId ??
			profile?.agentId ??
			(resolvedProfileName ? normalizePersistentAgentId(resolvedProfileName) : null);
		if (!effectiveAgentId) {
			throw new Error("No runtime profile or agent id is available for inspection");
		}

		const profileOwnsAgent = profile?.agentId === effectiveAgentId;
		const entity =
			(profile && profileOwnsAgent
				? ensurePersistentAgentForProfile(this.paths, profile, {
						continuityPolicyRef: continuityPolicyState.policy.policyId,
					}).entity
				: loadPersistentAgentEntity(this.paths, effectiveAgentId)) ?? null;
		if (!entity) {
			throw new Error(`Unknown persistent agent: ${effectiveAgentId}`);
		}

		return await buildPersistentAgentInspection({
			agent: entity,
			profile: profile && profile.agentId === entity.agentRef.agentId ? toRuntimePersistentAgentProfile(profile) : null,
			passport: loadPersistentAgentPassport(this.paths, entity.agentRef.agentId),
			entities: listPersistentAgentEntities(this.paths),
			lineageLinks: listPersistentAgentLineageLinks(this.paths),
			inheritanceBoundaries: listPersistentAgentInheritanceBoundaries(this.paths),
		});
	}

	async inspectPersistentAgentLineage(
		agentId?: string,
		profileName?: string
	): Promise<PersistentAgentLineageInspection> {
		const inspection = await this.inspectPersistentAgent(agentId, profileName);
		return inspection.lineage;
	}

	async setPersistentAgentEngineAttachment(request: {
		agentId?: string;
		profileName?: string;
		runtimeHost?: string;
		provider?: string | null;
		modelFamily?: string | null;
		modelId?: string | null;
		hostVersion?: string | null;
		promptTransport?: string | null;
		portabilityNotes?: string[];
		continuityFidelityNotes?: string[];
		compensationHints?: string[];
		reason?: string | null;
	}): Promise<PersistentAgentInspection> {
		const config = loadRuntimeConfig(this.paths);
		const resolvedProfileName = request.profileName ?? config.defaultProfile;
		let profile: RuntimeProfile | null = null;
		if (resolvedProfileName) {
			const loaded = loadProfile(this.paths, resolvedProfileName);
			if (loaded) {
				profile = ensureProfileAgentIdentity(this.paths, loaded);
			}
		}

		const continuityPolicyState = loadContinuityPolicyState(this.paths);
		const effectiveAgentId =
			request.agentId ??
			profile?.agentId ??
			(resolvedProfileName ? normalizePersistentAgentId(resolvedProfileName) : null);
		if (!effectiveAgentId) {
			throw new Error("No runtime profile or agent id is available for engine attachment updates");
		}

		const profileOwnsAgent = profile?.agentId === effectiveAgentId;
		const entity =
			(profile && profileOwnsAgent
				? ensurePersistentAgentForProfile(this.paths, profile, {
						continuityPolicyRef: continuityPolicyState.policy.policyId,
					}).entity
				: loadPersistentAgentEntity(this.paths, effectiveAgentId)) ?? null;
		if (!entity) {
			throw new Error(`Unknown persistent agent: ${effectiveAgentId}`);
		}

		const attachedAt = nowIso();
		const runtimeHost =
			request.runtimeHost?.trim() ||
			entity.currentEngineAttachment?.runtimeHost ||
			entity.currentRuntimeAttachments[0]?.runtimeHost ||
			null;
		if (!runtimeHost) {
			throw new Error("engine attachment updates require --runtime-host when no current runtime host can be inferred");
		}

		if (
			!request.provider &&
			!request.modelFamily &&
			!request.modelId &&
			!entity.currentEngineAttachment?.provider &&
			!entity.currentEngineAttachment?.modelFamily &&
			!entity.currentEngineAttachment?.modelId
		) {
			throw new Error("engine attachment updates require at least one of --provider, --model-family, or --model-id");
		}

		const history: EngineAttachment[] = [...entity.engineAttachmentHistory];
		if (entity.currentEngineAttachment) {
			history.push({
				...entity.currentEngineAttachment,
				detachedAt: attachedAt,
			});
		}

		const attachmentId = `engine_attach_${sanitizePersistentAgentToken(
			[
				runtimeHost,
				request.provider ?? entity.currentEngineAttachment?.provider ?? "unknown",
				request.modelFamily ?? request.modelId ?? entity.currentEngineAttachment?.modelFamily ?? "engine",
			].join("_"),
			"engine"
		)}`;

		const currentEngineAttachment = buildEngineAttachment({
			attachmentId,
			provider: request.provider ?? entity.currentEngineAttachment?.provider ?? null,
			modelFamily: request.modelFamily ?? entity.currentEngineAttachment?.modelFamily ?? null,
			modelId: request.modelId ?? entity.currentEngineAttachment?.modelId ?? null,
			runtimeHost,
			hostVersion: request.hostVersion ?? entity.currentEngineAttachment?.hostVersion ?? null,
			promptTransport: request.promptTransport ?? entity.currentEngineAttachment?.promptTransport ?? null,
			attachedAt,
			portabilityNotes: request.portabilityNotes ?? entity.currentEngineAttachment?.portabilityNotes ?? [],
			continuityFidelityNotes:
				request.continuityFidelityNotes ?? entity.currentEngineAttachment?.continuityFidelityNotes ?? [],
			compensationHints: request.compensationHints ?? entity.currentEngineAttachment?.compensationHints ?? [],
		});

		const updatedEntity: PersistentAgentEntity = {
			...entity,
			currentEngineAttachment,
			engineAttachmentHistory: history,
			notes: uniqueStrings([
				...entity.notes,
				request.reason
					? `Engine attachment updated: ${request.reason}`
					: `Engine attachment updated at ${attachedAt}.`,
			]),
		};
		savePersistentAgentEntity(this.paths, updatedEntity);

		return await buildPersistentAgentInspection({
			agent: updatedEntity,
			profile: profile && profile.agentId === updatedEntity.agentRef.agentId ? toRuntimePersistentAgentProfile(profile) : null,
			passport: loadPersistentAgentPassport(this.paths, updatedEntity.agentRef.agentId),
			entities: listPersistentAgentEntities(this.paths),
			lineageLinks: listPersistentAgentLineageLinks(this.paths),
			inheritanceBoundaries: listPersistentAgentInheritanceBoundaries(this.paths),
		});
	}

	async forkPersistentAgentIdentity(request: Record<string, unknown>): Promise<Record<string, unknown>> {
		const config = loadRuntimeConfig(this.paths);
		const parentProfileName =
			(typeof request.profileName === "string"
				? request.profileName
				: typeof request.profile === "string"
					? request.profile
					: config.defaultProfile) ?? null;
		if (!parentProfileName) {
			throw new Error("fork requires a parent profile or a configured default profile");
		}
		const loadedParentProfile = loadProfile(this.paths, parentProfileName);
		if (!loadedParentProfile) {
			throw new Error(`Unknown parent profile: ${parentProfileName}`);
		}
		const parentProfile = ensureProfileAgentIdentity(this.paths, loadedParentProfile);
		const parentSecret = loadSecret(this.paths, parentProfile.name);
		if (!parentSecret) {
			throw new Error(`Missing secure-store secret for parent profile ${parentProfile.name}`);
		}
		const parentEntity = ensurePersistentAgentForProfile(this.paths, parentProfile, {
			continuityPolicyRef: loadContinuityPolicyState(this.paths).policy.policyId,
		}).entity;

		const childProfileName =
			typeof request.childProfile === "string"
				? request.childProfile
				: typeof request["child-profile"] === "string"
					? request["child-profile"]
					: typeof request.childProfileName === "string"
						? request.childProfileName
						: "";
		if (childProfileName.trim().length === 0) {
			throw new Error("fork requires --child-profile <name>");
		}
		if (loadProfile(this.paths, childProfileName)) {
			throw new Error(`Child profile already exists: ${childProfileName}`);
		}

		const childIdentity = generateRuntimeIdentity();
		const createdAt = nowIso();
		const result = await forkPersistentAgent({
			parentEntity,
			parentProfile: toRuntimePersistentAgentProfile(parentProfile),
			parentNsec: parentSecret.nsec,
			childProfileName,
			childNpub: childIdentity.npub,
			childAgentId:
				typeof request.childAgentId === "string"
					? request.childAgentId
					: typeof request["child-agent-id"] === "string"
						? request["child-agent-id"]
						: undefined,
			childDisplayName:
				typeof request.childDisplayName === "string"
					? request.childDisplayName
					: typeof request["child-display-name"] === "string"
						? request["child-display-name"]
						: undefined,
			continuityPolicyRef: loadContinuityPolicyState(this.paths).policy.policyId,
			forkReason:
				typeof request.reason === "string"
					? request.reason
					: typeof request["fork-reason"] === "string"
						? request["fork-reason"]
						: typeof request.forkReason === "string"
							? request.forkReason
							: "",
			inherit: {
				policy: request["without-policy"] === true ? false : true,
				selfModel: request["without-self-model"] === true ? false : true,
				projectModels: request["without-project-models"] === true ? false : true,
				passport: request["without-passport"] === true ? false : true,
			},
			inheritedRefs:
				typeof request["inherit-refs"] === "string"
					? String(request["inherit-refs"])
							.split(",")
							.map((entry) => entry.trim())
							.filter((entry) => entry.length > 0)
					: typeof request.inheritRefs === "string"
						? String(request.inheritRefs)
								.split(",")
								.map((entry) => entry.trim())
								.filter((entry) => entry.length > 0)
						: [],
			excludedRefs:
				typeof request["exclude-refs"] === "string"
					? String(request["exclude-refs"])
							.split(",")
							.map((entry) => entry.trim())
							.filter((entry) => entry.length > 0)
					: typeof request.excludeRefs === "string"
						? String(request.excludeRefs)
								.split(",")
								.map((entry) => entry.trim())
								.filter((entry) => entry.length > 0)
						: [],
			trustCarryoverMode:
				typeof request["trust-carryover-mode"] === "string"
					? (request["trust-carryover-mode"] as TrustCarryoverMode)
					: typeof request.trustCarryoverMode === "string"
						? (request.trustCarryoverMode as TrustCarryoverMode)
						: undefined,
			createdAt,
			notes:
				typeof request.note === "string"
					? [request.note]
					: typeof request.notes === "string"
						? [request.notes]
						: [],
		});

		const childProfile: RuntimeProfile = {
			...parentProfile,
			name: childProfileName,
			npub: childIdentity.npub,
			agentId: result.childEntity.agentRef.agentId,
			lineageRoot: result.childEntity.agentRef.lineageRoot,
			createdAt,
			updatedAt: createdAt,
		};
		// Each write is atomic, but the fork as a whole is not transactional. Write the agent
		// state first and the profile last: the profile is what makes the child selectable, so
		// a crash mid-fork leaves orphaned (re-creatable) agent files rather than a selectable
		// profile whose entity/lineage/passport files are missing.
		savePersistentAgentEntity(this.paths, result.childEntity);
		savePersistentAgentLineageLink(this.paths, result.lineageLink);
		savePersistentAgentInheritanceBoundary(this.paths, result.inheritanceBoundary);
		if (result.childPassport) {
			savePersistentAgentPassport(this.paths, result.childEntity.agentRef.agentId, result.childPassport);
		}
		saveSecret(this.paths, childProfileName, {
			nsec: childIdentity.nsec,
			session: null,
		});
		saveProfile(this.paths, childProfile);
		writeRuntimeLog(this.paths, "agent.fork", {
			parentProfile: parentProfile.name,
			parentAgentId: parentEntity.agentRef.agentId,
			childProfile: childProfileName,
			childAgentId: result.childEntity.agentRef.agentId,
			lineageLinkId: result.lineageLink.linkId,
		});

		return {
			parentProfile: parentProfile.name,
			childProfile: childProfileName,
			childNpub: childIdentity.npub,
			childAgentId: result.childEntity.agentRef.agentId,
			lineageLink: result.lineageLink,
			inheritanceBoundary: result.inheritanceBoundary,
			childPassport: result.childPassport,
			inspection: await this.inspectPersistentAgent(result.childEntity.agentRef.agentId, childProfileName),
		};
	}

	inspectContinuityPolicy(): RuntimeContinuityInspection {
		return buildContinuityInspection(this.paths);
	}

	inspectContinuityState(): RuntimeContinuityInspection {
		return buildContinuityInspection(this.paths);
	}

	applyContinuityGovernorPatch(request: unknown): RuntimeContinuityPatchMutation {
		const policyState = loadContinuityPolicyState(this.paths);
		const governorFileState = loadContinuityGovernorFileState(this.paths);
		const { patch, state } = applyGovernorPatchMutation(policyState.policy, governorFileState.patchHistory, request);
		saveContinuityGovernorPatchHistory(this.paths, state.patchHistory);
		writeRuntimeLog(this.paths, patch.acceptance.accepted ? "continuity.patch.apply" : "continuity.patch.reject", {
			patchId: patch.patchId,
			patchType: patch.patchType,
			actor: patch.actor,
			accepted: patch.acceptance.accepted,
			status: patch.status,
			reasons: patch.acceptance.reasons,
		});
		return {
			patch,
			continuity: this.inspectContinuityState(),
		};
	}

	removeContinuityGovernorPatch(request: unknown): RuntimeContinuityPatchMutation {
		const body = request && typeof request === "object" && !Array.isArray(request) ? (request as Record<string, unknown>) : null;
		const patchId =
			typeof body?.patchId === "string"
				? body.patchId
				: typeof body?.patch_id === "string"
					? body.patch_id
					: "";
		if (patchId.trim().length === 0) {
			throw new Error("continuity patch removal requires patchId");
		}
		const removedReason =
			typeof body?.removedReason === "string"
				? body.removedReason
				: typeof body?.removed_reason === "string"
					? body.removed_reason
					: null;
		const policyState = loadContinuityPolicyState(this.paths);
		const governorFileState = loadContinuityGovernorFileState(this.paths);
		const { patch, state } = removeGovernorPatchMutation(
			policyState.policy,
			governorFileState.patchHistory,
			patchId,
			removedReason
		);
		saveContinuityGovernorPatchHistory(this.paths, state.patchHistory);
		writeRuntimeLog(this.paths, "continuity.patch.remove", {
			patchId: patch.patchId,
			actor: patch.actor,
			removedReason,
		});
		return {
			patch,
			continuity: this.inspectContinuityState(),
		};
	}

	async reflectContextPack(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const result = await client.reflectContextPack(payload);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async hotSyncControl(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (!this.ownsRuntimeHome()) throw new Error("Start the daemon before changing hot sync");
		if (!hotSyncEnabled()) throw new Error("Local hot sync is not enabled on this daemon");
		const {profileName, secret} = await this.withProfileBody(body);
		const profile = loadProfile(this.paths, profileName)!;
		if (isLocalOnlyRuntimeProfile(profile)) throw new Error("This profile uses local-only memory");
		const manager = getHotSyncManager({stateDir:this.paths.state,origin:profile.apiBase,npub:profile.npub,nsec:secret.nsec,profileName});
		if (body.action === "link" && typeof body.root === "string" && typeof body.name === "string") return manager.link(body.root, body.name);
		if (body.action === "reset" && typeof body.scope === "string") return manager.reset(body.scope);
		if (body.action === "inspect") return manager.read(typeof body.scope === "string" ? body.scope : "all", true);
		if (body.action === "status") return manager.status();
		throw new Error("Invalid hot-sync control action");
	}

	async readHotMemory(profileName?: string, scope?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({
			profileName,
		});
		const profile = loadProfile(this.paths, resolvedProfileName);
		if (profile && isLocalOnlyRuntimeProfile(profile)) {
			return readLocalHotMemory(this.paths.state, scope);
		}
		if (profile && hotSyncEnabled()) {
			const manager=getHotSyncManager({stateDir:this.paths.state,origin:profile.apiBase,npub:profile.npub,nsec:secret.nsec,profileName:resolvedProfileName});
			return manager.read(scope ?? "shared");
		}
		// Pass the scope through unchanged (undefined => the server's shared default), so internal
		// callers like adapter handoff summaries keep the single-doc shape. The operator CLI opts
		// into the cross-body union explicitly by passing scope=all.
		const result = await client.readHotMemory(scope);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async listWarmMemory(
		profileName?: string,
		filter: { type?: string; status?: string; includeSystemMemory?: boolean } = {}
	): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({
			profileName,
		});
		const result = await client.listWarmMemory(filter);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async searchMemory(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const result = await client.searchMemory(payload);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async evaluateWarmMemory(
		request: Record<string, unknown> = {},
		profileName?: string
	): Promise<WarmMemoryEvaluationReport> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const result = (await client.evaluateWarmMemory(payload)) as WarmMemoryEvaluationReport;
		await this.persistSession(resolvedProfileName, secret, client);
		writeRuntimeLog(this.paths, "memory.warm.evaluate", {
			profileName: resolvedProfileName,
			apply: payload.apply === true,
		});
		return result;
	}

	async exportMemory(profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({
			profileName,
		});
		const result = await client.exportMemory();
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async readPublicDiscoverySchema(profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({
			profileName,
		});
		const result = await client.readPublicDiscoverySchema();
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async inspectPublicDiscovery(request: Record<string, unknown> = {}, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({
			profileName,
		});
		const readString = (...values: unknown[]): string | undefined => {
			for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) {
		  return value.trim();
		}
			}
			return undefined;
		};
		const result = await client.inspectPublicDiscovery({
			eventTypes:
		typeof (request.eventTypes ?? request.event_types ?? request.eventType ?? request.event_type) === "string"
		  ? String(request.eventTypes ?? request.event_types ?? request.eventType ?? request.event_type)
			  .split(",")
			  .map((entry) => entry.trim())
			  .filter((entry) => entry.length > 0)
		  : undefined,
			authors: typeof request.authors === "string" ? request.authors.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined,
			primaryId: readString(request.primaryId, request.primary_id),
			eventId: readString(request.eventId, request.event_id),
			capabilityId: readString(request.capabilityId, request.capability_id),
			offerId: readString(request.offerId, request.offer_id),
			taskRef: readString(request.taskRef, request.task_ref),
			agentId: readString(request.agentId, request.agent_id),
			status: readString(request.status),
			since:
		typeof request.since === "number"
		  ? Math.trunc(request.since)
		  : typeof request.since === "string" && request.since.trim().length > 0
			? Math.trunc(Number(request.since))
			: undefined,
			until:
		typeof request.until === "number"
		  ? Math.trunc(request.until)
		  : typeof request.until === "string" && request.until.trim().length > 0
			? Math.trunc(Number(request.until))
			: undefined,
			latestOnly:
		typeof request.latestOnly === "boolean"
		  ? request.latestOnly
		  : request.latestOnly === "true" || request.latest_only === "true"
			? true
			: request.latestOnly === "false" || request.latest_only === "false"
			  ? false
			  : undefined,
			includeRaw:
		typeof request.includeRaw === "boolean"
		  ? request.includeRaw
		  : request.includeRaw === "true" || request.include_raw === "true"
			? true
			: request.includeRaw === "false" || request.include_raw === "false"
			  ? false
			  : undefined,
			limit:
		typeof request.limit === "number"
		  ? Math.trunc(request.limit)
		  : typeof request.limit === "string" && request.limit.trim().length > 0
			? Math.trunc(Number(request.limit))
			: undefined,
		});
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async publishPublicDiscoveryEvent(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const config = loadRuntimeConfig(this.paths);
		const resolvedProfileName = profileName ?? config.defaultProfile;
		if (!resolvedProfileName) {
			throw new Error("No runtime profile is configured");
		}
		const { profile, secret, client } = this.loadProfileClient(resolvedProfileName);
		const entity =
			typeof profile.agentId === "string" && profile.agentId.trim().length > 0
		? loadPersistentAgentEntity(this.paths, profile.agentId)
		: null;
		const readString = (...values: unknown[]): string | undefined => {
			for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) {
		  return value.trim();
		}
			}
			return undefined;
		};
		const readCsv = (...values: unknown[]): string[] => {
			for (const value of values) {
		if (Array.isArray(value)) {
		  return value
			.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
			.map((entry) => entry.trim());
		}
		if (typeof value === "string" && value.trim().length > 0) {
		  return value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		}
			}
			return [];
		};
		const readOptionalInteger = (...values: unknown[]): number | null => {
			for (const value of values) {
		if (value === null) {
		  return null;
		}
		if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
		  return value;
		}
		if (typeof value === "string" && value.trim().length > 0) {
		  const parsed = Number(value);
		  if (Number.isInteger(parsed) && parsed >= 0) {
			return parsed;
		  }
		}
			}
			return null;
		};

		const eventType = readString(request.eventType, request.event_type);
		if (!eventType || !PUBLIC_DISCOVERY_EVENT_TYPES.includes(eventType as (typeof PUBLIC_DISCOVERY_EVENT_TYPES)[number])) {
			throw new Error(`public discovery publish requires --event-type ${PUBLIC_DISCOVERY_EVENT_TYPES.join("|")}`);
		}

		const basePayload = {
			schemaVersion: "public_discovery_event_v1" as const,
			eventType: eventType as PublicDiscoveryEvent["eventType"],
			publishedAt: readString(request.publishedAt, request.published_at) ?? nowIso(),
			summary: readString(request.summary) ?? "",
			agentId: readString(request.agentId, request.agent_id) ?? profile.agentId ?? entity?.agentRef.agentId ?? null,
			lineageRoot:
		readString(request.lineageRoot, request.lineage_root) ?? profile.lineageRoot ?? entity?.agentRef.lineageRoot ?? null,
			displayName: readString(request.displayName, request.display_name) ?? resolvedProfileName,
			notes: readCsv(request.notes, request.note),
		};
		if (basePayload.summary.length === 0) {
			throw new Error("public discovery publish requires --summary <text>");
		}

		let payload: PublicDiscoveryEvent;
		switch (eventType) {
			case "capability_advertisement":
		payload = {
		  ...basePayload,
		  eventType,
		  advertisementId: readString(request.advertisementId, request.advertisement_id) ?? "",
		  capabilityIds: readCsv(request.capabilityIds, request.capability_ids),
		  capabilityClaimRefs: readCsv(request.capabilityClaimRefs, request.capability_claim_refs),
		  scope: {
			runtimeHosts: readCsv(request.runtimeHosts, request.runtime_hosts),
			trustZones: readCsv(request.trustZones, request.trust_zones) as CollaborationContextTrustZone[],
			workspaceRefs: readCsv(request.workspaceRefs, request.workspace_refs),
		  },
		  availabilityRef: readString(request.availabilityRef, request.availability_ref) ?? null,
		} as PublicDiscoveryEvent;
		break;
			case "availability_heartbeat": {
		const availabilityStatus = readString(request.status, request.availabilityStatus, request.availability_status);
		if (
		  !availabilityStatus ||
		  !PUBLIC_DISCOVERY_AVAILABILITY_STATUSES.includes(
			availabilityStatus as (typeof PUBLIC_DISCOVERY_AVAILABILITY_STATUSES)[number]
		  )
		) {
		  throw new Error(
			`availability heartbeat requires --status ${PUBLIC_DISCOVERY_AVAILABILITY_STATUSES.join("|")}`
		  );
		}
		payload = {
		  ...basePayload,
		  eventType,
		  presenceId: readString(request.presenceId, request.presence_id) ?? "",
		  availabilityStatus,
		  claimedJobs: readOptionalInteger(request.claimedJobs, request.claimed_jobs),
		  maxConcurrentJobs: readOptionalInteger(request.maxConcurrentJobs, request.max_concurrent_jobs),
		  nextHeartbeatDueAt: readString(request.nextHeartbeatDueAt, request.next_heartbeat_due_at) ?? null,
		  availabilityRef: readString(request.availabilityRef, request.availability_ref) ?? null,
		  currentTaskRefs: readCsv(request.currentTaskRefs, request.current_task_refs),
		} as PublicDiscoveryEvent;
		break;
			}
			case "task_offer":
		payload = {
		  ...basePayload,
		  eventType,
		  offerId: readString(request.offerId, request.offer_id) ?? "",
		  taskRef: readString(request.taskRef, request.task_ref) ?? "",
		  requiredCapabilityIds: readCsv(request.requiredCapabilityIds, request.required_capability_ids),
		  requiredCapabilityClaimRefs: readCsv(request.requiredCapabilityClaimRefs, request.required_capability_claim_refs),
		  targetAgentNpubs: readCsv(request.targetAgentNpubs, request.target_agent_npubs),
		  collaborationContextRef: readString(request.collaborationContextRef, request.collaboration_context_ref) ?? null,
		  budgetSats: readOptionalInteger(request.budgetSats, request.budget_sats),
		  expiresAt: readString(request.expiresAt, request.expires_at) ?? null,
		} as PublicDiscoveryEvent;
		break;
			case "task_claim": {
		const claimState = readString(request.claimState, request.claim_state) ?? "claimed";
		if (
		  !PUBLIC_DISCOVERY_TASK_CLAIM_STATES.includes(claimState as (typeof PUBLIC_DISCOVERY_TASK_CLAIM_STATES)[number])
		) {
		  throw new Error(`task claim requires --claim-state ${PUBLIC_DISCOVERY_TASK_CLAIM_STATES.join("|")}`);
		}
		payload = {
		  ...basePayload,
		  eventType,
		  claimId: readString(request.claimId, request.claim_id) ?? "",
		  offerId: readString(request.offerId, request.offer_id) ?? "",
		  offerEventId: readString(request.offerEventId, request.offer_event_id) ?? null,
		  claimState,
		  availabilityRef: readString(request.availabilityRef, request.availability_ref) ?? null,
		  collaborationContextRef: readString(request.collaborationContextRef, request.collaboration_context_ref) ?? null,
		  note: readString(request.note) ?? null,
		} as PublicDiscoveryEvent;
		break;
			}
			default:
		throw new Error(`unsupported public discovery event type: ${eventType}`);
		}

		const draft = buildPublicDiscoveryRelayDraft(payload);
		const decoded = nip19.decode(secret.nsec);
		if (decoded.type !== "nsec") {
			throw new Error("runtime secret is not a valid nsec");
		}
		const signedEvent = finalizeEvent(draft, decoded.data);
		const publishResult = await client.publishRelayEvent(signedEvent as unknown as Record<string, unknown>);
		await this.persistSession(resolvedProfileName, secret, client);
		writeRuntimeLog(this.paths, "public.discovery.publish", {
			profileName: resolvedProfileName,
			eventType: payload.eventType,
			primaryId:
		payload.eventType === "capability_advertisement"
		  ? payload.advertisementId
		  : payload.eventType === "availability_heartbeat"
			? payload.presenceId
			: payload.eventType === "task_offer"
			  ? payload.offerId
			  : payload.claimId,
		});
		return {
			payload,
			relay_event: signedEvent,
			publish_result: publishResult,
		};
	}

	async inspectInboxState(
		request: Record<string, unknown> = {},
		profileName?: string
	): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client } = await this.withProfileBody({
			profileName,
		});
		const parseCsv = (value: unknown): string[] | undefined =>
			typeof value === "string"
		? value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)
		: undefined;
		const parseBoolean = (value: unknown): boolean | undefined => {
			if (typeof value === "boolean") {
		return value;
			}
			if (value === "true") {
		return true;
			}
			if (value === "false") {
		return false;
			}
			return undefined;
		};
		const parseLimit = (value: unknown): number | undefined => {
			if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.trunc(value);
			}
			if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
			}
			return undefined;
		};

		const result = await client.inspectInboxState({
			statuses: parseCsv(request.statuses),
			priorities: parseCsv(request.priorities),
			contextId:
		typeof request.contextId === "string"
		  ? request.contextId
		  : typeof request.context_id === "string"
			? request.context_id
			: undefined,
			messageType:
		typeof request.messageType === "string"
		  ? request.messageType
		  : typeof request.message_type === "string"
			? request.message_type
			: undefined,
			unreadOnly: parseBoolean(request.unreadOnly ?? request.unread_only),
			includeTerminal: parseBoolean(request.includeTerminal ?? request.include_terminal),
			limit: parseLimit(request.limit),
		});
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async replayInboxItem(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const result = await client.replayInboxItem(payload);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async acknowledgeInboxItem(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const result = await client.acknowledgeInboxItem(payload);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async resolveInboxItem(request: Record<string, unknown>, profileName?: string): Promise<Record<string, unknown>> {
		const { profileName: resolvedProfileName, secret, client, payload } = await this.withProfileBody({
			profileName,
			...request,
		});
		const result = await client.resolveInboxItem(payload);
		await this.persistSession(resolvedProfileName, secret, client);
		return result;
	}

	async setMemoryMode(mode: RuntimeMemoryMode, profileName?: string): Promise<RuntimeProfile> {
		const config = loadRuntimeConfig(this.paths);
		const resolvedProfileName = profileName ?? config.defaultProfile;
		if (!resolvedProfileName) {
			throw new Error("No runtime profile is configured");
		}
		const profile = loadProfile(this.paths, resolvedProfileName);
		if (!profile) {
			throw new Error(`Unknown runtime profile: ${resolvedProfileName}`);
		}
		const updated: RuntimeProfile = {
			...profile,
			memoryMode: mode,
			updatedAt: nowIso(),
		};
		saveProfile(this.paths, updated);
		writeRuntimeLog(this.paths, "profile.memory_mode", {
			profileName: updated.name,
			memoryMode: updated.memoryMode,
		});
		return updated;
	}

	private profileNameForNpub(npub: string): string | null {
		if (!existsSync(this.paths.profiles)) {
			return null;
		}
		for (const file of readdirSync(this.paths.profiles).filter((name) => name.endsWith(".json")).sort()) {
			const profile = loadProfile(this.paths, file.slice(0, -5));
			if (profile?.npub === npub) {
				return profile.name;
			}
		}
		return null;
	}

	private loadProfileClient(profileName: string): { profile: RuntimeProfile; secret: RuntimeSecretState; client: HostedOnlyBotsClient } {
		const profile = loadProfile(this.paths, profileName);
		if (!profile) {
			throw new Error(`Unknown runtime profile: ${profileName}`);
		}
		const secret = loadSecret(this.paths, profileName);
		if (!secret) {
			throw new Error(`Missing secure-store secret for profile ${profileName}`);
		}
		const client = new HostedOnlyBotsClient({
			apiBase: profile.apiBase,
			npub: profile.npub,
			nsec: secret.nsec,
			session: secret.session,
		});
		return { profile, secret, client };
	}

	private async persistSession(profileName: string, secret: RuntimeSecretState, client: HostedOnlyBotsClient): Promise<void> {
		const nextSession = client.session();
		const current = loadSecret(this.paths, profileName);
		if (isSessionWriteStale(current?.session ?? null, nextSession)) {
			// Another request already persisted a fresher session token; keep it.
			return;
		}
		saveSecret(this.paths, profileName, {
			...secret,
			session: nextSession,
		});
	}

	async attachAdapter(request: RuntimeAttachRequest): Promise<RuntimeAttachResponse> {
		const config = loadRuntimeConfig(this.paths);
		const compatibility = compatibilityReason(config.coreVersion, request.adapterVersion);
		const existing = loadAdapterRecord(this.paths, request.adapterName);
		const broker = new OperatorRuntimePolicyBroker();
		let mountPolicyAudit: Record<string, unknown> | null = null;
		const controllerRequest = request.adapterName === HOSTED_PI_CONTROLLER_ADAPTER ||
			request.manifest?.runtimeId === HOSTED_PI_CONTROLLER_MANIFEST ||
			request.manifest?.runtimeVersion === HOSTED_PI_CONTROLLER_MANIFEST;
		const exactController = isExactHostedControllerAttach(request);
		if (controllerRequest && (!exactController || request.manifest?.workspaceRoot !== this.paths.home)) {
			throw new Error("Hosted controller attachment must declare exact authority-free metadata for this home");
		}
		if (exactController && existing && (existing.profileName !== request.profileName ||
			existing.version !== request.adapterVersion || existing.runtimeVersion !== request.runtimeVersion ||
			existing.hostHome !== null || existing.managedFiles.length !== 0)) {
			throw new Error("Hosted controller attachment conflicts with the existing host");
		}
		if (exactController && existing?.controllerConnectionId !== request.controllerConnectionId &&
			(existing?.controllerConnectionId ?? null) !== request.expectedControllerConnectionId) {
			throw new Error("Hosted controller connection generation is stale");
		}
		if (exactController && existing && existing.controllerConnectionId === request.controllerConnectionId &&
			(existing.controllerProcess?.pid !== request.controllerProcess?.pid ||
				existing.controllerProcess?.startedAtTicks !== request.controllerProcess?.startedAtTicks ||
				existing.controllerProcess?.bootId !== request.controllerProcess?.bootId)) {
			throw new Error("Hosted controller process replay conflicts with its connection");
		}

		if (request.manifest) {
			const exactLifecycleMetadata =
				isExactGovernedSyntheticLifecycleAttach(request) || exactController;
			const malformedSyntheticLifecycle =
				claimsGovernedSyntheticLifecycleProfile(request.manifest) &&
				!exactLifecycleMetadata;
			const policyDecision = broker.evaluate(
				request.manifest,
				{
					policyVersion: "2026-04-02",
					policyId: "runtime-default",
					runtimeClass: "tenant",
					secureExecutionRequired: malformedSyntheticLifecycle
						? true
						: !exactLifecycleMetadata,
					runtimeRoot: this.paths.state,
					allowReadOnlyRoots: [request.manifest.workspaceRoot],
					approvedExtraMounts: [],
					brokeredSecretRefs: ["nostr_identity", "onlybots_session"],
				},
				{
					// The exact profile is lifecycle/continuity metadata only. A
					// profile-shaped authority request fails closed before mount or
					// secret evaluation instead of inheriting the normal host claim.
					secureExecutionAvailable: malformedSyntheticLifecycle
						? false
						: !exactLifecycleMetadata,
					createManagedRoots: true,
				}
			);
			mountPolicyAudit = policyDecision.audit;
			if (!policyDecision.allowed) {
				const failedRecord: RuntimeAdapterRecord = {
					name: request.adapterName,
					version: request.adapterVersion,
					runtimeVersion: request.runtimeVersion,
					status: "failed",
					profileName: request.profileName,
					hostHome: request.hostHome ?? null,
					managedFiles: request.managedFiles ?? [],
					lastError: policyDecision.reason,
					installedAt: existing?.installedAt ?? nowIso(),
					updatedAt: nowIso(),
				};
				saveAdapterRecord(this.paths, failedRecord);
				return {
					accepted: false,
					adapter: failedRecord,
					compatibility: {
						compatible: compatibility === null,
						reason: compatibility,
					},
					mountPolicyAudit,
				};
			}
		}

		const record: RuntimeAdapterRecord = {
			name: request.adapterName,
			version: request.adapterVersion,
			runtimeVersion: request.runtimeVersion,
			status: compatibility ? "failed" : "attached",
			profileName: request.profileName,
			hostHome: request.hostHome ?? null,
			managedFiles: request.managedFiles ?? [],
			lastError: compatibility,
			installedAt: existing?.installedAt ?? nowIso(),
			// A controlled process restart resumes the same host lifetime. Status
			// still pauses on graceful shutdown; its federation timestamp is stable.
			updatedAt: exactController && existing ? existing.updatedAt : nowIso(),
			...(exactController ? { controllerConnectionId: request.controllerConnectionId, controllerProcess: request.controllerProcess } : {}),
		};
		saveAdapterRecord(this.paths, record);
		writeRuntimeLog(this.paths, "adapter.attach", {
			adapterName: record.name,
			status: record.status,
			profileName: record.profileName,
		});
		return {
			accepted: compatibility === null,
			adapter: record,
			compatibility: {
				compatible: compatibility === null,
				reason: compatibility,
			},
			mountPolicyAudit,
		};
	}

	async detachAdapter(request: RuntimeDetachRequest): Promise<RuntimeAdapterRecord> {
		if (request.adapterName !== HOSTED_PI_CONTROLLER_ADAPTER) throw new Error("Only the managed hosted controller can detach here");
		const existing = loadAdapterRecord(this.paths, request.adapterName);
		if (!existing || existing.profileName !== request.profileName ||
			existing.updatedAt !== request.expectedUpdatedAt || !request.controllerConnectionId ||
			existing.controllerConnectionId !== request.controllerConnectionId) throw new Error("Adapter detach binding is stale");
		const record = { ...existing, status: "installed" as const };
		saveAdapterRecord(this.paths, record);
		await this.inspectPersistentAgent(undefined, request.profileName);
		return record;
	}

	private async withProfileBody(
		body: Record<string, unknown>
	): Promise<{ profileName: string; secret: RuntimeSecretState; client: HostedOnlyBotsClient; payload: Record<string, unknown> }> {
		const config = loadRuntimeConfig(this.paths);
		const profileName =
			(typeof body.profileName === "string" ? body.profileName : typeof body.profile === "string" ? body.profile : null) ??
			config.defaultProfile;
		if (!profileName) {
			throw new Error("No runtime profile is configured");
		}
		const { secret, client } = this.loadProfileClient(profileName);
		return {
			profileName,
			secret,
			client,
			payload: { ...body, profileName: undefined, profile: undefined },
		};
	}

	async proxyContextPack(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { profileName, secret, client, payload } = await this.withProfileBody(body);
		const continuity = loadEffectiveContinuityGovernorState(this.paths);
		const result = await client.prepareContextPack(applyGovernorMemoryScope(payload, continuity.governorState.memoryScope));
		await this.persistSession(profileName, secret, client);
		await this.lifecycleManager.recordContextPackResult(profileName, result, "daemon_proxy");
		saveHealthState(this.paths, {
			...loadHealthState(this.paths),
			lastSuccessfulSyncAt: nowIso(),
			lastError: null,
		});
		writeRuntimeLog(this.paths, "context.pack", {
			profileName,
			goal: payload.goal,
		});
		return result;
	}

	async proxyContextReflect(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { profileName, secret, client, payload } = await this.withProfileBody(body);
		const result = await client.reflectContextPack(payload);
		await this.persistSession(profileName, secret, client);
		saveHealthState(this.paths, {
			...loadHealthState(this.paths),
			lastSuccessfulSyncAt: nowIso(),
			lastError: null,
		});
		writeRuntimeLog(this.paths, "context.reflect", {
			profileName,
			packId: payload.packId ?? payload.pack_id,
		});
		return result;
	}

	async proxyMemorySearch(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { profileName, secret, client, payload } = await this.withProfileBody(body);
		const result = await client.searchMemory(payload);
		await this.persistSession(profileName, secret, client);
		saveHealthState(this.paths, {
			...loadHealthState(this.paths),
			lastSuccessfulSyncAt: nowIso(),
			lastError: null,
		});
		writeRuntimeLog(this.paths, "memory.search", {
			profileName,
		});
		return result;
	}

	async proxyMemoryExport(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { profileName, secret, client } = await this.withProfileBody(body);
		const result = await client.exportMemory();
		await this.persistSession(profileName, secret, client);
		saveHealthState(this.paths, {
			...loadHealthState(this.paths),
			lastSuccessfulSyncAt: nowIso(),
			lastError: null,
		});
		writeRuntimeLog(this.paths, "memory.export", {
			profileName,
		});
		return result;
	}
}

export const readRuntimeLogs = (home?: string, lines: number = 50): string[] =>
	tailFileLines(logFile(ensureRuntimeHomeLayout(home)), lines);

export const buildRuntimeStatusDirect = async (home?: string, profileName?: string): Promise<RuntimeStatus> =>
	buildRuntimeStatus(resolveRuntimePaths(home), profileName);

export const buildRuntimeDoctorDirect = async (home?: string, profileName?: string): Promise<RuntimeDoctorReport> =>
	buildDoctorReport(ensureRuntimeHomeLayout(home), profileName);

export const startDetachedRuntimeDaemon = async (options: StartRuntimeDaemonOptions = {}): Promise<RuntimeDaemonState> => {
	const paths = resolveRuntimePaths(options.home);
	const daemonScriptPath = options.daemonScriptPath ?? path.resolve(__dirname, "daemon.js");
	if (
		options.organizationalWorkerConfigPath !== undefined &&
		!path.isAbsolute(options.organizationalWorkerConfigPath)
	) {
		throw new Error("organizational worker config path must be absolute");
	}
	const organizationalWorkerConfigPath = options.organizationalWorkerConfigPath
		? path.resolve(options.organizationalWorkerConfigPath)
		: undefined;
	const child = spawn(process.execPath, [
		daemonScriptPath,
		"serve",
		"--home",
		paths.home,
		"--port",
		String(options.port ?? 0),
		...(organizationalWorkerConfigPath
			? ["--organizational-worker-config", organizationalWorkerConfigPath]
			: []),
	], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();

	const waitForChildExit = async (timeoutMs: number): Promise<boolean> =>
		new Promise((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolve(true);
				return;
			}
			const onExit = () => {
				clearTimeout(timer);
				resolve(true);
			};
			const timer = setTimeout(() => {
				child.off("exit", onExit);
				resolve(false);
			}, timeoutMs);
			child.once("exit", onExit);
		});
	const terminateChild = async (): Promise<void> => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		if (await waitForChildExit(1_000)) return;
		child.kill("SIGKILL");
		await waitForChildExit(1_000);
	};

	const startedAt = Date.now();
	const startupTimeoutMs = organizationalWorkerConfigPath ? 30_000 : 5_000;
	let exitedBeforeReady = false;
	while (Date.now() - startedAt < startupTimeoutMs) {
		const state = loadDaemonState(paths);
		if (
			state.status === "running" &&
			state.port &&
			state.pid === child.pid
		) {
			const reachable = await probeRuntimeDaemonHealth(state, Math.min(1_000, Math.max(1, startupTimeoutMs - (Date.now() - startedAt))));
			if (reachable) {
				return state;
			}
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			exitedBeforeReady = true;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	await terminateChild();
	throw new Error(
		exitedBeforeReady
			? "Detached daemon exited before becoming ready"
			: `Timed out after ${startupTimeoutMs}ms waiting for detached daemon to start`
	);
};

export const stopDetachedRuntimeDaemon = async (home?: string): Promise<void> => {
	const paths = resolveRuntimePaths(home);
	const state = readDaemonOwnershipState(paths);
	if (!daemonOwnerIsLive(state)) return;
	if (!state?.ownerId || !state.ownerProcess) throw new Error("Live legacy daemon ownership must be reconciled before stopping");
	const current = readDaemonOwnershipState(paths);
	if (current?.status !== "running" || current.ownerId !== state.ownerId || current.pid !== state.pid ||
		current.ownerProcess?.startedAtTicks !== state.ownerProcess.startedAtTicks ||
		current.ownerProcess?.bootId !== state.ownerProcess.bootId) return;
	// Recheck the owner and process witness before SIGTERM. These are separate
	// syscalls; on macOS also require the nonce-bearing daemon health response.
	if (process.platform === "darwin" && !await probeRuntimeDaemonHealth(state)) {
		throw new Error("Daemon ownership health could not be verified before stopping");
	}
	if (!daemonOwnerIsLive(state)) return;
	try { process.kill(state.ownerProcess.pid, "SIGTERM"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (!daemonOwnerIsLive(state)) return;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error("Daemon stop timed out; owner process is still live");
};

export const formatRuntimeStatus = (status: RuntimeStatus): string => {
	const lines = [
		`core: ${status.coreVersion} (${status.channel})`,
		`home: ${status.home}`,
		`daemon: ${status.daemon.running ? "running" : "stopped"}${status.daemon.port ? ` on :${status.daemon.port}` : ""}${status.daemon.reachable ? " reachable" : ""}`,
		`queue_depth: ${status.queueDepth}`,
		`pending_hot_writes: ${status.pendingHotWrites}`,
		`pending_cold_batches: ${status.pendingColdBatches}`,
		`retrying_items: ${status.retryingItems}`,
		`backpressure: ${status.backpressure ? "yes" : "no"}`,
		`last_sync: ${status.lastSuccessfulSyncAt ?? "never"}`,
	];
	if (status.hotSync) lines.push(`hot_sync: ${status.hotSync.state} (pending: ${status.hotSync.pendingCount ?? 0})${status.hotSync.error ? `; ${status.hotSync.error}` : ""}`);
	if (status.profile) {
		lines.push(`profile: ${status.profile.name} (${status.profile.npub})`);
		lines.push(`agent mark (visual only):\n${renderAgentMarkText(status.profile.npub)}`);
		lines.push(`api_base: ${status.profile.apiBase}`);
		lines.push(`memory_mode: ${status.profile.memoryMode}`);
		lines.push(`auth: ${status.profile.authValid ? `valid until ${status.profile.authExpiresAt}` : "expired or missing"}`);
	} else {
		lines.push("profile: none configured");
	}
	if (status.inbox) {
		lines.push(
			`inbox: source=${status.inbox.source}${status.inbox.stale ? "/stale" : ""} total=${status.inbox.summary.total} active=${status.inbox.summary.active} unread=${status.inbox.summary.unread} acknowledged=${status.inbox.summary.acknowledged} new=${status.inbox.newSinceLastAnnouncement}`
		);
		if (status.inbox.topItems.length > 0) {
			lines.push(
		`inbox_top: ${status.inbox.topItems
		  .map(
			(item) =>
			  `${item.isNew ? "new:" : ""}${item.status}/${item.priority ?? "none"}/${item.eventType ?? "item"} ${item.summary}`
		  )
		  .join(" | ")}`
			);
		}
		if (status.inbox.fetchError) {
			lines.push(`inbox_error: ${status.inbox.fetchError}`);
		}
	} else {
		lines.push("inbox: unavailable");
	}
	if (status.dreamReview) {
		const typeBreakdown = Object.entries(status.dreamReview.summary.pendingByType)
			.filter(([, count]) => Number(count) > 0)
			.map(([type, count]) => `${type}:${count}`)
			.join(",");
		lines.push(
			`dream_review: source=${status.dreamReview.source}${status.dreamReview.stale ? "/stale" : ""} pending=${status.dreamReview.summary.pending} new=${status.dreamReview.newSinceLastAnnouncement}${typeBreakdown.length > 0 ? ` types=${typeBreakdown}` : ""}`
		);
		if (status.dreamReview.topItems.length > 0) {
			lines.push(
				`dream_review_top: ${status.dreamReview.topItems
					.map((item) => `${item.isNew ? "new:" : ""}${item.proposalType} ${item.summary}`)
					.join(" | ")}`
			);
		}
		if (status.dreamReview.fetchError) {
			lines.push(`dream_review_error: ${status.dreamReview.fetchError}`);
		}
	} else {
		lines.push("dream_review: unavailable");
	}
	if (status.adapters.length > 0) {
		lines.push(`adapters: ${status.adapters.map((adapter) => `${adapter.name}:${adapter.status}@${adapter.version}`).join(", ")}`);
	} else {
		lines.push("adapters: none attached");
	}
	lines.push(
		`continuity_policy: ${status.continuity.policy.policyVersion} (${status.continuity.source}/${status.continuity.effectiveSource}) ${
			status.continuity.degraded ? "degraded" : "ok"
		}`
	);
	lines.push(
		`continuity_governor: paused=${status.continuity.governor.paused ? "yes" : "no"} active=${status.continuity.governor.activePatches.length} history=${status.continuity.governor.patchHistory.length}`
	);
	lines.push(
		`continuity_runtime: enforced=${status.continuity.sharedRuntime.summary.enforced} best_effort=${status.continuity.sharedRuntime.summary.bestEffort} advisory=${status.continuity.sharedRuntime.summary.advisory}`
	);
	lines.push(
		`continuity_scope: hot=${status.continuity.governor.memoryScope.includeHotMemory ? "yes" : "no"} warm=${status.continuity.governor.memoryScope.includeWarmMemory ? "yes" : "no"} cold=${status.continuity.governor.memoryScope.includeColdMemory ? "yes" : "no"} layered=${status.continuity.governor.memoryScope.includeLayeredContext ? "yes" : "no"}`
	);
	lines.push(
		`continuity_budgets: sats=${status.continuity.policy.governance.budgetCeilings.maxBudgetSats} warm=${status.continuity.policy.governance.budgetCeilings.maxWarmWritesPerTurn} cold=${status.continuity.policy.governance.budgetCeilings.maxColdItemsPerBatch}`
	);
	lines.push(
		`continuity_authority: ${status.continuity.authority
			.map((entry) => `${entry.tier}=${entry.effectiveMode}`)
			.join(" ")}`
	);
	if (status.continuity.governor.pauseReasons.length > 0) {
		lines.push(...status.continuity.governor.pauseReasons.map((reason) => `continuity_pause: ${reason}`));
	}
	if (status.continuity.governor.activePatches.length > 0) {
		lines.push(
			...status.continuity.governor.activePatches.slice(0, 6).map(
				(patch) =>
					`continuity_patch: ${patch.patchId} ${patch.patchType} actor=${patch.actor} degraded=${patch.degraded ? "yes" : "no"} accepted=${patch.acceptance.accepted ? "yes" : "no"}`
			)
		);
	}
	if (status.continuity.hosts.length > 0) {
		lines.push(
			`continuity_hosts: ${status.continuity.hosts
				.map((host) => `${host.host}:${host.degraded ? "degraded" : "ok"} e=${host.summary.enforced}/b=${host.summary.bestEffort}/a=${host.summary.advisory}`)
				.join(", ")}`
		);
	}
	if (status.continuity.unresolvedConflicts.length > 0) {
		lines.push(
			...status.continuity.unresolvedConflicts.slice(0, 6).map(
				(conflict) =>
					`continuity_conflict: ${conflict.host} ${conflict.id} requested=${conflict.requested} effective=${conflict.effective}`
			)
		);
	}
	if (status.lifecycle.lastEvent) {
		lines.push(
			`last_event: ${status.lifecycle.lastEvent.type} at ${status.lifecycle.lastEvent.occurredAt}${
				status.lifecycle.lastEvent.turnId ? ` turn=${status.lifecycle.lastEvent.turnId}` : ""
			}${status.lifecycle.lastEvent.summary ? ` summary=${status.lifecycle.lastEvent.summary}` : ""}`
		);
	}
	if (status.lifecycle.lastCompletedTurn) {
		lines.push(
			`last_completed_turn: ${status.lifecycle.lastCompletedTurn.status} at ${status.lifecycle.lastCompletedTurn.occurredAt}${
				status.lifecycle.lastCompletedTurn.turnId ? ` turn=${status.lifecycle.lastCompletedTurn.turnId}` : ""
			}${status.lifecycle.lastCompletedTurn.summary ? ` summary=${status.lifecycle.lastCompletedTurn.summary}` : ""}`
		);
	}
	lines.push(`integrity: ${status.integrity.ok ? "ok" : "drift detected"}`);
	if (status.integrity.issues.length > 0) {
		lines.push(...status.integrity.issues.map((issue) => `integrity_${issue.severity}: ${issue.message}`));
	}
	if (status.lastError) {
		lines.push(`last_error: ${status.lastError}`);
	}
	return lines.join("\n");
};

export const formatRuntimeDoctor = (report: RuntimeDoctorReport): string =>
	report.checks.map((check) => `${check.ok ? "ok" : "fail"} ${check.id}: ${check.message}`).join("\n");

export const formatContinuityPolicyInspection = (inspection: RuntimeContinuityInspection): string => {
	const lines = [
		`policy_version: ${inspection.policy.policyVersion}`,
		`policy_id: ${inspection.policy.policyId}`,
		`source: ${inspection.source}`,
		`effective_source: ${inspection.effectiveSource}`,
		`degraded: ${inspection.degraded ? "yes" : "no"}`,
		`base_policy_version: ${inspection.base.policy.policyVersion}`,
		`base_policy_id: ${inspection.base.policy.policyId}`,
		`shared_runtime: enforced=${inspection.sharedRuntime.summary.enforced} best_effort=${inspection.sharedRuntime.summary.bestEffort} advisory=${inspection.sharedRuntime.summary.advisory}`,
		`authority: ${inspection.authority.map((entry) => `${entry.tier}=${entry.effectiveMode}`).join(" ")}`,
		`memory: hot_write=${inspection.policy.memory.hotWriteMode} write_threshold=${inspection.policy.memory.writeThreshold} warm_sensitivity=${inspection.policy.memory.warmPromotionSensitivity.toFixed(2)} trust_zone=${inspection.policy.memory.trustZoneScope}`,
		`governance: tool_approval=${inspection.policy.governance.toolApprovalMode} self_modification=${inspection.policy.governance.selfModificationMode} review_for=${inspection.policy.governance.requireReviewFor.join(", ") || "none"}`,
		`budgets: max_budget_sats=${inspection.policy.governance.budgetCeilings.maxBudgetSats} max_warm_writes_per_turn=${inspection.policy.governance.budgetCeilings.maxWarmWritesPerTurn} max_cold_items_per_batch=${inspection.policy.governance.budgetCeilings.maxColdItemsPerBatch}`,
		`governor_file: ${inspection.governor.file}`,
		`governor_state: paused=${inspection.governor.paused ? "yes" : "no"} active_patches=${inspection.governor.activePatches.length} patch_history=${inspection.governor.patchHistory.length}`,
		`memory_scope: hot=${inspection.governor.memoryScope.includeHotMemory ? "yes" : "no"} warm=${inspection.governor.memoryScope.includeWarmMemory ? "yes" : "no"} cold=${inspection.governor.memoryScope.includeColdMemory ? "yes" : "no"} layered=${inspection.governor.memoryScope.includeLayeredContext ? "yes" : "no"}`,
	];

	if (inspection.validationErrors.length > 0) {
		lines.push(...inspection.validationErrors.map((error) => `validation_error: ${error}`));
	}
	if (inspection.governor.validationErrors.length > 0) {
		lines.push(...inspection.governor.validationErrors.map((error) => `governor_validation_error: ${error}`));
	}
	if (inspection.governor.pauseReasons.length > 0) {
		lines.push(...inspection.governor.pauseReasons.map((reason) => `pause_reason: ${reason}`));
	}
	if (inspection.governor.patchHistory.length > 0) {
		for (const patch of inspection.governor.patchHistory) {
			lines.push(
				`patch: ${patch.patchId} ${patch.patchType} status=${patch.status} actor=${patch.actor} degraded=${patch.degraded ? "yes" : "no"} accepted=${patch.acceptance.accepted ? "yes" : "no"}`
			);
			if (patch.reason) {
				lines.push(`  reason: ${patch.reason}`);
			}
			if (patch.removedReason) {
				lines.push(`  removed_reason: ${patch.removedReason}`);
			}
			for (const reason of patch.acceptance.reasons) {
				lines.push(`  acceptance: ${reason}`);
			}
		}
	}

	for (const host of inspection.hosts) {
		lines.push(
			`host ${host.host}: ${host.degraded ? "degraded" : "ok"} enforced=${host.summary.enforced} best_effort=${host.summary.bestEffort} advisory=${host.summary.advisory}`
		);
		for (const note of host.notes) {
			lines.push(`  note: ${note}`);
		}
	}

	if (inspection.unresolvedConflicts.length > 0) {
		for (const conflict of inspection.unresolvedConflicts) {
			lines.push(
				`conflict: ${conflict.host} ${conflict.id} requested=${conflict.requested} effective=${conflict.effective} reason=${conflict.reason}`
			);
		}
	}

	return lines.join("\n");
};

export const formatRuntimeActivity = (activity: RuntimeLifecycleActivity): string => {
	const eventLines = activity.events.map(
		(event) => `event ${event.occurredAt} ${event.profileName} ${event.type} (${event.eventId})`
	);
	const actionLines = activity.actions.map((action) => {
		const details = action.details && typeof action.details === "object" && !Array.isArray(action.details)
			? (action.details as Record<string, unknown>)
			: null;
		const decision =
			details?.decision && typeof details.decision === "object" && !Array.isArray(details.decision)
				? (details.decision as Record<string, unknown>)
				: null;
		const candidate =
			details?.candidate && typeof details.candidate === "object" && !Array.isArray(details.candidate)
				? (details.candidate as Record<string, unknown>)
				: details;
		const inferred =
			candidate?.inferred && typeof candidate.inferred === "object" && !Array.isArray(candidate.inferred)
				? (candidate.inferred as Record<string, unknown>)
				: null;
		const candidateContent =
			candidate?.content && typeof candidate.content === "object" && !Array.isArray(candidate.content)
				? ((candidate.content as Record<string, unknown>).text as string | undefined)
				: typeof candidate?.content === "string"
					? candidate.content
					: undefined;
		const candidatePreview =
			typeof candidateContent === "string" && candidateContent.trim().length > 0
				? candidateContent.replace(/\s+/g, " ").trim().slice(0, 96)
				: null;
		const candidateType =
			typeof inferred?.type === "string"
				? inferred.type
				: typeof candidate?.type === "string"
					? candidate.type
					: null;
		const outcome =
			typeof decision?.outcome === "string" ? decision.outcome : action.type === "warm_proposal" ? "proposed" : null;
		const extra = [
			candidateType ? `candidate=${candidateType}` : null,
			outcome ? `outcome=${outcome}` : null,
			candidatePreview ? `preview="${candidatePreview}${candidatePreview.length >= 96 ? "..." : ""}"` : null,
		]
			.filter((value): value is string => value !== null)
			.join(" ");
		return `action ${action.createdAt} ${action.profileName} ${action.type}:${action.status} ${action.reason}${
			extra.length > 0 ? ` ${extra}` : ""
		}`;
	});
	return [...eventLines, ...actionLines].join("\n");
};

export const parseJsonFlag = (value: string | boolean | undefined): unknown => {
	if (typeof value !== "string" || value.trim().length === 0) {
		return undefined;
	}
	return JSON.parse(value);
};

export const formatContextPackInspection = (pack: Record<string, unknown>): string => {
	const packId = typeof pack.packId === "string" ? pack.packId : "unknown";
	const goal = typeof pack.goal === "string" ? pack.goal : "";
	const manifest =
		pack.manifest && typeof pack.manifest === "object" && !Array.isArray(pack.manifest)
			? (pack.manifest as Record<string, unknown>)
			: null;
	const budget =
		pack.budgetSummary && typeof pack.budgetSummary === "object" && !Array.isArray(pack.budgetSummary)
			? (pack.budgetSummary as Record<string, unknown>)
			: null;
	const judgment =
		pack.judgment && typeof pack.judgment === "object" && !Array.isArray(pack.judgment)
			? (pack.judgment as Record<string, unknown>)
			: null;
	const selfModel =
		pack.selfModel && typeof pack.selfModel === "object" && !Array.isArray(pack.selfModel)
			? (pack.selfModel as Record<string, unknown>)
			: null;
	const included = Array.isArray(pack.fragments) ? (pack.fragments as Array<Record<string, unknown>>) : [];
	const suppressed = Array.isArray(pack.suppressed) ? (pack.suppressed as Array<Record<string, unknown>>) : [];

	const lines = [`pack_id: ${packId}`];
	if (goal.length > 0) {
		lines.push(`goal: ${goal}`);
	}
	if (manifest) {
		const compilerVersion = typeof manifest.compilerVersion === "string" ? manifest.compilerVersion : "unknown";
		lines.push(`compiler_version: ${compilerVersion}`);
	}
	if (budget) {
		lines.push(
			`budget: fragments=${String(budget.selectedFragments ?? "?")}/${String(budget.maxFragments ?? "?")} tokens=${String(budget.selectedTokens ?? "?")}/${String(budget.maxTokens ?? "?")}`
		);
	}
	if (judgment) {
		lines.push(
			`judgment_markers: known=${Array.isArray(judgment.demonstratedKnowledge) ? judgment.demonstratedKnowledge.length : 0} corrections=${Array.isArray(judgment.recentCorrections) ? judgment.recentCorrections.length : 0} orientation=${Array.isArray(judgment.orientation) ? judgment.orientation.length : 0}`
		);
		const userModel =
			judgment.userModel && typeof judgment.userModel === "object" && !Array.isArray(judgment.userModel)
				? (judgment.userModel as Record<string, unknown>)
				: null;
		const projectModel =
			judgment.projectModel && typeof judgment.projectModel === "object" && !Array.isArray(judgment.projectModel)
				? (judgment.projectModel as Record<string, unknown>)
				: null;
		if (userModel) {
			lines.push(
				`user_model: preferences=${Array.isArray(userModel.communicationPreferences) ? userModel.communicationPreferences.length : 0} calibration=${Array.isArray(userModel.calibration) ? userModel.calibration.length : 0}`
			);
		}
		if (projectModel) {
			lines.push(
				`project_model: direction=${Array.isArray(projectModel.currentDirection) ? projectModel.currentDirection.length : 0} open_questions=${Array.isArray(projectModel.openQuestions) ? projectModel.openQuestions.length : 0} rejected=${Array.isArray(projectModel.rejectedAlternatives) ? projectModel.rejectedAlternatives.length : 0} risks=${Array.isArray(projectModel.unresolvedRisks) ? projectModel.unresolvedRisks.length : 0}`
			);
		}
	}
	if (selfModel) {
		lines.push(
			`self_model: strengths=${Array.isArray(selfModel.strengths) ? selfModel.strengths.length : 0} failure_modes=${Array.isArray(selfModel.failureModes) ? selfModel.failureModes.length : 0} bias_patterns=${Array.isArray(selfModel.biasPatterns) ? selfModel.biasPatterns.length : 0} pending_review=${String(selfModel.pendingReviewCount ?? 0)}`
		);
	}
	lines.push(`included_fragments: ${included.length}`);
	for (const [index, fragment] of included.entries()) {
		const reason = typeof fragment.reason === "string" ? fragment.reason : "unknown";
		const title = typeof fragment.title === "string" ? fragment.title : "fragment";
		const kind = typeof fragment.kind === "string" ? fragment.kind : "unknown";
		const score = typeof fragment.score === "number" ? fragment.score : null;
		const content = typeof fragment.content === "string" ? fragment.content : "";
		const knownContextRefs = Array.isArray(fragment.knownContextRefs)
			? fragment.knownContextRefs.filter((entry): entry is string => typeof entry === "string")
			: [];
		const explainability =
			fragment.explainability && typeof fragment.explainability === "object" && !Array.isArray(fragment.explainability)
				? (fragment.explainability as Record<string, unknown>)
				: null;
		lines.push(`${index + 1}. [${kind}] ${title}${score === null ? "" : ` score=${score}`}`);
		lines.push(`   reason: ${reason}`);
		if (explainability) {
			const authority =
				typeof explainability.authorityLevel === "string" ? explainability.authorityLevel : "unknown";
			const contradiction =
				typeof explainability.contradictionStatus === "string" ? explainability.contradictionStatus : "unknown";
			const advisory = typeof explainability.advisory === "boolean" ? String(explainability.advisory) : "unknown";
			const evidenceRefs = Array.isArray(explainability.evidenceRefs)
				? explainability.evidenceRefs.filter((entry): entry is string => typeof entry === "string").slice(0, 4)
				: [];
			lines.push(`   explainability: authority=${authority} contradiction=${contradiction} advisory=${advisory}`);
			if (evidenceRefs.length > 0) {
				lines.push(`   evidence_refs: ${evidenceRefs.join(", ")}`);
			}
		}
		if (knownContextRefs.length > 0) {
			lines.push(`   known_context_refs: ${knownContextRefs.join(", ")}`);
		}
		lines.push(`   content: ${truncateForPresentation(content, 220)}`);
	}
	lines.push(`suppressed_fragments: ${suppressed.length}`);
	for (const fragment of suppressed) {
		const title = typeof fragment.title === "string" ? fragment.title : "fragment";
		const kind = typeof fragment.kind === "string" ? fragment.kind : "unknown";
		const policy =
			fragment.suppressionPolicy && typeof fragment.suppressionPolicy === "object" && !Array.isArray(fragment.suppressionPolicy)
				? (fragment.suppressionPolicy as Record<string, unknown>)
				: null;
		const applied = policy && Array.isArray(policy.applied) ? policy.applied.join(", ") : "unknown";
		const preview = typeof fragment.contentPreview === "string" ? fragment.contentPreview : "";
		lines.push(`- [${kind}] ${title} suppressed_by=${applied}`);
		lines.push(`  preview: ${truncateForPresentation(preview, 220)}`);
	}
	return lines.join("\n");
};

export const formatJudgmentInspection = (inspection: Record<string, unknown>): string => {
	const snapshot =
		inspection.snapshot && typeof inspection.snapshot === "object" && !Array.isArray(inspection.snapshot)
			? (inspection.snapshot as Record<string, unknown>)
			: null;
	const entries = Array.isArray(inspection.entries) ? (inspection.entries as Array<Record<string, unknown>>) : [];
	const outcomes = Array.isArray(inspection.recentOutcomeEvents)
		? (inspection.recentOutcomeEvents as Array<Record<string, unknown>>)
		: [];
	const selfModel =
		inspection.selfModel && typeof inspection.selfModel === "object" && !Array.isArray(inspection.selfModel)
			? (inspection.selfModel as Record<string, unknown>)
			: null;
	const selfModelEntries = Array.isArray(inspection.selfModelEntries)
		? (inspection.selfModelEntries as Array<Record<string, unknown>>)
		: [];

	if (!snapshot) {
		return "No continuity judgment available";
	}

	const userModel =
		snapshot.userModel && typeof snapshot.userModel === "object" && !Array.isArray(snapshot.userModel)
			? (snapshot.userModel as Record<string, unknown>)
			: {};
	const projectModel =
		snapshot.projectModel && typeof snapshot.projectModel === "object" && !Array.isArray(snapshot.projectModel)
			? (snapshot.projectModel as Record<string, unknown>)
			: {};
	const formatList = (label: string, values: unknown): string[] => {
		const list = Array.isArray(values) ? (values as Array<Record<string, unknown>>) : [];
		if (list.length === 0) {
			return [];
		}
		return [
			`${label}: ${list.length}`,
			...list.slice(0, 5).map((entry) => `- ${typeof entry.summary === "string" ? entry.summary : typeof entry.marker === "string" ? entry.marker : "entry"}`),
		];
	};

	const lines = ["continuity_judgment"];
	lines.push(...formatList("user_preferences", userModel.communicationPreferences));
	lines.push(...formatList("user_calibration", userModel.calibration));
	lines.push(...formatList("project_direction", projectModel.currentDirection));
	lines.push(...formatList("open_questions", projectModel.openQuestions));
	lines.push(...formatList("rejected_alternatives", projectModel.rejectedAlternatives));
	lines.push(...formatList("unresolved_risks", projectModel.unresolvedRisks));
	lines.push(...formatList("demonstrated_knowledge", snapshot.demonstratedKnowledge));
	lines.push(...formatList("recent_corrections", snapshot.recentCorrections));
	lines.push(...formatList("orientation", snapshot.orientation));
	lines.push(...formatList("redundancy_markers", snapshot.redundancyMarkers));
	if (selfModel) {
		lines.push(...formatList("self_model_strengths", selfModel.strengths));
		lines.push(...formatList("self_model_failure_modes", selfModel.failureModes));
		lines.push(...formatList("self_model_calibration_notes", selfModel.calibrationNotes));
		lines.push(...formatList("self_model_preferred_environments", selfModel.preferredEnvironments));
		lines.push(...formatList("self_model_bias_patterns", selfModel.biasPatterns));
		lines.push(`self_model_pending_review: ${String(selfModel.pendingReviewCount ?? 0)}`);
	}
	lines.push(`active_entries: ${entries.filter((entry) => entry.status === "active").length}`);
	lines.push(`self_model_entries: ${selfModelEntries.length}`);
	lines.push(`recent_outcomes: ${outcomes.length}`);
	for (const outcome of outcomes.slice(0, 3)) {
		lines.push(
			`- ${typeof outcome.outcomeId === "string" ? outcome.outcomeId : "outcome"} ${typeof outcome.taskSucceeded === "boolean" ? (outcome.taskSucceeded ? "success" : "miss") : "unknown"} ${typeof outcome.goal === "string" ? truncateForPresentation(outcome.goal, 120) : ""}`
		);
	}
	return lines.join("\n");
};

export const formatContinuityInspection = (inspection: Record<string, unknown>): string => {
	const state =
		inspection.state && typeof inspection.state === "object" && !Array.isArray(inspection.state)
			? (inspection.state as Record<string, unknown>)
			: null;
	const queue =
		inspection.queue && typeof inspection.queue === "object" && !Array.isArray(inspection.queue)
			? (inspection.queue as Record<string, unknown>)
			: {};
	const runs =
		inspection.runs && typeof inspection.runs === "object" && !Array.isArray(inspection.runs)
			? (inspection.runs as Record<string, unknown>)
			: {};
	const metering =
		inspection.metering && typeof inspection.metering === "object" && !Array.isArray(inspection.metering)
			? (inspection.metering as Record<string, unknown>)
			: {};
	const health =
		inspection.health && typeof inspection.health === "object" && !Array.isArray(inspection.health)
			? (inspection.health as Record<string, unknown>)
			: {};
	const jobs = Array.isArray(inspection.jobs) ? (inspection.jobs as Array<Record<string, unknown>>) : [];
	const deferredReasons = Array.isArray(metering.deferredReasons)
		? (metering.deferredReasons as Array<Record<string, unknown>>)
		: [];
	const formatRun = (jobKind: "reflect" | "dream"): string => {
		const run =
			runs[jobKind] && typeof runs[jobKind] === "object" && !Array.isArray(runs[jobKind])
				? (runs[jobKind] as Record<string, unknown>)
				: {};
		const quality =
			run.qualitySummary && typeof run.qualitySummary === "object" && !Array.isArray(run.qualitySummary)
				? (run.qualitySummary as Record<string, unknown>)
				: null;
		const skipReason =
			typeof run.lastSkipReason === "string" && run.lastSkipReason.length > 0
				? run.lastSkipReason
				: typeof run.lastGovernorSkipReason === "string" && run.lastGovernorSkipReason.length > 0
					? run.lastGovernorSkipReason
					: "none";
		const qualitySummary = quality
			? ` signal_score=${String(quality.signalScore ?? "none")} meaningful=${String(quality.meaningfulOutcomeCount ?? "none")} stale_pending=${String(quality.stalePendingProposalCount ?? "none")}`
			: "";
		return `${jobKind}: status=${String(run.status ?? "missing")} next_due=${String(run.dueAt ?? "none")} last_completed=${String(run.lastCompletedAt ?? "never")} scheduled_reason=${String(run.scheduledReason ?? "none")} last_skip=${skipReason} attempts=${String(run.attemptCount ?? 0)} failures=${String(run.consecutiveFailures ?? 0)}${qualitySummary}`;
	};

	const lines = ["continuity_scheduler"];
	lines.push(
		`outcome_backlog: ${String(queue.outcomeBacklog ?? 0)} earliest=${String(queue.earliestUnprocessedOutcomeAt ?? "none")}`
	);
	lines.push(`pending_dream_proposals: ${String(queue.pendingDreamProposalCount ?? 0)}`);
	if (state) {
		lines.push(`last_outcome_at: ${String(state.lastOutcomeAt ?? "never")}`);
		lines.push(`last_reflect_at: ${String(state.lastReflectAt ?? "never")}`);
		lines.push(`last_dream_at: ${String(state.lastDreamAt ?? "never")}`);
	}
	lines.push(
		`queue: total=${String(queue.totalJobs ?? 0)} due=${String(queue.dueJobs ?? 0)} leased=${String(queue.leasedJobs ?? 0)} retry=${String(queue.retryJobs ?? 0)} dead_letter=${String(queue.deadLetterJobs ?? 0)}`
	);
	if (queue.oldestDueAt) {
		lines.push(`oldest_due_at: ${String(queue.oldestDueAt)}`);
	}
	if (queue.maxLeaseAgeSeconds !== undefined && queue.maxLeaseAgeSeconds !== null) {
		lines.push(`max_lease_age_seconds: ${String(queue.maxLeaseAgeSeconds)}`);
	}
	lines.push(formatRun("reflect"));
	lines.push(formatRun("dream"));
	lines.push(`health: ${String(health.status ?? "unknown")}`);
	const healthReasons = Array.isArray(health.reasons)
		? health.reasons.filter((entry): entry is string => typeof entry === "string")
		: [];
	for (const reason of healthReasons) {
		lines.push(`- ${reason}`);
	}
	lines.push(`shadow_cost_sats: ${String(metering.totalShadowCostSats ?? 0)}`);
	if (deferredReasons.length > 0) {
		lines.push("deferred_reasons:");
		for (const entry of deferredReasons.slice(0, 5)) {
			lines.push(
				`- ${typeof entry.reason === "string" ? entry.reason : "unknown"} count=${String(entry.count ?? 0)} shadow_cost_sats=${String(entry.shadowCostSats ?? 0)}`
			);
		}
	}
	if (jobs.length > 0) {
		lines.push(`jobs: ${jobs.length}`);
		for (const job of jobs) {
			lines.push(
				`- ${typeof job.jobKind === "string" ? job.jobKind : "job"} status=${String(job.status ?? "unknown")} due=${String(job.dueAt ?? "none")} lease_expires=${String(job.leaseExpiresAt ?? "none")} last_error=${String(job.lastError ?? "none")}`
			);
		}
	}
	return lines.join("\n");
};

const formatDreamStringList = (value: unknown, maxItems = 4): string => {
	const values = Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
		: [];
	if (values.length === 0) {
		return "none";
	}
	const shown = values.slice(0, maxItems);
	const suffix = values.length > shown.length ? ` +${values.length - shown.length}` : "";
	return `${shown.join(", ")}${suffix}`;
};

const formatDreamArtifactPreview = (value: unknown): string => {
	const previews = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
	if (previews.length === 0) {
		return "none";
	}
	return previews
		.slice(0, 3)
		.map((preview) => {
			const kind = typeof preview.kind === "string" ? preview.kind : "artifact";
			const action = typeof preview.action === "string" ? preview.action : "record";
			const entryType = typeof preview.entryType === "string" ? ` ${preview.entryType}` : "";
			const target = typeof preview.targetId === "string" ? ` target=${preview.targetId}` : "";
			const content = typeof preview.content === "string" ? ` ${truncateForPresentation(preview.content, 88)}` : "";
			const note = typeof preview.note === "string" ? ` note=${truncateForPresentation(preview.note, 72)}` : "";
			return `${action} ${kind}${entryType}${target}${content}${note}`.trim();
		})
		.join("; ");
};

export const formatDreamInspection = (inspection: Record<string, unknown>): string => {
	const runs = Array.isArray(inspection.runs) ? (inspection.runs as Array<Record<string, unknown>>) : [];
	const proposals = Array.isArray(inspection.proposals) ? (inspection.proposals as Array<Record<string, unknown>>) : [];
	const counts =
		inspection.counts && typeof inspection.counts === "object" && !Array.isArray(inspection.counts)
			? (inspection.counts as Record<string, unknown>)
			: {};
	const inbox =
		inspection.inbox && typeof inspection.inbox === "object" && !Array.isArray(inspection.inbox)
			? (inspection.inbox as Record<string, unknown>)
			: {};
	const inboxItems = Array.isArray(inbox.items)
		? (inbox.items as Array<Record<string, unknown>>)
		: proposals;
	const lines = [
		"dreaming",
		`runs: ${runs.length}`,
		`pending: ${String(counts.pending ?? inbox.pendingCount ?? 0)}`,
		`approved: ${String(counts.approved ?? 0)}`,
		`rejected: ${String(counts.rejected ?? 0)}`,
		`superseded: ${String(counts.superseded ?? 0)}`,
		`inbox: pending=${String(inbox.pendingCount ?? counts.pending ?? 0)} blocking=${String(inbox.blockingPendingCount ?? 0)} stale=${String(inbox.stalePendingCount ?? 0)}`,
	];
	for (const run of runs.slice(0, 2)) {
		lines.push(
			`- run ${typeof run.runId === "string" ? run.runId : "unknown"} trigger=${typeof run.trigger === "string" ? run.trigger : "unknown"} status=${typeof run.status === "string" ? run.status : "unknown"} proposals=${String((run.summary as Record<string, unknown> | undefined)?.totalProposals ?? 0)}`
		);
	}
	for (const item of inboxItems.slice(0, 6)) {
		const scope = item.scope && typeof item.scope === "object" && !Array.isArray(item.scope)
			? (item.scope as Record<string, unknown>)
			: {};
		const proposalId = typeof item.proposalId === "string" ? item.proposalId : "proposal";
		const status = typeof item.status === "string" ? item.status : "pending";
		const proposalType = typeof item.proposalType === "string" ? item.proposalType : "proposal";
		const confidence = typeof item.confidence === "number" ? item.confidence.toFixed(2) : "n/a";
		const promotionType = typeof item.promotionType === "string" ? item.promotionType : "unknown";
		const wording =
			typeof item.proposedDurableWording === "string"
				? truncateForPresentation(item.proposedDurableWording, 140)
				: typeof item.summary === "string"
					? truncateForPresentation(item.summary, 140)
					: "proposal";
		lines.push(`- ${proposalId} [${status}] ${proposalType} confidence=${confidence} promotion=${promotionType}`);
		lines.push(`  wording: ${wording}`);
		lines.push(`  evidence: ${formatDreamStringList(item.evidenceRefs)}`);
		lines.push(
			`  scope: targets=${formatDreamStringList(scope.targetRefs, 3)} sources=${formatDreamStringList(scope.sourceRefs, 3)} hosts=${formatDreamStringList(scope.preferredRuntimeHosts, 3)} tags=${formatDreamStringList(scope.tags, 3)}`
		);
		lines.push(`  preview: ${formatDreamArtifactPreview(item.appliedArtifactPreview)}`);
		lines.push(`  rejection_risks: ${formatDreamStringList(item.rejectionRisks)}`);
		if (typeof item.supersededByProposalId === "string") {
			lines.push(`  superseded_by: ${item.supersededByProposalId}`);
		}
		lines.push(`  detail: crosshead context dreams inspect --proposal-id ${proposalId} --json`);
	}
	return lines.join("\n");
};

export const formatObligationInspection = (inspection: Record<string, unknown>): string => {
	const obligations = Array.isArray(inspection.obligations)
		? (inspection.obligations as Array<Record<string, unknown>>)
		: [];
	const summary =
		inspection.summary && typeof inspection.summary === "object" && !Array.isArray(inspection.summary)
			? (inspection.summary as Record<string, unknown>)
			: {};
	const lines = [
		"obligations",
		`total: ${String(summary.total ?? obligations.length)}`,
		`due: ${String(summary.due ?? 0)}`,
		`scheduled: ${String(summary.scheduled ?? 0)}`,
		`done: ${String(summary.done ?? 0)}`,
		`next_fire_at: ${typeof summary.nextFireAt === "string" ? summary.nextFireAt : "none"}`,
	];
	for (const obligation of obligations.slice(0, 20)) {
		const status = typeof obligation.status === "string" ? obligation.status : "unknown";
		const mode = typeof obligation.actionMode === "string" ? obligation.actionMode : "remind";
		const title = typeof obligation.title === "string" ? truncateForPresentation(obligation.title, 72) : "(untitled)";
		const nextFire = typeof obligation.nextFireAt === "string" ? obligation.nextFireAt : "—";
		const recurring = obligation.recurrence && typeof obligation.recurrence === "object" ? " (recurring)" : "";
		lines.push(`- [${status}/${mode}] ${title} next=${nextFire}${recurring}`);
	}
	return lines.join("\n");
};

export const formatDreamRunResult = (result: Record<string, unknown>): string => {
	const run =
		result.run && typeof result.run === "object" && !Array.isArray(result.run)
			? (result.run as Record<string, unknown>)
			: null;
	const proposals = Array.isArray(run?.proposals) ? (run?.proposals as Array<Record<string, unknown>>) : [];
	const lines = [
		`run_id: ${typeof run?.runId === "string" ? run.runId : "unknown"}`,
		`trigger: ${typeof run?.trigger === "string" ? run.trigger : "unknown"}`,
		`status: ${typeof run?.status === "string" ? run.status : "unknown"}`,
		`proposals: ${proposals.length}`,
	];
	if (
		run?.scheduleDecision &&
		typeof run.scheduleDecision === "object" &&
		!Array.isArray(run.scheduleDecision) &&
		typeof (run.scheduleDecision as Record<string, unknown>).reason === "string"
	) {
		lines.push(`schedule_reason: ${(run.scheduleDecision as Record<string, unknown>).reason as string}`);
	}
	for (const proposal of proposals.slice(0, 5)) {
		lines.push(
			`- ${typeof proposal.proposalId === "string" ? proposal.proposalId : "proposal"} ${typeof proposal.proposalType === "string" ? proposal.proposalType : "unknown"} ${typeof proposal.summary === "string" ? truncateForPresentation(proposal.summary, 96) : ""}`.trim()
		);
	}
	return lines.join("\n");
};

export const formatDreamReviewResult = (result: Record<string, unknown>): string => {
	const proposal =
		result.proposal && typeof result.proposal === "object" && !Array.isArray(result.proposal)
			? (result.proposal as Record<string, unknown>)
			: null;
	const latestReview =
		proposal?.latestReview && typeof proposal.latestReview === "object" && !Array.isArray(proposal.latestReview)
			? (proposal.latestReview as Record<string, unknown>)
			: null;
	const lines = [
		`proposal_id: ${typeof proposal?.proposalId === "string" ? proposal.proposalId : "unknown"}`,
		`status: ${typeof proposal?.status === "string" ? proposal.status : "unknown"}`,
		`type: ${typeof proposal?.proposalType === "string" ? proposal.proposalType : "unknown"}`,
	];
	if (typeof proposal?.summary === "string") {
		lines.push(`summary: ${proposal.summary}`);
	}
	if (latestReview && typeof latestReview.decision === "string") {
		lines.push(`decision: ${latestReview.decision}`);
	}
	if (latestReview && typeof latestReview.supersededByProposalId === "string") {
		lines.push(`superseded_by: ${latestReview.supersededByProposalId}`);
	}
	if (latestReview && typeof latestReview.mergedIntoProposalId === "string") {
		lines.push(`merged_into: ${latestReview.mergedIntoProposalId}`);
	}
	if (latestReview && Array.isArray(latestReview.appliedArtifacts) && latestReview.appliedArtifacts.length > 0) {
		lines.push(`applied_artifacts: ${latestReview.appliedArtifacts.length}`);
	}
	return lines.join("\n");
};

export const formatSelfModelReviewResult = (result: Record<string, unknown>): string => {
	const decision = typeof result.decision === "string" ? result.decision : "unknown";
	const entry =
		result.entry && typeof result.entry === "object" && !Array.isArray(result.entry)
			? (result.entry as Record<string, unknown>)
			: null;
	const profile =
		result.profile && typeof result.profile === "object" && !Array.isArray(result.profile)
			? (result.profile as Record<string, unknown>)
			: null;
	const lines = [
		`decision: ${decision}`,
		`entry_id: ${typeof result.entryId === "string" ? result.entryId : "unknown"}`,
	];
	if (typeof result.replacementEntryId === "string" && result.replacementEntryId.length > 0) {
		lines.push(`replacement_entry_id: ${result.replacementEntryId}`);
	}
	if (entry) {
		const payload =
			entry.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)
				? (entry.payload as Record<string, unknown>)
				: null;
		if (payload && typeof payload.section === "string") {
			lines.push(`section: ${payload.section}`);
		}
		if (payload && typeof payload.summary === "string") {
			lines.push(`summary: ${payload.summary}`);
		}
		if (payload && payload.review && typeof payload.review === "object" && !Array.isArray(payload.review)) {
			const review = payload.review as Record<string, unknown>;
			if (typeof review.state === "string") {
				lines.push(`review_state: ${review.state}`);
			}
		}
	}
	if (profile) {
		lines.push(`pending_review: ${String(profile.pendingReviewCount ?? 0)}`);
	}
	return lines.join("\n");
};

export const formatHandoffVerification = (verification: Record<string, unknown>): string => {
	const valid = verification.valid === true;
	const signatureValid = verification.signatureValid === true;
	const withinBudget = verification.withinBudget === true;
	const errors = Array.isArray(verification.errors)
		? verification.errors.filter((entry): entry is string => typeof entry === "string")
		: [];
	const warnings = Array.isArray(verification.warnings)
		? verification.warnings.filter((entry): entry is string => typeof entry === "string")
		: [];
	const lines = [
		`valid: ${valid ? "yes" : "no"}`,
		`signature_valid: ${signatureValid ? "yes" : "no"}`,
		`within_budget: ${withinBudget ? "yes" : "no"}`,
	];
	if (typeof verification.sourceRuntime === "string") {
		lines.push(`source_runtime: ${verification.sourceRuntime}`);
	}
	if (typeof verification.targetRuntime === "string") {
		lines.push(`target_runtime: ${verification.targetRuntime}`);
	}
	if (typeof verification.signedBy === "string") {
		lines.push(`signed_by: ${verification.signedBy}`);
		lines.push(`signer mark (visual only):\n${renderAgentMarkText(verification.signedBy)}`);
	}
	if (typeof verification.sizeBytes === "number") {
		lines.push(`size_bytes: ${verification.sizeBytes}`);
	}
	if (warnings.length > 0) {
		lines.push(`warnings: ${warnings.join(" | ")}`);
	}
	if (errors.length > 0) {
		lines.push("errors:");
		lines.push(...errors.map((error) => `- ${error}`));
	}
	return lines.join("\n");
};

export const formatHandoffInspection = (inspection: Record<string, unknown>): string => {
	const fidelity =
		inspection.fidelity && typeof inspection.fidelity === "object" && !Array.isArray(inspection.fidelity)
			? (inspection.fidelity as Record<string, unknown>)
			: null;
	const task =
		inspection.task && typeof inspection.task === "object" && !Array.isArray(inspection.task)
			? (inspection.task as Record<string, unknown>)
			: null;
	const reasoning =
		inspection.reasoning && typeof inspection.reasoning === "object" && !Array.isArray(inspection.reasoning)
			? (inspection.reasoning as Record<string, unknown>)
			: null;
	const references =
		inspection.references && typeof inspection.references === "object" && !Array.isArray(inspection.references)
			? (inspection.references as Record<string, unknown>)
			: null;
	const sizeBudget =
		inspection.sizeBudget && typeof inspection.sizeBudget === "object" && !Array.isArray(inspection.sizeBudget)
			? (inspection.sizeBudget as Record<string, unknown>)
			: null;
	const warnings = Array.isArray(inspection.warnings)
		? inspection.warnings.filter((entry): entry is string => typeof entry === "string")
		: [];
	const continuation =
		inspection.continuation && typeof inspection.continuation === "object" && !Array.isArray(inspection.continuation)
			? (inspection.continuation as Record<string, unknown>)
			: null;
	const carriedForward = Array.isArray(continuation?.carriedForward)
		? continuation.carriedForward.filter((entry): entry is string => typeof entry === "string")
		: [];
	const referenceOnly = Array.isArray(continuation?.referenceOnly)
		? continuation.referenceOnly.filter((entry): entry is string => typeof entry === "string")
		: [];
	const manualReestablishment = Array.isArray(continuation?.manualReestablishment)
		? continuation.manualReestablishment.filter((entry): entry is string => typeof entry === "string")
		: [];

	const lines = [
		`handoff_id: ${typeof inspection.handoffId === "string" ? inspection.handoffId : "unknown"}`,
		`capsule: ${typeof inspection.capsuleKind === "string" ? inspection.capsuleKind : "unknown"} ${typeof inspection.capsuleVersion === "string" ? inspection.capsuleVersion : ""}`.trim(),
		`route: ${typeof inspection.sourceRuntime === "string" ? inspection.sourceRuntime : "unknown"} -> ${typeof inspection.targetRuntime === "string" ? inspection.targetRuntime : "unknown"}`,
		typeof inspection.signedBy === "string" ? `signed_by: ${inspection.signedBy}\nsigner mark (visual only):\n${renderAgentMarkText(inspection.signedBy)}` : null,
		typeof inspection.createdAt === "string" ? `created_at: ${inspection.createdAt}` : null,
		task && typeof task.objective === "string" ? `task: ${task.objective}` : null,
		task && Array.isArray(task.openLoops) && task.openLoops.length > 0 ? `open_loops: ${task.openLoops.join(" | ")}` : null,
		reasoning && typeof reasoning.currentTheory === "string" ? `current_theory: ${reasoning.currentTheory}` : null,
		reasoning && Array.isArray(reasoning.openQuestions) && reasoning.openQuestions.length > 0
			? `open_questions: ${reasoning.openQuestions.join(" | ")}`
			: null,
		references
			? `references: hot=${String(references.hotMemory ?? "unknown")} warm=${String(references.warmCount ?? 0)} cold=${String(references.coldCount ?? 0)}`
			: null,
		fidelity ? `fidelity: ${String(fidelity.level ?? "unknown")} ${String(fidelity.summary ?? "")}`.trim() : null,
		sizeBudget
			? `size_budget: ${String(sizeBudget.actualBytes ?? "?")}/${String(sizeBudget.maxBytes ?? "?")} bytes`
			: null,
		typeof inspection.redactionCount === "number" ? `redactions: ${inspection.redactionCount}` : null,
		typeof inspection.opaqueAttachmentCount === "number" ? `opaque_attachments: ${inspection.opaqueAttachmentCount}` : null,
		carriedForward.length > 0 ? `carried_forward: ${carriedForward.join(" | ")}` : null,
		referenceOnly.length > 0 ? `reference_only: ${referenceOnly.join(" | ")}` : null,
		manualReestablishment.length > 0 ? `manual_reestablishment: ${manualReestablishment.join(" | ")}` : null,
		warnings.length > 0 ? `warnings: ${warnings.join(" | ")}` : null,
	].filter((value): value is string => value !== null);

	return lines.join("\n");
};

export const formatHandoffExportResult = (result: Record<string, unknown>): string => {
	const record =
		result.record && typeof result.record === "object" && !Array.isArray(result.record)
			? (result.record as Record<string, unknown>)
			: null;
	const inspection =
		record?.inspection && typeof record.inspection === "object" && !Array.isArray(record.inspection)
			? (record.inspection as Record<string, unknown>)
			: null;
	const materialization =
		result.materialization && typeof result.materialization === "object" && !Array.isArray(result.materialization)
			? (result.materialization as Record<string, unknown>)
			: null;
	const delivery =
		materialization?.delivery && typeof materialization.delivery === "object" && !Array.isArray(materialization.delivery)
			? (materialization.delivery as Record<string, unknown>)
			: null;
	const comparison =
		result.restatementComparison && typeof result.restatementComparison === "object" && !Array.isArray(result.restatementComparison)
			? (result.restatementComparison as Record<string, unknown>)
			: null;
	const baseline =
		comparison?.baseline && typeof comparison.baseline === "object" && !Array.isArray(comparison.baseline)
			? (comparison.baseline as Record<string, unknown>)
			: null;
	const materialized =
		comparison?.materialized && typeof comparison.materialized === "object" && !Array.isArray(comparison.materialized)
			? (comparison.materialized as Record<string, unknown>)
			: null;
	const inspectionText = inspection ? formatHandoffInspection(inspection) : "handoff export created a capsule";

	const lines = [inspectionText];
	if (delivery) {
		lines.push(
			`delivery: ${String(delivery.primary ?? "unknown")}${
				typeof delivery.managedSurface === "string" ? ` via ${delivery.managedSurface}` : ""
			}`
		);
	}
	if (comparison) {
		lines.push(
			`restatement_coverage: baseline=${String(baseline?.score ?? "?")} materialized=${String(materialized?.score ?? "?")} lift=${String(comparison.lift ?? "?")}`
		);
	}
	if (typeof materialization?.startupContext === "string") {
		lines.push("claude_startup_context:");
		lines.push(String(materialization.startupContext));
	}
	return lines.join("\n");
};

export const formatHandoffImportResult = (result: Record<string, unknown>): string => {
	const inspection =
		result.inspection && typeof result.inspection === "object" && !Array.isArray(result.inspection)
			? (result.inspection as Record<string, unknown>)
			: null;
	const materialization =
		result.materialization && typeof result.materialization === "object" && !Array.isArray(result.materialization)
			? (result.materialization as Record<string, unknown>)
			: null;
	const delivery =
		materialization?.delivery && typeof materialization.delivery === "object" && !Array.isArray(materialization.delivery)
			? (materialization.delivery as Record<string, unknown>)
			: null;
	const receipt =
		result.receipt && typeof result.receipt === "object" && !Array.isArray(result.receipt)
			? (result.receipt as Record<string, unknown>)
			: null;
	const comparison =
		result.restatementComparison && typeof result.restatementComparison === "object" && !Array.isArray(result.restatementComparison)
			? (result.restatementComparison as Record<string, unknown>)
			: null;
	const baseline =
		comparison?.baseline && typeof comparison.baseline === "object" && !Array.isArray(comparison.baseline)
			? (comparison.baseline as Record<string, unknown>)
			: null;
	const materializedCoverage =
		comparison?.materialized && typeof comparison.materialized === "object" && !Array.isArray(comparison.materialized)
			? (comparison.materialized as Record<string, unknown>)
			: null;

	const lines = [
		inspection ? formatHandoffInspection(inspection) : "handoff import",
		`accepted: ${result.accepted === true ? "yes" : "no"}`,
		delivery
			? `delivery: ${String(delivery.primary ?? "unknown")}${
					typeof delivery.managedSurface === "string" ? ` via ${delivery.managedSurface}` : ""
				}`
			: null,
		comparison
			? `restatement_coverage: baseline=${String(baseline?.score ?? "?")} materialized=${String(materializedCoverage?.score ?? "?")} lift=${String(comparison.lift ?? "?")}`
			: null,
		receipt && typeof receipt.receivedAt === "string" ? `receipt_at: ${receipt.receivedAt}` : null,
	].filter((value): value is string => value !== null);

	if (typeof materialization?.startupContext === "string") {
		lines.push("startup_context:");
		lines.push(String(materialization.startupContext));
	}

	return lines.join("\n");
};

export const formatHandoffOutcomeResult = (result: Record<string, unknown>): string => {
	const outcome =
		result.outcome && typeof result.outcome === "object" && !Array.isArray(result.outcome)
			? (result.outcome as Record<string, unknown>)
			: null;
	const judgment =
		result.judgment && typeof result.judgment === "object" && !Array.isArray(result.judgment)
			? (result.judgment as Record<string, unknown>)
			: null;
	const updates = Array.isArray(result.judgment_updates) ? result.judgment_updates : [];

	return [
		typeof outcome?.outcomeId === "string" ? `outcome_id: ${outcome.outcomeId}` : null,
		typeof outcome?.kind === "string" ? `kind: ${outcome.kind}` : null,
		typeof outcome?.reporterRuntime === "string" ? `reported_by: ${outcome.reporterRuntime}` : null,
		typeof outcome?.reportedAt === "string" ? `reported_at: ${outcome.reportedAt}` : null,
		typeof outcome?.summary === "string" ? `summary: ${outcome.summary}` : null,
		typeof outcome?.resultingHandoffId === "string" ? `resulting_handoff_id: ${outcome.resultingHandoffId}` : null,
		typeof result.outcome_event_id === "string" ? `judgment_outcome_event_id: ${String(result.outcome_event_id)}` : null,
		judgment && typeof judgment === "object" ? `judgment_updates: ${updates.length}` : null,
	]
		.filter((value): value is string => value !== null)
		.join("\n");
};

type MemorySearchPresentationEntry = {
	rank: number;
	tier: "warm" | "cold";
	id: string;
	title: string;
	summary: string;
	source: string;
	createdAt: string | null;
	tags: string[];
	relevance: number;
	confidence: number | null;
	status: string | null;
	type: string | null;
	role: string | null;
};

type MemorySearchPresentation = {
	query: string;
	topK: number;
	counts: {
		warm: number;
		cold: number;
		returned: number;
	};
	results: MemorySearchPresentationEntry[];
};

const tokenizeForPresentation = (value: string): string[] =>
	value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length >= 3);

export const truncateForPresentation = (value: string, maxLength: number): string => {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 14)).trimEnd()}... [truncated]`;
};

const summarizeStructuredValue = (value: unknown, maxLength: number = 180): string => {
	if (value === null) {
		return "null";
	}
	if (typeof value === "string") {
		return truncateForPresentation(value, maxLength);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		const parts = value.slice(0, 3).map((entry) => summarizeStructuredValue(entry, 48));
		const suffix = value.length > 3 ? `, ... (${value.length - 3} omitted)` : "";
		return truncateForPresentation(`[${parts.join(", ")}${suffix}]`, maxLength);
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.slice(0, 4)
			.map(([key, entryValue]) => `${key}=${summarizeStructuredValue(entryValue, 48)}`);
		const suffix =
			Object.keys(value as Record<string, unknown>).length > 4
				? `, ... (${Object.keys(value as Record<string, unknown>).length - 4} fields omitted)`
				: "";
		return truncateForPresentation(entries.join(", ") + suffix, maxLength);
	}
	return truncateForPresentation(String(value), maxLength);
};

type WarmMemoryEntryInspectionView = {
	freshness: string | null;
	curationAction: string | null;
	curationReason: string | null;
	visibilityReason: string | null;
	systemMemory: boolean;
	generalWarmMemory: boolean | null;
	ageDays: number | null;
	archived: boolean;
	promotionOutcome: string | null;
	promotionScore: number | null;
	retrievalUsefulness: number | null;
	promotionReasons: string[];
	supersedesEntryIds: string[];
	conflictingEntryIds: string[];
};

type WarmMemoryRecentOutcomeSummary = {
	total: number;
	outcomes: Record<string, number>;
};

const parseWarmMemoryInspectionView = (entry: Record<string, unknown>): WarmMemoryEntryInspectionView => {
	const inspection =
		entry.inspection && typeof entry.inspection === "object" && !Array.isArray(entry.inspection)
			? (entry.inspection as Record<string, unknown>)
			: null;
	const promotion =
		inspection?.promotion && typeof inspection.promotion === "object" && !Array.isArray(inspection.promotion)
			? (inspection.promotion as Record<string, unknown>)
			: null;
	const visibility =
		inspection?.visibility && typeof inspection.visibility === "object" && !Array.isArray(inspection.visibility)
			? (inspection.visibility as Record<string, unknown>)
			: null;
	return {
		freshness: typeof inspection?.freshness === "string" ? inspection.freshness : null,
		curationAction: typeof inspection?.curationAction === "string" ? inspection.curationAction : null,
		curationReason: typeof inspection?.curationReason === "string" ? inspection.curationReason : null,
		visibilityReason: typeof visibility?.reason === "string" ? visibility.reason : null,
		systemMemory: visibility?.systemMemory === true,
		generalWarmMemory: typeof visibility?.generalWarmMemory === "boolean" ? visibility.generalWarmMemory : null,
		ageDays: typeof inspection?.ageDays === "number" ? inspection.ageDays : null,
		archived: inspection?.archived === true,
		promotionOutcome: typeof promotion?.outcome === "string" ? promotion.outcome : null,
		promotionScore: typeof promotion?.score === "number" ? promotion.score : null,
		retrievalUsefulness: typeof promotion?.retrievalUsefulness === "number" ? promotion.retrievalUsefulness : null,
		promotionReasons: Array.isArray(promotion?.reasons)
			? promotion.reasons.filter((value): value is string => typeof value === "string")
			: [],
		supersedesEntryIds: Array.isArray(promotion?.supersedesEntryIds)
			? promotion.supersedesEntryIds.filter((value): value is string => typeof value === "string")
			: [],
		conflictingEntryIds: Array.isArray(promotion?.conflictingEntryIds)
			? promotion.conflictingEntryIds.filter((value): value is string => typeof value === "string")
			: [],
	};
};

export const formatWarmMemoryEntryForDisplay = (entry: Record<string, unknown>): string => {
	const id = typeof entry.id === "string" ? entry.id : "unknown";
	const type = typeof entry.type === "string" ? entry.type : "unknown";
	const status = typeof entry.status === "string" ? entry.status : "unknown";
	const confidence =
		typeof entry.validityConfidence === "number"
			? entry.validityConfidence
			: typeof entry.validity_confidence === "number"
				? entry.validity_confidence
				: null;
	const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [];
	const content = typeof entry.content === "string" ? truncateForPresentation(entry.content, 220) : "";
	const inspection = parseWarmMemoryInspectionView(entry);
	const lines = [`${id} ${type}/${status}${confidence === null ? "" : ` confidence=${confidence}`}`];
	if (content.length > 0) {
		lines.push(content);
	}
	if (inspection.freshness || inspection.curationAction || inspection.ageDays !== null) {
		lines.push(
			[
				"inspection:",
				inspection.freshness ? `freshness=${inspection.freshness}` : null,
				inspection.curationAction ? `curation=${inspection.curationAction}` : null,
				inspection.systemMemory ? "visibility=system-hidden" : null,
				inspection.ageDays !== null ? `age_days=${inspection.ageDays}` : null,
				inspection.archived ? "archived=true" : null,
			]
				.filter((value): value is string => value !== null)
				.join(" ")
		);
	}
	if (inspection.promotionOutcome || inspection.promotionScore !== null || inspection.retrievalUsefulness !== null) {
		lines.push(
			[
				"promotion:",
				inspection.promotionOutcome ? `outcome=${inspection.promotionOutcome}` : null,
				inspection.promotionScore !== null ? `score=${inspection.promotionScore}` : null,
				inspection.retrievalUsefulness !== null ? `usefulness=${inspection.retrievalUsefulness}` : null,
			]
				.filter((value): value is string => value !== null)
				.join(" ")
		);
	}
	if (inspection.promotionReasons.length > 0) {
		lines.push(`why: ${inspection.promotionReasons.join(" | ")}`);
	}
	if (inspection.curationReason) {
		lines.push(`curation_reason: ${inspection.curationReason}`);
	}
	if (inspection.supersedesEntryIds.length > 0) {
		lines.push(`supersedes: ${inspection.supersedesEntryIds.join(", ")}`);
	}
	if (inspection.conflictingEntryIds.length > 0) {
		lines.push(`conflicts: ${inspection.conflictingEntryIds.join(", ")}`);
	}
	if (tags.length > 0) {
		lines.push(`tags: ${tags.join(", ")}`);
	}
	return lines.join("\n");
};

export const summarizeRecentWarmMemoryOutcomes = (activity: RuntimeLifecycleActivity): WarmMemoryRecentOutcomeSummary => {
	const outcomes: Record<string, number> = {};
	let total = 0;
	for (const action of activity.actions) {
		if (action.type !== "warm_commit" && action.type !== "warm_proposal") {
			continue;
		}
		const details =
			action.details && typeof action.details === "object" && !Array.isArray(action.details)
				? (action.details as Record<string, unknown>)
				: null;
		const decision =
			details?.decision && typeof details.decision === "object" && !Array.isArray(details.decision)
				? (details.decision as Record<string, unknown>)
				: null;
		const outcome = typeof decision?.outcome === "string" ? decision.outcome : action.type === "warm_proposal" ? "proposed" : null;
		if (!outcome) {
			continue;
		}
		outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
		total += 1;
	}
	return { total, outcomes };
};

export const formatWarmMemoryEvaluation = (
	report: WarmMemoryEvaluationReport,
	recentOutcomes: WarmMemoryRecentOutcomeSummary
): string => {
	const lines = [
		`evaluated_at: ${report.evaluatedAt}`,
		`entries_total: ${report.summary.total}`,
		`statuses: active=${report.summary.statuses.active} flagged=${report.summary.statuses.flagged} superseded=${report.summary.statuses.superseded} archived=${report.summary.statuses.archived}`,
		`freshness: fresh=${report.summary.freshness.fresh} aging=${report.summary.freshness.aging} stale=${report.summary.freshness.stale} protected=${report.summary.freshness.protected}`,
		`curation: keep=${report.summary.curation.keep} review=${report.summary.curation.review} archive=${report.summary.curation.archive}`,
		`outcomes: promoted=${report.summary.outcomes.promoted} merged=${report.summary.outcomes.merged} superseded=${report.summary.outcomes.superseded} proposed=${report.summary.outcomes.proposed} unknown=${report.summary.outcomes.unknown}`,
	];
	if (recentOutcomes.total > 0) {
		const recentLine = Object.entries(recentOutcomes.outcomes)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([outcome, count]) => `${outcome}=${count}`)
			.join(" ");
		lines.push(`recent_runtime_candidates: ${recentLine}`);
	}
	if (report.applied) {
		lines.push(`archived_now: ${report.archivedEntryIds.length}`);
	}
	const actionable = report.entries.filter((entry) => {
		const inspection =
			entry.inspection && typeof entry.inspection === "object" && !Array.isArray(entry.inspection)
				? (entry.inspection as Record<string, unknown>)
				: null;
		return typeof inspection?.curationAction === "string" && inspection.curationAction !== "keep";
	});
	lines.push(`actionable_entries: ${actionable.length}`);
	for (const entry of actionable.slice(0, 10)) {
		const inspection = parseWarmMemoryInspectionView(entry as unknown as Record<string, unknown>);
		const content = typeof entry.content === "string" ? truncateForPresentation(entry.content, 140) : "";
		lines.push(
			`- ${entry.id} ${entry.type}/${entry.status} freshness=${inspection.freshness ?? "unknown"} curation=${
				inspection.curationAction ?? "keep"
			}`
		);
		if (inspection.curationReason) {
			lines.push(`  reason: ${inspection.curationReason}`);
		}
		if (content.length > 0) {
			lines.push(`  content: ${content}`);
		}
	}
	return lines.join("\n");
};

const formatSingleHotContent = (rawContent: string): string => {
	const content = rawContent.trim();
	if (content.length === 0) {
		return "";
	}
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return Object.keys(parsed)
				.sort((left, right) => left.localeCompare(right))
				.map((key) => `${key}: ${summarizeStructuredValue(parsed[key])}`)
				.join("\n");
		}
	} catch {
		// Fall through to plain text formatting.
	}
	return truncateForPresentation(content, 1200);
};

export const formatHotMemoryForDisplay = (hot: Record<string, unknown>): string => {
	// Cross-body union response: render one labelled section per runtime scope.
	if (Array.isArray(hot.scopes)) {
		return (hot.scopes as Array<Record<string, unknown>>)
			.map((entry) => {
				const body = formatSingleHotContent(typeof entry.content === "string" ? entry.content : "");
				return body.length === 0 ? "" : `[${String(entry.scope ?? "shared")}]\n${body}`;
			})
			.filter((section) => section.length > 0)
			.join("\n\n");
	}
	return formatSingleHotContent(typeof hot.content === "string" ? hot.content : "");
};

const scoreTextOverlap = (queryTokens: string[], value: string): number => {
	if (queryTokens.length === 0) {
		return 0;
	}
	const candidateTokens = new Set(tokenizeForPresentation(value));
	if (candidateTokens.size === 0) {
		return 0;
	}
	let matches = 0;
	for (const token of queryTokens) {
		if (candidateTokens.has(token)) {
			matches += 1;
		}
	}
	return matches / queryTokens.length;
};

const normalizePresentationScore = (value: number): number => Number(Math.max(0, value).toFixed(3));

const normalizedDedupKey = (value: string): string =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.slice(0, 160);

export const buildMemorySearchPresentation = (
	query: string,
	topK: number,
	result: Record<string, unknown>
): MemorySearchPresentation => {
	const queryTokens = tokenizeForPresentation(query);
	const warm = Array.isArray(result.warm) ? (result.warm as Array<Record<string, unknown>>) : [];
	const cold = Array.isArray(result.cold) ? (result.cold as Array<Record<string, unknown>>) : [];

	const ranked = [
		...warm.map((entry) => {
			const content = typeof entry.content === "string" ? entry.content : "";
			const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [];
			const type = typeof entry.type === "string" ? entry.type : null;
			const status = typeof entry.status === "string" ? entry.status : null;
			const confidence = typeof entry.validityConfidence === "number" ? entry.validityConfidence : null;
			const relevance = normalizePresentationScore(
				0.45 +
					scoreTextOverlap(queryTokens, content) * 0.4 +
					scoreTextOverlap(queryTokens, tags.join(" ")) * 0.1 +
					(type === "commitment" ? 0.08 : type === "correction" ? 0.07 : type === "fact" ? 0.03 : 0.02) +
					(status === "active" ? 0.04 : 0)
			);
			return {
				tier: "warm" as const,
				id: typeof entry.id === "string" ? entry.id : "unknown",
				title: `${type ?? "warm"}${status ? ` (${status})` : ""}`,
				summary: truncateForPresentation(content, 220),
				source: "warm_memory",
				createdAt:
					typeof entry.updatedAt === "string"
						? entry.updatedAt
						: typeof entry.createdAt === "string"
							? entry.createdAt
							: null,
				tags,
				relevance,
				confidence,
				status,
				type,
				role: null,
			};
		}),
		...cold.map((entry) => {
			const content = typeof entry.content === "string" ? entry.content : "";
			const role = typeof entry.role === "string" ? entry.role : null;
			const relevance = normalizePresentationScore(
				0.22 + scoreTextOverlap(queryTokens, content) * 0.68 + (role === "user" ? 0.04 : role === "assistant" ? 0.02 : 0)
			);
			return {
				tier: "cold" as const,
				id: typeof entry.id === "string" ? entry.id : "unknown",
				title: `cold transcript${role ? ` (${role})` : ""}`,
				summary: truncateForPresentation(content, 220),
				source: "cold_memory",
				createdAt:
					typeof entry.timestamp === "string"
						? entry.timestamp
						: typeof entry.createdAt === "string"
							? entry.createdAt
							: null,
				tags: [],
				relevance,
				confidence: null,
				status: null,
				type: null,
				role,
			};
		}),
	]
		.sort((left, right) => {
			const relevanceDelta = right.relevance - left.relevance;
			if (relevanceDelta !== 0) {
				return relevanceDelta;
			}
			const timeDelta = (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
			if (timeDelta !== 0) {
				return timeDelta;
			}
			return left.id.localeCompare(right.id);
		});

	const deduped: Array<Omit<MemorySearchPresentationEntry, "rank">> = [];
	const seen = new Set<string>();
	for (const entry of ranked) {
		const dedupKey = normalizedDedupKey(`${entry.tier}:${entry.summary}`);
		if (dedupKey.length > 0 && seen.has(dedupKey)) {
			continue;
		}
		seen.add(dedupKey);
		deduped.push(entry);
	}

	const results = deduped.slice(0, Math.max(1, topK)).map((entry, index) => ({
		rank: index + 1,
		...entry,
	}));

	return {
		query,
		topK,
		counts: {
			warm: warm.length,
			cold: cold.length,
			returned: results.length,
		},
		results,
	};
};

export const formatMemorySearchPresentation = (presentation: MemorySearchPresentation): string => {
	if (presentation.results.length === 0) {
		return `No memory search results for "${presentation.query}"`;
	}
	return presentation.results
		.map((entry) => {
			const metadata = [
				`rank=${entry.rank}`,
				`tier=${entry.tier}`,
				entry.type ? `type=${entry.type}` : null,
				entry.status ? `status=${entry.status}` : null,
				entry.role ? `role=${entry.role}` : null,
				entry.confidence !== null ? `confidence=${entry.confidence}` : null,
				`relevance=${entry.relevance}`,
				entry.createdAt ? `at=${entry.createdAt}` : null,
			]
				.filter((value): value is string => value !== null)
				.join(" ");
			const tagLine = entry.tags.length > 0 ? `tags: ${entry.tags.join(", ")}` : null;
			return [entry.title, metadata, entry.summary, tagLine].filter((value): value is string => Boolean(value)).join("\n");
		})
		.join("\n\n");
};

export const formatRuntimeUpdateCheck = (result: Awaited<ReturnType<typeof checkForRuntimeUpdates>>): string => {
	const lines = [
		`home: ${result.home}`,
		`channel: ${result.channel}`,
		`core: ${describeVersionDelta(result.currentCoreVersion, result.latestCoreVersion)}`,
		`manifest: ${result.manifestPath ?? "none"}`,
	];
	if (result.adapters.length > 0) {
		lines.push(
			...result.adapters.map((adapter) =>
				`${adapter.name}: ${describeVersionDelta(adapter.currentVersion, adapter.latestVersion)}${
					adapter.compatible ? "" : ` incompatible (${adapter.reason})`
				}`
			)
		);
	} else {
		lines.push("adapters: none installed");
	}
	if (result.migrationNotes.length > 0) {
		lines.push(`migration_notes: ${result.migrationNotes.join(" | ")}`);
	}
	return lines.join("\n");
};

// Compatibility export: only the daemon holding the kernel lock may publish
// lifecycle state. A PID-only exit hook cannot distinguish another instance.
export const maybeRemovePidFile = (_home?: string): void => {};
