import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import ModelSelector from "../src/components/ModelSelector";
import type { RelayApiClient, RelayModelCatalog } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); });
const directory: RelayModelCatalog = { configured: true, chatConfigured: true, lastSuccessAt: "2026-10-17T00:00:00Z",
  lastFailureReason: null, cacheStale: false, snapshotSeq: "9", freeCount: 1,
  models: [{ id: "v/a:free", name: "免费 A", contextWindow: 65536, tools: true, textInput: true, textOutput: true }] };
async function render(catalog = directory, directoryUnavailable = false) {
  const choose = vi.fn(); const write = vi.fn();
  const refresh = vi.fn(async () => ({ status: "PUBLISHED", reason: null }));
  const client = { getModelCatalog: async () => { if (directoryUnavailable) throw new Error("offline"); return catalog; }, refreshModelCatalog: refresh,
    getSessionModelSelection: async () => ({ model: "removed:free" }),
    getModelPortStatus: async () => ({ configured: true, model: "default-model" }),
    getChatDefaultModelConnection: async () => ({ connectionId: null, revision: null }),
    requestAssistMessage: write, selectSessionModel: write } as unknown as RelayApiClient;
  function Harness() {
    const [open, setOpen] = useState(false);
    return <ModelSelector client={client} sessionId="s1" open={open} onOpenChange={setOpen}
      selectedModel={null} onChoose={choose} />;
  }
  const view = await mountReact(<Harness />); dispose = view.unmount;
  (view.wrapper.get('[data-testid="model-selector-open"]').element as HTMLButtonElement).focus();
  await view.wrapper.get('[data-testid="model-selector-open"]').trigger("click"); await flush();
  return { view, choose, write, refresh };
}
/** 清单条目就是按钮；这里按可见名称找到它并点击。 */
async function clickItem(name: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="listbox"] [role="option"]')]
    .find((item) => item.querySelector(".model-selector-option-name")?.textContent === name);
  if (!button) throw new Error(`missing list item ${name}`);
  await act(async () => button.click()); await flush();
}
function selectedOption(): string | null {
  return document.querySelector<HTMLElement>('[role="listbox"] [aria-selected="true"] .model-selector-option-name')?.textContent ?? null;
}
function openMenu(): boolean {
  return document.querySelector(".model-selector-menu") !== null;
}

it("下拉而非弹窗：打开后没有对话框，清单锚定在触发键的下拉层里", async () => {
  await render();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(openMenu()).toBe(true);
  expect(document.querySelector(".model-selector-menu [role='listbox']")).not.toBeNull();
});

it("失效原首选只标注不可调用，目录不自动改选；点合格条目即应用并收起", async () => {
  const { choose, write } = await render();
  // 失效原首选仍在清单里标记为当前选择，但不会被自动替换成目录第一项。
  expect(selectedOption()).toBe("removed:free");
  const stale = document.querySelector<HTMLButtonElement>('[data-testid="model-selector-option-removed:free"]')!;
  expect(stale.disabled).toBe(true);
  expect(stale.getAttribute("aria-label")).toContain("已不在目录中");
  expect(document.body.textContent).toContain("最多再试 3 个合格型号");
  expect(choose).not.toHaveBeenCalled();
  await clickItem("免费 A");
  // 2026-10-17 指令：点条目就是答案，不再经过「应用到后续消息」第二步。
  expect(choose).toHaveBeenCalledWith("v/a:free");
  expect(write).not.toHaveBeenCalled();
  expect(openMenu()).toBe(false);
});

