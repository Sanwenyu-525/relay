import { sql } from 'kysely';

import type { AssistMessageRecallSummary } from './assist-message-recall.js';
import { listAssistMessageRecallSummaries } from './assist-message-recall.js';
import type { SessionToolCallRow } from '../assist/session-tool-call-repository.js';
import { SessionToolCallRepository } from '../assist/session-tool-call-repository.js';
import type { AssistMessageRow, ModelCallRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
import { ModelCallRepository } from '../model/model-call-repository.js';
import { toDecimalString } from '../shared/decimal.js';
import { readSessionContextUsage } from './assist-context-projection.js';
import { readAssistSessionWithActivity } from './assist-queries.js';
import { projectSessionToolCalls } from './session-tool-call-projection.js';
import { createRepositories, type Repositories } from './unit-of-work.js';

/**
 * 会话导出的只读聚合（`GET /assist-sessions/:id/export`）。
 *
 * 这份文档回答的是「这段讨论到底发生了什么」：消息原文、每轮真实调用过哪些工具、工具是被拒
 * 还是结算、清单走到哪一步、上下文按哪一档走、发出去的执行请求停在哪个阶段。全部字段都来自
 * 已有的权威行与已有投影，没有一处由模型重新总结，也没有一处从界面百分比反推。
 *
 * 四条不能让步的口径：
 *   1. **只读。** 不派发工具、不写库、不推进修订。整份导出跑在一个 `READ ONLY` +
 *      `REPEATABLE READ` 事务里，所以「在途」的那几行描述的是同一时刻的事实，而不是边读
 *      边变之后再拼起来的矛盾快照（会话此刻可能正在生成）。
 *   2. **不静默截断。** 每一类集合都带 `{ total, exported, limit, truncated, reason }`；
 *      超过安全上限时明说这是部分导出，读的人不会把残缺当完整。
 *   3. **没有的事实不补。** 工具结果正文、Todo 变更历史、模型私有推理在这些表里根本不存在，
 *      导出里就只有账本给得出的那几列，并写明缺什么、为什么缺。
 *   4. **凭据字段默认脱敏，正文不阉。** 结构化字段里命中凭据形状的一律替换；用户与 AI 的
 *      消息正文逐字保留（诊断要看原文），这一点在 `privacy` 里当面说明。
 */

/** 格式标识：外部读者先认这两个字段，再决定怎么解析后面的内容。 */
export const SESSION_EXPORT_FORMAT = 'relay-session-export';
export const SESSION_EXPORT_VERSION = '1.0';

/** 单次导出的安全上限：超过就报告部分导出，不为「完整」把进程压垮。 */
const MAX_EXPORT_MESSAGES = 2_000;
const MAX_EXPORT_COLLECTION_ROWS = 500;
/** 结构化字段里单个字符串的上限：文件写入类参数会把整段正文带进来。 */
const MAX_STRUCTURED_STRING_CHARS = 32_768;

const MISSING_TODO_HISTORY = 'assist_session_todo_events 是只追加的历史表，当前没有面向界面的合法读口；'
  + '导出只给此刻挂着的那份快照，不重放历史版本。';
const MISSING_TOOL_RESULT_BODY = 'session_tool_calls 只登记 result_digest（结算摘要），不保存工具结果正文；'
  + '界面与模型读到的都是当轮即时内容，事后无法从这张表还原。';

/** 聚合过程中的中间形状：允许保留 Date / bigint / Buffer，出文档前由 `jsonDocument` 收口。 */
type Draft = Record<string, unknown>;

/** `JsonObject` 的索引签名是只读的，逐键写入得用可变形状，交出时再收回 `JsonObject`。 */
type MutableJson = { [key: string]: JsonValue };

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── 脱敏 ────────────────────────────────────────────────────────────────

interface Tally { keyHits: number; valueHits: number }

/**
 * 键名命中即整值替换。只收「这一列本来就是凭据」的写法：`usage_input_tokens` 这类计量列
 * 必须留下，所以规则是精确名加明确的凭据后缀，不是「含 token 字样就删」。
 */
const SECRET_KEY_EXACT = new Set([
  'api_key', 'apikey', 'x_api_key', 'openai_api_key', 'anthropic_api_key', 'access_key',
  'secret_key', 'private_key', 'session_key', 'encryption_key', 'master_key', 'service_key',
  'developer_key', 'secret', 'client_secret', 'password', 'passwd', 'pwd', 'token',
  'access_token', 'refresh_token', 'id_token', 'bearer_token', 'auth_token', 'authorization',
  'credential', 'credentials', 'cookie', 'cookies', 'set_cookie',
]);
const SECRET_KEY_SUFFIXES = /_(?:api_key|access_key|secret_key|private_key|secret|token|password|credential)$/u;

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
  return SECRET_KEY_EXACT.has(normalized) || SECRET_KEY_SUFFIXES.test(normalized);
}

