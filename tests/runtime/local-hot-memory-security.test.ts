import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readLocalHotMemory, writeLocalHotMemory } from "../../src/runtime/local-hot-memory";

describe("local hot-memory storage security", () => {
  it("uses collision-free bounded scope filenames and owner-only files", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "crosshead-local-hot-"));
    try {
      writeLocalHotMemory(stateDir, "colon", "body:one");
      writeLocalHotMemory(stateDir, "underscore", "body_one");

      expect(readLocalHotMemory(stateDir, "body:one").content).toBe("colon");
      expect(readLocalHotMemory(stateDir, "body_one").content).toBe("underscore");
      const directory = path.join(stateDir, "local-hot-memory");
      const files = readdirSync(directory);
      expect(files).toHaveLength(2);
      for (const file of files) expect(statSync(path.join(directory, file)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects traversal-like, oversized and read-only scopes", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "crosshead-local-hot-"));
    try {
      expect(() => writeLocalHotMemory(stateDir, "x", "../secret")).toThrow("scope is invalid");
      expect(() => writeLocalHotMemory(stateDir, "x", "x".repeat(65))).toThrow("scope is invalid");
      expect(() => writeLocalHotMemory(stateDir, "x", "all")).toThrow("read-only");
      expect(() => readLocalHotMemory(stateDir, "../secret")).toThrow("scope is invalid");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
