import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import type { RelayApiClient, RelayTaskAcceptance } from "../src/api/relayClient";
import AttentionQueue from "../src/components/AttentionQueue";
import TaskAcceptanceEvidence from "../src/components/TaskAcceptanceEvidence";
import { flush, mountReact } from "./mountApp";

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

function task(id: string, projectId: string, status = "WAITING", runId: string | null = null) {
  return { id, projectId, title: `任务 ${id}`, status, mode: "DELEGATE_AI", revision: "2", executor: runId ? "AI" : "HUMAN",
    executorRunId: runId, currentCompletionId: null, waitingReason: status === "WAITING" ? "等待人工核对" : null,
    blockingTaskIds: [], unresolvedBlockerIds: [], allowedActions: [] };
}

describe("26 日人工待处理汇总", () => {
  it("两个项目的 Review、Task、未决 Run 分组展示，重复业务 ID 去重且正常 Run 不冒充待办", async () => {
    const client = {
      getInterventions: vi.fn(async () => []),
      getReviews: vi.fn(async () => [{ id: "review-1", kind: "CRITERION", status: "OPEN", revision: "1",
        projectId: "project-a", taskId: "task-a", runId: "run-a", reason: "需要人工判断" },
      { id: "review-1", kind: "CRITERION", status: "OPEN", revision: "1",
        projectId: "project-a", taskId: "task-a", runId: "run-a", reason: "需要人工判断" }]),
      getWorkspaceTasksPage: vi.fn(async (cursor: string | null) => cursor === null
        ? { items: [task("task-a", "project-a", "WAITING", "run-a"), task("task-b", "project-b", "READY")], nextCursor: "page-2" }
        : { items: [task("task-b", "project-b", "READY"), task("task-c", "project-b", "WAITING", "run-c"),
          task("task-d", "project-b", "IN_PROGRESS", "run-d")], nextCursor: null }),
      getRun: vi.fn(async (id: string) => ({ id, taskId: id.replace("run", "task"), status: id === "run-c" ? "WAITING" : "RUNNING",
        unresolvedOperationIds: id === "run-c" ? ["operation-1"] : [], pendingControlRequest: null }))
    } as unknown as RelayApiClient;
    const mounted = await mountReact(createElement(MemoryRouter, null, createElement(AttentionQueue, { client }))); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.findAll('[data-testid="attention-review-review-1"]')).toHaveLength(1);
    expect(mounted.wrapper.findAll('[data-testid="attention-task-task-b"]')).toHaveLength(1);
    expect(mounted.wrapper.find('[data-testid="attention-run-run-c"]').text()).toContain("operation-1");
    expect(mounted.wrapper.find('[data-testid="attention-run-run-b"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="attention-task-task-a"]').exists()).toBe(false);
    expect(mounted.wrapper.find('[data-testid="attention-incomplete"]').exists()).toBe(false);
  });

  it("分页读取有上限并可继续，Run 失败时保留已读事项和不完整提示", async () => {
    let pages = 0;
    const client = {
      getInterventions: vi.fn(async () => []),
      getReviews: vi.fn(async () => []),
      getWorkspaceTasksPage: vi.fn(async (cursor: string | null) => {
        pages++;
        const number = cursor === null ? 0 : Number(cursor);
        return { items: [task(`task-${number}`, "project-a", "WAITING", "run-fail")],
          nextCursor: number === 10 ? null : String(number + 1) };
      }),
      getRun: vi.fn(async () => { throw new Error("Run 离线"); })
    } as unknown as RelayApiClient;
    const mounted = await mountReact(createElement(MemoryRouter, null, createElement(AttentionQueue, { client }))); unmount = mounted.unmount;
    await flush();
    expect(pages).toBe(10);
    expect(mounted.wrapper.get('[data-testid="attention-incomplete"]').text()).toContain("尚有后续页");
    expect(mounted.wrapper.get('[data-testid="attention-incomplete"]').text()).toContain("Run 离线");
    await mounted.wrapper.get('[data-testid="attention-incomplete"] button').trigger("click");
    await flush();
    expect(pages).toBe(11);
    expect(mounted.wrapper.get('[data-testid="attention-incomplete"]').text()).toContain("Run 离线");
    expect(mounted.wrapper.find('[data-testid="attention-task-task-10"]').exists()).toBe(true);
  });

  it("Review 已被别处处理后刷新移除，读取失败不显示空队列结论", async () => {
    let open = true;
    let fail = false;
    const client = {
      getInterventions: vi.fn(async () => []),
      getReviews: vi.fn(async () => {
        if (fail) throw new Error("Review 不可读");
        return open ? [{ id: "review-1", kind: "CRITERION", status: "OPEN", revision: "1",
          projectId: "project-a", taskId: null, runId: null, reason: "待审" }] : [];
      }),
      getWorkspaceTasksPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      getRun: vi.fn()
    } as unknown as RelayApiClient;
    const mounted = await mountReact(createElement(MemoryRouter, null, createElement(AttentionQueue, { client }))); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.find('[data-testid="attention-review-review-1"]').exists()).toBe(true);
    open = false; fail = true;
    await mounted.wrapper.get('[data-testid="attention-queue"] .list-header button').trigger("click");
    await flush();
    expect(mounted.wrapper.find('[data-testid="attention-review-review-1"]').exists()).toBe(false);
    expect(mounted.wrapper.get('[data-testid="attention-incomplete"]').text()).toContain("Review 不可读");
    expect(mounted.wrapper.text()).not.toContain("当前读取范围内没有待处理项");
  });
});

