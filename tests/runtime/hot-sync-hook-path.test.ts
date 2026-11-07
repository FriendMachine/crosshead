import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { HostRuntimeAdapterBase, type HostAdapterIdentity } from "../../src/runtime/host-adapter-base";
import { RuntimeLifecycleManager } from "../../src/runtime/lifecycle-engine";
import { HostedOnlyBotsClient } from "../../src/runtime/hosted-client";
import { getHotSyncManager, stopHotSyncManagers, hotSyncEnabled } from "../../src/runtime/hot-sync-manager";
import { buildContinuityGovernorState } from "../../src/runtime/continuity-governor";
import { buildDefaultContinuityPolicy } from "../../src/runtime/continuity-policy";
import type { LocalRuntimeClient } from "../../src/runtime/local-client";

const homes: string[] = [];
const releases: Array<() => void> = [];
const managers: RuntimeLifecycleManager[] = [];
class Adapter extends HostRuntimeAdapterBase {
	protected readonly identity: HostAdapterIdentity;
	protected readonly config = { profileName: "default", hostHome: "/fixture-host", adapterVersion: "fixture" };
	constructor(protected readonly client: LocalRuntimeClient, runtime: string) { super(); this.identity = { runtimeId: runtime, wrapperVersionFallback: "fixture", requestLabel: runtime }; }
	protected async attachWorkspace(): Promise<void> {}
}
const deadline = async <T>(work: Promise<T>): Promise<T> => {
	let timer: ReturnType<typeof setTimeout>;
	try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("hook waited for the hosted service")), 500); })]); }
	finally { clearTimeout(timer!); }
};
const harness = (runtime = "codex", coldSync = false) => {
	vi.stubEnv("CROSSHEAD_HOT_SYNC_ENABLED", "true");
	let blocked = true;
	const pending = new Set<(reason: Error) => void>();
	const fetcher = vi.fn(() => blocked ? new Promise<Response>((_, reject) => pending.add(reject)) : Promise.reject(new Error("fixture cloud offline")));
	vi.stubGlobal("fetch", fetcher);
	const release = () => { blocked = false; for (const reject of pending) reject(new Error("fixture cloud offline")); pending.clear(); };
	releases.push(release);
	const stateDir = mkdtempSync(path.join(os.tmpdir(), "xhd-hook-")); homes.push(stateDir);
	const key = generateSecretKey(), npub = nip19.npubEncode(getPublicKey(key)), nsec = nip19.nsecEncode(key);
	const profile = { name: "default", apiBase: "https://crosshead.sh", npub, memoryMode: coldSync ? "auto" as const : "assist" as const, features: { coldSync, autoWarmPromotion: false } };
	const lifecycle = new RuntimeLifecycleManager({ workerIntervalMs: 20, paths: { state: stateDir }, loadDefaultProfileName: () => "default", loadProfile: name => name === "default" ? profile : null,
		loadSecret: () => ({ nsec, session: null }), saveSecret: () => {}, loadHealth: () => ({ queueDepth: 0, lastSuccessfulSyncAt: null, lastError: null }), saveHealth: () => {},
		loadContinuityGovernorState: () => buildContinuityGovernorState(buildDefaultContinuityPolicy(), []), writeLog: () => {} });
	managers.push(lifecycle);
	const sync = getHotSyncManager({ stateDir, origin: profile.apiBase, npub, nsec, profileName: "default" });
	const client = { readHotMemory: async () => sync.read(), emitEvent: (event: Parameters<RuntimeLifecycleManager['handleEvent']>[0]) => lifecycle.handleEvent({ ...event, eventId: event.eventId ?? randomUUID() }) } as unknown as LocalRuntimeClient;
	return { stateDir, lifecycle, sync, adapter: new Adapter(client, runtime), fetcher, release };
};
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const manager of managers.splice(0)) await manager.stop();
	for (const home of homes.splice(0)) { await stopHotSyncManagers(home); rmSync(home, { recursive: true, force: true }); }
	vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("real adapter local hot-memory path", () => {
	it("uses local hot sync by default and supports an explicit rollback opt-out", () => {
		vi.stubEnv("CROSSHEAD_HOT_SYNC_ENABLED", undefined); expect(hotSyncEnabled()).toBe(true);
		vi.stubEnv("CROSSHEAD_HOT_SYNC_ENABLED", "false"); expect(hotSyncEnabled()).toBe(false);
		vi.stubEnv("CROSSHEAD_HOT_SYNC_ENABLED", "true"); expect(hotSyncEnabled()).toBe(true);
	});
	it.each(["codex", "claude-code", "pi", "hermes", "opencode"])("prepares and durably completes %s while hosted requests hang", async runtime => {
		const h = harness(runtime);
		const input = { workspaceRoot: "/fixture-project", sessionId: "session", turnId: "first", prompt: "Repair the queue" };
		const prepared = await deadline(h.adapter.prepareTurn(input));
		expect(prepared.packId).toBeNull();
		await deadline(h.adapter.completeTurn({ ...input, packId: prepared.packId, goal: input.prompt, summary: "Fsync the queue before acknowledging capture." }));
		expect(h.sync.status().pendingCount).toBe(1);
		const continued = await deadline(h.adapter.prepareTurn({ ...input, turnId: "second", prompt: "Continue queue repair" }));
		expect(continued.contextText).toContain("Fsync the queue before acknowledging capture.");
		expect(h.fetcher).not.toHaveBeenCalled();
	});
	it("does not hold the lifecycle lock during a previously due archive upload", async () => {
		const h = harness();
		const now = new Date().toISOString();
		const item = { id: "old-archive", key: "cold:default:session", kind: "cold_batch", profileName: "default", eventId: "old", sessionId: "session", workspaceId: "repo:/fixture-project", createdAt: now, availableAt: now, attempts: 0, payload: { items: [{ kind: "note", content: "old archive fixture" }] } };
		writeFileSync(path.join(h.stateDir, "queue.json"), JSON.stringify({ items: [item], processedEventIds: [] }));
		const flushing = h.lifecycle.flushDueItems();
		try {
			await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalled(), { timeout: 1000 });
			const input = { workspaceRoot: "/fixture-project", sessionId: "session", turnId: "new", prompt: "Continue" };
			const prepared = await deadline(h.adapter.prepareTurn(input));
			await deadline(h.adapter.completeTurn({ ...input, packId: prepared.packId, goal: input.prompt, summary: "The new finding survives a blocked archive." }));
			expect(h.sync.status().pendingCount).toBe(1);
			// The durable processed-event IDs written by new hooks must survive the
			// older worker's acknowledgment/retry commit.
			const before = JSON.parse(readFileSync(path.join(h.stateDir, "queue.json"), "utf8"));
			h.release(); await flushing;
			const after = JSON.parse(readFileSync(path.join(h.stateDir, "queue.json"), "utf8"));
			expect(after.processedEventIds).toEqual(before.processedEventIds);
			expect(after.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: "old-archive", attempts: 1 })]));
		} finally { h.release(); await flushing; }
	});
	it("imports unsent upgrade snapshots locally before new captures, and repeats safely after a crash", async () => {
		const h = harness();
		const checkpoint = { goal: "Recover upgrade", summary: "The unsent pre-upgrade finding", occurredAt: new Date().toISOString() };
		const item = { id: "upgrade", kind: "hot_write", profileName: "default", workspaceId: "repo:/fixture-project", payload: { scope: "codex", hotState: { runtime: "codex", workspaceId: "repo:/fixture-project", continuityCheckpoints: [checkpoint] } } };
		const queue = path.join(h.stateDir, "queue.json");
		const original = JSON.stringify({ items: [item], processedEventIds: [] });
		writeFileSync(queue, original);
		const input = { workspaceRoot: "/fixture-project", sessionId: "session", turnId: "upgrade", prompt: "Continue" };
		await deadline(h.adapter.prepareTurn(input));
		expect(h.sync.status().pendingCount).toBe(1);
		// Simulate a crash after the outbox fsync but before legacy-row removal.
		writeFileSync(queue, original);
		await deadline(h.adapter.completeTurn({ ...input, packId: null, goal: input.prompt, summary: "A new post-upgrade finding" }));
		expect(h.sync.status().pendingCount).toBe(2);
		const resumed = await deadline(h.adapter.prepareTurn({ ...input, turnId: "upgraded" }));
		expect(JSON.stringify(h.sync.read())).toContain(checkpoint.summary);
		expect(resumed.contextText).toContain("A new post-upgrade finding");
		expect(JSON.parse(readFileSync(queue, "utf8")).items).toEqual([]);
		expect(h.fetcher).not.toHaveBeenCalled();
	});
	it("acknowledges an uploaded archive without removing the same-key arrivals or processed events", async () => {
		const h = harness("codex", true);
		let release!: () => void;
		const upload = vi.spyOn(HostedOnlyBotsClient.prototype, "ingestColdMemory").mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({}); }));
		const input = { workspaceRoot: "/fixture-project", sessionId: "session", turnId: "one", prompt: "Continue" };
		await h.adapter.completeTurn({ ...input, packId: null, goal: input.prompt, summary: "First archived finding", transcript: [{ role: "assistant", content: "First archived finding" }] });
		const file = path.join(h.stateDir, "queue.json");
		const first = JSON.parse(readFileSync(file, "utf8"));
		expect(first.items).toHaveLength(1);
		const flushing = h.lifecycle.flushDueItems();
		try {
			await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
			await deadline(h.adapter.completeTurn({ ...input, turnId: "two", packId: null, goal: input.prompt, summary: "Second archived finding", transcript: [{ role: "assistant", content: "Second archived finding" }] }));
			const before = JSON.parse(readFileSync(file, "utf8"));
			expect(before.items).toHaveLength(2);
			expect(before.items[0].key).toBe(before.items[1].key);
			release(); await flushing;
			const after = JSON.parse(readFileSync(file, "utf8"));
			expect(after.items.map((i: {id: string}) => i.id)).toEqual([before.items[1].id]);
			expect(after.processedEventIds).toEqual(before.processedEventIds);
		} finally { release?.(); h.release(); await flushing; }
	});

	it("retains an unimportable row without blocking healthy hooks or uploading it as legacy data", async () => {
		const h = harness();
		const file = path.join(h.stateDir, "queue.json");
		const rows = [
			{ id: "unsupported", kind: "hot_write", profileName: "default", workspaceId: null, payload: { hotState: { currentTask: "Keep this task" } } },
			{ id: "removed-profile", kind: "hot_write", profileName: "removed", payload: { hotState: {} } },
		];
		writeFileSync(file, JSON.stringify({ items: rows, processedEventIds: [] }));
		await deadline(h.adapter.completeTurn({ workspaceRoot: "/fixture-project", sessionId: "session", turnId: "healthy", packId: null, goal: "Continue", summary: "Healthy local capture" }));
		expect(h.sync.status().pendingCount).toBe(1);
		expect(h.sync.status().state).toBe("needs_attention");
		await deadline(h.lifecycle.flushDueItems());
		expect(JSON.parse(readFileSync(file, "utf8")).items).toEqual(rows);
		h.release();
	});
	it("continues hot sync while an archive upload remains blocked", async () => {
		const h = harness();
		vi.spyOn(HostedOnlyBotsClient.prototype, "hotSyncCapabilities").mockResolvedValue({ enabled: true, version: 2 });
		vi.spyOn(HostedOnlyBotsClient.prototype, "listHotSync").mockResolvedValue({ scopes: [], next_cursor: null });
		vi.spyOn(HostedOnlyBotsClient.prototype, "readHotMemory").mockResolvedValue({ scopes: [] });
		vi.spyOn(HostedOnlyBotsClient.prototype, "readHotSync").mockImplementation(async (namespace, scope) => ({ namespace, scope, epoch: 0, revision: 0, content: null }));
		const write = vi.spyOn(HostedOnlyBotsClient.prototype, "writeHotSync").mockImplementation(async (base, content) => ({ ...base, revision: base.revision + 1, content }));
		let release!: () => void;
		const archive = vi.spyOn(HostedOnlyBotsClient.prototype, "ingestColdMemory").mockImplementation(() => new Promise(resolve => { release = () => resolve({}); }));
		const now = new Date().toISOString();
		writeFileSync(path.join(h.stateDir, "queue.json"), JSON.stringify({ items: [{ id: "archive", kind: "cold_batch", profileName: "default", eventId: "archive", availableAt: now, attempts: 0, payload: { items: [{ role: "assistant", content: "Archive", timestamp: now }] } }], processedEventIds: [] }));
		h.lifecycle.start();
		try {
			await vi.waitFor(() => expect(archive).toHaveBeenCalledOnce());
			await vi.waitFor(() => expect(h.sync.status().initialSyncPending).toBe(false));
			await deadline(h.adapter.completeTurn({ workspaceRoot: "/fixture-project", sessionId: "session", turnId: "during-archive", packId: null, goal: "Continue", summary: "Sync before archive finishes" }));
			expect(h.sync.status().pendingCount).toBe(1);
			await vi.waitFor(() => expect(h.sync.status().pendingCount).toBe(0), { timeout: 4000 });
			expect(write).toHaveBeenCalled();
			expect(JSON.parse(readFileSync(path.join(h.stateDir, "queue.json"), "utf8")).items).toHaveLength(1);
		} finally { release?.(); h.release(); await h.lifecycle.stop(); }
	});

});
