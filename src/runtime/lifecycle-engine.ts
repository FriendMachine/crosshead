import { getHotSyncManager, hotSyncEnabled, tickHotSyncManagers } from "./hot-sync-manager";
import { encodeArchivedTurn } from "./continuity-recall";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";

import type { ColdItemRole } from "../protocol/memory";
import type { CollaborationEventPriority, TypedInboxEventType } from "../protocol/collaboration";
import type { DurableInboxStatus } from "../protocol/inbox";
import type { Npub } from "../protocol/base";
import { COLLABORATION_EVENT_PRIORITIES } from "../protocol/collaboration";
import { DURABLE_INBOX_STATUSES, DURABLE_INBOX_TERMINAL_STATUSES } from "../protocol/inbox";
import { HOT_SCOPE_ALL } from "../protocol/memory";
import { captureHotFinding, renderHotCheckpoints, selectHotCheckpoints, updateHotCheckpoints } from "./hot-continuity";
import { normalizeTaskEvidence } from "./task-evidence";
import {
  buildHotContextActionCue,
  extractHotContextProjectPaths,
  pickHotContextValidationCommand,
} from "./hot-context-cues";
import { buildRuntimeBillingRemediation, formatRuntimeBillingRemediation, isBillingBlockedError } from "./billing-remediation";
import { describeBoundedRecallFallback, describeHostedFailure, HostedOnlyBotsClient, type HostedSession } from "./hosted-client";
import { isLocalOnlyRuntimeProfile, readLocalHotMemory, writeLocalHotMemory } from "./local-hot-memory";
import { workspaceHotScope, selectWorkspaceHotState } from "./workspace-hot-memory";
import { buildRuntimeContinuityOutcome, parseRuntimeContinuityOutcomeContent } from "./continuity-outcomes";
import {
  buildWarmPromotionCandidates,
  type WarmPromotionCandidate,
} from "./warm-memory-promotion";
import {
  automaticColdBatchDecision,
  automaticHotWritesEnabled,
  automaticWarmCommitDecision,
} from "./continuity-policy";
import type { ContinuityGovernorMemoryScope, ContinuityGovernorState } from "./continuity-governor";
import { appendPrivateFileLine, writeJsonFile as writeDurableJsonFile } from "./runtime-persistence";

export type RuntimeLifecycleMemoryMode = "off" | "manual" | "assist" | "auto";

export type RuntimeLifecycleProfile = {
  name: string;
  apiBase: string;
  npub: string;
  memoryMode: RuntimeLifecycleMemoryMode;
  features: {
    coldSync: boolean;
    autoWarmPromotion: boolean;
  };
};

export type RuntimeLifecycleSecret = {
  nsec: string;
  session: HostedSession | null;
};

export type RuntimeLifecycleHealthState = {
  queueDepth: number;
  pendingHotWrites?: number;
  pendingColdBatches?: number;
  retryingItems?: number;
  backpressure?: boolean;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
};

export type RuntimeInboxHudItem = {
  inboxId: string;
  messageEventId: string;
  status: DurableInboxStatus;
  priority: CollaborationEventPriority | null;
  eventType: TypedInboxEventType | null;
  senderNpub: Npub;
  taskRef: string | null;
  contextId: string | null;
  createdAt: string;
  updatedAt: string;
  summary: string;
  isNew: boolean;
};

export type RuntimeInboxHudSummary = {
  total: number;
  active: number;
  unread: number;
  acknowledged: number;
  terminal: number;
  deadLetter: number;
  statusCounts: Record<DurableInboxStatus, number>;
  priorityCounts: Record<CollaborationEventPriority, number>;
  eventTypeCounts: Partial<Record<TypedInboxEventType, number>>;
  highestActivePriority: CollaborationEventPriority | null;
  oldestActiveCreatedAt: string | null;
  newestActiveCreatedAt: string | null;
  sampledActiveCount: number;
  truncated: boolean;
};

export type RuntimeInboxHudState = {
  refreshedAt: string;
  source: "live" | "cached";
  stale: boolean;
  fetchError: string | null;
  summary: RuntimeInboxHudSummary;
  newSinceLastAnnouncement: number;
  lastAnnouncedAt: string | null;
  topItems: RuntimeInboxHudItem[];
};

export type RuntimeDreamProposalType =
  | "warm_memory"
  | "policy_patch"
  | "self_model"
  | "capability_refinement"
  | "staleness_marker"
  | "dream_connection"
  | "dream_story";

export type RuntimeDreamReviewHudItem = {
  proposalId: string;
  proposalType: RuntimeDreamProposalType;
  createdAt: string;
  confidence: number;
  utilityScore?: number | null;
  summary: string;
  isNew: boolean;
};

export type RuntimeDreamReviewHudSummary = {
  pending: number;
  pendingByType: Record<RuntimeDreamProposalType, number>;
  oldestPendingCreatedAt: string | null;
  newestPendingCreatedAt: string | null;
  sampledPendingCount: number;
  truncated: boolean;
};

export type RuntimeDreamReviewHudState = {
  refreshedAt: string;
  source: "live" | "cached";
  stale: boolean;
  fetchError: string | null;
  summary: RuntimeDreamReviewHudSummary;
  newSinceLastAnnouncement: number;
  lastAnnouncedAt: string | null;
  topItems: RuntimeDreamReviewHudItem[];
};

export type RuntimeObligationsHudItem = {
  id: string;
  title: string;
  status: string; // "scheduled" | "due"
  actionMode: string; // "remind" | "propose" | "auto"
  nextFireAt: string | null;
};

export type RuntimeObligationsHudSummary = {
  total: number;
  active: number;
  due: number;
  scheduled: number;
  nextFireAt: string | null;
};

export type RuntimeObligationsHudState = {
  refreshedAt: string;
  source: "live" | "cached";
  stale: boolean;
  fetchError: string | null;
  summary: RuntimeObligationsHudSummary;
  topItems: RuntimeObligationsHudItem[];
};

export type RuntimeLifecycleEventType =
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

export type RuntimeLifecycleEventRequest = {
  eventId?: string;
  runtime: string;
  profileName?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  type: RuntimeLifecycleEventType;
  occurredAt?: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type RuntimeLifecycleEvent = {
  eventId: string;
  runtime: string;
  profileName: string;
  workspaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  type: RuntimeLifecycleEventType;
  occurredAt: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type RuntimeMemoryActionType =
  | "inbox_refresh"
  | "dream_refresh"
  | "obligations_refresh"
  | "context_pack"
  | "context_reflect"
  | "hot_write"
  | "warm_proposal"
  | "warm_commit"
  | "cold_batch"
  | "mode_skip"
  | "queue_retry"
  | "queue_dead_letter"
  | "duplicate_event";

export type RuntimeMemoryActionStatus = "completed" | "queued" | "skipped" | "retrying" | "failed";

export type RuntimeMemoryActionRecord = {
  id: string;
  eventId: string | null;
  profileName: string;
  type: RuntimeMemoryActionType;
  status: RuntimeMemoryActionStatus;
  mode: RuntimeLifecycleMemoryMode;
  reason: string;
  createdAt: string;
  queueItemId: string | null;
  details: Record<string, unknown>;
};

export type RuntimeLifecycleActivity = {
  events: RuntimeLifecycleEvent[];
  actions: RuntimeMemoryActionRecord[];
};

export type RuntimeLifecycleEventResponse = {
  accepted: boolean;
  event: RuntimeLifecycleEvent;
  mode: RuntimeLifecycleMemoryMode;
  queueDepth: number;
  pendingHotWrites: number;
  pendingColdBatches: number;
  backpressure: boolean;
  inbox: RuntimeInboxHudState | null;
  dreamReview: RuntimeDreamReviewHudState | null;
  obligations: RuntimeObligationsHudState | null;
  contextPack: Record<string, unknown> | null;
  actions: RuntimeMemoryActionRecord[];
  warnings: string[];
};

type RuntimeColdBatchItem = {
  timestamp: string;
  role: ColdItemRole | null;
  content: string;
};

type RuntimeQueueItem =
  | {
      id: string;
      key: string;
      kind: "hot_write";
      profileName: string;
      eventId: string;
      sessionId: string | null;
      workspaceId: string | null;
      createdAt: string;
      availableAt: string;
      attempts: number;
      payload: {
        hotState: Record<string, unknown>;
        // Per-body hot-memory scope (runtime host); omitted => shared default on the server.
        scope?: string;
      };
    }
  | {
      id: string;
      key: string;
      kind: "cold_batch";
      profileName: string;
      eventId: string;
      sessionId: string | null;
      workspaceId: string | null;
      createdAt: string;
      availableAt: string;
      attempts: number;
      payload: {
        items: RuntimeColdBatchItem[];
      };
    }
  | {
      id: string;
      key: string;
      kind: "warm_commit";
      profileName: string;
      eventId: string;
      sessionId: string | null;
      workspaceId: string | null;
      createdAt: string;
      availableAt: string;
      attempts: number;
      payload: {
        candidate: WarmPromotionCandidate;
      };
    };

type RuntimeQueueState = {
  items: RuntimeQueueItem[];
  processedEventIds: string[];
};

type RuntimeInboxHudProfileState = {
  snapshot: RuntimeInboxHudState | null;
  lastAnnouncedActiveIds: string[];
  lastAnnouncedAt: string | null;
};

type RuntimeInboxHudStore = {
  schemaVersion: "runtime_inbox_hud_v1";
  profiles: Record<string, RuntimeInboxHudProfileState>;
};

type RuntimeDreamReviewHudProfileState = {
  snapshot: RuntimeDreamReviewHudState | null;
  lastAnnouncedProposalIds: string[];
  lastAnnouncedAt: string | null;
};

type RuntimeDreamReviewHudStore = {
  schemaVersion: "runtime_dream_review_hud_v1";
  profiles: Record<string, RuntimeDreamReviewHudProfileState>;
};

type RuntimeLifecycleDeps = {
  paths: {
    state: string;
  };
  loadDefaultProfileName: () => string | null;
  loadProfile: (name: string) => RuntimeLifecycleProfile | null;
  loadSecret: (name: string) => RuntimeLifecycleSecret | null;
  saveSecret: (name: string, secret: RuntimeLifecycleSecret) => void;
  loadHealth: () => RuntimeLifecycleHealthState;
  saveHealth: (state: RuntimeLifecycleHealthState) => void;
  loadContinuityGovernorState: () => ContinuityGovernorState;
  writeLog: (event: string, payload: Record<string, unknown>) => void;
  now?: () => Date;
  hotWriteDebounceMs?: number;
  coldBatchWindowMs?: number;
  workerIntervalMs?: number;
  maxQueueDepth?: number;
  maxQueueAttempts?: number;
};

const DEFAULT_HOT_WRITE_DEBOUNCE_MS = 1_250;
const DEFAULT_COLD_BATCH_WINDOW_MS = 2_000;
const DEFAULT_WORKER_INTERVAL_MS = 500;
const DEFAULT_MAX_QUEUE_DEPTH = 50;
const DEFAULT_MAX_QUEUE_ATTEMPTS = 10;
const MAX_TRACKED_EVENT_IDS = 1_000;
const INBOX_HUD_SAMPLE_LIMIT = 50;
const INBOX_HUD_TOP_ITEMS = 3;
const MAX_TRACKED_ANNOUNCED_INBOX_IDS = 200;
const DREAM_REVIEW_HUD_TOP_ITEMS = 3;
const MAX_TRACKED_ANNOUNCED_DREAM_PROPOSAL_IDS = 200;
const OBLIGATIONS_HUD_SAMPLE_LIMIT = 50;
const OBLIGATIONS_HUD_TOP_ITEMS = 3;

const queueFile = (stateDir: string): string => path.join(stateDir, "queue.json");
const eventsFile = (stateDir: string): string => path.join(stateDir, "lifecycle-events.jsonl");
const actionsFile = (stateDir: string): string => path.join(stateDir, "memory-actions.jsonl");
const inboxHudFile = (stateDir: string): string => path.join(stateDir, "inbox-hud.json");
const dreamReviewHudFile = (stateDir: string): string => path.join(stateDir, "dream-review-hud.json");

const parseJsonFile = <T>(filePath: string, fallback: T): T => {
  if (!existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
};

const writeJsonFile = (filePath: string, value: unknown): void => {
  writeDurableJsonFile(filePath, value);
};

const appendJsonLine = (filePath: string, value: unknown): void => {
  appendPrivateFileLine(filePath, JSON.stringify(value));
};

const readJsonLines = <T>(filePath: string, lines: number): T[] => {
  if (!existsSync(filePath)) {
    return [];
  }
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((entry) => entry.trim().length > 0)
    .slice(-Math.max(1, lines))
    .map((entry) => JSON.parse(entry) as T);
};

const emptyInboxStatusCounts = (): Record<DurableInboxStatus, number> =>
  Object.fromEntries(DURABLE_INBOX_STATUSES.map((status) => [status, 0])) as Record<DurableInboxStatus, number>;

const emptyInboxPriorityCounts = (): Record<CollaborationEventPriority, number> =>
  Object.fromEntries(
    COLLABORATION_EVENT_PRIORITIES.map((priority) => [priority, 0])
  ) as Record<CollaborationEventPriority, number>;

const normalizeRuntimeInboxHudStore = (value: unknown): RuntimeInboxHudStore => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      schemaVersion: "runtime_inbox_hud_v1",
      profiles: {},
    };
  }
  const raw = value as Record<string, unknown>;
  return {
    schemaVersion: "runtime_inbox_hud_v1",
    profiles:
      raw.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles)
		? (raw.profiles as Record<string, RuntimeInboxHudProfileState>)
		: {},
  };
};

const loadRuntimeInboxHudStore = (stateDir: string): RuntimeInboxHudStore =>
  normalizeRuntimeInboxHudStore(parseJsonFile(inboxHudFile(stateDir), { schemaVersion: "runtime_inbox_hud_v1", profiles: {} }));

const saveRuntimeInboxHudStore = (stateDir: string, store: RuntimeInboxHudStore): void => {
  writeJsonFile(inboxHudFile(stateDir), store);
};

