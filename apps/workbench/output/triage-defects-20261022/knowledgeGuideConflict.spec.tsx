import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { RelayApiError, type RelayApiClient } from "../../src/api/relayClient";
import ProjectKnowledgeGuide from "../../src/components/ProjectKnowledgeGuide";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });
it("项目导读保存冲突重读时，不应抛弃用户人工说明草稿", async () => {
  let changed = false;
  const client = {
    getProjectKnowledgeGuide: vi.fn(async () => ({ exists: true, revision: changed ? "2" : "1", entryCount: 1, gaps: [],
      entries: [{ ordinal: 0, refKind: "KNOWLEDGE", referenceMode: "CURRENT", targetId: "knowledge", label: changed ? "另一入口已保存的说明" : "原说明", title: "项目资料",
        resolvedVersionNumber: "1", resolution: "AVAILABLE", note: null, targetStatus: "ACTIVE", resolvedVersionId: "knowledge-version" }] })),
    getDecisions: vi.fn(async () => []), getRules: vi.fn(async () => []), getKnowledge: vi.fn(async () => []), getProjectTasks: vi.fn(async () => []),
    saveProjectKnowledgeGuide: vi.fn(async () => {
      changed = true;
      throw new RelayApiError({ status: 409, code: "REVISION_CONFLICT", detail: "changed", retryable: false, retryAction: "REFRESH_AND_REDECIDE", fieldErrors: [], expectedRevision: "1", actualRevision: "2" });
    })
  } as unknown as RelayApiClient;
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(ProjectKnowledgeGuide, { client, projectId: "project", onOpen: vi.fn() })));
  unmount = mounted.unmount; await flush();
  await mounted.wrapper.get('input[type="text"]').setValue("我刚编辑的人工说明必须保留");
  await mounted.wrapper.findAll("button").find(button => button.text() === "保存导读")!.trigger("click"); await flush();
  expect(mounted.wrapper.text()).toContain("导读已被别处改动");
  const value = (mounted.wrapper.get('input[type="text"]').element as HTMLInputElement).value;
  console.log("TRIAGE_GUIDE_CONFLICT", JSON.stringify({ value }));
  expect(value).toBe("我刚编辑的人工说明必须保留");
});
