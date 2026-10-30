import type { RelayContextBudgetTokens } from "../api/dtos/assist";

/**
 * 首条消息之前的**上下文档位草稿**（本机偏好，不是业务事实）。
 *
 * 2026-10-30 用户指令：空白新会话也要能选 256K／512K／1024K。此时还没有会话，
 * 档位没有地方可存，因此先按「新会话草稿作用域」留在本机；建会话命令把它一起带过去，
 * 在**创建事务里**写进会话行——第一个模型调用就按用户选的档位冻结预算，
 * 不存在「先按 256K 发起、再补写一次」的第二步。
 *
 * 作用域跟着首条的作用域走（工作区 + 项目/任务）：换一个作用域就是另一份草稿，
 * 因此「切换新会话」不会把这里的档位串到别的会话上。真正的业务事实仍然是服务端那一行，
 * 本机这份只负责「还没建会话时用户选了什么」。
 */
const PREFIX = "relay.workbench.contextBudgetDraft";
const VERSION = 1;
const TIERS: readonly RelayContextBudgetTokens[] = [262_144, 524_288, 1_048_576];

function storageKey(workspaceId: string, scope: string): string {
  return `${PREFIX}:${VERSION}:${workspaceId}:${scope}`;
}

/** 读回草稿档位；没有记录或值不合法时返回 null（由调用方取缺省档）。 */
export function readContextBudgetDraft(workspaceId: string,
  scope: string): RelayContextBudgetTokens | null {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(storageKey(workspaceId, scope)) ?? "null");
    if (typeof raw !== "object" || raw === null) return null;
    const value = (raw as { tokens?: unknown }).tokens;
    return TIERS.find((tier) => tier === value) ?? null;
  } catch { return null; }
}

/** 写入草稿档位；null 表示清除这份草稿。 */
export function writeContextBudgetDraft(workspaceId: string, scope: string,
  tokens: RelayContextBudgetTokens | null): void {
  try {
    if (tokens === null) { window.localStorage.removeItem(storageKey(workspaceId, scope)); return; }
    window.localStorage.setItem(storageKey(workspaceId, scope), JSON.stringify({ tokens }));
  } catch { /* 本机存储不可写时输入本身不受影响，档位退回缺省值。 */ }
}
