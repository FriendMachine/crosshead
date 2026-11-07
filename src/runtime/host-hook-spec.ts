// Single source of truth for the Claude Code and Codex lifecycle hooks Crosshead
// registers. The legacy installers (`crosshead install claude-code|codex`) and the
// generated host plugins (`plugins/`, see scripts/host-plugins.mjs) both render
// their hook files from this table, so the two modes cannot drift apart.

export type HookHost = "claude-code" | "codex";

export type HostHookEvent = "SessionStart" | "PreCompact" | "PostCompact" | "UserPromptSubmit" | "Stop";

export type HostHookHandler = {
	type: "command";
	command: string;
	statusMessage?: string;
	timeout?: number;
};

export type HostHookMatcherGroup = {
	matcher?: string;
	hooks: HostHookHandler[];
};

type HostHookEventSpec = {
	event: HostHookEvent;
	matcher?: string;
	/** Codex shows this while the hook runs. Claude Code registrations omit it. */
	codexStatusMessage: string;
	/** Codex timeout in seconds. Claude Code uses its own defaults. */
	codexTimeout?: number;
};

export const HOST_HOOK_EVENTS: readonly HostHookEventSpec[] = [
	{ event: "SessionStart", matcher: "startup|resume|clear|compact|fork", codexStatusMessage: "Crosshead session sync" },
	{ event: "PreCompact", matcher: "manual|auto", codexStatusMessage: "Crosshead pre-compact checkpoint", codexTimeout: 30 },
	{ event: "PostCompact", matcher: "manual|auto", codexStatusMessage: "Crosshead post-compact sync", codexTimeout: 30 },
	{ event: "UserPromptSubmit", codexStatusMessage: "Crosshead context", codexTimeout: 45 },
	{ event: "Stop", codexStatusMessage: "Crosshead memory sync", codexTimeout: 30 },
];

/** Plugin identity shared by both hosts' marketplaces: `crosshead@crosshead`. */
export const CROSSHEAD_PLUGIN_NAME = "crosshead";
export const CROSSHEAD_MARKETPLACE_NAME = "crosshead";
/** Bump when any generated plugin file changes; hosts pin installed plugins by version. */
export const CROSSHEAD_HOST_PLUGIN_VERSION = "1.0.1";

/** Path, relative to the plugin root, of the launcher the plugin hooks run. */
export const PLUGIN_HOOK_LAUNCHER = "scripts/crosshead-hook";

/** Flag the plugin launcher adds so the runtime can tell plugin and legacy invocations apart. */
export const PLUGIN_HOOK_VIA_FLAG = ["--via", "plugin"] as const;

export const pluginRootVariable = (host: HookHost): string => (host === "codex" ? "PLUGIN_ROOT" : "CLAUDE_PLUGIN_ROOT");

/**
 * Marker in the runtime's Claude Code and Codex hook wrappers. A wrapper without
 * it runs a runtime that predates plugin dispatch, which the launcher must not
 * call (it would treat a plugin invocation as an installer hook).
 */
export const PLUGIN_DISPATCH_CAPABILITY = "crosshead-hook-capability: plugin-dispatch-v1";

/** Flag the launcher adds so invocation receipts record which plugin version ran. */
export const PLUGIN_VERSION_FLAG = "--plugin-version";

const setupCommand = (host: HookHost): string => (host === "codex" ? "type $crosshead:setup" : "run /crosshead:setup");

// SessionStart notices are shown to the user only (systemMessage); they are not
// added to model context, so the model is never invited to run setup itself.
export const pluginSetupHint = (host: HookHost): string => `Crosshead isn't set up. To set it up, ${setupCommand(host)}.`;

export const pluginUpdateHint = (host: HookHost): string =>
	`The installed Crosshead runtime predates this plugin. To update it, ${setupCommand(host)}.`;

export const PLUGIN_HOME_CONFLICT_HINT =
	"Crosshead found separate ~/.crosshead and ~/.onlybots installations. Set CROSSHEAD_HOME to choose one; no state was moved.";

/** Ordered `[event, matcher group]` pairs for one host, with the caller's command per event. */
export const renderHostHookGroups = (
	host: HookHost,
	commandFor: (event: HostHookEvent) => string
): Array<readonly [HostHookEvent, HostHookMatcherGroup]> =>
	HOST_HOOK_EVENTS.map((spec) => {
		const handler: HostHookHandler = { type: "command", command: commandFor(spec.event) };
		if (host === "codex") {
			handler.statusMessage = spec.codexStatusMessage;
			if (spec.codexTimeout !== undefined) handler.timeout = spec.codexTimeout;
		}
		const group: HostHookMatcherGroup = spec.matcher === undefined ? { hooks: [handler] } : { matcher: spec.matcher, hooks: [handler] };
		return [spec.event, group] as const;
	});

/**
 * The command a plugin hook runs. The launcher resolves the installed runtime at
 * run time. It is run through `sh` so a lost executable bit cannot break it.
 */
export const pluginHookCommand = (host: HookHost, event: HostHookEvent): string =>
	`sh "\${${pluginRootVariable(host)}}/${PLUGIN_HOOK_LAUNCHER}" ${host} ${event}`;

/** Contents of a plugin's `hooks/hooks.json`. */
export const renderPluginHooksFile = (host: HookHost): string => {
	const hooks: Partial<Record<HostHookEvent, HostHookMatcherGroup[]>> = {};
	for (const [event, group] of renderHostHookGroups(host, (name) => pluginHookCommand(host, name))) {
		hooks[event] = [group];
	}
	return `${JSON.stringify({ description: "Crosshead persistent memory hooks. They run the locally installed Crosshead runtime.", hooks }, null, 2)}\n`;
};
