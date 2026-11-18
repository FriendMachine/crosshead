import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { assertNoLiveRuntimeHosts, maintainRuntimeBeforeLaunch, maintainRuntimeWhenIdle, runtimeUpdatePolicy, nativeHostProcessesRunning } from "../../src/runtime/runtime-auto-update";
import { AUTO_UPDATE_IDLE_MS, AUTO_UPDATE_TURN_MAX_MS, hostHooksRunning, hostTurnInProgress, idleUpdateCheckDue, lastHostActivityMs, recordHostActivity, startIdleUpdateTimer } from "../../src/runtime/runtime-idle-update";
import { rollbackFromCli, updateFromCli } from "../../src/runtime/cli/core";
import { fetchRuntimeReleaseArtifact, inspectInstalledRuntimeRelease, isAllowedRuntimeReleaseUrl, parseWrapperScriptTarget, resolveReleaseUpdateBaseUrl, updateManagedRuntimeRelease, runRuntimeInstallCommand } from "../../src/runtime/local-runtime";
import { shellQuote } from "../../src/runtime/adapter-utils";
import { ensureRuntimeHomeLayout, writeJsonFile } from "../../src/runtime/runtime-persistence";

const setup = () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "ob-auto-update-"));
	const p = ensureRuntimeHomeLayout(home);
	const releaseRuntime = path.join(p.libRuntime, "old", "dist", "runtime");
	mkdirSync(releaseRuntime, { recursive: true });
	writeFileSync(path.join(releaseRuntime, "cli.js"), "");
	writeFileSync(path.join(releaseRuntime, "daemon.js"), "");
	writeFileSync(path.join(p.bin, "onlybotsctl"), `#!/bin/sh\nnode '${path.join(releaseRuntime, "cli.js")}' "$@"\n`);
	writeFileSync(path.join(p.bin, "onlybotsd"), `#!/bin/sh\nnode '${path.join(releaseRuntime, "daemon.js")}' "$@"\n`);
	const deps = {
		inspect: vi.fn(async () => ({ installed: "old", available: "new" })),
		update: vi.fn(async () => ({ releaseId: "new" }) as any),
		verify: vi.fn(async () => {}),
		alive: (pid: number) => pid === 2001,
		hooksRunning: vi.fn(() => true),
		now: () => Date.now(),
	};
	return { home, p, deps };
};

const oldRelease = `0.5.0-alpha.13-${"a".repeat(12)}`;
const newRelease = `0.5.0-alpha.14-${"b".repeat(12)}`;
const newDigest = "b".repeat(64);
const autoSetup = () => {
	const fixture = setup();
	const runtime = path.join(fixture.p.libRuntime, oldRelease, "dist", "runtime");
	mkdirSync(runtime, { recursive: true });
	writeFileSync(path.join(runtime, "cli.js"), "");
	writeFileSync(path.join(runtime, "daemon.js"), "");
	writeFileSync(path.join(fixture.p.bin, "onlybotsctl"), `#!/bin/sh\nnode '${path.join(runtime, "cli.js")}' "$@"\n`);
	writeFileSync(path.join(fixture.p.bin, "onlybotsd"), `#!/bin/sh\nnode '${path.join(runtime, "daemon.js")}' "$@"\n`);
	fixture.deps.inspect.mockResolvedValue({ installed: oldRelease, available: newRelease, sha256: newDigest });
	fixture.deps.update.mockResolvedValue({ releaseId: newRelease } as any);
	fixture.deps.hooksRunning.mockReturnValue(false);
	return fixture;
};

