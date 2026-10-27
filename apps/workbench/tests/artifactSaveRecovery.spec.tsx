import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import ArtifactPanel from "../src/components/ArtifactPanel";
import { sha256Hex } from "../src/lib/sha256";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountReact } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const taskId = "33333333-3333-4333-8333-333333333333";
const artifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const versionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.(); cleanup = undefined; resetRelayConnectionForTest();
  vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear();
});

function connect() {
  activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function result(content: string) {
  return { task_id: taskId, artifact_id: artifactId, artifact_revision: "0", version_id: versionId,
    version_number: "1", media_type: "text/markdown", sha256: sha256Hex(content),
    size: String(new TextEncoder().encode(content).byteLength), task_revision: "3" };
}

async function mount() {
  connect();
  const view = await mountReact(createElement(MemoryRouter, {}, createElement(ArtifactPanel, {
    taskId, projectId: null, taskStatus: "IN_PROGRESS", taskRevision: "2", acceptanceRevision: "1",
    criteria: [], allowedActions: ["SAVE_ARTIFACT_VERSION", "COMPLETE"], writeBlockedReason: null,
    onRefresh: () => undefined
  })));
  cleanup = view.unmount;
  await flush(25);
  return view;
}

function listResponse() { return response({ items: [], current_accepted_version_ids: [] }); }

it("保存响应丢失后编辑草稿，重试仍发送本机持久化的原 ID 和正文", async () => {
  const posted: Record<string, unknown>[] = [];
  let sends = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push(body); sends += 1;
      if (sends === 1) throw new TypeError("lost artifact save response");
      return response({ command_id: body.command_id, committed_at: "2026-10-25T00:00:00.000Z",
        result: result(String(body.content)) });
    }
    if (url === `${root}/tasks/${taskId}/artifacts`) return listResponse();
    throw new Error(`unexpected ${url}`);
  }));
  const view = await mount();
  const original = "# 原始冻结正文\n";
  await view.wrapper.get('input[name="artifact-title"]').setValue("成果 A");
  await view.wrapper.get("#artifact-content").setValue(original);
  await view.wrapper.get('[data-testid="artifact-save"]').trigger("click"); await flush(25);
  const frozen = posted[0]!;
  expect(view.wrapper.get('[data-testid="artifact-save-pending"]').text()).toContain(String(frozen.command_id));
  expect(localStorage.length).toBe(1);

  await view.wrapper.get("#artifact-content").setValue("# 后续新草稿\n");
  await view.wrapper.get('[data-testid="artifact-save"]').trigger("click"); await flush(25);
  expect(posted).toHaveLength(2);
  expect(posted[1]).toEqual(frozen);
  expect(posted[1]!.content).toBe(original);
  expect(view.wrapper.get('[data-testid="artifact-save-receipt"]').text()).toContain("已创建产物并保存 v1");
});

it("卸载并重新挂载后从本机持久记录查询保存回执，不创建第二条命令", async () => {
  const posted: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      throw new TypeError("lost artifact save response");
    }
    if (url === `${root}/tasks/${taskId}/artifacts`) return listResponse();
    if (url.startsWith(`${root}/commands/`)) {
      const commandId = url.slice(`${root}/commands/`.length);
      return response({ command_id: commandId, command_type: "CreateArtifactWithVersion",
        committed_at: "2026-10-25T00:00:00.000Z", result: result("# persisted\n") });
    }
    throw new Error(`unexpected ${url}`);
  }));
  const first = await mount();
  await first.wrapper.get('input[name="artifact-title"]').setValue("成果 A");
  await first.wrapper.get("#artifact-content").setValue("# persisted\n");
  await first.wrapper.get('[data-testid="artifact-save"]').trigger("click"); await flush(25);
  const commandId = String(posted[0]!.command_id);
  first.unmount(); cleanup = undefined;

  const resumed = await mount();
  expect(resumed.wrapper.get('[data-testid="artifact-save-pending"]').text()).toContain(commandId);
  await resumed.wrapper.get('[data-testid="artifact-save-receipt-query"]').trigger("click"); await flush(25);
  expect(resumed.wrapper.get('[data-testid="artifact-save-receipt"]').text()).toContain("回执确认已提交");
  expect(posted).toHaveLength(1);
  expect(localStorage.length).toBe(0);
});

it.each(["command_id", "sha256", "size", "version_number", "artifact_revision", "task_revision"] as const)("保存响应的 %s 与原请求不符时保留待核对命令", async (field) => {
  const posted: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push(body);
      const saved = result(String(body.content));
      if (field === "sha256") saved.sha256 = "0".repeat(64);
      if (field === "size") saved.size = String(Number(saved.size) + 1);
      if (field === "version_number") saved.version_number = "99";
      if (field === "artifact_revision") saved.artifact_revision = "99";
      if (field === "task_revision") saved.task_revision = "99";
      return response({ command_id: field === "command_id" ? "99999999-9999-4999-8999-999999999999" : body.command_id,
        committed_at: "2026-10-25T00:00:00.000Z", result: saved });
    }
    if (url === `${root}/tasks/${taskId}/artifacts`) return listResponse();
    throw new Error(`unexpected ${url}`);
  }));
  const view = await mount();
  await view.wrapper.get('input[name="artifact-title"]').setValue("成果 A");
  await view.wrapper.get("#artifact-content").setValue("# body\n");
  await view.wrapper.get('[data-testid="artifact-save"]').trigger("click"); await flush(25);
  expect(view.wrapper.get('[data-testid="artifact-save-pending"]').text()).toContain(String(posted[0]!.command_id));
  expect(view.wrapper.get('[data-testid="artifact-save-receipt-query"]').exists()).toBe(true);
  expect(view.wrapper.find('[data-testid="artifact-save-receipt"]').exists()).toBe(false);
  expect(localStorage.length).toBe(1);
});
