import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { RunToolCallRow } from '../infrastructure/database-schema.js';
import { requireRow } from '../shared/sql-rows.js';

/**
 * run_tool_calls 的唯一 SQL Owner（docs/architecture/runtime-context.md §2.3）。
 *
 * 请求、工具名与参数摘要在写入后不可改写；应用角色只被允许推进状态、绑定动作身份与
 * 写入结果投影，因此恢复核对总能看到模型实际请求了什么。
 */
export class RunToolCallRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(input: {
    readonly id: string;
    readonly workspace_id: string;
    readonly project_id: string;
    readonly run_id: string;
    readonly step_id: string;
    readonly step_attempt_id: string;
    readonly model_call_id: string;
    readonly round: number;
    readonly ordinal: number;
    readonly provider_tool_call_id: string;
    readonly tool_name: string;
    readonly arguments: JsonObject;
    readonly arguments_sha256: string;
    readonly assistant_message?: JsonObject | null;
    /** 对某一次已结算冲突的重新适配；只能指向原始请求，深度限制由应用层判定。 */
    readonly adaptation_of?: string | null;
    readonly adapted_path?: string | null;
  }, db: DbExecutor = this.db): Promise<RunToolCallRow> {
    const result = await sql<RunToolCallRow>`
      insert into run_tool_calls
        (id, workspace_id, project_id, run_id, step_id, step_attempt_id, model_call_id,
         round, ordinal, provider_tool_call_id, tool_name, arguments, arguments_sha256, assistant_message,
         status, operation_id, result_ref, revision, adaptation_of, adapted_path)
      values (${input.id}, ${input.workspace_id}, ${input.project_id}, ${input.run_id},
        ${input.step_id}, ${input.step_attempt_id}, ${input.model_call_id}, ${input.round},
        ${input.ordinal}, ${input.provider_tool_call_id}, ${input.tool_name},
        ${JSON.stringify(input.arguments)}::jsonb, ${input.arguments_sha256},
        ${input.assistant_message == null ? null : JSON.stringify(input.assistant_message)}::jsonb,
        'REQUESTED', null, null, 1, ${input.adaptation_of ?? null}, ${input.adapted_path ?? null})
      returning *
    `.execute(db);
    return requireRow(result.rows, 'insert run tool call');
  }

  async read(id: string): Promise<RunToolCallRow | undefined> {
    return (await sql<RunToolCallRow>`select * from run_tool_calls
      where id = ${id}`.execute(this.db)).rows[0];
  }

  async readByOperation(runId: string, operationId: string): Promise<RunToolCallRow | undefined> {
    return (await sql<RunToolCallRow>`select * from run_tool_calls
      where run_id = ${runId} and operation_id = ${operationId}`.execute(this.db)).rows[0];
  }

  async lock(id: string, db: DbExecutor = this.db): Promise<RunToolCallRow | undefined> {
    return (await sql<RunToolCallRow>`select * from run_tool_calls
      where id = ${id} for update`.execute(db)).rows[0];
  }

  /** 一次 Attempt 已有的全部工具调用，按轮次与位置排序：模型消息重建与预算核对共用它。 */
  async listByAttempt(stepAttemptId: string,
    db: DbExecutor = this.db): Promise<readonly RunToolCallRow[]> {
    return (await sql<RunToolCallRow>`select * from run_tool_calls
      where step_attempt_id = ${stepAttemptId}
      order by round asc, ordinal asc`.execute(db)).rows;
  }

  /**
   * 本 Run 的全部工具调用，按轮次与位置排序。
   *
   * 冲突适配判定跨 Attempt 读取：恢复后新建的 Attempt 里那次冲突仍然是同一次冲突的
   * 事实来源，不能因为换了 Attempt 就当成没发生过。
   */
  async listByRun(runId: string, db: DbExecutor = this.db): Promise<readonly RunToolCallRow[]> {
    return (await sql<RunToolCallRow>`select * from run_tool_calls
      where run_id = ${runId}
      order by round asc, ordinal asc`.execute(db)).rows;
  }

  /** 本 Run 仍未走完的工具调用。一个 Run 同时只允许一个未决动作，与既有准入一致。 */
  async listPending(runId: string, db: DbExecutor = this.db): Promise<readonly RunToolCallRow[]> {
    return (await sql<RunToolCallRow>`select * from run_tool_calls
      where run_id = ${runId} and status in ('REQUESTED', 'PREPARED', 'WAITING_APPROVAL')
      order by round asc, ordinal asc`.execute(db)).rows;
  }

  async countByRun(runId: string, db: DbExecutor = this.db): Promise<number> {
    const result = await sql<{ count: string }>`select count(*)::text as count
      from run_tool_calls where run_id = ${runId}`.execute(db);
    return Number(result.rows[0]?.count ?? '0');
  }

  /** 该 Run 的工具请求里是否有这一条指向此 Operation：批准与检查点唤醒据此判断合法性。 */
  async countByOperation(runId: string, operationId: string,
    db: DbExecutor = this.db): Promise<number> {
    const result = await sql<{ count: string }>`select count(*)::text as count
      from run_tool_calls where run_id = ${runId} and operation_id = ${operationId}`.execute(db);
    return Number(result.rows[0]?.count ?? '0');
  }

  /** REQUESTED → PREPARED/WAITING_APPROVAL：只在动作身份已确定时前进。 */
  async bindOperation(id: string, operationId: string,
    status: 'PREPARED' | 'WAITING_APPROVAL', db: DbExecutor = this.db): Promise<boolean> {
    const result = await sql<{ id: string }>`update run_tool_calls
      set status = ${status}, operation_id = ${operationId},
          revision = revision + 1, updated_at = clock_timestamp()
      where id = ${id} and status = 'REQUESTED'
      returning id`.execute(db);
    return result.rows.length === 1;
  }

  /** 未派发行的类型化原因；不连 Operation，也不伪造一次执行。 */
  async reject(id: string, reason: string, detail: string,
    db: DbExecutor = this.db): Promise<boolean> {
    const result = await sql<{ id: string }>`update run_tool_calls
      set status = 'REJECTED', result_ref = ${JSON.stringify({ reason, detail })}::jsonb,
          revision = revision + 1, updated_at = clock_timestamp()
      where id = ${id} and status = 'REQUESTED'
      returning id`.execute(db);
    return result.rows.length === 1;
  }

  /**
   * 终态收口：把已证明未派发的 REQUESTED 行退出 pending。
   *
   * 只处理 operation_id 为 NULL 且同 id 无对应 Operation 的行：准备与绑定之间
   * 的竞态会在 logical_operations 里留下同 id 的行，此时必须跳过，走既有停止
   * 与核对流程。已有 Operation/Invocation/在途效果/UNKNOWN 一律不动。
   * 调用方须已按 Task→Run 锁序持有行锁（控制收口或终态查询事务内）。
   * 幂等：已 REJECTED/SETTLED/ABANDONED 的行不受影响，不建新行。
   */
  async rejectUndispatchedForTerminalRun(runId: string, runStatus: string,
    db: DbExecutor = this.db): Promise<number> {
    const candidates = (await sql<{ id: string }>`select id from run_tool_calls
      where run_id = ${runId} and status = 'REQUESTED' and operation_id is null
      order by round asc, ordinal asc`.execute(db)).rows;
    let rejected = 0;
    for (const candidate of candidates) {
      const operation = (await sql<{ id: string }>`select id from logical_operations
        where id = ${candidate.id}`.execute(db)).rows[0];
      if (operation !== undefined) continue;
      const done = (await sql<{ id: string }>`update run_tool_calls
        set status = 'REJECTED',
            result_ref = ${JSON.stringify({ reason: 'RUN_TERMINAL',
              detail: `Run 已进入终态或已脱离当前执行权（状态：${runStatus}），遗留的工具请求不再派发。` })}::jsonb,
            revision = revision + 1, updated_at = clock_timestamp()
        where id = ${candidate.id} and status = 'REQUESTED'
        returning id`.execute(db)).rows.length === 1;
      if (done) rejected += 1;
    }
    return rejected;
  }

  /**
   * 已连上 Operation 的行落定 SETTLED。结果投影由调用方从该 Operation 的 result_ref
   * 截取后再写入，本方法只搬运状态，不解释内容。
   */
  async settle(id: string, resultRef: JsonObject | null,
    db: DbExecutor = this.db): Promise<boolean> {
    const result = await sql<{ id: string }>`update run_tool_calls
      set status = 'SETTLED',
          result_ref = ${resultRef === null ? null : JSON.stringify(resultRef)}::jsonb,
          revision = revision + 1, updated_at = clock_timestamp()
      where id = ${id} and status in ('PREPARED', 'WAITING_APPROVAL')
        and operation_id is not null
      returning id`.execute(db);
    return result.rows.length === 1;
  }

  /** 恢复核对或人工处置之后才能放弃的行；已 SETTLED 的历史不被改写。 */
  async abandon(id: string, resultRef: JsonObject,
    db: DbExecutor = this.db): Promise<boolean> {
    const result = await sql<{ id: string }>`update run_tool_calls
      set status = 'ABANDONED', result_ref = ${JSON.stringify(resultRef)}::jsonb,
          revision = revision + 1, updated_at = clock_timestamp()
      where id = ${id} and status in ('REQUESTED', 'PREPARED', 'WAITING_APPROVAL')
      returning id`.execute(db);
    return result.rows.length === 1;
  }
}
