import { randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { assertManagedFilePath } from "./adapter-utils";
import type { UsageSnapshot } from "../protocol/token-usage";
import type { RuntimeProfile } from "./local-runtime";
import { loadProfile, writeRuntimeLog, type RuntimePaths } from "./runtime-persistence";
import { isRuntimeProfileForBinding } from "./runtime-profile-validation";
import { scanUsageSource, usageKey, usageSources, type TokenCounts, type UsageCursor, type UsageHost } from "./token-usage-transcript";

type ProfileIdentity = Pick<RuntimeProfile, "name" | "npub">;
export type UsageTotals = TokenCounts & { totalTokens: number };
export type UsageGroup = UsageTotals & { harness: UsageHost; model: string; subagent: boolean };

const schema = `
	CREATE TABLE IF NOT EXISTS usage_policy (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		enabled_at INTEGER
	) STRICT;
	INSERT OR IGNORE INTO usage_policy (id) VALUES (1);
	CREATE TABLE IF NOT EXISTS usage_turns (
		session TEXT PRIMARY KEY,
		started_at INTEGER NOT NULL
	) STRICT;
	CREATE TABLE IF NOT EXISTS usage_cursors (
		source TEXT PRIMARY KEY,
		cursor TEXT NOT NULL
	) STRICT;
	CREATE TABLE IF NOT EXISTS usage_events (
		id TEXT PRIMARY KEY,
		at INTEGER NOT NULL,
		harness TEXT NOT NULL,
		model TEXT NOT NULL,
		workspace TEXT NOT NULL,
		subagent INTEGER NOT NULL,
		input INTEGER NOT NULL,
		cached_input INTEGER NOT NULL,
		cache_write INTEGER NOT NULL,
		output INTEGER NOT NULL,
		reasoning INTEGER NOT NULL
	) STRICT;
	CREATE INDEX IF NOT EXISTS usage_date ON usage_events (at);
`;

const usageFile = (paths: RuntimePaths, profile: ProfileIdentity): string =>
	path.join(paths.state, "usage", `${usageKey(profile.name, profile.npub)}.sqlite`);

const openUsage = async (
	paths: RuntimePaths, profile: ProfileIdentity, mode: "read" | "write" | "create"
): Promise<DatabaseSync | undefined> => {
	const file = usageFile(paths, profile);
	const directory = path.dirname(file);
	if (mode === "create") {
		assertManagedFilePath(file, paths.home);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	}
	const parent = lstatSync(directory, { throwIfNoEntry: false });
	if (!parent) return undefined;
	if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) {
		throw new Error("Crosshead usage requires a private runtime usage directory.");
	}
	let metadata = lstatSync(file, { throwIfNoEntry: false });
	if (!metadata && mode === "create") {
		try {
			closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		metadata = lstatSync(file, { throwIfNoEntry: false });
	}
	if (!metadata) return undefined;
	assertManagedFilePath(file, paths.home);
	if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
		throw new Error("Crosshead usage requires a private regular database file.");
	}

	// Load SQLite lazily so a default-off profile never opens a usage store.
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(file, { readOnly: mode === "read" });
	try {
		db.exec("PRAGMA busy_timeout = 750");
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
};

const transaction = <T>(db: DatabaseSync, begin: "BEGIN" | "BEGIN IMMEDIATE", fn: () => T): T => {
	db.exec(begin);
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
};

const enabledAt = (db: DatabaseSync): number | null =>
	db.prepare("SELECT enabled_at FROM usage_policy WHERE id = 1").get()?.enabled_at as number | null;

export const setUsageEnabled = async (paths: RuntimePaths, profile: ProfileIdentity, enabled: boolean): Promise<number | null> => {
	const db = await openUsage(paths, profile, enabled ? "create" : "write");
	if (!db) return null;
	try {
		return transaction(db, "BEGIN IMMEDIATE", () => {
			db.exec(schema);
			const previous = enabledAt(db);
			const since = enabled ? previous ?? Date.now() : null;
			if (since !== previous) db.prepare("UPDATE usage_policy SET enabled_at = ? WHERE id = 1").run(since);
			return since;
		});
	} finally {
		db.close();
	}
};

const upsertEvent = `
	INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (id) DO UPDATE SET
		model = CASE WHEN usage_events.model = 'unknown' THEN excluded.model ELSE usage_events.model END,
		input = excluded.input,
		cached_input = excluded.cached_input,
		cache_write = excluded.cache_write,
		output = excluded.output,
		reasoning = excluded.reasoning
	WHERE excluded.output >= usage_events.output
`;

export const tokenUsagePhase = (event: string): "start" | "stop" | null => {
	if (event === "stop") return "stop";
	return event === "userpromptsubmit" || event === "user_prompt_submit" ? "start" : null;
};

type CaptureInput = {
	phase: "start" | "stop";
	paths: RuntimePaths;
	profileName: string;
	host: UsageHost;
	hostHome: string;
	workspace: string;
	session: string | null;
	file: string | null;
};

export const recordTokenUsageHook = async (input: CaptureInput): Promise<void> => {
	const { paths, profileName, host, hostHome, workspace, session, file, phase } = input;
	if (!session || (phase === "stop" && !file)) return;
	const at = Date.now();
	try {
		const profile = loadProfile(paths, profileName);
		if (!isRuntimeProfileForBinding(profile, profileName)) return;
		const db = await openUsage(paths, profile, "write");
		if (!db) return;
		try {
			transaction(db, "BEGIN IMMEDIATE", () => {
				const since = enabledAt(db);
				if (since === null || at < since) return;
				const sessionKey = usageKey(host, session);
				if (phase === "start") {
					db.prepare("INSERT OR REPLACE INTO usage_turns VALUES (?, ?)").run(sessionKey, at);
					return;
				}
				const started = db.prepare("SELECT started_at FROM usage_turns WHERE session = ?").get(sessionKey)?.started_at;
				if (typeof started !== "number" || started < since || !file) return;
				const readCursor = db.prepare("SELECT cursor FROM usage_cursors WHERE source = ?");
				const saveCursor = db.prepare("INSERT OR REPLACE INTO usage_cursors VALUES (?, ?)");
				const saveEvent = db.prepare(upsertEvent);
				const workspaceKey = usageKey(workspace);
				for (const source of usageSources(host, file, session, hostHome, started)) {
					const sourceKey = usageKey(host, source.file, source.session);
					const saved = readCursor.get(sourceKey)?.cursor;
					const previous = typeof saved === "string" ? JSON.parse(saved) as UsageCursor : undefined;
					const cursor = scanUsageSource(host, source, previous, started, event => {
						const { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens } = event.counts;
						saveEvent.run(event.key, event.at, host, event.model, workspaceKey, Number(event.subagent),
							inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens);
					});
					if (cursor && (cursor.fileId !== previous?.fileId || cursor.offset !== previous.offset)) {
						saveCursor.run(sourceKey, JSON.stringify(cursor));
					}
				}
			});
		} finally {
			db.close();
		}
	} catch {
		// Usage is best-effort. A missing/corrupt ledger must not interrupt a
		// host turn or put a transcript path or error contents in runtime logs.
		try { writeRuntimeLog(paths, "usage.capture_failed", { host, profile: profileName }); } catch { /* Ignore a log write failure. */ }
	}
};

const zeroTotals = (): UsageTotals => ({
	inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
});

const periodTotals = (groups: UsageGroup[]): UsageTotals => {
	const total = zeroTotals();
	for (const group of groups) {
		total.inputTokens += group.inputTokens;
		total.cachedInputTokens += group.cachedInputTokens;
		total.cacheWriteInputTokens += group.cacheWriteInputTokens;
		total.outputTokens += group.outputTokens;
		total.reasoningOutputTokens += group.reasoningOutputTokens;
		total.totalTokens += group.totalTokens;
	}
	return total;
};

const usageGroups = (query: StatementSync, from: number, through: number): UsageGroup[] =>
	query.all(from, through).map((row) => ({
		harness: row.harness as UsageHost,
		model: row.model as string,
		subagent: row.subagent === 1,
		inputTokens: row.input as number,
		cachedInputTokens: row.cached_input as number,
		cacheWriteInputTokens: row.cache_write as number,
		outputTokens: row.output as number,
		reasoningOutputTokens: row.reasoning as number,
		totalTokens: (row.input as number) + (row.output as number),
	}));

const UTC_DAY_MS = 86_400_000;
type SyncProfile = ProfileIdentity & Pick<RuntimeProfile, "apiBase">;
type SyncPolicy = {
	deviceId: string;
	consentRevision: number;
	destination: string | null;
	revision: number;
	lastDigest: string | null;
	lastSyncedAt: number | null;
	lastError: string | null;
};

const syncPolicy = (db: DatabaseSync): SyncPolicy | undefined => {
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_sync'").get()) return undefined;
	return db.prepare(`
		SELECT device_id AS deviceId, consent_revision AS consentRevision, destination, revision,
			last_digest AS lastDigest, last_synced_at AS lastSyncedAt, last_error AS lastError
		FROM usage_sync WHERE id = 1
	`).get() as SyncPolicy | undefined;
};

export const usageSyncStatus = async (paths: RuntimePaths, profile: SyncProfile) => {
	const db = await openUsage(paths, profile, "read");
	try {
		const policy = db ? syncPolicy(db) : undefined;
		const enabled = policy?.destination === profile.apiBase;
		return {
			enabled,
			lastSyncedAt: enabled && policy?.lastSyncedAt ? new Date(policy.lastSyncedAt).toISOString() : null,
			lastError: enabled ? policy?.lastError ?? null : null,
		};
	} finally {
		db?.close();
	}
};

export const setUsageSync = async (paths: RuntimePaths, profile: SyncProfile, enabled: boolean): Promise<void> => {
	const db = await openUsage(paths, profile, enabled ? "create" : "write");
	if (!db) return;
	try {
		transaction(db, "BEGIN IMMEDIATE", () => {
			if (enabled) {
				db.exec(schema);
				db.exec(`
					CREATE TABLE IF NOT EXISTS usage_sync (
						id INTEGER PRIMARY KEY CHECK (id = 1),
						device_id TEXT NOT NULL,
						consent_revision INTEGER NOT NULL DEFAULT 1,
						destination TEXT,
						revision INTEGER NOT NULL DEFAULT 0,
						last_digest TEXT,
						last_synced_at INTEGER,
						last_error TEXT
					) STRICT
				`);
				db.prepare(`
					INSERT INTO usage_sync (id, device_id, destination) VALUES (1, ?, ?)
					ON CONFLICT (id) DO UPDATE SET destination = excluded.destination, consent_revision = consent_revision + 1,
						revision = revision + 1, last_digest = NULL, last_synced_at = NULL, last_error = NULL
					WHERE destination IS NOT excluded.destination
				`).run(randomUUID(), profile.apiBase);
			} else if (syncPolicy(db)?.destination) {
				db.exec("UPDATE usage_sync SET destination = NULL, revision = revision + 1, last_digest = NULL, last_synced_at = NULL, last_error = NULL WHERE id = 1");
			}
		});
	} finally {
		db.close();
	}
};

export const prepareUsageSync = async (paths: RuntimePaths, profile: SyncProfile, now: number, force: boolean) => {
	const db = await openUsage(paths, profile, "write");
	if (!db) return undefined;
	try {
		const previous = syncPolicy(db);
		if (previous?.destination !== profile.apiBase) return undefined;
		return transaction(db, "BEGIN IMMEDIATE", () => {
			const policy = syncPolicy(db);
			if (policy?.destination !== profile.apiBase) return undefined;
			const since = (Math.floor(now / UTC_DAY_MS) - 29) * UTC_DAY_MS;
			const rows = db.prepare(`
				SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, harness, model,
					SUM(input) AS inputTokens, SUM(cached_input) AS cachedInputTokens,
					SUM(cache_write) AS cacheWriteInputTokens, SUM(output) AS outputTokens,
					SUM(reasoning) AS reasoningOutputTokens
				FROM usage_events WHERE at >= ? AND at <= ?
				GROUP BY day, harness, model ORDER BY day, harness, model
				LIMIT 1801
			`).all(since, now) as UsageSnapshot["rows"];
			const digest = usageKey(JSON.stringify(rows));
			if (!force && (policy.lastDigest === digest || (!policy.lastDigest && rows.length === 0))) return undefined;
			const revision = policy.revision + 1;
			const snapshot: UsageSnapshot = { deviceId: policy.deviceId, consentRevision: policy.consentRevision, revision, rows };
			if (rows.length > 1800 || Buffer.byteLength(JSON.stringify(snapshot)) > 512 * 1024) {
				throw new Error("The usage report exceeds the hosted snapshot limit.");
			}
			db.prepare("UPDATE usage_sync SET revision = ? WHERE id = 1").run(revision);
			return { snapshot, digest };
		});
	} catch (error) {
		if (syncPolicy(db)?.destination === profile.apiBase) {
			db.prepare("UPDATE usage_sync SET last_error = ? WHERE id = 1 AND destination = ?")
				.run("Could not prepare local usage totals for upload.", profile.apiBase);
		}
		throw error;
	} finally {
		db.close();
	}
};

export const usageSyncIsCurrent = async (paths: RuntimePaths, profile: SyncProfile, snapshot: UsageSnapshot): Promise<boolean> => {
	const db = await openUsage(paths, profile, "read");
	try {
		const policy = db ? syncPolicy(db) : undefined;
		return policy?.destination === profile.apiBase && policy.deviceId === snapshot.deviceId && policy.revision === snapshot.revision;
	} finally {
		db?.close();
	}
};

export const confirmUsageSync = async (paths: RuntimePaths, profile: SyncProfile, snapshot: UsageSnapshot, result: { digest: string } | { error: string }): Promise<void> => {
	const db = await openUsage(paths, profile, "write");
	if (!db) return;
	try {
		if (!syncPolicy(db)) return;
		db.prepare(`
			UPDATE usage_sync SET last_digest = COALESCE(?, last_digest), last_synced_at = COALESCE(?, last_synced_at), last_error = ?
			WHERE id = 1 AND device_id = ? AND destination = ? AND revision = ?
		`).run(
			"digest" in result ? result.digest : null, "digest" in result ? Date.now() : null,
			"error" in result ? result.error : null, snapshot.deviceId, profile.apiBase, snapshot.revision,
		);
	} finally {
		db.close();
	}
};

const PERIODS = [{ name: "today", days: 1 }, { name: "7d", days: 7 }, { name: "30d", days: 30 }] as const;

export const readUsage = async (paths: RuntimePaths, profile: ProfileIdentity, now: number) => {
	const db = await openUsage(paths, profile, "read");
	const report = (since: number | null, query?: StatementSync) => ({
		profile: profile.name,
		enabled: since !== null,
		enabledAt: since === null ? null : new Date(since).toISOString(),
		periods: PERIODS.map(({ name, days }) => {
			const start = Math.floor(now / UTC_DAY_MS) * UTC_DAY_MS - (days - 1) * UTC_DAY_MS;
			const groups = query ? usageGroups(query, start, now) : [];
			return { name, from: new Date(start).toISOString(), totals: periodTotals(groups), groups };
		}),
	});
	if (!db) return report(null);
	try {
		return transaction(db, "BEGIN", () => report(enabledAt(db), db.prepare(`
			SELECT harness, model, subagent, SUM(input) AS input, SUM(cached_input) AS cached_input,
				SUM(cache_write) AS cache_write, SUM(output) AS output, SUM(reasoning) AS reasoning
			FROM usage_events WHERE at >= ? AND at <= ?
			GROUP BY harness, model, subagent ORDER BY harness, model, subagent
		`)));
	} finally {
		db.close();
	}
};
