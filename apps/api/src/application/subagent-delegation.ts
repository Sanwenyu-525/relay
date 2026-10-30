import { createHash, randomUUID } from 'node:crypto';

import type { AssistSessionRow, AssistMessageRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject, JsonValue } from '../infrastructure/json.js';
// 委派的读写一律经 `createRepositories(...).subagents` / `withTransaction` 的同一事务连接，
// 这里不直接 new 仓储，避免出现第二条不走 UnitOfWork 的写入口。
import type { DelegationRole, DelegationTerminalStatus } from '../assist/subagent-repository.js';
import { SessionToolCallRepository, type SessionToolCallRow } from '../assist/session-tool-call-repository.js';
import { canonicalizeJson } from '../receipt/payload-hash.js';
import { freshAssistModelAttemptState } from './assist-model-snapshot.js';
import { createRepositories, withTransaction } from './unit-of-work.js';
import { DELEGATE_SUBAGENT_TOOL_NAME } from '../workflow/tool-catalog.js';
import { selectRuntimeSystemPrompt } from '../workflow/prompts/index.js';
import { ToolRequestRejected } from './tool-loop.js';
import { resourceNotFound } from './domain-error.js';

/**
 * 0128：有界多 Agent 首版（ADR-017、总纲 §0.9、运行架构 §2.5）。
 *
 * 产品链：主 Agent 接收任务 → 委派只读调查 → 接收结果 → 主 Agent 实施 →
 * 委派独立审查 → 处理发现 → 汇总交付。本模块是这条链的**协议层**：
 *
 *   * `createDelegation` —— 一次短事务里完成「锁父会话 → 槽位/层级/目录校验 →
 *     建子会话与子消息 → 建委派行与尝试行」。并发两个工具请求同时建委派时，
 *     父会话行锁把槽位计数串行化，不会出现第三个进行中的委派。
 *   * `runDelegationAttemptFlow` —— 执行一次尝试（由调用方注入真实子轮次），
 *     按 epoch/revision CAS 落定；可确认的模型失败给一次修正重试。
 *   * `reconcileDelegationAttempts` —— 恢复核对：崩溃窗口里「子消息已结算但
 *     尝试行没落定」「子消息被租约清扫」都按原身份补结算，不盲重跑。
 *
 * 子执行**不创建 Task/Run、不取得写权限、只有一层**：子会话的 AGENT 身份绑定同一
 * 受管资源，但词表里没有写工具也没有委派工具（`allowDelegate` 只对根会话为真），
 * Gateway 准入仍按原连接与权限重算——委派不是授权。
 */

/** 同一主会话下最多两个未终结委派（总纲 §0.9「最多同时执行两个只读子 Agent」）。 */
export const MAX_CONCURRENT_DELEGATIONS = 2;

/** 一次委派的尝试上限：初次 + 至多一次修正重试。 */
export const MAX_DELEGATION_ATTEMPTS = 2;

/** 回传主 Agent 的结论摘要上限；完整结论在子会话消息里，不复制第二份。 */
const RESULT_SUMMARY_LIMIT = 4_000;

const OBJECTIVE_LIMIT = 2_000;
const OUTPUT_REQUIREMENTS_LIMIT = 2_000;
const SCOPE_ITEM_LIMIT = 200;
const SCOPE_ITEMS = 20;
const BASELINE_LIMIT = 200;

/** 子会话标题上限；标题只是帮助阅读，导航用确切会话身份。 */
const CHILD_TITLE_LIMIT = 80;

export interface DelegationRequest {
  readonly role: DelegationRole;
  readonly objective: string;
  readonly scope: readonly string[];
  readonly baseline: string | null;
  readonly outputRequirements: string;
  readonly required: boolean;
}

/**
 * 校验模型给出的委派声明。
 *
 * 与工具参数校验同一立场：**模型声明不是执行授权**。角色越界、REVIEW 缺基线、
 * 超长字段都在这里被拒，模型收到类型化原因后可以改一次再交，而不是留下一条
 * 半可信的委派。
 */
