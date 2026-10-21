import type { AssistGoalRow, ChatMode } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { toDecimalString } from '../shared/decimal.js';
import { httpCommandScopeKey } from './actor.js';
import { runIdempotentCommand, type CommandOutcome } from './command.js';
import { DomainError, resourceNotFound } from './domain-error.js';
import { createRepositories, type Repositories } from './unit-of-work.js';
import { goalProjection } from './assist-goals.js';

/**
 * 0127：会话行为模式切换（工作台 §44.1）。
 *
 * 「选择器里的未发送草稿」与「服务端生效的模式」是两件事：选择器只读服务端状态，
 * 用户点选才发命令；命令按修订号 CAS 落库，之后所有消息按**服务端**的模式处理。
 * 本地不保存运行状态——刷新、换窗口、另一台设备读到的都是同一份。
 *
 * 模式切换本身**不启动执行**：切到 `/goal` 只是让下一条消息按目标处理；要真正开始工作
 * 仍需要一条带目标内容的消息，或者「按此计划执行」这条独立命令。
 *
 * 从活动目标切走时先持久化暂停意图：这一步必须落在同一次命令里，否则「界面已经显示
 * 计划模式、后端还在推进目标」就成了第二个真相。
 */

export type ChatModeTransition = {
  readonly session_id: string;
  readonly chat_mode: ChatMode;
  readonly revision: string;
  /**
   * 有活动目标时切走：控制意图已持久化，但在途轮次还没安全停下。
   * 界面据此显示「正在安全停止在途行动」，不在这一刻宣称已经切换完成。
   */
  readonly goal_stopping: boolean;
  readonly goal: JsonObject | null;
};

const OPEN_CONTROL_STATUSES: readonly AssistGoalRow['status'][] = ['ACTIVE', 'PAUSING'];

/**
 * 目标投影（含启动时选定的计划版本号）。
 *
 * 版本号只用于界面显示「按第 N 版执行」；它不参与任何执行判定。
 */
async function goalWithPlanVersion(repositories: Repositories,
  goal: AssistGoalRow): Promise<JsonObject> {
  const version = goal.plan_version_id === null ? null
    : (await repositories.planGoals.readPlan(goal.plan_version_id))?.version ?? null;
  return goalProjection(goal, version, null) as unknown as JsonObject;
}

/** 从活动目标切走时，把「暂停」这条控制意图写进目标。 */
async function requestGoalStopForModeSwitch(repositories: Repositories,
  goal: AssistGoalRow): Promise<boolean> {
  if (!OPEN_CONTROL_STATUSES.includes(goal.status)) return false;
  if (goal.status === 'PAUSING') return true;
  const updated = await repositories.planGoals.updateGoal(goal.id, goal.revision,
    { status: 'PAUSING' });
  // 竞争失败说明别人刚刚改了状态（暂停/取消/完成）：不覆盖，也不需要报错——
  // 用户看到的将是那次决定的真实结果。
  return updated;
}

/**
 * 0127：`/plan 内容`、`/goal 内容` 的行首前缀解析（与工作台 `lib/chatModeCommand.ts` 同一约定）。
 *
 * UI 客户端把它剥成「模式 + 正文」一次提交；原始 API 调用者直接发 `/plan X` 也必须得到
 * 同一事实——模式与消息在同一命令里生效。只认行首，名称后必须紧跟空白或结束，
 * 因此 `/plan-mode` 与正文中间的 `/plan` 都不是命令。
 */
export function parseChatModePrefix(content: string):
  { readonly mode: ChatMode; readonly rest: string } | null {
  const trimmed = content.trim();
  const match = /^\/([^\s/]+)(?=\s|$)/u.exec(trimmed);
  if (match === null) return null;
  const mode = ({ plan: 'PLAN', '计划': 'PLAN', goal: 'GOAL', '目标': 'GOAL' } as
    Record<string, ChatMode>)[match[1]!.toLowerCase()];
  if (mode === undefined) return null;
  return { mode, rest: trimmed.slice(match[0].length).trim() };
}

