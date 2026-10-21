import { useCallback, useEffect, useState } from "react";
import type { RelayApiClient } from "../api/relayClient";
import type { RelayChatImageInput } from "../api/dtos/information";
import { describeLiveError } from "./liveErrors";

/**
 * 图片输入的**提前说明**（工作台 §33.2，2026-10-19；2026-10-20 接原地声明）。
 *
 * 服务端在发送时按同一份判定拒绝图片（`application/chat-image-input.ts`），但那时
 * 图片已经上传过一次、用户也已经点了发送。这里把同一个结论提前到「刚把图粘进来」：
 * 只要不是明确支持，就在芯片行里说明这条消息会被拒，以及该改什么。
 *
 * 四条纪律：
 * - 只说明、不拦发送。服务端闸门才是准绳；客户端不造第二套裁决，也不禁用发送键
 *   （禁用会让「只想发这段文字」也被卡住）。
 * - 读不到就沉默（`null`）：不拿「未知」当「不支持」吓人，也不当「支持」骗人。
 * - 同一份 client 只读一次：首条消息与已有会话是两个组件，共用这一份缓存。
 * - **只在「目录里没有这个模型」时**给原地声明入口（2026-10-20，P1-5）：那时声明就是
 *   设计里的第三层，写下去立即生效；目录明确说不支持时声明不生效，给了按钮等于骗人。
 */
const cache = new WeakMap<RelayApiClient, {
  readonly state: RelayChatImageInput;
  readonly model: string | null;
  readonly provider: string;
}>();

function noticeFor(state: RelayChatImageInput, model: string | null): string | null {
  const which = model === null || model === "" ? "当前聊天模型" : `当前聊天模型（${model}）`;
  switch (state) {
    case "MODEL_LACKS_IMAGE_INPUT":
      return `${which}不支持图片输入，这条消息会被服务端拒绝：请移除图片，或改用支持图片的模型。`;
    case "MODEL_NOT_IN_CATALOG":
      // 2026-10-20：不再把用户推去改服务端环境变量。目录没有这个模型时，能力声明就是
      // 设计里的第三层，可以在下方直接写；目录里有条目时以目录为准（所以这里只说这一档）。
      return `模型目录里没有${model === null ? "当前聊天模型" : `「${model}」`}，无法确认它能否读图：`
        + "这条消息会被拒绝。可以在下方为它声明图片能力（立即生效），或改用目录里的模型。";
    case "NOT_CONFIGURED":
      return "当前实例没有配置真实模型端口，图片消息不会被接受：请先在连接设置里配置模型。";
    default:
      // SUPPORTED / DECLARED 不必说；UNKNOWN 是读不到，也不猜。
      return null;
  }
}

export interface ChatImageInputNotice {
  readonly notice: string | null;
  readonly state: RelayChatImageInput | null;
  readonly model: string | null;
  /** 只有「目录里没有这个模型」才为真：此时声明是唯一能让带图消息通过的入口。 */
  readonly canDeclare: boolean;
  readonly declaring: boolean;
  readonly declareError: string | null;
  /** 写入一次声明并重新读取同一份判定；失败只报原因，不改发送行为。 */
  readonly declare: (imageInput: boolean) => Promise<void>;
}

/** 返回「这条带图消息会被拒」的说明；可以发、无法判断或还没连上服务时为 null。 */
export function useChatImageInputNotice(client: RelayApiClient | null): ChatImageInputNotice {
  const [known, setKnown] = useState<{ readonly state: RelayChatImageInput;
    readonly model: string | null; readonly provider: string } | null>(() =>
    client === null ? null : cache.get(client) ?? null);
  const [declaring, setDeclaring] = useState(false);
  const [declareError, setDeclareError] = useState<string | null>(null);

  useEffect(() => {
    if (client === null) { setKnown(null); return; }
    const cached = cache.get(client);
    if (cached !== undefined) { setKnown(cached); return; }
    let active = true;
    void client.getModelPortStatus().then((status) => {
      const entry = { state: status.imageInput, model: status.model, provider: status.provider };
      cache.set(client, entry);
      if (active) setKnown(entry);
    }).catch(() => { if (active) setKnown(null); });
    return () => { active = false; };
  }, [client]);

  const declare = useCallback(async (imageInput: boolean): Promise<void> => {
    if (client === null || known === null || known.model === null) return;
    setDeclaring(true); setDeclareError(null);
    try {
      await client.putModelCapability({ provider: known.provider, model: known.model,
        imageInput, note: null });
      // 写完必须重新读判定：界面不能把自己刚写的声明当成已生效的事实。
      const status = await client.getModelPortStatus();
      const entry = { state: status.imageInput, model: status.model, provider: status.provider };
      cache.set(client, entry);
      setKnown(entry);
    } catch (caught) {
      setDeclareError(describeLiveError(caught).message);
    } finally {
      setDeclaring(false);
    }
  }, [client, known]);

  return {
    notice: known === null ? null : noticeFor(known.state, known.model),
    state: known?.state ?? null,
    model: known?.model ?? null,
    canDeclare: known?.state === "MODEL_NOT_IN_CATALOG" && known.model !== null &&
      known.provider === "openai-compatible",
    declaring,
    declareError,
    declare,
  };
}
