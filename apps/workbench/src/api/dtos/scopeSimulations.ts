import type { RelayPeriodPlanItem } from './personalPlanning';
export type RelayScopeOptionKind = 'ALL' | 'SHRINK' | 'DEFER';
export interface RelayScopeSimulationInput {
  commandId: string; planId: string; expectedRevision: string; keepTaskIds: readonly string[]; deferTaskIds: readonly string[]; unreliableTaskIds: readonly string[];
}
export interface RelayScopeSelection {
  commandId: string; simulationId: string; expectedRevision: string; option: RelayScopeOptionKind; confirmed: true; reason: string;
}
export interface RelayScopeSimulationResult {
  simulationId: string; sourcePlanId: string; projectId: string; revision: string; status: 'PROPOSED' | 'SELECTED';
  selectedOption: RelayScopeOptionKind | null; selectedPlanId: string | null;
}
export interface RelayScopeOption {
  kind: RelayScopeOptionKind; taskIds: string[]; retainedPrerequisiteIds: string[]; excludedTaskIds: string[];
  requestedElapsedMs: number | null; requestedHumanMs: number | null; plannedMs: number; capacityGapMs: number | null;
  unknownEstimateTaskIds: string[]; unreliableTaskIds: string[]; feasibility: string;
  items: RelayPeriodPlanItem[]; consequences: Record<string, unknown>[];
}
export interface RelayScopeSimulation extends RelayScopeSimulationResult {
  baseline: Record<string, unknown>; options: RelayScopeOption[]; createdAt: string; selectionReason: string | null; staleReasons: string[];
  selectedPlan: { planId: string; revision: string; items: RelayPeriodPlanItem[] } | null;
  executionAdmission: 'NOT_GRANTED'; permissionGaps: 'CHECK_AT_EXECUTION'; materialGaps: 'CHECK_AT_EXECUTION'; completionDate: null;
}
