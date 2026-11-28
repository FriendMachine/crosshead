import { nip19 } from "nostr-tools";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyMailPage, inspectMailView, mailCursor, mailNoticeContacts, pruneRemovedMailProfiles, reserveMailNotices, confirmMailNotices, type MailItem } from "../../src/runtime/mail-cache";

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
  const missingResponse = reserveMailNotices(root, profile, [item.sender], 1000);
  expect(missingResponse.ids).toEqual([item.eventId]);
  expect(reserveMailNotices(root, profile, [item.sender], 1001).ids).toEqual([]);
  const retry = reserveMailNotices(root, profile, [item.sender], 31001);
  expect(retry.ids).toEqual([item.eventId]);
  confirmMailNotices(root, profile, retry.token);
  expect(applyMailPage(root, profile, "0", first)).toBe(false);
  expect(reserveMailNotices(root, profile, [item.sender]).ids).toEqual([]);
  expect(inspectMailView(root, profile, "needs-response")).toEqual([item]);
  expect(inspectMailView(root, profile, "changed", "ctx_other")).toEqual([]);
  expect(inspectMailView(root, profile, "changed", "ctx_review")).toEqual([item]);
  expect(inspectMailView(root, profile, "changed", "ctx_review")).toEqual([]);
  expect(inspectMailView(root, profile, "changed")).toEqual([item]);
  const note = { ...item, cursor: "2", eventId: "b".repeat(64), kind: "note" };
  const completed = { ...item, cursor: "3", status: "completed", resolvedAt: "2026-11-28T01:00:00Z" };
  applyMailPage(root, profile, "1", { viewer: profile.npub, changes: [note, completed], nextCursor: "3", hasMore: false });
  expect(inspectMailView(root, profile, "needs-response")).toEqual([]);
  expect(reserveMailNotices(root, profile, [item.sender]).ids).toEqual([note.eventId]);
  const retagged = { ...note, cursor: "4", contextId: "ctx_other", kind: "assignment" };
  applyMailPage(root, profile, "3", { viewer: profile.npub, changes: [retagged], nextCursor: "4", hasMore: false });
  expect(inspectMailView(root, profile, "needs-response", "ctx_other")).toEqual([retagged]);
  const stranger = { ...profile, npub: "different-public-key" };
  expect(mailCursor(root, stranger)).toBe("0");
  expect(() => applyMailPage(root, stranger, "0", first)).toThrow();
  expect(inspectMailView(root, stranger, "thread", "ctx_review")).toEqual([]);
  expect(() => applyMailPage(root, profile, "4", { viewer: profile.npub, changes: [{ ...item, cursor: "5" }], nextCursor: "6", hasMore: false })).toThrow();
  expect(mailCursor(root, profile)).toBe("4");
  expect(inspectMailView(root, profile, "thread", "ctx_review")).toEqual([completed]);
  expect(() => inspectMailView(root, profile, "changed", "*")).toThrow();
  applyMailPage(root, profile, "4", { viewer: profile.npub, changes: [{ cursor: "5", eventId: retagged.eventId, removed: true }], nextCursor: "5", hasMore: false });
  expect(inspectMailView(root, profile, "needs-response")).toEqual([]);
  applyMailPage(root, profile, "5", { viewer: profile.npub, changes: [{ ...item, cursor: "6", notify: false }], nextCursor: "6", hasMore: false });
  expect(reserveMailNotices(root, profile, [item.sender]).ids).toEqual([]);
  pruneRemovedMailProfiles(root, () => [stranger]);
  expect(mailCursor(root, profile)).toBe("0");
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

it("keeps unknown senders out of automatic notices and scopes contact consent to the recipient", () => {
  const root = mkdtempSync(join(tmpdir(), "mail-consent-")); roots.push(root);
  const peer = nip19.npubEncode("ab".repeat(32)), outsider = nip19.npubEncode("cd".repeat(32));
  const messages = Array.from({ length: 7 }, (_, i) => ({
    ...item, cursor: String(i + 1), eventId: String(i + 1).padStart(64, "0"), sender: i === 6 ? peer : outsider,
  }));
  applyMailPage(root, profile, "0", { viewer: profile.npub, changes: messages, nextCursor: "7", hasMore: false });
  expect(inspectMailView(root, profile, "needs-response")).toHaveLength(7);
  expect(reserveMailNotices(root, profile, []).ids).toEqual([]);
  expect(() => mailNoticeContacts(root, profile, { action: "accept", npub: "invalid" })).toThrow();
  mailNoticeContacts(root, profile, { action: "accept", npub: peer });
  expect(mailNoticeContacts(root, { ...profile, npub: "another-recipient" })).toEqual([]);
  const notice = reserveMailNotices(root, profile, [], 0);
  expect(notice.ids).toEqual([messages[6].eventId]);
  expect(notice.sources[notice.ids[0]]).toBe(peer);
  mailNoticeContacts(root, profile, { action: "remove", npub: peer });
  expect(reserveMailNotices(root, profile, [], 30_001).ids).toEqual([]);
});
