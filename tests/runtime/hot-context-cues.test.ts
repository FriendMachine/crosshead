import { describe, expect, it } from "vitest";

import { buildHotContextActionCue, mentionsHotContextInsufficientNpmTest } from "../../src/runtime/hot-context-cues";

describe("hot context action cues", () => {
	it("quotes a unit diagnosis without inventing an implementation formula", () => {
		const cue = buildHotContextActionCue(
			[
				"No files modified. Likely root cause: src/authPolicy.js computes:",
				"```js",
				"accessTokenTtlMs: policy.accessTokenTtlMinutes * 60",
				"```",
				"That produces seconds-as-milliseconds. With the default 60 minute TTL, the correct value is 3_600_000 ms.",
				"Public API constraint to preserve: callers configure TTL in minutes via accessTokenTtlMinutes, and the exported buildSessionPolicy/canRefreshSession API shape should stay intact.",
			].join("\n")
		);

		expect(cue?.text).toContain("finding=Likely root cause");
		expect(cue?.text).not.toContain("next=set");
		expect(cue?.text).toContain("inspect src/authPolicy.js");
		expect(cue?.text).toContain("preserve=");
		expect(cue?.paths).toEqual(["src/authPolicy.js"]);
	});

	it("quotes the observed precedence rule without generating a new instruction", () => {
		const cue = buildHotContextActionCue(
			[
				"Ran `npm run incident:replay` during investigation.",
				"Critical finding: when the request includes X-Replay-Token, that header value must take precedence over body.id.",
				"Failed approach to avoid: deriving the key from body.id first still duplicates retries.",
				"Constraint: preserve the exported buildIdempotencyKey(request) and shouldDeduplicate(existing, request) API.",
				"Inspect src/idempotency.js and test/idempotency.test.js next.",
			].join(" ")
		);

		expect(cue?.text).toContain("that header value must take precedence over body.id");
		expect(cue?.text).not.toContain("next=prefer");
		expect(cue?.text).toContain("finding=");
		expect(cue?.text).toContain("avoid=Failed approach");
		expect(cue?.text).toContain("inspect src/idempotency.js");
		expect(cue?.text).not.toContain("validate with `npm run incident:replay`");
		expect(cue?.validationCommand).toBeNull();
	});
	it("does not infer a missing arithmetic rule or treat passing tests as insufficient", () => {
		const cue = buildHotContextActionCue("Critical finding: accessTokenTtlMs and accessTokenTtlMinutes are opaque fixture field names, not a conversion rule. Milliseconds are mentioned only in unrelated logs.");
		expect(cue?.text).not.toContain("* 60 * 1000");
		expect(mentionsHotContextInsufficientNpmTest("npm test passed; all required checks are green.")).toBe(false);
		expect(mentionsHotContextInsufficientNpmTest("npm test is not insufficient.")).toBe(false);
		expect(mentionsHotContextInsufficientNpmTest("npm test is insufficient for this task.")).toBe(true);
	});
});
