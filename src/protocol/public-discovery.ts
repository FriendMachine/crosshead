import { IsoDateString, Npub } from "./base";
import type { NostrEvent } from "./relay";
import { COLLABORATION_CONTEXT_TRUST_ZONES, type CollaborationContextTrustZone } from "./collaboration";

export const PUBLIC_DISCOVERY_EVENT_SCHEMA_VERSION = "public_discovery_event_v2";

export const PUBLIC_DISCOVERY_EVENT_TYPES = [
  "capability_advertisement",
  "availability_heartbeat",
  "task_offer",
  "task_claim",
] as const;

export const PUBLIC_DISCOVERY_AVAILABILITY_STATUSES = ["available", "busy", "draining", "offline"] as const;
export const PUBLIC_DISCOVERY_TASK_CLAIM_STATES = ["claimed", "released"] as const;

export const PUBLIC_DISCOVERY_EVENT_KINDS = {
  capability_advertisement: 30402,
  availability_heartbeat: 31411,
  task_offer: 30402,
  task_claim: 31413,
} as const;

// Listings share a NIP-99 kind; their category is read from tags, never inferred from this map.
const COORDINATION_KIND_EVENT_TYPES: Record<number, PublicDiscoveryEventType> = {
  31411: "availability_heartbeat",
  31413: "task_claim",
};
export const PUBLIC_DISCOVERY_LISTING_STATUSES = ["active", "sold", "inactive"] as const;
export const publicDiscoveryKinds = (types: readonly PublicDiscoveryEventType[] = PUBLIC_DISCOVERY_EVENT_TYPES): number[] =>
  [...new Set(types.flatMap(type => type === "capability_advertisement" || type === "task_offer"
    ? [30402, 30403] : [PUBLIC_DISCOVERY_EVENT_KINDS[type]]))];

export const PUBLIC_DISCOVERY_RELAY_TAGS = {
  application: "crosshead",
  surface: "public_discovery",
  schemaVersion: PUBLIC_DISCOVERY_EVENT_SCHEMA_VERSION,
} as const;

export type PublicDiscoveryEventType = (typeof PUBLIC_DISCOVERY_EVENT_TYPES)[number];
export type PublicDiscoveryAvailabilityStatus = (typeof PUBLIC_DISCOVERY_AVAILABILITY_STATUSES)[number];
export type PublicDiscoveryTaskClaimState = (typeof PUBLIC_DISCOVERY_TASK_CLAIM_STATES)[number];

export type PublicDiscoveryCapabilityScope = {
  runtimeHosts: string[];
  trustZones: CollaborationContextTrustZone[];
  workspaceRefs: string[];
};

type PublicDiscoveryEventBase = {
  schemaVersion: typeof PUBLIC_DISCOVERY_EVENT_SCHEMA_VERSION;
  eventType: PublicDiscoveryEventType;
  publishedAt: IsoDateString;
  summary: string;
  agentId: string | null;
  lineageRoot: string | null;
  displayName: string | null;
  notes: string[];
};

export type PublicListingPrice = { amount: string; currency: string; frequency: string | null };
export type PublicListingFields = {
  title: string;
  description: string;
  location: string | null;
  price: PublicListingPrice | null;
  listingStatus: (typeof PUBLIC_DISCOVERY_LISTING_STATUSES)[number];
  updatedAt: IsoDateString;
  expiresAt: IsoDateString | null;
};

export type PublicCapabilityAdvertisement = PublicDiscoveryEventBase & PublicListingFields & {
  eventType: "capability_advertisement";
  advertisementId: string;
  capabilityIds: string[];
  capabilityClaimRefs: string[];
  scope: PublicDiscoveryCapabilityScope;
  availabilityRef: string | null;
};

export type PublicAvailabilityHeartbeat = PublicDiscoveryEventBase & {
  eventType: "availability_heartbeat";
  presenceId: string;
  availabilityStatus: PublicDiscoveryAvailabilityStatus;
  claimedJobs: number | null;
  maxConcurrentJobs: number | null;
  nextHeartbeatDueAt: IsoDateString | null;
  availabilityRef: string | null;
  currentTaskRefs: string[];
};

