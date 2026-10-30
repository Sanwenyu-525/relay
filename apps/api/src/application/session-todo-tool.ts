import { createHash } from 'node:crypto';

import type { SessionToolCallRepository, SessionToolCallRow } from '../assist/session-tool-call-repository.js';
import { SessionTodoRepository } from '../assist/session-todo-repository.js';
import { buildTodoToolResult, TodoRequestRejected } from '../assist/session-todos.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { AssistMessageRow, AssistSessionRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';

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
      !Number.isInteger(rawExpected) || rawExpected < 1)) {
    return refuse('TODO_ARGUMENTS_INVALID',
      'expected_version 必须是正整数（你读到的那一版版本号）；省略表示不比对版本。');
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
    const digest = createHash('sha256').update(canonicalizeJson(JSON.parse(content) as JsonObject),
      'utf8').digest('hex');
    // 写入已 durable：结算失败只影响账本状态，不影响清单本身，因此不抛错也不改写结果。
    await repository.settleTodoWrite(input.row.id, digest);
    return { providerToolCallId: input.call.providerToolCallId, name: input.call.name,
      content, isError: false };
  } catch (error) {
    if (error instanceof TodoRequestRejected) {
      return refuse(error.reason, error.message);
    }
    throw error;
  }
}