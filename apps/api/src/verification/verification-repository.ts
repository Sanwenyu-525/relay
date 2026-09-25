import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  CheckResultRow,
  CheckResultValue,
  CheckSeverity,
  VerificationApplicabilityRow,
  VerificationSessionRow,
  VerificationSessionStatus,
  VerificationTargetRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { requireRow } from '../shared/sql-rows.js';

/**
 * Verification Session / Target / CheckResult / Applicability 的持久化入口
 * （migrations/0005_v002_verification.sql）。
 *
 * 边界（contracts/03 第 3–5 节）：
 *   * Session 绑定 task + acceptance_revision +（自动路径）run/契约与 CheckPlan 摘要；
 *   * CheckResult 只追加，同 (session, criterion, attempt) 唯一，历史不可改写；
 *   * ERROR/NOT_RUN 不转 PASS；总决策由应用用例写入 session.status/verdict；
 *   * 撤销适用性写 verification_applicability，不删除也不改写原 PASS 结果。
 *
 * 本仓储不决定业务语义：是否 PASS/RETRY/HUMAN、预算是否耗尽由应用用例裁决。
 */

const SESSION_COLUMNS = sql.raw(
  'id, task_id, acceptance_revision, run_id, execution_contract_id, verifier_policy_version, check_plan_hash, check_plan, status, verdict, revision, correction_budget_used, created_at, updated_at, finalized_at, parent_session_id',
);

const TARGET_COLUMNS = sql.raw(
  'session_id, artifact_version_id, content_hash, created_at',
);

const CHECK_RESULT_COLUMNS = sql.raw(
  'id, session_id, criterion_id, check_attempt, checker_id, checker_version, result, required, severity, evidence_refs, created_at',
);

const APPLICABILITY_COLUMNS = sql.raw(
  'session_id, revoked_at, reason, source_ref',
);

export interface NewVerificationSession {
  readonly id: string;
  readonly taskId: string;
  readonly acceptanceRevision: bigint;
  readonly runId: string | null;
  readonly executionContractId: string | null;
  readonly verifierPolicyVersion: string;
  readonly checkPlanHash: Buffer;
  readonly checkPlan: JsonObject;
  /** 创建时已用修正预算（该 Run 已 finalize 为 RETRY 的 session 数）；缺省 0。 */
  readonly correctionBudgetUsed?: bigint | undefined;
  readonly parentSessionId?: string | null | undefined;
}

export interface NewVerificationTarget {
  readonly sessionId: string;
  readonly artifactVersionId: string;
  readonly contentHash: Buffer;
}

export interface NewCheckResult {
  readonly id: string;
  readonly sessionId: string;
  readonly criterionId: string;
  readonly checkAttempt: number;
  readonly checkerId: string;
  readonly checkerVersion: string;
  readonly result: CheckResultValue;
  readonly required: boolean;
  readonly severity: CheckSeverity;
  readonly evidenceRefs: JsonObject;
}

export class VerificationRepository {
  private readonly db: DbExecutor;

  constructor(db: DbExecutor) {
    this.db = db;
  }

  async insertSession(input: NewVerificationSession): Promise<VerificationSessionRow> {
    const result = await sql<VerificationSessionRow>`
      insert into verification_sessions (
        id, task_id, acceptance_revision, run_id, execution_contract_id,
        verifier_policy_version, check_plan_hash, check_plan, status, correction_budget_used,
        parent_session_id
      )
      values (
        ${input.id}, ${input.taskId}, ${input.acceptanceRevision}, ${input.runId},
        ${input.executionContractId}, ${input.verifierPolicyVersion},
        ${input.checkPlanHash}, ${JSON.stringify(input.checkPlan)}::jsonb, 'OPEN',
        ${input.correctionBudgetUsed ?? 0n}, ${input.parentSessionId ?? null}
      )
      returning ${SESSION_COLUMNS}
    `.execute(this.db);

    return requireRow(result.rows, 'insert into verification_sessions');
  }

  async readSession(sessionId: string): Promise<VerificationSessionRow | undefined> {
    const result = await sql<VerificationSessionRow>`
      select ${SESSION_COLUMNS} from verification_sessions where id = ${sessionId}
    `.execute(this.db);

    return result.rows[0];
  }

  /** Session 行锁：总决策、预算与完成核对在同一行上串行化。 */
  async lockSession(sessionId: string): Promise<VerificationSessionRow | undefined> {
    const result = await sql<VerificationSessionRow>`
      select ${SESSION_COLUMNS} from verification_sessions where id = ${sessionId} for update
    `.execute(this.db);

    return result.rows[0];
  }

  async listSessionsByRun(runId: string): Promise<readonly VerificationSessionRow[]> {
    const result = await sql<VerificationSessionRow>`
      select ${SESSION_COLUMNS}
      from verification_sessions
      where run_id = ${runId}
      order by created_at, id
    `.execute(this.db);

    return result.rows;
  }

  async listSessionsByTaskCycle(
    taskId: string,
    acceptanceRevision: bigint,
  ): Promise<readonly VerificationSessionRow[]> {
    const result = await sql<VerificationSessionRow>`
      select ${SESSION_COLUMNS}
      from verification_sessions
      where task_id = ${taskId} and acceptance_revision = ${acceptanceRevision}
      order by created_at, id
    `.execute(this.db);

    return result.rows;
  }

