import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { acquireDaemonKernelLock, type DaemonKernelLock } from "./daemon-kernel-lock";
import { readRuntimeProcess, runtimeProcessIsLive } from "./runtime-process";
import { type HostedControllerProcess } from "./hosted-pi-controller-manifest";
import { daemonFile, ensureDurableDirectory, resolveRuntimePaths, type RuntimePaths } from "./runtime-persistence";
import type { RuntimeDaemonState } from "./local-runtime";

/** Ownership reads must not treat corrupt authority-bearing state as absence. */
export const readDaemonOwnershipState = (paths: RuntimePaths): RuntimeDaemonState | null => {
	for (const directory of [paths.home, paths.state]) {
		let stat: ReturnType<typeof lstatSync>;
		try { stat = lstatSync(directory); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
		if (!stat.isDirectory() || realpathSync(directory) !== directory || (stat.mode & 0o777) !== 0o700 ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Daemon home must be canonical, private and owned");
	}
	const file = daemonFile(paths);
	let stat: ReturnType<typeof lstatSync>;
	try { stat = lstatSync(file); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid())) {
		throw new Error("Daemon state must be a private owned regular file");
	}
	let state: RuntimeDaemonState;
	try { state = JSON.parse(readFileSync(file, "utf8")); }
	catch { throw new Error("Daemon state is corrupt; reconcile it before starting"); }
	if (!state || !["running", "stopped"].includes(state.status) || typeof state.controlToken !== "string" || !state.controlToken ||
		(state.pid !== null && (!Number.isSafeInteger(state.pid) || state.pid < 1)) ||
		(state.port !== null && (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535)) ||
		(state.status === "running" && (state.pid === null || state.port === null)) ||
		(state.status === "stopped" && (state.pid !== null || state.port !== null)) ||
		(state.ownerId !== undefined && (typeof state.ownerId !== "string" || !/^[0-9a-f-]{36}$/.test(state.ownerId))) ||
		((state.ownerId === undefined) !== (state.ownerProcess === undefined)) ||
		(state.ownerProcess !== undefined && (!state.ownerProcess || !Number.isSafeInteger(state.ownerProcess.pid) || state.ownerProcess.pid < 1 ||
			(state.ownerProcess.pid !== state.pid && state.pid !== null) ||
			typeof state.ownerProcess.startedAtTicks !== "string" || !/^[0-9]+$/.test(state.ownerProcess.startedAtTicks) ||
			typeof state.ownerProcess.bootId !== "string" || !/^[0-9a-f-]{36}$/.test(state.ownerProcess.bootId)))) {
		throw new Error("Daemon state is invalid; reconcile it before starting");
	}
	return state;
};

export const daemonOwnerIsLive = (state: RuntimeDaemonState | null): boolean => {
	if (!state?.pid) return false;
	if (state.ownerProcess) return runtimeProcessIsLive(state.ownerProcess);
	// A live legacy daemon has no kernel lock. Never replace its state or token.
	try { process.kill(state.pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};

/** A bounded health response belongs to the recorded owner, not just a port. */
export const probeRuntimeDaemonHealth = async (state: RuntimeDaemonState, timeoutMs = 1_000): Promise<boolean> => {
	if (state.status !== "running" || !state.port || !daemonOwnerIsLive(state)) return false;
	try {
		const response = await fetch(`http://127.0.0.1:${state.port}/health`, {
			redirect: "error", signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
			headers: { "x-onlybots-local-token": state.controlToken },
		});
		if (!response.ok) return false;
		if (!state.ownerId) return true; // Read-only compatibility for legacy runtimes.
		const reader = response.body?.getReader();
		if (!reader) return false;
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 4_096) { await reader.cancel(); return false; }
			chunks.push(chunk.value);
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ownerId?: string; ownerProcess?: HostedControllerProcess };
		return body.ownerId === state.ownerId && body.ownerProcess?.pid === state.ownerProcess?.pid &&
			body.ownerProcess?.startedAtTicks === state.ownerProcess?.startedAtTicks &&
			body.ownerProcess?.bootId === state.ownerProcess?.bootId && daemonOwnerIsLive(state);
	} catch { return false; }
};

export class RuntimeDaemonOwnership {
	readonly ownerId = randomUUID();
	readonly ownerProcess: HostedControllerProcess = readRuntimeProcess(process.pid);
	private claimed = false;
	constructor(readonly paths: RuntimePaths, private readonly lock: DaemonKernelLock) {}
	claim(paths: RuntimePaths): void {
		if (this.claimed || paths.home !== this.paths.home || !this.lock.alive()) throw new Error("Daemon ownership cannot be reused");
		this.claimed = true;
	}
	alive(): boolean { return this.lock.alive(); }
	isCurrent(state: RuntimeDaemonState | null): boolean {
		return this.alive() && state?.ownerId === this.ownerId && state.ownerProcess?.pid === this.ownerProcess.pid &&
			state.ownerProcess.startedAtTicks === this.ownerProcess.startedAtTicks && state.ownerProcess.bootId === this.ownerProcess.bootId;
	}
	async close(): Promise<void> { await this.lock.close(); }
}

export const acquireRuntimeDaemonOwnership = async (home?: string): Promise<RuntimeDaemonOwnership> => {
	const paths = resolveRuntimePaths(home);
	for (const directory of [paths.home, paths.state]) {
		// Only bootstrap the two lock parents. Never repair an existing unsafe
		// home or its symlinks; the full layout belongs to the acquired owner.
		let existing = directory;
		while (!existsSync(existing)) existing = path.dirname(existing);
		if (realpathSync(existing) !== existing) throw new Error("Daemon home must be canonical");
		try { lstatSync(directory); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			ensureDurableDirectory(directory);
		}
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Daemon home must be private and owned");
	}
	const lock = await acquireDaemonKernelLock(paths.home, paths.state);
	try {
		if (daemonOwnerIsLive(readDaemonOwnershipState(paths))) throw new Error("Daemon home already has a live owner");
		return new RuntimeDaemonOwnership(paths, lock);
	} catch (error) { await lock.close(); throw error; }
};
