import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayApiClient } from "../../src/api/relayClient";
import ProjectKnowledgeGuide from "../../src/components/ProjectKnowledgeGuide";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });
it("保存请求在途期间允许的人工说明编辑不应被成功回包吞掉", async () => {
  let storedLabel = "原说明";
  let revision = "1";
  let finishSave: (() => void) | undefined;
  const saves: unknown[] = [];
  const client = {
    getProjectKnowledgeGuide: vi.fn(async () => ({ exists: true, revision, entryCount: 1, gaps: [],
      entries: [{ ordinal: 0, refKind: "KNOWLEDGE", referenceMode: "CURRENT", targetId: "knowledge", label: storedLabel, title: "项目资料",
        resolvedVersionNumber: "1", resolution: "AVAILABLE", note: null, targetStatus: "ACTIVE", resolvedVersionId: "knowledge-version" }] })),
    getDecisions: vi.fn(async () => []), getRules: vi.fn(async () => []), getKnowledge: vi.fn(async () => []), getProjectTasks: vi.fn(async () => []),
    saveProjectKnowledgeGuide: vi.fn(async (input: { entries: { label: string }[] }) => {
      saves.push(input);
      await new Promise<void>(resolve => { finishSave = resolve; });
      storedLabel = input.entries[0]!.label; revision = "2";
    })
  } as unknown as RelayApiClient;
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(ProjectKnowledgeGuide, { client, projectId: "project", onOpen: vi.fn() })));
  unmount = mounted.unmount; await flush();
  await mounted.wrapper.get('input[type="text"]').setValue("已提交的说明A");
  await mounted.wrapper.findAll("button").find(button => button.text() === "保存导读")!.trigger("click");
  await flush();
  const editableInFlight = mounted.wrapper.get('input[type="text"]').attributes("disabled") === undefined;
  expect(editableInFlight).toBe(true);
  await mounted.wrapper.get('input[type="text"]').setValue("请求发出后继续输入的说明B");
  expect((mounted.wrapper.get('input[type="text"]').element as HTMLInputElement).value).toBe("请求发出后继续输入的说明B");
  finishSave!(); await flush(); await flush();
  const displayed = (mounted.wrapper.get('input[type="text"]').element as HTMLInputElement).value;
  const saveDisabled = mounted.wrapper.findAll("button").find(button => button.text() === "保存导读")!.attributes("disabled") !== undefined;
  console.log("TRIAGE_GUIDE_INFLIGHT", JSON.stringify({ editableInFlight, saves, storedLabel, displayed, saveDisabled, success: mounted.wrapper.text().includes("导读已保存") }));
  expect(displayed).toBe("请求发出后继续输入的说明B");
});
