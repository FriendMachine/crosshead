import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { LocalRuntimeClient } from "../../src/runtime/local-client";
import { OnlyBotsLocalRuntimeDaemon } from "../../src/runtime/local-runtime";
import { resolveRuntimePaths } from "../../src/runtime/runtime-persistence";
import { hostTurnInProgress } from "../../src/runtime/runtime-idle-update";

const cli = path.resolve(__dirname, "../../dist/runtime/cli.js");

it("installs Gemini CLI hooks that recall and capture a turn without replacing other hooks", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "crosshead-gemini-"));
	const home = path.join(root, "runtime");
	const project = path.join(root, "project");
	const subdir = path.join(project, "src");
	const otherProject = path.join(root, "other");
	const hostHome = path.join(root, "gemini settings");
	const dirEnv = { ...process.env, CROSSHEAD_PROFILE: "", ONLYBOTS_PROFILE: "" };
	const run = (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args, "--home", home], {
		cwd: project, env: dirEnv, encoding: "utf8", timeout: 10_000,
	});
	const existing = { tools: { allowed: ["read_file"] }, hooks: { AfterAgent: [{ hooks: [{ type: "command", name: "user-hook", command: "echo '{}'" }] }] } };
	const settingsPath = path.join(hostHome, "settings.json");
	const settings = () => JSON.parse(readFileSync(settingsPath, "utf8"));
	const daemon = new OnlyBotsLocalRuntimeDaemon(home);
	const prompt = "Find the migration flag.";
	const answer = "Use the blue ledger index for the maintenance migration.";
	const session = "gemini-session";
	const hook = (event: "BeforeAgent" | "AfterAgent" | "SessionEnd", extra: object = {}): Promise<string> => new Promise((resolve, reject) => {
		const spec = settings().hooks[event].flatMap((group: { hooks: { name: string; command: string }[] }) => group.hooks)
			.find((entry: { name: string }) => entry.name.startsWith("crosshead-gemini-"));
		const child = execFile("sh", ["-c", spec.command], { cwd: project, env: dirEnv, timeout: 15_000 }, (error, stdout, stderr) => {
			if (error) reject(error);
			else if (stderr.trim()) reject(new Error(stderr));
			else resolve(stdout.trim());
		});
		child.stdin!.end(JSON.stringify({
			hook_event_name: event, session_id: session, cwd: project, timestamp: new Date().toISOString(), prompt, ...extra,
		}));
	});

	try {
		mkdirSync(subdir, { recursive: true });
		mkdirSync(otherProject);
		await promisify(execFile)("git", ["init", "--quiet", project]);
		mkdirSync(hostHome);
		writeFileSync(settingsPath, JSON.stringify(existing));
		await run("quickstart", "--adapter", "gemini", "--profile", "studio", "--gemini-home", hostHome, "--api-base", "http://127.0.0.1:0", "--no-start");
		await run("install", "gemini", "--profile", "studio", "--gemini-home", hostHome);
		expect(settings().tools).toEqual(existing.tools);
		expect(settings().hooks.BeforeAgent).toHaveLength(1);
		expect(settings().hooks.AfterAgent).toHaveLength(2);
		expect(settings().hooks.AfterAgent[0]).toEqual(existing.hooks.AfterAgent[0]);

		await daemon.start();
		const paths = resolveRuntimePaths(home);
		expect(await hook("BeforeAgent")).not.toContain(answer);
		expect(hostTurnInProgress(paths, Date.now())).toBe(true);
		expect(await hook("AfterAgent", { prompt: "Different turn", prompt_response: "Avoid the wrong migration flag." })).toBe("{}");
		expect(await hook("AfterAgent", { prompt_response: answer })).toBe("{}");
		expect(await hook("AfterAgent", { prompt_response: "Do not store a duplicate completion." })).toBe("{}");
		expect(hostTurnInProgress(paths, Date.now())).toBe(false);

		const client = new LocalRuntimeClient({ home, timeoutMs: 2_000 });
		await expect.poll(async () => JSON.stringify(await client.readHotMemory("studio", "all")), { timeout: 5_000 }).toContain(answer);
		const resumed = JSON.parse(await hook("BeforeAgent", { session_id: "fresh-gemini-session", cwd: subdir }));
		expect(resumed.hookSpecificOutput.additionalContext).toContain(answer);
		expect(resumed.hookSpecificOutput.additionalContext).not.toMatch(/wrong migration flag|duplicate completion/);
		expect(await hook("SessionEnd", { session_id: "fresh-gemini-session" })).toBe("{}");
		expect(hostTurnInProgress(paths, Date.now())).toBe(false);

		expect(await hook("BeforeAgent", { session_id: "another-project", cwd: otherProject })).not.toContain(answer);
		await hook("SessionEnd", { session_id: "another-project", cwd: otherProject });

		await run("memory", "mode", "off", "--profile", "studio");
		expect(await hook("BeforeAgent")).toBe("{}");
		expect(hostTurnInProgress(paths, Date.now())).toBe(false);
		await run("memory", "mode", "assist", "--profile", "studio");
		expect(await hook("AfterAgent", { prompt_response: "Started with capture disabled." })).toBe("{}");
		expect(await hook("BeforeAgent")).not.toContain("Started with capture disabled.");

		await run("uninstall", "gemini");
		expect(settings()).toEqual(existing);
	} finally {
		await daemon.stop();
		rmSync(root, { recursive: true, force: true });
	}
}, 35_000);
