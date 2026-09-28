import type { DbExecutor } from '../infrastructure/database.js';
import { basename, dirname, relative } from 'node:path';
import type {
  ChangeSetFileRow, ChangeSetRow, GatewayConnectionRow, GatewayPermissionPolicyRow, GatewayPermissionVersionRow,
  InvocationAttemptRow, LogicalOperationRow, ManagedResourceRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { resourceNotFound } from './domain-error.js';
import { createRepositories, type Repositories } from './unit-of-work.js';
import { canonicalRelativePath, computeSha256, MAX_FILE_WRITE_DIFF_TEXT_BYTES,
  type FileChange } from '../files/file-changeset.js';

async function requireProject(repositories: Repositories, workspaceId: string, projectId: string): Promise<void> {
  const project = await repositories.projects.readProject(projectId);
  if (project?.workspace_id !== workspaceId) throw resourceNotFound('Project');
}

export interface GatewayConnectionDto {
  readonly id: string; readonly project_id: string; readonly status: string;
  readonly version: string; readonly capabilities: readonly string[];
  readonly allowed_host: string | null; readonly created_at: string;
}
async function connectionDto(repositories: Repositories, row: GatewayConnectionRow): Promise<GatewayConnectionDto> {
  const capabilities = await repositories.gateway.listConnectionCapabilities(row.id);
  return { id: row.id, project_id: row.project_id, status: row.status,
    version: toDecimalString(row.version),
    capabilities,
    allowed_host: capabilities.includes('WEB_FETCH') &&
      typeof row.config.allowed_host === 'string' ? row.config.allowed_host : null,
    created_at: row.created_at.toISOString() };
}
export async function listGatewayConnections(db: DbExecutor, workspaceId: string, projectId: string): Promise<readonly GatewayConnectionDto[]> {
  const repositories = createRepositories(db);
  await requireProject(repositories, workspaceId, projectId);
  return Promise.all((await repositories.gateway.listConnections(workspaceId, projectId)).map((row) => connectionDto(repositories, row)));
}
export async function readGatewayConnection(db: DbExecutor, workspaceId: string, projectId: string,
  connectionId: string): Promise<GatewayConnectionDto> {
  const repositories = createRepositories(db);
  const row = await repositories.gateway.readConnection(connectionId);
  if (row?.workspace_id !== workspaceId || row.project_id !== projectId) throw resourceNotFound('Connection');
  return connectionDto(repositories, row);
}
export async function testFakeGatewayConnection(db: DbExecutor, workspaceId: string, projectId: string,
  connectionId: string): Promise<{ readonly connection_id: string; readonly status: 'AVAILABLE' | 'DISABLED';
  readonly checked_at: string; readonly external_effect_executed: false }> {
  const row = await readGatewayConnection(db, workspaceId, projectId, connectionId);
  return { connection_id: row.id, status: row.status === 'ACTIVE' ? 'AVAILABLE' : 'DISABLED',
    checked_at: new Date().toISOString(), external_effect_executed: false };
}

export interface GatewayPolicyDto {
  readonly id: string; readonly project_id: string; readonly status: string;
  readonly active_version: string | null; readonly revision: string; readonly created_at: string;
}
function policyDto(row: GatewayPermissionPolicyRow): GatewayPolicyDto {
  return { id: row.id, project_id: row.project_id, status: row.status,
    active_version: row.active_version === null ? null : toDecimalString(row.active_version),
    revision: toDecimalString(row.revision), created_at: row.created_at.toISOString() };
}
export async function listGatewayPolicies(db: DbExecutor, workspaceId: string, projectId: string): Promise<readonly GatewayPolicyDto[]> {
  const repositories = createRepositories(db);
  await requireProject(repositories, workspaceId, projectId);
  return (await repositories.gateway.listPolicies(workspaceId, projectId)).map(policyDto);
}
export async function listGatewayPolicyVersions(db: DbExecutor, workspaceId: string, projectId: string,
  policyId: string): Promise<readonly { readonly version: string; readonly capability: string;
  readonly action_type: string; readonly target_prefix: string; readonly decision: string;
  readonly max_payload_bytes: number; readonly created_at: string }[]> {
  const repositories = createRepositories(db);
  const policy = await repositories.gateway.readPolicy(policyId);
  if (policy?.workspace_id !== workspaceId || policy.project_id !== projectId) throw resourceNotFound('Permission policy');
  return (await repositories.gateway.listPolicyVersions(policyId)).map((row: GatewayPermissionVersionRow) => ({
    version: toDecimalString(row.version), capability: row.capability_key, action_type: row.action_type,
    target_prefix: row.target_prefix, decision: row.decision,
    max_payload_bytes: row.max_payload_bytes, created_at: row.created_at.toISOString(),
  }));
}

export interface ManagedResourceDto {
  readonly id: string; readonly project_id: string; readonly canonical_root: string;
  readonly status: string; readonly revision: string; readonly resource_epoch: string;
  readonly file_write_identity_bound: boolean;
}
function resourceDto(row: ManagedResourceRow): ManagedResourceDto {
  return { id: row.id, project_id: row.project_id, canonical_root: row.canonical_root,
    status: row.status, revision: toDecimalString(row.revision),
    resource_epoch: toDecimalString(row.resource_epoch),
    file_write_identity_bound: row.file_write_root_id !== null };
}
export async function listManagedResources(db: DbExecutor, workspaceId: string, projectId: string): Promise<readonly ManagedResourceDto[]> {
  const repositories = createRepositories(db);
  await requireProject(repositories, workspaceId, projectId);
  return (await repositories.gateway.listProjectResources(workspaceId, projectId)).map(resourceDto);
}
export async function readManagedResource(db: DbExecutor, workspaceId: string, projectId: string,
  resourceId: string): Promise<ManagedResourceDto> {
  const row = await createRepositories(db).gateway.readResource(resourceId);
  if (row?.workspace_id !== workspaceId || row.project_id !== projectId) throw resourceNotFound('Managed resource');
  return resourceDto(row);
}

export interface GatewayInvocationDto {
  readonly id: string; readonly attempt_number: string; readonly status: string;
  readonly authority_revision: string; readonly connection_version: string;
  readonly worker_epoch: string | null; readonly created_at: string;
  readonly dispatched_at: string | null; readonly resolved_at: string | null;
  readonly result_ref: JsonObject | null;
}
function invocationDto(row: InvocationAttemptRow): GatewayInvocationDto {
  return { id: row.id, attempt_number: toDecimalString(row.attempt_number), status: row.status,
    authority_revision: toDecimalString(row.authority_revision),
    connection_version: toDecimalString(row.connection_version),
    worker_epoch: row.worker_epoch === null ? null : toDecimalString(row.worker_epoch),
    created_at: row.created_at.toISOString(), dispatched_at: row.dispatched_at?.toISOString() ?? null,
    resolved_at: row.resolved_at?.toISOString() ?? null, result_ref: row.result_ref };
}
export interface GatewayOperationDto {
  readonly id: string; readonly origin: 'RUN' | 'USER_IMPORT';
  readonly project_id: string; readonly run_id: string | null; readonly step_id: string | null;
  readonly import_job_id: string | null; readonly status: string; readonly action_type: string;
  readonly normalized_target: string; readonly params_hash: string;
  readonly connection_id: string; readonly connection_version: string;
  readonly policy_id: string; readonly policy_version: string;
  readonly created_at: string; readonly result_ref: JsonObject | null;
  readonly invocations: readonly GatewayInvocationDto[];
}
async function operationDto(repositories: Repositories, row: LogicalOperationRow): Promise<GatewayOperationDto> {
  return { id: row.id, origin: row.origin, project_id: row.project_id,
    run_id: row.run_id, step_id: row.step_id, import_job_id: row.import_job_id,
    status: row.status, action_type: row.action_type, normalized_target: row.normalized_target,
    params_hash: row.params_hash.toString('hex'), connection_id: row.connection_id,
    connection_version: toDecimalString(row.connection_version), policy_id: row.policy_id,
    policy_version: toDecimalString(row.policy_version), created_at: row.created_at.toISOString(),
    result_ref: row.result_ref,
    invocations: (await repositories.gateway.listInvocations(row.id)).map(invocationDto) };
}
export async function listRunGatewayOperations(db: DbExecutor, workspaceId: string,
  runId: string): Promise<readonly GatewayOperationDto[]> {
  const repositories = createRepositories(db);
  const run = await repositories.runs.readRun(runId);
  if (run?.workspace_id !== workspaceId) throw resourceNotFound('Run');
  return Promise.all((await repositories.gateway.listRunOperations(runId)).map((row) => operationDto(repositories, row)));
}
export async function listImportGatewayOperations(db: DbExecutor, workspaceId: string,
  importJobId: string): Promise<readonly GatewayOperationDto[]> {
  const repositories = createRepositories(db);
  const job = await repositories.gateway.readImportJob(importJobId);
  if (job?.workspace_id !== workspaceId) throw resourceNotFound('Import job');
  return Promise.all((await repositories.gateway.listImportOperations(job.id)).map((row) => operationDto(repositories, row)));
}
export async function readGatewayOperationDto(db: DbExecutor, workspaceId: string,
  operationId: string): Promise<GatewayOperationDto> {
  const repositories = createRepositories(db);
  const operation = await repositories.gateway.readOperation(operationId);
  if (operation?.workspace_id !== workspaceId) throw resourceNotFound('Gateway operation');
  return operationDto(repositories, operation);
}

export interface FileWriteChangeSetDto {
  readonly id: string; readonly invocation_id: string; readonly run_id: string;
  readonly resource_id: string; readonly action_type: string; readonly canonical_root: string;
  readonly status: string; readonly evidence_source: string; readonly file_count: number;
  readonly created_at: string; readonly updated_at: string;
  readonly files: readonly {
    readonly relative_path: string; readonly action: string;
    readonly baseline_sha256: string | null; readonly observed_baseline_sha256: string | null;
    readonly target_sha256: string | null; readonly actual_sha256: string | null;
    readonly status: string; readonly error: string | null; readonly created_at: string;
  }[];
}

function fileWriteFileDto(row: ChangeSetFileRow): FileWriteChangeSetDto['files'][number] {
  return { relative_path: row.relative_path, action: row.action,
    baseline_sha256: row.baseline_sha256, observed_baseline_sha256: row.observed_baseline_sha256,
    target_sha256: row.target_sha256, actual_sha256: row.actual_sha256,
    status: row.status, error: row.error, created_at: row.created_at.toISOString() };
}

async function fileWriteChangeSetDto(repositories: Repositories, row: ChangeSetRow): Promise<FileWriteChangeSetDto> {
  return { id: row.id, invocation_id: row.invocation_id, run_id: row.run_id,
    resource_id: row.resource_id, action_type: row.action_type, canonical_root: row.canonical_root,
    status: row.status, evidence_source: row.evidence_source, file_count: row.file_count,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
    files: (await repositories.changeSets.listFiles(row.id)).map(fileWriteFileDto) };
}

/** Historical ledger projection only; it does not read current disk state or infer acceptance. */
export async function readFileWriteChangeSets(db: DbExecutor, workspaceId: string, operationId: string): Promise<{
  readonly operation_id: string; readonly change_sets: readonly FileWriteChangeSetDto[];
}> {
  const repositories = createRepositories(db);
  const operation = await repositories.gateway.readOperation(operationId);
  if (operation?.workspace_id !== workspaceId || operation.capability_key !== 'FILE_WRITE' ||
      operation.origin !== 'RUN') throw resourceNotFound('File write operation');
  const rows = await repositories.changeSets.listByOperation(operationId);
  return { operation_id: operationId,
    change_sets: await Promise.all(rows.map((row) => fileWriteChangeSetDto(repositories, row))) };
}

/** Frozen intent only: this projection never rereads a mutable target file. */
export async function readFileWriteFrozenDiff(db: DbExecutor, workspaceId: string, operationId: string): Promise<{
  readonly operation_id: string;
  readonly basis: 'FROZEN_INTENT';
  readonly files: readonly {
    readonly relative_path: string;
    readonly action: FileChange['action'];
    readonly baseline_sha256: string | null;
    readonly target_sha256: string | null;
    readonly availability: 'AVAILABLE' | 'UNAVAILABLE';
    readonly unavailable_reason: string | null;
    readonly before_text: string | null;
    readonly after_text: string | null;
  }[];
}> {
  const repositories = createRepositories(db);
  const operation = await repositories.gateway.readOperation(operationId);
  if (operation?.workspace_id !== workspaceId || operation.capability_key !== 'FILE_WRITE' ||
      operation.origin !== 'RUN') throw resourceNotFound('File write operation');
  const pathEvidence = await repositories.fileWritePaths.readByOperation(operationId);
  const root = pathEvidence?.root_path ?? (operation.action_type === 'APPLY_CHANGESET'
    ? operation.normalized_target : dirname(operation.normalized_target));
  const changes: readonly FileChange[] = operation.action_type === 'APPLY_CHANGESET'
    ? operation.params.changes as unknown as FileChange[]
    : [{ path: pathEvidence === undefined ? basename(operation.normalized_target)
      : relative(root, operation.normalized_target),
      action: typeof operation.params.baseline_sha256 === 'string' ? 'MODIFY' : 'CREATE',
      baselineSha256: operation.params.baseline_sha256 as string | null | undefined,
      content: operation.params.content as string | undefined }];
  const snapshots = new Map((await repositories.fileWriteDiffs.listByOperation(operationId))
    .map((row) => [row.relative_path, row]));
  return { operation_id: operationId, basis: 'FROZEN_INTENT', files: changes.map((change) => {
    const path = canonicalRelativePath(root, change.path);
    const baselineSha = change.action === 'CREATE' ? null : change.baselineSha256?.toLowerCase() ?? null;
    const targetSha = change.action === 'DELETE' ? null :
      typeof change.content === 'string' ? computeSha256(change.content) : null;
    const snapshot = snapshots.get(path);
    let reason: string | null = null;
    const before = change.action === 'CREATE' ? '' : snapshot?.baseline_text ?? null;
    const after = change.action === 'DELETE' ? '' : change.content ?? null;
    if (before === null) reason = snapshot?.unavailable_reason ?? 'BASELINE_UNAVAILABLE';
    else if (change.action !== 'CREATE' && (snapshot?.baseline_sha256 !== baselineSha ||
        Buffer.byteLength(before, 'utf8') > MAX_FILE_WRITE_DIFF_TEXT_BYTES ||
        computeSha256(before) !== baselineSha)) reason = 'BASELINE_EVIDENCE_MISMATCH';
    if (reason === null && (after === null ||
        Buffer.byteLength(after, 'utf8') > MAX_FILE_WRITE_DIFF_TEXT_BYTES ||
        (change.action !== 'DELETE' && (targetSha === null ||
          (change.targetSha256 !== undefined && change.targetSha256.toLowerCase() !== targetSha))))) {
      reason = 'TARGET_TEXT_UNAVAILABLE';
    }
    return { relative_path: path, action: change.action, baseline_sha256: baselineSha,
      target_sha256: targetSha, availability: reason === null ? 'AVAILABLE' : 'UNAVAILABLE',
      unavailable_reason: reason, before_text: reason === null ? before : null,
      after_text: reason === null ? after : null };
  }) };
}
