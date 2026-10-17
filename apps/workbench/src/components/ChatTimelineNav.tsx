import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ListTree } from "lucide-react";
import type { RelayAssistMessage } from "../api/relayClient";
import { resolveMotionPreference } from "../lib/motionPreference";
import { resolvedTokenValue } from "../lib/tokens";
import "./ChatTimelineNav.css";

/**
 * 聊天消息时间线导航（工作台 §31）。
 *
 * 只读消费消息列表与消息流滚动容器：不发送命令、不调用模型、不另存一份消息正文。
 * 节点身份 = 当前会话 ID + 确切消息 ID，摘要文字与序号只用于呈现。
 */

// 首版实施默认（工作台 §31.1 待确认项）：标题取提问开头，正文取该轮助手回复已有片段。
// 这两个数字是内容截断长度，不是视觉尺度，因此不进 design-tokens.json。
const TITLE_LIMIT = 48;
const REPLY_LIMIT = 160;

/** 设计 token 的 rem 值 → px；根字号按 16px（与既有读区呼吸位、联动尺度同源换算）。 */
function tokenPx(name: string): number {
  return Number.parseFloat(resolvedTokenValue(name)) * 16;
}

/** 跳转后目标开头与可读区上沿之间的呼吸位；取 space.2，与滚动容器内边距同源。 */
const READ_INSET_PX = tokenPx("space.2");
/** 落点强调时长；减少动态效果时由 CSS 去掉过渡，时长不变。 */
const EMPHASIS_MS = Number.parseFloat(resolvedTokenValue("motion.duration.emphasis")) * 1000;

/* 悬停联动（工作台 §31 / 设计系统 §9.12）：轨道内移动指针时，刻度长度按
   「指针到刻度中心的距离」连续变化。尺度仍是既有 token 的组合，不另立一套数值：
   基准 = space.2（刻度默认长），峰值 = control.target.minimum − space.1（轨道内留呼吸位），
   衰减半径 = 3 × control.target.minimum（约上下各两条）；当前阅读位置那档 space.4 由 CSS 承担。 */
const TICK_BASE_PX = tokenPx("space.2");
const TICK_PEAK_PX = tokenPx("control.target.minimum") - tokenPx("space.1");
const TICK_CURRENT_PX = tokenPx("space.4");
const TICK_FALLOFF_RADIUS_PX = tokenPx("control.target.minimum") * 3;

/**
 * 指针与刻度中心的距离 → 该刻度此刻的长度（px）。
 * 峰值在指针处，向外按二次曲线衰减，到衰减半径回到基准长。
 * 联动只加长：调用方与刻度默认档取较大值，当前位置刻度不会被压得比默认态还短。
 */
export function chatTimelineTickWidth(distancePx: number): number {
  if (!Number.isFinite(distancePx) || distancePx >= TICK_FALLOFF_RADIUS_PX) return TICK_BASE_PX;
  if (distancePx <= 0) return TICK_PEAK_PX;
  const decay = 1 - distancePx / TICK_FALLOFF_RADIUS_PX;
  return TICK_BASE_PX + (TICK_PEAK_PX - TICK_BASE_PX) * decay * decay;
}

export type ChatTimelineNode = {
  readonly messageId: string;
  /** 仅用于可读名称里的序号；定位一律按 messageId，重排或读取失败时也不作为目标身份。 */
  readonly ordinal: number;
  readonly title: string;
  readonly titleTruncated: boolean;
  readonly reply: string | null;
  readonly replyTruncated: boolean;
};

function readableFragment(content: string | null): string | null {
  if (content === null) return null;
  const text = content.replace(/\s+/gu, " ").trim();
  return text === "" ? null : text;
}

/** 每条已加载且正文可读的用户消息一个节点；正文缺失时不伪造节点。 */
export function chatTimelineNodes(messages: readonly RelayAssistMessage[]): readonly ChatTimelineNode[] {
  const nodes: ChatTimelineNode[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "USER") return;
    const text = readableFragment(message.content);
    if (text === null) return;
    let reply: string | null = null;
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const next = messages[cursor];
      if (next.role === "USER") break;
      const candidate = readableFragment(next.content);
      if (candidate !== null) { reply = candidate; break; }
    }
    const title = text.slice(0, TITLE_LIMIT);
    const replyText = reply === null ? null : reply.slice(0, REPLY_LIMIT);
    nodes.push({ messageId: message.id, ordinal: nodes.length + 1, title,
      titleTruncated: text.length > title.length,
      reply: replyText, replyTruncated: reply !== null && replyText !== null && reply.length > replyText.length });
  });
  return nodes;
}

/** 三重身份核对：只认当前会话渲染出来的那条消息槽，避免迟到结果落到新会话。 */
function findSlot(owner: HTMLElement, sessionId: string, messageId: string): HTMLElement | null {
  const session = CSS.escape(sessionId);
  const target = CSS.escape(messageId);
  return owner.querySelector<HTMLElement>(
    `[data-chat-timeline-slot][data-timeline-session="${session}"][data-message-id="${target}"]`);
}

