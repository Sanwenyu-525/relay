import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AttentionQueue from "../src/components/AttentionQueue";
import type { RelayApiClient } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

const review = { id: "review-1", kind: "CRITERION", status: "OPEN", revision: "1",
  projectId: "project-a", taskId: "task-a", runId: "run-a", operationId: null,
  reason: "AWAITING_HUMAN_EVIDENCE", targetHash: "target-hash-1",
  target: { artifact_version_id: "artifact-version-1" }, evidence: { check_result: "AUTO_INCONCLUSIVE" },
  effect: { on_accept: "保存人工判断后重新核对完成条件" }, allowedDecisions: ["ACCEPT", "REQUEST_CHANGES"],
  expiresAt: null, createdAt: "2026-10-21T00:00:00.000Z", decidedAt: null };

const taskA = { id: "task-a", projectId: "project-a", title: "写第 3 章草稿", status: "WAITING",
  mode: "DELEGATE_AI", revision: "2", executor: "AI", executorRunId: "run-a", currentCompletionId: null,
  waitingReason: "必需验收条件需要你的判断", blockingTaskIds: [], unresolvedBlockerIds: [], allowedActions: [] };

const humanTask = { id: "task-b", projectId: "project-a", title: "整理第 3 章引用", status: "INBOX",
  mode: "ME", revision: "2", executor: "HUMAN", executorRunId: null, currentCompletionId: null,
  waitingReason: null, blockingTaskIds: [], unresolvedBlockerIds: [], allowedActions: [] };

/** 服务端把 Review 事项的「为什么」投影成 `枚举：枚举`，界面不能原样当成用户语言。 */
const intervention = { itemKey: "review:review-1", changeKey: "1", kind: "REVIEW",
  title: "有待审批事项", reason: "CRITERION：AWAITING_HUMAN_EVIDENCE", targetUrl: "/reviews?id=review-1" };

const failedRun = { id: "run-a", taskId: "task-a", status: "FAILED", unresolvedOperationIds: ["operation-1"],
  pendingControlRequest: null };

let mounted: Awaited<ReturnType<typeof mountReact>> | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; });

function client(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getInterventions: vi.fn(async () => [intervention]),
    getReviews: vi.fn(async () => [review]),
    getWorkspaceTasksPage: vi.fn(async () => ({ items: [taskA], nextCursor: null })),
    getRun: vi.fn(async () => failedRun),
    getProjectsPage: vi.fn(async () => ({ items: [{ id: "project-a", title: "论文项目" }], nextCursor: null })),
    ...overrides
  } as unknown as RelayApiClient;
}

async function read(overrides: Partial<Record<string, unknown>> = {}) {
  mounted = await mountReact(createElement(MemoryRouter, null,
    createElement(AttentionQueue, { client: client(overrides) })));
  await flush();
  return mounted;
}

/** 卡片正文（剥掉可展开技术细节后）真正摆给用户看的那段文字。 */
function plain(testId: string) {
  if (mounted === null) throw new Error("测试未先读取待处理队列");
  const card = mounted.wrapper.find(`[data-testid="${testId}"]`).element as HTMLElement;
  const clone = card.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("details").forEach((details) => details.remove());
  return (clone.textContent ?? "").replace(/\s+/gu, " ");
}

function identity(testId: string) {
  if (mounted === null) throw new Error("测试未先读取待处理队列");
  return mounted.wrapper.find(`[data-testid="${testId}"] details`).text();
}

describe("人工待处理卡片先说人能读懂的对象", () => {
  it("Review 卡片写项目名、任务名和这条请求要判断什么，编码只留在技术细节里", async () => {
    await read();
    const body = plain("attention-review-review-1");
    expect(body).toContain("论文项目");
    expect(body).toContain("写第 3 章草稿");
    expect(body).toContain("人工验收");
    expect(body).toContain("必需验收条件需要你的判断");
    expect(body).not.toContain("CRITERION");
    expect(body).not.toContain("AWAITING_HUMAN_EVIDENCE");
    expect(body).not.toContain("project-a");
    expect(body).not.toContain("review-1");
    expect(identity("attention-review-review-1")).toContain("project-a");
    expect(identity("attention-review-review-1")).toContain("review-1");
  });

  it("项目名读不到或任务不在已读范围时说明暂不可读取，不拿编码冒充名字", async () => {
    await read({ getProjectsPage: vi.fn(async () => { throw new Error("项目清单离线"); }) });
    expect(plain("attention-review-review-1")).toContain("项目名称暂不可读取");
    expect(plain("attention-review-review-1")).not.toContain("project-a");
    mounted!.unmount();
    await read({ getWorkspaceTasksPage: vi.fn(async () => ({ items: [], nextCursor: null })) });
    expect(plain("attention-review-review-1")).toContain("任务标题暂不可读取");
  });

  it("Run 卡片用状态中文说明要核对什么，Operation 编码进技术细节", async () => {
    await read();
    const body = plain("attention-run-run-a");
    expect(body).toContain("失败");
    expect(body).not.toContain("operation-1");
    expect(identity("attention-run-run-a")).toContain("operation-1");
  });

  it("必须介入事项与下方分组指向同一条请求时说明两者关系，计数口径不变", async () => {
    await read();
    expect(plain("attention-intervention-review:review-1")).toContain("同一条请求");
    expect(identity("attention-review-review-1")).toContain("也出现在「必须介入」");
    expect(mounted!.wrapper.find('[data-testid="required-interventions"] h2').text()).toBe("必须介入 · 1");
    expect(mounted!.wrapper.text()).toContain("待判断 Review · 1");
  });

  it("任务卡片只留一个主入口，ID 与版本展开后才给", async () => {
    await read({ getWorkspaceTasksPage: vi.fn(async () => ({ items: [taskA, humanTask], nextCursor: null })) });
    const card = mounted!.wrapper.find('[data-testid="attention-task-task-b"]');
    expect(card.element?.querySelectorAll('[data-testid="attention-main-entry"]') ?? []).toHaveLength(1);
    const body = plain("attention-task-task-b");
    expect(body).toContain("整理第 3 章引用");
    expect(body).toContain("论文项目");
    expect(body).toContain("打开任务核对当前状态");
    expect(body).not.toContain("task-b");
    expect(card.find("details").text()).toContain("task-b");
    expect(card.find("details").text()).toContain("v2");
  });
});
