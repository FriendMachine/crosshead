import { daemonOwnerIsLive, probeRuntimeDaemonHealth, readDaemonOwnershipState } from "./daemon-ownership";
import { startDetachedRuntimeDaemon } from "./local-runtime";
import { resolveRuntimePaths } from "./runtime-persistence";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Recover before dispatch, never replay an HTTP mutation after an ambiguous error. */
export const ensureHookRuntime = async (home: string): Promise<void> => {
	const paths = resolveRuntimePaths(home);
	const state = readDaemonOwnershipState(paths);
	if (state && await probeRuntimeDaemonHealth(state)) return;
	if ((process.env.CROSSHEAD_HOOK_AUTOSTART ?? process.env.ONLYBOTS_HOOK_AUTOSTART) === "0") {
		throw new Error("Crosshead daemon is unavailable and hook autostart is disabled; run crosshead start");
	}
	if (!daemonOwnerIsLive(state)) {
		// A coding hook cannot authorize restarting a paid organizational worker,
		// nor silently replace it with a daemon lacking its worker configuration.
		if (state?.organizationalWorkerConfigPath) {
			throw new Error("Crosshead organizational worker needs an explicit operator restart");
		}
		try {
			await startDetachedRuntimeDaemon({ home });
			return;
		} catch {
			// Another hook may have won the daemon's exclusive ownership lock.
			// Check its health below; never signal or replace that winner.
		}
	}
	const deadline = Date.now() + 5_000;
	do {
		const current = readDaemonOwnershipState(paths);
		if (current && await probeRuntimeDaemonHealth(current, Math.min(500, Math.max(1, deadline - Date.now())))) return;
		await pause(100);
	} while (Date.now() < deadline);
	throw new Error("Crosshead daemon is unavailable; run crosshead doctor. Live owners are never killed by hooks");
};

/** Successful host continuation must not imply successful memory delivery. */
export const reportHookFailure = (host: "codex" | "claude-code", event: string | undefined, error: unknown): void => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`onlybots-${host}-hook warning: ${message}`);
	if (["userpromptsubmit", "user_prompt_submit"].includes(event?.toLowerCase() ?? "")) {
		const warning = "Crosshead continuity is unavailable for this turn. Do not assume saved memory was loaded or this turn will be captured. Run crosshead doctor to diagnose.";
		process.stdout.write(host === "codex"
			? `${JSON.stringify({ continue: true, hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: warning } })}\n`
			: `${warning}\n`);
	}
};
