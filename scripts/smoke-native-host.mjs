// Run inside a disposable container with the real host installed. The model is
// deterministic and local: this tests the host/plugin/provider lifecycle, not model quality.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const { generateSecretKey, getPublicKey, nip19 } = require("nostr-tools");
const persistence = require("../dist/runtime/runtime-persistence.js");
const { LocalRuntimeClient } = require("../dist/runtime/local-client.js");
const { stopDetachedRuntimeDaemon } = require("../dist/runtime/local-runtime.js");
const host = process.argv[2];
assert(["hermes", "opencode"].includes(host));
const root = process.env.CROSSHEAD_SMOKE_ROOT ?? "/test";
const home = path.join(root, "runtime"), project = path.join(root, "project");
const profileName = "fixture";
let activeProject = project;
const hostHome = host === "hermes" ? path.join(root, "hermes") : path.join(root, "config", "opencode");
for (const dir of [root, project, hostHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const paths = persistence.ensureRuntimeHomeLayout(home);
if (!persistence.loadProfile(paths, profileName)) {
  const key = generateSecretKey(), now = new Date().toISOString();
  persistence.saveProfile(paths, { name: profileName, apiBase: "http://127.0.0.1:0", npub: nip19.npubEncode(getPublicKey(key)), memoryMode: "assist", workspaceScope: "repo",
    features: { feedback: false, relay: false, coldSync: false, autoWarmPromotion: false }, secureStoreMode: "file", createdAt: now, updatedAt: now });
  persistence.saveSecret(paths, profileName, { nsec: nip19.nsecEncode(key), session: null });
  persistence.saveProfile(paths, { ...persistence.loadProfile(paths, profileName), name: "default", memoryMode: "off" });
  persistence.saveSecret(paths, "default", { nsec: nip19.nsecEncode(key), session: null });
  persistence.saveRuntimeConfig(paths, { ...persistence.loadRuntimeConfig(paths), defaultProfile: "default" });
}
const marker = host === "hermes" ? "hermes-proof-7f92" : "opencode-proof-49a1";
const finding = `Finding ${marker}: the serializer represents durations as decimal nanosecond strings. Boundary zero is valid, negative durations are rejected. Verified a regression case; next add the transport round-trip check.`;
let requests = [], stage = 1;
const server = createServer(async (req, res) => {
  if (req.method === "GET") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ object: "list", data: [{ id: "crosshead-test", object: "model", owned_by: "fixture" }] })); return; }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({ stage, path: req.url, body });
  if (stage === 7) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "fixture-provider-error-private-detail", type: "invalid_request_error", code: "fixture_error" } }));
    return;
  }
  const content = stage === 1 ? finding : `Recovery verification ${marker} stage=${stage}: continue with transport round-trip validation.`;
  const base = { id: "chatcmpl-fixture", created: 1_800_000_000, model: "crosshead-test" };
  if (body.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    for (const chunk of [
      { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
      { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
    ]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  } else {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
  HERMES_HOME: path.join(root, "hermes"), TERMINAL_CWD: project, CROSSHEAD_HOME: home, CROSSHEAD_HOT_SYNC_ENABLED: "false", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", DO_NOT_TRACK: "1" };
const run = async (label, executable, args) => {
  const child = spawn(executable, args, { cwd: activeProject, env: { ...env, TERMINAL_CWD: activeProject }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }).finally(() => clearTimeout(timer));
  writeFileSync(path.join(root, `${host}-${label}.log`), stdout + "\nSTDERR:\n" + stderr);
  if (stage !== 7) assert.equal(code, 0, `${host} ${label} failed; see ${root}/${host}-${label}.log`);
  else assert(code === 0 || code === 1, `${host} forced failure hung or crashed`);
  return stdout;
};
const cli = path.resolve("/crosshead/dist/runtime/cli.js");
const binary = host === "hermes" ? "/opt/hermes/.venv/bin/hermes" : "/usr/local/bin/opencode";
if (host === "opencode") writeFileSync(path.join(hostHome, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json", model: "fixture/crosshead-test", small_model: "fixture/crosshead-test", enabled_providers: ["fixture"], share: "disabled", autoupdate: false,
  provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Local integration fixture", options: { baseURL, apiKey: "fixture-only" }, models: { "crosshead-test": { name: "Fixture", limit: { context: 32768, output: 2048 } } } } },
}));
const invoke = (prompt, resume = false) => host === "hermes"
  ? run(`turn-${stage}`, binary, ["chat", "--provider", "custom", "--base-url", baseURL, "--api-key", "fixture-only", "-m", "crosshead-test", "--oneshot", "--format", "stream-json", ...(resume ? ["--resume", "latest"] : []), "-q", prompt])
  : run(`turn-${stage}`, binary, ["run", "--format", "json", ...(resume ? ["--continue"] : []), prompt]);
const client = new LocalRuntimeClient({ home, timeoutMs: 5000 });
const waitCaptured = async (needle = marker) => {
  for (let i = 0; i < 100; i++) {
    const hot = await client.readHotMemory(profileName, "all").catch(() => null);
    if (JSON.stringify(hot).includes(needle)) return hot;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${host} final response did not reach local hot memory`);
};
const results = { host, checks: [] };
try {
  await run("install", process.execPath, [cli, "install", host, "--home", home, "--profile", profileName, `--${host}-home`, hostHome, ...(host === "hermes" ? ["--hermes-bin", binary] : [])]);
  if (host === "hermes") await run("doctor", binary, ["plugins", "doctor", "crosshead", "--ci"]);
  await invoke("Investigate serializer duration representation and preserve the discovered boundary requirements.");
  const hot = await waitCaptured();
  assert(requests.some(r => r.stage === 1 && JSON.stringify(r.body).includes("Crosshead hooks automatically capture")), "Host did not inject the Crosshead capture contract");
  results.checks.push("real host loaded native plugin and injected context", "final assistant response captured durably", "explicit nondefault profile overrides memory-off default");
  if (host === "opencode" && existsSync(path.join(root, "expect-hermes"))) {
    assert(requests.some(r => r.stage === 1 && JSON.stringify(r.body).includes("hermes-proof-7f92")), "Hermes finding was not injected into OpenCode");
    results.checks.push("Hermes to OpenCode memory handoff");
  }
  await stopDetachedRuntimeDaemon(home);
  stage = 2;
  // New host process, new session: the finding must come from Crosshead, not host history.
  const freshOutput = await invoke("What were the duration boundary findings? Continue the investigation.");
  await waitCaptured(`Recovery verification ${marker} stage=2`);
  assert(requests.some(r => r.stage === 2 && JSON.stringify(r.body).includes(marker)), "Saved finding missing after daemon restart and fresh host session");
  results.checks.push("daemon autostart and durable recovery in a fresh host process/session");
  stage = 3;
  const resumedOutput = await invoke("Resume this session and retain the duration investigation.", true);
  await waitCaptured(`Recovery verification ${marker} stage=3`);
  const session = output => output.split("\n").flatMap(line => { try { const e = JSON.parse(line); return e.sessionID || e.session_id || []; } catch { return []; } }).filter(Boolean).at(-1);
  assert(session(freshOutput) && session(freshOutput) === session(resumedOutput), "Host did not resume the preceding session");
  results.checks.push("native host session resume");
  const beforeOff = JSON.stringify(await client.readHotMemory(profileName, "all"));
  await stopDetachedRuntimeDaemon(home);
  persistence.saveProfile(paths, { ...persistence.loadProfile(paths, profileName), memoryMode: "off" });
  stage = 4;
  await invoke("Start an unrelated investigation with memory disabled.");
  assert(!requests.some(r => r.stage === 4 && JSON.stringify(r.body).includes(marker)), "Memory-off leaked saved context");
  assert.equal(JSON.stringify(await client.readHotMemory(profileName, "all")), beforeOff, "Memory-off captured a turn");
  results.checks.push("memory off suppresses injection and capture");
  await stopDetachedRuntimeDaemon(home);
  persistence.saveProfile(paths, { ...persistence.loadProfile(paths, profileName), memoryMode: "manual" });
  stage = 5;
  await invoke("Investigate in manual memory mode.");
  assert.equal(JSON.stringify(await client.readHotMemory(profileName, "all")), beforeOff, "Manual mode captured a turn");
  results.checks.push("manual mode suppresses automatic capture");
  await stopDetachedRuntimeDaemon(home);
  persistence.saveProfile(paths, { ...persistence.loadProfile(paths, profileName), memoryMode: "assist" });
  stage = 6;
  activeProject = path.join(root, "different-project");
  mkdirSync(activeProject, { recursive: true });
  await invoke("Inspect an unrelated workspace.");
  assert(!requests.some(r => r.stage === 6 && JSON.stringify(r.body).includes(marker)), "Foreign workspace received private project memory");
  results.checks.push("workspace isolation in actual provider-bound requests");
  activeProject = project;
  await stopDetachedRuntimeDaemon(home);
  stage = 7;
  await invoke("Intentionally trigger the fixture provider failure.");
  const failedHot = await waitCaptured(`${host === "hermes" ? "Hermes" : "OpenCode"} turn failed or was interrupted`);
  assert(!JSON.stringify(failedHot).includes("fixture-provider-error-private-detail"), "Provider error details reached memory");
  results.checks.push("actual provider failure captured without provider error detail");
  stage = 8;
  await stopDetachedRuntimeDaemon(home);
  await run("uninstall", process.execPath, [cli, "uninstall", host, "--home", home]);
  results.checks.push("managed uninstall");
  writeFileSync(path.join(root, `${host}-requests.json`), JSON.stringify(requests));
  writeFileSync(path.join(root, `${host}-result.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await stopDetachedRuntimeDaemon(home).catch(() => {});
  await new Promise(resolve => server.close(resolve));
}
