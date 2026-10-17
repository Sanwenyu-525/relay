import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { acceptAssistProposal, bindAssistSessionDirectory, bindAssistSessionProject,
  cancelAssistMessage, createAssistSession,
  rejectAssistProposal, requestAssistMessage } from '../application/assist-commands.js';
import { createRepositories } from '../application/unit-of-work.js';
import { establishConversationDiffBaseline, readConversationDiff, readConversationDiffFile }
  from '../conversation-diff/net-diff-service.js';
import { MAX_ASSIST_ATTACHMENT_BODY_BYTES, uploadAssistMessageAttachment }
  from '../application/assist-attachments.js';
import { archiveAssistSession, renameAssistSession, reopenAssistSession,
  setAssistSessionPin, setAssistSessionUnread } from '../application/assist-session-controls.js';
import { listAssistMessages, listAssistProposals, listAssistSessions, readAssistProposal,
  readAssistSession, readAssistSessionContexts, projectAssistSkillMessage, readAssistLivePreview }
  from '../application/assist-queries.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { AssistSessionStatus, ConversationMode } from '../infrastructure/database-schema.js';
import { MODEL_ERROR_CATEGORIES, type ModelErrorCategory }
  from '../workflow/model-error-classification.js';
import { toDecimalString } from '../shared/decimal.js';
import { commandEnvelopeSchema, ConversationDiffFileSchema, ConversationDiffSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const rev = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const text = Type.String({ minLength: 1, maxLength: 32_768 });
const base = Type.Object({ workspace_id: uuid }, strict);
const sessionItem = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const proposalItem = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const messageItem = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const livePreviewItem = Type.Object({ workspace_id: uuid, id: uuid,
  message_id: uuid }, strict);

const AssistSessionDto = Type.Object({
  id: uuid, workspace_id: uuid,
  project_id: Type.Union([uuid, Type.Null()]),
  task_id: Type.Union([uuid, Type.Null()]),
  title: Type.String(), status: Type.String(), revision: rev,
  /** 0090：置顶时刻（导航排序键，不是业务事实）。未置顶为 null。 */
  pinned_at: Type.Union([Type.String(), Type.Null()]),
  /** 冻结的会话身份：'AGENT' 普通会话，'ASSISTANT' 人设 助手会话，'LEARNING' 学习会话。 */
  conversation_mode: Type.Union([Type.Literal('AGENT'), Type.Literal('ASSISTANT'), Type.Literal('LEARNING')]),
  assistant_profile_id: Type.Union([uuid, Type.Null()]),
  /** 建会话时冻结的 助手 修订；AGENT 会话恒为 null。 */
  assistant_profile_revision: Type.Union([rev, Type.Null()]),
  /** 冻结的人设文本：只含文本，不含任何能力或连接信息。 */
  assistant_role: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  remember: Type.Boolean(),
  /** 0087：本会话当前绑定的受管工作目录；未绑定为 null。作用域不是准入。 */
  working_resource_id: Type.Union([uuid, Type.Null()]),
  context: Type.Optional(Type.Object({
    project_goals: Type.Array(Type.Object({ goal_id: uuid, title: Type.String() }, strict)),
    working_directory: Type.Union([Type.Null(), Type.Object({ resource_id: uuid,
      canonical_root: Type.Union([Type.String(), Type.Null()]) }, strict)]),
  }, strict)),
  created_at: Type.String(), updated_at: Type.String(),
}, strict);
/** 命令回执里的会话结果（resource 以 session_id 命名，与命令契约一致）。 */
const AssistSessionResult = Type.Object({
  session_id: uuid, workspace_id: uuid,
  project_id: Type.Union([uuid, Type.Null()]),
  task_id: Type.Union([uuid, Type.Null()]),
  title: Type.String(), status: Type.String(), revision: rev,
  conversation_mode: Type.Union([Type.Literal('AGENT'), Type.Literal('ASSISTANT'), Type.Literal('LEARNING')]),
  assistant_profile_id: Type.Union([uuid, Type.Null()]),
  assistant_profile_revision: Type.Union([rev, Type.Null()]),
  remember: Type.Boolean(),
  created_at: Type.String(), updated_at: Type.String(),
}, strict);
const AssistMessageDto = Type.Object({
  id: uuid, session_id: uuid, seq: rev, role: Type.String(), status: Type.String(),
  intent: Type.String(), content: Type.Union([Type.String(), Type.Null()]),
  error_code: Type.Union([Type.String(), Type.Null()]),
  provider_error_kind: Type.Union([
    ...MODEL_ERROR_CATEGORIES.map((category) => Type.Literal(category)), Type.Null(),
  ]),
  sources: Type.Array(Type.Object({}, { additionalProperties: true })),
  skill: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  skill_input: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  skill_output: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  /** 0071：内置工作方法身份（冻结定义 + 摘要 + 本次行动）；未采用方法时为 null。 */
  method: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  method_argument: Type.Union([Type.String(), Type.Null()]),
  provider_request_id: Type.Union([Type.String(), Type.Null()]),
  // cache_* 是 Provider 可选字段：null 表示未上报，不得读成"没有缓存"。
  usage: Type.Object({ input_tokens: Type.Union([Type.Integer(), Type.Null()]),
    output_tokens: Type.Union([Type.Integer(), Type.Null()]),
    cache_read_tokens: Type.Union([Type.Integer(), Type.Null()]),
    cache_creation_tokens: Type.Union([Type.Integer(), Type.Null()]) }, strict),
  cancel_requested: Type.Boolean(),
  created_at: Type.String(), updated_at: Type.String(),
}, strict);
const AssistLivePreviewDto = Type.Object({
  session_id: uuid, message_id: uuid,
  status: Type.Union([Type.Literal('PENDING'), Type.Literal('RUNNING'),
    Type.Literal('COMPLETED'), Type.Literal('FAILED'), Type.Literal('CANCELLED')]),
  preview_revision: rev, preview_text: Type.Union([Type.String(), Type.Null()]),
  preview_truncated: Type.Boolean(), preview_available: Type.Boolean(),
}, strict);
const AssistProposalDto = Type.Object({
  id: uuid, workspace_id: uuid, session_id: uuid, message_id: uuid,
  kind: Type.String(), project_id: Type.Union([uuid, Type.Null()]),
  task_id: Type.Union([uuid, Type.Null()]), target_type: Type.String(), target_id: uuid,
  base_revision: rev, payload: Type.Object({}, { additionalProperties: true }),
  base_acceptance_revision: Type.Union([rev, Type.Null()]),
  payload_hash: Type.String(), payload_available: Type.Boolean(),
  skill_sha256: Type.Union([Type.String(), Type.Null()]),
  skill_output_sha256: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  decision: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  created_at: Type.String(), decided_at: Type.Union([Type.String(), Type.Null()]),
  updated_at: Type.String(),
}, strict);

const createSessionBody = Type.Object({
  command_id: uuid,
  project_id: Type.Optional(Type.Union([uuid, Type.Null()])),
  task_id: Type.Optional(Type.Union([uuid, Type.Null()])),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  /**
   * 会话身份在建立时冻结，之后不改写：不传即 'AGENT'，既有客户端不受影响。
   * 'LEARNING' 是 0072 新增的独立受限身份：对项目只读，只多一项写个人学习记录的能力。
   * Breaking Change：Yes（语义）——同一 command_id 换模式重放按异载荷拒绝。
   */
  conversation_mode: Type.Optional(Type.Union([Type.Literal('AGENT'), Type.Literal('ASSISTANT'), Type.Literal('LEARNING')])),
  assistant_profile_id: Type.Optional(uuid),
}, strict);
const sessionsQuery = Type.Object({
  project_id: Type.Optional(uuid), task_id: Type.Optional(uuid),
  include_context: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
  /**
   * 0090：左栏「已归档」那一段的读法。缺省只列 ACTIVE——归档的语义就是退出默认列表，
   * 不传却返回全部会让「归档即隐藏」落空；`ALL` 供需要一屏看全部的场景显式使用。
   * 取值与库里 status 列一致（大写），与 assistant-profiles、domain-schemas 的列表过滤同一口径。
   */
  status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED'),
    Type.Literal('ALL')])),
}, strict);
/**
 * 绑定只接受确切的项目：resource_id 不在这里，因为目录就绪属于执行准入，
 * 把它并进归属命令会让未就绪原因被吞掉。
 */