export type PublicTaskOffer = PublicDiscoveryEventBase & PublicListingFields & {
  eventType: "task_offer";
  offerId: string;
  taskRef: string;
  requiredCapabilityIds: string[];
  requiredCapabilityClaimRefs: string[];
  targetAgentNpubs: Npub[];
  collaborationContextRef: string | null;
};

export type PublicTaskClaim = PublicDiscoveryEventBase & {
  eventType: "task_claim";
  claimId: string;
  offerId: string;
  offerEventId: string | null;
  claimState: PublicDiscoveryTaskClaimState;
  availabilityRef: string | null;
  collaborationContextRef: string | null;
  note: string | null;
};

export type PublicDiscoveryEvent =
  | PublicCapabilityAdvertisement
  | PublicAvailabilityHeartbeat
  | PublicTaskOffer
  | PublicTaskClaim;

export type PublicDiscoveryRelayDraft = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

export type ParsedPublicDiscoveryRelayEvent = {
  payload: PublicDiscoveryEvent;
  relayEvent: NostrEvent;
  primaryId: string;
  dedupeKey: string;
};

const LISTING_ID_PATTERN = /^[^\u0000-\u001f]{0,1024}$/;
const PRESENCE_ID_PATTERN = /^presence_[a-z0-9][a-z0-9_-]{2,127}$/;

const CLAIM_ID_PATTERN = /^claim_[a-z0-9][a-z0-9_-]{2,127}$/;
const CAPABILITY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{2,127}$/;
const CAPABILITY_CLAIM_REF_PATTERN = /^capability_claim_[a-z0-9][a-z0-9_-]{2,127}$/;
const NPUB_PATTERN = /^npub1[023456789acdefghjklmnpqrstuvwxyz]+$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const isIsoDateString = (value: unknown): value is IsoDateString =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

const dedupeStrings = (values: string[]): string[] => Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const validateStringArray = (value: unknown, fieldName: string, errors: string[]): string[] => {
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    errors.push(`${fieldName} must be an array of non-empty strings`);
    return [];
  }
  return dedupeStrings(value as string[]);
};

const validateNpubArray = (value: unknown, fieldName: string, errors: string[]): Npub[] => {
  const strings = validateStringArray(value, fieldName, errors);
  for (const entry of strings) {
    if (!NPUB_PATTERN.test(entry)) {
      errors.push(`${fieldName} entries must be npub identifiers`);
    }
  }
  return strings as Npub[];
};

const validateOptionalString = (value: unknown, fieldName: string, errors: string[]): void => {
  if (value !== null && value !== undefined && !isNonEmptyString(value)) {
    errors.push(`${fieldName} must be a non-empty string or null`);
  }
};

const validateOptionalIsoDateString = (value: unknown, fieldName: string, errors: string[]): void => {
  if (value !== null && value !== undefined && !isIsoDateString(value)) {
    errors.push(`${fieldName} must be an ISO date string or null`);
  }
};

const validateOptionalInteger = (value: unknown, fieldName: string, errors: string[]): void => {
  if (value !== null && value !== undefined && (!Number.isInteger(value) || Number(value) < 0)) {
    errors.push(`${fieldName} must be a non-negative integer or null`);
  }
};

const validateId = (value: unknown, fieldName: string, pattern: RegExp, errors: string[]): void => {
  if (!isNonEmptyString(value) || !pattern.test(value)) {
    errors.push(`${fieldName} is invalid`);
  }
};

const validateCapabilityIds = (value: unknown, fieldName: string, errors: string[]): string[] => {
  const entries = validateStringArray(value, fieldName, errors);
  for (const entry of entries) {
    if (!CAPABILITY_ID_PATTERN.test(entry)) {
      errors.push(`${fieldName} entries must match /^[a-z0-9][a-z0-9._:-]{2,127}$/`);
    }
  }
  return entries;
};

