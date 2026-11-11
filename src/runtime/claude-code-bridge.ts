import { ClaudeCodeRuntimeAdapter } from "./claude-code-adapter";
import { runCheckpointPageCommand } from "./checkpoint-pages";
import { assertSecureNodeRuntimeVersion } from "./node-runtime-version";

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

const parseTranscript = (value: string | boolean | undefined) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return JSON.parse(value) as Array<{
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    timestamp?: string;
  }>;
};

const parseStringArray = (value: string | boolean | undefined): string[] | undefined => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return JSON.parse(value) as string[];
};

const parseBooleanFlag = (value: string | boolean | undefined): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
};

export const runOnlyBotsClaudeCodeBridgeCli = async (argv: string[] = process.argv.slice(2)): Promise<void> => {
	assertSecureNodeRuntimeVersion();
  const { positionals, flags } = parseArgs(argv);
  const command = positionals[0] ?? "help";
  if (command === "checkpoint-page") {
    runCheckpointPageCommand("claude-code", positionals, flags);
    return;
  }

  if (command === "help") {
    process.stdout.write(
      [
        "crosshead-claude-code print --workspace-root <path> --session-id <id> --turn-id <id> --prompt <text> [--claude-bin <path>] [--model <name>] [--claude-args '[\"--output-format\",\"json\"]']",
        "crosshead-claude-code session-start --workspace-root <path> --session-id <id>",
        "crosshead-claude-code session-end --workspace-root <path> --session-id <id> --summary <text> [--goal <text>] [--turn-id <id>] [--pack-id <id>] [--task-succeeded true|false]",
        "crosshead-claude-code turn-start --workspace-root <path> --session-id <id> --turn-id <id> --prompt <text> [--transcript '<json>']",
        "crosshead-claude-code turn-failed --workspace-root <path> --session-id <id> --turn-id <id> --summary <text> [--goal <text>] [--pack-id <id>]",
        "crosshead-claude-code tool-completed --workspace-root <path> --session-id <id> --tool-name <name> --summary <text>",
        "crosshead-claude-code task-changed --workspace-root <path> --session-id <id> --task-title <text>",
        "crosshead-claude-code turn-completed --workspace-root <path> --session-id <id> --turn-id <id> --summary <text> [--goal <text>] [--pack-id <id>]",
        "crosshead-claude-code remember --workspace-root <path> --session-id <id> --content <text> [--entry-type fact]",
        "crosshead-claude-code search-memory --query <text> [--top-k 10]",
		"crosshead-claude-code inbox-state [--profile <name>] [--unread-only true|false] [--include-terminal true|false] [--limit <n>]",
		"crosshead-claude-code inbox-replay (--inbox-id <id>|--message-event-id <id>) [--profile <name>] [--note <text>]",
		"crosshead-claude-code inbox-ack (--inbox-id <id>|--message-event-id <id>) [--profile <name>] [--actor-runtime-host <host>] [--note <text>]",
		"crosshead-claude-code inbox-resolve (--inbox-id <id>|--message-event-id <id>) --resolution <completed|failed|rejected> [--profile <name>] [--result-summary <text>] [--failure-code <code>] [--retryable true|false] [--reason <text>] [--note <text>]",
        "crosshead-claude-code export-memory",
      ].join("\n") + "\n"
    );
    return;
  }

  const adapter = ClaudeCodeRuntimeAdapter.fromInstalled({
    home: typeof flags.home === "string" ? flags.home : undefined,
    hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
  });

  if (command === "print") {
    const result = await adapter.runPrintPrompt({
      profileName: typeof flags.profile === "string" ? flags.profile : undefined,
      workspaceRoot: String(flags["workspace-root"] ?? flags.workspaceRoot ?? ""),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
      hostVersion: typeof flags["host-version"] === "string" ? flags["host-version"] : undefined,
      sessionId: String(flags["session-id"] ?? flags.sessionId ?? ""),
      turnId: String(flags["turn-id"] ?? flags.turnId ?? ""),
      prompt: String(flags.prompt ?? ""),
      transcript: parseTranscript(flags.transcript),
      claudeBin: typeof flags["claude-bin"] === "string" ? flags["claude-bin"] : undefined,
      model: typeof flags.model === "string" ? flags.model : undefined,
      claudeArgs: parseStringArray(flags["claude-args"]),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "session-start") {
    await adapter.sessionStarted({
      profileName: typeof flags.profile === "string" ? flags.profile : undefined,
      workspaceRoot: String(flags["workspace-root"] ?? flags.workspaceRoot ?? ""),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
      hostVersion: typeof flags["host-version"] === "string" ? flags["host-version"] : undefined,
      sessionId: String(flags["session-id"] ?? flags.sessionId ?? ""),
    });
    process.stdout.write("session.started\n");
    return;
  }

  if (command === "session-end") {
    await adapter.sessionEnded({
      profileName: typeof flags.profile === "string" ? flags.profile : undefined,
      workspaceRoot: String(flags["workspace-root"] ?? flags.workspaceRoot ?? ""),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
      hostVersion: typeof flags["host-version"] === "string" ? flags["host-version"] : undefined,
      sessionId: String(flags["session-id"] ?? flags.sessionId ?? ""),
      turnId: typeof flags["turn-id"] === "string" ? flags["turn-id"] : undefined,
      packId: typeof flags["pack-id"] === "string" ? flags["pack-id"] : undefined,
      goal: typeof flags.goal === "string" ? flags.goal : undefined,
      summary: String(flags.summary ?? ""),
      taskSucceeded: parseBooleanFlag(flags["task-succeeded"]),
      transcript: parseTranscript(flags.transcript),
    });
    process.stdout.write("session.ended\n");
    return;
  }

  if (command === "turn-start") {
    const result = await adapter.prepareTurn({
      profileName: typeof flags.profile === "string" ? flags.profile : undefined,
      workspaceRoot: String(flags["workspace-root"] ?? flags.workspaceRoot ?? ""),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
      hostVersion: typeof flags["host-version"] === "string" ? flags["host-version"] : undefined,
      sessionId: String(flags["session-id"] ?? flags.sessionId ?? ""),
      turnId: String(flags["turn-id"] ?? flags.turnId ?? ""),
      prompt: String(flags.prompt ?? ""),
      transcript: parseTranscript(flags.transcript),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "tool-completed") {
    await adapter.toolCompleted({
      profileName: typeof flags.profile === "string" ? flags.profile : undefined,
      workspaceRoot: String(flags["workspace-root"] ?? flags.workspaceRoot ?? ""),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
      hostVersion: typeof flags["host-version"] === "string" ? flags["host-version"] : undefined,
      sessionId: String(flags["session-id"] ?? flags.sessionId ?? ""),
      turnId: typeof flags["turn-id"] === "string" ? flags["turn-id"] : undefined,
      toolName: String(flags["tool-name"] ?? flags.toolName ?? ""),
      summary: String(flags.summary ?? ""),
    });
    process.stdout.write("tool.completed\n");
    return;
  }

  if (command === "turn-failed") {
    await adapter.failTurn({
      profileName: typeof flags.profile === "string" ? flags.profile : undefined,
      workspaceRoot: String(flags["workspace-root"] ?? flags.workspaceRoot ?? ""),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
      hostVersion: typeof flags["host-version"] === "string" ? flags["host-version"] : undefined,
      sessionId: String(flags["session-id"] ?? flags.sessionId ?? ""),
      turnId: String(flags["turn-id"] ?? flags.turnId ?? ""),
      packId: typeof flags["pack-id"] === "string" ? flags["pack-id"] : undefined,
      goal: typeof flags.goal === "string" ? flags.goal : undefined,
      summary: String(flags.summary ?? ""),
      transcript: parseTranscript(flags.transcript),
    });
    process.stdout.write("turn.failed\n");
    return;
  }

  if (command === "task-changed") {
    await adapter.taskChanged({
      profileName: typeof flags.profile === "string" ? flags.profile : undefined,
      workspaceRoot: String(flags["workspace-root"] ?? flags.workspaceRoot ?? ""),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
      hostVersion: typeof flags["host-version"] === "string" ? flags["host-version"] : undefined,
      sessionId: String(flags["session-id"] ?? flags.sessionId ?? ""),
      taskTitle: String(flags["task-title"] ?? flags.taskTitle ?? ""),
      summary: typeof flags.summary === "string" ? flags.summary : undefined,
    });
    process.stdout.write("task.changed\n");
    return;
  }

  if (command === "turn-completed") {
    await adapter.completeTurn({
      profileName: typeof flags.profile === "string" ? flags.profile : undefined,
      workspaceRoot: String(flags["workspace-root"] ?? flags.workspaceRoot ?? ""),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
      hostVersion: typeof flags["host-version"] === "string" ? flags["host-version"] : undefined,
      sessionId: String(flags["session-id"] ?? flags.sessionId ?? ""),
      turnId: String(flags["turn-id"] ?? flags.turnId ?? ""),
      packId: typeof flags["pack-id"] === "string" ? flags["pack-id"] : undefined,
      goal: typeof flags.goal === "string" ? flags.goal : undefined,
      summary: String(flags.summary ?? ""),
      transcript: parseTranscript(flags.transcript),
      newFact: typeof flags["new-fact"] === "string" ? flags["new-fact"] : undefined,
      newCommitment: typeof flags["new-commitment"] === "string" ? flags["new-commitment"] : undefined,
    });
    process.stdout.write("turn.completed\n");
    return;
  }

  if (command === "remember") {
    await adapter.remember({
      profileName: typeof flags.profile === "string" ? flags.profile : undefined,
      workspaceRoot: String(flags["workspace-root"] ?? flags.workspaceRoot ?? ""),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
      hostVersion: typeof flags["host-version"] === "string" ? flags["host-version"] : undefined,
      sessionId: String(flags["session-id"] ?? flags.sessionId ?? ""),
      entryType:
        typeof flags["entry-type"] === "string"
          ? (flags["entry-type"] as "fact" | "commitment" | "correction" | "pattern")
          : undefined,
      content: String(flags.content ?? ""),
      tags: typeof flags.tags === "string" ? flags.tags.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined,
    });
    process.stdout.write("operator.command remember\n");
    return;
  }

  if (command === "search-memory") {
    const result = await adapter.searchMemory(
      String(flags.query ?? ""),
      typeof flags.profile === "string" ? flags.profile : undefined,
      typeof flags["top-k"] === "string" ? Number(flags["top-k"]) : 10,
      false,
      typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : process.env.CROSSHEAD_WORKSPACE_ID ?? process.env.ONLYBOTS_WORKSPACE_ID ?? `repo:${typeof flags["workspace-root"] === "string" ? flags["workspace-root"] : process.env.ONLYBOTS_WORKSPACE_ROOT ?? process.cwd()}`
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "export-memory") {
    const result = await adapter.exportMemory(typeof flags.profile === "string" ? flags.profile : undefined);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "inbox-state") {
    const result = await adapter.inspectInboxState(typeof flags.profile === "string" ? flags.profile : undefined, {
      unreadOnly: parseBooleanFlag(flags["unread-only"]),
      includeTerminal: parseBooleanFlag(flags["include-terminal"]),
      limit: typeof flags.limit === "string" ? Number(flags.limit) : undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "inbox-replay") {
    const result = await adapter.replayInboxItem({
      inboxId: typeof flags["inbox-id"] === "string" ? flags["inbox-id"] : undefined,
      messageEventId: typeof flags["message-event-id"] === "string" ? flags["message-event-id"] : undefined,
      note: typeof flags.note === "string" ? flags.note : undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "inbox-ack") {
    const result = await adapter.acknowledgeInboxItem({
      inboxId: typeof flags["inbox-id"] === "string" ? flags["inbox-id"] : undefined,
      messageEventId: typeof flags["message-event-id"] === "string" ? flags["message-event-id"] : undefined,
      actorRuntimeHost:
		typeof flags["actor-runtime-host"] === "string" ? flags["actor-runtime-host"] : undefined,
      note: typeof flags.note === "string" ? flags.note : undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "inbox-resolve") {
    const result = await adapter.resolveInboxItem({
      inboxId: typeof flags["inbox-id"] === "string" ? flags["inbox-id"] : undefined,
      messageEventId: typeof flags["message-event-id"] === "string" ? flags["message-event-id"] : undefined,
      actorRuntimeHost:
		typeof flags["actor-runtime-host"] === "string" ? flags["actor-runtime-host"] : undefined,
      resolution: typeof flags.resolution === "string" ? flags.resolution : undefined,
      resultSummary:
		typeof flags["result-summary"] === "string" ? flags["result-summary"] : undefined,
      failureCode:
		typeof flags["failure-code"] === "string" ? flags["failure-code"] : undefined,
      retryable: parseBooleanFlag(flags.retryable),
      reason: typeof flags.reason === "string" ? flags.reason : undefined,
      note: typeof flags.note === "string" ? flags.note : undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new Error(`Unsupported crosshead-claude-code command: ${command}`);
};

if (require.main === module) {
  runOnlyBotsClaudeCodeBridgeCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
