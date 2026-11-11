import type { RelayAssistMessage, RelayAssistProposal } from "../api/relayClient";

/**
 * 会话转录的**展示缓存**（2026-11-10，会话切换防闪）。
 *
 * 切换会话时 `AssistView` 按 session id 重挂载，消息读回前的那一帧既没有列表也没有
 * 滚动位置：空档消失后新内容一次性出现，再跳到底部，读起来就是「闪一下」。
 *
 * 这里只保存**上一次成功读回**的消息与提案，供重挂载时同步初始化；它不参与业务判断，
 * 也不冒充当前事实——面板挂载后立刻 `refresh()`，服务端结果覆盖缓存；读取失败时沿用
 * 既有的「下面显示的是上次成功读取的内容，可能已过期」说明。缓存按 workspace + session
 * 隔离，最多 12 条，读/写都刷新 LRU 位置。
 */

export interface CachedSessionTranscript {
  readonly messages: readonly RelayAssistMessage[];
  readonly proposals: readonly RelayAssistProposal[];
}

/** 单工作区保留的会话数：足够覆盖近期来回切换，又不会让长会话历史常驻内存。 */
const MAX_ENTRIES = 12;

const cache = new Map<string, CachedSessionTranscript>();

function keyOf(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

export function readCachedSessionTranscript(workspaceId: string,
  sessionId: string): CachedSessionTranscript | null {
  const key = keyOf(workspaceId, sessionId);
  const value = cache.get(key);
  if (value === undefined) return null;
  // Map 的插入顺序就是 LRU 顺序：读一次也算用过。
  cache.delete(key);
  cache.set(key, value);
  return value;
}

export function writeCachedSessionTranscript(workspaceId: string, sessionId: string,
  value: CachedSessionTranscript): void {
  const key = keyOf(workspaceId, sessionId);
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** 服务端明确否认这段内容（403/404）时丢弃缓存，避免下次切换又显示一遍。 */
export function dropCachedSessionTranscript(workspaceId: string, sessionId: string): void {
  cache.delete(keyOf(workspaceId, sessionId));
}

/** 用例之间清空模块级缓存；生产路径不需要调用。 */
export function clearSessionTranscriptCache(): void {
  cache.clear();
}
