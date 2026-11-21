import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { shellQuote } from "./adapter-utils";
import { acquireWorkspaceSetupKernelLock } from "./daemon-kernel-lock";
import type { NativeHostConfig } from "./native-host-adapter";

const PREFIX = "crosshead-agy-";

export const agySettingsPath = (geminiHome: string): string => path.join(geminiHome, "config", "hooks.json");

export const renderAgySettings = (config: NativeHostConfig, owner: string, install: boolean): string => {
	const file = agySettingsPath(config.hostHome);
	const settings: unknown = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
		throw new Error("Antigravity hooks.json must contain an object.");
	}
	const groups = settings as Record<string, unknown>;
	const name = PREFIX + owner;
	if (!install) {
		delete groups[name];
		return JSON.stringify(groups, null, 2) + "\n";
	}
	if (Object.keys(groups).some(key => key.startsWith(PREFIX) && key !== name)) {
		throw new Error("Antigravity already has Crosshead hooks from another runtime. Uninstall them first.");
	}
	const previous = groups[name];
	const enabled = !(previous && typeof previous === "object" && "enabled" in previous && previous.enabled === false);
	const launcher = shellQuote(path.join(config.runtimeHome, "bin", "crosshead")) + " host-hook agy";
	const home = " --home " + shellQuote(config.runtimeHome);
	groups[name] = {
		enabled,
		PreInvocation: [{ type: "command", command: launcher + " prepare" + home, timeout: 20 }],
		Stop: [{ type: "command", command: launcher + " complete" + home, timeout: 30 }],
	};
	return JSON.stringify(groups, null, 2) + "\n";
};

// Two runtime homes can target the same user hook file. Serialize edits by the
// host config location so both installs cannot claim ownership at once.
export const withAgySettingsLock = async <T>(geminiHome: string, edit: () => Promise<T>): Promise<T> => {
	mkdirSync(geminiHome, { recursive: true, mode: 0o700 });
	const lock = await acquireWorkspaceSetupKernelLock(agySettingsPath(realpathSync(geminiHome)));
	try { return await edit(); }
	finally { await lock.close(); }
};
