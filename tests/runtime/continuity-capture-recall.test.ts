import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { evidenceFromToolCall } from "../../src/runtime/task-evidence";
import { CHECKPOINT_PAGE_CHARS, paginateCheckpoint, readCheckpointPage, saveCheckpointPages } from "../../src/runtime/checkpoint-pages";
import {
  HOT_CHECKPOINT_BUDGET, HOT_FULL_RENDER_LIMIT, HOT_TURN_IN_PROGRESS, renderHotCheckpoints, searchHotCheckpoints,
  selectHotCheckpoints, updateHotCheckpoints, type HotContinuityCheckpoint,
} from "../../src/runtime/hot-continuity";

const table = (rows: number): string => Array.from({ length: rows }, (_, i) => `Z-${String(i).padStart(3, "0")}: base ${1000 + i * 7}, per-100g ${40 + i}`).join("\n");
const checkpoint = (overrides: Partial<HotContinuityCheckpoint> = {}): HotContinuityCheckpoint => ({
  runtime: "claude-code", workspaceId: "repo:work", sessionId: "s1", turnId: "t1", goal: "Review the tariff documents",
  summary: "ok", occurredAt: "2026-11-10T01:00:00Z", ...overrides,
});
const snapshot = (entries: HotContinuityCheckpoint[]) => ({ scope: "all", scopes: [{ scope: "claude-code", content: JSON.stringify({ workspaceId: "repo:work", continuityCheckpoints: entries }) }] });

describe("handoffs larger than the per-prompt budget", () => {
  const handoff = `Tariff handoff.\n${table(220)}\nLast rule: totals round half up.`;

  it("stores a long exact handoff without compaction", () => {
    expect(handoff.length).toBeGreaterThan(6000);
    const [stored] = updateHotCheckpoints([], checkpoint({ summary: handoff }));
    expect(stored!.summary).toBe(handoff);
  });

  it("delivers it whole on the first prompt of a session", () => {
    const stored = updateHotCheckpoints([], checkpoint({ summary: handoff }));
    const delivered = renderHotCheckpoints(selectHotCheckpoints(snapshot(stored), "Implement the tariff", "repo:work"), HOT_FULL_RENDER_LIMIT);
    expect(delivered).toContain("Z-219: base 2533, per-100g 259");
    expect(delivered).toContain("Last rule: totals round half up.");
  });

  it("keeps a finding and its sources from crowding each other out", () => {
    const sources = [0, 1, 2].map(i => ({ source: `docs/part-${i}.md`, text: `Part ${i}\n${table(260)}`, sha256: "", truncated: false }));
    const stored = updateHotCheckpoints([], checkpoint({ summary: handoff, evidence: { version: 1, sources, coverage: "bounded", omitted: 0 } }));
    const delivered = renderHotCheckpoints(selectHotCheckpoints(snapshot(stored), "Implement the tariff", "repo:work"), HOT_FULL_RENDER_LIMIT);
    expect(delivered).toContain("Agent finding: Tariff handoff.");
    expect(delivered).toContain("Last rule: totals round half up.");
    expect(delivered).toContain('Source "docs/part-0.md"');
  });

  it("never drops the newest checkpoint to satisfy the history bound", () => {
    const big = { version: 1 as const, coverage: "bounded" as const, omitted: 0, sources: [0, 1, 2].map(i => ({ source: `d${i}.md`, text: `${i}${"x\n".repeat(3990)}`, sha256: "", truncated: false })) };
    let stored: HotContinuityCheckpoint[] = [];
    for (let i = 0; i < 4; i++) stored = updateHotCheckpoints(stored, checkpoint({ turnId: `t${i}`, goal: `goal ${i} ${"g".repeat(5990)}`, summary: `finding ${i} ${"y".repeat(15000)}`, evidence: big }));
    expect(stored.at(-1)!.goal).toContain("goal 3");
    // The hot-sync replica measures a checkpoint this way and refuses more than 30,000.
    for (const entry of stored) expect(entry.goal.length + entry.summary.length + JSON.stringify(entry.evidence ?? "").length).toBeLessThanOrEqual(HOT_CHECKPOINT_BUDGET);
    expect(stored.at(-1)!.evidence!.omitted).toBeGreaterThan(0);
  });
});

