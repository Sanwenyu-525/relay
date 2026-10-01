import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ArrowDown, BookOpen, MessageSquareText, RotateCcw, Send } from "lucide-react";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayAssistLivePreview,
  type RelayAssistMessage, type RelayAssistProposal,
  type RelayAssistSession, type RelayAssistSourceRef, type RelayCommandReceipt,
  type RelaySkillDefinition, type RelaySkillInput, type RelayTaskSkillProposal } from "../api/relayClient";
import AssistSkillOutput from "../components/AssistSkillOutput";
import AssistSourcePicker from "../components/AssistSourcePicker";
import SafeMarkdown from "../components/SafeMarkdown";
import TaskContractProposalPreview from "../components/TaskContractProposalPreview";
import { describeLiveError } from "../lib/liveErrors";
import { modelErrorGuides } from "../lib/modelErrorGuides";
import { liveClient, useRelayConnection } from "../lib/relayConnection";
import "./AssistView.css";

type AssistTarget = { readonly kind: "PROJECT" | "TASK"; readonly id: string; readonly title: string;
  readonly revision: string; readonly projectId: string | null; readonly executor: string | null;
  readonly archivedAt: string | null | undefined };
type AssistIntent = "DISCUSS" | "PROPOSE_CANDIDATE" | "PROPOSE_TASK";
type PreviewReadError = { readonly message: string; readonly lastSuccessAt: string | null };
const intentLabels: Record<AssistIntent, string> = {
  DISCUSS: "发送讨论", PROPOSE_CANDIDATE: "请求文档候选", PROPOSE_TASK: "请求任务提案"
};
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
  readonly discard?: () => void;
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
  standalone = false, onNavigationStateChange, onRequestNewSession, embedded = false,
  onRequestSessionChange, onSessionSelected,
  preferredSkillId, onTargetChanged, externalReadBlockedReason = null, externalWriteBlockedReason = null, proposalActionHost }: {
  targetKind?: "PROJECT" | "TASK"; targetId?: string; preferredSessionId?: string | null;
  onSessionCreated?: (sessionId: string) => void;
  standalone?: boolean; onNavigationStateChange?: (state: AssistNavigationState) => void;
  onRequestNewSession?: (proceed: () => void) => void;
  onRequestSessionChange?: (proceed: () => void) => void;
  onSessionSelected?: (sessionId: string | null) => void;
  embedded?: boolean; preferredSkillId?: string; onTargetChanged?: () => void;
  externalReadBlockedReason?: string | null;
  externalWriteBlockedReason?: string | null;
  proposalActionHost?: HTMLElement | null;
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
    if (!standalone && !embedded) return;
    onNavigationStateChange?.({ dirty: sessionNavigation.dirty || selectedRefs.length > 0,
      discard: () => { sessionNavigation.discard?.(); setSelectedRefs([]); },
      pending: pendingCreate ? { commandId: pendingCreate.commandId,
        commandType: "CreateAssistSession", sessionId: null } : sessionNavigation.pending });
  }, [standalone, embedded, sessionNavigation, selectedRefs, pendingCreate, onNavigationStateChange]);

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
  const projectWriteBlockedReason = externalReadBlockedReason ?? externalWriteBlockedReason ?? (target.projectId === null ? null : loading || error !== null || target.archivedAt === undefined ?
    "Project 事实正在核对或读取失败，不能发送新的 Assist 命令。" : target.archivedAt !== null ?
      "项目已归档，不能发送新的 Assist 命令。" : null);
  const session = sessions.find((item) => item.id === sessionId) ?? null;
  const sessionChangeBlocked = sessionNavigation.pending !== null || pendingCreate !== null ||
    (!standalone && (sessionNavigation.dirty || selectedRefs.length > 0));
  function selectSession(next: string | null) {
    if (next === sessionId || sessionChangeBlocked) return;
    const proceed = () => { setSessionId(next); setSelectedRefs([]); onSessionSelected?.(next); };
    if (standalone && onRequestSessionChange) onRequestSessionChange(proceed);
    else proceed();
  }
  const sessionControls = <div className="form-actions"><label className="field"><span className="field-label">当前会话</span><select data-testid="assist-session-select" disabled={creating || sessionChangeBlocked} value={sessionId ?? ""} onChange={(event) => selectSession(event.target.value || null)}><option value="">选择会话</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.title}{item.status !== "ACTIVE" ? " · 已结束" : ""}</option>)}</select></label><button className={standalone && !session ? "primary-button" : "secondary-button"} type="button" data-testid="assist-new-session" disabled={creating || pendingCreate !== null || projectWriteBlockedReason !== null || sessionChangeBlocked} onClick={() => standalone && onRequestNewSession ? onRequestNewSession(() => void createSession()) : void createSession()}>{creating ? "正在创建" : "新建会话"}</button><button className="secondary-button" type="button" disabled={sessionChangeBlocked} onClick={() => void loadTarget(sessionId ?? undefined)}>刷新会话</button></div>;
  const sourcePicker = session?.status === "ACTIVE" ? <AssistSourcePicker key={`${connection.epoch}:${session.id}:${target.projectId ?? "none"}`} projectId={target.projectId} selectedRefs={selectedRefs} onChange={setSelectedRefs} /> : null;
  return <section className={embedded ? "embedded-assist" : standalone ? "skill-page agent-assist" : "skill-page page-primary"} data-testid="assist-target"><div className={standalone ? "agent-assist-heading" : undefined}><div>{embedded ? null : <><p className="eyebrow" title={id}>{kind === "PROJECT" ? "项目 Assist" : "任务 Assist"}{!standalone && ` · ${id}`}</p><h1>{target.title}</h1></>}{!standalone && !embedded && <><p className="page-lede">当前目标修订 v{target.revision}{target.executor && <> · 当前执行者 {target.executor}</>}</p><p className="helper-text">消息固定写入当前会话；切换目标后重新读取。Assist 建议不会自动修改业务事实。</p></>}</div>{!embedded && <Link className="text-link" to={kind === "PROJECT" ? `/projects/${id}` : `/tasks/${id}`}>返回{kind === "PROJECT" ? "项目" : "任务"}</Link>}</div>{loading && <p role="status">正在刷新目标与会话…</p>}{error && <p className="action-error" role="alert">{error}</p>}
    {projectWriteBlockedReason && <p className="disabled-reason" data-testid="assist-archive-reason">{projectWriteBlockedReason}</p>}
    {!externalReadBlockedReason && !(embedded && session) && <section className={standalone ? `agent-assist-session-bar${!session ? " agent-assist-session-bar--empty" : ""}` : "surface-panel"}>{!standalone && <h2>会话</h2>}{standalone && !session && <div className="agent-session-welcome"><MessageSquareText aria-hidden="true" /><h2>开始讨论</h2></div>}{!session && preferredSessionId === null && <p className="helper-text" data-testid="assist-new-session-prompt">目标已选。可以新建会话，或在“当前会话”中返回已有讨论。</p>}{!sessions.length && preferredSessionId !== null && <p className="helper-text">当前目标还没有会话，先新建会话再发送消息。</p>}{sessionControls}</section>}
    {createError && <p className="action-error" role="alert">{createError}</p>}{pendingCreate && <div className="agent-assist-session-status"><p className="helper-text">创建结果待核对，原 command_id：{pendingCreate.commandId}</p><button type="button" className="secondary-button" disabled={creating} onClick={() => void checkCreateReceipt()}>查询创建回执</button><button type="button" className="secondary-button" disabled={creating} onClick={() => void createSession(pendingCreate)}>以原命令重试</button></div>}
    {externalReadBlockedReason && selectedRefs.length > 0 && <button className="secondary-button" type="button" disabled={sessionNavigation.pending !== null} onClick={() => setSelectedRefs([])}>清空本次资料选择</button>}
    {session && <>{!externalReadBlockedReason && !standalone && !embedded && sourcePicker}
      <AssistSessionPanel key={`${connection.epoch}:${session.id}`} client={client} session={session} target={target} sources={selectedRefs}
        standalone={standalone} embedded={embedded} onNavigationStateChange={reportSessionNavigation}
        sourcePicker={sourcePicker}
        sourcesOpen={sourcesOpen} onToggleSources={() => setSourcesOpen((open) => !open)}
        preferredSkillId={preferredSkillId}
        proposalActionHost={proposalActionHost}
        externalReadBlockedReason={externalReadBlockedReason}
        writeBlockedReason={projectWriteBlockedReason}
        refreshTarget={async () => { await loadTarget(session.id); onTargetChanged?.(); }}
        clearSentSources={(sent) => setSelectedRefs((current) => JSON.stringify(current) === JSON.stringify(sent) ? [] : current)} />
      {!externalReadBlockedReason && embedded && <details className="embedded-assist-sources"><summary>会话与本次资料 · {session.title}</summary>{sessionControls}{sourcePicker}</details>}</>}
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

