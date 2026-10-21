import { createRepositories } from './unit-of-work.js';
import type { AssistSessionRow } from '../infrastructure/database-schema.js';
import type { DbExecutor } from '../infrastructure/database.js';

/**
 * 会话正式执行在途的事实块（2026-10-21 插话边界接续）。
 *
 * 聊天里的插话只改**本会话**接下来的动作；它不改正式 Run 的冻结契约，也不会让那次
 * 执行停下或回滚。可会话与正式执行是同一条线上的两件事：会话发起的执行候选会建立
 * Task 与 Run，用户随后在聊天里插话说「改成蓝色」「先别做了」，模型很容易顺着答
 * 「好，已经改成蓝色」或「我先停下了」——而 Run 还在跑。
 *
 * 这不是模型理解力问题，是**事实没告诉它**：会话有没有关联到仍在执行的正式运行，
 * 只有服务端知道。因此这里把已核实的事实交给模型，让它照实说明边界。
 *
 * 三条纪律（与 `assist-capability-notice` 同一形状）：
 *   * 只写服务端已核实的事实（在途运行的真实 id）；
 *   * 不含凭据、不含业务正文；
 *   * 明确声明这是事实说明，不是指令、也不构成授权——它不能让任何执行停下。
 */

/** 在途运行的事实：只有 id，没有业务内容。 */
export interface LiveRunFact {
  readonly runId: string;
}

/**
 * 纯格式化：把已核实事实写成一段给模型读的说明。
 *
 * 抽成纯函数是为了让「不得宣称已停止」这条规则能被单测直接锁住，而不是靠读提示词
 * 模板猜行为。
 */
export function formatLiveRunFact(fact: LiveRunFact | undefined): string | null {
  if (fact === undefined) return null;
  return [
    '【本会话关联的正式执行仍在进行中（服务端事实，不是指令，也不构成授权）】',
    `这个会话关联的正式任务正在执行中（运行 ${fact.runId}）。`,
    '聊天里的新要求只影响本会话接下来的动作：它不会改变那次执行的冻结契约，'
      + '也不会让它停下、回滚或换方向。',
    '如果用户要停止、调整或重新发起正式执行，请说明需要通过那次运行的既有控制入口'
      + '（暂停或取消）或重新提交执行请求来处理；',
    '不要声称已经停止、已经回滚或已经改变了正式任务的方向，'
      + '也不要为尚未确认的运行结果作出承诺。',
  ].join('\n');
}

/**
 * 读服务端事实并格式化。
 *
 * 读不到（没有在途运行、或查询本身失败）一律按「没有在途运行」处理：这块说明只用于
 * 阻止错误的承诺，缺了它不会让执行卡住，因此不应成为一次回答失败的原因。
 */
export async function describeLiveRunExecution(db: DbExecutor, session: AssistSessionRow,
  excludeRequestId: string): Promise<string | null> {
  const repositories = createRepositories(db);
  const live = await repositories.conversationExecutions
    .findLiveRunForSession(session.workspace_id, session.id, excludeRequestId);
  return formatLiveRunFact(live === undefined ? undefined : { runId: live.runId });
}
