import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	countLegacyClaudeHookCommands,
	findLegacyClaudeHookFiles,
	installClaudeCodeAdapter,
	loadClaudeCodeAdapterConfig,
	uninstallClaudeCodeAdapter,
} from "../../src/runtime/claude-code-adapter";
import { runOnlyBotsClaudeCodeHookCli } from "../../src/runtime/claude-code-hook";
import { ensureQuickstartDaemon } from "../../src/runtime/cli/quickstart";
import { countLegacyCodexHookCommands, installCodexAdapter, loadCodexAdapterConfig, uninstallCodexAdapter } from "../../src/runtime/codex-adapter";
import { runOnlyBotsCodexHookCli } from "../../src/runtime/codex-hook";
import { readRuntimeDaemonHealth } from "../../src/runtime/daemon-ownership";
import { evaluateHostHookInspection, inspectHostHookRegistrations } from "../../src/runtime/host-hook-doctor";
import * as spec from "../../src/runtime/host-hook-spec";
import { startDetachedRuntimeDaemon, stopDetachedRuntimeDaemon } from "../../src/runtime/local-runtime";
import { ensureRuntimeHomeLayout, loadDaemonState } from "../../src/runtime/runtime-persistence";
import { evaluateAdapterAutomation } from "../../src/runtime/runtime-status";
import {
	claudeLoadedSettingsFiles,
	countMatchingHookCommands,
	decideHookDispatch,
	detectClaudeCodePlugin,
	detectCodexPlugin,
	readCodexPluginEnabled,
	readPluginInvocation,
	recordPluginInvocation,
} from "../../src/runtime/host-plugin-mode";
// @ts-expect-error -- plain ESM generator script without type declarations
import { renderHostPluginFiles } from "../../scripts/host-plugins.mjs";

const repoRoot = path.resolve(__dirname, "../..");
const dirs: string[] = [];
const savedEnv = { ...process.env };
// Host variables from the shell running the suite (for example inside a Claude Code
// session) must not leak into the fixtures.
const hostVariables = ["CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_HOME", "CODEX_HOME", "CROSSHEAD_HOST_CODEX_HOME"];
beforeEach(() => {
	for (const name of hostVariables) delete process.env[name];
	// Default host paths (~/.claude, ~/.codex, ~/.crosshead) resolve inside a scratch home,
	// never the real one.
	process.env.HOME = tempDir("home");
});
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
const writeJson = (filePath: string, value: unknown) => {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(value));
};
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
			"plugins/codex/skills/setup/agents/openai.yaml",
		]);
		for (const [relative, content] of Object.entries(files)) {
			expect(readFileSync(path.join(repoRoot, relative), "utf8"), `${relative} is stale; run npm run plugins:generate`).toBe(content);
		}
	});

	// Hosts pin an installed plugin to its manifest version (Codex also re-asks for
	// hook trust when a version changes). Changing generated plugin content without
	// raising CROSSHEAD_HOST_PLUGIN_VERSION would ship different files under an
	// already-installed version. Pin each version's content here; add a new entry,
	// never edit an old one. 1.0.0 is unreleased while PR #14 is open.
	const PLUGIN_CONTENT_SHA256: Record<string, string> = {
		"1.0.0": "1c6295e2195529599233fae8d5a46b5671ef18998beaf39652e7bc6d955dc4d4",
		"1.0.1": "1fcdad297292b4ac92cf109a9b29da8f26928710099f028e53c12ae9c45ab5e6",
		"1.1.0": "afca3f9cf117ed90071a265abd0fa6ebe4d0cb22d1b0e344d20ce70af16d3a9b",
	};
	it("generated plugin content is pinned to CROSSHEAD_HOST_PLUGIN_VERSION", () => {
		const files = renderHostPluginFiles(spec) as Record<string, string>;
		const hash = createHash("sha256");
		for (const relative of Object.keys(files).filter((name) => name.startsWith("plugins/")).sort()) hash.update(`${relative}\0${files[relative]}\0`);
		const digest = hash.digest("hex");
		expect(
			PLUGIN_CONTENT_SHA256[spec.CROSSHEAD_HOST_PLUGIN_VERSION],
			`plugin content changed (sha256 ${digest}): raise CROSSHEAD_HOST_PLUGIN_VERSION and pin the new digest`
		).toBe(digest);
	});

	it("plugin hooks cover exactly the events the legacy installer registers", () => {
		for (const host of ["claude-code", "codex"] as const) {
			const hooks = JSON.parse(spec.renderPluginHooksFile(host)).hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
			const events = spec.HOST_HOOK_EVENTS.filter((entry) => !entry.hosts || entry.hosts.includes(host));
			expect(Object.keys(hooks)).toEqual(events.map((entry) => entry.event));
			for (const entry of events) {
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
		// The setup skill is user-invoked only.
		expect(files["plugins/claude-code/skills/setup/SKILL.md"]).toMatch(/^---\n[^]*\ndisable-model-invocation: true\n---\n/);
		expect(files["plugins/codex/skills/setup/agents/openai.yaml"]).toBe("policy:\n  allow_implicit_invocation: false\n");
		// Notices are for the user: no model context, and no instruction aimed at the model.
		for (const host of ["claude-code", "codex"] as const) {
			for (const hint of [spec.pluginSetupHint(host), spec.pluginUpdateHint(host)]) {
				expect(hint).toMatch(/To (set it up|update it), (run \/crosshead:setup|type \$crosshead:setup)\.$/);
				expect(hint).not.toMatch(/ask (Codex|Claude)|use the .* skill/);
			}
		}
		expect(files["plugins/codex/scripts/crosshead-hook"]).not.toContain("additionalContext");
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
		// The layout is unchanged except that SessionStart also matches `clear` (both
		// hosts start a fresh context after /clear, like startup), changed deliberately.
		expect(readJson(path.join(f.workspace, ".claude", "settings.json"))).toEqual({
			hooks: {
				SessionStart: [{ matcher: "startup|resume|clear|compact|fork", hooks: [{ type: "command", command: command("SessionStart") }] }],
				PreCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: command("PreCompact") }] }],
				PostCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: command("PostCompact") }] }],
				UserPromptSubmit: [{ hooks: [{ type: "command", command: command("UserPromptSubmit") }] }],
				PostToolUse: [{ matcher: "Bash|Read|shell|exec_command|shell_command|read_file", hooks: [{ type: "command", command: command("PostToolUse") }] }],
				PostToolUseFailure: [{ matcher: "Bash|Read", hooks: [{ type: "command", command: command("PostToolUseFailure") }] }],
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
				SessionStart: [{ matcher: "startup|resume|clear|compact|fork", hooks: [{ type: "command", command: command("SessionStart"), statusMessage: "Crosshead session sync" }] }],
				PreCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: command("PreCompact"), statusMessage: "Crosshead pre-compact checkpoint", timeout: 30 }] }],
				PostCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: command("PostCompact"), statusMessage: "Crosshead post-compact sync", timeout: 30 }] }],
				UserPromptSubmit: [{ hooks: [{ type: "command", command: command("UserPromptSubmit"), statusMessage: "Crosshead context", timeout: 45 }] }],
				PostToolUse: [{ matcher: "Bash|Read|shell|exec_command|shell_command|read_file", hooks: [{ type: "command", command: command("PostToolUse"), statusMessage: "Crosshead checkpoint", timeout: 15 }] }],
				Stop: [{ hooks: [{ type: "command", command: command("Stop"), statusMessage: "Crosshead memory sync", timeout: 30 }] }],
			},
		});
	});
});


