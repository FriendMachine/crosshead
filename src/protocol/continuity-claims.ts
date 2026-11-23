import type { Npub, Timestamped, Uuid } from "./base";

export const CONTINUITY_CLAIM_SCHEMA_VERSION = "continuity_claim_v1" as const;
export const CONTINUITY_CLAIM_EVIDENCE_SCHEMA_VERSION = "continuity_claim_evidence_v1" as const;

export const CONTINUITY_CLAIM_KINDS = [
	"task_commitment",
	"implementation",
	"deployment",
	"verification",
	"blocker",
] as const;

export const CONTINUITY_CLAIM_STATUSES = [
	"open",
	"blocked",
	"verified",
	"rejected",
	"stale",
	"superseded",
] as const;

export const CONTINUITY_CLAIM_EVIDENCE_KINDS = [
	"conversation_summary",
	"runtime_event",
	"task_master",
	"git_commit",
	"ci_pipeline",
	"deploy_trace",
	"prod_smoke",
	"reviewed_memory",
	"reviewed_dream",
	"operator_signoff",
	"peer_verification",
] as const;

export const CONTINUITY_CLAIM_AUTHORITIES = [
	"conversation",
	"runtime",
	"reviewed_memory",
	"task_master",
	"git",
	"ci",
	"deploy",
	"peer_verifier",
	"prod",
	"operator",
] as const;

export type ContinuityClaimKind = (typeof CONTINUITY_CLAIM_KINDS)[number];
export type ContinuityClaimStatus = (typeof CONTINUITY_CLAIM_STATUSES)[number];
export type ContinuityClaimEvidenceKind = (typeof CONTINUITY_CLAIM_EVIDENCE_KINDS)[number];
export type ContinuityClaimAuthority = (typeof CONTINUITY_CLAIM_AUTHORITIES)[number];

export const CONTINUITY_CLAIM_UNRESOLVED_STATUSES: ContinuityClaimStatus[] = ["open", "blocked", "stale"];
export const CONTINUITY_CLAIM_TERMINAL_STATUSES: ContinuityClaimStatus[] = [
	"verified",
	"rejected",
	"superseded",
];

export const CONTINUITY_CLAIM_EVIDENCE_AUTHORITY: Record<
	ContinuityClaimEvidenceKind,
	ContinuityClaimAuthority
> = {
	conversation_summary: "conversation",
	runtime_event: "runtime",
	task_master: "task_master",
	git_commit: "git",
	ci_pipeline: "ci",
	deploy_trace: "deploy",
	prod_smoke: "prod",
	reviewed_memory: "reviewed_memory",
	reviewed_dream: "reviewed_memory",
	operator_signoff: "operator",
	peer_verification: "peer_verifier",
};

export const CONTINUITY_CLAIM_AUTHORITY_RANK: Record<ContinuityClaimAuthority, number> = {
	conversation: 0,
	runtime: 10,
	reviewed_memory: 20,
	task_master: 30,
	git: 40,
	ci: 50,
	deploy: 60,
	// An appointed verifier that tried to falsify the claim. Below prod and operator: the server checks the verifier is a
	// distinct key appointed by the owner, not that it is run by someone other than the owner's own people.
	peer_verifier: 65,
	prod: 70,
	operator: 80,
};

export const CONTINUITY_CLAIM_VERIFICATION_EVIDENCE_KINDS: ContinuityClaimEvidenceKind[] = [
	"runtime_event",
	"task_master",
	"git_commit",
	"ci_pipeline",
	"deploy_trace",
	"prod_smoke",
	"reviewed_memory",
	"reviewed_dream",
	"operator_signoff",
	"peer_verification",
];

export const DEFAULT_CONTINUITY_CLAIM_REQUIRED_EVIDENCE: Record<
	ContinuityClaimKind,
	ContinuityClaimEvidenceKind[]
> = {
	task_commitment: ["task_master"],
	implementation: ["git_commit"],
	deployment: ["deploy_trace"],
	verification: ["prod_smoke"],
	blocker: ["operator_signoff"],
};

/**
 * The exact tree a claim is about. When a claim declares one, evidence of a kind that names a revision (commit,
 * pipeline, deploy trace) counts only if it names the same commit (or the same tree). Without it, evidence for
 * different commits could together verify a claim that no single tree satisfies.
 */
export type ContinuityClaimRevision = {
	repo?: string | null;
	commitSha: string;
	treeSha?: string | null;
	targetRef?: string | null;
	targetTipSha?: string | null;
};

export type ContinuityClaimSubject = {
	type: "task" | "commitment" | "implementation" | "deployment" | "verification" | "blocker" | "memory" | "other";
	ref: string;
	title?: string | null;
	metadata?: Record<string, unknown> | null;
	revision?: ContinuityClaimRevision | null;
};