  /** 总决策 CAS：仅 OPEN → 已决；revision 不匹配返回 undefined。 */
  async finalizeSession(input: {
    readonly sessionId: string;
    readonly expectedRevision: bigint;
    readonly status: Exclude<VerificationSessionStatus, 'OPEN'>;
    readonly correctionBudgetUsed: bigint;
  }): Promise<VerificationSessionRow | undefined> {
    const result = await sql<VerificationSessionRow>`
      update verification_sessions
      set status = ${input.status},
          verdict = ${input.status},
          correction_budget_used = ${input.correctionBudgetUsed},
          revision = revision + 1,
          updated_at = now(),
          finalized_at = now()
      where id = ${input.sessionId}
        and revision = ${input.expectedRevision}
        and status = 'OPEN'
      returning ${SESSION_COLUMNS}
    `.execute(this.db);

    return result.rows[0];
  }

  /**
   * 绑定验证目标。同一 (session, artifact_version_id) 只写一行：
   * 重复执行同一 VERIFY 既不再报错也不产生第二行，重复时读回既有行。
   */
  async insertTarget(input: NewVerificationTarget): Promise<VerificationTargetRow> {
    const inserted = await sql<VerificationTargetRow>`
      insert into verification_targets (session_id, artifact_version_id, content_hash)
      values (${input.sessionId}, ${input.artifactVersionId}, ${input.contentHash})
      on conflict (session_id, artifact_version_id) do nothing
      returning ${TARGET_COLUMNS}
    `.execute(this.db);

    if (inserted.rows[0] !== undefined) {
      return inserted.rows[0];
    }

    const existing = await this.readTarget(input.sessionId, input.artifactVersionId);

    if (existing === undefined) {
      throw new Error('verification target insert conflicted but no existing row was found');
    }

    return existing;
  }

  async readTarget(
    sessionId: string,
    artifactVersionId: string,
  ): Promise<VerificationTargetRow | undefined> {
    const result = await sql<VerificationTargetRow>`
      select ${TARGET_COLUMNS}
      from verification_targets
      where session_id = ${sessionId} and artifact_version_id = ${artifactVersionId}
    `.execute(this.db);

    return result.rows[0];
  }

  async listTargets(sessionId: string): Promise<readonly VerificationTargetRow[]> {
    const result = await sql<VerificationTargetRow>`
      select ${TARGET_COLUMNS}
      from verification_targets
      where session_id = ${sessionId}
      order by artifact_version_id
    `.execute(this.db);

    return result.rows;
  }

  async insertCheckResult(input: NewCheckResult): Promise<CheckResultRow> {
    const result = await sql<CheckResultRow>`
      insert into check_results (
        id, session_id, criterion_id, check_attempt, checker_id, checker_version,
        result, required, severity, evidence_refs
      )
      values (
        ${input.id}, ${input.sessionId}, ${input.criterionId}, ${input.checkAttempt},
        ${input.checkerId}, ${input.checkerVersion}, ${input.result},
        ${input.required}, ${input.severity}, ${JSON.stringify(input.evidenceRefs)}::jsonb
      )
      returning ${CHECK_RESULT_COLUMNS}
    `.execute(this.db);

    return requireRow(result.rows, 'insert into check_results');
  }

  async listCheckResults(sessionId: string): Promise<readonly CheckResultRow[]> {
    const result = await sql<CheckResultRow>`
      select ${CHECK_RESULT_COLUMNS}
      from check_results
      where session_id = ${sessionId}
      order by criterion_id, check_attempt
    `.execute(this.db);

    return result.rows;
  }

  /** 每条 criterion 取最大 attempt 的最新结果（总决策输入）。 */
  async listLatestCheckResults(sessionId: string): Promise<readonly CheckResultRow[]> {
    const result = await sql<CheckResultRow>`
      select ${CHECK_RESULT_COLUMNS}
      from check_results cr
      where cr.session_id = ${sessionId}
        and cr.check_attempt = (
          select max(cr2.check_attempt)
          from check_results cr2
          where cr2.session_id = cr.session_id and cr2.criterion_id = cr.criterion_id
        )
      order by cr.criterion_id
    `.execute(this.db);

    return result.rows;
  }

  /** 显式撤销适用性：已有撤销时返回既有行（重复撤销幂等，不改写历史理由）。 */
  async insertApplicabilityRevocation(input: {
    readonly sessionId: string;
    readonly reason: string;
    readonly sourceRef: string;
  }): Promise<{ readonly row: VerificationApplicabilityRow; readonly inserted: boolean }> {
    const inserted = await sql<VerificationApplicabilityRow>`
      insert into verification_applicability (session_id, reason, source_ref)
      values (${input.sessionId}, ${input.reason}, ${input.sourceRef})
      on conflict (session_id) do nothing
      returning ${APPLICABILITY_COLUMNS}
    `.execute(this.db);

    if (inserted.rows[0] !== undefined) {
      return { row: inserted.rows[0], inserted: true };
    }

    const existing = await this.readApplicability(input.sessionId);

    if (existing === undefined) {
      throw new Error('verification applicability insert conflicted but no existing row was found');
    }

    return { row: existing, inserted: false };
  }

  async readApplicability(
    sessionId: string,
  ): Promise<VerificationApplicabilityRow | undefined> {
    const result = await sql<VerificationApplicabilityRow>`
      select ${APPLICABILITY_COLUMNS}
      from verification_applicability
      where session_id = ${sessionId}
    `.execute(this.db);

    return result.rows[0];
  }

  async isApplicable(sessionId: string): Promise<boolean> {
    const revoked = await this.readApplicability(sessionId);
    return revoked === undefined;
  }
}
