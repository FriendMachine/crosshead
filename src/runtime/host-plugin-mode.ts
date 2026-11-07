import { existsSync, readFileSync } from "fs";
import os from "os";
import path from "path";

import { CROSSHEAD_HOST_PLUGIN_VERSION, CROSSHEAD_MARKETPLACE_NAME, CROSSHEAD_PLUGIN_NAME, PLUGIN_HOOK_VIA_FLAG, type HookHost } from "./host-hook-spec";
import { ensureRuntimeHomeLayout, loadAdapterRecord, parseJsonFile, resolveRuntimePaths, writeJsonFile } from "./runtime-persistence";

// Hook registration modes for Claude Code and Codex:
// - "settings": the legacy installer writes hooks into .claude/settings.json or
//   $CODEX_HOME/hooks.json.
// - "plugin": the Crosshead host plugin supplies the hooks; the installer writes
//   only the adapter config and wrappers, and removes legacy hook entries.
// Plugin mode is recorded only when the plugin is enabled at user scope, because
// the mode and the legacy hooks it removes apply to every project. The hook
// entrypoint makes sure exactly one registration handles each event.

export type HostHookMode = "settings" | "plugin";

export type PluginScope = "user" | "project" | "local";

export type PluginDetection = {
	/** Effective state for the inspected workspace. */
	enabled: boolean;
	/** Config file that decided the effective state, or null when no loaded file mentions the plugin. */
	source: string | null;
	scope: PluginScope | null;
	/** True when the user-scope config enables the plugin, so it applies in every project. */
	enabledAtUserScope: boolean;
	/** Why a project-level setting was not applied (Codex ignores untrusted project config). */
	ignored?: string;
};

/** The only plugin id this runtime recognizes: this repository's marketplace. */
export const CROSSHEAD_PLUGIN_ID = `${CROSSHEAD_PLUGIN_NAME}@${CROSSHEAD_MARKETPLACE_NAME}`;

const readJson = (filePath: string): Record<string, unknown> | null => {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
};

const nonEmpty = (value: string | undefined): string | undefined => (value && value.length > 0 ? value : undefined);