export function readDelegationToolArguments(raw: JsonObject): DelegationRequest {
  const role = raw.role;
  if (role !== 'INVESTIGATE' && role !== 'REVIEW') {
    throw new ToolRequestRejected('TOOL_ARGUMENT_INVALID',
      `delegate_subagent 的 role 只接受 INVESTIGATE / REVIEW。`);
  }
  const objective = textOf(raw.objective, OBJECTIVE_LIMIT);
  if (objective === undefined) {
    throw new ToolRequestRejected('TOOL_ARGUMENT_MISSING',
      'delegate_subagent 需要 objective（要查清或核对的问题）。');
  }
  const baseline = textOf(raw.baseline, BASELINE_LIMIT) ?? null;
  if (role === 'REVIEW' && baseline === null) {
    throw new ToolRequestRejected('TOOL_ARGUMENT_MISSING',
      'REVIEW 委派必须带 baseline（被审查改动对应的基线标识）；结论只对该基线成立。');
  }
  const scope = stringListOf(raw.scope, SCOPE_ITEMS, SCOPE_ITEM_LIMIT);
  return {
    role, objective, scope, baseline,
    outputRequirements: textOf(raw.output_requirements, OUTPUT_REQUIREMENTS_LIMIT)
      ?? '给出发现、证据位置与直接结论；无法核实的明确标注「未验证」。',
    required: raw.required === true,
  };
}

function textOf(value: JsonValue | undefined, max: number): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.trim().length <= max
    ? value.trim() : undefined;
}

function stringListOf(value: JsonValue | undefined, max: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const item of value) {
    const text = textOf(item, maxChars);
    if (text !== undefined && !items.includes(text)) items.push(text);
    if (items.length >= max) break;
  }
  return items;
}

/** 子 Agent 看到的冻结委派事实（数据，不是指令）。 */
export function subagentDelegationState(input: {
  readonly role: DelegationRole;
  readonly objective: string;
  readonly scope: readonly string[];
  readonly baseline: string | null;
  readonly outputRequirements: string;
  readonly required: boolean;
}): JsonObject {
  return {
    role: input.role,
    objective: input.objective,
    scope: [...input.scope],
    baseline: input.baseline,
    output_requirements: input.outputRequirements,
    required: input.required,
  };
}

export interface SubagentFinding {
  readonly statement: string;
  readonly evidence: string | null;
  readonly confidence: 'CONFIRMED' | 'UNVERIFIED';
}

export interface SubagentEnvelope {
  readonly reply: string;
  readonly findings: readonly SubagentFinding[];
  readonly conclusion: string | null;
}

/**
 * 读一次子执行输出。
 *
 * 与主流程信封同一纪律：形状校验 + 归一化，不做业务判定。子结论回传主 Agent 时
 * 永远是数据——主 Agent 可以引用、核对、继续，但它不是 USER 指令也不是完成证据。
 */
export function readSubagentEnvelope(content: string): SubagentEnvelope {
  const object = parseEnvelopeObject(content);
  if (object === undefined) {
    return { reply: content.trim().slice(0, RESULT_SUMMARY_LIMIT), findings: [], conclusion: null };
  }
  const reply = textOf(object.reply, RESULT_SUMMARY_LIMIT)
    ?? '子 Agent 没有给出可读结论。';
  const findings: SubagentFinding[] = [];
  const rawFindings = object.findings;
  if (Array.isArray(rawFindings)) {
    for (const item of rawFindings) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const entry = item as JsonObject;
      const statement = textOf(entry.statement, 2_000);
      if (statement === undefined) continue;
      findings.push({ statement,
        evidence: textOf(entry.evidence, 500) ?? null,
        confidence: entry.confidence === 'UNVERIFIED' ? 'UNVERIFIED' : 'CONFIRMED' });
      if (findings.length >= 20) break;
    }
  }
  return { reply, findings,
    conclusion: textOf(object.conclusion, 2_000) ?? null };
}

function parseEnvelopeObject(content: string): JsonObject | undefined {
  const trimmed = content.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as JsonObject : undefined;
  } catch { return undefined; }
}

/** 回传主 Agent 的工具结果正文：有界摘要 + 可核对的委派/子会话身份。 */
export function delegationResultText(input: {
  readonly delegationId: string;
  readonly childSessionId: string;
  readonly role: DelegationRole;
  readonly status: DelegationTerminalStatus;
  readonly envelope: SubagentEnvelope | null;
  readonly errorCode: string | null;
  readonly retried: boolean;
}): string {
  const head = { delegation_id: input.delegationId, child_session_id: input.childSessionId,
    role: input.role, status: input.status,
    ...(input.retried ? { retried_once: true } : {}),
    ...(input.errorCode === null ? {} : { error_code: input.errorCode }) };
  if (input.envelope === null) {
    return JSON.stringify({ ...head,
      detail: '这次委派没有产生结论；按上面的错误码处理，不要假设子 Agent 看过任何文件。' });
  }
  return JSON.stringify({ ...head,
    reply: input.envelope.reply,
    findings: input.envelope.findings.map((finding) => ({
      statement: finding.statement, evidence: finding.evidence,
      confidence: finding.confidence })),
    conclusion: input.envelope.conclusion });
}

