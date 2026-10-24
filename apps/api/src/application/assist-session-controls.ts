import { randomUUID } from 'node:crypto';

import type { DbExecutor } from '../infrastructure/database.js';
import type { AssistSessionRow, AssistSessionStatus } from '../infrastructure/database-schema.js';
import { checkRequiredText, normalizeText, TEXT_LIMITS } from '../shared/text.js';
import { toDecimalString } from '../shared/decimal.js';
import { LOCAL_ACTOR_REF, httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { assistSessionDeleteBlocked, invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { requireRevision } from './revisions.js';
import type { Repositories } from './unit-of-work.js';

/**
 * 会话行内控制的唯一应用 Owner（协作页左栏 §28.1，迁移 0090 / 0104 / 0113）。
 *
 * 这几件事改的都是 `assist_sessions` 行**自身**的几项事实：标题、置顶排序键、未读标记、归档状态。
 * 它们不建 Task/Run、不发模型或工具调用、不写任何业务事实，也不改会话身份
 * （`conversation_mode` 与人设快照仍按 0059/0072 冻结，改名不等于改身份）。
 * 与既有 Assist 命令一致，审计留在命令回执里，不另写 activity 事件——绑定目录那批
 * 会话级命令也没有 activity 记录，这里不引入第二套口径。唯一的例外是物理删除：
 * 会话行连同消息一起消失，回执之外再写一条 append-only 的 `ASSIST_SESSION_DELETED`。
 *
 * 分叉是这里唯一一条**新建行**的命令：它不改源会话，而是复制出一条子会话连它的历史输入快照
 * （见 `forkAssistSession`）。源行的修订、标题与导航键都保持原样。
 *
 * 幂等与并发：同一 `command_id` + 同载荷重放返回当时结果；`expected_revision` 不匹配即
 * 409 `REVISION_CONFLICT`，界面重读后由人重新决定，绝不静默覆盖或换命令 ID 重试。
 * 行锁（`for update`）先于判定，因此「归档」与「发消息」不会各自看到对方还没发生的事实。
 *
 * 归档沿用 0015 就定义的 `status='ARCHIVED'`：这条边界此前只有读侧守卫（归档会话拒收
 * 新消息、拒绝改归属与目录），本批补上写入口。归档**不删**任何行——消息、提案、命令
 * 回执与会话模型选择都留在原地，重开后照旧读得到（红线 3「历史保留」、红线 5「不假装原子」）。
 * 归档也不停止在途 Run：Run 生命周期归 Workflow，其结果仍按原身份投影回这条会话的历史。
 */

export type AssistSessionTitleResult = {
  readonly session_id: string;
  readonly title: string;
  readonly revision: string;
  readonly updated_at: string;
};

export type AssistSessionPinResult = {
  readonly session_id: string;
  readonly pinned: boolean;
  readonly pinned_at: string | null;
  readonly revision: string;
  readonly updated_at: string;
};

export type AssistSessionStatusResult = {
  readonly session_id: string;
  readonly status: AssistSessionStatus;
  readonly revision: string;
  readonly updated_at: string;
};

export type AssistSessionUnreadResult = {
  readonly session_id: string;
  readonly unread: boolean;
  readonly unread_at: string | null;
  readonly revision: string;
  readonly updated_at: string;
};

export type AssistSessionForkResult = {
  readonly session_id: string;
  readonly title: string;
  readonly revision: string;
  readonly updated_at: string;
  /** 这次复制进子会话的历史轮数；空讨论分叉即 0，不是失败。 */
  readonly copied_messages: number;
};

export interface RenameAssistSessionInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly title: string;
}

/**
 * 改名只改显示标题。标题按建会话同一套文本规则规范化（去首尾空白、1–200、无控制字符），
 * 规范化结果进命令摘要，因此「同一标题带不同空白」是同一个命令内容。
 */
export async function renameAssistSession(db: DbExecutor,
  input: RenameAssistSessionInput): Promise<CommandOutcome<AssistSessionTitleResult>> {
  const problem = checkRequiredText(input.title, 'title', 'title');
  if (problem !== undefined) throw validationFailed([problem]);
  const title = normalizeText(input.title);
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<AssistSessionTitleResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'RenameAssistSession',
    target: { session_id: input.sessionId },
    body: { expected_revision: expectedRevision.toString(), title },
    execute: async (repositories) => {
      const session = await requireEditableSession(repositories, input.workspaceId, input.sessionId,
        expectedRevision, '改名');
      const updated = await repositories.assist.applySessionControl(session.id, expectedRevision, { title });
      return titleResult(appliedSession(session, expectedRevision, updated));
    },
  });
}

