import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ScheduledTaskOccurrenceRow, ScheduledTaskRow, ScheduledTaskStatus } from '../planning/scheduled-task-repository.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { DomainError, invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { checkDeclaredOutputs } from './declared-output-requirements.js';
import { lockWritableProjectInWorkspace, readProjectInWorkspace, requireWorkspace } from './guards.js';
import { readAdmission } from './maintenance-admission.js';
import { prepareTaskCreation, createTask, type CreateTaskCriterionInput, type CreateTaskResult } from './create-task.js';
import { delegateTask } from './delegate-task.js';
import { requireRevision } from './revisions.js';
import { markTaskReady } from './task-commands.js';
import { scheduledTaskDispatchFailure } from './scheduled-task-admission.js';
import { freezeTaskChainExecution, requireTaskChainExecutionCurrent, taskChainDelegateExecution, type TaskChainExecutionInput, type TaskChainExecutionSpec } from './task-chain-execution.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';
import { advanceDueAt, isValidTimezone, localDateAt, parseLocalDate, parseLocalTime, resolveLocalDateTime, type RepeatRule } from './zoned-time.js';

type Scope = { workspaceId: string; commandId: string };

/** 授权上限：与 ADR-026 一致，最长 90 天。 */
const MAX_AUTHORIZATION_DAYS = 90;
const MAX_RUNS = 100;

export interface ScheduledTaskTemplateInput {
  readonly task_title: string;
  readonly objective: string;
  readonly criteria: readonly CreateTaskCriterionInput[];
  readonly expected_outputs: JsonObject;
  readonly mode: string;
}

const result = (row: ScheduledTaskRow) => ({
  scheduled_task_id: row.id,
  project_id: row.project_id,
  status: row.status,
  revision: row.revision.toString(),
  schedule_generation: row.schedule_generation.toString(),
  next_due_at: row.status === 'ENABLED' ? row.next_due_at.toISOString() : null,
});

export function requireText(value: string, field: string, max = 200): string {
  if (!value.trim() || value.length > max) throw validationFailed([{ field, message: `需要 1–${max} 字。` }]);
  return value.trim();
}

export function requireRule(value: RepeatRule): RepeatRule {
  if (value.kind === 'DAILY') {
    if (!Number.isInteger(value.interval_days) || value.interval_days < 1 || value.interval_days > 30) {
      throw validationFailed([{ field: 'repeat_rule', message: '按天重复需要 1–30 天的间隔。' }]);
    }
    return { kind: 'DAILY', interval_days: value.interval_days };
  }
  const weekdays = [...new Set(value.weekdays)].sort((a, b) => a - b);
  if (weekdays.length === 0 || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw validationFailed([{ field: 'repeat_rule', message: '按周重复需要 1–7 之间的星期几。' }]);
  }
  return { kind: 'WEEKLY', weekdays };
}

export function requireTimezone(value: string): string {
  if (!isValidTimezone(value)) throw validationFailed([{ field: 'timezone', message: '需要有效时区名称。' }]);
  return value;
}

export function requireLocalTime(value: string): string {
  try {
    parseLocalTime(value);
  } catch {
    throw validationFailed([{ field: 'local_time', message: '需要 HH:MM 形式的本地时刻。' }]);
  }
  return value;
}

export function requireLocalDate(value: string): { year: number; month: number; day: number } {
  try {
    return parseLocalDate(value);
  } catch {
    throw validationFailed([{ field: 'first_local_date', message: '需要 YYYY-MM-DD 形式且真实存在的日期。' }]);
  }
}

export function requireMaxRuns(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_RUNS) {
    throw validationFailed([{ field: 'max_runs', message: `执行次数上限需要 1–${MAX_RUNS}。` }]);
  }
  return value;
}

export function requireExpiry(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw validationFailed([{ field: 'authorization_expires_at', message: '需要明确 Z 或偏移量的实际时刻。' }]);
  }
  return new Date(value);
}

/**
 * 模板在创建时就按 CreateTask 的口径校验，避免等到首次触发才 422。
 * 规范化是确定性的（criterion_id 缺省按序号生成，不引入随机量），所以创建与编辑
 * 都在命令入口先算一次：同一结果既是落库模板，也是进入 payload_hash 的 body 字段。
 */