/** 委派尝试的持久摘要（有界；完整结论在子会话消息里）。 */
export function delegationSummaryText(envelope: SubagentEnvelope): string {
  const findings = envelope.findings.map((finding) => `- [${finding.confidence}] `
    + `${finding.statement}${finding.evidence === null ? '' : `（${finding.evidence}）`}`);
  const body = [envelope.reply, ...(findings.length === 0 ? [] : findings),
    ...(envelope.conclusion === null ? [] : [`结论：${envelope.conclusion}`])].join('\n');
  return body.length <= RESULT_SUMMARY_LIMIT ? body
    : `${body.slice(0, RESULT_SUMMARY_LIMIT)}…`;
}

// ---------------------------------------------------------------- 创建（短事务）

export interface CreatedDelegation {
  readonly delegationId: string;
  readonly childSessionId: string;
  readonly childMessageId: string;
  readonly attemptId: string;
  readonly system: string;
}

export class DelegationRefusedError extends Error {
  override readonly name = 'DelegationRefusedError';
  constructor(readonly reason: string, message: string) { super(message); }
}

/**
 * 子会话的主子关联与预算作用域（0128、运行架构 §2.5.3）。
 *
 * 两列必须同指**根会话**：`model_calls` 的预算闸门按 `budget_scope_session_id` 归口，
 * 指向子会话自己就等于每个子 Agent 另开一份额度，「原主执行共享预算」当场失效；
 * 只给父不给作用域则会被 `ck_assist_session_parent_budget` 拒掉。
 */
export function childSessionScope(parent: Pick<AssistSessionRow, 'id'>): {
  readonly parentSessionId: string; readonly budgetScopeSessionId: string;
} {
  return { parentSessionId: parent.id, budgetScopeSessionId: parent.id };
}

/**
 * 建立一次委派：子会话 + 子消息 + 委派行 + 初次尝试，一个短事务。
 *
 * 锁序只涉及**父会话行**（`for update`）：并发两个工具请求同时建委派时在这里串行化，
 * 槽位计数不会双过。子会话与消息的插入都指向已锁定的父行，不引入第二把锁。
 */
