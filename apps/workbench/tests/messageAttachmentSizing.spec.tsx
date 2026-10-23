import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import MessageAttachments from "../src/components/MessageAttachments";
import { RelayApiClient } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/**
 * 禅道 #154：占位符换成 `<img>` 之前先解码拿固有宽高，插入时就带 width/height，
 * 图片加载期间不再从 32px 占位撑到 192px 推挤后面的消息（CLS）。
 */
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

it("历史图片插入时自带固有宽高，占位符不再撑开消息列表", async () => {
  // jsdom 不加载图片：用假 Image 触发 load，并把固有宽高固定成 600×400。
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 600;
    naturalHeight = 400;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal("Image", FakeImage);

  const sessionId = "55555555-5555-4555-8555-555555555555";
  const attachmentId = "66666666-6666-4666-8666-666666666666";
  vi.stubGlobal("fetch", vi.fn(async () => json({
    attachment_id: attachmentId, name: "shot.png", media_type: "image/png",
    byte_length: 3, data_base64: "QUFB",
  })));

  const client = new RelayApiClient({
    baseUrl: "http://127.0.0.1:8787",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    bearerToken: "test",
  });
  const mounted = await mountReact(createElement(MemoryRouter, null, createElement(MessageAttachments, {
    client,
    sessionId,
    attachments: [{ id: attachmentId, name: "shot.png", mediaType: "image/png", byteLength: 3 }],
  })));
  unmount = mounted.unmount;
  await flush();

  const image = mounted.wrapper.get(".message-attachment-image");
  expect(image.attributes("width")).toBe("600");
  expect(image.attributes("height")).toBe("400");
  expect(mounted.wrapper.find(".message-attachment-placeholder").exists()).toBe(false);
});
