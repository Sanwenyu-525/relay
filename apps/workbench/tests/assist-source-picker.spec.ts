import { readFileSync } from "node:fs";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AssistSourcePicker from "../src/components/AssistSourcePicker";
import type { RelayAssistSourceRef } from "../src/api/relayClient";
import { activateRelayConnection, resetRelayConnectionForTest, useFixtureData } from "../src/lib/relayConnection";
import { flush, mountReact } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "55555555-5555-4555-8555-555555555555";

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

async function mountPicker(props: { projectId: string; selectedRefs: readonly RelayAssistSourceRef[] }) {
  const emitted: (readonly RelayAssistSourceRef[])[] = [];
  const onChange = (refs: readonly RelayAssistSourceRef[]) => { emitted.push(refs); };
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
      { kind: "KNOWLEDGE", rootId: "33333333-3333-4333-8333-333333333333", version: "2" }
    ]);
    wrapper.unmount();
  });

  it("更换 Project 范围时清除已选引用并丢弃旧范围迟到结果", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let releaseOld: ((value: Response) => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>((resolve) => { releaseOld = resolve; })));
    const wrapper = await mountPicker({ projectId,
      selectedRefs: [{ kind: "KNOWLEDGE", rootId: "33333333-3333-4333-8333-333333333333", version: "1" }] });
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

/**
 * CT-02（点击穿透整改，2026-10-17）常驻断言：资料面板只承担资料职责，四类读取状态互不掩盖，
 * 选择动作不产生任何请求。视觉档位（限高、内部滚动、面板字号）由 `migrated-scoped.css` 的规则守住。
 */
function searchItem(id: string, title: string) {
  return { type: "KNOWLEDGE", id, version: "1", title, snippet: "摘要", matched_fields: ["title"],
    source_ref: `knowledge:${id}:v1`, status: "ACTIVE", project_id: projectId };
}

function ref(id: string): RelayAssistSourceRef {
  return { kind: "KNOWLEDGE", rootId: id, version: "1" };
}

async function mount(props: { projectId: string | null; selectedRefs: readonly RelayAssistSourceRef[]; disabled?: boolean }) {
  const emitted: (readonly RelayAssistSourceRef[])[] = [];
  const mounted = await mountReact(createElement(AssistSourcePicker, {
    ...props, onChange: (refs: readonly RelayAssistSourceRef[]) => { emitted.push(refs); }
  }));
  return Object.assign(mounted.wrapper, {
    unmount: mounted.unmount,
    setProps: async (patch: Partial<typeof props>) => {
      props = { ...props, ...patch };
      await mounted.rerender(createElement(AssistSourcePicker, { ...props, onChange: (refs: readonly RelayAssistSourceRef[]) => { emitted.push(refs); } }));
    },
    emitted,
    searchCalls: () => requests.filter(([, init]) => !init?.method || init.method === "GET").length,
    postCalls: () => requests.filter(([, init]) => init?.method === "POST").length
  });
}

let requests: [string, RequestInit | undefined][] = [];

function stubSearch(handler: (query: string | null) => unknown) {
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push([String(input), init]);
    if (url.pathname !== `/api/v1/workspaces/${workspaceId}/search`) throw new Error(`意外请求：${url.pathname}`);
    return response(handler(url.searchParams.get("q")));
  }));
}

