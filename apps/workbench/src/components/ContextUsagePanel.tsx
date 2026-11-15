import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Database, FileText, MessagesSquare, MoreHorizontal, Settings, Wrench,
  type LucideIcon } from "lucide-react";
import { createCommandId, type RelayApiClient } from "../api/relayClient";
import type { DecimalRevision } from "../types";
import type { RelayCompactionTrigger, RelayContextUsageCategory,
  RelayContextUsageBreakdown, RelaySessionContextUsage } from "../api/dtos/assist";
import { describeLiveError } from "../lib/liveErrors";
import "./ContextUsagePanel.css";
import { Button } from "../ui";

/**
 * 上下文用量浮层（0145 / 0162 / 0165，2026-11-15）。
 *
 * 本次重构后只回答四个问题：
 *   1. 最近一次调用用了多少、相对**当前模型可用窗口**占多少；
 *   2. 现在有多少上下文、自动压缩阈值在哪、离它还有多远；
 *   3. 模型真实窗口多大、来源是什么、用户设置与实际生效是否一致；
 *   4. 手动压缩的进度与结果。
 *
 * 口径边界：
 *   · 分母是 `compaction.effective_window_tokens`（min(1M 目标, 模型窗口/安全回退,
 *     服务商硬上限)），不是模型宣传窗口，也不是已被取消的会话档位；
 *   · 模型窗口只读展示，**没有**任何编辑入口；普通用户只配置压缩阈值（在设置页）；
 *   · 窗口未知时显示安全回退值与「未知」，不显示虚假的 1M；
 *   · 分项来自服务端按请求文本的估算；没有分项就只写「暂无分项统计」，不补数；
 *   · 手动压缩只做「受理 → 轮询 → 终态」，不在按钮上宣称已经压完。
 */

/** 分类的显示顺序与名字。图标只做区分，不承担语义——名字才是事实。 */
const CATEGORY_META: Readonly<Record<RelayContextUsageCategory,
  { readonly label: string; readonly icon: LucideIcon }>> = {
  HISTORY: { label: "历史消息", icon: MessagesSquare },
  SYSTEM: { label: "系统 / 指令", icon: Settings },
  TOOLS: { label: "工具调用", icon: Wrench },
  FILE_READS: { label: "文件读取", icon: FileText },
  MEMORY: { label: "记忆 / 资料", icon: Database },
  OTHER: { label: "其他上下文", icon: MoreHorizontal },
};

const CATEGORY_ORDER: readonly RelayContextUsageCategory[] = ["HISTORY", "SYSTEM", "TOOLS",
  "FILE_READS", "MEMORY", "OTHER"];

// CONTEXT-COMPACTION-0162：压缩为什么发生 / 最近一次的终态。
const TRIGGER_LABELS: Readonly<Record<RelayCompactionTrigger, string>> = {
  MANUAL: "手动压缩",
  THRESHOLD: "达到阈值",
  OVERFLOW: "溢出保护",
};
const RESULT_LABELS: Readonly<Record<"COMPLETED" | "FAILED" | "CANCELLED", string>> = {
  COMPLETED: "已完成",
  FAILED: "失败（原文与已有摘要保留）",
  CANCELLED: "已取消",
};

/**
 * 窗口来源的界面说法。
 *
 * 「自动识别」只给模型目录/能力声明；部署配置是运维显式声明；未知一律说未知，
 * 不因为回退值是 256K 就写成「自动识别为 256K」。
 */
const WINDOW_SOURCE_LABELS: Readonly<Record<
  RelaySessionContextUsage["compaction"]["windowSource"], string>> = {
  MODEL_CATALOG: "自动识别 · 模型目录",
  CAPABILITY_DECLARATION: "高级能力声明",
  MODEL_CONFIG: "部署配置",
  UNKNOWN_FALLBACK: "未知 · 安全回退",
};

