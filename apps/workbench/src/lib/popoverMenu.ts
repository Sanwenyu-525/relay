import { useEffect, useRef, type RefObject } from "react";
import { closeSiblingOverlays, isTopOverlay, registerOverlay } from "./overlayStack";

/**
 * 浮层菜单的公共关闭语义（2026-10-17 用户指认「多菜单重叠、点菜单外面关不掉」后收口；
 * 2026-11-15 UI-UNIFY-03 接入统一层级栈）。
 *
 * 原生 `<details>` 只被 summary 的点击切换：点到弹层外面、按 Esc、再开第二个菜单，
 * 都不会收起第一个。这件事此前在每个弹层里各写一遍，已经漂移——「+」菜单、通知面板、
 * 模型选择器、会话切换四处自己处理，写入档位、页头「更多操作」、发送选项等弹层完全没有，
 * 于是多个绝对定位浮层可以同时打开并互相压住。这里把三条规则收成一处：
 *
 * 1. **点到外面就收**：document 捕获阶段听 pointerdown，目标不在浮层内即收起。
 *    用捕获阶段是为了早于 summary 的 click：先收掉已开的浮层，这一次点击才去开新的。
 * 2. **Esc 只收栈顶**：受控浮层由调用方自行决定焦点。组词期间的 Esc 归输入法
 *    （isComposing / keyCode 229），带修饰键的 Esc 不消费，已被内联处理器
 *    preventDefault 的 Esc 不重复处理。只有 `isTopOverlay` 为真的一层真正关闭，
 *    因此不会出现「关菜单顺带关掉外层对话框」。
 * 3. **同一时刻只保留一个浮层**：打开一个就把它余已注册的 popup 收掉，从根上消灭重叠。
 *
 * 常驻折叠披露区（列表里的「查看依据」这类内联 details）不是浮层，不要注册本 hook，
 * 行为保持不变。
 */

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
  const token = useRef(Symbol("detailsMenu"));
  const unregister = useRef<(() => void) | null>(null);
  const registeredNode = useRef<HTMLDetailsElement | null>(null);

  // 只在组件真正卸载时出栈；普通重渲染不能把层重新推到栈顶（那会让「后打开的上层」失效）。
  useEffect(() => () => {
    unregister.current?.();
    unregister.current = null;
    registeredNode.current = null;
  }, []);

  // 不在渲染期读 ref：首次 render 时 ref.current 还是 null，若把它写进依赖数组，
  // effect 只会在挂载后跑一次 null 分支，Esc/点外面/独占永远不会生效。
  // 这里在每次 commit 后读取当前节点并重挂监听；菜单节点替换时也会自动接管，
  // 代价只是浮层组件的一次 effect 重跑（渲染频率极低）。
  useEffect(() => {
    if (!enabled) {
      unregister.current?.();
      unregister.current = null;
      registeredNode.current = null;
      return;
    }
    const node = ref.current;
    if (node === null) return;

    const unregisterLayer = () => { unregister.current?.(); unregister.current = null; registeredNode.current = null; };
    const close = () => { node.open = false; onClosed.current?.(); unregisterLayer(); };
    const syncLayer = () => {
      if (!node.open) { unregisterLayer(); return; }
      // 同一个节点已注册：保持原来的打开顺序，不要每帧重新入栈。
      if (registeredNode.current === node) return;
      unregisterLayer();
      registeredNode.current = node;
      unregister.current = registerOverlay(token.current, "popup", close, node);
      closeSiblingOverlays(token.current, "popup", node);
    };

    syncLayer();
    // 打开即独占：其余已注册浮层同时收起，多菜单因此不会叠在一起。
    const onToggle = () => { syncLayer(); };
    node.addEventListener("toggle", onToggle);
    const onPointerDown = (event: PointerEvent) => {
      if (!node.open || node.contains(event.target as Node)) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (!node.open || event.defaultPrevented || composing(event) || !plainEscape(event)) return;
      if (!isTopOverlay(token.current)) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      node.querySelector("summary")?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      node.removeEventListener("toggle", onToggle);
      // 这里不 unregister：effect 每次渲染都会重跑，若在这里出栈，下一轮 effect 会把层
      // 重新推到栈顶，压在后来打开的 Tooltip/菜单之上。出栈由卸载 effect 与 syncLayer 负责。
    };
  });
}