export const readRuntimeInboxHudSnapshot = (stateDir: string, profileName: string): RuntimeInboxHudState | null => {
  const store = loadRuntimeInboxHudStore(stateDir);
  return store.profiles[profileName]?.snapshot ?? null;
};

const updateRuntimeInboxHudProfileState = (
  stateDir: string,
  profileName: string,
  mutate: (current: RuntimeInboxHudProfileState) => RuntimeInboxHudProfileState
): RuntimeInboxHudProfileState => {
  const store = loadRuntimeInboxHudStore(stateDir);
  const current = store.profiles[profileName] ?? {
    snapshot: null,
    lastAnnouncedActiveIds: [],
    lastAnnouncedAt: null,
  };
  const next = mutate(current);
  store.profiles[profileName] = next;
  saveRuntimeInboxHudStore(stateDir, store);
  return next;
};

const emptyDreamReviewPendingByType = (): Record<RuntimeDreamProposalType, number> => ({
  warm_memory: 0,
  policy_patch: 0,
  self_model: 0,
  capability_refinement: 0,
  staleness_marker: 0,
  dream_connection: 0,
  dream_story: 0,
});

const normalizeRuntimeDreamReviewHudStore = (value: unknown): RuntimeDreamReviewHudStore => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      schemaVersion: "runtime_dream_review_hud_v1",
      profiles: {},
    };
  }
  const raw = value as Record<string, unknown>;
  return {
    schemaVersion: "runtime_dream_review_hud_v1",
    profiles:
      raw.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles)
        ? (raw.profiles as Record<string, RuntimeDreamReviewHudProfileState>)
        : {},
  };
};

const loadRuntimeDreamReviewHudStore = (stateDir: string): RuntimeDreamReviewHudStore =>
  normalizeRuntimeDreamReviewHudStore(
    parseJsonFile(dreamReviewHudFile(stateDir), { schemaVersion: "runtime_dream_review_hud_v1", profiles: {} })
  );

const saveRuntimeDreamReviewHudStore = (stateDir: string, store: RuntimeDreamReviewHudStore): void => {
  writeJsonFile(dreamReviewHudFile(stateDir), store);
};

export const readRuntimeDreamReviewHudSnapshot = (
  stateDir: string,
  profileName: string
): RuntimeDreamReviewHudState | null => {
  const store = loadRuntimeDreamReviewHudStore(stateDir);
  return store.profiles[profileName]?.snapshot ?? null;
};

const updateRuntimeDreamReviewHudProfileState = (
  stateDir: string,
  profileName: string,
  mutate: (current: RuntimeDreamReviewHudProfileState) => RuntimeDreamReviewHudProfileState
): RuntimeDreamReviewHudProfileState => {
  const store = loadRuntimeDreamReviewHudStore(stateDir);
  const current = store.profiles[profileName] ?? {
    snapshot: null,
    lastAnnouncedProposalIds: [],
    lastAnnouncedAt: null,
  };
  const next = mutate(current);
  store.profiles[profileName] = next;
  saveRuntimeDreamReviewHudStore(stateDir, store);
  return next;
};

export const updateRuntimeDreamReviewHudSnapshotFromInspection = (
  stateDir: string,
  profileName: string,
  inspection: unknown,
  refreshedAt: string = new Date().toISOString()
): RuntimeDreamReviewHudState => {
  const currentProfileState = loadRuntimeDreamReviewHudStore(stateDir).profiles[profileName] ?? {
    snapshot: null,
    lastAnnouncedProposalIds: [],
    lastAnnouncedAt: null,
  };
  const parsed = parseDreamReviewHud(inspection, currentProfileState.lastAnnouncedProposalIds);
  const snapshot: RuntimeDreamReviewHudState = {
    refreshedAt,
    source: "live",
    stale: false,
    fetchError: null,
    summary: parsed.summary,
    newSinceLastAnnouncement: parsed.pendingIds.filter(
      (proposalId) => !currentProfileState.lastAnnouncedProposalIds.includes(proposalId)
    ).length,
    lastAnnouncedAt: currentProfileState.lastAnnouncedAt,
    topItems: parsed.topItems,
  };

  updateRuntimeDreamReviewHudProfileState(stateDir, profileName, (current) => ({
    ...current,
    snapshot,
  }));

  return snapshot;
};

const sanitizeString = (value: string): string =>
  value
    .replace(/ob_sess_[A-Za-z0-9_-]+/g, "[redacted-session]")
    .replace(/nsec1[0-9a-z]+/gi, "[redacted-nsec]");

const sanitizeValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }
  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = /secret|token|session|nsec/i.test(key) ? "[redacted]" : sanitizeValue(entry);
    }
    return sanitized;
  }
  return value;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asNumber = (value: unknown, fallback: number = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const trimSummary = (value: string, maxLength: number = 140): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};

const parseObligationsHudSummary = (value: unknown): RuntimeObligationsHudSummary => {
  const record = asRecord(value);
  return {
    total: asNumber(record?.total),
    active: asNumber(record?.active),
    due: asNumber(record?.due),
    scheduled: asNumber(record?.scheduled),
    nextFireAt: typeof record?.nextFireAt === "string" ? record.nextFireAt : null,
  };
};

const parseObligationsHudItems = (value: unknown): RuntimeObligationsHudItem[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: RuntimeObligationsHudItem[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const status = typeof record.status === "string" ? record.status : "";
    if (status !== "scheduled" && status !== "due") {
      continue; // only armed obligations are HUD-worthy
    }
    items.push({
      id: typeof record.id === "string" ? record.id : "",
      title: typeof record.title === "string" ? trimSummary(record.title, 80) : "(untitled)",
      status,
      actionMode: typeof record.actionMode === "string" ? record.actionMode : "remind",
      nextFireAt: typeof record.nextFireAt === "string" ? record.nextFireAt : null,
    });
  }
  items.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === "due" ? -1 : 1;
    }
    const at = a.nextFireAt ? Date.parse(a.nextFireAt) : Number.POSITIVE_INFINITY;
    const bt = b.nextFireAt ? Date.parse(b.nextFireAt) : Number.POSITIVE_INFINITY;
    return at - bt;
  });
  return items.slice(0, OBLIGATIONS_HUD_TOP_ITEMS);
};

const parseInboxHudSummary = (value: unknown): RuntimeInboxHudSummary => {
  const record = asRecord(value);
  const statusCountsRecord = asRecord(record?.statusCounts);
  const priorityCountsRecord = asRecord(record?.priorityCounts);
  const eventTypeCountsRecord = asRecord(record?.eventTypeCounts);
  return {
    total: asNumber(record?.total, 0),
    active: asNumber(record?.active, 0),
    unread: asNumber(record?.unread, 0),
    acknowledged: asNumber(record?.acknowledged, 0),
    terminal: asNumber(record?.terminal, 0),
    deadLetter: asNumber(record?.deadLetter, 0),
    statusCounts: Object.fromEntries(
      DURABLE_INBOX_STATUSES.map((status) => [status, asNumber(statusCountsRecord?.[status], 0)])
    ) as Record<DurableInboxStatus, number>,
    priorityCounts: Object.fromEntries(
      COLLABORATION_EVENT_PRIORITIES.map((priority) => [priority, asNumber(priorityCountsRecord?.[priority], 0)])
    ) as Record<CollaborationEventPriority, number>,
    eventTypeCounts: Object.fromEntries(
      Object.entries(eventTypeCountsRecord ?? {}).filter(
		([key, count]) => typeof key === "string" && typeof count === "number"
      )
    ) as Partial<Record<TypedInboxEventType, number>>,
    highestActivePriority:
      typeof record?.highestActivePriority === "string"
		? (record.highestActivePriority as CollaborationEventPriority)
		: null,
    oldestActiveCreatedAt: asString(record?.oldestActiveCreatedAt),
    newestActiveCreatedAt: asString(record?.newestActiveCreatedAt),
    sampledActiveCount: 0,
    truncated: false,
  };
};

const parseInboxHudItems = (
  value: unknown,
  lastAnnouncedActiveIds: string[]
): { activeIds: string[]; topItems: RuntimeInboxHudItem[]; sampledActiveCount: number } => {
  const activeIds: string[] = [];
  const topItems: RuntimeInboxHudItem[] = [];
  if (!Array.isArray(value)) {
    return {
      activeIds,
      topItems,
      sampledActiveCount: 0,
    };
  }

  for (const entry of value) {
    const item = asRecord(entry);
    if (!item || typeof item.id !== "string" || typeof item.messageEventId !== "string" || typeof item.senderNpub !== "string") {
      continue;
    }
    const status =
      typeof item.status === "string" && DURABLE_INBOX_STATUSES.includes(item.status as DurableInboxStatus)
		? (item.status as DurableInboxStatus)
		: "unread";
    const active = !DURABLE_INBOX_TERMINAL_STATUSES.includes(status as (typeof DURABLE_INBOX_TERMINAL_STATUSES)[number]);
    if (active) {
      activeIds.push(item.id);
    }
    if (topItems.length >= INBOX_HUD_TOP_ITEMS) {
      continue;
    }
    const inboxEvent = asRecord(item.inboxEvent);
    const rawSummary =
      asString(inboxEvent?.summary) ??
      asString(item.plaintext) ??
      asString(item.taskRef) ??
      `${status} inbox item`;
    topItems.push({
      inboxId: item.id,
      messageEventId: item.messageEventId,
      status,
      priority:
		typeof item.priority === "string" ? (item.priority as CollaborationEventPriority) : null,
      eventType:
		typeof inboxEvent?.eventType === "string" ? (inboxEvent.eventType as TypedInboxEventType) : null,
      senderNpub: item.senderNpub as Npub,
      taskRef: asString(item.taskRef),
      contextId: asString(item.contextId),
      createdAt: asString(item.createdAt) ?? new Date(0).toISOString(),
      updatedAt: asString(item.updatedAt) ?? asString(item.createdAt) ?? new Date(0).toISOString(),
      summary: trimSummary(rawSummary),
      isNew: active && !lastAnnouncedActiveIds.includes(item.id),
    });
  }

  return {
    activeIds,
    topItems,
    sampledActiveCount: activeIds.length,
  };
};

const isRuntimeDreamProposalType = (value: unknown): value is RuntimeDreamProposalType =>
  value === "warm_memory" ||
  value === "policy_patch" ||
  value === "self_model" ||
  value === "capability_refinement" ||
  value === "staleness_marker" ||
  value === "dream_connection" ||
  value === "dream_story";

const parseDreamReviewHud = (
  value: unknown,
  lastAnnouncedProposalIds: string[]
): { summary: RuntimeDreamReviewHudSummary; topItems: RuntimeDreamReviewHudItem[]; pendingIds: string[] } => {
  const record = asRecord(value);
  const pendingByType = emptyDreamReviewPendingByType();
  const pendingIds: string[] = [];
  const topItems: RuntimeDreamReviewHudItem[] = [];
  let oldestPendingCreatedAt: string | null = null;
  let newestPendingCreatedAt: string | null = null;

  const proposals = Array.isArray(record?.proposals) ? record.proposals : [];
  for (const entry of proposals) {
    const proposal = asRecord(entry);
    if (!proposal || typeof proposal.proposalId !== "string" || !isRuntimeDreamProposalType(proposal.proposalType)) {
      continue;
    }
    if (proposal.status !== "pending") {
      continue;
    }
    const createdAt = asString(proposal.createdAt) ?? new Date(0).toISOString();
    pendingIds.push(proposal.proposalId);
    pendingByType[proposal.proposalType] += 1;
    if (oldestPendingCreatedAt === null || createdAt.localeCompare(oldestPendingCreatedAt) < 0) {
      oldestPendingCreatedAt = createdAt;
    }
    if (newestPendingCreatedAt === null || createdAt.localeCompare(newestPendingCreatedAt) > 0) {
      newestPendingCreatedAt = createdAt;
    }
    if (topItems.length >= DREAM_REVIEW_HUD_TOP_ITEMS) {
      continue;
    }
    const payload = asRecord(proposal.payload);
    const utilityScore = asNumber(payload?.utilityScore, Number.NaN);
    topItems.push({
      proposalId: proposal.proposalId,
      proposalType: proposal.proposalType,
      createdAt,
      confidence: asNumber(proposal.confidence, 0),
      utilityScore: Number.isFinite(utilityScore) ? utilityScore : null,
      summary: trimSummary(asString(proposal.summary) ?? `${proposal.proposalType} proposal`),
      isNew: !lastAnnouncedProposalIds.includes(proposal.proposalId),
    });
  }

  const countsRecord = asRecord(record?.counts);
  const pendingCount = asNumber(countsRecord?.pending, pendingIds.length);
  return {
    summary: {
      pending: pendingCount,
      pendingByType,
      oldestPendingCreatedAt,
      newestPendingCreatedAt,
      sampledPendingCount: pendingIds.length,
      truncated: pendingCount > pendingIds.length,
    },
    topItems,
    pendingIds,
  };
};

const normalizeQueueState = (value: unknown): RuntimeQueueState => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { items: [], processedEventIds: [] };
  }
  const raw = value as Record<string, unknown>;
  return {
    items: Array.isArray(raw.items) ? (raw.items as RuntimeQueueItem[]) : [],
    processedEventIds: Array.isArray(raw.processedEventIds)
      ? (raw.processedEventIds as string[]).filter((entry) => typeof entry === "string")
      : [],
  };
};

const parseIsoOrNow = (value: string | undefined, now: () => Date): string => {
  if (!value) {
    return now().toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? now().toISOString() : parsed.toISOString();
};

const asBoolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

const normalizeFeedback = (value: unknown): Array<Record<string, unknown>> | undefined =>
  Array.isArray(value)
    ? value
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => entry as Record<string, unknown>)
    : undefined;

