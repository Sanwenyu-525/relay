import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { RotateCcw } from "lucide-react";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayAssistLivePreview,
  type RelayAssistMessage, type RelayAssistProposal,
  type RelayAssistSession, type RelayAssistSourceRef, type RelayCommandReceipt,
  type RelaySkillDefinition, type RelaySkillInput, type RelayTaskSkillProposal } from "../api/relayClient";
import AssistSkillOutput from "../components/AssistSkillOutput";
import AssistSourcePicker from "../components/AssistSourcePicker";
import TaskContractProposalPreview from "../components/TaskContractProposalPreview";
import { describeLiveError } from "../lib/liveErrors";
import { modelErrorGuides } from "../lib/modelErrorGuides";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import "./AssistView.css";

type AssistTarget = { readonly kind: "PROJECT" | "TASK"; readonly id: string; readonly title: string;
  readonly revision: string; readonly projectId: string | null; readonly executor: string | null;
  readonly archivedAt: string | null | undefined };
type AssistIntent = "DISCUSS" | "PROPOSE_CANDIDATE" | "PROPOSE_TASK";
const supportedSkillOutput: Readonly<Record<string, RelaySkillDefinition["outputKind"]>> = {
  "task-to-execution-contract": "TASK_DEFINITION_SUGGESTION",
  "project-resume": "PROJECT_RESUME",
  "verification-plan": "VERIFICATION_PLAN_SUGGESTION"
};
type PendingAction = { readonly kind: "send"; readonly commandId: string; readonly content: string;
  readonly intent: AssistIntent | null; readonly skillRef: { readonly id: string; readonly version: string } | null;
  readonly skillInput: RelaySkillInput | null; readonly sources: readonly RelayAssistSourceRef[] } |
  { readonly kind: "cancel" | "accept"; readonly commandId: string; readonly id: string } |
  { readonly kind: "acceptTask"; readonly commandId: string; readonly id: string;
    readonly taskId: string; readonly expectedTaskRevision: string;
    readonly expectedAcceptanceRevision: string; readonly payloadHash: string };
type PendingCreate = { readonly commandId: string; readonly projectId: string | null;
  readonly taskId: string | null; readonly title: string };
export type AssistNavigationState = {
  readonly dirty: boolean;
  readonly pending: { readonly commandId: string; readonly commandType: string;
    readonly sessionId: string | null } | null;
};
const cleanNavigationState: AssistNavigationState = { dirty: false, pending: null };

function targetMatches(session: RelayAssistSession, target: AssistTarget): boolean {
  return target.kind === "PROJECT" ? session.projectId === target.id && session.taskId === null
    : session.taskId === target.id && session.projectId === target.projectId;
}

function receiptMatches(receipt: RelayCommandReceipt, action: PendingAction, sessionId: string): boolean {
  const commandType = action.kind === "send" ? "RequestAssistMessage" : action.kind === "cancel"
    ? "CancelAssistMessage" : "AcceptAssistProposal";
  if (receipt.commandId !== action.commandId || receipt.commandType !== commandType) return false;
  if (action.kind === "send") return receipt.result.session_id === sessionId &&
    typeof receipt.result.assistant_message_id === "string";
  if (action.kind === "cancel") return receipt.result.message_id === action.id;
  if (action.kind === "acceptTask") return receipt.result.proposal_id === action.id &&
    receipt.result.task_id === action.taskId &&
    receipt.result.previous_acceptance_revision === action.expectedAcceptanceRevision &&
    typeof receipt.result.acceptance_revision === "string" &&
    typeof receipt.result.revision === "string" &&
    typeof receipt.result.status === "string" &&
    typeof receipt.result.objective === "string" &&
    receipt.result.required_output_spec !== null &&
    typeof receipt.result.required_output_spec === "object" &&
    !Array.isArray(receipt.result.required_output_spec) &&
    Array.isArray(receipt.result.criteria) &&
    Array.isArray(receipt.result.added_criterion_ids);
  return true;
}