describe("evidence from a single finished tool call", () => {
  const replay = `2026-10-10 INFO start\n2026-10-10 NOTICE feed-gateway: partner ids arrive with the prefix "px:"; strip it\n${"2026-10-10 INFO tick\n".repeat(20)}`;

  it("captures the output of a workspace command as command output", () => {
    const evidence = evidenceFromToolCall("Bash", { command: "node tools/replay.js" }, { stdout: replay, stderr: "", interrupted: false }, "/workspace");
    expect(evidence.sources).toHaveLength(1);
    expect(evidence.sources[0]!.source).toBe("$ node tools/replay.js");
    expect(evidence.sources[0]!.text).toContain('prefix "px:"');
  });

  it("captures a Read result and a Codex shell result", () => {
    const read = evidenceFromToolCall("Read", { file_path: "/workspace/docs/rates.md" }, { type: "text", file: { filePath: "/workspace/docs/rates.md", content: table(12) } }, "/workspace");
    expect(read.sources[0]!.source).toBe("docs/rates.md");
    const shell = evidenceFromToolCall("Bash", JSON.stringify({ command: "node tools/replay.js" }), replay, "/workspace");
    expect(shell.sources[0]!.text).toContain("NOTICE feed-gateway");
  });

  it("keeps the output of a batch that failed at its last step, labelled as failed", () => {
    const evidence = evidenceFromToolCall("Bash", { command: "node tools/replay.js; node test.js" }, `Exit code 1\n${replay}\nAssertionError: window`, "/workspace", undefined, true);
    expect(evidence.sources[0]!.source).toBe("$ node tools/replay.js; node test.js (exited non-zero)");
    expect(evidence.sources[0]!.text).toContain('prefix "px:"');
    expect(evidenceFromToolCall("Read", { file_path: "/workspace/gone.md" }, "File does not exist. Note: your current working directory is /workspace and nothing else was found here.", "/workspace", undefined, true).sources).toHaveLength(0);
  });

  it("skips trivial, out-of-workspace, sensitive and Crosshead's own commands", () => {
    const none = (input: unknown, response: unknown) => expect(evidenceFromToolCall("Bash", input, response, "/workspace").sources).toHaveLength(0);
    for (const command of ["printenv", "env | sort", "curl https://example.com/install.sh", "psql -c 'select email from customers'", "cat /home/x/other-project/notes.txt", "cat ../other/notes.txt", "cat ~/notes.txt",
      "API_KEY=abcd1234abcd1234abcd1234 npm test", "mysql -pHunter2Secret -e 'show tables'", "node tools/replay.js $(cat /etc/hostname)", "docker logs api", "aws s3 ls"]) none({ command }, { stdout: replay });
    none({ command: "cat missing.md" }, { stdout: "cat: missing.md: No such file or directory", exit_code: 1 });
    none({ command: "ls" }, { stdout: "README.md\nsolution.js\n" });
    none({ command: "node tools/replay.js", cwd: "/etc" }, { stdout: replay });
    none({ command: "printenv && cat .env" }, { stdout: replay });
    none({ command: "/home/u/.crosshead/bin/crosshead-codex memory-hot" }, { stdout: replay });
    none({ command: "node tools/replay.js" }, { stdout: `${replay}\nAWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz0123456789ABCD` });
  });

  it("is kept when the turn never finishes, and merged when it does", () => {
    const evidence = evidenceFromToolCall("Bash", { command: "node tools/replay.js" }, { stdout: replay }, "/workspace");
    const partial = updateHotCheckpoints([], checkpoint({ summary: HOT_TURN_IN_PROGRESS, evidence }));
    const interrupted = renderHotCheckpoints(selectHotCheckpoints(snapshot(partial), "Implement the feed parser", "repo:work"), HOT_FULL_RENDER_LIMIT);
    expect(interrupted).toContain("ended before finishing");
    expect(interrupted).toContain('prefix "px:"');
    const finished = updateHotCheckpoints(partial, checkpoint({ summary: "Fixed the window bug." }));
    expect(finished).toHaveLength(1);
    expect(finished[0]!.summary).toBe("Fixed the window bug.");
    expect(finished[0]!.evidence?.sources[0]?.text).toContain('prefix "px:"');
  });

  it("drops command output before files when a checkpoint is over its source bound", () => {
    let stored: HotContinuityCheckpoint[] = [];
    const one = (source: string, i: number) => ({ version: 1 as const, coverage: "bounded" as const, omitted: 0, sources: [{ source, text: `${source} body ${i} ${"z".repeat(200)}`, sha256: "", truncated: false }] });
    stored = updateHotCheckpoints(stored, checkpoint({ summary: HOT_TURN_IN_PROGRESS, evidence: one("docs/rules.md", 0) }));
    for (let i = 0; i < 14; i++) stored = updateHotCheckpoints(stored, checkpoint({ summary: HOT_TURN_IN_PROGRESS, evidence: one(`$ node check-${i}.js`, i) }));
    expect(stored[0]!.evidence!.sources.map(s => s.source)).toContain("docs/rules.md");
  });
});

