import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { HotSyncReplica, type HotSyncTransport } from "../../src/runtime/hot-sync-replica";
import { HotSyncManager } from "../../src/runtime/hot-sync-manager";
import { signHotSync } from "../../src/runtime/hot-sync-signing";
import { HOT_SYNC_VERSION, type HotSyncCheckpoint, type HotSyncSnapshot, type HotSyncEnvelope } from "../../src/protocol/hot-sync";
import type { HostedOnlyBotsClient } from "../../src/runtime/hosted-client";
import { workspaceHotScope } from "../../src/runtime/workspace-hot-memory";
const secret = generateSecretKey(), identity = { nsec: nip19.nsecEncode(secret), npub: nip19.npubEncode(getPublicKey(secret)) };
const homes: string[] = [];
const home = () => { const h = mkdtempSync(path.join(tmpdir(), "xhd-review-")); homes.push(h); return h; };
afterEach(() => { for (const h of homes.splice(0))
	rmSync(h, { recursive: true, force: true }); });
const cp = (id: string, summary = id): HotSyncCheckpoint => ({ id, summary, deviceId: id, goal: "fix sync", runtime: "codex", workspaceId: "repo:/project", occurredAt: "2026-11-03T00:00:00Z" });
class Cloud {
	rows = new Map<string, HotSyncSnapshot>();
	legacy: Record<string, unknown> = { scopes: [] };
	beforeRead: (() => void) | null = null;
	read = async (namespace: string, scope: string) => { this.beforeRead?.(); return structuredClone(this.rows.get(`${namespace}/${scope}`) ?? { namespace, scope, epoch: 0, revision: 0, content: null }); };
	write = async (base: HotSyncSnapshot, content: HotSyncEnvelope) => {
		const current = await this.read(base.namespace, base.scope);
		if (current.epoch !== base.epoch || current.revision !== base.revision)
			throw new Error("409");
		const next = { ...current, revision: current.revision + 1, content };
		this.rows.set(`${base.namespace}/${base.scope}`, next);
		return structuredClone(next);
	};
	reset = async (base: HotSyncSnapshot) => { const current = await this.read(base.namespace, base.scope); if (current.epoch !== base.epoch || current.revision !== base.revision)
		throw new Error("409"); const next = { ...current, epoch: current.epoch + 1, revision: current.revision + 1, content: null }; this.rows.set(`${base.namespace}/${base.scope}`, next); return next; };
	client(): HostedOnlyBotsClient { return { hotSyncCapabilities: async () => ({ version: 2, enabled: true }), readHotSync: this.read, writeHotSync: this.write, resetHotSync: this.reset, readHotMemory: async () => this.legacy, listHotSync: async (namespace: string) => ({ scopes: [...this.rows.values()].filter(r => r.namespace === namespace).map(r => ({ ...r, content: null })), next_cursor: null }) } as unknown as HostedOnlyBotsClient; }
}
const replica = (stateDir: string, transport: HotSyncTransport) => new HotSyncReplica({ stateDir, origin: "https://crosshead.sh", ...identity, namespace: "default", scope: "codex" }, transport);
const manager = (cloud: Cloud, stateDir = home()) => new HotSyncManager({ stateDir, origin: "https://crosshead.sh", ...identity, profileName: "default" }, cloud.client());
const claims = (m: HotSyncManager, inspect = false) => (m.read("all", inspect).scopes as Array<{
	content: string;
}>).flatMap(e => JSON.parse(e.content).continuityCheckpoints as HotSyncCheckpoint[]);
describe("hot-sync review regressions", () => {
	it.each([false, true])("completes reset before legacy import, including restart=%s, and syncs unrelated scopes", async (restart) => {
		const cloud = new Cloud(), stateDir = home();
		let m = manager(cloud, stateDir);
		const scope = workspaceHotScope("codex", m.workspace("repo:/project"))!;
		cloud.legacy = { scopes: [{ scope: "codex", integrity: "verified", content: JSON.stringify({ runtime: "codex", workspaceId: "repo:/project", continuityCheckpoints: [cp("legacy")] }) }] };
		m.reset(scope);
		m.capture("ignored", { ...cp("unrelated"), workspaceId: "repo:/other" });
		if (restart)
			m = manager(cloud, stateDir);
		await m.flush();
		await m.flush();
		expect((await cloud.read(m.namespace, scope))).toMatchObject({ epoch: 1, content: null });
		expect(claims(m).map(c => c.id)).toEqual(["unrelated"]);
		expect(m.status().pendingCount).toBe(0);
	});
	it("does not import if reset is requested while the legacy scope read is in flight", async () => {
		const cloud = new Cloud(), m = manager(cloud), scope = workspaceHotScope("codex", m.workspace("repo:/project"))!;
		cloud.legacy = { scopes: [{ scope: "codex", integrity: "verified", content: JSON.stringify({ runtime: "codex", workspaceId: "repo:/project", continuityCheckpoints: [cp("legacy")] }) }] };
		cloud.beforeRead = () => { cloud.beforeRead = null; m.reset(scope); };
		await m.flush();
		await m.flush();
		expect(claims(m)).toEqual([]);
		expect((await cloud.read(m.namespace, scope)).epoch).toBe(1);
	});
	it.each([false, true])("preserves divergent pending uploads across recovery, lostAck=%s", async (lostAck) => {
		const cloud = new Cloud(), a = replica(home(), cloud), bHome = home();
		let fail = lostAck;
		const transport: HotSyncTransport = { read: cloud.read, reset: cloud.reset, write: async (base, content) => { const result = await cloud.write(base, content); if (fail) {
				fail = false;
				throw new Error("lost ack");
			} return result; } };
		let b = replica(bHome, transport);
		a.capture({ ...cp("same", "one"), deviceId: "a" });
		b.capture({ ...cp("same", "two"), deviceId: "b" });
		await a.sync();
		if (lostAck) {
			await expect(b.sync()).rejects.toThrow("lost ack");
			b = replica(bHome, transport);
		}
		await b.sync();
		const recovered = replica(home(), cloud);
		await recovered.sync();
		expect(recovered.inspect().local.document.checkpoints.map(c => c.summary).sort()).toEqual(["one", "two"]);
		expect(recovered.inspect().local.document.checkpoints.every(c => c.conflictOf === "same")).toBe(true);
	});
	it("keeps a divergent same-ID capture made during an upload in the outbox", async () => {
		const cloud = new Cloud();
		let release!: () => void, started!: () => void;
		const ready = new Promise<void>(resolve => started = resolve), wait = new Promise<void>(resolve => release = resolve);
		const r = replica(home(), { read: cloud.read, reset: cloud.reset, write: async (b, c) => { started(); await wait; return cloud.write(b, c); } });
		r.capture(cp("same", "first"));
		const upload = r.sync();
		await ready;
		r.capture(cp("same", "second"));
		release();
		await upload;
		expect(r.inspect().pendingCount).toBe(1);
		await r.sync();
		const recovered = replica(home(), cloud);
		await recovered.sync();
		expect(recovered.inspect().local.document.checkpoints.map(c => c.summary).sort()).toEqual(["first", "second"]);
	});
	it("does not acknowledge an oversized conflict group by evicting its other variant", async () => {
		const cloud = new Cloud(), a = replica(home(), cloud), b = replica(home(), cloud);
		a.capture({ ...cp("same", "a".repeat(20000)), deviceId: "a" });
		await a.sync();
		b.capture({ ...cp("same", "b".repeat(20000)), deviceId: "b" });
		await expect(b.sync()).rejects.toThrow(/conflict group exceeds/);
		expect(b.inspect().pendingCount).toBe(1);
		expect(b.inspect().local.document.checkpoints.every(c => c.conflictOf === "same")).toBe(true);
		expect((await cloud.read("default", "codex")).content!.document.checkpoints[0]!.summary).toBe("a".repeat(20000));
	});
	it.each(["conflictsWith", "supersedes"] as const)("keeps %s targets withheld after the declaring checkpoint is pruned and after recovery", async (relation) => {
		const cloud = new Cloud(), stateDir = home();
		let m = manager(cloud, stateDir);
		m.capture("ignored", { ...cp("target"), occurredAt: "2026-11-03T01:00:00Z" });
		await m.flush();
		m.capture("ignored", { ...cp("declaration", relation === "supersedes" ? "x".repeat(25000) : "declaration"), [relation]: ["target"] });
		await m.flush();
		for (let i = 0; i < (relation === "supersedes" ? 10 : 12); i++) {
			m.capture("ignored", { ...cp(`later-${i}`, relation === "supersedes" ? "x".repeat(1000) : `later-${i}`), occurredAt: `2026-11-03T00:01:${String(i).padStart(2, "0")}Z` });
			await m.flush();
		}
		m = manager(cloud, stateDir);
		const fresh = manager(cloud);
		fresh.workspace("repo:/project");
		await fresh.flush();
		for (const view of [m, fresh]) {
			expect(claims(view, true).some(c => c.id === "target")).toBe(true);
			expect(claims(view, true).some(c => c.id === "declaration")).toBe(false);
			expect(claims(view).some(c => c.id === "target")).toBe(false);
		}
	});
	it("withholds targets referenced by an already-divergent declaration",async()=>{
		const cloud=new Cloud(),m=manager(cloud),workspaceId=m.workspace("repo:/project"),scope=workspaceHotScope("codex",workspaceId)!;
		const document={version:HOT_SYNC_VERSION,namespace:m.namespace,scope,epoch:0,checkpoints:[{...cp("target"),workspaceId},{...cp("variant:declaration"),workspaceId,conflictOf:"declaration",conflictsWith:["target"]}]};
		cloud.rows.set(`${m.namespace}/${scope}`,{namespace:m.namespace,scope,epoch:0,revision:1,content:signHotSync(document,identity.nsec)});
		await m.flush();expect(claims(m,true)).toHaveLength(2);expect(claims(m)).toEqual([]);
	});

	it("retires device watermarks without resurrecting acknowledged history from stale devices", async () => {
		const cloud = new Cloud();
		const old = cp("old");
		const seen = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`device-${i}`, 1]));
		const content = signHotSync({ version: HOT_SYNC_VERSION, namespace: "default", scope: "codex", epoch: 0, seen, checkpoints: [{ ...old, deviceId: "device-0", sequence: 1 }] }, identity.nsec);
		cloud.rows.set("default/codex", { namespace: "default", scope: "codex", epoch: 0, revision: 1, content });
		const stale = replica(home(), cloud);
		await stale.sync();
		cloud.rows.set("default/codex", { ...cloud.rows.get("default/codex")!, revision: cloud.rows.get("default/codex")!.revision + 1, content });
		expect(Object.keys(cloud.rows.get("default/codex")!.content!.document.seen!)).toHaveLength(128);
		const fresh = replica(home(), cloud);
		fresh.capture({ ...cp("fresh"), deviceId: "device-129" });
		await fresh.sync();
		for (let i = 0; i < 20; i++) {
			const device = replica(home(), cloud);
			device.capture({ ...cp(`new-${i}`), occurredAt: "2026-11-03T01:00:00Z", deviceId: `device-${130 + i}` });
			await device.sync();
		}
		await stale.sync();
		expect(stale.inspect().local.document.checkpoints.some(c => c.id === "old")).toBe(false);
		stale.capture({ ...cp("returning"), deviceId: "device-0" });
		await stale.sync();
		const recovered = replica(home(), cloud);
		await recovered.sync();
		const doc = recovered.inspect().local.document;
		expect(doc.checkpoints.some(c => c.id === "returning")).toBe(true);
		expect(doc.checkpoints.some(c => c.id === "old")).toBe(false);
		expect(Object.keys(doc.seen ?? {}).length).toBeLessThanOrEqual(12);
	});
});
