import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertManagedFilePath, parseArgs, writeManagedFile } from "./adapter-utils";
import { loadNativeHostConfig, type NativeHostConfig } from "./native-host-adapter";
import { dispatchNativeHostEvent } from "./native-host-hook";
import { AUTO_UPDATE_TURN_MAX_MS, recordHostActivity } from "./runtime-idle-update";
import { loadProfile, resolveRuntimePaths } from "./runtime-persistence";
import { readWorkspaceHookPolicy, workspaceProfileOverrideFor } from "./workspace-hooks";
import { workspaceDirectoryPath, workspaceProjectRoot } from "./workspace-identity";

type AgyHookInput = {
	conversationId?: unknown;
	workspacePaths?: unknown;
	transcriptPath?: unknown;
	lastUserInput?: unknown;
	terminationReason?: unknown;
	error?: unknown;
};

type ActiveTurn = {
	sessionId: string;
	turnId: string;
	updatedAt: string;
	workspaceRoot: string;
	profileName: string;
	identity: string;
	promptHash: string;
	previousUser: string | null;
	user: string | null;
	prepared: boolean;
	packId: string | null;
};

type ConversationState = { activeTurns?: { current: ActiveTurn }; handledUser?: string };
type TranscriptTurn = { user: string; prompt: string; truncated: boolean; reply: string | null };

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const TRANSCRIPT_WAIT_MS = 2_500;
const TRANSCRIPT_CHUNK_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_SCAN_BYTES = 32 * 1024 * 1024;

const readState = (file: string): ConversationState => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as ConversationState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return {};
	}
};

// The global hook file is shared with the App and IDE. Open only the known
// CLI log for this conversation. A dotfiles symlink may alias the Gemini root.
const transcriptForConversation = (geminiHome: string, conversationId: string, provided: unknown): string | null => {
	if (typeof provided !== "string") return null;
	const supplied = provided.startsWith("~/") ? path.join(os.homedir(), provided.slice(2)) : provided;
	if (!path.isAbsolute(supplied)) return null;
	const name = path.basename(supplied);
	if (name !== "transcript.jsonl" && name !== "transcript_full.jsonl") return null;
	const suffix = path.join("antigravity-cli", "brain", conversationId, ".system_generated", "logs", name);
	const expected = path.join(geminiHome, suffix);
	return [expected, path.join(realpathSync(geminiHome), suffix)].includes(path.resolve(supplied)) ? expected : null;
};

// The full CLI transcript wraps the user text and appends local metadata.
// The hook's lastUserInput is the original text without that envelope.
const transcriptPrompt = (content: string, truncated: boolean): string => {
	const opening = "<USER_REQUEST>\n";
	const closing = "\n</USER_REQUEST>";
	if (!content.startsWith(opening)) return content;
	const metadata = content.lastIndexOf(closing + "\n<ADDITIONAL_METADATA>");
	if (metadata >= opening.length) return content.slice(opening.length, metadata);
	if (content.endsWith(closing)) return content.slice(opening.length, -closing.length);
	return truncated ? content.slice(opening.length) : content;
};

// Read backward to the newest user row without loading the entire transcript.
// Keep partial rows as bytes so multibyte characters survive chunk boundaries.
function* recentTranscriptLines(fd: number, size: number): Generator<string> {
	const buffer = Buffer.alloc(Math.min(size, TRANSCRIPT_CHUNK_BYTES));
	const floor = Math.max(0, size - MAX_TRANSCRIPT_SCAN_BYTES);
	let position = size;
	let fragments: Buffer[] = [];
	while (position > floor) {
		const length = Math.min(buffer.length, position - floor);
		position -= length;
		// A truncated file is retried by the Stop hook against a fresh snapshot.
		if (readSync(fd, buffer, 0, length, position) !== length) return;
		let end = length;
		while (end > 0) {
			const index = buffer.lastIndexOf(0x0a, end - 1);
			if (index < 0) break;
			const prefix = buffer.subarray(index + 1, end);
			if (prefix.length || fragments.length) {
				yield fragments.length ? Buffer.concat([prefix, ...fragments.reverse()]).toString("utf8") : prefix.toString("utf8");
			}
			fragments = [];
			end = index;
		}
		if (end > 0) fragments.push(Buffer.from(buffer.subarray(0, end)));
	}
	// The leftmost fragment is complete only if we reached the start of the file.
	if (floor === 0 && fragments.length) yield Buffer.concat(fragments.reverse()).toString("utf8");
}

