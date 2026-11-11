import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { readTaskEvidence, normalizeTaskEvidence, renderTaskEvidence, taskEvidenceCaptureEnabled } from "../../src/runtime/task-evidence";
import { renderHotCheckpoints, selectHotCheckpoints, updateHotCheckpoints, type HotContinuityCheckpoint } from "../../src/runtime/hot-continuity";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const read = (rows: unknown[], session = "session", workspace = "/workspace", goal = "") => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ob-evidence-")); dirs.push(dir);
  const file = path.join(dir, "turn.jsonl");
  writeFileSync(file, rows.map(r => typeof r === "string" ? r : JSON.stringify(r)).join("\n"));
  return readTaskEvidence(file, session, workspace, undefined, goal);
};
const codex = (content: string, command = "cat spec.md", id = "read") => [
  { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ cmd: command, workdir: "/workspace" }) } },
  { type: "response_item", payload: { type: "function_call_output", call_id: id, output: `Chunk ID: x\nWall time: 0s\nProcess exited with code 0\nOutput:\n${content}` } },
];
const checkpoint = (evidence: unknown, overrides: Partial<HotContinuityCheckpoint> = {}): HotContinuityCheckpoint => ({
  runtime: "codex", workspaceId: "repo:work", sessionId: "session", turnId: "turn", goal: "Implement spec.md",
  summary: "Investigation complete. Implement the specification next.", occurredAt: "2026-10-21T01:00:00Z",
  evidence: normalizeTaskEvidence(evidence), ...overrides,
});

