import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import type { AgentMemberRow } from '../team/agent-member-repository.js';
import type { MemberConversationRow, MemberMessageRow } from '../team/member-conversation-repository.js';
import type {
  AssistModelPort, AssistRequest, AssistResult, AssistTurn, ModelUsage,
} from '../workflow/fake-model-port.js';
import { selectRuntimeSystemPrompt } from '../workflow/prompts/index.js';
import { DomainError } from './domain-error.js';
import { lockWritableProjectInWorkspace } from './guards.js';
import { readAdmission } from './maintenance-admission.js';
import { recordModelInvocation } from './model-call-recorder.js';
import { createRepositories, withTransaction, type Repositories } from './unit-of-work.js';

/**
 * 成员消息唤醒与消费结算的应用 Owner（ADR-034 包 C 第一片，迁移 0141）。
 *
 * Worker 每个 tick 做一次有界的工作单元：清扫过期租约，然后**至多唤醒一条**
 * RECORDED 消息。唤醒裁决只在消息行已有的定向事实上进行——私聊唤醒对方成员、
 * 群聊定向唤醒指定成员、未定向群聊由项目协调者接住；一次只唤醒一个成员，
 * 绝不默认广播全员（PT-04）。停用、归档、外部运行方式的成员不在裁决结果里：
 * 消息保留 RECORDED 等待（外部成员按领取协议主动领取），不记失败。
 *
 * 成员回信是 sender_kind=MEMBER、未定向的协作记录，且**只有用户发送的消息是唤醒
 * 触发**：回信既没有成员接收者、也不会进入唤醒候选——「互相回应不得形成无限唤醒
 * 链」由结构保证，不靠模型自觉。成员之间的定向互相唤醒随后续片的定向协议接入。
 * 回信不创建 Task/Run、不构成验收或权限变更（模板同此纪律）。
 *
 * 并发与恢复：RECORDED→CLAIMED 的条件更新是唯一领取点，重复扫描与并发巡检
 * 不重复领取；模型调用经 model_calls 账本逐次计量（kind='MEMBER'，指回触发
 * 消息行——额度不上限不等于不计量）；崩溃由租约清扫收敛——尝试上限内回到
 * RECORDED 接续，超上限按 WAKEUP_ATTEMPTS_EXHAUSTED 失败收口，不无限重试。
 * 模型失败本身不自动重试（红线：不盲重发）。
 */

/** V1 与 assist 生成同节奏：一个 tick 只处理一条，不抢占进程周期。 */
const DEFAULT_MAX_MESSAGES = 1;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_HISTORY_LIMIT = 20;
const REPLY_MAX_CHARS = 20_000;

export interface MemberWakeupOptions {
  readonly workerId: string;
  readonly modelPort: AssistModelPort;
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly maxMessages?: number;
  /** 提示词里携带的触发前历史条数。 */
  readonly historyLimit?: number;
  readonly signal?: AbortSignal | undefined;
  /** 注入时钟；缺省墙钟。 */
  readonly now?: Date;
}

export interface MemberWakeupOutcome {
  readonly messageId: string;
  readonly conversationId: string;
  readonly memberId: string;
  readonly replyMessageId: string | null;
  readonly status: 'PROCESSED' | 'FAILED' | 'DISCARDED' | 'RELEASED';
  readonly reason: string | null;
}

export interface MemberWakeupTickResult {
  readonly requeued: number;
  readonly expiredFailed: number;
  readonly processed: readonly MemberWakeupOutcome[];
  /** 有候选但无可唤醒成员（停用/外部/无协调者）：不动状态，等待或人工处理。 */
  readonly waiting: readonly { readonly messageId: string; readonly reason: string }[];
}

type Claim =
  | { readonly kind: 'CLAIM'; readonly message: MemberMessageRow;
      readonly conversation: MemberConversationRow; readonly member: AgentMemberRow;
      readonly projectTitle: string }
  | { readonly kind: 'NONE'; readonly waiting: readonly { messageId: string; reason: string }[] };

/**
 * 唤醒裁决：按消息行上的定向事实返回应唤醒的成员。
 *
 * 私聊→对方成员；群聊定向→按数组顺序第一个可唤醒的指定成员；群聊未定向→
 * 项目协调者。可唤醒＝本项目的 ACTIVE 且 BUILTIN 成员（外部成员离线等待，
 * 不由本循环唤醒），且不是发送者本人。跨项目的成员 id 不唤醒。
 */
