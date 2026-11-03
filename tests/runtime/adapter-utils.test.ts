import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";

import {
  buildWrapperScript,
  createWorkspaceManifest,
  extractContinuityPolicyRef,
  isManagedHookCommand,
  renderInjectedPrompt,
  shellQuote,
  summarizeHotMemory,
  writeManagedFile,
} from "../../src/runtime/adapter-utils";
import { ClaudeCodeRuntimeAdapter, renderClaudeLaunchWrapper, runCommandCapture } from "../../src/runtime/claude-code-adapter";
import { CodexRuntimeAdapter, renderCodexLaunchWrapper } from "../../src/runtime/codex-adapter";
import { HostRuntimeAdapterBase } from "../../src/runtime/host-adapter-base";
import { ensureEnvrcOnlyBotsBlock, hardenOmpExtensionSource, OMP_INSTALLED_EXTENSION_SOURCE } from "../../src/runtime/omp-adapter";
import { OMP_EXTENSION_SOURCE } from "../../src/runtime/omp-extension-template";

describe("adapter-utils", () => {
  it.each(["OnlyBots", "Crosshead"])("strips %s context from resumed OMP turns", (brand) => {
    const prelude = OMP_EXTENSION_SOURCE.slice(
      OMP_EXTENSION_SOURCE.indexOf("const ONLYBOTS_CONTEXT_PREFIX"),
      OMP_EXTENSION_SOURCE.indexOf("const trace ="),
    );
    const strip = runInNewContext(`${prelude}\nstripInjectedContextFromText`) as (text: string) => string;
    expect(strip(`${brand} runtime context for this Pi-compatible turn:\nold context\n\nCurrent Pi-compatible user request:\ncontinue`)).toBe("continue");
    expect(strip("ordinary user request")).toBe("ordinary user request");
  });

  it("keeps hosted lifecycle fields out of installed OMP prompts", () => {
    expect(OMP_INSTALLED_EXTENSION_SOURCE).toContain("injectedContext: \"\"");
    expect(OMP_INSTALLED_EXTENSION_SOURCE).toContain("contextText = renderHotMemoryFallback(hotMemorySnapshot)");
    expect(OMP_INSTALLED_EXTENSION_SOURCE).not.toContain("injectedContext: baseContextText");
    expect(OMP_INSTALLED_EXTENSION_SOURCE).not.toContain("inbox: response?.inbox");
    expect(OMP_INSTALLED_EXTENSION_SOURCE).not.toContain("warnings,\n          injectedContext");
  });

  it("never loads startup code from an untrusted workspace", () => {
    expect(OMP_INSTALLED_EXTENSION_SOURCE).not.toContain(
      'path.join(workspaceRoot, "dist", "runtime", "startup-context.js")'
    );
    expect(OMP_INSTALLED_EXTENSION_SOURCE).toContain('runtimeWrapperStartupContextFile(home, "onlybotsctl")');
    expect(OMP_INSTALLED_EXTENSION_SOURCE).not.toContain("const direct = entry?.workspaceId");
  });

  it("pins installed OMP extensions to the selected runtime home", () => {
    const installed = hardenOmpExtensionSource(OMP_EXTENSION_SOURCE, "/trusted/runtime home");
    expect(installed).toContain('const resolveRuntimeHome = () => "/trusted/runtime home";');
    expect(installed).not.toContain("workspaceHome");
    expect(installed).not.toContain("repoHome");
    expect(installed).not.toContain("process.env.CROSSHEAD_HOME");
  });

  it("preserves existing OMP shell helpers when applying the renamed runtime", () => {
    const existing = "# OnlyBots shell helper fallbacks\nsource_up\n";
    const updated = ensureEnvrcOnlyBotsBlock(existing, "/tmp/runtime");
    expect(updated.match(/shell helper fallbacks/g)).toHaveLength(1);
    expect(ensureEnvrcOnlyBotsBlock(updated, "/tmp/runtime")).toBe(updated);
  });

  it("refuses managed writes through file or parent-directory symlinks", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "crosshead-managed-file-"));
    try {
      const root = path.join(fixture, "root");
      const outside = path.join(fixture, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      const outsideFile = path.join(outside, "victim.txt");
      writeFileSync(outsideFile, "unchanged");

      symlinkSync(outsideFile, path.join(root, "linked-file"));
      expect(() => writeManagedFile(path.join(root, "linked-file"), "replaced", root)).toThrow("regular file");
      expect(readFileSync(outsideFile, "utf8")).toBe("unchanged");

      symlinkSync(outside, path.join(root, "linked-directory"));
      expect(() => writeManagedFile(path.join(root, "linked-directory", "created.txt"), "created", root)).toThrow(
			"parent must not be a symlink"
      );
      expect(existsSync(path.join(outside, "created.txt"))).toBe(false);

      const ordinary = path.join(root, "nested", "managed.txt");
      writeManagedFile(ordinary, "managed", root);
      expect(readFileSync(ordinary, "utf8")).toBe("managed");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  describe("extractContinuityPolicyRef", () => {
    it("reads the policy version from the daemon status continuity shape", () => {
      // Regression: the claude-code adapter previously only read top-level policyRef keys,
      // which never exist on the daemon's RuntimeContinuityInspection, so it always
      // captured policyRef: null while the codex adapter captured the real version.
      const daemonStatusContinuity = {
        source: "file",
        validationErrors: [],
        policy: { policyVersion: "continuity_policy_v1:sha256:abc" },
      };
      expect(extractContinuityPolicyRef(daemonStatusContinuity)).toBe("continuity_policy_v1:sha256:abc");
    });

    it("prefers explicit policyRef keys when present", () => {
      expect(extractContinuityPolicyRef({ policyRef: "explicit-ref" })).toBe("explicit-ref");
      expect(extractContinuityPolicyRef({ policy_ref: "snake-ref" })).toBe("snake-ref");
      expect(
        extractContinuityPolicyRef({ policyRef: "explicit-ref", policy: { policyVersion: "nested" } })
      ).toBe("explicit-ref");
    });

    it("returns null for non-object input or missing policy data", () => {
      expect(extractContinuityPolicyRef(null)).toBeNull();
      expect(extractContinuityPolicyRef("policy")).toBeNull();
      expect(extractContinuityPolicyRef([])).toBeNull();
      expect(extractContinuityPolicyRef({ policy: { policyVersion: "   " } })).toBeNull();
      expect(extractContinuityPolicyRef({ policy: "not-an-object" })).toBeNull();
    });
  });

  describe("renderInjectedPrompt", () => {
    it("returns the prompt unchanged when there is no context", () => {
      expect(renderInjectedPrompt("do the thing", "   ", "Codex")).toBe("do the thing");
    });

    it("labels the request with the host runtime name", () => {
      const injected = renderInjectedPrompt("do the thing", "ctx", "Claude Code");
      expect(injected).toContain("Crosshead runtime context:\nctx");
      expect(injected).toContain("Current Claude Code request:\ndo the thing");
    });
  });

  describe("buildWrapperScript", () => {
    it("emits a plain wrapper without env exports", () => {
      const script = buildWrapperScript("/opt/bridge.js");
      expect(script).toContain(`${shellQuote(process.execPath)} '/opt/bridge.js' "$@"`);
      expect(script).toContain("unset NODE_OPTIONS NODE_PATH");
      expect(script).not.toContain("export ONLYBOTS_HOME");
    });

    it("pins the host and runtime homes when env exports are requested", () => {
      const script = buildWrapperScript("/opt/hook.js", {
        hostHomeVar: "CODEX_HOME",
        hostHome: "/home/u/.codex",
        runtimeHome: "/home/u/.onlybots",
      });
      expect(script).toContain("export CODEX_HOME='/home/u/.codex'");
      expect(script).toContain("export ONLYBOTS_HOME='/home/u/.onlybots'");
      expect(script).toContain("export ONLYBOTS_RUNTIME_HOME='/home/u/.onlybots'");
    });
  });

  describe("host launcher quoting", () => {
    it.each(["codex", "claude"].flatMap((host) =>
      ["unset", "empty", "installed", "other", "other-active", "other-legacy"].map((selection) => [host, selection]),
    ))(
      "preserves %s profile isolation with %s home selection",
      (host, selection) => {
	const fixture = mkdtempSync(path.join(os.tmpdir(), "crosshead-codex-launch-"));
	try {
	  const hostHome = path.join(fixture, "personal ' profile");
	  const otherHome = path.join(fixture, "work ' $(false) profile");
	  const runtimeHome = path.join(fixture, "runtime");
	  const codexBinary = path.join(fixture, "codex-stub");
	  const wrapper = path.join(fixture, "codex");
	  const updateMarker = path.join(fixture, "update-called");
	  mkdirSync(path.join(runtimeHome, "bin"), { recursive: true });
	  writeFileSync(path.join(runtimeHome, "bin", "onlybotsctl"),
	    `#!/usr/bin/env bash\ntouch ${shellQuote(updateMarker)}\n`, { mode: 0o755 });
	  writeFileSync(codexBinary, `#!/usr/bin/env bash
printf '%s\\n' "\${CODEX_HOME:-\${CLAUDE_CONFIG_DIR:-\${CLAUDE_CODE_HOME:-}}}" "\${CROSSHEAD_HOME:-}" "\${ONLYBOTS_HOME:-}" "\${ONLYBOTS_RUNTIME_HOME:-}" "$@"
`, { mode: 0o755 });
	  const common = { marker: "test", adapterVersion: "test", runtimeHome, hostHome,
	    profileName: "default", installedAt: "now", updatedAt: "now" };
	  writeFileSync(wrapper, host === "codex"
	    ? renderCodexLaunchWrapper({ ...common, adapterName: "codex", codexBinary, skillName: "test" })
	    : renderClaudeLaunchWrapper({ ...common, adapterName: "claude-code", claudeBinary: codexBinary, workspaceRoot: fixture }));
	  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
	  const other = selection.startsWith("other");
	  const homeVar = host === "codex" ? "CODEX_HOME" : selection === "other-legacy" ? "CLAUDE_CODE_HOME" : "CLAUDE_CONFIG_DIR";
	  if (selection !== "unset") env[homeVar] = other ? otherHome : selection === "empty" ? "" : hostHome;
	  if (host === "claude" && selection === "other") env.CLAUDE_CODE_HOME = hostHome;
	  if (selection === "other-active") env[host === "codex" ? "ONLYBOTS_CODEX_WRAPPER_ACTIVE" : "ONLYBOTS_CLAUDE_WRAPPER_ACTIVE"] = "1";
	  const args = ["resume", "a session", "--profile", "work"];
	  const output = execFileSync("bash", [wrapper, ...args], { env, encoding: "utf8" });
	  expect(output.trimEnd().split("\n")).toEqual(other
	    ? [otherHome, "", "", "", ...args]
	    : [hostHome, runtimeHome, runtimeHome, runtimeHome, ...(host === "codex" ? ["--enable", "hooks"] : []), ...args]);
	  expect(existsSync(updateMarker)).toBe(!other);
	} finally {
	  rmSync(fixture, { recursive: true, force: true });
	}
      },
    );

    it("quotes every configured Codex and Claude path as a single shell word", () => {
      const hostile = `/tmp/host'$(touch /tmp/crosshead-shell-injection)`;
      const common = { marker: "test", adapterVersion: "test", runtimeHome: hostile, hostHome: hostile,
		profileName: "default", installedAt: "now", updatedAt: "now" };
      const codex = renderCodexLaunchWrapper({ ...common, adapterName: "codex", codexBinary: hostile, skillName: "test" });
      const claude = renderClaudeLaunchWrapper({ ...common, adapterName: "claude-code", claudeBinary: hostile, workspaceRoot: "/work" });
      for (const script of [codex, claude]) {
		expect(script).toContain(shellQuote(hostile));
		expect(script).toContain(shellQuote(`${hostile}/bin/onlybotsctl`));
		expect(script).not.toContain(`exec "${hostile}"`);
      }
    });

    it("bounds captured host output", async () => {
      await expect(runCommandCapture(
			"/usr/bin/printf",
			["%s", "x".repeat(2048)],
			process.cwd(),
			1024
      )).rejects.toThrow("output exceeded");
    });
  });

  describe("createWorkspaceManifest", () => {
    it("parameterizes the runtime id and ipc mount name", () => {
      const claude = createWorkspaceManifest("/repo", "repo:/repo", "claude-code", "claude-code-wrapper");
      expect(claude.runtimeId).toBe("claude-code");
      expect(claude.ipcMounts[0]?.name).toBe("claude-code-runtime");

      const codex = createWorkspaceManifest("/repo", "repo:/repo", "codex", "codex-wrapper");
      expect(codex.runtimeId).toBe("codex");
      expect(codex.ipcMounts[0]?.name).toBe("codex-runtime");
    });
  });

  describe("isManagedHookCommand", () => {
    it("matches by wrapper path or hook marker", () => {
      expect(isManagedHookCommand("/x/bin/onlybots-claude-code-hook Stop", "/x/bin/hook", "onlybots-claude-code-hook")).toBe(true);
      expect(isManagedHookCommand("/x/bin/hook Stop", "/x/bin/hook", "onlybots-claude-code-hook")).toBe(true);
      expect(isManagedHookCommand("/y/user-hook", "/x/bin/hook", "onlybots-claude-code-hook")).toBe(false);
      expect(isManagedHookCommand(undefined, "/x/bin/hook", "onlybots-claude-code-hook")).toBe(false);
    });
  });

  describe("summarizeHotMemory", () => {
    it("summarizes structured hot memory fields", () => {
      const summary = summarizeHotMemory(
        JSON.stringify({ currentGoal: "ship it", latestTurn: { summary: "did things" }, summary: "overall" })
      );
      expect(summary).toBe("ship it | did things | overall");
    });

    it("falls back to normalized plain text and truncates at 280 chars", () => {
      expect(summarizeHotMemory("  plain\n\ntext  ")).toBe("plain text");
      const long = "x".repeat(400);
      expect(summarizeHotMemory(long)?.length).toBeLessThanOrEqual(280);
    });
  });
});

describe("host adapter base wiring", () => {
  it("both host adapters share the lifecycle base class", () => {
    expect(Object.getPrototypeOf(ClaudeCodeRuntimeAdapter.prototype)).toBe(HostRuntimeAdapterBase.prototype);
    expect(Object.getPrototypeOf(CodexRuntimeAdapter.prototype)).toBe(HostRuntimeAdapterBase.prototype);
  });

  it("exposes the same lifecycle and memory surface on both adapters", () => {
    const surface = [
      "sessionStarted",
      "sessionEnded",
      "prepareTurn",
      "completeTurn",
      "failTurn",
      "toolCompleted",
      "taskChanged",
      "compactStarted",
      "compactCompleted",
      "remember",
      "searchMemory",
      "exportMemory",
      "readHotMemory",
      "listWarmMemory",
    ] as const;
    for (const method of surface) {
      expect(typeof (ClaudeCodeRuntimeAdapter.prototype as Record<string, unknown>)[method], `claude-code ${method}`).toBe(
        "function"
      );
      expect(typeof (CodexRuntimeAdapter.prototype as Record<string, unknown>)[method], `codex ${method}`).toBe("function");
    }
  });
});
