// Runtime file persistence: home layout, path mapping, and the JSON state
// loaders/savers for the local runtime daemon. All JSON writes are atomic
// (write temp file + rename) so a crash can never leave a torn state file.

import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import path from "path";

import { nowIso } from "./adapter-utils";
import { isRuntimeProfileName, resolveOnlyBotsHome } from "./runtime-env";
import type { AgentPassport } from "../protocol/passports";
import {
	buildDefaultContinuityPolicy,
	CONTINUITY_POLICY_SCHEMA_VERSION,
	resolveContinuityPolicy,
	type ContinuityPolicy,
	type ContinuityPolicySource,
} from "./continuity-policy";
import { resolveContinuityGovernorPatchHistory, type ContinuityGovernorPatchRecord } from "./continuity-governor";
import type {
	LineageLink,
	PersistentAgentEntity,
	PersistentAgentInheritanceBoundary,
} from "../protocol/persistent-agents";
import type {
	RuntimeAdapterName,
	RuntimeAdapterRecord,
	RuntimeAdapterSnapshot,
	RuntimeConfig,
	RuntimeCoreSnapshot,
	RuntimeDaemonState,
	RuntimeHealthState,
	RuntimeProfile,
	RuntimeSecretState,
} from "./local-runtime";

export const ONLYBOTS_RUNTIME_CORE_VERSION = "0.3.0";
export const RUNTIME_ADAPTER_NAMES: RuntimeAdapterName[] = ["codex", "claude-code", "pi", "hermes", "opencode"];

