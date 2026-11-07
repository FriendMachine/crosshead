import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("capacity profiler acceptance", () => {
	it("fails on swallowed transport errors and retains private recovery after failed cleanup", async () => {
		const home = mkdtempSync(path.join(tmpdir(), "xhd-profile-test-"));
		const server = createServer((_request, response) => response.destroy());
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		const child = spawn(process.execPath, ["scripts/profile-hot-sync.mjs", "--base-url", `http://127.0.0.1:${port}`, "--clients", "1", "--seconds", "10", "--capture-ms", "2000"], {
			env: { PATH: process.env.PATH, TMPDIR: home, TEMP: home, TMP: home }, stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "", stderr = "";
		child.stdout!.on("data", data => stdout += data.toString());
		child.stderr!.on("data", data => stderr += data.toString());
		const ended = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
			child.once("close", (code, signal) => resolve({ code, signal }));
			child.once("error", reject);
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
		try {
			const result = await ended;
			expect(result, stderr).toEqual({ code: 2, signal: null });
			const report = JSON.parse(stdout);
			expect(report.abort).toEqual({ reason: "sync_did_not_converge" });
			expect(report.devices[0].pending).toBeGreaterThan(0);
			expect(report.cleanup.some((entry: { scopeCleared?: boolean }) => entry.scopeCleared === false)).toBe(true);
			expect(path.relative(home, report.retainedRecovery).startsWith("..")).toBe(false);
			const recovery = JSON.parse(readFileSync(report.retainedRecovery, "utf8"));
			expect(recovery.identities[0].npub).toBe(report.npubs[0]);
			expect(recovery.identities[0].nsec).toMatch(/^nsec1/);
			expect(statSync(report.retainedRecovery).mode & 0o777).toBe(0o600);
			expect(stdout).not.toContain(recovery.identities[0].nsec);
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await ended;
			await new Promise<void>(resolve => server.close(() => resolve()));
			rmSync(home, { recursive: true, force: true });
		}
	}, 55000);
});
