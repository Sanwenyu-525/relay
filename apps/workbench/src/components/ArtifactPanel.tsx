import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FileText, Info, Save } from "lucide-react";
import SafeMarkdown from "./SafeMarkdown";
import TaskCompletionPanel from "./TaskCompletionPanel";
import { artifactVersionResultFrom, createCommandId, RelayApiError, RelayTransportError, stateMutationFrom, type RelayAcceptanceCriterion, type RelayArtifactVersionResult, type RelayProjectState, type RelayTaskArtifacts } from "../api/relayClient";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { taskStatusLabels } from "../lib/labels";
import { describeLiveError, type LiveActionError } from "../lib/liveErrors";
import { liveClient } from "../lib/relayConnection";
import { handleTabListKeyDown } from "../lib/tabNavigation";
import type { DecimalRevision, TaskStatus } from "../types";
import "./ArtifactPanel.css";

interface Props {
  documentHeader?: ReactNode;
  sourceUnavailable?: boolean;
  taskId: string; projectId: string | null; taskStatus: TaskStatus; taskRevision: DecimalRevision;
  acceptanceRevision: DecimalRevision; criteria: readonly RelayAcceptanceCriterion[];
  allowedActions: readonly string[] | null; writeBlockedReason: string | null; onRefresh: () => void;
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

interface DraftBase {
  readonly taskId: string;
  readonly taskRevision: DecimalRevision;
  readonly artifactId: string;
  readonly artifactRevision: DecimalRevision;
  readonly versionId: string;
}

function contentReadError(caught: unknown): string {
  if (caught instanceof RelayApiError && (caught.problem.status === 403 || caught.problem.status === 404 ||
    caught.problem.code === "EVIDENCE_UNAVAILABLE")) return "该版本正文暂不可用，请核对权限后重试；不会用其他版本替代。";
  if (caught instanceof RelayTransportError) return "正文读取失败：无法连接本机服务，请检查连接后重试。";
  return describeLiveError(caught).message;
}

export default function ArtifactPanel(props: Props) {
  const { documentHeader, sourceUnavailable: taskUnavailable = false, taskId, projectId, taskStatus, taskRevision, acceptanceRevision, criteria, allowedActions, writeBlockedReason, onRefresh } = props;
  const [title, setTitle] = useState("任务产物");
  const [content, setContent] = useState("");
  const [documentMode, setDocumentMode] = useState<"saved" | "edit" | "preview" | null>(null);
  const [readingVersionId, setReadingVersionId] = useState<string | null>(null);
  const [reading, setReading] = useState<{ versionId: string; content: string } | null>(null);
  const [readingLoading, setReadingLoading] = useState(false);
  const [readingFailure, setReadingFailure] = useState<string | null>(null);
  const [conflictReading, setConflictReading] = useState<{ versionId: string; content: string } | null>(null);
  const [conflictReadingLoading, setConflictReadingLoading] = useState(false);
  const [conflictReadingFailure, setConflictReadingFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveReceipt, setSaveReceipt] = useState<string | null>(null);
  const [saveFailure, setSaveFailure] = useState<LiveActionError | null>(null);
  const [savePending, setSavePending] = useState<PendingSave | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftFailure, setDraftFailure] = useState<string | null>(null);
  const [draftBase, setDraftBase] = useState<DraftBase | null>(null);
  const [rebasing, setRebasing] = useState(false);
  const [rebaseFailure, setRebaseFailure] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [artifactSnapshot, setArtifactSnapshot] = useState<{ taskId: string; data: RelayTaskArtifacts } | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [versionsFailure, setVersionsFailure] = useState<string | null>(null);
  const [artifactUnavailable, setArtifactUnavailable] = useState(false);
  const [state, setState] = useState<RelayProjectState | null>(null);
  const [selectFailure, setSelectFailure] = useState<LiveActionError | null>(null);
  const [stateFailure, setStateFailure] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectReceipt, setSelectReceipt] = useState<string | null>(null);
  const disposed = useRef(false);
  const artifactsRequest = useRef(0);
  const draftRequest = useRef(0);
  const readingRequest = useRef(0);
  const conflictReadingRequest = useRef(0);
  const stateRequest = useRef(0);
  const command = useRef({ select: null as string | null, complete: null as string | null, reopen: null as string | null });
  const pendingSave = useRef<PendingSave | null>(null);
  const acceptanceRound = useRef({ taskId, revision: acceptanceRevision });
  const savedContentSnapshot = useRef("");
  const contentRef = useRef(content);
  contentRef.current = content;
  const guard = useRef<DraftGuard>({ hasUnsavedChanges: () => contentRef.current !== savedContentSnapshot.current, discard: () => { contentRef.current = savedContentSnapshot.current; setContent(savedContentSnapshot.current); } });
  const live = allowedActions !== null;
  const sourceUnavailable = taskUnavailable || artifactUnavailable;
  const unavailableRef = useRef(sourceUnavailable);
  unavailableRef.current = sourceUnavailable;
  const taskUnavailableRef = useRef(taskUnavailable);
  taskUnavailableRef.current = taskUnavailable;
  const artifacts = !sourceUnavailable && artifactSnapshot?.taskId === taskId ? artifactSnapshot.data : null;
  const humanArtifact = artifacts?.items.filter((item) => item.versions.some((version) => version.sourceKind === "HUMAN")).at(-1) ?? null;
  const latestHumanVersion = humanArtifact?.versions.find((version) => version.artifactVersionId === humanArtifact.latestVersionId) ?? null;
  const latest = humanArtifact && latestHumanVersion ? {
    artifactId: humanArtifact.id, artifactRevision: humanArtifact.revision,
    versionId: latestHumanVersion.artifactVersionId, versionNumber: latestHumanVersion.versionNumber
  } : null;
  const versions = artifacts?.items.flatMap((artifact) => artifact.versions.map((version) => ({
    artifactId: artifact.id, versionId: version.artifactVersionId, versionNumber: version.versionNumber,
    title: artifact.title, sha256: version.sha256, size: version.size, createdAt: version.createdAt,
    sourceKind: version.sourceKind
  }))) ?? [];
  const selectedVersion = !versionsLoading && !versionsFailure
    ? versions.find((version) => version.versionId === selectedVersionId) ?? null : null;
  const selectedByProject = sourceUnavailable ? [] : state?.selectedArtifactVersionRefs ?? [];
  const contentBytes = new TextEncoder().encode(sourceUnavailable && content === savedContentSnapshot.current ? "" : content).length;
  const contentTooLarge = contentBytes > CONTENT_LIMIT_BYTES;
  const done = taskStatus === "DONE";
  const versionsReady = artifacts !== null && !versionsLoading && versionsFailure === null;
  const baseChanged = !sourceUnavailable && draftBase !== null && (draftBase.taskId !== taskId || draftBase.taskRevision !== taskRevision ||
    draftBase.artifactId !== latest?.artifactId || draftBase.artifactRevision !== latest.artifactRevision ||
    draftBase.versionId !== latest.versionId);
  const conflicting = !sourceUnavailable && (baseChanged || saveFailure?.kind === "conflict");
  const draftChanged = content !== savedContentSnapshot.current;
  const visibleDraftContent = sourceUnavailable && !draftChanged ? "" : content;
  const draftVersion = versions.find((version) => version.versionId === draftBase?.versionId) ?? null;
  const defaultReadingId = latest?.versionId ?? artifacts?.items.find((artifact) => artifact.latestVersionId)?.latestVersionId;
  const readingTarget = versions.find((version) => version.versionId === readingVersionId)
    ?? versions.find((version) => version.versionId === defaultReadingId) ?? null;
  const visibleReading = reading?.versionId === readingTarget?.versionId ? reading : null;
  const visibleConflictReading = conflictReading?.versionId === latest?.versionId ? conflictReading : null;
  const displayedMode = documentMode ?? (versions.length > 0 && !draftChanged ? "saved" : "edit");
  const canSave = live && writeBlockedReason === null && versionsReady && !baseChanged &&
    !conflicting && allowedActions.includes("SAVE_ARTIFACT_VERSION") &&
    !!content.trim() && !contentTooLarge && !saving && !draftLoading && !rebasing && savePending === null;

  async function loadArtifacts() {
    const client = liveClient();
    const request = ++artifactsRequest.current;
    if (!client || taskUnavailableRef.current) { setArtifactSnapshot(null); setVersionsLoading(false); return; }
    setVersionsLoading(true); setVersionsFailure(null);
    try {
      const loaded = await client.getTaskArtifacts(taskId);
      if (disposed.current || request !== artifactsRequest.current) return;
      setArtifactUnavailable(false);
      setArtifactSnapshot({ taskId, data: loaded });
      setSelectedVersionId((current) => {
        const allVersions = loaded.items.flatMap((item) => item.versions);
        return current && allVersions.some((version) => version.artifactVersionId === current)
          ? current : null;
      });
    } catch (caught) {
      if (!disposed.current && request === artifactsRequest.current) {
        const unavailable = caught instanceof RelayApiError && (caught.problem.status === 403 || caught.problem.status === 404);
        if (unavailable) { setArtifactUnavailable(true); setArtifactSnapshot(null); setSelectedVersionId(null); }
        setVersionsFailure(unavailable ? "产物版本暂不可读，请核对权限后重新读取。" : describeLiveError(caught).message);
      }
    } finally {
      if (!disposed.current && request === artifactsRequest.current) setVersionsLoading(false);
    }
  }

  async function loadState() {
    const client = liveClient();
    const request = ++stateRequest.current;
    if (!client || !projectId || unavailableRef.current) { setState(null); return; }
    try { const loaded = await client.getProjectState(projectId); if (!disposed.current && request === stateRequest.current) { setState(loaded); setStateFailure(null); } }
    catch (caught) { if (!disposed.current && request === stateRequest.current) setStateFailure(describeLiveError(caught).message); }
  }
  useEffect(() => { disposed.current = false; setDraftGuard(guard.current); return () => { disposed.current = true; artifactsRequest.current++; draftRequest.current++; readingRequest.current++; conflictReadingRequest.current++; stateRequest.current++; clearDraftGuard(guard.current); }; }, [taskId]);
  useEffect(() => { void loadArtifacts(); }, [taskId, projectId, taskRevision, taskUnavailable]);
  useEffect(() => { void loadState(); }, [taskId, projectId, taskRevision, sourceUnavailable]);
  useEffect(() => {
    if (!sourceUnavailable) return;
    draftRequest.current++; stateRequest.current++;
    setState(null); setSelectedVersionId(null); setDraftLoading(false);
    if (contentRef.current === savedContentSnapshot.current) {
      savedContentSnapshot.current = ""; contentRef.current = ""; setContent("");
    }
  }, [sourceUnavailable]);
  useEffect(() => {
    if (!versionsReady || !readingTarget) { readingRequest.current++; setReading(null); setReadingFailure(null); setReadingLoading(false); return; }
    void readVersion(readingTarget.versionId);
    return () => { readingRequest.current++; };
  }, [taskId, versionsReady, readingTarget?.versionId]);
  useEffect(() => {
    if (!conflicting || !versionsReady || !latest) { conflictReadingRequest.current++; setConflictReading(null); setConflictReadingFailure(null); setConflictReadingLoading(false); return; }
    void readConflictVersion(latest.versionId);
    return () => { conflictReadingRequest.current++; };
  }, [taskId, conflicting, versionsReady, latest?.versionId]);
  useEffect(() => {
    if (acceptanceRound.current.taskId === taskId && acceptanceRound.current.revision === acceptanceRevision) return;
    acceptanceRound.current = { taskId, revision: acceptanceRevision };
    resetAcceptanceSelection();
  }, [taskId, acceptanceRevision]);
  function resetAcceptanceSelection() { setSelectedVersionId(null); }
  async function readVersion(versionId: string) {
    const client = liveClient(); if (!client || unavailableRef.current) return;
    const request = ++readingRequest.current;
    setReading(null); setReadingLoading(true); setReadingFailure(null);
    try {
      const body = await client.getArtifactVersionContent(versionId);
      if (!disposed.current && request === readingRequest.current) setReading({ versionId, content: body });
    } catch (caught) { if (!disposed.current && request === readingRequest.current) setReadingFailure(contentReadError(caught)); }
    finally { if (!disposed.current && request === readingRequest.current) setReadingLoading(false); }
  }
  async function readConflictVersion(versionId: string) {
    const client = liveClient(); if (!client || unavailableRef.current) return;
    const request = ++conflictReadingRequest.current;
    setConflictReading(null); setConflictReadingLoading(true); setConflictReadingFailure(null);
    try {
      const body = await client.getArtifactVersionContent(versionId);
      if (!disposed.current && request === conflictReadingRequest.current) setConflictReading({ versionId, content: body });
    } catch (caught) { if (!disposed.current && request === conflictReadingRequest.current) setConflictReadingFailure(contentReadError(caught)); }
    finally { if (!disposed.current && request === conflictReadingRequest.current) setConflictReadingLoading(false); }
  }
  function remember(result: RelayArtifactVersionResult, attempt: PendingSave) {
    savedContentSnapshot.current = attempt.content;
    setDraftBase({ taskId: result.taskId, taskRevision: result.taskRevision, artifactId: result.artifactId,
      artifactRevision: result.artifactRevision, versionId: result.versionId });
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
  function editContent(value: string) {
    if (!draftBase && latest && versionsReady && value !== savedContentSnapshot.current) setDraftBase({
      taskId, taskRevision, artifactId: latest.artifactId, artifactRevision: latest.artifactRevision, versionId: latest.versionId
    });
    contentRef.current = value; setContent(value); setDocumentMode("edit");
  }
  async function loadLatestHumanDraft() {
    const client = liveClient();
    if (!client || unavailableRef.current || !latest || !humanArtifact || draftLoading || saving || savePending || done ||
      contentRef.current !== savedContentSnapshot.current) return;
    const expectedContent = contentRef.current;
    const token = ++draftRequest.current;
    setDraftLoading(true); setDraftFailure(null);
    try {
      const [body, current] = await Promise.all([
        client.getArtifactVersionContent(latest.versionId), client.getArtifact(humanArtifact.id)
      ]);
      if (disposed.current || token !== draftRequest.current) return;
      if (current.id !== humanArtifact.id || current.latestVersionId !== latest.versionId ||
        current.revision !== latest.artifactRevision)
        throw new Error("最新人工版本已变化；请刷新任务事实后再起草。");
      if (contentRef.current !== expectedContent) throw new Error("读取期间草稿发生变化，已保留你的输入。");
      savedContentSnapshot.current = body;
      setDraftBase({ taskId, taskRevision, artifactId: current.id,
        artifactRevision: current.revision, versionId: latest.versionId });
      editContent(body);
    } catch (caught) { if (!disposed.current && token === draftRequest.current) setDraftFailure(describeLiveError(caught).message); }
    finally { if (!disposed.current && token === draftRequest.current) setDraftLoading(false); }
  }
  async function confirmCurrentBase() {
    const client = liveClient();
    if (!client || !draftBase || !humanArtifact || !latest || !versionsReady || rebasing || saving || savePending || done) return;
    setRebasing(true); setRebaseFailure(null);
    try {
      const [task, artifact] = await Promise.all([client.getTask(taskId), client.getArtifact(draftBase.artifactId)]);
      if (disposed.current) return;
      if (task.id !== taskId || artifact.id !== draftBase.artifactId || artifact.taskId !== taskId ||
        !artifact.latestVersionId || !task.allowedActions.includes("SAVE_ARTIFACT_VERSION"))
        throw new Error("当前任务或产物不允许继续修订；草稿已保留。");
      if (task.revision !== taskRevision || artifact.revision !== latest.artifactRevision ||
        artifact.latestVersionId !== latest.versionId) {
        onRefresh();
        void loadArtifacts();
        throw new Error("确认时版本又发生变化；已重新读取，请查看新版本后再次确认。草稿已保留。");
      }
      setDraftBase({ taskId, taskRevision: task.revision, artifactId: artifact.id,
        artifactRevision: artifact.revision, versionId: artifact.latestVersionId });
      setSaveFailure(null);
      onRefresh();
      await loadArtifacts();
    } catch (caught) { if (!disposed.current) setRebaseFailure(describeLiveError(caught).message); }
    finally { if (!disposed.current) setRebasing(false); }
  }
  async function saveVersion() {
    const client = liveClient();
    if (!client || !canSave || pendingSave.current) return;
    const attempt: PendingSave = latest ? {
      kind: "append", commandId: createCommandId(), taskId,
      expectedTaskRevision: draftBase?.taskRevision ?? taskRevision, artifactId: draftBase?.artifactId ?? latest.artifactId,
      expectedArtifactRevision: draftBase?.artifactRevision ?? latest.artifactRevision, mediaType: MEDIA_TYPE, content
    } : {
      kind: "create", commandId: createCommandId(), taskId,
      expectedTaskRevision: taskRevision, title: title.trim(), mediaType: MEDIA_TYPE, content
    };
    if (!draftBase && attempt.kind === "append" && latest) setDraftBase({ taskId,
      taskRevision: attempt.expectedTaskRevision, artifactId: attempt.artifactId,
      artifactRevision: attempt.expectedArtifactRevision, versionId: latest.versionId });
    pendingSave.current = attempt; setSavePending(attempt);
    setSaving(true); setSaveFailure(null); setSaveReceipt(null);
    try {
      const result = attempt.kind === "append" ? await client.submitArtifactVersion(attempt) : await client.createArtifactWithVersion(attempt);
      if (disposed.current) return;
      settleSave(result, attempt, attempt.kind === "append" ? `已保存新版本 v${result.versionNumber}（sha256 ${result.sha256.slice(0, 12)}…，${result.size} 字节）。上一版本保持不变。` : `已创建产物并保存 v${result.versionNumber}（sha256 ${result.sha256.slice(0, 12)}…，${result.size} 字节）。旧版本不会被覆盖。`);
    } catch (caught) {
      if (disposed.current) return;
      const failure = describeLiveError(caught); setSaveFailure(failure);
      if (caught instanceof RelayApiError && DEFINITIVE_SAVE_REJECTIONS.has(caught.problem.code)) { pendingSave.current = null; setSavePending(null); }
      if (failure.kind === "conflict") { onRefresh(); void loadArtifacts(); }
    }
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
    if (!client || writeBlockedReason !== null || !versionsReady || !selectedVersion || !projectId || !state || selecting) return;
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
  if (!live) return <>{documentHeader}<section className="surface-panel" data-testid="artifact-fixture-gap"><h2>产物与完成</h2><p className="helper-text">示例数据没有产物事实，因此这里不展示任何产物、版本或完成凭据，也不提供可点的保存按钮。连接本机 API 后，产物版本、选择接受与人工完成会写入真实 PostgreSQL。</p></section></>;
  const editor = <>
    <label className="visually-hidden" htmlFor="artifact-content">Markdown 内容</label>
    <textarea id="artifact-content" value={visibleDraftContent} onChange={(event) => editContent(event.target.value)}
      className="markdown-editor" name="artifact-content" rows={16}
      disabled={done || !allowedActions.includes("SAVE_ARTIFACT_VERSION")}
      placeholder="用 Markdown 写这一轮的成果；保存后生成新的不可变版本。" />
  </>;
  const savedBody = <>
    {readingLoading && <p className="helper-text" role="status" data-testid="artifact-content-loading">正在读取 v{readingTarget?.versionNumber} 的确切正文…</p>}
    {readingFailure && <div className="artifact-paper-state" role="alert" data-testid="artifact-content-error">
      <h3>正文读取失败</h3><p className="helper-text">{readingFailure}</p>
      <button className="secondary-button" type="button" data-testid="artifact-content-retry"
        onClick={() => { if (readingTarget) void readVersion(readingTarget.versionId); }}>重试读取正文</button>
    </div>}
    {visibleReading && <div data-testid="artifact-saved-content"><SafeMarkdown source={visibleReading.content} /></div>}
    {!readingTarget && !versionsLoading && <div className="artifact-paper-state"><h3>{sourceUnavailable ? "已保存正文暂不可读" : "还没有已保存的正文"}</h3><p className="helper-text">{sourceUnavailable ? "旧正文与版本事实已隐藏；你的未保存输入与原命令仍保留。" : "在“编辑”中写下成果，保存首版后即可阅读确切版本。"}</p></div>}
  </>;
  const ArtifactHeading = documentHeader ? "h1" : "h2";
  return <div className={`artifact-workspace${documentHeader ? " artifact-workspace--with-header" : ""}${conflicting ? " artifact-workspace--conflict" : ""}`} data-testid="artifact-workspace">
    <section className="artifact-document" aria-label="产物正文与草稿" data-testid="artifact-editor">
      {documentHeader}
      <header className="artifact-document-heading">
        <p className="eyebrow">{conflicting ? "版本冲突与草稿保留" : "任务产物"}</p>
        <ArtifactHeading>{conflicting ? "有更新的版本，先核对差异" : displayedMode === "saved" ? readingTarget?.title ?? title : humanArtifact?.title ?? title}</ArtifactHeading>
        <p className="helper-text">{conflicting ? "对比当前版本与我的草稿，确认需要保留或调整的内容。" : displayedMode === "saved" && readingTarget ? `v${readingTarget.versionNumber} · 已保存版本` : "本轮草稿 · 尚未保存"}</p>
      </header>
      {sourceUnavailable && <p className="warning-callout" role="status" data-testid="artifact-source-unavailable">产物来源暂不可读。旧正文、名称与版本事实已隐藏；仅保留你的未保存输入与原命令。</p>}
      <div className="artifact-document-status">
        <div className="artifact-status-tags">
          <span className={`status-chip${draftChanged ? " status-chip--warning" : " status-chip--neutral"}`} data-testid="artifact-draft-status">
            {saving ? "保存中 · 草稿保留" : savePending ? "保存结果待核对" : draftChanged ? "草稿未保存" : draftBase ? "草稿与保存基线一致" : "草稿未开始"}
          </span>
        </div>
        <span className="helper-text">Markdown · {displayedMode === "saved" && !conflicting ? readingTarget?.size ?? "0" : contentBytes} 字节</span>
      </div>
      {versionsReady && versions.length > 0 && <nav className="artifact-version-strip" aria-label="阅读产物版本">
        {versions.map((version) => <button key={version.versionId} type="button"
          className={`secondary-button${readingTarget?.versionId === version.versionId ? " artifact-version-tab--active" : ""}`}
          data-testid={`artifact-read-${version.versionId}`} aria-current={readingTarget?.versionId === version.versionId ? "true" : undefined}
          title={`${version.title} · ${version.versionId}`} onClick={() => { setReadingVersionId(version.versionId); setDocumentMode("saved"); }}>
          v{version.versionNumber}{selectedByProject.some((ref) => ref.artifactVersionId === version.versionId) ? " · 当前选用" : ""}{artifacts?.items.some((item) => item.latestVersionId === version.versionId) ? " · 最新" : ""}
        </button>)}
      </nav>}
      {baseChanged && <p className="warning-callout" data-testid="artifact-draft-base-changed">当前任务或产物已不同于草稿基线；草稿仍保留，保存已暂停。请查看最新版本差异，再明确确认新基线。</p>}
      {saveFailure?.kind === "conflict" && <div className="warning-callout" role="alert" data-testid="artifact-save-conflict"><strong>{saveFailure.message}</strong><p>草稿已保留在编辑器里，没有被覆盖。确认新基线不会自动合并正文。</p></div>}
      {conflicting ? <div className="artifact-conflict-columns" data-testid="artifact-conflict-comparison">
        <article className="artifact-paper artifact-conflict-draft">
          <header className="artifact-paper-heading"><h3>我的草稿 · 基于 {draftVersion ? `v${draftVersion.versionNumber}` : "原基线"}</h3><p className="helper-text">未保存 · {contentBytes} 字节</p></header>
          {editor}
        </article>
        <article className="artifact-paper" data-testid="artifact-conflict-current">
          <header className="artifact-paper-heading"><h3>当前版本 · {latest ? `v${latest.versionNumber}` : "尚未核实"}</h3><p className="helper-text">已保存版本 · 只读核对</p></header>
          {versionsLoading || conflictReadingLoading ? <p className="helper-text" role="status">正在读取当前确切版本…</p>
            : versionsFailure ? <div className="artifact-paper-state" role="alert"><p>{versionsFailure}</p><button className="secondary-button" type="button" onClick={() => void loadArtifacts()}>重新读取产物</button></div>
              : conflictReadingFailure ? <div className="artifact-paper-state" role="alert" data-testid="artifact-conflict-content-error"><h3>当前正文读取失败</h3><p className="helper-text">{conflictReadingFailure}</p><button className="secondary-button" type="button" data-testid="artifact-conflict-content-retry" onClick={() => { if (latest) void readConflictVersion(latest.versionId); }}>重试读取当前正文</button></div>
                : visibleConflictReading ? <SafeMarkdown source={visibleConflictReading.content} /> : <p className="helper-text">当前版本尚未核实，不会显示其他版本的正文。</p>}
        </article>
      </div> : <section className="artifact-paper" aria-label="产物正文">
        <nav className="artifact-document-tabs" role="tablist" aria-label="产物正文展示" onKeyDown={handleTabListKeyDown}>
          {([{ key: "saved", label: "已保存正文" }, { key: "edit", label: "编辑" }, { key: "preview", label: "预览" }] as const).map((item) =>
            <button key={item.key} type="button" role="tab" id={`artifact-tab-${taskId}-${item.key}`} aria-controls={`artifact-content-${taskId}`} aria-selected={displayedMode === item.key} tabIndex={displayedMode === item.key ? 0 : -1}
              className={`artifact-document-tab${displayedMode === item.key ? " artifact-document-tab--active" : ""}`}
              data-testid={`artifact-mode-${item.key}`} onClick={() => setDocumentMode(item.key)}>{item.label}</button>)}
        </nav>
        <div role="tabpanel" id={`artifact-content-${taskId}`} aria-labelledby={`artifact-tab-${taskId}-${displayedMode}`} tabIndex={0}>{displayedMode === "saved" ? <div className="artifact-paper-body">{savedBody}</div>
          : displayedMode === "preview" ? <div className="artifact-paper-body" data-testid="artifact-draft-preview">{visibleDraftContent.trim() ? <SafeMarkdown source={visibleDraftContent} /> : <p className="helper-text">草稿为空；在“编辑”中输入后查看预览。</p>}</div> : editor}</div>
        <footer className="artifact-paper-footer"><span>{displayedMode === "saved" && readingTarget ? `v${readingTarget.versionNumber} · 已保存版本 · ${readingTarget.sourceKind === "HUMAN" ? "人工" : readingTarget.sourceKind}` : `本地草稿 · ${contentBytes} / ${CONTENT_LIMIT_BYTES} 字节`}</span></footer>
      </section>}
      {contentTooLarge && <p className="field-error" role="alert"><Info aria-hidden="true" />正文超过 256 KiB（按 UTF-8 字节判定），请拆分后再保存。</p>}
      <details className="artifact-version-history" data-testid="artifact-versions"><summary>版本详情与接受选择</summary><p className="helper-text">阅读选择与接受选择分别操作；“最新”“当前选用”和“本轮接受”分别来自版本、项目 State 与完成凭据。</p>
        {versionsLoading && <p className="helper-text" role="status">正在读取产物版本。</p>}
        {versionsFailure && <p className="action-error" role="alert">{versionsFailure} 草稿仍保留；产物列表尚未核实，暂不能保存或完成。<button className="secondary-button" type="button" onClick={() => void loadArtifacts()}>重新读取产物</button></p>}
        {versionsReady && (!versions.length ? <p className="helper-text">该任务尚无已保存的产物版本。</p> : <ul className="version-list">{versions.map((version) => <li key={version.versionId} className="version-row">
          <label className="version-choice"><input checked={selectedVersionId === version.versionId} onChange={() => setSelectedVersionId(version.versionId)} type="radio" name="artifact-version" value={version.versionId} data-testid={`artifact-version-${version.versionId}`} /><span className="version-copy"><strong>v{version.versionNumber} · {version.title}</strong><small>sha256 {version.sha256.slice(0, 12)}… · {version.size} 字节</small></span></label>
          <span className="version-tags">{artifacts?.items.some((item) => item.latestVersionId === version.versionId) && <span className="status-chip">最新</span>}{selectedByProject.some((ref) => ref.artifactVersionId === version.versionId) && <span className="status-chip status-chip--neutral">当前选用</span>}{artifacts?.currentAcceptedVersionIds.includes(version.versionId) && <span className="status-chip status-chip--neutral">本轮接受</span>}</span>
          <div className="artifact-version-actions"><Link className="inline-link" to={`/artifact-versions/${version.versionId}/lineage`}>来源与差异</Link></div>
        </li>)}</ul>)}
      </details>
      <p className="helper-text artifact-run-note"><FileText aria-hidden="true" />Run 步骤与控制在“执行记录”页签查看。</p>
    </section>
    <aside className="artifact-action-rail" aria-label="产物保存与验收" data-testid="artifact-action-rail">
      <section className="artifact-save-section">
        <h2>{conflicting ? "选择如何继续" : "保存为新版本"}</h2>
        <p>{draftVersion ? `基于 v${draftVersion.versionNumber} 编辑` : latest ? `保存至 ${humanArtifact?.title} 的新版本` : "创建首个产物版本"}</p>
        <p className="helper-text">保存后创建不可变版本；新版本不继承原来的验收凭据。草稿只保留在当前页面。</p>
        {writeBlockedReason && <p className="disabled-reason" data-testid="artifact-project-write-blocked">{writeBlockedReason}</p>}
        {done ? <p className="warning-callout" role="status" data-testid="artifact-editor-locked"><Info aria-hidden="true" />该任务本轮已完成：编辑入口已关闭，请先在下方重开任务再保存新版本。</p> : !allowedActions.includes("SAVE_ARTIFACT_VERSION") && <p className="disabled-reason" data-testid="artifact-editor-reason"><Info aria-hidden="true" />服务端未投影 SAVE_ARTIFACT_VERSION：当前状态是{taskStatusLabels[taskStatus]}，只有进行中的人工任务可以保存产物。</p>}
        {!humanArtifact && <label className="field"><span className="field-label">产物名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} name="artifact-title" disabled={done || savePending !== null || !allowedActions.includes("SAVE_ARTIFACT_VERSION")} /></label>}
        <div className="form-actions"><button className="primary-button" type="button" data-testid="artifact-save" disabled={!canSave} onClick={() => void saveVersion()}><Save aria-hidden="true" />{saving ? "正在保存" : "保存新版本"}</button></div>
        {draftBase && conflicting && <div className="form-actions"><button className="secondary-button" type="button" data-testid="artifact-confirm-new-base" disabled={rebasing || saving || savePending !== null || !versionsReady || !latest || writeBlockedReason !== null || done} onClick={() => void confirmCurrentBase()}>{rebasing ? "正在核对" : `确认以当前 v${latest?.versionNumber ?? "?"} 为基线（保留草稿）`}</button>{latest && <Link className="inline-link" to={`/artifact-versions/${latest.versionId}/lineage`}>查看版本历史与差异</Link>}</div>}
        {rebaseFailure && <p className="action-error" role="alert">{rebaseFailure}</p>}
        {latest && <button className="secondary-button" type="button" data-testid="artifact-load-latest-draft" disabled={done || draftLoading || rebasing || saving || savePending !== null || !versionsReady || content !== savedContentSnapshot.current || !allowedActions.includes("SAVE_ARTIFACT_VERSION")} onClick={() => void loadLatestHumanDraft()}>{draftLoading ? "正在读取" : `从最新人工版本 v${latest.versionNumber} 起草修订`}</button>}
        {draftFailure && <p className="action-error" role="alert">{draftFailure}</p>}
        {draftBase && !sourceUnavailable && <details className="artifact-binding-details"><summary>草稿基线{draftVersion ? ` · v${draftVersion.versionNumber}` : ""} · 任务修订 v{draftBase.taskRevision}</summary><p className="helper-text" data-testid="artifact-draft-base">草稿修订基线：版本 {draftBase.versionId} · Artifact revision v{draftBase.artifactRevision} · Task revision v{draftBase.taskRevision}。</p></details>}
        {savePending && <p className="helper-text" data-testid="artifact-save-pending">原 command_id：{savePending.commandId}。原请求{savePending.kind === "create" ? "创建产物" : `续写产物 ${savePending.artifactId}`}，正文 {new TextEncoder().encode(savePending.content).length} 字节；结果未核对前不能提交新草稿。</p>}
        {saveReceipt && <p className="receipt-message" role="status" data-testid="artifact-save-receipt">{saveReceipt}</p>}
        {saveFailure && saveFailure.kind !== "conflict" && <p className="action-error" role="alert">{saveFailure.message}</p>}
        {savePending && !saving && <button className="secondary-button" type="button" data-testid="artifact-save-receipt-query" onClick={() => void lookupSaveReceipt()}>查询本次保存回执</button>}
      </section>
      <section className="artifact-selection-section"><h3>当前选用（来自项目 State）</h3>
        <label className="field"><span className="field-label">本轮核对的版本</span><select value={selectedVersionId ?? ""} data-testid="artifact-accept-version" disabled={!versionsReady} onChange={(event) => setSelectedVersionId(event.target.value || null)}><option value="">选择确切版本</option>{versions.map((version) => <option key={version.versionId} value={version.versionId}>v{version.versionNumber} · {version.title}</option>)}</select></label>
        {stateFailure ? <p className="action-error" role="alert">{stateFailure}</p> : projectId === null ? <p className="helper-text">该任务未归属项目：选择版本为当前选用是 Project State 命令，因此不可用。</p> : selectedByProject.length === 0 ? <p className="helper-text">项目 State 还没有选用任何产物版本。</p> : <ul className="version-list">{selectedByProject.map((ref) => <li key={ref.artifactVersionId} className="version-row"><span className="version-copy"><strong>v{ref.versionNumber}</strong><small>来源：{ref.sourceRef}</small></span></li>)}</ul>}
        <p className="helper-text">准备接受：{selectedVersion ? `v${selectedVersion.versionNumber} · ${selectedVersion.title}` : "尚未选择版本"}</p>
        {selectedVersion && <details className="artifact-binding-details"><summary>核对接受版本身份</summary><p className="helper-text" data-testid="artifact-selected-version">准备接受：v{selectedVersion.versionNumber} · {selectedVersion.title} · {selectedVersion.versionId}</p></details>}
        <button className="secondary-button" type="button" data-testid="artifact-select-version" disabled={writeBlockedReason !== null || !versionsReady || selecting || !selectedVersion || !projectId || !state} onClick={() => void selectVersion()}>{selecting ? "正在提交" : "选择这个版本为当前选用"}</button>
        <p className="helper-text">“当前选用”是项目级事实，与“本轮接受”不同；下方完成命令接受的是明确选择的确切版本。</p>
        {selectReceipt && <p className="receipt-message" role="status">{selectReceipt}</p>}{selectFailure && <p className="action-error" role="alert">{selectFailure.message}</p>}{selectFailure?.kind === "transport" && <button className="secondary-button" type="button" disabled={selecting} onClick={() => void lookupSelectReceipt()}>查询本次选择回执</button>}
      </section>
      <TaskCompletionPanel live={live} target={{ taskId, taskStatus, taskRevision, acceptanceRevision,
        allowedActions: sourceUnavailable ? [] : allowedActions, criteria: sourceUnavailable ? [] : criteria, acceptedVersion: selectedVersion ? { artifactVersionId: selectedVersion.versionId,
          versionNumber: selectedVersion.versionNumber } : null,
        writeBlockedReason: writeBlockedReason ?? (!versionsReady ? "产物列表尚未核实，暂不能完成。请重新读取产物后继续。" : null) }} onRefresh={onRefresh} />
    </aside>
  </div>;
}