function motionAllowed(): boolean {
  // 减少动态效果偏好只影响跳转是否平滑，不影响落点、刻度与预览的正确性。
  return resolveMotionPreference();
}

export default function ChatTimelineNav({ sessionId, messages, getScrollOwner }: {
  sessionId: string;
  messages: readonly RelayAssistMessage[];
  getScrollOwner: () => HTMLElement | null }) {
  const nodes = useMemo(() => chatTimelineNodes(messages), [messages]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const railId = useId();
  const previewIdAttr = `${railId}-preview`;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const emphasis = useRef<number | null>(null);
  const flashed = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  /** 悬停联动：待执行的那一帧与最近一次指针高度（client 坐标；轨道自己滚动时重算用）。 */
  const tickFrame = useRef(0);
  const tickPointerY = useRef<number | null>(null);
  const clearEmphasis = useCallback(() => {
    if (emphasis.current !== null) window.clearTimeout(emphasis.current);
    emphasis.current = null;
    flashed.current?.removeAttribute("data-chat-timeline-target");
    flashed.current = null;
  }, []);
  /** 清掉联动写入的刻度长度：指针离开轨道、切换会话或卸载时都走这里。 */
  const clearTickWidths = useCallback(() => {
    if (tickFrame.current !== 0) {
      window.cancelAnimationFrame(tickFrame.current);
      tickFrame.current = 0;
    }
    tickPointerY.current = null;
    const rail = railRef.current;
    if (rail === null) return;
    rail.removeAttribute("data-tracking");
    for (const node of rail.querySelectorAll<HTMLElement>(".agent-chat-timeline-node")) {
      node.style.removeProperty("--chat-timeline-tick-width");
    }
  }, []);
  /** 一帧内按当前指针高度重算所有刻度长度；写内联变量，不参与 React 重渲染。 */
  const applyTickFalloff = useCallback(() => {
    tickFrame.current = 0;
    const rail = railRef.current;
    const pointerY = tickPointerY.current;
    if (rail === null || pointerY === null) return;
    rail.setAttribute("data-tracking", "true");
    for (const node of rail.querySelectorAll<HTMLElement>(".agent-chat-timeline-node")) {
      const box = node.getBoundingClientRect();
      const distance = Math.abs(pointerY - (box.top + box.height / 2));
      const rest = node.getAttribute("aria-current") === "true" ? TICK_CURRENT_PX : TICK_BASE_PX;
      const width = Math.max(rest, chatTimelineTickWidth(distance));
      node.style.setProperty("--chat-timeline-tick-width", `${Math.round(width * 100) / 100}px`);
    }
  }, []);
  const scheduleTickFalloff = useCallback((pointerY: number) => {
    tickPointerY.current = pointerY;
    if (tickFrame.current !== 0) return;
    tickFrame.current = window.requestAnimationFrame(applyTickFalloff);
  }, [applyTickFalloff]);
  useEffect(() => () => {
    mounted.current = false;
    clearEmphasis();
    clearTickWidths();
  }, [clearEmphasis, clearTickWidths]);

  /** 随实际阅读位置更新当前刻度：以可读区上沿最近的一条为准，不看最后点了谁。 */
  const syncActive = useCallback((owner: HTMLElement) => {
    if (nodes.length === 0) return;
    const viewportTop = owner.getBoundingClientRect().top;
    let current = nodes[0]!.messageId;
    for (const node of nodes) {
      const slot = findSlot(owner, sessionId, node.messageId);
      if (slot === null) continue;
      if (slot.getBoundingClientRect().top - viewportTop > READ_INSET_PX + 1) break;
      current = node.messageId;
    }
    // 已经贴底时最后一条就是当前位置，哪怕它的开头还没越过上沿（短会话、末尾长回复）。
    if (owner.scrollHeight - owner.scrollTop - owner.clientHeight <= 1) current = nodes[nodes.length - 1]!.messageId;
    setActiveId((previous) => previous === current ? previous : current);
  }, [nodes, sessionId]);

  useEffect(() => {
    const owner = getScrollOwner();
    if (owner === null) return;
    let frame = 0;
    const onScroll = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (mounted.current) syncActive(owner);
      });
    };
    owner.addEventListener("scroll", onScroll, { passive: true });
    // 流式增长、图片或代码块撑高同样要重新核对当前刻度，但不能反过来推动正文滚动。
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => onScroll());
    syncActive(owner);
    observer?.observe(owner);
    return () => {
      owner.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [getScrollOwner, nodes, sessionId, syncActive]);

  // 切换会话：整套节点会更换，联动的长度与跟踪状态不留在新会话的轨道上。
  useEffect(() => { clearTickWidths(); }, [sessionId, clearTickWidths]);

  // 浮层贴着刻度展开，再按可视高度把越界的一边拉回来；jsdom 无布局时落在 0，不影响行为断言。
  useLayoutEffect(() => {
    const preview = previewRef.current;
    const wrapper = wrapperRef.current;
    const anchor = anchorRef.current;
    if (previewId === null || preview === null || wrapper === null || anchor === null) return;
    const top = anchor.getBoundingClientRect().top - wrapper.getBoundingClientRect().top;
    const lowest = Math.max(0, wrapper.clientHeight - preview.offsetHeight);
    preview.style.top = `${Math.round(Math.max(0, Math.min(top, lowest)))}px`;
  }, [previewId, nodes]);

  const jump = (messageId: string) => {
    setNotice(null);
    const owner = getScrollOwner();
    if (owner === null) { setNotice("消息流还没准备好，位置保持不变。"); return; }
    const slot = findSlot(owner, sessionId, messageId);
    if (slot === null) { setNotice("这条消息不在已加载的消息流里，位置保持不变。"); return; }
    const top = slot.getBoundingClientRect().top - owner.getBoundingClientRect().top + owner.scrollTop;
    const target = Math.max(0, Math.round(top - READ_INSET_PX));
    // 只滚动当前消息流：滚动容器自己就是消息流 Owner，不碰页面滚动。
    if (motionAllowed()) owner.style.scrollBehavior = "smooth";
    owner.scrollTop = target;
    if (motionAllowed()) owner.style.scrollBehavior = "";
    // 位置确实变了才有 scroll 事件；这里再按实测位置核对一次，避免偏移恰好没变时刻度停在旧位置。
    syncActive(owner);
    setExpanded(false);
    // 跳转后指针还停在刻度上：不关掉浮层，预览就一直压着刚定位到的那段正文。
    setPreviewId(null);
    clearEmphasis();
    slot.setAttribute("data-chat-timeline-target", "true");
    flashed.current = slot;
    emphasis.current = window.setTimeout(() => {
      emphasis.current = null;
      if (flashed.current !== slot) return;
      slot.removeAttribute("data-chat-timeline-target");
      flashed.current = null;
    }, EMPHASIS_MS);
  };

  const showPreview = (node: ChatTimelineNode, anchor: HTMLElement) => {
    anchorRef.current = anchor;
    setPreviewId(node.messageId);
  };

  function onRailKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    if (previewId === null && !expanded) return;
    // 预览打开时这一次 Esc 归浮层，不能再被面板的 Esc Esc 停止序列记成第一下。
    event.preventDefault();
    event.stopPropagation();
    setPreviewId(null);
    setExpanded(false);
  }

  if (nodes.length === 0) return null;
  const preview = nodes.find((node) => node.messageId === previewId) ?? null;

  return <div className="agent-chat-timeline" ref={wrapperRef} data-testid="chat-timeline"
    onKeyDown={onRailKeyDown}>
    <button className="agent-chat-timeline-toggle" type="button" data-testid="chat-timeline-toggle"
      aria-expanded={expanded} aria-controls={railId} aria-label="消息时间线导航" title="消息时间线导航"
      onClick={() => setExpanded((value) => !value)}><ListTree aria-hidden="true" /></button>
    <nav id={railId} className="agent-chat-timeline-rail" aria-label="消息时间线" ref={railRef}
      data-expanded={expanded ? "true" : undefined} data-testid="chat-timeline-rail"
      onPointerMove={(event) => {
        // 触屏点按没有悬停语义，不写长度，避免抬起后残留一帧波形；鼠标与笔按指针高度实时联动。
        if (event.pointerType === "touch") return;
        scheduleTickFalloff(event.clientY);
      }}
      onPointerLeave={() => { setPreviewId(null); clearTickWidths(); }}
      onScroll={() => {
        // 轨道自身滚动时按最近一次指针高度重算，刻度移到指针下不会停在旧长度。
        const pointerY = tickPointerY.current;
        if (pointerY !== null) scheduleTickFalloff(pointerY);
      }}>
      {nodes.map((node) => <button key={node.messageId} type="button"
        className="agent-chat-timeline-node" data-testid={`chat-timeline-node-${node.messageId}`}
        aria-label={`第 ${node.ordinal} 条提问：${node.title}${node.titleTruncated ? "（开头已截断）" : ""}`}
        aria-current={activeId === node.messageId ? "true" : undefined}
        aria-describedby={previewId === node.messageId ? previewIdAttr : undefined}
        onPointerEnter={(event) => showPreview(node, event.currentTarget)}
        onFocus={(event) => showPreview(node, event.currentTarget)}
        onBlur={() => setPreviewId((current) => current === node.messageId ? null : current)}
        onClick={() => jump(node.messageId)} />)}
    </nav>
    {preview !== null && <div ref={previewRef} id={previewIdAttr} role="tooltip"
      className="agent-chat-timeline-preview" data-testid="chat-timeline-preview">
      <p className="agent-chat-timeline-preview-title"
        data-testid="chat-timeline-preview-title">{preview.title}{preview.titleTruncated ? "…" : ""}</p>
      {preview.reply !== null && <p className="agent-chat-timeline-preview-body"
        data-testid="chat-timeline-preview-body">{preview.reply}{preview.replyTruncated ? "…" : ""}</p>}
      {(preview.titleTruncated || preview.replyTruncated) &&
        <p className="agent-chat-timeline-preview-note">原文片段已截断</p>}
    </div>}
    {notice !== null && <p className="agent-chat-timeline-notice" role="alert"
      data-testid="chat-timeline-notice">{notice}</p>}
  </div>;
}
