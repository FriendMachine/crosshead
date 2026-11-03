import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsyncHarness = vi.hoisted(() => ({
  failNextFileSync: false,
  targetPath: null as string | null,
  observations: [] as Array<{
    kind: "file" | "directory" | "other";
    targetExists: boolean;
    targetMode: number | null;
  }>,
  syncedDirectories: [] as string[],
  descriptorPaths: new Map<number, string>(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    openSync: vi.fn(((file, flags, mode) => {
      const descriptor = mode === undefined
	? actual.openSync(file, flags)
	: actual.openSync(file, flags, mode);
      fsyncHarness.descriptorPaths.set(descriptor, String(file));
      return descriptor;
    }) as typeof actual.openSync),
    closeSync: vi.fn((descriptor: number) => {
      try {
	actual.closeSync(descriptor);
      } finally {
	fsyncHarness.descriptorPaths.delete(descriptor);
      }
    }),
    fsyncSync: vi.fn((descriptor: number) => {
      const descriptorStat = actual.fstatSync(descriptor);
      let kind: "file" | "directory" | "other" = "other";
      if (descriptorStat.isFile()) kind = "file";
      if (descriptorStat.isDirectory()) {
	kind = "directory";
	const descriptorPath = fsyncHarness.descriptorPaths.get(descriptor);
	if (descriptorPath !== undefined) fsyncHarness.syncedDirectories.push(descriptorPath);
      }
      const targetPath = fsyncHarness.targetPath;
      const targetExists = targetPath !== null && actual.existsSync(targetPath);
      const targetMode = targetExists ? actual.statSync(targetPath).mode & 0o777 : null;
      fsyncHarness.observations.push({ kind, targetExists, targetMode });
      if (kind === "file" && fsyncHarness.failNextFileSync) {
	fsyncHarness.failNextFileSync = false;
	throw new Error("injected temporary file fsync failure");
      }
      actual.fsyncSync(descriptor);
    }),
  };
});

import {
  adapterFile,
  adapterSnapshotFile,
  coreSnapshotFile,
  ensureRuntimeHomeLayout,
  isSessionWriteStale,
  logFile,
  loadDaemonState,
  loadProfile,
  loadSecret,
  persistentAgentBoundaryFile,
  persistentAgentEntityFile,
  persistentAgentLineageFile,
  persistentAgentPassportFile,
  profileFile,
  sanitizeLogValue,
  saveDaemonState,
  saveProfile,
  saveSecret,
  secretFile,
  writeJsonFile,
  writeRuntimeLog,
  type RuntimePaths,
} from "../../src/runtime/runtime-persistence";
import type { RuntimeProfile } from "../../src/runtime/local-runtime";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  fsyncHarness.failNextFileSync = false;
  fsyncHarness.targetPath = null;
  fsyncHarness.observations.length = 0;
  fsyncHarness.syncedDirectories.length = 0;
  fsyncHarness.descriptorPaths.clear();
});

