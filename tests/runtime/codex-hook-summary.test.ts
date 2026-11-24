import { describe, expect, it } from "vitest";

import { compactContinuitySummary } from "../../src/runtime/summary-compaction";

describe("Codex hook turn summary compaction", () => {
  it("keeps high-signal resume facts instead of prefix-only truncating them away", () => {
    const verboseSummary = [
      "Ran npm run incident:replay and npm test. No files were modified.",
      "R-42 points to src/idempotency.js: the exact request field that must take precedence is the `X-Idempotency-Key` header, matched case-insensitively. It must win over `body.id`.",
      "The failed approach to avoid is deriving the idempotency source from `body.id` first and only falling back to a header.",
      "Public API constraint: preserve the exported `buildIdempotencyKey(request)` and `shouldDeduplicate(existing, request)` functions, and do not add dependencies.",
      "Validation passed with a long trailing note that should be less important than the incident facts.",
    ].join(" ");

    const compacted = compactContinuitySummary(verboseSummary);

    expect(compacted.length).toBeLessThanOrEqual(640);
    expect(compacted).toContain("X-Idempotency-Key");
    expect(compacted).toContain("body.id");
    expect(compacted).toContain("failed approach");
    expect(compacted).toContain("Public API constraint");
  });

  it("collapses long markdown file links before deciding which resume facts fit", () => {
    const tempPath =
      "/tmp/onlybots-continuity-workspace-resume-idempotency-header-001-onlybots-r1-38b5ddba-tziKBT/workspace";
    const verboseSummary = [
      "I did not modify files.",
      `R-42 points to [scripts/replay-incident.js](${tempPath}/scripts/replay-incident.js:3): the request header \`X-Replay-Token\` must take precedence over \`request.body.id\`, with case-insensitive header matching.`,
      `The current risky code path is in [src/idempotency.js](${tempPath}/src/idempotency.js:18), where \`body.id\` is chosen first and headers are only a fallback.`,
      "Failed approach to avoid: deriving the idempotency key from `body.id` first, because retries can have patched bodies and still represent the same replay.",
      `Public API constraint: preserve the exported \`buildIdempotencyKey(request)\` and \`shouldDeduplicate(existing, request)\` API from [src/idempotency.js](${tempPath}/src/idempotency.js:32), and do not add dependencies.`,
      "Verification run: - `npm run incident:replay` - `npm test` passed.",
    ].join(" ");

    const compacted = compactContinuitySummary(verboseSummary);

    expect(compacted.length).toBeLessThanOrEqual(640);
    expect(compacted).toContain("X-Replay-Token");
    expect(compacted).toContain("request.body.id");
    expect(compacted).toContain("Failed approach");
    expect(compacted).toContain("Public API constraint");
    expect(compacted).not.toContain(tempPath);
  });

  it("keeps what is still unresolved or blocked when compacting", () => {
    const summary = [
      "I read the parser and the three fixtures in detail and summarised each of them for the record.",
      "The tokenizer handles quoted strings and escapes the same way in every fixture I looked at today.",
      "Formatting of the output table was adjusted to align the columns more neatly than before.",
      "Unresolved: the negative-offset case still returns the wrong row.",
      "Deploy is blocked on the staging credentials, which only the operator can rotate.",
      "Remaining work is the migration for the archived rows.",
      "Overall the session went smoothly and the code is in a reasonable state now.",
    ].join(" ");
    const compacted = compactContinuitySummary(summary, 260);
    expect(compacted.length).toBeLessThanOrEqual(260);
    expect(compacted).toContain("negative-offset case");
    expect(compacted).toContain("blocked on the staging credentials");
    expect(compacted).toContain("migration for the archived rows");
  });
});
