import { useCallback, useEffect, useRef, useState } from "react";
import type { RelayApiClient, RelayAssistMessage, RelaySessionToolCall, RelaySessionToolCalls } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import "./SessionRoundTrace.css";

/**
 * 这一轮做了什么（docs/frontend/workbench-design.md §18.10「原消息下展示读取中、执行中…实际阶段」）。
 *
 * 2026-10-21 用户指认「ai 的思考过程看不到」：Agent 主流程每轮调了什么工具、被拒还是结算，
 * 一直只写在 `session_tool_calls` 里，界面上因此只剩一个「正在生成」和三点动画。
 * 这里只呈现已落账的轮次，四条口径：
 *   * 顺序按服务端给的 (round, ordinal)，客户端不重排、不按位置猜归属。
 *   * 未知就是未知：UNKNOWN 说「结果未知，需核对」，不从时间差或上下文推一个成功或失败出来。
 *   * 这里没有模型的私有推理（该表没有那一列），只有工具账本；它也不提供批准、重试或取消，
 *     控制仍走输入栏与 Run 控制的既有入口。
 *   * 读取分两段：在途立即读并轮询（那时它是唯一的活体过程信号），终态等首次展开再读一次
 *     （刷新后一整段历史不该为每条消息各发一次请求）。代价是刷新后的终态轮次要点开才有数字。
 *
 * 2026-10-23 用户截图指令：删掉空轮次时的解释段与列表下方脚注（「没有调用任何工具…」、
 * 「以上是已落账的工具轮次…」）。没有轮次就什么都不说——摘要行与在途三点已经足够，
 * 解释段读起来像免责声明。删除只动呈现，不改变上面四条口径。
 */

const POLL_MS = 2_000;
/** PENDING 也算在途：它是「已提交、Worker 尚未领取」，轮次会在领取后开始出现。 */
const ACTIVE_STATUSES: readonly RelayAssistMessage["status"][] = ["PENDING", "RUNNING"];

const TARGET_KEYS = ["relative_path", "path", "pattern", "query", "check_id", "operation_id"] as const;

function statusText(call: RelaySessionToolCall): string {
  switch (call.status) {
    case "REQUESTED": return "已请求，尚未结算";
    case "SETTLED": return "已结算";
    case "REJECTED": return "被拒绝，没有执行";
    case "ABANDONED": return "已放弃，没有结算结果";
    default: return "结果未知，需核对";
  }
}

/** 折叠行点名对象：只取参数里那个真正说明「读的是哪里」的键，取不到就不猜。 */
function targetText(call: RelaySessionToolCall): string {
  for (const key of TARGET_KEYS) {
    const value = call.args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

function elapsedSeconds(call: RelaySessionToolCall): number | null {
  if (call.settledAt === null) return null;
  const started = Date.parse(call.requestedAt);
  const ended = Date.parse(call.settledAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  return Math.round((ended - started) / 100) / 10;
}

function stepCount(trace: RelaySessionToolCalls): number {
  return trace.rounds.reduce((total, round) => total + round.calls.length, 0);
}

export function SessionRoundTrace({ client, message, pollIntervalMs = POLL_MS }: {
  readonly client: RelayApiClient; readonly message: RelayAssistMessage;
  /** 生产用 2 秒；用例据此把轮询压到几毫秒，不必等真实时间。 */
  readonly pollIntervalMs?: number;
}) {
  const active = ACTIVE_STATUSES.includes(message.status);
  const [trace, setTrace] = useState<RelaySessionToolCalls | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(active);
  // 在途默认展开：那正是用户要看的东西；终态默认折叠，但用户的开合选择优先。
  const [open, setOpen] = useState(active);
  const touched = useRef(false);
  const loaded = useRef(false);
  const wasActive = useRef(active);
  const request = useRef(0);

  const read = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    try {
      const next = await client.getAssistSessionToolCalls(message.sessionId, message.id);
      if (current !== request.current) return;
      setTrace(next); setError(null); loaded.current = true;
    } catch (caught) {
      if (current !== request.current) return;
      setError(describeLiveError(caught).message);
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [client, message.sessionId, message.id]);

  useEffect(() => {
    if (message.role !== "ASSISTANT") return;
    if (active) {
      wasActive.current = true;
      void read();
      const timer = window.setInterval(() => void read(), pollIntervalMs);
      return () => { request.current++; window.clearInterval(timer); };
    }
    // 从在途进入终态时补读一次：最后一轮常常在状态翻转前一瞬才结算，
    // 不补这一次，刚结束的回复会停在少一步的旧读数上。
    if (wasActive.current) { wasActive.current = false; void read(); }
  }, [active, message.role, pollIntervalMs, read]);

  useEffect(() => { if (!touched.current) setOpen(active); }, [active]);

  if (message.role !== "ASSISTANT") return null;
  const steps = trace === null ? null : stepCount(trace);

  return <details className="tech-details session-round-trace" open={open}
    data-testid={`session-round-trace-${message.id}`}
    onToggle={(event) => {
      touched.current = true;
      setOpen(event.currentTarget.open);
      // 终态只在首次展开时读一次；读取失败后仍由「重新读取」显式重试，不自动反复回源。
      if (event.currentTarget.open && !loaded.current && !loading && !active) void read();
    }}>
    <summary data-testid="session-round-trace-toggle" aria-expanded={open}>
      这一轮做了什么{steps !== null && steps > 0 ? ` · ${steps} 步` : ""}
      {active && <span className="session-round-trace-live"> · 进行中</span>}
    </summary>
    {loading && !loaded.current && <p className="helper-text" role="status"
      data-testid="session-round-trace-loading">正在读取这一轮的过程…</p>}
    {error !== null && <div className="action-error" role="alert" data-testid={`session-round-trace-error-${message.id}`}>
      <p>过程读取失败：{error}</p>
      <p className="helper-text">正文与最终回复不受这条影响；这里只说明工具轮次没读到。</p>
      <button className="secondary-button" type="button" data-testid={`session-round-trace-retry-${message.id}`}
        disabled={loading} onClick={() => void read()}>重新读取</button>
    </div>}
    {trace !== null && trace.rounds.length > 0 && <ol className="session-round-trace-rounds"
      data-testid={`session-round-trace-list-${message.id}`}>
      {trace.rounds.map((round) => <li key={round.round} data-testid={`session-round-${round.round}`}>
        <p className="session-round-trace-round-title">第 {round.round + 1} 轮</p>
        <ul className="session-round-trace-calls">
          {round.calls.map((call) => {
            const target = targetText(call);
            const elapsed = elapsedSeconds(call);
            return <li key={call.id} data-testid={`session-round-call-${call.id}`}>
              <strong className="session-round-trace-tool">{call.toolName}</strong>
              {target !== "" && <code className="hash-code">{target}</code>}
              <span className="session-round-trace-status" data-status={call.status}>{statusText(call)}</span>
              {elapsed !== null && <span className="session-round-trace-elapsed">{elapsed}s</span>}
              {/* 拒绝、放弃与未知的原因都按服务端原样回显，不改写也不补结论。 */}
              {call.rejectionReason !== null && <span className="session-round-trace-reason"
                data-testid={`session-round-call-reason-${call.id}`}>
                {call.rejectionReason}{call.rejectionDetail !== null ? ` · ${call.rejectionDetail}` : ""}</span>}
            </li>;
          })}
        </ul>
      </li>)}
    </ol>}
  </details>;
}
