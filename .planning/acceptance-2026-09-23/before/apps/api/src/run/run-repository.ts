import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  ContextManifestRow,
  ExecutionContractRow,
  RunRow,
  RunStatus,
  RunStepKind,
  RunStepRow,
  RunStepStatus,
  StepAttemptRow,
  StepAttemptStatus,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { requireRow } from '../shared/sql-rows.js';

/**
 * Run / Step / Attempt 与执行契约的持久化入口（migrations/0004_v002_runs.sql）。
 *
 * 边界（contracts/02-state-and-execution.md 第 2、3 节）：
 *   * 一个 Task 至多一个未释放的 AI 执行权占有者，由 uq_run_live_task 与 Task 行的条件更新共同保证；
 *   * Run 的写提交必须匹配 Task 当前 executor_run_id 与 ownership_epoch，旧 epoch 的结果被拒绝；
 *   * Step 位置与 Attempt 结果只在同一事务内推进，重放同一来源尝试由 attempt_key 唯一约束去重。
 *
 * 本仓储不决定业务语义：状态是否允许迁移、失败是否可修正由应用用例裁决。
 */

const RUN_COLUMNS = sql.raw(
  'id, workspace_id, task_id, status, revision, ownership_epoch, retry_of_run_id, resume_phase, wait_reason, current_step_id, created_at, updated_at, terminal_at',
);

const STEP_COLUMNS = sql.raw(
  'id, run_id, step_index, step_kind, status, revision, result_ref, started_at, finished_at, created_at',
);

const ATTEMPT_COLUMNS = sql.raw(
  'id, step_id, attempt_number, attempt_key, status, worker_id, claim_epoch, lease_until, result_ref, evidence, started_at, finished_at, created_at',
);

export interface NewRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly ownershipEpoch: bigint;
  readonly retryOfRunId: string | null;
}

export interface NewExecutionContract {
  readonly runId: string;
  readonly taskId: string;
  readonly acceptanceRevision: bigint;
  readonly workflowKey: string;
  readonly workflowVersion: string;
  readonly executionConfigVersion: string;
  readonly contractHash: Buffer;
  readonly frozenSnapshot: JsonObject;
}

export interface NewRunStep {
  readonly id: string;
  readonly runId: string;
  readonly stepIndex: number;
  readonly stepKind: RunStepKind;
}

export interface NewStepAttempt {
  readonly id: string;
  readonly stepId: string;
  readonly attemptNumber: bigint;
  readonly attemptKey: string;
}

export interface RunAdvance {
  readonly runId: string;
  readonly expectedRevision: bigint;
  readonly status: RunStatus;
  readonly currentStepId?: string | null;
  readonly waitReason?: string | null;
  readonly resumePhase?: string | null;
  readonly terminal?: boolean;
}

export class RunRepository {
  private readonly db: DbExecutor;

  constructor(db: DbExecutor) {
    this.db = db;
  }

  /** 终态与结束时间一起写入；非终态清空 terminal_at，避免“已结束但仍可领取”。 */
  async insertRun(run: NewRun): Promise<RunRow> {
    const result = await sql<RunRow>`
      insert into runs (id, workspace_id, task_id, status, ownership_epoch, retry_of_run_id)
      values (${run.id}, ${run.workspaceId}, ${run.taskId}, 'CREATED', ${run.ownershipEpoch}, ${run.retryOfRunId})
      returning ${RUN_COLUMNS}
    `.execute(this.db);

    return requireRow(result.rows, 'insert into runs');
  }

