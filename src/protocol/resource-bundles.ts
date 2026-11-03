import { createHash } from "crypto";

import type { IsoDateString, Npub } from "./base";

export const RESOURCE_BUNDLE_SCHEMA_VERSION = "resource_bundle_v1";
export const RESOURCE_BUNDLE_RESOURCE_TYPES = [
	"executable_skill",
	"context_pack",
	"prompt_pack",
	"operator_extension",
	"ui_extension",
	"theme",
] as const;
export const RESOURCE_BUNDLE_INSTALL_SCOPES = ["user_global", "project", "tenant", "session"] as const;
export const RESOURCE_BUNDLE_TRUST_CLASSES = [
	"executable_untrusted",
	"context_reviewed",
	"extension_review_required",
	"presentation_only",
] as const;
export const RESOURCE_BUNDLE_EXECUTION_BOUNDARIES = ["install_only", "policy_gated"] as const;

export type ResourceBundleResourceType = (typeof RESOURCE_BUNDLE_RESOURCE_TYPES)[number];
export type ResourceBundleInstallScope = (typeof RESOURCE_BUNDLE_INSTALL_SCOPES)[number];
export type ResourceBundleTrustClass = (typeof RESOURCE_BUNDLE_TRUST_CLASSES)[number];
export type ResourceBundleExecutionBoundary = (typeof RESOURCE_BUNDLE_EXECUTION_BOUNDARIES)[number];

export type ResourceBundleProvenance = {
	sourceUrl: string | null;
	repositoryRef: string | null;
	payloadHash: string;
	signedAt: IsoDateString;
	signature: string;
	attestationRefs: string[];
};

export type ResourceBundleExecutionPolicy = {
	executable: boolean;
	policyRequired: boolean;
	sandboxRequired: boolean;
	requiredCapabilityRefs: string[];
	secretRefs: string[];
	networkEgress: string[];
};

export type ResourceBundleResource = {
	resourceId: string;
	resourceType: ResourceBundleResourceType;
	version: string;
	summary: string;
	entryRef: string;
	contentHash: string;
	installScopes: ResourceBundleInstallScope[];
	selectedByDefault: boolean;
	trustClass: ResourceBundleTrustClass;
	executionPolicy: ResourceBundleExecutionPolicy;
	tags: string[];
	notes: string[];
};

export type ResourceBundleInstallPolicy = {
	allowedScopes: ResourceBundleInstallScope[];
	defaultScope: ResourceBundleInstallScope;
	allowSelectiveInstall: boolean;
	requiresExplicitUpgradeApproval: boolean;
	executionTrustBoundary: ResourceBundleExecutionBoundary;
	operatorReviewRequiredResourceTypes: ResourceBundleResourceType[];
	notes: string[];
};

export type ResourceBundleManifest = {
	schemaVersion: typeof RESOURCE_BUNDLE_SCHEMA_VERSION;
	bundleId: string;
	publisherNpub: Npub;
	displayName: string;
	summary: string;
	version: string;
	channel: string | null;
	createdAt: IsoDateString;
	updatedAt: IsoDateString;
	provenance: ResourceBundleProvenance;
	installPolicy: ResourceBundleInstallPolicy;
	resources: ResourceBundleResource[];
	notes: string[];
};

export type ResourceBundleInspection = {
	bundleId: string;
	displayName: string;
	publisherNpub: Npub;
	version: string;
	channel: string | null;
	resourceCount: number;
	resourceTypeCounts: Record<ResourceBundleResourceType, number>;
	trustClassCounts: Record<ResourceBundleTrustClass, number>;
	allowedScopes: ResourceBundleInstallScope[];
	defaultScope: ResourceBundleInstallScope;
	allowSelectiveInstall: boolean;
	requiresExplicitUpgradeApproval: boolean;
	executionTrustBoundary: ResourceBundleExecutionBoundary;
	defaultSelectedResourceIds: string[];
	executableResourceIds: string[];
	operatorReviewResourceIds: string[];
	payloadHashMatches: boolean;
	warnings: string[];
};

