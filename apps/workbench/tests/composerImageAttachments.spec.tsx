import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSIST_ATTACHMENT_MEDIA_TYPES, MAX_ASSIST_ATTACHMENTS_PER_MESSAGE, MAX_ASSIST_ATTACHMENT_BYTES,
  MAX_ASSIST_ATTACHMENT_TOTAL_BYTES, attachmentProblem, formatAttachmentBytes,
} from "../src/components/composerAttachments";
import { activateRelayConnection, resetRelayConnectionForTest } from "../src/lib/relayConnection";
import { flush, mountWorkbench } from "./mountApp";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const attachmentId = "44444444-4444-4444-8444-444444444444";
const prefix = `/api/v1/workspaces/${workspaceId}`;

function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}
function session() {
  return { id: sessionId, workspace_id: workspaceId, project_id: projectId, task_id: null,
    title: "关于测试项目", status: "ACTIVE", revision: "1", updated_at: "2026-10-18T00:00:00Z" };
}
function message(id: string, seq: string, content: string, attachments: unknown[] = []) {
  return { id, session_id: sessionId, seq, role: "USER", status: "COMPLETED", intent: "DISCUSS",
    content, error_code: null, provider_error_kind: null, sources: [], skill: null, skill_input: null,
    skill_output: null, method: null, method_argument: null, provider_request_id: null,
    usage: { input_tokens: 0, output_tokens: 0 }, cancel_requested: false, attachments,
    created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z" };
}

/** 粘贴一张图片：jsdom 没有剪贴板实现，只能自己造一个带 clipboardData 的 paste 事件。 */
async function pasteFile(target: Element, file: File): Promise<void> {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    files: [file], types: ["Files"] } });
  await act(async () => { target.dispatchEvent(event); });
}
async function pasteText(target: Element, text: string): Promise<Event> {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
    files: [], types: ["text/plain"], getData: () => text } });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

afterEach(() => { resetRelayConnectionForTest(); vi.unstubAllGlobals(); });

