import { expect, it, vi } from "vitest";
import { createMailBrief, renderMailBrief } from "../../src/runtime/mail-brief";
import type { MailItem } from "../../src/runtime/mail-cache";
const context = "ctx_review", eventId = "a".repeat(64);
const mail: MailItem = { contextId: context, eventId, sender: "author", recipient: "reader", cursor: "1", kind: "note",
  text: "I ran the tests.", taskRef: null, parentEventId: null, status: "unread", createdAt: "", updatedAt: "",
  acknowledgedAt: null, resolvedAt: null, artifactRefs: [] };
it("requires explicit consent, cites the visible thread and rejects a fabricated source", async () => {
  const result = { findings: [{ kind: "reported_change", suggestion: "The author reports running tests.", eventId, quote: mail.text }] };
  const analyze = vi.fn(async (_: string) => JSON.stringify(result));
  expect((await createMailBrief(context, "reader", [mail], undefined, analyze)).analysis).toBe("disabled");
  expect(analyze).not.toHaveBeenCalled();
  const brief = await createMailBrief(context, "reader", [mail, { ...mail, contextId: "ctx_other", text: "other-thread-secret" },
    { ...mail, sender: "stranger", recipient: "another-agent", text: "third-party-message" }], "claude-code", analyze);
  expect(analyze.mock.calls[0][0]).not.toMatch(/other-thread-secret|third-party-message/);
  expect(renderMailBrief(brief, true)).toContain("[Source](#mail-" + eventId + ")");
  expect(renderMailBrief(brief, true)).toContain('id="mail-' + eventId + '"');
  expect(JSON.parse(analyze.mock.calls[0][0].split("\n").at(-1)!)[0].speaker).toBe("peer");
  const formatted = renderMailBrief({ ...brief, findings: brief.findings!.map(f => ({ ...f, suggestion: "Click [link](url)\n<img src=x>\x1b[2J" })) }, true, "reviewer+beta");
  expect(formatted).not.toMatch(/<img|\x1b|\[link\]\(url\)/);
  expect(formatted).toContain("--profile reviewer+beta");
  result.findings[0].quote = "CI verified.";
  await expect(createMailBrief(context, "reader", [mail], "claude-code", analyze)).rejects.toThrow("unsupported citation");
});
