import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { execFileSync, spawn } from "child_process";
import { writeJsonFile, type RuntimePaths } from "./runtime-persistence";

/** Automatic updates wait until every host has been quiet this long. Open but
 * idle sessions do not block an update: their next hook runs the new release
 * through the stable bin wrappers. */
export const AUTO_UPDATE_IDLE_MS = 10 * 60 * 1000;
/** A turn that got a prompt but no Stop counts as in progress for this long.
 * Cancelled turns never receive Stop, so their markers must age out. */
export const AUTO_UPDATE_TURN_MAX_MS = 2 * 60 * 60 * 1000;
const DAEMON_RESPAWN_MS = 30 * 60 * 1000;
export const AUTO_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const AUTO_UPDATE_FAILED_RETRY_MS = 30 * 60 * 1000;
const DAEMON_POLL_MS = 5 * 60 * 1000;

/** Hook state lives in the two unscoped files and, for workspace bindings (the
 * quickstart default), in state/workspace-hooks/<binding>/<root-hash>.json. */
const hookStateFiles = (paths: RuntimePaths): string[] => {
	const files = ["codex-hook.json", "claude-code-hook.json"].map(name => path.join(paths.state, name));
	const scopedRoot = path.join(paths.state, "workspace-hooks");
	// A directory that vanished has no turns. Any other error propagates so the
	// caller defers: an unreadable binding may hold a turn in progress.
	const list = <T>(read: () => T[]): T[] => {
		try { return read(); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	};
	for (const binding of list(() => readdirSync(scopedRoot, { withFileTypes: true }))) {
		if (!binding.isDirectory()) continue;
		for (const name of list(() => readdirSync(path.join(scopedRoot, binding.name)))) {
			// <hash>-startup.json and <hash>-resume.json are receipts, not turn state.
			if (/^[a-f0-9]{64}\.json$/.test(name)) files.push(path.join(scopedRoot, binding.name, name));
		}
	}
	return files;
};

const activityFile = (paths: RuntimePaths): string => path.join(paths.state, "host-activity.json");
const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));

/** Stamped at the start of every host hook invocation. Never throws:
 * a hook must not fail because the idle marker could not be written. */
export const recordHostActivity = (paths: RuntimePaths, now = Date.now()): void => {
	try { writeJsonFile(activityFile(paths), { at: now }); } catch { /* Best effort. */ }
};

/** Milliseconds timestamp of the newest hook activity, or 0 when none is known.
 * Hook state written by releases that predate the marker still counts. */
export const lastHostActivityMs = (paths: RuntimePaths): number => {
	let newest = 0;
	try {
		const at = readJson(activityFile(paths)).at;
		if (Number.isFinite(at)) newest = at;
	} catch { /* Missing or partial marker: fall back to hook state below. */ }
	for (const file of hookStateFiles(paths)) {
		try { newest = Math.max(newest, statSync(file).mtimeMs); } catch { /* Absent. */ }
	}
	return newest;
};

/** True while a Crosshead hook process is still executing for some host. */
export const hostHooksRunning = (excludePid: number, processTable = (): string => {
	if (!process.getuid) throw new Error("Process ownership unavailable");
	return execFileSync("/bin/ps", ["-u", String(process.getuid()), "-o", "pid=", "-o", "args="], {
		encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024,
	});
}): boolean => {
	try {
		return processTable().split("\n").some(line => {
			const fields = line.trim().match(/^(\d+)\s+(.+)$/);
			if (!fields || [excludePid, process.pid].includes(Number(fields[1]))) return false;
			return /\/dist\/runtime\/(?:codex|claude-code|native-host)-hook\.js(?:\s|$)|\/dist\/runtime\/cli\.js\s+host-hook\s+(?:codex|claude-code)(?:\s|$)/.test(fields[2]!);
		});
	} catch { return true; } // Unknown liveness must defer, never force an update.
};

/** True while some Codex or Claude Code turn has a prompt but no Stop yet. Tool
 * calls such as Edit and long model output run no hook, so quiet hooks alone
 * do not prove a turn has ended. A session runs one turn at a time, so only
 * its newest marker counts: older ones belong to turns that were cancelled.
 * Markers without a turn ID come from compaction between turns. */
