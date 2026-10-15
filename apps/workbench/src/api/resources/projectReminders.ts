import { RelayHttp } from '../core/http';
import { array, boolean, decimal, nullableString, object, string } from '../core/primitives';
import { commandEnvelopeFrom } from '../parse/projects';
import type { RelayProjectReminder, RelayReminderCreate, RelayReminderEdit, RelayReminderNotification, RelayReminderOccurrence, RelayReminderResolution, RelayReminderResult, RelayReminderStatusInput } from '../dtos/projectReminders';
function resultFrom(value: unknown): RelayReminderResult {
  const r = object(value, 'reminder result'); const status = string(r, 'status', 'reminder result');
  if (!['ENABLED', 'PAUSED', 'DISABLED'].includes(status)) throw new Error('提醒配置状态无法识别。');
  return { reminderId: string(r, 'reminder_id', 'reminder result'), projectId: string(r, 'project_id', 'reminder result'), revision: decimal(r, 'revision', 'reminder result'),
    status: status as RelayReminderResult['status'], scheduleGeneration: decimal(r, 'schedule_generation', 'reminder result') };
}
function reminderFrom(value: unknown): RelayProjectReminder {
  const r = object(value, 'reminder'); return { ...resultFrom(r), title: string(r, 'title', 'reminder'), dueAt: string(r, 'due_at', 'reminder'), timezone: string(r, 'timezone', 'reminder'),
    history: array(r, 'history', 'reminder').map((v) => object(v, 'config history')), createdAt: string(r, 'created_at', 'reminder') };
}
function occurrenceFrom(value: unknown): RelayReminderOccurrence {
  const r = object(value, 'reminder occurrence'); const status = string(r, 'status', 'reminder occurrence'); const project = object(r.project, 'reminder project');
  if (!['PENDING', 'HANDLED', 'DISMISSED'].includes(status) || r.execution_admission !== 'NOT_GRANTED') throw new Error('提醒事项状态或执行准入性质不明确。');
  return { occurrenceId: string(r, 'occurrence_id', 'reminder occurrence'), reminderId: string(r, 'reminder_id', 'reminder occurrence'), projectId: string(r, 'project_id', 'reminder occurrence'),
    configRevision: decimal(r, 'config_revision', 'reminder occurrence'), scheduleGeneration: decimal(r, 'schedule_generation', 'reminder occurrence'), title: string(r, 'title', 'reminder occurrence'),
    dueAt: string(r, 'due_at', 'reminder occurrence'), timezone: string(r, 'timezone', 'reminder occurrence'), missed: boolean(r, 'missed', 'reminder occurrence'), status: status as RelayReminderOccurrence['status'],
    revision: decimal(r, 'revision', 'reminder occurrence'), resolutionReason: nullableString(r, 'resolution_reason', 'reminder occurrence'), resolvedAt: nullableString(r, 'resolved_at', 'reminder occurrence'),
    createdAt: string(r, 'created_at', 'reminder occurrence'), project: { title: string(project, 'title', 'reminder project'), revision: decimal(project, 'revision', 'reminder project'), archived: boolean(project, 'archived', 'reminder project') },
    planEntry: string(r, 'plan_entry', 'reminder occurrence'), canPlan: boolean(r, 'can_plan', 'reminder occurrence'), executionAdmission: 'NOT_GRANTED' };
}
async function submit(http: RelayHttp, path: string, commandId: string, body: Record<string, unknown>, status: 200 | 201, id?: string) {
  const e = commandEnvelopeFrom(await http.request(path, { method: 'POST', body: JSON.stringify({ command_id: commandId, ...body }) }, status)); const r = resultFrom(e.result);
  if (e.commandId !== commandId || id !== undefined && r.reminderId !== id) throw new Error('提醒回执与原命令/配置不匹配。'); return r;
}
export async function createProjectReminder(http: RelayHttp, input: RelayReminderCreate) {
  const r = await submit(http, http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/reminders`), input.commandId,
    { title: input.title, due_at: input.dueAt, timezone: input.timezone, confirmed: input.confirmed }, 201);
  if (r.projectId !== input.projectId) throw new Error('提醒创建回执与项目不匹配。'); return r;
}
export function editProjectReminder(http: RelayHttp, input: RelayReminderEdit) {
  return submit(http, http.workspacePath(`/project-reminders/${encodeURIComponent(input.reminderId)}/edits`), input.commandId,
    { expected_revision: input.expectedRevision, title: input.title, due_at: input.dueAt, timezone: input.timezone, confirmed: input.confirmed, reason: input.reason }, 200, input.reminderId);
}
export function setProjectReminderStatus(http: RelayHttp, input: RelayReminderStatusInput) {
  return submit(http, http.workspacePath(`/project-reminders/${encodeURIComponent(input.reminderId)}/status-changes`), input.commandId,
    { expected_revision: input.expectedRevision, status: input.status, reason: input.reason }, 200, input.reminderId);
}
export async function getProjectReminder(http: RelayHttp, id: string) {
  const r = reminderFrom(await http.request(http.workspacePath(`/project-reminders/${encodeURIComponent(id)}`))); if (r.reminderId !== id) throw new Error('提醒身份不匹配。'); return r;
}
export async function getProjectReminders(http: RelayHttp, projectId: string) {
  const r = object(await http.request(http.workspacePath(`/projects/${encodeURIComponent(projectId)}/reminders`)), 'reminder list'); const items = array(r, 'items', 'reminder list').map(reminderFrom);
  if (r.project_id !== projectId || items.some((i) => i.projectId !== projectId)) throw new Error('提醒列表项目不匹配。'); return { projectId, items };
}
export async function getReminderOccurrences(http: RelayHttp, projectId?: string) {
  const r = object(await http.request(http.workspacePath(`/reminder-occurrences${projectId === undefined ? '' : `?project_id=${encodeURIComponent(projectId)}`}`)), 'reminder occurrences');
  const items = array(r, 'items', 'reminder occurrences').map(occurrenceFrom); if (projectId !== undefined && items.some((i) => i.projectId !== projectId)) throw new Error('提醒事项列表项目不匹配。'); return { items };
}
export async function getReminderOccurrence(http: RelayHttp, id: string) {
  const r = occurrenceFrom(await http.request(http.workspacePath(`/reminder-occurrences/${encodeURIComponent(id)}`))); if (r.occurrenceId !== id) throw new Error('提醒发生身份不匹配。'); return r;
}
export async function resolveReminderOccurrence(http: RelayHttp, input: RelayReminderResolution) {
  const e = commandEnvelopeFrom(await http.request(http.workspacePath(`/reminder-occurrences/${encodeURIComponent(input.occurrenceId)}/resolutions`), { method: 'POST', body: JSON.stringify({
    command_id: input.commandId, expected_revision: input.expectedRevision, action: input.action, reason: input.reason }) }, 200)); const r = object(e.result, 'reminder resolution');
  if (e.commandId !== input.commandId || r.occurrence_id !== input.occurrenceId) throw new Error('提醒处理回执与原命令/发生不匹配。');
  return { occurrenceId: input.occurrenceId, projectId: string(r, 'project_id', 'reminder resolution'), status: string(r, 'status', 'reminder resolution'), revision: decimal(r, 'revision', 'reminder resolution') };
}
export async function claimReminderNotifications(http: RelayHttp): Promise<RelayReminderNotification[]> {
  const r = object(await http.request(http.workspacePath('/project-reminders/notifications/claim'), { method: 'POST' }, 200), 'reminder notification claim');
  return array(r, 'items', 'reminder notification claim').map((v) => { const i = object(v, 'reminder notification'); return { occurrenceId: string(i, 'occurrence_id', 'reminder notification'),
    itemKey: string(i, 'item_key', 'reminder notification'), changeKey: string(i, 'change_key', 'reminder notification'), title: string(i, 'title', 'reminder notification'),
    reason: string(i, 'reason', 'reminder notification'), targetUrl: string(i, 'target_url', 'reminder notification') }; });
}
export async function settleReminderNotification(http: RelayHttp, item: RelayReminderNotification, status: 'DISPATCHED' | 'DENIED' | 'FAILED') {
  await http.request(http.workspacePath('/attention/notifications/settle'), { method: 'POST', body: JSON.stringify({ item_key: item.itemKey, change_key: item.changeKey, status }) }, 200);
}
