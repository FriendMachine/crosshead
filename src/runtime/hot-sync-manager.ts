import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { HotSyncReplica, hotSyncTenantDirectory, writeHotSyncState } from "./hot-sync-replica";
import { HostedOnlyBotsClient, HostedOnlyBotsRequestError } from "./hosted-client";
import { hotSyncName, HOT_SYNC_PROTOCOL_VERSION, HOT_SYNC_MAX_SCOPES, type HotSyncCheckpoint } from "../protocol/hot-sync";
import { workspaceHotScope } from "./workspace-hot-memory";
import { hotSyncConflictIds, hotSyncSupersededIds } from "./hot-sync-signing";
import { normalizeTaskEvidence } from "./task-evidence";
export const hotSyncEnabled = () => process.env.CROSSHEAD_HOT_SYNC_ENABLED === "true";
type Config = {
	stateDir: string;
	origin: string;
	npub: string;
	nsec: string;
	profileName: string;
};
type Metadata = {
	deviceId: string;
	workspaces: Record<string, string>;
	linked: Record<string, string>;
	migrated: Record<string, string>;
	mixedVersion: boolean;
	recoverySnapshots?: string[];
	lastDiscoveryAt?: string;
	error?: string | null;
};
export function canonicalGitRemote(value: string): string | null {
	try {
		const raw = value.trim().replace(/^([^/@:]+@)?([^/:]+):([^/].*)$/, "ssh://$2/$3");
		const url = new URL(raw);
		if (!["ssh:", "https:", "http:", "git:"].includes(url.protocol))
			return null;
		const repo = url.pathname.replace(/\.git\/?$/, "").replace(/\/+$/, "");
		return url.hostname.toLowerCase() + (url.port ? `:${url.port}` : "") + repo;
	}
	catch {
		return null;
	}
}
/** Owned by one daemon, with serial network work and durable per-scope outboxes. */
export class HotSyncManager {
	readonly namespace: string;
	private readonly replicas = new Map<string, HotSyncReplica>();
	private readonly client: HostedOnlyBotsClient;
	private readonly metadataFile: string;
	private metadata: Metadata;
	private nextSync = 0;
	private failures = 0;
	private inflight: Promise<void> | null = null;
	private stopped = false;
	private legacyQueueError: string | null = null;
	private cursor = 0;
	private nextCapabilities = 0;
	private nextDiscovery = 0;
	private nextLegacyCheck = 0;
	private workspaceGeneration = 0;
	private active = new Set<string>();
	constructor(private readonly config: Config, client?: HostedOnlyBotsClient) {
		this.namespace = createHmac("sha256", config.nsec).update(`crosshead-profile-v1\n${config.profileName.normalize("NFC")}`).digest("hex");
		this.client = client ?? new HostedOnlyBotsClient({ apiBase: config.origin, npub: config.npub, nsec: config.nsec });
		const directory = hotSyncTenantDirectory(config.stateDir, config.origin, config.npub);
		this.metadataFile = path.join(directory, `metadata-${this.namespace}.json`);
		this.metadata = existsSync(this.metadataFile) ? JSON.parse(readFileSync(this.metadataFile, "utf8")) : { deviceId: randomUUID(), workspaces: {}, linked: {}, migrated: {}, mixedVersion: false };
		if (!this.metadata.deviceId || !this.metadata.workspaces || !this.metadata.migrated)
			throw new Error("Invalid hot-sync metadata");
		if (existsSync(directory))
			for (const name of readdirSync(directory)) {
				if (!/^[a-f0-9]{64}\.json$/.test(name))
					continue;
				const record = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
				if (record.origin === config.origin && record.npub === config.npub && record.base?.document?.namespace === this.namespace)
					this.replica(record.base.document.scope);
			}
	}
	private persist(): void { writeHotSyncState(this.metadataFile, this.metadata); }
	private digest(value: string): string { return createHmac("sha256", this.config.nsec).update(`crosshead-workspace-v1\n${value}`).digest("hex"); }
	workspace(raw: string): string {
		if (this.metadata.workspaces[raw])
			return this.metadata.workspaces[raw]!;
		let remote: string | null = null;
		const root = raw.startsWith("repo:") ? raw.slice(5) : raw;
		if (path.isAbsolute(root))
			try {
				remote = canonicalGitRemote(execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }));
			}
			catch { }
		const id = this.digest(remote ? `git:${remote}` : `local:${raw}`);
		this.metadata.workspaces[raw] = id;
		this.nextLegacyCheck = 0;
		this.workspaceGeneration++;
		this.persist();
		return id;
	}
	link(root: string, label: string): Record<string, unknown> {
		if (!label.trim() || label.length > 200)
			throw new Error("Workspace name must contain 1–200 characters");
		const raw = `repo:${path.resolve(root)}`, id = this.digest(`label:${label.normalize("NFC")}`);
		const previous = this.metadata.workspaces[raw];
		if (previous && previous !== id && [...this.replicas.values()].some(r => r.inspect().local.document.checkpoints.some(c => c.workspaceId === previous)))
			throw new Error("Workspace already contains hot memory; reset its scopes before relinking");
		this.metadata.workspaces[raw] = id;
		this.metadata.linked[raw] = label;
		this.nextLegacyCheck = 0;
		this.workspaceGeneration++;
		this.persist();
		return { workspaceId: id, workspaceRoot: path.resolve(root) };
	}
	private replica(scope: string): HotSyncReplica {
		if (!hotSyncName(scope))
			throw new Error("Invalid hot-sync scope");
		let r = this.replicas.get(scope);
		if (!r) {
			if (this.replicas.size >= HOT_SYNC_MAX_SCOPES)
				throw new Error("Hot-sync scope limit reached");
			r = new HotSyncReplica({ ...this.config, namespace: this.namespace, scope }, { read: (n, s, k) => this.client.readHotSync(n, s, k), write: (b, c) => this.client.writeHotSync(b, c), reset: b => this.client.resetHotSync(b) });
			this.replicas.set(scope, r);
		}
		return r;
	}
	activate(runtime: string, raw: string): void {
		const workspace = this.workspace(raw);
		for (const source of new Set([runtime, "codex", "claude-code", "pi", "omp", "hermes", "opencode"]))
			this.active.add(workspaceHotScope(source, workspace)!);
	}
	readWorkspace(runtime: string, raw: string): Record<string, unknown> { this.activate(runtime, raw); return this.read(workspaceHotScope(runtime, this.workspace(raw))!); }
	read(scope = "all", inspect = false): Record<string, unknown> {
		const entries = (scope === "all" ? [...this.replicas.entries()] : [[scope, this.replica(scope)] as const]).flatMap(([name, replica]) => {
			const r = replica.inspect();
			if(r.local.document.checkpoints.some(c=>workspaceHotScope(c.runtime,c.workspaceId)!==name))throw new Error("Hot-sync checkpoint belongs to another workspace scope");
			const superseded = hotSyncSupersededIds(r.local.document);
			const disputed = hotSyncConflictIds(r.local.document);
			const candidates = inspect ? r.local.document.checkpoints : r.local.document.checkpoints.filter(c => !c.conflictOf && !superseded.has(c.id) && !disputed.has(c.id));
			const portable = candidates[0]?.workspaceId;
			const aliases = Object.entries(this.metadata.workspaces).filter(([, id]) => id === portable).map(([raw]) => raw);
			// Unmapped remote projects are inspectable but cannot cross into another workspace.
			return (aliases.length ? aliases : [portable ?? "unmapped"]).map(workspaceId => ({ scope: name, content: JSON.stringify({ workspaceId, continuityCheckpoints: candidates.map(c => ({ ...c, workspaceId })) }), integrity: "verified", sync: { pending: r.dirty, pendingCount: r.pendingCount, lastSuccessfulSyncAt: r.lastSyncedAt, error: r.error, discardedByReset: r.discardedByReset, conflicts: r.local.document.checkpoints.filter(c => c.conflictOf || hotSyncConflictIds(r.local.document).has(c.id)).length } }));
		});
		return scope === "all" ? { scope, scopes: entries } : entries[0]!;
	}
	capture(_scope: string, checkpoint: Omit<HotSyncCheckpoint, "deviceId">): void {
		const workspaceId = this.workspace(checkpoint.workspaceId);
		const scope = workspaceHotScope(checkpoint.runtime, workspaceId)!;
		this.active.add(scope);
		this.replica(scope).capture({ ...checkpoint, workspaceId, deviceId: this.metadata.deviceId });
		this.persist();
		if (!this.failures)
			this.nextSync = Math.min(this.nextSync, Date.now() + 1250);
	}
	private captureLegacy(raw: string, runtime: string, checkpoint: Record<string, unknown>): void {
		const digest = createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex");
		const workspaceId = this.workspace(raw), scope = workspaceHotScope(runtime, workspaceId)!;
		this.active.add(scope);
		// Identical imports on two devices must have identical signed provenance.
		this.replica(scope).capture({ id: `legacy:${digest}`, deviceId: `legacy:${digest}`, runtime, workspaceId, occurredAt: String(checkpoint.occurredAt), goal: String(checkpoint.goal).slice(0, 2000), summary: String(checkpoint.summary).slice(0, 6000), evidence: normalizeTaskEvidence(checkpoint.evidence) ?? undefined });
		this.persist();
	}
	/** Import a durable pre-sync queue snapshot before allowing any new upload.
	 * Stable IDs make an interrupted import safe to repeat before removing its row. */
	setLegacyQueueError(error: string | null): void { this.legacyQueueError = error; }
	importQueuedLegacy(state: Record<string, unknown>, fallbackRuntime: string, fallbackWorkspace: string | null): void {
		const raw = typeof state.workspaceId === "string" ? state.workspaceId : fallbackWorkspace;
		if (!raw) throw new Error("Queued hot memory has no workspace; retain it for recovery");
		const runtime = typeof state.runtime === "string" ? state.runtime : fallbackRuntime;
		const scope = workspaceHotScope(runtime, this.workspace(raw))!;
		const replica = this.replica(scope).inspect();
		// A legacy queue has no reset epoch. Preserve ambiguous snapshots for
		// explicit recovery rather than silently discarding or resurrecting them.
		if (replica.pendingReset || replica.base.document.epoch > 0)
			throw new Error("Queued legacy hot memory needs review after a reset");
		if (!Array.isArray(state.continuityCheckpoints) || !state.continuityCheckpoints.length)
			throw new Error("Queued hot memory has no checkpoints; retain it for recovery");
		// An undiscovered remote reset can discard epoch-zero pending captures.
		// Retain the exact original locally even after the old queue row is removed.
		const digest = createHash("sha256").update(JSON.stringify(state)).digest("hex");
		const recoveryFile = `legacy-recovery-${this.namespace}-${digest}.json`;
		if (!(this.metadata.recoverySnapshots ?? []).includes(recoveryFile)) {
			if ((this.metadata.recoverySnapshots?.length ?? 0) >= 200) throw new Error("Legacy recovery snapshot limit reached");
			writeHotSyncState(path.join(path.dirname(this.metadataFile), recoveryFile), state);
			this.metadata.recoverySnapshots = [...(this.metadata.recoverySnapshots ?? []), recoveryFile];
			this.persist();
		}
		for (const value of state.continuityCheckpoints) {
			const checkpoint = value as Record<string, unknown>;
			if (!checkpoint || typeof checkpoint.goal !== "string" || typeof checkpoint.summary !== "string" || typeof checkpoint.occurredAt !== "string" || !Number.isFinite(Date.parse(checkpoint.occurredAt)))
				throw new Error("Invalid queued hot-memory checkpoint; retain it for recovery");
			this.captureLegacy(raw, runtime, checkpoint);
		}
	}
	reset(scope: string): Record<string, unknown> { this.replica(scope).resetLocally(); this.nextSync = 0; return { scope, status: "pending_reset", message: "Cleared on this machine. Other devices clear this scope when they next sync." }; }
	status(): Record<string, unknown> {
		const scopes = [...this.replicas].map(([scope, r]) => { const x = r.inspect(); return { scope, epoch: x.base.document.epoch, remoteRevision: x.revision, pending: x.pendingCount, pendingReset: x.pendingReset, oldestPendingAt: x.oldestPendingAt, lastSuccessfulSyncAt: x.lastSyncedAt, conflicts: x.local.document.checkpoints.filter(c => c.conflictOf || hotSyncConflictIds(x.local.document).has(c.id)).length, error: x.error ?? (x.local.document.checkpoints.some(c=>workspaceHotScope(c.runtime,c.workspaceId)!==scope) ? "workspace_boundary_invalid" : null), discardedByReset: x.discardedByReset }; });
		return { enabled: true, initialSyncPending: !this.metadata.lastDiscoveryAt, lastSuccessfulDiscoveryAt: this.metadata.lastDiscoveryAt ?? null, pendingCount: scopes.reduce((n, s) => n + s.pending, 0), pendingScopes: scopes.filter(s => s.pending || s.pendingReset).length, state: this.legacyQueueError || this.metadata.error || this.metadata.mixedVersion || scopes.some(s=>s.conflicts>0 || s.error || s.discardedByReset>0) ? "needs_attention" : scopes.some(s => s.pending || s.pendingReset) || !this.metadata.lastDiscoveryAt ? "saved_locally" : "synced", error: this.legacyQueueError ?? this.metadata.error, mixedVersion: this.metadata.mixedVersion, legacyRecoverySnapshots: this.metadata.recoverySnapshots ?? [], namespace: this.namespace, scopes };
	}
	tick(): void {
		if (this.stopped || this.inflight || Date.now() < this.nextSync)
			return;
		this.inflight = this.flush(false).catch(() => { }).finally(() => { this.inflight = null; });
	}
	async stop(): Promise<void> { this.stopped = true; await this.inflight; }
	async flush(forceDiscovery = true): Promise<void> {
		try {
			if (forceDiscovery || Date.now() >= this.nextCapabilities) {
			const capabilities = await this.client.hotSyncCapabilities();
			if (capabilities.version !== HOT_SYNC_PROTOCOL_VERSION || capabilities.enabled !== true)
				throw new Error("hot_sync_unavailable");
			this.nextCapabilities = Date.now() + 300000;
			}
			if (forceDiscovery || Date.now() >= this.nextDiscovery) {
			let cursor: string | null = null;
			for (let page = 0; page < 2 && !this.stopped; page++) {
				const listing = await this.client.listHotSync(this.namespace, cursor);
				if (!Array.isArray(listing.scopes) || listing.scopes.length > 64)
					throw new Error("Invalid scope page");
				for (const item of listing.scopes) {
					if (item.namespace !== this.namespace || !hotSyncName(item.scope))
						throw new Error("Invalid scope entry");
					this.replica(item.scope);
				}
				if (!listing.next_cursor)
					break;
				if (!hotSyncName(listing.next_cursor) || listing.next_cursor === cursor)
					throw new Error("Invalid scope cursor");
				cursor = listing.next_cursor;
			}
			this.nextDiscovery = Date.now() + 30000;
			this.metadata.lastDiscoveryAt = new Date().toISOString();
			}
			const scopes = [...this.replicas.entries()];
			// Two slots favor active/dirty scopes, two rotate through discovery/recovery.
			const preferred = scopes.filter(([scope, r]) => this.active.has(scope) || r.inspect().dirty);
			const selected = new Set<HotSyncReplica>();
			for (let i = 0; i < Math.min(2, preferred.length); i++)
				selected.add(preferred[(this.cursor + i) % preferred.length]![1]);
			for (let i = 0; i < scopes.length && selected.size < 4; i++)
				selected.add(scopes[(this.cursor + i) % scopes.length]![1]);
			let syncError: unknown;
			const resetAttempts = new Set<HotSyncReplica>();
			// Resets must reach the cloud before import, but ordinary captures must
			// wait until import has durably queued legacy checkpoints.
			for (const replica of selected) {
				if (this.stopped)
					break;
				if (!replica.inspect().pendingReset)
					continue;
				resetAttempts.add(replica);
				try { await replica.sync(); } catch(error) { syncError ??= error; }
			}
			this.cursor += 2;
			let migrated = false;
			if (this.legacyQueueError) syncError ??= new Error(this.legacyQueueError);
			else try {
				if (forceDiscovery || Date.now() >= this.nextLegacyCheck) {
					const generation = this.workspaceGeneration;
					await this.migrateLegacy();
					this.nextLegacyCheck = generation === this.workspaceGeneration ? Date.now() + 60000 : 0;
				}
				migrated = true;
			} catch(error) { syncError ??= error; }
			// A failed import must not let a first upload create the revision that
			// would cause the next migration attempt to skip legacy history.
			if (migrated) for (const replica of selected) {
				if (this.stopped)
					break;
				if (resetAttempts.has(replica))
					continue;
				try { await replica.sync(); } catch(error) { syncError ??= error; }
			}
			if(syncError)throw syncError;
			this.failures = 0;
			this.metadata.error = null;
			this.persist();
			this.nextSync = Date.now() + ([...this.replicas.values()].some(r => r.inspect().dirty) ? 1500 : 15000) + Math.random() * 500;
		}
		catch (error) {
			this.failures++;
			this.metadata.error = error instanceof HostedOnlyBotsRequestError ? error.code ?? `http_${error.status}` : "sync_unavailable";
			this.persist();
			if (error instanceof HostedOnlyBotsRequestError && [401, 426, 503].includes(error.status)) this.nextCapabilities = 0;
			if (error instanceof HostedOnlyBotsRequestError && error.status === 401)
				this.client.setSession(null);
			this.nextSync = Date.now() + Math.max(error instanceof HostedOnlyBotsRequestError ? error.retryAfterMs : 0, Math.min(300000, 1000 * 2 ** Math.min(this.failures, 8))) + Math.random() * 1000;
			throw error;
		}
	}
	private async migrateLegacy(): Promise<void> {
		if (this.stopped)
			return;
		const legacy = await this.client.readHotMemory("all", 5000);
		for (const entry of Array.isArray(legacy.scopes) ? legacy.scopes : []) {
			if (this.stopped)
				return;
			if (entry.integrity !== "verified" || typeof entry.content !== "string")
				continue;
			let state: Record<string, unknown>;
			try {
				state = JSON.parse(entry.content);
			}
			catch {
				continue;
			}
			const raw = state.workspaceId;
			if (typeof raw !== "string" || !this.metadata.workspaces[raw])
				continue;
			const runtime = typeof state.runtime === "string" ? state.runtime : "shared";
			const scope = workspaceHotScope(runtime, this.workspace(raw))!;
			const digest = createHash("sha256").update(entry.content).digest("hex");
			const key = String(entry.scope);
			if (this.metadata.migrated[key]) {
				if (this.metadata.migrated[key] !== digest) {
					this.metadata.mixedVersion = true;
					this.persist();
				}
				continue;
			}
			// Never let a legacy import repopulate or block an explicitly reset scope.
			if(this.replica(scope).inspect().pendingReset)continue;
			const remote = await this.client.readHotSync(this.namespace, scope);
			// Linking can change the mapping while the cloud read is pending. Its
			// absence/reset proof is valid only for the scope that was read.
			if (workspaceHotScope(runtime, this.workspace(raw)) !== scope) continue;
			if(this.replica(scope).inspect().pendingReset)continue;
			if (remote.revision === 0 && remote.epoch === 0) {
				for (const checkpoint of Array.isArray(state.continuityCheckpoints) ? state.continuityCheckpoints : []) {
					if (typeof checkpoint.summary !== "string" || typeof checkpoint.goal !== "string" || !Number.isFinite(Date.parse(checkpoint.occurredAt)))
						continue;
					this.captureLegacy(raw, runtime, checkpoint);
				}
			}
			this.metadata.migrated[key] = digest;
			this.persist();
		}
	}
}
const managers = new Map<string, HotSyncManager>();
export function getHotSyncManager(config: Config): HotSyncManager {
	config = { ...config, origin: new URL(config.origin).toString().replace(/\/+$/, "") };
	const key = JSON.stringify([config.stateDir, config.origin, config.npub, config.profileName]);
	let manager = managers.get(key);
	if (!manager) {
		manager = new HotSyncManager(config);
		managers.set(key, manager);
	}
	return manager;
}
export function tickHotSyncManagers(stateDir: string): void { for (const [key, manager] of managers)
	if (JSON.parse(key)[0] === stateDir)
		manager.tick(); }
export async function stopHotSyncManagers(stateDir: string): Promise<void> { for (const [key, manager] of managers)
	if (JSON.parse(key)[0] === stateDir) {
		await manager.stop();
		managers.delete(key);
	} }
