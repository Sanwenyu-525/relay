import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ModelCallRow } from '../infrastructure/database-schema.js';
import type { ModelIdentity, ModelUsage } from '../workflow/fake-model-port.js';

export interface ModelCallOrigin {
  readonly workspaceId: string;
  readonly kind: ModelCallRow['kind'];
  readonly stepAttemptId?: string;
  readonly assistMessageId?: string;
  readonly manifestId?: string;
  readonly inputHash?: string;
  readonly readOperationId?: string;
  readonly readInvocationId?: string;
  readonly criterionId?: string;
  readonly checkAttempt?: number;
}

export interface ModelCallSettlement {
  readonly status: Exclude<ModelCallRow['status'], 'STARTED'>;
  readonly providerRequestId?: string | null;
  readonly usage?: ModelUsage;
  readonly errorKind?: string | null;
}

export class ModelScopeBudgetError extends Error {
  override readonly name = 'ModelScopeBudgetError';
  constructor() { super('model scope call or token budget exhausted'); }
}

export class ModelScopeArchivedError extends Error {
  override readonly name = 'ModelScopeArchivedError';
  constructor() { super('model call Project is archived'); }
}

/** Cost evidence only; the Run, CheckResult and Assist message own their own
 * business outcome. Never store prompts, responses, endpoints or credentials. */
export class ModelCallRepository {
  constructor(private readonly db: DbExecutor) {}

  async read(id: string, share = false): Promise<ModelCallRow | undefined> {
    const lock = share ? sql`for share` : sql``;
    return (await sql<ModelCallRow>`select * from model_calls where id = ${id} ${lock}`
      .execute(this.db)).rows[0];
  }

  async begin(id: string, origin: ModelCallOrigin, identity: ModelIdentity): Promise<void> {
    const budget = identity.budget;
    await this.db.transaction().execute(async (trx) => {
      const runScope = origin.stepAttemptId === undefined ? undefined
        : (await sql<{ id: string; project_id: string | null }>`select r.id, t.project_id
          from step_attempts a join run_steps s on s.id = a.step_id
          join runs r on r.id = s.run_id join tasks t on t.id = r.task_id
          where a.id = ${origin.stepAttemptId} and r.workspace_id = ${origin.workspaceId}`
          .execute(trx)).rows[0];
      const assistScope = origin.assistMessageId === undefined ? undefined
        : (await sql<{ id: string; project_id: string | null }>`select s.id,
            coalesce(s.project_id, t.project_id) as project_id
          from assist_messages m join assist_sessions s on s.id = m.session_id
          left join tasks t on t.id = s.task_id
          where m.id = ${origin.assistMessageId} and s.workspace_id = ${origin.workspaceId}`
          .execute(trx)).rows[0];
      if ((runScope === undefined) === (assistScope === undefined)) {
        throw new Error('model call scope is missing or ambiguous');
      }
      const projectId = runScope?.project_id ?? assistScope?.project_id ?? null;
      if (projectId !== null) {
        // The admission gate and STARTED row commit together before any network
        // call. ArchiveProject either precedes this lock or observes STARTED.
        const project = (await sql<{ archived_at: Date | null }>`select archived_at
          from projects where id = ${projectId} and workspace_id = ${origin.workspaceId}
          for key share`.execute(trx)).rows[0];
        if (project === undefined || project.archived_at !== null) {
          throw new ModelScopeArchivedError();
        }
      }
      if (budget !== undefined) {
        if (runScope !== undefined) {
          await sql`select id from runs where id = ${runScope.id} for update`.execute(trx);
        } else {
          await sql`select id from assist_sessions where id = ${assistScope!.id}
            for update`.execute(trx);
        }
        const totals = runScope === undefined
          ? await sql<{ calls: string; tokens: string }>`select count(*)::text as calls,
              coalesce(sum(case when c.usage_input_tokens is not null and
                c.usage_output_tokens is not null then
                c.usage_input_tokens + c.usage_output_tokens
                else coalesce(c.budget_reserved_tokens,
                  ${budget.scopeTokenLimit}) end), 0)::text as tokens
              from model_calls c join assist_messages m on m.id = c.assist_message_id
              where m.session_id = ${assistScope!.id} and c.workspace_id = ${origin.workspaceId}`
            .execute(trx)
          : await sql<{ calls: string; tokens: string }>`select count(*)::text as calls,
              coalesce(sum(case when c.usage_input_tokens is not null and
                c.usage_output_tokens is not null then
                c.usage_input_tokens + c.usage_output_tokens
                else coalesce(c.budget_reserved_tokens,
                  ${budget.scopeTokenLimit}) end), 0)::text as tokens
              from model_calls c join step_attempts a on a.id = c.step_attempt_id
              join run_steps s on s.id = a.step_id
              where s.run_id = ${runScope.id} and c.workspace_id = ${origin.workspaceId}`
            .execute(trx);
        const used = totals.rows[0]!;
        if (Number(used.calls) >= budget.scopeCallLimit ||
            Number(used.tokens) + budget.callReservationTokens >
              budget.scopeTokenLimit) throw new ModelScopeBudgetError();
      }
      await this.insert(trx, id, origin, identity);
    });
  }

  private async insert(db: DbExecutor, id: string, origin: ModelCallOrigin,
    identity: ModelIdentity): Promise<void> {
    await sql`insert into model_calls (id, workspace_id, kind, step_attempt_id,
      assist_message_id, manifest_id, criterion_id, check_attempt,
      provider, model, config_fingerprint, input_sha256,
      read_operation_id, read_invocation_id, budget_reserved_tokens)
      values (${id}, ${origin.workspaceId}, ${origin.kind},
        ${origin.stepAttemptId ?? null}, ${origin.assistMessageId ?? null},
        ${origin.manifestId ?? null}, ${origin.criterionId ?? null},
        ${origin.checkAttempt ?? null}, ${identity.provider}, ${identity.model},
        ${identity.configFingerprint}, ${origin.inputHash ?? null},
        ${origin.readOperationId ?? null}, ${origin.readInvocationId ?? null},
        ${identity.budget?.callReservationTokens ?? null})`.execute(db);
  }

  async settle(id: string, input: ModelCallSettlement): Promise<void> {
    const requestId = input.providerRequestId === undefined || input.providerRequestId === ''
      ? null : input.providerRequestId;
    const usageInput = input.usage?.inputTokens ?? null;
    const usageOutput = input.usage?.outputTokens ?? null;
    const changed = await sql<{ id: string }>`update model_calls set
      status = ${input.status}, provider_request_id = ${requestId},
      usage_input_tokens = ${usageInput}, usage_output_tokens = ${usageOutput},
      error_kind = ${input.errorKind ?? null}, settled_at = clock_timestamp()
      where id = ${id} and status = 'STARTED' returning id`.execute(this.db);
    if (changed.rows.length !== 1) throw new Error('model call was already settled');
  }

  async listForStepAttempt(stepAttemptId: string): Promise<readonly ModelCallRow[]> {
    return (await sql<ModelCallRow>`select * from model_calls
      where step_attempt_id = ${stepAttemptId} order by started_at, id`.execute(this.db)).rows;
  }

  async listForAssistMessage(messageId: string): Promise<readonly ModelCallRow[]> {
    return (await sql<ModelCallRow>`select * from model_calls
      where assist_message_id = ${messageId} order by started_at, id`.execute(this.db)).rows;
  }
}
