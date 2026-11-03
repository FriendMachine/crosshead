import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { acquireLoopbackDaemonLock } from "../../src/runtime/daemon-kernel-lock";
import { readRuntimeProcess, runtimeProcessIsLive } from "../../src/runtime/runtime-process";
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), execFileSync: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); });
describe("macOS daemon ownership", () => {
	it("excludes duplicate owners, releases on close, and isolates homes without flock", async () => {
		const home = `/private/tmp/onlybots-${randomUUID()}`;
		const first = await acquireLoopbackDaemonLock(home);
		try {
			expect(first.alive()).toBe(true);
			await expect(acquireLoopbackDaemonLock(home)).rejects.toThrow("controlled");
		} finally { await first.close(); }
		expect(first.alive()).toBe(false);
		const next = await acquireLoopbackDaemonLock(home);
		await next.close();
	});
	it("reads and compares owned macOS process witnesses without /proc", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const exec = vi.mocked(execFileSync);
		exec.mockImplementation(((file: string) => file === "/bin/ps"
			? `${process.getuid!()} S Thu Oct 22 00:00:00 2026\n`
			: "{ sec = 1792620000, usec = 123 } Wed Oct 21 19:00:00 2026\n") as never);
		const witness = readRuntimeProcess(process.pid);
		expect(runtimeProcessIsLive(witness)).toBe(true);
		expect(runtimeProcessIsLive({ ...witness, startedAtTicks: "0" })).toBe(false);
		exec.mockReturnValue(`${process.getuid!()} Z Thu Oct 22 00:00:00 2026\n`);
		expect(runtimeProcessIsLive(witness)).toBe(false);
	});
});
