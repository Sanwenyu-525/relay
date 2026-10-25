import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayApiClient, RelayApiError, type RelayPeriodPlan, type RelayProjectState, type RelayScopeSimulation, type RelayTaskChain,
  type RelayTaskDetail, type RelayTaskSummary } from "../src/api/relayClient";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const projectId = "22222222-2222-4222-8222-222222222222";
const taskId = "55555555-5555-4555-8555-555555555555";
const task2Id = "77777777-7777-4777-8777-777777777777";
const task: RelayTaskSummary = { id: taskId, projectId, title: "整理阶段交付", status: "READY", mode: "ME",
  revision: "4", executor: "HUMAN", executorRunId: null, currentCompletionId: null, waitingReason: null,
  blockingTaskIds: [], unresolvedBlockerIds: [], allowedActions: ["START"], updatedAt: "2026-10-24T00:00:00Z" };
const detail: RelayTaskDetail = { ...task, acceptance: { acceptanceRevision: "2", objective: "交付已审阅的项目成果",
  expectedOutputs: { artifacts: ["MARKDOWN_DOCUMENT"] }, source: "USER_DECLARED",
  criteria: [{ criterionId: "human", statement: "人工核对当前产物", required: true, method: "HUMAN", targetSpec: null }] }, dependencies: [] };

afterEach(() => {
  resetRelayConnectionForTest(); vi.restoreAllMocks(); sessionStorage.clear();
});

function connect() {
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId: "11111111-1111-4111-8111-111111111111",
    bearerToken: "test-token" });
}
function project() {
  return { id: projectId, title: "真实项目", projectType: "GENERAL", revision: "1", stateRevision: "1", archivedAt: null };
}
function projectState(): RelayProjectState {
  return { projectId, revision: "0", phaseKey: "DISCOVERY", nextActionTaskId: null, inProgress: [], blockers: [],
    risks: [], selectedArtifactVersionRefs: [], completedHighlightRefs: [], allowedActions: [] };
}
function chain(status: string) {
  return { chainId: "chain-1", projectId, status, revision: "1", title: "有限任务链",
    baseline: { tool_scope: "INTERNAL_MARKDOWN_ARTIFACTS_ONLY" }, maxTasks: 0, maxModelCalls: 0,
    taskReservations: 0, callsStarted: 0, expiresAt: null as string | null, reason: null, controlRequestId: null,
    authorizationHistory: [], items: [{ item_id: "item-1", ordinal: 0, task_id: taskId, status: "READY",
      baseline: { title: task.title }, execution_spec: {}, task_revision: "4", acceptance_revision: "2",
      run_id: null, completion_id: null, current_task_status: "READY", current_run_status: null }],
    modelUsage: { recorded_calls: 0, uncertain_calls: 0, known_input_tokens: null, known_output_tokens: null,
      total_tokens: null, monetary_cost: null } };
}
function check(element: Element) {
  return (element as HTMLInputElement).checked;
}

function twoTaskPlan(): RelayPeriodPlan {
  const tasks = [{ ...task, id: taskId, title: "主线工作" }, { ...task, id: task2Id, title: "独立工作" }];
  return { planId: "plan-scope", projectId, revision: "3", itemId: null, itemStatus: null, createdTaskId: null,
    title: "下一段工作", availableMs: "14400000", startedAt: "2026-10-25T00:00:00Z", endsAt: "2026-10-25T04:00:00Z",
    remainingMs: "14400000", expired: false, timeWarning: null, staleReasons: [],
    baseline: { tasks: tasks.map((row) => ({ task_id: row.id, title: row.title, revision: "4", acceptance_revision: "2",
      estimate_revision: "1", elapsed_ms: 3600000 })) },
    items: tasks.map((row, index) => ({ id: `item-${index + 1}`, taskId: row.id, title: row.title, kind: "TASK" as const,
      status: "CANDIDATE" as const, reason: "REMAINING_CAPACITY", budgetMs: 3600000, humanMs: 1200000,
      dependsOnTaskIds: [], createdTaskId: null, resolutionReason: null, output: null })),
    executionAdmission: "NOT_GRANTED", permissionGaps: "CHECK_AT_EXECUTION", humanIntervention: "SEE_BLOCKERS_AND_TASK_ACCEPTANCE" };
}

function scopeSimulation(): RelayScopeSimulation {
  const option = (kind: "ALL" | "SHRINK" | "DEFER") => ({ kind, taskIds: [taskId], retainedPrerequisiteIds: [],
    excludedTaskIds: [task2Id], requestedElapsedMs: 3600000, requestedHumanMs: 1200000, plannedMs: 3600000,
    capacityGapMs: null, unknownEstimateTaskIds: [], unreliableTaskIds: [], feasibility: "WITHIN_CAPACITY",
    items: [{ id: `scope-${kind.toLowerCase()}`, taskId, title: "主线工作", kind: "TASK" as const, status: "CANDIDATE" as const,
      reason: "MAINLINE_OR_PREREQUISITE", budgetMs: 3600000, humanMs: 1200000, dependsOnTaskIds: [],
      createdTaskId: null, resolutionReason: null, output: null }], consequences: [] });
  return { simulationId: "simulation-1", sourcePlanId: "plan-scope", projectId, revision: "1", status: "PROPOSED",
    selectedOption: null, selectedPlanId: null, baseline: {}, options: [option("ALL"), option("SHRINK"), option("DEFER")],
    createdAt: "2026-10-25T00:00:00Z", selectionReason: null, staleReasons: [], selectedPlan: null,
    executionAdmission: "NOT_GRANTED", permissionGaps: "CHECK_AT_EXECUTION", materialGaps: "CHECK_AT_EXECUTION", completionDate: null };
}

