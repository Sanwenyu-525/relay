import { useCallback, useEffect, useState, type MouseEvent, type FocusEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { X, ZoomIn } from "lucide-react";
import "./AttachmentPreview.css";

/**
 * 图片的悬停预览与原图查看层（工作台 §33.2 / §33.3）。
 *
 * 两处消费者共用这一份实现：输入框里待发送的芯片（缩略图只有 compact 控件那么高），
 * 以及历史消息里的附件（被 20rem×12rem 压住的高截图）。两边要的是同一个行为——
 * 「悬停/聚焦时把原图浮出来看，点击把原图放进整层细看」——所以几何、收回条件、
 * 浮层与查看层的外观都只写一遍。
 *
 * 浮层走 portal 挂到 `document.body`、`position: fixed`：输入卡在发送中
 * `overflow: hidden`，对话列本身也是滚动容器，留在锚点子树里会被裁掉。
 * 查看层（2026-10-24 用户确认方案 1）同样是 body 上的整层模态；方案 2 把浮层上限
 * 从固定 480×520 加大到视口六成——固定上限把整窗截图压到读不清，再大就该进查看层。
 */

/** 浮层与视口边缘、与锚点之间的留白。 */
const PREVIEW_MARGIN = 8;
/** 预览占视口的比例：宽高各取六成。小图仍不放大（放大只会糊），大图不再压到 480px。 */
const PREVIEW_VIEWPORT_RATIO = 0.6;

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
  const maxWidth = Math.max(160, Math.min(
    window.innerWidth * PREVIEW_VIEWPORT_RATIO, window.innerWidth - PREVIEW_MARGIN * 2 - 12));
  const capHeight = Math.max(120, Math.round(window.innerHeight * PREVIEW_VIEWPORT_RATIO));
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

/** 原图查看层里的一张图：内容快照，锚点此后消失也不影响已打开的这一层。 */
export interface AttachmentViewerItem {
  readonly key: string;
  readonly url: string;
  readonly name: string;
}

export interface AttachmentPreviewController {
  readonly preview: AttachmentPreviewState | null;
  /** `url` 为空（没有可读的图）时不浮空框。 */
  show: (key: string, url: string, name: string, anchor: HTMLElement) => void;
  hide: () => void;
  /** 点击锚点打开的原图查看层（2026-10-24 用户确认方案 1）；同一时刻至多一层。 */
  readonly viewer: AttachmentViewerItem | null;
  openViewer: (key: string, url: string, name: string) => void;
  closeViewer: () => void;
}

/** 预览与查看层的状态、打开与收回时机。浮层贴着锚点：滚动、改窗宽即收回。 */
export function useAttachmentPreview(): AttachmentPreviewController {
  const [preview, setPreview] = useState<AttachmentPreviewState | null>(null);
  const [viewer, setViewer] = useState<AttachmentViewerItem | null>(null);
  const open = preview !== null;
  const viewing = viewer !== null;

  const hide = useCallback(() => setPreview(null), []);
  const show = useCallback((key: string, url: string, name: string, anchor: HTMLElement) => {
    if (url === "") return;
    const next = geometry(key, url, name, anchor.getBoundingClientRect(), intrinsicSizeOf(anchor));
    // 在锚点内部移动会连续触发 mouseover：同一张图、同一位置就不必重渲染。
    setPreview((current) => current !== null && current.key === next.key &&
      current.left === next.left && current.top === next.top ? current : next);
  }, []);
  const openViewer = useCallback((key: string, url: string, name: string) => {
    if (url === "") return;
    // 打开查看层就收回浮层：同一张图不需要两层同时在场。
    setPreview(null);
    setViewer({ key, url, name });
  }, []);
  const closeViewer = useCallback(() => setViewer(null), []);

  // Esc 关闭查看层；背景不滚动——查看层是模态的，底下的会话列不该跟着滚。
  useEffect(() => {
    if (!viewing) return;
    const onKeyDown = (event: WindowEventMap["keydown"]): void => {
      if (event.key === "Escape") setViewer(null);
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [viewing]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  return { preview, show, hide, viewer, openViewer, closeViewer };
}

/**
 * 锚点上的一组事件处理器：指针进出、键盘聚焦、Esc、点击/回车打开原图查看层。
 *
 * 「内部移动不算离开」由 `relatedTarget` 判断——缩略图 → 名称 → 移除键之间穿行时
 * 不收回，否则浮层会一路闪。锚点内的按钮（移除、重新读取）自己 `stopPropagation`：
 * 点击它们是动作，不是「想看原图」。
 */
export function attachmentPreviewHandlers(key: string, url: string, name: string,
  controller: AttachmentPreviewController): {
    onMouseOver: (event: MouseEvent<HTMLElement>) => void;
    onMouseOut: (event: MouseEvent<HTMLElement>) => void;
    onFocusCapture: (event: FocusEvent<HTMLElement>) => void;
    onBlurCapture: (event: FocusEvent<HTMLElement>) => void;
    onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => void;
    onClick: (event: MouseEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
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
    onClick: () => controller.openViewer(key, url, name),
    onKeyDown: (event) => {
      // 焦点在锚点内的按钮上时，Enter/空格是那个按钮的动作，不能顺带开查看层。
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      controller.openViewer(key, url, name);
    },
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

/**
 * 原图查看层（2026-10-24 用户确认方案 1）：悬停浮层的上限再大也读不完密图，
 * 点击锚点把原图放进整层看。点遮罩、关闭键或 Esc 退出。
 *
 * 缩放是**分步**的：100% → 200% → 400% → 回到 100%，倍数相对适应尺寸（UI 上由
 * `data-zoom` 驱动 CSS `zoom`，按布局放大而非 transform，超出部分靠查看层滚动平移）。
 * 2026-10-24 用户指认「放大之后没变化」：图片原始尺寸与视口接近时，「适应窗口」与
 * 「实际大小」两态渲染相同，等值切换没有意义；分步倍数保证每一步都可见，按钮上
 * 常驻百分比说明当前状态。点图片与点放大键等效。
 */
export function AttachmentLightbox({ item, onClose }: {
  readonly item: AttachmentViewerItem | null;
  readonly onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const itemKey = item?.key ?? null;
  // 换一张图回到 100%：上一张的缩放状态不属于这一张。
  useEffect(() => { setZoom(1); }, [itemKey]);
  if (item === null) return null;
  const cycleZoom = () => setZoom((value) => (value === 1 ? 2 : value === 2 ? 4 : 1));
  const percent = `${zoom * 100}%`;
  return createPortal(
    <div className="attachment-lightbox" role="dialog" aria-modal="true"
      aria-label={`查看图片 ${item.name}`} data-testid="attachment-lightbox"
      data-zoom={zoom} onClick={onClose}>
      <img className="attachment-lightbox-image" src={item.url} alt=""
        data-testid="attachment-lightbox-image"
        onClick={(event) => { event.stopPropagation(); cycleZoom(); }} />
      <div className="attachment-lightbox-bar">
        <span className="attachment-lightbox-name" title={item.name}>{item.name}</span>
        <button type="button" className="attachment-lightbox-button attachment-lightbox-zoom"
          data-testid="attachment-lightbox-zoom" aria-label={`放大（当前 ${percent}）`}
          title={`放大（当前 ${percent}，最大 400%）`} onClick={(event) => {
            event.stopPropagation(); cycleZoom();
          }}>
          <ZoomIn aria-hidden="true" />
          <span aria-hidden="true">{percent}</span>
        </button>
        <button type="button" className="attachment-lightbox-button" autoFocus
          data-testid="attachment-lightbox-close" aria-label="关闭" title="关闭"
          onClick={(event) => { event.stopPropagation(); onClose(); }}>
          <X aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body);
}
