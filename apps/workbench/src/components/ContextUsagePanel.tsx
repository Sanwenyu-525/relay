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
 *   · **点档位就写服务端**（2026-10-31 用户指令：删掉「保存档位 / 重新读取」两枚按钮，
 *     档位点击即保存）。点下去就是一次写（带该会话自己的档位修订 CAS），不再有「已选未
 *     保存」这个中间态。生效与否只由服务端回执决定：在途与待核对时不宣称已切换，
 *     状态行明说「正在保存 X；确认之前仍按 Y 生效」。409 与明确失败都退回生效值并说明；
 *     传输失败保留原 command_id 待核对（不换新 ID），那条待核对档位仍显示为选中态。
 *
 * 组件仍支持「没有会话时」的草稿档位（`draftTier` 一族参数）；但主界面自 2026-11-01 起
 * 不再在首条输入器挂载该入口（会话欢迎页不显示上下文圆环），新会话档位由服务端按来源
 * 会话继承。首条之前的预选与草稿不再由产品路径调用。
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

/**
 * 一条「已发出、结果待核对」的档位写命令（P0，2026-10-30 复审）。
 *
 * 它必须带上**目标会话**：待核对属于那条会话的事实，不属于浮层这一屏。切到别的会话时它
 * 照样保留（原 command_id 不能丢），只是不参与那一屏的渲染。
 */
type Pending = { readonly sessionId: string; readonly commandId: string;
  readonly expectedRevision: DecimalRevision; readonly budget: RelayContextBudgetTokens;
  readonly reason: string };

