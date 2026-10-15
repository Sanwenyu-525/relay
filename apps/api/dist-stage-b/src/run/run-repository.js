import { sql } from 'kysely';
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
const RUN_COLUMNS = sql.raw('id, workspace_id, task_id, status, revision, ownership_epoch, retry_of_run_id, resume_phase, wait_reason, current_step_id, worker_epoch, worker_id, worker_lease_until, created_at, updated_at, terminal_at');
const STEP_COLUMNS = sql.raw('id, run_id, step_index, step_kind, status, revision, result_ref, started_at, finished_at, created_at');
const ATTEMPT_COLUMNS = sql.raw('id, step_id, attempt_number, attempt_key, status, worker_id, claim_epoch, lease_until, result_ref, evidence, started_at, finished_at, created_at');
export class RunRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    /** 终态与结束时间一起写入；非终态清空 terminal_at，避免“已结束但仍可领取”。 */
    async insertRun(run) {
        const result = await sql `
      insert into runs (id, workspace_id, task_id, status, ownership_epoch, retry_of_run_id)
      values (${run.id}, ${run.workspaceId}, ${run.taskId}, 'CREATED', ${run.ownershipEpoch}, ${run.retryOfRunId})
      returning ${RUN_COLUMNS}
    `.execute(this.db);
        return requireRow(result.rows, 'insert into runs');
    }
    async insertExecutionContract(contract) {
        const result = await sql `
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
    async readRun(runId) {
        const result = await sql `
      select ${RUN_COLUMNS} from runs where id = ${runId}
    `.execute(this.db);
        return result.rows[0];
    }
    /** Run 行锁：状态迁移、步骤位置与终态竞争都在同一行上串行化。 */
    async lockRun(runId) {
        const result = await sql `
      select ${RUN_COLUMNS} from runs where id = ${runId} for update
    `.execute(this.db);
        return result.rows[0];
    }
    async readContract(runId) {
        const result = await sql `
      select run_id, task_id, acceptance_revision, workflow_key, workflow_version,
             execution_config_version, contract_hash, frozen_snapshot, created_at
      from execution_contracts
      where run_id = ${runId}
    `.execute(this.db);
        return result.rows[0];
    }
    async listRunsByTask(taskId) {
        const result = await sql `
      select ${RUN_COLUMNS} from runs where task_id = ${taskId} order by created_at, id
    `.execute(this.db);
        return result.rows;
    }
    /** 当前未释放的 Run；不存在表示该 Task 没有 AI 执行权占有者。 */
    async findLiveRunForTask(taskId) {
        const result = await sql `
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
    async advanceRun(advance) {
        const terminalAt = advance.terminal === true ? sql `now()` : sql `null`;
        const currentStepId = advance.currentStepId === undefined ? null : advance.currentStepId;
        const result = await sql `
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
    /** 控制意图本身改变 Run 投影 revision，但不改状态/恢复位置。 */
    async touchRun(runId, expectedRevision) {
        const result = await sql `
      update runs set revision = revision + 1, updated_at = now()
      where id = ${runId} and revision = ${expectedRevision}
      returning ${RUN_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    /** Run 级 fence 与 Step Attempt claim 分开：旧 Worker 即使持有相同 Attempt ID 也不能提交。 */
    async claimWorker(runId, workerId, leaseUntil) {
        const result = await sql `
      update runs set worker_epoch = worker_epoch + 1, worker_id = ${workerId},
        worker_lease_until = ${leaseUntil}, updated_at = now()
      where id = ${runId} and worker_id is null
      returning ${RUN_COLUMNS}
    `.execute(this.db);
        if (result.rows[0] !== undefined)
            await this.deleteDraftPreview(runId);
        return result.rows[0];
    }
    async releaseWorker(runId, workerId, workerEpoch) {
        const result = await sql `
      update runs set worker_id = null, worker_lease_until = null, updated_at = now()
      where id = ${runId} and worker_id = ${workerId} and worker_epoch = ${workerEpoch}
      returning ${RUN_COLUMNS}
    `.execute(this.db);
        if (result.rows[0] !== undefined)
            await this.deleteDraftPreview(runId);
        return result.rows[0];
    }
    /** 仅在已核对旧进程停止后使用；租约到期本身不授权抢占。 */
    async fenceWorker(runId) {
        const result = await sql `
      update runs set worker_epoch = worker_epoch + 1, worker_id = null,
        worker_lease_until = null, updated_at = now()
      where id = ${runId} returning ${RUN_COLUMNS}
    `.execute(this.db);
        if (result.rows[0] !== undefined)
            await this.deleteDraftPreview(runId);
        return result.rows[0];
    }
    async readDraftPreview(runId) {
        return (await sql `select * from run_draft_previews
      where run_id = ${runId}`.execute(this.db)).rows[0];
    }
    async readRunForShare(runId) {
        return (await sql `select ${RUN_COLUMNS} from runs
      where id = ${runId} for share`.execute(this.db)).rows[0];
    }
    async readAttemptForShare(attemptId) {
        return (await sql `select ${ATTEMPT_COLUMNS} from step_attempts
      where id = ${attemptId} for share`.execute(this.db)).rows[0];
    }
    /** Caller holds the current Task/Run claim locks and has checked the exact call. */
    async writeDraftPreview(input) {
        await sql `insert into run_draft_previews (run_id, step_attempt_id,
      attempt_claim_epoch, run_worker_epoch, worker_id, invocation_epoch,
      model_call_id, preview_text, truncated)
      values (${input.runId}, ${input.attemptId}, ${input.attemptClaimEpoch},
        ${input.runWorkerEpoch}, ${input.workerId}, ${input.invocationEpoch},
        ${input.modelCallId}, ${input.text}, ${input.truncated})
      on conflict (run_id) do update set
        step_attempt_id = excluded.step_attempt_id,
        attempt_claim_epoch = excluded.attempt_claim_epoch,
        run_worker_epoch = excluded.run_worker_epoch,
        worker_id = excluded.worker_id,
        invocation_epoch = excluded.invocation_epoch,
        model_call_id = excluded.model_call_id,
        revision = case when run_draft_previews.model_call_id = excluded.model_call_id
          then run_draft_previews.revision + 1 else 1 end,
        preview_text = excluded.preview_text, truncated = excluded.truncated,
        updated_at = now()`.execute(this.db);
    }
    async deleteDraftPreview(runId) {
        await sql `delete from run_draft_previews where run_id = ${runId}`.execute(this.db);
    }
    async insertRunSteps(steps) {
        const rows = [];
        for (const step of steps) {
            const result = await sql `
        insert into run_steps (id, run_id, step_index, step_kind, status)
        values (${step.id}, ${step.runId}, ${step.stepIndex}, ${step.stepKind}, 'PENDING')
        returning ${STEP_COLUMNS}
      `.execute(this.db);
            rows.push(requireRow(result.rows, 'insert into run_steps'));
        }
        return rows;
    }
    async readStep(stepId) {
        const result = await sql `
      select ${STEP_COLUMNS} from run_steps where id = ${stepId}
    `.execute(this.db);
        return result.rows[0];
    }
    async readStepByKind(runId, stepKind) {
        const result = await sql `
      select ${STEP_COLUMNS} from run_steps where run_id = ${runId} and step_kind = ${stepKind}
    `.execute(this.db);
        return result.rows[0];
    }
    async lockStep(stepId) {
        const result = await sql `
      select ${STEP_COLUMNS} from run_steps where id = ${stepId} for update
    `.execute(this.db);
        return result.rows[0];
    }
    async listSteps(runId) {
        const result = await sql `
      select ${STEP_COLUMNS} from run_steps where run_id = ${runId} order by step_index
    `.execute(this.db);
        return result.rows;
    }
    /** 步骤状态的 CAS：只有当前 revision 与状态匹配才推进，重放不会重复推进。 */
    async advanceStep(input) {
        const result = await sql `
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
    async resetStepToPending(input) {
        const result = await sql `
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
    async insertStepAttempt(attempt) {
        const inserted = await sql `
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
    async readAttempt(attemptId) {
        const result = await sql `
      select ${ATTEMPT_COLUMNS} from step_attempts where id = ${attemptId}
    `.execute(this.db);
        return result.rows[0];
    }
    async readAttemptByKey(stepId, attemptKey) {
        const result = await sql `
      select ${ATTEMPT_COLUMNS}
      from step_attempts
      where step_id = ${stepId} and attempt_key = ${attemptKey}
    `.execute(this.db);
        return result.rows[0];
    }
    async listAttempts(stepId) {
        const result = await sql `
      select ${ATTEMPT_COLUMNS} from step_attempts where step_id = ${stepId} order by attempt_number
    `.execute(this.db);
        return result.rows;
    }
    /** 领取：PREPARED → RUNNING，claim_epoch +1 并写入 worker 与租约。 */
    async claimAttempt(input) {
        const result = await sql `
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
    /** 恢复扫描已确认旧 Worker 停止后，沿用同一 Attempt/动作身份并递增 fence。 */
    async reclaimAttempt(attemptId, workerId, leaseUntil) {
        const result = await sql `
      update step_attempts set worker_id = ${workerId}, claim_epoch = claim_epoch + 1,
        lease_until = ${leaseUntil}
      where id = ${attemptId} and status = 'RUNNING' returning ${ATTEMPT_COLUMNS}
    `.execute(this.db);
        return result.rows[0];
    }
    /**
     * 结果登记：只有 claim_epoch 与状态都匹配才写入。
     * 返回 undefined 表示这是迟到/过期结果，调用方必须保留核对证据而不是改状态。
     */
    async recordAttemptOutcome(input) {
        const result = await sql `
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
        if (result.rows[0] !== undefined) {
            await sql `delete from run_draft_previews where step_attempt_id = ${input.attemptId}`
                .execute(this.db);
        }
        return result.rows[0];
    }
    /** BUILD_CONTEXT 的不可变快照：同一 Run 的同一摘要只写一次，重复执行返回既有行。 */
    async insertContextManifest(input) {
        const inserted = await sql `
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
    async readContextManifestByHash(runId, manifestHash) {
        const result = await sql `
      select id, run_id, step_id, builder_version, manifest_hash, payload, created_at
      from context_manifests
      where run_id = ${runId} and manifest_hash = ${manifestHash}
    `.execute(this.db);
        return result.rows[0];
    }
    async listContextManifests(runId) {
        return (await sql `
      select id, run_id, step_id, builder_version, manifest_hash, payload, created_at
      from context_manifests where run_id = ${runId}
      order by created_at desc, id desc
    `.execute(this.db)).rows;
    }
    async readContextManifestById(runId, id) {
        return (await sql `
      select id, run_id, step_id, builder_version, manifest_hash, payload, created_at
      from context_manifests where run_id = ${runId} and id = ${id}
    `.execute(this.db)).rows[0];
    }
}
