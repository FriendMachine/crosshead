import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { shellQuote } from "./adapter-utils";
import type { NativeHostConfig } from "./native-host-adapter";

const EVENTS = ["BeforeAgent", "AfterAgent", "SessionEnd"] as const;
const NAME_PREFIX = "crosshead-gemini-";
const record = (input: unknown): Record<string, unknown> | undefined =>
	input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;

export const geminiSettingsPath = (config: NativeHostConfig): string => path.join(config.hostHome, "settings.json");

export const renderGeminiSettings = (config: NativeHostConfig, owner: string, install: boolean): string => {
	const file = geminiSettingsPath(config);
	const settings = record(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
	if (!settings) throw new Error("Gemini CLI settings must be a JSON object.");
	const hooks = record(settings.hooks ?? {});
	if (!hooks) throw new Error("Gemini CLI settings hooks must be an object.");
	const command = [config.nodeExecutable, path.join(__dirname, "gemini-cli-hook.js"), "--home", config.runtimeHome]
		.map(shellQuote).join(" ");
	for (const event of EVENTS) {
		const name = NAME_PREFIX + owner + "-" + event.toLowerCase();
		const groups = hooks[event] ?? [];
		if (!Array.isArray(groups)) throw new Error("Invalid Gemini CLI hook group for " + event);
		const kept = groups.flatMap(entry => {
			const group = record(entry);
			if (!group || !Array.isArray(group.hooks)) return [entry];
			const remaining = group.hooks.filter(hook => {
				const candidate = record(hook)?.name;
				if (install && typeof candidate === "string" && candidate.startsWith(NAME_PREFIX) && candidate !== name) {
					throw new Error("Gemini CLI already has hooks from another Crosshead runtime. Uninstall them first.");
				}
				return candidate !== name;
			});
			if (remaining.length === group.hooks.length) return [entry];
			return remaining.length ? [{ ...group, hooks: remaining }] : [];
		});
		if (install) kept.push({ hooks: [{ type: "command", name, command, timeout: 20_000 }] });
		if (kept.length) hooks[event] = kept;
		else delete hooks[event];
	}
	if (Object.keys(hooks).length) settings.hooks = hooks;
	else delete settings.hooks;
	return JSON.stringify(settings, null, 2) + "\n";
};
