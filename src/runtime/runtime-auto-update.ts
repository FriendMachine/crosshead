import { existsSync, openSync, closeSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { ensureRuntimeHomeLayout, loadRuntimeConfig, writeJsonFile, sanitizeLogValue } from "./runtime-persistence";
import { inspectInstalledRuntimeRelease, inspectPublishedRuntimeRelease, updateManagedRuntimeRelease } from "./local-runtime";

export type RuntimeUpdatePolicy = { mode: "auto" | "pinned"; releaseId: string | null };
const alive = (pid: number): boolean => {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
const read = (file: string): any => JSON.parse(readFileSync(file, "utf8"));

export const runtimeUpdatePolicy = (home?: string, mode?: string): RuntimeUpdatePolicy => {
	const paths = ensureRuntimeHomeLayout(home);
	const file = path.join(paths.config, "updates.json");
	if (mode !== undefined) {
		if (mode !== "auto" && mode !== "pinned") throw new Error("Update policy must be auto or pinned");
		const releaseId = inspectInstalledRuntimeRelease(paths).releaseId;
		if (mode === "pinned" && !releaseId) throw new Error("Only a published runtime installation can be pinned");
		writeJsonFile(file, { mode, releaseId: mode === "pinned" ? releaseId : null });
	}
	if (!existsSync(file)) return { mode: "auto", releaseId: null };
	const policy = read(file);
	if (!["auto", "pinned"].includes(policy.mode)) throw new Error("Invalid runtime update policy; automatic updates are disabled until repaired");
	return policy;
};

/** Hooks may never receive Stop after a cancelled turn. Keep their saved state,
 * but do not mistake it for a live process forever. This also protects legacy
 * hosts which started before launcher PID leases were installed. */
export const nativeHostProcessesRunning = (launcherPid: number, processTable = (): string => {
	if (!process.getuid) throw new Error("Process ownership unavailable");
	return execFileSync("/bin/ps", ["-u", String(process.getuid()), "-o", "pid=", "-o", "comm=", "-o", "args="], {
		encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024,
	});
}): boolean => {
	try {
		return processTable().split("\n").some(line => {
			const fields = line.trim().match(/^(\d+)\s+(.+)$/);
			if (!fields || [launcherPid, process.pid].includes(Number(fields[1]))) return false;
			// Native binaries, older Node-based CLIs, and still-draining hooks.
			return /(^|[\s/])(?:codex|claude)(?:[\s./]|$)|\/@(?:openai\/codex|anthropic-ai\/claude-code)\/|\/dist\/runtime\/(?:codex|claude-code)-hook\.js(?:\s|$)/i.test(fields[2]);
		});
	} catch { return true; } // Unknown liveness must defer, never force an update.
};

export const runtimeHasActiveWork = (home: string, hostRunning = () => true): boolean => {
	const paths = ensureRuntimeHomeLayout(home);
	const queueFile = path.join(paths.state, "queue.json");
	if (existsSync(queueFile) && (read(queueFile).items ?? []).length > 0) return true;
	for (const host of ["codex", "claude-code"]) {
		const file = path.join(paths.state, `${host}-hook.json`);
		if (!existsSync(file)) continue;
		const state = read(file);
		if (Object.keys(state.activeTurns ?? {}).length || state.turnId) return hostRunning();
	}
	return false;
};

/** A launcher holds its PID for its entire host lifetime (the shell uses exec).
 * Concurrent launchers serialize maintenance, and an existing live host prevents
 * automatic replacement even while it is idle between prompts. */
export const maintainRuntimeBeforeLaunch = async (home: string | undefined, hostPid: number, deps = {
	inspect: inspectPublishedRuntimeRelease,
	update: updateManagedRuntimeRelease,
	alive,
	nativeHostsRunning: nativeHostProcessesRunning,
	now: () => Date.now(),
}): Promise<string> => {
	if (!Number.isInteger(hostPid) || hostPid <= 1) throw new Error("A valid launcher PID is required");
	const paths = ensureRuntimeHomeLayout(home);
	const leases = path.join(paths.state, "host-processes");
	mkdirSync(leases, { recursive: true, mode: 0o700 });
	const lock = path.join(paths.state, "release-update.lock");
	let fd: number | undefined;
	const waitStarted = Date.now();
	while (fd === undefined) {
		try { fd = openSync(lock, "wx", 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid })); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// Serialize dead-owner recovery too: two waiters must not unlink a
			// replacement lock acquired between their reads of the dead owner.
			let recovery: number | undefined;
			try {
				recovery = openSync(`${lock}.recovery`, "wx", 0o600);
				const owner = read(lock);
				if (Number.isInteger(owner.pid) && !deps.alive(owner.pid)) rmSync(lock);
			} catch { /* Partial or unavailable locks require conservative waiting. */ }
			finally { if (recovery !== undefined) { closeSync(recovery); rmSync(`${lock}.recovery`, { force: true }); } }
			if (Date.now() - waitStarted > 180_000) throw new Error("Crosshead update is still running; retry launching after it finishes");
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}
	try {
		let activeHost = false;
		for (const file of readdirSync(leases)) {
			if (!/^\d+\.json$/.test(file)) continue;
			const pid = Number(file.slice(0, -5));
			if (!deps.alive(pid)) rmSync(path.join(leases, file));
			else if (pid !== hostPid) activeHost = true;
		}
		const policy = runtimeUpdatePolicy(paths.home);
		const installed = inspectInstalledRuntimeRelease(paths).releaseId;
		if (policy.mode === "pinned" || (process.env.CROSSHEAD_AUTO_UPDATE ?? process.env.ONLYBOTS_AUTO_UPDATE) === "0" || !installed || loadRuntimeConfig(paths).channel !== "stable") return "";
		const hasActiveWork = () => runtimeHasActiveWork(paths.home, () => deps.nativeHostsRunning(hostPid));
		if (activeHost || hasActiveWork()) return "";
		const stateFile = path.join(paths.state, "release-update.json");
		const state = existsSync(stateFile) ? read(stateFile) : {};
		if (deps.now() - (state.checkedAtMs ?? 0) < 12 * 60 * 60 * 1000) return "";
		try {
			const release = await deps.inspect(paths.home);
			writeJsonFile(stateFile, { checkedAtMs: deps.now(), ...release, status: "checked" });
			if (release.available === release.installed) return "";
			// Check again after network I/O for hooks started outside the launcher.
			if (hasActiveWork()) return "Crosshead update available; deferred while another turn is active.";
			writeJsonFile(stateFile, { checkedAtMs: deps.now(), ...release, status: "available" });
			return `Crosshead update ${release.available.slice(0, 12)} is available. Automatic code installation is disabled until signed releases are deployed; verify the release digest independently, then run: crosshead update --sha256 <digest>`;
		} catch (error) {
			const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
			writeJsonFile(stateFile, { checkedAtMs: deps.now(), status: "failed", error: message });
			return `Crosshead automatic update failed: ${message}. Check with crosshead doctor; retry with crosshead update.`;
		}
	} finally {
		try { writeJsonFile(path.join(leases, `${hostPid}.json`), { pid: hostPid, startedAt: new Date().toISOString() }); }
		finally { closeSync(fd); rmSync(lock, { force: true }); }
	}
};
