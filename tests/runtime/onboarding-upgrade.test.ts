import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installCodexAdapter, loadCodexAdapterConfig } from "../../src/runtime/codex-adapter";
import { installClaudeCodeAdapter } from "../../src/runtime/claude-code-adapter";
import { generateRuntimeIdentity, installRuntimeCore, reapplyManagedRuntimeRelease, setupRuntimeProfile, stopDetachedRuntimeDaemon, updateRuntimeAdapterVersion } from "../../src/runtime/local-runtime";
import { readDaemonOwnershipState } from "../../src/runtime/daemon-ownership";
import { resolveRuntimePaths } from "../../src/runtime/runtime-persistence";
import { readLocalHotMemory, writeLocalHotMemory } from "../../src/runtime/local-hot-memory";
import { inspectWorkspaceHooks, workspaceBindingStatus } from "../../src/runtime/workspace-hooks";
import { filterHotMemorySnapshotForWorkspace } from "../../src/runtime/host-adapter-base";
import { HostedOnlyBotsClient } from "../../src/runtime/hosted-client";
import { isRuntimeProfileName } from "../../src/runtime/runtime-env";
import { runOnlyBotsCodexHookCli } from "../../src/runtime/codex-hook";
import { runOnlyBotsClaudeCodeHookCli } from "../../src/runtime/claude-code-hook";

const repo = path.resolve(__dirname, "../..");
const cliFile = path.join(repo, "dist/runtime/cli.js");
const daemonFile = path.join(repo, "dist/runtime/daemon.js");
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "xhd-upgrade-"))); dirs.push(root);
  const home = path.join(root, "runtime"), project = path.join(root, "project");
  const codexHome = path.join(root, "codex"), claudeHome = path.join(root, "claude");
  for (const dir of [project, codexHome, claudeHome]) mkdirSync(dir, { recursive: true });
  const env = { PATH: process.env.PATH!, TMPDIR: tmpdir(), CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, CROSSHEAD_PROFILE: "leftover", CROSSHEAD_HOOK_AUTOSTART: "0" };
  const run = (...args: string[]) => spawnSync(process.execPath, [cliFile, ...args, "--home", home], { cwd: project, env, encoding: "utf8", timeout: 12000 });
  const cli = (...args: string[]) => { const result = run(...args); expect(result.status, result.stderr || result.stdout).toBe(0); return result.stdout; };
  const hooks = (host: "codex" | "claude-code") => inspectWorkspaceHooks(home, project).bindings.find(binding => binding.host === host)!;
  const invoke = (host: "codex" | "claude-code", event: string, payload: object) => {
    const file = hooks(host).file;
    const command = JSON.parse(readFileSync(file, "utf8")).hooks[event].at(-1).hooks[0].command;
    const result = spawnSync("sh", ["-c", command], { cwd: project, env, input: JSON.stringify({ cwd: project, ...payload }), encoding: "utf8", timeout: 10000 });
    expect(result.status, result.stderr).toBe(0); expect(result.stderr).toBe(""); return result.stdout;
  };
  return { root, home, project, codexHome, claudeHome, cli, run, hooks, invoke, env };
};
const profile = async (home: string, name: string) => setupRuntimeProfile({ home, profileName: name, apiBase: "http://127.0.0.1:0", ...generateRuntimeIdentity(), makeDefault: false });

