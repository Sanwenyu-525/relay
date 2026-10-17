import type { DbExecutor } from '../infrastructure/database.js';
import type { RunRow, RunToolCallRow, RunToolCallStatus } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { RunToolCallRepository } from '../run/run-tool-call-repository.js';
import { resourceNotFound } from './domain-error.js';
import { requireWorkspaceVisible } from './guards.js';
import { createRepositories } from './unit-of-work.js';
import { readFileWriteFrozenDiff } from './gateway-queries.js';
import { computeLineDiff } from '../conversation-diff/diff-engine.js';

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
  /** 写类工具的逐文件结算账本（工作台 §34.2）：冻结意图 + 实际回执，缺证据则空。 */
  readonly file_changes: readonly RunToolCallFileChangeDto[];
}

/**
 * 一次写入里单个文件的事实：`status` 来自适配器回执（APPLIED/CONFLICT/FAILED），
 * `added`/`removed` 只在冻结的两份文本都可统计时为真实行数，否则记 -1「待核对」。
 */
export interface RunToolCallFileChangeDto {
  readonly path: string;
  readonly action: 'CREATE' | 'MODIFY' | 'DELETE';
  readonly status: 'APPLIED' | 'CONFLICT' | 'FAILED' | 'UNKNOWN';
  /** -1 = 待核对（基线或目标文本不可用），绝不冒充 0。 */
  readonly added: number;
  readonly removed: number;
  readonly unavailable_reason: string | null;
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

function projectCall(row: RunToolCallRow,
  fileChanges: readonly RunToolCallFileChangeDto[]): RunToolCallDto {
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
    file_changes: fileChanges,
  };
}

/**
 * 按 (round, ordinal) 升序分组。不依赖入参顺序：仓储已排序，这里再排一次是为了让
 * 投影对任意输入都给出同一形状，前端因此不需要二次排序。
 */
export function projectRunToolCalls(
  run: RunRow,
  rows: readonly RunToolCallRow[],
  fileChangesByCall: ReadonlyMap<string, readonly RunToolCallFileChangeDto[]> = new Map(),
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
      calls: bucket.map((row) => projectCall(row, fileChangesByCall.get(row.id) ?? [])),
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
  const fileChanges = await readWriteCallFileChanges(db, workspaceId, rows);
  return projectRunToolCalls(run, rows, fileChanges);
}

/** 工具词表里的写类工具；与工具目录保持一致，新增写工具时同步。 */
const WRITE_TOOL_NAMES = new Set(['apply_changeset']);

/**
 * 写类工具的逐文件结算账本：冻结的两份文本（基线 + 目标）算行数，回执给实际状态。
 *
 * 缺证据（无操作、冻结文本不可用、行数超限）时如实记 -1「待核对」——
 * 局部记录不猜测，也不因为算不出行数就假装这次写入没发生。
 */
async function readWriteCallFileChanges(db: DbExecutor, workspaceId: string,
  rows: readonly RunToolCallRow[]): Promise<Map<string, readonly RunToolCallFileChangeDto[]>> {
  const result = new Map<string, readonly RunToolCallFileChangeDto[]>();
  for (const row of rows) {
    if (!WRITE_TOOL_NAMES.has(row.tool_name) || row.operation_id === null) continue;
    let frozen;
    try {
      frozen = await readFileWriteFrozenDiff(db, workspaceId, row.operation_id);
    } catch {
      continue;
    }
    const statuses = appliedStatuses(row.result_ref);
    result.set(row.id, frozen.files.map((file) => {
      const counts = file.availability === 'AVAILABLE' && file.before_text !== null &&
        file.after_text !== null
        ? computeLineDiff(file.before_text, file.after_text) : null;
      return {
        path: file.relative_path,
        action: file.action,
        status: statuses.get(normalizePath(file.relative_path)) ?? 'UNKNOWN',
        added: counts?.added ?? -1,
        removed: counts?.removed ?? -1,
        unavailable_reason: file.unavailable_reason,
      };
    }));
  }
  return result;
}

/**
 * 从文件写回执里取每个路径的实际状态。
 *
 * 回执路径以 `result_ref.file_write_receipt.result.changes[].path` 为准；形状不认识时
 * 全部落 UNKNOWN（调用方不得据此标「已修改」）。
 */
function appliedStatuses(resultRef: JsonObject | null):
  ReadonlyMap<string, RunToolCallFileChangeDto['status']> {
  const statuses = new Map<string, RunToolCallFileChangeDto['status']>();
  const receipt = resultRef?.file_write_receipt;
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return statuses;
  const result = (receipt as JsonObject).result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return statuses;
  const changes = (result as JsonObject).changes;
  if (!Array.isArray(changes)) return statuses;
  for (const entry of changes) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const change = entry as JsonObject;
    if (typeof change.path !== 'string') continue;
    const status = change.status === 'APPLIED' || change.status === 'CONFLICT' ||
      change.status === 'FAILED' ? change.status : 'UNKNOWN';
    statuses.set(normalizePath(change.path), status);
  }
  return statuses;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}
