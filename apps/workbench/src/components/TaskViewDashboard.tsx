import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, FileText, Info, Pause, Play, Shield } from "lucide-react";
import { createCommandId, type RelayApiClient, type RelayArtifact, type RelayArtifactVersionSummary, type RelayReview, type RelayReviewDecision, type RelayRun, type RelayTaskArtifacts, type RelayTaskDetail } from "../api/relayClient";
import RunToolTrajectoryPanel from "./RunToolTrajectoryPanel";
import { type ReviewNavigationState, reviewReasonText } from "./ReviewDecisionPanel";
import { runLabels, stepLabels, stepStatusLabels } from "./RunControlPanel";
import { executorLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useDelayedVisible } from "../lib/useDelayedVisible";
import "./TaskViewDashboard.css";

export interface TaskViewDashboardProps {
  readonly client: RelayApiClient;
  readonly task: RelayTaskDetail;
  readonly run: RelayRun | null;
  readonly projectTitle: string | null;
  readonly reviews: readonly RelayReview[];
  readonly openReview: RelayReview | null;
  readonly reviewError: string | null;
  readonly reviewWriteBlockedReason: string | null;
  readonly projectWriteBlockedReason: string | null;
  readonly onReviewNavigationStateChange: (state: ReviewNavigationState) => void;
  readonly onRefresh: () => void;
  readonly onSelectFileForPreview: (artifact: RelayArtifact, version: RelayArtifactVersionSummary, trigger: HTMLButtonElement) => void;
  readonly onSwitchToChat: () => void;
  readonly onOpenInspector: () => void;
}