  async insertExecutionContract(contract: NewExecutionContract): Promise<ExecutionContractRow> {
    const result = await sql<ExecutionContractRow>`
      insert into execution_contracts (
        run_id, task_id, acceptance_revision, workflow_key, workflow_version,
        execution_config_version, contract_hash, frozen_snapshot
      )
      values (
        ${contract.runId}, ${contract.taskId}, ${contract.acceptanceRevision},
        ${contract.workflowKey}, ${contract.workflowVersion}, ${contract.executionConfigVersion},
        ${contract.contractHash}, ${JSON.stringify(contract.frozenSnapshot)}::jsonb
      )
      returning run_id, task_id, acceptance_revision, workflow_key, workflow_version,
                execution_config_version, contract_hash, frozen_snapshot, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into execution_contracts');
  }

  async readRun(runId: string): Promise<RunRow | undefined> {
    const result = await sql<RunRow>`
      select ${RUN_COLUMNS} from runs where id = ${runId}
    `.execute(this.db);

    return result.rows[0];
  }

  /** Run 行锁：状态迁移、步骤位置与终态竞争都在同一行上串行化。 */
  async lockRun(runId: string): Promise<RunRow | undefined> {
    const result = await sql<RunRow>`
      select ${RUN_COLUMNS} from runs where id = ${runId} for update
    `.execute(this.db);

    return result.rows[0];
  }

  async readContract(runId: string): Promise<ExecutionContractRow | undefined> {
    const result = await sql<ExecutionContractRow>`
      select run_id, task_id, acceptance_revision, workflow_key, workflow_version,
             execution_config_version, contract_hash, frozen_snapshot, created_at
      from execution_contracts
      where run_id = ${runId}
    `.execute(this.db);

    return result.rows[0];
  }

  async listRunsByTask(taskId: string): Promise<readonly RunRow[]> {
    const result = await sql<RunRow>`
      select ${RUN_COLUMNS} from runs where task_id = ${taskId} order by created_at, id
    `.execute(this.db);

    return result.rows;
  }

  /** 当前未释放的 Run；不存在表示该 Task 没有 AI 执行权占有者。 */
  async findLiveRunForTask(taskId: string): Promise<RunRow | undefined> {
    const result = await sql<RunRow>`
      select ${RUN_COLUMNS}
      from runs
      where task_id = ${taskId}
        and status in (
          'CREATED', 'CONTEXT_BUILDING', 'PLANNING', 'RUNNING', 'WAITING_APPROVAL',
          'VERIFYING', 'RETRYING', 'PAUSED'
        )
    `.execute(this.db);

    return result.rows[0];
  }

  /** 状态迁移的 CAS：revision 不匹配返回 undefined，由调用方裁决为并发冲突。 */
  async advanceRun(advance: RunAdvance): Promise<RunRow | undefined> {
    const terminalAt = advance.terminal === true ? sql`now()` : sql`null`;
    const currentStepId = advance.currentStepId === undefined ? null : advance.currentStepId;

    const result = await sql<RunRow>`
      update runs
      set status = ${advance.status},
          revision = revision + 1,
          current_step_id = coalesce(${currentStepId}, current_step_id),
          wait_reason = ${advance.waitReason ?? null},
          resume_phase = ${advance.resumePhase ?? null},
          terminal_at = ${terminalAt},
          updated_at = now()
      where id = ${advance.runId} and revision = ${advance.expectedRevision}
      returning ${RUN_COLUMNS}
    `.execute(this.db);

    return result.rows[0];
  }

  async insertRunSteps(steps: readonly NewRunStep[]): Promise<readonly RunStepRow[]> {
    const rows: RunStepRow[] = [];

    for (const step of steps) {
      const result = await sql<RunStepRow>`
        insert into run_steps (id, run_id, step_index, step_kind, status)
        values (${step.id}, ${step.runId}, ${step.stepIndex}, ${step.stepKind}, 'PENDING')
        returning ${STEP_COLUMNS}
      `.execute(this.db);

      rows.push(requireRow(result.rows, 'insert into run_steps'));
    }

    return rows;
  }

  async readStep(stepId: string): Promise<RunStepRow | undefined> {
    const result = await sql<RunStepRow>`
      select ${STEP_COLUMNS} from run_steps where id = ${stepId}
    `.execute(this.db);

    return result.rows[0];
  }

  async readStepByKind(runId: string, stepKind: RunStepKind): Promise<RunStepRow | undefined> {
    const result = await sql<RunStepRow>`
      select ${STEP_COLUMNS} from run_steps where run_id = ${runId} and step_kind = ${stepKind}
    `.execute(this.db);

    return result.rows[0];
  }

  async lockStep(stepId: string): Promise<RunStepRow | undefined> {
    const result = await sql<RunStepRow>`
      select ${STEP_COLUMNS} from run_steps where id = ${stepId} for update
    `.execute(this.db);

    return result.rows[0];
  }

  async listSteps(runId: string): Promise<readonly RunStepRow[]> {
    const result = await sql<RunStepRow>`
      select ${STEP_COLUMNS} from run_steps where run_id = ${runId} order by step_index
    `.execute(this.db);

    return result.rows;
  }

  /** 步骤状态的 CAS：只有当前 revision 与状态匹配才推进，重放不会重复推进。 */
  async advanceStep(input: {
    readonly stepId: string;
    readonly expectedRevision: bigint;
    readonly status: RunStepStatus;
    readonly resultRef?: JsonObject | null;
  }): Promise<RunStepRow | undefined> {
    const result = await sql<RunStepRow>`
      update run_steps
      set status = ${input.status},
          revision = revision + 1,
          result_ref = ${input.resultRef === undefined || input.resultRef === null ? null : JSON.stringify(input.resultRef)}::jsonb,
          started_at = case when ${input.status} = 'RUNNING' then coalesce(started_at, now()) else started_at end,
          finished_at = case when ${input.status} in ('SUCCEEDED', 'FAILED', 'SKIPPED') then now() else finished_at end
      where id = ${input.stepId} and revision = ${input.expectedRevision}
      returning ${STEP_COLUMNS}
    `.execute(this.db);

    return result.rows[0];
  }

  /**
   * 步骤重置为 PENDING 的 CAS（P06 修正回路与“完成被阻塞”都用它）：
   * 清空 result_ref/started_at/finished_at 并递增 revision，让下一轮按固定顺序重跑。
   * 不新建步骤行、不让步骤计划增长（RETRYING 通过新 Attempt 表达）。
   */
  async resetStepToPending(input: {
    readonly stepId: string;
    readonly expectedRevision: bigint;
  }): Promise<RunStepRow | undefined> {
    const result = await sql<RunStepRow>`
      update run_steps
      set status = 'PENDING',
          revision = revision + 1,
          result_ref = null,
          started_at = null,
          finished_at = null
      where id = ${input.stepId} and revision = ${input.expectedRevision}
      returning ${STEP_COLUMNS}
    `.execute(this.db);

    return result.rows[0];
  }

  /**
   * 插入 Attempt。同一 (step, attempt_key) 已存在时返回既有行：
   * 重复提交同一来源尝试不产生第二条尝试（B08 的去重前提）。
   */
  async insertStepAttempt(
    attempt: NewStepAttempt,
  ): Promise<{ readonly row: StepAttemptRow; readonly inserted: boolean }> {
    const inserted = await sql<StepAttemptRow>`
      insert into step_attempts (id, step_id, attempt_number, attempt_key, status)
      values (${attempt.id}, ${attempt.stepId}, ${attempt.attemptNumber}, ${attempt.attemptKey}, 'PREPARED')
      on conflict (step_id, attempt_key) do nothing
      returning ${ATTEMPT_COLUMNS}
    `.execute(this.db);

    if (inserted.rows[0] !== undefined) {
      return { row: inserted.rows[0], inserted: true };
    }

    // on conflict 说明同一 (step, attempt_key) 已存在：读回既有尝试，不新建第二条。
    const existing = await this.readAttemptByKey(attempt.stepId, attempt.attemptKey);

    if (existing === undefined) {
      throw new Error('step attempt insert conflicted but no existing row was found');
    }

    return { row: existing, inserted: false };
  }

  async readAttempt(attemptId: string): Promise<StepAttemptRow | undefined> {
    const result = await sql<StepAttemptRow>`
      select ${ATTEMPT_COLUMNS} from step_attempts where id = ${attemptId}
    `.execute(this.db);

    return result.rows[0];
  }

  async readAttemptByKey(stepId: string, attemptKey: string): Promise<StepAttemptRow | undefined> {
    const result = await sql<StepAttemptRow>`
      select ${ATTEMPT_COLUMNS}
      from step_attempts
      where step_id = ${stepId} and attempt_key = ${attemptKey}
    `.execute(this.db);

    return result.rows[0];
  }

  async listAttempts(stepId: string): Promise<readonly StepAttemptRow[]> {
    const result = await sql<StepAttemptRow>`
      select ${ATTEMPT_COLUMNS} from step_attempts where step_id = ${stepId} order by attempt_number
    `.execute(this.db);

    return result.rows;
  }

  /** 领取：PREPARED → RUNNING，claim_epoch +1 并写入 worker 与租约。 */
  async claimAttempt(input: {
    readonly attemptId: string;
    readonly workerId: string;
    readonly leaseUntil: Date;
  }): Promise<StepAttemptRow | undefined> {
    const result = await sql<StepAttemptRow>`
      update step_attempts
      set status = 'RUNNING',
          worker_id = ${input.workerId},
          claim_epoch = claim_epoch + 1,
          lease_until = ${input.leaseUntil},
          started_at = coalesce(started_at, now())
      where id = ${input.attemptId} and status = 'PREPARED'
      returning ${ATTEMPT_COLUMNS}
    `.execute(this.db);

    return result.rows[0];
  }

  /**
   * 结果登记：只有 claim_epoch 与状态都匹配才写入。
   * 返回 undefined 表示这是迟到/过期结果，调用方必须保留核对证据而不是改状态。
   */
  async recordAttemptOutcome(input: {
    readonly attemptId: string;
    readonly expectedClaimEpoch: bigint;
    readonly status: StepAttemptStatus;
    readonly resultRef: JsonObject | null;
    readonly evidence: JsonObject | null;
  }): Promise<StepAttemptRow | undefined> {
    const result = await sql<StepAttemptRow>`
      update step_attempts
      set status = ${input.status},
          result_ref = ${input.resultRef === null ? null : JSON.stringify(input.resultRef)}::jsonb,
          evidence = ${input.evidence === null ? null : JSON.stringify(input.evidence)}::jsonb,
          finished_at = now(),
          worker_id = null,
          lease_until = null
      where id = ${input.attemptId}
        and status = 'RUNNING'
        and claim_epoch = ${input.expectedClaimEpoch}
      returning ${ATTEMPT_COLUMNS}
    `.execute(this.db);

    return result.rows[0];
  }

  /** 迟到结果只登记核对证据：不改步骤位置、不释放 claim、也不冒充成功。 */
  async markAttemptRejectedStale(input: {
    readonly attemptId: string;
    readonly evidence: JsonObject;
  }): Promise<StepAttemptRow | undefined> {
    const result = await sql<StepAttemptRow>`
      update step_attempts
      set status = 'REJECTED_STALE',
          evidence = ${JSON.stringify(input.evidence)}::jsonb,
          finished_at = now()
      where id = ${input.attemptId} and status in ('PREPARED', 'RUNNING')
      returning ${ATTEMPT_COLUMNS}
    `.execute(this.db);

    return result.rows[0];
  }

  /** BUILD_CONTEXT 的不可变快照：同一 Run 的同一摘要只写一次，重复执行返回既有行。 */
  async insertContextManifest(input: {
    readonly id: string;
    readonly runId: string;
    readonly stepId: string | null;
    readonly builderVersion: string;
    readonly manifestHash: Buffer;
    readonly payload: JsonObject;
  }): Promise<{ readonly row: ContextManifestRow; readonly inserted: boolean }> {
    const inserted = await sql<ContextManifestRow>`
      insert into context_manifests (id, run_id, step_id, builder_version, manifest_hash, payload)
      values (
        ${input.id}, ${input.runId}, ${input.stepId}, ${input.builderVersion},
        ${input.manifestHash}, ${JSON.stringify(input.payload)}::jsonb
      )
      on conflict (run_id, manifest_hash) do nothing
      returning id, run_id, step_id, builder_version, manifest_hash, payload, created_at
    `.execute(this.db);

    if (inserted.rows[0] !== undefined) {
      return { row: inserted.rows[0], inserted: true };
    }

    // 同一 Run 已有相同摘要的 Manifest：复用既有快照，不重写（BUILD_CONTEXT 只装配）。
    const existing = await this.readContextManifestByHash(input.runId, input.manifestHash);

    if (existing === undefined) {
      throw new Error('context manifest insert conflicted but no existing row was found');
    }

    return { row: existing, inserted: false };
  }

  async readContextManifestByHash(
    runId: string,
    manifestHash: Buffer,
  ): Promise<ContextManifestRow | undefined> {
    const result = await sql<ContextManifestRow>`
      select id, run_id, step_id, builder_version, manifest_hash, payload, created_at
      from context_manifests
      where run_id = ${runId} and manifest_hash = ${manifestHash}
    `.execute(this.db);

    return result.rows[0];
  }
}