export interface SetAssistSessionPinInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly pinned: boolean;
  /** 可注入时钟，供无 PG 的确定性单测；生产缺省 `new Date()`。 */
  readonly now?: Date | undefined;
}

/**
 * 置顶/取消置顶是同一条命令的两个方向，不做两个端点：两枚入口迟早会各长出一套规则。
 * 取消就是把排序键写回 NULL——置顶时刻本身不是需要留存的历史事实，那一次改动在回执里。
 */
export async function setAssistSessionPin(db: DbExecutor,
  input: SetAssistSessionPinInput): Promise<CommandOutcome<AssistSessionPinResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  const pinnedAt = input.pinned ? input.now ?? new Date() : null;
  return runIdempotentCommand<AssistSessionPinResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'SetAssistSessionPin',
    target: { session_id: input.sessionId },
    body: { expected_revision: expectedRevision.toString(), pinned: input.pinned },
    execute: async (repositories) => {
      const session = await requireEditableSession(repositories, input.workspaceId, input.sessionId,
        expectedRevision, input.pinned ? '置顶' : '取消置顶');
      const updated = await repositories.assist.applySessionControl(session.id, expectedRevision, { pinnedAt });
      return pinResult(appliedSession(session, expectedRevision, updated));
    },
  });
}

export interface SetAssistSessionUnreadInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
  readonly unread: boolean;
  /** 可注入时钟，供无 PG 的确定性单测；生产缺省 `new Date()`。 */
  readonly now?: Date | undefined;
}

/**
 * 未读标记（0104）：与置顶同一条形状的两个方向，不做两个端点。
 *
 * 它改的仍是这一行**自身**的一项导航偏好，与业务事实无关：不改变能不能发消息、
 * 绑哪个目录、归哪个项目，也不参与列表排序（排序键只有 `pinned_at` 与 `created_at`）。
 * 取消就是把标记写回 NULL，不在表里留「曾经未读」的历史——那一次改动在回执里。
 *
 * 本轮只有人工 toggle 一个写入方，因此不建「点开自动清除」：后者要防的是并发清除把
 * 刚打上的标记吃掉（上游 ZCode 为此另存一列单调版本做 CAS），而这里同一行的并发
 * 已由 `revision` 这一道 CAS 裁决，加第二套机制属提前建设。
 */
export async function setAssistSessionUnread(db: DbExecutor,
  input: SetAssistSessionUnreadInput): Promise<CommandOutcome<AssistSessionUnreadResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  const unreadAt = input.unread ? input.now ?? new Date() : null;
  return runIdempotentCommand<AssistSessionUnreadResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'SetAssistSessionUnread',
    target: { session_id: input.sessionId },
    body: { expected_revision: expectedRevision.toString(), unread: input.unread },
    execute: async (repositories) => {
      const session = await requireEditableSession(repositories, input.workspaceId, input.sessionId,
        expectedRevision, input.unread ? '标记未读' : '取消未读');
      const updated = await repositories.assist.applySessionControl(session.id, expectedRevision, { unreadAt });
      return unreadResult(appliedSession(session, expectedRevision, updated));
    },
  });
}

export interface ArchiveAssistSessionInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
}

export interface ForkAssistSessionInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
}

export interface DeleteAssistSessionInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly expectedRevision: string;
}

export type AssistSessionDeleteResult = {
  readonly session_id: string;
  readonly revision: string;
  readonly deleted_messages: number;
  readonly deleted_attachments: number;
  readonly deleted_at: string;
};

/**
 * 归档：会话退出默认列表、拒收新消息，历史全部保留。
 *
 * 在途消息（PENDING/RUNNING）挡住归档——「控制意图必须持久化，在途动作未安全处理前不宣称接手完成」。
 * 已在途的 Run 不在这里核对：Run 不属于会话，归档不该顺手处置执行，也不假装这两者原子；
 * 界面因此必须把「已归档」显示成「不再接收新消息」，而不是「工作已停止」。
 * 已是 ARCHIVED 时如实返回当前事实、不推进修订（与 ArchiveAssistantProfile 同一口径）。
 */
