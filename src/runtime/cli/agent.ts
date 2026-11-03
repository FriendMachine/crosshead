import path from "path";
import { AGENT_PASSPORT_SCHEMA_VERSION, AgentPassport, PASSPORT_RUNTIME_HOSTS, PASSPORT_TRUST_ZONE_IDS, PassportRuntimeHost, PassportTrustZoneId, buildDraftAgentPassport, validateAgentPassport } from "../../protocol/passports";
import { nowIso } from "../adapter-utils";
import { buildAgentIdentityAttestation, readAgentIdentityAttestation, writeAgentIdentityAttestation } from "../agent-identity-attestation";
import { signOrganizationAttachmentChallenge } from "../agent-organization-attachment";
import { OnlyBotsLocalRuntimeDaemon, parseArgs, parseJsonFlag } from "../local-runtime";
import { compilePassport, explainPassportRouting, formatPassportCompileResult, formatPassportImportResult, formatPassportRoutingExplanation, formatPassportVerifyResult, importPassportFromHost, verifyPassportCompilation } from "../passport-compiler";
import { PersistentAgentInspection, PersistentAgentLineageInspection } from "../persistent-agent-fork";
import { normalizePersistentAgentId } from "../persistent-agent-utils";
import { ONLYBOTS_RUNTIME_CORE_VERSION, ensureRuntimeHomeLayout, loadContinuityPolicyState, loadPersistentAgentEntity, loadProfile, loadRuntimeConfig, writeJsonFile } from "../runtime-persistence";
import { existsSync, readFileSync } from "fs";

const normalizePassportTrustZones = (raw: string | undefined): PassportTrustZoneId[] => {
	if (!raw) {
		return [...PASSPORT_TRUST_ZONE_IDS];
	}
	const zones = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry): entry is PassportTrustZoneId => PASSPORT_TRUST_ZONE_IDS.includes(entry as PassportTrustZoneId));
	return zones.length > 0 ? zones : [...PASSPORT_TRUST_ZONE_IDS];
};

const normalizePassportHosts = (raw: string | undefined): PassportRuntimeHost[] => {
	if (!raw) {
		return [...PASSPORT_RUNTIME_HOSTS];
	}
	const hosts = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry): entry is PassportRuntimeHost => PASSPORT_RUNTIME_HOSTS.includes(entry as PassportRuntimeHost));
	return hosts.length > 0 ? hosts : [...PASSPORT_RUNTIME_HOSTS];
};

const filterPassportDraft = (
	passport: AgentPassport,
	selectedTrustZones: PassportTrustZoneId[],
	selectedHosts: PassportRuntimeHost[]
): AgentPassport => ({
	...passport,
	memoryScope: {
		...passport.memoryScope,
		allowedTrustZones: passport.memoryScope.allowedTrustZones.filter((zone) => selectedTrustZones.includes(zone)),
	},
	trustZones: passport.trustZones.filter((zone) => selectedTrustZones.includes(zone.trustZoneId)),
	enforcement: {
		...passport.enforcement,
		compilationTargets: passport.enforcement.compilationTargets
			.filter((target) => selectedHosts.includes(target.targetHost))
			.map((target) => ({
				...target,
				defaultTrustZone: selectedTrustZones.includes(target.defaultTrustZone) ? target.defaultTrustZone : selectedTrustZones[0],
				trustZonePolicies: target.trustZonePolicies.filter((policy) => selectedTrustZones.includes(policy.trustZoneId)),
			})),
	},
});

const formatPassportSummary = (passport: AgentPassport): string =>
	[
		`passport_version: ${passport.passportVersion}`,
		`passport_id: ${passport.passportId}`,
		`agent: ${passport.agentRef.agentId} (${passport.agentRef.npub})`,
		`display_name: ${passport.identity.displayName}`,
		`continuity_policy_ref: ${passport.continuityPolicyRef ?? "none"}`,
		`trust_zones: ${passport.trustZones.map((entry) => entry.trustZoneId).join(", ")}`,
		`targets: ${passport.enforcement.compilationTargets.map((entry) => entry.targetHost).join(", ")}`,
		`required_compiled_fields: ${passport.provenance.requiredCompiledFields.join(", ")}`,
	].join("\n");

