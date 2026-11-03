import { accessSync, chmodSync, constants, existsSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";

import type { OperatorWorkspaceManifest } from "./operator-policy";
import { LocalRuntimeClient } from "./local-client";
import {
  ONLYBOTS_RUNTIME_CORE_VERSION,
  ensureRuntimeHomeLayout,
  removeRuntimeAdapterRecord,
  resolveRuntimeHome,
  type RuntimeAdapterRecord,
  upsertRuntimeAdapterRecord,
} from "./local-runtime";
import {
  buildPlainTextContinuationSummary,
  compareContinuityRestatement,
  buildCapturedContinuityContext,
  materializeContinuityIrForRuntime,
  normalizeCapturedContextToContinuityIr,
  type CapturedContinuityContext,
  type ContinuityMaterializationResult,
  type ContinuityRestatementComparison,
  type ContinuityTranslationResult,
  type ContinuityCaptureBase,
  type ContinuityFieldEffect,
  type ContinuityOpaqueAttachment,
  type ContinuityRedaction,
  type ContinuityTranslationContract,
} from "./continuity-ir";
import {
  assertManagedFilePath,
  buildWrapperScript,
  createWorkspaceManifest,
  extractContinuityPolicyRef,
  isManagedHookCommand,
  listWarmIds,
  nowIso,
  parseArgs,
  sanitizeString,
  shellQuote,
  summarizeHotMemory,
  summarizeJudgmentEntries,
  writeManagedFile,
} from "./adapter-utils";
import {
  HostRuntimeAdapterBase,
  type HostAdapterCompactEventRequest,
  type HostAdapterIdentity,
  type HostAdapterRememberRequest,
  type HostAdapterSessionEndedRequest,
  type HostAdapterSessionStartRequest,
  type HostAdapterTaskChangedRequest,
  type HostAdapterToolCompleteRequest,
  type HostAdapterTurnCompleteRequest,
  type HostAdapterTurnFailedRequest,
  type HostAdapterTurnPrepareRequest,
  type HostAdapterTurnPrepareResult,
} from "./host-adapter-base";
import { resolveClaudeCodeBinaryPath, resolveClaudeCodeHostHome } from "./runtime-env";
import type {
  HandoffCapsule,
  HandoffInspection,
  HandoffReceipt,
  HandoffStoredRecord,
  HandoffVerificationResult,
} from "./handoff-capsules";

export const ONLYBOTS_CLAUDE_CODE_ADAPTER_VERSION = "0.3.0";

const CLAUDE_CODE_ADAPTER_MARKER = "<!-- managed-by: onlybots-claude-code-adapter -->";
const CLAUDE_CODE_MANAGED_CONFIG_MARKER = "__onlybots_claude_code_adapter__";

export type ClaudeCodeAdapterConfig = {
  marker: string;
  adapterName: "claude-code";
  adapterVersion: string;
  runtimeHome: string;
  hostHome: string;
  workspaceRoot: string;
  profileName: string;
  claudeBinary: string;
  installedAt: string;
  updatedAt: string;
};

export type ClaudeCodeAdapterPaths = {
  runtimeHome: string;
  hostHome: string;
  workspaceRoot: string;
  configDirectory: string;
  configFile: string;
  projectDirectory: string;
  projectSettingsFile: string;
  wrapperFile: string;
  hookWrapperFile: string;
  claudeLaunchWrapperFile: string;
};

export type ClaudeCodeAdapterInstallOptions = {
  home?: string;
  hostHome?: string;
  workspaceRoot?: string;
  profileName?: string;
  adapterVersion?: string;
  bridgeScriptPath: string;
  hookScriptPath: string;
  claudeBinary?: string;
};

export type ClaudeCodeAdapterInstallResult = {
  adapter: RuntimeAdapterRecord;
  config: ClaudeCodeAdapterConfig;
  managedFiles: string[];
};

export type ClaudeCodeAdapterUninstallOptions = {
  home?: string;
  hostHome?: string;
};

export type ClaudeCodeAdapterTurnPrepareRequest = HostAdapterTurnPrepareRequest;

export type ClaudeCodeAdapterTurnPrepareResult = HostAdapterTurnPrepareResult;

export type ClaudeCodeAdapterTurnCompleteRequest = HostAdapterTurnCompleteRequest;

export type ClaudeCodeAdapterTurnFailedRequest = HostAdapterTurnFailedRequest;

export type ClaudeCodeAdapterSessionEndedRequest = HostAdapterSessionEndedRequest;

export type ClaudeCodeAdapterCompactEventRequest = HostAdapterCompactEventRequest;

export type ClaudeCodeAdapterToolCompleteRequest = HostAdapterToolCompleteRequest;

export type ClaudeCodeAdapterTaskChangedRequest = HostAdapterTaskChangedRequest;

export type ClaudeCodeAdapterRememberRequest = HostAdapterRememberRequest;

export type ClaudeCodePrintRequest = ClaudeCodeAdapterTurnPrepareRequest & {
  claudeBin?: string;
  model?: string;
  claudeArgs?: string[];
};

export type ClaudeCodePrintResult = ClaudeCodeAdapterTurnPrepareResult & {
  stdout: string;
  stderr: string;
  command: string[];
};

export type ClaudeCodeContinuityCapture = ContinuityCaptureBase & {
  runtime: "claude-code";
  hostHome?: string;
  printMode?: boolean;
  projectSettingsManaged?: boolean;
  promptTransport?: "--append-system-prompt" | "injectedPrompt";
  managedFiles?: string[];
};

export type ClaudeCodeAdapterHandoffCreateRequest = Omit<ClaudeCodeContinuityCapture, "runtime"> & {
  profileName?: string;
  targetRuntime?: "codex";
  maxBytes?: number;
};

export type ClaudeCodeAdapterHandoffCreateResult = {
  capture: CapturedContinuityContext;
  translation: ContinuityTranslationResult;
  materialization: ContinuityMaterializationResult;
  plainTextSummary: string;
  restatementComparison: ContinuityRestatementComparison;
  record: HandoffStoredRecord;
};

export type ClaudeCodeAdapterHandoffImportRequest = {
  profileName?: string;
  handoffId?: string;
  capsule?: HandoffCapsule;
  workspaceRoot: string;
  workspaceId?: string;
  hostHome?: string;
  hostVersion?: string;
  sessionId: string;
  accepted?: boolean;
  note?: string;
};

export type ClaudeCodeAdapterHandoffImportResult = {
  handoffId: string | null;
  accepted: boolean;
  verification: HandoffVerificationResult;
  inspection: HandoffInspection;
  materialization: ContinuityMaterializationResult | null;
  plainTextSummary: string | null;
  restatementComparison: ContinuityRestatementComparison | null;
  receipt: HandoffReceipt | null;
  record: HandoffStoredRecord | null;
};

type CommandCaptureResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};


