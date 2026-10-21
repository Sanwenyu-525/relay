import { createHash } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ActivityPageRow } from '../audit/activity-record-repository.js';
import { invalidCursor, resourceNotFound, validationFailed } from './domain-error.js';
import { createRepositories } from './unit-of-work.js';
import { readProjectInWorkspace, readTaskInWorkspace, requireWorkspace } from './guards.js';

type RefKind = 'PROJECT' | 'TASK' | 'RUN' | 'GOAL' | 'ARTIFACT_VERSION' |
  'REVIEW' | 'COMPLETION' | 'VERIFICATION_SESSION';
export interface ActivityDto {
  readonly id: string;
  readonly created_at: string;
  readonly actor_kind: 'HUMAN' | 'AI' | 'SYSTEM';
  readonly actor_ref: string;
  readonly command_id: string | null;
  readonly event_type: string;
  readonly summary: string;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly run_id: string | null;
  readonly entity_refs: readonly { readonly kind: RefKind; readonly id: string }[];
}

export interface ActivityPageDto {
  readonly items: readonly ActivityDto[];
  readonly next_cursor: string | null;
}

export interface ActivityFilter {
  readonly workspaceId: string;
  readonly projectId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly runId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RUN_ACTOR = /^run:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/attempt:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/iu;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
/**
 * Event type -> human summary.
 *
 * 2026-10-20 (fifth pass): this table used to cover only 18 event types, so every other type
 * fell back to the sentinel '业务事件'; the frontend then mapped it with its own second table,
 * and anything missing from both ended up rendered as "未识别的事件" — a real action that
 * actually happened read as a UI defect, and several of the same kind stacked up as identical
 * placeholder rows in "最近动态" (reported in a screenshot).
 * It is now filled in against every `eventType:` literal under apps/api/src (64 types).
 * The sentinel is kept on purpose: it is only returned when the server really has no summary
 * for a type, and the frontend then falls back to its own mapping or a clearly degraded copy,
 * so an unknown event is never dressed up as a concrete operation.
 */
const SUMMARY: Record<string, string> = {
  // Workspace & goals
  WORKSPACE_INITIALIZED: '创建工作区', GOAL_CREATED: '创建目标',
  GOAL_UPDATED: '修改目标', GOAL_ARCHIVED: '归档目标',
  // Projects
  PROJECT_CREATED: '创建项目', PROJECT_STATE_UPDATED: '更新项目状态',
  PROJECT_ARCHIVED: '归档项目', PROJECT_UNARCHIVED: '取消归档项目',
  PROJECT_PRESENTATION_UPDATED: '修改项目名称', PROJECT_GOAL_LINKED: '项目关联目标',
  PROJECT_GOAL_UNLINKED: '项目解除目标关联', PROJECT_RETURN_REVIEWED: '查看项目接续变化',
  PROJECT_DAILY_VIEW_CONFIRMED: '确认项目当日进展',
  PROJECT_DAILY_VIEW_BASELINE_REPAIRED: '重算项目当日基线',
  PROJECT_CONTINUATION_POINT_CAPTURED: '记录项目接续点',
  PROJECT_REMINDER_TRIGGERED: '触发项目提醒', PROJECT_REMINDER_RESOLVED: '处理项目提醒',
  PROJECT_BLUEPRINT_PROPOSED: '提出项目蓝图', PROJECT_BLUEPRINT_APPLIED: '应用项目蓝图',
  PROJECT_BLUEPRINT_REJECTED: '拒绝项目蓝图',
  // Tasks
  TASK_CREATED: '创建任务', TASK_PRESENTATION_UPDATED: '修改任务',
  TASK_PROJECT_ASSIGNED: '归入项目', TASK_PLANNING_UPDATED: '修改任务计划',
  TASK_ACCEPTANCE_CHANGED: '修改验收条件',
  TASK_ACCEPTANCE_MATERIAL_ATTACHED: '附上验收材料',
  TASK_ACCEPTANCE_MATERIAL_WITHDRAWN: '撤回验收材料',
  TASK_GOAL_ALIGNMENT_CHANGED: '修改任务目标对齐', TASK_DEPENDENCY_ADDED: '添加任务依赖',
  TASK_DEPENDENCY_REMOVED: '移除任务依赖', TASK_STARTED: '开始任务',
  TASK_DELEGATED: '委托任务', TASK_READIED: '任务进入可执行', TASK_CANCELLED: '取消任务',
  TASK_COMPLETED: '完成任务', TASK_REOPENED: '重开任务',
  SCHEDULED_TASK_OCCURRENCE_RESOLVED: '处理定时任务这一次执行',
  // Execution & artifacts
  DELEGATION_CREATED: '委托 AI 执行', RUN_CREATED: '创建 Run', RUN_FINISHED: 'Run 结束',
  RUN_FAILED: '运行失败', RUN_WAITING_TOOL_LOOP: 'Run 等待工具结果',
  RUN_WORKER_FENCED: 'Run 被 fencing 拦下', RUN_OWNERSHIP_MISMATCH: 'Run 归属不符',
  RUN_GRAPH_LAYOUT_REBUILT: '重排 Run 图', STEP_ATTEMPT_RESULT_REJECTED_STALE: '丢弃过期的步骤结果',
  ARTIFACT_VERSION_SAVED: '保存产物版本', ARTIFACT_VERSION_SELECTED: '选用产物版本',
  ACCEPTANCE_COMPARISON_FROZEN: '冻结验收比对',
  FILE_WRITE_MANUALLY_CLOSED: '手动结束文件写入',
  // Human judgement & verification
  REVIEW_REQUESTED: '请求人工判断', REVIEW_DECIDED: '人工判断已保存',
  VERIFICATION_COMPLETED: '验证完成', VERIFICATION_FINALIZED: '检查已结算',
  DECISION_REVIEW_PREPARED: '准备决策审阅', DECISION_PREMISE_REGISTERED: '登记决策前提',
  DECISION_REVIEW_RESOLVED: '了结决策审阅',
  // Run control
  RUN_CONTROL_REQUESTED: '请求运行控制', RUN_CONTROL_APPLIED: '运行控制已应用',
  // Conversations & memory
  CONVERSATION_STATE_REQUESTED: '提交状态维护请求', CONVERSATION_STATE_APPLIED: '应用状态维护',
  CONVERSATION_STATE_DECISION_ANSWERED: '回答状态维护提问',
  CONVERSATION_STATE_WITHDRAWN: '撤回状态维护请求', CONVERSATION_EXECUTION_REQUESTED: '提交执行请求',
  CONVERSATION_EXTERNAL_CHECKED: '核对讨论依赖的外部事实', ASSIST_SESSION_DELETED: '删除讨论',
  MEMORY_SAVED_FROM_MESSAGE: '从消息保存记忆', MEMORY_AUTO_CAPTURED: '自动记下记忆',
  MEMORY_AUTO_CAPTURE_ROUND: '自动记忆这一轮', MEMORY_AUTO_CAPTURE_RETIRED: '停用自动记忆',
  // Daily view & view configuration
  TODAY_TASK_SELECTION_CHANGED: '修改任务选择', TODAY_FOCUS_CHANGED: '修改当日焦点',
  VIEW_CONFIGURATION_CHANGED: '修改视图配置'
};

export async function listActivities(db: DbExecutor, input: ActivityFilter): Promise<ActivityPageDto> {
  const limit = input.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw validationFailed([{ field: 'limit', message: 'must be 1..100' }]);
  }
  const from = parseInstant(input.from, 'from');
  const to = parseInstant(input.to, 'to');
  if (from !== undefined && to !== undefined && from >= to) {
    throw validationFailed([{ field: 'to', message: 'must be after from' }]);
  }
  const filterKey = createHash('sha256').update(JSON.stringify({ workspaceId: input.workspaceId,
    projectId: input.projectId ?? null, taskId: input.taskId ?? null,
    runId: input.runId ?? null, from: input.from ?? null, to: input.to ?? null })).digest('hex');
  const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor, filterKey);
  return db.transaction().setIsolationLevel('repeatable read').execute(async (snapshot) => {
    const repositories = createRepositories(snapshot);
    await requireWorkspace(repositories, input.workspaceId);
    if (input.projectId !== undefined) {
      await readProjectInWorkspace(repositories, input.workspaceId, input.projectId);
    }
    if (input.taskId !== undefined) {
      await readTaskInWorkspace(repositories, input.workspaceId, input.taskId);
    }
    if (input.runId !== undefined) {
      const run = await repositories.runs.readRun(input.runId);
      if (run?.workspace_id !== input.workspaceId) throw resourceNotFound('Run');
    }
    const rows = await repositories.activities.listPage({ workspaceId: input.workspaceId,
      projectId: input.projectId, taskId: input.taskId, runId: input.runId,
      from, to, after, limit });
    const page = rows.slice(0, limit);
    const items = await Promise.all(page.map((row) => projectActivity(snapshot, row, input.workspaceId)));
    const last = page.at(-1);
    const nextCursor = rows.length > limit && last !== undefined ? Buffer.from(JSON.stringify({
      v: 1, filter: filterKey, at: last.cursor_at, id: last.id }), 'utf8').toString('base64url') : null;
    return { items, next_cursor: nextCursor };
  });
}

