import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { renderHotCheckpoints, updateHotCheckpoints, selectHotCheckpoints, type HotContinuityCheckpoint } from "../../src/runtime/hot-continuity";
import { normalizeTaskEvidence, withWorkspaceState, type TaskEvidence } from "../../src/runtime/task-evidence";
import { describeWorkspaceDrift, fileExcerptState, normalizeWorkspaceGitState, readWorkspaceGitState, sourceFilePath } from "../../src/runtime/workspace-state";
import { buildCapturedContinuityContext, normalizeCapturedContextToContinuityIr, validateContinuityIr } from "../../src/runtime/continuity-ir";
import { RuntimeLifecycleManager } from "../../src/runtime/lifecycle-engine";
import { buildContinuityGovernorState } from "../../src/runtime/continuity-governor";
import { buildDefaultContinuityPolicy } from "../../src/runtime/continuity-policy";
import { HANDOFF_IMPORT_COMMAND } from "../../src/runtime/handoff-import";
import { validHotSyncDocument, HOT_SYNC_VERSION } from "../../src/protocol/hot-sync";
import { retainHotSync } from "../../src/runtime/hot-sync-replica";
import { chmodSync } from "node:fs";
import { vi } from "vitest";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { readLocalHotMemory } from "../../src/runtime/local-hot-memory";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
const repo = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "crosshead-git-state-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  writeFileSync(path.join(root, "rules.md"), "Batches hold 37 items.\n");
  git(root, "add", "rules.md");
  git(root, "commit", "-q", "-m", "init");
  return root;
};
const evidence = (sources: TaskEvidence["sources"] = []): TaskEvidence => ({ version: 1, sources, coverage: "bounded", omitted: 0 });
const checkpoint = (ev: TaskEvidence): HotContinuityCheckpoint => ({
  runtime: "codex", workspaceId: "repo:/w", sessionId: "s", turnId: "t", goal: "Fix parcel batching", summary: "Tests passed.", occurredAt: "2026-11-23T00:00:00.000Z", evidence: ev,
});

