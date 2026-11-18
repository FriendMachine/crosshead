import { existsSync, readFileSync, statSync } from "fs";
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
const HOOK_STATE_FILES = ["codex-hook.json", "claude-code-hook.json"];

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
	for (const name of HOOK_STATE_FILES) {
		try { newest = Math.max(newest, statSync(path.join(paths.state, name)).mtimeMs); } catch { /* Absent. */ }
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
 * do not prove a turn has ended. */
export const hostTurnInProgress = (paths: RuntimePaths, now: number, maxAgeMs = AUTO_UPDATE_TURN_MAX_MS): boolean => {
	for (const name of HOOK_STATE_FILES) {
		let turns: unknown;
		try { turns = readJson(path.join(paths.state, name)).activeTurns; } catch { continue; }
		if (!turns || typeof turns !== "object") continue;
		for (const turn of Object.values(turns as Record<string, { updatedAt?: unknown }>)) {
			const startedAt = typeof turn?.updatedAt === "string" ? Date.parse(turn.updatedAt) : NaN;
			if (Number.isFinite(startedAt) && now - startedAt < maxAgeMs) return true;
		}
	}
	return false;
};

export const hostsIdle = (paths: RuntimePaths, now: number, idleMs = AUTO_UPDATE_IDLE_MS): boolean =>
	now - lastHostActivityMs(paths) >= idleMs && !hostTurnInProgress(paths, now);

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
