import { organizationJoinFromCli, signChallengeFromCli } from "./cli/organization";
import { installCodexFromCli, uninstallCodexFromCli } from "./codex-adapter";
import { installClaudeCodeFromCli, uninstallClaudeCodeFromCli } from "./claude-code-adapter";
import { installPiFromCli, uninstallPiFromCli } from "./pi-adapter";
import { installOmpFromCli, uninstallOmpFromCli } from "./omp-adapter";
import path from "path";
import { negotiationFromCli, organizationFromCli } from "./economic-governance-cli";
import { bundleFromCli } from "./resource-bundle-cli";
import { trustFromCli } from "./trust-routing-cli";

import { agentFromCli, lineageFromCli, passportFromCli } from "./cli/agent";
import { billingFromCli } from "./cli/billing";
import { capabilitiesFromCli, capabilityHelpLine } from "./cli/capabilities";
import { contextFromCli } from "./cli/context";
import { continuityFromCli } from "./cli/continuity";
import { applyFromCli, checkUpdatesFromCli, doctorFromCli, eventsFromCli, installCoreFromCli, keygenFromCli, logsFromCli, rollbackFromCli, setupProfileFromCli, startFromCli, statusFromCli, stopFromCli, uninstallFromCli, updateFromCli } from "./cli/core";
import { handoffFromCli } from "./cli/handoff";
import { memoryFromCli, workspaceFromCli } from "./cli/memory";
import { messagesFromCli } from "./cli/messages";
import { publicFromCli } from "./cli/public";
import { quickstartFromCli } from "./cli/quickstart";
import { buildRuntimeBillingRemediation, formatRuntimeBillingRemediation } from "./billing-remediation";
import { HostedOnlyBotsRequestError } from "./hosted-client";
import { assertSecureNodeRuntimeVersion } from "./node-runtime-version";

const renderOnlyBotsCtlCliError = (
	argv: string[],
	error: unknown
): { stream: "stdout" | "stderr"; output: string; exitCode: number } => {
	const message = error instanceof Error ? error.message : String(error);
	const hosted = error instanceof HostedOnlyBotsRequestError ? error : null;
	const remediation = hosted
		? buildRuntimeBillingRemediation({
				status: hosted.status,
				code: hosted.code,
				message: hosted.message,
				details: hosted.details,
			})
		: null;
	if (argv.includes("--json")) {
		return {
			stream: "stdout",
			output: JSON.stringify(
				{
					error: {
						code: hosted?.code ?? "bad_request",
						status: hosted?.status,
						message,
						details: hosted?.details,
						...(remediation ? { remediation } : {}),
					},
				},
				null,
				2
			),
			exitCode: 1,
		};
	}

	return {
		stream: "stderr",
		output: remediation ? `${message}\n${formatRuntimeBillingRemediation(remediation)}` : message,
		exitCode: 1,
	};
};

/** Commands an embedding build adds or overrides; each returns the text to print. */
export type OnlyBotsCtlCliExtensions = {
	commands?: Record<string, (rest: string[]) => Promise<string>>;
	/** Entry scripts that wrappers and daemon restarts should launch instead of this build's own. */
	cliScriptPath?: string;
	daemonScriptPath?: string;
};

