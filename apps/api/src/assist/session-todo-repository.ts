import { createHash, randomUUID } from 'node:crypto';
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
 *   * `assist_session_todo_snapshots` 是唯一有效投影（一会话一行，带轮次归属键与轮次顺序）。
 *
 * 四件不可让步的事（2026-10-30 第三轮补充工作轮次顺序）：
 *   1. 幂等按**原调用身份**（session_id + tool_call_id）判定，不按内容，也不只看最新快照：
 *      历史调用在快照推进之后才被重放，答案仍然只能是它当初写下的那一版。
 *   2. 同一调用 ID 换一份载荷是身份伪造：用规范化请求摘要（版本 + 条目身份 + 内容 + 状态）
 *      核对，不一致就拒绝，不新增版本、不改写历史。
 *   3. 版本 CAS：首次写入的基线是 0；已有快照时必须带上读到的版本号（同一轮次内）。
 *   4. 工作轮次顺序：快照带 `scope_seq`，等于开启该轮次的用户消息 `seq`。
 *      较旧轮次的写入**不能覆盖**较新轮次的当前投影（A→B→A 的迟到写入、并发切换）。
 *   5. 工作身份在首次判定时冻结（`assist_session_todo_turn_scopes`，迁移 0151）：
 *      插话、重启与恢复都读同一份归属，注入与写入的作用域必然一致，模型不能靠猜切换。
 */

export interface TodoWriteInput {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly messageId: string;
  readonly toolCallId: string;
  readonly items: unknown;
  readonly expectedVersion?: number | undefined;
  /** 工作轮次归属键；省略时按 messageId 反查。 */
  readonly scopeKey?: string | undefined;
}

export interface TodoWriteOutcome {
  readonly outcome: 'APPLIED' | 'IDEMPOTENT';
  readonly snapshot: TodoSnapshot;
}

interface SnapshotRow {
  readonly session_id: string;
  readonly scope_key: string;
  readonly scope_seq: string | number;
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
  readonly request_digest: string | null;
  readonly created_at: Date | string;
}

interface TurnRow {
  readonly id: string;
  readonly seq: string | number;
  readonly content: string | null;
}

/**
 * 轮次归属的判定依据（2026-10-30 第五轮，迁移 0151）。
 *
 * 归属在**首次判定时冻结**成持久事实（`assist_session_todo_turn_scopes`），此后重启、
 * 插话、迟到写入都读冻结值，不再按当时的快照状态重算：
 *   * `OPENED`：这一轮开启了自己的工作作用域（含上一轮收尾后开新工作）；
 *   * `CONTINUED_UNFINISHED`：上一轮清单仍有未完成项，这一轮延续同一作用域；
 *   * `FORCED_NEW_PREFIX`：用户写明「新任务：」或 /newtask，即使上一轮未完成也开新作用域。
 * 三个依据都来自服务端可核对的事实（用户消息原文、当前快照状态）；模型写入不改变归属，
 * 也就不能靠猜静默切换作用域。历史重放不依赖归属行（走事件表），恢复重放因此不受影响。
 */
type TurnScopeBasis = 'OPENED' | 'CONTINUED_UNFINISHED' | 'FORCED_NEW_PREFIX';

interface TurnScopeRow {
  readonly message_id: string;
  readonly scope_key: string;
  readonly basis: TurnScopeBasis;
}

const SNAPSHOT_COLUMNS = sql.raw('session_id, scope_key, scope_seq, version, items, ' +
  'in_progress_limit, updated_at, last_tool_call_id');

/** 明确要求开新任务的前缀：写了它就是新作用域，不靠模型猜。 */
const NEW_TASK_PREFIX = /^\s*(\/newtask\b|新任务[:：])/iu;

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * 规范化请求摘要（2026-10-30 第三轮）。
 *
 * 只把**影响请求语义**的东西纳入：基线版本、每步的 id（模型带回来时）、内容、状态。
 * 不纳入空白差异与服务端自行分配的 id，否则同一份请求重放会被误判成异载荷。
 */
