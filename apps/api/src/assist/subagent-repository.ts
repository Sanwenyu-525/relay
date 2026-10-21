import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  AssistDelegationAttemptRow, AssistDelegationRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';

/**
 * 0128：有界多 Agent 的持久化（ADR-017、运行架构 §2.5）。
 *
 * 与 plan-goal 仓储同一纪律：只做读写与 CAS，不解释业务。
 *   * 委派行按 revision CAS 前进——迟到结果拿旧修订号写不进去；
 *   * 尝试行按 claim_epoch CAS——租约过期后旧 Worker 的结果不得落定；
 *   * 并发槽（最多两个未终结委派）由 `countOpenByParent` 在**持锁的创建事务**里计数，
 *     不靠内存或定时猜测。
 */

export type DelegationRole = 'INVESTIGATE' | 'REVIEW';
export type DelegationStatus = AssistDelegationRow['status'];
export type DelegationAttemptStatus = AssistDelegationAttemptRow['status'];

/**
 * 委派的**终结态**：委派行与尝试行 CHECK 的交集（0128）。
 *
 * 子执行输出、回传主 Agent 的工具结果与落定都只用这一套词表——「子 Agent 成功了」和
 * 「这次委派成功了」是同一件事，不在链路里同时存在 COMPLETED / SUCCEEDED 两种说法。
 * 子会话**消息**行的终态仍是 `assist_messages` 自己的 COMPLETED；那次转换只发生在
 * 写消息行的那一处，不渗进委派链路。
 */
export type DelegationTerminalStatus = Extract<
  DelegationStatus, 'SUCCEEDED' | 'FAILED' | 'CANCELLED'>;

export interface InsertDelegationInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly role: DelegationRole;
  readonly objective: string;
  readonly scope: readonly JsonObject[];
  readonly baseline: JsonObject | null;
  readonly outputRequirements: string;
  readonly required: boolean;
  readonly parentMessageId: string;
  readonly parentToolCallId: string | null;
  readonly maxAttempts: number;
}

export interface DelegationPatch {
  readonly status?: DelegationStatus;
  readonly resultSummary?: string | null;
  readonly stopReason?: JsonObject | null;
  readonly attemptCount?: number;
}

export interface AttemptPatch {
  readonly status?: DelegationAttemptStatus;
  readonly workerId?: string | null;
  readonly resultMessageId?: string | null;
  readonly errorCode?: string | null;
}

const DELEGATION_COLUMNS = sql.raw('id, workspace_id, parent_session_id, child_session_id, role, ' +
  'objective, scope, baseline, output_requirements, required, status, attempt_count, ' +
  'max_attempts, parent_message_id, parent_tool_call_id, result_summary, stop_reason, revision, ' +
  'created_at, updated_at, closed_at');

const ATTEMPT_COLUMNS = sql.raw('id, delegation_id, attempt_index, claim_epoch, worker_id, status, ' +
  'result_message_id, error_code, created_at, updated_at');

export class SubagentRepository {
  constructor(private readonly db: DbExecutor) {}

  // ------------------------------------------------------------------ 委派账本

  async insertDelegation(input: InsertDelegationInput): Promise<AssistDelegationRow> {
    const rows = (await sql<AssistDelegationRow>`insert into assist_delegations (id, workspace_id,
      parent_session_id, child_session_id, role, objective, scope, baseline, output_requirements,
      required, status, attempt_count, max_attempts, parent_message_id, parent_tool_call_id)
      values (${input.id}, ${input.workspaceId}, ${input.parentSessionId}, ${input.childSessionId},
      ${input.role}, ${input.objective}, ${JSON.stringify(input.scope)}::jsonb,
      ${input.baseline === null ? null : JSON.stringify(input.baseline)}::jsonb,
      ${input.outputRequirements}, ${input.required}, 'RUNNING', 1, ${input.maxAttempts},
      ${input.parentMessageId}, ${input.parentToolCallId})
      returning ${DELEGATION_COLUMNS}`.execute(this.db)).rows;
    return rows[0]!;
  }

