import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { HotSyncReplica, type HotSyncTransport } from "../../src/runtime/hot-sync-replica";
import { mergeHotSync, signHotSync, verifyHotSync } from "../../src/runtime/hot-sync-signing";
import { HOT_SYNC_VERSION, type HotSyncSnapshot, type HotSyncCheckpoint } from "../../src/protocol/hot-sync";
const key = generateSecretKey(), nsec = nip19.nsecEncode(key), npub = nip19.npubEncode(getPublicKey(key));
const checkpoint = (id: string, summary = id): HotSyncCheckpoint => ({ id, summary, deviceId: id, runtime: "codex", workspaceId: "project", occurredAt: "2026-11-03T00:00:00Z", goal: "work" });
const doc = { version: HOT_SYNC_VERSION, namespace: "default", scope: "codex", epoch: 0, checkpoints: [checkpoint("a")] };
class Server implements HotSyncTransport {
	state: HotSyncSnapshot = { namespace: "default", scope: "codex", epoch: 0, revision: 0, content: null };
	offline = false;
	async read() { if (this.offline)
		throw new Error("offline"); return structuredClone(this.state); }
	async write(base: HotSyncSnapshot, content: NonNullable<HotSyncSnapshot['content']>) { if (this.offline)
		throw new Error("offline"); if (base.epoch !== this.state.epoch || base.revision !== this.state.revision)
		throw new Error("409"); this.state = { ...this.state, revision: this.state.revision + 1, content }; return structuredClone(this.state); }
	async reset() { this.state = { ...this.state, epoch: this.state.epoch + 1, revision: this.state.revision + 1, content: null }; return structuredClone(this.state); }
}
describe("signed hot sync", () => {
	it("binds signer, namespace, scope, epoch and bytes", () => {
		const signed = signHotSync(doc, nsec);
		expect(verifyHotSync(signed, npub, "default", "codex", 0)).toBe(true);
		for (const [ns, scope, epoch] of [["other", "codex", 0], ["default", "pi", 0], ["default", "codex", 1]] as const)
			expect(verifyHotSync(signed, npub, ns, scope, epoch)).toBe(false);
		signed.document.checkpoints[0]!.summary = "tamper";
		expect(verifyHotSync(signed, npub, "default", "codex", 0)).toBe(false);
	});
	it("merges idempotently and retains divergent same-ID findings", () => {
		const a = { ...doc, checkpoints: [checkpoint("a", "one")] }, b = { ...doc, checkpoints: [checkpoint("a", "two")] };
		const merged = mergeHotSync(a, b);
		expect(merged.checkpoints).toHaveLength(2);
		expect(mergeHotSync(b, a)).toEqual(merged);
		expect(mergeHotSync(merged, a)).toEqual(merged);
	});
	it("does not resurrect checkpoints omitted by an acknowledged device watermark", () => {
		const old = { ...doc, seen: { a: 1 }, checkpoints: [{ ...checkpoint("a"), deviceId: "a", sequence: 1 }] };
		const pruned = { ...old, checkpoints: [] };
		expect(mergeHotSync(old, pruned).checkpoints).toEqual([]);
		const fresh = { ...pruned, seen: { a: 2 }, checkpoints: [{ ...checkpoint("b"), deviceId: "a", sequence: 2 }] };
		expect(mergeHotSync(fresh, old).checkpoints.map(c => c.id)).toEqual(["b"]);
	});
	it("preserves capture made while an upload is awaiting acknowledgment", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "xhd-sync-race-")), server = new Server();
		let release!: () => void;
		let started!: () => void;
		const ready = new Promise<void>(resolve => started = resolve), blocked = new Promise<void>(resolve => release = resolve);
		const transport: HotSyncTransport = { read: () => server.read(), reset: () => server.reset(), write: async (b, c) => { started(); await blocked; return server.write(b, c); } };
		const replica = new HotSyncReplica({ stateDir: home, origin: "https://crosshead.sh", npub, nsec, namespace: "default", scope: "codex" }, transport);
		try {
			replica.capture(checkpoint("a"));
			const sync = replica.sync();
			await ready;
			replica.capture(checkpoint("b"));
			release();
			await sync;
			expect(replica.inspect().dirty).toBe(true);
			expect(replica.inspect().local.document.checkpoints.map(c => c.id)).toEqual(["a", "b"]);
		}
		finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
	it("survives offline restart, converges devices, and rejects resurrection after reset", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "xhd-sync-")), server = new Server();
		const make = (device: string) => new HotSyncReplica({ stateDir: path.join(home, device), origin: "https://crosshead.sh", npub, nsec, namespace: "default", scope: "codex" }, server);
		try {
			let a = make("a"), b = make("b");
			server.offline = true;
			a.capture(checkpoint("a"));
			b.capture(checkpoint("b"));
			for (let i = 0; i < 12; i++)
				await expect(a.sync()).rejects.toThrow("offline");
			a = make("a");
			expect(a.inspect().local.document.checkpoints).toHaveLength(1);
			server.offline = false;
			await a.sync();
			await b.sync();
			await a.sync();
			expect(a.inspect().local.document).toEqual(b.inspect().local.document);
			b.capture(checkpoint("offline-old"));
			a.resetLocally();
			await a.sync();
			await b.sync();
			expect(b.inspect().local.document.checkpoints).toEqual([]);
			expect(server.state.content).toBeNull();
		}
		finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
