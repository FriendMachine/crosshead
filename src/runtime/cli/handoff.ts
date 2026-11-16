import path from "path";
import { OnlyBotsLocalRuntimeDaemon, formatHandoffExportResult, formatHandoffImportResult, formatHandoffInspection, formatHandoffOutcomeResult, formatHandoffVerification, parseArgs, parseJsonFlag } from "../local-runtime";
import { chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { parseAllowedSigners } from "../handoff-import";
import { HANDOFF_CAPSULE_DEFAULT_MAX_BYTES } from "../handoff-capsules";
import { workspaceProjectRoot } from "../workspace-identity";
import { resolveRuntimePaths } from "../runtime-persistence";
import { readWorkspaceHookPolicy, workspaceHookForInvocation } from "../workspace-hooks";

type HandoffHost = "codex" | "claude-code";

// Pretty-printed JSON is larger than the signed capsule's 16 KiB canonical budget.
const HANDOFF_CAPSULE_FILE_MAX_BYTES = HANDOFF_CAPSULE_DEFAULT_MAX_BYTES * 8;
const HANDOFF_CREATE_INPUT_MAX_BYTES = 1024 * 1024;

const readJsonFileBounded = (filePath: string, maxBytes: number): Record<string, unknown> => {
	const fd = openSync(path.resolve(filePath), constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Handoff file must be a regular file no larger than ${maxBytes} bytes`);
		const buffer = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, null);
			if (count === 0) break;
			length += count;
		}
		if (length > maxBytes) throw new Error(`Handoff file must be no larger than ${maxBytes} bytes`);
		return JSON.parse(buffer.toString("utf8", 0, length)) as Record<string, unknown>;
	} finally {
		closeSync(fd);
	}
};

const writeCapsuleFile = (outputFile: string, capsule: unknown, force: boolean): void => {
	const rendered = `${JSON.stringify(capsule, null, 2)}\n`;
	if (Buffer.byteLength(rendered) > HANDOFF_CAPSULE_FILE_MAX_BYTES) {
		throw new Error(`Handoff capsule file exceeds ${HANDOFF_CAPSULE_FILE_MAX_BYTES} bytes`);
	}
	const temporary = path.join(path.dirname(outputFile), `.${path.basename(outputFile)}.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, rendered, { mode: 0o600, flag: "wx" });
		chmodSync(temporary, 0o600);
		if (force) renameSync(temporary, outputFile);
		else linkSync(temporary, outputFile);
	} finally {
		try { unlinkSync(temporary); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
};

const scopedWorkspaceId = (root: string, requested: string | undefined): string => {
	const canonical = `repo:${root}`;
	if (requested !== undefined && requested !== canonical) {
		throw new Error(`This scoped workspace uses ${canonical}. Remove the workspace-id override or use the bound project.`);
	}
	return canonical;
};

const scopedHandoffBinding = (home: string | undefined, host: HandoffHost, directory: string, profileName: string | undefined, hostHome: string | undefined) => {
	const paths = resolveRuntimePaths(home);
	const policy = readWorkspaceHookPolicy(paths);
	if (!policy) return null;
	let selected: ReturnType<typeof workspaceHookForInvocation> = null;
	for (const binding of policy.bindings) {
		if (binding.host !== host) continue;
		const match = workspaceHookForInvocation(policy, host, binding.id, directory);
		if (!match) continue;
		if (selected) throw new Error(`Multiple ${host} bindings apply to this workspace. Run crosshead workspace check to repair the configuration.`);
		selected = match;
	}
	if (!selected) return null;
	if (profileName !== undefined && profileName !== selected.binding.profile) {
		throw new Error(`This workspace uses profile ${selected.binding.profile} for ${host}. Choose that profile or reconfigure the workspace.`);
	}
	if (hostHome && path.resolve(hostHome) !== selected.binding.hostHome) {
		throw new Error(`This workspace uses ${selected.binding.hostHome} as its ${host} home. Remove the host-home override or reconfigure the workspace.`);
	}
	return {
		home: paths.home,
		hostHome: selected.binding.hostHome,
		root: selected.root,
		profileName: selected.binding.profile,
		sourceExcerpts: selected.binding.sourceExcerpts,
		legacyUnscoped: selected.binding.legacyUnscoped ?? false,
		legacyBefore: selected.binding.legacyBefore,
	};
};

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
		if (flags.output === true) throw new Error("--output needs a file path");
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
			const scoped = scopedHandoffBinding(typeof flags.home === "string" ? flags.home : undefined, "codex", workspaceRoot, profileName, typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined);
			const adapter = scoped ? CodexRuntimeAdapter.forWorkspace(scoped.home, scoped.hostHome, scoped.profileName, scoped.sourceExcerpts, scoped.legacyUnscoped, scoped.legacyBefore) : CodexRuntimeAdapter.fromInstalled({
				home: typeof flags.home === "string" ? flags.home : undefined,
				hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
			});
			result = (await adapter.createHandoff({
				...sharedRequest,
				profileName: scoped?.profileName ?? sharedRequest.profileName,
				workspaceRoot: scoped?.root ?? sharedRequest.workspaceRoot,
				workspaceId: scoped ? scopedWorkspaceId(scoped.root, sharedRequest.workspaceId) : sharedRequest.workspaceId,
				hostHome: scoped?.hostHome ?? (typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined),
			})) as unknown as Record<string, unknown>;
		} else if (sourceRuntime === "claude-code") {
			const { ClaudeCodeRuntimeAdapter } = await import("../claude-code-adapter");
			const scoped = scopedHandoffBinding(typeof flags.home === "string" ? flags.home : undefined, "claude-code", workspaceRoot, profileName, typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined);
			const adapter = scoped ? ClaudeCodeRuntimeAdapter.forWorkspace(scoped.home, scoped.hostHome, scoped.root, scoped.profileName, scoped.sourceExcerpts, scoped.legacyUnscoped, scoped.legacyBefore) : ClaudeCodeRuntimeAdapter.fromInstalled({
				home: typeof flags.home === "string" ? flags.home : undefined,
				hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
			});
			result = (await adapter.createHandoff({
				...sharedRequest,
				profileName: scoped?.profileName ?? sharedRequest.profileName,
				workspaceRoot: scoped?.root ?? sharedRequest.workspaceRoot,
				workspaceId: scoped ? scopedWorkspaceId(scoped.root, sharedRequest.workspaceId) : sharedRequest.workspaceId,
				hostHome: scoped?.hostHome ?? (typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined),
			})) as unknown as Record<string, unknown>;
		} else {
			throw new Error("handoff export requires --source codex or --source claude-code");
		}
		// The capsule file is what travels to another machine for `handoff import --file`.
		if (outputFile) {
			const record = result.record as { capsule?: unknown } | undefined;
			if (!record?.capsule) throw new Error("handoff export produced no capsule to write");
			writeCapsuleFile(outputFile, record.capsule, flags.force === true);
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
				? readJsonFileBounded(filePath, HANDOFF_CAPSULE_FILE_MAX_BYTES)
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
					? importWorkspaceRoot(flags["workspace-root"])
					: typeof flags.workspaceRoot === "string"
						? importWorkspaceRoot(flags.workspaceRoot)
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
			allowedSigners: (() => {
				const value = flags["allow-signer"] ?? flags.allowSigner;
				if (value === true) throw new Error("--allow-signer needs an npub");
				return parseAllowedSigners(value);
			})(),
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
			const scoped = scopedHandoffBinding(typeof flags.home === "string" ? flags.home : undefined, "claude-code", sharedRequest.workspaceRoot, profileName, typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined);
			const adapter = scoped ? ClaudeCodeRuntimeAdapter.forWorkspace(scoped.home, scoped.hostHome, scoped.root, scoped.profileName, scoped.sourceExcerpts, scoped.legacyUnscoped, scoped.legacyBefore) : ClaudeCodeRuntimeAdapter.fromInstalled({
				home: typeof flags.home === "string" ? flags.home : undefined,
				hostHome: typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined,
			});
			result = (await adapter.importHandoff({
				...sharedRequest,
				profileName: scoped?.profileName ?? sharedRequest.profileName,
				workspaceRoot: scoped?.root ?? sharedRequest.workspaceRoot,
				workspaceId: scoped ? scopedWorkspaceId(scoped.root, sharedRequest.workspaceId) : sharedRequest.workspaceId,
				hostHome: scoped?.hostHome ?? (typeof flags["claude-home"] === "string" ? flags["claude-home"] : undefined),
			})) as unknown as Record<string, unknown>;
		} else if (targetRuntime === "codex") {
			const { CodexRuntimeAdapter } = await import("../codex-adapter");
			const scoped = scopedHandoffBinding(typeof flags.home === "string" ? flags.home : undefined, "codex", sharedRequest.workspaceRoot, profileName, typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined);
			const adapter = scoped ? CodexRuntimeAdapter.forWorkspace(scoped.home, scoped.hostHome, scoped.profileName, scoped.sourceExcerpts, scoped.legacyUnscoped, scoped.legacyBefore) : CodexRuntimeAdapter.fromInstalled({
				home: typeof flags.home === "string" ? flags.home : undefined,
				hostHome: typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined,
			});
			result = (await adapter.importHandoff({
				...sharedRequest,
				profileName: scoped?.profileName ?? sharedRequest.profileName,
				workspaceRoot: scoped?.root ?? sharedRequest.workspaceRoot,
				workspaceId: scoped ? scopedWorkspaceId(scoped.root, sharedRequest.workspaceId) : sharedRequest.workspaceId,
				hostHome: scoped?.hostHome ?? (typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined),
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
		const payload = readJsonFileBounded(inputPath, HANDOFF_CREATE_INPUT_MAX_BYTES);
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
		const capsule = readJsonFileBounded(filePath, HANDOFF_CAPSULE_FILE_MAX_BYTES);
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
			const capsule = readJsonFileBounded(filePath, HANDOFF_CAPSULE_FILE_MAX_BYTES);
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
