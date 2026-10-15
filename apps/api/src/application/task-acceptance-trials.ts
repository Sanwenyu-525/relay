import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { AcceptanceTrialRow } from '../task/task-acceptance-trial-repository.js';
import { httpCommandScopeKey, LOCAL_ACTOR_REF } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { requireRevision } from './revisions.js';
import { lockAcceptanceTask } from './task-acceptance-materials.js';
import { withTransaction, type Repositories } from './unit-of-work.js';

type TrialScope = { workspaceId: string; taskId: string; commandId: string };
function result(row: AcceptanceTrialRow) {
  return { trial_id: row.id, task_id: row.task_id, status: row.status, revision: row.revision.toString() };
}
export function acceptanceTrialTiming(row: AcceptanceTrialRow, now: Date) {
  const end = row.finished_at ?? now;
  const elapsed = BigInt(Math.max(0, end.getTime() - row.started_at.getTime()));
  const active = row.active_ms + (row.active_started_at === null ? 0n :
    BigInt(Math.max(0, end.getTime() - row.active_started_at.getTime())));
  return { active_ms: active.toString(), elapsed_ms: elapsed.toString(),
    paused_ms: (elapsed > active ? elapsed - active : 0n).toString() };
}
async function lockedTrial(r: Repositories, input: TrialScope & { trialId: string; expectedRevision: string }) {
  const task = await lockAcceptanceTask(r, input.workspaceId, input.taskId);
  const row = await r.acceptanceTrials.read(input.trialId);
  if (row?.workspace_id !== input.workspaceId || row.task_id !== task.id) {
    throw resourceNotFound('TaskAcceptanceTrial');
  }
  if (row.revision !== requireRevision(input.expectedRevision, 'expected_revision')) {
    throw revisionConflict({ entityType: 'TASK_ACCEPTANCE_TRIAL',
      expectedRevision: input.expectedRevision, actualRevision: row.revision.toString() });
  }
  return { task, row };
}
async function audit(r: Repositories, input: TrialScope, projectId: string | null,
  eventType: string, trialId: string) {
  await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId,
    actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId,
    projectId, taskId: input.taskId, eventType, factRefs: { trial_id: trialId } });
}

export async function startTaskAcceptanceTrial(db: DbExecutor, input: TrialScope & {
  expectedAcceptanceRevision: string; mode: 'ORIGINAL' | 'EVIDENCE_VIEW'; sampleLabel: string; materialIds?: string[];
  comparisonId?: string;
}) {
  const acceptance = requireRevision(input.expectedAcceptanceRevision, 'expected_acceptance_revision');
  const ids = input.materialIds ?? [];
  if (!input.sampleLabel.trim() || input.sampleLabel.length > 1024 || ids.length > 64 ||
      new Set(ids).size !== ids.length || (input.mode === 'ORIGINAL' && ids.length > 0)) {
    throw validationFailed([{ field: 'sample_label/material_ids', message: '需要样本标签和明确材料范围；原流程不关联材料。' }]);
  }
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'StartTaskAcceptanceTrial', target: { task_id: input.taskId },
    body: { expected_acceptance_revision: acceptance.toString(), mode: input.mode,
      sample_label: input.sampleLabel, material_ids: ids,
      ...(input.comparisonId === undefined ? {} : { comparison_id: input.comparisonId }) }, execute: async (r) => {
      const task = await lockAcceptanceTask(r, input.workspaceId, input.taskId);
      if (task.acceptance_revision !== acceptance) throw revisionConflict({ entityType: 'TASK_ACCEPTANCE',
        expectedRevision: acceptance.toString(), actualRevision: task.acceptance_revision.toString() });
      if (input.comparisonId !== undefined) {
        const comparison = await r.acceptanceComparisons.read(input.comparisonId);
        if (comparison?.workspace_id !== input.workspaceId || comparison.project_id !== task.project_id) {
          throw resourceNotFound('AcceptanceComparison');
        }
        const baseline = await r.acceptanceTrials.read(comparison.baseline_trial_id);
        const baselineTask = baseline === undefined ? undefined : await r.tasks.readTask(baseline.task_id);
        if (input.mode !== 'EVIDENCE_VIEW' || baseline?.revision !== comparison.baseline_revision ||
            baselineTask?.acceptance_revision !== baseline.acceptance_revision) {
          throw invalidTransition('仅新证据流程可引用仍适用的冻结基线。');
        }
      }
      for (const id of ids) {
        const material = await r.acceptanceMaterials.read(id, true);
        if (material?.workspace_id !== input.workspaceId || material.task_id !== task.id) {
          throw resourceNotFound('TaskAcceptanceMaterial');
        }
        if (material.status !== 'ACTIVE' || material.acceptance_revision !== acceptance) {
          throw invalidTransition('试用材料关联已撤销或不属于当前验收修订。');
        }
      }
      const now = await r.acceptanceTrials.now();
      const row = await r.acceptanceTrials.insert({ id: randomUUID(), workspace_id: input.workspaceId,
        task_id: task.id, acceptance_revision: acceptance, mode: input.mode, sample_label: input.sampleLabel,
        material_ids: ids, started_at: now, active_started_at: now, comparison_id: input.comparisonId ?? null });
      await audit(r, input, task.project_id, 'TASK_ACCEPTANCE_TRIAL_STARTED', row.id);
      return result(row);
    } });
}

