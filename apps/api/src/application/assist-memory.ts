import { randomUUID } from 'node:crypto';
import type { AssistMessageRow, AssistSessionRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import type { AssistMemoryCheckpointRow } from '../assist/assist-memory-repository.js';
import { computePayloadHash } from '../receipt/payload-hash.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand } from './command.js';
import { DomainError, invalidTransition, resourceNotFound, revisionConflict } from './domain-error.js';
import { lockWritableProjectInWorkspace } from './guards.js';
import { requireRevision } from './revisions.js';
import { createRepositories, type Repositories } from './unit-of-work.js';
import { freezeAssistModelSnapshot, parseAssistModelSnapshot } from './assist-model-snapshot.js';
import { recheckAssistSources } from './assist-source-content.js';

export const MEMORY_RECENT_MESSAGES = 8;
export const MEMORY_AUTO_MESSAGES = 32;
export const MEMORY_AUTO_BYTES = 48000;
export const MEMORY_INPUT_BYTES = 128000;
export const MEMORY_BATCH_MESSAGES = 1000;

export function memoryCompactionTurn(message: AssistMessageRow): JsonObject {
  return { id: message.id, seq: message.seq.toString(), role: message.role,
    status: message.withdrawn_at === null ? message.status : 'WITHDRAWN', error_code: message.error_code,
    content: message.withdrawn_at === null
      ? message.content ?? '（该轮无可用文本，不能推断图片或执行成功。）' : null };
}

/** Same UTF-8 / 3 estimate as the model port; reserve 25% for prompts, tools and output. */
export function memoryContextLimits(callTokens: number | null) {
  if (callTokens === null) return { inputBytes: MEMORY_INPUT_BYTES, autoBytes: MEMORY_AUTO_BYTES,
    autoMessages: MEMORY_AUTO_MESSAGES };
  const inputBytes = Math.floor(callTokens * 0.75) * 3;
  return { inputBytes, autoBytes: Math.floor(inputBytes * 0.8), autoMessages: null };
}

export async function resolveMemoryContextLimits(r: Repositories, workspaceId: string,
  snapshot?: JsonObject | null, sessionId?: string) {
  // MEMORY_CONTEXT_TIERS: real calls use the frozen effective budget, including provider caps.
  // 0145：没有冻结快照时（Mock 轮次、老调用）按**会话自己的档位**估算，会话读不到才退回
  // 工作区默认——否则「会话选了 1M，压缩阈值仍按工作区 256K」会让整理比实际需要更早发生。
  const tokens = snapshot != null && snapshot.mock !== true
    ? parseAssistModelSnapshot(snapshot).budget.callReservationTokens
    : (sessionId === undefined ? undefined
      : (await r.assist.readSession(sessionId))?.context_budget_tokens)
      ?? (await r.workspaces.readDefaultDirectory(workspaceId))?.context_budget_tokens ?? null;
  return memoryContextLimits(tokens);
}

export class AssistMemoryUnavailable extends DomainError {
  constructor(code: string) { super({ code, status: 409, type: '/problems/memory-context-unavailable',
    title: '短期记忆需要处理', detail: code, retryable: false, retryAction: 'REFRESH_AND_REDECIDE' }); }
}

export function memoryHistoryFingerprint(messages: readonly AssistMessageRow[]): string {
  return computePayloadHash({ commandType: 'MEMORY_HISTORY_V1', target: null,
    body: messages.map((m) => ({ id: m.id, seq: m.seq.toString(), role: m.role,
      status: m.status, error_code: m.error_code, content: m.content, sources: m.sources })) }).toString('hex');
}

export async function checkpointAvailable(r: Repositories, storage: ManagedContentStore,
  session: AssistSessionRow, checkpoint: AssistMemoryCheckpointRow): Promise<boolean> {
  const authority = await r.workspaces.readAuthority(session.workspace_id);
  if (authority === undefined || checkpoint.session_id !== session.id || checkpoint.workspace_id !== session.workspace_id ||
      checkpoint.session_revision !== session.revision ||
      checkpoint.authority_revision !== authority.revision ||
      checkpoint.context_revision !== authority.context_revision) return false;
  const settings = await r.information.readMemorySettings(session.workspace_id);
  if (settings?.recall_enabled === false && checkpoint.sources.some((source) =>
      typeof source === 'object' && source !== null && !Array.isArray(source) &&
      (source as JsonObject).selection === 'AUTO_MEMORY')) return false;
  for (let offset = 0; offset < checkpoint.sources.length; offset += 20) {
    if (!(await recheckAssistSources(r, storage, session, checkpoint.sources.slice(offset, offset + 20))).available) return false;
  }
  return true;
}

/** A historical reply can carry data derived from a prior checkpoint or tool grant. */
export async function historicalReplyAvailable(r: Repositories, storage: ManagedContentStore,
  session: AssistSessionRow, messageId: string): Promise<boolean> {
  const use = await r.assistMemory.use(messageId);
  if (use !== undefined) {
    const recallEnabled = (await r.information.readMemorySettings(session.workspace_id))?.recall_enabled !== false;
    for (let offset = 0; offset < use.sources.length; offset += 20) {
      if (!(await recheckAssistSources(r, storage, session, use.sources.slice(offset, offset + 20))).available) return false;
    }
    if (!recallEnabled && use.sources.some((source) => typeof source === 'object' && source !== null &&
      !Array.isArray(source) && (source as JsonObject).selection === 'AUTO_MEMORY')) return false;
  }
  const authority = await r.workspaces.readAuthority(session.workspace_id);
  if ((use?.has_tool_context || (await r.assistMemory.messagesWithTools(session.id)).includes(messageId)) &&
      (use === undefined || use.authority_revision !== authority?.revision ||
       use.session_scope?.project_id !== session.project_id || use.session_scope?.task_id !== session.task_id ||
       use.session_scope?.working_resource_id !== session.working_resource_id)) return false;
  if (use?.checkpoint_id != null) {
    const checkpoint = await r.assistMemory.checkpoint(use.checkpoint_id);
    if (checkpoint === undefined || !await checkpointAvailable(r, storage, session, checkpoint)) return false;
  }
  return true;
}

/** A committed checkpoint plus exact subsequent original messages, never a last-N substitute. */
export async function readWorkingMemory(r: Repositories, storage: ManagedContentStore,
  session: AssistSessionRow, throughSeq: bigint, snapshot?: JsonObject | null): Promise<{ history: readonly AssistMessageRow[];
    checkpoint: AssistMemoryCheckpointRow | null; revision: bigint; inputByteLimit: number }> {
  const state = await r.assistMemory.state(session.id);
  const prior = state?.checkpoint_id == null ? null : await r.assistMemory.checkpoint(state.checkpoint_id) ?? null;
  const checkpoint = session.remember && prior !== null && await checkpointAvailable(r, storage, session, prior) ? prior : null;
  const floor = session.remember ? checkpoint?.through_seq ?? state?.cleared_through_seq ?? 0n : throughSeq - 2n;
  let history = await r.assistMemory.history(session.id, floor, throughSeq);
  if (history.length > 10000) throw new AssistMemoryUnavailable('MEMORY_HISTORY_LIMIT');
  if (!session.remember) history = history.filter((m) => m.role === 'USER').slice(-1);
  const bytes = history.reduce((sum, m) => sum + Buffer.byteLength(m.content ?? '', 'utf8'),
    Buffer.byteLength(checkpoint?.summary ?? '', 'utf8'));
  const limits = await resolveMemoryContextLimits(r, session.workspace_id, snapshot, session.id);
  if (bytes > limits.inputBytes) throw new AssistMemoryUnavailable('MEMORY_CONTEXT_TOO_LARGE');
  return { history, checkpoint, revision: state?.revision ?? 0n, inputByteLimit: limits.inputBytes };
}

async function lockedMemorySession(r: Repositories, workspaceId: string, sessionId: string) {
  const session = await r.assist.readSession(sessionId, true);
  if (session?.workspace_id !== workspaceId) throw resourceNotFound('Assist session');
  return session;
}

async function requireWritableMemorySession(r: Repositories, session: AssistSessionRow) {
  if (session.status !== 'ACTIVE' || session.conversation_mode !== 'AGENT') {
    throw invalidTransition('仅有效的普通 Agent 会话支持短期记忆控制。');
  }
  if (session.project_id !== null) await lockWritableProjectInWorkspace(r, session.workspace_id, session.project_id);
}

export async function prepareMemoryCompaction(r: Repositories, session: AssistSessionRow,
  reason: 'MANUAL' | 'AUTO', env: NodeJS.ProcessEnv, forceRebuild = false,
  modelSnapshot?: JsonObject | null, projectedInputBytes = 0): Promise<string | null> {
  const existing = await r.assistMemory.activeRequest(session.id);
  if (existing !== undefined) return existing.id;
  const settings = await r.information.readMemorySettings(session.workspace_id);
  if (!session.remember || reason === 'AUTO' && settings?.automatic_compaction === false) return null;
  const state = await r.assistMemory.state(session.id);
  const checkpoint = state?.checkpoint_id == null ? null : await r.assistMemory.checkpoint(state.checkpoint_id) ?? null;
  // MEMORY_BATCH_CURSOR: scan only the active prefix; completed batches are linked by checkpoint.
  const after = forceRebuild ? state?.cleared_through_seq ?? 0n
    : checkpoint?.through_seq ?? state?.cleared_through_seq ?? 0n;
  const history = await r.assistMemory.history(session.id, after, undefined, MEMORY_BATCH_MESSAGES + 1);
  const delta = history;
  const selection = await r.modelSelection.readForSession(session.id);
  const frozen = modelSnapshot === undefined ? await freezeAssistModelSnapshot(r, selection, env,
    { requiresTools: false, requiresJsonOutput: true },
    { workspaceId: session.workspace_id, sessionId: session.id }) : undefined;
  const snapshot = modelSnapshot ?? frozen?.snapshot ?? { mock: true };
  const limits = await resolveMemoryContextLimits(r, session.workspace_id, snapshot, session.id);
  const bytes = delta.reduce((sum, m) => sum + Buffer.byteLength(m.content ?? '', 'utf8'),
    forceRebuild ? 0 : Buffer.byteLength(checkpoint?.summary ?? '', 'utf8'));
  if (reason === 'AUTO' && history.length <= MEMORY_BATCH_MESSAGES &&
      Math.max(bytes, projectedInputBytes) < limits.autoBytes &&
      (limits.autoMessages === null || delta.length < limits.autoMessages)) return null;
  const candidates = delta.slice(0, -MEMORY_RECENT_MESSAGES);
  const summary = forceRebuild ? null : checkpoint?.summary ?? null;
  let inputBytes = Buffer.byteLength(JSON.stringify({ previous_summary: summary, completed_turns: [] }), 'utf8');
  let anchor: AssistMessageRow | undefined;
  for (const candidate of candidates) {
    inputBytes += Buffer.byteLength(JSON.stringify(memoryCompactionTurn(candidate)), 'utf8') + 1;
    if (inputBytes > Math.floor(limits.inputBytes * 0.95)) break;
    if (candidate.role === 'ASSISTANT' && candidate.status === 'COMPLETED') anchor = candidate;
  }
  if (anchor === undefined) {
    if (candidates.length > 0 && inputBytes > Math.floor(limits.inputBytes * 0.95)) {
      throw new AssistMemoryUnavailable('MEMORY_COMPACTION_INPUT_TOO_LARGE');
    }
    return null;
  }
  // A failed automatic request is retried only after history advances or explicit manual action.
  const latest = (await r.assistMemory.requests(session.id))[0];
  if (reason === 'AUTO' && latest?.reason === 'AUTO' && latest.through_seq >= anchor.seq &&
      latest.status !== 'COMPLETED') return null;
  const covered = history.filter((m) => m.seq <= anchor.seq);
  const authority = await r.workspaces.readAuthority(session.workspace_id);
  if (authority === undefined) throw resourceNotFound('Workspace authority');
  const id = randomUUID();
  await r.assistMemory.insertRequest({ id, workspaceId: session.workspace_id, sessionId: session.id,
    sessionRevision: session.revision, memoryRevision: state?.revision ?? 0n,
    authorityRevision: authority.revision, contextRevision: authority.context_revision,
    settingsRevision: settings?.revision ?? 0n, throughSeq: anchor.seq, anchorMessageId: anchor.id,
    sourceMessageIds: covered.map((m) => m.id), sourceSha256: memoryHistoryFingerprint(covered),
    modelSnapshot: { ...snapshot, memory_compaction: { after_seq: after.toString(),
      base_checkpoint_id: forceRebuild ? null : checkpoint?.id ?? null } }, reason });
  return id;
}

export async function requestMemoryCompaction(db: DbExecutor, input: { workspaceId: string;
  sessionId: string; commandId: string; expectedRevision?: string }, storage: ManagedContentStore,
  env: NodeJS.ProcessEnv = process.env) {
  const expected = input.expectedRevision === undefined ? null : requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<JsonObject>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'RequestMemoryCompaction', target: { session_id: input.sessionId },
    body: { expected_revision: expected?.toString() ?? null }, execute: async (r) => {
      const session = await lockedMemorySession(r, input.workspaceId, input.sessionId);
      const prior = await r.receipts.findReceipt({ scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId });
      if (prior !== undefined) return prior.result_ref;
      await requireWritableMemorySession(r, session);
      if (expected !== null && session.revision !== expected) throw revisionConflict({ entityType: 'ASSIST_SESSION',
        expectedRevision: expected.toString(), actualRevision: session.revision.toString() });
      if (await r.assist.hasInflightMessages(session.id)) throw invalidTransition('请先停止或等待在途消息，再手动整理记忆。');
      const state = await r.assistMemory.state(session.id);
      const checkpoint = state?.checkpoint_id == null ? undefined : await r.assistMemory.checkpoint(state.checkpoint_id);
      const invalid = checkpoint !== undefined && !await checkpointAvailable(r, storage, session, checkpoint);
      const id = await prepareMemoryCompaction(r, session, 'MANUAL', env, invalid);
      if (id === null) throw invalidTransition('尚无足够的已完成轮次可整理；近期原文将保持。');
      return { session_id: session.id, request_id: id, status: 'PENDING' };
    } });
}

