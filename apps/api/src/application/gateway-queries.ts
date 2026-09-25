import type { DbExecutor } from '../infrastructure/database.js';
import type {
  GatewayConnectionRow, GatewayPermissionPolicyRow, GatewayPermissionVersionRow,
  InvocationAttemptRow, LogicalOperationRow, ManagedResourceRow,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { resourceNotFound } from './domain-error.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

async function requireProject(repositories: Repositories, workspaceId: string, projectId: string): Promise<void> {
  const project = await repositories.projects.readProject(projectId);
  if (project?.workspace_id !== workspaceId) throw resourceNotFound('Project');
}

export interface GatewayConnectionDto {
  readonly id: string; readonly project_id: string; readonly status: string;
  readonly version: string; readonly capabilities: readonly string[]; readonly created_at: string;
}
async function connectionDto(repositories: Repositories, row: GatewayConnectionRow): Promise<GatewayConnectionDto> {
  return { id: row.id, project_id: row.project_id, status: row.status,
    version: toDecimalString(row.version),
    capabilities: await repositories.gateway.listConnectionCapabilities(row.id),
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
}
function resourceDto(row: ManagedResourceRow): ManagedResourceDto {
  return { id: row.id, project_id: row.project_id, canonical_root: row.canonical_root,
    status: row.status, revision: toDecimalString(row.revision),
    resource_epoch: toDecimalString(row.resource_epoch) };
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
