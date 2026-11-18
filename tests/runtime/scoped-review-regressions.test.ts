import { randomUUID } from "node:crypto";
import * as workspaceIdentity from "../../src/runtime/workspace-identity";
import { workspaceHookForInvocation } from "../../src/runtime/workspace-hooks";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { generateRuntimeIdentity, installRuntimeCore, setupRuntimeProfile, startDetachedRuntimeDaemon, stopDetachedRuntimeDaemon, updateManagedRuntimeRelease } from "../../src/runtime/local-runtime";
import { readDaemonOwnershipState, daemonOwnerIsLive } from "../../src/runtime/daemon-ownership";
import { configFile, loadRuntimeConfig, saveRuntimeConfig, resolveRuntimePaths, saveProfile } from "../../src/runtime/runtime-persistence";
import { writeLocalHotMemory, readLocalHotMemory } from "../../src/runtime/local-hot-memory";
import { inspectWorkspaceHooks } from "../../src/runtime/workspace-hooks";
import { runOnlyBotsCodexHookCli } from "../../src/runtime/codex-hook";
import { runOnlyBotsClaudeCodeHookCli } from "../../src/runtime/claude-code-hook";
import { renderRuntimeStartupContext } from "../../src/runtime/startup-context";
import { LocalRuntimeClient } from "../../src/runtime/local-client";
import * as hookRuntime from "../../src/runtime/hook-runtime";
import { runOnlyBotsCtlCli } from "../../src/runtime/cli";
import { memoryFromCli } from "../../src/runtime/cli/memory";
import { getHotSyncManager, stopHotSyncManagers } from "../../src/runtime/hot-sync-manager";
import { HostedOnlyBotsClient } from "../../src/runtime/hosted-client";

const repo = path.resolve(__dirname, "../..");
const cliFile = path.join(repo, "dist/runtime/cli.js"), daemonFile = path.join(repo, "dist/runtime/daemon.js");
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "xhd-review3-"))); roots.push(root);
  const home = path.join(root, "runtime"), project = path.join(root, "project"), second = path.join(root, "second");
  const codexHome = path.join(root, "codex"), claudeHome = path.join(root, "claude");
  for (const directory of [project, second, codexHome, claudeHome]) mkdirSync(directory, { recursive: true });
  const env = { PATH: process.env.PATH!, TMPDIR: tmpdir(), CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, CROSSHEAD_HOOK_AUTOSTART: "0" };
  const run = (...args: string[]) => spawnSync(process.execPath, [cliFile, ...args, "--home", home], { cwd: project, env, encoding: "utf8", timeout: 15000 });
  const cli = (...args: string[]) => { const result = run(...args); expect(result.status, result.stderr).toBe(0); return result.stdout; };
  return { root, home, project, second, codexHome, claudeHome, env, run, cli, paths: resolveRuntimePaths(home) };
};
const profile = (home: string, name: string) => setupRuntimeProfile({ home, profileName: name, apiBase: "http://127.0.0.1:0", ...generateRuntimeIdentity(), makeDefault: false });

