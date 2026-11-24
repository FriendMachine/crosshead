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
    // A saved "tests passed" is only useful with what was run, where and on which tree.
    expect(context).toContain("give the command, working directory, commit and whether the tree had uncommitted changes");
    expect(context).toContain("check it again live");
  });

  it("omits the capture contract once the session holds it", () => {
    expect(renderRuntimeStartupContext({ ...empty, actions: [], warnings: [], runtime: "codex", mode: "assist", captureGuidance: false }))
      .not.toContain("capture your final response");
  });

  it.each(["off", "manual"] as const)("does not promise automatic capture in %s mode", mode => {
    expect(renderRuntimeStartupContext({ ...empty, actions: [], warnings: [], runtime: "codex", mode })).not.toContain("capture your final response");
  });

  it("suppresses recalled memory while preserving off-mode diagnostics", () => {
    const context = renderRuntimeStartupContext({
      ...empty, runtime: "codex", mode: "off", actions: [], warnings: ["Saved warning"],
      injectedContext: "A previously saved private finding",
      hotMemorySnapshot: { scopes: [{ scope: "codex", content: "Saved checkpoint" }] },
    });
    expect(context).toContain("Mode: off");
    expect(context).toContain("Saved warning");
    expect(context).not.toContain("private finding");
    expect(context).not.toContain("Saved checkpoint");
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
