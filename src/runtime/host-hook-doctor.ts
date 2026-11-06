import path from "path";

import { findLegacyClaudeHookFiles, loadClaudeCodeAdapterConfig } from "./claude-code-adapter";
import { codexHooksFileHasLegacyHooks, codexLegacyHooksFile, loadCodexAdapterConfig } from "./codex-adapter";
import type { HookHost } from "./host-hook-spec";
import { detectClaudeCodePlugin, detectCodexPlugin, normalizeHostHookMode, type HostHookMode, type PluginDetection } from "./host-plugin-mode";
import type { RuntimeDoctorCheck } from "./local-runtime";
import { loadAdapterRecord, resolveRuntimePaths } from "./runtime-persistence";

export type HostHookInspection = {
	host: HookHost;
	mode: HostHookMode;
	plugin: PluginDetection;
	legacyHookFiles: string[];
};

const installCommand = (host: HookHost): string => `crosshead install ${host}`;

/** Doctor verdict for one host's hook registration. Exported for tests. */
export const evaluateHostHookInspection = (inspection: HostHookInspection): RuntimeDoctorCheck => {
	const { host, mode, plugin, legacyHookFiles } = inspection;
	const id = `${host === "codex" ? "codex" : "claude_code"}_hooks`;
	const pluginState = plugin.enabled ? `plugin enabled${plugin.source ? ` in ${plugin.source}` : ""}` : "plugin not enabled";
	const legacyState = legacyHookFiles.length > 0 ? `legacy hooks in ${legacyHookFiles.join(", ")}` : "no legacy hooks";
	const summary = `mode=${mode}; ${pluginState}; ${legacyState}.`;
	if (mode === "plugin") {
		if (!plugin.enabled) {
			return { id, ok: false, message: `${summary} No Crosshead hooks are active: enable the Crosshead plugin, or run ${installCommand(host)} --hook-mode settings.` };
		}
		if (legacyHookFiles.length > 0) {
			return { id, ok: false, message: `${summary} Duplicate registration (the legacy entries are ignored at run time): run ${installCommand(host)} to remove them.` };
		}
		return { id, ok: true, message: summary };
	}
	if (plugin.enabled && legacyHookFiles.length > 0) {
		return { id, ok: false, message: `${summary} Duplicate registration (the plugin defers to the legacy hooks here): run ${installCommand(host)} --hook-mode plugin to migrate.` };
	}
	if (!plugin.enabled && legacyHookFiles.length === 0) {
		return { id, ok: false, message: `${summary} No Crosshead hooks found for this workspace: install the Crosshead plugin or rerun ${installCommand(host)}.` };
	}
	return { id, ok: true, message: summary };
};

/** Hook registration checks for each installed Claude Code / Codex adapter. */
export const inspectHostHookRegistrations = (home?: string, workspaceRoot: string = process.cwd()): RuntimeDoctorCheck[] => {
	const paths = resolveRuntimePaths(home);
	const checks: RuntimeDoctorCheck[] = [];
	const claudeRecord = loadAdapterRecord(paths, "claude-code");
	if (claudeRecord) {
		try {
			const config = loadClaudeCodeAdapterConfig(paths.home, claudeRecord.hostHome ?? undefined);
			const roots = [...new Set([path.resolve(workspaceRoot), config.workspaceRoot])];
			checks.push(
				evaluateHostHookInspection({
					host: "claude-code",
					mode: normalizeHostHookMode(config.hookMode),
					plugin: detectClaudeCodePlugin(config.hostHome, path.resolve(workspaceRoot)),
					legacyHookFiles: [...new Set(roots.flatMap((root) => findLegacyClaudeHookFiles(root, paths.home)))],
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
					plugin: detectCodexPlugin(config.hostHome, path.resolve(workspaceRoot)),
					legacyHookFiles: codexHooksFileHasLegacyHooks(hooksFile, paths.home) ? [hooksFile] : [],
				})
			);
		} catch (error) {
			checks.push({ id: "codex_hooks", ok: false, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return checks;
};