const normalizeTranscriptItem = (entry: Record<string, unknown>): RuntimeColdBatchItem | null => {
  const content = asString(entry.content);
  if (!content) {
    return null;
  }
  const role = entry.role;
  const normalizedRole =
    role === "user" || role === "assistant" || role === "tool" || role === "system" ? role : null;
  return {
    timestamp: parseIsoOrNow(asString(entry.timestamp) ?? undefined, () => new Date()),
    role: normalizedRole,
    content,
  };
};

const parseStructuredHotState = (content: string): Record<string, unknown> => {
  if (content.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to text wrapper.
  }
  return { notes: content };
};

const boundedRecentEvents = (value: unknown, nextEntry: Record<string, unknown>): Record<string, unknown>[] => {
  const current =
    Array.isArray(value) && value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      ? (value as Record<string, unknown>[])
      : [];
  return [...current.slice(-4), nextEntry];
};

const buildHotState = (
  currentHot: Record<string, unknown>,
  event: RuntimeLifecycleEvent
): Record<string, unknown> => {
  const currentWorkspaceId = asString(currentHot.workspaceId) ?? asString(currentHot.workspace_id);
  const baseHot = event.workspaceId && currentWorkspaceId !== event.workspaceId ? {} : currentHot;
  const payload = event.payload;
  const continuityOutcome = buildRuntimeContinuityOutcome(event);
  const summary =
    continuityOutcome?.summary ??
    asString(payload.summary) ??
    asString(payload.result) ??
    asString(payload.goal) ??
    asString(payload.command) ??
    `${event.type}`;
  const nextState: Record<string, unknown> = {
    ...baseHot,
    runtime: event.runtime,
    profileName: event.profileName,
    workspaceId: event.workspaceId,
    sessionId: event.sessionId,
    updatedAt: event.occurredAt,
    currentGoal: continuityOutcome?.goal ?? asString(payload.goal) ?? baseHot.currentGoal ?? null,
    lastEvent: {
      type: event.type,
      turnId: event.turnId,
      summary,
      occurredAt: event.occurredAt,
    },
    recentEvents: boundedRecentEvents(baseHot.recentEvents, {
      type: event.type,
      summary,
      occurredAt: event.occurredAt,
    }),
  };

  if (event.type === "task.changed") {
    nextState.currentTask = asString(payload.taskTitle) ?? asString(payload.task) ?? summary;
  }
  if (event.type === "tool.completed") {
    nextState.lastTool = {
      name: asString(payload.toolName) ?? asString(payload.tool_name) ?? "tool",
      summary,
      occurredAt: event.occurredAt,
    };
  }
  if (event.type === "turn.completed" || event.type === "turn.failed") {
    nextState.lastTurn = {
      turnId: event.turnId,
      summary,
      occurredAt: event.occurredAt,
      status: event.type === "turn.completed" ? "completed" : "failed",
    };
  }
  if (event.type === "session.ended") {
    const turnSummary = asString(payload.turnSummary) ?? asString(payload.turn_summary);
    if (turnSummary) {
      nextState.lastTurn = {
        turnId: event.turnId,
        summary: turnSummary,
        occurredAt: event.occurredAt,
        status: payload.turnStatus === "failed" || payload.turn_status === "failed" ? "failed" : "completed",
      };
    }
  }
  if (event.type === "compact.started" || event.type === "compact.completed") {
    nextState.lastCompaction = {
      status: event.type === "compact.started" ? "started" : "completed",
      trigger: asString(payload.trigger) ?? asString(payload.source) ?? asString(payload.reason) ?? null,
      turnId: event.turnId,
      summary,
      occurredAt: event.occurredAt,
    };
  }
  if (event.type === "session.ended") {
    nextState.lastSession = {
      sessionId: event.sessionId,
      summary,
      occurredAt: event.occurredAt,
      taskSucceeded: continuityOutcome?.taskSucceeded ?? null,
      fastPathEligible: continuityOutcome?.fastPathEligible ?? false,
    };
  }

  if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "session.ended" || event.type === "compact.started") {
    const transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
    const assistant = transcript.slice().reverse().map(asRecord).find((item) => item?.role === "assistant");
    const finding = asString(payload.turnSummary) ?? asString(payload.turn_summary) ?? asString(payload.summary) ?? asString(assistant?.content) ?? summary;
    // Lifecycle acknowledgments describe transport, not findings. They must not
    // replace a completed turn's substantive checkpoint.
    const evidence = normalizeTaskEvidence(payload.taskEvidence);
    if (evidence?.sources.length || (event.type !== "compact.started" && !/^(?:(?:Codex|Claude Code)\s+)?(?:session (?:started|ended)|(?:completed|failed) a hooked turn)[.!\s]/i.test(finding))) {
      nextState.continuityCheckpoints = updateHotCheckpoints(baseHot.continuityCheckpoints, {
	runtime: event.runtime, workspaceId: event.workspaceId, sessionId: event.sessionId,
	turnId: event.turnId, goal: continuityOutcome?.goal ?? asString(payload.goal) ?? "",
	summary: captureHotFinding(finding), occurredAt: event.occurredAt,
	...(evidence ? { evidence } : {}),
      });
    }
  }

  return nextState;
};

const mergeAllowedScopeWithGovernor = (
  requested: unknown,
  scope: ContinuityGovernorMemoryScope
): Record<string, boolean> => {
  const allowedScope =
    requested && typeof requested === "object" && !Array.isArray(requested) ? (requested as Record<string, unknown>) : {};
  const include = (key: keyof ContinuityGovernorMemoryScope): boolean => {
    const requestedValue = allowedScope[key];
    return (typeof requestedValue === "boolean" ? requestedValue : true) && scope[key];
  };

  return {
    includeHotMemory: include("includeHotMemory"),
    includeWarmMemory: include("includeWarmMemory"),
    includeColdMemory: include("includeColdMemory"),
    includeLayeredContext: include("includeLayeredContext"),
  };
};

const buildPackRequest = (
  event: RuntimeLifecycleEvent,
  governorScope: ContinuityGovernorMemoryScope
): Record<string, unknown> | null => {
  const goal =
    asString(event.payload.goal) ??
    asString(event.payload.prompt) ??
    asString(event.payload.summary) ??
    asString(event.payload.taskTitle);
  if (!goal) {
    return null;
  }
  return {
    goal,
    recallPolicy: event.payload.recallPolicy === "bounded" ? "bounded" : undefined,
    transcript: Array.isArray(event.payload.transcript) ? event.payload.transcript : undefined,
    workspaceId: event.workspaceId,
    sessionId: event.sessionId,
    runtimeHost: event.runtime,
    hotMemorySnapshot:
      event.payload.hotMemorySnapshot && typeof event.payload.hotMemorySnapshot === "object" && !Array.isArray(event.payload.hotMemorySnapshot)
				? event.payload.hotMemorySnapshot
				: event.payload.hot_memory_snapshot && typeof event.payload.hot_memory_snapshot === "object" && !Array.isArray(event.payload.hot_memory_snapshot)
					? event.payload.hot_memory_snapshot
					: undefined,
    hotMemoryContent: asString(event.payload.hotMemoryContent) ?? asString(event.payload.hot_memory_content),
    includeResumeBrief:
      typeof event.payload.includeResumeBrief === "boolean"
				? event.payload.includeResumeBrief
				: typeof event.payload.include_resume_brief === "boolean"
					? event.payload.include_resume_brief
					: undefined,
    budget:
      event.payload.budget && typeof event.payload.budget === "object" && !Array.isArray(event.payload.budget)
        ? event.payload.budget
        : undefined,
    allowedScope: mergeAllowedScopeWithGovernor(
      event.payload.allowedScope && typeof event.payload.allowedScope === "object" && !Array.isArray(event.payload.allowedScope)
        ? event.payload.allowedScope
        : event.payload.allowed_scope && typeof event.payload.allowed_scope === "object" && !Array.isArray(event.payload.allowed_scope)
          ? event.payload.allowed_scope
          : undefined,
      governorScope
    ),
    contextSources: Array.isArray(event.payload.contextSources)
      ? event.payload.contextSources
      : Array.isArray(event.payload.context_sources)
        ? event.payload.context_sources
        : undefined,
    traverseAncestors:
      asBoolean(event.payload.traverseAncestors) ??
      asBoolean(event.payload.traverse_ancestors),
  };
};

const hasHotMemoryOverride = (packRequest: Record<string, unknown>): boolean =>
  (typeof packRequest.hotMemoryContent === "string" && packRequest.hotMemoryContent.trim().length > 0) ||
  Boolean(
    packRequest.hotMemorySnapshot &&
      typeof packRequest.hotMemorySnapshot === "object" &&
      !Array.isArray(packRequest.hotMemorySnapshot)
  );

const attachHotMemorySnapshot = async (
  client: HostedOnlyBotsClient,
  packRequest: Record<string, unknown>,
  warnings: string[]
): Promise<void> => {
  if (hasHotMemoryOverride(packRequest)) {
    return;
  }
  try {
    const hotMemory = await client.readHotMemory(HOT_SCOPE_ALL);
    packRequest.hotMemorySnapshot = hotMemory;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`hot memory snapshot unavailable for context pack: ${message}`);
  }
};

const parseJsonRecord = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const summarizeInline = (value: string, maxLength: number): string =>
  value.replace(/\s+/g, " ").trim().slice(0, maxLength).trim();

const localCommandHint = (summary: string): string | null => {
  return buildHotContextActionCue(summary, 420)?.text ?? null;
};

const localProjectPathHints = (summary: string, maxPaths: number = 2): string[] => {
  return extractHotContextProjectPaths(summary, maxPaths);
};

const localValidationCommand = (summary: string): string | null => {
  return pickHotContextValidationCommand(summary);
};

const localSupersededHint = (goal: string | null, summary: string): string | null => {
  const supersedingGoal =
    /\b(supersedes?|superseded|superseding|replaces?|replaced)\b/i.test(goal ?? "") &&
    /\b(old|legacy|historical|previous|prior)\b/i.test(summary);
  if (!supersedingGoal) {
    return null;
  }
  const paths = localProjectPathHints(summary);
  const validationCommand = localValidationCommand(summary);
  const parts = [
    `prior finding may be superseded; reconcile with the current request: ${summarizeInline(goal ?? "", 320)}`,
    paths.length > 0 ? `inspect ${paths.join(", ")}` : null,
    validationCommand ? `validate with \`${validationCommand}\`` : null,
  ];
  return parts.filter((entry) => entry !== null).join("; ");
};

const usefulLocalHotSummary = (summary: unknown): string | null => {
  const value = asString(summary);
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "session.started" || normalized === "turn.started") {
    return null;
  }
  return value;
};

type LocalHotContextCandidate = {
  scope: string | null;
  runtime: string | null;
  summary: string;
  timestamp: number;
};

