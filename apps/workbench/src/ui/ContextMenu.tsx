import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "./cn";

/**
 * 右键菜单：在指针位置打开，菜单项可键盘到达，Esc/点外面/选中都收起。
 *
 * 与 `Menu`（details 下拉）共用外观类（`ui-menu__panel` / `ui-menu__item`），不另造皮肤；
 * 差别只在打开方式与定位：右键菜单是 fixed 定位到指针坐标，并用 role="menu" 声明。
 *
 * 焦点契约：打开时把焦点送到第一项；方向键/Home/End 在可用项间移动；Esc 或选中后
 * 把焦点还给打开前的活动元素（若仍连接）。右键目标本身通常不可聚焦，因此不能假设
 * 「触发器」就是焦点归还点。
 */
export interface ContextMenuAction {
  readonly key: string;
  readonly label: ReactNode;
  readonly icon?: LucideIcon;
  readonly onSelect?: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly testId?: string;
}

export type ContextMenuEntry = ContextMenuAction | { readonly separator: true; readonly key?: string };

export interface ContextMenuProps {
  /** 可访问名称，同时用于 aria-label。 */
  readonly label: string;
  readonly items: readonly ContextMenuEntry[];
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly testId?: string;
}

const isAction = (entry: ContextMenuEntry): entry is ContextMenuAction => !("separator" in entry);

export default function ContextMenu({ label, items, children, disabled = false, className, testId }: ContextMenuProps) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const focusBeforePointer = useRef<HTMLElement | null>(null);

  const close = useCallback((restore = true) => {
    setPoint(null);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (restore && target?.isConnected) target.focus({ preventScroll: true });
  }, []);

  const open = (event: React.MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    // 右键点空白处会先把焦点移回 body（mousedown 的默认动作），所以必须在 mousedown
    // 阶段记下打开前的活动元素；键盘 ContextMenu 键没有指针，退回当前 activeElement。
    const remembered = focusBeforePointer.current;
    focusBeforePointer.current = null;
    const active = remembered?.isConnected === true ? remembered : document.activeElement;
    returnFocus.current = active instanceof HTMLElement ? active : null;
    setPoint({ x: event.clientX, y: event.clientY });
  };

  // 打开后：先把菜单夹进视口（右下角右键时不能溢出），再把焦点送到第一项。
  useLayoutEffect(() => {
    if (point === null) return;
    const panel = menu.current;
    if (panel === null) return;
    const rect = panel.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - rect.width - margin;
    const maxY = window.innerHeight - rect.height - margin;
    setPoint((current) => {
      if (current === null) return null;
      const x = Math.min(Math.max(margin, current.x), Math.max(margin, maxX));
      const y = Math.min(Math.max(margin, current.y), Math.max(margin, maxY));
      // 位置没变必须返回同一个对象：否则 setState → 重渲染 → layout effect → setState 会无限循环。
      return current.x === x && current.y === y ? current : { x, y };
    });
  }, [point]);

  useEffect(() => {
    if (point === null) return;
    const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("[role=\"menuitem\"]:not(:disabled)") ?? []);
    items()[0]?.focus({ preventScroll: true });

    const onPointerDown = (event: PointerEvent) => {
      if (menu.current?.contains(event.target as Node)) return;
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // 组词期间的按键属于输入法（与 Menu/Tabs 同一口径）。
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key === "Tab") { close(false); return; }
      // Enter/Space 显式落到当前项：WebView2 与读屏的合成点击并不总等价于原生按钮默认行为，
      // preventDefault 后手动 click 也不会双重触发。
      if ((event.key === "Enter" || event.key === " ") && document.activeElement instanceof HTMLButtonElement && menu.current?.contains(document.activeElement)) {
        event.preventDefault();
        document.activeElement.click();
        return;
      }
      const list = items();
      if (list.length === 0) return;
      const current = list.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowDown") { event.preventDefault(); list[(current + 1 + list.length) % list.length]?.focus(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); list[(current - 1 + list.length) % list.length]?.focus(); }
      else if (event.key === "Home") { event.preventDefault(); list[0]?.focus(); }
      else if (event.key === "End") { event.preventDefault(); list.at(-1)?.focus(); }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [point, close]);

  return <>
    <div
      className={cn("ui-context-menu-host", className)}
      data-testid={testId}
      onMouseDown={(event) => {
        if (event.button !== 2) return;
        focusBeforePointer.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }}
      onContextMenu={open}
    >{children}</div>
    {point === null ? null : createPortal(
      <div
        ref={menu}
        className="ui-menu__panel ui-context-menu"
        role="menu"
        aria-label={label}
        style={{ position: "fixed", top: point.y, left: point.x }}
      >
        {items.map((entry, index) => {
          if (!isAction(entry)) return <div key={entry.key ?? `separator-${index}`} className="ui-menu__separator" role="separator" />;
          const Icon = entry.icon;
          return <button
            key={entry.key}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={entry.disabled}
            data-testid={entry.testId}
            className={cn("ui-menu__item", entry.danger && "ui-menu__item--danger")}
            onClick={() => { entry.onSelect?.(); close(); }}
          >
            {Icon ? <Icon aria-hidden="true" /> : null}
            <span className="ui-menu__item-label">{entry.label}</span>
          </button>;
        })}
      </div>,
      document.body
    )}
  </>;
}
