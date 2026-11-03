import { describe, expect, it } from "vitest";

import { renderRuntimeStartupContext } from "../../src/runtime/startup-context";
import type { RuntimeObligationsHudState } from "../../src/runtime/lifecycle-engine";

const render = (obligations: RuntimeObligationsHudState | null): string =>
  renderRuntimeStartupContext({
    runtime: "claude-code",
    profileName: "test",
    mode: "assist",
    status: null,
    manifest: null,
    inbox: null,
    dreamReview: null,
    obligations,
    actions: [],
    warnings: [],
    injectedContext: "",
  });

const hud = (overrides: Partial<RuntimeObligationsHudState> = {}): RuntimeObligationsHudState => ({
  refreshedAt: "2026-06-08T12:00:00.000Z",
  source: "live",
  stale: false,
  fetchError: null,
  summary: { total: 2, active: 2, due: 1, scheduled: 1, nextFireAt: "2026-06-09T09:00:00.000Z" },
  topItems: [
    { id: "1", title: "Reauthenticate the service", status: "due", actionMode: "auto", nextFireAt: null },
    { id: "2", title: "Follow up with Joe", status: "scheduled", actionMode: "remind", nextFireAt: "2026-06-09T09:00:00.000Z" },
  ],
  ...overrides,
});

describe("startup context — obligations HUD rendering", () => {
  it("renders the obligations HUD summary line and a top-items digest", () => {
    const output = render(hud());
    expect(output).toContain("Obligations HUD: due 1 obligation, scheduled 1 obligation, next 2026-06-09T09:00:00.000Z");
    // due first; non-default action-mode is tagged; remind is not.
    expect(output).toContain("Obligations: due Reauthenticate the service [auto] | scheduled Follow up with Joe");
  });

  it("omits obligations lines when there are no obligations", () => {
    const output = render(hud({ summary: { total: 0, active: 0, due: 0, scheduled: 0, nextFireAt: null }, topItems: [] }));
    expect(output).not.toContain("Obligations HUD");
    expect(output).not.toContain("Obligations: ");
  });

  it("marks a cached snapshot as stale in the summary line", () => {
    const output = render(hud({ source: "cached", stale: true }));
    expect(output).toContain("cached snapshot");
  });

  it("omits the obligations lines entirely when the HUD state is null", () => {
    const output = render(null);
    expect(output).not.toContain("Obligations HUD");
    expect(output).not.toContain("Obligations:");
  });
});
