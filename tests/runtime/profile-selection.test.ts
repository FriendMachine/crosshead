import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCodexAdapterConfig } from "../../src/runtime/codex-adapter";
import { loadClaudeCodeAdapterConfig } from "../../src/runtime/claude-code-adapter";
import { runOnlyBotsCtlCli } from "../../src/runtime/cli";
import { resolveCrossheadProfile } from "../../src/runtime/runtime-env";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project profile selection", () => {
  it("prefers explicit profiles, then the canonical environment variable, then the legacy alias", () => {
    vi.stubEnv("CROSSHEAD_PROFILE", "crosshead");
    vi.stubEnv("ONLYBOTS_PROFILE", "legacy");
    expect(resolveCrossheadProfile("explicit")).toBe("explicit");
    expect(resolveCrossheadProfile()).toBe("crosshead");
    vi.stubEnv("CROSSHEAD_PROFILE", "");
    expect(resolveCrossheadProfile()).toBe("legacy");
    vi.stubEnv("ONLYBOTS_PROFILE", "");
    expect(resolveCrossheadProfile()).toBeUndefined();
  });

  it.each([
    ["codex", "__onlybots_codex_adapter__", loadCodexAdapterConfig],
    ["claude-code", "__onlybots_claude_code_adapter__", loadClaudeCodeAdapterConfig],
  ] as const)("selects the environment profile for installed %s hooks without rewriting saved config", (host, marker, load) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "crosshead-profile-"));
    roots.push(root);
    mkdirSync(path.join(root, "onlybots"));
    const file = path.join(root, "onlybots", `${host}-adapter.json`);
    const saved = JSON.stringify({ marker, profileName: "default", runtimeHome: "/saved-runtime", hostHome: root });
    writeFileSync(file, saved);
    vi.stubEnv("CROSSHEAD_PROFILE", "crosshead");
    vi.stubEnv("ONLYBOTS_PROFILE", "legacy");
    expect(load(undefined, root)).toMatchObject({ profileName: "crosshead", runtimeHome: "/saved-runtime" });
    expect(load("/explicit-runtime", root)).toMatchObject({ profileName: "crosshead", runtimeHome: "/explicit-runtime" });
    vi.stubEnv("CROSSHEAD_PROFILE", "");
    expect(load(undefined, root).profileName).toBe("legacy");
    vi.stubEnv("ONLYBOTS_PROFILE", "");
    expect(load(undefined, root).profileName).toBe("default");
    expect(readFileSync(file, "utf8")).toBe(saved);
  });

  it("passes the environment profile through the CLI while preserving an explicit --profile", async () => {
    vi.stubEnv("CROSSHEAD_PROFILE", "crosshead");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const probe = vi.fn(async () => "ok");
    await runOnlyBotsCtlCli(["probe"], { commands: { probe } });
    expect(probe).toHaveBeenLastCalledWith(["--profile", "crosshead"]);
    await runOnlyBotsCtlCli(["probe", "--profile", "explicit"], { commands: { probe } });
    expect(probe).toHaveBeenLastCalledWith(["--profile", "explicit"]);
  });
});
