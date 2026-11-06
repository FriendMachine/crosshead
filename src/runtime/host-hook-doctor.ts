import path from "path";

import { countLegacyClaudeHookCommands, findLegacyClaudeHookFiles, loadClaudeCodeAdapterConfig } from "./claude-code-adapter";
import { codexHooksFileHasLegacyHooks, codexLegacyHooksFile, loadCodexAdapterConfig } from "./codex-adapter";
import type { HookHost } from "./host-hook-spec";
import {
	detectClaudeCodePlugin,
	detectCodexPlugin,
	normalizeHookModeRequest,
	normalizeHostHookMode,
	readPluginInvocation,
	type HostHookMode,
	type PluginDetection,
	type PluginInvocationRecord,
} from "./host-plugin-mode";
import type { RuntimeDoctorCheck } from "./local-runtime";
import { loadAdapterRecord, resolveRuntimePaths } from "./runtime-persistence";

export type HostHookInspection = {
	host: HookHost;
	mode: HostHookMode;
	plugin: PluginDetection;
	/** Installer-written Crosshead hooks the host loads for the inspected workspace. */
	legacyHookFiles: string[];
	/** Last observed plugin hook run, or null if the host never ran one. */
	pluginInvocation?: PluginInvocationRecord | null;
	/** The last install asked for plugin hooks (`--hook-mode plugin`). */
	pluginRequested?: boolean;
};

const installCommand = (host: HookHost): string => `crosshead install ${host}`;

const CODEX_TRUST_HINT =
	"Codex runs plugin hooks only after you trust them: open /hooks in Codex, review and trust the Crosshead hooks (again after each plugin update), then start a session.";

const describePlugin = (plugin: PluginDetection): string => {
	const state = plugin.enabled
		? `plugin enabled${plugin.source ? ` in ${plugin.source}` : ""}${plugin.enabledAtUserScope ? "" : " (this project only)"}`
		: plugin.source
			? `plugin disabled in ${plugin.source}`
			: "plugin not enabled";
	return plugin.ignored ? `${state} (${plugin.ignored})` : state;
};

/** Doctor verdict for one host's hook registration. Exported for tests. */
export const evaluateHostHookInspection = (inspection: HostHookInspection): RuntimeDoctorCheck => {
	const { host, mode, plugin, legacyHookFiles } = inspection;
	const id = `${host === "codex" ? "codex" : "claude_code"}_hooks`;
	const legacyState = legacyHookFiles.length > 0 ? `legacy hooks in ${legacyHookFiles.join(", ")}` : "no legacy hooks";
	const summary = `mode=${mode}; ${describePlugin(plugin)}; ${legacyState}.`;
	const hasLegacy = legacyHookFiles.length > 0;
	// Codex: plugin hooks that never ran are most likely untrusted.
	const codexUnseen = host === "codex" && plugin.enabled && !inspection.pluginInvocation;
	const fail = (message: string): RuntimeDoctorCheck => ({ id, ok: false, message: `${summary} ${message}` });
	const ok = (message?: string): RuntimeDoctorCheck => ({ id, ok: true, message: message ? `${summary} ${message}` : summary });

	if (mode === "plugin") {
		if (!plugin.enabled) {
			return hasLegacy
				? fail(`The plugin is not enabled here, so only the installer hooks capture: enable the Crosshead plugin, or run ${installCommand(host)} --hook-mode settings.`)
				: fail(`No Crosshead hooks are active: enable the Crosshead plugin, or run ${installCommand(host)} --hook-mode settings.`);
		}
		if (hasLegacy && codexUnseen) {
			return fail(`Plugin mode is configured, but Codex has not run a Crosshead plugin hook yet, so the installer hooks are kept and capture meanwhile. ${CODEX_TRUST_HINT} Then run ${installCommand(host)} to remove the installer hooks.`);
		}
		if (hasLegacy) {
			return fail(`Duplicate registration (the plugin defers to the installer hooks while they exist): run ${installCommand(host)} to remove them.`);
		}
		if (codexUnseen) {
			return fail(`Plugin mode is configured, but no Crosshead plugin hook invocation has been seen, so nothing may be capturing. ${CODEX_TRUST_HINT}`);
		}
		return ok();
	}
	const requested = inspection.pluginRequested
		? ` Plugin hooks were requested; enable the plugin at user scope and run ${installCommand(host)} --hook-mode plugin to migrate.`
		: "";
	if (plugin.enabled && hasLegacy) {
		if (!plugin.enabledAtUserScope) {
			return ok(`The plugin is enabled only for this project, so the installer hooks stay in place for other projects; here the plugin defers to them and each event is captured once.${requested}`);
		}
		return fail(
			`Duplicate registration (the plugin defers to the installer hooks here): run ${installCommand(host)} --hook-mode plugin to migrate${host === "codex" && !inspection.pluginInvocation ? ` once Codex has run the plugin hooks. ${CODEX_TRUST_HINT}` : "."}`
		);
	}
	if (plugin.enabled && codexUnseen) {
		return fail(`No Crosshead plugin hook invocation has been seen and no installer hooks are present, so nothing may be capturing. ${CODEX_TRUST_HINT}`);
	}
	if (!plugin.enabled && !hasLegacy) {
		return fail(`No Crosshead hooks found for this workspace: install the Crosshead plugin or rerun ${installCommand(host)}.${requested}`);
	}
	return ok(requested ? requested.trim() : undefined);
};

