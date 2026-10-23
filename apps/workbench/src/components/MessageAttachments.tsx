import { useEffect, useState } from "react";
import type { RelayApiClient, RelayAssistMessageAttachment } from "../api/relayClient";
import { formatAttachmentBytes } from "./composerAttachments";
import {
  AttachmentPreviewLayer, attachmentPreviewHandlers, useAttachmentPreview,
} from "./attachmentPreview";
import "./MessageAttachments.css";

/**
 * 历史消息里的图片附件（工作台 §33.3）。
 *
 * 内容单独读取：消息列表只带元数据（id/名字/类型/字节数），图片本体按条拉取并缓存在本
 * 进程内——同一张图在重读会话后不再请求第二遍。读取失败不冒充「没有图片」：失败态
 * 就地写明并提供重试，图仍然在那条消息里。
 *
 * 图片是**会话输入快照**，不是资料也不是产物：这里只展示"我当时发了什么"，
 * 不假装模型回放了历史图片（回放规则在服务端组装里，见 HTTP §10.85）。
 *
 * 悬停预览（2026-10-19，与输入框芯片同一份 `attachmentPreview`）：气泡里的图被
 * `20rem × 12rem` 压着，竖屏截图读不出内容，悬停/聚焦时浮出原图。
 *
 * 尺寸预留（2026-10-23，禅道 #154）：占位符换成 `<img>` 之前先解码拿固有宽高，插入时就带
 * `width`/`height`，加载期间不再从 32px 占位撑到 192px 推挤后面的消息。解码失败或宿主
 * 不回调（测试环境不加载图片）时最多等 200ms 就先铺图，退回无尺寸渲染，不让图片卡在占位符。
 */
interface CachedAttachmentImage {
  readonly url: string;
  readonly width: number | null;
  readonly height: number | null;
}

const dataUrlCache = new Map<string, CachedAttachmentImage>();

function probeAttachmentImage(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (size: { width: number; height: number } | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(size);
    };
    const timer = window.setTimeout(() => finish(null), 200);
    if (typeof Image === "undefined") {
      finish(null);
      return;
    }
    const probe = new Image();
    probe.onload = () => finish(probe.naturalWidth > 0 && probe.naturalHeight > 0
      ? { width: probe.naturalWidth, height: probe.naturalHeight }
      : null);
    probe.onerror = () => finish(null);
    probe.src = url;
  });
}

export default function MessageAttachments({ client, sessionId, attachments }: {
  readonly client: RelayApiClient;
  readonly sessionId: string;
  readonly attachments: readonly RelayAssistMessageAttachment[];
}) {
  const [loaded, setLoaded] = useState<Readonly<Record<string, CachedAttachmentImage>>>({});
  const [failed, setFailed] = useState<Readonly<Record<string, boolean>>>({});
  const [retry, setRetry] = useState(0);
  const { preview, show, hide } = useAttachmentPreview();
  useEffect(() => {
    let live = true;
    for (const item of attachments) {
      const key = `${sessionId}:${item.id}`;
      if (dataUrlCache.has(key)) continue;
      void client.getAssistMessageAttachment({ sessionId, attachmentId: item.id })
        .then(async (content) => {
          const url = `data:${content.mediaType};base64,${content.dataBase64}`;
          const size = await probeAttachmentImage(url);
          const entry: CachedAttachmentImage = { url, width: size?.width ?? null, height: size?.height ?? null };
          dataUrlCache.set(key, entry);
          if (live) setLoaded((current) => ({ ...current, [item.id]: entry }));
        })
        .catch(() => {
          if (live) setFailed((current) => ({ ...current, [item.id]: true }));
        });
    }
    return () => { live = false; };
  }, [client, sessionId, attachments, retry]);
  if (attachments.length === 0) return null;
  return <div className="message-attachments" data-testid="assist-message-attachments"
    data-count={attachments.length}>
    {attachments.map((item) => {
      const cached = loaded[item.id] ?? dataUrlCache.get(`${sessionId}:${item.id}`);
      const missing = cached === undefined;
      const broken = missing && failed[item.id] === true;
      return <figure key={item.id} className="message-attachment"
        data-previewable={!missing}
        // 图还没读到（或读失败）时不挂预览：没有内容可放大，浮空框只会挡住重试入口。
        {...(missing ? {} : attachmentPreviewHandlers(item.id, cached.url, item.name, { preview, show, hide }))}>
        {missing
          ? <span className="message-attachment-placeholder" role="status">
            {broken ? "图片读取失败" : "正在读取图片…"}</span>
          : <img className="message-attachment-image" src={cached.url} alt={item.name}
            {...(cached.width === null || cached.height === null
              ? {} : { width: cached.width, height: cached.height })} />}
        <figcaption>{item.name} · {formatAttachmentBytes(item.byteLength)}</figcaption>
        {broken && <button className="text-link" type="button"
          onClick={() => {
            setFailed((current) => { const copy = { ...current }; delete copy[item.id]; return copy; });
            setRetry((value) => value + 1);
          }}>重新读取</button>}
      </figure>;
    })}
    <AttachmentPreviewLayer preview={preview} />
  </div>;
}