it("过期或缺凭据时免费条目禁用不可选，且不触发命令", async () => {
  const { write, choose, refresh } = await render({ ...directory, chatConfigured: false, cacheStale: true });
  const option = document.querySelector<HTMLButtonElement>('[data-testid="model-selector-option-v/a:free"]')!;
  expect(option.disabled).toBe(true);
  expect(document.body.textContent).toContain("仅供浏览");
  expect(document.body.textContent).toContain("调用凭据未配置");
  await act(async () => option.click()); await flush();
  expect(selectedOption()).toBe("removed:free");
  expect(choose).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  expect(openMenu()).toBe(true);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="model-selector-refresh"]')!.click());
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("Esc 关闭后恢复触发按钮焦点，不提交选择", async () => {
  const { view, choose } = await render();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(openMenu()).toBe(false);
  expect(document.activeElement).toBe(view.wrapper.get('[data-testid="model-selector-open"]').element);
  expect(choose).not.toHaveBeenCalled();
});

it("点下拉之外一次即收起，不提交选择", async () => {
  const { choose } = await render();
  await act(async () => document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(openMenu()).toBe(false);
  expect(choose).not.toHaveBeenCalled();
});

it("搜索无匹配与空目录分开，搜索不变更当前选择", async () => {
  const { choose, write } = await render();
  const input = document.querySelector<HTMLInputElement>(".model-selector-menu input[type='search']")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "no-such-model");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.body.textContent).toContain("没有匹配的免费模型");
  expect(document.body.textContent).not.toContain("当前没有可选的免费型号");
  // 搜索只筛清单：原当前选择与已选条目都不因过滤而改变。
  expect(selectedOption()).toBe("removed:free");
  expect(choose).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});

it("免费目录故障不妨碍明确选择原已配置模型", async () => {
  const { choose } = await render(directory, true);
  expect(document.body.textContent).toContain("免费目录读取失败");
  await clickItem("default-model");
  expect(choose).toHaveBeenCalledWith("default-model");
  expect(openMenu()).toBe(false);
});

it("清单条目只显示模型名，具体信息挂在 hover 的 title 上", async () => {
  await render();
  const option = document.querySelector<HTMLButtonElement>('[data-testid="model-selector-option-v/a:free"]')!;
  expect(option.querySelector(".model-selector-option-name")?.textContent).toBe("免费 A");
  expect(option.textContent).toBe("免费 A");
  expect(option.title).toContain("v/a:free");
  expect(option.title).toContain("上下文：65,536");
  expect(option.title).toContain("工具：支持");
});

it("首条消息场景：点击清单条目直接写入本地选择并关闭", async () => {
  const choose = vi.fn();
  const client = { getModelCatalog: async () => directory, refreshModelCatalog: async () => ({ status: "PUBLISHED", reason: null }),
    getModelPortStatus: async () => ({ configured: true, model: "default-model" }),
    getChatDefaultModelConnection: async () => ({ connectionId: null, revision: null }),
    getSessionModelSelection: async () => null } as unknown as RelayApiClient;
  function Harness() {
    const [open, setOpen] = useState(true);
    return <ModelSelector client={client} open={open} onOpenChange={setOpen}
      selectedModel={null} onChoose={choose} />;
  }
  const view = await mountReact(<Harness />); dispose = view.unmount; await flush();
  await clickItem("免费 A");
  expect(choose).toHaveBeenCalledWith("v/a:free");
  expect(document.querySelector(".model-selector-menu")).toBeNull();
});

/** 挂载不打开下拉的渲染：芯片文本与 title 就是用户在这一行看到的全部。 */
function triggerName(): string | null {
  return document.querySelector(".model-selector-trigger-name")?.textContent ?? null;
}

it("没有显式选择时芯片说「跟随默认」，不是「模型」占位（2026-11-04 取代 2026-10-21 的写法）", async () => {
  const client = { getModelCatalog: async () => directory, refreshModelCatalog: async () => ({ status: "PUBLISHED", reason: null }),
    getModelPortStatus: async () => ({ configured: true, model: "default-model" }),
    getChatDefaultModelConnection: async () => ({ connectionId: null, revision: null }),
    getSessionModelSelection: async () => null } as unknown as RelayApiClient;
  function Harness() {
    const [open, setOpen] = useState(false);
    return <ModelSelector client={client} sessionId="s1" open={open} onOpenChange={setOpen}
      selectedModel={null} onChoose={vi.fn()} />;
  }
  const view = await mountReact(<Harness />); dispose = view.unmount; await flush();
  expect(triggerName()).toBe("跟随默认");
  expect(document.querySelector('[data-testid="model-selector-open"]')?.getAttribute("title"))
    .toContain("跟随工作区默认");
});

