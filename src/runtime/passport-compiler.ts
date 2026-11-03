import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";

import { resolveClaudeCodeHostHome, resolveCodexHostHome, resolveOnlyBotsHome } from "./runtime-env";
import { assertManagedFilePath, writeManagedFile } from "./adapter-utils";
import type {
  AgentPassport,
  PassportCompilationTarget,
  PassportCompiledArtifact,
  PassportOutputHonesty,
  PassportOutputSource,
  PassportRuntimeHost,
  PassportTrustZone,
  PassportTrustZoneId,
} from "../protocol/passports";

const MANAGED_MARKDOWN_MARKERS: Record<
  "codex" | "claude-code" | "pi",
  {
    start: string;
    end: string;
  }
> = {
  codex: {
    start: "<!-- ONLYBOTS PASSPORT START:codex -->",
    end: "<!-- ONLYBOTS PASSPORT END:codex -->",
  },
  "claude-code": {
    start: "<!-- ONLYBOTS PASSPORT START:claude-code -->",
    end: "<!-- ONLYBOTS PASSPORT END:claude-code -->",
  },
  pi: {
    start: "<!-- ONLYBOTS PASSPORT START:pi -->",
    end: "<!-- ONLYBOTS PASSPORT END:pi -->",
  },
};

const CLAUDE_SETTINGS_SECTION_KEY = "onlybotsPassport";
const CLAUDE_SETTINGS_MARKER = "__onlybots_claude_passport__";
const PI_EMBEDDED_SECTION_KEY = "onlybotsPassport";
const PI_EMBEDDED_MARKER = "__onlybots_pi_passport__";
const ADAPTER_MANAGED_HTML_PREFIX = "<!-- managed-by:";

const stableStringify = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const nowIso = (): string => new Date().toISOString();

const ensureTrailingNewline = (value: string): string => (value.endsWith("\n") ? value : `${value}\n`);

const resolveCodexHome = (hostHome?: string): string => resolveCodexHostHome(hostHome);

const resolveClaudeCodeHome = (hostHome?: string): string => resolveClaudeCodeHostHome(hostHome);

const resolveRuntimeHome = (runtimeHome?: string): string => resolveOnlyBotsHome(runtimeHome);

const parseManagedAdapterJson = (filePath: string): Record<string, unknown> | null => {
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = readFileSync(filePath, "utf8");
  const content = raw.startsWith(ADAPTER_MANAGED_HTML_PREFIX) ? raw.slice(raw.indexOf("\n") + 1) : raw;
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const readJsonObject = (filePath: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must contain a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`${filePath} is not a valid JSON object: ${reason}`);
  }
};

const findCompilationTarget = (passport: AgentPassport, targetHost: PassportRuntimeHost): PassportCompilationTarget => {
  const target = passport.enforcement.compilationTargets.find((entry) => entry.targetHost === targetHost);
  if (!target) {
    throw new Error(`passport ${passport.passportId} does not declare a compilation target for ${targetHost}`);
  }
  return target;
};

const findTrustZone = (passport: AgentPassport, trustZoneId: PassportTrustZoneId): PassportTrustZone => {
  const trustZone = passport.trustZones.find((entry) => entry.trustZoneId === trustZoneId);
  if (!trustZone) {
    throw new Error(`passport ${passport.passportId} does not declare trust zone ${trustZoneId}`);
  }
  return trustZone;
};

const resolveTrustZoneId = (
  passport: AgentPassport,
  targetHost: PassportRuntimeHost,
  trustZoneId?: PassportTrustZoneId | null
): PassportTrustZoneId => {
  const target = findCompilationTarget(passport, targetHost);
  const selected = trustZoneId ?? target.defaultTrustZone;
  const policy = target.trustZonePolicies.find((entry) => entry.trustZoneId === selected);
  if (!policy) {
    throw new Error(`passport ${passport.passportId} does not declare trust zone ${selected} for ${targetHost}`);
  }
  return selected;
};

const findManagedArtifact = (
  passport: AgentPassport,
  targetHost: PassportRuntimeHost,
  trustZoneId: PassportTrustZoneId,
  surface: string
): PassportCompiledArtifact => {
  const target = findCompilationTarget(passport, targetHost);
  const policy = target.trustZonePolicies.find((entry) => entry.trustZoneId === trustZoneId);
  if (!policy) {
    throw new Error(`passport ${passport.passportId} does not declare trust zone ${trustZoneId} for ${targetHost}`);
  }
  const artifact = policy.compiledArtifacts.find((entry) => entry.surface === surface);
  if (!artifact) {
    throw new Error(`passport ${passport.passportId} does not declare compiled artifact surface ${surface} for ${targetHost}/${trustZoneId}`);
  }
  return artifact;
};

const parseMetadataLines = (content: string): Record<string, string> => {
  const metadata: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = /^([a-z_]+):\s*(.+)$/.exec(line.trim());
    if (match) {
      metadata[match[1]] = match[2];
    }
  }
  return metadata;
};

const locateManagedMarkdownBlock = (
  content: string,
  targetHost: "codex" | "claude-code" | "pi"
): { before: string; block: string; after: string; metadata: Record<string, string> } | null => {
  const markers = MANAGED_MARKDOWN_MARKERS[targetHost];
  const startIndex = content.indexOf(markers.start);
  const endIndex = content.indexOf(markers.end);
  if (startIndex === -1 && endIndex === -1) {
    return null;
  }
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`${targetHost} managed passport block is malformed; repair the markers before recompiling`);
  }
  const blockEnd = endIndex + markers.end.length;
  const block = content.slice(startIndex, blockEnd);
  return {
    before: content.slice(0, startIndex),
    block,
    after: content.slice(blockEnd),
    metadata: parseMetadataLines(block),
  };
};