function requestDigest(items: unknown, expectedVersion: number | undefined): string {
  const normalized = Array.isArray(items) ? items.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return ['', '', ''];
    const record = entry as Record<string, unknown>;
    return [
      typeof record.id === 'string' ? record.id : '',
      typeof record.content === 'string' ? record.content.trim() : '',
      typeof record.status === 'string' ? record.status : '',
    ];
  }) : [];
  return createHash('sha256')
    .update(JSON.stringify({ expectedVersion: expectedVersion ?? null, items: normalized }))
    .digest('hex');
}

function unfinished(items: readonly TodoItem[]): boolean {
  return items.some((item) => item.status === 'pending' || item.status === 'in_progress');
}

/**
 * 0150 之前的历史事件没有规范化摘要，回退到载荷语义比较（2026-10-30 四修）。
 *
 * 旧口径对两边各算一次 `requestDigest`，但服务端规范化会给**请求里没有 id 的条目**
 * 补上生成的 id——它进了 stored 一侧的摘要、却不在原始请求一侧，于是同一份载荷的
 * 历史重放被误判成异载荷（`TODO_TOOL_CALL_CONFLICT`）。条目 id 是服务端为前端稳定
 * key 维护的内部身份，不是请求语义；历史重放按 `(content, status)` 序列逐条比较，
 * 异载荷仍然拒绝，同载荷恢复不再被新增列挡住。
 */
export function legacyPayloadMatches(stored: readonly TodoItem[], raw: unknown): boolean {
  if (!Array.isArray(raw)) return stored.length === 0;
  if (raw.length !== stored.length) return false;
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    const status = typeof record.status === 'string' ? record.status : '';
    if (stored[index]!.content !== content || stored[index]!.status !== status) return false;
  }
  return true;
}

export class SessionTodoRepository {
  constructor(private readonly db: DbExecutor) {}

  /**
   * 这一轮属于哪个工作轮次。
   *
   * 基本规则：给 messageId 就找它之前最近的一条用户消息，否则找会话里最近的一条。
   *
   * 工作连续性（2026-10-30 第三轮）：只有**最新一轮**才做延续判断。上一轮清单仍有
   * 未完成项时，新一条用户消息（「继续」「补充」「这里不对」）延续同一工作作用域，
   * 不因为一句话就重置。历史轮次的写入不适用延续——它们必须落回自己那一轮，
   * 然后被轮次顺序闸门拦下。用户写了明确的「新任务」前缀才强制开新作用域。
   *
   * 第五轮（迁移 0151）：归属在首次判定时**冻结**。这堵住两个现算口径的洞：
   *   * 插话会改变「最新一轮」的判定——同一轮里插话前的写入延续旧作用域、插话后的
   *     写入却落进自己的 turn 键，一次生成中途清单身份被静默换掉；
   *   * 崩溃恢复重算时，延续轮次的调用会被判回它自己的 turn 键、被顺序闸门误拒。
   * 冻结后读写共用同一归属：注入给模型的作用域与写入落地的作用域必然一致。
   */
  async resolveScopeKey(sessionId: string, messageId?: string): Promise<string> {
    const turn = await this.latestUserTurn(sessionId, messageId);
    if (turn === undefined) return todoScopeKey(undefined);
    const frozen = await this.readTurnScope(sessionId, turn.id);
    if (frozen !== undefined) return frozen.scope_key;
    return this.attributeTurn(sessionId, turn);
  }

  /** 冻结的轮次归属；没有归属行 = 还没判定过。 */
  private async readTurnScope(sessionId: string, messageId: string): Promise<TurnScopeRow | undefined> {
    return (await sql<TurnScopeRow>`select message_id, scope_key, basis
      from assist_session_todo_turn_scopes
      where session_id = ${sessionId} and message_id = ${messageId}`.execute(this.db)).rows[0];
  }

