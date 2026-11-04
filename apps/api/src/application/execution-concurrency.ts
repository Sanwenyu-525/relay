import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import { DEFAULT_MAX_CONCURRENT_EXECUTIONS } from '../config/config.js';

/**
 * 系统级执行并发准入（runtime-context §2.12「并发上限」缺口的最小闭合）。
 *
 * 结构性上界此前只有「一条 Task 一个活动 Run」「一个会话一条 RUNNING 消息」，
 * 但跨会话/跨项目的后台执行（会话生成、成员唤醒、标题、导入、Run 命令）没有
 * 「同时最多 N 个执行者」的显式闸：常驻 API 与 Worker 各自领取，多个进程同时
 * 在跑时并行度只受进程数约束。这里补一个跨进程口径的准入读数：
 *
 *   * 统计三张执行账本上仍被租约持有的在途执行（Run 命令领取、会话生成、
 *     成员唤醒）。过期/心跳停摆的行由各自的恢复清扫收敛，统计只认「租约或心跳
 *     仍然新鲜」的行——已停的执行不算占位，避免把陈旧遗留读成系统满载。
 *   * `active < cap` 才允许本进程继续领取新工作；各 Owner 的既有领取 CAS 不变，
 *     因此闸是**准入建议**而不是第二套调度状态：检查与领取之间没有跨进程原子性，
 *     实际峰值最多超出 cap 一个「同时在做检查的进程数」（桌面拓扑 ≤ 2–3），
 *     不会无界。周期重复检查不重试领取——被闸住的候选下一拍自然再试。
 *   * 不新增表、不改迁移：读数全部来自既有账本行。
 */

export const EXECUTION_CONCURRENCY_ENV = 'RELAY_MAX_CONCURRENT_EXECUTIONS';

export interface ExecutionConcurrencyAdmission {
  readonly cap: number;
  readonly active: number;
  readonly admitted: boolean;
}

/**
 * 闸的启用判定：非 test 环境默认启用；test 环境只有显式设置
 * `RELAY_MAX_CONCURRENT_EXECUTIONS`（即显式选择上界）才启用。
 *
 * 原因：既有崩溃/竞争用例会在共享测试库里**有意**遗留在途行（RUNNING 消息、
 * 过期领取），闸若在测试默认生效，会把「上一用例的遗留」读成「系统满载」，
 * 让大批与并发无关的套件变成抖动源。生产与验收显式配置时闸照常生效。
 */
export function executionConcurrencyGateEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[EXECUTION_CONCURRENCY_ENV] !== undefined || env.NODE_ENV !== 'test';
}

export function readExecutionConcurrencyCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env[EXECUTION_CONCURRENCY_ENV]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_MAX_CONCURRENT_EXECUTIONS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error(`${EXECUTION_CONCURRENCY_ENV} must be an integer between 1 and 64`);
  }
  return value;
}

/** 各执行账本上仍被租约持有的在途执行数；同一查询覆盖 Run/会话生成/成员唤醒。 */
export async function countActiveExecutions(db: DbExecutor): Promise<number> {
  const result = await sql<{ active: string }>`
    select (
      (select count(*) from run_invocations
        where status = 'ACTIVE' and lease_until > clock_timestamp())
      + (select count(*) from assist_messages
        where status = 'RUNNING'
          and updated_at > clock_timestamp() - interval '120 seconds')
      + (select count(*) from project_member_messages
        where processing_status = 'CLAIMED' and lease_expires_at > clock_timestamp())
    )::text as active
  `.execute(db);
  const active = result.rows[0]?.active;
  return active === undefined ? 0 : Number(active);
}

/** 本进程这一拍是否允许继续领取新执行；结果只反映读取时刻，不构成预留。 */
export async function planExecutionAdmission(db: DbExecutor, cap: number,
): Promise<ExecutionConcurrencyAdmission> {
  const active = await countActiveExecutions(db);
  return { cap, active, admitted: active < cap };
}
