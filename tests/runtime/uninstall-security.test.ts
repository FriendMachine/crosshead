import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installRuntimeCore, uninstallRuntimeCore } from "../../src/runtime/local-runtime";
import { runtimeInstallMarkerFile, resolveRuntimePaths, writeJsonFile } from "../../src/runtime/runtime-persistence";
import { runOnlyBotsCtlCli } from "../../src/runtime/cli";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("safe runtime uninstall", () => {
	it("rejects unknown adapter names instead of falling through to core uninstall", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "crosshead-uninstall-unknown-adapter-"));
		dirs.push(dir);
		await installRuntimeCore({ home: dir, writeWrappers: false });

		await expect(runOnlyBotsCtlCli(["uninstall", "unknown-adapter", "--home", dir])).rejects.toThrow(
			"Unknown uninstall target: unknown-adapter"
		);
		expect(existsSync(runtimeInstallMarkerFile(resolveRuntimePaths(dir)))).toBe(true);
	});

  it("refuses to recursively delete an arbitrary unmarked directory", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crosshead-uninstall-arbitrary-"));
    dirs.push(dir);
    const important = path.join(dir, "important.txt");
    writeFileSync(important, "keep me");
    await expect(uninstallRuntimeCore(dir)).rejects.toThrow("installation marker is missing");
    expect(readFileSync(important, "utf8")).toBe("keep me");
  });

  it("removes only a marked install whose canonical path matches", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crosshead-uninstall-install-"));
    dirs.push(dir);
    await installRuntimeCore({ home: dir, writeWrappers: false });
    expect(existsSync(runtimeInstallMarkerFile(resolveRuntimePaths(dir)))).toBe(true);
    await uninstallRuntimeCore(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("rejects a copied or altered installation marker", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crosshead-uninstall-tampered-"));
    dirs.push(dir);
    await installRuntimeCore({ home: dir, writeWrappers: false });
    const marker = runtimeInstallMarkerFile(resolveRuntimePaths(dir));
    const parsed = JSON.parse(readFileSync(marker, "utf8"));
    writeFileSync(marker, JSON.stringify({ ...parsed, canonicalHome: "/tmp/different-install" }));
    await expect(uninstallRuntimeCore(dir)).rejects.toThrow("installation marker is missing");
    expect(existsSync(dir)).toBe(true);
  });

  it("refuses to signal a live PID from unverifiable legacy daemon state", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "crosshead-uninstall-live-pid-"));
    dirs.push(dir);
    await installRuntimeCore({ home: dir, writeWrappers: false });
    const paths = resolveRuntimePaths(dir);
    writeJsonFile(path.join(paths.state, "daemon.json"), {
      status: "running",
      port: 65535,
      controlToken: "untrusted-stale-state",
      pid: process.pid,
      organizationalWorkerConfigPath: null,
      startedAt: new Date().toISOString(),
      lastHeartbeat: null,
      lastError: null,
    });

    await expect(uninstallRuntimeCore(dir)).rejects.toThrow("legacy daemon ownership");
    expect(existsSync(dir)).toBe(true);
  });
});