export type ContinuityClaimScope = {
	workspaceId?: string | null;
	repo?: string | null;
	taskId?: string | null;
	environment?: string | null;
	agentNpub?: Npub | null;
	tags?: string[];
};

export type ContinuityClaimFreshness = {
	observedAt?: Date | null;
	staleAt?: Date | null;
	maxAgeSeconds?: number | null;
};

export type ContinuityClaimVerificationPlan = {
	requiredEvidence: ContinuityClaimEvidenceKind[];
	description?: string | null;
	checklist?: string[];
};

export type ContinuityClaim = Timestamped & {
	id: Uuid;
	npub: Npub;
	kind: ContinuityClaimKind;
	status: ContinuityClaimStatus;
	subject: ContinuityClaimSubject;
	statement: string;
	scope: ContinuityClaimScope;
	authority: ContinuityClaimAuthority;
	verificationPlan: ContinuityClaimVerificationPlan;
	freshness: ContinuityClaimFreshness;
	supersedes: Uuid[];
	supersededBy: Uuid | null;
	verifiedAt: Date | null;
	rejectedAt: Date | null;
	staleAt: Date | null;
	idempotencyKey: string | null;
	metadata: Record<string, unknown>;
};

export type ContinuityClaimEvidence = Timestamped & {
	id: Uuid;
	claimId: Uuid;
	npub: Npub;
	kind: ContinuityClaimEvidenceKind;
	authority: ContinuityClaimAuthority;
	ref: string;
	summary: string | null;
	observedAt: Date;
	idempotencyKey: string | null;
	metadata: Record<string, unknown>;
};

export type ContinuityClaimWithEvidence = ContinuityClaim & {
	evidence: ContinuityClaimEvidence[];
};

export const isContinuityClaimKind = (value: unknown): value is ContinuityClaimKind =>
	typeof value === "string" && (CONTINUITY_CLAIM_KINDS as readonly string[]).includes(value);

export const isContinuityClaimStatus = (value: unknown): value is ContinuityClaimStatus =>
	typeof value === "string" && (CONTINUITY_CLAIM_STATUSES as readonly string[]).includes(value);

export const isContinuityClaimEvidenceKind = (value: unknown): value is ContinuityClaimEvidenceKind =>
	typeof value === "string" && (CONTINUITY_CLAIM_EVIDENCE_KINDS as readonly string[]).includes(value);

export const isContinuityClaimAuthority = (value: unknown): value is ContinuityClaimAuthority =>
	typeof value === "string" && (CONTINUITY_CLAIM_AUTHORITIES as readonly string[]).includes(value);

export const continuityClaimAuthorityForEvidence = (
	kind: ContinuityClaimEvidenceKind,
): ContinuityClaimAuthority => CONTINUITY_CLAIM_EVIDENCE_AUTHORITY[kind];

export const continuityClaimAuthorityRank = (authority: ContinuityClaimAuthority): number =>
	CONTINUITY_CLAIM_AUTHORITY_RANK[authority];

export const compareContinuityClaimAuthority = (
	left: ContinuityClaimAuthority,
	right: ContinuityClaimAuthority,
): number => continuityClaimAuthorityRank(left) - continuityClaimAuthorityRank(right);

export const isVerificationCapableEvidenceKind = (kind: ContinuityClaimEvidenceKind): boolean =>
	(CONTINUITY_CLAIM_VERIFICATION_EVIDENCE_KINDS as readonly string[]).includes(kind);

// Hosted API request and response shapes.
export type ContinuityClaimCreateInput = {
	npub: Npub;
	kind: ContinuityClaimKind;
	status?: ContinuityClaimStatus;
	subject: ContinuityClaimSubject;
	statement: string;
	scope?: ContinuityClaimScope;
	authority?: ContinuityClaimAuthority;
	verificationPlan?: ContinuityClaimVerificationPlan;
	freshness?: ContinuityClaimFreshness;
	supersedes?: Uuid[];
	idempotencyKey?: string | null;
	metadata?: Record<string, unknown>;
};

export type ContinuityClaimEvidenceCreateInput = {
	claimId: Uuid;
	npub: Npub;
	kind: ContinuityClaimEvidenceKind;
	authority?: ContinuityClaimAuthority;
	ref: string;
	summary?: string | null;
	observedAt?: Date;
	idempotencyKey?: string | null;
	metadata?: Record<string, unknown>;
};

export type ContinuityClaimListFilters = {
	statuses?: ContinuityClaimStatus[];
	kinds?: ContinuityClaimKind[];
	unresolvedOnly?: boolean;
	subjectType?: string;
	subjectRef?: string;
	evidenceKind?: ContinuityClaimEvidenceKind;
	limit?: number;
};