async function adjudicateWakeupTarget(r: Repositories, message: MemberMessageRow,
  conversation: MemberConversationRow): Promise<AgentMemberRow | undefined> {
  const candidateIds: readonly (string | null)[] = conversation.kind === 'DIRECT'
    ? [conversation.member_id]
    : message.recipient_member_ids.length > 0 ? message.recipient_member_ids
      : [(await r.agentMembers.readCoordinator(conversation.project_id))?.member_id ?? null];
  for (const candidateId of candidateIds) {
    if (candidateId === null || candidateId === message.sender_member_id) continue;
    const member = await r.agentMembers.read(candidateId);
    if (member === undefined || member.project_id !== conversation.project_id) continue;
    if (member.status !== 'ACTIVE' || member.run_mode !== 'BUILTIN') continue;
    return member;
  }
  return undefined;
}

/**
 * 成员模型解析（PT-08）：INHERIT 用默认端口；EXPLICIT 只在本切片支持默认连接，
 * 存储的型号与指纹必须与当前端口一致，否则按类型化失败如实报告——绝不静默降级
 * 到别的型号。openrouter 连接的成员路由未接入（免费模型路由绑定 assist 消息行），
 * 同样类型化报告不可用。
 */
function resolveMemberModelPort(member: AgentMemberRow,
  defaultPort: AssistModelPort): { readonly port?: AssistModelPort; readonly error?: string } {
  const selection = member.model_selection;
  if (selection.mode !== 'EXPLICIT') return { port: defaultPort };
  if (selection.connection === 'openrouter') return { error: 'MEMBER_MODEL_ROUTE_UNAVAILABLE' };
  const identity = defaultPort.identity;
  if (selection.model !== identity.model || selection.config_fingerprint !== identity.configFingerprint) {
    return { error: 'MEMBER_MODEL_CONFIG_CHANGED' };
  }
  return { port: defaultPort };
}

function memberNameOf(members: readonly AgentMemberRow[], memberId: string | null): string {
  if (memberId === null) return '用户';
  return members.find((member) => member.id === memberId)?.name ?? '成员';
}

/** 讨论记录 → 模型轮次：HUMAN 作用户、成员作助手并带姓名前缀，触发消息恒为最后一条用户轮。 */
function buildWakeupTurns(history: readonly MemberMessageRow[], trigger: MemberMessageRow,
  members: readonly AgentMemberRow[]): AssistTurn[] {
  const turns: AssistTurn[] = history.map((row) => row.sender_kind === 'MEMBER'
    ? { role: 'assistant' as const, content: `【${memberNameOf(members, row.sender_member_id)}】${row.content}` }
    : { role: 'user' as const, content: row.content });
  turns.push(trigger.sender_kind === 'MEMBER'
    ? { role: 'user', content: `【来自成员 ${memberNameOf(members, trigger.sender_member_id)}】${trigger.content}` }
    : { role: 'user', content: trigger.content });
  return turns;
}

function settleMemberModelCall(result: AssistResult) {
  return result.kind === 'CANCELLED'
    ? { status: 'CANCELLED' as const, providerRequestId: result.providerRequestId ?? null,
      ...(result.usage === undefined ? {} : { usage: result.usage as ModelUsage }) }
    : { status: 'COMPLETED' as const, providerRequestId: result.providerRequestId,
      usage: result.usage };
}

