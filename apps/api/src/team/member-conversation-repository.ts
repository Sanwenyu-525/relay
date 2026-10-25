import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * 成员私聊/群聊与消息的持久化（ADR-034 包 B，迁移 0140；消费列与唤醒领取随
 * 迁移 0141 / 包 C 第一片接入）。
 *
 * 私聊一线程、群聊一线程由部分唯一索引裁决；消息的身份与定向接收者都在行上，
 * 去重靠命令回执（同 command_id 重放不落新行）。唤醒消费（RECORDED→CLAIMED→
 * PROCESSED/FAILED）在消息行上以条件更新结算，重复扫描与并发巡检不重复领取。
 */
export type MemberConversationKind = 'DIRECT' | 'GROUP';
export type MemberConversationStatus = 'OPEN' | 'CLOSED';
export type MemberMessageIntent = 'DISCUSS' | 'QUESTION' | 'SUGGESTION' | 'STATUS_REPORT' | 'CHECK_REQUEST' | 'HANDOFF';

export interface MemberConversationRow {
  id: string;
  workspace_id: string;
  project_id: string;
  kind: MemberConversationKind;
  member_id: string | null;
  title: string | null;
  status: MemberConversationStatus;
  close_reason: string | null;
  revision: bigint;
  created_at: Date;
  updated_at: Date;
}

export interface MemberMessageRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  project_id: string;
  seq: bigint;
  sender_kind: 'HUMAN' | 'MEMBER';
  sender_member_id: string | null;
  recipient_member_ids: string[];
  intent: MemberMessageIntent;
  content: string;
  handoff_payload: JsonObject | null;
  linked_task_id: string | null;
  linked_run_id: string | null;
  processing_status: 'RECORDED' | 'CLAIMED' | 'PROCESSED' | 'FAILED';
  /** 0141 消费事实：领取者、租约、尝试次数与结算结果；RECORDED 行全为空/零。 */
  claimed_by: string | null;
  claimed_at: Date | null;
  lease_expires_at: Date | null;
  attempts: number;
  processed_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
}

export class MemberConversationRepository {
  constructor(private readonly db: DbExecutor) {}

  /** 「开启或继续」：撞唯一索引说明线程已存在，返回既有行，不新建。 */
  async insertOrExisting(row: {
    readonly id: string; readonly workspace_id: string; readonly project_id: string;
    readonly kind: MemberConversationKind; readonly member_id: string | null; readonly title: string | null;
  }): Promise<MemberConversationRow> {
    const inserted = (await sql<MemberConversationRow>`insert into project_member_conversations
      (id, workspace_id, project_id, kind, member_id, title)
      values (${row.id}, ${row.workspace_id}, ${row.project_id}, ${row.kind}, ${row.member_id}, ${row.title})
      on conflict do nothing returning *`.execute(this.db)).rows[0];
    if (inserted !== undefined) return inserted;
    const existing = row.kind === 'DIRECT'
      ? await sql<MemberConversationRow>`select * from project_member_conversations
          where project_id = ${row.project_id} and kind = 'DIRECT' and member_id = ${row.member_id}`.execute(this.db)
      : await sql<MemberConversationRow>`select * from project_member_conversations
          where project_id = ${row.project_id} and kind = 'GROUP'`.execute(this.db);
    return existing.rows[0]!;
  }

