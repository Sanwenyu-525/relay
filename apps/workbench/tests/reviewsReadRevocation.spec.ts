import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

/**
 * 待处理页读取失权后的内容生命周期（#25 / DEV-0135）。
 *
 * 刷新读取遇到 401/403 明确失权时：
 * - 旧列表、原因、判断依据、原始 JSON、目标版本绑定立即撤下，不再展示；
 * - 明确错误与刷新重试入口保留；重获权限后可重读；
 * - ReviewDecisionPanel 里未核对的 command_id 与回执入口不能无提示丢失；
 * - 可恢复的读取失败（传输断开）按既有语义保留已读内容，只提示错误。
 */

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const reviewId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const reviewUrl = `${baseUrl}/api/v1/workspaces/${workspaceId}/reviews`;
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.(); unmount = null;
  sessionStorage.clear();
  resetRelayConnectionForTest(); vi.unstubAllGlobals();
});

function activate() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" }); }
function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function review() {
  return { id: reviewId, kind: "CRITERION", status: "OPEN", revision: "1", project_id: null,
    task_id: taskId, run_id: null,
    reason: "private-review-evidence-sentinel", target_hash: "a".repeat(64),
    target: { artifact_version_id: "55555555-5555-4555-8555-555555555555", acceptance_revision: "1", criterion_id: "human" },
    evidence: { summary: "private-review-evidence-sentinel" }, effect: { on_accept: "重新核对完成条件" },
    allowed_decisions: ["ACCEPT", "REQUEST_CHANGES"], expires_at: null,
    created_at: "2026-10-24T00:00:00.000Z", decided_at: null };
}

