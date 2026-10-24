import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayApiClient } from "../../src/api/relayClient";
import ProjectKnowledgeGuide from "../../src/components/ProjectKnowledgeGuide";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });
function LocationProbe() { return createElement("output", { "data-testid": "location" }, useLocation().pathname); }
it("导读里的成果版本标题应进入确切版本入口，而不是无响应按钮", async () => {
  const onOpen = vi.fn();
  const client = { getProjectKnowledgeGuide: vi.fn(async () => ({ exists: true, revision: "1", entryCount: 1, gaps: [], entries: [{ ordinal: 0,
    refKind: "ARTIFACT_VERSION", referenceMode: "CURRENT", targetId: "artifact-version-1", label: "核对这份成果", title: "结果.md", resolvedVersionNumber: "1", resolvedVersionId: "artifact-version-1",
    resolution: "AVAILABLE", note: null, targetStatus: "ACTIVE" }] })), getDecisions: vi.fn(async () => []), getRules: vi.fn(async () => []), getKnowledge: vi.fn(async () => []), getProjectTasks: vi.fn(async () => []) } as unknown as RelayApiClient;
  const mounted = await mountReact(createElement(MemoryRouter, { initialEntries: ["/projects/project/knowledge"] },
    createElement(ProjectKnowledgeGuide, { client, projectId: "project", onOpen }), createElement(LocationProbe)));
  unmount = mounted.unmount; await flush();
  await mounted.wrapper.get('[data-testid="guide-entry-ARTIFACT_VERSION"] button').trigger("click"); await flush();
  const location = mounted.wrapper.get('[data-testid="location"]').text();
  console.log("TRIAGE_GUIDE_ARTIFACT_NAVIGATION", JSON.stringify({ location, onOpenCalls: onOpen.mock.calls.length }));
  expect(location).toBe("/artifact-versions/artifact-version-1/lineage");
});