/** Hook registration checks for each installed Claude Code / Codex adapter. */
export const inspectHostHookRegistrations = (home?: string, workspaceRoot: string = process.cwd()): RuntimeDoctorCheck[] => {
	const paths = resolveRuntimePaths(home);
	const workspace = path.resolve(workspaceRoot);
	const checks: RuntimeDoctorCheck[] = [];
	const claudeRecord = loadAdapterRecord(paths, "claude-code");
	if (claudeRecord) {
		try {
			const config = loadClaudeCodeAdapterConfig(paths.home, claudeRecord.hostHome ?? undefined);
			const mode = normalizeHostHookMode(config.hookMode);
			// Exactly the files Claude Code loads for a session in this workspace.
			const legacy = findLegacyClaudeHookFiles(config.hostHome, workspace, paths.home);
			// In plugin mode, also report what a migration left in the configured workspace.
			const configured = path.join(config.workspaceRoot, ".claude", "settings.json");
			if (mode === "plugin" && !legacy.includes(configured) && countLegacyClaudeHookCommands(configured, paths.home) > 0) legacy.push(configured);
			checks.push(
				evaluateHostHookInspection({
					host: "claude-code",
					mode,
					plugin: detectClaudeCodePlugin(config.hostHome, workspace),
					legacyHookFiles: legacy,
					pluginInvocation: readPluginInvocation(paths.home, "claude-code"),
					pluginRequested: normalizeHookModeRequest(config.hookModeRequest) === "plugin",
				})
			);
		} catch (error) {
			checks.push({ id: "claude_code_hooks", ok: false, message: error instanceof Error ? error.message : String(error) });
		}
	}
	const codexRecord = loadAdapterRecord(paths, "codex");
	if (codexRecord) {
		try {
			const config = loadCodexAdapterConfig(paths.home, codexRecord.hostHome ?? undefined);
			const hooksFile = codexLegacyHooksFile(config.hostHome);
			checks.push(
				evaluateHostHookInspection({
					host: "codex",
					mode: normalizeHostHookMode(config.hookMode),
					plugin: detectCodexPlugin(config.hostHome, workspace),
					legacyHookFiles: codexHooksFileHasLegacyHooks(hooksFile, paths.home) ? [hooksFile] : [],
					pluginInvocation: readPluginInvocation(paths.home, "codex"),
					pluginRequested: normalizeHookModeRequest(config.hookModeRequest) === "plugin",
				})
			);
		} catch (error) {
			checks.push({ id: "codex_hooks", ok: false, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return checks;
};
