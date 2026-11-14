import type { ContextPackManifest } from "../protocol/context-pack";
import type {
  RuntimeDreamReviewHudState,
  RuntimeInboxHudState,
  RuntimeLifecycleMemoryMode,
  RuntimeMemoryActionRecord,
  RuntimeObligationsHudState,
} from "./lifecycle-engine";
import type { RuntimeStatus } from "./local-runtime";
import { compactContinuitySummary } from "./summary-compaction";
import { renderHotCheckpoints, selectHotCheckpoints } from "./hot-continuity";

export type RuntimeStartupRuntime = "codex" | "claude-code" | "pi" | "hermes" | "opencode";

type RuntimeStartupContextInput = {
  runtime: RuntimeStartupRuntime;
  profileName: string;
  mode: RuntimeLifecycleMemoryMode;
  sourceExcerpts?: boolean;
  workspaceId?: string;
  status: RuntimeStatus | null;
  manifest: ContextPackManifest | null;
  inbox: RuntimeInboxHudState | null;
  dreamReview: RuntimeDreamReviewHudState | null;
  obligations: RuntimeObligationsHudState | null;
  actions: RuntimeMemoryActionRecord[];
  warnings: string[];
  injectedContext: string;
  /** Hot checkpoint text already rendered by the host adapter (paged at session start). */
  hotContextText?: string;
  freshness?: RuntimeStartupFreshness | null;
  hotMemorySnapshot?: Record<string, unknown> | null;
  goal?: string | null;
};