export const hostTurnInProgress = (paths: RuntimePaths, now: number, maxAgeMs = AUTO_UPDATE_TURN_MAX_MS): boolean => {
	const newestBySession = new Map<string, number>();
	for (const file of hookStateFiles(paths)) {
		let turns: unknown;
		if (!existsSync(file)) continue;
		turns = readJson(file)?.activeTurns; // Unreadable state defers the update.
		if (!turns || typeof turns !== "object") continue;
		for (const [key, turn] of Object.entries(turns as Record<string, { sessionId?: unknown; turnId?: unknown; updatedAt?: unknown }>)) {
			if (typeof turn?.turnId !== "string" || !turn.turnId) continue;
			const startedAt = typeof turn.updatedAt === "string" ? Date.parse(turn.updatedAt) : NaN;
			if (!Number.isFinite(startedAt)) continue;
			const session = typeof turn.sessionId === "string" && turn.sessionId ? turn.sessionId : key;
			newestBySession.set(session, Math.max(newestBySession.get(session) ?? 0, startedAt));
		}
	}
	for (const startedAt of newestBySession.values()) if (now - startedAt < maxAgeMs) return true;
	return false;
};

export const hostsIdle = (paths: RuntimePaths, now: number, idleMs = AUTO_UPDATE_IDLE_MS): boolean => {
	try { return now - lastHostActivityMs(paths) >= idleMs && !hostTurnInProgress(paths, now); }
	catch { return false; } // Unknown turn state must defer, never force an update.
};

/** The organizational worker is restarted only by its operator, never by an
 * unattended update. */
export const daemonRunsOrganizationalWorker = (paths: RuntimePaths): boolean => {
	try { return Boolean(readJson(path.join(paths.state, "daemon.json")).organizationalWorkerConfigPath); } catch { return false; }
};

/** Cheap in-process gate for the daemon: no network, no child process. The
 * spawned updater repeats every check while holding the update lock. */
export const idleUpdateCheckDue = (paths: RuntimePaths, now = Date.now()): boolean => {
	if ((process.env.CROSSHEAD_AUTO_UPDATE ?? process.env.ONLYBOTS_AUTO_UPDATE) === "0") return false;
	try {
		const policyFile = path.join(paths.config, "updates.json");
		if (existsSync(policyFile) && readJson(policyFile).mode !== "auto") return false;
		const queueFile = path.join(paths.state, "queue.json");
		if (existsSync(queueFile) && (readJson(queueFile).items ?? []).length > 0) return false;
		const stateFile = path.join(paths.state, "release-update.json");
		const state = existsSync(stateFile) ? readJson(stateFile) : {};
		const wait = state.status === "failed" ? AUTO_UPDATE_FAILED_RETRY_MS : AUTO_UPDATE_CHECK_INTERVAL_MS;
		if (now - (state.checkedAtMs ?? 0) < wait) return false;
	} catch { return false; } // Unreadable policy or state: leave it to an explicit command.
	return !daemonRunsOrganizationalWorker(paths) && hostsIdle(paths, now);
};

/** Runs for the daemon's lifetime. The updater is a detached CLI process
 * because a successful update stops and replaces this daemon. */
export const startIdleUpdateTimer = (
	paths: RuntimePaths,
	cliScriptPath: () => string | null,
	pollMs = DAEMON_POLL_MS,
	respawnMs = DAEMON_RESPAWN_MS,
	launch = (cli: string): number | undefined => {
		// The daemon may have been started from a directory that no longer exists.
		const child = spawn(process.execPath, [cli, "update", "--check-idle", "--home", paths.home], { detached: true, stdio: "ignore", cwd: paths.home });
		child.on("error", () => undefined);
		child.unref();
		return child.pid;
	}
): NodeJS.Timeout => {
	let childPid: number | undefined;
	// The updater's exit is never observed, so bound how often one is started
	// even when it dies or defers before recording a check.
	let launchedAt = -Infinity;
	const childAlive = (): boolean => {
		if (!childPid) return false;
		try { process.kill(childPid, 0); return true; } catch { return false; }
	};
	const timer = setInterval(() => {
		try {
			if (childAlive() || Date.now() - launchedAt < respawnMs || !idleUpdateCheckDue(paths)) return;
			const cli = cliScriptPath();
			if (!cli) return;
			launchedAt = Date.now();
			childPid = launch(cli);
		} catch { /* The next poll retries. */ }
	}, pollMs);
	timer.unref();
	return timer;
};
