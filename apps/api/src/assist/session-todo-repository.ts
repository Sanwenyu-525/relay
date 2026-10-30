import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import {
  buildTodoContextBlock,
  normalizeTodoItems,
  parseTodoItems,
  projectTodoSnapshot,
  TODO_PARALLEL_LIMIT_DEFAULT,
  todoParallelLimit,
  todoScopeKey,
  TodoRequestRejected,
  type TodoItem,
  type TodoSnapshot,
} from './session-todos.js';

/**
 * 会话待办清单的独占持久化入口（ADR-038）。
 *
 * 一次写入 = 一条版本化事件 + 一行最新快照，**同一个事务**里提交：
 *   * `assist_session_todo_events` 是历史，只用于恢复与幂等核对，UI 与模型都不读它；
 *   * `assist_session_todo_snapshots` 是唯一有效投影（一会话一行，带本轮归属键）。
 *
 * 三件不可让步的事：
 *   1. 幂等按**原调用身份**（session_id + tool_call_id）判定，不按内容，也不只看最新快照：
 *      历史调用在快照推进之后才被重放，答案仍然只能是它当初写下的那一版。
 *   2. 同一调用 ID 换一份载荷是身份伪造：明确拒绝，不新增版本、不改写历史。
 *   3. 版本 CAS：首次写入的基线是 0；已有快照时必须带上读到的版本号，否则整次拒绝。
 */

export interface TodoWriteInput {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly messageId: string;
  readonly toolCallId: string;
  readonly items: unknown;
  readonly expectedVersion?: number | undefined;
  /** 工作轮次归属键；省略时按 messageId 反查开启这一轮的用户消息。 */
  readonly scopeKey?: string | undefined;
}

export interface TodoWriteOutcome {
  readonly outcome: 'APPLIED' | 'IDEMPOTENT';
  readonly snapshot: TodoSnapshot;
}

interface SnapshotRow {
  readonly session_id: string;
  readonly scope_key: string;
  readonly version: string | number;
  readonly items: unknown;
  readonly in_progress_limit: number | string;
  readonly updated_at: Date | string;
  readonly last_tool_call_id?: string;
}

interface EventRow {
  readonly session_id: string;
  readonly scope_key: string;
  readonly version: string | number;
  readonly items: unknown;
  readonly tool_call_id: string;
  readonly created_at: Date | string;
}

const SNAPSHOT_COLUMNS = sql.raw('session_id, scope_key, version, items, in_progress_limit, ' +
  'updated_at, last_tool_call_id');

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** 同一调用 ID 的载荷口径：只认「哪几步、各自什么状态」，不认服务端发的 id 与空白差异。 */
function payloadSignature(items: unknown): string {
  if (!Array.isArray(items)) return '';
  return JSON.stringify(items.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return ['', ''];
    const record = entry as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    const status = typeof record.status === 'string' ? record.status : '';
    return [content, status];
  }));
}

export class SessionTodoRepository {
  constructor(private readonly db: DbExecutor) {}

  /**
   * 这一轮属于哪个工作轮次。
   *
   * 给了 messageId（模型正在写的助手消息）就找它之前最近的一条用户消息；
   * 不给（读投影）就找会话里最近的一条用户消息。都没有时回落到会话级，与旧行为一致。
   */
  async resolveScopeKey(sessionId: string, messageId?: string): Promise<string> {
    const rows = messageId === undefined
      ? (await sql<{ id: string }>`select id from assist_messages
          where session_id = ${sessionId} and role = 'USER'
          order by seq desc limit 1`.execute(this.db)).rows
      : (await sql<{ id: string }>`select id from assist_messages
          where session_id = ${sessionId} and role = 'USER'
            and seq <= (select seq from assist_messages where id = ${messageId}
              and session_id = ${sessionId})
          order by seq desc limit 1`.execute(this.db)).rows;
    return todoScopeKey(rows[0]?.id);
  }

  /** 当前工作轮次的有效投影；属于别的轮次就等于「这一轮没有清单」。 */
  async read(sessionId: string, scopeKey?: string): Promise<TodoSnapshot | undefined> {
    const key = scopeKey ?? await this.resolveScopeKey(sessionId);
    return this.readScope(sessionId, key);
  }