export async function createDelegation(db: DbExecutor, input: {
  readonly parentSession: AssistSessionRow;
  readonly parentMessageId: string;
  readonly parentToolCallId: string | null;
  readonly request: DelegationRequest;
  readonly modelSelectionSnapshot: JsonObject | null;
  /** 0142：与快照同源的凭据身份；子会话沿用父消息身份，不重新解析当前凭据。 */
  readonly modelCredentialFingerprint?: string | null;
  readonly workerId: string;
  readonly maxAttempts?: number;
}): Promise<CreatedDelegation> {
  const parent = input.parentSession;
  if (parent.conversation_mode !== 'AGENT' || parent.parent_session_id !== null) {
    // 类型上不可达（词表门禁已挡），这里仍是确定性闸门：子会话与人设/学习档不得委派。
    throw new DelegationRefusedError('SUBAGENT_DELEGATE_UNAVAILABLE',
      '这条会话不能委派子 Agent：只有普通 Agent 的根会话可以。');
  }
  const created = await withTransaction(db, async (repositories) => {
    const locked = await repositories.assist.readSession(parent.id, true);
    if (locked === undefined) throw resourceNotFound('Assist session');
    if (locked.status !== 'ACTIVE') {
      throw new DelegationRefusedError('SUBAGENT_PARENT_SESSION_INACTIVE',
        '主会话已归档，不能建立新的委派。');
    }
    if (locked.project_id === null || locked.working_resource_id === null) {
      throw new DelegationRefusedError('SUBAGENT_PARENT_SCOPE_MISSING',
        '主会话还没有绑定项目或工作目录，子 Agent 没有可读的范围。');
    }
    const resource = await repositories.gateway.readResource(locked.working_resource_id);
    if (resource === undefined || resource.status !== 'ACTIVE' ||
        resource.project_id !== locked.project_id ||
        resource.workspace_id !== locked.workspace_id) {
      throw new DelegationRefusedError('SUBAGENT_PARENT_RESOURCE_UNAVAILABLE',
        '主会话绑定的工作目录当前不可用，子 Agent 没有可读的范围。');
    }
    // 槽位计数在父会话行锁内进行：两个并发请求不会同时看到 1 而各自放行。
    const open = await repositories.subagents.countOpenByParent(locked.id);
    if (open >= MAX_CONCURRENT_DELEGATIONS) {
      throw new DelegationRefusedError('SUBAGENT_SLOTS_EXHAUSTED',
        `同时进行中的委派已达上限（${MAX_CONCURRENT_DELEGATIONS}）；`
        + '请等现有子任务结束后再委派，或由主 Agent 自己继续。');
    }
    const childSessionId = randomUUID();
    await repositories.assist.insertSession({
      id: childSessionId, workspaceId: locked.workspace_id, projectId: locked.project_id,
      taskId: null,
      title: childTitle(input.request.role, input.request.objective),
      conversationMode: 'AGENT', chatMode: 'CHAT',
      workingResourceId: locked.working_resource_id,
      workingDirectorySource: locked.working_directory_source ?? 'USER_PICKED',
      // 0145：子会话共用主会话的预算作用域，档位随之继承——否则一次 1024K 的委派会在
      // 子轮次里按 256K 申请预算，工具续轮更早被拒。
      contextBudgetTokens: locked.context_budget_tokens,
      ...childSessionScope(locked),
    });
    const childMessageId = randomUUID();
    const seq = await repositories.assist.nextMessageSeq(childSessionId);
    await repositories.assist.insertMessage({
      id: childMessageId, sessionId: childSessionId, seq, role: 'ASSISTANT',
      status: 'PENDING', intent: 'DISCUSS', content: null, sources: [], chatMode: 'CHAT',
      ...(input.modelSelectionSnapshot === null ? {} : {
        modelSelectionSnapshot: input.modelSelectionSnapshot,
        modelAttemptState: freshAssistModelAttemptState(),
        modelCredentialFingerprint: input.modelCredentialFingerprint ?? null }),
    });
    const delegationId = randomUUID();
    const delegation = await repositories.subagents.insertDelegation({
      id: delegationId, workspaceId: locked.workspace_id, parentSessionId: locked.id,
      childSessionId, role: input.request.role, objective: input.request.objective,
      scope: input.request.scope.map((item): JsonObject => ({ text: item })),
      baseline: input.request.baseline === null ? null : { text: input.request.baseline },
      outputRequirements: input.request.outputRequirements,
      required: input.request.required, parentMessageId: input.parentMessageId,
      parentToolCallId: input.parentToolCallId,
      maxAttempts: input.maxAttempts ?? MAX_DELEGATION_ATTEMPTS,
    });
    const attemptId = randomUUID();
    await repositories.subagents.insertAttempt({ id: attemptId, delegationId,
      attemptIndex: 1, claimEpoch: 1n, workerId: input.workerId,
      resultMessageId: childMessageId });
    return { delegationId, childSessionId, childMessageId, attemptId,
      system: selectRuntimeSystemPrompt({ kind: 'AGENT_SUBAGENT',
        state: subagentDelegationState(input.request) }).system };
  });
  return created;
}

function childTitle(role: DelegationRole, objective: string): string {
  const label = role === 'REVIEW' ? '独立审查' : '只读调查';
  const trimmed = objective.trim();
  return `子 Agent · ${label} · ${trimmed.length > CHILD_TITLE_LIMIT
    ? `${trimmed.slice(0, CHILD_TITLE_LIMIT)}…` : trimmed}`;
}

// ---------------------------------------------------------------- 执行一次尝试

/** 调用方注入的真实子轮次（由生成层实现：领取、模型路由、只读轮次、结算）。 */
export type DelegationChildRunner = (input: {
  readonly childSession: AssistSessionRow;
  readonly childMessage: AssistMessageRow;
  readonly system: string;
  readonly signal: AbortSignal;
}) => Promise<SubagentChildOutcome>;

export interface SubagentChildOutcome {
  /** 子执行的结果用委派词表表达（见 `DelegationTerminalStatus`）：SUCCEEDED 即「这一层子执行给出了结论」。 */
  readonly status: DelegationTerminalStatus;
  readonly errorCode: string | null;
  /** 子执行输出原文（SUCCEEDED 时非空）。 */
  readonly content: string | null;
}

export interface DelegationToolOutcome {
  readonly status: DelegationTerminalStatus;
  readonly envelope: SubagentEnvelope | null;
  readonly errorCode: string | null;
  readonly retried: boolean;
  readonly delegationId: string;
  readonly childSessionId: string;
}

