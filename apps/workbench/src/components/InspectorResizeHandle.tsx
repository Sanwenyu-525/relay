import ResizableHandle from "../ui/ResizableHandle";
import { clampInspectorWidth, INSPECTOR_WIDTH_MAX_PX, INSPECTOR_WIDTH_MIN_PX,
  INSPECTOR_WIDTH_STEP_PX } from "../lib/inspectorWidthPreferences";

/**
 * 工作详情面板的左边界拖拽。
 *
 * 指针捕获、方向键与双击复位由 `src/ui/ResizableHandle` 统一实现；本组件只提供
 * 「面板贴右缘、向左拖才是放宽」的方向（direction=-1）与首次拖拽的实测起点。
 * 宽度由协作页持有（它同时写网格轨道），这里只测量并提交数值。
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
  return <ResizableHandle
    label="调整工作详情宽度"
    testId="inspector-resize-handle"
    className="inspector-resize-handle"
    title="拖动或左右方向键调整工作详情宽度；双击恢复默认"
    value={width}
    measure={measurePanel}
    min={INSPECTOR_WIDTH_MIN_PX}
    max={INSPECTOR_WIDTH_MAX_PX}
    step={INSPECTOR_WIDTH_STEP_PX}
    direction={-1}
    valueText={(value) => value === null ? "跟随默认宽度" : `${value} 像素`}
    onChange={(next, commit) => onWidthChange(next === null ? null : clampInspectorWidth(next), commit)}
  />;
}
