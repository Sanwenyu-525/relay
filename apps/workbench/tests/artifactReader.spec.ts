import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { RelayApiClient } from "../src/api/relayClient";
import ArtifactReaderPanel from "../src/components/ArtifactReaderPanel";
import { flush, mountReact } from "./mountApp";

const root = "http://127.0.0.1:8787/api/v1/workspaces/workspace";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body,
    text: async () => String(body) } as Response;
}
function artifacts(taskId = "task") {
  return { current_accepted_version_ids: ["v1"], items: [{ id: "artifact", task_id: taskId,
    title: "实验记录.md", revision: "3", latest_version_id: "v3", version_count: 3,
    versions: ["v3", "v1", "v2"].map((id) => ({ artifact_version_id: id,
      version_number: id.slice(1), media_type: "text/markdown", sha256: id.slice(1).repeat(64),
      size: "10", source_kind: "HUMAN", created_at: "2026-10-01T00:00:00Z" })) }] };
}
async function mountReader(selectedVersionId: string | null = null, compact = false) {
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: "workspace", bearerToken: "test-token" });
  const mounted = await mountReact(createElement(MemoryRouter, null,
    createElement(ArtifactReaderPanel, { client, taskId: "task", projectId: null, selectedVersionId, draft: null, compact })));
  unmount = mounted.unmount; await flush(); return mounted.wrapper;
}

describe("确切产物阅读与比较", () => {
  it("阅读其他版本时明确区别判断绑定，返回入口只重读确切绑定版本", async () => {
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${root}/tasks/task/artifacts`) return response(200, artifacts());
      const version = /artifact-versions\/(v[123])\/content$/u.exec(url)?.[1];
      if (version) { reads.push(version); return response(200, `${version} 的正文`); }
      throw new Error(`unexpected ${url}`);
    }));
    const wrapper = await mountReader("v2", true);
    expect(wrapper.find('[data-testid="collab-review-version-mismatch"]').exists()).toBe(false);
    await wrapper.get('[data-testid="collab-read-v1"]').trigger("click"); await flush();
    const warning = wrapper.get('[data-testid="collab-review-version-mismatch"]');
    expect(warning.text()).toContain("正在阅读 v1");
    expect(warning.text()).toContain("当前判断仍绑定「实验记录.md」v2");
    await warning.get("button").trigger("click"); await flush();
    expect(wrapper.find('[data-testid="collab-review-version-mismatch"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="collab-reading"]').text()).toContain("v2 的正文");
    expect(reads).toEqual(["v2", "v1", "v2"]);
  });

  it("版本面板Escape收起并归还焦点，组合输入不关闭", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      response(200, String(input).endsWith("/artifacts") ? artifacts() : "确切正文")));
    const wrapper = await mountReader("v2", true);
    const details = wrapper.get(".collab-version-details").element as HTMLDetailsElement;
    details.open = true;
    await act(async () => details.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
    expect(details.open).toBe(true);
    await act(async () => details.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(details.querySelector("summary"));
  });
  it("阅读历史版后比较以实际阅读版为当前版本，不改为 latest", async () => {
    const reads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `${root}/tasks/task/artifacts`) return response(200, artifacts());
      const version = /artifact-versions\/(v[123])\/content$/u.exec(url)?.[1];
      if (version) { reads.push(version); return response(200, `${version} 的正文`); }
      throw new Error(`unexpected ${url}`);
    }));
    const wrapper = await mountReader();
    expect(wrapper.get('[data-testid="collab-reading"]').text()).toContain("v3 的正文");
    await wrapper.get('[data-testid="collab-read-v1"]').trigger("click"); await flush();
    await wrapper.get('[data-testid="collab-compare-base"]').setValue("v2");
    await wrapper.get('[data-testid="collab-compare-open"]').trigger("click"); await flush();
    const compare = wrapper.get('[data-testid="collab-compare"]');
    expect(compare.text()).toContain("基线 v2 → 当前 v1");
    expect(compare.text()).toContain("v1 的正文");
    expect(compare.text()).not.toContain("v3 的正文");
    expect(reads).toEqual(["v3", "v1", "v2", "v1"]);
  });

  it("显式绑定版本缺失时提示不可读，绝不读取最新版顶替", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === `${root}/tasks/task/artifacts`) return response(200, artifacts());
      throw new Error("不能读取其他版本");
    }); vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountReader("missing-version");
    expect(wrapper.get('[data-testid="collab-bound-version-unavailable"]').text()).toContain("missing-version");
    expect(wrapper.find('[data-testid="collab-reading"]').exists()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("拒绝其他任务的版本列表，且刷新失败会清除旧正文", async () => {
    let denied = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === `${root}/tasks/task/artifacts`) return response(200, artifacts(denied ? "other-task" : "task"));
      return response(200, "先前可读的确切正文");
    }));
    const wrapper = await mountReader("v1");
    expect(wrapper.get('[data-testid="collab-reading"]').text()).toContain("先前可读的确切正文");
    denied = true;
    await wrapper.get('[data-testid="collab-reader-refresh"]').trigger("click"); await flush();
    expect(wrapper.get('[data-testid="collab-artifact-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="collab-reading"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("先前可读的确切正文");
  });
});