type ClaudeHookHandler = {
  type: "command";
  command: string;
};

type ClaudeHookMatcherGroup = {
  matcher?: string;
  hooks: ClaudeHookHandler[];
};

type ClaudeHooksConfig = Partial<
  Record<
    | "SessionStart"
    | "PreCompact"
    | "PostCompact"
    | "PreToolUse"
    | "PostToolUse"
    | "UserPromptSubmit"
    | "Stop",
    ClaudeHookMatcherGroup[]
  >
>;

type ClaudeSettingsConfig = Record<string, unknown> & {
  hooks?: ClaudeHooksConfig;
};


export const resolveClaudeCodeHome = (hostHome?: string): string => resolveClaudeCodeHostHome(hostHome);

export const resolveClaudeWorkspaceRoot = (workspaceRoot?: string, runtimeHomeInput?: string): string => {
  if (workspaceRoot) {
    return path.resolve(workspaceRoot);
  }
  const runtimeHome = resolveRuntimeHome(runtimeHomeInput);
  if ([".onlybots", ".crosshead"].includes(path.basename(runtimeHome))) {
    return path.dirname(runtimeHome);
  }
  return path.resolve(process.cwd());
};

const resolveClaudeCodeBinary = (runtimeHome: string, binary?: string): string => {
  const configured = resolveClaudeCodeBinaryPath(binary);
  if (path.isAbsolute(configured) || configured.includes(path.sep)) return path.resolve(configured);
  const blockedCandidates = new Set([
    path.join(runtimeHome, "bin", "claude"),
    path.join(runtimeHome, "bin", "crosshead-claude-code"),
  ]);
  for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(entry, process.platform === "win32" ? `${configured}.exe` : configured);
    if (blockedCandidates.has(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next PATH entry.
    }
  }
  throw new Error("Unable to resolve the real Claude Code binary from PATH; pass --claude-bin <path>");
};

const configFile = (hostHome: string): string => path.join(hostHome, "onlybots", "claude-code-adapter.json");
const projectSettingsFile = (workspaceRoot: string): string => path.join(workspaceRoot, ".claude", "settings.json");

const isManagedContent = (filePath: string): boolean =>
  existsSync(filePath) && readFileSync(filePath, "utf8").includes(CLAUDE_CODE_ADAPTER_MARKER);

const writeManagedExecutable = (filePath: string, scriptPath: string, runtimeHome: string): void => {
  writeManagedFile(filePath, buildWrapperScript(scriptPath), runtimeHome);
  chmodSync(filePath, 0o755);
};

export const resolveClaudeCodeAdapterPaths = (
  runtimeHomeInput?: string,
  hostHomeInput?: string,
  workspaceRootInput?: string
): ClaudeCodeAdapterPaths => {
  const runtimeHome = resolveRuntimeHome(runtimeHomeInput);
  const hostHome = resolveClaudeCodeHome(hostHomeInput);
  const workspaceRoot = resolveClaudeWorkspaceRoot(workspaceRootInput, runtimeHome);
  return {
    runtimeHome,
    hostHome,
    workspaceRoot,
    configDirectory: path.dirname(configFile(hostHome)),
    configFile: configFile(hostHome),
    projectDirectory: path.dirname(projectSettingsFile(workspaceRoot)),
    projectSettingsFile: projectSettingsFile(workspaceRoot),
    wrapperFile: path.join(runtimeHome, "bin", "crosshead-claude-code"),
    hookWrapperFile: path.join(runtimeHome, "bin", "crosshead-claude-code-hook"),
    claudeLaunchWrapperFile: path.join(runtimeHome, "bin", "claude"),
  };
};

const buildClaudeCodeAdapterConfig = (options: {
  runtimeHome: string;
  hostHome: string;
  workspaceRoot: string;
  profileName: string;
  adapterVersion: string;
  claudeBinary: string;
}): ClaudeCodeAdapterConfig => ({
  marker: CLAUDE_CODE_MANAGED_CONFIG_MARKER,
  adapterName: "claude-code",
  adapterVersion: options.adapterVersion,
  runtimeHome: options.runtimeHome,
  hostHome: options.hostHome,
  workspaceRoot: options.workspaceRoot,
  profileName: options.profileName,
  claudeBinary: options.claudeBinary,
  installedAt: nowIso(),
  updatedAt: nowIso(),
});

const buildHookCommand = (
  hookWrapperFile: string,
  eventName: "SessionStart" | "PreCompact" | "PostCompact" | "UserPromptSubmit" | "Stop",
  config: ClaudeCodeAdapterConfig
): string =>
  [
    shellQuote(hookWrapperFile),
    shellQuote(eventName),
    "--home",
    shellQuote(config.runtimeHome),
    "--claude-home",
    shellQuote(config.hostHome),
  ].join(" ");

const CLAUDE_HOOK_MARKER = "crosshead-claude-code-hook";

const readClaudeSettingsConfig = (filePath: string): ClaudeSettingsConfig => {
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ClaudeSettingsConfig) : {};
  } catch {
    return {};
  }
};

