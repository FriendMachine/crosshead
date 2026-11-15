import path from "path";
import { OnlyBotsLocalRuntimeDaemon, formatHandoffExportResult, formatHandoffImportResult, formatHandoffInspection, formatHandoffOutcomeResult, formatHandoffVerification, parseArgs, parseJsonFlag } from "../local-runtime";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { parseAllowedSigners } from "../handoff-import";
import { workspaceProjectRoot } from "../workspace-identity";

export const handoffFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];
	const profileName = typeof flags.profile === "string" ? flags.profile : undefined;
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);

	if (subcommand === "export") {
		const sourceRuntime = typeof flags.source === "string" ? flags.source : "codex";
		// Without --target the capsule goes to the other host; name the same host to move work to another machine.
		const targetRuntime = typeof flags.target === "string" ? flags.target : sourceRuntime === "codex" ? "claude-code" : "codex";
		if (targetRuntime !== "codex" && targetRuntime !== "claude-code") {
			throw new Error("handoff export requires --target codex or --target claude-code");
		}
		// Check before exporting: the capsule holds transcript text, so an existing file is not replaced silently.
		const outputFile = typeof flags.output === "string" && flags.output.trim().length > 0 ? path.resolve(flags.output) : null;
		if (outputFile && existsSync(outputFile) && flags.force !== true) {
			throw new Error(`${outputFile} already exists; choose another --output path or pass --force to replace it`);
		}
		const workspaceRoot =
			typeof flags["workspace-root"] === "string"
				? flags["workspace-root"]
				: typeof flags.workspaceRoot === "string"
					? flags.workspaceRoot
					: process.cwd();
		const sessionId =
			typeof flags["session-id"] === "string"
				? flags["session-id"]
				: typeof flags.sessionId === "string"
					? flags.sessionId
					: "";
		const prompt = typeof flags.prompt === "string" ? flags.prompt : positionals.slice(1).join(" ").trim();
		if (sessionId.trim().length === 0) {
			throw new Error("handoff export requires --session-id <id>");
		}
		if (prompt.length === 0) {
			throw new Error("handoff export requires --prompt <text> or a positional prompt");
		}
		const sharedRequest = {
			profileName,
			workspaceRoot,
			workspaceId:
				typeof flags["workspace-id"] === "string"
					? flags["workspace-id"]
					: typeof flags.workspaceId === "string"
						? flags.workspaceId
						: undefined,
			hostVersion:
				typeof flags["host-version"] === "string"
					? flags["host-version"]
					: typeof flags.hostVersion === "string"
						? flags.hostVersion
						: undefined,
			sessionId,
			targetRuntime: targetRuntime as "codex" | "claude-code",
			turnId:
				typeof flags["turn-id"] === "string"
					? flags["turn-id"]
					: typeof flags.turnId === "string"
						? flags.turnId
						: undefined,
			prompt,
			transcript: parseJsonFlag(flags["transcript-json"]) as Array<{
				role: "user" | "assistant" | "system" | "tool";
				content: string;
				timestamp?: string;
			}> | undefined,
			task: {
				objective:
					typeof flags["task-objective"] === "string"
						? flags["task-objective"]
						: typeof flags.taskObjective === "string"
							? flags.taskObjective
							: undefined,
				status:
					typeof flags["task-status"] === "string"
						? (flags["task-status"] as "pending" | "in_progress" | "blocked" | "completed")
						: undefined,
				openLoops: parseJsonFlag(flags["open-loops-json"]) as string[] | undefined,
			},
			reasoning: {
				currentTheory:
					typeof flags["current-theory"] === "string"
						? flags["current-theory"]
						: typeof flags.currentTheory === "string"
							? flags.currentTheory
							: undefined,
				openQuestions: parseJsonFlag(flags["open-questions-json"]) as string[] | undefined,
				rejectedPaths: parseJsonFlag(flags["rejected-paths-json"]) as string[] | undefined,
				unresolvedRisks: parseJsonFlag(flags["unresolved-risks-json"]) as string[] | undefined,
				portabilityNotes: parseJsonFlag(flags["portability-notes-json"]) as string[] | undefined,
				nextAction:
					typeof flags["next-action"] === "string"
						? flags["next-action"]
						: typeof flags.nextAction === "string"
							? flags.nextAction
							: undefined,
			},
			delegation: {
				whyTransfer:
					typeof flags["why-transfer"] === "string"
						? flags["why-transfer"]
						: typeof flags.whyTransfer === "string"
							? flags.whyTransfer
							: undefined,
				requestedCapabilities: parseJsonFlag(flags["requested-capabilities-json"]) as string[] | undefined,
			},
			maxBytes: typeof flags["max-bytes"] === "string" ? Number(flags["max-bytes"]) : undefined,
		};
		let result: Record<string, unknown>;
		if (sourceRuntime === "codex") {
			const { CodexRuntimeAdapter } = await import("../codex-adapter");
			const adapter = CodexRuntimeAdapter.fromInstalled({
				home: typeof flags.home === "string" ? flags.home : undefined,
				hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
			});
			result = (await adapter.createHandoff({
				...sharedRequest,
				hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
			})) as unknown as Record<string, unknown>;
		} else if (sourceRuntime === "claude-code") {
			const { ClaudeCodeRuntimeAdapter } = await import("../claude-code-adapter");
			const adapter = ClaudeCodeRuntimeAdapter.fromInstalled({
				home: typeof flags.home === "string" ? flags.home : undefined,
				hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
			});
			result = (await adapter.createHandoff({
				...sharedRequest,
				hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
			})) as unknown as Record<string, unknown>;
		} else {
			throw new Error("handoff export requires --source codex or --source claude-code");
		}
		// The capsule file is what travels to another machine for `handoff import --file`.
		if (outputFile) {
			const record = result.record as { capsule?: unknown } | undefined;
			if (!record?.capsule) throw new Error("handoff export produced no capsule to write");
			// mode applies only when the file is created, so a replaced file is narrowed explicitly too.
			writeFileSync(outputFile, `${JSON.stringify(record.capsule, null, 2)}\n`, { mode: 0o600, flag: flags.force === true ? "w" : "wx" });
			chmodSync(outputFile, 0o600);
			result = { ...result, capsuleFile: outputFile };
		}
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatHandoffExportResult(result as unknown as Record<string, unknown>);
	}

	if (subcommand === "import") {
		const targetRuntime = typeof flags.target === "string" ? flags.target : "claude-code";
		const filePath = typeof flags.file === "string" ? flags.file : "";
		const handoffId =
			typeof flags.id === "string"
				? flags.id
				: typeof flags["handoff-id"] === "string"
					? flags["handoff-id"]
					: "";
		const capsule =
			filePath.trim().length > 0
				? (JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as Record<string, unknown>)
				: undefined;
		if (!capsule && handoffId.trim().length === 0) {
			throw new Error("handoff import requires --file <capsule.json> or --id <handoff_id>");
		}
		const sharedRequest = {
			profileName,
			handoffId: handoffId.trim().length > 0 ? handoffId : undefined,
			capsule: capsule as never,
			// Hooks key memory by the project root, so run from a subdirectory the import still lands there.
			workspaceRoot:
				typeof flags["workspace-root"] === "string"
					? path.resolve(flags["workspace-root"])
					: typeof flags.workspaceRoot === "string"
						? path.resolve(flags.workspaceRoot)
						: importWorkspaceRoot(process.cwd()),
			workspaceId:
				typeof flags["workspace-id"] === "string"
					? flags["workspace-id"]
					: typeof flags.workspaceId === "string"
						? flags.workspaceId
						: undefined,
			hostVersion:
				typeof flags["host-version"] === "string"
					? flags["host-version"]
					: typeof flags.hostVersion === "string"
						? flags.hostVersion
						: undefined,
			sessionId:
				typeof flags["session-id"] === "string"
					? flags["session-id"]
					: typeof flags.sessionId === "string"
						? flags.sessionId
						// An import often happens before any session exists on the receiving machine.
						: "handoff-import",
			allowedSigners: parseAllowedSigners(flags["allow-signer"] ?? flags.allowSigner),
			allowStale: flags["allow-stale"] === true || flags.allowStale === true,
			accepted: flags.reject ? false : true,
			note:
				typeof flags.note === "string"
					? flags.note
					: typeof flags.reason === "string"
						? flags.reason
						: undefined,
		};
		let result: Record<string, unknown>;
		if (targetRuntime === "claude-code") {
			const { ClaudeCodeRuntimeAdapter } = await import("../claude-code-adapter");
			const adapter = ClaudeCodeRuntimeAdapter.fromInstalled({
				home: typeof flags.home === "string" ? flags.home : undefined,
				hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
			});
			result = (await adapter.importHandoff({
				...sharedRequest,
				hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
			})) as unknown as Record<string, unknown>;
		} else if (targetRuntime === "codex") {
			const { CodexRuntimeAdapter } = await import("../codex-adapter");
			const adapter = CodexRuntimeAdapter.fromInstalled({
				home: typeof flags.home === "string" ? flags.home : undefined,
				hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
			});
			result = (await adapter.importHandoff({
				...sharedRequest,
				hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
			})) as unknown as Record<string, unknown>;
		} else {
			throw new Error("handoff import currently supports only --target claude-code or --target codex");
		}
		// A refused capsule is a failure for whoever scripted the import; --reject is the operator's own choice.
		if (result.accepted !== true && !flags.reject) process.exitCode = 1;
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatHandoffImportResult(result as unknown as Record<string, unknown>);
	}

	if (subcommand === "outcome") {
		const handoffId =
			typeof flags.id === "string"
				? flags.id
				: typeof flags["handoff-id"] === "string"
					? flags["handoff-id"]
					: "";
		if (handoffId.trim().length === 0) {
			throw new Error("handoff outcome requires --id <handoff_id>");
		}
		const kind =
			typeof flags.kind === "string"
				? flags.kind
				: typeof flags.outcome === "string"
					? flags.outcome
					: typeof flags.status === "string"
						? flags.status
						: "";
		if (kind.trim().length === 0) {
			throw new Error("handoff outcome requires --kind <accepted|rejected|completed|failed|corrected>");
		}
		const runtime =
			typeof flags.runtime === "string"
				? flags.runtime
				: typeof flags["reported-by"] === "string"
					? flags["reported-by"]
					: typeof flags.reporterRuntime === "string"
						? flags.reporterRuntime
						: "";
		if (runtime.trim().length === 0) {
			throw new Error("handoff outcome requires --runtime <codex|claude-code>");
		}
		const workspaceRoot =
			typeof flags["workspace-root"] === "string"
				? flags["workspace-root"]
				: typeof flags.workspaceRoot === "string"
					? flags.workspaceRoot
					: "";
		const result = await daemon.recordHandoffOutcome(
			{
				handoffId,
				kind,
				reporterRuntime: runtime,
				reporterSessionId:
					typeof flags["session-id"] === "string"
						? flags["session-id"]
						: typeof flags.sessionId === "string"
							? flags.sessionId
							: undefined,
				reporterWorkspaceId:
					typeof flags["workspace-id"] === "string"
						? flags["workspace-id"]
						: typeof flags.workspaceId === "string"
							? flags.workspaceId
							: workspaceRoot.trim().length > 0
								? `repo:${workspaceRoot}`
								: undefined,
				summary:
					typeof flags.summary === "string"
						? flags.summary
						: typeof flags.note === "string"
							? flags.note
							: typeof flags.reason === "string"
								? flags.reason
								: undefined,
				details:
					typeof flags.details === "string"
						? flags.details
						: typeof flags.description === "string"
							? flags.description
							: undefined,
				taskSucceeded:
					flags["task-succeeded"] === true
						? true
						: flags["task-failed"] === true
							? false
							: undefined,
				changedDirection: flags["changed-direction"] === true ? true : undefined,
				nextAction:
					typeof flags["next-action"] === "string"
						? flags["next-action"]
						: typeof flags.nextAction === "string"
							? flags.nextAction
							: undefined,
				resultingHandoffId:
					typeof flags["resulting-handoff-id"] === "string"
						? flags["resulting-handoff-id"]
						: typeof flags.resultingHandoffId === "string"
							? flags.resultingHandoffId
							: undefined,
				signals: {
					projectDirection: parseJsonFlag(flags["project-direction-json"]) as string[] | undefined,
					openQuestions: parseJsonFlag(flags["open-questions-json"]) as string[] | undefined,
					rejectedAlternatives: parseJsonFlag(flags["rejected-alternatives-json"]) as string[] | undefined,
					unresolvedRisks: parseJsonFlag(flags["unresolved-risks-json"]) as string[] | undefined,
					demonstratedKnowledge: parseJsonFlag(flags["demonstrated-knowledge-json"]) as string[] | undefined,
					recentCorrections: parseJsonFlag(flags["recent-corrections-json"]) as string[] | undefined,
					orientation: parseJsonFlag(flags["orientation-json"]) as string[] | undefined,
					redundancyMarkers: parseJsonFlag(flags["redundancy-markers-json"]) as string[] | undefined,
				},
			},
			profileName
		);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatHandoffOutcomeResult(result);
	}

	if (subcommand === "create") {
		const inputPath =
			typeof flags.input === "string"
				? flags.input
				: typeof flags.file === "string"
					? flags.file
					: "";
		if (inputPath.trim().length === 0) {
			throw new Error("handoff create requires --input <translation.json>");
		}
		const payload = JSON.parse(readFileSync(path.resolve(inputPath), "utf8")) as Record<string, unknown>;
		const result = await daemon.createHandoff(
			{
				...payload,
				maxBytes: typeof flags["max-bytes"] === "string" ? Number(flags["max-bytes"]) : undefined,
			},
			profileName
		);
		if (flags.json || flags.debug) {
			return JSON.stringify(result, null, 2);
		}
		const inspection =
			result.inspection && typeof result.inspection === "object" && !Array.isArray(result.inspection)
				? (result.inspection as Record<string, unknown>)
				: null;
		return inspection ? formatHandoffInspection(inspection) : JSON.stringify(result, null, 2);
	}

	if (subcommand === "verify") {
		const filePath =
			typeof flags.file === "string"
				? flags.file
				: typeof flags.input === "string"
					? flags.input
					: "";
		if (filePath.trim().length === 0) {
			throw new Error("handoff verify requires --file <capsule.json>");
		}
		const capsule = JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as Record<string, unknown>;
		const result = await daemon.verifyHandoff({ capsule }, profileName);
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatHandoffVerification(result);
	}

	if (subcommand === "explain") {
		const filePath = typeof flags.file === "string" ? flags.file : "";
		const handoffId =
			typeof flags.id === "string"
				? flags.id
				: typeof flags["handoff-id"] === "string"
					? flags["handoff-id"]
					: "";
		if (filePath.trim().length > 0) {
			const capsule = JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as Record<string, unknown>;
			const result = await daemon.inspectHandoff({ capsule }, profileName);
			return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatHandoffInspection(result);
		}
		if (handoffId.trim().length > 0) {
			const result = await daemon.readHandoff(handoffId, profileName);
			const inspection =
				result.inspection && typeof result.inspection === "object" && !Array.isArray(result.inspection)
					? (result.inspection as Record<string, unknown>)
					: result;
			return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatHandoffInspection(inspection);
		}
		throw new Error("handoff explain requires --file <capsule.json> or --id <handoff_id>");
	}

	throw new Error("handoff requires one of: export, import, outcome, create, verify, explain");
};

const importWorkspaceRoot = (directory: string): string => {
	try {
		return workspaceProjectRoot(directory);
	} catch {
		return path.resolve(directory);
	}
};
