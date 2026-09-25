import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { rememberArtifactVersion, sessionVersionsFor } from "../src/lib/sessionArtifacts";
import { DomWrapper, flush, mountWorkbench } from "./mountApp";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const oldBase = "http://127.0.0.1:8787";
const newBase = "http://127.0.0.1:8791";
let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

function reply(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function task(title: string) {
  return {
    id: taskId, project_id: null, title, status: "IN_PROGRESS", mode: "ME", revision: "2",
    executor: { kind: "HUMAN", run_id: null, ownership_epoch: "0" },
    current_completion_id: null, waiting_reason: null, blocking_task_ids: [], unresolved_blocker_ids: [],
    allowed_actions: ["SAVE_ARTIFACT_VERSION", "COMPLETE"],
    acceptance: { acceptance_revision: "1", objective: "交付结果", source: "CREATE", criteria: [] },
    dependencies: []
  };
}

describe("连接切换隔离", () => {
  it("同一 Task ID 在新连接重读，旧连接迟到响应与产物记忆不能串入新空间", async () => {
    let resolveOld: (value: Response) => void = () => undefined;
    const oldReply = new Promise<Response>((resolve) => { resolveOld = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url) === `${oldBase}/api/v1/workspaces/${workspaceId}/tasks/${taskId}`) return oldReply;
      if (String(url) === `${newBase}/api/v1/workspaces/${workspaceId}/tasks/${taskId}`) return reply(task("新连接任务"));
      throw new Error(`unexpected request: ${url}`);
    }));
    activateRelayConnection({ baseUrl: oldBase, workspaceId, bearerToken: "old-test-token" });
    const mounted = await mountWorkbench(`/tasks/${taskId}`);
    unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("正在读取任务");

    rememberArtifactVersion(taskId, { artifactId: "old-artifact", artifactRevision: "1", versionId: "old-version", versionNumber: "1", title: "旧空间版本", sha256: "a".repeat(64), size: "5", savedAt: "2026-09-24T00:00:00.000Z" });
    await act(async () => activateRelayConnection({ baseUrl: newBase, workspaceId, bearerToken: "new-test-token" }));
    await flush();
    expect(mounted.wrapper.text()).toContain("新连接任务");
    expect(sessionVersionsFor(taskId)).toHaveLength(0);

    resolveOld(reply(task("旧连接任务")));
    await flush();
    expect(mounted.wrapper.text()).toContain("新连接任务");
    expect(mounted.wrapper.text()).not.toContain("旧连接任务");
    await mounted.wrapper.get('[data-testid="task-detail-tab-artifacts"]').trigger("click");
    expect(mounted.wrapper.text()).not.toContain("旧空间版本");
  });

  it("关闭连接面板后迟到的 readiness 不激活 live，编辑草稿后仍留在 fixture", async () => {
    let resolveReady: (value: Response) => void = () => undefined;
    const ready = new Promise<Response>((resolve) => { resolveReady = resolve; });
    const fetchStub = vi.fn(async (url: string) => {
      if (String(url) === `${oldBase}/health/ready`) return ready;
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchStub);
    const mounted = await mountWorkbench("/projects?view=create");
    unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="relay-connection-open"]').trigger("click");
    const page = new DomWrapper(document.body);
    await page.get('input[name="relay-workspace-id"]').setValue(workspaceId);
    await page.get('input[name="relay-bearer-token"]').setValue("test-token");
    await page.get('[data-testid="relay-connect"]').trigger("click");
    await page.get('button[aria-label="关闭面板"]').trigger("click");
    await mounted.wrapper.get('input[name="project-title"]').setValue("未保存草稿");
    resolveReady(reply({ status: "ready" }));
    await flush();
    expect(mounted.wrapper.get('[data-testid="relay-connection-open"]').text()).toContain("示例数据");
    expect(mounted.wrapper.get('input[name="project-title"]').attributes("value")).toBe("未保存草稿");
    await mounted.wrapper.get('[data-testid="relay-connection-open"]').trigger("click");
    await page.get('input[name="relay-bearer-token"]').setValue("another-test-token");
    await page.get('[data-testid="relay-connect"]').trigger("click");
    expect(page.get('[data-testid="relay-connection-error"]').text()).toContain("未保存的草稿");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});
