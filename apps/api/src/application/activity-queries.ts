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
const SUMMARY: Record<string, string> = {
  WORKSPACE_INITIALIZED: '创建工作区', PROJECT_CREATED: '创建项目',
  PROJECT_ARCHIVED: '归档项目', GOAL_CREATED: '创建目标',
  TASK_CREATED: '创建任务', TASK_PRESENTATION_UPDATED: '修改任务',
  TASK_ACCEPTANCE_CHANGED: '修改验收条件', TASK_PLANNING_UPDATED: '修改任务计划',
  TASK_DELEGATED: '委托任务', ARTIFACT_VERSION_SAVED: '保存产物版本',
  REVIEW_DECIDED: '人工判断已保存', TASK_COMPLETED: '完成任务',
  TASK_REOPENED: '重开任务', RUN_FAILED: '运行失败',
  RUN_CONTROL_REQUESTED: '请求运行控制', RUN_CONTROL_APPLIED: '运行控制已应用',
  TODAY_TASK_SELECTION_CHANGED: '修改任务选择', TODAY_FOCUS_CHANGED: '修改当日焦点',
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
