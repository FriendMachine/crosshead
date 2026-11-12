import path from "path";
import { runCheckpointPageCommand } from "./checkpoint-pages";

import { CodexRuntimeAdapter } from "./codex-adapter";
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

const canonicalCommand = (command: string): string => {
  switch (command) {
    case "memory_hot":
      return "memory-hot";
    case "memory_warm":
      return "memory-warm";
    case "memory_search":
    case "search-memory":
      return "memory-search";
    case "inbox_state":
      return "inbox-state";
    case "inbox_replay":
      return "inbox-replay";
    case "inbox_ack":
      return "inbox-ack";
    case "inbox_resolve":
      return "inbox-resolve";
    case "session_end":
      return "session-end";
    case "turn_failed":
      return "turn-failed";
    default:
      return command;
  }
};

const commandUsage = (command?: string): string[] => {
  switch (command) {
    case "session-start":
      return ["crosshead-codex session-start --workspace-root <path> --session-id <id>"];
    case "session-end":
      return [
        "crosshead-codex session-end --workspace-root <path> --session-id <id> --summary <text> [--goal <text>] [--turn-id <id>] [--pack-id <id>] [--task-succeeded true|false]",
      ];
    case "turn-start":
      return [
        "crosshead-codex turn-start --workspace-root <path> --session-id <id> --turn-id <id> --prompt <text> [--transcript '<json>']",
      ];
    case "turn-failed":
      return [
        "crosshead-codex turn-failed --workspace-root <path> --session-id <id> --turn-id <id> --summary <text> [--goal <text>] [--pack-id <id>] [--transcript '<json>']",
      ];
    case "tool-completed":
      return ["crosshead-codex tool-completed --workspace-root <path> --session-id <id> --tool-name <name> --summary <text>"];
    case "task-changed":
      return ["crosshead-codex task-changed --workspace-root <path> --session-id <id> --task-title <text>"];
    case "turn-completed":
      return [
        "crosshead-codex turn-completed --workspace-root <path> --session-id <id> --turn-id <id> --summary <text> [--goal <text>] [--pack-id <id>]",
      ];
    case "remember":
      return [
        "crosshead-codex remember --content <text> [--entry-type fact|commitment|correction|pattern] [--workspace-root <path>] [--session-id <id>] [--tags a,b,c]",
      ];
    case "memory-hot":
      return ["crosshead-codex memory-hot [--profile <name>] [--scope all|shared|codex|claude-code]"];
    case "memory-warm":
      return ["crosshead-codex memory-warm [--profile <name>] [--type <type>] [--status <status>] [--include-system]"];
    case "memory-search":
      return ["crosshead-codex memory-search --query <text> [--profile <name>] [--top-k <n>] [--include-system]"];
    case "export-memory":
      return ["crosshead-codex export-memory [--profile <name>]"];
    case "inbox-state":
      return ["crosshead-codex inbox-state [--profile <name>] [--unread-only true|false] [--include-terminal true|false] [--limit <n>]"];
    case "inbox-replay":
      return ["crosshead-codex inbox-replay (--inbox-id <id>|--message-event-id <id>) [--profile <name>] [--note <text>]"];
    case "inbox-ack":
      return ["crosshead-codex inbox-ack (--inbox-id <id>|--message-event-id <id>) [--profile <name>] [--actor-runtime-host <host>] [--note <text>]"];
    case "inbox-resolve":
      return ["crosshead-codex inbox-resolve (--inbox-id <id>|--message-event-id <id>) --resolution <completed|failed|rejected> [--profile <name>] [--result-summary <text>] [--failure-code <code>] [--retryable true|false] [--reason <text>] [--note <text>]"];
    default:
      return [
        "crosshead-codex capabilities:",
        "  memory_hot     crosshead-codex memory-hot",
        "  memory_warm    crosshead-codex memory-warm",
        "  memory_search  crosshead-codex memory-search --query \"...\"",
		"  inbox_state    crosshead-codex inbox-state",
		"  inbox_replay   crosshead-codex inbox-replay --inbox-id <id>",
        "  remember       crosshead-codex remember --content \"...\" --entry-type fact",
        "",
        "Legacy bridge commands:",
        "  crosshead-codex session-start --workspace-root <path> --session-id <id>",
        "  crosshead-codex session-end --workspace-root <path> --session-id <id> --summary <text> [--goal <text>]",
        "  crosshead-codex turn-start --workspace-root <path> --session-id <id> --turn-id <id> --prompt <text> [--transcript '<json>']",
        "  crosshead-codex turn-failed --workspace-root <path> --session-id <id> --turn-id <id> --summary <text> [--goal <text>]",
        "  crosshead-codex tool-completed --workspace-root <path> --session-id <id> --tool-name <name> --summary <text>",
        "  crosshead-codex task-changed --workspace-root <path> --session-id <id> --task-title <text>",
        "  crosshead-codex turn-completed --workspace-root <path> --session-id <id> --turn-id <id> --summary <text> [--goal <text>] [--pack-id <id>]",
		"  crosshead-codex inbox-state [--profile <name>]",
        "  crosshead-codex export-memory [--profile <name>]",
      ];
  }
};

