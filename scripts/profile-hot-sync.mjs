#!/usr/bin/env node
// Bounded workload using the shipped manager, disposable identities and synthetic findings.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const { generateSecretKey, getPublicKey, nip19 } = require('nostr-tools');
const { HotSyncManager } = require('../dist/runtime/hot-sync-manager.js');
const { HostedOnlyBotsClient } = require('../dist/runtime/hosted-client.js');
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const origin = new URL(option('--base-url', 'https://crosshead.sh')).origin;
if (!process.argv.includes('--allow-production') && !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Remote profiling requires --allow-production');
const count = Number(option('--clients', '6')), seconds = Number(option('--seconds', '65')), captureMs = Number(option('--capture-ms', '3000'));
if (!Number.isSafeInteger(count) || count < 1 || count > 10 || seconds < 10 || seconds > 180 || captureMs < 1500) throw new Error('Budget: 1–10 clients, 10–180 seconds, captures at least 1500 ms apart');
const root = mkdtempSync(path.join(os.tmpdir(), 'crosshead-sync-profile-'));
const clients = [], managers = [], observations = [], captureLatencies = [];
const originalFetch = globalThis.fetch;
let abort = null, phase = 'workload';
globalThis.fetch = async (...args) => {
	const started = performance.now();
	const response = await originalFetch(...args);
	const route = new URL(String(args[0])).pathname;
	observations.push({ phase, route, method: args[1]?.method ?? 'GET', status: response.status, ms: performance.now() - started });
	if (phase === 'workload' && (response.status === 429 || response.status >= 500)) abort ??= { route, status: response.status, retryAfter: response.headers.get('retry-after') };
	return response;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quantile = (a, q) => [...a].sort((x,y) => x-y)[Math.max(0, Math.ceil(a.length*q)-1)] ?? 0;
const summary = { origin, clients: count, seconds, captureMs, startedAt: new Date().toISOString(), synthetic: true, npubs: [], cleanup: [] };
try {
	for (let i = 0; i < count; i++) {
		const key = generateSecretKey(), identity = { nsec: nip19.nsecEncode(key), npub: nip19.npubEncode(getPublicKey(key)) };
		const client = new HostedOnlyBotsClient({ apiBase: origin, ...identity });
		summary.npubs.push(identity.npub);
		clients.push(client); managers.push(new HotSyncManager({ stateDir: path.join(root, String(i)), origin, ...identity, profileName: 'launch-capacity-fixture' }, client));
	}
	const start = performance.now(); let nextCapture = 0, event = 0;
	while (!abort && performance.now() - start < seconds*1000) {
		if (performance.now() - start >= nextCapture) {
			for (const [i, manager] of managers.entries()) {
				const before = performance.now();
				manager.capture('codex', { id: `capacity-${i}-${event}`, runtime: 'codex', workspaceId: 'repo:/synthetic-crosshead-capacity', occurredAt: new Date().toISOString(), goal: 'Synthetic launch sync verification', summary: `Synthetic capture ${event}; no customer content.` });
				captureLatencies.push(performance.now()-before);
			}
			event++; nextCapture += captureMs;
		}
		for (const manager of managers) manager.tick();
		await sleep(100);
	}
	summary.elapsedSeconds = Number(((performance.now()-start)/1000).toFixed(2));
	summary.abort = abort;
	summary.captures = captureLatencies.length;
	summary.captureP95Ms = Number(quantile(captureLatencies,.95).toFixed(2));
	summary.devices = managers.map(m => { const s = m.status(); return { state: s.state, pending: s.pendingCount, error: s.error }; });
} finally {
	phase = 'cleanup';
	for (const [device,result] of (await Promise.allSettled(managers.map(m => m.stop()))).entries()) if(result.status === "rejected") summary.cleanup.push({device,stopFailed:true});
	for (const [i, manager] of managers.entries()) {
		const client = clients[i];
		for (const {scope} of manager.status().scopes) {
			try { const base = await client.readHotSync(manager.namespace, scope); await client.resetHotSync(base); summary.cleanup.push({ device: i, scopeCleared: true }); }
			catch (error) { summary.cleanup.push({ device: i, scopeCleared: false, status: error.status, code: error.code }); }
		}
		const session = client.session();
		if (session) {
			try { const revoked = await originalFetch(`${origin}/v1/auth/revoke`, { method: 'POST', headers: { authorization: `Bearer ${session.sessionToken}` }, signal: AbortSignal.timeout(10000) });
			const result = await revoked.json();
			summary.cleanup.push({device:i,sessionRevoked:revoked.ok && result.revoked === true,status:revoked.status});
            } catch { summary.cleanup.push({device:i,sessionRevoked:false}); }
		}
	}
	summary.requests = Object.values(observations.reduce((all, x) => { const key = `${x.phase} ${x.method} ${x.route}`; const row = all[key] ??= { route: key, count: 0, statuses: {}, latencies: [] }; row.count++; row.statuses[x.status] = (row.statuses[x.status] ?? 0)+1; row.latencies.push(x.ms); return all; }, {})).map(({latencies, ...row}) => ({ ...row, p95Ms: Math.round(quantile(latencies,.95)) }));
	summary.finishedAt = new Date().toISOString();
	globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true });
	console.log(JSON.stringify(summary, null, 2));
}
if (summary.abort || summary.cleanup.some(x => x.scopeCleared === false || x.sessionRevoked === false || x.stopFailed)) process.exitCode = 2;
