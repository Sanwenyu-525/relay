import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { createCommandId, RelayApiError, type RelayApiClient,
  type RelayPeriodPlan, type RelayScopeOption, type RelayScopeOptionKind,
  type RelayScopeSimulation, type RelayTaskSummary, type RelayTimeEstimateInput } from "../api/relayClient";
import type { RelayProjectGoal } from "../api/blueprintDtos";
import ProjectNav from "../components/ProjectNav";
import PageHeader from "../components/PageHeader";
import { describeLiveError } from "../lib/liveErrors";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { useProjectTaskPages } from "../lib/useProjectTaskPages";
import { useRelayConnection } from "../lib/relayConnection";
import "./ProjectPlanningView.css";

type PlanningIntent =
  | { readonly kind: "PROPOSE_PLAN"; readonly input: { commandId: string; projectId: string; title: string;
    availableMs: number; diagnosticMs: number; taskIds: readonly string[]; mainlineTaskIds: readonly string[]; goalIds: readonly string[] } }
  | { readonly kind: "RESOLVE_ITEM"; readonly input: { commandId: string; planId: string; itemId: string;
    expectedRevision: string; action: "ACCEPT" | "REJECT"; reason: string } }
  | { readonly kind: "PROPOSE_SCOPE"; readonly input: { commandId: string; planId: string; expectedRevision: string;
    keepTaskIds: readonly string[]; deferTaskIds: readonly string[]; unreliableTaskIds: readonly string[] } }
  | { readonly kind: "SELECT_SCOPE"; readonly input: { commandId: string; simulationId: string; expectedRevision: string;
    option: RelayScopeOptionKind; confirmed: true; reason: string } }
  | { readonly kind: "RECORD_ESTIMATE"; readonly input: RelayTimeEstimateInput };
type EstimateHistory = Awaited<ReturnType<RelayApiClient["getTaskTimeEstimates"]>>;

const statusText: Record<string, string> = { CANDIDATE: "待决定", ACCEPTED: "已接受", REJECTED: "已拒绝",
  TASK: "任务", DIAGNOSTIC: "限时诊断", DEFERRED: "延后", PROPOSED: "待选择", SELECTED: "已选择" };
const reasonText: Record<string, string> = { MAINLINE_OR_PREREQUISITE: "主线或必要前置", REMAINING_CAPACITY: "剩余容量内",
  BOUNDED_DIAGNOSIS_REQUIRED: "限时诊断", CAPACITY_EXCEEDED: "容量不足", DEPENDENCY_NOT_PLANNED: "必要前置未纳入计划",
  OPEN_BLOCKER: "存在未解除阻塞", TASK_NOT_IDLE: "任务状态已变化", ESTIMATE_UNKNOWN: "估时未知",
  SCOPE_EXCLUDED: "缩小范围后移出", DEFERRED_BY_USER: "按选择延后", DEFERRED_WITH_DEPENDENT: "因前置延后",
  USER_MARKED_UNRELIABLE: "用户标记为不可靠", USER_DECLARED_UNVERIFIED: "用户声明，尚未核验" };

function pendingKey(client: RelayApiClient, projectId: string) {
  return `relay:planning-command:${client.baseUrl}:${client.workspaceId}:${projectId}`;
}
function readPending(client: RelayApiClient, projectId: string): PlanningIntent | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(pendingKey(client, projectId)) ?? "null");
    if (typeof parsed !== "object" || parsed === null || !("kind" in parsed) || !("input" in parsed) ||
      !["PROPOSE_PLAN", "RESOLVE_ITEM", "PROPOSE_SCOPE", "SELECT_SCOPE", "RECORD_ESTIMATE"].includes(String((parsed as { kind?: unknown }).kind))) return null;
    const input = (parsed as { input?: unknown }).input;
    return typeof input === "object" && input !== null && "commandId" in input &&
      typeof (input as { commandId?: unknown }).commandId === "string" ? parsed as PlanningIntent : null;
  } catch { return null; }
}
function optionTitle(kind: RelayScopeOptionKind) {
  return kind === "ALL" ? "全部候选" : kind === "SHRINK" ? "保留主线与必要前置" : "延后指定范围";
}
function formatMinutes(milliseconds: number | null) {
  return milliseconds === null ? "未知" : `${Math.round(milliseconds / 60000)} 分钟`;
}
function formatEstimate(value: string | null) {
  return value === null ? "未知" : formatMinutes(Number(value));
}
function minutesToMilliseconds(value: string): number | null {
  if (value.trim() === "") return null;
  const minutes = Number(value);
  const milliseconds = minutes * 60000;
  return Number.isSafeInteger(minutes) && minutes >= 0 && Number.isSafeInteger(milliseconds) ? milliseconds : null;
}
function field(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake];
}
function requiredString(record: Record<string, unknown>, camel: string, snake: string): string {
  const value = field(record, camel, snake);
  if (typeof value !== "string" || value === "") throw new Error(`命令结果缺少 ${camel} 身份。`);
  return value;
}

export default function ProjectPlanningView() {
  const { id = "" } = useParams();
  const connection = useRelayConnection();
  if (!connection.client) return <section className="page-state"><p className="eyebrow">下一段工作</p>
    <h1>需要连接本机 API</h1><p>计划和范围推演读取真实项目任务、目标与用户声明的估时；示例数据不提供可写的计划事实。</p>
    <Link className="text-link" to="/settings/connections">连接工作空间</Link></section>;
  return <LiveProjectPlanning key={`${connection.epoch}:${id}`} client={connection.client} projectId={id} />;
}

