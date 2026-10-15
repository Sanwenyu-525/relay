import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskInspectorPanel, { type TaskInspectorPanelProps } from "../src/components/TaskInspectorPanel";
import TaskViewDashboard from "../src/components/TaskViewDashboard";
import type { RelayApiClient, RelayArtifact, RelayRun, RelayTaskArtifacts, RelayTaskDetail } from "../src/api/relayClient";
import { RelayApiError } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

const task = { id: "task-a", projectId: "project-a", title: "页面重构", status: "IN_PROGRESS", revision: "4",
  executor: "AI", currentCompletionId: null, unresolvedBlockerIds: [], waitingReason: null,
  acceptance: { acceptanceRevision: "3", objective: "保持可读", criteria: [{ criterionId: "c1", statement: "验收条件不是成果" }] }
} as unknown as RelayTaskDetail;
const versions = [1, 2].map((n) => ({ artifactVersionId: `version-${n}`, versionNumber: String(n),
  mediaType: "text/markdown", sha256: String(n).repeat(64), size: "120", sourceKind: "HUMAN", createdAt: "2026-10-15T01:00:00Z" }));
const artifact: RelayArtifact = { id: "artifact-a", taskId: task.id, title: "成果.md", revision: "2",
  latestVersionId: "version-2", versionCount: 2, versions };
const saved: RelayTaskArtifacts = { items: [artifact], currentAcceptedVersionIds: ["version-1"] };
let cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
});
afterEach(() => { cleanups.forEach((cleanup) => cleanup()); cleanups = []; vi.unstubAllGlobals(); });

function setup(overrides: Partial<TaskInspectorPanelProps> = {}) {
  const read = vi.fn().mockResolvedValue(saved);
  const content = vi.fn().mockResolvedValue("# 确切 v2 正文");
  const props: TaskInspectorPanelProps = { client: { getTaskArtifacts: read, getArtifactVersionContent: content } as unknown as RelayApiClient,
    task, run: null, projectTitle: "项目", folder: null, mode: "AGENT", selectedArtifact: null,
    onSelectArtifactVersion: vi.fn(), onCloseFilePreview: vi.fn(), onClose: vi.fn(), ...overrides };
  return { props, read, content };
}
async function mount(props: TaskInspectorPanelProps) {
  const mounted = await mountReact(<TaskInspectorPanel {...props} />);
  cleanups.push(mounted.unmount);
  return mounted;
}

