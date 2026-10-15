import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import { toDecimalString } from '../shared/decimal.js';
import type {
  LearningConceptRow,
  LearningEvidenceKind,
  LearningEvidenceRow,
  LearningRecordEpochRow,
  LearningRoundRow,
  LearningRoundStatus,
  LearningSessionControlRow,
} from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * 学习记录的独占写入口（0072，ADR-020 / 领域模型 §13.1）。
 *
 * 五张表只由学习应用用例写入；其他模块不直接拼 SQL，也不在 `assist_*` 业务列上维护
 * 第二份学习状态。仓储绑定调用方的事务执行器，不自开事务、不自行提交——
 * 与既有仓储同形状（`unit-of-work.ts` 的 `withTransaction` 决定提交或回滚）。
 *
 * 三条不能让步的口径：
 *   * 知识点解析只按 slug / 别名**精确**匹配，不做模糊合并；不确定时由调用方保留区分。
 *   * 代次（workspace epoch 与 concept generation）是**删除边界**：清除或单项删除后
 *     旧轮次失去写入资格，不靠「回执里没有正文」这一点来假装安全。
 *   * 会话级记录控制由应用保存与校验，不由模型提示决定。
 */
export class LearningRepository {
  constructor(private readonly db: DbExecutor) {}

  // ── 知识点身份 ──────────────────────────────────────────────────────────────

  async findConceptBySlug(workspaceId: string, slug: string): Promise<LearningConceptRow | undefined> {
    return (await sql<LearningConceptRow>`select * from learning_concepts
      where workspace_id = ${workspaceId} and slug = ${slug}`.execute(this.db)).rows[0];
  }

  async findConceptById(conceptId: string): Promise<LearningConceptRow | undefined> {
    return (await sql<LearningConceptRow>`select * from learning_concepts
      where id = ${conceptId}`.execute(this.db)).rows[0];
  }

  /** 别名命中：jsonb 数组元素精确相等，不做前缀/模糊匹配。 */
  async findConceptByAlias(workspaceId: string, alias: string): Promise<LearningConceptRow | undefined> {
    return (await sql<LearningConceptRow>`select * from learning_concepts
      where workspace_id = ${workspaceId} and aliases ? ${alias}
      order by updated_at desc, id desc limit 1`.execute(this.db)).rows[0];
  }

  async insertConcept(input: {
    readonly workspaceId: string; readonly topic: string; readonly slug: string;
    readonly displayName: string; readonly aliases: readonly string[];
  }): Promise<LearningConceptRow> {
    const row = (await sql<LearningConceptRow>`insert into learning_concepts
      (id, workspace_id, topic, slug, display_name, aliases)
      values (${randomUUID()}, ${input.workspaceId}, ${input.topic}, ${input.slug},
        ${input.displayName}, ${JSON.stringify(input.aliases)}::jsonb)
      returning *`.execute(this.db)).rows[0];
    if (row === undefined) throw new Error('learning_concepts insert returned no row');
    return row;
  }

  async listConcepts(workspaceId: string): Promise<readonly LearningConceptRow[]> {
    return (await sql<LearningConceptRow>`select * from learning_concepts
      where workspace_id = ${workspaceId} order by topic asc, display_name asc, id asc`
      .execute(this.db)).rows;
  }

  /**
   * 概念代次递增：单项删除或纠正替换时调用。
   * 冻结在旧代次上的在途轮次因此失去写入资格，而**不**影响其他概念的并发轮次。
   */
  async bumpConceptGeneration(conceptId: string): Promise<bigint | undefined> {
    return (await sql<{ generation: bigint }>`update learning_concepts
      set generation = generation + 1, revision = revision + 1, updated_at = now()
      where id = ${conceptId} returning generation`.execute(this.db)).rows[0]?.generation;
  }

  async deleteConcept(conceptId: string): Promise<void> {
    await sql`delete from learning_concepts where id = ${conceptId}`.execute(this.db);
  }

  async deleteConcepts(workspaceId: string): Promise<number> {
    const rows = (await sql<{ id: string }>`delete from learning_concepts
      where workspace_id = ${workspaceId} returning id`.execute(this.db)).rows;
    return rows.length;
  }

