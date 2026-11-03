import type { WarmEntry, WarmEntryStatus } from "./memory";
import type { WarmMemoryVisibility } from "./warm-memory-visibility";

// Report shapes returned by the hosted warm-memory evaluation API.
export type WarmMemoryFreshness = "fresh" | "aging" | "stale" | "protected";
export type WarmMemoryCurationAction = "keep" | "review" | "archive";
export type WarmMemoryInspectionOutcome = "promoted" | "merged" | "superseded" | "proposed" | "rejected" | "unknown";

export type WarmMemoryPromotionInspection = {
  candidateId: string | null;
  outcome: WarmMemoryInspectionOutcome;
  recommendation: string | null;
  sourceQuality: string | null;
  classifier: string | null;
  eventType: string | null;
  runtime: string | null;
  score: number | null;
  retrievalUsefulness: number | null;
  reasons: string[];
  supersedesEntryIds: string[];
  conflictingEntryIds: string[];
};

export type WarmMemoryInspection = {
  freshness: WarmMemoryFreshness;
  curationAction: WarmMemoryCurationAction;
  curationReason: string | null;
  archived: boolean;
  archivedAt: string | null;
  protected: boolean;
  ageDays: number;
  lastValidatedAt: string | null;
  visibility: WarmMemoryVisibility;
  promotion: WarmMemoryPromotionInspection | null;
};

export type WarmMemoryInspectedEntry = WarmEntry & {
  inspection: WarmMemoryInspection;
};

export type WarmMemoryEvaluationSummary = {
  total: number;
  statuses: Record<WarmEntryStatus | "archived", number>;
  freshness: Record<WarmMemoryFreshness, number>;
  curation: Record<WarmMemoryCurationAction, number>;
  outcomes: Record<WarmMemoryInspectionOutcome, number>;
};

export type WarmMemoryEvaluationReport = {
  evaluatedAt: string;
  applied: boolean;
  archivedEntryIds: string[];
  summary: WarmMemoryEvaluationSummary;
  entries: WarmMemoryInspectedEntry[];
};
