import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { nip19 } from "nostr-tools";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type MailViewer = { name: string; apiBase: string; npub: string };
export type MailItem = {
  notify?: boolean; cursor: string; eventId: string; parentEventId: string | null; contextId: string | null; taskRef: string | null;
  sender: string; recipient: string; kind: string; status: string; text: string; artifactRefs: string[];
  owner?: string | null; assignee?: string | null;
  createdAt: string; updatedAt: string; acknowledgedAt: string | null; resolvedAt: string | null;
};
export type MailPage = { viewer: string; changes: (MailItem | { removed: true; cursor: string; eventId: string })[]; nextCursor: string; hasMore: boolean };
export type MailView = "needs-response" | "waiting" | "changed" | "thread";

function cacheName(profile: MailViewer): string {
  return createHash("sha256").update(JSON.stringify([profile.name, profile.apiBase, profile.npub])).digest("hex") + ".db";
}

export function pruneRemovedMailProfiles<T extends MailViewer>(state: string, readProfiles: () => (T | null)[]): (T | null)[] {
  const folder = path.join(state, "mail");
  // Snapshot cache names first so a new profile created during this scan retains its cache.
  const files = existsSync(folder) ? readdirSync(folder) : [];
  const profiles = readProfiles();
  if (profiles.every(p => p !== null)) {
    const active = new Set(profiles.map(cacheName));
    for (const file of files) {
      const match = /^([0-9a-f]{64}\.db)(?:-journal|-wal|-shm)?$/.exec(file);
      if (match && !active.has(match[1])) rmSync(path.join(folder, file), { force: true });
    }
  }
  return profiles;
}