/** 可确认失败才允许的修正重试类别：暂时性模型故障与一次输出格式错误。 */
function retryableChildFailure(errorCode: string | null): boolean {
  return errorCode === 'MODEL_TIMEOUT' || errorCode === 'MODEL_FAILED'
    || errorCode === 'MODEL_TOOL_OUTPUT_INVALID';
}

/**
 * 执行一次委派（含至多一次修正重试）并把结论落定。
 *
 * 顺序刻意如此：先跑、后落。跑之前的落定会让崩溃窗口里的委派行显示「已成功」而
 * 子消息还没有结论；跑之后不落则崩溃后无法核对。attempt/revision 双 CAS 保证
 * 迟到结果（旧 epoch / 旧修订号）写不进去。
 */
export async function runDelegationAttemptFlow(db: DbExecutor, input: {
  readonly created: CreatedDelegation;
  readonly workerId: string;
  readonly signal: AbortSignal;
  readonly runChild: DelegationChildRunner;
}): Promise<DelegationToolOutcome> {
  const repositories = createRepositories(db);
  const { created } = input;
  const delegation = await repositories.subagents.readDelegation(created.delegationId);
  if (delegation === undefined) throw resourceNotFound('Assist delegation');
  const childSession = await repositories.assist.readSession(created.childSessionId);
  if (childSession === undefined) throw resourceNotFound('Assist subagent session');
  let childMessage = await repositories.assist.readMessage(created.childMessageId);
  if (childMessage === undefined) throw resourceNotFound('Assist subagent message');
  let attemptId = created.attemptId;
  let retried = false;
  let outcome: SubagentChildOutcome = input.signal.aborted
    ? { status: 'CANCELLED', errorCode: 'SUBAGENT_CANCELLED', content: null }
    : await input.runChild({ childSession, childMessage,
      system: created.system, signal: input.signal });
  if (!input.signal.aborted && outcome.status === 'FAILED' && retryableChildFailure(outcome.errorCode) &&
      delegation.attempt_count < delegation.max_attempts) {
    // 一次有界修正重试：新尝试关联原委派，不换委派身份、不清掉失败关系。
    await settleAttemptFailure(db, attemptId, childMessage.id, outcome.errorCode);
    const retry = await createRetryAttempt(db, { delegation, workerId: input.workerId,
      previousMessage: childMessage });
    retried = true;
    attemptId = retry.attemptId;
    const retryMessage = await repositories.assist.readMessage(retry.childMessageId);
    if (retryMessage === undefined) throw resourceNotFound('Assist subagent retry message');
    childMessage = retryMessage;
    outcome = await input.runChild({ childSession, childMessage: retryMessage,
      system: created.system, signal: input.signal });
  }
  const envelope = outcome.status === 'SUCCEEDED' && outcome.content !== null
    ? readSubagentEnvelope(outcome.content) : null;
  const applied = await settleDelegationRecords(db, { delegationId: delegation.id, attemptId,
    expectedEpoch: 1n, status: outcome.status, errorCode: outcome.errorCode,
    resultMessageId: childMessage.id, envelope, retried });
  return { status: applied ? outcome.status : 'FAILED', envelope: applied ? envelope : null,
    errorCode: applied ? outcome.errorCode : 'SUBAGENT_CLAIM_LOST', retried,
    delegationId: delegation.id, childSessionId: created.childSessionId };
}

/** 修正重试的新尝试：同一子会话上的新消息 + 新尝试行，attempt_count 随 revision CAS 前进。 */
async function createRetryAttempt(db: DbExecutor, input: {
  readonly delegation: import('../infrastructure/database-schema.js').AssistDelegationRow;
  readonly workerId: string;
  readonly previousMessage: AssistMessageRow;
}): Promise<{ attemptId: string; childMessageId: string }> {
  const childSessionId = input.delegation.child_session_id;
  if (childSessionId === null) throw new Error('delegation retry without child session');
  return withTransaction(db, async (repositories) => {
    const locked = await repositories.subagents.readDelegation(input.delegation.id, true);
    if (locked === undefined) throw resourceNotFound('Assist delegation');
    if (locked.status !== 'RUNNING') {
      throw new Error('delegation retry entered a non-running delegation');
    }
    const childMessageId = randomUUID();
    const seq = await repositories.assist.nextMessageSeq(childSessionId);
    await repositories.assist.insertMessage({
      id: childMessageId, sessionId: childSessionId, seq, role: 'ASSISTANT',
      status: 'PENDING', intent: 'DISCUSS', content: null, sources: [], chatMode: 'CHAT',
      modelSelectionSnapshot: input.previousMessage.model_selection_snapshot,
      modelCredentialFingerprint: input.previousMessage.model_credential_fingerprint,
      ...(input.previousMessage.model_selection_snapshot === null ? {}
        : { modelAttemptState: freshAssistModelAttemptState() }) });
    const attemptId = randomUUID();
    await repositories.subagents.insertAttempt({ id: attemptId, delegationId: locked.id,
      attemptIndex: locked.attempt_count + 1, claimEpoch: 1n, workerId: input.workerId,
      resultMessageId: childMessageId });
    await repositories.subagents.updateDelegation(locked.id, locked.revision,
      { attemptCount: locked.attempt_count + 1 });
    return { attemptId, childMessageId };
  });
}

