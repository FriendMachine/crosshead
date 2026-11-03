import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveClaudeCodeBinaryPath,
  resolveClaudeCodeHostHome,
  resolveCodexHostHome,
  resolveOnlyBotsHome,
  resolveDefaultRuntimeHome,
} from "../../src/runtime/runtime-env";

const ENV_KEYS = ["CROSSHEAD_HOME", "ONLYBOTS_HOME", "ONLYBOTS_RUNTIME_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_HOME", "CLAUDE_CODE_BIN"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("runtime-env resolution", () => {
  it("prefers an explicit home argument over any environment variable", () => {
    process.env.ONLYBOTS_HOME = "/env/onlybots";
    expect(resolveOnlyBotsHome("/explicit/home")).toBe(path.resolve("/explicit/home"));
  });

  it("resolves ONLYBOTS_HOME ahead of ONLYBOTS_RUNTIME_HOME when both are set", () => {
    process.env.ONLYBOTS_HOME = "/env/onlybots-home";
    process.env.ONLYBOTS_RUNTIME_HOME = "/env/onlybots-runtime-home";
    expect(resolveOnlyBotsHome()).toBe(path.resolve("/env/onlybots-home"));
  });

  it("falls back to ONLYBOTS_RUNTIME_HOME, then the home directory default", () => {
    process.env.ONLYBOTS_RUNTIME_HOME = "/env/onlybots-runtime-home";
    expect(resolveOnlyBotsHome()).toBe(path.resolve("/env/onlybots-runtime-home"));

    delete process.env.ONLYBOTS_RUNTIME_HOME;
    expect(resolveOnlyBotsHome()).toBe(resolveDefaultRuntimeHome(os.homedir()));
  });

  it("resolves host homes from their dedicated environment variables", () => {
    process.env.CODEX_HOME = "/env/codex";
    process.env.CLAUDE_CODE_HOME = "/env/claude";
    expect(resolveCodexHostHome()).toBe(path.resolve("/env/codex"));
    expect(resolveClaudeCodeHostHome()).toBe(path.resolve("/env/claude"));

    delete process.env.CODEX_HOME;
    delete process.env.CLAUDE_CODE_HOME;
    expect(resolveCodexHostHome()).toBe(path.resolve(path.join(os.homedir(), ".codex")));
    expect(resolveClaudeCodeHostHome()).toBe(path.resolve(path.join(os.homedir(), ".claude")));
  });

  it("resolves the claude binary from the explicit argument, env var, then default", () => {
    expect(resolveClaudeCodeBinaryPath("/usr/local/bin/claude-custom")).toBe("/usr/local/bin/claude-custom");
    process.env.CLAUDE_CODE_BIN = "/opt/claude";
    expect(resolveClaudeCodeBinaryPath()).toBe("/opt/claude");
    delete process.env.CLAUDE_CODE_BIN;
    expect(resolveClaudeCodeBinaryPath()).toBe("claude");
  });

  it("respects direnv's Claude config directory ahead of the legacy adapter alias", () => {
    process.env.CLAUDE_CONFIG_DIR = "/work/.claude";
    process.env.CLAUDE_CODE_HOME = "/personal/.claude";
    expect(resolveClaudeCodeHostHome()).toBe(path.resolve("/work/.claude"));
    expect(resolveClaudeCodeHostHome("/explicit/.claude")).toBe(path.resolve("/explicit/.claude"));
    process.env.CLAUDE_CONFIG_DIR = "";
    expect(resolveClaudeCodeHostHome()).toBe(path.resolve("/personal/.claude"));
  });
});

it("keeps existing identities and refuses to choose between separate homes", () => {
 const base = mkdtempSync(path.join(os.tmpdir(), "crosshead-home-"));
 try {
  expect(resolveDefaultRuntimeHome(base)).toBe(path.join(base, ".crosshead"));
  mkdirSync(path.join(base, ".onlybots"));
  expect(resolveDefaultRuntimeHome(base)).toBe(path.join(base, ".onlybots"));
  symlinkSync(path.join(base, ".onlybots"), path.join(base, ".crosshead"));
  expect(resolveDefaultRuntimeHome(base)).toBe(path.join(base, ".crosshead"));
  rmSync(path.join(base, ".crosshead")); mkdirSync(path.join(base, ".crosshead"));
  expect(() => resolveDefaultRuntimeHome(base)).toThrow("separate installations");
  process.env.CROSSHEAD_HOME = path.join(base, "explicit");
  expect(resolveOnlyBotsHome()).toBe(path.join(base, "explicit"));
 } finally { rmSync(base, { recursive: true, force: true }); }
});
