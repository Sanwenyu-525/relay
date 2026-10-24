import type { KeyboardEvent } from "react";

/**
 * 同页列表键盘导航：横向页签与纵向漫游两类入口共用本模块，
 * IME 过滤与两端循环的判据只写一遍；路由导航继续使用链接，不挂这里的处理器。
 */

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

/**
 * 同页纵向列表漫游：只移动焦点，不改变选中。
 *
 * 与页签处理器的区别：页签的选中跟随焦点；列表项各自是独立动作（入口、按钮），
 * 激活仍由点击或 Enter/Space 显式触发，方向键不代劳。焦点落在项上之后的呈现
 * （如时间线刻度显示预览）由项自身的 focus 行为负责，本函数不引入业务语义。
 *
 * 项集合由调用方给选择器、每次按键重新查询：禁用项、折叠分组里的项与动态增删都在
 * 查询时自然生效，组件不必维护一份索引状态。折叠分组用 details 开合判定而非布局查询：
 * jsdom 无排版引擎，行为在测试与真实浏览器里才一致。两端循环与 IME 过滤和横向页签一致。
 * 焦点不在任何项上时不动：Tab 进入列表的既有语义不变，本函数只做增量加速。
 */
export function handleRosterKeyDown(event: KeyboardEvent<HTMLElement>, itemSelector: string): void {
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(itemSelector)]
    .filter((item) => !item.matches(":disabled") && item.closest("details:not([open])") === null);
  if (items.length === 0) return;
  const current = items.findIndex((item) => item === document.activeElement);
  if (current < 0) return;
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items[next]!.focus();
}