describe("工作详情的真实版本阅读", () => {
  it("只列真实成果，最新版本不继承另一版本的完成引用", async () => {
    const { props } = setup({ task: { ...task, currentCompletionId: "completion-a" } });
    const { wrapper } = await mount(props);
    await wrapper.get('[data-testid="collab-inspector-tab-RESULTS"]').trigger("click");
    const file = wrapper.get('[data-testid="collab-inspector-asset-artifact-a"]');
    expect(file.text()).toContain("成果.md");
    expect(file.text()).toContain("v2");
    expect(file.text()).toContain("当前完成凭据未引用此版本");
    expect(wrapper.text()).not.toContain("验收条件不是成果");
    await file.trigger("click");
    expect(props.onSelectArtifactVersion).toHaveBeenCalledWith(artifact, versions[1], file.element);
  });

  it("预览按确切版本读取并展示来源，不以 Task 完成替代版本验证", async () => {
    const { props, content } = setup({ selectedArtifact: { artifact, version: versions[1]! },
      task: { ...task, currentCompletionId: "completion-a" } });
    const { wrapper } = await mount(props);
    expect(content).toHaveBeenCalledWith("version-2");
    expect(wrapper.text()).toContain("确切 v2 正文");
    await wrapper.get('[role="tab"][aria-selected="true"]').trigger("keydown", { key: "End" });
    expect(wrapper.text()).toContain("version-2");
    expect(wrapper.text()).toContain("当前完成凭据未引用此版本");
    expect(wrapper.text()).toContain("未在此面板采集确切版本的验证结果");
    expect(wrapper.text()).not.toContain("示例内容");
  });

  it("成果读取失败与空态分开，并允许重读", async () => {
    const { props, read } = setup();
    read.mockRejectedValueOnce(new Error("清单暂不可读")).mockResolvedValueOnce(saved);
    const { wrapper } = await mount(props);
    await wrapper.get('[data-testid="collab-inspector-tab-RESULTS"]').trigger("click");
    expect(wrapper.text()).toContain("成果读取失败");
    expect(wrapper.text()).not.toContain("当前任务没有已保存");
    await wrapper.get('[data-testid="collab-inspector-artifacts-error"] button').trigger("click");
    expect(wrapper.find('[data-testid="collab-inspector-asset-artifact-a"]').exists()).toBe(true);
  });

  it("确实为空时不将验收条件转换成文件", async () => {
    const { props, read } = setup(); read.mockResolvedValue({ items: [], currentAcceptedVersionIds: [] });
    const { wrapper } = await mount(props);
    await wrapper.get('[data-testid="collab-inspector-tab-RESULTS"]').trigger("click");
    expect(wrapper.text()).toContain("当前任务没有已保存");
    expect(wrapper.findAll(".inspector-asset")).toHaveLength(0);
  });

  it("正文读取失败不显示假正文，原版本可以重读", async () => {
    const { props, content } = setup({ selectedArtifact: { artifact, version: versions[1]! } });
    content.mockRejectedValueOnce(new Error("正文暂不可读")).mockResolvedValueOnce("# 重读 v2 成功");
    const { wrapper } = await mount(props);
    expect(wrapper.text()).toContain("所选版本正文读取失败");
    expect(wrapper.find(".inspector-paper").exists()).toBe(false);
    await wrapper.get('[role="alert"] button').trigger("click");
    expect(wrapper.text()).toContain("重读 v2 成功");
    expect(content.mock.calls).toEqual([["version-2"], ["version-2"]]);
  });

  it("正文不可用只描述读取失败，不套用完成命令的拒绝文案", async () => {
    const { props, content } = setup({ selectedArtifact: { artifact, version: versions[1]! } });
    content.mockRejectedValue(new RelayApiError({ status: 409, code: "EVIDENCE_UNAVAILABLE", detail: "Content unavailable",
      retryable: false, fieldErrors: [], retryAction: null, expectedRevision: null, actualRevision: null, blockingReasons: [] }));
    const { wrapper } = await mount(props);
    expect(wrapper.text()).toContain("这个版本的正文当前不可读取");
    expect(wrapper.text()).not.toContain("完成被拒绝");
  });

  it("切换任务后迟到正文不能出现在新任务中", async () => {
    const { props, content } = setup({ selectedArtifact: { artifact, version: versions[1]! } });
    let resolveOld!: (value: string) => void;
    content.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveOld = resolve; }));
    const { wrapper, rerender } = await mount(props);
    await rerender(<TaskInspectorPanel {...props} task={{ ...task, id: "task-b", title: "新任务" }} />);
    await act(async () => resolveOld("旧任务私有正文"));
    expect(wrapper.text()).toContain("新任务");
    expect(wrapper.text()).not.toContain("旧任务私有正文");
    expect(wrapper.text()).not.toContain("成果.md");
  });

  it("完成引用读取失败不能转换成确定的未引用结论", async () => {
    const { props, read } = setup({ selectedArtifact: { artifact, version: versions[1]! },
      task: { ...task, currentCompletionId: "completion-a" } });
    read.mockRejectedValue(new Error("引用暂不可读"));
    const { wrapper } = await mount(props);
    await wrapper.get('[role="tab"][aria-selected="true"]').trigger("keydown", { key: "End" });
    expect(wrapper.text()).toContain("当前完成凭据版本引用读取失败");
    expect(wrapper.text()).not.toContain("当前完成凭据未引用此版本");
  });

  it("页签方向键、Home/End 与 panel 关联一致", async () => {
    const { props } = setup(); const { wrapper } = await mount(props);
    await wrapper.get('[data-testid="collab-inspector-tab-PROGRESS"]').trigger("keydown", { key: "ArrowRight" });
    const results = wrapper.get('[data-testid="collab-inspector-tab-RESULTS"]');
    expect(results.attributes("aria-selected")).toBe("true");
    expect(results.attributes("tabindex")).toBe("0");
    expect(wrapper.get('[role="tabpanel"]').attributes("aria-labelledby")).toBe(results.attributes("id"));
    await results.trigger("keydown", { key: "End" });
    expect(wrapper.get('[data-testid="collab-inspector-tab-RECORDS"]').attributes("aria-selected")).toBe("true");
    await wrapper.get('[data-testid="collab-inspector-tab-RECORDS"]').trigger("keydown", { key: "Home" });
    expect(wrapper.get('[data-testid="collab-inspector-tab-PROGRESS"]').attributes("aria-selected")).toBe("true");
  });

  it("任务版本更新会刷新清单，同时保持打开的确切正文版本", async () => {
    const { props, read, content } = setup({ selectedArtifact: { artifact, version: versions[1]! } });
    const { wrapper, rerender } = await mount(props);
    await rerender(<TaskInspectorPanel {...props} task={{ ...task, revision: "5" }} />);
    expect(read).toHaveBeenCalledTimes(2);
    expect(content).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain("确切 v2 正文");
  });

  it("运行失败不推断为检查失败，未知动作仍优先提示核对", async () => {
    const run = { id: "run-a", status: "FAILED", steps: [], unresolvedOperationIds: ["operation-a"] } as unknown as RelayRun;
    const { props } = setup({ run }); const { wrapper } = await mount(props);
    expect(wrapper.text()).toContain("外部结果待核对");
    expect(wrapper.text()).not.toContain("检查未通过");
  });

  it("缺少完成凭据时不以成功色显示正式完成", async () => {
    const { props } = setup({ task: { ...task, status: "DONE", currentCompletionId: null } });
    const { wrapper } = await mount(props);
    expect(wrapper.text()).toContain("完成凭据待核对");
    expect(wrapper.find(".inspector-badge--success").exists()).toBe(false);
  });
});

