import { describe, expect, it } from "vitest";

import { buildRuntimeStartupFreshness, renderRuntimeStartupContext } from "../../src/runtime/startup-context";

// Union shape as the adapter receives it from readHotMemory(profile, "all").
const union = (scopes: Array<{ scope: string; runtime: string; goal: string; updatedAt: string }>) => ({
  scope: "all",
  scopes: scopes.map((s) => ({
    scope: s.scope,
    content: JSON.stringify({ runtime: s.runtime, currentGoal: s.goal, updatedAt: s.updatedAt }),
    updated_at: s.updatedAt,
  })),
});

const OBSERVED = "2026-06-05T02:30:00.000Z";
const LAST_READ = "2026-06-05T01:30:00.000Z";

describe("runtime startup freshness — peer auto-include", () => {
  it("inlines a peer digest (and drops the advisory) when a peer changed since our last read", () => {
    const f = buildRuntimeStartupFreshness({
      runtime: "claude-code",
      observedAt: OBSERVED,
      previousContextReadAt: LAST_READ,
      hotMemory: union([
        { scope: "claude-code", runtime: "claude-code", goal: "my own goal", updatedAt: "2026-06-05T01:00:00.000Z" },
        { scope: "codex", runtime: "codex", goal: "codex is exploring freshness payloads", updatedAt: "2026-06-05T02:00:00.000Z" },
      ]),
    });
    expect(f.peerUpdate?.runtime).toBe("codex");
    expect(f.peerUpdate?.goal).toContain("codex is exploring");
    // The generic "go look" advisory is redundant once the content is inlined.
    expect(f.advisory).toBeNull();
  });

  it("detects a peer change even when our own scope is the absolute freshest", () => {
    const f = buildRuntimeStartupFreshness({
      runtime: "claude-code",
      observedAt: OBSERVED,
      previousContextReadAt: LAST_READ,
      hotMemory: union([
        { scope: "claude-code", runtime: "claude-code", goal: "my newer goal", updatedAt: "2026-06-05T02:10:00.000Z" },
        { scope: "codex", runtime: "codex", goal: "codex changed too", updatedAt: "2026-06-05T02:00:00.000Z" },
      ]),
    });
    expect(f.hotMemoryRuntime).toBe("claude-code"); // overall freshest is us
    expect(f.peerUpdate?.runtime).toBe("codex"); // but the peer-specific check still fires
    expect(f.peerUpdate?.goal).toBe("codex changed too");
  });

  it("spends no tokens on a peer digest when only our own runtime changed", () => {
    const f = buildRuntimeStartupFreshness({
      runtime: "claude-code",
      observedAt: OBSERVED,
      previousContextReadAt: LAST_READ,
      hotMemory: union([
        { scope: "claude-code", runtime: "claude-code", goal: "my goal", updatedAt: "2026-06-05T02:00:00.000Z" },
      ]),
    });
    expect(f.peerUpdate).toBeNull();
    expect(f.changedSincePreviousContextRead).toBe(true);
  });

  it("does not surface a peer digest on first contact (no known previous read)", () => {
    const f = buildRuntimeStartupFreshness({
      runtime: "claude-code",
      observedAt: OBSERVED,
      previousContextReadAt: null,
      hotMemory: union([
        { scope: "codex", runtime: "codex", goal: "codex goal", updatedAt: "2026-06-05T02:00:00.000Z" },
      ]),
    });
    expect(f.peerUpdate).toBeNull();
  });

  it("renders free hot-memory transfer availability with compact actionable hot-memory detail", () => {
    const output = renderRuntimeStartupContext({
      runtime: "codex",
      profileName: "default",
      mode: "assist",
      status: null,
      manifest: null,
      inbox: null,
      dreamReview: null,
      obligations: null,
      actions: [
				{
					id: "action-1",
					eventId: "event-1",
					profileName: "default",
					type: "context_pack",
					status: "skipped",
					mode: "assist",
					reason: "Paid context pack unavailable; rendered free hot-memory transfer context",
					createdAt: OBSERVED,
					queueItemId: null,
					details: { paymentRequired: true },
				},
      ],
      warnings: ["context pack requires payment; continuing with free hot-memory transfer context"],
      injectedContext: "",
      hotMemorySnapshot: union([
				{
					scope: "codex",
					runtime: "codex",
					goal: "R-42 requires X-Replay-Token to win over body.id before continuing.",
					updatedAt: "2026-06-05T02:00:00.000Z",
				},
				{
					scope: "claude-code",
					runtime: "claude-code",
					goal: "Project B has no Redis cache; do not copy Project A's invalidation convention.",
					updatedAt: "2026-06-05T02:10:00.000Z",
				},
      ]),
    });

    expect(output).toContain("Hot memory: free transfer snapshot available (2 scopes: codex, claude-code); context pack unavailable");
    expect(output).toContain("X-Replay-Token");
    expect(output).toContain("Project B has no Redis cache");
  });

  it("keeps high-signal latest-activity facts in compact startup context", () => {
    const output = renderRuntimeStartupContext({
      runtime: "codex",
      profileName: "default",
      mode: "auto",
      status: null,
      manifest: null,
      inbox: null,
      dreamReview: null,
      obligations: null,
      actions: [],
      warnings: [],
      injectedContext: "",
      freshness: {
        observedAt: OBSERVED,
        previousContextReadAt: LAST_READ,
        hotMemoryUpdatedAt: "2026-06-05T02:00:00.000Z",
        hotMemoryRuntime: "codex",
        changedSincePreviousContextRead: true,
        latestActivity: {
          type: "turn.completed",
          occurredAt: "2026-06-05T02:00:00.000Z",
          summary: [
            "Ran npm run incident:replay and npm test. No files were modified.",
            "R-42 points to src/idempotency.js: the exact request field that must take precedence is the `X-Idempotency-Key` header, matched case-insensitively. It must win over `body.id`.",
            "The failed approach to avoid is deriving the idempotency source from `body.id` first and only falling back to a header.",
            "Public API constraint: preserve the exported functions and do not add dependencies.",
          ].join(" "),
        },
        peerUpdate: null,
        advisory: null,
      },
    });

    expect(output).toContain("X-Idempotency-Key");
    expect(output).toContain("body.id");
    expect(output).toContain("failed approach");
  });
});
