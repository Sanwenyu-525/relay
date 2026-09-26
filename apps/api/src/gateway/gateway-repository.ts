import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type {
  GatewayCapability, GatewayConnectionRow, GatewayDecision, GatewayPermissionPolicyRow,
  GatewayPermissionVersionRow, ImportJobRow, InvocationAttemptRow, InvocationStatus,
  LogicalOperationRow, ManagedResourceRow, ResourceClaimRow, ResourceClaimStatus,
} from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { requireRow } from '../shared/sql-rows.js';

export interface ActivePolicy extends GatewayPermissionPolicyRow, GatewayPermissionVersionRow {}

/** SQL stays in the Gateway Owner; application use cases coordinate the lock order. */
export class GatewayRepository {
  constructor(private readonly db: DbExecutor) {}

  async insertConnection(input: { id: string; workspaceId: string; projectId: string; config: JsonObject }): Promise<GatewayConnectionRow> {
    const result = await sql<GatewayConnectionRow>`
      insert into gateway_connections (id, workspace_id, project_id, config)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${JSON.stringify(input.config)}::jsonb)
      returning *
    `.execute(this.db);
    return requireRow(result.rows, 'insert Gateway connection');
  }

  async readConnection(id: string): Promise<GatewayConnectionRow | undefined> {
    return (await sql<GatewayConnectionRow>`select * from gateway_connections where id = ${id}`.execute(this.db)).rows[0];
  }

  async listConnections(workspaceId: string, projectId: string): Promise<readonly GatewayConnectionRow[]> {
    return (await sql<GatewayConnectionRow>`select * from gateway_connections
      where workspace_id = ${workspaceId} and project_id = ${projectId}
      order by created_at, id limit 100`.execute(this.db)).rows;
  }

  async setConnection(input: { id: string; status: 'ACTIVE' | 'DISABLED'; config: JsonObject }): Promise<GatewayConnectionRow> {
    const result = await sql<GatewayConnectionRow>`
      update gateway_connections set status = ${input.status}, config = ${JSON.stringify(input.config)}::jsonb,
        version = version + 1, updated_at = now() where id = ${input.id} returning *
    `.execute(this.db);
    return requireRow(result.rows, 'update Gateway connection');
  }

  async addConnectionCapability(connectionId: string, capability: GatewayCapability): Promise<void> {
    await sql`insert into gateway_connection_capabilities (connection_id, capability_key)
      values (${connectionId}, ${capability})`.execute(this.db);
  }

  async hasConnectionCapability(connectionId: string, capability: GatewayCapability): Promise<boolean> {
    const result = await sql<{ present: boolean }>`
      select exists(select 1 from gateway_connection_capabilities
        where connection_id = ${connectionId} and capability_key = ${capability}) as present
    `.execute(this.db);
    return result.rows[0]?.present === true;
  }

  async listConnectionCapabilities(connectionId: string): Promise<readonly GatewayCapability[]> {
    const result = await sql<{ capability_key: GatewayCapability }>`
      select capability_key from gateway_connection_capabilities
      where connection_id = ${connectionId} order by capability_key
    `.execute(this.db);
    return result.rows.map((row) => row.capability_key);
  }

  async insertPolicy(input: { id: string; workspaceId: string; projectId: string; capability: GatewayCapability;
    actionType: string; targetPrefix: string; decision: GatewayDecision; maxPayloadBytes: number }): Promise<GatewayPermissionPolicyRow> {
    const root = await sql<GatewayPermissionPolicyRow>`
      insert into gateway_permission_policies (id, workspace_id, project_id, active_version)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, 1) returning *
    `.execute(this.db);
    await this.insertPolicyVersion({ policyId: input.id, version: 1n, ...input });
    return requireRow(root.rows, 'insert Gateway policy');
  }

  async insertPolicyVersion(input: { policyId: string; version: bigint; capability: GatewayCapability;
    actionType: string; targetPrefix: string; decision: GatewayDecision; maxPayloadBytes: number }): Promise<void> {
    await sql`insert into gateway_permission_versions
      (policy_id, version, capability_key, action_type, target_prefix, decision, max_payload_bytes)
      values (${input.policyId}, ${input.version}, ${input.capability}, ${input.actionType},
        ${input.targetPrefix}, ${input.decision}, ${input.maxPayloadBytes})`.execute(this.db);
  }

  async readPolicy(id: string): Promise<GatewayPermissionPolicyRow | undefined> {
    return (await sql<GatewayPermissionPolicyRow>`select * from gateway_permission_policies where id = ${id}`.execute(this.db)).rows[0];
  }

