import { isPostgresError, POSTGRES_ERROR_CODES } from '../infrastructure/postgres-error.js';
import { computePayloadHash } from '../receipt/payload-hash.js';
import { createRepositories, withTransaction } from './unit-of-work.js';
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
    name = 'CommandIdReusedError';
    scopeKey;
    commandId;
    constructor(scopeKey, commandId) {
        super(`command_id ${commandId} in scope ${scopeKey} was already used with a different payload`);
        this.scopeKey = scopeKey;
        this.commandId = commandId;
    }
}
export async function runIdempotentCommand(db, request) {
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
                return resolveExistingReceipt(existing, payloadHash);
            }
            // Gate first, before all business row locks. Reread after waiting because
            // the original request may have committed while maintenance held the gate.
            const gate = await readAdmission(repositories, 'share');
            const committedWhileWaiting = await repositories.receipts.findReceipt({
                scopeKey: request.scopeKey, commandId: request.commandId,
            });
            if (committedWhileWaiting !== undefined) {
                return resolveExistingReceipt(committedWhileWaiting, payloadHash);
            }
            if (!isDrainControlCommand(request.commandType))
                requireNormalAdmission(gate);
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
    }
    catch (error) {
        return resolveReceiptAfterUniqueViolation(db, error, request.scopeKey, request.commandId, payloadHash);
    }
}
/**
 * 回执唯一约束冲突后的统一处理，供 `runIdempotentCommand` 与自定义事务入口共用。
 *
 * 冲突意味着本事务已经完整回滚（业务效果、审计、状态变更都不存在），所以只能用
 * **新的正常事务上下文**读一次胜出回执，再按原请求摘要决定结果：
 *   - 摘要相同 → 同一次操作的另一个视角，返回原成功回执；
 *   - 摘要不同 → 抛 `CommandIdReusedError`（HTTP 409 COMMAND_ID_REUSED）；
 *   - 不是唯一约束冲突，或读不到可核对的回执 → 原样抛出，不伪造成功。
 *
 * 候选行锁只能串行同一候选；同一 scope 下**不同**候选的两个请求会各自越过回执查询，
 * 最后才在这里相遇——这正是跨候选命令冲突必须走这条路径的原因。
 */
export async function resolveReceiptAfterUniqueViolation(db, error, scopeKey, commandId, payloadHash) {
    if (!isPostgresError(error, POSTGRES_ERROR_CODES.uniqueViolation))
        throw error;
    const winner = await createRepositories(db).receipts.findReceipt({ scopeKey, commandId });
    if (winner === undefined)
        throw error;
    return resolveExistingReceipt(winner, payloadHash);
}
export function resolveExistingReceipt(receipt, payloadHash) {
    if (!Buffer.from(receipt.payload_hash).equals(payloadHash)) {
        throw new CommandIdReusedError(receipt.scope_key, receipt.command_id);
    }
    return {
        result: receipt.result_ref,
        replayed: true,
        committedAt: receipt.created_at,
    };
}
