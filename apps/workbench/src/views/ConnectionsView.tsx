import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  createCommandId, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayCommandEnvelope, type RelayGatewayCapability,
  type RelayGatewayConnectionSettings, type RelayGatewayDecision, type RelayGatewayPolicy,
  type RelayGatewayPolicyVersion, type RelayManagedResource, type RelayProject
} from "../api/relayClient";
import ProjectNav from "../components/ProjectNav";
import ViewConfigurationPanel from "../components/ViewConfigurationPanel";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import "./ConnectionsView.css";

const capabilities: readonly RelayGatewayCapability[] = ["WEB_FETCH", "FILE_READ", "FAKE_WRITE", "FAKE_PUBLIC_READ"];
const isFileCapability = (capability: RelayGatewayCapability) => capability === "FILE_READ" || capability === "FAKE_WRITE";
const connectionStatusText = (status: string): string => status === "ACTIVE" ? "已连接（尚未授权）"
  : status === "DISABLED" ? "已停用（失效）" : status === "REVOKED" ? "已撤销" : `未连接（${status}）`;

interface PolicyRow {
  readonly policy: RelayGatewayPolicy;
  readonly versions: readonly RelayGatewayPolicyVersion[];
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
  const navigate = useNavigate();
  const connection = useRelayConnection();
  const [projectId, setProjectId] = useState("");
  return <section className="connections-page">
    <p className="eyebrow">项目设置</p><h1>连接与权限</h1>
    <p className="page-lede">连接绑定能力和目标边界；PermissionPolicy 另行授权。默认拒绝，不会因创建连接自动放行。</p>
    {connection.mode === "fixture" && <p className="warning-callout" role="status">当前为示例数据；连接设置只在显式连接本机 API 后可用。</p>}
    <form className="surface-panel connections-entry" onSubmit={(event) => { event.preventDefault(); if (projectId.trim()) navigate(`/projects/${encodeURIComponent(projectId.trim())}/connections`); }}>
      <h2>打开项目连接设置</h2>
      <p className="helper-text">可从项目列表打开项目后进入连接设置，或输入已知的 Project ID。</p>
      <label className="field"><span className="field-label">Project ID</span><input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="Project UUID" data-testid="connections-project-id" /></label>
      <button className="primary-button" type="submit" disabled={!projectId.trim()}>打开连接设置</button>
    </form>
    <Link className="inline-link" to="/projects">返回项目入口</Link>
  </section>;
}