const filterManagedClaudeHooks = (existing: ClaudeSettingsConfig, hookWrapperPath: string): ClaudeSettingsConfig => {
  const next: ClaudeSettingsConfig = { ...existing };
  const hooks = next.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    delete next.hooks;
    return next;
  }

  const filteredHooks: ClaudeHooksConfig = {};
  for (const [eventName, matcherGroups] of Object.entries(hooks)) {
    const remainingGroups = (matcherGroups ?? [])
      .filter((group): group is ClaudeHookMatcherGroup => !!group && typeof group === "object" && !Array.isArray(group))
      .map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter((hook) => !isManagedHookCommand(hook.command, hookWrapperPath, CLAUDE_HOOK_MARKER) && !isManagedHookCommand(hook.command, path.join(path.dirname(hookWrapperPath), "onlybots-claude-code-hook"), "onlybots-claude-code-hook")),
      }))
      .filter((group) => group.hooks.length > 0);
    if (remainingGroups.length > 0) {
      filteredHooks[eventName as keyof ClaudeHooksConfig] = remainingGroups;
    }
  }

  if (Object.keys(filteredHooks).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = filteredHooks;
  }
  return next;
};

const renderClaudeSettingsConfig = (
  existing: ClaudeSettingsConfig,
  adapterPaths: ClaudeCodeAdapterPaths,
  config: ClaudeCodeAdapterConfig
): string => {
	const next = filterManagedClaudeHooks(existing, adapterPaths.hookWrapperFile);
	const hooks: ClaudeHooksConfig = next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks) ? next.hooks : {};
	const managedHooks: Array<
		readonly ["SessionStart" | "PreCompact" | "PostCompact" | "UserPromptSubmit" | "Stop", ClaudeHookMatcherGroup]
	> = [
		[
			"SessionStart",
			{
				matcher: "startup|resume|compact",
				hooks: [{ type: "command", command: buildHookCommand(adapterPaths.hookWrapperFile, "SessionStart", config) }],
			},
		],
		[
			"PreCompact",
			{
				matcher: "manual|auto",
				hooks: [{ type: "command", command: buildHookCommand(adapterPaths.hookWrapperFile, "PreCompact", config) }],
			},
		],
		[
			"PostCompact",
			{
				matcher: "manual|auto",
				hooks: [{ type: "command", command: buildHookCommand(adapterPaths.hookWrapperFile, "PostCompact", config) }],
			},
		],
		[
			"UserPromptSubmit",
      {
        hooks: [{ type: "command", command: buildHookCommand(adapterPaths.hookWrapperFile, "UserPromptSubmit", config) }],
      },
    ],
    [
      "Stop",
      {
        hooks: [{ type: "command", command: buildHookCommand(adapterPaths.hookWrapperFile, "Stop", config) }],
      },
    ],
  ];
  for (const [eventName, group] of managedHooks) {
    const existingGroups = hooks[eventName] ?? [];
    hooks[eventName] = [...existingGroups, group];
  }
  next.hooks = hooks;
  return `${JSON.stringify(next, null, 2)}\n`;
};

export const renderClaudeLaunchWrapper = (config: ClaudeCodeAdapterConfig): string => `#!/usr/bin/env bash
set -euo pipefail

# Respect the config directory selected by direnv, then the legacy adapter alias.
if [[ -n "\${CLAUDE_CONFIG_DIR:-\${CLAUDE_CODE_HOME:-}}" && "\${CLAUDE_CONFIG_DIR:-\${CLAUDE_CODE_HOME:-}}" != ${shellQuote(config.hostHome)} ]]; then
  exec ${shellQuote(config.claudeBinary)} "$@"
fi

if [[ "\${ONLYBOTS_CLAUDE_WRAPPER_ACTIVE:-0}" == "1" ]]; then
  exec ${shellQuote(config.claudeBinary)} "$@"
fi

export ONLYBOTS_CLAUDE_WRAPPER_ACTIVE=1
export CLAUDE_CONFIG_DIR=${shellQuote(config.hostHome)}
export CLAUDE_CODE_HOME=${shellQuote(config.hostHome)}
export ONLYBOTS_HOME=${shellQuote(config.runtimeHome)}
export CROSSHEAD_HOME="$ONLYBOTS_HOME"
export ONLYBOTS_RUNTIME_HOME=${shellQuote(config.runtimeHome)}

if [[ -x ${shellQuote(path.join(config.runtimeHome, "bin", "onlybotsctl"))} ]]; then
  ${shellQuote(path.join(config.runtimeHome, "bin", "onlybotsctl"))} update --check-on-launch --host-pid "$$" >&2
fi
exec ${shellQuote(config.claudeBinary)} "$@"
`;

export const runCommandCapture = async (
  command: string,
  args: string[],
  cwd: string,
  maxOutputBytes = 16 * 1024 * 1024
): Promise<CommandCaptureResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let settled = false;
    const capture = (chunk: Buffer | string, stream: "stdout" | "stderr") => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      capturedBytes += bytes.byteLength;
      if (capturedBytes > maxOutputBytes) {
		settled = true;
		child.kill("SIGTERM");
		const forceKill = setTimeout(() => {
		  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, 1_000);
		forceKill.unref();
		reject(new Error(`Claude Code output exceeded the ${maxOutputBytes}-byte limit`));
		return;
      }
      if (stream === "stdout") stdout += bytes.toString("utf8");
      else stderr += bytes.toString("utf8");
    };
    child.stdout.on("data", (chunk) => {
      capture(chunk, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      capture(chunk, "stderr");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
      });
    });
  });

const buildClaudeContinuityArtifacts = (input: ClaudeCodeContinuityCapture): {
  fieldEffects: ContinuityFieldEffect[];
  redactions: ContinuityRedaction[];
  opaqueAttachments: ContinuityOpaqueAttachment[];
} => {
  const fieldEffects: ContinuityFieldEffect[] = [];
  const redactions: ContinuityRedaction[] = [];
  const opaqueAttachments: ContinuityOpaqueAttachment[] = [];

  if (typeof input.hostHome === "string" && input.hostHome.trim().length > 0) {
    redactions.push({
      field: "host.claudeHome",
      reason: "host_private_path",
      description: "Claude home paths stay host-local and are not embedded into the runtime-neutral IR.",
    });
    fieldEffects.push({
      field: "host.claudeHome",
      action: "omitted",
      category: "private_host_layout",
      reason: "Claude home paths are redacted and replaced by runtime-neutral workspace references.",
    });
  }

  if (input.projectSettingsManaged) {
    opaqueAttachments.push({
      name: "claude_project_settings",
      kind: "hook_state",
      summary: "Managed .claude/settings.json hook state is preserved opaquely for later inspection.",
    });
    fieldEffects.push({
      field: "host.projectSettings",
      action: "opaque",
      category: "host_specific_settings",
      reason: "Claude project hook settings are host-specific and not part of the canonical continuity model.",
    });
  }

  if (input.printMode) {
    fieldEffects.push({
      field: "engineAttachment.promptTransport",
      action: "downgraded",
      category: "prompt_transport",
      reason: "Claude print-mode delivery is transport-specific and must be re-materialized on import.",
    });
  }

  if (Array.isArray(input.managedFiles) && input.managedFiles.length > 0) {
    opaqueAttachments.push({
      name: "claude_managed_files",
      kind: "host_config",
      summary: input.managedFiles.map((filePath) => path.basename(filePath)).join(", "),
    });
  }

  return { fieldEffects, redactions, opaqueAttachments };
};

