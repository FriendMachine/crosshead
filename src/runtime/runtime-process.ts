import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readHostedControllerProcess, type HostedControllerProcess } from "./hosted-pi-controller-manifest";

/** Process witnesses for the ordinary daemon. Linux-only hosted controllers
 * retain their existing /proc contract; the macOS daemon uses OS utilities. */
export const readRuntimeProcess = (pid: number): HostedControllerProcess => {
	if (process.platform !== "darwin") return readHostedControllerProcess(pid);
	if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Daemon process is invalid");
	const options = { encoding: "utf8" as const, timeout: 1_000, maxBuffer: 4096,
		env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", TZ: "UTC" } };
	const row = execFileSync("/bin/ps", ["-p", String(pid), "-o", "uid=,stat=,lstart="], options).trim();
	const match = /^(\d+)\s+(\S+)\s+(.+)$/.exec(row);
	if (!match || Number(match[1]) !== process.getuid?.() || /[ZX]/.test(match[2]!)) throw new Error("Daemon process is not live or owned");
	const startedAt = Date.parse(match[3]! + " UTC");
	if (!Number.isFinite(startedAt)) throw new Error("Daemon process start time is invalid");
	const boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], options).trim();
	if (!/^\{ sec = \d+, usec = \d+ \}/.test(boot)) throw new Error("Daemon boot identity is invalid");
	const hash = createHash("sha256").update(boot).digest("hex").slice(0, 32);
	return { pid, startedAtTicks: String(startedAt),
		bootId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}` };
};

export const runtimeProcessIsLive = (identity: HostedControllerProcess | undefined): boolean => {
	if (!identity) return false;
	try {
		const current = readRuntimeProcess(identity.pid);
		return current.startedAtTicks === identity.startedAtTicks && current.bootId === identity.bootId;
	} catch { return false; }
};
