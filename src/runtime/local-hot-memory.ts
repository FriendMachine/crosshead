import { filterHotMemorySnapshotForWorkspace } from "./workspace-memory";
import { workspaceHotScope } from "./workspace-hot-memory";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";

import { HOT_SCOPE_ALL, HOT_SCOPE_PATTERN, SHARED_HOT_SCOPE } from "../protocol/memory";
import { writeManagedFile } from "./adapter-utils";

const LOCAL_HOT_MEMORY_DIR = "local-hot-memory";

type RuntimeProfileLike = {
  apiBase: string;
};

export const isLocalOnlyRuntimeProfile = (profile: RuntimeProfileLike): boolean => {
  try {
    const parsed = new URL(profile.apiBase);
    return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === "0";
  } catch {
    return false;
  }
};

type HotMemoryOwner = { name: string; npub: string };

const localHotMemoryDir = (stateDir: string, owner?: HotMemoryOwner): string =>
  owner
    ? path.join(stateDir, LOCAL_HOT_MEMORY_DIR, "profiles", createHash("sha256").update(JSON.stringify([owner.name, owner.npub])).digest("hex"))
    : path.join(stateDir, LOCAL_HOT_MEMORY_DIR);

export const legacyOwnerFile = (stateDir: string): string => path.join(stateDir, "legacy-local-hot-owner.json");

const legacyOwners = new Map<string, { signature: string; owner: HotMemoryOwner | null }>();

/** Before namespacing, a flat store was shared by the runtime's local-only profiles.
 * Adopt it only for its sole existing local profile, and pin that identity before
 * another profile can be created. Old bytes remain available for recovery. */
const legacyOwner = (stateDir: string): HotMemoryOwner | null => {
  const pinned = legacyOwnerFile(stateDir);
  if (existsSync(pinned)) {
    try {
      const owner = JSON.parse(readFileSync(pinned, "utf8")) as HotMemoryOwner;
      return typeof owner.name === "string" && typeof owner.npub === "string" ? owner : null;
    } catch { return null; }
  }
  const profiles = path.join(path.dirname(stateDir), "config", "profiles");
  if (!existsSync(profiles)) return null;
  const names = readdirSync(profiles).filter(name => name.endsWith(".json")).sort();
  const signature = JSON.stringify(names.map(name => {
    try {
      const stat = statSync(path.join(profiles, name), { bigint: true });
      return [name, stat.ino.toString(), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()];
    } catch { return [name, "unavailable"]; }
  }));
  const cached = legacyOwners.get(stateDir);
  if (cached?.signature === signature) return cached.owner;
  let unclassified = false;
  const local = names.flatMap(name => {
    try {
      const profile = JSON.parse(readFileSync(path.join(profiles, name), "utf8"));
      if (!profile || typeof profile !== "object" || Array.isArray(profile) || profile.name !== name.slice(0, -5) ||
	  typeof profile.npub !== "string" || !profile.npub || typeof profile.apiBase !== "string" ||
	  !["http:", "https:"].includes(new URL(profile.apiBase).protocol)) throw new Error("Unclassified legacy profile");
      return isLocalOnlyRuntimeProfile(profile) ? [profile as HotMemoryOwner] : [];
    } catch { unclassified = true; return []; }
  });
  const owner = !unclassified && local.length === 1 ? { name: local[0]!.name, npub: local[0]!.npub } : null;
  if (legacyOwners.size >= 64) legacyOwners.delete(legacyOwners.keys().next().value!);
  legacyOwners.set(stateDir, { signature, owner });
  return owner;
};

export const planLegacyLocalHotOwner = (stateDir: string): { file: string; content: string } | null => {
  if (existsSync(legacyOwnerFile(stateDir))) return null;
  const directory = localHotMemoryDir(stateDir);
  if (!existsSync(directory) || !readdirSync(directory).some(name => name.endsWith(".json"))) return null;
  const owner = legacyOwner(stateDir);
  return { file: legacyOwnerFile(stateDir), content: JSON.stringify(owner ?? { ambiguous: true }) };
};