export const claudeCodeContinuityTranslationContract: ContinuityTranslationContract<ClaudeCodeContinuityCapture> = {
  runtime: "claude-code",
  captureContext: (input) => {
    const artifacts = buildClaudeContinuityArtifacts(input);
    return buildCapturedContinuityContext({
      ...input,
      promptTransport: input.promptTransport ?? "--append-system-prompt",
      fieldEffects: artifacts.fieldEffects,
      redactions: artifacts.redactions,
      opaqueAttachments: artifacts.opaqueAttachments,
    });
  },
  normalizeToContinuityIr: (captured, targetRuntime = null) =>
    normalizeCapturedContextToContinuityIr(captured, targetRuntime),
  materializeFromContinuityIr: (translation, targetRuntime = "claude-code") =>
    materializeContinuityIrForRuntime(translation, targetRuntime),
  reportFidelity: (translation) => translation.fidelity,
};

export const installClaudeCodeAdapter = async (
  options: ClaudeCodeAdapterInstallOptions
): Promise<ClaudeCodeAdapterInstallResult> => {
  const runtimeLayout = ensureRuntimeHomeLayout(options.home);
  const hostHome = resolveClaudeCodeHome(options.hostHome);
  const workspaceRoot = resolveClaudeWorkspaceRoot(options.workspaceRoot, runtimeLayout.home);
  const adapterPaths = resolveClaudeCodeAdapterPaths(runtimeLayout.home, hostHome, workspaceRoot);
  const profileName = options.profileName ?? "default";
  const adapterVersion = options.adapterVersion ?? ONLYBOTS_CLAUDE_CODE_ADAPTER_VERSION;
  const claudeBinary = resolveClaudeCodeBinary(runtimeLayout.home, options.claudeBinary);

  const config = buildClaudeCodeAdapterConfig({
    runtimeHome: runtimeLayout.home,
    hostHome,
    workspaceRoot,
    profileName,
    adapterVersion,
    claudeBinary,
  });

  assertManagedFilePath(adapterPaths.projectSettingsFile, workspaceRoot);
  writeManagedFile(
    adapterPaths.configFile,
    `${CLAUDE_CODE_ADAPTER_MARKER}\n${JSON.stringify(config, null, 2)}\n`,
    hostHome
  );
  writeManagedFile(
    adapterPaths.projectSettingsFile,
    renderClaudeSettingsConfig(readClaudeSettingsConfig(adapterPaths.projectSettingsFile), adapterPaths, config),
    workspaceRoot
  );
  writeManagedExecutable(adapterPaths.wrapperFile, options.bridgeScriptPath, runtimeLayout.home);
  writeManagedExecutable(adapterPaths.hookWrapperFile, options.hookScriptPath, runtimeLayout.home);
  writeManagedExecutable(path.join(config.runtimeHome, "bin", "onlybots-claude-code"), options.bridgeScriptPath, runtimeLayout.home);
  writeManagedExecutable(path.join(config.runtimeHome, "bin", "onlybots-claude-code-hook"), options.hookScriptPath, runtimeLayout.home);
  writeManagedFile(adapterPaths.claudeLaunchWrapperFile, renderClaudeLaunchWrapper(config), runtimeLayout.home);
  chmodSync(adapterPaths.claudeLaunchWrapperFile, 0o755);

  const managedFiles = [
    adapterPaths.configFile,
    adapterPaths.projectSettingsFile,
    adapterPaths.wrapperFile,
    adapterPaths.hookWrapperFile,
    path.join(config.runtimeHome, "bin", "onlybots-claude-code"),
    path.join(config.runtimeHome, "bin", "onlybots-claude-code-hook"),
    adapterPaths.claudeLaunchWrapperFile,
  ];
  const existingRecord = upsertRuntimeAdapterRecord(options.home, {
    name: "claude-code",
    version: adapterVersion,
    runtimeVersion: ONLYBOTS_RUNTIME_CORE_VERSION,
    status: "installed",
    profileName,
    hostHome,
    managedFiles,
    lastError: null,
    installedAt: nowIso(),
    updatedAt: nowIso(),
  });

  return {
    adapter: existingRecord,
    config,
    managedFiles,
  };
};

