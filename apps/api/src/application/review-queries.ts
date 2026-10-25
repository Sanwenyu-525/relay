import type { DbExecutor } from '../infrastructure/database.js';
import type { ReviewRequestRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { readFrozenActionOperationIds } from '../workflow/execution-contract.js';
import { resourceNotFound } from './domain-error.js';
import { requireWorkspaceVisible } from './guards.js';
import { reviewMatchesGatewayOperation, reviewTargetHash } from './review-requests.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

export interface ReviewDto {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly revision: string;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly run_id: string | null;
  /** ACTION_APPROVAL 绑定的确切动作身份；其它 kind 为 null。消费方据此把审批挂到工具调用行。 */
  readonly operation_id: string | null;
  readonly reason: string;
  readonly target_hash: string;
  readonly target: JsonObject;
  readonly evidence: JsonObject;
  readonly effect: JsonObject;
  readonly allowed_decisions: readonly string[];
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
}

export function reviewDto(row: ReviewRequestRow, expired = false): ReviewDto {
  return {
    id: row.id,
    kind: row.kind,
    status: expired ? 'EXPIRED' : row.status,
    revision: toDecimalString(row.revision),
    project_id: row.project_id,
    task_id: row.task_id,
    run_id: row.run_id,
    operation_id: row.kind === 'ACTION_APPROVAL' ? row.operation_id : null,
    reason: row.reason,
    target_hash: row.target_hash.toString('hex'),
    target: row.target,
    evidence: row.evidence,
    effect: row.effect,
    allowed_decisions: expired ? [] : row.status === 'OPEN' ? row.allowed_decisions : [],
    expires_at: row.expires_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    decided_at: row.decided_at?.toISOString() ?? null,
  };
}

export async function listInboxReviews(db: DbExecutor, workspaceId: string, status: 'OPEN' | 'DECIDED' | 'EXPIRED' = 'OPEN'): Promise<{ readonly items: readonly ReviewDto[] }> {
  await requireWorkspaceVisible(db, workspaceId);
  const repositories = createRepositories(db);
  const rows = status === 'EXPIRED'
    ? [...await repositories.reviews.listByWorkspace(workspaceId, 'EXPIRED'),
      ...await repositories.reviews.listByWorkspace(workspaceId, 'OPEN')]
      .sort((left, right) => left.created_at.getTime() - right.created_at.getTime() ||
        left.id.localeCompare(right.id))
    : await repositories.reviews.listByWorkspace(workspaceId, status);
  const items = await Promise.all(rows.map((row) => projectReview(repositories, row)));
  return { items: items.filter((item) => item.status === status) };
}

export async function listRunReviews(db: DbExecutor, workspaceId: string, runId: string): Promise<{ readonly items: readonly ReviewDto[] }> {
  await requireWorkspaceVisible(db, workspaceId);
  const repositories = createRepositories(db);
  const run = await repositories.runs.readRun(runId);
  if (run === undefined || run.workspace_id !== workspaceId) throw resourceNotFound('Run');
  return { items: await Promise.all((await repositories.reviews.listByRun(runId)).map((row) => projectReview(repositories, row))) };
}

export async function readReview(db: DbExecutor, workspaceId: string, reviewId: string): Promise<ReviewDto> {
  await requireWorkspaceVisible(db, workspaceId);
  const repositories = createRepositories(db);
  const row = await repositories.reviews.readRequest(reviewId);
  if (row === undefined || row.workspace_id !== workspaceId) throw resourceNotFound('Review');
  return projectReview(repositories, row);
}

async function projectReview(repositories: Repositories, row: ReviewRequestRow): Promise<ReviewDto> {
  return reviewDto(row, row.status === 'OPEN' && !(await isCurrentTarget(repositories, row)));
}

async function isCurrentTarget(repositories: Repositories, row: ReviewRequestRow): Promise<boolean> {
  if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) return false;
  if (row.kind === 'STATE_PROPOSAL') {
    if (row.project_id === null) return false;
    const state = await repositories.projects.readProjectState(row.project_id);
    return state !== undefined && row.target.base_revision === toDecimalString(state.revision);
  }
  if (row.kind === 'ACTION_APPROVAL' && row.run_id === null) {
    return isCurrentNonRunActionApproval(repositories, row);
  }
  if (row.run_id === null) return false;
  const run = await repositories.runs.readRun(row.run_id);
  const task = run === undefined ? undefined : await repositories.tasks.readTask(run.task_id);
  if (run === undefined || task === undefined || task.executor_kind !== 'AI' ||
      task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch ||
      row.target.run_id !== run.id ||
      row.target.acceptance_revision !== toDecimalString(task.acceptance_revision)) return false;
  if (row.kind === 'ACTION_APPROVAL') {
    if (run.status !== 'WAITING_APPROVAL' || row.operation_id !== row.target.operation_id ||
        !row.target_hash.equals(reviewTargetHash(row.target))) return false;
    const contract = await repositories.runs.readContract(run.id);
    if (contract === undefined || contract.acceptance_revision !== task.acceptance_revision) return false;
    const frozenActionIds = readFrozenActionOperationIds(contract.frozen_snapshot);
    if (frozenActionIds.length > 0 &&
        (row.operation_id === null || !frozenActionIds.includes(row.operation_id))) return false;
    const operation = row.operation_id === null ? undefined :
      await repositories.gateway.readOperation(row.operation_id);
    // P07 may reserve an operation identity before Gateway creates its row. Preserve that
    // valid waiting Review; once an Operation exists, project the exact same binding and
    // status required by decision submission and Gateway admission.
    if (operation === undefined) return true;
    return operation.status === 'WAITING_APPROVAL' &&
      reviewMatchesGatewayOperation(row, operation);
  }
  if (run.status !== 'WAITING_APPROVAL') return false;
  const persist = await repositories.runs.readStepByKind(run.id, 'PERSIST_CANDIDATE');
  if (persist?.result_ref?.artifact_version_id !== row.target.artifact_version_id) return false;
  const version = typeof row.target.artifact_version_id === 'string' ? await repositories.artifacts.readArtifactVersion(row.target.artifact_version_id) : undefined;
  if (version === undefined || version.content_hash.toString('hex') !== row.target.content_hash) return false;
  const latest = (await repositories.verifications.listSessionsByRun(run.id)).at(-1);
  return latest?.status === 'HUMAN';
}

