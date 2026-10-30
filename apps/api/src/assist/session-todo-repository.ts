import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import {
  buildTodoContextBlock,
  normalizeTodoItems,
  projectTodoSnapshot,
  TODO_PARALLEL_LIMIT_DEFAULT,
  todoParallelLimit,
  TodoRequestRejected,
  type TodoItem,
  type TodoSnapshot,
} from './session-todos.js';

/**
 * 会话待办清单的独占持久化入口（ADR-038）。
 *
 * 一次写入 = 一条版本化事件 + 一行最新快照，**同一个事务**里提交：
 *   * `assist_session_todo_events` 是历史，只用于恢复与审计，UI 与模型都不读它；
 *   * `assist_session_todo_snapshots` 是唯一有效投影（一会话一行）。
 * 两者分表而不是「快照 + 版本列」单表，是因为旧事件不能覆盖新快照：事件表按
 * (session_id, version) 唯一，写不进去就说明并发里有另一个写者已经占了这一版。
 *
 * 幂等按**原调用身份**判定，不按内容：同一条工具调用被重放（任务重试、进程重启后的
 * 重新结算）返回原版本，不递增、不再写事件；模型换一个新的调用重新提交同样的内容时，
 * 那是一次新的写入——这正是全量复写的语义。
 */

export interface TodoWriteInput {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly messageId: string;
  readonly toolCallId: string;
  readonly items: unknown;
  readonly expectedVersion?: number | undefined;
}

export interface TodoWriteOutcome {
  readonly outcome: 'APPLIED' | 'IDEMPOTENT';
  readonly snapshot: TodoSnapshot;
}

interface SnapshotRow {
  readonly session_id: string;
  readonly version: string | number;
  readonly items: unknown;
  readonly in_progress_limit: number | string;
  readonly updated_at: Date | string;
  readonly last_tool_call_id?: string;
}

const SNAPSHOT_COLUMNS = sql.raw('session_id, version, items, in_progress_limit, updated_at, ' +
  'last_tool_call_id');

export class SessionTodoRepository {
  constructor(private readonly db: DbExecutor) {}

  /** 当前有效投影。没有写过清单时返回 undefined——「没写过」与「写了个空清单」不是一回事。 */
  async read(sessionId: string): Promise<TodoSnapshot | undefined> {
    const rows = (await sql<SnapshotRow>`select ${SNAPSHOT_COLUMNS}
      from assist_session_todo_snapshots where session_id = ${sessionId}`
      .execute(this.db)).rows;
    const row = rows[0];
    return row === undefined ? undefined : projectTodoSnapshot(row);
  }

  /**
   * 上下文注入用的读口：这一版快照可能在本次生成之前的别的消息里写过。
   *
   * 供上下文注入使用：没有快照就返回空字符串，不把「没写过」渲染成一份空清单。
   */
  async readContextBlock(sessionId: string): Promise<string> {
    const snapshot = await this.read(sessionId);
    return snapshot === undefined ? '' : buildTodoContextBlock(snapshot);
  }

  /** 会话行上配置的并行条数上限；没有配置时用默认值。 */
  async parallelLimitFor(sessionId: string): Promise<number> {
    return this.limitFor(this.db, sessionId);
  }

  private async limitFor(executor: DbExecutor, sessionId: string): Promise<number> {
    const rows = (await sql<{ todo_parallel_limit: number | string | null }>`
      select todo_parallel_limit from assist_sessions where id = ${sessionId}`
      .execute(executor)).rows;
    return todoParallelLimit(rows[0]?.todo_parallel_limit ?? TODO_PARALLEL_LIMIT_DEFAULT);
  }

  /**
   * 全量复写一次清单。
   *
   * 失败关闭：任何一条校验不通过都整次拒绝，不写「部分项目」，也不留下半版事件。
   */
  async write(input: TodoWriteInput): Promise<TodoWriteOutcome> {
    return this.db.transaction().execute(async (trx) => {
      const current = (await sql<SnapshotRow>`select ${SNAPSHOT_COLUMNS}
        from assist_session_todo_snapshots where session_id = ${input.sessionId} for update`
        .execute(trx)).rows[0];
      // 同一调用的重放：原版本原样返回，不递增版本、不再写事件。
      if (current !== undefined && current.last_tool_call_id === input.toolCallId) {
        return { outcome: 'IDEMPOTENT' as const, snapshot: projectTodoSnapshot(current) };
      }
      const currentVersion = current === undefined ? 0 : Number(current.version);
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw new TodoRequestRejected('TODO_VERSION_CONFLICT',
          `清单已经更新到第 ${currentVersion} 版，你基于第 ${input.expectedVersion} 版提交；` +
          '请重新读取最新清单再全量复写，不要覆盖别人的新快照。');
      }
      const limit = await this.limitFor(trx, input.sessionId);
      const previous: readonly TodoItem[] = current === undefined ? [] : projectTodoSnapshot(current).items;
      const items = normalizeTodoItems({ raw: input.items, previous, parallelLimit: limit });
      const version = currentVersion + 1;
      const inserted = (await sql<{ id: string }>`insert into assist_session_todo_events
        (id, session_id, workspace_id, version, items, tool_call_id, message_id, origin_version)
        values (${randomUUID()}, ${input.sessionId}, ${input.workspaceId}, ${version},
          ${JSON.stringify(items)}::jsonb, ${input.toolCallId}, ${input.messageId}, ${currentVersion})
        on conflict (session_id, version) do nothing returning id`.execute(trx)).rows;
      if (inserted.length === 0) {
        // 另一个写者先占了这一版：不覆盖，交回调用方按冲突处理。
        throw new TodoRequestRejected('TODO_VERSION_CONFLICT',
          '清单同时被另一个写入占了这一版；请重新读取最新清单再提交。');
      }
      const updated = (await sql<SnapshotRow>`insert into assist_session_todo_snapshots
        (session_id, workspace_id, version, items, in_progress_limit, last_tool_call_id, last_message_id, updated_at)
        values (${input.sessionId}, ${input.workspaceId}, ${version}, ${JSON.stringify(items)}::jsonb,
          ${limit}, ${input.toolCallId}, ${input.messageId}, now())
        on conflict (session_id) do update set
          version = excluded.version, items = excluded.items, in_progress_limit = excluded.in_progress_limit,
          last_tool_call_id = excluded.last_tool_call_id, last_message_id = excluded.last_message_id,
          updated_at = excluded.updated_at
        where assist_session_todo_snapshots.version < excluded.version
        returning ${SNAPSHOT_COLUMNS}`.execute(trx)).rows;
      const row = updated[0];
      if (row === undefined) {
        throw new TodoRequestRejected('TODO_VERSION_CONFLICT',
          '快照已经比这次写入更新；旧请求不得覆盖新快照。');
      }
      return { outcome: 'APPLIED' as const, snapshot: projectTodoSnapshot(row) };
    });
  }
}