import { describe, expect, it } from "vitest";

import { renderRuntimeStartupContext } from "../../src/runtime/startup-context";
import type { RuntimeDreamReviewHudState } from "../../src/runtime/lifecycle-engine";

const dreamReviewHud = (): RuntimeDreamReviewHudState => ({
  refreshedAt: "2026-06-28T00:00:00.000Z",
  source: "live",
  stale: false,
  fetchError: null,
  summary: {
    pending: 2,
    pendingByType: {
      warm_memory: 0,
      policy_patch: 0,
      self_model: 0,
      capability_refinement: 1,
      staleness_marker: 0,
      dream_connection: 1,
      dream_story: 0,
    },
    oldestPendingCreatedAt: "2026-06-27T22:00:00.000Z",
    newestPendingCreatedAt: "2026-06-27T23:00:00.000Z",
    sampledPendingCount: 2,
    truncated: false,
  },
  newSinceLastAnnouncement: 1,
  lastAnnouncedAt: "2026-06-27T21:00:00.000Z",
  topItems: [
    {
      proposalId: "dream-proposal-1",
      proposalType: "dream_connection",
      createdAt: "2026-06-27T23:00:00.000Z",
      confidence: 0.72,
      utilityScore: 0.61,
      summary: "Review-gated bridges prevent speculative memory from becoming durable by accident.",
      isNew: true,
    },
  ],
});

const render = (injectedContext = ""): string =>
  renderRuntimeStartupContext({
    runtime: "pi",
    profileName: "test",
    mode: "assist",
    status: null,
    manifest: null,
    inbox: null,
    dreamReview: dreamReviewHud(),
    obligations: null,
    actions: [],
    warnings: [],
    injectedContext,
  });

describe("startup context — dream review action rendering", () => {
  it("renders proposal items, commands, and a self-directed review directive", () => {
    const output = render();

    expect(output).toContain("Dream review HUD: pending 2 proposals");
    expect(output).toContain("Dream review items: new dream_connection dream-proposal-1: Review-gated bridges");
    expect(output).toContain("confidence=0.72 utility=0.61");
    expect(output).toContain("Dream review (self-directed): these are your own dreams — decide pending proposals yourself now, without asking the user");
    expect(output).toContain("Dream review commands: crosshead context dreams inspect --status pending");
  });

  it("keeps review details in compact context when injected context is present", () => {
    const output = render("Injected continuity context.");

    expect(output).toContain("Dream review items: new dream_connection dream-proposal-1: Review-gated bridges");
    expect(output).toContain("confidence=0.72 utility=0.61");
    expect(output).toContain("Dream review (self-directed): these are your own dreams — decide pending proposals yourself now, without asking the user");
    expect(output).toContain("Dream review commands: crosshead context dreams inspect --status pending");
    expect(output).toContain("Injected context:\nInjected continuity context.");
  });
});
