import { createHash } from "crypto";

import type { ContinuityStructuredSignalQuality, ContinuityStructuredSignals } from "../protocol/continuity-signals";

export const RUNTIME_CONTINUITY_OUTCOME_SCHEMA_VERSION = "runtime_continuity_outcome_v1";

export const RUNTIME_CONTINUITY_REFLECTION_DEFAULTS = {
  quietWindowMinutes: 10,
  sessionStopFastPathMinutes: 2,
  minNewOutcomesPerReflect: 2,
  continuousCatchUpWindowMinutes: 45,
  continuousCatchUpMaxMinutes: 60,
} as const;

export type RuntimeContinuityOutcomeEventType = "turn.completed" | "turn.failed" | "session.ended";
export type RuntimeContinuityOutcomeTrigger = "turn_checkpoint" | "session_stop";

export type RuntimeContinuityTranscriptEntry = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
};

export type RuntimeContinuityOutcomeEvent = {
  eventId: string;
  runtime: string;
  profileName: string;
  workspaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type RuntimeContinuityOutcome = {
  schemaVersion: typeof RUNTIME_CONTINUITY_OUTCOME_SCHEMA_VERSION;
  eventId: string;
  dedupeKey: string;
  trigger: RuntimeContinuityOutcomeTrigger;
  eventType: RuntimeContinuityOutcomeEventType;
  runtime: string;
  profileName: string;
  workspaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  occurredAt: string;
  packId: string | null;
  goal: string | null;
  summary: string;
  taskSucceeded: boolean | null;
  transcript: RuntimeContinuityTranscriptEntry[];
  signals: ContinuityStructuredSignals;
  signalQuality: ContinuityStructuredSignalQuality;
  minimumReflectionPayload: boolean;
  fastPathEligible: boolean;
};

const asString = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);

const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const normalizeTranscriptEntry = (value: unknown): RuntimeContinuityTranscriptEntry | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const role = entry.role;
  const content = asString(entry.content);
  if (!content || (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool")) {
    return null;
  }
  return {
    role,
    content,
    timestamp: asString(entry.timestamp) ?? undefined,
  };
};

const normalizeTranscript = (value: unknown): RuntimeContinuityTranscriptEntry[] =>
  Array.isArray(value)
    ? value.map((entry) => normalizeTranscriptEntry(entry)).filter((entry): entry is RuntimeContinuityTranscriptEntry => entry !== null)
    : [];

const normalizeStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))]
    : typeof value === "string" && value.trim().length > 0
      ? [value.trim()]
      : [];

