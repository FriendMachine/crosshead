import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "fs";
import path from "path";

// The git state a checkpoint was written in. When the checkpoint is shown in
// another checkout, on another machine or after the tree moved on, the reader
// is told what differs instead of trusting results observed on other bytes.
// Warning only: nothing here restores or rewrites a file.
export type WorkspaceGitState = {
  head: string | null;
  branch: string | null;
  dirty: boolean;
  /** Untracked files at capture, with content hashes (bounded). */
  untracked: Array<{ path: string; sha256: string | null }>;
  untrackedOmitted?: number;
};

const GIT_TIMEOUT_MS = 1500;
const MAX_UNTRACKED = 20;
const MAX_HASH_BYTES = 512 * 1024;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
// Never record names that look like secrets or private host state.
const privateName = /(?:^|[/\\.'"_-])(?:env|secrets?|credentials?|id_rsa|id_ed25519|nsec|npmrc|pypirc)(?:$|[/\\.'"_-])|\.pem$|\.key$|\.tfvars$|(?:^|\/)\.(?:git|claude|codex|crosshead|onlybots|ssh|aws)(?:\/|$)/i;

const hashFile = (file: string): string | null => {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_HASH_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    readSync(fd, buffer, 0, stat.size, 0);
    return createHash("sha256").update(buffer).digest("hex");
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
};

/** Current git state of a workspace, or null when it is not a git checkout, git is missing or too slow. */
export const readWorkspaceGitState = (workspaceRoot: string): WorkspaceGitState | null => {
  let output: string;
  try {
    output = execFileSync("git", ["-C", workspaceRoot, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], {
      encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch { return null; }
  let root: string;
  try { root = realpathSync(workspaceRoot); } catch { root = workspaceRoot; }
  let head: string | null = null, branch: string | null = null, dirty = false;
  const untracked: WorkspaceGitState["untracked"] = [];
  let untrackedOmitted = 0;
  for (const record of output.split("\0")) {
    if (record.startsWith("# branch.oid ")) { const oid = record.slice(13).trim(); head = SHA.test(oid) ? oid : null; }
    else if (record.startsWith("# branch.head ")) { const name = record.slice(14).trim(); branch = name && name !== "(detached)" ? name.slice(0, 200) : null; }
    else if (record.startsWith("? ")) {
      dirty = true;
      const file = record.slice(2);
      if (privateName.test(file)) { untrackedOmitted++; continue; }
      if (untracked.length >= MAX_UNTRACKED) { untrackedOmitted++; continue; }
      untracked.push({ path: file.slice(0, 500), sha256: hashFile(path.join(root, file)) });
    } else if (/^[12u] /.test(record)) dirty = true;
  }
  return { head, branch, dirty, untracked, ...(untrackedOmitted ? { untrackedOmitted } : {}) };
};

export const normalizeWorkspaceGitState = (value: unknown): WorkspaceGitState | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const head = typeof item.head === "string" && SHA.test(item.head) ? item.head : null;
  const branch = typeof item.branch === "string" && item.branch ? item.branch.slice(0, 200) : null;
  const untracked = (Array.isArray(item.untracked) ? item.untracked : []).flatMap(entry => {
    const file = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (typeof file?.path !== "string" || !file.path || privateName.test(file.path)) return [];
    return [{ path: file.path.slice(0, 500), sha256: typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256) ? file.sha256 : null }];
  }).slice(0, MAX_UNTRACKED);
  const omitted = Number(item.untrackedOmitted);
  if (!head && !branch && item.dirty !== true && !untracked.length) return undefined;
  return { head, branch, dirty: item.dirty === true, untracked,
    ...(Number.isSafeInteger(omitted) && omitted > 0 ? { untrackedOmitted: Math.min(omitted, 100000) } : {}) };
};

const short = (sha: string | null): string => sha ? sha.slice(0, 10) : "an unknown commit";
const where = (state: WorkspaceGitState): string => `${short(state.head)}${state.branch ? ` on ${state.branch}` : ""}`;

/**
 * One line naming what differs between the tree a checkpoint was written in and
 * the tree here now, or "" when nothing differs or nothing can be compared.
 * `current` null means this workspace is not a readable git checkout.
 */
/** Whether a file excerpt still appears in the file on disk: "missing", "changed" or "same". */
export const fileExcerptState = (workspaceRoot: string, relative: string, excerpt: string): "missing" | "changed" | "same" => {
  const file = path.resolve(workspaceRoot, relative);
  const inside = path.relative(path.resolve(workspaceRoot), file);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return "same";
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return "missing";
    if (stat.size > 4 * MAX_HASH_BYTES) return "same";
    const buffer = Buffer.alloc(stat.size);
    readSync(fd, buffer, 0, stat.size, 0);
    // Compare a bounded prefix of the excerpt: hosts strip gutters and may cut the end.
    const probe = excerpt.trim().slice(0, 1500).replace(/\s+/g, " ");
    return buffer.toString("utf8").replace(/\s+/g, " ").includes(probe) ? "same" : "changed";
  } catch { return "missing"; } finally { if (fd !== undefined) closeSync(fd); }
};

export const describeWorkspaceDrift = (then: WorkspaceGitState | undefined, current: WorkspaceGitState | null, workspaceRoot: string | null): string => {
  if (!then) return "";
  const notes: string[] = [];
  if (!current) {
    if (then.head) notes.push(`written at ${where(then)}; no git checkout is readable here`);
  } else {
    const moved = Boolean(then.head && current.head && then.head !== current.head);
    if (moved) notes.push(`written at ${where(then)}; now ${where(current)}`);
    else if (then.branch && current.branch && then.branch !== current.branch) notes.push(`written on ${then.branch}; now on ${current.branch}`);
    // Same commit and still uncommitted changes here is the same working tree as far as git can tell.
    if (then.dirty && (moved || !current.dirty)) notes.push("written with uncommitted changes that are not in this tree, so results observed then may not hold here");
    if (workspaceRoot) {
      const missing: string[] = [], changed: string[] = [];
      for (const file of then.untracked) {
        const now = hashFile(path.join(workspaceRoot, file.path));
        if (now === null) missing.push(file.path);
        else if (file.sha256 && now !== file.sha256) changed.push(file.path);
      }
      const list = (files: string[]): string => files.slice(0, 5).join(", ") + (files.length > 5 ? ` and ${files.length - 5} more` : "");
      if (missing.length) notes.push(`untracked ${list(missing)} ${missing.length === 1 ? "is" : "are"} not present here`);
      if (changed.length) notes.push(`untracked ${list(changed)} changed since then`);
    }
  }
  return notes.length ? `Workspace drift (warning only; reread before relying on saved results): ${notes.join("; ")}.` : "";
};