export async function archiveAssistSession(db: DbExecutor,
  input: ArchiveAssistSessionInput): Promise<CommandOutcome<AssistSessionStatusResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<AssistSessionStatusResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'ArchiveAssistSession',
    target: { session_id: input.sessionId },
    body: { expected_revision: expectedRevision.toString() },
    execute: async (repositories) => {
      const session = await requireSessionInWorkspace(repositories, input.workspaceId, input.sessionId);
      requireExpectedRevision(session, expectedRevision);
      if (session.status === 'ARCHIVED') return statusResult(session);
      if (await repositories.assist.hasInflightMessages(session.id)) {
        throw invalidTransition('这段讨论还有消息在途，等它结束再归档。', { sessionId: session.id });
      }
      const updated = await repositories.assist.applySessionControl(session.id, expectedRevision,
        { status: 'ARCHIVED' });
      return statusResult(appliedSession(session, expectedRevision, updated));
    },
  });
}

/**
 * 重开：把归档的会话放回 ACTIVE。
 *
 * 重开不授予任何新的执行权：所属项目已归档时，发消息仍按既有归档栅栏被拒（HTTP §10.36），
 * 目录写准入也照旧逐次核对。这里也不回填「归档期间错过的东西」——归档期间本来就不接收消息。
 */
export async function reopenAssistSession(db: DbExecutor,
  input: ArchiveAssistSessionInput): Promise<CommandOutcome<AssistSessionStatusResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<AssistSessionStatusResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'ReopenAssistSession',
    target: { session_id: input.sessionId },
    body: { expected_revision: expectedRevision.toString() },
    execute: async (repositories) => {
      const session = await requireSessionInWorkspace(repositories, input.workspaceId, input.sessionId);
      requireExpectedRevision(session, expectedRevision);
      if (session.status === 'ACTIVE') return statusResult(session);
      const updated = await repositories.assist.applySessionControl(session.id, expectedRevision,
        { status: 'ACTIVE' });
      return statusResult(appliedSession(session, expectedRevision, updated));
    },
  });
}

/**
 * 物理删除一条会话（ADR-027，迁移 0116）。这是本模块唯一**不可撤销**的命令。
 *
 * 与归档相反：归档保留全部历史并可用「重开」撤销；删除按子 → 父顺序删掉会话自有的账本，
 * 会话行本身也消失，没有回收站、不提供恢复命令。删除前先过两道栅栏——在途消息（与归档
 * 同一条）和跨对象引用（`listDeleteBlockers`），任何一道命中都整条拒绝、零删除。
 *
 * 审计：会话行与消息都不再存在，命令回执仍留在 `command_receipts`；另写一条 append-only 的
 * `activity_records`，这是该会话存在过的唯一痕迹。`fact_refs` 只记身份、修订与删除行数，
 * 不复制标题或正文——用户要求删除之后，审计不应该变成第二份保存。
 */
export async function deleteAssistSession(db: DbExecutor,
  input: DeleteAssistSessionInput): Promise<CommandOutcome<AssistSessionDeleteResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<AssistSessionDeleteResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'DeleteAssistSession',
    target: { session_id: input.sessionId },
    body: { expected_revision: expectedRevision.toString() },
    execute: async (repositories) => {
      const session = await requireSessionInWorkspace(repositories, input.workspaceId, input.sessionId);
      requireExpectedRevision(session, expectedRevision);
      if (await repositories.assist.hasInflightMessages(session.id)) {
        throw invalidTransition('这段讨论还有消息在途，等它结束再删除。', { sessionId: session.id });
      }
      const blockers = await repositories.assist.listDeleteBlockers(session.id);
      if (blockers.length > 0) throw assistSessionDeleteBlocked(blockers);
      const deleted = await repositories.assist.deleteSession(session.id, expectedRevision);
      if (deleted === undefined) {
        throw revisionConflict({ entityType: 'Assist session',
          expectedRevision: expectedRevision.toString(), actualRevision: session.revision.toString() });
      }
      const deletedAt = new Date();
      await repositories.activities.insertActivityRecord({
        id: randomUUID(), workspaceId: input.workspaceId,
        actorKind: 'HUMAN', actorRef: LOCAL_ACTOR_REF,
        commandId: input.commandId, projectId: session.project_id, taskId: session.task_id,
        eventType: 'ASSIST_SESSION_DELETED',
        factRefs: { session_id: session.id,
          previous_revision: expectedRevision.toString(),
          deleted_messages: deleted.messages,
          deleted_attachments: deleted.attachments },
      });
      return { session_id: session.id, revision: expectedRevision.toString(),
        deleted_messages: deleted.messages, deleted_attachments: deleted.attachments,
        deleted_at: deletedAt.toISOString() };
    },
  });
}