export const preserveLegacyLocalHotOwner = (stateDir: string): void => {
  const planned = planLegacyLocalHotOwner(stateDir);
  if (planned) writeManagedFile(planned.file, planned.content, stateDir);
};

const canReadLegacy = (stateDir: string, owner: HotMemoryOwner): boolean => {
  const flat = localHotMemoryDir(stateDir);
  if (!existsSync(flat) || !readdirSync(flat).some(name => name.endsWith(".json"))) return false;
  const legacy = legacyOwner(stateDir);
  return legacy?.name === owner.name && legacy.npub === owner.npub;
};

const normalizeHotScope = (scope?: string | null): string => {
  const trimmed = typeof scope === "string" ? scope.trim() : "";
  const normalized = trimmed.length > 0 ? trimmed : SHARED_HOT_SCOPE;
  if (!HOT_SCOPE_PATTERN.test(normalized)) throw new Error("Hot-memory scope is invalid");
  return normalized;
};

const safeScopeFileName = (scope: string): string => `${encodeURIComponent(scope)}.json`;

const localHotMemoryFile = (directory: string, scope?: string | null): string =>
  path.join(directory, safeScopeFileName(normalizeHotScope(scope)));

const etagFor = (content: string): string => createHash("sha256").update(content).digest("base64url");

const scopeFromFileName = (fileName: string): string => {
  try {
    return decodeURIComponent(fileName.replace(/\.json$/i, ""));
  } catch {
    return fileName.replace(/\.json$/i, "");
  }
};

