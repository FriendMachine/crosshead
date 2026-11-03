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
] as const;

export const CONTINUITY_CLAIM_AUTHORITIES = [
	"conversation",
	"runtime",
	"reviewed_memory",
	"task_master",
	"git",
	"ci",
	"deploy",
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
};

export const CONTINUITY_CLAIM_AUTHORITY_RANK: Record<ContinuityClaimAuthority, number> = {
	conversation: 0,
	runtime: 10,
	reviewed_memory: 20,
	task_master: 30,
	git: 40,
	ci: 50,
	deploy: 60,
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

export type ContinuityClaimSubject = {
	type: "task" | "commitment" | "implementation" | "deployment" | "verification" | "blocker" | "memory" | "other";
	ref: string;
	title?: string | null;
	metadata?: Record<string, unknown> | null;
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
};
