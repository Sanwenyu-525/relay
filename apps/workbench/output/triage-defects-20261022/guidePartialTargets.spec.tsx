import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayApiClient } from "../../src/api/relayClient";
import ProjectKnowledgeGuide from "../../src/components/ProjectKnowledgeGuide";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });
it("任务成果读取失败时不应宣称所有可收录成果都已加入导读", async () => {
  const client = {
    getProjectKnowledgeGuide: vi.fn(async () => ({ exists: true, revision: "1", entryCount: 1, gaps: [],
      entries: [{ ordinal: 0, refKind: "KNOWLEDGE", referenceMode: "CURRENT", targetId: "knowledge", label: null, title: "已收录资料",
        resolvedVersionNumber: "1", resolution: "AVAILABLE", note: null, targetStatus: "ACTIVE", resolvedVersionId: "knowledge-version" }] })),
    getDecisions: vi.fn(async () => []), getRules: vi.fn(async () => []),
    getKnowledge: vi.fn(async () => [{ id: "knowledge", projectId: "project", title: "已收录资料" }]),
    getProjectTasks: vi.fn(async () => [{ id: "task-with-unread-artifacts" }]),
    getTaskArtifacts: vi.fn(async () => { throw new Error("TASK_ARTIFACT_READ_UNAVAILABLE"); })
  } as unknown as RelayApiClient;
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(ProjectKnowledgeGuide, { client, projectId: "project", onOpen: vi.fn() })));
  unmount = mounted.unmount; await flush(); await flush();
  expect(client.getTaskArtifacts).toHaveBeenCalledWith("task-with-unread-artifacts");
  const text = mounted.wrapper.text();
  const claimsComplete = text.includes("本项目可收录的决定、规则、资料与成果版本都已在导读中。");
  const alerts = mounted.wrapper.findAll('[role="alert"]').length;
  console.log("TRIAGE_GUIDE_PARTIAL_TARGETS", JSON.stringify({ claimsComplete, alerts, text }));
  expect(claimsComplete).toBe(false);
});