const resolvePassportTrustZoneFlag = (flags: Record<string, string | boolean>): PassportTrustZoneId | null => {
	const raw =
		typeof flags["trust-zone"] === "string"
			? flags["trust-zone"]
			: typeof flags.trustZone === "string"
				? flags.trustZone
				: undefined;
	if (!raw) {
		return null;
	}
	if (!PASSPORT_TRUST_ZONE_IDS.includes(raw as PassportTrustZoneId)) {
		throw new Error(`passport trust zone must be one of: ${PASSPORT_TRUST_ZONE_IDS.join(", ")}`);
	}
	return raw as PassportTrustZoneId;
};

const resolvePassportImportSourceFlag = (flags: Record<string, string | boolean>): "codex" | "claude-code" => {
	const raw = typeof flags.from === "string" ? flags.from : undefined;
	if (!raw) {
		throw new Error("passport from requires --from codex|claude-code");
	}
	if (raw !== "codex" && raw !== "claude-code") {
		throw new Error("passport from currently supports only codex or claude-code");
	}
	return raw;
};

const resolvePassportTargetHostFlag = (flags: Record<string, string | boolean>): PassportRuntimeHost => {
	const raw = typeof flags.target === "string" ? flags.target : undefined;
	if (!raw) {
		throw new Error(`passport target requires --target ${PASSPORT_RUNTIME_HOSTS.join("|")}`);
	}
	if (!PASSPORT_RUNTIME_HOSTS.includes(raw as PassportRuntimeHost)) {
		throw new Error(`passport target currently supports only ${PASSPORT_RUNTIME_HOSTS.join(", ")}`);
	}
	return raw as PassportRuntimeHost;
};

const resolvePassportInputPath = (flags: Record<string, string | boolean>): string =>
	path.resolve(
		typeof flags["passport-file"] === "string"
			? flags["passport-file"]
			: typeof flags.passportFile === "string"
				? flags.passportFile
				: typeof flags.file === "string"
					? flags.file
					: path.join(process.cwd(), "onlybots.passport.json")
	);

const loadPassportDocument = (filePath: string): AgentPassport => {
	if (!existsSync(filePath)) {
		throw new Error(`passport file not found: ${filePath}`);
	}
	const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
	const validationErrors = validateAgentPassport(parsed);
	if (validationErrors.length > 0) {
		throw new Error(`passport file is invalid:\n${validationErrors.join("\n")}`);
	}
	return parsed as AgentPassport;
};

