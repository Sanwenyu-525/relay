import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import AttentionQueue from "../src/components/AttentionQueue";
import { RelayApiError, type RelayApiClient, type RelayInterventionItem, type RelayProjectPage, type RelayReview, type RelayRun, type RelayTaskPage, type RelayTaskSummary } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/**
 * 禅道 #131 的受控复现：待处理队列分批读 Task，后续页暂时 503 之后必须还能按原游标重试。
 * 旧实现把失败页的游标一起清掉，只能从第一页重新遍历。
 */

/** 队列共 11 页：初始读 10 页（null..c9），第 11 页要用 c10 去取。 */
const TOTAL_PAGES = 11;
/** 这个替身只实现待处理队列用到的端口，签名与 RelayApiClient 保持一致。 */
interface AttentionClientDouble {
  getInterventions(): Promise<readonly RelayInterventionItem[]>;
  getReviews(): Promise<readonly RelayReview[]>;
  getWorkspaceTasksPage(cursor: string | null): Promise<RelayTaskPage>;
  getRun(runId: string): Promise<RelayRun>;
  getProjectsPage(status: "active" | "archived" | "all", cursor: string | null): Promise<RelayProjectPage>;
}

interface Fixture {
  /** 按顺序记录每次请求用的游标：「有没有重读前 10 页」只能靠它断言。 */
  readonly requestedCursors: (string | null)[];
  /** 当前暂时不可用（503）的游标；null 表示没有这样的页。 */
  unavailableCursor: string | null;
  /** 首读（cursor=null）就失败：用来核对首读仍走整块错误态。 */
  failFirstPage: boolean;
  /** 服务是否已经恢复。 */
  recovered: boolean;
  /** 队列总页数：页序号 0 是 cursor=null 那一页。 */
  totalPages: number;
}

function attentionTask(index: number): RelayTaskSummary {
  return {
    id: `task-${index}`, projectId: "project-a", title: `待处理任务 ${index}`, status: "WAITING",
    mode: "DELEGATE_AI", revision: "1", executor: "AI", executorRunId: null, currentCompletionId: null,
    waitingReason: "等待你核对这一项", blockingTaskIds: [], unresolvedBlockerIds: [], allowedActions: [],
    updatedAt: "2026-10-23T00:00:00.000Z"
  };
}

function unavailableError(): RelayApiError {
  return new RelayApiError({
    status: 503, code: "SERVICE_UNAVAILABLE", detail: "服务暂时不可用，请稍后重试。",
    retryable: true, retryAction: null, fieldErrors: [], expectedRevision: null, actualRevision: null
  });
}

function createDouble(fixture: Fixture): AttentionClientDouble {
  return {
    getInterventions: vi.fn(async () => []),
    getReviews: vi.fn(async () => []),
    getRun: vi.fn(async (runId: string) => { throw new Error(`本用例不应读取 Run ${runId}`); }),
    getProjectsPage: vi.fn(async () => ({ items: [], nextCursor: null })),
    getWorkspaceTasksPage: vi.fn(async (cursor: string | null): Promise<RelayTaskPage> => {
      fixture.requestedCursors.push(cursor);
      if (cursor === null && fixture.failFirstPage) throw unavailableError();
      if (cursor !== null && cursor === fixture.unavailableCursor && !fixture.recovered) throw unavailableError();
      const pageIndex = cursor === null ? 0 : Number.parseInt(cursor.slice(1), 10);
      return {
        items: [attentionTask(pageIndex + 1)],
        nextCursor: pageIndex + 1 < fixture.totalPages ? `c${pageIndex + 1}` : null
      };
    })
  };
}

let mounted: Awaited<ReturnType<typeof mountReact>> | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; });

async function render(fixture: Fixture): Promise<void> {
  const double = createDouble(fixture);
  mounted = await mountReact(createElement(MemoryRouter, null,
    createElement(AttentionQueue, { client: double as unknown as RelayApiClient })));
  await flush();
}

/** 「继续读取后续页」入口：先用测试标识找，找不到再按按钮文字找，两种实现都能认出来。 */
function continueButton(): HTMLButtonElement | null {
  const root = mounted?.wrapper.element ?? null;
  if (root === null) return null;
  const byTestId = root.querySelector<HTMLButtonElement>('[data-testid="attention-continue-pages"]');
  if (byTestId !== null) return byTestId;
  return [...root.querySelectorAll("button")]
    .find((button) => (button.textContent ?? "").includes("继续读取后续页")) ?? null;
}

async function clickContinue(): Promise<void> {
  const button = continueButton();
  if (button === null) throw new Error("找不到「继续读取后续页」入口：失败页的继续入口不该消失");
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush();
}