/** 一条会话自己的显示态：只有 sessionId 与当前会话一致时才参与渲染。 */
type Scoped<T> = { readonly sessionId: string; readonly value: T };

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
  /*
   * 正在保存的会话集合：按会话记，不按浮层记。
   *
   * 浮层是同一个组件实例，切会话只是换 props。用一个布尔表示「保存中」，会让 A 会话的在途
   * 请求把 B 会话的单选组也锁住；A 的请求结束时，又去解开 B 的锁。
   */
  const [savingSessions, setSavingSessions] = useState<readonly string[]>([]);
  const saving = sessionId !== null && savingSessions.includes(sessionId);
  /**
   * 在途写的**同步**标记。
   *
   * `saving` 是渲染后的派生值：同一帧里连着点两档时，第二个事件处理器看到的仍是旧闭包，
   * 会放出第二条写命令（两条同基线 CAS，一条成功一条 409，但「一次只允许一个未确认的写」
   * 已经被破坏）。ref 在事件里立即可见，用它做真正的闸门；`saving` 只管界面禁用。
   */
  const savingRef = useRef<readonly string[]>([]);
  /**
   * 用户刚点下、正在写给服务端的那一档（按会话登记）。
   *
   * 点档位就是一次写，所以它只活在一次写的过程里：回执确认、409 或明确失败都会清掉，
   * 让选择器回到服务端事实；只有传输失败（结果未决）时才留到回执核对完，免得把
   * 「可能已经写成功」的那一档先退回旧值，让用户以为没写。
   *
   * 按会话存放而不是单个值：切到别的会话时，A 的在途选择不能画到 B 的单选组上。
   */
  const [chosenBySession, setChosenBySession] =
    useState<readonly Scoped<RelayContextBudgetTokens>[]>([]);
  const chosenFor = chosenBySession.find((item) => item.sessionId === sessionId)?.value ?? null;
  const [conflict, setConflict] = useState<Scoped<string> | null>(null);
  const [actionError, setActionError] = useState<Scoped<string> | null>(null);
  const [pendingBySession, setPendingBySession] = useState<readonly Pending[]>([]);
  const [checkingSessions, setCheckingSessions] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<Scoped<string> | null>(null);
  /*
   * 下面这些都是**按会话存放的显示态**：写入时登记它属于哪条会话，渲染时只取当前会话那一份。
   * A 会话的迟到响应最多更新 A 的那一份，永远改不到 B 这一屏（P0-6）。
   */
  const conflictFor = conflict !== null && conflict.sessionId === sessionId ? conflict.value : null;
  const actionErrorFor = actionError !== null && actionError.sessionId === sessionId
    ? actionError.value : null;
  const noticeFor = notice !== null && notice.sessionId === sessionId ? notice.value : null;
  const pending = pendingBySession.find((item) => item.sessionId === sessionId) ?? null;
  const checking = sessionId !== null && checkingSessions.includes(sessionId);
  /** 把一条待核对的写命令登记到它自己的会话上；同一会话只保留一条。 */
  const rememberPending = useCallback((entry: Pending) => {
    setPendingBySession((current) => [...current.filter((item) => item.sessionId !== entry.sessionId),
      entry]);
  }, []);
  /** 这条会话的写命令收口了（成功、明确失败或换基线），不再占着待核对名额。 */
  const forgetPending = useCallback((targetSessionId: string) => {
    setPendingBySession((current) => current.filter((item) => item.sessionId !== targetSessionId));
  }, []);
  /** 登记/撤下这条会话「正在写」的档位。 */
  const rememberChosen = useCallback((targetSessionId: string, tokens: RelayContextBudgetTokens) => {
    setChosenBySession((current) => [...current.filter((item) => item.sessionId !== targetSessionId),
      { sessionId: targetSessionId, value: tokens }]);
  }, []);
  const forgetChosen = useCallback((targetSessionId: string) => {
    setChosenBySession((current) => current.filter((item) => item.sessionId !== targetSessionId));
  }, []);
  /*
   * 刚写成功、但父组件还没把新投影读回来的那一小段时间。
   *
   * 没有它就会出现「回闪」：点 512K → 写成功 → 乐观值清掉 → 投影还没刷新（仍是 256K）
   * → 选择器跳回 256K → 投影刷新后才又变回 512K。用户看到的是一次毫无来由的跳动，
   * 在慢网络下还会停留好几秒。
   *
   * 它只表示「服务端已经确认，但界面还没追上」；一旦投影读到的档位与修订和它一致，
   * 就清掉，让界面完全交给服务端事实。
   *
   * `baseRevision` 是这次写所用的 CAS 基线：投影的修订一旦不再等于它，就说明服务端已经走过
   * 这一步了——不管它是被我们写成的，还是被别人改走的，覆盖层都必须让位（前者是「追上了」，
   * 后者是「没轮上」）。P1 要的「外部改动必须显示出来」就靠这一条。
   */
  const [committed, setCommitted] = useState<{ readonly sessionId: string;
    readonly tokens: RelayContextBudgetTokens;
    readonly revision: DecimalRevision; readonly baseRevision: DecimalRevision } | null>(null);
  const committedFor = committed !== null && committed.sessionId === sessionId ? committed : null;
  const name = useId();
  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => { disposed.current = true; };
  }, []);
  useEffect(() => {
    if (committed === null || usage === null) return;
    if (usage.sessionId !== committed.sessionId) return;
    // 投影还停在这次写的基线上：界面还没追上，覆盖层继续顶住，避免回闪。
    if (usage.budget.revision === committed.baseRevision) return;
    // 服务端已经走到这一步：覆盖层让位，界面完全交给服务端事实。
    setCommitted(null);
  }, [committed, usage]);

  /*
   * 这里**不再**有「内容变了就把浮层滚回顶部」的复位（2026-11-01 用户指认档位切换时菜单闪动）。
   *
   * 那条复位压的是结构问题：浮层底边锚定、整块 overflow-y: auto，回执或冲突提示一出现容器就向上长，
   * 浏览器保住原视觉位置，把标题与主读数顶出可视区，看起来像「用量不见了」。
   * 现在浮层分成「上固定 / 中滚动 / 档位停靠」三段（见 ContextUsagePanel.css）：回执与错误只在中间的
   * 滚动区里长高，档位区固定在底部不动，几何由外层按圆环重新落位——不需要滚回顶部，也**不该**滚回：
   * 用户正读到第五行时点一下档位就被顶回第一行，那一次顶回就是用户看到的「跳」。
   */

  /*
   * 两个值必须分开说，界面才不会撒谎：
   *   savedTier —— 服务端已保存的档位，也就是「现在生效」的唯一来源；
   *                committed 只覆盖「回执已确认、投影还没追上」的一小段，避免回闪。
   *   chosen    —— 单选组的显示值：这次点击点下去的那一档优先（写的过程中/待核对时），
   *                其余时候就是生效值。点击即写，所以不存在「已选未保存」这个第三态。
   */
  const savedTier = committedFor?.tokens ?? usage?.budget.tokens ?? draftTier ?? TIERS[0].value;
  const chosen = chosenFor ?? savedTier;
  /** 空白新会话：用户显式选的 > 来源会话（已读到）> 无来源时的缺省 256K；读不到就留空。 */
  const firstChosen = draftTier ?? (inheritState === "ready" ? inheritedTier
    : inheritState === "none" ? TIERS[0].value : null);
  /**
   * 有会话时的状态行：正常状态不再常驻说明——三档的单选态已经说明当前值。
   * 只有「在途」「待核对」这种需要解释的情况才出一行。
   */
  const tierState = saving
    ? `正在保存 ${formatTierLabel(chosenFor)}；确认之前仍按 ${formatTierLabel(savedTier)} 生效。`
    : pending !== null
      ? `最后一次确认生效：${formatTierLabel(savedTier)}；待核对的那一档尚未确认。`
      : null;
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
      setActionError({ sessionId, value: loading ? "正在读取当前档位，稍后再点一次即可。"
        : "读不到这条会话的当前档位，暂时无法保存；请先重新读取。" });
      onReload();
      return;
    }
    if (savingRef.current.includes(sessionId)) return;
    // P0-1：有一条还没核对完的写命令时，绝不再生成新的 command_id。
    if (pending !== null) {
      setActionError({ sessionId, value: "上一条保存命令还没核对完：先查它的回执；确认它没有"
        + "提交之后，再用原命令与同一档位重试。这里不会再发第二条写命令。" });
      return;
    }
    const commandId = createCommandId();
    const origin = sessionId;
    // 用最近一次确认过的修订做 CAS：刚写成功但投影还没追上时，用旧修订会被打成 409。
    const expectedRevision = committedFor?.revision ?? usage.budget.revision;
    savingRef.current = [...savingRef.current, origin];
    setSavingSessions((current) => [...current, origin]);
    rememberChosen(origin, next);
    setNotice(null); setActionError(null); setConflict(null);
    try {
      const result = await client.setSessionContextBudget({ sessionId: origin, commandId,
        expectedRevision, budgetTokens: next });
      if (disposed.current) return;
      forgetPending(origin);
      forgetChosen(origin);
      setCommitted({ sessionId: origin, tokens: result.contextBudgetTokens,
        revision: result.revision, baseRevision: expectedRevision });
      setNotice({ sessionId: origin,
        value: `已保存：下次调用按 ${result.contextBudgetTokens.toLocaleString()} tokens 申请。` });
      onSaved();
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      if (described.kind === "conflict") {
        // 409：这条命令没有被提交（对方赢了），不留待核对，直接换基线重读（P0-5）。
        forgetPending(origin);
        forgetChosen(origin);
        setConflict({ sessionId: origin, value: described.message });
        onReload();
      } else if (caught instanceof RelayTransportError) {
        // 传输失败不等于没写成功：保留原 command_id 与载荷，由回执核对收口。
        // 这一档也继续显示为选中（结果未决，不先退回旧值），但状态行不宣称已生效。
        rememberPending({ sessionId: origin, commandId, expectedRevision, budget: next,
          reason: described.message });
      } else {
        // 明确失败：服务端说这条命令没写，就不再占着待核对名额，选择也退回生效值。
        forgetPending(origin);
        forgetChosen(origin);
        setActionError({ sessionId: origin, value: described.message });
      }
    } finally {
      savingRef.current = savingRef.current.filter((item) => item !== origin);
      if (!disposed.current) {
        setSavingSessions((current) => current.filter((item) => item !== origin));
      }
    }
  }, [client, committedFor, forgetChosen, forgetPending, loading, onDraftTierChange, onReload,
    onSaved, pending, rememberChosen, rememberPending, sessionId, usage]);

  async function checkReceipt(): Promise<void> {
    if (client === null || pending === null) return;
    const origin = pending.sessionId;
    setCheckingSessions((current) => [...current, origin]);
    setActionError(null);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      if (disposed.current) return;
      // 回执逐字核对：命令身份、命令类型、目标会话与档位值，缺一条都不能说「已生效」（P0-7）。
      const receiptBudget: unknown = receipt.result.context_budget_tokens;
      if (receipt.commandId !== pending.commandId
        || receipt.commandType !== "SetSessionContextBudget"
        || String(receipt.result.session_id ?? "") !== origin
        || receiptBudget !== pending.budget) {
        setActionError({ sessionId: origin, value: `原命令回执对不上（命令 ${receipt.commandId}、`
          + `类型 ${receipt.commandType}、会话 ${String(receipt.result.session_id ?? "")}、`
          + `档位 ${String(receiptBudget)}）；不能当作本次保存已生效，仍按原 command_id 处理。` });
        return;
      }
      forgetPending(origin);
      forgetChosen(origin);
      const revision = String(receipt.result.revision ?? "");
      // 回执确认了服务端事实：先把这一档钉住，避免重读回来之前选择器回闪旧值。
      setCommitted({ sessionId: origin, tokens: pending.budget, revision,
        baseRevision: pending.expectedRevision });
      setNotice({ sessionId: origin,
        value: "原命令回执已核对：档位已保存。" });
      onReload();
      onSaved();
    } catch (caught) {
      if (!disposed.current) {
        // 核对不到（服务还没记下这条命令，或回执读不到）也算 UNKNOWN：pending 保留，不换 ID。
        setActionError({ sessionId: origin,
          value: `回执尚未核对到：${describeLiveError(caught).message}` });
      }
    } finally {
      if (!disposed.current) {
        setCheckingSessions((current) => current.filter((item) => item !== origin));
      }
    }
  }

  /**
   * 按原命令重试：同一个 command_id、同一条会话、同一个档位与同一个 CAS 基线（P0-4）。
   *
   * 这是「查不到回执」时唯一的第二条出口，而且它**不是**一次新写：同一 command_id 在服务端
   * 是幂等的，重放只会返回原回执，不会写第二遍。
   */
  async function retryPending(): Promise<void> {
    if (client === null || pending === null) return;
    const origin = pending.sessionId;
    if (savingRef.current.includes(origin)) return;
    savingRef.current = [...savingRef.current, origin];
    setSavingSessions((current) => [...current, origin]);
    setActionError(null); setConflict(null); setNotice(null);
    try {
      const result = await client.setSessionContextBudget({ sessionId: origin,
        commandId: pending.commandId, expectedRevision: pending.expectedRevision,
        budgetTokens: pending.budget });
      if (disposed.current) return;
      forgetPending(origin);
      forgetChosen(origin);
      setCommitted({ sessionId: origin, tokens: result.contextBudgetTokens,
        revision: result.revision, baseRevision: pending.expectedRevision });
      setNotice({ sessionId: origin, value: "原命令已重放并核对：档位已保存。" });
      onReload();
      onSaved();
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      if (described.kind === "conflict") {
        // 原命令没被提交、修订又往前走：换基线重读，不再保留这条命令。
        forgetPending(origin);
        forgetChosen(origin);
        setConflict({ sessionId: origin, value: described.message });
        onReload();
      } else if (caught instanceof RelayTransportError) {
        // 还是没取到回执：命令仍然待核对，原 command_id 不换。
        setActionError({ sessionId: origin,
          value: `按原命令重试仍未取到回执：${described.message}` });
      } else {
        forgetPending(origin);
        forgetChosen(origin);
        setActionError({ sessionId: origin, value: described.message });
      }
    } finally {
      savingRef.current = savingRef.current.filter((item) => item !== origin);
      if (!disposed.current) {
        setSavingSessions((current) => current.filter((item) => item !== origin));
      }
    }
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

  return <div className="context-usage" data-testid="context-usage-panel">
    {/*
      * 2026-11-01 用户指令：浮层读序改为「最近一次模型调用 → 上下文构成 → 当前档位」，
      * 三档始终横排并钉在菜单最底部。
      *
      * 分成「滚动区 + 停靠区」两段 DOM，是为了让「档位永远可点」不依赖滚动位置：停靠区是布局的
      * 参与者，不是 sticky/absolute 覆盖层——它变高只会压缩上面的滚动区，不会遮住分项、错误提示
      * 或键盘焦点；窗口极短、压缩到极限时由停靠区自己滚动，而三档就排在它的第一屏。
      */}
    <div className="context-usage-scroll">
      {error !== null && <div className="action-error" role="alert" data-testid="context-usage-error">
        <p>上下文用量读取失败：{error}</p>
        <button className="secondary-button" type="button" disabled={loading}
          onClick={onReload}>重新读取</button>
      </div>}

      {usage !== null && <>
        {/* 第一段：这一次调用实际用了多少、当时冻结了多少预算。分母是那次调用的历史记录，
            与末段的当前档位是两件事，不共用一个数字，也不互相顶替。 */}
        <section className="context-usage-section" aria-labelledby={`${name}-history`}
          data-testid="context-usage-history">
          <div className="context-usage-heading-row">
            <h2 className="context-usage-section-title" id={`${name}-history`}>最近一次模型调用</h2>
            <span className="context-usage-tag"
              title="用量来自上一次调用；档位设置只影响后续调用，不改写这条记录。">历史记录</span>
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
            </>}
        </section>

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
          {breakdown !== null && breakdown.imageParts > 0 &&
            <p className="context-usage-note" data-testid="context-usage-image-note">
              另有 {breakdown.imageParts} 段图片未计入估算：图片 token 由模型侧编码决定。</p>}
        </section>
      </>}
      {usage === null && loading && <p className="context-usage-note" role="status"
        data-testid="context-usage-loading">正在读取上下文用量…</p>}
    </div>

    {/* 末段：以后按哪一档。它钉在菜单底部、离圆环最近，不随上方内容滚走。
        2026-11-01 用户指令：删掉「当前档位 256K」这一行——三档的单选态本身就是当前值，
        再写一遍只是重复；状态短标签随之退场，保存中/待核对/失败仍由下方状态行与错误块说明。 */}
    <div className="context-usage-dock">
      <section className="context-usage-section" data-testid="context-budget-inline">
        <div className="context-usage-tiers" role="radiogroup" aria-label="上下文档位"
          data-testid="context-usage-tiers">
          {TIERS.map((tier) => <label className="context-usage-tier" key={tier.value}
            data-divider={TIERS.indexOf(tier) === 0 ? undefined : "true"}>
            <input type="radio" name={`${name}-tier`} value={tier.value}
              data-testid={`context-budget-option-${tier.value}`}
              checked={(sessionId === null ? firstChosen : chosen) === tier.value}
              disabled={sessionId !== null && (saving || pending !== null)}
              onChange={() => { void applyTier(tier.value); }} />
            <span>{tier.label}</span>
          </label>)}
        </div>
        {/* 2026-11-01 用户指令：删掉「下次调用申请 N tokens」这一行。它把同一档位换个数再写一遍，
            窗口未知时还会多挂一枚解释标签；档位选择本身已表达「按哪一档申请」。 */}
        {sessionId === null && <p className="context-usage-note"
          data-testid="context-usage-first-tier-state">{firstTierState}</p>}
        <p className="context-usage-tier-state" role="status" data-testid="context-usage-tier-state">
          {tierState}</p>
        {sessionId === null && inheritState === "failed" && <button className="text-link" type="button"
          data-testid="context-usage-inherit-retry" onClick={() => onRetryInherit?.()}>
          重新读取来源档位</button>}
        {noticeFor !== null && <p className="context-usage-note" role="status"
          data-testid="context-budget-notice">{noticeFor}</p>}
        {actionErrorFor !== null && <p className="action-error" role="alert"
          data-testid="context-usage-action-error">{actionErrorFor}</p>}
        {conflictFor !== null && <p className="action-error" role="alert"
          data-testid="context-budget-conflict">
          档位已被其他操作改动：{conflictFor}。已重读最新值，再点一次即可。
        </p>}
        {pending !== null && <div className="action-error" role="alert"
          data-testid="context-budget-pending">
          <p>保存结果待核对：{pending.reason}</p>
          <p className="context-usage-note">原 command_id：{pending.commandId}。先查回执；查不到时只能用同一命令与同一档位重试，不换新 ID。</p>
          <button className="text-link" type="button" data-testid="context-budget-receipt"
            disabled={checking} onClick={() => void checkReceipt()}>
            {checking ? "正在查询…" : "查询原命令回执"}</button>
          <button className="text-link" type="button" data-testid="context-budget-retry"
            disabled={checking || saving} onClick={() => void retryPending()}>
            {saving ? "正在重试…" : "按原命令重试"}</button>
        </div>}
      </section>
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