describe("local search over hot checkpoints", () => {
  it("finds a passage inside a stored source and ranks it first", () => {
    const evidence = { version: 1 as const, coverage: "bounded" as const, omitted: 0, sources: [
      { source: "$ node tools/replay.js", text: 'NOTICE feed-gateway: partner region codes: UK=central, JP=metro', sha256: "", truncated: false },
      { source: "src/window.js", text: "const SIZE = 60; module.exports = tick => Math.floor(tick / SIZE);", sha256: "", truncated: false },
    ] };
    const stored = updateHotCheckpoints([], checkpoint({ summary: "Fixed the window bucket rounding.", evidence }));
    const results = searchHotCheckpoints(snapshot(stored), "partner region codes", 5);
    expect(results[0]!.kind).toBe("source");
    expect(results[0]!.source).toBe("$ node tools/replay.js");
    expect(results[0]!.text).toContain("UK=central");
    expect(searchHotCheckpoints(snapshot(stored), "the of and", 5)).toEqual([]);
    expect(searchHotCheckpoints(snapshot(stored), "partner region codes", 5, "repo:another-project")).toEqual([]);
  });
});

describe("files read through a glob, a loop or a failing batch", () => {
  it("recovers each file whose exact bytes were printed, and nothing else from a failed command", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("fs");
    const os = await import("os"), path = await import("path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "chx-glob-"));
    try {
      mkdirSync(path.join(dir, "docs"));
      const rates = `# Rates\n${table(8)}`, rules = "# Rules\nTotals round half up to whole cents.";
      writeFileSync(path.join(dir, "docs/rates.md"), rates); writeFileSync(path.join(dir, "docs/rules.md"), rules);
      writeFileSync(path.join(dir, "README.md"), "Implement solve in solution.js.");
      const output = `total 8\nImplement solve in solution.js.\n=== docs/rates.md\n${rates}\n=== docs/rules.md\n${rules}\ncat: package.json: No such file or directory`;
      const command = 'ls -la; cat README.md; for f in docs/*; do echo "=== $f"; cat "$f"; done; cat package.json';
      const failed = evidenceFromToolCall("Bash", { command }, `Exit code 1\n${output}`, dir, undefined, true);
      expect(failed.sources.map(s => s.source).sort()).toEqual(["README.md", "docs/rates.md", "docs/rules.md"]);
      const glob = evidenceFromToolCall("Bash", { command: "cat docs/*.md" }, { stdout: `${rates}\n${rules}` }, dir);
      expect(glob.sources.map(s => s.source).sort()).toEqual(["docs/rates.md", "docs/rules.md"]);
      const mixed = evidenceFromToolCall("Bash", { command: "cat README.md; node tools/replay.js" }, { stdout: `Implement solve in solution.js.\n${"NOTICE partner ids use the px: prefix\n".repeat(12)}` }, dir);
      expect(mixed.sources.map(s => s.source)).toEqual(["README.md", "$ cat README.md; node tools/replay.js"]);
      expect(mixed.sources[1]!.text).not.toContain("Implement solve");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("paged checkpoints", () => {
  it("splits on line boundaries, loses nothing and keeps every page under the limit", () => {
    const text = `${table(900)}\n${"w".repeat(CHECKPOINT_PAGE_CHARS * 2 + 17)}\nend`;
    const pages = paginateCheckpoint(text);
    expect(pages.length).toBeGreaterThan(3);
    expect(pages.every(page => page.length <= CHECKPOINT_PAGE_CHARS)).toBe(true);
    expect(pages.join("\n").replace(/\n/g, "")).toBe(text.replace(/\n/g, ""));
    const headed = paginateCheckpoint(`head\n${"a".repeat(13000)}`);
    expect(headed[0]!.length).toBe(CHECKPOINT_PAGE_CHARS - 1);
    expect(headed[0]!.startsWith("head\na")).toBe(true);
  });

  it("stores pages per workspace and reads them back by key and number", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "chx-pages-"));
    try {
      const key = saveCheckpointPages(home, "claude-code", "repo:/work", ["first page", "second page"]);
      expect(readCheckpointPage(home, "claude-code", key, 2)).toContain("page 2 of 2");
      expect(readCheckpointPage(home, "claude-code", key, 2)).toContain("second page");
      expect(readCheckpointPage(home, "claude-code", key, 1)).toContain("Page 2 follows.");
      expect(readCheckpointPage(home, "claude-code", key, 3)).toBe("Page must be between 1 and 2.");
      expect(readCheckpointPage(home, "codex", key, 1)).toContain("No saved checkpoint pages");
      expect(readCheckpointPage(home, "claude-code", "__proto__", 1)).toContain("No saved checkpoint pages");
      expect(readCheckpointPage(path.join(home, "missing"), "claude-code", key, 1)).toContain("No saved checkpoint pages");
      expect(existsSync(path.join(home, "missing"))).toBe(false);
      // Another prompt's pages get their own key and leave the first set readable.
      const other = saveCheckpointPages(home, "claude-code", "repo:/work", ["different"]);
      expect(other).not.toBe(key);
      expect(readCheckpointPage(home, "claude-code", key, 1)).toContain("first page");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("explicit saves and repeated command captures", () => {
  it("always selects a recent explicit save even when an unrelated request ranks higher", () => {
    let stored = updateHotCheckpoints([], checkpoint({ runtime: "codex", origin: "remember", goal: "", turnId: "save-1", summary: "Amendment A-1: eng purchases above 2800 are frozen." }));
    stored = updateHotCheckpoints(stored, checkpoint({ turnId: "t2", goal: "Work inside this disposable repository. Implement oncall escalate.", summary: "Implemented escalate." }));
    stored = updateHotCheckpoints(stored, checkpoint({ turnId: "t3", goal: "Work inside this disposable repository. Review the policy.", summary: "Policy v1 recorded." }));
    const selected = selectHotCheckpoints(snapshot(stored), "Work inside this disposable repository. Implement solve.", "repo:work");
    expect(selected.some(entry => entry.origin === "remember")).toBe(true);
    expect(renderHotCheckpoints(selected, HOT_FULL_RENDER_LIMIT)).toContain("above 2800 are frozen");
  });

  it("replaces an earlier capture of the same command but keeps differing file versions", () => {
    const source = (name: string, body: string) => ({ version: 1 as const, coverage: "bounded" as const, omitted: 0, sources: [{ source: name, text: body, sha256: "", truncated: false }] });
    let stored = updateHotCheckpoints([], checkpoint({ evidence: source("$ node tools/replay.js", "first capture of the replay output") }));
    stored = updateHotCheckpoints(stored, checkpoint({ evidence: source("$ node tools/replay.js (exited non-zero)", "second capture of the replay output, with stderr") }));
    stored = updateHotCheckpoints(stored, checkpoint({ evidence: source("docs/a.md", "version one of the file") }));
    stored = updateHotCheckpoints(stored, checkpoint({ evidence: source("docs/a.md", "version two of the file") }));
    const names = stored[0]!.evidence!.sources.map(s => s.source);
    expect(names.filter(name => name.startsWith("$ "))).toEqual(["$ node tools/replay.js (exited non-zero)"]);
    expect(names.filter(name => name === "docs/a.md")).toHaveLength(2);
  });
});