const bindSessionBody = Type.Object({ command_id: uuid, project_id: uuid }, strict);
const BindSessionResult = Type.Object({
  session_id: uuid, project_id: uuid, revision: rev,
}, strict);
const bindDirectoryBody = Type.Object({ command_id: uuid, resource_id: uuid }, strict);
const BindDirectoryResult = Type.Object({
  session_id: uuid, working_resource_id: uuid, revision: rev,
}, strict);
/**
 * 0090 / 0104 会话行内控制：改名/置顶/未读/归档/重开都只带 `expected_revision`，不接收别的字段。
 * 标题沿用建会话的 1–200 规则；归档与重开没有可携带的载荷，多余字段一律拒绝，
 * 免得日后有人往同一条命令里塞「顺便改点什么」。
 */
const renameSessionBody = Type.Object({ command_id: uuid, expected_revision: rev,
  title: Type.String({ minLength: 1, maxLength: 200 }) }, strict);
const pinSessionBody = Type.Object({ command_id: uuid, expected_revision: rev,
  pinned: Type.Boolean() }, strict);
/** 未读与置顶同一形状：一条命令两个方向，靠 `unread` 布尔区分，不做两个端点。 */
const unreadSessionBody = Type.Object({ command_id: uuid, expected_revision: rev,
  unread: Type.Boolean() }, strict);
