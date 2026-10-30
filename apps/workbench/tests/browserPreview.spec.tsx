import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { act } from "react";
import BrowserPreviewPanel from "../src/components/BrowserPreviewPanel";
import { flush, mountReact } from "./mountApp";
import { localPreviewRestoreStore } from "../src/lib/previewRestore";
import type {
  PreviewBounds, PreviewBridge, PreviewEventPayload, PreviewHandle, PreviewNavAction, PreviewSnapshot
} from "../src/lib/previewBridge";

/**
 * 内置网页预览面板的行为断言。
 *
 * 这些用例走**假宿主**：真实的原生子窗口只能在 Windows 桌面里验（TP-08 归真机），
 * 但标签身份、迟到事件、地址拒绝、实际地址回报、停止语义与作用域释放都是纯状态机，
 * 必须在每次改动后自动复验——它们最容易在「看起来能用」的改动里悄悄坏掉。
 */

class FakeBridge implements PreviewBridge {
  readonly opened: { scope: string; url: string; bounds: PreviewBounds }[] = [];
  readonly navigated: { id: string; url: string }[] = [];
  readonly closed: string[] = [];
  readonly released: string[] = [];
  readonly navActions: PreviewNavAction[] = [];
  readonly visibility: boolean[] = [];
  readonly external: string[] = [];
  private serial = 0;
  private listener: ((payload: PreviewEventPayload) => void) | null = null;
  private readonly states = new Map<string, PreviewSnapshot>();

  private snapshotOf(handle: PreviewHandle): PreviewSnapshot {
    const found = this.states.get(handle.id);
    if (found === undefined) throw new Error("unknown preview handle");
    return found;
  }

  async open(request: { scope: string; url: string; bounds: PreviewBounds }): Promise<PreviewSnapshot> {
    this.serial += 1;
    const snapshot: PreviewSnapshot = { id: `relay-preview-${this.serial}`, generation: this.serial,
      scope: request.scope, url: request.url, title: "", loading: true, canGoBack: false, canGoForward: false };
    this.states.set(snapshot.id, snapshot);
    this.opened.push(request);
    return snapshot;
  }

  async navigate(handle: PreviewHandle, url: string): Promise<PreviewSnapshot> {
    this.navigated.push({ id: handle.id, url });
    const next = { ...this.snapshotOf(handle), url, loading: true };
    this.states.set(handle.id, next);
    return next;
  }

  async setBounds(): Promise<void> { /* jsdom 无布局：几何归真机验收 */ }
  async setVisible(_handle: PreviewHandle, visible: boolean): Promise<void> { this.visibility.push(visible); }

  async nav(handle: PreviewHandle, action: PreviewNavAction): Promise<PreviewSnapshot> {
    this.navActions.push(action);
    return this.snapshotOf(handle);
  }

  async state(handle: PreviewHandle): Promise<PreviewSnapshot> { return this.snapshotOf(handle); }

  async close(handle: PreviewHandle): Promise<void> {
    this.closed.push(handle.id);
    this.states.delete(handle.id);
  }

  async releaseScope(scope: string): Promise<number> {
    this.released.push(scope);
    return 0;
  }

  async openExternal(url: string): Promise<void> { this.external.push(url); }

  async subscribe(listener: (payload: PreviewEventPayload) => void): Promise<() => void> {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  emit(payload: PreviewEventPayload): void { this.listener?.(payload); }
  handleOf(id: string): PreviewHandle {
    const snapshot = this.states.get(id);
    if (snapshot === undefined) throw new Error(`unknown preview id ${id}`);
    return { id: snapshot.id, generation: snapshot.generation };
  }
}

const scope = "workspace-1:conversation-1";
let unmount: (() => void) | null = null;

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { unmount?.(); unmount = null; window.localStorage.clear(); });

async function mount(bridge: PreviewBridge | null, targetScope = scope) {
  const mounted = await mountReact(<BrowserPreviewPanel bridge={bridge} scope={targetScope}
    restoreStore={localPreviewRestoreStore(window.localStorage)} />);
  unmount = mounted.unmount;
  return mounted;
}

async function typeAddress(wrapper: Awaited<ReturnType<typeof mount>>["wrapper"], value: string) {
  await wrapper.get('[data-testid="preview-address"]').setValue(value);
  await wrapper.get('[data-testid="preview-address"]').trigger("keydown", { key: "Enter" });
  await flush();
}