export type ResourceBundleSelectionPlan = {
	bundleId: string;
	scope: ResourceBundleInstallScope;
	selectedResourceIds: string[];
	selectedResources: Array<{
		resourceId: string;
		resourceType: ResourceBundleResourceType;
		entryRef: string;
		contentHash: string;
		trustClass: ResourceBundleTrustClass;
		executable: boolean;
		policyRequired: boolean;
		sandboxRequired: boolean;
	}>;
	blockedResources: Array<{
		resourceId: string;
		reason: string;
	}>;
	executionTrustBoundary: ResourceBundleExecutionBoundary;
	requiresExplicitUpgradeApproval: boolean;
	warnings: string[];
};

const RESOURCE_BUNDLE_ID_PATTERN = /^resource_bundle_[a-z0-9][a-z0-9_-]{2,127}$/;
const RESOURCE_ID_PATTERN = /^resource_[a-z0-9][a-z0-9._:-]{2,127}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;
const NPUB_PATTERN = /^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const SCHNORR_SIGNATURE_PATTERN = /^[0-9a-f]{128}$/i;

const RESOURCE_TYPE_SET = new Set<ResourceBundleResourceType>(RESOURCE_BUNDLE_RESOURCE_TYPES);
const INSTALL_SCOPE_SET = new Set<ResourceBundleInstallScope>(RESOURCE_BUNDLE_INSTALL_SCOPES);
const TRUST_CLASS_SET = new Set<ResourceBundleTrustClass>(RESOURCE_BUNDLE_TRUST_CLASSES);
const EXECUTION_BOUNDARY_SET = new Set<ResourceBundleExecutionBoundary>(RESOURCE_BUNDLE_EXECUTION_BOUNDARIES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const isIsoDateString = (value: unknown): value is IsoDateString =>
	isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

const validateStringArray = (value: unknown, fieldName: string, errors: string[]): string[] => {
	if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
		errors.push(`${fieldName} must be an array of non-empty strings`);
		return [];
	}
	return value.map((entry) => entry.trim());
};

const validateScopeArray = (
	value: unknown,
	fieldName: string,
	errors: string[]
): ResourceBundleInstallScope[] => {
	const parsed = validateStringArray(value, fieldName, errors);
	return parsed.filter((entry) => {
		if (!INSTALL_SCOPE_SET.has(entry as ResourceBundleInstallScope)) {
			errors.push(`${fieldName} contains unsupported scope ${entry}`);
			return false;
		}
		return true;
	}) as ResourceBundleInstallScope[];
};

const validateResourceTypeArray = (
	value: unknown,
	fieldName: string,
	errors: string[]
): ResourceBundleResourceType[] => {
	const parsed = validateStringArray(value, fieldName, errors);
	return parsed.filter((entry) => {
		if (!RESOURCE_TYPE_SET.has(entry as ResourceBundleResourceType)) {
			errors.push(`${fieldName} contains unsupported resource type ${entry}`);
			return false;
		}
		return true;
	}) as ResourceBundleResourceType[];
};

const buildCountRecord = <T extends string>(values: readonly T[]): Record<T, number> =>
	Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;

const canonicalizeJson = (value: unknown): string => {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalizeJson(entry)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`).join(",")}}`;
};

const expectedTrustClassForResourceType = (resourceType: ResourceBundleResourceType): ResourceBundleTrustClass => {
	switch (resourceType) {
		case "executable_skill":
			return "executable_untrusted";
		case "context_pack":
		case "prompt_pack":
			return "context_reviewed";
		case "operator_extension":
		case "ui_extension":
			return "extension_review_required";
		case "theme":
			return "presentation_only";
	}
};

