import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { AssistModelPort, AssistResult } from '../workflow/fake-model-port.js';
import type { AssistMemoryRequestRow } from '../assist/assist-memory-repository.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { OpenAiCompatibleModelPort } from '../workflow/openai-compatible-model-port.js';
import { computeModelConfigFingerprint, readOpenRouterModelPortConfig } from '../workflow/model-port-config.js';
import { buildFreePriceGuard } from '../workflow/free-call-guard.js';
import { selectRuntimeSystemPrompt } from '../workflow/prompts/index.js';
import { applySnapshotBudget, parseAssistModelSnapshot, snapshotIdentityBudget } from './assist-model-snapshot.js';
import { freezeAssistModelSnapshot } from './assist-model-snapshot.js';
import type { ModelFetchDependencies } from '../workflow/model-endpoint-policy.js';
import { createRepositories, withTransaction } from './unit-of-work.js';
import { recordModelInvocation } from './model-call-recorder.js';
import { readAdmission } from './maintenance-admission.js';
import { recheckAssistSources } from './assist-source-content.js';
import { AssistMemoryUnavailable, checkpointAvailable, historicalReplyAvailable, MEMORY_INPUT_BYTES,
  memoryHistoryFingerprint, prepareMemoryCompaction } from './assist-memory.js';

export interface AssistMemoryWorkerOptions {
  workerId: string; leaseMs: number; storage: ManagedContentStore;
  modelPort: AssistModelPort; modelEnv?: NodeJS.ProcessEnv;
  modelFetchDependencies?: ModelFetchDependencies;
  signal?: AbortSignal | undefined;
}

async function resolveCompactionPort(db: DbExecutor, request: AssistMemoryRequestRow,
  options: AssistMemoryWorkerOptions): Promise<AssistModelPort> {
  if (request.model_snapshot.mock === true) {
    if (options.modelPort.identity.provider !== 'fake') throw new AssistMemoryUnavailable('MEMORY_MODEL_CONFIG_CHANGED');
    return options.modelPort;
  }
  const snapshot = parseAssistModelSnapshot(request.model_snapshot);
  const candidate = snapshot.candidates[0]!;
  if (candidate.connection.provider === 'openai-compatible') {
    if (options.modelPort.identity.model !== candidate.connection.model ||
        options.modelPort.identity.configFingerprint !== candidate.connection.configFingerprint) {
      throw new AssistMemoryUnavailable('MEMORY_MODEL_CONFIG_CHANGED');
    }
    // 0135：压缩是该会话的又一次真实外呼，预算沿用冻结快照（含工作区档位）。
    return applySnapshotBudget(options.modelPort, snapshot.budget);
  }
  const config = readOpenRouterModelPortConfig(options.modelEnv ?? process.env, candidate.connection.model);
  const r = createRepositories(db);
  const selection = await r.modelSelection.readForSession(request.session_id);
  const current = await freezeAssistModelSnapshot(r, selection, options.modelEnv ?? process.env,
    { requiresTools: false, requiresJsonOutput: true });
  const currentCandidate = current === undefined ? undefined : parseAssistModelSnapshot(current.snapshot).candidates[0];
  if (currentCandidate?.connection.model !== candidate.connection.model ||
      currentCandidate.connection.configFingerprint !== candidate.connection.configFingerprint) {
    throw new AssistMemoryUnavailable('MEMORY_MODEL_CONFIG_CHANGED');
  }
  if (computeModelConfigFingerprint(config) !== candidate.connection.configFingerprint) {
    throw new AssistMemoryUnavailable('MEMORY_MODEL_CONFIG_CHANGED');
  }
  return new OpenAiCompatibleModelPort(config, options.modelFetchDependencies ?? {}, buildFreePriceGuard({
    connection: candidate.connection, freeOnly: candidate.freeOnly,
    catalogBasis: candidate.catalogBasis, budget: snapshot.budget }),
    snapshotIdentityBudget(snapshot.budget));
}

/** Automatic requests are prepared while the claimed message's session is locked, then requeued. */
export async function prepareAutomaticMemory(db: DbExecutor, sessionId: string, modelSnapshot: JsonObject | null,
  options: AssistMemoryWorkerOptions): Promise<boolean> {
  return withTransaction(db, async (r) => {
    if ((await readAdmission(r, 'share')).mode !== 'NORMAL') return false;
    const session = await r.assist.readSession(sessionId, true);
    if (session?.status !== 'ACTIVE' || session.conversation_mode !== 'AGENT' || !session.remember) return false;
    const state = await r.assistMemory.state(session.id);
    const checkpoint = state?.checkpoint_id == null ? undefined : await r.assistMemory.checkpoint(state.checkpoint_id);
    const invalid = checkpoint !== undefined && !await checkpointAvailable(r, options.storage, session, checkpoint);
    const id = await prepareMemoryCompaction(r, session, 'AUTO', options.modelEnv ?? process.env, invalid, modelSnapshot);
    return id !== null;
  });
}