describe("内置网页预览面板", () => {
  it("没有桌面宿主时如实说明不可用，不退化成为 iframe", async () => {
    const { wrapper } = await mount(null);
    expect(wrapper.get('[data-testid="browser-preview-unavailable"]').text()).toContain("桌面应用");
    expect(wrapper.element?.querySelector("iframe")).toBeNull();
    expect(wrapper.find('[data-testid="preview-address"]').exists()).toBe(false);
  });

  it("拒绝非 http/https 地址，且不向宿主发起打开请求", async () => {
    const bridge = new FakeBridge();
    const { wrapper } = await mount(bridge);
    await typeAddress(wrapper, "javascript:alert(1)");
    expect(bridge.opened.length).toBe(0);
    expect(wrapper.get('[data-testid="preview-notice"]').text()).toContain("http");
  });

  it("用户确认后才导航，并把宿主回报的实际地址显示出来", async () => {
    const bridge = new FakeBridge();
    const { wrapper } = await mount(bridge);
    await typeAddress(wrapper, "https://example.com/start");
    expect(bridge.opened.length).toBe(1);
    expect(bridge.opened[0]!.scope).toBe(scope);

    const handle = bridge.handleOf("relay-preview-1");
    await act(async () => {
      bridge.emit({ id: handle.id, generation: handle.generation, kind: "LOAD_STARTED", url: "https://example.com/start" });
      bridge.emit({ id: handle.id, generation: handle.generation, kind: "LOAD_FINISHED",
        url: "https://example.com/after-redirect", title: "落地页" });
    });
    await flush();
    expect(wrapper.get('[data-testid="preview-actual-url"]').text()).toContain("https://example.com/after-redirect");
    expect(wrapper.get('[data-testid="preview-tab-0"]').text()).toContain("落地页");
  });

  it("多个标签各自持有实例，关闭一个不影响另一个", async () => {
    const bridge = new FakeBridge();
    const { wrapper } = await mount(bridge);
    await typeAddress(wrapper, "https://a.example/");
    await wrapper.get('[data-testid="preview-tab-new"]').trigger("click");
    await flush();
    await typeAddress(wrapper, "https://b.example/");
    expect(bridge.opened.map((item) => item.url)).toEqual(["https://a.example/", "https://b.example/"]);

    const first = bridge.handleOf("relay-preview-1");
    const second = bridge.handleOf("relay-preview-2");
    await act(async () => {
      bridge.emit({ id: first.id, generation: first.generation, kind: "LOAD_FINISHED", url: "https://a.example/", title: "A 站" });
      bridge.emit({ id: second.id, generation: second.generation, kind: "LOAD_FINISHED", url: "https://b.example/", title: "B 站" });
    });
    await flush();
    expect(wrapper.get('[data-testid="preview-tab-0"]').text()).toContain("A 站");
    expect(wrapper.get('[data-testid="preview-tab-1"]').text()).toContain("B 站");

    await wrapper.get('[data-testid="preview-tab-close-0"]').trigger("click");
    await flush();
    expect(bridge.closed).toEqual([first.id]);
    // 关掉第一个标签后只剩一个标签，它回到索引 0 并保留自己的身份。
    expect(wrapper.find('[data-testid="preview-tab-1"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="preview-tab-0"]').text()).toContain("B 站");
  });

  it("关闭标签后迟到的旧事件被丢弃，不覆盖当前页面", async () => {
    const bridge = new FakeBridge();
    const { wrapper } = await mount(bridge);
    await typeAddress(wrapper, "https://a.example/");
    const stale = bridge.handleOf("relay-preview-1");
    await wrapper.get('[data-testid="preview-tab-close-0"]').trigger("click");
    await flush();
    await typeAddress(wrapper, "https://b.example/");
    const fresh = bridge.handleOf("relay-preview-2");
    await act(async () => {
      bridge.emit({ id: fresh.id, generation: fresh.generation, kind: "LOAD_FINISHED", url: "https://b.example/", title: "新页面" });
      // 已关闭实例的迟到事件：generation 与 id 都不再匹配任何标签。
      bridge.emit({ id: stale.id, generation: stale.generation, kind: "LOAD_FINISHED", url: "https://stale.example/", title: "旧页面" });
    });
    await flush();
    expect(wrapper.get('[data-testid="preview-tab-0"]').text()).toContain("新页面");
    // 地址栏展示会去掉根路径的尾斜杠，这里按展示形态断言。
    expect(wrapper.get('[data-testid="preview-actual-url"]').text()).toContain("https://b.example");
  });

  it("被拒绝的跳转只报原因，不把当前页面说成加载失败", async () => {
    const bridge = new FakeBridge();
    const { wrapper } = await mount(bridge);
    await typeAddress(wrapper, "https://a.example/");
    const handle = bridge.handleOf("relay-preview-1");
    await act(async () => {
      bridge.emit({ id: handle.id, generation: handle.generation, kind: "LOAD_FINISHED", url: "https://a.example/", title: "A 站" });
      bridge.emit({ id: handle.id, generation: handle.generation, kind: "NAVIGATION_BLOCKED",
        url: "http://127.0.0.1:5173/", reason: "这是工作台前端的开发服务器地址，不能作为预览页打开。" });
    });
    await flush();
    expect(wrapper.get('[data-testid="preview-notice"]').text()).toContain("开发服务器");
    expect(wrapper.element?.querySelector('[data-testid="browser-preview"]')?.getAttribute("data-preview-status")).toBe("READY");
  });

  it("停止加载走宿主动作，并如实说明不撤销已发出的请求", async () => {
    const bridge = new FakeBridge();
    const { wrapper } = await mount(bridge);
    await typeAddress(wrapper, "https://slow.example/");
    await wrapper.get('[data-testid="preview-stop"]').trigger("click");
    await flush();
    expect(bridge.navActions).toEqual(["STOP"]);
    expect(wrapper.get('[data-testid="preview-stopped"]').text()).toContain("不撤销");
  });

  it("页面进程异常退出有独立反馈，与加载超时区分", async () => {
    const bridge = new FakeBridge();
    const { wrapper } = await mount(bridge);
    await typeAddress(wrapper, "https://crash.example/");
    const handle = bridge.handleOf("relay-preview-1");
    await act(async () => {
      bridge.emit({ id: handle.id, generation: handle.generation, kind: "CRASHED", reason: "RENDER_PROCESS_EXITED" });
    });
    await flush();
    expect(wrapper.get('[data-testid="preview-crashed"]').text()).toContain("进程异常退出");
  });

  it("切换作用域释放旧实例，并清空标签", async () => {
    const bridge = new FakeBridge();
    const { wrapper, rerender } = await mount(bridge);
    await typeAddress(wrapper, "https://a.example/");
    expect(bridge.opened.length).toBe(1);

    await rerender(<BrowserPreviewPanel bridge={bridge} scope="workspace-1:conversation-2"
      restoreStore={localPreviewRestoreStore(window.localStorage)} />);
    await flush();
    expect(bridge.released).toContain(scope);
    // 新作用域从空白标签开始，不继承上一段会话的页面。
    expect(wrapper.get('[data-testid="preview-status-line"]').text()).toContain("尚未打开网页");
    expect(wrapper.get('[data-testid="preview-tab-0"]').text()).toContain("新标签页");
  });

  it("恢复提示只给来源，点击只填地址栏，加载仍需用户确认", async () => {
    const store = localPreviewRestoreStore(window.localStorage);
    store.write(scope, { entries: [{ origin: "https://restored.example" }], selected: 0 });
    const bridge = new FakeBridge();
    const { wrapper } = await mount(bridge);
    expect(wrapper.get('[data-testid="preview-restore"]').text()).toContain("1 个网站");

    await wrapper.get('[data-testid="preview-restore-https://restored.example"]').trigger("click");
    await flush();
    expect((wrapper.get('[data-testid="preview-address"]').element as HTMLInputElement).value).toBe("https://restored.example");
    expect(bridge.opened.length).toBe(0);
  });

  it("外部打开把当前实际地址交给宿主入口", async () => {
    const bridge = new FakeBridge();
    const { wrapper } = await mount(bridge);
    await typeAddress(wrapper, "https://a.example/x");
    await wrapper.get('[data-testid="preview-external"]').trigger("click");
    await flush();
    expect(bridge.external).toEqual(["https://a.example/x"]);
  });
});

