import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OnlyBotsLocalRuntimeDaemon, adoptUnpackedRuntimeRelease, inspectInstalledRuntimeRelease, installRuntimeCore } from "../../src/runtime/local-runtime";
import { ONLYBOTS_RUNTIME_CORE_VERSION, loadAdapterRecord, resolveRuntimePaths, upsertRuntimeAdapterRecord } from "../../src/runtime/runtime-persistence";

const repo = path.resolve(__dirname, "../..");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const runtimeHome = (): string => {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "xhd-adopt-"))); dirs.push(root);
	return path.join(root, "runtime");
};
/** What the install script leaves behind: a verified release under lib/runtime. */
const unpack = (home: string, releaseId: string): { cli: string; daemon: string } => {
	const root = path.join(home, "lib", "runtime", releaseId);
	mkdirSync(root, { recursive: true });
	symlinkSync(path.join(repo, "dist"), path.join(root, "dist"));
	return { cli: path.join(root, "dist/runtime/cli.js"), daemon: path.join(root, "dist/runtime/daemon.js") };
};

describe("install script over an existing installation", () => {
	it("makes the unpacked release the installed one", async () => {
		const home = runtimeHome();
		const previous = unpack(home, "0.0.1-aaaaaaaaaaaa");
		await installRuntimeCore({ home, cliScriptPath: previous.cli, daemonScriptPath: previous.daemon });
		const next = unpack(home, "0.0.2-bbbbbbbbbbbb");

		const result = await adoptUnpackedRuntimeRelease(home, "0.0.2-bbbbbbbbbbbb", { restart: false });

		const paths = resolveRuntimePaths(home);
		expect(result).toMatchObject({ previousReleaseId: "0.0.1-aaaaaaaaaaaa", releaseId: "0.0.2-bbbbbbbbbbbb", daemonRestarted: false });
		expect(inspectInstalledRuntimeRelease(paths)).toEqual({ releaseId: "0.0.2-bbbbbbbbbbbb", cliScriptPath: next.cli, daemonScriptPath: next.daemon });
		for (const [name, script] of [["crosshead", next.cli], ["onlybotsctl", next.cli], ["crossheadd", next.daemon]] as const) {
			const wrapper = readFileSync(path.join(paths.bin, name), "utf8");
			expect(wrapper).toContain(script);
			expect(wrapper).toContain(`CROSSHEAD_HOME='${home}'`);
		}
	});

	it("refuses a release that is not unpacked under the runtime home", async () => {
		const home = runtimeHome();
		const previous = unpack(home, "0.0.1-aaaaaaaaaaaa");
		await installRuntimeCore({ home, cliScriptPath: previous.cli, daemonScriptPath: previous.daemon });

		await expect(adoptUnpackedRuntimeRelease(home, "0.0.2-bbbbbbbbbbbb")).rejects.toThrow("is not unpacked");
		await expect(adoptUnpackedRuntimeRelease(home, "../0.0.1-aaaaaaaaaaaa")).rejects.toThrow("Invalid runtime release ID");
		expect(inspectInstalledRuntimeRelease(resolveRuntimePaths(home)).releaseId).toBe("0.0.1-aaaaaaaaaaaa");
	});
});

describe("adapter attach", () => {
	const installed = (home: string, hostHome: string) => upsertRuntimeAdapterRecord(home, {
		name: "claude-code", version: ONLYBOTS_RUNTIME_CORE_VERSION, runtimeVersion: ONLYBOTS_RUNTIME_CORE_VERSION, status: "installed",
		profileName: "default", hostHome, managedFiles: [path.join(hostHome, "settings.json"), path.join(home, "bin", "claude")],
		lastError: null, installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
	});
	const attach = (home: string, hostHome: string) => new OnlyBotsLocalRuntimeDaemon(home).attachAdapter({
		adapterName: "claude-code", adapterVersion: ONLYBOTS_RUNTIME_CORE_VERSION, runtimeVersion: ONLYBOTS_RUNTIME_CORE_VERSION,
		profileName: "default", hostHome, managedFiles: [path.join(home, "bin", "claude")],
	});

	it("keeps the managed files recorded at install, which doctor compares with the install snapshot", async () => {
		const home = runtimeHome();
		await installRuntimeCore({ home, writeWrappers: false });
		const record = installed(home, "/host/claude");

		const response = await attach(home, "/host/claude");

		expect(response.adapter.status).toBe("attached");
		expect(loadAdapterRecord(resolveRuntimePaths(home), "claude-code")!.managedFiles).toEqual(record.managedFiles);
	});

	it("takes the session's files when the host home differs from the installed one", async () => {
		const home = runtimeHome();
		await installRuntimeCore({ home, writeWrappers: false });
		installed(home, "/host/claude");

		await attach(home, "/other/claude");

		expect(loadAdapterRecord(resolveRuntimePaths(home), "claude-code")!.managedFiles).toEqual([path.join(home, "bin", "claude")]);
	});
});
