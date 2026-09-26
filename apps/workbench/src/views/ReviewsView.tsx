import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { RotateCcw } from "lucide-react";
import { createCommandId, RelayApiError, RelayTransportError, type RelayReview, type RelayReviewDecision } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { liveClient, useRelayConnection } from "../lib/relayConnection";

const kindLabels: Record<RelayReview["kind"], string> = { CRITERION: "人工验收", RETRY_BUDGET: "修正预算", CHECKER_RETRY: "检查器重试", ACTION_APPROVAL: "动作批准", STATE_PROPOSAL: "项目状态提案" };
const decisionLabels: Record<RelayReviewDecision, string> = { ACCEPT: "接受这项判断", REQUEST_CHANGES: "请求修改", SET_RETRY_BUDGET: "设置修正预算", RETRY_CHECKS: "重新运行检查", APPROVE: "批准这项动作", DENY: "拒绝这项请求" };
const reasonLabels: Record<string, string> = { CORRECTION_BUDGET_EXHAUSTED: "修正预算已用尽，需要你决定是否增加上限。", CHECKER_UNAVAILABLE: "检查器持续不可用，需要你决定是否重新运行检查。", AWAITING_HUMAN_EVIDENCE: "必需验收条件需要你的判断。", UNCERTAIN_REQUIRES_HUMAN: "检查结果不确定，需要你判断这项验收条件。" };
const fieldLabels: Record<string, string> = { artifact_version_id: "产物版本 ID", content_hash: "内容摘要", acceptance_revision: "验收版本", criterion_id: "验收条件 ID", session_id: "验证会话 ID", operation_id: "动作 ID", action_type: "动作类型", normalized_target: "动作目标", params_hash: "参数摘要", base_revision: "项目状态基线版本", typed_changes: "建议修改", check_plan_hash: "检查计划摘要" };
const preview: RelayReview = { id: "sample-review", kind: "CRITERION", status: "OPEN", revision: "1", projectId: "sample-project", taskId: "sample-task", runId: "sample-run", reason: "需要你判断候选产物是否满足必需验收条件。", targetHash: "示例摘要", target: { artifact_version_id: "示例产物 v3", acceptance_revision: "2", criterion_id: "human-1" }, evidence: { check_result: "自动检查无法代替人工判断" }, effect: { on_accept: "保存人工判断后重新核对完成条件", on_request_changes: "按原验收契约继续修正" }, allowedDecisions: ["ACCEPT", "REQUEST_CHANGES"], expiresAt: null, createdAt: "2026-09-23T00:00:00.000Z", decidedAt: null };
function reasonText(reason: string) { return reasonLabels[reason] ?? reason; }
function summary(review: RelayReview) { const version = review.target.artifact_version_id; if (typeof version === "string") return `产物版本 ${version}`; const target = review.target.normalized_target; return typeof target === "string" ? target : reasonText(review.reason); }
function displayValue(value: unknown) { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value); }
function fieldLabel(key: string) { return fieldLabels[key] ?? key.replaceAll("_", " "); }

