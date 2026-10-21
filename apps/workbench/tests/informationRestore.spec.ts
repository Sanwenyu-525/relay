import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { feedbackEntries, removeFeedback } from "../src/lib/feedback";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const projectId = "77777777-7777-4777-8777-777777777777";
const knowledgeId = "22222222-2222-4222-8222-222222222222";
const memoryId = "33333333-3333-4333-8333-333333333333";
const created = "2026-09-23T00:00:00.000Z";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const otherRoot = `${baseUrl}/api/v1/workspaces/${otherWorkspaceId}`;
let unmount: (() => void) | null = null;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function envelope(commandId: string, result: Record<string, unknown>) {
  return { command_id: commandId, committed_at: created, result };
}

function knowledge(status = "ACTIVE", revision = "2", project: string | null = null) {
  return { id: knowledgeId, project_id: project, title: "设计资料", status, revision,
    current_version: "1", created_at: created, updated_at: created };
}

function memory(status = "ACTIVE", revision = "2", expiresAt: string | null = "2026-12-31T00:00:00.000Z") {
  return { id: memoryId, project_id: null, title: "约定", status, revision, current_version: "1",
    text: "需要留存的事实", confirmed_by: "local-user", confirmed_at: created, expires_at: expiresAt,
    created_at: created, updated_at: created };
}

const portal = () => new DomWrapper(document.body);

function connect(id = workspaceId): void {
  activateRelayConnection({ baseUrl, workspaceId: id, bearerToken: "test-bearer-token-0123456789abcdef" });
}

function button(wrapper: DomWrapper, label: string): DomWrapper {
  const found = wrapper.findAll("button").find((item) => item.text() === label);
  if (!found) throw new Error(`找不到按钮「${label}」：${wrapper.element?.textContent?.slice(0, 600) ?? ""}`);
  return found;
}