const renderManagedMarkdown = (existing: string | null, block: string, targetHost: "codex" | "claude-code" | "pi") => {
  if (existing === null) {
    return {
      action: "create" as const,
      nextContent: ensureTrailingNewline(block),
      existingContent: null,
    };
  }
  const located = locateManagedMarkdownBlock(existing, targetHost);
  if (located) {
    const next = `${located.before}${block}${located.after}`;
    return {
      action: next === existing ? ("noop" as const) : ("update" as const),
      nextContent: ensureTrailingNewline(next),
      existingContent: existing,
    };
  }
  const trimmed = existing.replace(/\s+$/, "");
  const next = trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  return {
    action: next === ensureTrailingNewline(existing) ? ("noop" as const) : ("update" as const),
    nextContent: ensureTrailingNewline(next),
    existingContent: existing,
  };
};

const buildTextDiff = (existing: string | null, next: string): string => {
  if (existing === null) {
    return next
      .trimEnd()
      .split("\n")
      .map((line) => `+ ${line}`)
      .join("\n");
  }
  if (existing === next) {
    return "no changes";
  }
  const oldLines = existing.trimEnd().split("\n");
  const newLines = next.trimEnd().split("\n");

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const diffLines: string[] = [];
  const contextStart = Math.max(0, prefix - 2);
  for (const line of oldLines.slice(contextStart, prefix)) {
    diffLines.push(`  ${line}`);
  }
  for (const line of oldLines.slice(prefix, oldSuffix + 1)) {
    diffLines.push(`- ${line}`);
  }
  for (const line of newLines.slice(prefix, newSuffix + 1)) {
    diffLines.push(`+ ${line}`);
  }
  for (const line of newLines.slice(newSuffix + 1, Math.min(newLines.length, newSuffix + 3))) {
    diffLines.push(`  ${line}`);
  }
  return diffLines.join("\n");
};

const findExpectedSubsetMismatchPath = (
  actual: unknown,
  expected: unknown,
  currentPath = ""
): string | null => {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    return stableStringify(actual) === stableStringify(expected) ? null : currentPath;
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return currentPath;
  }
  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  for (const [key, value] of Object.entries(expectedRecord)) {
    const mismatch = findExpectedSubsetMismatchPath(
      actualRecord[key],
      value,
      currentPath.length > 0 ? `${currentPath}.${key}` : key
    );
    if (mismatch) {
      return mismatch;
    }
  }
  return null;
};

const renderBulletList = (values: string[]): string[] =>
  values.length > 0 ? values.map((value) => `- ${value}`) : ["- none declared"];

const renderMarkdownPassportBlock = (options: {
  passport: AgentPassport;
  targetHost: "codex" | "claude-code" | "pi";
  trustZone: PassportTrustZone;
  target: PassportCompilationTarget;
  artifact: PassportCompiledArtifact;
  generatedAt: string;
  compilerVersion: string;
  sourcePassportHash: string;
}): string => {
  const markers = MANAGED_MARKDOWN_MARKERS[options.targetHost];
  const lines = [
    markers.start,
    "## Crosshead Passport",
    "",
    "This managed block is compiler-owned. Edit the source passport and re-run `crosshead passport compile` instead of editing inside this block manually.",
    "",
    `passport_version: ${options.passport.passportVersion}`,
    `passport_id: ${options.passport.passportId}`,
    `generated_at: ${options.generatedAt}`,
    `compiler_version: ${options.compilerVersion}`,
    `source_passport_hash: ${options.sourcePassportHash}`,
    `trust_zone_id: ${options.trustZone.trustZoneId}`,
    `target_host: ${options.targetHost}`,
    `surface_honesty: ${options.artifact.honesty}`,
    `source_of_truth: ${options.artifact.sourceOfTruth}`,
    `agent_id: ${options.passport.agentRef.agentId}`,
    `npub: ${options.passport.agentRef.npub}`,
    `display_name: ${options.passport.identity.displayName}`,
    "",
    "Identity and posture:",
    `- ${options.passport.persona.summary}`,
    `- Current engine attachment: ${options.passport.enginePortability.currentEngineAttachmentRef ?? "none"}`,
    `- Preferred response length: ${options.passport.operatorPreferences.preferredResponseLength}`,
    "",
    `Trust zone: ${options.trustZone.displayName}`,
    ...renderBulletList(options.trustZone.outputAdjustments),
    "",
    "Portable memory tiers:",
    ...renderBulletList(options.trustZone.memoryScope.portableMemoryTiers),
    "",
    "Capabilities:",
    `- Declared: ${options.passport.capabilities.declared.join(", ")}`,
    `- Strengths: ${options.passport.capabilities.strengths.join(", ")}`,
    `- Limitations: ${options.passport.capabilities.limitations.join(", ")}`,
    "",
    "Review expectations:",
    ...renderBulletList(options.passport.operatorPreferences.reviewExpectations),
    "",
    "Host limitations:",
    ...renderBulletList(options.target.hostLimitations),
    "",
    "Artifact notes:",
    ...renderBulletList(options.artifact.notes),
    "",
    "Audit expectations:",
    ...renderBulletList(options.trustZone.auditExpectations),
    markers.end,
  ];
  return lines.join("\n");
};

