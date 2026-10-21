import type { DbExecutor } from '../infrastructure/database.js';
import { applyConversationExecution, isAutoStartConversationExecution } from './conversation-execution.js';
import { createRepositories } from './unit-of-work.js';
import { DomainError } from './domain-error.js';
import { readAdmission } from './maintenance-admission.js';

/**
 * 会话执行请求的**服务端**推进 Owner（2026-10-20 第二轮）。
 *
 * 此前「候选已就绪 → 建 Task/Run」由一个前端 effect 触发：页面关掉、刷新时机错过或
 * 另一台设备发起的请求，都会停在 READY 等一次并不必要的用户点击。那既不满足
 * 「发消息后就可以离开」，也让真正的推进责任散落在多个客户端上。
 *
 * 这里把它收回服务端：Worker 每个 tick 扫一遍「已就绪、还没有 Run」的原请求，沿
 * **原请求行上已经固定的三个阶段命令身份**（task/ready/delegate）调用既有
 * `applyConversationExecution()`。因此：
 *   * 不需要新命令、新表或第二个推进状态；
 *   * 重复扫描与迟到扫描都只重放原回执，不会产生第二个 Task 或 Run；
 *   * 前端不再需要持有推进责任，只保留故障后的显式「继续原请求」入口。
 *
 * 仍然是「候选 + 准入」而不是「自动全权执行」：能否真正建 Task/Run 由
 * `applyConversationExecution()` 里的会话/项目/资源/连接校验决定，写动作仍逐次过
 * Gateway 与审批。本函数只负责「谁来喊这一声」。
 */

/** 一次 tick 最多推进几条，避免一次进程周期被某个项目的批量请求占满。 */
const DEFAULT_LIMIT = 4;

export interface AutoStartTickResult {
  readonly applied: readonly { readonly requestId: string; readonly runId: string | null }[];
  readonly failed: readonly { readonly requestId: string; readonly reason: string }[];
}

/**
 * 本轮可以自动推进的请求：决定为 PREPARE、候选 READY、还没有 Run，且停在可接续阶段。
 *
 * `FAILED` 刻意**不在**名单里。它表示上次推进已经给出过具体原因（缺连接、缺目录、
 * 会话已有在途 Run 等），再自动重试只会把同一个错误刷成噪声；用户补齐配置后点一次
 * 「继续原请求」即可，那是一次明确的人工决定，不是被动的重复尝试。
 */
export async function runConversationExecutionAutoStartTick(db: DbExecutor,
  options?: { readonly limit?: number }): Promise<AutoStartTickResult> {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const repositories = createRepositories(db);
  // 维护/隔离期不推进：`settleDelegatedRequest()` 本身会拒绝，但那时错误已经被记到请求行上，
  // 一条本来完全合法的请求会因为「当时在维护」变成需要人工重试的失败。这里先退出去更诚实。
  if ((await readAdmission(repositories, 'share')).mode !== 'NORMAL') {
    return { applied: [], failed: [] };
  }
  const candidates = await repositories.conversationExecutions.listAutoStartCandidates(limit);
  const applied: { requestId: string; runId: string | null }[] = [];
  const failed: { requestId: string; reason: string }[] = [];
  for (const row of candidates) {
    if (!isAutoStartConversationExecution(row)) continue;
    try {
      const result = await applyConversationExecution(db, {
        workspaceId: row.workspace_id, requestId: row.id });
      applied.push({ requestId: row.id, runId: result.run_id });
    } catch (error) {
      // 推进失败必须留下**具体**原因，并且从这里退出去：修复前不再自动重试。
      // 重要一点：原因写在原请求行上而不是只写日志——用户关掉页面再回来时，
      // 唯一能告诉他「缺哪个连接」的就是这一行。
      const detail = error instanceof DomainError ? error.detail
        : error instanceof Error ? error.message : '本次推进没有完成。';
      const marked = await repositories.conversationExecutions.markAutoStartFailed(row.id, detail);
      // 已被别的推进结算（例如前端同时点了「继续」）时 marked 为 undefined：那不是失败。
      if (marked !== undefined) failed.push({ requestId: row.id, reason: detail });
    }
  }
  return { applied, failed };
}