export const canonicalizeResourceBundlePayload = (bundle: ResourceBundleManifest): string =>
	canonicalizeJson({
		schemaVersion: bundle.schemaVersion,
		bundleId: bundle.bundleId,
		publisherNpub: bundle.publisherNpub,
		displayName: bundle.displayName,
		summary: bundle.summary,
		version: bundle.version,
		channel: bundle.channel,
		createdAt: bundle.createdAt,
		updatedAt: bundle.updatedAt,
		provenance: {
			sourceUrl: bundle.provenance.sourceUrl,
			repositoryRef: bundle.provenance.repositoryRef,
			signedAt: bundle.provenance.signedAt,
			attestationRefs: bundle.provenance.attestationRefs,
		},
		installPolicy: bundle.installPolicy,
		resources: bundle.resources,
		notes: bundle.notes,
	});

export const computeResourceBundlePayloadHash = (bundle: ResourceBundleManifest): string =>
	`sha256:${createHash("sha256").update(canonicalizeResourceBundlePayload(bundle)).digest("hex")}`;

const validateExecutionPolicy = (
	value: unknown,
	resourceType: ResourceBundleResourceType | null,
	fieldName: string,
	errors: string[]
): void => {
	if (!isRecord(value)) {
		errors.push(`${fieldName} must be an object`);
		return;
	}
	if (typeof value.executable !== "boolean") {
		errors.push(`${fieldName}.executable must be a boolean`);
	}
	if (typeof value.policyRequired !== "boolean") {
		errors.push(`${fieldName}.policyRequired must be a boolean`);
	}
	if (typeof value.sandboxRequired !== "boolean") {
		errors.push(`${fieldName}.sandboxRequired must be a boolean`);
	}
	validateStringArray(value.requiredCapabilityRefs, `${fieldName}.requiredCapabilityRefs`, errors);
	validateStringArray(value.secretRefs, `${fieldName}.secretRefs`, errors);
	validateStringArray(value.networkEgress, `${fieldName}.networkEgress`, errors);

	if (resourceType === "executable_skill") {
		if (value.executable !== true) {
			errors.push(`${fieldName}.executable must be true for executable_skill resources`);
		}
		if (value.policyRequired !== true) {
			errors.push(`${fieldName}.policyRequired must be true for executable_skill resources`);
		}
		if (value.sandboxRequired !== true) {
			errors.push(`${fieldName}.sandboxRequired must be true for executable_skill resources`);
		}
		return;
	}

	if (value.executable === true) {
		errors.push(`${fieldName}.executable may be true only for executable_skill resources`);
	}
	if (value.sandboxRequired === true) {
		errors.push(`${fieldName}.sandboxRequired may be true only for executable_skill resources`);
	}
	const secretRefs = Array.isArray(value.secretRefs) ? value.secretRefs : [];
	if (secretRefs.length > 0) {
		errors.push(`${fieldName}.secretRefs must be empty for non-executable resources`);
	}
	const networkEgress = Array.isArray(value.networkEgress) ? value.networkEgress : [];
	if (networkEgress.length > 0) {
		errors.push(`${fieldName}.networkEgress must be empty for non-executable resources`);
	}
};

