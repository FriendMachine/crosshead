#!/usr/bin/env node
// Real Claude/Codex processes, a deterministic local model, generated identity.
// This proves hook delivery and durability; it does not measure model quality.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const tar = require('tar');
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'crosshead-coding-hosts-')));
const output = path.resolve(process.env.CROSSHEAD_TEST_LOG_DIR ?? '.coding-host-test-logs');
mkdirSync(output, { recursive: true });
const installed = path.join(root, 'installed'), home = path.join(root, 'runtime'), project = path.join(root, 'project');
const claudeHome = path.join(root, 'claude'), codexHome = path.join(root, 'codex');
for (const dir of [installed, home, project, claudeHome, codexHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const nativeClaude = process.env.CROSSHEAD_TEST_CLAUDE_BIN;
const nativeCodex = process.env.CROSSHEAD_TEST_CODEX_BIN;
assert(nativeClaude && nativeCodex, 'Set CROSSHEAD_TEST_CLAUDE_BIN and CROSSHEAD_TEST_CODEX_BIN to the actual pinned host binaries');
// Construct a fresh environment instead of inheriting provider/config credentials.
const env = { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR ?? os.tmpdir(), LANG: 'en_US.UTF-8', HOME: root,
	XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'),
	CROSSHEAD_HOME: home, ONLYBOTS_HOME: home,
	CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_CODE_HOME: claudeHome, CODEX_HOME: codexHome,
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
	ANTHROPIC_API_KEY: 'fixture-only', ANTHROPIC_AUTH_TOKEN: 'fixture-only', FIXTURE_API_KEY: 'fixture-only' };
let stage = 'capture', requests = [], cleanup = async () => {};
const publicInstall=process.env.CROSSHEAD_TEST_INSTALL_SOURCE==='public';
let publishedCli=null;
const marker = 'duration-fixture-8427';
const finding = `Finding ${marker}: serialize durations as decimal nanosecond strings. Zero is valid; negative durations are rejected. Do not convert to floating-point milliseconds. Next validate the transport round trip.`;
const server = createServer(async (req, res) => {
	if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'crosshead-fixture', object: 'model' }] })); return; }
	let raw = ''; for await (const chunk of req) raw += chunk;
	const body = JSON.parse(raw || '{}'); requests.push({ stage, path: req.url, body });
	if (req.url.includes('count_tokens')) { res.setHeader('Content-Type', 'application/json'); res.end('{"input_tokens":200}'); return; }
	const text = stage === 'capture' ? finding : `Continue transport validation. Fixture stage ${stage}.`;
	const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	if (req.url.includes('messages')) {
		const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 200, output_tokens: 60 } };
		if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return; }
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 200, output_tokens: 0 } } });
		emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
		emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
		emit('content_block_stop', { type: 'content_block_stop', index: 0 });
		emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 60 } });
		emit('message_stop', { type: 'message_stop' }); res.end(); return;
	}
	const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
	const response = { id: 'resp_fixture', object: 'response', created_at: 1800000000, model: body.model, status: 'completed', output: [item], usage: { input_tokens: 200, output_tokens: 60, total_tokens: 260 } };
	if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response)); return; }
	res.writeHead(200, { 'Content-Type': 'text/event-stream' });
	let sequence = 0; const responseEvent = (type, data) => emit(type, { type, sequence_number: sequence++, ...data });
	responseEvent('response.created', { response: { ...response, status: 'in_progress', output: [] } });
	responseEvent('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
	responseEvent('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
	responseEvent('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
	responseEvent('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
	responseEvent('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
	responseEvent('response.output_item.done', { output_index: 0, item });
	responseEvent('response.completed', { response }); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
env.ANTHROPIC_BASE_URL = base;
const run = async (name, binary, args, cwd = project) => {
	const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
	let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
	const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
	const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }).finally(() => clearTimeout(timer));
	writeFileSync(path.join(output, `${name}.log`), `${stdout}\nSTDERR:\n${stderr}`);
	assert.equal(code, 0, `${name} exited ${code}; inspect ${output}/${name}.log`); return stdout;
};
const results = { platform: process.platform, checks: [], fixture: true };
let primaryFailure = null;
try {
	const releaseDir = path.resolve(process.argv[2] ?? 'release');
	const manifest = JSON.parse(readFileSync(path.join(releaseDir, 'crosshead-release.json'), 'utf8'));
	const archive = path.join(releaseDir, manifest.artifacts.install.file);
	assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), manifest.artifacts.install.sha256);
	await tar.x({ file: archive, cwd: installed });
	results.hosts = { claude: (await run('claude-version', nativeClaude, ['--version'])).trim(), codex: (await run('codex-version', nativeCodex, ['--version'])).trim() };
	await run('runtime-dependencies', 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], installed);
	if(publicInstall){
		const script=await (await fetch('https://crosshead.sh/install',{signal:AbortSignal.timeout(30000)})).text();
		assert(script.includes(`RELEASE_ID="${manifest.releaseId}"`),'Production installer is not serving this release candidate');
		const publishedScript=path.join(root,'public-install.sh');writeFileSync(publishedScript,script);
		const freshHome=path.join(root,'fresh-public');env.CROSSHEAD_HOME=env.ONLYBOTS_HOME=freshHome;
		await run('public-fresh-install','bash',[publishedScript]);
		const freshCli=path.join(freshHome,'lib/runtime',manifest.releaseId,'dist/runtime/cli.js');
		await run('public-fresh-core',process.execPath,[freshCli,'install','--home',freshHome]);
		const status=JSON.parse(await run('public-fresh-status',process.execPath,[freshCli,'status','--home',freshHome,'--json']));
		assert.equal(status.coreVersion,manifest.version);
		env.CROSSHEAD_HOME=env.ONLYBOTS_HOME=home;
		const originalBaseline=readFileSync(path.resolve('tests/fixtures/published-alpha6-install.sh'),'utf8');
		assert.equal(createHash('sha256').update(originalBaseline).digest('hex'),'b8af3866f720577fed81630769dddae1128cb11cb8973614f11e58b9d10635da');
		// The original public archive alias moves on deploy. Substitute only the
		// immutable GitHub alpha.6 archive URL; retain its original digest check.
		const baseline=path.join(root,'alpha6-immutable-install.sh');
		writeFileSync(baseline,originalBaseline.replace(/^CROSSHEAD_RELEASE_URL=.+$/m,'CROSSHEAD_RELEASE_URL="https://github.com/FriendMachine/crosshead/releases/download/v0.5.0-alpha.6/crosshead-runtime-install-0.5.0-alpha.6.tgz"'));
		await run('published-alpha6-install','bash',[baseline]);
		const match=originalBaseline.match(/^RELEASE_ID="([^"]+)"/m);assert(match);
		const oldCli=path.join(home,'lib/runtime',match[1],'dist/runtime/cli.js');
		await run('published-alpha6-core',process.execPath,[oldCli,'install','--home',home]);
		await run('public-alpha6-to-candidate-update',process.execPath,[oldCli,'update','--home',home,'--base-url','https://crosshead.sh','--sha256',manifest.artifacts.install.sha256,'--no-restart']);
		publishedCli=path.join(home,'lib/runtime',manifest.releaseId,'dist/runtime/cli.js');
		assert.equal(JSON.parse(await run('public-updated-status',process.execPath,[publishedCli,'status','--home',home,'--json'])).coreVersion,manifest.version);
		results.checks.push('actual public installer fresh install', 'alpha.6 installer with immutable archive URL and original digest, updated using independently built candidate digest');
	}
	const fromInstalled = createRequire(path.join(installed, 'package.json'));
	const { generateSecretKey, getPublicKey, nip19 } = fromInstalled('nostr-tools');
	const persistence = fromInstalled('./dist/runtime/runtime-persistence.js');
	const { LocalRuntimeClient } = fromInstalled('./dist/runtime/local-client.js');
	const { stopDetachedRuntimeDaemon } = fromInstalled('./dist/runtime/local-runtime.js');
	cleanup = () => stopDetachedRuntimeDaemon(home);
	const key = generateSecretKey(), now = new Date().toISOString(), paths = persistence.ensureRuntimeHomeLayout(home);
	persistence.saveProfile(paths, { name: 'default', apiBase: 'https://crosshead.invalid', npub: nip19.npubEncode(getPublicKey(key)), memoryMode: 'assist', workspaceScope: 'repo', features: { feedback: false, relay: false, coldSync: false, autoWarmPromotion: false }, secureStoreMode: 'file', createdAt: now, updatedAt: now });
	persistence.saveSecret(paths, 'default', { nsec: nip19.nsecEncode(key), session: null });
	writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ env: { FIXTURE_PRESERVED: 'yes' } }));
	writeFileSync(path.join(codexHome, 'config.toml'), `model = "crosshead-fixture"\nmodel_provider = "crosshead_fixture"\n[model_providers.crosshead_fixture]\nname = "Local deterministic fixture"\nbase_url = "${base}/v1"\nenv_key = "FIXTURE_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
	const cli = publishedCli ?? path.join(installed, 'dist/runtime/cli.js');
	const installClaude = ['install', 'claude-code', '--home', home, '--claude-home', claudeHome, '--claude-bin', nativeClaude, '--workspace-root', project];
	const installCodex = ['install', 'codex', '--home', home, '--codex-home', codexHome, '--codex-bin', nativeCodex];
	await run('install-claude', process.execPath, [cli, ...installClaude]);
	await run('install-codex', process.execPath, [cli, ...installCodex]);
	const client = new LocalRuntimeClient({ home, timeoutMs: 5000 });
	await run('claude-first', path.join(home, 'bin/claude'), ['-p', 'Investigate duration encoding and preserve the boundary decisions.', '--model', 'claude-fixture', '--tools', '', '--output-format', 'json']);
	for (let i = 0; i < 100; i++) {
		if (JSON.stringify(await client.readHotMemory('default', 'all')).includes(marker)) break;
		if (i === 99) throw new Error('Claude final response was not captured');
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert(requests.some(r => r.stage === 'capture' && JSON.stringify(r.body).includes('Crosshead hooks automatically capture')), 'Claude did not load installed hooks');
	results.checks.push('real Claude host loaded installed hooks', 'assistant finding captured durably while hosted service unavailable');
	await cleanup(); stage = 'cross';
	await run('codex-fresh', path.join(home, 'bin/codex'), ['exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '--sandbox', 'read-only', '--json', 'Continue the duration investigation.']);
	assert(requests.some(r => r.stage === 'cross' && JSON.stringify(r.body).includes(marker)), 'Fresh Codex did not receive Claude finding');
	results.checks.push('real fresh Codex receives Claude finding through installed hooks');
	await cleanup(); stage = 'fresh';
	await run('claude-fresh', path.join(home, 'bin/claude'), ['-p', 'Recall the duration encoding boundary decisions.', '--model', 'claude-fixture', '--tools', '', '--output-format', 'json']);
	assert(requests.some(r => r.stage === 'fresh' && JSON.stringify(r.body).includes(marker)), 'Fresh Claude session did not receive prior finding');
	results.checks.push('fresh Claude session after daemon restart recalls finding');
	await run('adapter-reinstall', process.execPath, [cli, ...installClaude]);
	await run('uninstall-claude', process.execPath, [cli, 'uninstall', 'claude-code', '--home', home, '--claude-home', claudeHome]);
	await run('uninstall-codex', process.execPath, [cli, 'uninstall', 'codex', '--home', home, '--codex-home', codexHome]);
	assert.equal(JSON.parse(readFileSync(path.join(claudeHome, 'settings.json'), 'utf8')).env.FIXTURE_PRESERVED, 'yes');
	assert(readFileSync(path.join(codexHome, 'config.toml'), 'utf8').includes('[model_providers.crosshead_fixture]'));
	assert(!JSON.stringify(JSON.parse(readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'))).includes('hook-runtime'));
	results.checks.push('adapter reinstall and uninstall preserve unrelated host settings');
	results.releaseId = manifest.releaseId; results.source = manifest.source;
	writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2) + '\n');
	console.log(JSON.stringify(results));
} catch (error) { primaryFailure = error; throw error; } finally {
	writeFileSync(path.join(output, 'provider-observations.json'), JSON.stringify(requests.map(({stage, path: route, body}) => ({ stage, route, hasFinding: JSON.stringify(body).includes(marker), hasCaptureContract: JSON.stringify(body).includes('Crosshead hooks automatically capture') })), null, 2) + '\n');
	let cleaned = false;
	try { await cleanup(); cleaned = true; }
	catch (error) {
		writeFileSync(path.join(output, 'cleanup-error.log'), `${error.message}\nRetained fixture home: ${root}\n`);
		if (!primaryFailure) throw error;
	} finally {
		await new Promise(resolve => server.close(resolve));
		if (cleaned) rmSync(root, { recursive: true, force: true });
	}
}