/**
 * 值形态的凭据：已知前缀的密钥、PEM 私钥、`Bearer` 与凭据头部行、URL 里的用户密码与查询参数。
 * 顺序是有意的——私钥块先整段吞掉，否则块内那一行 `MII...` 会被后面的规则切成碎片。
 */
const SECRET_VALUE_RULES: readonly { readonly pattern: RegExp; readonly replace: string }[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    replace: '[REDACTED:private_key]' },
  { pattern: /\b(?:sk|pk|sk-proj|sk-svcacct|sk-or-v1|sk-ant|ghp|gho|ghu|ghs|github_pat|xoxb|xoxp|xoxa|xoxr|xoxs|AKIA|ASIA|AIza)[A-Za-z0-9_-]{8,}\b/gu,
    replace: '[REDACTED:api_key]' },
  { pattern: /^([ \t]*(?:authorization|x-api-key|api-key|cookie|set-cookie|proxy-authorization)[ \t]*:[ \t]*).+/gimu,
    replace: '$1[REDACTED:credential]' },
  { pattern: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{12,}/giu, replace: 'Bearer [REDACTED:token]' },
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:)([^\s/@]{3,})@/giu, replace: '$1[REDACTED:password]@' },
  { pattern: /([?&](?:access_token|id_token|api_key|apikey|token|password|secret|signature)=)[^&\s"']+/giu,
    replace: '$1[REDACTED:credential]' },
  { pattern: /\b(api[_-]?key|access[_-]?key|secret|password|passwd|auth[_-]?token|access[_-]?token)([ \t]*[:=][ \t]*)(['"]?)[^\s'",;)}]{4,}\3/giu,
    replace: '$1$2$3[REDACTED:credential]$3' },
];

function redactText(text: string, tally: Tally): string {
  let out = text;
  for (const rule of SECRET_VALUE_RULES) out = out.replace(rule.pattern, rule.replace);
  if (out !== text) tally.valueHits += 1;
  return out;
}

/** 先脱敏再截断：截断标记因此总落在真正交出去那段的末尾，不会被替换说明盖住。 */
function capText(text: string, tally: Tally): string {
  const redacted = redactText(text, tally);
  return redacted.length <= MAX_STRUCTURED_STRING_CHARS ? redacted
    : `${redacted.slice(0, MAX_STRUCTURED_STRING_CHARS)}…[TRUNCATED:${redacted.length}]`;
}

/** 结构化值：按键名整值替换，其余递归；Date / bigint / Buffer 就地转成可序列化形状。 */
function sanitize(value: unknown, tally: Tally): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return capText(value, tally);
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return toDecimalString(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, tally));
  if (typeof value === 'object') {
    const out: MutableJson = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) {
        out[key] = '[REDACTED:credential]';
        tally.keyHits += 1;
        continue;
      }
      out[key] = sanitize(entry, tally);
    }
    return out;
  }
  return capText(String(value), tally);
}

function sanitizeObject(value: unknown, tally: Tally): JsonObject {
  const projected = sanitize(value ?? {}, tally);
  return isJsonObject(projected) ? projected : {};
}

/** 自由文本字段（拒绝说明、错误原因）按值脱敏；用户与 AI 的正文不走这条路。 */
function sanitizeNote(value: string | null, tally: Tally): string | null {
  return value === null ? null : capText(value, tally);
}

/**
 * 把聚合形状收成一份真正可序列化的 JSON 文档。
 *
 * 单独一道，而不是让每个字段自己记得转换：这些表上的列类型只会越来越多（0154 就往执行请求
 * 里加了 bytea 摘要）。漏掉一列 bigint，Fastify 会在 `JSON.stringify` 当场抛 TypeError，
 * 导出变成 500——而且只在某一种数据形状下才炸。这里只认 Date / bigint / Buffer 三种宿主
 * 类型，其余原样交出，所以既不重复脱敏，也不重写已经算好的字符串。
 */
function jsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return toDecimalString(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === 'object') {
    const out: MutableJson = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonValue(entry);
    }
    return out;
  }
  return String(value);
}