const buildClaudeSettingsSection = (options: {
  passport: AgentPassport;
  trustZone: PassportTrustZone;
  target: PassportCompilationTarget;
  artifact: PassportCompiledArtifact;
  generatedAt: string;
  compilerVersion: string;
  sourcePassportHash: string;
}): Record<string, unknown> => ({
  marker: CLAUDE_SETTINGS_MARKER,
  passportVersion: options.passport.passportVersion,
  passportId: options.passport.passportId,
  generatedAt: options.generatedAt,
  compilerVersion: options.compilerVersion,
  sourcePassportHash: options.sourcePassportHash,
  targetHost: "claude-code",
  trustZoneId: options.trustZone.trustZoneId,
  surfaceHonesty: options.artifact.honesty,
  sourceOfTruth: options.artifact.sourceOfTruth,
  agentRef: options.passport.agentRef,
  displayName: options.passport.identity.displayName,
  personaSummary: options.passport.persona.summary,
  preferredResponseLength: options.passport.operatorPreferences.preferredResponseLength,
  reviewExpectations: options.passport.operatorPreferences.reviewExpectations,
  portableMemoryTiers: options.trustZone.memoryScope.portableMemoryTiers,
  outputAdjustments: options.trustZone.outputAdjustments,
  hostLimitations: options.target.hostLimitations,
  artifactNotes: options.artifact.notes,
  portabilityNotes: options.passport.enginePortability.portabilityNotes,
});

const buildPiEmbeddedPassportDocument = (options: {
  passport: AgentPassport;
  trustZone: PassportTrustZone;
  target: PassportCompilationTarget;
  artifact: PassportCompiledArtifact;
  generatedAt: string;
  compilerVersion: string;
  sourcePassportHash: string;
}): Record<string, unknown> => ({
  marker: PI_EMBEDDED_MARKER,
  passportVersion: options.passport.passportVersion,
  passportId: options.passport.passportId,
  generatedAt: options.generatedAt,
  compilerVersion: options.compilerVersion,
  sourcePassportHash: options.sourcePassportHash,
  targetHost: "pi",
  trustZoneId: options.trustZone.trustZoneId,
  surfaceHonesty: options.artifact.honesty,
  sourceOfTruth: options.artifact.sourceOfTruth,
  agentRef: options.passport.agentRef,
  displayName: options.passport.identity.displayName,
  personaSummary: options.passport.persona.summary,
  preferredResponseLength: options.passport.operatorPreferences.preferredResponseLength,
  reviewExpectations: options.passport.operatorPreferences.reviewExpectations,
  portableMemoryTiers: options.trustZone.memoryScope.portableMemoryTiers,
  outputAdjustments: options.trustZone.outputAdjustments,
  declaredCapabilities: options.passport.capabilities.declared,
  strengths: options.passport.capabilities.strengths,
  limitations: options.passport.capabilities.limitations,
  preferredTargets: options.passport.handoffPreferences.preferredTargets,
  requiredCapabilities: options.passport.handoffPreferences.requiresCapabilities,
  escalationHints: options.passport.handoffPreferences.escalationHints,
  hostLimitations: options.target.hostLimitations,
  artifactNotes: options.artifact.notes,
  portabilityNotes: options.passport.enginePortability.portabilityNotes,
});

export type PassportArtifactAction = "create" | "update" | "noop";

export type PassportCompileArtifactResult = {
  path: string;
  surface: string;
  action: PassportArtifactAction;
  honesty: PassportOutputHonesty;
  sourceOfTruth: PassportOutputSource;
  diff: string;
  notes: string[];
};

export type PassportCompileResult = {
  dryRun: boolean;
  wrote: boolean;
  passportId: string;
  passportVersion: string;
  targetHost: PassportRuntimeHost;
  trustZoneId: PassportTrustZoneId;
  generatedAt: string;
  compilerVersion: string;
  sourcePassportHash: string;
  artifacts: PassportCompileArtifactResult[];
  warnings: string[];
};

type PlannedArtifact = PassportCompileArtifactResult & {
  nextContent: string;
};

const planCodexArtifacts = (options: {
  passport: AgentPassport;
  workspaceRoot: string;
  trustZoneId: PassportTrustZoneId;
  compilerVersion: string;
}): {
  generatedAt: string;
  sourcePassportHash: string;
  artifacts: PlannedArtifact[];
  warnings: string[];
} => {
  const target = findCompilationTarget(options.passport, "codex");
  const trustZone = findTrustZone(options.passport, options.trustZoneId);
  const artifact = findManagedArtifact(options.passport, "codex", options.trustZoneId, "AGENTS.md");
  const generatedAt = nowIso();
  const sourcePassportHash = `sha256:${sha256Hex(stableStringify(options.passport))}`;
  const filePath = path.join(path.resolve(options.workspaceRoot), "AGENTS.md");
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
  const block = renderMarkdownPassportBlock({
    passport: options.passport,
    targetHost: "codex",
    trustZone,
    target,
    artifact,
    generatedAt,
    compilerVersion: options.compilerVersion,
    sourcePassportHash,
  });
  const rendered = renderManagedMarkdown(existing, block, "codex");
  return {
    generatedAt,
    sourcePassportHash,
    artifacts: [
      {
        path: filePath,
        surface: artifact.surface,
        action: rendered.action,
        honesty: artifact.honesty,
        sourceOfTruth: artifact.sourceOfTruth,
        diff: buildTextDiff(existing, rendered.nextContent),
        notes: artifact.notes,
        nextContent: rendered.nextContent,
      },
    ],
    warnings: [
      "Codex passport compilation writes only the advisory AGENTS.md surface. Runtime-enforced wrapper and hook wiring still come from the Codex adapter install path.",
    ],
  };
};

