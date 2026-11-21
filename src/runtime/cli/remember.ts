import { importWorkspaceRoot, scopedHandoffBinding, scopedWorkspaceId } from "./handoff";
import { parseArgs } from "../local-runtime";

export const rememberHelpLine =
	'crosshead remember "<text>" [--type fact|commitment|correction|pattern] [--host claude-code|codex] [--workspace-root <path>] [--profile <name>] [--home <path>]';

const ENTRY_TYPES = ["fact", "commitment", "correction", "pattern"] as const;
type EntryType = (typeof ENTRY_TYPES)[number];

/** The host this command runs under: an explicit --host, else what the calling session exports. */
const detectHost = (flag: string | undefined): "claude-code" | "codex" => {
	if (flag === "claude-code" || flag === "codex") return flag;
	if (flag) throw new Error("--host must be claude-code or codex");
	if (process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDECODE) return "claude-code";
	if (process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || process.env.CODEX_HOME) return "codex";
	throw new Error("Could not tell whether this is Claude Code or Codex; pass --host claude-code or --host codex");
};

/**
 * Saves one explicit fact to hot continuity for the current project, so a later session (in either host) receives it.
 * Agents call this directly; it works out the host, project root, profile and session itself.
 */
export const rememberFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const content = (typeof flags.content === "string" ? flags.content : positionals.join(" ")).trim();
	if (!content) throw new Error(`remember needs the text to save\n${rememberHelpLine}`);
	const typeFlag = typeof flags.type === "string" ? flags.type : typeof flags["entry-type"] === "string" ? flags["entry-type"] : "fact";
	if (!ENTRY_TYPES.includes(typeFlag as EntryType)) throw new Error(`--type must be one of ${ENTRY_TYPES.join(", ")}`);
	const host = detectHost(typeof flags.host === "string" ? flags.host : undefined);
	const home = typeof flags.home === "string" ? flags.home : undefined;
	const profileName = typeof flags.profile === "string" ? flags.profile : undefined;
	const workspaceRoot = importWorkspaceRoot(typeof flags["workspace-root"] === "string" ? flags["workspace-root"] : process.cwd());
	const sessionId = host === "claude-code"
		? process.env.CLAUDE_CODE_SESSION_ID
		: process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
	const scoped = scopedHandoffBinding(home, host, workspaceRoot, profileName, undefined);
	const request = {
		profileName: scoped?.profileName ?? profileName,
		workspaceRoot: scoped?.root ?? workspaceRoot,
		workspaceId: scoped ? scopedWorkspaceId(scoped.root, undefined) : undefined,
		sessionId: sessionId || undefined,
		entryType: typeFlag as EntryType,
		content,
		tags: [host, "explicit"],
	};
	if (host === "claude-code") {
		const { ClaudeCodeRuntimeAdapter } = await import("../claude-code-adapter");
		const adapter = scoped
			? ClaudeCodeRuntimeAdapter.forWorkspace(scoped.home, scoped.hostHome, scoped.root, scoped.profileName, scoped.sourceExcerpts, scoped.legacyUnscoped, scoped.legacyBefore)
			: ClaudeCodeRuntimeAdapter.fromInstalled({ home });
		await adapter.remember(request);
	} else {
		const { CodexRuntimeAdapter } = await import("../codex-adapter");
		const adapter = scoped
			? CodexRuntimeAdapter.forWorkspace(scoped.home, scoped.hostHome, scoped.profileName, scoped.sourceExcerpts, scoped.legacyUnscoped, scoped.legacyBefore)
			: CodexRuntimeAdapter.fromInstalled({ home });
		await adapter.remember(request);
	}
	return flags.json === true
		? JSON.stringify({ remembered: true, host, entryType: typeFlag, workspaceRoot: request.workspaceRoot }, null, 2)
		: `Remembered for ${request.workspaceRoot} (${typeFlag}). New ${host === "claude-code" ? "Claude Code" : "Codex"} and other host sessions in this project will see it.`;
};