/** 文档根必须是对象：聚合给的就是对象，这里只把 `JsonValue` 联合收回成 `JsonObject`。 */
function jsonDocument(draft: Draft): JsonObject {
  const projected = jsonValue(draft);
  if (!isJsonObject(projected)) throw new Error('SESSION_EXPORT_DOCUMENT_INVALID');
  return projected;
}

// ── 分项 ────────────────────────────────────────────────────────────────

interface CollectionReport {
  readonly total: number;
  readonly exported: number;
  readonly limit: number;
  readonly truncated: boolean;
  readonly reason: string | null;
}

function report(total: number, exported: number, limit: number, subject: string): CollectionReport {
  const truncated = exported < total;
  return { total, exported, limit, truncated,
    reason: truncated
      ? `超过单次导出上限 ${limit} 条，本文件是部分导出：${subject}只含前 ${exported} 条。`
      : null };
}

/** 在途回复的即时草稿：它是「截至导出这一刻」唯一还看得见的部分，来源标注清楚。 */
async function livePreviewOf(executor: DbExecutor, row: AssistMessageRow): Promise<Draft | null> {
  if (row.role !== 'ASSISTANT' || (row.status !== 'PENDING' && row.status !== 'RUNNING')) return null;
  const preview = await createRepositories(executor).assist.readLivePreview(row.id);
  if (preview === undefined) return null;
  return { revision: preview.revision, truncated: preview.truncated,
    updated_at: preview.updated_at, text: preview.preview_text };
}

function recallDto(recall: AssistMessageRecallSummary | null): Draft | null {
  if (recall === null) return null;
  return { id: recall.id, status: recall.status, planned_files: recall.planned_files,
    restored_files: recall.restored_files, skipped_files: recall.skipped_files,
    requested_at: recall.requested_at, completed_at: recall.completed_at };
}

function messageDto(row: AssistMessageRow, attachments: readonly JsonValue[],
  recall: AssistMessageRecallSummary | null, preview: Draft | null, tally: Tally): Draft {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    status: row.status,
    intent: row.intent,
    chat_mode: row.chat_mode,
    // 正文逐字保留：导出文件的价值就在原文；凭据风险由 privacy.message_content 如实声明。
    content: row.content,
    error_code: row.error_code,
    provider_error_kind: row.provider_error_kind,
    provider_request_id: row.provider_request_id,
    usage: { input_tokens: row.usage_input_tokens, output_tokens: row.usage_output_tokens,
      cache_read_tokens: row.usage_cache_read_tokens,
      cache_creation_tokens: row.usage_cache_creation_tokens },
    goal_id: row.goal_id,
    goal_outcome: row.goal_outcome === null ? null : sanitizeObject(row.goal_outcome, tally),
    withdrawn_at: row.withdrawn_at,
    withdrawn_by_recall_id: row.withdrawn_by_recall_id,
    cancel_requested: row.cancel_requested,
    worker_id: row.worker_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    attachments,
    sources: sanitizeObject(row.sources, tally),
    recall: recallDto(recall),
    live_preview: preview,
  };
}

function modelCallDto(row: ModelCallRow, tally: Tally): Draft {
  return {
    id: row.id,
    assist_message_id: row.assist_message_id,
    kind: row.kind,
    purpose: row.purpose,
    provider: row.provider,
    model: row.model,
    config_fingerprint: row.config_fingerprint,
    status: row.status,
    error_kind: row.error_kind,
    provider_request_id: row.provider_request_id,
    usage: { input_tokens: row.usage_input_tokens, output_tokens: row.usage_output_tokens,
      cache_read_tokens: row.usage_cache_read_tokens,
      cache_creation_tokens: row.usage_cache_creation_tokens },
    reserved_tokens: row.budget_reserved_tokens,
    // 0145 的上下文分项只有分类与数值，本来就不含提示词与正文。
    context_breakdown: row.context_usage === null ? null : sanitizeObject(row.context_usage, tally),
    started_at: row.started_at,
    settled_at: row.settled_at,
  };
}

/**
 * 文件变更摘要只取**已落库**的两份事实，不调用会话 diff 的读取用例：
 * 后者要扫受管根并跑 git，那是另一条会碰工作区的通道，导出不为它开门。
 * 基线条目里带前像正文，这里只交出计数与身份，不搬正文。
 */