/**
 * 分叉一条会话（0113）：把这段讨论连历史复制成一条新会话，两条此后各自独立生长。
 *
 * 复制的是**输入快照**：会话身份（模式、人设快照、是否续读、归属项目与任务、绑定目录）整行搬运，
 * 已完成的消息与图片附件按新序号搬进子会话。刻意不搬的是过程与结局类事实——服务商请求号、
 * token 用量、领取 worker、错误码、逐候选尝试状态：子会话没有发生过那次外呼，留着就是伪造。
 * 模型选择快照也一并不搬：0098 要求它与尝试状态成对非空，而复制过去的历史不会再被生成路径
 * 读取，单搬快照既撞库约束又只是在子会话里留下一份没有读方的排队期事实。
 * 提案（assist_proposals）也不搬：接受一次会写业务事实，同一条提案不能在两条会话里各接受一次。
 * 置顶与未读一律归零——那是这一行自己的导航偏好，不是历史。
 *
 * 源会话一行都不改，也**不推进它的修订**：分叉不是对父会话的一次改写。`expected_revision`
 * 仍然核对，它挡的是「界面看的还是旧事实就按下分叉」（例如父会话其实已归档）。
 *
 * 在途消息挡住分叉：正在生成的那一轮既不该进历史，也不该让子会话从半截开始。理由与归档同一句
 * ——控制意图必须持久化，在途动作未安全处理前不宣称「这一段已经定稿」。
 *
 * **没有可搬历史的讨论同样挡住分叉**（2026-10-24 用户截图指认「已有会话打开是新建会话欢迎页」）：
 * 分叉的语义是「连历史复制一份」，历史为空时它唯一的结果就是多出一条同样空的会话，而空会话在
 * 左栏与有内容的会话同形同标题（标题只由 `关于<目标>` 生成），点进去只剩欢迎空态。那两条空会话
 * 都是「首条消息没落地」留下的残迹，不该再被复制一份。判据与搬运用同一份 `listForkableMessageIds`，
 * 且**在插子会话之前**读——被拒的分叉连一行都不留下。
 */
export async function forkAssistSession(db: DbExecutor,
  input: ForkAssistSessionInput): Promise<CommandOutcome<AssistSessionForkResult>> {
  const expectedRevision = requireRevision(input.expectedRevision, 'expected_revision');
  return runIdempotentCommand<AssistSessionForkResult>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId),
    commandId: input.commandId,
    commandType: 'ForkAssistSession',
    target: { session_id: input.sessionId },
    body: { expected_revision: expectedRevision.toString() },
    execute: async (repositories) => {
      const source = await requireEditableSession(repositories, input.workspaceId, input.sessionId,
        expectedRevision, '分叉');
      if (await repositories.assist.hasInflightMessages(source.id)) {
        throw invalidTransition('这段讨论还有消息在途，等它结束再分叉。', { sessionId: source.id });
      }
      // 先读历史再插子会话：空讨论被拒时不能留下一条没有来源意义的子会话行。
      const history = await repositories.assist.listForkableMessageIds(source.id);
      if (history.length === 0) {
        throw invalidTransition('这段讨论还没有可搬的历史，不能分叉。', { sessionId: source.id });
      }
      const child = await repositories.assist.insertForkedSession({ id: randomUUID(),
        fromSessionId: source.id, title: nextForkTitle(source.title) });
      if (child === undefined) throw resourceNotFound('Assist session');
      for (const [index, message] of history.entries()) {
        const childMessageId = randomUUID();
        const copied = await repositories.assist.copyMessageInto({ sourceMessageId: message.id,
          parentSessionId: source.id, childSessionId: child.id, childMessageId,
          seq: BigInt(index + 1) });
        if (!copied) throw resourceNotFound('Assist message');
        for (const sourceAttachmentId of await repositories.assist
          .listAttachmentIdsByMessage(message.id)) {
          if (!await repositories.assist.copyAttachmentInto({ sourceAttachmentId,
            parentSessionId: source.id, childSessionId: child.id, childMessageId,
            childAttachmentId: randomUUID() })) throw resourceNotFound('Assist attachment');
        }
      }
      // 子会话的这些行确实刚落库，活动排序键按「消息落库即活动」这一条口径推进一次；
      // 父会话的 last_message_at 不受影响——分叉不是一次活动。历史已在上方核对为非空，
      // 因此子会话不存在「没有消息却推进活动键」的分支。
      await repositories.assist.touchLastMessage(child.id);
      return forkResult(child, history.length);
    },
  });
}

