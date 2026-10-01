import { createHash, randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ImportJobRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import { DomainError } from './domain-error.js';
import { dispatchGatewayAction, prepareGatewayAction, type GatewayOrigin } from './gateway-actions.js';
import { withTransaction, type Repositories } from './unit-of-work.js';
import { lockWritableProjectInWorkspace } from './guards.js';
import { readAdmission } from './maintenance-admission.js';

const TEXT_OCTET_LIMIT = 262144;

/** Prepare 在事务内整体回滚，这些拒绝意味着重新准备也不会成功：导入 job 终态 FAILED。 */
const TERMINAL_PREPARE_CODES: readonly string[] = [
  'GATEWAY_ORIGIN_DENIED', 'GATEWAY_TARGET_DENIED', 'GATEWAY_CONNECTION_DENIED', 'GATEWAY_CONNECTION_STALE',
  'GATEWAY_PERMISSION_DENIED', 'GATEWAY_PERMISSION_STALE', 'GATEWAY_IMPORT_STALE',
  'GATEWAY_PROJECT_REQUIRED', 'GATEWAY_APPROVAL_ID_CONFLICT',
];

/** 其他 tick 或人工路径正在处理同一 job/operation；跳过不重试。 */
const RACE_SKIP_CODES: readonly string[] = ['GATEWAY_OPERATION_SETTLED', 'GATEWAY_INVOCATION_STALE'];

export interface WebImportTickResult {
  prepared: number;
  dispatched: number;
  succeeded: number;
  failed: number;
}

/** Worker 后台 tick：把 WEB_FETCH 导入 job 从 QUEUED 驱动到 Knowledge 落库。
 * 网关意图 `web-import-{jobId}` 幂等；批准占用、控制撤销与幂等结算沿用 Gateway
 * 既有栅栏。USER_IMPORT 只读无副作用，结算不会产生 UNKNOWN。 */
export async function runWebImportTick(db: DbExecutor, input: {
  signal?: AbortSignal;
  maxJobs?: number;
} = {}): Promise<WebImportTickResult> {
  const result: WebImportTickResult = { prepared: 0, dispatched: 0, succeeded: 0, failed: 0 };
  // Phase A: prepare new jobs and RUNNING jobs left without an operation by a
  // crash after the status change. No network work happens in the claim txn.
  const claimed = await withTransaction(db, async (repositories) => {
    if ((await readAdmission(repositories, 'share')).mode !== 'NORMAL') return [];
    const jobs = await repositories.gateway.claimImportJobsNeedingPrepare(input.maxJobs ?? 10);
    const claimedJobs: ImportJobRow[] = [];
    for (const job of jobs) {
      await lockWritableProjectInWorkspace(repositories, job.workspace_id, job.project_id);
      claimedJobs.push(job.status === 'QUEUED'
        ? await repositories.gateway.setImportJobStatus(job.id, 'RUNNING', null) : job);
    }
    return claimedJobs;
  });
  for (const job of claimed) {
    if (input.signal?.aborted) break;
    const origin: GatewayOrigin = { kind: 'USER_IMPORT', importJobId: job.id,
      actorRef: job.actor_ref, configVersion: job.config_version };
    try {
      // An already prepared operation may predate this recovery path. Otherwise
      // derive one stable ID from the job so concurrent ticks cannot mint a new
      // action identity while preparing the same intent.
      const existing = await withTransaction(db, (repositories) =>
        repositories.gateway.findOperationByIntent({ importJobId: job.id,
          intentKey: `web-import-${job.id}` }));
      const prepared = await prepareGatewayAction(db, {
        workspaceId: job.workspace_id, operationId: existing?.id ?? webImportOperationId(job.id),
        intentKey: `web-import-${job.id}`, connectionId: job.connection_id!,
        origin, actionType: 'WEB_FETCH', target: job.source_uri, params: {},
      });
      result.prepared += 1;
      if (prepared.status === 'WAITING_APPROVAL') continue;
    } catch (error) {
      if (!(error instanceof DomainError) || !TERMINAL_PREPARE_CODES.includes(error.code)) {
        // Transient infrastructure failure rolled back the whole prepare: requeue
        // the job so a later tick retries, and surface the error to the supervisor.
        await withTransaction(db, async (repositories) => {
          const current = await repositories.gateway.lockImportJob(job.id);
          if (current !== undefined) await lockWritableProjectInWorkspace(repositories, current.workspace_id, current.project_id);
          if (current?.status === 'RUNNING') {
            await repositories.gateway.setImportJobStatus(job.id, 'QUEUED', null);
          }
        });
        throw error;
      }
      await withTransaction(db, async (repositories) => {
        const current = await repositories.gateway.lockImportJob(job.id);
        if (current !== undefined) await lockWritableProjectInWorkspace(repositories, current.workspace_id, current.project_id);
        if (current?.status === 'RUNNING') {
          await repositories.gateway.settleImportJob(job.id, 'FAILED', error.code);
        }
      });
      result.failed += 1;
    }
  }

  // Phase B: drive RUNNING jobs — dispatch approved/prepared operations and
  // settle Knowledge for already-executed ones (crash between phases).
  const runnable = await withTransaction(db,
    (repositories) => repositories.gateway.listRunnableImportJobIds());
  for (const { job_id, operation_id } of runnable) {
    if (input.signal?.aborted) break;
    const job = await withTransaction(db, (repositories) => repositories.gateway.readImportJob(job_id));
    const operation = await withTransaction(db, (repositories) => repositories.gateway.readOperation(operation_id));
    if (job === undefined || job.status !== 'RUNNING' || operation === undefined) continue;
    const origin: GatewayOrigin = { kind: 'USER_IMPORT', importJobId: job.id,
      actorRef: job.actor_ref, configVersion: job.config_version };
    if (operation.status === 'SUCCEEDED') {
      const settled = await settleImportSuccess(db, job.id, operation.id);
      result.succeeded += settled;
      if (settled === 0) result.failed += 1;
      continue;
    }
    if (operation.status === 'FAILED') {
      const reason = typeof operation.result_ref?.reason === 'string'
        ? operation.result_ref.reason : 'WEB_IMPORT_FAILED';
      await withTransaction(db, async (repositories) => {
        const current = await repositories.gateway.lockImportJob(job.id);
        if (current !== undefined) await lockWritableProjectInWorkspace(repositories, current.workspace_id, current.project_id);
        if (current?.status === 'RUNNING') {
          await repositories.gateway.settleImportJob(job.id, 'FAILED', reason);
        }
      });
      result.failed += 1;
      continue;
    }
    if (operation.status !== 'PREPARED' && operation.status !== 'WAITING_APPROVAL') continue;
    try {
      const dispatched = await dispatchGatewayAction(db, {
        workspaceId: job.workspace_id, operationId: operation.id, origin,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      result.dispatched += 1;
      if (dispatched.status === 'SUCCEEDED') {
        const settled = await settleImportSuccess(db, job.id, operation.id);
        result.succeeded += settled;
        if (settled === 0) result.failed += 1;
      } else if (dispatched.status === 'FAILED') {
        const reason = typeof dispatched.result_ref?.reason === 'string'
          ? dispatched.result_ref.reason : 'WEB_IMPORT_FAILED';
        await withTransaction(db, async (repositories) => {
          const current = await repositories.gateway.lockImportJob(job.id);
          if (current !== undefined) await lockWritableProjectInWorkspace(repositories, current.workspace_id, current.project_id);
          if (current?.status === 'RUNNING') {
            await repositories.gateway.settleImportJob(job.id, 'FAILED', reason);
          }
        });
        result.failed += 1;
      }
      // UNKNOWN cannot occur for USER_IMPORT reads; any other status is left for the next tick.
    } catch (error) {
      if (error instanceof DomainError && RACE_SKIP_CODES.includes(error.code)) continue;
      // An open ASK review is the durable wait state; the next tick re-dispatches.
      if (error instanceof DomainError && error.code === 'GATEWAY_APPROVAL_REQUIRED') continue;
      throw error;
    }
  }
  return result;
}

interface WebEvidence {
  readonly url: string; readonly final_url: string; readonly status: number;
  readonly content_type: string; readonly bytes: number; readonly sha256: string;
  readonly fetched_at: string; readonly extractor: string | null;
  readonly content: string | null; readonly text_available: boolean;
  readonly operation_id: string;
}

function readWebEvidence(resultRef: JsonObject | null): WebEvidence | undefined {
  if (resultRef === null) return undefined;
  const shape = { url: resultRef.url, final_url: resultRef.final_url, status: resultRef.status,
    content_type: resultRef.content_type, bytes: resultRef.bytes, sha256: resultRef.sha256,
    fetched_at: resultRef.fetched_at, extractor: resultRef.extractor, content: resultRef.content,
    text_available: resultRef.text_available, operation_id: resultRef.operation_id };
  if (typeof shape.url !== 'string' || typeof shape.final_url !== 'string' ||
      typeof shape.status !== 'number' || typeof shape.content_type !== 'string' ||
      typeof shape.bytes !== 'number' || typeof shape.sha256 !== 'string' ||
      typeof shape.fetched_at !== 'string' || typeof shape.text_available !== 'boolean' ||
      typeof shape.operation_id !== 'string' ||
      !(shape.extractor === null || typeof shape.extractor === 'string') ||
      !(shape.content === null || typeof shape.content === 'string')) {
    return undefined;
  }
  return shape as WebEvidence;
}

/** Knowledge 版本与 job SUCCEEDED 原子提交；job 行锁串行化重复结算。
 * 返回值计入 tick 统计：1 = 落库（或已在早前会话落库），0 = 页面无可提取正文按 FAILED 收敛。 */
async function settleImportSuccess(db: DbExecutor, jobId: string, operationId: string): Promise<number> {
  return withTransaction(db, async (repositories: Repositories) => {
    const job = await repositories.gateway.lockImportJob(jobId);
    if (job === undefined || job.status !== 'RUNNING') return 1;
    await lockWritableProjectInWorkspace(repositories, job.workspace_id, job.project_id);
    if (job.knowledge_version_id !== null) return 1;
    const operation = await repositories.gateway.lockOperation(operationId);
    if (operation?.status !== 'SUCCEEDED' || operation.result_ref === null) {
      throw new Error('import settle has no succeeded operation evidence');
    }
    const evidence = readWebEvidence(operation.result_ref);
    if (evidence === undefined || evidence.content === null || !evidence.text_available) {
      // The page has no extractable text; the fetch itself succeeded but the
      // import goal (a readable Knowledge version) cannot complete.
      await repositories.gateway.settleImportJob(job.id, 'FAILED', 'WEB_TEXT_UNAVAILABLE');
      return 0;
    }
    const stored = fitTextOctets(evidence.content, TEXT_OCTET_LIMIT);
    const mediaType = evidence.content_type === 'text/markdown' ? 'text/markdown' : 'text/plain';
    const knowledgeId = randomUUID();
    const versionId = randomUUID();
    await repositories.information.insertKnowledgeRoot(knowledgeId, job.workspace_id,
      job.project_id, evidence.url);
    await repositories.information.insertKnowledgeVersion({ id: versionId,
      workspaceId: job.workspace_id, knowledgeId, projectId: job.project_id, version: 1n,
      sourceKind: 'WEB_PAGE', mediaType, text: stored.text,
      hash: createHash('sha256').update(stored.text, 'utf8').digest(),
      artifactId: null, artifactVersionId: null, sourceUri: evidence.url,
      sourceRefs: { url: evidence.url, final_url: evidence.final_url, status: evidence.status,
        content_type: evidence.content_type, bytes: evidence.bytes,
        body_sha256: evidence.sha256, fetched_at: evidence.fetched_at,
        ...(evidence.extractor === null ? {} : { extractor: evidence.extractor }),
        truncated: stored.truncated, operation_id: operation.id, import_job_id: job.id } });
    await repositories.workspaces.bumpContextRevision(job.workspace_id);
    await repositories.gateway.settleImportJob(job.id, 'SUCCEEDED', null, versionId);
    return 1;
  });
}

function fitTextOctets(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= limit) return { text, truncated: false };
  // Cut on a code-point boundary so the stored text stays valid UTF-8.
  let end = text.length;
  while (Buffer.byteLength(text.slice(0, end), 'utf8') > limit) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function webImportOperationId(jobId: string): string {
  const bytes = createHash('sha1').update('relay-web-import-v1:').update(jobId).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
