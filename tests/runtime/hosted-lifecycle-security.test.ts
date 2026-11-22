import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readArchiveRecallSnapshot } from "../../src/runtime/archive-recall";
import { contextFromCli } from "../../src/runtime/cli/context";
import { OnlyBotsLocalRuntimeDaemon, setupRuntimeProfile } from "../../src/runtime/local-runtime";
import { HostRuntimeAdapterBase, type HostAdapterIdentity } from "../../src/runtime/host-adapter-base";
import { LocalRuntimeClient } from "../../src/runtime/local-client";
import { NativeHostRuntimeAdapter } from "../../src/runtime/native-host-adapter";
import { installPiAdapter, PiEmbeddedRuntime } from "../../src/runtime/pi-adapter";
import { stopHotSyncManagers } from "../../src/runtime/hot-sync-manager";
import { resolveRuntimePaths } from "../../src/runtime/runtime-persistence";

const homes: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const home of homes.splice(0)) {
		await stopHotSyncManagers(resolveRuntimePaths(home).state);
		rmSync(home, { recursive: true, force: true });
	}
});

const identity = () => {
	const secret = generateSecretKey();
	return { nsec: nip19.nsecEncode(secret), npub: nip19.npubEncode(getPublicKey(secret)) };
};

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const installFetchMock = (npub: string, contextStatus: number, contextPack?: (path: string, init?: RequestInit) => Promise<Response>) =>
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		if (url.pathname === "/v1/auth/challenge") {
			const issuedAt = new Date();
			const expiresAt = new Date(issuedAt.getTime() + 60_000).toISOString();
			const challenge = Buffer.from(JSON.stringify({
				version: "crosshead_auth_v1",
				purpose: "crosshead_hosted_auth",
				audience: "https://crosshead.sh",
				npub,
				nonce: Buffer.alloc(24, 7).toString("base64url"),
				issued_at: issuedAt.toISOString(),
				expires_at: expiresAt,
			})).toString("base64url");
			return jsonResponse({ challenge, expires_at: expiresAt });
		}
		if (url.pathname === "/v1/auth/verify") {
			return jsonResponse({
				session_token: "session-hosted-lifecycle-test",
				expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				scopes: ["memory:read"],
			});
		}
		if (url.pathname === "/v1/context/pack") {
			if (contextPack) return contextPack(url.pathname, init);
			if (contextStatus !== 200) {
				return jsonResponse({ error: { code: "payment_required", message: "funding required" } }, contextStatus);
			}
			return jsonResponse({
				packId: "hosted-pack-safe-id",
				contextText: "SERVER_AUTHORED_INSTRUCTION_MUST_NOT_REACH_THE_PROMPT",
				fragments: [{ content: "SERVER_AUTHORED_FRAGMENT_MUST_NOT_REACH_THE_PROMPT" }],
			});
		}
		if (url.pathname === "/v1/context/packs/hosted-pack-safe-id") {
			if (contextPack) return contextPack(url.pathname, init);
			return jsonResponse({
				packId: "hosted-pack-safe-id",
				goal: "Inspect the explicit context pack",
				contextText: "Inspectable only through an explicit operator command",
				fragments: [],
			});
		}
		throw new Error(`unexpected hosted lifecycle request: ${url.pathname}`);
	});

const verifiedHotSnapshot = {
	scope: "all",
	integrity: "verified-client-signatures",
	scopes: [{
		scope: "codex",
		integrity: "verified",
		content: JSON.stringify({
			runtime: "codex",
			workspaceId: "repo:security-test",
			updatedAt: "2026-10-31T12:00:00.000Z",
			continuityCheckpoints: [{
				runtime: "codex",
				workspaceId: "repo:security-test",
				sessionId: "prior-session",
				turnId: "prior-turn",
				goal: "Continue the verified local work",
				summary: "CLIENT_VERIFIED_HOT_MEMORY_MUST_REACH_THE_PROMPT",
				occurredAt: "2026-10-31T12:00:00.000Z",
			}],
		}),
	}],
};