const readScopeFile = (directory: string, fileName: string): Record<string, unknown> | null => {
  const filePath = path.join(directory, fileName);
  if (!existsSync(filePath) || !fileName.endsWith(".json")) {
    return null;
  }
  try {
    const content = readFileSync(filePath, "utf8");
    const stat = statSync(filePath);
    return {
      scope: scopeFromFileName(fileName),
      content,
      etag: etagFor(content),
      size_bytes: Buffer.byteLength(content, "utf8"),
      updated_at: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
};

export const readLocalHotMemory = (stateDir: string, scope?: string | null, owner?: HotMemoryOwner): Record<string, unknown> => {
  const directory = localHotMemoryDir(stateDir, owner);
  const normalizedScope = normalizeHotScope(scope);
  if (normalizedScope === HOT_SCOPE_ALL) {
    const scopes = existsSync(directory)
      ? readdirSync(directory)
		  .map((fileName) => readScopeFile(directory, fileName))
          .filter((entry): entry is Record<string, unknown> => entry !== null)
      : [];
    if (owner && canReadLegacy(stateDir, owner)) {
      const legacy = readLocalHotMemory(stateDir, HOT_SCOPE_ALL).scopes as Array<Record<string, unknown>>;
      const ownedScopes = new Set(scopes.map(entry => entry.scope));
      scopes.push(...legacy.filter(entry => !ownedScopes.has(entry.scope)));
    }
    return { scope: HOT_SCOPE_ALL, scopes };
  }

  const filePath = localHotMemoryFile(directory, normalizedScope);
  if (!existsSync(filePath)) {
    if (owner && canReadLegacy(stateDir, owner)) return readLocalHotMemory(stateDir, normalizedScope);
    return {
      scope: normalizedScope,
      content: "",
      etag: etagFor(""),
      size_bytes: 0,
      updated_at: null,
    };
  }
  const content = readFileSync(filePath, "utf8");
  const stat = statSync(filePath);
  return {
    scope: normalizedScope,
    content,
    etag: etagFor(content),
    size_bytes: Buffer.byteLength(content, "utf8"),
    updated_at: stat.mtime.toISOString(),
  };
};

export const writeLocalHotMemory = (stateDir: string, content: string, scope?: string | null, owner?: HotMemoryOwner): Record<string, unknown> => {
  if (owner) preserveLegacyLocalHotOwner(stateDir);
  const normalizedScope = normalizeHotScope(scope);
  if (normalizedScope === HOT_SCOPE_ALL) throw new Error("Hot-memory scope all is read-only");
  const filePath = localHotMemoryFile(localHotMemoryDir(stateDir, owner), normalizedScope);
  writeManagedFile(filePath, content, stateDir);
  return readLocalHotMemory(stateDir, normalizedScope, owner);
};

/** Fingerprint the complete source set, including newly arrived partitions. */
export const localHotMemoryAdoptionSnapshot = (stateDir: string, owner: HotMemoryOwner) => {
  const directories = [localHotMemoryDir(stateDir), localHotMemoryDir(stateDir, owner)];
  const source = directories.map(directory => existsSync(directory)
    ? readdirSync(directory).filter(name => name.endsWith(".json")).sort().map(name => {
      const file = path.join(directory, name);
      return [name, statSync(file).mtime.toISOString(), createHash("sha256").update(readFileSync(file)).digest("hex")];
    }) : []);
  const marker = legacyOwnerFile(stateDir);
  return { fingerprint: createHash("sha256").update(JSON.stringify(source)).digest("hex"), legacyOwner: existsSync(marker) ? readFileSync(marker, "utf8") : null };
};

/** Copy eligible history into current workspace partitions before the first new session.
 * Original flat archives remain untouched and cease being a fallback after replacement. */
export const planLocalHotMemoryAdoption = (
  stateDir: string, owner: HotMemoryOwner, workspaceId: string, unscoped: boolean, before?: string
) => {
  const sourceSnapshot = localHotMemoryAdoptionSnapshot(stateDir, owner);
  const raw = readLocalHotMemory(stateDir, "all", owner);
  const entries = (raw.scopes ?? []) as Array<Record<string, unknown>>;
  const tagged = entries.map(entry => {
    const owned = localHotMemoryFile(localHotMemoryDir(stateDir, owner), String(entry.scope));
    const source = existsSync(owned) ? owned : localHotMemoryFile(localHotMemoryDir(stateDir), String(entry.scope));
    return { ...entry, adoptionSource: source, adoptionBefore: String(entry.content ?? "") };
  });
  const snapshot = filterHotMemorySnapshotForWorkspace({ ...raw, scopes: tagged }, workspaceId, true, unscoped, before);
  const sources = new Map<string, { file: string; before: string }>();
  const planned = new Map<string, { file: string; content: string; time: number }>();
  for (const entry of (snapshot?.scopes ?? []) as Array<Record<string, unknown>>) {
    const content = String(entry.content ?? "");
    let state: Record<string, unknown>;
    try { state = JSON.parse(content); } catch { continue; }
    const runtime = typeof state.runtime === "string" ? state.runtime : null;
    const scopes = new Set([String(entry.scope), ...(runtime ? [workspaceHotScope(runtime, workspaceId)!] : [])]);
    const time = Date.parse(String(state.updatedAt ?? entry.updated_at)) || 0;
    for (const scope of scopes) {
      const file = localHotMemoryFile(localHotMemoryDir(stateDir, owner), normalizeHotScope(scope));
      if (existsSync(file)) continue;
      if (!planned.has(file) || time > planned.get(file)!.time) {
	planned.set(file, { file, content, time });
	const source = String(entry.adoptionSource);
	sources.set(source, { file: source, before: String(entry.adoptionBefore) });
      }
    }
  }
  if (planned.size && !existsSync(legacyOwnerFile(stateDir)) && canReadLegacy(stateDir, owner)) {
    const file = legacyOwnerFile(stateDir);
    planned.set(file, { file, content: JSON.stringify({ name: owner.name, npub: owner.npub }), time: 0 });
  }
  return { files: [...planned.values()].map(({ file, content }) => ({ file, content })), sources: [...sources.values()], snapshot: { stateDir, owner: { name: owner.name, npub: owner.npub }, ...sourceSnapshot } };
};
