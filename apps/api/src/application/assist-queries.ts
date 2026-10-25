import type { AssistMessageRow, AssistProposalRow, AssistSessionRow, AssistSessionStatus } from '../infrastructure/database-schema.js';
import type { AssistSessionListRow } from '../assist/assist-repository.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { ManagedContentStore } from '../storage/managed-content-store.js';
import { resourceNotFound } from './domain-error.js';
import { recheckAssistSources } from './assist-source-content.js';
import { historicalReplyAvailable } from './assist-memory.js';
import { createRepositories, withTransaction } from './unit-of-work.js';
import { availableFrozenSkill, inspectFrozenSkillSnapshot,
  isCallableSkill } from '../skills/first-party-registry.js';
import { availableFrozenMethod,
  inspectFrozenMethodSnapshot } from '../skills/builtin-methods.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';

/**
 * Assist 只读查询：全部按 Workspace 作用域过滤，跨作用域 ID 按不可见处理（404）。
 * 消息与提案都是 Assist 模块的投影，不复制第二套业务状态。
 */

export async function listAssistSessions(db: DbExecutor, input: { workspaceId: string;
  projectId?: string; taskId?: string; status?: AssistSessionStatus | 'ALL' }):
Promise<readonly AssistSessionListRow[]> {
  const r = createRepositories(db);
  return r.assist.listSessions(input.workspaceId, input.projectId, input.taskId, input.status);
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

/**
 * 单条会话读取 + 读时派生的 `has_messages`（与会话列表同一口径）。
 *
 * 保留 `readAssistSession` 的窄返回：命令、锁与内部定位只关心会话行本身。
 * 只有面向界面的单条 GET 需要这枚派生事实，所以单独成函数，不把派生查询
 * 塞进每条读写路径。
 */
export async function readAssistSessionWithActivity(db: DbExecutor, input: {
  workspaceId: string; sessionId: string }):
Promise<{ readonly session: AssistSessionRow; readonly hasMessages: boolean }> {
  const session = await readAssistSession(db, input);
  const hasMessages = await createRepositories(db).assist.sessionHasMessages(session.id);
  return { session, hasMessages };
}

export async function readAssistSessionContexts(db: DbExecutor, input: {
  workspaceId: string; sessionIds: readonly string[];
}) {
  return createRepositories(db).assist.listSessionContexts(input.workspaceId, input.sessionIds);
}

export async function listAssistMessages(db: DbExecutor, input: {
  workspaceId: string; sessionId: string; limit?: number }): Promise<readonly AssistMessageRow[]> {
  const session = await readAssistSession(db, input);
  const r = createRepositories(db);
  const limit = input.limit === undefined ? undefined :
    Math.max(1, Math.min(200, Math.trunc(input.limit)));
  return r.assist.listMessages(session.id, limit);
}

/**
 * 0093：消息投影里的附件元数据（id/名/类型/字节数，**不含内容**）。
 *
 * 内容只在显式请求 `readAssistMessageAttachment` 时单独读取：消息列表是每轮都要读的
 * 投影，把 bytea 混进去会让一次列表读取变成几 MB。按 message_id 分组返回，调用方
 * 按第一条消息的顺序拼装。
 */
export async function listAssistMessageAttachmentMeta(db: DbExecutor, input: {
  workspaceId: string; sessionId: string; messageIds: readonly string[] }):
Promise<ReadonlyMap<string, readonly AssistMessageAttachmentMeta[]>> {
  const session = await readAssistSession(db, input);
  if (input.messageIds.length === 0) return new Map();
  const rows = await createRepositories(db).assist
    .listAttachmentMetaByMessages(session.id, input.messageIds);
  const grouped = new Map<string, AssistMessageAttachmentMeta[]>();
  for (const row of rows) {
    if (row.message_id === null) continue;
    const list = grouped.get(row.message_id) ?? [];
    list.push({ id: row.id, name: row.name, mediaType: row.media_type,
      byteLength: row.byte_length });
    grouped.set(row.message_id, list);
  }
  return grouped;
}

export interface AssistMessageAttachmentMeta {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

/**
 * 0093：读取一张附件的内容（工作台 §33.3 的历史消息缩略图）。
 *
 * 只读、不改任何业务状态；归属同时核对 workspace 与 session——跨会话/跨工作区引用
 * 一律按不可见处理（404），不因为知道 id 就放宽。内容以 base64 返回：HTTP 客户端
 * 统一按 JSON 解析，二进制响应会给这条只读路径引入第二套传输形状。
 */
export async function readAssistMessageAttachment(db: DbExecutor, input: {
  workspaceId: string; sessionId: string; attachmentId: string }):
Promise<AssistMessageAttachmentContent> {
  const session = await readAssistSession(db, input);
  const row = await createRepositories(db).assist
    .readAttachment(input.attachmentId, session.workspace_id, session.id);
  if (row === undefined) throw resourceNotFound('Assist message attachment');
  return { attachmentId: row.id, name: row.name, mediaType: row.media_type,
    byteLength: row.byte_length, dataBase64: Buffer.from(row.content).toString('base64') };
}

export interface AssistMessageAttachmentContent {
  readonly attachmentId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly dataBase64: string;
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
    if (!await historicalReplyAvailable(r, storage, session, message.id)) return empty;
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
    readonly sources: unknown; readonly method: JsonObject | null;
    readonly method_argument: string | null;
  }> {
  // 内置工作方法（0071）：与 Skill 同口径——身份按发起时冻结的摘要核对，定义被替换后
  // 只显示历史身份，不按当前注册表补造；正文只在来源仍可读时投影。
  if (message.method_snapshot !== null) {
    const historical = inspectFrozenMethodSnapshot(message.method_snapshot);
    const resolved = historical === null ? null : availableFrozenMethod(message.method_snapshot);
    const ref = message.method_snapshot;
    const identity = historical === null ? {
      id: typeof ref.id === 'string' ? ref.id : 'UNKNOWN',
      version: typeof ref.version === 'string' ? ref.version : 'UNKNOWN',
      sha256: typeof ref.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(ref.sha256)
        ? ref.sha256 : null,
      definition_availability: 'UNAVAILABLE',
    } : { ...historical, definition_availability: resolved === null
      ? 'HISTORICAL_ONLY' : 'AVAILABLE' };
    const r = createRepositories(db);
    const { available, safeSources } = await recheckAssistSources(r, storage, session,
      message.sources);
    return { skill: null, skill_input: null, skill_output: null,
      content: available && await historicalReplyAvailable(r, storage, session, message.id) ? message.content : null, sources: safeSources,
      method: { ...identity, action: message.method_action },
      method_argument: message.method_argument };
  }
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
      content: checked.available && targetAvailable && await historicalReplyAvailable(r, storage, session, message.id) ? message.content : null,
      sources: checked.safeSources.map((source, index) => targetAvailable &&
        source.status === 'AVAILABLE' &&
        Array.isArray(message.sources) ? message.sources[index] : source),
      method: null, method_argument: null };
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
      ? message.content : null, sources: safeSources,
    method: null, method_argument: null };
}
