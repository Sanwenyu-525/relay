import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ModelConnectionRow, WorkspaceDefaultModelConnectionRow } from
  '../infrastructure/database-schema.js';

/**
 * 模型连接登记的独占 SQL Owner（迁移 0143，ADR-036）。
 *
 * 边界：
 *   * 只做持久化。不发外呼、不解析凭据、不写 `model_calls`、不建 Task/Run。
 *   * 凭据秘密**不经过**这里：本表只有不透明引用；写入引用的是用例层，秘密由
 *     `credentials/` 的存储端口保管。
 *   * 更新一律走 revision CAS：并发或重放的写以 `expected_revision` 收敛，旧值不覆盖新值。
 *     返回 `undefined` 表示「该 revision 已不是当前值或该连接不在这个工作区」——
 *     两种情况对外都是冲突，由用例层区分。
 *   * 没有 DELETE。停用是状态：已冻结在旧连接上的 Run 需要原身份继续可读、可诊断。
 */

export class ModelConnectionNameTakenError extends Error {
  override readonly name: string = 'ModelConnectionNameTakenError';
  readonly connectionName: string;
  constructor(connectionName: string) {
    super(`a model connection named "${connectionName}" already exists in this workspace`);
    this.connectionName = connectionName;
  }
}

export interface NewModelConnection {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly baseUrl: string | null;
  readonly defaultModel: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly maxCallTokens: number;
  readonly maxScopeCalls: number;
  readonly maxScopeTokens: number;
  readonly credentialRef: string;
}

/** 可改字段。`undefined` 表示「本次不改」，与「改成 null」区分。 */
export interface ModelConnectionPatch {
  readonly name?: string | undefined;
  readonly baseUrl?: string | null | undefined;
  readonly defaultModel?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly maxCallTokens?: number | undefined;
  readonly maxScopeCalls?: number | undefined;
  readonly maxScopeTokens?: number | undefined;
}

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

export class ModelConnectionRepository {
  constructor(private readonly db: DbExecutor) {}

  async list(workspaceId: string): Promise<readonly ModelConnectionRow[]> {
    return (await sql<ModelConnectionRow>`select * from model_connections
      where workspace_id = ${workspaceId}
      order by created_at asc, id asc`.execute(this.db)).rows;
  }

  async read(workspaceId: string, id: string): Promise<ModelConnectionRow | undefined> {
    return (await sql<ModelConnectionRow>`select * from model_connections
      where workspace_id = ${workspaceId} and id = ${id}`.execute(this.db)).rows[0];
  }

  async create(input: NewModelConnection): Promise<ModelConnectionRow> {
    try {
      return (await sql<ModelConnectionRow>`insert into model_connections (
        id, workspace_id, name, provider_kind, base_url, default_model,
        timeout_ms, max_output_tokens, max_call_tokens, max_scope_calls, max_scope_tokens,
        credential_ref
      ) values (
        ${input.id}, ${input.workspaceId}, ${input.name}, 'openai-compatible', ${input.baseUrl},
        ${input.defaultModel}, ${input.timeoutMs}, ${input.maxOutputTokens},
        ${input.maxCallTokens}, ${input.maxScopeCalls}, ${input.maxScopeTokens},
        ${input.credentialRef}
      ) returning *`.execute(this.db)).rows[0]!;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ModelConnectionNameTakenError(input.name);
      throw error;
    }
  }

