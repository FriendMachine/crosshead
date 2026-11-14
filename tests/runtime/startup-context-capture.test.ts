import { describe, expect, it } from "vitest";
import { renderRuntimeStartupContext } from "../../src/runtime/startup-context";

const empty = {
  profileName: "default", status: null, manifest: null, inbox: null,
  dreamReview: null, obligations: null, actions: [], warnings: [], injectedContext: "",
} as const;

describe("native hook capture contract", () => {
  it.each(["codex", "claude-code"] as const)("explains capture before %s has any saved memory", runtime => {
    const context = renderRuntimeStartupContext({ ...empty, actions: [], warnings: [], runtime, mode: "assist" });
    expect(context).toContain("capture your final response");
    expect(context).toContain("types and units");
    expect(context).toContain("Distinguish observed facts from assumptions");
    expect(context).toContain("No manual hook invocation or repository memory file is needed");
    expect(context).toContain("does not authorize file changes");
  });

  it.each(["off", "manual"] as const)("does not promise automatic capture in %s mode", mode => {
    expect(renderRuntimeStartupContext({ ...empty, actions: [], warnings: [], runtime: "codex", mode })).toBe("");
  });

  it("suppresses previously saved memory and HUD output when memory is off", () => {
    expect(renderRuntimeStartupContext({
      ...empty, runtime: "codex", mode: "off", actions: [], warnings: ["Saved warning"],
      injectedContext: "A previously saved private finding",
      hotMemorySnapshot: { scopes: [{ scope: "codex", content: "Saved checkpoint" }] },
    })).toBe("");
  });

  it("keeps prior findings and capture guidance together", () => {
    const context = renderRuntimeStartupContext({
      ...empty, actions: [], warnings: [], runtime: "codex", mode: "auto",
      injectedContext: "API durations use integer seconds; the upper bound is exclusive.",
    });
    expect(context).toContain("capture your final response");
    expect(context).toContain("API durations use integer seconds; the upper bound is exclusive.");
  });

  it("does not describe native Stop-hook behavior for a different runtime", () => {
    expect(renderRuntimeStartupContext({ ...empty, actions: [], warnings: [], runtime: "pi", mode: "auto" })).toBe("");
  });
});