const localTimestampMs = (value: unknown): number => {
  const text = asString(value);
  if (!text) {
    return 0;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
};

const localHotTimestamp = (content: Record<string, unknown>): number => {
  const lastTurn = asRecord(content.lastTurn);
  const lastEvent = asRecord(content.lastEvent);
  const lastSession = asRecord(content.lastSession);
  return Math.max(
    localTimestampMs(content.updatedAt),
    localTimestampMs(lastTurn?.occurredAt),
    localTimestampMs(lastEvent?.occurredAt),
    localTimestampMs(lastSession?.occurredAt)
  );
};

const localHotCandidateRank = (candidate: LocalHotContextCandidate, runtime: string): number => {
  const scope = candidate.scope?.toLowerCase() ?? null;
  const candidateRuntime = candidate.runtime?.toLowerCase() ?? null;
  const normalizedRuntime = runtime.toLowerCase();
  if (candidateRuntime === normalizedRuntime || scope === normalizedRuntime) {
    return 0;
  }
  if (scope === HOT_SCOPE_ALL || candidateRuntime === HOT_SCOPE_ALL) {
    return 2;
  }
  return 1;
};

const extractLocalHotContext = (hotMemorySnapshot: unknown, runtime: string, currentGoal: string | null): string => {
  const snapshot = parseJsonRecord(hotMemorySnapshot);
  const scopes = Array.isArray(snapshot?.scopes) ? snapshot.scopes.filter((entry) => entry && typeof entry === "object") : [];
  const candidates = scopes.length > 0 ? scopes : snapshot ? [snapshot] : [];
  const summaries: LocalHotContextCandidate[] = [];
  for (const candidate of candidates) {
    const scopeEntry = candidate as Record<string, unknown>;
    const scope = asString(scopeEntry.scope);
    const content = parseJsonRecord(scopeEntry.content) ?? parseJsonRecord(scopeEntry);
    if (!content) {
      continue;
    }
    const contentRuntime = asString(content.runtime);
    const lastTurn = asRecord(content.lastTurn);
    const lastEvent = asRecord(content.lastEvent);
    const lastSession = asRecord(content.lastSession);
    const recentEvents = Array.isArray(content.recentEvents) ? content.recentEvents : [];
    const recentSummary = recentEvents
      .slice()
      .reverse()
      .map((entry) => usefulLocalHotSummary(asRecord(entry)?.summary))
      .find((entry): entry is string => Boolean(entry));
    const latestSummary =
      usefulLocalHotSummary(lastTurn?.summary) ??
      usefulLocalHotSummary(lastSession?.summary) ??
      usefulLocalHotSummary(lastEvent?.summary) ??
      recentSummary;
    if (!latestSummary) {
      continue;
    }
    summaries.push({
      scope: scope ?? null,
      runtime: contentRuntime ?? null,
      summary: latestSummary,
      timestamp: localHotTimestamp(content),
    });
  }
  const selected = summaries
    .sort((left, right) => {
      const rankDelta = localHotCandidateRank(left, runtime) - localHotCandidateRank(right, runtime);
			if (rankDelta !== 0) {
				return rankDelta;
			}
			return right.timestamp - left.timestamp;
    })[0];
  if (!selected) {
    return "";
  }
  const staleHint = localSupersededHint(currentGoal, selected.summary);
  if (staleHint) {
    return `Hot memory stale note: ${staleHint}.`;
  }
  const hint = localCommandHint(selected.summary);
  if (hint) {
    return `Hot memory cue: ${hint}.`;
  }
  const latest = summarizeInline(selected.summary, 320);
  return `Hot memory latest: ${latest}`;
};

const emptyLayerManifest = (): { available: number; injected: number; omitted: number } => ({
  available: 0,
  injected: 0,
  omitted: 0,
});

const buildLocalOnlyContextPack = (event: RuntimeLifecycleEvent, packRequest: Record<string, unknown>): Record<string, unknown> => {
  const goal = asString(packRequest.goal);
  const checkpoints = selectHotCheckpoints(packRequest.hotMemorySnapshot, goal, event.workspaceId);
  const hotContextText = asRecord(packRequest.allowedScope)?.includeHotMemory === false ? "" : renderHotCheckpoints(checkpoints) || extractLocalHotContext(packRequest.hotMemorySnapshot, event.runtime, goal);
  const contextText = hotContextText;
  const injected = contextText.length > 0 ? 1 : 0;
  return {
    packId: null, // Local context is not a billable hosted context pack.
    contextText,
    fragments: injected > 0 ? [{ id: "local-hot-memory", kind: "hot_memory", content: contextText }] : [],
    manifest: {
      compilerVersion: "local-hot-v1",
      totalAvailableFragments: injected,
      totalInjectedFragments: injected,
      totalOmittedFragments: 0,
      judgmentSnapshot: emptyLayerManifest(),
      selfModel: emptyLayerManifest(),
      socialProfile: emptyLayerManifest(),
      hotMemory: { available: injected, injected, omitted: 0 },
      warmMemory: emptyLayerManifest(),
      coldMemory: emptyLayerManifest(),
      layeredContext: emptyLayerManifest(),
      topWarmEntries: [],
      suppressionCounts: {
				redundancy: 0,
				known_context: 0,
				budget_tokens: 0,
				budget_fragments: 0,
				stale: 0,
				low_signal: 0,
				low_orientation_value: 0,
      },
    },
  };
};

const isUnknownOrForeignContextPackError = (message: string): boolean =>
  /pack[_ -]?id is unknown/i.test(message) || /pack[_ -]?id.*does not belong/i.test(message);

const isPackBoundContinuityOutcomeItem = (item: RuntimeColdBatchItem): boolean =>
  Boolean(parseRuntimeContinuityOutcomeContent(item.content)?.packId);

const buildReflectionRequest = (event: RuntimeLifecycleEvent): Record<string, unknown> | null => {
  const continuityOutcome = buildRuntimeContinuityOutcome(event);
  if (!continuityOutcome || !continuityOutcome.packId) {
    return null;
  }

  const feedback = normalizeFeedback(event.payload.feedback);
  const taskSucceeded =
    asBoolean(event.payload.taskSucceeded) ??
    asBoolean(event.payload.task_succeeded) ??
    continuityOutcome.taskSucceeded ??
    undefined;
  const missedContext = asString(event.payload.missedContext) ?? asString(event.payload.missed_context);
  const demonstratedKnowledge =
    Array.isArray(event.payload.demonstratedKnowledge) || typeof event.payload.demonstratedKnowledge === "string"
      ? event.payload.demonstratedKnowledge
      : Array.isArray(event.payload.demonstrated_knowledge) || typeof event.payload.demonstrated_knowledge === "string"
        ? event.payload.demonstrated_knowledge
        : undefined;
  const communicationPreferences =
    Array.isArray(event.payload.communicationPreferences) || typeof event.payload.communicationPreferences === "string"
      ? event.payload.communicationPreferences
      : Array.isArray(event.payload.communication_preferences) || typeof event.payload.communication_preferences === "string"
        ? event.payload.communication_preferences
        : undefined;
  const userCalibration =
    Array.isArray(event.payload.userCalibration) || typeof event.payload.userCalibration === "string"
      ? event.payload.userCalibration
      : Array.isArray(event.payload.user_calibration) || typeof event.payload.user_calibration === "string"
        ? event.payload.user_calibration
        : undefined;
  const projectDirection =
    Array.isArray(event.payload.projectDirection) || typeof event.payload.projectDirection === "string"
      ? event.payload.projectDirection
      : Array.isArray(event.payload.project_direction) || typeof event.payload.project_direction === "string"
        ? event.payload.project_direction
        : undefined;
  const openQuestions =
    Array.isArray(event.payload.openQuestions) || typeof event.payload.openQuestions === "string"
      ? event.payload.openQuestions
      : Array.isArray(event.payload.open_questions) || typeof event.payload.open_questions === "string"
        ? event.payload.open_questions
        : undefined;
  const rejectedAlternatives =
    Array.isArray(event.payload.rejectedAlternatives) || typeof event.payload.rejectedAlternatives === "string"
      ? event.payload.rejectedAlternatives
      : Array.isArray(event.payload.rejected_alternatives) || typeof event.payload.rejected_alternatives === "string"
        ? event.payload.rejected_alternatives
        : undefined;
  const unresolvedRisks =
    Array.isArray(event.payload.unresolvedRisks) || typeof event.payload.unresolvedRisks === "string"
      ? event.payload.unresolvedRisks
      : Array.isArray(event.payload.unresolved_risks) || typeof event.payload.unresolved_risks === "string"
        ? event.payload.unresolved_risks
        : undefined;
  const recentCorrections =
    Array.isArray(event.payload.recentCorrections) || typeof event.payload.recentCorrections === "string"
      ? event.payload.recentCorrections
      : Array.isArray(event.payload.recent_corrections) || typeof event.payload.recent_corrections === "string"
        ? event.payload.recent_corrections
        : undefined;
  const orientationDelta =
    Array.isArray(event.payload.orientationDelta) || typeof event.payload.orientationDelta === "string"
      ? event.payload.orientationDelta
      : Array.isArray(event.payload.orientation_delta) || typeof event.payload.orientation_delta === "string"
        ? event.payload.orientation_delta
        : undefined;
  const redundancyMarkers =
    Array.isArray(event.payload.redundancyMarkers) || typeof event.payload.redundancyMarkers === "string"
      ? event.payload.redundancyMarkers
      : Array.isArray(event.payload.redundancy_markers) || typeof event.payload.redundancy_markers === "string"
        ? event.payload.redundancy_markers
        : undefined;

  if (
    !feedback &&
    taskSucceeded === undefined &&
    !missedContext &&
    communicationPreferences === undefined &&
    userCalibration === undefined &&
    projectDirection === undefined &&
    openQuestions === undefined &&
    rejectedAlternatives === undefined &&
    unresolvedRisks === undefined &&
    demonstratedKnowledge === undefined &&
    recentCorrections === undefined &&
    orientationDelta === undefined &&
    redundancyMarkers === undefined
  ) {
    return null;
  }

  return {
    packId: continuityOutcome.packId,
    goal: continuityOutcome.goal,
    outcomeDedupeKey: continuityOutcome.dedupeKey,
    outcomeTrigger: continuityOutcome.trigger,
    feedback,
    taskSucceeded,
    missedContext,
    communicationPreferences,
    userCalibration,
    projectDirection,
    openQuestions,
    rejectedAlternatives,
    unresolvedRisks,
    demonstratedKnowledge,
    recentCorrections,
    orientationDelta,
    redundancyMarkers,
  };
};

const explicitApprovalRequested = (event: RuntimeLifecycleEvent): boolean => {
  if (event.type === "operator.command") {
    return true;
  }
  const payload = event.payload;
  return (
    payload.approved === true ||
    payload.operatorApproved === true ||
    payload.operator_approved === true ||
    payload.allowColdSync === true ||
    payload.allow_cold_sync === true ||
    payload.policySignal === "operator_confirmed"
  );
};

const buildContinuityOutcomeColdItem = (event: RuntimeLifecycleEvent): RuntimeColdBatchItem | null => {
  const outcome = buildRuntimeContinuityOutcome(event);
  if (!outcome || !outcome.minimumReflectionPayload) {
    return null;
  }
  return {
    timestamp: outcome.occurredAt,
    role: "system",
    content: JSON.stringify(outcome, null, 2),
  };
};

const buildRawColdBatchItems = (event: RuntimeLifecycleEvent): RuntimeColdBatchItem[] => {
  const payload = event.payload;
  const directItems = payload.coldItems ?? payload.cold_items;
  if (Array.isArray(directItems)) {
    return directItems
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
      .map((entry) => normalizeTranscriptItem(entry))
      .filter((entry): entry is RuntimeColdBatchItem => entry !== null);
  }
  const transcript = payload.transcript;
  if (Array.isArray(transcript)) {
    return transcript
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
      .map((entry) => normalizeTranscriptItem(entry))
      .filter((entry): entry is RuntimeColdBatchItem => entry !== null);
  }
  const summary = asString(payload.summary) ?? asString(payload.result);
  if (!summary) {
    return [];
  }
  return [
    {
      timestamp: event.occurredAt,
      role: "system",
      content: `${event.type}: ${summary}`,
    },
  ];
};

const buildColdBatchItems = (event: RuntimeLifecycleEvent): RuntimeColdBatchItem[] => {
  const items = buildRawColdBatchItems(event);
  if (!event.workspaceId) return items;
  return items.map(item => ({ ...item, content: encodeArchivedTurn({
    workspaceId: event.workspaceId!, sessionId: event.sessionId,
    taskId: asString(event.payload.taskId) ?? asString(event.payload.task_id),
    goal: asString(event.payload.goal) ?? asString(event.payload.prompt) ?? "",
    content: item.content,
  }) }));
};

const shouldQueueHotWrite = (mode: RuntimeLifecycleMemoryMode, event: RuntimeLifecycleEvent): boolean => {
  if (mode !== "assist" && mode !== "auto") {
    return false;
  }
  return (
    event.type === "session.started" ||
    event.type === "session.ended" ||
    event.type === "compact.started" ||
    event.type === "compact.completed" ||
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "tool.completed" ||
    event.type === "task.changed" ||
    event.type === "operator.command"
  );
};

const shouldQueueContinuityOutcomeEvidence = (
  mode: RuntimeLifecycleMemoryMode,
  profile: RuntimeLifecycleProfile,
  event: RuntimeLifecycleEvent
): boolean => {
  if (!profile.features.coldSync) {
    return false;
  }
  if (mode !== "assist" && mode !== "auto") {
    return false;
  }
  return buildContinuityOutcomeColdItem(event) !== null;
};

const shouldQueueColdBatch = (
  mode: RuntimeLifecycleMemoryMode,
  profile: RuntimeLifecycleProfile,
  event: RuntimeLifecycleEvent
): boolean => {
  if (buildColdBatchItems(event).length === 0) {
    return false;
  }
  if (mode === "auto" && profile.features.coldSync) {
    return event.type === "turn.completed" || event.type === "tool.completed" || event.type === "operator.command";
  }
  if (mode === "assist") {
    return explicitApprovalRequested(event);
  }
  return false;
};

export class RuntimeLifecycleManager {
  private readonly now: () => Date;
  private readonly hotWriteDebounceMs: number;
  private readonly coldBatchWindowMs: number;
  private readonly workerIntervalMs: number;
  private readonly maxQueueDepth: number;
  private readonly maxQueueAttempts: number;
  private timer: NodeJS.Timeout | null = null;
  private backgroundOperation: Promise<void> | null = null;
  private mutation: Promise<void> = Promise.resolve();
  private detachedFlush: Promise<void> | null = null;
  private readonly claimedQueueItems = new Set<string>();

  constructor(private readonly deps: RuntimeLifecycleDeps) {
    this.now = deps.now ?? (() => new Date());
    this.hotWriteDebounceMs = deps.hotWriteDebounceMs ?? DEFAULT_HOT_WRITE_DEBOUNCE_MS;
    this.coldBatchWindowMs = deps.coldBatchWindowMs ?? DEFAULT_COLD_BATCH_WINDOW_MS;
    this.workerIntervalMs = deps.workerIntervalMs ?? DEFAULT_WORKER_INTERVAL_MS;
    this.maxQueueDepth = deps.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.maxQueueAttempts = deps.maxQueueAttempts ?? DEFAULT_MAX_QUEUE_ATTEMPTS;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      if (hotSyncEnabled()) {
				// Archive transport may be slow; it must not starve hot-memory sync.
				void this.withLock(async () => {
					if (this.deps.loadContinuityGovernorState().paused) return;
					const state = this.loadQueueState();
					this.importQueuedHotMemory(state);
					tickHotSyncManagers(this.deps.paths.state);
				}).catch(error => this.markFailure(error instanceof Error ? error.message : String(error)));
      }
      if (this.backgroundOperation) return;
      const operation = this.flushDueItems(false).catch((error) => {
        this.markFailure(error instanceof Error ? error.message : String(error));
      });
      this.backgroundOperation = operation;
      // Do not detach the error-health write from the operation stop awaits.
      void operation.then(
        () => { if (this.backgroundOperation === operation) this.backgroundOperation = null; },
        () => { /* Retain a failed health write so stop surfaces it. */ }
      );
    }, this.workerIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const operation = this.backgroundOperation;
    try { await operation; }
    finally {
      if (this.backgroundOperation === operation) this.backgroundOperation = null;
      await this.detachedFlush;
      await this.mutation;
    }
  }

  async readActivity(lines: number = 50): Promise<RuntimeLifecycleActivity> {
    return {
      events: readJsonLines<RuntimeLifecycleEvent>(eventsFile(this.deps.paths.state), lines),
      actions: readJsonLines<RuntimeMemoryActionRecord>(actionsFile(this.deps.paths.state), lines),
    };
  }

  async recordContextPackResult(
    profileName: string | null,
    result: Record<string, unknown>,
    source: "command" | "daemon_proxy"
  ): Promise<RuntimeMemoryActionRecord | null> {
    const packId = asString(result.packId);
    if (!packId) {
      return null;
    }
    return this.withLock(async () => {
      const resolved = this.resolveProfile(profileName);
      return this.recordAction({
		eventId: null,
		profileName: resolved.profileName,
		type: "context_pack",
		status: "completed",
		mode: resolved.profile.memoryMode,
		reason: "Prepared explicit hosted context pack",
		queueItemId: null,
		details: {
		  packId,
		  source,
		  fragments: Array.isArray(result.fragments) ? result.fragments.length : 0,
		  contextChars: asString(result.contextText)?.length ?? 0,
		},
      });
    });
  }

  async handleEvent(request: RuntimeLifecycleEventRequest): Promise<RuntimeLifecycleEventResponse> {
    return this.withLock(async () => {
      const state = this.loadQueueState();
      const { profileName, profile, secret } = this.resolveProfile(request.profileName ?? null);
      const localOnlyProfile = isLocalOnlyRuntimeProfile(profile);
      const event = this.hydrateEventFromPriorTurnStart(this.normalizeEvent(request, profileName));
      if(hotSyncEnabled() && !localOnlyProfile && event.workspaceId)getHotSyncManager({stateDir:this.deps.paths.state,origin:profile.apiBase,npub:profile.npub,nsec:secret.nsec,profileName}).activate(event.runtime,event.workspaceId);
      const continuity = this.deps.loadContinuityGovernorState();
      if (hotSyncEnabled() && !continuity.paused) this.importQueuedHotMemory(state);
      // Apply capture policy before the event log as well as before hot storage.
      // This also covers a mode/pause change racing a native hook's status read.
      if (profile.memoryMode === "off" || profile.memoryMode === "manual" || continuity.paused) {
	delete event.payload.taskEvidence;
      } else if (event.payload.taskEvidence !== undefined) {
	event.payload.taskEvidence = normalizeTaskEvidence(event.payload.taskEvidence);
      }
      const policy = continuity.effectivePolicy;
      const pausedReason =
        continuity.pauseReasons.length > 0
          ? `Continuity governor paused runtime-managed work: ${continuity.pauseReasons.join(" | ")}`
          : "Continuity governor paused runtime-managed work";
      const warnings: string[] = [];
      const actions: RuntimeMemoryActionRecord[] = [];
      let inbox: RuntimeInboxHudState | null = null;
      let dreamReview: RuntimeDreamReviewHudState | null = null;
      let obligations: RuntimeObligationsHudState | null = null;
      let contextPack: Record<string, unknown> | null = null;

      if (state.processedEventIds.includes(event.eventId)) {
        const duplicate = this.recordAction({
          eventId: event.eventId,
          profileName,
          type: "duplicate_event",
          status: "skipped",
          mode: profile.memoryMode,
          reason: "Lifecycle event was already processed",
          queueItemId: null,
          details: { type: event.type },
        });
        actions.push(duplicate);
        return this.buildResponse(event, profile.memoryMode, state, inbox, dreamReview, obligations, contextPack, actions, warnings);
      }

      this.recordEvent(event);

      if ((event.type === "session.started" || event.type === "turn.started") && !localOnlyProfile && !hotSyncEnabled()) {
		const inboxRefresh = await this.refreshInboxHud(profileName, profile, secret, event);
		inbox = inboxRefresh.state;
		if (inboxRefresh.action) {
		  actions.push(inboxRefresh.action);
		}
		warnings.push(...inboxRefresh.warnings);
        const dreamRefresh = await this.refreshDreamReviewHud(profileName, profile, secret, event);
        dreamReview = dreamRefresh.state;
        if (dreamRefresh.action) {
          actions.push(dreamRefresh.action);
        }
        warnings.push(...dreamRefresh.warnings);
        const obligationsRefresh = await this.refreshObligationsHud(profileName, profile, secret, event);
        obligations = obligationsRefresh.state;
        if (obligationsRefresh.action) {
          actions.push(obligationsRefresh.action);
        }
        warnings.push(...obligationsRefresh.warnings);
      }

      if (event.type === "turn.started") {
        if (continuity.paused) {
          actions.push(
            this.recordAction({
              eventId: event.eventId,
              profileName,
              type: "mode_skip",
              status: "skipped",
              mode: profile.memoryMode,
              reason: pausedReason,
              queueItemId: null,
              details: {
                type: event.type,
                paused: true,
                activePatches: continuity.activePatches.map((patch) => patch.patchId),
              },
            })
          );
        } else if (profile.memoryMode === "off") {
          actions.push(
            this.recordAction({
              eventId: event.eventId,
              profileName,
              type: "mode_skip",
              status: "skipped",
              mode: profile.memoryMode,
              reason: "Automatic retrieval is disabled in off mode",
              queueItemId: null,
              details: { type: event.type },
            })
          );
        } else {
          const packRequest = buildPackRequest(event, continuity.memoryScope);

          if (!packRequest) {
            actions.push(
              this.recordAction({
                eventId: event.eventId,
                profileName,
                type: "context_pack",
                status: "skipped",
                mode: profile.memoryMode,
                reason: "turn.started event did not include a usable goal",
                queueItemId: null,
                details: { type: event.type },
              })
            );
          } else {
						if (localOnlyProfile || hotSyncEnabled()) {
							if (!hasHotMemoryOverride(packRequest)) {
								packRequest.hotMemorySnapshot = localOnlyProfile ? readLocalHotMemory(this.deps.paths.state, HOT_SCOPE_ALL) : getHotSyncManager({stateDir:this.deps.paths.state,origin:profile.apiBase,npub:profile.npub,nsec:secret.nsec,profileName}).read();
							}
							contextPack = buildLocalOnlyContextPack(event, packRequest);
							actions.push(
								this.recordAction({
									eventId: event.eventId,
									profileName,
									type: "context_pack",
									status: "completed",
									mode: profile.memoryMode,
									reason: "Prepared local hot-memory turn context",
									queueItemId: null,
									details: {
										type: event.type,
										fragments: Array.isArray(contextPack.fragments) ? contextPack.fragments.length : 0,
										contextChars: asString(contextPack.contextText)?.length ?? 0,
										localOnly: true,
									},
								})
							);
						} else {
							const client = this.buildClient(profile, secret);
						if(hotSyncEnabled() && !localOnlyProfile) packRequest.hotMemorySnapshot=getHotSyncManager({stateDir:this.deps.paths.state,origin:profile.apiBase,npub:profile.npub,nsec:secret.nsec,profileName}).read();
						await attachHotMemorySnapshot(client, packRequest, warnings);
						try {
							const hostedPack = await client.prepareContextPack(packRequest, `context_pack_v1-${createHash("sha256").update(event.eventId).digest("hex").slice(0, 48)}`);
							const localPack = buildLocalOnlyContextPack(event, packRequest);
							const hostedPackId = asString(hostedPack.packId);
							contextPack = {
								...localPack,
								...(hostedPackId ? { packId: hostedPackId } : {}),
							};
							this.persistClientSession(profileName, secret, client);
							this.markSuccess();
							actions.push(
								this.recordAction({
									eventId: event.eventId,
									profileName,
									type: "context_pack",
									status: "completed",
									mode: profile.memoryMode,
									reason: "Prepared deterministic turn context",
									queueItemId: null,
									details: {
										type: event.type,
										fragments: Array.isArray(contextPack.fragments) ? contextPack.fragments.length : 0,
										contextChars: asString(contextPack.contextText)?.length ?? 0,
					packId: asString(contextPack.packId),
					...(contextPack.recall ? { recall: contextPack.recall } : {}),
									},
								})
							);
						} catch (error) {
	      if (!isBillingBlockedError(error) && packRequest.recallPolicy === "bounded") {
		contextPack = buildLocalOnlyContextPack(event, packRequest);
		warnings.push(describeBoundedRecallFallback(error));
		actions.push(this.recordAction({ eventId: event.eventId, profileName, type: "context_pack", status: "failed",
		  mode: profile.memoryMode, reason: "Bounded recall unavailable; preserved free hot-memory delivery", queueItemId: null,
		  details: { type: event.type, freeFallback: true, failure: describeHostedFailure(error) } }));
	      } else {
	      if (!isBillingBlockedError(error)) throw error;
							contextPack = buildLocalOnlyContextPack(event, packRequest);
							this.persistClientSession(profileName, secret, client);
							this.markSuccess();
							const remediation = buildRuntimeBillingRemediation({
								status: error.status,
								code: error.code,
								message: error.message,
								details: error.details,
							});
							warnings.push(
								[
									"context pack requires payment or funding; continuing with free hot-memory transfer context",
									remediation ? formatRuntimeBillingRemediation(remediation) : null,
								]
									.filter((value): value is string => Boolean(value))
									.join(". ")
							);
							actions.push(
								this.recordAction({
									eventId: event.eventId,
									profileName,
									type: "context_pack",
									status: "skipped",
									mode: profile.memoryMode,
									reason: "Paid context pack unavailable; rendered free hot-memory transfer context",
									queueItemId: null,
									details: {
										type: event.type,
										paymentRequired: true,
										status: error.status,
										code: error.code,
									},
								})
							);
	      }
						}
						}
          }
        }
      }

      if (event.type === "turn.completed" || event.type === "turn.failed") {
        if (continuity.paused) {
          actions.push(
            this.recordAction({
              eventId: event.eventId,
              profileName,
              type: "mode_skip",
              status: "skipped",
              mode: profile.memoryMode,
              reason: pausedReason,
              queueItemId: null,
              details: {
                type: event.type,
                paused: true,
                activePatches: continuity.activePatches.map((patch) => patch.patchId),
              },
            })
          );
				} else if ((profile.memoryMode === "assist" || profile.memoryMode === "auto") && !localOnlyProfile && !hotSyncEnabled()) {
          const reflectionRequest = buildReflectionRequest(event);
          if (reflectionRequest) {
            const client = this.buildClient(profile, secret);
            try {
              const reflection = await client.reflectContextPack(reflectionRequest);
              this.persistClientSession(profileName, secret, client);
              this.markSuccess();
              actions.push(
                this.recordAction({
                  eventId: event.eventId,
                  profileName,
                  type: "context_reflect",
                  status: "completed",
                  mode: profile.memoryMode,
                  reason: "Applied context-pack reflection feedback",
                  queueItemId: null,
                  details: sanitizeValue({
                    heuristicUpdates: Array.isArray(reflection.heuristicUpdates)
                      ? reflection.heuristicUpdates.length
                      : 0,
                    flaggedWarmEntries: Array.isArray(reflection.flaggedWarmEntries)
                      ? reflection.flaggedWarmEntries.length
                      : 0,
                  }) as Record<string, unknown>,
                })
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              this.persistClientSession(profileName, secret, client);
              const staleOrForeignPack = isUnknownOrForeignContextPackError(message);
              if (!staleOrForeignPack) {
                this.markFailure(message);
              }
              warnings.push(
                staleOrForeignPack
                  ? `context-pack reflection skipped (${message}); continuing with post-turn memory updates`
                  : `context-pack reflection failed (${message}); continuing with post-turn memory updates`
              );
              actions.push(
                this.recordAction({
                  eventId: event.eventId,
                  profileName,
                  type: "context_reflect",
                  status: staleOrForeignPack ? "skipped" : "failed",
                  mode: profile.memoryMode,
                  reason: staleOrForeignPack
                    ? "Hosted context-pack reflection rejected stale or foreign pack_id; continuing with post-turn memory updates"
                    : "Hosted context-pack reflection failed; continuing with post-turn memory updates",
                  queueItemId: null,
                  details: sanitizeValue({
                    error: message,
                    packId: reflectionRequest.packId,
                  }) as Record<string, unknown>,
                })
              );
            }
          }
        } else {
          actions.push(
            this.recordAction({
              eventId: event.eventId,
              profileName,
              type: "mode_skip",
              status: "skipped",
              mode: profile.memoryMode,
              reason: "Automatic reflection is disabled in off/manual mode",
              queueItemId: null,
              details: { type: event.type },
            })
          );
        }
      }

      if (shouldQueueHotWrite(profile.memoryMode, event)) {
        if (continuity.paused) {
          actions.push(
            this.recordAction({
              eventId: event.eventId,
              profileName,
              type: "mode_skip",
              status: "skipped",
              mode: profile.memoryMode,
              reason: pausedReason,
              queueItemId: null,
              details: { type: event.type, paused: true },
            })
          );
        } else if (!automaticHotWritesEnabled(policy)) {
          actions.push(
            this.recordAction({
              eventId: event.eventId,
              profileName,
              type: "mode_skip",
              status: "skipped",
              mode: profile.memoryMode,
              reason: "Automatic hot-memory writes are disabled by continuity policy",
              queueItemId: null,
              details: { type: event.type, policy: "memory.hotWriteMode=off" },
						})
					);
				} else {
					if (hotSyncEnabled() && !localOnlyProfile) {
						const manager=getHotSyncManager({stateDir:this.deps.paths.state,origin:profile.apiBase,npub:profile.npub,nsec:secret.nsec,profileName});
						const scope=workspaceHotScope(event.runtime,event.workspaceId) ?? "shared";
						const current=parseStructuredHotState(String(manager.readWorkspace(event.runtime,event.workspaceId ?? "").content ?? ""));
						const hot=buildHotState(current,event);
						const checkpoints=Array.isArray(hot.continuityCheckpoints)?hot.continuityCheckpoints:[];
						const last=checkpoints[checkpoints.length-1] as Record<string,unknown>|undefined;
						if(last && hot.continuityCheckpoints !== current.continuityCheckpoints && ["turn.completed","turn.failed","session.ended","compact.started"].includes(event.type)) {
						manager.capture(scope,{id:event.eventId,runtime:event.runtime,workspaceId:event.workspaceId ?? "",occurredAt:event.occurredAt,goal:String(last.goal ?? ""),summary:String(last.summary ?? ""),sessionId:event.sessionId,turnId:event.turnId,...(Array.isArray(event.payload.supersedes) ? {supersedes:event.payload.supersedes.filter((v):v is string=>typeof v === "string")} : {}),...(Array.isArray(event.payload.conflictsWith) ? {conflictsWith:event.payload.conflictsWith.filter((v):v is string=>typeof v === "string")} : {}),...(last.evidence ? {evidence:last.evidence} : {})});
							actions.push(this.recordAction({eventId:event.eventId,profileName,type:"hot_write",status:"completed",mode:profile.memoryMode,reason:"Saved hot memory on this machine; cloud sync pending",queueItemId:null,details:{type:event.type,storage:"local"}}));
						}
					} else {
					const scope = event.runtime || undefined;
					const partitionScope = workspaceHotScope(scope, event.workspaceId);
					const client = localOnlyProfile ? null : this.buildClient(profile, secret);
					const readHot = async (name: string | undefined) => client
						? client.readHotMemory(name) : readLocalHotMemory(this.deps.paths.state, name);
					const alias = await readHot(scope);
					const partition = partitionScope === scope ? alias : await readHot(partitionScope);
					if (client) this.persistClientSession(profileName, secret, client);
					const currentHot = selectWorkspaceHotState(
						parseStructuredHotState(String(partition.content ?? "")), parseStructuredHotState(String(alias.content ?? "")), event.workspaceId
					);
					const pending = state.items.slice().reverse().find(
						(item): item is Extract<RuntimeQueueItem, { kind: "hot_write" }> =>
							item.kind === "hot_write" && item.profileName === event.profileName && item.payload.scope === scope && item.workspaceId === event.workspaceId
					);
					const hotState = buildHotState(pending?.payload.hotState ?? currentHot, event);
					const queued = this.enqueueHotWrite(state, event, hotState, {
						immediate: event.type === "compact.started" || event.type === "compact.completed",
					});
					actions.push(
						this.recordAction({
							eventId: event.eventId,
							profileName,
							type: "hot_write",
							status: "queued",
							mode: profile.memoryMode,
							reason: "Queued debounced hot-memory update",
							queueItemId: queued.id,
							details: {
								type: event.type,
								sessionId: event.sessionId,
								workspaceId: event.workspaceId,
							},
						})
					);
				}
					}
			} else if (
				event.type === "session.started" ||
				event.type === "session.ended" ||
				event.type === "compact.started" ||
				event.type === "compact.completed" ||
				event.type === "turn.completed" ||
				event.type === "turn.failed" ||
				event.type === "tool.completed" ||
				event.type === "task.changed" ||
				event.type === "operator.command"
      ) {
        actions.push(
          this.recordAction({
            eventId: event.eventId,
            profileName,
            type: "mode_skip",
            status: "skipped",
            mode: profile.memoryMode,
            reason: "Automatic hot-memory writes are disabled for the current mode",
            queueItemId: null,
            details: { type: event.type },
          })
        );
      }

      const warmCandidates = buildWarmPromotionCandidates(event);
      if (warmCandidates.length > 0) {
        if (continuity.paused) {
          actions.push(
            this.recordAction({
              eventId: event.eventId,
              profileName,
              type: "mode_skip",
              status: "skipped",
              mode: profile.memoryMode,
              reason: pausedReason,
              queueItemId: null,
              details: {
                type: event.type,
                paused: true,
                candidates: warmCandidates.length,
              },
            })
          );
        } else {
          const allowAutomaticCommit = profile.memoryMode === "auto" && profile.features.autoWarmPromotion;
          const explicitApproval = explicitApprovalRequested(event);
          let committedWarmWrites = 0;
          for (const candidate of warmCandidates) {
            const policyDecision = automaticWarmCommitDecision(policy, {
              explicit: candidate.scoring.explicit,
              explicitApproval,
              autoModeEnabled: allowAutomaticCommit,
              candidateConfidence: candidate.inferred.confidence,
              committedCount: committedWarmWrites,
            });
            if (policyDecision.commit) {
              const queued = this.enqueueWarmCommit(state, event, candidate);
              committedWarmWrites += 1;
              actions.push(
                this.recordAction({
                  eventId: event.eventId,
                  profileName,
                  type: "warm_commit",
                  status: "queued",
                  mode: profile.memoryMode,
                  reason: `${candidate.reason}; ${policyDecision.reason}`,
                  queueItemId: queued.id,
                  details: {
                    ...(sanitizeValue(candidate) as Record<string, unknown>),
                    policyDecision: policyDecision.reason,
                  },
                })
              );
            } else if (
              profile.memoryMode === "manual" ||
              profile.memoryMode === "assist" ||
              profile.memoryMode === "auto"
            ) {
              actions.push(
                this.recordAction({
                  eventId: event.eventId,
                  profileName,
                  type: "warm_proposal",
                  status: "completed",
                  mode: profile.memoryMode,
                  reason: `${candidate.reason}; ${policyDecision.reason}`,
                  queueItemId: null,
                  details: {
                    ...(sanitizeValue(candidate) as Record<string, unknown>),
                    policyDecision: policyDecision.reason,
                  },
                })
              );
            }
          }
        }
      }

      const transcriptColdBatchItems = buildColdBatchItems(event);
      const transcriptColdBatchAllowedByMode = shouldQueueColdBatch(profile.memoryMode, profile, event);
      const continuityOutcomeItem = buildContinuityOutcomeColdItem(event);
      const continuityOutcomeAllowedByMode =
        continuityOutcomeItem !== null && shouldQueueContinuityOutcomeEvidence(profile.memoryMode, profile, event);
      const continuityOutcomeItems = continuityOutcomeAllowedByMode && continuityOutcomeItem ? [continuityOutcomeItem] : [];
      const wantsTranscriptColdBatch = transcriptColdBatchAllowedByMode && transcriptColdBatchItems.length > 0;
      const wantsContinuityOutcomeBatch = continuityOutcomeItems.length > 0;

      if (wantsTranscriptColdBatch || wantsContinuityOutcomeBatch) {
        if (continuity.paused) {
          actions.push(
            this.recordAction({
              eventId: event.eventId,
              profileName,
              type: "mode_skip",
              status: "skipped",
              mode: profile.memoryMode,
              reason: pausedReason,
              queueItemId: null,
              details: {
                type: event.type,
                paused: true,
                transcriptItems: transcriptColdBatchItems.length,
                continuityOutcomeItems: continuityOutcomeItems.length,
              },
            })
          );
        } else {
          let queuedTranscriptItems: RuntimeColdBatchItem[] = [];
          let transcriptDecisionReason: string | null = null;

          if (wantsTranscriptColdBatch) {
            const coldDecision = automaticColdBatchDecision(policy, {
              explicitApproval: explicitApprovalRequested(event),
              autoModeEnabled: profile.memoryMode === "auto" && profile.features.coldSync,
              itemCount: transcriptColdBatchItems.length,
            });
            transcriptDecisionReason = coldDecision.reason;
            if (coldDecision.allowed) {
              queuedTranscriptItems = transcriptColdBatchItems.slice(0, coldDecision.maxItems);
              if (queuedTranscriptItems.length === 0) {
                actions.push(
                  this.recordAction({
                    eventId: event.eventId,
                    profileName,
                    type: "mode_skip",
                    status: "skipped",
                    mode: profile.memoryMode,
                    reason: "Continuity policy reduced cold-memory batching budget to zero items",
                    queueItemId: null,
                    details: { type: event.type },
                  })
                );
              }
            } else if (!wantsContinuityOutcomeBatch) {
              actions.push(
                this.recordAction({
                  eventId: event.eventId,
                  profileName,
                  type: "mode_skip",
                  status: "skipped",
                  mode: profile.memoryMode,
                  reason: coldDecision.reason,
                  queueItemId: null,
                  details: { type: event.type, items: transcriptColdBatchItems.length },
                })
              );
            }
          }

          const finalColdBatchItems = [...continuityOutcomeItems, ...queuedTranscriptItems];
          if (finalColdBatchItems.length > 0) {
            const queued = this.enqueueColdBatch(state, event, finalColdBatchItems);
            const reason = continuityOutcomeItems.length > 0
              ? transcriptDecisionReason && queuedTranscriptItems.length > 0
                ? `${transcriptDecisionReason}; included structured continuity outcome evidence`
                : transcriptDecisionReason
                  ? `Queued structured continuity outcome evidence; ${transcriptDecisionReason}`
                  : "Queued structured continuity outcome evidence for scheduled reflection"
              : transcriptDecisionReason ?? "Queued cold-memory batch";
            actions.push(
              this.recordAction({
                eventId: event.eventId,
                profileName,
                type: "cold_batch",
                status: "queued",
                mode: profile.memoryMode,
                reason,
                queueItemId: queued.id,
                details: {
                  items: queued.payload.items.length,
                  transcriptItems: queuedTranscriptItems.length,
                  structuredOutcomeItems: continuityOutcomeItems.length,
                  originalTranscriptItems: transcriptColdBatchItems.length,
                },
              })
            );
          }
        }
      } else if (transcriptColdBatchItems.length > 0 && profile.memoryMode !== "off" && profile.memoryMode !== "manual") {
        actions.push(
          this.recordAction({
            eventId: event.eventId,
            profileName,
            type: "mode_skip",
            status: "skipped",
            mode: profile.memoryMode,
            reason: "Cold-memory batching requires auto mode or explicit approval",
            queueItemId: null,
            details: { type: event.type },
          })
        );
      }

      state.processedEventIds = [...state.processedEventIds, event.eventId].slice(-MAX_TRACKED_EVENT_IDS);
      this.saveQueueState(state);
      const processedState = hotSyncEnabled() ? state : await this.processDueItems(state, false);

      if (processedState.items.length > this.maxQueueDepth) {
        warnings.push("Local runtime queue is under backpressure");
      }

      return this.buildResponse(event, profile.memoryMode, processedState, inbox, dreamReview, obligations, contextPack, actions, warnings);
    });
  }

  async flushDueItems(force: boolean = true): Promise<void> {
    if (!hotSyncEnabled()) {
      await this.withLock(async () => {
				const state = this.loadQueueState();
				await this.processDueItems(state, force);
      });
      return;
    }
    if (this.detachedFlush) return this.detachedFlush;
    const operation = this.flushDetachedQueue(force);
    this.detachedFlush = operation;
    try { await operation; }
    finally { if (this.detachedFlush === operation) this.detachedFlush = null; }
  }

  private async flushDetachedQueue(force: boolean): Promise<void> {
    const claimed = await this.withLock(async () => {
      if (this.deps.loadContinuityGovernorState().paused) return null;
      const state = this.loadQueueState();
      this.importQueuedHotMemory(state);
      const now = this.now().getTime();
      const items = state.items.filter(item => {
				// Retained hosted snapshots are recovery data, never late legacy uploads.
				if (item.kind === "hot_write") {
					const profile = this.deps.loadProfile(item.profileName);
					if (!profile || !isLocalOnlyRuntimeProfile(profile)) return false;
				}
				return !this.claimedQueueItems.has(item.id) && (force || Date.parse(item.availableAt) <= now);
      });
      for (const item of items) this.claimedQueueItems.add(item.id);
      return structuredClone({ items, processedEventIds: [] }) as RuntimeQueueState;
    });
    if (!claimed) return;
    const claimedItems = [...claimed.items];
    const original = new Map(claimedItems.map(item => [item.id, JSON.stringify(item)]));
    try {
      // These awaits never own the local lifecycle mutation lock. Claimed items
      // remain durable, and new captures coalesce only into unclaimed items.
      const processed = await this.processDueItems(claimed, true, false);
      const remaining = new Map(processed.items.map(item => [item.id, item]));
      await this.withLock(async () => {
				const current = this.loadQueueState();
				current.items = current.items.flatMap(item => {
					const expected = original.get(item.id);
					if (!expected || JSON.stringify(item) !== expected) return [item];
					const retry = remaining.get(item.id);
					return retry ? [retry] : [];
				});
				this.saveQueueState(current);
      });
    } finally {
      await this.withLock(async () => { for (const item of claimedItems) this.claimedQueueItems.delete(item.id); });
    }
  }

  private importQueuedHotMemory(state: RuntimeQueueState): void {
    const imported = new Set<string>();
    const errors = new Map<ReturnType<typeof getHotSyncManager>, string | null>();
    for (const item of state.items) {
      if (item.kind !== "hot_write" || this.claimedQueueItems.has(item.id)) continue;
      try {
				const { profile, secret } = this.resolveProfile(item.profileName);
				if (isLocalOnlyRuntimeProfile(profile)) continue;
				const manager = getHotSyncManager({ stateDir: this.deps.paths.state, origin: profile.apiBase, npub: profile.npub, nsec: secret.nsec, profileName: item.profileName });
				if (!errors.has(manager)) errors.set(manager, null);
				try {
					manager.importQueuedLegacy(item.payload.hotState, item.payload.scope ?? "shared", item.workspaceId);
					imported.add(item.id);
				} catch (error) {
					errors.set(manager, error instanceof Error ? error.message : "Legacy queue needs recovery");
				}
      } catch (error) {
				// A removed/broken profile must not prevent unrelated local hooks.
				this.deps.writeLog("hot_sync_legacy_queue_retained", { queueItemId: item.id, profileName: item.profileName });
      }
    }
    for (const [manager, error] of errors) manager.setLegacyQueueError(error);
    if (imported.size) {
      // Each imported checkpoint is fsynced before its old queue entry is removed.
      state.items = state.items.filter(item => !imported.has(item.id));
      this.saveQueueState(state);
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.mutation.then(fn, fn);
    this.mutation = current.then(
      () => undefined,
      () => undefined
    );
    return current;
  }

  private loadQueueState(): RuntimeQueueState {
    return normalizeQueueState(parseJsonFile(queueFile(this.deps.paths.state), { items: [], processedEventIds: [] }));
  }

  private saveQueueState(state: RuntimeQueueState): void {
    writeJsonFile(queueFile(this.deps.paths.state), state);
    this.saveComputedHealth(state);
  }

  private saveComputedHealth(state: RuntimeQueueState, overrides: Partial<RuntimeLifecycleHealthState> = {}): void {
    const next: RuntimeLifecycleHealthState = {
      ...this.deps.loadHealth(),
      queueDepth: state.items.length,
      pendingHotWrites: state.items.filter((item) => item.kind === "hot_write").length,
      pendingColdBatches: state.items.filter((item) => item.kind === "cold_batch").length,
      retryingItems: state.items.filter((item) => item.attempts > 0).length,
      backpressure: state.items.length > this.maxQueueDepth,
      ...overrides,
    };
    this.deps.saveHealth(next);
  }

  private async refreshInboxHud(
    profileName: string,
    profile: RuntimeLifecycleProfile,
    secret: RuntimeLifecycleSecret,
    event: RuntimeLifecycleEvent
  ): Promise<{ state: RuntimeInboxHudState | null; action: RuntimeMemoryActionRecord | null; warnings: string[] }> {
    const warnings: string[] = [];
    const currentProfileState = loadRuntimeInboxHudStore(this.deps.paths.state).profiles[profileName] ?? {
      snapshot: null,
      lastAnnouncedActiveIds: [],
      lastAnnouncedAt: null,
    };

    try {
      const client = this.buildClient(profile, secret);
      const response = await client.inspectInboxState({
		includeTerminal: true,
		limit: INBOX_HUD_SAMPLE_LIMIT,
		messageType: "inbox_event",
      });
      this.persistClientSession(profileName, secret, client);
      this.markSuccess();

      const responseRecord = asRecord(response);
      const summary = parseInboxHudSummary(responseRecord?.summary);
      const parsedItems = parseInboxHudItems(responseRecord?.items, currentProfileState.lastAnnouncedActiveIds);
      summary.sampledActiveCount = parsedItems.sampledActiveCount;
      summary.truncated = summary.active > parsedItems.sampledActiveCount;

      const newSinceLastAnnouncement = parsedItems.activeIds.filter(
		(inboxId) => !currentProfileState.lastAnnouncedActiveIds.includes(inboxId)
      ).length;
      const advanceAnnouncement = event.type === "turn.started";
      const nextAnnouncedIds = advanceAnnouncement
		? parsedItems.activeIds.slice(0, MAX_TRACKED_ANNOUNCED_INBOX_IDS)
		: currentProfileState.lastAnnouncedActiveIds;
      const nextAnnouncedAt = advanceAnnouncement ? event.occurredAt : currentProfileState.lastAnnouncedAt;
      const snapshot: RuntimeInboxHudState = {
		refreshedAt: this.now().toISOString(),
		source: "live",
		stale: false,
		fetchError: null,
		summary,
		newSinceLastAnnouncement,
		lastAnnouncedAt: nextAnnouncedAt,
		topItems: parsedItems.topItems,
      };

      updateRuntimeInboxHudProfileState(this.deps.paths.state, profileName, (current) => ({
		...current,
		snapshot,
		lastAnnouncedActiveIds: nextAnnouncedIds,
		lastAnnouncedAt: nextAnnouncedAt,
      }));

      return {
		state: snapshot,
		action: this.recordAction({
		  eventId: event.eventId,
		  profileName,
		  type: "inbox_refresh",
		  status: "completed",
		  mode: profile.memoryMode,
		  reason:
			summary.total > 0
			  ? "Refreshed durable inbox HUD from hosted inbox state"
			  : "Confirmed durable inbox is empty",
		  queueItemId: null,
		  details: {
			source: "live",
			total: summary.total,
			active: summary.active,
			unread: summary.unread,
			newSinceLastAnnouncement,
			truncated: summary.truncated,
		  },
		}),
		warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markFailure(message);
      const cachedSnapshot = currentProfileState.snapshot;
      if (cachedSnapshot) {
		const fallback: RuntimeInboxHudState = {
		  ...cachedSnapshot,
		  source: "cached",
		  stale: true,
		  fetchError: message,
		};
		updateRuntimeInboxHudProfileState(this.deps.paths.state, profileName, (current) => ({
		  ...current,
		  snapshot: fallback,
		}));
		warnings.push(`Inbox HUD refresh failed; using cached state (${message})`);
		return {
		  state: fallback,
		  action: this.recordAction({
			eventId: event.eventId,
			profileName,
			type: "inbox_refresh",
			status: "failed",
			mode: profile.memoryMode,
			reason: "Hosted inbox HUD refresh failed; returned cached inbox state",
			queueItemId: null,
			details: {
			  source: "cached",
			  error: message,
			  cachedTotal: cachedSnapshot.summary.total,
			  cachedActive: cachedSnapshot.summary.active,
			},
		  }),
		  warnings,
		};
      }

      warnings.push(`Inbox HUD refresh failed (${message})`);
      return {
		state: null,
		action: this.recordAction({
		  eventId: event.eventId,
		  profileName,
		  type: "inbox_refresh",
		  status: "failed",
		  mode: profile.memoryMode,
		  reason: "Hosted inbox HUD refresh failed and no cached state was available",
		  queueItemId: null,
		  details: {
			source: "none",
			error: message,
		  },
		}),
		warnings,
      };
    }
  }

  private async refreshDreamReviewHud(
    profileName: string,
    profile: RuntimeLifecycleProfile,
    secret: RuntimeLifecycleSecret,
    event: RuntimeLifecycleEvent
  ): Promise<{ state: RuntimeDreamReviewHudState | null; action: RuntimeMemoryActionRecord | null; warnings: string[] }> {
    const warnings: string[] = [];
    const currentProfileState = loadRuntimeDreamReviewHudStore(this.deps.paths.state).profiles[profileName] ?? {
      snapshot: null,
      lastAnnouncedProposalIds: [],
      lastAnnouncedAt: null,
    };

    try {
      const client = this.buildClient(profile, secret);
      const response = await client.inspectDreams({ status: "pending" });
      this.persistClientSession(profileName, secret, client);
      this.markSuccess();

      const parsed = parseDreamReviewHud(response, currentProfileState.lastAnnouncedProposalIds);
      const advanceAnnouncement = event.type === "turn.started";
      const nextAnnouncedIds = advanceAnnouncement
        ? parsed.pendingIds.slice(0, MAX_TRACKED_ANNOUNCED_DREAM_PROPOSAL_IDS)
        : currentProfileState.lastAnnouncedProposalIds;
      const nextAnnouncedAt = advanceAnnouncement ? event.occurredAt : currentProfileState.lastAnnouncedAt;
      const snapshot: RuntimeDreamReviewHudState = {
        refreshedAt: this.now().toISOString(),
        source: "live",
        stale: false,
        fetchError: null,
        summary: parsed.summary,
        newSinceLastAnnouncement: parsed.pendingIds.filter(
          (proposalId) => !currentProfileState.lastAnnouncedProposalIds.includes(proposalId)
        ).length,
        lastAnnouncedAt: nextAnnouncedAt,
        topItems: parsed.topItems,
      };

      updateRuntimeDreamReviewHudProfileState(this.deps.paths.state, profileName, (current) => ({
        ...current,
        snapshot,
        lastAnnouncedProposalIds: nextAnnouncedIds,
        lastAnnouncedAt: nextAnnouncedAt,
      }));

      return {
        state: snapshot,
        action: this.recordAction({
          eventId: event.eventId,
          profileName,
          type: "dream_refresh",
          status: "completed",
          mode: profile.memoryMode,
          reason:
            parsed.summary.pending > 0
              ? "Refreshed dream review HUD from hosted continuity state"
              : "Confirmed there are no pending dream proposals",
          queueItemId: null,
          details: {
            source: "live",
            pending: parsed.summary.pending,
            newSinceLastAnnouncement: snapshot.newSinceLastAnnouncement,
            truncated: parsed.summary.truncated,
          },
        }),
        warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markFailure(message);
      const cachedSnapshot = currentProfileState.snapshot;
      if (cachedSnapshot) {
        const fallback: RuntimeDreamReviewHudState = {
          ...cachedSnapshot,
          source: "cached",
          stale: true,
          fetchError: message,
        };
        updateRuntimeDreamReviewHudProfileState(this.deps.paths.state, profileName, (current) => ({
          ...current,
          snapshot: fallback,
        }));
        warnings.push(`Dream review HUD refresh failed; using cached state (${message})`);
        return {
          state: fallback,
          action: this.recordAction({
            eventId: event.eventId,
            profileName,
            type: "dream_refresh",
            status: "failed",
            mode: profile.memoryMode,
            reason: "Hosted dream review HUD refresh failed; returned cached state",
            queueItemId: null,
            details: {
              source: "cached",
              error: message,
              cachedPending: cachedSnapshot.summary.pending,
            },
          }),
          warnings,
        };
      }

      warnings.push(`Dream review HUD refresh failed (${message})`);
      return {
        state: null,
        action: this.recordAction({
          eventId: event.eventId,
          profileName,
          type: "dream_refresh",
          status: "failed",
          mode: profile.memoryMode,
          reason: "Hosted dream review HUD refresh failed and no cached state was available",
          queueItemId: null,
          details: {
            source: "none",
            error: message,
          },
        }),
        warnings,
      };
    }
  }

  // Fetch the operator's scheduled/due obligations and build the HUD state for the session banner.
  // Lean (no snapshot persistence): a transient fetch failure just drops the line for this turn
  // with a warning; the next turn refetches. Not metered server-side.
  private async refreshObligationsHud(
    profileName: string,
    profile: RuntimeLifecycleProfile,
    secret: RuntimeLifecycleSecret,
    event: RuntimeLifecycleEvent
  ): Promise<{ state: RuntimeObligationsHudState | null; action: RuntimeMemoryActionRecord | null; warnings: string[] }> {
    const warnings: string[] = [];
    try {
      const client = this.buildClient(profile, secret);
      const response = await client.inspectObligations({
        statuses: ["scheduled", "due"],
        limit: OBLIGATIONS_HUD_SAMPLE_LIMIT,
      });
      this.persistClientSession(profileName, secret, client);
      this.markSuccess();

      const responseRecord = asRecord(response);
      const summary = parseObligationsHudSummary(responseRecord?.summary);
      const topItems = parseObligationsHudItems(responseRecord?.obligations);
      const snapshot: RuntimeObligationsHudState = {
        refreshedAt: this.now().toISOString(),
        source: "live",
        stale: false,
        fetchError: null,
        summary,
        topItems,
      };

      return {
        state: snapshot,
        action: this.recordAction({
          eventId: event.eventId,
          profileName,
          type: "obligations_refresh",
          status: "completed",
          mode: profile.memoryMode,
          reason:
            summary.total > 0
              ? "Refreshed obligations HUD from hosted obligations"
              : "Confirmed no scheduled obligations",
          queueItemId: null,
          details: {
            source: "live",
            total: summary.total,
            due: summary.due,
            scheduled: summary.scheduled,
          },
        }),
        warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markFailure(message);
      warnings.push(`Obligations HUD refresh failed (${message})`);
      return {
        state: null,
        action: this.recordAction({
          eventId: event.eventId,
          profileName,
          type: "obligations_refresh",
          status: "failed",
          mode: profile.memoryMode,
          reason: "Hosted obligations HUD refresh failed",
          queueItemId: null,
          details: { source: "none", error: message },
        }),
        warnings,
      };
    }
  }

  private buildResponse(
    event: RuntimeLifecycleEvent,
    mode: RuntimeLifecycleMemoryMode,
    state: RuntimeQueueState,
    inbox: RuntimeInboxHudState | null,
    dreamReview: RuntimeDreamReviewHudState | null,
    obligations: RuntimeObligationsHudState | null,
    contextPack: Record<string, unknown> | null,
    actions: RuntimeMemoryActionRecord[],
    warnings: string[]
  ): RuntimeLifecycleEventResponse {
    return {
      accepted: true,
      event,
      mode,
      queueDepth: state.items.length,
      pendingHotWrites: state.items.filter((item) => item.kind === "hot_write").length,
      pendingColdBatches: state.items.filter((item) => item.kind === "cold_batch").length,
      backpressure: state.items.length > this.maxQueueDepth,
      inbox,
      dreamReview,
      obligations,
      contextPack,
      actions,
      warnings,
    };
  }

  private normalizeEvent(request: RuntimeLifecycleEventRequest, profileName: string): RuntimeLifecycleEvent {
    return {
      eventId: request.eventId?.trim() || randomUUID(),
      runtime: request.runtime.trim(),
      profileName,
      workspaceId: request.workspaceId ?? null,
      sessionId: request.sessionId ?? null,
      turnId: request.turnId ?? null,
      type: request.type,
      occurredAt: parseIsoOrNow(request.occurredAt, this.now),
      payload: request.payload ?? {},
      metadata: request.metadata ?? {},
    };
  }

  private hydrateEventFromPriorTurnStart(event: RuntimeLifecycleEvent): RuntimeLifecycleEvent {
    if (event.type !== "turn.completed" && event.type !== "turn.failed" && event.type !== "session.ended") {
      return event;
    }
    const hasGoal = Boolean(asString(event.payload.goal));
    const transcript = Array.isArray(event.payload.transcript) ? event.payload.transcript : [];
    const hasUserTranscript = transcript.some((entry) => {
      const item = asRecord(entry);
      return item?.role === "user" && Boolean(asString(item.content));
    });
    if (hasGoal && hasUserTranscript && event.type !== "session.ended") {
      return event;
    }

    const priorEvents = readJsonLines<RuntimeLifecycleEvent>(eventsFile(this.deps.paths.state), 500);
    const matchingPriorEvent = (candidate: RuntimeLifecycleEvent): boolean => {
      if (
        candidate.runtime !== event.runtime ||
        candidate.profileName !== event.profileName ||
        candidate.workspaceId !== event.workspaceId
      ) {
        return false;
      }
      if (event.turnId) {
        return candidate.turnId === event.turnId;
      }
      return Boolean(event.sessionId && candidate.sessionId === event.sessionId);
    };
    const priorStart = priorEvents
      .slice()
      .reverse()
      .find((candidate) => {
        if (candidate.type !== "turn.started") {
          return false;
        }
        return matchingPriorEvent(candidate);
      });
    const priorCompletion =
      event.type === "session.ended"
        ? priorEvents
            .slice()
            .reverse()
            .find(
              (candidate) =>
                (candidate.type === "turn.completed" || candidate.type === "turn.failed") && matchingPriorEvent(candidate)
            )
        : null;
    if (!priorStart && !priorCompletion) {
      return event;
    }

    const hydratedPayload = { ...event.payload };
    const priorGoal = asString(priorStart?.payload.goal) ?? asString(priorCompletion?.payload.goal);
    if (!hasGoal && priorGoal) {
      hydratedPayload.goal = priorGoal;
    }
    const priorTranscript = Array.isArray(priorStart?.payload.transcript)
      ? priorStart.payload.transcript
      : Array.isArray(priorCompletion?.payload.transcript)
        ? priorCompletion.payload.transcript
        : null;
    if (!hasUserTranscript && priorTranscript) {
      const priorUserTranscript = priorTranscript.filter((entry) => {
        const item = asRecord(entry);
        return item?.role === "user" && Boolean(asString(item.content));
      });
      if (priorUserTranscript.length > 0) {
        hydratedPayload.transcript = [...priorUserTranscript, ...transcript];
      }
    }
    if (priorCompletion) {
      const priorSummary = asString(priorCompletion.payload.summary) ?? asString(priorCompletion.payload.result);
      if (priorSummary && !asString(hydratedPayload.turnSummary) && !asString(hydratedPayload.turn_summary)) {
        hydratedPayload.turnSummary = priorSummary;
        hydratedPayload.turnStatus = priorCompletion.type === "turn.failed" ? "failed" : "completed";
      }
    }

    return {
      ...event,
      payload: hydratedPayload,
      metadata: {
        ...event.metadata,
        ...(priorStart ? { hydratedFromTurnStartedEventId: priorStart.eventId } : {}),
        ...(priorCompletion ? { hydratedFromTurnCompletionEventId: priorCompletion.eventId } : {}),
      },
    };
  }

  private resolveProfile(
    profileName: string | null
  ): { profileName: string; profile: RuntimeLifecycleProfile; secret: RuntimeLifecycleSecret } {
    const resolvedProfileName = profileName ?? this.deps.loadDefaultProfileName();
    if (!resolvedProfileName) {
      throw new Error("No runtime profile is configured");
    }
    const profile = this.deps.loadProfile(resolvedProfileName);
    if (!profile) {
      throw new Error(`Unknown runtime profile: ${resolvedProfileName}`);
    }
    const secret = this.deps.loadSecret(resolvedProfileName);
    if (!secret) {
      throw new Error(`Missing secure-store secret for profile ${resolvedProfileName}`);
    }
    return {
      profileName: resolvedProfileName,
      profile,
      secret,
    };
  }

  private buildClient(profile: RuntimeLifecycleProfile, secret: RuntimeLifecycleSecret): HostedOnlyBotsClient {
    return new HostedOnlyBotsClient({
      apiBase: profile.apiBase,
      npub: profile.npub,
      nsec: secret.nsec,
      session: secret.session,
    });
  }

  private persistClientSession(profileName: string, secret: RuntimeLifecycleSecret, client: HostedOnlyBotsClient): void {
    this.deps.saveSecret(profileName, {
      ...secret,
      session: client.session(),
    });
  }

  private markSuccess(): void {
    const current = this.deps.loadHealth();
    this.deps.saveHealth({
      ...current,
      lastSuccessfulSyncAt: this.now().toISOString(),
      lastError: null,
    });
  }

  private markFailure(message: string): void {
    const current = this.deps.loadHealth();
    this.deps.saveHealth({
      ...current,
      lastError: message,
    });
  }

  private recordEvent(event: RuntimeLifecycleEvent): void {
    appendJsonLine(eventsFile(this.deps.paths.state), sanitizeValue(event));
    this.deps.writeLog("lifecycle.event", {
      eventId: event.eventId,
      profileName: event.profileName,
      type: event.type,
    });
  }

  private recordAction(
    input: Omit<RuntimeMemoryActionRecord, "id" | "createdAt">
  ): RuntimeMemoryActionRecord {
    const action: RuntimeMemoryActionRecord = {
      id: randomUUID(),
      createdAt: this.now().toISOString(),
      ...input,
      details: sanitizeValue(input.details) as Record<string, unknown>,
    };
    appendJsonLine(actionsFile(this.deps.paths.state), action);
    this.deps.writeLog("lifecycle.action", {
      actionId: action.id,
      profileName: action.profileName,
      type: action.type,
      status: action.status,
    });
    return action;
  }

  private enqueueHotWrite(
    state: RuntimeQueueState,
    event: RuntimeLifecycleEvent,
    hotState: Record<string, unknown>,
    options: { immediate?: boolean } = {}
  ): Extract<RuntimeQueueItem, { kind: "hot_write" }> {
    // Independent workspaces must not coalesce into the same pending write.
    const scope = event.runtime || undefined;
    const key = `hot:${event.profileName}:${workspaceHotScope(scope, event.workspaceId) || "global"}`;
    const now = this.now();
    const dueAt = options.immediate ? now.toISOString() : new Date(now.getTime() + this.hotWriteDebounceMs).toISOString();
    const existing = state.items.find(
      (item): item is Extract<RuntimeQueueItem, { kind: "hot_write" }> => item.kind === "hot_write" && item.key === key && !this.claimedQueueItems.has(item.id)
    );
    if (existing) {
      existing.eventId = event.eventId;
      existing.sessionId = event.sessionId;
      existing.workspaceId = event.workspaceId;
      existing.availableAt = dueAt;
      existing.payload.hotState = hotState;
      existing.payload.scope = scope;
      return existing;
    }
    const item: Extract<RuntimeQueueItem, { kind: "hot_write" }> = {
      id: randomUUID(),
      key,
      kind: "hot_write",
      profileName: event.profileName,
      eventId: event.eventId,
      sessionId: event.sessionId,
      workspaceId: event.workspaceId,
      createdAt: now.toISOString(),
      availableAt: dueAt,
      attempts: 0,
      payload: {
        hotState,
        scope,
      },
    };
    state.items.push(item);
    return item;
  }

  private enqueueColdBatch(
    state: RuntimeQueueState,
    event: RuntimeLifecycleEvent,
    items: RuntimeColdBatchItem[]
  ): Extract<RuntimeQueueItem, { kind: "cold_batch" }> {
    const key = `cold:${event.profileName}:${event.sessionId ?? event.workspaceId ?? "global"}`;
    const now = this.now();
    const dueAt = new Date(now.getTime() + this.coldBatchWindowMs).toISOString();
    const existing = state.items.find(
      (item): item is Extract<RuntimeQueueItem, { kind: "cold_batch" }> => item.kind === "cold_batch" && item.key === key && !this.claimedQueueItems.has(item.id)
    );
    if (existing) {
      existing.eventId = event.eventId;
      existing.sessionId = event.sessionId;
      existing.workspaceId = event.workspaceId;
      existing.availableAt = dueAt;
      existing.payload.items.push(...items);
      return existing;
    }
    const item: Extract<RuntimeQueueItem, { kind: "cold_batch" }> = {
      id: randomUUID(),
      key,
      kind: "cold_batch",
      profileName: event.profileName,
      eventId: event.eventId,
      sessionId: event.sessionId,
      workspaceId: event.workspaceId,
      createdAt: now.toISOString(),
      availableAt: dueAt,
      attempts: 0,
      payload: {
        items: [...items],
      },
    };
    state.items.push(item);
    return item;
  }

  private enqueueWarmCommit(
    state: RuntimeQueueState,
    event: RuntimeLifecycleEvent,
    candidate: WarmPromotionCandidate
  ): Extract<RuntimeQueueItem, { kind: "warm_commit" }> {
    const item: Extract<RuntimeQueueItem, { kind: "warm_commit" }> = {
      id: randomUUID(),
      key: `warm:${event.profileName}:${candidate.candidateId}`,
      kind: "warm_commit",
      profileName: event.profileName,
      eventId: event.eventId,
      sessionId: event.sessionId,
      workspaceId: event.workspaceId,
      createdAt: this.now().toISOString(),
      availableAt: this.now().toISOString(),
      attempts: 0,
      payload: {
        candidate,
      },
    };
    state.items.push(item);
    return item;
  }

  private async processDueItems(state: RuntimeQueueState, force: boolean, persistState = true): Promise<RuntimeQueueState> {
    const continuity = this.deps.loadContinuityGovernorState();
    if (continuity.paused) {
      if (persistState) this.saveQueueState(state);
      return state;
    }

    if (hotSyncEnabled()) tickHotSyncManagers(this.deps.paths.state);
    const now = this.now().getTime();
    const remaining: RuntimeQueueItem[] = [];
    const ready = state.items.filter((item) => force || new Date(item.availableAt).getTime() <= now);
    const pending = state.items.filter((item) => !ready.includes(item));

    for (const item of ready) {
      if (this.deps.loadContinuityGovernorState().paused) { remaining.push(item); continue; }
      try {
        const result = await this.processQueueItem(item);
        const warmDecision =
          item.kind === "warm_commit" &&
          result &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          result.decision &&
          typeof result.decision === "object" &&
          !Array.isArray(result.decision)
            ? (sanitizeValue(result.decision) as Record<string, unknown>)
            : null;
        this.recordAction({
          eventId: item.eventId,
          profileName: item.profileName,
          type: item.kind === "cold_batch" ? "cold_batch" : item.kind,
          status: "completed",
          mode: this.deps.loadProfile(item.profileName)?.memoryMode ?? "assist",
          reason:
            item.kind === "hot_write"
              ? "Flushed hot-memory update"
              : item.kind === "cold_batch"
                ? "Flushed cold-memory batch"
                : typeof warmDecision?.outcome === "string"
                  ? `Warm-memory candidate ${warmDecision.outcome}`
                  : "Committed warm-memory candidate",
          queueItemId: item.id,
          details:
            item.kind === "cold_batch"
              ? { items: item.payload.items.length }
              : item.kind === "warm_commit"
                ? {
                    candidate: sanitizeValue(item.payload.candidate) as Record<string, unknown>,
                    ...(warmDecision ? { decision: warmDecision } : {}),
                  }
                : {
                    sessionId: item.sessionId,
                    workspaceId: item.workspaceId,
                  },
        });
        this.markSuccess();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = item.attempts + 1;
        if (item.kind === "cold_batch" && isUnknownOrForeignContextPackError(message)) {
          const retryableItems = item.payload.items.filter((coldItem) => !isPackBoundContinuityOutcomeItem(coldItem));
          const droppedItems = item.payload.items.length - retryableItems.length;
          if (retryableItems.length > 0 && droppedItems > 0) {
            const retryItem: Extract<RuntimeQueueItem, { kind: "cold_batch" }> = {
              ...item,
              attempts,
              availableAt: this.now().toISOString(),
              payload: {
                items: retryableItems,
              },
            };
            remaining.push(retryItem);
            this.recordAction({
              eventId: item.eventId,
              profileName: item.profileName,
              type: "queue_retry",
              status: "retrying",
              mode: this.deps.loadProfile(item.profileName)?.memoryMode ?? "assist",
              reason: "Retrying cold batch after dropping stale or foreign context-pack evidence",
              queueItemId: item.id,
              details: {
                kind: item.kind,
                attempts,
                retryAt: retryItem.availableAt,
                retryableItems: retryableItems.length,
                droppedItems,
              },
            });
          }
          this.recordAction({
            eventId: item.eventId,
            profileName: item.profileName,
            type: "cold_batch",
            status: "skipped",
            mode: this.deps.loadProfile(item.profileName)?.memoryMode ?? "assist",
            reason: "Hosted cold ingest rejected stale or foreign pack_id; dropped non-retryable continuity evidence",
            queueItemId: item.id,
            details: {
              error: message,
              attempts,
              items: item.payload.items.length,
              retryableItems: retryableItems.length,
              droppedItems,
            },
          });
          continue;
        }
        if (attempts >= this.maxQueueAttempts) {
          this.recordAction({
            eventId: item.eventId,
            profileName: item.profileName,
            type: "queue_dead_letter",
            status: "failed",
            mode: this.deps.loadProfile(item.profileName)?.memoryMode ?? "assist",
            reason: message,
            queueItemId: item.id,
            details: {
              kind: item.kind,
              attempts,
            },
          });
        } else {
          const retryDelayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 5));
          const retryItem: RuntimeQueueItem = {
            ...item,
            attempts,
            availableAt: new Date(this.now().getTime() + retryDelayMs).toISOString(),
          };
          remaining.push(retryItem);
          this.recordAction({
            eventId: item.eventId,
            profileName: item.profileName,
            type: "queue_retry",
            status: "retrying",
            mode: this.deps.loadProfile(item.profileName)?.memoryMode ?? "assist",
            reason: message,
            queueItemId: item.id,
            details: {
              kind: item.kind,
              attempts,
              retryAt: retryItem.availableAt,
            },
          });
        }
        this.markFailure(message);
      }
    }

    state.items = [...pending, ...remaining];
    if (persistState) this.saveQueueState(state);
    return state;
  }

  private async processQueueItem(item: RuntimeQueueItem): Promise<Record<string, unknown> | null> {
    const { profile, secret } = this.resolveProfile(item.profileName);
    if (item.kind === "hot_write" && isLocalOnlyRuntimeProfile(profile)) {
      const partition = workspaceHotScope(item.payload.scope, item.workspaceId);
      if (partition !== item.payload.scope) writeLocalHotMemory(this.deps.paths.state, JSON.stringify(item.payload.hotState, null, 2), partition);
      writeLocalHotMemory(this.deps.paths.state, JSON.stringify(item.payload.hotState, null, 2), item.payload.scope);
      return null;
    }
    const client = this.buildClient(profile, secret);
    if (item.kind === "hot_write") {
      const partition = workspaceHotScope(item.payload.scope, item.workspaceId);
      if (partition !== item.payload.scope) await client.writeHotMemory(JSON.stringify(item.payload.hotState, null, 2), partition);
      await client.writeHotMemory(JSON.stringify(item.payload.hotState, null, 2), item.payload.scope);
    } else if (item.kind === "cold_batch") {
      await client.ingestColdMemory(item.payload.items);
    } else {
      const result = await client.createWarmMemory(item.payload.candidate as unknown as Record<string, unknown>);
      this.persistClientSession(item.profileName, secret, client);
      return result;
    }
    this.persistClientSession(item.profileName, secret, client);
    return null;
  }
}
