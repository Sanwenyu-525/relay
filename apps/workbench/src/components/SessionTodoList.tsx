import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CheckCircle2, ChevronRight, CircleDashed, ListChecks, Loader2, XCircle }
  from "lucide-react";
import type { RelaySessionTodoItem, RelaySessionTodoSnapshot } from "../api/resources/sessionTodos";
import type { RelayApiClient } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./SessionTodoList.css";
import { Button } from "../ui";

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
  /** 轮询间隔；生产 2.5 秒，用例据此压到几毫秒，不必等真实时间（同 SessionRoundTrace）。 */
  readonly pollIntervalMs?: number;
}

/** 生产轮询间隔：待办只在生成期间变，比工具轨迹更慢一档。 */
const POLL_MS = 2_500;
/** 读失败后的退避：慢一档，但不放弃，恢复后仍要跟上真实版本。 */
const RETRY_POLL_MS = 5_000;

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

function SessionTodoListContent({ client, sessionId, active = false, refreshKey = "",
  pollIntervalMs = POLL_MS }: Props) {
  const [snapshot, setSnapshot] = useState<RelaySessionTodoSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const latest = useRef<RelaySessionTodoSnapshot | null>(null);
  /**
   * 请求身份：**整个组件生命周期**单调递增，不随 Effect 重建归零。
   *
   * 这两枚 ref 的生命周期必须一致（2026-10-31 P0 修复）。此前 `issued` 是 Effect 内的
   * 局部变量，`applied` 却是组件级 ref：Effect 因 active / refreshKey / retry 重建后
   * `issued` 从 1 重新数，而 `applied` 还停在上一轮的较大值，于是重建后的每一次响应
   * 都满足不了 `seq >= applied`，被自己先前发出的序号永久挡掉——生成结束那一刻的
   * 最后一次读取因此永远落不了地，界面停在停止前的那一版。
   *
   * 现在两枚 ref 同生共死：会话切换由外层 `key` 重挂组件，两者一起归零；
   * 组件内的任何重读都只递增，迟到响应按序号先后决定谁赢。
   */
  const requestSeq = useRef(0);
  const applied = useRef(0);

  useEffect(() => {
    if (sessionId === null) return undefined;
    const sessionKey = sessionId;
    let alive = true;
    let timer: number | undefined;
    async function read() {
      const seq = ++requestSeq.current;
      setLoading(true);
      try {
        const next = await client.getAssistSessionTodos!(sessionKey);
        // 卸载或换会话后迟到的响应一律丢弃：那不是这一份视图的事实。
        if (alive && seq > applied.current) {
          applied.current = seq;
          if (next === null) {
            // 合法的空快照：这一轮没有清单，必须清掉上一轮的投影与版本缓存——
            // 否则用户切到新任务后还会看到旧清单。
            latest.current = null;
            setSnapshot(null);
          } else if (shouldAccept(latest.current, next)) {
            latest.current = next;
            setSnapshot(next);
          }
          setError(null);
        }
        if (alive && active) timer = window.setTimeout(() => void read(), pollIntervalMs);
      } catch (caught) {
        if (!alive) return;
        // 读失败不清空已有清单：说清「这份可能是旧的」，比退回「没有待办」诚实。
        if (seq > applied.current) setError(describeLiveError(caught).message);
        if (active) timer = window.setTimeout(() => void read(), RETRY_POLL_MS);
      } finally {
        if (alive) setLoading(false);
      }
    }
    void read();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [client, sessionId, active, refreshKey, retry, pollIntervalMs]);

  if (snapshot === null && error === null) return null;

  const items = snapshot?.items ?? [];
  const completed = items.filter((item) => item.status === "completed").length;
  /** 还没跑完的项：`已取消` 是用户明确放弃的那一项，不算「等着继续」。 */
  const remaining = items.filter((item) => item.status === "pending" ||
    item.status === "in_progress").length;
  const running = items.find((item) => item.status === "in_progress") ?? null;
  const current = running ?? items.find((item) => item.status === "pending") ?? null;
  // 完成度条：把「已完成 2/5」这句话变成可扫的长度。它只描述进度，不是验收结论——
  // 底部说明已经把这一点写清楚，所以这里不加数字、不加图例，只留一条 2px 的线。
  const ratio = items.length === 0 ? 0 : Math.round((completed / items.length) * 100);
  const progressStyle = { "--session-todos-ratio": `${ratio}%` } as CSSProperties;

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
          本轮停止，这一步未收尾
        </span>}
      {error !== null &&
        <span className="session-todos-error-label" data-testid="session-todo-error-label">
          读取失败
        </span>}
    </summary>
    {/* 完成度条紧贴标题行下沿：它是摘要的可视化，不是列表的一部分，也不参与滚动。 */}
    {snapshot !== null && items.length > 0 &&
      <span className="session-todos-progress" aria-hidden="true" style={progressStyle} />}
    <div className="session-todos-body" aria-busy={loading}>
      {error !== null && <div className="session-todos-error" role="alert">
        <p>待办读取失败：{error}{snapshot !== null ? " 当前显示上次读取的版本。" : ""}</p>
        <Button variant="text" disabled={loading}
          data-testid="session-todo-retry" onClick={() => setRetry((value) => value + 1)}>
          {loading ? "正在重试" : "重试读取"}
        </Button>
      </div>}
      {snapshot !== null && <ul className="session-todos-list">
        {items.map((item) => <li key={item.id} className="session-todos-item"
          data-testid="session-todo-item" data-status={item.status}>
          <StatusIcon status={item.status} active={active} />
          <span className={`session-todos-text session-todos-text-${item.status}`}>{item.content}</span>
          <span className="session-todos-status">{statusText(item.status, active)}</span>
        </li>)}
      </ul>}
      {snapshot !== null && <p className="session-todos-note" data-testid="session-todo-version-note">
        第 {snapshot.version} 版 · 服务端快照。只记录进度，不代表执行结果或验收结论。
      </p>}
      {/* 停下来不等于这件事结束了（2026-11-01 E2E-ALL-01）。真实用例里模型把预算烧完、
          清单停在「已完成 0/10」，界面只说了「这一步未收尾」——用户读到的是一条死路，
          而实际上接着发一句就会延续同一张清单、已完成的步骤不重做。合法的继续路径
          必须和「没做完」这件事同屏出现，否则提示本身就成了第二个问题。
          它排在「怎么换新任务」之前：先说怎么把这件事做完，再说怎么另起一件。 */}
      {!active && remaining > 0 && <p className="session-todos-note session-todos-hint"
        data-testid="session-todo-resume-hint">
        本轮没有把这 {remaining} 项跑完。接着做只需再发一条消息：清单会延续到那一轮，
        已完成的步骤不会重做。
      </p>}
      {/* 换任务的方式必须写在用户看得见的地方：归属不再由「清单是否完成」推断，
          没有声明就延续当前工作（含收尾后回来纠错），所以「怎么声明」要能查到。
          它是一条操作提示，不是免责说明，因此与上一行分属两个层级：提示里的写法
          用行内代码呈现，扫一眼就知道要照抄什么。 */}
      {snapshot !== null && <p className="session-todos-note session-todos-hint"
        data-testid="session-todo-new-task-hint">
        换新任务时，在消息开头写 <code>新任务：</code> 或 <code>/newtask</code>；清单会另起一份。
      </p>}
    </div>
  </details>;
}