const pickSignalList = (payload: Record<string, unknown>, ...keys: string[]): string[] => {
  for (const key of keys) {
    if (key in payload) {
      const normalized = normalizeStringList(payload[key]);
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }
  return [];
};

export const EMPTY_RUNTIME_CONTINUITY_SIGNALS: ContinuityStructuredSignals = {
  newFacts: [],
  newCommitments: [],
  communicationPreferences: [],
  userCalibration: [],
  projectDirection: [],
  openQuestions: [],
  rejectedAlternatives: [],
  unresolvedRisks: [],
  demonstratedKnowledge: [],
  recentCorrections: [],
  orientationDelta: [],
  redundancyMarkers: [],
  selfStrengths: [],
  selfFailureModes: [],
  selfCalibrationNotes: [],
  preferredEnvironments: [],
  selfBiasPatterns: [],
};

export const normalizeRuntimeContinuitySignals = (value: unknown): ContinuityStructuredSignals => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...EMPTY_RUNTIME_CONTINUITY_SIGNALS };
  }
  const payload = value as Record<string, unknown>;
  return {
    newFacts: pickSignalList(payload, "newFacts", "new_facts", "newFact", "new_fact"),
    newCommitments: pickSignalList(payload, "newCommitments", "new_commitments", "newCommitment", "new_commitment"),
    communicationPreferences: pickSignalList(payload, "communicationPreferences", "communication_preferences"),
    userCalibration: pickSignalList(payload, "userCalibration", "user_calibration"),
    projectDirection: pickSignalList(payload, "projectDirection", "project_direction"),
    openQuestions: pickSignalList(payload, "openQuestions", "open_questions"),
    rejectedAlternatives: pickSignalList(payload, "rejectedAlternatives", "rejected_alternatives"),
    unresolvedRisks: pickSignalList(payload, "unresolvedRisks", "unresolved_risks"),
    demonstratedKnowledge: pickSignalList(payload, "demonstratedKnowledge", "demonstrated_knowledge"),
    recentCorrections: pickSignalList(payload, "recentCorrections", "recent_corrections"),
    orientationDelta: pickSignalList(payload, "orientationDelta", "orientation_delta"),
    redundancyMarkers: pickSignalList(payload, "redundancyMarkers", "redundancy_markers"),
    selfStrengths: pickSignalList(payload, "selfStrengths", "self_strengths"),
    selfFailureModes: pickSignalList(payload, "selfFailureModes", "self_failure_modes"),
    selfCalibrationNotes: pickSignalList(payload, "selfCalibrationNotes", "self_calibration_notes"),
    preferredEnvironments: pickSignalList(payload, "preferredEnvironments", "preferred_environments"),
    selfBiasPatterns: pickSignalList(payload, "selfBiasPatterns", "self_bias_patterns"),
  };
};

const computeSignalQuality = (
  signals: ContinuityStructuredSignals,
  summary: string
): ContinuityStructuredSignalQuality => {
  const explicitSignalCount = Object.values(signals).reduce((total, entries) => total + entries.length, 0);
  return {
    explicitSignalCount,
    score: explicitSignalCount,
    usedSummaryFallback: explicitSignalCount === 0 && summary.trim().length > 0,
  };
};

const buildSummaryHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 12);

export const isRuntimeContinuityOutcomeEventType = (value: string): value is RuntimeContinuityOutcomeEventType =>
  value === "turn.completed" || value === "turn.failed" || value === "session.ended";

export const buildRuntimeContinuityOutcome = (event: RuntimeContinuityOutcomeEvent): RuntimeContinuityOutcome | null => {
  if (!isRuntimeContinuityOutcomeEventType(event.type)) {
    return null;
  }

  const packId = asString(event.payload.packId) ?? asString(event.payload.pack_id);
  const goal = asString(event.payload.goal) ?? asString(event.payload.prompt);
  const taskSucceeded =
    asBoolean(event.payload.taskSucceeded) ??
    asBoolean(event.payload.task_succeeded) ??
    (event.type === "turn.completed" ? true : event.type === "turn.failed" ? false : null);
  const summary =
    asString(event.payload.summary) ??
    asString(event.payload.result) ??
    (event.type === "session.ended"
      ? goal
        ? `Session ended after: ${goal}`
        : "Session ended."
      : event.type === "turn.failed"
        ? goal
          ? `Turn failed while trying to: ${goal}`
          : "Turn failed."
        : goal
          ? `Turn completed for: ${goal}`
          : "Turn completed.");
  const transcript = normalizeTranscript(event.payload.transcript);
  const signals = normalizeRuntimeContinuitySignals(event.payload);
  const signalQuality = computeSignalQuality(signals, summary);
  const trigger: RuntimeContinuityOutcomeTrigger = event.type === "session.ended" ? "session_stop" : "turn_checkpoint";
  const identityParts = [
    event.type,
    event.runtime,
    event.profileName,
    event.workspaceId ?? "-",
    event.sessionId ?? "-",
    event.type === "session.ended" ? "-" : event.turnId ?? "-",
    packId ?? "-",
    goal ?? "-",
    taskSucceeded === null ? "unknown" : taskSucceeded ? "success" : "failed",
  ];
  if (
    (event.type === "session.ended" && !event.sessionId && !packId) ||
    (event.type !== "session.ended" && !event.turnId && !packId)
  ) {
    identityParts.push(buildSummaryHash(summary));
  }

  return {
    schemaVersion: RUNTIME_CONTINUITY_OUTCOME_SCHEMA_VERSION,
    eventId: event.eventId,
    dedupeKey: identityParts.join(":"),
    trigger,
    eventType: event.type,
    runtime: event.runtime,
    profileName: event.profileName,
    workspaceId: event.workspaceId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    occurredAt: event.occurredAt,
    packId,
    goal,
    summary,
    taskSucceeded,
    transcript,
    signals,
    signalQuality,
    minimumReflectionPayload: packId !== null && goal !== null,
    fastPathEligible: event.type === "session.ended",
  };
};