const sessionStateBody = Type.Object({ command_id: uuid, expected_revision: rev }, strict);
const SessionTitleResult = Type.Object({
  session_id: uuid, title: Type.String(), revision: rev, updated_at: Type.String(),
}, strict);
const SessionPinResult = Type.Object({
  session_id: uuid, pinned: Type.Boolean(),
  pinned_at: Type.Union([Type.String(), Type.Null()]), revision: rev, updated_at: Type.String(),
}, strict);
const SessionUnreadResult = Type.Object({
  session_id: uuid, unread: Type.Boolean(),
  unread_at: Type.Union([Type.String(), Type.Null()]), revision: rev, updated_at: Type.String(),
}, strict);
const SessionStateResult = Type.Object({
  session_id: uuid, status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('ARCHIVED')]),
  revision: rev, updated_at: Type.String(),
}, strict);
const messagesQuery = Type.Object({ limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]{1,2}|200)$' })) }, strict);
const sourceRef = Type.Object({
  kind: Type.Union([Type.Literal('KNOWLEDGE'), Type.Literal('MEMORY'), Type.Literal('DECISION')]),
  root_id: uuid, version: Type.String({ pattern: '^[1-9][0-9]*$' }),
}, strict);
const requestMessageBody = Type.Object({
  command_id: uuid, content: text,
  intent: Type.Optional(Type.Union([Type.Literal('DISCUSS'), Type.Literal('PROPOSE_CANDIDATE'),
    Type.Literal('PROPOSE_TASK')])),
  source_refs: Type.Optional(Type.Array(sourceRef, { maxItems: 10 })),
  skill_ref: Type.Optional(Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }),
    version: Type.String({ minLength: 1, maxLength: 32 }) }, strict)),
  skill_input: Type.Optional(Type.Object({}, { additionalProperties: true })),
  /** 显式选择内置工作方法；不传时由 `/命令` 或自然语言识别决定（见 chat-commands.ts）。 */
  method_ref: Type.Optional(Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }),
    version: Type.String({ minLength: 1, maxLength: 32 }),
    /** 不传时取该方法的默认行动（三种方法默认都是只读的 INSPECT）。 */
    action: Type.Optional(Type.Union([Type.Literal('INSPECT'), Type.Literal('MODIFY')])) }, strict)),
  /**
   * 0072：本轮是否写入个人学习状态，缺省 true。只在学习会话上有意义；
   * 关闭时模型即使返回增量，应用也拒绝写入（提示词 §9.4）。
   */
  record_learning: Type.Optional(Type.Boolean()),
  /**
   * 0093：随消息发送的图片附件身份（≤4，由上传端点先落行）。ids 进命令载荷 hash，
   * 服务端在同一事务内核对归属并绑定；无附件时不传，既有载荷逐字不变。
   */
  attachment_ids: Type.Optional(Type.Array(uuid, { maxItems: 4 })),
  /** 0098: model-selection revision returned before accepting a first message. */
  expected_model_selection_revision: Type.Optional(Type.String({ pattern: '^[1-9][0-9]*$' })),
}, strict);
// 0093：上传一张图片附件（会话输入快照暂存）。media_type 白名单与字节上限由
// 应用用例裁决并给出可解释错误，schema 只锁形状；name ≤200 与附件名列一致。
const attachmentUploadBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  media_type: Type.String({ minLength: 1, maxLength: 100 }),
  data_base64: Type.String({ minLength: 1 }),
}, strict);
const AttachmentUploadResult = Type.Object({
  attachment_id: uuid, byte_length: Type.Integer({ minimum: 1 }),
  content_hash: Type.String({ minLength: 1 }),
}, strict);
const cancelBody = Type.Object({ command_id: uuid }, strict);
const proposalsQuery = Type.Object({
  session_id: Type.Optional(uuid), status: Type.Optional(Type.String()), kind: Type.Optional(Type.String()),
}, strict);
const proposalDecisionBody = Type.Object({ command_id: uuid }, strict);
const proposalAcceptBody = Type.Object({ command_id: uuid,
  expected_task_revision: Type.Optional(rev),
  expected_acceptance_revision: Type.Optional(rev),
  payload_hash: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
}, strict);

