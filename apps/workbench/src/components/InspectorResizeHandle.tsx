import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { clampInspectorWidth, INSPECTOR_WIDTH_MAX_PX, INSPECTOR_WIDTH_MIN_PX,
  INSPECTOR_WIDTH_STEP_PX } from "../lib/inspectorWidthPreferences";

/**
 * 工作详情面板的左边界拖拽。
 *
 * 与近期工作栏的 SidebarResizeHandle 共用 .drag-separator 的外观、指针捕获与
 * 「拖动预览、抬手提交」的交互；差别只有方向——面板贴右，向左拖才是放宽。
 * 宽度由协作页持有（它同时写网格轨道），本组件只测量并提交数值。
 */
function measurePanel(handle: HTMLElement): number | null {
  const panel = handle.parentElement?.querySelector<HTMLElement>(":scope > .task-inspector:not(.task-inspector--preview)");
  const width = panel?.getBoundingClientRect().width ?? 0;
  return width > 0 ? width : null;
}

export default function InspectorResizeHandle({ width, onWidthChange }: {
  width: number | null;
  onWidthChange: (width: number | null, commit: boolean) => void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || drag.current !== null) return;
    const startWidth = width ?? measurePanel(event.currentTarget);
    if (startWidth === null) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    // 左移放大：面板贴右缘，起点在左边界。
    state.width = clampInspectorWidth(state.startWidth + state.startX - event.clientX);
    onWidthChange(state.width, false);
  }
  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (state === null || state.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* 捕获已释放时忽略 */ }
    onWidthChange(state.width, true);
  }
  function pressKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const current = width ?? measurePanel(event.currentTarget);
    if (current === null) return;
    event.preventDefault();
    onWidthChange(clampInspectorWidth(current + (event.key === "ArrowLeft" ? INSPECTOR_WIDTH_STEP_PX : -INSPECTOR_WIDTH_STEP_PX)), true);
  }

  return <button type="button" role="separator"
    className={`drag-separator inspector-resize-handle${dragging ? " drag-separator--dragging" : ""}`}
    data-testid="inspector-resize-handle" aria-orientation="vertical" aria-label="调整工作详情宽度"
    aria-valuemin={INSPECTOR_WIDTH_MIN_PX} aria-valuemax={INSPECTOR_WIDTH_MAX_PX}
    aria-valuenow={width ?? undefined} aria-valuetext={width === null ? "跟随默认宽度" : `${width} 像素`}
    title="拖动或左右方向键调整工作详情宽度；双击恢复默认"
    onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
    onLostPointerCapture={endDrag} onKeyDown={pressKey} onDoubleClick={() => onWidthChange(null, true)} />;
}
