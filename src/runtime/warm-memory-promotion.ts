import { recallGoalTag, recallDescriptionTag, recallTaskTag } from "./continuity-recall";
import { createHash } from "crypto";

import type { WarmEntryType } from "../protocol/memory";

export const WARM_PROMOTION_CANDIDATE_SCHEMA_VERSION = "warm_promotion_candidate_v1";
export const WARM_PROMOTION_CLASSIFIER_SCHEMA_VERSION = "warm_promotion_classifier_v1";

export const WARM_PROMOTION_TOPIC_TAGS = [
  "adapter",
  "auth",
  "billing",
  "context",
  "deployment",
  "docs",
  "feedback",
  "memory",
  "messaging",
  "relay",
  "runtime",
  "security",
  "testing",
  "workflow",
] as const;

export type WarmPromotionTopicTag = (typeof WARM_PROMOTION_TOPIC_TAGS)[number];

export type WarmPromotionClassifierAdvisoryField =
  | "inferredType"
  | "topicTags"
  | "durabilityRecommendation"
  | "confidence"
  | "supersedesEntryIds"
  | "conflictsWithEntryIds";

export type WarmPromotionDurabilityRecommendation = "reject" | "proposal" | "promote";
export type WarmPromotionClassifierSource = "deterministic" | "server_default" | "runtime_override";
export type WarmPromotionSourceQuality =
  | "explicit_operator"
  | "successful_turn"
  | "correction_signal"
  | "task_signal"
  | "tool_signal"
  | "ambient_signal";

export type WarmPromotionLifecycleEventType =
  | "runtime.attached"
  | "runtime.detached"
  | "session.started"
  | "session.ended"
  | "compact.started"
  | "compact.completed"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "operator.command"
  | "task.changed"
  | "workspace.changed"
  | "files.edited"
  | "git.diff.created"
  | "feedback.submitted"
  | "message.received"
  | "relay.event";

export type WarmPromotionEvent = {
  eventId: string;
  runtime: string;
  profileName: string;
  workspaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  type: WarmPromotionLifecycleEventType;
  occurredAt: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type WarmPromotionClassifierContract = {
  schemaVersion: typeof WARM_PROMOTION_CLASSIFIER_SCHEMA_VERSION;
  classifierOwner: "onlybots_server";
  authoritativeFields: [];
  advisoryFields: WarmPromotionClassifierAdvisoryField[];
  input: {
    candidateId: string;
    content: string;
    contentHash: string;
    deterministicTags: string[];
    source: {
      eventType: WarmPromotionLifecycleEventType;
      runtime: string;
      profileName: string;
      workspaceId: string | null;
      sessionId: string | null;
      turnId: string | null;
    };
    currentInference: {
      type: WarmEntryType;
      confidence: number;
      topicTags: WarmPromotionTopicTag[];
      durabilityRecommendation: WarmPromotionDurabilityRecommendation;
    };
  };
};

export type WarmPromotionClassifierOutput = {
  schemaVersion: typeof WARM_PROMOTION_CLASSIFIER_SCHEMA_VERSION;
  authoritativeFields: [];
  advisoryFields: WarmPromotionClassifierAdvisoryField[];
  inferredType: WarmEntryType;
  topicTags: WarmPromotionTopicTag[];
  durabilityRecommendation: WarmPromotionDurabilityRecommendation;
  confidence: number;
  supersedesEntryIds: string[];
  conflictsWithEntryIds: string[];
};

export type WarmPromotionCandidate = {
  schemaVersion: typeof WARM_PROMOTION_CANDIDATE_SCHEMA_VERSION;
  candidateId: string;
  reason: string;
  source: {
    eventId: string;
    eventType: WarmPromotionLifecycleEventType;
    occurredAt: string;
    runtime: string;
    profileName: string;
    workspaceId: string | null;
    sessionId: string | null;
    turnId: string | null;
    command: string | null;
  };
  content: {
    text: string;
    hash: string;
  };
  deterministicTags: string[];
  inferred: {
    type: WarmEntryType;
    confidence: number;
    topicTags: WarmPromotionTopicTag[];
    durabilityRecommendation: WarmPromotionDurabilityRecommendation;
    classifierSource: WarmPromotionClassifierSource;
    authoritativeFields: [];
    advisoryFields: WarmPromotionClassifierAdvisoryField[];
  };
  scoring: {
    explicit: boolean;
    approved: boolean;
    taskSucceeded: boolean | null;
    sourceQuality: WarmPromotionSourceQuality;
    recurrenceKey: string;
  };
  relations: {
    supersedesEntryIds: string[];
    conflictsWithEntryIds: string[];
  };
  classifierContract: WarmPromotionClassifierContract;
};

const CLASSIFIER_ADVISORY_FIELDS: WarmPromotionClassifierAdvisoryField[] = [
  "inferredType",
  "topicTags",
  "durabilityRecommendation",
  "confidence",
  "supersedesEntryIds",
  "conflictsWithEntryIds",
];

const TOPIC_TAG_SET = new Set<WarmPromotionTopicTag>(WARM_PROMOTION_TOPIC_TAGS);
const WARM_ENTRY_TYPES = new Set<WarmEntryType>(["commitment", "correction", "fact", "pattern"]);

const asString = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);

