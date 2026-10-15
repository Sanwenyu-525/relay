import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ProjectReminderRow, ReminderOccurrenceRow } from '../planning/project-reminder-repository.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { lockWritableProjectInWorkspace, readProjectInWorkspace, requireWorkspace } from './guards.js';
import { readAdmission } from './maintenance-admission.js';
import { requireRevision } from './revisions.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';

type Scope = { workspaceId: string; commandId: string };
const result = (row: ProjectReminderRow) => ({ reminder_id: row.id, project_id: row.project_id, revision: row.revision.toString(), status: row.status, schedule_generation: row.schedule_generation.toString() });
export function reminderInstant(value: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) throw validationFailed([{ field: 'due_at', message: '需要明确 Z 或偏移量的实际时刻，不接受无时区钟点。' }]);
  if (new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) throw validationFailed([{ field: 'due_at', message: '日期不存在。' }]);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date(value)); }
  catch { throw validationFailed([{ field: 'timezone', message: '需要有效时区名称。' }]); }
  return new Date(value);
}
const text = (value: string, field: string, max = 4000) => {
  if (!value.trim() || value.length > max) throw validationFailed([{ field, message: `需要 1–${max} 字。` }]);
  return value.trim();
};
async function authority(r: Repositories, workspaceId: string) {
  if (await r.workspaces.lockAuthority(workspaceId, 'update') === undefined) throw resourceNotFound('Workspace');
}
async function audit(r: Repositories, input: Scope, row: ProjectReminderRow, event: string) {
  await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId, projectId: row.project_id, taskId: null,
    actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId, eventType: event, factRefs: result(row) });
}
function configEvent(row: Pick<ProjectReminderRow, 'title' | 'due_at' | 'timezone' | 'status' | 'schedule_generation' | 'revision'>, commandId: string, reason: string): JsonObject {
  return { title: row.title, due_at: row.due_at.toISOString(), timezone: row.timezone, status: row.status,
    schedule_generation: row.schedule_generation.toString(), revision: row.revision.toString(), command_id: commandId, reason };
}
export async function createProjectReminder(db: DbExecutor, input: Scope & { projectId: string; title: string; dueAt: string; timezone: string; confirmed: true }) {
  const title = text(input.title, 'title', 200); const dueAt = reminderInstant(input.dueAt, input.timezone);
  if (input.confirmed !== true) throw validationFailed([{ field: 'confirmed', message: '需要确认提醒实际时刻。' }]);
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'CreateProjectReminder',
    target: { project_id: input.projectId }, body: { title, due_at: dueAt.toISOString(), timezone: input.timezone, confirmed: input.confirmed }, execute: async (r) => {
      await authority(r, input.workspaceId); await lockWritableProjectInWorkspace(r, input.workspaceId, input.projectId);
      const row = await r.projectReminders.insert({ id: randomUUID(), workspace_id: input.workspaceId, project_id: input.projectId, title, due_at: dueAt, timezone: input.timezone,
        history: [configEvent({ title, due_at: dueAt, timezone: input.timezone, status: 'ENABLED', schedule_generation: 1n, revision: 1n }, input.commandId, '用户确认一次性继续项目提醒')] });
      await audit(r, input, row, 'PROJECT_REMINDER_CREATED'); return result(row);
    } });
}
export async function editProjectReminder(db: DbExecutor, input: Scope & { reminderId: string; expectedRevision: string; title: string; dueAt: string; timezone: string; confirmed: true; reason: string }) {
  const title = text(input.title, 'title', 200); const dueAt = reminderInstant(input.dueAt, input.timezone); const reason = text(input.reason, 'reason');
  if (input.confirmed !== true) throw validationFailed([{ field: 'confirmed', message: '需要确认修改实际时刻。' }]);
  return mutate(db, input, 'EditProjectReminder', { title, due_at: dueAt.toISOString(), timezone: input.timezone, confirmed: input.confirmed, reason }, async (r, row) => {
    const updated = { ...row, title, due_at: dueAt, timezone: input.timezone, schedule_generation: row.schedule_generation + (row.due_at.getTime() === dueAt.getTime() ? 0n : 1n) };
    return r.projectReminders.update(updated, configEvent({ ...updated, revision: row.revision + 1n }, input.commandId, reason));
  });
}
export async function setProjectReminderStatus(db: DbExecutor, input: Scope & { reminderId: string; expectedRevision: string; status: ProjectReminderRow['status']; reason: string }) {
  const reason = text(input.reason, 'reason');
  return mutate(db, input, 'SetProjectReminderStatus', { status: input.status, reason }, async (r, row) => {
    const updated = { ...row, status: input.status };
    return r.projectReminders.update(updated, configEvent({ ...updated, revision: row.revision + 1n }, input.commandId, reason));
  });
}
async function mutate(db: DbExecutor, input: Scope & { reminderId: string; expectedRevision: string }, commandType: string, body: JsonObject,
  apply: (r: Repositories, row: ProjectReminderRow) => Promise<ProjectReminderRow>) {
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType,
    target: { reminder_id: input.reminderId }, body: { expected_revision: input.expectedRevision, ...body }, execute: async (r) => {
      await authority(r, input.workspaceId);
      const row = await r.projectReminders.read(input.reminderId, true);
      if (row?.workspace_id !== input.workspaceId) throw resourceNotFound('ProjectReminder');
      await lockWritableProjectInWorkspace(r, input.workspaceId, row.project_id);
      if (row.revision !== requireRevision(input.expectedRevision, 'expected_revision')) throw revisionConflict({ entityType: 'PROJECT_REMINDER', expectedRevision: input.expectedRevision, actualRevision: row.revision.toString() });
      const updated = await apply(r, row); await audit(r, input, updated, commandType); return result(updated);
    } });
}
const reminderView = (row: ProjectReminderRow) => ({ ...result(row), title: row.title, due_at: row.due_at.toISOString(), timezone: row.timezone, history: row.history, created_at: row.created_at.toISOString() });
async function occurrenceView(r: Repositories, row: ReminderOccurrenceRow) {
  const project = await readProjectInWorkspace(r, row.workspace_id, row.project_id);
  return { occurrence_id: row.id, reminder_id: row.reminder_id, project_id: row.project_id, config_revision: row.config_revision.toString(), schedule_generation: row.schedule_generation.toString(),
    title: row.title, due_at: row.due_at.toISOString(), timezone: row.timezone, missed: row.missed, status: row.status, revision: row.revision.toString(),
    resolution_reason: row.resolution_reason, resolved_at: row.resolved_at?.toISOString() ?? null, created_at: row.created_at.toISOString(),
    project: { title: project.title, revision: project.revision.toString(), archived: project.archived_at !== null },
    plan_entry: `/api/v1/workspaces/${row.workspace_id}/projects/${row.project_id}/period-plans`,
    can_plan: project.archived_at === null && row.status === 'PENDING', execution_admission: 'NOT_GRANTED' };
}
export async function readProjectReminder(db: DbExecutor, workspaceId: string, id: string) {
  return withTransaction(db, async (r) => {
    const row = await r.projectReminders.read(id); if (row?.workspace_id !== workspaceId) throw resourceNotFound('ProjectReminder');
    return reminderView(row);
  });
}
export async function listProjectReminders(db: DbExecutor, workspaceId: string, projectId: string) {
  return withTransaction(db, async (r) => { await readProjectInWorkspace(r, workspaceId, projectId); return { project_id: projectId, items: (await r.projectReminders.list(workspaceId, projectId)).map(reminderView) }; });
}
export async function listReminderOccurrences(db: DbExecutor, workspaceId: string, projectId?: string) {
  return withTransaction(db, async (r) => {
    await requireWorkspace(r, workspaceId); if (projectId !== undefined) await readProjectInWorkspace(r, workspaceId, projectId);
    const items = []; for (const row of await r.projectReminders.occurrences(workspaceId, projectId)) items.push(await occurrenceView(r, row));
    return { items };
  });
}
export async function readReminderOccurrence(db: DbExecutor, workspaceId: string, id: string) {
  return withTransaction(db, async (r) => { const row = await r.projectReminders.readOccurrence(id); if (row?.workspace_id !== workspaceId) throw resourceNotFound('ReminderOccurrence'); return occurrenceView(r, row); });
}
export async function resolveReminderOccurrence(db: DbExecutor, input: Scope & { occurrenceId: string; expectedRevision: string; action: 'HANDLE' | 'DISMISS'; reason: string }) {
  const reason = text(input.reason, 'reason');
  return runIdempotentCommand(db, { scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'ResolveReminderOccurrence',
    target: { occurrence_id: input.occurrenceId }, body: { expected_revision: input.expectedRevision, action: input.action, reason }, execute: async (r) => {
      await authority(r, input.workspaceId); const row = await r.projectReminders.readOccurrence(input.occurrenceId, true);
      if (row?.workspace_id !== input.workspaceId) throw resourceNotFound('ReminderOccurrence');
      if (row.revision !== requireRevision(input.expectedRevision, 'expected_revision')) throw revisionConflict({ entityType: 'REMINDER_OCCURRENCE', expectedRevision: input.expectedRevision, actualRevision: row.revision.toString() });
      if (row.status !== 'PENDING') throw invalidTransition('此提醒事项已经处理，请读回原结果。');
      const updated = await r.projectReminders.resolve(row.id, input.action === 'HANDLE' ? 'HANDLED' : 'DISMISSED', reason);
      await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId: input.workspaceId, projectId: row.project_id, taskId: null,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId, eventType: 'PROJECT_REMINDER_RESOLVED', factRefs: { occurrence_id: row.id, action: input.action } });
      return { occurrence_id: row.id, project_id: row.project_id, status: updated.status, revision: updated.revision.toString() };
    } });
}
/** 仅服务存活期间调用；发生身份与通知/模型/任务执行分离。 */
export async function scanProjectReminders(db: DbExecutor, openedAt: Date) {
  let count = 0;
  for (const workspaceId of await createRepositories(db).projectReminders.dueWorkspaces()) count += await withTransaction(db, async (r) => {
    if ((await readAdmission(r, 'share')).mode !== 'NORMAL') return 0;
    await authority(r, workspaceId); const now = await r.projectReminders.now(); let added = 0;
    for (const row of await r.projectReminders.due(workspaceId, now)) {
      const project = await r.projects.lockProjectArchiveGate(row.project_id); if (project?.archived_at !== null) continue;
      const occurrence = await r.projectReminders.trigger(row, row.due_at < openedAt);
      if (occurrence !== undefined) {
        added++;
        await r.activities.insertActivityRecord({ id: randomUUID(), workspaceId, projectId: row.project_id, taskId: null, actorKind: 'SYSTEM', actorRef: 'project-reminder-scheduler',
          commandId: null, eventType: 'PROJECT_REMINDER_TRIGGERED', factRefs: { reminder_id: row.id, occurrence_id: occurrence.id, schedule_generation: row.schedule_generation.toString(), missed: occurrence.missed } });
      }
    }
    return added;
  });
  return count;
}
export async function claimReminderNotifications(db: DbExecutor, workspaceId: string) {
  return withTransaction(db, async (r) => {
    if ((await readAdmission(r, 'share')).mode !== 'NORMAL') return { items: [] };
    await authority(r, workspaceId); const items = [];
    for (const row of await r.projectReminders.occurrences(workspaceId, undefined, true)) {
      const project = await readProjectInWorkspace(r, workspaceId, row.project_id);
      if (project.archived_at !== null || !await r.projectReminders.claim(workspaceId, row.id)) continue;
      items.push({ occurrence_id: row.id, item_key: `project-reminder:${row.id}`, change_key: '1', title: row.title,
        reason: row.missed ? '错过的继续项目提醒仍待处理。' : '到了继续项目的时间，请主动发起本段计划。', target_url: `/projects/${row.project_id}?reminder_occurrence=${row.id}` });
    }
    return { items };
  });
}
