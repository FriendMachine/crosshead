import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { maintainRuntimeBeforeLaunch, runtimeUpdatePolicy, nativeHostProcessesRunning } from "../../src/runtime/runtime-auto-update";
import { fetchRuntimeReleaseArtifact, inspectInstalledRuntimeRelease, isAllowedRuntimeReleaseUrl, parseWrapperScriptTarget, resolveReleaseUpdateBaseUrl, updateManagedRuntimeRelease } from "../../src/runtime/local-runtime";
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
		alive: (pid: number) => pid === 2001,
		nativeHostsRunning: vi.fn(() => true),
		now: () => Date.now(),
	};
	return { home, p, deps };
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
	it("checks on the next idle launch, reports a trusted-install command, and throttles repeated checks", async () => {
		const { home, deps } = setup();
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("crosshead update --sha256 <digest>");
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).toHaveBeenCalledTimes(1);
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("pins the installed release and permits switching back to automatic updates", async () => {
		const { home, deps } = setup();
		expect(runtimeUpdatePolicy(home, "pinned")).toEqual({ mode: "pinned", releaseId: "old" });
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).not.toHaveBeenCalled();
		runtimeUpdatePolicy(home, "auto");
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).toHaveBeenCalledOnce();
		expect(deps.update).not.toHaveBeenCalled();
	});
	it.each(["codex", "claude-code"])("defers while %s has an active hooked turn", async host => {
		const { home, p, deps } = setup();
		writeJsonFile(path.join(p.state, `${host}-hook.json`), { activeTurns: { active: { turnId: "t" } } });
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).not.toHaveBeenCalled();
	});
	it("defers for a live idle host, but removes dead process leases", async () => {
		const { home, p, deps } = setup();
		const leases = path.join(p.state, "host-processes"); mkdirSync(leases);
		writeJsonFile(path.join(leases, "2001.json"), { pid: 2001 });
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).not.toHaveBeenCalled();
		deps.alive = () => false;
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).toHaveBeenCalledOnce();
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("reports an update after an interrupted host exits without deleting its saved hook state", async () => {
		const { home, p, deps } = setup();
		const file = path.join(p.state, "codex-hook.json");
		writeJsonFile(file, { activeTurns: { interrupted: { turnId: "old" } } });
		const before = readFileSync(file, "utf8");
		deps.nativeHostsRunning.mockReturnValue(false);
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("is available");
		expect(readFileSync(file, "utf8")).toBe(before);
	});
	it("waits for queued writes even when the interrupted host has exited", async () => {
		const { home, p, deps } = setup();
		writeJsonFile(path.join(p.state, "queue.json"), { items: [{}] });
		deps.nativeHostsRunning.mockReturnValue(false);
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("rechecks legacy host liveness after inspecting the release", async () => {
		const { home, p, deps } = setup();
		writeJsonFile(path.join(p.state, "codex-hook.json"), { activeTurns: { old: {} } });
		deps.nativeHostsRunning.mockReturnValueOnce(false).mockReturnValue(true);
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
		const { home, deps } = setup(); deps.inspect.mockResolvedValue({ installed: "old", available: "old" });
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("continues offline and records a throttled failure instead of blocking every launch", async () => {
		const { home, deps } = setup(); deps.inspect.mockRejectedValue(new Error("offline"));
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("offline");
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).toHaveBeenCalledOnce();
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("rechecks active work after fetching release metadata", async () => {
		const { home, p, deps } = setup();
		deps.inspect.mockImplementation(async () => { writeJsonFile(path.join(p.state, "queue.json"), { items: [{}] }); return { installed: "old", available: "new" }; });
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("deferred");
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("serializes concurrent launchers recovering a dead updater lock", async () => {
		const { home, p, deps } = setup();
		deps.alive = pid => pid === process.pid || pid === 2000 || pid === 2001;
		writeJsonFile(path.join(p.state, "release-update.lock"), { pid: 999999 });
		await Promise.all([maintainRuntimeBeforeLaunch(home, 2000, deps), maintainRuntimeBeforeLaunch(home, 2001, deps)]);
		expect(deps.inspect).toHaveBeenCalledOnce();
		expect(deps.update).not.toHaveBeenCalled();
	});
});