  /**
   * 首次判定并冻结这一轮的工作身份。
   *
   * 判定规则与第三轮一致，只是结果从此持久化；并发下两个判定者可能算出不同依据
   * （快照在两次计算之间变了），`on conflict do nothing` 让先到者定案，后到者读回
   * 已冻结的事实——同一轮次永远只有一个归属，不随观察顺序漂移。
   */
  private async attributeTurn(sessionId: string, turn: TurnRow): Promise<string> {
    const candidate = todoScopeKey(turn.id);
    const latest = await this.latestUserTurn(sessionId);
    const isLatest = latest !== undefined && latest.id === turn.id;
    let basis: TurnScopeBasis = 'OPENED';
    let scopeKey = candidate;
    if (NEW_TASK_PREFIX.test(turn.content ?? '')) {
      // 前缀只在它是最新一轮时才强制开新作用域；历史轮次落回自己的 turn 键，由顺序闸门拦。
      if (isLatest) basis = 'FORCED_NEW_PREFIX';
    } else if (isLatest) {
      const current = await this.readSnapshotRow(this.db, sessionId);
      if (current !== undefined && current.scope_key !== candidate &&
          unfinished(parseTodoItems(current.items))) {
        basis = 'CONTINUED_UNFINISHED';
        scopeKey = current.scope_key;
      }
    }
    await sql`insert into assist_session_todo_turn_scopes (session_id, message_id, scope_key, basis)
      values (${sessionId}, ${turn.id}, ${scopeKey}, ${basis})
      on conflict (session_id, message_id) do nothing`.execute(this.db);
    const frozen = await this.readTurnScope(sessionId, turn.id);
    return frozen?.scope_key ?? scopeKey;
  }

  private async latestUserTurn(sessionId: string, messageId?: string): Promise<TurnRow | undefined> {
    const rows = messageId === undefined
      ? (await sql<TurnRow>`select id, seq, content from assist_messages
          where session_id = ${sessionId} and role = 'USER'
          order by seq desc limit 1`.execute(this.db)).rows
      : (await sql<TurnRow>`select id, seq, content from assist_messages
          where session_id = ${sessionId} and role = 'USER'
            and seq <= (select seq from assist_messages where id = ${messageId}
              and session_id = ${sessionId})
          order by seq desc limit 1`.execute(this.db)).rows;
    return rows[0];
  }

  /** 当前投影（不管是哪一轮）的快照行；轮次顺序闸门与延续判断都用它。 */
  private async readSnapshotRow(executor: DbExecutor, sessionId: string): Promise<SnapshotRow | undefined> {
    return (await sql<SnapshotRow>`select ${SNAPSHOT_COLUMNS}
      from assist_session_todo_snapshots where session_id = ${sessionId}`
      .execute(executor)).rows[0];
  }

  /** 当前工作轮次的有效投影；属于别的轮次就等于「这一轮没有清单」。 */
  async read(sessionId: string, scopeKey?: string): Promise<TodoSnapshot | undefined> {
    const key = scopeKey ?? await this.resolveScopeKey(sessionId);
    return this.readScope(sessionId, key);
  }