const install = (f: ReturnType<typeof fixture>, extra: Partial<Parameters<typeof installClaudeCodeAdapter>[0]> = {}) =>
	installClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome, workspaceRoot: f.workspace, claudeBinary: process.execPath, ...scripts, ...extra });
const installCodex = (f: ReturnType<typeof fixture>, extra: Partial<Parameters<typeof installCodexAdapter>[0]> = {}) =>
	installCodexAdapter({ home: f.home, hostHome: f.codexHome, codexBinary: process.execPath, workspaceRoot: f.workspace, ...scripts, ...extra });

describe("plugin mode install and migration", () => {
	it("Claude Code: detects the plugin at user scope, skips hook writing and removes legacy hooks idempotently", async () => {
		const f = fixture("claude-migrate");
		const settings = path.join(f.workspace, ".claude", "settings.json");
		await install(f);
		const legacy = readJson(settings);
		legacy.hooks.Stop.push({ hooks: [{ type: "command", command: "echo unrelated" }] });
		legacy.model = "keep-me";
		writeFileSync(settings, JSON.stringify(legacy));
		expect(loadClaudeCodeAdapterConfig(f.home, f.claudeHome).hookMode).toBe("settings");

		enableClaudePlugin(f.claudeHome);
		const first = await install(f);
		expect(first.config.hookMode).toBe("plugin");
		expect(first.pluginDetection?.source).toBe(path.join(f.claudeHome, "settings.json"));
		expect(first.migratedFiles).toEqual([settings]);
		const migrated = readJson(settings);
		expect(managedCommands(migrated.hooks, "crosshead-claude-code-hook")).toEqual([]);
		expect(migrated.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "echo unrelated" }] }]);
		expect(migrated.model).toBe("keep-me");
		expect(first.managedFiles).not.toContain(settings);

		const second = await install(f);
		expect(second.migratedFiles).toEqual([]);
		expect(readJson(settings)).toEqual(migrated);
	});

	it("Claude Code: never deletes a settings file; it is left as {} (also on uninstall)", async () => {
		const f = fixture("claude-keep-file");
		const settings = path.join(f.workspace, ".claude", "settings.json");
		await install(f);
		enableClaudePlugin(f.claudeHome);
		expect((await install(f)).migratedFiles).toEqual([settings]);
		expect(readJson(settings)).toEqual({});

		const forced = await install(f, { hookMode: "settings" });
		expect(forced.config.hookMode).toBe("settings");
		expect(managedCommands(readJson(settings).hooks, "crosshead-claude-code-hook")).toHaveLength(7);
		await uninstallClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome });
		expect(readJson(settings)).toEqual({});
	});

	it("Claude Code: project-scope enablement keeps settings mode and never removes the global hooks", async () => {
		const f = fixture("claude-project-scope");
		// The default install: workspace = the user's home, so the hooks land in the user settings file.
		const userHome = path.join(f.root, "user");
		const claudeHome = path.join(userHome, ".claude");
		const userSettings = path.join(claudeHome, "settings.json");
		mkdirSync(claudeHome, { recursive: true });
		await install(f, { hostHome: claudeHome, workspaceRoot: userHome });
		expect(countLegacyClaudeHookCommands(userSettings, f.home)).toBe(7);
		writeJson(path.join(f.workspace, ".claude", "settings.json"), { enabledPlugins: { "crosshead@crosshead": true } });

		for (const hookMode of [undefined, "plugin"] as const) {
			const result = await install(f, { hostHome: claudeHome, workspaceRoot: userHome, hookMode });
			expect(result.config.hookMode).toBe("settings");
			expect(result.migratedFiles).toEqual([]);
			expect(countLegacyClaudeHookCommands(userSettings, f.home)).toBe(7);
		}
		const explicit = await install(f, { hostHome: claudeHome, workspaceRoot: f.workspace, hookMode: "plugin" });
		expect(explicit.config.hookMode).toBe("settings");
		expect(explicit.hookModeNote).toContain("user scope");
		expect(existsSync(path.join(f.workspace, ".claude", "settings.json")) && countLegacyClaudeHookCommands(path.join(f.workspace, ".claude", "settings.json"), f.home)).toBe(0);
		// A later reinstall without the flag (for example `crosshead update`) repeats the request.
		expect(loadClaudeCodeAdapterConfig(f.home, claudeHome).hookModeRequest).toBe("plugin");

		const [check] = inspectHostHookRegistrations(f.home, f.workspace);
		expect(check).toMatchObject({ id: "claude_code_hooks", ok: true });
		expect(check!.message).toContain("this project only");
		expect(check!.message).toContain("each event is captured once");
	});

	it("Claude Code: refuses a symlinked settings file before writing anything", async () => {
		const f = fixture("claude-symlink");
		const other = path.join(f.root, "other");
		await install(f, { workspaceRoot: other });
		const otherSettings = path.join(other, ".claude", "settings.json");
		const real = path.join(f.root, "dotfiles-settings.json");
		writeFileSync(real, readFileSync(otherSettings));
		rmSync(otherSettings);
		symlinkSync(real, otherSettings);
		// Legacy hooks in the new workspace as well, so a partial migration would be visible.
		await install(f, { hookMode: "settings" });
		const configPath = path.join(f.claudeHome, "onlybots", "claude-code-adapter.json");
		const workspaceSettings = path.join(f.workspace, ".claude", "settings.json");
		// The previous workspace is recorded as `other` only in the config written by the first install.
		const config = readFileSync(configPath, "utf8");
		writeFileSync(configPath, config.replace(JSON.stringify(f.workspace), JSON.stringify(other)));
		const before = { config: readFileSync(configPath, "utf8"), workspace: readFileSync(workspaceSettings, "utf8"), real: readFileSync(real, "utf8") };
		enableClaudePlugin(f.claudeHome);
		await expect(install(f, { hookMode: "plugin" })).rejects.toThrow(/Refusing to migrate Crosshead hooks in .*other.*No files were changed/);
		expect(readFileSync(configPath, "utf8")).toBe(before.config);
		expect(readFileSync(workspaceSettings, "utf8")).toBe(before.workspace);
		expect(readFileSync(real, "utf8")).toBe(before.real);
	});

	it("Codex: keeps legacy hooks until a plugin invocation is seen, then migrates and keeps unknown keys", async () => {
		const f = fixture("codex-migrate");
		const hooksFile = path.join(f.codexHome, "hooks.json");
		await installCodex(f);
		const legacy = readJson(hooksFile);
		legacy.hooks.PreToolUse = [{ matcher: "Bash", hooks: [{ type: "command", command: "echo unrelated" }] }];
		legacy.$schema = "keep-me";
		writeFileSync(hooksFile, JSON.stringify(legacy));

		enableCodexPlugin(f.codexHome);
		const pending = await installCodex(f);
		expect(pending.config.hookMode).toBe("plugin");
		expect(pending.migratedFiles).toEqual([]);
		expect(pending.hookModeNote).toContain("/hooks");
		expect(countLegacyCodexHookCommands(hooksFile, f.home)).toBe(6);

		recordPluginInvocation(f.home, "codex", spec.CROSSHEAD_HOST_PLUGIN_VERSION, f.codexHome);
		const result = await installCodex(f);
		expect(result.migratedFiles).toEqual([hooksFile]);
		expect(readJson(hooksFile)).toEqual({ $schema: "keep-me", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo unrelated" }] }] } });
		expect(loadCodexAdapterConfig(f.home, f.codexHome).hookMode).toBe("plugin");
		expect((await installCodex(f)).migratedFiles).toEqual([]);
		await uninstallCodexAdapter({ home: f.home, hostHome: f.codexHome });
		expect(readJson(hooksFile).$schema).toBe("keep-me");
	});

	it("Codex: a disabled plugin, or one enabled only in project config, keeps settings mode", async () => {
		const f = fixture("codex-disabled");
		enableCodexPlugin(f.codexHome, false);
		const result = await installCodex(f);
		expect(result.config.hookMode).toBe("settings");
		expect(managedCommands(readJson(path.join(f.codexHome, "hooks.json")).hooks, "crosshead-codex-hook")).toHaveLength(6);

		writeFileSync(path.join(f.codexHome, "config.toml"), `[projects."${f.workspace}"]\ntrust_level = "trusted"\n`);
		mkdirSync(path.join(f.workspace, ".codex"));
		writeFileSync(path.join(f.workspace, ".codex", "config.toml"), '[plugins."crosshead@crosshead"]\nenabled = true\n');
		const project = await installCodex(f, { hookMode: "plugin" });
		expect(project.pluginDetection).toMatchObject({ enabled: true, scope: "project", enabledAtUserScope: false });
		expect(project.config.hookMode).toBe("settings");
		expect(project.migratedFiles).toEqual([]);
		expect(countLegacyCodexHookCommands(path.join(f.codexHome, "hooks.json"), f.home)).toBe(6);
	});

	it.each(["older-version", "different-home", "unbound-receipt"])("Codex: %s receipt cannot authorize global hook removal", async (kind) => {
		const f = fixture(`codex-receipt-${kind}`);
		await installCodex(f);
		enableCodexPlugin(f.codexHome);
		if (kind === "unbound-receipt") {
			writeJson(path.join(f.home, "state", "host-plugin-invocations.json"), { codex: { lastSeenAt: new Date().toISOString(), pluginVersion: spec.CROSSHEAD_HOST_PLUGIN_VERSION } });
		} else {
			recordPluginInvocation(f.home, "codex", kind === "older-version" ? "1.0.0" : spec.CROSSHEAD_HOST_PLUGIN_VERSION, kind === "different-home" ? path.join(f.root, "other-codex") : f.codexHome);
		}
		const pending = await installCodex(f);
		expect(pending.migratedFiles).toEqual([]);
		expect(countLegacyCodexHookCommands(path.join(f.codexHome, "hooks.json"), f.home)).toBe(6);
		expect(inspectHostHookRegistrations(f.home, f.workspace).find((check) => check.id === "codex_hooks")).toMatchObject({ ok: false });
		recordPluginInvocation(f.home, "codex", spec.CROSSHEAD_HOST_PLUGIN_VERSION, f.codexHome);
		expect((await installCodex(f)).migratedFiles).toEqual([path.join(f.codexHome, "hooks.json")]);
	});

	it("Codex: refuses a symlinked hooks.json before writing anything", async () => {
		const f = fixture("codex-symlink");
		const hooksFile = path.join(f.codexHome, "hooks.json");
		await installCodex(f);
		const real = path.join(f.root, "hooks-real.json");
		writeFileSync(real, readFileSync(hooksFile));
		rmSync(hooksFile);
		symlinkSync(real, hooksFile);
		const configPath = path.join(f.codexHome, "onlybots", "codex-adapter.json");
		const before = readFileSync(configPath, "utf8");
		enableCodexPlugin(f.codexHome);
		recordPluginInvocation(f.home, "codex", spec.CROSSHEAD_HOST_PLUGIN_VERSION, f.codexHome);
		await expect(installCodex(f)).rejects.toThrow("regular file");
		expect(readFileSync(configPath, "utf8")).toBe(before);
		expect(countLegacyCodexHookCommands(real, f.home)).toBe(6);
	});
});

