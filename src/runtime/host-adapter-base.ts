import { workspaceProjectRoot } from "./workspace-hooks";
import { existsSync } from "fs";
import { nowIso, renderInjectedPrompt, shellQuote } from "./adapter-utils";
import { workspaceHotScope } from "./workspace-hot-memory";
import path from "path";
import { HOT_CONTEXT_LIMIT, HOT_FULL_RENDER_LIMIT, renderHotCheckpoints, selectHotCheckpoints } from "./hot-continuity";
import { CHECKPOINT_PAGE_CHARS, inlineCheckpointPages, paginateCheckpoint, saveCheckpointPages } from "./checkpoint-pages";
import { resolveRuntimeHome } from "./local-runtime";
import { evidenceFromToolCall, readTaskEvidence, taskEvidenceCaptureEnabled, type TaskEvidence } from "./task-evidence";
import type { LocalRuntimeClient } from "./local-client";
import {
  buildRuntimeStartupFreshness,
  renderRuntimeStartupContext,
  type RuntimeStartupRuntime,
} from "./startup-context";

// Shared lifecycle core for the host runtime adapters. The claude-code and codex adapters
// previously each carried byte-identical copies of these methods (differing only in the
// runtime id, wrapper-version fallback, and prompt label), so fixes to context injection
// could land in one runtime and silently miss the other.

export type HostAdapterIdentity = {
  /** Runtime id reported in lifecycle events, e.g. "claude-code" or "codex". */
  runtimeId: RuntimeStartupRuntime;
  /** hostVersion fallback when the hook does not report one, e.g. "codex-wrapper". */
  wrapperVersionFallback: string;
  /** Human-readable label used in the injected prompt, e.g. "Claude Code". */
  requestLabel: string;
};

export type HostAdapterBaseConfig = {
  profileName: string;
  hostHome: string;
  adapterVersion: string;
  /** Runtime home holding this host's bridge wrapper under bin/. */
  runtimeHome?: string;
  sourceExcerpts?: boolean;
  workspaceOnly?: boolean;
  legacyUnscoped?: boolean;
  legacyBefore?: string;
};

export type HostAdapterTranscriptEntry = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
};

export type HostAdapterSessionStartRequest = {
  profileName?: string;
  workspaceRoot: string;
  workspaceId?: string;
  hostHome?: string;
  hostVersion?: string;
  sessionId: string;
};

export type HostAdapterTurnPrepareRequest = {
  profileName?: string;
  workspaceRoot: string;
  workspaceId?: string;
  hostHome?: string;
  hostVersion?: string;
  hookObservedAt?: string;
  previousContextReadAt?: string | null;
  sessionId: string;
  turnId: string;
  prompt: string;
  transcript?: HostAdapterTranscriptEntry[];
  /** True for the first prompt of a host session; it gets the larger hot-context budget. */
  sessionStart?: boolean;
};

export type HostAdapterToolEvidenceRequest = {
  profileName?: string;
  workspaceRoot: string;
  workspaceId?: string;
  hostVersion?: string;
  sessionId: string;
  turnId?: string | null;
  goal?: string | null;
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  /** The host reported the call as failed; only exact file matches are kept from its output. */
  failed?: boolean;
};

export type HostAdapterTurnPrepareResult = {
  packId: string | null;
  contextText: string;
  injectedPrompt: string;
  warnings: string[];
};

export type HostAdapterTurnCompleteRequest = {
  taskEvidence?: TaskEvidence;
  profileName?: string;
  workspaceRoot: string;
  workspaceId?: string;
  hostHome?: string;
  hostVersion?: string;
  sessionId: string;
  turnId: string;
  packId?: string | null;
  goal?: string;
  summary: string;
  transcript?: HostAdapterTranscriptEntry[];
  newFact?: string | string[];
  newCommitment?: string | string[];
};

export type HostAdapterTurnFailedRequest = {
  taskEvidence?: TaskEvidence;
  profileName?: string;
  workspaceRoot: string;
  workspaceId?: string;
  hostHome?: string;
  hostVersion?: string;
  sessionId: string;
  turnId: string;
  packId?: string | null;
  goal?: string;
  summary: string;
  transcript?: HostAdapterTranscriptEntry[];
};

export type HostAdapterToolCompleteRequest = {
  profileName?: string;
  workspaceRoot: string;
  workspaceId?: string;
  hostHome?: string;
  hostVersion?: string;
  sessionId: string;
  turnId?: string;
  toolName: string;
  summary: string;
};

