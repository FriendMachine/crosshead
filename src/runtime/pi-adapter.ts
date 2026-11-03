import { existsSync, readFileSync, rmSync } from "fs";
import path from "path";

import type { OperatorWorkspaceManifest } from "./operator-policy";
import { LocalRuntimeClient } from "./local-client";
import { isLocalOnlyRuntimeProfile } from "./local-hot-memory";
import {
  ONLYBOTS_RUNTIME_CORE_VERSION,
  ensureRuntimeHomeLayout,
  removeRuntimeAdapterRecord,
  resolveRuntimeHome,
  type RuntimeAdapterRecord,
  upsertRuntimeAdapterRecord,
} from "./local-runtime";
import { nowIso, parseArgs, writeManagedFile } from "./adapter-utils";
import { buildRuntimeStartupFreshness, renderRuntimeStartupContext } from "./startup-context";
import { loadProfile } from "./runtime-persistence";

export const ONLYBOTS_PI_ADAPTER_VERSION = "0.3.0";
export const PI_GOVERNED_SYNTHETIC_REPOSITORY_MANIFEST_PROFILE =
  "governed-synthetic-repository-v1" as const;
export type PiEmbeddedWorkspaceManifestProfile =
  | "interactive-default"
  | typeof PI_GOVERNED_SYNTHETIC_REPOSITORY_MANIFEST_PROFILE;

const PI_ADAPTER_MARKER = "__onlybots_pi_adapter__";

export type PiAdapterConfig = {
  marker: string;
  adapterName: "pi";
  adapterVersion: string;
  runtimeHome: string;
  profileName: string;
  embeddedMode: true;
  installedAt: string;
  updatedAt: string;
};

export type PiAdapterPaths = {
  runtimeHome: string;
  configDirectory: string;
  configFile: string;
};

export type PiAdapterInstallOptions = {
  home?: string;
  profileName?: string;
  adapterVersion?: string;
};

export type PiAdapterInstallResult = {
  adapter: RuntimeAdapterRecord;
  config: PiAdapterConfig;
  managedFiles: string[];
};

export type PiAdapterUninstallOptions = {
  home?: string;
};

export type PiEmbeddedTurnPrepareResult = {
  packId: string | null;
  contextText: string;
  injectedPrompt: string;
  warnings: string[];
};

export type PiEmbeddedExecutorRequest = PiEmbeddedTurnPrepareResult & {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  prompt: string;
  signal?: AbortSignal;
  transcript: Array<{
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    timestamp?: string;
  }>;
};

export type PiEmbeddedExecutorResult = {
  output: string;
  transcript?: Array<{
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    timestamp?: string;
  }>;
  tools?: Array<{
    toolName: string;
    summary: string;
  }>;
  task?: {
    title: string;
    summary?: string;
  };
  newFact?: string | string[];
  newCommitment?: string | string[];
};

export type PiEmbeddedRuntimeOptions = {
  home?: string;
  profileName?: string;
  workspaceRoot: string;
  workspaceId?: string;
  sessionId: string;
  hostVersion?: string;
  workspaceManifestProfile?: PiEmbeddedWorkspaceManifestProfile;
  executor: (request: PiEmbeddedExecutorRequest) => Promise<PiEmbeddedExecutorResult>;
};

export type PiEmbeddedRunResult = PiEmbeddedTurnPrepareResult & {
  output: string;
};

export type PiRememberRequest = {
  entryType?: "fact" | "commitment" | "correction" | "pattern";
  content: string;
  tags?: string[];
};

const configFile = (runtimeHome: string): string => path.join(runtimeHome, "config", "embedded", "pi-adapter.json");

export const resolvePiAdapterPaths = (runtimeHomeInput?: string): PiAdapterPaths => {
  const runtimeHome = resolveRuntimeHome(runtimeHomeInput);
  return {
    runtimeHome,
    configDirectory: path.dirname(configFile(runtimeHome)),
    configFile: configFile(runtimeHome),
  };
};

