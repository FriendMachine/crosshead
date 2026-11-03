import path from "path";

import {
	buildBundledCapabilityDocument,
	type CapabilityDocument,
} from "../../protocol/features";
import { parseArgs } from "../local-runtime";
import { ensureRuntimeHomeLayout, parseJsonFile, writeJsonFile } from "../runtime-persistence";

type CapabilityCliResult = CapabilityDocument & {
	readonly cache?: {
		readonly source: "server" | "cache" | "none";
		readonly base_url?: string;
		readonly fetched_at?: string;
		readonly refresh_error?: string;
	};
};

type CachedCapabilityDocument = CapabilityDocument & {
	readonly fetched_at: string;
	readonly base_url: string;
};

const flagString = (value: string | boolean | undefined): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value : undefined;

const cacheFile = (home?: string): string => {
	const paths = ensureRuntimeHomeLayout(home);
	return path.join(paths.cache, "capabilities.json");
};

const readCachedCapabilities = (home?: string): CachedCapabilityDocument | null =>
	parseJsonFile<CachedCapabilityDocument | null>(cacheFile(home), null);

const writeCachedCapabilities = (
	home: string | undefined,
	baseUrl: string,
	document: CapabilityDocument
): CachedCapabilityDocument => {
	const cached = {
		...document,
		source: "cache" as const,
		base_url: baseUrl,
		fetched_at: new Date().toISOString(),
	};
	writeJsonFile(cacheFile(home), cached);
	return cached;
};

const fetchCapabilities = async (baseUrl: string): Promise<CapabilityDocument> => {
	const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
	const response = await fetch(`${normalizedBaseUrl}/v1/capabilities`, {
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`capability refresh failed: HTTP ${response.status}`);
	}
	const payload = (await response.json()) as CapabilityDocument;
	if (payload.schema_version !== "onlybots_capabilities_v1" || !payload.feature_gates) {
		throw new Error("capability refresh returned an invalid capability document");
	}
	return {
		...payload,
		source: "server",
	};
};

const renderCapabilityTable = (document: CapabilityCliResult): string => {
	const lines = [
		`Crosshead capabilities (${document.source}, env=${document.environment})`,
		"help_requires_network=false",
	];
	if (document.cache?.base_url) {
		lines.push(`base_url=${document.cache.base_url}`);
	}
	if (document.cache?.refresh_error) {
		lines.push(`refresh_error=${document.cache.refresh_error}`);
	}
	for (const gate of Object.values(document.feature_gates)) {
		lines.push(`${gate.id}: ${gate.state}${gate.enabled ? "" : " (disabled)"}`);
	}
	return lines.join("\n");
};

export const capabilitiesFromCli = async (argv: string[]): Promise<string> => {
	const { flags } = parseArgs(argv);
	const home = flagString(flags.home);
	const requestedEnv =
		flagString(flags.env) ??
		(process.env.CROSSHEAD_CLI_ENV ?? process.env.ONLYBOTS_CLI_ENV) ??
		(process.env.CROSSHEAD_ENV ?? process.env.ONLYBOTS_ENV) ??
		"production";
	const asJson = flags.json === true;
	const refresh = flags.refresh === true;
	const baseUrl = flagString(flags["base-url"]) ?? process.env.CROSSHEAD_BASE_URL ?? process.env.ONLYBOTS_BASE_URL;

	let document: CapabilityCliResult = {
		...buildBundledCapabilityDocument(requestedEnv),
		cache: { source: "none" },
	};

	if (refresh) {
		if (!baseUrl) {
			throw new Error("crosshead capabilities --refresh requires --base-url <url> or CROSSHEAD_BASE_URL");
		}
		try {
			const fresh = await fetchCapabilities(baseUrl);
			const cached = writeCachedCapabilities(home, baseUrl, fresh);
			document = {
				...fresh,
				cache: {
					source: "server",
					base_url: baseUrl.replace(/\/+$/, ""),
					fetched_at: cached.fetched_at,
				},
			};
		} catch (error) {
			const cached = readCachedCapabilities(home);
			if (!cached) {
				throw error;
			}
			document = {
				...cached,
				source: "cache",
				cache: {
					source: "cache",
					base_url: cached.base_url,
					fetched_at: cached.fetched_at,
					refresh_error: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}

	if (asJson) {
		return JSON.stringify(document, null, 2);
	}
	return renderCapabilityTable(document);
};

export const capabilityHelpLine =
	"crosshead capabilities [--env <test|local|lab|staging|production>] [--json] [--refresh --base-url <url>] [--home <path>]";