async function settleAttemptFailure(db: DbExecutor, attemptId: string,
  messageId: string, errorCode: string | null): Promise<void> {
  await withTransaction(db, async (repositories) => {
    const attempt = await repositories.subagents.readAttempt(attemptId, true);
    if (attempt?.status === 'RUNNING') {
      await repositories.subagents.updateAttempt(attempt.id, attempt.claim_epoch,
        { status: 'FAILED', resultMessageId: messageId, errorCode });
    }
  });
}

/** 尝试行按 epoch CAS、委派行按 revision CAS 落定；任一失败都说明迟到结果，不覆盖。 */
async function settleDelegationRecords(db: DbExecutor, input: {
  readonly delegationId: string;
  readonly attemptId: string;
  readonly expectedEpoch: bigint;
  readonly status: DelegationTerminalStatus;
  readonly errorCode: string | null;
  readonly resultMessageId: string;
  readonly envelope: SubagentEnvelope | null;
  readonly retried: boolean;
}): Promise<boolean> {
  return withTransaction(db, async (repositories) => {
    const attempt = await repositories.subagents.readAttempt(input.attemptId, true);
    if (attempt === undefined || attempt.status !== 'RUNNING' ||
        attempt.claim_epoch !== input.expectedEpoch) {
      // 迟到结果（旧 epoch 或已被恢复流程结算）：只记录已知事实，不推进委派。
      return false;
    }
    // 子执行结果已按委派词表给出，这里不再做一次转换：两套说法并存时，
    // 「COMPLETED 的尝试」与「SUCCEEDED 的委派」会在恢复核对里对不上。
    await repositories.subagents.updateAttempt(input.attemptId, input.expectedEpoch, {
      status: input.status, resultMessageId: input.resultMessageId,
      errorCode: input.status === 'SUCCEEDED' ? null : input.errorCode });
    const delegation = await repositories.subagents.readDelegation(input.delegationId, true);
    if (delegation === undefined || delegation.status !== 'RUNNING') return false;
    if (input.status === 'SUCCEEDED' && input.envelope !== null) {
      await repositories.subagents.updateDelegation(delegation.id, delegation.revision, {
        status: 'SUCCEEDED',
        resultSummary: delegationSummaryText(input.envelope),
        stopReason: null });
      return true;
    }
    await repositories.subagents.updateDelegation(delegation.id, delegation.revision, {
      status: input.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
      resultSummary: null,
      stopReason: { code: input.status === 'CANCELLED' ? 'SUBAGENT_CANCELLED'
        : `SUBAGENT_${input.errorCode ?? 'FAILED'}`,
        detail: input.status === 'CANCELLED'
          ? '这次子执行被停止；没有产生结论。'
          : `这次子执行失败（${input.errorCode ?? 'UNKNOWN'}）。`,
        ...(input.retried ? { retried_once: true } : {}),
        resumable: false } });
    return true;
  });
}

// ---------------------------------------------------------------- 工具结算入口

export interface DelegationToolContext {
  readonly parentSession: AssistSessionRow;
  readonly parentMessage: AssistMessageRow;
  readonly row: SessionToolCallRow;
  readonly call: { readonly providerToolCallId: string; readonly name: string;
    readonly arguments: JsonObject };
  readonly workerId: string;
  readonly signal: AbortSignal;
  readonly runChild: DelegationChildRunner;
}

/**
 * 会话工具轮次里一次 `delegate_subagent` 请求的完整落定。
 *
 * 与 Gateway 工具同一条账本纪律：先登记（行已由调用方插入），再校验、执行、结算；
 * 被拒不连任何动作，类型化原因回传模型并留在 `session_tool_calls` 上。
 */
