import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Scale } from "lucide-react";
import ArtifactReaderPanel from "./ArtifactReaderPanel";
import ArtifactVersionCompare from "./ArtifactVersionCompare";
import DevToolsPanel from "./DevToolsPanel";
import ReviewDecisionPanel, { reviewReasonText, type ReviewNavigationState } from "./ReviewDecisionPanel";
import { runLabels, stepLabels, stepStatusLabels } from "./RunControlPanel";
import RunTracePanel from "./RunTracePanel";
import TaskCheckPlanPreview from "./TaskCheckPlanPreview";
import TaskCompletionPanel from "./TaskCompletionPanel";
import { describeLiveError } from "../lib/liveErrors";
import { reviewKindLabels } from "../lib/labels";
import { handleTabListKeyDown } from "../lib/tabNavigation";
import type { RelayApiClient, RelayArtifactLineage, RelayReview, RelayRun, RelayRunDraftPreview, RelayTaskDetail } from "../api/relayClient";
import "./WorkspaceReading.css";

export type WorkspaceSideTab = "DOCUMENT" | "CHECK" | "HISTORY";

const tabs: readonly (readonly [WorkspaceSideTab, string])[] = [
  ["DOCUMENT", "成果"], ["CHECK", "检查"], ["HISTORY", "历史"]
];

/**
 * 工作区右栏：文档、检查、版本历史三个页签共享同一个确切 Task。
 * 判断与完成跟着文档页签内联（效果图结构），执行事实与检查证据收在检查页签。
 * 这里不拥有业务状态，所有写入仍走既有命令路径。
 */
