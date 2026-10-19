import { useEffect, useState } from "react";
import type { RelayApiClient, RelayAssistMessageAttachment } from "../api/relayClient";
import { formatAttachmentBytes } from "./composerAttachments";
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
 */
const dataUrlCache = new Map<string, string>();

export default function MessageAttachments({ client, sessionId, attachments }: {
  readonly client: RelayApiClient;
  readonly sessionId: string;
  readonly attachments: readonly RelayAssistMessageAttachment[];
}) {
  const [loaded, setLoaded] = useState<Readonly<Record<string, string>>>({});
  const [failed, setFailed] = useState<Readonly<Record<string, boolean>>>({});
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    for (const item of attachments) {
      const key = `${sessionId}:${item.id}`;
      if (dataUrlCache.has(key)) continue;
      void client.getAssistMessageAttachment({ sessionId, attachmentId: item.id })
        .then((content) => {
          const url = `data:${content.mediaType};base64,${content.dataBase64}`;
          dataUrlCache.set(key, url);
          if (live) setLoaded((current) => ({ ...current, [item.id]: url }));
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
      const source = loaded[item.id] ?? dataUrlCache.get(`${sessionId}:${item.id}`);
      const missing = source === undefined;
      const broken = missing && failed[item.id] === true;
      return <figure key={item.id} className="message-attachment">
        {missing
          ? <span className="message-attachment-placeholder" role="status">
            {broken ? "图片读取失败" : "正在读取图片…"}</span>
          : <img className="message-attachment-image" src={source} alt={item.name} />}
        <figcaption>{item.name} · {formatAttachmentBytes(item.byteLength)}</figcaption>
        {broken && <button className="text-link" type="button"
          onClick={() => {
            setFailed((current) => { const copy = { ...current }; delete copy[item.id]; return copy; });
            setRetry((value) => value + 1);
          }}>重新读取</button>}
      </figure>;
    })}
  </div>;
}
