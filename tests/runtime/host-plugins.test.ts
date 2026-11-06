import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installClaudeCodeAdapter, loadClaudeCodeAdapterConfig, uninstallClaudeCodeAdapter } from "../../src/runtime/claude-code-adapter";
import { runOnlyBotsClaudeCodeHookCli } from "../../src/runtime/claude-code-hook";
import { installCodexAdapter, loadCodexAdapterConfig } from "../../src/runtime/codex-adapter";
import { runOnlyBotsCodexHookCli } from "../../src/runtime/codex-hook";
import { evaluateHostHookInspection, inspectHostHookRegistrations } from "../../src/runtime/host-hook-doctor";
import * as spec from "../../src/runtime/host-hook-spec";
import { decideHookDispatch, detectClaudeCodePlugin, readCodexPluginEnabled } from "../../src/runtime/host-plugin-mode";
// @ts-expect-error -- plain ESM generator script without type declarations
import { renderHostPluginFiles } from "../../scripts/host-plugins.mjs";

const repoRoot = path.resolve(__dirname, "../..");
const dirs: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
	dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
	process.env = { ...savedEnv };
});

const tempDir = (label: string): string => {
	const dir = mkdtempSync(path.join(os.tmpdir(), `crosshead-plugins-${label}-`));
	dirs.push(dir);
	return dir;
};

const fixture = (label: string) => {
	const root = tempDir(label);
	const home = path.join(root, "runtime");
	const claudeHome = path.join(root, "claude");
	const codexHome = path.join(root, "codex");
	const workspace = path.join(root, "project");
	for (const dir of [claudeHome, codexHome, workspace]) mkdirSync(dir, { recursive: true });
	return { root, home, claudeHome, codexHome, workspace };
};

const scripts = { bridgeScriptPath: path.join(repoRoot, "dist/runtime/claude-code-bridge.js"), hookScriptPath: path.join(repoRoot, "dist/runtime/claude-code-hook.js") };
const readJson = (filePath: string) => JSON.parse(readFileSync(filePath, "utf8"));
const enableClaudePlugin = (claudeHome: string, enabled = true) =>
	writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify({ enabledPlugins: { "crosshead@crosshead": enabled } }));
const enableCodexPlugin = (codexHome: string, enabled = true) =>
	writeFileSync(path.join(codexHome, "config.toml"), `model = "x"\n\n[plugins."crosshead@crosshead"]\nenabled = ${enabled}\n`);
const managedCommands = (hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> | undefined, marker: string) =>
	Object.values(hooks ?? {}).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command))).filter((command) => command.includes(marker));