/** Nearest ancestor (including `start`) that contains a `.git` entry. */
const findGitRoot = (start: string): string | null => {
	let current = path.resolve(start);
	for (;;) {
		if (existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
};

// ---- Claude Code ------------------------------------------------------------

/** The user settings directory Claude Code itself loads: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const claudeUserConfigDir = (env: NodeJS.ProcessEnv = process.env): string =>
	path.resolve(nonEmpty(env.CLAUDE_CONFIG_DIR) ?? path.join(os.homedir(), ".claude"));

/** The project directory of a Claude Code session: `CLAUDE_PROJECT_DIR` when set, else the payload cwd. */
export const claudeSessionProjectDir = (fallback: string, env: NodeJS.ProcessEnv = process.env): string =>
	path.resolve(nonEmpty(env.CLAUDE_PROJECT_DIR) ?? fallback);

export type ClaudeSettingsSource = { scope: PluginScope; file: string };

/**
 * The settings files Claude Code loads for a session whose project directory is
 * `projectDir`, highest precedence first (managed settings excluded):
 * - `.claude/settings.local.json` at the git repository root (Claude Code 2.1.211+;
 *   not when the root is the home directory), and in the project directory;
 * - `.claude/settings.json` in the project directory only (no ancestor lookup);
 * - `settings.json` in the user settings directory.
 * See https://code.claude.com/docs/en/settings.md.
 */
export const claudeLoadedSettingsFiles = (userConfigDir: string, projectDir: string): ClaudeSettingsSource[] => {
	const project = path.resolve(projectDir);
	const gitRoot = findGitRoot(project);
	const localDirs = gitRoot && gitRoot !== path.resolve(os.homedir()) ? [gitRoot, project] : [project];
	const userFile = path.join(path.resolve(userConfigDir), "settings.json");
	const sources: ClaudeSettingsSource[] = [
		...localDirs.map((dir) => ({ scope: "local" as const, file: path.join(dir, ".claude", "settings.local.json") })),
		{ scope: "project", file: path.join(project, ".claude", "settings.json") },
	];
	// In the home directory the project file is the user file; report it once, as user settings.
	const seen = new Set<string>([userFile]);
	return [...sources.filter((source) => (seen.has(source.file) ? false : (seen.add(source.file), true))), { scope: "user", file: userFile }];
};

const claudeEnabledPluginValue = (filePath: string): boolean | null => {
	const enabledPlugins = readJson(filePath)?.enabledPlugins;
	if (!enabledPlugins || typeof enabledPlugins !== "object" || Array.isArray(enabledPlugins)) return null;
	const value = (enabledPlugins as Record<string, unknown>)[CROSSHEAD_PLUGIN_ID];
	return typeof value === "boolean" ? value : null;
};

export const detectClaudeCodePlugin = (userConfigDir: string, projectDir: string): PluginDetection => {
	const sources = claudeLoadedSettingsFiles(userConfigDir, projectDir);
	const userSource = sources.find((source) => source.scope === "user")!;
	const enabledAtUserScope = claudeEnabledPluginValue(userSource.file) === true;
	for (const source of sources) {
		const value = claudeEnabledPluginValue(source.file);
		if (value === null) continue;
		return { enabled: value, source: source.file, scope: source.scope, enabledAtUserScope };
	}
	return { enabled: false, source: null, scope: null, enabledAtUserScope };
};

// ---- Codex: a small TOML reader for the keys Crosshead needs ---------------

/** Removes a `#` comment that is outside a string. */
const stripTomlComment = (line: string): string => {
	let quote: '"' | "'" | null = null;
	for (let index = 0; index < line.length; index++) {
		const char = line[index]!;
		if (quote === '"' && char === "\\") {
			index++;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === "#") return line.slice(0, index);
	}
	return line;
};

/** Splits a dotted TOML key (`a."b.c".d`) into its parts, or null if it is malformed. */
const parseTomlKey = (raw: string): string[] | null => {
	const parts: string[] = [];
	let rest = raw.trim();
	while (rest.length > 0) {
		let part: string;
		const quoted = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(rest);
		if (quoted) {
			part = quoted[1] !== undefined ? quoted[1].replace(/\\(.)/g, "$1") : quoted[2]!;
			rest = rest.slice(quoted[0].length).trimStart();
		} else {
			const bare = /^[A-Za-z0-9_-]+/.exec(rest);
			if (!bare) return null;
			part = bare[0];
			rest = rest.slice(part.length).trimStart();
		}
		parts.push(part);
		if (rest.length === 0) break;
		if (!rest.startsWith(".")) return null;
		rest = rest.slice(1).trimStart();
	}
	return parts.length > 0 ? parts : null;
};

type TomlScalar = boolean | string;
type TomlEntries = { tables: string[][]; values: Array<{ key: string[]; value: TomlScalar }> };

const parseTomlScalar = (raw: string): TomlScalar | undefined => {
	const value = raw.trim();
	if (value === "true") return true;
	if (value === "false") return false;
	const quoted = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/.exec(value);
	if (quoted) return quoted[1] !== undefined ? quoted[1].replace(/\\(.)/g, "$1") : quoted[2]!;
	return undefined;
};

/** Index of the first `ch` outside strings and brackets, or -1. */
const indexOutside = (text: string, ch: string, trackDepth: boolean): number => {
	let depth = 0;
	let quote: string | null = null;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (quote) {
			if (quote === '"' && char === "\\") index++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (trackDepth && (char === "{" || char === "[")) depth++;
		else if (trackDepth && (char === "}" || char === "]")) depth--;
		else if (char === ch && depth === 0) return index;
	}
	return -1;
};

/** Splits `a = 1, b = { c = 2 }` at top-level commas. */
const splitInlineTable = (body: string): string[] => {
	const parts: string[] = [];
	let rest = body;
	for (;;) {
		const comma = indexOutside(rest, ",", true);
		if (comma < 0) break;
		parts.push(rest.slice(0, comma));
		rest = rest.slice(comma + 1);
	}
	parts.push(rest);
	return parts.filter((part) => part.trim().length > 0);
};

const collectTomlAssignment = (prefix: string[], assignment: string, entries: TomlEntries): void => {
	const equals = indexOutside(assignment, "=", false);
	if (equals < 0) return;
	const key = parseTomlKey(assignment.slice(0, equals));
	if (!key) return;
	const full = [...prefix, ...key];
	const rawValue = assignment.slice(equals + 1).trim();
	if (rawValue.startsWith("{") && rawValue.endsWith("}")) {
		entries.tables.push(full);
		for (const part of splitInlineTable(rawValue.slice(1, -1))) collectTomlAssignment(full, part, entries);
		return;
	}
	const scalar = parseTomlScalar(rawValue);
	if (scalar !== undefined) entries.values.push({ key: full, value: scalar });
};

const bracketBalance = (text: string): number => {
	let balance = 0;
	let quote: string | null = null;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (quote) {
			if (quote === '"' && char === "\\") index++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === "[" || char === "{") balance++;
		else if (char === "]" || char === "}") balance--;
	}
	return balance;
};

/**
 * Collects tables and boolean/string values from a Codex config.toml. Enough of
 * TOML for `[plugins."id"]`, `[projects."path"]`, dotted keys and inline tables;
 * multi-line strings and arrays are skipped without being misread as tables.
 */
export const parseTomlEntries = (content: string): TomlEntries => {
	const entries: TomlEntries = { tables: [], values: [] };
	let table: string[] = [];
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		let line = stripTomlComment(lines[index]!).trim();
		if (line.length === 0) continue;
		const multiline = /("""|''')/.exec(line);
		if (multiline && line.indexOf(multiline[1]!, multiline.index + 3) < 0) {
			// Skip to the end of a multi-line string.
			while (++index < lines.length && !lines[index]!.includes(multiline[1]!));
			continue;
		}
		if (line.startsWith("[[")) {
			// Arrays of tables are not used for these keys; ignore their contents.
			table = ["\u0000array"];
			continue;
		}
		if (line.startsWith("[")) {
			const header = /^\[([^\]]*)\]$/.exec(line);
			const key = header ? parseTomlKey(header[1]!) : null;
			table = key ?? ["\u0000invalid"];
			if (key) entries.tables.push(key);
			continue;
		}
		// Join a value that spans lines (multi-line arrays or inline tables).
		while (bracketBalance(line) > 0 && index + 1 < lines.length) {
			line = `${line} ${stripTomlComment(lines[++index]!).trim()}`;
		}
		collectTomlAssignment(table, line, entries);
	}
	return entries;
};

const keyEquals = (left: string[], right: string[]): boolean => left.length === right.length && left.every((part, index) => part === right[index]);

const tomlValue = (entries: TomlEntries, key: string[]): TomlScalar | undefined => {
	let result: TomlScalar | undefined;
	for (const entry of entries.values) if (keyEquals(entry.key, key)) result = entry.value;
	return result;
};

/**
 * Reads `[plugins."crosshead@crosshead"] enabled = true|false` from a Codex
 * config.toml. A listed plugin is enabled unless `enabled = false`. Returns null
 * when the file does not mention the plugin.
 */
export const readCodexPluginEnabled = (content: string): boolean | null => {
	const entries = parseTomlEntries(content);
	const key = ["plugins", CROSSHEAD_PLUGIN_ID];
	const enabled = tomlValue(entries, [...key, "enabled"]);
	if (typeof enabled === "boolean") return enabled;
	const mentioned =
		entries.tables.some((table) => keyEquals(table, key)) ||
		entries.values.some((entry) => entry.key.length > 2 && keyEquals(entry.key.slice(0, 2), key));
	return mentioned ? true : null;
};

/** True when the user config marks `dir` as a trusted project (`[projects."<dir>"] trust_level = "trusted"`). */
export const readCodexProjectTrusted = (content: string, dir: string): boolean =>
	tomlValue(parseTomlEntries(content), ["projects", path.resolve(dir), "trust_level"]) === "trusted";

const readText = (filePath: string): string | null => {
	try {
		return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
	} catch {
		return null;
	}
};

/** Project-level Codex config files for a workspace: the workspace and its git root. */
export const codexProjectConfigFiles = (workspaceRoot: string): Array<{ dir: string; file: string }> => {
	const workspace = path.resolve(workspaceRoot);
	const gitRoot = findGitRoot(workspace);
	const dirs = [workspace, ...(gitRoot && gitRoot !== workspace ? [gitRoot] : [])];
	return dirs.map((dir) => ({ dir, file: path.join(dir, ".codex", "config.toml") }));
};

/**
 * Codex plugin state for a workspace. The user config (`$CODEX_HOME/config.toml`)
 * applies everywhere. A project's `.codex/config.toml` applies only when the user
 * config trusts that project; otherwise Codex ignores it.
 */
export const detectCodexPlugin = (codexHome: string, workspaceRoot: string = process.cwd()): PluginDetection => {
	const userFile = path.join(path.resolve(codexHome), "config.toml");
	const userContent = readText(userFile);
	const userValue = userContent === null ? null : readCodexPluginEnabled(userContent);
	const enabledAtUserScope = userValue === true;
	let ignored: string | undefined;
	for (const { dir, file } of codexProjectConfigFiles(workspaceRoot)) {
		if (file === userFile) continue;
		const content = readText(file);
		if (content === null) continue;
		const value = readCodexPluginEnabled(content);
		if (value === null) continue;
		const trusted = userContent !== null && readCodexProjectTrusted(userContent, dir);
		if (!trusted) {
			ignored = `${file} is ignored until Codex trusts ${dir}`;
			continue;
		}
		return { enabled: value, source: file, scope: "project", enabledAtUserScope };
	}
	const extra = ignored ? { ignored } : {};
	if (userValue !== null) return { enabled: userValue, source: userFile, scope: "user", enabledAtUserScope, ...extra };
	return { enabled: false, source: null, scope: null, enabledAtUserScope, ...extra };
};

// ---- Hook mode selection ----------------------------------------------------

export type HookModeRequest = HostHookMode | "auto";

export type HookModeResolution = {
	mode: HostHookMode;
	detection: PluginDetection;
	/** The explicit request this install honored, kept so later reinstalls (for example `crosshead update`) repeat it. */
	request: HostHookMode | null;
	/** False when plugin hooks were requested but cannot be used globally: write no installer hooks either. */
	writeLegacyHooks: boolean;
	note: string | null;
};

/**
 * `--hook-mode plugin|settings|auto` (default auto, or the explicit request of a
 * previous install). Plugin mode needs the plugin enabled at user scope: it
 * removes the installer hooks, which can cover every project. When plugin hooks
 * are requested but the plugin is enabled only for some projects (or not yet),
 * the mode stays "settings", existing installer hooks are kept, no new ones are
 * written, and the plugin runs wherever no installer hooks load.
 */
export const resolveHostHookMode = (
	requested: string | boolean | undefined,
	detect: () => PluginDetection,
	previousRequest?: HostHookMode | null
): HookModeResolution => {
	const request = parseHookModeFlag(requested) ?? previousRequest ?? "auto";
	const detection = detect();
	if (request === "settings") return { mode: "settings", detection, request: "settings", writeLegacyHooks: true, note: null };
	if (detection.enabledAtUserScope) {
		return { mode: "plugin", detection, request: request === "plugin" ? "plugin" : null, writeLegacyHooks: false, note: null };
	}
	if (request === "auto") return { mode: "settings", detection, request: null, writeLegacyHooks: true, note: null };
	const where = detection.enabled && detection.source ? `enabled only in ${detection.source}` : "not enabled at user scope";
	return {
		mode: "settings",
		detection,
		request: "plugin",
		writeLegacyHooks: false,
		note: `the Crosshead plugin is ${where}; existing installer hooks are kept, no new ones are written, and the plugin runs where none load. Enable the plugin at user scope and rerun to migrate.`,
	};
};

export const parseHookModeFlag = (value: string | boolean | undefined): HookModeRequest | undefined => {
	if (value === undefined) return undefined;
	if (value === "auto" || value === "plugin" || value === "settings") return value;
	throw new Error("--hook-mode must be one of: auto, plugin, settings");
};

export const describeHookMode = (mode: HostHookMode, detection: PluginDetection | null): string =>
	mode === "plugin"
		? `plugin (hooks come from the Crosshead plugin${detection?.source ? `; enabled in ${detection.source}` : ""})`
		: "settings (hooks written by this installer)";

export const normalizeHostHookMode = (value: unknown): HostHookMode => (value === "plugin" ? "plugin" : "settings");

export const normalizeHookModeRequest = (value: unknown): HostHookMode | null =>
	value === "plugin" || value === "settings" ? value : null;

/**
 * True when a Claude Code or Codex adapter config file (marker line, then JSON)
 * relies on plugin hooks: plugin mode, or plugin hooks requested where the plugin
 * is not enabled at user scope (no installer hooks are written then).
 */
export const adapterConfigUsesPluginHooks = (configFile: string): boolean => {
	try {
		const content = readFileSync(configFile, "utf8");
		const parsed = JSON.parse(content.slice(content.indexOf("{"))) as { hookMode?: unknown; hookModeRequest?: unknown };
		return normalizeHostHookMode(parsed.hookMode) === "plugin" || normalizeHookModeRequest(parsed.hookModeRequest) === "plugin";
	} catch {
		return false;
	}
};

// ---- Dispatch -----------------------------------------------------------------

export const isPluginHookInvocation = (flags: Record<string, string | boolean>): boolean =>
	flags[PLUGIN_HOOK_VIA_FLAG[0].slice(2)] === PLUGIN_HOOK_VIA_FLAG[1];

export type HookDispatchDecision = "run" | "skip-duplicate";

/**
 * Exactly one registration handles each event. `legacyHooksPresent` answers
 * whether the host loaded installer-written Crosshead hooks for this session.
 * - Installer hooks loaded: they run and the plugin defers, in either mode.
 *   This covers projects the migration never saw and, for Codex, the window
 *   before the user trusts the plugin hooks.
 * - No installer hooks loaded: the plugin runs. In plugin mode a stale
 *   installer invocation (for example from a session that started before the
 *   migration) is skipped; in settings mode it still runs.
 */
export const decideHookDispatch = (input: {
	viaPlugin: boolean;
	mode: HostHookMode;
	legacyHooksPresent: () => boolean;
}): HookDispatchDecision => {
	if (input.viaPlugin) return input.legacyHooksPresent() ? "skip-duplicate" : "run";
	if (input.mode === "settings") return "run";
	return input.legacyHooksPresent() ? "run" : "skip-duplicate";
};

/**
 * Counts hook handlers whose command `isCrosshead` recognizes. Tolerates any
 * shape: non-object hooks, non-array events, null or non-object groups and
 * handlers are ignored, so empty arrays never count.
 */
export type HookMatch = { event: string; matcherValue?: string };

export const countMatchingHookCommands = (settings: unknown, isCrosshead: (command: string) => boolean, match?: HookMatch): number => {
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) return 0;
	const hooks = (settings as { hooks?: unknown }).hooks;
	if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return 0;
	let count = 0;
	for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
		if (match && event.toLowerCase().replace(/_/g, "") !== match.event.toLowerCase().replace(/_/g, "")) continue;
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			if (!group || typeof group !== "object" || Array.isArray(group)) continue;
			if (match) {
				const matcher = (group as { matcher?: unknown }).matcher;
				if (typeof matcher === "string" && matcher !== "" && matcher !== "*") {
					if (match.matcherValue === undefined) continue;
					try { if (!new RegExp(matcher).test(match.matcherValue)) continue; } catch { continue; }
				}
			}
			const handlers = (group as { hooks?: unknown }).hooks;
			if (!Array.isArray(handlers)) continue;
			for (const handler of handlers) {
				const command = handler && typeof handler === "object" ? (handler as { command?: unknown }).command : undefined;
				if (typeof command === "string" && isCrosshead(command)) count++;
			}
		}
	}
	return count;
};

/** Reads a JSON settings file for inspection; missing or invalid files read as null. */
export const readSettingsForInspection = (filePath: string): unknown => (existsSync(filePath) ? readJson(filePath) : null);

// ---- Plugin invocation receipts -----------------------------------------------

export type PluginInvocationRecord = { lastSeenAt: string; pluginVersion: string | null; hostHome: string | null };

const invocationFile = (runtimeHome: string): string => path.join(path.resolve(runtimeHome), "state", "host-plugin-invocations.json");

export const readPluginInvocation = (runtimeHome: string, host: HookHost): PluginInvocationRecord | null => {
	const records = parseJsonFile<Record<string, unknown> | null>(invocationFile(runtimeHome), null);
	const record = records?.[host] as Partial<PluginInvocationRecord> | undefined;
	return record && typeof record.lastSeenAt === "string"
		? { lastSeenAt: record.lastSeenAt, pluginVersion: typeof record.pluginVersion === "string" ? record.pluginVersion : null, hostHome: typeof record.hostHome === "string" ? record.hostHome : null }
		: null;
};

/**
 * Records that the host ran a plugin hook (for Codex, proof that the user trusted
 * the plugin hooks). Rewritten at most every 10 minutes per host, or when the
 * plugin version changes.
 */
export const pluginInvocationMatches = (record: PluginInvocationRecord | null | undefined, hostHome: string): boolean =>
	record?.pluginVersion === CROSSHEAD_HOST_PLUGIN_VERSION && record.hostHome === path.resolve(hostHome);

export const recordPluginInvocation = (runtimeHome: string, host: HookHost, pluginVersion: string | null, hostHome: string, now: Date = new Date()): void => {
	const previous = readPluginInvocation(runtimeHome, host);
	const resolvedHome = path.resolve(hostHome);
	if (previous && previous.pluginVersion === pluginVersion && previous.hostHome === resolvedHome && now.getTime() - Date.parse(previous.lastSeenAt) < 10 * 60_000) return;
	ensureRuntimeHomeLayout(runtimeHome);
	const file = invocationFile(runtimeHome);
	const records = parseJsonFile<Record<string, unknown> | null>(file, null) ?? {};
	writeJsonFile(file, { ...records, [host]: { lastSeenAt: now.toISOString(), pluginVersion, hostHome: resolvedHome } });
};

/**
 * Host config directory for a plugin invocation, which carries no
 * `--claude-home`/`--codex-home`: the host's own environment variable when set,
 * otherwise the directory the adapter was installed into (so `--claude-home`
 * and `--codex-home` installs work), otherwise the default.
 */
export const resolvePluginHostHome = (host: HookHost, runtimeHome: string, env: NodeJS.ProcessEnv = process.env): string | undefined => {
	const fromEnv = host === "codex" ? nonEmpty(env.CODEX_HOME) : nonEmpty(env.CLAUDE_CONFIG_DIR) ?? nonEmpty(env.CLAUDE_CODE_HOME);
	if (fromEnv) return path.resolve(fromEnv);
	try {
		return loadAdapterRecord(resolveRuntimePaths(runtimeHome), host)?.hostHome ?? undefined;
	} catch {
		return undefined;
	}
};

/** The Codex home whose hooks.json the host loaded, as the plugin launcher saw it before the wrapper's environment. */
export const codexLoadedHome = (fallback: string, env: NodeJS.ProcessEnv = process.env): string =>
	path.resolve(nonEmpty(env.CROSSHEAD_HOST_CODEX_HOME) ?? fallback);

/** One-line SessionStart JSON both hosts accept: a notice for the user only, with no model context. */
export const writePluginSetupNotice = (message: string): void => {
	process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
};