export type ContinuityClaimVerificationResult = {
	claim: ContinuityClaimWithEvidence;
	verified: boolean;
	missingEvidence: ContinuityClaimEvidenceKind[];
	nonVerifyingEvidence: ContinuityClaimEvidenceKind[];
	/** Evidence not counted because it names a different revision than the claim declares. */
	revisionMismatches?: Array<{ evidenceId: Uuid; kind: ContinuityClaimEvidenceKind; reason: string }>;
};

/**
 * Whether a peer verifier's upheld verdict stands in for a required evidence kind: it does for kinds ranked at or
 * below `deploy` (a verifier can re-check a commit, pipeline or deploy trace), never for `prod_smoke` or
 * `operator_signoff`.
 */
export const peerVerificationSatisfiesEvidence = (kind: ContinuityClaimEvidenceKind): boolean =>
	kind === "peer_verification" ||
	CONTINUITY_CLAIM_AUTHORITY_RANK[CONTINUITY_CLAIM_EVIDENCE_AUTHORITY[kind]] <= CONTINUITY_CLAIM_AUTHORITY_RANK.deploy;

/** Evidence kinds that are about one revision and must match a claim's declared revision. */
export const CONTINUITY_CLAIM_REVISION_EVIDENCE_KINDS: ContinuityClaimEvidenceKind[] = ["git_commit", "ci_pipeline", "deploy_trace"];

const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const gitObject = (value: unknown): string | null =>
	typeof value === "string" && GIT_OBJECT.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null;
const shortText = (value: unknown, max: number): string | null =>
	typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : null;

/**
 * A claim revision in canonical form, `null` when absent, or an error message when present but invalid. Commit and
 * tree IDs are full SHA-1 or SHA-256 hex, so abbreviations cannot match the wrong object.
 */
export const normalizeContinuityClaimRevision = (value: unknown): ContinuityClaimRevision | null | { error: string } => {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value)) return { error: "subject.revision must be an object" };
	const item = value as Record<string, unknown>;
	const commitSha = gitObject(item.commitSha);
	if (!commitSha) return { error: "subject.revision.commitSha must be a full 40- or 64-character hex commit ID" };
	for (const key of ["treeSha", "targetTipSha"] as const) {
		if (item[key] !== undefined && item[key] !== null && !gitObject(item[key])) return { error: `subject.revision.${key} must be a full hex object ID` };
	}
	for (const [key, max] of [["repo", 500], ["targetRef", 255]] as const) {
		if (item[key] !== undefined && item[key] !== null && !shortText(item[key], max)) return { error: `subject.revision.${key} must be a non-empty string of at most ${max} characters` };
	}
	const known = new Set(["repo", "commitSha", "treeSha", "targetRef", "targetTipSha"]);
	const unknown = Object.keys(item).find(key => !known.has(key));
	if (unknown) return { error: `subject.revision.${unknown} is not a known field` };
	return {
		commitSha,
		...(shortText(item.repo, 500) ? { repo: shortText(item.repo, 500) } : {}),
		...(gitObject(item.treeSha) ? { treeSha: gitObject(item.treeSha) } : {}),
		...(shortText(item.targetRef, 255) ? { targetRef: shortText(item.targetRef, 255) } : {}),
		...(gitObject(item.targetTipSha) ? { targetTipSha: gitObject(item.targetTipSha) } : {}),
	};
};

/**
 * Whether one piece of evidence counts toward a claim with this revision. Evidence of other kinds always counts.
 * Revision-bearing evidence must carry `metadata.commitSha` equal to the claim's commit, or `metadata.treeSha` equal to
 * the claim's tree when the claim names one (a rebuilt or re-merged commit with the same tree).
 */
export const continuityClaimEvidenceMatchesRevision = (
	revision: ContinuityClaimRevision | null | undefined,
	evidence: Pick<ContinuityClaimEvidence, "kind" | "metadata">,
): { matches: true } | { matches: false; reason: string } => {
	if (!revision || !(CONTINUITY_CLAIM_REVISION_EVIDENCE_KINDS as readonly string[]).includes(evidence.kind)) return { matches: true };
	const commit = gitObject(evidence.metadata?.commitSha);
	const tree = gitObject(evidence.metadata?.treeSha);
	if (commit === revision.commitSha) return { matches: true };
	if (revision.treeSha && tree === revision.treeSha) return { matches: true };
	if (!commit && !tree) return { matches: false, reason: `${evidence.kind} evidence names no commit; the claim is about ${revision.commitSha}` };
	return { matches: false, reason: `${evidence.kind} evidence is for ${commit ?? `tree ${tree}`}, not the claim's ${revision.commitSha}` };
};