const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const asStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const hashString = (value: string): string => createHash("sha256").update(value).digest("hex");

const normalizeTagValue = (value: string, mode: "default" | "path" = "default"): string =>
  value
    .trim()
    .toLowerCase()
    .replace(mode === "path" ? /[^a-z0-9./_-]+/g : /[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

const makeTag = (prefix: string, rawValue: string, mode: "default" | "path" = "default"): string | null => {
  const normalized = normalizeTagValue(rawValue, mode);
  if (normalized.length === 0) {
    return null;
  }
  return `${prefix}:${normalized}`;
};

const pushTag = (target: string[], tag: string | null): void => {
  if (tag) {
    target.push(tag);
  }
};

const unique = <T>(values: T[]): T[] => Array.from(new Set(values));

const textualValues = (value: unknown): string[] => {
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => textualValues(entry));
  }
  return [];
};

const buildTopicInferenceHaystack = (event: WarmPromotionEvent, content: string): string => {
  const payloadText = [
    event.payload.summary,
    event.payload.result,
    event.payload.goal,
    event.payload.prompt,
    event.payload.command,
    event.payload.taskTitle,
    event.payload.task,
    event.payload.toolName,
    event.payload.tool_name,
    event.payload.newFact,
    event.payload.new_fact,
    event.payload.newCommitment,
    event.payload.new_commitment,
    event.payload.newCorrection,
    event.payload.new_correction,
    event.payload.correctedFact,
    event.payload.corrected_fact,
    event.payload.whatChanged,
    event.payload.what_changed,
    event.payload.whatIsNowTrue,
    event.payload.what_is_now_true,
    event.payload.nextStep,
    event.payload.next_step,
    event.payload.canonicalWorkflow,
    event.payload.canonical_workflow,
    event.payload.remainingCaveat,
    event.payload.remaining_caveat,
  ].flatMap((value) => textualValues(value));

  return [event.type, content, ...payloadText].join(" ").toLowerCase();
};

const inferTopicTags = (candidateType: WarmEntryType, event: WarmPromotionEvent, content: string): WarmPromotionTopicTag[] => {
  const topics: WarmPromotionTopicTag[] = [];
  const haystack = buildTopicInferenceHaystack(event, content);

  if (haystack.includes("runtime") || haystack.includes("adapter")) {
    topics.push("runtime");
  }
  if (haystack.includes("adapter") || haystack.includes("codex") || haystack.includes("claude") || haystack.includes("pi")) {
    topics.push("adapter");
  }
  if (haystack.includes("memory") || haystack.includes("context")) {
    topics.push("memory");
  }
  if (haystack.includes("context")) {
    topics.push("context");
  }
  if (haystack.includes("test") || haystack.includes("qa")) {
    topics.push("testing");
  }
  if (haystack.includes("doc") || haystack.includes("readme")) {
    topics.push("docs");
  }
  if (haystack.includes("auth") || haystack.includes("session")) {
    topics.push("auth");
  }
  if (haystack.includes("billing") || haystack.includes("payment")) {
    topics.push("billing");
  }
  if (haystack.includes("relay")) {
    topics.push("relay");
  }
  if (haystack.includes("message")) {
    topics.push("messaging");
  }
  if (haystack.includes("feedback")) {
    topics.push("feedback");
  }
  if (haystack.includes("security") || haystack.includes("secret")) {
    topics.push("security");
  }
  if (haystack.includes("deploy") || haystack.includes("release") || haystack.includes("prod")) {
    topics.push("deployment");
  }
  if (candidateType === "commitment" || candidateType === "pattern") {
    topics.push("workflow");
  }

  return unique(topics.filter((tag): tag is WarmPromotionTopicTag => TOPIC_TAG_SET.has(tag)));
};

const inferSourceQuality = (candidateType: WarmEntryType, event: WarmPromotionEvent, explicit: boolean): WarmPromotionSourceQuality => {
  if (explicit || event.type === "operator.command") {
    return "explicit_operator";
  }
  if (candidateType === "correction") {
    return "correction_signal";
  }
  if (event.type === "turn.completed") {
    return "successful_turn";
  }
  if (event.type === "task.changed") {
    return "task_signal";
  }
  if (event.type === "tool.completed") {
    return "tool_signal";
  }
  return "ambient_signal";
};

const inferDurabilityRecommendation = (
  candidateType: WarmEntryType,
  confidence: number,
  explicit: boolean,
  taskSucceeded: boolean | null
): WarmPromotionDurabilityRecommendation => {
  if (explicit) {
    return "promote";
  }
  if (candidateType === "correction" && confidence >= 0.9) {
    return "promote";
  }
  if (taskSucceeded === false) {
    return "proposal";
  }
  return confidence >= 0.85 ? "promote" : "proposal";
};

