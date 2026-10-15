import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { InformationRootRow } from '../infrastructure/database-schema.js';
import type { AcceptanceTrialObservation, AcceptanceTrialRow } from '../task/task-acceptance-trial-repository.js';
import { httpCommandScopeKey, LOCAL_ACTOR_REF } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { readProjectInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { lockAcceptanceTask } from './task-acceptance-materials.js';
import { withTransaction, type Repositories } from './unit-of-work.js';

export async function freezeAcceptanceComparison(db: DbExecutor, input: {
  workspaceId: string; projectId: string; commandId: string; baselineTrialId: string;
  expectedBaselineRevision: string; targetReductionPercent: number; sampleScope: string;
}) {
  const revision = requireRevision(input.expectedBaselineRevision, 'expected_baseline_revision');
  if (!Number.isInteger(input.targetReductionPercent) || input.targetReductionPercent < 1 ||
      input.targetReductionPercent > 100 || !input.sampleScope.trim() || input.sampleScope.length > 4000) {
    throw validationFailed([{ field: 'comparison', message: '需要 1–100 整数目标百分比及样本口径。' }]);
  }
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'FreezeAcceptanceComparison', target: { project_id: input.projectId },
    body: { baseline_trial_id: input.baselineTrialId, expected_baseline_revision: revision.toString(),
      target_reduction_percent: input.targetReductionPercent, sample_scope: input.sampleScope }, execute: async (r) => {
      const located = await r.acceptanceTrials.read(input.baselineTrialId, false);
      if (located?.workspace_id !== input.workspaceId) throw resourceNotFound('TaskAcceptanceTrial');
      const task = await lockAcceptanceTask(r, input.workspaceId, located.task_id);
      if (task.project_id !== input.projectId) throw resourceNotFound('TaskAcceptanceTrial');
      const baseline = (await r.acceptanceTrials.read(located.id))!;
      if (baseline.revision !== revision) throw revisionConflict({ entityType: 'TASK_ACCEPTANCE_TRIAL',
        expectedRevision: revision.toString(), actualRevision: baseline.revision.toString() });
      if (baseline.mode !== 'ORIGINAL' || baseline.status !== 'FINISHED' || baseline.acceptance_revision !== task.acceptance_revision) {
        throw invalidTransition('基线必须是当前验收修订下已结束的原流程试用。');
      }
      const observation = (await r.acceptanceTrials.observations(baseline.id))[0];
      const comparison = await r.acceptanceComparisons.insert({ id: randomUUID(), workspace_id: input.workspaceId,
        project_id: input.projectId, baseline_trial_id: baseline.id, baseline_revision: revision,
        baseline_observation_id: observation?.id ?? null, target_reduction_percent: input.targetReductionPercent,
        sample_scope: input.sampleScope });
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
        projectId: input.projectId, taskId: baseline.task_id, eventType: 'ACCEPTANCE_COMPARISON_FROZEN',
        factRefs: { comparison_id: comparison.id, baseline_trial_id: baseline.id,
          baseline_revision: revision.toString(), baseline_observation_id: observation?.id ?? null } });
      return { comparison_id: comparison.id, project_id: comparison.project_id };
    } });
}

function reduction(baseline: bigint | null, current: bigint | null) {
  return baseline === null || baseline <= 0n || current === null ? null :
    Number((baseline - current) * 10000n / baseline) / 100;
}
export function acceptanceComparisonMetrics(input: {
  baselineFindingMs: bigint; findingMs: bigint | null; baselinePreparationMs: bigint | null;
  preparationMs: bigint | null; baselineTotalMs: bigint | null; totalMs: bigint | null; targetPercent: number;
}) {
  return { finding_reduction_percent: reduction(input.baselineFindingMs, input.findingMs),
    total_reduction_percent: reduction(input.baselineTotalMs, input.totalMs),
    preparation_difference_ms: input.baselinePreparationMs === null || input.preparationMs === null ? null :
      (input.preparationMs - input.baselinePreparationMs).toString(),
    finding_target_met: input.baselineFindingMs <= 0n || input.findingMs === null ? null :
      (input.baselineFindingMs - input.findingMs) * 100n >= input.baselineFindingMs * BigInt(input.targetPercent),
    overall_time_saved: input.baselineTotalMs === null || input.baselineTotalMs <= 0n || input.totalMs === null ? null :
      input.totalMs < input.baselineTotalMs };
}
function observationDto(row: AcceptanceTrialObservation | undefined) {
  return row === undefined ? null : { observation_id: row.id, trial_revision: row.trial_revision.toString(),
    preparation_ms: row.preparation_ms?.toString() ?? null, total_acceptance_ms: row.total_acceptance_ms?.toString() ?? null,
    correctness_outcome: row.correctness_outcome, source_kind: 'USER_REPORTED', source_note: row.source_note,
    source_message_id: row.source_message_id };
}
async function materialScope(r: Repositories, row: AcceptanceTrialRow, projectId: string) {
  let incomplete = false;
  for (const id of row.material_ids) {
    const material = await r.acceptanceMaterials.read(id);
    if (material === undefined || material.workspace_id !== row.workspace_id || material.task_id !== row.task_id ||
        material.status !== 'ACTIVE' || material.acceptance_revision !== row.acceptance_revision) return 'STALE';
    const version = await r.information.readKnowledgeVersionById(material.knowledge_version_id);
    const root = version === undefined ? undefined :
      await r.information.readRoot<InformationRootRow>('knowledge', version.knowledge_id);
    if (root?.workspace_id !== row.workspace_id || root.project_id !== projectId || root.status !== 'ACTIVE' ||
        version?.availability !== 'AVAILABLE' || version.version !== root.current_version) return 'STALE';
    if (material.criterion_id === null || material.tested_artifact_version_id === null) incomplete = true;
    if (material.tested_artifact_version_id !== null) {
      const target = await r.artifacts.readArtifactVersion(material.tested_artifact_version_id);
      if (target === undefined || (await r.artifacts.listArtifactVersions(target.artifact_id))[0]?.id !== target.id) return 'STALE';
    }
  }
  return incomplete ? 'INCOMPLETE' : 'CURRENT';
}

