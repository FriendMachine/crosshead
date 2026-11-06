// Run inside a disposable container with the real Claude Code and Codex CLIs on
// PATH, this repository read-only at /crosshead (with node_modules and a local
// `npm run release:build` in release/), and a writable /test. No credentials:
// a local fixture stands in for the Anthropic and OpenAI APIs and for the
// crosshead.sh installer and release download. Hosted Crosshead calls go to an
// unreachable local address; nothing reaches a production service.
//
// Proves: plugins install from this repository's marketplace files; the
// plugins validate; without a runtime SessionStart prints one setup line and
// exits 0; the setup skill's commands connect the runtime without writing
// legacy hooks; with a legacy install present each event is captured exactly
// once before and after migration; uninstalling the plugins leaves no hooks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { generateSecretKey, getPublicKey, nip19 } = require("nostr-tools");
const persistence = require("/crosshead/dist/runtime/runtime-persistence.js");
const spec = require("/crosshead/dist/runtime/host-hook-spec.js");

const repo = "/crosshead";
const root = process.env.CROSSHEAD_SMOKE_ROOT ?? "/test";
const logDir = path.join(root, "logs");
mkdirSync(logDir, { recursive: true });
const results = { checks: [], notExercised: [] };
const check = (label) => {
	results.checks.push(label);
	console.log(`ok - ${label}`);
};

