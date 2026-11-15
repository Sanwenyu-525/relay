import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "./cn";

/**
 * 页内切换条。
 *
 * 两种形态共用一个外观：
 * - **导航形态**（任一项带 `href`）：本质是链接，语义用 `nav > a[aria-current]`，
 *   不假扮 tab（路由切换会重建页面，套 `role="tabpanel"` 会承诺一个不存在的面板关系）。
 * - **选择形态**（无 `href`）：`role="tablist"`，方向键在选项卡间移动并激活，Home/End 到两端。
 *
 * ## 导航形态的激活判定（UI-UNIFY-03）
 *
 * `value` 可选：
 * - 省略时按当前路由自动判定（`resolveNavigationKey`）。先比路径：精确匹配优先，
 *   其次是「当前路径以该项路径为前缀」的子路由；再比查询参数：带参数的项要求每个
 *   参数都与当前 URL 一致。当前 URL 有查询参数且某项带同名参数时，该参数项优先于
 *   无参数的「全部」项——否则 `/tasks?tab=inbox` 会同时点亮「全部」与「收件箱」。
 * - 显式传入时以 `value` 为准（兼容既有调用方，也给「路由无法表达」的场景留出口）。
 * - `aria-current="page"` 只出现在真正激活且未禁用的项上。
 *
 * 禁用导航项渲染为不可聚焦的 `span[role="link"][aria-disabled="true"]`，不挂 Link、
 * 不响应 Enter；不靠 `pointer-events: none` 兜底。
 *
 * ## 选择形态键盘
 *
 * 采用 WAI-ARIA APG Tabs 的**自动激活**：焦点移动即选中。理由是这些页签的面板都在
 * 同一页面内已挂载，切换只改变本地显示状态（最重的任务详情产物页签也只是同页异步读取），
 * 不存在「切换成本高、需要用户先确认再加载」的场景；手动激活会让每个页签多一次 Enter。
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
  /** 页面既有皮肤类名（如 `subnav-item`）；选中时自动追加 `--active`，供迁移期保持像素不变。 */
  readonly className?: string;
  /** 选择形态下作为 tab 元素的 id（面板可用 aria-labelledby 指向它）。 */
  readonly id?: string;
  /** 选择形态下 tab 控制的 panel id（存在面板节点时填写）。 */
  readonly ariaControls?: string;
}

export type TabsVariant = "pill" | "page";

export interface TabsProps {
  readonly items: readonly TabItem[];
  /** 当前选中项的 key；导航形态可省略（由当前路由决定 aria-current）。 */
  readonly value?: string;
  readonly onChange?: (key: string) => void;
  readonly label: string;
  /** pill = 面板内切换（默认）；page = 页面级导航条，沿用既有 subnav/skill-tabs 几何。 */
  readonly variant?: TabsVariant;
  readonly className?: string;
  readonly testId?: string;
}

interface RouteLike {
  readonly pathname: string;
  readonly search: string;
}

interface NavigationCandidate {
  readonly key: string;
  readonly score: number;
  readonly hasSearch: boolean;
}

/**
 * 在候选导航项中选出唯一激活项。导出是为了单测能直接钉住匹配规则，
 * 不必通过渲染结果的间接信号推断。
 */
export function resolveNavigationKey(items: readonly TabItem[], location: RouteLike, explicitValue?: string): string | null {
  if (explicitValue !== undefined) {
    const explicit = items.find((item) => item.key === explicitValue);
    return explicit !== undefined && explicit.disabled !== true ? explicit.key : null;
  }
  const current = new URL(location.pathname + location.search, "http://relay.local");
  const candidates: NavigationCandidate[] = [];
  items.forEach((item) => {
    if (item.href === undefined || item.disabled === true) return;
    const target = new URL(item.href, "http://relay.local");
    let pathScore = 0;
    if (target.pathname === current.pathname) pathScore = 1000 + target.pathname.length;
    else if (target.pathname !== "/" && current.pathname.startsWith(target.pathname.endsWith("/") ? target.pathname : `${target.pathname}/`)) {
      pathScore = 100 + target.pathname.length;
    }
    if (pathScore === 0) return;
    let searchScore = 0;
    for (const [name, value] of target.searchParams) {
      if (current.searchParams.get(name) !== value) return;
      searchScore += 1;
    }
    candidates.push({ key: item.key, score: pathScore + (searchScore > 0 ? 50 + searchScore : 0), hasSearch: searchScore > 0 });
  });
  if (candidates.length === 0) return null;
  // 当前 URL 带查询参数时，带参数的候选项优先；没有任何参数项匹配时再落到「全部」。
  const searchAware = candidates.filter((candidate) => candidate.hasSearch);
  const pool = current.searchParams.size > 0 && searchAware.length > 0 ? searchAware : candidates;
  pool.sort((left, right) => right.score - left.score);
  return pool[0]?.key ?? null;
}