  async readScope(sessionId: string, scopeKey: string): Promise<TodoSnapshot | undefined> {
    const rows = (await sql<SnapshotRow>`select ${SNAPSHOT_COLUMNS}
      from assist_session_todo_snapshots where session_id = ${sessionId}`
      .execute(this.db)).rows;
    const row = rows[0];
    if (row === undefined || row.scope_key !== scopeKey) return undefined;
    return projectTodoSnapshot(row);
  }

  /**
   * 上下文注入用的读口：每次真实模型调用前从数据库重读，压缩、checkpoint 恢复、
   * 进程重启之后拿到的都是同一轮次的权威快照，不从历史消息里重建「上一版清单」。
   */
  async readContextBlock(sessionId: string, messageId?: string): Promise<string> {
    const scopeKey = await this.resolveScopeKey(sessionId, messageId);
    const snapshot = await this.readScope(sessionId, scopeKey);
    return snapshot === undefined ? '' : buildTodoContextBlock(snapshot);
  }

  /** 会话行上配置的并行条数上限；这是当前唯一的配置入口。 */
  async parallelLimitFor(sessionId: string): Promise<number> {
    return this.limitFor(this.db, sessionId);
  }

  private async limitFor(executor: DbExecutor, sessionId: string): Promise<number> {
    const rows = (await sql<{ todo_parallel_limit: number | string | null }>`
      select todo_parallel_limit from assist_sessions where id = ${sessionId}`
      .execute(executor)).rows;
    return todoParallelLimit(rows[0]?.todo_parallel_limit ?? TODO_PARALLEL_LIMIT_DEFAULT);
  }

  private async readEventByToolCall(sessionId: string, toolCallId: string,
    executor: DbExecutor = this.db): Promise<EventRow | undefined> {
    const rows = (await sql<EventRow>`select session_id, scope_key, version, items, tool_call_id,
        created_at from assist_session_todo_events
      where session_id = ${sessionId} and tool_call_id = ${toolCallId}`.execute(executor)).rows;
    return rows[0];
  }

  /**
   * 原调用的回执。
   *
   * 历史调用被重放（任务重试、快照已提交但工具未结算就退出）时，答案只能是它当初写下的
   * 那一版：版本号不递增、不再写事件。同一调用 ID 换一份载荷是身份伪造，明确拒绝。
   */
  private async replay(event: EventRow, input: TodoWriteInput): Promise<TodoWriteOutcome> {
    const storedItems = parseTodoItems(event.items);
    if (payloadSignature(storedItems) !== payloadSignature(input.items)) {
      throw new TodoRequestRejected('TODO_TOOL_CALL_CONFLICT',
        '这个工具调用 ID 已经写过另一份清单；同一调用不能换载荷重放，请用新的调用提交。');
    }
    const limit = await this.limitFor(this.db, input.sessionId);
    const createdAt = event.created_at instanceof Date
      ? event.created_at.toISOString() : event.created_at;
    return { outcome: 'IDEMPOTENT', snapshot: { sessionId: input.sessionId,
      scopeKey: event.scope_key, version: Number(event.version), items: storedItems,
      inProgressLimit: limit, updatedAt: createdAt } };
  }

  /**
   * 全量复写一次清单。失败关闭：任何一条校验不通过都整次拒绝，不留半版事件。
   */
  async write(input: TodoWriteInput): Promise<TodoWriteOutcome> {
    if (!Array.isArray(input.items)) {
      throw new TodoRequestRejected('TODO_ITEMS_INVALID', 'items 必须是数组，且表示这一版的完整清单。');
    }
    const scopeKey = input.scopeKey ?? await this.resolveScopeKey(input.sessionId, input.messageId);
    try {
      return await this.db.transaction()
        .execute((trx) => this.writeInTransaction(trx, input, scopeKey));
    } catch (error) {
      // 并发下同身份或同版本被另一个写者抢先：回到已提交的事实上重新判定，不盲重试。
      if (pgErrorCode(error) !== '23505') throw error;
      const concurrent = await this.readEventByToolCall(input.sessionId, input.toolCallId);
      if (concurrent !== undefined) return this.replay(concurrent, input);
      throw new TodoRequestRejected('TODO_VERSION_CONFLICT',
        '清单同时被另一个写入占了这一版；请重新读取最新清单再提交。');
    }
  }