it("服务端没有应用默认时才退回「模型」占位，不谎报型号", async () => {
  const client = { getModelCatalog: async () => directory, refreshModelCatalog: async () => ({ status: "PUBLISHED", reason: null }),
    getModelPortStatus: async () => ({ configured: false, model: null }),
    getChatDefaultModelConnection: async () => ({ connectionId: null, revision: null }),
    getSessionModelSelection: async () => null } as unknown as RelayApiClient;
  function Harness() {
    const [open, setOpen] = useState(false);
    return <ModelSelector client={client} sessionId="s1" open={open} onOpenChange={setOpen}
      selectedModel={null} onChoose={vi.fn()} />;
  }
  const view = await mountReact(<Harness />); dispose = view.unmount; await flush();
  expect(triggerName()).toBe("跟随默认");
});

it("会话显式选择优先于应用默认，本机记忆不冒充会话事实", async () => {
  const client = { getModelCatalog: async () => directory, refreshModelCatalog: async () => ({ status: "PUBLISHED", reason: null }),
    getModelPortStatus: async () => ({ configured: true, model: "default-model" }),
    getChatDefaultModelConnection: async () => ({ connectionId: null, revision: null }),
    getSessionModelSelection: async () => ({ model: "v/a:free" }) } as unknown as RelayApiClient;
  function Harness() {
    const [open, setOpen] = useState(false);
    return <ModelSelector client={client} sessionId="s1" open={open} onOpenChange={setOpen}
      selectedModel={"v/a:free"} onChoose={vi.fn()} />;
  }
  const view = await mountReact(<Harness />); dispose = view.unmount; await flush();
  expect(triggerName()).toBe("v/a:free");
});

/** 已登记连接的最小 DTO：界面只看身份、名称、型号与启停状态。 */
function connection(id: string, name: string, model: string, status: "ACTIVE" | "DISABLED") {
  return { id, name, providerKind: "openai-compatible", baseUrl: "https://fixture.invalid/v1",
    defaultModel: model, budget: { timeoutMs: 1, maxOutputTokens: 1, maxCallTokens: 1,
      maxScopeCalls: 1, maxScopeTokens: 1 }, credentialVersion: 1, status,
    revision: "1", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z" };
}

it("已登记连接独立成段：启用可选、停用禁用，点选按连接身份提交", async () => {
  const choose = vi.fn(); const chooseConnection = vi.fn();
  const client = { getModelCatalog: async () => directory,
    refreshModelCatalog: async () => ({ status: "PUBLISHED", reason: null }),
    getModelPortStatus: async () => ({ configured: true, model: "default-model" }),
    getChatDefaultModelConnection: async () => ({ connectionId: null, revision: null }),
    getSessionModelSelection: async () => null,
    listModelConnections: async () => [connection("conn-1", "团队网关", "vendor/registered", "ACTIVE"),
      connection("conn-2", "停用网关", "vendor/old", "DISABLED")] } as unknown as RelayApiClient;
  function Harness() {
    const [open, setOpen] = useState(true);
    return <ModelSelector client={client} sessionId="s1" open={open} onOpenChange={setOpen}
      selectedModel={null} onChoose={choose} onChooseConnection={chooseConnection} />;
  }
  const view = await mountReact(<Harness />); dispose = view.unmount; await flush();
  expect(document.querySelector('[role="group"][aria-label="已登记连接"]')).not.toBeNull();
  const disabled = document.querySelector<HTMLButtonElement>('[data-testid="model-selector-option-conn-2"]')!;
  expect(disabled.disabled).toBe(true);
  expect(disabled.getAttribute("aria-label")).toContain("已停用");
  const active = document.querySelector<HTMLButtonElement>('[data-testid="model-selector-option-conn-1"]')!;
  expect(active.disabled).toBe(false);
  expect(active.title).toContain("型号：vendor/registered");
  await clickItem("团队网关");
  expect(chooseConnection).toHaveBeenCalledWith(expect.objectContaining({ id: "conn-1",
    defaultModel: "vendor/registered" }));
  expect(choose).not.toHaveBeenCalled();
  expect(openMenu()).toBe(false);
});

it("连接读取失败只告警，不阻断目录型号选择", async () => {
  const choose = vi.fn();
  const client = { getModelCatalog: async () => directory,
    refreshModelCatalog: async () => ({ status: "PUBLISHED", reason: null }),
    getModelPortStatus: async () => ({ configured: true, model: "default-model" }),
    getChatDefaultModelConnection: async () => ({ connectionId: null, revision: null }),
    getSessionModelSelection: async () => null,
    listModelConnections: async () => { throw new Error("offline"); } } as unknown as RelayApiClient;
  function Harness() {
    const [open, setOpen] = useState(true);
    return <ModelSelector client={client} sessionId="s1" open={open} onOpenChange={setOpen}
      selectedModel={null} onChoose={choose} onChooseConnection={vi.fn()} />;
  }
  const view = await mountReact(<Harness />); dispose = view.unmount; await flush();
  expect(document.body.textContent).toContain("已登记连接读取失败");
  await clickItem("免费 A");
  expect(choose).toHaveBeenCalledWith("v/a:free");
});

it("「跟随工作区默认」清掉显式选择，并如实显示聊天默认的型号来源", async () => {
  const followDefault = vi.fn();
  const client = { getModelCatalog: async () => directory,
    refreshModelCatalog: async () => ({ status: "PUBLISHED", reason: null }),
    getModelPortStatus: async () => ({ configured: true, model: "process-default" }),
    getChatDefaultModelConnection: async () => ({ connectionId: "conn-chat", revision: "3" }),
    getSessionModelSelection: async () => ({ model: "v/a:free", connectionId: null }),
    listModelConnections: async () => [connection("conn-chat", "聊天默认", "chat-default-model", "ACTIVE")]
  } as unknown as RelayApiClient;
  function Harness() {
    const [open, setOpen] = useState(true);
    return <ModelSelector client={client} sessionId="s1" open={open} onOpenChange={setOpen}
      selectedModel={"v/a:free"} onChoose={vi.fn()} onChooseConnection={vi.fn()}
      onFollowDefault={followDefault} />;
  }
  const view = await mountReact(<Harness />); dispose = view.unmount; await flush();
  const entry = document.querySelector<HTMLButtonElement>(
    '[data-testid="model-selector-option-follow-default"]')!;
  expect(entry).not.toBeNull();
  expect(entry.textContent).toContain("跟随工作区默认");
  // 说明里写的是**聊天默认连接**的型号，不是进程默认——两者不能互相冒充。
  expect(entry.title).toContain("chat-default-model");
  expect(entry.title).not.toContain("process-default");
  await clickItem("跟随工作区默认");
  expect(followDefault).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".model-selector-menu")).toBeNull();
});