function AssistMessageRow({ client, target, message, preview, previewError, onRetryPreview, busy, pending, writeBlocked, onCancel }: { client: RelayApiClient;
  target: AssistTarget; message: RelayAssistMessage; busy: boolean; pending: boolean; writeBlocked: boolean;
  preview: RelayAssistLivePreview | null;
  previewError: PreviewReadError | null; onRetryPreview: () => void;
  onCancel: (id: string) => void }) {
  const user = message.role === "USER";
  return <article className="agent-message" data-role={message.role}>
    <span className="agent-message-avatar" aria-hidden="true">{user ? "我" : <MessageSquareText />}</span>
    <div className="agent-message-body">
    <p className="agent-message-meta"><span className="agent-message-role">{user ? "我" : "AI"}</span>
      {messageTime(message.createdAt) !== "" && <time dateTime={message.createdAt ?? undefined}>{messageTime(message.createdAt)}</time>}
      {/* 完成态不占位：正常完成不需要额外标注，未完成和失败必须显式说明。 */}
      {messageStatusLabels[message.status] !== "" && <span className="agent-message-status">
        {messageStatusLabels[message.status]}
        {message.cancelRequested && message.status === "RUNNING" ? "（正在取消）" : ""}</span>}</p>
    {/* 用户输入保持纯文本；只有 AI 最终正文走安全 Markdown，Skill 输出另由 AssistSkillOutput 渲染，避免同一正文出现两次。 */}
    {message.content !== null && user &&
      <p className="assist-message-content">{message.content}</p>}
    {message.content !== null && !user && message.skill === null &&
      <div className="assist-message-content assist-message-markdown"><SafeMarkdown source={message.content} /></div>}
    {canPreview(message) && preview?.previewAvailable && preview.previewText !== null &&
      <div data-testid={`assist-live-preview-${message.id}`}><p className="helper-text">生成中草稿 · 仅当前预览 v{preview.previewRevision}，不是完整消息或已接受产物{preview.previewTruncated ? " · 预览已截断" : ""}</p>
        <p className="assist-message-content">{preview.previewText}</p></div>}
    {canPreview(message) && previewError && <div className="assist-preview-error" role="alert"
      data-testid={`assist-preview-error-${message.id}`}>
      <p>生成预览读取失败：{previewError.message}</p>
      <p className="helper-text">后台回复状态仍以消息为准。{previewError.lastSuccessAt
        ? `最近成功读取：${messageTime(previewError.lastSuccessAt)}。` : "尚未成功读取预览。"}</p>
      <button className="text-link" type="button" disabled={writeBlocked} onClick={onRetryPreview}>重新读取预览</button>
    </div>}
    {message.errorCode && <p className="action-error">生成失败：{message.errorCode}</p>}
    {message.status === "FAILED" && message.providerErrorKind !== null &&
      <p className="helper-text" data-testid="assist-provider-error">模型服务：{modelErrorGuides[message.providerErrorKind]}</p>}
    {message.skill && message.role === "ASSISTANT" && message.status === "COMPLETED" &&
      (message.skill.outputAvailability !== "HISTORICAL_SNAPSHOT" || message.skillOutput === null) &&
      <p className="helper-text">Skill 输出当前不可读取；不会展示失效的历史正文或来源引用。</p>}
    {message.skillOutput && message.skill?.outputAvailability === "HISTORICAL_SNAPSHOT" &&
      message.role === "ASSISTANT" && message.status === "COMPLETED" &&
      <AssistSkillOutput client={client} output={message.skillOutput} currentTarget={target} />}
    {message.skill && <details><summary>Skill 来源与定义</summary><p className="helper-text">
      {message.skill.id} v{message.skill.version}
      {message.skill.sha256 && <> · 定义摘要 {message.skill.sha256}</>}
      {message.skill.definitionAvailability === "HISTORICAL_ONLY" &&
        <> · 冻结历史定义仅可查阅；当前注册表不再提供此版本，不能新调用或接受，不会以新版替换历史来源</>}
      {message.skill.definitionAvailability === "UNAVAILABLE" && <> · 历史定义不可用</>}
      {message.skill.missingCapabilities.length > 0 && <> · 缺少能力 {message.skill.missingCapabilities.join("、")}</>}
    </p></details>}
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
      <details><summary>消息详情</summary><p className="helper-text">用量：输入 {message.usage.inputTokens ?? "未知"}、输出 {message.usage.outputTokens ?? "未知"} tokens</p></details>}
    </div>
  </article>;
}

