import type { RelayAssistSourceRef } from "../api/relayClient";

/**
 * 本机「最近引用过的资料版本」。与近期目录同一性质（领域模型 §12.2）：
 * 它只是本设备的展示偏好，不是资源身份，也不是授权事实——
 * 选中的引用仍只是「本次请求的候选输入」，发送时服务端会按获准范围与原版本复核。
 *
 * 只记确切的 kind/rootId/version 三元组；不缓存标题、摘要或任何资料正文，
 * 因此这份偏好不会成为第二套内容来源。
 */
const KEY = "relay.workbench.recentAssistSourceRefs";
const VERSION = 1;
/** 上限与发送时「每次消息最多选择 10 个资料版本」的既有约束一致。 */
const MAX_ENTRIES = 10;

export function sourceRefKey(ref: RelayAssistSourceRef): string {
  return `${ref.kind}:${ref.rootId}:${ref.version}`;
}

export function readRecentSourceRefs(): readonly RelayAssistSourceRef[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== VERSION) return [];
    const items = (raw as { entries?: unknown }).entries;
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is RelayAssistSourceRef => typeof item === "object" && item !== null &&
      ((item as RelayAssistSourceRef).kind === "KNOWLEDGE" ||
        (item as RelayAssistSourceRef).kind === "MEMORY" ||
        (item as RelayAssistSourceRef).kind === "DECISION") &&
      typeof (item as RelayAssistSourceRef).rootId === "string" &&
      typeof (item as RelayAssistSourceRef).version === "string").slice(0, MAX_ENTRIES);
  } catch { return []; }
}

/**
 * 记下一次实际发送用过的资料版本（按最近使用排在前面、同版本去重、超限截断）。
 * 只在服务端已受理这条消息后调用：没有任何引用时保持原列表，不写空记录。
 */
export function rememberSourceRefs(sent: readonly RelayAssistSourceRef[]): readonly RelayAssistSourceRef[] {
  const current = readRecentSourceRefs();
  if (sent.length === 0) return current;
  const sentKeys = new Set(sent.map(sourceRefKey));
  const next = [...sent, ...current.filter((item) => !sentKeys.has(sourceRefKey(item)))].slice(0, MAX_ENTRIES);
  try { window.localStorage.setItem(KEY, JSON.stringify({ version: VERSION, entries: next })); }
  catch { /* 偏好写不进去不影响服务端的资料选择与复核。 */ }
  return next;
}
