export interface RelayAcceptanceComparisonInput {
  projectId: string; commandId: string; baselineTrialId: string; expectedBaselineRevision: string;
  targetReductionPercent: number; sampleScope: string;
}
export interface RelayComparisonObservation {
  observationId: string; trialRevision: string; preparationMs: string | null; totalAcceptanceMs: string | null;
  correctnessOutcome: 'UNKNOWN' | 'NO_ISSUE_REPORTED' | 'ISSUE_REPORTED'; sourceKind: 'USER_REPORTED'; sourceNote: string;
  sourceMessageId: string | null;
}
export interface RelayAcceptanceComparisonSample {
  trialId: string; taskId: string; trialRevision: string; sampleLabel: string;
  status: 'RUNNING' | 'PAUSED' | 'FINISHED'; materialIds: readonly string[]; findingMs: string | null;
  observation: RelayComparisonObservation | null; materialStatus: 'CURRENT' | 'INCOMPLETE' | 'STALE';
  assessment: 'IN_PROGRESS' | 'INSUFFICIENT_DATA' | 'STALE' | 'CORRECTNESS_ISSUE' | 'TARGET_MET' | 'TARGET_NOT_MET';
  findingReductionPercent: number | null; totalReductionPercent: number | null;
  preparationDifferenceMs: string | null; findingTargetMet: boolean | null; overallTimeSaved: boolean | null;
}
export interface RelayAcceptanceComparison {
  comparisonId: string; projectId: string; baselineTrialId: string; baselineTaskId: string;
  baselineRevision: string; baselineCurrent: boolean; baselineFindingMs: string;
  baselineObservation: RelayComparisonObservation | null; targetReductionPercent: number;
  sampleScope: string; frozenAt: string; totalIncludesPreparation: true; evidenceKind: 'USER_REPORTED_SAMPLE';
  samples: RelayAcceptanceComparisonSample[];
}
export interface RelayAcceptanceComparisons { projectId: string; items: RelayAcceptanceComparison[] }
