import type { RelayAssistMessage } from "../api/relayClient";

/**
 * 消息落地判定：权威投影的末条消息从 previous 变到 next，是否算「落地了一条消息」。
 *
 * 左栏按最后消息时间排序，服务端在两个写入 Owner 上单调推进 `last_message_at`
 * （迁移 0111）：`insertMessage`（用户消息与发送时预插的 PENDING ASSISTANT 行）与
 * `settleGeneration`（CAS 命中后结算）。因此只有两件事对应排序键前进：
 * ① 末条消息换了 id——新落地了一条（发送、插话、重开都走命令插行）；
 * ② 同一条在途消息转终态——结算时刻再推进一次（失败与取消同样上浮）。
 *
 * 在途心跳（PENDING→RUNNING）不算落地：服务端不为状态翻转写 `last_message_at`，
 * 拿它触发重读只会让每次生成多发一次请求。previous 为 null 是首读基线
 * （切会话后的第一次权威读取），next 为 null 是一条消息都没有，两者都不递计数。
 */

const terminalStatuses: ReadonlySet<RelayAssistMessage["status"]> = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export function assistActivityLanded(previous: RelayAssistMessage | null, next: RelayAssistMessage | null): boolean {
  if (previous === null || next === null) return false;
  if (previous.id !== next.id) return true;
  return !terminalStatuses.has(previous.status) && terminalStatuses.has(next.status);
}
