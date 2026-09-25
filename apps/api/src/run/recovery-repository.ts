import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  RunControlRequestRow, RunControlStatus, RunControlType, RunEffectActionRow, RunEffectStatus,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { requireRow } from '../shared/sql-rows.js';

const CONTROL_COLUMNS = sql.raw('id, workspace_id, task_id, run_id, type, requested_by, status, revision, result_ref, supersedes_request_id, requested_at, decided_at');
const EFFECT_COLUMNS = sql.raw('operation_id, run_id, step_id, attempt_id, action_type, target_ref, params_hash, status, result_ref, revision, dispatch_count, created_at, dispatched_at, resolved_at');

/** P08 恢复事实；业务裁决留给应用用例。 */
export class RecoveryRepository {
  constructor(private readonly db: DbExecutor) {}

  async insertControl(input: {
    readonly id: string; readonly workspaceId: string; readonly taskId: string; readonly runId: string;
    readonly type: RunControlType; readonly requestedBy: string; readonly supersedesRequestId?: string | null;
  }): Promise<RunControlRequestRow> {
    const result = await sql<RunControlRequestRow>`
      insert into run_control_requests (id, workspace_id, task_id, run_id, type, requested_by, supersedes_request_id)
      values (${input.id}, ${input.workspaceId}, ${input.taskId}, ${input.runId}, ${input.type},
        ${input.requestedBy}, ${input.supersedesRequestId ?? null})
      returning ${CONTROL_COLUMNS}
    `.execute(this.db);
    return requireRow(result.rows, 'insert run control request');
  }

  async readControl(id: string): Promise<RunControlRequestRow | undefined> {
    const result = await sql<RunControlRequestRow>`select ${CONTROL_COLUMNS} from run_control_requests where id = ${id}`.execute(this.db);
    return result.rows[0];
  }

  async lockPendingControl(runId: string): Promise<RunControlRequestRow | undefined> {
    const result = await sql<RunControlRequestRow>`
      select ${CONTROL_COLUMNS} from run_control_requests where run_id = ${runId} and status = 'PENDING' for update
    `.execute(this.db);
    return result.rows[0];
  }

  async findPendingControl(runId: string): Promise<RunControlRequestRow | undefined> {
    const result = await sql<RunControlRequestRow>`
      select ${CONTROL_COLUMNS} from run_control_requests where run_id = ${runId} and status = 'PENDING'
    `.execute(this.db);
    return result.rows[0];
  }

  async listIdlePendingControls(limit: number,
    after?: { requestedAt: Date; id: string }): Promise<readonly {
      id: string; run_id: string; requested_at: Date;
    }[]> {
    const cursor = after === undefined ? sql`` : sql`
      and (c.requested_at, c.id) > (${after.requestedAt}, ${after.id}::uuid)
    `;
    const result = await sql<{ id: string; run_id: string; requested_at: Date }>`
      select c.id, c.run_id, c.requested_at from run_control_requests c
      join run_invocations i on i.run_id = c.run_id
      join runs r on r.id = c.run_id
      where c.status = 'PENDING' and i.status = 'IDLE' and r.worker_id is null
        ${cursor}
      order by c.requested_at, c.id limit ${limit}
    `.execute(this.db);
    return result.rows;
  }

  async decideControl(id: string, status: Exclude<RunControlStatus, 'PENDING'>, resultRef: JsonObject): Promise<RunControlRequestRow | undefined> {
    const result = await sql<RunControlRequestRow>`
      update run_control_requests set status = ${status}, revision = revision + 1,
        result_ref = ${JSON.stringify(resultRef)}::jsonb, decided_at = now()
      where id = ${id} and status = 'PENDING' returning ${CONTROL_COLUMNS}
    `.execute(this.db);
    return result.rows[0];
  }

  async insertEffect(input: {
    readonly operationId: string; readonly runId: string; readonly stepId: string; readonly attemptId: string;
    readonly targetRef: string; readonly paramsHash: Buffer;
  }): Promise<RunEffectActionRow> {
    const result = await sql<RunEffectActionRow>`
      insert into run_effect_actions (operation_id, run_id, step_id, attempt_id, action_type, target_ref, params_hash)
      values (${input.operationId}, ${input.runId}, ${input.stepId}, ${input.attemptId},
        'PUBLISH_CANDIDATE', ${input.targetRef}, ${input.paramsHash})
      on conflict (attempt_id) do nothing returning ${EFFECT_COLUMNS}
    `.execute(this.db);
    if (result.rows[0] !== undefined) return result.rows[0];
    const existing = await this.readEffectByAttempt(input.attemptId);
    if (existing === undefined) throw new Error('effect insert conflicted without existing row');
    return existing;
  }