export const validateResourceBundleResource = (
	value: unknown,
	fieldName = "resource"
): string[] => {
	const errors: string[] = [];
	if (!isRecord(value)) {
		return [`${fieldName} must be an object`];
	}
	const resourceType = isNonEmptyString(value.resourceType)
		? (value.resourceType as ResourceBundleResourceType)
		: null;
	if (!isNonEmptyString(value.resourceId) || !RESOURCE_ID_PATTERN.test(value.resourceId)) {
		errors.push(`${fieldName}.resourceId must match /^resource_[a-z0-9][a-z0-9._:-]{2,127}$/`);
	}
	if (!resourceType || !RESOURCE_TYPE_SET.has(resourceType)) {
		errors.push(`${fieldName}.resourceType must be one of: ${RESOURCE_BUNDLE_RESOURCE_TYPES.join(", ")}`);
	}
	if (!isNonEmptyString(value.version) || !VERSION_PATTERN.test(value.version)) {
		errors.push(`${fieldName}.version must be a semantic version string`);
	}
	if (!isNonEmptyString(value.summary)) {
		errors.push(`${fieldName}.summary is required`);
	}
	if (!isNonEmptyString(value.entryRef)) {
		errors.push(`${fieldName}.entryRef is required`);
	}
	if (!isNonEmptyString(value.contentHash) || !SHA256_PATTERN.test(value.contentHash)) {
		errors.push(`${fieldName}.contentHash must be a sha256:<hex> digest`);
	}
	const installScopes = validateScopeArray(value.installScopes, `${fieldName}.installScopes`, errors);
	if (installScopes.length === 0) {
		errors.push(`${fieldName}.installScopes must contain at least one allowed scope`);
	}
	if (typeof value.selectedByDefault !== "boolean") {
		errors.push(`${fieldName}.selectedByDefault must be a boolean`);
	}
	if (!isNonEmptyString(value.trustClass) || !TRUST_CLASS_SET.has(value.trustClass as ResourceBundleTrustClass)) {
		errors.push(`${fieldName}.trustClass must be one of: ${RESOURCE_BUNDLE_TRUST_CLASSES.join(", ")}`);
	} else if (resourceType && expectedTrustClassForResourceType(resourceType) !== value.trustClass) {
		errors.push(
			`${fieldName}.trustClass must be ${expectedTrustClassForResourceType(resourceType)} for ${resourceType} resources`
		);
	}
	validateExecutionPolicy(value.executionPolicy, resourceType, `${fieldName}.executionPolicy`, errors);
	validateStringArray(value.tags, `${fieldName}.tags`, errors);
	validateStringArray(value.notes, `${fieldName}.notes`, errors);
	return errors;
};