describe("hosted lifecycle prompt boundary", () => {
	it("records an explicit context pack so context inspect --latest can resolve it", async () => {
		const signer = identity();
		const home = mkdtempSync(path.join(os.tmpdir(), "crosshead-context-latest-"));
		homes.push(home);
		installFetchMock(signer.npub, 200);
		await setupRuntimeProfile({
			home,
			profileName: "default",
			apiBase: "https://crosshead.sh",
			npub: signer.npub,
			nsec: signer.nsec,
			memoryMode: "assist",
		});

		const created = JSON.parse(await contextFromCli([
			"pack",
			"--goal",
			"Inspect the explicit context pack",
			"--home",
			home,
			"--profile",
			"default",
			"--json",
		])) as Record<string, unknown>;
		expect(created.packId).toBe("hosted-pack-safe-id");

		const inspected = JSON.parse(await contextFromCli([
			"inspect",
			"--latest",
			"--home",
			home,
			"--profile",
			"default",
			"--json",
		])) as Record<string, unknown>;
		expect(inspected.packId).toBe("hosted-pack-safe-id");
	});

	it.each([
		["a successful hosted response", 200],
		["a payment-required hosted response", 402],
	] as const)("renders only client-verified hot memory after %s", async (_label, contextStatus) => {
		// Exercise the explicit legacy opt-out path and its untrusted hosted responses.
		vi.stubEnv("CROSSHEAD_HOT_SYNC_ENABLED", "false");
		const signer = identity();
		const home = mkdtempSync(path.join(os.tmpdir(), "crosshead-hosted-lifecycle-security-"));
		homes.push(home);
		installFetchMock(signer.npub, contextStatus);
		await setupRuntimeProfile({
			home,
			profileName: "default",
			apiBase: "https://crosshead.sh",
			npub: signer.npub,
			nsec: signer.nsec,
			memoryMode: "assist",
		});

		const daemon = new OnlyBotsLocalRuntimeDaemon(home);
		const result = await daemon.submitLifecycleEvent({
			runtime: "claude-code",
			type: "turn.started",
			workspaceId: "repo:security-test",
			sessionId: "current-session",
			turnId: "current-turn",
			payload: {
				goal: "Continue the verified local work",
				hotMemorySnapshot: verifiedHotSnapshot,
			},
		});

		const promptSurface = JSON.stringify(result.contextPack);
		expect(promptSurface).toContain("CLIENT_VERIFIED_HOT_MEMORY_MUST_REACH_THE_PROMPT");
		expect(promptSurface).not.toContain("SERVER_AUTHORED_INSTRUCTION_MUST_NOT_REACH_THE_PROMPT");
		expect(promptSurface).not.toContain("SERVER_AUTHORED_FRAGMENT_MUST_NOT_REACH_THE_PROMPT");
		if (contextStatus === 200) expect(result.contextPack?.packId).toBe("hosted-pack-safe-id");
	});

	it.each([
		{
			label: "the server's recall deadline",
			contextPack: async () => jsonResponse({ error: { code: "recall_deadline_exceeded", message: "late",
				details: { deadline_ms: 2500, charged_sats: 0, retryable: true } } }, 503),
			failure: { errorClass: "http", status: 503, code: "recall_deadline_exceeded" },
			warning: "charged nothing",
		},
		{
			label: "the client's recall timeout",
			contextPack: async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
			failure: { errorClass: "timeout" },
			warning: "may still settle",
		},
		{
			label: "an unacknowledged paid commit",
			contextPack: async () => jsonResponse({ error: { code: "paid_operation_commit_unknown", message: "uncertain", details: { retry_with_same_key: true } } }, 503),
			failure: { errorClass: "http", status: 503, code: "paid_operation_commit_unknown" },
			warning: "same idempotency key",
		},
	])("records why bounded recall fell back to free hot memory after $label", async ({ contextPack, failure, warning }) => {
		// Local-first sessions deliberately skip paid automatic recall. Exercise the
		// still-supported hosted path explicitly rather than depending on defaults.
		vi.stubEnv("CROSSHEAD_HOT_SYNC_ENABLED", "false");
		const signer = identity();
		const home = mkdtempSync(path.join(os.tmpdir(), "crosshead-bounded-fallback-"));
		homes.push(home);
		installFetchMock(signer.npub, 200, contextPack);
		await setupRuntimeProfile({
			home,
			profileName: "default",
			apiBase: "https://crosshead.sh",
			npub: signer.npub,
			nsec: signer.nsec,
			memoryMode: "assist",
		});

		const daemon = new OnlyBotsLocalRuntimeDaemon(home);
		const result = await daemon.submitLifecycleEvent({
			runtime: "claude-code",
			type: "turn.started",
			workspaceId: "repo:security-test",
			sessionId: "current-session",
			turnId: "current-turn",
			payload: {
				goal: "Continue the verified local work",
				recallPolicy: "bounded",
				hotMemorySnapshot: verifiedHotSnapshot,
			},
		});

		const fallback = result.actions.find((action) => action.type === "context_pack" && action.status === "failed");
		expect(fallback?.details).toMatchObject({ freeFallback: true, failure });
		expect(result.warnings.filter((entry) => entry.startsWith("Saved-context retrieval unavailable"))).toEqual([
			expect.stringContaining(warning),
		]);
		expect(JSON.stringify(result.contextPack)).toContain("CLIENT_VERIFIED_HOT_MEMORY_MUST_REACH_THE_PROMPT");
	});
});