const extractFilePaths = (event: WarmPromotionEvent): string[] => {
  const fileLists = [
    event.payload.filePaths,
    event.payload.file_paths,
    event.payload.files,
    event.payload.editedFiles,
    event.payload.edited_files,
    event.metadata.filePaths,
    event.metadata.file_paths,
  ];
  return unique(fileLists.flatMap((value) => asStringList(value)).slice(0, 8));
};

const extractToolNames = (event: WarmPromotionEvent): string[] =>
  unique(
    [
      asString(event.payload.toolName),
      asString(event.payload.tool_name),
      asString(event.metadata.toolName),
      asString(event.metadata.tool_name),
    ].filter((value): value is string => value !== null)
  );

const extractCommitSha = (event: WarmPromotionEvent): string | null =>
  asString(event.payload.commitSha) ??
  asString(event.payload.commit_sha) ??
  asString(event.metadata.commitSha) ??
  asString(event.metadata.commit_sha);

const extractTaskId = (event: WarmPromotionEvent): string | null =>
  asString(event.payload.taskId) ??
  asString(event.payload.task_id) ??
  asString(event.payload.taskTitle) ??
  asString(event.payload.task);

export const extractDeterministicWarmPromotionTags = (event: WarmPromotionEvent, candidateType: WarmEntryType): string[] => {
  const tags: string[] = [];
  const goal = asString(event.payload.goal) ?? asString(event.payload.prompt);
  if (goal) tags.push(recallGoalTag(goal), recallDescriptionTag(goal));
  const recallTaskId = asString(event.payload.taskId) ?? asString(event.payload.task_id);
  if (recallTaskId) tags.push(recallTaskTag(recallTaskId));
  pushTag(tags, makeTag("runtime", event.runtime));
  pushTag(tags, makeTag("profile", event.profileName));
  pushTag(tags, makeTag("event", event.type));
  pushTag(tags, makeTag("candidate", candidateType));

  if (event.workspaceId) {
    pushTag(tags, makeTag("workspace", event.workspaceId, "path"));
  }
  if (event.sessionId) {
    pushTag(tags, makeTag("session", event.sessionId));
  }
  if (event.turnId) {
    pushTag(tags, makeTag("turn", event.turnId));
  }

  const command = asString(event.payload.command);
  if (command) {
    pushTag(tags, makeTag("command", command));
  }

  const commitSha = extractCommitSha(event);
  if (commitSha) {
    pushTag(tags, makeTag("commit", commitSha));
  }

  const taskId = extractTaskId(event);
  if (taskId) {
    pushTag(tags, makeTag("task", taskId));
  }

  for (const filePath of extractFilePaths(event)) {
    pushTag(tags, makeTag("file", filePath, "path"));
  }
  for (const toolName of extractToolNames(event)) {
    pushTag(tags, makeTag("tool", toolName));
  }

  return unique(tags);
};

const buildCandidateId = (event: WarmPromotionEvent, type: WarmEntryType, contentHash: string): string =>
  `wmc_${hashString(`${event.eventId}:${type}:${contentHash}`).slice(0, 16)}`;

export type WarmPromotionContinuityScope = "project" | "runtime_host";

const normalizeContinuityText = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const hostSpecificSignal = (value: string): boolean =>
  /\b(host[- ]specific|host[- ]only|runtime[- ]host|adapter[- ]local|codex[- ]only|claude[- ]code[- ]only|pi[- ]only)\b/i.test(
    value
  );

const inferContinuityScope = (event: WarmPromotionEvent, candidate: { type: WarmEntryType; content: string; reason: string; semanticTags: string[] }): WarmPromotionContinuityScope => {
  const explicitScopeTag = candidate.semanticTags
    .map((tag) => normalizeTagValue(tag))
    .find((tag) => tag === "scope:host" || tag === "scope:runtime-host" || tag === "host-specific");
  if (explicitScopeTag) {
    return "runtime_host";
  }
  const haystack = `${candidate.content} ${candidate.reason} ${candidate.semanticTags.join(" ")} ${event.metadata.reason ?? ""}`;
  if (hostSpecificSignal(haystack)) {
    return "runtime_host";
  }
  return "project";
};

const buildContinuityDedupeKey = (
  event: WarmPromotionEvent,
  type: WarmEntryType,
  normalizedContentHash: string,
  scope: WarmPromotionContinuityScope
): string => {
  const workspace = event.workspaceId ?? "global";
  if (scope === "runtime_host") {
    return `runtime-host:${event.runtime}:${workspace}:${type}:${normalizedContentHash.slice(0, 16)}`;
  }
  return `project:${workspace}:${type}:${normalizedContentHash.slice(0, 16)}`;
};