describe("checkpoint git state", () => {
  it("records head, branch, dirty and untracked files, and skips private names", () => {
    const root = repo();
    writeFileSync(path.join(root, "scripts.py"), "print(1)\n");
    writeFileSync(path.join(root, ".env"), "TOKEN=x\n");
    const state = readWorkspaceGitState(root)!;
    expect(state.head).toBe(git(root, "rev-parse", "HEAD"));
    expect(state.branch).toBe("main");
    expect(state.dirty).toBe(true);
    expect(state.untracked.map(file => file.path)).toEqual(["scripts.py"]);
    expect(state.untracked[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(state.untrackedOmitted).toBe(1);
    expect(normalizeWorkspaceGitState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("returns null outside git and never throws", () => {
    const plain = mkdtempSync(path.join(tmpdir(), "crosshead-no-git-"));
    dirs.push(plain);
    expect(readWorkspaceGitState(plain)).toBeNull();
    expect(readWorkspaceGitState(path.join(plain, "missing"))).toBeNull();
  });

  it("says nothing in the same checkout and one line after the tree moves", () => {
    const root = repo();
    writeFileSync(path.join(root, "tool.py"), "print(1)\n");
    const then = readWorkspaceGitState(root)!;
    expect(describeWorkspaceDrift(then, readWorkspaceGitState(root), root)).toBe("");
    rmSync(path.join(root, "tool.py"));
    writeFileSync(path.join(root, "rules.md"), "Batches hold 43 items.\n");
    git(root, "commit", "-q", "-am", "change");
    const line = describeWorkspaceDrift(then, readWorkspaceGitState(root), root);
    expect(line.split("\n")).toHaveLength(1);
    // A commit on top of the saved one is progress: one neutral clause, no uncommitted-changes warning.
    expect(line).toContain(`moved forward from ${then.head!.slice(0, 10)} to ${git(root, "rev-parse", "HEAD").slice(0, 10)} on main`);
    expect(line).toContain("untracked tool.py is not present here");
    expect(line).not.toContain("uncommitted changes that are not in this tree");
  });

  it("states a plain forward move without a warning, and still warns when the saved commit is not an ancestor", () => {
    const root = repo();
    writeFileSync(path.join(root, "rules.md"), "Batches hold 40 items.\n");
    const then = readWorkspaceGitState(root)!;
    expect(then.dirty).toBe(true);
    git(root, "commit", "-q", "-am", "work");
    const forward = describeWorkspaceDrift(then, readWorkspaceGitState(root), root);
    expect(forward).toBe(`Workspace moved forward from ${then.head!.slice(0, 10)} to ${git(root, "rev-parse", "HEAD").slice(0, 10)} on main since this was written (it was written with uncommitted changes, which may or may not be in these commits).`);
    expect(forward).not.toContain("reread");
    // History rewritten so the saved commit is not an ancestor of HEAD on the same branch: the full warning returns.
    git(root, "checkout", "-q", "--orphan", "rewritten");
    git(root, "commit", "-q", "-m", "unrelated");
    git(root, "branch", "-q", "-M", "main");
    const diverged = describeWorkspaceDrift(then, readWorkspaceGitState(root), root);
    expect(diverged).toContain("Workspace drift (warning only");
    expect(diverged).toContain("uncommitted changes that are not in this tree");
  });

  it("marks command output run at another commit and file excerpts that changed, in rendered checkpoints", () => {
    const root = repo();
    const state = readWorkspaceGitState(root)!;
    const stamped = withWorkspaceState(normalizeTaskEvidence(evidence([
      { source: "rules.md", text: "Batches hold 37 items.", sha256: "", truncated: false },
      { source: "$ npm test", text: "42 passing", sha256: "", truncated: false },
    ]))!, state);
    expect(stamped.sources[1]!.head).toBe(state.head);
    expect(stamped.sources[0]!.head).toBeUndefined();
    const stored = updateHotCheckpoints([], checkpoint(stamped));
    expect(stored[0]!.evidence!.workspace).toEqual(state);
    const same = renderHotCheckpoints(selectHotCheckpoints({ scope: "all", scopes: [{ scope: "codex", content: JSON.stringify({ continuityCheckpoints: stored }) }] }, "parcel batching"), 4200, { root, git: readWorkspaceGitState(root) });
    expect(same).not.toContain("Workspace drift");
    expect(same).not.toContain("[changed on disk");
    expect(same).not.toContain("[ran at");
    writeFileSync(path.join(root, "rules.md"), "Batches hold 43 items.\n");
    git(root, "commit", "-q", "-am", "change");
    const moved = renderHotCheckpoints(stored, 4200, { root, git: readWorkspaceGitState(root) });
    expect(moved).toContain("Workspace moved forward from");
    // The stale excerpt is dropped and the file named once; no reread instruction.
    expect(moved).toContain('Changed on disk since observed (old excerpts omitted; the current files are authoritative): "rules.md"');
    expect(moved).not.toContain("Batches hold 37 items.");
    expect(moved).not.toContain("reread]");
    expect(moved).toContain(`Source "$ npm test" [ran at ${state.head!.slice(0, 10)}`);
  });

  it("keeps the latest git state when a later capture has no sources, and names dropped sources", () => {
    const first = normalizeTaskEvidence({ ...evidence([{ source: "a.md", text: "alpha", sha256: "", truncated: false }]), workspace: { head: "a".repeat(40), branch: "main", dirty: false, untracked: [] } })!;
    const later = { ...evidence(), workspace: { head: "b".repeat(40), branch: "main", dirty: false, untracked: [] } };
    const stored = updateHotCheckpoints(updateHotCheckpoints([], checkpoint(first)), { ...checkpoint(later), turnId: "t" });
    expect(stored[0]!.evidence!.workspace!.head).toBe("b".repeat(40));
    expect(stored[0]!.evidence!.sources[0]!.source).toBe("a.md");
    const many = normalizeTaskEvidence(evidence(Array.from({ length: 12 }, (_, i) => ({ source: `f${i}.md`, text: `body ${i}`, sha256: "", truncated: false }))))!;
    expect(many.omittedSources?.map(entry => entry.source)).toEqual(["f10.md", "f11.md"]);
    expect(renderHotCheckpoints([checkpoint(many)])).toContain('Also observed but not kept (reread if needed): "f10.md" "f11.md"');
  });

  it("older clients' evidence without git state still renders without drift lines", () => {
    const old = normalizeTaskEvidence({ version: 1, coverage: "bounded", omitted: 0, sources: [{ source: "x.md", text: "x", sha256: "", truncated: false }] })!;
    expect(old.workspace).toBeUndefined();
    expect(renderHotCheckpoints([checkpoint(old)], 4200, { root: "/nonexistent-root", git: null })).not.toContain("Workspace drift");
  });

  it("emits nothing in the same checkout for shell-read sources, unhashed untracked entries and large files", () => {
    const root = repo();
    const outside = mkdtempSync(path.join(tmpdir(), "crosshead-outside-"));
    dirs.push(outside);
    mkdirSync(path.join(outside, "lib"));
    symlinkSync(path.join(outside, "lib"), path.join(root, "linked"));
    writeFileSync(path.join(root, "big.bin"), Buffer.alloc(600 * 1024, 1));
    const then = readWorkspaceGitState(root)!;
    expect(then.untracked.find(file => file.path.startsWith("linked"))?.sha256 ?? null).toBeNull();
    expect(describeWorkspaceDrift(then, readWorkspaceGitState(root), root)).toBe("");
    const stored = updateHotCheckpoints([], checkpoint(withWorkspaceState(normalizeTaskEvidence(evidence([
      { source: "sed -n 1,5p rules.md", text: "Batches hold 37 items.", sha256: "", truncated: false },
      { source: "head -n 3 rules.md && cat other.md", text: "Batches hold 37 items.\nother", sha256: "", truncated: false },
    ]))!, then)));
    const same = renderHotCheckpoints(stored, 4200, { root, git: readWorkspaceGitState(root) });
    expect(same).not.toContain("[not present here]");
    expect(same).not.toContain("Workspace drift");
    expect(sourceFilePath("sed -n 1,5p rules.md")).toBe("rules.md");
    expect(sourceFilePath("head -n 3 rules.md && cat other.md")).toBeNull();
    expect(sourceFilePath("src/a.ts")).toBe("src/a.ts");
    expect(sourceFilePath("../etc/passwd")).toBeNull();
  });

  it("rejects synced paths that leave the workspace and never reads through them", () => {
    const root = repo();
    const normalized = normalizeWorkspaceGitState({ head: "a".repeat(40), branch: "main", dirty: true, untracked: [
      { path: "../../../../etc/hostname", sha256: "b".repeat(64) }, { path: "/etc/hostname", sha256: null },
      { path: "ok.py", sha256: null }, { path: "x\0y", sha256: null }, { path: "deploy/.env.production", sha256: null },
    ] })!;
    expect(normalized.untracked.map(file => file.path)).toEqual(["ok.py"]);
    expect(fileExcerptState(root, "../../../../etc/hostname", "x")).toBe("same");
    const outside = mkdtempSync(path.join(tmpdir(), "crosshead-outside-"));
    dirs.push(outside);
    writeFileSync(path.join(outside, "secret.txt"), "outside bytes");
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));
    expect(fileExcerptState(root, "escape.txt", "different")).toBe("same");
  });

  it("does not block on a FIFO", () => {
    const root = repo();
    execFileSync("mkfifo", [path.join(root, "pipe.txt")]);
    const started = Date.now();
    expect(fileExcerptState(root, "pipe.txt", "x")).toBe("same");
    const state = readWorkspaceGitState(root)!;
    expect(describeWorkspaceDrift(state, state, root)).toBe("");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("returns null quickly when git is not on PATH", () => {
    const root = repo();
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try { expect(readWorkspaceGitState(root)).toBeNull(); } finally { process.env.PATH = saved; }
  });

  it("keeps a large checkpoint with metadata under the sync budget and the drift line short", () => {
    const sources = Array.from({ length: 10 }, (_, i) => ({ source: `src/file-${i}.ts`, text: `line ${i}\n`.repeat(900), sha256: "", truncated: false }));
    const workspace = { head: "a".repeat(40), branch: "b".repeat(100), dirty: true,
      untracked: Array.from({ length: 10 }, (_, i) => ({ path: `${"d".repeat(140)}/${i}.py`, sha256: null })) };
    const ev = normalizeTaskEvidence({ ...evidence(sources), workspace, omittedSources: Array.from({ length: 8 }, (_, i) => ({ source: `${"n".repeat(150)}${i}`, sha256: String(i).repeat(64) })) })!;
    const [stored] = updateHotCheckpoints([], { ...checkpoint(ev), goal: "g".repeat(6000), summary: "s".repeat(12000) });
    expect(stored!.goal.length + stored!.summary.length + JSON.stringify(stored!.evidence).length).toBeLessThanOrEqual(29000);
    const line = describeWorkspaceDrift(stored!.evidence!.workspace ?? workspace, { head: "c".repeat(40), branch: "x".repeat(100), dirty: false, untracked: [] }, "/nonexistent-root");
    expect(line.length).toBeLessThanOrEqual(320);
  });

  it("gives up on a slow git within its timeout and records nothing", () => {
    const root = repo();
    const bin = mkdtempSync(path.join(tmpdir(), "crosshead-slow-git-"));
    dirs.push(bin);
    writeFileSync(path.join(bin, "git"), "#!/bin/sh\nsleep 5\n");
    chmodSync(path.join(bin, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    const started = Date.now();
    try { expect(readWorkspaceGitState(root)).toBeNull(); } finally { process.env.PATH = saved; }
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("round-trips git state through a synced document that older clients also accept", () => {
    const evidence = { version: 1, coverage: "bounded", omitted: 0, sources: [], workspace: { head: "a".repeat(40), branch: "main", dirty: false, untracked: [{ path: "tool.py", sha256: null }] } };
    const document = { version: HOT_SYNC_VERSION, namespace: "n", scope: "s", epoch: 0, checkpoints: [{
      id: "c1", deviceId: "d", runtime: "codex", workspaceId: "repo:/w", occurredAt: "2026-11-23T00:00:00.000Z", goal: "g", summary: "s", evidence,
    }] };
    // The wire validator treats evidence as opaque, so a document from this client validates for older ones.
    expect(validHotSyncDocument(document)).toBe(true);
    const kept = retainHotSync(document as never);
    expect(kept.checkpoints[0]!.evidence).toEqual(evidence);
    expect(normalizeTaskEvidence(kept.checkpoints[0]!.evidence)?.workspace?.head).toBe("a".repeat(40));
  });

  it("carries the exporting workspace's git state through a handoff capsule into the imported checkpoint", async () => {
    const root = repo();
    const captured = buildCapturedContinuityContext({ runtime: "codex", workspaceRoot: root, workspaceId: "repo:w", sessionId: "s", turnId: "t",
      prompt: "Continue", transcript: [{ role: "user", content: "Continue" }], task: { objective: "Continue", openLoops: [] } });
    writeFileSync(path.join(root, "customer-export.csv"), "private\n");
    // Not carried unless the caller opts in (deal handoffs to another party never do).
    expect(normalizeCapturedContextToContinuityIr(captured, "claude-code").ir.provenance.workspace).toBeUndefined();
    const ir = normalizeCapturedContextToContinuityIr(captured, "claude-code", { workspaceState: true }).ir;
    expect(validateContinuityIr(ir)).toEqual([]);
    expect(ir.provenance.workspace?.head).toBe(git(root, "rev-parse", "HEAD"));
    expect(ir.provenance.workspace?.dirty).toBe(true);
    // A capsule leaves the machine: no untracked names or hashes.
    expect(ir.provenance.workspace?.untracked).toEqual([]);
    expect(JSON.stringify(ir)).not.toContain("customer-export");

    const state = mkdtempSync(path.join(tmpdir(), "crosshead-import-state-"));
    dirs.push(state);
    vi.stubEnv("CROSSHEAD_HOT_SYNC_ENABLED", "false");
    const key = generateSecretKey(), npub = nip19.npubEncode(getPublicKey(key)), nsec = nip19.nsecEncode(key);
    const manager = new RuntimeLifecycleManager({
      paths: { state }, hotWriteDebounceMs: 0, loadDefaultProfileName: () => "default",
      loadProfile: () => ({ name: "default", apiBase: "http://127.0.0.1:0", npub, memoryMode: "assist", features: { coldSync: false, autoWarmPromotion: false } }),
      loadSecret: () => ({ nsec, session: null }), saveSecret: () => {}, loadHealth: () => ({ queueDepth: 0, lastSuccessfulSyncAt: null, lastError: null }), saveHealth: () => {},
      loadContinuityGovernorState: () => buildContinuityGovernorState(buildDefaultContinuityPolicy(), []), writeLog: () => {},
    } as never);
    try {
      await manager.handleEvent({ eventId: "import-1", runtime: "claude-code", type: "operator.command", workspaceId: "repo:/elsewhere", sessionId: "import",
        payload: { command: HANDOFF_IMPORT_COMMAND, goal: "Imported handoff", content: "Imported handoff text.", handoffTurnId: "handoff-x",
          taskEvidence: { version: 1, sources: [], coverage: "unavailable", omitted: 0, workspace: ir.provenance.workspace } } });
      const stored = JSON.stringify(readLocalHotMemory(state, "all", { name: "default", apiBase: "http://127.0.0.1:0", npub } as never));
      expect(stored).toContain("handoff-x");
      expect(stored).toContain(ir.provenance.workspace!.head!);
    } finally { await manager.stop(); vi.unstubAllEnvs(); }
  });
});
