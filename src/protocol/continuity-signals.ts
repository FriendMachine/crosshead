export type ContinuityStructuredSignals = {
  newFacts: string[];
  newCommitments: string[];
  communicationPreferences: string[];
  userCalibration: string[];
  projectDirection: string[];
  openQuestions: string[];
  rejectedAlternatives: string[];
  unresolvedRisks: string[];
  demonstratedKnowledge: string[];
  recentCorrections: string[];
  orientationDelta: string[];
  redundancyMarkers: string[];
  selfStrengths: string[];
  selfFailureModes: string[];
  selfCalibrationNotes: string[];
  preferredEnvironments: string[];
  selfBiasPatterns: string[];
};

export type ContinuityStructuredSignalQuality = {
  explicitSignalCount: number;
  score: number;
  usedSummaryFallback: boolean;
  summaryFallbackSignals?: string[];
};