  async listPolicies(workspaceId: string, projectId: string): Promise<readonly GatewayPermissionPolicyRow[]> {
    return (await sql<GatewayPermissionPolicyRow>`select * from gateway_permission_policies
      where workspace_id = ${workspaceId} and project_id = ${projectId}
      order by created_at, id limit 100`.execute(this.db)).rows;
  }

  async listPolicyVersions(policyId: string): Promise<readonly GatewayPermissionVersionRow[]> {
    return (await sql<GatewayPermissionVersionRow>`select * from gateway_permission_versions
      where policy_id = ${policyId} order by version desc limit 100`.execute(this.db)).rows;
  }

  async latestPolicyVersion(policyId: string): Promise<bigint> {
    const result = await sql<{ version: bigint | null }>`
      select max(version) as version from gateway_permission_versions where policy_id = ${policyId}
    `.execute(this.db);
    return result.rows[0]?.version ?? 0n;
  }

  async activatePolicyVersion(id: string, version: bigint): Promise<GatewayPermissionPolicyRow> {
    const result = await sql<GatewayPermissionPolicyRow>`
      update gateway_permission_policies set active_version = ${version}, status = 'ACTIVE',
        revision = revision + 1, updated_at = now() where id = ${id} returning *
    `.execute(this.db);
    return requireRow(result.rows, 'activate Gateway policy version');
  }

  async revokePolicy(id: string): Promise<GatewayPermissionPolicyRow> {
    const result = await sql<GatewayPermissionPolicyRow>`
      update gateway_permission_policies set active_version = null, status = 'REVOKED',
        revision = revision + 1, updated_at = now() where id = ${id} returning *
    `.execute(this.db);
    return requireRow(result.rows, 'revoke Gateway policy');
  }

  async listActivePolicies(workspaceId: string, projectId: string, capability: GatewayCapability, actionType: string): Promise<readonly ActivePolicy[]> {
    const result = await sql<ActivePolicy>`
      select p.*, v.version, v.capability_key, v.action_type, v.target_prefix, v.decision,
        v.max_payload_bytes, v.created_at as version_created_at
      from gateway_permission_policies p join gateway_permission_versions v
        on v.policy_id = p.id and v.version = p.active_version
      where p.workspace_id = ${workspaceId} and p.project_id = ${projectId}
        and p.status = 'ACTIVE' and v.capability_key = ${capability} and v.action_type = ${actionType}
      order by p.id
    `.execute(this.db);
    return result.rows;
  }

  /** A single advisory transaction lock serializes root registration across Workspaces. */
  async lockResourceRegistry(): Promise<void> {
    await sql`select pg_advisory_xact_lock(7162, 9)`.execute(this.db);
  }

  async listResources(): Promise<readonly ManagedResourceRow[]> {
    return (await sql<ManagedResourceRow>`select * from managed_resources order by identity_key, id`.execute(this.db)).rows;
  }

  async insertResource(input: { id: string; workspaceId: string; projectId: string;
    canonicalRoot: string; identityKey: string }): Promise<ManagedResourceRow> {
    const result = await sql<ManagedResourceRow>`
      insert into managed_resources (id, workspace_id, project_id, canonical_root, identity_key)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.canonicalRoot}, ${input.identityKey})
      returning *
    `.execute(this.db);
    return requireRow(result.rows, 'insert managed resource');
  }

  async readResource(id: string): Promise<ManagedResourceRow | undefined> {
    return (await sql<ManagedResourceRow>`select * from managed_resources where id = ${id}`.execute(this.db)).rows[0];
  }

  async listProjectResources(workspaceId: string, projectId: string): Promise<readonly ManagedResourceRow[]> {
    return (await sql<ManagedResourceRow>`select * from managed_resources
      where workspace_id = ${workspaceId} and project_id = ${projectId}
      order by created_at, id limit 100`.execute(this.db)).rows;
  }

  async lockResource(id: string): Promise<ManagedResourceRow | undefined> {
    return (await sql<ManagedResourceRow>`select * from managed_resources where id = ${id} for update`.execute(this.db)).rows[0];
  }

  async disableResource(id: string): Promise<ManagedResourceRow> {
    const result = await sql<ManagedResourceRow>`
      update managed_resources set status = 'DISABLED', revision = revision + 1
      where id = ${id} returning *
    `.execute(this.db);
    return requireRow(result.rows, 'disable managed resource');
  }

