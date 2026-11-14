import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import path from "path";

import type { OperatorWorkspaceManifest } from "./operator-policy";

// Shared helpers for the host runtime adapters (claude-code, codex, pi). These were
// previously duplicated per adapter, which let bug fixes land in one runtime and not the
// others; runtime-specific differences are expressed as parameters instead.

export const nowIso = (): string => new Date().toISOString();

export const sanitizeString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export const summarizeHotMemory = (value: unknown): string | null => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const fields = [
      sanitizeString(parsed.currentGoal),
      parsed.latestTurn && typeof parsed.latestTurn === "object" && !Array.isArray(parsed.latestTurn)
        ? sanitizeString((parsed.latestTurn as Record<string, unknown>).summary)
        : null,
      sanitizeString(parsed.summary),
    ].filter((entry): entry is string => entry !== null);
    if (fields.length > 0) {
      return fields.join(" | ").slice(0, 280);
    }
  } catch {
    // Raw string hot-memory content is still usable.
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 280 ? normalized : `${normalized.slice(0, 277).trimEnd()}...`;
};

export const summarizeJudgmentEntries = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? sanitizeString((entry as Record<string, unknown>).summary)
            : sanitizeString(entry)
        )
        .filter((entry): entry is string => entry !== null)
    : [];

export const listWarmIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? sanitizeString((entry as Record<string, unknown>).id)
            : null
        )
        .filter((entry): entry is string => entry !== null)
    : [];

// The daemon status endpoint reports continuity as a RuntimeContinuityInspection, whose
// version lives at continuity.policy.policyVersion. The direct policyRef/policy_ref keys
// are kept for explicitly provided policy objects. (The claude-code adapter previously
// only read the direct keys, so it always captured policyRef: null from daemon status.)
export const extractContinuityPolicyRef = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const continuity = value as Record<string, unknown>;
  const direct = sanitizeString(continuity.policyRef ?? continuity.policy_ref);
  if (direct) {
    return direct;
  }
  if (continuity.policy && typeof continuity.policy === "object" && !Array.isArray(continuity.policy)) {
    return sanitizeString((continuity.policy as Record<string, unknown>).policyVersion);
  }
  return null;
};

export const parseArgs = (args: string[]): { positionals: string[]; flags: Record<string, string | boolean> } => {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals > 2) {
      flags[value.slice(2, equals)] = value.slice(equals + 1);
      continue;
    }
    const key = value.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return { positionals, flags };
};

export const assertManagedFilePath = (filePath: string, managedRoot: string): void => {
  const root = path.resolve(managedRoot);
  const target = path.resolve(filePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Managed file must remain under its declared root");
  }

  let current = root;
  for (const segment of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Managed file parent must not be a symlink or non-directory");
    }
  }
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Managed file target must be a regular file");
    }
  }
};

export const writeManagedFile = (
  filePath: string,
  content: string | NodeJS.ArrayBufferView,
  managedRoot: string
): void => {
  assertManagedFilePath(filePath, managedRoot);
  const target = path.resolve(filePath);

  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const staged = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    writeFileSync(descriptor, content, "utf8");
    closeSync(descriptor);
    descriptor = null;
    renameSync(staged, target);
    chmodSync(target, 0o600);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(staged, { force: true });
  }
};

export const isManagedHookCommand = (
  command: string | undefined,
  hookWrapperPath: string,
  hookMarker: string
): boolean => typeof command === "string" && (command.includes(hookWrapperPath) || command.includes(hookMarker));

export const renderInjectedPrompt = (prompt: string, contextText: string, requestLabel: string): string =>
  contextText.trim().length === 0
    ? prompt
    : `Crosshead runtime context:\n${contextText.trim()}\n\nCurrent ${requestLabel} request:\n${prompt}`;

export type WrapperEnvExports = {
  hostHomeVar: string;
  hostHome: string;
  runtimeHome: string;
};

export const buildWrapperScript = (scriptPath: string, env?: WrapperEnvExports, marker?: string): string => `#!/usr/bin/env bash
${marker ? `# ${marker}\n` : ""}set -euo pipefail
unset NODE_OPTIONS NODE_PATH
${
  env
    ? `export ${env.hostHomeVar}=${shellQuote(env.hostHome)}
export ONLYBOTS_HOME=${shellQuote(env.runtimeHome)}
export CROSSHEAD_HOME="$ONLYBOTS_HOME"
export ONLYBOTS_RUNTIME_HOME=${shellQuote(env.runtimeHome)}
`
    : ""
}
${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"
`;

export const createWorkspaceManifest = (
  workspaceRoot: string,
  workspaceId: string,
  runtimeId: string,
  hostVersion: string
): OperatorWorkspaceManifest => ({
  manifestVersion: "1",
  tenantId: "local-operator",
  workspaceId,
  runClass: "interactive",
  runtimeId,
  runtimeVersion: hostVersion,
  workspaceRoot,
  readOnlyMounts: [
    {
      name: "workspace",
      sourcePath: workspaceRoot,
      targetPath: "/workspace",
    },
  ],
  scratchMounts: [
    {
      name: "scratch",
      targetPath: "/scratch",
    },
  ],
  stateMounts: [
    {
      name: "state",
      targetPath: "/state",
    },
  ],
  ipcMounts: [
    {
      name: `${runtimeId}-runtime`,
      targetPath: "/ipc",
    },
  ],
  requestedSecretRefs: ["nostr_identity", "onlybots_session"],
  requestedAt: nowIso(),
});