// ---- Fixture: model APIs, installer and release download -----------------
const requests = [];
const replyText = "Fixture reply: findings recorded, next step is the transport round-trip check.";
const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
const tarball = readFileSync(path.join(repo, "release", `crosshead-runtime-install-${pkg.version}.tgz`));
const tarballSha = createHash("sha256").update(tarball).digest("hex");
const sse = (res, events) => {
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	res.end();
};
let installerScript = "";
const server = createServer(async (req, res) => {
	let raw = "";
	for await (const chunk of req) raw += chunk;
	requests.push({ url: req.url, body: raw });
	appendFileSync(path.join(logDir, "fixture-requests.log"), `${req.method} ${req.url} ${raw.length}\n`);
	if (req.url === "/install") return res.end(installerScript);
	if (req.url === "/install/releases/crosshead-runtime.tgz") return res.end(tarball);
	let body = {};
	try { body = JSON.parse(raw); } catch {}
	if (req.url.startsWith("/v1/messages/count_tokens")) return res.end(JSON.stringify({ input_tokens: 10 }));
	if (req.url.startsWith("/v1/messages")) {
		const message = { id: "msg_fixture", type: "message", role: "assistant", model: body.model ?? "fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
		if (!body.stream) return res.end(JSON.stringify({ ...message, content: [{ type: "text", text: replyText }], stop_reason: "end_turn" }));
		return sse(res, [
			["message_start", { type: "message_start", message }],
			["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
			["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: replyText } }],
			["content_block_stop", { type: "content_block_stop", index: 0 }],
			["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }],
			["message_stop", { type: "message_stop" }],
		]);
	}
	if (req.url.startsWith("/v1/responses")) {
		const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: replyText, annotations: [] }] };
		const response = { id: "resp_fixture", object: "response", created_at: 1_800_000_000, status: "in_progress", model: body.model ?? "fixture", output: [] };
		return sse(res, [
			["response.created", { type: "response.created", response }],
			["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }],
			["response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: replyText }],
			["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
			["response.completed", { type: "response.completed", response: { ...response, status: "completed", output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } }],
		]);
	}
	res.writeHead(404);
	res.end("{}");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
// The digest-checked installer from this repository, pointed at the local release.
installerScript = readFileSync(path.join(repo, "docs", "security-review", "install.sh"), "utf8")
	.replace(/^BASE_URL=.*$/m, `BASE_URL="${base}"`)
	.replace(/^RELEASE_ID=.*$/m, `RELEASE_ID="${pkg.version}-${tarballSha.slice(0, 12)}"`)
	.replace(/^RELEASE_URL=.*$/m, `RELEASE_URL="${base}/install/releases/onlybots-runtime.tgz"`)
	.replace(/^CROSSHEAD_RELEASE_URL=.*$/m, `CROSSHEAD_RELEASE_URL="${base}/install/releases/crosshead-runtime.tgz"`)
	.replace(/^RELEASE_SHA256=.*$/m, `RELEASE_SHA256="${tarballSha}"`);

// ---- Process helpers -------------------------------------------------------
const homeEnv = (home) => ({
	// ~/.crosshead/bin stays off PATH: its claude/codex launchers check crosshead.sh for updates.
	PATH: process.env.PATH,
	HOME: home,
	LANG: "C.UTF-8",
	CROSSHEAD_HOT_SYNC_ENABLED: "false",
	ANTHROPIC_BASE_URL: base,
	ANTHROPIC_API_KEY: "fixture-not-a-real-key",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	DISABLE_AUTOUPDATER: "1",
	FIXTURE_API_KEY: "fixture-only",
	DO_NOT_TRACK: "1",
});
let logIndex = 0;
const run = async (label, home, command, args, { cwd = home, input = "", allowFailure = false, env = {} } = {}) => {
	const child = spawn(command, args, { cwd, env: { ...homeEnv(home), ...env }, stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.stdin.end(input);
	const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
	const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearTimeout(timer));
	const file = path.join(logDir, `${String(++logIndex).padStart(2, "0")}-${label}.log`);
	writeFileSync(file, `$ ${command} ${args.join(" ")}\nexit=${code}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`);
	if (!allowFailure) assert.equal(code, 0, `${label} exited ${code}; see ${file}`);
	return { code, stdout, stderr, file };
};

const makeHome = (name) => {
	const home = path.join(root, name);
	const project = path.join(home, "project");
	mkdirSync(project, { recursive: true });
	// The Claude CLI's project-trust prompt is skipped in -p mode; record onboarding as done.
	writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [project]: { hasTrustDialogAccepted: true } } }));
	mkdirSync(path.join(home, ".codex"), { recursive: true });
	writeFileSync(
		path.join(home, ".codex", "config.toml"),
		`model = "fixture-model"\nmodel_provider = "fixture"\n\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "${base}/v1"\nwire_api = "responses"\nenv_key = "FIXTURE_API_KEY"\n`
	);
	return { home, project };
};

const addMarketplaces = async (home) => {
	await run("claude-marketplace-add", home, "claude", ["plugin", "marketplace", "add", repo]);
	await run("claude-plugin-install", home, "claude", ["plugin", "install", "crosshead@crosshead"]);
	await run("codex-marketplace-add", home, "codex", ["plugin", "marketplace", "add", repo]);
	await run("codex-plugin-add", home, "codex", ["plugin", "add", "crosshead@crosshead"]);
	const list = await run("codex-plugin-list", home, "codex", ["plugin", "list"]);
	assert.match(list.stdout, /\.agents\/plugins\/marketplace\.json/);
	assert.match(list.stdout, /crosshead@crosshead\s+installed.*\/crosshead\/plugins\/codex/);
	const claudeList = JSON.parse((await run("claude-plugin-list", home, "claude", ["plugin", "list", "--json"])).stdout);
	assert(claudeList.some((entry) => entry.id === "crosshead@crosshead" && entry.enabled === true), "Claude plugin not enabled");
};

const seedProfile = (home) => {
	// Stands in for `quickstart` identity creation, which registers with the hosted service.
	const paths = persistence.ensureRuntimeHomeLayout(path.join(home, ".crosshead"));
	if (persistence.loadProfile(paths, "default")) return;
	const key = generateSecretKey();
	const now = new Date().toISOString();
	persistence.saveProfile(paths, {
		name: "default", apiBase: "http://127.0.0.1:9", npub: nip19.npubEncode(getPublicKey(key)), memoryMode: "assist", workspaceScope: "repo",
		features: { feedback: false, relay: false, coldSync: false, autoWarmPromotion: false }, secureStoreMode: "file", createdAt: now, updatedAt: now,
	});
	persistence.saveSecret(paths, "default", { nsec: nip19.nsecEncode(key), session: null });
	persistence.saveRuntimeConfig(paths, { ...persistence.loadRuntimeConfig(paths), defaultProfile: "default" });
};

const installRuntime = async (home) => {
	await run("installer", home, "bash", ["-c", `curl -fsSL ${base}/install | bash`]);
	assert(existsSync(path.join(home, ".crosshead", "bin", "crosshead")));
	await run("update-pin", home, xhd(home), ["update", "--pin"]);
	seedProfile(home);
};

const xhd = (home) => path.join(home, ".crosshead", "bin", "crosshead");
const lifecycle = (home) => {
	const file = path.join(home, ".crosshead", "state", "lifecycle-events.jsonl");
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const eventCounts = (events, sessionId) => {
	const counts = {};
	for (const event of events) if (!sessionId || event.sessionId === sessionId) counts[event.type] = (counts[event.type] ?? 0) + 1;
	return counts;
};

// One real headless session per host. Returns the host's session id and its hook-run log.
const claudeSession = async (label, home, project) => {
	const debugFile = path.join(logDir, `claude-debug-${label}.txt`);
	const result = await run(`claude-session-${label}`, home, "claude", ["-p", "Investigate the duration serializer and report findings.", "--output-format", "json", "--debug-file", debugFile], { cwd: project });
	const sessionId = JSON.parse(result.stdout.trim().split("\n").at(-1)).session_id;
	const hookRuns = readFileSync(debugFile, "utf8").split("\n").filter((line) => /Hooks: \S+ \[.*\] .*finished with status/.test(line));
	return { sessionId, hookRuns, result };
};
const codexSession = async (label, home, project) => {
	// The human-readable output lists each hook run ("hook: Stop Completed"); --json omits them.
	const result = await run(`codex-session-${label}`, home, "codex", ["exec", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "Investigate the duration serializer and report findings."], { cwd: project });
	const output = `${result.stdout}\n${result.stderr}`;
	const sessionId = /^session id: (\S+)/m.exec(output)?.[1] ?? null;
	const hookRuns = output.split("\n").map((line) => line.trim()).filter((line) => /^hook: \S+ Completed/.test(line));
	return { sessionId, hookRuns, result };
};
const waitFor = async (predicate, label) => {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.fail(`timed out waiting for ${label}`);
};
// Session ids are redacted in the lifecycle log, so each session is measured as the
// change in event counts it causes. Sessions run one at a time.
const baselines = {};
const measuredSession = async (home, host, label, runSession) => {
	const before = eventCounts(lifecycle(home));
	const session = await runSession();
	await waitFor(() => (eventCounts(lifecycle(home))["turn.completed"] ?? 0) > (before["turn.completed"] ?? 0), `${host} ${label} capture`);
	await new Promise((resolve) => setTimeout(resolve, 1500)); // let any duplicate land before counting
	const after = eventCounts(lifecycle(home));
	const delta = Object.fromEntries(Object.keys(after).map((type) => [type, after[type] - (before[type] ?? 0)]).filter(([, count]) => count > 0));
	assert.equal(delta["turn.completed"], 1, `${host} ${label}: ${JSON.stringify(delta)}`);
	if (baselines[host]) assert.deepEqual(delta, baselines[host], `${host} ${label}: events differ from the single-registration baseline`);
	else baselines[host] = delta;
	results[`${host}:${label}`] = { lifecycleDelta: delta, hookRuns: session.hookRuns.length };
	return session;
};
const crossheadHookLines = (session) => session.hookRuns.filter((line) => /crosshead/.test(line) || /^hook:/.test(line.trim()));
const doctor = async (home, project) => JSON.parse((await run("doctor", home, xhd(home), ["doctor", "--json", "--workspace-root", project], { cwd: project, allowFailure: true })).stdout);
const doctorCheck = (report, id) => report.checks.find((entry) => entry.id === id);

const pluginHookCommand = (home, host, event) => {
	const hooksFile = host === "codex"
		? path.join(home, ".codex", "plugins", "cache", "crosshead", "crosshead", spec.CROSSHEAD_HOST_PLUGIN_VERSION, "hooks", "hooks.json")
		: path.join(repo, "plugins", "claude-code", "hooks", "hooks.json");
	return JSON.parse(readFileSync(hooksFile, "utf8")).hooks[event][0].hooks[0].command;
};
const pluginRoot = (home, host) =>
	host === "codex" ? path.join(home, ".codex", "plugins", "cache", "crosshead", "crosshead", spec.CROSSHEAD_HOST_PLUGIN_VERSION) : path.join(repo, "plugins", "claude-code");
// Runs the exact command a host would, with the plugin-root variables the host sets.
const runPluginHook = (label, home, project, host, event, payload) =>
	run(`hook-${host}-${event}-${label}`, home, "sh", ["-c", pluginHookCommand(home, host, event)], {
		cwd: project,
		input: JSON.stringify({ cwd: project, hook_event_name: event, ...payload }),
		env: host === "codex" ? { PLUGIN_ROOT: pluginRoot(home, host), CLAUDE_PLUGIN_ROOT: pluginRoot(home, host) } : { CLAUDE_PLUGIN_ROOT: pluginRoot(home, host) },
	});

const scanForCrossheadHooks = (home, project) => {
	const files = [
		path.join(home, ".claude", "settings.json"),
		path.join(project, ".claude", "settings.json"),
		path.join(project, ".claude", "settings.local.json"),
		path.join(home, ".codex", "hooks.json"),
		path.join(home, ".codex", "config.toml"),
	];
	const hits = files.filter((file) => existsSync(file) && /crosshead-(claude-code-|codex-)?hook|crosshead@crosshead/.test(readFileSync(file, "utf8")));
	return hits;
};

try {
	await run("claude-version", root, "claude", ["--version"]);
	await run("codex-version", root, "codex", ["--version"]);
	for (const target of [repo, path.join(repo, "plugins", "claude-code")]) {
		await run("validate", root, "claude", ["plugin", "validate", target, "--strict"]);
	}
	check("claude plugin validate --strict passes for the marketplace and the Claude Code plugin");

	// ---- B1: existing legacy install, no plugins: single-registration baseline ---
	const b = makeHome("legacy");
	await installRuntime(b.home);
	await run("legacy-install-claude", b.home, xhd(b.home), ["install", "claude-code", "--workspace-root", b.project], { cwd: b.project });
	await run("legacy-install-codex", b.home, xhd(b.home), ["install", "codex"], { cwd: b.project });
	const claudeLegacy = await measuredSession(b.home, "claude-code", "legacy only", () => claudeSession("legacy-only", b.home, b.project));
	assert.equal(crossheadHookLines(claudeLegacy).length, 3);
	const codexLegacy = await measuredSession(b.home, "codex", "legacy only", () => codexSession("legacy-only", b.home, b.project));
	assert.equal(codexLegacy.hookRuns.length, 3);
	check("legacy settings-mode install: 3 hook runs and one capture per session in each host (baseline)");

	// ---- A: new user. Plugins first, no runtime --------------------------------
	const a = makeHome("fresh");
	await addMarketplaces(a.home);
	check("both plugins install from the repository marketplace (Codex reads .agents/plugins/marketplace.json)");
	for (const host of ["claude-code", "codex"]) {
		const start = await runPluginHook("no-runtime", a.home, a.project, host, "SessionStart", { session_id: "no-runtime", source: "startup" });
		assert.equal(start.stdout.trim().split("\n").length, 1);
		assert.equal(JSON.parse(start.stdout).systemMessage, spec.pluginSetupHint(host));
		for (const event of ["UserPromptSubmit", "Stop", "PreCompact", "PostCompact"]) {
			const other = await runPluginHook("no-runtime", a.home, a.project, host, event, { session_id: "no-runtime", prompt: "x" });
			assert.equal(other.stdout, "");
		}
	}
	const claudeFresh = await claudeSession("no-runtime", a.home, a.project);
	assert.equal(crossheadHookLines(claudeFresh).length, 3, claudeFresh.hookRuns.join("\n"));
	assert(claudeFresh.hookRuns.every((line) => line.includes("status 0")));
	assert(requests.some((request) => request.url.startsWith("/v1/messages") && request.body.includes(spec.pluginSetupHint("claude-code"))), "Claude setup hint did not reach model context");
	const codexFresh = await codexSession("no-runtime", a.home, a.project);
	assert(requests.some((request) => request.url.startsWith("/v1/responses") && request.body.includes(JSON.stringify(spec.pluginSetupHint("codex")).slice(1, -1))), "Codex setup hint did not reach model context");
	assert.deepEqual(codexFresh.hookRuns.map((line) => line.trim()), ["hook: SessionStart Completed", "hook: UserPromptSubmit Completed", "hook: Stop Completed"]);
	assert(!existsSync(path.join(a.home, ".crosshead")), "a plugin hook created runtime state");
	check("without a runtime, SessionStart prints one setup line, every hook exits 0, real sessions complete and nothing is installed");

	// The setup skill's commands, after consent: digest-checked installer, then quickstart in plugin mode.
	await installRuntime(a.home);
	for (const adapter of ["claude-code", "codex"]) {
		const quick = await run(`quickstart-${adapter}`, a.home, xhd(a.home), ["quickstart", "--api-base", "http://127.0.0.1:9", "--adapter", adapter, "--workspace-root", ".", "--hook-mode", "plugin"], { cwd: a.project });
		assert.match(quick.stdout, /hook_mode: plugin/);
	}
	assert(!existsSync(path.join(a.project, ".claude", "settings.json")), "quickstart wrote Claude Code settings hooks");
	assert(!existsSync(path.join(a.home, ".codex", "hooks.json")), "quickstart wrote Codex hooks.json");
	const claudeA = await measuredSession(a.home, "claude-code", "after setup", () => claudeSession("setup-done", a.home, a.project));
	assert.equal(crossheadHookLines(claudeA).length, 3);
	const codexA = await measuredSession(a.home, "codex", "after setup", () => codexSession("setup-done", a.home, a.project));
	assert.equal(codexA.hookRuns.length, 3);
	for (const id of ["claude_code_hooks", "codex_hooks"]) assert.match(doctorCheck(await doctor(a.home, a.project), id).message, /^mode=plugin; plugin enabled/);
	check("setup (installer + quickstart --hook-mode plugin) writes no host hooks; one capture per event in both hosts; doctor reports plugin mode");

	// ---- B2: plugins added to the legacy install, then migration -------------
	await addMarketplaces(b.home);
	const claudeDup = await measuredSession(b.home, "claude-code", "legacy + plugin", () => claudeSession("legacy-plus-plugin", b.home, b.project));
	assert.equal(claudeDup.hookRuns.filter((line) => /crosshead/.test(line)).length, 6, "expected both registrations to run");
	const codexDup = await measuredSession(b.home, "codex", "legacy + plugin", () => codexSession("legacy-plus-plugin", b.home, b.project));
	assert.equal(codexDup.hookRuns.length, 6, codexDup.hookRuns.join("\n"));
	const before = await doctor(b.home, b.project);
	for (const id of ["claude_code_hooks", "codex_hooks"]) assert.match(doctorCheck(before, id).message, /Duplicate registration/);
	check("legacy + plugin before migration: both registrations run, exactly one captures, doctor flags the duplicate");

	for (const adapter of ["claude-code", "codex"]) {
		const migrated = await run(`migrate-${adapter}`, b.home, xhd(b.home), ["install", adapter, "--workspace-root", b.project], { cwd: b.project });
		assert.match(migrated.stdout, /hook_mode: plugin/);
		assert.match(migrated.stdout, /migrated_legacy_hooks: /);
		const again = await run(`migrate-again-${adapter}`, b.home, xhd(b.home), ["install", adapter, "--workspace-root", b.project], { cwd: b.project });
		assert.doesNotMatch(again.stdout, /migrated_legacy_hooks/);
	}
	const claudeMigrated = await measuredSession(b.home, "claude-code", "after migration", () => claudeSession("migrated", b.home, b.project));
	assert.equal(claudeMigrated.hookRuns.filter((line) => /crosshead/.test(line)).length, 3);
	assert(claudeMigrated.hookRuns.every((line) => line.includes("plugin crosshead@crosshead")), "a legacy hook still ran");
	const codexMigrated = await measuredSession(b.home, "codex", "after migration", () => codexSession("migrated", b.home, b.project));
	assert.equal(codexMigrated.hookRuns.length, 3);
	for (const host of ["claude-code", "codex"]) {
		const before = eventCounts(lifecycle(b.home));
		for (const event of ["PreCompact", "PostCompact"]) {
			await runPluginHook("migrated", b.home, b.project, host, event, { session_id: `direct-compact-${host}`, trigger: "manual" });
		}
		await waitFor(() => (eventCounts(lifecycle(b.home))["compact.completed"] ?? 0) > (before["compact.completed"] ?? 0), `${host} compact events`);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const after = eventCounts(lifecycle(b.home));
		for (const type of ["compact.started", "compact.completed"]) assert.equal(after[type] - (before[type] ?? 0), 1, `${host} ${type}`);
	}
	const after = await doctor(b.home, b.project);
	for (const id of ["claude_code_hooks", "codex_hooks"]) assert.match(doctorCheck(after, id).message, /^mode=plugin; plugin enabled.*no legacy hooks\.$/);
	check("migration is idempotent; afterwards only the plugin hooks run, one capture per event (PreCompact/PostCompact driven directly), doctor ok");

	// ---- Uninstall the plugins ----------------------------------------------
	await run("claude-plugin-uninstall", b.home, "claude", ["plugin", "uninstall", "crosshead@crosshead"]);
	await run("codex-plugin-remove", b.home, "codex", ["plugin", "remove", "crosshead@crosshead"]);
	const leftovers = scanForCrossheadHooks(b.home, b.project);
	// Hosts may keep an inactive copy of an uninstalled plugin for garbage collection; record it.
	const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])) : []);
	results.inactivePluginCacheAfterUninstall = [path.join(b.home, ".claude", "plugins", "cache", "crosshead"), path.join(b.home, ".codex", "plugins", "cache", "crosshead")].flatMap(walk);
	assert.deepEqual(leftovers, [], `orphaned Crosshead hook registrations: ${leftovers.join(", ")}`);
	const eventsBefore = lifecycle(b.home).length;
	const claudeAfter = await claudeSession("uninstalled", b.home, b.project);
	assert.equal(claudeAfter.hookRuns.filter((line) => /crosshead/.test(line)).length, 0);
	const codexAfter = await codexSession("uninstalled", b.home, b.project);
	assert.equal(codexAfter.hookRuns.length, 0);
	assert.equal(lifecycle(b.home).length, eventsBefore, "a hook ran after the plugins were uninstalled");
	const removed = await doctor(b.home, b.project);
	for (const id of ["claude_code_hooks", "codex_hooks"]) assert.match(doctorCheck(removed, id).message, /No Crosshead hooks are active/);
	check("uninstalling the plugins leaves no Crosshead hooks in any host config; sessions run no Crosshead hook; doctor reports it");

	results.notExercised.push(
		"interactive /crosshead:setup and Codex skill invocation by a model (the skill's commands were run directly)",
		"Codex hook trust review (/hooks); runs used --dangerously-bypass-hook-trust",
		"identity registration with the hosted service (profile seeded locally; hosted API unreachable by design)",
		"native compaction (PreCompact/PostCompact were driven with representative payloads)",
		"downloading the installer from crosshead.sh and its production digest (a local rendering of docs/security-review/install.sh served the local release)"
	);
	results.ok = true;
} catch (error) {
	results.ok = false;
	results.error = error instanceof Error ? error.stack : String(error);
	process.exitCode = 1;
} finally {
	writeFileSync(path.join(root, "host-plugins-result.json"), JSON.stringify(results, null, 2));
	for (const home of [path.join(root, "fresh"), path.join(root, "legacy")]) {
		if (existsSync(path.join(home, ".crosshead", "bin", "crosshead"))) {
			spawnSync(path.join(home, ".crosshead", "bin", "crosshead"), ["stop"], { env: homeEnv(home), stdio: "ignore", timeout: 20_000 });
		}
	}
	server.close();
	console.log(JSON.stringify(results, null, 2));
}
