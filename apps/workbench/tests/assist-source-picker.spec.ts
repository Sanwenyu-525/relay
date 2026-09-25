import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AssistSourcePicker from "../src/components/AssistSourcePicker";
import { activateRelayConnection, resetRelayConnectionForTest, useFixtureData } from "../src/lib/relayConnection";
import { flush, mountReact } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "55555555-5555-4555-8555-555555555555";

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

async function mountPicker(props: { projectId: string; selectedRefs: readonly string[] }) {
  const emitted: (readonly string[])[] = [];
  const onChange = (refs: readonly string[]) => emitted.push(refs);
  const mounted = await mountReact(createElement(AssistSourcePicker, { ...props, onChange }));
  return Object.assign(mounted.wrapper, {
    unmount: mounted.unmount,
    setProps: async (patch: Partial<typeof props>) => { props = { ...props, ...patch }; await mounted.rerender(createElement(AssistSourcePicker, { ...props, onChange })); },
    emitted: (_name: string) => emitted.map((refs) => [refs])
  });
}

afterEach(() => {
  resetRelayConnectionForTest();
  vi.unstubAllGlobals();
});

describe("P12 Assist 显式来源选择", () => {
  it("迟到的旧搜索结果不能覆盖新检索，选择只上报来源引用", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let releaseOld: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/api/v1/workspaces/${workspaceId}/search`);
      expect(url.searchParams.get("project_id")).toBe(projectId);
      expect(url.searchParams.get("types")).toBe("KNOWLEDGE,MEMORY,DECISION");
      if (url.searchParams.get("q") === "旧词") {
        return new Promise<Response>((resolve) => { releaseOld = resolve; });
      }
      return response({ items: [{ type: "KNOWLEDGE", id: "33333333-3333-4333-8333-333333333333",
        version: "2", title: "新资料", snippet: "片段", matched_fields: ["title"],
        source_ref: "knowledge:33333333-3333-4333-8333-333333333333:v2", status: "ACTIVE", project_id: projectId },
      { type: "MEMORY", id: "99999999-9999-4999-8999-999999999999", version: "1",
        title: "其他项目资料", snippet: "不可展示", matched_fields: ["title"],
        source_ref: "memory:99999999-9999-4999-8999-999999999999:v1", status: "ACTIVE", project_id: otherProjectId }],
      next_cursor: null });
    }));
    const wrapper = await mountPicker({ projectId, selectedRefs: [] });
    await wrapper.get("#assist-source-query").setValue("旧词");
    await wrapper.get("form").trigger("submit");
    await wrapper.get("#assist-source-query").setValue("新词");
    await wrapper.get("form").trigger("submit");
    await flush(20);
    releaseOld!(response({ items: [{ type: "MEMORY", id: "44444444-4444-4444-8444-444444444444",
      version: "1", title: "旧资料", snippet: "旧片段", matched_fields: ["title"],
      source_ref: "memory:44444444-4444-4444-8444-444444444444:v1", status: "ACTIVE", project_id: projectId }],
    next_cursor: null }));
    await flush(20);
    expect(wrapper.text()).toContain("新资料");
    expect(wrapper.text()).not.toContain("旧资料");
    expect(wrapper.text()).not.toContain("其他项目资料");
    await wrapper.get('input[type="checkbox"]').setValue(true);
    expect(wrapper.emitted("update:selectedRefs")?.at(-1)?.[0]).toEqual([
      "knowledge:33333333-3333-4333-8333-333333333333:v2"
    ]);
    wrapper.unmount();
  });

  it("更换 Project 范围时清除已选引用并丢弃旧范围迟到结果", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let releaseOld: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>((resolve) => { releaseOld = resolve; })));
    const wrapper = await mountPicker({ projectId,
      selectedRefs: ["knowledge:33333333-3333-4333-8333-333333333333:v1"] });
    await wrapper.get("#assist-source-query").setValue("旧项目");
    await wrapper.get("form").trigger("submit");
    expect(releaseOld).not.toBeNull();
    await wrapper.setProps({ projectId: otherProjectId });
    expect(wrapper.emitted("update:selectedRefs")?.at(-1)?.[0]).toEqual([]);
    releaseOld!(response({ items: [{ type: "KNOWLEDGE", id: "33333333-3333-4333-8333-333333333333",
      version: "1", title: "旧项目秘密", snippet: "片段", matched_fields: ["title"],
      source_ref: "knowledge:33333333-3333-4333-8333-333333333333:v1", status: "ACTIVE", project_id: projectId }],
    next_cursor: null }));
    await flush(20);
    expect(wrapper.text()).not.toContain("旧项目秘密");
    wrapper.unmount();
  });

  it("断开 live 连接时清除可见搜索结果", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async () => response({ items: [{
      type: "DECISION", id: "66666666-6666-4666-8666-666666666666", version: "1",
      title: "已获准决定", snippet: "摘要", matched_fields: ["title"],
      source_ref: "decision:66666666-6666-4666-8666-666666666666:v1", status: "ACTIVE", project_id: projectId
    }], next_cursor: null })));
    const wrapper = await mountPicker({ projectId, selectedRefs: [] });
    await wrapper.get("#assist-source-query").setValue("决定");
    await wrapper.get("form").trigger("submit");
    await flush(20);
    expect(wrapper.text()).toContain("已获准决定");
    useFixtureData();
    await flush(20);
    expect(wrapper.text()).not.toContain("已获准决定");
    expect(wrapper.emitted("update:selectedRefs")?.at(-1)?.[0]).toEqual([]);
    wrapper.unmount();
  });

  it("修改检索词即清除上一词的结果，避免误选旧来源", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async () => response({ items: [{
      type: "KNOWLEDGE", id: "88888888-8888-4888-8888-888888888888", version: "1",
      title: "上一词资料", snippet: "摘要", matched_fields: ["title"],
      source_ref: "knowledge:88888888-8888-4888-8888-888888888888:v1", status: "ACTIVE", project_id: projectId
    }], next_cursor: null })));
    const wrapper = await mountPicker({ projectId, selectedRefs: [] });
    await wrapper.get("#assist-source-query").setValue("上一词");
    await wrapper.get("form").trigger("submit");
    await flush(20);
    expect(wrapper.text()).toContain("上一词资料");
    await wrapper.get("#assist-source-query").setValue("新词");
    expect(wrapper.text()).not.toContain("上一词资料");
    wrapper.unmount();
  });
});
