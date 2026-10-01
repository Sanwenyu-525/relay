import type { KeyboardEvent } from "react";

/** 同页横向页签：焦点和选中项一起移动，路由链接不使用此处理器。 */
export function handleTabListKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]:not(:disabled)')];
  const current = tabs.findIndex((tab) => tab === document.activeElement);
  if (current < 0 || tabs.length === 0) return;
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
    : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next]!.focus();
  tabs[next]!.click();
}
