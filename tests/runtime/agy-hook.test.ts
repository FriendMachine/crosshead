import { execFile } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { LocalRuntimeClient } from "../../src/runtime/local-client";
import { installRuntimeCore, OnlyBotsLocalRuntimeDaemon, reapplyManagedRuntimeRelease, uninstallRuntimeCore } from "../../src/runtime/local-runtime";
import { installNativeHostAdapter } from "../../src/runtime/native-host-adapter";
import { hostHooksRunning, hostTurnInProgress } from "../../src/runtime/runtime-idle-update";
import { resolveRuntimePaths } from "../../src/runtime/runtime-persistence";

const repo = path.resolve(__dirname, "../..");
const cli = path.join(repo, "dist/runtime/cli.js");
const exec = promisify(execFile);
const otherHooks = { lint: { Stop: [{ type: "command", command: "echo '{}'" }] } };
const managedGroup = (hooks: Record<string, any>) => hooks[Object.keys(hooks).find(name => name.startsWith("crosshead-agy-"))!];
const userStep = (index: number, content: string) => ({ step_index: index, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content });
const fullUserStep = (index: number, content: string) => userStep(index,
	`<USER_REQUEST>\n${content}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-21T13:43:22-05:00.\n</ADDITIONAL_METADATA>`);
const modelStep = (index: number, content: string) => ({ step_index: index, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content });

