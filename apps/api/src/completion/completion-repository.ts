import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  CompletionBasisKind,
  CompletionRecordRow,
  HumanAcceptanceActorKind,
  HumanAcceptanceRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { requireRow } from '../shared/sql-rows.js';

export interface NewHumanAcceptance {
  readonly id: string;
  readonly taskId: string;
  readonly acceptanceRevision: bigint;
  readonly actorKind: HumanAcceptanceActorKind;
  readonly actorRef: string;
  readonly statement: string;
  readonly acceptedCriterionIds: readonly string[];
  readonly acceptedVersionRefs: readonly string[];
  readonly reason: string | null;
}

export interface NewCompletionRecord {
  readonly id: string;
  readonly taskId: string;
  readonly acceptanceRevision: bigint;
  readonly basisKind: CompletionBasisKind;
  /** HUMAN 完成必填；AUTO 完成为 null。 */
  readonly humanAcceptanceId: string | null;
  /** AUTO 完成必填，与 run_id 一起绑定到本周期的 PASS session。 */
  readonly verificationSessionId?: string | null;
  readonly runId?: string | null;
  readonly stateDelta: JsonObject;
}

/**
 * 人工接受与完成凭据。两张表都是不可变历史：应用角色只有 SELECT/INSERT。
 * 同一 Task 周期最多一条 completion_records（uq_completion_records_cycle）；
 * 完成依据必须属于同一周期（复合外键），不能借别的周期的接受记录完成本轮。
 */
export class CompletionRepository {
  private readonly db: DbExecutor;

  constructor(db: DbExecutor) {
    this.db = db;
  }

  async insertHumanAcceptance(acceptance: NewHumanAcceptance): Promise<HumanAcceptanceRow> {
    const result = await sql<HumanAcceptanceRow>`
      insert into human_acceptances (
        id, task_id, acceptance_revision, actor_kind, actor_ref, statement,
        accepted_criterion_ids, accepted_version_refs, reason
      )
      values (
        ${acceptance.id}, ${acceptance.taskId}, ${acceptance.acceptanceRevision},
        ${acceptance.actorKind}, ${acceptance.actorRef}, ${acceptance.statement},
        ${JSON.stringify(acceptance.acceptedCriterionIds)}::jsonb,
        ${JSON.stringify(acceptance.acceptedVersionRefs)}::jsonb,
        ${acceptance.reason}
      )
      returning id, task_id, acceptance_revision, actor_kind, actor_ref, statement,
                accepted_criterion_ids, accepted_version_refs, reason, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into human_acceptances');
  }

  async insertCompletionRecord(record: NewCompletionRecord): Promise<CompletionRecordRow> {
    const result = await sql<CompletionRecordRow>`
      insert into completion_records (
        id, task_id, acceptance_revision, basis_kind, human_acceptance_id,
        verification_session_id, run_id, state_delta
      )
      values (
        ${record.id}, ${record.taskId}, ${record.acceptanceRevision}, ${record.basisKind},
        ${record.humanAcceptanceId}, ${record.verificationSessionId ?? null},
        ${record.runId ?? null}, ${JSON.stringify(record.stateDelta)}::jsonb
      )
      returning id, task_id, acceptance_revision, basis_kind, human_acceptance_id,
                verification_session_id, run_id, state_delta, committed_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into completion_records');
  }

  async readCompletionRecord(recordId: string): Promise<CompletionRecordRow | undefined> {
    const result = await sql<CompletionRecordRow>`
      select id, task_id, acceptance_revision, basis_kind, human_acceptance_id,
             verification_session_id, run_id, state_delta, committed_at
      from completion_records
      where id = ${recordId}
    `.execute(this.db);

    return result.rows[0];
  }

  async readHumanAcceptance(acceptanceId: string): Promise<HumanAcceptanceRow | undefined> {
    const result = await sql<HumanAcceptanceRow>`
      select id, task_id, acceptance_revision, actor_kind, actor_ref, statement,
             accepted_criterion_ids, accepted_version_refs, reason, created_at
      from human_acceptances
      where id = ${acceptanceId}
    `.execute(this.db);

    return result.rows[0];
  }

  async listCompletionRecordsByCycle(
    taskId: string,
    acceptanceRevision: bigint,
  ): Promise<readonly CompletionRecordRow[]> {
    const result = await sql<CompletionRecordRow>`
      select id, task_id, acceptance_revision, basis_kind, human_acceptance_id,
             verification_session_id, run_id, state_delta, committed_at
      from completion_records
      where task_id = ${taskId} and acceptance_revision = ${acceptanceRevision}
    `.execute(this.db);

    return result.rows;
  }
}