  async readEffectByAttempt(attemptId: string): Promise<RunEffectActionRow | undefined> {
    const result = await sql<RunEffectActionRow>`select ${EFFECT_COLUMNS} from run_effect_actions where attempt_id = ${attemptId}`.execute(this.db);
    return result.rows[0];
  }

  async lockEffectByAttempt(attemptId: string): Promise<RunEffectActionRow | undefined> {
    const result = await sql<RunEffectActionRow>`select ${EFFECT_COLUMNS} from run_effect_actions where attempt_id = ${attemptId} for update`.execute(this.db);
    return result.rows[0];
  }

  async listUnresolvedEffects(runId: string): Promise<readonly RunEffectActionRow[]> {
    const result = await sql<RunEffectActionRow>`
      select ${EFFECT_COLUMNS} from run_effect_actions
      where run_id = ${runId} and (
        status in ('DISPATCHING', 'UNKNOWN')
        or (status = 'SUCCEEDED' and exists (
          select 1 from step_attempts a where a.id = run_effect_actions.attempt_id and a.status = 'RUNNING'
        ))
      ) order by created_at, operation_id
    `.execute(this.db);
    return result.rows;
  }

  async dispatchEffect(operationId: string): Promise<RunEffectActionRow | undefined> {
    const result = await sql<RunEffectActionRow>`
      update run_effect_actions set status = 'DISPATCHING', revision = revision + 1,
        dispatch_count = dispatch_count + 1, dispatched_at = now()
      where operation_id = ${operationId} and status = 'PREPARED' returning ${EFFECT_COLUMNS}
    `.execute(this.db);
    return result.rows[0];
  }

  async resolveEffect(operationId: string, expectedStatus: RunEffectStatus, status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN', resultRef: JsonObject): Promise<RunEffectActionRow | undefined> {
    const result = await sql<RunEffectActionRow>`
      update run_effect_actions set status = ${status}, revision = revision + 1,
        result_ref = ${JSON.stringify(resultRef)}::jsonb, resolved_at = now()
      where operation_id = ${operationId} and status = ${expectedStatus} returning ${EFFECT_COLUMNS}
    `.execute(this.db);
    return result.rows[0];
  }

  /** 仅在旧 Worker 已确认停止且目标内容确实不存在后，允许同一 operation_id 重发。 */
  async resetAbsentEffect(operationId: string, expectedStatus: 'DISPATCHING' | 'UNKNOWN'): Promise<RunEffectActionRow | undefined> {
    const result = await sql<RunEffectActionRow>`
      update run_effect_actions set status = 'PREPARED', revision = revision + 1,
        result_ref = null, resolved_at = null
      where operation_id = ${operationId} and status = ${expectedStatus} returning ${EFFECT_COLUMNS}
    `.execute(this.db);
    return result.rows[0];
  }

  async hasWorkerFence(runId: string, workerId: string, workerEpoch: bigint): Promise<boolean> {
    const result = await sql<{ present: boolean }>`
      select exists (
        select 1 from activity_records
        where event_type = 'RUN_WORKER_FENCED'
          and fact_refs ->> 'run_id' = ${runId}
          and fact_refs ->> 'stopped_worker_id' = ${workerId}
          and fact_refs ->> 'worker_epoch' = ${workerEpoch.toString()}
      ) as present
    `.execute(this.db);
    return result.rows[0]?.present ?? false;
  }

  async listExpiredWorkerRuns(limit: number): Promise<readonly { readonly id: string; readonly worker_id: string }[]> {
    const result = await sql<{ id: string; worker_id: string }>`
      select id, worker_id from (
        select r.id, r.worker_id from runs r
        where r.worker_id is not null and r.worker_lease_until <= now()
        union
        select r.id, a.worker_id from runs r
        join run_effect_actions e on e.run_id = r.id
        join step_attempts a on a.id = e.attempt_id
        where r.worker_id is null and a.worker_id is not null
          and (e.status in ('DISPATCHING', 'UNKNOWN') or (e.status = 'SUCCEEDED' and a.status = 'RUNNING'))
          and exists (
            select 1 from activity_records event
            where event.event_type = 'RUN_WORKER_FENCED'
              and event.fact_refs ->> 'run_id' = r.id::text
              and event.fact_refs ->> 'stopped_worker_id' = a.worker_id
              and event.fact_refs ->> 'worker_epoch' = r.worker_epoch::text
          )
      ) candidates order by id limit ${limit}
    `.execute(this.db);
    return result.rows;
  }
}
