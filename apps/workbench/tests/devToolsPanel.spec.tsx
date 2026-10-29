import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import DevToolsPanel from "../src/components/DevToolsPanel";
import { flush, mountReact } from "./mountApp";
import type { RelayApiClient, RelayManagedResource } from "../src/api/relayClient";

/**
 * 工具面板的整合规则（[工作台 §50.1]）：
 * 网页预览不需要项目或任务；文件与变更需要 Project 资格，缺资格时如实说明，
 * 不伪造 ID、不创建占位 Task，也不去读一个不存在的受管目录清单。
 */

// 夹具只提供面板真正读取的字段（路径、状态、修订、写身份）；其余字段不参与断言，
// 因此按 unknown 断言成领域类型，避免为凑形状编造无关值。
const resource = {
  id: "resource-1", projectId: "project-1",
  canonicalRoot: "D:/work/relay", displayName: "relay",
  status: "ACTIVE", revision: "3", fileWriteIdentityBound: true
} as unknown as RelayManagedResource;

function fakeClient(resources: readonly RelayManagedResource[] = [resource]) {
  return {
    baseUrl: "http://127.0.0.1:8787",
    workspaceId: "workspace-1",
    getManagedResources: vi.fn(async () => resources),
    getRunGatewayOperations: vi.fn(async () => [])
  } as unknown as RelayApiClient;
}

let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });

async function mount(client: RelayApiClient, projectId: string | null, taskId: string | null) {
  const mounted = await mountReact(createElement(MemoryRouter, {},
    createElement(DevToolsPanel, { client, projectId, taskId, run: null, previewBridge: null,
      previewScope: "workspace-1:conversation-1", onClose: () => undefined })));
  unmount = mounted.unmount;
  await flush();
  return mounted;
}

describe("右侧工具面板的资格与页签", () => {
  it("没有项目时不读受管目录，并如实说明文件与变更需要项目", async () => {
    const client = fakeClient();
    const { wrapper } = await mount(client, null, null);
    expect(client.getManagedResources).not.toHaveBeenCalled();
    // 2026-10-28：没有关联项目时默认落在真的能用的「网页」，而不是开局就是两张不可用说明。
    expect(wrapper.get('[data-testid="devtools-tab-WEB"]').attributes("aria-selected")).toBe("true");
    expect(wrapper.find('[data-testid="devtools-files-unavailable"]').exists()).toBe(false);

    await wrapper.get('[data-testid="devtools-tab-FILES"]').trigger("click");
    const empty = wrapper.get('[data-testid="devtools-files-unavailable"]');
    expect(empty.text()).toContain("尚未关联项目");
    expect(empty.text()).toContain("关联项目后，可查看其受管文件与 Git 变更。");
    // 安全边界收进辅助说明，不再反复解释同一个概念。
    expect(empty.text()).toContain("不推断本机任意路径");
    // 空态必须给出一条现在就能走的路，而不是让用户停在「不可用」上。
    await empty.get('[data-testid="devtools-empty-open-web"]').trigger("click");
    expect(wrapper.get('[data-testid="devtools-tab-WEB"]').attributes("aria-selected")).toBe("true");

    await wrapper.get('[data-testid="devtools-tab-GIT"]').trigger("click");
    expect(wrapper.get('[data-testid="devtools-git-unavailable"]').text()).toContain("没有可核对的目录基线");
    // 不能把「没有项目」读成「工作目录干净」。
    expect(wrapper.get('[data-testid="devtools-git-unavailable"]').text()).toContain("不是「工作目录干净」的结论");
  });

  it("没有项目时网页页签仍然可用，只是说明当前不是桌面宿主", async () => {
    const { wrapper } = await mount(fakeClient(), null, null);
    await wrapper.get('[data-testid="devtools-tab-WEB"]').trigger("click");
    await flush();
    expect(wrapper.get('[data-testid="browser-preview"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="browser-preview-unavailable"]').text()).toContain("桌面应用");
  });

  it("有项目时列出受管目录，并保留任务产物入口", async () => {
    const client = fakeClient();
    const { wrapper } = await mount(client, "project-1", "task-1");
    expect(client.getManagedResources).toHaveBeenCalledWith("project-1");
    expect(wrapper.get('[data-testid="devtools-files"]').text()).toContain("D:/work/relay");
    expect(wrapper.get('[data-testid="devtools-files"]').text()).toContain("打开任务产物版本");
  });

  it("终端仍如实显示未接入，不提供可执行提示符", async () => {
    const { wrapper } = await mount(fakeClient(), "project-1", "task-1");
    await wrapper.get('[data-testid="devtools-tab-TERMINAL"]').trigger("click");
    expect(wrapper.get('[data-testid="devtools-terminal-gap"]').text()).toContain("尚未确定");
    expect(wrapper.element?.querySelector('[data-testid="devtools-terminal"] input')).toBeNull();
  });

  it("收起入口只有一颗，位于页签条右端而不是底部抽屉", async () => {
    const { wrapper } = await mount(fakeClient(), "project-1", "task-1");
    const root = wrapper.element!;
    const closes = root.querySelectorAll('[data-testid="devtools-close"]');
    // 底部「执行输出」抽屉不再自带同义键：全面板只留一颗，避免两个收起入口。
    expect(closes.length).toBe(1);
    expect(root.querySelector(".devtools-header")?.contains(closes[0]!)).toBe(true);
    expect(root.querySelector(".devtools-drawer-bar")?.contains(closes[0]!)).toBe(false);
  });

  it("网页页签切走再切回不重建面板，标签状态得以保留", async () => {
    const { wrapper } = await mount(fakeClient(), "project-1", "task-1");
    await wrapper.get('[data-testid="devtools-tab-WEB"]').trigger("click");
    await flush();
    // 面板保持挂载（hidden 而不是条件渲染）：切走再切回拿到的是同一棵子树，
    // 真实宿主里这意味着标签与容器都不会被重建、也不会重新加载页面。
    const first = wrapper.get('[data-testid="browser-preview"]').element;
    expect(first).not.toBeNull();
    await wrapper.get('[data-testid="devtools-tab-FILES"]').trigger("click");
    expect(wrapper.get('[data-testid="devtools-tab-WEB"]').attributes("aria-selected")).toBe("false");
    await wrapper.get('[data-testid="devtools-tab-WEB"]').trigger("click");
    await flush();
    expect(wrapper.get('[data-testid="browser-preview"]').element).toBe(first);
  });
});
