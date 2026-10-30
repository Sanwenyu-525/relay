import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Database, FileText, MessagesSquare, MoreHorizontal, Settings, Wrench,
  type LucideIcon } from "lucide-react";
import { createCommandId, RelayTransportError, type RelayApiClient } from "../api/relayClient";
import type { DecimalRevision } from "../types";
import type { RelayContextBudgetTokens, RelayContextUsageCategory,
  RelayContextUsageBreakdown, RelaySessionContextUsage } from "../api/dtos/assist";
import { describeLiveError } from "../lib/liveErrors";
import "./ContextUsagePanel.css";

/**
 * 上下文用量浮层（0145 / 2026-10-30 用户指令）。
 *
 * 三段结构，从上到下就是用户要回答的三个问题：
 *   1. 这次调用了多少、还剩多少 —— 用量摘要（沿用 `.agent-chat-context-meter-*` 那套已确认的
 *      白色轻量排版：主读数一行 + 细进度线 + 两列二级信息）；
 *   2. 这些 token 是哪来的 —— 上下文构成（只显示真的采到的分项）；
 *   3. 以后按哪一档 —— 会话上下文档位（三个横向选项，**选中即是改变**）。
 *
 * 四条不可让步的口径：
 *   · 占比的分母是**那次调用冻结的预算**（`reservedTokens`），不是当前档位；历史调用没有
 *     可靠冻结预算时只写「预算未知」，不拿当前档位冒充、也不显示未经证实的百分比；
 *   · 分项来自服务端按请求文本的估算，界面必须标「估算」；没有分项就只写「暂无分项统计」，
 *     不补数、不把总量平均分摊到几个分类里；
 *   · 没有「跟随应用默认」这一档：每个会话从建立那一刻起就有确定档位；
 *   · **选择与保存分开**（2026-10-30 复审恢复原定交互）：点档位只改本地已选值，
 *     按「保存档位」才写服务端（带该会话自己的档位修订 CAS）。生效与否只由服务端回执
 *     决定：保存中与待核对的档位一律标「尚未生效」，不宣称已切换。409 重读最新值并
 *     说明；传输失败保留原 command_id 待核对（不换新 ID）。
 *
 * 没有会话时（首条消息之前）也能选：档位先存在**当前新会话草稿作用域**，随建会话命令
 * 一起写进创建事务，因此第一个模型调用就按用户选的档位冻结预算，不存在「先按 256K
 * 发起、再补写」。
 */

const TIERS: readonly { readonly value: RelayContextBudgetTokens; readonly label: string }[] = [
  { value: 262_144, label: "256K" },
  { value: 524_288, label: "512K" },
  { value: 1_048_576, label: "1024K" },
];

/** 档位的界面说法：只由值决定，不随选中态变化。 */
function formatTierLabel(tokens: RelayContextBudgetTokens | null): string {
  const tier = TIERS.find((item) => item.value === tokens);
  return tier === undefined ? "未确认" : tier.label;
}

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

type Pending = { readonly commandId: string; readonly expectedRevision: DecimalRevision;
  readonly budget: RelayContextBudgetTokens; readonly reason: string };