export default function ReviewsView() {
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const selectedId = query.get("id");
  const connection = useRelayConnection();
  const live = connection.mode === "live";
  const [reviews, setReviews] = useState<readonly RelayReview[]>([]);
  const [selected, setSelected] = useState<RelayReview | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receiptMessage, setReceiptMessage] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [retryBudget, setRetryBudget] = useState(2);
  const [pendingCommand, setPendingCommand] = useState<{ reviewId: string; commandId: string; decision: RelayReviewDecision } | null>(null);
  const [projectArchivedAt, setProjectArchivedAt] = useState<string | null | undefined>(undefined);
  const [projectReadError, setProjectReadError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  async function load() {
    const version = ++requestVersion.current;
    if (!selectedRef.current) setLoading(true); else setRefreshing(true);
    setError(null); setProjectArchivedAt(undefined); setProjectReadError(null);
    try {
      if (!live) { setReviews([preview]); setSelected(preview); selectedRef.current = preview; setProjectArchivedAt(null); return; }
      const client = connection.client; if (!client) throw new Error("本机 API 连接已失效，请重新连接后读取待审请求。");
      const items = await client.getReviews();
      const previousId = selectedRef.current?.id === "sample-review" ? null : selectedRef.current?.id ?? null;
      const reviewId = selectedId ?? previousId ?? items[0]?.id ?? null;
      const detail = reviewId ? await client.getReview(reviewId) : null;
      let archivedAt: string | null | undefined = null;
      let projectFailure: string | null = null;
      if (detail?.projectId) {
        archivedAt = undefined;
        try {
          if (detail.taskId) { const task = await client.getTask(detail.taskId); if (task.id !== detail.taskId || task.projectId !== detail.projectId) throw new RelayTransportError("Review 的 Task 与 Project 归属不匹配。"); }
          const project = await client.getProject(detail.projectId);
          if (project.id !== detail.projectId) throw new RelayTransportError("Project 读取结果与 Review 归属不匹配。");
          archivedAt = project.archivedAt;
        } catch (caught) { projectFailure = describeLiveError(caught).message; }
      }
      if (version !== requestVersion.current) return;
      setReviews(items); setSelected(detail); selectedRef.current = detail; setProjectArchivedAt(archivedAt); setProjectReadError(projectFailure);
      if (detail?.kind === "RETRY_BUDGET") { const currentLimit = Number(detail.evidence.limit); setRetryBudget(Number.isInteger(currentLimit) ? Math.min(6, currentLimit + 1) : 3); }
    } catch (caught) { if (version === requestVersion.current) setError(describeLiveError(caught).message); }
    finally { if (version === requestVersion.current) { setLoading(false); setRefreshing(false); } }
  }
  useEffect(() => { setSelected(null); selectedRef.current = null; setProjectArchivedAt(undefined); setProjectReadError(null); void load(); return () => { requestVersion.current++; }; }, [live, selectedId, connection.client]);
  function selectReview(reviewId: string) { setActionError(null); setReceiptMessage(null); setFeedback(""); navigate(`/reviews?id=${encodeURIComponent(reviewId)}`); }
  async function decide(decision: RelayReviewDecision) {
    const review = selected; const client = liveClient();
    if (!live || !client || !review || (selectedId !== null && review.id !== selectedId) || projectWriteBlockedReason !== null || !review.allowedDecisions.includes(decision) || pendingCommand || submitting) return;
    setActionError(null); setReceiptMessage(null);
    const note = feedback.trim();
    if (decision === "REQUEST_CHANGES" && !note) { setActionError("请求修改时请说明需要调整的内容。"); return; }
    if (decision === "SET_RETRY_BUDGET" && (!Number.isInteger(retryBudget) || retryBudget < 1 || retryBudget > 6)) { setActionError("修正预算须为 1 到 6 之间的整数。"); return; }
    const commandId = createCommandId(); setPendingCommand({ reviewId: review.id, commandId, decision }); setSubmitting(true);
    try { await client.decideReview({ reviewId: review.id, commandId, expectedRevision: review.revision, targetHash: review.targetHash, decision, ...(note ? { feedback: note } : {}), ...(decision === "SET_RETRY_BUDGET" ? { retryBudget } : {}) }); setPendingCommand(null); setReceiptMessage("决定已保存。请查看最新状态；动作批准不表示动作已经执行。"); await load(); }
    catch (caught) { if (caught instanceof RelayTransportError) setActionError("响应丢失或回执无法核对，提交结果待核对。请查询原命令回执，不要重新提交新命令。"); else { setPendingCommand(null); setActionError(describeLiveError(caught).message); if (caught instanceof RelayApiError && ["REVIEW_TARGET_CHANGED", "REVIEW_EXPIRED", "REVISION_CONFLICT"].includes(caught.problem.code)) await load(); } }
    finally { setSubmitting(false); }
  }
  async function checkReceipt() {
    const pending = pendingCommand; const client = liveClient(); if (!pending || !client || submitting) return;
    setSubmitting(true);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      const result = receipt.result;
      if (receipt.commandId !== pending.commandId || receipt.commandType !== "ResolveReview" ||
          result.review_id !== pending.reviewId || result.decision !== pending.decision ||
          typeof result.decision_id !== "string" || typeof result.revision !== "string" ||
          !/^\d+$/.test(result.revision)) throw new RelayTransportError("原命令回执与当前 Review 决定不匹配。");
      setPendingCommand(null); setActionError(null); setReceiptMessage("已核对原命令回执，正在读取最新待审状态。"); await load();
    } catch (caught) {
      setActionError(caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND"
        ? "尚未找到原命令回执，结果仍未确定。请稍后继续核对同一 command_id。"
        : caught instanceof RelayTransportError ? "原命令回执与当前 Review、决定或命令类型不匹配；结果仍未确定，请保留原 command_id。"
        : describeLiveError(caught).message);
    }
    finally { setSubmitting(false); }
  }
  const factRows = (value: Record<string, unknown>) => Object.entries(value).map(([key, item]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd>{displayValue(item)}</dd></div>);
  const projectWriteBlockedReason = !selected?.projectId ? null : (selectedId !== null && selected.id !== selectedId) || projectArchivedAt === undefined || loading || refreshing || error !== null
    ? `Project 事实正在核对或读取失败，不能提交新的 Review 决定。${projectReadError ?? ""}`
    : projectArchivedAt !== null ? "项目已归档，不能提交新的 Review 决定。" : null;
  return <section className="review-page" data-testid="review-inbox"><header className="review-heading"><div><p className="eyebrow">{live ? "真实待审" : "示例待审"}</p><h1>等待你的判断</h1><p className="page-lede">每条请求都绑定确切对象与版本。保存判断后，执行与完成状态仍以服务端最新事实为准。</p></div><button className="secondary-button" type="button" disabled={loading || refreshing} onClick={() => void load()}><RotateCcw aria-hidden="true" />{refreshing ? "正在更新" : "刷新"}</button></header>
    {!live && <p className="warning-callout">当前为只读示例。连接本机 API 后可处理真实 Review 请求。</p>}{error && <p className="action-error" role="alert">{error}</p>}{loading ? <p className="helper-text" role="status">正在读取待审请求…</p> : <div className="review-columns"><section className="review-list" aria-label="待审请求"><h2>待处理 <span>{reviews.length}</span></h2>{!reviews.length && <p className="helper-text">当前没有待处理请求。新的人工判断会在验证或动作准入需要时出现。</p>}{reviews.map((review) => <button key={review.id} className={`review-list-item${selected?.id === review.id ? " review-list-item--selected" : ""}`} type="button" aria-current={selected?.id === review.id ? "true" : undefined} onClick={() => selectReview(review.id)}><strong>{kindLabels[review.kind]}</strong><span>{summary(review)}</span><small>请求 v{review.revision} · {review.status === "OPEN" ? "待判断" : "已处理"}</small></button>)}</section>
      {selected && (selectedId === null || selected.id === selectedId) ? <article className="review-detail"><div className="review-detail-heading"><div><p className="eyebrow">{kindLabels[selected.kind]} · 请求 v{selected.revision}</p><h2>{reasonText(selected.reason)}</h2></div><span className={`status-chip status-chip--${selected.status === "OPEN" ? "warning" : "neutral"}`}>{selected.status === "OPEN" ? "待判断" : "已处理"}</span></div><p className="helper-text">请求 ID：{selected.id}</p>{selected.expiresAt && <p className="helper-text">有效期至：{selected.expiresAt}</p>}{selected.taskId && live && <p><Link className="text-link" to={`/tasks/${selected.taskId}`}>查看关联任务</Link></p>}
        <section className="review-fact-section"><h3>绑定对象</h3><dl className="review-facts">{factRows(selected.target)}<div><dt>请求目标摘要</dt><dd>{selected.targetHash}</dd></div></dl></section><section className="review-fact-section"><h3>判断依据</h3><dl className="review-facts">{factRows(selected.evidence)}</dl></section><section className="review-fact-section"><h3>可能影响</h3><dl className="review-facts">{factRows(selected.effect)}</dl></section>
        {selected.status === "OPEN" ? <div className="review-decision"><h3>作出决定</h3>{projectWriteBlockedReason && <p className="disabled-reason" data-testid="review-project-archive-reason">{projectWriteBlockedReason}</p>}<label className="field" htmlFor="review-feedback"><span className="field-label">说明</span><span className="field-hint">请求修改时必填；其他决定可留空。</span><textarea id="review-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={3} disabled={!live || submitting || pendingCommand !== null || projectWriteBlockedReason !== null} /></label>{selected.allowedDecisions.includes("SET_RETRY_BUDGET") && <label className="field" htmlFor="review-budget"><span className="field-label">新的修正预算</span><span className="field-hint">填写 1 到 6 次；服务端会重新核对当前已用次数。</span><input id="review-budget" value={retryBudget} onChange={(event) => setRetryBudget(Number(event.target.value))} type="number" min="1" max="6" step="1" disabled={!live || submitting || pendingCommand !== null || projectWriteBlockedReason !== null} /></label>}{actionError && <p className="action-error" role="alert">{actionError}</p>}{receiptMessage && <p className="receipt-message" role="status">{receiptMessage}</p>}{pendingCommand ? <button className="secondary-button" type="button" data-testid="review-check-receipt" disabled={submitting} onClick={() => void checkReceipt()}>核对原命令回执</button> : <div className="review-actions">{selected.allowedDecisions.map((decision) => <button key={decision} className={decision === "DENY" || decision === "REQUEST_CHANGES" ? "secondary-button" : "primary-button"} type="button" data-testid={`review-decision-${decision}`} disabled={!live || submitting || projectWriteBlockedReason !== null} onClick={() => void decide(decision)}>{submitting ? "正在保存" : decisionLabels[decision]}</button>)}</div>}{!live ? <p className="disabled-reason">示例数据不提交决定。连接本机 API 后再操作。</p> : !selected.allowedDecisions.length && <p className="disabled-reason">当前请求没有可用决定。请刷新核对有效性。</p>}</div> : <div className="review-decision"><p className="receipt-message" role="status">这条请求已有决定。历史判断保留；如需继续操作，请读取新的请求。</p>{receiptMessage && <p className="receipt-message" role="status">{receiptMessage}</p>}{pendingCommand?.reviewId === selected.id && <button className="secondary-button" type="button" data-testid="review-check-receipt" disabled={submitting} onClick={() => void checkReceipt()}>核对原命令回执</button>}{actionError && <p className="action-error" role="alert">{actionError}</p>}</div>}
      </article> : <div className="review-detail review-empty"><p>选择一条待审请求查看绑定对象、证据和可用决定。</p></div>}</div>}
  </section>;
}
