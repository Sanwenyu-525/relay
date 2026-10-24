import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  createCommandId, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayCommandEnvelope, type RelayGatewayCapability,
  type RelayGatewayConnectionSettings, type RelayGatewayDecision, type RelayGatewayPolicy,
  type RelayGatewayPolicyVersion, type RelayManagedResource, type RelayProject, type RelayProjectListItem
} from "../api/relayClient";
import ProjectNav from "../components/ProjectNav";
import PageHeader from "../components/PageHeader";
import ViewConfigurationPanel from "../components/ViewConfigurationPanel";
import { describeLiveError } from "../lib/liveErrors";
import { gatewayCapabilityLabel } from "../lib/labels";
import { type RelayPluginRuntimeStatus } from "../api/resources/plugins";
import { useRelayConnection } from "../lib/relayConnection";
import "./ConnectionsView.css";

/**
 * 普通入口只列真实工具能力。测试能力（FAKE_*）不是用户要用的工具，把它们混进正常下拉，
 * 等于让普通用户在一个「选哪个能力」的问题里先遇到一个只对测试有意义的选项。
 * 显式开发入口见 `devCapabilitiesEnabled`（地址带 `?dev-capabilities=1`）。
 */
const dailyCapabilities: readonly RelayGatewayCapability[] =
  ["WEB_FETCH", "FILE_READ", "FILE_QUERY", "FILE_WRITE", "GIT_READ", "GIT_WRITE", "CLI_RUN",
    "COMPUTER_READ", "COMPUTER_INPUT", "GITHUB_READ", "BROWSER_READ", "BROWSER_ACTION", "BROWSER_COMMIT"];
const testCapabilities: readonly RelayGatewayCapability[] = ["FAKE_WRITE", "FAKE_PUBLIC_READ"];
/** 全部能力：只用于把历史策略回填到表单，不作为可选清单。 */
const allCapabilities: readonly RelayGatewayCapability[] = [...dailyCapabilities, ...testCapabilities];
/** 显式开发入口：只有主动在地址上声明，才把测试能力放进下拉。 */
function devCapabilitiesEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try { return new URLSearchParams(window.location.search).get("dev-capabilities") === "1"; }
  catch { return false; }
}
/** 服务端 rootBoundCaps：这类 Connection 必须绑定一个绝对根目录，Fake 能力不绑定任何边界。 */
const rootBoundCapabilities: readonly RelayGatewayCapability[] =
  ["FILE_READ", "FILE_QUERY", "FILE_WRITE", "GIT_READ", "GIT_WRITE", "CLI_RUN"];
/** 当前 Gateway 动作契约；提交后仍由服务端核对能力与动作的对应关系。 */
const policyActions: Record<RelayGatewayCapability, readonly string[]> = {
  WEB_FETCH: ["WEB_FETCH"], FILE_READ: ["READ_FILE"],
  FILE_QUERY: ["LIST_DIRECTORY", "FIND_PATHS", "SEARCH_TEXT"],
  FILE_WRITE: ["APPLY_CHANGESET", "READ_CHANGE_SET", "WRITE_FILE"],
  GIT_READ: ["GIT_STATUS", "GIT_DIFF", "GIT_LOG"],
  GIT_WRITE: ["GIT_STAGE", "GIT_COMMIT", "GIT_PUSH"],
  CLI_RUN: ["CLI_RUN", "RUN_BUILD", "RUN_TEST"],
  FAKE_WRITE: ["WRITE_MARKER"], FAKE_PUBLIC_READ: ["READ_PUBLIC"],
  COMPUTER_READ: ["COMPUTER_SCREENSHOT", "COMPUTER_GET_WINDOWS"],
  COMPUTER_INPUT: ["COMPUTER_ACTIVATE_WINDOW", "COMPUTER_MOVE", "COMPUTER_CLICK",
    "COMPUTER_DOUBLE_CLICK", "COMPUTER_SCROLL", "COMPUTER_DRAG", "COMPUTER_TYPE",
    "COMPUTER_KEYPRESS", "COMPUTER_HOTKEY"],
  GITHUB_READ: ["GITHUB_REPO_VIEW", "GITHUB_PR_LIST", "GITHUB_PR_VIEW", "GITHUB_ISSUE_LIST",
    "GITHUB_ISSUE_VIEW"],
  BROWSER_READ: ["BROWSER_LIST_PAGES", "BROWSER_READ_PAGE", "BROWSER_SCREENSHOT", "BROWSER_WAIT_FOR"],
  BROWSER_ACTION: ["BROWSER_NEW_PAGE", "BROWSER_NAVIGATE", "BROWSER_CLICK", "BROWSER_FILL",
    "BROWSER_PRESS_KEY", "BROWSER_CLOSE_PAGE"],
  BROWSER_COMMIT: ["BROWSER_SUBMIT_FORM", "BROWSER_UPLOAD_FILE"]
};
/** 除公共读取外的策略都按受管资源目录限定目标前缀（服务端 policyScope）。 */
const isFileCapability = (capability: RelayGatewayCapability) =>
  capability !== "WEB_FETCH" && capability !== "FAKE_PUBLIC_READ";
const connectionStatusText = (status: string): string => status === "ACTIVE" ? "已连接（尚未授权）"
  : status === "DISABLED" ? "已停用（失效）" : status === "REVOKED" ? "已撤销" : `未连接（${status}）`;
/** 能力的中文显示名与「+」菜单连接器二级共用同一份（`lib/labels`），不另立第二套；未知枚举回退原文。 */
const capabilityLabel = (capability: string): string => gatewayCapabilityLabel(capability);
/** 列表用的决定中文短名；下拉保持「枚举 · 中文」双语便于与服务端核对。 */
const decisionLabels: Record<RelayGatewayDecision, string> = {
  DENY: "拒绝", ASK: "每次请求审批", AUTO: "自动准入"
};
const decisionLabel = (decision: string): string =>
  decisionLabels[decision as RelayGatewayDecision] ?? decision;