describe("项目计划与有限任务链页面", () => {
  it("计划只创建候选并携带所选任务与主线，不启动 Run", async () => {
    connect();
    const propose = vi.spyOn(RelayApiClient.prototype, "proposePeriodPlan").mockResolvedValue({
      planId: "plan-1", projectId, revision: "1", itemId: null, itemStatus: null, createdTaskId: null });
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue(projectState());
    vi.spyOn(RelayApiClient.prototype, "getProjectGoals").mockResolvedValue([]);
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task], nextCursor: null });
    const savedPlan = { ...twoTaskPlan(), planId: "plan-1", revision: "1", items: [twoTaskPlan().items[0]!] };
    vi.spyOn(RelayApiClient.prototype, "getProjectPeriodPlans").mockResolvedValueOnce({ projectId, items: [] })
      .mockResolvedValue({ projectId, items: [savedPlan] });
    vi.spyOn(RelayApiClient.prototype, "getPeriodPlan").mockResolvedValue(savedPlan);
    vi.spyOn(RelayApiClient.prototype, "getTaskTimeEstimates").mockResolvedValue({ taskId, current: {
      id: "estimate-1", taskId, revision: "1", acceptanceRevision: "2", elapsedMs: "3600000", executionMs: null,
      waitingMs: null, reviewMs: null, humanMs: "1200000", sourceNote: "用户复盘声明", sourceKind: "USER_DECLARED",
      createdAt: "2026-10-24T00:00:00Z", applicable: true }, items: [] });
    const start = vi.spyOn(RelayApiClient.prototype, "startHumanTask");
    const delegate = vi.spyOn(RelayApiClient.prototype, "delegateTask");
    const mounted = await mountWorkbench(`/projects/${projectId}/planning`);
    try {
      await flush();
      await mounted.wrapper.get(`[data-testid="planning-task-${taskId}"] input[type="checkbox"]`).setValue(true);
      await mounted.wrapper.get(`[data-testid="planning-task-${taskId}"] .planning-mainline input[type="checkbox"]`).setValue(true);
      await mounted.wrapper.get('[data-testid="period-plan-propose"]').trigger("click");
      await flush();
      expect(propose).toHaveBeenCalledTimes(1);
      expect(propose.mock.calls[0]![0]).toMatchObject({ projectId, taskIds: [taskId], mainlineTaskIds: [taskId], goalIds: [] });
      expect(propose.mock.calls[0]![0].availableMs).toBe(240 * 60000);
      expect(start).not.toHaveBeenCalled();
      expect(delegate).not.toHaveBeenCalled();
      expect(mounted.wrapper.text()).toContain("接受计划只处理计划项，不授权执行");
    } finally { mounted.unmount(); }
  });

  it("计划提交成功但详情暂时 404 时保留原命令，回执恢复后选择确切计划", async () => {
    connect();
    const savedPlan = { ...twoTaskPlan(), planId: "plan-recovered", revision: "1", items: [twoTaskPlan().items[0]!] };
    let planVisible = false;
    let commandId = "";
    let receiptCount = 0;
    const propose = vi.spyOn(RelayApiClient.prototype, "proposePeriodPlan").mockImplementation(async (input) => {
      commandId = input.commandId;
      return { planId: savedPlan.planId, projectId, revision: savedPlan.revision, itemId: null, itemStatus: null, createdTaskId: null };
    });
    const readPlan = vi.spyOn(RelayApiClient.prototype, "getPeriodPlan").mockImplementation(async () => {
      if (!planVisible) throw new RelayApiError({ status: 404, code: "NOT_FOUND", detail: "plan read unavailable",
        retryable: false, retryAction: "NONE", fieldErrors: [], expectedRevision: null, actualRevision: null });
      return savedPlan;
    });
    const readPlans = vi.spyOn(RelayApiClient.prototype, "getProjectPeriodPlans").mockImplementation(async () => ({
      projectId, items: planVisible ? [savedPlan] : [] }));
    const receipt = vi.spyOn(RelayApiClient.prototype, "getCommandReceipt").mockImplementation(async (id) => {
      receiptCount++;
      expect(id).toBe(commandId);
      planVisible = true;
      return { commandId: id, commandType: "ProposePeriodPlan", committedAt: "2026-10-25T00:00:00Z",
        result: { plan_id: savedPlan.planId, project_id: receiptCount === 1 ? "wrong-project" : projectId, revision: savedPlan.revision } };
    });
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue(projectState());
    vi.spyOn(RelayApiClient.prototype, "getProjectGoals").mockResolvedValue([]);
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task], nextCursor: null });
    vi.spyOn(RelayApiClient.prototype, "getTaskTimeEstimates").mockResolvedValue({ taskId, current: null, items: [] });
    const mounted = await mountWorkbench(`/projects/${projectId}/planning`);
    try {
      await flush();
      await mounted.wrapper.get(`[data-testid="planning-task-${taskId}"] input[type="checkbox"]`).setValue(true);
      await mounted.wrapper.get('[data-testid="period-plan-propose"]').trigger("click"); await flush();
      expect(propose).toHaveBeenCalledTimes(1);
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(true);
      expect(mounted.wrapper.text()).toContain("命令已响应但读回仍待核对，原 ID 与载荷已保留");
      await mounted.wrapper.get('[data-testid="planning-pending-command"] button').trigger("click"); await flush();
      expect(receipt).toHaveBeenCalledTimes(1);
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(true);
      expect(mounted.wrapper.text()).toContain("计划回执项目身份不匹配");
      await mounted.wrapper.get('[data-testid="planning-pending-command"] button').trigger("click"); await flush();
      expect(receipt).toHaveBeenCalledTimes(2);
      expect(readPlan).toHaveBeenCalledTimes(2);
      expect(readPlans).toHaveBeenCalled();
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(false);
      expect((mounted.wrapper.get(".planning-history select").element as HTMLSelectElement).value).toBe(savedPlan.planId);
      expect(mounted.wrapper.get(".receipt-message").text()).toContain("已读回并选中对应计划");
    } finally { mounted.unmount(); }
  });

  it("手动估时按分钟换算毫秒并读回 USER_DECLARED 历史与适用状态", async () => {
    connect();
    const estimateItem = { id: "estimate-1", taskId, revision: "1", acceptanceRevision: "2", elapsedMs: "720000",
      executionMs: "120000", waitingMs: "60000", reviewMs: "60000", humanMs: "180000", sourceNote: "基于最近三次复盘",
      sourceKind: "USER_DECLARED" as const, createdAt: "2026-10-25T00:00:00Z" };
    let history: Awaited<ReturnType<RelayApiClient["getTaskTimeEstimates"]>> = { taskId, current: null, items: [] };
    const record = vi.spyOn(RelayApiClient.prototype, "recordTaskTimeEstimate").mockImplementation(async (input) => {
      expect(input).toMatchObject({ taskId, expectedTaskRevision: "4", expectedEstimateRevision: "0", confirmed: true,
        elapsedMs: 720000, executionMs: 120000, waitingMs: 60000, reviewMs: 60000, humanMs: 180000,
        sourceNote: "基于最近三次复盘" });
      history = { taskId, current: { ...estimateItem, applicable: true }, items: [estimateItem] };
      return { taskId, estimateId: estimateItem.id, revision: estimateItem.revision };
    });
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue(projectState());
    vi.spyOn(RelayApiClient.prototype, "getProjectGoals").mockResolvedValue([]);
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task], nextCursor: null });
    vi.spyOn(RelayApiClient.prototype, "getProjectPeriodPlans").mockResolvedValue({ projectId, items: [] });
    vi.spyOn(RelayApiClient.prototype, "getTaskTimeEstimates").mockImplementation(async () => history);
    const mounted = await mountWorkbench(`/projects/${projectId}/planning`);
    try {
      await flush();
      const editor = mounted.wrapper.get(`[data-testid="planning-task-${taskId}"] .planning-estimate-editor`);
      await editor.find("summary").trigger("click");
      const inputs = editor.findAll("input");
      await inputs[0]!.setValue("12"); await inputs[1]!.setValue("2"); await inputs[2]!.setValue("1");
      await inputs[3]!.setValue("1"); await inputs[4]!.setValue("3"); await inputs[5]!.setValue("基于最近三次复盘");
      await editor.get("button").trigger("click"); await flush();
      expect(record).toHaveBeenCalledTimes(1);
      expect(mounted.wrapper.get(`[data-testid="planning-task-${taskId}"] .planning-estimate`).text())
        .toContain("当前验收适用 · 总时长 12 分钟 · 执行 2 分钟 · 等待 1 分钟 · 复核 1 分钟 · 人工 3 分钟 · USER_DECLARED");
      expect(mounted.wrapper.get(".receipt-message").text()).toContain("适用于当前验收版本");
    } finally { mounted.unmount(); }
  });

  it("估时 CAS 冲突不重复写入，并刷新当前 Task 与估时修订", async () => {
    connect();
    const latest = { id: "estimate-2", taskId, revision: "2", acceptanceRevision: "2", elapsedMs: "900000",
      executionMs: null, waitingMs: null, reviewMs: null, humanMs: null, sourceNote: "刚更新的估时",
      sourceKind: "USER_DECLARED" as const, createdAt: "2026-10-25T00:00:00Z" };
    const record = vi.spyOn(RelayApiClient.prototype, "recordTaskTimeEstimate").mockRejectedValue(new RelayApiError({
      status: 409, code: "REVISION_CONFLICT", detail: "task or estimate revision changed", retryable: false,
      retryAction: "NONE", fieldErrors: [], expectedRevision: null, actualRevision: null }));
    const readEstimates = vi.spyOn(RelayApiClient.prototype, "getTaskTimeEstimates")
      .mockResolvedValueOnce({ taskId, current: null, items: [] })
      .mockResolvedValue({ taskId, current: { ...latest, applicable: true }, items: [latest] });
    vi.spyOn(RelayApiClient.prototype, "getTask").mockResolvedValue({ ...detail, revision: "5" });
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue(projectState());
    vi.spyOn(RelayApiClient.prototype, "getProjectGoals").mockResolvedValue([]);
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task], nextCursor: null });
    vi.spyOn(RelayApiClient.prototype, "getProjectPeriodPlans").mockResolvedValue({ projectId, items: [] });
    const mounted = await mountWorkbench(`/projects/${projectId}/planning`);
    try {
      await flush();
      const editor = mounted.wrapper.get(`[data-testid="planning-task-${taskId}"] .planning-estimate-editor`);
      await editor.find("summary").trigger("click");
      const inputs = editor.findAll("input");
      await inputs[0]!.setValue("12"); await inputs[5]!.setValue("基于新进展重新估算");
      await editor.get("button").trigger("click"); await flush();
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]![0]).toMatchObject({ expectedTaskRevision: "4", expectedEstimateRevision: "0" });
      expect(readEstimates).toHaveBeenCalledTimes(2);
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(false);
      expect(mounted.wrapper.get(`[data-testid="planning-task-${taskId}"]`).text()).toContain("Task 修订 v5");
      expect(mounted.wrapper.get(`[data-testid="planning-task-${taskId}"] .planning-estimate-editor small`).text())
        .toContain("Task v5 和最近估时修订 v2");
      expect(mounted.wrapper.get(`[data-testid="planning-task-${taskId}"] .planning-estimate`).text()).toContain("当前验收适用");
      expect(mounted.wrapper.text()).toContain("命令被服务端拒绝");
    } finally { mounted.unmount(); }
  });

  it("旧估时仍保留历史并明确标为不适用于当前验收", async () => {
    connect();
    const old = { id: "estimate-old", taskId, revision: "1", acceptanceRevision: "1", elapsedMs: "600000",
      executionMs: null, waitingMs: "120000", reviewMs: null, humanMs: null, sourceNote: "旧验收阶段复盘",
      sourceKind: "USER_DECLARED" as const, createdAt: "2026-10-20T00:00:00Z" };
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue(projectState());
    vi.spyOn(RelayApiClient.prototype, "getProjectGoals").mockResolvedValue([]);
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task], nextCursor: null });
    vi.spyOn(RelayApiClient.prototype, "getProjectPeriodPlans").mockResolvedValue({ projectId, items: [] });
    vi.spyOn(RelayApiClient.prototype, "getTaskTimeEstimates").mockResolvedValue({ taskId,
      current: { ...old, applicable: false }, items: [old] });
    const mounted = await mountWorkbench(`/projects/${projectId}/planning`);
    try {
      await flush();
      const estimate = mounted.wrapper.get(`[data-testid="planning-task-${taskId}"] .planning-estimate`);
      expect(estimate.text()).toContain("旧估时失效：来自验收 v1");
      expect(estimate.text()).toContain("当前验收不适用");
      await estimate.find("summary").trigger("click");
      expect(estimate.text()).toContain("查看估时历史（1 条）");
      expect(estimate.text()).toContain("旧验收阶段复盘");
    } finally { mounted.unmount(); }
  });

  it("估时响应未知时保留原命令并通过原回执读回，不生成第二个命令", async () => {
    connect();
    const estimateItem = { id: "estimate-recovered", taskId, revision: "1", acceptanceRevision: "2", elapsedMs: "600000",
      executionMs: "120000", waitingMs: null, reviewMs: "60000", humanMs: null, sourceNote: "复盘估时",
      sourceKind: "USER_DECLARED" as const, createdAt: "2026-10-25T00:00:00Z" };
    let commandId = "";
    let history: Awaited<ReturnType<RelayApiClient["getTaskTimeEstimates"]>> = { taskId, current: null, items: [] };
    const record = vi.spyOn(RelayApiClient.prototype, "recordTaskTimeEstimate").mockImplementation(async (input) => {
      commandId = input.commandId;
      throw new Error("connection lost after submit");
    });
    const receipt = vi.spyOn(RelayApiClient.prototype, "getCommandReceipt").mockImplementation(async (id) => {
      expect(id).toBe(commandId);
      history = { taskId, current: { ...estimateItem, applicable: true }, items: [estimateItem] };
      return { commandId, commandType: "RecordTaskTimeEstimate", committedAt: "2026-10-25T00:00:00Z",
        result: { task_id: taskId, estimate_id: estimateItem.id, revision: estimateItem.revision } };
    });
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue(projectState());
    vi.spyOn(RelayApiClient.prototype, "getProjectGoals").mockResolvedValue([]);
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task], nextCursor: null });
    vi.spyOn(RelayApiClient.prototype, "getProjectPeriodPlans").mockResolvedValue({ projectId, items: [] });
    vi.spyOn(RelayApiClient.prototype, "getTaskTimeEstimates").mockImplementation(async () => history);
    const mounted = await mountWorkbench(`/projects/${projectId}/planning`);
    try {
      await flush();
      const editor = mounted.wrapper.get(`[data-testid="planning-task-${taskId}"] .planning-estimate-editor`);
      await editor.find("summary").trigger("click");
      const inputs = editor.findAll("input");
      await inputs[0]!.setValue("10"); await inputs[1]!.setValue("2"); await inputs[3]!.setValue("1");
      await inputs[5]!.setValue("复盘估时");
      await editor.get("button").trigger("click"); await flush();
      expect(commandId).not.toBe("");
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(true);
      await mounted.wrapper.get('[data-testid="planning-pending-command"] button').trigger("click"); await flush();
      expect(receipt).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledTimes(1);
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(false);
      expect(mounted.wrapper.text()).toContain("已使用原回执恢复，没有重新提交");
    } finally { mounted.unmount(); }
  });

  it("范围推演成功后重读原计划推演，并允许明确选择新候选", async () => {
    connect();
    let simulation = scopeSimulation();
    let activePlan: RelayPeriodPlan = twoTaskPlan();
    let activePlans: readonly RelayPeriodPlan[] = [activePlan];
    const readSimulations = vi.spyOn(RelayApiClient.prototype, "getPlanScopeSimulations")
      .mockImplementation(async () => ({ sourcePlanId: "plan-scope", items: [simulation] }));
    vi.spyOn(RelayApiClient.prototype, "getScopeSimulation").mockImplementation(async () => simulation);
    vi.spyOn(RelayApiClient.prototype, "getPeriodPlan").mockImplementation(async (id) => ({ ...activePlan, planId: id }));
    const proposeScope = vi.spyOn(RelayApiClient.prototype, "proposeScopeSimulation").mockResolvedValue({
      simulationId: simulation.simulationId, sourcePlanId: "plan-scope", projectId, revision: "1", status: "PROPOSED",
      selectedOption: null, selectedPlanId: null });
    const selectScope = vi.spyOn(RelayApiClient.prototype, "selectScopeSimulation").mockImplementation(async () => {
      simulation = { ...simulation, revision: "2", status: "SELECTED", selectedOption: "SHRINK", selectedPlanId: "plan-selected" };
      activePlan = { ...twoTaskPlan(), planId: "plan-selected" };
      activePlans = [activePlan];
      return { simulationId: simulation.simulationId, sourcePlanId: "plan-scope", projectId, revision: "2", status: "SELECTED",
        selectedOption: "SHRINK", selectedPlanId: "plan-selected" };
    });
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue(projectState());
    vi.spyOn(RelayApiClient.prototype, "getProjectGoals").mockResolvedValue([]);
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task, { ...task, id: task2Id, title: "独立工作" }], nextCursor: null });
    vi.spyOn(RelayApiClient.prototype, "getProjectPeriodPlans").mockImplementation(async () => ({ projectId, items: [...activePlans] }));
    vi.spyOn(RelayApiClient.prototype, "getTaskTimeEstimates").mockImplementation(async (id) => ({ taskId: id, current: null, items: [] }));
    const mounted = await mountWorkbench(`/projects/${projectId}/planning`);
    try {
      await flush();
      const scopeRows = mounted.wrapper.findAll(".planning-scope-row");
      expect(scopeRows).toHaveLength(2);
      await scopeRows[0]!.findAll('input[type="checkbox"]')[0]!.setValue(true);
      await scopeRows[1]!.findAll('input[type="checkbox"]')[1]!.setValue(true);
      await mounted.wrapper.get(".planning-scope button").trigger("click");
      await flush();
      expect(proposeScope.mock.calls[0]![0]).toMatchObject({ planId: "plan-scope", keepTaskIds: [taskId], deferTaskIds: [task2Id] });
      expect(readSimulations).toHaveBeenCalledTimes(2);
      expect(mounted.wrapper.get('[data-testid="scope-simulation"]').text()).toContain("全部候选");
      expect(mounted.wrapper.get('[data-testid="scope-simulation"]').text()).toContain("保留主线与必要前置");
      await mounted.wrapper.get('.planning-simulation input[placeholder="说明为什么采用此范围"]').setValue("保留当前主线");
      await mounted.wrapper.get('[data-testid="scope-option-SHRINK"] button').trigger("click");
      await flush();
      expect(selectScope.mock.calls[0]![0]).toMatchObject({ simulationId: "simulation-1", option: "SHRINK", confirmed: true, reason: "保留当前主线" });
    } finally { mounted.unmount(); }
  });

  it("PROPOSE_SCOPE 回执项目错配时保留原命令，核对后选中新推演", async () => {
    connect();
    const activePlan = twoTaskPlan();
    const existing = scopeSimulation();
    const created = { ...scopeSimulation(), simulationId: "simulation-new" };
    let simulations = [existing];
    let commandId = "";
    let receiptCount = 0;
    const propose = vi.spyOn(RelayApiClient.prototype, "proposeScopeSimulation").mockImplementation(async (input) => {
      commandId = input.commandId; simulations = [existing, created]; throw new Error("response lost");
    });
    const readSimulation = vi.spyOn(RelayApiClient.prototype, "getScopeSimulation")
      .mockImplementation(async (id) => simulations.find((item) => item.simulationId === id)!);
    vi.spyOn(RelayApiClient.prototype, "getPlanScopeSimulations").mockImplementation(async () => ({ sourcePlanId: "plan-scope", items: simulations }));
    vi.spyOn(RelayApiClient.prototype, "getPeriodPlan").mockResolvedValue(activePlan);
    vi.spyOn(RelayApiClient.prototype, "getProjectPeriodPlans").mockResolvedValue({ projectId, items: [activePlan] });
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue(projectState());
    vi.spyOn(RelayApiClient.prototype, "getProjectGoals").mockResolvedValue([]);
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task, { ...task, id: task2Id, title: "独立工作" }], nextCursor: null });
    vi.spyOn(RelayApiClient.prototype, "getTaskTimeEstimates").mockImplementation(async (id) => ({ taskId: id, current: null, items: [] }));
    const receipt = vi.spyOn(RelayApiClient.prototype, "getCommandReceipt").mockImplementation(async (id) => {
      receiptCount++;
      return { commandId: id, commandType: "ProposeScopeSimulation", committedAt: "2026-10-25T00:00:00Z",
        result: { simulation_id: created.simulationId, source_plan_id: "plan-scope", project_id: receiptCount === 1 ? "wrong-project" : projectId,
          revision: created.revision, status: "PROPOSED" } };
    });
    const mounted = await mountWorkbench(`/projects/${projectId}/planning`);
    try {
      await flush();
      const rows = mounted.wrapper.findAll(".planning-scope-row");
      await rows[0]!.findAll('input[type="checkbox"]')[0]!.setValue(true);
      await rows[1]!.findAll('input[type="checkbox"]')[1]!.setValue(true);
      await mounted.wrapper.get(".planning-scope button").trigger("click"); await flush();
      expect(propose).toHaveBeenCalledTimes(1);
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(true);
      await mounted.wrapper.get('[data-testid="planning-pending-command"] button').trigger("click"); await flush();
      expect(receipt).toHaveBeenCalledWith(commandId);
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(true);
      await mounted.wrapper.get('[data-testid="planning-pending-command"] button').trigger("click"); await flush();
      expect(propose).toHaveBeenCalledTimes(1);
      expect(readSimulation).toHaveBeenCalledWith(created.simulationId);
      expect((mounted.wrapper.get(".planning-scope select").element as HTMLSelectElement).value).toBe(created.simulationId);
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(false);
      expect(mounted.wrapper.text()).toContain("已读回并选中对应推演");
    } finally { mounted.unmount(); }
  });

  it("SELECT_SCOPE 回执选中计划错配时保留原命令，正确恢复后选中新计划", async () => {
    connect();
    const basePlan = twoTaskPlan();
    const selectedPlan: RelayPeriodPlan = { ...twoTaskPlan(), planId: "plan-selected", revision: "1" };
    let plans: RelayPeriodPlan[] = [basePlan];
    let simulation = scopeSimulation();
    let commandId = "";
    let receiptCount = 0;
    vi.spyOn(RelayApiClient.prototype, "getProjectPeriodPlans").mockImplementation(async () => ({ projectId, items: plans }));
    vi.spyOn(RelayApiClient.prototype, "getPeriodPlan").mockImplementation(async (id) => id === selectedPlan.planId ? selectedPlan : basePlan);
    vi.spyOn(RelayApiClient.prototype, "getPlanScopeSimulations").mockImplementation(async () => ({ sourcePlanId: "plan-scope", items: [simulation] }));
    vi.spyOn(RelayApiClient.prototype, "getScopeSimulation").mockImplementation(async () => simulation);
    vi.spyOn(RelayApiClient.prototype, "proposeScopeSimulation").mockResolvedValue({
      simulationId: simulation.simulationId, sourcePlanId: "plan-scope", projectId, revision: "1", status: "PROPOSED",
      selectedOption: null, selectedPlanId: null });
    const select = vi.spyOn(RelayApiClient.prototype, "selectScopeSimulation").mockImplementation(async (input) => {
      commandId = input.commandId;
      simulation = { ...simulation, revision: "2", status: "SELECTED", selectedOption: "SHRINK", selectedPlanId: selectedPlan.planId };
      plans = [basePlan, selectedPlan]; throw new Error("response lost");
    });
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue(projectState());
    vi.spyOn(RelayApiClient.prototype, "getProjectGoals").mockResolvedValue([]);
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task, { ...task, id: task2Id, title: "独立工作" }], nextCursor: null });
    vi.spyOn(RelayApiClient.prototype, "getTaskTimeEstimates").mockImplementation(async (id) => ({ taskId: id, current: null, items: [] }));
    const receipt = vi.spyOn(RelayApiClient.prototype, "getCommandReceipt").mockImplementation(async (id) => {
      receiptCount++;
      return { commandId: id, commandType: "SelectScopeSimulation", committedAt: "2026-10-25T00:00:00Z",
        result: { simulation_id: simulation.simulationId, source_plan_id: "plan-scope", project_id: projectId,
          revision: simulation.revision, status: "SELECTED", selected_option: "SHRINK",
          selected_plan_id: receiptCount === 1 ? "plan-wrong" : selectedPlan.planId } };
    });
    const mounted = await mountWorkbench(`/projects/${projectId}/planning`);
    try {
      await flush();
      await mounted.wrapper.get('.planning-simulation input[placeholder="说明为什么采用此范围"]').setValue("保留当前主线");
      await mounted.wrapper.get('[data-testid="scope-option-SHRINK"] button').trigger("click"); await flush();
      expect(select).toHaveBeenCalledTimes(1);
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(true);
      await mounted.wrapper.get('[data-testid="planning-pending-command"] button').trigger("click"); await flush();
      expect(receipt).toHaveBeenCalledWith(commandId);
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(true);
      await mounted.wrapper.get('[data-testid="planning-pending-command"] button').trigger("click"); await flush();
      expect(select).toHaveBeenCalledTimes(1);
      expect((mounted.wrapper.get(".planning-history select").element as HTMLSelectElement).value).toBe(selectedPlan.planId);
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(false);
      expect(mounted.wrapper.text()).toContain("已读回并选中新计划与推演");
    } finally { mounted.unmount(); }
  });

  it("RESOLVE_ITEM 回执状态与服务端计划不一致时保留原命令，重读后确认准确项", async () => {
    connect();
    let activePlan = twoTaskPlan();
    let commandId = "";
    let receiptCount = 0;
    vi.spyOn(RelayApiClient.prototype, "getProjectPeriodPlans").mockImplementation(async () => ({ projectId, items: [activePlan] }));
    vi.spyOn(RelayApiClient.prototype, "getPeriodPlan").mockImplementation(async () => activePlan);
    vi.spyOn(RelayApiClient.prototype, "getPlanScopeSimulations").mockResolvedValue({ sourcePlanId: "plan-scope", items: [] });
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue(projectState());
    vi.spyOn(RelayApiClient.prototype, "getProjectGoals").mockResolvedValue([]);
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task, { ...task, id: task2Id, title: "独立工作" }], nextCursor: null });
    vi.spyOn(RelayApiClient.prototype, "getTaskTimeEstimates").mockImplementation(async (id) => ({ taskId: id, current: null, items: [] }));
    const resolve = vi.spyOn(RelayApiClient.prototype, "resolvePeriodPlanItem").mockImplementation(async (input) => {
      commandId = input.commandId;
      activePlan = { ...activePlan, revision: "4", items: activePlan.items.map((item) => item.id === input.itemId
        ? { ...item, status: "ACCEPTED", resolutionReason: input.reason } : item) };
      throw new Error("response lost");
    });
    const receipt = vi.spyOn(RelayApiClient.prototype, "getCommandReceipt").mockImplementation(async (id) => {
      receiptCount++;
      return { commandId: id, commandType: "ResolvePeriodPlanItem", committedAt: "2026-10-25T00:00:00Z",
        result: { plan_id: "plan-scope", item_id: "item-1", project_id: projectId,
          item_status: receiptCount === 1 ? "REJECTED" : "ACCEPTED", revision: "4" } };
    });
    const mounted = await mountWorkbench(`/projects/${projectId}/planning`);
    try {
      await flush();
      await mounted.wrapper.get('input[placeholder="说明接受或拒绝的依据"]').setValue("人工接受当前依据");
      await mounted.wrapper.get('[data-testid="period-plan-item-item-1"] button').trigger("click"); await flush();
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(true);
      await mounted.wrapper.get('[data-testid="planning-pending-command"] button').trigger("click"); await flush();
      expect(receipt).toHaveBeenCalledWith(commandId);
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(true);
      await mounted.wrapper.get('[data-testid="planning-pending-command"] button').trigger("click"); await flush();
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(mounted.wrapper.find('[data-testid="period-plan-item-item-1"]').text()).toContain("已接受");
      expect(mounted.wrapper.find('[data-testid="planning-pending-command"]').exists()).toBe(false);
      expect(mounted.wrapper.text()).toContain("已读回对应计划和处理状态");
    } finally { mounted.unmount(); }
  });

  it("创建任务链后仍保持 DRAFT；只有单独勾选授权确认才提交预算", async () => {
    connect();
    const chainState: { rows: ReturnType<typeof chain>[]; nextId: number } = { rows: [], nextId: 0 };
    const create = vi.spyOn(RelayApiClient.prototype, "createTaskChain").mockImplementation(async () => {
      const chainId = `chain-${++chainState.nextId}`;
      chainState.rows.push({ ...chain("DRAFT"), chainId });
      return { chainId, projectId, status: "DRAFT", revision: "1" };
    });
    const authorize = vi.spyOn(RelayApiClient.prototype, "authorizeTaskChain").mockImplementation(async (input) => {
      const index = chainState.rows.findIndex((row) => row.chainId === input.chainId);
      chainState.rows[index] = { ...chain("ACTIVE"), chainId: input.chainId, revision: "2", maxTasks: input.maxTasks, maxModelCalls: input.maxModelCalls,
        taskReservations: 0, callsStarted: 0, expiresAt: input.expiresAt };
      return { chainId: input.chainId, projectId, status: "ACTIVE", revision: "2" };
    });
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue(projectState());
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task], nextCursor: null });
    vi.spyOn(RelayApiClient.prototype, "getTask").mockResolvedValue(detail);
    vi.spyOn(RelayApiClient.prototype, "getTaskChain").mockImplementation(async (id) => chainState.rows.find((row) => row.chainId === id)!);
    vi.spyOn(RelayApiClient.prototype, "getReviews").mockResolvedValue([]);
    vi.spyOn(RelayApiClient.prototype, "getProjectTaskChains").mockImplementation(async () => ({ projectId,
      items: chainState.rows }));
    const mounted = await mountWorkbench(`/projects/${projectId}/task-chains`);
    try {
      await flush();
      await mounted.wrapper.get('.task-chain-task-list input[type="checkbox"]').setValue(true);
      await flush();
      await mounted.wrapper.get('[data-testid="task-chain-create"]').trigger("click");
      await flush();
      expect(create).toHaveBeenCalledTimes(1);
      expect(authorize).not.toHaveBeenCalled();
      expect(create.mock.calls[0]![0].tasks).toEqual([{ taskId, expectedRevision: "4", expectedAcceptanceRevision: "2" }]);
      const future = new Date(Date.now() + 60 * 60 * 1000);
      const localExpiry = new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      await mounted.wrapper.get('input[type="datetime-local"]').setValue(localExpiry);
      const consent = mounted.wrapper.get('[aria-label="明确任务链授权"] input[type="checkbox"]');
      expect(check(consent.element!)).toBe(false);
      await consent.setValue(true);
      expect((mounted.wrapper.get('[data-testid="task-chain-authorize"]').element as HTMLButtonElement).disabled).toBe(false);
      await mounted.wrapper.get('[data-testid="task-chain-authorize"]').trigger("click");
      await flush();
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(authorize.mock.calls[0]![0]).toMatchObject({ chainId: "chain-1", confirmed: true, maxTasks: 1, maxModelCalls: 3 });
      await mounted.wrapper.get('.task-chain-task-list input[type="checkbox"]').setValue(true);
      await flush();
      await mounted.wrapper.get('[data-testid="task-chain-create"]').trigger("click");
      await flush();
      expect(create).toHaveBeenCalledTimes(2);
      expect((mounted.wrapper.get(".task-chain-history select").element as HTMLSelectElement).value).toBe("chain-2");
      expect(mounted.wrapper.get('[data-testid="task-chain-detail"]').text()).toContain("草稿");
      expect(chainState.rows.find((row) => row.chainId === "chain-1")?.status).toBe("ACTIVE");
    } finally { mounted.unmount(); }
  });

  it("第二条任务链丢响应后按原回执选中，并恢复授权和暂停的准确任务链", async () => {
    connect();
    const rows: RelayTaskChain[] = [{ ...chain("DRAFT"), chainId: "chain-1" }];
    const receipts = new Map<string, Awaited<ReturnType<RelayApiClient["getCommandReceipt"]>>>();
    const create = vi.spyOn(RelayApiClient.prototype, "createTaskChain").mockImplementation(async (input) => {
      const created = { ...chain("DRAFT"), chainId: "chain-2" };
      rows.push(created);
      receipts.set(input.commandId, { commandId: input.commandId, commandType: "CreateTaskChain",
        committedAt: "2026-10-25T00:00:00Z", result: { chainId: created.chainId, projectId, status: created.status, revision: created.revision } });
      throw new TypeError("create response lost after commit");
    });
    const authorize = vi.spyOn(RelayApiClient.prototype, "authorizeTaskChain").mockImplementation(async (input) => {
      const index = rows.findIndex((row) => row.chainId === input.chainId);
      rows[index] = { ...rows[index]!, status: "ACTIVE", revision: "2", maxTasks: input.maxTasks,
        maxModelCalls: input.maxModelCalls, expiresAt: input.expiresAt };
      receipts.set(input.commandId, { commandId: input.commandId, commandType: "AuthorizeTaskChain",
        committedAt: "2026-10-25T00:00:00Z", result: { chainId: input.chainId, projectId, status: "ACTIVE", revision: "2" } });
      throw new TypeError("authorize response lost after commit");
    });
    const stop = vi.spyOn(RelayApiClient.prototype, "stopTaskChain").mockImplementation(async (input) => {
      const index = rows.findIndex((row) => row.chainId === input.chainId);
      rows[index] = { ...rows[index]!, status: input.action === "PAUSE" ? "PAUSED" : "REVOKED", revision: "3", reason: input.reason };
      receipts.set(input.commandId, { commandId: input.commandId, commandType: "StopTaskChain",
        committedAt: "2026-10-25T00:00:00Z", result: { chainId: input.chainId, projectId,
          status: input.action === "PAUSE" ? "PAUSED" : "REVOKED", revision: "3" } });
      throw new TypeError("stop response lost after commit");
    });
    const receipt = vi.spyOn(RelayApiClient.prototype, "getCommandReceipt").mockImplementation(async (id) => {
      const found = receipts.get(id);
      if (!found) throw new Error("receipt not found");
      return found;
    });
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue(projectState());
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task], nextCursor: null });
    vi.spyOn(RelayApiClient.prototype, "getTask").mockResolvedValue(detail);
    vi.spyOn(RelayApiClient.prototype, "getTaskChain").mockImplementation(async (id) => rows.find((row) => row.chainId === id)!);
    vi.spyOn(RelayApiClient.prototype, "getReviews").mockResolvedValue([]);
    vi.spyOn(RelayApiClient.prototype, "getProjectTaskChains").mockImplementation(async () => ({ projectId, items: rows }));
    const mounted = await mountWorkbench(`/projects/${projectId}/task-chains`);
    try {
      await flush();
      expect((mounted.wrapper.get(".task-chain-history select").element as HTMLSelectElement).value).toBe("chain-1");
      await mounted.wrapper.get('.task-chain-task-list input[type="checkbox"]').setValue(true); await flush();
      await mounted.wrapper.get('[data-testid="task-chain-create"]').trigger("click"); await flush();
      expect(create).toHaveBeenCalledTimes(1);
      expect(mounted.wrapper.find('[data-testid="task-chain-pending"]').exists()).toBe(true);
      await mounted.wrapper.get('[data-testid="task-chain-pending"] button').trigger("click"); await flush();
      expect(receipt).toHaveBeenCalledTimes(1);
      expect((mounted.wrapper.get(".task-chain-history select").element as HTMLSelectElement).value).toBe("chain-2");
      expect(mounted.wrapper.get('[data-testid="task-chain-detail"]').text()).toContain("草稿");

      const future = new Date(Date.now() + 60 * 60 * 1000);
      const localExpiry = new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      await mounted.wrapper.get('input[type="datetime-local"]').setValue(localExpiry);
      await mounted.wrapper.get('[aria-label="明确任务链授权"] input[type="checkbox"]').setValue(true);
      await mounted.wrapper.get('[data-testid="task-chain-authorize"]').trigger("click"); await flush();
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(mounted.wrapper.find('[data-testid="task-chain-pending"]').exists()).toBe(true);
      await mounted.wrapper.get('[data-testid="task-chain-pending"] button').trigger("click"); await flush();
      expect(receipt).toHaveBeenCalledTimes(2);
      expect(mounted.wrapper.get('[data-testid="task-chain-detail"]').text()).toContain("已授权执行");
      expect((mounted.wrapper.get(".task-chain-history select").element as HTMLSelectElement).value).toBe("chain-2");

      await mounted.wrapper.get(".task-chain-stop input").setValue("暂停并检查进度");
      await mounted.wrapper.get(".task-chain-stop button").trigger("click"); await flush();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(mounted.wrapper.find('[data-testid="task-chain-pending"]').exists()).toBe(true);
      await mounted.wrapper.get('[data-testid="task-chain-pending"] button').trigger("click"); await flush();
      expect(receipt).toHaveBeenCalledTimes(3);
      expect(mounted.wrapper.get('[data-testid="task-chain-detail"]').text()).toContain("已暂停");
      expect(create).toHaveBeenCalledTimes(1);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally { mounted.unmount(); }
  });

  it("缺少必需验收条件、支持产物或存在未解除 blocker 时禁用创建并显示依据", async () => {
    connect();
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue({ ...projectState(), blockers: [
      { blockerId: "blocker-1", targetKind: "TASK", targetId: taskId, reason: "等待外部材料", sourceRef: "human:test",
        resolvedAt: null, createdAt: "2026-10-25T00:00:00Z" },
    ] });
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task], nextCursor: null });
    vi.spyOn(RelayApiClient.prototype, "getTask").mockResolvedValue({ ...detail,
      unresolvedBlockerIds: ["blocker-1"],
      acceptance: { ...detail.acceptance, expectedOutputs: { artifacts: ["PDF"] }, criteria: [] } });
    vi.spyOn(RelayApiClient.prototype, "getProjectTaskChains").mockResolvedValue({ projectId, items: [] });
    vi.spyOn(RelayApiClient.prototype, "getReviews").mockResolvedValue([]);
    const mounted = await mountWorkbench(`/projects/${projectId}/task-chains`);
    try {
      await flush();
      await mounted.wrapper.get('.task-chain-task-list input[type="checkbox"]').setValue(true);
      await flush();
      const text = mounted.wrapper.get(".task-chain-order").text();
      expect(text).toContain("缺少必需验收条件");
      expect(text).toContain("MARKDOWN_DOCUMENT");
      expect(text).toContain("等待外部材料");
      expect((mounted.wrapper.get('[data-testid="task-chain-create"]').element as HTMLButtonElement).disabled).toBe(true);
    } finally { mounted.unmount(); }
  });

  it("任务链前置顺序错误时显示未完成 BLOCKS 依赖并禁用创建", async () => {
    connect();
    const laterTask: RelayTaskSummary = { ...task, id: task2Id, title: "应先完成的前置" };
    vi.spyOn(RelayApiClient.prototype, "getProject").mockResolvedValue(project());
    vi.spyOn(RelayApiClient.prototype, "getProjectState").mockResolvedValue(projectState());
    vi.spyOn(RelayApiClient.prototype, "getProjectTasksPage").mockResolvedValue({ items: [task, laterTask], nextCursor: null });
    vi.spyOn(RelayApiClient.prototype, "getTask").mockImplementation(async (id) => id === taskId
      ? { ...detail, dependencies: [{ taskId: task2Id, dependencyKind: "BLOCKS", status: "INBOX", title: laterTask.title }] }
      : { ...detail, id: task2Id, title: laterTask.title });
    vi.spyOn(RelayApiClient.prototype, "getProjectTaskChains").mockResolvedValue({ projectId, items: [] });
    vi.spyOn(RelayApiClient.prototype, "getReviews").mockResolvedValue([]);
    const mounted = await mountWorkbench(`/projects/${projectId}/task-chains`);
    try {
      await flush();
      const choices = mounted.wrapper.findAll('.task-chain-task-list input[type="checkbox"]');
      await choices[0]!.setValue(true); await choices[1]!.setValue(true); await flush();
      expect(mounted.wrapper.get(".task-chain-order").text()).toContain("应先完成的前置");
      expect(mounted.wrapper.text()).toContain("所选顺序没有把全部未完成的必要前置排在依赖任务之前");
      expect((mounted.wrapper.get('[data-testid="task-chain-create"]').element as HTMLButtonElement).disabled).toBe(true);
    } finally { mounted.unmount(); }
  });
});