export const runOnlyBotsCtlCli = async (
	argv: string[] = process.argv.slice(2),
	extensions: OnlyBotsCtlCliExtensions = {}
): Promise<void> => {
	assertSecureNodeRuntimeVersion();
	const command = argv[0];
	const rest = argv.slice(1);
	const extension = command ? extensions.commands?.[command] : undefined;
	if (extension) {
		process.stdout.write(`${await extension(rest)}\n`);
		return;
	}
	const cliScriptPath = extensions.cliScriptPath ?? path.resolve(__filename);
	const daemonScriptPath = extensions.daemonScriptPath ?? path.resolve(__dirname, "daemon.js");
	const codexBridgeScriptPath = path.resolve(__dirname, "codex-bridge.js");
	const codexHookScriptPath = path.resolve(__dirname, "codex-hook.js");
	const claudeCodeBridgeScriptPath = path.resolve(__dirname, "claude-code-bridge.js");
	const claudeCodeHookScriptPath = path.resolve(__dirname, "claude-code-hook.js");

	let output: string;
	switch (command) {
		case "install":
			if (rest[0] === "codex") {
				await installCoreFromCli(rest.slice(1), cliScriptPath, daemonScriptPath);
				output = await installCodexFromCli(rest.slice(1), codexBridgeScriptPath, codexHookScriptPath);
				break;
			}
			if (rest[0] === "claude-code") {
				await installCoreFromCli(rest.slice(1), cliScriptPath, daemonScriptPath);
				output = await installClaudeCodeFromCli(rest.slice(1), claudeCodeBridgeScriptPath, claudeCodeHookScriptPath);
				break;
			}
			if (rest[0] === "pi") {
				await installCoreFromCli(rest.slice(1), cliScriptPath, daemonScriptPath);
				output = await installPiFromCli(rest.slice(1));
				break;
			}
			if (rest[0] === "omp") {
				await installCoreFromCli(rest.slice(1), cliScriptPath, daemonScriptPath);
				output = await installOmpFromCli(rest.slice(1));
				break;
			}
			output = await installCoreFromCli(rest, cliScriptPath, daemonScriptPath);
			break;
		case "setup":
			output = await setupProfileFromCli(rest);
			break;
		case "keygen":
			output = await keygenFromCli(rest);
			break;
		case "status":
			output = await statusFromCli(rest);
			break;
		case "check-updates":
			output = await checkUpdatesFromCli(rest);
			break;
		case "doctor":
			output = await doctorFromCli(rest);
			break;
		case "logs":
			output = await logsFromCli(rest);
			break;
		case "events":
			output = await eventsFromCli(rest);
			break;
		case "workspace":
			output = await workspaceFromCli(rest);
			break;
		case "memory":
			output = await memoryFromCli(rest);
			break;
		case "messages":
			output = await messagesFromCli(rest);
			break;
		case "billing":
			output = await billingFromCli(rest);
			break;
		case "public":
			output = await publicFromCli(rest);
			break;
		case "sign-challenge":
			output = await signChallengeFromCli(rest);
			break;
		case "organization":
			output = rest[0] === "join" ? await organizationJoinFromCli(rest.slice(1)) : await organizationFromCli(rest);
			break;
		case "negotiation":
			output = await negotiationFromCli(rest);
			break;
		case "bundle":
			output = await bundleFromCli(rest);
			break;
		case "trust":
			output = await trustFromCli(rest);
			break;
		case "context":
			output = await contextFromCli(rest);
			break;
		case "continuity":
			output = await continuityFromCli(rest);
			break;
		case "passport":
			output = await passportFromCli(rest);
			break;
		case "agent":
			output = await agentFromCli(rest);
			break;
		case "lineage":
			output = await lineageFromCli(rest);
			break;
		case "handoff":
			output = await handoffFromCli(rest);
			break;
		case "capabilities":
			output = await capabilitiesFromCli(rest);
			break;
		case "quickstart":
		case "onboard":
			output = await quickstartFromCli(rest, {
				cliScriptPath,
				daemonScriptPath,
				codexBridgeScriptPath,
				codexHookScriptPath,
				claudeCodeBridgeScriptPath,
				claudeCodeHookScriptPath,
			});
			break;
		case "start":
			output = await startFromCli(rest);
			break;
		case "apply":
			output = await applyFromCli(rest);
			break;
		case "update":
			output = await updateFromCli(rest);
			break;
		case "rollback":
			output = await rollbackFromCli(rest);
			break;
		case "stop":
			output = await stopFromCli(rest);
			break;
		case "uninstall":
			if (rest[0] === "codex") {
				output = await uninstallCodexFromCli(rest.slice(1));
				break;
			}
			if (rest[0] === "claude-code") {
				output = await uninstallClaudeCodeFromCli(rest.slice(1));
				break;
			}
			if (rest[0] === "pi") {
				output = await uninstallPiFromCli(rest.slice(1));
				break;
			}
			if (rest[0] === "omp") {
				output = await uninstallOmpFromCli(rest.slice(1));
				break;
			}
			if (rest[0] && !rest[0].startsWith("--")) {
				throw new Error(`Unknown uninstall target: ${rest[0]}`);
			}
			output = await uninstallFromCli(rest);
			break;
		default:
			output = [
				"Crosshead CLI (crosshead; aliases: xhd, onlybotsctl)",
				"crosshead install [--home <path>] [--channel stable|beta|canary]",
				"crosshead install codex [--home <path>] [--codex-home <path>] [--codex-bin <path>] [--profile <name>] [--version <version>]",
				"crosshead install claude-code [--home <path>] [--claude-home <path>] [--workspace-root <path>] [--profile <name>] [--version <version>] [--claude-bin <path>]",
				"crosshead install pi [--home <path>] [--profile <name>] [--version <version>]  # embedded hosts without shell wiring",
				"crosshead install omp [--home <path>] [--profile <name>] [--workspace-root <path>] [--omp-bin <path>] [--no-envrc]  # Pi-compatible OMP project wiring",
				"crosshead quickstart --api-base <url> [--home <path>] [--profile <name>] [--adapter codex|claude-code|pi|omp|none] [--workspace-root <path>] [--omp-bin <path>] [--create-checkout] [--json]",
				capabilityHelpLine,
		"crosshead keygen [--json]",
		"crosshead keygen --setup --profile <name> --api-base <url> [--home <path>] [--memory-mode assist] [--workspace-scope repo|workspace|global] [--json]",
				"crosshead setup --profile <name> --api-base <url> --npub <npub> --nsec <nsec> [--memory-mode assist]",
				"crosshead start [--home <path>] [--port <port>]",
				"crosshead stop [--home <path>]",
				"crosshead status [--home <path>] [--profile <name>] [--billing] [--json]",
				"crosshead billing status [--home <path>] [--profile <name>] [--low-credit-threshold <credits>] [--json]",
				"crosshead billing checkout [--home <path>] [--profile <name>] [--credits <n>] [--success-url <url>] [--cancel-url <url>] [--json]",
				"crosshead billing invoices [--home <path>] [--profile <name>] [--status unpaid|paid|expired|canceled] [--limit <n>] [--json]",
				"crosshead billing invoice (--invoice-id <id>|--payment-hash <hash>) [--home <path>] [--profile <name>] [--json]",
				"crosshead check-updates [--home <path>] [--channel stable|beta|canary] [--json]",
				"crosshead apply [--home <path>] [--manifest <path>]",
				"crosshead update --sha256 <trusted-release-digest> [--home <path>] [--no-restart]",
				"crosshead update --pin|--auto|--policy [--home <path>]",
				"crosshead update [adapter] [--home <path>] [--channel stable|beta|canary] [--version <version>]",
				"crosshead rollback [adapter] --to <version> [--home <path>]",
				"crosshead doctor [--home <path>] [--json]",
				"crosshead logs [--home <path>] [--lines 50]",
				"crosshead events [--home <path>] [--lines 50] [--json]",
				"crosshead workspace link --name <shared-label> --workspace-root <path> [--home <path>] [--profile <name>]",
				"crosshead memory sync [--home <path>] [--profile <name>]",
				"crosshead memory hot reset --scope <scope> [--home <path>] [--profile <name>]",
				"crosshead memory hot [--inspect] [--home <path>] [--profile <name>] [--json|--debug]",
				"crosshead memory warm [--home <path>] [--profile <name>] [--type <type>] [--status <status>] [--include-system] [--json|--debug]",
				"crosshead memory evaluate [--home <path>] [--profile <name>] [--lines 200] [--limit 50] [--apply] [--include-system] [--json|--debug]",
				"crosshead memory search <query> [--home <path>] [--profile <name>] [--top-k <n>] [--include-system] [--json|--debug]",
				"crosshead memory export [--home <path>] [--profile <name>]",
				"crosshead memory mode <off|manual|assist|auto> [--home <path>] [--profile <name>]",
		"crosshead messages state [--home <path>] [--profile <name>] [--statuses <csv>] [--priorities <csv>] [--context-id <id>] [--message-type <chat|inbox_event>] [--unread-only true|false] [--include-terminal true|false] [--limit <n>] [--json|--debug]",
		"crosshead messages replay (--inbox-id <id>|--message-event-id <id>) [--home <path>] [--profile <name>] [--note <text>] [--json|--debug]",
		"crosshead messages ack (--inbox-id <id>|--message-event-id <id>) [--home <path>] [--profile <name>] [--actor-runtime-host <host>] [--note <text>] [--json|--debug]",
		"crosshead messages resolve (--inbox-id <id>|--message-event-id <id>) --resolution <completed|failed|rejected> [--home <path>] [--profile <name>] [--actor-runtime-host <host>] [--result-summary <text>] [--failure-code <code>] [--retryable true|false] [--reason <text>] [--note <text>] [--json|--debug]",
		"crosshead public schema [--home <path>] [--profile <name>] [--json]",
		"crosshead public state [--home <path>] [--profile <name>] [--event-type <type>] [--authors <csv>] [--primary-id <id>] [--event-id <id>] [--capability-id <id>] [--offer-id <id>] [--task-ref <ref>] [--agent-id <id>] [--status <status>] [--since <unix>] [--until <unix>] [--latest-only true|false] [--include-raw true|false] [--limit <n>] [--json|--debug]",
		"crosshead public advertise --advertisement-id <id> --summary <text> --capability-ids <csv> [--capability-claim-refs <csv>] [--runtime-hosts <csv>] [--trust-zones <csv>] [--workspace-refs <csv>] [--availability-ref <ref>] [--note <text>] [--home <path>] [--profile <name>] [--json|--debug]",
		"crosshead public availability --presence-id <id> --status <available|busy|draining|offline> --summary <text> [--claimed-jobs <n>] [--max-concurrent-jobs <n>] [--next-heartbeat-due-at <iso>] [--availability-ref <ref>] [--current-task-refs <csv>] [--note <text>] [--home <path>] [--profile <name>] [--json|--debug]",
		"crosshead public offer --offer-id <id> --task-ref <ref> --summary <text> [--required-capability-ids <csv>] [--required-capability-claim-refs <csv>] [--target-agent-npubs <csv>] [--collaboration-context-ref <ref>] [--budget-sats <n>] [--expires-at <iso>] [--note <text>] [--home <path>] [--profile <name>] [--json|--debug]",
		"crosshead public claim --claim-id <id> --offer-id <id> --summary <text> [--offer-event-id <id>] [--claim-state <claimed|released>] [--availability-ref <ref>] [--collaboration-context-ref <ref>] [--note <text>] [--home <path>] [--profile <name>] [--json|--debug]",
		"crosshead organization join <code> [--agent-id <agent_id>] [--profile <name>] [--json]",
		"crosshead sign-challenge \"<console challenge>\" [--npub <npub>] [--profile <name>] [--home <path>] [--json]",
		"crosshead organization init --organization-id <id> --organization-npub <npub> --display-name <name> --summary <text> --founder-agent-ids <csv> --founder-agent-npubs <csv> [--file <path>] [--json]",
		"crosshead organization inspect --file <path> [--json]",
		"crosshead organization policy-inspect --file <path> [--json]",
		"crosshead organization budget-inspect --file <path> [--json]",
		"crosshead organization member-add --file <path> --member-agent-id <id> --member-npub <npub> --role <founder|operator|builder|reviewer|treasury|observer> [--write] [--json]",
		"crosshead organization member-remove --file <path> --agent-id <id> [--write] [--json]",
		"crosshead organization member-role --file <path> --agent-id <id> --role <founder|operator|builder|reviewer|treasury|observer> [--write] [--json]",
		"crosshead organization member-status --file <path> --agent-id <id> --status <active|suspended|former> [--write] [--json]",
		"crosshead negotiation init --thread-id <id> --work-summary <text> --requester-organization-id <id> --requester-organization-npub <npub> --provider-organization-id <id> --provider-organization-npub <npub> --summary <text> [--file <path>] [--json]",
		"crosshead negotiation inspect --file <path> [--json]",
		"crosshead negotiation explain --file <path> [--json]",
		"crosshead negotiation counter --file <path> --summary <text> [--write] [--json]",
		"crosshead negotiation conditional-accept --file <path> --summary <text> [--condition-refs <csv>] [--write] [--json]",
		"crosshead negotiation reject --file <path> --summary <text> [--reason <text>] [--write] [--json]",
		"crosshead negotiation settle --file <path> --summary <text> --settlement-ref <ref> [--write] [--json]",
		"crosshead bundle schema [--json]",
		"crosshead bundle inspect --file <path> [--json]",
		"crosshead bundle validate --file <path> [--json]",
		"crosshead bundle select --file <path> --scope <user_global|project|tenant|session> [--resource-ids <csv>] [--json]",
				"crosshead trust receipt handoff --id <handoff_id> [--outcome-id <id>] [--output <path>] [--json]",
				"crosshead trust graph [--receipt-files <csv>] [--claim-files <csv>] [--edge-files <csv>] [--event-files <csv>] [--fetch-public true|false] [--authors <csv>] [--json]",
				"crosshead trust route --required-capability-ids <csv> [--receipt-files <csv>] [--claim-files <csv>] [--edge-files <csv>] [--event-files <csv>] [--preferred-runtime-hosts <csv>] [--required-trust-zones <csv>] [--budget-sats <n>] [--include-unavailable true|false] [--top-k <n>] [--authors <csv>] [--json]",
				"crosshead context pack --goal <text> [--home <path>] [--profile <name>] [--session-id <id>] [--workspace-id <id>] [--max-fragments <n>] [--max-tokens <n>] [--pricing-usd-per-1k <usd>] [--model <name>] [--json]",
				"crosshead context inspect (--pack-id <id>|--latest) [--home <path>] [--profile <name>] [--json]",
				"crosshead context judgment [--home <path>] [--profile <name>] [--json]",
				"crosshead context continuity [--home <path>] [--profile <name>] [--json]",
				"crosshead context dreams inspect [--home <path>] [--profile <name>] [--proposal-id <id>] [--run-id <id>] [--status pending|approved|rejected|superseded] [--json]",
				"crosshead context dreams run [--home <path>] [--profile <name>] [--trigger operator|scheduled] [--max-outcomes <n>] [--note <text>] [--json]",
				"crosshead context dreams review --proposal-id <id> --decision <approve|reject|supersede|merge> [--target-proposal-id <id>] [--note <text>] [--home <path>] [--profile <name>] [--json]",
				"crosshead context obligations inspect [--home <path>] [--profile <name>] [--status scheduled|due|done|cancelled] [--limit <n>] [--json]",
				"crosshead context self-model review --entry-id <id> --decision <approve|reject|supersede> [--summary <text>] [--section strength|failure_mode|calibration_note|preferred_environment|bias_pattern] [--preferred-runtime-hosts <csv>] [--note <text>] [--json]",
				"crosshead continuity policy [--home <path>] [--json]",
				"crosshead continuity state [--home <path>] [--json]",
				"crosshead continuity patch --file <path> [--home <path>] [--json]",
				"crosshead continuity remove --patch-id <id> [--reason <text>] [--home <path>] [--json]",
				"crosshead passport init [--home <path>] [--profile <name>] [--agent-id <id>] [--display-name <name>] [--workspace-id <id>] [--trust-zones <csv>] [--targets <csv>] [--file <path>] [--json]",
				"crosshead passport import --from codex|claude-code [--workspace-root <path>] [--trust-zone personal|shared|public|client] [--file <path>] [--json]",
				"crosshead passport compile --target codex|claude-code|pi [--workspace-root <path>] [--passport-file <path>] [--trust-zone personal|shared|public|client] [--write] [--json]",
				"crosshead passport diff --target codex|claude-code|pi [--workspace-root <path>] [--passport-file <path>] [--trust-zone personal|shared|public|client] [--json]",
				"crosshead passport verify --target codex|claude-code|pi [--workspace-root <path>] [--passport-file <path>] [--trust-zone personal|shared|public|client] [--json]",
				"crosshead passport explain-routing [--passport-file <path>] [--json]",
				"crosshead agent show [--home <path>] [--profile <name>] [--agent-id <id>] [--json]",
				"crosshead agent attest-identity --home <path> --profile <name> --output <new-absolute-private-file> [--json]",
				"crosshead agent verify-identity --input <absolute-evidence-file> [--json]",
				"crosshead agent sign-organization-attachment --home <path> --profile <name> --challenge <onlybots_org_attach_v1:...> [--json]",
				"crosshead agent set-engine [--home <path>] [--profile <name>] [--agent-id <id>] [--runtime-host <host>] [--provider <name>] [--model-family <name>] [--model-id <name>] [--host-version <version>] [--prompt-transport <surface>] [--portability-notes-json <json>] [--fidelity-notes-json <json>] [--compensation-hints-json <json>] [--reason <text>] [--json]",
				"crosshead agent fork [--home <path>] [--profile <name>] --child-profile <name> --reason <text> [--child-agent-id <id>] [--child-display-name <name>] [--inherit-refs <csv>] [--exclude-refs <csv>] [--without-policy] [--without-self-model] [--without-project-models] [--without-passport] [--trust-carryover-mode none|bounded|operator_review] [--note <text>] [--json]",
				"crosshead lineage show [--home <path>] [--profile <name>] [--agent-id <id>] [--json]",
				"crosshead handoff export --source <codex|claude-code> --target <claude-code|codex> --workspace-root <path> --session-id <id> --prompt <text> [--turn-id <id>] [--transcript-json <json>] [--json]",
				"crosshead handoff import --target <claude-code|codex> --id <handoff_id> --workspace-root <path> --session-id <id> [--note <text>] [--reject] [--json]",
				"crosshead handoff outcome --id <handoff_id> --runtime <codex|claude-code> --kind <accepted|rejected|completed|failed|corrected> [--summary <text>] [--resulting-handoff-id <id>] [--json]",
				"crosshead handoff create --input <translation.json> [--home <path>] [--profile <name>] [--max-bytes <n>] [--json]",
				"crosshead handoff verify --file <capsule.json> [--home <path>] [--profile <name>] [--json]",
				"crosshead handoff explain --file <capsule.json> [--home <path>] [--profile <name>] [--json]",
				"crosshead handoff explain --id <handoff_id> [--home <path>] [--profile <name>] [--json]",
				"crosshead uninstall [--home <path>]",
				"crosshead uninstall codex [--home <path>] [--codex-home <path>]",
				"crosshead uninstall claude-code [--home <path>] [--claude-home <path>]",
				"crosshead uninstall pi [--home <path>]",
				"crosshead uninstall omp [--home <path>] [--workspace-root <path>]",
			].join("\n");
	}

	process.stdout.write(`${output}\n`);
};

export const runOnlyBotsCtlCliEntrypoint = async (
	argv: string[] = process.argv.slice(2),
	exit: (code: number) => void = process.exit,
	extensions: OnlyBotsCtlCliExtensions = {}
): Promise<void> => {
	try {
		await runOnlyBotsCtlCli(argv, extensions);
	} catch (error) {
		const rendered = renderOnlyBotsCtlCliError(argv, error);
		const stream = rendered.stream === "stdout" ? process.stdout : process.stderr;
		stream.write(`${rendered.output}\n`);
		exit(rendered.exitCode);
	}
};

if (require.main === module) {
	void runOnlyBotsCtlCliEntrypoint();
}
