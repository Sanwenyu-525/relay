import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const parentId = "33333333-3333-4333-8333-333333333333";
const completionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const url = `${baseUrl}/api/v1/workspaces/${workspaceId}/artifact-versions/${versionId}/lineage`;
let unmount: (() => void) | null = null;

afterEach(() => { unmount?.(); unmount = null; resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function contentResponse(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as Response;
}
function lineage() { return { artifact_version_id: versionId, artifact_id: "44444444-4444-4444-8444-444444444444",
  version_number: "2", sha256: "a".repeat(64), source_kind: "HUMAN_EDIT", content_availability: "UNAVAILABLE",
  direct_parents: [
    { id: "55555555-5555-4555-8555-555555555555", relation: "REVISED_FROM", parent_kind: "ARTIFACT_VERSION",
      parent_id: parentId, availability: "AVAILABLE", created_at: "2026-09-26T00:00:00Z" },
    { id: "66666666-6666-4666-8666-666666666666", relation: "DERIVED_FROM", parent_kind: "KNOWLEDGE_VERSION",
      parent_id: "hidden-parent-id", availability: "UNAVAILABLE", created_at: "2026-09-26T00:00:00Z" },
    { id: "77777777-7777-4777-8777-777777777777", relation: "GENERATED_BY", parent_kind: "RUN_STEP",
      parent_id: "88888888-8888-4888-8888-888888888888", availability: "AVAILABLE", created_at: "2026-09-26T00:00:00Z" }
  ] }; }

describe("P15 Artifact Lineage", () => {
  it("fixture 无真实来源；live 只链接确切可读父版本并说明其他来源边界", async () => {
    const fixtureFetch = vi.fn(); vi.stubGlobal("fetch", fixtureFetch);
    let mounted = await mountWorkbench(`/artifact-versions/${versionId}/lineage`); unmount = mounted.unmount;
    expect(mounted.wrapper.text()).toContain("示例数据没有真实产物来源关系");
    expect(fixtureFetch).not.toHaveBeenCalled(); unmount(); unmount = null;

    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === url) return response({ ...lineage(), direct_parents: [...lineage().direct_parents,
        { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", relation: "ACCEPTED_BY", parent_kind: "COMPLETION_RECORD",
          parent_id: completionId, availability: "AVAILABLE", created_at: "2026-09-26T00:00:00Z" }] });
      throw new Error(`Unexpected ${input}`);
    }));
    mounted = await mountWorkbench(`/artifact-versions/${versionId}/lineage`); unmount = mounted.unmount;
    const panel = mounted.wrapper.get('[data-testid="artifact-lineage"]');
    expect(panel.text()).toContain("直接父来源 · 4");
    expect(panel.text()).toContain("修订自 · 产物版本");
    expect(panel.text()).toContain("历史正文不可用或无权读取");
    expect(panel.find(`a[href="/artifact-versions/${parentId}/lineage"]`).exists()).toBe(true);
    expect(panel.find(`a[href="/completion-records/${completionId}"]`).exists()).toBe(true);
    expect(panel.text()).not.toContain("hidden-parent-id");
    expect(panel.text()).toContain("当前没有该类型的确切直达页");
    expect(panel.find('a[href^="/runs/"]').exists()).toBe(false);
  });

  it("刷新失去权限时清除旧来源和深链", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== url) throw new Error(`Unexpected ${input}`);
      return ++reads === 1 ? response(lineage()) : response({ code: "RESOURCE_NOT_FOUND", detail: "not found" }, 404);
    }));
    const mounted = await mountWorkbench(`/artifact-versions/${versionId}/lineage`); unmount = mounted.unmount;
    expect(mounted.wrapper.get('[data-testid="artifact-lineage"]').text()).toContain("直接父来源 · 3");
    await mounted.wrapper.get('[data-testid="artifact-lineage"] button').trigger("click"); await flush();
    const panel = mounted.wrapper.get('[data-testid="artifact-lineage"]');
    expect(panel.text()).toContain("当前不可读取或无权查看");
    expect(panel.text()).not.toContain("直接父来源 · 3");
    expect(panel.find(`a[href="/artifact-versions/${parentId}/lineage"]`).exists()).toBe(false);
  });

  it("切换版本后迟到的旧来源不能覆盖新版本", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const nextId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const old: { resolve?: (value: Response) => void } = {};
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === url) return new Promise<Response>((resolve) => { old.resolve = resolve; });
      if (String(input) === `${baseUrl}/api/v1/workspaces/${workspaceId}/artifact-versions/${nextId}/lineage`)
        return response({ ...lineage(), artifact_version_id: nextId, direct_parents: [] });
      throw new Error(`Unexpected ${input}`);
    }));
    const mounted = await mountWorkbench(`/artifact-versions/${versionId}/lineage`); unmount = mounted.unmount;
    await mounted.router.push(`/artifact-versions/${nextId}/lineage`); await flush();
    expect(mounted.wrapper.get('[data-testid="artifact-lineage"]').text()).toContain(`Version ID${nextId}`);
    old.resolve?.(response(lineage())); await flush();
    const panel = mounted.wrapper.get('[data-testid="artifact-lineage"]');
    expect(panel.text()).toContain("直接父来源 · 0");
    expect(panel.find(`a[href="/artifact-versions/${parentId}/lineage"]`).exists()).toBe(false);
  });

  it("长正文、确切历史来源与直接引用均绑定所选版本，读取全程只发 GET", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
    const calls: string[] = [];
    const current = `# 结果\n${"共同内容\n".repeat(1200)}新结论\n尾段`;
    const before = `# 结果\n${"共同内容\n".repeat(1200)}旧结论\n尾段`;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const path = String(input).slice(root.length); calls.push(path);
      if (path === `/artifact-versions/${versionId}/lineage`) return response({ ...lineage(), content_availability: "AVAILABLE" });
      if (path === `/artifact-versions/${parentId}/lineage`) return response({ ...lineage(), artifact_version_id: parentId,
        version_number: "1", sha256: "b".repeat(64), content_availability: "AVAILABLE", direct_parents: [] });
      if (path === `/artifacts/44444444-4444-4444-8444-444444444444`) return response({
        id: "44444444-4444-4444-8444-444444444444", task_id: "task-one", title: "实验结果", revision: "1",
        latest_version_id: versionId, version_count: 2, versions: [
          { artifact_version_id: parentId, version_number: "1", media_type: "text/markdown", sha256: "b".repeat(64), size: "12800", source_kind: "HUMAN", created_at: "2026-09-25T00:00:00Z" },
          { artifact_version_id: versionId, version_number: "2", media_type: "text/markdown", sha256: "a".repeat(64), size: "12800", source_kind: "HUMAN_EDIT", created_at: "2026-09-26T00:00:00Z" }
        ]
      });
      if (path === `/artifact-versions/${versionId}/content`) return contentResponse(current);
      if (path === `/artifact-versions/${parentId}/content`) return contentResponse(before);
      if (path === `/artifact-versions/${versionId}/direct-uses`) return response({ source_artifact_version_id: versionId,
        source_content_availability: "AVAILABLE", scope: "RECORDED_DIRECT_ONLY", complete: false, has_more: false,
        direct_uses: [{ relation: "DERIVED_FROM", child_artifact_version_id: parentId,
          child_artifact_id: "44444444-4444-4444-8444-444444444444", child_version_number: "1",
          availability: "AVAILABLE", created_at: "2026-09-26T00:00:00Z" }] });
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench(`/artifact-versions/${versionId}/lineage`); unmount = mounted.unmount;
    expect(calls).toEqual([`/artifact-versions/${versionId}/lineage`]);
    await mounted.wrapper.get('[data-testid="artifact-version-compare"] button').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="artifact-current-content"]').text()).toContain("新结论");
    await mounted.wrapper.get('[data-testid="artifact-compare-select"]').setValue(parentId);
    await mounted.wrapper.get('[data-testid="artifact-compare-submit"]').trigger("click"); await flush();
    const diff = mounted.wrapper.get('[data-testid="artifact-compare-result"]');
    expect(diff.text()).toContain("旧结论"); expect(diff.text()).toContain("新结论");
    expect(diff.text()).toContain("共同前缀 1201 行");
    expect(diff.find(`a[href="/artifact-versions/${parentId}/lineage"]`).exists()).toBe(true);
    await mounted.wrapper.get('[data-testid="artifact-direct-uses"] button').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="artifact-direct-uses"]').text()).toContain("完整影响范围未知");
    expect(mounted.wrapper.get('[data-testid="artifact-direct-uses"]').text()).toContain("打开直接引用版本 v1");
    expect(calls).toContain(`/artifact-versions/${versionId}/direct-uses`);
  });

  it("相同版本显示相同；仅 CRLF/LF 不同时不称字节相同；切换版本清理迟到正文", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
    const current = "甲\n乙";
    const pendingOld: { resolve?: (value: Response) => void } = {};
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path === `/artifact-versions/${versionId}/lineage`) return response({ ...lineage(), content_availability: "AVAILABLE" });
      if (path === `/artifact-versions/${parentId}/lineage`) return response({ ...lineage(), artifact_version_id: parentId,
        version_number: "1", content_availability: "AVAILABLE", direct_parents: [] });
      if (path === "/artifacts/44444444-4444-4444-8444-444444444444") return response({
        id: "44444444-4444-4444-8444-444444444444", task_id: "task-one", title: "结果", revision: "1",
        latest_version_id: versionId, version_count: 2, versions: [versionId, parentId].map((id, index) => ({
          artifact_version_id: id, version_number: String(2 - index), media_type: "text/markdown", sha256: "a".repeat(64),
          size: "8", source_kind: "HUMAN", created_at: "2026-09-26T00:00:00Z" }))
      });
      if (path === `/artifact-versions/${versionId}/content`) return contentResponse(current);
      if (path === `/artifact-versions/${parentId}/content`) return contentResponse("甲\r\n乙");
      throw new Error(`Unexpected ${path}`);
    }));
    const mounted = await mountWorkbench(`/artifact-versions/${versionId}/lineage`); unmount = mounted.unmount;
    await mounted.wrapper.get('[data-testid="artifact-version-compare"] button').trigger("click"); await flush();
    await mounted.wrapper.get('[data-testid="artifact-compare-select"]').setValue(versionId);
    await mounted.wrapper.get('[data-testid="artifact-compare-submit"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="artifact-compare-result"]').text()).toContain("两个确切版本正文相同");
    await mounted.wrapper.get('[data-testid="artifact-compare-select"]').setValue(parentId);
    await mounted.wrapper.get('[data-testid="artifact-compare-submit"]').trigger("click"); await flush();
    expect(mounted.wrapper.get('[data-testid="artifact-compare-result"]').text()).toContain("换行字节不同");

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).slice(root.length);
      if (path === `/artifact-versions/${versionId}/lineage`) return response({ ...lineage(), content_availability: "AVAILABLE" });
      if (path === `/artifact-versions/${parentId}/lineage`) return response({ ...lineage(), artifact_version_id: parentId, direct_parents: [] });
      if (path === "/artifacts/44444444-4444-4444-8444-444444444444") return new Promise<Response>((resolve) => { pendingOld.resolve = resolve; });
      if (path === `/artifact-versions/${versionId}/content`) return contentResponse("迟到内容");
      throw new Error(`Unexpected ${path}`);
    }));
    await mounted.wrapper.get('[data-testid="artifact-lineage"] > button').trigger("click"); await flush();
    await mounted.wrapper.get('[data-testid="artifact-version-compare"] button').trigger("click");
    await mounted.router.push(`/artifact-versions/${parentId}/lineage`); await flush();
    pendingOld.resolve?.(response({ id: "44444444-4444-4444-8444-444444444444", task_id: "task-one", title: "旧", revision: "1",
      latest_version_id: versionId, version_count: 0, versions: [] })); await flush();
    expect(mounted.wrapper.text()).not.toContain("迟到内容");
    expect(mounted.wrapper.get('[data-testid="artifact-version-compare"]').text()).not.toContain("正在读取");
  });
});
