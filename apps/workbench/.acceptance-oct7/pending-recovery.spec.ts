import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import FileWriteDispositionPanel from "../src/components/FileWriteDispositionPanel";
import RunControlPanel, { type RunControlState } from "../src/components/RunControlPanel";
import { RelayTransportError, type RelayApiClient } from "../src/api/relayClient";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush } from "../tests/mountApp";
let root: Root | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; sessionStorage.clear(); resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
const baseUrl = "http://127.0.0.1:8787", workspaceId = "11111111-1111-4111-8111-111111111111";
const operationId = "55555555-5555-4555-8555-555555555555", runId = "33333333-3333-4333-8333-333333333333";
const invocationId = "66666666-6666-4666-8666-666666666666";
async function click(selector: string) { await act(async () => document.querySelector<HTMLButtonElement>(selector)!.click()); await flush(10); }
it("切Operation后迟到未知响应仍保存原处置命令", async () => {
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((_resolve, failed) => { reject = failed; });
  const client = {baseUrl, workspaceId,
    getFileWriteChangeSets: async () => [],
    getFileWriteDispositionPreview: async () => ({ runId, changeSetId:null, invocationId, canDispose:true, observationSha256:"b".repeat(64), runRevision:"3", taskRevision:"4", files:[], blockingReasons:[], disposition:null }),
    closePartialFileWrite: vi.fn(async () => gate),
  } as unknown as RelayApiClient;
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const render = async (op: string) => { await act(async () => root!.render(createElement(FileWriteDispositionPanel, {client, operationId:op,runId,runRevision:"3",onFactsChanged:async () => {}}))); await flush(15); };
  await render(operationId); await click('[data-testid="file-write-dispose-open"]'); await click('[data-testid="file-write-dispose-confirm"]');
  const key = `relay:file-write-disposition:${baseUrl}:${workspaceId}:${operationId}`;
  const original = sessionStorage.getItem(key); expect(original).not.toBeNull();
  await render("77777777-7777-4777-8777-777777777777");
  await act(async () => reject(new RelayTransportError("response lost after commit"))); await flush(10);
  expect(sessionStorage.getItem(key)).toBe(original);
});
it("同Run revision更新不能丢失未知控制命令身份", async () => {
  activateRelayConnection({baseUrl,workspaceId,bearerToken:"test-token"});
  vi.stubGlobal("fetch", vi.fn(async () => {throw new TypeError("response lost after commit");}));
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const state = {run:{id:runId,revision:"3",status:"RUNNING",pendingControlRequest:null,waitReason:null}, task:{id:"22222222-2222-4222-8222-222222222222",revision:"4",executor:"AI",status:"IN_PROGRESS"},controlRecord:null,activeRun:true,terminal:false,projectWriteBlockedReason:null} as unknown as RunControlState;
  const render = async (s: RunControlState) => {await act(async () => root!.render(createElement(RunControlPanel,{state:s,onReload:async () => {}})));await flush(10);};
  await render(state);await click('[data-testid="run-control-PAUSE"]');
  expect(document.querySelector('[data-testid="run-check-receipt"]')).not.toBeNull();
  await render({...state,run:{...state.run,revision:"4"}});
  expect(document.querySelector('[data-testid="run-check-receipt"]')).not.toBeNull();
});
