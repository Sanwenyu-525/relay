import { RelayHttp } from '../core/http';
import { array, boolean, decimal, integer, isRecord, nullableString, object, string } from '../core/primitives';
import { commandEnvelopeFrom } from '../parse/projects';
import type {
  RelayScheduledTask, RelayScheduledTaskCreate, RelayScheduledTaskDetail, RelayScheduledTaskEdit,
  RelayScheduledTaskOccurrence, RelayScheduledTaskOccurrenceResolution, RelayScheduledTaskOccurrenceStatus,
  RelayScheduledTaskRepeat, RelayScheduledTaskResult, RelayScheduledTaskStatus, RelayScheduledTaskStatusInput,
  RelayScheduledTaskTemplate,
} from '../dtos/scheduledTasks';

const OCCURRENCE_STATUSES: readonly RelayScheduledTaskOccurrenceStatus[] =
  ['DISPATCHING', 'DISPATCHED', 'BLOCKED', 'SKIPPED', 'RESOLVED'];
const STATUSES: readonly RelayScheduledTaskStatus[] = ['ENABLED', 'PAUSED', 'DISABLED', 'EXPIRED'];

function statusFrom(value: string, name: string): RelayScheduledTaskStatus {
  if (!STATUSES.includes(value as RelayScheduledTaskStatus)) throw new Error(`${name} 包含未知状态。`);
  return value as RelayScheduledTaskStatus;
}

function repeatFrom(value: unknown): RelayScheduledTaskRepeat {
  const rule = object(value, 'scheduled task repeat');
  const kind = string(rule, 'kind', 'scheduled task repeat');
  if (kind === 'DAILY') return { kind: 'DAILY', intervalDays: integer(rule, 'interval_days', 'scheduled task repeat') };
  if (kind === 'WEEKLY') {
    const weekdays = array(rule, 'weekdays', 'scheduled task repeat').map((day) => {
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7) {
        throw new Error('scheduled task repeat.weekdays 响应格式无效。');
      }
      return day;
    });
    return { kind: 'WEEKLY', weekdays };
  }
  throw new Error('scheduled task repeat.kind 无法识别。');
}

function templateFrom(value: unknown): RelayScheduledTaskTemplate {
  const template = object(value, 'scheduled task template');
  const mode = string(template, 'mode', 'scheduled task template');
  if (mode !== 'ME' && mode !== 'AI_ASSIST') throw new Error('scheduled task template.mode 无法识别。');
  const criteria = array(template, 'criteria', 'scheduled task template').map((item) => {
    if (typeof item === 'string') return item;
    if (isRecord(item) && typeof item.statement === 'string') return item.statement;
    throw new Error('scheduled task template.criteria 响应格式无效。');
  });
  return {
    taskTitle: string(template, 'task_title', 'scheduled task template'),
    objective: string(template, 'objective', 'scheduled task template'),
    criteria, mode,
  };
}

function resultFrom(value: unknown): RelayScheduledTaskResult {
  const row = object(value, 'scheduled task result');
  return {
    scheduledTaskId: string(row, 'scheduled_task_id', 'scheduled task result'),
    projectId: string(row, 'project_id', 'scheduled task result'),
    status: statusFrom(string(row, 'status', 'scheduled task result'), 'scheduled task result'),
    revision: decimal(row, 'revision', 'scheduled task result'),
    scheduleGeneration: decimal(row, 'schedule_generation', 'scheduled task result'),
    nextDueAt: nullableString(row, 'next_due_at', 'scheduled task result'),
  };
}

function projectFrom(value: unknown) {
  const project = object(value, 'scheduled task project');
  return {
    title: string(project, 'title', 'scheduled task project'),
    revision: decimal(project, 'revision', 'scheduled task project'),
    archived: boolean(project, 'archived', 'scheduled task project'),
  };
}

function taskFrom(value: unknown): RelayScheduledTask {
  const row = object(value, 'scheduled task');
  return {
    ...resultFrom(row),
    title: string(row, 'title', 'scheduled task'),
    template: templateFrom(row.template),
    repeat: repeatFrom(row.repeat_rule),
    timezone: string(row, 'timezone', 'scheduled task'),
    localTime: string(row, 'local_time', 'scheduled task'),
    firstRunAt: string(row, 'first_run_at', 'scheduled task'),
    maxRuns: integer(row, 'max_runs', 'scheduled task'),
    runsStarted: integer(row, 'runs_started', 'scheduled task'),
    authorizationExpiresAt: string(row, 'authorization_expires_at', 'scheduled task'),
    createdAt: string(row, 'created_at', 'scheduled task'),
    ...(row.project === undefined ? {} : { project: projectFrom(row.project) }),
  };
}

function occurrenceFrom(value: unknown): RelayScheduledTaskOccurrence {
  const row = object(value, 'scheduled task occurrence');
  const status = string(row, 'status', 'scheduled task occurrence');
  if (!OCCURRENCE_STATUSES.includes(status as RelayScheduledTaskOccurrenceStatus)) {
    throw new Error('scheduled task occurrence.status 无法识别。');
  }
  return {
    occurrenceId: string(row, 'occurrence_id', 'scheduled task occurrence'),
    scheduledTaskId: string(row, 'scheduled_task_id', 'scheduled task occurrence'),
    projectId: string(row, 'project_id', 'scheduled task occurrence'),
    sequence: decimal(row, 'sequence', 'scheduled task occurrence'),
    dueAt: string(row, 'due_at', 'scheduled task occurrence'),
    timezone: string(row, 'timezone', 'scheduled task occurrence'),
    missed: boolean(row, 'missed', 'scheduled task occurrence'),
    status: status as RelayScheduledTaskOccurrenceStatus,
    taskId: nullableString(row, 'task_id', 'scheduled task occurrence'),
    runId: nullableString(row, 'run_id', 'scheduled task occurrence'),
    reason: nullableString(row, 'reason', 'scheduled task occurrence'),
    revision: decimal(row, 'revision', 'scheduled task occurrence'),
    createdAt: string(row, 'created_at', 'scheduled task occurrence'),
  };
}