export async function setChatMode(db: DbExecutor, input: {
  workspaceId: string;
  sessionId: string;
  commandId: string;
  mode: ChatMode;
  expectedRevision?: string | undefined;
}): Promise<CommandOutcome<ChatModeTransition>> {
  if (input.expectedRevision !== undefined && !/^[1-9][0-9]*$/u.test(input.expectedRevision)) {
    throw new DomainError({ code: 'VALIDATION_FAILED', status: 422,
      type: '/problems/validation-failed', title: '请求未通过校验',
      detail: 'expected_revision 必须是正整数修订号。', retryable: false,
      retryAction: 'NONE', fieldErrors: [{ field: 'expected_revision',
        message: '必须是正整数修订号' }] });
  }
  return runIdempotentCommand<ChatModeTransition>(db, {
    scopeKey: httpCommandScopeKey(input.workspaceId), commandId: input.commandId,
    commandType: 'SetChatMode', target: { session_id: input.sessionId },
    body: { mode: input.mode,
      ...(input.expectedRevision === undefined ? {} : { expected_revision: input.expectedRevision }) },
    execute: async (repositories) => {
      const session = await repositories.assist.readSession(input.sessionId, true);
      if (session === undefined || session.workspace_id !== input.workspaceId) {
        throw resourceNotFound('Assist session');
      }
      if (session.status !== 'ACTIVE') {
        throw new DomainError({ code: 'INVALID_TRANSITION', status: 409,
          type: '/problems/invalid-transition', title: '当前事实不满足该操作',
          detail: '会话已归档，不能再切换模式。', retryable: false,
          retryAction: 'REFRESH_AND_REDECIDE', conflict: { sessionId: session.id } });
      }
      const openGoal = await repositories.planGoals.readOpenGoal(session.id, true);
      // 切走时先记暂停意图（切到 GOAL 不需要：目标本来就要继续推进）。
      const stopping = openGoal !== undefined && input.mode !== 'GOAL'
        ? await requestGoalStopForModeSwitch(repositories, openGoal) : false;
      const expected = input.expectedRevision === undefined ? undefined
        : BigInt(input.expectedRevision);
      if (session.chat_mode !== input.mode) {
        const switched = await repositories.planGoals.setSessionChatMode({
          sessionId: session.id, mode: input.mode,
          ...(expected === undefined ? {} : { expectedRevision: expected }),
        });
        if (!switched) {
          const current = await repositories.planGoals.readSessionChatMode(session.id);
          throw new DomainError({ code: 'CHAT_MODE_REVISION_CONFLICT', status: 409,
            type: '/problems/chat-mode-revision-conflict', title: '会话模式已被其他操作修改',
            detail: '这条会话的模式刚被另一个操作改写；请重新读取当前模式后再选择。',
            retryable: true, retryAction: 'REFRESH_AND_REDECIDE', conflict: {
              entityType: 'assist_session',
              ...(expected === undefined ? {} : { expectedRevision: toDecimalString(expected) }),
              ...(current === undefined ? {} : { actualRevision: toDecimalString(current.revision) }),
              sessionId: session.id } });
        }
      } else if (expected !== undefined && session.revision !== expected) {
        throw new DomainError({ code: 'CHAT_MODE_REVISION_CONFLICT', status: 409,
          type: '/problems/chat-mode-revision-conflict', title: '会话状态已被其他操作修改',
          detail: '这条会话刚被另一个操作改写；请重新读取当前状态后再选择。',
          retryable: true, retryAction: 'REFRESH_AND_REDECIDE', conflict: {
            entityType: 'assist_session', expectedRevision: toDecimalString(expected),
            actualRevision: toDecimalString(session.revision), sessionId: session.id } });
      }
      const fresh = await repositories.assist.readSession(session.id);
      if (fresh === undefined) throw resourceNotFound('Assist session');
      const goalAfter = await repositories.planGoals.readOpenGoal(session.id);
      return {
        session_id: fresh.id, chat_mode: fresh.chat_mode,
        revision: toDecimalString(fresh.revision),
        goal_stopping: stopping,
        goal: goalAfter === undefined ? null
          : await goalWithPlanVersion(repositories, goalAfter),
      };
    },
  });
}