function requireTemplate(input: ScheduledTaskTemplateInput, workspaceId: string, commandId: string): JsonObject {
  const prepared = prepareTaskCreation({
    workspaceId,
    commandId,
    projectId: null,
    title: input.task_title,
    objective: input.objective,
    criteria: input.criteria,
    expectedOutputs: input.expected_outputs,
    mode: input.mode,
  });
  const declared = checkDeclaredOutputs({ requiredOutputSpec: input.expected_outputs });
  if (declared.status !== 'SATISFIED') {
    throw validationFailed([{ field: 'template.expected_outputs', message: '声明的产物要求当前无法判定。' }]);
  }
  return {
    task_title: prepared.title,
    objective: prepared.objective,
    criteria: prepared.criteria.map((criterion) => ({
      criterion_id: criterion.criterionId,
      statement: criterion.statement,
      required: criterion.required,
      method: criterion.method,
      target_spec: criterion.targetSpec,
    })),
    expected_outputs: input.expected_outputs,
    mode: prepared.mode,
  };
}

async function authority(r: Repositories, workspaceId: string): Promise<void> {
  if (await r.workspaces.lockAuthority(workspaceId, 'share') === undefined) throw resourceNotFound('Workspace');
}

async function audit(r: Repositories, input: Scope, row: ScheduledTaskRow, event: string): Promise<void> {
  await r.activities.insertActivityRecord({
    id: randomUUID(), workspaceId: input.workspaceId, projectId: row.project_id, taskId: null,
    actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId, eventType: event, factRefs: result(row),
  });
}

function configEvent(row: ScheduledTaskRow, commandId: string, reason: string): JsonObject {
  return {
    title: row.title, repeat_rule: row.repeat_rule, timezone: row.timezone, local_time: row.local_time,
    status: row.status, schedule_generation: row.schedule_generation.toString(), revision: row.revision.toString(),
    next_due_at: row.next_due_at.toISOString(), command_id: commandId, reason,
  };
}

export interface CreateScheduledTaskInput {
  readonly projectId: string;
  readonly title: string;
  readonly template: ScheduledTaskTemplateInput;
  readonly repeat: RepeatRule;
  readonly timezone: string;
  readonly localTime: string;
  readonly firstLocalDate: string;
  readonly maxRuns: number;
  readonly authorizationExpiresAt: string;
  readonly execution: TaskChainExecutionInput | undefined;
  readonly confirmed: true;
}

export async function createScheduledTask(db: DbExecutor, input: Scope & CreateScheduledTaskInput) {
  if (input.confirmed !== true) throw validationFailed([{ field: 'confirmed', message: '需要确认定时启动的实际时刻与授权。' }]);
  const title = requireText(input.title, 'title');
  const repeat = requireRule(input.repeat);
  const timezone = requireTimezone(input.timezone);
  const localTime = requireLocalTime(input.localTime);
  const firstLocalDate = requireLocalDate(input.firstLocalDate);
  const maxRuns = requireMaxRuns(input.maxRuns);
  const expiresAt = requireExpiry(input.authorizationExpiresAt);
  const template = requireTemplate(input.template, input.workspaceId, input.commandId);

  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'CreateScheduledTask',
    target: { project_id: input.projectId },
    body: {
      title, template, repeat_rule: repeat as unknown as JsonObject, timezone, local_time: localTime,
      first_local_date: input.firstLocalDate, max_runs: maxRuns,
      authorization_expires_at: expiresAt.toISOString(), confirmed: input.confirmed,
      execution: input.execution === undefined ? null : JSON.parse(JSON.stringify(input.execution)) as JsonObject,
    },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      await lockWritableProjectInWorkspace(r, input.workspaceId, input.projectId);
      const now = await r.scheduledTasks.now();
      const firstRunAt = resolveLocalDateTime(firstLocalDate, parseLocalTime(localTime), timezone);
      if (firstRunAt <= now) throw validationFailed([{ field: 'first_local_date', message: '首次触发必须在未来。' }]);
      const horizon = now.getTime() + MAX_AUTHORIZATION_DAYS * 86_400_000;
      if (expiresAt <= now || expiresAt.getTime() > horizon) {
        throw validationFailed([{ field: 'authorization_expires_at', message: `授权到期需在未来 ${MAX_AUTHORIZATION_DAYS} 天内。` }]);
      }
      const row = await r.scheduledTasks.insert({
        id: randomUUID(), workspace_id: input.workspaceId, project_id: input.projectId, title,
        template, repeat_rule: repeat as unknown as JsonObject, timezone, local_time: localTime,
        first_run_at: firstRunAt, next_due_at: firstRunAt, max_runs: maxRuns, authorization_expires_at: expiresAt,
        execution_input: input.execution === undefined ? {} : JSON.parse(JSON.stringify(input.execution)) as JsonObject,
        history: [{
          title, template, repeat_rule: repeat as unknown as JsonObject, timezone, local_time: localTime,
          first_run_at: firstRunAt.toISOString(), next_due_at: firstRunAt.toISOString(), status: 'ENABLED',
          schedule_generation: '1', revision: '1', max_runs: maxRuns, authorization_expires_at: expiresAt.toISOString(),
          command_id: input.commandId, reason: '用户确认周期定时启动授权',
        }],
      });
      await audit(r, input, row, 'SCHEDULED_TASK_CREATED');
      return result(row);
    },
  });
}

