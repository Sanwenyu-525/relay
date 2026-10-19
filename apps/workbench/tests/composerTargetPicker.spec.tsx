import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import ComposerTargetPicker from "../src/components/ComposerTargetPicker";
import type { RelayApiClient } from "../src/api/relayClient";
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

function stubClient(overrides: Partial<Record<"getProjectsPage" | "getProjectTasks", unknown>> = {}) {
  return {
    getProjectsPage: vi.fn(async () => projects),
    getProjectTasks: vi.fn(async () => tasks),
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

describe("输入器的目标芯片", () => {
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
      expect(client.getProjectTasks).not.toHaveBeenCalled();
      await click(row("composer-target-project-p-1"));
      await flush(0);
      expect(client.getProjectTasks).toHaveBeenCalledWith("p-1");
      expect(row("composer-target-task-t-1")?.textContent).toContain("写第 4 章");
      expect(row("composer-target-task-t-1")?.textContent).toContain("进行中");
      await click(row("composer-target-task-t-2"));
      expect(onPick).toHaveBeenCalledWith({ kind: "TASK", id: "t-2", projectId: "p-1", title: "整理参考文献" });
    } finally { view.unmount(); }
  });

  it("空清单与读取失败各有如实文案，不编造目标", async () => {
    const empty = { getProjectsPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      getProjectTasks: vi.fn(async () => []) } as unknown as RelayApiClient;
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