it("recalls and saves Antigravity turns by transcript user row across repeated prompts and background work", async () => {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "crosshead-agy-")));
	const home = path.join(root, "runtime");
	const agyHome = path.join(root, "gemini settings");
	const realAgyHome = path.join(root, "gemini settings data");
	const project = path.join(root, "project");
	const subdir = path.join(project, "src");
	const separate = path.join(root, "other-project");
	const env = { PATH: process.env.PATH!, TMPDIR: os.tmpdir(), CROSSHEAD_HOOK_AUTOSTART: "0" };
	const cmdOptions = { cwd: project, env, timeout: 15_000 };
	const cliRun = (...args: string[]) => exec(process.execPath, [cli, ...args, "--home", home], cmdOptions);
	const hooksFile = path.join(agyHome, "config", "hooks.json");
	const hooks = () => JSON.parse(readFileSync(hooksFile, "utf8"));
	const daemon = new OnlyBotsLocalRuntimeDaemon(home);
	const paths = resolveRuntimePaths(home);
	const client = new LocalRuntimeClient({ home, timeoutMs: 3_000 });
	const busy = () => hostTurnInProgress(paths, Date.now());
	const prompt = "Find the ledger migration flag.";
	const answer = "Use sunrise-7b41 for the maintenance migration.";
	const nextPrompt = "Find the ledger rollback flag.";
	const nextAnswer = "Use marigold-1881 to roll the migration back.";
	const session = "first-conversation";
	const transcriptFor = (id: string) => path.join(realAgyHome, "antigravity-cli", "brain", id, ".system_generated", "logs",
		id === session ? "transcript_full.jsonl" : "transcript.jsonl");
	const addSteps = (id: string, ...steps: object[]) => {
		const file = transcriptFor(id);
		mkdirSync(path.dirname(file), { recursive: true });
		appendFileSync(file, steps.map(row => JSON.stringify(row)).join("\n") + "\n");
	};
	const hook = (event: "PreInvocation" | "Stop", id: string, extra: Record<string, unknown> = {}, warning?: RegExp): Promise<Record<string, unknown>> =>
		new Promise((resolve, reject) => {
			const child = execFile("sh", ["-c", managedGroup(hooks())[event][0].command], cmdOptions, (error, stdout, stderr) => {
				if (error) { reject(error); return; }
				try {
					if (warning) expect(stderr.trim()).toMatch(warning);
					else expect(stderr.trim()).toBe("");
					resolve(JSON.parse(stdout));
				} catch (parseError) { reject(parseError); }
			});
			child.stdin!.end(JSON.stringify({
				conversationId: id, workspacePaths: [project], transcriptPath: transcriptFor(id), lastUserInput: prompt,
				...(event === "PreInvocation" ? { invocationNum: 9, initialNumSteps: 400 } : { executionNum: 1, terminationReason: "model_stop", fullyIdle: true }),
				...extra,
			}));
		});
	const hot = async (profile: string) => JSON.stringify(await client.readHotMemory(profile, "all"));
	const events = async (type: string) => (await client.readActivity(100)).events.filter(event => event.runtime === "agy" && event.type === type);

	try {
		mkdirSync(subdir, { recursive: true });
		mkdirSync(separate);
		await exec("git", ["init", "--quiet", project]);
		mkdirSync(path.join(realAgyHome, "config"), { recursive: true });
		symlinkSync(realAgyHome, agyHome, "dir");
		writeFileSync(hooksFile, JSON.stringify(otherHooks));
		await cliRun("quickstart", "--adapter", "agy", "--profile", "studio", "--agy-home", agyHome, "--api-base", "http://127.0.0.1:0", "--no-start");
		await cliRun("quickstart", "--adapter", "none", "--profile", "repository", "--api-base", "http://127.0.0.1:0", "--no-start");
		writeFileSync(path.join(paths.config, "workspace-hooks.json"), JSON.stringify({
			version: 1, scope: "project", bindings: [], overrides: [{ root: project, profile: "repository" }],
		}));
		await cliRun("install", "agy", "--profile", "studio", "--agy-home", agyHome);
		expect(Object.keys(hooks())).toHaveLength(2);
		expect(hooks().lint).toEqual(otherHooks.lint);
		expect(managedGroup(hooks()).PreInvocation[0].command).toContain("bin/crosshead' host-hook agy prepare");
		expect(hostHooksRunning(1, () => "123456 node /release/dist/runtime/cli.js host-hook agy complete")).toBe(true);

		await daemon.start();
		await cliRun("memory", "mode", "off", "--profile", "studio");
		addSteps(session, userStep(1, "Earlier request."), modelStep(2, "An earlier unrelated answer."), fullUserStep(3, prompt));
		const submit = daemon.submitLifecycleEvent.bind(daemon);
		const verifiedArchive = "Reviewed warm and cold migration evidence.";
		const prepared = vi.spyOn(daemon, "submitLifecycleEvent").mockImplementationOnce(async event => {
			const response = await submit(event);
			expect(event.payload).toMatchObject({
				recallPolicy: "bounded", allowedScope: { includeWarmMemory: true, includeColdMemory: true },
			});
			return { ...response, contextPack: { ...response.contextPack, verifiedArchiveContext: verifiedArchive, contextText: "UNVERIFIED_AGY_TEXT" } };
		});
		const first = await hook("PreInvocation", session, { workspacePaths: [subdir] });
		prepared.mockRestore();
		expect(JSON.stringify(first.injectSteps)).toContain("profile=repository");
		expect(JSON.stringify(first.injectSteps)).toContain(verifiedArchive);
		expect(JSON.stringify(first.injectSteps)).not.toContain("UNVERIFIED_AGY_TEXT");
		expect(busy()).toBe(true);
		addSteps(session, { ...modelStep(4, "Intermediate tool call text."), tool_calls: [{}] },
			{ step_index: 5, source: "MODEL", type: "GENERIC", status: "DONE", content: "Raw tool output." });
		expect(await hook("PreInvocation", session, { invocationNum: 10, initialNumSteps: 535 })).toEqual({});
		expect(await events("turn.started")).toHaveLength(1);
		expect(await hook("Stop", session, { lastUserInput: "Different prompt" })).toEqual({});
		expect(busy()).toBe(true);
		addSteps(session, { ...modelStep(6, answer), thinking: "Private model reasoning." });
		// A model can finish its reply while a background command still runs.
		await hook("Stop", session, { fullyIdle: false, terminationReason: "NO_TOOL_CALL" });
		expect(busy()).toBe(false);
		await expect.poll(() => hot("repository"), { timeout: 6_000 }).toContain(answer);
		await hook("Stop", session);
		expect(await events("turn.completed")).toHaveLength(1);
		expect(await hot("repository")).not.toMatch(/earlier unrelated|Intermediate tool call|Raw tool output|Private model reasoning/);
		expect(await hot("studio")).not.toContain(answer);

		// The next user turn has a cumulative counter and its response flushes
		// after the old 600 ms deadline. A resolved user row must win over indexes.
		const secondInput = { lastUserInput: nextPrompt, invocationNum: 41, initialNumSteps: 900 };
		addSteps(session, fullUserStep(7, nextPrompt));
		const second = await hook("PreInvocation", session, secondInput);
		expect(JSON.stringify(second.injectSteps)).toContain(answer);
		addSteps(session, { ...modelStep(8, "Wait while I read the rollback table."), tool_calls: [{}] });
		await Promise.all([
			hook("Stop", session, { lastUserInput: nextPrompt }),
			delay(1_200).then(() => addSteps(session,
				{ step_index: 9, source: "MODEL", type: "GENERIC", status: "DONE", content: "Rollback table." },
				modelStep(10, nextAnswer))),
		]);
		const completed = await events("turn.completed");
		expect(completed).toHaveLength(2);
		expect(completed[1]?.payload.summary).toBe(nextAnswer);

		// A wake-up carrying the previous prompt must never replay its reply.
		expect(await hook("PreInvocation", session, secondInput)).toEqual({});
		await hook("Stop", session, { lastUserInput: nextPrompt });
		expect(await events("turn.completed")).toHaveLength(2);
		expect(busy()).toBe(false);

		// Repeating the exact prompt with a fresh USER_INPUT does start a turn.
		addSteps(session, fullUserStep(11, nextPrompt));
		const repeated = await hook("PreInvocation", session, secondInput);
		expect(JSON.stringify(repeated.injectSteps)).toContain(nextAnswer);
		// The full transcript can put more than a MiB between the user row
		// and final reply in a single large tool result.
		const largeTurnAnswer = "A newly confirmed rollback flag is iris-7241.";
		addSteps(session, { ...modelStep(12, "Read the large rollback log."), tool_calls: [{}] },
			{ step_index: 13, source: "MODEL", type: "GENERIC", status: "DONE", content: "Raw tool output café.\n".repeat(95_000) },
			modelStep(14, largeTurnAnswer));
		await hook("Stop", session, { lastUserInput: nextPrompt });
		const afterLargeTurn = await events("turn.completed");
		expect(afterLargeTurn).toHaveLength(3);
		expect(afterLargeTurn[2]?.payload.summary).toBe(largeTurnAnswer);

		const failed = "What is the rollback fallback?";
		addSteps(session, userStep(15, failed));
		await hook("PreInvocation", session, { lastUserInput: failed });
		addSteps(session, modelStep(16, "The fallback flag is daisy-4331."));
		const rejection = vi.spyOn(daemon, "submitLifecycleEvent").mockRejectedValueOnce(new Error("synthetic stop-time failure"));
		try {
			await hook("Stop", session, { lastUserInput: failed }, /could not complete an Antigravity CLI hook/);
		} finally { rejection.mockRestore(); }
		expect(busy()).toBe(false);
		expect(await events("turn.completed")).toHaveLength(3);

		const recalled = await hook("PreInvocation", "fresh-conversation");
		expect(JSON.stringify(recalled.injectSteps)).toContain(answer);
		await hook("Stop", "fresh-conversation", {}, /no checkpoint was saved/);
		expect(await events("turn.completed")).toHaveLength(3);
		expect(await hook("PreInvocation", "other-conversation", { workspacePaths: [separate] })).toEqual({});
		expect(await hook("PreInvocation", "mixed", { workspacePaths: [project, separate] })).toEqual({});
		expect(await hook("PreInvocation", "wrong-log", { transcriptPath: path.join(path.dirname(transcriptFor("wrong-log")), "other.jsonl") })).toEqual({});
		expect(await hook("PreInvocation", "app", { transcriptPath: path.join(agyHome, "antigravity", "brain", "app", ".system_generated", "logs", "transcript.jsonl") })).toEqual({});
		await cliRun("memory", "mode", "manual", "--profile", "repository");
		expect(await hook("PreInvocation", "manual")).toEqual({});
		expect(busy()).toBe(false);
		await cliRun("uninstall", "agy");
		expect(hooks()).toEqual(otherHooks);
	} finally {
		await daemon.stop();
		rmSync(root, { recursive: true, force: true });
	}
}, 45_000);