const buildPiAdapterConfig = (options: {
  runtimeHome: string;
  profileName: string;
  adapterVersion: string;
}): PiAdapterConfig => ({
  marker: PI_ADAPTER_MARKER,
  adapterName: "pi",
  adapterVersion: options.adapterVersion,
  runtimeHome: options.runtimeHome,
  profileName: options.profileName,
  embeddedMode: true,
  installedAt: nowIso(),
  updatedAt: nowIso(),
});

export const createPiWorkspaceManifest = (
  workspaceRoot: string,
  workspaceId: string,
  hostVersion: string,
  profile: PiEmbeddedWorkspaceManifestProfile = "interactive-default"
): OperatorWorkspaceManifest =>
  profile === PI_GOVERNED_SYNTHETIC_REPOSITORY_MANIFEST_PROFILE
    ? {
	manifestVersion: "1",
	tenantId: "local-organizational-worker",
	workspaceId,
	runClass: "one_shot",
	runtimeId: "pi-embedded-synthetic-repository-v1",
	runtimeVersion: "pi-embedded-synthetic-repository-v1",
	workspaceRoot,
	readOnlyMounts: [],
	scratchMounts: [],
	stateMounts: [],
	ipcMounts: [],
	extraMounts: [],
	requestedSecretRefs: [],
	rawSecretEnvKeys: [],
	requestedAt: nowIso(),
      }
    : {
	manifestVersion: "1",
	tenantId: "local-operator",
	workspaceId,
	runClass: "interactive",
	runtimeId: "pi",
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
	    name: "pi-runtime",
	    targetPath: "/ipc",
	  },
	],
	requestedSecretRefs: ["nostr_identity", "onlybots_session"],
	requestedAt: nowIso(),
      };

const renderInjectedPrompt = (prompt: string, contextText: string): string =>
  contextText.trim().length === 0
    ? prompt
    : `Crosshead runtime context:\n${contextText.trim()}\n\nCurrent Pi request:\n${prompt}`;