export async function settleDelegationToolCall(db: DbExecutor, context: DelegationToolContext):
  Promise<{ readonly providerToolCallId: string; readonly name: string;
    readonly content: string; readonly isError: boolean }> {
  const { row, call } = context;
  const repository = new SessionToolCallRepository(db);
  const refuse = async (reason: string, detail: string) => {
    await repository.reject(row.id, reason, detail);
    return { providerToolCallId: call.providerToolCallId, name: call.name,
      content: `【${reason}】${detail}`, isError: true };
  };
  let request: DelegationRequest;
  try {
    request = readDelegationToolArguments(call.arguments);
  } catch (error) {
    return refuse(error instanceof ToolRequestRejected ? error.reason : 'TOOL_ARGUMENT_INVALID',
      error instanceof Error ? error.message : '委派声明不合法。');
  }
  if (context.parentSession.parent_session_id !== null) {
    return refuse('SUBAGENT_DELEGATE_UNAVAILABLE',
      '子会话不能委派：仅一层委派，这条会话本身已是子会话。');
  }
  let created: CreatedDelegation;
  try {
    created = await createDelegation(db, {
      parentSession: context.parentSession, parentMessageId: context.parentMessage.id,
      parentToolCallId: row.id, request,
      modelSelectionSnapshot: context.parentMessage.model_selection_snapshot,
      modelCredentialFingerprint: context.parentMessage.model_credential_fingerprint,
      workerId: context.workerId });
  } catch (error) {
    if (error instanceof DelegationRefusedError) {
      return refuse(error.reason, error.message);
    }
    throw error;
  }
  const outcome = await runDelegationAttemptFlow(db, {
    created, workerId: context.workerId, signal: context.signal,
    runChild: context.runChild });
  const digest = createHash('sha256').update(canonicalizeJson({
    delegation_id: outcome.delegationId, status: outcome.status,
    ...(outcome.errorCode === null ? {} : { error_code: outcome.errorCode }) }), 'utf8')
    .digest('hex');
  await repository.settleApplicationTool(row.id, digest);
  return { providerToolCallId: call.providerToolCallId, name: call.name,
    content: delegationResultText({ delegationId: outcome.delegationId,
      childSessionId: outcome.childSessionId, role: request.role, status: outcome.status,
      envelope: outcome.envelope, errorCode: outcome.errorCode, retried: outcome.retried }),
    isError: outcome.status !== 'SUCCEEDED' };
}

// ---------------------------------------------------------------- 恢复核对

/**
 * 崩溃窗口的补结算：尝试行仍 RUNNING，而子消息已有终态（或被租约清扫）。
 *
 * 三种窗口各自按原身份闭合：
 *   * 子消息 COMPLETED、尝试行未落定 → 按消息补记 SUCCEEDED（结果已保存、回执丢失）；
 *   * 子消息 FAILED/CANCELLED → 按消息的错误码补记，委派随之 FAILED/CANCELLED；
 *   * 子消息仍是 PENDING/RUNNING 且租约已过期 → 记 ATTEMPT_LEASE_LOST，不盲重跑。
 *
 * 租约过期**不证明**旧执行已停止：因此这里只补记已知事实，绝不重新派发子轮次。
 */
export async function reconcileDelegationAttempts(db: DbExecutor, options: {
  readonly now: Date;
  readonly leaseMs: number;
}): Promise<readonly { delegationId: string; outcome: string }[]> {
  const repositories = createRepositories(db);
  const running = await repositories.subagents.listRunningAttempts();
  const settled: { delegationId: string; outcome: string }[] = [];
  for (const entry of running) {
    const message = await repositories.assist.readMessage(entry.attempt.result_message_id ?? '');
    const decision = reconcileDecision(message, entry.attempt.updated_at, options);
    if (decision === undefined) continue;
    const applied = await withTransaction(db, async (tx) => {
      const attempt = await tx.subagents.readAttempt(entry.attempt.id, true);
      if (attempt === undefined || attempt.status !== 'RUNNING') return false;
      await tx.subagents.updateAttempt(entry.attempt.id, attempt.claim_epoch, {
        status: decision.attemptStatus,
        errorCode: decision.errorCode,
        ...(message?.status === 'COMPLETED' ? { resultMessageId: message.id } : {}) });
      const delegation = await tx.subagents.readDelegation(entry.delegation.id, true);
      if (delegation === undefined) return false;
      const summary = decision.attemptStatus === 'SUCCEEDED' && message?.content
        ? message.content.slice(0, RESULT_SUMMARY_LIMIT) : null;
      await tx.subagents.updateDelegation(delegation.id, delegation.revision, {
        status: decision.delegationStatus, resultSummary: summary,
        stopReason: { code: decision.errorCode ?? 'SUBAGENT_RECONCILED',
          detail: decision.detail, resumable: false } });
      return true;
    });
    if (applied) {
      settled.push({ delegationId: entry.delegation.id, outcome: decision.attemptStatus });
    }
  }
  return settled;
}

