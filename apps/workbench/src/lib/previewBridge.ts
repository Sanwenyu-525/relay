import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 内置网页预览的宿主桥。
 *
 * 工作台这一侧只持有**句柄**，不自己宣称导航成功：地址、标题、加载态与崩溃全部来自
 * 宿主的原生事件（`relay-preview-event`）。句柄由 `id` + `generation` 组成，`id` 永不复用，
 * 因此关闭后迟到的请求不会打到新标签上。
 *
 * 非桌面宿主（浏览器开发模式）没有原生容器，`desktopPreviewBridge()` 返回 null，
 * 面板必须如实说明不可用，而不是退化成一个 iframe。
 */

export interface PreviewHandle {
  readonly id: string;
  readonly generation: number;
}

export interface PreviewBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PreviewSnapshot {
  readonly id: string;
  readonly generation: number;
  readonly scope: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export type PreviewEventKind = "LOAD_STARTED" | "LOAD_FINISHED" | "TITLE" | "NAVIGATION_BLOCKED" | "CRASHED";

export interface PreviewEventPayload {
  readonly id: string;
  readonly generation: number;
  readonly kind: PreviewEventKind;
  readonly url?: string;
  readonly title?: string;
  readonly reason?: string;
}

export type PreviewNavAction = "BACK" | "FORWARD" | "STOP";

export interface PreviewBridge {
  open(request: { scope: string; url: string; bounds: PreviewBounds }): Promise<PreviewSnapshot>;
  navigate(handle: PreviewHandle, url: string): Promise<PreviewSnapshot>;
  setBounds(handle: PreviewHandle, bounds: PreviewBounds): Promise<void>;
  setVisible(handle: PreviewHandle, visible: boolean): Promise<void>;
  nav(handle: PreviewHandle, action: PreviewNavAction): Promise<PreviewSnapshot>;
  state(handle: PreviewHandle): Promise<PreviewSnapshot>;
  close(handle: PreviewHandle): Promise<void>;
  /** 切会话时释放该作用域的全部实例；返回实际关闭数量。 */
  releaseScope(scope: string): Promise<number>;
  openExternal(url: string): Promise<void>;
  /** 订阅宿主事件。返回取消订阅函数。 */
  subscribe(listener: (payload: PreviewEventPayload) => void): Promise<UnlistenFn>;
}

export const PREVIEW_EVENT_NAME = "relay-preview-event";

/** 当前是否为具备原生预览容器的桌面宿主。 */
export function previewHostAvailable(): boolean {
  return isTauri();
}

export function desktopPreviewBridge(): PreviewBridge | null {
  if (!isTauri()) return null;
  return {
    open: ({ scope, url, bounds }) => invoke<PreviewSnapshot>("preview_open", { scope, url, bounds }),
    navigate: (handle, url) => invoke<PreviewSnapshot>("preview_navigate", { handle, url }),
    setBounds: (handle, bounds) => invoke<void>("preview_set_bounds", { handle, bounds }),
    setVisible: (handle, visible) => invoke<void>("preview_set_visible", { handle, visible }),
    nav: (handle, action) => invoke<PreviewSnapshot>("preview_nav", { handle, action }),
    state: (handle) => invoke<PreviewSnapshot>("preview_state", { handle }),
    close: (handle) => invoke<void>("preview_close", { handle }),
    releaseScope: (scope) => invoke<number>("preview_release_scope", { scope }),
    openExternal: (url) => invoke<void>("preview_open_external", { url }),
    subscribe: (listener) => listen<PreviewEventPayload>(PREVIEW_EVENT_NAME, (event) => listener(event.payload))
  };
}

/**
 * 事件归属判定：只有句柄完全一致的标签才接受这条事件。
 * 关闭标签、切换作用域、重建实例之后到达的旧事件都会被丢掉，不会覆盖新页面。
 */
export function eventBelongsTo(handle: PreviewHandle | null, payload: PreviewEventPayload): boolean {
  return handle !== null && payload.id === handle.id && payload.generation === handle.generation;
}