const buildContinuityTags = (
  event: WarmPromotionEvent,
  dedupeKey: string,
  scope: WarmPromotionContinuityScope
): string[] => {
  const keyHash = hashString(dedupeKey).slice(0, 16);
  return [
    `continuity-scope:${scope}`,
    `continuity-dedupe:${keyHash}`,
    `memory-claim:shared-continuity:${keyHash}`,
    `source-event:${normalizeTagValue(event.eventId)}`,
    ...(scope === "runtime_host" ? [`continuity-host:${normalizeTagValue(event.runtime)}`] : []),
  ];
};

const normalizeCandidateType = (value: unknown): WarmEntryType | null => {
  const candidateType = asString(value);
  if (!candidateType || !WARM_ENTRY_TYPES.has(candidateType as WarmEntryType)) {
    return null;
  }
  return candidateType as WarmEntryType;
};

const normalizeConfidence = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

const isTaskSuccessful = (event: WarmPromotionEvent): boolean | null =>
  asBoolean(event.payload.taskSucceeded) ?? asBoolean(event.payload.task_succeeded);

const isLikelyTransientDistillation = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return (
    normalized.length < 24 ||
    normalized.includes("placeholder") ||
    normalized.includes("scratch") ||
    normalized.includes("dummy") ||
    normalized.includes("artifact")
  );
};

const inferRemainingCaveatType = (content: string): WarmEntryType =>
  /\b(never|avoid|do not|don't|must not|cannot|can't)\b/i.test(content) ? "correction" : "fact";

const inferDistilledSummaryType = (summary: string): WarmEntryType | null => {
  if (isLikelyTransientDistillation(summary)) {
    return null;
  }
  if (/\b(canonical|workflow|playbook|standard)\b/i.test(summary)) {
    return "pattern";
  }
  if (/^(verify|keep|track|use|prefer|always)\b/i.test(summary.trim())) {
    return "commitment";
  }
  if (/\b(now|owns|uses|routes|persists|is|are|remains|became|aligned)\b/i.test(summary)) {
    return "fact";
  }
  return null;
};

const collectExplicitCandidates = (event: WarmPromotionEvent): Array<{
  type: WarmEntryType;
  content: string;
  confidence: number;
  reason: string;
  explicit: boolean;
  semanticTags: string[];
  supersedesEntryIds: string[];
  conflictsWithEntryIds: string[];
}> => {
  const entries: Array<{
    type: WarmEntryType;
    content: string;
    confidence: number;
    reason: string;
    explicit: boolean;
    semanticTags: string[];
    supersedesEntryIds: string[];
    conflictsWithEntryIds: string[];
  }> = [];

  const appendScalar = (value: unknown, type: WarmEntryType, reason: string, explicit: boolean, confidence: number): void => {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    for (const item of items) {
      if (typeof item === "string" && item.trim().length > 0) {
        entries.push({
          type,
          content: item.trim(),
          confidence,
          reason,
          explicit,
          semanticTags: [],
          supersedesEntryIds: [],
          conflictsWithEntryIds: [],
        });
      }
    }
  };

  appendScalar(event.payload.newFact ?? event.payload.new_fact, "fact", `${event.type} surfaced a new fact`, false, 0.9);
  appendScalar(
    event.payload.newCommitment ?? event.payload.new_commitment,
    "commitment",
    `${event.type} surfaced a new commitment`,
    false,
    0.9
  );
  appendScalar(
    event.payload.newCorrection ?? event.payload.new_correction ?? event.payload.correctedFact ?? event.payload.corrected_fact,
    "correction",
    `${event.type} surfaced a correction signal`,
    false,
    0.95
  );

  const warmCandidates = event.payload.warmCandidates ?? event.payload.warm_candidates;
  if (Array.isArray(warmCandidates)) {
    for (const rawCandidate of warmCandidates) {
      if (!rawCandidate || typeof rawCandidate !== "object" || Array.isArray(rawCandidate)) {
        continue;
      }
      const candidate = rawCandidate as Record<string, unknown>;
      const type = normalizeCandidateType(candidate.type ?? candidate.entryType ?? candidate.entry_type);
      const content = asString(candidate.content);
      if (!type || !content) {
        continue;
      }
      entries.push({
        type,
        content,
        confidence: normalizeConfidence(candidate.confidence, 0.85),
        reason: asString(candidate.reason) ?? `${event.type} suggested ${type}`,
        explicit: candidate.explicit === true,
        semanticTags: asStringList(candidate.tags),
        supersedesEntryIds: asStringList(candidate.supersedesEntryIds ?? candidate.supersedes_entry_ids),
        conflictsWithEntryIds: asStringList(candidate.conflictsWithEntryIds ?? candidate.conflicts_with_entry_ids),
      });
    }
  }

  if (event.type === "operator.command" && asString(event.payload.command) === "remember") {
    const type = normalizeCandidateType(event.payload.entryType ?? event.payload.entry_type) ?? "fact";
    const content = asString(event.payload.content);
    if (content) {
      entries.push({
        type,
        content,
        confidence: 1,
        reason: "Explicit operator remember command",
        explicit: true,
        semanticTags: asStringList(event.payload.tags),
        supersedesEntryIds: asStringList(event.payload.supersedesEntryIds ?? event.payload.supersedes_entry_ids),
        conflictsWithEntryIds: asStringList(event.payload.conflictsWithEntryIds ?? event.payload.conflicts_with_entry_ids),
      });
    }
  }

  if (event.type === "turn.completed" && isTaskSuccessful(event) !== false) {
    appendScalar(
      event.payload.whatChanged ?? event.payload.what_changed,
      "fact",
      "Post-turn distillation captured what changed",
      false,
      0.88
    );
    appendScalar(
      event.payload.whatIsNowTrue ?? event.payload.what_is_now_true,
      "fact",
      "Post-turn distillation captured what is now true",
      false,
      0.9
    );
    appendScalar(
      event.payload.nextStep ?? event.payload.next_step,
      "commitment",
      "Post-turn distillation captured the next durable step",
      false,
      0.86
    );
    appendScalar(
      event.payload.canonicalWorkflow ?? event.payload.canonical_workflow,
      "pattern",
      "Post-turn distillation captured the canonical workflow",
      false,
      0.88
    );

    const remainingCaveat = asString(event.payload.remainingCaveat ?? event.payload.remaining_caveat);
    if (remainingCaveat) {
      entries.push({
        type: inferRemainingCaveatType(remainingCaveat),
        content: remainingCaveat,
        confidence: 0.84,
        reason: "Post-turn distillation captured a remaining caveat",
        explicit: false,
        semanticTags: [],
        supersedesEntryIds: [],
        conflictsWithEntryIds: [],
      });
    }

    const alreadyDistilled =
      (asString(event.payload.newFact ?? event.payload.new_fact) !== null ||
        Array.isArray(event.payload.newFact ?? event.payload.new_fact)) ||
      (asString(event.payload.newCommitment ?? event.payload.new_commitment) !== null ||
        Array.isArray(event.payload.newCommitment ?? event.payload.new_commitment)) ||
      (asString(event.payload.newCorrection ?? event.payload.new_correction ?? event.payload.correctedFact ?? event.payload.corrected_fact) !== null ||
        Array.isArray(event.payload.newCorrection ?? event.payload.new_correction ?? event.payload.correctedFact ?? event.payload.corrected_fact)) ||
      entries.length > 0;
    const summary = asString(event.payload.summary);
    const distilledSummaryType = summary ? inferDistilledSummaryType(summary) : null;
    if (!alreadyDistilled && summary && distilledSummaryType) {
      entries.push({
        type: distilledSummaryType,
        content: summary,
        confidence: distilledSummaryType === "pattern" ? 0.84 : 0.86,
        reason: "Post-turn distillation captured a durable summary",
        explicit: false,
        semanticTags: [],
        supersedesEntryIds: [],
        conflictsWithEntryIds: [],
      });
    }
  }

  return entries.filter(
    (entry, index, values) =>
      values.findIndex((candidate) => candidate.type === entry.type && candidate.content === entry.content) === index
  );
};