const planClaudeArtifacts = (options: {
  passport: AgentPassport;
  workspaceRoot: string;
  trustZoneId: PassportTrustZoneId;
  compilerVersion: string;
}): {
  generatedAt: string;
  sourcePassportHash: string;
  artifacts: PlannedArtifact[];
  warnings: string[];
} => {
  const target = findCompilationTarget(options.passport, "claude-code");
  const trustZone = findTrustZone(options.passport, options.trustZoneId);
  const markdownArtifact = findManagedArtifact(options.passport, "claude-code", options.trustZoneId, "CLAUDE.md");
  const settingsArtifact = findManagedArtifact(options.passport, "claude-code", options.trustZoneId, ".claude/settings.json");
  const generatedAt = nowIso();
  const sourcePassportHash = `sha256:${sha256Hex(stableStringify(options.passport))}`;
  const workspaceRoot = path.resolve(options.workspaceRoot);

  const claudeMdPath = path.join(workspaceRoot, "CLAUDE.md");
  const existingClaudeMd = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf8") : null;
  const claudeBlock = renderMarkdownPassportBlock({
    passport: options.passport,
    targetHost: "claude-code",
    trustZone,
    target,
    artifact: markdownArtifact,
    generatedAt,
    compilerVersion: options.compilerVersion,
    sourcePassportHash,
  });
  const renderedClaudeMd = renderManagedMarkdown(existingClaudeMd, claudeBlock, "claude-code");

  const settingsPath = path.join(workspaceRoot, ".claude", "settings.json");
  const existingSettingsContent = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  const existingSettings = existingSettingsContent ? readJsonObject(settingsPath) : {};
  const nextSettings = {
    ...existingSettings,
    [CLAUDE_SETTINGS_SECTION_KEY]: buildClaudeSettingsSection({
      passport: options.passport,
      trustZone,
      target,
      artifact: settingsArtifact,
      generatedAt,
      compilerVersion: options.compilerVersion,
      sourcePassportHash,
    }),
  };
  const nextSettingsContent = `${JSON.stringify(nextSettings, null, 2)}\n`;
  const settingsAction: PassportArtifactAction =
    existingSettingsContent === null ? "create" : existingSettingsContent === nextSettingsContent ? "noop" : "update";

  return {
    generatedAt,
    sourcePassportHash,
    artifacts: [
      {
        path: claudeMdPath,
        surface: markdownArtifact.surface,
        action: renderedClaudeMd.action,
        honesty: markdownArtifact.honesty,
        sourceOfTruth: markdownArtifact.sourceOfTruth,
        diff: buildTextDiff(existingClaudeMd, renderedClaudeMd.nextContent),
        notes: markdownArtifact.notes,
        nextContent: renderedClaudeMd.nextContent,
      },
      {
        path: settingsPath,
        surface: settingsArtifact.surface,
        action: settingsAction,
        honesty: settingsArtifact.honesty,
        sourceOfTruth: settingsArtifact.sourceOfTruth,
        diff: buildTextDiff(existingSettingsContent, nextSettingsContent),
        notes: settingsArtifact.notes,
        nextContent: nextSettingsContent,
      },
    ],
    warnings: [
      "Claude Code passport compilation writes the advisory CLAUDE.md block plus the managed onlybotsPassport section in .claude/settings.json. Hook installation and runtime attachment still come from the Claude Code adapter install path.",
    ],
  };
};

const planPiArtifacts = (options: {
  passport: AgentPassport;
  workspaceRoot: string;
  runtimeHome?: string;
  trustZoneId: PassportTrustZoneId;
  compilerVersion: string;
}): {
  generatedAt: string;
  sourcePassportHash: string;
  artifacts: PlannedArtifact[];
  warnings: string[];
} => {
  const target = findCompilationTarget(options.passport, "pi");
  const trustZone = findTrustZone(options.passport, options.trustZoneId);
  const markdownArtifact = findManagedArtifact(options.passport, "pi", options.trustZoneId, "AGENTS.md");
  const profileArtifact = findManagedArtifact(options.passport, "pi", options.trustZoneId, "pi-passport.json");
  const generatedAt = nowIso();
  const sourcePassportHash = `sha256:${sha256Hex(stableStringify(options.passport))}`;
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const runtimeHome = resolveRuntimeHome(options.runtimeHome);

  const agentsPath = path.join(workspaceRoot, "AGENTS.md");
  const existingAgents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : null;
  const agentsBlock = renderMarkdownPassportBlock({
    passport: options.passport,
    targetHost: "pi",
    trustZone,
    target,
    artifact: markdownArtifact,
    generatedAt,
    compilerVersion: options.compilerVersion,
    sourcePassportHash,
  });
  const renderedAgents = renderManagedMarkdown(existingAgents, agentsBlock, "pi");

  const embeddedPassportPath = path.join(runtimeHome, "config", "embedded", "pi-passport.json");
  const existingEmbeddedContent = existsSync(embeddedPassportPath) ? readFileSync(embeddedPassportPath, "utf8") : null;
  const nextEmbeddedContent = `${JSON.stringify(
    buildPiEmbeddedPassportDocument({
      passport: options.passport,
      trustZone,
      target,
      artifact: profileArtifact,
      generatedAt,
      compilerVersion: options.compilerVersion,
      sourcePassportHash,
    }),
    null,
    2
  )}\n`;
  const embeddedAction: PassportArtifactAction =
    existingEmbeddedContent === null ? "create" : existingEmbeddedContent === nextEmbeddedContent ? "noop" : "update";

  return {
    generatedAt,
    sourcePassportHash,
    artifacts: [
      {
        path: agentsPath,
        surface: markdownArtifact.surface,
        action: renderedAgents.action,
        honesty: markdownArtifact.honesty,
        sourceOfTruth: markdownArtifact.sourceOfTruth,
        diff: buildTextDiff(existingAgents, renderedAgents.nextContent),
        notes: markdownArtifact.notes,
        nextContent: renderedAgents.nextContent,
      },
      {
        path: embeddedPassportPath,
        surface: profileArtifact.surface,
        action: embeddedAction,
        honesty: profileArtifact.honesty,
        sourceOfTruth: profileArtifact.sourceOfTruth,
        diff: buildTextDiff(existingEmbeddedContent, nextEmbeddedContent),
        notes: profileArtifact.notes,
        nextContent: nextEmbeddedContent,
      },
    ],
    warnings: [
      "Pi passport compilation writes a runtime-owned embedded passport profile plus an advisory AGENTS.md block. Embedded execution and memory automation still come from the Pi adapter install path.",
    ],
  };
};