function AssistSessionPanel({ client, session, target, sources, writeBlockedReason,
  refreshTarget, clearSentSources, standalone, onNavigationStateChange, sourcesOpen, onToggleSources,
  sourcePicker, preferredSkillId, embedded, externalReadBlockedReason, proposalActionHost }: { client: RelayApiClient;
  session: RelayAssistSession; target: AssistTarget; sources: readonly RelayAssistSourceRef[];
  writeBlockedReason: string | null;
  refreshTarget: () => Promise<void>;
  clearSentSources: (sent: readonly RelayAssistSourceRef[]) => void;
  standalone: boolean; onNavigationStateChange: (state: AssistNavigationState) => void;
  sourcesOpen: boolean; onToggleSources: () => void;
  sourcePicker: ReactNode; preferredSkillId?: string; embedded?: boolean;
  externalReadBlockedReason: string | null; proposalActionHost?: HTMLElement | null }) {
  const [messages, setMessages] = useState<readonly RelayAssistMessage[] | null>(null);
  const [previews, setPreviews] = useState<Readonly<Record<string, RelayAssistLivePreview>>>({});
  const [previewErrors, setPreviewErrors] = useState<Readonly<Record<string, PreviewReadError>>>({});
  const [previewRetry, setPreviewRetry] = useState(0);
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
  const composerFormId = useId();
  const requestVersion = useRef(0);
  const disposed = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [atLatest, setAtLatest] = useState(true);
  const previewSuccessAt = useRef<Record<string, string>>({});
  const skillPreferenceApplied = useRef(false);
  const discardDraft = useCallback(() => {
    if (pending || busy) return;
    setDraft(""); setSkillInputText(""); setSelectedSkillKey(""); setIntent("DISCUSS");
  }, [pending, busy]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (standalone && transcript && transcript.clientHeight > 0 && followLatest.current)
      transcript.scrollTop = transcript.scrollHeight;
  }, [standalone, messages, previews, proposals]);
  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    const content = transcriptContentRef.current;
    if (!standalone || !transcript || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      // 隐藏布局不能重置阅读意图；再次显示时由尺寸通知继续原来的跟随状态。
      if (followLatest.current && transcript.clientHeight > 0) transcript.scrollTop = transcript.scrollHeight;
    });
    observer.observe(transcript); observer.observe(content);
    return () => observer.disconnect();
  }, [standalone, externalReadBlockedReason]);
  useEffect(() => {
    if (!standalone && !embedded) return;
    onNavigationStateChange({ dirty: Boolean(draft.trim() || skillInputText.trim() || (standalone && (selectedSkillKey || intent !== "DISCUSS"))),
      discard: discardDraft,
      pending: pending ? { commandId: pending.commandId,
        commandType: pending.kind === "send" ? "RequestAssistMessage" : pending.kind === "cancel"
          ? "CancelAssistMessage" : "AcceptAssistProposal", sessionId: session.id } : null });
  }, [standalone, embedded, draft, skillInputText, selectedSkillKey, intent, pending, session.id, onNavigationStateChange, discardDraft]);

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
      setMessages(null); setProposals([]); setPreviews({}); setPreviewErrors({}); setError(describeLiveError(caught).message);
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
      const supported = items.filter((item) => item.target === target.kind &&
        supportedSkillOutput[item.id] === item.outputKind).sort((a, b) =>
        a.id === b.id ? b.version.localeCompare(a.version, undefined, { numeric: true }) :
          a.id.localeCompare(b.id));
      setSkills(supported); setSkillError(null);
      if (!skillPreferenceApplied.current && preferredSkillId) {
        const preferred = supported.find((item) => item.id === preferredSkillId && item.callSupported);
        if (preferred) setSelectedSkillKey(`${preferred.id}@${preferred.version}`);
        skillPreferenceApplied.current = true;
      }
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
    setPreviewErrors((current) => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
    if (ids.size === 0 || writeBlockedReason !== null) return;
    let active = true;
    let timer: number | undefined;
    async function poll() {
      await Promise.all([...ids].map(async (messageId) => {
        try {
          const next = await client.getAssistLivePreview(session.id, messageId);
          if (!active || disposed.current || client !== liveClient()) return;
          setPreviewErrors((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
          if (next.status !== "PENDING" && next.status !== "RUNNING") {
            ids.delete(messageId);
            setPreviews((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
            void refresh();
          } else if (!next.previewAvailable || next.previewText === null) {
            setPreviews((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
          } else {
            previewSuccessAt.current[messageId] = new Date().toISOString();
            setPreviews((current) => ({ ...current, [messageId]: next }));
          }
        } catch (caught) {
          if (!active || disposed.current) return;
          setPreviews((current) => { const copy = { ...current }; delete copy[messageId]; return copy; });
          setPreviewErrors((current) => ({ ...current, [messageId]: {
            message: describeLiveError(caught).message, lastSuccessAt: previewSuccessAt.current[messageId] ?? null
          } }));
          ids.delete(messageId);
          if (caught instanceof RelayApiError && (caught.problem.status === 404 || caught.problem.status === 403)) {
            void refresh();
          }
        }
      }));
      if (active && ids.size > 0) timer = window.setTimeout(() => { void poll(); }, 400);
    }
    void poll();
    return () => { active = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [previewIds, previewRetry, client, session.id, writeBlockedReason]);

  async function runAction(action: PendingAction, retry = false) {
    if (busy || (!retry && (pending !== null || writeBlockedReason !== null)) ||
      (retry && pending !== action)) return;
    setBusy(true); setPending(action); setActionError(null); setNotice(null);
    try {
      if (action.kind === "send") {
        followLatest.current = true; setAtLatest(true);
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

  const transcriptContent = <>
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
        previewError={previewErrors[message.id] ?? null} onRetryPreview={() => setPreviewRetry((value) => value + 1)}
        writeBlocked={writeBlockedReason !== null}
        onCancel={(id) => void runAction({ kind: "cancel", id, commandId: createCommandId() })} />
      </li>;
    })}</ol>}</>;

  const visibleProposals = embedded ? proposals.filter((proposal) => preferredSkillId === "task-to-execution-contract"
    ? proposal.kind === "TASK_CONTRACT_CHANGE" : proposal.kind === "VERIFICATION_PLAN_CHANGE") : proposals;
  const featuredProposalId = visibleProposals.find((proposal) => proposal.status === "PENDING")?.id ?? visibleProposals[0]?.id;
  const ProposalContainer = embedded ? "section" : "details";
  const pendingProposalCount = visibleProposals.filter((proposal) => proposal.status === "PENDING").length;
  const proposalPanel = <ProposalContainer className={standalone ? "agent-chat-proposals" : embedded ? "embedded-assist-proposals" : "assist-options-expanded"} data-testid="assist-proposals" open={embedded ? undefined : !standalone || pendingProposalCount > 0}>
    {!embedded && <><summary>Assist 提案 · {visibleProposals.length}{pendingProposalCount > 0 ? ` · ${pendingProposalCount} 个待确认提议` : ""}</summary>{!standalone && <h3>Assist 提案</h3>}</>}
    {!visibleProposals.length && <p className="helper-text">当前会话没有待确认提案；Skill 历史输出仍可只读查看。</p>}
    {visibleProposals.map((proposal) => {
      if ("baseAcceptanceRevision" in proposal) {
        const preview = <TaskContractProposalPreview key={`${proposal.id}:${proposal.status}:${target.revision}`} client={client} proposal={proposal}
          taskId={target.id} projectId={target.projectId} disabled={busy || pending !== null || writeBlockedReason !== null}
          acceptSupported={currentSkillAccepts(proposal)}
          actionHost={embedded && proposal.id === featuredProposalId ? proposalActionHost : undefined}
          onAccept={(selected: RelayTaskSkillProposal) => void runAction({ kind: "acceptTask",
            id: selected.id, taskId: selected.targetId, commandId: createCommandId(),
            expectedTaskRevision: selected.baseRevision,
            expectedAcceptanceRevision: selected.baseAcceptanceRevision,
            payloadHash: selected.payloadHash })} />;
        return standalone ? <article className="assist-proposal agent-chat-proposal-card" key={`${proposal.id}:${proposal.status}:${target.revision}`}>
          <div className="task-proposal-heading"><h4>{proposal.kind === "TASK_CONTRACT_CHANGE" ? "任务定义提议" : "验收方案提议"}</h4>
            <span className="task-proposal-state" data-status={proposal.status}>{proposal.status === "PENDING" ? "待确认" : proposal.status}</span></div>
          {proposal.payloadAvailable && proposal.targetId === target.id && proposal.payload
            ? <><p className="assist-proposal-summary">{proposal.payload.objective}</p><p className="helper-text">保留 {proposal.payload.preservedCriterionIds.length} 条验收条件，新增 {proposal.payload.addedCriterionIds.length} 条；接受后创建新版本。</p></>
            : <p className="helper-text">提议内容当前不可读，不能确认。</p>}
          <details className="agent-chat-proposal-details"><summary>{proposal.status === "PENDING" ? "查看提议与接受操作" : "查看完整提议"}</summary>{preview}</details>
        </article> : preview;
      }
      return <article className="assist-proposal agent-chat-proposal-card" key={proposal.id}>
        <div className="task-proposal-heading"><h4>{proposal.kind === "CANDIDATE_MARKDOWN" ? "Markdown 候选" : "任务定义提案"}</h4>
          <span className="task-proposal-state" data-status={proposal.status}>{proposal.status === "PENDING" ? "待确认" : proposal.status}</span></div>
        <p><strong>{proposal.kind === "CANDIDATE_MARKDOWN" ? "拟新增受管产物：" : "拟创建任务："}</strong>{proposal.payload.title}</p>
        {proposal.kind === "TASK_DEFINITION" && <p className="assist-proposal-summary">{proposal.payload.objective}</p>}
        <details className="agent-chat-proposal-details"><summary>{proposal.status === "PENDING" ? "查看提议与接受操作" : "查看完整提议"}</summary>
          {proposal.kind === "CANDIDATE_MARKDOWN" ? <><p className="helper-text">{proposal.payload.mediaType}</p><pre className="assist-proposal-payload">{proposal.payload.markdown}</pre></>
            : <><p>{proposal.payload.objective}</p><h5>验收条件</h5><ul>{proposal.payload.criteria.map((criterion, index) => <li key={index}>{criterion.statement} · {criterion.required ? "必需" : "可选"} · {criterion.method}</li>)}</ul><p className="helper-text">预期产物：{JSON.stringify(proposal.payload.expectedOutputs)}</p></>}
          <details><summary>核对目标与内容摘要</summary><p className="helper-text">目标 {proposal.targetType} · {proposal.targetId} · 基于修订 v{proposal.baseRevision} · 内容摘要 {proposal.payloadHash}</p></details>
          {proposal.status === "PENDING" && <button className="primary-button" type="button" disabled={busy || pending !== null || writeBlockedReason !== null} onClick={() => void runAction({ kind: "accept", id: proposal.id, commandId: createCommandId() })}>接受此提案</button>}
        </details>
      </article>;
    })}
  </ProposalContainer>;

  const transcript = <div ref={transcriptRef} className={standalone ? "agent-chat-transcript" : undefined}
    role="region" aria-label="会话消息" tabIndex={0} data-testid="assist-transcript"
    onScroll={(event) => {
      const element = event.currentTarget;
      if (element.clientHeight === 0) return;
      const latest = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
      followLatest.current = latest; setAtLatest(latest);
    }}><div ref={transcriptContentRef} className="agent-chat-content">{transcriptContent}{standalone && !externalReadBlockedReason && visibleProposals.length > 0 && proposalPanel}</div></div>;
  const frozenSkill = pending?.kind === "send" && pending.skillRef
    ? skills.find((item) => item.id === pending.skillRef?.id && item.version === pending.skillRef.version) : null;
  const sendLabel = pending?.kind === "send"
    ? pending.skillRef ? `运行 ${frozenSkill?.title ?? pending.skillRef.id}` : intentLabels[pending.intent ?? "DISCUSS"]
    : selectedSkill ? `运行 ${selectedSkill.title}` : intentLabels[intent];

  const sendOptions = <details className={standalone ? "agent-chat-options" : "assist-options-expanded"} open={!standalone || sourcesOpen}
        onKeyDown={(event) => {
          if (!standalone || !sourcesOpen || event.key !== "Escape" || event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault(); event.stopPropagation();
          onToggleSources(); event.currentTarget.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
        }}
        onToggle={(event) => { if (standalone && event.currentTarget.open !== sourcesOpen) onToggleSources(); }}><summary>{standalone ? "选项" : "发送选项"}{!standalone && <> · {selectedSkill ? selectedSkill.title : intent === "DISCUSS" ? "普通讨论" : "提案"}</>}</summary>
      {standalone && sourcePicker}
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
      <p className="helper-text">本次发送冻结已选的 {sources.length} 个资料版本。Assist 不能自行提交业务修改。</p></details>;

  return <section className={standalone ? "surface-panel agent-chat-conversation" : "surface-panel"} data-testid="assist-session">
    {!externalReadBlockedReason && embedded && proposalPanel}
    {!externalReadBlockedReason && <div className={standalone ? "agent-chat-conversation-heading" : embedded ? "embedded-assist-session-heading" : undefined}><div>{!embedded && <h2>{standalone ? "对话" : "消息与提案"}</h2>}{standalone || embedded ? <details><summary>会话信息</summary><p className="helper-text">{session.title} · {session.status} · {session.id}</p></details> : <p className="helper-text">会话 {session.id} · {session.status}。生成与取消均以服务端状态为准。</p>}</div><button className="secondary-button" type="button" data-testid="assist-refresh" onClick={() => void refresh()}>{standalone ? "刷新" : "刷新消息与提案"}</button></div>}
    {!externalReadBlockedReason && (embedded ? <details className="embedded-assist-history"><summary>查看会话历史与原始建议</summary>{transcript}</details> : <div className={standalone ? "agent-chat-transcript-shell" : undefined}>{transcript}
    {standalone && !atLatest && <button className="secondary-button agent-chat-latest" type="button" data-testid="assist-latest"
      onClick={() => {
        const element = transcriptRef.current;
        followLatest.current = true; setAtLatest(true);
        if (element) { element.scrollTop = element.scrollHeight; element.focus({ preventScroll: true }); }
      }}><ArrowDown aria-hidden="true" />回到最新</button>}
    </div>)}

    {session.status === "ACTIVE" && <div className={standalone ? "agent-chat-composer" : "create-form"}><form id={composerFormId} className="agent-chat-message-form" onSubmit={send}>
      <label className="field"><span className={standalone ? "visually-hidden" : "field-label"}>本次消息</span><textarea data-testid="assist-draft"
        placeholder={standalone ? "输入你的想法、修改意见或新的要求" : undefined}
        value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={32768} rows={standalone ? 2 : 4}
        disabled={pending !== null || busy} onKeyDown={(event) => {
          if (standalone && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault(); event.currentTarget.form?.requestSubmit();
          }
        }} /></label>
      {!standalone && <button className="primary-button" data-testid="assist-send" type="submit"
        disabled={!draft.trim() || pending !== null || busy || writeBlockedReason !== null || Boolean(selectedSkillKey && !selectedSkill) ||
          Boolean(selectedSkill && (!selectedSkill.callSupported || selectedSkill.missingCapabilities.length > 0))}>{busy ? `正在提交 · ${sendLabel}` : sendLabel}</button>}
    </form>
      {standalone && <div className="agent-chat-composer-actions">
        <div className="agent-chat-composer-tools">
          <button className="agent-chat-tool" type="button" data-testid="assist-open-sources"
            aria-expanded={sourcesOpen} onClick={onToggleSources}><BookOpen aria-hidden="true" />资料 {sources.length}</button>
          {sendOptions}
          <span className="helper-text agent-chat-send-hint">Enter 发送，Shift + Enter 换行</span>
        </div>
        <button className="primary-button" data-testid="assist-send" type="submit" form={composerFormId}
          disabled={!draft.trim() || pending !== null || busy || writeBlockedReason !== null || Boolean(selectedSkillKey && !selectedSkill) ||
            Boolean(selectedSkill && (!selectedSkill.callSupported || selectedSkill.missingCapabilities.length > 0))}><Send aria-hidden="true" />{busy ? `正在提交 · ${sendLabel}` : sendLabel}</button>
      </div>}
      {!standalone && sendOptions}
    </div>}    {actionError && <p className="action-error" role="alert">{actionError}</p>}{notice && <p className="receipt-message" role="status">{notice}</p>}{pending && <div className="assist-pending"><p className="helper-text">命令结果待核对，原 command_id：{pending.commandId}。先查回执；未找到时只能用原命令 ID 和原载荷重试。</p><button className="secondary-button" type="button" disabled={busy} onClick={() => void checkReceipt()}>查询原命令回执</button><button className="secondary-button" type="button" disabled={busy} onClick={() => void runAction(pending, true)}>以原命令重试</button></div>}
    {!externalReadBlockedReason && !embedded && !standalone && proposalPanel}
  </section>;
}