/**
 * P0-1 恢复描述一致性反例。
 *
 * 已发现的问题：面板初始化会读取已有恢复来源，但持久化 Effect 用**初始空白标签状态**
 * 写盘——`store.write` 收到空 entries 会删掉该作用域的描述。表现为：第一次挂载时
 * 恢复提示还在（state 已读），刷新/重挂后消失；切作用域时还会把旧会话的来源
 * 瞬写进新作用域。正确口径：初始化空态与作用域切换都不写盘，只有用户真的打开过
 * 页面或关掉带页面的标签才持久化（后者覆盖「关闭全部后的显式清空」）。
 */
describe("内置网页预览的恢复描述一致性", () => {
  it("连续挂载、卸载、重载后恢复来源仍然正确，初始化不删恢复描述", async () => {
    const store = localPreviewRestoreStore(window.localStorage);
    store.write(scope, { entries: [{ origin: "https://restored.example" }], selected: 0 });
    const bridge = new FakeBridge();

    const first = await mount(bridge);
    // 第一次挂载就可能触发缺陷：持久化 Effect 拿空白初始态写盘，把描述删掉。
    expect(store.read(scope).entries.map((entry) => entry.origin)).toEqual(["https://restored.example"]);
    first.unmount();

    const second = await mount(bridge);
    expect(second.wrapper.get('[data-testid="preview-restore"]').text()).toContain("1 个网站");
    // 点恢复芯片只填地址栏：不发起加载，也不该把恢复描述删掉。
    await second.wrapper.get('[data-testid="preview-restore-https://restored.example"]').trigger("click");
    await flush();
    expect(bridge.opened.length).toBe(0);
    second.unmount();

    const third = await mount(bridge);
    expect(third.wrapper.get('[data-testid="preview-restore"]').text()).toContain("1 个网站");
    expect(store.read(scope).entries.map((entry) => entry.origin)).toEqual(["https://restored.example"]);
  });

  it("切换作用域不串页：旧会话来源不写进新作用域，新作用域已有描述不被删除", async () => {
    const otherScope = "workspace-1:conversation-2";
    const store = localPreviewRestoreStore(window.localStorage);
    store.write(otherScope, { entries: [{ origin: "https://other-restore.example" }], selected: 0 });
    const bridge = new FakeBridge();
    const { wrapper, rerender } = await mount(bridge);
    await typeAddress(wrapper, "https://a.example/");
    expect(store.read(scope).entries.map((entry) => entry.origin)).toEqual(["https://a.example"]);

    await rerender(<BrowserPreviewPanel bridge={bridge} scope={otherScope} restoreStore={store} />);
    await flush();
    // 新作用域从空白标签开始，不继承上一段会话的页面。
    expect(wrapper.get('[data-testid="preview-status-line"]').text()).toContain("尚未打开网页");
    // 新作用域自己的恢复描述仍在，且没有被旧会话的来源污染。
    expect(store.read(otherScope).entries.map((entry) => entry.origin)).toEqual(["https://other-restore.example"]);
    expect(wrapper.get('[data-testid="preview-restore"]').text()).toContain("1 个网站");
    // 旧作用域的描述不因切换丢失，切回来仍可恢复。
    expect(store.read(scope).entries.map((entry) => entry.origin)).toEqual(["https://a.example"]);
    await rerender(<BrowserPreviewPanel bridge={bridge} scope={scope} restoreStore={store} />);
    await flush();
    expect(wrapper.get('[data-testid="preview-restore"]').text()).toContain("1 个网站");
  });

  it("用户关闭全部标签后恢复描述被显式清空（与初始化空态区分）", async () => {
    const store = localPreviewRestoreStore(window.localStorage);
    const bridge = new FakeBridge();
    const { wrapper } = await mount(bridge);
    await typeAddress(wrapper, "https://a.example/");
    expect(store.read(scope).entries.map((entry) => entry.origin)).toEqual(["https://a.example"]);
    await wrapper.get('[data-testid="preview-tab-close-0"]').trigger("click");
    await flush();
    expect(store.read(scope).entries).toEqual([]);
  });

  it("多标签来源按顺序恢复，且只存来源不存 path/query/fragment", async () => {
    const store = localPreviewRestoreStore(window.localStorage);
    const bridge = new FakeBridge();
    const { wrapper } = await mount(bridge);
    await typeAddress(wrapper, "https://a.example/first?token=secret");
    await wrapper.get('[data-testid="preview-tab-new"]').trigger("click");
    await flush();
    await typeAddress(wrapper, "https://b.example/second#frag");
    expect(store.read(scope).entries.map((entry) => entry.origin)).toEqual(["https://a.example", "https://b.example"]);
  });
});

