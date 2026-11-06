import { publicDiscoveryRawEvents } from "./public-discovery";
import { readFileSync, writeFileSync } from "fs";
import path from "path";

import { OnlyBotsLocalRuntimeDaemon } from "./local-runtime";
import {
	explainCapabilityRouting,
	extractCapabilityClaims,
	extractPublicDiscoveryObservations,
	extractTrustEdges,
	extractTrustReceipts,
	inspectTrustGraph,
} from "./trust-routing";

const parseArgs = (args: string[]): { positionals: string[]; flags: Record<string, string | boolean> } => {
	const positionals: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index]!;
		if (!value.startsWith("--")) {
			positionals.push(value);
			continue;
		}
		const key = value.slice(2);
		const next = args[index + 1];
		if (!next || next.startsWith("--")) {
			flags[key] = true;
			continue;
		}
		flags[key] = next;
		index += 1;
	}
	return { positionals, flags };
};

const csv = (value: string | boolean | undefined): string[] =>
	typeof value === "string"
		? value
				.split(",")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0)
		: [];

const parseBoolean = (value: string | boolean | undefined, fallback = false): boolean => {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value !== "string") {
		return fallback;
	}
	const normalized = value.trim().toLowerCase();
	if (["true", "1", "yes", "y", "on"].includes(normalized)) {
		return true;
	}
	if (["false", "0", "no", "n", "off"].includes(normalized)) {
		return false;
	}
	throw new Error(`invalid boolean value: ${value}`);
};

const readJsonDocument = (filePath: string): unknown => JSON.parse(readFileSync(path.resolve(filePath), "utf8"));