  async readScope(sessionId: string, scopeKey: string): Promise<TodoSnapshot | undefined> {
    const row = await this.readSnapshotRow(this.db, sessionId);
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

  /** 轮次顺序：轮次键里的用户消息 seq；会话级回落 0。 */
  private async scopeSeq(executor: DbExecutor, sessionId: string, scopeKey: string): Promise<bigint> {
    if (!scopeKey.startsWith('turn:')) return 0n;
    const rows = (await sql<{ seq: string | number }>`select seq from assist_messages
      where id = ${scopeKey.slice(5)} and session_id = ${sessionId}`.execute(executor)).rows;
    return rows[0] === undefined ? 0n : BigInt(rows[0].seq);
  }

  private async readEventByToolCall(sessionId: string, toolCallId: string,
    executor: DbExecutor = this.db): Promise<EventRow | undefined> {
    const rows = (await sql<EventRow>`select session_id, scope_key, version, items, tool_call_id,
        request_digest, created_at from assist_session_todo_events
      where session_id = ${sessionId} and tool_call_id = ${toolCallId}`.execute(executor)).rows;
    return rows[0];
  }

  /**
   * 恢复核对入口：这次调用当初有没有真的提交过事件。
   *
   * 恢复路径必须先看这一位再决定动作：事件存在 = 快照事务已提交，可以走原身份重放；
   * 事件不存在 = 写入从未发生，任何「再写一遍」都是重新执行，不属于恢复。
   */
  async hasCommittedEvent(sessionId: string, toolCallId: string): Promise<boolean> {
    return await this.readEventByToolCall(sessionId, toolCallId) !== undefined;
  }

  /**
   * 原调用的回执。
   *
   * 历史调用被重放（任务重试、快照已提交但工具未结算就退出）时，答案只能是它当初写下的
   * 那一版：版本号不递增、不再写事件。同一调用 ID 换一份载荷是身份伪造，明确拒绝。
   */
  private async replay(event: EventRow, input: TodoWriteInput): Promise<TodoWriteOutcome> {
    const storedItems = parseTodoItems(event.items);
    const digest = requestDigest(input.items, input.expectedVersion);
    const matches = event.request_digest === null
      ? legacyPayloadMatches(storedItems, input.items)
      : event.request_digest === digest;
    if (!matches) {
      throw new TodoRequestRejected('TODO_TOOL_CALL_CONFLICT',
        '这个工具调用 ID 已经写过另一份清单（版本、条目或状态不同）；同一调用不能换载荷重放，请用新的调用提交。');
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

    const seq = await this.scopeSeq(trx, input.sessionId, scopeKey);
    const current = await this.readSnapshotRow(trx, input.sessionId);
    // 轮次顺序闸门：旧轮次的写入不得改写新轮次的当前投影。
    if (current !== undefined && BigInt(current.scope_seq) > seq) {
      throw new TodoRequestRejected('TODO_SCOPE_STALE',
        '这个工作轮次已经被更新的一轮取代；旧轮次的写入不会改写当前清单。' +
        '如果你确实在继续当前这一轮，请按当前轮次重新读取清单再提交。');
    }
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
    const digest = requestDigest(input.items, expected);
    const inserted = (await sql<{ id: string }>`insert into assist_session_todo_events
      (id, session_id, workspace_id, scope_key, scope_seq, version, items, tool_call_id, message_id,
        origin_version, request_digest)
      values (${randomUUID()}, ${input.sessionId}, ${input.workspaceId}, ${scopeKey}, ${seq.toString()},
        ${version}, ${JSON.stringify(items)}::jsonb, ${input.toolCallId}, ${input.messageId},
        ${currentVersion}, ${digest})
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
      (session_id, workspace_id, scope_key, scope_seq, version, items, in_progress_limit,
        last_tool_call_id, last_message_id, updated_at)
      values (${input.sessionId}, ${input.workspaceId}, ${scopeKey}, ${seq.toString()}, ${version},
        ${JSON.stringify(items)}::jsonb, ${limit}, ${input.toolCallId}, ${input.messageId}, now())
      on conflict (session_id) do update set
        workspace_id = excluded.workspace_id, scope_key = excluded.scope_key,
        scope_seq = excluded.scope_seq, version = excluded.version, items = excluded.items,
        in_progress_limit = excluded.in_progress_limit,
        last_tool_call_id = excluded.last_tool_call_id,
        last_message_id = excluded.last_message_id, updated_at = excluded.updated_at
      where (assist_session_todo_snapshots.scope_seq, assist_session_todo_snapshots.version)
        < (excluded.scope_seq, excluded.version)
      returning ${SNAPSHOT_COLUMNS}`.execute(trx)).rows;
    const row = updated[0];
    if (row === undefined) {
      const after = await this.readSnapshotRow(trx, input.sessionId);
      if (after !== undefined && BigInt(after.scope_seq) > seq) {
        throw new TodoRequestRejected('TODO_SCOPE_STALE',
          '这个工作轮次已经被更新的一轮取代；旧轮次的写入不会改写当前清单。');
      }
      throw new TodoRequestRejected('TODO_VERSION_CONFLICT',
        '快照已经比这次写入更新；旧请求不得覆盖新快照。');
    }
    return { outcome: 'APPLIED', snapshot: projectTodoSnapshot(row) };
  }
}