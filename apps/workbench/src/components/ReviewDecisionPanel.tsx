import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { createCommandId, RelayApiError, RelayTransportError,
  type RelayReview, type RelayReviewDecision } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient } from "../lib/relayConnection";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";

export const reviewDecisionLabels: Record<RelayReviewDecision, string> = {
  ACCEPT: "接受这项判断", REQUEST_CHANGES: "请求修改", SET_RETRY_BUDGET: "设置修正预算",
  RETRY_CHECKS: "重新运行检查", APPROVE: "批准这项动作", DENY: "拒绝这项请求"
};
const reasonLabels: Record<string, string> = {
  CORRECTION_BUDGET_EXHAUSTED: "修正预算已用尽，需要你决定是否增加上限。",
  CHECKER_UNAVAILABLE: "检查器持续不可用，需要你决定是否重新运行检查。",
  AWAITING_HUMAN_EVIDENCE: "必需验收条件需要你的判断。",
  UNCERTAIN_REQUIRES_HUMAN: "检查结果不确定，需要你判断这项验收条件。"
};
const fieldLabels: Record<string, string> = {
  artifact_version_id: "产物版本 ID", content_hash: "内容摘要", acceptance_revision: "验收版本",
  criterion_id: "验收条件 ID", session_id: "验证会话 ID", operation_id: "动作 ID", action_type: "动作类型",
  normalized_target: "动作目标", params_hash: "参数摘要", base_revision: "项目状态基线版本",
  typed_changes: "建议修改", check_plan_hash: "检查计划摘要", permission_version: "权限版本",
  permission_revision: "权限修订", gateway_connection_id: "连接 ID", resource_id: "受管资源 ID",
  changeset_id: "变化集 ID", changeset_version: "变化集版本", changeset_hash: "变化集摘要",
  diff_hash: "差异摘要", repository: "仓库", branch: "分支", commit_message: "提交信息", current_revision: "当前版本"
};