export const installPiAdapter = async (options: PiAdapterInstallOptions = {}): Promise<PiAdapterInstallResult> => {
  const runtimeLayout = ensureRuntimeHomeLayout(options.home);
  const adapterPaths = resolvePiAdapterPaths(runtimeLayout.home);
  const profileName = options.profileName ?? "default";
  const adapterVersion = options.adapterVersion ?? ONLYBOTS_PI_ADAPTER_VERSION;
  const config = buildPiAdapterConfig({
    runtimeHome: runtimeLayout.home,
    profileName,
    adapterVersion,
  });

  writeManagedFile(adapterPaths.configFile, `${JSON.stringify(config, null, 2)}\n`, runtimeLayout.home);

  const managedFiles = [adapterPaths.configFile];
  const existingRecord = upsertRuntimeAdapterRecord(options.home, {
    name: "pi",
    version: adapterVersion,
    runtimeVersion: ONLYBOTS_RUNTIME_CORE_VERSION,
    status: "installed",
    profileName,
    hostHome: null,
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

export const uninstallPiAdapter = async (options: PiAdapterUninstallOptions = {}): Promise<string[]> => {
  const runtimeHome = resolveRuntimeHome(options.home);
  const filePath = configFile(runtimeHome);
  const removed: string[] = [];
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
    removed.push(filePath);
  }
  removeRuntimeAdapterRecord(options.home, "pi");
  return removed;
};

const loadPiAdapterConfig = (runtimeHomeInput?: string): PiAdapterConfig => {
  const filePath = configFile(resolveRuntimeHome(runtimeHomeInput));
  if (!existsSync(filePath)) {
    throw new Error("Pi adapter is not installed");
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as PiAdapterConfig;
  if (parsed.marker !== PI_ADAPTER_MARKER) {
    throw new Error("Pi adapter config is not managed by Crosshead");
  }
  if (runtimeHomeInput && parsed.runtimeHome !== resolveRuntimeHome(runtimeHomeInput)) {
    return {
      ...parsed,
      runtimeHome: resolveRuntimeHome(runtimeHomeInput),
    };
  }
  return parsed;
};

export class PiEmbeddedRuntime {
  private readonly client: LocalRuntimeClient;
  private readonly config: PiAdapterConfig;
  private readonly workspaceRoot: string;
  private readonly workspaceId: string;
  private readonly sessionId: string;
  private readonly hostVersion: string;
  private readonly workspaceManifestProfile: PiEmbeddedWorkspaceManifestProfile;
  private readonly executor: (request: PiEmbeddedExecutorRequest) => Promise<PiEmbeddedExecutorResult>;
  private started = false;

  constructor(options: PiEmbeddedRuntimeOptions) {
    const loadedConfig = loadPiAdapterConfig(options.home);
    this.config = options.profileName ? { ...loadedConfig, profileName: options.profileName } : loadedConfig;
    this.client = new LocalRuntimeClient({
      home: this.config.runtimeHome,
      timeoutMs: 30_000,
    });
    this.workspaceRoot = options.workspaceRoot;
    this.workspaceId = options.workspaceId ?? `repo:${options.workspaceRoot}`;
    this.sessionId = options.sessionId;
    this.hostVersion = options.hostVersion ?? "pi-embedded";
    this.workspaceManifestProfile =
      options.workspaceManifestProfile ?? "interactive-default";
    if (
      this.workspaceManifestProfile ===
      PI_GOVERNED_SYNTHETIC_REPOSITORY_MANIFEST_PROFILE
    ) {
      const profile = loadProfile(
	ensureRuntimeHomeLayout(this.config.runtimeHome),
	this.config.profileName
      );
      if (!profile || !isLocalOnlyRuntimeProfile(profile)) {
	throw new Error(
	  "the governed synthetic Pi executor requires a local-only runtime profile"
	);
      }
    }
    this.executor = options.executor;
  }

  private async attachWorkspace(): Promise<void> {
    await this.client.attachAdapter({
      adapterName: "pi",
      adapterVersion: this.config.adapterVersion,
      runtimeVersion: ONLYBOTS_RUNTIME_CORE_VERSION,
      profileName: this.config.profileName,
      hostHome: null,
      managedFiles: [configFile(this.config.runtimeHome)].filter((entry) => existsSync(entry)),
      manifest: createPiWorkspaceManifest(
	this.workspaceRoot,
	this.workspaceId,
	this.hostVersion,
	this.workspaceManifestProfile
      ),
    });
  }

  async startSession(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.attachWorkspace();
    await this.client.emitEvent({
      runtime: "pi",
      profileName: this.config.profileName,
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      type: "session.started",
      payload: {
        embedded: true,
      },
      metadata: {
        hostVersion: this.hostVersion,
        adapterVersion: this.config.adapterVersion,
      },
    });
    this.started = true;
  }

  async prepareTurn(input: {
    turnId: string;
    prompt: string;
    observedAt?: string;
    previousContextReadAt?: string | null;
    transcript?: Array<{
      role: "user" | "assistant" | "system" | "tool";
      content: string;
      timestamp?: string;
    }>;
  }): Promise<PiEmbeddedTurnPrepareResult> {
    await this.startSession();
    const observedAt = input.observedAt ?? nowIso();
    const preTurnHotMemory = await this.client.readHotMemory(this.config.profileName, "all").catch(() => null);
    const response = await this.client.emitEvent({
      runtime: "pi",
      profileName: this.config.profileName,
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      turnId: input.turnId,
      type: "turn.started",
      payload: {
        goal: input.prompt,
        transcript: input.transcript ?? [],
				allowedScope: {
					includeHotMemory: true,
					includeWarmMemory: false,
					includeColdMemory: false,
					includeLayeredContext: false,
				},
				includeResumeBrief: false,
				budget: {
					maxFragments: 3,
					maxTokens: 360,
				},
				hotMemorySnapshot: preTurnHotMemory ?? { scope: "all", scopes: [] },
      },
      metadata: {
        hostVersion: this.hostVersion,
        adapterVersion: this.config.adapterVersion,
      },
    });
    const contextPack =
      response.contextPack && typeof response.contextPack === "object" && !Array.isArray(response.contextPack)
        ? response.contextPack
        : null;
    const packId = contextPack && typeof contextPack.packId === "string" ? contextPack.packId : null;
    const freshness = buildRuntimeStartupFreshness({
      runtime: "pi",
      observedAt,
      previousContextReadAt: input.previousContextReadAt ?? null,
      hotMemory: preTurnHotMemory,
    });
    const contextText = renderRuntimeStartupContext({
      runtime: "pi",
      profileName: this.config.profileName,
      mode: response.mode,
      status: null,
      manifest: null,
      inbox: null,
      dreamReview: null,
      obligations: null,
      actions: [],
      warnings: [],
      injectedContext: "",
      freshness,
      hotMemorySnapshot: preTurnHotMemory,
    });
    return {
      packId,
      contextText,
      injectedPrompt: renderInjectedPrompt(input.prompt, contextText),
      warnings: response.warnings,
    };
  }

  async taskChanged(task: { title: string; summary?: string }): Promise<void> {
    await this.client.emitEvent({
      runtime: "pi",
      profileName: this.config.profileName,
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      type: "task.changed",
      payload: {
        taskTitle: task.title,
        summary: task.summary ?? task.title,
      },
      metadata: {
        hostVersion: this.hostVersion,
        adapterVersion: this.config.adapterVersion,
      },
    });
  }

  async toolCompleted(tool: { turnId?: string; toolName: string; summary: string }): Promise<void> {
    await this.client.emitEvent({
      runtime: "pi",
      profileName: this.config.profileName,
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      turnId: tool.turnId ?? null,
      type: "tool.completed",
      payload: {
        toolName: tool.toolName,
        summary: tool.summary,
      },
      metadata: {
        hostVersion: this.hostVersion,
        adapterVersion: this.config.adapterVersion,
      },
    });
  }

  async completeTurn(input: {
    turnId: string;
    packId?: string | null;
    goal?: string;
    summary: string;
    transcript?: Array<{
      role: "user" | "assistant" | "system" | "tool";
      content: string;
      timestamp?: string;
    }>;
    newFact?: string | string[];
    newCommitment?: string | string[];
  }): Promise<void> {
    await this.client.emitEvent({
      runtime: "pi",
      profileName: this.config.profileName,
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      turnId: input.turnId,
      type: "turn.completed",
      payload: {
        packId: input.packId ?? null,
        goal: input.goal ?? null,
        summary: input.summary,
        transcript: input.transcript ?? [],
        newFact: input.newFact,
        newCommitment: input.newCommitment,
        taskSucceeded: true,
      },
      metadata: {
        hostVersion: this.hostVersion,
        adapterVersion: this.config.adapterVersion,
      },
    });
  }

  async sessionEnded(input: {
    turnId?: string | null;
    packId?: string | null;
    goal?: string;
    summary: string;
    taskSucceeded?: boolean | null;
    transcript?: Array<{
      role: "user" | "assistant" | "system" | "tool";
      content: string;
      timestamp?: string;
    }>;
  }): Promise<void> {
    await this.client.emitEvent({
      runtime: "pi",
      profileName: this.config.profileName,
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      turnId: input.turnId ?? null,
      type: "session.ended",
      payload: {
        packId: input.packId ?? null,
        goal: input.goal ?? null,
        summary: input.summary,
        transcript: input.transcript ?? [],
        taskSucceeded: input.taskSucceeded ?? null,
      },
      metadata: {
        hostVersion: this.hostVersion,
        adapterVersion: this.config.adapterVersion,
      },
    });
  }

  async remember(input: PiRememberRequest): Promise<void> {
    await this.client.emitEvent({
      runtime: "pi",
      profileName: this.config.profileName,
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      type: "operator.command",
      payload: {
        command: "remember",
        entryType: input.entryType ?? "fact",
        content: input.content,
        tags: input.tags ?? ["pi", "explicit"],
      },
      metadata: {
        hostVersion: this.hostVersion,
        adapterVersion: this.config.adapterVersion,
      },
    });
  }

  async searchMemory(query: string, topK: number = 10): Promise<Record<string, unknown>> {
    return this.client.searchMemory({
      profileName: this.config.profileName,
      query,
      top_k: topK,
    });
  }

  async exportMemory(): Promise<Record<string, unknown>> {
    return this.client.exportMemory(this.config.profileName);
  }

  async runTurn(input: {
    turnId: string;
    prompt: string;
    signal?: AbortSignal;
    transcript?: Array<{
      role: "user" | "assistant" | "system" | "tool";
      content: string;
      timestamp?: string;
    }>;
  }): Promise<PiEmbeddedRunResult> {
    const throwIfAborted = (): void => {
      if (!input.signal?.aborted) return;
      const message =
	input.signal.reason instanceof Error
	  ? input.signal.reason.message
	  : typeof input.signal.reason === "string" && input.signal.reason.trim()
	    ? input.signal.reason
	    : "Pi embedded turn was cancelled";
      const error = new Error(message);
      error.name = "AbortError";
      throw error;
    };
    throwIfAborted();
    const prepared = await this.prepareTurn(input);

    try {
      throwIfAborted();
      const result = await this.executor({
        ...prepared,
        workspaceRoot: this.workspaceRoot,
        workspaceId: this.workspaceId,
        sessionId: this.sessionId,
        turnId: input.turnId,
        prompt: input.prompt,
	signal: input.signal,
        transcript: input.transcript ?? [],
      });
      throwIfAborted();

      if (result.task) {
        await this.taskChanged(result.task);
      }

      for (const tool of result.tools ?? []) {
	throwIfAborted();
        await this.toolCompleted({
          turnId: input.turnId,
          toolName: tool.toolName,
          summary: tool.summary,
        });
      }

      const output = result.output.trim().length > 0 ? result.output.trim() : "Pi completed the request.";
      throwIfAborted();
      await this.completeTurn({
        turnId: input.turnId,
        packId: prepared.packId,
        goal: input.prompt,
        summary: output,
        transcript:
          result.transcript ??
          [
            ...(input.transcript ?? [{ role: "user" as const, content: input.prompt }]),
            { role: "assistant" as const, content: output },
          ],
        newFact: result.newFact,
        newCommitment: result.newCommitment,
      });

      return {
        ...prepared,
        output,
      };
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      await this.client.emitEvent({
        runtime: "pi",
        profileName: this.config.profileName,
        workspaceId: this.workspaceId,
        sessionId: this.sessionId,
        turnId: input.turnId,
        type: "turn.failed",
        payload: {
          packId: prepared.packId,
          goal: input.prompt,
          summary,
          transcript: input.transcript ?? [{ role: "user", content: input.prompt }],
          taskSucceeded: false,
        },
        metadata: {
          hostVersion: this.hostVersion,
          adapterVersion: this.config.adapterVersion,
        },
      });
      throw error;
    }
  }
}

export const installPiFromCli = async (argv: string[]): Promise<string> => {
  const { flags } = parseArgs(argv);
  const result = await installPiAdapter({
    home: typeof flags.home === "string" ? flags.home : undefined,
    profileName: typeof flags.profile === "string" ? flags.profile : "default",
    adapterVersion: typeof flags.version === "string" ? flags.version : undefined,
  });
  return [
    `Installed Pi adapter ${result.adapter.version}`,
    `runtime_home: ${result.config.runtimeHome}`,
    "mode: embedded",
  ].join("\n");
};

export const uninstallPiFromCli = async (argv: string[]): Promise<string> => {
  const { flags } = parseArgs(argv);
  const removed = await uninstallPiAdapter({
    home: typeof flags.home === "string" ? flags.home : undefined,
  });
  return removed.length === 0 ? "Pi adapter was already absent" : `Removed Pi adapter files:\n${removed.join("\n")}`;
};
