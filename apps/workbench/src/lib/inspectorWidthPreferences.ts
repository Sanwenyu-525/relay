/**
 * 工作详情（右侧「工作详情」面板）左边界拖拽宽度。
 *
 * 只是本设备的展示偏好，不承载 Task、Run、Review 或命令身份；读写失败时回退到
 * layout.inspector.width token，本次会话仍可继续使用默认宽度。
 * 下限 18rem 对齐 token 下界，保证正文与步骤流可读；上限 40rem 对齐深预览的阅读上限。
 */
export const INSPECTOR_WIDTH_STORAGE_KEY = "relay.workbench.inspectorWidthPx";
export const INSPECTOR_WIDTH_MIN_PX = 288;
export const INSPECTOR_WIDTH_MAX_PX = 640;
export const INSPECTOR_WIDTH_STEP_PX = 16;

export function clampInspectorWidth(value: number): number {
  return Math.min(INSPECTOR_WIDTH_MAX_PX, Math.max(INSPECTOR_WIDTH_MIN_PX, Math.round(value)));
}

export function readStoredInspectorWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(INSPECTOR_WIDTH_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampInspectorWidth(parsed) : null;
  } catch { return null; }
}

/** null 表示恢复默认宽度（删除本地覆盖），与双击手柄的语义一致。 */
export function saveInspectorWidth(value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(INSPECTOR_WIDTH_STORAGE_KEY);
    else window.localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(clampInspectorWidth(value)));
  } catch { /* 存储不可写时仅本次会话生效 */ }
}
