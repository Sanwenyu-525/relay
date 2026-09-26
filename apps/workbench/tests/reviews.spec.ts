import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

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
});