const resolveWorkspaceRoot = (flags: Record<string, string | boolean>): string =>
  path.resolve(String(flags["workspace-root"] ?? flags.workspaceRoot ?? process.cwd()));

const resolveQuery = (flags: Record<string, string | boolean>, positionals: string[]): string =>
  typeof flags.query === "string" ? flags.query : positionals.slice(1).join(" ").trim();

export const runOnlyBotsCodexBridgeCli = async (argv: string[] = process.argv.slice(2)): Promise<void> => {
	assertSecureNodeRuntimeVersion();
  const { positionals, flags } = parseArgs(argv);
  const command = canonicalCommand(positionals[0] ?? "help");
  if (command === "checkpoint-page") {
    runCheckpointPageCommand("codex", positionals, flags);
    return;
  }

  if (command === "help" || flags.help) {
    process.stdout.write(`${commandUsage(command === "help" ? undefined : command).join("\n")}\n`);
    return;
  }

  const adapter = CodexRuntimeAdapter.fromInstalled({
    home: typeof flags.home === "string" ? flags.home : undefined,
    hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
  });

  if (command === "session-start") {
    await adapter.sessionStarted({
      profileName: typeof flags.profile === "string" ? flags.profile : undefined,
      workspaceRoot: resolveWorkspaceRoot(flags),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
      hostVersion: typeof flags["host-version"] === "string" ? flags["host-version"] : undefined,
      sessionId: String(flags["session-id"] ?? flags.sessionId ?? ""),
    });
    process.stdout.write("session.started\n");
    return;
  }

  if (command === "session-end") {
    await adapter.sessionEnded({
      profileName: typeof flags.profile === "string" ? flags.profile : undefined,
      workspaceRoot: resolveWorkspaceRoot(flags),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
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
      workspaceRoot: resolveWorkspaceRoot(flags),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
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
      workspaceRoot: resolveWorkspaceRoot(flags),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
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
      workspaceRoot: resolveWorkspaceRoot(flags),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
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
      workspaceRoot: resolveWorkspaceRoot(flags),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
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
      workspaceRoot: resolveWorkspaceRoot(flags),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
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
      workspaceRoot: resolveWorkspaceRoot(flags),
      workspaceId: typeof flags["workspace-id"] === "string" ? flags["workspace-id"] : undefined,
      hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
      hostVersion: typeof flags["host-version"] === "string" ? flags["host-version"] : undefined,
      sessionId: typeof flags["session-id"] === "string" ? flags["session-id"] : undefined,
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

  if (command === "memory-hot") {
    const result = await adapter.readHotMemory(
      typeof flags.profile === "string" ? flags.profile : undefined,
      typeof flags.scope === "string" && flags.scope.length > 0 ? flags.scope : "all"
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "memory-warm") {
    const result = await adapter.listWarmMemory(typeof flags.profile === "string" ? flags.profile : undefined, {
      type: typeof flags.type === "string" ? flags.type : undefined,
      status: typeof flags.status === "string" ? flags.status : undefined,
      includeSystemMemory: flags["include-system"] === true || flags.includeSystem === true,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "memory-search") {
    const query = resolveQuery(flags, positionals);
    if (query.length === 0) {
      throw new Error("memory-search requires --query <text> or a positional query");
    }
    const result = await adapter.searchMemory(
      query,
      typeof flags.profile === "string" ? flags.profile : undefined,
      typeof flags["top-k"] === "string" ? Number(flags["top-k"]) : 10,
      flags["include-system"] === true || flags.includeSystem === true,
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

  throw new Error(`Unsupported crosshead-codex command: ${command}`);
};

if (require.main === module) {
  runOnlyBotsCodexBridgeCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
