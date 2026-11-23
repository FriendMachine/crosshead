import { existsSync, readFileSync } from "fs";
import path from "path";
import { ensureRuntimeHomeLayout } from "./local-runtime";
import { writeJsonFile } from "./runtime-persistence";

// Which host session last received its full session-start hot context. The
// first prompt of a session gets a large budget; repeating that on every prompt
// would spend the user's context window on text the session already holds.
const markerFile = (runtimeHome: string, host: string): string =>
  path.join(ensureRuntimeHomeLayout(runtimeHome).state, `${host}-context-session.json`);

const readMarker = (file: string): Record<string, string[] | string> => {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string[] | string> : {};
  } catch { return {}; }
};

/** True once per (workspace, session): the caller should deliver the session-start budget. */
export const claimSessionStartContext = (runtimeHome: string, host: string, workspaceId: string, sessionId: string): boolean => {
  try {
    const file = markerFile(runtimeHome, host), marker = readMarker(file);
    // Several sessions can be open in one workspace; each is served once.
    const served = Object.hasOwn(marker, workspaceId) ? [marker[workspaceId]!].flat().filter(id => typeof id === "string") : [];
    if (served.includes(sessionId)) return false;
    const entries = Object.entries({ ...marker, [workspaceId]: [...served, sessionId].slice(-8) }).slice(-64);
    writeJsonFile(file, Object.fromEntries(entries));
    return true;
  } catch { return false; }
};

/** After compaction the host has dropped earlier context, so the next prompt is a fresh start. */
export const releaseSessionStartContext = (runtimeHome: string, host: string, workspaceId: string): void => {
  resetSessionDelivery(runtimeHome, host, { workspaceId });
  try {
    const file = markerFile(runtimeHome, host), marker = readMarker(file);
    if (!Object.hasOwn(marker, workspaceId)) return;
    delete marker[workspaceId];
    writeJsonFile(file, marker);
  } catch { /* A missed release only costs the larger budget once. */ }
};

// Which hot checkpoints each host session has already been given. A checkpoint
// the session already holds is not sent again on every prompt; compaction, a
// session start or a changed checkpoint (a new digest) sends it again.
// Local state only: never synced, keyed by host session.
const deliveryFile = (runtimeHome: string, host: string): string =>
  path.join(ensureRuntimeHomeLayout(runtimeHome).state, `${host}-context-delivery.json`);
// A safety net for compactions no hook reports: after this many prompts the
// session receives its checkpoints again.
export const HOT_REDELIVERY_PROMPTS = 25;
const MAX_DELIVERY_SESSIONS = 64;
const MAX_DELIVERY_DIGESTS = 48;

type DeliveryRecord = { workspaceId: string; digests: string[]; prompts: number; updatedAt: string };

const readDeliveries = (file: string): Record<string, DeliveryRecord> => {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => {
      const item = value as Partial<DeliveryRecord> | null;
      return item && typeof item === "object" && Array.isArray(item.digests) && typeof item.prompts === "number"
        ? [[key, { workspaceId: String(item.workspaceId ?? ""), digests: item.digests.filter((d): d is string => typeof d === "string"), prompts: item.prompts, updatedAt: String(item.updatedAt ?? "") }]]
        : [];
    }));
  } catch { return {}; }
};

/**
 * What this session already received. `refresh` is true when it must be treated
 * as holding nothing: no record (new session, or reset by compaction) or the
 * redelivery interval has passed.
 */
export const readSessionDelivery = (runtimeHome: string, host: string, sessionId: string): { delivered: Set<string>; refresh: boolean } => {
  try {
    const record = readDeliveries(deliveryFile(runtimeHome, host))[sessionId];
    if (!record || record.prompts >= HOT_REDELIVERY_PROMPTS) return { delivered: new Set(), refresh: true };
    return { delivered: new Set(record.digests), refresh: false };
  } catch { return { delivered: new Set(), refresh: true }; }
};

/** Record this prompt's deliveries. `refresh` starts a new record; otherwise digests are added. */
export const recordSessionDelivery = (runtimeHome: string, host: string, workspaceId: string, sessionId: string, digests: string[], refresh: boolean): void => {
  try {
    const file = deliveryFile(runtimeHome, host), records = readDeliveries(file);
    const previous = refresh ? undefined : records[sessionId];
    delete records[sessionId];
    const merged = [...new Set([...(previous?.digests ?? []), ...digests])].slice(-MAX_DELIVERY_DIGESTS);
    const next = { ...records, [sessionId]: { workspaceId, digests: merged, prompts: (previous?.prompts ?? 0) + 1, updatedAt: new Date().toISOString() } };
    writeJsonFile(file, Object.fromEntries(Object.entries(next).slice(-MAX_DELIVERY_SESSIONS)));
  } catch { /* A lost record only means a checkpoint is sent again. */ }
};

/** Compaction dropped what the session held: forget its deliveries (one session, or every session in a workspace). */
export const resetSessionDelivery = (runtimeHome: string, host: string, target: { sessionId?: string | null; workspaceId?: string | null }): void => {
  try {
    const file = deliveryFile(runtimeHome, host), records = readDeliveries(file);
    const kept = Object.entries(records).filter(([session, record]) =>
      !(target.sessionId && session === target.sessionId) && !(target.workspaceId && record.workspaceId === target.workspaceId));
    if (kept.length !== Object.keys(records).length) writeJsonFile(file, Object.fromEntries(kept));
  } catch { /* A failed reset can only withhold a repeat; the redelivery interval bounds that. */ }
};
