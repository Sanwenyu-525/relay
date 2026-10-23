/**
 * 会话基线的持久化（工作台 §34.3 / 迁移 0097）。
 *
 * 应用层是基线「建立 / 读取 / 失效」的唯一协调入口；本仓库只负责落库与查询，不拥有
 * 任何业务判定。基线行不可变：建立后不更新，目录切换/失权由上层按新根路径产生新段或隐藏。
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { canonicalRelativePath, isProtectedPath } from '../files/file-changeset.js';
import type { BaselineFile } from './diff-engine.js';

/** 落库后的基线文件形态（jsonb 内一条）。 */
export interface StoredBaselineFile {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly text: string | null;
  readonly line_count: number | null;
  readonly unavailable_reason: string | null;
}

/** 一条已持久化的会话基线（统计段）。 */
export interface StoredBaseline {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly resourceId: string;
  readonly rootPath: string;
  readonly capturedAt: Date;
  readonly files: readonly StoredBaselineFile[];
  readonly incomplete: boolean;
  readonly captureReason: string;
  readonly revision: bigint;
}

export interface SaveBaselineInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly resourceId: string;
  readonly rootPath: string;
  readonly files: readonly BaselineFile[];
  readonly incomplete: boolean;
  readonly captureReason: string;
}

/** 把采集到的 BaselineFile 规整为可存 jsonb 的 StoredBaselineFile。 */
export function toStoredFiles(files: readonly BaselineFile[]): StoredBaselineFile[] {
  return files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    size_bytes: file.sizeBytes,
    text: file.text,
    line_count: file.lineCount,
    unavailable_reason: file.unavailableReason,
  }));
}

export interface ConversationDiffRepository {
  /** 原子发布一条基线；若同 (workspace,session,resource,root) 已存在则复用，保证只一个有效起点（CD-08 并发）。 */
  saveBaseline(input: SaveBaselineInput): Promise<StoredBaseline>;
  /** 读当前根路径下最新的基线（用于「会话起点」）；按 (workspace,session,resource,root) 全键过滤，避免跨资源段串读。 */
  readLatestBaseline(workspaceId: string, sessionId: string, resourceId: string, rootPath: string): Promise<StoredBaseline | undefined>;
  /**
   * 本会话**实际落盘**的相对路径（会话口径的唯一归因来源，2026-10-20）。
   *
   * 两处真实写账本的并集：
   *   ① 委派执行：会话的执行请求 → Run → `change_sets` → `change_set_files`；
   *   ② 会话直写（0126）：`session_tool_calls` 的 `apply_changeset` → `logical_operations`，
   *      取 prepare 校验后冻结的 `params.changes`。这条路径不经过 Run，也不会写
   *      `change_sets`，漏掉它会让聊天里新建的文件在会话 diff 中完全消失（DEV-0107）。
   *
   * **模型声明过但没落盘的路径不算**（用户 2026-10-20 明确「完全不出现」）：声明只代表打算改，
   * 若把「候选/被拒请求」也算进来，别人恰好在同一个窗口里改了那个文件时，就会把别人的改动
   * 记到本会话头上。因此直写只认已结算或结果未知的行，被拒与在途请求不进入归因。
   *
   * 按 `rootPath` 过滤：换过目录的会话，旧根写过的相对路径不能算进新根这一段（否则会在新段里
   * 变成「扫描没覆盖到」的假缺口）。直写行没有自己的根列，用 Operation 准备时冻结的
   * `normalized_target`（APPLY_CHANGESET 恒为受管根）核对。
   *
   * 这里只回答「哪些路径属于这个会话」，不回答「改了多少行」：行数仍由基线→当前内容算出，
   * 所以写了又改回原样的路径会因摘要相同而自然消失。
   */
  listWrittenPaths(workspaceId: string, sessionId: string, rootPath: string): Promise<readonly string[]>;
}

export class KyselyConversationDiffRepository implements ConversationDiffRepository {
  constructor(private readonly db: DbExecutor) {}

