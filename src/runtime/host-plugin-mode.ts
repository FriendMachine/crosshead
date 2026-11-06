import { existsSync, readFileSync } from "fs";
import path from "path";

import { CROSSHEAD_PLUGIN_NAME, PLUGIN_HOOK_VIA_FLAG, type HookHost } from "./host-hook-spec";

// Hook registration modes for Claude Code and Codex:
// - "settings": the legacy installer writes hooks into .claude/settings.json or
//   $CODEX_HOME/hooks.json.
// - "plugin": the Crosshead host plugin supplies the hooks; the installer writes
//   only the adapter config and wrappers, and removes legacy hook entries.
// The selected mode is stored in the adapter config so the hook entrypoint can
// make sure exactly one registration handles each event.

export type HostHookMode = "settings" | "plugin";

export type PluginDetection = {
	enabled: boolean;
	/** Config file that decided the result, or null when no file mentions the plugin. */
	source: string | null;
};

const readJson = (filePath: string): Record<string, unknown> | null => {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
};

const isCrossheadPluginId = (id: string): boolean => id === CROSSHEAD_PLUGIN_NAME || id.startsWith(`${CROSSHEAD_PLUGIN_NAME}@`);

/** Claude Code settings precedence for `enabledPlugins`: local, then project, then user. */
export const claudePluginSettingsFiles = (hostHome: string, workspaceRoot: string): string[] => [
	path.join(workspaceRoot, ".claude", "settings.local.json"),
	path.join(workspaceRoot, ".claude", "settings.json"),
	path.join(hostHome, "settings.json"),
];

export const detectClaudeCodePlugin = (hostHome: string, workspaceRoot: string): PluginDetection => {
	for (const filePath of claudePluginSettingsFiles(hostHome, workspaceRoot)) {
		const enabledPlugins = readJson(filePath)?.enabledPlugins;
		if (!enabledPlugins || typeof enabledPlugins !== "object" || Array.isArray(enabledPlugins)) continue;
		const entries = Object.entries(enabledPlugins as Record<string, unknown>).filter(([id]) => isCrossheadPluginId(id));
		if (entries.length === 0) continue;
		return { enabled: entries.some(([, value]) => value === true), source: filePath };
	}
	return { enabled: false, source: null };
};

/**
 * Reads `[plugins."crosshead@<marketplace>"] enabled = true|false` from a Codex
 * config.toml without a TOML dependency. Only that table is interpreted.
 */
export const readCodexPluginEnabled = (content: string): boolean | null => {
	let inTable = false;
	let result: boolean | null = null;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.replace(/\s+#.*$/, "").trim();
		if (line.startsWith("[")) {
			const match = /^\[\s*plugins\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]$/.exec(line);
			const id = match ? match[1] ?? match[2] ?? match[3] ?? "" : "";
			inTable = id !== "" && isCrossheadPluginId(id);
			if (inTable && result === null) result = true; // Codex treats a listed plugin as enabled unless disabled.
			continue;
		}
		if (!inTable) continue;
		const enabled = /^enabled\s*=\s*(true|false)$/.exec(line);
		if (enabled) result = enabled[1] === "true";
	}
	return result;
};

export const codexPluginConfigFiles = (hostHome: string, workspaceRoot: string): string[] => [
	path.join(workspaceRoot, ".codex", "config.toml"),
	path.join(hostHome, "config.toml"),
];

export const detectCodexPlugin = (hostHome: string, workspaceRoot: string = process.cwd()): PluginDetection => {
	for (const filePath of codexPluginConfigFiles(hostHome, workspaceRoot)) {
		if (!existsSync(filePath)) continue;
		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const enabled = readCodexPluginEnabled(content);
		if (enabled !== null) return { enabled, source: filePath };
	}
	return { enabled: false, source: null };
};

export const detectHostPlugin = (host: HookHost, hostHome: string, workspaceRoot: string): PluginDetection =>
	host === "codex" ? detectCodexPlugin(hostHome, workspaceRoot) : detectClaudeCodePlugin(hostHome, workspaceRoot);

/** `--hook-mode plugin|settings|auto` (default auto: plugin when the host has it enabled). */
export const resolveHostHookMode = (
	requested: string | boolean | undefined,
	detect: () => PluginDetection
): { mode: HostHookMode; detection: PluginDetection | null } => {
	if (requested === undefined || requested === "auto") {
		const detection = detect();
		return { mode: detection.enabled ? "plugin" : "settings", detection };
	}
	if (requested === "plugin" || requested === "settings") return { mode: requested, detection: null };
	throw new Error("--hook-mode must be one of: auto, plugin, settings");
};

export const parseHookModeFlag = (value: string | boolean | undefined): HostHookMode | "auto" | undefined => {
	if (value === undefined) return undefined;
	if (value === "auto" || value === "plugin" || value === "settings") return value;
	throw new Error("--hook-mode must be one of: auto, plugin, settings");
};

export const describeHookMode = (mode: HostHookMode, detection: PluginDetection | null): string =>
	mode === "plugin"
		? `plugin (hooks come from the Crosshead plugin${detection?.source ? `; enabled in ${detection.source}` : ""})`
		: "settings (hooks written by this installer)";

export const normalizeHostHookMode = (value: unknown): HostHookMode => (value === "plugin" ? "plugin" : "settings");

/** Hook mode recorded in a Claude Code or Codex adapter config file (marker line, then JSON). */
export const readAdapterConfigHookMode = (configFile: string): HostHookMode => {
	try {
		const content = readFileSync(configFile, "utf8");
		const parsed = JSON.parse(content.slice(content.indexOf("{"))) as { hookMode?: unknown };
		return normalizeHostHookMode(parsed.hookMode);
	} catch {
		return "settings";
	}
};

export const isPluginHookInvocation = (flags: Record<string, string | boolean>): boolean =>
	flags[PLUGIN_HOOK_VIA_FLAG[0].slice(2)] === PLUGIN_HOOK_VIA_FLAG[1];

export type HookDispatchDecision = "run" | "skip-duplicate";

/**
 * Exactly one registration handles each event:
 * - plugin mode: the plugin runs; any leftover legacy entry is ignored.
 * - settings mode: legacy entries run; the plugin runs only where no legacy
 *   entry covers this workspace (for example a project the installer never saw).
 */
export const decideHookDispatch = (input: {
	viaPlugin: boolean;
	mode: HostHookMode;
	legacyHooksPresent: () => boolean;
}): HookDispatchDecision => {
	if (input.mode === "plugin") return input.viaPlugin ? "run" : "skip-duplicate";
	if (!input.viaPlugin) return "run";
	return input.legacyHooksPresent() ? "skip-duplicate" : "run";
};

/** Settings files Claude Code may load project hooks from for a session in `workspaceRoot`. */
export const claudeProjectSettingsCandidates = (workspaceRoot: string): string[] => {
	const candidates: string[] = [];
	let current = path.resolve(workspaceRoot);
	for (;;) {
		candidates.push(path.join(current, ".claude", "settings.json"));
		const parent = path.dirname(current);
		if (parent === current) return candidates;
		current = parent;
	}
};

/** One-line JSON both hosts accept on SessionStart: a user-visible notice plus model context. */
export const writePluginSetupNotice = (hookEventName: "SessionStart", message: string): void => {
	process.stdout.write(
		`${JSON.stringify({ systemMessage: message, hookSpecificOutput: { hookEventName, additionalContext: message } })}\n`
	);
};
