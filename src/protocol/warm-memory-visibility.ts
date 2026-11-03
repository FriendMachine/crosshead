import type { WarmEntry } from "./memory";

export type WarmMemoryVisibility = {
  generalWarmMemory: boolean;
  systemMemory: boolean;
  reason: string | null;
  schemaVersion: string | null;
};

const STRUCTURED_SYSTEM_TAGS = new Set([
  "continuity:judgment",
  "agent:self-model",
  "memory-route:continuity_judgment",
  "memory-route:agent_self_model",
]);

const STRUCTURED_SYSTEM_SCHEMA_VERSIONS = new Set([
  "continuity_judgment_entry_v1",
  "agent_self_model_entry_v1",
]);

const parseSchemaVersion = (content: string): string | null => {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
    return typeof schemaVersion === "string" && schemaVersion.trim().length > 0 ? schemaVersion.trim() : null;
  } catch {
    return null;
  }
};

export const inspectWarmMemoryVisibility = (entry: Pick<WarmEntry, "content" | "tags">): WarmMemoryVisibility => {
  const matchingTag = entry.tags.find((tag) => STRUCTURED_SYSTEM_TAGS.has(tag)) ?? null;
  if (matchingTag) {
    return {
      generalWarmMemory: false,
      systemMemory: true,
      reason: `structured_system_tag:${matchingTag}`,
      schemaVersion: parseSchemaVersion(entry.content),
    };
  }

  const schemaVersion = parseSchemaVersion(entry.content);
  if (schemaVersion && STRUCTURED_SYSTEM_SCHEMA_VERSIONS.has(schemaVersion)) {
    return {
      generalWarmMemory: false,
      systemMemory: true,
      reason: `structured_system_schema:${schemaVersion}`,
      schemaVersion,
    };
  }

  return {
    generalWarmMemory: true,
    systemMemory: false,
    reason: null,
    schemaVersion,
  };
};

export const isStructuredSystemWarmEntry = (entry: Pick<WarmEntry, "content" | "tags">): boolean =>
  inspectWarmMemoryVisibility(entry).systemMemory;

export const filterWarmEntriesForGeneralUse = <T extends Pick<WarmEntry, "content" | "tags">>(
  entries: T[],
  options: { includeSystemMemory?: boolean } = {}
): T[] => (options.includeSystemMemory === true ? entries : entries.filter((entry) => !isStructuredSystemWarmEntry(entry)));
