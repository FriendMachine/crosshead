import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyMailPage, inspectMailView, mailCursor, takeMailNotices, type MailItem } from "../../src/runtime/mail-cache";

const roots: string[] = [];
const profile = { name: "reviewer", apiBase: "http://localhost", npub: "recipient" };
const item: MailItem = {
  cursor: "1", eventId: "a".repeat(64), kind: "assignment", sender: "requester", recipient: profile.npub,
  contextId: "ctx_review", parentEventId: null, taskRef: "review", status: "unread", text: "review the change",
  artifactRefs: [], createdAt: "2026-11-28T00:00:00Z", updatedAt: "2026-11-28T00:00:00Z", acknowledgedAt: null, resolvedAt: null,
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
it("recovers from overlapping pages, preserves independent read markers and separates identities", () => {
  const root = mkdtempSync(join(tmpdir(), "mail-test-")); roots.push(root);
  const first = { viewer: profile.npub, changes: [item], nextCursor: "1", hasMore: false };
  applyMailPage(root, profile, "0", first);
  expect(takeMailNotices(root, profile)).toEqual([item.eventId]);
  applyMailPage(root, profile, "0", first);
  expect(takeMailNotices(root, profile)).toEqual([]);
  expect(inspectMailView(root, profile, "needs-response")).toEqual([item]);
  expect(inspectMailView(root, profile, "changed", "ctx_other")).toEqual([]);
  expect(inspectMailView(root, profile, "changed", "ctx_review")).toEqual([item]);
  expect(inspectMailView(root, profile, "changed", "ctx_review")).toEqual([]);
  expect(inspectMailView(root, profile, "changed")).toEqual([item]);
  const note = { ...item, cursor: "2", eventId: "b".repeat(64), kind: "note" };
  const completed = { ...item, cursor: "3", status: "completed", resolvedAt: "2026-11-28T01:00:00Z" };
  applyMailPage(root, profile, "1", { viewer: profile.npub, changes: [note, completed], nextCursor: "3", hasMore: false });
  expect(inspectMailView(root, profile, "needs-response")).toEqual([]);
  expect(takeMailNotices(root, profile)).toEqual([note.eventId]);
  const stranger = { ...profile, npub: "different-public-key" };
  expect(mailCursor(root, stranger)).toBe("0");
  expect(() => applyMailPage(root, stranger, "0", first)).toThrow();
  expect(inspectMailView(root, stranger, "thread", "ctx_review")).toEqual([]);
  expect(() => applyMailPage(root, profile, "3", { viewer: profile.npub, changes: [{ ...item, cursor: "4" }], nextCursor: "5", hasMore: false })).toThrow();
  expect(mailCursor(root, profile)).toBe("3");
  expect(inspectMailView(root, profile, "thread", "ctx_review")).toEqual([note, completed]);
});

it("rejects out-of-range revisions and atomically rolls back a malformed second item", () => {
  const root = mkdtempSync(join(tmpdir(), "mail-test-")); roots.push(root);
  const apply = (changes: MailItem[]) => applyMailPage(root, profile, "0", { viewer: profile.npub, changes, nextCursor: changes.at(-1)!.cursor, hasMore: false });
  expect(() => apply([item, { ...item, eventId: "bad", cursor: "2" }])).toThrow();
  expect(() => apply([{ ...item, cursor: "9223372036854775808" }])).toThrow();
  expect(mailCursor(root, profile)).toBe("0");
  expect(inspectMailView(root, profile, "thread", "ctx_review")).toEqual([]);
  apply([{ ...item, cursor: "9223372036854775807" }]);
  expect(mailCursor(root, profile)).toBe("9223372036854775807");
});