const buildPaths = (): RuntimePaths => {
  const home = mkdtempSync(path.join(os.tmpdir(), "onlybots-runtime-persistence-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return ensureRuntimeHomeLayout(home);
};

const buildProfile = (name: string): RuntimeProfile => ({
  name,
  apiBase: "http://127.0.0.1:9",
  npub: "npub1persistence",
  memoryMode: "off",
  features: { coldSync: false, autoWarmPromotion: false },
} as unknown as RuntimeProfile);

describe("runtime persistence", () => {
  it("durably establishes every newly created runtime directory entry", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "onlybots-runtime-layout-"));
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const intermediate = path.join(parent, "nested");
    const home = path.join(intermediate, "runtime-home");
    fsyncHarness.syncedDirectories.length = 0;

    const paths = ensureRuntimeHomeLayout(home);

    expect(fsyncHarness.syncedDirectories).toContain(parent);
    expect(fsyncHarness.syncedDirectories).toContain(intermediate);
    expect(fsyncHarness.syncedDirectories).toContain(home);
    expect(fsyncHarness.syncedDirectories).toContain(paths.state);
    expect(statSync(intermediate).mode & 0o777).toBe(0o700);
    expect(statSync(paths.state).mode & 0o777).toBe(0o700);
  });

  it("rejects symlinked directories inside the runtime home", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "onlybots-runtime-symlink-"));
    cleanups.push(() => rmSync(fixture, { recursive: true, force: true }));
    const home = path.join(fixture, "home");
    const outside = path.join(fixture, "outside");
    mkdirSync(home);
    mkdirSync(outside);
    symlinkSync(outside, path.join(home, "state"), "dir");

    expect(() => ensureRuntimeHomeLayout(home)).toThrow("must not be a symlink");
  });

  it("fsyncs JSON content before rename and the parent directory after owner-only replacement", () => {
    const paths = buildPaths();
    const targetPath = path.join(paths.state, "durable.json");
    fsyncHarness.targetPath = targetPath;
    fsyncHarness.observations.length = 0;

    writeJsonFile(targetPath, { durable: true });

    expect(JSON.parse(readFileSync(targetPath, "utf8"))).toEqual({ durable: true });
    expect(fsyncHarness.observations).toEqual([
      { kind: "file", targetExists: false, targetMode: null },
      { kind: "directory", targetExists: true, targetMode: 0o600 },
    ]);
    expect(readdirSync(paths.state).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves the prior JSON and cleans up the temp file when its fsync fails", () => {
    const paths = buildPaths();
    const targetPath = path.join(paths.state, "durable.json");
    writeFileSync(targetPath, JSON.stringify({ durable: "previous" }), { mode: 0o600 });
    fsyncHarness.targetPath = targetPath;
    fsyncHarness.observations.length = 0;
    fsyncHarness.failNextFileSync = true;

    expect(() => writeJsonFile(targetPath, { durable: "replacement" })).toThrow(
      "injected temporary file fsync failure"
    );

    expect(JSON.parse(readFileSync(targetPath, "utf8"))).toEqual({ durable: "previous" });
    expect(fsyncHarness.observations).toEqual([
      { kind: "file", targetExists: true, targetMode: 0o600 },
    ]);
    expect(readdirSync(paths.state).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(targetPath)).toBe(true);
    expect(statSync(targetPath).isFile()).toBe(true);
  });

  it("refuses to replace a symlink presented as a JSON state file", () => {
    const paths = buildPaths();
    const outside = path.join(path.dirname(paths.home), `${path.basename(paths.home)}-outside.json`);
    cleanups.push(() => rmSync(outside, { force: true }));
    writeFileSync(outside, "unchanged");
    const targetPath = path.join(paths.state, "linked.json");
    symlinkSync(outside, targetPath);

    expect(() => writeJsonFile(targetPath, { replaced: true })).toThrow("non-regular JSON file");
    expect(readFileSync(outside, "utf8")).toBe("unchanged");
  });

  it("redacts common credential forms before they enter logs or durable failures", () => {
    const observerToken = randomBytes(32).toString("base64url");
    const secrets = [
      "adapter-transport-secret",
      "dummy-secret",
      "dummy-api-key",
      "dummy-cookie",
      "query-secret",
      "json-secret",
      observerToken,
    ];
    const sanitized = sanitizeLogValue([
      "Authorization: Bearer adapter-transport-secret",
      "https://apiuser:dummy-secret@example.test/v1",
      "X-API-Key: dummy-api-key",
      "Cookie: session=dummy-cookie",
      "https://example.test/callback?access_token=query-secret",
      '{"client_secret":"json-secret"}',
      `Authorization: Bearer ${observerToken}`,
      `{"bearerToken":"${observerToken}"}`,
    ].join("\n"));

    for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("[redacted-credential]");
    expect(sanitized).toContain("https://example.test/callback");
  });

  it("round-trips profiles and secrets and leaves no temp files behind", () => {
    const paths = buildPaths();
    saveProfile(paths, buildProfile("default"));
    saveSecret(paths, "default", { nsec: "nsec1secret", session: null });

    expect(loadProfile(paths, "default")?.npub).toBe("npub1persistence");
    expect(loadSecret(paths, "default")?.nsec).toBe("nsec1secret");
    expect(loadProfile(paths, "missing")).toBeNull();

    const leftovers = [...readdirSync(paths.profiles), ...readdirSync(paths.secrets)].filter((f) =>
      f.endsWith(".tmp")
    );
    expect(leftovers).toEqual([]);
  });

  it("rejects traversal and separator characters in persistence filenames", () => {
    const paths = buildPaths();
    const pathBuilders: Array<(value: string) => string> = [
      (value) => profileFile(paths, value),
      (value) => secretFile(paths, value),
      (value) => adapterFile(paths, value),
      (value) => persistentAgentEntityFile(paths, value),
      (value) => persistentAgentPassportFile(paths, value),
      (value) => persistentAgentLineageFile(paths, value),
      (value) => persistentAgentBoundaryFile(paths, value),
      (value) => coreSnapshotFile(paths, value),
      (value) => adapterSnapshotFile(paths, "codex", value),
    ];

    for (const buildPath of pathBuilders) {
      expect(() => buildPath("../escaped")).toThrow("portable path token");
      expect(() => buildPath("..\\escaped")).toThrow("portable path token");
      expect(() => buildPath("nested/escaped")).toThrow("portable path token");
    }

    expect(profileFile(paths, "release+canary.1")).toBe(path.join(paths.profiles, "release+canary.1.json"));
  });

  it("falls back cleanly when a state file is corrupt instead of throwing", () => {
    const paths = buildPaths();
    writeFileSync(path.join(paths.state, "daemon.json"), "{not json");
    const state = loadDaemonState(paths);
    expect(state.status).toBeDefined();
    expect(state.organizationalWorkerConfigPath).toBeNull();

    saveDaemonState(paths, { ...state, status: "running" });
    expect(loadDaemonState(paths).status).toBe("running");
  });

  it("survives many interleaved writers without producing torn JSON", async () => {
    const paths = buildPaths();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => async () => {
        saveProfile(paths, { ...buildProfile("default"), npub: `npub1writer${i}` } as RuntimeProfile);
      }).map((fn) => fn())
    );
    const profile = loadProfile(paths, "default");
    expect(profile?.npub).toMatch(/^npub1writer\d+$/);
  });

  it("tightens runtime directories and authority-bearing files to owner-only modes", () => {
    const paths = buildPaths();
    const daemonState = loadDaemonState(paths);
    for (const directory of Object.values(paths)) {
      chmodSync(directory, 0o775);
    }
    const daemonPath = path.join(paths.state, "daemon.json");
    writeFileSync(daemonPath, JSON.stringify(daemonState), { mode: 0o664 });
    chmodSync(daemonPath, 0o664);

    const tightened = ensureRuntimeHomeLayout(paths.home);
    for (const directory of Object.values(tightened)) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }

    saveDaemonState(tightened, daemonState);
    saveProfile(tightened, buildProfile("default"));
    saveSecret(tightened, "default", { nsec: "nsec1secret", session: null });
    writeJsonFile(path.join(tightened.state, "organizational-worker-ledger-v2.json"), {
      attempts: {},
    });
    writeRuntimeLog(tightened, "security.mode_test", { controlToken: "not-logged" });

    const sensitiveFiles = [
      daemonPath,
      path.join(tightened.profiles, "default.json"),
      path.join(tightened.secrets, "default.json"),
      path.join(tightened.state, "organizational-worker-ledger-v2.json"),
      logFile(tightened),
    ];
    for (const filePath of sensitiveFiles) {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });
});

describe("isSessionWriteStale", () => {
  const session = (token: string, expiresAt: string) => ({ sessionToken: token, expiresAt, scopes: [] });

  it("treats identical tokens and missing existing sessions as safe to write", () => {
    expect(isSessionWriteStale(null, session("a", "2026-06-10T01:00:00Z"))).toBe(false);
    expect(
      isSessionWriteStale(session("a", "2026-06-10T01:00:00Z"), session("a", "2026-06-10T01:00:00Z"))
    ).toBe(false);
  });

  it("rejects writing an older token over a fresher one", () => {
    expect(
      isSessionWriteStale(session("fresh", "2026-06-10T02:00:00Z"), session("stale", "2026-06-10T01:00:00Z"))
    ).toBe(true);
    expect(
      isSessionWriteStale(session("old", "2026-06-10T01:00:00Z"), session("new", "2026-06-10T02:00:00Z"))
    ).toBe(false);
  });

  it("rejects clearing a session that exists on disk", () => {
    expect(isSessionWriteStale(session("a", "2026-06-10T01:00:00Z"), null)).toBe(true);
    expect(isSessionWriteStale(null, null)).toBe(false);
  });
});
