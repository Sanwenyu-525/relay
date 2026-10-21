import { useCallback, useEffect, useRef, useState } from "react";
import type { RelayApiClient, RelayConversationDiff, RelayConversationDiffScope } from "../api/relayClient";

interface ConversationDiffState {
  readonly diff: RelayConversationDiff | null;
  readonly loading: boolean;
  readonly error: string | null;
  /** 刷新失败但仍保留上次可信值：界面标「更新失败 · 截至…」（§34.4 / CD-17）。 */
  readonly stale: boolean;
  /** 上一次可信读取的本地时刻；只在有可信值时有意义。 */
  readonly readAt: string | null;
  readonly refresh: () => void;
}

/** 可信值按会话存放：切换会话的那一帧旧净变化立即不可见，不靠下一次响应来清。 */
interface Snapshot {
  readonly sessionId: string;
  readonly diff: RelayConversationDiff;
  readonly readAt: string;
}

/**
 * 会话总 diff 的轮询读取（工作台 §34 / 设计系统 §9.15）。
 *
 * 总数只反映「已落盘」内容：模型仍在生成的预览不进这里。轮询让输入框上方的居中总 diff
 * 跟上磁盘真实改动；`enabled` 为 false（只读会话 / 会话非 ACTIVE / 外部读取被挡）时整份收干净，
 * 不会出现「上一会话的净变化挂在当前会话上」。版本守卫保证切换会话后到达的响应被丢弃。
 *
 * 刷新失败**不清零**：保留上次可信值并标 stale（CD-17）；只有从未读到过可信值才显示不可用。
 */
export function useConversationDiff(client: RelayApiClient, sessionId: string | null,
  enabled: boolean, pollMs = 4000, scope: RelayConversationDiffScope = "SESSION"): ConversationDiffState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const version = useRef(0);

  const read = useCallback(async () => {
    if (!enabled || sessionId === null) {
      setSnapshot(null); setError(null); setInFlight(false);
      return;
    }
    const current = ++version.current;
    setInFlight(true);
    try {
      const next = await client.getConversationDiff(sessionId, scope);
      if (current !== version.current) return;
      setSnapshot({ sessionId, diff: next, readAt: new Date().toISOString() });
      setError(null);
    } catch (caught) {
      if (current !== version.current) return;
      // 失败时保留同一会话的可信值；换会话的可信值已在 enabled/sessionId 变化时收掉。
      setError(caught instanceof Error ? caught.message : "会话 diff 读不到。");
    } finally {
      if (current === version.current) setInFlight(false);
    }
  }, [client, sessionId, enabled, scope]);

  useEffect(() => {
    void read();
    if (!enabled || sessionId === null) return;
    const timer = setInterval(() => { void read(); }, pollMs);
    return () => { clearInterval(timer); version.current++; };
  }, [read, pollMs, enabled, sessionId]);

  const mine = snapshot !== null && snapshot.sessionId === sessionId ? snapshot : null;
  return {
    diff: mine?.diff ?? null,
    loading: enabled && sessionId !== null && inFlight,
    error,
    stale: error !== null && mine !== null,
    readAt: mine?.readAt ?? null,
    refresh: () => { void read(); },
  };
}
