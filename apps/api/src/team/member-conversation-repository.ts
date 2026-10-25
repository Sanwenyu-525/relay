import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * 成员私聊/群聊与消息的持久化（ADR-034 包 B，迁移 0140）。
 *
 * 私聊一线程、群聊一线程由部分唯一索引裁决；消息的身份与定向接收者都在行上，
 * 去重靠命令回执（同 command_id 重放不落新行），消费结算（CLAIMED/PROCESSED）随
 * 包 C 唤醒接入——本表先保存 `processing_status` 词表，不提前实现消费循环。
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
}
