import { createHash } from 'node:crypto';

import { SessionToolCallRepository, type SessionToolCallRow } from '../assist/session-tool-call-repository.js';
import { SessionTodoRepository } from '../assist/session-todo-repository.js';
import { buildTodoToolResult, TodoRequestRejected, type TodoSnapshot } from '../assist/session-todos.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { AssistMessageRow, AssistSessionRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { createRepositories } from './unit-of-work.js';

/**
 * `todo_write` 的结算（ADR-038）。
 *
 * 这个工具是**应用内动作**：它没有 Gateway 动作类型，也不产生 Operation、审批或执行候选。
 * 把它挂在 Gateway 上会是一条谎话——它既不是外部系统动作，也没有「外部事实」要核对。
 * 因此结算与 `delegate_subagent` 同形：工具账本记这一行（REQUESTED → SETTLED / REJECTED），
 * 结果摘要进 `result_digest`，不碰 Task / Run / Verification 的任何完成事实。
 *
 * 拒绝一律**类型化 + 无副作用**：校验不通过时不写事件、不更新快照，模型拿到原因码后
 * 可以自己改成合法的一版再提交。
 */

/** 清单已保存但账本没结算：不静默当成功，留给恢复路径按原调用身份重结算。 */
export class TodoSettlementIncomplete extends Error {
  constructor(readonly toolCallId: string) {
    super(`待办清单已保存，但工具账本未结算（${toolCallId}）；恢复时会按原调用身份重结算。`);
    this.name = 'TodoSettlementIncomplete';
  }
}

/** 结算摘要的单一来源：同一次写入在「正常结算」与「崩溃后恢复」必须算出同一个值。 */
export function todoSettlementDigest(snapshot: TodoSnapshot): string {
  const content = buildTodoToolResult(snapshot);
  return createHash('sha256').update(canonicalizeJson(JSON.parse(content) as JsonObject),
    'utf8').digest('hex');
}

async function settleOnce(repository: SessionToolCallRepository, id: string,
  digest: string): Promise<boolean> {
  try {
    return await repository.settleTodoWrite(id, digest);
  } catch {
    return false;
  }
}

export interface TodoToolCallSettlement {
  readonly providerToolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly isError: boolean;
}

export async function settleTodoWriteCall(db: DbExecutor, input: {
  readonly session: AssistSessionRow;
  readonly message: AssistMessageRow;
  readonly row: SessionToolCallRow;
  readonly repository: SessionToolCallRepository;
  readonly call: { readonly providerToolCallId: string; readonly name: string;
    readonly arguments: JsonObject };
}): Promise<TodoToolCallSettlement> {
  const repository = input.repository;
  const refuse = async (reason: string, detail: string): Promise<TodoToolCallSettlement> => {
    await repository.reject(input.row.id, reason, detail);
    return { providerToolCallId: input.call.providerToolCallId, name: input.call.name,
      content: JSON.stringify({ status: 'REJECTED', reason, detail }), isError: true };
  };

  const rawExpected = input.call.arguments.expected_version;
  if (rawExpected !== undefined && (typeof rawExpected !== 'number' ||
      !Number.isInteger(rawExpected) || rawExpected < 0)) {
    return refuse('TODO_ARGUMENTS_INVALID',
      'expected_version 必须是非负整数：清单还没写过时写 0，否则写你读到的那一版版本号。');
  }
  try {
    const written = await new SessionTodoRepository(db).write({
      sessionId: input.session.id,
      workspaceId: input.session.workspace_id,
      messageId: input.message.id,
      toolCallId: input.row.id,
      items: input.call.arguments.items,
      expectedVersion: typeof rawExpected === 'number' ? rawExpected : undefined,
    });
    const content = buildTodoToolResult(written.snapshot);
    const digest = todoSettlementDigest(written.snapshot);
    // 结算不能“当成了就完了”（2026-10-30 第三轮）：清单已 durable，但账本没落地时，
    // 必须能分辨“已经结算过”与“根本没结算”。先看返回值，再回读账本，仍不行就重试一次；
    // 三条都不成立时抛错——留给恢复路径重新结算（行仍是 REQUESTED，幂等判定在事件表上）。
    let settled = await settleOnce(repository, input.row.id, digest);
    if (!settled) {
      const after = await repository.read(input.row.id);
      if (after !== undefined && after.status === 'SETTLED' && after.result_digest === digest) {
        settled = true;
      } else {
        settled = await settleOnce(repository, input.row.id, digest);
      }
    }
    if (!settled) {
      throw new TodoSettlementIncomplete(input.row.id);
    }
    return { providerToolCallId: input.call.providerToolCallId, name: input.call.name,
      content, isError: false };
  } catch (error) {
    if (error instanceof TodoRequestRejected) {
      return refuse(error.reason, error.message);
    }
    throw error;
  }
}

