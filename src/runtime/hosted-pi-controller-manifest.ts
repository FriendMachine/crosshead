import type { OperatorWorkspaceManifest } from "./operator-policy";
import { readFileSync, statSync } from "node:fs";

export const HOSTED_PI_CONTROLLER_ADAPTER = "hosted-pi-controller";
export const HOSTED_PI_CONTROLLER_MANIFEST = "hosted-pi-controller-metadata-v1";

export type HostedControllerProcess = { pid: number; startedAtTicks: string; bootId: string };

/** Linux process start ticks distinguish a live controller from a recycled PID.
 * No command line or environment (which may contain credentials) is read. */
export const readHostedControllerProcess = (pid: number): HostedControllerProcess => {
	if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Hosted controller process is invalid");
	const directory = `/proc/${pid}`;
	if (typeof process.getuid === "function" && statSync(directory).uid !== process.getuid()) throw new Error("Hosted controller process is not owned");
	const stat = readFileSync(`${directory}/stat`, "utf8");
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const startedAtTicks = fields[19];
	if (!startedAtTicks || !/^[0-9]+$/.test(startedAtTicks) || ["Z", "X"].includes(fields[0]!)) throw new Error("Hosted controller process is not live");
	return { pid, startedAtTicks, bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
};

export const hostedControllerProcessIsLive = (identity: HostedControllerProcess | undefined): boolean => {
	try {
		if (!identity) return false;
		const current = readHostedControllerProcess(identity.pid);
		return current.startedAtTicks === identity.startedAtTicks && current.bootId === identity.bootId;
	}
	catch { return false; }
};

/** This host manages the existing dispatcher; the Pi session runs inside its
 * admitted sandbox. Attachment conveys no mount, model or execution authority. */
export const hostedPiControllerManifest = (home: string): OperatorWorkspaceManifest => ({
	manifestVersion: "1",
	tenantId: "local-hosted-controller",
	workspaceId: "hosted-controller:pi",
	runClass: "one_shot",
	runtimeId: HOSTED_PI_CONTROLLER_MANIFEST,
	runtimeVersion: HOSTED_PI_CONTROLLER_MANIFEST,
	workspaceRoot: home,
	readOnlyMounts: [], scratchMounts: [], stateMounts: [], ipcMounts: [],
	extraMounts: [], requestedSecretRefs: [], rawSecretEnvKeys: [],
	requestedAt: new Date().toISOString(),
});