/** 受管资源与权限策略共用的状态中文短名；连接的 ACTIVE 另有专门语义文案。 */
const recordStatusLabels: Record<string, string> = {
  ACTIVE: "有效", DISABLED: "已停用", REVOKED: "已撤销"
};
const recordStatusLabel = (status: string): string => recordStatusLabels[status] ?? status;

interface PolicyRow {
  readonly policy: RelayGatewayPolicy;
  readonly versions: readonly RelayGatewayPolicyVersion[];
}

/**
 * 日常区的工具清单：一行一个「用户真正要用的东西」，而不是一行一个能力键。
 *
 * 这些行只读服务端已返回的连接与策略快照（不新增查询、不推断可达性），把
 * 「已连接」与「已授权」分开呈现：连接存在但策略为 DENY 时不能写成可用。
 * 逐动作配置仍在高级区，普通入口不再要求用户先理解能力、动作与目标前缀。
 */
interface ToolRowSpec {
  readonly key: string;
  readonly label: string;
  readonly purpose: string;
  readonly capabilities: readonly RelayGatewayCapability[];
  /** 缺口时唯一需要读的一句：去哪儿补，而不是「请配置」。 */
  readonly next: string;
  /** 三个内置插件额外带安装级运行时状态（`/plugins/status`，HTTP §10.104）。 */
  readonly plugin?: "computer" | "browser" | "github";
}

const toolRows: readonly ToolRowSpec[] = [
  { key: "files", label: "本机文件", purpose: "列出 · 查找 · 搜索 · 读取，按档位写入当前目录",
    capabilities: ["FILE_READ", "FILE_QUERY", "FILE_WRITE"],
    next: "在对话里选择目录即可读取；写入档位在同一处切换。" },
  { key: "git", label: "Git 只读", purpose: "status · diff · log",
    capabilities: ["GIT_READ"], next: "打开 Git 仓库根目录后自动获得，不需要单独登记连接。" },
  { key: "web", label: "网页抓取", purpose: "按允许的主机读取网页",
    capabilities: ["WEB_FETCH"], next: "需要时在下方高级配置里添加允许主机。" },
  { key: "cli", label: "命令行", purpose: "运行目录内脚本，或连接上点名的可执行文件",
    capabilities: ["CLI_RUN"], next: "需要时在下方高级配置里登记目录与允许的可执行文件。" },
  { key: "computer", label: "电脑操控", purpose: "截图 · 窗口 · 鼠标键盘",
    capabilities: ["COMPUTER_READ", "COMPUTER_INPUT"], plugin: "computer",
    next: "授权在下方高级区登记连接与策略；本机运行时是否就绪看本行「本机」状态。" },
  { key: "browser", label: "浏览器操控", purpose: "页面读取 · 点击 · 填表",
    capabilities: ["BROWSER_READ", "BROWSER_ACTION", "BROWSER_COMMIT"], plugin: "browser",
    next: "授权在下方高级区登记连接与策略；扩展配对与本机状态看本行「本机」说明。" },
  { key: "github", label: "GitHub", purpose: "仓库 · PR · Issue 只读",
    capabilities: ["GITHUB_READ"], plugin: "github",
    next: "授权在下方高级区登记连接与策略；gh 是否安装与登录看本行「本机」状态。" },
];

/** 安装级状态的中文短名；detail 与 remediation 进悬停提示，不在行内铺开。 */
const runtimeStateLabels: Record<string, string> = {
  READY: "就绪", NOT_INSTALLED: "未安装", NOT_PAIRED: "未配对",
  NOT_AUTHENTICATED: "未登录", UNAVAILABLE: "不可用" };

/**
 * 返回位置（2026-10-21，R3-01）：`?from=` 由会话里的「管理连接与权限」写入，
 * 这里只接受站内绝对路径——外链不能当作返回目标，否则一次跳转就能把人带出站。
 */
function returnPath(search: URLSearchParams): string | null {
  const from = search.get("from");
  if (from === null || !from.startsWith("/") || from.startsWith("//") || from.includes("\\")) return null;
  return from;
}

function ReturnToConversation({ search }: { search: URLSearchParams }) {
  const from = returnPath(search);
  if (from === null) return null;
  return <p><Link className="inline-link" data-testid="connections-return" to={from}>返回原会话</Link></p>;
}

type ToolTone = "success" | "warning" | "danger" | "neutral";

/** 一个工具的真实状态：连接有效性 + 是否已有非拒绝策略；两者缺一都不能读作可用。 */
function toolStatus(snapshot: Snapshot, spec: ToolRowSpec): { readonly text: string;
  readonly tone: ToolTone; readonly detail: string } {
  const matching = snapshot.connections.filter((item) =>
    item.capabilities.some((capability) => spec.capabilities.includes(capability as RelayGatewayCapability)));
  if (matching.length === 0) return { text: "未配置", tone: "neutral", detail: spec.next };
  const active = matching.filter((item) => item.status === "ACTIVE");
  if (active.length === 0) {
    return matching.some((item) => item.status === "DISABLED")
      ? { text: "已停用", tone: "warning", detail: "连接已停用；重新启用或重新授权前不会执行。" }
      : { text: "已撤销", tone: "danger", detail: "连接已撤销；原批准不能继续复用。" };
  }
  const authorized = snapshot.policies.some(({ policy, versions }) => {
    if (policy.status !== "ACTIVE") return false;
    const version = versions.find((item) => item.version === policy.activeVersion);
    return version !== undefined && spec.capabilities.includes(version.capability as RelayGatewayCapability) &&
      version.decision !== "DENY";
  });
  return authorized
    ? { text: "可用", tone: "success", detail: "连接有效且已有非拒绝策略；这不代表已经执行过任何动作。" }
    : { text: "已连接，尚未授权", tone: "warning", detail: "连接本身不是授权；默认拒绝仍然生效。" };
}

