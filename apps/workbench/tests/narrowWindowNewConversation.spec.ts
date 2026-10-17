import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { dialogLabels, dialogText, DomWrapper, flush, folderStripName, mountWorkbench, openWorkingDirectory, pressEscape, toolbarSessionTitle } from "./mountApp";

// 2026-10-08 窄窗/短窗「新对话」入口可发现性。
// 抽屉入口与近期工作栏入口必须共用同一条 /agent?new=… 语义：进入空白讨论，
// 不继承目录、任务或旧会话；草稿守卫沿用 App 的既有 useBlocker，不另建第二套会话状态。
// 本文件只断言行为（进入哪个上下文、草稿两个分支）；真实可见性、几何与键盘路径由
// tests/browser/narrowWindowNewConversation.spec.ts 在 Chromium 里核对。

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "66666666-6666-4666-8666-666666666666";
const root = `/api/v1/workspaces/${workspaceId}`;
const canonicalRoot = "D:\\Develop\\NarrowWindowProject";
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function readyDirectory(): unknown {
  return { canonical_root: canonicalRoot, display_name: "NarrowWindowProject", status: "READY", reason: null,
    association: { project_id: projectId, project_title: "NarrowWindowProject", project_archived: false,
      resource_id: "res-1", resource_status: "ACTIVE", file_write_identity_bound: true },
    created_project: true, created_resource: false, candidates: [],
    write_readiness: { status: "NEEDS_CONNECTION", detail: "本项目还没有绑定该目录的文件写入连接。" } };
}

/** 一条已存在的普通讨论：新对话必须不继承它。 */
const existingSession = { id: sessionId, workspace_id: workspaceId, project_id: null, task_id: null,
  title: "已有的普通讨论", status: "ACTIVE", revision: "1",
  created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z" };

async function mount(path = "/agent", options: { sessions?: boolean; directory?: boolean } = {}) {
  const withSessions = options.sessions !== false;
  activateRelayConnection({ baseUrl: "http://127.0.0.1:8787", workspaceId, bearerToken: "synthetic-token" });
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const apiPath = url.pathname;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path: apiPath, body });
      if (apiPath === `${root}/working-directories/open`) {
        return response({ command_id: body.command_id, committed_at: "2026-10-08T00:00:00Z",
          result: readyDirectory(), links: { resource: "" } });
      }
      throw new Error(`Unexpected command: ${apiPath}`);
    }
    if (apiPath === `${root}/projects/${projectId}`) {
      return response({ id: projectId, title: "NarrowWindowProject", project_type: "GENERAL", revision: "1",
        state_revision: "1", archived_at: null });
    }
    if (apiPath === `${root}/model-port`) {
      return response({ provider: "fake", configured: false, model: null, base_url: null, max_call_tokens: null });
    }
    if (apiPath === `${root}/assist-sessions`) return response({ items: withSessions ? [existingSession] : [] });
    if (apiPath === `${root}/assist-sessions/${sessionId}`) return response(existingSession);
    if (apiPath === `${root}/assist-sessions/${sessionId}/messages`) {
      return response({ items: [
        { id: "u-1", session_id: sessionId, seq: "0", role: "USER", status: "COMPLETED", intent: "DISCUSS",
          content: "旧讨论的第一句", error_code: null, sources: [], cancel_requested: false,
          usage: { input_tokens: 1, output_tokens: 1 } },
        { id: "a-1", session_id: sessionId, seq: "1", role: "ASSISTANT", status: "COMPLETED", intent: "DISCUSS",
          content: "旧讨论的第一句回复", error_code: null, sources: [], cancel_requested: false,
          usage: { input_tokens: 1, output_tokens: 1 } }] });
    }
    return response({ items: [], next_cursor: null });
  }));
  const view = await mountWorkbench(path);
  unmount = view.unmount;
  await flush(80);
  if (options.directory === true) {
    // 目录控件已搬进细条上的「更换目录」框（协作页 §3.3），框走 portal 挂在 body 上。
    await openWorkingDirectory(canonicalRoot);
    await flush(120);
  }
  return { ...view, posts };
}

async function openNavigation(view: { wrapper: DomWrapper }): Promise<void> {
  await view.wrapper.get('button[aria-label="打开导航"]').trigger("click");
  await flush();
}

