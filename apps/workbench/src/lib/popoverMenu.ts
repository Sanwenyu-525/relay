import { useEffect, useRef, type RefObject } from "react";

/**
 * 浮层菜单的公共关闭语义（2026-10-17 用户指认「多菜单重叠、点菜单外面关不掉」后收口）。
 *
 * 原生 `<details>` 只被 summary 的点击切换：点到弹层外面、按 Esc、再开第二个菜单，
 * 都不会收起第一个。这件事此前在每个弹层里各写一遍，已经漂移——「+」菜单、通知面板、
 * 模型选择器、会话切换四处自己处理，写入档位、页头「更多操作」、发送选项等弹层完全没有，
 * 于是多个绝对定位浮层可以同时打开并互相压住。这里把三条规则收成一处：
 *
 * 1. **点到外面就收**：document 捕获阶段听 pointerdown，目标不在浮层内即收起。
 *    用捕获阶段是为了早于 summary 的 click：先收掉已开的浮层，这一次点击才去开新的。
 * 2. **Esc 收并把焦点还给触发器**（受控浮层由调用方自行决定焦点）。组词期间的 Esc
 *    归输入法（isComposing / keyCode 229），带修饰键的 Esc 不消费，已被内联处理器
 *    preventDefault 的 Esc 不重复处理——与既有弹层同一口径。
 * 3. **同一时刻只保留一个浮层**：打开一个就把它余已注册的收掉，从根上消灭重叠。
 *
 * 常驻折叠披露区（列表里的「查看依据」这类内联 details）不是浮层，不要注册本 hook，
 * 行为保持不变。
 */

type MenuCloser = () => void;

/** 已注册浮层的关闭回调：只做「关掉这个浮层」的最小动作，焦点管理归调用方。 */
const registered = new Map<symbol, MenuCloser>();

/** 打开一个浮层时，把其余已注册浮层全部收起。 */
function closeOthers(token: symbol): void {
  for (const [candidate, close] of registered) {
    if (candidate !== token) close();
  }
}

/** 组词期间的 Esc 属于输入法，不能吞。 */
function composing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** 裸 Esc 才算关闭意图；带修饰键的组合键不消费。 */
function plainEscape(event: KeyboardEvent): boolean {
  return event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export interface DetailsMenuOptions {
  /** 收起时要顺带清理的派生状态（二级面板、hover 记录等）。 */
  onClosed?: () => void;
  /** 传 false 时完全不挂监听：同一组件在内联披露形态下不是浮层，不参与关闭语义。 */
  enabled?: boolean;
}

/**
 * 非受控 `<details>` 浮层（写入档位、页头更多操作、「+」菜单、版本与比较等）。
 * 开合由原生 toggle 驱动，钩子只补外部关闭、Esc 与独占。
 */
export function useDetailsMenu(ref: RefObject<HTMLDetailsElement | null>, options: DetailsMenuOptions = {}): void {
  const { enabled = true } = options;
  const onClosed = useRef(options.onClosed);
  onClosed.current = options.onClosed;
  // details 可能条件渲染（页头「更多操作」等）：渲染期读一次 ref，节点挂载后 effect 依赖
  // 变化会重挂监听；卸载时 React 置空 ref，依赖归 null 后监听一并拆除。
  const node = ref.current;
  useEffect(() => {
    if (!enabled || node === null) return;
    const token = Symbol("detailsMenu");
    const close = () => { node.open = false; onClosed.current?.(); };
    registered.set(token, close);
    // 打开即独占：其余已注册浮层同时收起，多菜单因此不会叠在一起。
    const onToggle = () => { if (node.open) closeOthers(token); };
    node.addEventListener("toggle", onToggle);
    const onPointerDown = (event: PointerEvent) => {
      if (!node.open || node.contains(event.target as Node)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (!node.open || event.defaultPrevented || composing(event) || !plainEscape(event)) return;
      event.preventDefault();
      close();
      node.querySelector("summary")?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      node.removeEventListener("toggle", onToggle);
      registered.delete(token);
    };
  }, [enabled, node]);
}

/**
 * 受控浮层（发送选项、草稿分点浮层等）：开合是 React state，由调用方的 onClose 收口。
 * root 是「浮层 + 触发器」共同的外壳引用；点在触发器上不算外面——那一次点击的开关
 * 语义归触发器自己（否则会先被外部关闭收掉，又立刻被点击打开）。
 */
export function useMenuDismiss(open: boolean, onClose: () => void, root: RefObject<HTMLElement | null>): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // 外壳与 details 一样可能条件渲染：渲染期读 ref，挂载后 effect 依赖变化自动接管。
  const rootNode = root.current;
  useEffect(() => {
    if (!open || rootNode === null) return;
    const token = Symbol("menuLayer");
    registered.set(token, () => onCloseRef.current());
    closeOthers(token);
    const onPointerDown = (event: PointerEvent) => {
      if (event.defaultPrevented || rootNode.contains(event.target as Node) === true) return;
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || composing(event) || !plainEscape(event)) return;
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      registered.delete(token);
    };
  }, [open, rootNode]);
}

/**
 * 只挂「独占」：浮层自己已有完整的外部关闭与 Esc 处理（模型选择器、会话行菜单），
 * 只需在打开时把别的浮层收掉，避免两套浮层互相压。
 */
export function useMenuExclusive(open: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const token = Symbol("menuLayer");
    registered.set(token, () => onCloseRef.current());
    closeOthers(token);
    return () => { registered.delete(token); };
  }, [open]);
}