it("completes a guided legacy migration that creates a second profile", async () => {
  const f = fixture(), old = await profile(f.home, "existing");
  const memory = JSON.stringify({ runtime: "codex", continuityCheckpoints: [{ summary: "Existing integer cents requirement", occurredAt: "2026-01-01T00:00:00Z" }] });
  writeLocalHotMemory(f.paths.state, memory, "codex");
  const scripts = { cliScriptPath: cliFile, daemonScriptPath: daemonFile, codexBridgeScriptPath: path.join(repo, "dist/runtime/codex-bridge.js"), codexHookScriptPath: path.join(repo, "dist/runtime/codex-hook.js"), claudeCodeBridgeScriptPath: path.join(repo, "dist/runtime/claude-code-bridge.js"), claudeCodeHookScriptPath: path.join(repo, "dist/runtime/claude-code-hook.js") };
  const flags = { home: f.home, "api-base": "http://127.0.0.1:0", "codex-home": f.codexHome, "claude-home": f.claudeHome, port: "0" };
  const code = `require(${JSON.stringify(path.join(repo, "dist/runtime/cli/workspace.js"))}).scopedQuickstartFromCli(${JSON.stringify(flags)},${JSON.stringify(scripts)},true).then(value=>console.log(value),error=>{console.error(error.message);process.exitCode=1});`;
  const answers = ["1", f.project, "codex", "existing", "no", "yes", f.second, "codex", "new", "no", "no", "yes"];
  const child = spawn(process.execPath, ["-e", code], { cwd: f.project, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", pending = "";
  child.stdout.on("data", data => { stdout += String(data); });
  child.stderr.on("data", data => {
    stderr += String(data); pending += String(data);
    if (pending.endsWith("] ") && answers.length) { child.stdin.write(answers.shift()! + "\n"); pending = ""; }
  });
  try {
    const result = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("guided setup timed out: " + stderr)); }, 20000);
      child.once("exit", status => { clearTimeout(timer); resolve(status); });
      child.once("error", reject);
    });
    expect(result, stderr).toBe(0); expect(stdout).toContain("Crosshead setup complete");
    expect(inspectWorkspaceHooks(f.home).bindings.map(binding => binding.profile).sort()).toEqual(["existing", "new"]);
    expect(JSON.stringify(readLocalHotMemory(f.paths.state, "all", old))).toContain("integer cents");
    const newer = JSON.parse(readFileSync(path.join(f.paths.profiles, "new.json"), "utf8"));
    expect(JSON.stringify(readLocalHotMemory(f.paths.state, "all", newer))).not.toContain("integer cents");
    expect(readFileSync(path.join(f.paths.state, "local-hot-memory/codex.json"), "utf8")).toBe(memory);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const closed = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await closed; }
    if (readDaemonOwnershipState(f.paths)) await stopDetachedRuntimeDaemon(f.home);
  }
}, 30000);

it("preflights corrupt policy before stopping a daemon or mutating install/update files", async () => {
  const f = fixture(); await profile(f.home, "work");
  await installRuntimeCore({ home: f.home, cliScriptPath: cliFile, daemonScriptPath: daemonFile });
  const policy = path.join(f.paths.config, "workspace-hooks.json"); writeFileSync(policy, "{truncated");
  await startDetachedRuntimeDaemon({ home: f.home, port: 0, daemonScriptPath: daemonFile });
  const owner = readDaemonOwnershipState(f.paths);
  const config = readFileSync(configFile(f.paths)), wrapper = readFileSync(path.join(f.paths.bin, "crosshead"));
  try {
    const result = f.run("uninstall");
    expect(result.status).toBe(1); expect(result.stderr).toContain("workspace repair");
    expect(daemonOwnerIsLive(owner)).toBe(true);
    expect(readDaemonOwnershipState(f.paths)?.pid).toBe(owner?.pid);
    const install = f.run("install", "codex", "--profile", "work", "--codex-home", f.codexHome, "--codex-bin", "/bin/true");
    expect(install.status).toBe(1); expect(install.stderr).toContain("workspace repair");
    expect(readFileSync(configFile(f.paths))).toEqual(config); expect(readFileSync(path.join(f.paths.bin, "crosshead"))).toEqual(wrapper);
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network should begin"));
    await expect(updateManagedRuntimeRelease(f.home)).rejects.toThrow("workspace repair"); expect(network).not.toHaveBeenCalled();
    expect(readFileSync(policy, "utf8")).toBe("{truncated");
  } finally { if (readDaemonOwnershipState(f.paths)) await stopDetachedRuntimeDaemon(f.home); }
}, 30000);

it.each([["pi", "pi"], ["omp", "pi"], ["hermes", "hermes"], ["opencode", "opencode"]] as const)("retains administrative startup diagnostics in off mode for %s", (_host, runtime) => {
  const context = renderRuntimeStartupContext({ runtime, profileName: "work", mode: "off", status: null, manifest: null, inbox: null, dreamReview: null,
    obligations: { refreshedAt: "2026-01-01T00:00:00Z", source: "live", stale: false, fetchError: null, summary: { total: 1, active: 1, due: 1, scheduled: 0, nextFireAt: null }, topItems: [{ id: "1", title: "Reconnect the service", status: "due", actionMode: "remind", nextFireAt: null }] },
    actions: [], warnings: ["Service unavailable"], injectedContext: "Private recalled memory", hotMemorySnapshot: { content: "Private checkpoint" } });
  expect(context).toContain("Mode: off"); expect(context).toContain("Service unavailable"); expect(context).toContain("Reconnect the service");
  expect(context).not.toContain("Private recalled memory"); expect(context).not.toContain("Private checkpoint"); expect(context).not.toContain("capture your final response");
});