export const buildWarmPromotionCandidates = (event: WarmPromotionEvent): WarmPromotionCandidate[] => {
  const taskSucceeded = isTaskSuccessful(event);
  const approved =
    event.type === "operator.command" ||
    event.payload.approved === true ||
    event.payload.operatorApproved === true ||
    event.payload.operator_approved === true ||
    event.payload.allowColdSync === true ||
    event.payload.allow_cold_sync === true ||
    event.payload.policySignal === "operator_confirmed";

  return collectExplicitCandidates(event).map((candidate) => {
    const contentHash = hashString(candidate.content);
    const continuityScope = inferContinuityScope(event, candidate);
    const normalizedContentHash = hashString(normalizeContinuityText(candidate.content));
    const continuityDedupeKey = buildContinuityDedupeKey(
      event,
      candidate.type,
      normalizedContentHash,
      continuityScope
    );
    const deterministicTags = unique([
      ...extractDeterministicWarmPromotionTags(event, candidate.type),
      ...buildContinuityTags(event, continuityDedupeKey, continuityScope),
    ]);
    const topicTags = unique([
      ...inferTopicTags(candidate.type, event, candidate.content),
      ...candidate.semanticTags
        .map((tag) => normalizeTagValue(tag))
        .filter((tag): tag is WarmPromotionTopicTag => TOPIC_TAG_SET.has(tag as WarmPromotionTopicTag)),
    ]);
    const durabilityRecommendation = inferDurabilityRecommendation(
      candidate.type,
      candidate.confidence,
      candidate.explicit,
      taskSucceeded
    );
    const candidateId = buildCandidateId(event, candidate.type, contentHash);

    const classifierContract: WarmPromotionClassifierContract = {
      schemaVersion: WARM_PROMOTION_CLASSIFIER_SCHEMA_VERSION,
      classifierOwner: "onlybots_server",
      authoritativeFields: [],
      advisoryFields: [...CLASSIFIER_ADVISORY_FIELDS],
      input: {
        candidateId,
        content: candidate.content,
        contentHash,
        deterministicTags,
        source: {
          eventType: event.type,
          runtime: event.runtime,
          profileName: event.profileName,
          workspaceId: event.workspaceId,
          sessionId: event.sessionId,
          turnId: event.turnId,
        },
        currentInference: {
          type: candidate.type,
          confidence: candidate.confidence,
          topicTags,
          durabilityRecommendation,
        },
      },
    };

    return {
      schemaVersion: WARM_PROMOTION_CANDIDATE_SCHEMA_VERSION,
      candidateId,
      reason: candidate.reason,
      source: {
        eventId: event.eventId,
        eventType: event.type,
        occurredAt: event.occurredAt,
        runtime: event.runtime,
        profileName: event.profileName,
        workspaceId: event.workspaceId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        command: asString(event.payload.command),
      },
      content: {
        text: candidate.content,
        hash: contentHash,
      },
      deterministicTags,
      inferred: {
        type: candidate.type,
        confidence: candidate.confidence,
        topicTags,
        durabilityRecommendation,
        classifierSource: "deterministic",
        authoritativeFields: [],
        advisoryFields: [...CLASSIFIER_ADVISORY_FIELDS],
      },
      scoring: {
        explicit: candidate.explicit,
        approved,
        taskSucceeded,
        sourceQuality: inferSourceQuality(candidate.type, event, candidate.explicit),
	recurrenceKey: continuityDedupeKey,
      },
      relations: {
        supersedesEntryIds: candidate.supersedesEntryIds,
        conflictsWithEntryIds: candidate.conflictsWithEntryIds,
      },
      classifierContract,
    };
  });
};