export const compilePassport = (options: {
  passport: AgentPassport;
  targetHost: PassportRuntimeHost;
  workspaceRoot: string;
  runtimeHome?: string;
  trustZoneId?: PassportTrustZoneId | null;
  compilerVersion: string;
  write?: boolean;
}): PassportCompileResult => {
  const trustZoneId = resolveTrustZoneId(options.passport, options.targetHost, options.trustZoneId);
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const workspaceArtifacts = options.targetHost === "claude-code"
    ? [path.join(workspaceRoot, "CLAUDE.md"), path.join(workspaceRoot, ".claude", "settings.json")]
    : [path.join(workspaceRoot, "AGENTS.md")];
  for (const filePath of workspaceArtifacts) assertManagedFilePath(filePath, workspaceRoot);
  const runtimeHome = options.targetHost === "pi" ? resolveRuntimeHome(options.runtimeHome) : null;
  if (runtimeHome) {
    assertManagedFilePath(path.join(runtimeHome, "config", "embedded", "pi-passport.json"), runtimeHome);
  }
  const planned =
    options.targetHost === "codex"
      ? planCodexArtifacts({
          passport: options.passport,
          workspaceRoot: options.workspaceRoot,
          trustZoneId,
          compilerVersion: options.compilerVersion,
        })
      : options.targetHost === "claude-code"
        ? planClaudeArtifacts({
            passport: options.passport,
            workspaceRoot: options.workspaceRoot,
            trustZoneId,
            compilerVersion: options.compilerVersion,
          })
        : planPiArtifacts({
          passport: options.passport,
          workspaceRoot: options.workspaceRoot,
          runtimeHome: options.runtimeHome,
          trustZoneId,
          compilerVersion: options.compilerVersion,
        });

  if (options.write) {
    for (const artifact of planned.artifacts) {
      const relativeToWorkspace = path.relative(workspaceRoot, artifact.path);
      const managedRoot = !relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace)
		? workspaceRoot
		: runtimeHome;
      if (!managedRoot) throw new Error("Passport artifact escaped its managed root");
      writeManagedFile(artifact.path, artifact.nextContent, managedRoot);
    }
  }

  return {
    dryRun: !options.write,
    wrote: !!options.write,
    passportId: options.passport.passportId,
    passportVersion: options.passport.passportVersion,
    targetHost: options.targetHost,
    trustZoneId,
    generatedAt: planned.generatedAt,
    compilerVersion: options.compilerVersion,
    sourcePassportHash: planned.sourcePassportHash,
    artifacts: planned.artifacts.map(({ nextContent: _nextContent, ...artifact }) => artifact),
    warnings: planned.warnings,
  };
};

export type PassportVerifyArtifactResult = {
  path: string;
  surface: string;
  ok: boolean;
  reason: string;
};

export type PassportVerifyResult = {
  ok: boolean;
  passportId: string;
  targetHost: PassportRuntimeHost;
  trustZoneId: PassportTrustZoneId;
  sourcePassportHash: string;
  artifacts: PassportVerifyArtifactResult[];
  warnings: string[];
};

const verifyManagedMarkdownArtifact = (
  filePath: string,
  targetHost: "codex" | "claude-code" | "pi",
  expectedMetadata: Record<string, string>
): PassportVerifyArtifactResult => {
  if (!existsSync(filePath)) {
    return {
      path: filePath,
      surface: path.basename(filePath),
      ok: false,
      reason: "file is missing",
    };
  }
  const located = locateManagedMarkdownBlock(readFileSync(filePath, "utf8"), targetHost);
  if (!located) {
    return {
      path: filePath,
      surface: path.basename(filePath),
      ok: false,
      reason: "managed passport block is missing",
    };
  }
  for (const [key, value] of Object.entries(expectedMetadata)) {
    if (located.metadata[key] !== value) {
      return {
        path: filePath,
        surface: path.basename(filePath),
        ok: false,
        reason: `metadata mismatch for ${key}: expected ${value}, found ${located.metadata[key] ?? "missing"}`,
      };
    }
  }
  return {
    path: filePath,
    surface: path.basename(filePath),
    ok: true,
    reason: "managed passport block matches expected provenance",
  };
};

const verifyJsonObjectArtifact = (
  filePath: string,
  surface: string,
  expectedFields: Record<string, unknown>
): PassportVerifyArtifactResult => {
  if (!existsSync(filePath)) {
    return {
      path: filePath,
      surface,
      ok: false,
      reason: "file is missing",
    };
  }
  const record = readJsonObject(filePath);
  for (const [key, value] of Object.entries(expectedFields)) {
    const mismatchPath = findExpectedSubsetMismatchPath(record[key], value, key);
    if (mismatchPath) {
      return {
        path: filePath,
        surface,
        ok: false,
        reason: `managed passport field ${mismatchPath} does not match the source passport provenance`,
      };
    }
  }
  return {
    path: filePath,
    surface,
    ok: true,
    reason: "managed passport object matches expected provenance",
  };
};

