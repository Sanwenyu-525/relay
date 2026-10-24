import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import ArtifactTextLocksPanel from "../../src/components/ArtifactTextLocksPanel";
import type { RelayApiClient, RelayArtifactLineage } from "../../src/api/relayClient";
import { markdownBlocks } from "../../../api/src/artifact/markdown-locks";
import { flush, mountReact } from "../../tests/mountApp";
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; });
it.each(["\n", "\r\n", "\r"])("换行%j的前端锁定段落编号必须与服务端切块一致", async (separator) => {
  const content = `first paragraph${separator}${separator}second paragraph`;
  const actualServerBlocks = markdownBlocks(content, "PARAGRAPH");
  const client = { getArtifact: vi.fn(async () => ({ id: "artifact", revision: "1", latestVersionId: "version" })),
    getArtifactTextLocks: vi.fn(async () => []), getArtifactVersionContent: vi.fn(async () => content) } as unknown as RelayApiClient;
  const lineage = { artifactVersionId: "version", artifactId: "artifact", versionNumber: "1", sha256: "a".repeat(64), sourceKind: "HUMAN", contentAvailability: "AVAILABLE", directParents: [] } as RelayArtifactLineage;
  const mounted = await mountReact(createElement(ArtifactTextLocksPanel, { client, lineage })); unmount = mounted.unmount; await flush();
  const selectors = mounted.wrapper.findAll("select");
  const options = selectors[1].findAll("option");
  console.log("TRIAGE_TEXT_LOCK_LINE_ENDINGS", JSON.stringify({ displayedOptions: options.map(option => option.text()), serverBlocks: actualServerBlocks.map(block => ({ index: block.index, text: block.text })) }));
  expect(options).toHaveLength(actualServerBlocks.length);
});