  async nextResourceEpoch(id: string): Promise<bigint> {
    const result = await sql<{ resource_epoch: bigint }>`
      update managed_resources set resource_epoch = resource_epoch + 1 where id = ${id}
      returning resource_epoch
    `.execute(this.db);
    return requireRow(result.rows, 'increment resource epoch').resource_epoch;
  }

  async activeClaim(resourceId: string): Promise<ResourceClaimRow | undefined> {
    return (await sql<ResourceClaimRow>`select * from resource_claims
      where resource_id = ${resourceId} and status in ('HELD', 'QUARANTINED') for update`.execute(this.db)).rows[0];
  }

  async listOccupiedResources(): Promise<readonly { readonly claim_id: string; readonly identity_key: string }[]> {
    return (await sql<{ claim_id: string; identity_key: string }>`
      select c.id as claim_id, r.identity_key from resource_claims c
      join managed_resources r on r.id = c.resource_id
      where c.status in ('HELD', 'QUARANTINED') order by r.identity_key, c.id
    `.execute(this.db)).rows;
  }

  async insertClaim(input: { id: string; workspaceId: string; projectId: string;
    resourceId: string; taskId: string; runId: string;
    workerId: string; workerEpoch: bigint; claimEpoch: bigint; claimToken: string }): Promise<ResourceClaimRow> {
    const result = await sql<ResourceClaimRow>`
      insert into resource_claims (id, workspace_id, project_id, resource_id, task_id, run_id, worker_id,
        worker_epoch, claim_epoch, claim_token, status)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.resourceId}, ${input.taskId}, ${input.runId},
        ${input.workerId}, ${input.workerEpoch}, ${input.claimEpoch}, ${input.claimToken}, 'HELD')
      returning *
    `.execute(this.db);
    return requireRow(result.rows, 'insert resource claim');
  }

  async readClaim(id: string): Promise<ResourceClaimRow | undefined> {
    return (await sql<ResourceClaimRow>`select * from resource_claims where id = ${id}`.execute(this.db)).rows[0];
  }

  async setClaimStatus(id: string, status: ResourceClaimStatus): Promise<ResourceClaimRow> {
    const result = await sql<ResourceClaimRow>`
      update resource_claims set status = ${status},
        released_at = case when ${status} = 'RELEASED' then now() else null end
      where id = ${id} and status in ('HELD', 'QUARANTINED') returning *
    `.execute(this.db);
    return requireRow(result.rows, 'change resource claim status');
  }

  async insertImportJob(input: { id: string; workspaceId: string; projectId: string;
    actorRef: string; configVersion: string; sourceUri: string; commandId: string;
    connectionId?: string }): Promise<ImportJobRow> {
    const result = await sql<ImportJobRow>`
      insert into import_jobs (id, workspace_id, project_id, actor_ref, config_version,
        source_uri, request_command_id, connection_id)
      values (${input.id}, ${input.workspaceId}, ${input.projectId}, ${input.actorRef},
        ${input.configVersion}, ${input.sourceUri}, ${input.commandId},
        ${input.connectionId ?? null}) returning *
    `.execute(this.db);
    return requireRow(result.rows, 'insert import job');
  }

  async lockImportJob(id: string): Promise<ImportJobRow | undefined> {
    return (await sql<ImportJobRow>`select * from import_jobs where id = ${id} for update`.execute(this.db)).rows[0];
  }

  async readImportJob(id: string): Promise<ImportJobRow | undefined> {
    return (await sql<ImportJobRow>`select * from import_jobs where id = ${id}`.execute(this.db)).rows[0];
  }

  /** Also reclaims RUNNING jobs with no operation after a crash between the
   * status change and Gateway prepare. The job row serializes each scan. */
  async claimImportJobsNeedingPrepare(limit: number): Promise<readonly ImportJobRow[]> {
    return (await sql<ImportJobRow>`
      select j.* from import_jobs j
      join projects p on p.id = j.project_id and p.archived_at is null
      where j.connection_id is not null and
        (j.status = 'QUEUED' or (j.status = 'RUNNING' and not exists (
          select 1 from logical_operations o where o.import_job_id = j.id and o.origin = 'USER_IMPORT')))
      order by j.created_at, j.id
      limit ${limit} for update of j skip locked`.execute(this.db)).rows;
  }