const formatPersistentAgentInspection = (inspection: PersistentAgentInspection): string => {
	const lines = [
		`agent_id: ${inspection.agent.agentRef.agentId}`,
		`npub: ${inspection.agent.agentRef.npub}`,
		`lineage_root: ${inspection.agent.agentRef.lineageRoot}`,
		`status: ${inspection.agent.status}`,
		`policy_ref: ${inspection.agent.policyRef ?? "none"}`,
		`self_model_ref: ${inspection.agent.selfModelRef ?? "none"}`,
		`passport_ref: ${inspection.agent.passportRef ?? "none"}`,
		`project_model_refs: ${inspection.agent.projectModelRefs.join(", ") || "none"}`,
		`runtime_attachments: ${inspection.agent.currentRuntimeAttachments.length}`,
		`engine_attachment: ${inspection.agent.currentEngineAttachment?.runtimeHost ?? "none"}`,
		`engine_attachment_history: ${inspection.agent.engineAttachmentHistory.length}`,
		`engine_portability: ${inspection.enginePortability.stability}`,
		`engine_portability_summary: ${inspection.enginePortability.summary}`,
	];
	if (inspection.profile) {
		lines.push(`profile: ${inspection.profile.name}`);
		lines.push(`api_base: ${inspection.profile.apiBase}`);
		lines.push(`memory_mode: ${inspection.profile.memoryMode}`);
		lines.push(`workspace_scope: ${inspection.profile.workspaceScope}`);
	}
	if (inspection.lineage.parentLink) {
		lines.push(`parent_agent: ${inspection.lineage.parentLink.parentAgentId}`);
		lines.push(`lineage_link: ${inspection.lineage.parentLink.linkId}`);
	} else {
		lines.push("parent_agent: none");
	}
	lines.push(`children: ${inspection.lineage.childLinks.map((link) => link.childAgentId).join(", ") || "none"}`);
	lines.push(
		`lineage_signatures: link=${inspection.lineage.signatureVerification.lineageLinkValid === null ? "n/a" : inspection.lineage.signatureVerification.lineageLinkValid ? "valid" : "invalid"} boundary=${inspection.lineage.signatureVerification.inheritanceBoundaryValid === null ? "n/a" : inspection.lineage.signatureVerification.inheritanceBoundaryValid ? "valid" : "invalid"}`
	);
	lines.push(
		`divergence: separate_identity=${inspection.lineage.divergence.separateIdentity ? "yes" : "no"} runtime_reset=${inspection.lineage.divergence.runtimeAttachmentsReset ? "yes" : "no"} engine_reset=${inspection.lineage.divergence.engineAttachmentReset ? "yes" : "no"}`
	);
	if (inspection.lineage.divergence.inheritedRefs.length > 0) {
		lines.push(`inherited_refs: ${inspection.lineage.divergence.inheritedRefs.join(", ")}`);
	}
	if (inspection.lineage.divergence.excludedRefs.length > 0) {
		lines.push(`excluded_refs: ${inspection.lineage.divergence.excludedRefs.join(", ")}`);
	}
	if (inspection.agent.notes.length > 0) {
		lines.push(...inspection.agent.notes.map((note) => `note: ${note}`));
	}
	if (inspection.enginePortability.reasons.length > 0) {
		lines.push(...inspection.enginePortability.reasons.map((reason: string) => `engine_reason: ${reason}`));
	}
	if (inspection.enginePortability.compensationHints.length > 0) {
		lines.push(...inspection.enginePortability.compensationHints.map((hint: string) => `engine_hint: ${hint}`));
	}
	return lines.join("\n");
};

const flattenLineageTree = (tree: PersistentAgentLineageInspection["tree"], depth = 0): string[] => {
	const prefix = "  ".repeat(depth);
	const lines = [`${prefix}${tree.agentId} (${tree.npub})`];
	for (const child of tree.children) {
		lines.push(...flattenLineageTree(child, depth + 1));
	}
	return lines;
};

const formatPersistentAgentLineageInspection = (inspection: PersistentAgentLineageInspection): string => {
	const lines = [
		`requested_agent_id: ${inspection.requestedAgentId}`,
		`root_agent_id: ${inspection.rootAgentId}`,
		`ancestors: ${inspection.ancestors.map((entry) => entry.agentId).join(" -> ") || "none"}`,
		`parent_link: ${inspection.parentLink?.linkId ?? "none"}`,
		`child_links: ${inspection.childLinks.map((entry) => entry.linkId).join(", ") || "none"}`,
		`lineage_signature_valid: ${inspection.signatureVerification.lineageLinkValid === null ? "n/a" : inspection.signatureVerification.lineageLinkValid ? "yes" : "no"}`,
		`boundary_signature_valid: ${inspection.signatureVerification.inheritanceBoundaryValid === null ? "n/a" : inspection.signatureVerification.inheritanceBoundaryValid ? "yes" : "no"}`,
		`inherited_refs: ${inspection.divergence.inheritedRefs.join(", ") || "none"}`,
		`excluded_refs: ${inspection.divergence.excludedRefs.join(", ") || "none"}`,
		`runtime_attachments_reset: ${inspection.divergence.runtimeAttachmentsReset ? "yes" : "no"}`,
		`engine_attachment_reset: ${inspection.divergence.engineAttachmentReset ? "yes" : "no"}`,
		"tree:",
		...flattenLineageTree(inspection.tree),
	];
	return lines.join("\n");
};

