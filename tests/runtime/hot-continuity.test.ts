import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  captureHotFinding, HOT_CONTEXT_LIMIT, HOT_FINDING_LIMIT, renderHotCheckpoints,
  selectHotCheckpoints, updateHotCheckpoints, type HotContinuityCheckpoint,
} from "../../src/runtime/hot-continuity";
import { readLastAssistantMessage } from "../../src/runtime/hook-transcript";
import { renderRuntimeStartupContext } from "../../src/runtime/startup-context";

const checkpoint = (overrides: Partial<HotContinuityCheckpoint> = {}): HotContinuityCheckpoint => ({
  runtime: "codex", workspaceId: "repo:alpha", sessionId: "investigation", turnId: "inspect",
  goal: "Investigate the parcel batching contract", summary: "Parcel batches contain at most 37 items. A partial batch keeps input order.",
  occurredAt: "2026-10-17T01:00:00.000Z", ...overrides,
});
const snapshot = (entries: HotContinuityCheckpoint[]) => ({ scope: "all", scopes: [{
  scope: "codex", content: JSON.stringify({ workspaceId: "repo:alpha", continuityCheckpoints: entries }),
}] });

describe("hot continuity findings", () => {
  it("preserves user-only requirements independently of an incomplete assistant response", () => {
    const stored = updateHotCheckpoints([], checkpoint({
      goal: "Investigate parcel batching. This is read-only; do not contact the carrier. Spending limit is $7. Never convert centimetres to inches.",
      summary: "The source investigation is complete. Ready to continue.",
    }));
    const delivered = renderHotCheckpoints(selectHotCheckpoints(snapshot(stored), "Continue parcel batching", "repo:alpha"));
    expect(delivered).toContain("Prior task request:");
    expect(delivered).toContain("do not contact the carrier");
    expect(delivered).toContain("Spending limit is $7");
    expect(delivered).toContain("Never convert centimetres to inches");
  });

  it("marks request truncation without treating a partial request as complete", () => {
    const stored = updateHotCheckpoints([], checkpoint({ goal: "User constraint. ".repeat(600) }));
    expect(stored[0]?.goal.length).toBe(6000);
    expect(stored[0]?.goalTruncated).toBe(true);
    const delivered = renderHotCheckpoints(stored);
    expect(delivered).toContain("[request incomplete]");
    expect(delivered.length).toBeLessThanOrEqual(HOT_CONTEXT_LIMIT);
  });
  it("preserves exact late constraints and Markdown instead of replacing them with a cue", () => {
    const finding = `${"Investigation detail. ".repeat(40)}\n- Batch ceiling: 37.\n- Empty parcel labels return null.\n- Validate with npm run check.\n`;
    const captured = captureHotFinding(finding);
    expect(captured).toBe(finding.trim());
    const rendered = renderHotCheckpoints([checkpoint({ summary: captured })]);
    expect(rendered).toContain("Batch ceiling: 37.");
    expect(rendered).toContain("Empty parcel labels return null.");
    expect(rendered).toContain("npm run check");
  });

  it.each(["codex", "claude-code"])("finds the original task after unrelated sessions written by %s", (runtime) => {
    const entries = [checkpoint({ runtime }), ...["Log retention is nine days.", "Queue concurrency is five.", "Backups start at dawn."].map((summary, i) =>
      checkpoint({ runtime, goal: "Explain archive operations", summary, sessionId: `interlude-${i}`, turnId: `${i}`, occurredAt: `2026-10-17T01:0${i + 1}:00.000Z` })
    )];
    const selected = selectHotCheckpoints(snapshot(entries), "Implement parcel batching, preserving the contract", "repo:alpha");
    expect(selected[0]?.summary).toContain("37 items");
    expect(renderHotCheckpoints(selected)).not.toContain("Backups start");
  });

  it("prefers a relevant peer finding over recent unrelated activity in the reader's runtime", () => {
    const peer = checkpoint({ runtime: "claude-code" });
    const own = checkpoint({ goal: "Explain deployment", summary: "The deploy region is west.", occurredAt: "2026-10-17T02:00:00.000Z" });
    expect(selectHotCheckpoints(snapshot([peer, own]), "Resume parcel batching")[0]?.runtime).toBe("claude-code");
  });

  it("labels the latest correction and retains the earlier finding as historical", () => {
    const corrected = checkpoint({ runtime: "claude-code", summary: "Correction: parcel batches hold 43 items, replacing 37.", occurredAt: "2026-10-17T02:00:00.000Z" });
    const selected = selectHotCheckpoints(snapshot([checkpoint(), corrected]), "Resume parcel batching");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.summary).toBe(corrected.summary);
    const delivered = renderHotCheckpoints(selected);
    expect(delivered).toContain("43 items, replacing 37");
    expect(delivered).toContain("Earlier agent findings (may be superseded");
    expect(delivered).toContain("37 items");
  });

  it("preserves sources and prior decisions across host updates, duplicated scopes and source conflicts", () => {
    for (const source of ["codex", "claude-code"]) for (const receiver of ["codex", "claude-code"]) {
      for (const conflict of [false, true]) for (const reversed of [false, true]) {
	const original = checkpoint({ runtime: source, summary: "Decision: verify the carrier receipt before submission.",
	  evidence: { version: 1, coverage: "bounded", omitted: 0, sources: [{ source: "spec.txt", text: "Dimensions are integer millimetres.", sha256: "", truncated: false }] } });
	const next = checkpoint({ runtime: receiver, sessionId: "later", turnId: "later", summary: "Latest note: implementation reviewed.", occurredAt: "2026-10-17T02:00:00Z",
	  evidence: conflict ? { version: 1, coverage: "bounded", omitted: 0, sources: [{ source: "spec.txt", text: "Dimensions are integer centimetres.", sha256: "", truncated: false }] } : undefined });
	const scopes = [original, next, original, next].map(entry => ({ scope: entry.runtime, content: JSON.stringify({ continuityCheckpoints: [entry] }) }));
	const selected = selectHotCheckpoints({ scopes: reversed ? scopes.reverse() : scopes }, original.goal, original.workspaceId);
	expect(selected).toHaveLength(1);
	expect(selected[0]?.summary).toBe(next.summary);
	expect(selected[0]?.evidence?.sources).toHaveLength(conflict ? 2 : 1);
	expect(selected[0]?.earlierFindings).toHaveLength(1);
	const delivered = renderHotCheckpoints(selected);
	expect(delivered).toContain("integer millimetres");
	expect(delivered).toContain("verify the carrier receipt before submission");
	if (conflict) {
	  expect(delivered).toContain("integer centimetres");
	  expect(delivered).toContain("multiple observed versions; reconcile");
	}
	expect(delivered.length).toBeLessThanOrEqual(HOT_CONTEXT_LIMIT);
      }
    }
  });

  it("does not collapse requests with distinct case or whitespace literals", () => {
    for (const [a, b] of [["AbC", "abc"], ["a  b", "a b"]]) {
      const entries = [checkpoint({ goal: `Apply code "${a}"` }), checkpoint({ goal: `Apply code "${b}"`, turnId: "other" })];
      expect(selectHotCheckpoints(snapshot(entries), "Apply code", "repo:alpha")).toHaveLength(2);
    }
  });

  it("does not use an empty request as proof that unrelated turns are the same task", () => {
    const initial = checkpoint({ goal: "", evidence: { version: 1, coverage: "bounded", omitted: 0, sources: [{ source: "first.txt", text: "OLD_TASK_ONLY", sha256: "", truncated: false }] } });
    const next = checkpoint({ goal: "", sessionId: "other", turnId: "other", summary: "Unrelated update", occurredAt: "2026-10-17T02:00:00Z" });
    const stored = updateHotCheckpoints(updateHotCheckpoints([], initial), next);
    expect(stored.at(-1)?.evidence).toBeUndefined();
    expect(renderHotCheckpoints(selectHotCheckpoints(snapshot(stored), null, "repo:alpha"))).not.toContain("OLD_TASK_ONLY");
  });

  it("can retrieve an earlier decision after a later same-task summary omits its terms", () => {
    const entries = [checkpoint({ summary: "Validate the freight receipt before submission." }),
      checkpoint({ summary: "Implementation reviewed", turnId: "next", occurredAt: "2026-10-17T02:00:00Z" }),
      checkpoint({ goal: "Restart archive jobs", summary: "Archive ready", turnId: "unrelated", occurredAt: "2026-10-17T03:00:00Z" })];
    const chosen = selectHotCheckpoints(snapshot(entries), "Continue the freight receipt work", "repo:alpha");
    expect(renderHotCheckpoints(chosen)).toContain("freight receipt");
    expect(renderHotCheckpoints(chosen)).not.toContain("Archive ready");
  });

  it("does not let a large selected history starve the second selected task", () => {
    const delivered = renderHotCheckpoints([
      { ...checkpoint({ summary: "Large first-task finding. ".repeat(300) }), earlierFindings: [{ runtime: "codex", occurredAt: "2026-10-17T01:00:00Z", summary: "Earlier observation. ".repeat(300) }] },
      checkpoint({ goal: "Apply the scoped amendment", summary: "Only the beta region changes; preserve all other regions." }),
    ]);
    expect(delivered).toContain("Only the beta region changes");
    expect(delivered.length).toBeLessThanOrEqual(HOT_CONTEXT_LIMIT);
  });

  it("rejects other workspace findings even when their terms are a better match", () => {
    expect(selectHotCheckpoints(snapshot([checkpoint()]), "parcel batching", "repo:beta")).toEqual([]);
    expect(selectHotCheckpoints({ continuityCheckpoints: [checkpoint({ workspaceId: "repo:beta" })] }, "parcel", "repo:alpha")).toEqual([]);
  });

  it("bounds captured findings, retained history and the delivered payload", () => {
    let entries: HotContinuityCheckpoint[] = [];
    for (let i = 0; i < 30; i++) entries = updateHotCheckpoints(entries, checkpoint({ turnId: String(i), summary: "Bounded evidence. ".repeat(800) }));
    expect(entries.length).toBeLessThanOrEqual(12);
    expect(entries.reduce((n, entry) => n + entry.goal.length + entry.summary.length, 0)).toBeLessThanOrEqual(72000);
    expect(entries.every((entry) => entry.summary.length <= HOT_FINDING_LIMIT)).toBe(true);
    expect(renderHotCheckpoints(entries).length).toBeLessThanOrEqual(HOT_CONTEXT_LIMIT);
    expect(entries.at(-1)?.turnId).toBe("29");
  });

  it("replaces a repeated turn checkpoint without discarding other turns", () => {
    let entries = updateHotCheckpoints([], checkpoint());
    entries = updateHotCheckpoints(entries, checkpoint({ turnId: "next", summary: "Verification passed." }));
    entries = updateHotCheckpoints(entries, checkpoint({ summary: "Parcel batches contain 43 items." }));
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.summary)).toContain("Verification passed.");
  });

  it("delivers task findings when the hosted paid pack is unavailable", () => {
    const context = renderRuntimeStartupContext({ runtime: "claude-code", profileName: "default", mode: "assist",
      status: null, manifest: null, inbox: null, dreamReview: null, obligations: null, actions: [], warnings: [],
      injectedContext: "", hotMemorySnapshot: snapshot([checkpoint()]), goal: "Implement parcel batching",
    });
    expect(context).toContain("37 items");
    expect(context).toContain("input order");
  });
});

describe("native transcript capture", () => {
  it.each(["claude", "codex"])("recovers %s assistant text past a partial write, ignoring reasoning and foreign sessions", (runtime) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ob-transcript-"));
    try {
      const file = path.join(dir, "transcript.jsonl");
      const message = { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }, { type: "text", text: "Exact limit is 37 parcels." }] };
      writeFileSync(file, [
	JSON.stringify(runtime === "claude" ? { sessionId: "ours", type: "assistant", message } : { type: "response_item", payload: message }),
	JSON.stringify({ sessionId: "foreign", message: { role: "assistant", content: "WRONG_SESSION" } }),
	'{"partial":',
      ].join("\n"));
      expect(readLastAssistantMessage(file, "ours")).toBe("Exact limit is 37 parcels.");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
