import path from "node:path";
import { workspaceProjectRoot } from "./workspace-identity";
import { workspaceHotScope } from "./workspace-hot-memory";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseJsonRecord = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const parseHotMemoryEntryContent = (entry: Record<string, unknown>): Record<string, unknown> | null => {
  if (isRecord(entry.content)) {
    return entry.content;
  }
  return typeof entry.content === "string" ? parseJsonRecord(entry.content) : null;
};

const hasHotMemoryEntryContent = (entry: Record<string, unknown>): boolean => {
  if (isRecord(entry.content)) {
    return true;
  }
  return typeof entry.content === "string" && entry.content.trim().length > 0;
};

const getWorkspaceId = (value: Record<string, unknown> | null): string | null => {
  const workspaceId = value?.workspaceId ?? value?.workspace_id;
  return typeof workspaceId === "string" && workspaceId.trim().length > 0 ? workspaceId.trim() : null;
};

export const filterHotMemorySnapshotForWorkspace = (
  hotMemory: Record<string, unknown> | null,
  workspaceId: string,
  workspaceOnly = false,
  legacyUnscoped = false,
  legacyBefore?: string
): Record<string, unknown> | null => {
  if (!hotMemory) {
    return null;
  }
  if (workspaceOnly && workspaceId.startsWith("repo:")) {
    const target = workspaceId.slice(5);
    const roots = new Map<string, boolean>();
    const equivalent = (id: string | null, observedAt?: unknown): boolean => {
      if (id === workspaceId) return true;
      if (!id) return legacyUnscoped && Boolean(legacyBefore) && typeof observedAt === "string" &&
	Date.parse(observedAt) <= Date.parse(legacyBefore!);
      if (!id.startsWith("repo:") || !path.isAbsolute(id.slice(5))) return false;
      if (!roots.has(id)) {
	try { roots.set(id, workspaceProjectRoot(id.slice(5)) === target); } catch { roots.set(id, false); }
      }
      return roots.get(id)!;
    };
    const normalize = (entry: Record<string, unknown>): Record<string, unknown> | null => {
      const content = parseHotMemoryEntryContent(entry);
      if (!content || !equivalent(getWorkspaceId(content), entry.updated_at ?? content.updatedAt ?? content.occurredAt)) return null;
      const checkpoints = Array.isArray(content.continuityCheckpoints)
	? content.continuityCheckpoints.filter(isRecord).filter(checkpoint => equivalent(getWorkspaceId(checkpoint), checkpoint.occurredAt ?? entry.updated_at ?? content.updatedAt))
	  .map(checkpoint => ({ ...checkpoint, workspaceId })) : undefined;
      return { ...entry, content: JSON.stringify({ ...content, workspaceId,
	...(checkpoints ? { continuityCheckpoints: checkpoints } : {}) }) };
    };
    hotMemory = Array.isArray(hotMemory.scopes)
      ? { ...hotMemory, scopes: hotMemory.scopes.filter(isRecord).map(normalize).filter(isRecord) }
      : normalize(hotMemory);
    if (!hotMemory) return null;
  }
  const scopedEntries = Array.isArray(hotMemory.scopes) ? hotMemory.scopes.filter(isRecord) : null;
  if (!scopedEntries) {
    if (!hasHotMemoryEntryContent(hotMemory)) {
      return null;
    }
    const entryWorkspaceId = getWorkspaceId(parseHotMemoryEntryContent(hotMemory));
    return entryWorkspaceId === workspaceId || (!workspaceOnly && !entryWorkspaceId) ? hotMemory : null;
  }
  const scopes = scopedEntries.filter((entry) => {
    if (!hasHotMemoryEntryContent(entry)) {
      return false;
    }
    const entryWorkspaceId = getWorkspaceId(parseHotMemoryEntryContent(entry));
    return entryWorkspaceId === workspaceId || (!workspaceOnly && !entryWorkspaceId);
  });
  if (scopes.length === 0) {
    return null;
  }
  // The legacy runtime alias and its retained workspace partition describe one
  // document. Inject the newest version once, under the readable runtime name.
  const selected = new Map<string, Record<string, unknown>>();
  const other: Record<string, unknown>[] = [];
  for (const entry of scopes) {
    const content = parseHotMemoryEntryContent(entry);
    const runtime = typeof content?.runtime === "string" ? content.runtime : null;
    if (!runtime || getWorkspaceId(content) !== workspaceId ||
      ![runtime, workspaceHotScope(runtime, workspaceId)].includes(String(entry.scope))) {
      other.push(entry);
      continue;
    }
    const previous = selected.get(runtime);
    const updated = Date.parse(String(content?.updatedAt)) || 0;
    const previousUpdated = Date.parse(String(parseHotMemoryEntryContent(previous ?? {})?.updatedAt)) || 0;
    if (!previous || updated >= previousUpdated) selected.set(runtime, { ...entry, scope: runtime });
  }
  return { ...hotMemory, scopes: [...other, ...selected.values()] };
};
