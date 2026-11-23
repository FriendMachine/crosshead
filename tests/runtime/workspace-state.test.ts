import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { renderHotCheckpoints, updateHotCheckpoints, selectHotCheckpoints, type HotContinuityCheckpoint } from "../../src/runtime/hot-continuity";
import { normalizeTaskEvidence, withWorkspaceState, type TaskEvidence } from "../../src/runtime/task-evidence";
import { describeWorkspaceDrift, normalizeWorkspaceGitState, readWorkspaceGitState } from "../../src/runtime/workspace-state";

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
    expect(line).toContain(`written at ${then.head!.slice(0, 10)} on main; now ${git(root, "rev-parse", "HEAD").slice(0, 10)}`);
    expect(line).toContain("untracked tool.py is not present here");
    expect(line).toContain("uncommitted changes that are not in this tree");
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
    expect(moved).toContain("Workspace drift");
    expect(moved).toContain('Source "rules.md" [changed on disk since observed; reread]');
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
});
