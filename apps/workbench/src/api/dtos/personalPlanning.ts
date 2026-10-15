export interface RelayTimeEstimateInput {
  commandId: string; taskId: string; expectedTaskRevision: string; expectedEstimateRevision: string; confirmed: true;
  elapsedMs: number | null; executionMs: number | null; waitingMs: number | null; reviewMs: number | null; humanMs: number | null; sourceNote: string;
}
export interface RelayTimeEstimate {
  id: string; taskId: string; revision: string; acceptanceRevision: string; elapsedMs: string | null;
  executionMs: string | null; waitingMs: string | null; reviewMs: string | null; humanMs: string | null;
  sourceNote: string; sourceKind: 'USER_DECLARED'; createdAt: string;
}
export interface RelayPeriodPlanInput {
  commandId: string; projectId: string; title: string; availableMs: number; diagnosticMs: number;
  taskIds: readonly string[]; mainlineTaskIds: readonly string[]; goalIds: readonly string[];
}
export interface RelayPeriodPlanResolution {
  commandId: string; planId: string; itemId: string; expectedRevision: string; action: 'ACCEPT' | 'REJECT'; reason: string;
}
export interface RelayPeriodPlanResult { planId: string; projectId: string; revision: string; itemId: string | null; itemStatus: string | null; createdTaskId: string | null }
export interface RelayPeriodPlanItem {
  id: string; taskId: string; title: string; kind: 'TASK' | 'DIAGNOSTIC' | 'DEFERRED'; reason: string;
  budgetMs: number | null; humanMs: number | null; dependsOnTaskIds: string[]; status: 'CANDIDATE' | 'ACCEPTED' | 'REJECTED';
  createdTaskId: string | null; resolutionReason: string | null; output: string | null;
}
export interface RelayPeriodPlan extends RelayPeriodPlanResult {
  title: string; availableMs: string; startedAt: string; endsAt: string; remainingMs: string; expired: boolean;
  timeWarning: 'ESTIMATED_WORK_EXCEEDS_REMAINING_WINDOW' | null;
  staleReasons: string[]; baseline: Record<string, unknown>; items: RelayPeriodPlanItem[];
  executionAdmission: 'NOT_GRANTED'; permissionGaps: 'CHECK_AT_EXECUTION'; humanIntervention: 'SEE_BLOCKERS_AND_TASK_ACCEPTANCE';
}