const writeJsonDocument = (filePath: string, value: unknown): void => {
	writeFileSync(path.resolve(filePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const loadDocuments = (paths: string[]): unknown[] => paths.map((filePath) => readJsonDocument(filePath));

const formatReceiptResult = (result: Record<string, unknown>): string => {
	const receipt =
		result.receipt && typeof result.receipt === "object" && !Array.isArray(result.receipt)
			? (result.receipt as Record<string, unknown>)
			: null;
	const verification =
		result.verification && typeof result.verification === "object" && !Array.isArray(result.verification)
			? (result.verification as Record<string, unknown>)
			: null;
	const source =
		result.source && typeof result.source === "object" && !Array.isArray(result.source)
			? (result.source as Record<string, unknown>)
			: null;
	return [
		`${String(receipt?.receiptId ?? "unknown receipt")} ${String(receipt?.receiptType ?? "unknown")}`,
		`subject: ${
			receipt?.subject &&
			typeof receipt.subject === "object" &&
			!Array.isArray(receipt.subject) &&
			(receipt.subject as Record<string, unknown>).subjectType === "agent" &&
			typeof ((receipt.subject as Record<string, unknown>).agentRef as Record<string, unknown> | undefined)?.agentId === "string"
				? (((receipt.subject as Record<string, unknown>).agentRef as Record<string, unknown>).agentId as string)
				: "unknown"
		}`,
		`outcome: ${String(source?.outcomeId ?? "none")} capabilities: ${
			Array.isArray(source?.observedCapabilityIds) ? source.observedCapabilityIds.join(", ") || "none" : "none"
		}`,
		`signature_valid: ${verification?.valid === true ? "yes" : "no"}`,
	].join("\n");
};

const formatGraphResult = (result: Awaited<ReturnType<typeof inspectTrustGraph>>): string => {
	const validReceipts = result.receipts.filter((receipt) => receipt.valid).length;
	const invalidReceipts = result.receipts.length - validReceipts;
	return [
		`receipts: ${result.receipts.length} (valid=${validReceipts} invalid=${invalidReceipts})`,
		`trust_edges: ${result.trustEdges.length}`,
		`capability_claims: ${result.capabilityClaims.length}`,
		`public_discovery_items: ${result.publicDiscoveryItems.length}`,
		...(result.warnings.length > 0 ? [`warnings: ${result.warnings.join(" | ")}`] : []),
	].join("\n");
};

const formatRouteResult = (result: Awaited<ReturnType<typeof explainCapabilityRouting>>): string => {
	const lines = [
		`required_capabilities: ${result.query.requiredCapabilityIds.join(", ") || "none"}`,
		`candidates: ${result.candidates.length}`,
	];
	for (const candidate of result.candidates.slice(0, 5)) {
		const label =
			candidate.subject.subjectType === "agent"
				? candidate.subject.agentRef.agentId
				: candidate.subject.organizationRef.organizationId;
		lines.push(
			`${label}: score=${candidate.score.total} eligible=${candidate.eligibleForRouting ? "yes" : "no"} availability=${candidate.availability.status}`
		);
		lines.push(
			`  observed=${candidate.matchedCapabilities.observed.join(", ") || "none"} declared=${
				candidate.matchedCapabilities.declared.join(", ") || "none"
			} missing=${candidate.matchedCapabilities.missing.join(", ") || "none"}`
		);
		lines.push(
			`  reasons: ${candidate.explanation.positiveSignals.slice(0, 2).join(" | ") || "none"}${
				candidate.explanation.blockingReasons.length > 0
					? ` blockers=${candidate.explanation.blockingReasons.join(" | ")}`
					: ""
			}`
		);
	}
	return lines.join("\n");
};

const maybeWriteOutput = (
	flags: Record<string, string | boolean>,
	value: unknown
): { text: string; wrote: string | null } => {
	const outputPath =
		typeof flags.output === "string"
			? flags.output
			: typeof flags.file === "string" && flags.write === true
				? flags.file
				: null;
	if (!outputPath) {
		return {
			text: JSON.stringify(value, null, 2),
			wrote: null,
		};
	}
	writeJsonDocument(outputPath, value);
	return {
		text: JSON.stringify({ wrote: true, file: path.resolve(outputPath) }, null, 2),
		wrote: path.resolve(outputPath),
	};
};

const loadTrustInputs = (flags: Record<string, string | boolean>) => {
	const receiptFiles = csv(flags["receipt-files"] ?? flags.receiptFiles);
	const claimFiles = csv(flags["claim-files"] ?? flags.claimFiles);
	const edgeFiles = csv(flags["edge-files"] ?? flags.edgeFiles);
	const eventFiles = csv(flags["event-files"] ?? flags.eventFiles);

	const receipts = loadDocuments(receiptFiles).flatMap((document) => extractTrustReceipts(document));
	const capabilityClaims = loadDocuments(claimFiles).flatMap((document) => extractCapabilityClaims(document));
	const trustEdges = loadDocuments(edgeFiles).flatMap((document) => extractTrustEdges(document));
	const publicDiscoveryEvents = loadDocuments(eventFiles).flatMap(publicDiscoveryRawEvents);

	return {
		receipts,
		capabilityClaims,
		trustEdges,
		publicDiscoveryEvents,
	};
};

const fetchLivePublicDiscovery = async (
	daemon: OnlyBotsLocalRuntimeDaemon,
	flags: Record<string, string | boolean>,
	profileName?: string
) => {
	const eventType =
		typeof flags["event-type"] === "string"
			? flags["event-type"]
			: typeof flags.eventType === "string"
				? flags.eventType
				: "capability_advertisement,availability_heartbeat";
	const result = await daemon.inspectPublicDiscovery(
		{
			event_type: eventType,
			authors: typeof flags.authors === "string" ? flags.authors : undefined,
			latest_only: String(
				parseBoolean(
					typeof flags["latest-only"] === "string" ? flags["latest-only"] : flags.latestOnly,
					true
				)
			),
			include_raw: "true",
			limit:
				typeof flags.limit === "string"
					? flags.limit
					: typeof flags["top-k"] === "string"
						? String(Math.max(25, Number(flags["top-k"]) * 5))
						: "100",
		},
		profileName
	);
	return publicDiscoveryRawEvents(result);
};

export const trustFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
	const profileName = typeof flags.profile === "string" ? flags.profile : undefined;

	if (subcommand === "receipt") {
		const sourceKind = positionals[1];
		if (sourceKind !== "handoff") {
			throw new Error("trust receipt currently supports only: handoff");
		}
		const handoffId =
			typeof flags.id === "string"
				? flags.id
				: typeof flags["handoff-id"] === "string"
					? flags["handoff-id"]
					: "";
		if (!handoffId) {
			throw new Error("trust receipt handoff requires --id <handoff_id>");
		}
		const result = await daemon.mintHandoffTrustReceipt(
			{
				handoffId,
				outcomeId:
					typeof flags["outcome-id"] === "string"
						? flags["outcome-id"]
						: typeof flags.outcomeId === "string"
							? flags.outcomeId
							: undefined,
			},
			profileName
		);
		const persisted = maybeWriteOutput(flags, result);
		if (flags.json || flags.debug || persisted.wrote) {
			return persisted.text;
		}
		return formatReceiptResult(result);
	}

	if (subcommand === "graph") {
		const inputs = loadTrustInputs(flags);
    const requestedFetch = flags["fetch-public"] ?? flags.fetchPublic;
    const shouldFetchPublic = requestedFetch !== undefined ? parseBoolean(requestedFetch, false)
      : typeof flags.authors === "string" || typeof flags["event-type"] === "string" || inputs.publicDiscoveryEvents.length > 0;
    const events = shouldFetchPublic
      ? [...inputs.publicDiscoveryEvents, ...(await fetchLivePublicDiscovery(daemon, flags, profileName))]
      : inputs.publicDiscoveryEvents;
    const publicDiscoveryItems = extractPublicDiscoveryObservations({ revision_events: events });
		const result = await inspectTrustGraph({
			trustReceipts: inputs.receipts,
			capabilityClaims: inputs.capabilityClaims,
			trustEdges: inputs.trustEdges,
			publicDiscoveryItems,
		});
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatGraphResult(result);
	}

	if (subcommand === "route") {
		const requiredCapabilityIds = csv(flags["required-capability-ids"] ?? flags.requiredCapabilityIds);
		if (requiredCapabilityIds.length === 0) {
			throw new Error("trust route requires --required-capability-ids <csv>");
		}
		const inputs = loadTrustInputs(flags);
    const shouldFetchPublic = parseBoolean(flags["fetch-public"] ?? flags.fetchPublic, true);
    const events = shouldFetchPublic
      ? [...inputs.publicDiscoveryEvents, ...(await fetchLivePublicDiscovery(daemon, flags, profileName))]
      : inputs.publicDiscoveryEvents;
    const publicDiscoveryItems = extractPublicDiscoveryObservations({ revision_events: events });
		const result = await explainCapabilityRouting({
			trustReceipts: inputs.receipts,
			capabilityClaims: inputs.capabilityClaims,
			trustEdges: inputs.trustEdges,
			publicDiscoveryItems,
			routing: {
				requiredCapabilityIds,
				preferredRuntimeHosts: csv(flags["preferred-runtime-hosts"] ?? flags.preferredRuntimeHosts),
				requiredTrustZones: csv(flags["required-trust-zones"] ?? flags.requiredTrustZones),
				budgetSats:
					typeof flags["budget-sats"] === "string"
						? Number(flags["budget-sats"])
						: typeof flags.budgetSats === "string"
							? Number(flags.budgetSats)
							: null,
				includeUnavailable: parseBoolean(
					typeof flags["include-unavailable"] === "string" ? flags["include-unavailable"] : flags.includeUnavailable,
					false
				),
				topK:
					typeof flags["top-k"] === "string"
						? Number(flags["top-k"])
						: typeof flags.topK === "string"
							? Number(flags.topK)
							: undefined,
			},
		});
		return flags.json || flags.debug ? JSON.stringify(result, null, 2) : formatRouteResult(result);
	}

	throw new Error("trust requires one of: receipt handoff, graph, route");
};