export default function ContextUsagePanel({ client, sessionId, sessionRevision, usage, loading,
  error, onReload }: {
  readonly client: RelayApiClient | null;
  /** 当前会话；null = 还没有会话，手动压缩不可用。 */
  readonly sessionId: string | null;
  /** 会话修订，手动压缩按它做 CAS 基线。 */
  readonly sessionRevision: DecimalRevision | null;
  /** 服务端投影；null = 还没读到（loading 或失败）。 */
  readonly usage: RelaySessionContextUsage | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onReload: () => void;
}) {
  /** 手动压缩的在途/回执/错误态，按会话登记，切会话不串台。 */
  const [compactBusy, setCompactBusy] = useState(false);
  const [compactNotice, setCompactNotice] = useState<
    { readonly sessionId: string; readonly value: string } | null>(null);
  const [compactError, setCompactError] = useState<
    { readonly sessionId: string; readonly value: string } | null>(null);
  const [pollTicks, setPollTicks] = useState(0);
  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => { disposed.current = true; };
  }, []);

  const lastCall = usage?.lastCall ?? null;
  const compaction = usage?.compaction ?? null;
  const compactionActive = compaction?.active ?? null;
  const compactNoticeFor = compactNotice !== null && compactNotice.sessionId === sessionId
    ? compactNotice.value : null;
  const compactErrorFor = compactError !== null && compactError.sessionId === sessionId
    ? compactError.value : null;

  /*
   * 压缩在后台 Worker 里跑：受理之后只能靠重读投影观察状态。
   * 只在「确有在途压缩」时轮询，最多 60 次（约两分钟）；终态一到就停，
   * 不因为浮层开着就无限读接口。
   */
  useEffect(() => {
    if (compactionActive === null || pollTicks >= 60) return;
    const timer = window.setTimeout(() => {
      setPollTicks((value) => value + 1);
      onReload();
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [compactionActive, pollTicks, onReload]);
  useEffect(() => { if (compactionActive === null) setPollTicks(0); }, [compactionActive]);
  useEffect(() => { setPollTicks(0); }, [sessionId]);

  /**
   * 手动压缩：与 `/compact` 走同一个 Owner（`RequestMemoryCompaction`）。
   * 202 只表示受理；这里不宣称已经压完，状态由 `compaction.active` / `last_result` 读回。
   */
  const compactNow = useCallback(async (): Promise<void> => {
    if (client === null || sessionId === null || sessionRevision === null || compactBusy) return;
    const origin = sessionId;
    setCompactBusy(true); setCompactError(null); setCompactNotice(null);
    try {
      const accepted = await client.requestSessionMemoryCompaction({ sessionId: origin,
        commandId: createCommandId(), expectedRevision: sessionRevision });
      if (disposed.current) return;
      setCompactNotice({ sessionId: origin,
        value: `已受理压缩请求（${accepted.status}）；完成状态会自动刷新。` });
      setPollTicks(0);
      onReload();
    } catch (caught) {
      if (disposed.current) return;
      setCompactError({ sessionId: origin, value: describeLiveError(caught).message });
    } finally { if (!disposed.current) setCompactBusy(false); }
  }, [client, compactBusy, onReload, sessionId, sessionRevision]);

  const name = useId();
  const inputTokens = lastCall?.inputTokens ?? null;
  // 分母只取「实际可用窗口」：旧会话档位已经不参与预算，也不再出现在投影里。
  const windowTokens = compaction?.effectiveWindowTokens ?? null;
  const reserved = lastCall?.reservedTokens ?? null;
  const ratio = inputTokens !== null && windowTokens !== null && windowTokens > 0
    ? inputTokens / windowTokens : null;
  const remaining = inputTokens !== null && windowTokens !== null
    ? windowTokens - inputTokens : null;
  const percent = ratio === null ? null : formatRatioPercent(ratio);
  const breakdown = lastCall?.breakdown ?? null;
  const hitRate = cacheHitRate(inputTokens, lastCall?.cacheReadTokens ?? null);

  return <div className="context-usage" data-testid="context-usage-panel">
    <div className="context-usage-scroll">
      {error !== null && <div className="action-error" role="alert" data-testid="context-usage-error">
        <p>上下文用量读取失败：{error}</p>
        <Button variant="secondary" disabled={loading}
          onClick={onReload}>重新读取</Button>
      </div>}

      {/* 还没有会话时没有投影可读，但手动压缩仍然应当以禁用态说明为什么不可用，
          而不是让整个浮层只剩一个空容器。 */}
      {usage === null && sessionId === null && error === null && !loading &&
        <section className="context-usage-section" aria-labelledby={`${name}-no-session`}
          data-testid="context-usage-no-session">
          <h2 className="context-usage-section-title" id={`${name}-no-session`}>还没有会话</h2>
          <p className="context-usage-note">选中或新建会话后，这里显示上下文用量。</p>
          <div className="context-usage-actions">
            <Button variant="secondary" disabled data-testid="context-compaction-now">立即压缩</Button>
          </div>
        </section>}

      {usage !== null && <>
        {/* 第一段：这一次调用实际用了多少、相对当前模型可用窗口占了多少。 */}
        <section className="context-usage-section" aria-labelledby={`${name}-history`}
          data-testid="context-usage-history">
          <div className="context-usage-heading-row">
            <h2 className="context-usage-section-title" id={`${name}-history`}>最近一次模型调用</h2>
            <span className="context-usage-tag"
              title="用量来自上一次调用；占比按当前模型的可用窗口计算。">历史记录</span>
          </div>
          {lastCall === null || inputTokens === null
            ? <p className="agent-chat-context-meter-empty" data-testid="assist-context-meter-empty">
              {lastCall === null
                ? "尚无模型调用。收到回复后这里显示该次调用的上下文用量。"
                : "这次调用没有上报输入用量，无法给出占比。"}</p>
            : <>
              <div className="agent-chat-context-meter-main">
                <p className="agent-chat-context-meter-figure">
                  <span className="agent-chat-context-meter-amount">
                    <span data-testid="assist-context-meter-input">{inputTokens.toLocaleString()}</span>
                    {windowTokens !== null && <><span className="agent-chat-context-meter-sep"> / </span>
                      <span data-testid="assist-context-meter-window">{windowTokens.toLocaleString()}</span></>}
                    <span className="agent-chat-context-meter-unit"> tokens</span>
                  </span>
                  {percent !== null && <span className="agent-chat-context-meter-percent"
                    data-testid="assist-context-meter-percent" data-over={ratio !== null && ratio > 1
                      ? "true" : undefined}>{percent}%</span>}
                </p>
                {ratio !== null && <span className="agent-chat-context-meter-bar" aria-hidden="true"
                  data-over={ratio > 1 ? "true" : undefined}>
                  <span style={{ width: `${Math.min(1, ratio) * 100}%` }} /></span>}
                {/* 那次调用冻结的预算与当前可用窗口不同时明说一句：占比按当前窗口计算，
                    冻结值只作为历史依据保留。 */}
                {reserved !== null && windowTokens !== null && reserved !== windowTokens &&
                  <p className="context-usage-note" data-testid="context-usage-frozen-note">
                    这次调用当时冻结 {reserved.toLocaleString()} tokens；占比按当前模型可用窗口
                    {" "}{windowTokens.toLocaleString()} tokens 计算。
                  </p>}
                {(remaining !== null || lastCall.outputTokens !== null)
                  && <div className="agent-chat-context-meter-secondary"
                    data-single={remaining === null || lastCall.outputTokens === null ? "true" : undefined}>
                    {remaining !== null && <div className="agent-chat-context-meter-stat">
                      <span className="agent-chat-context-meter-stat-label">
                        {remaining < 0 ? "超出可用窗口（估算）" : "窗口余量（估算）"}</span>
                      <span className="agent-chat-context-meter-stat-value"
                        data-over={remaining < 0 ? "true" : undefined}
                        data-testid="assist-context-meter-remaining">
                        {Math.abs(remaining).toLocaleString()}
                        <span className="agent-chat-context-meter-stat-unit"> tokens</span>
                      </span>
                    </div>}
                    {lastCall.outputTokens !== null && <div className="agent-chat-context-meter-stat">
                      <span className="agent-chat-context-meter-stat-label">本次输出</span>
                      <span className="agent-chat-context-meter-stat-value"
                        data-testid="assist-context-meter-output">
                      {lastCall.outputTokens.toLocaleString()}
                      <span className="agent-chat-context-meter-stat-unit"> tokens</span>
                      </span>
                    </div>}
                  </div>}
                {/* 缓存读数属于输入量的缓存维度：单独一行，不参与构成加总，也没上报就整项不出现。 */}
                {(lastCall.cacheReadTokens !== null || lastCall.cacheCreationTokens !== null
                  || hitRate !== null) && <dl className="agent-chat-context-meter-cache">
                  {lastCall.cacheReadTokens !== null && <div className="agent-chat-context-meter-cache-row">
                    <dt>缓存读取</dt>
                    <dd data-testid="assist-context-meter-cache-read">{lastCall.cacheReadTokens.toLocaleString()}
                      <span className="agent-chat-context-meter-cache-unit"> tokens</span></dd>
                  </div>}
                  {lastCall.cacheCreationTokens !== null && <div className="agent-chat-context-meter-cache-row">
                    <dt>缓存写入</dt>
                    <dd data-testid="assist-context-meter-cache-write">
                      {lastCall.cacheCreationTokens.toLocaleString()}
                      <span className="agent-chat-context-meter-cache-unit"> tokens</span></dd>
                  </div>}
                  {hitRate !== null && <div className="agent-chat-context-meter-cache-row">
                    <dt>缓存命中率</dt>
                    <dd data-testid="assist-context-meter-cache-hit">{hitRate}%</dd>
                  </div>}
                </dl>}
              </div>
            </>}
        </section>

        {/* CONTEXT-COMPACTION-0162 / 0165：自动压缩。读序与用户的问题一致：现在有多少 →
            模型装得下多少 → 用户设的阈值 → 实际生效阈值 → 离它还有多远 → 上一次结果。 */}
        {compaction !== null && <section className="context-usage-section"
          aria-labelledby={`${name}-compaction`} data-testid="context-compaction">
          <div className="context-usage-heading-row">
            <h3 className="context-usage-section-title" id={`${name}-compaction`}>自动压缩</h3>
            <span className="context-usage-tag" data-state={compaction.enabled ? "on" : "off"}
              data-testid="context-compaction-state">
              {compaction.enabled ? "已开启" : "已关闭"}
            </span>
          </div>
          <div className="context-compaction-headline">
            <p className="context-compaction-figure">
              <span data-testid="context-compaction-current">
                {compaction.contextTokens.toLocaleString()}</span>
              <span className="context-compaction-sep"> / </span>
              <span data-testid="context-compaction-threshold">
                {compaction.effectiveThresholdTokens.toLocaleString()}</span>
              <span className="agent-chat-context-meter-unit"> tokens</span>
            </p>
            <span className="context-usage-estimate" data-testid="context-compaction-source">
              {compaction.contextSource === "PROVIDER_USAGE" ? "真实基线 + 估算增量" : "估算"}
            </span>
          </div>
          {/* 进度按「实际可用窗口」画，阈值在轨道上单独标一枚刻度：两条线不是同一个数。 */}
          <span className="context-compaction-track" aria-hidden="true">
            <span className="context-compaction-fill"
              data-over={compaction.distanceTokens <= 0 ? "true" : undefined}
              style={{ width: `${Math.min(1, compaction.contextTokens
                / Math.max(1, compaction.effectiveWindowTokens)) * 100}%` }} />
            <span className="context-compaction-marker" style={{ left: `${Math.min(1,
              compaction.effectiveThresholdTokens
                / Math.max(1, compaction.effectiveWindowTokens)) * 100}%` }} />
          </span>
          <p className="context-usage-note" data-testid="context-compaction-distance">
            {compaction.distanceTokens > 0
              ? `距离自动压缩还有 ${compaction.distanceTokens.toLocaleString()} tokens。`
              : `已超过自动压缩阈值 ${Math.abs(compaction.distanceTokens).toLocaleString()} tokens；`
                + "下一次请求前会先整理。"}
          </p>
          <ul className="context-usage-list">
            <li className="context-usage-row" data-testid="context-compaction-window-row">
              <span className="context-usage-row-label">模型上下文窗口</span>
              <span className="context-usage-row-value">
                {compaction.modelWindowTokens === null
                  ? `未知（按安全回退 ${compaction.effectiveWindowTokens.toLocaleString()} tokens）`
                  : <>
                    {compaction.modelWindowTokens.toLocaleString()}
                    <span className="context-usage-row-unit"> tokens</span>
                  </>}
                <span className="context-usage-row-aside" data-testid="context-compaction-window-source">
                  {WINDOW_SOURCE_LABELS[compaction.windowSource]} · 不可在此修改
                </span>
              </span>
            </li>
            {compaction.providerCallCapTokens !== null &&
              compaction.providerCallCapTokens !== compaction.modelWindowTokens &&
              <li className="context-usage-row" data-testid="context-compaction-call-cap-row">
                <span className="context-usage-row-label">服务商单次上限</span>
                <span className="context-usage-row-value">
                  {compaction.providerCallCapTokens.toLocaleString()}
                  <span className="context-usage-row-unit"> tokens</span>
                  <span className="context-usage-row-aside">实际可用窗口按它收敛</span>
                </span>
              </li>}
            <li className="context-usage-row" data-testid="context-compaction-configured-row">
              <span className="context-usage-row-label">用户设置阈值</span>
              <span className="context-usage-row-value">
                {compaction.requestedThresholdTokens.toLocaleString()}
                <span className="context-usage-row-unit"> tokens</span>
                {compaction.thresholdTokens === null &&
                  <span className="context-usage-row-aside">默认值</span>}
              </span>
            </li>
            <li className="context-usage-row" data-testid="context-compaction-threshold-row">
              <span className="context-usage-row-label">实际生效阈值</span>
              <span className="context-usage-row-value">{compaction.effectiveThresholdTokens.toLocaleString()}
                <span className="context-usage-row-unit"> tokens</span></span>
            </li>
            <li className="context-usage-row" data-testid="context-compaction-post-target-row">
              <span className="context-usage-row-label">压缩后目标</span>
              <span className="context-usage-row-value">
                约 {compaction.postCompactionTargetTokens.toLocaleString()}
                <span className="context-usage-row-unit"> tokens</span></span>
            </li>
          </ul>
          {/* 保存值与生效值不一致时必须说清原因：不静默使用无效配置，也不改写用户保存值。 */}
          {compaction.thresholdClamped && <p className="context-usage-note"
            data-testid="context-compaction-clamped">
            用户设置 {compaction.requestedThresholdTokens.toLocaleString()} tokens / 实际生效
            {" "}{compaction.effectiveThresholdTokens.toLocaleString()} tokens / 原因：当前模型上下文容量不足，
            系统已自动应用安全限制（为输出、工具与安全余量预留
            {" "}{compaction.outputReserveTokens.toLocaleString()} /{" "}
            {compaction.protocolOverheadTokens.toLocaleString()} /{" "}
            {compaction.safetyReserveTokens.toLocaleString()} tokens）。
          </p>}
          {compaction.thresholdTokens === null && !compaction.thresholdClamped &&
            <p className="context-usage-note" data-testid="context-compaction-default-note">
              阈值使用默认值 {compaction.defaultThresholdTokens.toLocaleString()} tokens；
              推荐区间 {compaction.recommended.min.toLocaleString()}–
              {compaction.recommended.max.toLocaleString()} tokens（仅提示，不是硬性限制）。
            </p>}
          {!compaction.enabled && <p className="context-usage-note"
            data-testid="context-compaction-disabled-note">
            普通自动压缩已关闭；请求装不下时仍会执行溢出保护压缩，不会直接把超预算请求发出去。
          </p>}
          {compactionActive !== null && <p className="context-compaction-active" role="status"
            data-testid="context-compaction-active" data-status={compactionActive.status}>
            {compactionActive.status === "RUNNING" ? "正在压缩上下文…" : "压缩请求已排队…"}
            （{TRIGGER_LABELS[compactionActive.trigger]}）
          </p>}
          {compaction.lastResult !== null && <p className="context-usage-note"
            data-testid="context-compaction-last-result" data-status={compaction.lastResult.status}>
            最近一次压缩：{RESULT_LABELS[compaction.lastResult.status]}
            {" · "}{TRIGGER_LABELS[compaction.lastResult.trigger]}
            {compaction.lastResult.tokensBefore !== null &&
              ` · 压缩前 ${compaction.lastResult.tokensBefore.toLocaleString()} tokens`}
            {compaction.lastResult.tokensAfter !== null &&
              ` → 压缩后 ${compaction.lastResult.tokensAfter.toLocaleString()} tokens`}
            {compaction.lastResult.tokensBefore !== null && compaction.lastResult.tokensAfter !== null &&
              `（减少 ${Math.max(0, compaction.lastResult.tokensBefore
                - compaction.lastResult.tokensAfter).toLocaleString()}）`}
            {compaction.lastResult.errorCode !== null &&
              ` · ${compaction.lastResult.errorCode}`}
            {" · "}{new Date(compaction.lastResult.at).toLocaleString()}
          </p>}
          {/* 压缩成功不等于预算够了：压完仍高于安全输入上限时，下一轮要么继续整理剩余
              原文，要么在无法安全容纳时明确中止。这里说明它，而不是让读者以为已经解决。 */}
          {compaction.lastResult?.budgetUnmet === true && <p className="context-usage-note"
            data-testid="context-compaction-budget-unmet">
            压缩后仍有 {compaction.lastResult.tokensAfter?.toLocaleString()} tokens，
            高于安全输入上限 {(compaction.lastResult.safeInputTokens
              ?? compaction.safeInputTokens).toLocaleString()} tokens
            （按这次压缩判定时的窗口）；下一轮会继续整理剩余历史，
            无法安全容纳时会明确中止并说明。
          </p>}
          <div className="context-usage-actions">
            <Button variant="secondary" data-testid="context-compaction-now"
              disabled={client === null || sessionId === null || sessionRevision === null
                || compactBusy || compactionActive !== null}
              onClick={() => void compactNow()}>
              {compactBusy ? "正在提交…" : "立即压缩上下文"}</Button>
          </div>
          {compactNoticeFor !== null && <p className="context-usage-note" role="status"
            data-testid="context-compaction-notice">{compactNoticeFor}</p>}
          {compactErrorFor !== null && <p className="action-error" role="alert"
            data-testid="context-compaction-error">{compactErrorFor}</p>}
        </section>}

        <section className="context-usage-section" aria-labelledby={`${name}-breakdown`}>
          <h3 className="context-usage-section-title" id={`${name}-breakdown`}>
            上下文构成
            {breakdown !== null && <span className="context-usage-estimate"
              data-testid="context-usage-estimate">估算</span>}
          </h3>
          {breakdown === null
            ? <p className="context-usage-note" data-testid="context-usage-breakdown-empty">
              当前记录没有分项统计</p>
            : <ul className="context-usage-list" data-testid="context-usage-breakdown">
              {sortedCategories(breakdown).map((entry) => {
                const meta = CATEGORY_META[entry.key];
                const Icon = meta.icon;
                return <li key={entry.key} className="context-usage-row"
                  data-category={entry.key}
                  data-testid={`context-usage-row-${entry.key}`}>
                  <Icon aria-hidden="true" className="context-usage-row-icon" size={14} />
                  <span className="context-usage-row-label">{meta.label}</span>
                  <span className="context-usage-row-value">{entry.tokens.toLocaleString()}
                    <span className="context-usage-row-unit"> tokens</span></span>
                </li>;
              })}
            </ul>}
          {/* 分项合计与 Provider 实报不是同一个口径（2026-11-10 用户指认差异）：
              估算按请求文本 UTF-8 字节 ÷ 3，英文占比高时会比 Provider 的分词结果偏大。
              两个数不同时把两边的口径写在同一条 caption 里，避免读者把差额当成丢项。 */}
          {breakdown !== null && inputTokens !== null &&
            breakdown.estimatedTotalTokens !== inputTokens &&
            <p className="context-usage-note" data-testid="context-usage-estimate-note">
              分项合计约 {breakdown.estimatedTotalTokens.toLocaleString()} tokens（按请求文本字节估算）；
              Provider 本次实报输入 {inputTokens.toLocaleString()} tokens。
            </p>}
          {breakdown !== null && breakdown.imageParts > 0 &&
            <p className="context-usage-note" data-testid="context-usage-image-note">
              另有 {breakdown.imageParts} 段图片未计入估算：图片 token 由模型侧编码决定。</p>}
        </section>
      </>}
      {usage === null && loading && <p className="context-usage-note" role="status"
        data-testid="context-usage-loading">正在读取上下文用量…</p>}
    </div>
  </div>;
}

/**
 * 分项按固定顺序排，不按大小排：两次打开时同一项在同一个位置，读数才可比。
 * 零值项不显示——「0 tokens」会被读成「占了一点」。
 */
function sortedCategories(breakdown: RelayContextUsageBreakdown) {
  const byKey = new Map(breakdown.categories.map((entry) => [entry.key, entry]));
  return CATEGORY_ORDER.flatMap((key) => {
    const entry = byKey.get(key);
    return entry === undefined || entry.tokens <= 0 ? [] : [entry];
  });
}

/** 命中率只在两个读数都可靠、且读取量不超过输入量时才有分母。 */
function cacheHitRate(input: number | null, cacheRead: number | null): string | null {
  if (input === null || cacheRead === null || input <= 0 || cacheRead > input) return null;
  return formatUsagePercent(cacheRead / input);
}

/**
 * 比例读数：未满但会进位成 100% 时保留小数，够了就是 100%，超出后给出真实比例
 * （`100.0` 也保留，免得把刚超出的读数说回 100%）。与圆环共用同一套读法。
 */
export function formatRatioPercent(ratio: number): string {
  const rounded = Math.round(ratio * 100);
  if (ratio < 1) {
    if (rounded < 100) return String(rounded);
    const tenths = Math.floor(ratio * 1000) / 10;
    return tenths >= 100 ? "99.9" : tenths.toFixed(1);
  }
  if (ratio === 1) return "100";
  const tenths = Math.round(ratio * 1000) / 10;
  if (tenths === 100) return "100.0";
  return Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
}

function formatUsagePercent(ratio: number): string {
  if (ratio >= 1) return "100";
  const whole = Math.round(ratio * 100);
  if (whole < 100) return String(whole);
  return (Math.floor(ratio * 1000) / 10).toFixed(1);
}