export interface EditScheduledTaskInput {
  readonly scheduledTaskId: string;
  readonly expectedRevision: string;
  readonly title: string;
  readonly template: ScheduledTaskTemplateInput;
  readonly repeat: RepeatRule;
  readonly timezone: string;
  readonly localTime: string;
  readonly firstLocalDate: string;
  readonly maxRuns: number;
  readonly authorizationExpiresAt: string;
  readonly execution: TaskChainExecutionInput | undefined;
  readonly confirmed: true;
  readonly reason: string;
}

export async function editScheduledTask(db: DbExecutor, input: Scope & EditScheduledTaskInput) {
  if (input.confirmed !== true) throw validationFailed([{ field: 'confirmed', message: '需要确认修改后的实际时刻。' }]);
  const title = requireText(input.title, 'title');
  const repeat = requireRule(input.repeat);
  const timezone = requireTimezone(input.timezone);
  const localTime = requireLocalTime(input.localTime);
  const firstLocalDate = requireLocalDate(input.firstLocalDate);
  const maxRuns = requireMaxRuns(input.maxRuns);
  const expiresAt = requireExpiry(input.authorizationExpiresAt);
  const reason = requireText(input.reason, 'reason', 4000);
  // 模板整体进入命令摘要（#148）：同一 command_id 换模板必须判成 ID 复用，不能返回旧回执。
  const template = requireTemplate(input.template, input.workspaceId, input.commandId);

  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'EditScheduledTask',
    target: { scheduled_task_id: input.scheduledTaskId },
    body: {
      expected_revision: input.expectedRevision, title, template, repeat_rule: repeat as unknown as JsonObject, timezone,
      local_time: localTime, first_local_date: input.firstLocalDate, max_runs: maxRuns,
      authorization_expires_at: expiresAt.toISOString(), confirmed: input.confirmed, reason,
      execution: input.execution === undefined ? null : JSON.parse(JSON.stringify(input.execution)) as JsonObject,
    },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      const row = await r.scheduledTasks.read(input.scheduledTaskId, true);
      if (row?.workspace_id !== input.workspaceId) throw resourceNotFound('ScheduledTask');
      await lockWritableProjectInWorkspace(r, input.workspaceId, row.project_id);
      if (row.revision !== requireRevision(input.expectedRevision, 'expected_revision')) {
        throw revisionConflict({ entityType: 'SCHEDULED_TASK', expectedRevision: input.expectedRevision, actualRevision: row.revision.toString() });
      }
      // EXPIRED 允许编辑（#149）：HTTP 契约 10.94「到期与预算耗尽」要求先通过编辑延长授权，
      // 编辑本身就是那个入口；编辑后状态保持 EXPIRED，是否恢复启用由用户显式决定。

      const now = await r.scheduledTasks.now();
      const horizon = now.getTime() + MAX_AUTHORIZATION_DAYS * 86_400_000;
      if (expiresAt <= now || expiresAt.getTime() > horizon) {
        throw validationFailed([{ field: 'authorization_expires_at', message: `授权到期需在未来 ${MAX_AUTHORIZATION_DAYS} 天内。` }]);
      }
      const firstRunAt = resolveLocalDateTime(firstLocalDate, parseLocalTime(localTime), timezone);

      // 只有影响排期的字段变化才提升代次：改标题或模板不该让已排定的发生作废。
      const scheduleChanged = row.timezone !== timezone || row.local_time !== localTime
        || JSON.stringify(row.repeat_rule) !== JSON.stringify(repeat)
        || row.first_run_at.getTime() !== firstRunAt.getTime();
      const nextDueAt = row.status === 'ENABLED'
        ? advanceDueAt({ rule: repeat, timezone, localTime, now, anchor: firstRunAt })
        : row.next_due_at;

      const updated = await r.scheduledTasks.update({
        ...row, title, template, repeat_rule: repeat as unknown as JsonObject, timezone, local_time: localTime,
        first_run_at: firstRunAt, max_runs: maxRuns, authorization_expires_at: expiresAt,
        execution_input: input.execution === undefined ? {} : JSON.parse(JSON.stringify(input.execution)) as JsonObject,
        schedule_generation: scheduleChanged ? row.schedule_generation + 1n : row.schedule_generation,
      }, nextDueAt, configEvent({
        ...row, title, template, repeat_rule: repeat as unknown as JsonObject, timezone, local_time: localTime,
        first_run_at: firstRunAt, max_runs: maxRuns, authorization_expires_at: expiresAt,
        schedule_generation: scheduleChanged ? row.schedule_generation + 1n : row.schedule_generation,
        revision: row.revision + 1n,
      }, input.commandId, reason));
      await audit(r, input, updated, 'SCHEDULED_TASK_EDITED');
      return result(updated);
    },
  });
}

