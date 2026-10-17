import { useEffect, useId, useRef, useState } from "react";

import { RelayApiError, RelayTransportError, type RelayApiClient } from "../api/relayClient";
import "./ComposerDraftAssist.css";

/**
 * 输入框自动分点与手动润色（工作台 §30，视觉对齐 `GPT页面原型/Relay_Composer_Assist_Prototype.html`）。
 *
 * 这个模块导出三件东西，让「辅助状态」与「呈现位置」分开：
 *   * `useComposerDraftAssist()` —— 唯一的状态 Owner（定时、版本、来源校验、快照与暂停）；
 *   * `ComposerDraftBar()` —— 输入卡**上方**的提示行与锚定浮层（原型的 `assist-bar` + `assist-popover`）；
 *   * `ComposerPolishButton()` —— 输入卡**工具行内**的润色键（原型的 `#polishBtn`）。
 *
 * 为什么要拆开：润色是发送前的一个动作，和「资料 / 模式 / ContextMeter」同一行才是它该在的地方；
 * 把它单独放一行会显得它是个独立功能区，也会把输入卡往下推。原型三方案共用这一处按钮位置。
 *
 * **本模块不持有正文**：正文与光标仍归原输入器 Owner（`AssistView` 的首条草稿 / 会话草稿），
 * 这里只经 `onChange` 请求替换草稿。首条与已有会话共用同一份辅助逻辑，不存在第二个正文 Owner。
 *
 * 硬边界（与 §30.2–§30.4 一一对应）：
 *   * 停笔延时后才请求；组词期间、空文、禁用、在途发送、斜杠命令、短输入、已分行都不请求；
 *   * 同一草稿版本只请求一次，忽略与失败都不自动重试；
 *   * 请求与回包都带**单调内容版本**，仅比较文本不足以处理「改了又改回相同文本」；
 *   * 采用分点提供一次「撤销分点」；开始润色结束该入口；
 *   * 润色成功保存润色前快照并暂停自动分点，撤销精确恢复快照（含丢弃润色后的手动修改）；
 *   * 任何失败都保留草稿，不阻止原发送。
 */

/** 停笔延时：集中常量，工作台 §30.5 的**待验证默认值**，不是已确认产品数值。 */
export const COMPOSER_OUTLINE_DELAY_MS = 2000;

/**
 * 与服务端同一口径的边界（`apps/api/src/workflow/composer-draft.ts`）。
 * 两个应用各自打包、没有共享模块，因此这里是刻意的重复常量：客户端据此少发无意义的请求，
 * 服务端仍是唯一权威（它会再次判定并可能返回 NO_SUGGESTION）。
 */
const COMPOSER_MIN_DRAFT_CODE_POINTS = 8;
const COMPOSER_MAX_DRAFT_CODE_POINTS = 4000;

type OutlineRecord =
  | { readonly kind: "PENDING"; readonly version: number }
  | { readonly kind: "READY"; readonly version: number;
      readonly text: string; readonly itemCount: number }
  | { readonly kind: "FAILED"; readonly version: number; readonly message: string };

type PolishRecord =
  | { readonly kind: "PENDING"; readonly version: number }
  | { readonly kind: "FAILED"; readonly version: number; readonly message: string }
  /** 已应用：快照是**本次润色前**的完整草稿，成功后编辑不覆盖它。 */
  | { readonly kind: "APPLIED"; readonly snapshot: string };

