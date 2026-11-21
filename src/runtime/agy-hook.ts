import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertManagedFilePath, parseArgs, writeManagedFile } from "./adapter-utils";
import { loadNativeHostConfig } from "./native-host-adapter";
import { dispatchNativeHostEvent } from "./native-host-hook";
import { AUTO_UPDATE_TURN_MAX_MS } from "./runtime-idle-update";
import { loadProfile, resolveRuntimePaths } from "./runtime-persistence";
import { readWorkspaceHookPolicy, workspaceProfileOverrideFor } from "./workspace-hooks";
import { workspaceDirectoryPath, workspaceProjectRoot } from "./workspace-identity";

type AgyHookInput = {
	conversationId?: unknown;
	workspacePaths?: unknown;
	transcriptPath?: unknown;
	lastUserInput?: unknown;
	invocationNum?: unknown;
	initialNumSteps?: unknown;
	terminationReason?: unknown;
	fullyIdle?: unknown;
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
	initialNumSteps: number;
	packId: string | null;
};

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const isStep = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const readTurn = (file: string): ActiveTurn | undefined => {
	try {
		return (JSON.parse(readFileSync(file, "utf8")) as { activeTurns?: { current?: ActiveTurn } }).activeTurns?.current;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
};

const isActive = (turn: ActiveTurn | undefined): turn is ActiveTurn =>
	Boolean(turn && Date.now() - Date.parse(turn.updatedAt) < AUTO_UPDATE_TURN_MAX_MS);

// The global hook file is shared with the App and IDE. Limit this adapter to
// CLI transcripts and open only the documented log for this conversation.
const transcriptForConversation = (geminiHome: string, conversationId: string, provided: unknown): string | null => {
	if (typeof provided !== "string") return null;
	const supplied = provided.startsWith("~/") ? path.join(os.homedir(), provided.slice(2)) : provided;
	const expected = path.join(geminiHome, "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
	return path.isAbsolute(supplied) && path.resolve(supplied) === expected ? expected : null;
};

const readFinalResponse = (geminiHome: string, transcript: string, initialNumSteps: number): string | null => {
	assertManagedFilePath(transcript, geminiHome);
	let fd: number | undefined;
	try {
		fd = openSync(transcript, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile()) return null;
		const length = Math.min(stat.size, 1024 * 1024);
		const buffer = Buffer.alloc(length);
		const offset = stat.size - length;
		const bytes = readSync(fd, buffer, 0, length, offset);
		const lines = buffer.subarray(0, bytes).toString("utf8").split(/\r?\n/);
		if (offset > 0) lines.shift();
		for (const line of lines.reverse()) {
			let step;
			try { step = JSON.parse(line); } catch { continue; }
			if (!step || !isStep(step.step_index)) continue;
			if (step.step_index < initialNumSteps) return null;
			if (step.source === "USER_EXPLICIT" && step.type === "USER_INPUT") return null;
			if (step.source !== "MODEL" || step.type !== "PLANNER_RESPONSE") continue;
			// Planner steps may contain reasoning and tool calls. Only a finished
			// model message with displayable text is a checkpoint.
			return step.status === "DONE" && typeof step.content === "string" && step.content.trim() &&
				(!Array.isArray(step.tool_calls) || step.tool_calls.length === 0) ? step.content.slice(0, 16_384) : null;
		}
		return null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};

const handleHook = async (event: "prepare" | "complete", input: AgyHookInput, home?: string) => {
	const { conversationId: sessionId, lastUserInput: prompt, workspacePaths } = input;
	if (typeof sessionId !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(sessionId) || typeof prompt !== "string" || !prompt.trim() ||
		!Array.isArray(workspacePaths) || workspacePaths.length === 0 || workspacePaths.length > 32 ||
		!workspacePaths.every((directory): directory is string => typeof directory === "string" && path.isAbsolute(directory))) return {};
	if (event === "prepare" && (input.invocationNum !== 0 || !isStep(input.initialNumSteps))) return {};
	const config = loadNativeHostConfig("agy", home);
	const transcript = transcriptForConversation(config.hostHome, sessionId, input.transcriptPath);
	if (!transcript) return {};
	const roots = new Set(workspacePaths.map(workspaceProjectRoot));
	const workspaceRoot = roots.values().next().value;
	if (roots.size !== 1 || !workspaceRoot) return {};
	const paths = resolveRuntimePaths(config.runtimeHome);
	const file = path.join(paths.state, "agy-turns", digest(sessionId) + ".json");
	assertManagedFilePath(file, paths.home);
	const active = readTurn(file);
	const directory = workspaceDirectoryPath(workspacePaths[0]!);
	const profileName = workspaceProfileOverrideFor(readWorkspaceHookPolicy(paths), directory)?.profile ?? config.profileName;
	const profile = loadProfile(paths, profileName);
	const identity = profile ? digest(profile.npub) : "";
	const promptHash = digest(prompt);
	const matches = isActive(active) && active.workspaceRoot === workspaceRoot && active.profileName === profileName &&
		active.promptHash === promptHash && active.identity === identity;
	const canCapture = profile?.memoryMode === "assist" || profile?.memoryMode === "auto";
	if (event === "prepare") {
		const initialNumSteps = input.initialNumSteps as number;
		if (matches && active.initialNumSteps === initialNumSteps) return {};
		rmSync(file, { force: true });
		if (!canCapture) return {};
		const turnId = randomUUID();
		const result = await dispatchNativeHostEvent(config, "prepare", { workspaceRoot, profileName, sessionId, turnId, prompt });
		if (!("injectedPrompt" in result)) return {};
		const current: ActiveTurn = {
			sessionId, turnId, updatedAt: new Date().toISOString(), workspaceRoot, profileName, identity, promptHash,
			initialNumSteps, packId: result.packId ?? null,
		};
		writeManagedFile(file, JSON.stringify({ activeTurns: { current } }), paths.home);
		return result.contextText ? { injectSteps: [{ ephemeralMessage: result.contextText }] } : {};
	}
	if (!matches) return {};
	if (canCapture && input.terminationReason === "model_stop" && !input.error) {
		if (input.fullyIdle === false) return {};
		if (input.fullyIdle !== true) return {};
		let summary = readFinalResponse(config.hostHome, transcript, active.initialNumSteps);
		// The transcript can be flushed separately from the Stop notification.
		for (let retry = 0; !summary && retry < 4; retry += 1) {
			await delay(150);
			summary = readFinalResponse(config.hostHome, transcript, active.initialNumSteps);
		}
		if (summary && readTurn(file)?.turnId === active.turnId) {
			await dispatchNativeHostEvent(config, "complete", { ...active, prompt, summary });
		}
	}
	if (readTurn(file)?.turnId === active.turnId) rmSync(file, { force: true });
	return {};
};

const main = async (): Promise<void> => {
	try {
		const { positionals, flags } = parseArgs(process.argv.slice(2));
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

if (require.main === module) void main();
