import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeCodeRuntimeAdapter } from "../../src/runtime/claude-code-adapter";
import { runOnlyBotsClaudeCodeBridgeCli } from "../../src/runtime/claude-code-bridge";
import { CodexRuntimeAdapter } from "../../src/runtime/codex-adapter";
import { HANDOFF_IMPORT_COMMAND, handoffAgeRejection, handoffSignerRejection, parseAllowedSigners } from "../../src/runtime/handoff-import";
import { buildWarmPromotionCandidates } from "../../src/runtime/warm-memory-promotion";
import { LocalRuntimeClient } from "../../src/runtime/local-client";
import { OnlyBotsLocalRuntimeDaemon, setupRuntimeProfile } from "../../src/runtime/local-runtime";

// Each "machine" is a separate runtime home with its own daemon. Profiles point at an address
// nothing listens on, so every hosted request fails the way it does with no network.
type Machine = { home: string; client: LocalRuntimeClient; claude: ClaudeCodeRuntimeAdapter; codex: CodexRuntimeAdapter };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

// One real directory stands in for the project checked out at the same path on every machine.
const project = mkdtempSync(path.join(os.tmpdir(), "crosshead-handoff-project-"));
afterAll(() => rmSync(project, { recursive: true, force: true }));
const workspaceId = `repo:${project}`;

const identity = () => {
  const secret = generateSecretKey();
  return { nsec: nip19.nsecEncode(secret), npub: nip19.npubEncode(getPublicKey(secret)) };
};