interface Snapshot {
  readonly project: RelayProject;
  readonly connections: readonly RelayGatewayConnectionSettings[];
  readonly policies: readonly PolicyRow[];
  readonly resources: readonly RelayManagedResource[];
}
interface PendingCommand {
  readonly id: string;
  readonly type: string;
  readonly resultKey: "connection_id" | "policy_id" | "resource_id";
  readonly targetId: string | null;
  readonly expectedStatus: "ACTIVE" | "DISABLED" | "REVOKED";
  readonly send: (client: RelayApiClient, commandId: string) => Promise<RelayCommandEnvelope>;
  readonly label: string;
}

function matchingResult(envelope: RelayCommandEnvelope, pending: PendingCommand, projectId: string): string | null {
  const result = envelope.result;
  if (envelope.commandId !== pending.id || result.project_id !== projectId ||
    typeof result[pending.resultKey] !== "string" || (result[pending.resultKey] as string).length === 0 ||
    (pending.targetId !== null && result[pending.resultKey] !== pending.targetId) ||
    result.status !== pending.expectedStatus ||
    !/^(0|[1-9][0-9]*)$/u.test(String(result[pending.resultKey === "connection_id" ? "version" : "revision"] ?? ""))) return null;
  return result[pending.resultKey] as string;
}

async function readSnapshot(client: RelayApiClient, projectId: string): Promise<Snapshot> {
  const [project, connections, policies, resources] = await Promise.all([
    client.getProject(projectId), client.getGatewayConnectionSettings(projectId),
    client.getGatewayPolicies(projectId), client.getManagedResources(projectId)
  ]);
  if (project.id !== projectId || connections.some((item) => item.projectId !== projectId) ||
    policies.some((item) => item.projectId !== projectId) || resources.some((item) => item.projectId !== projectId)) {
    throw new Error("连接设置查询返回了其他项目的数据。");
  }
  const withVersions = await Promise.all(policies.map(async (policy) => ({
    policy, versions: await client.getGatewayPolicyVersions(projectId, policy.id)
  })));
  return { project, connections, policies: withVersions, resources };
}

