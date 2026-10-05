/**
 * 运行期动效偏好。只决定装饰层是否绘制，不发送任何命令，也不隐藏状态文字与控制入口。
 *
 * 优先级：用户在本机显式关闭 > 系统「减少动态效果」> 默认开启。
 * 显式选择记在 localStorage，这样「本机关动效」不会被系统设置覆盖回去，
 * 反过来系统设置改变时（html[data-motion] 缺省）仍按系统走。
 */
const STORAGE_KEY = "relay.motion";

export type MotionPreference = "on" | "off" | "system";

export function storedMotionPreference(): MotionPreference | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "on" || value === "off" || value === "system" ? value : null;
  } catch {
    // 隐私模式或存储不可用时按系统设置走，不因此让页面起不来。
    return null;
  }
}

export function storeMotionPreference(value: MotionPreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // 存不住只影响本次会话的选择，不阻断设置入口本身。
  }
}

export function systemPrefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 本次渲染是否绘制运行期动效。 */
export function resolveMotionPreference(): boolean {
  const stored = storedMotionPreference();
  if (stored === "on") return true;
  if (stored === "off") return false;
  return !systemPrefersReducedMotion();
}

/** 把当前解析结果写回 <html data-motion>，供 CSS 选择器读取。 */
export function applyMotionPreference(value: MotionPreference = "system"): boolean {
  const allowed = value === "system" ? resolveMotionPreference() : value === "on";
  document.documentElement.dataset.motion = allowed ? "on" : "off";
  return allowed;
}