export function reviewReasonText(reason: string): string { return reasonLabels[reason] ?? reason; }
export function reviewSummary(review: RelayReview): string {
  const version = review.target.artifact_version_id;
  if (typeof version === "string") return `产物版本 ${version}`;
  const target = review.target.normalized_target;
  return typeof target === "string" ? target : reviewReasonText(review.reason);
}
export function isReviewExpired(review: RelayReview): boolean {
  if (review.status !== "OPEN" || !review.expiresAt) return false;
  const at = Date.parse(review.expiresAt);
  return Number.isFinite(at) && at <= Date.now();
}
export function reviewStaleDecisionReason(code: string): string | null {
  if (code === "REVIEW_TARGET_CHANGED") return "动作内容或目标已经变化，这次批准对新的目标无效。已重新读取最新请求，请对新版本重新判断——刷新不会自动批准。";
  if (code === "REVIEW_EXPIRED") return "这项请求已超过有效期，批准已失效。已重新读取最新状态，请对仍然有效的请求重新判断。";
  if (code === "PERMISSION_REVOKED" || code === "PERMISSION_DENIED_FOR_ACTION" || code === "SCOPE_NOT_ALLOWED") return "执行这项动作所需的权限已被撤销或收紧，未执行的批准必须拒绝。已重新读取最新状态。";
  if (code === "REVISION_CONFLICT") return "这条请求的版本已经变化（可能已被其他入口处理）。本次决定未提交，已重新读取最新状态。";
  return null;
}
function displayValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
}
function fieldLabel(key: string): string { return fieldLabels[key] ?? key.replaceAll("_", " "); }
function factRows(value: Record<string, unknown>) {
  return Object.entries(value).map(([key, item]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd>{displayValue(item)}</dd></div>);
}

export interface ReviewNavigationState {
  readonly reviewId: string;
  readonly pendingCommandId: string | null;
  readonly dirty: boolean;
}
export interface ReviewDecisionPanelProps {
  live: boolean;
  review: RelayReview;
  /** 非 null 时表示当前作用域/归档/加载状态不允许提交决定。 */
  writeBlockedReason: string | null;
  busy?: boolean;
  onRefresh: () => void | Promise<void>;
  compact?: boolean;
  /** 父级已核对验收版本与条件 ID 后提供的只读条件正文。 */
  criterionStatement?: string | null;
  onNavigationStateChange?: (state: ReviewNavigationState) => void;
}

/**
 * Review 决定的唯一写路径：待审页与协作工作区共用。
 * 过期、归档、修订与目标摘要四道栅栏集中在这里，任一入口都不会绕过。
 */
export default function ReviewDecisionPanel({ live, review, writeBlockedReason, busy = false, onRefresh, compact, criterionStatement, onNavigationStateChange }: ReviewDecisionPanelProps) {
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [retryBudget, setRetryBudget] = useState(() => {
    const limit = Number(review.evidence.limit);
    return Number.isInteger(limit) ? Math.min(6, limit + 1) : 3;
  });
  const [pendingCommand, setPendingCommand] = useState<{ reviewId: string; commandId: string; decision: RelayReviewDecision } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receiptMessage, setReceiptMessage] = useState<string | null>(null);
  const inFlightCommandId = useRef<string | null>(null);
  const guardState = useRef({ pendingCommand, submitting, feedback, live });
  guardState.current = { pendingCommand, submitting, feedback, live };
  const guard = useRef<DraftGuard>({
    hasUnsavedChanges: () => guardState.current.pendingCommand !== null || guardState.current.submitting ||
      guardState.current.live && guardState.current.feedback.trim().length > 0,
    pendingCommandId: () => guardState.current.pendingCommand?.commandId ?? inFlightCommandId.current,
    discard: () => {
      if (guardState.current.pendingCommand !== null || guardState.current.submitting) return;
      setFeedback(""); setActionError(null);
    }
  });
  useEffect(() => { setDraftGuard(guard.current); return () => clearDraftGuard(guard.current); }, []);
  useEffect(() => {
    if (guardState.current.pendingCommand !== null || guardState.current.submitting) return;
    setFeedback(""); setFeedbackOpen(false); setActionError(null); setReceiptMessage(null);
    const limit = Number(review.evidence.limit);
    setRetryBudget(Number.isInteger(limit) ? Math.min(6, limit + 1) : 3);
  }, [review.id]);
  useEffect(() => {
    onNavigationStateChange?.({ reviewId: review.id,
      pendingCommandId: pendingCommand?.commandId ?? inFlightCommandId.current,
      dirty: guard.current.hasUnsavedChanges() });
  }, [review.id, pendingCommand, submitting, feedback, live, onNavigationStateChange]);

  const expired = isReviewExpired(review);
  const expiredReason = expired ? "这项请求已超过有效期。为避免按列表缓存继续批准，决定按钮已停用；请刷新核对最新状态，再对仍然有效的请求重新判断。" : null;
  const decisionBlockedReason = writeBlockedReason ?? expiredReason;
  const showRejectNote = review.allowedDecisions.includes("DENY") || review.allowedDecisions.includes("REQUEST_CHANGES");

  async function decide(decision: RelayReviewDecision) {
    const client = liveClient();
    if (!client || !live || writeBlockedReason !== null || expired || !review.allowedDecisions.includes(decision) || pendingCommand || submitting) return;
    const note = feedback.trim();
    if (decision === "REQUEST_CHANGES" && !note) { setFeedbackOpen(true); setActionError("请求修改时请说明需要调整的内容。"); return; }
    if (decision === "SET_RETRY_BUDGET" && (!Number.isInteger(retryBudget) || retryBudget < 1 || retryBudget > 6)) {
      setActionError("修正预算须为 1 到 6 之间的整数。"); return;
    }
    const commandId = createCommandId();
    inFlightCommandId.current = commandId;
    setPendingCommand({ reviewId: review.id, commandId, decision }); setSubmitting(true); setActionError(null); setReceiptMessage(null);
    try {
      await client.decideReview({ reviewId: review.id, commandId, expectedRevision: review.revision,
        targetHash: review.targetHash, decision, ...(note ? { feedback: note } : {}),
        ...(decision === "SET_RETRY_BUDGET" ? { retryBudget } : {}) });
      setPendingCommand(null);
      setFeedback("");
      setReceiptMessage("决定已保存。请查看最新状态；动作批准不表示动作已经执行。");
      await onRefresh();
    } catch (caught) {
      if (caught instanceof RelayTransportError) setActionError("响应丢失或回执无法核对，提交结果待核对。请查询原命令回执，不要重新提交新命令。");
      else {
        setPendingCommand(null);
        const stale = caught instanceof RelayApiError ? reviewStaleDecisionReason(caught.problem.code) : null;
        if (stale) { setActionError(stale); await onRefresh(); }
        else {
          setActionError(describeLiveError(caught).message);
          if (caught instanceof RelayApiError && caught.problem.code === "REVIEW_TARGET_CHANGED") await onRefresh();
        }
      }
    } finally { inFlightCommandId.current = null; setSubmitting(false); }
  }

  async function checkReceipt() {
    const pending = pendingCommand; const client = liveClient();
    if (!client || !pending || submitting) return;
    inFlightCommandId.current = pending.commandId;
    setSubmitting(true);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      const result = receipt.result;
      if (receipt.commandId !== pending.commandId || receipt.commandType !== "ResolveReview" ||
          result.review_id !== pending.reviewId || result.decision !== pending.decision ||
          typeof result.decision_id !== "string" || typeof result.revision !== "string" || !/^\d+$/.test(result.revision)) {
        throw new RelayTransportError("原命令回执与当前 Review 决定不匹配。");
      }
      setPendingCommand(null); setFeedback(""); setActionError(null);
      setReceiptMessage("已核对原命令回执，正在读取最新待审状态。");
      await onRefresh();
    } catch (caught) {
      setActionError(caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND"
        ? "尚未找到原命令回执，结果仍未确定。请稍后继续核对同一 command_id。"
        : caught instanceof RelayTransportError ? "原命令回执与当前 Review、决定或命令类型不匹配；结果仍未确定，请保留原 command_id。"
        : describeLiveError(caught).message);
    } finally { inFlightCommandId.current = null; setSubmitting(false); }
  }

  const feedbackField = <label className="field" htmlFor={`review-feedback-${review.id}`}><span className="field-label">说明</span>
    <span className="field-hint">请求修改时必填；其他决定可留空。</span>
    <textarea id={`review-feedback-${review.id}`} value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={compact ? 2 : 3}
      disabled={!live || submitting || pendingCommand !== null || decisionBlockedReason !== null} /></label>;

  const facts = <>
    <section className="review-fact-section"><h3>判断依据</h3><dl className="review-facts">{factRows(review.evidence)}</dl></section>
    <section className="review-fact-section"><h3>可能影响</h3>{Object.keys(review.effect).length ? <dl className="review-facts">{factRows(review.effect)}</dl> : <p className="helper-text">服务端没有提供这项决定的影响说明；未知影响不做推测。有依据的延后影响只在这里如实列出，不作为催促，也不代表可以延后必需项。</p>}</section>
    {compact && showRejectNote && <p className="helper-text">拒绝或请求修改只记录判断，不等于执行失败，也不会自动结束执行或转移执行权。</p>}
  </>;
  const targetConditions = Object.fromEntries(Object.entries(review.target).filter(([key]) =>
    ["acceptance_revision", "criterion_id", "action_type", "normalized_target"].includes(key))
    .map(([key, value]) => compact && key === "criterion_id" && criterionStatement?.trim()
      ? ["验收条件", criterionStatement] : [key, value]));

  if (review.status !== "OPEN") return <div className="review-decision">
    <p className="receipt-message" role="status">这条请求已有决定。历史判断保留；如需继续操作，请读取新的请求。</p>
    {receiptMessage && <p className="receipt-message" role="status">{receiptMessage}</p>}
    {pendingCommand?.reviewId === review.id &&
      <button className="secondary-button" type="button" data-testid="review-check-receipt" disabled={submitting} onClick={() => void checkReceipt()}>核对原命令回执</button>}
    {actionError && <p className="action-error" role="alert">{actionError}</p>}
  </div>;

  return <div className={`review-decision${compact ? " review-decision--compact" : ""}`} data-testid="review-decision" data-review-kind={review.kind}>
    <div className="review-bound-summary" data-testid="review-bound-summary"><h3>判断对象与条件</h3>
      <p>{typeof review.target.artifact_version_id === "string"
        ? compact ? <Link className="inline-link" to={`/artifact-versions/${review.target.artifact_version_id}/lineage`}
          title={`产物版本 ${review.target.artifact_version_id}`}>确切版本 · {review.target.artifact_version_id.slice(0, 8)}…</Link>
          : "所引用的确切产物版本" : reviewSummary(review)}</p>
      <dl className="review-facts">{factRows(targetConditions)}</dl>
    </div>
    {compact ? <>{review.kind === "ACTION_APPROVAL" && facts}
      {review.kind !== "ACTION_APPROVAL" && <p className="review-impact-summary helper-text">{typeof review.effect.on_accept === "string" ? `接受后：${review.effect.on_accept}` : "保存判断后核对服务端影响；执行与完成分别确认。"}</p>}</>
      : <>{facts}<details className="review-evidence-details"><summary>核对绑定对象与技术身份</summary><section className="review-fact-section"><h3>绑定对象</h3><dl className="review-facts">{factRows(review.target)}<div><dt>请求目标摘要</dt><dd>{review.targetHash}</dd></div></dl></section></details></>}
    {!compact && <h3>作出决定</h3>}
    {writeBlockedReason && <p className="disabled-reason" data-testid="review-project-archive-reason">{writeBlockedReason}</p>}
    {!writeBlockedReason && expired && <p className="disabled-reason" data-testid="review-expired-reason">{expiredReason}
      <button className="text-link" type="button" data-testid="review-expired-refresh" disabled={busy || submitting} onClick={() => void onRefresh()}>刷新核对最新状态</button></p>}
    {compact ? <div className="review-details-row">
      <details className="review-evidence-details"><summary>查看依据与绑定对象</summary>{review.kind !== "ACTION_APPROVAL" && facts}<section className="review-fact-section"><h3>绑定对象</h3><dl className="review-facts">{factRows(review.target)}<div><dt>请求目标摘要</dt><dd>{review.targetHash}</dd></div></dl></section></details>
      <details className="review-feedback-details" open={feedbackOpen}
        onToggle={(event) => setFeedbackOpen(event.currentTarget.open)} data-testid="review-feedback-details">
        <summary>补充说明</summary>{feedbackField}
      </details>
    </div> : feedbackField}
    {review.allowedDecisions.includes("SET_RETRY_BUDGET") && <label className="field" htmlFor={`review-budget-${review.id}`}>
      <span className="field-label">新的修正预算</span><span className="field-hint">填写 1 到 6 次；服务端会重新核对当前已用次数。</span>
      <input id={`review-budget-${review.id}`} value={retryBudget} onChange={(event) => setRetryBudget(Number(event.target.value))}
        type="number" min="1" max="6" step="1"
        disabled={!live || submitting || pendingCommand !== null || decisionBlockedReason !== null} /></label>}
    {actionError && <p className="action-error" role="alert">{actionError}</p>}
    {receiptMessage && <p className="receipt-message" role="status">{receiptMessage}</p>}
    {pendingCommand ? <button className="secondary-button" type="button" data-testid="review-check-receipt" disabled={submitting} onClick={() => void checkReceipt()}>核对原命令回执</button>
      : <div className="review-actions">{review.allowedDecisions.map((decision) => <button key={decision}
        className={decision === "DENY" || decision === "REQUEST_CHANGES" ? "secondary-button" : "primary-button"} type="button"
        data-testid={`review-decision-${decision}`} disabled={!live || submitting || decisionBlockedReason !== null}
        onClick={() => void decide(decision)}>{submitting ? "正在保存" : reviewDecisionLabels[decision]}</button>)}</div>}
    {!live ? <p className="disabled-reason">示例数据不提交决定。连接本机 API 后再操作。</p>
      : !review.allowedDecisions.length && <p className="disabled-reason">当前请求没有可用决定，可能因为你没有相应权限或请求已失效。请刷新核对有效性。</p>}
    {!compact && review.allowedDecisions.length > 0 && showRejectNote && <p className="helper-text">拒绝或请求修改只保存你的判断，不等于执行失败，也不会自动改变执行权或让 Run 直接失败。</p>}
    {review.kind === "ACTION_APPROVAL" && <p className="helper-text">批准只针对上面列出的这一个动作、目标与内容版本。批准本地 commit 不授权 push 或其他后续动作，也不支持输入任意命令；批准后以动作回执为准，不假设已经执行成功。</p>}
  </div>;
}