class ArchiveHookAdapter extends HostRuntimeAdapterBase {
	protected readonly identity: HostAdapterIdentity;
	protected readonly config = { profileName: "default", hostHome: "/fixture-host", adapterVersion: "fixture" };

	constructor(protected readonly client: LocalRuntimeClient, runtime: "codex" | "claude-code") {
		super();
		this.identity = { runtimeId: runtime, wrapperVersionFallback: "fixture", requestLabel: runtime };
	}

	protected async attachWorkspace(): Promise<void> {}
}

describe("verified recall through native prompt preparation", () => {
	it.each(["codex", "claude-code", "agy", "hermes", "opencode", "pi"] as const)("recalls the whole approved warm and cold task in %s", async (runtime) => {
		vi.stubEnv("CROSSHEAD_HOT_SYNC_ENABLED", "true");
		const signer = identity();
		const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "crosshead-verified-recall-")));
		homes.push(home);
		const workspaceId = `repo:${home}`;
		const goal = "Repair payment retries without duplicate charges";
		let taskId = "recall-task:payments-retry";
		const hot = "The fixture worker is offline.";
		const cold = { id: "cold:original", kind: "cold_memory", content: "Retry the payment with the original idempotency key." };
		const warm = { id: "warm:correction", kind: "warm_memory", content: "Check the receipt before every payment retry." };
		const previewPackId = "hosted-pack-safe-id";
		const hostedText = "UNVERIFIED_HOSTED_PROMPT_TEXT";
		let sources = [cold, warm];
		let whenRequested: (() => Promise<void>) | undefined;
		let responseStatus = 200;
		let warnings: string[] = [];
		const requestHosts: (string | null)[] = [];
		const fetcher = installFetchMock(signer.npub, 200, async (_path, init) => {
			const body = init?.body ? JSON.parse(String(init.body)) : null;
			if (body) {
				expect(body.allowedScope.includeHotMemory).toBe(false);
				expect(body).not.toHaveProperty("hotMemorySnapshot");
				requestHosts.push(body.runtimeHost);
			}
			const returned = sources;
			await whenRequested?.();
			if (responseStatus !== 200) return jsonResponse({ error: { code: "payment_required" } }, responseStatus);
			return jsonResponse({
				packId: previewPackId,
				goal: body?.goal ?? goal,
				workspaceId,
				contextText: hostedText,
				fragments: returned,
				recall: {
					policy: "bounded",
					warnings,
					sources: returned.map(source => source.id),
					decisions: [{ task: taskId, sources: returned.map(source => source.id) }],
				},
			});
		});
		await setupRuntimeProfile({ home, ...signer, profileName: "default", apiBase: "https://crosshead.sh", memoryMode: "assist" });
		fetcher.mockClear();
		const daemon = new OnlyBotsLocalRuntimeDaemon(home);
		const hotSnapshot = { scope: "all", scopes: [{
			scope: runtime,
			content: JSON.stringify({ workspaceId, continuityCheckpoints: [{
				workspaceId, runtime, sessionId: "previous", turnId: "previous",
				goal, summary: hot, occurredAt: "2026-10-31T12:00:00.000Z",
			}] }),
		}] };
		const handle = (event: Parameters<typeof daemon.submitLifecycleEvent>[0]) => daemon.submitLifecycleEvent(event);
		const localClient = {
			emitEvent: handle,
			readHotMemory: async () => hotSnapshot,
			attachAdapter: async () => ({}),
		} as unknown as LocalRuntimeClient;
		if (runtime === "pi") {
			await installPiAdapter({ home });
			vi.spyOn(LocalRuntimeClient.prototype, "attachAdapter").mockResolvedValue({} as never);
			vi.spyOn(LocalRuntimeClient.prototype, "readHotMemory").mockResolvedValue(hotSnapshot);
			vi.spyOn(LocalRuntimeClient.prototype, "emitEvent").mockImplementation(handle);
		}
		const prepare = (turnId: string, prompt = goal, root = home) => {
			const observedAt = "2026-11-01T12:00:00.000Z";
			if (runtime === "pi") {
				return new PiEmbeddedRuntime({
					home, workspaceRoot: root, sessionId: "session", executor: async () => { throw new Error("unexpected inference"); },
				}).prepareTurn({ turnId, prompt, observedAt });
			}
			const adapter = runtime === "codex" || runtime === "claude-code"
				? new ArchiveHookAdapter(localClient, runtime)
				: new NativeHostRuntimeAdapter({
					marker: "crosshead-native-host-v1", name: runtime, runtimeHome: home, hostHome: home,
					profileName: "default", adapterVersion: "fixture", hostBinary: runtime, nodeExecutable: process.execPath,
				}, localClient);
			return adapter.prepareTurn({ workspaceRoot: root, sessionId: "session", turnId, prompt, hookObservedAt: observedAt });
		};
		const command = async (...argv: string[]) => JSON.parse(await contextFromCli([
			"recall", ...argv, "--home", home, "--workspace-root", home,
		]));
		const preview = (...args: string[]) => command("preview", "--goal", goal, ...args);
		const approve = ({ packId, sha256 }: { packId: string; sha256: string }) =>
			command("approve", "--pack-id", packId, "--sha256", sha256);

		const baseline = await prepare("unapproved");
		expect(baseline.contextText).toContain(hot);
		expect(fetcher).not.toHaveBeenCalled();
		await expect(approve({ packId: previewPackId, sha256: "0".repeat(64) })).rejects.toThrow("requires a current preview");
		expect(fetcher).not.toHaveBeenCalled();
		warnings = ["Hosted archive search was skipped."];
		await expect(preview()).rejects.toThrow("reported incomplete archive retrieval");
		warnings = [];
		const original = await preview();
		expect(original.sources).toEqual([cold, warm]);
		await approve(original);

		const verified = await prepare("approved");
		expect(verified.contextText.startsWith(baseline.contextText + "\n\n")).toBe(true);
		expect(verified.contextText).toContain(cold.content);
		expect(verified.contextText).toContain(warm.content);
		expect(verified.contextText).not.toContain(hostedText);
		expect(requestHosts.every(host => host === null)).toBe(true);

		const beforeDenied = fetcher.mock.calls.length;
		const denied = await daemon.submitLifecycleEvent({
			runtime, type: "turn.started", workspaceId, sessionId: "session", turnId: "archive-scope-legacy-alias",
			payload: { goal, recallPolicy: "bounded", allowed_scope: { includeWarmMemory: false, includeColdMemory: false } },
		});
		expect(denied.contextPack?.verifiedArchiveContext).toBeUndefined();
		expect(fetcher.mock.calls).toHaveLength(beforeDenied);

		const coldDenied = await daemon.submitLifecycleEvent({
			runtime, type: "turn.started", workspaceId, sessionId: "session", turnId: "archive-scope-cold-denied",
			payload: { goal, recallPolicy: "bounded", allowed_scope: { include_cold_memory: false } },
		});
		const posted = fetcher.mock.calls.at(-1)?.[1]?.body;
		expect(JSON.parse(String(posted)).allowedScope.includeColdMemory).toBe(false);
		expect(coldDenied.contextPack?.verifiedArchiveContext).toBeUndefined();
		expect(coldDenied.contextPack?.packId).toBeNull();

		warnings = ["Archive search was skipped."];
		expect((await prepare("incomplete")).packId).toBeNull();
		warnings = [];
		sources = [cold]; // An internally consistent response that omits the approved correction.
		const withheld = await prepare("omits-correction");
		expect(withheld.contextText).toBe(baseline.contextText);
		expect(withheld.packId).toBeNull();
		expect((await daemon.readActivity(100)).actions).toContainEqual(expect.objectContaining({
			details: expect.objectContaining({ packId: previewPackId, verifiedArchiveRecall: false }),
		}));
		sources = [cold, warm];
		const previousTaskId = taskId;
		const stale = await preview();
		taskId = "recall-task:payment-retry-v2";
		sources = [cold, { ...warm, content: "Check the receipt and verify that the payer matches." }];
		await expect(approve(stale)).rejects.toThrow("digest changed");
		await approve(await preview());
		await expect(approve(original)).rejects.toThrow("requires a current preview");
		expect((await command("list")).approvals).toEqual([expect.objectContaining({ taskId })]);
		expect((await prepare("new-revision")).contextText).toContain(sources[1]!.content);
		taskId = previousTaskId;
		sources = [cold, warm];
		expect((await prepare("replayed-revision")).contextText).toBe(baseline.contextText);

		responseStatus = 402;
		expect((await prepare("unfunded")).contextText).toBe(baseline.contextText);
		responseStatus = 200;
		const calls = fetcher.mock.calls.length;
		expect((await prepare("nearby-goal", "Repair payment retries with a different contract")).contextText).not.toContain(cold.content);
		expect((await prepare("declined", "Repair payment retries using only the provided specification")).contextText).not.toContain(cold.content);
		expect((await prepare("foreign", goal, path.join(home, "different-workspace"))).contextText).not.toContain(cold.content);
		expect(fetcher.mock.calls.length).toBe(calls);

		await approve(await preview("--host", runtime));
		expect((await prepare("host-scoped")).contextText).toContain(warm.content);
		expect(requestHosts.slice(-2)).toEqual([runtime, runtime]);
		let release!: () => void;
		whenRequested = () => new Promise<void>(resolve => { release = resolve; });
		const inFlight = prepare("in-flight");
		try {
			await vi.waitFor(() => expect(release).toBeTypeOf("function"));
			const independentTurn = prepare("unrelated", "Inspect rendering metrics");
			await expect(Promise.race([
				independentTurn.then(() => "prepared"),
				new Promise(resolve => setTimeout(() => resolve("blocked"), 250)),
			])).resolves.toBe("prepared");
			await command("revoke", "--task", taskId);
		} finally {
			release?.();
		}
		expect((await inFlight).contextText).toBe(baseline.contextText);
		expect((await command("list")).approvals).toEqual([
			expect.objectContaining({ taskId: "recall-task:payment-retry-v2", runtimeHost: null }),
		]);
	});
});

