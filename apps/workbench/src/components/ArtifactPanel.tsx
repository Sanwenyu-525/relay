import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FileText, Info, Save } from "lucide-react";
import SafeMarkdown from "./SafeMarkdown";
import TaskCompletionPanel from "./TaskCompletionPanel";
import { artifactVersionResultFrom, createCommandId, RelayApiError, RelayTransportError, stateMutationFrom, type RelayAcceptanceCriterion, type RelayApiClient, type RelayArtifactVersionResult, type RelayProjectState, type RelayTaskArtifacts } from "../api/relayClient";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { taskStatusLabels } from "../lib/labels";
import { describeLiveError, needsReceiptCheck, type LiveActionError } from "../lib/liveErrors";
import { liveClient } from "../lib/relayConnection";
import { checkRecoveryNow, recoveryScope, recoveryStorageKey, registerRecoveryOwner, removeRecovery, subscribeRecoveries, upsertRecovery, type RecoveryRecord } from "../lib/commandRecovery";
import { sha256Hex } from "../lib/sha256";
import { handleTabListKeyDown } from "../lib/tabNavigation";
import type { DecimalRevision, TaskStatus } from "../types";
import "./ArtifactPanel.css";
import { Button } from "../ui";

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
  /** Missing only in durable records written before exact version binding. */
  readonly expectedVersionNumber?: DecimalRevision;
});

interface PendingSaveRecovery {
  readonly available: boolean;
  readonly attempt: PendingSave | null;
}

