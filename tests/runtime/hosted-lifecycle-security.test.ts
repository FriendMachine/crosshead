import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { contextFromCli } from "../../src/runtime/cli/context";
import { OnlyBotsLocalRuntimeDaemon, setupRuntimeProfile } from "../../src/runtime/local-runtime";

const homes: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
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

const installFetchMock = (npub: string, contextStatus: number, contextPack?: () => Promise<Response>) => {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
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
			if (contextPack) return contextPack();
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
			return jsonResponse({
				packId: "hosted-pack-safe-id",
				goal: "Inspect the explicit context pack",
				contextText: "Inspectable only through an explicit operator command",
				fragments: [],
			});
		}
		throw new Error(`unexpected hosted lifecycle request: ${url.pathname}`);
	});
};

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
