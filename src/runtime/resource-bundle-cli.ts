import { readFileSync } from "fs";
import path from "path";

import type { ResourceBundleInstallScope, ResourceBundleManifest } from "../protocol/resource-bundles";
import { RESOURCE_BUNDLE_EXECUTION_BOUNDARIES, RESOURCE_BUNDLE_INSTALL_SCOPES, RESOURCE_BUNDLE_RESOURCE_TYPES, RESOURCE_BUNDLE_SCHEMA_VERSION, RESOURCE_BUNDLE_TRUST_CLASSES, inspectResourceBundleManifest, resolveResourceBundleSelection, resourceBundleExample, validateResourceBundleManifest } from "../protocol/resource-bundles";

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

const readJsonDocument = <T>(filePath: string): T =>
	JSON.parse(readFileSync(path.resolve(filePath), "utf8")) as T;

const formatInspection = (inspection: ReturnType<typeof inspectResourceBundleManifest>): string =>
	[
		`${inspection.displayName} (${inspection.bundleId})`,
		`version: ${inspection.version} resources=${inspection.resourceCount} default_scope=${inspection.defaultScope}`,
		`selective_install=${inspection.allowSelectiveInstall ? "yes" : "no"} upgrade_approval=${
			inspection.requiresExplicitUpgradeApproval ? "yes" : "no"
		} execution_boundary=${inspection.executionTrustBoundary}`,
		`default_selected: ${inspection.defaultSelectedResourceIds.join(", ") || "none"}`,
		`executable_resources: ${inspection.executableResourceIds.join(", ") || "none"}`,
		`operator_review_resources: ${inspection.operatorReviewResourceIds.join(", ") || "none"}`,
		`payload_hash_matches: ${inspection.payloadHashMatches ? "yes" : "no"}`,
		...(inspection.warnings.length > 0 ? [`warnings: ${inspection.warnings.join(" | ")}`] : []),
	].join("\n");

const formatSelectionPlan = (plan: ReturnType<typeof resolveResourceBundleSelection>): string =>
	[
		`${plan.bundleId} scope=${plan.scope}`,
		`selected: ${plan.selectedResourceIds.join(", ") || "none"}`,
		`execution_boundary: ${plan.executionTrustBoundary} upgrade_approval=${
			plan.requiresExplicitUpgradeApproval ? "yes" : "no"
		}`,
		`blocked: ${plan.blockedResources.map((entry) => `${entry.resourceId}:${entry.reason}`).join(" | ") || "none"}`,
		...(plan.warnings.length > 0 ? [`warnings: ${plan.warnings.join(" | ")}`] : []),
	].join("\n");

export const bundleFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];

	if (subcommand === "schema") {
		return JSON.stringify(
			{
				schema_version: RESOURCE_BUNDLE_SCHEMA_VERSION,
				resource_types: RESOURCE_BUNDLE_RESOURCE_TYPES,
				install_scopes: RESOURCE_BUNDLE_INSTALL_SCOPES,
				trust_classes: RESOURCE_BUNDLE_TRUST_CLASSES,
				execution_boundaries: RESOURCE_BUNDLE_EXECUTION_BOUNDARIES,
				compatibility: {
					validate_endpoint: "POST /v1/resource-bundles/validate",
					install_boundary: "bundle installation records provenance and scope policy but never grants executable trust by itself",
					selective_install: "selection plans may choose a subset of resources only when allowSelectiveInstall is true",
				},
				operator_surface: {
					inspect: "crosshead bundle inspect --file <path> --json",
					validate: "crosshead bundle validate --file <path> --json",
					select: "crosshead bundle select --file <path> --scope <user_global|project|tenant|session> [--resource-ids <csv>] --json",
				},
				example: resourceBundleExample,
			},
			null,
			2
		);
	}

	if (subcommand === "inspect") {
		const filePath = typeof flags.file === "string" ? flags.file : null;
		if (!filePath) {
			throw new Error("bundle inspect requires --file <path>");
		}
		const bundle = readJsonDocument<ResourceBundleManifest>(filePath);
		const inspection = inspectResourceBundleManifest(bundle);
		return flags.json ? JSON.stringify(inspection, null, 2) : formatInspection(inspection);
	}

	if (subcommand === "validate") {
		const filePath = typeof flags.file === "string" ? flags.file : null;
		if (!filePath) {
			throw new Error("bundle validate requires --file <path>");
		}
		const bundle = readJsonDocument<ResourceBundleManifest>(filePath);
		const errors = validateResourceBundleManifest(bundle);
		const valid = errors.length === 0;
		const output = {
			valid,
			errors,
			inspection: valid ? inspectResourceBundleManifest(bundle) : null,
		};
		return JSON.stringify(output, null, 2);
	}

	if (subcommand === "select") {
		const filePath = typeof flags.file === "string" ? flags.file : null;
		if (!filePath) {
			throw new Error("bundle select requires --file <path>");
		}
		const scopeValue =
			typeof flags.scope === "string" ? flags.scope : typeof flags["install-scope"] === "string" ? flags["install-scope"] : null;
		if (!scopeValue) {
			throw new Error("bundle select requires --scope <user_global|project|tenant|session>");
		}
		const bundle = readJsonDocument<ResourceBundleManifest>(filePath);
		const selection = resolveResourceBundleSelection(bundle, {
			scope: scopeValue as ResourceBundleInstallScope,
			resourceIds: csv(flags["resource-ids"] ?? flags.resourceIds),
		});
		return flags.json ? JSON.stringify(selection, null, 2) : formatSelectionPlan(selection);
	}

	throw new Error("bundle requires one of: schema, inspect, validate, select");
};