export async function runMemberWakeupTick(db: DbExecutor,
  options: MemberWakeupOptions): Promise<MemberWakeupTickResult> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const repositories = createRepositories(db);
  // 维护/隔离期不唤醒：领取事务里的栅栏会拒绝，但那会把一条合法消息记成失败，
  // 先退出去更诚实（与会话自动推进同一纪律）。
  if ((await readAdmission(repositories, 'share')).mode !== 'NORMAL') {
    return { requeued: 0, expiredFailed: 0, processed: [], waiting: [] };
  }
  const sweep = await repositories.memberConversations.sweepExpiredWakeup(now, maxAttempts);
  const processed: MemberWakeupOutcome[] = [];
  const allWaiting: { messageId: string; reason: string }[] = [];
  for (let index = 0; index < maxMessages; index += 1) {
    const claim = await withTransaction(db, async (tx) => {
      const waiting: { messageId: string; reason: string }[] = [];
      for (const message of await tx.memberConversations.listWakeupCandidates(8)) {
        const conversation = await tx.memberConversations.read(message.conversation_id, true);
        if (conversation === undefined || conversation.status !== 'OPEN') continue;
        const member = await adjudicateWakeupTarget(tx, message, conversation);
        if (member === undefined) {
          waiting.push({ messageId: message.id, reason: 'NO_WAKEABLE_MEMBER' });
          continue;
        }
        // 归档栅栏与领取同一事务：归档项目不领取（候选过滤之后的并发窗口在这里收口）。
        try {
          const project = await lockWritableProjectInWorkspace(tx, message.workspace_id,
            conversation.project_id);
          const claimed = await tx.memberConversations
            .claimWakeupMessage(message.id, options.workerId, now, leaseMs);
          if (claimed === undefined) continue;
          return { kind: 'CLAIM' as const, message: claimed, conversation, member,
            projectTitle: project.title, waiting };
        } catch (error) {
          if (error instanceof DomainError && error.code === 'PROJECT_ARCHIVED') continue;
          throw error;
        }
      }
      return { kind: 'NONE' as const, waiting };
    });
    if (claim.kind === 'NONE') {
      allWaiting.push(...claim.waiting);
      break;
    }
    allWaiting.push(...claim.waiting);
    processed.push(await processClaimedWakeup(db, {
      claim, options, now, leaseMs, historyLimit }));
  }
  return { requeued: sweep.requeued, expiredFailed: sweep.failed, processed, waiting: allWaiting };
}