  /**
   * CAS 更新。`expectedRevision` 不符 → 返回 undefined（冲突）。
   *
   * 预算的跨列约束（单次 ≤ 作用域、输出 ≤ 单次）由表 CHECK 保证；这里不做二次判断，
   * 因为部分更新时应用层看到的是「合并后的整行」，判断点只有一处才不会分叉。
   */
  async update(workspaceId: string, id: string, expectedRevision: bigint,
    patch: ModelConnectionPatch): Promise<ModelConnectionRow | undefined> {
    const sets = [sql`revision = revision + 1`, sql`updated_at = now()`];
    if (patch.name !== undefined) sets.push(sql`name = ${patch.name}`);
    if (patch.baseUrl !== undefined) sets.push(sql`base_url = ${patch.baseUrl}`);
    if (patch.defaultModel !== undefined) sets.push(sql`default_model = ${patch.defaultModel}`);
    if (patch.timeoutMs !== undefined) sets.push(sql`timeout_ms = ${patch.timeoutMs}`);
    if (patch.maxOutputTokens !== undefined) {
      sets.push(sql`max_output_tokens = ${patch.maxOutputTokens}`);
    }
    if (patch.maxCallTokens !== undefined) sets.push(sql`max_call_tokens = ${patch.maxCallTokens}`);
    if (patch.maxScopeCalls !== undefined) {
      sets.push(sql`max_scope_calls = ${patch.maxScopeCalls}`);
    }
    if (patch.maxScopeTokens !== undefined) {
      sets.push(sql`max_scope_tokens = ${patch.maxScopeTokens}`);
    }
    if (sets.length === 2) {
      // 没有可改字段：不制造空更新、不推进 revision，但仍按 CAS 语义返回当前行。
      const current = await this.read(workspaceId, id);
      return current !== undefined && current.revision === expectedRevision ? current : undefined;
    }
    try {
      return (await sql<ModelConnectionRow>`update model_connections set ${sql.join(sets, sql`, `)}
        where workspace_id = ${workspaceId} and id = ${id} and revision = ${expectedRevision}
        returning *`.execute(this.db)).rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) throw new ModelConnectionNameTakenError(String(patch.name));
      throw error;
    }
  }

  /**
   * 轮换凭据引用：换引用、`credential_version + 1`、`revision + 1`，同一 CAS 语句完成。
   *
   * 三件事必须原子：如果版本没跟着变，冻结在旧凭据上的调用就不会发现「凭据已换」，
   * 会继续拿旧身份外呼——正是 P0-2 要拦的情形。
   */
  async rotateCredential(workspaceId: string, id: string, expectedRevision: bigint,
    credentialRef: string): Promise<ModelConnectionRow | undefined> {
    return (await sql<ModelConnectionRow>`update model_connections set
      credential_ref = ${credentialRef},
      credential_version = credential_version + 1,
      revision = revision + 1, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${id} and revision = ${expectedRevision}
      returning *`.execute(this.db)).rows[0];
  }

  /** 工作区默认连接（0144）。放在同一仓库上，避免调用方为「一条默认值」再记一个仓库名。 */
  async readDefault(workspaceId: string): Promise<WorkspaceDefaultModelConnectionRow | undefined> {
    return new WorkspaceDefaultModelConnectionRepository(this.db).read(workspaceId);
  }

  async setDefault(workspaceId: string, connectionId: string):
  Promise<WorkspaceDefaultModelConnectionRow | undefined> {
    return new WorkspaceDefaultModelConnectionRepository(this.db).setDefault(workspaceId,
      connectionId);
  }

  async setStatus(workspaceId: string, id: string, expectedRevision: bigint,
    status: 'ACTIVE' | 'DISABLED'): Promise<ModelConnectionRow | undefined> {
    return (await sql<ModelConnectionRow>`update model_connections set
      status = ${status}, revision = revision + 1, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${id} and revision = ${expectedRevision}
      returning *`.execute(this.db)).rows[0];
  }
}

/**
 * 工作区默认模型连接（迁移 0144）。
 *
 * 只表达「新 Run 从哪条连接冻结」。它**不**写回进程配置，也**不**改会话选择——两者的作用域
 * 不同（会话选择是聊天用哪个模型），混写会让「为什么这个 Run 用了这个模型」无法回答。
 *
 * `setDefault` 是幂等的：指向同一条连接时不推进 revision，调用方无需先读后写。
 */
export class WorkspaceDefaultModelConnectionRepository {
  constructor(private readonly db: DbExecutor) {}

  async read(workspaceId: string): Promise<WorkspaceDefaultModelConnectionRow | undefined> {
    return (await sql<WorkspaceDefaultModelConnectionRow>`select * from
      workspace_default_model_connection where workspace_id = ${workspaceId}`
      .execute(this.db)).rows[0];
  }

  /** 设置默认连接；连接必须属于同一工作区（跨工作区一律按「连接不存在」处理）。 */
  async setDefault(workspaceId: string, connectionId: string):
  Promise<WorkspaceDefaultModelConnectionRow | undefined> {
    const connection = await sql<{ id: string }>`select id from model_connections
      where workspace_id = ${workspaceId} and id = ${connectionId}`
      .execute(this.db);
    if (connection.rows.length === 0) return undefined;
    const updated = await sql<WorkspaceDefaultModelConnectionRow>`
      insert into workspace_default_model_connection (workspace_id, connection_id)
      values (${workspaceId}, ${connectionId})
      on conflict (workspace_id) do update set
        connection_id = excluded.connection_id,
        revision = workspace_default_model_connection.revision + 1,
        updated_at = now()
      where workspace_default_model_connection.connection_id <> excluded.connection_id
      returning *`.execute(this.db);
    if (updated.rows[0] !== undefined) return updated.rows[0];
    // 已经是这条连接：不推进 revision，直接回读当前行。
    return this.read(workspaceId);
  }
}