afterEach(() => {
  unmount?.(); unmount = null;
  // 撤销条是命令式条目，故意活得比触发它的视图久；不清空会串到下一条例。
  act(() => { feedbackEntries().forEach((entry) => { removeFeedback(entry.id); }); });
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

describe("资料生命周期恢复", () => {
  it("归档资料成功后给出撤销条，撤销另发新命令并取回执修订", async () => {
    connect();
    let status = "ACTIVE"; let revision = "2";
    const archiveBodies: Record<string, unknown>[] = [];
    const undoBodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === "/knowledge") return response(200, [knowledge(status, revision)]);
      if (path === `/knowledge/${knowledgeId}`) return response(200, knowledge(status, revision));
      if (path === `/knowledge/${knowledgeId}/versions`) return response(200, []);
      if (path === `/knowledge/${knowledgeId}/archive` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        archiveBodies.push(body); status = "ARCHIVED"; revision = "3";
        return response(200, envelope(String(body.command_id),
          { knowledge_id: knowledgeId, revision: "3", status: "ARCHIVED" }));
      }
      if (path === `/knowledge/${knowledgeId}/unarchive` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        undoBodies.push(body); status = "ACTIVE"; revision = "4";
        return response(200, envelope(String(body.command_id),
          { knowledge_id: knowledgeId, revision: "4", status: "ACTIVE" }));
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await button(mounted.wrapper, "归档资料").trigger("click"); await flush();
    expect(archiveBodies).toHaveLength(1);
    expect(Object.keys(archiveBodies[0]!).sort()).toEqual(["command_id", "expected_revision"]);
    expect(archiveBodies[0]).toMatchObject({ expected_revision: "2" });
    // 只有回执核对通过才有撤销条：文案写明改了什么，动作是「撤销」。
    const undo = portal().get(`[data-testid="information-undo-${knowledgeId}"]`);
    expect(undo.text()).toContain("已归档资料「设计资料」");
    expect(undo.text()).toContain("撤销");
    expect(mounted.wrapper.text()).toContain("已停用或归档");

    await undo.get("button").trigger("click"); await flush();
    expect(undoBodies).toHaveLength(1);
    expect(undoBodies[0]).toMatchObject({ expected_revision: "3" });
    expect(undoBodies[0]!.command_id).not.toBe(archiveBodies[0]!.command_id);
    expect(portal().find(`[data-testid="information-undo-${knowledgeId}"]`).exists()).toBe(false);
    expect(mounted.wrapper.get(".knowledge-row").text()).toContain("有效");
  });

  it("归档在途时重复点击只发一条命令；结果不明时不给撤销条并保留原命令核对入口", async () => {
    connect();
    let release: ((value: Response) => void) | null = null;
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === "/knowledge") return response(200, [knowledge()]);
      if (path === `/knowledge/${knowledgeId}`) return response(200, knowledge());
      if (path === `/knowledge/${knowledgeId}/versions`) return response(200, []);
      if (path === `/knowledge/${knowledgeId}/archive` && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Promise<Response>((resolve) => { release = resolve; });
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    const target = button(mounted.wrapper, "归档资料");
    await target.trigger("click"); await flush(10);
    expect(release).not.toBeNull();
    await target.trigger("click");
    expect(bodies).toHaveLength(1);
    // 回执指向别的命令 = 无法核对，不是成功：不得出现撤销条。
    release!(response(200, envelope("另一个命令",
      { knowledge_id: knowledgeId, revision: "3", status: "ARCHIVED" })));
    await flush();
    expect(bodies).toHaveLength(1);
    expect(portal().find(`[data-testid="information-undo-${knowledgeId}"]`).exists()).toBe(false);
    const pending = mounted.wrapper.get('[data-testid="knowledge-pending-receipt"]');
    expect(pending.text()).toContain(String(bodies[0]!.command_id));
    expect(pending.text()).toContain("核对原命令回执");
  });

  it("撤销失败升级为停留 Notice 并指向永久入口，归档状态与待核对提示不被掩盖", async () => {
    connect();
    let status = "ACTIVE"; let revision = "2";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === "/knowledge") return response(200, [knowledge(status, revision)]);
      if (path === `/knowledge/${knowledgeId}`) return response(200, knowledge(status, revision));
      if (path === `/knowledge/${knowledgeId}/versions`) return response(200, []);
      if (path === `/knowledge/${knowledgeId}/archive` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        status = "ARCHIVED"; revision = "3";
        return response(200, envelope(String(body.command_id),
          { knowledge_id: knowledgeId, revision: "3", status: "ARCHIVED" }));
      }
      if (path === `/knowledge/${knowledgeId}/unarchive` && init?.method === "POST")
        return response(409, { code: "REVISION_CONFLICT", detail: "stale",
          conflict: { expected_revision: "3", actual_revision: "4" } });
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await button(mounted.wrapper, "归档资料").trigger("click"); await flush();
    await portal().get(`[data-testid="information-undo-${knowledgeId}"]`).get("button").trigger("click");
    await flush();
    const notice = portal().get(`[data-testid="information-undo-${knowledgeId}"]`);
    expect(notice.attributes("data-variant")).toBe("notice");
    expect(notice.text()).toContain("撤销没成功");
    expect(notice.text()).toContain("列表里仍能找到它");
    // 撤销失败后仍然是归档事实：永久恢复入口留在详情里，不依赖浮层。
    expect(mounted.wrapper.get('[data-testid="knowledge-restore-entry"]').text()).toContain("只把状态改回有效");
    expect(mounted.wrapper.get('[data-testid="knowledge-restore"]').attributes("disabled")).toBeUndefined();
  });

  it("切到别的资料类型后按撤销仍落到原资料，不把结果写进新范围", async () => {
    connect();
    let knowledgeReads = 0;
    let status = "ACTIVE";
    const undoBodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === "/knowledge") { knowledgeReads++; return response(200, [knowledge(status, "2")]); }
      if (path === `/knowledge/${knowledgeId}`) return response(200, knowledge(status, "2"));
      if (path === `/knowledge/${knowledgeId}/versions`) return response(200, []);
      if (path === "/memories") return response(200, []);
      if (path === `/knowledge/${knowledgeId}/archive` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        status = "ARCHIVED";
        return response(200, envelope(String(body.command_id),
          { knowledge_id: knowledgeId, revision: "3", status: "ARCHIVED" }));
      }
      if (path === `/knowledge/${knowledgeId}/unarchive` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        undoBodies.push(body);
        return response(200, envelope(String(body.command_id),
          { knowledge_id: knowledgeId, revision: "4", status: "ACTIVE" }));
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await button(mounted.wrapper, "归档资料").trigger("click"); await flush();
    const readsBeforeSwitch = knowledgeReads;
    await mounted.wrapper.get('[data-testid="knowledge-tab-MEMORY"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-tab-MEMORY"]').attributes("aria-selected")).toBe("true");
    await portal().get(`[data-testid="information-undo-${knowledgeId}"]`).get("button").trigger("click");
    await flush();
    expect(undoBodies).toHaveLength(1);
    expect(undoBodies[0]).toMatchObject({ expected_revision: "3" });
    // 迟到的撤销结果只属于原资料：当前记忆范围不被重读成资料。
    expect(knowledgeReads).toBe(readsBeforeSwitch);
    expect(mounted.wrapper.get('[data-testid="knowledge-tab-MEMORY"]').attributes("aria-selected")).toBe("true");
  });

  it("永久恢复用当次读回的修订，成功后定向重读并说明只改状态", async () => {
    connect();
    let status = "ARCHIVED";
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === "/knowledge") return response(200, [knowledge(status, "3")]);
      // 列表那一行是旧修订，永久恢复必须用详情当次读回的 "5"。
      if (path === `/knowledge/${knowledgeId}`) return response(200, knowledge(status, "5"));
      if (path === `/knowledge/${knowledgeId}/versions`) return response(200, []);
      if (path === `/knowledge/${knowledgeId}/unarchive` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body); status = "ACTIVE";
        return response(200, envelope(String(body.command_id),
          { knowledge_id: knowledgeId, revision: "6", status: "ACTIVE" }));
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    const entry = mounted.wrapper.get('[data-testid="knowledge-restore-entry"]');
    expect(entry.text()).toContain("归档时产生的待核对候选都保持原状");
    await mounted.wrapper.get('[data-testid="knowledge-restore"]').trigger("click"); await flush();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ expected_revision: "5" });
    expect(mounted.wrapper.get(".receipt-message").text()).toContain("已恢复为有效资料");
    expect(mounted.wrapper.get(".knowledge-row").text()).toContain("有效");
    expect(mounted.wrapper.find('[data-testid="knowledge-restore-entry"]').exists()).toBe(false);
  });

  it("永久恢复冲突先重读事实并要求重新决定，不自动覆盖", async () => {
    connect();
    let detailReads = 0;
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === "/knowledge") return response(200, [knowledge("ARCHIVED", "3")]);
      if (path === `/knowledge/${knowledgeId}`) { detailReads++; return response(200, knowledge("ARCHIVED", "5")); }
      if (path === `/knowledge/${knowledgeId}/versions`) return response(200, []);
      if (path === `/knowledge/${knowledgeId}/unarchive` && init?.method === "POST") {
        posts++;
        return response(409, { code: "REVISION_CONFLICT", detail: "stale",
          conflict: { expected_revision: "5", actual_revision: "6" } });
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    const afterMount = detailReads;
    await mounted.wrapper.get('[data-testid="knowledge-restore"]').trigger("click"); await flush();
    expect(posts).toBe(1);
    expect(detailReads).toBeGreaterThan(afterMount);
    const conflictError = mounted.wrapper.get('[data-testid="knowledge-action-error"]').text();
    expect(conflictError).toContain("刚被别处改过");
    expect(conflictError).toContain("请核对后决定是否再次恢复");
    expect(posts).toBe(1);
  });

  it("停用记忆后撤销失败留下 Notice，永久恢复说明不延长有效期", async () => {
    connect();
    let status = "ACTIVE"; let revision = "1";
    const reactivateBodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(root.length);
      if (path === "/knowledge") return response(200, []);
      if (path === "/memories") return response(200, [memory(status, revision)]);
      if (path === `/memories/${memoryId}`) return response(200, memory(status, revision));
      if (path === `/memories/${memoryId}/revisions`) return response(200, []);
      if (path === `/memories/${memoryId}/retire` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        status = "RETIRED"; revision = "2";
        return response(200, envelope(String(body.command_id),
          { memory_id: memoryId, revision: "2", status: "RETIRED" }));
      }
      if (path === `/memories/${memoryId}/reactivate` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        reactivateBodies.push(body);
        if (reactivateBodies.length === 1) throw new TypeError("response lost");
        status = "ACTIVE"; revision = "3";
        return response(200, envelope(String(body.command_id),
          { memory_id: memoryId, revision: "3", status: "ACTIVE" }));
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench("/knowledge?kind=MEMORY"); unmount = mounted.unmount;
    await button(mounted.wrapper, "停用记忆").trigger("click"); await flush();
    const undo = portal().get(`[data-testid="information-undo-${memoryId}"]`);
    expect(undo.text()).toContain("已停用记忆「约定」");
    // 反向命令网络失败：结果未明，不能宣称已恢复。
    await undo.get("button").trigger("click"); await flush();
    expect(portal().get(`[data-testid="information-undo-${memoryId}"]`).text()).toContain("撤销没成功");
    const note = mounted.wrapper.get('[data-testid="knowledge-restore-note"]');
    expect(note.text()).toContain("不延长有效期");
    expect(note.text()).toContain("不能当作可供 Agent 使用");
    expect(mounted.wrapper.get('[data-testid="knowledge-restore"]').attributes("disabled")).toBeUndefined();
    // 永久恢复不碰旁边那条还没保存的草稿：它只发生命周期命令，不重置输入区。
    await mounted.wrapper.get('[data-testid="knowledge-create"]').trigger("click");
    await mounted.wrapper.get('[data-testid="knowledge-title"]').setValue("尚未保存的新记忆");
    await mounted.wrapper.get('[data-testid="knowledge-restore"]').trigger("click"); await flush();
    expect(reactivateBodies).toHaveLength(2);
    expect(reactivateBodies[1]).toMatchObject({ expected_revision: "2" });
    expect((mounted.wrapper.get('[data-testid="knowledge-title"]').element as HTMLInputElement).value)
      .toBe("尚未保存的新记忆");
    // 回执只说明持久状态已恢复：是否仍到期由重读后的有效状态决定，不能提前宣称「现已有效」。
    expect(mounted.wrapper.get(".receipt-message").text()).toContain("已恢复记忆的持久状态");
    expect(mounted.wrapper.get(".receipt-message").text()).not.toContain("已恢复为有效记忆");
    // 恢复只改状态：有效期照旧显示，不是被重新确认或延长。
    expect(mounted.wrapper.text()).toContain("到期 2026-12-31");
  });

  it("切换 Workspace 后按撤销仍打到原范围，不落到新连接", async () => {
    connect(workspaceId);
    let status = "ACTIVE";
    const undoRoots: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const fromOriginal = url.startsWith(root);
      const path = url.slice((fromOriginal ? root : otherRoot).length);
      if (path === "/knowledge") return response(200, fromOriginal ? [knowledge(status, "2")] : []);
      if (path === `/knowledge/${knowledgeId}`) return response(200, knowledge(status, "2"));
      if (path === `/knowledge/${knowledgeId}/versions`) return response(200, []);
      if (path === `/knowledge/${knowledgeId}/archive` && init?.method === "POST" && fromOriginal) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        status = "ARCHIVED";
        return response(200, envelope(String(body.command_id),
          { knowledge_id: knowledgeId, revision: "3", status: "ARCHIVED" }));
      }
      if (path === `/knowledge/${knowledgeId}/unarchive` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        undoRoots.push(fromOriginal ? "original" : "other");
        return response(200, envelope(String(body.command_id),
          { knowledge_id: knowledgeId, revision: "4", status: "ACTIVE" }));
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench("/knowledge"); unmount = mounted.unmount;
    await button(mounted.wrapper, "归档资料").trigger("click"); await flush();
    await act(async () => { connect(otherWorkspaceId); }); await flush();
    // 新连接只有空列表；撤销条属于原范围，命令仍必须打到原 Workspace。
    expect(mounted.wrapper.find('[data-testid="knowledge-restore-entry"]').exists()).toBe(false);
    await portal().get(`[data-testid="information-undo-${knowledgeId}"]`).get("button").trigger("click");
    await flush();
    expect(undoRoots).toEqual(["original"]);
  });

  it("归档 Project 下的恢复入口沿既有写入守卫禁用", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const path = url.slice(root.length);
      if (path === `/knowledge?project_id=${projectId}`) return response(200, [knowledge("ARCHIVED", "3", projectId)]);
      if (path === `/knowledge/${knowledgeId}`) return response(200, knowledge("ARCHIVED", "3", projectId));
      if (path === `/knowledge/${knowledgeId}/versions`) return response(200, []);
      if (path === `/projects/${projectId}`) return response(200, { id: projectId, title: "项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: created });
      throw new Error(`Unexpected request ${path}`);
    }));
    const mounted = await mountWorkbench(`/projects/${projectId}/knowledge`); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.get('[data-testid="knowledge-project-write-blocked"]').text()).toContain("关联项目已归档");
    expect(mounted.wrapper.get('[data-testid="knowledge-restore"]').attributes("disabled")).toBeDefined();
  });
});
