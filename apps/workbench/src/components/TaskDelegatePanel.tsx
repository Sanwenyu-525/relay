import { useEffect, useRef, useState } from "react";
import AssistSourcePicker from "./AssistSourcePicker";
import { createCommandId, delegateSubmissionFrom, RelayApiError, RelayTransportError,
  type RelayApiClient, type RelayAssistSourceRef, type RelayMockGatewayConnection,
  type RelayMockManagedResource } from "../api/relayClient";
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
  const [delegateSources, setDelegateSources] = useState<readonly RelayAssistSourceRef[]>([]);
  const actionVersion = useRef(0);
  const targetKey = `${task.id}:${task.revision}:${task.executor}:${task.executorRunId}:${task.projectId}`;

  useEffect(() => {
    actionVersion.current++;
    setPendingDelegate(null); setDelegateError(null); setDelegating(false);
    setMockActionEnabled(false); setMockConnectionId(""); setMockResourceId("");
    setMockTarget(""); setMockContent(""); setDelegateSources([]);
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
  }, [mockActionEnabled, task.projectId, client, mockConfigEpoch]);

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

  async function delegate() {
    if (delegateBlockedReason || mockActionBlockedReason || pendingDelegate || delegating) return;
    const commandId = createCommandId(); const version = actionVersion.current;
    setPendingDelegate({ taskId: task.id, commandId }); setDelegateError(null); setDelegating(true);
    try {
      const accepted = await client.delegateTask({ taskId: task.id, commandId, expectedTaskRevision: task.revision,
        contextSources: delegateSources.map((source) => ({ ...source })),
        ...(mockActionEnabled ? { mockGatewayAction: { connectionId: mockConnectionId,
          resourceId: mockResourceId, target: mockTarget.trim(), content: mockContent.trim() } } : {}) });
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
  return <section className={compact ? "collaboration-delegate" : "surface-panel"} data-testid="task-delegate-panel">
    {!compact && <h2>委托执行</h2>}
    <p className="helper-text">委托命令返回 202 只表示已创建 Run 并授予执行权；实际进度以 Run 查询为准。聊天中的“开始”不构成委托授权。</p>
    {task.projectId && (compact
      ? <details className="collaboration-disclosure"><summary>本次委托冻结的资料来源 · 已选 {delegateSources.length}</summary>
        <AssistSourcePicker projectId={task.projectId} selectedRefs={delegateSources}
          onChange={setDelegateSources} disabled={delegating || pendingDelegate !== null} /></details>
      : <AssistSourcePicker projectId={task.projectId} selectedRefs={delegateSources}
        onChange={setDelegateSources} disabled={delegating || pendingDelegate !== null} />)}
    {showMockOptions && (compact
      ? <details className="collaboration-disclosure"><summary>附加 Mock 文件动作（可选）</summary>
        <MockActionOptions />
      </details>
      : <MockActionOptions />)}
    {delegateError && <p className="action-error" role="alert">{delegateError}</p>}
    {pendingDelegate ? <>
      <p className="helper-text" data-testid="delegate-command-id">原 command_id：{pendingDelegate.commandId}</p>
      <button className="secondary-button" type="button" data-testid="delegate-check-receipt" disabled={delegating}
        onClick={() => void checkDelegateReceipt()}>核对原命令回执</button>
    </> : <>
      <button className="primary-button" type="button" data-testid="task-delegate"
        disabled={delegateBlockedReason !== null || mockActionBlockedReason !== null || delegating}
        onClick={() => void delegate()}>{delegating ? "正在提交" : "委托 AI 执行"}</button>
      {delegateBlockedReason && <p className="disabled-reason">{delegateBlockedReason}</p>}
    </>}
  </section>;

  function MockActionOptions() {
    return <div className="create-form" data-testid="task-mock-action-options">
      <label className="choice-option"><input type="checkbox" checked={mockActionEnabled}
        onChange={(event) => setMockActionEnabled(event.target.checked)} disabled={pendingDelegate !== null || delegating}
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
        {mockConfigError && <button className="secondary-button" type="button" onClick={() => setMockConfigEpoch((value) => value + 1)}>重读动作配置</button>}
      </>}
    </div>;
  }
}