describe("26 日需求验收证据", () => {
  const acceptance: RelayTaskAcceptance = { acceptanceRevision: "3", objective: "交付组合结果", expectedOutputs: { kind: "CODE" },
    source: "HUMAN", criteria: [{ criterionId: "must-1", statement: "重要行为可用", required: true,
      method: "AUTO", targetSpec: { artifact_kind: "CODE" } },
    { criterionId: "must-2", statement: "人工确认", required: true, method: "HUMAN", targetSpec: null }] };
  function client(checkResult: string, finalizedAt: string | null = "2026-09-27T00:00:00Z") {
    return {
      getTaskCheckPlanPreview: vi.fn(async () => ({ taskId: "task-1", status: "AVAILABLE", sources: { taskRevision: "2", acceptanceRevision: "3" },
        checkPlanSha256: "plan-1", checkPlan: { entries: [{ criterionId: "must-1", checkerId: "checker-1", checkerVersion: "1" }] } })),
      getTaskArtifacts: vi.fn(async () => ({ items: [{ latestVersionId: "version-1", versions: [{ artifactVersionId: "version-1", sha256: "sha-1" }] }] })),
      getRunTrace: vi.fn(async () => ({ taskId: "task-1", runId: "run-1", verifications: [{ id: "session-1", acceptanceRevision: "3",
        checkPlanHash: "plan-1", status: "FINALIZED", verdict: "PASS", finalizedAt,
        targets: [{ artifactVersionId: "version-1", contentSha256: "sha-1" }],
        checks: [{ criterionId: "must-1", result: checkResult }] }] })),
      getTask: vi.fn(async () => ({ revision: "2", acceptance: { acceptanceRevision: "3" }, executorRunId: "run-1", currentCompletionId: null }))
    } as unknown as RelayApiClient;
  }
  function completedClient(artifactVersions: readonly { availability: "AVAILABLE" | "UNAVAILABLE" }[],
    artifactItems: readonly unknown[]) {
    return { ...client("PASS"),
      getTaskArtifacts: vi.fn(async () => ({ items: artifactItems })),
      getCompletionEvidence: vi.fn(async () => ({ completionId: "completion-1", taskId: "task-1", isCurrent: true,
        acceptanceRevision: "3", basisKind: "HUMAN", acceptance: { availability: "AVAILABLE" },
        humanAcceptance: { availability: "AVAILABLE", acceptedCriterionIds: ["must-2"] },
        verificationSession: null, artifactVersions })),
      getTask: vi.fn(async () => ({ revision: "2", acceptance: { acceptanceRevision: "3" },
        executorRunId: null, currentCompletionId: "completion-1" }))
    } as unknown as RelayApiClient;
  }
  it("hash 与产物匹配的历史 PASS 也不推断当前适用性；未运行条件保留缺口", async () => {
    const mounted = await mountReact(createElement(MemoryRouter, null, createElement(TaskAcceptanceEvidence, { client: client("PASS"), taskId: "task-1",
      taskRevision: "2", acceptance, runId: "run-1", completionId: null }))); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.get('[data-testid="acceptance-criterion-must-1"]').text()).toContain("历史检查 PASS，当前适用性未核实");
    expect(mounted.wrapper.get('[data-testid="acceptance-criterion-must-2"]').text()).toContain("未关联当前 CheckPlan");
    expect(mounted.wrapper.text()).toContain("组合版本证据：当前接口没有可核对");
  });
  it("检查器 ERROR 与未完成会话分别保留错误和未运行缺口", async () => {
    const mounted = await mountReact(createElement(MemoryRouter, null, createElement(TaskAcceptanceEvidence, { client: client("ERROR"), taskId: "task-1",
      taskRevision: "2", acceptance, runId: "run-1", completionId: null }))); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.get('[data-testid="acceptance-criterion-must-1"]').text()).toContain("历史检查器错误");
    await mounted.rerender(createElement(MemoryRouter, null, createElement(TaskAcceptanceEvidence, { client: client("PASS", null), taskId: "task-1",
      taskRevision: "2", acceptance, runId: "run-1", completionId: null })));
    await flush();
    expect(mounted.wrapper.text()).toContain("旧结果不适用");
    expect(mounted.wrapper.text()).not.toContain("当前版本检查 PASS");
  });

  it("不同产物版本、验收版本与组合版本均不能继承历史 PASS", async () => {
    const api = client("PASS");
    vi.mocked(api.getTaskArtifacts).mockResolvedValueOnce({ items: [{ latestVersionId: "version-2",
      versions: [{ artifactVersionId: "version-2", sha256: "sha-2" }] }] } as never);
    const mounted = await mountReact(createElement(MemoryRouter, null, createElement(TaskAcceptanceEvidence, { client: api, taskId: "task-1",
      taskRevision: "2", acceptance, runId: "run-1", completionId: null }))); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.get('[data-testid="acceptance-criterion-must-1"]').text()).toContain("旧结果不适用");
    expect(mounted.wrapper.text()).toContain("组合版本证据：当前接口没有可核对");
    mounted.unmount(); unmount = null;
    const oldAcceptance = client("PASS");
    const trace = await oldAcceptance.getRunTrace("run-1");
    vi.mocked(oldAcceptance.getRunTrace).mockResolvedValueOnce({ ...trace,
      verifications: trace.verifications.map((session) => ({ ...session, acceptanceRevision: "2" })) });
    const second = await mountReact(createElement(MemoryRouter, null, createElement(TaskAcceptanceEvidence, {
      client: oldAcceptance, taskId: "task-1", taskRevision: "2", acceptance, runId: "run-1", completionId: null
    }))); unmount = second.unmount;
    await flush();
    expect(second.wrapper.get('[data-testid="acceptance-criterion-must-1"]').text()).toContain("旧结果不适用");
  });

  it("合法空产物集合的当前 HUMAN 完成可显示人工接受", async () => {
    const noOutputAcceptance = { ...acceptance, expectedOutputs: { artifacts: [] } };
    const api = completedClient([], []);
    const mounted = await mountReact(createElement(MemoryRouter, null, createElement(TaskAcceptanceEvidence, {
      client: api, taskId: "task-1", taskRevision: "2", acceptance: noOutputAcceptance,
      runId: null, completionId: "completion-1"
    }))); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.get('[data-testid="acceptance-criterion-must-2"]').text()).toContain("当前完成凭据已接受");
    expect(mounted.wrapper.text()).toContain("当前周期、验收与产物来源已核对");
  });

  it("声明且实际有产物但完成凭据的版本不可用时不显示当前人工接受", async () => {
    const api = completedClient([{ availability: "UNAVAILABLE" }],
      [{ latestVersionId: "version-1", versions: [{ artifactVersionId: "version-1", sha256: "sha-1" }] }]);
    const mounted = await mountReact(createElement(MemoryRouter, null, createElement(TaskAcceptanceEvidence, {
      client: api, taskId: "task-1", taskRevision: "2", acceptance,
      runId: null, completionId: "completion-1"
    }))); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.get('[data-testid="acceptance-criterion-must-2"]').text()).toContain("无当前完成凭据关联");
    expect(mounted.wrapper.text()).toContain("不适用、来源缺失或读取未完成");
  });
});
