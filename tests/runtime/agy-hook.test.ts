import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { LocalRuntimeClient } from "../../src/runtime/local-client";
import { OnlyBotsLocalRuntimeDaemon } from "../../src/runtime/local-runtime";
import { installNativeHostAdapter, uninstallNativeHostAdapter } from "../../src/runtime/native-host-adapter";
import { hostTurnInProgress } from "../../src/runtime/runtime-idle-update";
import { resolveRuntimePaths } from "../../src/runtime/runtime-persistence";

const cli = path.resolve(__dirname, "../../dist/runtime/cli.js");
const exec = promisify(execFile);
const otherHooks = { lint: { Stop: [{ type: "command", command: "echo '{}'" }] } };

it("installs agy hooks and saves only the finished model response into the selected repository profile", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "crosshead-agy-"));
	const home = path.join(root, "runtime");
	const agyHome = path.join(root, "gemini settings");
	const project = path.join(root, "project");
	const subdir = path.join(project, "src");
	const separate = path.join(root, "other-project");
	const env = { ...process.env, CROSSHEAD_PROFILE: "", ONLYBOTS_PROFILE: "" };
	const cmdOptions = { cwd: project, env, timeout: 12_000 };
	const cliRun = (...args: string[]) => exec(process.execPath, [cli, ...args, "--home", home], cmdOptions);
	const hooksFile = path.join(agyHome, "config", "hooks.json");
	const hooks = () => JSON.parse(readFileSync(hooksFile, "utf8"));
	const daemon = new OnlyBotsLocalRuntimeDaemon(home);
	const paths = resolveRuntimePaths(home);
	const client = new LocalRuntimeClient({ home, timeoutMs: 3_000 });
	const busy = () => hostTurnInProgress(paths, Date.now());
	const prompt = "Find the ledger migration flag.";
	const answer = "Use sunrise-7b41 for the maintenance migration.";
	const transcriptFor = (id: string) => path.join(agyHome, "antigravity-cli", "brain", id, ".system_generated", "logs", "transcript.jsonl");
	const hook = (event: "PreInvocation" | "Stop", id: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
		new Promise((resolve, reject) => {
			const group = Object.keys(hooks()).find(name => name.startsWith("crosshead-agy-"))!;
			const child = execFile("sh", ["-c", hooks()[group][event][0].command], cmdOptions, (error, stdout, stderr) => {
				if (error || stderr.trim()) { reject(error ?? new Error(stderr)); return; }
				try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
			});
			child.stdin!.end(JSON.stringify({
				conversationId: id, workspacePaths: [project], transcriptPath: transcriptFor(id), lastUserInput: prompt,
				...(event === "PreInvocation" ? { invocationNum: 0, initialNumSteps: 4 } : { executionNum: 1, terminationReason: "model_stop", fullyIdle: true }),
				...extra,
			}));
		});
	const hot = async (profile: string) => JSON.stringify(await client.readHotMemory(profile, "all"));
	const session = "first-conversation";

	try {
		mkdirSync(subdir, { recursive: true });
		mkdirSync(separate);
		await exec("git", ["init", "--quiet", project]);
		mkdirSync(path.dirname(hooksFile), { recursive: true });
		writeFileSync(hooksFile, JSON.stringify(otherHooks));
		await cliRun("quickstart", "--adapter", "agy", "--profile", "studio", "--agy-home", agyHome, "--api-base", "http://127.0.0.1:0", "--no-start");
		await cliRun("quickstart", "--adapter", "none", "--profile", "repository", "--api-base", "http://127.0.0.1:0", "--no-start");
		writeFileSync(path.join(paths.config, "workspace-hooks.json"), JSON.stringify({
			version: 1, scope: "project", bindings: [], overrides: [{ root: project, profile: "repository" }],
		}));
		await cliRun("install", "agy", "--profile", "studio", "--agy-home", agyHome);
		expect(Object.keys(hooks())).toHaveLength(2);
		expect(hooks().lint).toEqual(otherHooks.lint);

		await daemon.start();
		const first = await hook("PreInvocation", session, { workspacePaths: [subdir] });
		expect(JSON.stringify(first.injectSteps)).toContain("profile=repository");
		expect(busy()).toBe(true);
		expect(await hook("PreInvocation", session)).toEqual({});
		expect(await hook("PreInvocation", session, { invocationNum: 1, initialNumSteps: 6 })).toEqual({});
		expect(await hook("Stop", session, { lastUserInput: "Different prompt" })).toEqual({});
		expect(await hook("Stop", session, { fullyIdle: false })).toEqual({});
		expect(busy()).toBe(true);

		const transcript = transcriptFor(session);
		mkdirSync(path.dirname(transcript), { recursive: true });
		writeFileSync(transcript, [
			{ step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "An earlier unrelated answer." },
			{ step_index: 3, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: prompt },
			{ step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "Intermediate tool call text.", tool_calls: [{}] },
			{ step_index: 5, source: "MODEL", type: "GENERIC", status: "DONE", content: "Raw tool output." },
			{ step_index: 6, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: answer, thinking: "Private model reasoning." },
		].map(row => JSON.stringify(row)).join("\n") + "\n");
		expect(await hook("Stop", session)).toEqual({});
		expect(await hook("Stop", session)).toEqual({});
		expect(busy()).toBe(false);
		await expect.poll(() => hot("repository"), { timeout: 6_000 }).toContain(answer);
		expect(await hot("repository")).not.toMatch(/earlier unrelated|Intermediate tool call|Raw tool output|Private model reasoning/);
		expect(await hot("studio")).not.toContain(answer);

		// A resumed turn can stop before the host flushes any new response.
		// The older response still in the log cannot satisfy that turn.
		await hook("PreInvocation", session, { initialNumSteps: 8 });
		await hook("Stop", session);
		expect(busy()).toBe(false);

		const recalled = await hook("PreInvocation", "fresh-conversation", { workspacePaths: [project], initialNumSteps: 1 });
		expect(JSON.stringify(recalled.injectSteps)).toContain(answer);
		await hook("Stop", "fresh-conversation", { terminationReason: "error", error: "Fixture error" });
		const elsewhere = await hook("PreInvocation", "other-conversation", { workspacePaths: [separate] });
		expect(JSON.stringify(elsewhere)).not.toContain(answer);
		await hook("Stop", "other-conversation", { workspacePaths: [separate], terminationReason: "error" });
		expect(await hook("PreInvocation", "mixed", { workspacePaths: [project, separate] })).toEqual({});
		expect(await hook("PreInvocation", "app", { transcriptPath: path.join(agyHome, "antigravity", "brain", "app", ".system_generated", "logs", "transcript.jsonl") })).toEqual({});
		await cliRun("memory", "mode", "manual", "--profile", "repository");
		expect(await hook("PreInvocation", "manual")).toEqual({});
		await cliRun("memory", "mode", "off", "--profile", "studio");
		expect(await hook("PreInvocation", "off", { workspacePaths: [separate] })).toEqual({});
		expect(busy()).toBe(false);
		await cliRun("uninstall", "agy");
		expect(hooks()).toEqual(otherHooks);
	} finally {
		await daemon.stop();
		rmSync(root, { recursive: true, force: true });
	}
}, 45_000);

it("preserves disabled hooks across reinstall and rejects another runtime's claim to the same configuration", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "crosshead-agy-settings-"));
	try {
		const home = path.join(root, "first");
		const hostHome = path.join(root, "gemini");
		const file = path.join(hostHome, "config", "hooks.json");
		await installNativeHostAdapter("agy", { home, hostHome });
		const original = JSON.parse(readFileSync(file, "utf8"));
		const group = Object.values(original)[0] as { enabled: boolean };
		group.enabled = false;
		writeFileSync(file, JSON.stringify(original));
		await installNativeHostAdapter("agy", { home, hostHome });
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original);
		await expect(installNativeHostAdapter("agy", { home: path.join(root, "second"), hostHome })).rejects.toThrow("another runtime");
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(original);
		await uninstallNativeHostAdapter("agy", home);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