export interface SetScheduledTaskStatusInput {
  readonly scheduledTaskId: string;
  readonly expectedRevision: string;
  readonly status: 'ENABLED' | 'PAUSED' | 'DISABLED';
  readonly reason: string;
}

export async function setScheduledTaskStatus(db: DbExecutor, input: Scope & SetScheduledTaskStatusInput) {
  const reason = requireText(input.reason, 'reason', 4000);
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'SetScheduledTaskStatus',
    target: { scheduled_task_id: input.scheduledTaskId },
    body: { expected_revision: input.expectedRevision, status: input.status, reason },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      const row = await r.scheduledTasks.read(input.scheduledTaskId, true);
      if (row?.workspace_id !== input.workspaceId) throw resourceNotFound('ScheduledTask');
      await lockWritableProjectInWorkspace(r, input.workspaceId, row.project_id);
      if (row.revision !== requireRevision(input.expectedRevision, 'expected_revision')) {
        throw revisionConflict({ entityType: 'SCHEDULED_TASK', expectedRevision: input.expectedRevision, actualRevision: row.revision.toString() });
      }
      // EXPIRED 不能直接改回 ENABLED（契约 10.94：须先通过编辑延长授权）。到期或预算耗尽的
      // 原因在编辑解除前会一直成立，所以这里按「原因是否已由编辑解除」判定，而不是无条件拒绝。
      const now = await r.scheduledTasks.now();
      if (row.status === 'EXPIRED' && input.status === 'ENABLED'
        && (row.authorization_expires_at <= now || row.runs_started >= row.max_runs)) {
        throw invalidTransition('已到期的定时任务需要先通过编辑延长授权有效期（或恢复执行次数预算），不能直接重新启用。');
      }
      if (row.status === input.status) throw invalidTransition('状态没有变化，请读回当前结果。');

      // 重新启用时把已过去的时刻推到下一个未来时段，避免一开启就补跑关闭期间的多次。
      const nextDueAt = input.status === 'ENABLED'
        ? advanceDueAt({ rule: row.repeat_rule as unknown as RepeatRule, timezone: row.timezone, localTime: row.local_time, now, anchor: row.first_run_at })
        : row.next_due_at;
      const updated = await r.scheduledTasks.setStatus(row.id, input.status, nextDueAt, {
        status: input.status, revision: (row.revision + 1n).toString(), next_due_at: nextDueAt.toISOString(),
        command_id: input.commandId, reason,
      });
      await audit(r, input, updated, 'SCHEDULED_TASK_STATUS_CHANGED');
      return result(updated);
    },
  });
}

