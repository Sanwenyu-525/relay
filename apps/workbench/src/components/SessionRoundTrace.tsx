import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight, CircleCheck, CircleX, Hourglass, Info, LoaderCircle, TriangleAlert,
} from "lucide-react";
import type { RelayApiClient, RelayAssistMessage, RelaySessionToolCalls } from "../api/relayClient";
import {
  activityHeaderState, activitySpanMs, formatSpan, sessionActivityRounds, summarizeActivity,
  type ActivityItem, type ActivityPhaseTone,
} from "../lib/activityPresentation";
import {
  ACTIVITY_DENSITY_LABEL, detailOpenByDefault, mustShowActivity, useActivityDensity,
  type ActivityDensity,
} from "../lib/activityDensity";
import { describeLiveError } from "../lib/liveErrors";
import ActivityDetail from "./ActivityDetail";
import ActivityRow from "./ActivityRow";
import "./SessionRoundTrace.css";

/**
 * 执行过程（docs/frontend/workbench-design.md §18.10；2026-10-29 V3 重构）。
 *
 * 这一块只呈现**已落账的工具事实**：模型请求了什么、被准入拒绝还是结算、结果是否未知。
 * 它不是模型的私有推理——`session_tool_calls` 没有那一列，因此这里也不会凭工具名、
 * 耗时或最终正文编出一段「思考过程」。
 *
 * 四条口径（V2 起未变，V3 继续成立）：
 *   * 顺序信任服务端的 `(round, ordinal)`；轮次分组信任外层 `rounds`，客户端不重排。
 *   * `REQUESTED` 不是已执行，`UNKNOWN` 不是失败也不是成功，`REJECTED` 与执行失败分开。
 *   * 不提供批准/重试/取消：控制仍走输入栏与 Run 控制的既有入口。
 *   * 读取分两段：在途立即读并轮询；终态等首次展开再读一次，避免整段历史各发一次请求。
 *
 * 2026-10-29 V3 的三处实质改动：
 *
 * 1. **入口永不消失（P0 缺陷修复）**。V2 在「终态 + 读回零条记录」时直接 `return null`，
 *    于是用户点开一个本来存在的入口、读完之后它整块消失，看起来像点了没反应。
 *    现在入口对每条 AI 消息恒在：读到零条就显示「本轮没有调用工具」的空状态，
 *    读取失败显示错误与重读，身份不符显示拒绝原因——点击一定有确定的反馈。
 *    这条由 `tests/sessionRoundTrace.spec.tsx` 的永久回归用例钉住。
 *
 * 2. **标题行按效果图重做**：`[箭头] [状态图标] 执行过程 [规模 · 状态] [耗时]`。
 *    文案由 `activityHeaderState()` 从可验证的聚合状态派生——不知道总数就不报 `2/5`，
 *    没有剩余时间就不报「预计还需」，未读取就不预判有没有工具（只说「展开查看」）。
 *
 * 3. **长轮次收敛**：单轮超过阈值时先显示前若干项 + 全部例外项，其余折叠为
 *    「展开其余 N 项」。例外（待核对、未执行、失败）在任何档位、任何折叠下都可见。
 */

const POLL_MS = 2_000;
/** PENDING 也算在途：它是「已提交、Worker 尚未领取」，轮次会在领取后开始出现。 */
const ACTIVE_STATUSES: readonly RelayAssistMessage["status"][] = ["PENDING", "RUNNING"];
const DENSITIES: readonly ActivityDensity[] = ["concise", "standard", "detailed"];
/** 单轮超过这个项数才收敛；常见短轮次不受影响。 */
const COLLAPSE_THRESHOLD = 10;
/** 收敛时保留的普通项数（例外项不受此限制，永远显示）。 */
const COLLAPSED_HEAD = 6;

function noteOf(item: ActivityItem): string {
  const { rejectionReason, rejectionDetail } = item.detail;
  if (rejectionReason === null) return "";
  return rejectionDetail === null ? rejectionReason : `${rejectionReason} · ${rejectionDetail}`;
}

