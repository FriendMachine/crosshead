import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Explicit arguments win, then CROSSHEAD_HOME, then the legacy environment aliases.
// Managed launchers bind all aliases to one home. Preserve existing identities;
// separate populated homes require an explicit choice instead of silent migration.

export const resolveDefaultRuntimeHome = (userHome: string): string => {
  const current = path.join(userHome, ".crosshead");
  const legacy = path.join(userHome, ".onlybots");
  if (existsSync(current) && existsSync(legacy) && realpathSync(current) !== realpathSync(legacy)) {
    throw new Error("Both ~/.crosshead and ~/.onlybots contain separate installations. Choose one with CROSSHEAD_HOME or --home; no state was moved.");
  }
  return existsSync(current) ? current : existsSync(legacy) ? legacy : current;
};

export const resolveCrossheadHome = (home?: string): string =>
  path.resolve(home ?? process.env.CROSSHEAD_HOME ?? process.env.CROSSHEAD_RUNTIME_HOME ?? process.env.ONLYBOTS_HOME ?? process.env.ONLYBOTS_RUNTIME_HOME ?? resolveDefaultRuntimeHome(os.homedir()));

export const resolveCodexHostHome = (hostHome?: string): string =>
  path.resolve(hostHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));

export const resolveClaudeCodeHostHome = (hostHome?: string): string =>
  path.resolve(hostHome ?? (process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CODE_HOME) ?? path.join(os.homedir(), ".claude"));

export const resolveClaudeCodeBinaryPath = (binary?: string): string =>
  binary ?? process.env.CLAUDE_CODE_BIN ?? "claude";

/** @deprecated Use resolveCrossheadHome. */
export const resolveOnlyBotsHome = resolveCrossheadHome;
