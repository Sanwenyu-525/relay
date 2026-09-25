import { useEffect, useRef, useState } from "react";
import { Check, FileText, Info, RotateCcw, Save } from "lucide-react";
import SafeMarkdown from "./SafeMarkdown";
import { artifactVersionResultFrom, completionFrom, createCommandId, RelayApiError, RelayTransportError, reopenFrom, stateMutationFrom, type RelayAcceptanceCriterion, type RelayArtifactVersionResult, type RelayProjectState, type RelayTaskArtifacts } from "../api/relayClient";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { taskStatusLabels } from "../lib/labels";
import { describeLiveError, type LiveActionError } from "../lib/liveErrors";
import { liveClient } from "../lib/relayConnection";
import type { DecimalRevision, TaskStatus } from "../types";

interface Props {
  taskId: string; projectId: string | null; taskStatus: TaskStatus; taskRevision: DecimalRevision;
  acceptanceRevision: DecimalRevision; criteria: readonly RelayAcceptanceCriterion[];
  allowedActions: readonly string[] | null; onRefresh: () => void;
}
const MEDIA_TYPE = "text/markdown";
const CONTENT_LIMIT_BYTES = 256 * 1024;
const wrongReceipt = (commandType: string, action: string): LiveActionError => ({ kind: "unknown", message: `回执的命令类型是 ${commandType}，不是本次${action}；请核对 command ID。`, fieldErrors: [] });
const DEFINITIVE_SAVE_REJECTIONS = new Set(["VALIDATION_FAILED", "REVISION_CONFLICT", "INVALID_TRANSITION", "UNSUPPORTED_MEDIA_TYPE", "CONTENT_TOO_LARGE"]);
type PendingSave = {
  readonly commandId: string;
  readonly taskId: string;
  readonly expectedTaskRevision: DecimalRevision;
  readonly mediaType: typeof MEDIA_TYPE;
  readonly content: string;
} & ({
  readonly kind: "create";
  readonly title: string;
} | {
  readonly kind: "append";
  readonly artifactId: string;
  readonly expectedArtifactRevision: DecimalRevision;
});