export default function ContextUsagePanel({ client, sessionId, usage, loading, error, onReload,
  onSaved, draftTier, onDraftTierChange, inheritedTier = null, inheritState = "none",
  onRetryInherit }: {
  readonly client: RelayApiClient | null;
  /** 当前会话；null = 还没有会话（首条输入器），此时档位先落在新会话草稿作用域。 */
  readonly sessionId: string | null;
  /** 服务端投影；null = 还没读到（loading 或失败）。 */
  readonly usage: RelaySessionContextUsage | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onReload: () => void;
  readonly onSaved: () => void;
  /** 没有会话时的草稿档位与它的写入口（建会话时随命令落库）。 */
  readonly draftTier?: RelayContextBudgetTokens | null;
  readonly onDraftTierChange?: (tier: RelayContextBudgetTokens) => void;
  /**
   * 空白新会话将要继承到的档位（P0-A，2026-10-30 复审）。这是**来源会话那一行事实**，
   * 不是缺省值：只有 ready 才给出档位，loading / failed 只给待确认状态，
   * 不把 256K 冒充成「继承结果」。
   */
  readonly inheritedTier?: RelayContextBudgetTokens | null;
  readonly inheritState?: "none" | "loading" | "ready" | "failed";
  readonly onRetryInherit?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  /**
   * 已选、还没保存的那一档（P0-C，2026-10-30 复审恢复「选择后点击保存」）。
   *
   * 选择只改这里，不写服务端；写服务端必须由「保存档位」触发。这样单选组里出现的新值
   * 永远不会被读成「已经生效」——生效值只来自服务端已保存的那一档。
   */
  const [draftSelection, setDraftSelection] = useState<RelayContextBudgetTokens | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /*
   * 刚写成功、但父组件还没把新投影读回来的那一小段时间。
   *
   * 没有它就会出现「回闪」：点 512K → 写成功 → 乐观值清掉 → 投影还没刷新（仍是 256K）
   * → 选择器跳回 256K → 投影刷新后才又变回 512K。用户看到的是一次毫无来由的跳动，
   * 在慢网络下还会停留好几秒。
   *
   * 它只表示「服务端已经确认，但界面还没追上」；一旦投影读到的档位与修订和它一致，
   * 就清掉，让界面完全交给服务端事实。
   */
  const [committed, setCommitted] = useState<{ readonly tokens: RelayContextBudgetTokens;
    readonly revision: DecimalRevision } | null>(null);
  const name = useId();
  const disposed = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    disposed.current = false;
    return () => { disposed.current = true; };
  }, []);
  useEffect(() => {
    setDraftSelection(null); setConflict(null); setPending(null); setActionError(null);
    setNotice(null); setCommitted(null);
  }, [sessionId]);
  useEffect(() => {
    if (committed === null || usage === null) return;
    if (usage.budget.tokens === committed.tokens && usage.budget.revision === committed.revision) {
      setCommitted(null);
    }
  }, [committed, usage]);

  /**
   * 内容变了就把浮层滚回顶部。
   *
   * 浮层是**底边锚定**、高度受限的容器：回执、冲突提示或新的分项出现时它会向上长，
   * 浏览器会保住原来的视觉位置，结果把标题与主读数顶出可视区——看起来像是「用量不见了」。
   * 这里在内容变化时显式回到顶部，三段结构永远从「上下文用量」开始读。
   */
  useEffect(() => {
    const menu = rootRef.current?.closest(".agent-chat-context-meter-menu");
    if (menu instanceof HTMLElement) menu.scrollTop = 0;
  }, [usage, notice, conflict, pending, actionError]);

  /*
   * 两个值必须分开说，界面才不会撒谎：
   *   savedTier —— 服务端已保存的档位，也就是「现在生效」的唯一来源；
   *                committed 只覆盖「回执已确认、投影还没追上」的一小段，避免回闪。
   *   chosen    —— 单选组的显示值：用户刚点的那一档优先，否则就是生效值。
   * 「已选未保存」「保存中待确认」都只改 chosen，savedTier 不动，状态行照实说明。
   */
  const savedTier = committed?.tokens ?? usage?.budget.tokens ?? draftTier ?? TIERS[0].value;
  const chosen = draftSelection ?? savedTier;
  /** 空白新会话：用户显式选的 > 来源会话（已读到）> 无来源时的缺省 256K；读不到就留空。 */
  const firstChosen = draftTier ?? (inheritState === "ready" ? inheritedTier
    : inheritState === "none" ? TIERS[0].value : null);
  /** 有会话时的状态行：生效值只认服务端那一档。 */
  const tierState = saving
    ? `正在保存 ${formatTierLabel(draftSelection)}；确认之前仍按 ${formatTierLabel(savedTier)} 生效。`
    : draftSelection !== null && draftSelection !== savedTier
      ? `已选 ${formatTierLabel(draftSelection)}，尚未保存；现在生效的是 ${formatTierLabel(savedTier)}。`
      : `当前生效：${formatTierLabel(savedTier)}；下一次模型调用按它冻结预算。`;
  /** 还没有会话时的状态行：继承结果只有读到来源会话那一行才敢说。 */
  const firstTierState = draftTier != null
    ? `已选 ${formatTierLabel(draftTier)}：会话建立时写入，第一个模型调用就按它冻结预算。`
    : inheritState === "loading"
      ? "正在读取来源会话的档位…（尚未确认，先不显示继承结果）"
      : inheritState === "ready"
        ? `继承来源会话：${formatTierLabel(inheritedTier)}；会话建立时写入，第一个模型调用按它冻结预算。`
        : inheritState === "failed"
          ? "读不到来源会话的档位：先不显示继承结果；建立时由服务端按来源会话继承，来源无效则从 256K 起。也可以现在直接选一档。"
          : "没有来源会话：会话建立时从 256K 起。";

  const applyTier = useCallback(async (next: RelayContextBudgetTokens): Promise<void> => {
    if (sessionId === null) {
      // 还没有会话：只改草稿，建会话时随命令落库。
      onDraftTierChange?.(next);
      return;
    }
    if (client === null) return;
    if (usage === null) {
      // 读不到当前档位就写不了：CAS 需要基线修订。没有基线还硬写，等于把
      // 「不知道当前值」伪装成「知道」。这里说清楚，并让人能重读。
      setActionError(loading ? "正在读取当前档位，稍后再点一次即可。"
        : "读不到这条会话的当前档位，暂时无法保存；请先重新读取。");
      onReload();
      return;
    }
    if (saving) return;
    const commandId = createCommandId();
    // 用最近一次确认过的修订做 CAS：刚写成功但投影还没追上时，用旧修订会被打成 409。
    const expectedRevision = committed?.revision ?? usage.budget.revision;
    setSaving(true); setDraftSelection(next); setNotice(null); setActionError(null); setConflict(null);
    try {
      const result = await client.setSessionContextBudget({ sessionId, commandId,
        expectedRevision, budgetTokens: next });
      if (disposed.current) return;
      setPending(null);
      setCommitted({ tokens: result.contextBudgetTokens, revision: result.revision });
      setNotice(`已保存（修订 v${result.revision}）：本会话每次模型调用最多携带 `
        + `${result.contextBudgetTokens.toLocaleString()} tokens。`);
      onSaved();
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      if (described.kind === "conflict") {
        // 409 不覆盖别人刚写入的值：重读最新档位并说明，用户再点一次即可。
        setConflict(described.message);
        onReload();
      } else if (caught instanceof RelayTransportError) {
        // 传输失败不等于没写成功：保留原 command_id 与载荷，由回执核对收口。
        setPending({ commandId, expectedRevision, budget: next, reason: described.message });
      } else {
        setActionError(described.message);
      }
    } finally {
      if (!disposed.current) setSaving(false);
    }
  }, [client, committed?.revision, loading, onDraftTierChange, onReload, onSaved, saving,
    sessionId, usage]);

  async function checkReceipt(): Promise<void> {
    if (client === null || sessionId === null || pending === null) return;
    setChecking(true); setActionError(null);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      if (disposed.current) return;
      if (receipt.commandType !== "SetSessionContextBudget") {
        setActionError(`原命令回执的类型是 ${receipt.commandType}，不是会话上下文档位；`
          + "不能当作本次保存已生效。");
        return;
      }
      const receiptSession = String(receipt.result.session_id ?? "");
      if (receiptSession !== sessionId) {
        setActionError("原命令回执属于另一条会话，不能当作本次保存已生效。");
        return;
      }
      setPending(null);
      const revision = String(receipt.result.revision ?? "");
      // 回执确认了服务端事实：先把这一档钉住，避免重读回来之前选择器回闪旧值。
      setCommitted({ tokens: pending.budget, revision });
      setNotice(`原命令回执已核对：会话档位已保存（修订 v${revision}）。`);
      onReload();
      onSaved();
    } catch (caught) {
      if (!disposed.current) setActionError(`回执尚未核对到：${describeLiveError(caught).message}`);
    } finally { if (!disposed.current) setChecking(false); }
  }

  const lastCall = usage?.lastCall ?? null;
  const inputTokens = lastCall?.inputTokens ?? null;
  // 分母优先用那次调用的冻结预算：换档之后历史占比仍按当时的口径解释。
  // 冻结预算缺失（历史调用没有预留列）时**不借用当前档位**——那会显示一个未经证实的百分比。
  const reserved = lastCall?.reservedTokens ?? null;
  const ratio = inputTokens !== null && reserved !== null && reserved > 0
    ? inputTokens / reserved : null;
  const remaining = inputTokens !== null && reserved !== null ? reserved - inputTokens : null;
  const percent = ratio === null ? null : formatRatioPercent(ratio);
  const breakdown = lastCall?.breakdown ?? null;
  const hitRate = cacheHitRate(inputTokens, lastCall?.cacheReadTokens ?? null);
  // 档位与那次调用冻结的预算不同时，明确写出来：否则「占比 16%」和「当前 1024K」
  // 会读成互相矛盾的两个数。
  const freezeDiffers = usage?.budget.tokens != null && lastCall?.reservedTokens != null &&
    lastCall.reservedTokens !== usage.budget.tokens;

  return <div className="context-usage" data-testid="context-usage-panel" ref={rootRef}>
    {error !== null && <div className="action-error" role="alert" data-testid="context-usage-error">
      <p>上下文用量读取失败：{error}</p>
      <button className="secondary-button" type="button" disabled={loading}
        onClick={onReload}>重新读取</button>
    </div>}

    {usage !== null && <>
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
                {reserved !== null && <><span className="agent-chat-context-meter-sep"> / </span>
                  <span>{reserved.toLocaleString()}</span></>}
                <span className="agent-chat-context-meter-unit"> tokens</span>
              </span>
              {percent !== null && <span className="agent-chat-context-meter-percent"
                data-testid="assist-context-meter-percent" data-over={ratio !== null && ratio > 1
                  ? "true" : undefined}>{percent}%</span>}
              {percent === null && reserved === null && <span className="agent-chat-context-meter-unknown"
                data-testid="assist-context-meter-budget-unknown">预算未知</span>}
            </p>
            {ratio !== null && <span className="agent-chat-context-meter-bar" aria-hidden="true"
              data-over={ratio > 1 ? "true" : undefined}>
              <span style={{ width: `${Math.min(1, ratio) * 100}%` }} /></span>}
            {/* 二级信息两列：预算余量（估算）与本次输出。余量是「预算 − 上报用量」，
                不等于模型物理窗口的剩余容量。 */}
            {(remaining !== null || lastCall.outputTokens !== null)
              && <div className="agent-chat-context-meter-secondary"
                data-single={remaining === null || lastCall.outputTokens === null ? "true" : undefined}>
                {remaining !== null && <div className="agent-chat-context-meter-stat">
                  <span className="agent-chat-context-meter-stat-label">
                    {remaining < 0 ? "超出预算（估算）" : "预算余量（估算）"}</span>
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
          {freezeDiffers && <p className="context-usage-note" data-testid="context-usage-frozen-note">
            这次调用按 {lastCall.reservedTokens?.toLocaleString()} tokens 的冻结预算记录，
            当前档位是 {usage?.budget.tokens.toLocaleString()} tokens；占比按当时的口径显示。
          </p>}
        </>}

      <section className="context-usage-section" aria-labelledby={`${name}-breakdown`}>
        <h3 className="context-usage-section-title" id={`${name}-breakdown`}>
          上下文构成
          {breakdown !== null && <span className="context-usage-estimate"
            data-testid="context-usage-estimate">估算</span>}
        </h3>
        {breakdown === null
          ? <p className="context-usage-note" data-testid="context-usage-breakdown-empty">
            暂无分项统计。这条记录只保留了总用量。</p>
          : <ul className="context-usage-list" data-testid="context-usage-breakdown">
            {sortedCategories(breakdown).map((entry) => {
              const meta = CATEGORY_META[entry.key];
              const Icon = meta.icon;
              return <li key={entry.key} className="context-usage-row"
                data-testid={`context-usage-row-${entry.key}`}>
                <Icon aria-hidden="true" className="context-usage-row-icon" size={14} />
                <span className="context-usage-row-label">{meta.label}</span>
                <span className="context-usage-row-value">{entry.tokens.toLocaleString()}
                  <span className="context-usage-row-unit"> tokens</span></span>
              </li>;
            })}
          </ul>}
        {breakdown !== null && breakdown.imageParts > 0 &&
          <p className="context-usage-note" data-testid="context-usage-image-note">
            另有 {breakdown.imageParts} 段图片未计入估算：图片 token 由模型侧编码决定。</p>}
      </section>

      <section className="context-usage-section" aria-labelledby={`${name}-tiers`}
        data-testid="context-budget-inline">
        <h3 className="context-usage-section-title" id={`${name}-tiers`}>上下文档位</h3>
        <p className="context-usage-note">本会话独立保存，新会话继承上一会话的选择。</p>
        <div className="context-usage-tiers" role="radiogroup" aria-label="上下文档位"
          data-testid="context-usage-tiers">
          {TIERS.map((tier) => <label className="context-usage-tier" key={tier.value}
            data-divider={TIERS.indexOf(tier) === 0 ? undefined : "true"}>
            <input type="radio" name={`${name}-tier`} value={tier.value}
              data-testid={`context-budget-option-${tier.value}`}
              checked={chosen === tier.value} disabled={saving}
              onChange={() => setDraftSelection(tier.value)} />
            <span>{tier.label}</span>
          </label>)}
        </div>
        <div className="context-usage-tier-actions">
          <button className="secondary-button secondary-button--compact" type="button"
            data-testid="context-budget-save"
            disabled={saving || loading || usage === null || draftSelection === null
              || draftSelection === savedTier}
            onClick={() => { if (draftSelection !== null) void applyTier(draftSelection); }}>
            {saving ? "正在保存" : "保存档位"}</button>
          <button className="secondary-button secondary-button--compact" type="button"
            data-testid="context-budget-reload" disabled={saving} onClick={() => onReload()}>
            重新读取</button>
        </div>
        <p className="context-usage-note" role="status" data-testid="context-usage-tier-state">
          {tierState}
        </p>
        {notice !== null && <p className="receipt-message" role="status"
          data-testid="context-budget-notice">{notice}</p>}
        {actionError !== null && <p className="action-error" role="alert"
          data-testid="context-usage-action-error">{actionError}</p>}
        {conflict !== null && <p className="action-error" role="alert"
          data-testid="context-budget-conflict">
          档位已被其他操作改动：{conflict}。已重读最新值，再点一次即可。
        </p>}
        {pending !== null && <div className="action-error" role="alert"
          data-testid="context-budget-pending">
          <p>保存结果待核对：{pending.reason}</p>
          <p className="context-usage-note">原 command_id：{pending.commandId}。先查回执；查不到时只能用同一命令与同一档位重试，不换新 ID。</p>
          <button className="text-link" type="button" data-testid="context-budget-receipt"
            disabled={checking} onClick={() => void checkReceipt()}>
            {checking ? "正在查询…" : "查询原命令回执"}</button>
        </div>}
      </section>
    </>}
    {sessionId === null && (
      <section className="context-usage-section" aria-labelledby={`${name}-first-tiers`}>
        <h3 className="context-usage-section-title" id={`${name}-first-tiers`}>上下文档位</h3>
        <p className="context-usage-note">本会话独立保存，新会话继承上一会话的选择。</p>
        <div className="context-usage-tiers" role="radiogroup" aria-label="上下文档位"
          data-testid="context-usage-tiers">
          {TIERS.map((tier) => <label className="context-usage-tier" key={tier.value}
            data-divider={TIERS.indexOf(tier) === 0 ? undefined : "true"}>
            <input type="radio" name={`${name}-first-tier`} value={tier.value}
              data-testid={`context-budget-option-${tier.value}`}
              checked={firstChosen === tier.value}
              onChange={() => { onDraftTierChange?.(tier.value); }} />
            <span>{tier.label}</span>
          </label>)}
        </div>
        <p className="context-usage-note" role="status" data-testid="context-usage-tier-state">
          {firstTierState}
        </p>
        {inheritState === "failed" && <button className="text-link" type="button"
          data-testid="context-usage-inherit-retry" onClick={() => onRetryInherit?.()}>
          重新读取来源档位</button>}
      </section>
    )}
    {usage === null && loading && <p className="context-usage-note" role="status"
      data-testid="context-usage-loading">正在读取上下文用量…</p>}
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
