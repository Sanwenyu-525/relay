import { useCallback, useEffect, useRef, useState } from "react";
import { RelayApiError, type RelayApiClient, type RelayConversationDiff, type RelayConversationDiffScope } from "../api/relayClient";

interface ConversationDiffState {
  readonly diff: RelayConversationDiff | null;
  readonly loading: boolean;
  readonly error: string | null;
  /** 刷新失败但仍保留上次可信值：界面标「更新失败 · 截至…」（§34.4 / CD-17）。 */
  readonly stale: boolean;
  /** 上一次可信读取的本地时刻；只在有可信值时有意义。 */
  readonly readAt: string | null;
  /**
   * 每次成功统计读取后递增。服务端 DTO 没有当前侧快照代次字段，已展开正文以它为
   * 当前侧身份（§34.2）：统计刷新成功后正文重新核对，不把旧正文配新统计（禅道 #117）。
   */
  readonly successSeq: number;
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
 * 刷新失败分两类（禅道 #118）：401/403/404 是明确拒读——旧统计与正文不再可信，
 * 撤下并报拒读状态；503、传输失败等临时故障才按 CD-17 保留上次可信值标 stale。
 */
export function useConversationDiff(client: RelayApiClient, sessionId: string | null,
  enabled: boolean, pollMs = 4000, scope: RelayConversationDiffScope = "SESSION"): ConversationDiffState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [successSeq, setSuccessSeq] = useState(0);
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
      setSuccessSeq((value) => value + 1);
    } catch (caught) {
      if (current !== version.current) return;
      if (caught instanceof RelayApiError && [401, 403, 404].includes(caught.problem.status)) {
        // 明确拒读（凭据失效 / 无权 / 对象不存在）：不能当成临时网络失败继续展示旧目录。
        setSnapshot(null);
        setError(`会话文件变化统计被拒绝读取（HTTP ${caught.problem.status} ${caught.problem.code}）：${caught.problem.detail}`);
        return;
      }
      // 临时故障保留同一会话的可信值；换会话的可信值已在 enabled/sessionId 变化时收掉。
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
    successSeq,
    refresh: () => { void read(); },
  };
}
