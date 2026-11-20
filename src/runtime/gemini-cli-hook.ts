import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { assertManagedFilePath, parseArgs, writeManagedFile } from "./adapter-utils";
import { loadNativeHostConfig } from "./native-host-adapter";
import { dispatchNativeHostEvent } from "./native-host-hook";
import { loadProfile, resolveRuntimePaths } from "./runtime-persistence";
import { AUTO_UPDATE_TURN_MAX_MS } from "./runtime-idle-update";
import { workspaceProjectRoot } from "./workspace-identity";

type GeminiInput = {
	hook_event_name?: unknown;
	session_id?: unknown;
	cwd?: unknown;
	prompt?: unknown;
	prompt_response?: unknown;
};

type TurnState = {
	sessionId: string;
	turnId: string;
	updatedAt: string;
	workspaceRoot: string;
	promptHash: string;
	identity: string;
	packId: string | null;
};
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

const readTurn = (file: string): TurnState | undefined => {
	try {
		return (JSON.parse(readFileSync(file, "utf8")) as { activeTurns?: { current?: TurnState } }).activeTurns?.current;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
};

const handleGeminiHook = async (input: GeminiInput, home?: string) => {
	const { hook_event_name: event, session_id: sessionId, cwd, prompt, prompt_response: summary } = input;
	if ((event !== "BeforeAgent" && event !== "AfterAgent" && event !== "SessionEnd") ||
		typeof sessionId !== "string" || !sessionId || sessionId.length > 512 ||
		typeof cwd !== "string" || !path.isAbsolute(cwd)) return {};
	const config = loadNativeHostConfig("gemini", home);
	const paths = resolveRuntimePaths(config.runtimeHome);
	const file = path.join(paths.state, "gemini-turns", digest(sessionId) + ".json");
	assertManagedFilePath(file, paths.home);
	if (event === "SessionEnd") {
		rmSync(file, { force: true });
		return {};
	}
	if (typeof prompt !== "string") return {};
	const workspaceRoot = workspaceProjectRoot(cwd);
	const profile = loadProfile(paths, config.profileName);
	if (!profile) return {};
	const identity = digest(JSON.stringify([config.profileName, profile.npub]));
	const promptHash = digest(prompt);
	if (event === "BeforeAgent") {
		rmSync(file, { force: true });
		const turnId = randomUUID();
		const result = await dispatchNativeHostEvent(config, "prepare", { workspaceRoot, sessionId, turnId, prompt });
		if (!("injectedPrompt" in result)) return {};
		const current: TurnState = {
			sessionId, turnId, workspaceRoot, promptHash, identity,
			updatedAt: new Date().toISOString(), packId: result.packId ?? null,
		};
		writeManagedFile(file, JSON.stringify({ activeTurns: { current } }), paths.home);
		return result.contextText
			? { hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext: result.contextText } }
			: {};
	}
	const turn = readTurn(file);
	if (!turn || turn.workspaceRoot !== workspaceRoot || turn.promptHash !== promptHash || turn.identity !== identity ||
		Date.now() - Date.parse(turn.updatedAt) >= AUTO_UPDATE_TURN_MAX_MS || typeof summary !== "string") return {};
	await dispatchNativeHostEvent(config, "complete", { ...turn, prompt, summary });
	if (readTurn(file)?.turnId === turn.turnId) rmSync(file, { force: true });
	return {};
};

const main = async (): Promise<void> => {
	try {
		const { flags } = parseArgs(process.argv.slice(2));
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const value of process.stdin) {
			const chunk = Buffer.from(value);
			size += chunk.length;
			if (size > 262_144) throw new Error("Gemini CLI hook input too large.");
			chunks.push(chunk);
		}
		const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as GeminiInput;
		const result = await handleGeminiHook(input, typeof flags.home === "string" ? flags.home : undefined);
		process.stdout.write(JSON.stringify(result) + "\n");
	} catch {
		process.stderr.write("Crosshead could not complete a Gemini CLI hook. Run crosshead doctor to diagnose.\n");
		process.stdout.write("{}\n");
	}
};

if (require.main === module) void main();
