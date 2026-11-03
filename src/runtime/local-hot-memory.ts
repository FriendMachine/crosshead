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

const localHotMemoryDir = (stateDir: string): string => path.join(stateDir, LOCAL_HOT_MEMORY_DIR);

const normalizeHotScope = (scope?: string | null): string => {
  const trimmed = typeof scope === "string" ? scope.trim() : "";
  const normalized = trimmed.length > 0 ? trimmed : SHARED_HOT_SCOPE;
  if (!HOT_SCOPE_PATTERN.test(normalized)) throw new Error("Hot-memory scope is invalid");
  return normalized;
};

const safeScopeFileName = (scope: string): string => `${encodeURIComponent(scope)}.json`;

const localHotMemoryFile = (stateDir: string, scope?: string | null): string =>
  path.join(localHotMemoryDir(stateDir), safeScopeFileName(normalizeHotScope(scope)));

const etagFor = (content: string): string => createHash("sha256").update(content).digest("base64url");

const scopeFromFileName = (fileName: string): string => {
  try {
    return decodeURIComponent(fileName.replace(/\.json$/i, ""));
  } catch {
    return fileName.replace(/\.json$/i, "");
  }
};

const readScopeFile = (stateDir: string, fileName: string): Record<string, unknown> | null => {
  const filePath = path.join(localHotMemoryDir(stateDir), fileName);
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

export const readLocalHotMemory = (stateDir: string, scope?: string | null): Record<string, unknown> => {
  const normalizedScope = normalizeHotScope(scope);
  if (normalizedScope === HOT_SCOPE_ALL) {
    const directory = localHotMemoryDir(stateDir);
    const scopes = existsSync(directory)
      ? readdirSync(directory)
          .map((fileName) => readScopeFile(stateDir, fileName))
          .filter((entry): entry is Record<string, unknown> => entry !== null)
      : [];
    return {
      scope: HOT_SCOPE_ALL,
      scopes,
    };
  }

  const filePath = localHotMemoryFile(stateDir, normalizedScope);
  if (!existsSync(filePath)) {
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

export const writeLocalHotMemory = (stateDir: string, content: string, scope?: string | null): Record<string, unknown> => {
  const normalizedScope = normalizeHotScope(scope);
  if (normalizedScope === HOT_SCOPE_ALL) throw new Error("Hot-memory scope all is read-only");
  const filePath = localHotMemoryFile(stateDir, normalizedScope);
  writeManagedFile(filePath, content, stateDir);
  return readLocalHotMemory(stateDir, normalizedScope);
};
