import { basename, dirname, relative } from 'node:path';
import { toDecimalString } from '../shared/decimal.js';
import { resourceNotFound } from './domain-error.js';
import { createRepositories } from './unit-of-work.js';
import { canonicalRelativePath, computeSha256, MAX_FILE_WRITE_DIFF_TEXT_BYTES } from '../files/file-changeset.js';
async function requireProject(repositories, workspaceId, projectId) {
    const project = await repositories.projects.readProject(projectId);
    if (project?.workspace_id !== workspaceId)
        throw resourceNotFound('Project');
}
async function connectionDto(repositories, row) {
    const capabilities = await repositories.gateway.listConnectionCapabilities(row.id);
    const executables = capabilities.includes('CLI_RUN') && Array.isArray(row.config.allowed_executables)
        ? row.config.allowed_executables.filter((entry) => typeof entry === 'string') : null;
    return { id: row.id, project_id: row.project_id, status: row.status,
        version: toDecimalString(row.version),
        capabilities,
        allowed_host: capabilities.includes('WEB_FETCH') &&
            typeof row.config.allowed_host === 'string' ? row.config.allowed_host : null,
        allowed_executables: executables === null || executables.length === 0 ? null : executables,
        created_at: row.created_at.toISOString() };
}
export async function listGatewayConnections(db, workspaceId, projectId) {
    const repositories = createRepositories(db);
    await requireProject(repositories, workspaceId, projectId);
    return Promise.all((await repositories.gateway.listConnections(workspaceId, projectId)).map((row) => connectionDto(repositories, row)));
}
export async function readGatewayConnection(db, workspaceId, projectId, connectionId) {
    const repositories = createRepositories(db);
    const row = await repositories.gateway.readConnection(connectionId);
    if (row?.workspace_id !== workspaceId || row.project_id !== projectId)
        throw resourceNotFound('Connection');
    return connectionDto(repositories, row);
}
export async function testFakeGatewayConnection(db, workspaceId, projectId, connectionId) {
    const row = await readGatewayConnection(db, workspaceId, projectId, connectionId);
    return { connection_id: row.id, status: row.status === 'ACTIVE' ? 'AVAILABLE' : 'DISABLED',
        checked_at: new Date().toISOString(), external_effect_executed: false };
}
function policyDto(row) {
    return { id: row.id, project_id: row.project_id, status: row.status,
        active_version: row.active_version === null ? null : toDecimalString(row.active_version),
        revision: toDecimalString(row.revision), created_at: row.created_at.toISOString() };
}
export async function listGatewayPolicies(db, workspaceId, projectId) {
    const repositories = createRepositories(db);
    await requireProject(repositories, workspaceId, projectId);
    return (await repositories.gateway.listPolicies(workspaceId, projectId)).map(policyDto);
}
export async function listGatewayPolicyVersions(db, workspaceId, projectId, policyId) {
    const repositories = createRepositories(db);
    const policy = await repositories.gateway.readPolicy(policyId);
    if (policy?.workspace_id !== workspaceId || policy.project_id !== projectId)
        throw resourceNotFound('Permission policy');
    return (await repositories.gateway.listPolicyVersions(policyId)).map((row) => ({
        version: toDecimalString(row.version), capability: row.capability_key, action_type: row.action_type,
        target_prefix: row.target_prefix, decision: row.decision,
        max_payload_bytes: row.max_payload_bytes, created_at: row.created_at.toISOString(),
    }));
}
function resourceDto(row) {
    return { id: row.id, project_id: row.project_id, canonical_root: row.canonical_root,
        status: row.status, revision: toDecimalString(row.revision),
        resource_epoch: toDecimalString(row.resource_epoch),
        file_write_identity_bound: row.file_write_root_id !== null };
}
export async function listManagedResources(db, workspaceId, projectId) {
    const repositories = createRepositories(db);
    await requireProject(repositories, workspaceId, projectId);
    return (await repositories.gateway.listProjectResources(workspaceId, projectId)).map(resourceDto);
}
export async function readManagedResource(db, workspaceId, projectId, resourceId) {
    const row = await createRepositories(db).gateway.readResource(resourceId);
    if (row?.workspace_id !== workspaceId || row.project_id !== projectId)
        throw resourceNotFound('Managed resource');
    return resourceDto(row);
}
function invocationDto(row) {
    return { id: row.id, attempt_number: toDecimalString(row.attempt_number), status: row.status,
        authority_revision: toDecimalString(row.authority_revision),
        connection_version: toDecimalString(row.connection_version),
        worker_epoch: row.worker_epoch === null ? null : toDecimalString(row.worker_epoch),
        created_at: row.created_at.toISOString(), dispatched_at: row.dispatched_at?.toISOString() ?? null,
        resolved_at: row.resolved_at?.toISOString() ?? null, result_ref: row.result_ref };
}
async function operationDto(repositories, row) {
    return { id: row.id, origin: row.origin, project_id: row.project_id,
        run_id: row.run_id, step_id: row.step_id, import_job_id: row.import_job_id,
        status: row.status, action_type: row.action_type, normalized_target: row.normalized_target,
        params_hash: row.params_hash.toString('hex'), connection_id: row.connection_id,
        connection_version: toDecimalString(row.connection_version), policy_id: row.policy_id,
        policy_version: toDecimalString(row.policy_version), created_at: row.created_at.toISOString(),
        result_ref: row.result_ref,
        invocations: (await repositories.gateway.listInvocations(row.id)).map(invocationDto) };
}
export async function listRunGatewayOperations(db, workspaceId, runId) {
    const repositories = createRepositories(db);
    const run = await repositories.runs.readRun(runId);
    if (run?.workspace_id !== workspaceId)
        throw resourceNotFound('Run');
    return Promise.all((await repositories.gateway.listRunOperations(runId)).map((row) => operationDto(repositories, row)));
}
export async function listImportGatewayOperations(db, workspaceId, importJobId) {
    const repositories = createRepositories(db);
    const job = await repositories.gateway.readImportJob(importJobId);
    if (job?.workspace_id !== workspaceId)
        throw resourceNotFound('Import job');
    return Promise.all((await repositories.gateway.listImportOperations(job.id)).map((row) => operationDto(repositories, row)));
}
export async function readGatewayOperationDto(db, workspaceId, operationId) {
    const repositories = createRepositories(db);
    const operation = await repositories.gateway.readOperation(operationId);
    if (operation?.workspace_id !== workspaceId)
        throw resourceNotFound('Gateway operation');
    return operationDto(repositories, operation);
}
function fileWriteFileDto(row) {
    return { relative_path: row.relative_path, action: row.action,
        baseline_sha256: row.baseline_sha256, observed_baseline_sha256: row.observed_baseline_sha256,
        target_sha256: row.target_sha256, actual_sha256: row.actual_sha256,
        status: row.status, error: row.error, created_at: row.created_at.toISOString() };
}
async function fileWriteChangeSetDto(repositories, row) {
    return { id: row.id, invocation_id: row.invocation_id, run_id: row.run_id,
        resource_id: row.resource_id, action_type: row.action_type, canonical_root: row.canonical_root,
        status: row.status, evidence_source: row.evidence_source, file_count: row.file_count,
        created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
        files: (await repositories.changeSets.listFiles(row.id)).map(fileWriteFileDto) };
}
/** Historical ledger projection only; it does not read current disk state or infer acceptance. */
export async function readFileWriteChangeSets(db, workspaceId, operationId) {
    const repositories = createRepositories(db);
    const operation = await repositories.gateway.readOperation(operationId);
    if (operation?.workspace_id !== workspaceId || operation.capability_key !== 'FILE_WRITE' ||
        operation.origin !== 'RUN')
        throw resourceNotFound('File write operation');
    const rows = await repositories.changeSets.listByOperation(operationId);
    return { operation_id: operationId,
        change_sets: await Promise.all(rows.map((row) => fileWriteChangeSetDto(repositories, row))) };
}
/** Frozen intent only: this projection never rereads a mutable target file. */
export async function readFileWriteFrozenDiff(db, workspaceId, operationId) {
    const repositories = createRepositories(db);
    const operation = await repositories.gateway.readOperation(operationId);
    if (operation?.workspace_id !== workspaceId || operation.capability_key !== 'FILE_WRITE' ||
        operation.origin !== 'RUN')
        throw resourceNotFound('File write operation');
    const pathEvidence = await repositories.fileWritePaths.readByOperation(operationId);
    const root = pathEvidence?.root_path ?? (operation.action_type === 'APPLY_CHANGESET'
        ? operation.normalized_target : dirname(operation.normalized_target));
    const changes = operation.action_type === 'APPLY_CHANGESET'
        ? operation.params.changes
        : [{ path: pathEvidence === undefined ? basename(operation.normalized_target)
                    : relative(root, operation.normalized_target),
                action: typeof operation.params.baseline_sha256 === 'string' ? 'MODIFY' : 'CREATE',
                baselineSha256: operation.params.baseline_sha256,
                content: operation.params.content }];
    const snapshots = new Map((await repositories.fileWriteDiffs.listByOperation(operationId))
        .map((row) => [row.relative_path, row]));
    return { operation_id: operationId, basis: 'FROZEN_INTENT', files: changes.map((change) => {
            const path = canonicalRelativePath(root, change.path);
            const baselineSha = change.action === 'CREATE' ? null : change.baselineSha256?.toLowerCase() ?? null;
            const targetSha = change.action === 'DELETE' ? null :
                typeof change.content === 'string' ? computeSha256(change.content) : null;
            const snapshot = snapshots.get(path);
            let reason = null;
            const before = change.action === 'CREATE' ? '' : snapshot?.baseline_text ?? null;
            const after = change.action === 'DELETE' ? '' : change.content ?? null;
            if (before === null)
                reason = snapshot?.unavailable_reason ?? 'BASELINE_UNAVAILABLE';
            else if (change.action !== 'CREATE' && (snapshot?.baseline_sha256 !== baselineSha ||
                Buffer.byteLength(before, 'utf8') > MAX_FILE_WRITE_DIFF_TEXT_BYTES ||
                computeSha256(before) !== baselineSha))
                reason = 'BASELINE_EVIDENCE_MISMATCH';
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