export const verifyPassportCompilation = (options: {
  passport: AgentPassport;
  targetHost: PassportRuntimeHost;
  workspaceRoot: string;
  runtimeHome?: string;
  trustZoneId?: PassportTrustZoneId | null;
  compilerVersion: string;
}): PassportVerifyResult => {
  const trustZoneId = resolveTrustZoneId(options.passport, options.targetHost, options.trustZoneId);
  const target = findCompilationTarget(options.passport, options.targetHost);
  const trustZone = findTrustZone(options.passport, trustZoneId);
  const sourcePassportHash = `sha256:${sha256Hex(stableStringify(options.passport))}`;
  const workspaceRoot = path.resolve(options.workspaceRoot);

  const artifacts: PassportVerifyArtifactResult[] = [];

  if (options.targetHost === "codex") {
    artifacts.push(
      verifyManagedMarkdownArtifact(path.join(workspaceRoot, "AGENTS.md"), "codex", {
        passport_version: options.passport.passportVersion,
        passport_id: options.passport.passportId,
        source_passport_hash: sourcePassportHash,
        trust_zone_id: trustZone.trustZoneId,
        target_host: "codex",
      })
    );
  } else if (options.targetHost === "claude-code") {
    artifacts.push(
      verifyManagedMarkdownArtifact(path.join(workspaceRoot, "CLAUDE.md"), "claude-code", {
        passport_version: options.passport.passportVersion,
        passport_id: options.passport.passportId,
        source_passport_hash: sourcePassportHash,
        trust_zone_id: trustZone.trustZoneId,
        target_host: "claude-code",
      })
    );
    artifacts.push(
      verifyJsonObjectArtifact(
        path.join(workspaceRoot, ".claude", "settings.json"),
        ".claude/settings.json",
        {
          [CLAUDE_SETTINGS_SECTION_KEY]: {
            marker: CLAUDE_SETTINGS_MARKER,
            passportVersion: options.passport.passportVersion,
            passportId: options.passport.passportId,
            sourcePassportHash,
            targetHost: "claude-code",
            trustZoneId,
            surfaceHonesty: findManagedArtifact(options.passport, "claude-code", trustZoneId, ".claude/settings.json").honesty,
            sourceOfTruth: findManagedArtifact(options.passport, "claude-code", trustZoneId, ".claude/settings.json").sourceOfTruth,
            agentRef: options.passport.agentRef,
            displayName: options.passport.identity.displayName,
          },
        }
      )
    );
  } else {
    const runtimeHome = resolveRuntimeHome(options.runtimeHome);
    artifacts.push(
      verifyManagedMarkdownArtifact(path.join(workspaceRoot, "AGENTS.md"), "pi", {
        passport_version: options.passport.passportVersion,
        passport_id: options.passport.passportId,
        source_passport_hash: sourcePassportHash,
        trust_zone_id: trustZone.trustZoneId,
        target_host: "pi",
      })
    );
    artifacts.push(
      verifyJsonObjectArtifact(
        path.join(runtimeHome, "config", "embedded", "pi-passport.json"),
        "pi-passport.json",
        {
          marker: PI_EMBEDDED_MARKER,
          passportVersion: options.passport.passportVersion,
          passportId: options.passport.passportId,
          sourcePassportHash,
          targetHost: "pi",
          trustZoneId,
          surfaceHonesty: findManagedArtifact(options.passport, "pi", trustZoneId, "pi-passport.json").honesty,
          sourceOfTruth: findManagedArtifact(options.passport, "pi", trustZoneId, "pi-passport.json").sourceOfTruth,
          agentRef: options.passport.agentRef,
          displayName: options.passport.identity.displayName,
        }
      )
    );
  }

  return {
    ok: artifacts.every((artifact) => artifact.ok),
    passportId: options.passport.passportId,
    targetHost: options.targetHost,
    trustZoneId,
    sourcePassportHash,
    artifacts,
    warnings: [
      "Passport schema v1 carries signedBy/signedAt identity metadata but does not yet include detached signature bytes, so verify checks provenance consistency rather than a cryptographic signature payload.",
    ],
  };
};

export type PassportImportResult = {
  passport: AgentPassport;
  sourceHost: PassportRuntimeHost;
  trustZoneId: PassportTrustZoneId;
  discoveredFiles: string[];
  notes: string[];
  warnings: string[];
};

const listExisting = (files: string[]): string[] => files.filter((filePath) => existsSync(filePath));

const detectCodexImportEvidence = (workspaceRoot: string, codexHome: string) => {
  const hooksPath = path.join(codexHome, "hooks.json");
  const skills = ["crosshead-bootstrap", "crosshead-runtime", "onlybots-bootstrap", "onlybots-runtime"].map(name => path.join(codexHome, "skills", name, "SKILL.md"));
  const adapterConfigPath = path.join(codexHome, "onlybots", "codex-adapter.json");
  const agentsPath = path.join(workspaceRoot, "AGENTS.md");
  const files = listExisting([hooksPath, ...skills, adapterConfigPath, agentsPath]);
  const notes: string[] = [];
  const warnings: string[] = [];
  let trustZoneId: PassportTrustZoneId | null = null;
  let displayName: string | null = null;

  if (existsSync(hooksPath)) {
    const hooks = readJsonObject(hooksPath);
    if (hooks.hooks && typeof hooks.hooks === "object" && !Array.isArray(hooks.hooks)) {
      notes.push("Detected Codex hook configuration in hooks.json.");
    }
  } else {
    warnings.push("Codex hooks.json was not found. Runtime-enforced lifecycle wiring may not be installed.");
  }

  if (skills.some(existsSync)) {
    notes.push("Detected an installed Crosshead Codex skill entry.");
  }

  const adapterConfig = parseManagedAdapterJson(adapterConfigPath);
  if (adapterConfig) {
    const profileName = typeof adapterConfig.profileName === "string" ? adapterConfig.profileName : null;
    notes.push(
      profileName ? `Detected Crosshead Codex adapter config for profile ${profileName}.` : "Detected Crosshead Codex adapter config."
    );
  }

  if (existsSync(agentsPath)) {
    const located = locateManagedMarkdownBlock(readFileSync(agentsPath, "utf8"), "codex");
    if (located) {
      trustZoneId =
        typeof located.metadata.trust_zone_id === "string" ? (located.metadata.trust_zone_id as PassportTrustZoneId) : null;
      displayName = typeof located.metadata.display_name === "string" ? located.metadata.display_name : null;
      notes.push("Detected an existing managed Codex passport block in AGENTS.md.");
    } else {
      notes.push("Found AGENTS.md without a Crosshead-managed passport block; user-owned prompt content was preserved but not imported.");
    }
  }

  return { files, notes, warnings, trustZoneId, displayName };
};

