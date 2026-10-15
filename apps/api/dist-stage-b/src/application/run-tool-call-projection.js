import { RunToolCallRepository } from '../run/run-tool-call-repository.js';
import { resourceNotFound } from './domain-error.js';
import { requireWorkspaceVisible } from './guards.js';
import { createRepositories } from './unit-of-work.js';
/** 历史行可能来自更早的部署，参数形状不再受当前词表约束；非对象一律按空对象投影，不让整份轨迹失败。 */
function asObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}
function projectCall(row) {
    return {
        id: row.id,
        round: row.round,
        ordinal: row.ordinal,
        tool_name: row.tool_name,
        status: row.status,
        arguments: asObject(row.arguments),
        arguments_sha256: row.arguments_sha256,
        provider_tool_call_id: row.provider_tool_call_id,
        operation_id: row.operation_id,
        result_ref: row.result_ref,
        adaptation_of: row.adaptation_of,
        adapted_path: row.adapted_path,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
    };
}
/**
 * 按 (round, ordinal) 升序分组。不依赖入参顺序：仓储已排序，这里再排一次是为了让
 * 投影对任意输入都给出同一形状，前端因此不需要二次排序。
 */
export function projectRunToolCalls(run, rows) {
    const byRound = new Map();
    for (const row of rows) {
        const bucket = byRound.get(row.round);
        if (bucket === undefined)
            byRound.set(row.round, [row]);
        else
            bucket.push(row);
    }
    const rounds = [...byRound.keys()].sort((left, right) => left - right).map((round) => {
        const bucket = (byRound.get(round) ?? []).slice()
            .sort((left, right) => left.ordinal - right.ordinal);
        return {
            round,
            // 同一轮的请求都来自同一次模型调用；出现不同值说明事实被改写过，按首次出现如实呈现。
            model_call_id: bucket[0]?.model_call_id ?? '',
            calls: bucket.map(projectCall),
        };
    });
    return { run_id: run.id, run_status: run.status, wait_reason: run.wait_reason, rounds };
}
/**
 * 只读投影的 I/O 入口。跨作用域与不可见 ID 一律 404；没有工具请求的 Run 返回空轮次，
 * 那是一个事实而不是读取失败。
 */
export async function readRunToolCalls(db, workspaceId, runId) {
    await requireWorkspaceVisible(db, workspaceId);
    const repositories = createRepositories(db);
    const run = await repositories.runs.readRun(runId);
    if (run === undefined || run.workspace_id !== workspaceId)
        throw resourceNotFound('Run');
    const rows = await new RunToolCallRepository(db).listByRun(run.id);
    return projectRunToolCalls(run, rows);
}