function taskCardIds(): string[] {
  const root = mounted?.wrapper.element ?? null;
  if (root === null) return [];
  return [...root.querySelectorAll('[data-testid^="attention-task-"]')]
    .map((node) => node.getAttribute("data-testid") ?? "");
}

function incompleteWarning(): Element | null {
  const root = mounted?.wrapper.element ?? null;
  if (root === null) return null;
  return root.querySelector('[data-testid="attention-incomplete"]');
}

function pageText(): string {
  return mounted?.wrapper.text() ?? "";
}

describe("人工待处理队列的续页恢复（禅道 #131）", () => {
  it("初批读满 10 页后保留下一页游标，继续入口仍在", async () => {
    const fixture: Fixture = { requestedCursors: [], unavailableCursor: "c10", failFirstPage: false, recovered: false, totalPages: TOTAL_PAGES };
    await render(fixture);
    expect(fixture.requestedCursors).toEqual([null, "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"]);
    expect(continueButton()).not.toBeNull();
    expect(taskCardIds()).toHaveLength(10);
  });

  it("后续页失败时保留失败页身份与继续入口，首批任务与未核对完整警告都还在", async () => {
    const fixture: Fixture = { requestedCursors: [], unavailableCursor: "c10", failFirstPage: false, recovered: false, totalPages: TOTAL_PAGES };
    await render(fixture);
    await clickContinue();
    expect(fixture.requestedCursors).toEqual([null, "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"]);
    // 首批读到的任务不能因为续页失败而消失。
    expect(taskCardIds()).toHaveLength(10);
    expect(taskCardIds()).toContain("attention-task-task-1");
    expect(taskCardIds()).toContain("attention-task-task-10");
    // 「待处理范围未核对完整」这条警告仍在。
    expect(incompleteWarning()).not.toBeNull();
    expect(pageText()).toContain("待处理范围未核对完整");
    // 失败原因就地提示，不把「暂时不可用」说成别的。
    expect(pageText()).toContain("服务暂时不可用");
    // 继续入口仍在：失败页的身份（c10）没有丢。
    expect(continueButton()).not.toBeNull();
  });

  it("服务恢复后按原游标重试这一页，不重读前 10 页", async () => {
    const fixture: Fixture = { requestedCursors: [], unavailableCursor: "c10", failFirstPage: false, recovered: false, totalPages: TOTAL_PAGES };
    await render(fixture);
    await clickContinue();
    expect(continueButton()).not.toBeNull();

    fixture.recovered = true;
    await clickContinue();

    // 请求游标序列：前 10 页各读一次，失败页按原游标重试一次，没有从头重读。
    expect(fixture.requestedCursors).toEqual([
      null, "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c10"
    ]);
    expect(fixture.requestedCursors.filter((cursor) => cursor === null)).toHaveLength(1);
    expect(fixture.requestedCursors.filter((cursor) => cursor === "c5")).toHaveLength(1);
    // 恢复后新读到的任务可见，失败提示消失。
    expect(taskCardIds()).toContain("attention-task-task-11");
    expect(taskCardIds()).toHaveLength(11);
    expect(pageText()).not.toContain("服务暂时不可用");
    expect(incompleteWarning()).toBeNull();
  });

  it("首读失败仍按整块错误态呈现，没有可续的游标", async () => {
    const fixture: Fixture = { requestedCursors: [], unavailableCursor: null, failFirstPage: true, recovered: false, totalPages: TOTAL_PAGES };
    await render(fixture);
    expect(fixture.requestedCursors).toEqual([null]);
    expect(incompleteWarning()).not.toBeNull();
    expect(pageText()).toContain("Task 列表未读完");
    // 首读没有页身份可保留，不给继续入口。
    expect(continueButton()).toBeNull();
  });

  it("续页批次里后面某页失败时，保留的是那一页的游标而不是批首游标", async () => {
    const fixture: Fixture = { requestedCursors: [], unavailableCursor: "c11", failFirstPage: false, recovered: false, totalPages: 13 };
    await render(fixture);
    await clickContinue();
    // c10 读到了，c11 失败：失败页身份是 c11。
    expect(fixture.requestedCursors).toEqual([null, "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11"]);
    expect(taskCardIds()).toContain("attention-task-task-11");
    expect(taskCardIds()).not.toContain("attention-task-task-12");
    expect(continueButton()).not.toBeNull();

    fixture.recovered = true;
    await clickContinue();
    expect(fixture.requestedCursors.slice(12)).toEqual(["c11", "c12"]);
    expect(taskCardIds()).toContain("attention-task-task-12");
    expect(taskCardIds()).toContain("attention-task-task-13");
    expect(pageText()).not.toContain("服务暂时不可用");
  });
});