describe("plugin detection", () => {
	it("reads Codex plugin tables without a TOML dependency", () => {
		expect(readCodexPluginEnabled('[plugins."crosshead@crosshead"]\nenabled = true\n')).toBe(true);
		expect(readCodexPluginEnabled("[plugins.'crosshead@crosshead']\nenabled = false # off\n")).toBe(false);
		expect(readCodexPluginEnabled('[plugins."crosshead@crosshead"]\nenabled = false#c\n')).toBe(false);
		expect(readCodexPluginEnabled('[plugins."crosshead@crosshead"] # comment\nenabled = true\n')).toBe(true);
		expect(readCodexPluginEnabled('[plugins."crosshead@crosshead"]\n')).toBe(true);
		expect(readCodexPluginEnabled('[plugins]\n"crosshead@crosshead" = { enabled = false }\n')).toBe(false);
		expect(readCodexPluginEnabled('plugins."crosshead@crosshead".enabled = false\n')).toBe(false);
		expect(readCodexPluginEnabled('notes = """\n[plugins."crosshead@crosshead"]\n"""\n')).toBeNull();
		expect(readCodexPluginEnabled('list = [\n  "a",\n]\n[plugins."crosshead@crosshead"]\nenabled = false\n')).toBe(false);
		expect(readCodexPluginEnabled('x = "#"\n[plugins."crosshead@crosshead"]\nenabled = false\n')).toBe(false);
		// Only this repository's marketplace counts.
		expect(readCodexPluginEnabled("[plugins.'crosshead@local']\nenabled = true\n")).toBeNull();
		expect(readCodexPluginEnabled('[plugins."other@x"]\nenabled = true\n[features]\nenabled = true\n')).toBeNull();
		expect(readCodexPluginEnabled('[plugins."crosshead-extra@crosshead"]\nenabled = true\n')).toBeNull();
	});

	it("Codex ignores a project config until the project is trusted", () => {
		const f = fixture("codex-trust");
		mkdirSync(path.join(f.workspace, ".codex"));
		writeFileSync(path.join(f.workspace, ".codex", "config.toml"), '[plugins."crosshead@crosshead"]\nenabled = true\n');
		const untrusted = detectCodexPlugin(f.codexHome, f.workspace);
		expect(untrusted).toMatchObject({ enabled: false, enabledAtUserScope: false });
		expect(untrusted.ignored).toContain("until Codex trusts");
		writeFileSync(path.join(f.codexHome, "config.toml"), `[projects."${f.workspace}"]\ntrust_level = "trusted"\n`);
		expect(detectCodexPlugin(f.codexHome, f.workspace)).toMatchObject({ enabled: true, scope: "project", enabledAtUserScope: false });
		enableCodexPlugin(f.codexHome);
		expect(detectCodexPlugin(f.codexHome, f.workspace)).toMatchObject({ enabled: true, scope: "user", enabledAtUserScope: true });
	});

	it("applies Claude Code settings precedence (local over project over user) and only this marketplace", () => {
		const f = fixture("detect");
		enableClaudePlugin(f.claudeHome, true);
		writeJson(path.join(f.workspace, ".claude", "settings.local.json"), { enabledPlugins: { "crosshead@crosshead": false } });
		expect(detectClaudeCodePlugin(f.claudeHome, f.workspace)).toEqual({
			enabled: false,
			source: path.join(f.workspace, ".claude", "settings.local.json"),
			scope: "local",
			enabledAtUserScope: true,
		});
		writeJson(path.join(f.claudeHome, "settings.json"), { enabledPlugins: { "crosshead@elsewhere": true } });
		rmSync(path.join(f.workspace, ".claude", "settings.local.json"));
		expect(detectClaudeCodePlugin(f.claudeHome, f.workspace)).toMatchObject({ enabled: false, source: null });
	});

	it("lists exactly the settings files Claude Code loads, with no ancestor lookup", () => {
		const f = fixture("loaded-files");
		const sub = path.join(f.workspace, "sub");
		mkdirSync(sub);
		// The session's project directory is a git repository root.
		mkdirSync(path.join(sub, ".git"));
		expect(claudeLoadedSettingsFiles(f.claudeHome, sub).map((entry) => entry.file)).toEqual([
			path.join(sub, ".claude", "settings.local.json"),
			path.join(sub, ".claude", "settings.json"),
			path.join(f.claudeHome, "settings.json"),
		]);
		// A session in a subdirectory of a repository: the local file also lives at the repository root,
		// but the shared project file is read only from the session's directory.
		rmSync(path.join(sub, ".git"), { recursive: true });
		mkdirSync(path.join(f.workspace, ".git"));
		expect(claudeLoadedSettingsFiles(f.claudeHome, sub).map((entry) => entry.file)).toEqual([
			path.join(f.workspace, ".claude", "settings.local.json"),
			path.join(sub, ".claude", "settings.local.json"),
			path.join(sub, ".claude", "settings.json"),
			path.join(f.claudeHome, "settings.json"),
		]);
	});

	it("counts Crosshead commands: empty arrays, empty groups and null groups never count or throw", () => {
		const f = fixture("counting");
		const isCrosshead = (command: string) => command.includes("crosshead-claude-code-hook");
		for (const shape of [
			{ hooks: { Stop: [] } },
			{ hooks: { Stop: [null, {}, { hooks: null }, { hooks: [] }, { hooks: [null, { command: 3 }] }], PreCompact: null, Bad: "x" } },
			{ hooks: [] },
			{ hooks: null },
			null,
			[],
		]) {
			expect(countMatchingHookCommands(shape, isCrosshead)).toBe(0);
		}
		expect(countMatchingHookCommands({ hooks: { Stop: [null, { hooks: [{ command: "/x/bin/crosshead-claude-code-hook Stop" }] }] } }, isCrosshead)).toBe(1);

		writeJson(path.join(f.workspace, ".claude", "settings.json"), { hooks: { Stop: [] } });
		expect(findLegacyClaudeHookFiles(f.claudeHome, f.workspace, f.home)).toEqual([]);
		writeJson(path.join(f.codexHome, "hooks.json"), { hooks: { Stop: [null, { hooks: null }] } });
		expect(countLegacyCodexHookCommands(path.join(f.codexHome, "hooks.json"), f.home)).toBe(0);
	});
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

// A hook that runs reaches the (absent) daemon and fails; a skipped one resolves.
const RAN = "daemon is unavailable";

describe("hook dispatch", () => {
	it("runs exactly one registration per event", () => {
		const present = () => true;
		const absent = () => false;
		// Installer hooks loaded: they run and the plugin defers, in either mode.
		expect(decideHookDispatch({ viaPlugin: false, mode: "settings", legacyHooksPresent: present })).toBe("run");
		expect(decideHookDispatch({ viaPlugin: true, mode: "settings", legacyHooksPresent: present })).toBe("skip-duplicate");
		expect(decideHookDispatch({ viaPlugin: false, mode: "plugin", legacyHooksPresent: present })).toBe("run");
		expect(decideHookDispatch({ viaPlugin: true, mode: "plugin", legacyHooksPresent: present })).toBe("skip-duplicate");
		// None loaded: the plugin runs; a stale installer invocation is skipped in plugin mode.
		expect(decideHookDispatch({ viaPlugin: true, mode: "settings", legacyHooksPresent: absent })).toBe("run");
		expect(decideHookDispatch({ viaPlugin: true, mode: "plugin", legacyHooksPresent: absent })).toBe("run");
		expect(decideHookDispatch({ viaPlugin: false, mode: "plugin", legacyHooksPresent: absent })).toBe("skip-duplicate");
		expect(decideHookDispatch({ viaPlugin: false, mode: "settings", legacyHooksPresent: absent })).toBe("run");
	});

	it("plugin invocations before setup print a user-only setup notice on SessionStart", async () => {
		const f = fixture("unconfigured");
		process.env.CROSSHEAD_HOOK_AUTOSTART = "0";
		process.env.CODEX_HOME = f.codexHome;
		const payload = JSON.stringify({ session_id: "s1", cwd: f.workspace });
		const claudeStart = await captureStdout(() => runOnlyBotsClaudeCodeHookCli(["SessionStart", "--home", f.home, "--claude-home", f.claudeHome, "--via", "plugin"], payload));
		expect(JSON.parse(claudeStart)).toEqual({ systemMessage: spec.pluginSetupHint("claude-code") });
		expect(await captureStdout(() => runOnlyBotsClaudeCodeHookCli(["Stop", "--home", f.home, "--claude-home", f.claudeHome, "--via", "plugin"], payload))).toBe("");
		const codexStart = await captureStdout(() => runOnlyBotsCodexHookCli(["SessionStart", "--home", f.home, "--via", "plugin"], payload));
		expect(JSON.parse(codexStart)).toEqual({ systemMessage: spec.pluginSetupHint("codex") });
		// Legacy invocations keep failing loudly when the adapter is missing.
		await expect(runOnlyBotsClaudeCodeHookCli(["Stop", "--home", f.home, "--claude-home", f.claudeHome], payload)).rejects.toThrow("not installed");
	});

	it("plugin invocations find a --claude-home install through the adapter record", async () => {
		const f = fixture("claude-home");
		process.env.CROSSHEAD_HOOK_AUTOSTART = "0";
		await install(f, { workspaceRoot: path.join(f.root, "elsewhere") });
		// No CLAUDE_CONFIG_DIR and no --claude-home: the plugin launcher passes neither.
		const payload = JSON.stringify({ session_id: "s1", cwd: f.workspace });
		await expect(runOnlyBotsClaudeCodeHookCli(["Stop", "--home", f.home, "--via", "plugin", "--plugin-version", spec.CROSSHEAD_HOST_PLUGIN_VERSION], payload)).rejects.toThrow(RAN);
	});

	it("Claude Code: checks the session's project directory, not its ancestors, plus the user settings", async () => {
		const f = fixture("claude-dirs");
		process.env.CROSSHEAD_HOOK_AUTOSTART = "0";
		process.env.CLAUDE_CONFIG_DIR = f.claudeHome;
		const sub = path.join(f.workspace, "sub");
		mkdirSync(sub);
		await install(f);
		const hook = (projectDir: string, cwd: string, ...extra: string[]) => {
			process.env.CLAUDE_PROJECT_DIR = projectDir;
			return runOnlyBotsClaudeCodeHookCli(["Stop", "--home", f.home, ...extra], JSON.stringify({ session_id: "s", cwd }));
		};
		// Session in the workspace: the legacy hooks load, so the plugin defers.
		await expect(hook(f.workspace, f.workspace, "--via", "plugin")).resolves.toBeUndefined();
		await expect(hook(f.workspace, f.workspace, "--claude-home", f.claudeHome)).rejects.toThrow(RAN);
		// After `cd sub` inside that session the project directory is unchanged.
		await expect(hook(f.workspace, sub, "--via", "plugin")).resolves.toBeUndefined();
		// A session started in a subdirectory does not load W/.claude/settings.json: the plugin captures.
		await expect(hook(sub, sub, "--via", "plugin")).rejects.toThrow(RAN);
	});

	it("Claude Code: legacy hooks in the user settings cover a workspace outside $HOME", async () => {
		const f = fixture("claude-outside-home");
		process.env.CROSSHEAD_HOOK_AUTOSTART = "0";
		// Default install layout: the workspace is the user's home, the hooks land in ~/.claude/settings.json.
		const userHome = path.join(f.root, "user");
		const claudeHome = path.join(userHome, ".claude");
		mkdirSync(claudeHome, { recursive: true });
		await install(f, { hostHome: claudeHome, workspaceRoot: userHome });
		process.env.CLAUDE_CONFIG_DIR = claudeHome;
		const outside = path.join(f.root, "srv", "project");
		mkdirSync(outside, { recursive: true });
		process.env.CLAUDE_PROJECT_DIR = outside;
		const payload = JSON.stringify({ session_id: "s", cwd: outside });
		await expect(runOnlyBotsClaudeCodeHookCli(["Stop", "--home", f.home, "--via", "plugin", "--plugin-version", spec.CROSSHEAD_HOST_PLUGIN_VERSION], payload)).resolves.toBeUndefined();
		await expect(runOnlyBotsClaudeCodeHookCli(["Stop", "--home", f.home, "--claude-home", claudeHome], payload)).rejects.toThrow(RAN);
		const [check] = inspectHostHookRegistrations(f.home, outside);
		expect(check!.message).toContain(path.join(claudeHome, "settings.json"));
	});

	it("empty hook arrays do not make the plugin defer", async () => {
		const f = fixture("claude-empty");
		process.env.CROSSHEAD_HOOK_AUTOSTART = "0";
		process.env.CLAUDE_CONFIG_DIR = f.claudeHome;
		enableClaudePlugin(f.claudeHome);
		await install(f, { hookMode: "plugin" });
		writeJson(path.join(f.workspace, ".claude", "settings.json"), { hooks: { Stop: [], SessionStart: [null, { hooks: [] }] } });
		process.env.CLAUDE_PROJECT_DIR = f.workspace;
		await expect(runOnlyBotsClaudeCodeHookCli(["Stop", "--home", f.home, "--via", "plugin"], JSON.stringify({ session_id: "s", cwd: f.workspace }))).rejects.toThrow(RAN);
		expect(inspectHostHookRegistrations(f.home, f.workspace)[0]).toMatchObject({ ok: true });

		process.env.CODEX_HOME = f.codexHome;
		await installCodex(f, { hookMode: "settings" });
		writeJson(path.join(f.codexHome, "hooks.json"), { hooks: { Stop: [null, { hooks: null }] } });
		await expect(runOnlyBotsCodexHookCli(["Stop", "--home", f.home, "--via", "plugin"], JSON.stringify({ session_id: "s", cwd: f.workspace }))).rejects.toThrow(RAN);
	});

	it.each(["claude-code", "codex"] as const)("%s: partial legacy registrations defer only matching events and sources", async (host) => {
		const f = fixture(`${host}-partial`);
		process.env.CROSSHEAD_HOOK_AUTOSTART = "0";
		process.env.CLAUDE_CONFIG_DIR = f.claudeHome;
		process.env.CLAUDE_PROJECT_DIR = f.workspace;
		process.env.CODEX_HOME = f.codexHome;
		if (host === "codex") await installCodex(f); else await install(f);
		const file = host === "codex" ? path.join(f.codexHome, "hooks.json") : path.join(f.workspace, ".claude", "settings.json");
		const legacy = readJson(file);
		legacy.hooks = { SessionStart: [{ ...legacy.hooks.SessionStart[0], matcher: "startup|resume" }] };
		writeJson(file, legacy);
		const hook = host === "codex" ? runOnlyBotsCodexHookCli : runOnlyBotsClaudeCodeHookCli;
		const invoke = (event: string, source?: string) => hook([event, "--home", f.home, "--via", "plugin", "--plugin-version", spec.CROSSHEAD_HOST_PLUGIN_VERSION], JSON.stringify({ session_id: "partial", cwd: f.workspace, source }));
		await expect(invoke("SessionStart", "startup")).resolves.toBeUndefined();
		await expect(invoke("SessionStart", "fork")).rejects.toThrow(RAN);
		await expect(invoke("UserPromptSubmit")).rejects.toThrow(RAN);
		await expect(invoke("Stop")).rejects.toThrow(RAN);
	});

	it("Claude Code: plugin mode defers to leftover installer hooks and skips stale ones", async () => {
		const f = fixture("claude-plugin-mode");
		process.env.CROSSHEAD_HOOK_AUTOSTART = "0";
		process.env.CLAUDE_CONFIG_DIR = f.claudeHome;
		process.env.CLAUDE_PROJECT_DIR = f.workspace;
		const payload = JSON.stringify({ session_id: "s1", cwd: f.workspace });
		const args = (...extra: string[]) => ["Stop", "--home", f.home, ...extra];
		enableClaudePlugin(f.claudeHome);
		await install(f, { hookMode: "plugin" });
		await expect(runOnlyBotsClaudeCodeHookCli(args("--claude-home", f.claudeHome), payload)).resolves.toBeUndefined();
		await expect(runOnlyBotsClaudeCodeHookCli(args("--via", "plugin", "--plugin-version", "9.9.9"), payload)).rejects.toThrow(RAN);
		expect(readPluginInvocation(f.home, "claude-code")?.pluginVersion).toBe("9.9.9");
		// Hooks an older install left in this project still load: they capture, the plugin defers.
		await install(f, { hookMode: "settings" });
		writeFileSync(
			path.join(f.claudeHome, "onlybots", "claude-code-adapter.json"),
			readFileSync(path.join(f.claudeHome, "onlybots", "claude-code-adapter.json"), "utf8").replace('"hookMode": "settings"', '"hookMode": "plugin"')
		);
		await expect(runOnlyBotsClaudeCodeHookCli(args("--via", "plugin"), payload)).resolves.toBeUndefined();
		await expect(runOnlyBotsClaudeCodeHookCli(args("--claude-home", f.claudeHome), payload)).rejects.toThrow(RAN);
	});

	it("Codex: until Codex has run the plugin hooks, the installer hooks capture and doctor explains /hooks trust", async () => {
		const f = fixture("codex-trust-window");
		process.env.CROSSHEAD_HOOK_AUTOSTART = "0";
		process.env.CODEX_HOME = f.codexHome;
		const payload = JSON.stringify({ session_id: "s1", cwd: f.workspace });
		await installCodex(f);
		enableCodexPlugin(f.codexHome);
		const pending = await installCodex(f, { hookMode: "plugin" });
		expect(pending.config.hookMode).toBe("plugin");
		expect(countLegacyCodexHookCommands(path.join(f.codexHome, "hooks.json"), f.home)).toBe(6);
		const window = inspectHostHookRegistrations(f.home, f.workspace).find((check) => check.id === "codex_hooks")!;
		expect(window.ok).toBe(false);
		expect(window.message).toContain("/hooks");
		expect(window.message).toContain("capture meanwhile");

		// Untrusted plugin hooks never fire; the installer hook still captures.
		await expect(runOnlyBotsCodexHookCli(["Stop", "--home", f.home, "--codex-home", f.codexHome], payload)).rejects.toThrow(RAN);
		// Once trusted, both fire: the plugin defers and records that it ran.
		await expect(runOnlyBotsCodexHookCli(["Stop", "--home", f.home, "--via", "plugin", "--plugin-version", spec.CROSSHEAD_HOST_PLUGIN_VERSION], payload)).resolves.toBeUndefined();
		expect(readPluginInvocation(f.home, "codex")).not.toBeNull();
		const migrated = await installCodex(f);
		expect(migrated.migratedFiles).toEqual([path.join(f.codexHome, "hooks.json")]);
		await expect(runOnlyBotsCodexHookCli(["Stop", "--home", f.home, "--via", "plugin", "--plugin-version", spec.CROSSHEAD_HOST_PLUGIN_VERSION], payload)).rejects.toThrow(RAN);
		// A Codex session that loaded hooks.json before the migration: its installer hook is skipped.
		await expect(runOnlyBotsCodexHookCli(["Stop", "--home", f.home, "--codex-home", f.codexHome], payload)).resolves.toBeUndefined();
		expect(inspectHostHookRegistrations(f.home, f.workspace).find((check) => check.id === "codex_hooks")).toMatchObject({ ok: true });
	});

	it("Codex: doctor warns when plugin mode is configured but no plugin hook has run", () => {
		const check = evaluateHostHookInspection({
			host: "codex",
			mode: "plugin",
			plugin: { enabled: true, source: "/c/config.toml", scope: "user", enabledAtUserScope: true },
			legacyHookFiles: [],
			pluginInvocation: null,
		});
		expect(check.ok).toBe(false);
		expect(check.message).toContain("no Crosshead plugin hook invocation has been seen");
		expect(check.message).toContain("/hooks");
		expect(
			evaluateHostHookInspection({
				host: "codex",
				hostHome: "/c",
				mode: "plugin",
				plugin: { enabled: true, source: "/c/config.toml", scope: "user", enabledAtUserScope: true },
				legacyHookFiles: [],
				pluginInvocation: { lastSeenAt: new Date().toISOString(), pluginVersion: spec.CROSSHEAD_HOST_PLUGIN_VERSION, hostHome: "/c" },
			}).ok
		).toBe(true);
	});
});

describe("plugin launcher", () => {
	const launcher = path.join(repoRoot, "plugins", "claude-code", spec.PLUGIN_HOOK_LAUNCHER);
	const run = (env: NodeJS.ProcessEnv, ...args: string[]) =>
		spawnSync("sh", [launcher, ...args], { input: '{"session_id":"s"}', encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
	const fakeWrapper = (home: string, name: string, body: string) => {
		mkdirSync(path.join(home, "bin"), { recursive: true });
		writeFileSync(path.join(home, "bin", name), body, { mode: 0o755 });
	};

	it("prints one user-only setup line on SessionStart and exits 0 without a runtime", () => {
		const f = fixture("launcher");
		for (const host of ["claude-code", "codex"] as const) {
			const start = run({ HOME: f.root }, host, "SessionStart");
			expect(start.status).toBe(0);
			expect(start.stdout.trim().split("\n")).toHaveLength(1);
			expect(JSON.parse(start.stdout)).toEqual({ systemMessage: spec.pluginSetupHint(host) });
			const stop = run({ HOME: f.root }, host, "Stop");
			expect(stop.status).toBe(0);
			expect(stop.stdout).toBe("");
		}
		expect(run({ HOME: f.root }, "unknown-host", "SessionStart").stdout).toBe("");
	});

	it("asks for an update when the runtime's hook wrapper predates plugin dispatch", () => {
		const f = fixture("launcher-old");
		const home = path.join(f.root, ".crosshead");
		fakeWrapper(home, "crosshead-claude-code-hook", "#!/bin/sh\necho ran\n");
		const start = run({ HOME: f.root }, "claude-code", "SessionStart");
		expect(JSON.parse(start.stdout).systemMessage).toBe(spec.pluginUpdateHint("claude-code"));
		expect(run({ HOME: f.root }, "claude-code", "Stop").stdout).toBe("");
	});

	it("runs the wrapper without reading host config itself, so --claude-home and --codex-home installs work", () => {
		const f = fixture("launcher-current");
		const home = path.join(f.root, ".crosshead");
		for (const name of ["crosshead-claude-code-hook", "crosshead-codex-hook"]) {
			fakeWrapper(home, name, `#!/bin/sh\n# ${spec.PLUGIN_DISPATCH_CAPABILITY}\necho "$@" "codex_home=$CROSSHEAD_HOST_CODEX_HOME"\n`);
		}
		// No adapter config at the default host paths.
		const claude = run({ HOME: f.root }, "claude-code", "Stop");
		expect(claude.stdout).toBe(`Stop --home ${home} --via plugin --plugin-version ${spec.CROSSHEAD_HOST_PLUGIN_VERSION} codex_home=\n`);
		const codex = run({ HOME: f.root, CODEX_HOME: "/elsewhere/codex" }, "codex", "Stop");
		expect(codex.stdout).toContain("codex_home=/elsewhere/codex");
		expect(run({ HOME: f.root }, "codex", "Stop").stdout).toContain(`codex_home=${f.root}/.codex`);
	});

	it("treats empty home variables as unset and keeps the runtime's two-homes check", () => {
		const f = fixture("launcher-homes");
		const home = path.join(f.root, ".crosshead");
		fakeWrapper(home, "crosshead-claude-code-hook", `#!/bin/sh\n# ${spec.PLUGIN_DISPATCH_CAPABILITY}\necho "$3"\n`);
		expect(run({ HOME: f.root, CROSSHEAD_HOME: "" }, "claude-code", "Stop").stdout).toBe(`${home}\n`);
		// The runtime agrees: an empty CROSSHEAD_HOME is unset, not the current directory.
		const resolved = spawnSync(process.execPath, ["-e", 'process.stdout.write(require(process.argv[1]).resolveCrossheadHome())', path.join(repoRoot, "dist/runtime/runtime-env.js")], {
			cwd: f.workspace,
			encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: f.root, CROSSHEAD_HOME: "", CROSSHEAD_RUNTIME_HOME: "", ONLYBOTS_HOME: "", ONLYBOTS_RUNTIME_HOME: "" },
		});
		expect(resolved.stdout).toBe(home);

		mkdirSync(path.join(f.root, ".onlybots"));
		const conflict = run({ HOME: f.root }, "claude-code", "SessionStart");
		expect(JSON.parse(conflict.stdout).systemMessage).toBe(spec.PLUGIN_HOME_CONFLICT_HINT);
		expect(run({ HOME: f.root }, "claude-code", "Stop").stdout).toBe("");
		// An explicit choice wins.
		expect(run({ HOME: f.root, CROSSHEAD_HOME: home }, "claude-code", "Stop").stdout).toBe(`${home}\n`);
	});

	it("is the same file in both plugins and passes sh -n", () => {
		const codexLauncher = path.join(repoRoot, "plugins", "codex", spec.PLUGIN_HOOK_LAUNCHER);
		expect(readFileSync(codexLauncher, "utf8")).toBe(readFileSync(launcher, "utf8"));
		execFileSync("sh", ["-n", launcher]);
	});
});

describe("doctor hook checks", () => {
	it("reports the active mode and flags duplicates or missing hooks", async () => {
		const ok = evaluateHostHookInspection({ host: "claude-code", mode: "plugin", plugin: { enabled: true, source: "/u/settings.json", scope: "user", enabledAtUserScope: true }, legacyHookFiles: [] });
		expect(ok).toMatchObject({ id: "claude_code_hooks", ok: true });
		expect(ok.message).toBe("mode=plugin; plugin enabled in /u/settings.json; no legacy hooks.");
		expect(evaluateHostHookInspection({ host: "codex", mode: "plugin", plugin: { enabled: false, source: null, scope: null, enabledAtUserScope: false }, legacyHookFiles: [] }).ok).toBe(false);
		const duplicate = evaluateHostHookInspection({
			host: "codex",
			mode: "settings",
			plugin: { enabled: true, source: null, scope: "user", enabledAtUserScope: true },
			legacyHookFiles: ["/c/hooks.json"],
			pluginInvocation: { lastSeenAt: new Date().toISOString(), pluginVersion: null, hostHome: null },
		});
		expect(duplicate.ok).toBe(false);
		expect(duplicate.message).toContain("--hook-mode plugin");

		const f = fixture("doctor");
		process.env.CLAUDE_CONFIG_DIR = f.claudeHome;
		await install(f);
		enableClaudePlugin(f.claudeHome);
		const [check] = inspectHostHookRegistrations(f.home, f.workspace);
		expect(check).toMatchObject({ id: "claude_code_hooks", ok: false });
		expect(check!.message).toContain("Duplicate registration");
		const pluginInstall = await install(f);
		expect(inspectHostHookRegistrations(f.home, f.workspace)[0]).toMatchObject({ ok: true });
		expect(evaluateAdapterAutomation(pluginInstall.adapter)).toMatchObject({ id: "adapter_claude_code_automation", ok: true });
		enableCodexPlugin(f.codexHome);
		const codexInstall = await installCodex(f, { hookMode: "plugin" });
		expect(codexInstall.config.hookMode).toBe("plugin");
		expect(evaluateAdapterAutomation(codexInstall.adapter)).toMatchObject({ id: "adapter_codex_automation", ok: true });
		await uninstallClaudeCodeAdapter({ home: f.home, hostHome: f.claudeHome });
		expect(inspectHostHookRegistrations(f.home, f.workspace).map((entry) => entry.id)).toEqual(["codex_hooks"]);
	});
});

describe("quickstart daemon", () => {
	it("restarts a daemon left on another release through the ownership-checked path, and reports --port", async () => {
		const f = fixture("stale-daemon");
		// A copy of the built runtime stands in for the release the daemon was started from.
		const oldRelease = path.join(f.root, "old-release");
		cpSync(path.join(repoRoot, "dist"), path.join(oldRelease, "dist"), { recursive: true });
		cpSync(path.join(repoRoot, "package.json"), path.join(oldRelease, "package.json"));
		symlinkSync(path.join(repoRoot, "node_modules"), path.join(oldRelease, "node_modules"));
		const oldDaemon = path.join(oldRelease, "dist", "runtime", "daemon.js");
		const installedDaemon = path.join(repoRoot, "dist", "runtime", "daemon.js");
		const paths = ensureRuntimeHomeLayout(f.home);
		try {
			const first = await startDetachedRuntimeDaemon({ home: f.home, daemonScriptPath: oldDaemon });
			expect((await readRuntimeDaemonHealth(first))?.daemonScriptPath).toBe(oldDaemon);

			const restarted = await ensureQuickstartDaemon({ home: f.home, daemonScriptPath: installedDaemon });
			expect(restarted).toMatchObject({ id: "daemon", ok: true });
			expect(restarted.detail).toMatch(/^Restarted onlybotsd on port \d+: it was running .*old-release/);
			const state = loadDaemonState(paths);
			expect(state.pid).not.toBe(first.pid);
			expect((await readRuntimeDaemonHealth(state))?.daemonScriptPath).toBe(installedDaemon);

			const reused = await ensureQuickstartDaemon({ home: f.home, daemonScriptPath: installedDaemon });
			expect(reused).toEqual({ id: "daemon", ok: true, detail: `onlybotsd already running on port ${state.port}` });
			const otherPort = await ensureQuickstartDaemon({ home: f.home, daemonScriptPath: installedDaemon, port: String(state.port! === 65535 ? 65534 : state.port! + 1) });
			expect(otherPort.ok).toBe(false);
			expect(otherPort.detail).toContain("was not applied");
			expect(loadDaemonState(paths).pid).toBe(state.pid);
		} finally {
			await stopDetachedRuntimeDaemon(f.home);
		}
	}, 60_000);
});
