import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { hardenOmpExtensionSource, installOmpProjectAdapter, uninstallOmpProjectAdapter } from "../../src/runtime/omp-adapter";
import { resolvePiAdapterPaths } from "../../src/runtime/pi-adapter";
import { OMP_EXTENSION_SOURCE } from "../../src/runtime/omp-extension-template";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

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

	it("removes the previous managed extension after a runtime upgrade", async () => {
		const { runtimeHome, workspaceRoot, ompBinary } = fixture();
		const installed = await installOmpProjectAdapter({ home: runtimeHome, workspaceRoot, ompBinary });
		writeFileSync(installed.extensionFile, hardenOmpExtensionSource(OMP_EXTENSION_SOURCE, runtimeHome, false));

		await uninstallOmpProjectAdapter({ home: runtimeHome, workspaceRoot });
		expect(existsSync(installed.extensionFile)).toBe(false);
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

it("passes only daemon-verified archive context to the installed Oh My Pi extension", async () => {
	const { runtimeHome, workspaceRoot, ompBinary } = fixture();
	const installed = await installOmpProjectAdapter({ home: runtimeHome, workspaceRoot, ompBinary, writeEnvrc: false });
	writeFileSync(path.join(runtimeHome, "state", "daemon.json"), JSON.stringify({ status: "running", port: 1234, controlToken: "fixture" }));
	const archive = "Reviewed warm and cold retry evidence.";
	const hot = "The queue stays offline.";
	let approved = false;
	const requested = vi.fn();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		expect(url.origin).toBe("http://127.0.0.1:1234");
		if (url.pathname === "/v1/memory/hot") {
			return Response.json({ scopes: [{ scope: "pi", content: JSON.stringify({ workspaceId: `repo:${workspaceRoot}`, currentGoal: hot }) }] });
		}
		if (url.pathname === "/v1/events") {
			const event = JSON.parse(String(init?.body));
			if (event.type === "turn.started") {
				requested(event.payload);
				return Response.json({ contextPack: {
					contextText: "UNVERIFIED_OMP_TEXT",
					...(approved ? { packId: "reviewed", verifiedArchiveContext: archive } : {}),
				} });
			}
		}
		return Response.json({ ok: true });
	});
	const { default: extension } = await import(/* @vite-ignore */ pathToFileURL(installed.extensionFile).href);
	type ContextHook = (event: { messages: { role: string; content: string }[] }, ctx: {
		cwd: string; ui: { notify: (message: string) => void };
	}) => Promise<{ messages: { content: string }[] } | undefined>;
	const handlers = new Map<string, ContextHook>();
	extension({ on: (event: string, handler: ContextHook) => handlers.set(event, handler), registerCommand: vi.fn() });
	const invoke = async () => {
		const result = await handlers.get("context")!(
			{ messages: [{ role: "user", content: "Resume the payment retries" }] },
			{ cwd: workspaceRoot, ui: { notify: message => { throw new Error(message); } } },
		);
		return result?.messages[0]?.content;
	};
	const baseline = await invoke();
	expect(baseline).toContain(hot);
	expect(baseline).not.toContain(archive);
	approved = true;
	const recalled = await invoke();
	expect(recalled).toContain(hot);
	expect(recalled).toContain(archive);
	expect(recalled).not.toContain("UNVERIFIED_OMP_TEXT");
	expect(requested).toHaveBeenLastCalledWith(expect.objectContaining({
		recallPolicy: "bounded", allowedScope: expect.objectContaining({ includeWarmMemory: true, includeColdMemory: true }),
	}));
});
