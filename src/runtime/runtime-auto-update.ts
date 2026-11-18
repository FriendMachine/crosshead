import { existsSync, openSync, closeSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { ensureRuntimeHomeLayout, writeJsonFile, sanitizeLogValue, writeRuntimeLog } from "./runtime-persistence";
import { AUTO_UPDATE_CHECK_INTERVAL_MS, AUTO_UPDATE_FAILED_RETRY_MS, AUTO_UPDATE_IDLE_MS, hostHooksRunning, hostsIdle } from "./runtime-idle-update";
import { inspectInstalledRuntimeRelease, inspectPublishedRuntimeRelease, updateManagedRuntimeRelease } from "./local-runtime";
import { verifyGitHubReleaseAttestation } from "./release-attestation";
import semver from "semver";

export type RuntimeUpdatePolicy = { mode: "auto" | "manual"; releaseId: string | null };
const RELEASE_ID = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)-([a-f0-9]{12})$/;
const alive = (pid: number): boolean => {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
const read = (file: string): any => JSON.parse(readFileSync(file, "utf8"));

export const runtimeUpdatePolicy = (home?: string, mode?: string): RuntimeUpdatePolicy => {
	const paths = ensureRuntimeHomeLayout(home);
	const file = path.join(paths.config, "updates.json");
	if (mode !== undefined) {
		if (mode !== "auto" && mode !== "manual" && mode !== "pinned") throw new Error("Update policy must be auto or manual");
		const normalized = mode === "pinned" ? "manual" : mode;
		const releaseId = normalized === "manual" ? inspectInstalledRuntimeRelease(paths).releaseId : null;
		writeJsonFile(file, { mode: normalized, releaseId });
		if (normalized === "auto") rmSync(path.join(paths.state, "release-update.json"), { force: true });
	}
	if (!existsSync(file)) return { mode: "auto", releaseId: null };
	const policy = read(file);
	if (policy.mode === "pinned") return { mode: "manual", releaseId: typeof policy.releaseId === "string" ? policy.releaseId : null };
	if (policy.mode !== "auto" && policy.mode !== "manual") throw new Error("Invalid runtime update policy; automatic updates are disabled until repaired");
	return { mode: policy.mode, releaseId: typeof policy.releaseId === "string" ? policy.releaseId : null };
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

/** Call while holding the update lock, before changing files used by a host. */
export const assertNoLiveRuntimeHosts = (
	home: string,
	force = false,
	ownerAlive = alive,
	nativeHostsRunning = () => nativeHostProcessesRunning(process.pid)
): void => {
	if (force) return;
	const leases = path.join(ensureRuntimeHomeLayout(home).state, "host-processes");
	for (const file of existsSync(leases) ? readdirSync(leases) : []) {
		if (!/^\d+\.json$/.test(file)) continue;
		const pid = Number(file.slice(0, -5));
		if (ownerAlive(pid)) {
			throw new Error("A managed host is running; close it before updating, or use --force to update during its session");
		}
		rmSync(path.join(leases, file));
	}
	if (nativeHostsRunning()) {
		throw new Error("A Codex or Claude host is running; close it before updating, or use --force to update during its session");
	}
};

/** Serializes all release installs and update-policy writes across CLI processes. */
export const withRuntimeUpdateLock = async <T>(home: string | undefined, action: () => Promise<T> | T, ownerAlive = alive): Promise<T> => {
	const paths = ensureRuntimeHomeLayout(home);
	const lock = path.join(paths.state, "release-update.lock");
	let fd: number | undefined;
	const waitStarted = Date.now();
	while (fd === undefined) {
		let created: number | undefined;
		try { created = openSync(lock, "wx", 0o600); writeFileSync(created, JSON.stringify({ pid: process.pid })); fd = created; }
		catch (error) {
			if (created !== undefined) { closeSync(created); rmSync(lock, { force: true }); }
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// Serialize dead-owner recovery too: two waiters must not unlink a
			// replacement lock acquired between their reads of the dead owner.
			let recovery: number | undefined;
			try {
				recovery = openSync(`${lock}.recovery`, "wx", 0o600);
				const owner = read(lock);
				if (Number.isInteger(owner.pid) && !ownerAlive(owner.pid)) rmSync(lock);
			} catch { /* Partial or unavailable locks require conservative waiting. */ }
			finally { if (recovery !== undefined) { closeSync(recovery); rmSync(`${lock}.recovery`, { force: true }); } }
			if (Date.now() - waitStarted > 180_000) throw new Error("Crosshead update is still running; retry launching after it finishes");
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	}
	try { return await action(); }
	finally { closeSync(fd); rmSync(lock, { force: true }); }
};

type IdleUpdateDeps = {
	inspect: typeof inspectPublishedRuntimeRelease;
	update: typeof updateManagedRuntimeRelease;
	verify: typeof verifyGitHubReleaseAttestation;
	alive: (pid: number) => boolean;
	hooksRunning: (excludePid: number) => boolean;
	now: () => number;
};
const idleUpdateDeps = (): IdleUpdateDeps => ({
	inspect: inspectPublishedRuntimeRelease,
	update: updateManagedRuntimeRelease,
	verify: verifyGitHubReleaseAttestation,
	alive,
	hooksRunning: hostHooksRunning,
	now: () => Date.now(),
});

/** Installs a newer attested release once every host has been quiet for
 * AUTO_UPDATE_IDLE_MS. Sessions that are open but idle do not block it. Every
 * outcome that reached the network is recorded in release-update.json. Call
 * while holding the update lock. */
const installWhenIdle = async (paths: ReturnType<typeof ensureRuntimeHomeLayout>, excludePid: number, deps: IdleUpdateDeps): Promise<string> => {
	const policy = runtimeUpdatePolicy(paths.home);
	const installed = inspectInstalledRuntimeRelease(paths).releaseId;
	if (policy.mode === "manual" || (process.env.CROSSHEAD_AUTO_UPDATE ?? process.env.ONLYBOTS_AUTO_UPDATE) === "0") return "";
	if (!installed) return "Crosshead automatic update skipped: this install does not identify a managed release. Repair it with crosshead update --sha256 <trusted-digest>.";
	const queued = (): boolean => {
		const queueFile = path.join(paths.state, "queue.json");
		return existsSync(queueFile) && (read(queueFile).items ?? []).length > 0;
	};
	const busy = (): boolean => queued() || !hostsIdle(paths, deps.now()) || deps.hooksRunning(excludePid);
	if (busy()) return "";
	const stateFile = path.join(paths.state, "release-update.json");
	const state = existsSync(stateFile) ? read(stateFile) : {};
	if (deps.now() - (state.checkedAtMs ?? 0) < (state.status === "failed" ? AUTO_UPDATE_FAILED_RETRY_MS : AUTO_UPDATE_CHECK_INTERVAL_MS)) return "";
	try {
		const release = await deps.inspect(paths.home);
		if (release.available === installed) {
			writeJsonFile(stateFile, { checkedAtMs: deps.now(), ...release, status: "current" });
			return "";
		}
		const candidate = release.available.match(RELEASE_ID);
		const current = installed.match(RELEASE_ID);
		if (!candidate || !current || !semver.valid(candidate[1]) || !semver.valid(current[1]) ||
			!semver.gt(candidate[1], current[1]) || !/^[a-f0-9]{64}$/.test(release.sha256) ||
			candidate[2] !== release.sha256.slice(0, 12)) {
			throw new Error("Published release metadata is invalid or is not newer than the installed release");
		}
		// Deferrals are not throttled: the next idle window retries the install.
		const deferred = (stage: string): string => {
			writeJsonFile(stateFile, { ...state, installed, available: release.available, status: "deferred", deferredAtMs: deps.now() });
			return `Crosshead ${stage} available; deferred until hosts have been idle for ${AUTO_UPDATE_IDLE_MS / 60_000} minutes.`;
		};
		// Check again after network I/O for turns that started meanwhile.
		if (busy()) return deferred("update");
		await deps.verify(candidate[1], release.sha256);
		if (busy()) return deferred("verified update");
		const updated = await deps.update(paths.home, {
			trustedSha256: release.sha256, timeoutMs: 45_000, expectedReleaseId: release.available,
			beforeApply: () => {
				if (busy()) throw new Error("A host became active during the update; it will retry when hosts are idle");
			},
		});
		if (updated.releaseId !== release.available) throw new Error("Installed release did not match the verified release");
		writeJsonFile(stateFile, { checkedAtMs: deps.now(), installed: release.available, available: release.available, previous: installed, status: "updated" });
		return `Crosshead automatically updated to ${candidate[1]} (signed release verified).`;
	} catch (error) {
		const message = sanitizeLogValue(error instanceof Error ? error.message : String(error));
		writeJsonFile(stateFile, { checkedAtMs: deps.now(), status: "failed", error: message });
		return `Crosshead automatic update failed: ${message}. Check with crosshead doctor; retry with crosshead update --sha256 <trusted-digest>.`;
	}
};

/** A launcher holds its PID for its entire host lifetime (the shell uses exec).
 * Concurrent launchers serialize maintenance. The lease only guards manual
 * updates; an automatic update needs quiet hosts, not closed ones. */
export const maintainRuntimeBeforeLaunch = async (home: string | undefined, hostPid: number, deps: IdleUpdateDeps = idleUpdateDeps()): Promise<string> => {
	if (!Number.isInteger(hostPid) || hostPid <= 1) throw new Error("A valid launcher PID is required");
	const paths = ensureRuntimeHomeLayout(home);
	const leases = path.join(paths.state, "host-processes");
	mkdirSync(leases, { recursive: true, mode: 0o700 });
	return withRuntimeUpdateLock(paths.home, async () => {
		try {
			for (const file of readdirSync(leases)) {
				if (!/^\d+\.json$/.test(file)) continue;
				if (!deps.alive(Number(file.slice(0, -5)))) rmSync(path.join(leases, file));
			}
			return await installWhenIdle(paths, hostPid, deps);
		} finally {
			writeJsonFile(path.join(leases, `${hostPid}.json`), { pid: hostPid, startedAt: new Date().toISOString() });
		}
	}, deps.alive);
};

/** Entry point for the daemon's detached updater (`update --check-idle`). */
export const maintainRuntimeWhenIdle = async (home: string | undefined, deps: IdleUpdateDeps = idleUpdateDeps()): Promise<string> => {
	const paths = ensureRuntimeHomeLayout(home);
	const result = await withRuntimeUpdateLock(paths.home, () => installWhenIdle(paths, process.pid, deps), deps.alive);
	if (result) writeRuntimeLog(paths, "update.auto", { result });
	return result;
};
