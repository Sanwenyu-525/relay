import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { MessageSquareText, Plus, RotateCcw } from "lucide-react";
import type { RelayApiClient, RelayAssistSession, RelayProjectListItem, RelayTaskSummary } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import AppDialog from "../components/AppDialog";
import AssistView, { type AssistNavigationState } from "./AssistView";
import "./AgentChatView.css";

type TargetKind = "PROJECT" | "TASK";
type Selection = { readonly kind: TargetKind; readonly id: string; readonly sessionId: string | null };
type RecoveryRecord = { readonly commandId: string; readonly commandType: string;
  readonly sessionId: string | null; readonly targetKind: TargetKind; readonly targetId: string };
const cleanNavigation: AssistNavigationState = { dirty: false, pending: null };

function recoveryKey(client: RelayApiClient): string {
  return `relay-agent-chat-pending:${client.baseUrl}:${client.workspaceId}`;
}

function readRecovery(client: RelayApiClient): readonly RecoveryRecord[] {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(recoveryKey(client)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is RecoveryRecord => item && typeof item === "object" &&
      typeof item.commandId === "string" && typeof item.commandType === "string" &&
      (item.sessionId === null || typeof item.sessionId === "string") &&
      (item.targetKind === "PROJECT" || item.targetKind === "TASK") && typeof item.targetId === "string");
  } catch { return []; }
}

function sessionTarget(session: RelayAssistSession): Selection | null {
  if (session.taskId) return { kind: "TASK", id: session.taskId, sessionId: session.id };
  if (session.projectId) return { kind: "PROJECT", id: session.projectId, sessionId: session.id };
  return null;
}

export default function AgentChatView() {
  const connection = useRelayConnection();
  if (connection.mode !== "live" || !connection.client) return <section className="page-state" data-testid="agent-fixture-gap">
    <p className="eyebrow">Agent 聊天</p><h1>示例模式没有真实会话</h1>
    <p>连接本机 API 后，可以在这里查看项目或任务的 Assist 会话。示例模式不生成模型回复或提案。</p>
  </section>;
  return <AgentChatLive key={connection.epoch} client={connection.client} />;
}

