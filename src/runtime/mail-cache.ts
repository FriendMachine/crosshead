import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type MailViewer = { name: string; apiBase: string; npub: string };
export type MailItem = {
  cursor: string; eventId: string; parentEventId: string | null; contextId: string | null; taskRef: string | null;
  sender: string; recipient: string; kind: string; status: string; text: string; artifactRefs: string[];
  owner?: string | null; assignee?: string | null;
  createdAt: string; updatedAt: string; acknowledgedAt: string | null; resolvedAt: string | null;
};
export type MailPage = { viewer: string; changes: MailItem[]; nextCursor: string; hasMore: boolean };
export type MailView = "needs-response" | "waiting" | "changed" | "thread";

function open(state: string, profile: MailViewer): DatabaseSync {
  const folder = path.join(state, "mail");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(JSON.stringify([profile.name, profile.apiBase, profile.npub])).digest("hex");
  const file = path.join(folder, key + ".db");
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS progress (scope TEXT PRIMARY KEY, cursor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, context TEXT, incoming INTEGER NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, shown INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
    );`);
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
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } finally { db.close(); }
}
export function mailCursor(state: string, profile: MailViewer): string {
  const db = open(state, profile);
  try { return readCursor(db, "sync"); } finally { db.close(); }
}
export function applyMailPage(state: string, profile: MailViewer, after: string, page: MailPage): void {
  if (page.viewer !== profile.npub || !Array.isArray(page.changes)) throw new Error("Unexpected mail feed identity or format");
  transaction(state, profile, db => {
    if (readCursor(db, "sync") !== after) return;
    const upsert = db.prepare(`INSERT INTO items(id,revision,context,incoming,kind,status,data) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, context=excluded.context, incoming=excluded.incoming,
        kind=excluded.kind, status=excluded.status, data=excluded.data`);
    let cursor = after;
    for (const item of page.changes) {
      if ((item.recipient !== profile.npub && item.sender !== profile.npub) || !/^[0-9a-f]{64}$/.test(item.eventId) ||
          !/^\d{1,19}$/.test(item.cursor) || BigInt(item.cursor) > 9223372036854775807n || BigInt(item.cursor) <= BigInt(cursor)) throw new Error("Invalid mail feed item");
      upsert.run(item.eventId, item.cursor, item.contextId, Number(item.recipient === profile.npub), item.kind, item.status, JSON.stringify(item));
      cursor = item.cursor;
    }
    if (page.nextCursor !== cursor || (page.hasMore && cursor === after)) throw new Error("Invalid mail feed cursor");
    saveCursor(db, "sync", cursor);
  });
}
export function takeMailNotices(state: string, profile: MailViewer): string[] {
  return transaction(state, profile, db => {
    const rows = db.prepare("SELECT id FROM items WHERE incoming=1 AND shown=0 AND status='unread' ORDER BY revision LIMIT 5").all();
    const shown = db.prepare("UPDATE items SET shown=1 WHERE id=?");
    return rows.map(row => { shown.run(row.id); return String(row.id); });
  });
}
export function readMailItem(state: string, profile: MailViewer, eventId: string): MailItem | null {
  const db = open(state, profile);
  try {
    const row = db.prepare("SELECT data FROM items WHERE id=?").get(eventId);
    return row ? JSON.parse(String(row.data)) as MailItem : null;
  } finally { db.close(); }
}
export function inspectMailView(state: string, profile: MailViewer, view: MailView, context?: string): MailItem[] {
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
    return results.map(row => JSON.parse(String(row.data)) as MailItem);
  });
}