function parseInstant(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  if (!INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    throw validationFailed([{ field, message: 'must be a UTC RFC3339 instant' }]);
  }
  return new Date(value);
}

function decodeCursor(cursor: string, filter: string): { at: string; id: string } {
  if (cursor.length > 800) throw invalidCursor('cursor', '游标过长。');
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.filter !== filter || typeof parsed.at !== 'string' ||
        !Number.isFinite(Date.parse(parsed.at)) || typeof parsed.id !== 'string' ||
        !UUID.test(parsed.id)) throw new Error('invalid cursor');
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw invalidCursor('cursor', '游标不可解析或与当前筛选条件不一致。');
  }
}

async function projectActivity(db: DbExecutor, row: ActivityPageRow,
  workspaceId: string): Promise<ActivityDto> {
  const refs: { kind: RefKind; id: string }[] = [];
  if (row.project_id !== null) refs.push({ kind: 'PROJECT', id: row.project_id });
  if (row.task_id !== null) refs.push({ kind: 'TASK', id: row.task_id });
  if (row.run_id !== null) refs.push({ kind: 'RUN', id: row.run_id });
  const candidateRefs = [
    ['goal_id', 'GOAL', 'goals', 'id'],
    ['artifact_version_id', 'ARTIFACT_VERSION', 'artifact_versions', 'id'],
    ['review_id', 'REVIEW', 'review_requests', 'id'],
    ['completion_id', 'COMPLETION', 'completion_records', 'id'],
    ['verification_session_id', 'VERIFICATION_SESSION', 'verification_sessions', 'id'],
  ] as const;
  for (const [key, kind] of candidateRefs) {
    const value = row.fact_refs[key];
    if (typeof value !== 'string' || !UUID.test(value)) continue;
    if (await refVisible(db, workspaceId, kind, value)) refs.push({ kind, id: value });
  }
  const actorRef = row.actor_ref === 'user:local' || row.actor_ref === 'recovery-scanner' ||
    RUN_ACTOR.test(row.actor_ref)
    ? row.actor_ref : 'REDACTED';
  return { id: row.id, created_at: row.created_at.toISOString(), actor_kind: row.actor_kind,
    actor_ref: actorRef, command_id: row.command_id, event_type: row.event_type,
    summary: SUMMARY[row.event_type] ?? '业务事件', project_id: row.project_id,
    task_id: row.task_id, run_id: row.run_id, entity_refs: refs };
}