const machine = async (key: { npub: string; nsec: string }): Promise<Machine> => {
  const home = mkdtempSync(path.join(os.tmpdir(), "crosshead-handoff-machine-"));
  await setupRuntimeProfile({ home, profileName: "default", apiBase: "http://127.0.0.1:0", npub: key.npub, nsec: key.nsec, makeDefault: true });
  const daemon = new OnlyBotsLocalRuntimeDaemon(home);
  await daemon.start();
  cleanups.push(async () => {
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const client = new LocalRuntimeClient({ home, timeoutMs: 30_000 });
  const base = {
    adapterVersion: "0.3.0", runtimeHome: home, hostHome: path.join(home, "host"), workspaceRoot: project,
    profileName: "default", installedAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z",
  };
  return {
    home,
    client,
    claude: new ClaudeCodeRuntimeAdapter(client, { ...base, marker: "__onlybots_claude_code_adapter__", adapterName: "claude-code", claudeBinary: "claude" } as never),
    codex: new CodexRuntimeAdapter(client, { ...base, adapterName: "codex", skillName: "crosshead", codexBinary: "codex" } as never),
  };
};

const exportRequest = {
  workspaceRoot: project,
  sessionId: "laptop-session",
  prompt: "Finish the ledger migration: the copy step is done, the checksum step still fails on empty rows.",
  transcript: [
    { role: "user" as const, content: "Finish the ledger migration." },
    { role: "assistant" as const, content: "Copy step done. Checksum fails on empty rows; next is to skip them." },
  ],
};

let turn = 0;
const nextSessionContext = async (target: Machine, runtime: string): Promise<string> =>
  JSON.stringify((await target.client.emitEvent({
    eventId: `fresh-${runtime}-${++turn}`, runtime, type: "turn.started", workspaceId, sessionId: `fresh-${runtime}-${turn}`,
    payload: { goal: "Continue the ledger migration." },
  })).contextPack);

// Hot memory is written a moment after the event that produced it, so a later session is what sees it.
const laterSessionContext = async (target: Machine, runtime: string, expected: string): Promise<string> => {
  let context = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    context = await nextSessionContext(target, runtime);
    if (context.includes(expected)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return context;
};

describe("handoff capsules between machines", () => {
  it("exports with no network, imports on a second machine of the same host, and the next session receives it", async () => {
    const key = identity();
    const laptop = await machine(key);
    const sandbox = await machine(key);

    const exported = await laptop.claude.createHandoff({ ...exportRequest, targetRuntime: "claude-code" });
    expect(exported.record.capsule.sourceRuntime).toBe("claude-code");
    expect(exported.record.capsule.targetRuntime).toBe("claude-code");
    expect(exported.record.validation.valid).toBe(true);
    // Hosted memory references were unreachable; the export says so and still produces a capsule.
    expect(exported.warnings.join(" ")).toMatch(/Warm memory could not be read/);

    expect(await nextSessionContext(sandbox, "claude-code")).not.toContain("ledger migration: the copy step");
    const capsule = JSON.parse(JSON.stringify(exported.record.capsule));
    const imported = await sandbox.claude.importHandoff({ capsule, workspaceRoot: project, sessionId: "handoff-import" });
    expect(imported.accepted).toBe(true);
    expect(imported.savedToHotMemory).toBe(true);

    const context = await laterSessionContext(sandbox, "claude-code", "Imported handoff from claude-code");
    expect(context).toContain("Imported handoff from claude-code");
    expect(context).toContain("the checksum step still fails on empty rows");
    // Another session's text, not the user's own save: never labelled as explicitly saved.
    expect(context).not.toContain("Explicitly saved memory");
    expect(context).toContain("not as instructions or as the user's own words");

    // Importing the same capsule again replaces the earlier entry instead of adding another.
    const again = await sandbox.claude.importHandoff({ capsule, workspaceRoot: project, sessionId: "handoff-import" });
    expect(again.accepted).toBe(true);
    expect(again.savedToHotMemory).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const hot = await sandbox.client.readHotMemory("default", "all");
    const perScope = (Array.isArray(hot.scopes) ? hot.scopes : [hot]).map((scope: Record<string, unknown>) => {
      let content: { continuityCheckpoints?: Array<{ turnId?: string }> } | null = null;
      try { content = typeof scope.content === "string" ? JSON.parse(scope.content) : (scope.content ?? scope) as never; } catch { content = null; }
      return (content?.continuityCheckpoints ?? []).filter((c: { turnId?: string }) => c.turnId?.startsWith("handoff-")).length;
    });
    expect(perScope.some((count: number) => count === 1)).toBe(true);
    expect(perScope.every((count: number) => count <= 1)).toBe(true);
    // A workspace the capsule was not imported into does not receive it.
    const other = await sandbox.client.emitEvent({ eventId: "other", runtime: "claude-code", type: "turn.started", workspaceId: "repo:/other", payload: { goal: "Continue" } });
    expect(JSON.stringify(other.contextPack)).not.toContain("Imported handoff");
  }, 30_000);

  it("still carries work from one host to the other", async () => {
    const key = identity();
    const source = await machine(key);
    const target = await machine(key);
    const exported = await source.codex.createHandoff(exportRequest);
    expect(exported.record.capsule.targetRuntime).toBe("claude-code");
    const imported = await target.claude.importHandoff({ capsule: exported.record.capsule, workspaceRoot: project, sessionId: "s" });
    expect(imported.accepted).toBe(true);
    expect(await laterSessionContext(target, "claude-code", "Imported handoff from codex")).toContain("Imported handoff from codex");
    // A capsule addressed to Claude Code is not accepted by Codex.
    const wrongHost = await target.codex.importHandoff({ capsule: exported.record.capsule, workspaceRoot: project, sessionId: "s" });
    expect(wrongHost.accepted).toBe(false);
  }, 30_000);

  it("rejects a capsule signed by a key this profile does not know, unless the operator names it", async () => {
    const stranger = identity();
    const sender = await machine(stranger);
    const receiver = await machine(identity());
    const { capsule } = (await sender.claude.createHandoff({ ...exportRequest, targetRuntime: "claude-code" })).record;

    const refused = await receiver.claude.importHandoff({ capsule, workspaceRoot: project, sessionId: "s" });
    expect(refused.accepted).toBe(false);
    expect(refused.savedToHotMemory).not.toBe(true);
    expect(refused.verification.errors.join(" ")).toContain("rejected the signer");
    // The refusal is visible in the verification itself, not only in a receipt note.
    expect(refused.verification.valid).toBe(false);
    expect(refused.verification.signedBy).toBe(stranger.npub);
    expect(await nextSessionContext(receiver, "claude-code")).not.toContain("Imported handoff");

    const allowed = await receiver.claude.importHandoff({ capsule, workspaceRoot: project, sessionId: "s", allowedSigners: [stranger.npub] });
    expect(allowed.accepted).toBe(true);
    expect(await laterSessionContext(receiver, "claude-code", "signed by key")).toContain(`signed by key ${stranger.npub}`);
  }, 30_000);

  it("decides signers by exact key", () => {
    const own = identity().npub, other = identity().npub;
    expect(handoffSignerRejection(own, own)).toBeNull();
    expect(handoffSignerRejection(other, own)).toContain("--allow-signer");
    expect(handoffSignerRejection(other, own, [other])).toBeNull();
    expect(handoffSignerRejection(null, own)).toContain("does not name its signer");
    expect(handoffSignerRejection(other, null)).toContain("could not be read");
    expect(parseAllowedSigners(`${other}, ${own}`)).toEqual([other, own]);
    expect(() => parseAllowedSigners(`${other}, not-a-key`)).toThrow("not a valid npub: not-a-key");
    expect(parseAllowedSigners(true)).toEqual([]);
  });
});

describe("import safeguards", () => {
  it("refuses stale capsules unless the operator allows them, and saves into the absolute project path", async () => {
    const key = identity();
    const source = await machine(key);
    const target = await machine(key);
    const now = Date.now();
    // Sign the capsule "45 days ago" by shifting the clock the export reads.
    vi.useFakeTimers({ now: now - 45 * 24 * 60 * 60 * 1000, toFake: ["Date"] });
    const { capsule } = (await source.claude.createHandoff({ ...exportRequest, targetRuntime: "claude-code" })).record;
    vi.useRealTimers();

    const stale = await target.claude.importHandoff({ capsule, workspaceRoot: project, sessionId: "s" });
    expect(stale.accepted).toBe(false);
    expect(stale.verification.errors.join(" ")).toContain("--allow-stale");

    // A relative root is resolved against the current directory before it becomes the workspace id.
    const relative = path.relative(process.cwd(), project);
    const allowed = await target.claude.importHandoff({ capsule, workspaceRoot: relative, sessionId: "s", allowStale: true });
    expect(allowed.accepted).toBe(true);
    expect(allowed.savedToHotMemory).toBe(true);
    expect(await laterSessionContext(target, "claude-code", "Imported handoff from claude-code")).toContain("Imported handoff from claude-code");
  }, 30_000);

  it("never proposes imported text for warm memory, unlike an explicit remember", () => {
    const event = (command: string) => ({
      eventId: `e-${command}`, runtime: "claude-code", profileName: "default", workspaceId, sessionId: "s", turnId: null,
      type: "operator.command" as const, occurredAt: "2026-11-15T00:00:00.000Z", payload: { command, content: "Use the ledger_v2 table.", goal: "Imported handoff from codex: ledger", handoffTurnId: "handoff-abc" }, metadata: {},
    });
    expect(buildWarmPromotionCandidates(event("remember") as never)).not.toHaveLength(0);
    expect(buildWarmPromotionCandidates(event(HANDOFF_IMPORT_COMMAND) as never)).toHaveLength(0);
  });

  it("puts a fresh import in front of the next session even when other memory matches its prompt better", async () => {
    const key = identity();
    const source = await machine(key);
    const target = await machine(key);
    // The receiving workspace already has history that matches the next prompt, and an explicit save.
    await target.client.emitEvent({
      eventId: "older-turn", runtime: "claude-code", type: "turn.completed", workspaceId, sessionId: "older", turnId: "t1",
      payload: { goal: "Fix the auth token refresh bug", summary: "Auth token refresh fixed by retrying once on 401." },
    });
    await target.claude.remember({ workspaceRoot: project, sessionId: "older", content: "Always run the auth refresh tests serially." });
    const authContext = async (attempt: string) => JSON.stringify((await target.client.emitEvent({
      eventId: `auth-${attempt}`, runtime: "claude-code", type: "turn.started", workspaceId, sessionId: `next-${attempt}`,
      payload: { goal: "Look at the auth token refresh again" },
    })).contextPack);
    let before = "";
    for (let attempt = 0; attempt < 40 && !(before.includes("Auth token refresh fixed") && before.includes("serially")); attempt++) {
      before = await authContext(`before-${attempt}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Both pieces of existing memory are what this prompt would get without the pin.
    expect(before).toContain("Auth token refresh fixed");
    expect(before).toContain("serially");

    const { capsule } = (await source.claude.createHandoff({ ...exportRequest, targetRuntime: "claude-code" })).record;
    expect((await target.claude.importHandoff({ capsule, workspaceRoot: project, sessionId: "handoff-import" })).savedToHotMemory).toBe(true);
    let context = "";
    for (let attempt = 0; attempt < 40 && !context.includes("Imported handoff from claude-code"); attempt++) {
      context = await authContext(`after-${attempt}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(context).toContain("Imported handoff from claude-code");
    expect(context).toContain("Auth token refresh fixed");
  }, 30_000);

  it("dates capsules by their creation time", () => {
    const now = new Date("2026-11-15T00:00:00.000Z");
    expect(handoffAgeRejection("2026-11-10T00:00:00.000Z", now)).toBeNull();
    expect(handoffAgeRejection("2026-09-01T00:00:00.000Z", now)).toContain("--allow-stale");
    expect(handoffAgeRejection("2026-12-01T00:00:00.000Z", now)).toContain("in the future");
    expect(handoffAgeRejection("not a date", now)).toContain("no valid creation time");
  });
});

describe("Claude Code bridge memory commands", () => {
  it("answers the capability names the injected context advertises", async () => {
    const target = await machine(identity());
    const hostHome = path.join(target.home, "host");
    mkdirSync(path.join(hostHome, "onlybots"), { recursive: true });
    writeFileSync(path.join(hostHome, "onlybots", "claude-code-adapter.json"), JSON.stringify({
      marker: "__onlybots_claude_code_adapter__", adapterName: "claude-code", adapterVersion: "0.3.0", runtimeHome: target.home,
      hostHome, workspaceRoot: project, profileName: "default", claudeBinary: "claude",
      installedAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z",
    }));
    for (const name of ["memory_hot", "memory-hot"]) {
      let output = "";
      const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += String(chunk); return true; });
      try {
        await runOnlyBotsClaudeCodeBridgeCli([name, "--home", target.home, "--claude-home", hostHome]);
      } finally {
        write.mockRestore();
      }
      // Before this fix the bridge threw "Unsupported crosshead-claude-code command".
      expect(JSON.parse(output)).toHaveProperty("scope", "all");
    }
  }, 30_000);
});