interface ReconcileDecision {
  readonly attemptStatus: DelegationTerminalStatus;
  readonly delegationStatus: DelegationTerminalStatus;
  readonly errorCode: string | null;
  readonly detail: string;
}

function reconcileDecision(message: AssistMessageRow | undefined,
  attemptUpdatedAt: Date, options: { now: Date; leaseMs: number }):
  ReconcileDecision | undefined {
  if (message === undefined) {
    return { attemptStatus: 'FAILED', delegationStatus: 'FAILED',
      errorCode: 'SUBAGENT_MESSAGE_MISSING',
      detail: '这次子执行的消息行不存在；按失败结算，不重跑。' };
  }
  if (message.status === 'COMPLETED') {
    return { attemptStatus: 'SUCCEEDED', delegationStatus: 'SUCCEEDED', errorCode: null,
      detail: '子执行已给出结论（恢复时按原消息补记）。' };
  }
  if (message.status === 'CANCELLED') {
    return { attemptStatus: 'CANCELLED', delegationStatus: 'CANCELLED',
      errorCode: 'SUBAGENT_CANCELLED', detail: '这次子执行已被停止。' };
  }
  if (message.status === 'FAILED') {
    return { attemptStatus: 'FAILED', delegationStatus: 'FAILED',
      errorCode: message.error_code ?? 'SUBAGENT_FAILED',
      detail: `这次子执行失败（${message.error_code ?? 'UNKNOWN'}）。` };
  }
  // PENDING/RUNNING：只有租约确实过期才补记；仍在租约内的交给在途执行自己结算。
  const deadline = new Date(Math.max(attemptUpdatedAt.getTime(), message.updated_at.getTime())
    + options.leaseMs * 2);
  if (options.now < deadline) return undefined;
  return { attemptStatus: 'FAILED', delegationStatus: 'FAILED',
    errorCode: 'ATTEMPT_LEASE_LOST',
    detail: '子执行的 Worker 租约已过期且没有结论；按失败结算，需要时由主 Agent 重新委派。' };
}

// ---------------------------------------------------------------- 读投影

export interface DelegationProjection {
  readonly delegation_id: string;
  readonly child_session_id: string | null;
  readonly role: DelegationRole;
  readonly objective: string;
  readonly scope: readonly string[];
  readonly baseline: string | null;
  readonly required: boolean;
  readonly status: string;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly result_summary: string | null;
  readonly created_at: string;
  readonly closed_at: string | null;
}

function scopeTexts(value: JsonValue): readonly string[] {
  // 0128 stores [{text}], not {items}; keep the legacy wrapper readable.
  const raw = Array.isArray(value) ? value
    : typeof value === 'object' && value !== null ? (value as JsonObject).items : undefined;
  return Array.isArray(raw) ? raw.flatMap((item) => {
    if (typeof item === 'string') return [item];
    return typeof item === 'object' && item !== null && !Array.isArray(item)
      && typeof item.text === 'string' ? [item.text] : [];
  }) : [];
}

function baselineText(value: JsonObject | null): string | null {
  if (value === null) return null;
  const raw = value.text;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

export async function listSessionDelegations(db: DbExecutor, input: {
  readonly workspaceId: string; sessionId: string;
}): Promise<readonly DelegationProjection[]> {
  const repositories = createRepositories(db);
  const session = await repositories.assist.readSession(input.sessionId);
  if (session === undefined || session.workspace_id !== input.workspaceId) {
    throw resourceNotFound('Assist session');
  }
  const rows = await repositories.subagents.listByParent(session.id, 50);
  return rows.map((row): DelegationProjection => ({
    delegation_id: row.id, child_session_id: row.child_session_id, role: row.role,
    objective: row.objective, scope: scopeTexts(row.scope),
    baseline: baselineText(row.baseline), required: row.required, status: row.status,
    attempt_count: row.attempt_count, max_attempts: row.max_attempts,
    result_summary: row.result_summary,
    created_at: row.created_at.toISOString(),
    closed_at: row.closed_at === null ? null : row.closed_at.toISOString(),
  }));
}

/** 供测试与恢复核对的工具名常量再导出（单一来源在 tool-catalog）。 */
export { DELEGATE_SUBAGENT_TOOL_NAME };
