import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const reviewId = "22222222-2222-4222-8222-222222222222";
const projectId = "99999999-9999-4999-8999-999999999999";
const reviewUrl = `${baseUrl}/api/v1/workspaces/${workspaceId}/reviews`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function review(status = "OPEN", project: string | null = null) {
  return {
    id: reviewId,
    kind: "CRITERION",
    status,
    revision: status === "OPEN" ? "1" : "2",
    project_id: project,
    task_id: "33333333-3333-4333-8333-333333333333",
    run_id: "44444444-4444-4444-8444-444444444444",
    reason: "请核对产物中的结论",
    target_hash: "a".repeat(64),
    target: { artifact_version_id: "55555555-5555-4555-8555-555555555555", acceptance_revision: "1", criterion_id: "human" },
    evidence: { check_result: "UNCERTAIN" },
    effect: { on_accept: "重新核对完成条件" },
    allowed_decisions: status === "OPEN" ? ["ACCEPT", "REQUEST_CHANGES"] : [],
    expires_at: null,
    created_at: "2026-09-23T00:00:00.000Z",
    decided_at: status === "OPEN" ? null : "2026-09-23T00:01:00.000Z"
  };
}

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function activate(): void {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
}

describe("P07 Review Inbox", () => {
  it("读取请求旁的确切历史正文，不以最新版替代，也不提交决定", async () => {
    activate(); const item = review(); const reads: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") throw new Error("阅读不应写入判断");
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [item] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, item);
      if (url.endsWith(`/tasks/${item.task_id}/artifacts`)) return response(200, {
        current_accepted_version_ids: [], items: [{ id: "artifact-1", task_id: item.task_id,
          title: "判断对象.md", revision: "3", latest_version_id: "latest-version", version_count: 2,
          versions: [{ artifact_version_id: "latest-version", version_number: "3", media_type: "text/markdown", sha256: "b".repeat(64), size: "10", source_kind: "HUMAN", created_at: item.created_at },
            { artifact_version_id: item.target.artifact_version_id, version_number: "2", media_type: "text/markdown", sha256: "c".repeat(64), size: "10", source_kind: "HUMAN", created_at: item.created_at }] }]
      });
      if (url.endsWith(`/artifact-versions/${item.target.artifact_version_id}/content`)) {
        reads.push(item.target.artifact_version_id);
        return { ok: true, status: 200, text: async () => "## 所引用的历史结论\n必须依据这一版判断。" } as Response;
      }
      if (url.endsWith("/content")) throw new Error("不能读取最新版本代替请求目标");
      return response(200, { items: [], next_cursor: null });
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/reviews?id=${reviewId}`); unmount = mounted.unmount; await flush();
    expect(mounted.wrapper.get('[data-testid="review-bound-reader"]').text()).toContain("必须依据这一版判断");
    expect(mounted.wrapper.get('[data-testid="review-bound-reader"] .artifact-doc-heading').text()).toContain("v2");
    expect(reads).toEqual([item.target.artifact_version_id]);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("待审响应丢失后切换查询被拦截，确认原回执前保留原命令 ID", async () => {
    activate(); let commandId = ""; let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [review()] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, review());
      if (url === `${reviewUrl}/${reviewId}/decisions` && init?.method === "POST") {
        posts++; commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        throw new TypeError("response lost");
      }
      if (url.endsWith(`/commands/${commandId}`)) return response(200, {
        command_id: commandId, command_type: "ResolveReview", committed_at: review().created_at,
        result: { review_id: reviewId, decision_id: "decision-1", decision: "ACCEPT", revision: "2" }
      });
      if (url.endsWith("/artifacts")) return response(200, { items: [], current_accepted_version_ids: [] });
      return response(200, { items: [], next_cursor: null });
    }));
    const mounted = await mountWorkbench(`/reviews?id=${reviewId}`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click"); await flush();
    await mounted.router.push(`/reviews?id=88888888-8888-4888-8888-888888888888`); await flush();
    expect(mounted.router.currentRoute.value.query.id).toBe(reviewId);
    const dialog = new DomWrapper(document.querySelector('[role="dialog"]'));
    expect(dialog.text()).toContain(commandId);
    expect(mounted.wrapper.find('[data-testid="discard-draft-leave"]').exists()).toBe(false);
    await dialog.findAll("button").find((button) => button.text() === "保留并继续编辑")!.trigger("click");
    await mounted.wrapper.get('[data-testid="relay-connection-open"]').trigger("click");
    const connectionDialog = new DomWrapper(document.body);
    await connectionDialog.get('[data-testid="relay-disconnect"]').trigger("click");
    expect(connectionDialog.get('[data-testid="relay-connection-error"]').text()).toContain("先查询原命令回执");
    expect(connectionDialog.get('[data-testid="relay-connection-error"]').text()).not.toContain("丢弃");
    await connectionDialog.findAll('[role="dialog"] button').find((button) => button.text() === "关闭")!.trigger("click");
    expect(mounted.wrapper.get('[data-testid="review-check-receipt"]').exists()).toBe(true);
    await mounted.wrapper.get('[data-testid="review-check-receipt"]').trigger("click"); await flush();
    expect(posts).toBe(1);
    expect(mounted.wrapper.text()).toContain("已核对原命令回执");
  });
  it.each(["bound", "other-task", "other-version", "unavailable"])("请求名称只来自绑定版本，不用最新版或其他任务替换（%s）", async (source) => {
    activate();
    const item = review();
    const taskId = item.task_id;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") throw new Error("读取请求名称不应提交业务命令");
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      if (url.endsWith("/tasks?scope=all") || url.endsWith("/projects?status=active")) return response(200, { items: [], next_cursor: null });
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [item] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, item);
      if (url.endsWith(`/tasks/${taskId}/artifacts`)) return source === "unavailable" ? response(403, { code: "FORBIDDEN", detail: "名称不可读取" })
        : response(200, { current_accepted_version_ids: [], items: [{ id: "artifact-1", task_id: source === "other-task" ? "other-task" : taskId,
          title: "评价方案.md", revision: "3", latest_version_id: "latest-version", version_count: 2,
          versions: [{ artifact_version_id: "latest-version", version_number: "3", media_type: "text/markdown", sha256: "b".repeat(64), size: "10", source_kind: "HUMAN", created_at: item.created_at },
            { artifact_version_id: source === "other-version" ? "another-version" : item.target.artifact_version_id, version_number: "2", media_type: "text/markdown", sha256: "c".repeat(64), size: "10", source_kind: "HUMAN", created_at: item.created_at }] }] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench("/reviews"); unmount = mounted.unmount;
    const row = mounted.wrapper.get(".review-list-item");
    if (source === "bound") expect(row.text()).toContain("评价方案.md v2");
    else expect(row.text()).not.toContain("评价方案.md");
    expect(row.text()).not.toContain("评价方案.md v3");
    expect(mounted.wrapper.get(".review-detail").text()).toContain(item.target.artifact_version_id);
    expect(fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
  });

  it("筛选请求类型只改变列表，原未决决定仍可核对且不重复提交", async () => {
    activate();
    const item = review();
    const approval = { ...item, id: "approval-review", kind: "ACTION_APPROVAL", reason: "本地提交需要批准", target: { normalized_target: "repo/main" } };
    let commandId = "";
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      if (url.endsWith("/tasks?scope=all") || url.endsWith("/projects?status=active")) return response(200, { items: [], next_cursor: null });
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [item, approval] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, item);
      if (url.endsWith(`/tasks/${item.task_id}/artifacts`)) return response(200, { items: [], current_accepted_version_ids: [] });
      if (url === `${reviewUrl}/${reviewId}/decisions` && init?.method === "POST") {
        posts++; commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id); throw new TypeError("response lost");
      }
      if (url.endsWith(`/commands/${commandId}`)) return response(200, { command_id: commandId, command_type: "ResolveReview", committed_at: item.created_at,
        result: { review_id: reviewId, decision_id: "decision-1", decision: "ACCEPT", revision: "2" } });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/reviews"); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click"); await flush();
    await mounted.wrapper.get('[data-testid="review-filter-ACTION_APPROVAL"]').trigger("click"); await flush();
    expect(mounted.wrapper.get(".review-list-item").text()).toContain("本地提交需要批准");
    expect(mounted.wrapper.get('[data-testid="review-check-receipt"]').exists()).toBe(true);
    await mounted.wrapper.get('[data-testid="review-check-receipt"]').trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain("已核对原命令回执");
    expect(posts).toBe(1);
  });

  it("无项目请求刷新失败时禁用新决定，不能按旧详情继续提交", async () => {
    activate();
    let denied = false;
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") { posts++; throw new Error("旧请求不得提交"); }
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      if (url.endsWith("/tasks?scope=all") || url.endsWith("/projects?status=active")) return response(200, { items: [], next_cursor: null });
      if (url === `${reviewUrl}?status=OPEN`) return denied ? response(403, { code: "FORBIDDEN", detail: "请求不可读取" }) : response(200, { items: [review()] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, review());
      if (url.endsWith("/artifacts")) return response(200, { items: [], current_accepted_version_ids: [] });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/reviews"); unmount = mounted.unmount;
    denied = true; await mounted.wrapper.get(".review-heading button").trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeDefined();
    await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click"); await flush();
    expect(posts).toBe(0);
  });

  it("示例模式展示只读请求，不提供可提交决定", async () => {
    const mounted = await mountWorkbench("/reviews");
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("等待你的判断");
    expect(mounted.wrapper.text()).toContain("只读示例");
    expect(mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeDefined();
  });

  it("真实决定绑定 revision 和目标摘要，保存后读取历史状态", async () => {
    activate();
    let decided = false;
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: decided ? [] : [review()] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, review(decided ? "DECIDED" : "OPEN"));
      if (url === `${reviewUrl}/${reviewId}/decisions` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        decided = true;
        return response(200, { command_id: posts[0].command_id, committed_at: "2026-09-23T00:01:00.000Z", result: { review_id: reviewId, decision_id: "decision-1", decision: "ACCEPT", effect: {}, revision: "2" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));
    const mounted = await mountWorkbench("/reviews");
    unmount = mounted.unmount;
    await flush(50);
    expect(mounted.wrapper.text()).toContain("产物版本 ID");
    await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click");
    await flush(50);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ expected_revision: "1", target_hash: "a".repeat(64), decision: "ACCEPT" });
    expect(typeof posts[0].command_id).toBe("string");
    expect(mounted.wrapper.text()).toContain("这条请求已有决定");
  });

  it("响应丢失后只查询原 command receipt，不生成第二次决定", async () => {
    activate();
    let commandId = "";
    let postCount = 0;
    let receiptCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [review()] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, review());
      if (url === `${reviewUrl}/${reviewId}/decisions` && init?.method === "POST") {
        postCount += 1;
        commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        throw new TypeError("connection lost");
      }
      if (url === `${baseUrl}/api/v1/workspaces/${workspaceId}/commands/${commandId}`) {
        receiptCount += 1;
        return response(200, { command_id: commandId, command_type: "ResolveReview", committed_at: "2026-09-23T00:01:00.000Z",
          result: { review_id: reviewId, decision_id: "decision-1", decision: "ACCEPT", effect: {}, revision: "2" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));
    const mounted = await mountWorkbench("/reviews");
    unmount = mounted.unmount;
    await flush(50);
    await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click");
    await flush(50);
    expect(mounted.wrapper.text()).toContain("提交结果待核对");
    await mounted.wrapper.get('[data-testid="review-check-receipt"]').trigger("click");
    await flush(50);
    expect(postCount).toBe(1);
    expect(receiptCount).toBe(1);
    expect(mounted.wrapper.text()).toContain("已核对原命令回执");
  });

  it("成功响应中的决定不匹配时保留原命令，再核对完整 Review 回执", async () => {
    activate();
    let commandId = "";
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [review()] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, review());
      if (url === `${reviewUrl}/${reviewId}/decisions` && init?.method === "POST") {
        posts++; commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        return response(200, { command_id: commandId, committed_at: "2026-09-24T00:01:00.000Z",
          result: { review_id: reviewId, decision_id: "decision-1", decision: "DENY", effect: {}, revision: "2" } });
      }
      if (url === `${baseUrl}/api/v1/workspaces/${workspaceId}/commands/${commandId}`) {
        return response(200, { command_id: commandId, command_type: "ResolveReview", committed_at: "2026-09-24T00:01:00.000Z",
          result: { review_id: reviewId, decision_id: "decision-1", decision: "ACCEPT", effect: {}, revision: "2" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));
    const mounted = await mountWorkbench("/reviews"); unmount = mounted.unmount;
    await flush();
    await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click");
    await flush();
    expect(mounted.wrapper.text()).toContain("回执无法核对");
    expect(mounted.wrapper.get('[data-testid="review-check-receipt"]').exists()).toBe(true);
    await mounted.wrapper.get('[data-testid="review-check-receipt"]').trigger("click");
    await flush();
    expect(posts).toBe(1);
    expect(mounted.wrapper.text()).toContain("已核对原命令回执");
  });

  it("原回执的命令类型、Review ID 或决定不匹配时均保持未决", async () => {
    activate();
    let commandId = "";
    let posts = 0;
    let receiptReads = 0;
    const mismatches = [
      { command_type: "ResumeRun", result: { review_id: reviewId, decision_id: "decision-1", decision: "ACCEPT", revision: "2" } },
      { command_type: "ResolveReview", result: { review_id: "wrong-review", decision_id: "decision-1", decision: "ACCEPT", revision: "2" } },
      { command_type: "ResolveReview", result: { review_id: reviewId, decision_id: "decision-1", decision: "DENY", revision: "2" } }
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [review()] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, review());
      if (url === `${reviewUrl}/${reviewId}/decisions` && init?.method === "POST") {
        posts++; commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        throw new TypeError("response lost");
      }
      if (url === `${baseUrl}/api/v1/workspaces/${workspaceId}/commands/${commandId}`) {
        const mismatch = mismatches[receiptReads++];
        return response(200, { command_id: commandId, command_type: mismatch?.command_type ?? "ResolveReview",
          committed_at: "2026-09-24T00:01:00.000Z",
          result: mismatch?.result ?? { review_id: reviewId, decision_id: "decision-1", decision: "ACCEPT", revision: "2" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));
    const mounted = await mountWorkbench("/reviews"); unmount = mounted.unmount;
    await flush();
    await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click");
    await flush();
    for (let index = 0; index < mismatches.length; index++) {
      await mounted.wrapper.get('[data-testid="review-check-receipt"]').trigger("click");
      await flush();
      expect(mounted.wrapper.text()).toContain("结果仍未确定");
      expect(mounted.wrapper.get('[data-testid="review-check-receipt"]').exists()).toBe(true);
    }
    expect(posts).toBe(1);
    expect(receiptReads).toBe(3);
  });

  it("归档 Project 的 Review 历史仍可读，但不发送新决定", async () => {
    activate();
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") throw new Error("archived Review must not write");
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [review("OPEN", projectId)] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, review("OPEN", projectId));
      if (url === `${baseUrl}/api/v1/workspaces/${workspaceId}/tasks/33333333-3333-4333-8333-333333333333`)
        return response(200, { id: "33333333-3333-4333-8333-333333333333", project_id: projectId,
          title: "历史任务", status: "WAITING", mode: "ME", revision: "1",
          executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" }, current_completion_id: null,
          waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
          acceptance: { acceptance_revision: "1", objective: "核对", source: "CREATE", criteria: [] }, dependencies: [] });
      if (url === `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}`)
        return response(200, { id: projectId, title: "历史项目", project_type: "GENERAL", revision: "2",
          state_revision: "1", archived_at: "2026-09-26T00:00:00Z" });
      throw new Error(`unexpected request: ${url}`);
    }); vi.stubGlobal("fetch", fetchMock);
    const mounted = await mountWorkbench(`/reviews?id=${reviewId}`); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.get('[data-testid="review-project-archive-reason"]').text()).toContain("已归档");
    expect(mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeDefined();
    await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("原 Review 决定响应不明后即使目标变为归档历史，仍能查询原回执", async () => {
    activate();
    let archived = false; let commandId = ""; let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: archived ? [] : [review("OPEN", projectId)] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, review(archived ? "DECIDED" : "OPEN", projectId));
      if (url === `${baseUrl}/api/v1/workspaces/${workspaceId}/tasks/33333333-3333-4333-8333-333333333333`)
        return response(200, { id: "33333333-3333-4333-8333-333333333333", project_id: projectId,
          title: "任务", status: "WAITING", mode: "ME", revision: "1",
          executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" }, current_completion_id: null,
          waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [], allowed_actions: [],
          acceptance: { acceptance_revision: "1", objective: "核对", source: "CREATE", criteria: [] }, dependencies: [] });
      if (url === `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}`)
        return response(200, { id: projectId, title: "项目", project_type: "GENERAL", revision: archived ? "2" : "1",
          state_revision: "1", archived_at: archived ? "2026-09-26T00:00:00Z" : null });
      if (url === `${reviewUrl}/${reviewId}/decisions` && init?.method === "POST") {
        commandId = String((JSON.parse(String(init.body)) as Record<string, unknown>).command_id);
        posts++; throw new TypeError("response lost");
      }
      if (url === `${baseUrl}/api/v1/workspaces/${workspaceId}/commands/${commandId}`)
        return response(200, { command_id: commandId, command_type: "ResolveReview", committed_at: "2026-09-26T00:00:00Z",
          result: { review_id: reviewId, decision_id: "decision-1", decision: "ACCEPT", revision: "2" } });
      throw new Error(`unexpected request: ${url}`);
    }));
    const mounted = await mountWorkbench(`/reviews?id=${reviewId}`); unmount = mounted.unmount;
    await flush(); await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="review-check-receipt"]').exists()).toBe(true);
    archived = true;
    await mounted.wrapper.get('.review-heading button').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="review-check-receipt"]').attributes("disabled")).toBeUndefined();
    await mounted.wrapper.get('[data-testid="review-check-receipt"]').trigger("click"); await flush();
    expect(posts).toBe(1);
    expect(mounted.wrapper.text()).toContain("已核对原命令回执");
  });

  it("过期请求停用决定并给出刷新入口，点击不提交新决定", async () => {
    activate();
    const expired = { ...review(), expires_at: "2020-01-01T00:00:00.000Z" };
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [expired] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, expired);
      if (url === `${reviewUrl}/${reviewId}/decisions` && init?.method === "POST") { posts += 1; throw new Error("过期决定不应提交"); }
      throw new Error(`unexpected request: ${url}`);
    }));
    const mounted = await mountWorkbench(`/reviews?id=${reviewId}`); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.text()).toContain("已超过有效期");
    expect(mounted.wrapper.get('[data-testid="review-expired-reason"]').exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="review-expired-refresh"]').exists()).toBe(true);
    expect(mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeDefined();
    await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click");
    await flush();
    expect(posts).toBe(0);
  });

  it("列表逐项提示与拒绝不等于执行失败说明", async () => {
    activate();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [review()] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, review());
      throw new Error(`unexpected request: ${url}`);
    }));
    const mounted = await mountWorkbench(`/reviews?id=${reviewId}`); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.text()).toContain("逐项判断");
    expect(mounted.wrapper.text()).toContain("不能绕过证据自动接受");
    expect(mounted.wrapper.text()).toContain("不等于执行失败");
  });

  it("动作批准绑定权限版本与变化集，说明本地 commit 不授权 push", async () => {
    activate();
    const approval = {
      ...review(),
      kind: "ACTION_APPROVAL",
      reason: "Git commit 需要你的批准",
      target: { operation_id: "op-1", action_type: "GIT_COMMIT", normalized_target: "repo/main", params_hash: "b".repeat(64), permission_version: "4", changeset_hash: "c".repeat(64) },
      evidence: { changeset_id: "cs-9", changeset_version: "3" },
      effect: { on_approve: "仅允许这一次本地 commit，不授权 push" },
      allowed_decisions: ["APPROVE", "DENY"],
      expires_at: null
    };
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [approval] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, approval);
      if (url === `${reviewUrl}/${reviewId}/decisions` && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return response(200, { command_id: posts[0].command_id, committed_at: "2026-09-23T00:01:00.000Z", result: { review_id: reviewId, decision_id: "d-1", decision: "APPROVE", effect: {}, revision: "2" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }));
    const mounted = await mountWorkbench(`/reviews?id=${reviewId}`); unmount = mounted.unmount;
    await flush();
    expect(mounted.wrapper.text()).toContain("权限版本");
    expect(mounted.wrapper.text()).toContain("变化集摘要");
    expect(mounted.wrapper.text()).toContain("批准本地 commit 不授权 push");
    await mounted.wrapper.get('[data-testid="review-decision-APPROVE"]').trigger("click");
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ decision: "APPROVE", target_hash: "a".repeat(64) });
    expect(mounted.wrapper.text()).toContain("动作批准不表示动作已经执行");
  });

  it("批准后目标变化时说明失效并重新读取，不显示为已批准", async () => {
    activate();
    let reloads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) return response(200, { items: [review()] });
      if (url === `${reviewUrl}/${reviewId}`) { reloads += 1; return response(200, review()); }
      if (url === `${reviewUrl}/${reviewId}/decisions` && init?.method === "POST") {
        return response(409, { code: "REVIEW_TARGET_CHANGED", detail: "review target changed" });
      }
      throw new Error(`unexpected request: ${url}`);
    }));
    const mounted = await mountWorkbench(`/reviews?id=${reviewId}`); unmount = mounted.unmount;
    const initialReloads = reloads;
    await flush();
    await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click");
    await flush();
    expect(mounted.wrapper.text()).toContain("动作内容或目标已经变化");
    expect(mounted.wrapper.text()).not.toContain("决定已保存");
    expect(reloads).toBeGreaterThan(initialReloads);
  });
});