export const sanitizeLogValue = (value: string): string =>
	value
		.replace(/ob_sess_[A-Za-z0-9_-]+/g, "[redacted-session]")
		.replace(/nsec1[0-9a-z]+/gi, "[redacted-nsec]")
		.replace(
			/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi,
			"$1[redacted-credential]@"
		)
		.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted-credential]")
		.replace(
			/\b((?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi,
			"$1[redacted-credential]"
		)
		.replace(
			/([?&](?:access[_-]?token|api[_-]?key|authorization|control[_-]?token|key|password|secret|session[_-]?token|token)=)[^&#\s]+/gi,
			"$1[redacted-credential]"
		)
		.replace(
			/("(?:access[_-]?token|api[_-]?key|authorization|bearerToken|client[_-]?secret|controlToken|cookie|nsec|password|private[_-]?key|secret|sessionToken)"\s*:\s*")[^"]*(")/gi,
			"$1[redacted-credential]$2"
		);

export const safeJson = (value: unknown): string => sanitizeLogValue(JSON.stringify(value));

export const parseJsonFile = <T>(filePath: string, fallback: T): T => {
	if (!existsSync(filePath)) {
		return fallback;
	}
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as T;
	} catch {
		return fallback;
	}
};

const fsyncDirectory = (directoryPath: string): void => {
	const descriptor = openSync(directoryPath, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
};

export const ensureDurableDirectory = (directoryPath: string): void => {
	const missingDirectories: string[] = [];
	let candidate = directoryPath;
	while (!existsSync(candidate)) {
		missingDirectories.push(candidate);
		const parent = path.dirname(candidate);
		if (parent === candidate) break;
		candidate = parent;
	}

	mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
	for (const createdPath of missingDirectories.reverse()) {
		chmodSync(createdPath, 0o700);
		fsyncDirectory(createdPath);
		fsyncDirectory(path.dirname(createdPath));
	}
	chmodSync(directoryPath, 0o700);
	fsyncDirectory(directoryPath);
};

export const writeJsonFile = (filePath: string, value: unknown): void => {
	const directoryPath = path.dirname(filePath);
	mkdirSync(directoryPath, { recursive: true });
	if (existsSync(filePath)) {
		const existing = lstatSync(filePath);
		if (existing.isSymbolicLink() || !existing.isFile()) {
			throw new Error(`Refusing to replace non-regular JSON file: ${filePath}`);
		}
	}
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	let temporaryDescriptor: number | null = null;
	let directoryDescriptor: number | null = null;
	try {
		temporaryDescriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(temporaryDescriptor, JSON.stringify(value, null, 2), "utf8");
		fsyncSync(temporaryDescriptor);
		closeSync(temporaryDescriptor);
		temporaryDescriptor = null;
		renameSync(temporaryPath, filePath);
		chmodSync(filePath, 0o600);
		directoryDescriptor = openSync(directoryPath, "r");
		fsyncSync(directoryDescriptor);
		closeSync(directoryDescriptor);
		directoryDescriptor = null;
	} finally {
		try {
			if (temporaryDescriptor !== null) closeSync(temporaryDescriptor);
		} catch {
			// Preserve the original write/fsync failure while still attempting all cleanup.
		}
		try {
			if (directoryDescriptor !== null) closeSync(directoryDescriptor);
		} catch {
			// The durable write path already closed this descriptor on success.
		}
		rmSync(temporaryPath, { force: true });
	}
};

export const appendPrivateFileLine = (filePath: string, line: string): void => {
	mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const descriptor = openSync(
		filePath,
		constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
		0o600
	);
	try {
		writeFileSync(descriptor, line.endsWith("\n") ? line : `${line}\n`, "utf8");
	} finally {
		closeSync(descriptor);
	}
	chmodSync(filePath, 0o600);
};

export const resolveRuntimeHome = (home?: string): string => resolveOnlyBotsHome(home);

/** Resolves the runtime layout without creating directories. Read-only commands
 * must use this rather than unexpectedly materializing a mistyped runtime home. */
export const resolveRuntimePaths = (home?: string) => {
	const resolved = resolveRuntimeHome(home);
	return {
		home: resolved,
		bin: path.join(resolved, "bin"),
		config: path.join(resolved, "config"),
		profiles: path.join(resolved, "config", "profiles"),
		secrets: path.join(resolved, "config", "secrets"),
		adapters: path.join(resolved, "adapters"),
		cache: path.join(resolved, "cache"),
		lib: path.join(resolved, "lib"),
		libRuntime: path.join(resolved, "lib", "runtime"),
		logs: path.join(resolved, "logs"),
		state: path.join(resolved, "state"),
		stateHandoffs: path.join(resolved, "state", "handoffs"),
		stateAgents: path.join(resolved, "state", "agents"),
		stateAgentEntities: path.join(resolved, "state", "agents", "entities"),
		stateAgentLineage: path.join(resolved, "state", "agents", "lineage"),
		stateAgentBoundaries: path.join(resolved, "state", "agents", "boundaries"),
		stateAgentPassports: path.join(resolved, "state", "agents", "passports"),
		versionsCore: path.join(resolved, "versions", "core"),
		versionsAdapters: path.join(resolved, "versions", "adapters"),
	};
};

export type RuntimePaths = ReturnType<typeof resolveRuntimePaths>;

export const RUNTIME_INSTALL_MARKER_VERSION = 1;
export const runtimeInstallMarkerFile = (paths: RuntimePaths): string => path.join(paths.home, ".crosshead-install.json");
export const writeRuntimeInstallMarker = (paths: RuntimePaths): void => {
	const existing = parseJsonFile<{ installId?: unknown } | null>(runtimeInstallMarkerFile(paths), null);
	writeJsonFile(runtimeInstallMarkerFile(paths), {
		version: RUNTIME_INSTALL_MARKER_VERSION,
		installId: typeof existing?.installId === "string" && /^[0-9a-f-]{36}$/i.test(existing.installId)
			? existing.installId : randomUUID(),
		canonicalHome: realpathSync(paths.home),
		updatedAt: nowIso(),
	});
};

export const ensureRuntimeHomeLayout = (home?: string): RuntimePaths => {
	const paths = resolveRuntimePaths(home);
	ensureDurableDirectory(paths.home);
	for (const dir of Object.values(paths)) {
		if (dir === paths.home) continue;
		let current = paths.home;
		for (const segment of path.relative(paths.home, dir).split(path.sep).filter(Boolean)) {
			current = path.join(current, segment);
			if (!existsSync(current)) continue;
			const stat = lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				throw new Error(`Runtime directory must not be a symlink or non-directory: ${current}`);
			}
		}
		ensureDurableDirectory(dir);
	}
	return paths;
};

export const configFile = (paths: RuntimePaths): string => path.join(paths.config, "runtime.json");

export const continuityPolicyFile = (paths: RuntimePaths): string => path.join(paths.config, "continuity-policy.json");

export const continuityGovernorFile = (paths: RuntimePaths): string => path.join(paths.state, "continuity-governor.json");

export const daemonFile = (paths: RuntimePaths): string => path.join(paths.state, "daemon.json");

export const healthFile = (paths: RuntimePaths): string => path.join(paths.state, "health.json");

export const lifecycleEventsFile = (paths: RuntimePaths): string => path.join(paths.state, "lifecycle-events.jsonl");

const portablePathToken = (value: string, fieldName: string): string => {
	if (!isRuntimeProfileName(value)) {
		throw new Error(`${fieldName} must be a portable path token`);
	}
	return value;
};

export const profileFile = (paths: RuntimePaths, name: string): string =>
	path.join(paths.profiles, `${portablePathToken(name, "profile name")}.json`);

export const secretFile = (paths: RuntimePaths, name: string): string =>
	path.join(paths.secrets, `${portablePathToken(name, "secret name")}.json`);

export const adapterFile = (paths: RuntimePaths, name: string): string =>
	path.join(paths.adapters, `${portablePathToken(name, "adapter name")}.json`);

export const persistentAgentEntityFile = (paths: RuntimePaths, agentId: string): string =>
	path.join(paths.stateAgentEntities, `${portablePathToken(agentId, "agent id")}.json`);

export const persistentAgentPassportFile = (paths: RuntimePaths, agentId: string): string =>
	path.join(paths.stateAgentPassports, `${portablePathToken(agentId, "agent id")}.json`);

export const persistentAgentLineageFile = (paths: RuntimePaths, linkId: string): string =>
	path.join(paths.stateAgentLineage, `${portablePathToken(linkId, "lineage link id")}.json`);

export const persistentAgentBoundaryFile = (paths: RuntimePaths, boundaryId: string): string =>
	path.join(paths.stateAgentBoundaries, `${portablePathToken(boundaryId, "inheritance boundary id")}.json`);

export const logFile = (paths: RuntimePaths): string => {
	const canonical = path.join(paths.logs, "crossheadd.log");
	const legacy = path.join(paths.logs, "onlybotsd.log");
	return !existsSync(canonical) && existsSync(legacy) ? legacy : canonical;
};

export const coreSnapshotFile = (paths: RuntimePaths, version: string): string =>
	path.join(paths.versionsCore, `${portablePathToken(version, "core version")}.json`);

export const adapterSnapshotDir = (paths: RuntimePaths, adapterName: RuntimeAdapterName): string =>
	path.join(paths.versionsAdapters, portablePathToken(adapterName, "adapter name"));

export const adapterSnapshotFile = (paths: RuntimePaths, adapterName: RuntimeAdapterName, version: string): string =>
	path.join(adapterSnapshotDir(paths, adapterName), `${portablePathToken(version, "adapter version")}.json`);

export const saveContinuityPolicy = (paths: RuntimePaths, policy: ContinuityPolicy): void => {
	writeJsonFile(continuityPolicyFile(paths), policy);
};

export const saveContinuityGovernorPatchHistory = (
	paths: RuntimePaths,
	patchHistory: ContinuityGovernorPatchRecord[]
): void => {
	writeJsonFile(continuityGovernorFile(paths), patchHistory);
};

export const loadContinuityPolicyState = (
	paths: RuntimePaths
): { source: ContinuityPolicySource; policy: ContinuityPolicy; validationErrors: string[] } => {
	const filePath = continuityPolicyFile(paths);
	if (!existsSync(filePath)) {
		return {
			source: "runtime_default",
			policy: buildDefaultContinuityPolicy(),
			validationErrors: [],
		};
	}

	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		const policy = resolveContinuityPolicy(parsed);
		if (policy.policyVersion !== CONTINUITY_POLICY_SCHEMA_VERSION) {
			throw new Error(
				`continuity policy version ${policy.policyVersion} is not supported; expected ${CONTINUITY_POLICY_SCHEMA_VERSION}`
			);
		}
		return {
			source: "stored_policy",
			policy,
			validationErrors: [],
		};
	} catch (error) {
		return {
			source: "fallback_default",
			policy: buildDefaultContinuityPolicy(),
			validationErrors: [error instanceof Error ? error.message : String(error)],
		};
	}
};

export const loadContinuityGovernorFileState = (
	paths: RuntimePaths
): { patchHistory: ContinuityGovernorPatchRecord[]; validationErrors: string[] } => {
	const filePath = continuityGovernorFile(paths);
	if (!existsSync(filePath)) {
		return {
			patchHistory: [],
			validationErrors: [],
		};
	}

	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		return {
			patchHistory: resolveContinuityGovernorPatchHistory(parsed),
			validationErrors: [],
		};
	} catch (error) {
		return {
			patchHistory: [],
			validationErrors: [error instanceof Error ? error.message : String(error)],
		};
	}
};

export const loadRuntimeConfig = (paths: RuntimePaths): RuntimeConfig =>
	parseJsonFile<RuntimeConfig>(configFile(paths), {
		coreVersion: ONLYBOTS_RUNTIME_CORE_VERSION,
		channel: "stable",
		defaultProfile: null,
		installedAt: nowIso(),
		updatedAt: nowIso(),
	});

export const saveRuntimeConfig = (paths: RuntimePaths, config: RuntimeConfig): void => {
	writeJsonFile(configFile(paths), config);
};

export const loadDaemonState = (paths: RuntimePaths): RuntimeDaemonState =>
	parseJsonFile<RuntimeDaemonState>(daemonFile(paths), {
		status: "stopped",
		port: null,
		controlToken: randomUUID(),
		pid: null,
		organizationalWorkerConfigPath: null,
		startedAt: null,
		lastHeartbeat: null,
		lastError: null,
	});

export const saveDaemonState = (paths: RuntimePaths, state: RuntimeDaemonState): void => {
	writeJsonFile(daemonFile(paths), state);
};

export const loadHealthState = (paths: RuntimePaths): RuntimeHealthState =>
	parseJsonFile<RuntimeHealthState>(healthFile(paths), {
		queueDepth: 0,
		pendingHotWrites: 0,
		pendingColdBatches: 0,
		retryingItems: 0,
		backpressure: false,
		lastSuccessfulSyncAt: null,
		lastError: null,
	});

export const saveHealthState = (paths: RuntimePaths, state: RuntimeHealthState): void => {
	writeJsonFile(healthFile(paths), state);
};

export const loadProfile = (paths: RuntimePaths, name: string): RuntimeProfile | null => {
	const filePath = profileFile(paths, name);
	if (!existsSync(filePath)) {
		return null;
	}
	return parseJsonFile<RuntimeProfile>(filePath, null as never);
};

export const saveProfile = (paths: RuntimePaths, profile: RuntimeProfile): void => {
	writeJsonFile(profileFile(paths, profile.name), profile);
};

export const loadSecret = (paths: RuntimePaths, name: string): RuntimeSecretState | null => {
	const filePath = secretFile(paths, name);
	if (!existsSync(filePath)) {
		return null;
	}
	return parseJsonFile<RuntimeSecretState>(filePath, null as never);
};

export const saveSecret = (paths: RuntimePaths, name: string, secret: RuntimeSecretState): void => {
	const filePath = secretFile(paths, name);
	writeJsonFile(filePath, secret);
	chmodSync(filePath, 0o600);
};

// Concurrent daemon requests each carry their own client; without an ordering check the
// last one to settle could persist an older session token over a newer one and force a
// needless re-auth on the next request.
export const isSessionWriteStale = (
	existing: { expiresAt: string; sessionToken: string } | null | undefined,
	next: { expiresAt: string; sessionToken: string } | null | undefined
): boolean => {
	if (!next) {
		return existing != null;
	}
	if (!existing || existing.sessionToken === next.sessionToken) {
		return false;
	}
	const existingExpiry = Date.parse(existing.expiresAt);
	const nextExpiry = Date.parse(next.expiresAt);
	if (Number.isNaN(existingExpiry) || Number.isNaN(nextExpiry)) {
		return false;
	}
	return nextExpiry < existingExpiry;
};

export const loadAdapterRecord = (paths: RuntimePaths, name: string): RuntimeAdapterRecord | null => {
	const filePath = adapterFile(paths, name);
	if (!existsSync(filePath)) {
		return null;
	}
	return parseJsonFile<RuntimeAdapterRecord>(filePath, null as never);
};

export const listAdapterRecords = (paths: RuntimePaths): RuntimeAdapterRecord[] => {
	if (!existsSync(paths.adapters)) {
		return [];
	}
	return readdirSync(paths.adapters)
		.filter((entry: string) => entry.endsWith(".json"))
		.map((entry: string) => parseJsonFile<RuntimeAdapterRecord>(path.join(paths.adapters, entry), null as never))
		.sort((left: RuntimeAdapterRecord, right: RuntimeAdapterRecord) => left.name.localeCompare(right.name));
};

export const saveAdapterRecord = (paths: RuntimePaths, record: RuntimeAdapterRecord): void => {
	writeJsonFile(adapterFile(paths, record.name), record);
};

export const loadPersistentAgentEntity = (paths: RuntimePaths, agentId: string): PersistentAgentEntity | null => {
	const filePath = persistentAgentEntityFile(paths, agentId);
	if (!existsSync(filePath)) {
		return null;
	}
	return parseJsonFile<PersistentAgentEntity>(filePath, null as never);
};

export const savePersistentAgentEntity = (paths: RuntimePaths, entity: PersistentAgentEntity): void => {
	writeJsonFile(persistentAgentEntityFile(paths, entity.agentRef.agentId), entity);
};

export const listPersistentAgentEntities = (paths: RuntimePaths): PersistentAgentEntity[] => {
	if (!existsSync(paths.stateAgentEntities)) {
		return [];
	}
	return readdirSync(paths.stateAgentEntities)
		.filter((entry: string) => entry.endsWith(".json"))
		.map((entry: string) => parseJsonFile<PersistentAgentEntity>(path.join(paths.stateAgentEntities, entry), null as never))
		.filter((entry): entry is PersistentAgentEntity => entry !== null);
};

export const loadPersistentAgentPassport = (paths: RuntimePaths, agentId: string): AgentPassport | null => {
	const filePath = persistentAgentPassportFile(paths, agentId);
	if (!existsSync(filePath)) {
		return null;
	}
	return parseJsonFile<AgentPassport>(filePath, null as never);
};

export const savePersistentAgentPassport = (paths: RuntimePaths, agentId: string, passport: AgentPassport): void => {
	writeJsonFile(persistentAgentPassportFile(paths, agentId), passport);
};

export const listPersistentAgentLineageLinks = (paths: RuntimePaths): LineageLink[] => {
	if (!existsSync(paths.stateAgentLineage)) {
		return [];
	}
	return readdirSync(paths.stateAgentLineage)
		.filter((entry: string) => entry.endsWith(".json"))
		.map((entry: string) => parseJsonFile<LineageLink>(path.join(paths.stateAgentLineage, entry), null as never))
		.filter((entry): entry is LineageLink => entry !== null);
};

export const savePersistentAgentLineageLink = (paths: RuntimePaths, link: LineageLink): void => {
	writeJsonFile(persistentAgentLineageFile(paths, link.linkId), link);
};

export const listPersistentAgentInheritanceBoundaries = (paths: RuntimePaths): PersistentAgentInheritanceBoundary[] => {
	if (!existsSync(paths.stateAgentBoundaries)) {
		return [];
	}
	return readdirSync(paths.stateAgentBoundaries)
		.filter((entry: string) => entry.endsWith(".json"))
		.map(
			(entry: string) =>
				parseJsonFile<PersistentAgentInheritanceBoundary>(path.join(paths.stateAgentBoundaries, entry), null as never)
		)
		.filter((entry): entry is PersistentAgentInheritanceBoundary => entry !== null);
};

export const savePersistentAgentInheritanceBoundary = (
	paths: RuntimePaths,
	boundary: PersistentAgentInheritanceBoundary
): void => {
	writeJsonFile(persistentAgentBoundaryFile(paths, boundary.boundaryId), boundary);
};

export const saveCoreSnapshot = (paths: RuntimePaths, snapshot: RuntimeCoreSnapshot): void => {
	writeJsonFile(coreSnapshotFile(paths, snapshot.version), snapshot);
};

export const saveAdapterSnapshot = (paths: RuntimePaths, snapshot: RuntimeAdapterSnapshot): void => {
	writeJsonFile(adapterSnapshotFile(paths, snapshot.name, snapshot.version), snapshot);
};

export const loadCoreSnapshot = (paths: RuntimePaths, version: string): RuntimeCoreSnapshot | null =>
	parseJsonFile<RuntimeCoreSnapshot>(coreSnapshotFile(paths, version), null as never);

export const loadAdapterSnapshot = (paths: RuntimePaths, adapterName: RuntimeAdapterName, version: string): RuntimeAdapterSnapshot | null =>
	parseJsonFile<RuntimeAdapterSnapshot>(adapterSnapshotFile(paths, adapterName, version), null as never);

export const upsertRuntimeAdapterRecord = (home: string | undefined, record: RuntimeAdapterRecord): RuntimeAdapterRecord => {
	const paths = ensureRuntimeHomeLayout(home);
	saveAdapterRecord(paths, record);
	if (RUNTIME_ADAPTER_NAMES.includes(record.name as RuntimeAdapterName)) {
		saveAdapterSnapshot(paths, {
			name: record.name as RuntimeAdapterName,
			version: record.version,
			runtimeVersion: record.runtimeVersion,
			hostHome: record.hostHome,
			profileName: record.profileName,
			managedFiles: record.managedFiles,
			capturedAt: nowIso(),
			source: "install",
		});
	}
	return record;
};

export const removeRuntimeAdapterRecord = (home: string | undefined, adapterName: string): void => {
	const paths = ensureRuntimeHomeLayout(home);
	rmSync(adapterFile(paths, adapterName), { force: true });
};

export const writeRuntimeLog = (paths: RuntimePaths, event: string, payload: Record<string, unknown>): void => {
	appendPrivateFileLine(logFile(paths), safeJson({ timestamp: nowIso(), event, payload }));
};

export const tailFileLines = (filePath: string, lines: number): string[] => {
	if (!existsSync(filePath)) {
		return [];
	}
	return readFileSync(filePath, "utf8")
		.split("\n")
		.filter((entry) => entry.length > 0)
		.slice(-Math.max(1, lines));
};

export const readJsonLines = <T>(filePath: string, lines: number): T[] =>
	tailFileLines(filePath, lines)
		.map((line) => {
			try {
				return JSON.parse(line) as T;
			} catch {
				return null;
			}
		})
		.filter((value): value is T => value !== null);