function pendingSaveKey(client: RelayApiClient, taskId: string): string {
  return `relay:artifact-save:v1:${encodeURIComponent(client.baseUrl)}:${encodeURIComponent(client.workspaceId)}:${taskId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecimalRevision(value: unknown): value is DecimalRevision {
  return typeof value === "string" && /^\d+$/u.test(value);
}

function isPendingSave(value: unknown, taskId: string): value is PendingSave {
  if (!isRecord(value) || typeof value.commandId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.commandId) ||
    value.taskId !== taskId || !isDecimalRevision(value.expectedTaskRevision) ||
    value.mediaType !== MEDIA_TYPE || typeof value.content !== "string" ||
    new TextEncoder().encode(value.content).byteLength > CONTENT_LIMIT_BYTES) return false;
  if (value.kind === "create") return typeof value.title === "string" && value.title.trim() !== "";
  return value.kind === "append" && typeof value.artifactId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.artifactId) &&
    isDecimalRevision(value.expectedArtifactRevision) &&
    (value.expectedVersionNumber === undefined || isDecimalRevision(value.expectedVersionNumber));
}

function readPendingSave(key: string, taskId: string): PendingSaveRecovery {
  let serialized: string | null;
  try {
    serialized = localStorage.getItem(key);
    if (serialized === null) {
      const legacy = sessionStorage.getItem(key);
      serialized = legacy;
      if (legacy !== null) {
        localStorage.setItem(key, legacy);
        sessionStorage.removeItem(key);
      }
    }
  } catch { return { available: false, attempt: null }; }
  if (serialized === null) return { available: true, attempt: null };
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value) || value.version !== 1 || value.taskId !== taskId ||
      !(value.pending === null || isPendingSave(value.pending, taskId))) return { available: false, attempt: null };
    return { available: true, attempt: value.pending };
  } catch { return { available: false, attempt: null }; }
}

function writePendingSave(key: string, attempt: PendingSave | null): boolean {
  try {
    if (attempt === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ version: 1, taskId: attempt.taskId, pending: attempt }));
    try { sessionStorage.removeItem(key); } catch { /* The durable record is already authoritative. */ }
    return true;
  } catch { return false; }
}

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
  const [savePendingScope, setSavePendingScope] = useState<string | null>(null);
  const [saveRecoveryScope, setSaveRecoveryScope] = useState<string | null>(null);
  const [saveRecoveryAvailable, setSaveRecoveryAvailable] = useState(false);
  const [saveStorageWarning, setSaveStorageWarning] = useState(false);
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
  const [selectionPending, setSelectionPending] = useState<RecoveryRecord | null>(null);
  const [selectionChecking, setSelectionChecking] = useState(false);
  const selectionFlight = useRef<string | null>(null);
  const disposed = useRef(false);
  const artifactsRequest = useRef(0);
  const draftRequest = useRef(0);
  const readingRequest = useRef(0);
  const conflictReadingRequest = useRef(0);
  const stateRequest = useRef(0);
  const command = useRef({ select: null as string | null, complete: null as string | null, reopen: null as string | null });
  const pendingSave = useRef<PendingSave | null>(null);
  const pendingSaveScope = useRef<string | null>(null);
  const acceptanceRound = useRef({ taskId, revision: acceptanceRevision });
  const savedContentSnapshot = useRef("");
  const contentRef = useRef(content);
  contentRef.current = content;
  const guard = useRef<DraftGuard>({ hasUnsavedChanges: () => contentRef.current !== savedContentSnapshot.current, discard: () => { contentRef.current = savedContentSnapshot.current; setContent(savedContentSnapshot.current); } });
  const live = allowedActions !== null;
  const saveRecoveryClient = liveClient();
  const saveRecoveryKey = saveRecoveryClient ? pendingSaveKey(saveRecoveryClient, taskId) : null;
  const selectionScope = saveRecoveryClient && live && projectId ? recoveryScope(saveRecoveryClient) : null;
  const selectionKey = selectionScope === null ? null : `${selectionScope}:${taskId}:${projectId}`;
  const selectionKeyRef = useRef(selectionKey); selectionKeyRef.current = selectionKey;
  const saveRecoveryKeyRef = useRef(saveRecoveryKey);
  saveRecoveryKeyRef.current = saveRecoveryKey;
  const saveRecoveryReady = saveRecoveryKey !== null && saveRecoveryScope === saveRecoveryKey && saveRecoveryAvailable;
  const activeSavePending = saveRecoveryReady && savePendingScope === saveRecoveryKey ? savePending : null;
  const sourceUnavailable = taskUnavailable || artifactUnavailable;
  const unavailableRef = useRef(sourceUnavailable);
  unavailableRef.current = sourceUnavailable;
  const taskUnavailableRef = useRef(taskUnavailable);
  taskUnavailableRef.current = taskUnavailable;
  const artifacts = !sourceUnavailable && artifactSnapshot?.taskId === taskId ? artifactSnapshot.data : null;
  // ARTIFACT-HANDOFF-EDIT-20261105：草稿基线固定后不随阅读切换；AI 原版也可在接手后续写。
  const editableArtifact = artifacts?.items.find((item) => item.id === draftBase?.artifactId)
    ?? artifacts?.items.find((item) => item.versions.some((version) => version.artifactVersionId === readingVersionId))
    ?? artifacts?.items.filter((item) => item.versions.some((version) => version.sourceKind === "HUMAN")).at(-1)
    ?? artifacts?.items.at(-1) ?? null;
  const latestEditableVersion = editableArtifact?.versions.find((version) => version.artifactVersionId === editableArtifact.latestVersionId) ?? null;
  const latest = editableArtifact && latestEditableVersion ? {
    artifactId: editableArtifact.id, artifactRevision: editableArtifact.revision,
    versionId: latestEditableVersion.artifactVersionId, versionNumber: latestEditableVersion.versionNumber
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
  const canSave = live && saveRecoveryReady && !saveStorageWarning && writeBlockedReason === null && versionsReady && !baseChanged &&
    !conflicting && allowedActions.includes("SAVE_ARTIFACT_VERSION") &&
    !!content.trim() && !contentTooLarge && !saving && !draftLoading && !rebasing && activeSavePending === null;

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
  useEffect(() => {
    if (saveRecoveryKey === null) {
      pendingSave.current = null; pendingSaveScope.current = null;
      setSavePending(null); setSavePendingScope(null); setSaveRecoveryScope(null);
      setSaveRecoveryAvailable(false); setSaveStorageWarning(false);
      return;
    }
    const restored = readPendingSave(saveRecoveryKey, taskId);
    pendingSave.current = restored.attempt;
    pendingSaveScope.current = restored.attempt === null ? null : saveRecoveryKey;
    setSavePending(restored.attempt); setSavePendingScope(restored.attempt === null ? null : saveRecoveryKey);
    setSaveRecoveryScope(saveRecoveryKey); setSaveRecoveryAvailable(restored.available);
    setSaveStorageWarning(!restored.available);
    setSaving(false); setSaveFailure(null); setSaveReceipt(null);
  }, [saveRecoveryKey, taskId]);
  // ARTIFACT-SELECTION-RECOVERY-20261106：原选择只核对，不把新候选塞进旧 command_id。
  useEffect(() => {
    setSelecting(false);
    if (selectionScope === null || selectionKey === null || saveRecoveryClient === null || projectId === null) {
      command.current.select = null; setSelectionPending(null); return;
    }
    const client = saveRecoveryClient, scope = selectionScope, requestKey = selectionKey;
    let active = true;
    const matches = (record: RecoveryRecord) => record.commandType === "SetProjectState" &&
      record.targetKind === "TASK" && record.targetId === taskId && record.sessionId === null && typeof record.objectId === "string";
    const unsubscribe = subscribeRecoveries(scope, (entries) => {
      const entry = entries.find((item) => matches(item.record));
      command.current.select = entry?.record.commandId ?? null;
      setSelectionPending(entry?.record ?? null);
      setSelectionChecking(entry?.phase === "CHECKING" || entry?.phase === "RETRYING");
      if (entry?.error) setSelectFailure({ kind: "unknown", message: `原选择结果尚待核对。${entry.error}`, fieldErrors: [] });
    });
    const unregister = registerRecoveryOwner({ scope,
      claims: (record) => matches(record) && selectionFlight.current !== record.commandId,
      verify(record, receipt) {
        if (receipt.commandId !== record.commandId || receipt.commandType !== "SetProjectState") return "IDENTITY_MISMATCH";
        try {
          const mutation = stateMutationFrom(receipt.result);
          return mutation.projectId === projectId && mutation.action === "SELECT_ARTIFACT_VERSION" ? null : "IDENTITY_MISMATCH";
        } catch { return "MALFORMED"; }
      },
      async apply(record, receipt) {
        if (!active) return "KEPT";
        return await confirmSelection(client, scope, requestKey, record, stateMutationFrom(receipt.result)) ? "APPLIED" : "KEPT";
      },
      fetchReceipt: (commandId, signal) => client.getCommandReceipt(commandId, signal)
    });
    const selectionGuard: DraftGuard = {
      hasUnsavedChanges: () => command.current.select !== null, discard: () => undefined,
      pendingCommandId: () => command.current.select,
      pendingCommandState: () => selectionFlight.current === command.current.select && command.current.select !== null ? "IN_FLIGHT" : command.current.select ? "UNRESOLVED" : null,
      pendingRecoversAfterLeave: () => {
        try {
          const stored: unknown = JSON.parse(sessionStorage.getItem(recoveryStorageKey(scope)) ?? "[]");
          return Array.isArray(stored) && stored.some((item) => item.commandId === command.current.select);
        } catch { return false; }
      }
    };
    setDraftGuard(selectionGuard);
    return () => { active = false; unsubscribe(); unregister(); clearDraftGuard(selectionGuard); };
  }, [saveRecoveryClient, selectionScope, selectionKey, taskId, projectId]);
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
  function persistPendingSave(key: string, attempt: PendingSave | null): boolean {
    const saved = writePendingSave(key, attempt);
    pendingSave.current = attempt;
    pendingSaveScope.current = attempt === null ? null : key;
    setSavePending(attempt); setSavePendingScope(attempt === null ? null : key);
    setSaveStorageWarning(!saved);
    return saved;
  }
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
    const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
    const contentBytes = new TextEncoder().encode(attempt.content).byteLength;
    if (result.taskId !== attempt.taskId || !isUuid(result.artifactId) || !isUuid(result.versionId) ||
      result.mediaType !== attempt.mediaType || !/^[0-9a-f]{64}$/u.test(result.sha256) ||
      result.sha256 !== sha256Hex(attempt.content) || BigInt(result.size) !== BigInt(contentBytes) ||
      !isDecimalRevision(result.versionNumber) || BigInt(result.versionNumber) < 1n ||
      !isDecimalRevision(result.artifactRevision) ||
      !isDecimalRevision(result.taskRevision) ||
      BigInt(result.taskRevision) !== BigInt(attempt.expectedTaskRevision) + 1n) return false;
    if (attempt.kind === "append") return result.artifactId === attempt.artifactId &&
      BigInt(result.artifactRevision) > BigInt(attempt.expectedArtifactRevision) &&
      (attempt.expectedVersionNumber === undefined ||
        BigInt(result.versionNumber) === BigInt(attempt.expectedVersionNumber) + 1n);
    return BigInt(result.versionNumber) === 1n && BigInt(result.artifactRevision) === 0n;
  }
  function settleSave(result: RelayArtifactVersionResult, attempt: PendingSave, receipt: string, requestScope: string) {
    if (!saveResultMatches(result, attempt)) throw new RelayTransportError("保存结果与原请求的产物版本不符，请核对原 command_id。");
    if (saveRecoveryKeyRef.current !== requestScope || disposed.current) return;
    const cleared = persistPendingSave(requestScope, null);
    remember(result, attempt);
    setSaveReceipt(`${receipt}${contentRef.current === attempt.content ? "" : "当前草稿仍未保存。"}`);
    if (!cleared) setSaveFailure({ kind: "unknown", message: "保存回执已核实，但本机无法清理持久恢复副本；重新打开后仍会按原 command_id 查询。", fieldErrors: [] });
    onRefresh();
  }
  function editContent(value: string) {
    if (!draftBase && latest && versionsReady && value !== savedContentSnapshot.current) setDraftBase({
      taskId, taskRevision, artifactId: latest.artifactId, artifactRevision: latest.artifactRevision, versionId: latest.versionId
    });
    contentRef.current = value; setContent(value); setDocumentMode("edit");
  }
  async function loadLatestDraft() {
    const client = liveClient();
    if (!client || unavailableRef.current || !latest || !editableArtifact || draftLoading || saving || activeSavePending || done ||
      contentRef.current !== savedContentSnapshot.current) return;
    const expectedContent = contentRef.current;
    const token = ++draftRequest.current;
    setDraftLoading(true); setDraftFailure(null);
    try {
      const [body, current] = await Promise.all([
        client.getArtifactVersionContent(latest.versionId), client.getArtifact(editableArtifact.id)
      ]);
      if (disposed.current || token !== draftRequest.current) return;
      if (current.id !== editableArtifact.id || current.latestVersionId !== latest.versionId ||
        current.revision !== latest.artifactRevision)
        throw new Error("最新版本已变化；请刷新任务事实后再起草。");
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
    if (!client || !draftBase || !editableArtifact || !latest || !versionsReady || rebasing || saving || activeSavePending || done) return;
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
  async function submitSaveAttempt(client: NonNullable<ReturnType<typeof liveClient>>, requestScope: string, attempt: PendingSave) {
    if (saving || saveRecoveryKeyRef.current !== requestScope || disposed.current) return;
    setSaving(true); setSaveFailure(null); setSaveReceipt(null);
    try {
      const result = attempt.kind === "append" ? await client.submitArtifactVersion(attempt) : await client.createArtifactWithVersion(attempt);
      if (disposed.current || saveRecoveryKeyRef.current !== requestScope) return;
      const receipt = attempt.kind === "append"
        ? `已保存新版本 v${result.versionNumber}（sha256 ${result.sha256.slice(0, 12)}…，${result.size} 字节）。上一版本保持不变。`
        : `已创建产物并保存 v${result.versionNumber}（sha256 ${result.sha256.slice(0, 12)}…，${result.size} 字节）。旧版本不会被覆盖。`;
      settleSave(result, attempt, receipt, requestScope);
    } catch (caught) {
      if (disposed.current || saveRecoveryKeyRef.current !== requestScope) return;
      const failure = describeLiveError(caught); setSaveFailure(failure);
      if (caught instanceof RelayApiError && DEFINITIVE_SAVE_REJECTIONS.has(caught.problem.code)) persistPendingSave(requestScope, null);
      if (failure.kind === "conflict") { onRefresh(); void loadArtifacts(); }
    } finally {
      if (!disposed.current && saveRecoveryKeyRef.current === requestScope) setSaving(false);
    }
  }
  async function saveVersion() {
    const client = liveClient(); const requestScope = saveRecoveryKey;
    if (!client || !requestScope || !saveRecoveryReady || saving) return;
    let attempt = pendingSaveScope.current === requestScope ? pendingSave.current : null;
    if (attempt === null) {
      if (!canSave) return;
      attempt = latest ? {
        kind: "append", commandId: createCommandId(), taskId,
        expectedTaskRevision: draftBase?.taskRevision ?? taskRevision, artifactId: draftBase?.artifactId ?? latest.artifactId,
        expectedArtifactRevision: draftBase?.artifactRevision ?? latest.artifactRevision,
        expectedVersionNumber: latest.versionNumber, mediaType: MEDIA_TYPE, content
      } : {
        kind: "create", commandId: createCommandId(), taskId,
        expectedTaskRevision: taskRevision, title: title.trim(), mediaType: MEDIA_TYPE, content
      };
      if (!draftBase && attempt.kind === "append" && latest) setDraftBase({ taskId,
        taskRevision: attempt.expectedTaskRevision, artifactId: attempt.artifactId,
        artifactRevision: attempt.expectedArtifactRevision, versionId: latest.versionId });
    }
    if (!persistPendingSave(requestScope, attempt)) {
      setSaveFailure({ kind: "unknown", message: "无法保存原始保存命令，未向服务端发送请求。请恢复本机存储后按原 command_id 继续。", fieldErrors: [] });
      return;
    }
    await submitSaveAttempt(client, requestScope, attempt);
  }
  async function lookupSaveReceipt() {
    const client = liveClient(); const requestScope = saveRecoveryKey;
    const pending = requestScope !== null && pendingSaveScope.current === requestScope ? pendingSave.current : null;
    if (!client || !requestScope || !pending || saving) return;
    setSaving(true); setSaveFailure(null);
    try {
      const body = await client.getCommandReceipt(pending.commandId);
      if (disposed.current || saveRecoveryKeyRef.current !== requestScope) return;
      const expectedType = pending.kind === "create" ? "CreateArtifactWithVersion" : "SubmitHumanArtifactVersion";
      if (body.commandId !== pending.commandId) {
        setSaveFailure({ kind: "unknown", message: "回执 command_id 与原保存命令不符；请继续核对原 ID。", fieldErrors: [] }); return;
      }
      if (body.commandType !== expectedType) { setSaveFailure(wrongReceipt(body.commandType, "保存")); return; }
      const result = artifactVersionResultFrom(body.result);
      settleSave(result, pending, `回执确认已提交：产物版本 v${result.versionNumber}（sha256 ${result.sha256.slice(0, 12)}…）。`, requestScope);
    } catch (caught) {
      if (!disposed.current && saveRecoveryKeyRef.current === requestScope) setSaveFailure(describeLiveError(caught));
    } finally {
      if (!disposed.current && saveRecoveryKeyRef.current === requestScope) setSaving(false);
    }
  }
  async function confirmSelection(client: RelayApiClient, scope: string, requestKey: string, record: RecoveryRecord, mutation: ReturnType<typeof stateMutationFrom>): Promise<boolean> {
    if (projectId === null || mutation.projectId !== projectId || mutation.action !== "SELECT_ARTIFACT_VERSION") return false;
    const request = ++stateRequest.current;
    const current = await client.getProjectState(projectId);
    if (disposed.current || selectionKeyRef.current !== requestKey || unavailableRef.current || request !== stateRequest.current ||
        current.projectId !== projectId || BigInt(current.revision) < BigInt(mutation.revision)) return false;
    if (BigInt(current.revision) === BigInt(mutation.revision) && !current.selectedArtifactVersionRefs.some((version) => version.artifactVersionId === record.objectId)) return false;
    setState(current); setStateFailure(null);
    removeRecovery(scope, record.commandId); setSelectFailure(null);
    setSelectReceipt(`原选择命令已确认，当前选用已重新读取（State revision v${current.revision}）；本轮接受仍需单独核对。`);
    return true;
  }
  async function selectVersion() {
    const client = liveClient(); const scope = selectionScope, requestKey = selectionKey;
    if (!client || !scope || !requestKey || writeBlockedReason !== null || !versionsReady || !selectedVersion || !projectId || !state || selecting || command.current.select !== null) return;
    const commandId = createCommandId();
    const record: RecoveryRecord = { commandId, commandType: "SetProjectState", sessionId: null, targetKind: "TASK", targetId: taskId, objectId: selectedVersion.versionId };
    selectionFlight.current = commandId;
    if (!upsertRecovery(scope, record)) {
      removeRecovery(scope, commandId); selectionFlight.current = null;
      setSelectFailure({ kind: "unknown", message: "无法安全保存原选择身份，未提交选择。请检查浏览器存储。", fieldErrors: [] }); return;
    }
    setSelecting(true); setSelectFailure(null); setSelectReceipt(null);
    let acceptedByServer = false;
    try {
      const result = await client.selectArtifactVersion({ projectId, commandId, expectedRevision: state.revision, artifactVersionId: record.objectId!, sourceRef: `human:workbench:task/${taskId}` });
      acceptedByServer = true;
      if (!await confirmSelection(client, scope, requestKey, record, result)) throw new RelayTransportError("原选择回执与当前项目状态尚未核对，请查询原命令。");
    } catch (caught) {
      if (disposed.current || selectionKeyRef.current !== requestKey) return;
      setSelectFailure(describeLiveError(caught));
      if (!acceptedByServer && !needsReceiptCheck(caught)) removeRecovery(scope, commandId);
    } finally {
      if (selectionFlight.current === commandId) selectionFlight.current = null;
      if (!disposed.current && selectionKeyRef.current === requestKey) setSelecting(false);
    }
  }
  async function lookupSelectReceipt() {
    const scope = selectionScope, requestKey = selectionKey, pending = command.current.select;
    if (!scope || !requestKey || !pending || selecting) return;
    setSelecting(true); setSelectFailure(null);
    try {
      const result = await checkRecoveryNow(scope, pending);
      if (!disposed.current && selectionKeyRef.current === requestKey && result.kind === "FAILED")
        setSelectFailure({ kind: "unknown", message: `原选择结果尚待核对。${result.message}`, fieldErrors: [] });
    } finally { if (!disposed.current && selectionKeyRef.current === requestKey) setSelecting(false); }
  }
  if (!live) return <>{documentHeader}<section className="surface-panel" data-testid="artifact-fixture-gap"><h2>产物与完成</h2><p className="helper-text">示例数据没有产物事实，不展示产物、版本或完成凭据。连接本机 API 后会写入真实 PostgreSQL。</p></section></>;
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
      <Button variant="secondary" data-testid="artifact-content-retry"
        onClick={() => { if (readingTarget) void readVersion(readingTarget.versionId); }}>重试读取正文</Button>
    </div>}
    {visibleReading && <div data-testid="artifact-saved-content"><SafeMarkdown source={visibleReading.content} /></div>}
    {/* versionsFailure 时不能落到「还没有已保存的正文」：版本读不到时 versions 为空、readingTarget
        为 null，那正是「没读到」而不是「确实没写」。versionsReady 是同组件 :418 已有的正确守卫。 */}
    {!readingTarget && !versionsLoading && versionsFailure === null && <div className="artifact-paper-state"><h3>{sourceUnavailable ? "已保存正文暂不可读" : "还没有已保存的正文"}</h3><p className="helper-text">{sourceUnavailable ? "旧正文与版本事实已隐藏；你的未保存输入与原命令仍保留。" : "在“编辑”中写下成果，保存首版后即可阅读确切版本。"}</p></div>}
    {!readingTarget && !versionsLoading && versionsFailure !== null && <div className="artifact-paper-state" role="alert"><h3>版本没有读到</h3><p className="helper-text">当前无法确认这任务已保存哪些正文版本；这不代表它没有正文。请重试读取，已保存的版本事实不会被改写。</p></div>}
  </>;
  const ArtifactHeading = documentHeader ? "h1" : "h2";
  return <div className={`artifact-workspace${documentHeader ? " artifact-workspace--with-header" : ""}${conflicting ? " artifact-workspace--conflict" : ""}`} data-testid="artifact-workspace">
    <section className="artifact-document" aria-label="产物正文与草稿" data-testid="artifact-editor">
      {documentHeader}
      <header className="artifact-document-heading">
        <p className="eyebrow">{conflicting ? "版本冲突与草稿保留" : "任务产物"}</p>
        <ArtifactHeading>{conflicting ? "有更新的版本，先核对差异" : displayedMode === "saved" ? readingTarget?.title ?? title : editableArtifact?.title ?? title}</ArtifactHeading>
        <p className="helper-text">{conflicting ? "对比当前版本与我的草稿，确认需要保留或调整的内容。" : displayedMode === "saved" && readingTarget ? `v${readingTarget.versionNumber} · 已保存版本` : "本轮草稿 · 尚未保存"}</p>
      </header>
      {sourceUnavailable && <p className="warning-callout" role="status" data-testid="artifact-source-unavailable">产物来源暂不可读。旧正文、名称与版本事实已隐藏；仅保留你的未保存输入与原命令。</p>}
      <div className="artifact-document-status">
        <div className="artifact-status-tags">
          <span className={`status-chip${draftChanged ? " status-chip--warning" : " status-chip--neutral"}`} data-testid="artifact-draft-status">
            {saving ? "保存中 · 草稿保留" : activeSavePending ? "保存结果待核对" : draftChanged ? "草稿未保存" : draftBase ? "草稿与保存基线一致" : "草稿未开始"}
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
            : versionsFailure ? <div className="artifact-paper-state" role="alert"><p>{versionsFailure}</p><Button variant="secondary" onClick={() => void loadArtifacts()}>重新读取产物</Button></div>
              : conflictReadingFailure ? <div className="artifact-paper-state" role="alert" data-testid="artifact-conflict-content-error"><h3>当前正文读取失败</h3><p className="helper-text">{conflictReadingFailure}</p><Button variant="secondary" data-testid="artifact-conflict-content-retry" onClick={() => { if (latest) void readConflictVersion(latest.versionId); }}>重试读取当前正文</Button></div>
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
      <details className="artifact-version-history" data-testid="artifact-versions"><summary>版本详情</summary><p className="helper-text">阅读版本、当前选用与本轮接受分开操作；三者分别来自版本、项目 State 与完成凭据。</p>
        {versionsLoading && <p className="helper-text" role="status">正在读取产物版本。</p>}
        {versionsFailure && <p className="action-error" role="alert">{versionsFailure} 草稿仍保留；产物列表尚未核实，暂不能保存或完成。<Button variant="secondary" onClick={() => void loadArtifacts()}>重新读取产物</Button></p>}
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
        <p>{draftVersion ? `基于 v${draftVersion.versionNumber} 编辑` : latest ? `保存至 ${editableArtifact?.title} 的新版本` : "创建首个产物版本"}</p>
        <p className="helper-text">保存后创建不可变版本；新版本不继承原来的验收凭据。草稿只保留在当前页面。</p>
        {saveRecoveryScope === saveRecoveryKey && saveStorageWarning && <p className="disabled-reason" role="status" data-testid="artifact-save-storage-warning">本机持久恢复记录不可用。未核实的保存会保留原 command_id 和正文；无法安全记录时不会发送新命令。</p>}
        {writeBlockedReason && <p className="disabled-reason" data-testid="artifact-project-write-blocked">{writeBlockedReason}</p>}
        {done ? <p className="warning-callout" role="status" data-testid="artifact-editor-locked"><Info aria-hidden="true" />该任务本轮已完成：编辑入口已关闭，请先在下方重开任务再保存新版本。</p> : !allowedActions.includes("SAVE_ARTIFACT_VERSION") && <p className="disabled-reason" data-testid="artifact-editor-reason"><Info aria-hidden="true" />服务端未投影 SAVE_ARTIFACT_VERSION：当前状态是{taskStatusLabels[taskStatus]}，只有进行中的人工任务可以保存产物。</p>}
        {!editableArtifact && <label className="field"><span className="field-label">产物名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} name="artifact-title" disabled={done || activeSavePending !== null || !allowedActions.includes("SAVE_ARTIFACT_VERSION")} /></label>}
        <div className="form-actions"><Button variant="primary" data-testid="artifact-save" disabled={saving || !(canSave || (saveRecoveryReady && activeSavePending !== null && !sourceUnavailable))} onClick={() => void saveVersion()}><Save aria-hidden="true" />{saving ? "正在保存" : activeSavePending ? "按原命令重试保存" : "保存新版本"}</Button></div>
        {draftBase && conflicting && <div className="form-actions"><Button variant="secondary" data-testid="artifact-confirm-new-base" disabled={rebasing || saving || activeSavePending !== null || !versionsReady || !latest || writeBlockedReason !== null || done} onClick={() => void confirmCurrentBase()}>{rebasing ? "正在核对" : `确认以当前 v${latest?.versionNumber ?? "?"} 为基线（保留草稿）`}</Button>{latest && <Link className="inline-link" to={`/artifact-versions/${latest.versionId}/lineage`}>查看版本历史与差异</Link>}</div>}
        {rebaseFailure && <p className="action-error" role="alert">{rebaseFailure}</p>}
        {latest && <Button variant="secondary" data-testid="artifact-load-latest-draft" disabled={done || draftLoading || rebasing || saving || activeSavePending !== null || !versionsReady || content !== savedContentSnapshot.current || !allowedActions.includes("SAVE_ARTIFACT_VERSION")} onClick={() => void loadLatestDraft()}>{draftLoading ? "正在读取" : `从最新版本 v${latest.versionNumber} 起草修订`}</Button>}
        {draftFailure && <p className="action-error" role="alert">{draftFailure}</p>}
        {draftBase && !sourceUnavailable && <details className="artifact-binding-details"><summary>草稿基线{draftVersion ? ` · v${draftVersion.versionNumber}` : ""} · 任务修订 v{draftBase.taskRevision}</summary><p className="helper-text" data-testid="artifact-draft-base">草稿修订基线：版本 {draftBase.versionId} · Artifact revision v{draftBase.artifactRevision} · Task revision v{draftBase.taskRevision}。</p></details>}
        {activeSavePending && <p className="helper-text" data-testid="artifact-save-pending">原 command_id：{activeSavePending.commandId}。原请求{activeSavePending.kind === "create" ? "创建产物" : `续写产物 ${activeSavePending.artifactId}`}，正文 {new TextEncoder().encode(activeSavePending.content).length} 字节；结果未核对前不能提交新草稿。</p>}
        {saveReceipt && <p className="receipt-message" role="status" data-testid="artifact-save-receipt">{saveReceipt}</p>}
        {saveFailure && saveFailure.kind !== "conflict" && <p className="action-error" role="alert">{saveFailure.message}</p>}
        {activeSavePending && !saving && <Button variant="secondary" data-testid="artifact-save-receipt-query" onClick={() => void lookupSaveReceipt()}>查询本次保存回执</Button>}
      </section>
      <section className="artifact-selection-section"><h3>当前选用（来自项目 State）</h3>
        <label className="field"><span className="field-label">设置为当前选用的版本</span><select value={selectedVersionId ?? ""} data-testid="artifact-accept-version" disabled={!versionsReady} onChange={(event) => setSelectedVersionId(event.target.value || null)}><option value="">选择确切版本</option>{versions.map((version) => <option key={version.versionId} value={version.versionId}>v{version.versionNumber} · {version.title}</option>)}</select></label>
        {stateFailure ? <p className="action-error" role="alert">{stateFailure}</p> : projectId === null ? <p className="helper-text">该任务未归属项目：选择版本为当前选用是 Project State 命令，因此不可用。</p> : selectedByProject.length === 0 ? <p className="helper-text">项目 State 还没有选用任何产物版本。</p> : <ul className="version-list">{selectedByProject.map((ref) => <li key={ref.artifactVersionId} className="version-row"><span className="version-copy"><strong>v{ref.versionNumber}</strong><small>来源：{ref.sourceRef}</small></span></li>)}</ul>}
        <p className="helper-text">当前选用候选：{selectedVersion ? `v${selectedVersion.versionNumber} · ${selectedVersion.title}` : "尚未选择版本"}</p>
        {selectedVersion && <details className="artifact-binding-details"><summary>核对当前选用候选身份</summary><p className="helper-text" data-testid="artifact-selected-version">当前选用候选：v{selectedVersion.versionNumber} · {selectedVersion.title} · {selectedVersion.versionId}</p></details>}
        <Button variant="secondary" data-testid="artifact-select-version" disabled={writeBlockedReason !== null || !versionsReady || selecting || selectionPending !== null || !selectedVersion || !projectId || !state} onClick={() => void selectVersion()}>{selecting ? "正在提交" : "选择这个版本为当前选用"}</Button>
        <p className="helper-text">“当前选用”是项目级事实，与“本轮接受”不同；下方完成命令接受的是明确选择的确切版本。</p>
        {selectReceipt && <p className="receipt-message" role="status">{selectReceipt}</p>}{selectFailure && <p className="action-error" role="alert">{selectFailure.message}</p>}{selectionPending && <p className="helper-text" data-testid="artifact-select-pending">{selectionFlight.current === selectionPending.commandId ? "正在提交选择，原命令身份已保存。" : selectionChecking ? "正在核对原选择结果，不重新提交。" : "原选择结果尚待核对；仅查询原命令，不重新提交。"}原 command_id：{selectionPending.commandId}</p>}{selectionPending && <Button variant="secondary" data-testid="artifact-select-receipt-query" disabled={selecting || selectionChecking} onClick={() => void lookupSelectReceipt()}>查询本次选择回执</Button>}
      </section>
      <TaskCompletionPanel live={live} target={{ taskId, taskStatus, taskRevision, acceptanceRevision,
        allowedActions: sourceUnavailable ? [] : allowedActions, criteria: sourceUnavailable ? [] : criteria,
        acceptedVersion: null,
        availableArtifactVersions: versionsReady ? versions.map((version) => ({ artifactId: version.artifactId,
          artifactTitle: version.title, artifactVersionId: version.versionId, versionNumber: version.versionNumber,
          isLatest: artifacts?.items.some((item) => item.latestVersionId === version.versionId) ?? false })) : [],
        currentAcceptedArtifactVersionIds: versionsReady ? artifacts?.currentAcceptedVersionIds ?? [] : undefined,
        writeBlockedReason: writeBlockedReason ?? (!versionsReady ? "产物列表尚未核实，暂不能完成。请重新读取产物后继续。" : null) }} onRefresh={onRefresh} />
    </aside>
  </div>;
}
