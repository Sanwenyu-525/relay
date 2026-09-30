import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Info, RotateCcw } from "lucide-react";
import ReviewDecisionPanel, { isReviewExpired, reviewReasonText, reviewSummary } from "../components/ReviewDecisionPanel";
import { RelayTransportError, type RelayReview } from "../api/relayClient";
import { reviewKindLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import "./ReviewsView.css";

const kindLabels = reviewKindLabels;
const preview: RelayReview = { id: "sample-review", kind: "CRITERION", status: "OPEN", revision: "1", projectId: "sample-project", taskId: "sample-task", runId: "sample-run", reason: "需要你判断候选产物是否满足必需验收条件。", targetHash: "示例摘要", target: { artifact_version_id: "示例产物 v3", acceptance_revision: "2", criterion_id: "human-1" }, evidence: { check_result: "自动检查无法代替人工判断" }, effect: { on_accept: "保存人工判断后重新核对完成条件", on_request_changes: "按原验收契约继续修正" }, allowedDecisions: ["ACCEPT", "REQUEST_CHANGES"], expiresAt: null, createdAt: "2026-09-23T00:00:00.000Z", decidedAt: null };

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
  const [error, setError] = useState<string | null>(null);
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
    } catch (caught) { if (version === requestVersion.current) setError(describeLiveError(caught).message); }
    finally { if (version === requestVersion.current) { setLoading(false); setRefreshing(false); } }
  }
  useEffect(() => { setSelected(null); selectedRef.current = null; setProjectArchivedAt(undefined); setProjectReadError(null); void load(); return () => { requestVersion.current++; }; }, [live, selectedId, connection.client]);
  function selectReview(reviewId: string) { navigate(`/reviews?id=${encodeURIComponent(reviewId)}`); }

  const projectWriteBlockedReason = !selected?.projectId ? null : (selectedId !== null && selected.id !== selectedId) || projectArchivedAt === undefined || loading || refreshing || error !== null
    ? `Project 事实正在核对或读取失败，不能提交新的 Review 决定。${projectReadError ?? ""}`
    : projectArchivedAt !== null ? "项目已归档，不能提交新的 Review 决定。" : null;

  return <section className="review-page" data-testid="review-inbox"><header className="review-heading"><div><p className="eyebrow">{live ? "真实待审" : "示例待审"}</p><h1>等待你的判断</h1><p className="page-lede">每条请求都绑定确切对象与版本。保存判断后，执行与完成状态仍以服务端最新事实为准。</p></div><button className="secondary-button" type="button" disabled={loading || refreshing} onClick={() => void load()}><RotateCcw aria-hidden="true" />{refreshing ? "正在更新" : "刷新"}</button></header>
    {!live && <p className="warning-callout">当前为只读示例。连接本机 API 后可处理真实 Review 请求。</p>}{error && <p className="action-error" role="alert">{error}</p>}{loading ? <p className="helper-text" role="status">正在读取待审请求…</p> : <div className="review-columns"><section className="review-list" aria-label="待审请求"><h2>待处理 <span>{reviews.length}</span></h2>{!reviews.length ? <p className="helper-text">当前没有待处理请求。通知和刷新都不会自动制造待审请求；只有验证或动作准入确实需要人工判断时，才会在这里出现新请求。</p> : <p className="helper-text">逐项判断：每条请求都要在查看绑定对象与证据后单独作出一个明确决定。列表不提供批量批准，也不能绕过证据自动接受。</p>}{reviews.map((review) => <button key={review.id} className={`review-list-item${selected?.id === review.id ? " review-list-item--selected" : ""}`} type="button" aria-current={selected?.id === review.id ? "true" : undefined} onClick={() => selectReview(review.id)}><strong>{kindLabels[review.kind]}</strong><span>{reviewSummary(review)}</span><small>请求 v{review.revision} · {review.status === "OPEN" ? isReviewExpired(review) ? "已过期" : "待判断" : "已处理"}</small></button>)}</section>
      {selected && (selectedId === null || selected.id === selectedId) ? <article className="review-detail" aria-label="所选待审请求详情"><div className="review-detail-heading"><div><p className="eyebrow">{kindLabels[selected.kind]} · 请求 v{selected.revision}</p><h2>{reviewReasonText(selected.reason)}</h2></div><span className={`status-chip status-chip--${selected.status === "OPEN" ? "warning" : "neutral"}`}>{selected.status === "OPEN" ? "待判断" : "已处理"}</span></div><p className="helper-text">请求 ID：<code className="hash-code">{selected.id}</code></p>{selected.expiresAt && <p className="helper-text">有效期至：{selected.expiresAt}</p>}{selected.taskId && live && <p><Link className="text-link" to={`/tasks/${selected.taskId}`}>查看关联任务</Link></p>}
        <ReviewDecisionPanel live={live} review={selected} writeBlockedReason={projectWriteBlockedReason}
          busy={loading || refreshing} onRefresh={load} />
      </article> : <div className="review-detail review-empty" role="status"><p className="helper-text"><Info aria-hidden="true" /> 选择一条待审请求查看绑定对象、证据和可用决定。</p></div>}</div>}
  </section>;
}