/**
 * 分叉标题由服务端决定，不让界面各写一套「（1）」：末位已经是「（n）」（全角或半角都认）
 * 就把 n 加一，否则追加「（1）」。编号跟着**被分叉那一条自己的标题**走，因此同一源会话
 * 分两次都是「（1）」（标题本来就不是唯一键），分叉一条「（1）」得到的才是「（2）」。
 * 不按兄弟数量排号：那要在没有索引的来源列上反查子会话，只为一个显示编号不值得。
 * 上限仍守标题这一档（200）：超长时截的是正文前缀，编号永远完整留在末尾。
 */
export function nextForkTitle(title: string): string {
  const matched = /[（(](\d+)[）)]\s*$/u.exec(title);
  const suffix = `（${matched === null ? 1 : Number(matched[1]) + 1}）`;
  const chars = Array.from(matched === null ? title : title.slice(0, matched.index));
  // 按完整码点退让：既守住标题这一档的长度上限，也不会把一个 emoji 切成半个。
  while (chars.length > 0 && chars.join('').length + suffix.length > TEXT_LIMITS.title) {
    chars.pop();
  }
  return `${chars.join('')}${suffix}`;
}

/** 行锁读取 + 作用域核对：跨 Workspace 的会话按不可见处理（404），与既有会话命令一致。 */
async function requireSessionInWorkspace(repositories: Repositories,
  workspaceId: string, sessionId: string,
): Promise<AssistSessionRow> {
  const session = await repositories.assist.readSession(sessionId, true);
  if (session === undefined || session.workspace_id !== workspaceId) {
    throw resourceNotFound('Assist session');
  }
  return session;
}

/** 改名与置顶只作用于未归档会话：归档态下这些入口都会先要求重开，避免「改了却什么都发不出去」。 */
async function requireEditableSession(repositories: Repositories,
  workspaceId: string, sessionId: string, expectedRevision: bigint, action: string): Promise<AssistSessionRow> {
  const session = await requireSessionInWorkspace(repositories, workspaceId, sessionId);
  requireExpectedRevision(session, expectedRevision);
  if (session.status !== 'ACTIVE') {
    throw invalidTransition(`会话已归档，不能${action}；先重开这条会话再操作。`, { sessionId: session.id });
  }
  return session;
}

function requireExpectedRevision(session: AssistSessionRow, expectedRevision: bigint): void {
  if (session.revision !== expectedRevision) {
    throw revisionConflict({ entityType: 'Assist session',
      expectedRevision: expectedRevision.toString(), actualRevision: session.revision.toString() });
  }
}

/**
 * CAS 落空的兜底：调用方已持行锁并核对过修订，正常路径不可能走到这里。
 * 真走到这里说明这一行在锁外被改或消失，只能抛错，不能返回一个「看起来对」的结果。
 */
function appliedSession(before: AssistSessionRow, expectedRevision: bigint,
  updated: AssistSessionRow | undefined): AssistSessionRow {
  if (updated !== undefined) return updated;
  throw revisionConflict({ entityType: 'Assist session',
    expectedRevision: expectedRevision.toString(), actualRevision: before.revision.toString() });
}

function titleResult(row: AssistSessionRow): AssistSessionTitleResult {
  return { session_id: row.id, title: row.title,
    revision: toDecimalString(row.revision), updated_at: row.updated_at.toISOString() };
}

function pinResult(row: AssistSessionRow): AssistSessionPinResult {
  return { session_id: row.id, pinned: row.pinned_at !== null,
    pinned_at: row.pinned_at === null ? null : row.pinned_at.toISOString(),
    revision: toDecimalString(row.revision), updated_at: row.updated_at.toISOString() };
}

function statusResult(row: AssistSessionRow): AssistSessionStatusResult {
  return { session_id: row.id, status: row.status,
    revision: toDecimalString(row.revision), updated_at: row.updated_at.toISOString() };
}

function unreadResult(row: AssistSessionRow): AssistSessionUnreadResult {
  return { session_id: row.id, unread: row.unread_at !== null,
    unread_at: row.unread_at?.toISOString() ?? null,
    revision: toDecimalString(row.revision), updated_at: row.updated_at.toISOString() };
}

function forkResult(row: AssistSessionRow, copiedMessages: number): AssistSessionForkResult {
  return { session_id: row.id, title: row.title, revision: toDecimalString(row.revision),
    updated_at: row.updated_at.toISOString(), copied_messages: copiedMessages };
}