/**
 * 受控浮层（发送选项、草稿分点浮层等）：开合是 React state，由调用方的 onClose 收口。
 * root 是「浮层 + 触发器」共同的外壳引用；点在触发器上不算外面——那一次点击的开关
 * 语义归触发器自己（否则会先被外部关闭收掉，又立刻被点击打开）。
 *
 * 返回层 token：需要自己处理按键的组件（如 Combobox 的输入框）用它判断「我是不是栈顶」，
 * 避免在 Tooltip 盖在上层时抢先关掉列表。
 */
export function useMenuDismiss(open: boolean, onClose: () => void, root: RefObject<HTMLElement | null>): symbol {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const token = useRef(Symbol("menuLayer"));
  // 外壳与 details 同理：在 effect 里读取节点，避免首次 render 的 null ref 被写进依赖。
  useEffect(() => {
    if (!open) return;
    const rootNode = root.current;
    if (rootNode === null) return;
    const close = () => onCloseRef.current();
    const unregister = registerOverlay(token.current, "popup", close, rootNode);
    closeSiblingOverlays(token.current, "popup", rootNode);
    const onPointerDown = (event: PointerEvent) => {
      if (event.defaultPrevented || rootNode.contains(event.target as Node) === true) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || composing(event) || !plainEscape(event)) return;
      if (!isTopOverlay(token.current)) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      unregister();
    };
  }, [open]);
  return token.current;
}

/**
 * 只挂「独占」：浮层自己已有完整的外部关闭与 Esc 处理（模型选择器、会话行菜单），
 * 只需在打开时把别的浮层收掉，避免两套浮层互相压。
 * 这些组件仍要自己判断 `isTopOverlay`，否则会越过上层浮层关闭。
 */
export function useMenuExclusive(open: boolean, onClose: () => void): symbol {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const token = useRef(Symbol("menuLayer"));
  useEffect(() => {
    if (!open) return;
    const unregister = registerOverlay(token.current, "popup", () => onCloseRef.current());
    closeSiblingOverlays(token.current, "popup");
    return unregister;
  }, [open]);
  return token.current;
}

/**
 * 浮层翻面（2026-10-24，贴芯片锚定同轮）：浮层改锚在芯片上后，芯片靠近输入卡右缘时
 * 从左缘起排的面板会越出卡片，被中栏 `.collab-center` 的 `overflow:hidden` 裁掉
 * （1000px 视口实测：芯片左缘 715 + 320 = 1035，卡片右缘 971）。模型选择器在右端
 * 一组里常驻翻面（CSS 静态规则），但资料芯片在窄窗会随工具行换行跑到左边，静态规则
 * 那时又会把面板裁出卡片左缘——所以这一枚的量必须现算：打开时、窗口尺寸变化时、
 * 面板自身宽度变化时（选 Skill 会改变发送选项面板宽度）各量一次。
 *
 * 规则：芯片左缘 + 面板宽越过卡片右缘、且翻面后面板左缘仍在卡片内时，写
 * `data-flip="inline"`（CSS 改为右缘贴芯片）；其余情况不写（左缘贴芯片是默认）。
 * 只写数据属性，定位本身仍在 CSS；量不到卡片或面板宽为 0（关闭态）时保持不翻。
 */
export function usePopupFlip(details: RefObject<HTMLDetailsElement | null>): void {
  const node = details.current;
  useEffect(() => {
    if (node === null) return;
    const place = () => {
      if (!node.open) { node.removeAttribute("data-flip"); return; }
      const summary = node.querySelector("summary");
      const panel = node.lastElementChild;
      const card = node.closest(".agent-chat-composer, .create-form");
      if (summary === null || panel === null || card === null) return;
      const chip = summary.getBoundingClientRect();
      const bounds = card.getBoundingClientRect();
      const width = (panel as HTMLElement).getBoundingClientRect().width;
      if (width === 0) return;
      const flip = chip.left + width > bounds.right - 1 && chip.right - width >= bounds.left + 1;
      // 只在状态真的变化时写：同值 setAttribute 也会进 MutationObserver，不自激循环。
      const flipped = node.getAttribute("data-flip") === "inline";
      if (flip && !flipped) node.setAttribute("data-flip", "inline");
      else if (!flip && flipped) node.removeAttribute("data-flip");
    };
    place();
    // 开合可能来自原生 toggle、React 受控 open 或用户点 summary：监听属性覆盖全部来源。
    const attributes = new MutationObserver(place);
    attributes.observe(node, { attributes: true, attributeFilter: ["open"] });
    const panel = node.lastElementChild;
    const size = panel === null ? null : new ResizeObserver(place);
    if (panel !== null && size !== null) size.observe(panel);
    window.addEventListener("resize", place);
    return () => {
      attributes.disconnect();
      size?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [node]);
}
