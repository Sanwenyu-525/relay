import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
 * 「以上是已落账的工具轮次…」）。没有轮次就什么都不摆——摘要行与在途三点已经足够，
 * 解释段读起来像免责声明。2026-10-25 用户再次指认「展开没内容」：终态读取确认是空轮次后，
 * 连摘要行一起收起，不留点开是空的壳；终态首次展开前仍保留入口（否则无法触发那一次读取）。
 * 删除只动呈现，不改变上面四条口径。
 *
 * 2026-10-25 回复生命周期综合优化（P1）：
 *   * 摘要行先说人话：把工具名折成「读取文件 / 列目录 / 搜索内容 …」，只保留次数；
 *     工具名、路径、轮次与逐项状态全在展开内容里，技术细节不再挤在折叠行上。
 *   * 状态语言统一为三种：在途（正在做某件事 / N 步）、被拒 N 项未执行、未知 N 项待核对。
 *     不再单独写「进行中」——消息行首的三点已经承担「还在跑」这个信号，
 *     两处同时说同一件事只是多一个装饰性指示。
 *   * 原生 `<details>` 的程序化 open 也会触发 toggle：此前那次回声被当成人工开合，
 *     写进 touched 之后「完成时自动收起」就永远失效。现在 DOM 状态与我们记的 state 一致时
 *     直接忽略——只有真的差一位才算用户动手。
 *   * 已完成不等于任务完成：这里只用中性摘要与状态词，不给绿色成功样式。
 */

const POLL_MS = 2_000;
/** PENDING 也算在途：它是「已提交、Worker 尚未领取」，轮次会在领取后开始出现。 */
const ACTIVE_STATUSES: readonly RelayAssistMessage["status"][] = ["PENDING", "RUNNING"];

const TARGET_KEYS = ["relative_path", "path", "pattern", "query", "check_id", "operation_id"] as const;

/**
 * 工具名 → 用户能读懂的活动词。取不到就原样显示工具名：宁可露出一个英文名，
 * 也不为了顺口编一个不存在的动作。这是展示层映射，不新增任何业务含义。
 */
const TOOL_ACTIVITY: Readonly<Record<string, string>> = {
  read_file: "读取文件",
  list_directory: "列目录",
  find_paths: "查找文件",
  search_text: "搜索内容",
  git_status: "查看 Git 状态",
  git_diff: "查看改动",
  git_log: "查看提交记录",
  run_check: "运行检查",
  apply_changeset: "修改文件",
  read_change_set: "读取变更集",
  computer_screenshot: "截屏",
  computer_get_windows: "枚举窗口",
  github_repo_view: "查询仓库",
  github_pr_list: "列出 PR",
  github_pr_view: "查看 PR",
  github_issue_list: "列出 Issue",
  github_issue_view: "查看 Issue",
  browser_list_pages: "列出页面",
  browser_read_page: "读取网页",
  browser_screenshot: "网页截图",
  browser_wait_for: "等待页面",
};

function activityOf(call: RelaySessionToolCall): string {
  const known = TOOL_ACTIVITY[call.toolName];
  if (known !== undefined) return known;
  if (call.toolName.startsWith("computer_")) return "桌面操作";
  if (call.toolName.startsWith("browser_")) return "浏览器操作";
  if (call.toolName.startsWith("github_")) return "查询 GitHub";
  return call.toolName;
}

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

function allCalls(trace: RelaySessionToolCalls): readonly RelaySessionToolCall[] {
  return trace.rounds.flatMap((round) => round.calls);
}

function stepCount(trace: RelaySessionToolCalls): number {
  return trace.rounds.reduce((total, round) => total + round.calls.length, 0);
}

/** 折叠行的人话摘要：按出现顺序列出做过的事，同名动作合并成次数；超过三类只报类数。 */
function activitySummary(calls: readonly RelaySessionToolCall[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const call of calls) {
    const key = activityOf(call);
    if (!counts.has(key)) order.push(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = order.slice(0, 3).map((key) => `${key} ${counts.get(key)} 次`);
  if (order.length > 3) parts.push(`等 ${order.length} 类`);
  return parts.join("、");
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
  const [loaded, setLoaded] = useState(false);
  const touched = useRef(false);
  const wasActive = useRef(active);
  const request = useRef(0);
  /** 我们最后一次告诉 DOM 的开合状态；原生 toggle 与它一致时就是程序化回声。 */
  const openState = useRef(active);

  const read = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    try {
      const next = await client.getAssistSessionToolCalls(message.sessionId, message.id);
      if (current !== request.current) return;
      // 读回空轮次不覆盖已经看到的步骤：那可能是服务端并发清理或读取落在两次写入之间，
      // 而「真实发生过的步骤」不能因为后一次返回空就从这个界面上消失。
      setTrace((previous) => previous !== null && stepCount(previous) > 0 && stepCount(next) === 0
        ? previous : next);
      setError(null);
      setLoaded(true);
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

  useLayoutEffect(() => { openState.current = open; }, [open]);

  if (message.role !== "ASSISTANT") return null;
  const calls = trace === null ? [] : allCalls(trace);
  const steps = trace === null ? null : stepCount(trace);
  // 读取确认「这一轮没有工具轮次」之后不再留折叠行——点开是空的壳比不显示更差。
  // 但只在真的确认过才收（loaded），且读过一次有步骤时上面已保证不会被空读数覆盖。
  if (steps === 0 && loaded && !active && !loading && error === null) return null;

  const pending = calls.filter((call) => call.status === "UNKNOWN" || call.status === "ABANDONED").length;
  const rejected = calls.filter((call) => call.status === "REJECTED").length;
  const running = calls.filter((call) => call.status === "REQUESTED").at(-1) ?? null;
  const activity = steps === null || steps === 0 ? ""
    : active ? (running !== null ? `正在${activityOf(running)}` : "") : activitySummary(calls);
  const countText = steps !== null && steps > 0 ? `${steps} 步` : "";
  const detail = [activity, countText].filter((part) => part !== "").join(" · ");

  return <details className="tech-details session-round-trace" open={open}
    data-testid={`session-round-trace-${message.id}`}
    data-state={active ? "active" : "settled"}
    onToggle={(event) => {
      const domOpen = event.currentTarget.open;
      // 原生 details 的 open 由 React 改也会派发 toggle；DOM 与我们记的一致时就是自己那次回声，
      // 不能把它算成人工开合（否则「完成时自动收起」会永久失效）。
      if (domOpen === openState.current) return;
      touched.current = true;
      openState.current = domOpen;
      setOpen(domOpen);
      // 终态只在首次展开时读一次；读取失败后仍由「重新读取」显式重试，不自动反复回源。
      if (domOpen && !loaded && !loading && !active) void read();
    }}>
    <summary data-testid="session-round-trace-toggle" aria-expanded={open}>
      <span className="session-round-trace-label">这一轮做了什么</span>
      {detail !== "" && <> · <span className="session-round-trace-activity"
        data-testid="session-round-trace-activity">{detail}</span></>}
      {pending > 0 && <> · <span className="session-round-trace-pending">{pending} 项待核对</span></>}
      {rejected > 0 && <> · <span className="session-round-trace-rejected">{rejected} 项未执行</span></>}
    </summary>
    {loading && !loaded && <p className="helper-text" role="status"
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