describe("legacy onboarding upgrades", () => {
  it("retains flat checkpoints through scoped startup/search/update and fully uninstalls adapters", async () => {
    const f = fixture();
    const paths = resolveRuntimePaths(f.home);
    const identity = await profile(f.home, "work");
    await installRuntimeCore({ home: f.home, cliScriptPath: cliFile, daemonScriptPath: daemonFile });
    await installCodexAdapter({ home: f.home, hostHome: f.codexHome, profileName: "work", codexBinary: "/bin/true", bridgeScriptPath: path.join(repo, "dist/runtime/codex-bridge.js"), hookScriptPath: path.join(repo, "dist/runtime/codex-hook.js") });
    await installClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome, workspaceRoot: f.project, profileName: "work", claudeBinary: "/bin/true", bridgeScriptPath: path.join(repo, "dist/runtime/claude-code-bridge.js"), hookScriptPath: path.join(repo, "dist/runtime/claude-code-hook.js") });
    const requirement = "Existing invoice requirements use integer cents and round half up.";
    const legacy = JSON.stringify({ runtime: "codex", continuityCheckpoints: [{ runtime: "codex", workspaceId: null, sessionId: "old", turnId: "old", goal: "invoice requirements", summary: requirement, occurredAt: new Date().toISOString() }] });
    writeLocalHotMemory(paths.state, legacy, "codex");
    expect(loadCodexAdapterConfig(f.home, f.codexHome).profileName).toBe("work");
    expect(f.cli("memory", "hot", "--profile=work", "--json")).toContain(requirement);
    const dry = JSON.parse(f.cli("quickstart", "--adapter", "pi", "--profile", "work", "--dry-run", "--json"));
    expect(dry).toMatchObject({ applied: false, scope: "legacy", adapter: "pi" });
    f.cli("quickstart", "--adapter", "codex", "--profile", "work", "--codex-home", f.codexHome, "--codex-bin", "/bin/true", "--no-start", "--json");
    expect(existsSync(path.join(paths.config, "workspace-hooks.json"))).toBe(false);
    try {
      f.cli("quickstart", "--scope", "project", "--adapter", "both", "--profile", "work", "--workspace-root", f.project, "--codex-home", f.codexHome, "--claude-home", f.claudeHome, "--port", "0", "--json");
      f.invoke("codex", "SessionStart", { source: "startup", session_id: "new" });
      expect(f.invoke("codex", "UserPromptSubmit", { session_id: "new", prompt: "Continue invoice requirements" })).toContain(requirement);
      expect(f.cli("memory", "search", "invoice", "--profile", "work", "--json")).toContain(requirement);
      await profile(f.home, "other");
      expect(JSON.stringify(readLocalHotMemory(paths.state, "all", identity))).toContain(requirement);
      expect(f.cli("memory", "hot", "--profile", "other", "--json")).not.toContain(requirement);
      const before = f.hooks("codex");
      const settings = JSON.parse(readFileSync(before.file, "utf8"));
      for (const groups of Object.values(settings.hooks) as Array<Array<{ hooks: Array<{command:string}> }>>) {
	for (const group of groups) for (const handler of group.hooks) handler.command = handler.command.replace(/ --source-excerpts (on|off)$/, "");
      }
      writeFileSync(before.file, JSON.stringify(settings));
      const nextRelease = path.join(paths.libRuntime, "fixture-next");
      mkdirSync(nextRelease, { recursive: true });
      cpSync(path.join(repo, "dist"), path.join(nextRelease, "dist"), { recursive: true });
      symlinkSync(path.join(repo, "node_modules"), path.join(nextRelease, "node_modules"), "dir");
      const nextScript = (name: string) => path.join(nextRelease, "dist/runtime", name);
      await reapplyManagedRuntimeRelease(paths, {
	baseUrl: "http://127.0.0.1:0", releaseId: "fixture", releaseUrl: "", releaseSha256: "",
	releaseRoot: nextRelease, cliScriptPath: nextScript("cli.js"), daemonScriptPath: nextScript("daemon.js"),
	localRuntimeModulePath: nextScript("local-runtime.js"), codexAdapterModulePath: nextScript("codex-adapter.js"), claudeCodeAdapterModulePath: nextScript("claude-code-adapter.js"), piAdapterModulePath: nextScript("pi-adapter.js"),
      }, [{ name: "codex", profileName: "work", hostHome: f.codexHome, codexBinary: "/bin/true" }, { name: "claude-code", profileName: "work", hostHome: f.claudeHome, workspaceRoot: f.project, claudeBinary: "/bin/true" }]);
      expect(readFileSync(path.join(paths.bin, "crosshead-codex"), "utf8")).toContain(nextScript("codex-bridge.js"));
      expect(readFileSync(path.join(paths.bin, "crosshead-claude-code"), "utf8")).toContain(nextScript("claude-code-bridge.js"));
      await updateRuntimeAdapterVersion(f.home, "codex", "0.3.0");
      expect(f.hooks("codex")).toMatchObject({ id: before.id, profile: "work", configured: true });
      expect(JSON.parse(readFileSync(before.file, "utf8")).hooks.SessionStart).toHaveLength(1);
      f.invoke("claude-code", "SessionStart", { source: "resume", session_id: "resumed" });
      expect(f.invoke("claude-code", "UserPromptSubmit", { session_id: "resumed", prompt: "Continue invoice requirements" })).toContain(requirement);
      expect(readFileSync(path.join(paths.state, "local-hot-memory/codex.json"), "utf8")).toBe(legacy);
      f.env.CODEX_HOME = "";
      f.env.CLAUDE_CONFIG_DIR = "";
      f.cli("uninstall", "codex");
      for (const file of ["onlybots/codex-adapter.json", "skills/crosshead-bootstrap/SKILL.md"]) expect(existsSync(path.join(f.codexHome, file))).toBe(false);
      expect(existsSync(path.join(paths.bin, "crosshead-codex-hook"))).toBe(false);
      expect(f.hooks("claude-code").configured).toBe(true);
      f.cli("uninstall", "claude-code");
      expect(existsSync(path.join(f.claudeHome, "onlybots/claude-code-adapter.json"))).toBe(false);
      expect(existsSync(path.join(paths.bin, "crosshead-claude-code-hook"))).toBe(false);
    } finally { if (readDaemonOwnershipState(paths)) await stopDetachedRuntimeDaemon(f.home); }
  }, 30000);

  it("maps symlinks and subdirectories only to their own repository", () => {
    const f = fixture();
    mkdirSync(path.join(f.project, ".git")); writeFileSync(path.join(f.project, ".git/HEAD"), "ref: refs/heads/main\n");
    mkdirSync(path.join(f.project, "src"));
    const alias = path.join(f.root, "alias"); symlinkSync(f.project, alias);
    const checkpoint = { runtime: "codex", workspaceId: `repo:${alias}/src`, summary: "Old path rule", goal: "requirements", occurredAt: new Date().toISOString() };
    const snapshot = { scopes: [{ scope: "codex", content: JSON.stringify({ workspaceId: checkpoint.workspaceId, continuityCheckpoints: [checkpoint] }) }] };
    const mapped = filterHotMemorySnapshotForWorkspace(snapshot, `repo:${f.project}`, true);
    expect(JSON.stringify(mapped)).toContain("Old path rule");
    expect(JSON.stringify(mapped)).not.toContain(alias);
    const unrelated = path.join(f.root, "unrelated"); mkdirSync(unrelated);
    expect(filterHotMemorySnapshotForWorkspace(snapshot, `repo:${unrelated}`, true)).toBeNull();
    expect(snapshot.scopes[0]!.content).toContain(alias);
  });

  it("keeps generated Codex settings local and preserves already tracked hooks", async () => {
    const f = fixture(); await profile(f.home, "work");
    expect(spawnSync("git", ["init", "-q", f.project]).status).toBe(0);
    f.cli("quickstart", "--scope", "project", "--adapter", "codex", "--profile", "work", "--codex-home", f.codexHome, "--no-start");
    const local = path.join(f.project, ".codex/hooks.json");
    expect(spawnSync("git", ["-C", f.project, "check-ignore", local]).status).toBe(0);
    f.cli("workspace", "remove", "--workspace-root", f.project);
    writeFileSync(local, JSON.stringify({ hooks: {}, description: "team-owned" }));
    expect(spawnSync("git", ["-C", f.project, "add", ".codex/hooks.json"]).status).toBe(0);
    f.cli("workspace", "add", "--workspace-root", f.project, "--adapter", "codex", "--profile", "work", "--codex-home", f.codexHome);
    expect(f.hooks("codex").file).toBe(path.join(f.codexHome, "hooks.json"));
    expect(JSON.parse(readFileSync(local, "utf8"))).toEqual({ hooks: {}, description: "team-owned" });
  });

  it("retains a shared Git exclude while another worktree remains configured", async () => {
    const f = fixture(); await profile(f.home, "work");
    expect(spawnSync("git", ["init", "-q", f.project]).status).toBe(0);
    expect(spawnSync("git", ["-C", f.project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "base"]).status).toBe(0);
    const sibling = path.join(f.root, "sibling");
    expect(spawnSync("git", ["-C", f.project, "worktree", "add", "-qb", "sibling", sibling]).status).toBe(0);
    f.cli("quickstart", "--scope", "project", "--adapter", "codex", "--profile", "work", "--codex-home", f.codexHome, "--no-start");
    f.cli("workspace", "add", "--workspace-root", sibling, "--adapter", "codex", "--profile", "work", "--codex-home", f.codexHome);
    f.cli("workspace", "remove", "--workspace-root", f.project);
    expect(spawnSync("git", ["-C", sibling, "check-ignore", ".codex/hooks.json"]).status).toBe(0);
  });

  it("keeps ambiguous legacy stores quarantined after a profile changes endpoint", async () => {
    const f = fixture();
    const first = await profile(f.home, "first");
    const key = generateRuntimeIdentity();
    await setupRuntimeProfile({ home: f.home, profileName: "second", apiBase: "http://127.0.0.1:0", ...key });
    const paths = resolveRuntimePaths(f.home);
    writeLocalHotMemory(paths.state, "Unknown ownership", "codex");
    expect(JSON.stringify(readLocalHotMemory(paths.state, "all", first))).not.toContain("Unknown ownership");
    vi.spyOn(HostedOnlyBotsClient.prototype, "ensureSession").mockResolvedValue(null as never);
    await setupRuntimeProfile({ home: f.home, profileName: "second", apiBase: "https://example.invalid", ...key });
    expect(JSON.stringify(readLocalHotMemory(paths.state, "all", first))).not.toContain("Unknown ownership");
    expect(readFileSync(path.join(paths.state, "local-hot-memory/codex.json"), "utf8")).toBe("Unknown ownership");
  });

  it("does not transfer legacy adoption to another profile or future unscoped captures", async () => {
    const f = fixture(); await profile(f.home, "first"); await profile(f.home, "second");
    f.cli("quickstart", "--scope", "project", "--adapter", "codex", "--profile", "first", "--codex-home", f.codexHome, "--no-start");
    expect(f.hooks("codex").legacyUnscoped).toBe(true);
    const unscoped = { scopes: [{ scope: "codex", updated_at: "2099-01-01T00:00:00Z", content: JSON.stringify({ summary: "Future unrelated note" }) }] };
    expect(filterHotMemorySnapshotForWorkspace(unscoped, `repo:${f.project}`, true, true, "2026-01-01T00:00:00Z")).toBeNull();
    f.cli("workspace", "add", "--workspace-root", f.project, "--adapter", "codex", "--profile", "second", "--codex-home", f.codexHome);
    expect(f.hooks("codex").legacyUnscoped).toBe(false);
  });

  it("uses the persistence grammar for existing profile names", async () => {
    const f = fixture(); await profile(f.home, "work+personal");
    f.cli("quickstart", "--scope", "project", "--adapter", "codex", "--profile=work+personal", "--codex-home", f.codexHome, "--no-start");
    expect(f.hooks("codex").profile).toBe("work+personal");
    expect(isRuntimeProfileName("a".repeat(128))).toBe(true);
    expect(isRuntimeProfileName("a".repeat(129))).toBe(false);
  });

  it.each([runOnlyBotsCodexHookCli, runOnlyBotsClaudeCodeHookCli])("treats corrupt policy as paused hook work", async run => {
    const f = fixture(); mkdirSync(path.join(f.home, "config"), { recursive: true });
    writeFileSync(path.join(f.home, "config/workspace-hooks.json"), "{partial");
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run(["PostToolUse", "--home", "/missing", "--binding", "ignored", "--source-excerpts", "off"], "invalid stdin")).resolves.toBeUndefined();
    await expect(run(["PostToolUse", "--home", f.home, "--binding", "ignored"], "invalid stdin")).resolves.toBeUndefined();
    expect(warning).not.toHaveBeenCalled();
    await expect(run(["SessionStart", "--home", f.home, "--binding", "ignored"], "{}")).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
  });

  it("uses one status ladder for unobserved all-project bindings", async () => {
    const f = fixture(); await profile(f.home, "work");
    f.cli("quickstart", "--scope", "all", "--adapter", "codex", "--profile", "work", "--codex-home", f.codexHome, "--no-start");
    const inspection = inspectWorkspaceHooks(f.home);
    expect(workspaceBindingStatus(inspection.bindings[0]!, null)).toBe("configured; check from a project");
  });
});

