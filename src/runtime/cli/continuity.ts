import path from "path";
import { readFileSync } from "fs";
import { OnlyBotsLocalRuntimeDaemon, formatContinuityPolicyInspection, parseArgs } from "../local-runtime";

export const continuityFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
	if (subcommand === "policy" || subcommand === "state") {
		const inspection = subcommand === "policy" ? daemon.inspectContinuityPolicy() : daemon.inspectContinuityState();
		return flags.json || flags.debug ? JSON.stringify(inspection, null, 2) : formatContinuityPolicyInspection(inspection);
	}
	if (subcommand === "patch") {
		const filePath =
			typeof flags.file === "string"
				? flags.file
				: typeof flags.patch === "string"
					? flags.patch
					: "";
		if (filePath.trim().length === 0) {
			throw new Error("continuity patch requires --file <path>");
		}
		const patchBody = JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as Record<string, unknown>;
		const result = daemon.applyContinuityGovernorPatch(patchBody);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatContinuityPolicyInspection(result.continuity);
	}
	if (subcommand === "remove") {
		const patchId =
			typeof flags["patch-id"] === "string"
				? flags["patch-id"]
				: typeof flags.patchId === "string"
					? flags.patchId
					: "";
		if (patchId.trim().length === 0) {
			throw new Error("continuity remove requires --patch-id <id>");
		}
		const result = daemon.removeContinuityGovernorPatch({
			patchId,
			removedReason:
				typeof flags.reason === "string"
					? flags.reason
					: typeof flags["removed-reason"] === "string"
						? flags["removed-reason"]
						: undefined,
		});
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatContinuityPolicyInspection(result.continuity);
	}
	throw new Error(
		subcommand === "benchmark" || subcommand === "reconcile"
			? `continuity ${subcommand} is an operator tool and is not included in the Crosshead runtime`
			: "continuity requires one of: policy, state, patch, remove"
	);
};