it.each([["codex", runOnlyBotsCodexHookCli], ["claude-code", runOnlyBotsClaudeCodeHookCli]] as const)("pauses a deleted scoped profile for every %s event", async (host, hook) => {
  const f = fixture(); await profile(f.home, "work");
  f.cli("quickstart", "--scope", "project", "--adapter", host, "--profile", "work", "--source-excerpts", "on", "--no-start");
  const binding = inspectWorkspaceHooks(f.home).bindings[0]!;
  rmSync(path.join(f.paths.profiles, "work.json"));
  const warning = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) {
    await hook([event, "--home", f.home, "--binding", binding.id], JSON.stringify({ cwd: f.second }));
  }
  expect(warning).not.toHaveBeenCalled();
  for (const event of ["PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact", "Stop", "SessionStart", "UserPromptSubmit"]) {
    await expect(hook([event, "--home", f.home, "--binding", binding.id], JSON.stringify({ cwd: f.project }))).resolves.toBeUndefined();
  }
  expect(warning).toHaveBeenCalledTimes(2); expect(warning.mock.calls.flat().join(" ")).toContain("workspace check");
  expect(existsSync(path.join(f.paths.profiles, "work.json"))).toBe(false);
  expect(existsSync(path.join(f.paths.state, "lifecycle-events.jsonl"))).toBe(false);
});

it("isolates marked child hooks during an active parent turn and keeps Codex fork hooks active", async () => {
  const f = fixture();
  await profile(f.home, "work");
  f.cli("quickstart", "--scope", "project", "--adapter", "both", "--profile", "work", "--source-excerpts", "on", "--no-start");
  const ensure = vi.spyOn(hookRuntime, "ensureHookRuntime").mockResolvedValue(undefined);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(LocalRuntimeClient.prototype, "attachAdapter").mockResolvedValue({} as Awaited<ReturnType<LocalRuntimeClient["attachAdapter"]>>);
  vi.spyOn(LocalRuntimeClient.prototype, "readHotMemory").mockResolvedValue({});
  vi.spyOn(LocalRuntimeClient.prototype, "status").mockResolvedValue({ profile: { memoryMode: "assist" } } as Awaited<ReturnType<LocalRuntimeClient["status"]>>);
  const emit = vi.spyOn(LocalRuntimeClient.prototype, "emitEvent").mockResolvedValue({ mode: "assist" } as Awaited<ReturnType<LocalRuntimeClient["emitEvent"]>>);
  const bindings = inspectWorkspaceHooks(f.home).bindings;
  expect(bindings.map(binding => binding.host).sort()).toEqual(["claude-code", "codex"]);

  for (const binding of bindings) {
    const hook = binding.host === "codex" ? runOnlyBotsCodexHookCli : runOnlyBotsClaudeCodeHookCli;
    const invoke = (event: string, extra: Record<string, unknown> = {}) => hook(
      [event, "--home", f.home, "--binding", binding.id],
      JSON.stringify({ cwd: f.project, session_id: "parent", prompt: "Review migration.md", ...extra })
    );
    await invoke("SessionStart", { source: "startup" });
    await invoke("UserPromptSubmit", { agent_type: "reviewer" });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "turn.started", sessionId: "parent" }));

    const read = binding.host === "codex"
      ? { tool_name: "exec_command", tool_input: { cmd: "cat migration.md", workdir: f.project }, tool_response: "Use the last imported row." }
      : { tool_name: "Read", tool_input: { file_path: path.join(f.project, "migration.md") }, tool_response: { file: { content: "Use the last imported row." } } };
    emit.mockClear();
    ensure.mockClear();
    stdout.mockClear();
    for (const event of ["UserPromptSubmit", "PreCompact", "PostCompact", "Stop", "PostToolUse", "PostToolUseFailure"]) {
      await invoke(event, { ...read, agent_id: "child", agent_type: "reviewer" });
    }
    expect(ensure).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();

    await invoke("PostToolUse", read);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "tool.completed", sessionId: "parent" }));
  }

  const binding = bindings.find(binding => binding.host === "codex")!;
  const args = ["--home", f.home, "--binding", binding.id];
  const side = JSON.stringify({ cwd: f.project, session_id: "side", turn_id: "side-turn", source: "fork", prompt: "Explain the cursor" });
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) await runOnlyBotsCodexHookCli([event, ...args], side);
  for (const type of ["session.started", "turn.started", "turn.completed"]) {
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type, sessionId: "side" }));
  }
});