function LiveProjectPlanning({ client, projectId }: { readonly client: RelayApiClient; readonly projectId: string }) {
  const taskPages = useProjectTaskPages(client, projectId, true, `${client.workspaceId}:${projectId}`, 20);
  const [projectTitle, setProjectTitle] = useState("");
  const [goals, setGoals] = useState<readonly RelayProjectGoal[]>([]);
  const [plans, setPlans] = useState<readonly RelayPeriodPlan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [simulations, setSimulations] = useState<readonly RelayScopeSimulation[]>([]);
  const [selectedSimulationId, setSelectedSimulationId] = useState("");
  const skipSimulationRefreshForPlan = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<PlanningIntent | null>(() => readPending(client, projectId));
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const key = useMemo(() => pendingKey(client, projectId), [client, projectId]);
  const [title, setTitle] = useState("下一段工作");
  const [availableMinutes, setAvailableMinutes] = useState("240");
  const [diagnosticMinutes, setDiagnosticMinutes] = useState("30");
  const [selectedTaskIds, setSelectedTaskIds] = useState<readonly string[]>([]);
  const [mainlineTaskIds, setMainlineTaskIds] = useState<readonly string[]>([]);
  const [goalIds, setGoalIds] = useState<readonly string[]>([]);
  const [estimates, setEstimates] = useState<ReadonlyMap<string, EstimateHistory>>(new Map());
  const [estimateTaskRevisionOverrides, setEstimateTaskRevisionOverrides] = useState<ReadonlyMap<string, string>>(new Map());
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [resolutionReason, setResolutionReason] = useState("");
  const [keepTaskIds, setKeepTaskIds] = useState<readonly string[]>([]);
  const [deferTaskIds, setDeferTaskIds] = useState<readonly string[]>([]);
  const [unreliableTaskIds, setUnreliableTaskIds] = useState<readonly string[]>([]);
  const [scopeReason, setScopeReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAbsent, setPendingAbsent] = useState(false);
  const scopeVersion = useRef(0);
  const simulationVersion = useRef(0);
  const selectedPlanIdRef = useRef(selectedPlanId);
  selectedPlanIdRef.current = selectedPlanId;

  const formDraft = { title, availableMinutes, diagnosticMinutes, selectedTaskIds, mainlineTaskIds, goalIds };
  const formDraftRef = useRef(formDraft);
  formDraftRef.current = formDraft;
  const cleanDraft = useRef(JSON.stringify({ title: "下一段工作", availableMinutes: "240", diagnosticMinutes: "30",
    selectedTaskIds: [], mainlineTaskIds: [], goalIds: [] }));
  const guard = useRef<DraftGuard>({
    hasUnsavedChanges: () => pendingRef.current !== null || JSON.stringify(formDraftRef.current) !== cleanDraft.current,
    discard: () => {
      if (pendingRef.current) return;
      setTitle("下一段工作"); setAvailableMinutes("240"); setDiagnosticMinutes("30");
      setSelectedTaskIds([]); setMainlineTaskIds([]); setGoalIds([]);
    },
    pendingCommandId: () => pendingRef.current?.input.commandId ?? null,
    pendingRecoversAfterLeave: () => true
  });

  const refreshPlans = useCallback(async (keepSelection = true) => {
    const token = ++scopeVersion.current;
    setError(null);
    try {
      const [project, nextGoals, nextPlans] = await Promise.all([client.getProject(projectId),
        client.getProjectGoals(projectId), client.getProjectPeriodPlans(projectId)]);
      if (token !== scopeVersion.current) return;
      setProjectTitle(project.title); setGoals(nextGoals); setPlans(nextPlans.items);
      setSelectedPlanId((current) => keepSelection && nextPlans.items.some((plan) => plan.planId === current)
        ? current : nextPlans.items[0]?.planId ?? "");
    } catch (caught) { if (token === scopeVersion.current) setError(describeLiveError(caught).message); }
    finally { if (token === scopeVersion.current) setLoading(false); }
  }, [client, projectId]);

  const refreshSimulations = useCallback(async (planId: string, preferSimulationId?: string) => {
    const token = ++simulationVersion.current;
    try {
      const result = await client.getPlanScopeSimulations(planId);
      if (token !== simulationVersion.current || selectedPlanIdRef.current !== planId) return;
      setSimulations(result.items);
      setSelectedSimulationId(result.items.some((item) => item.simulationId === preferSimulationId)
        ? preferSimulationId! : result.items[0]?.simulationId ?? "");
    } catch (caught) {
      if (token === simulationVersion.current && selectedPlanIdRef.current === planId)
        setActionError(`读取范围推演失败：${describeLiveError(caught).message}`);
    }
  }, [client]);

  async function readPlanForSelection(planId: string) {
    scopeVersion.current++;
    const [plan, planList] = await Promise.all([client.getPeriodPlan(planId), client.getProjectPeriodPlans(projectId)]);
    if (plan.projectId !== projectId || !planList.items.some((item) => item.planId === planId))
      throw new Error("计划详情与项目列表读回不一致；命令仍待核对。");
    const listed = planList.items.find((item) => item.planId === planId)!;
    if (listed.revision !== plan.revision) throw new Error("计划详情与项目列表修订不一致；命令仍待核对。");
    setPlans(planList.items); setSelectedPlanId(planId);
    return plan;
  }

  async function applyVerifiedResult(intent: PlanningIntent, rawResult: unknown) {
    const result = typeof rawResult === "object" && rawResult !== null ? rawResult as Record<string, unknown> : {};
    if (intent.kind === "RECORD_ESTIMATE") {
      const taskId = requiredString(result, "taskId", "task_id");
      const estimateId = requiredString(result, "estimateId", "estimate_id");
      const revision = requiredString(result, "revision", "revision");
      if (taskId !== intent.input.taskId) throw new Error("估时回执任务身份与原请求不匹配。");
      const history = await client.getTaskTimeEstimates(taskId);
      const saved = history.items.find((item) => item.id === estimateId && item.revision === revision);
      if (!saved || saved.taskId !== taskId || saved.sourceKind !== "USER_DECLARED" ||
        saved.sourceNote !== intent.input.sourceNote || saved.elapsedMs !== (intent.input.elapsedMs === null ? null : String(intent.input.elapsedMs)) ||
        saved.executionMs !== (intent.input.executionMs === null ? null : String(intent.input.executionMs)) ||
        saved.waitingMs !== (intent.input.waitingMs === null ? null : String(intent.input.waitingMs)) ||
        saved.reviewMs !== (intent.input.reviewMs === null ? null : String(intent.input.reviewMs)) ||
        saved.humanMs !== (intent.input.humanMs === null ? null : String(intent.input.humanMs)))
        throw new Error("估时历史未能核对原命令的记录 ID、载荷与用户声明来源；命令仍待核对。");
      setEstimates((current) => new Map(current).set(taskId, history));
      return history.current?.id === estimateId && history.current.applicable
        ? "用户声明估时已记录并读回，适用于当前验收版本。"
        : "用户声明估时已保留在历史中，但当前验收版本已变化，该记录不适用于当前验收。";
    }

    if (intent.kind === "PROPOSE_PLAN") {
      const planId = requiredString(result, "planId", "plan_id");
      if (requiredString(result, "projectId", "project_id") !== projectId) throw new Error("计划回执项目身份不匹配。");
      const revision = requiredString(result, "revision", "revision");
      const plan = await readPlanForSelection(planId);
      if (plan.revision !== revision) throw new Error("计划回执修订与详情读回不一致；命令仍待核对。");
      return "计划命令已核对，已读回并选中对应计划。";
    }
    if (intent.kind === "RESOLVE_ITEM") {
      const planId = requiredString(result, "planId", "plan_id");
      const itemId = requiredString(result, "itemId", "item_id");
      const itemStatus = requiredString(result, "itemStatus", "item_status");
      const expectedStatus = intent.input.action === "ACCEPT" ? "ACCEPTED" : "REJECTED";
      const revision = requiredString(result, "revision", "revision");
      if (requiredString(result, "projectId", "project_id") !== projectId) throw new Error("计划项回执项目身份不匹配。");
      const plan = await readPlanForSelection(planId);
      const item = plan.items.find((candidate) => candidate.id === itemId);
      if (planId !== intent.input.planId || itemId !== intent.input.itemId || itemStatus !== expectedStatus ||
        item?.status !== expectedStatus || plan.revision !== revision)
        throw new Error("计划项身份或读回状态与原操作不一致；命令仍待核对。");
      return "计划项命令已核对，已读回对应计划和处理状态。";
    }
    if (intent.kind === "PROPOSE_SCOPE") {
      const simulationId = requiredString(result, "simulationId", "simulation_id");
      const revision = requiredString(result, "revision", "revision");
      if (requiredString(result, "sourcePlanId", "source_plan_id") !== intent.input.planId ||
        requiredString(result, "projectId", "project_id") !== projectId || requiredString(result, "status", "status") !== "PROPOSED")
        throw new Error("范围推演回执身份或状态与原请求不匹配。");
      const plan = await readPlanForSelection(intent.input.planId);
      const [simulation, list] = await Promise.all([client.getScopeSimulation(simulationId), client.getPlanScopeSimulations(plan.planId)]);
      if (simulation.revision !== revision || simulation.sourcePlanId !== plan.planId || simulation.projectId !== projectId || simulation.status !== "PROPOSED" ||
        !list.items.some((item) => item.simulationId === simulationId)) throw new Error("范围推演详情与列表读回不一致；命令仍待核对。");
      setSimulations(list.items); setSelectedSimulationId(simulationId);
      return "范围推演命令已核对，已读回并选中对应推演。";
    }

    const simulationId = requiredString(result, "simulationId", "simulation_id");
    const selectedPlanId = requiredString(result, "selectedPlanId", "selected_plan_id");
    const sourcePlanId = requiredString(result, "sourcePlanId", "source_plan_id");
    const revision = requiredString(result, "revision", "revision");
    if (requiredString(result, "projectId", "project_id") !== projectId || simulationId !== intent.input.simulationId ||
      requiredString(result, "status", "status") !== "SELECTED" ||
      requiredString(result, "selectedOption", "selected_option") !== intent.input.option)
      throw new Error("范围选择回执身份、状态或选项与原请求不匹配。");
    const [simulation, list] = await Promise.all([client.getScopeSimulation(simulationId), client.getPlanScopeSimulations(sourcePlanId)]);
    if (simulation.revision !== revision || simulation.sourcePlanId !== sourcePlanId || simulation.projectId !== projectId ||
      simulation.status !== "SELECTED" || simulation.selectedOption !== intent.input.option ||
      simulation.selectedPlanId !== selectedPlanId || !list.items.some((item) => item.simulationId === simulationId))
      throw new Error("范围推演详情与列表读回不一致；命令仍待核对。");
    const previousPlanId = selectedPlanIdRef.current;
    skipSimulationRefreshForPlan.current = selectedPlanId;
    await readPlanForSelection(selectedPlanId);
    if (previousPlanId === selectedPlanId) skipSimulationRefreshForPlan.current = null;
    setSimulations(list.items); setSelectedSimulationId(simulationId);
    return "范围选择命令已核对，已读回并选中新计划与推演。";
  }

  useEffect(() => { setDraftGuard(guard.current); void refreshPlans(false); return () => {
    scopeVersion.current++; clearDraftGuard(guard.current);
  }; }, [refreshPlans]);

  const selectedPlan = plans.find((plan) => plan.planId === selectedPlanId) ?? null;
  const selectedSimulation = simulations.find((simulation) => simulation.simulationId === selectedSimulationId) ?? null;
  useEffect(() => {
    if (!selectedPlan) { simulationVersion.current++; setSimulations([]); setSelectedSimulationId(""); return; }
    if (skipSimulationRefreshForPlan.current === selectedPlan.planId) {
      skipSimulationRefreshForPlan.current = null;
      return () => { simulationVersion.current++; };
    }
    simulationVersion.current++;
    setSimulations([]); setSelectedSimulationId("");
    void refreshSimulations(selectedPlan.planId);
    return () => { simulationVersion.current++; };
  }, [selectedPlanId, refreshSimulations]);

  useEffect(() => {
    let active = true;
    const ids = taskPages.items.map((task) => task.id);
    if (ids.length === 0) { setEstimates(new Map()); setEstimateError(null); return () => { active = false; }; }
    setEstimateError(null);
    void Promise.all(ids.map(async (taskId) => [taskId, await client.getTaskTimeEstimates(taskId)] as const))
      .then((rows) => { if (active) setEstimates(new Map(rows)); })
      .catch((caught: unknown) => { if (active) setEstimateError(describeLiveError(caught).message); });
    return () => { active = false; };
  }, [client, taskPages.items]);

  function storePending(intent: PlanningIntent) {
    try { sessionStorage.setItem(key, JSON.stringify(intent)); }
    catch { setActionError("无法在本机暂存原命令；为保证可恢复，本次没有发送。"); return false; }
    pendingRef.current = intent; setPending(intent); setPendingAbsent(false); return true;
  }
  function clearPending() {
    try { sessionStorage.removeItem(key); } catch { /* Keep the in-memory resolution visible for this page. */ }
    pendingRef.current = null; setPending(null); setPendingAbsent(false);
  }
  async function send(intent: PlanningIntent) {
    if (submitting || pendingRef.current !== null) return;
    if (!storePending(intent)) return;
    setSubmitting(true); setActionError(null); setNotice(null);
    await sendStored(intent);
  }
  async function sendStored(intent: PlanningIntent) {
    setSubmitting(true); setActionError(null);
    let commandResponseReceived = false;
    try {
      let result: unknown;
      if (intent.kind === "PROPOSE_PLAN") result = await client.proposePeriodPlan(intent.input);
      else if (intent.kind === "RESOLVE_ITEM") result = await client.resolvePeriodPlanItem(intent.input);
      else if (intent.kind === "PROPOSE_SCOPE") result = await client.proposeScopeSimulation(intent.input);
      else if (intent.kind === "SELECT_SCOPE") result = await client.selectScopeSimulation(intent.input);
      else result = await client.recordTaskTimeEstimate(intent.input);
      commandResponseReceived = true;
      const confirmation = await applyVerifiedResult(intent, result);
      clearPending(); setNotice(confirmation);
      if (intent.kind === "PROPOSE_PLAN") {
        setTitle("下一段工作"); setAvailableMinutes("240"); setDiagnosticMinutes("30");
        setSelectedTaskIds([]); setMainlineTaskIds([]); setGoalIds([]);
        cleanDraft.current = JSON.stringify({ title: "下一段工作", availableMinutes: "240", diagnosticMinutes: "30",
          selectedTaskIds: [], mainlineTaskIds: [], goalIds: [] });
      }
    } catch (caught) {
      const definitive = !commandResponseReceived && caught instanceof RelayApiError && caught.problem.status < 500;
      if (definitive) clearPending();
      let refreshNote = "";
      if (definitive && intent.kind === "RECORD_ESTIMATE") {
        try {
          const [task, history] = await Promise.all([client.getTask(intent.input.taskId), client.getTaskTimeEstimates(intent.input.taskId)]);
          if (task.projectId !== projectId) throw new Error("任务读回不属于当前项目。");
          setEstimateTaskRevisionOverrides((current) => new Map(current).set(task.id, task.revision));
          setEstimates((current) => new Map(current).set(task.id, history));
        } catch (refreshError) { refreshNote = `；当前任务和估时修订刷新失败：${describeLiveError(refreshError).message}`; }
      }
      setActionError(`${commandResponseReceived ? "命令已响应但读回仍待核对，原 ID 与载荷已保留" : definitive ? "命令被服务端拒绝" : "命令结果待核对，原 ID 与载荷已保留"}：${describeLiveError(caught).message}${refreshNote}`);
      if (definitive) await refreshPlans();
    } finally { setSubmitting(false); }
  }
  async function recoverPending() {
    if (!pending || submitting) return;
    setSubmitting(true); setActionError(null); setPendingAbsent(false);
    try {
      let receipt;
      try { receipt = await client.getCommandReceipt(pending.input.commandId); }
      catch (caught) {
        if (caught instanceof RelayApiError && caught.problem.status === 404) {
          setPendingAbsent(true); setActionError("服务端尚未找到该命令回执。原 ID 与完整载荷仍保留，可明确选择用同一 ID 重试。");
          return;
        }
        throw caught;
      }
      const expected = pending.kind === "PROPOSE_PLAN" ? "ProposePeriodPlan"
        : pending.kind === "RESOLVE_ITEM" ? "ResolvePeriodPlanItem"
        : pending.kind === "PROPOSE_SCOPE" ? "ProposeScopeSimulation"
        : pending.kind === "SELECT_SCOPE" ? "SelectScopeSimulation" : "RecordTaskTimeEstimate";
      if (receipt.commandId !== pending.input.commandId || receipt.commandType !== expected)
        throw new Error("回执身份或命令类型与原请求不匹配；继续保留原请求供核对。");
      const confirmation = await applyVerifiedResult(pending, receipt.result);
      clearPending(); setNotice(`${confirmation} 已使用原回执恢复，没有重新提交。`);
    } catch (caught) {
      setActionError(`回执或服务端读回暂时无法核对，原请求仍保留：${describeLiveError(caught).message}`);
    } finally { setSubmitting(false); }
  }

  function toggleId(setter: (ids: readonly string[]) => void, ids: readonly string[], id: string) {
    setter(ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  }
  const loadedTasks = taskPages.items;

  if (loading) return <section className="page-state" role="status"><h1>正在读取下一段工作…</h1></section>;
  if (error && projectTitle === "") return <section className="page-state page-state--error" role="alert"><h1>暂时无法读取项目计划</h1>
    <p>{error}</p><button className="secondary-button" type="button" onClick={() => void refreshPlans(false)}>重新读取</button></section>;

  return <section className="skill-page planning-page"><div className="page-layout"><main className="page-primary">
    <PageHeader title="下一段工作" meta={projectTitle} lede="把本段时间和要推进的任务排成可审阅计划。接受计划只处理计划项，不授权执行。" />
    <ProjectNav projectId={projectId} active="planning" />
    {pending && <section className="surface-panel planning-pending" aria-label="计划命令待核对" data-testid="planning-pending-command">
      <h2>命令结果待核对</h2><p>原 command ID：<code>{pending.input.commandId}</code>。请求载荷已保存在本机此工作区，不会自动换 ID 重发。</p>
      <button className="secondary-button" type="button" disabled={submitting} onClick={() => void recoverPending()}>查询原命令回执</button>
      {pendingAbsent && <button className="secondary-button" type="button" disabled={submitting}
        onClick={() => void sendStored(pending)}>用原 ID 与原载荷重试</button>}
    </section>}
    {error && <p className="action-error" role="alert">刷新失败：{error}；已保留本地已读计划。</p>}
    {notice && <p className="receipt-message" role="status">{notice}</p>}
    {actionError && <p className="action-error" role="alert">{actionError}</p>}

    <section className="surface-panel planning-compose" aria-label="发起计划">
      <h2>安排一个时间窗口</h2>
      <p className="helper-text">估时只使用用户声明记录。未提供估时的任务可进入有限诊断候选；本段计划不创建执行授权。</p>
      <div className="planning-fields">
        <label className="field"><span className="field-label">计划名称</span><input value={title} maxLength={200}
          onChange={(event) => setTitle(event.target.value)} disabled={pending !== null} /></label>
        <label className="field"><span className="field-label">可用时间（分钟）</span><input type="number" min="1" max="2592000"
          value={availableMinutes} onChange={(event) => setAvailableMinutes(event.target.value)} disabled={pending !== null} /></label>
        <label className="field"><span className="field-label">未知估时诊断预算（分钟）</span><input type="number" min="0" max="2592000"
          value={diagnosticMinutes} onChange={(event) => setDiagnosticMinutes(event.target.value)} disabled={pending !== null} /></label>
      </div>
      <h3>选择任务与主线</h3>
      <p className="helper-text">已加载 {loadedTasks.length} 项{taskPages.nextCursor === null ? "，任务列表已到末页。" : "，仍有后续页。"}</p>
      {taskPages.error && <div className="action-error" role="alert">已保留已加载任务与原游标：{taskPages.error}
        <button className="text-button" type="button" disabled={taskPages.loading || taskPages.loadingMore} onClick={taskPages.retry}>重试任务读取</button></div>}
      {taskPages.items.map((task) => <TaskChoice key={task.id} task={task} selected={selectedTaskIds.includes(task.id)}
        mainline={mainlineTaskIds.includes(task.id)} disabled={pending !== null}
        onSelect={() => toggleId(setSelectedTaskIds, selectedTaskIds, task.id)}
        onMainline={() => toggleId(setMainlineTaskIds, mainlineTaskIds, task.id)} estimate={estimates.get(task.id)}
        estimateLoadFailed={estimateError !== null}
        taskRevision={estimateTaskRevisionOverrides.get(task.id) ?? task.revision}
        onRecordEstimate={(elapsedMs, executionMs, waitingMs, reviewMs, humanMs, sourceNote) => {
          const history = estimates.get(task.id);
          const latest = history?.items[0];
          void send({ kind: "RECORD_ESTIMATE", input: { commandId: createCommandId(), taskId: task.id,
            expectedTaskRevision: estimateTaskRevisionOverrides.get(task.id) ?? task.revision,
            expectedEstimateRevision: latest?.revision ?? "0", confirmed: true,
            elapsedMs, executionMs, waitingMs, reviewMs, humanMs, sourceNote } });
        }} />)}
      {taskPages.loading && loadedTasks.length === 0 && <p role="status">正在读取项目任务…</p>}
      {taskPages.nextCursor !== null && <button className="secondary-button" type="button" disabled={taskPages.loading || taskPages.loadingMore}
        onClick={taskPages.loadMore}>{taskPages.loadingMore ? "正在读取后续任务…" : "加载更多任务"}</button>}
      {estimateError && <p className="action-error" role="alert">部分估时暂时无法读取：{estimateError}</p>}
      <h3>关联目标</h3>
      {goals.length === 0 ? <p className="helper-text">项目没有已关联目标；可以只按任务安排。</p> : goals.map((goal) => <label className="planning-check" key={goal.goalId}>
        <input type="checkbox" checked={goalIds.includes(goal.goalId)} disabled={pending !== null}
          onChange={() => toggleId(setGoalIds, goalIds, goal.goalId)} />
        <span>{goal.title}<small>{goal.status} · 目标修订 v{goal.revision}</small></span></label>)}
      <button className="primary-button" type="button" data-testid="period-plan-propose" disabled={submitting || pending !== null ||
        title.trim() === "" || selectedTaskIds.length === 0 || !Number.isSafeInteger(Number(availableMinutes)) ||
        Number(availableMinutes) < 1 || !Number.isSafeInteger(Number(diagnosticMinutes)) || Number(diagnosticMinutes) < 0}
        onClick={() => void send({ kind: "PROPOSE_PLAN", input: { commandId: createCommandId(), projectId,
          title: title.trim(), availableMs: Number(availableMinutes) * 60000, diagnosticMs: Number(diagnosticMinutes) * 60000,
          taskIds: selectedTaskIds, mainlineTaskIds: mainlineTaskIds.filter((id) => selectedTaskIds.includes(id)), goalIds } })}>
        生成计划候选</button>
    </section>

    <section className="surface-panel planning-history" aria-label="计划历史">
      <div className="planning-section-head"><h2>计划与历史</h2><button className="text-button" type="button" onClick={() => void refreshPlans()}>重新读取</button></div>
      {plans.length === 0 ? <p className="helper-text">还没有计划记录。</p> : <label className="field"><span className="field-label">选择计划版本</span>
        <select value={selectedPlanId} onChange={(event) => setSelectedPlanId(event.target.value)}>
          {plans.map((plan) => <option key={plan.planId} value={plan.planId}>{plan.title} · 修订 v{plan.revision} · {plan.expired ? "已过窗口" : "窗口有效"}</option>)}
        </select></label>}
      {selectedPlan && <PlanDetail plan={selectedPlan} simulations={simulations} selectedSimulation={selectedSimulation}
        simulationId={selectedSimulationId} setSimulationId={setSelectedSimulationId} submitting={submitting || pending !== null}
        reason={resolutionReason} setReason={setResolutionReason} scopeReason={scopeReason} setScopeReason={setScopeReason}
        keepTaskIds={keepTaskIds} setKeepTaskIds={setKeepTaskIds} deferTaskIds={deferTaskIds} setDeferTaskIds={setDeferTaskIds}
        unreliableTaskIds={unreliableTaskIds} setUnreliableTaskIds={setUnreliableTaskIds}
        onResolve={(itemId, action) => void send({ kind: "RESOLVE_ITEM", input: { commandId: createCommandId(),
          planId: selectedPlan.planId, itemId, expectedRevision: selectedPlan.revision, action, reason: resolutionReason.trim() } })}
        onProposeScope={() => void send({ kind: "PROPOSE_SCOPE", input: { commandId: createCommandId(), planId: selectedPlan.planId,
          expectedRevision: selectedPlan.revision, keepTaskIds, deferTaskIds, unreliableTaskIds } })}
        onSelectScope={(option) => selectedSimulation && void send({ kind: "SELECT_SCOPE", input: { commandId: createCommandId(),
          simulationId: selectedSimulation.simulationId, expectedRevision: selectedSimulation.revision, option,
          confirmed: true, reason: scopeReason.trim() } })} />}
      {selectedPlan?.items.some((item) => item.status === "ACCEPTED" && item.kind !== "DEFERRED") &&
        <Link className="secondary-button" to={`/projects/${encodeURIComponent(projectId)}/task-chains?from-plan=${encodeURIComponent(selectedPlan.planId)}`}>审阅已接受项并预选任务链</Link>}
    </section>
    <p className="helper-text">计划只保存范围建议与逐项处理结果。接受候选可按原应用用例创建任务；开始任务、Delegate、Run、Review 与完成继续由各自入口处理。</p>
  </main></div></section>;
}

function TaskChoice({ task, selected, mainline, disabled, onSelect, onMainline, estimate, estimateLoadFailed, taskRevision, onRecordEstimate }: {
  readonly task: RelayTaskSummary; readonly selected: boolean; readonly mainline: boolean; readonly disabled: boolean;
  readonly onSelect: () => void; readonly onMainline: () => void;
  readonly estimate?: EstimateHistory;
  readonly estimateLoadFailed: boolean; readonly taskRevision: string;
  readonly onRecordEstimate: (elapsedMs: number, executionMs: number | null, waitingMs: number | null,
    reviewMs: number | null, humanMs: number | null, sourceNote: string) => void;
}) {
  const [elapsedMinutes, setElapsedMinutes] = useState("");
  const [executionMinutes, setExecutionMinutes] = useState("");
  const [waitingMinutes, setWaitingMinutes] = useState("");
  const [reviewMinutes, setReviewMinutes] = useState("");
  const [humanMinutes, setHumanMinutes] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const elapsedMs = minutesToMilliseconds(elapsedMinutes);
  const executionMs = minutesToMilliseconds(executionMinutes);
  const waitingMs = minutesToMilliseconds(waitingMinutes);
  const reviewMs = minutesToMilliseconds(reviewMinutes);
  const humanMs = humanMinutes.trim() === "" ? null : minutesToMilliseconds(humanMinutes);
  const current = estimate?.current;
  const latest = estimate?.items[0];
  return <div className="planning-task-row" data-testid={`planning-task-${task.id}`}>
    <label className="planning-check"><input type="checkbox" checked={selected} disabled={disabled} onChange={onSelect} />
      <span>{task.title}<small>{task.status} · {task.executor} · Task 修订 v{taskRevision}</small></span></label>
    <label className="planning-check planning-mainline"><input type="checkbox" checked={mainline} disabled={disabled || !selected}
      onChange={onMainline} /><span>主线</span></label>
    <div className="planning-estimate" aria-label={`${task.title} 的用户估时`}>
      {current ? <p>{current.applicable ? "当前验收适用" : `旧估时失效：来自验收 v${current.acceptanceRevision}（当前验收不适用）`} · {estimateBreakdown(current)} · {current.sourceKind} · {current.sourceNote}</p>
        : estimateLoadFailed ? <p>估时读取失败；当前估时未知，不能按 0 分钟计算。</p>
          : <p>{latest ? `最近一条用户声明估时来自验收 v${latest.acceptanceRevision}，当前版本不适用。` : "无用户声明估时；未知不会按 0 分钟计算。"}</p>}
      {estimate && estimate.items.length > 0 && <details><summary>查看估时历史（{estimate.items.length} 条）</summary><ul>
        {estimate.items.map((item) => <li key={item.id}>估时 v{item.revision} · 验收 v{item.acceptanceRevision} · {estimateBreakdown(item)} · {item.sourceKind} · {item.sourceNote}</li>)}
      </ul></details>}
      <details className="planning-estimate-editor"><summary>录入或更新估时</summary>
        <label>总时长（分钟）<input type="number" min="0" step="1" value={elapsedMinutes} disabled={disabled}
          onChange={(event) => setElapsedMinutes(event.target.value)} /></label>
        <label>执行时长（分钟，可留空）<input type="number" min="0" step="1" value={executionMinutes} disabled={disabled}
          onChange={(event) => setExecutionMinutes(event.target.value)} /></label>
        <label>等待时长（分钟，可留空）<input type="number" min="0" step="1" value={waitingMinutes} disabled={disabled}
          onChange={(event) => setWaitingMinutes(event.target.value)} /></label>
        <label>复核时长（分钟，可留空）<input type="number" min="0" step="1" value={reviewMinutes} disabled={disabled}
          onChange={(event) => setReviewMinutes(event.target.value)} /></label>
        <label>人工投入（分钟，可留空）<input type="number" min="0" step="1" value={humanMinutes} disabled={disabled}
          onChange={(event) => setHumanMinutes(event.target.value)} /></label>
        <label>来源说明<input value={sourceNote} maxLength={4000} disabled={disabled}
          onChange={(event) => setSourceNote(event.target.value)} /></label>
        <button type="button" className="secondary-button" disabled={disabled || elapsedMs === null ||
          (executionMinutes.trim() !== "" && executionMs === null) || (waitingMinutes.trim() !== "" && waitingMs === null) ||
          (reviewMinutes.trim() !== "" && reviewMs === null) || (humanMinutes.trim() !== "" && humanMs === null) || sourceNote.trim() === ""}
          onClick={() => onRecordEstimate(elapsedMs!, executionMs, waitingMs, reviewMs, humanMs, sourceNote.trim())}>保存用户声明估时</button>
        <small>使用 Task v{taskRevision} 和最近估时修订 v{latest?.revision ?? "0"}；录入后会读回历史与当前适用状态。</small>
      </details>
    </div>
  </div>;
}

function estimateBreakdown(estimate: { readonly elapsedMs: string | null; readonly executionMs: string | null;
  readonly waitingMs: string | null; readonly reviewMs: string | null; readonly humanMs: string | null }) {
  return `总时长 ${formatEstimate(estimate.elapsedMs)} · 执行 ${formatEstimate(estimate.executionMs)} · 等待 ${formatEstimate(estimate.waitingMs)} · 复核 ${formatEstimate(estimate.reviewMs)} · 人工 ${formatEstimate(estimate.humanMs)}`;
}

function PlanDetail({ plan, simulations, selectedSimulation, simulationId, setSimulationId, submitting,
  reason, setReason, scopeReason, setScopeReason, keepTaskIds, setKeepTaskIds, deferTaskIds, setDeferTaskIds,
  unreliableTaskIds, setUnreliableTaskIds, onResolve, onProposeScope, onSelectScope }: {
  readonly plan: RelayPeriodPlan; readonly simulations: readonly RelayScopeSimulation[];
  readonly selectedSimulation: RelayScopeSimulation | null; readonly simulationId: string; readonly setSimulationId: (id: string) => void;
  readonly submitting: boolean; readonly reason: string; readonly setReason: (value: string) => void;
  readonly scopeReason: string; readonly setScopeReason: (value: string) => void;
  readonly keepTaskIds: readonly string[]; readonly setKeepTaskIds: (ids: readonly string[]) => void;
  readonly deferTaskIds: readonly string[]; readonly setDeferTaskIds: (ids: readonly string[]) => void;
  readonly unreliableTaskIds: readonly string[]; readonly setUnreliableTaskIds: (ids: readonly string[]) => void;
  readonly onResolve: (itemId: string, action: "ACCEPT" | "REJECT") => void; readonly onProposeScope: () => void;
  readonly onSelectScope: (option: RelayScopeOptionKind) => void;
}) {
  const baselineTasks = Array.isArray(plan.baseline.tasks) ? plan.baseline.tasks as unknown as readonly Record<string, unknown>[] : [];
  const scopeReady = plan.staleReasons.length === 0 && !plan.expired && plan.items.every((item) => item.status === "CANDIDATE") && plan.items.length > 1;
  return <div className="planning-detail" data-testid="period-plan-detail">
    <div className="planning-facts"><span>修订 v{plan.revision}</span><span>{new Date(plan.startedAt).toLocaleString()} → {new Date(plan.endsAt).toLocaleString()}</span>
      <span>可用 {formatMinutes(Number(plan.availableMs))} · 当前剩余 {formatMinutes(Number(plan.remainingMs))}</span>
      <span>{plan.expired ? "窗口已结束" : "窗口有效"}</span></div>
    <p className="planning-boundary">接受计划不授权执行 · Run 准入未授予 · 每项接受都要独立处理</p>
    {plan.timeWarning && <p className="action-error" role="status">按当前剩余窗口估算可能超时。</p>}
    {plan.staleReasons.length > 0 && <p className="action-error" role="alert">基线已变化：{plan.staleReasons.join("、")}。此版本保留只读；不能继续用它推演或应用。</p>}
    <h3>计划项</h3>
    <ul className="planning-items">{plan.items.map((item) => <li key={item.id} data-testid={`period-plan-item-${item.id}`}>
      <div><strong>{item.title}</strong><span className="planning-status">{statusText[item.status] ?? item.status} · {statusText[item.kind] ?? item.kind}</span></div>
      <p>{reasonText[item.reason] ?? item.reason} · 预算 {formatMinutes(item.budgetMs)} · 人工 {formatMinutes(item.humanMs)}</p>
      {item.dependsOnTaskIds.length > 0 && <p className="helper-text">必要前置：{item.dependsOnTaskIds.join(", ")}</p>}
      {item.resolutionReason && <p className="helper-text">处理理由：{item.resolutionReason}</p>}
      {item.createdTaskId && <p><Link to={`/tasks/${encodeURIComponent(item.createdTaskId)}`}>查看已创建任务</Link></p>}
      {item.status === "CANDIDATE" && <div className="planning-item-actions">
        {item.kind !== "DEFERRED" && <button className="secondary-button" type="button" disabled={submitting || reason.trim() === ""}
          onClick={() => onResolve(item.id, "ACCEPT")}>接受此项</button>}
        <button className="text-button" type="button" disabled={submitting || reason.trim() === ""}
          onClick={() => onResolve(item.id, "REJECT")}>拒绝此项</button></div>}
    </li>)}</ul>
    {plan.items.some((item) => item.status === "CANDIDATE" && item.kind !== "DEFERRED") && <label className="field">
      <span className="field-label">逐项处理理由</span><input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={4000}
        placeholder="说明接受或拒绝的依据" /></label>}
    <details className="planning-baseline"><summary>查看冻结来源（{baselineTasks.length} 项任务）</summary>
      <p>创建时间、目标关联、Task 修订、验收修订、估时修订和阻塞事实来自本计划固定基线。</p>
      <ul>{baselineTasks.map((task) => <li key={String(task.task_id)}>{String(task.title)} · Task v{String(task.revision)} · 验收 v{String(task.acceptance_revision)} · 估时 v{String(task.estimate_revision)}
        {task.elapsed_ms === null ? " · 估时未知" : ` · 用户估时 ${formatMinutes(Number(task.elapsed_ms))}`}</li>)}</ul>
    </details>

    <section className="planning-scope" aria-label="固定容量范围推演">
      <h3>比较范围</h3><p className="helper-text">三种方案共用原计划容量和冻结估时来源。推演只生成新的计划候选，不修改现有 Task。</p>
      {!scopeReady && <p className="helper-text">仅在窗口有效、基线未变化且原计划项尚未应用时可发起范围推演；至少需要两项计划任务。</p>}
      {baselineTasks.map((task) => {
        const taskId = String(task.task_id); const taskTitle = String(task.title);
        return <div className="planning-scope-row" key={taskId}><strong>{taskTitle}</strong>
          <label className="planning-check"><input type="checkbox" checked={keepTaskIds.includes(taskId)} disabled={!scopeReady || submitting}
            onChange={() => setKeepTaskIds(keepTaskIds.includes(taskId) ? keepTaskIds.filter((id) => id !== taskId) : [...keepTaskIds, taskId])} />保留/主线</label>
          <label className="planning-check"><input type="checkbox" checked={deferTaskIds.includes(taskId)} disabled={!scopeReady || submitting}
            onChange={() => setDeferTaskIds(deferTaskIds.includes(taskId) ? deferTaskIds.filter((id) => id !== taskId) : [...deferTaskIds, taskId])} />明确延后</label>
          <label className="planning-check"><input type="checkbox" checked={unreliableTaskIds.includes(taskId)} disabled={!scopeReady || submitting}
            onChange={() => setUnreliableTaskIds(unreliableTaskIds.includes(taskId) ? unreliableTaskIds.filter((id) => id !== taskId) : [...unreliableTaskIds, taskId])} />估时不可靠</label>
          <span className="helper-text">{task.elapsed_ms === null ? "未知估时" : `估时 ${formatMinutes(Number(task.elapsed_ms))}`}</span>
        </div>;
      })}
      <button className="secondary-button" type="button" disabled={!scopeReady || submitting || keepTaskIds.length === 0 || deferTaskIds.length === 0}
        onClick={onProposeScope}>生成 ALL / SHRINK / DEFER 推演</button>
      {simulations.length > 0 && <label className="field"><span className="field-label">既有推演</span><select value={simulationId} onChange={(event) => setSimulationId(event.target.value)}>
        {simulations.map((simulation) => <option key={simulation.simulationId} value={simulation.simulationId}>{simulation.status === "SELECTED" ? "已选定" : "待选择"} · v{simulation.revision}</option>)}
      </select></label>}
      {selectedSimulation && <ScopeOptions simulation={selectedSimulation} submitting={submitting} reason={scopeReason} setReason={setScopeReason} onSelect={onSelectScope} />}
    </section>
  </div>;
}

function ScopeOptions({ simulation, submitting, reason, setReason, onSelect }: { readonly simulation: RelayScopeSimulation;
  readonly submitting: boolean; readonly reason: string; readonly setReason: (value: string) => void;
  readonly onSelect: (kind: RelayScopeOptionKind) => void }) {
  const names: readonly RelayScopeOptionKind[] = ["ALL", "SHRINK", "DEFER"];
  const stale = simulation.staleReasons.length > 0;
  return <div className="planning-simulation" data-testid="scope-simulation">
    <p className="planning-boundary">推演修订 v{simulation.revision} · 准入未授予 · 不承诺完成日期</p>
    {stale && <p className="action-error" role="alert">原计划已变化，不能继续选择：{simulation.staleReasons.join("、")}</p>}
    <div className="planning-options">{names.map((kind) => {
      const option: RelayScopeOption | undefined = simulation.options.find((item) => item.kind === kind);
      if (!option) return null;
      return <section className="planning-option" key={kind} data-testid={`scope-option-${kind}`}>
        <h4>{optionTitle(kind)}</h4><p>{option.feasibility} · 计划 {formatMinutes(option.plannedMs)} · 请求估时 {formatMinutes(option.requestedElapsedMs)} · 容量缺口 {formatMinutes(option.capacityGapMs)}</p>
        {option.unknownEstimateTaskIds.length > 0 && <p>未知估时：{option.unknownEstimateTaskIds.join(", ")}</p>}
        {option.unreliableTaskIds.length > 0 && <p>标记不可靠：{option.unreliableTaskIds.join(", ")}</p>}
        <ul>{option.items.map((item) => <li key={item.id}>{item.title} · {statusText[item.kind] ?? item.kind} · {reasonText[item.reason] ?? item.reason}</li>)}</ul>
        {option.consequences.map((consequence, index) => <p key={index}>影响：{String(consequence.title ?? consequence.task_id)} · {String(consequence.reason)}
          {Array.isArray(consequence.affected_dependent_task_ids) && consequence.affected_dependent_task_ids.length > 0
            ? ` · 受影响后续：${consequence.affected_dependent_task_ids.join(", ")}` : ""}</p>)}
        <button className="secondary-button" type="button" disabled={stale || simulation.status !== "PROPOSED" || submitting || reason.trim() === ""}
          onClick={() => onSelect(kind)}>选择为新计划候选</button>
      </section>;
    })}</div>
    {simulation.status === "PROPOSED" && <label className="field"><span className="field-label">选择理由</span>
      <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={4000} placeholder="说明为什么采用此范围" /></label>}
    {simulation.selectedPlan && <p className="receipt-message" role="status">方案已成为新计划候选（{simulation.selectedOption}）。请在上方逐项接受或拒绝；没有启动 Run。</p>}
  </div>;
}