  async readDelegation(id: string, lock = false): Promise<AssistDelegationRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<AssistDelegationRow>`select ${DELEGATION_COLUMNS} from assist_delegations
      where id = ${id} ${suffix}`.execute(this.db)).rows[0];
  }

  /**
   * 同一主会话下未终结的委派数（RUNNING/QUEUED 都算）。
   *
   * 必须在持有主会话行锁的事务里调用：两个并发工具请求同时看到 1、各自再建一个，
   * 就会越过「最多两个」的产品边界。
   */
  async countOpenByParent(parentSessionId: string): Promise<number> {
    const rows = (await sql<{ count: string }>`select count(*)::text as count
      from assist_delegations
      where parent_session_id = ${parentSessionId}
        and status in ('QUEUED', 'RUNNING')`.execute(this.db)).rows;
    return Number(rows[0]?.count ?? '0');
  }

  async listByParent(parentSessionId: string,
    limit = 50): Promise<readonly AssistDelegationRow[]> {
    return (await sql<AssistDelegationRow>`select ${DELEGATION_COLUMNS} from assist_delegations
      where parent_session_id = ${parentSessionId}
      order by created_at desc, id desc limit ${Math.max(1, Math.min(200, limit))}`
      .execute(this.db)).rows;
  }

  async listByChildSession(childSessionId: string): Promise<readonly AssistDelegationRow[]> {
    return (await sql<AssistDelegationRow>`select ${DELEGATION_COLUMNS} from assist_delegations
      where child_session_id = ${childSessionId}`.execute(this.db)).rows;
  }

  async updateDelegation(id: string, expectedRevision: bigint,
    patch: DelegationPatch): Promise<boolean> {
    const assignments = [sql`updated_at = now()`, sql`revision = revision + 1`];
    if (patch.status !== undefined) {
      assignments.push(sql`status = ${patch.status}`);
      assignments.push(['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(patch.status)
        ? sql`closed_at = now()` : sql`closed_at = null`);
    }
    if (patch.resultSummary !== undefined) {
      assignments.push(sql`result_summary = ${patch.resultSummary}`);
    }
    if (patch.stopReason !== undefined) {
      assignments.push(sql`stop_reason = ${patch.stopReason === null ? null
        : JSON.stringify(patch.stopReason)}::jsonb`);
    }
    if (patch.attemptCount !== undefined) {
      assignments.push(sql`attempt_count = ${patch.attemptCount}`);
    }
    const rows = (await sql<{ id: string }>`update assist_delegations set
      ${sql.join(assignments, sql`, `)}
      where id = ${id} and revision = ${expectedRevision} returning id`.execute(this.db)).rows;
    return rows.length === 1;
  }

  // ------------------------------------------------------------------ 子尝试

  async insertAttempt(input: { id: string; delegationId: string; attemptIndex: number;
    claimEpoch: bigint; workerId: string }): Promise<AssistDelegationAttemptRow> {
    const rows = (await sql<AssistDelegationAttemptRow>`insert into assist_delegation_attempts
      (id, delegation_id, attempt_index, claim_epoch, worker_id, status)
      values (${input.id}, ${input.delegationId}, ${input.attemptIndex}, ${input.claimEpoch},
      ${input.workerId}, 'RUNNING') returning ${ATTEMPT_COLUMNS}`.execute(this.db)).rows;
    return rows[0]!;
  }

  async readAttempt(id: string, lock = false): Promise<AssistDelegationAttemptRow | undefined> {
    const suffix = lock ? sql`for update` : sql``;
    return (await sql<AssistDelegationAttemptRow>`select ${ATTEMPT_COLUMNS}
      from assist_delegation_attempts where id = ${id} ${suffix}`.execute(this.db)).rows[0];
  }

  async listAttempts(delegationId: string): Promise<readonly AssistDelegationAttemptRow[]> {
    return (await sql<AssistDelegationAttemptRow>`select ${ATTEMPT_COLUMNS}
      from assist_delegation_attempts where delegation_id = ${delegationId}
      order by attempt_index`.execute(this.db)).rows;
  }

  async readLatestAttempt(delegationId: string): Promise<AssistDelegationAttemptRow | undefined> {
    return (await sql<AssistDelegationAttemptRow>`select ${ATTEMPT_COLUMNS}
      from assist_delegation_attempts where delegation_id = ${delegationId}
      order by attempt_index desc limit 1`.execute(this.db)).rows[0];
  }

  /** 按领取代次 CAS 落定尝试结果：迟到旧 epoch 写不进去。 */
  async updateAttempt(id: string, expectedEpoch: bigint,
    patch: AttemptPatch): Promise<boolean> {
    const assignments = [sql`updated_at = now()`];
    if (patch.status !== undefined) assignments.push(sql`status = ${patch.status}`);
    if (patch.workerId !== undefined) assignments.push(sql`worker_id = ${patch.workerId}`);
    if (patch.resultMessageId !== undefined) {
      assignments.push(sql`result_message_id = ${patch.resultMessageId}`);
    }
    if (patch.errorCode !== undefined) assignments.push(sql`error_code = ${patch.errorCode}`);
    const rows = (await sql<{ id: string }>`update assist_delegation_attempts set
      ${sql.join(assignments, sql`, `)}
      where id = ${id} and claim_epoch = ${expectedEpoch} returning id`.execute(this.db)).rows;
    return rows.length === 1;
  }

  /**
   * 仍挂着 RUNNING 的尝试（恢复核对用）。
   *
   * 进程在子执行中崩溃时，子消息会先被租约清扫收敛，而尝试行还是 RUNNING——
   * 恢复时按消息真实状态补结算，不盲目重跑。用 `to_jsonb` 取整行，避免手数列名漂移。
   */
  async listRunningAttempts(): Promise<readonly {
    attempt: AssistDelegationAttemptRow; delegation: AssistDelegationRow;
  }[]> {
    const rows = (await sql<{ attempt: AssistDelegationAttemptRow;
      delegation: AssistDelegationRow }>`
      select to_jsonb(a) as attempt, to_jsonb(d) as delegation
      from assist_delegation_attempts a
      join assist_delegations d on d.id = a.delegation_id
      where a.status = 'RUNNING'
      order by a.created_at`.execute(this.db)).rows;
    return rows;
  }
}