export const uninstallClaudeCodeAdapter = async (
  options: ClaudeCodeAdapterUninstallOptions = {}
): Promise<string[]> => {
  const runtimeHome = resolveRuntimeHome(options.home);
  const hostHome = resolveClaudeCodeHome(options.hostHome);
  const adapterConfig = existsSync(configFile(hostHome)) ? loadClaudeCodeAdapterConfig(runtimeHome, hostHome) : null;
  const workspaceRoot = adapterConfig?.workspaceRoot ?? resolveClaudeWorkspaceRoot(undefined, runtimeHome);
  const candidateFiles = [
    configFile(hostHome),
    projectSettingsFile(workspaceRoot),
    path.join(runtimeHome, "bin", "crosshead-claude-code"),
    path.join(runtimeHome, "bin", "crosshead-claude-code-hook"),
    path.join(runtimeHome, "bin", "onlybots-claude-code"),
    path.join(runtimeHome, "bin", "onlybots-claude-code-hook"),
    path.join(runtimeHome, "bin", "claude"),
  ];
  const removed: string[] = [];
  for (const filePath of candidateFiles) {
    if (!existsSync(filePath)) {
      continue;
    }
    if (filePath === projectSettingsFile(workspaceRoot)) {
      const filtered = filterManagedClaudeHooks(readClaudeSettingsConfig(filePath), path.join(runtimeHome, "bin", "crosshead-claude-code-hook"));
      if (Object.keys(filtered).length > 0) {
		writeManagedFile(filePath, `${JSON.stringify(filtered, null, 2)}\n`, workspaceRoot);
      } else {
        rmSync(filePath, { force: true });
        removed.push(filePath);
      }
      continue;
    }
    if (["onlybots-claude-code", "onlybots-claude-code-hook", "crosshead-claude-code", "crosshead-claude-code-hook", "claude"].includes(path.basename(filePath)) || isManagedContent(filePath)) {
      rmSync(filePath, { force: true });
      removed.push(filePath);
    }
  }
  removeRuntimeAdapterRecord(options.home, "claude-code");
  return removed;
};

export const loadClaudeCodeAdapterConfig = (
  runtimeHomeInput?: string,
  hostHomeInput?: string
): ClaudeCodeAdapterConfig => {
  const filePath = configFile(resolveClaudeCodeHome(hostHomeInput));
  if (!existsSync(filePath)) {
    throw new Error("Claude Code adapter is not installed");
  }
  const content = readFileSync(filePath, "utf8").replace(`${CLAUDE_CODE_ADAPTER_MARKER}\n`, "");
  const parsed = JSON.parse(content) as ClaudeCodeAdapterConfig;
  if (parsed.marker !== CLAUDE_CODE_MANAGED_CONFIG_MARKER) {
    throw new Error("Claude Code adapter config is not managed by Crosshead");
  }
  if (runtimeHomeInput && parsed.runtimeHome !== resolveRuntimeHome(runtimeHomeInput)) {
    return {
      ...parsed,
      runtimeHome: resolveRuntimeHome(runtimeHomeInput),
    };
  }
  return parsed;
};

const CLAUDE_CODE_ADAPTER_IDENTITY: HostAdapterIdentity = {
  runtimeId: "claude-code",
  wrapperVersionFallback: "claude-code-wrapper",
  requestLabel: "Claude Code",
};

export class ClaudeCodeRuntimeAdapter extends HostRuntimeAdapterBase {
  static readonly continuityTranslationContract = claudeCodeContinuityTranslationContract;

  protected readonly identity = CLAUDE_CODE_ADAPTER_IDENTITY;

  constructor(
    protected readonly client: LocalRuntimeClient,
    protected readonly config: ClaudeCodeAdapterConfig
  ) {
    super();
  }

  static fromInstalled(options: { home?: string; hostHome?: string } = {}): ClaudeCodeRuntimeAdapter {
    const config = loadClaudeCodeAdapterConfig(options.home, options.hostHome);
    return new ClaudeCodeRuntimeAdapter(
      new LocalRuntimeClient({
        home: config.runtimeHome,
        timeoutMs: 30_000,
      }),
      config
    );
  }

  protected async attachWorkspace(input: {
    profileName?: string;
    workspaceRoot: string;
    workspaceId: string;
    hostHome?: string;
    hostVersion?: string;
  }): Promise<void> {
    await this.client.attachAdapter({
      adapterName: "claude-code",
      adapterVersion: this.config.adapterVersion,
      runtimeVersion: ONLYBOTS_RUNTIME_CORE_VERSION,
      profileName: input.profileName ?? this.config.profileName,
      hostHome: input.hostHome ?? this.config.hostHome,
      managedFiles: [
        configFile(this.config.hostHome),
        projectSettingsFile(this.config.workspaceRoot),
        path.join(this.config.runtimeHome, "bin", "crosshead-claude-code"),
        path.join(this.config.runtimeHome, "bin", "crosshead-claude-code-hook"),
        path.join(this.config.runtimeHome, "bin", "onlybots-claude-code"),
        path.join(this.config.runtimeHome, "bin", "onlybots-claude-code-hook"),
        path.join(this.config.runtimeHome, "bin", "claude"),
      ].filter((entry) => existsSync(entry)),
      manifest: createWorkspaceManifest(
        input.workspaceRoot,
        input.workspaceId,
        "claude-code",
        input.hostVersion ?? "claude-code-wrapper"
      ),
    });
  }











  async searchMemory(
    query: string,
    profileName?: string,
    topK: number = 10,
    includeSystemMemory: boolean = false
  ): Promise<Record<string, unknown>> {
    return this.client.searchMemory({
      profileName: profileName ?? this.config.profileName,
      query,
      top_k: topK,
      include_system: includeSystemMemory,
    });
  }

  async exportMemory(profileName?: string): Promise<Record<string, unknown>> {
    return this.client.exportMemory(profileName ?? this.config.profileName);
  }

  async readHotMemory(profileName?: string, scope?: string): Promise<Record<string, unknown>> {
    return this.client.readHotMemory(profileName ?? this.config.profileName, scope);
  }

  async listWarmMemory(
    profileName?: string,
    filter: { type?: string; status?: string; includeSystemMemory?: boolean } = {}
  ): Promise<Record<string, unknown>> {
    return this.client.listWarmMemory(profileName ?? this.config.profileName, filter);
  }

  async inspectInboxState(
    profileName?: string,
    filter: {
      statuses?: string[];
      priorities?: string[];
      contextId?: string;
      messageType?: string;
      unreadOnly?: boolean;
      includeTerminal?: boolean;
      limit?: number;
    } = {}
  ): Promise<Record<string, unknown>> {
    return this.client.inspectInboxState(profileName ?? this.config.profileName, filter);
  }

  async replayInboxItem(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.replayInboxItem(body);
  }

  async acknowledgeInboxItem(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.acknowledgeInboxItem(body);
  }

  async resolveInboxItem(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.resolveInboxItem(body);
  }

