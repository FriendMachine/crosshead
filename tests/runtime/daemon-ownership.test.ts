import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OnlyBotsLocalRuntimeDaemon, stopDetachedRuntimeDaemon, startDetachedRuntimeDaemon, buildRuntimeStatusDirect } from "../../src/runtime/local-runtime";
import { daemonFile, ensureRuntimeHomeLayout, loadDaemonState, saveDaemonState, loadHealthState } from "../../src/runtime/runtime-persistence";
import { loadEffectiveContinuityGovernorState } from "../../src/runtime/runtime-status";
import { RuntimeLifecycleManager } from "../../src/runtime/lifecycle-engine";
import * as ownership from "../../src/runtime/daemon-ownership";
import { probeRuntimeDaemonHealth } from "../../src/runtime/daemon-ownership";
import { readHostedControllerProcess } from "../../src/runtime/hosted-pi-controller-manifest";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const authenticatedHealth = (state: { port: number | null; controlToken: string }) =>
	fetch(`http://127.0.0.1:${state.port}/health`, { headers: { "x-onlybots-local-token": state.controlToken } });
const fixture = async (run: (home: string) => Promise<void>) => {
	const home = mkdtempSync(path.join(os.tmpdir(), "fm-daemon-ownership-"));
	ensureRuntimeHomeLayout(home);
	try { await run(home); } finally { rmSync(home, { recursive: true, force: true }); }
};
const childDaemon = (home: string, extra: string[] = []) => {
	// Build before this suite: these checks exercise the shipped CLI in another
	// OS process, including signal handlers and the parent-death kernel lock.
	const child = spawn(process.execPath, [path.resolve("dist/runtime/daemon.js"), "serve", "--home", home, ...extra], {
		stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH },
	});
	let error = "";
	child.stderr!.on("data", chunk => { error = (error + chunk.toString()).slice(-1024); });
	const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	return { child, terminal, error: () => error };
};
type Job = ReturnType<typeof childDaemon>;
const waitTerminal = async (job: Job) => Promise.race([
	job.terminal,
	new Promise<never>((_, reject) => {
		const timer = setTimeout(() => reject(new Error("Child daemon did not exit")), 10_000);
		timer.unref();
		void job.terminal.finally(() => clearTimeout(timer));
	}),
]);
const cleanup = async (job: Job) => {
	if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill("SIGKILL");
	await waitTerminal(job);
};
const ready = async (home: string, job: Job) => {
	const paths = ensureRuntimeHomeLayout(home);
	for (let n = 0; n < 100; n++) {
		if (job.child.exitCode !== null || job.child.signalCode !== null) throw new Error("Daemon exited: " + job.error());
		const state = loadDaemonState(paths);
		if (state.pid === job.child.pid && state.status === "running" && state.port) {
			const response = await authenticatedHealth(state);
			if (response.ok) return state;
		}
		await pause(50);
	}
	throw new Error("Daemon readiness timed out");
};

