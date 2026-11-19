import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { loadProfile, loadSecret, resolveRuntimePaths, saveProfile, saveSecret } from "../../src/runtime/runtime-persistence";
import { setupRuntimeProfile } from "../../src/runtime/local-runtime";
import type { UsageSnapshot } from "../../src/protocol/token-usage";
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
	const native = (response: string, thread: string, input: number, output: number, extra = {}) =>
		codexRow("token_usage_record", { response_id: response, thread_id: thread, session_id: "parent-codex",
			usage: { ...codexTokens(input, output), ...extra } });
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
			codexRow("turn_context", { model: "gpt-6.2-sol" }),
			native("resp-3", "parent-codex", 30, 5, { cached_input_tokens: 28, cache_write_input_tokens: 4 }),
		));
		await Promise.all(Array.from({ length: 2 }, () => promisify(execFile)("sh",
			["-c", `printf '%s' "$USAGE_FIXTURE_PAYLOAD" | ${hook.command}`],
			{ cwd: project, env: { ...env, USAGE_FIXTURE_PAYLOAD: hook.payload }, timeout: 10000 })));

		const result = report("default");
		expect(result.periods.map((period: { totals: { totalTokens: number } }) => period.totals.totalTokens)).toEqual([164, 164, 164]);
		expect(result.periods[0].totals).toEqual({
			inputTokens: 139, cachedInputTokens: 56, cacheWriteInputTokens: 8, outputTokens: 25, reasoningOutputTokens: 8, totalTokens: 164,
		});
		expect(result.periods[0].groups).toEqual(expect.arrayContaining([
			expect.objectContaining({ harness: "claude-code", model: "claude-demo", subagent: true, totalTokens: 23 }),
			expect.objectContaining({ harness: "codex", model: "gpt-6.2-sol", subagent: false, totalTokens: 35 }),
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
		const fixture = JSON.parse(readFileSync(path.resolve(__dirname, "../fixtures/token-usage-snapshot.json"), "utf8")) as UsageSnapshot;
		const uploaded: { authorization: string | undefined; body: UsageSnapshot }[] = [];
		const authenticated: string[] = [];
		const authBearers: (string | undefined)[] = [];
		let rejectAudience = false;
		let base = "";
		const server = createServer(async (request, response) => {
			const chunks: Uint8Array[] = [];
			for await (const chunk of request) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const send = (status: number, value: unknown) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(value));
			};
			if (request.url === "/v1/auth/challenge") {
				authBearers.push(request.headers.authorization);
				const issued = new Date();
				const expires = new Date(issued.getTime() + 60_000).toISOString();
				const challenge = Buffer.from(JSON.stringify({
					version: "crosshead_auth_v1", purpose: "crosshead_hosted_auth", audience: base,
					npub: body.npub, nonce: Buffer.alloc(24, 3).toString("base64url"),
					issued_at: issued.toISOString(), expires_at: expires,
				})).toString("base64url");
				return send(200, { challenge, expires_at: expires });
			}
			if (request.url === "/v1/auth/verify") {
				authenticated.push(body.npub as string);
				authBearers.push(request.headers.authorization);
				return send(200, { session_token: "fresh-fixture-session", expires_at: new Date(Date.now() + day).toISOString(), scopes: ["memory:*"] });
			}
			if (request.method !== "PUT" || request.url !== "/v1/usage/snapshot") return send(404, {});
			uploaded.push({ authorization: request.headers.authorization, body });
			return rejectAudience
				? send(409, { error: { code: "usage_audience_changed", message: "relink" } })
				: send(200, { stored: true });
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Fixture server has no TCP port");
			base = "http://127.0.0.1:" + address.port;
			const hosted = { ...identity, apiBase: base };
			saveProfile(paths, hosted);
			saveSecret(paths, hosted.name, { ...loadSecret(paths, hosted.name)!,
				session: { npub: hosted.npub, audience: "https://previous.example", sessionToken: "previous-session", expiresAt: new Date(Date.now() + day).toISOString(), scopes: ["memory:*"] } });
			const command = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
				[cliScript, "usage", "sync", ...args, "--home", home, "--json"], { cwd: project, env, timeout: 10000 })).stdout).profiles;
			expect(await command("now", "--all-profiles")).toEqual([
				{ profile: "default", available: true, enabled: false, lastSyncedAt: null, lastError: null },
				{ profile: "separate", available: false, enabled: false, lastSyncedAt: null, lastError: null },
			]);
			expect(uploaded).toHaveLength(0);
			expect((await command("on", "--all-profiles"))[0]).toMatchObject({ enabled: true, lastSyncedAt: null });
			expect(uploaded).toHaveLength(0);
			expect((await command("now"))[0].lastSyncedAt).toEqual(expect.any(String));
			expect(authenticated).toEqual([hosted.npub]);
			expect(authBearers).toEqual([undefined, undefined]);
			expect(uploaded).toHaveLength(1);
			const first = uploaded[0]!;
			expect(first.authorization).toBe("Bearer fresh-fixture-session");
			expect(first.body.deviceId).toEqual(expect.any(String));
			expect(first.body.rows.every(row => row.day === now.slice(0, 10))).toBe(true);
			// Normalize the generated device ID and UTC day to compare the exact wire payload
			// with the fixture fed to the production validator by the hosted CI test.
			expect({
				...first.body, deviceId: fixture.deviceId,
				rows: first.body.rows.map(row => ({ ...row, day: fixture.rows[0]!.day })),
			}).toEqual(fixture);
			expect(await prepareUsageSync(paths, hosted, Date.now(), false)).toBeUndefined();
			expect(await prepareUsageSync(paths, { ...hosted, apiBase: "https://another.example" }, Date.now(), true)).toBeUndefined();
			const pending = await prepareUsageSync(paths, hosted, Date.now() + 30 * day, false);
			expect(pending?.snapshot.rows).toEqual([]);
			rejectAudience = true;
			await expect(command("now")).rejects.toMatchObject({ stdout: expect.stringContaining("account link changed") });
			expect((await command("status"))[0].lastError).toContain("account link changed");
			expect((await command("off"))[0]).toMatchObject({ enabled: false, lastSyncedAt: null, lastError: null });
			expect(await usageSyncIsCurrent(paths, hosted, pending!.snapshot)).toBe(false);
			await command("now");
			expect(uploaded).toHaveLength(2);
			rejectAudience = false;
			await command("on");
			expect((await command("now"))[0].lastError).toBeNull();
			expect(uploaded[2]!.body.consentRevision).not.toBe(first.body.consentRevision);
			expect(uploaded[2]!.body.deviceId).toBe(first.body.deviceId);
			expect(authenticated).toEqual([hosted.npub]);
			expect(report("default").periods[0].totals.totalTokens).toBe(182);
			const replacement = loadProfile(paths, "separate")!;
			await setupRuntimeProfile({
				home, profileName: "default", npub: replacement.npub,
				nsec: loadSecret(paths, "separate")!.nsec, apiBase: base,
			});
			expect(authenticated).toEqual([hosted.npub, replacement.npub]);
			expect(loadSecret(paths, "default")?.session).toMatchObject({ npub: replacement.npub, audience: base });
			expect((await command("status"))[0]).toMatchObject({ enabled: false, lastError: null });


		} finally {
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		}

	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