export async function resetSessionMemory(db: DbExecutor, input: { workspaceId: string; sessionId: string;
  commandId: string; expectedRevision: string; expectedSessionRevision: string; remember?: boolean }) {
  const expected = requireRevision(input.expectedRevision, 'expected_revision');
  const sessionExpected = requireRevision(input.expectedSessionRevision, 'expected_session_revision');
  return runIdempotentCommand<JsonObject>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: input.remember === undefined ? 'ClearSessionMemory' : 'SetSessionMemory',
    target: { session_id: input.sessionId }, body: { expected_revision: expected.toString(),
      expected_session_revision: sessionExpected.toString(), remember: input.remember ?? null }, execute: async (r) => {
      const session = await lockedMemorySession(r, input.workspaceId, input.sessionId);
      const prior = await r.receipts.findReceipt({ scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId });
      if (prior !== undefined) return prior.result_ref;
      await requireWritableMemorySession(r, session);
      const state = await r.assistMemory.state(session.id, true);
      if ((state?.revision ?? 0n) !== expected || session.revision !== sessionExpected) {
        throw revisionConflict({ entityType: 'SESSION_MEMORY', expectedRevision: expected.toString(),
          actualRevision: (state?.revision ?? 0n).toString() });
      }
      if (await r.assist.hasInflightMessages(session.id) || await r.assistMemory.activeRequest(session.id) !== undefined) {
        throw invalidTransition('存在在途消息或记忆整理；先取消或等待安全结束，再清除工作窗口。');
      }
      const saved = await r.assistMemory.reset(session.id, await r.assistMemory.latestHistorySeq(session.id));
      if (input.remember !== undefined && input.remember !== session.remember) await r.assistMemory.setRemember(session.id, input.remember);
      return { session_id: session.id, revision: saved.revision.toString(),
        session_revision: (session.revision + (input.remember !== undefined && input.remember !== session.remember ? 1n : 0n)).toString(),
        remember: input.remember ?? session.remember, cleared_through_seq: saved.cleared_through_seq.toString() };
    } });
}

