import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

export type ScheduledTaskStatus = 'ENABLED' | 'PAUSED' | 'DISABLED' | 'EXPIRED';
export type OccurrenceStatus = 'DISPATCHING' | 'DISPATCHED' | 'BLOCKED' | 'SKIPPED' | 'RESOLVED';

export interface ScheduledTaskRow {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  template: JsonObject;
  repeat_rule: JsonObject;
  timezone: string;
  local_time: string;
  first_run_at: Date;
  next_due_at: Date;
  status: ScheduledTaskStatus;
  schedule_generation: bigint;
  revision: bigint;
  max_runs: number;
  runs_reserved: number;
  runs_started: number;
  authorization_expires_at: Date;
  execution_input: JsonObject;
  history: JsonObject[];
  created_at: Date;
}

export interface ScheduledTaskOccurrenceRow {
  id: string;
  scheduled_task_id: string;
  workspace_id: string;
  project_id: string;
  schedule_generation: bigint;
  sequence: bigint;
  due_at: Date;
  timezone: string;
  missed: boolean;
  status: OccurrenceStatus;
  task_id: string | null;
  run_id: string | null;
  create_command_id: string;
  ready_command_id: string;
  delegate_command_id: string;
  frozen_execution: JsonObject;
  reason: string | null;
  revision: bigint;
  created_at: Date;
}

export interface OccurrenceInsert {
  readonly id: string;
  readonly scheduled_task_id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly schedule_generation: bigint;
  readonly sequence: bigint;
  readonly due_at: Date;
  readonly timezone: string;
  readonly missed: boolean;
  readonly create_command_id: string;
  readonly ready_command_id: string;
  readonly delegate_command_id: string;
}

/**
 * 定时任务的两张表不进 `RelayDatabaseSchema`：与 `project_reminders` / `task_chains` 同例，
 * 用原生 SQL 自带 Row 接口，避免把计划表混进核心 Kysely 类型面。
 */
export class ScheduledTaskRepository {
  constructor(private readonly db: DbExecutor) {}

  async now(): Promise<Date> {
    return (await sql<{ time: Date }>`select clock_timestamp() as time`.execute(this.db)).rows[0]!.time;
  }

  async insert(row: Pick<ScheduledTaskRow,
    'id' | 'workspace_id' | 'project_id' | 'title' | 'template' | 'repeat_rule' | 'timezone' | 'local_time'
    | 'first_run_at' | 'next_due_at' | 'max_runs' | 'authorization_expires_at' | 'execution_input' | 'history'>): Promise<ScheduledTaskRow> {
    return (await sql<ScheduledTaskRow>`insert into scheduled_tasks
      (id, workspace_id, project_id, title, template, repeat_rule, timezone, local_time, first_run_at, next_due_at,
       max_runs, authorization_expires_at, execution_input, history)
      values (${row.id}, ${row.workspace_id}, ${row.project_id}, ${row.title}, ${JSON.stringify(row.template)}::jsonb,
        ${JSON.stringify(row.repeat_rule)}::jsonb, ${row.timezone}, ${row.local_time}, ${row.first_run_at}, ${row.next_due_at},
        ${row.max_runs}, ${row.authorization_expires_at}, ${JSON.stringify(row.execution_input)}::jsonb,
        ${JSON.stringify(row.history)}::jsonb)
      returning *`.execute(this.db)).rows[0]!;
  }