export const validateResourceBundleManifest = (value: unknown): string[] => {
	const errors: string[] = [];
	if (!isRecord(value)) {
		return ["resourceBundle must be an object"];
	}
	if (value.schemaVersion !== RESOURCE_BUNDLE_SCHEMA_VERSION) {
		errors.push(`schemaVersion must be ${RESOURCE_BUNDLE_SCHEMA_VERSION}`);
	}
	if (!isNonEmptyString(value.bundleId) || !RESOURCE_BUNDLE_ID_PATTERN.test(value.bundleId)) {
		errors.push("bundleId must match /^resource_bundle_[a-z0-9][a-z0-9_-]{2,127}$/");
	}
	if (!isNonEmptyString(value.publisherNpub) || !NPUB_PATTERN.test(value.publisherNpub)) {
		errors.push("publisherNpub must be an npub identifier");
	}
	if (!isNonEmptyString(value.displayName)) {
		errors.push("displayName is required");
	}
	if (!isNonEmptyString(value.summary)) {
		errors.push("summary is required");
	}
	if (!isNonEmptyString(value.version) || !VERSION_PATTERN.test(value.version)) {
		errors.push("version must be a semantic version string");
	}
	if (value.channel !== null && value.channel !== undefined && !isNonEmptyString(value.channel)) {
		errors.push("channel must be a non-empty string or null");
	}
	if (!isIsoDateString(value.createdAt)) {
		errors.push("createdAt must be an ISO date string");
	}
	if (!isIsoDateString(value.updatedAt)) {
		errors.push("updatedAt must be an ISO date string");
	}

	if (!isRecord(value.provenance)) {
		errors.push("provenance must be an object");
	} else {
		if (value.provenance.sourceUrl !== null && value.provenance.sourceUrl !== undefined && !isNonEmptyString(value.provenance.sourceUrl)) {
			errors.push("provenance.sourceUrl must be a non-empty string or null");
		}
		if (
			value.provenance.repositoryRef !== null &&
			value.provenance.repositoryRef !== undefined &&
			!isNonEmptyString(value.provenance.repositoryRef)
		) {
			errors.push("provenance.repositoryRef must be a non-empty string or null");
		}
		if (!isNonEmptyString(value.provenance.payloadHash) || !SHA256_PATTERN.test(value.provenance.payloadHash)) {
			errors.push("provenance.payloadHash must be a sha256:<hex> digest");
		}
		if (!isIsoDateString(value.provenance.signedAt)) {
			errors.push("provenance.signedAt must be an ISO date string");
		}
		if (!isNonEmptyString(value.provenance.signature) || !SCHNORR_SIGNATURE_PATTERN.test(value.provenance.signature)) {
			errors.push("provenance.signature must be a 64-byte hex Schnorr signature");
		}
		validateStringArray(value.provenance.attestationRefs, "provenance.attestationRefs", errors);
	}

	if (!isRecord(value.installPolicy)) {
		errors.push("installPolicy must be an object");
	} else {
		const allowedScopes = validateScopeArray(value.installPolicy.allowedScopes, "installPolicy.allowedScopes", errors);
		if (allowedScopes.length === 0) {
			errors.push("installPolicy.allowedScopes must contain at least one scope");
		}
		if (
			!isNonEmptyString(value.installPolicy.defaultScope) ||
			!INSTALL_SCOPE_SET.has(value.installPolicy.defaultScope as ResourceBundleInstallScope)
		) {
			errors.push(`installPolicy.defaultScope must be one of: ${RESOURCE_BUNDLE_INSTALL_SCOPES.join(", ")}`);
		} else if (!allowedScopes.includes(value.installPolicy.defaultScope as ResourceBundleInstallScope)) {
			errors.push("installPolicy.defaultScope must appear in installPolicy.allowedScopes");
		}
		if (typeof value.installPolicy.allowSelectiveInstall !== "boolean") {
			errors.push("installPolicy.allowSelectiveInstall must be a boolean");
		}
		if (typeof value.installPolicy.requiresExplicitUpgradeApproval !== "boolean") {
			errors.push("installPolicy.requiresExplicitUpgradeApproval must be a boolean");
		}
		if (
			!isNonEmptyString(value.installPolicy.executionTrustBoundary) ||
			!EXECUTION_BOUNDARY_SET.has(value.installPolicy.executionTrustBoundary as ResourceBundleExecutionBoundary)
		) {
			errors.push(
				`installPolicy.executionTrustBoundary must be one of: ${RESOURCE_BUNDLE_EXECUTION_BOUNDARIES.join(", ")}`
			);
		}
		validateResourceTypeArray(
			value.installPolicy.operatorReviewRequiredResourceTypes,
			"installPolicy.operatorReviewRequiredResourceTypes",
			errors
		);
		validateStringArray(value.installPolicy.notes, "installPolicy.notes", errors);
	}

	if (!Array.isArray(value.resources) || value.resources.length === 0) {
		errors.push("resources must contain at least one bundle resource");
	} else {
		const seen = new Set<string>();
		for (let index = 0; index < value.resources.length; index += 1) {
			const resource = value.resources[index];
			errors.push(...validateResourceBundleResource(resource, `resources[${index}]`));
			if (isRecord(resource) && isNonEmptyString(resource.resourceId)) {
				if (seen.has(resource.resourceId)) {
					errors.push(`resources[${index}].resourceId duplicates ${resource.resourceId}`);
				}
				seen.add(resource.resourceId);
			}
		}
	}
	validateStringArray(value.notes, "notes", errors);

	if (errors.length === 0) {
		const bundle = value as ResourceBundleManifest;
		const allowedScopes = new Set(bundle.installPolicy.allowedScopes);
		for (const resource of bundle.resources) {
			for (const scope of resource.installScopes) {
				if (!allowedScopes.has(scope)) {
					errors.push(`resource ${resource.resourceId} includes install scope ${scope} outside installPolicy.allowedScopes`);
				}
			}
		}
		if (
			bundle.resources.some((resource) => resource.executionPolicy.executable) &&
			bundle.installPolicy.executionTrustBoundary !== "policy_gated"
		) {
			errors.push("installPolicy.executionTrustBoundary must be policy_gated when any resource is executable");
		}
		if (!bundle.installPolicy.allowSelectiveInstall && bundle.resources.some((resource) => !resource.selectedByDefault)) {
			errors.push("all resources must be selectedByDefault when installPolicy.allowSelectiveInstall is false");
		}
		const reviewRequiredTypes = new Set(bundle.installPolicy.operatorReviewRequiredResourceTypes);
		for (const resource of bundle.resources) {
			if (
				(resource.resourceType === "operator_extension" || resource.resourceType === "ui_extension") &&
				!reviewRequiredTypes.has(resource.resourceType)
			) {
				errors.push(
					`installPolicy.operatorReviewRequiredResourceTypes must include ${resource.resourceType} when that resource type is present`
				);
			}
		}
		const computedHash = computeResourceBundlePayloadHash(bundle);
		if (bundle.provenance.payloadHash !== computedHash) {
			errors.push("provenance.payloadHash does not match the canonical bundle payload");
		}
	}

	return errors;
};