  private async writeInTransaction(trx: DbExecutor, input: TodoWriteInput,
    scopeKey: string): Promise<TodoWriteOutcome> {
    const replay = await this.readEventByToolCall(input.sessionId, input.toolCallId, trx);
    if (replay !== undefined) return this.replay(replay, input);

    const current = (await sql<SnapshotRow>`select ${SNAPSHOT_COLUMNS}
      from assist_session_todo_snapshots where session_id = ${input.sessionId} for update`
      .execute(trx)).rows[0];
    const sameScope = current !== undefined && current.scope_key === scopeKey;
    const currentVersion = sameScope && current !== undefined ? Number(current.version) : 0;
    const expected = input.expectedVersion;
    if (currentVersion === 0) {
      if (expected !== undefined && expected !== 0) {
        throw new TodoRequestRejected('TODO_VERSION_CONFLICT',
          '这一轮还没有写过清单（当前版本 0）；首次写入请把 expected_version 写成 0 或省略。');
      }
    } else if (expected === undefined) {
      throw new TodoRequestRejected('TODO_VERSION_REQUIRED',
        `清单已经是第 ${currentVersion} 版；全量复写必须带 expected_version: ${currentVersion}，` +
        '否则无法证明你读到的是最新一版。');
    } else if (expected !== currentVersion) {
      throw new TodoRequestRejected('TODO_VERSION_CONFLICT',
        `清单已经更新到第 ${currentVersion} 版，你基于第 ${expected} 版提交；` +
        `请按 expected_version: ${currentVersion} 重新读取后全量复写。`);
    }

    const limit = await this.limitFor(trx, input.sessionId);
    const previous: readonly TodoItem[] = sameScope && current !== undefined
      ? projectTodoSnapshot(current).items : [];
    const items = normalizeTodoItems({ raw: input.items, previous, parallelLimit: limit });
    const version = currentVersion + 1;
    const inserted = (await sql<{ id: string }>`insert into assist_session_todo_events
      (id, session_id, workspace_id, scope_key, version, items, tool_call_id, message_id, origin_version)
      values (${randomUUID()}, ${input.sessionId}, ${input.workspaceId}, ${scopeKey}, ${version},
        ${JSON.stringify(items)}::jsonb, ${input.toolCallId}, ${input.messageId}, ${currentVersion})
      on conflict (session_id, tool_call_id) do nothing returning id`.execute(trx)).rows;
    if (inserted.length === 0) {
      const concurrent = await this.readEventByToolCall(input.sessionId, input.toolCallId, trx);
      if (concurrent === undefined) {
        throw new TodoRequestRejected('TODO_VERSION_CONFLICT',
          '清单同时被另一个写入占了这一版；请重新读取最新清单再提交。');
      }
      return this.replay(concurrent, input);
    }
    const updated = (await sql<SnapshotRow>`insert into assist_session_todo_snapshots
      (session_id, workspace_id, scope_key, version, items, in_progress_limit, last_tool_call_id,
        last_message_id, updated_at)
      values (${input.sessionId}, ${input.workspaceId}, ${scopeKey}, ${version},
        ${JSON.stringify(items)}::jsonb, ${limit}, ${input.toolCallId}, ${input.messageId}, now())
      on conflict (session_id) do update set
        workspace_id = excluded.workspace_id, scope_key = excluded.scope_key,
        version = excluded.version, items = excluded.items,
        in_progress_limit = excluded.in_progress_limit,
        last_tool_call_id = excluded.last_tool_call_id,
        last_message_id = excluded.last_message_id, updated_at = excluded.updated_at
      where assist_session_todo_snapshots.scope_key <> excluded.scope_key
        or assist_session_todo_snapshots.version < excluded.version
      returning ${SNAPSHOT_COLUMNS}`.execute(trx)).rows;
    const row = updated[0];
    if (row === undefined) {
      throw new TodoRequestRejected('TODO_VERSION_CONFLICT',
        '快照已经比这次写入更新；旧请求不得覆盖新快照。');
    }
    return { outcome: 'APPLIED', snapshot: projectTodoSnapshot(row) };
  }
}