export default function WorkspaceSidePanel({ client, task, run, draft, tab, onTabChange,
  devToolsOpen, onCloseDevTools,
  reviews, reviewIndex, onReviewIndexChange, openReview, reviewError,
  reviewWriteBlockedReason, projectWriteBlockedReason, onReviewNavigationStateChange, onRefresh }: {
  client: RelayApiClient;
  task: RelayTaskDetail;
  run: RelayRun | null;
  draft: RelayRunDraftPreview | null;
  tab: WorkspaceSideTab;
  onTabChange: (next: WorkspaceSideTab) => void;
  devToolsOpen: boolean;
  onCloseDevTools: () => void;
  reviews: readonly RelayReview[];
  reviewIndex: number;
  onReviewIndexChange: (next: number) => void;
  openReview: RelayReview | null;
  reviewError: string | null;
  reviewWriteBlockedReason: string | null;
  projectWriteBlockedReason: string | null;
  onReviewNavigationStateChange: (state: ReviewNavigationState) => void;
  onRefresh: () => void;
}) {
  const tabId = useId();
  // 文档子树保持挂载，切换视图不能丢失判断草稿或待核对的原命令。
  const toolsVisible = devToolsOpen && task.projectId !== null;
  const judgment = openReview === null
        ? reviewError
          ? <p className="action-error" role="alert" data-testid="collab-judgment-error">{reviewError}</p>
          : <p className="helper-text" data-testid="collab-judgment-empty">暂无待判断事项。</p>
        : <section className="collab-judgment" data-testid="collab-judgment" data-review-kind={openReview.kind} tabIndex={-1} aria-label="等待你的判断">
            <div className="collab-judgment-heading">
              <h2><Scale aria-hidden="true" />等待你的判断</h2>
              {reviews.length > 1 && <details className="collab-review-picker"><summary>{reviewKindLabels[openReview.kind]} · {reviews.length} 项</summary><label><span className="visually-hidden">选择请求</span>
                <select data-testid="collab-review-select" value={String(reviewIndex)}
                  onChange={(event) => onReviewIndexChange(Number(event.target.value))}>
                  {reviews.map((review, index) => <option key={review.id} value={index}>{reviewKindLabels[review.kind]} · {reviewReasonText(review.reason)}</option>)}
                </select></label></details>}
              <details className="collab-judgment-context"><summary>执行权边界</summary>
                <p className="helper-text">判断不会暂停执行或转移执行权。</p></details>
            </div>
            <ReviewDecisionPanel live compact review={openReview} writeBlockedReason={reviewWriteBlockedReason}
              criterionStatement={openReview.target.acceptance_revision === task.acceptance.acceptanceRevision
                ? task.acceptance.criteria.find((criterion) => criterion.criterionId === openReview.target.criterion_id)?.statement ?? null : null}
              onNavigationStateChange={onReviewNavigationStateChange}
              onRefresh={onRefresh} />
          </section>;
  return <aside className="collab-side" aria-label={toolsVisible ? "文件与运行工具" : "产物与判断"} data-testid="collab-side" data-pane={toolsVisible ? "DEVTOOLS" : tab}>
    {toolsVisible && <DevToolsPanel client={client} projectId={task.projectId!} taskId={task.id} run={run} onClose={onCloseDevTools} />}
    <div className="collab-side-tabs" role="tablist" aria-label="成果、检查与历史" data-testid="collab-side-tabs" hidden={toolsVisible}
      onKeyDown={handleTabListKeyDown}>
      {tabs.map(([key, label]) => <button key={key} type="button"
        className={`collab-side-tab${tab === key ? " collab-side-tab--active" : ""}`}
        role="tab" id={`${tabId}-tab-${key}`} aria-controls={`${tabId}-panel-${key}`}
        aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} data-testid={`collab-side-tab-${key}`}
        onClick={() => onTabChange(key)}>{label}</button>)}
    </div>
    {!toolsVisible && tab !== "DOCUMENT" && openReview && <div className="collab-review-shortcut" data-testid="collab-review-shortcut">
      <p><Scale aria-hidden="true" /><strong>待判断：{reviewReasonText(openReview.reason)}</strong></p>
      <button className="secondary-button" type="button" aria-controls={`${tabId}-panel-DOCUMENT`}
        onClick={() => {
          onTabChange("DOCUMENT");
          window.requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="collab-judgment"]')?.focus());
        }}>查看依据与判断</button>
    </div>}

    <div className="collab-side-body" role="tabpanel" id={`${tabId}-panel-DOCUMENT`} aria-labelledby={`${tabId}-tab-DOCUMENT`}
      tabIndex={0} data-testid="collab-panel-DOCUMENT" hidden={tab !== "DOCUMENT" || toolsVisible}>
      <ArtifactReaderPanel compact client={client} taskId={task.id} projectId={task.projectId}
        selectedVersionId={typeof openReview?.target.artifact_version_id === "string" ? openReview.target.artifact_version_id : null}
        draft={draft} paperFooter={judgment} />
      <details className="collab-completion-details"><summary>检查与完成 · 独立确认</summary>
      <TaskCompletionPanel compact live onRefresh={onRefresh}
        target={{ taskId: task.id, taskStatus: task.status, taskRevision: task.revision,
          acceptanceRevision: task.acceptance.acceptanceRevision, allowedActions: task.allowedActions,
          criteria: task.acceptance.criteria, acceptedVersion: null, writeBlockedReason: projectWriteBlockedReason }} />
      <Link className="secondary-button" to={`/tasks/${task.id}?tab=artifacts`}>
        <ExternalLink aria-hidden="true" />打开任务产物与编辑</Link>
      </details>
    </div>

    <div className="collab-side-body" role="tabpanel" id={`${tabId}-panel-CHECK`} aria-labelledby={`${tabId}-tab-CHECK`}
      tabIndex={0} data-testid="collab-panel-CHECK" hidden={tab !== "CHECK" || toolsVisible}>
      {tab === "CHECK" && !toolsVisible && <><RunProgress run={run} />
      {run === null
        ? <p className="helper-text">当前任务没有 AI Run，因此没有可归属的运行事实；这不是"执行已完成"。</p>
        : <RunTracePanel client={client} runId={run.id} taskId={task.id} runRevision={run.revision} />}
      <TaskCheckPlanPreview client={client} taskId={task.id}
        taskRevision={task.revision} acceptanceRevision={task.acceptance.acceptanceRevision} />
      </>}
    </div>

    <div className="collab-side-body" role="tabpanel" id={`${tabId}-panel-HISTORY`} aria-labelledby={`${tabId}-tab-HISTORY`}
      tabIndex={0} data-testid="collab-panel-HISTORY" hidden={tab !== "HISTORY" || toolsVisible}>
      {tab === "HISTORY" && !toolsVisible && <VersionHistory client={client} taskId={task.id} />}
    </div>
  </aside>;
}

