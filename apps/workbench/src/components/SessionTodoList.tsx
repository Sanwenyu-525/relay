import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronRight, CircleDashed, ListChecks, Loader2, XCircle }
  from "lucide-react";
import type { RelaySessionTodoItem, RelaySessionTodoSnapshot } from "../api/resources/sessionTodos";
import type { RelayApiClient } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./SessionTodoList.css";

/**
 * 会话待办清单（ADR-038，2026-10-30）。
 *
 * 位置固定在消息区与输入器之间：用户读到哪一步、Agent 打算做什么，在这里是同一条线。
 *
 * 六条设计约束：
 *   * **默认折叠**：收起时只有一行——已完成数量 + 当前步骤。展开才看全部项目；
 *   * **布局稳定**：摘要行固定几何，清单更新时高度只由「展开/收起」决定；
 *   * **不抢焦点**：轮询刷新只改文本，不重挂节点、不自动展开、不滚动到当前项；
 *   * **只读**：进度只有模型写入口一条来源，界面不提供本地勾选；
 *   * **有界**：展开后内部滚动并限高，短窗口里输入器仍然可用；
 *   * **按事实动**：只有这一轮真的在生成时 `in_progress` 才转圈；会话停止或失败后
 *     旧清单仍可能写着 `in_progress`，那只说明最后一步没走完，不代表还在跑。
 *
 * 失败与未知按事实呈现：读不到就说读不到，并给重试；不把「读失败」渲染成「没有待办」。
 * 迟到的旧版本不覆盖新版本，也不让 A 轮次的清单回闪到 B 轮次。
 */

type TodoClient = Pick<RelayApiClient, "workspaceId" | "getAssistSessionTodos">;

interface Props {
  readonly client: TodoClient;
  readonly sessionId: string | null;
  /** 这一轮生成是否仍在跑：只在跑的时候轮询，也只在跑的时候把进行中渲染成动态。 */
  readonly active?: boolean;
  /** 外部事实变化（例如消息列表追加）时要求重读一次。 */
  readonly refreshKey?: string;
}

const STATUS_LABEL: Record<RelaySessionTodoItem["status"], string> = {
  pending: "待办", in_progress: "进行中", completed: "已完成", cancelled: "已取消",
};

function statusText(status: RelaySessionTodoItem["status"], active: boolean): string {
  // 生成已结束但最后一步仍标着 in_progress：说明这一步没跑完，而不是还在跑。
  if (status === "in_progress" && !active) return "进行中·已停止";
  return STATUS_LABEL[status];
}

function StatusIcon({ status, active }: { readonly status: RelaySessionTodoItem["status"];
  readonly active: boolean }) {
  if (status === "completed") return <CheckCircle2 className="session-todos-icon" aria-hidden="true" />;
  if (status === "cancelled") return <XCircle className="session-todos-icon" aria-hidden="true" />;
  if (status === "in_progress") {
    return active
      ? <Loader2 className="session-todos-icon session-todos-icon-active" aria-hidden="true" />
      : <CircleDashed className="session-todos-icon session-todos-icon-stalled" aria-hidden="true" />;
  }
  return <CircleDashed className="session-todos-icon" aria-hidden="true" />;
}

/** 迟到响应不得回退视图：同轮次按版本前进，换轮次（版本从 1 重计）则接受。 */
export function shouldAccept(previous: RelaySessionTodoSnapshot | null,
  next: RelaySessionTodoSnapshot): boolean {
  if (previous === null) return true;
  if (next.scopeKey !== previous.scopeKey) return true;
  return next.version >= previous.version;
}

export default function SessionTodoList(props: Props) {
  if (typeof props.client.getAssistSessionTodos !== "function") return null;
  if (props.sessionId === null) return null;
  // 会话变化即换读取 Owner：上一条会话的清单不会在新会话的首帧短暂出现。
  return <SessionTodoListContent key={`${props.client.workspaceId}:${props.sessionId}`} {...props} />;
}

function SessionTodoListContent({ client, sessionId, active = false, refreshKey = "" }: Props) {
  const [snapshot, setSnapshot] = useState<RelaySessionTodoSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const latest = useRef<RelaySessionTodoSnapshot | null>(null);

  useEffect(() => {
    if (sessionId === null) return undefined;
    const sessionKey = sessionId;
    let alive = true;
    let timer: number | undefined;
    async function read() {
      setLoading(true);
      try {
        const next = await client.getAssistSessionTodos!(sessionKey);
        if (!alive) return;
        if (next !== null && shouldAccept(latest.current, next)) {
          latest.current = next;
          setSnapshot(next);
        }
        setError(null);
        if (active) timer = window.setTimeout(() => void read(), 2500);
      } catch (caught) {
        if (!alive) return;
        // 读失败不清空已有清单：说清「这份可能是旧的」，比退回「没有待办」诚实。
        setError(describeLiveError(caught).message);
        if (active) timer = window.setTimeout(() => void read(), 5000);
      } finally {
        if (alive) setLoading(false);
      }
    }
    void read();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [client, sessionId, active, refreshKey, retry]);

  if (snapshot === null && error === null) return null;

  const items = snapshot?.items ?? [];
  const completed = items.filter((item) => item.status === "completed").length;
  const running = items.find((item) => item.status === "in_progress") ?? null;
  const current = running ?? items.find((item) => item.status === "pending") ?? null;

  return <details className="session-todos" data-testid="session-todo-list"
    data-session-todo-version={snapshot?.version ?? 0} data-session-todo-running={active}>
    <summary className="session-todos-summary" data-testid="session-todo-summary">
      <ChevronRight className="session-todos-chevron" aria-hidden="true" />
      <ListChecks className="session-todos-heading-icon" aria-hidden="true" />
      <span className="session-todos-title">待办</span>
      {snapshot !== null &&
        <span className="session-todos-count" data-testid="session-todo-count">
          已完成 {completed}/{items.length}
        </span>}
      {current !== null &&
        <span className="session-todos-current" title={current.content}
          data-testid="session-todo-current">{current.content}</span>}
      {current !== null && current.status === "in_progress" && !active &&
        <span className="session-todos-stalled" data-testid="session-todo-stalled">
          生成已结束，这一步未收尾
        </span>}
      {error !== null &&
        <span className="session-todos-error-label" data-testid="session-todo-error-label">
          读取失败
        </span>}
    </summary>
    <div className="session-todos-body" aria-busy={loading}>
      {error !== null && <div className="session-todos-error" role="alert">
        <p>待办读取失败：{error}{snapshot !== null ? " 当前显示上次读取的版本。" : ""}</p>
        <button className="text-button" type="button" disabled={loading}
          data-testid="session-todo-retry" onClick={() => setRetry((value) => value + 1)}>
          {loading ? "正在重试" : "重试读取"}
        </button>
      </div>}
      {snapshot !== null && <ul className="session-todos-list">
        {items.map((item) => <li key={item.id} className="session-todos-item"
          data-testid="session-todo-item" data-status={item.status}>
          <StatusIcon status={item.status} active={active} />
          <span className={`session-todos-text session-todos-text-${item.status}`}>{item.content}</span>
          <span className="session-todos-status">{statusText(item.status, active)}</span>
        </li>)}
      </ul>}
      {snapshot !== null && <p className="session-todos-note">
        第 {snapshot.version} 版 · 来自服务端快照。待办只记录进度，不代表执行结果或验收结论。
      </p>}
    </div>
  </details>;
}