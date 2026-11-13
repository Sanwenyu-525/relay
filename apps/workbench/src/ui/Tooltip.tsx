import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";

/**
 * 轻量 Tooltip：指针悬停与键盘聚焦都会显示，Esc 收起。
 *
 * 触发器通过 `cloneElement` 附加事件与 `aria-describedby`，不额外包一层可聚焦元素——
 * 包一层 span 会让读屏把名称读在外壳上，也会改变布局盒。因此触发器必须能透传
 * `onMouseEnter/onMouseLeave/onFocus/onBlur/aria-describedby/ref`（`src/ui` 的组件都透传；
 * 自定义组件若不透传，本组件不会报错但也拿不到事件，需在调用处确认）。
 *
 * 气泡用 portal + position:fixed，避免被 `overflow: hidden` 的卡片/表格裁掉；打开期间
 * 监听滚动与窗口尺寸变化重新定位。
 */
export interface TooltipProps {
  /** 气泡内容（短文本）；同时作为可访问描述。 */
  readonly label: ReactNode;
  readonly children: ReactElement;
  readonly placement?: "top" | "bottom";
  /** 悬停出现延迟（毫秒）；键盘聚焦不延迟。 */
  readonly delay?: number;
  readonly disabled?: boolean;
  readonly className?: string;
}

type TriggerProps = {
  ref?: Ref<HTMLElement>;
  "aria-describedby"?: string;
  onMouseEnter?: (event: ReactMouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: ReactMouseEvent<HTMLElement>) => void;
  onFocus?: (event: React.FocusEvent<HTMLElement>) => void;
  onBlur?: (event: React.FocusEvent<HTMLElement>) => void;
};

export default function Tooltip({ label, children, placement = "top", delay = 250, disabled = false, className }: TooltipProps) {
  const id = `ui-tooltip-${useId().replaceAll(":", "")}`;
  const trigger = useRef<HTMLElement | null>(null);
  const bubble = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  const hide = useCallback(() => { clear(); setOpen(false); setPosition(null); }, [clear]);

  const show = useCallback((immediate: boolean) => {
    if (disabled) return;
    clear();
    if (immediate) { setOpen(true); return; }
    timer.current = setTimeout(() => setOpen(true), delay);
  }, [clear, delay, disabled]);

  useEffect(() => clear, [clear]);

  // 打开后再测量：气泡尺寸只有在渲染后才知道，先隐藏再一次性定位，避免左上角闪一下。
  const reposition = useCallback(() => {
    const anchor = trigger.current;
    const panel = bubble.current;
    if (anchor === null || panel === null) return;
    const rect = anchor.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    const margin = 8;
    const half = box.width / 2;
    const center = rect.left + rect.width / 2;
    const left = Math.min(window.innerWidth - margin - half, Math.max(margin + half, center));
    const top = placement === "bottom" ? rect.bottom + 6 : rect.top - box.height - 6;
    setPosition({ top: Math.max(margin, top), left });
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    // 滚动时跟随而不是立即收起：scrollIntoView、键盘聚焦引起的页面滚动都很常见，
    // 一滚就收会让键盘用户看不到提示。窗口尺寸变化仍然收起。
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide, reposition]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      hide();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, hide]);

  if (!isValidElement<TriggerProps>(children)) return children;
  const child = children as ReactElement<TriggerProps>;
  const childProps = child.props;
  const describedBy = [childProps["aria-describedby"], open ? id : undefined].filter(Boolean).join(" ") || undefined;

  const element = cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      trigger.current = node;
      const existing = childProps.ref;
      if (typeof existing === "function") existing(node);
      else if (existing !== undefined && existing !== null) (existing as { current: HTMLElement | null }).current = node;
    },
    "aria-describedby": describedBy,
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => { childProps.onMouseEnter?.(event); show(false); },
    onMouseLeave: (event: ReactMouseEvent<HTMLElement>) => { childProps.onMouseLeave?.(event); hide(); },
    onFocus: (event: React.FocusEvent<HTMLElement>) => { childProps.onFocus?.(event); show(true); },
    onBlur: (event: React.FocusEvent<HTMLElement>) => { childProps.onBlur?.(event); hide(); }
  });

  return <>
    {element}
    {open && !disabled ? createPortal(
      <div
        ref={bubble}
        id={id}
        role="tooltip"
        className={cn("ui-tooltip", className)}
        style={position === null ? { position: "fixed", top: 0, left: 0, visibility: "hidden" } : { position: "fixed", top: position.top, left: position.left, transform: "translateX(-50%)" }}
      >{label}</div>,
      document.body
    ) : null}
  </>;
}
