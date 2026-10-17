/**
 * 工具调用生成中预览的持久化（迁移 0102 / 工作台 §34.4）。
 *
 * 一行 = 一次模型调用里某个 ordinal 的可丢弃预览。应用层负责解析与行数计算，本仓库只做
 * 落库与读取：upsert、按 run 读取、以及整轮落库/失败/取消后的清理。旧 revision 不能覆盖
 * 新值，因此更新带 revision 条件（CD-15）。
 */

import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import type { RunToolCallPreviewRow } from '../infrastructure/database-schema.js';
import type { ToolPreviewFile } from './tool-call-preview.js';

export interface ToolCallPreviewRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly modelCallId: string;
  readonly ordinal: number;
  readonly toolName: string;
  readonly files: readonly ToolPreviewFile[];
  readonly truncated: boolean;
  readonly revision: bigint;
  readonly updatedAt: Date;
}

export interface UpsertToolCallPreviewInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly modelCallId: string;
  readonly ordinal: number;
  readonly toolName: string;
  readonly files: readonly ToolPreviewFile[];
  readonly truncated: boolean;
}

export interface ToolCallPreviewRepository {
  upsert(input: UpsertToolCallPreviewInput): Promise<void>;
  /**
   * 只返回**模型调用仍在 STARTED** 的预览：调用一结算（完成/失败/取消）或进程崩溃后
   * 被恢复标记，这一行的模型调用就不再是 STARTED，读接口也就不会再把它展示为「生成中」。
   */
  listActiveByRun(workspaceId: string, runId: string): Promise<readonly ToolCallPreviewRecord[]>;
  /** 整轮落库/失败/取消后的清理；幂等，重复调用无副作用。 */
  deleteForCall(workspaceId: string, modelCallId: string): Promise<void>;
}

/** 行 → 记录；jsonb 形状损坏时按空数组处理，不把畸形数据当预览展示。 */
export function mapPreviewRow(row: RunToolCallPreviewRow): ToolCallPreviewRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    modelCallId: row.model_call_id,
    ordinal: row.ordinal,
    toolName: row.tool_name,
    files: parsePreviewFiles(row.files),
    truncated: row.truncated,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function parsePreviewFiles(value: JsonObject): ToolPreviewFile[] {
  if (!Array.isArray(value)) return [];
  const files: ToolPreviewFile[] = [];
  for (const entry of value as readonly JsonValue[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const file = entry as JsonObject;
    if (typeof file.path !== 'string' || file.path === '') continue;
    const action = file.action === 'CREATE' || file.action === 'MODIFY' || file.action === 'DELETE' ||
      file.action === 'UNKNOWN' ? file.action : 'UNKNOWN';
    files.push({
      path: file.path,
      action,
      added: typeof file.added === 'number' && Number.isInteger(file.added) ? file.added : -1,
      removed: typeof file.removed === 'number' && Number.isInteger(file.removed) ? file.removed : -1,
      targetComplete: file.target_complete === true,
    });
  }
  return files;
}

export class KyselyToolCallPreviewRepository implements ToolCallPreviewRepository {
  constructor(private readonly db: DbExecutor) {}

  async upsert(input: UpsertToolCallPreviewInput): Promise<void> {
    const filesJson = JSON.stringify(input.files.map((file) => ({
      path: file.path,
      action: file.action,
      added: file.added,
      removed: file.removed,
      target_complete: file.targetComplete,
    })));
    await sql`
      insert into run_tool_call_previews
        (workspace_id, run_id, model_call_id, ordinal, tool_name, files, truncated)
      values (${input.workspaceId}, ${input.runId}, ${input.modelCallId}, ${input.ordinal},
        ${input.toolName}, ${filesJson}::jsonb, ${input.truncated})
      on conflict (workspace_id, model_call_id, ordinal) do update set
        tool_name = excluded.tool_name,
        files = excluded.files,
        truncated = excluded.truncated,
        revision = nextval('run_tool_call_preview_revision'),
        updated_at = now()
    `.execute(this.db);
  }

  async listActiveByRun(workspaceId: string, runId: string): Promise<readonly ToolCallPreviewRecord[]> {
    const result = await sql<RunToolCallPreviewRow>`
      select p.* from run_tool_call_previews p
      join model_calls c on c.id = p.model_call_id and c.workspace_id = p.workspace_id
      where p.workspace_id = ${workspaceId} and p.run_id = ${runId} and c.status = 'STARTED'
      order by p.updated_at, p.ordinal
    `.execute(this.db);
    return result.rows.map(mapPreviewRow);
  }

  async deleteForCall(workspaceId: string, modelCallId: string): Promise<void> {
    await sql`
      delete from run_tool_call_previews
      where workspace_id = ${workspaceId} and model_call_id = ${modelCallId}
    `.execute(this.db);
  }
}