function RunProgress({ run }: { run: RelayRun | null }) {
  if (run === null) return null;
  const current = run.steps.find((step) => step.id === run.currentStepId) ?? null;
  return <section className="collab-run-progress" data-testid="collab-run-progress">
    <h3>执行进展</h3>
    <p className="helper-text">{runLabels[run.status] ?? run.status} · {current ? `${stepLabels[current.kind] ?? current.kind} / ${stepStatusLabels[current.status] ?? current.status}` : "尚无当前步骤"}</p>
    {!run.steps.length && <p className="helper-text">尚无步骤记录。</p>}
    <details><summary>查看 {run.steps.length} 个步骤与时间</summary><ol className="run-list">{run.steps.map((step) => <li key={step.id}>
      <strong>{step.index + 1}. {stepLabels[step.kind] ?? step.kind}</strong> · {stepStatusLabels[step.status] ?? step.status}
      {step.id === run.currentStepId && <> · 当前步骤</>}
      {step.reason !== null && <div className="helper-text">服务端给出的失败原因：{step.reason}</div>}
      <div className="helper-text">{step.startedAt ?? "未开始"} → {step.finishedAt ?? "未结束"}</div>
    </li>)}</ol><p className="helper-text">Run 修订 v{run.revision}；步骤与事件以服务端事实为准。</p></details>
    {run.waitReason && <p className="helper-text">等待原因：{run.waitReason}</p>}
    {run.pendingControlRequest && <p className="receipt-message" role="status">已提交控制请求 {run.pendingControlRequest.type} · {run.pendingControlRequest.status}，等待安全点处理；这不等于已经停止。</p>}
    {run.unresolvedOperationIds.length > 0 && <p className="warning-callout" role="status">有 {run.unresolvedOperationIds.length} 项动作结果未知或未结清（{run.unresolvedOperationIds.join("、")}）。先按原 operation_id 核对，不盲重试、不换身份。</p>}
    <Link className="text-link" to={`/runs/${run.id}`}>打开完整运行记录</Link>
  </section>;
}

/** 版本历史：逐个确切版本读取来源关系，缺失时如实显示不可用，不用最新版本替换。 */
function VersionHistory({ client, taskId }: { client: RelayApiClient; taskId: string }) {
  const [versions, setVersions] = useState<readonly { id: string; versionNumber: string; title: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [lineage, setLineage] = useState<RelayArtifactLineage | null>(null);
  const [lineageError, setLineageError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const lineageRequest = useRef(0);

  useEffect(() => {
    const version = ++request.current;
    lineageRequest.current++;
    setLoading(true); setError(null); setSelected(""); setLineage(null); setLineageError(null);
    void client.getTaskArtifacts(taskId).then((artifacts) => {
      if (version !== request.current) return;
      setVersions(artifacts.items.flatMap((artifact) => artifact.versions.map((item) =>
        ({ id: item.artifactVersionId, versionNumber: item.versionNumber, title: artifact.title }))));
    }, (caught: unknown) => {
      if (version === request.current) { setVersions([]); setError(describeLiveError(caught).message); }
    }).finally(() => { if (version === request.current) setLoading(false); });
    return () => { request.current++; lineageRequest.current++; };
  }, [client, taskId]);

  useEffect(() => {
    lineageRequest.current++;
    setLineage(null); setLineageError(null);
    if (!selected) return;
    const version = ++lineageRequest.current;
    void client.getArtifactLineage(selected).then((next) => {
      if (next.artifactVersionId !== selected) throw new Error("来源关系与所选版本不匹配。");
      if (version === lineageRequest.current) setLineage(next);
    }).catch((caught: unknown) => {
      if (version === lineageRequest.current) setLineageError(describeLiveError(caught).message);
    });
    return () => { lineageRequest.current++; };
  }, [client, selected]);

  if (loading) return <p className="helper-text" role="status">正在读取版本…</p>;
  if (error) return <p className="action-error" role="alert">{error}</p>;
  if (versions.length === 0) return <p className="helper-text">该任务还没有已保存的产物版本；没有历史不是读取失败。</p>;

  return <>
    <label className="field"><span className="field-label">选择一个确切版本</span>
      <select data-testid="collab-history-select" value={selected} onChange={(event) => setSelected(event.target.value)}>
        <option value="">请选择</option>
        {versions.map((item) => <option key={item.id} value={item.id}>v{item.versionNumber} · {item.title}</option>)}
      </select></label>
    {lineageError && <p className="action-error" role="alert">{lineageError}</p>}
    {lineage && <section className="collab-history-detail" data-testid="collab-history-detail">
      <p className="helper-text">v{lineage.versionNumber} · sha256 {lineage.sha256.slice(0, 12)}… · 来源 {lineage.sourceKind}
        · 正文 {lineage.contentAvailability === "AVAILABLE" ? "可读" : "不可用"}</p>
      {lineage.contentAvailability !== "AVAILABLE"
        ? <p className="helper-text">该版本正文当前不可用；不以最新版本替代，也不显示失效的历史正文。</p>
        : <ArtifactVersionCompare client={client} lineage={lineage} />}
      <Link className="text-link" to={`/artifact-versions/${lineage.artifactVersionId}/lineage`}>打开完整来源与历史</Link>
    </section>}
  </>;
}
