import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Info, RotateCcw } from "lucide-react";
import ReviewDecisionPanel, { isReviewExpired, reviewReasonText } from "../components/ReviewDecisionPanel";
import ArtifactReaderPanel from "../components/ArtifactReaderPanel";
import { RelayTransportError, type RelayReview } from "../api/relayClient";
import { reviewKindLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import { useDisplayPreferences } from "../lib/displayPreferences";
import "./ReviewsView.css";

const kindLabels = reviewKindLabels;
const preview: RelayReview = { id: "sample-review", kind: "CRITERION", status: "OPEN", revision: "1", projectId: "sample-project", taskId: "sample-task", runId: "sample-run", reason: "需要你判断候选产物是否满足必需验收条件。", targetHash: "示例摘要", target: { artifact_version_id: "示例产物 v3", acceptance_revision: "2", criterion_id: "human-1" }, evidence: { check_result: "自动检查无法代替人工判断" }, effect: { on_accept: "保存人工判断后重新核对完成条件", on_request_changes: "按原验收契约继续修正" }, allowedDecisions: ["ACCEPT", "REQUEST_CHANGES"], expiresAt: null, createdAt: "2026-09-23T00:00:00.000Z", decidedAt: null };

export default function ReviewsView() {
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const selectedId = query.get("id");
  const connection = useRelayConnection();
  const live = connection.mode === "live";
  const { timeZone } = useDisplayPreferences();
  const [kind, setKind] = useState<RelayReview["kind"] | "ALL">(() => {
    const requested = query.get("kind");
    return requested && Object.hasOwn(kindLabels, requested) ? requested as RelayReview["kind"] : "ALL";
  });
  const [labels, setLabels] = useState<{ reviewId: string; projectTitle: string | null; targetTitle: string | null } | null>(null);
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
    setError(null); setLabels(null); setProjectArchivedAt(undefined); setProjectReadError(null);
    try {
      if (!live) { setReviews([preview]); setSelected(preview); selectedRef.current = preview; setProjectArchivedAt(null); return; }
      const client = connection.client; if (!client) throw new Error("本机 API 连接已失效，请重新连接后读取待审请求。");
      const items = await client.getReviews();
      const previousId = selectedRef.current?.id === "sample-review" ? null : selectedRef.current?.id ?? null;
      const reviewId = selectedId ?? previousId ?? items[0]?.id ?? null;
      const detail = reviewId ? await client.getReview(reviewId) : null;
      let archivedAt: string | null | undefined = null;
      let projectFailure: string | null = null;
      let projectTitle: string | null = null;
      let targetTitle: string | null = null;
      if (detail?.projectId) {
        archivedAt = undefined;
        try {
          if (detail.taskId) { const task = await client.getTask(detail.taskId); if (task.id !== detail.taskId || task.projectId !== detail.projectId) throw new RelayTransportError("Review 的 Task 与 Project 归属不匹配。"); }
          const project = await client.getProject(detail.projectId);
          if (project.id !== detail.projectId) throw new RelayTransportError("Project 读取结果与 Review 归属不匹配。");
          archivedAt = project.archivedAt;
          projectTitle = project.title;
        } catch (caught) { projectFailure = describeLiveError(caught).message; }
      }
      // 名称只来自确切目标的只读元数据，失败时保留原版本 ID，不影响决定的绑定身份。
      if (detail?.taskId && typeof detail.target.artifact_version_id === "string") {
        try {
          const artifacts = await client.getTaskArtifacts(detail.taskId);
          for (const artifact of artifacts.items) {
            if (artifact.taskId !== detail.taskId) continue;
            const boundVersion = artifact.versions.find((item) => item.artifactVersionId === detail.target.artifact_version_id);
            if (boundVersion) { targetTitle = `${artifact.title} v${boundVersion.versionNumber}`; break; }
          }
        } catch { /* 名称不可读取时继续显示服务端绑定的确切版本 ID。 */ }
      }
      if (version !== requestVersion.current) return;
      setReviews(items); setSelected(detail); selectedRef.current = detail; setProjectArchivedAt(archivedAt); setProjectReadError(projectFailure);
      setLabels(detail ? { reviewId: detail.id, projectTitle, targetTitle } : null);
    } catch (caught) { if (version === requestVersion.current) setError(describeLiveError(caught).message); }
    finally { if (version === requestVersion.current) { setLoading(false); setRefreshing(false); } }
  }
  useEffect(() => { setSelected(null); selectedRef.current = null; setProjectArchivedAt(undefined); setProjectReadError(null); void load(); return () => { requestVersion.current++; }; }, [live, selectedId, connection.client]);
  function selectReview(reviewId: string) {
    const selection = new URLSearchParams({ id: reviewId });
    if (kind !== "ALL") selection.set("kind", kind);
    navigate(`/reviews?${selection}`);
  }

  const projectWriteBlockedReason = loading || refreshing || error !== null || selectedId !== null && selected?.id !== selectedId
    ? "请求正在核对或读取失败，不能提交新的 Review 决定。"
    : !selected?.projectId ? null : projectArchivedAt === undefined
      ? `Project 事实正在核对或读取失败，不能提交新的 Review 决定。${projectReadError ?? ""}`
      : projectArchivedAt !== null ? "项目已归档，不能提交新的 Review 决定。" : null;

  const visibleReviews = kind === "ALL" ? reviews : reviews.filter((review) => review.kind === kind);
  const title = (review: RelayReview) => labels?.reviewId === review.id && labels.targetTitle
    ? labels.targetTitle : reviewReasonText(review.reason);
  const status = (review: RelayReview) => review.status === "OPEN"
    ? isReviewExpired(review) ? "已过期" : "待判断" : "已处理";
  const requestTime = (value: string) => Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("zh-CN", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value))
    : "时间不可读取";

  return <section className="review-page" data-testid="review-inbox"><div className="review-columns">
    <div className="review-primary">
      <header className="review-heading"><div><h1>等待你的判断</h1><p className="page-lede">{loading ? "正在核对请求" : `${reviews.length} 项请求 · 查看对象与依据后逐项处理`}</p></div><button className="secondary-button" type="button" disabled={loading || refreshing} onClick={() => void load()}><RotateCcw aria-hidden="true" />{refreshing ? "正在更新" : "刷新"}</button></header>
      {!live && <p className="warning-callout">当前为只读示例。连接本机 API 后可处理真实 Review 请求。</p>}
      {error && <p className="action-error" role="alert">{error}</p>}
      <section className="review-list" aria-label="待审请求">
        <nav className="review-filters" aria-label="请求类型">
          <button type="button" data-testid="review-filter-ALL" aria-pressed={kind === "ALL"} onClick={() => setKind("ALL")}>全部 <span>{reviews.length}</span></button>
          {(Object.keys(kindLabels) as RelayReview["kind"][]).filter((item) => reviews.some((review) => review.kind === item) || item === kind).map((item) =>
            <button key={item} type="button" data-testid={`review-filter-${item}`} aria-pressed={kind === item} onClick={() => setKind(item)}>{kindLabels[item]} <span>{reviews.filter((review) => review.kind === item).length}</span></button>)}
        </nav>
        {loading ? <p className="helper-text" role="status">正在读取待审请求…</p> : <>
          <div className="review-list-columns" aria-hidden="true"><span>请求事项</span><span>类型</span><span>所属项目</span><span>请求时间</span><span>当前状态</span></div>
          {!visibleReviews.length && <p className="helper-text">{reviews.length ? "当前类型没有待处理请求。" : "当前没有待处理请求。只有验证或动作准入确实需要人工判断时，才会出现新请求。"}</p>}
          {visibleReviews.map((review) => <button key={review.id} className={`review-list-item${selected?.id === review.id ? " review-list-item--selected" : ""}`} type="button" aria-current={selected?.id === review.id ? "true" : undefined} onClick={() => selectReview(review.id)}>
            <strong>{title(review)}<small>请求 v{review.revision}</small></strong>
            <span className="review-kind">{kindLabels[review.kind]}</span>
            <span className="review-project">{review.projectId === null ? "未归属项目" : labels?.projectTitle && selected?.projectId === review.projectId ? labels.projectTitle : "项目名称暂不可读"}</span>
            <time dateTime={review.createdAt}>{requestTime(review.createdAt)}</time>
            <span className={`status-chip status-chip--${review.status === "OPEN" && !isReviewExpired(review) ? "warning" : "neutral"}`}>{status(review)}</span>
          </button>)}
        </>}
      </section>
      {live && connection.client && selected?.taskId && typeof selected.target.artifact_version_id === "string" && !error && !loading && !refreshing && (selectedId === null || selected.id === selectedId) &&
        <section className="review-reading" aria-label="阅读判断对象" data-testid="review-bound-reader"><h2>判断对象</h2>
          <ArtifactReaderPanel key={`${connection.epoch}:${selected.id}:${selected.revision}`} client={connection.client} taskId={selected.taskId} projectId={selected.projectId}
            selectedVersionId={selected.target.artifact_version_id} draft={null} /></section>}
    </div>
    {selected && (selectedId === null || selected.id === selectedId) ? <article className="review-detail" aria-label="所选待审请求详情">
      <div className="review-detail-heading"><h2>为何需要你</h2><span className={`status-chip status-chip--${selected.status === "OPEN" && !isReviewExpired(selected) ? "warning" : "neutral"}`}>{status(selected)}</span></div>
      <p className="review-reason">{reviewReasonText(selected.reason)}</p>
      <dl className="review-request-facts"><div><dt>请求事项 · {kindLabels[selected.kind]}</dt><dd>{title(selected)}</dd></div><div><dt>请求时间</dt><dd><time dateTime={selected.createdAt}>{requestTime(selected.createdAt)}</time></dd></div></dl>
      <details className="review-request-identity"><summary>请求身份 · v{selected.revision}</summary><p className="helper-text">请求 ID：<code className="hash-code">{selected.id}</code> · 请求 v{selected.revision}</p>{selected.projectId && <p className="helper-text">Project ID：{selected.projectId}</p>}{selected.taskId && <p className="helper-text">Task ID：{selected.taskId}</p>}</details>
      {selected.expiresAt && <p className="helper-text">有效期至：{selected.expiresAt}</p>}
      {selected.taskId && live && <div className="form-actions"><Link className="text-link" to={`/tasks/${selected.taskId}?tab=artifacts`}>查看关联任务与产物</Link>{typeof selected.target.artifact_version_id === "string" && <Link className="text-link" to={`/artifact-versions/${selected.target.artifact_version_id}/lineage`}>核对版本来源</Link>}</div>}
      <ReviewDecisionPanel live={live} review={selected} writeBlockedReason={projectWriteBlockedReason}
        busy={loading || refreshing} onRefresh={load} />
      <details className="page-explanation"><summary>逐项判断的边界</summary><p className="helper-text">每条请求绑定自己的对象与依据，不能绕过证据自动接受。判断保存后，任务完成与执行权仍须分别核对。</p></details>
    </article> : <div className="review-detail review-empty" role="status"><h2>为何需要你</h2><p className="helper-text"><Info aria-hidden="true" /> 选择一条待审请求查看绑定对象、证据和可用决定。</p></div>}
  </div></section>;
}
