/**
 * 浮层层级栈（UI-UNIFY-03）。
 *
 * 2026-11-15 收口：此前对话框、菜单、Popover、Combobox、Tooltip、右键菜单各自在
 * document 上监听 Escape。它们只能看到 `event.defaultPrevented`，而同一个节点上的多个
 * 监听器即使前一个已 preventDefault，后一个仍会照常执行——于是「Esc 关菜单的同时把
 * 外层对话框一起关掉」「关 Tooltip 把 Drawer 一起关掉」都能发生，具体关几层取决于
 * 监听器注册顺序。这里给所有浮层一条共同规则：
 *
 * 1. **后打开的是上层**：层按打开顺序入栈，`isTopOverlay` 只对最后入栈的层为真；
 * 2. **Esc 只处理栈顶**：每层在自己的处理器里先问「我是不是栈顶」，不是就直接返回；
 * 3. **同组独占**：同为 `popup` 的菜单/弹出层在打开时收掉其他 popup；但若新层在
 *    DOM 上位于旧层内部（Popover 里的 Combobox），旧层是它的容器而不是兄弟，保留；
 *    对话框与 Tooltip 不参与这条规则（对话框可以叠对话框，Tooltip 不抢独占）；
 * 4. **卸载即出栈**：每个 `registerOverlay` 返回清理函数，React effect 卸载时调用，
 *    避免已卸载组件继续响应全局快捷键。
 *
 * 层级顺序就是用户体验顺序：对话框里打开菜单 → 菜单在上；菜单里聚焦出 Tooltip →
 * Tooltip 在上。一次 Esc 只关掉最近打开的那一层，第二次再关下一层。
 *
 * 注意：本栈不接管原生 `<select>` 的弹层。原生下拉打开时 Esc 由浏览器处理，页面
 * 不会收到 keydown；不要为了「统一」把它算进浮层栈。
 */

export type OverlayKind = "dialog" | "popup" | "tooltip";

interface OverlayEntry {
  readonly token: symbol;
  readonly kind: OverlayKind;
  readonly close: () => void;
  /** 浮层根节点；用于区分「兄弟浮层」与「容器内再打开的浮层」。 */
  readonly root: HTMLElement | null;
}

let entries: OverlayEntry[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** 测试与诊断用：当前打开的浮层数量。 */
export function overlayCount(): number {
  return entries.length;
}

/** 测试用：当前栈顶的类别；没有浮层时为 null。 */
export function topOverlayKind(): OverlayKind | null {
  return entries.at(-1)?.kind ?? null;
}

export function subscribeOverlayStack(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * 打开一层浮层。token 必须由调用方持有（通常是一个 `useRef(Symbol(...))`），
 * 同一个 token 重复注册时会被移到栈顶，因此「关掉再打开」仍然符合后打开在上。
 */
export function registerOverlay(token: symbol, kind: OverlayKind, close: () => void, root: HTMLElement | null = null): () => void {
  entries = [...entries.filter((entry) => entry.token !== token), { token, kind, close, root }];
  notify();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    entries = entries.filter((entry) => entry.token !== token);
    notify();
  };
}

export function isTopOverlay(token: symbol): boolean {
  return entries.at(-1)?.token === token;
}

/**
 * 同组独占：打开一个 popup 时把所有其他 popup 收掉（对话框与 Tooltip 不受影响）。
 * 传入新层根节点时，DOM 祖先/后代关系的两层视为嵌套而非并列——例如 Popover 面板里
 * 再打开的 Combobox 不应把 Popover 一起收掉；无关的两层仍按独占关闭。
 */
export function closeSiblingOverlays(token: symbol, kind: OverlayKind, root: HTMLElement | null = null): void {
  const siblings = entries.filter((entry) => {
    if (entry.token === token || entry.kind !== kind) return false;
    if (root === null || entry.root === null) return true;
    return !root.contains(entry.root) && !entry.root.contains(root);
  });
  for (const sibling of siblings) sibling.close();
}

/** 读屏/测试辅助：某层是否仍在栈内（卸载后为 false）。 */
export function hasOverlay(token: symbol): boolean {
  return entries.some((entry) => entry.token === token);
}
