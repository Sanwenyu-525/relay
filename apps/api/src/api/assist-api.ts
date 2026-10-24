import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { acceptAssistProposal, bindAssistSessionDirectory, bindAssistSessionProject,
  cancelAssistMessage, createAssistSession,
  rejectAssistProposal, requestAssistMessage, steerAssistMessage }
  from '../application/assist-commands.js';
import { createRepositories } from '../application/unit-of-work.js';
import { establishConversationDiffBaseline, readConversationDiff, readConversationDiffFile }
  from '../conversation-diff/net-diff-service.js';
import { MAX_ASSIST_ATTACHMENT_BODY_BYTES, uploadAssistMessageAttachment }
  from '../application/assist-attachments.js';
import { archiveAssistSession, deleteAssistSession, forkAssistSession, renameAssistSession,
  reopenAssistSession, setAssistSessionPin, setAssistSessionUnread }
  from '../application/assist-session-controls.js';
import { listAssistMessages, listAssistProposals, listAssistSessions, readAssistProposal,
  readAssistSession, readAssistSessionContexts, projectAssistSkillMessage, readAssistLivePreview,
  listAssistMessageAttachmentMeta, readAssistMessageAttachment,
  type AssistMessageAttachmentMeta }
  from '../application/assist-queries.js';
import { listAssistMessageRecallSummaries, readAssistMessageRecall, recallAssistMessage,
  readAssistMessageRecallUndo, readMessageRecallSettings, undoAssistMessageRecall,
  type AssistMessageRecallSummary } from '../application/assist-message-recall.js';
import { resourceNotFound } from '../application/domain-error.js';
import { readSessionToolCalls } from '../application/session-tool-call-projection.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { AssistSessionStatus, ConversationMode } from '../infrastructure/database-schema.js';
import { MODEL_ERROR_CATEGORIES, type ModelErrorCategory }
  from '../workflow/model-error-classification.js';
import { readDeclaredImageInput } from '../workflow/model-port-config.js';
import { toDecimalString } from '../shared/decimal.js';
import { commandEnvelopeSchema, ConversationDiffFileSchema, ConversationDiffSchema } from './domain-schemas.js';
import { createCommandHandler, sendReadError, type RouteDependencies } from './envelope.js';
import { sendAssistLivePreviewStream } from './preview-events-api.js';

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: 'uuid' });
const rev = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
const text = Type.String({ minLength: 1, maxLength: 32_768 });
/**
 * 消息正文。与 `text` 的唯一差别是允许空串：带图片附件的讨论轮可以只有图片
 * （HTTP §10.85，2026-10-18）。是否真的允许空正文由用例裁决——schema 只锁上限与形状，
 * 无附件时空正文仍在用例层按既有 `must not be empty` 拒绝。
 */
const assistMessageContent = Type.String({ maxLength: 32_768 });
const base = Type.Object({ workspace_id: uuid }, strict);
const sessionItem = Type.Object({ workspace_id: uuid, id: uuid }, strict);
/** 会话 diff 的范围参数：省略＝会话口径（只算本会话落盘的路径）。 */
const conversationDiffScopeQuery = Type.Object({
  scope: Type.Optional(Type.Union([Type.Literal('SESSION'), Type.Literal('DIRECTORY')])),
}, strict);
const proposalItem = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const messageItem = Type.Object({ workspace_id: uuid, id: uuid }, strict);
const attachmentItem = Type.Object({ workspace_id: uuid, id: uuid, attachment_id: uuid }, strict);
const livePreviewItem = Type.Object({ workspace_id: uuid, id: uuid,
  message_id: uuid }, strict);