function sessionDto(row: { id: string; workspace_id: string; project_id: string | null;
  task_id: string | null; title: string; status: string; revision: bigint;
  pinned_at: Date | null;
  unread_at: Date | null;
  conversation_mode: ConversationMode; assistant_profile_id: string | null;
  assistant_profile_revision: bigint | null; assistant_role_snapshot: JsonObject | null;
  remember: boolean; working_resource_id: string | null; created_at: Date; updated_at: Date }) {
  return {
    id: row.id, workspace_id: row.workspace_id, project_id: row.project_id,
    task_id: row.task_id, title: row.title, status: row.status,
    revision: toDecimalString(row.revision),
    // 置顶时刻逐字返回：客户端据此排序并显示「已置顶」，不自行推断。
    pinned_at: row.pinned_at === null ? null : row.pinned_at.toISOString(),
    // 0104：未读时刻同样逐字返回。NULL=已读，界面不替服务端猜「看过就算读」。
    unread_at: row.unread_at === null ? null : row.unread_at.toISOString(),
    conversation_mode: row.conversation_mode,
    assistant_profile_id: row.assistant_profile_id,
    assistant_profile_revision: row.assistant_profile_revision === null ? null
      : toDecimalString(row.assistant_profile_revision),
    // 人设快照逐字返回：客户端显示的就是这条会话建立时的人设，不读当前助手。
    assistant_role: row.assistant_role_snapshot,
    remember: row.remember,
    // 0087：会话当前绑定的受管目录。只读投影——作用域不是准入，客户端据此显示
    // 「这次会读哪个目录」，不代表这次读取一定会被放行。
    working_resource_id: row.working_resource_id,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  };
}

function messageDto(row: { id: string; session_id: string; seq: bigint; role: string;
  status: string; intent: string; content: string | null; error_code: string | null;
  provider_error_kind: ModelErrorCategory | null;
  sources: unknown; provider_request_id: string | null; usage_input_tokens: number | null;
  usage_output_tokens: number | null; usage_cache_read_tokens: number | null;
  usage_cache_creation_tokens: number | null; cancel_requested: boolean;
  created_at: Date; updated_at: Date },
  projection: { skill: JsonObject | null; skill_input: JsonObject | null;
    skill_output: JsonObject | null; content: string | null; sources: unknown;
    method: JsonObject | null; method_argument: string | null }) {
  return {
    id: row.id, session_id: row.session_id, seq: toDecimalString(row.seq), role: row.role,
    status: row.status, intent: row.intent, content: projection.content,
    error_code: row.error_code, provider_error_kind: row.provider_error_kind,
    sources: projection.sources,
    skill: projection.skill, skill_input: projection.skill_input,
    skill_output: projection.skill_output,
    method: projection.method, method_argument: projection.method_argument,
    provider_request_id: row.provider_request_id,
    usage: { input_tokens: row.usage_input_tokens, output_tokens: row.usage_output_tokens,
      cache_read_tokens: row.usage_cache_read_tokens,
      cache_creation_tokens: row.usage_cache_creation_tokens },
    cancel_requested: row.cancel_requested,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  };
}