  async saveBaseline(input: SaveBaselineInput): Promise<StoredBaseline> {
    const id = randomUUID();
    const filesJson = JSON.stringify(toStoredFiles(input.files));
    await sql`
      insert into conversation_diff_baselines
        (id, workspace_id, session_id, resource_id, root_path, files, incomplete, capture_reason)
      values (${id}, ${input.workspaceId}, ${input.sessionId}, ${input.resourceId},
        ${input.rootPath}, ${filesJson}::jsonb, ${input.incomplete}, ${input.captureReason})
      on conflict (workspace_id, session_id, resource_id, root_path) do nothing
    `.execute(this.db);
    const row = await sql<BaselineRow>`
      select * from conversation_diff_baselines
      where workspace_id = ${input.workspaceId} and session_id = ${input.sessionId}
        and resource_id = ${input.resourceId} and root_path = ${input.rootPath}
      order by captured_at desc limit 1
    `.execute(this.db);
    const found = row.rows[0];
    if (found === undefined) throw new Error('CONVERSATION_DIFF_BASELINE_NOT_READABLE');
    return mapRow(found);
  }

  async readLatestBaseline(workspaceId: string, sessionId: string, resourceId: string,
    rootPath: string): Promise<StoredBaseline | undefined> {
    const row = await sql<BaselineRow>`
      select * from conversation_diff_baselines
      where workspace_id = ${workspaceId} and session_id = ${sessionId}
        and resource_id = ${resourceId} and root_path = ${rootPath}
      order by captured_at desc limit 1
    `.execute(this.db);
    const found = row.rows[0];
    return found === undefined ? undefined : mapRow(found);
  }

  async listWrittenPaths(workspaceId: string, sessionId: string,
    rootPath: string): Promise<readonly string[]> {
    const rows = (await sql<{ path: string }>`
      select distinct path from (
        select f.relative_path as path
          from conversation_execution_requests q
          join change_sets cs on cs.run_id = q.run_id and cs.workspace_id = q.workspace_id
          join change_set_files f on f.change_set_id = cs.id and f.invocation_id = cs.invocation_id
         where q.workspace_id = ${workspaceId} and q.session_id = ${sessionId}
           and cs.status in ('SUCCEEDED', 'PARTIAL', 'UNKNOWN')
           and cs.canonical_root = ${rootPath}
           and f.relative_path <> ''
        union all
        select change->>'path' as path
          from session_tool_calls stc
          join logical_operations op on op.id = stc.operation_id
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(op.params->'changes') = 'array'
              then op.params->'changes' else '[]'::jsonb end) as change
         where stc.session_id = ${sessionId}
           and stc.tool_name = 'apply_changeset'
           and stc.status in ('SETTLED', 'UNKNOWN')
           and op.workspace_id = ${workspaceId}
           and op.origin = 'AGENT_SESSION_WRITE'
           and op.action_type = 'APPLY_CHANGESET'
           and op.normalized_target = ${rootPath}
           and change->>'path' <> ''
      ) written
      order by path
    `.execute(this.db)).rows;
    // prepare 校验过路径安全，但冻结参数保留的是调用方写法（`./a`、反斜杠等）。
    // 归因要和基线/当前扫描的同一相对形态对齐，否则写过的文件会因字符串不同被漏掉。
    const paths = new Set<string>();
    for (const row of rows) {
      try {
        const path = canonicalRelativePath(rootPath, row.path);
        if (path !== '' && !isProtectedPath(path)) paths.add(path);
      } catch {
        // 路径已不可能是本次根内的合法目标：不把它变成假缺口。
      }
    }
    return [...paths].sort();
  }
}

interface BaselineRow {
  id: string;
  workspace_id: string;
  session_id: string;
  resource_id: string;
  root_path: string;
  captured_at: Date;
  files: JsonObject;
  incomplete: boolean;
  capture_reason: string;
  revision: bigint;
}

function mapRow(row: BaselineRow): StoredBaseline {
  const files = Array.isArray(row.files) ? (row.files as unknown as StoredBaselineFile[]) : [];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    resourceId: row.resource_id,
    rootPath: row.root_path,
    capturedAt: row.captured_at,
    files,
    incomplete: row.incomplete,
    captureReason: row.capture_reason,
    revision: row.revision,
  };
}
