import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, Circle, Clock, FileText, Folder, Link2, Loader, Shield, Sparkles, X } from "lucide-react";
import type { RelayApiClient, RelayArtifact, RelayArtifactVersionSummary, RelayRun, RelayTaskArtifacts, RelayTaskDetail, RelayWorkingDirectory } from "../api/relayClient";
import SafeMarkdown from "./SafeMarkdown";
import { runLabels, stepLabels, stepStatusLabels } from "./RunControlPanel";
import { executorLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import "./TaskInspectorPanel.css";

export interface TaskInspectorPanelProps {
  readonly client: RelayApiClient;
  readonly task: RelayTaskDetail;
  readonly run: RelayRun | null;
  readonly projectTitle: string | null;
  readonly folder: RelayWorkingDirectory | null;
  readonly mode: string;
  readonly selectedArtifact: { readonly artifact: RelayArtifact; readonly version: RelayArtifactVersionSummary } | null;
  readonly onSelectArtifactVersion: (artifact: RelayArtifact, version: RelayArtifactVersionSummary, trigger: HTMLButtonElement) => void;
  readonly onCloseFilePreview: () => void;
  readonly onClose: () => void;
  readonly onSwitchToTask?: () => void;
  readonly isChatView?: boolean;
}

type InspectorTab = "PROGRESS" | "RESULTS" | "RECORDS";
/** 步骤符号的四态：与 V4.2 原型的 step-symbol 一一对应。 */
type StepState = "done" | "active" | "failed" | "waiting";

const inspectorTabs: readonly { readonly id: InspectorTab; readonly label: string }[] = [
  { id: "PROGRESS", label: "进展" },
  { id: "RESULTS", label: "成果" },
  { id: "RECORDS", label: "记录" }
];

/** 步骤状态只做「已执行/执行中/失败/待进行」四态映射；服务端枚举扩展时回退为待进行。 */
function stepStateOf(status: string, isCurrent: boolean): StepState {
  if (status === "SUCCEEDED" || status === "SKIPPED") return "done";
  if (status === "FAILED") return "failed";
  if (status === "RUNNING") return isCurrent ? "active" : "waiting";
  if (status === "CANCELLED") return "failed";
  return "waiting";
}

const stepStateLabels: Record<StepState, string> = {
  done: "已执行", active: "执行中", failed: "失败", waiting: "待进行"
};

/**
 * 右侧「工作详情」面板。
 *
 * 结构对齐 Relay V4.2 页面原型：顶部标题区 + 进展/成果/记录三个页签 + 成果深预览。
 * 只做呈现层重组——进度、步骤、注意力提示、版本凭据全部来自已经读到的 task / run 事实，
 * 不推断新状态、不补造差异或凭据。原型里「变更」页签需要真实 diff，
 * 当前面板没有该数据来源，因此深预览只保留「预览」与「版本与来源」两页。
 */
export default function TaskInspectorPanel({
  client,
  task,
  run,
  projectTitle,
  folder,
  mode,
  selectedArtifact,
  onSelectArtifactVersion,
  onCloseFilePreview,
  onClose,
  onSwitchToTask,
  isChatView
}: TaskInspectorPanelProps) {
  const [selectedTab, setSelectedTab] = useState<InspectorTab>("PROGRESS");
  const [tabTaskId, setTabTaskId] = useState(task.id);
  const tab = tabTaskId === task.id ? selectedTab : "PROGRESS";
  const [previewTab, setPreviewTab] = useState<"CONTENT" | "ORIGIN">("CONTENT");
  const [artifactReload, setArtifactReload] = useState(0);
  const [previewReload, setPreviewReload] = useState(0);
  const [artifactRead, setArtifactRead] = useState<{ readonly taskId: string; readonly revision: RelayTaskDetail["revision"]; readonly status: "loading" | "ready" | "error";
    readonly value?: RelayTaskArtifacts; readonly error?: string }>({ taskId: task.id, revision: task.revision, status: "loading" });
  const [previewRead, setPreviewRead] = useState<{ readonly versionId: string; readonly status: "loading" | "ready" | "error";
    readonly content?: string; readonly error?: string } | null>(null);
  const tabRefs = useRef<Partial<Record<InspectorTab, HTMLButtonElement>>>({});
  const previewTabRefs = useRef<Partial<Record<typeof previewTab, HTMLButtonElement>>>({});
  const currentArtifactRead = artifactRead.taskId === task.id && artifactRead.revision === task.revision
    ? artifactRead : { taskId: task.id, revision: task.revision, status: "loading" as const };
  const artifacts = currentArtifactRead.status === "ready" ? currentArtifactRead.value : null;
  const preview = selectedArtifact?.artifact.taskId === task.id
    && selectedArtifact.artifact.versions.some((version) => version.artifactVersionId === selectedArtifact.version.artifactVersionId)
    ? selectedArtifact : null;

  useEffect(() => {
    let active = true;
    setArtifactRead({ taskId: task.id, revision: task.revision, status: "loading" });
    void client.getTaskArtifacts(task.id).then((value) => {
      if (active) setArtifactRead({ taskId: task.id, revision: task.revision, status: "ready", value });
    }).catch((caught: unknown) => {
      if (active) setArtifactRead({ taskId: task.id, revision: task.revision, status: "error", error: describeLiveError(caught).message });
    });
    return () => { active = false; };
  }, [client, task.id, task.revision, artifactReload]);

  useEffect(() => {
    setTabTaskId(task.id);
    setSelectedTab("PROGRESS");
    setPreviewTab("CONTENT");
  }, [task.id]);

  useEffect(() => {
    if (preview === null) { setPreviewRead(null); return; }
    const versionId = preview.version.artifactVersionId;
    let active = true;
    setPreviewRead({ versionId, status: "loading" });
    void client.getArtifactVersionContent(versionId).then((content) => {
      if (active) setPreviewRead({ versionId, status: "ready", content });
    }).catch((caught: unknown) => {
      const failure = describeLiveError(caught);
      if (active) setPreviewRead({ versionId, status: "error", error: failure.kind === "evidence"
        ? "这个版本的正文当前不可读取，请核对原文件是否仍可访问。" : failure.message });
    });
    return () => { active = false; };
  }, [client, preview?.version.artifactVersionId, previewReload]);

  function selectTab(next: InspectorTab) {
    setTabTaskId(task.id);
    setSelectedTab(next);
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLElement>, current: InspectorTab) {
    const index = inspectorTabs.findIndex((item) => item.id === current);
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % inspectorTabs.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + inspectorTabs.length - 1) % inspectorTabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? inspectorTabs.length - 1 : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = inspectorTabs[nextIndex]!;
    selectTab(next.id);
    requestAnimationFrame(() => tabRefs.current[next.id]?.focus());
  }

  function handlePreviewTabKeyDown(event: KeyboardEvent<HTMLElement>, current: typeof previewTab) {
    const previewTabs = ["CONTENT", "ORIGIN"] as const;
    const index = previewTabs.indexOf(current);
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % previewTabs.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + previewTabs.length - 1) % previewTabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? previewTabs.length - 1 : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = previewTabs[nextIndex]!;
    setPreviewTab(next);
    requestAnimationFrame(() => previewTabRefs.current[next]?.focus());
  }

  const steps = run?.steps ?? [];
  const doneCount = steps.filter((step) => step.status === "SUCCEEDED" || step.status === "SKIPPED").length;
  const percentage = steps.length > 0 ? Math.round((doneCount / steps.length) * 100) : 0;

  const unresolvedCount = run?.unresolvedOperationIds.length ?? 0;
  const blocked = task.unresolvedBlockerIds.length > 0 || task.status === "BLOCKED";
  const failed = run?.status === "FAILED";
  const completionUnconfirmed = task.status === "DONE" && task.currentCompletionId === null;
  const tone: "success" | "warning" | "danger" | "neutral" = unresolvedCount > 0 || blocked || failed ? "danger"
    : run?.pendingControlRequest != null || run?.status === "PAUSED" || task.status === "WAITING" || completionUnconfirmed ? "warning"
    : task.status === "DONE" ? "success" : "neutral";

  const inspectorStatus = unresolvedCount > 0 ? "外部结果待核对"
    : failed ? "执行失败"
    : blocked ? "存在阻塞"
    : run?.pendingControlRequest != null ? "已提交控制请求"
    : run?.status === "PAUSED" ? "已暂停"
    : completionUnconfirmed ? "完成凭据待核对"
    : task.status === "DONE" ? "已完成"
    : run !== null ? runLabels[run.status] ?? run.status
    : taskStatusLabels[task.status] ?? task.status;

  /** 注意力提示：只报真实存在的风险，没有风险就不占位。 */
  const attention = (() => {
    if (unresolvedCount > 0) return { tone: "danger" as const, title: "外部动作结果待核对",
      body: `${unresolvedCount} 项动作结果未知；沿原 operation_id 核对，不盲重试，也不换动作 ID 绕过。` };
    if (failed) return { tone: "danger" as const, title: "本轮执行失败",
      body: "请查看失败步骤与工具回执；已保存的成果仍可阅读。" };
    if (blocked) return { tone: "danger" as const, title: "存在未解除的阻塞",
      body: `${task.unresolvedBlockerIds.length} 项阻塞未解除，依赖它的步骤不会推进。` };
    if (run?.pendingControlRequest != null) return { tone: "warning" as const, title: "控制请求等待安全点",
      body: "请求已受理不等于已停止或已交接；在途动作安全处理前不宣称接手完成。" };
    if (run?.status === "PAUSED") return { tone: "warning" as const, title: "Run 已暂停",
      body: "可以安全修改后续计划；继续执行前需要重新确认当前事实。" };
    if (run?.waitReason || task.waitingReason) return { tone: "warning" as const, title: "等待原因",
      body: run?.waitReason ?? task.waitingReason ?? "" };
    if (task.status === "WAITING") return { tone: "warning" as const, title: "等待人工判断",
      body: "等待判断不等于已暂停；判断入口在成果区。" };
    return null;
  })();

  function readArtifactVersion(version: RelayArtifactVersionSummary): string {
    const parsed = Date.parse(version.createdAt);
    return Number.isNaN(parsed) ? version.createdAt : new Date(parsed).toLocaleString();
  }

  function completionStatusForVersion(versionId: string): string {
    if (task.currentCompletionId === null) return "当前没有完成凭据";
    if (currentArtifactRead.status === "loading") return "正在读取当前完成凭据版本引用";
    if (currentArtifactRead.status === "error") return "当前完成凭据版本引用读取失败";
    return currentArtifactRead.value?.currentAcceptedVersionIds?.includes(versionId)
      ? "当前完成凭据引用此版本" : "当前完成凭据未引用此版本";
  }

  const versionRows: readonly { readonly label: string; readonly value: string }[] = [
    { label: "任务版本", value: `v${task.revision}` },
    { label: "验收版本", value: `v${task.acceptance.acceptanceRevision}` },
    { label: "执行者", value: executorLabels[task.executor] ?? task.executor },
    { label: "Run 身份", value: run?.id.slice(0, 8) ?? "尚未启动" },
    { label: "Run 状态", value: run !== null ? runLabels[run.status] ?? run.status : "尚未启动" },
    { label: "正式完成凭据", value: task.currentCompletionId ?? "本轮尚无" }
  ];

  /** 步骤说明：有服务端原因就照实显示，没有就按状态给一句不误导的说明。 */
  function stepNote(step: RelayRun["steps"][number]): string {
    if (step.reason !== null && step.reason !== "") return step.reason;
    if (step.status === "FAILED" || step.status === "CANCELLED") return "未记录失败原因；请查看对应工具回执。";
    if (step.status === "RUNNING") return "当前步骤正在执行，尚无完成回执。";
    if (step.status === "PENDING") return "尚未开始。";
    if (step.status === "SUCCEEDED" || step.status === "SKIPPED") return "步骤回执显示已结束，未附带说明。";
    return "服务端未提供步骤说明。";
  }

  const records = steps.map((step) => ({
    key: step.id,
    title: stepLabels[step.kind] ?? step.kind,
    sub: stepNote(step),
    meta: `${stepStatusLabels[step.status] ?? step.status}${step.startedAt ? ` · 开始 ${step.startedAt}` : ""}${step.finishedAt ? ` · 结束 ${step.finishedAt}` : ""}`,
    state: stepStateOf(step.status, step.id === run?.currentStepId)
  }));

  function renderProgress() {
    return <>
      <p className="inspector-overline">当前工作</p>
      <h3 className="inspector-title">{task.title}</h3>
      <p className="inspector-sub">{projectTitle ?? (task.projectId === null ? "无项目" : "项目标题暂不可读取")} · {isChatView ? "会话关联到同一任务" : "任务与运行事实"}</p>
      <div className="inspector-status-row">
        <span className={`inspector-badge inspector-badge--${tone}`}>{inspectorStatus}</span>
        {task.status === "DONE" && task.currentCompletionId === null && <span className="inspector-badge inspector-badge--subtle">尚未正式完成</span>}
      </div>
      {steps.length > 0 && <>
        <div className="inspector-progress" role="progressbar" aria-valuenow={percentage} aria-valuemin={0} aria-valuemax={100}
          aria-valuetext={`已结束步骤 ${doneCount} / ${steps.length}；此计数不代表任务完成或验证通过`}
          aria-label="Run 已结束步骤数量比例，不代表任务完成或验证通过"><span style={{ width: `${percentage}%` }} /></div>
        <div className="inspector-progress-caption">
          <span>已结束步骤 {doneCount} / {steps.length}</span>
          <span>Run 步骤计数，不代表任务或验收进度</span>
        </div>
      </>}
      {attention !== null && <div className={`inspector-attention inspector-attention--${attention.tone}`} role={attention.tone === "danger" ? "alert" : "status"}>
        <b>{attention.title}</b>{attention.body}
      </div>}
      {steps.length > 0
        ? <>
          <p className="inspector-section-head">主要步骤</p>
          <div className="inspector-steps">
            {steps.map((step) => {
              const state = stepStateOf(step.status, step.id === run?.currentStepId);
              return <div className="inspector-step" key={step.id}>
                <span className={`inspector-step-symbol inspector-step-symbol--${state}`} aria-hidden="true">
                  {state === "done" ? <CheckCircle2 size={13} />
                    : state === "failed" ? <AlertTriangle size={13} />
                    : state === "active" ? <Loader size={13} />
                    : <Circle size={13} />}
                </span>
                <span className="inspector-step-body">
                  <span className="inspector-step-label">{stepLabels[step.kind] ?? step.kind}</span>
                  <span className="inspector-step-hint">{stepNote(step)}</span>
                </span>
                <span className={`inspector-step-state inspector-step-state--${state}`}>{stepStateLabels[state]}</span>
              </div>;
            })}
          </div>
        </>
        : <p className="inspector-note">本轮还没有产生执行步骤。普通讨论不要求建立 Run；涉及文件操作时才需要落实执行上下文。</p>}
      {isChatView && onSwitchToTask && <button type="button" className="inspector-secondary" data-testid="collab-inspector-open-task" onClick={onSwitchToTask}>
        <Folder size={14} aria-hidden="true" /> 打开任务执行面板
      </button>}
      <button type="button" className="inspector-secondary" onClick={() => selectTab("RECORDS")}>
        <Link2 size={14} aria-hidden="true" /> 查看执行与验证记录
      </button>
    </>;
  }

  function renderResults() {
    const items = artifacts?.items ?? [];
    return <>
      <p className="inspector-overline">工作成果</p>
      <h3 className="inspector-title">已保存的成果版本</h3>
      <p className="inspector-sub">请选择已保存的成果，阅读对应的确切版本正文。</p>
      <p className="inspector-section-head">成果条目 <span className="inspector-section-count">{currentArtifactRead.status === "ready" ? `${items.length} 项` : ""}</span></p>
      {currentArtifactRead.status === "loading"
        ? <p className="inspector-note" role="status">正在读取已保存成果…</p>
        : currentArtifactRead.status === "error"
          ? <div className="inspector-artifact-error" role="alert" data-testid="collab-inspector-artifacts-error">
            <p>成果读取失败：{currentArtifactRead.error}</p>
            <button type="button" className="inspector-secondary" onClick={() => setArtifactReload((value) => value + 1)}>重新读取成果</button>
          </div>
          : items.length > 0
            ? <div className="inspector-assets">
              {items.map((artifact) => {
                const version = artifact.latestVersionId === null
                  ? undefined : artifact.versions.find((item) => item.artifactVersionId === artifact.latestVersionId);
                const completionStatus = version ? completionStatusForVersion(version.artifactVersionId) : "";
                const content = <>
                  <span className="inspector-asset-icon" aria-hidden="true"><FileText size={15} /></span>
                  <span className="inspector-asset-copy">
                    <span className="inspector-asset-name">{artifact.title}</span>
                    <span className="inspector-asset-meta">{version ? `v${version.versionNumber} · ${version.mediaType} · ${version.sourceKind}` : "没有可读取版本"}</span>
                    <span className="inspector-asset-status">{version ? completionStatus : "Artifact 尚未保存版本"}</span>
                  </span>
                </>;
                return version
                  ? <button type="button" className="inspector-asset" key={artifact.id} id={`collab-inspector-asset-${artifact.id}`}
                    data-artifact-id={artifact.id} data-testid={`collab-inspector-asset-${artifact.id}`}
                    title={`打开 ${artifact.title} v${version.versionNumber}`}
                    onClick={(event) => onSelectArtifactVersion(artifact, version, event.currentTarget)}>{content}<ChevronRight className="inspector-asset-arrow" size={14} aria-hidden="true" /></button>
                  : <div className="inspector-asset" key={artifact.id} data-testid={`collab-inspector-asset-${artifact.id}`}>{content}</div>;
              })}
            </div>
            : <p className="inspector-note">当前任务没有已保存的成果版本。</p>}
      <p className="inspector-section-head">版本与凭据</p>
      <dl className="inspector-version-table">
        {versionRows.map((row) => <div className="inspector-version-row" key={row.label}>
          <dt>{row.label}</dt><dd>{row.value}</dd>
        </div>)}
      </dl>
    </>;
  }

  function renderRecords() {
    return <>
      <p className="inspector-overline">运行记录</p>
      <h3 className="inspector-title">执行与验证依据</h3>
      <p className="inspector-sub">步骤状态、失败原因与运行身份集中在这里，不占进展首屏。</p>
      {attention !== null && <div className={`inspector-attention inspector-attention--${attention.tone}`} role={attention.tone === "danger" ? "alert" : "status"}>
        <b>{attention.title}</b>{attention.body}
      </div>}
      <p className="inspector-section-head">步骤记录</p>
      {records.length > 0
        ? <div className="inspector-records">
          {records.map((record) => <div className="inspector-record" key={record.key}>
            <span className={`inspector-record-icon inspector-record-icon--${record.state}`} aria-hidden="true">
              {record.state === "done" ? <CheckCircle2 size={13} />
                : record.state === "failed" ? <AlertTriangle size={13} />
                : <Clock size={13} />}
            </span>
            <span className="inspector-record-text">
              <span className="inspector-record-title">{record.title}</span>
              <span className="inspector-record-sub">{record.sub}</span>
              <span className="inspector-record-meta">{record.meta}</span>
            </span>
          </div>)}
        </div>
        : <p className="inspector-note">本轮没有执行步骤，也就没有工具调用或验证回执。</p>}
      <p className="inspector-section-head">运行元数据</p>
      <dl className="inspector-version-table">
        <div className="inspector-version-row"><dt>Run 身份</dt><dd>{run?.id ?? "未创建"}</dd></div>
        <div className="inspector-version-row"><dt>Run 版本</dt><dd>{run !== null ? `v${run.revision}` : "未创建"}</dd></div>
        <div className="inspector-version-row"><dt>待核对动作</dt><dd>{unresolvedCount > 0 ? `${unresolvedCount} 项` : "无"}</dd></div>
        <div className="inspector-version-row"><dt>Token / 费用</dt><dd>未采集</dd></div>
      </dl>
      <p className="inspector-section-head">来源与上下文</p>
      <div className="inspector-source">
        <div className="inspector-source-row"><span>所属项目</span><strong>{projectTitle ?? (task.projectId === null ? "无项目" : "未命名项目")}</strong></div>
        <div className="inspector-source-row"><span>工作目录</span><strong>{folder?.canonicalRoot ?? folder?.displayName ?? "未绑定工作目录"}</strong></div>
        <div className="inspector-source-row"><span>执行模式</span><strong><Sparkles size={12} aria-hidden="true" /> {mode}</strong></div>
        <div className="inspector-source-row"><span>权限策略</span><strong><Shield size={12} aria-hidden="true" /> 危险操作需确认</strong></div>
      </div>
    </>;
  }

  if (preview !== null) {
    const previewContent = previewRead?.versionId === preview.version.artifactVersionId ? previewRead : null;
    const completionStatus = completionStatusForVersion(preview.version.artifactVersionId);
    return <aside className="task-inspector task-inspector--preview" id={`collab-inspector-${task.id}`} data-testid="collab-inspector" aria-label="成果文件预览">
      <div className="inspector-head">
        <button type="button" className="inspector-back" data-testid="collab-inspector-preview-back"
          title="返回工作详情" onClick={onCloseFilePreview}><ArrowLeft size={15} aria-hidden="true" /></button>
        <div className="inspector-head-copy">
          <strong>文件预览</strong>
          <small>只读 · 不影响当前协作</small>
        </div>
        <button type="button" className="inspector-close" title="关闭面板" data-testid="collab-inspector-close" onClick={onClose}>
          <X size={15} aria-hidden="true" /></button>
      </div>
      <div className="inspector-preview-bar">
        <p className="inspector-preview-name">{preview.artifact.title}</p>
        <p className="inspector-preview-meta">版本 v{preview.version.versionNumber} · {preview.version.mediaType} · 来源 {preview.version.sourceKind}</p>
        <div className="inspector-preview-tabs" role="tablist" aria-label="预览分页" onKeyDown={(event) => handlePreviewTabKeyDown(event, previewTab)}>
          <button type="button" role="tab" id={`collab-inspector-preview-tab-${task.id}-CONTENT`}
            aria-controls={`collab-inspector-preview-panel-${task.id}`} aria-selected={previewTab === "CONTENT"}
            tabIndex={previewTab === "CONTENT" ? 0 : -1} ref={(element) => { if (element) previewTabRefs.current.CONTENT = element; }}
            className={previewTab === "CONTENT" ? "active" : ""} onClick={() => setPreviewTab("CONTENT")}>预览</button>
          <button type="button" role="tab" id={`collab-inspector-preview-tab-${task.id}-ORIGIN`}
            aria-controls={`collab-inspector-preview-panel-${task.id}`} aria-selected={previewTab === "ORIGIN"}
            tabIndex={previewTab === "ORIGIN" ? 0 : -1} ref={(element) => { if (element) previewTabRefs.current.ORIGIN = element; }}
            className={previewTab === "ORIGIN" ? "active" : ""} onClick={() => setPreviewTab("ORIGIN")}>版本与来源</button>
        </div>
      </div>
      <div className="inspector-preview-body" role="tabpanel" id={`collab-inspector-preview-panel-${task.id}`}
        aria-labelledby={`collab-inspector-preview-tab-${task.id}-${previewTab}`} tabIndex={0}>
        {previewTab === "CONTENT"
          ? previewContent?.status === "ready" ? <article className="inspector-paper"><SafeMarkdown source={previewContent.content ?? ""} /></article>
            : previewContent?.status === "error" ? <div className="inspector-artifact-error" role="alert">
              <p>所选版本正文读取失败：{previewContent.error}</p>
              <button type="button" className="inspector-secondary" onClick={() => setPreviewReload((value) => value + 1)}>重新读取此版本</button>
            </div>
            : <p className="inspector-note" role="status">正在读取所选确切版本…</p>
          : <dl className="inspector-version-table">
            <div className="inspector-version-row"><dt>成果</dt><dd>{preview.artifact.title}</dd></div>
            <div className="inspector-version-row"><dt>Artifact ID</dt><dd>{preview.artifact.id}</dd></div>
            <div className="inspector-version-row"><dt>版本 ID</dt><dd>{preview.version.artifactVersionId}</dd></div>
            <div className="inspector-version-row"><dt>版本</dt><dd>v{preview.version.versionNumber}</dd></div>
            <div className="inspector-version-row"><dt>来源类型</dt><dd>{preview.version.sourceKind}</dd></div>
            <div className="inspector-version-row"><dt>创建时间</dt><dd>{readArtifactVersion(preview.version)}</dd></div>
            <div className="inspector-version-row"><dt>SHA-256</dt><dd>{preview.version.sha256}</dd></div>
            <div className="inspector-version-row"><dt>当前完成凭据</dt><dd>{completionStatus}</dd></div>
            <div className="inspector-version-row"><dt>CompletionRecord</dt><dd>{task.currentCompletionId ?? "本轮尚无"}</dd></div>
            <div className="inspector-version-row"><dt>任务版本</dt><dd>v{task.revision}</dd></div>
            <div className="inspector-version-row"><dt>验收版本</dt><dd>v{task.acceptance.acceptanceRevision}</dd></div>
            <div className="inspector-version-row"><dt>项目</dt><dd>{projectTitle ?? (task.projectId === null ? "无项目" : "项目标题暂不可读取")}</dd></div>
            <div className="inspector-version-row"><dt>当前 Run</dt><dd>{run?.id ?? "未创建"}</dd></div>
            <div className="inspector-version-row"><dt>Run 状态</dt><dd>{run ? runLabels[run.status] ?? run.status : "未启动"}</dd></div>
            <div className="inspector-version-row"><dt>检查结论</dt><dd>未在此面板采集确切版本的验证结果</dd></div>
          </dl>}
      </div>
      <div className="inspector-preview-foot"><span>只读版本内容 · {preview.version.size} 字节</span></div>
    </aside>;
  }

  return <aside className="task-inspector" id={`collab-inspector-${task.id}`} data-testid="collab-inspector" aria-label="工作详情">
    <div className="inspector-head">
      <div className="inspector-head-copy">
        <strong>工作详情</strong>
        <small>按需查看，不影响协作</small>
      </div>
      <button type="button" className="inspector-close" title="关闭面板" data-testid="collab-inspector-close" onClick={onClose}>
        <X size={15} aria-hidden="true" /></button>
    </div>
    <div className="inspector-tabs" role="tablist" aria-label="工作详情分类">
      {inspectorTabs.map((item) => <button key={item.id} type="button" role="tab"
        id={`collab-inspector-tab-${task.id}-${item.id}`} aria-controls={`collab-inspector-panel-${task.id}`}
        aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1}
        ref={(element) => { if (element) tabRefs.current[item.id] = element; }}
        className={tab === item.id ? "active" : ""} data-testid={`collab-inspector-tab-${item.id}`}
        onKeyDown={(event) => handleTabKeyDown(event, item.id)} onClick={() => selectTab(item.id)}>{item.label}</button>)}
    </div>
    <div className="inspector-body" id={`collab-inspector-panel-${task.id}`} role="tabpanel"
      aria-labelledby={`collab-inspector-tab-${task.id}-${tab}`} tabIndex={0} data-testid={`collab-inspector-panel-${tab}`}>
      {tab === "PROGRESS" ? renderProgress() : tab === "RESULTS" ? renderResults() : renderRecords()}
    </div>
  </aside>;
}
