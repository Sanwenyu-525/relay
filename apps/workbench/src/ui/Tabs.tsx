import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "./cn";

/**
 * 页内切换条。
 *
 * 两种形态共用一个外观：
 * - **导航形态**（任一项带 `href`）：本质是链接，语义用 `nav > a[aria-current]`，
 *   不假扮 tab（路由切换会重建页面，套 `role="tabpanel"` 会承诺一个不存在的面板关系）。
 * - **选择形态**（无 `href`）：`role="tablist"`，方向键在选项卡间移动并激活，Home/End 到两端。
 *
 * 外观只有一套 `.ui-tabs`，替代页面上各自拼的 `.subnav` / `.skill-tabs` / `.pv-filter` 三种写法。
 */
export interface TabItem {
  readonly key: string;
  readonly label: ReactNode;
  /** 有 href 时渲染成链接（导航形态）。 */
  readonly href?: string;
  /** 计数或状态，靠右显示。 */
  readonly badge?: ReactNode;
  readonly disabled?: boolean;
  readonly testId?: string;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  /** 当前选中项的 key；导航形态可省略（由当前路由决定 aria-current）。 */
  readonly value?: string;
  readonly onChange?: (key: string) => void;
  readonly label: string;
  readonly className?: string;
  readonly testId?: string;
}

export default function Tabs({ items, value, onChange, label, className, testId }: TabsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const navigation = items.some((item) => item.href !== undefined);

  if (navigation) {
    return <nav className={cn("ui-tabs", className)} aria-label={label} data-testid={testId}>
      {items.map((item) => {
        const active = item.key === value;
        return <Link
          key={item.key}
          to={item.href ?? "#"}
          className={cn("ui-tabs__item", active && "is-active")}
          aria-current={active ? "page" : undefined}
          data-testid={item.testId}
        >
          {item.label}
          {item.badge === undefined ? null : <span className="ui-tabs__badge">{item.badge}</span>}
        </Link>;
      })}
    </nav>;
  }

  const enabled = items.filter((item) => item.disabled !== true);
  const move = (key: string, delta: number) => {
    const index = enabled.findIndex((item) => item.key === key);
    if (index < 0) return;
    const next = enabled[(index + delta + enabled.length) % enabled.length];
    if (next === undefined) return;
    onChange?.(next.key);
    const target = refs.current[items.findIndex((item) => item.key === next.key)];
    target?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); move(key, 1); }
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); move(key, -1); }
    else if (event.key === "Home") { event.preventDefault(); const first = enabled[0]; if (first) { onChange?.(first.key); refs.current[items.findIndex((item) => item.key === first.key)]?.focus(); } }
    else if (event.key === "End") { event.preventDefault(); const last = enabled.at(-1); if (last) { onChange?.(last.key); refs.current[items.findIndex((item) => item.key === last.key)]?.focus(); } }
  };

  return <div className={cn("ui-tabs", className)} role="tablist" aria-label={label} data-testid={testId}>
    {items.map((item, index) => {
      const active = item.key === value;
      return <button
        key={item.key}
        ref={(node) => { refs.current[index] = node; }}
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        disabled={item.disabled}
        className={cn("ui-tabs__item", active && "is-active")}
        data-testid={item.testId}
        onClick={() => onChange?.(item.key)}
        onKeyDown={(event) => onKeyDown(event, item.key)}
      >
        {item.label}
        {item.badge === undefined ? null : <span className="ui-tabs__badge">{item.badge}</span>}
      </button>;
    })}
  </div>;
}