export default function ArtifactPanel(props: Props) {
  const { taskId, projectId, taskStatus, taskRevision, acceptanceRevision, criteria, allowedActions, onRefresh } = props;
  const [title, setTitle] = useState("任务产物");
  const [content, setContent] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveReceipt, setSaveReceipt] = useState<string | null>(null);
  const [saveFailure, setSaveFailure] = useState<LiveActionError | null>(null);
  const [savePending, setSavePending] = useState<PendingSave | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [artifactSnapshot, setArtifactSnapshot] = useState<{ taskId: string; data: RelayTaskArtifacts } | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [versionsFailure, setVersionsFailure] = useState<string | null>(null);
  const [state, setState] = useState<RelayProjectState | null>(null);
  const [stateFailure, setStateFailure] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectReceipt, setSelectReceipt] = useState<string | null>(null);
  const [selectFailure, setSelectFailure] = useState<LiveActionError | null>(null);
  const [acceptanceStatement, setAcceptanceStatement] = useState("按当前验收标准完成，并接受所选产物版本。");
  const [acceptanceReason, setAcceptanceReason] = useState("");
  const [acceptedCriterionIds, setAcceptedCriterionIds] = useState<string[]>([]);
  const [completing, setCompleting] = useState(false);
  const [completionReceipt, setCompletionReceipt] = useState<string | null>(null);
  const [completionFailure, setCompletionFailure] = useState<LiveActionError | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const [reopening, setReopening] = useState(false);
  const [reopenReceipt, setReopenReceipt] = useState<string | null>(null);
  const [reopenFailure, setReopenFailure] = useState<LiveActionError | null>(null);
  const disposed = useRef(false);
  const artifactsRequest = useRef(0);
  const command = useRef({ select: null as string | null, complete: null as string | null, reopen: null as string | null });
  const pendingSave = useRef<PendingSave | null>(null);
  const acceptanceRound = useRef({ taskId, revision: acceptanceRevision });
  const savedContentSnapshot = useRef("");
  const contentRef = useRef(content);
  contentRef.current = content;
  const guard = useRef<DraftGuard>({ hasUnsavedChanges: () => contentRef.current !== savedContentSnapshot.current, discard: () => { contentRef.current = savedContentSnapshot.current; setContent(savedContentSnapshot.current); } });
  const live = allowedActions !== null;
  const artifacts = artifactSnapshot?.taskId === taskId ? artifactSnapshot.data : null;
  const humanArtifact = artifacts?.items.filter((item) => item.versions.some((version) => version.sourceKind === "HUMAN")).at(-1) ?? null;
  const latestHumanVersion = humanArtifact?.versions.at(-1) ?? null;
  const latest = humanArtifact && latestHumanVersion ? {
    artifactId: humanArtifact.id, artifactRevision: humanArtifact.revision,
    versionId: latestHumanVersion.artifactVersionId, versionNumber: latestHumanVersion.versionNumber
  } : null;
  const versions = artifacts?.items.flatMap((artifact) => artifact.versions.map((version) => ({
    artifactId: artifact.id, versionId: version.artifactVersionId, versionNumber: version.versionNumber,
    title: artifact.title, sha256: version.sha256, size: version.size
  }))) ?? [];
  const selectedVersion = !versionsLoading && !versionsFailure
    ? versions.find((version) => version.versionId === selectedVersionId) ?? null : null;
  const selectedByProject = state?.selectedArtifactVersionRefs ?? [];
  const contentBytes = new TextEncoder().encode(content).length;
  const contentTooLarge = contentBytes > CONTENT_LIMIT_BYTES;
  const done = taskStatus === "DONE";
  const requiredCriteria = criteria.filter((criterion) => criterion.required);
  const versionsReady = artifacts !== null && !versionsLoading && versionsFailure === null;
  const canSave = live && versionsReady && allowedActions.includes("SAVE_ARTIFACT_VERSION") && !!content.trim() && !contentTooLarge && !saving && savePending === null;
  const canComplete = live && versionsReady && allowedActions.includes("COMPLETE") && requiredCriteria.every((criterion) => acceptedCriterionIds.includes(criterion.criterionId)) && !!acceptanceStatement.trim() && !completing;
  const canReopen = live && allowedActions.includes("REOPEN") && !!reopenReason.trim() && !reopening;

  async function loadArtifacts() {
    const client = liveClient();
    const request = ++artifactsRequest.current;
    if (!client) { setArtifactSnapshot(null); setVersionsLoading(false); return; }
    setVersionsLoading(true); setVersionsFailure(null);
    try {
      const loaded = await client.getTaskArtifacts(taskId);
      if (disposed.current || request !== artifactsRequest.current) return;
      setArtifactSnapshot({ taskId, data: loaded });
      setSelectedVersionId((current) => {
        const allVersions = loaded.items.flatMap((item) => item.versions);
        return current && allVersions.some((version) => version.artifactVersionId === current)
          ? current : null;
      });
    } catch (caught) {
      if (!disposed.current && request === artifactsRequest.current) setVersionsFailure(describeLiveError(caught).message);
    } finally {
      if (!disposed.current && request === artifactsRequest.current) setVersionsLoading(false);
    }
  }

  async function loadState() {
    const client = liveClient();
    if (!client || !projectId) { setState(null); return; }
    try { const loaded = await client.getProjectState(projectId); if (!disposed.current) { setState(loaded); setStateFailure(null); } }
    catch (caught) { if (!disposed.current) setStateFailure(describeLiveError(caught).message); }
  }
  useEffect(() => { disposed.current = false; setDraftGuard(guard.current); return () => { disposed.current = true; artifactsRequest.current++; clearDraftGuard(guard.current); }; }, [taskId]);
  useEffect(() => { void loadState(); void loadArtifacts(); }, [taskId, projectId, taskRevision]);
  useEffect(() => {
    if (acceptanceRound.current.taskId === taskId && acceptanceRound.current.revision === acceptanceRevision) return;
    acceptanceRound.current = { taskId, revision: acceptanceRevision };
    resetAcceptanceSelection();
  }, [taskId, acceptanceRevision]);
  function resetAcceptanceSelection() { setSelectedVersionId(null); setAcceptedCriterionIds([]); }
  function remember(result: RelayArtifactVersionResult, attempt: PendingSave) {
    savedContentSnapshot.current = attempt.content;
    if (contentRef.current === attempt.content) setSelectedVersionId(result.versionId);
    void loadArtifacts();
  }
  function saveResultMatches(result: RelayArtifactVersionResult, attempt: PendingSave) {
    return result.taskId === attempt.taskId && result.mediaType === attempt.mediaType &&
      (attempt.kind === "create" || result.artifactId === attempt.artifactId);
  }
  function settleSave(result: RelayArtifactVersionResult, attempt: PendingSave, receipt: string) {
    if (!saveResultMatches(result, attempt)) throw new RelayTransportError("保存结果与原请求目标不符，请核对原 command_id。");
    pendingSave.current = null; setSavePending(null);
    remember(result, attempt);
    setSaveReceipt(`${receipt}${contentRef.current === attempt.content ? "" : "当前草稿仍未保存。"}`);
    onRefresh();
  }
  function editContent(value: string) { contentRef.current = value; setContent(value); }
  async function saveVersion() {
    const client = liveClient();
    if (!client || !canSave || pendingSave.current) return;
    const attempt: PendingSave = latest ? {
      kind: "append", commandId: createCommandId(), taskId,
      expectedTaskRevision: taskRevision, artifactId: latest.artifactId,
      expectedArtifactRevision: latest.artifactRevision, mediaType: MEDIA_TYPE, content
    } : {
      kind: "create", commandId: createCommandId(), taskId,
      expectedTaskRevision: taskRevision, title: title.trim(), mediaType: MEDIA_TYPE, content
    };
    pendingSave.current = attempt; setSavePending(attempt);
    setSaving(true); setSaveFailure(null); setSaveReceipt(null);
    try {
      const result = attempt.kind === "append" ? await client.submitArtifactVersion(attempt) : await client.createArtifactWithVersion(attempt);
      if (disposed.current) return;
      settleSave(result, attempt, attempt.kind === "append" ? `已保存新版本 v${result.versionNumber}（sha256 ${result.sha256.slice(0, 12)}…，${result.size} 字节）。上一版本保持不变。` : `已创建产物并保存 v${result.versionNumber}（sha256 ${result.sha256.slice(0, 12)}…，${result.size} 字节）。旧版本不会被覆盖。`);
    } catch (caught) { if (disposed.current) return; setSaveFailure(describeLiveError(caught)); if (caught instanceof RelayApiError && DEFINITIVE_SAVE_REJECTIONS.has(caught.problem.code)) { pendingSave.current = null; setSavePending(null); } }
    finally { if (!disposed.current) setSaving(false); }
  }
  async function lookupSaveReceipt() {
    const client = liveClient(); const pending = pendingSave.current;
    if (!client || !pending || saving) return;
    setSaving(true); setSaveFailure(null);
    try { const body = await client.getCommandReceipt(pending.commandId); if (disposed.current) return; const expectedType = pending.kind === "create" ? "CreateArtifactWithVersion" : "SubmitHumanArtifactVersion"; if (body.commandId !== pending.commandId) { setSaveFailure({ kind: "unknown", message: "回执 command_id 与原保存命令不符；请继续核对原 ID。", fieldErrors: [] }); return; } if (body.commandType !== expectedType) { setSaveFailure(wrongReceipt(body.commandType, "保存")); return; } const result = artifactVersionResultFrom(body.result); settleSave(result, pending, `回执确认已提交：产物版本 v${result.versionNumber}（sha256 ${result.sha256.slice(0, 12)}…）。`); }
    catch (caught) { if (!disposed.current) setSaveFailure(describeLiveError(caught)); }
    finally { if (!disposed.current) setSaving(false); }
  }
  async function selectVersion() {
    const client = liveClient();
    if (!client || !selectedVersion || !projectId || !state || selecting) return;
    setSelecting(true); setSelectFailure(null); setSelectReceipt(null);
    try { command.current.select ??= createCommandId(); const result = await client.selectArtifactVersion({ projectId, commandId: command.current.select, expectedRevision: state.revision, artifactVersionId: selectedVersion.versionId, sourceRef: `human:workbench:task/${taskId}` }); if (disposed.current) return; command.current.select = null; setSelectReceipt(`项目 State 已选用 v${selectedVersion.versionNumber}（State revision v${result.revision}）。这是“当前选用”，与“本轮接受”不同。`); await loadState(); }
    catch (caught) { if (disposed.current) return; const described = describeLiveError(caught); setSelectFailure(described); if (described.kind !== "transport") command.current.select = null; }
    finally { if (!disposed.current) setSelecting(false); }
  }
  async function lookupSelectReceipt() {
    const client = liveClient(); const pending = command.current.select;
    if (!client || !pending || selecting) return;
    setSelecting(true); setSelectFailure(null);
    try { const body = await client.getCommandReceipt(pending); if (disposed.current) return; if (body.commandType !== "SetProjectState") { setSelectFailure(wrongReceipt(body.commandType, "选择")); return; } const result = stateMutationFrom(body.result); command.current.select = null; setSelectReceipt(`回执确认已提交：项目 State 已选用该版本（State revision v${result.revision}）。`); await loadState(); }
    catch (caught) { if (!disposed.current) setSelectFailure(describeLiveError(caught)); }
    finally { if (!disposed.current) setSelecting(false); }
  }
  function toggleCriterion(criterionId: string, checked: boolean) { setAcceptedCriterionIds((current) => checked ? [...current, criterionId] : current.filter((id) => id !== criterionId)); }
  async function completeTask() {
    const client = liveClient(); if (!client || !canComplete) return;
    setCompleting(true); setCompletionFailure(null); setCompletionReceipt(null);
    try { command.current.complete ??= createCommandId(); const result = await client.completeHumanTask({ taskId, commandId: command.current.complete, expectedRevision: taskRevision, acceptanceRevision, artifactVersionIds: selectedVersion ? [selectedVersion.versionId] : [], statement: acceptanceStatement.trim(), acceptedCriterionIds, reason: acceptanceReason.trim() || null }); if (disposed.current) return; command.current.complete = null; setCompletionReceipt(`已完成本轮：完成凭据 ${result.completionId}，任务修订 v${result.revision}，验收版本 v${result.acceptanceRevision}${result.stateRevision === null ? "" : `，项目 State 修订 v${result.stateRevision}`}。历史凭据保留；再次编辑需要重开。`); onRefresh(); }
    catch (caught) { if (disposed.current) return; const described = describeLiveError(caught); setCompletionFailure(described); if (described.kind !== "transport") command.current.complete = null; }
    finally { if (!disposed.current) setCompleting(false); }
  }
  async function lookupCompleteReceipt() {
    const client = liveClient(); const pending = command.current.complete; if (!client || !pending || completing) return;
    setCompleting(true); setCompletionFailure(null);
    try { const body = await client.getCommandReceipt(pending); if (disposed.current) return; if (body.commandType !== "CompleteHumanTask") { setCompletionFailure(wrongReceipt(body.commandType, "完成")); return; } const result = completionFrom(body.result); command.current.complete = null; setCompletionReceipt(`回执确认已完成：完成凭据 ${result.completionId}，任务修订 v${result.revision}。`); onRefresh(); }
    catch (caught) { if (!disposed.current) setCompletionFailure(describeLiveError(caught)); }
    finally { if (!disposed.current) setCompleting(false); }
  }
  async function reopenTask() {
    const client = liveClient(); if (!client || !canReopen) return;
    setReopening(true); setReopenFailure(null); setReopenReceipt(null);
    try { command.current.reopen ??= createCommandId(); const result = await client.reopenTask({ taskId, commandId: command.current.reopen, expectedRevision: taskRevision, reason: reopenReason.trim() }); if (disposed.current) return; if (result.taskId !== taskId) throw new RelayTransportError("重开结果与当前任务不符，请核对原 command_id。"); command.current.reopen = null; setReopenReceipt(`已重开：回到${result.status}，新验收版本 v${result.acceptanceRevision}（原 v${result.previousAcceptanceRevision} 的历史凭据仍保留）。编辑前需要重新开始任务。`); resetAcceptanceSelection(); setReopenReason(""); onRefresh(); }
    catch (caught) { if (disposed.current) return; const described = describeLiveError(caught); setReopenFailure(described); if (described.kind !== "transport") command.current.reopen = null; }
    finally { if (!disposed.current) setReopening(false); }
  }
  async function lookupReopenReceipt() {
    const client = liveClient(); const pending = command.current.reopen; if (!client || !pending || reopening) return;
    setReopening(true); setReopenFailure(null);
    try { const body = await client.getCommandReceipt(pending); if (disposed.current) return; if (body.commandId !== pending || body.commandType !== "ReopenTask") { setReopenFailure(wrongReceipt(body.commandType, "重开")); return; } const result = reopenFrom(body.result); if (result.taskId !== taskId) { setReopenFailure({ kind: "unknown", message: "重开回执与当前任务不符；请核对原 command_id。", fieldErrors: [] }); return; } command.current.reopen = null; resetAcceptanceSelection(); setReopenReceipt(`回执确认已重开：回到${result.status}，新验收版本 v${result.acceptanceRevision}。`); setReopenReason(""); onRefresh(); }
    catch (caught) { if (!disposed.current) setReopenFailure(describeLiveError(caught)); }
    finally { if (!disposed.current) setReopening(false); }
  }

  if (!live) return <section className="surface-panel" data-testid="artifact-fixture-gap"><h2>产物与完成</h2><p className="helper-text">示例数据没有产物事实，因此这里不展示任何产物、版本或完成凭据，也不提供可点的保存按钮。连接本机 API 后，产物版本、选择接受与人工完成会写入真实 PostgreSQL。</p></section>;
  return <>
    <section className="surface-panel" data-testid="artifact-editor"><h2>人工编辑与保存版本</h2><p className="helper-text">保存会创建不可变版本：旧版本不会被覆盖，新版本不继承任何验收凭据。草稿只是本地输入，保存成功前不算已发布产物。</p>{done ? <p className="warning-callout" role="status" data-testid="artifact-editor-locked"><Info aria-hidden="true" />该任务本轮已完成：编辑入口已关闭，请先在下方重开任务再保存新版本。</p> : !allowedActions.includes("SAVE_ARTIFACT_VERSION") && <p className="disabled-reason" data-testid="artifact-editor-reason"><Info aria-hidden="true" />服务端未投影 SAVE_ARTIFACT_VERSION：当前状态是{taskStatusLabels[taskStatus]}，只有进行中的人工任务可以保存产物。</p>}
      <label className="field"><span className="field-label">产物名称</span><input value={humanArtifact?.title ?? title} onChange={(event) => setTitle(event.target.value)} name="artifact-title" disabled={humanArtifact !== null || done || savePending !== null} /><span className="field-hint">{humanArtifact ? "这里保存的是该人工产物的新版本。" : "尚无人工产物；保存会创建产物，之后续写不可变版本。"}</span></label>
      <div className="editor-toolbar"><span className="field-label">Markdown 内容</span><div className="segmented">{[false, true].map((showPreview) => <label key={String(showPreview)} className={`segmented-option${previewing === showPreview ? " segmented-option--selected" : ""}`}><input checked={previewing === showPreview} onChange={() => setPreviewing(showPreview)} className="visually-hidden" type="radio" name="artifact-view" value={String(showPreview)} />{showPreview ? "预览" : "编辑"}</label>)}</div></div>
      {previewing ? <SafeMarkdown source={content} /> : <textarea value={content} onChange={(event) => editContent(event.target.value)} className="markdown-editor" name="artifact-content" rows={12} disabled={done} placeholder="用 Markdown 写这一轮的成果；标题、列表、粗体、行内代码与 http/https 链接会被安全渲染。" />}
      <p className="field-counter">{contentBytes} / {CONTENT_LIMIT_BYTES} 字节</p>{contentTooLarge && <p className="field-error" role="alert"><Info aria-hidden="true" />正文超过 256 KiB（按 UTF-8 字节判定），服务端会返回 413；请拆分后再保存。</p>}<div className="form-actions"><button className="primary-button" type="button" data-testid="artifact-save" disabled={!canSave} onClick={() => void saveVersion()}><Save aria-hidden="true" />{saving ? "正在保存" : "保存新版本"}</button></div>{savePending && <p className="helper-text" data-testid="artifact-save-pending">原 command_id：{savePending.commandId}。原请求{savePending.kind === "create" ? "创建产物" : `续写产物 ${savePending.artifactId}`}，正文 {new TextEncoder().encode(savePending.content).length} 字节；结果未核对前不能提交新草稿。</p>}{saveReceipt && <p className="receipt-message" role="status" data-testid="artifact-save-receipt">{saveReceipt}</p>}{saveFailure && <p className="action-error" role="alert">{saveFailure.message}</p>}{saveFailure?.kind === "conflict" && <p className="helper-text">草稿保留在编辑器里，没有被覆盖；请先重新读取任务事实，再决定是否用新版本提交。</p>}{savePending && !saving && <button className="secondary-button" type="button" data-testid="artifact-save-receipt-query" onClick={() => void lookupSaveReceipt()}>查询本次保存回执</button>}
    </section>
    <section className="surface-panel" data-testid="artifact-versions"><h2>版本与接受</h2><p className="helper-text">以下是服务端保存的任务产物历史。“最新”“当前选用”和“本轮接受”分别来自版本、项目 State 与当前完成凭据。</p>{versionsLoading && <p className="helper-text" role="status">正在读取产物版本。</p>}{versionsFailure && <p className="action-error" role="alert">{versionsFailure} 草稿仍保留；产物列表尚未核实，暂不能保存或完成。<button className="secondary-button" type="button" onClick={() => void loadArtifacts()}>重新读取产物</button></p>}{versionsReady && (!versions.length ? <div className="page-state"><p>该任务尚无已保存的产物版本。</p></div> : <ul className="version-list">{versions.map((version) => <li key={version.versionId} className="version-row"><label className="version-choice"><input checked={selectedVersionId === version.versionId} onChange={() => setSelectedVersionId(version.versionId)} type="radio" name="artifact-version" value={version.versionId} data-testid={`artifact-version-${version.versionId}`} /><span className="version-copy"><strong>v{version.versionNumber} · {version.title}</strong><small>sha256 {version.sha256.slice(0, 12)}… · {version.size} 字节</small></span></label><span className="version-tags">{artifacts?.items.some((item) => item.latestVersionId === version.versionId) && <span className="status-chip">最新</span>}{selectedByProject.some((ref) => ref.artifactVersionId === version.versionId) && <span className="status-chip status-chip--neutral">当前选用</span>}{artifacts?.currentAcceptedVersionIds.includes(version.versionId) && <span className="status-chip status-chip--neutral">本轮接受</span>}</span></li>)}</ul>)}
      <section className="rail-section"><h3>当前选用（来自项目 State）</h3>{stateFailure ? <p className="action-error" role="alert">{stateFailure}</p> : projectId === null ? <p className="helper-text">该任务未归属项目：选择版本为当前选用是 Project State 命令，因此不可用。</p> : selectedByProject.length === 0 ? <ul className="helper-text">项目 State 还没有选用任何产物版本。</ul> : <ul className="version-list">{selectedByProject.map((ref) => <li key={ref.artifactVersionId} className="version-row"><span className="version-copy"><strong>v{ref.versionNumber}</strong><small>来源：{ref.sourceRef}</small></span></li>)}</ul>}<button className="secondary-button" type="button" data-testid="artifact-select-version" disabled={!versionsReady || selecting || !selectedVersion || !projectId || !state} onClick={() => void selectVersion()}>{selecting ? "正在提交" : "选择这个版本为当前选用"}</button><p className="helper-text">“当前选用”是项目级事实，只影响后续 Context 与工作台视图；它不等于“本轮接受”，完成凭据里的版本以完成命令为准。</p>{selectReceipt && <p className="receipt-message" role="status">{selectReceipt}</p>}{selectFailure && <p className="action-error" role="alert">{selectFailure.message}</p>}{selectFailure?.kind === "transport" && <button className="secondary-button" type="button" disabled={selecting} onClick={() => void lookupSelectReceipt()}>查询本次选择回执</button>}</section>
    </section>
    <section className="surface-panel" data-testid="task-completion"><h2>检查与完成</h2><p className="helper-text">完成是一次短事务：任务状态、完成凭据与项目 State 一起提交。检查通过不等于完成，完成也不等于执行成功。</p><fieldset className="field" disabled={done || !allowedActions.includes("COMPLETE")}><legend className="field-label">必需验收条件（全部勾选才能完成）</legend>{!requiredCriteria.length && <p className="field-hint">当前验收版本没有必需条件。</p>}{requiredCriteria.map((criterion) => <label key={criterion.criterionId} className="choice-option"><input type="checkbox" checked={acceptedCriterionIds.includes(criterion.criterionId)} data-testid={`criterion-${criterion.criterionId}`} onChange={(event) => toggleCriterion(criterion.criterionId, event.target.checked)} /><span>{criterion.statement}<small>方式：{criterion.method}</small></span></label>)}</fieldset><label className="field"><span className="field-label">接受说明</span><input value={acceptanceStatement} onChange={(event) => setAcceptanceStatement(event.target.value)} name="completion-statement" disabled={done} /></label><label className="field"><span className="field-label">补充理由（可选）</span><input value={acceptanceReason} onChange={(event) => setAcceptanceReason(event.target.value)} name="completion-reason" disabled={done} /></label><p className="helper-text">将随完成提交的产物版本：{selectedVersion ? `v${selectedVersion.versionNumber}` : "无（该任务未声明产物要求时允许为空集合）"}</p><div className="form-actions"><button className="primary-button" type="button" data-testid="task-complete" disabled={!canComplete} onClick={() => void completeTask()}><Check aria-hidden="true" />{completing ? "正在提交" : "完成本轮"}</button></div>{!done && !allowedActions.includes("COMPLETE") && <p className="disabled-reason" data-testid="task-complete-reason"><Info aria-hidden="true" />服务端未投影 COMPLETE：只有进行中的人工任务可以完成。</p>}{done && <p className="disabled-reason" data-testid="task-complete-done"><Info aria-hidden="true" />该任务当前已完成；需要再次编辑请先重开。</p>}{completionReceipt && <p className="receipt-message" role="status" data-testid="task-complete-receipt">{completionReceipt}</p>}{completionFailure && <p className="action-error" role="alert">{completionFailure.message}</p>}{completionFailure?.kind === "transport" && <button className="secondary-button" type="button" disabled={completing} onClick={() => void lookupCompleteReceipt()}>查询本次完成回执</button>}</section>
    {(done || allowedActions.includes("REOPEN") || reopenReceipt) && <section className="surface-panel" data-testid="task-reopen"><h2>重开任务</h2><p className="helper-text">重开会建立新的验收版本并回到可开始；旧完成凭据与历史版本都保留，不会被删除或改写。</p><label className="field"><span className="field-label">重开原因<span className="field-required" aria-hidden="true">*</span></span><input value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} name="reopen-reason" /></label><div className="form-actions"><button className="secondary-button" type="button" data-testid="task-reopen-submit" disabled={!canReopen} onClick={() => void reopenTask()}><RotateCcw aria-hidden="true" />{reopening ? "正在重开" : "重开任务"}</button></div>{reopenReceipt && <p className="receipt-message" role="status" data-testid="task-reopen-receipt">{reopenReceipt}</p>}{reopenFailure && <p className="action-error" role="alert">{reopenFailure.message}</p>}{reopenFailure?.kind === "transport" && <button className="secondary-button" type="button" data-testid="task-reopen-receipt-query" disabled={reopening} onClick={() => void lookupReopenReceipt()}>查询本次重开回执</button>}</section>}
    <p className="helper-text"><FileText aria-hidden="true" />当前任务的 Run 步骤与控制请在“执行记录”页签打开；这里仅处理人工产物与完成。</p>
  </>;
}