export interface ResolveOccurrenceInput {
  readonly occurrenceId: string;
  readonly expectedRevision: string;
  readonly action: 'RETRY' | 'DISMISS';
  readonly reason: string;
}

export async function resolveScheduledTaskOccurrence(db: DbExecutor, input: Scope & ResolveOccurrenceInput) {
  const reason = requireText(input.reason, 'reason', 4000);
  return runIdempotentCommand(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId, commandType: 'ResolveScheduledTaskOccurrence',
    target: { occurrence_id: input.occurrenceId },
    body: { expected_revision: input.expectedRevision, action: input.action, reason },
    execute: async (r) => {
      await authority(r, input.workspaceId);
      const occurrence = await r.scheduledTasks.readOccurrence(input.occurrenceId, true);
      if (occurrence?.workspace_id !== input.workspaceId) throw resourceNotFound('ScheduledTaskOccurrence');
      if (occurrence.revision !== requireRevision(input.expectedRevision, 'expected_revision')) {
        throw revisionConflict({ entityType: 'SCHEDULED_TASK_OCCURRENCE', expectedRevision: input.expectedRevision, actualRevision: occurrence.revision.toString() });
      }
      if (occurrence.status !== 'BLOCKED') throw invalidTransition('只有待处理的触发才能补跑或忽略。');
      // 补跑前准入（P0-A）：必然不可执行的触发在命令事务内拒绝，不重开发生，
      // 也就不会走到「先建 Task 再在 Delegate 被拒」的无意义路径。
      if (input.action === 'RETRY') {
        const failure = await scheduledTaskDispatchFailure(r, input.workspaceId, occurrence);
        if (failure !== undefined) throw invalidTransition(`这次触发当前不能补跑：${failure.message}`);
      }

      const updated = input.action === 'RETRY'
        ? await r.scheduledTasks.reopen(occurrence.id)
        : await r.scheduledTasks.resolve(occurrence.id, 'RESOLVED', reason);
      if (updated === undefined) throw invalidTransition('这次触发已经不在待处理状态。');
      await r.activities.insertActivityRecord({
        id: randomUUID(), workspaceId: input.workspaceId, projectId: occurrence.project_id, taskId: null,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF, commandId: input.commandId, eventType: 'SCHEDULED_TASK_OCCURRENCE_RESOLVED',
        factRefs: { occurrence_id: occurrence.id, action: input.action },
      });
      return { occurrence_id: occurrence.id, scheduled_task_id: occurrence.scheduled_task_id, status: updated.status, revision: updated.revision.toString() };
    },
  });
}

const occurrenceView = (row: ScheduledTaskOccurrenceRow) => ({
  occurrence_id: row.id, scheduled_task_id: row.scheduled_task_id, project_id: row.project_id,
  schedule_generation: row.schedule_generation.toString(), sequence: row.sequence.toString(),
  due_at: row.due_at.toISOString(), timezone: row.timezone, missed: row.missed, status: row.status,
  task_id: row.task_id, run_id: row.run_id, reason: row.reason, revision: row.revision.toString(),
  created_at: row.created_at.toISOString(),
});

const taskView = (row: ScheduledTaskRow) => ({
  ...result(row), title: row.title, template: row.template, repeat_rule: row.repeat_rule, timezone: row.timezone,
  local_time: row.local_time, first_run_at: row.first_run_at.toISOString(),
  max_runs: row.max_runs, runs_reserved: row.runs_reserved, runs_started: row.runs_started,
  authorization_expires_at: row.authorization_expires_at.toISOString(), history: row.history,
  created_at: row.created_at.toISOString(),
});

export async function readScheduledTask(db: DbExecutor, workspaceId: string, id: string) {
  return withTransaction(db, async (r) => {
    const row = await r.scheduledTasks.read(id);
    if (row?.workspace_id !== workspaceId) throw resourceNotFound('ScheduledTask');
    const project = await readProjectInWorkspace(r, workspaceId, row.project_id);
    return {
      ...taskView(row),
      project: { title: project.title, revision: project.revision.toString(), archived: project.archived_at !== null },
      occurrences: (await r.scheduledTasks.occurrences(id)).map(occurrenceView),
      // 最近 20 条窗口之外可能还有未处理的 BLOCKED；不单独返回就会丢失补跑/忽略入口。
      pending_occurrences: (await r.scheduledTasks.blockedOccurrences(id)).map(occurrenceView),
    };
  });
}