export async function listAcceptanceComparisons(db: DbExecutor, workspaceId: string, projectId: string) {
  return withTransaction(db, async (r) => {
    await readProjectInWorkspace(r, workspaceId, projectId);
    const items = [];
    for (const comparison of await r.acceptanceComparisons.list(workspaceId, projectId)) {
      const baseline = (await r.acceptanceTrials.read(comparison.baseline_trial_id, false))!;
      const baselineTask = await r.tasks.readTaskForShare(baseline.task_id);
      const baselineCurrent = baseline.revision === comparison.baseline_revision &&
        baselineTask?.acceptance_revision === baseline.acceptance_revision;
      const baselineObservation = (await r.acceptanceTrials.observations(baseline.id))
        .find((o) => o.id === comparison.baseline_observation_id);
      const samples = [];
      for (const trial of await r.acceptanceComparisons.trials(comparison.id)) {
        const task = await r.tasks.readTaskForShare(trial.task_id);
        const materialStatus = await materialScope(r, trial, projectId);
        const observation = (await r.acceptanceTrials.observations(trial.id))[0];
        const metrics = acceptanceComparisonMetrics({ baselineFindingMs: baseline.active_ms,
          findingMs: trial.status === 'FINISHED' ? trial.active_ms : null,
          baselinePreparationMs: baselineObservation?.preparation_ms ?? null, preparationMs: observation?.preparation_ms ?? null,
          baselineTotalMs: baselineObservation?.total_acceptance_ms ?? null,
          totalMs: trial.status === 'FINISHED' ? observation?.total_acceptance_ms ?? null : null,
          targetPercent: comparison.target_reduction_percent });
        const stale = !baselineCurrent || task?.acceptance_revision !== trial.acceptance_revision || materialStatus === 'STALE';
        const correctnessIssue = baselineObservation?.correctness_outcome === 'ISSUE_REPORTED' ||
          observation?.correctness_outcome === 'ISSUE_REPORTED';
        const complete = baselineObservation?.correctness_outcome === 'NO_ISSUE_REPORTED' &&
          observation?.correctness_outcome === 'NO_ISSUE_REPORTED' && materialStatus === 'CURRENT' &&
          metrics.finding_target_met !== null && metrics.overall_time_saved !== null &&
          metrics.preparation_difference_ms !== null;
        const assessment = stale ? 'STALE' : trial.status !== 'FINISHED' ? 'IN_PROGRESS' :
          correctnessIssue ? 'CORRECTNESS_ISSUE' : !complete ? 'INSUFFICIENT_DATA' :
          metrics.finding_target_met && metrics.overall_time_saved ? 'TARGET_MET' : 'TARGET_NOT_MET';
        samples.push({ trial_id: trial.id, task_id: trial.task_id, trial_revision: trial.revision.toString(),
          sample_label: trial.sample_label, status: trial.status, material_ids: trial.material_ids,
          finding_ms: trial.status === 'FINISHED' ? trial.active_ms.toString() : null,
          observation: observationDto(observation), material_status: materialStatus, assessment, ...metrics });
      }
      items.push({ comparison_id: comparison.id, project_id: comparison.project_id,
        baseline_trial_id: baseline.id, baseline_task_id: baseline.task_id,
        baseline_revision: comparison.baseline_revision.toString(), baseline_current: baselineCurrent,
        baseline_finding_ms: baseline.active_ms.toString(), baseline_observation: observationDto(baselineObservation),
        target_reduction_percent: comparison.target_reduction_percent, sample_scope: comparison.sample_scope,
        frozen_at: comparison.frozen_at.toISOString(), total_includes_preparation: true,
        evidence_kind: 'USER_REPORTED_SAMPLE', samples });
    }
    return { project_id: projectId, items };
  });
}
