import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { stopDetachedRuntimeDaemon } from "../../src/runtime/local-runtime";
import { readDaemonOwnershipState } from "../../src/runtime/daemon-ownership";
import { resolveRuntimePaths } from "../../src/runtime/runtime-persistence";

const cliScript = path.resolve(__dirname, "../../dist/runtime/cli.js");
const localEndpoint = "http://127.0.0.1:0";

it("keeps the all-projects default while nearer directory overrides choose the profile", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "crosshead-overrides-")));
  const home = path.join(root, "runtime");
  const codexHome = path.join(root, "codex");
  const claudeHome = path.join(root, "claude");
  const umbrella = path.join(root, "umbrella");
  const nestedRepo = path.join(umbrella, "apps", "service");
  const research = path.join(umbrella, "research");
  const subproject = path.join(research, "loom");
  const outside = path.join(root, "elsewhere");
  const env = { PATH: process.env.PATH, CROSSHEAD_HOOK_AUTOSTART: "0" };
  const run = (args: string[], cwd = root) =>
    spawnSync(process.execPath, [cliScript, ...args, "--home", home], { cwd, env, encoding: "utf8", timeout: 10000 });
  const cli = (args: string[], cwd = root) => {
    const result = run(args, cwd);
    expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(0);
    return result.stdout;
  };
  const check = (directory: string) => JSON.parse(cli(["workspace", "check", "--workspace-root", directory, "--json"]));
  const profileIn = (directory: string, host = "claude-code") =>
    check(directory).bindings.find((binding: { host: string }) => binding.host === host)?.profile;
  const common = ["--codex-home", codexHome, "--claude-home", claudeHome];
  try {
    for (const dir of [codexHome, claudeHome, path.join(subproject, "src"), outside]) mkdirSync(dir, { recursive: true });
    mkdirSync(nestedRepo, { recursive: true });
    expect(spawnSync("git", ["init", "-q", nestedRepo]).status).toBe(0);
    cli(["keygen", "--setup", "--profile", "default", "--api-base", localEndpoint]);
    for (const name of ["umbrella", "research", "loom"]) {
      cli(["keygen", "--setup", "--profile", name, "--api-base", localEndpoint, "--no-default"]);
    }
    cli(["quickstart", "--scope", "all", "--adapter", "both", "--profile", "default", "--port", "0", ...common]);
    const policyFile = path.join(home, "config/workspace-hooks.json");
    const policyBefore = readFileSync(policyFile, "utf8");
    const settingsBefore = readFileSync(path.join(claudeHome, "settings.json"), "utf8");

    const preview = JSON.parse(cli(["workspace", "profile", "set", "--workspace-root", umbrella, "--profile", "umbrella", "--dry-run", "--json"]));
    expect(preview.overrides).toEqual([{ root: umbrella, profile: "umbrella" }]);
    expect(preview.files).toEqual([policyFile]);
    expect(readFileSync(policyFile, "utf8")).toBe(policyBefore);

    cli(["workspace", "profile", "set", "--workspace-root", umbrella, "--profile", "umbrella"]);
    cli(["workspace", "profile", "set", "--workspace-root", research, "--profile", "research"]);
    cli(["workspace", "profile", "set", "--workspace-root", subproject, "--profile", "loom"]);
    // Host settings keep their hooks; only the Crosshead policy changes.
    expect(readFileSync(path.join(claudeHome, "settings.json"), "utf8")).toBe(settingsBefore);

    expect(profileIn(outside)).toBe("default");
    expect(profileIn(umbrella)).toBe("umbrella");
    expect(profileIn(nestedRepo)).toBe("umbrella");
    expect(profileIn(nestedRepo, "codex")).toBe("umbrella");
    expect(profileIn(research)).toBe("research");
    expect(profileIn(path.join(subproject, "src"))).toBe("loom");
    expect(check(path.join(subproject, "src")).override).toEqual({ root: subproject, profile: "loom" });

    const settings = JSON.parse(readFileSync(path.join(claudeHome, "settings.json"), "utf8"));
    const prompt = settings.hooks.UserPromptSubmit.at(-1).hooks[0].command as string;
    const invoke = (cwd: string) => {
      const result = spawnSync("sh", ["-c", prompt], { cwd, env, input: JSON.stringify({ cwd, session_id: "s", prompt: "Continue" }), encoding: "utf8", timeout: 10000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    expect(invoke(path.join(subproject, "src"))).toContain("profile=loom");
    expect(invoke(nestedRepo)).toContain("profile=umbrella");
    expect(invoke(outside)).toContain("profile=default");

    // Manual commands in an overridden directory use its profile unless one is chosen.
    expect(cli(["status", "--json"], subproject)).toContain('"loom"');
    expect(cli(["status", "--profile", "default", "--json"], subproject)).not.toContain('"loom"');

    cli(["workspace", "profile", "clear", "--workspace-root", subproject]);
    expect(profileIn(path.join(subproject, "src"))).toBe("research");
    const unknown = run(["workspace", "profile", "set", "--workspace-root", subproject, "--profile", "missing"]);
    expect(unknown.status).not.toBe(0);
    expect(run(["workspace", "profile", "set", "--workspace-root", path.parse(root).root, "--profile", "loom"]).status).not.toBe(0);

    cli(["workspace", "profile", "clear", "--workspace-root", umbrella]);
    cli(["workspace", "profile", "clear", "--workspace-root", research]);
    expect(readFileSync(policyFile, "utf8")).toBe(policyBefore);

    // A malformed override pauses hooks like any other damaged policy.
    writeFileSync(policyFile, JSON.stringify({ ...JSON.parse(policyBefore), overrides: [{ root: "relative", profile: "loom" }] }));
    expect(run(["workspace", "check", "--workspace-root", outside, "--json"]).stdout).toContain("Invalid Crosshead workspace hook settings");
  } finally {
    if (readDaemonOwnershipState(resolveRuntimePaths(home))) await stopDetachedRuntimeDaemon(home);
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