const detectClaudeImportEvidence = (workspaceRoot: string, claudeHome: string) => {
  const adapterConfigPath = path.join(claudeHome, "onlybots", "claude-code-adapter.json");
  const settingsPath = path.join(workspaceRoot, ".claude", "settings.json");
  const claudeMdPath = path.join(workspaceRoot, "CLAUDE.md");
  const files = listExisting([adapterConfigPath, settingsPath, claudeMdPath]);
  const notes: string[] = [];
  const warnings: string[] = [];
  let trustZoneId: PassportTrustZoneId | null = null;
  let displayName: string | null = null;

  const adapterConfig = parseManagedAdapterJson(adapterConfigPath);
  if (adapterConfig) {
    const profileName = typeof adapterConfig.profileName === "string" ? adapterConfig.profileName : null;
    notes.push(
      profileName
        ? `Detected Crosshead Claude Code adapter config for profile ${profileName}.`
        : "Detected Crosshead Claude Code adapter config."
    );
  } else {
    warnings.push("Claude Code adapter config was not found under the host home.");
  }

  if (existsSync(settingsPath)) {
    const settings = readJsonObject(settingsPath);
    if (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)) {
      notes.push("Detected Claude Code hooks in .claude/settings.json.");
    }
    const section = settings[CLAUDE_SETTINGS_SECTION_KEY];
    if (section && typeof section === "object" && !Array.isArray(section)) {
      const record = section as Record<string, unknown>;
      if (record.marker === CLAUDE_SETTINGS_MARKER) {
        trustZoneId = typeof record.trustZoneId === "string" ? (record.trustZoneId as PassportTrustZoneId) : null;
        displayName = typeof record.displayName === "string" ? record.displayName : null;
        notes.push("Detected an existing managed onlybotsPassport section in .claude/settings.json.");
      }
    }
  } else {
    warnings.push("Workspace .claude/settings.json was not found.");
  }

  if (existsSync(claudeMdPath)) {
    const located = locateManagedMarkdownBlock(readFileSync(claudeMdPath, "utf8"), "claude-code");
    if (located) {
      if (!trustZoneId && typeof located.metadata.trust_zone_id === "string") {
        trustZoneId = located.metadata.trust_zone_id as PassportTrustZoneId;
      }
      if (!displayName && typeof located.metadata.display_name === "string") {
        displayName = located.metadata.display_name;
      }
      notes.push("Detected an existing managed Claude passport block in CLAUDE.md.");
    } else {
      notes.push("Found CLAUDE.md without a Crosshead-managed passport block; user-owned prompt content was preserved but not imported.");
    }
  }

  return { files, notes, warnings, trustZoneId, displayName };
};

export const importPassportFromHost = (options: {
  basePassport: AgentPassport;
  sourceHost: "codex" | "claude-code";
  workspaceRoot: string;
  trustZoneId?: PassportTrustZoneId | null;
  codexHome?: string;
  claudeHome?: string;
}): PassportImportResult => {
  const imported = JSON.parse(JSON.stringify(options.basePassport)) as AgentPassport;
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const evidence =
    options.sourceHost === "codex"
      ? detectCodexImportEvidence(workspaceRoot, resolveCodexHome(options.codexHome))
      : detectClaudeImportEvidence(workspaceRoot, resolveClaudeCodeHome(options.claudeHome));

  const target = findCompilationTarget(imported, options.sourceHost);
  const trustZoneId = options.trustZoneId ?? evidence.trustZoneId ?? target.defaultTrustZone;
  findTrustZone(imported, trustZoneId);
  target.defaultTrustZone = trustZoneId;

  imported.provenance.updatedAt = nowIso();
  imported.enginePortability.currentEngineAttachmentRef = null;
  imported.handoffPreferences.preferredTargets = [
    options.sourceHost,
    ...imported.handoffPreferences.preferredTargets.filter((entry) => entry !== options.sourceHost),
  ];
  if (evidence.displayName) {
    imported.identity.displayName = evidence.displayName;
  }
  imported.notes = [
    ...imported.notes,
    `Imported from existing ${options.sourceHost} host files on ${imported.provenance.updatedAt}.`,
    `Host import from ${options.sourceHost} left currentEngineAttachmentRef unset because host evidence alone cannot prove the active engine attachment id.`,
    ...evidence.notes,
  ];

  return {
    passport: imported,
    sourceHost: options.sourceHost,
    trustZoneId,
    discoveredFiles: evidence.files,
    notes: evidence.notes,
    warnings: evidence.warnings,
  };
};