/** 抽屉由 AppDialog 渲染进 document.body 的 portal，因此在 document 上找，不在挂载容器内。 */
function navigationAction(): DomWrapper {
  return new DomWrapper(document.querySelector('[data-testid="mobile-new-conversation"]'));
}

function clickButtonByText(text: string): void {
  const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent === text);
  expect(button, `找不到按钮：${text}`).toBeDefined();
  button!.click();
}

describe("窄窗抽屉里的新对话入口", () => {
  it("抽屉入口与近期工作栏入口是同一条 /agent?new=… 路径，不另建会话状态", async () => {
    const view = await mount("/agent");
    await openNavigation(view);
    const railHref = view.wrapper.get('[data-testid="context-new-conversation"]').attributes("href");
    const drawerHref = navigationAction().attributes("href");
    expect(drawerHref).toBe(railHref);
    expect(drawerHref).toMatch(/^\/agent\?new=/u);
    // 可见文字就是动作名：键盘与读屏用户不需要猜图标。
    expect(navigationAction().text()).toContain("新对话");
  });

  it("从既有会话进入新讨论：不继承旧会话与任务上下文，抽屉同时关闭", async () => {
    const view = await mount("/agent");
    expect(view.wrapper.find('[data-testid="assist-session"]').exists(), view.wrapper.text()).toBe(true);
    expect(toolbarSessionTitle()).toBe("已有的普通讨论");

    await openNavigation(view);
    await navigationAction().trigger("click");
    await flush(120);

    expect(view.router.currentRoute.value.query.new).toBeTruthy();
    // 抽屉关闭：点击动作后只剩工作区，不再压着导航层。
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // 没有选中会话，旧正文也不再出现在读区。
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="collab-session-title"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    expect(view.wrapper.text()).not.toContain("旧讨论的第一句");
    // 没有任务上下文。
    expect(view.wrapper.find('[data-testid="collab-goal"]').exists()).toBe(false);
    // 进入新讨论不发任何写命令。
    expect(view.posts).toHaveLength(0);
  });

  it("从已打开目录的讨论进入新对话：目录作用域不跟着带过去", async () => {
    const view = await mount("/agent?new=seed", { sessions: false, directory: true });
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists(), view.wrapper.text()).toBe(true);
    expect(folderStripName()).toContain("NarrowWindowProject");

    await openNavigation(view);
    await navigationAction().trigger("click");
    await flush(120);

    expect(view.router.currentRoute.value.query.new).not.toBe("seed");
    // 目录作用域清空：细条回到未选择目录，写准入说明一并消失。
    expect(folderStripName()).toBe("未选择目录");
    expect(view.wrapper.find('[data-testid="folder-write-readiness"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="collab-goal"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(false);
    // 新对话本身不新建会话，也不重复写目录。
    expect(view.posts.filter((post) => post.path === `${root}/assist-sessions`)).toHaveLength(0);
    expect(view.posts.filter((post) => post.path === `${root}/working-directories/open`)).toHaveLength(1);
  });

  it("有未发送草稿时抽屉入口被守卫拦住；留在当前工作区保留正文与会话", async () => {
    const view = await mount("/agent");
    // 普通 /agent 会续上最近会话，因此草稿落在已有会话的输入器上。
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("还没发送的想法");
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(true);

    await openNavigation(view);
    await navigationAction().trigger("click");
    await flush();
    expect(dialogText()).toContain("未保存");
    expect(dialogLabels()).toContain("保留未保存的修改");
    // 抽屉让位给草稿守卫，不叠加成两层浮层。
    expect(document.querySelector('[data-testid="mobile-new-conversation"]')).toBeNull();

    clickButtonByText("保留并继续编辑");
    await flush(120);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(view.router.currentRoute.value.query.new).toBeUndefined();
    expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value)
      .toBe("还没发送的想法");
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(true);
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(false);
    expect(view.posts).toHaveLength(0);
  });

  it("确认丢弃后才切到新讨论，切换本身不发任何命令", async () => {
    const view = await mount("/agent");
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("准备丢弃的想法");

    await openNavigation(view);
    await navigationAction().trigger("click");
    await flush();
    clickButtonByText("丢弃草稿并离开");
    await flush(120);

    expect(view.router.currentRoute.value.query.new).toBeTruthy();
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    expect(view.posts).toHaveLength(0);
  });
});