async function readFileChanges(r: Repositories, workspaceId: string, sessionId: string,
  resourceId: string | null): Promise<Draft> {
  if (resourceId === null) return { available: false, reason: 'NO_RESOURCE' };
  const resource = await r.gateway.readResource(resourceId);
  if (resource === undefined || resource.workspace_id !== workspaceId ||
      resource.status !== 'ACTIVE') {
    return { available: false, reason: 'RESOURCE_UNAVAILABLE', resource_id: resourceId };
  }
  const baseline = await r.conversationDiff.readLatestBaseline(workspaceId, sessionId,
    resourceId, resource.canonical_root);
  const written = await r.conversationDiff.listWrittenPaths(workspaceId, sessionId,
    resource.canonical_root);
  const paths = written.slice(0, MAX_EXPORT_COLLECTION_ROWS);
  return {
    available: true,
    resource_id: resourceId,
    root_path: resource.canonical_root,
    baseline: baseline === undefined ? null : {
      captured_at: baseline.capturedAt, file_count: baseline.files.length,
      incomplete: baseline.incomplete, capture_reason: baseline.captureReason,
      revision: baseline.revision,
    },
    written_paths: paths,
    written_paths_truncated: written.length > paths.length,
    note: 'written_paths 是本会话落过盘的路径集合（来自变更集与会话账本），不含逐行差异；'
      + '逐行差异要在工作区侧另读，导出不代替。',
  };
}

// ── 导出主体 ─────────────────────────────────────────────────────────────

/**
 * 只读导出。归属口径与其它 Assist 读取一致：跨 Workspace 与不存在同样按不可见处理（404）。
 *
 * 一致性：先在事务外确认会话可见，再把全部读取放进一个 `READ ONLY` + `REPEATABLE READ`
 * 事务。只读事务不加行锁，不会挡住正在写这一轮的执行方；同一快照则保证消息状态、工具账本、
 * 清单与执行请求描述的是同一时刻，而不是各自读一次之后再拼。
 */
export async function exportAssistSession(db: DbExecutor, input: {
  workspaceId: string; sessionId: string;
}): Promise<JsonObject> {
  await readAssistSessionWithActivity(db, input);
  return db.transaction().execute(async (trx) => {
    // 必须是事务里的第一条语句：Postgres 不允许已经跑过查询之后再设隔离级别。
    await sql`set transaction isolation level repeatable read read only`.execute(trx);
    return buildExport(trx, input);
  });
}

