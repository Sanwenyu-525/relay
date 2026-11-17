import { useEffect, useId, useRef, useState } from "react";
import type { RelaySessionContextUsage } from "../api/dtos/assist";
import { buildContextUsageViewModel, type ContextUsageViewModel } from "../lib/contextUsageModel";
import { Button } from "../ui";
import "./ContextUsagePanel.css";

/**
 * 上下文用量浮层（0145 / 0162 / 0165；2026-11-15 CONTEXT-USAGE-MINIMAL）。
 *
 * 这一轮把它从「诊断 / 容量面板」收缩成轻量状态监控：
 *   · 核心只答「用了多少 / 生效阈值多少 / 还剩多少」；
 *   · 自动压缩只保留一行开启状态；阈值被模型容量收敛时补一行原因；
 *   · 构成、容量、最近调用、成功记录、时间戳与手动压缩按钮都不再占默认正文。
 *
 * 口径边界：当前 Token 仍取服务端投影（真实基线 + 估算增量，或整份估算）；
 * 分母仍是实际生效压缩阈值，不是模型窗口。数据与压缩状态机没有变化，
 * 手动压缩继续走 `/compact` 命令入口（本组件不再发压缩请求）。
 *
 * 面板几何（宽度 / 最大高度 / 圆角 / 阴影 / 定位）由 AssistView.css 的
 * `.agent-chat-context-meter-menu` 定义；这里没有滚动容器，内容自然决定高度。
 */

export default function ContextUsagePanel({ usage, loading, error, onReload }: {
  /** 服务端投影；null = 还没读到（loading 或失败）。 */
  readonly usage: RelaySessionContextUsage | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onReload: () => void;
}) {
  /*
   * 压缩在后台 Worker 里跑：受理之后只能靠重读投影观察状态。
   * 只在「确有在途压缩」时轮询，最多 60 次（约两分钟）；终态一到就停。
   * 手动压缩入口已移到 `/compact`，这里只负责让当前浮层跟上状态。
   */
  const [pollTicks, setPollTicks] = useState(0);
  const reloadRef = useRef(onReload);
  useEffect(() => { reloadRef.current = onReload; }, [onReload]);
  const compactionActive = usage?.compaction.active ?? null;
  useEffect(() => {
    if (compactionActive === null || pollTicks >= 60) return;
    const timer = window.setTimeout(() => {
      setPollTicks((value) => value + 1);
      reloadRef.current();
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [compactionActive, pollTicks]);
  useEffect(() => { if (compactionActive === null) setPollTicks(0); }, [compactionActive]);

  const name = useId();
  const vm = buildContextUsageViewModel(usage);

  return <div className="context-usage" data-testid="context-usage-panel">
    {error !== null && <div className="context-usage-error" role="alert"
      data-testid="context-usage-error">
      <p>上下文用量读取失败：{error}</p>
      <Button variant="text" className="context-usage-reload" disabled={loading}
        onClick={onReload}>重新读取</Button>
    </div>}

    {usage === null && loading && error === null && <p className="context-usage-note"
      role="status" data-testid="context-usage-loading">正在读取上下文用量…</p>}

    {usage === null && !loading && error === null && <p className="context-usage-note"
      data-testid="context-usage-empty">暂无可用的上下文用量读数。</p>}

    {vm !== null && <>
      <CurrentUsageSection vm={vm} />
      <CompactionSection name={name} vm={vm} />
    </>}
  </div>;
}

/**
 * 核心区：当前上下文 / 实际生效阈值。进度条分母是生效阈值——
 * 它才是「距离自动压缩」的那个分母；模型窗口占用留在输入区的圆环上。
 */
function CurrentUsageSection({ vm }: { readonly vm: ContextUsageViewModel }) {
  const { current } = vm;
  const enabled = vm.compaction.enabled;
  const over = current.remaining < 0;
  const distance = over
    ? (enabled
      ? `已超过自动压缩阈值 ${Math.abs(current.remaining).toLocaleString()} tokens，下一次请求前会先整理。`
      : `已超过压缩阈值 ${Math.abs(current.remaining).toLocaleString()} tokens。`)
    : (enabled
      ? `距离自动压缩还剩 ${current.remaining.toLocaleString()} tokens。`
      : `距压缩阈值还剩 ${current.remaining.toLocaleString()} tokens。`);
  return <section className="context-usage-current" aria-label="当前上下文用量"
    data-testid="context-usage-current">
    <div className="context-usage-figure-row">
      <p className="context-usage-figure">
        <span data-testid="context-usage-current-tokens">{current.tokens.toLocaleString()}</span>
        <span className="context-usage-figure-sep"> / </span>
        <span data-testid="context-usage-current-threshold">{current.threshold.toLocaleString()}</span>
        <span className="context-usage-figure-unit"> tokens</span>
      </p>
      <span className="context-usage-percent" data-testid="context-usage-current-percent"
        data-over={over ? "true" : undefined}>{current.percentLabel}%</span>
    </div>
    <span className="context-usage-bar" aria-hidden="true" data-over={over ? "true" : undefined}
      data-testid="context-usage-current-bar">
      <span style={{ width: `${Math.min(1, current.ratio) * 100}%` }} />
    </span>
    <p className="context-usage-distance" data-testid="context-usage-current-remaining"
      data-over={over ? "true" : undefined}>{distance}</p>
  </section>;
}

/**
 * 自动压缩：只保留「已开启 / 已关闭」一行；用户设置与实际生效不同时，
 * 在下面补一行容量收敛原因；压缩失败只留错误码，成功记录和减少量不再出现。
 * 正在压缩 / 已达标等状态由浮层标题行的状态词承担，这里不重复。
 */
function CompactionSection({ name, vm }: {
  readonly name: string; readonly vm: ContextUsageViewModel;
}) {
  const compaction = vm.compaction;
  const lastResult = compaction.lastResult;
  const failed = lastResult?.status === "FAILED";
  const unknownWindow = compaction.modelWindow === null
    || compaction.windowSource === "UNKNOWN_FALLBACK";
  const showClamp = compaction.clamped && compaction.requested !== compaction.effective;
  return <section className="context-usage-compaction" aria-labelledby={`${name}-compaction`}
    data-testid="context-compaction">
    <div className="context-usage-heading-row">
      <h2 className="context-usage-section-title" id={`${name}-compaction`}>自动压缩</h2>
      <span className="context-usage-tag" data-state={compaction.enabled ? "on" : "off"}
        data-testid="context-compaction-state">
        {compaction.enabled ? "已开启" : "已关闭"}
      </span>
    </div>
    {showClamp && <p className="context-usage-note" data-testid="context-compaction-clamped">
      {`${compaction.usingDefault ? "当前阈值" : "用户设置"} ${compaction.requested.toLocaleString()}；${unknownWindow ? "模型窗口未知" : "容量受限"}，按 ${compaction.effective.toLocaleString()} 生效。`}
    </p>}
    {!showClamp && unknownWindow && <p className="context-usage-note"
      data-testid="context-compaction-window-unknown">
      模型窗口未知，阈值按安全回退计算。
    </p>}
    {failed && <p className="context-usage-note context-usage-note--danger" role="alert"
      data-testid="context-compaction-failed">
      上次压缩失败{lastResult.errorCode === null ? "。" : ` · ${lastResult.errorCode}`}
    </p>}
  </section>;
}
