import { ensureHookRuntime, reportHookFailure } from "./hook-runtime";
import { existsSync, readFileSync } from "fs";
import path from "path";

import { captureHotFinding } from "./hot-continuity";
import { readLastAssistantMessage } from "./hook-transcript";

import { ClaudeCodeRuntimeAdapter, findLegacyClaudeHookFiles, loadClaudeCodeAdapterConfig } from "./claude-code-adapter";
import { pluginSetupHint } from "./host-hook-spec";
import {
  claudeSessionProjectDir,
  claudeUserConfigDir,
  decideHookDispatch,
  isPluginHookInvocation,
  normalizeHostHookMode,
  recordPluginInvocation,
  resolvePluginHostHome,
  writePluginSetupNotice,
} from "./host-plugin-mode";
import { ensureRuntimeHomeLayout, resolveRuntimeHome } from "./local-runtime";
import { writeJsonFile } from "./runtime-persistence";
import { assertSecureNodeRuntimeVersion } from "./node-runtime-version";

type HookTurnState = {
  sessionId: string | null;
  turnId: string | null;
  prompt: string | null;
  packId: string | null;
  workspaceRoot: string;
  workspaceId: string;
  lastContextReadAt: string | null;
  updatedAt: string;
};

type HookState = HookTurnState & {
  activeTurns: Record<string, HookTurnState>;
};