describe("CT-02 资料面板的职责、状态与副作用边界", () => {
  afterEach(() => {
    resetRelayConnectionForTest();
    vi.unstubAllGlobals();
  });

  it("面板只承载资料职责：标题、已选数量、已选项、引用范围按序分组且不含生成方式与意图", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    stubSearch(() => ({ items: [searchItem("33333333-3333-4333-8333-333333333333", "候选资料")], next_cursor: null }));
    const wrapper = await mount({ projectId, selectedRefs: [ref("aaaaaaa1-1111-4111-8111-111111111111"), ref("aaaaaaa2-1111-4111-8111-111111111111")] });
    try {
      await wrapper.get("#assist-source-query").setValue("资料");
      await wrapper.get('[data-testid="assist-source-picker"] form').trigger("submit");
      await flush(20);
      const before = (a: string, b: string) => {
        const first = wrapper.get(a).element!; const second = wrapper.get(b).element!;
        // compareDocumentPosition 返回位掩码：FOLLOWING 命中才说明 a 在 b 之前。
        return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      };
      expect(wrapper.get(".assist-source-head h2").text()).toContain("资料");
      expect(before(".assist-source-head", ".assist-source-body")).toBe(true);
      expect(before(".assist-source-head", '[data-testid="assist-source-scope"]')).toBe(true);
      expect(before("#assist-source-query", '[data-testid="assist-source-scope"]')).toBe(true);
      expect(before('[data-testid="assist-source-scope"]', ".assist-source-body")).toBe(true);
      expect(before('[data-region="selected"]', '[data-region="results"]')).toBe(true);
      expect(wrapper.get('[data-testid="assist-source-count"]').text()).toContain("已选 2 / 10");
      const text = wrapper.text();
      expect(text).toContain("引用范围");
      expect(text).not.toContain("生成方式");
      expect(text).not.toContain("意图");
      expect(wrapper.find('[data-testid="assist-skill"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="assist-intent"]').exists()).toBe(false);
    } finally { wrapper.unmount(); }
  });

  it("空态、查无结果与读取失败互不掩盖，失败后按同一检索词重试", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let attempts = 0;
    stubSearch((query) => {
      if (query === "注定失败" && ++attempts === 1) throw new Error("读取失败");
      return { items: [searchItem("33333333-3333-4333-8333-333333333333", `“${query}”的结果`)], next_cursor: null };
    });
    const wrapper = await mount({ projectId, selectedRefs: [] });
    try {
      expect(wrapper.get('[data-testid="assist-source-empty"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="assist-source-none"]').exists()).toBe(false);
      await wrapper.get("#assist-source-query").setValue("注定失败");
      await wrapper.get('[data-testid="assist-source-picker"] form').trigger("submit");
      await flush(20);
      expect(wrapper.find('[data-testid="assist-source-empty"]').exists()).toBe(false);
      // 失败不能渲染成「没有资料」的空列表：错误与无结果两种说法不能同时出现。
      expect(wrapper.find('[data-testid="assist-source-none"]').exists()).toBe(false);
      const retry = wrapper.get('[data-testid="assist-source-retry"]');
      expect(wrapper.get(".action-error").exists()).toBe(true);
      await retry.trigger("click");
      await flush(20);
      expect(wrapper.text()).toContain("“注定失败”的结果");
      expect(wrapper.find('[data-testid="assist-source-retry"]').exists()).toBe(false);
      expect(wrapper.searchCalls()).toBe(2);
    } finally { wrapper.unmount(); }
  });

  it("检索过但没有匹配时才说查无结果，未检索时保持空态", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    stubSearch(() => ({ items: [], next_cursor: null }));
    const wrapper = await mount({ projectId, selectedRefs: [] });
    try {
      await wrapper.get("#assist-source-query").setValue("查不到");
      await wrapper.get('[data-testid="assist-source-picker"] form').trigger("submit");
      await flush(20);
      expect(wrapper.get('[data-testid="assist-source-none"]').text()).toContain("没有可见的匹配资料");
      expect(wrapper.find('[data-testid="assist-source-empty"]').exists()).toBe(false);
      await wrapper.get("#assist-source-query").setValue("查不到但没提交");
      expect(wrapper.find('[data-testid="assist-source-none"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="assist-source-empty"]').exists()).toBe(true);
    } finally { wrapper.unmount(); }
  });

  it("勾选与移除资料只编辑本次候选输入：不发送消息、不建执行、不额外请求", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    stubSearch(() => ({ items: [searchItem("33333333-3333-4333-8333-333333333333", "甲资料"),
      searchItem("44444444-4444-4444-8444-444444444444", "乙资料")], next_cursor: null }));
    const wrapper = await mount({ projectId, selectedRefs: [] });
    try {
      await wrapper.get("#assist-source-query").setValue("资料");
      await wrapper.get('[data-testid="assist-source-picker"] form').trigger("submit");
      await flush(20);
      const afterSearch = requests.length;
      const boxes = wrapper.findAll('[data-region="results"] input[type="checkbox"]');
      await boxes[0]!.setValue(true);
      await wrapper.setProps({ selectedRefs: [ref("33333333-3333-4333-8333-333333333333")] });
      await wrapper.get('[data-region="selected"] button').trigger("click");
      await wrapper.setProps({ selectedRefs: [] });
      await boxes[1]!.setValue(true);
      expect(wrapper.emitted.at(-1)).toEqual([{ kind: "KNOWLEDGE", rootId: "44444444-4444-4444-8444-444444444444", version: "1" }]);
      expect(requests.length).toBe(afterSearch);
      expect(wrapper.postCalls()).toBe(0);
    } finally { wrapper.unmount(); }
  });

  it("超出可选上限只给状态说明，不伪装成可重试的读取失败", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    stubSearch(() => ({ items: [searchItem("33333333-3333-4333-8333-333333333333", "第十一份资料")], next_cursor: null }));
    const selected = Array.from({ length: 10 }, (_unused, index) => ref(`0000000${index}-0000-4000-8000-000000000000`));
    const wrapper = await mount({ projectId, selectedRefs: selected });
    try {
      await wrapper.get("#assist-source-query").setValue("资料");
      await wrapper.get('[data-testid="assist-source-picker"] form').trigger("submit");
      await flush(20);
      const emissions = wrapper.emitted.length;
      await wrapper.get('[data-region="results"] input[type="checkbox"]').setValue(true);
      expect(wrapper.get('[data-testid="assist-source-limit"]').text()).toContain("最多选择 10 个资料版本");
      expect(wrapper.find('[data-testid="assist-source-retry"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="assist-source-body"] .action-error').exists()).toBe(false);
      expect(wrapper.emitted.length).toBe(emissions);
      expect(wrapper.get('[data-testid="assist-source-count"]').text()).toContain("已选 10 / 10");
    } finally { wrapper.unmount(); }
  });

  it("限高与内部滚动、面板字号档位留在样式表里（不新增数值档）", () => {
    const css = readFileSync("src/migrated-scoped.css", "utf8");
    const rule = (selector: string) => {
      const found = new RegExp(`^\\.${selector}\\s*\\{([^}]*)\\}`, "mu").exec(css);
      if (!found) throw new Error(`缺少样式规则：.${selector}`);
      return found[1]!;
    };
    const body = rule("assist-source-body");
    expect(body).toContain("max-height: min(30dvh, var(--relay-layout-workspace-sideWidth))");
    expect(body).toContain("overflow-y: auto");
    expect(rule("assist-source-title")).toContain("font-size: var(--relay-font-size-body)");
    for (const selector of ["assist-source-title", "assist-source-count", "assist-source-scope", "assist-source-body"]) {
      expect(rule(selector)).not.toMatch(/font-size:\s*\d/);
    }
  });
});
