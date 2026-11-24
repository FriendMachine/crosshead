import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateRuntimeIdentity, installRuntimeCore, setupRuntimeProfile, stopDetachedRuntimeDaemon } from "../../src/runtime/local-runtime";
import { readDaemonOwnershipState } from "../../src/runtime/daemon-ownership";
import { resolveRuntimePaths } from "../../src/runtime/runtime-persistence";
import { writeLocalHotMemory } from "../../src/runtime/local-hot-memory";
import { inspectWorkspaceHooks } from "../../src/runtime/workspace-hooks";

// End to end through the installed hook commands and a real daemon: a checkpoint
// reaches a session once, and again after compaction or a session start.
const repo = path.resolve(__dirname, "../..");
const cliFile = path.join(repo, "dist/runtime/cli.js");
const daemonFile = path.join(repo, "dist/runtime/daemon.js");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("hot checkpoint delivery through installed hooks", () => {
  it("sends a checkpoint once per session and again after compaction or a session start, on both hosts", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "xhd-delivery-"))); dirs.push(root);
    const home = path.join(root, "runtime"), project = path.join(root, "project");
    const codexHome = path.join(root, "codex"), claudeHome = path.join(root, "claude");
    for (const dir of [project, codexHome, claudeHome]) mkdirSync(dir, { recursive: true });
    const env = { PATH: process.env.PATH!, TMPDIR: tmpdir(), CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, CROSSHEAD_HOOK_AUTOSTART: "0" };
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, [cliFile, ...args, "--home", home], { cwd: project, env, encoding: "utf8", timeout: 12000 });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      return result.stdout;
    };
    const invoke = (host: "codex" | "claude-code", event: string, payload: object): string => {
      const file = inspectWorkspaceHooks(home, project).bindings.find(binding => binding.host === host)!.file;
      const command = JSON.parse(readFileSync(file, "utf8")).hooks[event].at(-1).hooks[0].command;
      const result = spawnSync("sh", ["-c", command], { cwd: project, env, input: JSON.stringify({ cwd: project, ...payload }), encoding: "utf8", timeout: 10000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    const paths = resolveRuntimePaths(home);
    await setupRuntimeProfile({ home, profileName: "work", apiBase: "http://127.0.0.1:0", ...generateRuntimeIdentity(), makeDefault: false });
    await installRuntimeCore({ home, cliScriptPath: cliFile, daemonScriptPath: daemonFile });
    const requirement = "Existing invoice requirements use integer cents and round half up.";
    writeLocalHotMemory(paths.state, JSON.stringify({ runtime: "codex", continuityCheckpoints: [{
      runtime: "codex", workspaceId: null, sessionId: "old", turnId: "old", goal: "invoice requirements", summary: requirement, occurredAt: new Date().toISOString(),
    }] }), "codex");
    try {
      cli("quickstart", "--scope", "project", "--adapter", "both", "--profile", "work", "--workspace-root", project, "--codex-home", codexHome, "--claude-home", claudeHome, "--port", "0", "--json");
      for (const host of ["codex", "claude-code"] as const) {
        const session = `${host}-session`;
        const prompt = (text = "Continue invoice requirements") => invoke(host, "UserPromptSubmit", { session_id: session, prompt: text });
        invoke(host, "SessionStart", { source: "startup", session_id: session });
        expect(prompt()).toContain(requirement);
        const again = prompt();
        expect(again).not.toContain(requirement);
        expect(again).not.toContain("capture your final response");
        // Automatic compaction (Claude Code skips its other work for it) still resets delivery.
        invoke(host, "PreCompact", { session_id: session, trigger: "auto" });
        expect(prompt()).toContain(requirement);
        expect(prompt()).not.toContain(requirement);
        invoke(host, "SessionStart", { source: "resume", session_id: session });
        expect(prompt()).toContain(requirement);
      }
    } finally { if (readDaemonOwnershipState(paths)) await stopDetachedRuntimeDaemon(home); }
  }, 120000);
});