it("searches hot memory only inside the explicitly selected workspace and profile", async () => {
  const f = fixture();
  const work = await profile(f.home, "work");
  const other = await profile(f.home, "other");
  const workspaceId = `repo:${f.second}`;
  const otherWorkspaceId = `repo:${f.project}`;
  const checkpoint = (workspaceId: string | null, summary: string) => ({
    workspaceId, runtime: "codex", occurredAt: "2026-11-18T00:00:00.000Z", summary,
  });
  writeLocalHotMemory(f.paths.state, JSON.stringify({
    workspaceId,
    continuityCheckpoints: [
      checkpoint(workspaceId, "Migration cursor uses the last imported row"),
      checkpoint(otherWorkspaceId, "Migration cursor from another workspace"),
      checkpoint(null, "Migration cursor from unscoped memory"),
    ],
    hotMemory: { continuityCheckpoints: [checkpoint(null, "Migration cursor from nested metadata")] },
  }), "codex", work);
  writeLocalHotMemory(f.paths.state, JSON.stringify({
    workspaceId: otherWorkspaceId,
    continuityCheckpoints: [checkpoint(otherWorkspaceId, "Migration cursor in a different workspace document")],
  }), "claude-code", work);
  writeLocalHotMemory(f.paths.state, JSON.stringify({
    workspaceId,
    continuityCheckpoints: [checkpoint(workspaceId, "Migration cursor from a different profile")],
  }), "codex", other);

  const result = JSON.parse(f.cli("memory", "search", "migration cursor", "--workspace-root", f.second, "--profile", "work", "--json"));
  expect(result.scope).toBe("local_hot_memory");
  expect(result.workspaceId).toBe(workspaceId);
  expect(result.results.map((entry: { text: string }) => entry.text)).toEqual(["Migration cursor uses the last imported row"]);
  expect(f.run("memory", "search", "migration cursor", "--workspace-root").stderr).toContain("requires a directory");
  Object.assign(f.env, { CROSSHEAD_PROFILE: "work" });
  for (const profileArgs of [[], ["--profile"], ["--profile="]]) {
    expect(f.run("memory", "search", "migration cursor", "--workspace-root", f.second, ...profileArgs).stderr)
      .toContain("requires an explicit --profile");
  }
});

it("keeps hosted profiles isolated during local search and refuses legacy hosted fallback", async () => {
  const f = fixture();
  const identity = generateRuntimeIdentity();
  const origin = "https://crosshead.invalid";
  const workspaceId = `repo:${f.project}`;
  for (const [profileName, summary] of [["work", "Migration cursor from the work profile"], ["other", "Migration cursor from another profile"]]) {
    const local = await setupRuntimeProfile({ home: f.home, profileName, apiBase: "http://127.0.0.1:0", ...identity });
    saveProfile(f.paths, { ...local, apiBase: origin });
    const manager = getHotSyncManager({ stateDir: f.paths.state, origin, ...identity, profileName });
    manager.capture("codex", {
      id: randomUUID(), workspaceId, runtime: "codex", goal: "", summary, occurredAt: new Date().toISOString(),
    });
  }
  await stopHotSyncManagers(f.paths.state);
  Object.assign(f.env, { CROSSHEAD_HOT_SYNC_ENABLED: "true" });
  const args = ["search", "migration cursor", "--workspace-root", f.project, "--profile", "work", "--json"];
  const result = JSON.parse(f.cli("memory", ...args));
  expect(result.results.map((entry: { text: string }) => entry.text)).toEqual(["Migration cursor from the work profile"]);

  vi.stubEnv("CROSSHEAD_HOT_SYNC_ENABLED", "false");
  const hosted = vi.spyOn(HostedOnlyBotsClient.prototype, "readHotMemory").mockResolvedValue({});
  await expect(memoryFromCli([...args, "--home", f.home])).rejects.toThrow("requires local hot sync");
  expect(hosted).not.toHaveBeenCalled();
});

