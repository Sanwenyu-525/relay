import { readFrozenActionOperationIds, readFrozenRunActions, } from '../workflow/execution-contract.js';
import { DomainError } from './domain-error.js';
/**
 * 一个 Run 冻结的动作可能不止一个：先按授权读取，再写文件并跑一次受限检查。
 * 这里只依据持久事实选择“下一个未成功落地的动作”，不重排顺序，也不新建动作身份。
 */
export async function readPendingFrozenRunAction(repositories, runId) {
    const contract = await repositories.runs.readContract(runId);
    if (contract === undefined)
        return undefined;
    const { read, writes } = readFrozenRunActions(contract.frozen_snapshot);
    const ordered = read === undefined ? writes : [read, ...writes];
    if (ordered.length === 0)
        return undefined;
    const byId = new Map(ordered.map((action) => [action.operation_id, action]));
    const rows = await Promise.all(readFrozenActionOperationIds(contract.frozen_snapshot)
        .map(async (id) => ({ id, operation: await repositories.gateway.readOperation(id) })));
    const settled = new Set(rows.filter((row) => row.operation?.status === 'SUCCEEDED')
        .map((row) => row.id));
    const pendingRow = rows.find((row) => !settled.has(row.id)) ?? rows[rows.length - 1];
    if (pendingRow === undefined)
        return undefined;
    const action = byId.get(pendingRow.id);
    if (action === undefined) {
        throw new DomainError({ code: 'FROZEN_ACTION_INVALID', status: 409,
            type: '/problems/frozen-action-invalid', title: '冻结动作无效',
            detail: '冻结 Run 契约声明的动作身份与冻结内容不一致。', retryable: false, retryAction: 'NONE' });
    }
    return { actionId: pendingRow.id, action, operation: pendingRow.operation, settled,
        allSettled: pendingRow === rows[rows.length - 1] && settled.size === rows.length };
}