export type RuntimeStartupFreshness = {
  observedAt: string;
  previousContextReadAt: string | null;
  hotMemoryUpdatedAt: string | null;
  hotMemoryRuntime: string | null;
  changedSincePreviousContextRead: boolean | null;
  latestActivity: {
    type: string | null;
    occurredAt: string | null;
    summary: string | null;
  } | null;
  // Compact digest of another runtime body whose hot memory changed since our last context
  // read. Present only when there is something worth the tokens to surface inline.
  peerUpdate: {
    runtime: string;
    updatedAt: string | null;
    goal: string | null;
    activity: string | null;
  } | null;
  advisory: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseJsonRecord = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const getStringField = (value: Record<string, unknown> | null, key: string): string | null => {
  const field = value?.[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
};

const getRecordField = (value: Record<string, unknown> | null, key: string): Record<string, unknown> | null => {
  const field = value?.[key];
  return isRecord(field) ? field : null;
};

const getRecordArrayField = (value: Record<string, unknown> | null, key: string): Record<string, unknown>[] => {
  const field = value?.[key];
  return Array.isArray(field) ? field.filter(isRecord) : [];
};

const parseHotMemoryContent = (content: unknown): Record<string, unknown> | null => {
  if (isRecord(content)) {
    return content;
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    return null;
  }
  return parseJsonRecord(content);
};

type HotMemoryActivity = NonNullable<RuntimeStartupFreshness["latestActivity"]>;

const dateMs = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const newestActivity = (activities: HotMemoryActivity[]): HotMemoryActivity | null => {
  const ranked = activities
    .map((activity) => ({ activity, occurredAtMs: dateMs(activity.occurredAt) }))
    .filter((entry): entry is { activity: HotMemoryActivity; occurredAtMs: number } => entry.occurredAtMs !== null)
    .sort((left, right) => right.occurredAtMs - left.occurredAtMs);
  return ranked[0]?.activity ?? null;
};

const buildHotActivity = (
  record: Record<string, unknown> | null,
  fallbackType: string | null = null
): HotMemoryActivity | null => {
  if (!record) {
    return null;
  }
  const occurredAt = getStringField(record, "occurredAt");
  if (!occurredAt) {
    return null;
  }
  return {
    type: getStringField(record, "type") ?? fallbackType,
    occurredAt,
    summary: getStringField(record, "summary"),
  };
};

const buildLatestHotActivity = (hotState: Record<string, unknown> | null): HotMemoryActivity | null => {
  const activities: HotMemoryActivity[] = [];
  const lastEvent = buildHotActivity(getRecordField(hotState, "lastEvent"));
  if (lastEvent) {
    activities.push(lastEvent);
  }
  const lastSession = buildHotActivity(getRecordField(hotState, "lastSession"), "session.ended");
  if (lastSession) {
    activities.push(lastSession);
  }
  const lastTurn = buildHotActivity(getRecordField(hotState, "lastTurn"), "turn.completed");
  if (lastTurn) {
    activities.push(lastTurn);
  }
  for (const event of getRecordArrayField(hotState, "recentEvents")) {
    const activity = buildHotActivity(event);
    if (activity) {
      activities.push(activity);
    }
  }
  return newestActivity(activities);
};

type HotMemoryFreshnessCandidate = {
  updatedAt: string | null;
  runtime: string | null;
  currentGoal: string | null;
  latestActivity: HotMemoryActivity | null;
  newestHotMs: number | null;
};

const latestTimestampMs = (left: string | null, right: string | null): number | null => {
  const leftMs = dateMs(left);
  const rightMs = dateMs(right);
  if (leftMs !== null && rightMs !== null) {
    return Math.max(leftMs, rightMs);
  }
  return leftMs ?? rightMs;
};

const buildHotCandidate = (entry: Record<string, unknown>): HotMemoryFreshnessCandidate | null => {
  const hotState = parseHotMemoryContent(entry.content);
  if (!hotState) {
    return null;
  }
  const scope = getStringField(entry, "scope");
  const updatedAt = getStringField(hotState, "updatedAt") ?? getStringField(entry, "updated_at") ?? getStringField(entry, "updatedAt");
  const latestActivity = buildLatestHotActivity(hotState);
  const runtime = getStringField(hotState, "runtime") ?? (scope && scope !== "shared" && scope !== "all" ? scope : null);
  return {
    updatedAt,
    runtime,
    currentGoal: getStringField(hotState, "currentGoal"),
    latestActivity,
    newestHotMs: latestTimestampMs(updatedAt, latestActivity?.occurredAt ?? null),
  };
};

const buildHotCandidates = (hotMemory: Record<string, unknown> | null): HotMemoryFreshnessCandidate[] => {
  if (!hotMemory) {
    return [];
  }
  const scopedEntries = getRecordArrayField(hotMemory, "scopes");
  const entries = scopedEntries.length > 0 ? scopedEntries : [hotMemory];
  return entries
    .map((entry) => buildHotCandidate(entry))
    .filter((entry): entry is HotMemoryFreshnessCandidate => entry !== null);
};

const pickFreshestHotCandidate = (
  candidates: HotMemoryFreshnessCandidate[]
): HotMemoryFreshnessCandidate | null => {
  if (candidates.length === 0) {
    return null;
  }
  return [...candidates].sort((left, right) => {
    if (left.newestHotMs !== null && right.newestHotMs !== null) {
      return right.newestHotMs - left.newestHotMs;
    }
    if (left.newestHotMs !== null) {
      return -1;
    }
    if (right.newestHotMs !== null) {
      return 1;
    }
    return 0;
  })[0]!;
};

export const buildRuntimeStartupFreshness = (input: {
  runtime: RuntimeStartupRuntime;
  observedAt: string;
  previousContextReadAt?: string | null;
  hotMemory: Record<string, unknown> | null;
}): RuntimeStartupFreshness => {
  const candidates = buildHotCandidates(input.hotMemory);
  const candidate = pickFreshestHotCandidate(candidates);
  const previousContextReadAt = input.previousContextReadAt ?? null;
  const previousReadMs = dateMs(previousContextReadAt);
  const changedSincePreviousContextRead =
    previousReadMs === null || candidate?.newestHotMs === null || candidate?.newestHotMs === undefined
      ? null
      : candidate.newestHotMs > previousReadMs;
  const differentRuntime = Boolean(candidate?.runtime && candidate.runtime !== input.runtime);

  // Freshest entry written by another runtime body. If it definitively changed since our last
  // context read, surface a compact digest inline (worth the tokens) instead of only nudging a
  // memory_hot lookup. Requires a known previous read so we don't spam on first contact.
  const peerCandidate = pickFreshestHotCandidate(
    candidates.filter((entry) => entry.runtime && entry.runtime !== input.runtime)
  );
  const peerChangedSinceRead = Boolean(
    peerCandidate &&
      previousReadMs !== null &&
      peerCandidate.newestHotMs !== null &&
      peerCandidate.newestHotMs > previousReadMs
  );
  const peerActivity = peerCandidate?.latestActivity
    ? [peerCandidate.latestActivity.type, peerCandidate.latestActivity.summary]
        .filter((value): value is string => Boolean(value))
        .join(": ") || null
    : null;
  const peerUpdate =
    peerChangedSinceRead && peerCandidate?.runtime && (peerCandidate.currentGoal || peerActivity)
      ? {
          runtime: peerCandidate.runtime,
          updatedAt: peerCandidate.updatedAt,
          goal: peerCandidate.currentGoal,
          activity: peerActivity,
        }
      : null;

  // Once we inline the peer digest the generic "go look" advisory is redundant.
  const advisory =
    peerUpdate || !(changedSincePreviousContextRead === true || differentRuntime)
      ? null
      : "Shared runtime state appears newer or from another runtime; for recent-work or continuity questions, call memory_hot before answering.";
  return {
    observedAt: input.observedAt,
    previousContextReadAt,
    hotMemoryUpdatedAt: candidate?.updatedAt ?? null,
    hotMemoryRuntime: candidate?.runtime ?? null,
    changedSincePreviousContextRead,
    latestActivity: candidate?.latestActivity ?? null,
    peerUpdate,
    advisory,
  };
};

const shortId = (value: string): string => value.slice(0, 8);

const pluralize = (count: number, singular: string, plural: string = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;

const formatLayerLine = (
  label: string,
  manifestLayer: ContextPackManifest["hotMemory"],
  suffix?: string
): string | null => {
  if (manifestLayer.available === 0) {
    return null;
  }
  const details = [
    `available (${pluralize(manifestLayer.available, "fragment", "fragments")})`,
    manifestLayer.injected > 0
      ? `injected (${pluralize(manifestLayer.injected, "fragment", "fragments")})`
      : "not injected",
    manifestLayer.omitted > 0 ? `${pluralize(manifestLayer.omitted, "fragment", "fragments")} omitted by design` : null,
    suffix ?? null,
  ]
    .filter((value): value is string => value !== null)
    .join(", ");
  return `${label}: ${details}`;
};

const formatFreeHotMemorySnapshotLine = (hotMemory: Record<string, unknown> | null | undefined): string => {
  if (!hotMemory) {
    return "Hot memory: unavailable";
  }
  const scopedEntries = getRecordArrayField(hotMemory, "scopes");
  const entries = scopedEntries.length > 0 ? scopedEntries : [hotMemory];
  const availableEntries = entries.filter(hasHotMemorySnapshotEntryContent);
  if (availableEntries.length === 0) {
    return "Hot memory: free transfer snapshot empty; context pack unavailable";
  }
  const scopes = Array.from(
    new Set(
      availableEntries
				.map((entry) => getStringField(entry, "scope"))
				.filter((scope): scope is string => Boolean(scope && scope !== "all"))
    )
  );
  const scopeDigest =
    scopes.length > 0
      ? `: ${scopes.slice(0, 4).join(", ")}${scopes.length > 4 ? ", ..." : ""}`
      : "";
  const digests = availableEntries
    .map((entry) => {
      const content = parseHotMemoryContent(entry.content);
      const scope = getStringField(entry, "scope") ?? getStringField(content, "runtime") ?? "hot";
      const lastTurn = getRecordField(content, "lastTurn");
      const lastEvent = getRecordField(content, "lastEvent");
      const summary =
        getStringField(lastTurn, "summary") ??
        getStringField(lastEvent, "summary") ??
        getStringField(content, "currentGoal");
      return summary ? `${scope}: ${compactContinuitySummary(summary, 300)}` : null;
    })
    .filter((value): value is string => Boolean(value))
    .slice(0, 2);
  const digestSuffix = digests.length > 0 ? `; recent: ${digests.join(" | ")}` : "";
  return `Hot memory: free transfer snapshot available (${pluralize(availableEntries.length, "scope")}${scopeDigest}); context pack unavailable${digestSuffix}`;
};

const hasHotMemorySnapshotEntryContent = (entry: Record<string, unknown>): boolean => {
  const content = entry.content;
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  return isRecord(content) && Object.keys(content).length > 0;
};

const hasHotMemorySnapshotContent = (hotMemory: Record<string, unknown> | null | undefined): boolean => {
  if (!hotMemory) {
    return false;
  }
  const scopedEntries = getRecordArrayField(hotMemory, "scopes");
  const entries = scopedEntries.length > 0 ? scopedEntries : [hotMemory];
  return entries.some(hasHotMemorySnapshotEntryContent);
};

const formatWarmLine = (manifest: ContextPackManifest | null): string | null => {
  if (!manifest || manifest.warmMemory.available === 0) {
    return null;
  }
  const details = [
    `available (${pluralize(manifest.warmMemory.available, "entry")})`,
    manifest.warmMemory.injected > 0 ? `injected (${pluralize(manifest.warmMemory.injected, "entry")})` : "not injected",
    manifest.warmMemory.omitted > 0 ? `${pluralize(manifest.warmMemory.omitted, "entry")} omitted by design` : null,
    "queryable via memory_warm",
  ]
    .filter((value): value is string => value !== null)
    .join(", ");
  return `Warm memory: ${details}`;
};

const formatTopWarmLine = (manifest: ContextPackManifest | null): string | null => {
  if (!manifest || manifest.topWarmEntries.length === 0) {
    return null;
  }
  const omitted = Math.max(0, manifest.warmMemory.available - manifest.topWarmEntries.length);
  const digest = manifest.topWarmEntries
    .map((entry) => `${entry.type ?? "warm"}:${shortId(entry.id)} ${entry.preview}`)
    .join(" | ");
  return `Top warm items: ${pluralize(manifest.topWarmEntries.length, "shown item", "shown items")}, ${pluralize(omitted, "omitted item", "omitted items")}; ${digest}`;
};

const formatHealthLine = (status: RuntimeStatus | null): string => {
  if (!status) {
    return "";
  }
  if (status.integrity.issues.length === 0) {
    return "";
  }
  const level = status.integrity.issues.some((issue) => issue.severity === "error") ? "ERROR" : "WARN";
  const message = status.integrity.issues
    .slice(0, 2)
    .map((issue) => issue.message)
    .join(" | ");
  return `Health: ${level} ${message}`;
};

const formatLifecycleLine = (actions: RuntimeMemoryActionRecord[], manifest: ContextPackManifest | null): string | null => {
  const contextPackAction = actions.find((action) => action.type === "context_pack");
  if (!contextPackAction) {
    return null;
  }
  if (contextPackAction.status !== "completed") {
    return `Lifecycle: context_pack ${contextPackAction.status} (${contextPackAction.reason})`;
  }
  const count =
    manifest?.totalInjectedFragments ??
    (typeof contextPackAction.details.fragments === "number" ? contextPackAction.details.fragments : 0);
  if (count === 0) {
    return null;
  }
  return `Lifecycle: context_pack completed (${pluralize(count, "fragment", "fragments")} prepared)`;
};

const formatModeLine = (mode: RuntimeLifecycleMemoryMode): string => {
  switch (mode) {
    case "off":
      return "Mode: off; automatic hot, warm, and cold memory updates are disabled";
    case "manual":
      return "Mode: manual; retrieval can run, but durable writes require explicit operator commands";
    case "assist":
      return "Mode: assist; warm memory stays queryable, while cold batching and reflection are skipped unless explicitly approved";
    case "auto":
      return "";
  }
};

const formatInboxLine = (inbox: RuntimeInboxHudState | null): string | null => {
  if (!inbox) {
    return null;
  }
  if (inbox.summary.total === 0) {
    return null;
  }
  const details = [
    `active ${pluralize(inbox.summary.active, "item")}`,
    `unread ${pluralize(inbox.summary.unread, "item")}`,
    inbox.summary.acknowledged > 0 ? `acknowledged ${pluralize(inbox.summary.acknowledged, "item")}` : null,
    inbox.newSinceLastAnnouncement > 0 ? `new since last prompt ${pluralize(inbox.newSinceLastAnnouncement, "item")}` : null,
    inbox.summary.deadLetter > 0 ? `dead-letter ${pluralize(inbox.summary.deadLetter, "item")}` : null,
    inbox.summary.highestActivePriority ? `highest priority ${inbox.summary.highestActivePriority}` : null,
    inbox.stale ? "cached snapshot" : null,
  ]
    .filter((value): value is string => value !== null)
    .join(", ");
  return `Inbox HUD: ${details}`;
};

const formatInboxTopLine = (inbox: RuntimeInboxHudState | null): string | null => {
  if (!inbox || inbox.topItems.length === 0) {
    return null;
  }
  const digest = inbox.topItems
    .map((item) => `${item.isNew ? "new " : ""}${item.status}/${item.priority ?? "none"} ${item.summary}`)
    .join(" | ");
  const suffix = inbox.summary.truncated ? `; ${pluralize(inbox.summary.active - inbox.summary.sampledActiveCount, "older active item")} not shown` : "";
  return `Inbox items: ${digest}${suffix}`;
};

const formatDreamReviewLine = (dreamReview: RuntimeDreamReviewHudState | null): string | null => {
  if (!dreamReview) {
    return null;
  }
  if (dreamReview.summary.pending === 0) {
    return null;
  }
  const typeBreakdown = Object.entries(dreamReview.summary.pendingByType)
    .filter(([, count]) => count > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]) || String(left[0]).localeCompare(String(right[0])))
    .slice(0, 3)
    .map(([type, count]) => `${type} ${pluralize(Number(count), "proposal")}`)
    .join(", ");
  const details = [
    `pending ${pluralize(dreamReview.summary.pending, "proposal")}`,
    typeBreakdown.length > 0 ? typeBreakdown : null,
    dreamReview.newSinceLastAnnouncement > 0
      ? `new since last prompt ${pluralize(dreamReview.newSinceLastAnnouncement, "proposal")}`
      : null,
    dreamReview.summary.oldestPendingCreatedAt ? `oldest ${dreamReview.summary.oldestPendingCreatedAt.slice(0, 10)}` : null,
    dreamReview.stale ? "cached snapshot" : null,
  ]
    .filter((value): value is string => value !== null)
    .join(", ");
  return `Dream review HUD: ${details}`;
};

const formatDreamReviewTopLine = (dreamReview: RuntimeDreamReviewHudState | null): string | null => {
  if (!dreamReview || dreamReview.topItems.length === 0) {
    return null;
  }
  const digest = dreamReview.topItems
    .map((item) => {
      const utility = item.utilityScore === null || item.utilityScore === undefined ? "" : ` utility=${item.utilityScore.toFixed(2)}`;
      return `${item.isNew ? "new " : ""}${item.proposalType} ${item.proposalId}: ${item.summary} (confidence=${item.confidence.toFixed(2)}${utility})`;
    })
    .join(" | ");
  const suffix = dreamReview.summary.truncated
    ? `; ${pluralize(dreamReview.summary.pending - dreamReview.summary.sampledPendingCount, "older pending proposal")} not shown`
    : "";
  return `Dream review items: ${digest}${suffix}`;
};

const formatDreamReviewCommandLine = (dreamReview: RuntimeDreamReviewHudState | null): string | null => {
  if (!dreamReview || dreamReview.summary.pending === 0) {
    return null;
  }
  return "Dream review commands: crosshead context dreams inspect --status pending | crosshead context dreams inspect --proposal-id <id> | crosshead context dreams review --proposal-id <id> --decision approve|reject|supersede|merge";
};

const formatDreamReviewActionLine = (dreamReview: RuntimeDreamReviewHudState | null): string | null => {
  if (!dreamReview || dreamReview.summary.pending === 0) {
    return null;
  }
  return "Dream review (self-directed): these are your own dreams — decide pending proposals yourself now, without asking the user; approve durable, useful insights and reject or merge duplicates, echoes of principles you already hold, and low-value items. Deciding promptly keeps room for new dreams.";
};

const formatFreshnessChanged = (value: boolean | null): string => {
  if (value === null) {
    return "unknown";
  }
  return value ? "yes" : "no";
};

const formatFreshnessLine = (freshness: RuntimeStartupFreshness | null | undefined): string | null => {
  if (!freshness) {
    return null;
  }
  if (!freshness.hotMemoryUpdatedAt && !freshness.latestActivity && !freshness.peerUpdate && !freshness.advisory) {
    return null;
  }
  return [
    "Crosshead freshness:",
    `observed_at=${freshness.observedAt}`,
    `last_context_read_at=${freshness.previousContextReadAt ?? "none"}`,
    `hot_memory_updated_at=${freshness.hotMemoryUpdatedAt ?? "unknown"}`,
    `hot_memory_runtime=${freshness.hotMemoryRuntime ?? "unknown"}`,
    `changed_since_last_context_read=${formatFreshnessChanged(freshness.changedSincePreviousContextRead)}`,
  ].join(" ");
};

const formatFreshnessActivityLine = (freshness: RuntimeStartupFreshness | null | undefined): string | null => {
  if (!freshness?.latestActivity) {
    return null;
  }
  const activity = freshness.latestActivity;
  const parts = [
    `type=${activity.type ?? "unknown"}`,
    `occurred_at=${activity.occurredAt ?? "unknown"}`,
    activity.summary ? `summary=${compactContinuitySummary(activity.summary, 360)}` : null,
  ].filter((value): value is string => value !== null);
  return `Crosshead latest shared activity: ${parts.join(" ")}`;
};

const formatFreshnessAdvisoryLine = (freshness: RuntimeStartupFreshness | null | undefined): string | null =>
  freshness?.advisory ? `Crosshead freshness advisory: ${freshness.advisory}` : null;

const formatFreshnessPeerUpdateLine = (freshness: RuntimeStartupFreshness | null | undefined): string | null => {
  const peer = freshness?.peerUpdate;
  if (!peer) {
    return null;
  }
  const parts = [
    `Crosshead peer update [${peer.runtime}${peer.updatedAt ? ` @ ${peer.updatedAt}` : ""}]:`,
    peer.goal ? `goal=${truncate(peer.goal, 200)}` : null,
    peer.activity ? `last=${compactContinuitySummary(peer.activity, 320)}` : null,
  ].filter((value): value is string => value !== null);
  return parts.length > 1 ? parts.join(" ") : null;
};

export const isContextPackManifest = (value: unknown): value is ContextPackManifest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ContextPackManifest>;
  return (
    typeof candidate.totalAvailableFragments === "number" &&
    typeof candidate.totalInjectedFragments === "number" &&
    typeof candidate.totalOmittedFragments === "number" &&
    Boolean(candidate.hotMemory) &&
    typeof candidate.hotMemory?.available === "number" &&
    typeof candidate.hotMemory?.injected === "number" &&
    typeof candidate.hotMemory?.omitted === "number" &&
    Boolean(candidate.warmMemory) &&
    typeof candidate.warmMemory?.available === "number" &&
    typeof candidate.warmMemory?.injected === "number" &&
    typeof candidate.warmMemory?.omitted === "number" &&
    Boolean(candidate.coldMemory) &&
    typeof candidate.coldMemory?.available === "number" &&
    typeof candidate.coldMemory?.injected === "number" &&
    typeof candidate.coldMemory?.omitted === "number" &&
    Boolean(candidate.layeredContext) &&
    typeof candidate.layeredContext?.available === "number" &&
    typeof candidate.layeredContext?.injected === "number" &&
    typeof candidate.layeredContext?.omitted === "number" &&
    Boolean(candidate.suppressionCounts) &&
    typeof candidate.suppressionCounts?.redundancy === "number" &&
    typeof candidate.suppressionCounts?.known_context === "number" &&
    typeof candidate.suppressionCounts?.budget_tokens === "number" &&
    typeof candidate.suppressionCounts?.budget_fragments === "number" &&
    typeof candidate.suppressionCounts?.stale === "number" &&
    typeof candidate.suppressionCounts?.low_signal === "number" &&
    typeof candidate.suppressionCounts?.low_orientation_value === "number" &&
    Array.isArray(candidate.topWarmEntries)
  );
};