const readLatestTurn = (geminiHome: string, transcript: string): TranscriptTurn | null => {
	assertManagedFilePath(transcript, geminiHome);
	let fd: number | undefined;
	try {
		fd = openSync(transcript, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile()) return null;
		let reply: string | null = null;
		let seenPlanner = false;
		for (const line of recentTranscriptLines(fd, stat.size)) {
			let step;
			try { step = JSON.parse(line); } catch { continue; }
			if (!step || !Number.isSafeInteger(step.step_index)) continue;
			if (step.source === "USER_EXPLICIT" && step.type === "USER_INPUT") {
				if (typeof step.content !== "string") return null;
				const truncated = Array.isArray(step.truncated_fields) && step.truncated_fields.includes("content");
				const prompt = transcriptPrompt(step.content, truncated);
				return {
					user: digest(JSON.stringify([step.step_index, step.created_at, prompt])),
					prompt,
					truncated,
					reply,
				};
			}
			if (seenPlanner || step.source !== "MODEL" || step.type !== "PLANNER_RESPONSE") continue;
			seenPlanner = true;
			const hasToolCalls = Array.isArray(step.tool_calls) && step.tool_calls.length > 0;
			// A planner issuing a tool call is intermediate even if its tool result
			// has not reached disk yet. Stop polls for the final text-only planner.
			if (!hasToolCalls && step.status === "DONE" && typeof step.content === "string" && step.content.trim()) {
				reply = step.content.slice(0, 16_384);
			}
		}
		return null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};

const matchesPrompt = (turn: TranscriptTurn | null, prompt: string): turn is TranscriptTurn => {
	if (!turn) return false;
	if (turn.prompt === prompt) return true;
	// Long user messages in agy logs contain a truncated prefix. When the
	// truncation flag is present require a substantial prefix from that row.
	return turn.truncated && turn.prompt.length >= 512 && prompt.length > turn.prompt.length &&
		prompt.startsWith(turn.prompt.slice(0, 512));
};

const userForTurn = (transcript: TranscriptTurn | null, active: ActiveTurn, prompt: string): TranscriptTurn | null =>
	matchesPrompt(transcript, prompt) && (active.user ? transcript.user === active.user : transcript.user !== active.previousUser)
		? transcript : null;

const prepareTurn = async (config: NativeHostConfig, active: ActiveTurn, prompt: string) => {
	const result = await dispatchNativeHostEvent(config, "prepare", { ...active, prompt });
	if (!("injectedPrompt" in result)) return null;
	active.prepared = true;
	active.packId = result.packId ?? null;
	return result.contextText ? { injectSteps: [{ ephemeralMessage: result.contextText }] } : {};
};

// Some agy versions emit the model run's internal stop reason rather than
// the public hook example's model_stop value.
const isCompletedResponse = (reason: unknown) => reason === "model_stop" || reason === "NO_TOOL_CALL";

const handleHook = async (event: "prepare" | "complete", input: AgyHookInput, home?: string) => {
	const { conversationId: sessionId, lastUserInput: prompt, workspacePaths } = input;
	if (typeof sessionId !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(sessionId) || typeof prompt !== "string" || !prompt.trim() ||
		!Array.isArray(workspacePaths) || workspacePaths.length === 0 || workspacePaths.length > 32 ||
		!workspacePaths.every((directory): directory is string => typeof directory === "string" && path.isAbsolute(directory))) return {};
	const config = loadNativeHostConfig("agy", home);
	const transcript = transcriptForConversation(config.hostHome, sessionId, input.transcriptPath);
	if (!transcript) return {};
	const roots = new Set(workspacePaths.map(workspaceProjectRoot));
	const workspaceRoot = roots.values().next().value;
	if (roots.size !== 1 || !workspaceRoot) return {};
	const paths = resolveRuntimePaths(config.runtimeHome);
	const file = path.join(paths.state, "agy-turns", digest(sessionId) + ".json");
	assertManagedFilePath(file, paths.home);
	const state = readState(file);
	const active = state.activeTurns?.current;
	const directory = workspaceDirectoryPath(workspacePaths[0]!);
	const profileName = workspaceProfileOverrideFor(readWorkspaceHookPolicy(paths), directory)?.profile ?? config.profileName;
	const profile = loadProfile(paths, profileName);
	const identity = profile ? digest(profile.npub) : "";
	const promptHash = digest(prompt);
	const sameRequest = active?.workspaceRoot === workspaceRoot && active.promptHash === promptHash;
	const sameProfile = active?.profileName === profileName && active.identity === identity;
	const matches = active && "previousUser" in active && sameRequest && sameProfile && Date.now() - Date.parse(active.updatedAt) < AUTO_UPDATE_TURN_MAX_MS;
	const canCapture = profile?.memoryMode === "assist" || profile?.memoryMode === "auto";
	const saveState = (value: ConversationState) => {
		if (value.activeTurns || value.handledUser) writeManagedFile(file, JSON.stringify(value), paths.home);
		else rmSync(file, { force: true });
	};

	if (event === "prepare") {
		if (!canCapture) return {};
		const latest = readLatestTurn(config.hostHome, transcript);
		const observed = matchesPrompt(latest, prompt) ? latest.user : null;
		const newUser = observed && observed !== state.handledUser && !latest?.reply ? observed : null;
		// Additional invocations in one turn can happen after tool use. The
		// explicit transcript user row anchors the turn, independent of counters.
		const changedUser = active?.user && newUser && newUser !== active.user;
		if (sameRequest && !sameProfile && !changedUser) return {};
		recordHostActivity(paths);
		const current: ActiveTurn = matches && !changedUser ? active : {
			sessionId, turnId: randomUUID(), updatedAt: "", workspaceRoot, profileName, identity, promptHash,
			previousUser: latest?.user ?? null, user: newUser, prepared: false, packId: null,
		};
		if (!current.user && newUser && newUser !== current.previousUser) current.user = newUser;
		current.updatedAt = new Date().toISOString();
		// A background wake-up may carry the previous prompt. Wait for a new
		// user row before injecting again. Stop can still save a late-written turn.
		const waitForUser = !current.user && observed !== null;
		const output = current.prepared || waitForUser ? {} : await prepareTurn(config, current, prompt);
		if (output === null) {
			saveState({ handledUser: state.handledUser });
			return {};
		}
		saveState({ ...state, activeTurns: { current } });
		return output;
	}

	if (!active || !sameRequest) return {};
	let finishedUser: TranscriptTurn | null = null;
	try {
		if (!matches || !canCapture || !isCompletedResponse(input.terminationReason) || input.error) return {};
		recordHostActivity(paths);
		const deadline = Date.now() + TRANSCRIPT_WAIT_MS;
		for (;;) {
			finishedUser = userForTurn(readLatestTurn(config.hostHome, transcript), active, prompt);
			if (finishedUser?.reply || Date.now() >= deadline) break;
			await delay(150);
		}
		if (readState(file).activeTurns?.current.turnId !== active.turnId) return {};
		if (finishedUser?.reply) {
			await dispatchNativeHostEvent(config, "complete", { ...active, prompt, summary: finishedUser.reply });
		} else if (active.prepared || finishedUser) {
			process.stderr.write("Crosshead found no final Antigravity reply for this turn; no checkpoint was saved.\n");
		}
	} finally {
		const latestState = readState(file);
		if (latestState.activeTurns?.current.turnId === active.turnId) {
			saveState({ handledUser: finishedUser?.user ?? active.user ?? latestState.handledUser });
		}
	}
	return {};
};

export const runAgyHookCli = async (argv: string[]): Promise<void> => {
	try {
		const { positionals, flags } = parseArgs(argv);
		const event = positionals[0];
		if (event !== "prepare" && event !== "complete") throw new Error("Unknown Antigravity hook event.");
		const chunks: Buffer[] = [];
		let length = 0;
		for await (const value of process.stdin) {
			const chunk = Buffer.from(value);
			length += chunk.length;
			if (length > 262_144) throw new Error("Antigravity hook input too large.");
			chunks.push(chunk);
		}
		const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AgyHookInput;
		const result = await handleHook(event, data, typeof flags.home === "string" ? flags.home : undefined);
		process.stdout.write(JSON.stringify(result) + "\n");
	} catch {
		process.stderr.write("Crosshead could not complete an Antigravity CLI hook. Run crosshead doctor to diagnose.\n");
		process.stdout.write("{}\n");
	}
};

if (require.main === module) void runAgyHookCli(process.argv.slice(2));
