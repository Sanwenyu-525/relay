import type { DbExecutor } from '../infrastructure/database.js';
import type { CommandReceiptRow } from '../infrastructure/database-schema.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import { isPostgresError, POSTGRES_ERROR_CODES } from '../infrastructure/postgres-error.js';
import { computePayloadHash } from '../receipt/payload-hash.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';
import { isDrainControlCommand, readAdmission, requireNormalAdmission } from './maintenance-admission.js';

/**
 * 命令回执与幂等执行基础。
 *
 * 顺序（依据 docs/api/http-command-contract.md 第 2 节）：
 *   1. 规范化输入并计算 payload_hash（command_id 与请求追踪 ID 不进入摘要）；
 *   2. 在同一事务内先查同 scope/command_id 的回执：存在且摘要一致 → 返回原结果；摘要不同 → 拒绝；
 *   3. 首次请求才执行业务回调，并把回执与业务事实在同一事务提交；
 *   4. 并发首次请求由唯一约束裁决：失败事务回滚后读取胜出回执，再比对摘要。
 */

export class CommandIdReusedError extends Error {
  override readonly name = 'CommandIdReusedError';

  readonly scopeKey: string;
  readonly commandId: string;

  constructor(scopeKey: string, commandId: string) {
    super(
      `command_id ${commandId} in scope ${scopeKey} was already used with a different payload`,
    );
    this.scopeKey = scopeKey;
    this.commandId = commandId;
  }
}

export type CommandResult = JsonObject;

export interface CommandRequest<TResult extends CommandResult> {
  /** 作用域：V1 为 Workspace（HTTP 命令再加上当前用户）。 */
  readonly scopeKey: string;
  readonly commandId: string;
  readonly commandType: string;
  /** 命令目标（资源 ID 等），调用方已补齐缺省值。 */
  readonly target: JsonValue;
  /** 命令内容，调用方已规范化；数组顺序按调用方给出的语义顺序。 */
  readonly body: JsonValue;
  readonly execute: (repositories: Repositories) => Promise<TResult>;
}

export interface CommandOutcome<TResult extends CommandResult> {
  /** 首次执行返回本次结果，重放返回当时保存的结果。 */
  readonly result: TResult;
  readonly replayed: boolean;
  readonly committedAt: Date;
}

export async function runIdempotentCommand<TResult extends CommandResult>(
  db: DbExecutor,
  request: CommandRequest<TResult>,
): Promise<CommandOutcome<TResult>> {
  const payloadHash = computePayloadHash({
    commandType: request.commandType,
    target: request.target,
    body: request.body,
  });

  try {
    return await withTransaction(db, async (repositories) => {
      const existing = await repositories.receipts.findReceipt({
        scopeKey: request.scopeKey,
        commandId: request.commandId,
      });

      if (existing !== undefined) {
        return resolveExistingReceipt<TResult>(existing, payloadHash);
      }

      // Gate first, before all business row locks. Reread after waiting because
      // the original request may have committed while maintenance held the gate.
      const gate = await readAdmission(repositories, 'share');
      const committedWhileWaiting = await repositories.receipts.findReceipt({
        scopeKey: request.scopeKey, commandId: request.commandId,
      });
      if (committedWhileWaiting !== undefined) {
        return resolveExistingReceipt<TResult>(committedWhileWaiting, payloadHash);
      }
      if (!isDrainControlCommand(request.commandType)) requireNormalAdmission(gate);

      const result = await request.execute(repositories);
      const receipt = await repositories.receipts.insertReceipt({
        scopeKey: request.scopeKey,
        commandId: request.commandId,
        commandType: request.commandType,
        payloadHash,
        result,
      });

      return {
        result,
        replayed: false,
        committedAt: receipt.created_at,
      };
    });
  } catch (error) {
    if (isPostgresError(error, POSTGRES_ERROR_CODES.uniqueViolation)) {
      // 事务已回滚，不能在失败上下文继续读；用新连接读胜出回执再决定是幂等重放还是冲突。
      const winner = await createRepositories(db).receipts.findReceipt({
        scopeKey: request.scopeKey,
        commandId: request.commandId,
      });

      if (winner !== undefined) {
        return resolveExistingReceipt<TResult>(winner, payloadHash);
      }
    }

    throw error;
  }
}

export function resolveExistingReceipt<TResult extends CommandResult>(
  receipt: CommandReceiptRow,
  payloadHash: Buffer,
): CommandOutcome<TResult> {
  if (!Buffer.from(receipt.payload_hash).equals(payloadHash)) {
    throw new CommandIdReusedError(receipt.scope_key, receipt.command_id);
  }

  return {
    result: receipt.result_ref as TResult,
    replayed: true,
    committedAt: receipt.created_at,
  };
}
