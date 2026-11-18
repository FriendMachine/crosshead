import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { scanUsageSource, type UsageEvent } from "../../src/runtime/token-usage-transcript";

it("uses Codex cumulative changes to deduplicate old snapshots and preserves model state between partial writes", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "crosshead-usage-legacy-"));
	try {
		const file = path.join(directory, "legacy-codex.jsonl");
		const source = { file, session: "session", subagent: false };
		const at = (days: number) => new Date(Date.UTC(2026, 10, days)).toISOString();
		const rows = (...records: unknown[]) => records.map(record => JSON.stringify(record) + "\n").join("");
		const tokens = (input: number, output: number, reasoning = 0) =>
			({ input_tokens: input, output_tokens: output, reasoning_output_tokens: reasoning });
		const snapshot = (date: string, input: number, output: number, last?: object, reasoning = 0, includes = true) =>
			({ timestamp: date, type: "event_msg", payload: { type: "token_count", info: {
				total_token_usage: tokens(input, output, reasoning), last_token_usage: last, last_usage_includes_reasoning: includes,
			} } });
		const first = rows(
			{ type: "turn_context", timestamp: at(12), payload: { model: "gpt-original" } },
			snapshot(at(12), 200, 30, tokens(200, 30)),
			snapshot(at(13), 270, 42),
			snapshot(at(13), 270, 42),
		);
		const remaining = rows(
			{ type: "turn_context", timestamp: at(14), payload: { model: "gpt-next" } },
			snapshot(at(14), 30, 10, tokens(30, 8, 2), 2, false),
		);
		const split = remaining.indexOf("payload");
		writeFileSync(file, first + remaining.slice(0, split));
		const events: UsageEvent[] = [];
		const cursor = scanUsageSource("codex", source, undefined, Date.parse(at(13)), event => events.push(event));
		expect(cursor?.offset).toBe(Buffer.byteLength(first));
		expect(events.map(({ model, counts }) => [model, counts.inputTokens, counts.outputTokens])).toEqual([["gpt-original", 70, 12]]);
		appendFileSync(file, remaining.slice(split));
		const next = scanUsageSource("codex", source, cursor, Date.parse(at(13)), event => events.push(event));
		expect(events.map(({ model, counts }) => [model, counts.inputTokens, counts.outputTokens])).toEqual([["gpt-original", 70, 12], ["gpt-next", 30, 10]]);
		const replacement = path.join(directory, "replacement.jsonl");
		writeFileSync(replacement, first + remaining);
		renameSync(replacement, file);
		const replay: UsageEvent[] = [];
		scanUsageSource("codex", source, next, Date.parse(at(13)), event => replay.push(event));
		expect(replay.map(event => event.key)).toEqual(events.map(event => event.key));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