export const agentFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];
	const profileName =
		typeof flags.profile === "string"
			? flags.profile
			: typeof flags["profile-name"] === "string"
				? flags["profile-name"]
				: undefined;
	const agentId =
		typeof flags["agent-id"] === "string"
			? flags["agent-id"]
			: typeof flags.agentId === "string"
				? flags.agentId
		: undefined;

	if (subcommand === "show") {
		const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
		const inspection = await daemon.inspectPersistentAgent(agentId, profileName);
		return flags.json ? JSON.stringify(inspection, null, 2) : formatPersistentAgentInspection(inspection);
	}
	if (subcommand === "attest-identity") {
		const home = typeof flags.home === "string" ? flags.home : undefined;
		const output = typeof flags.output === "string" ? flags.output : undefined;
		if (!home || !profileName || !output) {
			throw new Error("agent attest-identity requires --home <path>, --profile <name>, and --output <new-absolute-private-file>");
		}
		const built = await buildAgentIdentityAttestation({
			home,
			profileName,
		});
		writeAgentIdentityAttestation(output, built.bytes);
		return flags.json
			? JSON.stringify(
					{
						wrote: true,
						evidenceRef: built.evidenceRef,
						evidenceDigest: built.evidenceDigest,
						agentId: built.attestation.subject.agentId,
						npub: built.attestation.subject.npub,
						authority: "none",
					},
					null,
					2,
				)
			: `Wrote local-only identity evidence for ${built.attestation.subject.agentId}; authority=none`;
	}
	if (subcommand === "verify-identity") {
		const input = typeof flags.input === "string" ? flags.input : undefined;
		if (!input) throw new Error("agent verify-identity requires --input <absolute-evidence-file>");
		const verified = await readAgentIdentityAttestation(input);
		return flags.json
			? JSON.stringify(
					{
						valid: true,
						evidenceRef: verified.evidenceRef,
						evidenceDigest: verified.evidenceDigest,
						agentId: verified.attestation.subject.agentId,
						npub: verified.attestation.subject.npub,
						authority: "none",
					},
					null,
					2,
				)
			: `Verified local-only identity evidence for ${verified.attestation.subject.agentId}; authority=none`;
	}
	if (subcommand === "issue-federation-binding") {
		throw new Error("agent issue-federation-binding is an operator tool and is not included in the Crosshead runtime");
	}
	if (subcommand === "request-report-decision") {
		throw new Error("agent request-report-decision is an operator tool and is not included in the Crosshead runtime");
	}
	if (subcommand === "sign-organization-attachment") {
		const home = typeof flags.home === "string" ? flags.home : undefined;
		const challenge = typeof flags.challenge === "string" ? flags.challenge : undefined;
		if (!home || !profileName || !challenge) {
			throw new Error("agent sign-organization-attachment requires --home <path>, --profile <name>, and --challenge <onlybots_org_attach_v1:...>");
		}
		const signed = await signOrganizationAttachmentChallenge({ home, profileName, challenge });
		return flags.json
			? JSON.stringify(signed, null, 2)
			: [
				`Organization: ${signed.organizationId}`,
				`Agent: ${signed.agentId} (${signed.npub})`,
				`Challenge digest: ${signed.challengeDigest}`,
				`Signature: ${signed.signature}`,
			].join("\n");
	}
	if (subcommand === "set-engine") {
		const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
		const runtimeHost =
			typeof flags["runtime-host"] === "string"
				? flags["runtime-host"]
				: typeof flags.runtimeHost === "string"
					? flags.runtimeHost
					: undefined;
		const inspection = await daemon.setPersistentAgentEngineAttachment({
			agentId,
			profileName,
			runtimeHost,
			provider: typeof flags.provider === "string" ? flags.provider : undefined,
			modelFamily:
				typeof flags["model-family"] === "string"
					? flags["model-family"]
					: typeof flags.modelFamily === "string"
						? flags.modelFamily
						: undefined,
			modelId:
				typeof flags["model-id"] === "string"
					? flags["model-id"]
					: typeof flags.modelId === "string"
						? flags.modelId
						: undefined,
			hostVersion:
				typeof flags["host-version"] === "string"
					? flags["host-version"]
					: typeof flags.hostVersion === "string"
						? flags.hostVersion
						: undefined,
			promptTransport:
				typeof flags["prompt-transport"] === "string"
					? flags["prompt-transport"]
					: typeof flags.promptTransport === "string"
						? flags.promptTransport
						: undefined,
			portabilityNotes: parseJsonFlag(flags["portability-notes-json"]) as string[] | undefined,
			continuityFidelityNotes: parseJsonFlag(flags["fidelity-notes-json"]) as string[] | undefined,
			compensationHints: parseJsonFlag(flags["compensation-hints-json"]) as string[] | undefined,
			reason: typeof flags.reason === "string" ? flags.reason : undefined,
		});
		return flags.json ? JSON.stringify(inspection, null, 2) : formatPersistentAgentInspection(inspection);
	}
	if (subcommand === "fork") {
		const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
		const result = await daemon.forkPersistentAgentIdentity({
			...flags,
			profileName,
		});
		return flags.json
			? JSON.stringify(result, null, 2)
			: [
					`Forked ${String(result["childAgentId"])} from ${String((result["lineageLink"] as Record<string, unknown>).parentAgentId)}`,
					`child_profile: ${String(result["childProfile"])}`,
					`child_npub: ${String(result["childNpub"])}`,
					`lineage_link: ${String((result["lineageLink"] as Record<string, unknown>).linkId)}`,
					`inheritance_boundary: ${String((result["inheritanceBoundary"] as Record<string, unknown>).boundaryId)}`,
				].join("\n");
	}

	throw new Error("agent requires one of: show, attest-identity, verify-identity, request-report-decision, sign-organization-attachment, set-engine, fork");
};

