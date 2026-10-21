import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';

/**
 * 自动捕获的记账（ADR-030）。
 *
 * 它不是「另一种记忆」：Memory 仍写在 memory_items / memory_versions /
 * memory_message_sources。这里只记「哪次提取、来自哪条消息、内容指纹、是否被撤销」，
 * 因此候选/自动记忆不会长成第二套正文。
 */
export interface MemoryAutoCaptureRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string | null;
  readonly session_id: string;
  readonly message_id: string;
  readonly source_sha256: string;
  readonly normalized_sha256: string;
  readonly memory_id: string;
  /** DEV-0042：这一条来自原消息的哪一段（逐字片段）。 */
  readonly source_quote: string;
  readonly status: 'ACTIVE' | 'RETIRED';
  readonly revision: bigint;
  readonly created_at: Date;
  readonly decided_at: Date | null;
  readonly decided_by: string | null;
}

export class MemoryCaptureRepository {
  constructor(private readonly db: DbExecutor) {}

  /**
   * 写入一次捕获。
   *
   * 唯一键 `(session_id, message_id, normalized_sha256)` 让重复触发变成空操作：
   * 同一消息重放、同一内容重复提取都不会写第二行，也不需要先查后写（那有并发窗口）。
   *
   * `sourceQuote` 是这一条对应的**原消息逐字片段**（DEV-0042）：来源类别由它核验而来，
   * 留在这里是为了事后能复核「这条记忆说的是哪一段」。
   */
  async insert(input: { id: string; workspaceId: string; projectId: string | null;
    sessionId: string; messageId: string; sourceSha256: string; normalizedSha256: string;
    memoryId: string; sourceQuote: string }): Promise<MemoryAutoCaptureRow | undefined> {
    return (await sql<MemoryAutoCaptureRow>`insert into memory_auto_captures
      (id, workspace_id, project_id, session_id, message_id, source_sha256, normalized_sha256,
        memory_id, source_quote)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.sessionId},
        ${input.messageId}, ${input.sourceSha256}, ${input.normalizedSha256}, ${input.memoryId},
        ${input.sourceQuote})
      on conflict (session_id, message_id, normalized_sha256) do nothing
      returning *`.execute(this.db)).rows[0];
  }

  /**
   * 同一来源同一内容的串行化锁。
   *
   * 冲突键相同只会排队，不阻塞别的会话；用它把「先查重再写入」的两个事务串起来，
   * 避免两个 Worker 同时提取同一条消息时各写一份 Memory。
   */
  async lockSource(key: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(this.db);
  }

  async byId(id: string, lock = false): Promise<MemoryAutoCaptureRow | undefined> {
    return (await sql<MemoryAutoCaptureRow>`select * from memory_auto_captures where id = ${id}
      ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }

  async list(workspaceId: string, limit: number): Promise<readonly MemoryAutoCaptureRow[]> {
    return (await sql<MemoryAutoCaptureRow>`select * from memory_auto_captures
      where workspace_id = ${workspaceId} and status = 'ACTIVE'
      order by created_at desc limit ${limit}`.execute(this.db)).rows;
  }

  /** 撤销：状态与决定人同时落库，revision 前进一格供回执核对。 */
  async retire(id: string, actor: string): Promise<MemoryAutoCaptureRow | undefined> {
    return (await sql<MemoryAutoCaptureRow>`update memory_auto_captures
      set status = 'RETIRED', decided_at = now(), decided_by = ${actor}, revision = revision + 1
      where id = ${id} and status = 'ACTIVE'
      returning *`.execute(this.db)).rows[0];
  }

  /**
   * 同一内容是否已经提取过（含已撤销）。
   *
   * 撤销后不能再提议同一内容——否则「撤销」只是把界面清干净，下一轮又写回来。
   */
  async hasCaptured(sessionId: string, messageId: string, normalizedSha256: string): Promise<boolean> {
    const row = (await sql<{ one: number }>`select 1 as one from memory_auto_captures
      where session_id = ${sessionId} and message_id = ${messageId}
        and normalized_sha256 = ${normalizedSha256} limit 1`.execute(this.db)).rows[0];
    return row !== undefined;
  }

  /** 同范围内是否已有完全相同标题与正文的 ACTIVE 记忆（人工或自动）。 */
  async hasMemoryWithText(workspaceId: string, projectId: string | null,
    title: string, text: string): Promise<boolean> {
    const row = (await sql<{ one: number }>`select 1 as one from memory_items m
      join memory_versions v on v.memory_id = m.id and v.version = m.current_version
      where m.workspace_id = ${workspaceId} and m.status = 'ACTIVE'
        and m.project_id is not distinct from ${projectId}
        and v.title = ${title} and v.body_text = ${text} limit 1`.execute(this.db)).rows[0];
    return row !== undefined;
  }

  /** 每会话当日（UTC）已写入条数，用于限频；撤销的不回收名额，避免反复提取。 */
  async countToday(sessionId: string): Promise<number> {
    const row = (await sql<{ count: string }>`select count(*)::text as count from memory_auto_captures
      where session_id = ${sessionId}
        and created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc')`
      .execute(this.db)).rows[0];
    return Number(row?.count ?? '0');
  }
}