export function ProjectConnectionsView() {
  const { id: projectId = "" } = useParams();
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

  const [connectionCapability, setConnectionCapability] = useState<RelayGatewayCapability>("WEB_FETCH");
  const [connectionHost, setConnectionHost] = useState("");
  const [connectionRoot, setConnectionRoot] = useState("");
  const [resourceRoot, setResourceRoot] = useState("");
  const [policyId, setPolicyId] = useState("");
  const [policyCapability, setPolicyCapability] = useState<RelayGatewayCapability>("WEB_FETCH");
  const [policyDecision, setPolicyDecision] = useState<RelayGatewayDecision>("DENY");
  const [policyHost, setPolicyHost] = useState("");
  const [policyResourceId, setPolicyResourceId] = useState("");
  const [maxPayloadBytes, setMaxPayloadBytes] = useState("2");
  const [health, setHealth] = useState<Record<string, { checking: boolean; result: string | null; error: string | null }>>({});

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
        result: `服务端只读核对：状态 ${detail.status}（${active ? "已连接" : "未连接/已停用"}） · 版本 v${detail.version}`
          + (detail.capabilities.length > 0 ? ` · 能力 ${detail.capabilities.join(" · ")}` : "")
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
    setActionError(null); setFailedCommandId(null); setMessage(null); setPolicyId(""); setHealth({});
    if (client !== null) void refresh(client, request);
    return () => { scope.current++; pendingRef.current = null; };
  }, [client, projectId, connection.epoch]);

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
    if (command.type === "CreateGatewayConnection") { setConnectionHost(""); setConnectionRoot(""); }
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
    if ((capability === "FILE_READ" && !rootPath) || (capability === "WEB_FETCH" && !allowedHost)) return;
    const command: PendingCommand = { id: createCommandId(), type: "CreateGatewayConnection", resultKey: "connection_id", targetId: null, expectedStatus: "ACTIVE",
      label: "连接创建", send: (api, commandId) => api.createGatewayConnection({ projectId, commandId, capability,
        ...(capability === "FILE_READ" ? { rootPath } : {}), ...(capability === "WEB_FETCH" ? { allowedHost } : {}) }) };
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
    const decision = policyDecision;
    const host = policyHost.trim();
    const resourceId = isFileCapability(capability) ? policyResourceId : null;
    const bytes = Number(maxPayloadBytes);
    if ((capability === "WEB_FETCH" && !host) || (isFileCapability(capability) && !resourceId) ||
      !Number.isInteger(bytes) || bytes < 0 || bytes > 262144 ||
      (resourceId !== null && !snapshot?.resources.some((item) => item.id === resourceId && item.status === "ACTIVE"))) return;
    const input = { projectId, capability, resourceId, decision, maxPayloadBytes: bytes,
      ...(capability === "WEB_FETCH" ? { host } : {}) };
    void sendCommand(selected === null
      ? { id: createCommandId(), type: "CreateGatewayPolicy", resultKey: "policy_id", targetId: null, expectedStatus: "ACTIVE",
        label: "权限策略创建", send: (api, commandId) => api.createGatewayPolicy({ ...input, commandId }) }
      : { id: createCommandId(), type: "AddGatewayPolicyVersion", resultKey: "policy_id", targetId: selected.id, expectedStatus: "ACTIVE",
        label: "权限策略修订", send: (api, commandId) => api.addGatewayPolicyVersion({ ...input,
          policyId: selected.id, expectedRevision: selected.revision, commandId }) });
  }

  const selectedPolicy = snapshot?.policies.find(({ policy }) => policy.id === policyId) ?? null;
  const activeResources = snapshot?.resources.filter((item) => item.status === "ACTIVE") ?? [];
  const busy = submitting || pending !== null;
  return <section className="connections-page">
    <p className="eyebrow">项目设置</p><h1>连接与权限</h1>
    <p className="page-lede">连接限定能力与目标；权限策略单独控制 AUTO、ASK、DENY。创建连接后仍默认拒绝。</p>
    <ProjectNav projectId={projectId} active="connections" />
    <p><Link className="inline-link" to={`/projects/${projectId}`}>返回原项目页</Link></p>
    <ViewConfigurationPanel client={client} projectId={projectId} projectArchivedAt={projectArchivedAt} />
    {client === null ? <p className="warning-callout" role="status">当前为示例数据预览；没有真实连接或权限配置。请先连接本机 API。</p> : <>
      <div className="connections-title"><h2>{snapshot?.project.title ?? "当前项目"}</h2>
        <button className="secondary-button" type="button" onClick={() => { void refresh(client); }} disabled={loading || busy}>刷新服务端配置</button></div>
      <p className="helper-text">Project ID：<code className="hash-code">{projectId}</code></p>
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
        <section className="surface-panel"><h2>连接</h2>
          <p className="helper-text">本列表最多读取服务端前 100 条且无游标。状态与 capability 来自服务端；WEB_FETCH 只公开 allowed_host，FILE_READ 的连接目录未由此接口公开。连接本身不是授权。</p>
          {snapshot.connections.length === 0 ? <p className="helper-text">本项目尚无连接。</p> : <ul className="connections-list">{snapshot.connections.map((item) => {
            const healthState = health[item.id];
            return <li key={item.id}>
            <div><strong>{item.capabilities.join(" · ")}</strong><small>{connectionStatusText(item.status)} · {item.status} · v{item.version} · {item.id}</small>
              {item.capabilities.includes("WEB_FETCH") && <small>允许主机：{item.allowedHost ?? "未由接口公开"}</small>}
              {item.capabilities.includes("FILE_READ") && <small>连接目录未由此接口公开；下方受管资源目录是独立配置，不推定同根。</small>}
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
          <form className="connections-form" onSubmit={submitConnection}>
            <h3>创建连接</h3><label className="field"><span className="field-label">Capability</span><select value={connectionCapability} disabled={busy} onChange={(event) => setConnectionCapability(event.target.value as RelayGatewayCapability)} data-testid="connection-capability">
              {capabilities.map((capability) => <option key={capability} value={capability}>{capability}</option>)}</select></label>
            {connectionCapability === "WEB_FETCH" && <label className="field"><span className="field-label">允许主机</span><input value={connectionHost} onChange={(event) => setConnectionHost(event.target.value)} disabled={busy} required placeholder="example.org" data-testid="connection-host" /><span className="field-hint">只填 DNS 主机，不含 scheme、端口和路径；本页不启用私有地址例外。</span></label>}
            {connectionCapability === "FILE_READ" && <label className="field"><span className="field-label">连接目录</span><input value={connectionRoot} onChange={(event) => setConnectionRoot(event.target.value)} disabled={busy} required placeholder="本机已有绝对目录" data-testid="connection-root" /><span className="field-hint">服务端要求现存目录；提交后查询接口不读回原目录。</span></label>}
            <button className="primary-button" type="submit" disabled={busy || writeBlockedReason !== null}>创建连接</button>
          </form>
        </section>

        <section className="surface-panel"><h2>受管资源</h2><p className="helper-text">本列表最多读取服务端前 100 条且无游标。下列目录是 FILE_READ / FAKE_WRITE 策略可引用的独立受管资源；不等于 FILE_READ 连接目录。</p>
          {snapshot.resources.length === 0 ? <p className="helper-text">本项目尚无受管资源。</p> : <ul className="connections-list">{snapshot.resources.map((item) => <li key={item.id}><div><strong>{item.canonicalRoot}</strong><small>{item.status} · rev {item.revision} · epoch {item.resourceEpoch} · {item.id}</small>
            <small>Windows 文件写入目录身份：{item.fileWriteIdentityBound ? "已绑定" : "未绑定；若需在 Windows 使用 FILE_WRITE，请在 Windows 停用后重新登记此目录"}</small></div>
            {item.status === "ACTIVE" && <button className="danger-button" type="button" disabled={busy || writeBlockedReason !== null} onClick={() => { void sendCommand({
              id: createCommandId(), type: "DisableManagedResource", resultKey: "resource_id", targetId: item.id, expectedStatus: "DISABLED",
              label: "受管资源停用", send: (api, commandId) => api.disableManagedResource({ projectId, resourceId: item.id,
                expectedRevision: item.revision, commandId }) }); }}>停用资源</button>}</li>)}</ul>}
          <form className="connections-form" onSubmit={submitResource}><h3>登记受管目录</h3>
            <label className="field"><span className="field-label">本机已有绝对目录</span><input value={resourceRoot} onChange={(event) => setResourceRoot(event.target.value)} disabled={busy} required data-testid="resource-root" /></label>
            <button className="secondary-button" type="submit" disabled={busy || writeBlockedReason !== null}>登记受管资源</button></form>
        </section>

        <section className="surface-panel"><h2>PermissionPolicy</h2>
          <p className="helper-text">本列表最多读取服务端前 100 条且无游标。没有匹配的有效策略时默认 DENY。AUTO / ASK / DENY 只在你明确提交策略后生效；还需有效连接及目标边界匹配。</p>
          {snapshot.policies.length === 0 ? <p className="helper-text">本项目没有权限策略，当前默认 DENY。</p> : <ul className="connections-list">{snapshot.policies.map(({ policy, versions }) => {
            const active = versions.find((version) => version.version === policy.activeVersion);
            return <li key={policy.id}><div><strong>{active ? `${active.capability} · ${active.decision}` : "无有效版本 · DENY"}</strong>
              <small>{policy.status} · rev {policy.revision} · active v{policy.activeVersion ?? "无"} · {policy.id}</small>
              {active && <small>目标：{active.targetPrefix} · 上限 {active.maxPayloadBytes} bytes · {active.actionType}</small>}
              {policy.activeVersion && !active && <small>当前版本详情尚未读到，不推断授权。</small>}
              <details><summary>查看已读取版本（{versions.length}，最多最近 100 条）</summary><ol>{versions.map((version) => <li key={version.version}>v{version.version} · {version.capability} · {version.decision} · {version.targetPrefix} · {version.maxPayloadBytes} bytes</li>)}</ol></details>
            </div><div className="connections-actions">
              {policy.status === "ACTIVE" && <button className="secondary-button" type="button" disabled={busy} onClick={() => {
                setPolicyId(policy.id); setPolicyResourceId("");
                if (active && capabilities.includes(active.capability as RelayGatewayCapability)) {
                  setPolicyCapability(active.capability as RelayGatewayCapability);
                  setPolicyDecision(active.decision as RelayGatewayDecision);
                  setMaxPayloadBytes(String(active.maxPayloadBytes));
                  setPolicyHost(active.capability === "WEB_FETCH" ? active.targetPrefix : "");
                }
              }}>修订</button>}
              {policy.status === "ACTIVE" && <button className="danger-button" type="button" disabled={busy || writeBlockedReason !== null} onClick={() => { void sendCommand({
                id: createCommandId(), type: "RevokeGatewayPolicy", resultKey: "policy_id", targetId: policy.id, expectedStatus: "REVOKED",
                label: "权限策略撤销", send: (api, commandId) => api.revokeGatewayPolicy({ projectId, policyId: policy.id,
                  expectedRevision: policy.revision, commandId }) }); }}>撤销</button>}
            </div></li>;
          })}</ul>}
          <form className="connections-form" onSubmit={submitPolicy} data-testid="policy-form"><h3>{selectedPolicy ? `修订策略 ${selectedPolicy.policy.id}` : "新建策略"}</h3>
            {selectedPolicy && <p className="helper-text">基于 rev {selectedPolicy.policy.revision} 追加不可变版本；旧版本仍可查看。</p>}
            <label className="field"><span className="field-label">策略</span><select value={policyId} disabled={busy} onChange={(event) => { setPolicyId(event.target.value); setPolicyResourceId(""); }} data-testid="policy-select">
              <option value="">新建策略</option>{snapshot.policies.filter(({ policy }) => policy.status === "ACTIVE").map(({ policy }) => <option key={policy.id} value={policy.id}>{policy.id}</option>)}</select></label>
            <label className="field"><span className="field-label">Capability</span><select value={policyCapability} disabled={busy} onChange={(event) => { setPolicyCapability(event.target.value as RelayGatewayCapability); setPolicyResourceId(""); }} data-testid="policy-capability">
              {capabilities.map((capability) => <option key={capability} value={capability}>{capability}</option>)}</select></label>
            {policyCapability === "WEB_FETCH" && <label className="field"><span className="field-label">策略主机</span><input value={policyHost} onChange={(event) => setPolicyHost(event.target.value)} disabled={busy} required placeholder="example.org" data-testid="policy-host" /></label>}
            {isFileCapability(policyCapability) && <label className="field"><span className="field-label">受管资源</span><select value={policyResourceId} onChange={(event) => setPolicyResourceId(event.target.value)} disabled={busy} required data-testid="policy-resource">
              <option value="">明确选择一个有效资源</option>{activeResources.map((item) => <option key={item.id} value={item.id}>{item.canonicalRoot} · {item.id}</option>)}</select><span className="field-hint">版本接口不提供 resource_id；修订时须重新明确选择，不从目录字符串猜测。</span></label>}
            <label className="field"><span className="field-label">决定</span><select value={policyDecision} onChange={(event) => setPolicyDecision(event.target.value as RelayGatewayDecision)} disabled={busy} data-testid="policy-decision">
              <option value="DENY">DENY · 拒绝（默认）</option><option value="ASK">ASK · 每次请求审批</option><option value="AUTO">AUTO · 匹配时自动准入</option></select></label>
            <label className="field"><span className="field-label">最大载荷字节</span><input type="number" min="0" max="262144" step="1" value={maxPayloadBytes} onChange={(event) => setMaxPayloadBytes(event.target.value)} disabled={busy} required data-testid="policy-max-bytes" /><span className="field-hint">当前只读动作的空参数编码为 2 字节；上限由服务端校验。</span></label>
            <div className="connections-actions"><button className="primary-button" type="submit" disabled={busy || writeBlockedReason !== null || (isFileCapability(policyCapability) && activeResources.length === 0)} data-testid="policy-save">{selectedPolicy ? "提交策略新版本" : "明确创建策略"}</button>
              {selectedPolicy && <button className="secondary-button" type="button" disabled={busy} onClick={() => { setPolicyId(""); setPolicyDecision("DENY"); setPolicyResourceId(""); }}>取消修订</button>}</div>
          </form>
        </section>
      </>}
    </>}
  </section>;
}
