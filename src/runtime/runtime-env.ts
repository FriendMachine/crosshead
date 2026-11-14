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

// An empty environment variable counts as unset, as it does for the installer
// and the plugin launcher (`${CROSSHEAD_HOME:-...}`).
const envValue = (name: string): string | undefined => process.env[name] || undefined;

export const resolveCrossheadProfile = (profile?: string): string | undefined =>
  profile ?? envValue("CROSSHEAD_PROFILE") ?? envValue("ONLYBOTS_PROFILE");

export const resolveCrossheadHome = (home?: string): string =>
  path.resolve(home ?? envValue("CROSSHEAD_HOME") ?? envValue("CROSSHEAD_RUNTIME_HOME") ?? envValue("ONLYBOTS_HOME") ?? envValue("ONLYBOTS_RUNTIME_HOME") ?? resolveDefaultRuntimeHome(os.homedir()));

export const resolveCodexHostHome = (hostHome?: string): string =>
  path.resolve(hostHome ?? envValue("CODEX_HOME") ?? path.join(os.homedir(), ".codex"));

export const resolveClaudeCodeHostHome = (hostHome?: string): string =>
  path.resolve(hostHome ?? envValue("CLAUDE_CONFIG_DIR") ?? envValue("CLAUDE_CODE_HOME") ?? path.join(os.homedir(), ".claude"));

export const resolveClaudeCodeBinaryPath = (binary?: string): string =>
  binary ?? process.env.CLAUDE_CODE_BIN ?? "claude";

/** @deprecated Use resolveCrossheadHome. */
export const resolveOnlyBotsHome = resolveCrossheadHome;
