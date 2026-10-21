import { useCallback, useEffect, useState, type MouseEvent, type FocusEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import "./AttachmentPreview.css";

/**
 * 图片的悬停预览（工作台 §33.2 / §33.3）。
 *
 * 两处消费者共用这一份实现：输入框里待发送的芯片（缩略图只有 compact 控件那么高），
 * 以及历史消息里的附件（被 20rem×12rem 压住的高截图）。两边要的是同一个行为——
 * 「悬停/聚焦时把原图浮出来看」——所以几何、收回条件与浮层外观都只写一遍。
 *
 * 浮层走 portal 挂到 `document.body`、`position: fixed`：输入卡在发送中
 * `overflow: hidden`，对话列本身也是滚动容器，留在锚点子树里会被裁掉。
 */

/** 浮层与视口边缘、与锚点之间的留白。 */
const PREVIEW_MARGIN = 8;
/** 预览上限：再大就会盖住正在读的内容，也读不完。 */
const PREVIEW_MAX_WIDTH = 480;
const PREVIEW_MAX_HEIGHT = 520;

/**
 * 一次预览的几何快照。
 *
 * 存快照而不是存元素引用：锚点可能在预览期间被移除（上传完成、发送成功、切换会话），
 * 浮层不该因为找不到锚点而抛错，也不该跟着已经变形的锚点漂移。
 */
export interface AttachmentPreviewState {
  readonly key: string;
  readonly url: string;
  readonly name: string;
  readonly left: number;
  readonly top: number;
  readonly above: boolean;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

/** 贴着锚点上方浮出；上方放不下就翻到下方；水平方向夹在视口内。 */
function geometry(key: string, url: string, name: string, rect: DOMRect,
  intrinsic: { width: number; height: number } | null): AttachmentPreviewState {
  const maxWidth = Math.max(160,
    Math.min(PREVIEW_MAX_WIDTH, window.innerWidth - PREVIEW_MARGIN * 2 - 12));
  const capHeight = Math.max(120,
    Math.min(PREVIEW_MAX_HEIGHT, Math.round(window.innerHeight * 0.6)));
  // 翻不翻面要看这张图**实际**会占多高，不是上限：320×200 的截图在任何位置都放得下，
  // 按 520px 的上限判断会把它无谓地翻到下方，盖住后面的消息。
  const fitHeight = (cap: number): number => intrinsic === null
    ? cap
    : Math.max(1, Math.round(intrinsic.height *
      Math.min(maxWidth / intrinsic.width, cap / intrinsic.height, 1)));
  const roomAbove = rect.top - PREVIEW_MARGIN * 2;
  const roomBelow = window.innerHeight - rect.bottom - PREVIEW_MARGIN * 2;
  const natural = fitHeight(capHeight);
  // 两侧都放不下时选空间大的一侧，并把高度收到那一侧的实际余量——
  // 竖屏长截图（1000×3000）只有这样才不会越出视口。
  const above = roomAbove >= natural ? true : roomBelow >= natural ? false : roomAbove > roomBelow;
  const maxHeight = Math.max(120, Math.min(capHeight, above ? roomAbove : roomBelow));
  return {
    key, url, name,
    left: Math.max(PREVIEW_MARGIN,
      Math.min(rect.left, window.innerWidth - maxWidth - PREVIEW_MARGIN - 12)),
    top: above ? rect.top - PREVIEW_MARGIN : rect.bottom + PREVIEW_MARGIN,
    above, maxWidth, maxHeight,
  };
}

/** 锚点里那张图的原生尺寸；还没解码出来时返回 null（退化成按上限判断）。 */
function intrinsicSizeOf(anchor: HTMLElement): { width: number; height: number } | null {
  const image = anchor.querySelector("img");
  if (image === null || image.naturalWidth <= 0 || image.naturalHeight <= 0) return null;
  return { width: image.naturalWidth, height: image.naturalHeight };
}

export interface AttachmentPreviewController {
  readonly preview: AttachmentPreviewState | null;
  /** `url` 为空（没有可读的图）时不浮空框。 */
  show: (key: string, url: string, name: string, anchor: HTMLElement) => void;
  hide: () => void;
}

/** 预览状态与收回时机。滚动、改窗宽即收回：浮层是贴着锚点的，锚点动了它就错位了。 */
export function useAttachmentPreview(): AttachmentPreviewController {
  const [preview, setPreview] = useState<AttachmentPreviewState | null>(null);
  const open = preview !== null;

  const hide = useCallback(() => setPreview(null), []);
  const show = useCallback((key: string, url: string, name: string, anchor: HTMLElement) => {
    if (url === "") return;
    const next = geometry(key, url, name, anchor.getBoundingClientRect(), intrinsicSizeOf(anchor));
    // 在锚点内部移动会连续触发 mouseover：同一张图、同一位置就不必重渲染。
    setPreview((current) => current !== null && current.key === next.key &&
      current.left === next.left && current.top === next.top ? current : next);
  }, []);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  return { preview, show, hide };
}

/**
 * 锚点上的一组事件处理器：指针进出、键盘聚焦、Esc。
 *
 * 「内部移动不算离开」由 `relatedTarget` 判断——缩略图 → 名称 → 移除键之间穿行时
 * 不收回，否则浮层会一路闪。
 */
export function attachmentPreviewHandlers(key: string, url: string, name: string,
  controller: AttachmentPreviewController): {
    onMouseOver: (event: MouseEvent<HTMLElement>) => void;
    onMouseOut: (event: MouseEvent<HTMLElement>) => void;
    onFocusCapture: (event: FocusEvent<HTMLElement>) => void;
    onBlurCapture: (event: FocusEvent<HTMLElement>) => void;
    onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => void;
  } {
  const staysInside = (current: HTMLElement, next: EventTarget | null): boolean =>
    next instanceof Node && current.contains(next);
  return {
    onMouseOver: (event) => controller.show(key, url, name, event.currentTarget),
    onMouseOut: (event) => {
      if (staysInside(event.currentTarget, event.relatedTarget)) return;
      controller.hide();
    },
    onFocusCapture: (event) => controller.show(key, url, name, event.currentTarget),
    onBlurCapture: (event) => {
      if (staysInside(event.currentTarget, event.relatedTarget)) return;
      controller.hide();
    },
    onKeyDownCapture: (event) => { if (event.key === "Escape") controller.hide(); },
  };
}

/**
 * 浮层本体。`aria-hidden`：名称在锚点里已经读得到，这里只是把同一张图放大，不重复播报。
 */
export function AttachmentPreviewLayer({ preview }: { readonly preview: AttachmentPreviewState | null }) {
  if (preview === null) return null;
  return createPortal(
    <div className="attachment-preview" data-testid="attachment-preview" data-key={preview.key}
      aria-hidden="true"
      style={{ left: preview.left, top: preview.top,
        transform: preview.above ? "translateY(-100%)" : undefined }}>
      <img className="attachment-preview-image" src={preview.url} alt=""
        style={{ maxWidth: preview.maxWidth, maxHeight: preview.maxHeight }} />
    </div>,
    document.body);
}
