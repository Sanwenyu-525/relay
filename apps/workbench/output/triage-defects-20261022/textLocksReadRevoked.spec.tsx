import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import ArtifactTextLocksPanel from "../../src/components/ArtifactTextLocksPanel";
import { RelayApiError, type RelayApiClient, type RelayArtifactLineage } from "../../src/api/relayClient";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });
it("锁定事实刷新403后应撤下旧原文并停止沿旧事实操作", async () => {
  let revoked = false;
  const forbidden = () => new RelayApiError({ status: 403, code: "PERMISSION_DENIED", detail: "access revoked", retryable: false, retryAction: null, fieldErrors: [], expectedRevision: null, actualRevision: null });
  const client = {
    getArtifact: vi.fn(async () => { if (revoked) throw forbidden(); return { id: "artifact", revision: "7", latestVersionId: "version" }; }),
    getArtifactTextLocks: vi.fn(async () => { if (revoked) throw forbidden(); return [{ id: "lock", artifactId: "artifact", blockKind: "PARAGRAPH", blockIndex: 0, status: "ACTIVE", text: "LOCK_SECRET_BEFORE_REVOKE", baseVersionId: "version" }]; }),
    getArtifactVersionContent: vi.fn(async () => { if (revoked) throw forbidden(); return "BODY_SECRET_BEFORE_REVOKE"; }),
    unlockArtifactText: vi.fn(async () => { throw forbidden(); })
  } as unknown as RelayApiClient;
  const lineage = { artifactVersionId: "version", artifactId: "artifact", versionNumber: "1", sha256: "a".repeat(64), sourceKind: "HUMAN", contentAvailability: "AVAILABLE", directParents: [] } as RelayArtifactLineage;
  const mounted = await mountReact(createElement(ArtifactTextLocksPanel, { client, lineage })); unmount = mounted.unmount; await flush();
  expect(mounted.wrapper.text()).toContain("LOCK_SECRET_BEFORE_REVOKE");
  revoked = true;
  await mounted.wrapper.findAll("button").find(button => button.text() === "刷新锁定事实")!.trigger("click"); await flush();
  expect(mounted.wrapper.find('[role="alert"]').exists()).toBe(true);
  const secretStillVisible = mounted.wrapper.text().includes("LOCK_SECRET_BEFORE_REVOKE") || mounted.wrapper.text().includes("BODY_SECRET_BEFORE_REVOKE");
  const unlock = mounted.wrapper.findAll("button").find(button => button.text() === "解除这一处锁定");
  const unlockEnabled = unlock !== undefined && unlock.attributes("disabled") === undefined;
  if (unlockEnabled) { await unlock!.trigger("click"); await flush(); }
  console.log("TRIAGE_TEXT_LOCKS_READ_REVOKED", JSON.stringify({ secretStillVisible, unlockEnabled, unlockCalls: (client.unlockArtifactText as ReturnType<typeof vi.fn>).mock.calls.length }));
  expect(secretStillVisible).toBe(false);
  expect(unlockEnabled).toBe(false);
});
