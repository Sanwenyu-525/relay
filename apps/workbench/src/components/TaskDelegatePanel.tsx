import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import AssistSourcePicker from "./AssistSourcePicker";
import { createCommandId, delegateSubmissionFrom, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayAssistSourceRef, type RelayMockGatewayConnection,
  type RelayMockManagedResource, type RelayGatewayConnection, type RelayManagedResource } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import type { DecimalRevision, ExecutorKind, TaskStatus } from "../types";

export interface DelegateTarget {
  readonly id: string;
  readonly projectId: string | null;
  readonly status: TaskStatus;
  readonly executor: ExecutorKind;
  readonly revision: DecimalRevision;
  readonly executorRunId: string | null;
  readonly allowedActions: readonly string[];
}

type ReadKind = "NONE" | "FILE_READ" | "WEB_FETCH";

function readTargetError(kind: ReadKind, target: string): string | null {
  const value = target.trim();
  if (kind === "FILE_READ") {
    if (!value) return "请填写所选受管目录内的相对文件路径。";
    if (/^[\\/]|^[a-z]:|[<>:\"|?*\u0000-\u001f]/i.test(value) ||
        value.split(/[\\/]/).includes("..") || /[\\/]$/.test(value) ||
        value.split(/[\\/]/).every((part) => part === "" || part === ".")) {
      return "文件目标必须是目录内的相对文件路径，不能使用绝对路径或上级目录。";
    }
  } else if (kind === "WEB_FETCH") {
    if (!value) return "请填写要读取的网页 URL。";
    try {
      const url = new URL(value);
      if (!/^https?:\/\//i.test(value) || !url.hostname || url.username || url.password || value.includes("#")) {
        return "网页目标仅接受无用户信息、无片段的 http(s) URL。";
      }
    } catch { return "请填写合法的 http(s) 网页 URL。"; }
  }
  return null;
}

/**
 * 任务委托是唯一写入口：任务详情页与协作工作区共用同一个组件和同一条命令路径，
 * 避免两处各自维护 Delegate 准入、回执核对或 Mock 动作配置。
 */
export default function TaskDelegatePanel({ client, task, projectWriteBlockedReason, onDelegated, compact }: {
  client: RelayApiClient;
  task: DelegateTarget;
  projectWriteBlockedReason: string | null;
  onDelegated: (runId: string) => void;
  compact?: boolean;
}) {
  const [delegating, setDelegating] = useState(false);
  const [delegateError, setDelegateError] = useState<string | null>(null);
  const [pendingDelegate, setPendingDelegate] = useState<{ taskId: string; commandId: string } | null>(null);
  const [mockActionEnabled, setMockActionEnabled] = useState(false);
  const [mockConnections, setMockConnections] = useState<readonly RelayMockGatewayConnection[]>([]);
  const [mockResources, setMockResources] = useState<readonly RelayMockManagedResource[]>([]);
  const [mockConfigLoading, setMockConfigLoading] = useState(false);
  const [mockConfigError, setMockConfigError] = useState<string | null>(null);
  const [mockConfigEpoch, setMockConfigEpoch] = useState(0);
  const [mockConnectionId, setMockConnectionId] = useState("");
  const [mockResourceId, setMockResourceId] = useState("");
  const [mockTarget, setMockTarget] = useState("");
  const [mockContent, setMockContent] = useState("");
  const [readKind, setReadKind] = useState<ReadKind>("NONE");
  const [readConnections, setReadConnections] = useState<readonly RelayGatewayConnection[]>([]);
  const [readResources, setReadResources] = useState<readonly RelayManagedResource[]>([]);
  const [readConfigLoading, setReadConfigLoading] = useState(false);
  const [readConfigError, setReadConfigError] = useState<string | null>(null);
  const [readConfigEpoch, setReadConfigEpoch] = useState(0);
  const [readConnectionId, setReadConnectionId] = useState("");
  const [readResourceId, setReadResourceId] = useState("");
  const [readRelativeTarget, setReadRelativeTarget] = useState("");
  const [readUrl, setReadUrl] = useState("");
  const [delegateSources, setDelegateSources] = useState<readonly RelayAssistSourceRef[]>([]);
  const [delegateExpanded, setDelegateExpanded] = useState(false);
  const actionVersion = useRef(0);
  const targetKey = `${task.id}:${task.revision}:${task.executor}:${task.executorRunId}:${task.projectId}`;

  useEffect(() => {
    actionVersion.current++;
    setPendingDelegate(null); setDelegateError(null); setDelegating(false);
    setMockActionEnabled(false); setMockConnectionId(""); setMockResourceId("");
    setMockTarget(""); setMockContent(""); setDelegateSources([]);
    setMockConnections([]); setMockResources([]); setMockConfigError(null); setMockConfigLoading(false);
    setReadKind("NONE"); clearReadConfig();
    setDelegateExpanded(false);
  }, [targetKey]);

  useEffect(() => {
    if (!mockActionEnabled || !task.projectId) return;
    let active = true;
    setMockConfigLoading(true); setMockConfigError(null);
    void Promise.all([client.getMockGatewayConnections(task.projectId), client.getMockManagedResources(task.projectId)]).then(
      ([connections, resources]) => {
        if (!active) return;
        const writable = connections.filter((item) => item.status === "ACTIVE" && item.capabilities.includes("FAKE_WRITE"));
        const managed = resources.filter((item) => item.status === "ACTIVE");
        setMockConnections(writable); setMockResources(managed);
        setMockConnectionId((current) => writable.some((item) => item.id === current) ? current : writable[0]?.id ?? "");
        setMockResourceId((current) => managed.some((item) => item.id === current) ? current : managed[0]?.id ?? "");
      }, (caught: unknown) => { if (active) { setMockConnections([]); setMockResources([]); setMockConfigError(describeLiveError(caught).message); } }
    ).finally(() => { if (active) setMockConfigLoading(false); });
    return () => { active = false; };
  }, [mockActionEnabled, targetKey, client, mockConfigEpoch]);

  useEffect(() => {
    if (readKind === "NONE" || !task.projectId) return;
    let active = true;
    setReadConfigLoading(true); setReadConfigError(null);
    void Promise.all([client.getGatewayConnections(task.projectId), readKind === "FILE_READ"
      ? client.getManagedResources(task.projectId) : Promise.resolve([])]).then(
      ([connections, resources]) => {
        if (!active) return;
        const available = connections.filter((item) => item.status === "ACTIVE" && item.capabilities.includes(readKind));
        const managed = resources.filter((item) => item.status === "ACTIVE" && item.projectId === task.projectId);
        setReadConnections(available); setReadResources(managed);
        setReadConnectionId(available[0]?.id ?? ""); setReadResourceId(managed[0]?.id ?? "");
      }, (caught: unknown) => { if (active) { clearReadConfig(); setReadConfigError(describeLiveError(caught).message); } }
    ).finally(() => { if (active) setReadConfigLoading(false); });
    return () => { active = false; };
  }, [readKind, targetKey, client, readConfigEpoch]);

  const delegateBlockedReason = projectWriteBlockedReason ? projectWriteBlockedReason
    : task.status !== "READY" ? "只有 READY 的任务可委托。"
    : task.executor !== "HUMAN" ? "当前执行权不属于人工，不能重复委托。"
    : task.projectId === null ? "没有所属项目，缺少 AI 执行作用域。"
    : !task.allowedActions.includes("START") ? "当前前置条件不允许开始任务，请刷新核对。" : null;
  const mockActionBlockedReason = !mockActionEnabled ? null
    : mockConfigLoading ? "正在读取项目动作配置。"
    : mockConfigError ? `动作配置无法读取：${mockConfigError}`
    : !mockConnectionId ? "此项目没有可用的 Mock 写入连接。"
    : !mockResourceId ? "此项目没有可用的受管目录。"
    : !mockTarget.trim() ? "请填写受管目录内的完整目标文件路径。"
    : !mockContent.trim() ? "请填写要写入的 Mock 内容。" : null;
  const readActionBlockedReason = readKind === "NONE" ? null
    : readConfigLoading ? "正在读取项目读取配置。"
    : readConfigError ? `读取配置无法读取：${readConfigError}`
    : !readConnections.some((item) => item.id === readConnectionId) ? `此项目没有可用的${readKind === "FILE_READ" ? "文件" : "网页"}读取连接。`
    : readKind === "FILE_READ" && !readResources.some((item) => item.id === readResourceId) ? "此项目没有可用的受管目录。"
    : readTargetError(readKind, readKind === "FILE_READ" ? readRelativeTarget : readUrl);

  async function delegate() {
    if (delegateBlockedReason || mockActionBlockedReason || readActionBlockedReason || pendingDelegate || delegating) return;
    const commandId = createCommandId(); const version = actionVersion.current;
    setPendingDelegate({ taskId: task.id, commandId }); setDelegateError(null); setDelegating(true);
    try {
      const accepted = await client.delegateTask({ taskId: task.id, commandId, expectedTaskRevision: task.revision,
        contextSources: delegateSources.map((source) => ({ ...source })),
        ...(mockActionEnabled ? { mockGatewayAction: { connectionId: mockConnectionId,
          resourceId: mockResourceId, target: mockTarget.trim(), content: mockContent.trim() } } : {}),
        ...(readKind === "FILE_READ" ? { fileReadAction: { connectionId: readConnectionId,
          resourceId: readResourceId, relativeTarget: readRelativeTarget.trim() } } : {}),
        ...(readKind === "WEB_FETCH" ? { webFetchAction: { connectionId: readConnectionId, url: readUrl.trim() } } : {}) });
      if (version !== actionVersion.current) return;
      setPendingDelegate(null); onDelegated(accepted.runId);
    } catch (caught) {
      if (version !== actionVersion.current) return;
      if (caught instanceof RelayTransportError) setDelegateError("提交结果尚未确定。只能查询原 command_id 回执，不能生成新命令重试。");
      else { setPendingDelegate(null); setDelegateError(describeLiveError(caught).message); }
    } finally { if (version === actionVersion.current) setDelegating(false); }
  }

  async function checkDelegateReceipt() {
    const pending = pendingDelegate;
    if (!pending || delegating) return;
    const version = actionVersion.current; setDelegating(true);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      if (version !== actionVersion.current) return;
      const accepted = delegateSubmissionFrom(receipt.result);
      if (receipt.commandId !== pending.commandId || receipt.commandType !== "DelegateTask" ||
          accepted.taskId !== pending.taskId) throw new Error("原命令回执与当前任务不匹配。");
      setPendingDelegate(null); setDelegateError(null); onDelegated(accepted.runId);
    } catch (caught) {
      if (version !== actionVersion.current) return;
      setDelegateError(caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND"
        ? "尚未找到原命令回执，结果仍未确定；请稍后继续查询同一个 command_id。"
        : caught instanceof RelayApiError ? describeLiveError(caught).message
        : "原命令回执无法匹配 Delegate 与当前任务，结果仍未确定；请保留原 command_id 核对。");
    } finally { if (version === actionVersion.current) setDelegating(false); }
  }

  const showMockOptions = task.executorRunId === null;
  const needsAttention = delegating || pendingDelegate !== null || delegateError !== null;
  const panelOpen = delegateExpanded || needsAttention;
  const content = <>
    <p className="helper-text">{compact ? "提交委托后请以运行状态核对进展；讨论消息不会自动启动执行。"
      : "委托命令返回 202 只表示已创建 Run 并授予执行权；实际进度以 Run 查询为准。聊天中的“开始”不构成委托授权。"}</p>
    {task.projectId && (compact
      ? <details className="collaboration-disclosure"><summary>本次委托冻结的资料来源 · 已选 {delegateSources.length}</summary>
        <AssistSourcePicker projectId={task.projectId} selectedRefs={delegateSources}
          onChange={setDelegateSources} disabled={delegating || pendingDelegate !== null} /></details>
      : <AssistSourcePicker projectId={task.projectId} selectedRefs={delegateSources}
        onChange={setDelegateSources} disabled={delegating || pendingDelegate !== null} />)}
    {showMockOptions && renderReadActionOptions()}
    {showMockOptions && (compact
      ? <details className="collaboration-disclosure"><summary>附加 Mock 文件动作（可选）</summary>
        {renderMockActionOptions()}
      </details>
      : renderMockActionOptions())}
    {delegateError && <p className="action-error" role="alert">{delegateError}</p>}
    {pendingDelegate ? <>
      <p className="helper-text" data-testid="delegate-command-id">原 command_id：{pendingDelegate.commandId}</p>
      <button className="secondary-button" type="button" data-testid="delegate-check-receipt" disabled={delegating}
        onClick={() => void checkDelegateReceipt()}>核对原命令回执</button>
    </> : <>
      <button className="primary-button" type="button" data-testid="task-delegate"
        disabled={delegateBlockedReason !== null || mockActionBlockedReason !== null || readActionBlockedReason !== null || delegating}
        onClick={() => void delegate()}>{delegating ? "正在提交" : "委托 AI 执行"}</button>
      {delegateBlockedReason && <p className="disabled-reason">{delegateBlockedReason}</p>}
    </>}
  </>;
  return <section className={compact ? "collaboration-delegate" : "surface-panel"} data-testid="task-delegate-panel">
    {compact ? <>
      <button className="collaboration-delegate-toggle" type="button" data-testid="delegate-config-toggle"
        aria-expanded={panelOpen} aria-controls={`delegate-config-${task.id}`} disabled={needsAttention}
        onClick={() => setDelegateExpanded((value) => !value)}>
        {panelOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        委托 AI 执行设置<span className="helper-text">{delegateBlockedReason ? "当前不可用" : "配置与开始"}</span>
      </button>
      {!panelOpen && delegateBlockedReason && <p className="disabled-reason">{delegateBlockedReason}</p>}
      <div id={`delegate-config-${task.id}`} data-testid="delegate-config-body" hidden={!panelOpen}>{content}</div>
    </> : <><h2>委托执行</h2>{content}</>}
  </section>;

  function clearReadConfig() {
    setReadConnections([]); setReadResources([]); setReadConnectionId(""); setReadResourceId("");
    setReadRelativeTarget(""); setReadUrl(""); setReadConfigError(null); setReadConfigLoading(false);
  }

  function renderReadActionOptions() {
    const frozen = pendingDelegate !== null || delegating;
    return <div className="create-form" data-testid="task-read-action-options">
      <label className="field"><span className="field-label">附加真实读取（可选）</span>
        <select value={readKind} data-testid="task-read-kind" disabled={frozen}
          onChange={(event) => {
            const kind = event.target.value as ReadKind;
            setReadKind(kind); clearReadConfig(); setReadConfigLoading(kind !== "NONE");
            setMockActionEnabled(false); setMockConnectionId(""); setMockResourceId("");
            setMockTarget(""); setMockContent(""); setMockConnections([]); setMockResources([]);
          }}><option value="NONE">不附加读取</option><option value="FILE_READ">读取受管文件</option>
          <option value="WEB_FETCH">读取网页</option></select></label>
      {readKind !== "NONE" && <>
        <label className="field"><span className="field-label">读取连接</span>
          <select value={readConnectionId} data-testid="task-read-connection" disabled={readConfigLoading || frozen}
            onChange={(event) => { setReadConnectionId(event.target.value); setReadResourceId(""); setReadRelativeTarget(""); setReadUrl(""); }}>
            <option value="">选择连接</option>{readConnections.map((item) => <option key={item.id} value={item.id}>
              {item.allowedHost ? `${item.allowedHost} · ${item.id}` : item.id}</option>)}</select></label>
        {readKind === "FILE_READ" ? <>
          <label className="field"><span className="field-label">受管目录</span>
            <select value={readResourceId} data-testid="task-read-resource" disabled={readConfigLoading || frozen}
              onChange={(event) => { setReadResourceId(event.target.value); setReadRelativeTarget(""); }}>
              <option value="">选择目录</option>{readResources.map((item) => <option key={item.id} value={item.id}>{item.canonicalRoot}</option>)}</select>
            <span className="field-hint">连接与受管目录分别选择，是否匹配会在执行时核对。</span></label>
          <label className="field"><span className="field-label">相对文件路径</span>
            <input value={readRelativeTarget} data-testid="task-read-relative-target" maxLength={1024} disabled={frozen}
              onChange={(event) => setReadRelativeTarget(event.target.value)} placeholder="notes/source.md" /></label>
        </> : <label className="field"><span className="field-label">网页 URL</span>
          <input value={readUrl} data-testid="task-read-url" type="url" maxLength={2048} disabled={frozen}
            onChange={(event) => setReadUrl(event.target.value)} placeholder="https://example.org/article" /></label>}
        <p className="helper-text">本次委托只读取一个目标；运行时仍会核对连接、权限、目标、网页主机和重定向。</p>
        {readActionBlockedReason && <p className="disabled-reason" data-testid="task-read-blocked">{readActionBlockedReason}</p>}
        <button className="secondary-button" type="button" data-testid="task-read-reload" disabled={readConfigLoading || frozen}
          onClick={() => { clearReadConfig(); setReadConfigLoading(true); setReadConfigEpoch((value) => value + 1); }}>重读读取配置</button>
      </>}
    </div>;
  }

  function renderMockActionOptions() {
    return <div className="create-form" data-testid="task-mock-action-options">
      <label className="choice-option"><input type="checkbox" checked={mockActionEnabled}
        onChange={(event) => {
          setMockActionEnabled(event.target.checked); setMockConnectionId(""); setMockResourceId(""); setMockTarget(""); setMockContent("");
          if (event.target.checked) { setReadKind("NONE"); clearReadConfig(); }
        }} disabled={pendingDelegate !== null || delegating}
        data-testid="task-mock-action-toggle" /><span>附加 Mock 文件动作<small>仅向已登记的受管目录写入固定内容，执行前仍会核对权限并可能等待批准。</small></span></label>
      {mockActionEnabled && <>
        <label className="field"><span className="field-label">Mock 写入连接</span><select value={mockConnectionId}
          onChange={(event) => setMockConnectionId(event.target.value)} disabled={mockConfigLoading || pendingDelegate !== null || delegating}
          data-testid="task-mock-connection"><option value="">选择连接</option>{mockConnections.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
        <label className="field"><span className="field-label">受管目录</span><select value={mockResourceId}
          onChange={(event) => { setMockResourceId(event.target.value); setMockTarget(""); }}
          disabled={mockConfigLoading || pendingDelegate !== null || delegating} data-testid="task-mock-resource">
          <option value="">选择目录</option>{mockResources.map((item) => <option key={item.id} value={item.id}>{item.canonicalRoot}</option>)}</select></label>
        <label className="field"><span className="field-label">目标文件完整路径</span><input value={mockTarget}
          onChange={(event) => setMockTarget(event.target.value)} maxLength={4096} disabled={pendingDelegate !== null || delegating}
          data-testid="task-mock-target" /><span className="field-hint">目标必须在所选受管目录内；文件名由你明确指定。</span></label>
        <label className="field"><span className="field-label">Mock 写入内容</span><textarea value={mockContent}
          onChange={(event) => setMockContent(event.target.value)} maxLength={1024} rows={3}
          disabled={pendingDelegate !== null || delegating} data-testid="task-mock-content" /></label>
        <p className="helper-text">连接、目录和写入权限须先在该项目登记。委托回执不会执行文件动作；审批回执也不代表写入已完成。</p>
        {mockActionBlockedReason && <p className="disabled-reason" data-testid="task-mock-blocked">{mockActionBlockedReason}</p>}
        {mockConfigError && <button className="secondary-button" type="button" disabled={pendingDelegate !== null || delegating}
          onClick={() => setMockConfigEpoch((value) => value + 1)}>重读动作配置</button>}
      </>}
    </div>;
  }
}
