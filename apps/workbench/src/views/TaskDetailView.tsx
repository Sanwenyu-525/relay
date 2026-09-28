import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Info, RotateCcw } from "lucide-react";
import ArtifactPanel from "../components/ArtifactPanel";
import TaskAcceptanceEvidence from "../components/TaskAcceptanceEvidence";
import AssistSourcePicker from "../components/AssistSourcePicker";
import StatusChip from "../components/StatusChip";
import { createCommandId, delegateSubmissionFrom, RelayApiError, RelayTransportError, type RelayAcceptanceCriterion, type RelayApiClient, type RelayAssistSourceRef, type RelayMockGatewayConnection, type RelayMockManagedResource, type RelayTaskAcceptance } from "../api/relayClient";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { fixtureModeFromQuery } from "../lib/fixtureMode";
import { executorLabels, interactionModeLabels, taskStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";
import type { DecimalRevision, ExecutorKind, FixtureError, InteractionMode, TaskStatus } from "../types";

interface TaskDetailResult {
  readonly source: "fixture" | "live";
  readonly projectArchivedAt: string | null | undefined;
  readonly projectReadError: string | null;
  readonly task: { readonly id: string; readonly title: string; readonly status: TaskStatus; readonly mode: InteractionMode; readonly executor: ExecutorKind; readonly revision: DecimalRevision; readonly acceptanceRevision: DecimalRevision; readonly currentCompletionId: string | null; readonly projectId: string | null; readonly runId: string | null; readonly allowedActions: readonly string[] | null };
  readonly objective: string | null;
  readonly acceptance: RelayTaskAcceptance | null;
  readonly criteria: readonly RelayAcceptanceCriterion[];
  readonly criteriaNote: string;
  readonly dependencies: readonly { readonly id: string; readonly title: string; readonly status: TaskStatus }[];
}
const tabs = [{ key: "overview", label: "概览" }, { key: "artifacts", label: "产物" }, { key: "runs", label: "执行记录" }] as const;

export default function TaskDetailView() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const mode = fixtureModeFromQuery(query);
  const connection = useRelayConnection();
  const live = connection.mode === "live";
  const targetKey = `${connection.epoch}:${id}:${mode}`;
  const [result, setResult] = useState<TaskDetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "artifacts" | "runs">(() => {
    const requested = query.get("tab");
    return requested === "artifacts" || requested === "runs" ? requested : "overview";
  });
  const [refreshing, setRefreshing] = useState(false);
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
  const requestVersion = useRef(0);
  const actionVersion = useRef(0);
  const disposed = useRef(false);
  const loadedTarget = useRef<string | null>(null);
  const activeTarget = useRef(targetKey);
  activeTarget.current = targetKey;
  async function loadFixture(): Promise<TaskDetailResult | null> {
    const snapshot = await fixtureAdapter.loadTask(id, mode);
    if (!snapshot) return null;
    const record = snapshot.task;
    return { source: "fixture", projectArchivedAt: null, projectReadError: null, task: { id: record.id, title: record.title, status: record.status, mode: record.mode, executor: record.executor, revision: record.revision, acceptanceRevision: snapshot.verification.acceptanceRevision, currentCompletionId: null, projectId: snapshot.id, runId: null, allowedActions: null }, objective: record.definition.objective, acceptance: null, criteria: snapshot.verification.checks.map((check) => ({ criterionId: check.id, statement: check.title, required: check.required, method: check.method, targetSpec: null })), criteriaNote: "示例验收方案，不代表服务端当前验收版本。", dependencies: [] };
  }
  async function loadLive(client: RelayApiClient): Promise<TaskDetailResult> {
    const task = await client.getTask(id);
    if (task.id !== id) throw new Error("Task 单读与当前目标不匹配。");
    let projectArchivedAt: string | null | undefined = null;
    let projectReadError: string | null = null;
    if (task.projectId !== null) {
      projectArchivedAt = undefined;
      try {
        const project = await client.getProject(task.projectId);
        if (project.id !== task.projectId) throw new Error("Project 单读与当前 Task 不匹配。");
        projectArchivedAt = project.archivedAt;
      } catch (caught) { projectReadError = describeLiveError(caught).message; }
    }
    return { source: "live", projectArchivedAt, projectReadError, task: { id: task.id, title: task.title, status: task.status, mode: task.mode, executor: task.executor, revision: task.revision, acceptanceRevision: task.acceptance.acceptanceRevision, currentCompletionId: task.currentCompletionId, projectId: task.projectId, runId: task.executorRunId, allowedActions: task.allowedActions }, objective: task.acceptance.objective || null, acceptance: task.acceptance, criteria: task.acceptance.criteria, criteriaNote: `来源：${task.acceptance.source}；验收版本 v${task.acceptance.acceptanceRevision}。`, dependencies: task.dependencies.map((dependency) => ({ id: dependency.taskId, title: dependency.title, status: dependency.status })) };
  }
  async function load() {
    const request = ++requestVersion.current;
    if (loadedTarget.current !== targetKey) { loadedTarget.current = targetKey; setResult(null); setLoading(true); setRefreshing(false); }
    else if (result) setRefreshing(true); else setLoading(true);
    setError(null);
    try { const client = connection.client; const loaded = client ? await loadLive(client) : await loadFixture(); if (request === requestVersion.current && !disposed.current && activeTarget.current === targetKey) setResult(loaded); }
    catch (caught) { if (request !== requestVersion.current || disposed.current || activeTarget.current !== targetKey) return; setError(live ? describeLiveError(caught).message : caught instanceof Error && "kind" in caught ? (caught as FixtureError).message.trim() : caught instanceof Error ? caught.message.trim() : "读取示例任务时发生未知错误。"); }
    finally { if (request === requestVersion.current && !disposed.current && activeTarget.current === targetKey) { setLoading(false); setRefreshing(false); } }
  }
  useEffect(() => {
    disposed.current = false; actionVersion.current++;
    setPendingDelegate(null); setDelegateError(null); setDelegating(false);
    setMockActionEnabled(false); setMockConnectionId(""); setMockResourceId(""); setMockTarget(""); setMockContent("");
    setDelegateSources([]);
    void load();
    return () => { disposed.current = true; requestVersion.current++; actionVersion.current++; };
  }, [targetKey]);
  useEffect(() => {
    const projectId = result?.source === "live" ? result.task.projectId : null;
    const client = connection.client;
    if (!mockActionEnabled || !projectId || !client) return;
    let active = true;
    setMockConfigLoading(true); setMockConfigError(null);
    void Promise.all([client.getMockGatewayConnections(projectId), client.getMockManagedResources(projectId)]).then(
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
  }, [mockActionEnabled, result?.task.projectId, result?.source, connection.client, mockConfigEpoch]);
  const projectWriteBlockedReason = result?.source !== "live" || result.task.projectId === null ? null :
    refreshing || loading || error !== null || result.projectArchivedAt === undefined ?
      `Project 事实正在核对或读取失败，不能提交新的任务命令。${result.projectReadError ?? ""}` :
      result.projectArchivedAt !== null ? "项目已归档，不能提交新的任务命令。" : null;
  const delegateBlockedReason = result?.source !== "live" ? "示例数据不创建真实 Run。"
    : projectWriteBlockedReason ? projectWriteBlockedReason
    : result.task.status !== "READY" ? "只有 READY 的任务可委托。"
    : result.task.executor !== "HUMAN" ? "当前执行权不属于人工，不能重复委托。"
    : result.task.projectId === null ? "没有所属项目，缺少 AI 执行作用域。"
    : !result.task.allowedActions?.includes("START") ? "当前前置条件不允许开始任务，请刷新核对。" : null;
  const mockActionBlockedReason = !mockActionEnabled ? null
    : mockConfigLoading ? "正在读取项目动作配置。"
    : mockConfigError ? `动作配置无法读取：${mockConfigError}`
    : !mockConnectionId ? "此项目没有可用的 Mock 写入连接。"
    : !mockResourceId ? "此项目没有可用的受管目录。"
    : !mockTarget.trim() ? "请填写受管目录内的完整目标文件路径。"
    : !mockContent.trim() ? "请填写要写入的 Mock 内容。" : null;
  async function delegate() {
    const task = result?.task; const client = connection.client;
    if (!task || !client || delegateBlockedReason || mockActionBlockedReason || pendingDelegate || delegating) return;
    const commandId = createCommandId(); const version = actionVersion.current;
    setPendingDelegate({ taskId: task.id, commandId }); setDelegateError(null); setDelegating(true);
    try {
      const accepted = await client.delegateTask({ taskId: task.id, commandId, expectedTaskRevision: task.revision,
        contextSources: delegateSources.map((source) => ({ ...source })),
        ...(mockActionEnabled ? { mockGatewayAction: { connectionId: mockConnectionId,
          resourceId: mockResourceId, target: mockTarget.trim(), content: mockContent.trim() } } : {}) });
      if (version !== actionVersion.current) return;
      setPendingDelegate(null); navigate(`/runs/${accepted.runId}`);
    } catch (caught) {
      if (version !== actionVersion.current) return;
      if (caught instanceof RelayTransportError) setDelegateError("提交结果尚未确定。只能查询原 command_id 回执，不能生成新命令重试。");
      else {
        setPendingDelegate(null); setDelegateError(describeLiveError(caught).message);
        if (caught instanceof RelayApiError) void load();
      }
    } finally { if (version === actionVersion.current) setDelegating(false); }
  }
  async function checkDelegateReceipt() {
    const pending = pendingDelegate; const client = connection.client;
    if (!pending || !client || delegating) return;
    const version = actionVersion.current; setDelegating(true);
    try {
      const receipt = await client.getCommandReceipt(pending.commandId);
      if (version !== actionVersion.current) return;
      const accepted = delegateSubmissionFrom(receipt.result);
      if (receipt.commandId !== pending.commandId || receipt.commandType !== "DelegateTask" ||
          accepted.taskId !== pending.taskId) throw new Error("原命令回执与当前任务不匹配。");
      setPendingDelegate(null); setDelegateError(null); navigate(`/runs/${accepted.runId}`);
    } catch (caught) {
      if (version !== actionVersion.current) return;
      setDelegateError(caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND"
        ? "尚未找到原命令回执，结果仍未确定；请稍后继续查询同一个 command_id。"
        : caught instanceof RelayApiError ? describeLiveError(caught).message
        : "原命令回执无法匹配 Delegate 与当前任务，结果仍未确定；请保留原 command_id 核对。");
    } finally { if (version === actionVersion.current) setDelegating(false); }
  }
  const mockActionOptions = result?.source === "live" && !result.task.runId ? <div className="create-form" data-testid="task-mock-action-options">
    <label className="choice-option"><input type="checkbox" checked={mockActionEnabled} onChange={(event) => setMockActionEnabled(event.target.checked)} disabled={pendingDelegate !== null || delegating} data-testid="task-mock-action-toggle" /><span>附加 Mock 文件动作<small>可选；仅向已登记的受管目录写入固定内容，执行前仍会核对权限并可能等待批准。</small></span></label>
    {mockActionEnabled && <>
      <label className="field"><span className="field-label">Mock 写入连接</span><select value={mockConnectionId} onChange={(event) => setMockConnectionId(event.target.value)} disabled={mockConfigLoading || pendingDelegate !== null || delegating} data-testid="task-mock-connection"><option value="">选择连接</option>{mockConnections.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
      <label className="field"><span className="field-label">受管目录</span><select value={mockResourceId} onChange={(event) => { setMockResourceId(event.target.value); setMockTarget(""); }} disabled={mockConfigLoading || pendingDelegate !== null || delegating} data-testid="task-mock-resource"><option value="">选择目录</option>{mockResources.map((item) => <option key={item.id} value={item.id}>{item.canonicalRoot}</option>)}</select></label>
      <label className="field"><span className="field-label">目标文件完整路径</span><input value={mockTarget} onChange={(event) => setMockTarget(event.target.value)} maxLength={4096} disabled={pendingDelegate !== null || delegating} data-testid="task-mock-target" /><span className="field-hint">目标必须在所选受管目录内；文件名由你明确指定。</span></label>
      <label className="field"><span className="field-label">Mock 写入内容</span><textarea value={mockContent} onChange={(event) => setMockContent(event.target.value)} maxLength={1024} rows={3} disabled={pendingDelegate !== null || delegating} data-testid="task-mock-content" /></label>
      <p className="helper-text">连接、目录和写入权限须先在该项目登记。委托回执不会执行文件动作；审批回执也不代表写入已完成。</p>
      {mockActionBlockedReason && <p className="disabled-reason" data-testid="task-mock-blocked">{mockActionBlockedReason}</p>}
      {mockConfigError && <button className="secondary-button" type="button" onClick={() => setMockConfigEpoch((value) => value + 1)}>重读动作配置</button>}
    </>}
  </div> : null;
  if (loadedTarget.current !== targetKey || loading) return <section className="page-state" aria-live="polite"><p className="eyebrow">任务详情</p><h1>正在读取任务</h1><p>{live ? "正在从本机 API 读取真实任务事实。" : "示例数据正在加载。"}</p></section>;
  if (error) return <section className="page-state page-state--error" role="alert"><p className="eyebrow">任务详情</p><h1>暂时无法读取这个任务</h1><p>{error}</p><button className="secondary-button" type="button" onClick={() => void load()}><RotateCcw aria-hidden="true" />重新读取</button></section>;
  if (!result) return <section className="page-state"><p className="eyebrow">任务详情</p><h1>{live ? "服务端没有返回这个任务" : "示例数据没有这个任务"}</h1><p>{live ? "跨作用域或已删除的任务按不可见处理；页面不会据此创建任务。" : "示例数据里只有“确定实验评价指标”这一个任务，其他任务不显示示例内容。"}</p><Link className="text-link" to="/tasks">返回任务列表</Link></section>;
  return <section className="skill-page" data-testid="task-detail"><div className="page-layout"><div className="page-primary"><p className="eyebrow">{live ? "真实任务" : "示例任务"}</p><h1>{result.task.title}</h1>{result.objective && <p className="page-lede">{result.objective}</p>}{refreshing && <p className="helper-text" role="status">正在更新任务事实，已显示的内容保持可见。</p>}{projectWriteBlockedReason && <p className="disabled-reason" data-testid="task-project-archive-reason">{projectWriteBlockedReason}</p>}
    <section className="rail-section"><h3>三个独立事实</h3><dl className="rail-definition-list"><div><dt>工作状态</dt><dd><StatusChip status={result.task.status} /></dd></div><div><dt>执行模式</dt><dd>{interactionModeLabels[result.task.mode]}</dd></div><div><dt>当前执行者</dt><dd>{executorLabels[result.task.executor]}</dd></div><div><dt>任务修订</dt><dd>v{result.task.revision}</dd></div><div><dt>验收版本</dt><dd>v{result.task.acceptanceRevision}</dd></div></dl>{result.source === "live" && result.task.currentCompletionId && <Link className="inline-link" to={`/completion-records/${result.task.currentCompletionId}`}>查看当前完成凭据</Link>}</section>
    <nav className="skill-tabs" aria-label="任务详情页签">{tabs.map((item) => <button key={item.key} className={`skill-tab${tab === item.key ? " skill-tab--active" : ""}`} type="button" aria-current={tab === item.key ? "page" : undefined} data-testid={`task-detail-tab-${item.key}`} onClick={() => setTab(item.key)}>{item.label}</button>)}</nav>
    {tab === "runs" && result.source === "live" && !result.task.runId && <section className="surface-panel" data-testid="task-delegate-panel"><h2>委托执行</h2><p className="helper-text">委托命令返回 202 只表示已创建 Run 并授予执行权；实际进度以 Run 查询为准。</p>{result.task.projectId && <AssistSourcePicker projectId={result.task.projectId} selectedRefs={delegateSources} onChange={setDelegateSources} disabled={delegating || pendingDelegate !== null} />}{mockActionOptions}{delegateError && <p className="action-error" role="alert">{delegateError}</p>}{pendingDelegate ? <><p className="helper-text" data-testid="delegate-command-id">原 command_id：{pendingDelegate.commandId}</p><button className="secondary-button" type="button" data-testid="delegate-check-receipt" disabled={delegating} onClick={() => void checkDelegateReceipt()}>核对原命令回执</button></> : <><button className="primary-button" type="button" data-testid="task-delegate" disabled={delegateBlockedReason !== null || mockActionBlockedReason !== null || delegating} onClick={() => void delegate()}>{delegating ? "正在提交" : "委托 AI 执行"}</button>{delegateBlockedReason && <p className="disabled-reason">{delegateBlockedReason}</p>}</>}</section>}
    {tab === "overview" && result.source === "live" && result.acceptance && connection.client &&
      <TaskAcceptanceEvidence client={connection.client} taskId={result.task.id} taskRevision={result.task.revision}
        acceptance={result.acceptance} runId={result.task.runId} completionId={result.task.currentCompletionId} />}
    {tab === "overview" ? <><section className="surface-panel"><h2>验收标准</h2><p className="helper-text">{result.criteriaNote}</p>{result.criteria.length ? <ul className="criteria-list">{result.criteria.map((criterion) => <li key={criterion.criterionId} className="criteria-row"><span className="criteria-copy"><strong>{criterion.statement}</strong><small>标识 {criterion.criterionId} · 验证方式 {criterion.method} · {criterion.required ? "必需" : "可选"}</small></span>{criterion.required && <span className="status-chip">必需</span>}</li>)}</ul> : <div className="page-state"><p>当前验收版本没有条件。</p></div>}<p className="helper-text"><Info aria-hidden="true" />修改验收标准需要专用命令，当前 API 还没有该入口（待接入）；本页只读取，不在这里改写验收。</p></section><section className="surface-panel"><h2>前置依赖</h2>{result.source === "fixture" ? <p className="helper-text">示例数据没有提供该任务的依赖事实；项目任务页展示的依赖来自示例项目范围。</p> : result.dependencies.length === 0 ? <div className="helper-text">没有前置依赖。</div> : <ul className="criteria-list">{result.dependencies.map((dependency) => <li key={dependency.id} className="criteria-row"><span className="criteria-copy"><strong>{dependency.title}</strong><small>状态：{taskStatusLabels[dependency.status]}</small></span><Link className="text-link" to={`/tasks/${dependency.id}`}>打开</Link></li>)}</ul>}</section><section className="surface-panel"><h2>编辑入口</h2><p className="helper-text">{result.task.status === "DONE" ? "该任务本轮已完成：编辑前需要先重开，界面不会悄悄改旧版本。" : "完善定义与验收方案沿用已有的 Skill 页面；产物编辑在“产物”页签里进行。"}</p><div className="form-actions"><Link className="secondary-button" to={`/tasks/${result.task.id}?skill=definition`}>完善任务定义</Link><Link className="secondary-button" to={`/tasks/${result.task.id}?skill=verification`}>验收方案</Link><Link className="secondary-button" to={`/tasks/${result.task.id}?skill=assist`}>打开 Assist</Link></div></section></> : tab === "artifacts" ? <ArtifactPanel key={`${connection.epoch}:${result.task.id}`} taskId={result.task.id} projectId={result.task.projectId} taskStatus={result.task.status} taskRevision={result.task.revision} acceptanceRevision={result.task.acceptanceRevision} criteria={result.criteria} allowedActions={result.task.allowedActions} writeBlockedReason={projectWriteBlockedReason} onRefresh={() => { if (!disposed.current) void load(); }} /> : <section className="surface-panel" data-testid="task-runs"><h2>执行记录</h2>{result.source === "live" && result.task.runId ? <><p className="helper-text">当前 AI 执行记录：{result.task.runId}</p><Link className="secondary-button" to={`/runs/${result.task.runId}`}>查看 Run 步骤与控制</Link></> : <p className="helper-text">{result.source === "fixture" ? "示例数据不提供真实 Run。" : "当前任务没有 AI Run；本页不推断历史执行记录。"}</p>}{result.task.currentCompletionId && <p className="helper-text">当前完成凭据：<Link className="inline-link" to={`/completion-records/${result.task.currentCompletionId}`}>{result.task.currentCompletionId}</Link>（历史凭据在重开后仍保留）。</p>}</section>}
  </div></div></section>;
}
