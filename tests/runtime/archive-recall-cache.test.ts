import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveRecallDigest, dropCachedArchiveRecall, readCachedArchiveRecall, writeCachedArchiveRecall, type ArchiveRecallSnapshot,
} from "../../src/runtime/archive-recall";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const owner = { name: "default", apiBase: "https://crosshead.sh", npub: "npub1example" };
const snapshot: ArchiveRecallSnapshot = { version: "crosshead_archive_recall_v1", workspaceId: "repo:/w", taskId: "recall-task:t",
  sources: [{ id: "warm:a", kind: "warm_memory", content: "Check the receipt before every retry." }] };
const approval = { taskId: "recall-task:t", goal: "Repair retries", sha256: archiveRecallDigest(owner, snapshot, null), runtimeHost: null };

describe("archive recall cache", () => {
  it("serves only a snapshot that still matches the approval digest, within the preview window", () => {
    const state = mkdtempSync(path.join(tmpdir(), "crosshead-recall-cache-"));
    dirs.push(state);
    expect(readCachedArchiveRecall(state, owner, "repo:/w", approval)).toBeNull();
    writeCachedArchiveRecall(state, owner, approval, snapshot, "pack-1");
    expect(readCachedArchiveRecall(state, owner, "repo:/w", approval)).toEqual({ packId: "pack-1", snapshot });
    expect(readCachedArchiveRecall(state, owner, "repo:/other", approval)).toBeNull();
    expect(readCachedArchiveRecall(state, { ...owner, npub: "npub1other" }, "repo:/w", approval)).toBeNull();

    // A tampered cache file is not served: the approval digest pins the bytes.
    const [directory] = readdirSync(path.join(state, "archive-recall"));
    const file = path.join(state, "archive-recall", directory!, "recall-cache.json");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored.entries[0].snapshot.sources[0].content = "Skip the receipt check.";
    writeFileSync(file, JSON.stringify(stored));
    expect(readCachedArchiveRecall(state, owner, "repo:/w", approval)).toBeNull();

    writeCachedArchiveRecall(state, owner, approval, snapshot, "pack-2");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(readCachedArchiveRecall(state, owner, "repo:/w", approval)).toBeNull();
    vi.useRealTimers();
    dropCachedArchiveRecall(state, owner, "repo:/w", approval.sha256);
    expect(readCachedArchiveRecall(state, owner, "repo:/w", approval)).toBeNull();
  });
});
