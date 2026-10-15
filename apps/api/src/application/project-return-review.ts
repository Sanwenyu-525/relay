import { createHash, randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ProjectReturnReviewRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { resourceNotFound } from './domain-error.js';
import { computeDailyDelta, readCurrentFacts } from './project-daily-continuation.js';
import { readProjectInWorkspace } from './guards.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/**
 * 返回轻量核对（总纲 §0.8.1 / 测试计划 NLS-05、NLS-08、NLS-09 / 任务书第五节第 4 项）。
 *
 * 「基线查询/顶部卡不是检查运行」：这里是一条**有持久身份的核对记录**——
 *   1. 权限：先核对项目可见性；失权直接拒绝，零写入、零核对；
 *   2. 差异：把实际已查看基线与当前事实比对（复用日常查看的 delta 语义）；
 *   3. 证据适用性：逐个核对已完成任务的完成记录——验收版本未漂移、AUTO 会话仍适用才算适用；
 *   4. 指纹：事实 + 基线 + 证据共同决定 fingerprint；没变就复用同一行（重复打开、双击、
 *      重启都不产生第二次核对），变了就重新核对，不把旧结论冒充新结果；
 *   5. 边界：核对是同步只读动作——不伪造 Run、不启动进程、不自动修复、不新建任务、
 *      不做未授权的外部调用（NLS-05）。
 */

export type ReturnReviewEvidence = {
  readonly task_id: string;
  readonly completion_id: string;
  readonly basis_kind: string;
  readonly acceptance_revision: string;
  readonly applicable: boolean;
};

export type ReturnReviewProjection = {
  readonly review_id: string;
  readonly project_id: string;
  readonly status: 'APPLICABLE' | 'CHANGED';
  readonly fingerprint: string;
  /** true = 这份事实与证据上已经核对过，本次按原记录复用，不产生第二次核对。 */
  readonly reused: boolean;
  readonly changed_dimensions: readonly string[];
  readonly delta: {
    readonly phase_changed: boolean;
    readonly next_action_changed: boolean;
    readonly new_open_task_count: number;
    readonly closed_open_task_count: number;
    readonly unresolved_blocker_count_changed: boolean;
    readonly open_tasks_unknown: boolean;
  } | null;
  readonly evidence: readonly ReturnReviewEvidence[];
  readonly created_at: string;
};

/** 已完成任务的完成证据适用性：验收版本漂移或 AUTO 会话被撤销都算不再适用。 */
async function readEvidenceApplicability(repositories: Repositories, projectId: string,
  workspaceId: string): Promise<readonly ReturnReviewEvidence[]> {
  const done = await repositories.tasks.listProjectTasksByStatus(projectId, ['DONE']);
  const entries: ReturnReviewEvidence[] = [];
  for (const task of done.slice(0, 100)) {
    if (task.workspace_id !== workspaceId) continue;
    if (task.current_completion_id === null) {
      entries.push({ task_id: task.id, completion_id: '', basis_kind: 'MISSING',
        acceptance_revision: toDecimalString(task.acceptance_revision), applicable: false });
      continue;
    }
    const completion = await repositories.completions
      .readCompletionRecord(task.current_completion_id);
    if (completion === undefined) {
      entries.push({ task_id: task.id, completion_id: task.current_completion_id,
        basis_kind: 'MISSING', acceptance_revision: '', applicable: false });
      continue;
    }
    let applicable = completion.acceptance_revision === task.acceptance_revision;
    if (applicable && completion.basis_kind === 'AUTO' &&
        completion.verification_session_id !== null) {
      applicable = await repositories.verifications
        .isApplicable(completion.verification_session_id);
    }
    entries.push({ task_id: task.id, completion_id: completion.id,
      basis_kind: completion.basis_kind,
      acceptance_revision: toDecimalString(completion.acceptance_revision), applicable });
  }
  return entries;
}

function fingerprintOf(current: {
  readonly phase_key: string | null; readonly next_action_task_id: string | null;
  readonly open_task_ids: readonly string[]; readonly open_task_ids_truncated: boolean;
  readonly unresolved_blocker_count: number;
}, baselineRefs: JsonObject | null,
  evidence: readonly ReturnReviewEvidence[]): string {
  const canonical = JSON.stringify({ current: { phase: current.phase_key,
    next: current.next_action_task_id, open: current.open_task_ids,
    truncated: current.open_task_ids_truncated, blockers: current.unresolved_blocker_count },
  baseline: baselineRefs, evidence });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function projectionOf(row: ProjectReturnReviewRow, reused: boolean): ReturnReviewProjection {
  const result = row.result as unknown as Record<string, unknown>;
  const dimensions = Array.isArray(result.changed_dimensions)
    ? result.changed_dimensions.filter((item): item is string => typeof item === 'string') : [];
  const evidence = Array.isArray(result.evidence) ? result.evidence as ReturnReviewEvidence[]
    : [];
  return { review_id: row.id, project_id: row.project_id, status: row.status,
    fingerprint: row.fingerprint, reused,
    changed_dimensions: dimensions,
    delta: (result.delta ?? null) as ReturnReviewProjection['delta'],
    evidence, created_at: row.created_at.toISOString() };
}

export interface ReviewProjectReturnInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly commandId: string;
}

export async function reviewProjectReturn(db: DbExecutor,
  input: ReviewProjectReturnInput): Promise<{
    readonly projection: ReturnReviewProjection;
    readonly replayed: boolean;
  }> {
  const repositories = createRepositories(db);
  // 权限先行：失权读取直接拒绝，不产生核对记录、不做任何后续核对。
  await readProjectInWorkspace(repositories, input.workspaceId, input.projectId);

  const current = await readCurrentFacts(repositories, input.projectId);
  const baseline = (await repositories.dailyViews
    .findByProject(input.workspaceId, input.projectId)) ?? null;
  const baselineRefs = baseline?.viewed_fact_refs ?? null;
  const delta = computeDailyDelta(current, baselineRefs);
  const evidence = await readEvidenceApplicability(repositories, input.projectId,
    input.workspaceId);

  const changedDimensions: string[] = [];
  if (baseline === null) changedDimensions.push('baseline_missing');
  if (delta?.phase_changed === true) changedDimensions.push('phase');
  if (delta?.next_action_changed === true) changedDimensions.push('next_action');
  if (delta !== null && (delta.new_open_task_ids.length > 0 ||
      delta.closed_task_ids.length > 0 || delta.open_tasks_unknown)) {
    changedDimensions.push('open_tasks');
  }
  if (delta?.unresolved_blocker_count_changed === true) changedDimensions.push('blockers');
  if (evidence.some((entry) => !entry.applicable)) changedDimensions.push('evidence_drift');
  // 有可比对基线、没有差异、证据全部仍适用 → 复用既有结论；否则如实标出变化维度。
  // 证据集合本身的变化由指纹承担：新增/变化的证据得到新 fingerprint，重新核对一次。
  const status: 'APPLICABLE' | 'CHANGED' = baseline !== null && delta !== null &&
    changedDimensions.length === 0 ? 'APPLICABLE' : 'CHANGED';
  const fingerprint = fingerprintOf(current, baselineRefs, evidence);
  const result = { changed_dimensions: changedDimensions, evidence,
    delta: delta === null ? null : { phase_changed: delta.phase_changed,
      next_action_changed: delta.next_action_changed,
      new_open_task_count: delta.new_open_task_ids.length,
      closed_open_task_count: delta.closed_task_ids.length,
      unresolved_blocker_count_changed: delta.unresolved_blocker_count_changed,
      open_tasks_unknown: delta.open_tasks_unknown } };

  const outcome = await runIdempotentCommand<{ review_id: string; reused: boolean }>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'ReviewProjectReturn', target: { project_id: input.projectId },
    body: { fingerprint },
    execute: async (repos) => {
      // 同一事实与证据已核对过：复用原记录，不产生第二次核对、不重复审计。
      const existing = await repos.returnReviews.findByFingerprint(input.workspaceId,
        input.projectId, fingerprint);
      if (existing !== undefined) return { review_id: existing.id, reused: true };
      const inserted = await repos.returnReviews.insertReview({
        workspaceId: input.workspaceId, projectId: input.projectId, fingerprint, status,
        result: result as JsonObject });
      // 并发首插撞唯一约束：回读胜出行（仍只有一条核对记录）。
      const row = inserted ?? await repos.returnReviews.findByFingerprint(input.workspaceId,
        input.projectId, fingerprint);
      if (row === undefined) {
        throw new Error('return review row disappeared after conflict resolution');
      }
      if (inserted !== undefined) {
        await repos.activities.insertActivityRecord({ id: randomUUID(),
          workspaceId: input.workspaceId, actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
          commandId: input.commandId, projectId: input.projectId, taskId: null,
          eventType: 'PROJECT_RETURN_REVIEWED',
          factRefs: { project_id: input.projectId, review_id: row.id, status,
            fingerprint, changed_dimensions: changedDimensions } });
      }
      return { review_id: row.id, reused: false };
    },
  });

  const row = await repositories.returnReviews.findByFingerprint(input.workspaceId,
    input.projectId, fingerprint);
  if (row === undefined) throw resourceNotFound('Return review');
  return { projection: projectionOf(row, outcome.replayed || outcome.result.reused),
    replayed: outcome.replayed };
}
