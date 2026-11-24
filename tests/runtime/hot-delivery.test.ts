import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HostRuntimeAdapterBase, type HostAdapterIdentity } from "../../src/runtime/host-adapter-base";
import { releaseSessionStartContext, resetSessionDelivery, HOT_REDELIVERY_PROMPTS } from "../../src/runtime/hook-session-context";
import { renderHotCheckpoints, selectHotCheckpoints, type HotContinuityCheckpoint } from "../../src/runtime/hot-continuity";
import type { LocalRuntimeClient } from "../../src/runtime/local-client";

const workspaceId = "repo:/fixture";
const checkpoint = (overrides: Partial<HotContinuityCheckpoint> = {}): HotContinuityCheckpoint => ({
  runtime: "codex", workspaceId, sessionId: "earlier", turnId: "inspect",
  goal: "Investigate the parcel batching contract", summary: "Parcel batches contain at most 37 items.",
  occurredAt: "2026-10-17T01:00:00.000Z", ...overrides,
});
const snapshotOf = (entries: HotContinuityCheckpoint[]) => ({ scope: "all", scopes: [{
  scope: "codex", content: JSON.stringify({ workspaceId, continuityCheckpoints: entries }),
}] });

class Adapter extends HostRuntimeAdapterBase {
  protected readonly identity: HostAdapterIdentity;
  protected readonly config;
  constructor(protected readonly client: LocalRuntimeClient, runtimeHome: string, runtimeId: "codex" | "claude-code" | "pi" = "codex") {
    super();
    this.identity = { runtimeId, wrapperVersionFallback: "test", requestLabel: "Codex" } as HostAdapterIdentity;
    this.config = { profileName: "default", hostHome: "/host", adapterVersion: "test", runtimeHome };
  }
  protected async attachWorkspace(): Promise<void> {}
}

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

const harness = (entries: HotContinuityCheckpoint[], runtimeId: "codex" | "claude-code" | "pi" = "codex", wrapper = true) => {
  const home = mkdtempSync(path.join(tmpdir(), "crosshead-hot-delivery-"));
  homes.push(home);
  if (wrapper) {
    mkdirSync(path.join(home, "bin"), { recursive: true });
    for (const name of ["crosshead-codex", "crosshead-claude-code"]) writeFileSync(path.join(home, "bin", name), "#!/bin/sh\n", { mode: 0o755 });
  }
  let snapshot = snapshotOf(entries);
  const client = {
    readHotMemory: async () => snapshot,
    emitEvent: async () => ({ mode: "assist", warnings: [], contextPack: null }),
    status: async () => ({ profile: { memoryMode: "assist" } }),
  } as unknown as LocalRuntimeClient;
  const adapter = new Adapter(client, home, runtimeId);
  const prompt = async (text: string, options: { sessionStart?: boolean; sessionId?: string } = {}) =>
    (await adapter.prepareTurn({ workspaceRoot: "/fixture", workspaceId, sessionId: options.sessionId ?? "s1", turnId: `t-${Math.random()}`, prompt: text, sessionStart: options.sessionStart ?? false })).contextText;
  return { home, prompt, setEntries: (next: HotContinuityCheckpoint[]) => { snapshot = snapshotOf(next); } };
};

