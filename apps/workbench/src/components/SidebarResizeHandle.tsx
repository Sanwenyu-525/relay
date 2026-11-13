import ResizableHandle from "../ui/ResizableHandle";
import { resolvedTokenValue } from "../lib/tokens";

/**
 * 侧栏拖拽分隔条：只注入展示层宽度（--relay-sidebar-user-width），不承载业务事实。
 * 上下限与步长对齐既有 token：下限 10rem 保证导航文字可读，上限 20rem 等于窄右栏宽度，
 * 步长 16px 对应 space.4 节奏；窄断点（≤63.9375rem）由 CSS 隐藏手柄并使用固定列宽。
 *
 * 指针捕获与方向键逻辑在 `src/ui/ResizableHandle`，本组件只声明方向与默认宽度。
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
  return <ResizableHandle
    label="调整侧边栏宽度"
    testId="sidebar-resize-handle"
    className="sidebar-resize-handle"
    title="拖拽调整侧边栏宽度；双击复位"
    value={width}
    defaultValue={SIDEBAR_DEFAULT_WIDTH_PX}
    min={SIDEBAR_MIN_WIDTH_PX}
    max={SIDEBAR_MAX_WIDTH_PX}
    step={SIDEBAR_STEP_PX}
    direction={1}
    onChange={(next, commit) => onWidthChange(next === null ? null : clampSidebarWidth(next), commit)}
  />;
}