describe("single-home daemon ownership", () => {
	it("excludes another instance and a failed contender stop cannot alter owner state", async () => fixture(async home => {
		const owner = new OnlyBotsLocalRuntimeDaemon(home);
		const contender = new OnlyBotsLocalRuntimeDaemon(home);
		try {
			const state = await owner.start();
			await expect(contender.start()).rejects.toThrow(/controlled|live owner/);
			await contender.stop();
			expect(loadDaemonState(ensureRuntimeHomeLayout(home))).toMatchObject({ ownerId: state.ownerId, pid: process.pid, port: state.port, controlToken: state.controlToken });
			expect((await fetch(`http://127.0.0.1:${state.port}/health`)).status).toBe(401);
			expect((await authenticatedHealth(state)).status).toBe(200);
		} finally { await owner.stop(); await contender.stop(); }
	}));

	it("releases ownership after a bind failure without modifying the previous state", async () => fixture(async home => {
		const paths = ensureRuntimeHomeLayout(home);
		saveDaemonState(paths, loadDaemonState(paths));
		const original = readFileSync(daemonFile(paths));
		const listener = createServer();
		await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
		const failed = new OnlyBotsLocalRuntimeDaemon(home);
		const successor = new OnlyBotsLocalRuntimeDaemon(home);
		try {
			const address = listener.address();
			if (!address || typeof address === "string") throw new Error("Missing fixture port");
			await expect(failed.start(address.port)).rejects.toThrow(/EADDRINUSE/);
			await failed.stop();
			expect(readFileSync(daemonFile(paths))).toEqual(original);
			const state = await successor.start();
			await failed.stop();
			expect(loadDaemonState(paths).ownerId).toBe(state.ownerId);
		} finally { await successor.stop(); await new Promise<void>(resolve => listener.close(() => resolve())); }
	}));

	it("refuses corrupt and live legacy state without resetting its token", async () => fixture(async home => {
		const paths = ensureRuntimeHomeLayout(home);
		const daemon = new OnlyBotsLocalRuntimeDaemon(home);
		writeFileSync(daemonFile(paths), "{invalid", { mode: 0o600 });
		await expect(daemon.start()).rejects.toThrow("corrupt");
		await expect(buildRuntimeStatusDirect(home)).rejects.toThrow("corrupt");
		expect(readFileSync(daemonFile(paths), "utf8")).toBe("{invalid");
		saveDaemonState(paths, { ...loadDaemonState(paths), status: "running", pid: process.pid, port: 1, controlToken: "legacy-token" });
		const original = readFileSync(daemonFile(paths));
		await expect(daemon.start()).rejects.toThrow("live owner");
		await daemon.stop();
		await expect(stopDetachedRuntimeDaemon(home)).rejects.toThrow("legacy");
		expect(readFileSync(daemonFile(paths))).toEqual(original);
	}));

	it("rejects a symlinked authority state", async () => fixture(async home => {
		const paths = ensureRuntimeHomeLayout(home);
		const target = path.join(home, "unrelated.json");
		writeFileSync(target, JSON.stringify(loadDaemonState(paths)), { mode: 0o600 });
		symlinkSync(target, daemonFile(paths));
		const daemon = new OnlyBotsLocalRuntimeDaemon(home);
		await expect(daemon.start()).rejects.toThrow("private owned regular");
		await daemon.stop();
	}));

	it("rejects dangling state symlinks and unsafe homes without repairing their modes", async () => fixture(async home => {
		const paths = ensureRuntimeHomeLayout(home);
		symlinkSync(path.join(home, "absent.json"), daemonFile(paths));
		await expect(new OnlyBotsLocalRuntimeDaemon(home).start()).rejects.toThrow("private owned regular");
		rmSync(daemonFile(paths));
		rmSync(paths.state, { recursive: true });
		chmodSync(home, 0o755);
		try {
			await expect(new OnlyBotsLocalRuntimeDaemon(home).start()).rejects.toThrow("private and owned");
			await expect(buildRuntimeStatusDirect(home)).rejects.toThrow("private and owned");
			expect(statSync(home).mode & 0o777).toBe(0o755);
		} finally { chmodSync(home, 0o700); }
	}));

	it("keeps ownership until composed cleanup completes and surfaces cleanup failures", async () => fixture(async home => {
		let release!: () => void;
		const barrier = new Promise<void>(resolve => { release = resolve; });
		const daemon = new OnlyBotsLocalRuntimeDaemon(home, { runtimeCleanup: () => barrier });
		const contender = new OnlyBotsLocalRuntimeDaemon(home);
		try {
			await daemon.start();
			const stopping = daemon.stop();
			await expect(contender.start()).rejects.toThrow(/controlled|live owner/);
			release();
			await stopping;
			const failing = new OnlyBotsLocalRuntimeDaemon(home, { runtimeCleanup: async () => { throw new Error("cleanup fixture failed"); } });
			await failing.start();
			await expect(failing.stop()).rejects.toThrow("cleanup fixture failed");
			expect(loadDaemonState(ensureRuntimeHomeLayout(home)).lastError).toBe("Daemon shutdown cleanup failed");
		} finally { release(); await daemon.stop(); await contender.stop(); }
	}));

	it("bounds health checks and rejects redirects or a different owner at the same port", async () => fixture(async home => {
		const sockets = new Set<import("node:net").Socket>();
		let mode = "different";
		const listener = createServer((_request, response) => {
			if (mode === "hang") return;
			if (mode === "large") { response.end("a".repeat(4097)); return; }
			if (mode === "redirect") { response.writeHead(302, { location: "/unrelated" }); response.end(); return; }
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ ownerId: "another-owner", ownerProcess: readHostedControllerProcess(process.pid) }));
		});
		listener.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
		await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
		try {
			const address = listener.address();
			if (!address || typeof address === "string") throw new Error("Missing fixture port");
			const state = { ...loadDaemonState(ensureRuntimeHomeLayout(home)), status: "running" as const, port: address.port,
				pid: process.pid, ownerId: "940063f4-11c5-4b50-94af-679c4b3e878f", ownerProcess: readHostedControllerProcess(process.pid) };
			expect(await probeRuntimeDaemonHealth(state, 100)).toBe(false);
			mode = "redirect";
			expect(await probeRuntimeDaemonHealth(state, 100)).toBe(false);
			mode = "large";
			expect(await probeRuntimeDaemonHealth(state, 100)).toBe(false);
			mode = "hang";
			const start = Date.now();
			expect(await probeRuntimeDaemonHealth(state, 100)).toBe(false);
			expect(Date.now() - start).toBeLessThan(1_000);
		} finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => listener.close(() => resolve())); }
	}));

	it("awaits the timer failure's final health write before completing shutdown", async () => fixture(async home => {
		const paths = ensureRuntimeHomeLayout(home);
		const writes: string[] = [];
		let rejectFlush!: (error: Error) => void;
		let started!: () => void;
		const began = new Promise<void>(resolve => { started = resolve; });
		const failure = new Promise<never>((_, reject) => { rejectFlush = reject; });
		const manager = new RuntimeLifecycleManager({ paths: { state: paths.state },
			loadDefaultProfileName: () => null, loadProfile: () => null, loadSecret: () => null, saveSecret: () => {},
			loadHealth: () => loadHealthState(paths), saveHealth: state => { writes.push(state.lastError ?? "none"); },
			loadContinuityGovernorState: () => loadEffectiveContinuityGovernorState(paths).governorState,
			writeLog: () => {}, workerIntervalMs: 5 });
		const flush = vi.spyOn(manager, "flushDueItems").mockImplementation(async () => { started(); return failure; });
		try {
			manager.start();
			await began;
			let stopped = false;
			const stopping = manager.stop().then(() => { stopped = true; });
			await pause(20);
			expect(stopped).toBe(false);
			rejectFlush(new Error("timer fixture failure"));
			await stopping;
			expect(writes).toEqual(["timer fixture failure"]);
			await pause(20);
			expect(writes).toHaveLength(1);
		} finally { rejectFlush(new Error("fixture cleanup")); await manager.stop(); flush.mockRestore(); }
	}));

	it("attempts composed startup cleanup under ownership even when lifecycle cleanup rejects", async () => fixture(async home => {
		const listener = createServer();
		await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
		let release!: () => void;
		let began!: () => void;
		const barrier = new Promise<void>(resolve => { release = resolve; });
		const cleanupBegan = new Promise<void>(resolve => { began = resolve; });
		const stop = vi.spyOn(RuntimeLifecycleManager.prototype, "stop").mockRejectedValueOnce(new Error("lifecycle cleanup fixture failed"));
		const daemon = new OnlyBotsLocalRuntimeDaemon(home, { runtimeCleanup: async () => { began(); await barrier; } });
		const contender = new OnlyBotsLocalRuntimeDaemon(home);
		try {
			const address = listener.address();
			if (!address || typeof address === "string") throw new Error("Missing fixture port");
			const failed = daemon.start(address.port);
			const rejected = expect(failed).rejects.toThrow("startup and cleanup failed");
			await cleanupBegan;
			await expect(contender.start()).rejects.toThrow(/controlled|live owner/);
			release();
			await rejected;
			await contender.start();
		} finally { release(); stop.mockRestore(); await daemon.stop(); await contender.stop(); await new Promise<void>(resolve => listener.close(() => resolve())); }
	}));

	it("surfaces a failed timer health write and allows the same lifecycle to restart", async () => fixture(async home => {
		const paths = ensureRuntimeHomeLayout(home);
		let failedHealthWrite = false;
		const manager = new RuntimeLifecycleManager({ paths: { state: paths.state },
			loadDefaultProfileName: () => null, loadProfile: () => null, loadSecret: () => null, saveSecret: () => {},
			loadHealth: () => loadHealthState(paths), saveHealth: () => { failedHealthWrite = true; throw new Error("health write fixture failed"); },
			loadContinuityGovernorState: () => loadEffectiveContinuityGovernorState(paths).governorState,
			writeLog: () => {}, workerIntervalMs: 5 });
		const flush = vi.spyOn(manager, "flushDueItems").mockRejectedValueOnce(new Error("timer fixture failed")).mockResolvedValue(undefined);
		try {
			manager.start();
			for (let n = 0; n < 100 && !failedHealthWrite; n++) await pause(5);
			expect(failedHealthWrite).toBe(true);
			await expect(manager.stop()).rejects.toThrow("health write fixture failed");
			manager.start();
			for (let n = 0; n < 100 && flush.mock.calls.length < 2; n++) await pause(5);
			expect(flush.mock.calls.length).toBeGreaterThanOrEqual(2);
			await manager.stop();
		} finally { await manager.stop().catch(() => undefined); flush.mockRestore(); }
	}));

	it("serializes stop with an in-flight start and allows a clean successor", async () => fixture(async home => {
		const daemon = new OnlyBotsLocalRuntimeDaemon(home);
		const starting = daemon.start();
		const stopping = daemon.stop();
		await starting;
		await stopping;
		expect(loadDaemonState(ensureRuntimeHomeLayout(home)).status).toBe("stopped");
		const successor = new OnlyBotsLocalRuntimeDaemon(home);
		try { await successor.start(); } finally { await successor.stop(); }
	}));

	it("fails HTTP closed and never rewrites a successor generation on stale stop", async () => fixture(async home => {
		const daemon = new OnlyBotsLocalRuntimeDaemon(home);
		const paths = ensureRuntimeHomeLayout(home);
		try {
			const state = await daemon.start();
			const successor = { ...state, ownerId: "cd6f8ab5-9aef-4dab-8de8-2590e7615b35" };
			saveDaemonState(paths, successor);
			expect((await fetch(`http://127.0.0.1:${state.port}/health`)).status).toBe(503);
			await pause(1_100);
			await daemon.stop();
			expect(loadDaemonState(paths)).toEqual(successor);
		} finally { await daemon.stop(); }
	}));

	it("rejects competing real processes and proves terminal stop before restart", async () => fixture(async home => {
		const first = childDaemon(home);
		let second: Job | undefined;
		let restarted: Job | undefined;
		try {
			const state = await ready(home, first);
			second = childDaemon(home);
			expect(await waitTerminal(second)).toEqual({ code: 1, signal: null });
			expect(second.error()).toMatch(/controlled|live owner/);
			await expect(startDetachedRuntimeDaemon({ home })).rejects.toThrow("exited before");
			expect(loadDaemonState(ensureRuntimeHomeLayout(home))).toMatchObject({ pid: first.child.pid, ownerId: state.ownerId, controlToken: state.controlToken });
			await stopDetachedRuntimeDaemon(home);
			expect(await waitTerminal(first)).toEqual({ code: 0, signal: null });
			expect(loadDaemonState(ensureRuntimeHomeLayout(home)).status).toBe("stopped");
			restarted = childDaemon(home);
			const next = await ready(home, restarted);
			expect(next.ownerId).not.toBe(state.ownerId);
			expect(next.controlToken).not.toBe(state.controlToken);
			await stopDetachedRuntimeDaemon(home);
			expect(await waitTerminal(restarted)).toEqual({ code: 0, signal: null });
		} finally { await cleanup(first); if (second) await cleanup(second); if (restarted) await cleanup(restarted); }
	}));

	it("releases the kernel lock after SIGKILL and recovers the same durable home", async () => fixture(async home => {
		const first = childDaemon(home);
		let successor: Job | undefined;
		const durable = path.join(home, "state", "queue.json");
		const bytes = Buffer.from('{"version":1,"items":[]}\n');
		writeFileSync(durable, bytes, { mode: 0o600 });
		try {
			const state = await ready(home, first);
			first.child.kill("SIGKILL");
			expect(await waitTerminal(first)).toEqual({ code: null, signal: "SIGKILL" });
			await stopDetachedRuntimeDaemon(home); // Does not fabricate a stopped receipt.
			expect((await buildRuntimeStatusDirect(home)).daemon).toMatchObject({ running: false, reachable: false });
			expect(loadDaemonState(ensureRuntimeHomeLayout(home)).ownerId).toBe(state.ownerId);
			successor = childDaemon(home);
			const next = await ready(home, successor);
			expect(next.ownerId).not.toBe(state.ownerId);
			expect(readFileSync(durable)).toEqual(bytes);
			await stopDetachedRuntimeDaemon(home);
			expect(await waitTerminal(successor)).toEqual({ code: 0, signal: null });
		} finally { await cleanup(first); if (successor) await cleanup(successor); }
	}));

	it("does not signal a PID whose stored process start witness differs", async () => fixture(async home => {
		const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: {} });
		const terminal = new Promise<void>(resolve => child.once("exit", () => resolve()));
		try {
			const paths = ensureRuntimeHomeLayout(home);
			const witness = readHostedControllerProcess(child.pid!);
			saveDaemonState(paths, { ...loadDaemonState(paths), status: "running", pid: child.pid!, port: 1,
				ownerId: "940063f4-11c5-4b50-94af-679c4b3e878f", ownerProcess: { ...witness, startedAtTicks: "0" } });
			const original = readFileSync(daemonFile(paths));
			await stopDetachedRuntimeDaemon(home);
			expect(readFileSync(daemonFile(paths))).toEqual(original);
			expect(child.exitCode).toBeNull();
			expect(readHostedControllerProcess(child.pid!)).toEqual(witness);
		} finally { child.kill("SIGKILL"); await terminal; }
	}));

	it("leaves a changed owner generation untouched even while the captured process is alive", async () => fixture(async home => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: {} });
		const terminal = new Promise<void>(resolve => child.once("exit", () => resolve()));
		const paths = ensureRuntimeHomeLayout(home);
		const original = { ...loadDaemonState(paths), status: "running" as const, port: 1, pid: child.pid!,
			ownerId: "940063f4-11c5-4b50-94af-679c4b3e878f", ownerProcess: readHostedControllerProcess(child.pid!) };
		const successor = { ...original, pid: process.pid, ownerId: "cd6f8ab5-9aef-4dab-8de8-2590e7615b35",
			ownerProcess: readHostedControllerProcess(process.pid) };
		saveDaemonState(paths, original);
		const read = ownership.readDaemonOwnershipState;
		const switched = vi.spyOn(ownership, "readDaemonOwnershipState").mockImplementationOnce(p => {
			const captured = read(p);
			saveDaemonState(p, successor);
			return captured;
		});
		try {
			await stopDetachedRuntimeDaemon(home);
			expect(ownership.readDaemonOwnershipState(paths)).toEqual(successor);
			expect(readHostedControllerProcess(child.pid!)).toEqual(original.ownerProcess);
			expect(child.exitCode).toBeNull();
		} finally { switched.mockRestore(); child.kill("SIGKILL"); await terminal; }
	}));

	it("rejects organizational-worker composition before claiming ownership", async () => fixture(async home => {
		const config = path.join(home, "bad-config.json");
		writeFileSync(config, "{}", { mode: 0o600 });
		const failed = childDaemon(home, ["--organizational-worker-config", config]);
		let successor: Job | undefined;
		try {
			expect(await waitTerminal(failed)).toEqual({ code: 1, signal: null });
			expect(failed.error()).toContain("--organizational-worker-config is not supported by this Crosshead runtime build");
			expect(loadDaemonState(ensureRuntimeHomeLayout(home)).status).toBe("stopped");
			successor = childDaemon(home);
			await ready(home, successor);
			await stopDetachedRuntimeDaemon(home);
			expect(await waitTerminal(successor)).toEqual({ code: 0, signal: null });
		} finally { await cleanup(failed); if (successor) await cleanup(successor); }
	}));
});