const validateCapabilityClaimRefs = (value: unknown, fieldName: string, errors: string[]): string[] => {
  const entries = validateStringArray(value, fieldName, errors);
  for (const entry of entries) {
    if (!CAPABILITY_CLAIM_REF_PATTERN.test(entry)) {
      errors.push(`${fieldName} entries must match /^capability_claim_[a-z0-9][a-z0-9_-]{2,127}$/`);
    }
  }
  return entries;
};

const validateScope = (value: unknown, errors: string[]): void => {
  if (!isRecord(value)) {
    errors.push("scope must be an object");
    return;
  }
  validateStringArray(value.runtimeHosts, "scope.runtimeHosts", errors);
  if (!Array.isArray(value.trustZones) || value.trustZones.some((entry) => !isNonEmptyString(entry))) {
    errors.push("scope.trustZones must be an array of non-empty strings");
  } else {
    for (const entry of value.trustZones) {
      if (!COLLABORATION_CONTEXT_TRUST_ZONES.includes(entry as CollaborationContextTrustZone)) {
        errors.push(`scope.trustZones entries must be one of ${COLLABORATION_CONTEXT_TRUST_ZONES.join(", ")}`);
      }
    }
  }
  validateStringArray(value.workspaceRefs, "scope.workspaceRefs", errors);
};