export const lineageFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];
	if (subcommand !== "show") {
		throw new Error("lineage requires: show");
	}
	const daemon = new OnlyBotsLocalRuntimeDaemon(typeof flags.home === "string" ? flags.home : undefined);
	const profileName =
		typeof flags.profile === "string"
			? flags.profile
			: typeof flags["profile-name"] === "string"
				? flags["profile-name"]
				: undefined;
	const agentId =
		typeof flags["agent-id"] === "string"
			? flags["agent-id"]
			: typeof flags.agentId === "string"
				? flags.agentId
				: undefined;
	const inspection = await daemon.inspectPersistentAgentLineage(agentId, profileName);
	return flags.json ? JSON.stringify(inspection, null, 2) : formatPersistentAgentLineageInspection(inspection);
};

export const passportFromCli = async (argv: string[]): Promise<string> => {
	const { positionals, flags } = parseArgs(argv);
	const subcommand = positionals[0];
	const home = typeof flags.home === "string" ? flags.home : undefined;
	const paths = ensureRuntimeHomeLayout(home);
	const config = loadRuntimeConfig(paths);
	const requestedProfile =
		typeof flags.profile === "string" ? flags.profile : config.defaultProfile ?? "default";
	const profile = loadProfile(paths, requestedProfile);

	if (subcommand === "init") {
		const selectedTrustZones = normalizePassportTrustZones(
			typeof flags["trust-zones"] === "string"
				? flags["trust-zones"]
				: typeof flags.trustZones === "string"
					? flags.trustZones
					: typeof flags["trust-zone"] === "string"
						? flags["trust-zone"]
						: typeof flags.trustZone === "string"
							? flags.trustZone
							: undefined
		);
		const selectedHosts = normalizePassportHosts(
			typeof flags.targets === "string"
				? flags.targets
				: typeof flags.hosts === "string"
					? flags.hosts
					: typeof flags.target === "string"
						? flags.target
						: undefined
		);
		const explicitNpub =
			typeof flags.npub === "string"
				? flags.npub
				: profile?.npub ?? "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqw0x2r";
		const agentId = normalizePersistentAgentId(
			typeof flags["agent-id"] === "string"
				? flags["agent-id"]
				: typeof flags.agentId === "string"
					? flags.agentId
					: requestedProfile
		);
		const lineageRoot = normalizePersistentAgentId(
			typeof flags["lineage-root"] === "string"
				? flags["lineage-root"]
				: typeof flags.lineageRoot === "string"
					? flags.lineageRoot
					: agentId
		);
		const workspaceId =
			typeof flags["workspace-id"] === "string"
				? flags["workspace-id"]
				: typeof flags.workspaceId === "string"
					? flags.workspaceId
					: `repo:${path.basename(process.cwd())}`;
		const continuityPolicyState = loadContinuityPolicyState(paths);
		const existingAgentEntity =
			profile?.agentId ? loadPersistentAgentEntity(paths, profile.agentId) : requestedProfile ? loadPersistentAgentEntity(paths, agentId) : null;
		const draft = filterPassportDraft(
			buildDraftAgentPassport({
				agentRef: {
					agentId,
					npub: explicitNpub,
					lineageRoot,
				},
				displayName:
					typeof flags["display-name"] === "string"
						? flags["display-name"]
						: typeof flags.displayName === "string"
							? flags.displayName
							: `Crosshead ${requestedProfile} agent`,
				continuityPolicyRef: continuityPolicyState.policy.policyId,
				compilerVersion: ONLYBOTS_RUNTIME_CORE_VERSION,
				currentEngineAttachmentRef:
					typeof flags["engine-attachment-ref"] === "string"
						? flags["engine-attachment-ref"]
						: typeof flags.engineAttachmentRef === "string"
							? flags.engineAttachmentRef
							: existingAgentEntity?.currentEngineAttachment?.attachmentId ?? null,
				allowedWorkspaces: [workspaceId],
				createdAt: nowIso(),
			}),
			selectedTrustZones,
			selectedHosts
		);
		const validationErrors = validateAgentPassport(draft);
		if (validationErrors.length > 0) {
			throw new Error(`passport init produced an invalid draft:\n${validationErrors.join("\n")}`);
		}
		const outputPath =
			typeof flags.file === "string"
				? flags.file
				: typeof flags.output === "string"
					? flags.output
					: undefined;
		if (outputPath) {
			writeJsonFile(path.resolve(outputPath), draft);
			return flags.json
				? JSON.stringify(
						{
							wrote: true,
							file: path.resolve(outputPath),
							passportId: draft.passportId,
							passportVersion: AGENT_PASSPORT_SCHEMA_VERSION,
						},
						null,
						2
					)
				: `Wrote passport scaffold to ${path.resolve(outputPath)}`;
		}
		return flags.json ? JSON.stringify(draft, null, 2) : formatPassportSummary(draft);
	}

	if (subcommand === "import") {
		const sourceHost = resolvePassportImportSourceFlag(flags);
		const trustZoneId = resolvePassportTrustZoneFlag(flags);
		const workspaceRoot =
			typeof flags["workspace-root"] === "string"
				? flags["workspace-root"]
				: typeof flags.workspaceRoot === "string"
					? flags.workspaceRoot
					: process.cwd();
		const explicitNpub =
			typeof flags.npub === "string"
				? flags.npub
				: profile?.npub ?? "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqw0x2r";
		const agentId = normalizePersistentAgentId(
			typeof flags["agent-id"] === "string"
				? flags["agent-id"]
				: typeof flags.agentId === "string"
					? flags.agentId
					: requestedProfile
		);
		const continuityPolicyState = loadContinuityPolicyState(paths);
		const basePassport = buildDraftAgentPassport({
			agentRef: {
				agentId,
				npub: explicitNpub,
				lineageRoot:
					typeof flags["lineage-root"] === "string"
						? normalizePersistentAgentId(flags["lineage-root"])
						: typeof flags.lineageRoot === "string"
							? normalizePersistentAgentId(flags.lineageRoot)
							: agentId,
			},
			displayName:
				typeof flags["display-name"] === "string"
					? flags["display-name"]
					: typeof flags.displayName === "string"
						? flags.displayName
						: `Crosshead ${requestedProfile} agent`,
			continuityPolicyRef: continuityPolicyState.policy.policyId,
			compilerVersion: ONLYBOTS_RUNTIME_CORE_VERSION,
			currentEngineAttachmentRef: null,
			allowedWorkspaces: [
				typeof flags["workspace-id"] === "string"
					? flags["workspace-id"]
					: typeof flags.workspaceId === "string"
						? flags.workspaceId
						: `repo:${path.basename(path.resolve(workspaceRoot))}`,
			],
			createdAt: nowIso(),
		});
		const imported = importPassportFromHost({
			basePassport,
			sourceHost,
			workspaceRoot,
			trustZoneId,
			codexHome:
				typeof flags["codex-home"] === "string"
					? flags["codex-home"]
					: typeof flags.codexHome === "string"
						? flags.codexHome
						: undefined,
			claudeHome:
				typeof flags["claude-home"] === "string"
					? flags["claude-home"]
					: typeof flags.claudeHome === "string"
						? flags.claudeHome
						: undefined,
		});
		const validationErrors = validateAgentPassport(imported.passport);
		if (validationErrors.length > 0) {
			throw new Error(`passport import produced an invalid draft:\n${validationErrors.join("\n")}`);
		}
		const outputPath =
			typeof flags.output === "string"
				? flags.output
				: typeof flags.file === "string"
					? flags.file
					: undefined;
		if (outputPath) {
			writeJsonFile(path.resolve(outputPath), imported.passport);
			return flags.json
				? JSON.stringify(
						{
							wrote: true,
							file: path.resolve(outputPath),
							sourceHost: imported.sourceHost,
							trustZoneId: imported.trustZoneId,
							passport: imported.passport,
							discoveredFiles: imported.discoveredFiles,
							notes: imported.notes,
							warnings: imported.warnings,
						},
						null,
						2
					)
				: `Wrote imported passport draft to ${path.resolve(outputPath)}`;
		}
		return flags.json
			? JSON.stringify(imported, null, 2)
			: formatPassportImportResult(imported);
	}

	if (subcommand === "compile" || subcommand === "diff" || subcommand === "verify" || subcommand === "explain-routing") {
		const passportPath = resolvePassportInputPath(flags);
		const passport = loadPassportDocument(passportPath);
		const workspaceRoot =
			typeof flags["workspace-root"] === "string"
				? flags["workspace-root"]
				: typeof flags.workspaceRoot === "string"
					? flags.workspaceRoot
					: process.cwd();
		const trustZoneId = resolvePassportTrustZoneFlag(flags);

		if (subcommand === "explain-routing") {
			const explanation = explainPassportRouting(passport);
			return flags.json ? JSON.stringify(explanation, null, 2) : formatPassportRoutingExplanation(explanation);
		}

		const targetHost = resolvePassportTargetHostFlag(flags);
		if (subcommand === "compile" || subcommand === "diff") {
			const result = compilePassport({
				passport,
				targetHost,
				workspaceRoot,
				runtimeHome: home,
				trustZoneId,
				compilerVersion: ONLYBOTS_RUNTIME_CORE_VERSION,
				write: subcommand === "compile" && (flags.write === true || flags.apply === true),
			});
			return flags.json ? JSON.stringify(result, null, 2) : formatPassportCompileResult(result);
		}

		const verification = verifyPassportCompilation({
			passport,
			targetHost,
			workspaceRoot,
			runtimeHome: home,
			trustZoneId,
			compilerVersion: ONLYBOTS_RUNTIME_CORE_VERSION,
		});
		return flags.json ? JSON.stringify(verification, null, 2) : formatPassportVerifyResult(verification);
	}

	throw new Error("passport requires one of: init, import, compile, diff, verify, explain-routing");
};