export const buildWarmEntryTagsFromCandidate = (candidate: WarmPromotionCandidate): string[] =>
  unique([
    ...candidate.deterministicTags,
    ...candidate.inferred.topicTags.map((tag) => `topic:${tag}`),
  ]);

export const validateWarmPromotionCandidate = (candidate: WarmPromotionCandidate): void => {
  if (candidate.schemaVersion !== WARM_PROMOTION_CANDIDATE_SCHEMA_VERSION) {
    throw new Error("Warm promotion candidate schema version is invalid");
  }
  if (!candidate.candidateId.startsWith("wmc_")) {
    throw new Error("Warm promotion candidate id is invalid");
  }
  if (!candidate.content.text.trim()) {
    throw new Error("Warm promotion candidate content is required");
  }
  if (candidate.content.hash.length !== 64) {
    throw new Error("Warm promotion candidate content hash is invalid");
  }
  if (!WARM_ENTRY_TYPES.has(candidate.inferred.type)) {
    throw new Error("Warm promotion candidate inferred type is invalid");
  }
  if (candidate.inferred.confidence < 0 || candidate.inferred.confidence > 1) {
    throw new Error("Warm promotion candidate confidence is invalid");
  }
  if (!candidate.deterministicTags.every((tag) => tag.includes(":"))) {
    throw new Error("Warm promotion deterministic tags are invalid");
  }
  if (candidate.classifierContract.classifierOwner !== "onlybots_server") {
    throw new Error("Warm promotion classifier owner is invalid");
  }
};

export const validateWarmPromotionClassifierOutput = (
  output: WarmPromotionClassifierOutput
): WarmPromotionClassifierOutput => {
  if (output.schemaVersion !== WARM_PROMOTION_CLASSIFIER_SCHEMA_VERSION) {
    throw new Error("Warm promotion classifier schema version is invalid");
  }
  if (!WARM_ENTRY_TYPES.has(output.inferredType)) {
    throw new Error("Warm promotion classifier inferred type is invalid");
  }
  if (output.confidence < 0 || output.confidence > 1) {
    throw new Error("Warm promotion classifier confidence is invalid");
  }
  if (!output.topicTags.every((tag) => TOPIC_TAG_SET.has(tag))) {
    throw new Error("Warm promotion classifier topic tags are invalid");
  }
  return output;
};

const DURABILITY_RECOMMENDATION_VALUES: readonly WarmPromotionDurabilityRecommendation[] = [
  "reject",
  "proposal",
  "promote",
];
const CLASSIFIER_SOURCE_VALUES: readonly WarmPromotionClassifierSource[] = [
  "deterministic",
  "server_default",
  "runtime_override",
];
const SOURCE_QUALITY_VALUES: readonly WarmPromotionSourceQuality[] = [
  "explicit_operator",
  "successful_turn",
  "correction_signal",
  "task_signal",
  "tool_signal",
  "ambient_signal",
];
const LIFECYCLE_EVENT_TYPE_VALUES: readonly WarmPromotionLifecycleEventType[] = [
  "runtime.attached",
  "runtime.detached",
  "session.started",
  "session.ended",
  "compact.started",
  "compact.completed",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "operator.command",
  "task.changed",
  "workspace.changed",
  "files.edited",
  "git.diff.created",
  "feedback.submitted",
  "message.received",
  "relay.event",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const expectRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`Warm promotion field ${field} must be an object`);
  }
  return value;
};

