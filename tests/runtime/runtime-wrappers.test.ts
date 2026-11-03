import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installRuntimeCore } from "../../src/runtime/local-runtime";

// Build before this suite: the wrapper runs a compiled CLI in a real shell.
const compiledRuntime = path.resolve("dist/runtime/local-runtime.js");

describe("runtime wrappers", () => {
	it("replaces the wrapper that is running an update without breaking its shell", async () => {
		const home = mkdtempSync(path.join(os.tmpdir(), "crosshead-wrapper-"));
		try {
			const current = path.join(home, "lib", "runtime", "1", "cli.js");
			const next = path.join(home, "lib", "runtime", "0.3.0-0123456789ab", "dist", "runtime", "cli.js");
			mkdirSync(path.dirname(current), { recursive: true });
			// Stand-in for `crosshead update`: install wrappers for a release whose
			// path has a different length, then exit normally.
			writeFileSync(
				current,
				`require(${JSON.stringify(compiledRuntime)}).installRuntimeCore(${JSON.stringify({
					home,
					writeWrappers: true,
					cliScriptPath: next,
					daemonScriptPath: next,
				})}).then(() => process.exit(0), (error) => { console.error(error); process.exit(3); });\n`
			);
			await installRuntimeCore({ home, writeWrappers: true, cliScriptPath: current, daemonScriptPath: current });

			const wrapper = path.join(home, "bin", "crosshead");
			const result = spawnSync("bash", [wrapper], { encoding: "utf8", env: { PATH: process.env.PATH } });
			expect(result.stderr).not.toMatch(/unexpected EOF|syntax error/);
			expect(result.status).toBe(0);
			expect(readFileSync(wrapper, "utf8")).toContain(next);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
