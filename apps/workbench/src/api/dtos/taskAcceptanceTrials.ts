export interface RelayAcceptanceTrialResult {
  trialId: string; taskId: string; status: 'RUNNING' | 'PAUSED' | 'FINISHED'; revision: string;
}
export interface RelayAcceptanceObservation {
  observationId: string; trialRevision: string; preparationMs: string | null;
  totalAcceptanceMs: string | null; sourceNote: string; sourceKind: 'USER_REPORTED'; createdAt: string;
  correctnessOutcome: 'UNKNOWN' | 'NO_ISSUE_REPORTED' | 'ISSUE_REPORTED';
  sourceMessageId: string | null;
}
export interface RelayAcceptanceTrial extends RelayAcceptanceTrialResult {
  mode: 'ORIGINAL' | 'EVIDENCE_VIEW'; sampleLabel: string; materialIds: readonly string[];
  acceptanceRevision: string; acceptanceMatches: boolean; startedAt: string; finishedAt: string | null;
  activeMs: string; pausedMs: string; elapsedMs: string; totalIncludesPreparation: true;
  latestObservation: RelayAcceptanceObservation | null; observations: RelayAcceptanceObservation[];
  comparisonId: string | null;
}
export interface RelayAcceptanceTrialStart {
  taskId: string; commandId: string; expectedAcceptanceRevision: string;
  mode: 'ORIGINAL' | 'EVIDENCE_VIEW'; sampleLabel: string; materialIds?: string[];
  comparisonId?: string;
}
export interface RelayAcceptanceTrialCommand {
  taskId: string; trialId: string; commandId: string; expectedRevision: string;
}
export interface RelayAcceptanceTrialTransition extends RelayAcceptanceTrialCommand {
  action: 'PAUSE' | 'RESUME' | 'FINISH';
}
export interface RelayAcceptanceObservationInput extends RelayAcceptanceTrialCommand {
  preparationMs: number | null; totalAcceptanceMs: number | null; sourceNote: string;
  correctnessOutcome?: 'UNKNOWN' | 'NO_ISSUE_REPORTED' | 'ISSUE_REPORTED';
}
export interface RelayAcceptanceTrials { taskId: string; serverTime: string; items: RelayAcceptanceTrial[] }
