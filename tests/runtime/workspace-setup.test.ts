import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { stopDetachedRuntimeDaemon } from "../../src/runtime/local-runtime";
import { readDaemonOwnershipState } from "../../src/runtime/daemon-ownership";
import { saveCheckpointPages } from "../../src/runtime/checkpoint-pages";
import { resolveRuntimePaths, loadRuntimeConfig } from "../../src/runtime/runtime-persistence";

const cliScript = path.resolve(__dirname, "../../dist/runtime/cli.js");
const localEndpoint = "http://127.0.0.1:0";

it("previews and verifies the installed hooks across two projects and profiles", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "crosshead-workspaces-")));
  const home = path.join(root, "runtime");
  const codexHome = path.join(root, "codex");
  const claudeHome = path.join(root, "claude");
  const projectA = path.join(root, "repo A's checkout");
  const projectB = path.join(root, "repo B");
  const outside = path.join(root, "unselected");
  const subdirectory = path.join(projectA, "src");
  const nestedRepo = path.join(projectA, "nested");
  const env = {
    PATH: process.env.PATH,
    CROSSHEAD_PROFILE: "default",
    CROSSHEAD_CAPTURE_SOURCE_EVIDENCE: "1",
    CROSSHEAD_HOOK_AUTOSTART: "0",
  };
  const cli = (...args: string[]) => {
    const run = spawnSync(process.execPath, [cliScript, ...args, "--home", home], { env, encoding: "utf8", timeout: 10000 });
    expect(run.status, run.stderr || run.stdout || String(run.error)).toBe(0);
    return run.stdout;
  };
  const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  const check = (directory: string) => JSON.parse(cli("workspace", "check", "--workspace-root", directory, "--json"));
  const configFor = (host: string, directory: string) => path.join(directory, host === "codex" ? ".codex/hooks.json" : ".claude/settings.local.json");
  const hook = (file: string, event: string) => readJson(file).hooks[event].at(-1).hooks[0].command as string;
  const invoke = (command: string, cwd: string, payload: Record<string, unknown>) => {
    const run = spawnSync("sh", ["-c", command], { cwd, env, input: JSON.stringify({ cwd, ...payload }), encoding: "utf8", timeout: 10000 });
    expect(run.stderr).toBe("");
    expect(run.status, String(run.error)).toBe(0);
    return run.stdout;
  };
  const common = ["--codex-home", codexHome, "--claude-home", claudeHome];
  try {
    for (const dir of [codexHome, claudeHome, path.join(projectA, ".git"), path.join(projectB, ".git"), subdirectory, path.join(nestedRepo, ".git"), outside]) {
      mkdirSync(dir, { recursive: true });
    }
    for (const project of [projectA, projectB, nestedRepo, outside]) {
      mkdirSync(path.join(project, ".git"), { recursive: true });
      writeFileSync(path.join(project, ".git/HEAD"), "ref: refs/heads/main\n");
    }
    cli("keygen", "--setup", "--profile", "default", "--api-base", localEndpoint);
    const global = path.join(codexHome, "hooks.json");
    const foreignHook = { type: "command", command: `printf '%s' '${home}/bin/onlybots-codex-hook'` };
    const otherRuntime = { type: "command", command: `'${home}/bin/onlybots-codex-hook' SessionStart --home '${root}/other-runtime'` };
    const legacy = `'${home}/bin/onlybots-codex-hook' SessionStart --home '${home}' --codex-home '${codexHome}'`;
    const customHook = { type: "command", command: `${legacy} && printf 'keep custom action'` };
    const globalText = JSON.stringify({ description: "keep me", hooks: { SessionStart: [{ hooks: [
      foreignHook, otherRuntime, customHook, { type: "command", command: legacy },
    ] }] } });
    writeFileSync(global, globalText);
    const firstSetup = [
      "quickstart", "--scope", "project", "--adapter", "both", "--workspace-root", subdirectory,
      "--profile", "a", "--api-base", localEndpoint, "--port", "0", ...common, "--json",
    ];
    const preview = JSON.parse(cli(...firstSetup, "--dry-run"));
    expect(preview.applied).toBe(false);
    expect(preview.newProfiles).toEqual(["a"]);
    expect(preview.bindings).toHaveLength(2);
    expect(preview.bindings.every((binding: { root: string }) => binding.root === projectA)).toBe(true);
    expect(preview.replacesUserHooksIn).toEqual([global]);
    expect(readFileSync(global, "utf8")).toBe(globalText);
    expect(existsSync(configFor("codex", projectA))).toBe(false);
    expect(existsSync(path.join(home, "config/profiles/a.json"))).toBe(false);

    expect(JSON.parse(cli(...firstSetup)).applied).toBe(true);
    expect(readJson(global)).toEqual({ description: "keep me", hooks: { SessionStart: [{ hooks: [foreignHook, otherRuntime, customHook] }] } });
    expect(check(projectA).bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ host: "codex", profile: "a", configured: true, startup: null, resume: null }),
      expect.objectContaining({ host: "claude-code", profile: "a", configured: true, startup: null, resume: null }),
    ]));
    cli("keygen", "--setup", "--profile", "b", "--api-base", localEndpoint, "--no-default");
    cli("workspace", "add", "--workspace-root", projectB, "--adapter", "codex", "--profile", "b", ...common);
    cli("workspace", "add", "--workspace-root", projectB, "--adapter", "claude-code", "--profile", "a", ...common);
    expect(loadRuntimeConfig(resolveRuntimePaths(home)).defaultProfile).toBe("default");

    const aCodex = configFor("codex", projectA);
    const aClaude = configFor("claude-code", projectA);
    const bCodex = configFor("codex", projectB);
    const startA = hook(aCodex, "SessionStart");
    invoke(startA, subdirectory, { source: "startup", session_id: "a-codex" });
    invoke(hook(aCodex, "UserPromptSubmit"), subdirectory, { session_id: "a-codex", turn_id: "one", prompt: "Repair the queue" });
    const eventFile = path.join(home, "state/lifecycle-events.jsonl");
    const beforeTool = readFileSync(eventFile, "utf8");
    invoke(hook(aCodex, "PostToolUse"), subdirectory, {
      session_id: "a-codex", turn_id: "one", tool_name: "Read",
      tool_input: { file_path: path.join(projectA, "rules.md") },
      tool_response: { type: "text", file: { filePath: path.join(projectA, "rules.md"), content: "Source excerpts are disabled for this binding." } },
    });
    expect(readFileSync(eventFile, "utf8")).toBe(beforeTool);
    const finding = "Keep the queue ordered by the original receipt ID.";
    invoke(hook(aCodex, "Stop"), subdirectory, { session_id: "a-codex", turn_id: "one", summary: finding });
    await vi.waitFor(() => expect(cli("memory", "hot", "--profile", "a", "--json")).toContain(finding), { timeout: 6000, interval: 200 });
    expect(cli("memory", "hot", "--profile", "b", "--json")).not.toContain(finding);
    expect(cli("memory", "search", "queue receipt", "--profile", "a", "--json")).toContain(finding);
    expect(cli("memory", "search", "queue receipt", "--profile", "b", "--json")).not.toContain(finding);
    const pageKey = saveCheckpointPages(home, "codex", `repo:${projectA}`, ["First saved page", "Further saved source observations"]);
    expect(cli("checkpoint-page", "2", "--runtime", "codex", "--key", pageKey)).toContain("Further saved source observations");
    invoke(hook(aClaude, "SessionStart"), projectA, { source: "startup", session_id: "a-claude" });
    const aContext = invoke(hook(aClaude, "UserPromptSubmit"), projectA, { session_id: "a-claude", prompt: "Continue the queue repair" });
    expect(aContext).toContain("profile=a");
    expect(aContext).toContain(finding);
    expect(aContext).not.toContain("bounded workspace file-read evidence");
    invoke(startA, projectA, { source: "resume", session_id: "a-codex" });
    invoke(hook(bCodex, "SessionStart"), projectB, { source: "startup", session_id: "b-codex" });
    const bContext = invoke(hook(bCodex, "UserPromptSubmit"), projectB, { session_id: "b-codex", prompt: "Continue the queue repair" });
    expect(bContext).toContain("profile=b");
    expect(bContext).not.toContain(finding);
    const sameProfileContext = invoke(hook(configFor("claude-code", projectB), "UserPromptSubmit"), projectB, {
      session_id: "b-claude", prompt: "Continue the queue repair",
    });
    expect(sameProfileContext).toContain("profile=a");
    expect(sameProfileContext).not.toContain(finding);
    expect(check(projectA).bindings.find((binding: { host: string }) => binding.host === "codex")).toMatchObject({
      startup: { profile: "a", workspaceRoot: projectA },
      resume: { profile: "a", workspaceRoot: projectA },
    });
    expect(check(outside).bindings).toEqual([]);
    expect(check(nestedRepo).bindings).toEqual([]);
    const events = path.join(home, "state/lifecycle-events.jsonl");
    const before = readFileSync(events, "utf8");
    expect(invoke(startA, outside, { source: "startup", session_id: "outside" })).toBe("");
    expect(invoke(startA, nestedRepo, { source: "startup", session_id: "nested" })).toBe("");
    expect(invoke(`'${home}/bin/crosshead-codex-hook' SessionStart --via plugin --home '${home}'`, outside, { source: "startup" })).toBe("");
    cli("memory", "mode", "off", "--profile", "a");
    expect(invoke(hook(aClaude, "UserPromptSubmit"), projectA, { session_id: "a-claude", prompt: "Continue the queue repair" })).toBe("");
    expect(invoke(hook(aCodex, "Stop"), projectA, { session_id: "a-codex", summary: "Do not save this" })).toBe("");
    expect(readFileSync(events, "utf8")).toBe(before);

    cli("workspace", "remove", "--workspace-root", projectA, ...common);
    expect(check(projectA).bindings).toEqual([]);
    expect(check(projectB).bindings).toHaveLength(2);
    expect(invoke(startA, projectA, { source: "resume", session_id: "a-codex" })).toBe("");
    expect(readFileSync(events, "utf8")).toBe(before);

    cli("workspace", "add", "--workspace-root", projectB, "--adapter", "codex", "--profile", "b", "--source-excerpts", "on", ...common);
    invoke(hook(bCodex, "SessionStart"), projectB, { source: "startup", session_id: "capture-on" });
    invoke(hook(bCodex, "UserPromptSubmit"), projectB, { session_id: "capture-on", turn_id: "capture", prompt: "Inspect the selected project" });
    const toolOutput = "Selected workspace source text for the opted-in capture.";
    invoke(hook(bCodex, "PostToolUse"), projectB, {
      session_id: "capture-on", turn_id: "capture", tool_name: "Read",
      tool_input: { file_path: path.join(projectB, "rules.md") },
      tool_response: { type: "text", file: { filePath: path.join(projectB, "rules.md"), content: toolOutput } },
    });
    expect(readFileSync(events, "utf8")).toContain(toolOutput);

    cli("quickstart", "--scope", "all", "--adapter", "codex", "--profile", "b", "--no-start", ...common);
    expect(check(outside).bindings).toHaveLength(1);
    invoke(hook(global, "SessionStart"), outside, { source: "startup", session_id: "global" });
    expect(check(outside).bindings[0].startup).toMatchObject({ profile: "b", workspaceRoot: outside });
    cli("quickstart", "--scope", "manual", "--profile", "b", "--no-start", ...common);
    expect(check(outside)).toMatchObject({ scope: "manual", bindings: [] });
    expect(readJson(global).hooks.SessionStart[0].hooks).toEqual([foreignHook, otherRuntime, customHook]);
    cli("workspace", "add", "--workspace-root", projectB, "--adapter", "both", "--profile", "b", ...common);
    cli("uninstall", "codex", ...common);
    expect(check(projectB).bindings.map((binding: { host: string }) => binding.host)).toEqual(["claude-code"]);
    cli("uninstall");
    expect(existsSync(home)).toBe(false);
    expect(readJson(configFor("claude-code", projectB)).hooks).toEqual({});
  } finally {
    if (readDaemonOwnershipState(resolveRuntimePaths(home))) await stopDetachedRuntimeDaemon(home);
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
