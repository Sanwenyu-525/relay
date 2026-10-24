import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayApiClient, RelayArtifactLineage } from "../../src/api/relayClient";
import ArtifactImpactCheckPanel from "../../src/components/ArtifactImpactCheckPanel";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });
it("影响检查切换变化前版本后，不能沿用未标明旧基线的结果生成修改候选", async () => {
  const writes: Record<string, unknown>[] = [];
  const client = {
    getArtifact: vi.fn(async (id: string) => id === "source" ? { id, revision: "3", latestVersionId: "after", versions: [
      { artifactVersionId: "before-a", versionNumber: "1" }, { artifactVersionId: "before-b", versionNumber: "2" }, { artifactVersionId: "after", versionNumber: "3" }] }
      : { id, revision: "1", latestVersionId: "target-version" }),
    getArtifactDirectUses: vi.fn(async () => ({ directUses: [], hasMore: false })),
    startArtifactImpactCheck: vi.fn(async () => "check-for-a"),
    getArtifactImpactCheck: vi.fn(async () => ({ id: "check-for-a", sourceBeforeVersionId: "before-a", sourceAfterVersionId: "after", status: "COMPLETED", stale: false, errorCode: null,
      possiblyRelated: [], directTargets: [{ targetVersionId: "target-version", targetArtifactId: "target", versionNumber: "1", availability: "AVAILABLE", relation: "DERIVED_FROM", analysed: false }], unanalysedScope: [] })),
    startArtifactImpactCandidate: vi.fn(async (input: Record<string, unknown>) => { writes.push(input); return "candidate"; }),
    getArtifactImpactCandidate: vi.fn(async () => ({ id: "candidate", targetVersionId: "target-version", targetArtifactId: "target", status: "COMPLETED", stale: false, errorCode: null, markdown: "candidate derived from A", appliedVersionId: null }))
  } as unknown as RelayApiClient;
  const lineage = { artifactVersionId: "after", artifactId: "source", versionNumber: "3", sha256: "a".repeat(64), sourceKind: "HUMAN", contentAvailability: "AVAILABLE", directParents: [] } as RelayArtifactLineage;
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(ArtifactImpactCheckPanel, { client, lineage }))); unmount = mounted.unmount; await flush();
  await mounted.wrapper.get("select").setValue("before-a"); await flush();
  await mounted.wrapper.findAll("button").find(button => button.text() === "检查影响")!.trigger("click"); await flush();
  expect(mounted.wrapper.find('[data-testid="artifact-impact-result"]').exists()).toBe(true);
  await mounted.wrapper.get("select").setValue("before-b"); await flush();
  const generate = mounted.wrapper.findAll("button").find(button => button.text() === "为此目标生成修改候选");
  if (generate) { await generate.trigger("click"); await flush(); }
  console.log("TRIAGE_IMPACT_BASELINE_SWITCH", JSON.stringify({ selectedBefore: (mounted.wrapper.get("select").element as HTMLSelectElement).value, writes }));
  expect(writes).toHaveLength(0);
});
