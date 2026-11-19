import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { loadProfile, loadSecret, resolveRuntimePaths, saveProfile, saveSecret } from "../../src/runtime/runtime-persistence";
import { prepareUsageSync, readUsage, usageSyncIsCurrent } from "../../src/runtime/token-usage";

const cliScript = path.resolve(__dirname, "../../dist/runtime/cli.js");
const day = 86_400_000;
const privateText = "synthetic prompt content that should never be stored in the usage ledger";
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row) + "\n").join("");

it("counts both hosts through installed hooks and sends only aggregate rows after console sync opt-in", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "crosshead-token-usage-"));
	const home = path.join(root, "runtime");
	const project = path.join(root, "project");
	const other = path.join(root, "other");
	const codexHome = path.join(root, "codex");
	const claudeHome = path.join(root, "claude");
	const claudeFile = path.join(claudeHome, "parent-claude.jsonl");
	const claudeSubagents = path.join(claudeHome, "parent-claude", "subagents");
	const today = new Date().toISOString().slice(0, 10).split("-");
	const rollouts = path.join(codexHome, "sessions", ...today);
	const codexFile = path.join(rollouts, "rollout-parent.jsonl");
	const codexChildFile = path.join(rollouts, "rollout-child.jsonl");
	const env = { ...process.env, CROSSHEAD_PROFILE: "", ONLYBOTS_PROFILE: "", CROSSHEAD_HOOK_AUTOSTART: "0" };
	const cli = (...args: string[]) => execFileSync(process.execPath, [cliScript, ...args, "--home", home],
		{ cwd: project, env, encoding: "utf8", timeout: 10000 }).trim();
	const invoke = (phase: "UserPromptSubmit" | "Stop", host: "claude-code" | "codex", file: string, session: string, cwd = project) => {
		const plan = JSON.parse(cli("workspace", "check", "--workspace-root", cwd, "--json"));
		const binding = plan.bindings.find((row: { host: string }) => row.host === host);
		const config = JSON.parse(readFileSync(binding.file, "utf8"));
		const command = config.hooks[phase][0].hooks[0].command as string;
		execFileSync("sh", ["-c", command], { cwd, env, input: JSON.stringify({ cwd, session_id: session, transcript_path: file }), timeout: 10000 });
		return { command, payload: JSON.stringify({ cwd, session_id: session, transcript_path: file }) };
	};
	const start = (host: "claude-code" | "codex", file: string, session: string, cwd = project) =>
		invoke("UserPromptSubmit", host, file, session, cwd);
	const stop = (host: "claude-code" | "codex", file: string, session: string, cwd = project) =>
		invoke("Stop", host, file, session, cwd);
	const report = (profile: string) => JSON.parse(cli("usage", "--profile", profile, "--json")).profiles[0];
	const claudeMessage = (id: string, output: number, timestamp = new Date().toISOString()) => ({
		type: "assistant", timestamp, sessionId: "parent-claude", message: {
			id, model: "claude-demo", content: [{ type: "text", text: privateText }], usage: {
				input_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 2, output_tokens: output,
				output_tokens_details: { thinking_tokens: 1 },
			},
		},
	});
	const codexRow = (type: string, payload: Record<string, unknown>, timestamp = new Date().toISOString()) =>
		({ type, payload, timestamp });
	const codexTokens = (input: number, output: number) =>
		({ input_tokens: input, cached_input_tokens: 4, output_tokens: output, reasoning_output_tokens: 2 });
	const native = (response: string, thread: string, input: number, output: number) =>
		codexRow("token_usage_record", { response_id: response, thread_id: thread, session_id: "parent-codex", usage: codexTokens(input, output) });
	const codexMirror = (input: number, output: number) =>
		codexRow("event_msg", { type: "token_count", info: { total_token_usage: codexTokens(input, output), last_token_usage: codexTokens(input, output) } });

	try {
		for (const dir of [project, other, claudeSubagents, rollouts]) mkdirSync(dir, { recursive: true });
		cli("quickstart", "--scope", "all", "--adapter", "both", "--profile", "default", "--api-base", "http://127.0.0.1:0",
			"--claude-home", claudeHome, "--codex-home", codexHome, "--no-start");
		cli("keygen", "--setup", "--profile", "separate", "--api-base", "http://127.0.0.1:0", "--no-default");
		cli("workspace", "profile", "set", "--workspace-root", other, "--profile", "separate");
		cli("memory", "mode", "off", "--profile", "default");
		cli("memory", "mode", "off", "--profile", "separate");

		writeFileSync(claudeFile, jsonl(claudeMessage("old", 900)));
		start("claude-code", claudeFile, "parent-claude");
		stop("claude-code", claudeFile, "parent-claude");
		expect(report("default")).toMatchObject({ enabled: false, enabledAt: null });
		expect(existsSync(path.join(home, "state", "usage"))).toBe(false);

		cli("usage", "on");
		const started = report("default").enabledAt;
		cli("usage", "on");
		expect(report("default").enabledAt).toBe(started);
		start("claude-code", claudeFile, "parent-claude");
		const now = new Date().toISOString();
		const update = claudeMessage("new", 4, now);
		const partial = JSON.stringify(update);
		const split = partial.indexOf(privateText) + 7;
		appendFileSync(claudeFile, jsonl(claudeMessage("new", 3, now)) + partial.slice(0, split));
		writeFileSync(path.join(claudeSubagents, "agent-fixture.jsonl"), jsonl(claudeMessage("sub", 6, now)));
		stop("claude-code", claudeFile, "parent-claude", other);
		expect(report("separate").periods[0].totals.totalTokens).toBe(0);
		stop("claude-code", claudeFile, "parent-claude");
		expect(report("default").periods[0].totals.outputTokens).toBe(9);
		appendFileSync(claudeFile, partial.slice(split) + "\n");
		stop("claude-code", claudeFile, "parent-claude");
		expect(report("default").periods[0].totals.outputTokens).toBe(10);

		start("codex", codexFile, "parent-codex");
		const metadata = codexRow("session_meta", { id: "parent-codex", session_id: "parent-codex" });
		writeFileSync(codexFile, jsonl(metadata,
			codexRow("turn_context", { model: "gpt-demo" }),
			native("resp-1", "parent-codex", 60, 7), codexMirror(60, 7), codexMirror(60, 7),
		));
		writeFileSync(codexChildFile, jsonl(
			codexRow("session_meta", { id: "child-codex", parent_thread_id: "parent-codex", session_id: "parent-codex" }),
			codexRow("turn_context", { model: "gpt-child" }),
			native("resp-2", "child-codex", 15, 3), codexMirror(15, 3),
		));
		writeFileSync(path.join(rollouts, "rollout-unrelated.jsonl"), jsonl(
			codexRow("session_meta", { id: "unrelated", parent_thread_id: "somewhere-else", session_id: "somewhere-else" }),
			native("resp-unrelated", "unrelated", 2000, 1000),
		));
		const hook = stop("codex", codexFile, "parent-codex");
		appendFileSync(codexFile, jsonl(
			codexRow("turn_context", { model: "gpt-next" }),
			native("resp-3", "parent-codex", 30, 5),
		));
		await Promise.all(Array.from({ length: 2 }, () => promisify(execFile)("sh",
			["-c", `printf '%s' "$USAGE_FIXTURE_PAYLOAD" | ${hook.command}`],
			{ cwd: project, env: { ...env, USAGE_FIXTURE_PAYLOAD: hook.payload }, timeout: 10000 })));

		const result = report("default");
		expect(result.periods.map((period: { totals: { totalTokens: number } }) => period.totals.totalTokens)).toEqual([164, 164, 164]);
		expect(result.periods[0].totals).toEqual({
			inputTokens: 139, cachedInputTokens: 32, cacheWriteInputTokens: 4, outputTokens: 25, reasoningOutputTokens: 8, totalTokens: 164,
		});
		expect(result.periods[0].groups).toEqual(expect.arrayContaining([
			expect.objectContaining({ harness: "claude-code", model: "claude-demo", subagent: true, totalTokens: 23 }),
			expect.objectContaining({ harness: "codex", model: "gpt-next", subagent: false, totalTokens: 35 }),
			expect.objectContaining({ harness: "codex", model: "gpt-child", subagent: true, totalTokens: 18 }),
		]));

		cli("usage", "off");
		appendFileSync(claudeFile, jsonl(claudeMessage("disabled", 300)));
		stop("claude-code", claudeFile, "parent-claude");
		expect(report("default").periods[0].totals.totalTokens).toBe(164);
		cli("usage", "on");
		start("claude-code", claudeFile, "parent-claude");
		appendFileSync(claudeFile, jsonl(claudeMessage("re-enabled", 1)));
		stop("claude-code", claudeFile, "parent-claude");
		expect(report("default").periods[0].totals.totalTokens).toBe(182);
		expect(JSON.parse(cli("usage", "--all-profiles", "--json")).profiles.map((profile: { profile: string; enabled: boolean }) =>
			[profile.profile, profile.enabled])).toEqual([["default", true], ["separate", false]]);

		const usageDir = path.join(home, "state", "usage");
		const stores = readdirSync(usageDir).filter(file => file.endsWith(".sqlite"));
		expect(stores).toHaveLength(1);
		expect(statSync(usageDir).mode & 0o777).toBe(0o700);
		const storePath = path.join(usageDir, stores[0]!);
		expect(statSync(storePath).mode & 0o777).toBe(0o600);
		const bytes = readFileSync(storePath);
		for (const text of [privateText, claudeFile, codexFile, "parent-codex", project]) expect(bytes.includes(text)).toBe(false);
		expect(existsSync(path.join(home, "state", "lifecycle-events.jsonl"))).toBe(false);

		cli("usage", "on", "--profile", "separate");
		appendFileSync(claudeFile, jsonl(claudeMessage("previous-profile-tail", 500)));
		stop("claude-code", claudeFile, "parent-claude", other);
		expect(report("separate").periods[0].totals.totalTokens).toBe(0);
		start("claude-code", claudeFile, "parent-claude", other);
		appendFileSync(claudeFile, jsonl(claudeMessage("new-profile-turn", 2)));
		stop("claude-code", claudeFile, "parent-claude", other);
		expect(report("separate").periods[0].totals.totalTokens).toBe(19);
		expect(report("default").periods[0].totals.totalTokens).toBe(182);

		const paths = resolveRuntimePaths(home);
		const identity = loadProfile(paths, "default")!;
		const clock = Date.parse(now);
		expect((await readUsage(paths, identity, clock + 6 * day)).periods.map(period => period.totals.totalTokens)).toEqual([0, 182, 182]);
		expect((await readUsage(paths, identity, clock + 29 * day)).periods.map(period => period.totals.totalTokens)).toEqual([0, 0, 182]);
		expect((await readUsage(paths, identity, clock + 30 * day)).periods.map(period => period.totals.totalTokens)).toEqual([0, 0, 0]);
		const uploaded: unknown[] = [];
		const server = createServer(async (request, response) => {
			const chunks: Uint8Array[] = [];
			for await (const chunk of request) chunks.push(chunk);
			uploaded.push({ method: request.method, url: request.url, authorization: request.headers.authorization,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
			response.writeHead(200, { "content-type": "application/json" });
			response.end('{"stored":true}');
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Fixture server has no TCP port");
			const hosted = { ...identity, apiBase: "http://127.0.0.1:" + address.port };
			saveProfile(paths, hosted);
			saveSecret(paths, hosted.name, { ...loadSecret(paths, hosted.name)!,
				session: { sessionToken: "synthetic-session", expiresAt: new Date(Date.now() + day).toISOString(), scopes: ["memory:*"] } });
			const command = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
				[cliScript, "usage", "sync", ...args, "--home", home, "--json"], { cwd: project, env, timeout: 10000 })).stdout).profiles;
			expect(await command("now", "--all-profiles")).toEqual([
				{ profile: "default", available: true, enabled: false, lastSyncedAt: null },
				{ profile: "separate", available: false, enabled: false, lastSyncedAt: null },
			]);
			expect(uploaded).toHaveLength(0);
			expect((await command("on", "--all-profiles"))[0]).toMatchObject({ enabled: true, lastSyncedAt: null });
			expect(uploaded).toHaveLength(0);
			expect((await command("now"))[0].lastSyncedAt).toEqual(expect.any(String));
			expect(uploaded).toEqual([{
				method: "PUT", url: "/v1/usage/snapshot", authorization: "Bearer synthetic-session",
				body: {
					deviceId: expect.any(String), revision: 1, rows: [
						{ day: now.slice(0, 10), harness: "claude-code", model: "claude-demo",
							inputTokens: 51, cachedInputTokens: 30, cacheWriteInputTokens: 6, outputTokens: 11, reasoningOutputTokens: 3 },
						{ day: now.slice(0, 10), harness: "codex", model: "gpt-child",
							inputTokens: 15, cachedInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 2 },
						{ day: now.slice(0, 10), harness: "codex", model: "gpt-demo",
							inputTokens: 60, cachedInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 7, reasoningOutputTokens: 2 },
						{ day: now.slice(0, 10), harness: "codex", model: "gpt-next",
							inputTokens: 30, cachedInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 2 },
					],
				},
			}]);
			expect(await prepareUsageSync(paths, hosted, Date.now(), false)).toBeUndefined();
			expect(await prepareUsageSync(paths, { ...hosted, apiBase: "https://another.example" }, Date.now(), true)).toBeUndefined();
			const pending = await prepareUsageSync(paths, hosted, Date.now() + 30 * day, false);
			expect(pending?.snapshot.rows).toEqual([]);
			expect((await command("off"))[0]).toMatchObject({ enabled: false, lastSyncedAt: null });
			expect(await usageSyncIsCurrent(paths, hosted, pending!.snapshot)).toBe(false);
			await command("now");
			expect(uploaded).toHaveLength(1);
			expect(report("default").periods[0].totals.totalTokens).toBe(182);
		} finally {
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}

	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
