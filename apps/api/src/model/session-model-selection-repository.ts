import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { SessionModelSelectionRow } from '../infrastructure/database-schema.js';

/**
 * 会话模型选择的独占 SQL Owner（迁移 0089，专项阶段 C）。
 *
 * 用例负责开事务、读准入、绑定同一个执行器；本仓库不自开 transaction()/commit()，
 * 也不发外呼、不建 Task/Run、不写 model_calls，更不写回进程默认。
 * 写入是「CAS + revision 单调递增」：首次写以 INSERT 建 revision=1，后续写以
 * `revision = 期望值` 收窄，冲突即返回 null 由用例回 `SELECTION_REVISION_CONFLICT`。
 * 同一命令的重放由命令回执在 Owner 之前短路，不重复进入这里。
 */

export interface ApplySelectionInput {
  readonly sessionId: string;
  readonly connection: 'default' | 'openrouter';
  readonly model: string;
  readonly configFingerprint: string;
  readonly freeOnly: boolean;
  readonly catalogSource: 'openrouter' | null;
  /** 目录快照序号（digits 字符串避免 JS 精度丢失）；无目录依据时 null。 */
  readonly catalogSnapshotSeq: string | null;
  readonly catalogModelId: string | null;
  /** null 表示调用方认为本会话尚无选择（首次写）；非 null 表示以其为 CAS 基线。 */
  readonly expectedRevision: string | null;
  readonly commandId: string;
  readonly now: Date;
}

export class SessionModelSelectionRepository {
  constructor(private readonly db: DbExecutor) {}

  async readForSession(sessionId: string): Promise<SessionModelSelectionRow | undefined> {
    const result = await sql<SessionModelSelectionRow>`
      select * from session_model_selection where session_id = ${sessionId}
    `.execute(this.db);
    return result.rows[0];
  }

  /**
   * CAS 写入当前选择。返回落库后的整行；返回 null 表示基线不符（并发更新或首次写撞已存在行），
   * 调用方据此判冲突，绝不覆盖更新的值。
   */
  async applySelection(input: ApplySelectionInput): Promise<SessionModelSelectionRow | null> {
    if (input.expectedRevision === null) {
      const inserted = await sql<SessionModelSelectionRow>`
        insert into session_model_selection
          (session_id, connection, model, config_fingerprint, free_only, catalog_source,
           catalog_snapshot_seq, catalog_model_id, revision, selected_by_command_id, updated_at)
        values
          (${input.sessionId}, ${input.connection}, ${input.model}, ${input.configFingerprint},
           ${input.freeOnly}, ${input.catalogSource}, ${input.catalogSnapshotSeq}::bigint,
           ${input.catalogModelId}, 1, ${input.commandId}, ${input.now})
        on conflict (session_id) do nothing
        returning *
      `.execute(this.db);
      return inserted.rows[0] ?? null;
    }
    const updated = await sql<SessionModelSelectionRow>`
      update session_model_selection
      set connection = ${input.connection}, model = ${input.model},
        config_fingerprint = ${input.configFingerprint}, free_only = ${input.freeOnly},
        catalog_source = ${input.catalogSource}, catalog_snapshot_seq = ${input.catalogSnapshotSeq}::bigint,
        catalog_model_id = ${input.catalogModelId}, revision = revision + 1,
        selected_by_command_id = ${input.commandId}, updated_at = ${input.now}
      where session_id = ${input.sessionId} and revision = ${input.expectedRevision}::bigint
      returning *
    `.execute(this.db);
    return updated.rows[0] ?? null;
  }
}