async function buildExport(executor: DbExecutor, input: {
  workspaceId: string; sessionId: string;
}): Promise<JsonObject> {
  const r = createRepositories(executor);
  const tally: Tally = { keyHits: 0, valueHits: 0 };
  const { session, hasMessages, runState, listState } =
    await readAssistSessionWithActivity(executor, input);

  const messageRows = await r.assist.listMessages(session.id);
  const exportedMessages = messageRows.slice(0, MAX_EXPORT_MESSAGES);
  const messageIds = exportedMessages.map((row) => row.id);

  // 附件只到元数据：内容字节要走显式的附件读取端点，不把二进制塞进诊断文件。
  const attachmentRows = messageIds.length === 0 ? []
    : await r.assist.listAttachmentMetaByMessages(session.id, messageIds);
  const attachmentsByMessage = new Map<string, JsonValue[]>();
  for (const row of attachmentRows) {
    if (row.message_id === null) continue;
    const list = attachmentsByMessage.get(row.message_id) ?? [];
    list.push({ id: row.id, name: row.name, media_type: row.media_type,
      byte_length: row.byte_length });
    attachmentsByMessage.set(row.message_id, list);
  }

  const recallByMessage = new Map<string, AssistMessageRecallSummary>();
  for (const recall of await listAssistMessageRecallSummaries(executor, session.id)) {
    recallByMessage.set(recall.message_id, recall);
    recallByMessage.set(recall.assistant_message_id, recall);
  }

  const previews = await Promise.all(exportedMessages.map((row) => livePreviewOf(executor, row)));
  const messages = exportedMessages.map((row, index) => messageDto(row,
    attachmentsByMessage.get(row.id) ?? [], recallByMessage.get(row.id) ?? null,
    previews[index] ?? null, tally));

  // 工具账本按消息归组后复用界面同一个投影函数：两处形状必须一致，外部读者不必认两套。
  const allToolCallRows = await new SessionToolCallRepository(executor).listBySession(session.id);
  const toolCallRows = allToolCallRows.slice(0, MAX_EXPORT_COLLECTION_ROWS);
  const statusByMessage = new Map(exportedMessages.map((row) => [row.id, row.status]));
  // 账本里可能挂着本文件没有导出消息的行：被截断的那一段，以及 0122 那类「插话被消费」的占位
  // 回复（`listMessages` 刻意不列它）。轮次仍是真实证据，逐条回读消息行拿状态；回读不到才写 null。
  const byMessage = new Map<string, SessionToolCallRow[]>();
  for (const row of toolCallRows) {
    const bucket = byMessage.get(row.message_id);
    if (bucket === undefined) byMessage.set(row.message_id, [row]);
    else bucket.push(row);
  }
  const toolCallGroups: Draft[] = [];
  for (const [messageId, rows] of byMessage) {
    const status = statusByMessage.get(messageId)
      ?? (await r.assist.readMessage(messageId))?.status ?? null;
    const projected = projectSessionToolCalls(session.id, messageId, status ?? 'CANCELLED', rows);
    toolCallGroups.push({
      message_id: messageId,
      message_status: status,
      rounds: projected.rounds.map((round) => ({
        round: round.round,
        calls: round.calls.map((call) => ({
          ...call,
          arguments: sanitizeObject(call.arguments, tally),
          rejection_detail: sanitizeNote(call.rejection_detail, tally),
        })),
      })),
    });
  }

  const modelCallRows = await new ModelCallRepository(executor).listForAssistMessages(messageIds);
  const modelCalls = modelCallRows.slice(0, MAX_EXPORT_COLLECTION_ROWS)
    .map((row) => modelCallDto(row, tally));

  // 多取一条只为了知道「有没有被上限切掉」，不把这一条冒充成会话里真实存在的第 N+1 项。
  const executionRows = await r.conversationExecutions
    .listSessionRequests(input.workspaceId, session.id, MAX_EXPORT_COLLECTION_ROWS + 1);
  const executions = executionRows.slice(0, MAX_EXPORT_COLLECTION_ROWS).reverse()
    .map((row) => ({
      id: row.id,
      command_id: row.command_id,
      source_message_id: row.source_message_id,
      source_message_seq: row.source_message_seq,
      // 0154：来源消息脱钩（会话聊天已删）之后，序号 + 正文摘要是唯一还能核对
      // 「这条请求当初来自哪条消息」的凭据，因此连同脱钩时刻一起交出去。
      source_message_sha256: row.source_message_sha256 === null ? null
        : row.source_message_sha256.toString('hex'),
      source_detached_at: row.source_detached_at,
      project_id: row.project_id,
      task_id: row.task_id,
      run_id: row.run_id,
      resource_id: row.resource_id,
      root_path: row.root_path,
      execution_kind: row.execution_kind,
      machine_capability: row.machine_capability,
      decision: row.decision,
      candidate_status: row.candidate_status,
      status: row.status,
      revision: row.revision,
      clarification: sanitizeObject(row.clarification ?? {}, tally),
      candidate: sanitizeObject(row.candidate ?? {}, tally),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

  // Operation 身份只从本会话的工具账本里取：不跨会话，也不替别的 Run 补一份动作进来。
  const operationIds = [...new Set(toolCallRows
    .map((row) => row.operation_id).filter((id): id is string => id !== null))];
  const operations: Draft[] = [];
  for (const id of operationIds) {
    const operation = await r.gateway.readOperation(id);
    // 读不到或作用域对不上时整条不写：动作身份属于本会话的账本，但内容不属于这个 Workspace。
    if (operation === undefined || operation.workspace_id !== input.workspaceId) continue;
    operations.push({
      id: operation.id,
      origin: operation.origin,
      capability_key: operation.capability_key,
      action_type: operation.action_type,
      normalized_target: operation.normalized_target,
      resource_id: operation.resource_id,
      status: operation.status,
      task_id: operation.task_id,
      run_id: operation.run_id,
      // 存的是 bytea，读回来是 Buffer：在定义处就转成十六进制字符串，与 trace-queries 同一写法，
      // 不依赖文档收口时的兜底转换才知道这一列是什么。
      params_sha256: operation.params_hash.toString('hex'),
      // connection_config 与 params 不进导出：前者是接入配置（端点与接入参数），后者可能带
      // 整段文件正文。这一份只回答「动作准入到哪一步」，参数身份由 params_sha256 核对。
      result_ref: operation.result_ref === null ? null : sanitizeObject(operation.result_ref, tally),
      created_at: operation.created_at,
      updated_at: operation.updated_at,
    });
  }

  const context = (await r.assist.listSessionContexts(input.workspaceId, [session.id]))[0];
  const todoSnapshot = await r.todos.readCurrent(session.id);
  const selection = await r.modelSelection.readForSession(session.id);
  const fileChanges = await readFileChanges(r, input.workspaceId, session.id,
    session.working_resource_id);

  return jsonDocument({
    format: SESSION_EXPORT_FORMAT,
    schema_version: SESSION_EXPORT_VERSION,
    exported_at: new Date(),
    // 应用版本目前没有可靠的运行时来源：安装包不读 package.json，也没有版本常量。
    // 与其从别处猜一个数冒充，不如把「读不到」本身写成事实。
    relay: { version: null, version_source: 'NOT_EXPOSED_BY_API' },
    snapshot: {
      is_generating: runState !== null,
      run_state: runState,
      list_state: listState,
      note: runState === null
        ? '会话没有在途生成，这份导出对应导出时刻的完整落库事实。'
        : '会话正在生成中：本文件是截至导出时刻的快照，在途回复只包含已落盘的即时草稿'
          + '（见 messages[].live_preview）。',
    },
    workspace: { id: session.workspace_id },
    session: {
      id: session.id,
      title: session.title,
      status: session.status,
      conversation_mode: session.conversation_mode,
      chat_mode: session.chat_mode,
      assistant_profile_id: session.assistant_profile_id,
      assistant_profile_revision: session.assistant_profile_revision,
      remember: session.remember,
      project_id: session.project_id,
      task_id: session.task_id,
      working_resource_id: session.working_resource_id,
      working_directory_source: session.working_directory_source,
      forked_from_session_id: session.forked_from_session_id,
      parent_session_id: session.parent_session_id,
      budget_scope_session_id: session.budget_scope_session_id,
      revision: session.revision,
      pinned_at: session.pinned_at,
      unread_at: session.unread_at,
      last_message_at: session.last_message_at,
      created_at: session.created_at,
      updated_at: session.updated_at,
      has_messages: hasMessages,
    },
    scope: {
      working_directory: sanitizeObject(context?.working_directory ?? {}, tally),
      project_goals: sanitizeObject(context?.project_goals ?? [], tally),
    },
    model: selection === undefined ? null : {
      connection: selection.connection,
      model: selection.model,
      free_only: selection.free_only,
      catalog_source: selection.catalog_source,
      updated_at: selection.updated_at,
    },
    context_usage: await readSessionContextUsage(executor, input.workspaceId, session.id),
    messages,
    tool_calls: toolCallGroups,
    model_calls: modelCalls,
    todos: {
      snapshot: todoSnapshot === undefined ? null : {
        session_id: todoSnapshot.sessionId, scope_key: todoSnapshot.scopeKey,
        version: todoSnapshot.version, items: todoSnapshot.items,
        in_progress_limit: todoSnapshot.inProgressLimit, updated_at: todoSnapshot.updatedAt,
      },
      change_history_exported: false,
      note: MISSING_TODO_HISTORY,
    },
    executions,
    operations,
    file_changes: fileChanges,
    completeness: {
      messages: report(messageRows.length, exportedMessages.length, MAX_EXPORT_MESSAGES, '消息'),
      tool_calls: report(allToolCallRows.length, toolCallRows.length,
        MAX_EXPORT_COLLECTION_ROWS, '工具调用'),
      model_calls: report(modelCallRows.length, modelCalls.length,
        MAX_EXPORT_COLLECTION_ROWS, '模型调用'),
      executions: report(executionRows.length, executions.length,
        MAX_EXPORT_COLLECTION_ROWS, '执行请求'),
      operations: report(operationIds.length, operations.length,
        MAX_EXPORT_COLLECTION_ROWS, '动作'),
      tool_calls_without_message: [...byMessage.keys()].filter((id) => !statusByMessage.has(id)),
      missing_evidence: [
        MISSING_TOOL_RESULT_BODY,
        MISSING_TODO_HISTORY,
        '模型私有推理：本仓库不存储，因此不可能导出。',
        'Relay 应用版本：API 运行时没有可靠来源，见 relay.version_source。',
      ],
    },
    privacy: {
      redacted_key_fields: tally.keyHits,
      redacted_value_fields: tally.valueHits,
      message_content: '用户与 AI 的消息正文逐字保留，未做脱敏：其中可能包含你自己输入的个人或项目资料。',
      structured_fields: '工具参数、执行候选、来源引用与动作结果按凭据字段名与凭据值形态脱敏，命中处替换为 [REDACTED:*]。',
      attachments: '附件只导出元数据（id/名称/媒体类型/字节数），不内嵌二进制内容。',
    },
  });
}
