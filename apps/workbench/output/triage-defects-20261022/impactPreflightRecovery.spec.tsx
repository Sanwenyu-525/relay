import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayApiClient, RelayArtifactLineage } from "../../src/api/relayClient";
import ArtifactImpactCheckPanel from "../../src/components/ArtifactImpactCheckPanel";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });
it("生成影响候选前发现目标版本变化且未发写命令时，应允许重查而非永久pending", async () => {
  const startCandidate = vi.fn();
  const client = {
    getArtifact: vi.fn(async (id: string) => id === "source" ? { id, revision: "2", latestVersionId: "after",
      versions: [{ artifactVersionId: "before", versionNumber: "1" }, { artifactVersionId: "after", versionNumber: "2" }] }
      : { id, revision: "3", latestVersionId: "target-new" }),
    getArtifactDirectUses: vi.fn(async () => ({ directUses: [], hasMore: false })),
    startArtifactImpactCheck: vi.fn(async () => "check"),
    getArtifactImpactCheck: vi.fn(async () => ({ id: "check", status: "COMPLETED", stale: false, errorCode: null,
      possiblyRelated: [], directTargets: [{ targetVersionId: "target-old", targetArtifactId: "target", versionNumber: "1", availability: "AVAILABLE", relation: "DERIVED_FROM", analysed: false }],
      unanalysedScope: [] })),
    startArtifactImpactCandidate: startCandidate
  } as unknown as RelayApiClient;
  const lineage = { artifactVersionId: "after", artifactId: "source", versionNumber: "2", sha256: "a".repeat(64), sourceKind: "HUMAN", contentAvailability: "AVAILABLE", directParents: [] } as RelayArtifactLineage;
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(ArtifactImpactCheckPanel, { client, lineage }))); unmount = mounted.unmount; await flush();
  await mounted.wrapper.get("select").setValue("before"); await flush();
  const button = (text: string) => mounted.wrapper.findAll("button").find(item => item.text() === text)!;
  await button("检查影响").trigger("click"); await flush();
  await button("为此目标生成修改候选").trigger("click"); await flush();
  expect(startCandidate).not.toHaveBeenCalled();
  expect(mounted.wrapper.text()).toContain("目标已出现新版本；请重新检查影响");
  console.log("TRIAGE_IMPACT_PREFLIGHT", JSON.stringify({ candidateWrites: startCandidate.mock.calls.length, disabled: button("检查影响").attributes("disabled") !== undefined }));
  expect(button("检查影响").attributes("disabled")).toBeUndefined();
});