  // ── 证据行 ──────────────────────────────────────────────────────────────────

  async insertEvidence(input: {
    readonly workspaceId: string; readonly conceptId: string; readonly kind: LearningEvidenceKind;
    readonly scenario: string; readonly detail: string;
    readonly disposition: LearningEvidenceRow['disposition'];
    readonly sourceKind: LearningEvidenceRow['source_kind'];
    readonly sourceMessageId: string | null; readonly sessionId: string | null;
    readonly observedAt: Date; readonly epoch: bigint;
    /**
     * 0072 整改：写入时刻的期望概念代次。给出时与 `for update` 锁内重新读到的
     * 代次比对，不一致就不写（返回 undefined，由调用方按 LEARNING_ROUND_STALE 收口）。
     * 这把「校验通过」与「真正写入」放进同一临界区：人工纠正/删除要么在本事务前
     * 提交（这里读到新代次 → 拒绝），要么等本事务提交后才生效（先落后提交）。
     */
    readonly expectedGeneration?: string | undefined;
  }): Promise<LearningEvidenceRow | undefined> {
    const current = (await sql<{ generation: bigint }>`select generation
      from learning_concepts where id = ${input.conceptId} for update`.execute(this.db))
      .rows[0];
    // 概念行消失（全清/删除）：这一轮同样失去写入资格。
    if (current === undefined) return undefined;
    if (input.expectedGeneration !== undefined &&
        toDecimalString(current.generation) !== input.expectedGeneration) {
      return undefined;
    }
    const row = (await sql<LearningEvidenceRow>`insert into learning_evidence
      (id, workspace_id, concept_id, kind, scenario, detail, disposition, source_kind,
        source_message_id, session_id, observed_at, epoch)
      values (${randomUUID()}, ${input.workspaceId}, ${input.conceptId}, ${input.kind},
        ${input.scenario}, ${input.detail}, ${input.disposition}, ${input.sourceKind},
        ${input.sourceMessageId}, ${input.sessionId}, ${input.observedAt}, ${input.epoch})
      returning *`.execute(this.db)).rows[0];
    if (row === undefined) throw new Error('learning_evidence insert returned no row');
    return row;
  }