export const inspectResourceBundleManifest = (bundle: ResourceBundleManifest): ResourceBundleInspection => {
	const resourceTypeCounts = buildCountRecord(RESOURCE_BUNDLE_RESOURCE_TYPES);
	const trustClassCounts = buildCountRecord(RESOURCE_BUNDLE_TRUST_CLASSES);
	const defaultSelectedResourceIds: string[] = [];
	const executableResourceIds: string[] = [];
	const operatorReviewResourceIds: string[] = [];

	for (const resource of bundle.resources) {
		resourceTypeCounts[resource.resourceType] += 1;
		trustClassCounts[resource.trustClass] += 1;
		if (resource.selectedByDefault) {
			defaultSelectedResourceIds.push(resource.resourceId);
		}
		if (resource.executionPolicy.executable) {
			executableResourceIds.push(resource.resourceId);
		}
		if (resource.trustClass === "extension_review_required") {
			operatorReviewResourceIds.push(resource.resourceId);
		}
	}

	const payloadHashMatches = bundle.provenance.payloadHash === computeResourceBundlePayloadHash(bundle);
	const warnings: string[] = [];
	if (!payloadHashMatches) {
		warnings.push("Canonical payload hash does not match the stored provenance payload hash.");
	}
	if (executableResourceIds.length > 0) {
		warnings.push("Executable resources remain install-only until separate policy and sandbox approval occurs.");
	}
	if (operatorReviewResourceIds.length > 0) {
		warnings.push("Operator or UI extensions require explicit review before activation.");
	}
	if (bundle.installPolicy.allowSelectiveInstall && defaultSelectedResourceIds.length === 0) {
		warnings.push("Selective install is enabled, but no resources are selected by default.");
	}
	for (const resource of bundle.resources) {
		if (resource.selectedByDefault && !resource.installScopes.includes(bundle.installPolicy.defaultScope)) {
			warnings.push(
				`Resource ${resource.resourceId} is selectedByDefault but does not support the bundle default scope ${bundle.installPolicy.defaultScope}.`
			);
		}
	}

	return {
		bundleId: bundle.bundleId,
		displayName: bundle.displayName,
		publisherNpub: bundle.publisherNpub,
		version: bundle.version,
		channel: bundle.channel,
		resourceCount: bundle.resources.length,
		resourceTypeCounts,
		trustClassCounts,
		allowedScopes: [...bundle.installPolicy.allowedScopes],
		defaultScope: bundle.installPolicy.defaultScope,
		allowSelectiveInstall: bundle.installPolicy.allowSelectiveInstall,
		requiresExplicitUpgradeApproval: bundle.installPolicy.requiresExplicitUpgradeApproval,
		executionTrustBoundary: bundle.installPolicy.executionTrustBoundary,
		defaultSelectedResourceIds,
		executableResourceIds,
		operatorReviewResourceIds,
		payloadHashMatches,
		warnings,
	};
};