function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** 自动分点是否适用：与 §30.2/§30.4 的排除项逐条对应。 */
function outlineEligible(value: string): boolean {
  if (value.trim() === "") return false;
  if (/^\s*\//u.test(value)) return false;
  if (value.includes("\n") || value.includes("\r")) return false;
  const points = codePointLength(value);
  return points >= COMPOSER_MIN_DRAFT_CODE_POINTS && points <= COMPOSER_MAX_DRAFT_CODE_POINTS;
}

/**
 * 草稿辅助失败的呈现。**不做无依据归因**：按 HTTP 状态分类，把可执行的下一步写进文案。
 *
 * 404 要单独说清楚：那是 Fastify 的 not-found（`api/server.ts` 的 `resourceNotFound()`）
 * 给出的通用 `RESOURCE_NOT_FOUND`，detail 是「请求的路径在当前服务上不存在。」——
 * 它只说明**当前连接的服务进程没有这条路由**（通常是前端比 API 新：API 还在跑旧构建，
 * 尚未注册 `/composer/draft-assist`），不是草稿有问题，也不代表发送被禁止。
 * 因此这里不照抄那句通用 detail，而是指向「更新/重启服务端」，并强调草稿与发送不受影响。
 */
function describeAssistError(error: unknown): string {
  if (error instanceof RelayApiError) {
    const { status, code, detail } = error.problem;
    if (status === 404) {
      return `草稿辅助在当前服务上不可用（404 ${code}）：连接的服务尚未提供该端点，请更新或重启服务端；草稿与发送不受影响。`;
    }
    if (status === 409 || status === 502) return detail;
  }
  if (error instanceof RelayTransportError) return error.message;
  return "草稿辅助暂时不可用，草稿已保留。";
}

export interface ComposerDraftAssistOptions {
  client: RelayApiClient | null;
  /** 连接 + 工作区 + 会话（首条为 null）身份：变化使在途请求与全部辅助状态失效。 */
  sourceKey: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** 首条在途/待核对、会话在生成中：辅助不发起也不替代发送。 */
  inflight?: boolean;
  /** 中文组词中：零请求。 */
  composing?: boolean;
  /** 撤销/忽略后把焦点交回输入框；本模块自己从不主动抢焦点。 */
  onRequestFocus?: () => void;
  /**
   * 停笔延时的注入点。默认就是上面那个待验证常量；测试与后续调参用它缩短等待，
   * 它不是用户可调设置（工作台 §30.5：不增加设置中心或调参表单）。
   */
  outlineDelayMs?: number;
}

export interface ComposerDraftAssist {
  readonly recordKey: string;
  readonly ready: { readonly text: string; readonly itemCount: number } | null;
  readonly showPanel: boolean;
  readonly outlineUndo: string | null;
  readonly polishBusy: boolean;
  readonly polishApplied: boolean;
  readonly polishEnabled: boolean;
  readonly failedOutline: string | null;
  readonly polishFailed: string | null;
  /** 撤销润色的后果提示 id：工具行按钮用 aria-describedby 指向它，读屏可获取。 */
  readonly consequenceId: string;
  readonly openPanel: () => void;
  readonly closePanel: () => void;
  readonly ignoreOutline: () => void;
  readonly adoptOutline: () => void;
  readonly undoOutline: () => void;
  readonly retryOutline: () => void;
  /** 工具行按钮的唯一动作：空闲时润色，已应用时撤销。 */
  readonly togglePolish: () => void;
}

export function useComposerDraftAssist({
  client, sourceKey, value, onChange, disabled = false, inflight = false, composing = false,
  onRequestFocus, outlineDelayMs = COMPOSER_OUTLINE_DELAY_MS,
}: ComposerDraftAssistOptions): ComposerDraftAssist {
  const consequenceId = useId();
  const [outline, setOutline] = useState<OutlineRecord | null>(null);
  const [outlineUndo, setOutlineUndo] = useState<string | null>(null);
  const [polish, setPolish] = useState<PolishRecord | null>(null);
  /** 展开状态按「来源#版本」记账：版本一变，浮层自动收起，不需要在编辑时 setState。 */
  const [expandedFor, setExpandedFor] = useState<string | null>(null);

  const versionRef = useRef(0);
  const seenRef = useRef({ value, source: sourceKey });
  const handledRef = useRef<string | null>(null);
  /** 该文本不再自动触发分点：采用后的文本、撤销恢复的文本、润色结果都落在这里。 */
  const suppressRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // 渲染期只做「派生状态」调整（React 支持的 props 变化适配写法）：
  //   * 正文变化 → 版本 +1（旧回包据此失效），并解除一次性抑制；
  //   * 来源变化或正文被清空（发送成功）→ 清掉本次全部辅助状态。
  const seen = seenRef.current;
  if (seen.source !== sourceKey) {
    seenRef.current = { value, source: sourceKey };
    versionRef.current += 1;
    handledRef.current = null; suppressRef.current = null;
    abortRef.current?.abort(); abortRef.current = null; seqRef.current += 1;
    setOutline(null); setOutlineUndo(null); setPolish(null); setExpandedFor(null);
  } else if (seen.value !== value) {
    const previous = seen.value;
    seenRef.current = { value, source: sourceKey };
    versionRef.current += 1;
    if (suppressRef.current !== null && suppressRef.current !== value) suppressRef.current = null;
    if (value === "" && previous !== "") {
      handledRef.current = null;
      abortRef.current?.abort(); abortRef.current = null; seqRef.current += 1;
      setOutline(null); setOutlineUndo(null); setPolish(null); setExpandedFor(null);
    }
  }

  const version = versionRef.current;
  const recordKey = `${sourceKey}#${version}`;
  const ready = outline !== null && outline.version === version && outline.kind === "READY"
    ? outline : null;
  const failedOutline = outline !== null && outline.version === version && outline.kind === "FAILED"
    ? outline : null;
  const showPanel = ready !== null && expandedFor === recordKey;

  const polishBusy = polish !== null && polish.kind === "PENDING" && polish.version === version;
  const polishApplied = polish !== null && polish.kind === "APPLIED";
  const polishFailed = polish !== null && polish.kind === "FAILED" && polish.version === version;
  const polishEnabled = client !== null && !disabled && !inflight && !polishBusy
    && value.trim() !== "" && codePointLength(value) <= COMPOSER_MAX_DRAFT_CODE_POINTS;

  const eligible = client !== null && !disabled && !inflight && !composing && !polishApplied
    && suppressRef.current !== value && outlineEligible(value)
    && handledRef.current !== recordKey;

  /** 来源 + 版本双重核对：改回相同文本后旧回包必须仍然被丢弃。 */
  function isCurrent(seq: number, requestVersion: number): boolean {
    return seq === seqRef.current && requestVersion === versionRef.current
      && seenRef.current.source === sourceKey;
  }

  useEffect(() => {
    if (!eligible || client === null) return;
    const requestVersion = versionRef.current;
    const text = value;
    const handle = setTimeout(() => {
      void runOutline(client, requestVersion, text);
    }, outlineDelayMs);
    return () => clearTimeout(handle);
    // eligible 已覆盖 client/禁用/在途/组词/版本等条件；value 变化重启计时即停笔判定。
    // sourceKey 也要在依赖里：换会话/换连接后即使正文一字未改，也应重新为新的来源计时。
  }, [eligible, client, value, outlineDelayMs, sourceKey]);

  async function runOutline(activeClient: RelayApiClient, requestVersion: number,
    text: string): Promise<void> {
    const key = `${sourceKey}#${requestVersion}`;
    if (handledRef.current === key) return;
    // 同一版本只请求一次：失败与忽略都不自动重试。
    handledRef.current = key;
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setOutline({ kind: "PENDING", version: requestVersion });
    try {
      const result = await activeClient.requestComposerDraftAssist({
        operation: "OUTLINE", text, signal: controller.signal,
      });
      if (!isCurrent(seq, requestVersion)) return;
      if (result.status !== "OUTLINE") { setOutline(null); return; }
      setOutline({ kind: "READY", version: requestVersion,
        text: result.text, itemCount: result.itemCount });
    } catch (caught) {
      if (!isCurrent(seq, requestVersion)) return;
      if (controller.signal.aborted) { setOutline(null); return; }
      setOutline({ kind: "FAILED", version: requestVersion,
        message: describeAssistError(caught) });
    }
  }

  function retryOutline(): void {
    if (client === null || failedOutline === null) return;
    handledRef.current = null;
    setOutline(null);
    void runOutline(client, version, value);
  }

  function togglePolish(): void {
    if (client === null) return;
    if (polishApplied) { undoPolish(); return; }
    if (!polishEnabled) return;
    const requestVersion = versionRef.current;
    const text = value;
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // 「开始润色结束该撤销入口」：分点撤销与润色撤销不能互相覆盖。
    setOutlineUndo(null);
    setOutline(null);
    setExpandedFor(null);
    setPolish({ kind: "PENDING", version: requestVersion });
    void client.requestComposerDraftAssist({ operation: "POLISH", text, signal: controller.signal })
      .then((result) => {
        if (!isCurrent(seq, requestVersion)) return;
        if (result.status !== "POLISH") {
          setPolish({ kind: "FAILED", version: requestVersion,
            message: "润色未返回可用结果，草稿已保留。" });
          return;
        }
        suppressRef.current = result.text;
        setPolish({ kind: "APPLIED", snapshot: text });
        onChange(result.text);
      })
      .catch((caught) => {
        if (!isCurrent(seq, requestVersion)) return;
        if (controller.signal.aborted) { setPolish(null); return; }
        setPolish({ kind: "FAILED", version: requestVersion,
          message: describeAssistError(caught) });
      });
  }

  function undoPolish(): void {
    if (polish === null || polish.kind !== "APPLIED") return;
    suppressRef.current = polish.snapshot;
    setPolish(null);
    setOutline(null);
    setOutlineUndo(null);
    setExpandedFor(null);
    onChange(polish.snapshot);
    onRequestFocus?.();
  }

  function adoptOutline(): void {
    if (ready === null) return;
    setOutlineUndo(value);
    suppressRef.current = ready.text;
    setOutline(null);
    setExpandedFor(null);
    onChange(ready.text);
    onRequestFocus?.();
  }

  function ignoreOutline(): void {
    setOutline(null);
    setExpandedFor(null);
    // 忽略后整行提示消失：焦点交回输入框，不让它落到 body。
    onRequestFocus?.();
  }

  function undoOutline(): void {
    if (outlineUndo === null) return;
    suppressRef.current = outlineUndo;
    setOutlineUndo(null);
    setOutline(null);
    onChange(outlineUndo);
    onRequestFocus?.();
  }

  return {
    recordKey,
    ready, showPanel, outlineUndo,
    polishBusy, polishApplied, polishEnabled,
    failedOutline: failedOutline === null ? null : failedOutline.message,
    polishFailed: polishFailed && polish !== null && polish.kind === "FAILED"
      ? polish.message : null,
    consequenceId,
    openPanel: () => setExpandedFor(recordKey),
    closePanel: () => setExpandedFor(null),
    ignoreOutline, adoptOutline, undoOutline, retryOutline, togglePolish,
  };
}

/** 工具行里的润色键：同一键位三态，不并列放两颗常驻按钮（原型 `#polishBtn`）。 */
export function ComposerPolishButton({ assist }: { assist: ComposerDraftAssist }) {
  const label = assist.polishApplied ? "撤销润色" : assist.polishBusy ? "润色中…" : "润色";
  const title = assist.polishApplied
    ? "直接恢复本次润色前的草稿与当时编号，不弹确认框、不调用模型"
    : assist.polishBusy ? "正在润色，重复点击不会重复提交" : "润色当前草稿的表达";
  return <button type="button" className="agent-chat-tool composer-draft-polish"
    data-testid={assist.polishApplied ? "composer-draft-undo-polish" : "composer-draft-polish"}
    data-busy={assist.polishBusy ? "true" : undefined}
    disabled={assist.polishBusy || (!assist.polishEnabled && !assist.polishApplied)}
    title={title} aria-label={title}
    aria-describedby={assist.polishApplied ? assist.consequenceId : undefined}
    onClick={assist.togglePolish}>{label}</button>;
}

/** 输入卡上方的提示行与锚定浮层（原型 `assist-bar` + `assist-popover`）。 */
export function ComposerDraftBar({ assist, value, inlinePolish = false }: {
  assist: ComposerDraftAssist;
  /** 当前草稿：浮层的「原文」列直接读它，不再另存一份。 */
  value: string;
  /** 没有工具行可放润色键时（子页/嵌入态），把它并进提示行。 */
  inlinePolish?: boolean;
}) {
  const viewRef = useRef<HTMLButtonElement | null>(null);
  const tone = assist.failedOutline !== null ? "bad"
    : assist.polishFailed !== null ? "warn" : "normal";
  const showRow = assist.ready !== null || assist.outlineUndo !== null
    || assist.polishApplied || assist.polishBusy
    || assist.failedOutline !== null || assist.polishFailed !== null;
  if (!showRow && !inlinePolish) return null;
  // 关闭浮层时焦点回「查看」键：提示行保持渲染，键一直都在，因此焦点有处可还。
  const closePanel = () => { assist.closePanel(); viewRef.current?.focus(); };
  return <div className="composer-draft-bar" data-tone={tone} data-testid="composer-draft-assist">
    {assist.ready !== null && <span className="composer-draft-bar-text" role="status">
      已整理为 {assist.ready.itemCount} 个要点</span>}
    {assist.outlineUndo !== null && <span className="composer-draft-bar-text">已采用分点</span>}
    {assist.polishApplied && !assist.outlineUndo &&
      <span className="composer-draft-bar-text">已润色 · 可以继续编辑</span>}
    {assist.polishBusy && <span className="composer-draft-bar-text">正在润色…</span>}
    {assist.ready !== null && <button type="button" className="composer-draft-bar-cta"
      ref={viewRef} aria-expanded={assist.showPanel}
      onClick={() => (assist.showPanel ? closePanel() : assist.openPanel())}
      data-testid="composer-draft-view">{assist.showPanel ? "收起" : "查看"}</button>}
    {assist.ready !== null && <button type="button" className="composer-draft-bar-cta"
      onClick={assist.ignoreOutline} data-testid="composer-draft-ignore">忽略</button>}
    {assist.outlineUndo !== null && <button type="button" className="composer-draft-bar-cta"
      onClick={assist.undoOutline} data-testid="composer-draft-undo-outline">撤销分点</button>}
    {assist.ready !== null &&
      <span className="composer-draft-bar-note">未采用不会替换正文</span>}
    {assist.outlineUndo !== null &&
      <span className="composer-draft-bar-note">只撤销这一次分点变更</span>}
    {assist.polishApplied && !assist.outlineUndo &&
      <span className="composer-draft-bar-note" data-testid="composer-draft-polish-note">撤销将恢复润色前原话，并清除润色后的手动修改。</span>}
    {assist.polishBusy &&
      <span className="composer-draft-bar-note">不会改动你正在输入的正文</span>}
    {assist.polishApplied && !assist.outlineUndo && <span className="visually-hidden"
      id={assist.consequenceId}>撤销将恢复润色前原话，并清除润色后的手动修改。</span>}
    {assist.failedOutline !== null && <p className="composer-draft-bar-text" role="alert"
      data-tone="bad">{assist.failedOutline}</p>}
    {assist.failedOutline !== null && <button type="button" className="composer-draft-bar-cta"
      onClick={assist.retryOutline} data-testid="composer-draft-retry-outline">重试分点</button>}
    {assist.polishFailed !== null && <p className="composer-draft-bar-text" role="alert"
      data-tone="warn">{assist.polishFailed}</p>}
    {inlinePolish && <ComposerPolishButton assist={assist} />}
    {/* 浮层锚在提示行上方：非模态、限高、内部滚动，不遮住输入与发送，也不推动布局。 */}
    {assist.showPanel && assist.ready !== null && <div className="composer-draft-popover"
      role="group" aria-label="分点建议" data-testid="composer-draft-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePanel(); }
      }}>
      <div className="composer-draft-compare">
        <div className="composer-draft-compare-column">
          <p className="composer-draft-compare-label">原文</p>
          <pre data-testid="composer-draft-original">{value}</pre>
        </div>
        <div className="composer-draft-compare-column">
          <p className="composer-draft-compare-label">建议（只加编号与换行，原话不变）</p>
          <pre data-testid="composer-draft-suggested">{assist.ready.text}</pre>
        </div>
      </div>
      <div className="composer-draft-panel-actions">
        <button type="button" className="primary-button primary-button--compact"
          onClick={assist.adoptOutline} data-testid="composer-draft-adopt">采用分点</button>
        <button type="button" className="secondary-button secondary-button--compact"
          onClick={closePanel} data-testid="composer-draft-cancel">取消</button>
      </div>
    </div>}
  </div>;
}