/** 项目与任务子页、独立 Agent 页共用同一个 Assist 业务入口。 */
export default function AssistView({ targetKind, targetId, preferredSessionId, onSessionCreated,
  standalone = false, onNavigationStateChange, onRequestNewSession }: {
  targetKind?: "PROJECT" | "TASK"; targetId?: string; preferredSessionId?: string | null;
  onSessionCreated?: (sessionId: string) => void;
  standalone?: boolean; onNavigationStateChange?: (state: AssistNavigationState) => void;
  onRequestNewSession?: (proceed: () => void) => void;
} = {}) {
  const location = useLocation();
  const params = useParams();
  const kind = targetKind ?? (location.pathname.startsWith("/projects/") ? "PROJECT" : "TASK");
  const id = targetId ?? params.id ?? "";
  const connection = useRelayConnection();
  const client = connection.client;
  const [target, setTarget] = useState<AssistTarget | null>(null);
  const [sessions, setSessions] = useState<readonly RelayAssistSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selectedRefs, setSelectedRefs] = useState<readonly RelayAssistSourceRef[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [sessionNavigation, setSessionNavigation] = useState<AssistNavigationState>(cleanNavigationState);
  const requestVersion = useRef(0);
  const reportSessionNavigation = useCallback((state: AssistNavigationState) => setSessionNavigation(state), []);

  useEffect(() => {
    if (!standalone) return;
    onNavigationStateChange?.({ dirty: sessionNavigation.dirty || selectedRefs.length > 0,
      pending: pendingCreate ? { commandId: pendingCreate.commandId,
        commandType: "CreateAssistSession", sessionId: null } : sessionNavigation.pending });
  }, [standalone, sessionNavigation, selectedRefs, pendingCreate, onNavigationStateChange]);

  async function loadTarget(preferredSessionIdFromRefresh?: string) {
    const version = ++requestVersion.current;
    if (target?.id !== id || target.kind !== kind) {
      setTarget(null); setSessions([]); setSessionId(null); setSelectedRefs([]);
    }
    setError(null); setLoading(client !== null);
    if (!client) return;
    try {
      const targetPromise: Promise<AssistTarget> = kind === "PROJECT"
        ? client.getProject(id).then((project) => ({ kind, id: project.id, title: project.title,
          revision: project.revision, projectId: project.id, executor: null,
          archivedAt: project.archivedAt }))
        : client.getTask(id).then(async (task) => {
          let archivedAt: string | null | undefined = null;
          if (task.projectId) {
            archivedAt = undefined;
            try { const project = await client.getProject(task.projectId); if (project.id === task.projectId) archivedAt = project.archivedAt; }
            catch { /* 保留任务与历史会话读取，关闭新的写命令。 */ }
          }
          return { kind, id: task.id, title: task.title, revision: task.revision,
            projectId: task.projectId, executor: task.executor, archivedAt };
        });
      const [nextTarget, list] = await Promise.all([targetPromise,
        client.getAssistSessions(kind === "PROJECT" ? { projectId: id } : { taskId: id })]);
      if (version !== requestVersion.current || client !== liveClient()) return;
      const scoped = list.filter((item) => targetMatches(item, nextTarget));
      setTarget(nextTarget); setSessions(scoped);
      // null 表示从独立页开始新会话；undefined 保留项目/任务子页的默认最近会话行为。
      const preferred = preferredSessionIdFromRefresh !== undefined
        ? preferredSessionIdFromRefresh : preferredSessionId;
      setSessionId((current) => preferred === null
        ? current && scoped.some((item) => item.id === current) ? current : null
        : preferred ? scoped.some((item) => item.id === preferred) ? preferred : null
          : current && scoped.some((item) => item.id === current) ? current : scoped[0]?.id ?? null);
      if (preferred && !scoped.some((item) => item.id === preferred))
        setError("所选会话不属于当前目标，请刷新会话列表后重试。");
    } catch (caught) { if (version === requestVersion.current) setError(describeLiveError(caught).message); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }
  useEffect(() => {
    setPendingCreate(null); setCreateError(null); setCreating(false);
    void loadTarget();
    return () => { requestVersion.current++; };
  }, [kind, id, client]);
  useEffect(() => {
    if (preferredSessionId === undefined) return;
    setSessionId(preferredSessionId !== null && sessions.some((item) => item.id === preferredSessionId)
      ? preferredSessionId : null);
    setSelectedRefs([]);
  }, [preferredSessionId]);

  async function createSession(retry?: PendingCreate) {
    if (!target || !client || creating || (!retry && (pendingCreate || projectWriteBlockedReason))) return;
    const action: PendingCreate = retry ?? { commandId: createCommandId(),
      projectId: target.kind === "PROJECT" ? target.id : target.projectId,
      taskId: target.kind === "TASK" ? target.id : null, title: `关于${target.title}`.slice(0, 200) };
    const version = requestVersion.current;
    setCreating(true); setCreateError(null); setPendingCreate(action);
    try {
      const created = await client.createAssistSession(action);
      if (version !== requestVersion.current) return;
      setPendingCreate(null); setCreating(false); await loadTarget(created.id);
      if (requestVersion.current === version + 1 && client === liveClient()) onSessionCreated?.(created.id);
    } catch (caught) {
      if (version !== requestVersion.current) return;
      const described = describeLiveError(caught);
      if (described.kind !== "transport") setPendingCreate(null);
      setCreateError(described.message);
    } finally { if (version === requestVersion.current) setCreating(false); }
  }
  async function checkCreateReceipt() {
    if (!client || !pendingCreate || creating) return;
    const commandId = pendingCreate.commandId; const version = requestVersion.current;
    setCreating(true); setCreateError(null);
    try {
      const receipt = await client.getCommandReceipt(commandId);
      if (version !== requestVersion.current) return;
      if (receipt.commandId !== commandId || receipt.commandType !== "CreateAssistSession" ||
          typeof receipt.result.session_id !== "string") throw new Error("会话回执与原命令不匹配。");
      setPendingCreate(null); setCreating(false); await loadTarget(receipt.result.session_id);
      if (requestVersion.current === version + 1 && client === liveClient())
        onSessionCreated?.(receipt.result.session_id);
    } catch (caught) { if (version === requestVersion.current) setCreateError(describeLiveError(caught).message); }
    finally { if (version === requestVersion.current) setCreating(false); }
  }

  if (connection.mode !== "live") return <section className="page-state" data-testid="assist-fixture-gap"><p className="eyebrow">Assist</p><h1>示例模式没有真实会话</h1><p>连接本机 API 后才能读取项目或任务会话；示例模式不生成模型回复或提案。</p></section>;
  if (error && (target?.id !== id || target.kind !== kind)) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">Assist</p><h1>暂时无法读取对话目标</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void loadTarget()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (target?.id !== id || target.kind !== kind) return <section className="page-state" aria-live="polite"><p className="eyebrow">Assist</p><h1>正在核对对话目标与会话</h1></section>;
  if (!target || !client) return null;
  const projectWriteBlockedReason = target.projectId === null ? null : loading || error !== null || target.archivedAt === undefined ?
    "Project 事实正在核对或读取失败，不能发送新的 Assist 命令。" : target.archivedAt !== null ?
      "项目已归档，不能发送新的 Assist 命令。" : null;
  const session = sessions.find((item) => item.id === sessionId) ?? null;
  return <section className={standalone ? "skill-page agent-assist" : "skill-page"} data-testid="assist-target"><div className={standalone ? "agent-assist-heading" : undefined}><div><p className="eyebrow" title={id}>{kind === "PROJECT" ? "项目 Assist" : "任务 Assist"}{!standalone && ` · ${id}`}</p><h1>{target.title}</h1>{!standalone && <><p className="page-lede">当前目标修订 v{target.revision}{target.executor && <> · 当前执行者 {target.executor}</>}</p><p className="helper-text">消息固定写入当前会话；切换目标后重新读取。Assist 建议不会自动修改业务事实。</p></>}</div><Link className="text-link" to={kind === "PROJECT" ? `/projects/${id}` : `/tasks/${id}`}>返回{kind === "PROJECT" ? "项目" : "任务"}</Link></div>{loading && <p role="status">正在刷新目标与会话…</p>}{error && <p className="action-error" role="alert">{error}</p>}
    {projectWriteBlockedReason && <p className="disabled-reason" data-testid="assist-archive-reason">{projectWriteBlockedReason}</p>}
    <section className={standalone ? "agent-assist-session-bar" : "surface-panel"}>{!standalone && <h2>会话</h2>}<div className="form-actions">{!standalone && <label className="field"><span className="field-label">当前会话</span><select data-testid="assist-session-select" value={sessionId ?? ""} onChange={(event) => { setSessionId(event.target.value || null); setSelectedRefs([]); }}><option value="">选择会话</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.status}</option>)}</select></label>}<button className="secondary-button" type="button" data-testid="assist-new-session" disabled={creating || pendingCreate !== null || projectWriteBlockedReason !== null} onClick={() => standalone && onRequestNewSession ? onRequestNewSession(() => void createSession()) : void createSession()}>{creating ? "正在创建" : "新建会话"}</button><button className="secondary-button" type="button" onClick={() => void loadTarget(sessionId ?? undefined)}>刷新会话</button></div>{!session && preferredSessionId === null && <p className="helper-text" data-testid="assist-new-session-prompt">目标已选。先点击“新建会话”，创建成功后再发送消息；如需继续已有会话，请从左侧选择。</p>}{!sessions.length && preferredSessionId !== null && <p className="helper-text">当前目标还没有会话，先新建会话再发送消息。</p>}{createError && <p className="action-error" role="alert">{createError}</p>}{pendingCreate && <><p className="helper-text">创建结果待核对，原 command_id：{pendingCreate.commandId}</p><button type="button" className="secondary-button" disabled={creating} onClick={() => void checkCreateReceipt()}>查询创建回执</button><button type="button" className="secondary-button" disabled={creating} onClick={() => void createSession(pendingCreate)}>以原命令重试</button></>}</section>
    {session && <>{session.status === "ACTIVE" && (standalone ? <details className="agent-chat-sources" open={sourcesOpen}><summary>资料来源 · 已选 {selectedRefs.length}</summary><AssistSourcePicker key={`${connection.epoch}:${session.id}:${target.projectId ?? "none"}`} projectId={target.projectId} selectedRefs={selectedRefs} onChange={setSelectedRefs} /></details> : <AssistSourcePicker key={`${connection.epoch}:${session.id}:${target.projectId ?? "none"}`} projectId={target.projectId} selectedRefs={selectedRefs} onChange={setSelectedRefs} />)}
      <AssistSessionPanel key={`${connection.epoch}:${session.id}`} client={client} session={session} target={target} sources={selectedRefs}
        standalone={standalone} onNavigationStateChange={reportSessionNavigation}
        sourcesOpen={sourcesOpen} onToggleSources={() => setSourcesOpen((open) => !open)}
        writeBlockedReason={projectWriteBlockedReason}
        refreshTarget={() => loadTarget(session.id)}
        clearSentSources={(sent) => setSelectedRefs((current) => JSON.stringify(current) === JSON.stringify(sent) ? [] : current)} /></>}
  </section>;
}