export async function listScheduledTasks(db: DbExecutor, workspaceId: string, projectId?: string) {
  return withTransaction(db, async (r) => {
    await requireWorkspace(r, workspaceId);
    if (projectId !== undefined) await readProjectInWorkspace(r, workspaceId, projectId);
    const items = [];
    for (const row of await r.scheduledTasks.list(workspaceId, projectId)) {
      const project = await readProjectInWorkspace(r, row.workspace_id, row.project_id);
      items.push({
        ...taskView(row),
        project: { title: project.title, revision: project.revision.toString(), archived: project.archived_at !== null },
      });
    }
    return { project_id: projectId ?? null, items };
  });
}

/**
 * 每 tick 的扫描：先清「待分发」（崩溃残留与人工补跑），再处理到期时段。
 *
 * 与 N05 提醒的关键差别：提醒只落待处理，这里会真正新建 Task 并启动；因此每条准入
 * 都要在事务内裁决，失败也必须落一条 occurrence 说明原因，不能静默跳过。
 */
export async function scanScheduledTasks(db: DbExecutor, openedAt: Date): Promise<string[]> {
  const dispatch: string[] = [];
  for (const workspaceId of await createRepositories(db).scheduledTasks.dueWorkspaces()) {
    const created = await withTransaction(db, async (r) => {
      if ((await readAdmission(r, 'share')).mode !== 'NORMAL') return [];
      await authority(r, workspaceId);
      const now = await r.scheduledTasks.now();
      const ids: string[] = [];

      for (const pending of await r.scheduledTasks.pendingDispatch(workspaceId)) ids.push(pending.id);

      for (const row of await r.scheduledTasks.due(workspaceId, now)) {
        const project = await r.projects.lockProjectArchiveGate(row.project_id);
        if (project?.archived_at !== null) continue;

        const nextDueAt = advanceDueAt({
          rule: row.repeat_rule as unknown as RepeatRule, timezone: row.timezone,
          localTime: row.local_time, now, anchor: row.first_run_at,
        });
        // 先推进时段再落发生：推进失败说明状态已被暂停/停用，本轮不该再产生任何事实。
        const advanced = await r.scheduledTasks.advanceSlot(row.id, nextDueAt);
        if (advanced === undefined) continue;

        const occurrenceBase = {
          id: randomUUID(), scheduled_task_id: row.id, workspace_id: row.workspace_id, project_id: row.project_id,
          schedule_generation: row.schedule_generation, sequence: BigInt(advanced.runs_reserved),
          due_at: row.next_due_at, timezone: row.timezone, missed: row.next_due_at < openedAt,
          create_command_id: randomUUID(), ready_command_id: randomUUID(), delegate_command_id: randomUUID(),
          // 发生时配置冻结（P0-A）：模板与执行意图随发生落库，之后的编辑只影响未来时段。
          frozen_template: row.template, frozen_execution_input: row.execution_input,
        };

        if (row.runs_started >= row.max_runs) {
          await r.scheduledTasks.insertOccurrence(occurrenceBase, 'BLOCKED', 'BUDGET_EXHAUSTED');
          await r.scheduledTasks.setStatus(row.id, 'EXPIRED', nextDueAt, { reason: 'BUDGET_EXHAUSTED', next_due_at: nextDueAt.toISOString() });
          continue;
        }
        if (row.authorization_expires_at <= now) {
          await r.scheduledTasks.insertOccurrence(occurrenceBase, 'BLOCKED', 'AUTHORIZATION_EXPIRED');
          await r.scheduledTasks.setStatus(row.id, 'EXPIRED', nextDueAt, { reason: 'AUTHORIZATION_EXPIRED', next_due_at: nextDueAt.toISOString() });
          continue;
        }

        // 应用关闭期间错过的时段不自动执行：只留一条待处理，由用户决定是否补跑。
        // 先判错过再判「上一轮未验收」：关闭期间无法观测上一轮状态，用错过解释更准确。
        if (occurrenceBase.missed) {
          await r.scheduledTasks.insertOccurrence(occurrenceBase, 'BLOCKED', 'MISSED');
          continue;
        }

        // 串行准入看真实存在的 Task（#147）：无 task_id 的 SKIPPED/BLOCKED/RESOLVED 发生
        // 不产生任务，不能遮住仍未验收的上一轮——上一条 occurrence 是什么状态无关紧要，
        // 只要本计划还有未终态（DONE/CANCELLED）的 Task，本轮就继续跳过，不堆出第二个任务。
        if ((await r.scheduledTasks.unfinishedBoundTaskIds(row.id)).length > 0) {
          await r.scheduledTasks.insertOccurrence(occurrenceBase, 'SKIPPED', 'PREVIOUS_TASK_NOT_ACCEPTED');
          continue;
        }

        const inserted = await r.scheduledTasks.insertOccurrence(occurrenceBase, 'DISPATCHING');
        if (inserted !== undefined) ids.push(inserted.id);
      }
      return ids;
    });
    dispatch.push(...created);
  }
  return dispatch;
}

