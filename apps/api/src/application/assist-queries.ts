import type { AssistMessageRow, AssistProposalRow, AssistSessionRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { resourceNotFound } from './domain-error.js';
import { recheckAssistSources } from './assist-runner.js';
import { createRepositories, withTransaction } from './unit-of-work.js';
import { availableFrozenSkill, inspectFrozenSkillSnapshot,
  isCallableSkill } from '../skills/first-party-registry.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';

/**
 * Assist 只读查询：全部按 Workspace 作用域过滤，跨作用域 ID 按不可见处理（404）。
 * 消息与提案都是 Assist 模块的投影，不复制第二套业务状态。
 */

export async function listAssistSessions(db: DbExecutor, input: { workspaceId: string;
  projectId?: string; taskId?: string }): Promise<readonly AssistSessionRow[]> {
  const r = createRepositories(db);
  return r.assist.listSessions(input.workspaceId, input.projectId, input.taskId);
}

export async function readAssistSession(db: DbExecutor, input: {
  workspaceId: string; sessionId: string }): Promise<AssistSessionRow> {
  const r = createRepositories(db);
  const session = await r.assist.readSession(input.sessionId);
  if (session === undefined || session.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist session');
  }
  return session;
}

export async function listAssistMessages(db: DbExecutor, input: {
  workspaceId: string; sessionId: string; limit?: number }): Promise<readonly AssistMessageRow[]> {
  const session = await readAssistSession(db, input);
  const r = createRepositories(db);
  const limit = input.limit === undefined ? undefined :
    Math.max(1, Math.min(200, Math.trunc(input.limit)));
  return r.assist.listMessages(session.id, limit);
}

/** Short, reauthorized snapshot; revisions describe only disposable draft display. */
export async function readAssistLivePreview(db: DbExecutor, storage: ManagedContentStore,
  input: { workspaceId: string; sessionId: string; messageId: string }): Promise<{
    session_id: string; message_id: string; status: AssistMessageRow['status'];
    preview_revision: string; preview_text: string | null;
    preview_truncated: boolean; preview_available: boolean;
  }> {
  return withTransaction(db, async (r) => {
    if (await r.workspaces.lockAuthority(input.workspaceId, 'share') === undefined) {
      throw resourceNotFound('Workspace');
    }
    const session = await r.assist.readSession(input.sessionId);
    const message = await r.assist.readMessage(input.messageId);
    if (session?.workspace_id !== input.workspaceId ||
        message?.session_id !== session.id) throw resourceNotFound('Assist message');
    const empty = { session_id: session.id, message_id: message.id,
      status: message.status, preview_revision: '0', preview_text: null,
      preview_truncated: false, preview_available: false };
    if (message.role !== 'ASSISTANT' || message.intent !== 'DISCUSS' ||
        message.skill_snapshot !== null ||
        message.status !== 'PENDING' && message.status !== 'RUNNING' ||
        message.cancel_requested) return empty;
    const task = session.task_id === null ? undefined : await r.tasks.readTask(session.task_id);
    const project = session.project_id === null ? undefined :
      await r.projects.readProject(session.project_id);
    if (session.project_id !== null && project?.workspace_id !== input.workspaceId ||
        session.task_id !== null && (task?.workspace_id !== input.workspaceId ||
          task.project_id !== session.project_id)) return empty;

    const history = await r.assist.listCompletedHistory(session.id, message.seq, 20);
    const sourceGroups = [message.sources, ...history.filter((entry) =>
      entry.role === 'ASSISTANT').map((entry) => entry.sources)];
    if (sourceGroups.reduce((count, group) => count +
        (Array.isArray(group) ? group.length : 21), 0) > 20) return empty;
    for (const sources of sourceGroups) {
      if (!(await recheckAssistSources(r, storage, session, sources)).available) return empty;
    }
    // Wait for any concurrent cancel/settlement only after bounded source reads.
    // Holding SHARE until commit makes the returned state and prefix one snapshot.
    const current = await r.assist.readMessage(message.id, 'share');
    if (current === undefined ||
        current.status !== 'PENDING' && current.status !== 'RUNNING' ||
        current.cancel_requested) return { ...empty, status: current?.status ?? message.status };
    const preview = await r.assist.readLivePreview(message.id);
    return { ...empty, preview_revision: preview === undefined ? '0' :
      toDecimalString(preview.revision), preview_text: preview?.preview_text ?? null,
      preview_truncated: preview?.truncated ?? false, preview_available: true };
  });
}

export async function listAssistProposals(db: DbExecutor, storage: ManagedContentStore, input: {
  workspaceId: string; sessionId?: string; status?: string;
  kind?: string }): Promise<readonly (AssistProposalRow & { payload_available: boolean })[]> {
  const r = createRepositories(db);
  const rows = await r.assist.listProposals(input.workspaceId, {
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
  });
  return Promise.all(rows.map((row) => projectProposal(db, storage, row)));
}

export async function readAssistProposal(db: DbExecutor, storage: ManagedContentStore, input: {
  workspaceId: string; proposalId: string }): Promise<AssistProposalRow & {
    payload_available: boolean }> {
  const r = createRepositories(db);
  const proposal = await r.assist.readProposal(input.proposalId);
  if (proposal === undefined || proposal.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist proposal');
  }
  return projectProposal(db, storage, proposal);
}

async function projectProposal(db: DbExecutor, storage: ManagedContentStore,
  proposal: AssistProposalRow): Promise<AssistProposalRow & {
    payload_available: boolean }> {
  if (proposal.kind !== 'TASK_CONTRACT_CHANGE' &&
      proposal.kind !== 'VERIFICATION_PLAN_CHANGE') {
    return { ...proposal, payload_available: true };
  }
  const r = createRepositories(db);
  const session = await r.assist.readSession(proposal.session_id);
  const message = await r.assist.readMessage(proposal.message_id);
  const projected = session === undefined || message === undefined ? null :
    await projectAssistSkillMessage(db, storage, session, message);
  const available = projected?.skill?.output_availability === 'HISTORICAL_SNAPSHOT' &&
    session?.workspace_id === proposal.workspace_id &&
    session.task_id === proposal.target_id;
  return { ...proposal, payload: available ? proposal.payload : {},
    payload_available: available };
}

/** Skill outputs are historical suggestions, projected only while selected sources remain readable. */
export async function projectAssistSkillMessage(db: DbExecutor, storage: ManagedContentStore,
  session: AssistSessionRow, message: AssistMessageRow): Promise<{
    readonly skill: JsonObject | null; readonly skill_input: JsonObject | null;
    readonly skill_output: JsonObject | null; readonly content: string | null;
    readonly sources: unknown;
  }> {
  if (message.skill_snapshot === null) {
    const r = createRepositories(db);
    const checked = await recheckAssistSources(r, storage, session, message.sources);
    const task = session.task_id === null ? undefined : await r.tasks.readTask(session.task_id);
    const project = session.project_id === null ? undefined :
      await r.projects.readProject(session.project_id);
    const targetAvailable = (session.project_id === null ||
      project?.workspace_id === session.workspace_id) &&
      (session.task_id === null || task?.workspace_id === session.workspace_id &&
        task.project_id === session.project_id);
    return { skill: null, skill_input: null, skill_output: null,
      content: checked.available && targetAvailable ? message.content : null,
      sources: checked.safeSources.map((source, index) => targetAvailable &&
        source.status === 'AVAILABLE' &&
        Array.isArray(message.sources) ? message.sources[index] : source) };
  }
  const historical = inspectFrozenSkillSnapshot(message.skill_snapshot);
  const resolved = historical === null ? null : availableFrozenSkill(message.skill_snapshot);
  const ref = message.skill_snapshot;
  const identity = historical === null ? {
    id: typeof ref.id === 'string' && /^[a-z0-9-]{1,100}$/u.test(ref.id)
      ? ref.id : 'UNKNOWN',
    version: typeof ref.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/u.test(ref.version)
      ? ref.version : 'UNKNOWN',
    sha256: typeof ref.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(ref.sha256)
      ? ref.sha256 : null,
    definition_availability: 'UNAVAILABLE',
  } : { ...historical, definition_availability: resolved === null ||
    !isCallableSkill(resolved)
    ? 'HISTORICAL_ONLY' : 'AVAILABLE' };
  const r = createRepositories(db);
  const { available: sourcesAvailable, safeSources } = await recheckAssistSources(r,
    storage, session, message.sources);
  const task = session.task_id === null ? undefined : await r.tasks.readTask(session.task_id);
  const project = session.project_id === null ? undefined :
    await r.projects.readProject(session.project_id);
  const targetAvailable = historical !== null &&
    (historical.target === 'TASK'
      ? task?.workspace_id === session.workspace_id &&
        task.project_id === session.project_id &&
        (session.project_id === null || project?.workspace_id === session.workspace_id)
      : project?.workspace_id === session.workspace_id);
  const outputAvailable = historical !== null && sourcesAvailable && targetAvailable;
  const outputAvailability = !outputAvailable ? 'UNAVAILABLE' :
    message.status === 'COMPLETED' ? 'HISTORICAL_SNAPSHOT' :
      message.status === 'PENDING' || message.status === 'RUNNING' ? 'PENDING' :
        'NO_OUTPUT';
  const skill = { ...identity, output_availability: outputAvailability };
  return { skill, skill_input: message.skill_input,
    skill_output: outputAvailability === 'HISTORICAL_SNAPSHOT'
      ? message.skill_output : null,
    content: outputAvailability === 'HISTORICAL_SNAPSHOT'
      ? message.content : null, sources: safeSources };
}
