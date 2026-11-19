import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { HostRuntimeAdapterBase, type HostAdapterIdentity } from "../../src/runtime/host-adapter-base";
import { RuntimeLifecycleManager } from "../../src/runtime/lifecycle-engine";
import { getHotSyncManager, stopHotSyncManagers } from "../../src/runtime/hot-sync-manager";
import { buildContinuityGovernorState } from "../../src/runtime/continuity-governor";
import { buildDefaultContinuityPolicy } from "../../src/runtime/continuity-policy";
import type { LocalRuntimeClient } from "../../src/runtime/local-client";

// A host Stop hook reports the end of a turn twice: turn.completed (or
// turn.failed) and then session.ended, both for the same session and turn.
// Each must not become its own synced checkpoint.

const homes: string[] = [];
const managers: RuntimeLifecycleManager[] = [];
class Adapter extends HostRuntimeAdapterBase {
	protected readonly identity: HostAdapterIdentity;
	protected readonly config = { profileName: "default", hostHome: "/fixture-host", adapterVersion: "fixture" };
	constructor(protected readonly client: LocalRuntimeClient, runtime: string) { super(); this.identity = { runtimeId: runtime, wrapperVersionFallback: "fixture", requestLabel: runtime }; }
	protected async attachWorkspace(): Promise<void> {}
}
const harness = (runtime: string) => {
	vi.stubEnv("CROSSHEAD_HOT_SYNC_ENABLED", "true");
	vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("fixture cloud offline"))));
	const stateDir = mkdtempSync(path.join(os.tmpdir(), "xhd-dedupe-")); homes.push(stateDir);
	const key = generateSecretKey(), npub = nip19.npubEncode(getPublicKey(key)), nsec = nip19.nsecEncode(key);
	const profile = { name: "default", apiBase: "https://crosshead.sh", npub, memoryMode: "assist" as const, features: { coldSync: false, autoWarmPromotion: false } };
	const lifecycle = new RuntimeLifecycleManager({ workerIntervalMs: 20, paths: { state: stateDir }, loadDefaultProfileName: () => "default", loadProfile: name => name === "default" ? profile : null,
		loadSecret: () => ({ nsec, session: null }), saveSecret: () => {}, loadHealth: () => ({ queueDepth: 0, lastSuccessfulSyncAt: null, lastError: null }), saveHealth: () => {},
		loadContinuityGovernorState: () => buildContinuityGovernorState(buildDefaultContinuityPolicy(), []), writeLog: () => {} });
	managers.push(lifecycle);
	const sync = getHotSyncManager({ stateDir, origin: profile.apiBase, npub, nsec, profileName: "default" });
	const client = { readHotMemory: async () => sync.read(), emitEvent: (event: Parameters<RuntimeLifecycleManager["handleEvent"]>[0]) => lifecycle.handleEvent({ ...event, eventId: event.eventId ?? randomUUID() }), status: async () => ({ profile }) } as unknown as LocalRuntimeClient;
	return { lifecycle, sync, adapter: new Adapter(client, runtime) };
};
type Visible = { id: string; sessionId?: string; turnId?: string; summary: string; origin?: string };
const visible = (sync: ReturnType<typeof harness>["sync"], inspect = false): Visible[] =>
	((sync.read("all", inspect) as { scopes: Array<{ content: string }> }).scopes)
		.flatMap(s => (JSON.parse(s.content) as { continuityCheckpoints: Visible[] }).continuityCheckpoints);
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.stop();
	for (const home of homes.splice(0)) { await stopHotSyncManagers(home); rmSync(home, { recursive: true, force: true }); }
	vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

const input = { workspaceRoot: "/fixture-project", sessionId: "session", turnId: "turn-1", prompt: "Find the duplicate" };
const finding = "Stop emits turn.completed and session.ended for the same turn.";