function proposalDto(row: { id: string; workspace_id: string; session_id: string;
  message_id: string; kind: string; project_id: string | null; task_id: string | null;
  target_type: string; target_id: string; base_revision: bigint; payload: unknown;
  base_acceptance_revision: bigint | null; payload_hash: string;
  payload_available: boolean; skill_sha256: string | null;
  skill_output_sha256: string | null;
  status: string; decision: unknown; created_at: Date;
  decided_at: Date | null; updated_at: Date }) {
  return {
    id: row.id, workspace_id: row.workspace_id, session_id: row.session_id,
    message_id: row.message_id, kind: row.kind, project_id: row.project_id,
    task_id: row.task_id, target_type: row.target_type, target_id: row.target_id,
    base_revision: toDecimalString(row.base_revision), payload: row.payload,
    base_acceptance_revision: row.base_acceptance_revision === null ? null :
      toDecimalString(row.base_acceptance_revision),
    payload_hash: row.payload_hash, payload_available: row.payload_available,
    skill_sha256: row.skill_sha256,
    skill_output_sha256: row.skill_output_sha256,
    status: row.status, decision: row.decision,
    created_at: row.created_at.toISOString(),
    decided_at: row.decided_at === null ? null : row.decided_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function registerAssistRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.post('/assist-sessions', { schema: { params: base, body: createSessionBody,
    response: { 201: commandEnvelopeSchema(AssistSessionResult) } } },
  createCommandHandler(dependencies, { commandType: 'CreateAssistSession',
    bodySchema: createSessionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await createAssistSession(executor, {
        workspaceId: params.workspace_id ?? '', commandId: body.command_id,
        ...(body.project_id === undefined ? {} : { projectId: body.project_id }),
        ...(body.task_id === undefined ? {} : { taskId: body.task_id }),
        title: body.title,
        ...(body.conversation_mode === undefined ? {} : { conversationMode: body.conversation_mode }),
        ...(body.assistant_profile_id === undefined ? {} : { assistantProfileId: body.assistant_profile_id }),
      });
      return { outcome, result: outcome.result };
    } }));

  // 绑定更新既有会话，不新建资源：按 successStatusOf 的规则返回 200 而非 201。
app.post('/assist-sessions/:id/binding', { schema: { params: sessionItem, body: bindSessionBody,
    response: { 200: commandEnvelopeSchema(BindSessionResult) } } },
  createCommandHandler(dependencies, { commandType: 'BindAssistSessionProject',
    bodySchema: bindSessionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await bindAssistSessionProject(executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.id ?? '',
        commandId: body.command_id, projectId: body.project_id });
      return { outcome, result: outcome.result };
    } }));

  // 0087：绑定本会话的当前工作目录。目录是作用域不是准入——写入仍逐次经 Gateway 核对。
  app.post('/assist-sessions/:id/working-directory', { schema: { params: sessionItem,
    body: bindDirectoryBody, response: { 200: commandEnvelopeSchema(BindDirectoryResult) } } },
  createCommandHandler(dependencies, { commandType: 'BindAssistSessionDirectory',
    bodySchema: bindDirectoryBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await bindAssistSessionDirectory(executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.id ?? '',
        commandId: body.command_id, resourceId: body.resource_id });
      return { outcome, result: outcome.result };
    } }));

  // 0090：会话行内控制。四件事都只改这一行自身的标题/排序键/归档态，
  // 统一 200（不新建资源），都带 command_id 幂等与 expected_revision CAS。
  app.post('/assist-sessions/:id/title', { schema: { params: sessionItem,
    body: renameSessionBody, response: { 200: commandEnvelopeSchema(SessionTitleResult) } } },
  createCommandHandler(dependencies, { commandType: 'RenameAssistSession',
    bodySchema: renameSessionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await renameAssistSession(executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision,
        title: body.title });
      return { outcome, result: outcome.result };
    } }));

  app.post('/assist-sessions/:id/pin', { schema: { params: sessionItem,
    body: pinSessionBody, response: { 200: commandEnvelopeSchema(SessionPinResult) } } },
  createCommandHandler(dependencies, { commandType: 'SetAssistSessionPin',
    bodySchema: pinSessionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await setAssistSessionPin(executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision,
        pinned: body.pinned });
      return { outcome, result: outcome.result };
    } }));

  app.post('/assist-sessions/:id/unread', { schema: { params: sessionItem,
    body: unreadSessionBody, response: { 200: commandEnvelopeSchema(SessionUnreadResult) } } },
  createCommandHandler(dependencies, { commandType: 'SetAssistSessionUnread',
    bodySchema: unreadSessionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await setAssistSessionUnread(executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision,
        unread: body.unread });
      return { outcome, result: outcome.result };
    } }));

  app.post('/assist-sessions/:id/archive', { schema: { params: sessionItem,
    body: sessionStateBody, response: { 200: commandEnvelopeSchema(SessionStateResult) } } },
  createCommandHandler(dependencies, { commandType: 'ArchiveAssistSession',
    bodySchema: sessionStateBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await archiveAssistSession(executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  // 重开把会话放回 ACTIVE：它不授予新的执行权，发消息与目录准入照旧逐次核对。
  app.post('/assist-sessions/:id/reopen', { schema: { params: sessionItem,
    body: sessionStateBody, response: { 200: commandEnvelopeSchema(SessionStateResult) } } },
  createCommandHandler(dependencies, { commandType: 'ReopenAssistSession',
    bodySchema: sessionStateBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await reopenAssistSession(executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  app.get('/assist-sessions', { schema: { params: base, querystring: sessionsQuery } },
  async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { project_id?: string; task_id?: string;
        include_context?: 'true' | 'false'; status?: AssistSessionStatus | 'ALL' };
      const rows = await listAssistSessions(dependencies.database.executor, {
        workspaceId: p.workspace_id,
        ...(q.project_id === undefined ? {} : { projectId: q.project_id }),
        ...(q.task_id === undefined ? {} : { taskId: q.task_id }),
        status: q.status ?? 'ACTIVE',
      });
      const contexts = q.include_context === 'true' ? await readAssistSessionContexts(dependencies.database.executor,
        { workspaceId: p.workspace_id, sessionIds: rows.map((row) => row.id) }) : [];
      const byId = new Map(contexts.map((context) => [context.session_id, context]));
      return { items: rows.map((row) => {
        const readContext = byId.get(row.id);
        const context = readContext?.session_revision === row.revision ? readContext : undefined;
        return { ...sessionDto(row), ...(context === undefined ? {} : { context: {
          project_goals: context.project_goals, working_directory: context.working_directory } }) };
      }) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/assist-sessions/:id', { schema: { params: sessionItem,
    querystring: Type.Object({ include_context: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])) }, strict),
    response: { 200: AssistSessionDto } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      const session = await readAssistSession(dependencies.database.executor, {
        workspaceId: p.workspace_id, sessionId: p.id ?? '' });
      const q = request.query as { include_context?: 'true' | 'false' };
      const readContext = q.include_context === 'true' ? (await readAssistSessionContexts(dependencies.database.executor,
        { workspaceId: p.workspace_id, sessionIds: [session.id] }))[0] : undefined;
      const context = readContext?.session_revision === session.revision ? readContext : undefined;
      return { ...sessionDto(session), ...(context === undefined ? {} : { context: {
        project_goals: context.project_goals, working_directory: context.working_directory } }) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  // 0093：上传一张图片附件（会话输入快照暂存，不是幂等命令）。路由级放宽 bodyLimit
  // 只作用于本端点：base64 后约 2.7 MiB + JSON 余量；其他端点仍用服务器默认限制。
  app.post('/assist-sessions/:id/message-attachments', {
    schema: { params: sessionItem, body: attachmentUploadBody,
      response: { 201: AttachmentUploadResult } },
    bodyLimit: MAX_ASSIST_ATTACHMENT_BODY_BYTES,
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      const body = request.body as { name: string; media_type: string; data_base64: string };
      const result = await uploadAssistMessageAttachment(dependencies.database.executor, {
        workspaceId: p.workspace_id, sessionId: p.id ?? '', name: body.name,
        mediaType: body.media_type, dataBase64: body.data_base64 });
      return reply.code(201).send(result);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  // 异步生成：202 只代表消息已排队；回复以 GET messages 的 ASSISTANT 行状态为准。
  app.post('/assist-sessions/:id/messages', { schema: { params: sessionItem,    body: requestMessageBody,
    response: { 202: commandEnvelopeSchema(Type.Object({
      session_id: uuid, user_message_id: uuid, assistant_message_id: uuid,
    }, strict)) } } },
  createCommandHandler(dependencies, { commandType: 'RequestAssistMessage',
    bodySchema: requestMessageBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await requestAssistMessage(executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.id ?? '',
        commandId: body.command_id, content: body.content,
        ...(body.intent === undefined ? {} : { intent: body.intent }),
        ...(body.source_refs === undefined ? {} : { sourceRefs: body.source_refs }),
        ...(body.skill_ref === undefined ? {} : { skillRef: body.skill_ref }),
        ...(body.skill_input === undefined ? {} : { skillInput: body.skill_input }),
        ...(body.method_ref === undefined ? {} : { methodRef: body.method_ref }),
        ...(body.record_learning === undefined ? {} : { recordLearning: body.record_learning }),
        ...(body.attachment_ids === undefined ? {} : { attachmentIds: body.attachment_ids }),
        ...(body.expected_model_selection_revision === undefined ? {} : {
          expectedModelSelectionRevision: body.expected_model_selection_revision,
        }),
        // 0093：能力闸门的裁决输入——当前聊天恒由进程默认连接服务（见闸门注释）。
        chatModelName: process.env.RELAY_MODEL_NAME,
      });
      return { outcome, result: outcome.result };
    } }));

  app.get('/assist-sessions/:id/messages', { schema: { params: sessionItem,
    querystring: messagesQuery,
    response: { 200: Type.Object({ items: Type.Array(AssistMessageDto) }, strict) },
  } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      const q = request.query as { limit?: string };
      const rows = await listAssistMessages(dependencies.database.executor, {
        workspaceId: p.workspace_id, sessionId: p.id ?? '',
        ...(q.limit === undefined ? {} : { limit: Number(q.limit) }),
      });
      const session = await readAssistSession(dependencies.database.executor, {
        workspaceId: p.workspace_id, sessionId: p.id ?? '' });
      return { items: await Promise.all(rows.map(async (row) => messageDto(row,
        await projectAssistSkillMessage(dependencies.database.executor,
          dependencies.storage, session, row)))) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/assist-sessions/:id/messages/:message_id/live-preview', {
    schema: { params: livePreviewItem, response: { 200: AssistLivePreviewDto } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string;
        message_id: string };
      reply.header('Cache-Control', 'no-store');
      return await readAssistLivePreview(dependencies.database.executor,
        dependencies.storage, { workspaceId: p.workspace_id, sessionId: p.id,
          messageId: p.message_id });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/assist-messages/:id/cancel', { schema: { params: messageItem, body: cancelBody,
    response: { 200: commandEnvelopeSchema(Type.Object({
      message_id: uuid, status: Type.String(),
    }, strict)) } } },
  createCommandHandler(dependencies, { commandType: 'CancelAssistMessage',
    bodySchema: cancelBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await cancelAssistMessage(executor, {
        workspaceId: params.workspace_id ?? '', messageId: params.id ?? '',
        commandId: body.command_id });
      return { outcome, result: outcome.result };
    } }));

  app.get('/assist-proposals', { schema: { params: base, querystring: proposalsQuery } },
  async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      const q = request.query as { session_id?: string; status?: string; kind?: string };
      const rows = await listAssistProposals(dependencies.database.executor,
        dependencies.storage, {
        workspaceId: p.workspace_id,
        ...(q.session_id === undefined ? {} : { sessionId: q.session_id }),
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.kind === undefined ? {} : { kind: q.kind }),
      });
      return { items: rows.map(proposalDto) };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/assist-proposals/:id', { schema: { params: proposalItem,
    response: { 200: AssistProposalDto } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      const row = await readAssistProposal(dependencies.database.executor,
        dependencies.storage, {
        workspaceId: p.workspace_id, proposalId: p.id ?? '' });
      return proposalDto(row);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.post('/assist-proposals/:id/accept', { schema: { params: proposalItem,
    body: proposalAcceptBody,
    response: { 200: commandEnvelopeSchema(Type.Object({}, { additionalProperties: true })) } } },
  createCommandHandler(dependencies, { commandType: 'AcceptAssistProposal',
    bodySchema: proposalAcceptBody,
    execute: async ({ dependencies: routeDependencies, executor, params, body }) => {
      const outcome = await acceptAssistProposal(executor, {
        workspaceId: params.workspace_id ?? '', proposalId: params.id ?? '',
        commandId: body.command_id, storage: routeDependencies.storage,
        ...(body.expected_task_revision === undefined ? {} :
          { expectedTaskRevision: body.expected_task_revision }),
        ...(body.expected_acceptance_revision === undefined ? {} :
          { expectedAcceptanceRevision: body.expected_acceptance_revision }),
        ...(body.payload_hash === undefined ? {} : { payloadHash: body.payload_hash }) });
      return { outcome, result: outcome.result };
    } }));

  app.post('/assist-proposals/:id/reject', { schema: { params: proposalItem,
    body: proposalDecisionBody,
    response: { 200: commandEnvelopeSchema(Type.Object({
      proposal_id: uuid, status: Type.String(),
    }, strict)) } } },
  createCommandHandler(dependencies, { commandType: 'RejectAssistProposal',
    bodySchema: proposalDecisionBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await rejectAssistProposal(executor, {
        workspaceId: params.workspace_id ?? '', proposalId: params.id ?? '',
        commandId: body.command_id });
      return { outcome, result: outcome.result };
    } }));

function conversationDiffDto(result: Awaited<ReturnType<typeof readConversationDiff>>): unknown {
  if (!result.available) {
    return { available: false, reason: result.reason };
  }
  const diff = result.diff;
  return {
    available: true,
    baseline_captured_at: diff.baselineCapturedAt,
    baseline_revision: diff.baselineRevision.toString(),
    root_path: diff.rootPath,
    resource_id: diff.resourceId,
    incomplete: diff.incomplete,
    total_files: diff.totalFiles,
    total_added: diff.totalAdded,
    total_removed: diff.totalRemoved,
    files: diff.files.map((file) => ({
      path: file.path,
      action: file.action,
      added: file.added,
      removed: file.removed,
      unavailable_reason: file.unavailableReason,
    })),
  };
}

app.get('/assist-sessions/:id/conversation-diff', {
  schema: { params: sessionItem, response: { 200: ConversationDiffSchema } },
}, async (request, reply) => {
  try {
    const p = request.params as { workspace_id: string; id: string };
    reply.header('Cache-Control', 'no-store');
    const result = await readConversationDiff(createRepositories(dependencies.database.executor), {
      workspaceId: p.workspace_id, sessionId: p.id,
    });
    return conversationDiffDto(result);
  } catch (error) { return sendReadError(reply, error, request.id); }
});

// CD-18：展开阅读——单文件的逐行完整 diff（与总数同一份基线修订 + 同一份当前快照）。
app.get('/assist-sessions/:id/conversation-diff/file', {
  schema: { params: sessionItem,
    querystring: Type.Object({ path: Type.String({ minLength: 1 }) }, strict),
    response: { 200: ConversationDiffFileSchema } },
}, async (request, reply) => {
  try {
    const p = request.params as { workspace_id: string; id: string };
    const query = request.query as { path: string };
    reply.header('Cache-Control', 'no-store');
    const result = await readConversationDiffFile(createRepositories(dependencies.database.executor), {
      workspaceId: p.workspace_id, sessionId: p.id, path: query.path,
    });
    if (!result.available) return { available: false as const, reason: result.reason };
    return {
      available: true as const,
      path: result.file.path,
      action: result.file.action,
      added: result.file.added,
      removed: result.file.removed,
      unavailable_reason: result.file.unavailableReason,
      rows: result.file.rows === null ? null : result.file.rows.map((row) => ({
        kind: row.kind, old_line: row.oldLine, new_line: row.newLine, text: row.text,
      })),
      rows_truncated: result.file.rowsTruncated,
      rows_unavailable_reason: result.file.rowsUnavailableReason,
    };
  } catch (error) { return sendReadError(reply, error, request.id); }
});

// CD-05：主动「从现在开始统计」——为当前目录新建一段基线（不倒造过去）。返回幂等结果。
app.post('/assist-sessions/:id/conversation-diff/baseline', {
  schema: { params: sessionItem, body: Type.Object({}, { additionalProperties: false }),
    response: { 200: Type.Object({ established: Type.Boolean(), reason: Type.String() }, strict) } },
}, async (request, reply) => {
  try {
    const p = request.params as { workspace_id: string; id: string };
    reply.header('Cache-Control', 'no-store');
    const outcome = await establishConversationDiffBaseline(createRepositories(dependencies.database.executor), {
      workspaceId: p.workspace_id, sessionId: p.id,
    });
    return { established: outcome.established, reason: outcome.reason };
  } catch (error) { return sendReadError(reply, error, request.id); }
});
}