describe("待处理页读取失权的内容撤回", () => {
  it("403 失权后清除旧列表与判断依据，错误与重试入口保留，决定按钮禁用", async () => {
    activate();
    const item = review();
    let denied = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) return denied ? response(403, { code: "FORBIDDEN", detail: "请求不可读取" }) : response(200, { items: [item] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, item);
      if (url.endsWith("/artifacts")) return response(200, { items: [], current_accepted_version_ids: [] });
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      if (url.endsWith("/tasks?scope=all") || url.endsWith("/projects?status=active")) return response(200, { items: [], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/reviews"); unmount = mounted.unmount; await flush();
    expect(mounted.wrapper.text()).toContain("private-review-evidence-sentinel");

    denied = true;
    await mounted.wrapper.get('[data-testid="review-refresh"]').trigger("click"); await flush();
    // 明确错误与重试入口仍在。
    expect(mounted.wrapper.get('[data-testid="review-read-error"]').text()).toContain("请求不可读取");
    expect(mounted.wrapper.get('[data-testid="review-refresh"]').attributes("disabled")).toBeUndefined();
    // 受限内容全部撤下：原因、证据、原始 JSON、目标版本、列表条目。
    expect(mounted.wrapper.text()).not.toContain("private-review-evidence-sentinel");
    expect(mounted.wrapper.text()).not.toContain("a".repeat(64));
    expect(mounted.wrapper.text()).not.toContain("55555555-5555-4555-8555-555555555555");
    expect(mounted.wrapper.get('[data-testid="review-raw-json"]').text()).not.toContain("sentinel");
    // 决定按钮存在但禁用：不能按旧详情继续提交。
    expect(mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeDefined();
    expect(mounted.wrapper.find(".review-list-item").exists()).toBe(false);

    // 重获权限后可重读。
    denied = false;
    await mounted.wrapper.get('[data-testid="review-refresh"]').trigger("click"); await flush();
    expect(mounted.wrapper.find('[data-testid="review-read-error"]').exists()).toBe(false);
    expect(mounted.wrapper.text()).toContain("private-review-evidence-sentinel");
    expect(mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').attributes("disabled")).toBeUndefined();
  });

  it("401 失权同样撤下受限内容", async () => {
    activate();
    const item = review();
    let denied = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) return denied ? response(401, { code: "AUTH_REQUIRED", detail: "凭据失效" }) : response(200, { items: [item] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, item);
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      if (url.endsWith("/tasks?scope=all") || url.endsWith("/projects?status=active")) return response(200, { items: [], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/reviews"); unmount = mounted.unmount; await flush();
    expect(mounted.wrapper.text()).toContain("private-review-evidence-sentinel");
    denied = true;
    await mounted.wrapper.get('[data-testid="review-refresh"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="review-read-error"]').text()).toContain("凭据未被接受");
    expect(mounted.wrapper.text()).not.toContain("private-review-evidence-sentinel");
  });

  it("传输失败等可恢复错误保留已读内容，只提示并允许重试", async () => {
    activate();
    const item = review();
    let broken = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) {
        if (broken) throw new TypeError("network glitch");
        return response(200, { items: [item] });
      }
      if (url === `${reviewUrl}/${reviewId}`) return response(200, item);
      if (url.endsWith("/artifacts")) return response(200, { items: [], current_accepted_version_ids: [] });
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      if (url.endsWith("/tasks?scope=all") || url.endsWith("/projects?status=active")) return response(200, { items: [], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/reviews"); unmount = mounted.unmount; await flush();
    broken = true;
    await mounted.wrapper.get('[data-testid="review-refresh"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="review-read-error"]').text()).toContain("响应丢失");
    // 可恢复的读取失败不清内容：旧列表与依据仍可见，供重试后继续。
    expect(mounted.wrapper.text()).toContain("private-review-evidence-sentinel");
    expect(mounted.wrapper.find(".review-list-item").exists()).toBe(true);
  });

  it("未核对的判定命令在失权剥壳后仍保留回执核对入口", async () => {
    activate();
    const item = review();
    let denied = false;
    const posts: Record<string, unknown>[] = [];
    let receiptReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url === `${reviewUrl}/${reviewId}/decisions`) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        throw new TypeError("response lost");
      }
      if (url.startsWith(`${baseUrl}/api/v1/workspaces/${workspaceId}/commands/`)) {
        receiptReads += 1;
        return response(404, { code: "COMMAND_NOT_FOUND", detail: "not found yet" });
      }
      if (url === `${reviewUrl}?status=OPEN`) return denied ? response(403, { code: "FORBIDDEN", detail: "请求不可读取" }) : response(200, { items: [item] });
      if (url === `${reviewUrl}/${reviewId}`) return response(200, item);
      if (url.endsWith("/artifacts")) return response(200, { items: [], current_accepted_version_ids: [] });
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      if (url.endsWith("/tasks?scope=all") || url.endsWith("/projects?status=active")) return response(200, { items: [], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/reviews"); unmount = mounted.unmount; await flush();
    // 提交决定，响应丢失 → 面板进入待核对。
    await mounted.wrapper.get('[data-testid="review-decision-ACCEPT"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="review-check-receipt"]').exists()).toBe(true);

    // 刷新读取 403 失权：受限内容撤下，但回执入口仍在，可用原 ID 继续核对。
    denied = true;
    await mounted.wrapper.get('[data-testid="review-refresh"]').trigger("click"); await flush();
    expect(mounted.wrapper.text()).not.toContain("private-review-evidence-sentinel");
    const receipt = mounted.wrapper.get('[data-testid="review-check-receipt"]');
    expect(receipt.attributes("disabled")).toBeUndefined();
    await receipt.trigger("click"); await flush();
    expect(receiptReads).toBeGreaterThanOrEqual(1);
    // 回执未命中时保持待核对恢复态，且不把原请求正文带回来。
    expect(mounted.wrapper.text()).toContain("尚未找到原命令回执");
    // 失权后决定按钮不再出现（详情只剩恢复态），旧依据不可见。
    expect(mounted.wrapper.find('[data-testid="review-decision-ACCEPT"]').exists()).toBe(false);
  });

  it("迟到响应不覆盖更新的事实（隔离在途读取）", async () => {
    activate();
    const stale = review();
    let reviewsCalls = 0;
    let hanging: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${reviewUrl}?status=OPEN`) {
        reviewsCalls += 1;
        // 第 2 次（刷新）读取挂起，制造与第 3 次（切换选中）读取的重叠。
        if (reviewsCalls === 2) return new Promise<Response>((resolve) => { hanging = resolve; });
        if (reviewsCalls >= 3) return response(403, { code: "FORBIDDEN", detail: "请求不可读取" });
        return response(200, { items: [stale] });
      }
      if (url === `${reviewUrl}/${reviewId}`) return response(200, stale);
      if (url.endsWith("/attention/interventions")) return response(200, { items: [] });
      if (url.endsWith("/tasks?scope=all") || url.endsWith("/projects?status=active")) return response(200, { items: [], next_cursor: null });
      throw new Error(`unexpected ${url}`);
    }));
    const mounted = await mountWorkbench("/reviews"); unmount = mounted.unmount; await flush();
    expect(mounted.wrapper.text()).toContain("private-review-evidence-sentinel");

    // 点击刷新发起第 2 次读取并让它挂起；期间切换选中触发第 3 次读取并失权。
    await mounted.wrapper.get('[data-testid="review-refresh"]').trigger("click"); await flush();
    await mounted.wrapper.get(".review-list-item").trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="review-read-error"]').text()).toContain("请求不可读取");
    expect(mounted.wrapper.text()).not.toContain("private-review-evidence-sentinel");

    // 释放迟到的旧读取：不得把失权后的状态覆盖回旧列表。
    const releaseHanging = hanging as unknown as ((value: Response) => void) | null;
    releaseHanging?.(response(200, { items: [stale] })); await flush();
    expect(mounted.wrapper.text()).not.toContain("private-review-evidence-sentinel");
    expect(mounted.wrapper.get('[data-testid="review-read-error"]').text()).toContain("请求不可读取");
  });
});
