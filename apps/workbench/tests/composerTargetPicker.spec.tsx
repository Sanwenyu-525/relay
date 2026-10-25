import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import ComposerTargetPicker from "../src/components/ComposerTargetPicker";
import { RelayApiError } from "../src/api/relayClient";
import type { RelayApiClient, RelayProjectListItem } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/**
 * 输入器「选择任务 / 选择项目」芯片（工作台 §32.11）的契约测试。
 *
 * 锁的是三件事：清单来自真实接口（不在前端写死）、缺数据时如实说明、选中后把目标
 * 交回调用方而不是自己伪造归属。真实 Chromium 几何与真实 Windows 窗口未验证。
 */

const projects = {
  items: [
    { id: "p-1", title: "毕业论文", projectType: "PROJECT", revision: "1", stateRevision: "1",
      archivedAt: null, archiveStatus: "ACTIVE" as const, phaseKey: "EXECUTION",
      nextActionTaskId: null, createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z" },
    { id: "p-2", title: "Relay-Agent", projectType: "PROJECT", revision: "1", stateRevision: "1",
      archivedAt: null, archiveStatus: "ACTIVE" as const, phaseKey: "EXECUTION",
      nextActionTaskId: null, createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z" }
  ],
  nextCursor: null
};

const tasks = [
  { id: "t-1", projectId: "p-1", title: "写第 4 章", status: "IN_PROGRESS" as const,
    mode: "EXECUTE" as const, revision: "1", executor: "HUMAN" as const, executorRunId: null,
    currentCompletionId: null, waitingReason: null, blockingTaskIds: [], unresolvedBlockerIds: [],
    hint: null },
  { id: "t-2", projectId: "p-1", title: "整理参考文献", status: "READY" as const,
    mode: "EXECUTE" as const, revision: "1", executor: "AI" as const, executorRunId: null,
    currentCompletionId: null, waitingReason: null, blockingTaskIds: [], unresolvedBlockerIds: [],
    hint: null }
];

function stubClient(overrides: Partial<Record<"getProjectsPage" | "getProjectTasksPage", unknown>> = {}) {
  return {
    getProjectsPage: vi.fn(async () => projects),
    getProjectTasksPage: vi.fn(async () => ({ items: tasks, nextCursor: null })),
    ...overrides
  } as unknown as RelayApiClient;
}

const chip = () => document.querySelector<HTMLElement>('[data-testid="composer-target"]');
const row = (testId: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
async function click(element: HTMLElement | null): Promise<void> {
  if (element === null) throw new Error("点击目标不存在");
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await flush(0);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("输入器的工作对象芯片", () => {
  it("项目清单来自接口，选项目即回传目标", async () => {
    const onPick = vi.fn();
    const view = await mountReact(<ComposerTargetPicker client={stubClient()} need="PROJECT" onPick={onPick} />);
    try {
      expect(chip()?.textContent).toContain("选择项目");
      await click(chip());
      expect(document.querySelector(".composer-target-menu")).not.toBeNull();
      // 打开才读，第一项来自真实返回的项目。
      expect(row("composer-target-project-p-1")?.textContent).toContain("毕业论文");
      await click(row("composer-target-project-p-1"));
      expect(onPick).toHaveBeenCalledWith({ kind: "PROJECT", id: "p-1", projectId: "p-1", title: "毕业论文" });
      // 选完即收起，不留一个已经选过的面板。
      expect(document.querySelector<HTMLDetailsElement>(".composer-target")?.open).toBe(false);
    } finally { view.unmount(); }
  });

  it("任务要经过项目：选项目后才列任务，点任务回传任务目标", async () => {
    const onPick = vi.fn();
    const client = stubClient();
    const view = await mountReact(<ComposerTargetPicker client={client} need="TASK" onPick={onPick} />);
    try {
      expect(chip()?.textContent).toContain("选择任务");
      await click(chip());
      // 任务清单在选项目之前不读，避免拉全库任务。
      expect(client.getProjectTasksPage).not.toHaveBeenCalled();
      await click(row("composer-target-project-p-1"));
      await flush(0);
      expect(client.getProjectTasksPage).toHaveBeenCalledWith("p-1", null, undefined);
      expect(row("composer-target-task-t-1")?.textContent).toContain("写第 4 章");
      expect(row("composer-target-task-t-1")?.textContent).toContain("进行中");
      await click(row("composer-target-task-t-2"));
      expect(onPick).toHaveBeenCalledWith({ kind: "TASK", id: "t-2", projectId: "p-1", title: "整理参考文献" });
    } finally { view.unmount(); }
  });

  it("空清单与读取失败各有如实文案，不编造目标", async () => {
    const empty = { getProjectsPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      getProjectTasksPage: vi.fn(async () => ({ items: [], nextCursor: null })) } as unknown as RelayApiClient;
    const first = await mountReact(<ComposerTargetPicker client={empty} need="TASK" onPick={() => {}} />);
    try {
      await click(chip());
      expect(document.querySelector(".composer-target-line")?.textContent).toContain("还没有可用的项目");
    } finally { first.unmount(); }
    const failing = { getProjectsPage: vi.fn(async () => { throw new Error("boom"); }),
      getProjectTasks: vi.fn(async () => []) } as unknown as RelayApiClient;
    const second = await mountReact(<ComposerTargetPicker client={failing} need="PROJECT" onPick={() => {}} />);
    try {
      await click(chip());
      expect(document.querySelector(".composer-target-line--error")?.textContent).toContain("清单读取失败");
      expect(document.querySelector('[data-testid^="composer-target-project-"]')).toBeNull();
    } finally { second.unmount(); }
  });

  it("没有本机 API 时说明缺什么；发送中不可展开", async () => {
    const view = await mountReact(<ComposerTargetPicker client={null} need="TASK" onPick={() => {}} disabled />);
    try {
      expect(chip()?.getAttribute("aria-disabled")).toBe("true");
      await click(chip());
      expect(document.querySelector<HTMLDetailsElement>(".composer-target")?.open).toBe(false);
    } finally { view.unmount(); }
  });
});

/**
 * 目标清单读取失败后的恢复（禅道 #103）。
 *
 * 首次读取失败不能被缓存成永久不可用：失败与空清单是两个事实，服务恢复后要能在
 * 原组件里重试回来——不重挂整页、不切走当前讨论、不建会话不改归属。重试是显式入口，
 * 不把错误重置写进 effect 依赖引发自动请求风暴；迟到回包由请求版本守卫丢弃。
 */

function project(id: string, title: string): RelayProjectListItem {
  return { id, title, projectType: "PROJECT", revision: "1", stateRevision: "1",
    archivedAt: null, archiveStatus: "ACTIVE", phaseKey: "EXECUTION",
    nextActionTaskId: null, createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z" };
}

function unavailable(): RelayApiError {
  return new RelayApiError({ status: 503, code: "DATABASE_UNAVAILABLE", detail: "project list temporarily unavailable",
    retryable: true, retryAction: "RETRY", fieldErrors: [], expectedRevision: null, actualRevision: null });
}

const retryButton = () => document.querySelector<HTMLButtonElement>('[data-testid="composer-target-retry"]');

describe("目标清单读取失败后的恢复（禅道 #103）", () => {
  it("项目清单首次失败后可显式重试恢复；重开弹层不自动重读也不丢错误", async () => {
    const recovered = { items: [project("p-recovered", "恢复后可选项目")], nextCursor: null };
    let calls = 0;
    const client = { getProjectsPage: vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw unavailable();
      return recovered;
    }) } as unknown as RelayApiClient;
    const onPick = vi.fn();
    const view = await mountReact(<ComposerTargetPicker client={client} need="PROJECT" onPick={onPick} />);
    try {
      await click(chip());
      expect(document.querySelector(".composer-target-line--error")?.textContent).toContain("清单读取失败");
      expect(document.querySelector(".composer-target-line")?.textContent).not.toContain("还没有");
      // 收起再展开：错误保留、不自动重读——恢复要走显式重试，不靠开合制造请求风暴。
      await click(chip());
      await click(chip());
      expect(document.querySelector(".composer-target-line--error")).not.toBeNull();
      expect(client.getProjectsPage).toHaveBeenCalledTimes(1);
      // 显式重试：按当前 client/need 重读同一次只读请求，成功后显示真实项目。
      await click(retryButton());
      expect(document.querySelector('[data-testid="composer-target-project-p-recovered"]')?.textContent)
        .toContain("恢复后可选项目");
      expect(document.querySelector(".composer-target-line--error")).toBeNull();
      expect(client.getProjectsPage).toHaveBeenCalledTimes(2);
      // 重试只读：未创建任何会话、未改变归属（onPick 未被重试触碰）。
      expect(onPick).not.toHaveBeenCalled();
    } finally { view.unmount(); }
  });

  it("连续失败可再次重试，成功前错误一直在", async () => {
    let calls = 0;
    const client = { getProjectsPage: vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw unavailable();
      return { items: [project("p-ok", "第三次读取到的项目")], nextCursor: null };
    }) } as unknown as RelayApiClient;
    const view = await mountReact(<ComposerTargetPicker client={client} need="PROJECT" onPick={vi.fn()} />);
    try {
      await click(chip());
      expect(document.querySelector(".composer-target-line--error")).not.toBeNull();
      await click(retryButton());
      expect(document.querySelector(".composer-target-line--error")?.textContent).toContain("清单读取失败");
      await click(retryButton());
      expect(document.querySelector('[data-testid="composer-target-project-p-ok"]')).not.toBeNull();
      expect(client.getProjectsPage).toHaveBeenCalledTimes(3);
    } finally { view.unmount(); }
  });

  it("任务清单读取失败后原页重试可恢复，重试仍是只读", async () => {
    const single = { items: [project("p-1", "毕业论文")], nextCursor: null };
    let taskCalls = 0;
    const client = {
      getProjectsPage: vi.fn(async () => single),
      getProjectTasksPage: vi.fn(async () => {
        taskCalls += 1;
        if (taskCalls === 1) throw unavailable();
        return { items: tasks, nextCursor: null };
      })
    } as unknown as RelayApiClient;
    const onPick = vi.fn();
    const view = await mountReact(<ComposerTargetPicker client={client} need="TASK" onPick={onPick} />);
    try {
      await click(chip());
      // 只有一个项目时自动选中，任务清单读取失败要就地可见。
      await flush(0);
      expect(document.querySelector(".composer-target-line--error")?.textContent).toContain("任务清单读取失败");
      // 失败不冒充「还没有任务」。
      expect(document.body.textContent).not.toContain("这个项目还没有任务");
      const taskRetry = [...document.querySelectorAll<HTMLButtonElement>(".composer-target-line--error button")]
        .find((element) => (element.textContent ?? "").includes("重试")) ?? null;
      await click(taskRetry);
      expect(document.querySelector('[data-testid="composer-target-task-t-1"]')?.textContent).toContain("写第 4 章");
      expect(client.getProjectTasksPage).toHaveBeenCalledTimes(2);
      // 恢复后选择任务仍照常回传目标。
      await click(row("composer-target-task-t-2"));
      expect(onPick).toHaveBeenCalledWith({ kind: "TASK", id: "t-2", projectId: "p-1", title: "整理参考文献" });
    } finally { view.unmount(); }
  });

  it("收起弹层后迟到的旧回包不串进新清单", async () => {
    let releaseFirst!: (value: { items: RelayProjectListItem[]; nextCursor: null }) => void;
    const gated = new Promise<{ items: RelayProjectListItem[]; nextCursor: null }>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const client = { getProjectsPage: vi.fn(async () => {
      calls += 1;
      return calls === 1 ? gated : { items: [project("p-late", "后来请求的项目")], nextCursor: null };
    }) } as unknown as RelayApiClient;
    const view = await mountReact(<ComposerTargetPicker client={client} need="PROJECT" onPick={vi.fn()} />);
    try {
      await click(chip());
      await click(chip());
      await click(chip());
      await flush(0);
      expect(document.querySelector('[data-testid="composer-target-project-p-late"]')).not.toBeNull();
      // 第一次（已收起那轮）的回包迟到，带着另一个候选回来：不得覆盖当前清单。
      await act(async () => {
        releaseFirst({ items: [project("p-stale", "迟到旧候选")], nextCursor: null });
      });
      await flush(0);
      expect(document.querySelector('[data-testid="composer-target-project-p-late"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="composer-target-project-p-stale"]')).toBeNull();
    } finally { view.unmount(); }
  });
});
