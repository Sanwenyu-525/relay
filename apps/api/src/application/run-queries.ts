import type { DbExecutor } from '../infrastructure/database.js';
import type {
  RunRow,
  RunStepRow,
  StepAttemptRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { resourceNotFound } from './domain-error.js';
import { requireWorkspaceVisible } from './guards.js';
import { createRepositories, type Repositories } from './unit-of-work.js';
import { listRunReviews } from './review-queries.js';

/**
 * Run 查询投影（docs/api/http-command-contract.md 第 6 节）。
 *
 * 只输出安全的只读模型：状态、当前步骤、步骤与最近尝试、冻结契约摘要与结果引用；
 * 不含宿主机路径、密钥或可写实体。跨作用域 ID 一律按不可见处理（404）。
 * P08 增加待处理控制请求与未核对动作 ID；M03 同时投影 Gateway UNKNOWN。
 * 前端必须区分 PENDING 与 APPLIED。
 */

export interface RunContractDto {
  readonly workflow_key: string;
  readonly workflow_version: string;
  readonly execution_config_version: string;
  readonly acceptance_revision: string;
  readonly contract_hash: string;
}

export interface RunStepDto {
  readonly step_id: string;
  readonly step_index: number;
  readonly step_kind: string;
  readonly status: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

export interface RunAttemptDto {
  readonly attempt_id: string;
  readonly step_id: string;
  readonly step_kind: string;
  readonly attempt_number: string;
  readonly status: string;
  readonly claim_epoch: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

export interface RunResultRefDto {
  readonly step_kind: string;
  readonly result_ref: JsonObject;
}

export interface RunDto {
  readonly id: string;
  readonly task_id: string;
  readonly status: string;
  readonly revision: string;
  readonly ownership_epoch: string;
  readonly retry_of_run_id: string | null;
  readonly current_step_id: string | null;
  readonly wait_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly terminal_at: string | null;
  readonly contract: RunContractDto;
  readonly current_step: RunStepDto | null;
  readonly steps: readonly RunStepDto[];
  readonly recent_attempts: readonly RunAttemptDto[];
  readonly result_refs: readonly RunResultRefDto[];
  readonly blocking_review_ids: readonly string[];
  readonly pending_control_request: { readonly id: string; readonly type: string; readonly status: 'PENDING'; readonly requested_at: string } | null;
  readonly unresolved_operation_ids: readonly string[];
}

export async function readRunById(
  db: DbExecutor,
  workspaceId: string,
  runId: string,
): Promise<RunDto> {
  await requireWorkspaceVisible(db, workspaceId);

  const repositories = createRepositories(db);
  const run = await repositories.runs.readRun(runId);

  if (run === undefined || run.workspace_id !== workspaceId) {
    throw resourceNotFound('Run');
  }

  const dto = await projectRun(repositories, run);
  const reviews = await listRunReviews(db, workspaceId, run.id);
  const pending = await repositories.recovery.findPendingControl(run.id);
  const unresolved = await repositories.recovery.listUnresolvedEffects(run.id);
  const gatewayUnknown = (await repositories.gateway.listUnresolvedRunOperations(run.id))
    .filter((operation) => operation.workspace_id === workspaceId &&
      operation.origin === 'RUN' && operation.status === 'UNKNOWN');
  return { ...dto, blocking_review_ids: reviews.items.filter((item) => item.status === 'OPEN').map((item) => item.id),
    pending_control_request: pending === undefined ? null : { id: pending.id, type: pending.type, status: 'PENDING', requested_at: pending.requested_at.toISOString() },
    unresolved_operation_ids: [...new Set([...unresolved.map((item) => item.operation_id),
      ...gatewayUnknown.map((operation) => operation.id)])] };
}

async function projectRun(repositories: Repositories, run: RunRow): Promise<Omit<RunDto, 'blocking_review_ids' | 'pending_control_request' | 'unresolved_operation_ids'>> {
  const contract = await repositories.runs.readContract(run.id);
  const steps = await repositories.runs.listSteps(run.id);
  const attempts = await listAttempts(repositories, steps);
  const currentStep = steps.find((step) => step.id === run.current_step_id);

  return {
    id: run.id,
    task_id: run.task_id,
    status: run.status,
    revision: toDecimalString(run.revision),
    ownership_epoch: toDecimalString(run.ownership_epoch),
    retry_of_run_id: run.retry_of_run_id,
    current_step_id: run.current_step_id,
    wait_reason: run.wait_reason,
    created_at: run.created_at.toISOString(),
    updated_at: run.updated_at.toISOString(),
    terminal_at: run.terminal_at === null ? null : run.terminal_at.toISOString(),
    contract: {
      workflow_key: contract?.workflow_key ?? '',
      workflow_version: contract?.workflow_version ?? '',
      execution_config_version: contract?.execution_config_version ?? '',
      acceptance_revision: toDecimalString(contract?.acceptance_revision ?? run.ownership_epoch),
      contract_hash: contract === undefined ? '' : Buffer.from(contract.contract_hash).toString('hex'),
    },
    current_step: currentStep === undefined ? null : stepDto(currentStep),
    steps: steps.map(stepDto),
    recent_attempts: attempts,
    result_refs: steps
      .filter((step) => step.result_ref !== null)
      .map((step) => ({ step_kind: step.step_kind, result_ref: step.result_ref as JsonObject })),
  };
}

async function listAttempts(
  repositories: Repositories,
  steps: readonly RunStepRow[],
): Promise<readonly RunAttemptDto[]> {
  const rows: RunAttemptDto[] = [];

  for (const step of steps) {
    const attempts = await repositories.runs.listAttempts(step.id);

    for (const attempt of attempts) {
      rows.push(attemptDto(step, attempt));
    }
  }

  return rows;
}

function stepDto(step: RunStepRow): RunStepDto {
  return {
    step_id: step.id,
    step_index: step.step_index,
    step_kind: step.step_kind,
    status: step.status,
    started_at: step.started_at === null ? null : step.started_at.toISOString(),
    finished_at: step.finished_at === null ? null : step.finished_at.toISOString(),
  };
}

function attemptDto(step: RunStepRow, attempt: StepAttemptRow): RunAttemptDto {
  return {
    attempt_id: attempt.id,
    step_id: step.id,
    step_kind: step.step_kind,
    attempt_number: toDecimalString(attempt.attempt_number),
    status: attempt.status,
    claim_epoch: toDecimalString(attempt.claim_epoch),
    started_at: attempt.started_at === null ? null : attempt.started_at.toISOString(),
    finished_at: attempt.finished_at === null ? null : attempt.finished_at.toISOString(),
  };
}