export async function cancelMemoryCompaction(db: DbExecutor, input: { workspaceId: string;
  sessionId: string; requestId: string; commandId: string }) {
  return runIdempotentCommand<JsonObject>(db, { scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId, commandType: 'CancelMemoryCompaction',
    target: { session_id: input.sessionId, request_id: input.requestId }, body: {}, execute: async (r) => {
      const session = await lockedMemorySession(r, input.workspaceId, input.sessionId);
      const job = await r.assistMemory.request(input.requestId, true);
      if (job?.session_id !== session.id) throw resourceNotFound('Memory request');
      await r.assistMemory.cancel(job.id);
      return { session_id: session.id, request_id: job.id,
        status: job.status === 'PENDING' ? 'CANCELLED' : job.status,
        cancel_requested: job.status === 'RUNNING' || job.cancel_requested };
    } });
}

export async function readSessionMemory(db: DbExecutor, storage: ManagedContentStore,
  workspaceId: string, sessionId: string) {
  const r = createRepositories(db);
  const session = await r.assist.readSession(sessionId);
  if (session?.workspace_id !== workspaceId) throw resourceNotFound('Assist session');
  const state = await r.assistMemory.state(session.id);
  const checkpoint = state?.checkpoint_id == null ? undefined : await r.assistMemory.checkpoint(state.checkpoint_id);
  const available = checkpoint !== undefined && session.remember && await checkpointAvailable(r, storage, session, checkpoint);
  // Keep the public provenance list cumulative while workers only read bounded delta batches.
  const sourceBatches: AssistMemoryCheckpointRow[] = [];
  if (available && checkpoint !== undefined) {
    let cursor: AssistMemoryCheckpointRow | undefined = checkpoint;
    while (cursor !== undefined) {
      sourceBatches.push(cursor);
      const parentId = await r.assistMemory.checkpointParent(cursor.id);
      if (parentId === null) break;
      const parent = await r.assistMemory.checkpoint(parentId);
      if (parent?.session_id !== session.id || parent.through_seq >= cursor.through_seq) {
        throw new AssistMemoryUnavailable('MEMORY_SOURCE_CHANGED');
      }
      cursor = parent;
    }
  }
  const requests = await r.assistMemory.requests(session.id);
  return { session_id: session.id, session_revision: session.revision.toString(),
    revision: (state?.revision ?? 0n).toString(), remember: session.remember,
    cleared_through_seq: (state?.cleared_through_seq ?? 0n).toString(),
    checkpoint: checkpoint === undefined ? null : { id: checkpoint.id, available,
      through_seq: checkpoint.through_seq.toString(), summary: available ? checkpoint.summary : null,
      model_call_id: checkpoint.model_call_id, created_at: checkpoint.created_at.toISOString(),
      source_message_ids: sourceBatches.reverse().flatMap((batch) => batch.source_message_ids),
      sources: available ? checkpoint.sources : [] },
    requests: requests.map((job) => ({ id: job.id, reason: job.reason, status: job.status,
      cancel_requested: job.cancel_requested, error_code: job.error_code, checkpoint_id: job.checkpoint_id,
      model_call_id: job.model_call_id, through_seq: job.through_seq.toString(),
      created_at: job.created_at.toISOString(), updated_at: job.updated_at.toISOString() })) };
}

export async function readMessageMemoryUse(db: DbExecutor, storage: ManagedContentStore,
  workspaceId: string, sessionId: string, messageId: string) {
  const r = createRepositories(db);
  const session = await r.assist.readSession(sessionId);
  const message = await r.assist.readMessage(messageId);
  if (session?.workspace_id !== workspaceId || message?.session_id !== session.id) throw resourceNotFound('Assist message');
  const use = await r.assistMemory.use(messageId);
  const available = await historicalReplyAvailable(r, storage, session, messageId);
  const sources: JsonObject[] = [];
  for (let offset = 0; offset < (use?.sources.length ?? 0); offset += 20) {
    sources.push(...(await recheckAssistSources(r, storage, session, use!.sources.slice(offset, offset + 20))).safeSources);
  }
  return { session_id: sessionId, message_id: messageId, recorded: use !== undefined,
    available, checkpoint_id: use?.checkpoint_id ?? null, sources };
}