describe("输入框图片附件（工作台 §33）", () => {
  it("前端上限与服务端常量是同一组数值", () => {
    const source = readFileSync(resolve(__dirname, "../../api/src/application/assist-attachments.ts"), "utf8");
    expect(MAX_ASSIST_ATTACHMENT_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_ASSIST_ATTACHMENT_TOTAL_BYTES).toBe(6 * 1024 * 1024);
    expect(MAX_ASSIST_ATTACHMENTS_PER_MESSAGE).toBe(4);
    expect(source).toContain(`export const MAX_ASSIST_ATTACHMENT_BYTES = 2 * 1024 * 1024;`);
    expect(source).toContain(`export const MAX_ASSIST_ATTACHMENTS_PER_MESSAGE = ${MAX_ASSIST_ATTACHMENTS_PER_MESSAGE};`);
    expect(source).toContain(`export const MAX_ASSIST_ATTACHMENT_TOTAL_BYTES = 6 * 1024 * 1024;`);
    for (const mediaType of ASSIST_ATTACHMENT_MEDIA_TYPES) expect(source).toContain(`'${mediaType}'`);
    expect(formatAttachmentBytes(1024)).toBe("1 KB");
    expect(formatAttachmentBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("逐张裁决类型、单张大小、数量与总量，非图片给出可读理由", () => {
    const png = (size: number, name = "shot.png") => new File([new Uint8Array(size)], name, { type: "image/png" });
    const staged = (size: number, index: number) => ({
      key: `k${index}`, url: "", file: png(size), name: `图${index}`,
      mediaType: "image/png", byteLength: size });
    expect(attachmentProblem(new File(["x"], "a.pdf", { type: "application/pdf" }), [])).toContain("仅支持 PNG");
    expect(attachmentProblem(new File([], "empty.png", { type: "image/png" }), [])).toContain("空文件");
    expect(attachmentProblem(png(MAX_ASSIST_ATTACHMENT_BYTES + 1), [])).toContain("单张上限");
    expect(attachmentProblem(png(10), Array.from({ length: MAX_ASSIST_ATTACHMENTS_PER_MESSAGE },
      (_, index) => staged(10, index)))).toContain("最多 4 张");
    expect(attachmentProblem(png(MAX_ASSIST_ATTACHMENT_BYTES),
      [staged(MAX_ASSIST_ATTACHMENT_BYTES, 1), staged(MAX_ASSIST_ATTACHMENT_BYTES, 2),
        staged(1024 * 1024, 3)]))
      .toContain("超过每条消息");
    expect(attachmentProblem(png(10), [staged(10, 1)])).toBeNull();
  });

  it("纯文本粘贴逐字不变，只有文件项才进附件暂存", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "测试项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}` && init?.method !== "POST")
        return response(session());
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [] });
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      if (init?.method !== "POST") return response({ items: [] });
      throw new Error(`unexpected POST ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    const draft = view.wrapper.get('[data-testid="assist-draft"]').element!;
    const textEvent = await pasteText(draft, "一段文字");
    expect(textEvent.defaultPrevented).toBe(false);
    expect(view.wrapper.find('[data-testid="composer-attachments"]').exists()).toBe(false);
    view.unmount();
  });

  it("粘贴图片只暂存、不发请求；发送时先上传再带 attachment_ids 提交空正文", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let uploadBody: Record<string, unknown> | null = null;
    let sentBody: Record<string, unknown> | null = null;
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST") posts.push(path);
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "测试项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { command_id: string };
        return response({ command_id: body.command_id, committed_at: "2026-10-18T00:00:00Z",
          result: { ...session(), session_id: sessionId } }, 201);
      }
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}` && init?.method !== "POST")
        return response(session());
      if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method !== "POST")
        return response({ items: [] });
      if (path === `${prefix}/assist-sessions/${sessionId}/message-attachments`) {
        uploadBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ attachment_id: attachmentId, byte_length: 3, content_hash: "hash" }, 201);
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ command_id: sentBody.command_id, committed_at: "2026-10-18T00:00:00Z",
          result: { session_id: sessionId, user_message_id: attachmentId,
            assistant_message_id: "55555555-5555-4555-8555-555555555555" } }, 202);
      }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      if (init?.method !== "POST") return response({ items: [] });
      throw new Error(`unexpected POST ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    await flush();
    const draft = view.wrapper.get('[data-testid="assist-draft"]').element!;
    await pasteFile(draft, new File([new Uint8Array([1, 2, 3])], "截图.png", { type: "image/png" }));
    expect(view.wrapper.get('[data-testid="composer-attachments"]').text()).toContain("截图.png");
    // 暂存期间不发任何请求：上传只在点发送之后发生。
    expect(posts).toEqual([]);
    const send = view.wrapper.get('[data-testid="assist-send"]');
    // 只有图片、没有正文也允许发送：发送键不再按「正文为空」禁用（§33 / HTTP §10.85）。
    expect(send.attributes("disabled")).toBeUndefined();
    await send.trigger("click");
    await flush();
    expect(uploadBody).toMatchObject({ name: "截图.png", media_type: "image/png", data_base64: "AQID" });
    expect(sentBody).toMatchObject({ content: "", attachment_ids: [attachmentId] });
    // 发送成功后芯片清空，不留在框里等待重复发送。
    expect(view.wrapper.find('[data-testid="composer-attachments"]').exists()).toBe(false);
    view.unmount();
  });

  it("首条消息也能只发图片：先建会话、再上传、最后按同一组 id 发首条", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let uploadBody: Record<string, unknown> | null = null;
    let sentBody: Record<string, unknown> | null = null;
    const order: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST") order.push(path);
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "测试项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { command_id: string; title: string };
        // 没有正文的首条用「关于{目标}」兜底：服务端的 title CHECK 不接受空标题。
        expect(body.title).toBe("关于测试项目");
        return response({ command_id: body.command_id, committed_at: "2026-10-18T00:00:00Z",
          result: { ...session(), session_id: sessionId } }, 201);
      }
      if (path === `${prefix}/assist-sessions`) return response({ items: [] });
      if (path === `${prefix}/assist-sessions/${sessionId}` && init?.method !== "POST")
        return response(session());
      if (path === `${prefix}/assist-sessions/${sessionId}/message-attachments`) {
        uploadBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ attachment_id: attachmentId, byte_length: 3, content_hash: "hash" }, 201);
      }
      if (path === `${prefix}/assist-sessions/${sessionId}/messages` && init?.method !== "POST")
        return response({ items: [] });
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ command_id: sentBody.command_id, committed_at: "2026-10-18T00:00:00Z",
          result: { session_id: sessionId, user_message_id: attachmentId,
            assistant_message_id: "55555555-5555-4555-8555-555555555555" } }, 202);
      }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      if (init?.method !== "POST") return response({ items: [] });
      throw new Error(`unexpected POST ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    const draft = view.wrapper.get('[data-testid="assist-first-draft"]').element!;
    await pasteFile(draft, new File([new Uint8Array([1, 2, 3])], "首条.png", { type: "image/png" }));
    expect(view.wrapper.get('[data-testid="composer-attachments"]').text()).toContain("首条.png");
    expect(view.wrapper.get('[data-testid="assist-first-send"]').attributes("disabled")).toBeUndefined();
    await view.wrapper.get('[data-testid="assist-first-send"]').trigger("click");
    await flush();
    // 顺序就是契约：会话必须先存在，附件才有上传目标；附件先于消息命令产生 id。
    expect(order).toEqual([`${prefix}/assist-sessions`,
      `${prefix}/assist-sessions/${sessionId}/message-attachments`,
      `${prefix}/assist-sessions/${sessionId}/messages`]);
    expect(uploadBody).toMatchObject({ name: "首条.png", data_base64: "AQID" });
    expect(sentBody).toMatchObject({ content: "", attachment_ids: [attachmentId] });
    view.unmount();
  });

  it("历史消息里的附件按需读取并渲染缩略图，读取失败就地说明", async () => {
    activateRelayConnection({ baseUrl, workspaceId, bearerToken: "test-token" });
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === `${prefix}/projects/${projectId}`) return response({ id: projectId, title: "测试项目",
        project_type: "GENERAL", revision: "1", state_revision: "1", archived_at: null });
      if (path === `${prefix}/assist-sessions`) return response({ items: [session()] });
      if (path === `${prefix}/assist-sessions/${sessionId}` && init?.method !== "POST")
        return response(session());
      if (path === `${prefix}/assist-sessions/${sessionId}/messages`) return response({ items: [
        message("66666666-6666-4666-8666-666666666666", "1", "",
          [{ id: attachmentId, name: "截图.png", media_type: "image/png", byte_length: 3 }])] });
      if (path === `${prefix}/assist-sessions/${sessionId}/message-attachments/${attachmentId}`) {
        reads += 1;
        return response({ attachment_id: attachmentId, name: "截图.png", media_type: "image/png",
          byte_length: 3, data_base64: "AQID" });
      }
      if (path === `${prefix}/assist-proposals`) return response({ items: [] });
      if (path === `${prefix}/skill-definitions`) return response({ items: [] });
      if (init?.method !== "POST") return response({ items: [] });
      throw new Error(`unexpected POST ${path}`);
    }));
    const view = await mountWorkbench(`/projects/${projectId}?skill=assist`);
    await flush();
    const gallery = view.wrapper.get('[data-testid="assist-message-attachments"]');
    expect(gallery.text()).toContain("截图.png");
    expect(view.wrapper.get(".message-attachment-image").attributes("src"))
      .toBe("data:image/png;base64,AQID");
    expect(reads).toBe(1);
    view.unmount();
  });
});
