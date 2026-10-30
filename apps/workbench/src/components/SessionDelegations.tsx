import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { RelayApiClient, RelaySessionDelegation } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./SessionDelegations.css";

type DelegationClient = Pick<RelayApiClient, "workspaceId" | "getAssistSessionDelegations">;
interface Props {
  readonly client: DelegationClient;
  readonly sessionId: string;
  readonly parentRunning?: boolean;
  readonly refreshKey?: string;
  readonly onOpenSession?: (sessionId: string) => void;
}

const statusLabels: Record<RelaySessionDelegation["status"], string> = {
  QUEUED: "排队中", RUNNING: "进行中", SUCCEEDED: "已返回", FAILED: "失败", CANCELLED: "已取消"
};

/** 会话内临时委派的只读投影，不创建 Agent，也不从主会话的输出猜测协作结果。 */
export default function SessionDelegations(props: Props) {
  if (typeof props.client.getAssistSessionDelegations !== "function") return null;
  // 会话变化即换读取 Owner：旧行不会在下一条会话的首帧短暂出现。
  return <SessionDelegationsContent key={`${props.client.workspaceId}:${props.sessionId}`} {...props} />;
}

function SessionDelegationsContent({ client, sessionId, parentRunning = false,
  refreshKey = "", onOpenSession }: Props) {
  const [items, setItems] = useState<readonly RelaySessionDelegation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    async function read() {
      setLoading(true);
      try {
        const next = await client.getAssistSessionDelegations!(sessionId);
        if (!alive) return;
        setItems(next); setError(null);
        if (parentRunning || next.some((item) => item.status === "QUEUED" || item.status === "RUNNING")) {
          // 在上次响应结算后再排下一次，慢接口不会堆叠请求。
          timer = window.setTimeout(() => void read(), 2500);
        }
      } catch (caught) {
        if (alive) setError(describeLiveError(caught).message);
      } finally { if (alive) setLoading(false); }
    }
    void read();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [client, sessionId, parentRunning, refreshKey, retry]);

  // 没有委派时不留空面板；读失败不能当作「没有委派」。
  if (items.length === 0 && error === null) return null;
  const activeCount = items.filter((item) => item.status === "QUEUED" || item.status === "RUNNING").length;
  const failedCount = items.filter((item) => item.status === "FAILED").length;
  return <details className="session-delegations" data-testid="session-delegations">
    <summary className="session-delegations-header">
      <ChevronRight className="session-delegations-chevron" aria-hidden="true" />
      <span className="session-delegations-title">会话协作</span>
      {items.length > 0 && <span>{items.length} 项{activeCount > 0 ? ` · ${activeCount} 项进行中` : ""}
        {failedCount > 0 ? ` · ${failedCount} 项失败` : ""}</span>}
      {error !== null && <span className="session-delegations-error-label">读取失败</span>}
    </summary>
    <div className="session-delegations-content" aria-busy={loading}>
      {error !== null && <div className="session-delegations-error" role="alert">
        <p>协作状态读取失败：{error}{items.length > 0 ? " 当前显示上次读取的记录。" : ""}</p>
        <button className="text-button" type="button" disabled={loading}
          data-testid="session-delegations-retry" onClick={() => setRetry((value) => value + 1)}>
          {loading ? "正在重试…" : "重试读取"}</button>
      </div>}
      <ul className="session-delegations-list">
        {items.map((item) => <li key={item.delegationId} className="session-delegations-item"
          data-testid="session-delegation" data-status={item.status}>
          <div className="session-delegations-item-heading">
            <span className="session-delegations-role">{item.role === "INVESTIGATE" ? "调查" : "审查"}</span>
            <span className="session-delegations-status">{statusLabels[item.status]}</span>
            <span>{item.required ? "必需" : "补充"}</span>
            <span className="session-delegations-attempt">尝试 {item.attemptCount} / {item.maxAttempts}</span>
          </div>
          <p className="session-delegations-objective">{item.objective}</p>
          <dl className="session-delegations-facts">
            {item.scope.length > 0 && <><dt>范围</dt><dd>{item.scope.join("、")}</dd></>}
            {item.baseline !== null && <><dt>基线</dt><dd><code>{item.baseline}</code></dd></>}
          </dl>
          {item.resultSummary !== null && <p className="session-delegations-result"
            data-testid="session-delegation-result">{item.resultSummary}</p>}
          {item.resultSummary === null && item.status === "FAILED" &&
            <p className="session-delegations-result">未返回结果，请查看子任务记录。</p>}
          {onOpenSession !== undefined && item.childSessionId !== null && <button className="text-button" type="button"
            data-testid="session-delegation-open" onClick={() => onOpenSession(item.childSessionId!)}>
            查看子任务记录</button>}
        </li>)}
      </ul>
    </div>
  </details>;
}