it("keeps the same Antigravity command through upgrades and removes only its group when uninstalling the runtime", async () => {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "crosshead-agy-settings-")));
	try {
		const home = path.join(root, "first");
		const hostHome = path.join(root, "gemini");
		const file = path.join(hostHome, "config", "hooks.json");
		const oldRelease = path.join(root, "old");
		const nextRelease = path.join(root, "next");
		const script = (root: string, name: string) => path.join(root, "dist", "runtime", name + ".js");
		const nextScript = (name: string) => script(nextRelease, name);
		await installRuntimeCore({ home, cliScriptPath: script(oldRelease, "cli"), daemonScriptPath: script(oldRelease, "daemon") });
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(otherHooks));
		await installNativeHostAdapter("agy", { home, hostHome });
		const original = JSON.parse(readFileSync(file, "utf8"));
		const group = managedGroup(original);
		group.enabled = false;
		writeFileSync(file, JSON.stringify(original));
		await expect(installNativeHostAdapter("agy", { home: path.join(root, "second"), hostHome })).rejects.toThrow("another runtime");
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original);

		const paths = resolveRuntimePaths(home);
		const release = {
			baseUrl: "http://127.0.0.1:0", releaseId: "fixture", releaseUrl: "", releaseSha256: "",
			releaseRoot: nextRelease, cliScriptPath: nextScript("cli"), daemonScriptPath: nextScript("daemon"),
			localRuntimeModulePath: nextScript("local-runtime"), codexAdapterModulePath: nextScript("codex-adapter"),
			claudeCodeAdapterModulePath: nextScript("claude-code-adapter"), piAdapterModulePath: nextScript("pi-adapter"),
		};
		const adapters = [{ name: "agy" as const, profileName: "default", hostHome, hostBinary: "agy" }];
		await expect(reapplyManagedRuntimeRelease(paths, release, adapters)).rejects.toThrow("does not support installed Antigravity CLI hooks");
		mkdirSync(nextRelease);
		cpSync(path.join(repo, "dist"), path.join(nextRelease, "dist"), { recursive: true });
		symlinkSync(path.join(repo, "node_modules"), path.join(nextRelease, "node_modules"), "dir");
		await reapplyManagedRuntimeRelease(paths, release, adapters);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original);
		expect(readFileSync(path.join(paths.bin, "crosshead"), "utf8")).toContain(nextScript("cli"));
		const invoked = await exec("sh", ["-c", "printf '{}' | " + group.PreInvocation[0].command], { timeout: 10_000 });
		expect(JSON.parse(invoked.stdout)).toEqual({});
		expect(invoked.stderr).toBe("");

		await uninstallRuntimeCore(home);
		expect(existsSync(home)).toBe(false);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(otherHooks);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