  async read(id: string, lock = false): Promise<ScheduledTaskRow | undefined> {
    return (await sql<ScheduledTaskRow>`select * from scheduled_tasks where id = ${id}
      ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }

  async list(workspaceId: string, projectId?: string): Promise<ScheduledTaskRow[]> {
    return (await sql<ScheduledTaskRow>`select * from scheduled_tasks where workspace_id = ${workspaceId}
      ${projectId === undefined ? sql`` : sql`and project_id = ${projectId}`}
      order by created_at desc, id desc`.execute(this.db)).rows;
  }

  /** 配置变更：revision 自增并追加历史；`nextDueAt` 由调用方按新规则算好后传入。 */
  async update(row: ScheduledTaskRow, nextDueAt: Date, event: JsonObject): Promise<ScheduledTaskRow> {
    return (await sql<ScheduledTaskRow>`update scheduled_tasks set title = ${row.title},
      template = ${JSON.stringify(row.template)}::jsonb, repeat_rule = ${JSON.stringify(row.repeat_rule)}::jsonb,
      timezone = ${row.timezone}, local_time = ${row.local_time}, first_run_at = ${row.first_run_at},
      next_due_at = ${nextDueAt},
      status = ${row.status}, schedule_generation = ${row.schedule_generation}, max_runs = ${row.max_runs},
      authorization_expires_at = ${row.authorization_expires_at},
      execution_input = ${JSON.stringify(row.execution_input)}::jsonb,
      revision = revision + 1, history = history || ${JSON.stringify([event])}::jsonb
      where id = ${row.id} returning *`.execute(this.db)).rows[0]!;
  }

  /**
   * 触发后推进下次时刻并占用一个时段序号。
   *
   * 这里**不**校验预算：`runs_reserved` 只是时段计数，预算口径是 `runs_started`
   * （用户理解的 max_runs 是「最多真正启动多少次」），由调用方在插入 occurrence 前判定。
   */
  async advanceSlot(id: string, nextDueAt: Date): Promise<ScheduledTaskRow | undefined> {
    return (await sql<ScheduledTaskRow>`update scheduled_tasks
      set next_due_at = ${nextDueAt}, runs_reserved = runs_reserved + 1
      where id = ${id} and status = 'ENABLED'
      returning *`.execute(this.db)).rows[0];
  }

  async markStarted(id: string): Promise<void> {
    await sql`update scheduled_tasks set runs_started = runs_started + 1
      where id = ${id} and runs_started < runs_reserved`.execute(this.db);
  }

  async setStatus(id: string, status: ScheduledTaskStatus, nextDueAt: Date, event: JsonObject): Promise<ScheduledTaskRow> {
    return (await sql<ScheduledTaskRow>`update scheduled_tasks set status = ${status}, next_due_at = ${nextDueAt},
      revision = revision + 1, history = history || ${JSON.stringify([event])}::jsonb
      where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }

  async dueWorkspaces(): Promise<string[]> {
    return (await sql<{ workspace_id: string }>`select distinct workspace_id from (
        select s.workspace_id from scheduled_tasks s join projects p on p.id = s.project_id
          where s.status = 'ENABLED' and s.next_due_at <= clock_timestamp() and p.archived_at is null
        union
        select o.workspace_id from scheduled_task_occurrences o where o.status = 'DISPATCHING'
      ) candidates order by workspace_id`.execute(this.db)).rows.map((row) => row.workspace_id);
  }

  /** 到期行加行锁；`skip locked` 让另一个调度实例直接跳过，不排队等锁。 */
  async due(workspaceId: string, now: Date): Promise<ScheduledTaskRow[]> {
    return (await sql<ScheduledTaskRow>`select s.* from scheduled_tasks s join projects p on p.id = s.project_id
      where s.workspace_id = ${workspaceId} and s.status = 'ENABLED' and s.next_due_at <= ${now}
        and p.archived_at is null
      order by s.next_due_at, s.id limit 50 for update of s skip locked`.execute(this.db)).rows;
  }

  async insertOccurrence(row: OccurrenceInsert, status: 'DISPATCHING' | 'BLOCKED' | 'SKIPPED', reason: string | null = null): Promise<ScheduledTaskOccurrenceRow | undefined> {
    return (await sql<ScheduledTaskOccurrenceRow>`insert into scheduled_task_occurrences
      (id, scheduled_task_id, workspace_id, project_id, schedule_generation, sequence, due_at, timezone, missed,
       status, create_command_id, ready_command_id, delegate_command_id, reason)
      values (${row.id}, ${row.scheduled_task_id}, ${row.workspace_id}, ${row.project_id}, ${row.schedule_generation},
        ${row.sequence}, ${row.due_at}, ${row.timezone}, ${row.missed}, ${status},
        ${row.create_command_id}, ${row.ready_command_id}, ${row.delegate_command_id}, ${reason})
      on conflict (scheduled_task_id, schedule_generation, sequence) do nothing
      returning *`.execute(this.db)).rows[0];
  }

  /** 待分发：崩溃恢复与人工「补跑」都落在这里，调度器每 tick 先清这批。 */
  async pendingDispatch(workspaceId: string): Promise<ScheduledTaskOccurrenceRow[]> {
    return (await sql<ScheduledTaskOccurrenceRow>`select * from scheduled_task_occurrences
      where workspace_id = ${workspaceId} and status = 'DISPATCHING'
      order by created_at, id limit 50`.execute(this.db)).rows;
  }

  async readOccurrence(id: string, lock = false): Promise<ScheduledTaskOccurrenceRow | undefined> {
    return (await sql<ScheduledTaskOccurrenceRow>`select * from scheduled_task_occurrences where id = ${id}
      ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }

  async occurrences(scheduledTaskId: string, limit = 20): Promise<ScheduledTaskOccurrenceRow[]> {
    return (await sql<ScheduledTaskOccurrenceRow>`select * from scheduled_task_occurrences
      where scheduled_task_id = ${scheduledTaskId} order by created_at desc, id desc limit ${limit}`.execute(this.db)).rows;
  }

  /** 上一轮（最近创建）的 occurrence；用于判断「上一轮是否已验收」。 */
  async latestOccurrence(scheduledTaskId: string): Promise<ScheduledTaskOccurrenceRow | undefined> {
    return (await sql<ScheduledTaskOccurrenceRow>`select * from scheduled_task_occurrences
      where scheduled_task_id = ${scheduledTaskId} order by created_at desc, id desc limit 1`.execute(this.db)).rows[0];
  }

  async blocked(workspaceId: string, limit = 50): Promise<ScheduledTaskOccurrenceRow[]> {
    return (await sql<ScheduledTaskOccurrenceRow>`select * from scheduled_task_occurrences
      where workspace_id = ${workspaceId} and status = 'BLOCKED' order by created_at, id limit ${limit}`.execute(this.db)).rows;
  }

  /** 详情用：不受最近 N 条窗口限制的待处理（BLOCKED）时段，窗口外的旧阻塞不能丢处理入口。 */
  async blockedOccurrences(scheduledTaskId: string): Promise<ScheduledTaskOccurrenceRow[]> {
    return (await sql<ScheduledTaskOccurrenceRow>`select * from scheduled_task_occurrences
      where scheduled_task_id = ${scheduledTaskId} and status = 'BLOCKED' order by created_at, id`.execute(this.db)).rows;
  }

  /** 新建 Task 之后立刻绑定：让 Delegate 事务内能核对「这次触发确实对应这个 Task」。 */
  async bindTask(id: string, taskId: string): Promise<void> {
    await sql`update scheduled_task_occurrences set task_id = ${taskId}, revision = revision + 1
      where id = ${id} and status = 'DISPATCHING'`.execute(this.db);
  }

  /** 触发时冻结的执行范围：连接/资料/资源依据在这一刻确定，事后漂移不回写历史。 */
  async freezeExecution(id: string, spec: JsonObject): Promise<void> {
    await sql`update scheduled_task_occurrences set frozen_execution = ${JSON.stringify(spec)}::jsonb,
      revision = revision + 1 where id = ${id}`.execute(this.db);
  }

  async markDispatched(id: string, taskId: string, runId: string): Promise<void> {
    await sql`update scheduled_task_occurrences set status = 'DISPATCHED', task_id = ${taskId}, run_id = ${runId},
      reason = null, revision = revision + 1 where id = ${id}`.execute(this.db);
  }

  async markSettled(id: string, status: 'BLOCKED' | 'SKIPPED', reason: string): Promise<void> {
    await sql`update scheduled_task_occurrences set status = ${status}, reason = ${reason}, revision = revision + 1
      where id = ${id}`.execute(this.db);
  }

  async resolve(id: string, status: 'RESOLVED', reason: string): Promise<ScheduledTaskOccurrenceRow> {
    return (await sql<ScheduledTaskOccurrenceRow>`update scheduled_task_occurrences
      set status = ${status}, reason = ${reason}, revision = revision + 1 where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }

  /** 人工「补跑一次」：把 BLOCKED 发生重新置为可分发，不新增预留。 */
  async reopen(id: string): Promise<ScheduledTaskOccurrenceRow | undefined> {
    return (await sql<ScheduledTaskOccurrenceRow>`update scheduled_task_occurrences
      set status = 'DISPATCHING', reason = null, revision = revision + 1
      where id = ${id} and status = 'BLOCKED' returning *`.execute(this.db)).rows[0];
  }
}