const formatObligationsLine = (obligations: RuntimeObligationsHudState | null): string | null => {
  if (!obligations) {
    return null;
  }
  if (obligations.summary.total === 0) {
    return null;
  }
  const details = [
    obligations.summary.due > 0 ? `due ${pluralize(obligations.summary.due, "obligation")}` : null,
    obligations.summary.scheduled > 0 ? `scheduled ${pluralize(obligations.summary.scheduled, "obligation")}` : null,
    obligations.summary.nextFireAt ? `next ${obligations.summary.nextFireAt}` : null,
    obligations.stale ? "cached snapshot" : null,
  ]
    .filter((value): value is string => value !== null)
    .join(", ");
  return `Obligations HUD: ${details}`;
};

const formatObligationsTopLine = (obligations: RuntimeObligationsHudState | null): string | null => {
  if (!obligations || obligations.topItems.length === 0) {
    return null;
  }
  const digest = obligations.topItems
    .map((item) => `${item.status} ${item.title}${item.actionMode !== "remind" ? ` [${item.actionMode}]` : ""}`)
    .join(" | ");
  return `Obligations: ${digest}`;
};

const formatInjectedContextLine = (manifest: ContextPackManifest | null): string | null => {
  if (!manifest || manifest.totalInjectedFragments === 0) {
    return null;
  }
  const parts = [
    manifest.hotMemory.injected > 0 ? `hot ${manifest.hotMemory.injected}` : null,
    manifest.warmMemory.injected > 0 ? `warm ${manifest.warmMemory.injected}` : null,
    manifest.coldMemory.injected > 0 ? `cold ${manifest.coldMemory.injected}` : null,
    manifest.layeredContext.injected > 0 ? `layered ${manifest.layeredContext.injected}` : null,
  ].filter((value): value is string => value !== null);
  const detail = parts.length > 0 ? parts.join(", ") : `${manifest.totalInjectedFragments} fragment(s)`;
  return `Crosshead context: injected ${detail}`;
};