export interface TodoWriteReconciliation {
  /** 本次按原调用身份补结算成功的账本行 id。 */
  readonly settled: readonly string[];
  /** 无法确认的调用数：事件不存在（写入事务没提交过）或核对失败，保持 REQUESTED 可诊断。 */
  readonly unconfirmed: number;
}

/**
 * `todo_write` 账本的崩溃恢复（ADR-038，2026-10-30 四轮）。
 *
 * 写入与结算之间不是原子的：快照/事件在同一事务里提交成功后，Worker 可能在
 * `settleTodoWrite` 之前退出（TodoSettlementIncomplete 抛出、进程重启、租约清扫）。
 * 那条 REQUESTED 行在 TL-12 里靠「同身份再调一次」恢复，但生产里没人负责再调——
 * 本用例就是这个恢复路径：每次生成 tick 的租约清扫之后跑一遍有界扫描。
 *
 * 三条纪律（与写入侧的幂等语义一致）：
 *   1. **只核对、不重做。** 事件表里已有 `(session_id, tool_call_id)` 的调用走原身份
 *      重放（`write()` 的幂等路径），拿回当初那一版，不新增事件、不递增版本；
 *   2. **事件不存在的调用保持 REQUESTED。** 说明写入事务从未提交过，没有任何已成功的
 *      写入可恢复——重新执行它等于替一条已经失败（LEASE_LOST）的生成伪造进度；
 *   3. **核对失败的调用保持 REQUESTED。** 同身份异载荷（`TODO_TOOL_CALL_CONFLICT`）是
 *      需要人工核对的异常，不吞掉、不伪装成结算成功，由下一轮继续可见。
 */
export async function reconcileTodoWriteSettlements(db: DbExecutor,
  options?: { readonly limit?: number }): Promise<TodoWriteReconciliation> {
  const repository = new SessionToolCallRepository(db);
  // 有界扫描：单用户规模下 REQUESTED 积压很少；上限只是防御 tick 被异常积压拖长。
  const pending = await repository.listPendingTodoWrites(options?.limit ?? 200);
  if (pending.length === 0) return { settled: [], unconfirmed: 0 };
  const todos = new SessionTodoRepository(db);
  const settled: string[] = [];
  let unconfirmed = 0;
  for (const row of pending) {
    const session = await createRepositories(db).assist.readSession(row.session_id);
    if (session === undefined) { unconfirmed += 1; continue; }
    // 事件表里没有这条调用 = 快照事务没提交过。先核对再动作：这里若直接走写入口，
    // 会把一次从未提交的写入重新执行成新事件——那是替一条已失败的生成伪造进度。
    if (!await todos.hasCommittedEvent(row.session_id, row.id)) { unconfirmed += 1; continue; }
    const argumentsValue = row.arguments as { items?: unknown; expected_version?: unknown };
    const rawExpected = argumentsValue.expected_version;
    try {
      // 原身份重放：write() 命中事件走幂等路径，返回当初那一版，不新增事件、不递增版本。
      const outcome = await todos.write({ sessionId: row.session_id,
        workspaceId: session.workspace_id, messageId: row.message_id, toolCallId: row.id,
        items: argumentsValue.items,
        expectedVersion: typeof rawExpected === 'number' ? rawExpected : undefined });
      if (outcome.outcome !== 'IDEMPOTENT') { unconfirmed += 1; continue; }
      if (await repository.settleTodoWrite(row.id, todoSettlementDigest(outcome.snapshot))) {
        settled.push(row.id);
      } else {
        unconfirmed += 1;
      }
    } catch {
      // 同身份异载荷或会话状态异常：保持 REQUESTED 可诊断，不让一条毒行拖垮整个 tick。
      unconfirmed += 1;
    }
  }
  return { settled, unconfirmed };
}