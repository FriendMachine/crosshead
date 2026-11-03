import { Npub, Timestamped, Uuid } from "./base";
import type { SocialDisclosureSensitivity, SocialVisibilitySnapshot } from "./social-visibility";

// Hot memory is partitioned per "body" (runtime host) so concurrent bodies of the same
// identity — e.g. codex and claude-code on one npub — keep independent working state instead
// of clobbering a single shared doc. `SHARED_HOT_SCOPE` is the backward-compatible default used
// before a body declares its scope. `HOT_SCOPE_ALL` is a reserved read-only token that returns
// the union across every scope; it must never be written.
export const SHARED_HOT_SCOPE = "shared";
export const HOT_SCOPE_ALL = "all";
// Runtime-host vocabulary plus the shared sentinel (lowercase, bounded length).
export const HOT_SCOPE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export const normalizeHotScope = (scope?: string | null): string => {
  const trimmed = (scope ?? "").trim();
  return trimmed.length > 0 ? trimmed : SHARED_HOT_SCOPE;
};

export type HotMemory = Timestamped & {
  npub: Npub;
  scope: string;
  content: string;
  etag: string;
  sizeBytes: number;
};

export const WARM_ENTRY_TYPE_VALUES = ["commitment", "pattern", "correction", "fact"] as const;
export const WARM_ENTRY_STATUS_VALUES = ["active", "superseded", "flagged"] as const;
export const PROVENANCE_SOURCE_VALUES = ["user_stated", "inferred", "imported", "agent_observed"] as const;

export type WarmEntryType = (typeof WARM_ENTRY_TYPE_VALUES)[number];
export type WarmEntryStatus = (typeof WARM_ENTRY_STATUS_VALUES)[number];
export type ProvenanceSource = (typeof PROVENANCE_SOURCE_VALUES)[number];

export type EmbeddingMetadata = {
  provider: string;
  model: string;
  dimensions: number;
};

export type WarmEntry = Timestamped & {
  id: Uuid;
  npub: Npub;
  type: WarmEntryType;
  content: string;
  tags: string[];
  provenanceSource: ProvenanceSource;
  provenanceSourceContext: string | null;
  provenanceSessionId: string | null;
  provenanceCreatedBy: Npub;
  validityConfidence: number;
  validityExpiresAt: Date | null;
  validityVerifiedAt: Date | null;
  supersededBy: Uuid | null;
  supersedes: Uuid | null;
  conflictsWith: Uuid | null;
  status: WarmEntryStatus;
  embedding: number[] | null;
  embeddingMetadata?: EmbeddingMetadata | null;
  sourceSubject: string | null;
  sourceContext: string | null;
  audiencePolicyRef: string;
  sensitivity: SocialDisclosureSensitivity;
  visibilitySnapshot: SocialVisibilitySnapshot | null;
  derivationRefs: string[];
};

export type ColdChunk = Timestamped & {
  id: Uuid;
  npub: Npub;
  gcsUri: string;
  sizeBytes: number;
  sizeKb: number;
  timeStart: Date;
  timeEnd: Date;
  ingestedAt: Date;
  contentHash: string;
  embedding: number[] | null;
};

export type ColdItemRole = "user" | "assistant" | "tool" | "system";

export type ColdItem = Timestamped & {
  id: Uuid;
  npub: Npub;
  chunkId: Uuid;
  timestamp: Date;
  role: ColdItemRole | null;
  content: string;
  contentHash: string;
  embedding: number[] | null;
  embeddingMetadata?: EmbeddingMetadata | null;
};
