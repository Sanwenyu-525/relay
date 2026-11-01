import type { RelayApiClient, RelayAssistSession } from "../api/relayClient";
import { describeLiveError, needsReceiptCheck } from "./liveErrors";

/**
 * 会话删除的**结果事实**（2026-10-31）。
 *
 * 删除是本工作台唯一不可撤销的操作，因此结果只有四种，不允许有第五种含糊说法：
 *   * `deleted`    —— 服务端确认这条讨论已经不在了（要么命令直接成功，要么按原 command_id
 *                    核对回执确认已提交）。
 *   * `blocked`    —— 服务端明确拒绝（被别的对象引用）：行还在，原因逐条可读。
 *   * `failed`     —— 服务端明确拒绝且不是阻断（修订冲突、校验失败等）：行还在。
 *   * `unresolved` —— **是否生效未知**：5xx、响应丢失、正文读不出。这一档既不是成功也不是
 *                    失败，界面不得替用户猜，只能按原 command_id 核对回执。
 *
 * 「响应丢失」过去被当成失败显示，等于用一句没依据的话否定了一次可能已经发生的删除；
 * 「5xx 一定是失败」也不成立——命令与回执在同一事务里提交，5xx 之后服务端可能已经删成功。
 * 因此这里把「需要按原命令核对回执」这一档显式建模出来。
 */
export type SessionDeleteOutcome =
  | { readonly state: "deleted"; readonly viaReceipt: boolean }
  | {
    readonly state: "blocked";
    readonly reasons: readonly string[];
    readonly reasonCodes: readonly string[];
  }
  | {
    readonly state: "failed";
    readonly message: string;
    readonly requestId: string | null;
    readonly conflict: boolean;
  }
  | {
    readonly state: "unresolved";
    readonly message: string;
    readonly requestId: string | null;
    readonly commandId: string;
  };

/**
 * 按**原 command_id** 核对回执，判断这次删除到底生效没有。
 *
 * 判定只有两条：回执存在且命令类型是 `DeleteAssistSession` → 已删；回执不存在 → 还没查到
 * （服务端明确说过：回执不存在不能证明一个仍在事务中的请求永远未提交，因此这一档是
 * 「待核实」，不是「失败」）。回执存在但命令类型对不上 → 同样不能算已删。
 */
export type DeleteReceiptVerdict = "deleted" | "unresolved";

export async function verifyDeleteReceipt(
  client: RelayApiClient,
  commandId: string,
): Promise<DeleteReceiptVerdict> {
  try {
    const receipt = await client.getCommandReceipt(commandId);
    return receipt.commandType === "DeleteAssistSession" ? "deleted" : "unresolved";
  } catch {
    // 404（回执不存在）与读取失败都归「待核实」：两种情况都不能替用户断定删没删。
    return "unresolved";
  }
}

/**
 * 发一次删除命令，并把结果归成上面四种事实之一。
 *
 * * 成功：直接 `deleted`。
 * * 业务阻断（409 SESSION_DELETE_BLOCKED）：`blocked`，原因逐条返回。
 * * 其它明确拒绝（409 修订冲突、422 校验…）：`failed`，行还在。
 * * 结果未知（5xx / 传输失败 / 正文读不出）：**按原 command_id 核对一次回执**——
 *   核对到已删就算删成功（`viaReceipt: true`），核对不到就留在 `unresolved`，
 *   既不宣称失败，也不换 command_id 重发。
 */
export async function deleteSessionAndVerify(
  client: RelayApiClient,
  session: Pick<RelayAssistSession, "id" | "revision">,
  commandId: string,
): Promise<SessionDeleteOutcome> {
  try {
    await client.deleteAssistSession({ sessionId: session.id, commandId,
      expectedRevision: session.revision });
    return { state: "deleted", viaReceipt: false };
  } catch (caught) {
    if (needsReceiptCheck(caught)) {
      const described = describeLiveError(caught);
      const verdict = await verifyDeleteReceipt(client, commandId);
      if (verdict === "deleted") return { state: "deleted", viaReceipt: true };
      return {
        state: "unresolved",
        message: described.kind === "transport"
          ? "响应丢失，这次删除是否已生效还没有确定。请按原命令核对回执，不要重复删除。"
          : "服务端没能完成这次操作，是否已生效还没有确定。请按原命令核对回执，不要重复删除。",
        requestId: described.requestId ?? null,
        commandId
      };
    }
    const described = describeLiveError(caught);
    if (described.blockedReasons !== undefined && described.blockedReasons.length > 0) {
      return { state: "blocked", reasons: described.blockedReasons,
        reasonCodes: described.blockedReasonCodes ?? [] };
    }
    return {
      state: "failed",
      message: described.kind === "conflict"
        ? "这条讨论刚被改过，已重新读取最新内容，请核对后再删除。"
        : described.message,
      requestId: described.requestId ?? null,
      conflict: described.kind === "conflict"
    };
  }
}

/** 复制到剪贴板；失败不抛，界面只把按钮短暂切成「已复制」。 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined) return false;
  try { await clipboard.writeText(text); return true; }
  catch { return false; }
}