  async createHandoff(input: ClaudeCodeAdapterHandoffCreateRequest): Promise<ClaudeCodeAdapterHandoffCreateResult> {
    const profileName = input.profileName ?? this.config.profileName;
    const needsHotSummary = !input.memory?.hotSummary;
    const needsWarmIds = !input.memory?.warmIds || input.memory.warmIds.length === 0;
    const needsJudgment =
      !input.memory?.selfModelIds ||
      input.memory.selfModelIds.length === 0 ||
      !input.reasoning?.currentTheory ||
      !input.reasoning?.openQuestions ||
      input.reasoning.openQuestions.length === 0 ||
      !input.reasoning?.rejectedPaths ||
      !input.reasoning.unresolvedRisks;
    const needsIdentity = !input.identity?.npub;
    const needsPolicyRef = !input.policy?.policyRef;

    const [hot, warm, judgment, status] = await Promise.all([
      needsHotSummary ? this.client.readHotMemory(profileName) : Promise.resolve(null),
      needsWarmIds ? this.client.listWarmMemory(profileName, { status: "active" }) : Promise.resolve(null),
      needsJudgment ? this.client.inspectContinuityJudgment(profileName) : Promise.resolve(null),
      needsIdentity || needsPolicyRef ? this.client.status(profileName) : Promise.resolve(null),
    ]);

    const snapshot =
      judgment?.snapshot && typeof judgment.snapshot === "object" && !Array.isArray(judgment.snapshot)
        ? (judgment.snapshot as Record<string, unknown>)
        : null;
    const projectModel =
      snapshot?.projectModel && typeof snapshot.projectModel === "object" && !Array.isArray(snapshot.projectModel)
        ? (snapshot.projectModel as Record<string, unknown>)
        : null;
    const approvedSelfModelIds = Array.isArray(judgment?.selfModelEntries)
      ? (judgment.selfModelEntries as Array<Record<string, unknown>>)
          .filter((entry) => {
            const payload =
              entry.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)
                ? (entry.payload as Record<string, unknown>)
                : null;
            return entry.status === "active" && payload?.review && typeof payload.review === "object" && !Array.isArray(payload.review)
              ? (payload.review as Record<string, unknown>).state === "approved"
              : false;
          })
          .map((entry) => (typeof entry.warmEntryId === "string" ? entry.warmEntryId : null))
          .filter((entry): entry is string => entry !== null)
      : [];
    const activeWarmIds = listWarmIds(warm?.entries);
    const managedFiles = [
      configFile(this.config.hostHome),
      projectSettingsFile(this.config.workspaceRoot),
      path.join(this.config.runtimeHome, "bin", "crosshead-claude-code"),
      path.join(this.config.runtimeHome, "bin", "crosshead-claude-code-hook"),
        path.join(this.config.runtimeHome, "bin", "onlybots-claude-code"),
        path.join(this.config.runtimeHome, "bin", "onlybots-claude-code-hook"),
      path.join(this.config.runtimeHome, "bin", "claude"),
    ].filter((entry) => existsSync(entry));

    const enrichedCapture: ClaudeCodeContinuityCapture = {
      runtime: "claude-code",
      ...input,
      hostHome: input.hostHome ?? this.config.hostHome,
      hostVersion: input.hostVersion ?? "claude-code-wrapper",
      identity: {
        agentId: input.identity?.agentId ?? (status?.profile && typeof status.profile === "object" ? "crosshead-claude-code" : null),
        npub:
          input.identity?.npub ??
          (status?.profile && typeof status.profile === "object" && !Array.isArray(status.profile)
            ? sanitizeString((status.profile as Record<string, unknown>).npub)
            : null),
        lineageRoot: input.identity?.lineageRoot ?? input.identity?.agentId ?? "crosshead-claude-code",
      },
      reasoning: {
        currentTheory:
          input.reasoning?.currentTheory ??
          (projectModel ? summarizeJudgmentEntries(projectModel.currentDirection)[0] ?? null : null),
        openQuestions: input.reasoning?.openQuestions ?? (projectModel ? summarizeJudgmentEntries(projectModel.openQuestions) : []),
        rejectedPaths:
          input.reasoning?.rejectedPaths ?? (projectModel ? summarizeJudgmentEntries(projectModel.rejectedAlternatives) : []),
        unresolvedRisks:
          input.reasoning?.unresolvedRisks ?? (projectModel ? summarizeJudgmentEntries(projectModel.unresolvedRisks) : []),
        portabilityNotes: input.reasoning?.portabilityNotes ?? [
          "Exported from the live Claude Code runtime so Codex can resume with explicit continuity gaps.",
        ],
        nextAction: input.reasoning?.nextAction ?? null,
      },
      memory: {
        hotSummary: input.memory?.hotSummary ?? summarizeHotMemory(hot?.content),
        warmIds: input.memory?.warmIds ?? activeWarmIds,
        coldChunkIds: input.memory?.coldChunkIds ?? [],
        projectModelIds: input.memory?.projectModelIds ?? [],
        userModelIds: input.memory?.userModelIds ?? [],
        selfModelIds: input.memory?.selfModelIds ?? approvedSelfModelIds,
      },
      policy: {
        policyRef: input.policy?.policyRef ?? extractContinuityPolicyRef(status?.continuity),
        continuityPolicy: input.policy?.continuityPolicy ?? "shared-runtime",
        enforcementHints: input.policy?.enforcementHints ?? [],
        memoryScope: {
          allowedWorkspaces: input.policy?.memoryScope?.allowedWorkspaces ?? [],
          allowedTrustZones: input.policy?.memoryScope?.allowedTrustZones ?? [],
        },
      },
      delegation: {
        whyTransfer:
          input.delegation?.whyTransfer ??
          "Continue execution in Codex while preserving the current Crosshead continuity state.",
        requestedCapabilities: input.delegation?.requestedCapabilities ?? ["repo_execution", "tool_use"],
        recommendedTarget: "codex",
      },
      economics: {
        budgetRemainingSats: input.economics?.budgetRemainingSats ?? null,
        costSoFarSats: input.economics?.costSoFarSats ?? null,
        budgetHints:
          input.economics?.budgetHints ?? ["Prefer the signed capsule plus referenced memory instead of rewriting context by hand."],
      },
      printMode: input.printMode ?? false,
      projectSettingsManaged: input.projectSettingsManaged ?? true,
      promptTransport: input.promptTransport ?? "--append-system-prompt",
      managedFiles: input.managedFiles ?? managedFiles,
    };