export const parseRuntimeContinuityOutcome = (value: unknown): RuntimeContinuityOutcome | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const parsed = value as Record<string, unknown>;
  if (parsed.schemaVersion !== RUNTIME_CONTINUITY_OUTCOME_SCHEMA_VERSION) {
    return null;
  }

  const eventId = asString(parsed.eventId);
  const dedupeKey = asString(parsed.dedupeKey);
  const trigger = parsed.trigger;
  const eventTypeRaw = String(parsed.eventType ?? "");
  const runtime = asString(parsed.runtime);
  const profileName = asString(parsed.profileName);
  const occurredAt = asString(parsed.occurredAt);
  const summary = asString(parsed.summary);
  const signalSummary = summary ?? "";

  const signals = normalizeRuntimeContinuitySignals(parsed.signals ?? parsed);
  const parsedSignalQuality =
    parsed.signalQuality && typeof parsed.signalQuality === "object" && !Array.isArray(parsed.signalQuality)
      ? (parsed.signalQuality as Record<string, unknown>)
      : null;
  const signalQuality: ContinuityStructuredSignalQuality = {
    explicitSignalCount:
      parsedSignalQuality && Number.isInteger(parsedSignalQuality.explicitSignalCount)
        ? Number(parsedSignalQuality.explicitSignalCount)
        : computeSignalQuality(signals, signalSummary).explicitSignalCount,
    score:
      parsedSignalQuality && Number.isInteger(parsedSignalQuality.score)
        ? Number(parsedSignalQuality.score)
        : computeSignalQuality(signals, signalSummary).score,
    usedSummaryFallback:
      parsedSignalQuality?.usedSummaryFallback === true
        ? true
        : computeSignalQuality(signals, signalSummary).usedSummaryFallback,
  };

  if (
    !eventId ||
    !dedupeKey ||
    (trigger !== "turn_checkpoint" && trigger !== "session_stop") ||
    !isRuntimeContinuityOutcomeEventType(eventTypeRaw) ||
    !runtime ||
    !profileName ||
    !occurredAt ||
    !summary
  ) {
    return null;
  }

  return {
    schemaVersion: RUNTIME_CONTINUITY_OUTCOME_SCHEMA_VERSION,
    eventId,
    dedupeKey,
    trigger,
    eventType: eventTypeRaw,
    runtime,
    profileName,
    workspaceId: asString(parsed.workspaceId),
    sessionId: asString(parsed.sessionId),
    turnId: asString(parsed.turnId),
    occurredAt,
    packId: asString(parsed.packId),
    goal: asString(parsed.goal),
    summary,
    taskSucceeded: asBoolean(parsed.taskSucceeded),
    transcript: normalizeTranscript(parsed.transcript),
    signals,
    signalQuality,
    minimumReflectionPayload: parsed.minimumReflectionPayload === true,
    fastPathEligible: parsed.fastPathEligible === true,
  };
};

export const parseRuntimeContinuityOutcomeContent = (content: string): RuntimeContinuityOutcome | null => {
  const parsed = parseJsonObject(content);
  return parsed ? parseRuntimeContinuityOutcome(parsed) : null;
};