export const resolveResourceBundleSelection = (
	bundle: ResourceBundleManifest,
	input: {
		scope: ResourceBundleInstallScope;
		resourceIds?: string[];
	}
): ResourceBundleSelectionPlan => {
	const errors = validateResourceBundleManifest(bundle);
	if (errors.length > 0) {
		throw new Error(errors.join("\n"));
	}
	if (!INSTALL_SCOPE_SET.has(input.scope)) {
		throw new Error(`scope must be one of: ${RESOURCE_BUNDLE_INSTALL_SCOPES.join(", ")}`);
	}
	if (!bundle.installPolicy.allowedScopes.includes(input.scope)) {
		throw new Error(`bundle does not allow installs for scope ${input.scope}`);
	}

	const availableResources = bundle.resources.filter((resource) => resource.installScopes.includes(input.scope));
	const blockedResources = bundle.resources
		.filter((resource) => !resource.installScopes.includes(input.scope))
		.map((resource) => ({
			resourceId: resource.resourceId,
			reason: `resource is not installable in ${input.scope} scope`,
		}));

	let selectedResources: ResourceBundleResource[];
	const requestedIds = input.resourceIds?.filter((resourceId) => resourceId.trim().length > 0) ?? [];
	if (requestedIds.length > 0) {
		if (!bundle.installPolicy.allowSelectiveInstall) {
			throw new Error("bundle does not allow filtered resource selection");
		}
		selectedResources = requestedIds.map((resourceId) => {
			const match = bundle.resources.find((resource) => resource.resourceId === resourceId);
			if (!match) {
				throw new Error(`unknown resourceId ${resourceId}`);
			}
			if (!match.installScopes.includes(input.scope)) {
				throw new Error(`resource ${resourceId} is not installable in ${input.scope} scope`);
			}
			return match;
		});
	} else if (bundle.installPolicy.allowSelectiveInstall) {
		selectedResources = availableResources.filter((resource) => resource.selectedByDefault);
	} else {
		selectedResources = availableResources;
	}

	const warnings: string[] = [];
	if (selectedResources.length === 0) {
		warnings.push("No resources were selected for the requested scope.");
	}
	if (selectedResources.some((resource) => resource.executionPolicy.executable)) {
		warnings.push("Selected resources include executable content; installation does not grant execution permission.");
	}
	if (selectedResources.some((resource) => resource.trustClass === "extension_review_required")) {
		warnings.push("Selected resources include extensions that require explicit operator review before activation.");
	}

	return {
		bundleId: bundle.bundleId,
		scope: input.scope,
		selectedResourceIds: selectedResources.map((resource) => resource.resourceId),
		selectedResources: selectedResources.map((resource) => ({
			resourceId: resource.resourceId,
			resourceType: resource.resourceType,
			entryRef: resource.entryRef,
			contentHash: resource.contentHash,
			trustClass: resource.trustClass,
			executable: resource.executionPolicy.executable,
			policyRequired: resource.executionPolicy.policyRequired,
			sandboxRequired: resource.executionPolicy.sandboxRequired,
		})),
		blockedResources,
		executionTrustBoundary: bundle.installPolicy.executionTrustBoundary,
		requiresExplicitUpgradeApproval: bundle.installPolicy.requiresExplicitUpgradeApproval,
		warnings,
	};
};

const EXAMPLE_PUBLISHER_NPUB =
	"npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

