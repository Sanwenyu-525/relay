import { SessionToolCallRepository } from '../assist/session-tool-call-repository.js';
import type { DbExecutor } from '../infrastructure/database.js';

/**
 * 会话 Gateway 工具请求的恢复核对（AGENT-CORE-RELIABILITY，2026-11-01 P2-B）。
 *
 * 崩溃窗口的最后一侧：`settleSessionReadonlyToolCall` 在「登记 REQUESTED」与
 * 「prepare 提交动作」之间中断时，请求行没有 Operation、也没有任何外部副作用，而它
 * 所属的生成可能已经终止（LEASE_LOST／取消／失败），再也不会有人来结算它。与
 * todo_write 的收口（迁移 0152）同一语义：落 ABANDONED + 类型化原因，不重跑、
 * 不伪造成功。已绑定 Operation 的行不在这里动——那种行可能已经派出去了，归因由
 * 执行活动投影按 Gateway 证据只读完成（ENG-OBS-02），不改写账本。
 *
 * 与委派、todo 的核对同批挂在生成 tick 上；重复扫描是空操作（ABANDONED 不再匹配），
 * 单批有界，批次限额与todo 恢复核对同数量级。
 */

export const ORPHANED_SESSION_TOOL_CALL_REASON = 'SESSION_TOOL_CALL_NEVER_PREPARED';
export const ORPHANED_SESSION_TOOL_CALL_DETAIL = '生成已终止，且这次请求从未提交过任何 Gateway 动作：' +
  '没有执行、也没有外部副作用；需要这次读取请重新发起。';

const BATCH_LIMIT = 64;

export async function reconcileTerminatedGenerationToolCalls(db: DbExecutor): Promise<number> {
  const repository = new SessionToolCallRepository(db);
  const rows = await repository.listOrphanedGatewayRequests(BATCH_LIMIT);
  let closed = 0;
  for (const row of rows) {
    // 收口的全部前置条件都写进了同一条 UPDATE：列表读取之后消息终态或动作提交情况
    // 发生变化时，这一行原样不动，留给下一轮扫描按最新事实判定。
    if (await repository.abandonNeverDispatchedRequest(row.id,
      ORPHANED_SESSION_TOOL_CALL_REASON, ORPHANED_SESSION_TOOL_CALL_DETAIL)) {
      closed += 1;
    }
  }
  return closed;
}