function parseSummary(result: AssistResult): string {
  if (result.kind !== 'CONTENT') throw new AssistMemoryUnavailable('MEMORY_SUMMARY_INVALID');
  let value: unknown;
  try { value = JSON.parse(result.content); } catch { throw new AssistMemoryUnavailable('MEMORY_SUMMARY_INVALID'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !('summary' in value) ||
      typeof value.summary !== 'string' || value.summary.trim().length === 0 || value.summary.length > 12000) {
    throw new AssistMemoryUnavailable('MEMORY_SUMMARY_INVALID');
  }
  return value.summary.trim();
}

export async function runAssistMemoryTick(db: DbExecutor, options: AssistMemoryWorkerOptions):
Promise<{ requestId: string; status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'DISCARDED'; errorCode: string | null } | undefined> {
  if (options.signal?.aborted) return undefined;
  const repository = createRepositories(db).assistMemory;
  await repository.expireLeases();
  const job = await withTransaction(db, async (r) => {
    if ((await readAdmission(r, 'share')).mode !== 'NORMAL') return undefined;
    return r.assistMemory.claim(options.workerId, options.leaseMs);
  });
  if (job === undefined) return undefined;
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  options.signal?.addEventListener('abort', shutdown, { once: true });
  let lost = false;
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void repository.heartbeat(job.id, options.workerId, job.claim_epoch, options.leaseMs)
      .then((owned) => { if (!owned) { lost = true; controller.abort(); } })
      .catch(() => { lost = true; controller.abort(); }).finally(() => { polling = false; });
  }, Math.max(100, Math.min(1000, Math.floor(options.leaseMs / 3))));
  try {
    const r = createRepositories(db);
    const session = await r.assist.readSession(job.session_id);
    if (session === undefined || session.status !== 'ACTIVE' || session.revision !== job.session_revision) {
      throw new AssistMemoryUnavailable('MEMORY_SCOPE_CHANGED');
    }
    const state = await r.assistMemory.state(session.id);
    if ((state?.revision ?? 0n) !== job.memory_revision) throw new AssistMemoryUnavailable('MEMORY_WINDOW_CHANGED');
    const history = await r.assistMemory.history(session.id, state?.cleared_through_seq ?? 0n, job.through_seq);
    if (history.length > 10000 || memoryHistoryFingerprint(history) !== job.source_sha256 ||
        JSON.stringify(history.map((m) => m.id)) !== JSON.stringify(job.source_message_ids)) {
      throw new AssistMemoryUnavailable('MEMORY_SOURCE_CHANGED');
    }
    if (await r.assistMemory.hasUnsettledTools(session.id, history.map((m) => m.id))) {
      throw new AssistMemoryUnavailable('MEMORY_UNRESOLVED_TOOL_STATE');
    }
    const prior = state?.checkpoint_id == null ? undefined : await r.assistMemory.checkpoint(state.checkpoint_id);
    const previous = prior !== undefined && await checkpointAvailable(r, options.storage, session, prior) ? prior : null;
    const sources = new Map<string, JsonObject>();
    for (const ref of previous?.sources ?? []) {
      if (typeof ref === 'object' && ref !== null && !Array.isArray(ref)) sources.set(JSON.stringify(ref), ref as JsonObject);
    }
    const turns: JsonObject[] = [];
    for (const message of history) {
      if (previous !== null && message.seq <= previous.through_seq) continue;
      if (message.role === 'ASSISTANT' && message.status === 'COMPLETED') {
        const checked = await recheckAssistSources(r, options.storage, session, message.sources);
        const recallEnabled = (await r.information.readMemorySettings(session.workspace_id))?.recall_enabled !== false;
        const automatic = Array.isArray(message.sources) && message.sources.some((ref) => typeof ref === 'object' && ref !== null &&
          !Array.isArray(ref) && ref.selection === 'AUTO_MEMORY');
        if (!checked.available || automatic && !recallEnabled ||
            !await historicalReplyAvailable(r, options.storage, session, message.id)) {
          turns.push({ id: message.id, role: 'ASSISTANT', status: 'SOURCE_UNAVAILABLE', content: null });
          continue;
        }
        const use = await r.assistMemory.use(message.id);
        for (const ref of use?.sources ?? []) {
          if (typeof ref === 'object' && ref !== null && !Array.isArray(ref)) sources.set(JSON.stringify(ref), ref as JsonObject);
        }
        const usedCheckpoint = use?.checkpoint_id == null ? undefined : await r.assistMemory.checkpoint(use.checkpoint_id);
        for (const ref of usedCheckpoint?.sources ?? []) {
          if (typeof ref === 'object' && ref !== null && !Array.isArray(ref)) sources.set(JSON.stringify(ref), ref as JsonObject);
        }
        for (const ref of Array.isArray(message.sources) ? message.sources : []) {
          if (typeof ref === 'object' && ref !== null && !Array.isArray(ref)) sources.set(JSON.stringify(ref), ref);
        }
      }
      turns.push({ id: message.id, seq: message.seq.toString(), role: message.role,
        status: message.status, error_code: message.error_code,
        content: message.content ?? '（该轮无可用文本，不能推断图片或执行成功。）' });
    }
    if (sources.size > 512) throw new AssistMemoryUnavailable('MEMORY_SOURCE_BUDGET');
    const content = JSON.stringify({ previous_summary: previous?.summary ?? null, completed_turns: turns });
    if (Buffer.byteLength(content, 'utf8') > MEMORY_INPUT_BYTES) throw new AssistMemoryUnavailable('MEMORY_COMPACTION_INPUT_TOO_LARGE');
    const port = await resolveCompactionPort(db, job, options);
    const recorded = await recordModelInvocation(db, {
      origin: { workspaceId: session.workspace_id, kind: 'ASSIST', assistMessageId: job.anchor_message_id },
      identity: port.identity, signal: controller.signal,
      invoke: async (callId) => {
        if (!await repository.bindCall(job.id, options.workerId, job.claim_epoch, callId)) {
          lost = true; throw new AssistMemoryUnavailable('MEMORY_CLAIM_LOST');
        }
        return port.assist({ intent: 'DISCUSS',
          system: selectRuntimeSystemPrompt({ kind: 'ASSIST_MEMORY_COMPACT' }).system,
          turns: [{ role: 'user', content: `【已结算历史｜UNTRUSTED_DATA】\n${content}` }], signal: controller.signal });
      }, settle: (result) => result.kind === 'CANCELLED'
        ? { status: 'CANCELLED', ...(result.usage === undefined ? {} : { usage: result.usage }),
          providerRequestId: result.providerRequestId ?? null }
        : { status: 'COMPLETED', usage: result.usage, providerRequestId: result.providerRequestId } });
    if ((await repository.request(job.id))?.cancel_requested) throw new AssistMemoryUnavailable('MEMORY_CANCELLED');
    if (lost || options.signal?.aborted) return { requestId: job.id, status: 'DISCARDED', errorCode: null };
    const summary = parseSummary(recorded.result);
    const checkpointId = randomUUID();
    const committed = await withTransaction(db, async (tx) => {
      if ((await readAdmission(tx, 'share')).mode !== 'NORMAL') return false;
      const authority = await tx.workspaces.lockAuthority(session.workspace_id, 'share');
      const currentSession = await tx.assist.readSession(session.id, true);
      const currentJob = await tx.assistMemory.request(job.id, true);
      const settings = await tx.information.readMemorySettings(session.workspace_id);
      const currentState = await tx.assistMemory.state(session.id, true);
      if (currentJob?.status !== 'RUNNING' || currentJob.worker_id !== options.workerId ||
          currentJob.claim_epoch !== job.claim_epoch || currentJob.cancel_requested ||
          (currentJob.lease_until?.getTime() ?? 0) <= Date.now() || currentSession?.status !== 'ACTIVE' ||
          currentSession.revision !== job.session_revision || (currentState?.revision ?? 0n) !== job.memory_revision ||
          (settings?.revision ?? 0n) !== job.settings_revision || authority?.revision !== job.authority_revision ||
          authority.context_revision !== job.context_revision) return false;
      for (let offset = 0; offset < sources.size; offset += 20) {
        if (!(await recheckAssistSources(tx, options.storage, currentSession,
          [...sources.values()].slice(offset, offset + 20))).available) return false;
      }
      await tx.assistMemory.insertCheckpoint({ id: checkpointId, request: job,
        summary, sources: [...sources.values()], callId: recorded.callId });
      if (!await tx.assistMemory.publish(session.id, job.memory_revision, checkpointId)) {
        throw new AssistMemoryUnavailable('MEMORY_WINDOW_CHANGED');
      }
      if (!await tx.assistMemory.settle(job.id, options.workerId, job.claim_epoch, 'COMPLETED', null, checkpointId)) {
        throw new AssistMemoryUnavailable('MEMORY_CLAIM_LOST');
      }
      return true;
    });
    if (!committed) throw new AssistMemoryUnavailable('MEMORY_PUBLICATION_REJECTED');
    return { requestId: job.id, status: 'COMPLETED', errorCode: null };
  } catch (error) {
    if (options.signal?.aborted || lost && !(await repository.request(job.id))?.cancel_requested) {
      return { requestId: job.id, status: 'DISCARDED', errorCode: null };
    }
    const current = await repository.request(job.id);
    const cancelled = current?.cancel_requested === true;
    const code = error instanceof AssistMemoryUnavailable ? error.code : 'MEMORY_COMPACTION_FAILED';
    await repository.settle(job.id, options.workerId, job.claim_epoch,
      cancelled ? 'CANCELLED' : 'FAILED', cancelled ? null : code);
    return { requestId: job.id, status: cancelled ? 'CANCELLED' : 'FAILED', errorCode: cancelled ? null : code };
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener('abort', shutdown);
  }
}