    const capture = claudeCodeContinuityTranslationContract.captureContext(enrichedCapture);
    const translation = claudeCodeContinuityTranslationContract.normalizeToContinuityIr(capture, input.targetRuntime ?? "codex");
    const materialization = claudeCodeContinuityTranslationContract.materializeFromContinuityIr(translation, "codex");
    const plainTextSummary = buildPlainTextContinuationSummary(translation, "codex");
    const restatementComparison = compareContinuityRestatement(materialization.startupContext, translation, "codex");
    const created = (await this.client.createHandoff({
      translation,
      maxBytes: input.maxBytes,
    })) as { handoff?: HandoffStoredRecord };
    const record =
      created.handoff && typeof created.handoff === "object" && !Array.isArray(created.handoff)
        ? (created.handoff as HandoffStoredRecord)
        : (created as unknown as HandoffStoredRecord);

    return {
      capture,
      translation,
      materialization,
      plainTextSummary,
      restatementComparison,
      record,
    };
  }

  async importHandoff(input: ClaudeCodeAdapterHandoffImportRequest): Promise<ClaudeCodeAdapterHandoffImportResult> {
    const workspaceRoot = String(input.workspaceRoot ?? "").trim();
    const workspaceId = input.workspaceId ?? `repo:${workspaceRoot}`;
    const sessionId = String(input.sessionId ?? "").trim();
    const handoffId = sanitizeString(input.handoffId);
    const accepted = input.accepted !== false;
    const rejectionReason = (reason: string): string => (input.note ? `${reason} ${input.note}` : reason);

    const rejectStoredHandoff = async (reason: string): Promise<ClaudeCodeAdapterHandoffImportResult> => {
      const baseVerification: HandoffVerificationResult = {
        valid: false,
        signatureValid: false,
        payloadHashMatches: false,
        withinBudget: false,
        errors: [reason],
        warnings: [],
        sourceRuntime: "codex",
        targetRuntime: "claude-code",
        signedBy: null,
        sizeBytes: null,
      };
      const baseInspection: HandoffInspection = {
        handoffId: handoffId ?? "unknown",
        capsuleVersion: "unknown",
        capsuleKind: "unknown",
        sourceRuntime: "codex",
        targetRuntime: "claude-code",
        signedBy: "",
        createdAt: nowIso(),
        task: {
          objective: "unknown",
          openLoops: [],
        },
        reasoning: {
          currentTheory: null,
          openQuestions: [],
        },
        references: {
          hotMemory: "omitted",
          warmCount: 0,
          coldCount: 0,
          projectModelCount: 0,
          userModelCount: 0,
          selfModelCount: 0,
        },
        redactionCount: 0,
        opaqueAttachmentCount: 0,
        fidelity: {
          level: "minimal",
          categories: [],
          summary: reason,
        },
        continuation: {
          carriedForward: [],
          referenceOnly: [],
          manualReestablishment: [reason],
          cautions: [reason],
        },
        sizeBudget: {
          maxBytes: 0,
          actualBytes: 0,
          withinBudget: false,
        },
        warnings: [reason],
      };

      if (!handoffId) {
        return {
          handoffId: null,
          accepted: false,
          verification: baseVerification,
          inspection: baseInspection,
          materialization: null,
          plainTextSummary: null,
          restatementComparison: null,
          receipt: null,
          record: null,
        };
      }

      const updated = (await this.client.acknowledgeHandoff({
        handoffId,
        accepted: false,
        note: rejectionReason(reason),
        receipt: {
          receiverRuntime: "claude-code",
          receiverSessionId: sessionId || null,
          receiverWorkspaceId: workspaceRoot ? workspaceId : null,
          note: rejectionReason(reason),
          warnings: [reason],
          manualReestablishment: [reason],
        },
      })) as HandoffStoredRecord;

      return {
        handoffId,
        accepted: false,
        verification: updated.validation,
        inspection: updated.inspection,
        materialization: null,
        plainTextSummary: null,
        restatementComparison: null,
        receipt: updated.receipt,
        record: updated,
      };
    };

    if (workspaceRoot.length === 0) {
      return rejectStoredHandoff("Claude Code handoff import requires workspaceRoot");
    }
    if (sessionId.length === 0) {
      return rejectStoredHandoff("Claude Code handoff import requires sessionId");
    }

    await this.attachWorkspace({
      profileName: input.profileName,
      workspaceRoot,
      workspaceId,
      hostHome: input.hostHome,
      hostVersion: input.hostVersion ?? "claude-code-wrapper",
    });

    const storedRecord =
      handoffId !== null ? ((await this.client.readHandoff(handoffId)) as HandoffStoredRecord) : null;
    const capsule =
      input.capsule ??
      (storedRecord?.capsule && typeof storedRecord.capsule === "object" && !Array.isArray(storedRecord.capsule)
        ? storedRecord.capsule
        : null);

    if (!capsule) {
      return rejectStoredHandoff("Claude Code handoff import requires a stored handoff id or raw capsule");
    }

    // A stored record is only transport. The local client must verify the exact
    // capsule bytes before any hosted or persisted validation metadata is used.
    const verification = (await this.client.verifyHandoff({ capsule })) as HandoffVerificationResult;
    const inspection = (await this.client.inspectHandoff({ capsule })) as HandoffInspection;

    if (!verification.valid) {
      return rejectStoredHandoff(`Claude Code handoff import rejected an invalid capsule: ${verification.errors.join(" | ")}`);
    }
    if (capsule.sourceRuntime !== "codex") {
      return rejectStoredHandoff(`Claude Code import only accepts Codex-origin handoffs, received ${capsule.sourceRuntime}`);
    }
    if (capsule.targetRuntime !== "claude-code") {
      return rejectStoredHandoff(`Claude Code import requires targetRuntime=claude-code, received ${capsule.targetRuntime}`);
    }
    if (!accepted) {
      return rejectStoredHandoff(input.note?.trim().length ? input.note.trim() : "Operator rejected the handoff during Claude Code import.");
    }

    const translation: ContinuityTranslationResult = {
      sourceRuntime: capsule.sourceRuntime,
      targetRuntime: capsule.targetRuntime,
      ir: capsule.continuityIr,
      fieldEffects: [],
      opaqueAttachments: capsule.opaqueAttachments,
      redactions: capsule.redactions,
      fidelity: capsule.fidelity,
    };
    const materialization = claudeCodeContinuityTranslationContract.materializeFromContinuityIr(translation, "claude-code");
    const plainTextSummary = buildPlainTextContinuationSummary(translation, "claude-code");
    const restatementComparison = compareContinuityRestatement(materialization.startupContext, translation, "claude-code");
    const updated =
      handoffId === null
        ? null
        : ((await this.client.acknowledgeHandoff({
            handoffId,
            accepted: true,
            note:
              sanitizeString(input.note) ??
              `Imported into Claude Code session ${sessionId} for workspace ${workspaceId}.`,
            receipt: {
              receiverRuntime: "claude-code",
              receiverSessionId: sessionId,
              receiverWorkspaceId: workspaceId,
              note: sanitizeString(input.note) ?? "Claude Code import accepted the handoff.",
              delivery: materialization.delivery,
              warnings: materialization.warnings,
              manualReestablishment: materialization.continuationPlan.manualReestablishment,
            },
          })) as HandoffStoredRecord);

    return {
      handoffId,
      accepted: true,
      verification,
      inspection,
      materialization,
      plainTextSummary,
      restatementComparison,
      receipt: updated?.receipt ?? null,
      record: updated,
    };
  }

  async runPrintPrompt(input: ClaudeCodePrintRequest): Promise<ClaudeCodePrintResult> {
    const workspaceId = input.workspaceId ?? `repo:${input.workspaceRoot}`;
    await this.sessionStarted({
      profileName: input.profileName,
      workspaceRoot: input.workspaceRoot,
      workspaceId,
      hostHome: input.hostHome,
      hostVersion: input.hostVersion ?? "claude-cli",
      sessionId: input.sessionId,
    });

    const prepared = await this.prepareTurn({
      ...input,
      workspaceId,
      hostVersion: input.hostVersion ?? "claude-cli",
    });

    const command = [input.claudeBin ?? this.config.claudeBinary, "--print"];
    if (typeof input.model === "string" && input.model.trim().length > 0) {
      command.push("--model", input.model.trim());
    }
    if (prepared.contextText.trim().length > 0) {
      command.push("--append-system-prompt", prepared.contextText.trim());
    }
    if (Array.isArray(input.claudeArgs)) {
      command.push(...input.claudeArgs);
    }
    command.push(input.prompt);

    let result: CommandCaptureResult;
    try {
      result = await runCommandCapture(command[0]!, command.slice(1), input.workspaceRoot);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      await this.failTurn({
        profileName: input.profileName,
        workspaceRoot: input.workspaceRoot,
        workspaceId,
        hostVersion: input.hostVersion ?? "claude-cli",
        sessionId: input.sessionId,
        turnId: input.turnId,
        packId: prepared.packId,
        goal: input.prompt,
        summary,
        transcript: input.transcript ?? [{ role: "user", content: input.prompt }],
      });
      throw new Error(`Claude Code launch failed: ${summary}`);
    }

    if (result.exitCode !== 0) {
      const summary =
        result.stderr.trim().length > 0 ? result.stderr.trim() : `Claude Code exited with code ${result.exitCode}`;
      await this.failTurn({
        profileName: input.profileName,
        workspaceRoot: input.workspaceRoot,
        workspaceId,
        hostVersion: input.hostVersion ?? "claude-cli",
        sessionId: input.sessionId,
        turnId: input.turnId,
        packId: prepared.packId,
        goal: input.prompt,
        summary,
        transcript: input.transcript ?? [{ role: "user", content: input.prompt }],
      });
      throw new Error(summary);
    }

    const assistantText = result.stdout.trim().length > 0 ? result.stdout.trim() : "Claude Code completed the request.";
    await this.completeTurn({
      profileName: input.profileName,
      workspaceRoot: input.workspaceRoot,
      workspaceId,
      hostVersion: input.hostVersion ?? "claude-cli",
      sessionId: input.sessionId,
      turnId: input.turnId,
      packId: prepared.packId,
      goal: input.prompt,
      summary: assistantText,
      transcript: [
        ...(input.transcript ?? [{ role: "user", content: input.prompt }]),
        { role: "assistant", content: assistantText },
      ],
    });

    return {
      ...prepared,
      stdout: result.stdout,
      stderr: result.stderr,
      command,
    };
  }
}

