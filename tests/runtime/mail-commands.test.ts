import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRuntimeHomeLayout, saveProfile } from "../../src/runtime/runtime-persistence";
import { afterEach, expect, it, vi } from "vitest";
import { messagesFromCli } from "../../src/runtime/cli/messages";
import { OnlyBotsLocalRuntimeDaemon } from "../../src/runtime/local-runtime";
import { runOnlyBotsCodexBridgeCli } from "../../src/runtime/codex-bridge";
import { runOnlyBotsClaudeCodeBridgeCli } from "../../src/runtime/claude-code-bridge";
import { CodexRuntimeAdapter } from "../../src/runtime/codex-adapter";
import { ClaudeCodeRuntimeAdapter } from "../../src/runtime/claude-code-adapter";

afterEach(() => { vi.restoreAllMocks(); });

it("passes parent and exact request ID through both bridges and the CLI", async () => {
  const parent = "f".repeat(64), receipt = { request_id: "followup-1" };
  const sendAgentMail = vi.fn().mockResolvedValue(receipt);
  vi.spyOn(CodexRuntimeAdapter, "fromInstalled").mockReturnValue({ sendAgentMail } as unknown as CodexRuntimeAdapter);
  vi.spyOn(ClaudeCodeRuntimeAdapter, "fromInstalled").mockReturnValue({ sendAgentMail } as unknown as ClaudeCodeRuntimeAdapter);
  vi.spyOn(OnlyBotsLocalRuntimeDaemon.prototype, "sendAgentMail").mockImplementation(sendAgentMail);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const flags = ["--text", "Follow up", "--parent", parent, "--profile", "review", "--request-id", "followup-1"];
  await runOnlyBotsCodexBridgeCli(["mail-assign", ...flags]);
  await runOnlyBotsClaudeCodeBridgeCli(["mail_assign", ...flags]);
  expect(JSON.parse(await messagesFromCli(["assign", ...flags]))).toEqual(receipt);
  expect(sendAgentMail.mock.calls).toEqual(Array(3).fill([{ action: "assign", parent, requestId: "followup-1", text: "Follow up", to: undefined }, "review"]));
});

it("cannot return an old identity's cached view if the profile changes during an offline refresh", async () => {
  const home = mkdtempSync(join(tmpdir(), "mail-rotation-"));
  try {
    const paths = ensureRuntimeHomeLayout(home);
    const profile = { name: "review", npub: "original", apiBase: "https://server.invalid" } as Parameters<typeof saveProfile>[1];
    saveProfile(paths, profile);
    const daemon = new OnlyBotsLocalRuntimeDaemon(home);
    vi.spyOn(daemon as any, "syncMail").mockImplementation(async () => {
      saveProfile(paths, { ...profile, npub: "replacement" });
      throw new Error("offline");
    });
    await expect(daemon.viewAgentMail("waiting", undefined, "review")).rejects.toThrow("profile changed");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