function itemClassName(item: TabItem, active: boolean): string {
  return cn("ui-tabs__item", item.className, active && "is-active", active && item.className !== undefined && `${item.className}--active`, item.disabled === true && "is-disabled");
}

function TabContent({ item }: { readonly item: TabItem }) {
  return <>
    {item.label}
    {item.badge === undefined ? null : <>{" "}<span className="ui-tabs__badge">{item.badge}</span></>}
  </>;
}

function NavigationTabs({ items, value, label, variant, className, testId }: TabsProps) {
  const location = useLocation();
  const active = resolveNavigationKey(items, location, value);
  return <nav
    className={cn("ui-tabs", variant === "page" && "ui-tabs--page", className)}
    aria-label={label}
    data-testid={testId}
  >
    {items.map((item) => {
      if (item.href === undefined || item.disabled === true) {
        // 禁用项不渲染链接：没有 href 就没有原生跳转，也不进入 Tab 顺序。
        return <span
          key={item.key}
          // role=link + aria-disabled 让读屏知道「这里是一个当前不可用的导航入口」，
          // 而不是把它读成普通文本；tabIndex=-1 保证键盘不会聚焦到一个无法激活的项。
          role="link"
          aria-disabled={item.disabled === true || undefined}
          tabIndex={-1}
          className={itemClassName(item, false)}
          data-testid={item.testId}
        ><TabContent item={item} /></span>;
      }
      const isActive = item.key === active;
      return <Link
        key={item.key}
        to={item.href}
        className={itemClassName(item, isActive)}
        aria-current={isActive ? "page" : undefined}
        data-testid={item.testId}
      ><TabContent item={item} /></Link>;
    })}
  </nav>;
}

export default function Tabs({ items, value, onChange, label, variant = "pill", className, testId }: TabsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const navigation = items.some((item) => item.href !== undefined);

  if (navigation) {
    return <NavigationTabs items={items} value={value} onChange={onChange} label={label} variant={variant} className={className} testId={testId} />;
  }

  const enabled = items.filter((item) => item.disabled !== true);
  const validValue = value !== undefined && enabled.some((item) => item.key === value) ? value : null;
  // 受控值不合法（指向已删除/禁用的项）时，不伪造 aria-selected；但要让 Tab 键仍能进入
  // 选项卡组，所以把 roving tabindex 的 0 位让给第一个可用项。
  const focusKey = validValue ?? enabled[0]?.key ?? null;

  const focusItem = (key: string) => {
    const item = items.find((candidate) => candidate.key === key);
    if (item === undefined || item.disabled === true) return;
    onChange?.(key);
    refs.current[items.findIndex((candidate) => candidate.key === key)]?.focus();
  };

  const move = (key: string, delta: number) => {
    const index = enabled.findIndex((item) => item.key === key);
    if (index < 0 || enabled.length === 0) return;
    const next = enabled[(index + delta + enabled.length) % enabled.length];
    if (next === undefined) return;
    focusItem(next.key);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    // 组词期间按键归输入法：中文/日文/韩文在候选词选择时也会用到方向键。
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); move(key, 1); }
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); move(key, -1); }
    else if (event.key === "Home") {
      event.preventDefault();
      const first = enabled[0];
      if (first !== undefined) focusItem(first.key);
    } else if (event.key === "End") {
      event.preventDefault();
      const last = enabled.at(-1);
      if (last !== undefined) focusItem(last.key);
    }
  };

  return <div className={cn("ui-tabs", variant === "page" && "ui-tabs--page", className)} role="tablist" aria-label={label} data-testid={testId}>
    {items.map((item, index) => {
      const active = item.key === validValue;
      return <button
        key={item.key}
        ref={(node) => { refs.current[index] = node; }}
        type="button"
        role="tab"
        id={item.id}
        aria-controls={item.ariaControls}
        aria-selected={active}
        aria-disabled={item.disabled === true || undefined}
        tabIndex={item.key === focusKey ? 0 : -1}
        disabled={item.disabled === true}
        className={itemClassName(item, active)}
        data-testid={item.testId}
        onClick={() => { if (item.disabled !== true) onChange?.(item.key); }}
        onKeyDown={(event) => onKeyDown(event, item.key)}
      >
        <TabContent item={item} />
      </button>;
    })}
  </div>;
}