  async read(id: string, lock = false): Promise<MemberConversationRow | undefined> {
    return (await sql<MemberConversationRow>`select * from project_member_conversations where id = ${id}
      ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }

  async list(workspaceId: string, projectId: string): Promise<MemberConversationRow[]> {
    return (await sql<MemberConversationRow>`select * from project_member_conversations
      where workspace_id = ${workspaceId} and project_id = ${projectId}
      order by created_at, id`.execute(this.db)).rows;
  }

  async close(id: string, closeReason: string | null): Promise<MemberConversationRow> {
    return (await sql<MemberConversationRow>`update project_member_conversations
      set status = 'CLOSED', close_reason = ${closeReason}, revision = revision + 1, updated_at = now()
      where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }

  async reopen(id: string): Promise<MemberConversationRow> {
    return (await sql<MemberConversationRow>`update project_member_conversations
      set status = 'OPEN', close_reason = null, revision = revision + 1, updated_at = now()
      where id = ${id} returning *`.execute(this.db)).rows[0]!;
  }

  async nextSeq(conversationId: string): Promise<bigint> {
    return (await sql<{ next: bigint }>`select coalesce(max(seq), 0) + 1 as next
      from project_member_messages where conversation_id = ${conversationId}`.execute(this.db)).rows[0]!.next;
  }

  async insertMessage(row: {
    readonly id: string; readonly conversation_id: string; readonly workspace_id: string; readonly project_id: string;
    readonly seq: bigint; readonly sender_kind: 'HUMAN' | 'MEMBER'; readonly sender_member_id: string | null;
    readonly recipient_member_ids: readonly string[]; readonly intent: MemberMessageIntent;
    readonly content: string; readonly handoff_payload: JsonObject | null;
    readonly linked_task_id: string | null; readonly linked_run_id: string | null;
  }): Promise<MemberMessageRow> {
    return (await sql<MemberMessageRow>`insert into project_member_messages
      (id, conversation_id, workspace_id, project_id, seq, sender_kind, sender_member_id,
       recipient_member_ids, intent, content, handoff_payload, linked_task_id, linked_run_id)
      values (${row.id}, ${row.conversation_id}, ${row.workspace_id}, ${row.project_id}, ${row.seq},
        ${row.sender_kind}, ${row.sender_member_id}, ${JSON.stringify(row.recipient_member_ids)}::jsonb,
        ${row.intent}, ${row.content}, ${row.handoff_payload === null ? null : JSON.stringify(row.handoff_payload)}::jsonb,
        ${row.linked_task_id}, ${row.linked_run_id})
      returning *`.execute(this.db)).rows[0]!;
  }

  async messages(conversationId: string, afterSeq: bigint | null, limit: number): Promise<MemberMessageRow[]> {
    return (await sql<MemberMessageRow>`select * from project_member_messages
      where conversation_id = ${conversationId}
        ${afterSeq === null ? sql`` : sql`and seq > ${afterSeq}`}
      order by seq limit ${limit}`.execute(this.db)).rows;
  }

  async readMessage(id: string): Promise<MemberMessageRow | undefined> {
    return (await sql<MemberMessageRow>`select * from project_member_messages
      where id = ${id}`.execute(this.db)).rows[0];
  }

  /* ------------------ 唤醒消费循环（0141，ADR-034 包 C 第一片） ------------------ */

  /**
   * 唤醒候选：未结算、会话仍开放、项目未归档，且**由用户发送**——成员回信
   * （sender_kind=MEMBER、未定向）不是唤醒触发，否则群聊里一次回应会唤醒协调者、
   * 协调者的回应再唤醒别人，形成无结束条件的互相唤醒链。成员之间的定向互相
   * 唤醒随后续片的定向协议接入，本循环不猜测方向。裁决（唤醒谁）由应用层完成。
   */
  async listWakeupCandidates(limit: number): Promise<MemberMessageRow[]> {
    return (await sql<MemberMessageRow>`select m.* from project_member_messages m
      join project_member_conversations c on c.id = m.conversation_id
      join projects p on p.id = m.project_id
      where m.processing_status = 'RECORDED' and m.sender_kind = 'HUMAN'
        and c.status = 'OPEN' and p.archived_at is null
      order by m.created_at, m.id limit ${limit}`.execute(this.db)).rows;
  }

  /** RECORDED→CLAIMED 的一次性领取（CAS）：并发扫描只有一方成功，attempts 计数含本次。 */
  async claimWakeupMessage(id: string, workerId: string, now: Date, leaseMs: number): Promise<MemberMessageRow | undefined> {
    return (await sql<MemberMessageRow>`update project_member_messages
      set processing_status = 'CLAIMED', claimed_by = ${workerId}, claimed_at = ${now},
        lease_expires_at = ${new Date(now.getTime() + leaseMs)}, attempts = attempts + 1
      where id = ${id} and processing_status = 'RECORDED' returning *`.execute(this.db)).rows[0];
  }

  /** 生成期间续租；只续本 Worker 持有的 CLAIMED 行。 */
  async heartbeatWakeup(id: string, workerId: string, now: Date, leaseMs: number): Promise<boolean> {
    const alive = (await sql<{ id: string }>`update project_member_messages
      set lease_expires_at = ${new Date(now.getTime() + leaseMs)}
      where id = ${id} and processing_status = 'CLAIMED' and claimed_by = ${workerId}
      returning id`.execute(this.db)).rows.length === 1;
    return alive;
  }

  /** 归档栅栏等「领取后前提失效」场景：退还领取（清在途事实、保留 attempts），不记失败。 */
  async releaseWakeupClaim(id: string, workerId: string): Promise<boolean> {
    return (await sql<{ id: string }>`update project_member_messages
      set processing_status = 'RECORDED', claimed_by = null, claimed_at = null, lease_expires_at = null
      where id = ${id} and processing_status = 'CLAIMED' and claimed_by = ${workerId}
      returning id`.execute(this.db)).rows.length === 1;
  }

  /** 按领取身份 CAS 结算成功；回信行由调用方在同一事务写入。 */
  async settleWakeupProcessed(id: string, workerId: string, now: Date): Promise<boolean> {
    return (await sql<{ id: string }>`update project_member_messages
      set processing_status = 'PROCESSED', processed_at = ${now}, failure_reason = null
      where id = ${id} and processing_status = 'CLAIMED' and claimed_by = ${workerId}
      returning id`.execute(this.db)).rows.length === 1;
  }

  /** 按领取身份 CAS 结算失败：写明具体原因，模型失败不自动重试。 */
  async settleWakeupFailed(id: string, workerId: string, now: Date, reason: string): Promise<boolean> {
    return (await sql<{ id: string }>`update project_member_messages
      set processing_status = 'FAILED', processed_at = ${now}, failure_reason = ${reason}
      where id = ${id} and processing_status = 'CLAIMED' and claimed_by = ${workerId}
      returning id`.execute(this.db)).rows.length === 1;
  }

  /**
   * 过期租约清扫（崩溃恢复）：未超尝试上限的回到 RECORDED 等待下次唤醒；
   * 超上限（WAKEUP_ATTEMPTS_EXHAUSTED）按失败收口，不无限重试。
   */
  async sweepExpiredWakeup(now: Date, maxAttempts: number): Promise<{ requeued: number; failed: number }> {
    const requeued = (await sql<{ id: string }>`update project_member_messages
      set processing_status = 'RECORDED', claimed_by = null, claimed_at = null, lease_expires_at = null
      where processing_status = 'CLAIMED' and lease_expires_at < ${now} and attempts < ${maxAttempts}
      returning id`.execute(this.db)).rows.length;
    const failed = (await sql<{ id: string }>`update project_member_messages
      set processing_status = 'FAILED', processed_at = ${now},
        failure_reason = 'WAKEUP_ATTEMPTS_EXHAUSTED'
      where processing_status = 'CLAIMED' and lease_expires_at < ${now} and attempts >= ${maxAttempts}
      returning id`.execute(this.db)).rows.length;
    return { requeued, failed };
  }
}