const expectString = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw new Error(`Warm promotion field ${field} must be a string`);
  }
  return value;
};

const expectStringOrNull = (value: unknown, field: string): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  return expectString(value, field);
};

const expectNumber = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Warm promotion field ${field} must be a finite number`);
  }
  return value;
};

const expectBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`Warm promotion field ${field} must be a boolean`);
  }
  return value;
};

const expectBooleanOrNull = (value: unknown, field: string): boolean | null => {
  if (value === null || value === undefined) {
    return null;
  }
  return expectBoolean(value, field);
};

const expectStringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Warm promotion field ${field} must be an array of strings`);
  }
  return value as string[];
};

const expectEnum = <T extends string>(value: unknown, allowed: readonly T[], field: string): T => {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`Warm promotion field ${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
};

const expectEnumArray = <T extends string>(value: unknown, allowed: readonly T[], field: string): T[] => {
  if (!Array.isArray(value)) {
    throw new Error(`Warm promotion field ${field} must be an array`);
  }
  return value.map((item, index) => expectEnum(item, allowed, `${field}[${index}]`));
};

const expectEmptyArray = (value: unknown, field: string): [] => {
  if (!Array.isArray(value) || value.length !== 0) {
    throw new Error(`Warm promotion field ${field} must be an empty array`);
  }
  return [];
};

export const parseWarmPromotionClassifierOutput = (value: unknown): WarmPromotionClassifierOutput => {
  const raw = expectRecord(value, "classifierOutput");
  const output: WarmPromotionClassifierOutput = {
    schemaVersion: expectEnum(
      raw.schemaVersion,
      [WARM_PROMOTION_CLASSIFIER_SCHEMA_VERSION],
      "classifierOutput.schemaVersion"
    ),
    authoritativeFields: expectEmptyArray(raw.authoritativeFields, "classifierOutput.authoritativeFields"),
    advisoryFields: expectEnumArray(raw.advisoryFields, CLASSIFIER_ADVISORY_FIELDS, "classifierOutput.advisoryFields"),
    inferredType: expectEnum(raw.inferredType, [...WARM_ENTRY_TYPES], "classifierOutput.inferredType"),
    topicTags: expectEnumArray(raw.topicTags, WARM_PROMOTION_TOPIC_TAGS, "classifierOutput.topicTags"),
    durabilityRecommendation: expectEnum(
      raw.durabilityRecommendation,
      DURABILITY_RECOMMENDATION_VALUES,
      "classifierOutput.durabilityRecommendation"
    ),
    confidence: expectNumber(raw.confidence, "classifierOutput.confidence"),
    supersedesEntryIds: expectStringArray(raw.supersedesEntryIds, "classifierOutput.supersedesEntryIds"),
    conflictsWithEntryIds: expectStringArray(raw.conflictsWithEntryIds, "classifierOutput.conflictsWithEntryIds"),
  };
  return validateWarmPromotionClassifierOutput(output);
};

export const parseWarmPromotionCandidate = (value: unknown): WarmPromotionCandidate => {
  const raw = expectRecord(value, "candidate");
  const source = expectRecord(raw.source, "candidate.source");
  const content = expectRecord(raw.content, "candidate.content");
  const inferred = expectRecord(raw.inferred, "candidate.inferred");
  const scoring = expectRecord(raw.scoring, "candidate.scoring");
  const relations = expectRecord(raw.relations, "candidate.relations");
  const contract = expectRecord(raw.classifierContract, "candidate.classifierContract");
  const contractInput = expectRecord(contract.input, "candidate.classifierContract.input");
  const contractSource = expectRecord(contractInput.source, "candidate.classifierContract.input.source");
  const contractInference = expectRecord(
    contractInput.currentInference,
    "candidate.classifierContract.input.currentInference"
  );

  const candidate: WarmPromotionCandidate = {
    schemaVersion: expectEnum(raw.schemaVersion, [WARM_PROMOTION_CANDIDATE_SCHEMA_VERSION], "candidate.schemaVersion"),
    candidateId: expectString(raw.candidateId, "candidate.candidateId"),
    reason: expectString(raw.reason, "candidate.reason"),
    source: {
      eventId: expectString(source.eventId, "candidate.source.eventId"),
      eventType: expectEnum(source.eventType, LIFECYCLE_EVENT_TYPE_VALUES, "candidate.source.eventType"),
      occurredAt: expectString(source.occurredAt, "candidate.source.occurredAt"),
      runtime: expectString(source.runtime, "candidate.source.runtime"),
      profileName: expectString(source.profileName, "candidate.source.profileName"),
      workspaceId: expectStringOrNull(source.workspaceId, "candidate.source.workspaceId"),
      sessionId: expectStringOrNull(source.sessionId, "candidate.source.sessionId"),
      turnId: expectStringOrNull(source.turnId, "candidate.source.turnId"),
      command: expectStringOrNull(source.command, "candidate.source.command"),
    },
    content: {
      text: expectString(content.text, "candidate.content.text"),
      hash: expectString(content.hash, "candidate.content.hash"),
    },
    deterministicTags: expectStringArray(raw.deterministicTags, "candidate.deterministicTags"),
    inferred: {
      type: expectEnum(inferred.type, [...WARM_ENTRY_TYPES], "candidate.inferred.type"),
      confidence: expectNumber(inferred.confidence, "candidate.inferred.confidence"),
      topicTags: expectEnumArray(inferred.topicTags, WARM_PROMOTION_TOPIC_TAGS, "candidate.inferred.topicTags"),
      durabilityRecommendation: expectEnum(
        inferred.durabilityRecommendation,
        DURABILITY_RECOMMENDATION_VALUES,
        "candidate.inferred.durabilityRecommendation"
      ),
      classifierSource: expectEnum(
        inferred.classifierSource,
        CLASSIFIER_SOURCE_VALUES,
        "candidate.inferred.classifierSource"
      ),
      authoritativeFields: expectEmptyArray(inferred.authoritativeFields, "candidate.inferred.authoritativeFields"),
      advisoryFields: expectEnumArray(
        inferred.advisoryFields,
        CLASSIFIER_ADVISORY_FIELDS,
        "candidate.inferred.advisoryFields"
      ),
    },
    scoring: {
      explicit: expectBoolean(scoring.explicit, "candidate.scoring.explicit"),
      approved: expectBoolean(scoring.approved, "candidate.scoring.approved"),
      taskSucceeded: expectBooleanOrNull(scoring.taskSucceeded, "candidate.scoring.taskSucceeded"),
      sourceQuality: expectEnum(scoring.sourceQuality, SOURCE_QUALITY_VALUES, "candidate.scoring.sourceQuality"),
      recurrenceKey: expectString(scoring.recurrenceKey, "candidate.scoring.recurrenceKey"),
    },
    relations: {
      supersedesEntryIds: expectStringArray(relations.supersedesEntryIds, "candidate.relations.supersedesEntryIds"),
      conflictsWithEntryIds: expectStringArray(
        relations.conflictsWithEntryIds,
        "candidate.relations.conflictsWithEntryIds"
      ),
    },
    classifierContract: {
      schemaVersion: expectEnum(
        contract.schemaVersion,
        [WARM_PROMOTION_CLASSIFIER_SCHEMA_VERSION],
        "candidate.classifierContract.schemaVersion"
      ),
      classifierOwner: expectEnum(contract.classifierOwner, ["onlybots_server"], "candidate.classifierContract.classifierOwner"),
      authoritativeFields: expectEmptyArray(
        contract.authoritativeFields,
        "candidate.classifierContract.authoritativeFields"
      ),
      advisoryFields: expectEnumArray(
        contract.advisoryFields,
        CLASSIFIER_ADVISORY_FIELDS,
        "candidate.classifierContract.advisoryFields"
      ),
      input: {
        candidateId: expectString(contractInput.candidateId, "candidate.classifierContract.input.candidateId"),
        content: expectString(contractInput.content, "candidate.classifierContract.input.content"),
        contentHash: expectString(contractInput.contentHash, "candidate.classifierContract.input.contentHash"),
        deterministicTags: expectStringArray(
          contractInput.deterministicTags,
          "candidate.classifierContract.input.deterministicTags"
        ),
        source: {
          eventType: expectEnum(
            contractSource.eventType,
            LIFECYCLE_EVENT_TYPE_VALUES,
            "candidate.classifierContract.input.source.eventType"
          ),
          runtime: expectString(contractSource.runtime, "candidate.classifierContract.input.source.runtime"),
          profileName: expectString(contractSource.profileName, "candidate.classifierContract.input.source.profileName"),
          workspaceId: expectStringOrNull(
            contractSource.workspaceId,
            "candidate.classifierContract.input.source.workspaceId"
          ),
          sessionId: expectStringOrNull(contractSource.sessionId, "candidate.classifierContract.input.source.sessionId"),
          turnId: expectStringOrNull(contractSource.turnId, "candidate.classifierContract.input.source.turnId"),
        },
        currentInference: {
          type: expectEnum(contractInference.type, [...WARM_ENTRY_TYPES], "candidate.classifierContract.input.currentInference.type"),
          confidence: expectNumber(
            contractInference.confidence,
            "candidate.classifierContract.input.currentInference.confidence"
          ),
          topicTags: expectEnumArray(
            contractInference.topicTags,
            WARM_PROMOTION_TOPIC_TAGS,
            "candidate.classifierContract.input.currentInference.topicTags"
          ),
          durabilityRecommendation: expectEnum(
            contractInference.durabilityRecommendation,
            DURABILITY_RECOMMENDATION_VALUES,
            "candidate.classifierContract.input.currentInference.durabilityRecommendation"
          ),
        },
      },
    },
  };

  validateWarmPromotionCandidate(candidate);
  return candidate;
};