export default function TaskViewDashboard({
  client,
  task,
  run,
  reviews,
  openReview,
  reviewError,
  reviewWriteBlockedReason,
  onRefresh,
  onSelectFileForPreview,
  onSwitchToChat,
}: TaskViewDashboardProps) {
  const [subtab, setSubtab] = useState<"overview" | "activity" | "files">("overview");
  const [artifactRead, setArtifactRead] = useState<{ readonly taskId: string; readonly revision: RelayTaskDetail["revision"]; readonly status: "loading" | "ready" | "error";
    readonly value?: RelayTaskArtifacts; readonly error?: string }>({ taskId: task.id, revision: task.revision, status: "loading" });
  const [artifactReload, setArtifactReload] = useState(0);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setArtifactRead({ taskId: task.id, revision: task.revision, status: "loading" });
    void client.getTaskArtifacts(task.id).then((result) => {
      if (active) setArtifactRead({ taskId: task.id, revision: task.revision, status: "ready", value: result });
    }).catch((caught: unknown) => {
      if (active) setArtifactRead({ taskId: task.id, revision: task.revision, status: "error", error: describeLiveError(caught).message });
    });
    return () => { active = false; };
  }, [client, task.id, task.revision, artifactReload]);
  const currentArtifactRead = artifactRead.taskId === task.id && artifactRead.revision === task.revision
    ? artifactRead : { taskId: task.id, revision: task.revision, status: "loading" as const };
  /** 换任务时成果读取通常几十毫秒完成，加载提示延迟出现，避免「闪一下」（见 lib/useDelayedVisible）。 */
  const artifactsLoadingVisible = useDelayedVisible(currentArtifactRead.status === "loading");
  const artifacts = currentArtifactRead.status === "ready" ? currentArtifactRead.value : null;

  const totalSteps = run?.steps.length ?? 0;
  const completedSteps = run?.steps.filter((step) => step.status === "SUCCEEDED" || step.status === "SKIPPED").length ?? 0;
  const percentage = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : null;

  const isPaused = run?.status === "PAUSED";
  const isRunning = run?.status === "RUNNING";
  const isComplete = task.status === "DONE" && task.currentCompletionId !== null;
  const hasPendingApproval = reviews.length > 0;

  async function handleTogglePause() {
    if (!run || controlBusy) return;
    setControlBusy(true);
    setControlError(null);
    try {
      if (isPaused) {
        await client.resumeRun({
          runId: run.id,
          commandId: createCommandId(),
          expectedRunRevision: run.revision,
          expectedTaskRevision: task.revision
        });
      } else if (isRunning) {
        await client.requestRunControl({
          runId: run.id,
          commandId: createCommandId(),
          type: "PAUSE",
          expectedRunRevision: run.revision,
          expectedTaskRevision: task.revision
        });
      }
      onRefresh();
    } catch (caught) {
      setControlError(describeLiveError(caught).message);
    } finally {
      setControlBusy(false);
    }
  }

  const targetCriterionId = typeof openReview?.target["criterion_id"] === "string"
    ? openReview.target["criterion_id"]
    : null;

  const criterionStatement = openReview !== null && openReview.target["acceptance_revision"] === task.acceptance.acceptanceRevision
    ? task.acceptance.criteria.find((c) => c.criterionId === targetCriterionId)?.statement ?? null
    : null;

  return (
    <div className="task-dashboard-scroll" data-testid="task-dashboard-view">
      <div className="task-dashboard-inner">
        {/* 顶部状态条：若有审批 */}
        {hasPendingApproval && (
          <div className="task-notice" role="alert" data-testid="collab-approval-notice">
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
              <AlertTriangle aria-hidden="true" />
              <span>存在待判断事项；等待判断不等于已暂停，执行状态以当前 Run 事实为准。</span>
            </div>
            <button
              type="button"
              className="task-notice-action"
              onClick={() => {
                const el = document.getElementById("approvalCardSection");
                el?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            >
              立即处理 →
            </button>
          </div>
        )}

        {/* 顶部状态条：若已完成 */}
        {isComplete && (
          <div className="task-completed-banner" data-testid="collab-completed-card">
            <div className="task-completed-icon">
              <CheckCircle2 aria-hidden="true" size={24} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3>任务已完成</h3>
              <p>任务已有当前完成凭据，可查看本次接受的成果与记录。</p>
            </div>
            <button
              type="button"
              className="secondary-button secondary-button--compact"
              onClick={() => setSubtab("files")}
            >
              查看成果
            </button>
          </div>
        )}
        {task.status === "DONE" && task.currentCompletionId === null && (
          <p className="task-notice" role="status" data-testid="collab-completion-record-missing">
            Task 当前状态为已完成，但没有读取到当前 CompletionRecord；此处不显示正式完成凭据。
          </p>
        )}
        {run?.status === "COMPLETED" && task.status !== "DONE" && (
          <p className="helper-text" role="status" data-testid="collab-run-completed-task-open">
            Run 已结束；Task 尚未标记完成。Run 结束不等于任务完成或验收通过。
          </p>
        )}

        {/* 概览区：Hero + Metric */}
        <div className="task-overview-grid">
          <section className="task-hero-card">
            <div className="task-eyebrow">当前任务 / TASK OVERVIEW</div>
            <h2>{task.title}</h2>
            <p>{task.acceptance?.objective ?? "围绕会话归属、中文详情、条件编辑与桌面响应表现执行验收与协作。"}</p>
            <div className="task-hero-footer">
              <div className="task-agent-avatar">{executorLabels[task.executor]}</div>
              <span className="task-agent-status-text">
                {task.executor === "AI" ? "Relay Agent" : executorLabels[task.executor]} · {run ? (runLabels[run.status] ?? run.status) : (taskStatusLabels[task.status] ?? task.status)}
              </span>
              <span style={{ flex: 1 }} />
              {isRunning && (
                <button
                  type="button"
                  className="secondary-button secondary-button--compact"
                  disabled={controlBusy}
                  onClick={() => void handleTogglePause()}
                >
                  <Pause size={14} aria-hidden="true" /> 暂停任务
                </button>
              )}
              {isPaused && (
                <button
                  type="button"
                  className="secondary-button secondary-button--compact"
                  disabled={controlBusy}
                  onClick={() => void handleTogglePause()}
                >
                  <Play size={14} aria-hidden="true" /> 继续执行
                </button>
              )}
              <button
                type="button"
                className="secondary-button secondary-button--compact"
                onClick={onSwitchToChat}
              >
                进入对话
              </button>
            </div>
            {controlError && <p className="action-error" role="alert">{controlError}</p>}
          </section>

          <section className="task-metric-card">
            <div>
              <div className="task-eyebrow">Run 步骤计数</div>
              <div className="task-metric-stat">
                {percentage === null ? "—" : percentage}
                {percentage !== null && <span className="task-metric-unit">%</span>}
              </div>
              <div className="task-metric-sub">
                {totalSteps > 0 ? `${completedSteps} / ${totalSteps} 个 Run 步骤已结束` : "尚无步骤记录"}
              </div>
            </div>
            <div>
              {percentage !== null && <div className="task-progress-bar" role="progressbar" aria-label="Run 已结束步骤数量比例，不代表任务完成或验证通过"
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}
                aria-valuetext={`${completedSteps} / ${totalSteps} 个 Run 步骤已结束`}>
                <span style={{ width: `${percentage}%` }} />
              </div>}
              <div className="task-metric-status">
                <span style={{ height: 6, width: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
                <span>{isPaused ? "已暂停" : isRunning ? "Agent 正在执行" : taskStatusLabels[task.status] ?? task.status}</span>
              </div>
            </div>
          </section>
        </div>

        {/* 待确认操作卡片（Approval Card） */}
        {openReview !== null && (
          <section className="task-approval-card" id="approvalCardSection" data-testid="task-dashboard-approval">
            <div className="task-approval-title">
              <Shield aria-hidden="true" />
              <span>等待你确认一项操作</span>
            </div>
            <p>
              {criterionStatement ? `目标验收条件：${criterionStatement}` : reviewReasonText(openReview.reason)}
            </p>
            {targetCriterionId && (
              <div className="task-approval-detail-box">
                关联验收标准编号：{targetCriterionId}
              </div>
            )}
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
              <button
                type="button"
                className="primary-button primary-button--compact"
                disabled={Boolean(reviewWriteBlockedReason) || controlBusy}
                onClick={async () => {
                  if (controlBusy) return;
                  setControlBusy(true);
                  try {
                    const decision: RelayReviewDecision = openReview.allowedDecisions.includes("APPROVE") ? "APPROVE" : "ACCEPT";
                    await client.decideReview({
                      reviewId: openReview.id,
                      commandId: createCommandId(),
                      decision,
                      targetHash: openReview.targetHash,
                      expectedRevision: openReview.revision
                    });
                    onRefresh();
                  } catch (caught) {
                    setControlError(describeLiveError(caught).message);
                  } finally {
                    setControlBusy(false);
                  }
                }}
              >
                批准并继续
              </button>
              <button
                type="button"
                className="secondary-button secondary-button--compact"
                disabled={Boolean(reviewWriteBlockedReason) || controlBusy}
                onClick={async () => {
                  if (controlBusy) return;
                  setControlBusy(true);
                  try {
                    const decision: RelayReviewDecision = openReview.allowedDecisions.includes("DENY") ? "DENY" : "REQUEST_CHANGES";
                    await client.decideReview({
                      reviewId: openReview.id,
                      commandId: createCommandId(),
                      decision,
                      feedback: "从工作台任务视图拒绝",
                      targetHash: openReview.targetHash,
                      expectedRevision: openReview.revision
                    });
                    onRefresh();
                  } catch (caught) {
                    setControlError(describeLiveError(caught).message);
                  } finally {
                    setControlBusy(false);
                  }
                }}
              >
                拒绝
              </button>
            </div>
            {reviewWriteBlockedReason && <p className="disabled-reason" role="status">{reviewWriteBlockedReason}</p>}
            {reviewError && <p className="action-error" role="alert">{reviewError}</p>}
          </section>
        )}

        {/* 子页签（Subtabs） */}
        <div className="task-subtabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={subtab === "overview"}
            className={`task-subtab-btn ${subtab === "overview" ? "active" : ""}`}
            onClick={() => setSubtab("overview")}
          >
            执行计划
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subtab === "activity"}
            className={`task-subtab-btn ${subtab === "activity" ? "active" : ""}`}
            onClick={() => setSubtab("activity")}
          >
            工具记录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subtab === "files"}
            className={`task-subtab-btn ${subtab === "files" ? "active" : ""}`}
            onClick={() => setSubtab("files")}
          >
            交付成果 {artifacts?.items.length ? `(${artifacts.items.length})` : ""}
          </button>
        </div>

        {/* 子页签 1: 执行计划 */}
        {subtab === "overview" && (
          <div>
            <div className="task-plan-list">
              {run?.steps.length ? (
                run.steps.map((step, idx) => {
                  const isDone = step.status === "SUCCEEDED";
                  const inProgress = step.status === "RUNNING";
                  return (
                    <div className="task-plan-row" key={step.id}>
                      <div className={`task-step-mark ${isDone ? "finished" : inProgress ? "progress" : ""}`}>
                        {isDone ? <CheckCircle2 size={13} /> : idx + 1}
                      </div>
                      <div className="task-plan-content">
                        <div className="task-plan-title">{stepLabels[step.kind] ?? step.kind}</div>
                        <div className="task-plan-desc">
                          {step.startedAt ? `开始时间：${new Date(step.startedAt).toLocaleTimeString()}` : "尚未开始"}
                        </div>
                      </div>
                      <div className="task-plan-right">
                        <span className="status-chip">{stepStatusLabels[step.status] ?? step.status}</span>
                      </div>
                    </div>
                  );
                })
              ) : task.acceptance?.criteria.length ? (
                task.acceptance.criteria.map((crit, idx) => (
                  <div className="task-plan-row" key={crit.criterionId}>
                    <div className="task-step-mark">{idx + 1}</div>
                    <div className="task-plan-content">
                      <div className="task-plan-title">{crit.statement}</div>
                      <div className="task-plan-desc">方法：{crit.method} · {crit.required ? "必选条件" : "可选条件"}</div>
                    </div>
                    <div className="task-plan-right">
                      <span className="status-chip">{taskStatusLabels[task.status] ?? task.status}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ padding: "1.5rem", color: "var(--relay-color-text-muted)", fontSize: "0.8125rem", textAlign: "center" }}>
                  当前任务尚未配置步骤或验收条件。
                </div>
              )}
            </div>
            <div className="task-subtle-callout">
              <Info size={15} />
              <span>步骤和执行日志会随 Agent 工作同步更新；可在工作详情中查看上下文。</span>
            </div>
          </div>
        )}

        {/* 子页签 2: 工具记录 */}
        {subtab === "activity" && (
          <div>
            <RunToolTrajectoryPanel
              client={client}
              run={run}
            />
          </div>
        )}

        {/* 子页签 3: 交付成果 */}
        {subtab === "files" && (
          <div>
            {currentArtifactRead.status === "loading" ? (
              artifactsLoadingVisible ? <p role="status" data-testid="collab-artifacts-loading">正在读取已保存成果…</p> : null
            ) : currentArtifactRead.status === "error" ? (
              <div role="alert" data-testid="collab-artifacts-error">
                <p>成果读取失败：{currentArtifactRead.error}</p>
                <button type="button" className="secondary-button" onClick={() => setArtifactReload((value) => value + 1)}>重新读取成果</button>
              </div>
            ) : artifacts?.items.length ? (
              <div className="task-files-grid">
                {artifacts.items.map((art) => {
                  const latestVersion = art.latestVersionId === null
                    ? undefined : art.versions.find((version) => version.artifactVersionId === art.latestVersionId);
                  return (
                    <button
                      type="button"
                      key={art.id}
                      className="task-file-card"
                      disabled={latestVersion === undefined}
                      title={latestVersion === undefined ? "这个成果尚无可读取版本" : `打开 ${art.title} v${latestVersion.versionNumber}`}
                      onClick={(event) => { if (latestVersion) onSelectFileForPreview(art, latestVersion, event.currentTarget); }}
                    >
                      <div className="task-file-icon">
                        <FileText size={18} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="task-file-name">{art.title}</div>
                        <div className="task-file-meta">
                          {latestVersion ? `版本 ${latestVersion.versionNumber} · ${latestVersion.mediaType}` : "无可读取版本"}
                        </div>
                      </div>
                      <ExternalLink size={14} style={{ color: "var(--relay-color-text-muted)" }} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: "2rem", textAlign: "center", color: "var(--relay-color-text-muted)", fontSize: "0.8125rem" }}>
                暂无已保存的成果文件。
              </div>
            )}
            <div className="task-preview-info-box">
              点击文件卡片可在工作详情中预览对应版本的正文。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