async function processClaimedWakeup(db: DbExecutor, context: {
  readonly claim: Extract<Claim, { readonly kind: 'CLAIM' }>;
  readonly options: MemberWakeupOptions;
  readonly now: Date;
  readonly leaseMs: number;
  readonly historyLimit: number;
}): Promise<MemberWakeupOutcome> {
  const { claim, options, now, leaseMs, historyLimit } = context;
  const { message, conversation, member } = claim;
  const base = { messageId: message.id, conversationId: conversation.id, memberId: member.id };

  const modelRoute = resolveMemberModelPort(member, options.modelPort);
  if (modelRoute.error !== undefined) {
    await withTransaction(db, (tx) => tx.memberConversations
      .settleWakeupFailed(message.id, options.workerId, now, modelRoute.error!));
    return { ...base, replyMessageId: null, status: 'FAILED', reason: modelRoute.error };
  }
  const port = modelRoute.port!;

  // 讨论记录在领取之后、调用之前读取：提示词事实与结算事实同一代（消息行不可变）。
  const repositories = createRepositories(db);
  const priorRows = (await repositories.memberConversations
    .messages(conversation.id, null, Number(message.seq - 1n))).slice(-historyLimit);
  const members = await repositories.agentMembers.list(conversation.workspace_id, conversation.project_id);
  const state: JsonObject = {
    member_name: member.name, role_key: member.role_key, duties: member.duties,
    project_title: claim.projectTitle, conversation_kind: conversation.kind,
    undirected: conversation.kind === 'GROUP' && message.recipient_member_ids.length === 0,
  };
  const request: AssistRequest = {
    intent: 'DISCUSS',
    system: selectRuntimeSystemPrompt({ kind: 'MEMBER_WAKEUP', state }).system,
    turns: buildWakeupTurns(priorRows, message, members),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const heartbeatMs = Math.max(500, Math.floor(leaseMs / 3));
  const heartbeat = setInterval(() => {
    void (async () => {
      await repositories.memberConversations.heartbeatWakeup(message.id, options.workerId,
        new Date(), leaseMs);
    })().catch(() => undefined);
  }, heartbeatMs);
  try {
    const result = (await recordModelInvocation(db, {
      origin: { workspaceId: message.workspace_id, kind: 'MEMBER', memberMessageId: message.id },
      identity: port.identity,
      signal: controller.signal,
      invoke: async () => port.assist({ ...request, signal: controller.signal }),
      settle: settleMemberModelCall,
    })).result;

    if (result.kind === 'TOOL_CALLS') {
      return settleFailure(db, options, now, base, 'TOOL_CALLS_WITHOUT_DECLARED_TOOLS');
    }
    if (result.kind === 'CANCELLED') {
      if (options.signal?.aborted === true) {
        // 宿主停机没有持久化的用户取消意图：留给租约清扫按崩溃语义收敛。
        return { ...base, replyMessageId: null, status: 'DISCARDED', reason: null };
      }
      return settleFailure(db, options, now, base, 'MEMBER_MODEL_CANCELLED');
    }
    const content = result.content.trim();
    if (content.length === 0) return settleFailure(db, options, now, base, 'MEMBER_REPLY_EMPTY');
    if (content.length > REPLY_MAX_CHARS) {
      return settleFailure(db, options, now, base, 'MEMBER_REPLY_OVER_LIMIT');
    }

    // 结算与回信同一短事务：CAS 按领取身份核对，回信 seq 在会话行锁内分配。
    return await withTransaction(db, async (tx): Promise<MemberWakeupOutcome> => {
      const current = await tx.memberConversations.read(conversation.id, true);
      if (current === undefined) {
        await tx.memberConversations.settleWakeupFailed(message.id, options.workerId, now, 'CONVERSATION_MISSING');
        return { ...base, replyMessageId: null, status: 'FAILED', reason: 'CONVERSATION_MISSING' };
      }
      try {
        await lockWritableProjectInWorkspace(tx, current.workspace_id, current.project_id);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'PROJECT_ARCHIVED') {
          // 归档发生在领取与结算之间：退还领取（等待，不记失败）。
          await tx.memberConversations.releaseWakeupClaim(message.id, options.workerId);
          return { ...base, replyMessageId: null, status: 'RELEASED', reason: null };
        }
        throw error;
      }
      if (current.status !== 'OPEN') {
        await tx.memberConversations.settleWakeupFailed(message.id, options.workerId, now, 'CONVERSATION_CLOSED');
        return { ...base, replyMessageId: null, status: 'FAILED', reason: 'CONVERSATION_CLOSED' };
      }
      if (!await tx.memberConversations.settleWakeupProcessed(message.id, options.workerId, now)) {
        // 迟到的领取者（租约清扫已把行退回并被他人处理）：不冒充成功。
        return { ...base, replyMessageId: null, status: 'DISCARDED', reason: null };
      }
      const seq = await tx.memberConversations.nextSeq(current.id);
      const reply = await tx.memberConversations.insertMessage({
        id: randomUUID(), conversation_id: current.id, workspace_id: message.workspace_id,
        project_id: current.project_id, seq, sender_kind: 'MEMBER', sender_member_id: member.id,
        recipient_member_ids: [], intent: 'DISCUSS', content, handoff_payload: null,
        linked_task_id: null, linked_run_id: null,
      });
      await tx.activities.insertActivityRecord({
        id: randomUUID(), workspaceId: message.workspace_id, projectId: current.project_id,
        taskId: null, actorKind: 'AI', actorRef: `member:${member.id}`, commandId: null,
        eventType: 'MEMBER_MESSAGE_PROCESSED',
        factRefs: { message_id: message.id, reply_message_id: reply.id,
          member_id: member.id, seq: reply.seq.toString() },
      });
      return { ...base, replyMessageId: reply.id, status: 'PROCESSED', reason: null };
    });
  } catch (error) {
    // 模型或装配异常：按类型化失败收口，不自动重试。宿主停机（外部 signal）留给租约清扫。
    if (options.signal?.aborted === true) {
      return { ...base, replyMessageId: null, status: 'DISCARDED', reason: null };
    }
    const reason = error instanceof DomainError ? error.code : 'MODEL_FAILED';
    return settleFailure(db, options, now, base, reason);
  } finally {
    clearInterval(heartbeat);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

async function settleFailure(db: DbExecutor, options: MemberWakeupOptions, now: Date,
  base: Pick<MemberWakeupOutcome, 'messageId' | 'conversationId' | 'memberId'>,
  reason: string): Promise<MemberWakeupOutcome> {
  await withTransaction(db, (tx) => tx.memberConversations
    .settleWakeupFailed(base.messageId, options.workerId, now, reason));
  return { ...base, replyMessageId: null, status: 'FAILED', reason };
}
