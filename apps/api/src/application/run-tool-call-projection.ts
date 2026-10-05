import type { DbExecutor } from '../infrastructure/database.js';
import type { RunRow, RunToolCallRow, RunToolCallStatus } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { RunToolCallRepository } from '../run/run-tool-call-repository.js';
import { resourceNotFound } from './domain-error.js';
import { requireWorkspaceVisible } from './guards.js';
import { createRepositories } from './unit-of-work.js';

/**
 * Run 工具调用只读投影（docs/api/http-command-contract.md §10.56）。
 *
 * 这份投影只做一件事：把「模型这一轮实际请求了什么、实际拿到了什么」原样摆出来。
 * 投影分两层是刻意的——`projectRunToolCalls` 是纯函数，可直接对行做判定；
 * `readRunToolCalls` 只负责作用域与 404，不解释任何内容。
 *
 * 两条不变量：
 *   * `arguments` 与 `result_ref` 逐字节透传。`result_ref` 是模型当时实际消费的那一份
 *     （run-tool-call-repository.ts 的 settle() 写明结果投影由调用方从 Operation 的
 *     result_ref 截取后写入），重新序列化会让界面与模型对不上账。
 *   * 不新增「摘要」或「人类可读结论」字段。那是第二套语义，等真有消费方再加；
 *     折叠行的一行摘要在前端现算，事实源只有这一份。
 */

export interface RunToolCallDto {
  readonly id: string;
  readonly round: number;
  readonly ordinal: number;
  readonly tool_name: string;
  readonly status: RunToolCallStatus;
  readonly arguments: JsonObject;
  readonly arguments_sha256: string;
  readonly provider_tool_call_id: string;
  readonly operation_id: string | null;
  readonly result_ref: JsonObject | null;
  readonly adaptation_of: string | null;
  readonly adapted_path: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RunToolCallRoundDto {
  readonly round: number;
  readonly model_call_id: string;
  readonly calls: readonly RunToolCallDto[];
}

export interface RunToolCallProjection {
  readonly run_id: string;
  readonly run_status: string;
  readonly wait_reason: string | null;
  readonly rounds: readonly RunToolCallRoundDto[];
}

/** 历史行可能来自更早的部署，参数形状不再受当前词表约束；非对象一律按空对象投影，不让整份轨迹失败。 */
function asObject(value: JsonObject): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function projectCall(row: RunToolCallRow): RunToolCallDto {
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
export function projectRunToolCalls(
  run: RunRow,
  rows: readonly RunToolCallRow[],
): RunToolCallProjection {
  const byRound = new Map<number, RunToolCallRow[]>();
  for (const row of rows) {
    const bucket = byRound.get(row.round);
    if (bucket === undefined) byRound.set(row.round, [row]);
    else bucket.push(row);
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
export async function readRunToolCalls(
  db: DbExecutor,
  workspaceId: string,
  runId: string,
): Promise<RunToolCallProjection> {
  await requireWorkspaceVisible(db, workspaceId);
  const repositories = createRepositories(db);
  const run = await repositories.runs.readRun(runId);
  if (run === undefined || run.workspace_id !== workspaceId) throw resourceNotFound('Run');
  const rows = await new RunToolCallRepository(db).listByRun(run.id);
  return projectRunToolCalls(run, rows);
}