function open(state: string, profile: MailViewer): DatabaseSync {
  const folder = path.join(state, "mail");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const file = path.join(folder, cacheName(profile));
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  closeSync(openSync(file, "a", 0o600));
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout=2000; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS notice_contacts (sender TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS notice_leases (id TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS progress (scope TEXT PRIMARY KEY, cursor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, context TEXT, incoming INTEGER NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, shown INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mail_notice_sender ON items(json_extract(data,'$.sender'), revision)
      WHERE incoming=1 AND shown=0 AND status='unread';`);
  return db;
}
function readCursor(db: DatabaseSync, scope: string): string {
  return String(db.prepare("SELECT cursor FROM progress WHERE scope=?").get(scope)?.cursor ?? "0");
}
function saveCursor(db: DatabaseSync, scope: string, cursor: string): void {
  db.prepare("INSERT INTO progress VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET cursor=excluded.cursor").run(scope, cursor);
}
function transaction<T>(state: string, profile: MailViewer, work: (db: DatabaseSync) => T): T {
  const db = open(state, profile);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { if (db.isTransaction) db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  } finally { db.close(); }
}
export function mailCursor(state: string, profile: MailViewer): string {
  const db = open(state, profile);
  try { return readCursor(db, "sync"); } finally { db.close(); }
}
export function applyMailPage(state: string, profile: MailViewer, after: string, page: MailPage): boolean {
  if (page.viewer !== profile.npub || !Array.isArray(page.changes)) throw new Error("Unexpected mail feed identity or format");
  return transaction(state, profile, db => {
    if (readCursor(db, "sync") !== after) return false;
    const upsert = db.prepare(`INSERT INTO items(id,revision,context,incoming,kind,status,data,shown) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, context=excluded.context, incoming=excluded.incoming,
        kind=excluded.kind, status=excluded.status, data=excluded.data, shown=MAX(items.shown,excluded.shown)`);
    let cursor = after;
    for (const item of page.changes) {
      if (!item || typeof item !== "object" || !/^[0-9a-f]{64}$/.test(item.eventId) ||
          !/^\d{1,19}$/.test(item.cursor) || BigInt(item.cursor) > 9223372036854775807n || BigInt(item.cursor) <= BigInt(cursor)) throw new Error("Invalid mail feed item");
      cursor = item.cursor;
      if ("removed" in item && item.removed === true) {
        db.prepare("DELETE FROM items WHERE id=?").run(item.eventId);
        db.prepare("DELETE FROM notice_leases WHERE id=?").run(item.eventId);
        continue;
      }
      if (!("recipient" in item) || (item.recipient !== profile.npub && item.sender !== profile.npub)) throw new Error("Invalid mail feed participant");
      upsert.run(item.eventId, item.cursor, item.contextId, Number(item.recipient === profile.npub), item.kind, item.status, JSON.stringify(item), Number(item.notify === false));
    }
    if (page.nextCursor !== cursor || (page.hasMore && cursor === after)) throw new Error("Invalid mail feed cursor");
    saveCursor(db, "sync", cursor);
    return true;
  });
}
export function mailNoticeContacts(state: string, profile: MailViewer, change?: { action: "accept" | "remove"; npub: string }): string[] {
  if (change) {
    let valid = false;
    try {
      const key = nip19.decode(change.npub);
      valid = key.type === "npub" && nip19.npubEncode(key.data) === change.npub;
    } catch { /* Reject a malformed public key. */ }
    if (!valid) throw new Error("A canonical public npub is required");
  }
  return transaction(state, profile, db => {
    if (change?.action === "accept") db.prepare("INSERT OR IGNORE INTO notice_contacts VALUES(?)").run(change.npub);
    if (change?.action === "remove") db.prepare("DELETE FROM notice_contacts WHERE sender=?").run(change.npub);
    return db.prepare("SELECT sender FROM notice_contacts ORDER BY sender").all().map(row => String(row.sender));
  });
}

export function reserveMailNotices(state: string, profile: MailViewer, localSenders: string[], now = Date.now()) {
  return transaction(state, profile, db => {
    db.prepare("DELETE FROM notice_leases WHERE expires <= ?").run(now);
    const rows = db.prepare(`SELECT id, json_extract(data,'$.sender') AS sender FROM items WHERE incoming=1 AND shown=0 AND status='unread'
      AND json_extract(data,'$.sender') IN (SELECT value FROM json_each(?) UNION SELECT sender FROM notice_contacts)
      AND id NOT IN (SELECT id FROM notice_leases) ORDER BY revision LIMIT 5`).all(JSON.stringify(localSenders));
    const token = randomUUID();
    const reserve = db.prepare("INSERT INTO notice_leases VALUES(?,?,?)");
    const ids = rows.map(row => String(row.id));
    for (const id of ids) reserve.run(id, token, now + 30_000);
    return { ids, token, sources: Object.fromEntries(rows.map(row => [String(row.id), String(row.sender)])) };
  });
}
export function confirmMailNotices(state: string, profile: MailViewer, token: string): void {
  transaction(state, profile, db => {
    db.prepare("UPDATE items SET shown=1 WHERE id IN (SELECT id FROM notice_leases WHERE token=?)").run(token);
    db.prepare("DELETE FROM notice_leases WHERE token=?").run(token);
  });
}
export function readMailItem(state: string, profile: MailViewer, eventId: string, markShown = false): MailItem | null {
  return transaction(state, profile, db => {
    if (markShown) db.prepare("UPDATE items SET shown=1 WHERE id=?").run(eventId);
    const row = db.prepare("SELECT data FROM items WHERE id=?").get(eventId);
    return row ? JSON.parse(String(row.data)) as MailItem : null;
  });
}
export function inspectMailView(state: string, profile: MailViewer, view: MailView, context?: string): MailItem[] {
  if (context !== undefined && !/^ctx_[a-z0-9][a-z0-9_-]{2,127}$/.test(context)) throw new Error("Invalid context ID");
  if (view === "thread" && !context) throw new Error("thread requires a context ID");
  return transaction(state, profile, db => {
    const scope = "seen:" + (context ?? "*");
    const where = ["(? IS NULL OR context=?)"];
    const values = [context ?? null, context ?? null];
    if (view === "changed") {
      where.push("revision > CAST(? AS INTEGER)");
      values.push(readCursor(db, scope));
    } else if (view === "needs-response" || view === "waiting") {
      where.push("kind='assignment'", "status IN ('unread','acknowledged')", view === "waiting" ? "incoming=0" : "incoming=1");
    } else if (view !== "thread") throw new Error("Unknown mail view");
    const results = db.prepare("SELECT data FROM items WHERE " + where.join(" AND ") + " ORDER BY revision").all(...values);
    if (view === "changed") saveCursor(db, scope, readCursor(db, "sync"));
    const items = results.map(row => JSON.parse(String(row.data)) as MailItem);
    if (view === "thread") items.sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.eventId.localeCompare(b.eventId));
    return items;
  });
}
