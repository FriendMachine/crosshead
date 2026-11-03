import type { WarmEntryType } from "./memory";

// Context pack manifest returned by the hosted context API.
export type ContextPackSuppressionReason =
  | "redundancy"
  | "known_context"
  | "budget_tokens"
  | "budget_fragments"
  | "stale"
  | "low_signal"
  | "low_orientation_value";

export type ContextPackLayerManifest = {
  available: number;
  injected: number;
  omitted: number;
};

export type ContextPackWarmDigestEntry = {
  id: string;
  type: WarmEntryType | null;
  reason: string;
  score: number;
  preview: string;
};

export type ContextPackManifest = {
  compilerVersion: string;
  totalAvailableFragments: number;
  totalInjectedFragments: number;
  totalOmittedFragments: number;
  judgmentSnapshot: ContextPackLayerManifest;
  selfModel: ContextPackLayerManifest;
  socialProfile: ContextPackLayerManifest;
  hotMemory: ContextPackLayerManifest;
  warmMemory: ContextPackLayerManifest;
  coldMemory: ContextPackLayerManifest;
  layeredContext: ContextPackLayerManifest;
  topWarmEntries: ContextPackWarmDigestEntry[];
  suppressionCounts: Record<ContextPackSuppressionReason, number>;
};