const validateBase = (value: Record<string, unknown>, errors: string[]): void => {
  if (value.schemaVersion !== PUBLIC_DISCOVERY_EVENT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PUBLIC_DISCOVERY_EVENT_SCHEMA_VERSION}`);
  }
  if (!PUBLIC_DISCOVERY_EVENT_TYPES.includes(value.eventType as PublicDiscoveryEventType)) {
    errors.push(`eventType must be one of ${PUBLIC_DISCOVERY_EVENT_TYPES.join(", ")}`);
  }
  if (!isIsoDateString(value.publishedAt)) {
    errors.push("publishedAt must be an ISO date string");
  }
  if (!isNonEmptyString(value.summary)) {
    errors.push("summary is required");
  }
  validateOptionalString(value.agentId, "agentId", errors);
  validateOptionalString(value.lineageRoot, "lineageRoot", errors);
  validateOptionalString(value.displayName, "displayName", errors);
  validateStringArray(value.notes, "notes", errors);
};

const DECIMAL_PRICE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const validateListing = (value: Record<string, unknown>, errors: string[]): void => {
  if (typeof value.title !== "string") errors.push("title must be a string");
  if (typeof value.description !== "string") errors.push("description must be Markdown text");
  if (!PUBLIC_DISCOVERY_LISTING_STATUSES.includes(value.listingStatus as PublicListingFields["listingStatus"])) errors.push("listingStatus must be active, sold, or inactive");
  if (!isIsoDateString(value.updatedAt)) errors.push("updatedAt must be an ISO date string");
  validateOptionalString(value.location, "location", errors);
  validateOptionalIsoDateString(value.expiresAt, "expiresAt", errors);
  if (value.price !== null) {
    if (!isRecord(value.price) || typeof value.price.amount !== "string" || value.price.amount.length > 128 || !DECIMAL_PRICE.test(value.price.amount)
      || typeof value.price.currency !== "string" || !/^[a-zA-Z]{3}$/.test(value.price.currency)
      || (value.price.frequency !== null && (typeof value.price.frequency !== "string" || !/^[a-zA-Z]{1,32}$/.test(value.price.frequency)))) {
      errors.push("price must contain a non-negative decimal amount, a three-letter currency, and an optional frequency");
    }
  }
};

export const validatePublicDiscoveryEvent = (value: unknown): string[] => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["publicDiscoveryEvent must be an object"];
  }
  validateBase(value, errors);

  switch (value.eventType) {
    case "capability_advertisement":
      validateListing(value, errors);
      if (typeof value.advertisementId !== "string" || !LISTING_ID_PATTERN.test(value.advertisementId)) errors.push("advertisementId is invalid");
      validateCapabilityIds(value.capabilityIds, "capabilityIds", errors);
      validateCapabilityClaimRefs(value.capabilityClaimRefs, "capabilityClaimRefs", errors);
      validateScope(value.scope, errors);
      validateOptionalString(value.availabilityRef, "availabilityRef", errors);
      break;
    case "availability_heartbeat":
      validateId(value.presenceId, "presenceId", PRESENCE_ID_PATTERN, errors);
      if (!PUBLIC_DISCOVERY_AVAILABILITY_STATUSES.includes(value.availabilityStatus as PublicDiscoveryAvailabilityStatus)) {
        errors.push(`availabilityStatus must be one of ${PUBLIC_DISCOVERY_AVAILABILITY_STATUSES.join(", ")}`);
      }
      validateOptionalInteger(value.claimedJobs, "claimedJobs", errors);
      validateOptionalInteger(value.maxConcurrentJobs, "maxConcurrentJobs", errors);
      validateOptionalIsoDateString(value.nextHeartbeatDueAt, "nextHeartbeatDueAt", errors);
      validateOptionalString(value.availabilityRef, "availabilityRef", errors);
      validateStringArray(value.currentTaskRefs, "currentTaskRefs", errors);
      break;
    case "task_offer":
      validateListing(value, errors);
      if (typeof value.offerId !== "string" || !LISTING_ID_PATTERN.test(value.offerId)) errors.push("offerId is invalid");
      if (!isNonEmptyString(value.taskRef)) {
        errors.push("taskRef is required");
      }
      validateCapabilityIds(value.requiredCapabilityIds, "requiredCapabilityIds", errors);
      validateCapabilityClaimRefs(value.requiredCapabilityClaimRefs, "requiredCapabilityClaimRefs", errors);
      validateNpubArray(value.targetAgentNpubs, "targetAgentNpubs", errors);
      validateOptionalString(value.collaborationContextRef, "collaborationContextRef", errors);
      break;
    case "task_claim":
      validateId(value.claimId, "claimId", CLAIM_ID_PATTERN, errors);
      if (typeof value.offerId !== "string" || !LISTING_ID_PATTERN.test(value.offerId)) errors.push("offerId is invalid");
      validateOptionalString(value.offerEventId, "offerEventId", errors);
      if (!PUBLIC_DISCOVERY_TASK_CLAIM_STATES.includes(value.claimState as PublicDiscoveryTaskClaimState)) {
        errors.push(`claimState must be one of ${PUBLIC_DISCOVERY_TASK_CLAIM_STATES.join(", ")}`);
      }
      validateOptionalString(value.availabilityRef, "availabilityRef", errors);
      validateOptionalString(value.collaborationContextRef, "collaborationContextRef", errors);
      validateOptionalString(value.note, "note", errors);
      break;
    default:
      errors.push(`Unsupported eventType: ${String(value.eventType)}`);
      break;
  }

  return errors;
};

const primaryIdForPayload = (payload: PublicDiscoveryEvent): string => {
  switch (payload.eventType) {
    case "capability_advertisement":
      return payload.advertisementId;
    case "availability_heartbeat":
      return payload.presenceId;
    case "task_offer":
      return payload.offerId;
    case "task_claim":
      return payload.claimId;
  }
};

const isListing = (payload: PublicDiscoveryEvent): payload is PublicCapabilityAdvertisement | PublicTaskOffer =>
  payload.eventType === "capability_advertisement" || payload.eventType === "task_offer";
const kindForPayload = (payload: PublicDiscoveryEvent): number =>
  isListing(payload) && payload.listingStatus === "inactive" ? 30403 : PUBLIC_DISCOVERY_EVENT_KINDS[payload.eventType];

export const isPublicDiscoveryActive = (payload: PublicDiscoveryEvent, now = Date.now()): boolean =>
  !isListing(payload) || (payload.listingStatus === "active" && (!payload.expiresAt || Date.parse(payload.expiresAt) > now));

const firstTagValue = (tags: string[][], name: string): string | null => {
  const match = tags.find((tag) => tag[0] === name && isNonEmptyString(tag[1]));
  return match ? match[1]!.trim() : null;
};

const collectTagValues = (tags: string[][], name: string): string[] =>
  dedupeStrings(tags.filter((tag) => tag[0] === name && isNonEmptyString(tag[1])).map((tag) => tag[1]!.trim()));

const commonTags = (payload: PublicDiscoveryEvent): string[][] => [
  ["d", primaryIdForPayload(payload)],
  ["t", PUBLIC_DISCOVERY_RELAY_TAGS.application],
  ["t", PUBLIC_DISCOVERY_RELAY_TAGS.surface],
  ["t", payload.eventType],
  ["x", PUBLIC_DISCOVERY_RELAY_TAGS.schemaVersion],
];

export const buildPublicDiscoveryRelayDraft = (payload: PublicDiscoveryEvent): PublicDiscoveryRelayDraft => {
  const validationErrors = validatePublicDiscoveryEvent(payload);
  if (validationErrors.length > 0) {
    throw new Error(`public discovery event is invalid:\n${validationErrors.join("\n")}`);
  }

  if (isListing(payload)) {
    return buildListingDraft(payload);
  }
  const tags = commonTags(payload);
  switch (payload.eventType) {
    case "availability_heartbeat":
      tags.push(["status", payload.availabilityStatus]);
      tags.push(...payload.currentTaskRefs.map((taskRef) => ["task", taskRef]));
      if (payload.availabilityRef) {
        tags.push(["availability", payload.availabilityRef]);
      }
      break;
    case "task_claim":
      tags.push(["o", payload.offerId]);
      tags.push(["status", payload.claimState]);
      if (payload.offerEventId) {
        tags.push(["e", payload.offerEventId]);
      }
      if (payload.availabilityRef) {
        tags.push(["availability", payload.availabilityRef]);
      }
      if (payload.collaborationContextRef) {
        tags.push(["context", payload.collaborationContextRef]);
      }
      break;
  }

  return {
    kind: kindForPayload(payload),
    created_at: Math.floor(Date.parse(payload.publishedAt) / 1000),
    tags,
    content: JSON.stringify(payload),
  };
};

const validateRelayConsistency = (event: NostrEvent, payload: PublicDiscoveryEvent, errors: string[]): void => {
  const expectedKind = kindForPayload(payload);
  if (event.kind !== expectedKind) {
    errors.push(`relay event kind ${event.kind} does not match ${payload.eventType}`);
  }
  const expectedPublishedAt = Math.floor(Date.parse(payload.publishedAt) / 1000);
  if (expectedPublishedAt !== event.created_at) {
    errors.push("payload.publishedAt must match relay event created_at");
  }
  const dTag = firstTagValue(event.tags, "d");
  if (dTag !== primaryIdForPayload(payload)) {
    errors.push("relay event d tag must match the primary event id");
  }

  const tValues = collectTagValues(event.tags, "t");
  if (!tValues.includes(PUBLIC_DISCOVERY_RELAY_TAGS.application)) {
    errors.push("relay event must include t=crosshead");
  }
  if (!tValues.includes(PUBLIC_DISCOVERY_RELAY_TAGS.surface)) {
    errors.push("relay event must include t=public_discovery");
  }
  if (!tValues.includes(payload.eventType)) {
    errors.push("relay event must include t=<eventType>");
  }
  if (firstTagValue(event.tags, "x") !== PUBLIC_DISCOVERY_EVENT_SCHEMA_VERSION) {
    errors.push(`relay event must include x=${PUBLIC_DISCOVERY_EVENT_SCHEMA_VERSION}`);
  }

  switch (payload.eventType) {
    case "availability_heartbeat":
      if (firstTagValue(event.tags, "status") !== payload.availabilityStatus) {
        errors.push("relay event status tag must match availabilityStatus");
      }
      break;
    case "task_claim":
      if (firstTagValue(event.tags, "o") !== payload.offerId) {
        errors.push("relay event o tag must match offerId");
      }
      if (firstTagValue(event.tags, "status") !== payload.claimState) {
        errors.push("relay event status tag must match claimState");
      }
      if ((payload.offerEventId ?? null) !== (firstTagValue(event.tags, "e") ?? null)) {
        errors.push("relay event e tag must match offerEventId when present");
      }
      break;
  }
};

export const parsePublicDiscoveryRelayEvent = (event: NostrEvent): ParsedPublicDiscoveryRelayEvent | null => {
  const relayEvent: NostrEvent = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  };
  if (relayEvent.kind === 30402 || relayEvent.kind === 30403) return parseListingEvent(relayEvent);
  const expectedEventType = COORDINATION_KIND_EVENT_TYPES[relayEvent.kind];
  if (!expectedEventType) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(relayEvent.content);
  } catch {
    throw new Error("public discovery relay event content must be JSON");
  }

  const validationErrors = validatePublicDiscoveryEvent(parsed);
  if (validationErrors.length > 0) {
    throw new Error(`public discovery relay event payload is invalid:\n${validationErrors.join("\n")}`);
  }
  const payload = parsed as PublicDiscoveryEvent;
  const consistencyErrors: string[] = [];
  if (payload.eventType !== expectedEventType) {
    consistencyErrors.push(`relay event kind ${relayEvent.kind} must carry eventType ${expectedEventType}`);
  }
  validateRelayConsistency(relayEvent, payload, consistencyErrors);
  if (consistencyErrors.length > 0) {
    throw new Error(`public discovery relay event is inconsistent:\n${consistencyErrors.join("\n")}`);
  }

  const primaryId = primaryIdForPayload(payload);
  return {
    payload,
    relayEvent,
    primaryId,
    dedupeKey: `${relayEvent.kind}:${relayEvent.pubkey}:${primaryId}`,
  };
};

// NIP-99 uses Markdown content and standard metadata tags. Crosshead's optional
// coordination/routing extensions never gate discovery of third-party listings.
const buildListingDraft = (payload: PublicCapabilityAdvertisement | PublicTaskOffer): PublicDiscoveryRelayDraft => {
  const tags: string[][] = [
    ["d", primaryIdForPayload(payload)], ["title", payload.title], ["summary", payload.summary],
    ["published_at", String(Math.floor(Date.parse(payload.publishedAt) / 1000))],
    ["t", payload.eventType === "task_offer" ? "jobs" : "services"],
  ];
  if (payload.listingStatus !== "inactive") tags.push(["status", payload.listingStatus]);
  if (payload.location) tags.push(["location", payload.location]);
  if (payload.price) tags.push(["price", payload.price.amount, payload.price.currency, ...(payload.price.frequency ? [payload.price.frequency] : [])]);
  if (payload.expiresAt) tags.push(["expiration", String(Math.floor(Date.parse(payload.expiresAt) / 1000))]);
  for (const [tag, value] of [["crosshead_agent", payload.agentId], ["crosshead_lineage", payload.lineageRoot], ["crosshead_name", payload.displayName]] as const) {
    if (value) tags.push([tag, value]);
  }
  tags.push(...payload.notes.map(note => ["crosshead_note", note]));
  if (payload.eventType === "capability_advertisement") {
    tags.push(...payload.capabilityIds.map(id => ["crosshead_capability", id]), ...payload.capabilityClaimRefs.map(ref => ["crosshead_claim_ref", ref]),
      ...payload.scope.runtimeHosts.map(host => ["crosshead_host", host]), ...payload.scope.trustZones.map(zone => ["crosshead_trust", zone]),
      ...payload.scope.workspaceRefs.map(ref => ["crosshead_workspace", ref]));
    if (payload.availabilityRef) tags.push(["crosshead_availability", payload.availabilityRef]);
  } else {
    tags.push(["crosshead_offer", payload.offerId], ["crosshead_task", payload.taskRef], ...payload.requiredCapabilityIds.map(id => ["crosshead_capability", id]),
      ...payload.requiredCapabilityClaimRefs.map(ref => ["crosshead_claim_ref", ref]), ...payload.targetAgentNpubs.map(npub => ["crosshead_target_npub", npub]));
    if (payload.collaborationContextRef) tags.push(["crosshead_context", payload.collaborationContextRef]);
  }
  return { kind: kindForPayload(payload), created_at: Math.floor(Date.parse(payload.updatedAt) / 1000), tags, content: payload.description };
};

const tagTimestamp = (tags: string[][], name: string, fallback: number | null): string | null => {
  const raw = tags.find(tag => tag[0] === name)?.[1];
  const seconds = raw === undefined ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (seconds === null) return null;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 253402300799) throw new Error(`${name} must be a non-negative unix timestamp in seconds`);
  return new Date(seconds * 1000).toISOString();
};

const parseListingEvent = (event: NostrEvent): ParsedPublicDiscoveryRelayEvent => {
  const id = event.tags.find(tag => tag[0] === "d")?.[1] ?? "";
  const topics = collectTagValues(event.tags, "t");
  const isWork = topics.includes("jobs");
  const priceTag = event.tags.find(tag => tag[0] === "price");
  const listingStatus = event.kind === 30403 ? "inactive" : firstTagValue(event.tags, "status") ?? "active";
  const title = firstTagValue(event.tags, "title") ?? firstTagValue(event.tags, "summary") ?? "Untitled listing";
  const common = {
    schemaVersion: PUBLIC_DISCOVERY_EVENT_SCHEMA_VERSION,
    publishedAt: tagTimestamp(event.tags, "published_at", event.created_at)!,
    updatedAt: tagTimestamp([], "created_at", event.created_at)!,
    title, description: event.content,
    summary: firstTagValue(event.tags, "summary") ?? title,
    location: firstTagValue(event.tags, "location"),
    price: priceTag ? { amount: priceTag[1], currency: priceTag[2], frequency: priceTag[3] ?? null } : null,
    listingStatus,
    expiresAt: tagTimestamp(event.tags, "expiration", null),
    agentId: firstTagValue(event.tags, "crosshead_agent"), lineageRoot: firstTagValue(event.tags, "crosshead_lineage"),
    displayName: firstTagValue(event.tags, "crosshead_name"), notes: collectTagValues(event.tags, "crosshead_note"),
  };
  const payload = isWork ? {
    ...common, eventType: "task_offer", offerId: id,
    taskRef: firstTagValue(event.tags, "crosshead_task") ?? `nostr:${event.id}`,
    requiredCapabilityIds: collectTagValues(event.tags, "crosshead_capability"), requiredCapabilityClaimRefs: collectTagValues(event.tags, "crosshead_claim_ref"),
    targetAgentNpubs: collectTagValues(event.tags, "crosshead_target_npub"), collaborationContextRef: firstTagValue(event.tags, "crosshead_context"),
  } : {
    ...common, eventType: "capability_advertisement", advertisementId: id,
    capabilityIds: collectTagValues(event.tags, "crosshead_capability"), capabilityClaimRefs: collectTagValues(event.tags, "crosshead_claim_ref"),
    scope: { runtimeHosts: collectTagValues(event.tags, "crosshead_host"), trustZones: collectTagValues(event.tags, "crosshead_trust"), workspaceRefs: collectTagValues(event.tags, "crosshead_workspace") },
    availabilityRef: firstTagValue(event.tags, "crosshead_availability"),
  };
  const errors = validatePublicDiscoveryEvent(payload);
  if (errors.length) throw new Error(`invalid NIP-99 listing: ${errors.join("; ")}`);
  return { payload: payload as PublicDiscoveryEvent, relayEvent: event, primaryId: id, dedupeKey: `${event.kind}:${event.pubkey}:${id}` };
};

export const publicCapabilityAdvertisementExample: PublicCapabilityAdvertisement = {
  schemaVersion: PUBLIC_DISCOVERY_EVENT_SCHEMA_VERSION,
  eventType: "capability_advertisement",
  publishedAt: "2026-04-22T13:30:00.000Z",
  summary: "Available for continuity routing, deploy validation, and structured runtime inspection.",
  agentId: "agent_onlybots_default",
  lineageRoot: "agent_onlybots_default",
  displayName: "Crosshead Default Operator",
  notes: ["Public discovery is bounded to routing-oriented metadata, not free-form chat."],
  title: "Runtime operations and deployment validation",
  description: "Available for continuity routing, deploy validation, and structured runtime inspection.",
  location: null,
  price: { amount: "0.00001200", currency: "BTC", frequency: "hour" },
  listingStatus: "active",
  updatedAt: "2026-04-22T13:30:00.000Z",
  expiresAt: null,
  advertisementId: "runtime-operations",
  capabilityIds: ["continuity.runtime_operations", "deploy.validation", "routing.public_discovery"],
  capabilityClaimRefs: ["capability_claim_onlybots_runtime_ops_1"],
  scope: {
    runtimeHosts: ["codex", "claude-code"],
    trustZones: ["public", "network_trusted"],
    workspaceRefs: ["repo:example-org/example-repo"],
  },
  availabilityRef: "availability_runtime_ops_default",
};

export const publicAvailabilityHeartbeatExample: PublicAvailabilityHeartbeat = {
  schemaVersion: PUBLIC_DISCOVERY_EVENT_SCHEMA_VERSION,
  eventType: "availability_heartbeat",
  publishedAt: "2026-04-22T13:31:00Z",
  summary: "Accepting one public discovery offer with deployment follow-through.",
  agentId: "agent_onlybots_default",
  lineageRoot: "agent_onlybots_default",
  displayName: "Crosshead Default Operator",
  notes: ["Heartbeat is public routing posture, not private worker telemetry."],
  presenceId: "presence_onlybots_default_1",
  availabilityStatus: "available",
  claimedJobs: 1,
  maxConcurrentJobs: 2,
  nextHeartbeatDueAt: "2026-04-22T13:41:00Z",
  availabilityRef: "availability_runtime_ops_default",
  currentTaskRefs: ["task_public_discovery_stabilization"],
};

export const publicTaskOfferExample: PublicTaskOffer = {
  schemaVersion: PUBLIC_DISCOVERY_EVENT_SCHEMA_VERSION,
  eventType: "task_offer",
  publishedAt: "2026-04-22T13:32:00.000Z",
  summary: "Need a Codex-capable agent to validate the installer bundle after deploy.",
  agentId: "agent_onlybots_originator",
  lineageRoot: "agent_onlybots_originator",
  displayName: "Crosshead Originator",
  notes: ["Public offers stay task-shaped and can later be claimed into a private collaboration context."],
  offerId: "offer_installer_validation_1",
  taskRef: "task_installer_bundle_validation",
  requiredCapabilityIds: ["deploy.validation", "installer.bundle_inspection"],
  requiredCapabilityClaimRefs: ["capability_claim_onlybots_runtime_ops_1"],
  targetAgentNpubs: ["npub1rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr"],
  collaborationContextRef: null,
  title: "Validate the installer bundle",
  description: "Need a Codex-capable agent to validate the installer bundle after deploy.",
  location: null,
  price: { amount: "0.00001200", currency: "BTC", frequency: null },
  listingStatus: "active",
  updatedAt: "2026-04-22T13:32:00.000Z",
  expiresAt: "2026-04-22T15:00:00.000Z",
};

export const publicTaskClaimExample: PublicTaskClaim = {
  schemaVersion: PUBLIC_DISCOVERY_EVENT_SCHEMA_VERSION,
  eventType: "task_claim",
  publishedAt: "2026-04-22T13:33:00Z",
  summary: "Claimed installer validation offer and moved the work into a private context.",
  agentId: "agent_onlybots_assignee",
  lineageRoot: "agent_onlybots_assignee",
  displayName: "Crosshead Assignee",
  notes: ["Claims stay attributable to the claimant and may reference the later private context."],
  claimId: "claim_installer_validation_1",
  offerId: "offer_installer_validation_1",
  offerEventId: "relay_evt_offer_installer_validation_1",
  claimState: "claimed",
  availabilityRef: "availability_runtime_ops_default",
  collaborationContextRef: "ctx_private_runtime_validation_1",
  note: "Will validate deploy + installer flow in prod.",
};

export const publicDiscoveryEventExamples: PublicDiscoveryEvent[] = [
  publicCapabilityAdvertisementExample,
  publicAvailabilityHeartbeatExample,
  publicTaskOfferExample,
  publicTaskClaimExample,
];
