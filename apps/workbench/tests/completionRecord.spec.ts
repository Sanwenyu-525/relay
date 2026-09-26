import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const completionId = "77777777-7777-4777-8777-777777777777";
const otherId = "88888888-8888-4888-8888-888888888888";
const taskId = "33333333-3333-4333-8333-333333333333";
const versionId = "55555555-5555-4555-8555-555555555555";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function connect() { activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" }); }
function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function humanEvidence(id = completionId) {
  return { completion_id: id, task_id: taskId, basis_kind: "HUMAN", acceptance_revision: "2",
    is_current: false, committed_at: "2026-09-25T00:00:00Z",
    acceptance: { availability: "AVAILABLE", objective: "旧版目标：保存实验记录", expected_outputs: { kind: "NOTE" },
      source: "HUMAN", created_at: "2026-09-24T00:00:00Z",
      criteria: [{ criterion_id: "old-c1", statement: "旧版条件", required: true, method: "HUMAN", target_spec: { expected: "old" } }] },
    human_acceptance: { availability: "AVAILABLE", id: "99999999-9999-4999-8999-999999999999",
      actor_kind: "HUMAN", statement: "当时核对通过", accepted_criterion_ids: ["old-c1"], reason: null,
      created_at: "2026-09-25T00:00:00Z" }, verification_session: null,
    artifact_versions: [{ availability: "AVAILABLE", artifact_version_id: versionId,
      artifact_id: "44444444-4444-4444-8444-444444444444", version_number: "1", sha256: "a".repeat(64) }] };
}

describe("P15 完成凭据详情", () => {
  it("fixture 明示没有真实凭据；历史 HUMAN 只显示当时的验收与确切产物版本", async () => {
    const calls = vi.fn(); vi.stubGlobal("fetch", calls);
    let mounted = await mountWorkbench(`/completion-records/${completionId}`); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("示例数据没有真实完成凭据");
    expect(calls).not.toHaveBeenCalled(); unmount(); unmount = null;

    connect();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      expect(String(input)).toBe(`${root}/completion-records/${completionId}`);
      return response(humanEvidence());
    }));
    mounted = await mountWorkbench(`/completion-records/${completionId}`); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("历史凭据；当前任务已不指向此凭据");
    expect(mounted.wrapper.text()).toContain("旧版目标：保存实验记录");
    expect(mounted.wrapper.text()).toContain("旧版条件");
    expect(mounted.wrapper.text()).toContain("当时核对通过");
    expect(mounted.wrapper.text()).toContain('"expected":"old"');
    expect(mounted.wrapper.find(`a[href="/artifact-versions/${versionId}/lineage"]`).exists()).toBe(true);
    expect(mounted.wrapper.find(`a[href="/activity?task_id=${taskId}"]`).exists()).toBe(true);
  });

  it("不可用的验收、验证和产物引用一律清空，不泄漏返回中的旧 ID 或正文", async () => {
    connect();
    vi.stubGlobal("fetch", vi.fn(async () => response({ completion_id: completionId, task_id: taskId,
      basis_kind: "AUTO", acceptance_revision: "3", is_current: true, committed_at: "2026-09-26T00:00:00Z",
      acceptance: { availability: "UNAVAILABLE", objective: "secret-objective", expected_outputs: { secret: "private" },
        source: "secret-source", created_at: "private", criteria: [{ criterion_id: "secret-criterion" }] },
      human_acceptance: null,
      verification_session: { availability: "UNAVAILABLE", id: "secret-session", run_id: "secret-run",
        status: "secret-status", verdict: "secret-verdict", check_plan_hash: "secret-hash", applicable: true },
      artifact_versions: [{ availability: "UNAVAILABLE", artifact_version_id: "secret-version",
        artifact_id: "secret-artifact", version_number: "4", sha256: "secret-sha" }] })));
    const mounted = await mountWorkbench(`/completion-records/${completionId}`); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("历史验收内容不可用");
    expect(mounted.wrapper.text()).toContain("验证会话不可用");
    expect(mounted.wrapper.text()).toContain("产物版本不可用");
    expect(mounted.wrapper.text()).not.toContain("secret-");
    expect(mounted.wrapper.text()).not.toContain("private");
    expect(mounted.wrapper.findAll('a[href*="secret-"]')).toHaveLength(0);
  });

  it("AUTO 凭据显示当时验证事实并链接确切来源 Run", async () => {
    connect();
    const runId = "66666666-6666-4666-8666-666666666666";
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...humanEvidence(), basis_kind: "AUTO",
      human_acceptance: null, verification_session: { availability: "AVAILABLE",
        id: "99999999-9999-4999-8999-999999999999", run_id: runId,
        status: "PASSED", verdict: "PASS", check_plan_hash: "b".repeat(64), applicable: false } })));
    const mounted = await mountWorkbench(`/completion-records/${completionId}`); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("自动验证");
    expect(mounted.wrapper.text()).toContain("PASSED / PASS");
    expect(mounted.wrapper.text()).toContain("不再适用");
    expect(mounted.wrapper.find(`a[href="/runs/${runId}"]`).exists()).toBe(true);
    expect(mounted.wrapper.text()).not.toContain("当时核对通过");
  });

  it("切换凭据隔离迟到响应，刷新 404 清除已显示的历史内容", async () => {
    connect();
    let resolveOld: ((value: Response) => void) | undefined;
    let otherReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path === `/completion-records/${completionId}`) return new Promise<Response>((resolve) => { resolveOld = resolve; });
      if (path === `/completion-records/${otherId}`) {
        otherReads++;
        return otherReads === 1 ? response({ ...humanEvidence(otherId), acceptance: {
          ...humanEvidence(otherId).acceptance, objective: "新凭据目标" } })
          : response({ code: "RESOURCE_NOT_FOUND", detail: "not found" }, 404);
      }
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench(`/completion-records/${completionId}`); unmount = mounted.unmount;
    await mounted.router.push(`/completion-records/${otherId}`); await flush();
    expect(mounted.wrapper.text()).toContain("新凭据目标");
    resolveOld?.(response(humanEvidence())); await flush();
    expect(mounted.wrapper.text()).not.toContain("旧版目标：保存实验记录");
    await mounted.wrapper.findAll("button").find((button) => button.text() === "重读凭据")!.trigger("click"); await flush();
    expect(mounted.wrapper.text()).toContain("当前不可读取或无权查看");
    expect(mounted.wrapper.text()).not.toContain("新凭据目标");
  });
});