function reasonOf(error: unknown): string {
  if (error instanceof DomainError) return `${error.code}: ${error.detail}`;
  return error instanceof Error ? error.name : 'DISPATCH_FAILED';
}

/**
 * 执行一次触发：新建 Task → 冻结执行范围 → 标记就绪 → 委托。
 *
 * 三步命令的身份都在 occurrence 落库时预生成，所以中途崩溃后重跑靠回执重放，
 * 不会重复建 Task；`expected_task_revision` 只能取自前一步回执，读库重算会让
 * payload_hash 变化并被判成 CommandIdReused。
 *
 * 重跑的载荷一律来自已持久化的原事实，不从当前可变配置重算：
 *   * 模板与执行意图在发生落库时冻结（frozen_template / frozen_execution_input，P0-A）——
 *     分发中断后用户编辑模板，未提交的 CreateTask 也不得读到新模板；已提交过的
 *     CreateTask 则取原回执结果（#150），两条路径都不把编辑后的当前配置与原命令身份拼接；
 *   * 执行范围复用 occurrence 上已冻结的 frozen_execution，只有首次才按当时状态冻结；
 *     恢复时旧冻结依据必须仍与当前事实一致（requireTaskChainExecutionCurrent），
 *     资料/资源/连接漂移就让这次 BLOCKED，不重算覆盖（#151）。
 * CreateTask 未提交前先做一次快照准入：必然不可执行的触发不建 Task 直接落 BLOCKED（P0-A）。
 * 上一轮 Task 终态由 Delegate 原事务内的准入复核（ADR-026），扫描只负责给跳过原因。
 */
