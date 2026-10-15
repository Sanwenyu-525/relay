import { useEffect, useRef, useState } from "react";
import { createCommandId, type RelayApiClient,
  type RelayDailyContinuation, type RelayReturnReview } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { phaseLabel } from "../lib/labels";
import "./DailyContinuationCard.css";

/**
 * 返回项目时的顶部接续卡（总纲 §0.8.1、工作台 §18.9）。
 *
 * 展示三件事：当前事实、相对上次**实际查看**（已确认基线）的变化、在途/阻塞/待验收计数。
 * 无基线只展示当前事实，不凭时间猜测期间变化。「已查看」确认只记录阅读进度：
 * 卡片成功呈现后自动确认一次（一次 presentation_id 一次），不是接受候选、接手或完成；
 * 确认成功不改变卡片内容，命名接续点面板也不被日常查看重设。
 */

type ConfirmState = "idle" | "pending" | "failed";

/** 有实质变化：任一 *_changed 为 true，或新增/关闭任务清单非空。 */
function hasRealChange(projection: RelayDailyContinuation): boolean {
  const delta = projection.delta;
  if (delta === null) return false;
  if (delta.openTasksUnknown) return true;
  return delta.phaseChanged || delta.nextActionChanged ||
    delta.newOpenTaskIds.length > 0 || delta.closedTaskIds.length > 0 ||
    delta.unresolvedBlockerCountChanged;
}

/** 摘要行的变化短语；phase 等枚举沿用 phaseLabel 的中文回退。 */
function deltaParts(projection: RelayDailyContinuation): readonly string[] {
  const delta = projection.delta;
  if (delta === null) return [];
  const parts: string[] = [];
  if (delta.phaseChanged) {
    parts.push(`阶段 ${phaseLabel(delta.phaseBefore ?? "") || "未设置"} → ${phaseLabel(delta.phaseAfter ?? "") || "未设置"}`);
  }
  if (delta.nextActionChanged) parts.push("下一步已变更");
  if (delta.openTasksUnknown) parts.push("任务较多，新增/关闭未逐项比对");
  if (delta.newOpenTaskIds.length > 0) parts.push(`新增 ${delta.newOpenTaskIds.length} 个任务`);
  if (delta.closedTaskIds.length > 0) parts.push(`关闭 ${delta.closedTaskIds.length} 个任务`);
  if (delta.unresolvedBlockerCountChanged) parts.push("未决阻塞有变化");
  return parts;
}

/** 当前事实一行：与展开区同源，无基线首帧的主要内容。 */
function currentFactsText(projection: RelayDailyContinuation): string {
  const { current } = projection;
  const phase = current.phaseKey === null ? "未设置" : phaseLabel(current.phaseKey);
  return `阶段 ${phase} · 下一步 ${current.nextActionTaskId === null ? "未指定" : current.nextActionTaskId}` +
    ` · 进行中任务 ${current.openTaskCount} · 等待验收 ${current.waitingTaskCount}` +
    ` · 阻塞 ${current.blockedTaskCount} · 未决阻塞 ${current.unresolvedBlockerCount}`;
}

/** 返回轻量核对的变化维度短语（NLS-05）。 */
function returnReviewDimensionText(review: RelayReturnReview): string {
  const labels: Readonly<Record<string, string>> = {
    baseline_missing: "还没有可比对的查看基线",
    phase: "阶段有变化",
    next_action: "下一步有变化",
    open_tasks: "任务集合有变化",
    blockers: "未决阻塞有变化",
    evidence_drift: "完成证据已不适用",
  };
  const parts = review.changedDimensions.map((item) => labels[item] ?? item);
  return parts.length > 0 ? parts.join("、") : "发现变化";
}