it("routes workspace link by the first positional after flags", async () => {
  const request = vi.spyOn(LocalRuntimeClient.prototype, "hotSyncControl").mockResolvedValue({ workspaceId: "fixture-link" });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runOnlyBotsCtlCli(["workspace", "--home", "/isolated", "--profile=work", "link", "--name", "shared", "--workspace-root", "/project"]);
  expect(request).toHaveBeenCalledWith({ action: "link", name: "shared", root: "/project", profileName: "work" });
});

it.each([["codex", runOnlyBotsCodexHookCli], ["claude-code", runOnlyBotsClaudeCodeHookCli]] as const)("pauses malformed persisted %s profiles before daemon work", async (host, hook) => {
  const f = fixture(); await profile(f.home, "work");
  f.cli("quickstart", "--scope", "project", "--adapter", host, "--profile", "work", "--source-excerpts", "on", "--no-start");
  const binding = inspectWorkspaceHooks(f.home).bindings[0]!;
  const file = path.join(f.paths.profiles, "work.json"), valid = JSON.parse(readFileSync(file, "utf8"));
  const warning = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const invalid of [{}, [], { ...valid, memoryMode: "unexpected" }, { ...valid, npub: "invalid" }, { ...valid, features: null }]) {
    writeFileSync(file, JSON.stringify(invalid));
    await expect(hook(["PostToolUse", "--home", f.home, "--binding", binding.id], JSON.stringify({ cwd: f.project }))).resolves.toBeUndefined();
    await expect(hook(["SessionStart", "--home", f.home, "--binding", binding.id], JSON.stringify({ cwd: f.project }))).resolves.toBeUndefined();
  }
  expect(warning).toHaveBeenCalledTimes(5);
  expect(existsSync(path.join(f.paths.state, "lifecycle-events.jsonl"))).toBe(false);
});

it("keeps an explicit equals-form profile distinct from the default for memory reads", async () => {
  const f = fixture(), first = await profile(f.home, "first"), second = await profile(f.home, "second");
  saveRuntimeConfig(f.paths, { ...loadRuntimeConfig(f.paths), defaultProfile: "first" });
  writeLocalHotMemory(f.paths.state, "first profile private memory", "codex", first);
  writeLocalHotMemory(f.paths.state, "second profile private memory", "codex", second);
  const output = f.cli("memory", "hot", "--profile=second", "--json");
  expect(output).toContain("second profile private memory"); expect(output).not.toContain("first profile private memory");
});

it("Git-locally excludes both host settings and preserves tracked Claude team settings", async () => {
  const f = fixture(); await profile(f.home, "work");
  expect(spawnSync("git", ["init", "-q", f.project]).status).toBe(0);
  f.cli("quickstart", "--scope", "project", "--adapter", "both", "--profile", "work", "--no-start");
  for (const file of [".codex/hooks.json", ".claude/settings.local.json"]) {
    expect(spawnSync("git", ["-C", f.project, "check-ignore", file]).status).toBe(0);
  }
  const excludes = readFileSync(path.join(f.project, ".git/info/exclude"), "utf8");
  expect(excludes).toContain("/.codex/hooks.json"); expect(excludes).toContain("/.claude/settings.local.json");
  expect(existsSync(path.join(f.project, ".gitignore"))).toBe(false);
  f.cli("workspace", "remove", "--workspace-root", f.project);
  const team = path.join(f.project, ".claude/settings.local.json"), content = JSON.stringify({ note: "team-owned", hooks: {} });
  writeFileSync(team, content); expect(spawnSync("git", ["-C", f.project, "add", "-f", ".claude/settings.local.json"]).status).toBe(0);
  f.cli("workspace", "add", "--workspace-root", f.project, "--adapter", "both", "--profile", "work");
  expect(readFileSync(team, "utf8")).toBe(content);
  expect(inspectWorkspaceHooks(f.home).bindings.find(binding => binding.host === "claude-code")!.file).toBe(path.join(f.claudeHome, "settings.json"));
});

