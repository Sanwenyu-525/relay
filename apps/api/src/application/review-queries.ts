import type { DbExecutor } from '../infrastructure/database.js';
import type { ReviewRequestRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { resourceNotFound } from './domain-error.js';
import { requireWorkspaceVisible } from './guards.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

export interface ReviewDto {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly revision: string;
  readonly project_id: string | null;
  readonly task_id: string | null;
  readonly run_id: string | null;
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
  const rows = await repositories.reviews.listByWorkspace(workspaceId);
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
  if (row.run_id === null) return false;
  const run = await repositories.runs.readRun(row.run_id);
  const task = run === undefined ? undefined : await repositories.tasks.readTask(run.task_id);
  if (run === undefined || task === undefined || task.executor_run_id !== run.id || task.ownership_epoch !== run.ownership_epoch || row.target.acceptance_revision !== toDecimalString(task.acceptance_revision)) return false;
  if (row.kind === 'ACTION_APPROVAL') return run.status === 'WAITING_APPROVAL' && row.operation_id === row.target.operation_id;
  if (run.status !== 'WAITING_APPROVAL') return false;
  const persist = await repositories.runs.readStepByKind(run.id, 'PERSIST_CANDIDATE');
  if (persist?.result_ref?.artifact_version_id !== row.target.artifact_version_id) return false;
  const version = typeof row.target.artifact_version_id === 'string' ? await repositories.artifacts.readArtifactVersion(row.target.artifact_version_id) : undefined;
  if (version === undefined || version.content_hash.toString('hex') !== row.target.content_hash) return false;
  const latest = (await repositories.verifications.listSessionsByRun(run.id)).at(-1);
  return latest?.status === 'HUMAN';
}
