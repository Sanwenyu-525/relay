import type { DbExecutor } from '../infrastructure/database.js';
import type { AssistSessionRow, AssistSessionStatus } from '../infrastructure/database-schema.js';
import { checkRequiredText, normalizeText } from '../shared/text.js';
import { toDecimalString } from '../shared/decimal.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { invalidTransition, resourceNotFound, revisionConflict, validationFailed } from './domain-error.js';
import { requireRevision } from './revisions.js';
import type { Repositories } from './unit-of-work.js';

/**
 * 会话行内控制的唯一应用 Owner（协作页左栏 §28.1，迁移 0090 / 0104）。
 *
 * 这几件事改的都是 `assist_sessions` 行**自身**的几项事实：标题、置顶排序键、未读标记、归档状态。
 * 它们不建 Task/Run、不发模型或工具调用、不写任何业务事实，也不改会话身份
 * （`conversation_mode` 与人设快照仍按 0059/0072 冻结，改名不等于改身份）。
 * 与既有 Assist 命令一致，审计留在命令回执里，不另写 activity 事件——绑定目录那批
 * 会话级命令也没有 activity 记录，这里不引入第二套口径。
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