  async readEvidence(id: string, lock = false): Promise<LearningEvidenceRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<LearningEvidenceRow>`select * from learning_evidence
      where id = ${id} ${suffix}`.execute(this.db)).rows[0];
  }

  async listEvidenceByConcept(conceptId: string): Promise<readonly LearningEvidenceRow[]> {
    return (await sql<LearningEvidenceRow>`select * from learning_evidence
      where concept_id = ${conceptId} order by observed_at desc, id desc`.execute(this.db)).rows;
  }

  /** 轻量查看：默认按主题归组取最近的证据，不复制第二套全量聊天。 */
  async listEvidenceByWorkspace(workspaceId: string,
    limit = 200): Promise<readonly LearningEvidenceRow[]> {
    return (await sql<LearningEvidenceRow>`select * from learning_evidence
      where workspace_id = ${workspaceId} order by observed_at desc, id desc limit ${limit}`
      .execute(this.db)).rows;
  }

  async updateEvidenceDisposition(id: string,
    disposition: LearningEvidenceRow['disposition']): Promise<void> {
    await sql`update learning_evidence set disposition = ${disposition},
      revision = revision + 1, updated_at = now() where id = ${id}`.execute(this.db);
  }

  async deleteEvidence(id: string): Promise<boolean> {
    const rows = (await sql<{ id: string }>`delete from learning_evidence
      where id = ${id} returning id`.execute(this.db)).rows;
    return rows.length > 0;
  }

  async deleteEvidenceByWorkspace(workspaceId: string): Promise<number> {
    const rows = (await sql<{ id: string }>`delete from learning_evidence
      where workspace_id = ${workspaceId} returning id`.execute(this.db)).rows;
    return rows.length;
  }

  // ── 清除边界 ────────────────────────────────────────────────────────────────

  /**
   * 读取当前代次。缺行等价于 epoch 0——**不**在建会话或读取时偷偷插入行，
   * 只有真正发生清除时才建立边界行，避免「读一下就写了」。
   */
  async readEpoch(workspaceId: string): Promise<bigint> {
    const row = (await sql<LearningRecordEpochRow>`select * from learning_record_epochs
      where workspace_id = ${workspaceId}`.execute(this.db)).rows[0];
    return row?.epoch ?? 0n;
  }

  async readEpochRow(workspaceId: string): Promise<LearningRecordEpochRow | undefined> {
    return (await sql<LearningRecordEpochRow>`select * from learning_record_epochs
      where workspace_id = ${workspaceId}`.execute(this.db)).rows[0];
  }

  /**
   * 清除边界的事务锁（0072 整改 / R6）。
   *
   * `pg_advisory_xact_lock` 把「结算」与「全清」排成一致序列：持锁方提交前，另一方
   * 既读不到推进后的 epoch，也看不到未提交的删除。于是全清之后不存在「旧 epoch 证据
   * 仍算当前内容」的窗口；结算先提交时，全清随后照常把新证据一起清掉。
   *
   * 命名空间带 workspaceId，与迁移/Graph 的咨询锁互不冲突；事务结束自动释放。
   * 锁顺序纪律：取得本锁之后才允许碰 `learning_rounds` 行——全清同序，避免死锁。
   */
  async lockRecordEpoch(workspaceId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${
      `learning-record-epoch:${workspaceId}`}, 0))`.execute(this.db);
  }

  /** 全清：代次递增并把清除身份持久化，旧轮次据此判定无写入资格。 */
  async bumpEpoch(workspaceId: string, clearCommandId: string): Promise<bigint> {
    const row = (await sql<{ epoch: bigint }>`insert into learning_record_epochs
      (workspace_id, epoch, cleared_at, clear_command_id)
      values (${workspaceId}, 1, now(), ${clearCommandId})
      on conflict (workspace_id) do update
        set epoch = learning_record_epochs.epoch + 1, cleared_at = now(),
            clear_command_id = ${clearCommandId}, updated_at = now()
      returning epoch`.execute(this.db)).rows[0];
    if (row === undefined) throw new Error('learning_record_epochs upsert returned no row');
    return row.epoch;
  }

  // ── 会话级记录控制 ──────────────────────────────────────────────────────────

  async readSessionControl(sessionId: string): Promise<LearningSessionControlRow | undefined> {
    return (await sql<LearningSessionControlRow>`select * from learning_session_controls
      where session_id = ${sessionId}`.execute(this.db)).rows[0];
  }

  /**
   * 会话级开关。`expectedRevision` 给出时按 CAS 更新，输方返回 undefined，
   * 由调用方以冲突收敛——与仓库既有的 revision 栅栏同形状。
   */
  async upsertSessionControl(input: {
    readonly sessionId: string; readonly workspaceId: string; readonly recordsEnabled: boolean;
    readonly updatedByMessageId: string | null; readonly expectedRevision?: bigint | undefined;
  }): Promise<LearningSessionControlRow | undefined> {
    const expected = input.expectedRevision;
    if (expected === 0n) {
      return (await sql<LearningSessionControlRow>`insert into learning_session_controls
        (session_id, workspace_id, records_enabled, revision, updated_by_message_id)
        values (${input.sessionId}, ${input.workspaceId}, ${input.recordsEnabled}, 1,
          ${input.updatedByMessageId})
        on conflict (session_id) do update
          set records_enabled = ${input.recordsEnabled}, revision = 1,
              updated_by_message_id = ${input.updatedByMessageId}, updated_at = now()
          where learning_session_controls.revision = 0
        returning *`.execute(this.db)).rows[0];
    }
    if (expected === undefined) {
      return (await sql<LearningSessionControlRow>`insert into learning_session_controls
        (session_id, workspace_id, records_enabled, revision, updated_by_message_id)
        values (${input.sessionId}, ${input.workspaceId}, ${input.recordsEnabled}, 1,
          ${input.updatedByMessageId})
        on conflict (session_id) do update
          set records_enabled = ${input.recordsEnabled}, revision = learning_session_controls.revision + 1,
              updated_by_message_id = ${input.updatedByMessageId}, updated_at = now()
        returning *`.execute(this.db)).rows[0];
    }
    return (await sql<LearningSessionControlRow>`update learning_session_controls
      set records_enabled = ${input.recordsEnabled}, revision = revision + 1,
          updated_by_message_id = ${input.updatedByMessageId}, updated_at = now()
      where session_id = ${input.sessionId} and revision = ${expected}
      returning *`.execute(this.db)).rows[0];
  }

  // ── 轮次结算依据 ────────────────────────────────────────────────────────────

  /** 一条助手消息最多一轮；并发首插撞唯一约束时返回 undefined，由调用方回读。 */
  async insertRound(input: {
    readonly workspaceId: string; readonly sessionId: string; readonly messageId: string;
    readonly epoch: bigint; readonly conceptGenerations: JsonObject;
    readonly recordEnabled: boolean;
  }): Promise<LearningRoundRow | undefined> {
    return (await sql<LearningRoundRow>`insert into learning_rounds
      (id, workspace_id, session_id, message_id, epoch, concept_generations, record_enabled)
      values (${randomUUID()}, ${input.workspaceId}, ${input.sessionId}, ${input.messageId},
        ${input.epoch}, ${JSON.stringify(input.conceptGenerations)}::jsonb, ${input.recordEnabled})
      on conflict (message_id) do nothing
      returning *`.execute(this.db)).rows[0];
  }

  async readRoundByMessage(messageId: string): Promise<LearningRoundRow | undefined> {
    return (await sql<LearningRoundRow>`select * from learning_rounds
      where message_id = ${messageId}`.execute(this.db)).rows[0];
  }

  async listSessionRounds(sessionId: string): Promise<readonly LearningRoundRow[]> {
    return (await sql<LearningRoundRow>`select * from learning_rounds
      where session_id = ${sessionId} order by created_at desc limit 200`
      .execute(this.db)).rows;
  }

  async readRound(id: string, lock = false): Promise<LearningRoundRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<LearningRoundRow>`select * from learning_rounds
      where id = ${id} ${suffix}`.execute(this.db)).rows[0];
  }

  /** 只有仍 PENDING 的轮次可以被结算；否则返回 false（旧 worker 不再有资格）。 */
  async settleRound(id: string, status: Exclude<LearningRoundStatus, 'PENDING'>,
    rejectionReason: string | null): Promise<boolean> {
    const rows = (await sql<{ id: string }>`update learning_rounds
      set status = ${status}, rejection_reason = ${rejectionReason}, settled_at = now(),
          updated_at = now()
      where id = ${id} and status = 'PENDING' returning id`.execute(this.db)).rows;
    return rows.length > 0;
  }

  /**
   * 全清时的在途轮次处理：**保留行、改状态**，不删除。
   *
   * 轮次行不含任何评估正文（只有冻结代次、概念代次与状态），属于提示词 §9.3 允许保留的
   * 「最小控制元数据」；保留它才能让迟到轮次得到**可核对的原因**（依据已过期），
   * 而不是笼统的「依据不存在」。
   */
  async cancelWorkspaceRounds(workspaceId: string): Promise<number> {
    const rows = (await sql<{ id: string }>`update learning_rounds
      set status = 'CANCELLED', rejection_reason = 'LEARNING_RECORDS_CLEARED',
          settled_at = now(), updated_at = now()
      where workspace_id = ${workspaceId} and status = 'PENDING' returning id`
      .execute(this.db)).rows;
    return rows.length;
  }

  /** 会话归档/清除时的在途轮次取消：只改状态，不保留评估正文。 */
  async cancelPendingRounds(sessionId: string): Promise<number> {
    const rows = (await sql<{ id: string }>`update learning_rounds
      set status = 'CANCELLED', rejection_reason = 'SESSION_CONTROL_CHANGED',
          settled_at = now(), updated_at = now()
      where session_id = ${sessionId} and status = 'PENDING' returning id`
      .execute(this.db)).rows;
    return rows.length;
  }
}