export async function transitionTaskAcceptanceTrial(db: DbExecutor, input: TrialScope & {
  trialId: string; expectedRevision: string; action: 'PAUSE' | 'RESUME' | 'FINISH';
}) {
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'TransitionTaskAcceptanceTrial',
    target: { task_id: input.taskId, trial_id: input.trialId },
    body: { expected_revision: input.expectedRevision, action: input.action }, execute: async (r) => {
      const { task, row } = await lockedTrial(r, input);
      if (row.status === 'FINISHED' || (input.action === 'RESUME' && row.status !== 'PAUSED') ||
          (input.action === 'PAUSE' && row.status !== 'RUNNING')) {
        throw invalidTransition('当前试用状态不支持该计时操作。');
      }
      const now = await r.acceptanceTrials.now();
      const updated = await r.acceptanceTrials.update({ ...row,
        active_ms: BigInt(acceptanceTrialTiming(row, now).active_ms),
        status: input.action === 'FINISH' ? 'FINISHED' : input.action === 'PAUSE' ? 'PAUSED' : 'RUNNING',
        active_started_at: input.action === 'RESUME' ? now : null,
        finished_at: input.action === 'FINISH' ? now : null });
      await audit(r, input, task.project_id, `TASK_ACCEPTANCE_TRIAL_${input.action}`, row.id);
      return result(updated);
    } });
}

export async function recordTaskAcceptanceObservation(db: DbExecutor, input: TrialScope & {
  trialId: string; expectedRevision: string; preparationMs: number | null;
  totalAcceptanceMs: number | null; sourceNote: string;
  correctnessOutcome?: 'UNKNOWN' | 'NO_ISSUE_REPORTED' | 'ISSUE_REPORTED';
  sourceMessageId?: string;
}) {
  if ([input.preparationMs, input.totalAcceptanceMs].some((ms) => ms !== null && (!Number.isSafeInteger(ms) || ms < 0)) ||
      !input.sourceNote.trim() || input.sourceNote.length > 4000 ||
      (input.preparationMs !== null && input.totalAcceptanceMs !== null && input.totalAcceptanceMs < input.preparationMs)) {
    throw validationFailed([{ field: 'observation', message: '人工耗时使用非负整数毫秒，总耗时包括准备成本，来源说明不能为空。' }]);
  }
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'RecordTaskAcceptanceObservation',
    target: { task_id: input.taskId, trial_id: input.trialId }, body: {
      expected_revision: input.expectedRevision, preparation_ms: input.preparationMs,
      total_acceptance_ms: input.totalAcceptanceMs, source_note: input.sourceNote,
      ...(input.correctnessOutcome === undefined ? {} : { correctness_outcome: input.correctnessOutcome }),
      ...(input.sourceMessageId === undefined ? {} : { source_message_id: input.sourceMessageId }) }, execute: async (r) => {
      const { task, row } = await lockedTrial(r, input);
      if (input.sourceMessageId !== undefined) {
        const message = await r.assist.readMessage(input.sourceMessageId);
        const session = message === undefined ? undefined : await r.assist.readSession(message.session_id);
        if (message?.role !== 'USER' || message.status !== 'COMPLETED' || session?.workspace_id !== input.workspaceId ||
            session.project_id !== task.project_id || session.conversation_mode !== 'AGENT') {
          throw invalidTransition('耗时补录来源必须是同项目普通会话的原用户消息。');
        }
      }
      const updated = await r.acceptanceTrials.update(row);
      await r.acceptanceTrials.observe({ id: randomUUID(), trial_id: row.id, trial_revision: updated.revision,
        preparation_ms: input.preparationMs === null ? null : BigInt(input.preparationMs),
        total_acceptance_ms: input.totalAcceptanceMs === null ? null : BigInt(input.totalAcceptanceMs),
        source_note: input.sourceNote, correctness_outcome: input.correctnessOutcome ?? 'UNKNOWN',
        source_message_id: input.sourceMessageId ?? null });
      await audit(r, input, task.project_id, 'TASK_ACCEPTANCE_TRIAL_OBSERVED', row.id);
      return result(updated);
    } });
}

export async function listTaskAcceptanceTrials(db: DbExecutor, workspaceId: string, taskId: string) {
  return withTransaction(db, async (r) => {
    const task = await r.tasks.readTaskForShare(taskId);
    if (task?.workspace_id !== workspaceId) throw resourceNotFound('Task');
    const rows = await r.acceptanceTrials.list(workspaceId, taskId);
    const now = await r.acceptanceTrials.now();
    const items = [];
    for (const row of rows) {
      const observations = (await r.acceptanceTrials.observations(row.id)).map((o) => ({
        observation_id: o.id, trial_revision: o.trial_revision.toString(), preparation_ms: o.preparation_ms?.toString() ?? null,
        total_acceptance_ms: o.total_acceptance_ms?.toString() ?? null, source_note: o.source_note,
        source_kind: 'USER_REPORTED' as const, correctness_outcome: o.correctness_outcome, source_message_id: o.source_message_id,
        created_at: o.created_at.toISOString() }));
      items.push({ ...result(row), mode: row.mode, sample_label: row.sample_label, material_ids: row.material_ids,
        acceptance_revision: row.acceptance_revision.toString(), acceptance_matches: row.acceptance_revision === task.acceptance_revision,
        comparison_id: row.comparison_id,
        started_at: row.started_at.toISOString(), finished_at: row.finished_at?.toISOString() ?? null,
        ...acceptanceTrialTiming(row, now), total_includes_preparation: true,
        latest_observation: observations[0] ?? null, observations });
    }
    return { task_id: task.id, server_time: now.toISOString(), items };
  });
}