const buildExampleBundle = (): ResourceBundleManifest => {
	const draft: ResourceBundleManifest = {
		schemaVersion: RESOURCE_BUNDLE_SCHEMA_VERSION,
		bundleId: "resource_bundle_onlybots_ops_review_pack",
		publisherNpub: EXAMPLE_PUBLISHER_NPUB,
		displayName: "Crosshead Ops Review Pack",
		summary:
			"Signed bundle that groups a reviewed context pack, a prompt pack, and a policy-gated executable audit helper without collapsing install trust into execution trust.",
		version: "1.2.0",
		channel: "stable",
		createdAt: "2026-04-23T12:00:00Z",
		updatedAt: "2026-04-23T12:30:00Z",
		provenance: {
			sourceUrl: "https://onlybots.ai/bundles/ops-review-pack-1.2.0.tgz",
			repositoryRef: "repo:onlybots/bundles/ops-review-pack",
			payloadHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
			signedAt: "2026-04-23T12:31:00Z",
			signature: "a".repeat(128),
			attestationRefs: ["trust_receipt_ops_review_bundle_publish_1"],
		},
		installPolicy: {
			allowedScopes: ["project", "tenant", "session"],
			defaultScope: "project",
			allowSelectiveInstall: true,
			requiresExplicitUpgradeApproval: true,
			executionTrustBoundary: "policy_gated",
			operatorReviewRequiredResourceTypes: ["operator_extension", "ui_extension"],
			notes: [
				"Install trust is separate from execution trust.",
				"Executable resources remain policy-gated and sandboxed after installation.",
			],
		},
		resources: [
			{
				resourceId: "resource_context_delivery_review",
				resourceType: "context_pack",
				version: "1.2.0",
				summary: "Workspace-scoped delivery review context for governance and release checks.",
				entryRef: "context/delivery-review/AGENTS.md",
				contentHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
				installScopes: ["project", "tenant", "session"],
				selectedByDefault: true,
				trustClass: "context_reviewed",
				executionPolicy: {
					executable: false,
					policyRequired: false,
					sandboxRequired: false,
					requiredCapabilityRefs: [],
					secretRefs: [],
					networkEgress: [],
				},
				tags: ["review", "release", "context"],
				notes: ["Reviewed prompt/context resources are installable without granting executable authority."],
			},
			{
				resourceId: "resource_prompt_release_summary",
				resourceType: "prompt_pack",
				version: "1.2.0",
				summary: "Prompt fragments for structured release summaries and operator verification checklists.",
				entryRef: "prompts/release-summary/system.md",
				contentHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
				installScopes: ["project", "tenant", "session"],
				selectedByDefault: true,
				trustClass: "context_reviewed",
				executionPolicy: {
					executable: false,
					policyRequired: false,
					sandboxRequired: false,
					requiredCapabilityRefs: [],
					secretRefs: [],
					networkEgress: [],
				},
				tags: ["prompt", "release"],
				notes: ["Prompt packs remain data resources, not code execution grants."],
			},
			{
				resourceId: "resource_skill_handoff_audit",
				resourceType: "executable_skill",
				version: "1.2.0",
				summary: "Detached executable skill for handoff audit generation that still requires policy approval and sandbox enforcement.",
				entryRef: "skills/handoff-audit/entry.js",
				contentHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
				installScopes: ["tenant", "session"],
				selectedByDefault: false,
				trustClass: "executable_untrusted",
				executionPolicy: {
					executable: true,
					policyRequired: true,
					sandboxRequired: true,
					requiredCapabilityRefs: ["skills.execute", "memory:read"],
					secretRefs: [],
					networkEgress: ["none"],
				},
				tags: ["skill", "audit", "handoff"],
				notes: ["Installing the skill does not authorize execution without a separate policy gate."],
			},
		],
		notes: [
			"Resource bundles package provenance and install-scope policy together.",
			"They do not imply unrestricted execution trust for executable resources.",
		],
	};

	return {
		...draft,
		provenance: {
			...draft.provenance,
			payloadHash: computeResourceBundlePayloadHash(draft),
		},
	};
};

export const resourceBundleExample: ResourceBundleManifest = buildExampleBundle();