async function isCurrentNonRunActionApproval(
  repositories: Repositories,
  row: ReviewRequestRow,
): Promise<boolean> {
  if (row.task_id !== null || row.operation_id === null ||
      !row.target_hash.equals(reviewTargetHash(row.target)) ||
      row.target.operation_id !== row.operation_id || row.target.acceptance_revision !== null) {
    return false;
  }

  const operation = await repositories.gateway.readOperation(row.operation_id);
  if (operation === undefined || operation.workspace_id !== row.workspace_id ||
      operation.project_id !== row.project_id || operation.task_id !== null || operation.run_id !== null ||
      operation.step_id !== null || operation.status !== 'WAITING_APPROVAL' ||
      row.import_job_id !== operation.import_job_id ||
      row.target.origin !== operation.origin || row.target.run_id !== null || row.target.step_id !== null ||
      row.target.import_job_id !== operation.import_job_id || row.target.action_type !== operation.action_type ||
      row.target.normalized_target !== operation.normalized_target ||
      row.target.params_hash !== operation.params_hash.toString('hex') ||
      row.target.connection_id !== operation.connection_id ||
      row.target.connection_version !== operation.connection_version.toString() ||
      row.target.policy_id !== operation.policy_id ||
      row.target.policy_version !== operation.policy_version.toString()) {
    return false;
  }

  if (operation.origin === 'USER_ACTION') {
    return operation.import_job_id === null && operation.resource_id !== null;
  }
  if (operation.origin !== 'USER_IMPORT' || operation.import_job_id === null) return false;

  const job = await repositories.gateway.readImportJob(operation.import_job_id);
  return job !== undefined && job.workspace_id === row.workspace_id &&
    job.project_id === operation.project_id && (job.status === 'QUEUED' || job.status === 'RUNNING');
}