function bodyFrom(input: RelayScheduledTaskCreate): Record<string, unknown> {
  return {
    title: input.title,
    template: {
      task_title: input.template.taskTitle,
      objective: input.template.objective,
      mode: input.template.mode,
      criteria: input.template.criteria.map((statement) => ({ statement })),
    },
    repeat_rule: input.repeat.kind === 'DAILY'
      ? { kind: 'DAILY', interval_days: input.repeat.intervalDays }
      : { kind: 'WEEKLY', weekdays: [...input.repeat.weekdays] },
    timezone: input.timezone,
    local_time: input.localTime,
    first_local_date: input.firstLocalDate,
    max_runs: input.maxRuns,
    authorization_expires_at: input.authorizationExpiresAt,
    confirmed: input.confirmed,
  };
}

async function submit(http: RelayHttp, path: string, commandId: string, body: Record<string, unknown>, status: 200 | 201, id?: string) {
  const envelope = commandEnvelopeFrom(await http.request(path, { method: 'POST', body: JSON.stringify({ command_id: commandId, ...body }) }, status));
  const result = resultFrom(envelope.result);
  if (envelope.commandId !== commandId || (id !== undefined && result.scheduledTaskId !== id)) {
    throw new Error('定时任务回执与原命令/对象不匹配。');
  }
  return result;
}

export async function createScheduledTask(http: RelayHttp, input: RelayScheduledTaskCreate) {
  const result = await submit(http, http.workspacePath(`/projects/${encodeURIComponent(input.projectId)}/scheduled-tasks`), input.commandId, bodyFrom(input), 201);
  if (result.projectId !== input.projectId) throw new Error('定时任务创建回执与项目不匹配。');
  return result;
}

export function editScheduledTask(http: RelayHttp, input: RelayScheduledTaskEdit) {
  return submit(http, http.workspacePath(`/scheduled-tasks/${encodeURIComponent(input.scheduledTaskId)}/edits`), input.commandId,
    { expected_revision: input.expectedRevision, ...bodyFrom(input), reason: input.reason }, 200, input.scheduledTaskId);
}

export function setScheduledTaskStatus(http: RelayHttp, input: RelayScheduledTaskStatusInput) {
  return submit(http, http.workspacePath(`/scheduled-tasks/${encodeURIComponent(input.scheduledTaskId)}/status-changes`), input.commandId,
    { expected_revision: input.expectedRevision, status: input.status, reason: input.reason }, 200, input.scheduledTaskId);
}

export async function resolveScheduledTaskOccurrence(http: RelayHttp, input: RelayScheduledTaskOccurrenceResolution) {
  const envelope = commandEnvelopeFrom(await http.request(
    http.workspacePath(`/scheduled-task-occurrences/${encodeURIComponent(input.occurrenceId)}/resolutions`),
    { method: 'POST', body: JSON.stringify({ command_id: input.commandId, expected_revision: input.expectedRevision, action: input.action, reason: input.reason }) }, 200));
  const row = object(envelope.result, 'scheduled task occurrence resolution');
  if (envelope.commandId !== input.commandId || row.occurrence_id !== input.occurrenceId) {
    throw new Error('定时任务触发处理回执与原命令/发生不匹配。');
  }
  return { occurrenceId: input.occurrenceId, status: string(row, 'status', 'scheduled task occurrence resolution'), revision: decimal(row, 'revision', 'scheduled task occurrence resolution') };
}

export async function getScheduledTasks(http: RelayHttp, projectId?: string) {
  const query = projectId === undefined ? '' : `?project_id=${encodeURIComponent(projectId)}`;
  const payload = object(await http.request(http.workspacePath(`/scheduled-tasks${query}`)), 'scheduled task list');
  const items = array(payload, 'items', 'scheduled task list').map(taskFrom);
  if (projectId !== undefined && items.some((item) => item.projectId !== projectId)) {
    throw new Error('定时任务列表项目不匹配。');
  }
  return items;
}

export async function getScheduledTask(http: RelayHttp, id: string): Promise<RelayScheduledTaskDetail> {
  const row = object(await http.request(http.workspacePath(`/scheduled-tasks/${encodeURIComponent(id)}`)), 'scheduled task');
  const base = taskFrom(row);
  if (base.scheduledTaskId !== id) throw new Error('定时任务身份不匹配。');
  return {
    ...base,
    project: projectFrom(row.project),
    occurrences: array(row, 'occurrences', 'scheduled task').map(occurrenceFrom),
    // 旧服务端可能不带该字段；缺失按空处理，不阻塞详情读取。
    ...(row.pending_occurrences === undefined ? { pendingOccurrences: [] as RelayScheduledTaskOccurrence[] }
      : { pendingOccurrences: array(row, 'pending_occurrences', 'scheduled task').map(occurrenceFrom) }),
  };
}