it("没有显式选择时芯片说「跟随默认」；打开后写清解析到的聊天默认型号，不拿进程默认顶替", async () => {
  const client = { getModelCatalog: async () => directory,
    refreshModelCatalog: async () => ({ status: "PUBLISHED", reason: null }),
    getModelPortStatus: async () => ({ configured: true, model: "process-default" }),
    getChatDefaultModelConnection: async () => ({ connectionId: "conn-chat", revision: "3" }),
    getSessionModelSelection: async () => null,
    listModelConnections: async () => [connection("conn-chat", "聊天默认", "chat-default-model", "ACTIVE")]
  } as unknown as RelayApiClient;
  function Harness() {
    const [open, setOpen] = useState(false);
    return <ModelSelector client={client} sessionId="s1" open={open} onOpenChange={setOpen}
      selectedModel={null} onChoose={vi.fn()} onChooseConnection={vi.fn()}
      onFollowDefault={vi.fn()} />;
  }
  const view = await mountReact(<Harness />); dispose = view.unmount; await flush();
  // 收起状态不猜型号，只说自己跟随默认。
  expect(triggerName()).toBe("跟随默认");
  await view.wrapper.get('[data-testid="model-selector-open"]').trigger("click"); await flush();
  // 打开后读到的是聊天默认连接声明的型号，不是进程默认。
  expect(triggerName()).toBe("跟随默认 · chat-default-model");
  const entry = document.querySelector<HTMLButtonElement>(
    '[data-testid="model-selector-option-follow-default"]')!;
  expect(entry.title).toContain("chat-default-model");
  expect(entry.title).not.toContain("process-default");
});