function canPreview(message: RelayAssistMessage): boolean {
  return message.role === "ASSISTANT" && message.intent === "DISCUSS" && message.skill === null &&
    !message.cancelRequested && (message.status === "PENDING" || message.status === "RUNNING");
}

const messageStatusLabels: Record<RelayAssistMessage["status"], string> = {
  PENDING: "等待生成", RUNNING: "正在生成", COMPLETED: "", FAILED: "生成失败", CANCELLED: "已取消"
};

function messageTime(value: string | null): string {
  const at = value === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(at)) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));
}

function messageDay(value: string | null): string | null {
  const at = value === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(at)).replaceAll("/", "-");
}

function AssistMessageRow({ client, target, message, preview, busy, pending, writeBlocked, onCancel }: { client: RelayApiClient;
  target: AssistTarget; message: RelayAssistMessage; busy: boolean; pending: boolean; writeBlocked: boolean;
  preview: RelayAssistLivePreview | null;
  onCancel: (id: string) => void }) {
  const user = message.role === "USER";
  return <article className="agent-message" data-role={message.role}>
    <span className="agent-message-avatar" aria-hidden="true">{user ? "我" : "AI"}</span>
    <div className="agent-message-body">
    <p className="agent-message-meta"><span className="agent-message-role">{user ? "我" : "AI"}</span>
      {messageTime(message.createdAt) !== "" && <time dateTime={message.createdAt ?? undefined}>{messageTime(message.createdAt)}</time>}
      {/* 完成态不占位：正常完成不需要额外标注，未完成和失败必须显式说明。 */}
      {messageStatusLabels[message.status] !== "" && <span className="agent-message-status">
        {messageStatusLabels[message.status]}
        {message.cancelRequested && message.status === "RUNNING" ? "（正在取消）" : ""}</span>}</p>
    {message.skill && <p className="helper-text">第一方 Skill {message.skill.id} v{message.skill.version}
      {message.skill.sha256 && <> · 定义摘要 {message.skill.sha256}</>}
      {message.skill.definitionAvailability === "HISTORICAL_ONLY" &&
        <> · 冻结历史定义仅可查阅；当前注册表不再提供此版本，不能新调用或接受，不会以新版替换历史来源</>}
      {message.skill.definitionAvailability === "UNAVAILABLE" && <> · 历史定义不可用</>}
      {message.skill.missingCapabilities.length > 0 && <> · 缺少能力 {message.skill.missingCapabilities.join("、")}</>}
    </p>}
    {message.content !== null && (message.skill === null || message.role === "USER") &&
      <p className="assist-message-content">{message.content}</p>}
    {canPreview(message) && preview?.previewAvailable && preview.previewText !== null &&
      <div data-testid={`assist-live-preview-${message.id}`}><p className="helper-text">生成中草稿 · 仅当前预览 v{preview.previewRevision}，不是完整消息或已接受产物{preview.previewTruncated ? " · 预览已截断" : ""}</p>
        <p className="assist-message-content">{preview.previewText}</p></div>}
    {message.errorCode && <p className="action-error">生成失败：{message.errorCode}</p>}
    {message.status === "FAILED" && message.providerErrorKind !== null &&
      <p className="helper-text" data-testid="assist-provider-error">模型服务：{modelErrorGuides[message.providerErrorKind]}</p>}
    {message.skill && message.role === "ASSISTANT" && message.status === "COMPLETED" &&
      (message.skill.outputAvailability !== "HISTORICAL_SNAPSHOT" || message.skillOutput === null) &&
      <p className="helper-text">Skill 输出当前不可读取；不会展示失效的历史正文或来源引用。</p>}
    {message.skillOutput && message.skill?.outputAvailability === "HISTORICAL_SNAPSHOT" &&
      message.role === "ASSISTANT" && message.status === "COMPLETED" &&
      <AssistSkillOutput client={client} output={message.skillOutput} currentTarget={target} />}
    {message.role === "ASSISTANT" && (message.status === "PENDING" || message.status === "RUNNING") && <>
      <p className="helper-text">{message.status === "PENDING" ? "等待生成" : "正在生成"}；此处不会把 202 回执当作完成。</p>
      {!message.cancelRequested && <button className="secondary-button" type="button" data-testid="assist-cancel"
        disabled={busy || pending || writeBlocked} onClick={() => onCancel(message.id)}>取消这条回复</button>}
    </>}
    {message.sources.length > 0 && <details><summary>本次实际来源</summary><ul>
      {message.sources.map((source, index) => {
        const available = source.sourceRef !== null && (message.skill
          ? source.status === "AVAILABLE" : source.status !== "UNAVAILABLE");
        const path = source.kind && source.rootId && source.version && available
          ? `/knowledge?kind=${encodeURIComponent(source.kind)}&item=${encodeURIComponent(source.rootId)}` : null;
        return <li key={index}>{available ? source.sourceRef : "来源不可用"} · {source.status}
          {path && <> · <Link className="inline-link" to={path}>打开来源条目</Link></>}
          {source.reason ? ` · ${source.reason}` : ""}</li>;
      })}
    </ul></details>}
    {message.role === "ASSISTANT" && message.status === "COMPLETED" &&
      <p className="helper-text">用量：输入 {message.usage.inputTokens ?? "未知"}、输出 {message.usage.outputTokens ?? "未知"} tokens</p>}
    </div>
  </article>;
}