it.each(["non-git", "git-missing", "git-timeout"])("keeps project files unchanged with %s and uses private scoped registrations", async scenario => {
  const f = fixture(); await profile(f.home, "work");
  for (const sub of [".codex", ".claude"]) mkdirSync(path.join(f.project, sub));
  const codex = path.join(f.project, ".codex/hooks.json"), claude = path.join(f.project, ".claude/settings.local.json"), legacy = path.join(f.project, ".claude/settings.json");
  const team = JSON.stringify({ hooks: {}, note: "team" });
  const legacyTeam = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `'${f.home}/bin/onlybots-claude-code-hook' SessionStart --home '${f.home}' --claude-home '${f.claudeHome}'` }] }] } });
  writeFileSync(codex, team); writeFileSync(claude, team); writeFileSync(legacy, legacyTeam);
  if (scenario !== "non-git") {
    expect(spawnSync("git", ["init", "-q", f.project]).status).toBe(0);
    expect(spawnSync("git", ["-C", f.project, "add", "-f", ".codex/hooks.json", ".claude/settings.local.json", ".claude/settings.json"]).status).toBe(0);
  }
  if (scenario === "git-missing") f.env.PATH = "";
  if (scenario === "git-timeout") {
    const fakeBin = path.join(f.root, "fake-bin"); mkdirSync(fakeBin);
    writeFileSync(path.join(fakeBin, "git"), "#!/bin/sh\nexec /bin/sleep 3\n", { mode: 0o755 }); f.env.PATH = fakeBin;
  }
  f.cli("quickstart", "--scope", "project", "--adapter", "both", "--profile", "work", "--no-start");
  expect(readFileSync(codex, "utf8")).toBe(team); expect(readFileSync(claude, "utf8")).toBe(team); expect(readFileSync(legacy, "utf8")).toBe(legacyTeam);
  expect(existsSync(path.join(f.project, ".gitignore"))).toBe(false);
  const bindings = inspectWorkspaceHooks(f.home).bindings;
  expect(bindings).toHaveLength(2); expect(bindings.every(binding => binding.registration === "user" && binding.configured)).toBe(true);
  expect(inspectWorkspaceHooks(f.home, f.second).bindings).toEqual([]);
});

it("walks the repository once per hook invocation and workspace inspection", async () => {
  const f = fixture(); await profile(f.home, "work");
  let directory = f.project;
  const bindings = Array.from({ length: 20 }, () => {
    const root = directory; directory = path.join(directory, "sub"); mkdirSync(directory);
    return { id: randomUUID(), host: "codex" as const, root, hostHome: f.codexHome, profile: "work", sourceExcerpts: false, registration: "user" as const };
  });
  const policy = { version: 1 as const, scope: "project" as const, bindings };
  writeFileSync(path.join(f.paths.config, "workspace-hooks.json"), JSON.stringify(policy));
  const walk = vi.spyOn(workspaceIdentity, "workspaceRepositoryRoot");
  expect(workspaceHookForInvocation(policy, "codex", bindings.at(-1)!.id, directory)?.root).toBe(bindings.at(-1)!.root);
  expect(walk).toHaveBeenCalledTimes(1); walk.mockClear();
  expect(workspaceHookForInvocation(policy, "codex", bindings[0]!.id, directory)).toBeNull();
  expect(walk).toHaveBeenCalledTimes(1); walk.mockClear();
  expect(inspectWorkspaceHooks(f.home, directory).bindings).toHaveLength(1);
  expect(walk).toHaveBeenCalledTimes(1);
});

it("caches legacy profile parsing without hiding profile changes or writing during reads", async () => {
  const f = fixture(), identity = await profile(f.home, "work");
  const file = path.join(f.paths.profiles, "work.json"), original = readFileSync(file, "utf8"), parsed = JSON.parse(original);
  writeLocalHotMemory(f.paths.state, "Legacy private checkpoint", "codex");
  const parse = JSON.parse; let profileParses = 0;
  vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: (key: string, value: unknown) => unknown) => {
    if (text === original) profileParses++;
    return parse(text, reviver);
  });
  expect(JSON.stringify(readLocalHotMemory(f.paths.state, "all", identity))).toContain("Legacy private checkpoint");
  expect(JSON.stringify(readLocalHotMemory(f.paths.state, "all", identity))).toContain("Legacy private checkpoint");
  expect(profileParses).toBe(1);
  writeFileSync(file, JSON.stringify({ ...parsed, npub: generateRuntimeIdentity().npub }));
  expect(JSON.stringify(readLocalHotMemory(f.paths.state, "all", identity))).not.toContain("Legacy private checkpoint");
  expect(existsSync(path.join(f.paths.state, "legacy-local-hot-owner.json"))).toBe(false);
});