export default function ConnectionsView() {
  const [search] = useSearchParams();
  const connection = useRelayConnection();
  const client = connection.client;
  const [projects, setProjects] = useState<readonly RelayProjectListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectRequest = useRef(0);
  async function loadProjects(cursor: string | null = null) {
    if (!client) return;
    const request = ++projectRequest.current; setLoading(true); setError(null);
    try {
      const page = await client.getProjectsPage("active", cursor);
      if (request !== projectRequest.current) return;
      setProjects((current) => cursor === null ? page.items : [...current, ...page.items.filter((item) => !current.some((row) => row.id === item.id))]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      // 首屏/刷新读取失败时必须让旧列表失效：否则错误横幅旁仍渲染一份未重新核实的项目清单，
      // 用户无法区分「这就是当前项目」与「这是上次读到的」。分页失败保留已有条目，只报错误。
      if (request === projectRequest.current) {
        setError(describeLiveError(caught).message);
        if (cursor === null) { setProjects([]); setNextCursor(null); }
      }
    }
    finally { if (request === projectRequest.current) setLoading(false); }
  }
  useEffect(() => {
    setProjects([]); setNextCursor(null); setError(null); setLoading(false);
    void loadProjects();
    return () => { projectRequest.current++; };
  }, [client, connection.epoch]);
  return <section className="connections-page">
    <PageHeader testId="connections-page-head" title="连接与权限" meta="项目设置"
      lede="选择项目，管理连接、受管目录与权限。" />
    <ReturnToConversation search={search} />
    {connection.mode === "fixture" && <p className="warning-callout" role="status">当前为示例数据；连接设置只在显式连接本机 API 后可用。</p>}
    {client && <section className="surface-panel connections-project-picker" aria-label="选择项目"><div className="section-heading-row"><h2>项目</h2><button type="button" className="secondary-button" disabled={loading} onClick={() => void loadProjects()}>刷新</button></div>
      {loading && <p className="helper-text" role="status">正在读取项目…</p>}{error && <p className="action-error" role="alert">{error}</p>}
      {!loading && !error && projects.length === 0 && <p className="helper-text">当前没有进行中项目。<Link to="/projects">打开项目列表</Link></p>}
      <ul className="connections-list">{projects.map((project) => <li key={project.id}>
        {/* 选定项目继续携带返回位置：范围选择这一跳不能把人原路丢在半路。 */}
        <Link className="text-link" data-testid="connections-picker-project"
          to={`/projects/${project.id}/connections${returnPath(search) === null ? ""
            : `?from=${encodeURIComponent(returnPath(search) ?? "")}`}`}>{project.title}</Link>
        <span className="helper-text">v{project.revision}</span></li>)}</ul>
      {nextCursor && <button type="button" className="secondary-button" disabled={loading} onClick={() => void loadProjects(nextCursor)}>继续加载项目</button>}
    </section>}
    <Link className="inline-link" to="/projects">返回项目入口</Link>
  </section>;
}

export function ProjectConnectionsView() {
  const { id: projectId = "" } = useParams();
  const [search] = useSearchParams();
  /**
   * 从会话「+」的插件面板带进来的定位键（R3-01）：只认这一页真实存在的工具行，
   * 未知键不猜某一行——猜错比不定位更糟，用户会对着一条无关结论做判断。
   */
  const locatedTool = toolRows.some((row) => row.key === search.get("tool")) ? search.get("tool") : null;
  const locatedRef = useRef<HTMLLIElement | null>(null);
  const locatedDone = useRef(false);
  const connection = useRelayConnection();
  const client = connection.mode === "live" ? connection.client : null;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [failedCommandId, setFailedCommandId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [mayRetry, setMayRetry] = useState(false);
  const pendingRef = useRef<PendingCommand | null>(null);
  const scope = useRef(0);
  const projectArchivedAt = !loading && error === null ? snapshot?.project.archivedAt : undefined;
  const writeBlockedReason = projectArchivedAt === undefined ? "Project 事实尚未确认，不能提交连接或权限变更。" :
    projectArchivedAt !== null ? "项目已归档，不能提交新的连接或权限变更。" : null;
  /** 普通入口的能力清单；测试能力只经显式开发入口进入。 */
  const capabilities = devCapabilitiesEnabled() ? allCapabilities : dailyCapabilities;

  const [connectionCapability, setConnectionCapability] = useState<RelayGatewayCapability>("WEB_FETCH");
  const [connectionHost, setConnectionHost] = useState("");
  const [connectionRoot, setConnectionRoot] = useState("");
  const [connectionExecutables, setConnectionExecutables] = useState("");
  const [resourceRoot, setResourceRoot] = useState("");
  const [policyId, setPolicyId] = useState("");
  const [policyCapability, setPolicyCapability] = useState<RelayGatewayCapability>("WEB_FETCH");
  const [policyActionType, setPolicyActionType] = useState("");
  const [policyDecision, setPolicyDecision] = useState<RelayGatewayDecision>("DENY");
  const [policyHost, setPolicyHost] = useState("");
  const [policyResourceId, setPolicyResourceId] = useState("");
  const [maxPayloadBytes, setMaxPayloadBytes] = useState("2");
  const [health, setHealth] = useState<Record<string, { checking: boolean; result: string | null; error: string | null }>>({});
  /** 安装级插件运行时状态：装没装、登录没登录、运行时在不在；与项目授权分开呈现。 */
  const [pluginRuntime, setPluginRuntime] = useState<Record<string, RelayPluginRuntimeStatus> | null>(null);
  const [pluginRuntimeError, setPluginRuntimeError] = useState<string | null>(null);

  async function checkConnectionHealth(connectionId: string) {
    if (client === null || health[connectionId]?.checking) return;
    const request = scope.current;
    setHealth((current) => ({ ...current, [connectionId]: { checking: true, result: null, error: null } }));
    try {
      const detail = await client.getGatewayConnectionSetting(projectId, connectionId);
      if (request !== scope.current) return;
      if (detail.id !== connectionId || detail.projectId !== projectId) throw new Error("连接详情与目标不匹配。");
      const active = detail.status === "ACTIVE";
      setHealth((current) => ({ ...current, [connectionId]: { checking: false, error: null,
        result: `服务端只读核对：${connectionStatusText(detail.status)} · 版本 v${detail.version}`
          + (detail.capabilities.length > 0 ? ` · 能力 ${detail.capabilities.map(capabilityLabel).join(" · ")}` : "")
          + (detail.allowedHost ? ` · 允许主机 ${detail.allowedHost}` : "")
          + (active ? "" : "；连接存在不等于已获授权，失效后原批准不可继续复用。") } }));
    } catch (caught) {
      if (request !== scope.current) return;
      setHealth((current) => ({ ...current, [connectionId]: { checking: false, result: null, error: describeLiveError(caught).message } }));
    }
  }

  async function refresh(activeClient: RelayApiClient, request = scope.current): Promise<Snapshot | null> {
    setLoading(true); setError(null);
    try {
      const next = await readSnapshot(activeClient, projectId);
      if (request !== scope.current) return null;
      setSnapshot(next);
      // 插件运行时状态是安装级只读探测，读失败不遮挡项目授权信息，只在本行如实说明。
      try {
        const status = await activeClient.getPluginStatus();
        if (request !== scope.current) return next;
        setPluginRuntime(Object.fromEntries(status.map((row) => [row.plugin, row])));
        setPluginRuntimeError(null);
      } catch (caught) {
        if (request === scope.current) setPluginRuntimeError(describeLiveError(caught).message);
      }
      return next;
    } catch (caught) {
      if (request === scope.current) setError(describeLiveError(caught).message);
      return null;
    } finally {
      if (request === scope.current) setLoading(false);
    }
  }

  useEffect(() => {
    const request = ++scope.current;
    pendingRef.current = null; setPending(null); setMayRetry(false); setSnapshot(null);
    setActionError(null); setFailedCommandId(null); setMessage(null); setPolicyId(""); setPolicyActionType(""); setHealth({});
    setPluginRuntime(null); setPluginRuntimeError(null);
    if (client !== null) void refresh(client, request);
    return () => { scope.current++; pendingRef.current = null; };
  }, [client, projectId, connection.epoch]);

  /* 带 tool 进来时把这一行滚到眼前并交出台焦（只在数据落地后做一次，刷新不重复抢焦点）：
     用户从会话里点「管理这个插件的连接与权限」，落在本页应当直接站在这一行前，
     而不是重新在七行里找一遍。 */
  useEffect(() => {
    const node = locatedRef.current;
    if (node === null || snapshot === null || locatedDone.current) return;
    locatedDone.current = true;
    node.scrollIntoView({ block: "center" });
    node.focus({ preventScroll: true });
  }, [locatedTool, snapshot]);

  async function resolveSuccess(activeClient: RelayApiClient, command: PendingCommand, envelope: RelayCommandEnvelope, request: number) {
    const resultId = matchingResult(envelope, command, projectId);
    if (resultId === null) throw new RelayTransportError("命令回执的项目或目标无法核对。");
    pendingRef.current = null; setPending(null); setMayRetry(false);
    const connectionDetail = command.resultKey === "connection_id"
      ? await activeClient.getGatewayConnectionSetting(projectId, resultId).catch(() => null) : null;
    const resourceDetail = command.resultKey === "resource_id"
      ? await activeClient.getManagedResource(projectId, resultId).catch(() => null) : null;
    const next = await refresh(activeClient, request);
    if (request !== scope.current) return;
    const confirmed = command.resultKey === "connection_id"
      ? (connectionDetail?.id === resultId && connectionDetail.projectId === projectId && connectionDetail.version === envelope.result.version && connectionDetail.status === envelope.result.status) ||
        next?.connections.some((item) => item.id === resultId && item.version === envelope.result.version && item.status === envelope.result.status)
      : command.resultKey === "policy_id"
        ? next?.policies.some(({ policy }) => policy.id === resultId && policy.revision === envelope.result.revision &&
          policy.status === envelope.result.status && (command.type === "RevokeGatewayPolicy"
            ? policy.activeVersion === null : policy.activeVersion === envelope.result.version))
        : (resourceDetail?.id === resultId && resourceDetail.projectId === projectId && resourceDetail.revision === envelope.result.revision && resourceDetail.status === envelope.result.status) ||
          next?.resources.some((item) => item.id === resultId && item.revision === envelope.result.revision && item.status === envelope.result.status);
    setMessage(confirmed ? `${command.label}已由服务端回执和最新项目查询确认。` : `${command.label}回执已提交；列表尚未确认最新状态，请刷新核对。`);
    if (command.resultKey === "policy_id" && next?.policies.some(({ policy }) => policy.id === resultId)) setPolicyId(resultId);
    if (command.type === "CreateGatewayConnection") {
      setConnectionHost(""); setConnectionRoot(""); setConnectionExecutables("");
    }
    if (command.type === "CreateManagedResource") setResourceRoot("");
  }

  async function sendCommand(command: PendingCommand, retry = false) {
    if (client === null || submitting || (!retry && writeBlockedReason !== null) ||
      (pendingRef.current !== null && (!retry || pendingRef.current !== command))) return;
    const request = scope.current;
    pendingRef.current = command; setPending(command); setMayRetry(false); setSubmitting(true);
    setActionError(null); setFailedCommandId(null); setMessage(null);
    try {
      const envelope = await command.send(client, command.id);
      if (request === scope.current) await resolveSuccess(client, command, envelope, request);
    } catch (caught) {
      if (request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.status < 500 && caught.problem.code !== "COMMAND_ID_REUSED") {
        pendingRef.current = null; setPending(null);
        setActionError(describeLiveError(caught).message);
        if (caught.problem.status === 409) setFailedCommandId(command.id);
        if (caught.problem.status === 409) void refresh(client, request);
      } else {
        setActionError("提交结果尚不明确。先查询原 command_id 回执；查询不到时仅能原样重试。");
      }
    } finally {
      if (request === scope.current) setSubmitting(false);
    }
  }

  async function checkReceipt() {
    const command = pendingRef.current;
    if (!command || !client || submitting) return;
    const request = scope.current;
    setSubmitting(true); setActionError(null);
    try {
      const receipt = await client.getCommandReceipt(command.id);
      if (request !== scope.current) return;
      if (receipt.commandType !== command.type) throw new RelayTransportError("原命令回执类型不匹配。");
      await resolveSuccess(client, command, receipt, request);
    } catch (caught) {
      if (request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(true);
        setActionError("原命令回执暂未找到；仍用原 command_id 和冻结的内容重试，或稍后再查。");
      } else setActionError("原回执仍无法核对；请保留 command_id 继续查询。");
    } finally {
      if (request === scope.current) setSubmitting(false);
    }
  }

  function submitConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const capability = connectionCapability;
    const rootPath = connectionRoot.trim();
    const allowedHost = connectionHost.trim();
    const allowedExecutables: readonly string[] = capability === "CLI_RUN"
      ? Object.freeze(connectionExecutables.split(/\r\n?|\n/u).map((path) => path.trim()).filter(Boolean))
      : [];
    if ((rootBoundCapabilities.includes(capability) && !rootPath) || (capability === "WEB_FETCH" && !allowedHost)) return;
    const command: PendingCommand = { id: createCommandId(), type: "CreateGatewayConnection", resultKey: "connection_id", targetId: null, expectedStatus: "ACTIVE",
      label: "连接创建", send: (api, commandId) => api.createGatewayConnection({ projectId, commandId, capability,
        ...(rootBoundCapabilities.includes(capability) ? { rootPath } : {}), ...(capability === "WEB_FETCH" ? { allowedHost } : {}),
        ...(capability === "CLI_RUN" && allowedExecutables.length > 0 ? { allowedExecutables } : {}) }) };
    void sendCommand(command);
  }

  function submitResource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rootPath = resourceRoot.trim();
    if (!rootPath) return;
    void sendCommand({ id: createCommandId(), type: "CreateManagedResource", resultKey: "resource_id", targetId: null, expectedStatus: "ACTIVE",
      label: "受管资源创建", send: (api, commandId) => api.createManagedResource({ projectId, commandId, rootPath }) });
  }

  function submitPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = snapshot?.policies.find(({ policy }) => policy.id === policyId)?.policy ?? null;
    const capability = policyCapability;
    const actionType = policyActionType;
    const decision = policyDecision;
    const host = policyHost.trim();
    const resourceId = isFileCapability(capability) ? policyResourceId : null;
    const bytes = Number(maxPayloadBytes);
    if ((capability === "WEB_FETCH" && !host) || (isFileCapability(capability) && !resourceId) ||
      !Number.isInteger(bytes) || bytes < 0 || bytes > 262144 ||
      (actionType !== "" && !policyActions[capability].includes(actionType)) ||
      (resourceId !== null && !snapshot?.resources.some((item) => item.id === resourceId && item.status === "ACTIVE"))) return;
    const input = { projectId, capability, resourceId, decision, maxPayloadBytes: bytes,
      ...(capability === "WEB_FETCH" ? { host } : {}), ...(actionType === "" ? {} : { actionType }) };
    void sendCommand(selected === null
      ? { id: createCommandId(), type: "CreateGatewayPolicy", resultKey: "policy_id", targetId: null, expectedStatus: "ACTIVE",
        label: "权限策略创建", send: (api, commandId) => api.createGatewayPolicy({ ...input, commandId }) }
      : { id: createCommandId(), type: "AddGatewayPolicyVersion", resultKey: "policy_id", targetId: selected.id, expectedStatus: "ACTIVE",
        label: "权限策略修订", send: (api, commandId) => api.addGatewayPolicyVersion({ ...input,
          policyId: selected.id, expectedRevision: selected.revision, commandId }) });
  }

  function selectPolicy(id: string) {
    setPolicyId(id); setPolicyResourceId(""); setPolicyActionType("");
    const row = snapshot?.policies.find(({ policy }) => policy.id === id);
    const active = row?.versions.find((version) => version.version === row.policy.activeVersion);
    if (active && allCapabilities.includes(active.capability as RelayGatewayCapability)) {
      setPolicyCapability(active.capability as RelayGatewayCapability);
      setPolicyActionType(active.actionType);
      setPolicyDecision(active.decision as RelayGatewayDecision);
      setMaxPayloadBytes(String(active.maxPayloadBytes));
      setPolicyHost(active.capability === "WEB_FETCH" ? active.targetPrefix : "");
    } else if (id === "") setPolicyDecision("DENY");
  }

  const selectedPolicy = snapshot?.policies.find(({ policy }) => policy.id === policyId) ?? null;
  const activeResources = snapshot?.resources.filter((item) => item.status === "ACTIVE") ?? [];
  const busy = submitting || pending !== null;
  return <section className="connections-page">
    <PageHeader testId="project-connections-page-head" title="连接与权限" meta="项目设置"
      lede="连接限定能力与目标；权限策略单独控制 AUTO、ASK、DENY。创建连接后仍默认拒绝。" />
    <ProjectNav projectId={projectId} active="connections" />
    <ReturnToConversation search={search} />
    <p><Link className="inline-link" to={`/projects/${projectId}`}>返回原项目页</Link></p>
    <details className="connections-view-configuration">
      <summary>工作台默认视图与页面顺序</summary>
      <ViewConfigurationPanel client={client} projectId={projectId} projectArchivedAt={projectArchivedAt} />
    </details>
    {client === null ? <p className="warning-callout" role="status">当前为示例数据预览；没有真实连接或权限配置。请先连接本机 API。</p> : <>
      <div className="connections-title"><h2>{snapshot?.project.title ?? "当前项目"}</h2>
        <button className="secondary-button" type="button" onClick={() => { void refresh(client); }} disabled={loading || busy}>刷新服务端配置</button></div>
      <details className="connections-identity"><summary>项目身份与配置范围</summary><p className="helper-text">Project ID：<code className="hash-code">{projectId}</code></p><p className="helper-text">连接绑定能力和目标边界；权限策略另行授权。默认拒绝，不会因创建连接自动放行。</p></details>
      {loading && <p role="status">正在读取项目连接、受管资源与权限版本…</p>}
      {error && <p className="action-error" role="alert">{error}</p>}
      {writeBlockedReason && <p className="disabled-reason" data-testid="connections-archive-reason">{writeBlockedReason}</p>}
      {message && <p className="success-callout" role="status">{message}</p>}
      {actionError && <p className="action-error" role="alert">{actionError}{failedCommandId && <> 原 command_id：{failedCommandId}。请核对新修订后明确重新提交。</>}</p>}
      {pending && <div className="warning-callout" data-testid="connections-pending">
        <strong>提交结果待核对</strong><p>原 command_id：{pending.id}。在结果确认前，不提交其他配置变更。</p>
        <button className="secondary-button" type="button" disabled={submitting} onClick={() => { void checkReceipt(); }}>查询原命令回执</button>
        {mayRetry && <button className="secondary-button" type="button" disabled={submitting} onClick={() => { void sendCommand(pending, true); }}>用原 ID 和内容重试</button>}
      </div>}
      {snapshot && <>
        {/* 日常区：只回答「现在能做什么、缺什么、去哪儿补」。这里不出现能力、动作、
            受管资源或 AUTO/ASK/DENY，也不需要用户先配一遍才能用文件。 */}
        <section className="surface-panel connections-tools" data-testid="connections-tools">
          <h2>可以用的工具</h2>
          <p className="helper-text">日常使用不需要在这里逐项配置：在对话里选择目录、或直接说出要做的事即可。下面每行是服务端记录的真实状态。</p>
          <ul className="connections-list connections-tool-list">{toolRows.map((row) => {
            const state = toolStatus(snapshot, row);
            const runtime = row.plugin === undefined ? null
              : pluginRuntimeError !== null ? { error: pluginRuntimeError as string }
              : pluginRuntime === null ? null
              : pluginRuntime[row.plugin] ?? null;
            return <li key={row.key} data-testid={`connections-tool-${row.key}`}
              ref={row.key === locatedTool ? locatedRef : undefined}
              data-located={row.key === locatedTool ? "true" : undefined}
              tabIndex={row.key === locatedTool ? -1 : undefined}>
              <div><strong>{row.label}</strong><small>{row.purpose}</small>
                <small data-testid={`connections-tool-state-${row.key}`}>{state.detail}</small>
                {runtime !== null && ("error" in runtime
                  ? <small className="action-error" role="status"
                    data-testid={`connections-tool-runtime-${row.key}`}>本机状态读取失败：{runtime.error}</small>
                  : <small data-testid={`connections-tool-runtime-${row.key}`}
                    title={`${runtime.detail}${runtime.remediation === null ? "" : ` 建议：${runtime.remediation}`}`}>
                    本机：{runtimeStateLabels[runtime.state] ?? runtime.state}</small>)}</div>
              <div className="connections-actions">
                <span className={`status-chip status-chip--${state.tone}`}>{state.text}</span>
              </div>
            </li>;
          })}</ul>
          <p className="field-hint">「可用」只表示连接有效且已有非拒绝策略；撤销、停用与拒绝仍然生效，不会因为这里显示可用而被覆盖。</p>
        </section>
        <details className="surface-panel connections-advanced" data-testid="connections-advanced">
          <summary>高级：逐动作配置（连接、受管目录与权限策略）</summary>
          <p className="helper-text">只有排查异常、或需要精确控制某个动作时才用这里。日常打开目录已经自动完成读取与 Git 只读配置；测试能力只在地址带 <code className="hash-code">?dev-capabilities=1</code> 时出现。</p>
        <section className="surface-panel"><h2>连接</h2>
          <p className="helper-text">本列表最多读取服务端前 100 条，没有下一页。状态与能力来自服务端；网页抓取（WEB_FETCH）只公开允许的主机，文件读取（FILE_READ）的连接目录未由此接口公开。连接本身不是授权。</p>
          {snapshot.connections.length === 0 ? <p className="helper-text">本项目尚无连接。</p> : <ul className="connections-list">{snapshot.connections.map((item) => {
            const healthState = health[item.id];
            return <li key={item.id}>
            <div><strong title={item.capabilities.join(" · ")}>
              {item.capabilities.map(capabilityLabel).join(" · ")}</strong>
              <small title={item.status}>{connectionStatusText(item.status)} · v{item.version} · <code className="hash-code">{item.id}</code></small>
              {item.capabilities.includes("WEB_FETCH") && <small>允许主机：{item.allowedHost ?? "未由接口公开"}</small>}
              {item.capabilities.includes("CLI_RUN") && <small data-testid="connection-allowed-executables">允许的可执行文件：{item.allowedExecutables?.length ? item.allowedExecutables.join("、") : "未配置"}</small>}
              {item.capabilities.some((capability) => rootBoundCapabilities.includes(capability as RelayGatewayCapability)) && <small>连接目录未由此接口公开；下方受管资源目录是独立配置，不推定同根。</small>}
              {healthState?.result && <small className="connection-health" role="status">{healthState.result}</small>}
              {healthState?.error && <small className="action-error" role="alert">健康核对失败：{healthState.error}</small>}</div>
            <div className="connections-actions">
              <button className="secondary-button" type="button" disabled={healthState?.checking === true} onClick={() => { void checkConnectionHealth(item.id); }} data-testid={`connection-health-${item.id}`}>{healthState?.checking ? "正在只读核对…" : "只读健康核对"}</button>
              {item.status === "ACTIVE" && <button className="danger-button" type="button" disabled={busy || writeBlockedReason !== null} onClick={() => { void sendCommand({
              id: createCommandId(), type: "DisableGatewayConnection", resultKey: "connection_id", targetId: item.id, expectedStatus: "DISABLED",
              label: "连接停用", send: (api, commandId) => api.disableGatewayConnection({ projectId, connectionId: item.id,
                expectedVersion: item.version, commandId }) }); }}>停用连接</button>}
            </div>
          </li>; })}</ul>}
          <p className="field-hint">「只读健康核对」只重新读取服务端连接配置，不触发任何写入或外部动作；主机/目录真实可达性探针当前无只读接口，标记为待接入。</p>
          <details className="connections-create" open={snapshot.connections.length === 0}><summary>新建连接</summary><form className="connections-form" onSubmit={submitConnection}>
            <h3>创建连接</h3><label className="field"><span className="field-label">能力</span><select value={connectionCapability} disabled={busy} onChange={(event) => setConnectionCapability(event.target.value as RelayGatewayCapability)} data-testid="connection-capability">
              {capabilities.map((capability) => <option key={capability} value={capability}>{capability}</option>)}</select></label>
            {connectionCapability === "WEB_FETCH" && <label className="field"><span className="field-label">允许主机</span><input value={connectionHost} onChange={(event) => setConnectionHost(event.target.value)} disabled={busy} required placeholder="example.org" data-testid="connection-host" /><span className="field-hint">只填 DNS 主机，不含 scheme、端口和路径；本页不启用私有地址例外。</span></label>}
            {rootBoundCapabilities.includes(connectionCapability) && <label className="field"><span className="field-label">连接目录</span><input value={connectionRoot} onChange={(event) => setConnectionRoot(event.target.value)} disabled={busy} required placeholder="本机已有绝对目录" data-testid="connection-root" /><span className="field-hint">服务端要求现存目录；提交后查询接口不读回原目录。</span></label>}
            {connectionCapability === "CLI_RUN" && <label className="field"><span className="field-label">允许的可执行文件</span><textarea value={connectionExecutables} onChange={(event) => setConnectionExecutables(event.target.value)} disabled={busy} rows={3} data-testid="connection-executables" /><span className="field-hint">每行填写一个完整绝对路径（路径可含空格），留空表示未配置。服务端会核验现存普通文件并返回规范化路径；根目录内脚本无需列出，根目录外可执行文件需与此列表匹配。此列表不替代动作权限。</span></label>}
            <button className="primary-button" type="submit" disabled={busy || writeBlockedReason !== null}>创建连接</button>
          </form></details>
        </section>

        <section className="surface-panel"><h2>受管资源</h2><p className="helper-text">本列表最多读取服务端前 100 条，没有下一页。下列目录是文件读取 / 写入类策略可引用的独立受管资源，不等于文件读取连接自身的目录。</p>
          {snapshot.resources.length === 0 ? <p className="helper-text">本项目尚无受管资源。</p> : <ul className="connections-list">{snapshot.resources.map((item) => <li key={item.id}><div><strong>{item.canonicalRoot}</strong><small title={item.status}>{recordStatusLabel(item.status)} · rev {item.revision} · epoch {item.resourceEpoch} · <code className="hash-code">{item.id}</code></small>
            <small>Windows 文件写入目录身份：{item.fileWriteIdentityBound ? "已绑定" : "未绑定；若需在 Windows 使用 FILE_WRITE，请在 Windows 停用后重新登记此目录"}</small></div>
            {item.status === "ACTIVE" && <button className="danger-button" type="button" disabled={busy || writeBlockedReason !== null} onClick={() => { void sendCommand({
              id: createCommandId(), type: "DisableManagedResource", resultKey: "resource_id", targetId: item.id, expectedStatus: "DISABLED",
              label: "受管资源停用", send: (api, commandId) => api.disableManagedResource({ projectId, resourceId: item.id,
                expectedRevision: item.revision, commandId }) }); }}>停用资源</button>}</li>)}</ul>}
          <details className="connections-create" open={snapshot.resources.length === 0}><summary>登记受管目录</summary><form className="connections-form" onSubmit={submitResource}><h3>登记受管目录</h3>
            <label className="field"><span className="field-label">本机已有绝对目录</span><input value={resourceRoot} onChange={(event) => setResourceRoot(event.target.value)} disabled={busy} required data-testid="resource-root" /></label>
            <button className="secondary-button" type="submit" disabled={busy || writeBlockedReason !== null}>登记受管资源</button></form></details>
        </section>

        <section className="surface-panel"><h2>权限策略</h2>
          <p className="helper-text">本列表最多读取服务端前 100 条，没有下一页。没有匹配的有效策略时默认拒绝（DENY）。自动放行 / 询问 / 拒绝（AUTO / ASK / DENY）只在你明确提交策略后生效；还需有效连接及目标边界匹配。</p>
          {snapshot.policies.length === 0 ? <p className="helper-text">本项目没有权限策略，当前默认 DENY。</p> : <ul className="connections-list">{snapshot.policies.map(({ policy, versions }) => {
            const active = versions.find((version) => version.version === policy.activeVersion);
            return <li key={policy.id}><div><strong title={active ? `${active.capability} · ${active.decision}` : "DENY"}>
              {active ? `${capabilityLabel(active.capability)} · ${decisionLabel(active.decision)}`
                : `无有效版本 · ${decisionLabel("DENY")}`}</strong>
              <small title={policy.status}>{recordStatusLabel(policy.status)} · rev {policy.revision} · 生效版本 {policy.activeVersion ?? "无"} · <code className="hash-code">{policy.id}</code></small>
              {active && <small>目标：{active.targetPrefix} · 上限 {active.maxPayloadBytes} bytes · {active.actionType}</small>}
              {policy.activeVersion && !active && <small>当前版本详情尚未读到，不推断授权。</small>}
              <details className="tech-details"><summary>查看已读取版本（{versions.length}，最多最近 100 条）</summary><ol>{versions.map((version) => <li key={version.version}>v{version.version} · {version.capability} · {version.decision} · {version.targetPrefix} · {version.maxPayloadBytes} bytes</li>)}</ol></details>
            </div><div className="connections-actions">
              {policy.status === "ACTIVE" && <button className="secondary-button" type="button" disabled={busy} onClick={() => selectPolicy(policy.id)}>修订</button>}
              {policy.status === "ACTIVE" && <button className="danger-button" type="button" disabled={busy || writeBlockedReason !== null} onClick={() => { void sendCommand({
                id: createCommandId(), type: "RevokeGatewayPolicy", resultKey: "policy_id", targetId: policy.id, expectedStatus: "REVOKED",
                label: "权限策略撤销", send: (api, commandId) => api.revokeGatewayPolicy({ projectId, policyId: policy.id,
                  expectedRevision: policy.revision, commandId }) }); }}>撤销</button>}
            </div></li>;
          })}</ul>}
          <details className="connections-create" open={selectedPolicy !== null || snapshot.policies.length === 0}><summary>{selectedPolicy ? "修订权限策略" : "新建权限策略"}</summary><form className="connections-form" onSubmit={submitPolicy} data-testid="policy-form"><h3>{selectedPolicy ? `修订策略 ${selectedPolicy.policy.id}` : "新建策略"}</h3>
            {selectedPolicy && <p className="helper-text">基于 rev {selectedPolicy.policy.revision} 追加不可变版本；旧版本仍可查看。</p>}
            <label className="field"><span className="field-label">策略</span><select value={policyId} disabled={busy} onChange={(event) => selectPolicy(event.target.value)} data-testid="policy-select">
              <option value="">新建策略</option>{snapshot.policies.filter(({ policy }) => policy.status === "ACTIVE").map(({ policy }) => <option key={policy.id} value={policy.id}>{policy.id}</option>)}</select></label>
            <label className="field"><span className="field-label">能力</span><select value={policyCapability} disabled={busy} onChange={(event) => { setPolicyCapability(event.target.value as RelayGatewayCapability); setPolicyActionType(""); setPolicyResourceId(""); }} data-testid="policy-capability">
              {capabilities.map((capability) => <option key={capability} value={capability}>{capability}</option>)}</select></label>
            <label className="field"><span className="field-label">动作</span><select value={policyActionType} onChange={(event) => setPolicyActionType(event.target.value)} disabled={busy} data-testid="policy-action">
              <option value="">使用能力默认动作</option>{policyActions[policyCapability].map((action) => <option key={action} value={action}>{action}</option>)}</select><span className="field-hint">策略只匹配这一项动作。目录检索的列出、查找和搜索须分别配置。</span></label>
            {policyCapability === "WEB_FETCH" && <label className="field"><span className="field-label">策略主机</span><input value={policyHost} onChange={(event) => setPolicyHost(event.target.value)} disabled={busy} required placeholder="example.org" data-testid="policy-host" /></label>}
            {isFileCapability(policyCapability) && <label className="field"><span className="field-label">受管资源</span><select value={policyResourceId} onChange={(event) => setPolicyResourceId(event.target.value)} disabled={busy} required data-testid="policy-resource">
              <option value="">明确选择一个有效资源</option>{activeResources.map((item) => <option key={item.id} value={item.id}>{item.canonicalRoot} · {item.id}</option>)}</select><span className="field-hint">版本接口不提供 resource_id；修订时须重新明确选择，不从目录字符串猜测。</span></label>}
            <label className="field"><span className="field-label">决定</span><select value={policyDecision} onChange={(event) => setPolicyDecision(event.target.value as RelayGatewayDecision)} disabled={busy} data-testid="policy-decision">
              <option value="DENY">DENY · 拒绝（默认）</option><option value="ASK">ASK · 每次请求审批</option><option value="AUTO">AUTO · 匹配时自动准入</option></select></label>
            <label className="field"><span className="field-label">最大载荷字节</span><input type="number" min="0" max="262144" step="1" value={maxPayloadBytes} onChange={(event) => setMaxPayloadBytes(event.target.value)} disabled={busy} required data-testid="policy-max-bytes" /><span className="field-hint">当前只读动作的空参数编码为 2 字节；上限由服务端校验。</span></label>
            <div className="connections-actions"><button className="primary-button" type="submit" disabled={busy || writeBlockedReason !== null || (isFileCapability(policyCapability) && activeResources.length === 0)} data-testid="policy-save">{selectedPolicy ? "提交策略新版本" : "明确创建策略"}</button>
              {selectedPolicy && <button className="secondary-button" type="button" disabled={busy} onClick={() => selectPolicy("")}>取消修订</button>}</div>
          </form></details>
        </section>
        </details>
      </>}
    </>}
  </section>;
}
