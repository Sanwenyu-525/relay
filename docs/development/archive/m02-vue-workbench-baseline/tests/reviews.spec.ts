import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const reviewId = "22222222-2222-4222-8222-222222222222";
const reviewUrl = `${baseUrl}/api/v1/workspaces/${workspaceId}/reviews`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function review(status = "OPEN") {
  return {
    id: reviewId,
    kind: "CRITERION",
    status,
    revision: status === "OPEN" ? "1" : "2",
    project_id: null,
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
        return response(200, { command_id: commandId, command_type: "ResolveReview", committed_at: "2026-09-23T00:01:00.000Z", result: { review_id: reviewId } });
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
  });
});