describe("host plugin files", () => {
	it("checked-in plugin and marketplace files match the shared hook spec", () => {
		const files = renderHostPluginFiles(spec) as Record<string, string>;
		expect(Object.keys(files).sort()).toEqual([
			".agents/plugins/marketplace.json",
			".claude-plugin/marketplace.json",
			"plugins/claude-code/.claude-plugin/plugin.json",
			"plugins/claude-code/hooks/hooks.json",
			"plugins/claude-code/scripts/crosshead-hook",
			"plugins/claude-code/skills/setup/SKILL.md",
			"plugins/codex/.codex-plugin/plugin.json",
			"plugins/codex/hooks/hooks.json",
			"plugins/codex/scripts/crosshead-hook",
			"plugins/codex/skills/setup/SKILL.md",
		]);
		for (const [relative, content] of Object.entries(files)) {
			expect(readFileSync(path.join(repoRoot, relative), "utf8"), `${relative} is stale; run npm run plugins:generate`).toBe(content);
		}
	});

	it("plugin hooks cover exactly the events the legacy installer registers", () => {
		for (const host of ["claude-code", "codex"] as const) {
			const hooks = JSON.parse(spec.renderPluginHooksFile(host)).hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
			expect(Object.keys(hooks)).toEqual(spec.HOST_HOOK_EVENTS.map((entry) => entry.event));
			for (const entry of spec.HOST_HOOK_EVENTS) {
				expect(hooks[entry.event]).toHaveLength(1);
				expect(hooks[entry.event]![0]!.matcher).toBe(entry.matcher);
				expect(hooks[entry.event]![0]!.hooks[0]!.command).toBe(spec.pluginHookCommand(host, entry.event));
			}
		}
	});

	it("skills never download code other than the digest-pinned installer", () => {
		const files = renderHostPluginFiles(spec) as Record<string, string>;
		for (const host of ["claude-code", "codex"]) {
			const skill = files[`plugins/${host}/skills/setup/SKILL.md`]!;
			expect(skill.match(/https?:\/\/[^\s)`]+/g)?.filter((url) => !url.startsWith("https://crosshead.sh"))).toEqual([]);
			expect(skill).toContain(`--adapter ${host} --workspace-root . --hook-mode plugin`);
			expect(skill).toContain("ask for explicit consent");
		}
		const launcherCode = files["plugins/codex/scripts/crosshead-hook"]!.split("\n").filter((line) => !line.trimStart().startsWith("#"));
		expect(launcherCode.join("\n")).not.toMatch(/curl|wget|npm |npx |node /);
	});
});

describe("legacy hook rendering", () => {
	it("keeps the settings-mode hook layout unchanged", async () => {
		const f = fixture("legacy-claude");
		await installClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome, workspaceRoot: f.workspace, claudeBinary: process.execPath, hookMode: "settings", ...scripts });
		const hookWrapper = path.join(f.home, "bin", "crosshead-claude-code-hook");
		const command = (event: string) => `'${hookWrapper}' '${event}' --home '${f.home}' --claude-home '${f.claudeHome}'`;
		expect(readJson(path.join(f.workspace, ".claude", "settings.json"))).toEqual({
			hooks: {
				SessionStart: [{ matcher: "startup|resume|compact", hooks: [{ type: "command", command: command("SessionStart") }] }],
				PreCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: command("PreCompact") }] }],
				PostCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: command("PostCompact") }] }],
				UserPromptSubmit: [{ hooks: [{ type: "command", command: command("UserPromptSubmit") }] }],
				Stop: [{ hooks: [{ type: "command", command: command("Stop") }] }],
			},
		});
	});

	it("keeps the Codex settings-mode hook layout unchanged", async () => {
		const f = fixture("legacy-codex");
		await installCodexAdapter({ home: f.home, hostHome: f.codexHome, codexBinary: process.execPath, hookMode: "settings", ...scripts });
		const hookWrapper = path.join(f.home, "bin", "crosshead-codex-hook");
		const command = (event: string) => `'${hookWrapper}' '${event}' --home '${f.home}' --codex-home '${f.codexHome}'`;
		expect(readJson(path.join(f.codexHome, "hooks.json"))).toEqual({
			hooks: {
				SessionStart: [{ matcher: "startup|resume|compact", hooks: [{ type: "command", command: command("SessionStart"), statusMessage: "Crosshead session sync" }] }],
				PreCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: command("PreCompact"), statusMessage: "Crosshead pre-compact checkpoint", timeout: 30 }] }],
				PostCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: command("PostCompact"), statusMessage: "Crosshead post-compact sync", timeout: 30 }] }],
				UserPromptSubmit: [{ hooks: [{ type: "command", command: command("UserPromptSubmit"), statusMessage: "Crosshead context", timeout: 45 }] }],
				Stop: [{ hooks: [{ type: "command", command: command("Stop"), statusMessage: "Crosshead memory sync", timeout: 30 }] }],
			},
		});
	});
});

describe("plugin mode install and migration", () => {
	it("Claude Code: detects the enabled plugin, skips hook writing and removes legacy hooks idempotently", async () => {
		const f = fixture("claude-migrate");
		const settings = path.join(f.workspace, ".claude", "settings.json");
		await installClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome, workspaceRoot: f.workspace, claudeBinary: process.execPath, ...scripts });
		const legacy = readJson(settings);
		legacy.hooks.Stop.push({ hooks: [{ type: "command", command: "echo unrelated" }] });
		legacy.model = "keep-me";
		writeFileSync(settings, JSON.stringify(legacy));
		expect(loadClaudeCodeAdapterConfig(f.home, f.claudeHome).hookMode).toBe("settings");

		enableClaudePlugin(f.claudeHome);
		const first = await installClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome, workspaceRoot: f.workspace, claudeBinary: process.execPath, ...scripts });
		expect(first.config.hookMode).toBe("plugin");
		expect(first.pluginDetection?.source).toBe(path.join(f.claudeHome, "settings.json"));
		expect(first.migratedFiles).toEqual([settings]);
		const migrated = readJson(settings);
		expect(managedCommands(migrated.hooks, "crosshead-claude-code-hook")).toEqual([]);
		expect(migrated.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "echo unrelated" }] }]);
		expect(migrated.model).toBe("keep-me");
		expect(first.managedFiles).not.toContain(settings);

		const second = await installClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome, workspaceRoot: f.workspace, claudeBinary: process.execPath, ...scripts });
		expect(second.migratedFiles).toEqual([]);
		expect(readJson(settings)).toEqual(migrated);
	});

	it("Claude Code: removes a settings file that only held Crosshead hooks; explicit --hook-mode wins over detection", async () => {
		const f = fixture("claude-explicit");
		const settings = path.join(f.workspace, ".claude", "settings.json");
		await installClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome, workspaceRoot: f.workspace, claudeBinary: process.execPath, ...scripts });
		const result = await installClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome, workspaceRoot: f.workspace, claudeBinary: process.execPath, hookMode: "plugin", ...scripts });
		expect(result.pluginDetection).toBeNull();
		expect(result.migratedFiles).toEqual([settings]);
		expect(existsSync(settings)).toBe(false);

		enableClaudePlugin(f.claudeHome);
		const forced = await installClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome, workspaceRoot: f.workspace, claudeBinary: process.execPath, hookMode: "settings", ...scripts });
		expect(forced.config.hookMode).toBe("settings");
		expect(managedCommands(readJson(settings).hooks, "crosshead-claude-code-hook")).toHaveLength(5);
	});

	it("Codex: detects the enabled plugin in config.toml and migrates hooks.json", async () => {
		const f = fixture("codex-migrate");
		const hooksFile = path.join(f.codexHome, "hooks.json");
		await installCodexAdapter({ home: f.home, hostHome: f.codexHome, codexBinary: process.execPath, ...scripts });
		const legacy = readJson(hooksFile);
		legacy.hooks.PreToolUse = [{ matcher: "Bash", hooks: [{ type: "command", command: "echo unrelated" }] }];
		writeFileSync(hooksFile, JSON.stringify(legacy));

		enableCodexPlugin(f.codexHome);
		const result = await installCodexAdapter({ home: f.home, hostHome: f.codexHome, codexBinary: process.execPath, ...scripts });
		expect(result.config.hookMode).toBe("plugin");
		expect(result.migratedFiles).toEqual([hooksFile]);
		expect(readJson(hooksFile)).toEqual({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo unrelated" }] }] } });
		expect(loadCodexAdapterConfig(f.home, f.codexHome).hookMode).toBe("plugin");

		const again = await installCodexAdapter({ home: f.home, hostHome: f.codexHome, codexBinary: process.execPath, ...scripts });
		expect(again.migratedFiles).toEqual([]);
	});

	it("Codex: a disabled plugin keeps settings mode", async () => {
		const f = fixture("codex-disabled");
		enableCodexPlugin(f.codexHome, false);
		const result = await installCodexAdapter({ home: f.home, hostHome: f.codexHome, codexBinary: process.execPath, ...scripts });
		expect(result.config.hookMode).toBe("settings");
		expect(managedCommands(readJson(path.join(f.codexHome, "hooks.json")).hooks, "crosshead-codex-hook")).toHaveLength(5);
	});
});

describe("plugin detection", () => {
	it("reads Codex plugin tables without a TOML dependency", () => {
		expect(readCodexPluginEnabled('[plugins."crosshead@crosshead"]\nenabled = true\n')).toBe(true);
		expect(readCodexPluginEnabled("[plugins.'crosshead@local']\nenabled = false # off\n")).toBe(false);
		expect(readCodexPluginEnabled('[plugins."crosshead@crosshead"]\n')).toBe(true);
		expect(readCodexPluginEnabled('[plugins."other@x"]\nenabled = true\n[features]\nenabled = true\n')).toBeNull();
		expect(readCodexPluginEnabled('[plugins."crosshead-extra@x"]\nenabled = true\n')).toBeNull();
	});

	it("applies Claude Code settings precedence (local over project over user)", () => {
		const f = fixture("detect");
		enableClaudePlugin(f.claudeHome, true);
		mkdirSync(path.join(f.workspace, ".claude"), { recursive: true });
		writeFileSync(path.join(f.workspace, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "crosshead@crosshead": false } }));
		expect(detectClaudeCodePlugin(f.claudeHome, f.workspace)).toEqual({ enabled: false, source: path.join(f.workspace, ".claude", "settings.local.json") });
	});
});

describe("hook dispatch", () => {
	it("runs exactly one registration per event", () => {
		const present = () => true;
		const absent = () => false;
		expect(decideHookDispatch({ viaPlugin: true, mode: "plugin", legacyHooksPresent: present })).toBe("run");
		expect(decideHookDispatch({ viaPlugin: false, mode: "plugin", legacyHooksPresent: present })).toBe("skip-duplicate");
		expect(decideHookDispatch({ viaPlugin: false, mode: "settings", legacyHooksPresent: present })).toBe("run");
		expect(decideHookDispatch({ viaPlugin: true, mode: "settings", legacyHooksPresent: present })).toBe("skip-duplicate");
		expect(decideHookDispatch({ viaPlugin: true, mode: "settings", legacyHooksPresent: absent })).toBe("run");
	});

	const captureStdout = async (run: () => Promise<void>): Promise<string> => {
		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			chunks.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			await run();
		} finally {
			process.stdout.write = original;
		}
		return chunks.join("");
	};

	it("plugin invocations before setup print the setup notice on SessionStart only", async () => {
		const f = fixture("unconfigured");
		process.env.CROSSHEAD_HOOK_AUTOSTART = "0";
		process.env.CODEX_HOME = f.codexHome;
		const payload = JSON.stringify({ session_id: "s1", cwd: f.workspace });
		const claudeStart = await captureStdout(() => runOnlyBotsClaudeCodeHookCli(["SessionStart", "--home", f.home, "--claude-home", f.claudeHome, "--via", "plugin"], payload));
		expect(JSON.parse(claudeStart)).toEqual({
			systemMessage: spec.pluginSetupHint("claude-code"),
			hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: spec.pluginSetupHint("claude-code") },
		});
		expect(await captureStdout(() => runOnlyBotsClaudeCodeHookCli(["Stop", "--home", f.home, "--claude-home", f.claudeHome, "--via", "plugin"], payload))).toBe("");
		const codexStart = await captureStdout(() => runOnlyBotsCodexHookCli(["SessionStart", "--home", f.home, "--via", "plugin"], payload));
		expect(JSON.parse(codexStart).systemMessage).toBe(spec.pluginSetupHint("codex"));
		// Legacy invocations keep failing loudly when the adapter is missing.
		await expect(runOnlyBotsClaudeCodeHookCli(["Stop", "--home", f.home, "--claude-home", f.claudeHome], payload)).rejects.toThrow("not installed");
	});

	it("skips the duplicate registration before touching the daemon", async () => {
		const f = fixture("dedupe");
		process.env.CROSSHEAD_HOOK_AUTOSTART = "0";
		const payload = JSON.stringify({ session_id: "s1", cwd: f.workspace });
		const claudeArgs = (...extra: string[]) => ["Stop", "--home", f.home, "--claude-home", f.claudeHome, ...extra];
		await installClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome, workspaceRoot: f.workspace, claudeBinary: process.execPath, ...scripts });
		// Settings mode with legacy hooks in this workspace: the plugin defers, legacy runs (and reaches the daemon).
		await expect(runOnlyBotsClaudeCodeHookCli(claudeArgs("--via", "plugin"), payload)).resolves.toBeUndefined();
		await expect(runOnlyBotsClaudeCodeHookCli(claudeArgs(), payload)).rejects.toThrow("daemon is unavailable");
		// Settings mode in a workspace the installer never saw: the plugin handles it.
		const other = path.join(f.root, "other");
		mkdirSync(other);
		await expect(runOnlyBotsClaudeCodeHookCli(claudeArgs("--via", "plugin"), JSON.stringify({ session_id: "s2", cwd: other }))).rejects.toThrow("daemon is unavailable");
		// Plugin mode: legacy invocations are ignored, plugin invocations run.
		await installClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome, workspaceRoot: f.workspace, claudeBinary: process.execPath, hookMode: "plugin", ...scripts });
		await expect(runOnlyBotsClaudeCodeHookCli(claudeArgs(), payload)).resolves.toBeUndefined();
		await expect(runOnlyBotsClaudeCodeHookCli(claudeArgs("--via", "plugin"), payload)).rejects.toThrow("daemon is unavailable");

		process.env.CODEX_HOME = f.codexHome;
		await installCodexAdapter({ home: f.home, hostHome: f.codexHome, codexBinary: process.execPath, ...scripts });
		await expect(runOnlyBotsCodexHookCli(["Stop", "--home", f.home, "--via", "plugin"], payload)).resolves.toBeUndefined();
		await installCodexAdapter({ home: f.home, hostHome: f.codexHome, codexBinary: process.execPath, hookMode: "plugin", ...scripts });
		await expect(runOnlyBotsCodexHookCli(["Stop", "--home", f.home, "--codex-home", f.codexHome], payload)).resolves.toBeUndefined();
	});
});

describe("plugin launcher", () => {
	const launcher = path.join(repoRoot, "plugins", "claude-code", spec.PLUGIN_HOOK_LAUNCHER);
	const run = (env: NodeJS.ProcessEnv, ...args: string[]) =>
		spawnSync("sh", [launcher, ...args], { input: '{"session_id":"s"}', encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

	it("prints one setup line on SessionStart and exits 0 without a runtime", () => {
		const f = fixture("launcher");
		for (const host of ["claude-code", "codex"] as const) {
			const start = run({ HOME: f.root }, host, "SessionStart");
			expect(start.status).toBe(0);
			expect(start.stdout.trim().split("\n")).toHaveLength(1);
			expect(JSON.parse(start.stdout).systemMessage).toBe(spec.pluginSetupHint(host));
			const stop = run({ HOME: f.root }, host, "Stop");
			expect(stop.status).toBe(0);
			expect(stop.stdout).toBe("");
		}
		expect(run({ HOME: f.root }, "unknown-host", "SessionStart").stdout).toBe("");
	});

	it("asks for an update when the runtime predates plugin support", () => {
		const f = fixture("launcher-old");
		mkdirSync(path.join(f.root, ".crosshead", "bin"), { recursive: true });
		writeFileSync(path.join(f.root, ".crosshead", "bin", "crosshead-claude-code-hook"), "#!/bin/sh\necho ran\n", { mode: 0o755 });
		mkdirSync(path.join(f.claudeHome, "onlybots"), { recursive: true });
		writeFileSync(path.join(f.claudeHome, "onlybots", "claude-code-adapter.json"), '{"marker":"x"}');
		const start = run({ HOME: f.root, CLAUDE_CONFIG_DIR: f.claudeHome }, "claude-code", "SessionStart");
		expect(JSON.parse(start.stdout).systemMessage).toBe(spec.pluginUpdateHint("claude-code"));
		expect(run({ HOME: f.root, CLAUDE_CONFIG_DIR: f.claudeHome }, "claude-code", "Stop").stdout).toBe("");

		writeFileSync(path.join(f.claudeHome, "onlybots", "claude-code-adapter.json"), '{"marker":"x","hookMode":"plugin"}');
		const current = run({ HOME: f.root, CLAUDE_CONFIG_DIR: f.claudeHome }, "claude-code", "Stop");
		expect(current.stdout).toBe("ran\n");
	});

	it("is the same file in both plugins and passes sh -n", () => {
		const codexLauncher = path.join(repoRoot, "plugins", "codex", spec.PLUGIN_HOOK_LAUNCHER);
		expect(readFileSync(codexLauncher, "utf8")).toBe(readFileSync(launcher, "utf8"));
		execFileSync("sh", ["-n", launcher]);
	});
});

describe("doctor hook checks", () => {
	it("reports the active mode and flags duplicates or missing hooks", async () => {
		const ok = evaluateHostHookInspection({ host: "claude-code", mode: "plugin", plugin: { enabled: true, source: "/u/settings.json" }, legacyHookFiles: [] });
		expect(ok).toMatchObject({ id: "claude_code_hooks", ok: true });
		expect(ok.message).toContain("mode=plugin");
		expect(evaluateHostHookInspection({ host: "codex", mode: "plugin", plugin: { enabled: false, source: null }, legacyHookFiles: [] }).ok).toBe(false);
		const duplicate = evaluateHostHookInspection({ host: "codex", mode: "settings", plugin: { enabled: true, source: null }, legacyHookFiles: ["/c/hooks.json"] });
		expect(duplicate.ok).toBe(false);
		expect(duplicate.message).toContain("--hook-mode plugin");

		const f = fixture("doctor");
		await installClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome, workspaceRoot: f.workspace, claudeBinary: process.execPath, ...scripts });
		enableClaudePlugin(f.claudeHome);
		const [check] = inspectHostHookRegistrations(f.home, f.workspace);
		expect(check).toMatchObject({ id: "claude_code_hooks", ok: false });
		expect(check!.message).toContain("Duplicate registration");
		await installClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome, workspaceRoot: f.workspace, claudeBinary: process.execPath, ...scripts });
		expect(inspectHostHookRegistrations(f.home, f.workspace)[0]).toMatchObject({ ok: true });
		await uninstallClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome });
		expect(inspectHostHookRegistrations(f.home, f.workspace)).toEqual([]);
	});
});
