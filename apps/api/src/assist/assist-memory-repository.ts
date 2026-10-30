import { sql } from 'kysely';
import type { DbExecutor } from '../infrastructure/database.js';
import type { AssistMessageRow } from '../infrastructure/database-schema.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';

export interface AssistMemoryStateRow {
  session_id: string; revision: bigint; cleared_through_seq: bigint;
  checkpoint_id: string | null; updated_at: Date;
}
export interface AssistMemoryCheckpointRow {
  id: string; workspace_id: string; session_id: string; through_seq: bigint;
  session_revision: bigint; authority_revision: bigint; context_revision: bigint;
  source_message_ids: JsonValue[]; source_sha256: string; sources: JsonValue[];
  summary: string; model_call_id: string; created_at: Date;
}
export interface AssistMemoryRequestRow {
  id: string; workspace_id: string; session_id: string; session_revision: bigint;
  authority_revision: bigint; context_revision: bigint;
  memory_revision: bigint; settings_revision: bigint; through_seq: bigint;
  anchor_message_id: string; source_message_ids: JsonValue[]; source_sha256: string;
  model_snapshot: JsonObject; reason: 'MANUAL' | 'AUTO';
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  worker_id: string | null; claim_epoch: bigint; lease_until: Date | null;
  cancel_requested: boolean; model_call_id: string | null; checkpoint_id: string | null;
  error_code: string | null; created_at: Date; updated_at: Date;
}

/** Assist owns the working window; original messages and tool execution remain authoritative. */
export class AssistMemoryRepository {
  constructor(private readonly db: DbExecutor) {}