it("does not infer sole legacy ownership while another profile is unreadable", async () => {
  const f = fixture(), identity = await profile(f.home, "first"); await profile(f.home, "second");
  writeFileSync(path.join(f.paths.profiles, "second.json"), "{truncated");
  writeLocalHotMemory(f.paths.state, "Ambiguous private checkpoint", "codex");
  expect(JSON.stringify(readLocalHotMemory(f.paths.state, "all", identity))).not.toContain("Ambiguous private checkpoint");
});

it.each(["identity", "json", "empty", "array", "features", "name"])("reports malformed profile %s as invalid in workspace check and doctor", async kind => {
  const f = fixture(); await profile(f.home, "work");
  f.cli("quickstart", "--scope", "project", "--adapter", "codex", "--profile", "work", "--no-start");
  const file = path.join(f.paths.profiles, "work.json"), valid = JSON.parse(readFileSync(file, "utf8"));
  const damaged = kind === "json" ? "{partial" : JSON.stringify(kind === "empty" ? {} : kind === "array" ? [] :
    kind === "features" ? { ...valid, features: null } : kind === "name" ? { ...valid, name: "bad/name" } : { ...valid, npub: "invalid" });
  writeFileSync(file, damaged);
  const inspection = JSON.parse(f.cli("workspace", "check", "--json"));
  expect(inspection.bindings[0]).toMatchObject({ profileState: "invalid", memoryMode: null, startup: null, resume: null });
  expect(f.cli("workspace", "check")).toContain("profile invalid");
  const report = JSON.parse(f.cli("doctor", "--profile", "work", "--json"));
  expect(report.checks.find((check: { id: string }) => check.id === "codex_hooks")).toMatchObject({ ok: false });
  expect(report.checks.find((check: { id: string }) => check.id === "codex_hooks").message).toContain("profile invalid");
});

it.each(["codex", "claude-code"] as const)("refuses a %s private fallback inside the project before creating a profile", async host => {
  const f = fixture(); await profile(f.home, "work");
  writeLocalHotMemory(f.paths.state, "Existing legacy memory", "codex");
  const hostDirectory = path.join(f.project, host === "codex" ? ".codex" : ".claude"); mkdirSync(hostDirectory);
  const projectSettings = path.join(hostDirectory, host === "codex" ? "hooks.json" : "settings.local.json");
  const target = path.join(hostDirectory, host === "codex" ? "hooks.json" : "settings.json");
  const team = JSON.stringify({ note: "team-owned", hooks: {} }); writeFileSync(projectSettings, team); writeFileSync(target, team);
  expect(spawnSync("git", ["init", "-q", f.project]).status).toBe(0);
  expect(spawnSync("git", ["-C", f.project, "add", "-f", "."]).status).toBe(0);
  const alias = path.join(f.root, "host alias"); symlinkSync(hostDirectory, alias);
  for (const home of [hostDirectory, alias, path.join(f.project, "new-host-home")]) {
    const args = ["quickstart", "--scope", "project", "--adapter", host, "--profile", "new", "--api-base", "http://127.0.0.1:0", "--no-start", host === "codex" ? "--codex-home" : "--claude-home", home];
    // An unavailable Git result also covers a not-yet-existing fallback destination.
    const result = spawnSync(process.execPath, [cliFile, ...args, "--home", f.home], { cwd: f.project, env: { ...f.env, PATH: "" }, encoding: "utf8" });
    expect(result.status).toBe(1); expect(result.stderr).toContain("outside the selected projects");
    expect(readFileSync(projectSettings, "utf8")).toBe(team); expect(readFileSync(target, "utf8")).toBe(team);
    expect(existsSync(path.join(f.paths.profiles, "new.json"))).toBe(false);
    expect(existsSync(path.join(f.paths.state, "legacy-local-hot-owner.json"))).toBe(false);
    expect(existsSync(path.join(f.paths.config, "workspace-hooks.json"))).toBe(false);
  }
});