  /** Include settled operations so a crash after Gateway outcome still commits
   * the job and Knowledge version on the next tick. */
  async listRunnableImportJobIds(): Promise<readonly { job_id: string; operation_id: string }[]> {
    return (await sql<{ job_id: string; operation_id: string }>`
      select j.id as job_id, o.id as operation_id
      from import_jobs j
      join logical_operations o on o.import_job_id = j.id and o.origin = 'USER_IMPORT'
      where j.status = 'RUNNING' and o.status in
        ('PREPARED', 'WAITING_APPROVAL', 'SUCCEEDED', 'FAILED')
      order by j.created_at, j.id`.execute(this.db)).rows;
  }

  async setImportJobStatus(id: string, status: ImportJobRow['status'], error: string | null): Promise<ImportJobRow> {
    const result = await sql<ImportJobRow>`
      update import_jobs set status = ${status}, error = ${error}, revision = revision + 1
      where id = ${id} returning *
    `.execute(this.db);
    return requireRow(result.rows, 'change import job status');
  }

  /** Terminal settle for an executed import; knowledge_version_id links the
   * fetched page atomically with the SUCCEEDED status. */
  async settleImportJob(id: string, status: Extract<ImportJobRow['status'], 'SUCCEEDED' | 'FAILED'>,
    error: string | null, knowledgeVersionId?: string): Promise<ImportJobRow> {
    const result = await sql<ImportJobRow>`
      update import_jobs set status = ${status}, error = ${error},
        knowledge_version_id = ${knowledgeVersionId ?? null}, revision = revision + 1
      where id = ${id} returning *
    `.execute(this.db);
    return requireRow(result.rows, 'settle import job');
  }

  async insertOperation(input: Omit<LogicalOperationRow, 'created_at' | 'updated_at' | 'result_ref'>): Promise<LogicalOperationRow> {
    const result = await sql<LogicalOperationRow>`
      insert into logical_operations (id, workspace_id, project_id, origin, task_id, run_id, step_id,
        import_job_id, intent_key, connection_id, connection_version, connection_config,
        policy_id, policy_version, capability_key, action_type, normalized_target,
        params_hash, params, resource_id, status)
      values (${input.id}, ${input.workspace_id}, ${input.project_id}, ${input.origin}, ${input.task_id},
        ${input.run_id}, ${input.step_id}, ${input.import_job_id}, ${input.intent_key},
        ${input.connection_id}, ${input.connection_version}, ${JSON.stringify(input.connection_config)}::jsonb,
        ${input.policy_id}, ${input.policy_version}, ${input.capability_key}, ${input.action_type},
        ${input.normalized_target}, ${input.params_hash}, ${JSON.stringify(input.params)}::jsonb,
        ${input.resource_id}, ${input.status}) returning *
    `.execute(this.db);
    return requireRow(result.rows, 'insert logical operation');
  }

  async readOperation(id: string): Promise<LogicalOperationRow | undefined> {
    return (await sql<LogicalOperationRow>`select * from logical_operations where id = ${id}`.execute(this.db)).rows[0];
  }

  async lockOperation(id: string): Promise<LogicalOperationRow | undefined> {
    return (await sql<LogicalOperationRow>`select * from logical_operations where id = ${id} for update`.execute(this.db)).rows[0];
  }

  async findOperationByIntent(input: { runId?: string; stepId?: string; importJobId?: string; intentKey: string }): Promise<LogicalOperationRow | undefined> {
    const result = input.importJobId === undefined
      ? await sql<LogicalOperationRow>`select * from logical_operations where run_id = ${input.runId ?? null}
          and step_id = ${input.stepId ?? null} and intent_key = ${input.intentKey}`.execute(this.db)
      : await sql<LogicalOperationRow>`select * from logical_operations where import_job_id = ${input.importJobId}
          and intent_key = ${input.intentKey}`.execute(this.db);
    return result.rows[0];
  }

  async setOperationStatus(id: string, status: LogicalOperationRow['status'], resultRef: JsonObject | null = null): Promise<LogicalOperationRow> {
    const result = await sql<LogicalOperationRow>`
      update logical_operations set status = ${status}, result_ref = ${resultRef === null ? null : JSON.stringify(resultRef)}::jsonb,
        updated_at = now() where id = ${id} returning *
    `.execute(this.db);
    return requireRow(result.rows, 'change logical operation status');
  }

  async listUnresolvedRunOperations(runId: string): Promise<readonly LogicalOperationRow[]> {
    return (await sql<LogicalOperationRow>`select * from logical_operations where run_id = ${runId}
      and status in ('PREPARED', 'DISPATCHING', 'UNKNOWN', 'WAITING_APPROVAL') order by created_at, id`.execute(this.db)).rows;
  }

