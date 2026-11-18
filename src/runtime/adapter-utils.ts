import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
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
import { selectHotCheckpoints } from "./hot-continuity";
import { IMPORTED_HANDOFF_TURN_PREFIX } from "./handoff-import";
import { compactContinuitySummary } from "./summary-compaction";

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
    const checkpoints = Array.isArray(parsed.continuityCheckpoints)
      ? parsed.continuityCheckpoints.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
      : null;
    const latestCheckpoint = checkpoints?.sort((a, b) =>
      (Date.parse(String(b.occurredAt)) || 0) - (Date.parse(String(a.occurredAt)) || 0))[0];
    const fields = [
      sanitizeString(parsed.currentGoal),
      parsed.latestTurn && typeof parsed.latestTurn === "object" && !Array.isArray(parsed.latestTurn)
        ? sanitizeString((parsed.latestTurn as Record<string, unknown>).summary)
        : null,
      sanitizeString(parsed.summary),
      sanitizeString(latestCheckpoint?.summary) ?? sanitizeString(latestCheckpoint?.goal),
    ].filter((entry): entry is string => entry !== null);
    if (fields.length > 0) {
      return fields.join(" | ").slice(0, 280);
    }
    if (checkpoints) return null;
  } catch {
    // Raw string hot-memory content is still usable.
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 280 ? normalized : `${normalized.slice(0, 277).trimEnd()}...`;
};

// The handoff file's own budget is 16 KiB of canonical JSON, and an import saves
// at most IMPORTED_HANDOFF_LIMIT characters of the rendered handoff. This leaves
// room for the rest of the capsule in both.
export const HANDOFF_HOT_SUMMARY_LIMIT = 5000;

/**
 * What a handoff file carries from hot memory: the latest saved request and the
 * agent's final response for this workspace (plus a pending import or explicit
 * save), at full length up to the limit. Observed source excerpts stay behind;
 * the file travels to other machines. Falls back to the one-line summary for
 * hot memory that holds no checkpoints.
 */
export const summarizeHotMemoryForHandoff = (
  snapshot: Record<string, unknown> | null, preferredRuntime: string, limit: number = HANDOFF_HOT_SUMMARY_LIMIT
): string | null => {
  if (!snapshot) return null;
  const entries = selectHotCheckpoints(snapshot, null);
  if (entries.length === 0) return summarizeHotMemorySnapshot(snapshot, preferredRuntime);
  const parts: string[] = [];
  let remaining = limit;
  for (const [index, entry] of entries.entries()) {
    const label = entry.turnId?.startsWith(IMPORTED_HANDOFF_TURN_PREFIX) ? "Imported earlier" : entry.origin === "remember" ? "Explicitly saved" : "Latest work";
    const heading = `${label} (${entry.runtime}, ${entry.occurredAt}):`;
    const available = Math.floor(remaining / (entries.length - index)) - heading.length - 40;
    if (available < 200) break;
    const goal = entry.goal ? entry.goal.slice(0, Math.floor(available * 0.3)) : "";
    const request = goal ? `\nRequest: ${goal}${goal.length < entry.goal.length || entry.goalTruncated ? " [request incomplete]" : ""}` : "";
    const findingBudget = available - request.length;
    const finding = entry.summary.length <= findingBudget ? entry.summary : compactContinuitySummary(entry.summary, findingBudget);
    const part = `${heading}${request}\nFinding: ${finding}`;
    parts.push(part);
    remaining -= part.length + 2;
  }
  return parts.length > 0 ? parts.join("\n\n") : summarizeHotMemorySnapshot(snapshot, preferredRuntime);
};

export const summarizeHotMemorySnapshot = (snapshot: Record<string, unknown> | null, preferredRuntime: string): string | null => {
  if (!snapshot) return null;
  const entries = (Array.isArray(snapshot.scopes) ? snapshot.scopes : [snapshot])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
  const preferred = (entry: Record<string, unknown>): boolean =>
    entry.scope === preferredRuntime || String(entry.scope).startsWith(`ws-${preferredRuntime}-`);
  for (const entry of [...entries.filter(preferred), ...entries.filter((candidate) => !preferred(candidate))]) {
    const summary = summarizeHotMemory(entry.content);
    if (summary) return summary;
  }
  return null;
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
  let replacedMode: number | null = null;
  try {
    const existing = lstatSync(target);
    if (existing.isFile()) replacedMode = existing.mode & 0o777;
  } catch { /* New file. */ }
  const staged = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    writeFileSync(descriptor, content, "utf8");
    // Replacing an executable wrapper must not leave it briefly unrunnable:
    // a host hook may exec it while an automatic update rewrites it.
    const executable = replacedMode !== null && (replacedMode & 0o111) !== 0;
    if (executable) fchmodSync(descriptor, replacedMode!);
    closeSync(descriptor);
    descriptor = null;
    renameSync(staged, target);
    if (!executable) chmodSync(target, 0o600);
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
