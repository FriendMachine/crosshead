import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, truncateSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { HotSyncManager, canonicalGitRemote, stopHotSyncManagers } from "../../src/runtime/hot-sync-manager";
import { HotSyncReplica, HOT_SYNC_LOCAL_BYTES, hotSyncTenantDirectory } from "../../src/runtime/hot-sync-replica";
import { HostedOnlyBotsClient, HostedOnlyBotsRequestError } from "../../src/runtime/hosted-client";
import { HOT_SYNC_VERSION, type HotSyncCheckpoint, type HotSyncEnvelope, type HotSyncSnapshot } from "../../src/protocol/hot-sync";
import { buildContinuityGovernorState } from "../../src/runtime/continuity-governor";
import { buildDefaultContinuityPolicy } from "../../src/runtime/continuity-policy";
import { RuntimeLifecycleManager } from "../../src/runtime/lifecycle-engine";
import { signHotSync, verifyHotSync } from "../../src/runtime/hot-sync-signing";
const homes: string[] = [];
const home = () => { const h = mkdtempSync(path.join(tmpdir(), "xhd-hot-acceptance-")); homes.push(h); return h; };
const identity = () => { const key = generateSecretKey(); return { npub: nip19.npubEncode(getPublicKey(key)), nsec: nip19.nsecEncode(key) }; };
const checkpoint = (id: string): HotSyncCheckpoint => ({ id, deviceId: "device", runtime: "codex", workspaceId: "repo:/project", goal: "repair sync", summary: `finding ${id}`, occurredAt: "2026-11-03T00:00:00Z" });
class Cloud {
	rows = new Map<string, HotSyncSnapshot>();
	legacy: Record<string, unknown> = { scopes: [] };
	offline = false;
	accepted: string[] = [];
	client(npub: string): HostedOnlyBotsClient {
		const key = (n: string, s: string) => JSON.stringify([npub, n, s]);
		const read = async (n: string, s: string) => structuredClone(this.rows.get(key(n, s)) ?? { namespace: n, scope: s, epoch: 0, revision: 0, content: null });
		return {
			hotSyncCapabilities: async () => { if (this.offline)
				throw new Error("offline"); return { version: 1, enabled: true }; },
			listHotSync: async (n: string) => ({ scopes: [...this.rows.entries()].filter(([k]) => JSON.parse(k)[0] === npub && JSON.parse(k)[1] === n).map(([, v]) => ({ ...v, content: null })), next_cursor: null }),
			readHotMemory: async () => this.legacy,
			readHotSync: read,
			writeHotSync: async (b: HotSyncSnapshot, content: HotSyncEnvelope) => {
				const current = await read(b.namespace, b.scope);
				if (b.epoch !== current.epoch || b.revision !== current.revision)
					throw new Error("409");
				expect(verifyHotSync(content, npub, b.namespace, b.scope, b.epoch)).toBe(true);
				this.accepted.push(...content.document.checkpoints.map(c => c.id));
				const next = { ...b, revision: b.revision + 1, content };
				this.rows.set(key(b.namespace, b.scope), next);
				return structuredClone(next);
			},
			resetHotSync: async (b: HotSyncSnapshot) => { const current = await read(b.namespace, b.scope); if (b.revision !== current.revision)
				throw new Error("409"); const next = { ...b, epoch: b.epoch + 1, revision: b.revision + 1, content: null }; this.rows.set(key(b.namespace, b.scope), next); return next; },
			setSession: vi.fn(),
		} as unknown as HostedOnlyBotsClient;
	}
}
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const h of homes.splice(0)) {
	await stopHotSyncManagers(h);
	rmSync(h, { recursive: true, force: true });
} });
const entries = (m: HotSyncManager, inspect = false) => (m.read("all", inspect).scopes as Array<{
	content: string;
}>).flatMap(e => JSON.parse(e.content).continuityCheckpoints as HotSyncCheckpoint[]);
describe("local-first hot-memory acceptance", () => {
	it("maps sanitized remotes and explicit links across paths, while isolating profiles and identities", async () => {
		expect(canonicalGitRemote("git@github.com:FriendMachine/crosshead.git")).toBe("github.com/FriendMachine/crosshead");
		expect(canonicalGitRemote("https://user:secret@github.com/FriendMachine/crosshead.git?token=secret")).toBe("github.com/FriendMachine/crosshead");
		const cloud = new Cloud(), id = identity();
		const make = (stateDir: string, profileName = "default", who = id) => new HotSyncManager({ stateDir, origin: "https://crosshead.sh", ...who, profileName }, cloud.client(who.npub));
		const a = make(home()), b = make(home()), otherProfile = make(home(), "work"), otherIdentity = make(home(), "default", identity());
		const rootA = home(), rootB = home();
		for (const root of [rootA, rootB]) {
			execFileSync("git", ["init", "-q", root]);
			execFileSync("git", ["-C", root, "remote", "add", "origin", root === rootA ? "git@github.com:org/project.git" : "https://github.com/org/project.git"]);
		}
		expect(a.workspace(`repo:${rootA}`)).toBe(b.workspace(`repo:${rootB}`));
		expect(a.link("/a", "project").workspaceId).toBe(b.link("/b", "project").workspaceId);
		otherProfile.link("/c", "project");
		otherIdentity.link("/d", "project");
		a.capture("ignored", { ...checkpoint("one"), workspaceId: "repo:/a" });
		b.capture("ignored", { ...checkpoint("two"), workspaceId: "repo:/b" });
		await a.flush();
		await b.flush();
		await a.flush();
		await otherProfile.flush();
		await otherIdentity.flush();
		expect(entries(a).map(c => c.id).sort()).toEqual(["one", "two"]);
		expect(entries(b).map(c => c.id).sort()).toEqual(["one", "two"]);
		expect(entries(otherProfile)).toEqual([]);
		expect(entries(otherIdentity)).toEqual([]);
		expect(JSON.stringify([...cloud.rows.values()])).not.toMatch(/repo:\/|secret|github.com/);
	});
	it("keeps the durable offline backlog beyond upload and view limits, including restart", async () => {
		const cloud = new Cloud(), id = identity(), stateDir = home(), client = cloud.client(id.npub);
		const config = { stateDir, origin: "https://crosshead.sh", ...id, namespace: "default", scope: "codex" };
		const transport = { read: client.readHotSync.bind(client), write: client.writeHotSync.bind(client), reset: client.resetHotSync.bind(client) };
		let replica = new HotSyncReplica(config, transport);
		for (let i = 0; i < 24; i++)
			replica.capture({ ...checkpoint(`record-${i}`), summary: "x".repeat(7000) });
		expect(replica.inspect().pendingCount).toBe(24);
		expect(replica.inspect().local.document.checkpoints.length).toBeLessThanOrEqual(12);
		replica = new HotSyncReplica(config, transport);
		expect(replica.inspect().pendingCount).toBe(24);
		for (let i = 0; i < 24; i++)
			await replica.sync();
		expect(replica.inspect().pendingCount).toBe(0);
		expect(new Set(cloud.accepted).size).toBe(24);
		const timings: number[] = [];
		for (let i = 0; i < 100; i++) {
			const t = performance.now();
			replica.inspect();
			timings.push(performance.now() - t);
		}
		timings.sort((a, b) => a - b);
		expect(timings[94]).toBeLessThan(100);
		console.info(`hot read latency ms p50=${timings[49]!.toFixed(2)} p95=${timings[94]!.toFixed(2)}`);
	});
	it("preserves existing captures on quota/disk failures and rejects modified local signatures", () => {
		const cloud = new Cloud(), id = identity(), stateDir = home(), client = cloud.client(id.npub), config = { stateDir, origin: "https://crosshead.sh", ...id, namespace: "default", scope: "codex" };
		const transport = { read: client.readHotSync.bind(client), write: client.writeHotSync.bind(client), reset: client.resetHotSync.bind(client) };
		const replica = new HotSyncReplica(config, transport);
		replica.capture(checkpoint("safe"));
		const dir = hotSyncTenantDirectory(stateDir, config.origin, id.npub), file = path.join(dir, readdirSync(dir)[0]!);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const blocker = path.join(dir, "f".repeat(64) + ".json");
		writeFileSync(blocker, "");
		truncateSync(blocker, HOT_SYNC_LOCAL_BYTES);
		expect(() => replica.capture(checkpoint("overflow"))).toThrow(/quota/);
		rmSync(blocker);
		expect(replica.inspect().pendingCount).toBe(1);
		const backup = path.join(stateDir, "backup.json");
		writeFileSync(backup, readFileSync(file));
		rmSync(file);
		symlinkSync(backup, file);
		expect(() => replica.capture(checkpoint("disk-error"))).toThrow(/non-regular/);
		rmSync(file);
		writeFileSync(file, readFileSync(backup));
		expect(replica.inspect().pendingCount).toBe(1);
		const record = JSON.parse(readFileSync(file, "utf8"));
		record.pending[0].document.checkpoints[0].summary = "forged";
		writeFileSync(file, JSON.stringify(record));
		expect(() => replica.inspect()).toThrow(/Invalid local/);
	});
	it("withholds both explicitly disputed claims, applies corrections, and keeps inspection available", () => {
		const id = identity(), m = new HotSyncManager({ stateDir: home(), origin: "https://crosshead.sh", ...id, profileName: "default" });
		m.capture("ignored", checkpoint("a"));
		m.capture("ignored", { ...checkpoint("b"), conflictsWith: ["a"] });
		expect(entries(m)).toHaveLength(0);
		expect(entries(m, true)).toHaveLength(2);
		m.capture("ignored", { ...checkpoint("correction"), supersedes: ["a", "b"] });
		expect(entries(m).map(c => c.id)).toEqual(["correction"]);
	});
	it("imports only verified legacy memory once and persists a mixed-version warning", async () => {
		const cloud = new Cloud(), id = identity(), stateDir = home(), config = { stateDir, origin: "https://crosshead.sh", ...id, profileName: "default" };
		let m = new HotSyncManager(config, cloud.client(id.npub));
		m.workspace("repo:/project");
		cloud.legacy = { scopes: [{ scope: "codex", integrity: "failed", content: JSON.stringify({ workspaceId: "repo:/project", runtime: "codex", continuityCheckpoints: [checkpoint("legacy")] }) }] };
		await m.flush();
		expect(entries(m)).toHaveLength(0);
		(cloud.legacy.scopes as any[])[0].integrity = "verified";
		await m.flush();
		expect(entries(m)).toHaveLength(1);
		(cloud.legacy.scopes as any[])[0].content = (cloud.legacy.scopes as any[])[0].content.replace("finding legacy", "older client update");
		await m.flush();
		m = new HotSyncManager(config, cloud.client(id.npub));
		expect(m.status().mixedVersion).toBe(true);
		expect(entries(m)[0]!.summary).toBe("finding legacy");
	});
	it("refuses to render a validly signed checkpoint under the wrong workspace scope",async()=>{
		const cloud=new Cloud(),id=identity(),m=new HotSyncManager({stateDir:home(),origin:"https://crosshead.sh",...id,profileName:"default"},cloud.client(id.npub));
		m.capture("ignored",checkpoint("legitimate"));await m.flush();
		const [key,row]=[...cloud.rows][0]!;
		row.content=signHotSync({...row.content!.document,checkpoints:[{...row.content!.document.checkpoints[0]!,workspaceId:"another-workspace"}]},id.nsec);row.revision++;cloud.rows.set(key,row);
		await m.flush();expect(()=>m.read()).toThrow(/another workspace scope/);
	});

	it("honors Retry-After instead of retrying every worker tick", async () => {
		vi.useFakeTimers();
		try {
			const id = identity(), client = new Cloud().client(id.npub), probe = vi.spyOn(client, "hotSyncCapabilities").mockRejectedValue(new HostedOnlyBotsRequestError({ status: 429, code: "rate_limited", message: "wait", retryAfterMs: 60000 }));
			const m = new HotSyncManager({ stateDir: home(), origin: "https://crosshead.sh", ...id, profileName: "default" }, client);
			await expect(m.flush()).rejects.toThrow();
			m.tick();
			await vi.advanceTimersByTimeAsync(59000);
			m.tick();
			expect(probe).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(2001);
			m.tick();
			await m.stop();
			expect(probe).toHaveBeenCalledTimes(2);
		}
		finally {
			vi.useRealTimers();
		}
	});
	it("delivers the exact finding to Codex, Claude Code, and Pi offline after restart without hosted prompt requests", async () => {
		vi.stubEnv("CROSSHEAD_HOT_SYNC_ENABLED", "true");
		const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
		vi.stubGlobal("fetch", fetcher);
		const stateDir = home(), id = identity();
		const make = () => new RuntimeLifecycleManager({ paths: { state: stateDir }, loadDefaultProfileName: () => "default", loadProfile: () => ({ name: "default", apiBase: "https://crosshead.sh", npub: id.npub, memoryMode: "assist", features: { coldSync: false, autoWarmPromotion: false } }), loadSecret: () => ({ nsec: id.nsec, session: null }), saveSecret: () => { }, loadHealth: () => ({ queueDepth: 0, lastSuccessfulSyncAt: null, lastError: null }), saveHealth: () => { }, loadContinuityGovernorState: () => buildContinuityGovernorState(buildDefaultContinuityPolicy(), []), writeLog: () => { } });
		let m = make();
		await m.handleEvent({ eventId: "capture", runtime: "codex", type: "turn.completed", workspaceId: "repo:/project", payload: { goal: "repair sync", summary: "The queue must fsync before acknowledging capture." } });
		await m.handleEvent({eventId:"acknowledgment",runtime:"codex",type:"session.ended",workspaceId:"repo:/project",payload:{summary:"Codex session ended."}});
		expect(new HotSyncManager({stateDir,origin:"https://crosshead.sh",...id,profileName:"default"}).status().pendingCount).toBe(1);
		await m.stop();
		await stopHotSyncManagers(stateDir);
		m = make();
		for (const runtime of ["codex", "claude-code", "pi"]) {
			const r = await m.handleEvent({ eventId: `read-${runtime}`, runtime, type: "turn.started", workspaceId: "repo:/project", payload: { goal: "continue repair sync" } });
			expect(JSON.stringify(r.contextPack)).toContain("The queue must fsync before acknowledging capture.");
		}
		const suppressed=await m.handleEvent({eventId:"hot-disabled",runtime:"codex",type:"turn.started",workspaceId:"repo:/project",payload:{goal:"continue",allowedScope:{includeHotMemory:false}}});
		expect(JSON.stringify(suppressed.contextPack)).not.toContain("The queue must fsync");
		const elsewhere = await m.handleEvent({ eventId: "other-project", runtime: "codex", type: "turn.started", workspaceId: "repo:/elsewhere", payload: { goal: "continue" } });
		expect(JSON.stringify(elsewhere.contextPack)).not.toContain("The queue must fsync");
		expect(fetcher.mock.calls.some(([url]) => String(url).includes("/context/pack") || String(url).includes("/memory/hot?"))).toBe(false);
		await m.stop();
	});
});