async function refVisible(db: DbExecutor, workspaceId: string, kind: RefKind,
  id: string): Promise<boolean> {
  if (kind === 'GOAL') {
    return (await db.selectFrom('goals').select('id')
      .where('workspace_id', '=', workspaceId).where('id', '=', id).executeTakeFirst()) !== undefined;
  }
  if (kind === 'ARTIFACT_VERSION') {
    return (await db.selectFrom('artifact_versions as v').innerJoin('artifacts as a', 'a.id', 'v.artifact_id')
      .select('v.id').where('a.workspace_id', '=', workspaceId).where('v.id', '=', id)
      .executeTakeFirst()) !== undefined;
  }
  if (kind === 'REVIEW') {
    return (await db.selectFrom('review_requests').select('id')
      .where('workspace_id', '=', workspaceId).where('id', '=', id).executeTakeFirst()) !== undefined;
  }
  if (kind === 'COMPLETION') {
    return (await db.selectFrom('completion_records as c').innerJoin('tasks as t', 't.id', 'c.task_id')
      .select('c.id').where('t.workspace_id', '=', workspaceId).where('c.id', '=', id)
      .executeTakeFirst()) !== undefined;
  }
  if (kind === 'VERIFICATION_SESSION') {
    return (await db.selectFrom('verification_sessions as v').innerJoin('tasks as t', 't.id', 'v.task_id')
      .select('v.id').where('t.workspace_id', '=', workspaceId).where('v.id', '=', id)
      .executeTakeFirst()) !== undefined;
  }
  return false;
}
