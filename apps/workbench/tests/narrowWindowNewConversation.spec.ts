import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { dialogText, DomWrapper, flush, folderStripName, mountWorkbench, openWorkingDirectory, pressEscape, toolbarSessionTitle } from "./mountApp";

// 2026-10-08 窄窗/短窗「新对话」入口可发现性。
// 抽屉入口与近期工作栏入口必须共用同一条 /agent?new=… 语义：进入空白讨论，
// 不继承目录、任务或旧会话。2026-10-19 用户指令：未发送草稿不再弹确认框，
// 换工作区直接切、草稿按会话留在本机（见 src/lib/composerDrafts.ts）。
// 本文件只断言行为（进入哪个上下文、草稿留在原会话并在回去时恢复）；真实可见性、
// 几何与键盘路径由 tests/browser/narrowWindowNewConversation.spec.ts 在 Chromium 里核对。

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
    // 目录控件已搬进细条上的「更换目录」浮层（协作页 §3.3），控件按 body 查询。
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
    // 目录作用域清空：细条回到「选择工作目录」那颗键，写准入说明一并消失。
    expect(folderStripName()).toBe("选择工作目录");
    expect(view.wrapper.find('[data-testid="folder-write-readiness"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="collab-goal"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(false);
    // 新对话本身不新建会话，也不重复写目录。
    expect(view.posts.filter((post) => post.path === `${root}/assist-sessions`)).toHaveLength(0);
    expect(view.posts.filter((post) => post.path === `${root}/working-directories/open`)).toHaveLength(1);
  });

  it("有未发送草稿时抽屉入口直接进入新对话；草稿留在原会话，回去时原样恢复", async () => {
    const view = await mount("/agent");
    // 普通 /agent 会续上最近会话，因此草稿落在已有会话的输入器上。
    await view.wrapper.get('[data-testid="assist-draft"]').setValue("还没发送的想法");
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(true);

    await openNavigation(view);
    await navigationAction().trigger("click");
    await flush(120);
    // 不再弹「未保存」确认：抽屉直接让位给新讨论。
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(view.router.currentRoute.value.query.new).toBeTruthy();
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="assist-first-draft"]').exists()).toBe(true);
    // 草稿属于原会话，不跟着带进新讨论。
    expect((view.wrapper.get('[data-testid="assist-first-draft"]').element as HTMLTextAreaElement).value).toBe("");

    // 回到原会话：草稿按会话留在本机，原样恢复。
    await view.router.push("/agent");
    await flush(120);
    expect(view.wrapper.find('[data-testid="assist-session"]').exists()).toBe(true);
    expect((view.wrapper.get('[data-testid="assist-draft"]').element as HTMLTextAreaElement).value)
      .toBe("还没发送的想法");
    expect(view.posts).toHaveLength(0);
  });
});

/**
 * 命令结果待核对时的焦点回退（2026-10-19 调整）。
 * 未发送草稿不再弹确认框，「保留并继续编辑」只剩「留在当前工作区」一个出口；
 * 没有可续写的编辑器时，焦点必须停在打开导航按钮上，不得被塞进输入器。
 * 焦点断言针对 document.activeElement，不只看 ref 是否存在。
 */
describe("命令结果待核对时的焦点回退", () => {
  /** 真实点击「打开导航」会把焦点带到按钮上：抽屉与守卫弹层的默认回焦都落在它。 */
  function focusMenuButton(view: { wrapper: DomWrapper }): HTMLButtonElement {
    const menuButton = view.wrapper.get('button[aria-label="打开导航"]').element as HTMLButtonElement;
    menuButton.focus();
    return menuButton;
  }

  it("命令结果待核对时，弹层只有「留在当前工作区」，焦点停在打开导航按钮", async () => {
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