export const installClaudeCodeFromCli = async (
  argv: string[],
  bridgeScriptPath: string,
  hookScriptPath: string
): Promise<string> => {
  const { flags } = parseArgs(argv);
  const result = await installClaudeCodeAdapter({
    home: typeof flags.home === "string" ? flags.home : undefined,
    hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
    workspaceRoot: typeof flags["workspace-root"] === "string" ? flags["workspace-root"] : undefined,
    profileName: typeof flags.profile === "string" ? flags.profile : "default",
    adapterVersion: typeof flags.version === "string" ? flags.version : undefined,
    bridgeScriptPath,
    hookScriptPath,
    claudeBinary: typeof flags["claude-bin"] === "string" ? flags["claude-bin"] : undefined,
  });
  return [
    `Installed Claude Code adapter ${result.adapter.version}`,
    `runtime_home: ${result.config.runtimeHome}`,
    `claude_home: ${result.config.hostHome}`,
    `workspace_root: ${result.config.workspaceRoot}`,
    `claude_bin: ${result.config.claudeBinary}`,
  ].join("\n");
};

export const uninstallClaudeCodeFromCli = async (argv: string[]): Promise<string> => {
  const { flags } = parseArgs(argv);
  const removed = await uninstallClaudeCodeAdapter({
    home: typeof flags.home === "string" ? flags.home : undefined,
    hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
  });
  return removed.length === 0
    ? "Claude Code adapter was already absent"
    : `Removed Claude Code adapter files:\n${removed.join("\n")}`;
};