describe("one synced checkpoint per turn", () => {
	it.each(["claude-code", "codex"])("%s: completed turn followed by session end saves once", async runtime => {
		const h = harness(runtime);
		await h.adapter.prepareTurn(input);
		await h.adapter.completeTurn({ ...input, packId: null, goal: input.prompt, summary: finding });
		await h.adapter.sessionEnded({ ...input, packId: null, goal: input.prompt, summary: finding, taskSucceeded: true });
		const turn = visible(h.sync).filter(c => c.turnId === "turn-1");
		expect(turn).toHaveLength(1);
		expect(turn[0]!.summary).toContain(finding);
		// The identical second capture is not written at all, so only one record waits to sync.
		expect(h.sync.status().pendingCount).toBe(1);
	});

	it("failed turn followed by session end saves once", async () => {
		const h = harness("claude-code");
		await h.adapter.prepareTurn(input);
		await h.adapter.failTurn({ ...input, packId: null, goal: input.prompt, summary: finding });
		await h.adapter.sessionEnded({ ...input, packId: null, goal: input.prompt, summary: finding, taskSucceeded: false });
		expect(visible(h.sync).filter(c => c.turnId === "turn-1")).toHaveLength(1);
	});

	it("a later, different capture of the same turn replaces the earlier one", async () => {
		const h = harness("codex");
		await h.adapter.prepareTurn(input);
		await h.adapter.completeTurn({ ...input, packId: null, goal: input.prompt, summary: "First version of the finding." });
		// A turn reported again (for example a retried Stop hook) with a newer finding.
		await h.adapter.completeTurn({ ...input, packId: null, goal: input.prompt, summary: "Revised version of the finding." });
		const turn = visible(h.sync).filter(c => c.turnId === "turn-1");
		expect(turn.map(c => c.summary)).toEqual([expect.stringContaining("Revised version")]);
	});

	it("separate turns stay separate", async () => {
		const h = harness("claude-code");
		for (const turnId of ["turn-1", "turn-2"]) {
			await h.adapter.prepareTurn({ ...input, turnId });
			await h.adapter.completeTurn({ ...input, turnId, packId: null, goal: input.prompt, summary: `${finding} (${turnId})` });
			await h.adapter.sessionEnded({ ...input, turnId, packId: null, goal: input.prompt, summary: `${finding} (${turnId})`, taskSucceeded: true });
		}
		expect(visible(h.sync).map(c => c.turnId).sort()).toEqual(["turn-1", "turn-2"]);
	});

	it("an explicit remember in the same session is kept beside the turn's checkpoint", async () => {
		const h = harness("codex");
		await h.adapter.prepareTurn(input);
		await h.lifecycle.handleEvent({ eventId: "remember-1", runtime: "codex", type: "operator.command", workspaceId: "repo:/fixture-project", sessionId: "session", turnId: "turn-1",
			payload: { command: "remember", content: "Keep this explicit note.", entryType: "fact" } });
		await h.adapter.completeTurn({ ...input, packId: null, goal: input.prompt, summary: finding });
		await h.adapter.sessionEnded({ ...input, packId: null, goal: input.prompt, summary: finding, taskSucceeded: true });
		const shown = visible(h.sync);
		expect(shown.filter(c => c.origin === "remember")).toHaveLength(1);
		expect(shown.filter(c => c.origin !== "remember")).toHaveLength(1);
	});

	it("collapses duplicates already saved by older clients when reading, but keeps them for inspection", () => {
		const h = harness("claude-code");
		const base = { runtime: "claude-code", workspaceId: "repo:/fixture-project", goal: input.prompt, sessionId: "session", turnId: "old-turn" };
		// Ids deliberately sort opposite to time, so the survivor cannot come from array order.
		h.sync.capture("", { ...base, id: "b-older", occurredAt: "2026-11-18T10:00:00.000Z", summary: "older copy" });
		h.sync.capture("", { ...base, id: "a-newer", occurredAt: "2026-11-18T10:00:00.020Z", summary: "newer copy" });
		h.sync.capture("", { ...base, id: "c-legacy-1", turnId: undefined, occurredAt: "2026-11-18T09:00:00.000Z", summary: "legacy without turn" });
		h.sync.capture("", { ...base, id: "d-legacy-2", turnId: undefined, occurredAt: "2026-11-18T09:00:00.010Z", summary: "legacy without turn" });
		const shown = visible(h.sync);
		expect(shown.filter(c => c.turnId === "old-turn").map(c => c.summary)).toEqual(["newer copy"]);
		expect(shown.filter(c => !c.turnId)).toHaveLength(2);
		expect(visible(h.sync, true).filter(c => c.turnId === "old-turn")).toHaveLength(2);
	});
});