  async listUnresolvedImportOperations(importJobId: string): Promise<readonly LogicalOperationRow[]> {
    return (await sql<LogicalOperationRow>`select * from logical_operations where import_job_id = ${importJobId}
      and status in ('PREPARED', 'DISPATCHING', 'UNKNOWN', 'WAITING_APPROVAL')
      order by created_at, id`.execute(this.db)).rows;
  }

  async insertInvocation(input: Omit<InvocationAttemptRow, 'created_at' | 'dispatched_at' | 'resolved_at' | 'result_ref'>): Promise<InvocationAttemptRow> {
    const result = await sql<InvocationAttemptRow>`
      insert into invocation_attempts (id, operation_id, origin, task_id, run_id, resource_id,
        attempt_number, status,
        authority_revision, connection_version, connection_config, ownership_epoch,
        worker_id, worker_epoch, resource_claim_id, claim_token, claim_epoch)
      values (${input.id}, ${input.operation_id}, ${input.origin}, ${input.task_id},
        ${input.run_id}, ${input.resource_id}, ${input.attempt_number}, ${input.status},
        ${input.authority_revision}, ${input.connection_version}, ${JSON.stringify(input.connection_config)}::jsonb,
        ${input.ownership_epoch}, ${input.worker_id}, ${input.worker_epoch},
        ${input.resource_claim_id}, ${input.claim_token}, ${input.claim_epoch}) returning *
    `.execute(this.db);
    return requireRow(result.rows, 'insert invocation');
  }

  async readInvocation(id: string): Promise<InvocationAttemptRow | undefined> {
    return (await sql<InvocationAttemptRow>`select * from invocation_attempts where id = ${id}`.execute(this.db)).rows[0];
  }

  async lockInvocation(id: string): Promise<InvocationAttemptRow | undefined> {
    return (await sql<InvocationAttemptRow>`select * from invocation_attempts where id = ${id} for update`.execute(this.db)).rows[0];
  }

  async lastInvocation(operationId: string): Promise<InvocationAttemptRow | undefined> {
    return (await sql<InvocationAttemptRow>`select * from invocation_attempts
      where operation_id = ${operationId} order by attempt_number desc limit 1`.execute(this.db)).rows[0];
  }

  async listInvocations(operationId: string): Promise<readonly InvocationAttemptRow[]> {
    return (await sql<InvocationAttemptRow>`select * from invocation_attempts
      where operation_id = ${operationId} order by attempt_number, id limit 100`.execute(this.db)).rows;
  }

  async listRunOperations(runId: string): Promise<readonly LogicalOperationRow[]> {
    return (await sql<LogicalOperationRow>`select * from logical_operations
      where run_id = ${runId} order by created_at, id limit 100`.execute(this.db)).rows;
  }

  async listImportOperations(importJobId: string): Promise<readonly LogicalOperationRow[]> {
    return (await sql<LogicalOperationRow>`select * from logical_operations
      where import_job_id = ${importJobId} order by created_at, id limit 100`.execute(this.db)).rows;
  }

  async transitionInvocation(id: string, from: InvocationStatus, to: InvocationStatus, resultRef: JsonObject | null = null): Promise<InvocationAttemptRow | undefined> {
    const result = await sql<InvocationAttemptRow>`
      update invocation_attempts set status = ${to}, result_ref = ${resultRef === null ? null : JSON.stringify(resultRef)}::jsonb,
        dispatched_at = case when ${to} = 'DISPATCHING' then clock_timestamp() else dispatched_at end,
        resolved_at = case when ${to} in ('SUCCEEDED', 'FAILED', 'NOT_EXECUTED') then clock_timestamp() else resolved_at end
      where id = ${id} and status = ${from} returning *
    `.execute(this.db);
    return result.rows[0];
  }

  async reserveApproval(reviewId: string, operationId: string): Promise<void> {
    await sql`insert into approval_reservations (review_id, operation_id)
      values (${reviewId}, ${operationId}) on conflict (review_id) do nothing`.execute(this.db);
  }

  async readReservation(reviewId: string): Promise<{ readonly review_id: string; readonly operation_id: string } | undefined> {
    return (await sql<{ review_id: string; operation_id: string }>`select review_id, operation_id
      from approval_reservations where review_id = ${reviewId}`.execute(this.db)).rows[0];
  }

  async bindInvocationApproval(invocationId: string, reviewId: string, operationId: string): Promise<void> {
    await sql`insert into invocation_approval_bindings (invocation_id, review_id, operation_id)
      values (${invocationId}, ${reviewId}, ${operationId})`.execute(this.db);
  }
}