/**
 * 空白态的边框（2026-10-30 用户指认「网页预览空白态是一整块占满视口的大型空边框」）。
 *
 * jsdom 不加载样式表，因此直接核对规则本身：空白/已停止/崩溃三态把 `.preview-surface`
 * 的边框与底色收掉，但**不动尺寸**——首次导航前 `open()` 量的就是这块矩形，
 * 收边框不能顺手把原生子窗口的落位几何改小。
 */
describe("网页预览空白态不画大空框", () => {
  const css = readFileSync(`${process.cwd()}/src/components/BrowserPreviewPanel.css`, "utf8");
  const blankRule = css.match(
    /\.preview-panel\[data-preview-status="BLANK"\] \.preview-surface,[\s\S]*?\}/u)?.[0] ?? "";

  it("空白/已停止/崩溃三态都收掉边框与底色", () => {
    expect(blankRule).toContain('[data-preview-status="BLANK"]');
    expect(blankRule).toContain('[data-preview-status="STOPPED"]');
    expect(blankRule).toContain('[data-preview-status="CRASHED"]');
    expect(blankRule).toMatch(/border-color:\s*transparent/u);
    expect(blankRule).toMatch(/background:\s*transparent/u);
    // 只改视觉：尺寸与流式占位仍由 `.preview-surface` 自己决定。
    expect(blankRule).not.toMatch(/(min-height|height|flex):/u);
  });

  it("加载中与已就绪仍保留容器边框", () => {
    expect(blankRule).not.toContain('[data-preview-status="LOADING"]');
    expect(blankRule).not.toContain('[data-preview-status="READY"]');
  });
});
