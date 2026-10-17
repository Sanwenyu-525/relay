import type { DbExecutor } from '../infrastructure/database.js';
import type { RunRow } from '../infrastructure/database-schema.js';
import { RunToolCallRepository } from '../run/run-tool-call-repository.js';
import { resourceNotFound } from './domain-error.js';
import { requireWorkspaceVisible } from './guards.js';
import { createRepositories } from './unit-of-work.js';
import type { ToolCallPreviewRecord } from '../conversation-diff/tool-call-preview-repository.js';

/**
 * Run 工具调用「生成中」预览只读投影（工作台 §34.4 / CD-09–11）。
 *
 * 这份投影是**临时证据**的出口：预览只说明「模型正在写出哪些文件、行数怎么变」，
 * 不代表请求已被接受、更不代表已经落盘。判定口径有三条：
 *   * 只有 Run 仍在 RUNNING 时才返回预览——终态 Run 不应再显示「正在生成」；
 *   * 仓储已按模型调用 STARTED 过滤，结算/崩溃后的残留不会再出现；
 *   * (model_call_id, ordinal) 已落成工具调用行的预览被剔除：真实行一开始就有定论，
 *     同一位置不能同时出现「正在生成」与「已派发」两种事实。
 *
 * `added`/`removed` 为 -1 表示待核对（目标未收全或无法可靠计算），调用方不得把它当 0。
 */

export interface RunToolCallPreviewFileDto {
  readonly path: string;
  readonly action: 'CREATE' | 'MODIFY' | 'DELETE' | 'UNKNOWN';
  readonly added: number;
  readonly removed: number;
  readonly target_complete: boolean;
}

export interface RunToolCallPreviewDto {
  readonly model_call_id: string;
  readonly ordinal: number;
  readonly tool_name: string;
  readonly revision: string;
  readonly truncated: boolean;
  readonly updated_at: string;
  readonly files: readonly RunToolCallPreviewFileDto[];
}

export interface RunToolCallPreviewProjection {
  readonly run_id: string;
  readonly previews: readonly RunToolCallPreviewDto[];
}

function projectPreview(preview: ToolCallPreviewRecord): RunToolCallPreviewDto {
  return {
    model_call_id: preview.modelCallId,
    ordinal: preview.ordinal,
    tool_name: preview.toolName,
    revision: preview.revision.toString(),
    truncated: preview.truncated,
    updated_at: preview.updatedAt.toISOString(),
    files: preview.files.map((file) => ({
      path: file.path,
      action: file.action,
      added: file.added,
      removed: file.removed,
      target_complete: file.targetComplete,
    })),
  };
}

export function projectRunToolCallPreviews(run: RunRow,
  previews: readonly ToolCallPreviewRecord[],
  settledKeys: ReadonlySet<string>): RunToolCallPreviewProjection {
  if (run.status !== 'RUNNING') return { run_id: run.id, previews: [] };
  const list = previews
    .filter((preview) => !settledKeys.has(`${preview.modelCallId}:${preview.ordinal}`))
    .sort((left, right) => left.ordinal - right.ordinal)
    .map(projectPreview);
  return { run_id: run.id, previews: list };
}

export async function readRunToolCallPreviews(db: DbExecutor, workspaceId: string,
  runId: string): Promise<RunToolCallPreviewProjection> {
  await requireWorkspaceVisible(db, workspaceId);
  const repositories = createRepositories(db);
  const run = await repositories.runs.readRun(runId);
  if (run === undefined || run.workspace_id !== workspaceId) throw resourceNotFound('Run');
  if (run.status !== 'RUNNING') return { run_id: run.id, previews: [] };
  const previews = await repositories.toolCallPreview.listActiveByRun(workspaceId, run.id);
  if (previews.length === 0) return { run_id: run.id, previews: [] };
  const toolRows = await new RunToolCallRepository(db).listByRun(run.id);
  const settledKeys = new Set(toolRows.map((row) => `${row.model_call_id}:${row.ordinal}`));
  return projectRunToolCallPreviews(run, previews, settledKeys);
}