export async function dispatchScheduledOccurrence(db: DbExecutor, occurrenceId: string): Promise<void> {
  const occurrence = await withTransaction(db, async (r) => r.scheduledTasks.readOccurrence(occurrenceId));
  if (occurrence === undefined || occurrence.status !== 'DISPATCHING') return;
  const schedule = await withTransaction(db, async (r) => r.scheduledTasks.read(occurrence.scheduled_task_id));
  if (schedule === undefined) {
    await withTransaction(db, async (r) => { await r.scheduledTasks.markSettled(occurrenceId, 'BLOCKED', 'SCHEDULE_UNAVAILABLE'); });
    return;
  }

  try {
    // 已提交过的 CreateTask 以原回执为准：重放原结果，与模板是否被编辑无关。
    const priorCreate = await withTransaction(db, async (r) => r.receipts.findReceipt({
      scopeKey: httpCommandScopeKey(occurrence.workspace_id), commandId: occurrence.create_command_id,
    }));
    if (priorCreate === undefined) {
      // CreateTask 未提交前先做快照准入（P0-A）：必然不可执行的触发不得先建 Task。
      // 并发窗口内的状态变化仍由 Delegate 原事务内准入兜底，契约的「已知中间态」收窄到那。
      const failure = await withTransaction(db, async (r) =>
        scheduledTaskDispatchFailure(r, occurrence.workspace_id, occurrence));
      if (failure !== undefined) {
        await withTransaction(db, async (r) => {
          await r.scheduledTasks.markSettled(occurrenceId, 'BLOCKED', failure.reason);
        });
        return;
      }
    }
    // 载荷一律来自发生时冻结的副本（P0-A）；迁移 0138 前的旧行保持 '{}'，回落计划当前值。
    const template = Object.keys(occurrence.frozen_template).length > 0 ? occurrence.frozen_template : schedule.template;
    const executionInput = Object.keys(occurrence.frozen_execution_input).length > 0
      ? occurrence.frozen_execution_input : schedule.execution_input;
    const created: CommandOutcome<CreateTaskResult> = priorCreate === undefined
      ? await createTask(db, {
          workspaceId: occurrence.workspace_id,
          commandId: occurrence.create_command_id,
          projectId: occurrence.project_id,
          title: String(template.task_title),
          objective: String(template.objective),
          criteria: (template.criteria ?? []) as unknown as readonly CreateTaskCriterionInput[],
          expectedOutputs: (template.expected_outputs ?? {}) as JsonObject,
          mode: String(template.mode),
        })
      : { result: priorCreate.result_ref as CreateTaskResult, replayed: true, committedAt: priorCreate.created_at };
    const taskId = created.result.task_id;
    await withTransaction(db, async (r) => { await r.scheduledTasks.bindTask(occurrenceId, taskId); });

    // 执行范围按触发当时的状态冻结：连接/资料/资源漂移就让这一次失败，不静默降级。
    // 已冻结的依据直接复用，重算会改变 Delegate 载荷并破坏 ready/delegate 的回执重放。
    // 首次冻结的输入意图同样取发生时冻结的副本（P0-A），编辑只影响未来时段。
    const frozen: TaskChainExecutionSpec = Object.keys(occurrence.frozen_execution).length === 0
      ? await withTransaction(db, async (r) => {
          const spec = await freezeTaskChainExecution(
            r, occurrence.workspace_id, occurrence.project_id, taskId,
            Object.keys(executionInput).length === 0 ? undefined : executionInput as unknown as TaskChainExecutionInput,
          );
          await r.scheduledTasks.freezeExecution(occurrenceId, spec);
          return spec;
        })
      : await withTransaction(db, async (r) => {
          // 恢复分发（#151）：已有冻结依据必须先核对是否仍然 CURRENT，漂移就让这次
          // BLOCKED——不重算、不覆盖原快照，重写会抹掉漂移证据并绕过契约要求的漂移阻断。
          const spec = occurrence.frozen_execution as unknown as TaskChainExecutionSpec;
          await requireTaskChainExecutionCurrent(r, occurrence.workspace_id, occurrence.project_id, spec, taskId);
          return spec;
        });

    const ready = await markTaskReady(db, {
      workspaceId: occurrence.workspace_id, taskId,
      commandId: occurrence.ready_command_id, expectedRevision: created.result.revision,
    });
    const delegated = await delegateTask(db, {
      workspaceId: occurrence.workspace_id, taskId,
      commandId: occurrence.delegate_command_id, expectedTaskRevision: ready.result.revision,
      scheduledTaskBinding: {
        occurrenceId: occurrence.id, scheduledTaskId: schedule.id,
        scheduleGeneration: occurrence.schedule_generation.toString(),
      },
      ...taskChainDelegateExecution(frozen, schedule.authorization_expires_at),
    });
    // 完成标记只在 DISPATCHING → DISPATCHED 真正发生时计数（P0-A）：另一个分发路径
    // 已完成同一发生时这里拿到 undefined，跳过 markStarted，runs_started 不重复累计。
    await withTransaction(db, async (r) => {
      const completed = await r.scheduledTasks.markDispatched(occurrenceId, taskId, delegated.result.run_id);
      if (completed !== undefined) await r.scheduledTasks.markStarted(schedule.id);
    });
  } catch (error) {
    await withTransaction(db, async (r) => {
      await r.scheduledTasks.markSettled(occurrenceId, 'BLOCKED', reasonOf(error));
    });
  }
}

/** 调度器入口：扫描后逐条分发。分发失败已由 dispatchScheduledOccurrence 落成 BLOCKED。 */
export async function runScheduledTaskTick(db: DbExecutor, openedAt: Date): Promise<number> {
  const ids = await scanScheduledTasks(db, openedAt);
  for (const id of ids) await dispatchScheduledOccurrence(db, id);
  return ids.length;
}

export function describeLocalDue(row: ScheduledTaskRow): { localDate: string; localTime: string } {
  const date = localDateAt(row.next_due_at, row.timezone);
  return { localDate: `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`, localTime: row.local_time };
}

export type { ScheduledTaskStatus };