function AgentChatLive({ client }: { client: RelayApiClient }) {
  const [sessions, setSessions] = useState<readonly RelayAssistSession[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectedRef = useRef<Selection | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const openingRef = useRef(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerOpenRef = useRef(false);
  const [pickerKind, setPickerKind] = useState<TargetKind>("PROJECT");
  const [pickerTargetId, setPickerTargetId] = useState("");
  const [projects, setProjects] = useState<readonly RelayProjectListItem[]>([]);
  const [tasks, setTasks] = useState<readonly RelayTaskSummary[]>([]);
  const [projectCursor, setProjectCursor] = useState<string | null>(null);
  const [taskCursor, setTaskCursor] = useState<string | null>(null);
  const [loadedKinds, setLoadedKinds] = useState<readonly TargetKind[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const listVersion = useRef(0);
  const openVersion = useRef(0);
  const optionsVersion = useRef(0);
  const navigationRef = useRef<AssistNavigationState>(cleanNavigation);
  const [transition, setTransition] = useState<{ kind: "dirty" | "pending"; proceed: () => void } | null>(null);
  const [recoveries, setRecoveries] = useState<readonly RecoveryRecord[]>(() => readRecovery(client));
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  const updateRecoveries = useCallback((update: (current: readonly RecoveryRecord[]) => readonly RecoveryRecord[]) => {
    setRecoveries((current) => {
      const next = update(current);
      try { window.sessionStorage.setItem(recoveryKey(client), JSON.stringify(next)); } catch { /* 会话内仍保留原 ID。 */ }
      return next;
    });
  }, [client]);
  const reportNavigation = useCallback((state: AssistNavigationState) => {
    const previous = navigationRef.current.pending;
    navigationRef.current = state;
    if (previous && !state.pending)
      updateRecoveries((current) => current.filter((item) => item.commandId !== previous.commandId));
    if (state.pending && selectedRef.current) {
      const selected = selectedRef.current;
      updateRecoveries((current) => current.some((item) => item.commandId === state.pending?.commandId)
        ? current : [...current, { ...state.pending!, targetKind: selected.kind, targetId: selected.id }]);
    }
  }, [updateRecoveries]);
  useEffect(() => {
    const guard: DraftGuard = {
      hasUnsavedChanges: () => navigationRef.current.dirty || navigationRef.current.pending !== null,
      discard: () => { navigationRef.current = cleanNavigation; }
    };
    setDraftGuard(guard);
    return () => clearDraftGuard(guard);
  }, []);

  function requestTransition(proceed: () => void) {
    const state = navigationRef.current;
    if (state.pending) setTransition({ kind: "pending", proceed });
    else if (state.dirty) setTransition({ kind: "dirty", proceed });
    else proceed();
  }

  async function checkRecovery(record: RecoveryRecord) {
    setCheckingId(record.commandId); setRecoveryError(null);
    try {
      const receipt = await client.getCommandReceipt(record.commandId);
      if (receipt.commandId !== record.commandId || receipt.commandType !== record.commandType ||
        record.commandType === "RequestAssistMessage" && receipt.result.session_id !== record.sessionId)
        throw new Error("原命令回执与记录的身份不匹配。");
      updateRecoveries((current) => current.filter((item) => item.commandId !== record.commandId));
      void refreshSessions();
    } catch (caught) { setRecoveryError(`${describeLiveError(caught).message} 原载荷未保存，不能换命令 ID 重试；请继续核对服务端结果。`); }
    finally { setCheckingId(null); }
  }

  function choose(next: Selection | null) {
    selectedRef.current = next;
    setSelection(next);
  }

  async function openSession(row: RelayAssistSession) {
    const version = ++openVersion.current;
    openingRef.current = true;
    setOpeningId(row.id);
    setOpenError(null);
    choose(null);
    try {
      const current = await client.getAssistSession(row.id);
      if (version !== openVersion.current || client !== liveClient()) return;
      if (current.id !== row.id || current.projectId !== row.projectId || current.taskId !== row.taskId)
        throw new Error("会话归属已变化，请刷新列表后重新选择。");
      const target = sessionTarget(current);
      if (!target) throw new Error("该会话没有可核对的项目或任务目标。");
      choose(target);
      pickerOpenRef.current = false; setPickerOpen(false);
    } catch (caught) {
      if (version === openVersion.current) setOpenError(describeLiveError(caught).message);
    } finally {
      if (version === openVersion.current) { openingRef.current = false; setOpeningId(null); }
    }
  }

  async function refreshSessions() {
    const version = ++listVersion.current;
    setLoading(true); setListError(null);
    try {
      const rows = await client.getAssistSessions({});
      if (version !== listVersion.current || client !== liveClient()) return;
      const ordered = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setSessions(ordered);
      if (!selectedRef.current && !openingRef.current && !pickerOpenRef.current) {
        const first = ordered.find((item) => sessionTarget(item) !== null);
        if (first) void openSession(first);
      }
    } catch (caught) {
      if (version === listVersion.current) setListError(describeLiveError(caught).message);
    } finally { if (version === listVersion.current) setLoading(false); }
  }

  async function loadOptions(kind: TargetKind, cursor: string | null) {
    const version = ++optionsVersion.current;
    setOptionsLoading(true); setOptionsError(null);
    try {
      if (kind === "PROJECT") {
        const page = await client.getProjectsPage("all", cursor);
        if (version !== optionsVersion.current || client !== liveClient()) return;
        setProjects((current) => cursor === null ? page.items : [...current, ...page.items]);
        setProjectCursor(page.nextCursor);
      } else {
        const page = await client.getWorkspaceTasksPage(cursor);
        if (version !== optionsVersion.current || client !== liveClient()) return;
        setTasks((current) => cursor === null ? page.items : [...current, ...page.items]);
        setTaskCursor(page.nextCursor);
      }
      setLoadedKinds((current) => current.includes(kind) ? current : [...current, kind]);
    } catch (caught) {
      if (version === optionsVersion.current) setOptionsError(describeLiveError(caught).message);
    } finally { if (version === optionsVersion.current) setOptionsLoading(false); }
  }

  useEffect(() => {
    void refreshSessions();
    return () => { listVersion.current++; openVersion.current++; optionsVersion.current++; };
  }, [client]);

  function startNew() {
    openVersion.current++;
    openingRef.current = false;
    setOpeningId(null); setOpenError(null);
    pickerOpenRef.current = true; setPickerOpen(true); setPickerTargetId("");
    if (!loadedKinds.includes(pickerKind)) void loadOptions(pickerKind, null);
  }

  function changeKind(kind: TargetKind) {
    optionsVersion.current++;
    setOptionsLoading(false); setOptionsError(null);
    setPickerKind(kind); setPickerTargetId("");
    if (!loadedKinds.includes(kind)) void loadOptions(kind, null);
  }

  function openTarget() {
    if (!pickerTargetId) return;
    const exists = pickerKind === "PROJECT" ? projects.some((item) => item.id === pickerTargetId)
      : tasks.some((item) => item.id === pickerTargetId);
    if (!exists) return;
    openVersion.current++;
    openingRef.current = false;
    setOpeningId(null); setOpenError(null);
    choose({ kind: pickerKind, id: pickerTargetId, sessionId: null });
    pickerOpenRef.current = false; setPickerOpen(false);
  }

  function sessionCreated(sessionId: string) {
    const current = selectedRef.current;
    if (current) choose({ ...current, sessionId });
    void refreshSessions();
  }

  const availableTargets = pickerKind === "PROJECT" ? projects : tasks;
  const nextCursor = pickerKind === "PROJECT" ? projectCursor : taskCursor;
  return <section className="agent-chat-page" data-testid="agent-chat-page">
    <aside className="agent-chat-rail" aria-label="Agent 会话">
      <div className="agent-chat-rail-header"><div><p className="eyebrow">工作空间</p><h1>Agent 聊天</h1></div>
        <button className="primary-button" type="button" data-testid="agent-new" onClick={() => requestTransition(startNew)}>
          <Plus aria-hidden="true" />新会话</button></div>
      <p className="helper-text">讨论与提案关联项目或任务，确认前不会修改业务事实。</p>
      <div className="agent-chat-list-heading"><h2>会话</h2>
        <button className="icon-button" type="button" aria-label="刷新会话列表" onClick={() => void refreshSessions()}>
          <RotateCcw aria-hidden="true" /></button></div>
      {loading && <p className="helper-text" role="status">正在读取会话…</p>}
      {listError && <p className="action-error" role="alert">{listError}</p>}
      {!loading && !listError && sessions.length === 0 && <p className="helper-text">还没有会话。选择项目或任务后新建。</p>}
      <ul className="agent-chat-session-list">{sessions.map((item) => {
        const target = sessionTarget(item);
        return <li key={item.id}><button type="button" className="agent-chat-session-item"
          data-testid={`agent-session-${item.id}`} aria-current={selection?.sessionId === item.id ? "true" : undefined}
          disabled={!target || openingId !== null} onClick={() => requestTransition(() => void openSession(item))}>
          <MessageSquareText aria-hidden="true" /><span><strong>{item.title}</strong>
            <small>{target?.kind === "TASK" ? "任务" : target ? "项目" : "目标不可用"} · {item.status}</small></span>
        </button></li>;
      })}</ul>
      {recoveries.length > 0 && <section className="agent-chat-recovery" role="status"><strong>待核对的原命令</strong>
        {recoveries.map((record) => <div key={record.commandId}><span>{record.commandType} · {record.targetKind === "PROJECT" ? "项目" : "任务"} {record.targetId} · {record.commandId}</span>
          <button className="secondary-button" type="button" disabled={checkingId !== null}
            onClick={() => void checkRecovery(record)}>{checkingId === record.commandId ? "正在查询" : "查询原命令回执"}</button></div>)}
        {recoveryError && <p className="action-error" role="alert">{recoveryError}</p>}
        <p className="helper-text">离开页面后只保留命令身份；回执查不到时不能换新 ID 重试。</p></section>}
    </aside>
    <div className="agent-chat-main">
      {pickerOpen && <section className="agent-chat-picker surface-panel" data-testid="agent-target-picker">
        <h2>选择新会话的目标</h2><p className="helper-text">先打开项目或任务，再在右侧新建 Assist 会话。</p>
        <div className="agent-chat-picker-fields"><label className="field"><span className="field-label">目标类型</span>
          <select data-testid="agent-target-kind" value={pickerKind} onChange={(event) => changeKind(event.target.value as TargetKind)}>
            <option value="PROJECT">项目</option><option value="TASK">任务</option></select></label>
          <label className="field"><span className="field-label">{pickerKind === "PROJECT" ? "项目" : "任务"}</span>
            <select data-testid="agent-target-id" value={pickerTargetId} onChange={(event) => setPickerTargetId(event.target.value)}>
              <option value="">请选择</option>{availableTargets.map((item) => <option key={item.id} value={item.id}>
                {item.title}{"archiveStatus" in item && item.archiveStatus === "ARCHIVED" ? "（已归档，只读）" : ""}</option>)}</select></label></div>
        {optionsLoading && <p className="helper-text" role="status">正在读取目标…</p>}
        {optionsError && <p className="action-error" role="alert">{optionsError} <button className="text-link" type="button"
          onClick={() => void loadOptions(pickerKind, null)}>重试</button></p>}
        {!optionsLoading && !optionsError && loadedKinds.includes(pickerKind) && availableTargets.length === 0 &&
          <p className="helper-text">暂无可选{pickerKind === "PROJECT" ? "项目" : "任务"}。
            <Link className="text-link" to={pickerKind === "PROJECT" ? "/projects" : "/tasks"}>前往列表</Link></p>}
        {nextCursor && <button className="secondary-button" type="button" disabled={optionsLoading}
          onClick={() => void loadOptions(pickerKind, nextCursor)}>加载更多{pickerKind === "PROJECT" ? "项目" : "任务"}</button>}
        <div className="form-actions"><button className="primary-button" type="button" data-testid="agent-open-target"
          disabled={!pickerTargetId || optionsLoading} onClick={openTarget}>打开目标</button>
          <button className="secondary-button" type="button" onClick={() => { pickerOpenRef.current = false; setPickerOpen(false); }}>取消</button></div>
      </section>}
      {openingId && <section className="page-state" role="status"><h2>正在核对会话归属</h2><p>读取服务端会话与目标后显示消息。</p></section>}
      {openError && <section className="page-state page-state--error" role="alert"><h2>无法打开会话</h2><p>{openError}</p></section>}
      {!pickerOpen && !openingId && !openError && selection && <AssistView
        key={`${selection.kind}:${selection.id}:${selection.sessionId ?? "target"}`}
        targetKind={selection.kind} targetId={selection.id}
        preferredSessionId={selection.sessionId} onSessionCreated={sessionCreated}
        standalone onNavigationStateChange={reportNavigation} onRequestNewSession={requestTransition} />}
      {!pickerOpen && !openingId && !openError && !selection && <section className="page-state agent-chat-empty">
        <MessageSquareText aria-hidden="true" /><h2>选择会话，或开始新的讨论</h2>
        <p>会话固定关联项目或任务；发送后的状态与结果以服务端为准。</p>
        <button className="primary-button" type="button" onClick={() => requestTransition(startNew)}><Plus aria-hidden="true" />选择目标</button>
      </section>}
    </div>
    <AppDialog open={transition !== null} title={transition?.kind === "pending" ? "命令结果待核对" : "未发送的内容"}
      onClose={() => setTransition(null)}><p>{transition?.kind === "pending"
        ? `原命令 ${navigationRef.current.pending?.commandId ?? ""} 的结果仍待核对。请留在当前会话查询回执；不会以新命令重试。`
        : "当前会话有未发送的消息或已选资料。切换后这些内容会丢失。"}</p>
      <div className="form-actions"><button className="secondary-button" type="button" onClick={() => setTransition(null)}>留在当前会话</button>
        {transition?.kind === "dirty" && <button className="primary-button" type="button" data-testid="agent-discard-draft"
          onClick={() => { const proceed = transition.proceed; setTransition(null); navigationRef.current = cleanNavigation; proceed(); }}>丢弃并继续</button>}</div>
    </AppDialog>
  </section>;
}
