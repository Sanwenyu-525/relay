import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { useDetailsMenu, useMenuDismiss } from "../lib/popoverMenu";
import { cn } from "./cn";

/**
 * 菜单与弹出层。
 *
 * 不引 Radix：项目已有一套收敛过的浮层语义（`lib/popoverMenu`）——点到外面收起、Esc 收起、
 * 同一时刻只留一个浮层、组词期间的 Esc 不吞。这些都是 2026-10-17「多菜单重叠」之后
 * 逐步补出来的真实修复，换库等于把这些行为重新实现一遍并丢失回归依据。
 * 这里只补两件它没管的事：键盘可达（menu 角色 + 首项聚焦）和外观（token）。
 */

/** 关闭最近的 details 浮层并把焦点还给触发器。菜单项不需要知道自己在哪个菜单里。 */
function closeFromItem(element: HTMLElement): void {
  const details = element.closest("details");
  if (details === null) return;
  details.open = false;
  details.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
}

export interface MenuProps {
  /** 触发器内容（图标或文字）。 */
  readonly trigger: ReactNode;
  /** 可访问名称，同时作为原生 title。 */
  readonly label: string;
  readonly children: ReactNode;
  readonly align?: "start" | "end";
  readonly triggerClassName?: string;
  readonly className?: string;
  readonly testId?: string;
}

export function Menu({ trigger, label, children, align = "start", triggerClassName, className, testId }: MenuProps) {
  const ref = useRef<HTMLDetailsElement>(null);
  useDetailsMenu(ref);

  /** 菜单项是 roving tabindex（-1）：打开后必须由脚本送焦点，否则键盘用户进不去。 */
  const items = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("[role=\"menuitem\"]:not(:disabled)") ?? []);
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open) return;
    requestAnimationFrame(() => {
      // 指针打开也把焦点送进菜单：读屏与键盘用户随后可直接用方向键，Esc 仍回 summary。
      if (ref.current?.open) items()[0]?.focus({ preventScroll: true });
    });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const list = items();
    if (list.length === 0) return;
    const current = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") { event.preventDefault(); list[(current + 1 + list.length) % list.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); list[(current - 1 + list.length) % list.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); list[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); list.at(-1)?.focus(); }
    else if (event.key === "Tab" && ref.current !== null) {
      // Tab 是离开菜单，不是继续在页面里漫游：先收起，焦点交给浏览器的下一个可聚焦元素。
      ref.current.open = false;
    }
  };

  return <details className={cn("ui-menu", className)} ref={ref} data-testid={testId} onToggle={onToggle}>
    <summary className={cn("ui-menu__trigger", triggerClassName)} aria-label={label} title={label}>{trigger}</summary>
    <div className={cn("ui-menu__panel", align === "end" && "ui-menu__panel--end")} role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>
  </details>;
}

export interface MenuItemProps {
  readonly children: ReactNode;
  readonly onSelect?: () => void;
  readonly icon?: LucideIcon;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly testId?: string;
}

export function MenuItem({ children, onSelect, icon: Icon, danger = false, disabled = false, testId }: MenuItemProps) {
  return <button
    type="button"
    role="menuitem"
    tabIndex={-1}
    className={cn("ui-menu__item", danger && "ui-menu__item--danger")}
    disabled={disabled}
    data-testid={testId}
    onClick={(event) => {
      onSelect?.();
      closeFromItem(event.currentTarget);
    }}
  >
    {Icon ? <Icon aria-hidden="true" /> : null}
    <span className="ui-menu__item-label">{children}</span>
  </button>;
}

export function MenuSeparator() {
  return <div className="ui-menu__separator" role="separator" />;
}

export interface PopoverProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 触发器由调用方渲染，必须自己带 `aria-expanded={open}`（这里不改写传入的节点）。 */
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  readonly label: string;
  readonly align?: "start" | "end";
  readonly className?: string;
  readonly testId?: string;
}

export function Popover({ open, onClose, trigger, children, label, align = "start", className, testId }: PopoverProps) {
  const root = useRef<HTMLDivElement>(null);
  useMenuDismiss(open, onClose, root);
  return <div className={cn("ui-popover", className)} ref={root} data-testid={testId}>
    {trigger}
    {open ? <div className={cn("ui-popover__panel", align === "end" && "ui-popover__panel--end")} role="dialog" aria-label={label}>
      {children}
    </div> : null}
  </div>;
}
