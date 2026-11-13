import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "./cn";

/**
 * 拖拽改宽的唯一实现（UI-UNIFY-02）。
 *
 * 侧栏与工作详情面板原本各写一份指针捕获 + 钳制 + 方向键逻辑，已经漂移出两个缺陷：
 * 侧栏抬手时提交的是渲染期的旧 `width`（拖动期间父级只做预览、不重渲染时会把宽度写回起点），
 * 且两处对 IME 组合键、`aria-valuetext` 的处理不一致。这里把「测量起点 → 拖动预览 →
 * 抬手提交 → 键盘步进 → 双击复位」收成一处，布局仍由页面自己的网格轨道负责。
 *
 * 不新增 `ResizablePanel` 容器：协作页的列宽由 grid 轨道持有（见 CollaborationView），
 * 再包一层 div 会改变 DOM 结构与现有尺寸断言；公共机制是手柄，不是外壳。
 */

export interface ResizeDragOptions {
  /** 已提交的宽度；null 表示跟随默认/实测值。 */
  readonly value: number | null;
  /** 键盘步进与未设置宽度时的起点。 */
  readonly defaultValue?: number;
  /** 首次拖拽的实测起点（如面板当前宽度）；返回 null 表示无法测量。 */
  readonly measure?: (handle: HTMLElement) => number | null;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** 1 = 指针右移变宽（左侧栏）；-1 = 指针左移变宽（右侧面板）。 */
  readonly direction: 1 | -1;
  readonly onChange: (width: number | null, commit: boolean) => void;
}

export interface ResizeDrag {
  readonly dragging: boolean;
  readonly handleProps: {
    readonly onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
    readonly onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
    readonly onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
    readonly onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
    readonly onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
    readonly onDoubleClick: () => void;
  };
}

export function useResizeDrag(options: ResizeDragOptions): ResizeDrag {
  const { value, defaultValue, measure, min, max, step, direction, onChange } = options;
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)));

  /** 起点：已提交宽度 → 默认宽度 → 实测 → 下限。 */
  function resolveStart(handle: HTMLElement): number {
    return clamp(value ?? defaultValue ?? measure?.(handle) ?? min);
  }

  function start(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || drag.current !== null) return;
    const startWidth = resolveStart(event.currentTarget);
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    // width 同时记在拖拽状态里：抬手提交不依赖父级是否在下一次渲染前更新 value。
    state.width = clamp(state.startWidth + (event.clientX - state.startX) * direction);
    onChange(state.width, false);
  }

  function end(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* 捕获已释放时忽略 */ }
    onChange(state.width, true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    // 组词期间的 Esc/方向键属于输入法，不能吞（与 lib/popoverMenu 同一口径）。
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = (event.key === "ArrowRight" ? 1 : -1) * direction * step;
    onChange(clamp(resolveStart(event.currentTarget) + delta), true);
  }

  return {
    dragging,
    handleProps: {
      onPointerDown: start,
      onPointerMove: move,
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
      onKeyDown,
      onDoubleClick: () => onChange(null, true)
    }
  };
}

export interface ResizableHandleProps extends Omit<ResizeDragOptions, "onChange"> {
  /** 可访问名称（同时作为原生 title 的默认值）。 */
  readonly label: string;
  readonly onChange: ResizeDragOptions["onChange"];
  readonly className?: string;
  readonly testId?: string;
  readonly title?: string;
  /** 宽度为 null 时的朗读文案；不传则用 aria-valuenow。 */
  readonly valueText?: (value: number | null) => string | undefined;
}

export default function ResizableHandle({
  label, value, defaultValue, measure, min, max, step, direction, onChange,
  className, testId, title, valueText
}: ResizableHandleProps) {
  const { dragging, handleProps } = useResizeDrag({ value, defaultValue, measure, min, max, step, direction, onChange });
  return <button
    type="button"
    role="separator"
    aria-orientation="vertical"
    aria-label={label}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={value ?? defaultValue}
    aria-valuetext={valueText?.(value)}
    title={title ?? label}
    data-testid={testId}
    className={cn("drag-separator", "ui-resizable-handle", dragging && "drag-separator--dragging", className)}
    {...handleProps}
  />;
}
