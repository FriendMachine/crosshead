import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { HotSyncReplica } from "./hot-sync-replica";
import { HostedOnlyBotsClient } from "./hosted-client";
import { hotSyncName, type HotSyncCheckpoint } from "../protocol/hot-sync";
import { writeJsonFile } from "./runtime-persistence";
export const hotSyncEnabled = () => process.env.CROSSHEAD_HOT_SYNC_ENABLED === "true";
type Config = {
	stateDir: string;
	origin: string;
	npub: string;
	nsec: string;
	profileName: string;
};
/** One daemon owns all mutations. Each scope has one in-flight sync. */
export class HotSyncManager {
	readonly namespace: string;
	private readonly replicas = new Map<string, HotSyncReplica>();
	private readonly client: HostedOnlyBotsClient;
	private nextSync = 0;
	private inflight: Promise<void> | null = null;
	readonly deviceId: string;
	constructor(private readonly config: Config) {
		this.namespace = createHmac("sha256", config.nsec).update(`crosshead-profile-v1\n${config.profileName}`).digest("hex");
		this.client = new HostedOnlyBotsClient({ apiBase: config.origin, npub: config.npub, nsec: config.nsec });
		const deviceFile = path.join(config.stateDir, "hot-sync-device.json");
		this.deviceId = existsSync(deviceFile) ? JSON.parse(readFileSync(deviceFile, "utf8")).deviceId : randomUUID();
		if (!existsSync(deviceFile))
			writeJsonFile(deviceFile, { deviceId: this.deviceId });
		const dir = path.join(config.stateDir, "hot-sync");
		if (existsSync(dir))
			for (const name of readdirSync(dir)) {
				if (!/^[a-f0-9]{64}\.json$/.test(name))
					continue;
				const record = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
				if (record.origin === config.origin && record.npub === config.npub && record.local?.document?.namespace === this.namespace)
					this.replica(record.local.document.scope);
			}
	}
	private replica(scope: string): HotSyncReplica {
		if (!hotSyncName(scope))
			throw new Error("Invalid hot-sync scope");
		let replica = this.replicas.get(scope);
		if (!replica) {
			replica = new HotSyncReplica({ ...this.config, namespace: this.namespace, scope }, { read: (n, s) => this.client.readHotSync(n, s), write: (b, c) => this.client.writeHotSync(b, c), reset: b => this.client.resetHotSync(b) });
			this.replicas.set(scope, replica);
		}
		return replica;
	}
	read(scope = "all"): Record<string, unknown> {
		const entries = (scope === "all" ? [...this.replicas.entries()] : [[scope, this.replica(scope)] as const]).map(([name, replica]) => {
			const r = replica.inspect();
			// Unresolved variants stay inspectable but are withheld from automatic context.
			const checkpoints = r.local.document.checkpoints.filter(c => !c.conflictOf);
			return { scope: name, content: JSON.stringify({ workspaceId: checkpoints[0]?.workspaceId, continuityCheckpoints: checkpoints }), integrity: "verified", sync: { pending: r.dirty, lastSuccessfulSyncAt: r.lastSyncedAt, error: r.error, conflicts: r.local.document.checkpoints.filter(c => c.conflictOf).length } };
		});
		return scope === "all" ? { scope, scopes: entries } : entries[0]!;
	}
	capture(scope: string, checkpoint: Omit<HotSyncCheckpoint, "deviceId">): void { this.replica(scope).capture({ ...checkpoint, deviceId: this.deviceId }); this.nextSync = 0; }
	tick(): void {
		if (this.inflight || Date.now() < this.nextSync)
			return;
		this.nextSync = Date.now() + 15000 + Math.random() * 1000;
		this.inflight = this.refresh().catch(() => { }).finally(() => { this.inflight = null; });
	}
	private async refresh(): Promise<void> {
		// Dirty scopes get a chance to upload even if scope discovery fails.
		await Promise.allSettled([...this.replicas.values()].map(r => r.sync()));
		let cursor: string | null = null;
		for (let page = 0; page < 2; page++) {
			const listing = await this.client.listHotSync(this.namespace, cursor);
			if (!Array.isArray(listing.scopes) || listing.scopes.length > 64)
				throw new Error("Invalid scope page");
			for (const item of listing.scopes) {
				if (item.namespace !== this.namespace || !hotSyncName(item.scope))
					throw new Error("Invalid scope entry");
				await this.replica(item.scope).sync();
			}
			cursor = listing.next_cursor;
			if (!cursor)
				break;
		}
	}
}
const managers = new Map<string, HotSyncManager>();
export function getHotSyncManager(config: Config): HotSyncManager {
	const key = JSON.stringify([config.stateDir, config.origin, config.npub, config.profileName]);
	let manager = managers.get(key);
	if (!manager) {
		manager = new HotSyncManager(config);
		managers.set(key, manager);
	}
	return manager;
}
export function tickHotSyncManagers(): void { for (const manager of managers.values())
	manager.tick(); }