describe("hot checkpoint delivery per session", () => {
  it("sends the full checkpoint at session start even when the prompt shares no terms", async () => {
    const h = harness([checkpoint()]);
    const text = await h.prompt("continue", { sessionStart: true });
    expect(text).toContain("Parcel batches contain at most 37 items.");
    expect(text).toContain("Crosshead hooks automatically capture your final response");
  });

  it("does not resend a checkpoint the session already received, and omits the capture contract after the first prompt", async () => {
    const h = harness([checkpoint()]);
    expect(await h.prompt("Resume parcel batching", { sessionStart: true })).toContain("37 items");
    const second = await h.prompt("Resume parcel batching");
    expect(second).not.toContain("37 items");
    expect(second).not.toContain("Crosshead hooks automatically capture your final response");
    expect(second).not.toContain("saved checkpoint for");
  });

  it("reduces an unrelated checkpoint to a one-line pointer after the first prompt, once", async () => {
    const h = harness([checkpoint(), checkpoint({ goal: "Tune the retry backoff", summary: "Backoff doubles from 200 ms.", turnId: "retry", occurredAt: "2026-10-17T00:30:00.000Z" })]);
    // The session's first prompt receives what it selects in full.
    await h.prompt("Tune the retry backoff", { sessionId: "s2", sessionStart: true });
    const first = await h.prompt("Rename the logging helper in utils", { sessionId: "s2" });
    expect(first).not.toContain("37 items");
    const pointer = first.split("\n").filter(line => line.includes("saved checkpoint for"));
    expect(pointer).toHaveLength(1);
    expect(pointer[0]).toContain('"Investigate the parcel batching contract"');
    expect(pointer[0]).toContain("checkpoint-page 1");
    expect(pointer[0]).toContain("--key ");
    expect(first).not.toContain("excerpt only");
    expect(await h.prompt("Rename the logging helper in utils", { sessionId: "s2" })).not.toContain("saved checkpoint for");
    // Once the prompt relates to it, the session gets the checkpoint itself.
    expect(await h.prompt("What did the parcel batching investigation find?", { sessionId: "s2" })).toContain("37 items");
  });

  it("resends after compaction, after a checkpoint change and after the redelivery interval", async () => {
    const h = harness([checkpoint()]);
    await h.prompt("Resume parcel batching", { sessionStart: true });
    resetSessionDelivery(h.home, "codex", { sessionId: "s1" });
    const afterCompaction = await h.prompt("Resume parcel batching");
    expect(afterCompaction).toContain("37 items");
    expect(afterCompaction).toContain("Crosshead hooks automatically capture your final response");
    releaseSessionStartContext(h.home, "codex", workspaceId);
    expect(await h.prompt("Resume parcel batching")).toContain("37 items");
    h.setEntries([checkpoint({ summary: "Parcel batches contain at most 43 items.", occurredAt: "2026-10-17T03:00:00.000Z", turnId: "later" })]);
    expect(await h.prompt("Resume parcel batching")).toContain("43 items");
    const repeats: boolean[] = [];
    for (let index = 0; index < HOT_REDELIVERY_PROMPTS; index += 1) repeats.push((await h.prompt("Resume parcel batching")).includes("43 items"));
    // Withheld while the session holds it, then sent exactly once when the interval passes.
    expect(repeats.filter(Boolean)).toHaveLength(1);
    expect(repeats[0]).toBe(false);
  });

  it("delivers an explicit save once even when unrelated to the prompt", async () => {
    const save = checkpoint({ origin: "remember", goal: "", summary: "Remember: staging deploys need the blue key.", turnId: "remember-1", occurredAt: "2026-10-17T02:00:00.000Z" });
    const h = harness([checkpoint(), save]);
    const first = await h.prompt("Resume parcel batching", { sessionStart: true });
    expect(first).toContain("staging deploys need the blue key");
    expect(await h.prompt("Resume parcel batching")).not.toContain("blue key");
  });

  it("keeps sessions independent", async () => {
    const h = harness([checkpoint()]);
    await h.prompt("Resume parcel batching", { sessionStart: true, sessionId: "a" });
    expect(await h.prompt("Resume parcel batching", { sessionStart: true, sessionId: "b" })).toContain("37 items");
  });

  it("works without a host wrapper and leaves other hosts unchanged", async () => {
    const plain = harness([checkpoint()], "codex", false);
    expect(await plain.prompt("Resume parcel batching", { sessionStart: true })).toContain("37 items");
    expect(await plain.prompt("Resume parcel batching")).not.toContain("37 items");
    const two = harness([checkpoint(), checkpoint({ goal: "Tune the retry backoff", summary: "Backoff doubles from 200 ms.", turnId: "retry", occurredAt: "2026-10-17T00:30:00.000Z" })], "codex", false);
    await two.prompt("Tune the retry backoff", { sessionId: "s3", sessionStart: true });
    const pointer = await two.prompt("Rename the logging helper", { sessionId: "s3" });
    expect(pointer).toContain("saved checkpoint for");
    expect(pointer).toContain('search it with: crosshead memory search "<query>"');
    const pi = harness([checkpoint()], "pi");
    expect(await pi.prompt("Resume parcel batching")).toContain("37 items");
    expect(await pi.prompt("Resume parcel batching")).toContain("37 items");
  });
});

describe("delivery edge cases from review", () => {
  it("gives a session that holds nothing the full checkpoint even when the start claim was lost", async () => {
    const h = harness([checkpoint()]);
    // sessionStart false (failed claim, auto-compaction, racing hook) but no record yet.
    const text = await h.prompt("continue", { sessionId: "fresh" });
    expect(text).toContain("37 items");
    expect(text).not.toContain("saved checkpoint for");
    await h.prompt("continue", { sessionId: "fresh" });
    resetSessionDelivery(h.home, "codex", { sessionId: "fresh" });
    expect(await h.prompt("continue", { sessionId: "fresh" })).toContain("37 items");
  });

  it("does not let another session's write undo a compaction reset", async () => {
    const h = harness([checkpoint()]);
    await h.prompt("Resume parcel batching", { sessionStart: true, sessionId: "a" });
    await h.prompt("Resume parcel batching", { sessionStart: true, sessionId: "b" });
    resetSessionDelivery(h.home, "codex", { sessionId: "a" });
    await h.prompt("Resume parcel batching", { sessionId: "b" });
    expect(await h.prompt("Resume parcel batching", { sessionId: "a" })).toContain("37 items");
  });

  it("does not send a session its own checkpoints until compaction", async () => {
    const own = checkpoint({ sessionId: "s1", turnId: "own", summary: "Own finding: parcel weights are grams.", occurredAt: "2026-10-17T05:00:00.000Z" });
    const h = harness([own]);
    await h.prompt("Resume parcel batching", { sessionStart: true });
    h.setEntries([{ ...own, summary: "Own finding: parcel weights are kilograms.", occurredAt: "2026-10-17T06:00:00.000Z" }]);
    expect(await h.prompt("Resume parcel batching")).not.toContain("kilograms");
    resetSessionDelivery(h.home, "codex", { sessionId: "s1" });
    expect(await h.prompt("Resume parcel batching")).toContain("kilograms");
  });
});

describe("selection labels", () => {
  it("marks a zero-score top entry unrelated and a matching one related", () => {
    const snapshot = snapshotOf([checkpoint()]);
    expect(selectHotCheckpoints(snapshot, "Rename the logging helper")[0]?.match).toBe("unrelated");
    expect(selectHotCheckpoints(snapshot, "Resume parcel batching")[0]?.match).toBe("related");
    expect(renderHotCheckpoints(selectHotCheckpoints(snapshot, "x"))).toContain("37 items");
  });
});