export type HostAdapterTaskChangedRequest = {
  profileName?: string;
  workspaceRoot: string;
  workspaceId?: string;
  hostHome?: string;
  hostVersion?: string;
  sessionId: string;
  taskTitle: string;
  summary?: string;
};

export type HostAdapterSessionEndedRequest = {
  taskEvidence?: TaskEvidence;
  profileName?: string;
  workspaceRoot: string;
  workspaceId?: string;
  hostHome?: string;
  hostVersion?: string;
  sessionId: string;
  turnId?: string | null;
  packId?: string | null;
  goal?: string;
  summary: string;
  taskSucceeded?: boolean | null;
  transcript?: HostAdapterTranscriptEntry[];
};

export type HostAdapterCompactEventRequest = {
  profileName?: string;
  workspaceRoot: string;
  workspaceId?: string;
  hostHome?: string;
  hostVersion?: string;
  sessionId: string;
  turnId?: string | null;
  trigger?: string | null;
  summary: string;
  payload?: Record<string, unknown>;
};

export type HostAdapterRememberRequest = {
  profileName?: string;
  workspaceRoot: string;
  workspaceId?: string;
  hostHome?: string;
  hostVersion?: string;
  sessionId?: string;
  entryType?: "fact" | "commitment" | "correction" | "pattern";
  content: string;
  tags?: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseJsonRecord = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const parseHotMemoryEntryContent = (entry: Record<string, unknown>): Record<string, unknown> | null => {
  if (isRecord(entry.content)) {
    return entry.content;
  }
  return typeof entry.content === "string" ? parseJsonRecord(entry.content) : null;
};

const hasHotMemoryEntryContent = (entry: Record<string, unknown>): boolean => {
  if (isRecord(entry.content)) {
    return true;
  }
  return typeof entry.content === "string" && entry.content.trim().length > 0;
};

const getWorkspaceId = (value: Record<string, unknown> | null): string | null => {
  const workspaceId = value?.workspaceId ?? value?.workspace_id;
  return typeof workspaceId === "string" && workspaceId.trim().length > 0 ? workspaceId.trim() : null;
};

const emptyHotMemorySnapshot = (): Record<string, unknown> => ({ scope: "all", scopes: [] });

export const filterHotMemorySnapshotForWorkspace = (
  hotMemory: Record<string, unknown> | null,
  workspaceId: string,
  workspaceOnly = false,
  legacyUnscoped = false,
  legacyBefore?: string
): Record<string, unknown> | null => {
  if (!hotMemory) {
    return null;
  }
  if (workspaceOnly && workspaceId.startsWith("repo:")) {
    const target = workspaceId.slice(5);
    const equivalent = (id: string | null, observedAt?: unknown): boolean => {
      if (id === workspaceId) return true;
      if (!id) return legacyUnscoped && Boolean(legacyBefore) && typeof observedAt === "string" &&
	Date.parse(observedAt) <= Date.parse(legacyBefore!);
      if (!id.startsWith("repo:") || !path.isAbsolute(id.slice(5))) return false;
      try { return workspaceProjectRoot(id.slice(5)) === target; } catch { return false; }
    };
    const normalize = (entry: Record<string, unknown>): Record<string, unknown> | null => {
      const content = parseHotMemoryEntryContent(entry);
      if (!content || !equivalent(getWorkspaceId(content), entry.updated_at ?? content.updatedAt ?? content.occurredAt)) return null;
      const checkpoints = Array.isArray(content.continuityCheckpoints)
	? content.continuityCheckpoints.filter(isRecord).filter(checkpoint => equivalent(getWorkspaceId(checkpoint), checkpoint.occurredAt ?? entry.updated_at ?? content.updatedAt))
	  .map(checkpoint => ({ ...checkpoint, workspaceId })) : undefined;
      return { ...entry, content: JSON.stringify({ ...content, workspaceId,
	...(checkpoints ? { continuityCheckpoints: checkpoints } : {}) }) };
    };
    hotMemory = Array.isArray(hotMemory.scopes)
      ? { ...hotMemory, scopes: hotMemory.scopes.filter(isRecord).map(normalize).filter(isRecord) }
      : normalize(hotMemory);
    if (!hotMemory) return null;
  }
  const scopedEntries = Array.isArray(hotMemory.scopes) ? hotMemory.scopes.filter(isRecord) : null;
  if (!scopedEntries) {
    if (!hasHotMemoryEntryContent(hotMemory)) {
      return null;
    }
    const entryWorkspaceId = getWorkspaceId(parseHotMemoryEntryContent(hotMemory));
    return entryWorkspaceId === workspaceId || (!workspaceOnly && !entryWorkspaceId) ? hotMemory : null;
  }
  const scopes = scopedEntries.filter((entry) => {
    if (!hasHotMemoryEntryContent(entry)) {
      return false;
    }
    const entryWorkspaceId = getWorkspaceId(parseHotMemoryEntryContent(entry));
    return entryWorkspaceId === workspaceId || (!workspaceOnly && !entryWorkspaceId);
  });
  if (scopes.length === 0) {
    return null;
  }
  // The legacy runtime alias and its retained workspace partition describe one
  // document. Inject the newest version once, under the readable runtime name.
  const selected = new Map<string, Record<string, unknown>>();
  const other: Record<string, unknown>[] = [];
  for (const entry of scopes) {
    const content = parseHotMemoryEntryContent(entry);
    const runtime = typeof content?.runtime === "string" ? content.runtime : null;
    if (!runtime || getWorkspaceId(content) !== workspaceId ||
      ![runtime, workspaceHotScope(runtime, workspaceId)].includes(String(entry.scope))) {
      other.push(entry);
      continue;
    }
    const previous = selected.get(runtime);
    const updated = Date.parse(String(content?.updatedAt)) || 0;
    const previousUpdated = Date.parse(String(parseHotMemoryEntryContent(previous ?? {})?.updatedAt)) || 0;
    if (!previous || updated >= previousUpdated) selected.set(runtime, { ...entry, scope: runtime });
  }
  return { ...hotMemory, scopes: [...other, ...selected.values()] };
};

export abstract class HostRuntimeAdapterBase {
  protected abstract readonly identity: HostAdapterIdentity;
  protected abstract readonly client: LocalRuntimeClient;
  protected abstract readonly config: HostAdapterBaseConfig;

  async captureTaskEvidence(file: string | null, sessionId: string, workspaceRoot: string, since?: string | null, goal?: string | null): Promise<TaskEvidence | undefined> {
    // Scoped setup stores the capture choice independently of memory mode.
    // Legacy installs continue using their environment capture policy.
    if (!(this.config.sourceExcerpts ?? taskEvidenceCaptureEnabled())) return undefined;
    // Check the current profile at capture time, including a mode change during
    // this turn. Never inspect tool output when automatic memory is disabled.
    const status = await this.client.status(this.config.profileName).catch(() => null);
    if (status?.profile?.memoryMode !== "auto" && status?.profile?.memoryMode !== "assist") return undefined;
    return readTaskEvidence(file, sessionId, workspaceRoot, since, goal ?? "");
  }

  /** This host's Crosshead command, or null when no wrapper is installed (other hosts). */
  protected bridgeCommand(): string | null {
    const wrapper = { "claude-code": "crosshead-claude-code", codex: "crosshead-codex" }[this.identity.runtimeId as string];
    if (!wrapper || !this.config.runtimeHome) return null;
    if (this.config.workspaceOnly) {
      const cli = path.join(this.config.runtimeHome, "bin", "crosshead");
      return existsSync(cli)
	? `${shellQuote(cli)} checkpoint-page%PAGE% --runtime ${this.identity.runtimeId} --home ${shellQuote(this.config.runtimeHome)}`
	: null;
    }
    // Plugin-only installs may have no wrapper; never name a command that is not there.
    const file = path.join(this.config.runtimeHome, "bin", wrapper);
    if (!existsSync(file)) return null;
    const quoted = /^[A-Za-z0-9_@%+=:,./-]+$/.test(file) ? file : shellQuote(file);
    const home = path.resolve(this.config.runtimeHome) === path.resolve(resolveRuntimeHome(undefined)) ? "" : ` --home ${shellQuote(this.config.runtimeHome)}`;
    return `${quoted} checkpoint-page%PAGE%${home}`;
  }

  /**
   * Hot checkpoint text for one prompt. The first prompt of a session gets the
   * first page of the complete checkpoint; later prompts get the small excerpt.
   * Whenever more is saved than is shown, the pages are stored and the text ends
   * with the exact command that prints them, so an agent never has to stop or
   * guess because a note was cut off.
   */
  protected renderHotContext(snapshot: unknown, prompt: string, workspaceId: string, sessionStart: boolean): string | undefined {
    const command = this.bridgeCommand();
    if (!command || !this.config.runtimeHome) return undefined;
    const selected = selectHotCheckpoints(snapshot, prompt, this.config.workspaceOnly ? workspaceId : undefined);
    if (!selected.length) return undefined;
    const full = renderHotCheckpoints(selected, HOT_FULL_RENDER_LIMIT);
    const inline = sessionStart ? inlineCheckpointPages(this.identity.runtimeId) : 0;
    if (full.length <= (sessionStart ? CHECKPOINT_PAGE_CHARS * inline : HOT_CONTEXT_LIMIT)) return full;
    const pages = paginateCheckpoint(full);
    if (sessionStart && pages.length <= inline) return full;
    const key = saveCheckpointPages(this.config.runtimeHome, this.identity.runtimeId, workspaceId, pages);
    const read = (page: number): string => `${command.replace("%PAGE%", ` ${page}`)} --key ${key}`;
    const shown = inline === 1 ? "page 1" : `pages 1 to ${inline}`;
    const remaining = pages.length - inline === 1 ? `page ${pages.length}` : `pages ${inline + 1} to ${pages.length}, one page number per call`;
    return sessionStart
      ? `${pages.slice(0, inline).join("\n")}\n[Crosshead: ${shown} of ${pages.length} of the saved checkpoint shown. The rest holds further saved findings and observed sources. Before relying on partial values, read ${remaining}, with this Crosshead command: ${read(inline + 1)}]`
      : `${renderHotCheckpoints(selected, HOT_CONTEXT_LIMIT)}\n[Crosshead: excerpt only. The saved checkpoint has ${pages.length} page${pages.length === 1 ? "" : "s"}; read from the start with: ${read(1)}]`;
  }

  /**
   * Checkpoint what one finished tool call showed, before the turn ends. Same
   * opt-in and memory-mode gates as captureTaskEvidence. Returns whether
   * anything was recorded.
   */
  async recordToolEvidence(input: HostAdapterToolEvidenceRequest): Promise<boolean> {
    if (!(this.config.sourceExcerpts ?? taskEvidenceCaptureEnabled())) return false;
    const taskEvidence = evidenceFromToolCall(input.toolName, input.toolInput, input.toolResponse, input.workspaceRoot, nowIso(), input.failed === true);
    if (!taskEvidence.sources.length) return false;
    const profileName = input.profileName ?? this.config.profileName;
    const status = await this.client.status(profileName).catch(() => null);
    if (status?.profile?.memoryMode !== "auto" && status?.profile?.memoryMode !== "assist") return false;
    await this.client.emitEvent({
      runtime: this.identity.runtimeId,
      profileName,
      workspaceId: input.workspaceId ?? `repo:${input.workspaceRoot}`,
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      type: "tool.completed",
      payload: { toolName: input.toolName, summary: `Observed ${input.toolName} result`, checkpointOnly: true, ...(input.goal ? { goal: input.goal } : {}), taskEvidence },
      metadata: { hostVersion: input.hostVersion ?? this.identity.wrapperVersionFallback, adapterVersion: this.config.adapterVersion },
    });
    return true;
  }

  /** Adapter-specific workspace attachment (managed files and manifest differ per host). */
  protected abstract attachWorkspace(input: {
    profileName?: string;
    workspaceRoot: string;
    workspaceId: string;
    hostHome?: string;
    hostVersion?: string;
  }): Promise<void>;

  async sessionStarted(input: HostAdapterSessionStartRequest): Promise<void> {
    const workspaceId = input.workspaceId ?? `repo:${input.workspaceRoot}`;
    await this.attachWorkspace({
      profileName: input.profileName,
      workspaceRoot: input.workspaceRoot,
      workspaceId,
      hostHome: input.hostHome,
      hostVersion: input.hostVersion,
    });
    await this.client.emitEvent({
      runtime: this.identity.runtimeId,
      profileName: input.profileName ?? this.config.profileName,
      workspaceId,
      sessionId: input.sessionId,
      type: "session.started",
      payload: {
        hostHome: input.hostHome ?? this.config.hostHome,
      },
      metadata: {
        hostVersion: input.hostVersion ?? this.identity.wrapperVersionFallback,
        adapterVersion: this.config.adapterVersion,
      },
    });
  }

  async prepareTurn(input: HostAdapterTurnPrepareRequest): Promise<HostAdapterTurnPrepareResult> {
    const workspaceId = input.workspaceId ?? `repo:${input.workspaceRoot}`;
    const profileName = input.profileName ?? this.config.profileName;
    const observedAt = input.hookObservedAt ?? nowIso();
    const previousContextReadAt = input.previousContextReadAt ?? null;
    await this.attachWorkspace({
      profileName,
      workspaceRoot: input.workspaceRoot,
      workspaceId,
      hostHome: input.hostHome,
      hostVersion: input.hostVersion,
    });
    const rawPreTurnHotMemory = await this.client.readHotMemory(profileName, "all").catch(() => null);
    const preTurnHotMemory = filterHotMemorySnapshotForWorkspace(rawPreTurnHotMemory, workspaceId, this.config.workspaceOnly, this.config.legacyUnscoped, this.config.legacyBefore);
    const response = await this.client.emitEvent({
      runtime: this.identity.runtimeId,
      profileName,
      workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      type: "turn.started",
      payload: {
        goal: input.prompt,
	recallPolicy: "bounded",
        transcript: input.transcript ?? [],
        allowedScope: {
          includeHotMemory: true,
	  includeWarmMemory: true,
	  includeColdMemory: true,
          includeLayeredContext: false,
        },
				includeResumeBrief: false,
				budget: {
					maxFragments: 3,
					maxTokens: 1200,
				},
				hotMemorySnapshot: preTurnHotMemory ?? emptyHotMemorySnapshot(),
      },
      metadata: {
        hostVersion: input.hostVersion ?? this.identity.wrapperVersionFallback,
        adapterVersion: this.config.adapterVersion,
      },
    });
    const contextPack =
      response.contextPack && typeof response.contextPack === "object" && !Array.isArray(response.contextPack)
        ? response.contextPack
	: null;
    const packId = contextPack && typeof contextPack.packId === "string" ? contextPack.packId : null;
    const freshness = buildRuntimeStartupFreshness({
      runtime: this.identity.runtimeId,
      observedAt,
      previousContextReadAt,
      hotMemory: preTurnHotMemory,
    });
    // A hook without a usable prompt still records its lifecycle event, but must
    // not inject background state whose availability depends on debounce timing.
    // The lifecycle response can contain hosted service data. Until those
    // fields have end-to-end authenticity, none of them may become model
    // instructions. The hot snapshot has already crossed the client's local
    // signature-verification boundary and is the sole dynamic prompt source.
    const contextText = input.prompt.trim() ? renderRuntimeStartupContext({
      runtime: this.identity.runtimeId,
      profileName,
      mode: response.mode,
      sourceExcerpts: this.config.sourceExcerpts ?? taskEvidenceCaptureEnabled(),
      workspaceId: this.config.workspaceOnly ? workspaceId : undefined,
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
      goal: input.prompt,
      hotContextText: this.renderHotContext(preTurnHotMemory, input.prompt, workspaceId, input.sessionStart === true),
    }) : "";
    return {
      packId,
      contextText,
      injectedPrompt: renderInjectedPrompt(input.prompt, contextText, this.identity.requestLabel),
      warnings: response.warnings,
    };
  }

  async completeTurn(input: HostAdapterTurnCompleteRequest): Promise<void> {
    const workspaceId = input.workspaceId ?? `repo:${input.workspaceRoot}`;
    await this.client.emitEvent({
      runtime: this.identity.runtimeId,
      profileName: input.profileName ?? this.config.profileName,
      workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      type: "turn.completed",
      payload: {
        packId: input.packId ?? null,
        goal: input.goal ?? null,
        summary: input.summary,
	taskEvidence: input.taskEvidence,
        transcript: input.transcript ?? [],
        newFact: input.newFact,
        newCommitment: input.newCommitment,
        taskSucceeded: true,
      },
      metadata: {
        hostVersion: input.hostVersion ?? this.identity.wrapperVersionFallback,
        adapterVersion: this.config.adapterVersion,
      },
    });
  }

  async failTurn(input: HostAdapterTurnFailedRequest): Promise<void> {
    const workspaceId = input.workspaceId ?? `repo:${input.workspaceRoot}`;
    await this.client.emitEvent({
      runtime: this.identity.runtimeId,
      profileName: input.profileName ?? this.config.profileName,
      workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      type: "turn.failed",
      payload: {
        packId: input.packId ?? null,
        goal: input.goal ?? null,
        summary: input.summary,
	taskEvidence: input.taskEvidence,
        transcript: input.transcript ?? [],
        taskSucceeded: false,
      },
      metadata: {
        hostVersion: input.hostVersion ?? this.identity.wrapperVersionFallback,
        adapterVersion: this.config.adapterVersion,
      },
    });
  }

  async toolCompleted(input: HostAdapterToolCompleteRequest): Promise<void> {
    const workspaceId = input.workspaceId ?? `repo:${input.workspaceRoot}`;
    await this.client.emitEvent({
      runtime: this.identity.runtimeId,
      profileName: input.profileName ?? this.config.profileName,
      workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      type: "tool.completed",
      payload: {
        toolName: input.toolName,
        summary: input.summary,
      },
      metadata: {
        hostVersion: input.hostVersion ?? this.identity.wrapperVersionFallback,
        adapterVersion: this.config.adapterVersion,
      },
    });
  }

  async taskChanged(input: HostAdapterTaskChangedRequest): Promise<void> {
    const workspaceId = input.workspaceId ?? `repo:${input.workspaceRoot}`;
    await this.client.emitEvent({
      runtime: this.identity.runtimeId,
      profileName: input.profileName ?? this.config.profileName,
      workspaceId,
      sessionId: input.sessionId,
      type: "task.changed",
      payload: {
        taskTitle: input.taskTitle,
        summary: input.summary ?? input.taskTitle,
      },
      metadata: {
        hostVersion: input.hostVersion ?? this.identity.wrapperVersionFallback,
        adapterVersion: this.config.adapterVersion,
      },
    });
  }

  async sessionEnded(input: HostAdapterSessionEndedRequest): Promise<void> {
    const workspaceId = input.workspaceId ?? `repo:${input.workspaceRoot}`;
    await this.client.emitEvent({
      runtime: this.identity.runtimeId,
      profileName: input.profileName ?? this.config.profileName,
      workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      type: "session.ended",
      payload: {
        packId: input.packId ?? null,
        goal: input.goal ?? null,
        summary: input.summary,
	taskEvidence: input.taskEvidence,
        transcript: input.transcript ?? [],
        taskSucceeded: input.taskSucceeded ?? null,
      },
      metadata: {
        hostVersion: input.hostVersion ?? this.identity.wrapperVersionFallback,
        adapterVersion: this.config.adapterVersion,
      },
    });
  }

  private async emitCompactEvent(
    type: "compact.started" | "compact.completed",
    input: HostAdapterCompactEventRequest
  ): Promise<void> {
    const workspaceId = input.workspaceId ?? `repo:${input.workspaceRoot}`;
    const profileName = input.profileName ?? this.config.profileName;
    await this.attachWorkspace({
      profileName,
      workspaceRoot: input.workspaceRoot,
      workspaceId,
      hostHome: input.hostHome,
      hostVersion: input.hostVersion,
    });
    await this.client.emitEvent({
      runtime: this.identity.runtimeId,
      profileName,
      workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      type,
      payload: {
        ...(input.payload ?? {}),
        trigger: input.trigger ?? null,
        summary: input.summary,
      },
      metadata: {
        hostVersion: input.hostVersion ?? this.identity.wrapperVersionFallback,
        adapterVersion: this.config.adapterVersion,
      },
    });
  }

  async compactStarted(input: HostAdapterCompactEventRequest): Promise<void> {
    await this.emitCompactEvent("compact.started", input);
  }

  async compactCompleted(input: HostAdapterCompactEventRequest): Promise<void> {
    await this.emitCompactEvent("compact.completed", input);
  }

  async remember(input: HostAdapterRememberRequest): Promise<void> {
    const workspaceId = input.workspaceId ?? `repo:${input.workspaceRoot}`;
    await this.client.emitEvent({
      runtime: this.identity.runtimeId,
      profileName: input.profileName ?? this.config.profileName,
      workspaceId,
      sessionId: input.sessionId ?? null,
      type: "operator.command",
      payload: {
        command: "remember",
        entryType: input.entryType ?? "fact",
        content: input.content,
        tags: input.tags ?? [this.identity.runtimeId, "explicit"],
      },
      metadata: {
        hostVersion: input.hostVersion ?? this.identity.wrapperVersionFallback,
        adapterVersion: this.config.adapterVersion,
      },
    });
  }
}