describe("published runtime automatic updates", () => {
	it("detects the single-quoted wrapper emitted by the real installer", () => {
		const { home, p } = setup();
		expect(inspectInstalledRuntimeRelease(p).releaseId).toBe("old");
		expect(parseWrapperScriptTarget(path.join(p.bin, "onlybotsctl"))).toBe(`${home}/lib/runtime/old/dist/runtime/cli.js`);
		const target = `${home}/lib/runtime/release'quoted/dist/runtime/cli.js`;
		writeFileSync(path.join(p.bin, "onlybotsctl"), `#!/bin/sh\nnode ${shellQuote(target)} "$@"\n`);
		expect(parseWrapperScriptTarget(path.join(p.bin, "onlybotsctl"))).toBe(target);
		writeFileSync(path.join(p.bin, "onlybotsctl"), `#!/bin/sh\n${shellQuote(process.execPath)} ${shellQuote(target)} "$@"\n`);
		expect(parseWrapperScriptTarget(path.join(p.bin, "onlybotsctl"))).toBe(target);
	});
	it("rejects hosted metadata that changes the attested release ID before downloading", async () => {
		const { home } = setup();
		const sha256 = "b".repeat(64);
		const script = `RELEASE_ID="0.5.0-alpha.15-${sha256.slice(0, 12)}"\nRELEASE_URL="https://crosshead.sh/install/releases/crosshead-runtime.tgz"\nRELEASE_SHA256="${sha256}"\n`;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(script));
		try {
			await expect(updateManagedRuntimeRelease(home, { trustedSha256: sha256, expectedReleaseId: newRelease }))
				.rejects.toThrow("changed after attestation");
			expect(fetchMock).toHaveBeenCalledOnce();
		} finally { fetchMock.mockRestore(); }
	});
	it("rejects an installer release ID with a digest suffix that does not match metadata", async () => {
		const { home } = setup();
		const sha256 = "b".repeat(64);
		const script = `RELEASE_ID="0.5.0-alpha.14-${"a".repeat(12)}"\nRELEASE_URL="https://crosshead.sh/install/releases/crosshead-runtime.tgz"\nRELEASE_SHA256="${sha256}"\n`;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(script));
		try {
			await expect(updateManagedRuntimeRelease(home, { trustedSha256: sha256 })).rejects.toThrow("release ID does not match");
			expect(fetchMock).toHaveBeenCalledOnce();
		} finally { fetchMock.mockRestore(); }
	});
	it("rejects wrapper command substitution and custom executable update origins", async () => {
		const { home, p } = setup();
		writeFileSync(path.join(p.bin, "onlybotsctl"), '#!/bin/sh\nnode "$(touch /tmp/owned)" "$@"\n');
		expect(parseWrapperScriptTarget(path.join(p.bin, "onlybotsctl"))).toBeNull();
		await expect(updateManagedRuntimeRelease(home, { baseUrl: "https://updates.example.test" }))
			.rejects.toThrow("Custom runtime update origins are disabled");
		await expect(updateManagedRuntimeRelease(home)).rejects.toThrow("requires --sha256");
	});
	it("ignores installed-release wrappers that point outside the runtime library", () => {
		const { p } = setup();
		const fixture = mkdtempSync(path.join(os.tmpdir(), "crosshead-forged-release-"));
		try {
			const external = path.join(fixture, "lib", "runtime", "forged", "dist", "runtime");
			mkdirSync(external, { recursive: true });
			writeFileSync(path.join(external, "cli.js"), "");
			writeFileSync(path.join(external, "daemon.js"), "");
			writeFileSync(path.join(p.bin, "onlybotsctl"), `#!/bin/sh\nnode '${path.join(external, "cli.js")}' "$@"\n`);
			writeFileSync(path.join(p.bin, "onlybotsd"), `#!/bin/sh\nnode '${path.join(external, "daemon.js")}' "$@"\n`);
			expect(inspectInstalledRuntimeRelease(p)).toEqual({ releaseId: null, cliScriptPath: null, daemonScriptPath: null });
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
	it("does not let hosted API environment overrides select the executable update origin", () => {
		const { p } = setup();
		const previousCrosshead = process.env.CROSSHEAD_BASE_URL;
		const previousOnlyBots = process.env.ONLYBOTS_BASE_URL;
		try {
			process.env.CROSSHEAD_BASE_URL = "http://127.0.0.1:9999";
			process.env.ONLYBOTS_BASE_URL = "https://attacker.example.test";
			expect(resolveReleaseUpdateBaseUrl(p)).toBe("https://crosshead.sh");
		} finally {
			if (previousCrosshead === undefined) delete process.env.CROSSHEAD_BASE_URL;
			else process.env.CROSSHEAD_BASE_URL = previousCrosshead;
			if (previousOnlyBots === undefined) delete process.env.ONLYBOTS_BASE_URL;
			else process.env.ONLYBOTS_BASE_URL = previousOnlyBots;
		}
	});
	it("accepts only the release-specific GitHub artifact as the independent download origin", () => {
		const releaseId = "0.4.3-7f611dfd4501";
		expect(isAllowedRuntimeReleaseUrl(
			"https://crosshead.sh",
			releaseId,
			new URL("https://github.com/FriendMachine/crosshead/releases/download/v0.4.3/crosshead-runtime-install-0.4.3.tgz")
		)).toBe(true);
		for (const url of [
			"https://github.com/attacker/crosshead/releases/download/v0.4.3/crosshead-runtime-install-0.4.3.tgz",
			"https://github.com/FriendMachine/crosshead/releases/download/v0.4.2/crosshead-runtime-install-0.4.2.tgz",
			"https://github.com/FriendMachine/crosshead/releases/download/v0.4.3/other.tgz",
			"https://user:password@github.com/FriendMachine/crosshead/releases/download/v0.4.3/crosshead-runtime-install-0.4.3.tgz",
		]) expect(isAllowedRuntimeReleaseUrl("https://crosshead.sh", releaseId, new URL(url))).toBe(false);
	});
	it("follows only bounded HTTPS redirects to GitHub's release asset origin", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, {
				status: 302,
				headers: { location: "https://release-assets.githubusercontent.com/github-production-release-asset/release.tgz?sig=example" },
			}))
			.mockResolvedValueOnce(new Response("release-bytes", {
				status: 200,
				headers: { "content-length": "13" },
			}));
		await expect(fetchRuntimeReleaseArtifact(
			"https://github.com/FriendMachine/crosshead/releases/download/v0.4.4/crosshead-runtime-install-0.4.4.tgz"
		)).resolves.toEqual(Buffer.from("release-bytes"));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
		fetchMock.mockRestore();
	});
	it.each([
		"http://release-assets.githubusercontent.com/release.tgz",
		"https://release-assets.githubusercontent.com:444/release.tgz",
		"https://attacker.example/release.tgz",
		"https://user:password@release-assets.githubusercontent.com/release.tgz",
	])("rejects an unsafe GitHub release redirect to %s", async location => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, {
			status: 302,
			headers: { location },
		}));
		await expect(fetchRuntimeReleaseArtifact(
			"https://github.com/FriendMachine/crosshead/releases/download/v0.4.4/crosshead-runtime-install-0.4.4.tgz"
		)).rejects.toThrow("redirected outside the trusted GitHub asset origin");
		fetchMock.mockRestore();
	});
	it("does not follow redirects from the hosted release mirror", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, {
			status: 302,
			headers: { location: "https://release-assets.githubusercontent.com/release.tgz" },
		}));
		await expect(fetchRuntimeReleaseArtifact(
			"https://crosshead.sh/install/releases/crosshead-runtime.tgz"
		)).rejects.toThrow("disallowed redirect");
		fetchMock.mockRestore();
	});
	it("rejects a GitHub release redirect chain longer than three hops", async () => {
		const redirect = () => new Response(null, {
			status: 302,
			headers: { location: "https://release-assets.githubusercontent.com/next" },
		});
		const fetchMock = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(redirect())
			.mockResolvedValueOnce(redirect())
			.mockResolvedValueOnce(redirect())
			.mockResolvedValueOnce(redirect());
		await expect(fetchRuntimeReleaseArtifact(
			"https://github.com/FriendMachine/crosshead/releases/download/v0.4.4/crosshead-runtime-install-0.4.4.tgz"
		)).rejects.toThrow("disallowed redirect");
		expect(fetchMock).toHaveBeenCalledTimes(4);
		fetchMock.mockRestore();
	});
	it("installs a signed newer release on an idle launch and throttles subsequent checks", async () => {
		const { home, deps } = autoSetup();
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("automatically updated");
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).toHaveBeenCalledTimes(1);
		expect(deps.verify).toHaveBeenCalledExactlyOnceWith("0.5.0-alpha.14", newDigest);
		expect(deps.update).toHaveBeenCalledExactlyOnceWith(home, expect.objectContaining({
			trustedSha256: newDigest, timeoutMs: 45_000, expectedReleaseId: newRelease, beforeApply: expect.any(Function),
		}));
		deps.hooksRunning.mockReturnValue(true);
		expect(deps.update.mock.calls[0]![1].beforeApply).toThrow("A host became active");
	});
	it("blocks release, catalog and rollback changes while a managed host is live", async () => {
		const { home, p } = autoSetup();
		const leases = path.join(p.state, "host-processes");
		mkdirSync(leases, { recursive: true });
		writeJsonFile(path.join(leases, `${process.pid}.json`), { pid: process.pid });
		await expect(updateFromCli(["--home", home, "--sha256", newDigest])).rejects.toThrow("managed host is running");
		await expect(updateFromCli(["--home", home, "--channel", "stable"])).rejects.toThrow("managed host is running");
		await expect(rollbackFromCli(["--home", home, "--to", "0.3.0"])).rejects.toThrow("managed host is running");
		await expect(updateFromCli(["--home", home, "--force"])).rejects.toThrow("requires --sha256");
	});
	it("checks direct native hosts even without a launcher lease", () => {
		const { home } = setup();
		expect(() => assertNoLiveRuntimeHosts(home, false, () => false, () => true)).toThrow("Codex or Claude host is running");
		expect(() => assertNoLiveRuntimeHosts(home, true, () => false, () => true)).not.toThrow();
	});
	it("offers auto and manual CLI settings and migrates the legacy pinned mode", async () => {
		const { home, p, deps } = autoSetup();
		expect(JSON.parse(await updateFromCli(["--manual", "--home", home]))).toEqual({ mode: "manual", releaseId: oldRelease });
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).not.toHaveBeenCalled();
		writeJsonFile(path.join(p.config, "updates.json"), { mode: "pinned", releaseId: oldRelease });
		expect(runtimeUpdatePolicy(home)).toEqual({ mode: "manual", releaseId: oldRelease });
		expect(JSON.parse(await updateFromCli(["--auto", "--home", home]))).toEqual({ mode: "auto", releaseId: null });
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.update).toHaveBeenCalledOnce();
	});
	it("rechecking auto explicitly clears a previous update check cooldown", async () => {
		const { home, p, deps } = autoSetup();
		writeJsonFile(path.join(p.state, "release-update.json"), { checkedAtMs: Date.now(), status: "current" });
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).not.toHaveBeenCalled();
		runtimeUpdatePolicy(home, "auto");
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.update).toHaveBeenCalledOnce();
	});
	it.each(["codex", "claude-code"])("defers while %s hook state changed in the last ten minutes, even from a release without the activity marker", async host => {
		const { home, p, deps } = autoSetup();
		writeJsonFile(path.join(p.state, `${host}-hook.json`), { activeTurns: { active: { turnId: "t" } } });
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).not.toHaveBeenCalled();
		deps.now = () => Date.now() + AUTO_UPDATE_IDLE_MS + 1000;
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("automatically updated");
	});
	it("updates while another host is open but idle, keeping its lease and removing dead ones", async () => {
		const { home, p, deps } = autoSetup();
		const leases = path.join(p.state, "host-processes"); mkdirSync(leases);
		writeJsonFile(path.join(leases, "2001.json"), { pid: 2001 });
		writeJsonFile(path.join(leases, "2002.json"), { pid: 2002 });
		recordHostActivity(p, Date.now() - AUTO_UPDATE_IDLE_MS - 1000);
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("automatically updated");
		expect(existsSync(path.join(leases, "2001.json"))).toBe(true);
		expect(existsSync(path.join(leases, "2002.json"))).toBe(false);
	});
	it("waits until ten minutes after the last hook activity", async () => {
		const { home, p, deps } = autoSetup();
		const base = Date.now();
		recordHostActivity(p, base);
		deps.now = () => base + AUTO_UPDATE_IDLE_MS - 1;
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toBe("");
		expect(deps.inspect).not.toHaveBeenCalled();
		expect(existsSync(path.join(p.state, "release-update.json"))).toBe(false);
		deps.now = () => base + AUTO_UPDATE_IDLE_MS;
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("automatically updated");
	});
	it("records a deferral without throttling the retry when a turn starts during the check", async () => {
		const { home, p, deps } = autoSetup();
		deps.inspect.mockImplementation(async () => { recordHostActivity(p); return { installed: oldRelease, available: newRelease, sha256: newDigest }; });
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("deferred until hosts have been idle for 10 minutes");
		const state = JSON.parse(readFileSync(path.join(p.state, "release-update.json"), "utf8"));
		expect(state).toMatchObject({ status: "deferred", available: newRelease });
		expect(state.checkedAtMs).toBeUndefined();
		deps.now = () => Date.now() + AUTO_UPDATE_IDLE_MS + 1000;
		deps.inspect.mockResolvedValue({ installed: oldRelease, available: newRelease, sha256: newDigest });
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("automatically updated");
	});
	it("runs the same idle install for the daemon's detached updater and logs the outcome", async () => {
		const { home, p, deps } = autoSetup();
		expect(await maintainRuntimeWhenIdle(home, deps)).toContain("automatically updated");
		expect(deps.hooksRunning).toHaveBeenCalledWith(process.pid);
		expect(JSON.parse(readFileSync(path.join(p.state, "release-update.json"), "utf8"))).toMatchObject({ status: "updated", installed: newRelease, previous: oldRelease });
		expect(readFileSync(path.join(p.logs, "crossheadd.log"), "utf8")).toContain("update.auto");
	});
	it("lets the daemon spawn one updater only when a check is due and hosts are idle", async () => {
		const { home, p } = autoSetup();
		const now = Date.now();
		expect(idleUpdateCheckDue(p, now)).toBe(true);
		recordHostActivity(p, now);
		expect(idleUpdateCheckDue(p, now + AUTO_UPDATE_IDLE_MS - 1)).toBe(false);
		expect(idleUpdateCheckDue(p, now + AUTO_UPDATE_IDLE_MS)).toBe(true);
		expect(lastHostActivityMs(p)).toBe(now);
		writeJsonFile(path.join(p.state, "release-update.json"), { checkedAtMs: now + AUTO_UPDATE_IDLE_MS, status: "current" });
		expect(idleUpdateCheckDue(p, now + AUTO_UPDATE_IDLE_MS + 1)).toBe(false);
		rmSync(path.join(p.state, "release-update.json"));
		runtimeUpdatePolicy(home, "manual");
		expect(idleUpdateCheckDue(p, now + AUTO_UPDATE_IDLE_MS)).toBe(false);
		runtimeUpdatePolicy(home, "auto");
		recordHostActivity(p, 1);
		const launch = vi.fn(() => process.pid);
		const timer = startIdleUpdateTimer(p, () => "/runtime/cli.js", 5, 60_000, launch);
		try {
			await vi.waitFor(() => expect(launch).toHaveBeenCalledWith("/runtime/cli.js"));
			await new Promise(resolve => setTimeout(resolve, 40));
			expect(launch).toHaveBeenCalledOnce(); // The first updater is still alive.
		} finally { clearInterval(timer); }
		// An updater that exits without recording a check is not restarted on every poll.
		const dead = vi.fn(() => 2 ** 30);
		const bounded = startIdleUpdateTimer(p, () => "/runtime/cli.js", 5, 60_000, dead);
		try {
			await vi.waitFor(() => expect(dead).toHaveBeenCalled());
			await new Promise(resolve => setTimeout(resolve, 40));
			expect(dead).toHaveBeenCalledOnce();
		} finally { clearInterval(bounded); }
	});
	it("treats a prompt without a Stop as a turn in progress until it ages out", async () => {
		const { home, p, deps } = autoSetup();
		const started = Date.now();
		writeJsonFile(path.join(p.state, "claude-code-hook.json"), { activeTurns: { t: { turnId: "t", updatedAt: new Date(started).toISOString() } } });
		// Quiet for well over ten minutes, but the turn never stopped.
		deps.now = () => started + AUTO_UPDATE_TURN_MAX_MS - 1000;
		expect(hostTurnInProgress(p, deps.now())).toBe(true);
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toBe("");
		expect(deps.inspect).not.toHaveBeenCalled();
		expect(idleUpdateCheckDue(p, deps.now())).toBe(false);
		// A cancelled turn never gets Stop; its marker must not block forever.
		deps.now = () => started + AUTO_UPDATE_TURN_MAX_MS;
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("automatically updated");
	});
	it("updates ten minutes after Stop clears the turn", async () => {
		const { home, p, deps } = autoSetup();
		const file = path.join(p.state, "codex-hook.json");
		writeJsonFile(file, { activeTurns: { t: { turnId: "t", updatedAt: new Date().toISOString() } } });
		writeJsonFile(file, { activeTurns: {} });
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toBe("");
		deps.now = () => Date.now() + AUTO_UPDATE_IDLE_MS + 1000;
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("automatically updated");
	});
	it("never restarts a daemon that runs the organizational worker", async () => {
		const { home, p, deps } = autoSetup();
		writeJsonFile(path.join(p.state, "daemon.json"), { status: "running", organizationalWorkerConfigPath: "/etc/worker.json" });
		expect(idleUpdateCheckDue(p, Date.now())).toBe(false);
		expect(await maintainRuntimeWhenIdle(home, deps)).toBe("");
		expect(deps.inspect).not.toHaveBeenCalled();
	});
	it("records a deferral, not a failure, when a host becomes active as files are about to change", async () => {
		const { home, p, deps } = autoSetup();
		deps.update.mockImplementation(async (_home: string, options: any) => { recordHostActivity(p); options.beforeApply(); return { releaseId: newRelease } as any; });
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("deferred because a host became active");
		const state = JSON.parse(readFileSync(path.join(p.state, "release-update.json"), "utf8"));
		expect(state.status).toBe("deferred");
		expect(state.checkedAtMs).toBeUndefined();
	});
	it("treats only running Crosshead hook processes as activity, and fails closed", () => {
		const prefix = `2000 node /home/u/.crosshead/lib/runtime/r/dist/runtime/cli.js host-hook codex Stop\n`;
		expect(hostHooksRunning(2000, () => prefix + "2002 claude\n2003 codex app-server\n2004 node /r/dist/runtime/cli.js update --check-idle")).toBe(false);
		expect(hostHooksRunning(1, () => prefix)).toBe(true);
		expect(hostHooksRunning(1, () => "2002 node /r/dist/runtime/claude-code-hook.js Stop")).toBe(true);
		expect(hostHooksRunning(1, () => "2002 node /r/dist/runtime/native-host-hook.js --host hermes")).toBe(true);
		expect(hostHooksRunning(1, () => { throw new Error("ps unavailable"); })).toBe(true);
	});
	it("updates despite a stale active-turn marker without deleting saved hook state", async () => {
		const { home, p, deps } = autoSetup();
		const file = path.join(p.state, "codex-hook.json");
		writeJsonFile(file, { activeTurns: { interrupted: { turnId: "old" } } });
		const before = readFileSync(file, "utf8");
		deps.now = () => Date.now() + AUTO_UPDATE_IDLE_MS + 1000;
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("automatically updated");
		expect(readFileSync(file, "utf8")).toBe(before);
	});
	it("waits for queued writes even when the interrupted host has exited", async () => {
		const { home, p, deps } = autoSetup();
		writeJsonFile(path.join(p.state, "queue.json"), { items: [{}] });
		deps.hooksRunning.mockReturnValue(false);
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("rechecks running hooks after inspecting the release", async () => {
		const { home, deps } = autoSetup();
		deps.hooksRunning.mockReturnValueOnce(false).mockReturnValue(true);
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("deferred");
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("recognizes native hosts and draining hooks, excludes the launcher, and fails closed", () => {
		const prefix = `2000 codex /usr/bin/codex\n${process.pid} node /runtime/cli.js\n`;
		expect(nativeHostProcessesRunning(2000, () => prefix)).toBe(false);
		for (const command of ["codex /usr/bin/codex app-server", "claude /usr/bin/claude", "2.1.301 /home/user/.local/share/claude/versions/2.1.301", "node /opt/@anthropic-ai/claude-code/cli.js", "node /opt/@openai/codex/bin/codex.js", "node /runtime/dist/runtime/codex-hook.js Stop"]) {
			expect(nativeHostProcessesRunning(2000, () => prefix + `2002 ${command}`)).toBe(true);
		}
		expect(nativeHostProcessesRunning(2000, () => { throw new Error("ps unavailable"); })).toBe(true);
	});
	it("does not replace a release already current", async () => {
		const { home, deps } = autoSetup(); deps.inspect.mockResolvedValue({ installed: oldRelease, available: oldRelease, sha256: "a".repeat(64) });
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("continues offline and records a throttled failure instead of blocking every launch", async () => {
		const { home, deps } = autoSetup(); deps.inspect.mockRejectedValue(new Error("offline"));
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("offline");
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).toHaveBeenCalledOnce();
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("rechecks active work after fetching release metadata", async () => {
		const { home, p, deps } = autoSetup();
		deps.inspect.mockImplementation(async () => { writeJsonFile(path.join(p.state, "queue.json"), { items: [{}] }); return { installed: oldRelease, available: newRelease, sha256: newDigest }; });
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("deferred");
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("never installs when the signed attestation cannot be verified", async () => {
		const { home, p, deps } = autoSetup();
		deps.verify.mockRejectedValue(new Error("untrusted signature"));
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("untrusted signature");
		expect(deps.update).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(path.join(p.state, "release-update.json"), "utf8")).status).toBe("failed");
	});
	it.each([
		{ available: `0.5.0-alpha.12-${"b".repeat(12)}`, sha256: newDigest },
		{ available: `0.5.0-alpha.13-${"b".repeat(12)}`, sha256: newDigest },
		{ available: newRelease, sha256: "c".repeat(64) },
	])("rejects rollback, same-version replacement, or a release-ID digest mismatch", async release => {
		const { home, deps } = autoSetup();
		deps.inspect.mockResolvedValue({ installed: oldRelease, ...release });
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("metadata is invalid");
		expect(deps.verify).not.toHaveBeenCalled();
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("defers when a hook starts during signature verification", async () => {
		const { home, deps } = autoSetup();
		deps.hooksRunning.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("deferred");
		expect(deps.verify).toHaveBeenCalledOnce();
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("defers when active work begins during signature verification", async () => {
		const { home, p, deps } = autoSetup();
		deps.verify.mockImplementation(async () => { writeJsonFile(path.join(p.state, "queue.json"), { items: [{}] }); });
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("deferred");
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("defers automatic installs while a hook process is running", async () => {
		const { home, deps } = autoSetup();
		deps.hooksRunning.mockReturnValue(true);
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).not.toHaveBeenCalled();
	});
	it("serializes policy changes with a running automatic install", async () => {
		const { home, deps } = autoSetup();
		let finish!: (value: any) => void;
		deps.update.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
		const launch = maintainRuntimeBeforeLaunch(home, 2000, deps);
		await vi.waitFor(() => expect(deps.update).toHaveBeenCalledOnce());
		let changed = false;
		const manual = updateFromCli(["--manual", "--home", home]).then(() => { changed = true; });
		await new Promise(resolve => setTimeout(resolve, 30));
		expect(changed).toBe(false);
		finish({ releaseId: newRelease });
		await launch;
		await manual;
		expect(runtimeUpdatePolicy(home).mode).toBe("manual");
	});
	it("bounds a stalled dependency installer and reaps its child", async () => {
		await expect(runRuntimeInstallCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), 100))
			.rejects.toThrow("timed out");
	});
	it("serializes concurrent launchers recovering a dead updater lock", async () => {
		const { home, p, deps } = autoSetup();
		deps.alive = pid => pid === process.pid || pid === 2000 || pid === 2001;
		writeJsonFile(path.join(p.state, "release-update.lock"), { pid: 999999 });
		await Promise.all([maintainRuntimeBeforeLaunch(home, 2000, deps), maintainRuntimeBeforeLaunch(home, 2001, deps)]);
		expect(deps.inspect).toHaveBeenCalledOnce();
		expect(deps.update).toHaveBeenCalledOnce();
	});
});
