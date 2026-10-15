import { sql } from 'kysely';
import { requireRow } from '../shared/sql-rows.js';
const REQUEST_COLUMNS = sql.raw('id, workspace_id, project_id, task_id, run_id, verification_session_id, criterion_id, operation_id, import_job_id, kind, reason, status, revision, target_hash, target, evidence, effect, allowed_decisions, expires_at, created_at, decided_at');
const DECISION_COLUMNS = sql.raw('id, review_id, command_id, decision, feedback, retry_budget, target_hash, effect, decided_at');
export class ReviewRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async insertRequest(input) {
        const result = await sql `
      insert into review_requests (
        id, workspace_id, project_id, task_id, run_id, verification_session_id,
        criterion_id, operation_id, import_job_id, kind, reason, target_hash, target,
        evidence, effect, allowed_decisions, expires_at
      ) values (
        ${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.taskId}, ${input.runId},
        ${input.verificationSessionId}, ${input.criterionId}, ${input.operationId}, ${input.importJobId},
        ${input.kind}, ${input.reason}, ${input.targetHash}, ${JSON.stringify(input.target)}::jsonb,
        ${JSON.stringify(input.evidence)}::jsonb, ${JSON.stringify(input.effect)}::jsonb,
        ${sql `array[${sql.join(input.allowedDecisions)}]::text[]`}, ${input.expiresAt}
      ) returning ${REQUEST_COLUMNS}
    `.execute(this.db);
        return requireRow(result.rows, 'insert into review_requests');
    }
    async readRequest(id) {
        const result = await sql `select ${REQUEST_COLUMNS} from review_requests where id = ${id}`.execute(this.db);
        return result.rows[0];
    }
    async lockRequest(id) {
        const result = await sql `select ${REQUEST_COLUMNS} from review_requests where id = ${id} for update`.execute(this.db);
        return result.rows[0];
    }
    async listByWorkspace(workspaceId, status) {
        const result = await sql `
      select ${REQUEST_COLUMNS} from review_requests
      where workspace_id = ${workspaceId} and (${status ?? null}::text is null or status = ${status ?? null})
      order by created_at, id
    `.execute(this.db);
        return result.rows;
    }
    async listByRun(runId) {
        const result = await sql `
      select ${REQUEST_COLUMNS} from review_requests where run_id = ${runId} order by created_at, id
    `.execute(this.db);
        return result.rows;
    }
    async decideRequest(id, expectedRevision) {
        const result = await sql `
      update review_requests set status = 'DECIDED', revision = revision + 1, decided_at = now()
      where id = ${id} and status = 'OPEN' and revision = ${expectedRevision}
      returning ${REQUEST_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    async expireRequest(id, expectedRevision) {
        const result = await sql `
      update review_requests set status = 'EXPIRED', revision = revision + 1
      where id = ${id} and status = 'OPEN' and revision = ${expectedRevision}
      returning ${REQUEST_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    async expireOpenForRun(runId, exceptReviewId) {
        await sql `
      update review_requests set status = 'EXPIRED', revision = revision + 1
      where run_id = ${runId} and id <> ${exceptReviewId} and status = 'OPEN'
    `.execute(this.db);
    }
    async insertDecision(input) {
        const result = await sql `
      insert into review_decisions (id, review_id, command_id, decision, feedback, retry_budget, target_hash, effect)
      values (${input.id}, ${input.reviewId}, ${input.commandId}, ${input.decision}, ${input.feedback},
        ${input.retryBudget}, ${input.targetHash}, ${JSON.stringify(input.effect)}::jsonb)
      returning ${DECISION_COLUMNS}
    `.execute(this.db);
        return requireRow(result.rows, 'insert into review_decisions');
    }
    async readDecision(reviewId) {
        const result = await sql `select ${DECISION_COLUMNS} from review_decisions where review_id = ${reviewId}`.execute(this.db);
        return result.rows[0];
    }
    async readByOperationId(operationId) {
        const result = await sql `select ${REQUEST_COLUMNS} from review_requests where operation_id = ${operationId}`.execute(this.db);
        return result.rows[0];
    }
    async readCorrectionBudget(runId) {
        const result = await sql `
      select run_id, max_corrections, revision, updated_at from run_correction_budgets where run_id = ${runId}
    `.execute(this.db);
        return result.rows[0];
    }
    async setCorrectionBudget(runId, maxCorrections) {
        const result = await sql `
      insert into run_correction_budgets (run_id, max_corrections) values (${runId}, ${maxCorrections})
      on conflict (run_id) do update set max_corrections = excluded.max_corrections,
        revision = run_correction_budgets.revision + 1, updated_at = now()
      returning run_id, max_corrections, revision, updated_at
    `.execute(this.db);
        return requireRow(result.rows, 'upsert run_correction_budgets');
    }
}