const parseArgs = (args: string[]): { positionals: string[]; flags: Record<string, string | boolean> } => {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
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

const nowIso = (): string => new Date().toISOString();

const readJsonObject = (value: string): Record<string, unknown> | null => {
  if (value.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const readStdinJson = (override?: string): Record<string, unknown> | null => {
  if (typeof override === "string") {
    return readJsonObject(override);
  }
  if (process.stdin.isTTY) {
    return null;
  }
  try {
    return readJsonObject(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
};

const hookStateFile = (runtimeHome: string): string => path.join(ensureRuntimeHomeLayout(runtimeHome).state, "claude-code-hook.json");

const defaultHookState = (workspaceRoot: string, workspaceId: string): HookState => ({
  sessionId: null,
  turnId: null,
  prompt: null,
  packId: null,
  workspaceRoot,
  workspaceId,
  lastContextReadAt: null,
  updatedAt: nowIso(),
  activeTurns: {},
});

const normalizeHookTurnState = (
  parsed: Partial<HookTurnState>,
  fallback: Pick<HookTurnState, "workspaceRoot" | "workspaceId" | "lastContextReadAt" | "updatedAt">
): HookTurnState => ({
  sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
  turnId: typeof parsed.turnId === "string" ? parsed.turnId : null,
  prompt: typeof parsed.prompt === "string" ? parsed.prompt : null,
  packId: typeof parsed.packId === "string" ? parsed.packId : null,
  workspaceRoot: typeof parsed.workspaceRoot === "string" ? parsed.workspaceRoot : fallback.workspaceRoot,
  workspaceId: typeof parsed.workspaceId === "string" ? parsed.workspaceId : fallback.workspaceId,
  lastContextReadAt:
    typeof parsed.lastContextReadAt === "string" ? parsed.lastContextReadAt : fallback.lastContextReadAt,
  updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt,
});

const hookTurnKey = (sessionId: string | null, turnId: string | null): string | null =>
  sessionId || turnId ? `${sessionId ?? "-"}:${turnId ?? "-"}` : null;

const loadHookState = (runtimeHome: string, workspaceRoot: string, workspaceId: string): HookState => {
  const filePath = hookStateFile(runtimeHome);
  if (!existsSync(filePath)) {
    return defaultHookState(workspaceRoot, workspaceId);
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<HookState>;
    const parsedWorkspaceId = typeof parsed.workspaceId === "string" ? parsed.workspaceId : null;
    const topLevelMatchesWorkspace = parsedWorkspaceId === workspaceId;
    const fallback = {
      workspaceRoot,
      workspaceId,
      lastContextReadAt:
        topLevelMatchesWorkspace && typeof parsed.lastContextReadAt === "string" ? parsed.lastContextReadAt : null,
      updatedAt: topLevelMatchesWorkspace && typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
    };
    const base = topLevelMatchesWorkspace
      ? {
          ...normalizeHookTurnState(parsed, fallback),
          workspaceRoot,
          workspaceId,
        }
      : defaultHookState(workspaceRoot, workspaceId);
    const activeTurns: Record<string, HookTurnState> = {};
    const rawActiveTurns =
      parsed.activeTurns && typeof parsed.activeTurns === "object" && !Array.isArray(parsed.activeTurns)
        ? parsed.activeTurns
        : {};
    for (const [key, value] of Object.entries(rawActiveTurns)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      activeTurns[key] = normalizeHookTurnState(value as Partial<HookTurnState>, base);
    }
    return { ...base, activeTurns };
  } catch {
    return defaultHookState(workspaceRoot, workspaceId);
  }
};

const saveHookState = (runtimeHome: string, state: HookState): void => {
  writeJsonFile(hookStateFile(runtimeHome), state);
};

const selectHookTurnState = (state: HookState, sessionId: string | null, turnId: string | null): HookTurnState => {
  const key = hookTurnKey(sessionId, turnId);
  const matchesWorkspace = (turn: HookTurnState): boolean => turn.workspaceId === state.workspaceId;
  if (key && state.activeTurns[key]) {
    return state.activeTurns[key];
  }
  const turns = Object.values(state.activeTurns);
  const sameWorkspaceTurns = turns.filter(matchesWorkspace);
  const matchByTurn =
    sameWorkspaceTurns.find((turn) => turn.turnId === turnId) ?? turns.find((turn) => turn.turnId === turnId);
  if (turnId && matchByTurn) {
    return matchByTurn;
  }
  const matchBySession =
    sameWorkspaceTurns.find((turn) => turn.sessionId === sessionId) ??
    turns.find((turn) => turn.sessionId === sessionId);
  if (sessionId && matchBySession) {
    return matchBySession;
  }
  const latestSameWorkspaceTurn = sameWorkspaceTurns
    .slice()
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .at(-1);
  if (latestSameWorkspaceTurn) {
    return latestSameWorkspaceTurn;
  }
  return state;
};

const saveHookTurnState = (runtimeHome: string, state: HookState, turn: HookTurnState): void => {
  const activeTurns = { ...state.activeTurns };
  const key = hookTurnKey(turn.sessionId, turn.turnId);
  if (key) {
    activeTurns[key] = turn;
  }
  saveHookState(runtimeHome, { ...state, ...turn, activeTurns });
};

const clearHookTurnState = (
  runtimeHome: string,
  state: HookState,
  sessionId: string | null,
  turnId: string | null,
  fallback: Pick<HookTurnState, "workspaceRoot" | "workspaceId" | "lastContextReadAt">
): void => {
  const activeTurns = { ...state.activeTurns };
  const key = hookTurnKey(sessionId, turnId);
  if (key) {
    delete activeTurns[key];
  }
  const remaining = Object.values(activeTurns).sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const next = remaining.at(-1) ?? {
    sessionId: null,
    turnId: null,
    prompt: null,
    packId: null,
    workspaceRoot: fallback.workspaceRoot,
    workspaceId: fallback.workspaceId,
    lastContextReadAt: fallback.lastContextReadAt,
    updatedAt: nowIso(),
  };
  saveHookState(runtimeHome, { ...next, activeTurns });
};

const getNestedValue = (payload: Record<string, unknown> | null, dottedKey: string): unknown => {
  if (!payload) {
    return undefined;
  }
  let current: unknown = payload;
  for (const segment of dottedKey.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const pickString = (payload: Record<string, unknown> | null, candidates: string[]): string | null => {
  for (const candidate of candidates) {
    const value = getNestedValue(payload, candidate);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
};

const pickBoolean = (payload: Record<string, unknown> | null, candidates: string[]): boolean | null => {
  for (const candidate of candidates) {
    const value = getNestedValue(payload, candidate);
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
};

const pickFlagString = (flags: Record<string, string | boolean>, candidates: string[]): string | null => {
  for (const candidate of candidates) {
    const value = flags[candidate];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
};

const pickEnvString = (candidates: string[]): string | null => {
  for (const candidate of candidates) {
    const canonical = candidate.replace(/^ONLYBOTS_/, "CROSSHEAD_");
    const value = process.env[canonical] ?? process.env[candidate];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
};

const resolvePathCandidate = (value: string): string => (path.isAbsolute(value) ? value : path.resolve(process.cwd(), value));

const resolveHookWorkspaceRoot = (
  payload: Record<string, unknown> | null,
  flags: Record<string, string | boolean>
): string => {
  const candidate =
    pickFlagString(flags, ["workspace-root", "workspaceRoot"]) ??
    pickString(payload, [
      "workspace_root",
      "workspaceRoot",
      "workspace.root",
      "workspace.path",
      "cwd",
      "current_working_directory",
      "currentWorkingDirectory",
      "payload.workspace_root",
      "payload.workspaceRoot",
      "payload.cwd",
    ]) ??
    pickEnvString(["ONLYBOTS_WORKSPACE_ROOT", "BENCH_WORKSPACE"]);
  return candidate ? resolvePathCandidate(candidate) : process.cwd();
};

const resolveHookWorkspaceId = (
  payload: Record<string, unknown> | null,
  flags: Record<string, string | boolean>,
  workspaceRoot: string
): string => {
  return (
    pickFlagString(flags, ["workspace-id", "workspaceId"]) ??
    pickString(payload, [
      "workspace_id",
      "workspaceId",
      "workspace.id",
      "payload.workspace_id",
      "payload.workspaceId",
    ]) ??
    pickEnvString(["ONLYBOTS_WORKSPACE_ID"]) ??
    `repo:${workspaceRoot}`
  );
};

const pickCompactionTrigger = (payload: Record<string, unknown> | null): string | null =>
  pickString(payload, [
    "trigger",
    "compact_trigger",
    "compactTrigger",
    "compaction_trigger",
    "compactionTrigger",
    "source",
    "reason",
    "payload.trigger",
    "payload.source",
  ]);

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;

const buildTurnTranscript = (
	prompt: string | null,
	summary: string,
	failed: boolean
): Array<{ role: "user" | "assistant"; content: string }> => {
	if (prompt && !failed) {
		return [
			{ role: "user", content: prompt },
			{ role: "assistant", content: summary },
		];
	}
	if (prompt) {
		return [{ role: "user", content: prompt }];
	}
	if (failed) {
		return [];
	}
	return [{ role: "assistant", content: summary }];
};

const buildSyntheticSessionId = (): string => `claude-hook-session-${Date.now()}`;
const buildSyntheticTurnId = (): string => `claude-hook-turn-${Date.now()}`;

export const runOnlyBotsClaudeCodeHookCli = async (
  argv: string[] = process.argv.slice(2),
  stdinOverride?: string
): Promise<void> => {
	assertSecureNodeRuntimeVersion();
  const { positionals, flags } = parseArgs(argv);
  const eventName = positionals[0] ?? "help";
  const normalizedEventName = eventName.toLowerCase();
  const runtimeHome = resolveRuntimeHome(typeof flags.home === "string" ? flags.home : undefined);
  const viaPlugin = isPluginHookInvocation(flags);
  const hostHome =
    typeof flags["claude-home"] === "string" ? flags["claude-home"] : viaPlugin ? resolvePluginHostHome("claude-code", runtimeHome) : undefined;
  const payload = readStdinJson(stdinOverride);
  const workspaceRoot = resolveHookWorkspaceRoot(payload, flags);
  const workspaceId = resolveHookWorkspaceId(payload, flags, workspaceRoot);
  if (eventName !== "help") {
    let installedConfig: ReturnType<typeof loadClaudeCodeAdapterConfig> | null = null;
    try {
      installedConfig = loadClaudeCodeAdapterConfig(runtimeHome, hostHome);
    } catch (error) {
      if (!viaPlugin) throw error;
    }
    if (!installedConfig) {
      // Plugin installed before setup: tell the user how to finish, never fail the session.
      if (normalizedEventName === "sessionstart" || normalizedEventName === "session_start") {
        writePluginSetupNotice(pluginSetupHint("claude-code"));
      }
      return;
    }
    if (viaPlugin) {
      try {
        recordPluginInvocation(runtimeHome, "claude-code", typeof flags["plugin-version"] === "string" ? flags["plugin-version"] : null);
      } catch {
        // A receipt is diagnostic only; never fail the hook over it.
      }
    }
    // Exactly the settings files Claude Code loaded for this session: the user
    // settings and the session's project directory (CLAUDE_PROJECT_DIR).
    const decision = decideHookDispatch({
      viaPlugin,
      mode: normalizeHostHookMode(installedConfig.hookMode),
      legacyHooksPresent: () =>
        findLegacyClaudeHookFiles(claudeUserConfigDir(), claudeSessionProjectDir(workspaceRoot), runtimeHome).length > 0,
    });
    if (decision === "skip-duplicate") return;
  }
  const adapter = ClaudeCodeRuntimeAdapter.fromInstalled({
    home: runtimeHome,
    hostHome,
  });
  const state = loadHookState(runtimeHome, workspaceRoot, workspaceId);

  if (eventName === "help") {
    process.stdout.write(
      "crosshead-claude-code-hook <SessionStart|PreCompact|PostCompact|UserPromptSubmit|Stop> [--home <path>] [--claude-home <path>]\n"
    );
    return;
  }

  if (["sessionstart", "session_start", "precompact", "pre_compact", "postcompact", "post_compact", "userpromptsubmit", "user_prompt_submit", "stop"].includes(normalizedEventName)) {
    await ensureHookRuntime(runtimeHome);
  }

  if (normalizedEventName === "sessionstart" || normalizedEventName === "session_start") {
    const sessionId =
      pickString(payload, ["session_id", "sessionId", "session.id", "conversation_id", "conversationId"]) ??
      state.sessionId ??
      buildSyntheticSessionId();
    await adapter.sessionStarted({
      workspaceRoot,
      workspaceId,
      sessionId,
      hostHome,
      hostVersion: pickString(payload, ["claude_version", "claudeVersion", "client.version"]) ?? "claude-code-hook",
    });
    saveHookState(runtimeHome, {
      ...state,
      sessionId,
      workspaceRoot,
      workspaceId,
      updatedAt: nowIso(),
    });
		return;
	}

	if (normalizedEventName === "precompact" || normalizedEventName === "pre_compact") {
		const requestedSessionId =
			pickString(payload, ["session_id", "sessionId", "session.id", "conversation_id", "conversationId"]) ??
			state.sessionId ??
			null;
		const requestedTurnId =
			pickString(payload, ["turn_id", "turnId", "event_id", "eventId", "id", "message_id", "messageId"]) ??
			state.turnId ??
			null;
		const turnState = selectHookTurnState(state, requestedSessionId, requestedTurnId);
		const sessionId = turnState.sessionId ?? requestedSessionId ?? buildSyntheticSessionId();
		const turnId = turnState.turnId ?? requestedTurnId ?? null;
    const turnWorkspaceRoot = turnState.workspaceRoot;
		const trigger = pickCompactionTrigger(payload);
		const prompt = turnState.prompt ?? pickString(payload, ["prompt", "goal", "user_prompt", "userPrompt"]);
		await adapter.compactStarted({
			workspaceRoot: turnWorkspaceRoot,
			workspaceId: turnState.workspaceId,
			sessionId,
			turnId,
			trigger,
			hostHome,
			hostVersion: pickString(payload, ["claude_version", "claudeVersion", "client.version"]) ?? "claude-code-hook",
			summary: trigger ? `Claude Code pre-compact checkpoint (${trigger}).` : "Claude Code pre-compact checkpoint.",
			payload: {
				hookEventName: "PreCompact",
				goal: prompt,
				taskEvidence: await adapter.captureTaskEvidence(pickString(payload, ["transcript_path", "transcriptPath", "conversation_path", "conversationPath"]), sessionId, turnWorkspaceRoot, turnState.lastContextReadAt, prompt),
			},
		});
		saveHookTurnState(runtimeHome, state, {
			...turnState,
			sessionId,
			turnId,
			prompt,
			workspaceRoot: turnWorkspaceRoot,
			workspaceId: turnState.workspaceId,
			updatedAt: nowIso(),
		});
		return;
	}

	if (normalizedEventName === "postcompact" || normalizedEventName === "post_compact") {
		const requestedSessionId =
			pickString(payload, ["session_id", "sessionId", "session.id", "conversation_id", "conversationId"]) ??
			state.sessionId ??
			null;
		const requestedTurnId =
			pickString(payload, ["turn_id", "turnId", "event_id", "eventId", "id", "message_id", "messageId"]) ??
			state.turnId ??
			null;
		const turnState = selectHookTurnState(state, requestedSessionId, requestedTurnId);
		const sessionId = turnState.sessionId ?? requestedSessionId ?? buildSyntheticSessionId();
		const turnId = turnState.turnId ?? requestedTurnId ?? null;
    const turnWorkspaceRoot = turnState.workspaceRoot;
		const trigger = pickCompactionTrigger(payload);
		const prompt = turnState.prompt ?? pickString(payload, ["prompt", "goal", "user_prompt", "userPrompt"]);
		await adapter.compactCompleted({
			workspaceRoot: turnWorkspaceRoot,
			workspaceId: turnState.workspaceId,
			sessionId,
			turnId,
			trigger,
			hostHome,
			hostVersion: pickString(payload, ["claude_version", "claudeVersion", "client.version"]) ?? "claude-code-hook",
			summary: trigger ? `Claude Code post-compact sync (${trigger}).` : "Claude Code post-compact sync.",
			payload: {
				hookEventName: "PostCompact",
				goal: prompt,
			},
		});
		saveHookTurnState(runtimeHome, state, {
			...turnState,
			sessionId,
			turnId,
      prompt,
      workspaceRoot: turnWorkspaceRoot,
      workspaceId: turnState.workspaceId,
      updatedAt: nowIso(),
    });
    return;
  }

  if (normalizedEventName === "userpromptsubmit" || normalizedEventName === "user_prompt_submit") {
    const sessionId =
      pickString(payload, ["session_id", "sessionId", "session.id", "conversation_id", "conversationId"]) ??
      state.sessionId ??
      buildSyntheticSessionId();
    const prompt = pickString(payload, [
      "prompt",
      "text",
      "message",
      "user_prompt",
      "userPrompt",
      "input",
      "payload.prompt",
      "payload.text",
    ]);
    const turnId =
      pickString(payload, ["turn_id", "turnId", "event_id", "eventId", "id", "message_id", "messageId"]) ??
      buildSyntheticTurnId();
    const hookObservedAt = nowIso();
    const turnState = selectHookTurnState(state, sessionId, turnId);
    const turnWorkspaceRoot = turnState.workspaceRoot;
    if (!turnState.sessionId || turnState.sessionId !== sessionId) {
      await adapter.sessionStarted({
        workspaceRoot: turnWorkspaceRoot,
        workspaceId: turnState.workspaceId,
        sessionId,
        hostHome,
        hostVersion: pickString(payload, ["claude_version", "claudeVersion", "client.version"]) ?? "claude-code-hook",
      });
    }
    const prepared = await adapter.prepareTurn({
      workspaceRoot: turnWorkspaceRoot,
      workspaceId: turnState.workspaceId,
      sessionId,
      turnId,
      prompt: prompt ?? "",
      hostHome,
      hostVersion: pickString(payload, ["claude_version", "claudeVersion", "client.version"]) ?? "claude-code-hook",
      hookObservedAt,
      previousContextReadAt: turnState.lastContextReadAt,
      transcript: prompt ? [{ role: "user", content: prompt }] : [],
    });
    saveHookTurnState(runtimeHome, state, {
      sessionId,
      turnId,
      prompt,
      packId: prepared.packId,
      workspaceRoot: turnWorkspaceRoot,
      workspaceId: turnState.workspaceId,
      lastContextReadAt: hookObservedAt,
      updatedAt: hookObservedAt,
    });
    if (prepared.contextText.trim().length > 0) {
      process.stdout.write(`${prepared.contextText.trim()}\n`);
    }
    return;
  }

  if (normalizedEventName === "stop") {
    const requestedSessionId =
      pickString(payload, ["session_id", "sessionId", "session.id", "conversation_id", "conversationId"]) ??
      state.sessionId ??
      null;
    const requestedTurnId =
      pickString(payload, ["turn_id", "turnId", "event_id", "eventId", "id", "message_id", "messageId"]) ??
      state.turnId ??
      null;
    const turnState = selectHookTurnState(state, requestedSessionId, requestedTurnId);
    const sessionId = turnState.sessionId ?? requestedSessionId ?? buildSyntheticSessionId();
    const turnId = turnState.turnId ?? requestedTurnId ?? buildSyntheticTurnId();
    const turnWorkspaceRoot = turnState.workspaceRoot;
    const prompt = turnState.prompt ?? null;
    const packId = turnState.packId ?? null;
    const failed =
      pickBoolean(payload, ["failed", "failure", "error", "is_error", "isError"]) ??
      (() => {
        const success = pickBoolean(payload, ["success", "ok"]);
        return success === null ? false : !success;
      })();
    const summarySource =
      pickString(payload, [
        "summary",
        "error",
        "failure_reason",
        "failureReason",
        "last_assistant_message",
        "output_text",
        "outputText",
        "assistant_response",
        "assistantResponse",
        "message",
        "result",
      ]) ?? readLastAssistantMessage(
	pickString(payload, ["transcript_path", "transcriptPath"]), sessionId
      ) ?? "";
    const summary =
      summarySource.length > 0
	? captureHotFinding(summarySource)
        : prompt
          ? failed
            ? `Claude Code failed a hooked turn after: ${truncate(prompt, 180)}`
            : `Claude Code completed a hooked turn after: ${truncate(prompt, 180)}`
          : failed
            ? `Claude Code failed a hooked turn.`
            : `Claude Code completed a hooked turn.`;
    const taskEvidence = await adapter.captureTaskEvidence(
      pickString(payload, ["transcript_path", "transcriptPath", "conversation_path", "conversationPath"]),
      sessionId, turnWorkspaceRoot, turnState.lastContextReadAt, prompt
    );
    const transcript = buildTurnTranscript(prompt, summary, failed);
    const hostVersion = pickString(payload, ["claude_version", "claudeVersion", "client.version"]) ?? "claude-code-hook";
    if (failed) {
      await adapter.failTurn({
        workspaceRoot: turnWorkspaceRoot,
        workspaceId: turnState.workspaceId,
        sessionId,
        turnId,
        packId,
        goal: prompt ?? undefined,
        summary,
        hostHome,
        hostVersion,
        transcript,
	taskEvidence,
      });
    } else {
      await adapter.completeTurn({
        workspaceRoot: turnWorkspaceRoot,
        workspaceId: turnState.workspaceId,
        sessionId,
        turnId,
        packId,
        goal: prompt ?? undefined,
        summary,
        hostHome,
        hostVersion,
        transcript,
	taskEvidence,
      });
    }
    const sessionSummary =
      pickString(payload, ["session_summary", "sessionSummary", "stop_reason", "stopReason"]) ??
      (summarySource.length > 0
	? summary
	: prompt
        ? failed
          ? `Claude Code session ended after a failed turn for: ${truncate(prompt, 180)}`
          : `Claude Code session ended after: ${truncate(prompt, 180)}`
        : `Claude Code session ended.`);
    await adapter.sessionEnded({
      workspaceRoot: turnWorkspaceRoot,
      workspaceId: turnState.workspaceId,
      sessionId,
      turnId,
      packId,
      goal: prompt ?? undefined,
      summary: sessionSummary,
      hostHome,
      hostVersion,
      taskSucceeded: !failed,
      transcript,
      taskEvidence,
    });
    clearHookTurnState(runtimeHome, state, sessionId, turnId, {
      workspaceRoot: turnWorkspaceRoot,
      workspaceId: turnState.workspaceId,
      lastContextReadAt: turnState.lastContextReadAt,
    });
    
    return;
  }

  throw new Error(`Unsupported crosshead-claude-code-hook event: ${eventName}`);
};

if (require.main === module) {
  runOnlyBotsClaudeCodeHookCli().catch((error) => {
    reportHookFailure("claude-code", process.argv[2], error);
    process.exit(0);
  });
}