it("releases the setup lock after its owning process is killed", async () => {
  const f = fixture();
  const moduleFile = JSON.stringify(path.join(repo, "dist/runtime/workspace-hooks.js"));
  const pathsFile = JSON.stringify(path.join(repo, "dist/runtime/runtime-persistence.js"));
  const code = `
    const { withWorkspaceSetupLock } = require(${moduleFile});
    const { resolveRuntimePaths } = require(${pathsFile});
    withWorkspaceSetupLock(resolveRuntimePaths(process.argv[1]), async () => {
      console.log("locked");
      await new Promise(() => {});
    });
  `;
  const child = spawn(process.execPath, ["-e", code, f.home], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("lock startup timed out")), 4000); child.stdout.on("data", data => { if (String(data).includes("locked")) { clearTimeout(timer); resolve(); } }); child.once("exit", code => { clearTimeout(timer); reject(new Error(`lock owner exited ${code}`)); }); });
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
    const retry = spawnSync(process.execPath, ["-e", `const {withWorkspaceSetupLock}=require(${JSON.stringify(path.join(repo,"dist/runtime/workspace-hooks.js"))});const {resolveRuntimePaths}=require(${JSON.stringify(path.join(repo,"dist/runtime/runtime-persistence.js"))});withWorkspaceSetupLock(resolveRuntimePaths(process.argv[1]),async()=>console.log('recovered'));`, f.home], { encoding: "utf8", timeout: 5000 });
    expect(retry.status, retry.stderr).toBe(0); expect(retry.stdout).toContain("recovered");
  } finally { if (child.exitCode === null && child.signalCode === null) { const exit = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exit; } }
}, 12000);
