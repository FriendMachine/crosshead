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
  try {
    const file = markerFile(runtimeHome, host), marker = readMarker(file);
    if (!Object.hasOwn(marker, workspaceId)) return;
    delete marker[workspaceId];
    writeJsonFile(file, marker);
  } catch { /* A missed release only costs the larger budget once. */ }
};
