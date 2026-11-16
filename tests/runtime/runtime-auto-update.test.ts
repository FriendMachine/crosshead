import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { maintainRuntimeBeforeLaunch, runtimeUpdatePolicy, nativeHostProcessesRunning } from "../../src/runtime/runtime-auto-update";
import { updateFromCli } from "../../src/runtime/cli/core";
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
		nativeHostsRunning: vi.fn(() => true),
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
	fixture.deps.nativeHostsRunning.mockReturnValue(false);
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
		expect(deps.update).toHaveBeenCalledExactlyOnceWith(home, { trustedSha256: newDigest, timeoutMs: 45_000, expectedReleaseId: newRelease });
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
	it.each(["codex", "claude-code"])("defers while %s has an active hooked turn", async host => {
		const { home, p, deps } = autoSetup();
		writeJsonFile(path.join(p.state, `${host}-hook.json`), { activeTurns: { active: { turnId: "t" } } });
		deps.nativeHostsRunning.mockReturnValue(true);
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).not.toHaveBeenCalled();
	});
	it("defers for a live idle host, but removes dead process leases", async () => {
		const { home, p, deps } = autoSetup();
		const leases = path.join(p.state, "host-processes"); mkdirSync(leases);
		writeJsonFile(path.join(leases, "2001.json"), { pid: 2001 });
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).not.toHaveBeenCalled();
		deps.alive = () => false;
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.inspect).toHaveBeenCalledOnce();
		expect(deps.update).toHaveBeenCalledOnce();
	});
	it("reports an update after an interrupted host exits without deleting its saved hook state", async () => {
		const { home, p, deps } = autoSetup();
		const file = path.join(p.state, "codex-hook.json");
		writeJsonFile(file, { activeTurns: { interrupted: { turnId: "old" } } });
		const before = readFileSync(file, "utf8");
		deps.nativeHostsRunning.mockReturnValue(false);
		expect(await maintainRuntimeBeforeLaunch(home, 2000, deps)).toContain("automatically updated");
		expect(readFileSync(file, "utf8")).toBe(before);
	});
	it("waits for queued writes even when the interrupted host has exited", async () => {
		const { home, p, deps } = autoSetup();
		writeJsonFile(path.join(p.state, "queue.json"), { items: [{}] });
		deps.nativeHostsRunning.mockReturnValue(false);
		await maintainRuntimeBeforeLaunch(home, 2000, deps);
		expect(deps.update).not.toHaveBeenCalled();
	});
	it("rechecks legacy host liveness after inspecting the release", async () => {
		const { home, p, deps } = autoSetup();
		writeJsonFile(path.join(p.state, "codex-hook.json"), { activeTurns: { old: {} } });
		deps.nativeHostsRunning.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
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
	it("defers when a native host starts during signature verification without hook state", async () => {
		const { home, deps } = autoSetup();
		deps.nativeHostsRunning.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
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
	it("defers automatic installs while a different native host is running even without a lease", async () => {
		const { home, deps } = autoSetup();
		deps.nativeHostsRunning.mockReturnValue(true);
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