function AssistSessionPanel({ client, session, target, sources, writeBlockedReason,
  refreshTarget, clearSentSources, standalone, onNavigationStateChange, sourcesOpen, onToggleSources }: { client: RelayApiClient;
  session: RelayAssistSession; target: AssistTarget; sources: readonly RelayAssistSourceRef[];
  writeBlockedReason: string | null;
  refreshTarget: () => Promise<void>;
  clearSentSources: (sent: readonly RelayAssistSourceRef[]) => void;
  standalone: boolean; onNavigationStateChange: (state: AssistNavigationState) => void;
  sourcesOpen: boolean; onToggleSources: () => void }) {
  const [messages, setMessages] = useState<readonly RelayAssistMessage[] | null>(null);
  const [previews, setPreviews] = useState<Readonly<Record<string, RelayAssistLivePreview>>>({});
  const [proposals, setProposals] = useState<readonly RelayAssistProposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [intent, setIntent] = useState<AssistIntent>("DISCUSS");
  const [skills, setSkills] = useState<readonly RelaySkillDefinition[]>([]);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [selectedSkillKey, setSelectedSkillKey] = useState("");
  const [skillInputText, setSkillInputText] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const requestVersion = useRef(0);
  const disposed = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (standalone && transcript && followLatest.current) transcript.scrollTop = transcript.scrollHeight;
  }, [standalone, messages, previews]);
  useEffect(() => {
    if (!standalone) return;
    onNavigationStateChange({ dirty: Boolean(draft.trim() || skillInputText.trim() || selectedSkillKey || intent !== "DISCUSS"),
      pending: pending ? { commandId: pending.commandId,
        commandType: pending.kind === "send" ? "RequestAssistMessage" : pending.kind === "cancel"
          ? "CancelAssistMessage" : "AcceptAssistProposal", sessionId: session.id } : null });
  }, [standalone, draft, skillInputText, selectedSkillKey, intent, pending, session.id, onNavigationStateChange]);

  async function refresh() {
    const version = ++requestVersion.current;
    try {
      const [nextMessages, nextProposals] = await Promise.all([
        client.getAssistMessages(session.id), client.getAssistProposals(session.id)]);
      if (disposed.current || version !== requestVersion.current || client !== liveClient()) return;
      if (nextMessages.some((item) => item.sessionId !== session.id) ||
          nextProposals.some((item) => item.sessionId !== session.id)) throw new Error("Assist 查询返回了其他会话的内容。");
      setMessages(nextMessages); setProposals(nextProposals); setError(null);
    } catch (caught) { if (!disposed.current && version === requestVersion.current) {
      setMessages(null); setProposals([]); setPreviews({}); setError(describeLiveError(caught).message);
    } }
  }
  useEffect(() => {
    disposed.current = false; void refresh();
    return () => { disposed.current = true; requestVersion.current++; };
  }, [client, session.id]);
  async function loadSkills() {
    try {
      const items = await client.getFirstPartySkills();
      if (disposed.current || client !== liveClient()) return;
      setSkills(items.filter((item) => item.target === target.kind &&
        supportedSkillOutput[item.id] === item.outputKind).sort((a, b) =>
        a.id === b.id ? b.version.localeCompare(a.version, undefined, { numeric: true }) :
          a.id.localeCompare(b.id))); setSkillError(null);
    } catch (caught) {
      if (!disposed.current) { setSkills([]); setSkillError(describeLiveError(caught).message); }
    }
  }
  useEffect(() => { void loadSkills(); }, [client, target.kind]);
  useEffect(() => {
    if (!messages?.some((item) => item.role === "ASSISTANT" && (item.status === "PENDING" || item.status === "RUNNING"))) return;
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => window.clearInterval(timer);
  }, [messages, client, session.id]);

  const previewIds = messages?.filter(canPreview).map((item) => item.id).join("|") ?? "";
  useEffect(() => {
    const ids = new Set(previewIds ? previewIds.split("|") : []);
    setPreviews((current) => {
      const kept = Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id) && writeBlockedReason === null));
      return Object.keys(kept).length === Object.keys(current).length ? current : kept;
    });
    if (ids.size === 0 || writeBlockedReason !== null) return;
    let active = true;
    let timer: number | undefined;
    async function poll() {
      await Promise.all([...ids].map(async (messageId) => {
        try {
          const next = await client.getAssistLivePreview(session.id, messageId);
          if (!active || disposed.current || client !== liveClient()) return;
          if (next.status !== "PENDING" && next.status !== "RUNNING") {
            ids.delete(messageId);
            setPreviews((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
            void refresh();
          } else if (!next.previewAvailable || next.previewText === null) {
            setPreviews((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
          } else {
            setPreviews((current) => ({ ...current, [messageId]: next }));
          }
        } catch (caught) {
          if (!active || disposed.current) return;
          setPreviews((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
          if (caught instanceof RelayApiError && (caught.problem.status === 404 || caught.problem.status === 403)) {
            ids.delete(messageId);
            void refresh();
          }
        }
      }));
      if (active && ids.size > 0) timer = window.setTimeout(() => { void poll(); }, 400);
    }
    void poll();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [previewIds, client, session.id, writeBlockedReason]);

  async function runAction(action: PendingAction, retry = false) {
    if (busy || (!retry && (pending !== null || writeBlockedReason !== null)) ||
      (retry && pending !== action)) return;
    setBusy(true); setPending(action); setActionError(null); setNotice(null);
    try {
      if (action.kind === "send") {
        followLatest.current = true;
        const common = { sessionId: session.id, commandId: action.commandId,
          content: action.content, sourceRefs: action.sources };
        if (action.skillRef && action.skillInput) {
          await client.requestAssistMessage({ ...common, skillRef: action.skillRef, skillInput: action.skillInput });
        } else if (action.intent) {
          await client.requestAssistMessage({ ...common, intent: action.intent });
        }
        if (disposed.current) return;
        setDraft(""); clearSentSources(action.sources);
        setNotice("消息已排队；回复状态以服务端消息为准。");
      } else if (action.kind === "cancel") {
        const status = await client.cancelAssistMessage(action.id, action.commandId);
        if (disposed.current) return;
        setNotice(status === "RUNNING" ? "取消意图已提交，等待生成安全结束。" : "消息已由服务端确认取消。");
      } else if (action.kind === "acceptTask") {
        const receipt = await client.acceptAssistProposal(action.id, action.commandId, {
          expectedTaskRevision: action.expectedTaskRevision,
          expectedAcceptanceRevision: action.expectedAcceptanceRevision,
          payloadHash: action.payloadHash });
        if (!receiptMatches({ ...receipt, commandType: "AcceptAssistProposal" }, action, session.id)) {
          throw new Error("Task 验收变更回执与原提案不匹配。");
        }
        if (disposed.current) return;
        setNotice(`提案已接受；Task v${receipt.result.revision} / 验收 v${receipt.result.acceptance_revision}。请重新读取当前准入预览。`);
        void refreshTarget();
      } else {
        await client.acceptAssistProposal(action.id, action.commandId);
        if (disposed.current) return;
        setNotice("提案接受回执已提交；业务结果以刷新后的目标与提案状态为准。");
      }
      setPending(null); await refresh();
    } catch (caught) {
      if (disposed.current) return;
      const described = describeLiveError(caught);
      if (described.kind !== "transport") setPending(null);
      setActionError(described.kind === "conflict" && action.kind === "acceptTask"
        ? `${described.message} 原提案仍保留供核对，不能覆盖当前验收；请重新生成提案。`
        : described.message);
      if (described.kind === "conflict" || described.kind === "transition") {
        void refresh(); void refreshTarget();
      }
    } finally { if (!disposed.current) setBusy(false); }
  }
  async function checkReceipt() {
    if (!pending || busy) return;
    setBusy(true); setActionError(null);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      if (disposed.current) return;
      if (!receiptMatches(receipt, pending, session.id)) throw new Error("回执与本次 Assist 命令不匹配。");
      if (pending.kind === "send") { setDraft(""); clearSentSources(pending.sources); }
      if (pending.kind === "acceptTask") void refreshTarget();
      setPending(null); setNotice("原命令回执已核对；正在读取服务端状态。"); await refresh();
    } catch (caught) { if (!disposed.current) setActionError(describeLiveError(caught).message); }
    finally { if (!disposed.current) setBusy(false); }
  }
  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || content.length > 32768 || pending || busy || writeBlockedReason !== null) return;
    const skill = skills.find((item) => `${item.id}@${item.version}` === selectedSkillKey);
    if (selectedSkillKey && (!skill || !skill.callSupported || skill.missingCapabilities.length > 0)) return;
    const input = skillInputText.trim();
    if (input.length > 2000) return;
    const skillInput: RelaySkillInput | null = !skill ? null : skill.id === "task-to-execution-contract"
      ? input ? { desired_result: input } : {}
      : skill.id === "project-resume" ? input ? { focus: input } : {}
      : input ? { risk_focus: input } : {};
    void runAction({ kind: "send", commandId: createCommandId(), content,
      intent: skill ? null : intent, skillRef: skill ? { id: skill.id, version: skill.version } : null,
      skillInput, sources: sources.map((ref) => ({ ...ref })) });
  }

  const selectedSkill = skills.find((item) => `${item.id}@${item.version}` === selectedSkillKey) ?? null;
  function currentSkillAccepts(proposal: RelayTaskSkillProposal): boolean {
    const source = messages?.find((message) => message.id === proposal.messageId);
    const outputKind = proposal.kind === "TASK_CONTRACT_CHANGE"
      ? "TASK_DEFINITION_SUGGESTION" : "VERIFICATION_PLAN_SUGGESTION";
    if (source && (source.role !== "ASSISTANT" || source.status !== "COMPLETED" ||
      source.skill?.definitionAvailability !== "AVAILABLE" ||
      source.skill.outputAvailability !== "HISTORICAL_SNAPSHOT" ||
      source.skill.sha256 !== proposal.skillSha256 ||
      source.skillOutput?.targetId !== proposal.targetId ||
      source.skillOutput.kind !== outputKind)) return false;
    return skills.some((current) => current.target === "TASK" && current.outputKind === outputKind &&
      current.sha256 === proposal.skillSha256 && current.callSupported && current.acceptSupported &&
      (!source || current.id === source.skill?.id && current.version === source.skill.version));
  }

  return <section className={standalone ? "surface-panel agent-chat-conversation" : "surface-panel"} data-testid="assist-session"><div className={standalone ? "agent-chat-conversation-heading" : undefined}><div><h2>{standalone ? "对话" : "消息与提案"}</h2>{standalone ? <details><summary>会话信息</summary><p className="helper-text">{session.title} · {session.status} · {session.id}</p></details> : <p className="helper-text">会话 {session.id} · {session.status}。生成与取消均以服务端状态为准。</p>}</div><button className="secondary-button" type="button" data-testid="assist-refresh" onClick={() => void refresh()}>{standalone ? "刷新" : "刷新消息与提案"}</button></div>
    <div ref={transcriptRef} className={standalone ? "agent-chat-transcript" : undefined}
      onScroll={(event) => {
        const element = event.currentTarget;
        followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
      }}>
    {messages === null && !error && <p role="status">正在读取会话消息…</p>}
    {error && <p className="action-error" role="alert">{error} <button type="button" className="text-link" onClick={() => void refresh()}>重读</button></p>}
    {messages?.length === 0 && <p className="helper-text">还没有消息。</p>}
    {!!messages?.length && <ol className="agent-message-list">{messages.map((message, index) => {
      const previous = index > 0 ? messages[index - 1] : undefined;
      const day = messageDay(message.createdAt);
      const newDay = day !== null && (previous === undefined || messageDay(previous.createdAt) !== day);
      return <li key={message.id} className="agent-message-slot">
        {newDay && <p className="agent-date-separator" role="separator" aria-label={`日期 ${day}`}><span>{day}</span></p>}
        <AssistMessageRow client={client} target={target} message={message} busy={busy} pending={pending !== null}
        preview={canPreview(message) && writeBlockedReason === null ? previews[message.id] ?? null : null}
        writeBlocked={writeBlockedReason !== null}
        onCancel={(id) => void runAction({ kind: "cancel", id, commandId: createCommandId() })} />
      </li>;
    })}</ol>}</div>
    {session.status === "ACTIVE" && <form className={standalone ? "create-form agent-chat-composer" : "create-form"} onSubmit={send}>
      {standalone && <p className="agent-chat-composer-heading">给这项工作补充要求</p>}
      <label className="field"><span className={standalone ? "visually-hidden" : "field-label"}>本次消息</span><textarea data-testid="assist-draft"
        placeholder={standalone ? "输入你的想法、修改意见或新的要求" : undefined}
        value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={32768} rows={standalone ? 2 : 4}
        disabled={pending !== null || busy} /></label>
      <details className={standalone ? "agent-chat-options" : "assist-options-expanded"} open={!standalone}><summary>发送选项 · {selectedSkill ? selectedSkill.title : intent === "DISCUSS" ? "普通讨论" : "提案"}</summary>
      <label className="field"><span className="field-label">生成方式</span><select data-testid="assist-skill"
        value={selectedSkillKey} onChange={(event) => { setSelectedSkillKey(event.target.value); setSkillInputText(""); }}
        disabled={pending !== null || busy}>
        <option value="">普通 Assist</option>
        {skills.map((skill) => <option key={`${skill.id}@${skill.version}`} value={`${skill.id}@${skill.version}`}
          disabled={!skill.callSupported || skill.missingCapabilities.length > 0}>{skill.title} v{skill.version} ·
          {!skill.callSupported ? "历史版本，仅可查阅" : skill.missingCapabilities.length > 0 ? "缺能力，当前不可调用" :
            skill.availability === "CALLABLE_READ_ONLY" ? "只读" : "仅建议"}</option>)}
      </select></label>
      {skillError && <p className="action-error" role="alert">Skill 清单暂不可读：{skillError}。
        普通 Assist 仍可用。<button className="text-link" type="button" onClick={() => void loadSkills()}>重读 Skill</button></p>}
      {selectedSkill ? <>
        <p className="helper-text">{selectedSkill.title} · {selectedSkill.id} v{selectedSkill.version} ·
          定义摘要 {selectedSkill.sha256} ·
          {selectedSkill.availability === "CALLABLE_READ_ONLY" ? "只读输出" : "仅生成建议"}。
          依赖：{selectedSkill.dependencies.map((dep) => `${dep.kind} ${dep.id}@${dep.version} (${dep.sha256})`).join("；")}。
          {selectedSkill.requiredCapabilities.length ? `需要能力：${selectedSkill.requiredCapabilities.join("、")}。` : "无额外 Connector 能力要求；模型服务仍须另行可用。"}
          {selectedSkill.missingCapabilities.length ? ` 缺少能力：${selectedSkill.missingCapabilities.join("、")}。` : ""}
          模型输出本身只读；可接受的 Task Skill 会另给服务端合并提案，需明确确认。</p>
        <label className="field"><span className="field-label">{selectedSkill.id === "task-to-execution-contract"
          ? "期望结果（可选）" : selectedSkill.id === "project-resume" ? "关注点（可选）" : "风险重点（可选）"}</span>
          <textarea data-testid="assist-skill-input" value={skillInputText}
            onChange={(event) => setSkillInputText(event.target.value)} maxLength={2000} rows={2}
            disabled={pending !== null || busy} /></label>
      </> : <label className="field"><span className="field-label">意图</span><select data-testid="assist-intent"
        value={intent} onChange={(event) => setIntent(event.target.value as AssistIntent)} disabled={pending !== null || busy}>
        <option value="DISCUSS">讨论</option>{target.kind === "TASK" && <option value="PROPOSE_CANDIDATE">提出 Markdown 候选</option>}
        {session.projectId !== null && <option value="PROPOSE_TASK">提出任务定义</option>}
      </select></label>}
      <p className="helper-text">本次发送冻结已选的 {sources.length} 个资料版本。Assist 不能自行提交业务修改。</p></details>
      {standalone && <div className="agent-chat-composer-actions">
        <span className="agent-chat-composer-tools">
          <span className="agent-chat-tool agent-chat-tool--pending" aria-disabled="true"
            title="附件上传尚未接入，不能发送未保存的本地文件">附件 · 待接入</span>
          <button className="agent-chat-tool" type="button" data-testid="assist-open-sources"
            aria-expanded={sourcesOpen} onClick={onToggleSources}>知识 · 已选 {sources.length}</button>
          <span className="agent-chat-tool agent-chat-tool--pending" aria-disabled="true"
            title="@ 引用尚未接入，不能凭文字猜测引用对象">@ 引用 · 待接入</span>
        </span>
        <button className="primary-button" data-testid="assist-send" type="submit"
          disabled={!draft.trim() || pending !== null || busy || writeBlockedReason !== null || Boolean(selectedSkillKey && !selectedSkill) ||
            Boolean(selectedSkill && (!selectedSkill.callSupported || selectedSkill.missingCapabilities.length > 0))}>{busy ? "正在提交" : "发送讨论"}</button>
      </div>}
      {!standalone && <button className="primary-button" data-testid="assist-send" type="submit"
        disabled={!draft.trim() || pending !== null || busy || writeBlockedReason !== null || Boolean(selectedSkillKey && !selectedSkill) ||
          Boolean(selectedSkill && (!selectedSkill.callSupported || selectedSkill.missingCapabilities.length > 0))}>{busy ? "正在提交" : "发送消息"}</button>}
    </form>}    {actionError && <p className="action-error" role="alert">{actionError}</p>}{notice && <p className="receipt-message" role="status">{notice}</p>}{pending && <div className="assist-pending"><p className="helper-text">命令结果待核对，原 command_id：{pending.commandId}。先查回执；未找到时只能用原命令 ID 和原载荷重试。</p><button className="secondary-button" type="button" disabled={busy} onClick={() => void checkReceipt()}>查询原命令回执</button><button className="secondary-button" type="button" disabled={busy} onClick={() => void runAction(pending, true)}>以原命令重试</button></div>}
    <details className={standalone ? "agent-chat-proposals" : "assist-options-expanded"} open={!standalone}><summary>Assist 提案 · {proposals.length}</summary><h3>Assist 提案</h3>{!proposals.length && <p className="helper-text">当前会话没有待确认提案；Skill 历史输出仍可只读查看。</p>}{proposals.map((proposal) =>
      "baseAcceptanceRevision" in proposal
        ? <TaskContractProposalPreview key={`${proposal.id}:${proposal.status}:${target.revision}`} client={client} proposal={proposal}
          taskId={target.id} projectId={target.projectId} disabled={busy || pending !== null || writeBlockedReason !== null}
          acceptSupported={currentSkillAccepts(proposal)}
          onAccept={(selected: RelayTaskSkillProposal) => void runAction({ kind: "acceptTask",
            id: selected.id, taskId: selected.targetId, commandId: createCommandId(),
            expectedTaskRevision: selected.baseRevision,
            expectedAcceptanceRevision: selected.baseAcceptanceRevision,
            payloadHash: selected.payloadHash })} />
        : <article className="assist-proposal" key={proposal.id}><h4>{proposal.kind === "CANDIDATE_MARKDOWN" ? "Markdown 候选" : "任务定义提案"} · {proposal.status}</h4><p className="helper-text">目标 {proposal.targetType} · {proposal.targetId} · 基于修订 v{proposal.baseRevision} · 内容摘要 {proposal.payloadHash}</p>{proposal.kind === "CANDIDATE_MARKDOWN" ? <><p><strong>拟新增受管产物：</strong>{proposal.payload.title}（{proposal.payload.mediaType}）</p><pre className="assist-proposal-payload">{proposal.payload.markdown}</pre></> : <><p><strong>拟创建任务：</strong>{proposal.payload.title}</p><p>{proposal.payload.objective}</p><h5>验收条件</h5><ul>{proposal.payload.criteria.map((criterion, index) => <li key={index}>{criterion.statement} · {criterion.required ? "必需" : "可选"} · {criterion.method}</li>)}</ul><p className="helper-text">预期产物：{JSON.stringify(proposal.payload.expectedOutputs)}</p></>}{proposal.status === "PENDING" && <button className="primary-button" type="button" disabled={busy || pending !== null || writeBlockedReason !== null} onClick={() => void runAction({ kind: "accept", id: proposal.id, commandId: createCommandId() })}>接受此提案</button>}</article>)}</details>
  </section>;
}