/** 标题行状态图标：与行内同一套形状语言，尺寸更大一档。 */
function HeaderIcon({ tone, live }: { readonly tone: ActivityPhaseTone; readonly live: boolean }) {
  // settled 与 success 用的是同一枚对勾，但 settled 的语义只是「这一轮结清了」；
  // 颜色在 CSS 里降到次级色，绿色留给将来真有验证证据的结果。
  if (tone === "settled" || tone === "success") return <CircleCheck aria-hidden="true" />;
  if (tone === "danger") return <CircleX aria-hidden="true" />;
  if (tone === "attention") return <TriangleAlert aria-hidden="true" />;
  if (tone === "running") {
    // 只有列表里没有「当前行」时标题图标才转：整块区域只保留一个主进度动效。
    return live ? <LoaderCircle className="activity-header-spin" aria-hidden="true" />
      : <Hourglass aria-hidden="true" />;
  }
  return <Info aria-hidden="true" />;
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
  const { density, setDensity } = useActivityDensity();
  /** 第三层详情的逐行开合；用户手动开合永远优先于密度默认值。 */
  const [rowOpen, setRowOpen] = useState<ReadonlySet<string>>(() => new Set());
  const rowTouched = useRef(false);
  /** 长轮次里被用户点开的轮次；键是服务端给的外层轮次序号。 */
  const [expandedRounds, setExpandedRounds] = useState<ReadonlySet<number>>(() => new Set());

  const rounds = useMemo(() => (trace === null ? [] : sessionActivityRounds(trace)), [trace]);
  const items = useMemo(() => rounds.flat(), [rounds]);

  const read = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    try {
      const next = await client.getAssistSessionToolCalls(message.sessionId, message.id);
      if (current !== request.current) return;
      // 读回空轮次不覆盖已经看到的步骤：那可能是服务端并发清理或读取落在两次写入之间，
      // 而「真实发生过的步骤」不能因为后一次返回空就从这个界面上消失。
      setTrace((previous) => previous !== null && stepCountOf(previous) > 0 && stepCountOf(next) === 0
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

  // 密度切到「详细」时把第三层默认展开；用户手动动过之后就只尊重用户。
  // 用值比较而不是无条件 setState：轮询每两秒会给一份新数组，无条件写状态会变成持续重渲染。
  useEffect(() => {
    if (rowTouched.current) return;
    setRowOpen((previous) => {
      if (!detailOpenByDefault(density)) return previous.size === 0 ? previous : new Set();
      if (previous.size === items.length && items.every((item) => previous.has(item.id))) return previous;
      return new Set(items.map((item) => item.id));
    });
  }, [density, items]);

  if (message.role !== "ASSISTANT") return null;

  const summary = summarizeActivity(items);
  const current = [...items].reverse().find((item) => item.tone === "active") ?? null;
  const header = activityHeaderState({ loaded, error: error !== null, inFlight: active,
    awaitingWorker: message.status === "PENDING", summary });
  // 耗时只在整轮都结算之后才报：半个区间会被读成「已经跑完了」。
  const span = active || !loaded ? "" : formatSpan(activitySpanMs(items));
  // 标题图标转动的条件：确实在跑、且列表里没有哪一行正在转（一行都不转时才轮到它）。
  const headerLive = active && current === null;

  return <details className="activity-panel" open={open}
    data-testid={`session-round-trace-${message.id}`}
    data-state={active ? "active" : "settled"}
    data-phase={header.phase}
    data-tone={header.tone}
    data-density={density}
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
    <summary className="activity-header" data-testid="session-round-trace-toggle" aria-expanded={open}>
      <span className="activity-header-chevron" aria-hidden="true"><ChevronRight /></span>
      <span className="activity-header-icon" data-tone={header.tone} aria-hidden="true">
        <HeaderIcon tone={header.tone} live={headerLive} />
      </span>
      <span className="activity-header-title">{header.title}</span>
      <span className="activity-header-meta" data-testid="session-round-trace-activity">
        {header.meta}
      </span>
      {span !== "" && <span className="activity-header-elapsed" data-testid="session-round-trace-span">
        {span}</span>}
    </summary>

    {error !== null && <div className="activity-panel-notice" data-tone="danger" role="alert"
      data-testid={`session-round-trace-error-${message.id}`}>
      <p className="activity-panel-notice-title"><CircleX aria-hidden="true" />过程读取失败</p>
      <p>{error}</p>
      <p className="helper-text">正文与最终回复不受这条影响；这里只说明工具轮次没读到。</p>
      <button className="secondary-button" type="button" data-testid={`session-round-trace-retry-${message.id}`}
        disabled={loading} onClick={() => void read()}>重新读取</button>
    </div>}

    {loading && !loaded && error === null && <p className="helper-text activity-panel-loading" role="status"
      data-testid="session-round-trace-loading">正在读取这一轮的过程…</p>}

    {/* 空状态（V3 新增）：入口已经点开了，就必须给一个确定的答案。
        这一轮确实没有工具调用——不制造空的技术时间线，也不补虚假的思考步骤。
        **只在 EMPTY 相位显示**：在途且零记录是 RUNNING_NO_TOOLS，此刻说「没有调用工具」
        就是替模型提前下结论（它随时可能开始调用）。 */}
    {header.phase === "EMPTY" &&
      <div className="activity-panel-notice" data-tone="neutral"
        data-testid={`session-round-trace-empty-${message.id}`}>
        <p className="activity-panel-notice-title"><Info aria-hidden="true" />本轮没有调用工具</p>
        <p>本次回复仅基于已有信息与上下文生成，没有读取文件、执行命令或修改内容。</p>
      </div>}

    {items.length > 0 && <>
      {/* 阅读密度只改视图：三个档位共享同一份事实，任何档位都不隐藏审批、被拒与未知。 */}
      <div className="activity-panel-toolbar">
        <span className="helper-text">阅读密度</span>
        <div className="activity-panel-density" role="group" aria-label="活动阅读密度">
          {DENSITIES.map((value) => <button key={value} type="button" className="activity-panel-density-option"
            data-testid={`session-round-trace-density-${value}`}
            aria-pressed={density === value}
            onClick={() => setDensity(value)}>{ACTIVITY_DENSITY_LABEL[value]}</button>)}
        </div>
      </div>
      <ol className="activity-panel-rounds" data-testid={`session-round-trace-list-${message.id}`}>
        {trace?.rounds.map((round, index) => {
          const roundItems = rounds[index] ?? [];
          // 简洁档只留风险项；风险项由 mustShowActivity 统一判定，这里不自己再写一份。
          const scoped = density === "concise"
            ? roundItems.filter((item) => mustShowActivity(item.tone, item.detail.failed))
            : roundItems;
          if (scoped.length === 0) return null;
          // 长轮次收敛：保留前若干项 + 全部例外项，其余折叠。顺序始终是原始顺序。
          const collapsible = density !== "detailed" && scoped.length > COLLAPSE_THRESHOLD
            && !expandedRounds.has(round.round);
          const shown = collapsible
            ? scoped.filter((item, position) => position < COLLAPSED_HEAD
              || mustShowActivity(item.tone, item.detail.failed))
            : scoped;
          const hidden = scoped.length - shown.length;
          // 组标题只报真实数量与真实状态，不给阶段编名字（后端没有阶段字段）。
          const roundSummary = summarizeActivity(scoped);
          return <li key={round.round} className="activity-panel-round" data-testid={`session-round-${round.round}`}>
            <p className="activity-panel-round-title">
              <span>第 {round.round + 1} 轮</span>
              <span className="activity-panel-round-count">{roundSummary.total} 项</span>
              {roundSummary.failed > 0 && <span className="activity-panel-round-flag" data-tone="danger">
                {roundSummary.failed} 项失败</span>}
              {roundSummary.rejected > 0 && <span className="activity-panel-round-flag" data-tone="danger">
                {roundSummary.rejected} 项未执行</span>}
              {roundSummary.unknown > 0 && <span className="activity-panel-round-flag" data-tone="attention">
                {roundSummary.unknown} 项待核对</span>}
            </p>
            <ul className="activity-panel-list">
              {shown.map((item) => {
                const note = noteOf(item);
                return <ActivityRow key={item.id} item={item}
                  current={active && current?.id === item.id}
                  testId={`session-round-call-${item.id}`}
                  note={note === "" ? undefined : <span
                    data-testid={`session-round-call-reason-${item.id}`}>{note}</span>}
                  expanded={rowOpen.has(item.id)}
                  detail={<ActivityDetail item={item} />}
                  onToggle={() => {
                    rowTouched.current = true;
                    setRowOpen((previous) => {
                      const next = new Set(previous);
                      if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                      return next;
                    });
                  }} />;
              })}
            </ul>
            {hidden > 0 && <button className="activity-panel-more" type="button"
              data-testid={`session-round-more-${round.round}`}
              onClick={() => setExpandedRounds((previous) => {
                const next = new Set(previous); next.add(round.round); return next;
              })}>展开其余 {hidden} 项</button>}
            {!collapsible && expandedRounds.has(round.round) && <button className="activity-panel-more"
              type="button" data-testid={`session-round-less-${round.round}`}
              onClick={() => setExpandedRounds((previous) => {
                const next = new Set(previous); next.delete(round.round); return next;
              })}>收起这一轮</button>}
          </li>;
        })}
      </ol>
    </>}
  </details>;
}

function stepCountOf(trace: RelaySessionToolCalls): number {
  return trace.rounds.reduce((total, round) => total + round.calls.length, 0);
}