describe("verified archive pack structure", () => {
	const workspaceId = "repo:/review";
	const goal = "Recover the exact task";
	const first = { id: "warm:first", kind: "warm_memory", content: "Approved warm fact." };
	const second = { id: "cold:second", kind: "cold_memory", content: "Approved cold record." };
	const ids = [first.id, second.id];
	const decision = { task: "task-A", sources: ids };
	const base = {
		workspaceId, goal, fragments: [first, second],
		recall: { policy: "bounded", sources: ids, decisions: [decision], warnings: [] },
	};
	it("accepts a complete warm and cold task", () => {
		expect(readArchiveRecallSnapshot(base, workspaceId, goal)?.sources).toEqual([first, second]);
	});
	it.each([
		["unlisted fragment", { ...base, fragments: [...base.fragments, { ...first, id: "warm:extra" }] }],
		["duplicate source", { ...base, fragments: [first, first] }],
		["ambiguous decisions", { ...base, recall: { ...base.recall, decisions: [decision, { ...decision, task: "task-B" }] } }],
		["mismatched kind", { ...base, fragments: [{ ...first, kind: "cold_memory" }, second] }],
		["hosted hot fragment", { ...base, fragments: [...base.fragments, { id: "hot:extra", kind: "hot_memory", content: "extra" }] }],
		["over-budget source", { ...base, fragments: [{ ...first, content: "x".repeat(4_000) }, second] }],
		["incomplete task warning", { ...base, recall: { ...base.recall, warnings: ["Archive search was skipped."] } }],
		["withheld task", { ...base, fragments: [], recall: { ...base.recall, sources: [], decisions: [] } }],
	])("withholds a pack with a %s", (_label, pack) => {
		expect(readArchiveRecallSnapshot(pack, workspaceId, goal)).toBeNull();
	});
});