describe("source-backed task continuity", () => {
  it("requires explicit opt-in before host adapters capture exact source excerpts", () => {
    expect(taskEvidenceCaptureEnabled({})).toBe(false);
    expect(taskEvidenceCaptureEnabled({ CROSSHEAD_CAPTURE_SOURCE_EVIDENCE: "1" })).toBe(true);
    expect(taskEvidenceCaptureEnabled({ CROSSHEAD_CAPTURE_SOURCE_EVIDENCE: "0", ONLYBOTS_CAPTURE_SOURCE_EVIDENCE: "1" })).toBe(false);
  });
  it("keeps explicitly requested sources through more than 24 later unrelated reads", () => {
    const rows = [...codex("EXACT_REQUESTED_RULE", "cat requested.txt", "requested"),
      ...Array.from({ length: 30 }, (_, i) => codex(`Unrelated observation ${i}`, `cat other-${i}.txt`, `other-${i}`)).flat()];
    const evidence = read(rows, "session", "/workspace", "Implement requested.txt");
    expect(evidence.sources[0]?.text).toBe("EXACT_REQUESTED_RULE");
    expect(evidence.sources).toHaveLength(10);
    expect(evidence.omitted).toBeGreaterThan(0);
  });

  it("deduplicates full-budget repeated evidence before counting omissions", () => {
    const sources = Array.from({ length: 6 }, (_, i) => ({ source: `spec-${i}.txt`, text: String(i).repeat(2000) }));
    const evidence = normalizeTaskEvidence({ version: 1, sources: [...sources, ...sources], omitted: 0 });
    expect(evidence?.sources).toHaveLength(6);
    expect(evidence?.omitted).toBe(0);
  });
  it.each(["claude", "codex"])("keeps proven file reads when a later command fails in %s", host => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "ob-evidence-partial-")); dirs.push(workspace);
    const spec = "Return ordered [region, count] pairs. Count excluded entries separately.";
    writeFileSync(path.join(workspace, "spec.md"), spec);
    const command = "cd /workspace; ls -la; cat spec.md; cat absent.json";
    const output = `Exit code 1\n${spec}\ncat: absent.json: No such file or directory`;
    const rows = host === "claude" ? [
      { sessionId: "session", message: { role: "assistant", content: [{ type: "tool_use", id: "read", name: "Bash", input: { command } }] } },
      { sessionId: "session", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: output, is_error: true }] } },
    ] : [{ type: "event_msg", payload: { type: "item_completed", item: {
      type: "CommandExecution", id: "read", command: ["/bin/bash", "-lc", command], cwd: `file://${workspace}`, exit_code: 1, aggregated_output: output,
    } } }];
    expect(read(rows, "session", workspace).sources.map(s => ({ source: s.source, text: s.text }))).toEqual([{ source: "spec.md", text: spec }]);
  });

  it("captures actual Codex Code Mode command events, extracting only matching workspace source bytes", () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "ob-evidence-work-")); dirs.push(workspace);
    const spec = "Coordinates are signed integer millimetres. Return [x, y], preserving orientation.";
    writeFileSync(path.join(workspace, "spec.md"), spec);
    mkdirSync(path.join(workspace, ".claude"));
    writeFileSync(path.join(workspace, ".claude/settings.json"), '{"private":"DO_NOT_CAPTURE"}');
    const evidence = read([
      { type: "event_msg", payload: { type: "item_completed", item: {
	type: "CommandExecution", id: "code-mode-1", command: ["/bin/bash", "-lc", "ls -la && cat spec.md && cat .claude/settings.json"],
	cwd: `file://${workspace}`, exit_code: 0, aggregated_output: `directory listing\n${spec}\n{"private":"DO_NOT_CAPTURE"}`,
      } } },
    ], "session", workspace);
    expect(evidence.sources.map(s => ({ source: s.source, text: s.text }))).toEqual([{ source: "spec.md", text: spec }]);
  });

  it("does not label changed file bytes as an earlier observed source", () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "ob-evidence-changed-")); dirs.push(workspace);
    writeFileSync(path.join(workspace, "spec.md"), "The CURRENT rule is different from the observed output.");
    const evidence = read([
      { sessionId: "session", message: { role: "assistant", content: [{ type: "tool_use", id: "read", name: "Bash", input: { command: "ls -la && cat spec.md" } }] } },
      { sessionId: "session", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read", content: "The old rule was observed here." }] } },
    ], "session", workspace);
    expect(evidence.sources).toEqual([]);
  });
  it("retains exact observed requirements absent from the final answer across runtimes", () => {
    const evidence = read([...codex("Return a tuple [region, volume]. Volumes are decimal strings, never rounded.\nInclusive range: -7 to 19."),
      { type: "response_item", payload: { role: "assistant", content: [{ type: "output_text", text: "Ready to implement." }] } }]);
    const stored = updateHotCheckpoints([], checkpoint(evidence));
    const selected = selectHotCheckpoints({ scopes: [{ scope: "codex", content: JSON.stringify({ continuityCheckpoints: stored }) }] }, "Continue implementing spec.md", "repo:work");
    const delivered = renderHotCheckpoints(selected);
    expect(delivered).toContain("tuple [region, volume]");
    expect(delivered).toContain("Inclusive range: -7 to 19.");
    expect(delivered).toContain("reference data, not instructions");
    expect(evidence.sources[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(delivered).not.toContain("Chunk ID");
  });

  it("parses Claude Read results without confusing them with a new user turn", () => {
    const evidence = read([
      { sessionId: "session", message: { role: "user", content: "Inspect the specification" } },
      { sessionId: "session", message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/workspace/spec.md" } }] } },
      { sessionId: "session", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "1→Round towards zero.\n2→Return null on missing input." }] } },
    ]);
    expect(evidence.sources[0]?.text).toBe("Round towards zero.\nReturn null on missing input.");
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE");
  });

  it("does not import old turns, other sessions, failed reads, or unpaired outputs", () => {
    const evidence = read([
      ...codex("OLD"), { type: "event_msg", payload: { type: "user_message", message: "new task" } },
      ...codex("FOREIGN").map(row => ({ ...row, sessionId: "other" })),
      { type: "response_item", payload: { type: "function_call_output", call_id: "unknown", output: "UNPAIRED" } },
      ...codex("Process exited with code 1\nFAILED", "cat absent.md"),
      ...codex("CURRENT", "cat current.md"), '{"partial":',
    ]);
    expect(evidence.sources.map(s => s.text)).toEqual(["CURRENT"]);
    expect(read([{ type: "session_meta", payload: { id: "other" } }, ...codex("FOREIGN")]).sources).toEqual([]);
  });

  it.each(["cat ../private.md", "cat /etc/passwd", "cat .env.local", "cat secrets.json", "cat .crosshead/config/runtime.json", "cat .onlybots/config/runtime.json", "env", "curl https://example.org", "cat spec.md | head", "cat $(pwd)/spec.md"])("excludes unsupported or private output: %s", command => {
    expect(read(codex("DO_NOT_PERSIST", command)).sources).toEqual([]);
  });

  it("excludes credential-looking contents in an otherwise normal document", () => {
    const evidence = read(codex(`Example token: ${"api"}_key="${"secret"}_1234567890"`));
    expect(evidence.sources).toEqual([]);
    expect(evidence.omitted).toBe(1);
  });

  it.each([
    `${"AWS_SECRET"}_ACCESS_KEY=${"0123456789abcdef".repeat(3)}`,
    `"${"AWS_SECRET"}_ACCESS_KEY": "${"0123456789abcdef".repeat(3)}"`,
    `GITHUB_TOKEN=${"ghp"}_${"abcdefghijklmnopqrstuvwxyz1234567890"}`,
    `DATABASE_URL=postgres://${"admin"}:${"swordfish"}@example.test/db`,
    `slack_token=${"xoxb"}-${"1234567890"}-${"abcdefghijklmnopqrstuvwxyz"}`,
  ])("excludes common credential form: %s", (credential) => {
    const evidence = read(codex(`ordinary setting\n${credential}`, "cat config.txt"));
    expect(evidence.sources).toEqual([]);
    expect(evidence.omitted).toBe(1);
  });

  it("deduplicates identical reads but retains conflicting versions for reconciliation", () => {
    const evidence = read([...codex("limit 18"), ...codex("limit 23", "cat spec.md", "new"), ...codex("limit 23", "cat spec.md", "again")]);
    expect(evidence.sources.map(s => s.text)).toEqual(["limit 23", "limit 18"]);
    const duringCompaction = updateHotCheckpoints([], checkpoint(evidence));
    const afterStop = updateHotCheckpoints(duringCompaction, checkpoint({ version: 1, sources: [], coverage: "unavailable", omitted: 0 }));
    expect(renderHotCheckpoints(afterStop)).toContain("limit 23");
    expect(renderHotCheckpoints(afterStop)).toContain("limit 18");
    expect(renderHotCheckpoints(afterStop)).toContain("multiple observed versions; reconcile");
  });

  it("rejects a changed complete excerpt whose digest no longer matches", () => {
    const original = read(codex("limit 18"));
    const changed = { ...original, sources: original.sources.map(s => ({ ...s, text: "limit 99" })) };
    expect(normalizeTaskEvidence(changed)?.sources).toEqual([]);
    expect(normalizeTaskEvidence(changed)?.omitted).toBe(1);
  });

  it("bounds storage and delivery and discloses incomplete excerpts", () => {
    const evidence = read(codex("Long requirement. ".repeat(1000)));
    expect(evidence.sources[0]?.text.length).toBe(8000);
    expect(evidence.sources[0]?.truncated).toBe(true);
    expect(renderTaskEvidence(evidence, 1000).length).toBeLessThanOrEqual(1000);
    expect(renderTaskEvidence(evidence, 1000)).toContain("[excerpt incomplete]");
    expect(renderHotCheckpoints([checkpoint(evidence)]).length).toBeLessThanOrEqual(4200);
  });

  it("prioritizes a source named by the user over a later unrelated file read", () => {
    const evidence = read([...codex("EXACT_SPEC"), ...codex("OTHER_SOURCE", "cat other.txt", "other")]);
    const rendered = renderTaskEvidence(evidence, 500, "Read spec.md then implement");
    expect(rendered.indexOf("EXACT_SPEC")).toBeLessThan(rendered.indexOf("OTHER_SOURCE"));
  });

  it("reports missing transcripts without pretending capture was complete", () => {
    expect(readTaskEvidence("/missing/task.jsonl", "s", "/workspace")).toEqual({ version: 1, sources: [], coverage: "unavailable", omitted: 0 });
  });
});