  async state(sessionId: string, lock = false): Promise<AssistMemoryStateRow | undefined> {
    return (await sql<AssistMemoryStateRow>`select * from assist_memory_state
      where session_id = ${sessionId} ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }

  async checkpoint(id: string): Promise<AssistMemoryCheckpointRow | undefined> {
    return (await sql<AssistMemoryCheckpointRow>`select * from assist_memory_checkpoints
      where id = ${id}`.execute(this.db)).rows[0];
  }

  async checkpointParent(id: string): Promise<string | null> {
    return (await sql<{ parent_id: string | null }>`select
      model_snapshot->'memory_compaction'->>'base_checkpoint_id' as parent_id
      from assist_memory_requests where checkpoint_id = ${id} and status = 'COMPLETED'
      limit 1`.execute(this.db)).rows[0]?.parent_id ?? null;
  }

  async history(sessionId: string, after: bigint, through?: bigint, limit = 10001): Promise<readonly AssistMessageRow[]> {
    // 0122：插话被消费的占位行（CANCELLED + STEERED）不是一轮历史——它的用户原文
    // 已经作为插话进入原在途回复的上下文，再以「该轮 CANCELLED」回放会凭空多出一个
    // 没有答案的助手回合。
    return (await sql<AssistMessageRow>`select * from assist_messages where session_id = ${sessionId}
      and seq > ${after} and status in ('COMPLETED', 'FAILED', 'CANCELLED')
      and not (role = 'ASSISTANT' and status = 'CANCELLED' and error_code is not distinct from 'STEERED')
      ${through === undefined ? sql`` : sql`and seq <= ${through}`}
      order by seq limit ${limit}`.execute(this.db)).rows;
  }

  async latestHistorySeq(sessionId: string): Promise<bigint> {
    return (await sql<{ seq: bigint }>`select seq from assist_messages where session_id = ${sessionId}
      and status in ('COMPLETED', 'FAILED', 'CANCELLED')
      and not (role = 'ASSISTANT' and status = 'CANCELLED' and error_code is not distinct from 'STEERED')
      order by seq desc limit 1`.execute(this.db)).rows[0]?.seq ?? 0n;
  }

  async request(id: string, lock = false): Promise<AssistMemoryRequestRow | undefined> {
    return (await sql<AssistMemoryRequestRow>`select * from assist_memory_requests where id = ${id}
      ${lock ? sql`for update` : sql``}`.execute(this.db)).rows[0];
  }

  async activeRequest(sessionId: string): Promise<AssistMemoryRequestRow | undefined> {
    return (await sql<AssistMemoryRequestRow>`select * from assist_memory_requests
      where session_id = ${sessionId} and status in ('PENDING', 'RUNNING')`.execute(this.db)).rows[0];
  }

  async insertRequest(input: { id: string; workspaceId: string; sessionId: string;
    sessionRevision: bigint; memoryRevision: bigint; settingsRevision: bigint;
    authorityRevision: bigint; contextRevision: bigint;
    throughSeq: bigint; anchorMessageId: string; sourceMessageIds: readonly string[];
    sourceSha256: string; modelSnapshot: JsonObject; reason: 'MANUAL' | 'AUTO' }): Promise<void> {
    await sql`insert into assist_memory_requests (id, workspace_id, session_id, session_revision,
      authority_revision, context_revision,
      memory_revision, settings_revision, through_seq, anchor_message_id, source_message_ids,
      source_sha256, model_snapshot, reason) values (${input.id}, ${input.workspaceId},
      ${input.sessionId}, ${input.sessionRevision}, ${input.authorityRevision}, ${input.contextRevision},
      ${input.memoryRevision}, ${input.settingsRevision},
      ${input.throughSeq}, ${input.anchorMessageId}, ${JSON.stringify(input.sourceMessageIds)}::jsonb,
      ${input.sourceSha256}, ${JSON.stringify(input.modelSnapshot)}::jsonb, ${input.reason})`.execute(this.db);
  }

  async claim(workerId: string, leaseMs: number): Promise<AssistMemoryRequestRow | undefined> {
    return (await sql<AssistMemoryRequestRow>`update assist_memory_requests
      set status = 'RUNNING', worker_id = ${workerId}, claim_epoch = claim_epoch + 1,
        lease_until = now() + ${leaseMs} * interval '1 millisecond', updated_at = now()
      where id = (select j.id from assist_memory_requests j
        join assist_sessions s on s.id = j.session_id
        left join projects p on p.id = s.project_id
        where j.status = 'PENDING' and s.status = 'ACTIVE'
          and (s.project_id is null or p.archived_at is null)
          and not exists (select 1 from assist_messages m where m.session_id = s.id and m.status = 'RUNNING')
        order by j.created_at, j.id limit 1 for update of j skip locked)
      returning *`.execute(this.db)).rows[0];
  }

  async expireLeases(): Promise<void> {
    await sql`update assist_memory_requests j set status = 'FAILED', error_code = 'MEMORY_SCOPE_CHANGED',
      updated_at = now() where j.status = 'PENDING' and exists (
        select 1 from assist_sessions s left join projects p on p.id = s.project_id
        where s.id = j.session_id and (s.status <> 'ACTIVE' or
          (s.project_id is not null and p.archived_at is not null)))`.execute(this.db);
    await sql`update assist_memory_requests set status = 'FAILED', error_code = 'MEMORY_WORKER_LOST',
      updated_at = now() where status = 'RUNNING' and lease_until < now()`.execute(this.db);
  }

  async heartbeat(id: string, workerId: string, epoch: bigint, leaseMs: number): Promise<boolean> {
    return (await sql<{ id: string }>`update assist_memory_requests set
      lease_until = now() + ${leaseMs} * interval '1 millisecond', updated_at = now()
      where id = ${id} and status = 'RUNNING' and worker_id = ${workerId}
        and claim_epoch = ${epoch} and lease_until > now() and cancel_requested = false returning id`.execute(this.db)).rows.length === 1;
  }

  async bindCall(id: string, workerId: string, epoch: bigint, callId: string): Promise<boolean> {
    return (await sql<{ id: string }>`update assist_memory_requests set model_call_id = ${callId}
      where id = ${id} and status = 'RUNNING' and worker_id = ${workerId} and claim_epoch = ${epoch}
        and lease_until > now() and cancel_requested = false returning id`.execute(this.db)).rows.length === 1;
  }

  async settle(id: string, workerId: string, epoch: bigint, status: 'COMPLETED' | 'FAILED' | 'CANCELLED',
    errorCode: string | null, checkpointId: string | null = null): Promise<boolean> {
    return (await sql<{ id: string }>`update assist_memory_requests set status = ${status},
      error_code = ${errorCode}, checkpoint_id = ${checkpointId}, lease_until = null, updated_at = now()
      where id = ${id} and status = 'RUNNING' and worker_id = ${workerId}
        and claim_epoch = ${epoch} returning id`.execute(this.db)).rows.length === 1;
  }

  async insertCheckpoint(input: { id: string; request: AssistMemoryRequestRow;
    summary: string; sources: readonly JsonObject[]; callId: string }): Promise<void> {
    const j = input.request;
    await sql`insert into assist_memory_checkpoints (id, workspace_id, session_id, through_seq,
      session_revision, authority_revision, context_revision,
      source_message_ids, source_sha256, sources, summary, model_call_id)
      values (${input.id}, ${j.workspace_id}, ${j.session_id}, ${j.through_seq},
        ${j.session_revision}, ${j.authority_revision}, ${j.context_revision},
        ${JSON.stringify(j.source_message_ids)}::jsonb, ${j.source_sha256},
        ${JSON.stringify(input.sources)}::jsonb, ${input.summary}, ${input.callId})`.execute(this.db);
  }

  async publish(sessionId: string, expectedRevision: bigint, checkpointId: string): Promise<boolean> {
    if (expectedRevision !== 0n) {
      return (await sql<{ session_id: string }>`update assist_memory_state
        set checkpoint_id = ${checkpointId}, revision = revision + 1, updated_at = now()
        where session_id = ${sessionId} and revision = ${expectedRevision}
        returning session_id`.execute(this.db)).rows.length === 1;
    }
    return (await sql<{ session_id: string }>`insert into assist_memory_state (session_id, revision, checkpoint_id)
      select ${sessionId}, 1, ${checkpointId} where ${expectedRevision}::bigint = 0
      on conflict (session_id) do update set checkpoint_id = excluded.checkpoint_id,
        revision = assist_memory_state.revision + 1, updated_at = now()
        where assist_memory_state.revision = ${expectedRevision}
      returning session_id`.execute(this.db)).rows.length === 1;
  }

  async reset(sessionId: string, throughSeq: bigint): Promise<AssistMemoryStateRow> {
    return (await sql<AssistMemoryStateRow>`insert into assist_memory_state
      (session_id, revision, cleared_through_seq) values (${sessionId}, 1, ${throughSeq})
      on conflict (session_id) do update set revision = assist_memory_state.revision + 1,
        cleared_through_seq = excluded.cleared_through_seq, checkpoint_id = null, updated_at = now()
      returning *`.execute(this.db)).rows[0]!;
  }

  async cancel(id: string): Promise<void> {
    await sql`update assist_memory_requests set cancel_requested = true,
      status = case when status = 'PENDING' then 'CANCELLED' else status end, updated_at = now()
      where id = ${id} and status in ('PENDING', 'RUNNING')`.execute(this.db);
  }

  async setRemember(sessionId: string, remember: boolean): Promise<void> {
    await sql`update assist_sessions set remember = ${remember}, revision = revision + 1,
      updated_at = now() where id = ${sessionId}`.execute(this.db);
  }

  async requests(sessionId: string): Promise<readonly AssistMemoryRequestRow[]> {
    return (await sql<AssistMemoryRequestRow>`select * from assist_memory_requests
      where session_id = ${sessionId} order by created_at desc, id desc limit 20`.execute(this.db)).rows;
  }

  async recordUse(input: { messageId: string; sessionId: string; authorityRevision: bigint;
    contextRevision: bigint; memoryRevision: bigint; checkpointId: string | null; sources: readonly JsonObject[];
    hasToolContext: boolean; sessionScope: JsonObject }): Promise<void> {
    await sql`insert into assist_memory_uses (message_id, session_id, authority_revision,
      context_revision, memory_revision, checkpoint_id, sources, has_tool_context, session_scope) values (${input.messageId},
      ${input.sessionId}, ${input.authorityRevision}, ${input.contextRevision},
      ${input.memoryRevision}, ${input.checkpointId}, ${JSON.stringify(input.sources)}::jsonb,
      ${input.hasToolContext}, ${JSON.stringify(input.sessionScope)}::jsonb) on conflict (message_id) do nothing`.execute(this.db);
  }

  async use(messageId: string): Promise<{ checkpoint_id: string | null; authority_revision: bigint;
    sources: JsonValue[]; has_tool_context: boolean; session_scope: JsonObject | null } | undefined> {
    return (await sql<{ checkpoint_id: string | null; authority_revision: bigint; sources: JsonValue[];
      has_tool_context: boolean; session_scope: JsonObject | null }>`select checkpoint_id, authority_revision, sources, has_tool_context, session_scope
      from assist_memory_uses where message_id = ${messageId}`.execute(this.db)).rows[0];
  }

  async messagesWithTools(sessionId: string): Promise<readonly string[]> {
    return (await sql<{ message_id: string }>`select distinct message_id from session_tool_calls
      where session_id = ${sessionId}`.execute(this.db)).rows.map((row) => row.message_id);
  }

  async hasUnsettledTools(sessionId: string, messageIds: readonly string[]): Promise<boolean> {
    if (messageIds.length === 0) return false;
    return (await sql<{ id: string }>`select id from session_tool_calls where session_id = ${sessionId}
      and message_id = any(${[...messageIds]}::uuid[]) and status not in ('SETTLED', 'REJECTED')
      limit 1`.execute(this.db)).rows.length > 0;
  }
}
