import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonOwnerIsLive, probeRuntimeDaemonHealth } from "../../src/runtime/daemon-ownership";
import { daemonFile, ensureRuntimeHomeLayout, loadDaemonState, saveDaemonState } from "../../src/runtime/runtime-persistence";
import { stopDetachedRuntimeDaemon } from "../../src/runtime/local-runtime";
import { reportHookFailure } from "../../src/runtime/hook-runtime";

// Like daemon-ownership.test.ts, exercise the compiled shipped daemon. Build first.
const { ensureHookRuntime } = require("../../dist/runtime/hook-runtime") as typeof import("../../src/runtime/hook-runtime");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const fixture = async (run: (home: string) => Promise<void>) => {
	const home = mkdtempSync(path.join(os.tmpdir(), "ob-hook-recovery-"));
	ensureRuntimeHomeLayout(home);
	try { await run(home); }
	finally {
		await stopDetachedRuntimeDaemon(home);
		for (let n = 0; n < 100 && daemonOwnerIsLive(loadDaemonState(ensureRuntimeHomeLayout(home))); n++) await pause(50);
		rmSync(home, { recursive: true, force: true });
	}
};

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("hook daemon recovery", () => {
	it("starts a stopped runtime, recovers SIGKILL with concurrent hooks, and retains saved memory", async () => fixture(async home => {
		await ensureHookRuntime(home);
		const paths = ensureRuntimeHomeLayout(home);
		const first = loadDaemonState(paths);
		expect(await probeRuntimeDaemonHealth(first)).toBe(true);
		const marker = path.join(paths.state, "recovery-fixture.json");
		writeFileSync(marker, "saved continuity", { mode: 0o600 });
		process.kill(first.pid!, "SIGKILL");
		for (let n = 0; n < 100 && daemonOwnerIsLive(first); n++) await pause(50);
		expect(daemonOwnerIsLive(first)).toBe(false);
		await Promise.all([ensureHookRuntime(home), ensureHookRuntime(home)]);
		const recovered = loadDaemonState(paths);
		expect(recovered.ownerId).not.toBe(first.ownerId);
		expect(await probeRuntimeDaemonHealth(recovered)).toBe(true);
		await ensureHookRuntime(home);
		expect(loadDaemonState(paths).ownerId).toBe(recovered.ownerId);
		expect(readFileSync(marker, "utf8")).toBe("saved continuity");
	}), 25_000);

	it("honors disabled autostart and refuses to relaunch a paid worker", async () => fixture(async home => {
		vi.stubEnv("ONLYBOTS_HOOK_AUTOSTART", "0");
		await expect(ensureHookRuntime(home)).rejects.toThrow("autostart is disabled");
		vi.stubEnv("ONLYBOTS_HOOK_AUTOSTART", "1");
		const paths = ensureRuntimeHomeLayout(home);
		saveDaemonState(paths, { ...loadDaemonState(paths), organizationalWorkerConfigPath: "/operator/worker.json" });
		const before = readFileSync(daemonFile(paths));
		await expect(ensureHookRuntime(home)).rejects.toThrow("explicit operator restart");
		expect(readFileSync(daemonFile(paths))).toEqual(before);
	}));

	it("does not replace a live unresponsive owner", async () => fixture(async home => {
		const paths = ensureRuntimeHomeLayout(home);
		saveDaemonState(paths, { ...loadDaemonState(paths), status: "running", pid: process.pid, port: 1 });
		const before = readFileSync(daemonFile(paths));
		try {
			await expect(ensureHookRuntime(home)).rejects.toThrow("Live owners are never killed");
			expect(readFileSync(daemonFile(paths))).toEqual(before);
		} finally { saveDaemonState(paths, { ...loadDaemonState(paths), status: "stopped", pid: null, port: null }); }
	}), 10_000);

	it("refuses corrupt authority state without overwriting it", async () => fixture(async home => {
		const paths = ensureRuntimeHomeLayout(home);
		const original = loadDaemonState(paths);
		writeFileSync(daemonFile(paths), "{broken", { mode: 0o600 });
		try {
			await expect(ensureHookRuntime(home)).rejects.toThrow("corrupt");
			expect(readFileSync(daemonFile(paths), "utf8")).toBe("{broken");
		} finally { saveDaemonState(paths, original); }
	}));

	it.each(["codex", "claude-code"] as const)("makes %s prompt failures visible without blocking the host", host => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(console, "error").mockImplementation(() => {});
		reportHookFailure(host, "UserPromptSubmit", new Error("connection refused"));
		const output = String(write.mock.calls[0]![0]);
		if (host === "codex") expect(JSON.parse(output).continue).toBe(true);
		expect(output).toContain("continuity is unavailable");
		expect(output).toContain("Do not assume saved memory was loaded");
	});
});
