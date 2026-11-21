import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ host: string; input: Record<string, unknown> }> = [];
vi.mock("../../src/runtime/claude-code-adapter", () => ({
	ClaudeCodeRuntimeAdapter: { fromInstalled: () => ({ remember: async (input: Record<string, unknown>) => { calls.push({ host: "claude-code", input }); } }) },
}));
vi.mock("../../src/runtime/codex-adapter", () => ({
	CodexRuntimeAdapter: { fromInstalled: () => ({ remember: async (input: Record<string, unknown>) => { calls.push({ host: "codex", input }); } }) },
}));

import { rememberFromCli } from "../../src/runtime/cli/remember";

describe("crosshead remember", () => {
	const home = mkdtempSync(path.join(tmpdir(), "xhd-remember-cli-"));
	afterEach(() => {
		calls.length = 0;
		vi.unstubAllEnvs();
	});

	it("saves positional text for the Claude Code session it runs in", async () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "session-123");
		vi.stubEnv("CLAUDECODE", "1");
		const out = await rememberFromCli(["Prices", "are", "in", "credits", "--home", home, "--workspace-root", home]);
		expect(out).toContain("Remembered");
		expect(calls).toEqual([{ host: "claude-code", input: expect.objectContaining({ content: "Prices are in credits", entryType: "fact", sessionId: "session-123", workspaceRoot: path.resolve(home) }) }]);
	});

	it("uses Codex when asked and accepts an entry type", async () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
		vi.stubEnv("CLAUDECODE", "");
		await rememberFromCli(["--host", "codex", "--type", "correction", "--content", "Settle only after delivery", "--home", home, "--workspace-root", home]);
		expect(calls[0]).toMatchObject({ host: "codex", input: { content: "Settle only after delivery", entryType: "correction" } });
	});

	it("refuses empty text, unknown types and an undetectable host", async () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
		vi.stubEnv("CLAUDECODE", "");
		vi.stubEnv("CODEX_THREAD_ID", "");
		vi.stubEnv("CODEX_SESSION_ID", "");
		await expect(rememberFromCli(["--host", "codex", "--home", home])).rejects.toThrow(/needs the text/);
		await expect(rememberFromCli(["x", "--host", "codex", "--type", "opinion", "--home", home])).rejects.toThrow(/--type/);
		await expect(rememberFromCli(["x", "--home", home])).rejects.toThrow(/--host/);
		expect(calls).toEqual([]);
	});

	it("cleans up", () => rmSync(home, { recursive: true, force: true }));
});