export default function DailyContinuationCard({ client, projectId }: {
  client: RelayApiClient; projectId: string }) {
  const [projection, setProjection] = useState<RelayDailyContinuation | null>(null);
  /** 本次展示的身份：由服务端在读取时签发（身份 + 顺序），确认只针对这份已展示结果。 */
  const [presentation, setPresentation] = useState<{ readonly projection: RelayDailyContinuation;
    readonly presentationId: string; readonly presentationSeq: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>("idle");
  const version = useRef(0);
  const disposed = useRef(false);
  /** 已确认过的 presentation：重复挂载/重渲染不产生第二次确认命令。 */
  const confirmedPresentationId = useRef<string | null>(null);
  /** 确认命令身份：重试沿用同一 command_id（幂等），不换 ID 绕过。 */
  const confirmCommandId = useRef<string | null>(null);
  const autoRetryUsed = useRef(false);
  /** 返回轻量核对（Slice C）：结果与触发身份。 */
  const [review, setReview] = useState<RelayReturnReview | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  /** 已触发过核对的展示身份：同一展示只触发一次；服务端按事实指纹复用同一记录。 */
  const reviewedPresentationId = useRef<string | null>(null);
  const reviewCommandId = useRef<string | null>(null);

  useEffect(() => {
    const request = ++version.current;
    setLoading(true); setError(null); setPresentation(null); setProjection(null);
    setConfirmState("idle");
    confirmedPresentationId.current = null;
    confirmCommandId.current = null;
    autoRetryUsed.current = false;
    setReview(null); setReviewError(null);
    reviewedPresentationId.current = null;
    reviewCommandId.current = null;
    void client.getDailyContinuation(projectId).then((next) => {
      if (disposed.current || request !== version.current) return;
      if (next.projectId !== projectId) throw new Error("接续卡查询返回了其他项目的事实。");
      setProjection(next);
      setPresentation({ projection: next, presentationId: next.presentation.presentationId,
        presentationSeq: next.presentation.presentationSeq });
    }).catch((caught: unknown) => {
      if (disposed.current || request !== version.current) return;
      setError(describeLiveError(caught).message);
    }).finally(() => {
      if (!disposed.current && request === version.current) setLoading(false);
    });
    // disposed 只在卸载时置位：依赖变化重跑是项目切换的正常路径，不能永久挡住新请求。
    return () => { version.current++; };
  }, [client, projectId]);
  useEffect(() => () => { disposed.current = true; }, []);

  /** 确认一次：成功静默结束；失败时自动重试恰一次，之后交给手动链接。 */
  async function confirmOnce(identity: { readonly presentationId: string;
    readonly presentationSeq: string; readonly projection: RelayDailyContinuation }) {
    if (disposed.current) return;
    const data = identity.projection;
    setConfirmState("pending");
    try {
      await client.confirmDailyView(projectId, {
        commandId: confirmCommandId.current ?? createCommandId(),
        presentationId: identity.presentationId,
        presentationSeq: identity.presentationSeq,
        viewedStateRevision: data.current.stateRevision,
        // 回显本次实际展示的内容：确认针对这份已展示结果，不用稍后读取的新状态冒充已看。
        viewedFactRefs: { phase_key: data.current.phaseKey,
          next_action_task_id: data.current.nextActionTaskId,
          open_task_ids: [...data.current.openTaskIds],
          open_task_ids_truncated: data.current.openTaskIdsTruncated,
          // 阻塞计数一并回显：基线缺它时 blocker 维度只能保守显示「无变化」。
          unresolved_blocker_count: data.current.unresolvedBlockerCount }
      });
      if (disposed.current) return;
      confirmedPresentationId.current = identity.presentationId;
      // 确认成功不改变卡片内容：已查看不是接受，也不触发任何状态变化。
      setConfirmState("idle");
    } catch {
      if (disposed.current) return;
      if (!autoRetryUsed.current) {
        autoRetryUsed.current = true;
        await confirmOnce(identity);
        return;
      }
      setConfirmState("failed");
    }
  }

  // 卡片成功呈现后确认一次：effect 在投影渲染提交后运行，天然满足「呈现后确认」。
  useEffect(() => {
    if (presentation === null || confirmState === "pending") return;
    if (confirmedPresentationId.current === presentation.presentationId) return;
    if (confirmCommandId.current === null) confirmCommandId.current = createCommandId();
    void confirmOnce(presentation);
    // confirmState 只用于失败链接的呈现；确认流程由本 effect 与 confirmOnce 自行推进。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentation, projectId]);

  // 返回轻量核对（Slice C / NLS-05）：每个展示身份触发一次；服务端按事实与证据指纹复用
  // 同一核对记录，重复打开不产生第二次核对。核对是只读结论：不启动进程、不伪造 Run、
  // 不自动修复或新建任务；失败如实显示，未完成时不说「无变化」。
  useEffect(() => {
    if (presentation === null || disposed.current) return;
    if (reviewedPresentationId.current === presentation.presentationId) return;
    reviewedPresentationId.current = presentation.presentationId;
    reviewCommandId.current ??= createCommandId();
    void client.reviewProjectReturn(projectId, reviewCommandId.current).then((next) => {
      if (disposed.current) return;
      if (next.projectId !== projectId) {
        throw new Error("返回核对回执与当前项目不匹配。");
      }
      setReview(next);
      setReviewError(null);
    }).catch((caught: unknown) => {
      if (disposed.current) return;
      // 未完成就是未完成：清掉本次触发身份，下一次读取沿同一命令身份重新核对。
      reviewedPresentationId.current = null;
      setReviewError(describeLiveError(caught).message);
    });
  }, [presentation, client, projectId]);

  if (loading) {
    return <section className="daily-continuation" data-testid="daily-continuation"
      data-state="loading" aria-live="polite">
      <p className="helper-text" role="status">正在读取项目接续…</p>
    </section>;
  }
  if (error !== null || projection === null) {
    // 失败态绝不显示「没有变化/与上次查看一致」：读不到就说读不到，可重试。
    return <section className="daily-continuation daily-continuation--failed"
      data-testid="daily-continuation" data-state="failed">
      <p className="warning-callout" role="alert">接续进度读取失败：{error ?? "项目事实不可用。"}</p>
      <p className="helper-text">不显示变化摘要，避免把读取失败当成没有变化。</p>
      <button className="secondary-button" type="button" data-testid="daily-continuation-retry"
        onClick={() => { setError(null); setLoading(true);
          const request = ++version.current;
          void client.getDailyContinuation(projectId).then((next) => {
            if (disposed.current || request !== version.current) return;
            if (next.projectId !== projectId) throw new Error("接续卡查询返回了其他项目的事实。");
            setError(null); setProjection(next);
            setPresentation({ projection: next,
              presentationId: next.presentation.presentationId,
              presentationSeq: next.presentation.presentationSeq });
          }).catch((caught: unknown) => {
            if (!disposed.current && request === version.current) setError(describeLiveError(caught).message);
          }).finally(() => {
            if (!disposed.current && request === version.current) setLoading(false);
          });
        }}>重试</button>
    </section>;
  }
  const baseline = projection.baseline;
  const changed = hasRealChange(projection);
  const parts = changed ? deltaParts(projection) : [];
  const attention = projection.current.blockedTaskCount > 0 ||
    projection.current.unresolvedBlockerCount > 0;
  return <section className={`daily-continuation${attention ? " daily-continuation--attention" : ""}`}
    data-testid="daily-continuation" data-state={changed ? "changed" : "unchanged"}>
    <p className="daily-continuation-summary" data-testid="daily-continuation-summary">
      {baseline === null ? "首次查看，以下是当前事实"
        : changed ? `自上次查看：${parts.join("；")}`
        : projection.delta === null ? "上次查看记录存在，本次没有变化明细可核对"
        : "与上次查看一致"}
    </p>
    {/* 在途/阻塞计数在折叠态也可见：阻塞不为零时整卡带 attention 边线。 */}
    <p className={`daily-continuation-facts${attention ? " daily-continuation-facts--attention" : ""}`}
      data-testid="daily-continuation-facts">{currentFactsText(projection)}</p>
    {/* 返回轻量核对结论（NLS-05）：核对是持久记录，未完成时如实显示、不冒充无变化。 */}
    {review !== null && <p className="helper-text"
      data-testid="daily-continuation-review">
      {review.status === "APPLICABLE"
        ? `轻量核对：未见变化，既有证据仍适用${review.reused ? "（复用上次核对记录）" : ""}`
        : `轻量核对：${returnReviewDimensionText(review)}；只圈出需核对的范围，` +
          "未启动修复、新任务或外部调用"}
    </p>}
    {reviewError !== null && <p className="helper-text" role="alert"
      data-testid="daily-continuation-review-failed">
      轻量核对未完成：{reviewError}；不显示「无变化」结论。</p>}
    <details className="daily-continuation-details">
      <summary>变化明细与当前事实</summary>
      <p className="helper-text">State v{projection.current.stateRevision} · 接续投影 v{projection.revision}
        {baseline !== null && <> · 上次确认于 {new Date(baseline.confirmedAt).toLocaleString("zh-CN")}</>}</p>
      {baseline !== null && projection.delta !== null && <dl className="daily-continuation-delta"
        data-testid="daily-continuation-delta">
        <div><dt>阶段</dt><dd>{projection.delta.phaseChanged
          ? `${phaseLabel(projection.delta.phaseBefore ?? "") || "未设置"} → ${phaseLabel(projection.delta.phaseAfter ?? "") || "未设置"}`
          : "未变化"}</dd></div>
        <div><dt>下一步</dt><dd>{projection.delta.nextActionChanged
          ? `${projection.delta.nextActionBefore ?? "未指定"} → ${projection.delta.nextActionAfter ?? "未指定"}`
          : "未变化"}</dd></div>
        <div><dt>新增任务</dt><dd>{projection.delta.openTasksUnknown
          ? "任务较多，本次未逐项比对"
          : projection.delta.newOpenTaskIds.length === 0 ? "无"
            : projection.delta.newOpenTaskIds.join("、")}</dd></div>
        <div><dt>关闭任务</dt><dd>{projection.delta.openTasksUnknown
          ? "任务较多，本次未逐项比对"
          : projection.delta.closedTaskIds.length === 0 ? "无"
            : projection.delta.closedTaskIds.join("、")}</dd></div>
        <div><dt>未决阻塞</dt><dd>{projection.delta.unresolvedBlockerCountChanged ? "计数有变化" : "未变化"}</dd></div>
      </dl>}
      {baseline !== null && projection.delta === null &&
        <p className="helper-text">服务端本次没有给出相对基线的变化明细；以上计数仍是当前事实。</p>}
      <p className="helper-text">在途与未决：进行中任务 {projection.current.openTaskCount} ·
        {" "}等待验收 {projection.current.waitingTaskCount} ·
        {" "}阻塞 {projection.current.blockedTaskCount} ·
        {" "}未决阻塞 {projection.current.unresolvedBlockerCount}</p>
    </details>
    {confirmState === "failed" && <button className="text-link" type="button"
      data-testid="daily-continuation-confirm-retry"
      onClick={() => {
        if (presentation === null) return;
        void confirmOnce(presentation);
      }}>查看进度未确认，点击确认</button>}
  </section>;
}