it("任务概览不会将 Run 结束或缺少步骤换算成任务完成和虚构进度", async () => {
  const { props } = setup();
  const run = { id: "run-a", status: "COMPLETED", steps: [] } as unknown as RelayRun;
  const mounted = await mountReact(<TaskViewDashboard client={props.client} task={task} run={run} projectTitle="项目"
    reviews={[]} openReview={null} reviewError={null} reviewWriteBlockedReason={null} projectWriteBlockedReason={null}
    onReviewNavigationStateChange={vi.fn()} onRefresh={vi.fn()} onSelectFileForPreview={vi.fn()}
    onSwitchToChat={vi.fn()} onOpenInspector={vi.fn()} />);
  cleanups.push(mounted.unmount); await flush(1);
  expect(mounted.wrapper.find('[data-testid="collab-completed-card"]').exists()).toBe(false);
  expect(mounted.wrapper.find('[role="progressbar"]').exists()).toBe(false);
  expect(mounted.wrapper.text()).toContain("Run 已结束");
});

it("人工完成且无 Run 的任务不声称 AI 已执行所有步骤", async () => {
  const { props } = setup();
  const mounted = await mountReact(<TaskViewDashboard client={props.client}
    task={{ ...task, status: "DONE", executor: "HUMAN", currentCompletionId: "completion-a" }} run={null} projectTitle="项目"
    reviews={[]} openReview={null} reviewError={null} reviewWriteBlockedReason={null} projectWriteBlockedReason={null}
    onReviewNavigationStateChange={vi.fn()} onRefresh={vi.fn()} onSelectFileForPreview={vi.fn()}
    onSwitchToChat={vi.fn()} onOpenInspector={vi.fn()} />);
  cleanups.push(mounted.unmount);
  expect(mounted.wrapper.text()).toContain("任务已有当前完成凭据");
  expect(mounted.wrapper.text()).not.toContain("所有计划步骤已执行");
  expect(mounted.wrapper.find(".task-agent-avatar").text()).toBe("我");
  expect(mounted.wrapper.find(".task-agent-status-text").text()).not.toContain("Relay Agent");
});