export type PassportRoutingExplanation = {
  passportId: string;
  declarative: true;
  declaredCapabilities: string[];
  strengths: string[];
  limitations: string[];
  preferredTargets: PassportRuntimeHost[];
  requiredCapabilities: string[];
  escalationHints: string[];
  targets: Array<{
    targetHost: PassportRuntimeHost;
    preferred: boolean;
    defaultTrustZone: PassportTrustZoneId;
    compiledSurfaces: Array<{
      surface: string;
      honesty: PassportOutputHonesty;
      sourceOfTruth: PassportOutputSource;
    }>;
    hostLimitations: string[];
    trustZoneNotes: string[];
    rationale: string[];
  }>;
  notes: string[];
};

export const explainPassportRouting = (passport: AgentPassport): PassportRoutingExplanation => ({
  passportId: passport.passportId,
  declarative: true,
  declaredCapabilities: passport.capabilities.declared,
  strengths: passport.capabilities.strengths,
  limitations: passport.capabilities.limitations,
  preferredTargets: passport.handoffPreferences.preferredTargets,
  requiredCapabilities: passport.handoffPreferences.requiresCapabilities,
  escalationHints: passport.handoffPreferences.escalationHints,
  targets: passport.enforcement.compilationTargets.map((target) => {
    const defaultPolicy = target.trustZonePolicies.find((entry) => entry.trustZoneId === target.defaultTrustZone);
    return {
      targetHost: target.targetHost,
      preferred: passport.handoffPreferences.preferredTargets.includes(target.targetHost),
      defaultTrustZone: target.defaultTrustZone,
      compiledSurfaces: (defaultPolicy?.compiledArtifacts ?? []).map((artifact) => ({
        surface: artifact.surface,
        honesty: artifact.honesty,
        sourceOfTruth: artifact.sourceOfTruth,
      })),
      hostLimitations: target.hostLimitations,
      trustZoneNotes: defaultPolicy?.notes ?? [],
      rationale: [
        passport.handoffPreferences.preferredTargets.includes(target.targetHost)
          ? "listed in handoffPreferences.preferredTargets"
          : "not listed in handoffPreferences.preferredTargets",
        passport.handoffPreferences.requiresCapabilities.length > 0
          ? `requires capabilities: ${passport.handoffPreferences.requiresCapabilities.join(", ")}`
          : "no explicit requiredCapabilities declared",
      ],
    };
  }),
  notes: [
    ...passport.enginePortability.portabilityNotes,
    "Routing hints are declarative. The passport does not enforce target matching or capability resolution by itself.",
  ],
});

export const formatPassportCompileResult = (result: PassportCompileResult): string =>
  [
    `passport ${result.wrote ? "compile" : "compile dry-run"} for ${result.targetHost}/${result.trustZoneId}`,
    `passport_id: ${result.passportId}`,
    `source_passport_hash: ${result.sourcePassportHash}`,
    ...result.artifacts.flatMap((artifact) => [
      "",
      `${artifact.surface} -> ${artifact.path}`,
      `action: ${artifact.action}`,
      `honesty: ${artifact.honesty}`,
      `source_of_truth: ${artifact.sourceOfTruth}`,
      "diff:",
      artifact.diff,
    ]),
    ...result.warnings.flatMap((warning) => ["", `warning: ${warning}`]),
  ].join("\n");

export const formatPassportVerifyResult = (result: PassportVerifyResult): string =>
  [
    `passport verify for ${result.targetHost}/${result.trustZoneId}: ${result.ok ? "pass" : "fail"}`,
    `passport_id: ${result.passportId}`,
    `source_passport_hash: ${result.sourcePassportHash}`,
    ...result.artifacts.map(
      (artifact) => `${artifact.ok ? "ok" : "fail"} ${artifact.surface} (${artifact.path}): ${artifact.reason}`
    ),
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ].join("\n");

export const formatPassportImportResult = (result: PassportImportResult): string =>
  [
    `passport import from ${result.sourceHost}`,
    `trust_zone: ${result.trustZoneId}`,
    `passport_id: ${result.passport.passportId}`,
    `display_name: ${result.passport.identity.displayName}`,
    `discovered_files: ${result.discoveredFiles.length > 0 ? result.discoveredFiles.join(", ") : "none"}`,
    ...result.notes.map((note) => `note: ${note}`),
    ...result.warnings.map((warning) => `warning: ${warning}`),
  ].join("\n");

export const formatPassportRoutingExplanation = (result: PassportRoutingExplanation): string =>
  [
    `passport routing for ${result.passportId}`,
    `declarative: ${result.declarative ? "yes" : "no"}`,
    `declared_capabilities: ${result.declaredCapabilities.join(", ")}`,
    `strengths: ${result.strengths.join(", ")}`,
    `limitations: ${result.limitations.join(", ")}`,
    `preferred_targets: ${result.preferredTargets.join(", ")}`,
    `required_capabilities: ${result.requiredCapabilities.join(", ")}`,
    "escalation_hints:",
    ...renderBulletList(result.escalationHints),
    "targets:",
    ...result.targets.flatMap((target) => [
      `- ${target.targetHost} preferred=${target.preferred ? "yes" : "no"} default_trust_zone=${target.defaultTrustZone}`,
      `  rationale: ${target.rationale.join(" | ")}`,
      `  compiled_surfaces: ${
        target.compiledSurfaces.length > 0
          ? target.compiledSurfaces.map((surface) => `${surface.surface} (${surface.honesty}/${surface.sourceOfTruth})`).join(", ")
          : "none"
      }`,
      `  host_limitations: ${target.hostLimitations.join(" | ") || "none declared"}`,
      `  trust_zone_notes: ${target.trustZoneNotes.join(" | ") || "none declared"}`,
    ]),
    "notes:",
    ...renderBulletList(result.notes),
  ].join("\n");