const AssistSessionDto = Type.Object({
  id: uuid, workspace_id: uuid,
  project_id: Type.Union([uuid, Type.Null()]),
  task_id: Type.Union([uuid, Type.Null()]),
  title: Type.String(), status: Type.String(), revision: rev,
  /** 0090：置顶时刻（导航排序键，不是业务事实）。未置顶为 null。 */
  pinned_at: Type.Union([Type.String(), Type.Null()]),
  /** 0104：未读标记时刻（导航标记，不是业务事实）。已读为 null。 */
  unread_at: Type.Union([Type.String(), Type.Null()]),
  /** 0111：最后一条消息落库或生成结算的时刻（活动排序键）。还没有消息为 null。 */
  last_message_at: Type.Union([Type.String(), Type.Null()]),
  /** 冻结的会话身份：'AGENT' 普通会话，'ASSISTANT' 人设 助手会话，'LEARNING' 学习会话。 */
  conversation_mode: Type.Union([Type.Literal('AGENT'), Type.Literal('ASSISTANT'), Type.Literal('LEARNING')]),
  /**
   * 0127：行为模式（普通讨论 / 只读规划 / 持续目标）。
   *
   * 与会话身份分开：它可随命令切换，不改变身份、权限或工具准入来源。
   * 客户端只读这个字段决定显示哪个模式，不保存自己的运行状态。
   */
  chat_mode: Type.Union([Type.Literal('CHAT'), Type.Literal('PLAN'), Type.Literal('GOAL')]),
  assistant_profile_id: Type.Union([uuid, Type.Null()]),
  /** 建会话时冻结的 助手 修订；AGENT 会话恒为 null。 */
  assistant_profile_revision: Type.Union([rev, Type.Null()]),
  /** 冻结的人设文本：只含文本，不含任何能力或连接信息。 */
  assistant_role: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
  remember: Type.Boolean(),
  /** 0087：本会话当前绑定的受管工作目录；未绑定为 null。作用域不是准入。 */
  working_resource_id: Type.Union([uuid, Type.Null()]),
  /** 0113：这条会话是哪一次分叉产生的；不是分叉来的为 null。来源只解释标题，不改变任何判定。 */
  forked_from_session_id: Type.Union([uuid, Type.Null()]),
  context: Type.Optional(Type.Object({
    project_goals: Type.Array(Type.Object({ goal_id: uuid, title: Type.String() }, strict)),
    working_directory: Type.Union([Type.Null(), Type.Object({ resource_id: uuid,
      canonical_root: Type.Union([Type.String(), Type.Null()]),
      source: Type.Union([Type.Literal('USER_PICKED'), Type.Literal('WORKSPACE_DEFAULT'), Type.Null()]) }, strict)]),
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
const assistRecallStatus = Type.Union([Type.Literal('RUNNING'), Type.Literal('COMPLETED'),
  Type.Literal('PARTIAL'), Type.Literal('FAILED')]);
/** 0132：消息列表用的撤回摘要；逐文件结果只在回执端点读取。 */
const AssistMessageRecallSummaryDto = Type.Object({
  id: uuid, message_id: uuid, assistant_message_id: uuid, status: assistRecallStatus,
  planned_files: Type.Integer({ minimum: 0 }),
  restored_files: Type.Integer({ minimum: 0 }),
  skipped_files: Type.Integer({ minimum: 0 }),
  completed_at: Type.Union([Type.String(), Type.Null()]),
}, strict);
/** 0132：一次消息撤回的逐文件结果。detail 只是摘要，事实以 files 为准。 */
const AssistMessageRecallDto = Type.Object({
  id: uuid, message_id: uuid, assistant_message_id: uuid,
  status: assistRecallStatus,
  root_path: Type.Union([Type.String(), Type.Null()]),
  planned_files: Type.Integer({ minimum: 0 }),
  restored_files: Type.Integer({ minimum: 0 }),
  skipped_files: Type.Integer({ minimum: 0 }),
  detail: Type.Object({}, { additionalProperties: true }),
  requested_at: Type.String(), completed_at: Type.Union([Type.String(), Type.Null()]),
  files: Type.Array(Type.Object({
    path: Type.String(), status: Type.String(),
    reason: Type.Union([Type.String(), Type.Null()]),
    baseline: Type.Union([Type.Literal('PRESENT'), Type.Literal('ABSENT')]),
    baseline_sha256: Type.Union([Type.String(), Type.Null()]),
  }, strict)),
}, strict);
/** 0132（§27.3.3）：一次「撤销这次回退」的回执；files 为逐文件预检与恢复结果。 */
const AssistMessageRecallUndoDto = Type.Object({
  id: uuid, source_recall_id: uuid, status: assistRecallStatus,
  root_path: Type.String(),
  detail: Type.Object({}, { additionalProperties: true }),
  requested_at: Type.String(), completed_at: Type.Union([Type.String(), Type.Null()]),
  files: Type.Array(Type.Object({
    path: Type.String(), status: Type.String(),
    reason: Type.Union([Type.String(), Type.Null()]),
  }, strict)),
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
  /** 0122：这条排队消息已被请求「插话」到正在生成的那一轮；生成方消费前为 true。 */
  steer_requested: Type.Boolean(),
  /** 0093：随这条消息发送的图片附件元数据（内容按单张另行读取）。 */
  attachments: Type.Array(Type.Object({
    id: uuid, name: Type.String(), media_type: Type.String(),
    byte_length: Type.Integer({ minimum: 1 }),
  }, strict)),
  /** 0132：撤回标记。原文与工具记录仍返回；客户端按 withdrawn_at 显示占位。 */
  withdrawn_at: Type.Union([Type.String(), Type.Null()]),
  withdrawn_by_recall_id: Type.Union([uuid, Type.Null()]),
  /** 0132：这条消息（或其直接回复）触发的撤回摘要；没有撤回为 null。 */
  recall: Type.Union([AssistMessageRecallSummaryDto, Type.Null()]),
  created_at: Type.String(), updated_at: Type.String(),
}, strict);
const AssistLivePreviewDto = Type.Object({
  session_id: uuid, message_id: uuid,
  status: Type.Union([Type.Literal('PENDING'), Type.Literal('RUNNING'),
    Type.Literal('COMPLETED'), Type.Literal('FAILED'), Type.Literal('CANCELLED')]),
  preview_revision: rev, preview_text: Type.Union([Type.String(), Type.Null()]),
  preview_truncated: Type.Boolean(), preview_available: Type.Boolean(),
}, strict);
/**
 * 会话工具轮次（工作台 §18.10「原消息下展示实际阶段」）。`arguments` 是开放对象，内容由
 * 具体工具决定，投影不新增解释字段；一行摘要由前端现算。与 Run 的工具轨迹刻意不同形——
 * 两张表、两种身份。这里没有模型推理文本：那张表不存它，现行禁令也不因此改变。
 */
const AssistSessionToolCallsDto = Type.Object({
  session_id: uuid, message_id: uuid, message_status: Type.String(),
  rounds: Type.Array(Type.Object({
    round: Type.Integer({ minimum: 0 }),
    calls: Type.Array(Type.Object({
      id: uuid, round: Type.Integer({ minimum: 0 }), ordinal: Type.Integer({ minimum: 0 }),
      tool_name: Type.String(),
      status: Type.Union([Type.Literal('REQUESTED'), Type.Literal('SETTLED'),
        Type.Literal('REJECTED'), Type.Literal('ABANDONED'), Type.Literal('UNKNOWN')]),
      arguments: Type.Object({}, { additionalProperties: true }),
      arguments_sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
      provider_tool_call_id: Type.Union([Type.String(), Type.Null()]),
      operation_id: Type.Union([uuid, Type.Null()]),
      rejection_reason: Type.Union([Type.String(), Type.Null()]),
      rejection_detail: Type.Union([Type.String(), Type.Null()]),
      result_digest: Type.Union([Type.String(), Type.Null()]),
      requested_at: Type.String(), settled_at: Type.Union([Type.String(), Type.Null()]),
    }, strict)),
  }, strict)),
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
  /**
   * 0127：新会话的行为模式；缺省 CHAT（旧客户端不受影响）。
   * 只用于「空会话里直接发 `/plan 内容`」这条路径，不改变会话身份。
   */
  chat_mode: Type.Optional(Type.Union([Type.Literal('CHAT'), Type.Literal('PLAN'),
    Type.Literal('GOAL')])),
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
 * 0090 / 0104 / 0113 会话行内控制：改名/置顶/未读/归档/重开/分叉都只带 `expected_revision`，
 * 不接收别的字段。标题沿用建会话的 1–200 规则；归档、重开与分叉没有可携带的载荷，多余字段一律拒绝，
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
/** ADR-027：删除回执。`revision` 是删除前被核对过的那个修订，行本身已不存在。 */
const SessionDeleteResult = Type.Object({
  session_id: uuid, revision: rev,
  deleted_messages: Type.Integer({ minimum: 0 }),
  deleted_attachments: Type.Integer({ minimum: 0 }),
  deleted_at: Type.String(),
}, strict);
/**
 * 0113 分叉结果：`session_id` 是**新建的子会话**（命令目标才是源会话）。
 * `copied_messages` 为 0 不是失败——空讨论分叉就是一条新的空讨论。
 */
const SessionForkResult = Type.Object({
  session_id: uuid, title: Type.String(), revision: rev, updated_at: Type.String(),
  copied_messages: Type.Integer({ minimum: 0 }),
}, strict);
const messagesQuery = Type.Object({ limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]{1,2}|200)$' })) }, strict);
const sourceRef = Type.Object({
  kind: Type.Union([Type.Literal('KNOWLEDGE'), Type.Literal('MEMORY'), Type.Literal('DECISION')]),
  root_id: uuid, version: Type.String({ pattern: '^[1-9][0-9]*$' }),
}, strict);
const requestMessageBody = Type.Object({
  /**
   * 0127：这条消息按哪种行为模式受理。缺省沿用会话已保存的模式。
   *
   * `/plan 内容`、`/goal 内容` 发送时由客户端解析成「模式 + 正文」一次提交，
   * 因此「命令发送后生效」和「模式与消息同一次事务」同时成立。
   */
  chat_mode: Type.Optional(Type.Union([Type.Literal('CHAT'), Type.Literal('PLAN'),
    Type.Literal('GOAL')])),
  command_id: uuid, content: assistMessageContent,
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
/** 0093：单张附件内容的只读投影（与上传返回同一身份字段，另加内容与名字/类型）。 */
const AttachmentContent = Type.Object({
  attachment_id: uuid, name: Type.String(), media_type: Type.String(),
  byte_length: Type.Integer({ minimum: 1 }), data_base64: Type.String(),
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
  last_message_at: Date | null;
  conversation_mode: ConversationMode; chat_mode: 'CHAT' | 'PLAN' | 'GOAL';
  assistant_profile_id: string | null;
  assistant_profile_revision: bigint | null; assistant_role_snapshot: JsonObject | null;
  remember: boolean; working_resource_id: string | null;
  forked_from_session_id: string | null; created_at: Date; updated_at: Date }) {
  return {
    id: row.id, workspace_id: row.workspace_id, project_id: row.project_id,
    task_id: row.task_id, title: row.title, status: row.status,
    revision: toDecimalString(row.revision),
    // 置顶时刻逐字返回：客户端据此排序并显示「已置顶」，不自行推断。
    pinned_at: row.pinned_at === null ? null : row.pinned_at.toISOString(),
    // 0104：未读时刻同样逐字返回。NULL=已读，界面不替服务端猜「看过就算读」。
    unread_at: row.unread_at === null ? null : row.unread_at.toISOString(),
    // 0111：活动排序键逐字返回。NULL 只表示这段会话还没有消息，顺序仍由服务端决定。
    last_message_at: row.last_message_at === null ? null : row.last_message_at.toISOString(),
    conversation_mode: row.conversation_mode,
    chat_mode: row.chat_mode,
    assistant_profile_id: row.assistant_profile_id,
    assistant_profile_revision: row.assistant_profile_revision === null ? null
      : toDecimalString(row.assistant_profile_revision),
    // 人设快照逐字返回：客户端显示的就是这条会话建立时的人设，不读当前助手。
    assistant_role: row.assistant_role_snapshot,
    remember: row.remember,
    // 0087：会话当前绑定的受管目录。只读投影——作用域不是准入，客户端据此显示
    // 「这次会读哪个目录」，不代表这次读取一定会被放行。
    working_resource_id: row.working_resource_id,
    // 0113：分叉来源逐字返回。它只解释标题里那个「（1）」从哪来，不参与任何判定。
    forked_from_session_id: row.forked_from_session_id,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  };
}

function messageDto(row: { id: string; session_id: string; seq: bigint; role: string;
  status: string; intent: string; content: string | null; error_code: string | null;
  provider_error_kind: ModelErrorCategory | null;
  sources: unknown; provider_request_id: string | null; usage_input_tokens: number | null;
  usage_output_tokens: number | null; usage_cache_read_tokens: number | null;
  usage_cache_creation_tokens: number | null; cancel_requested: boolean;
  steer_requested: boolean;
  withdrawn_at: Date | null; withdrawn_by_recall_id: string | null;
  created_at: Date; updated_at: Date },
  projection: { skill: JsonObject | null; skill_input: JsonObject | null;
    skill_output: JsonObject | null; content: string | null; sources: unknown;
    method: JsonObject | null; method_argument: string | null },
  attachments: readonly AssistMessageAttachmentMeta[] = [],
  recall: AssistMessageRecallSummary | null = null) {
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
    steer_requested: row.steer_requested,
    attachments: attachments.map((item) => ({ id: item.id, name: item.name,
      media_type: item.mediaType, byte_length: item.byteLength })),
    withdrawn_at: row.withdrawn_at === null ? null : row.withdrawn_at.toISOString(),
    withdrawn_by_recall_id: row.withdrawn_by_recall_id,
    recall: recall === null ? null : recallSummaryDto(recall),
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  };
}

function recallSummaryDto(recall: AssistMessageRecallSummary) {
  return { id: recall.id, message_id: recall.message_id,
    assistant_message_id: recall.assistant_message_id, status: recall.status,
    planned_files: recall.planned_files, restored_files: recall.restored_files,
    skipped_files: recall.skipped_files, completed_at: recall.completed_at };
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

  // ADR-027：物理删除。不可撤销、没有回收站；被其它对象引用的会话整条拒绝（409
  // SESSION_DELETE_BLOCKED），不提供强制删除开关。归档与删除是两条通道。
  app.post('/assist-sessions/:id/delete', { schema: { params: sessionItem,
    body: sessionStateBody, response: { 200: commandEnvelopeSchema(SessionDeleteResult) } } },
  createCommandHandler(dependencies, { commandType: 'DeleteAssistSession',
    bodySchema: sessionStateBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await deleteAssistSession(executor, {
        workspaceId: params.workspace_id ?? '', sessionId: params.id ?? '',
        commandId: body.command_id, expectedRevision: body.expected_revision });
      return { outcome, result: outcome.result };
    } }));

  // 0113：分叉。与上面几条不同，它不改源会话，而是新建一条带历史的子会话，因此按新建资源给 201，
  // 回执的资源链接指向子会话（命令目标仍是源会话）。源会话有消息在途时按状态冲突拒绝。
  app.post('/assist-sessions/:id/fork', { schema: { params: sessionItem,
    body: sessionStateBody, response: { 201: commandEnvelopeSchema(SessionForkResult) } } },
  createCommandHandler(dependencies, { commandType: 'ForkAssistSession',
    bodySchema: sessionStateBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await forkAssistSession(executor, {
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

  // 0093：读一张附件的内容（工作台 §33.3 历史消息缩略图）。只读、不改业务状态；
  // 归属同时核对 workspace 与 session，跨会话引用按 404 拒绝。内容以 base64 返回，
  // 与上传端点同一种传输形状，客户端不需要第二套二进制读法。
  app.get('/assist-sessions/:id/message-attachments/:attachment_id', {
    schema: { params: attachmentItem, response: { 200: AttachmentContent } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string; attachment_id: string };
      const attachment = await readAssistMessageAttachment(dependencies.database.executor, {
        workspaceId: p.workspace_id, sessionId: p.id ?? '', attachmentId: p.attachment_id });
      // 用例层用 camelCase，响应按 HTTP 契约的 snake_case 投影：schema 会丢掉未声明字段，
      // 直接把用例对象返回会让客户端读到空响应体。
      reply.header('Cache-Control', 'private, max-age=300');
      return { attachment_id: attachment.attachmentId, name: attachment.name,
        media_type: attachment.mediaType, byte_length: attachment.byteLength,
        data_base64: attachment.dataBase64 };
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  // 异步生成：202 只代表消息已排队；回复以 GET messages 的 ASSISTANT 行状态为准。
  app.post('/assist-sessions/:id/messages', { schema: { params: sessionItem,    body: requestMessageBody,
    response: { 202: commandEnvelopeSchema(Type.Object({
      session_id: uuid, user_message_id: uuid, assistant_message_id: uuid,
      /** 0127：受理时的行为模式与目标归属；旧客户端忽略这两个字段即可。 */
      chat_mode: Type.Optional(Type.Union([Type.Literal('CHAT'), Type.Literal('PLAN'),
        Type.Literal('GOAL')])),
      goal_id: Type.Optional(Type.Union([uuid, Type.Null()])),
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
        ...(body.chat_mode === undefined ? {} : { chatMode: body.chat_mode }),
        // 0093：能力闸门的裁决输入——当前聊天恒由进程默认连接服务（见闸门注释）。
        // 0121：声明来源按 (provider, model) 查声明表；目录无条目时才看声明与环境变量。
        chatModelName: process.env.RELAY_MODEL_NAME,
        modelProvider: process.env.RELAY_MODEL_PROVIDER ?? 'openai-compatible',
        declaredImageInput: readDeclaredImageInput(process.env),
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
      // 0093：附件元数据按会话一次性取齐（只读 id/名/类型/字节数，不读内容字节），
      // 再按 message_id 归到各自消息上——不为每条消息各发一次查询。
      const attachments = await listAssistMessageAttachmentMeta(
        dependencies.database.executor, { workspaceId: p.workspace_id,
          sessionId: p.id ?? '', messageIds: rows.map((row) => row.id) });
      // 0132：撤回摘要按消息一次性取齐，目标用户消息与其直接回复共用同一条回执。
      const recalls = await listAssistMessageRecallSummaries(
        dependencies.database.executor, p.id ?? '');
      const recallByMessage = new Map<string, AssistMessageRecallSummary>();
      for (const recall of recalls) {
        recallByMessage.set(recall.message_id, recall);
        recallByMessage.set(recall.assistant_message_id, recall);
      }
      return { items: await Promise.all(rows.map(async (row) => messageDto(row,
        await projectAssistSkillMessage(dependencies.database.executor,
          dependencies.storage, session, row),
        attachments.get(row.id) ?? [], recallByMessage.get(row.id) ?? null))) };
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

  // 会话工具轮次只读投影（工作台 §18.10）：这条回复实际请求过哪些工具、各自结算没有。
  // 只读、不派发、不改任何一行状态；账本此前只有写入口，界面上因此只剩一个「正在生成」。
  app.get('/assist-sessions/:id/messages/:message_id/tool-calls', {
    schema: { params: livePreviewItem, response: { 200: AssistSessionToolCallsDto } },
  }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string;
        message_id: string };
      reply.header('Cache-Control', 'no-store');
      return await readSessionToolCalls(dependencies.database.executor,
        { workspaceId: p.workspace_id, sessionId: p.id, messageId: p.message_id });
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  // 生成中预览 SSE（§10.59）：帧体与 GET live-preview 同形；每次推送前重新授权。
  app.get('/assist-sessions/:id/messages/:message_id/live-preview/events', {
    schema: { params: livePreviewItem },
  }, async (request, reply) => {
    const p = request.params as { workspace_id: string; id: string;
      message_id: string };
    return sendAssistLivePreviewStream(request, reply, dependencies.database.executor,
      dependencies.storage, p.workspace_id, p.id, p.message_id);
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

  /* 0122：排队消息的「插话」。与取消同一形状（同一条消息、同一个 command_id 幂等），
     语义相反：取消让这一行结束，插话让正在生成的那一轮多跑一步并带上它的原文。 */
  app.post('/assist-messages/:id/steer', { schema: { params: messageItem, body: cancelBody,
    response: { 200: commandEnvelopeSchema(Type.Object({
      message_id: uuid, status: Type.String(),
    }, strict)) } } },
  createCommandHandler(dependencies, { commandType: 'SteerAssistMessage',
    bodySchema: cancelBody,
    execute: async ({ executor, params, body }) => {
      const outcome = await steerAssistMessage(executor, {
        workspaceId: params.workspace_id ?? '', messageId: params.id ?? '',
        commandId: body.command_id });
      return { outcome, result: outcome.result };
    } }));

  /* 0132：撤回一条用户消息，并回退这条消息之后本会话关联的文件写入。
     范围、前像与逐路径结果由用例裁决；这里只负责 HTTP 表达与回执读取。 */
  app.post('/assist-messages/:id/recall', { schema: { params: messageItem, body: cancelBody,
    response: { 200: commandEnvelopeSchema(AssistMessageRecallDto) } } },
  createCommandHandler(dependencies, { commandType: 'RecallAssistMessage',
    bodySchema: cancelBody,
    execute: async ({ executor, params, body }) => {
      const { recall, replayed } = await recallAssistMessage(executor, {
        workspaceId: params.workspace_id ?? '', messageId: params.id ?? '',
        commandId: body.command_id });
      const result = recall as unknown as JsonObject;
      return { outcome: { result, replayed,
        committedAt: new Date(recall.requested_at) }, result };
    } }));

  app.get('/assist-messages/:id/recall', { schema: { params: messageItem,
    response: { 200: AssistMessageRecallDto } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      const recall = await readAssistMessageRecall(
        dependencies.database.executor, p.workspace_id, p.id ?? '');
      if (recall === undefined) throw resourceNotFound('Assist message recall');
      return recall;
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  /* 0132（§27.3.3）：撤销最近一次完整成功的撤回——把其实际触及的文件恢复到该次
     撤回开始写入前的内容（保护副本）。单层：同一撤回至多一条撤销，撤销本身不可再反向。 */
  app.post('/assist-message-recalls/:id/undo', { schema: {
    params: messageItem, body: cancelBody,
    response: { 200: commandEnvelopeSchema(AssistMessageRecallUndoDto) } } },
  createCommandHandler(dependencies, { commandType: 'UndoAssistMessageRecall',
    bodySchema: cancelBody,
    execute: async ({ executor, params, body }) => {
      const { undo, replayed } = await undoAssistMessageRecall(executor, {
        workspaceId: params.workspace_id ?? '', recallId: params.id ?? '',
        commandId: body.command_id });
      const result = undo as unknown as JsonObject;
      return { outcome: { result, replayed,
        committedAt: new Date(undo.requested_at) }, result };
    } }));

  /* 0132（§27.3.4）：快照容量与保留的生效配置、实际占用与最旧快照（可恢复时段）。 */
  app.get('/message-recall/settings', { schema: { params: base, response: { 200:
    Type.Object({
      retention_days: Type.Integer({ minimum: 0 }),
      capacity_bytes: Type.Integer({ minimum: 1 }),
      per_file_cap_bytes: Type.Integer({ minimum: 1 }),
      usage_bytes: Type.String(),
      snapshot_count: Type.Integer({ minimum: 0 }),
      oldest_snapshot_at: Type.Union([Type.String(), Type.Null()]),
    }, strict) } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string };
      return await readMessageRecallSettings(dependencies.database.executor, p.workspace_id);
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

  app.get('/assist-message-recalls/:id/undo', { schema: { params: messageItem,
    response: { 200: AssistMessageRecallUndoDto } } }, async (request, reply) => {
    try {
      const p = request.params as { workspace_id: string; id: string };
      const undo = await readAssistMessageRecallUndo(
        dependencies.database.executor, p.workspace_id, p.id ?? '');
      if (undo === undefined) throw resourceNotFound('Assist message recall undo');
      return undo;
    } catch (error) { return sendReadError(reply, error, request.id); }
  });

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
    scope: diff.scope,
    baseline_captured_at: diff.baselineCapturedAt,
    baseline_revision: diff.baselineRevision.toString(),
    root_path: diff.rootPath,
    resource_id: diff.resourceId,
    incomplete: diff.incomplete,
    coverage: {
      baseline: { complete: diff.coverage.baseline.complete,
        reason: diff.coverage.baseline.reason, files: diff.coverage.baseline.files,
        listed: diff.coverage.baseline.listed },
      current: { complete: diff.coverage.current.complete,
        reason: diff.coverage.current.reason, files: diff.coverage.current.files,
        listed: diff.coverage.current.listed },
      unchecked_files: diff.coverage.uncheckedFiles,
      unverified_files: diff.coverage.unverifiedFiles,
      unverifiable_files: diff.coverage.unverifiableFiles,
      unscanned_files: diff.coverage.unscannedFiles,
    },
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
  schema: { params: sessionItem, querystring: conversationDiffScopeQuery,
    response: { 200: ConversationDiffSchema } },
}, async (request, reply) => {
  try {
    const p = request.params as { workspace_id: string; id: string };
    const query = request.query as { scope?: 'SESSION' | 'DIRECTORY' };
    reply.header('Cache-Control', 'no-store');
    const result = await readConversationDiff(createRepositories(dependencies.database.executor), {
      workspaceId: p.workspace_id, sessionId: p.id,
      ...(query.scope === undefined ? {} : { scope: query.scope }),
    });
    return conversationDiffDto(result);
  } catch (error) { return sendReadError(reply, error, request.id); }
});

// CD-18：展开阅读——单文件的逐行完整 diff（与总数同一份基线修订 + 同一份当前快照）。
app.get('/assist-sessions/:id/conversation-diff/file', {
  schema: { params: sessionItem,
    querystring: Type.Object({ path: Type.String({ minLength: 1 }),
      scope: Type.Optional(Type.Union([Type.Literal('SESSION'), Type.Literal('DIRECTORY')])) }, strict),
    response: { 200: ConversationDiffFileSchema } },
}, async (request, reply) => {
  try {
    const p = request.params as { workspace_id: string; id: string };
    const query = request.query as { path: string; scope?: 'SESSION' | 'DIRECTORY' };
    reply.header('Cache-Control', 'no-store');
    const result = await readConversationDiffFile(createRepositories(dependencies.database.executor), {
      workspaceId: p.workspace_id, sessionId: p.id, path: query.path,
      ...(query.scope === undefined ? {} : { scope: query.scope }),
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