/**
 * 「保留并继续编辑」后的编辑焦点恢复（2026-10-08 缺陷回归）。
 * 用户明确选择继续编辑时，焦点必须回到触发保护的草稿编辑器并保留原光标/选区，
 * 且必须发生在守卫弹层完成关闭与默认回焦之后——否则会被默认回焦覆盖回「打开导航」。
 * 丢弃分支、抽屉 Escape 与其他弹层的回焦行为保持不变。
 * 焦点断言针对 document.activeElement 与 selection，不只看 ref 是否存在。
 */
describe("保留并继续编辑后的编辑焦点恢复", () => {
  /** 真实点击「打开导航」会把焦点带到按钮上：抽屉与守卫弹层的默认回焦都落在它，恢复不能被它盖掉。 */
  function focusMenuButton(view: { wrapper: DomWrapper }): HTMLButtonElement {
    const menuButton = view.wrapper.get('button[aria-label="打开导航"]').element as HTMLButtonElement;
    menuButton.focus();
    return menuButton;
  }

  it("已有会话输入器：保留并继续编辑后焦点与光标回到原位，可直接续写", async () => {
    const view = await mount("/agent");
    const draft = view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement;
    draft.focus();
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("还没发送的想法");
    draft.setSelectionRange(3, 3);
    const menuButton = focusMenuButton(view);

    await openNavigation(view);
    await navigationAction().trigger("click");
    await flush();
    expect(dialogText()).toContain("未保存");
    clickButtonByText("保留并继续编辑");
    await flush(120);

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const restored = view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement;
    // 焦点在编辑器上，而不是被默认回焦带回「打开导航」按钮。
    expect(document.activeElement).toBe(restored);
    expect(document.activeElement).not.toBe(menuButton);
    // 光标停在正文中间的原位置，用户可以直接续写。
    expect(restored.value).toBe("还没发送的想法");
    expect(restored.selectionStart).toBe(3);
    expect(restored.selectionEnd).toBe(3);
  });

  it("首条输入器：保留并继续编辑后焦点与选区回到原位，可直接续写", async () => {
    const view = await mount("/agent?new=seed", { sessions: false });
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    const draft = view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement;
    draft.focus();
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("还没有发出的首条草稿");
    draft.setSelectionRange(2, 5);
    focusMenuButton(view);

    await openNavigation(view);
    await navigationAction().trigger("click");
    await flush();
    expect(dialogText()).toContain("未保存");
    clickButtonByText("保留并继续编辑");
    await flush(120);

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const restored = view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement;
    expect(document.activeElement).toBe(restored);
    // 有选区时按原选区恢复，不强制跳到开头/末尾。
    expect(restored.selectionStart).toBe(2);
    expect(restored.selectionEnd).toBe(5);
  });

  it("命令结果待核对时，「保留并继续编辑」维持默认回焦，不把焦点塞进输入器", async () => {
    const view = await mount("/agent", { sessions: false });
    const draft = view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement;
    draft.focus();
    await view.wrapper.get('[data-testid="assist-first-draft"]').setValue("发送会失败的想法");
    // fixture 对未知的 assist-sessions POST 抛错：首条命令进入「结果待核对」，
    // 此时守卫弹层没有可续写的编辑器语义，恢复不得越过 pending 门控抢焦点。
    const form = draft.closest("form");
    expect(form).not.toBeNull();
    await new DomWrapper(form).trigger("submit");
    await flush(120);
    expect(view.wrapper.text()).toContain("创建结果待核对");
    const menuButton = focusMenuButton(view);

    await openNavigation(view);
    await navigationAction().trigger("click");
    await flush();
    expect(dialogText()).toContain("待核对");
    clickButtonByText("保留并继续编辑");
    await flush(120);

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(menuButton);
  });

  it("普通抽屉 Escape 关闭后，焦点仍回到打开导航按钮", async () => {
    const view = await mount("/agent");
    const menuButton = focusMenuButton(view);
    await openNavigation(view);
    expect(document.querySelector('[data-testid="mobile-new-conversation"]')).not.toBeNull();

    pressEscape();
    await flush();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(menuButton);
  });
});