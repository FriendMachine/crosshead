import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const workspaceRepositoryRoot = (directory: string): string | null => {
  for (let current = directory;; current = path.dirname(current)) {
    const git = path.join(current, ".git");
    if (existsSync(path.join(git, "HEAD"))) return current;
    try {
      const info = statSync(git);
      if (info.isFile() && info.size <= 4096 && readFileSync(git, "utf8").startsWith("gitdir: ")) return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (path.dirname(current) === current) return null;
  }
};

export const workspaceDirectoryPath = (directory: string): string => {
  const resolved = realpathSync(directory);
  if (!statSync(resolved).isDirectory()) throw new Error(`Expected a directory: ${directory}`);
  return resolved;
};

export const workspaceProjectRoot = (directory: string): string => {
  const resolved = workspaceDirectoryPath(directory);
  return workspaceRepositoryRoot(resolved) ?? resolved;
};
