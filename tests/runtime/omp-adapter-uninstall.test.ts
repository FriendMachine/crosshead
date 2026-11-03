import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installOmpProjectAdapter, uninstallOmpProjectAdapter } from "../../src/runtime/omp-adapter";
import { resolvePiAdapterPaths } from "../../src/runtime/pi-adapter";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const fixture = (): { root: string; runtimeHome: string; workspaceRoot: string; ompBinary: string } => {
	const root = mkdtempSync(path.join(os.tmpdir(), "crosshead-omp-uninstall-"));
	dirs.push(root);
	const runtimeHome = path.join(root, "runtime");
	const workspaceRoot = path.join(root, "workspace");
	const ompBinary = path.join(root, "real-omp");
	mkdirSync(workspaceRoot, { recursive: true });
	writeFileSync(ompBinary, "#!/usr/bin/env bash\nexit 0\n");
	chmodSync(ompBinary, 0o755);
	return { root, runtimeHome, workspaceRoot, ompBinary };
};

describe("OMP project adapter uninstall", () => {
	it("removes only OMP project wiring and retains the runtime and Pi adapter", async () => {
		const { runtimeHome, workspaceRoot, ompBinary } = fixture();
		const installed = await installOmpProjectAdapter({ home: runtimeHome, workspaceRoot, ompBinary });

		expect(existsSync(installed.extensionFile)).toBe(true);
		expect(existsSync(installed.launcherFile)).toBe(true);
		const result = await uninstallOmpProjectAdapter({ home: runtimeHome, workspaceRoot });

		expect(existsSync(runtimeHome)).toBe(true);
		expect(existsSync(resolvePiAdapterPaths(runtimeHome).configFile)).toBe(true);
		expect(result.piAdapterRetained).toBe(true);
		expect(existsSync(installed.extensionFile)).toBe(false);
		expect(existsSync(installed.launcherFile)).toBe(false);
		expect(existsSync(installed.configFile)).toBe(false);
		expect(existsSync(installed.envrcFile!)).toBe(false);
	});

	it("preserves unrelated workspace configuration", async () => {
		const { runtimeHome, workspaceRoot, ompBinary } = fixture();
		const configFile = path.join(workspaceRoot, ".omp", "config.yml");
		const envrcFile = path.join(workspaceRoot, ".envrc");
		mkdirSync(path.dirname(configFile), { recursive: true });
		const originalConfig = "model: test\nextensions:\n  - ./keep.js\n";
		const originalEnvrc = "export EXISTING=1\n";
		writeFileSync(configFile, originalConfig);
		writeFileSync(envrcFile, originalEnvrc);

		await installOmpProjectAdapter({ home: runtimeHome, workspaceRoot, ompBinary });
		const result = await uninstallOmpProjectAdapter({ home: runtimeHome, workspaceRoot });

		expect(readFileSync(configFile, "utf8")).toBe(originalConfig);
		expect(readFileSync(envrcFile, "utf8")).toBe(originalEnvrc);
		expect(result.updatedFiles.sort()).toEqual([configFile, envrcFile].sort());
	});

	it("fails closed before removing anything when the extension was modified", async () => {
		const { runtimeHome, workspaceRoot, ompBinary } = fixture();
		const installed = await installOmpProjectAdapter({ home: runtimeHome, workspaceRoot, ompBinary });
		writeFileSync(installed.extensionFile, "// user-modified extension\n");

		await expect(uninstallOmpProjectAdapter({ home: runtimeHome, workspaceRoot })).rejects.toThrow(
			"Refusing to remove modified OMP extension"
		);
		expect(existsSync(runtimeHome)).toBe(true);
		expect(existsSync(installed.launcherFile)).toBe(true);
		expect(readFileSync(installed.extensionFile, "utf8")).toBe("// user-modified extension\n");
	});
});