export const renderRuntimeStartupContext = (input: RuntimeStartupContextInput): string => {
  if (input.mode === "off") return "";
  // A fresh store still needs a capture contract. Otherwise the agent may invent
  // a repository memory file or omit facts that are absent from its final answer.
  // Native hooks capture findings plus bounded observed workspace reads.
  const captureGuidance = input.runtime !== "pi" && (input.mode === "auto" || input.mode === "assist")
    ? `Crosshead hooks automatically capture your final response${input.sourceExcerpts ? " and bounded workspace file-read evidence" : ""} as a continuity checkpoint. When handing off unfinished work, include the exact discovered requirements: input/output types and units, boundary rules, decisions and rejected alternatives, verification, and next steps. Distinguish observed facts from assumptions. No manual hook invocation or repository memory file is needed. Continuity does not authorize file changes; obey the user's read-only and other task constraints.`
    : null;
  const manifest = input.manifest;
  const trimmedContext = input.injectedContext.trim();
  const hasHotMemoryFallback = !manifest && hasHotMemorySnapshotContent(input.hotMemorySnapshot);
  const hasHealthIssue = Boolean(input.status && input.status.integrity.issues.length > 0);
  const hasHudItem =
    Boolean(input.inbox && input.inbox.summary.total > 0) ||
    Boolean(input.dreamReview && input.dreamReview.summary.pending > 0) ||
    Boolean(input.obligations && input.obligations.summary.total > 0);
  const hasFreshnessSignal = Boolean(input.freshness?.latestActivity || input.freshness?.peerUpdate || input.freshness?.advisory);
  const hasActionableContext =
    trimmedContext.length > 0 ||
    hasHotMemoryFallback ||
    hasHealthIssue ||
    hasHudItem ||
    input.warnings.length > 0 ||
    hasFreshnessSignal ||
    captureGuidance !== null;
  if (!hasActionableContext) {
    return "";
  }
  if (trimmedContext.length > 0) {
    const compactLines = [
      `Crosshead attached: profile=${input.profileName} mode=${input.mode} runtime=${input.runtime}`,
      captureGuidance,
      formatInjectedContextLine(manifest),
      formatHealthLine(input.status),
      formatInboxLine(input.inbox),
      formatDreamReviewLine(input.dreamReview),
      formatDreamReviewTopLine(input.dreamReview),
      formatDreamReviewActionLine(input.dreamReview),
      formatDreamReviewCommandLine(input.dreamReview),
      formatObligationsLine(input.obligations),
      input.warnings.length > 0 ? `Warnings: ${input.warnings.join(" | ")}` : null,
    ].filter((value): value is string => value !== null && value.length > 0);
    return `${compactLines.join("\n")}\n\nInjected context:\n${trimmedContext}`;
  }
  const capabilitiesNeeded =
    Boolean(manifest && manifest.totalAvailableFragments > 0) ||
    hasHotMemoryFallback ||
    Boolean(input.inbox && input.inbox.summary.total > 0) ||
    Boolean(input.dreamReview && input.dreamReview.summary.pending > 0) ||
    Boolean(input.obligations && input.obligations.summary.total > 0);
  const lines = [
    `Crosshead attached: profile=${input.profileName} mode=${input.mode} runtime=${input.runtime}`,
    captureGuidance,
    formatFreshnessLine(input.freshness),
    // When a peer body changed since our last read, inject its compact digest in place of the
    // generic latest-activity + "go look" advisory lines — more useful for fewer tokens.
    ...(input.freshness?.peerUpdate
      ? [formatFreshnessPeerUpdateLine(input.freshness)]
      : [formatFreshnessActivityLine(input.freshness), formatFreshnessAdvisoryLine(input.freshness)]),
    formatHealthLine(input.status),
    formatLifecycleLine(input.actions, manifest),
    manifest ? formatLayerLine("Hot memory", manifest.hotMemory) : hasHotMemoryFallback
      ? input.hotContextText || renderHotCheckpoints(selectHotCheckpoints(input.hotMemorySnapshot, input.goal ?? null, input.workspaceId)) || formatFreeHotMemorySnapshotLine(input.hotMemorySnapshot)
      : null,
    formatWarmLine(manifest),
    manifest && (manifest.layeredContext.available > 0 || manifest.layeredContext.injected > 0)
      ? formatLayerLine("Layered context", manifest.layeredContext)
      : null,
    formatInboxLine(input.inbox),
    formatDreamReviewLine(input.dreamReview),
    formatObligationsLine(input.obligations),
    formatModeLine(input.mode),
    formatTopWarmLine(manifest),
    formatInboxTopLine(input.inbox),
    formatDreamReviewTopLine(input.dreamReview),
    formatDreamReviewActionLine(input.dreamReview),
    formatDreamReviewCommandLine(input.dreamReview),
    formatObligationsTopLine(input.obligations),
    input.warnings.length > 0 ? `Warnings: ${input.warnings.join(" | ")}` : null,
    capabilitiesNeeded ? "Capabilities: memory_hot, memory_warm, memory_search, remember, inbox_state, inbox_replay, inbox_ack, inbox_resolve" : null,
  ].filter((value): value is string => value !== null && value.length > 0);

  return trimmedContext.length > 0 ? `${lines.join("\n")}\n\nInjected context:\n${trimmedContext}` : lines.join("\n");
};
