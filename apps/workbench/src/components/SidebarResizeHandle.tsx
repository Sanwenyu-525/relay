import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { resolvedTokenValue } from "../lib/tokens";

/**
 * 侧栏拖拽分隔条：只注入展示层宽度（--relay-sidebar-user-width），不承载业务事实。
 * 上下限与步长对齐既有 token：下限 10rem 保证导航文字可读，上限 20rem 等于窄右栏宽度，
 * 步长 16px 对应 space.4 节奏；窄断点（≤63.9375rem）由 CSS 隐藏手柄并使用固定列宽。
 */
export const SIDEBAR_MIN_WIDTH_PX = 160;
export const SIDEBAR_MAX_WIDTH_PX = 320;
const SIDEBAR_DEFAULT_WIDTH_PX = Number.parseFloat(resolvedTokenValue("layout.sidebar.width")) * 16;
const SIDEBAR_STEP_PX = 16;

export function clampSidebarWidth(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH_PX, Math.max(SIDEBAR_MIN_WIDTH_PX, Math.round(value)));
}

export default function SidebarResizeHandle({ width, onWidthChange }: {
  width: number | null;
  onWidthChange: (width: number | null, commit: boolean) => void;
}) {
  const drag = useRef<{ pointerId: number; startWidth: number; startX: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || drag.current !== null) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, startWidth: width ?? SIDEBAR_DEFAULT_WIDTH_PX, startX: event.clientX };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (state === null || event.pointerId !== state.pointerId) return;
    onWidthChange(clampSidebarWidth(state.startWidth + event.clientX - state.startX), false);
  }
  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (state === null || event.pointerId !== state.pointerId) return;
    drag.current = null;
    setDragging(false);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* 捕获已释放时忽略 */ }
    onWidthChange(width ?? SIDEBAR_DEFAULT_WIDTH_PX, true);
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const current = width ?? SIDEBAR_DEFAULT_WIDTH_PX;
    if (event.key === "ArrowLeft") { event.preventDefault(); onWidthChange(clampSidebarWidth(current - SIDEBAR_STEP_PX), true); }
    else if (event.key === "ArrowRight") { event.preventDefault(); onWidthChange(clampSidebarWidth(current + SIDEBAR_STEP_PX), true); }
  }

  return <button type="button" className={`sidebar-resize-handle${dragging ? " sidebar-resize-handle--dragging" : ""}`}
    data-testid="sidebar-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整侧边栏宽度"
    title="拖拽调整侧边栏宽度；双击复位" aria-valuemin={SIDEBAR_MIN_WIDTH_PX} aria-valuemax={SIDEBAR_MAX_WIDTH_PX}
    aria-valuenow={width ?? SIDEBAR_DEFAULT_WIDTH_PX}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
    onKeyDown={onKeyDown} onDoubleClick={() => onWidthChange(null, true)} />;
}
