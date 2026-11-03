import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { Ellipsis } from "lucide-react";
import { fixtureAdapter } from "../fixtures/fixtureAdapter";
import { useRelayConnection } from "../lib/relayConnection";
import { useDetailsMenu } from "../lib/popoverMenu";
import { bottomWorkbenchNavigation, devToolsNavState, primaryWorkbenchNavigation,
  secondaryWorkNavigation, workbenchNavTargetActive, type WorkbenchNavEntry } from "../lib/workbenchNavigation";

/**
 * 标题栏横向导航（UI-NAV-01 titlebar 布局）。
 *
 * 与左侧导航栏消费同一份入口数据与同一条当前页规则（workbenchNavigation.ts），只改变展示位置。
 * 宽度自适应：按容器实测宽度从左到右尽量放下完整条目，放不下的整条折进「更多」菜单——
 * 菜单里保留图标与全名，当前页在折叠区时触发器带同一激活底色，位置状态不因折叠丢失。
 * 条目之间的空白属于窗口拖拽区（onDragBlank 由 DesktopTitleBar 传入，与标题带拖动同一处理），
 * 链接与「更多」触发器不触发拖动。
 */

/** 溢出触发器的兜底宽度：可见时以实测为准，隐藏（无溢出）时用上一次实测或这份估计。 */
const MORE_FALLBACK_WIDTH_PX = 64;

export default function TitlebarNavigation({ onDragBlank }: { onDragBlank: (event: MouseEvent<HTMLDivElement>) => void }) {
  const location = useLocation();
  const connection = useRelayConnection();
  const path = location.pathname;
  const inboxTab = path === "/tasks" && new URLSearchParams(location.search).get("tab") === "inbox";
  const chrome = useMemo(() => fixtureAdapter.getNavigationLabels(), [location.key]);

  const entries = useMemo(() => [
    ...primaryWorkbenchNavigation({
      pendingReviewCount: connection.mode === "live" ? "" : String(chrome.pendingReviewCount)
    }),
    ...secondaryWorkNavigation(),
    ...bottomWorkbenchNavigation({
      includeDevTools: import.meta.env.DEV,
      devToolsState: devToolsNavState(path, location.search, location.state)
    })
  ], [connection.mode, chrome.pendingReviewCount, path, location.search, location.state]);

  const isActive = (entry: WorkbenchNavEntry) => workbenchNavTargetActive(path, inboxTab, entry.to);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLDetailsElement | null>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const itemWidths = useRef<number[]>([]);
  const moreWidth = useRef(MORE_FALLBACK_WIDTH_PX);
  const [visibleCount, setVisibleCount] = useState(entries.length);
  useDetailsMenu(moreRef);

  /**
   * 折叠测量：条目被 display:none 后 offsetWidth 量不到，所以每次可见时把实测宽度
   * 写进缓存，隐藏项沿用缓存值——窗口从窄拖宽时被折条目仍按真实宽度参与分配，
   * 不会闪出「先全显再折叠」的抖动。分配必须把条目之间的 gap 与触发器宽度一起计入，
   * 只累加条目宽度会漏掉这两份，尾部条目会压到日期与状态簇上（1280 实测溢出 30px）。
   * jsdom 没有 ResizeObserver：保持全显初值即可。
   */
  useLayoutEffect(() => {
    const container = containerRef.current;
    const list = listRef.current;
    if (container === null || list === null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const available = container.clientWidth;
      if (available <= 0) return;
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      const widths = entries.map((_, index) => {
        const node = itemRefs.current[index];
        const measured = node === null || node.hidden ? 0 : node.offsetWidth;
        if (measured > 0) itemWidths.current[index] = measured;
        return itemWidths.current[index] ?? 0;
      });
      const moreNode = moreRef.current;
      if (moreNode !== null && !moreNode.hidden) {
        const measured = moreNode.offsetWidth;
        if (measured > 0) moreWidth.current = measured;
      }
      let used = 0;
      let count = entries.length;
      for (let index = 0; index < widths.length; index++) {
        // 行内保留的条目都要与「更多」触发器共存：还有条目会折进菜单时就预留它的宽度。
        const gapWidth = index > 0 ? gap : 0;
        const moreNeeded = index < widths.length - 1 ? moreWidth.current : 0;
        if (used + gapWidth + widths[index]! + moreNeeded > available) { count = index; break; }
        used += gapWidth + widths[index]!;
      }
      setVisibleCount(count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    // 字体就绪会改变条目实测宽度而容器宽度不变——ResizeObserver 不会为此回调，补量一次。
    void document.fonts?.ready.then(() => measure()).catch(() => undefined);
    return () => observer.disconnect();
  }, [entries]);

  const closeMoreMenu = () => { if (moreRef.current !== null) moreRef.current.open = false; };
  // 当前页落在折叠区时给触发器同一激活底色：位置状态不因条目被折叠而不可见。
  const overflowActive = entries.slice(visibleCount).some((entry) => isActive(entry));

  // 条目与「更多」之间的空白属于窗口拖拽区；链接与已展开的菜单面板不参与拖动。
  const onBlankMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest("a, summary, .titlebar-navigation__menu")) return;
    onDragBlank(event);
  };

  return <div ref={containerRef} className="titlebar-navigation" onMouseDown={onBlankMouseDown}>
    <nav ref={listRef} className="titlebar-navigation__list" aria-label="全局导航">
      {entries.map((entry, index) => {
        const active = isActive(entry);
        return <Link key={entry.label} ref={(node) => { itemRefs.current[index] = node; }}
          to={entry.to} state={entry.state} title={entry.title} hidden={index >= visibleCount}
          aria-current={active ? "page" : undefined}
          className={`titlebar-navigation__item${active ? " titlebar-navigation__item--active" : ""}`}>
          <entry.icon aria-hidden="true" /><span className="titlebar-navigation__label">{entry.label}</span>
          {entry.count && <span className="titlebar-navigation__count" aria-label={`${entry.label} ${entry.count} 项`}>{entry.count}</span>}
        </Link>;
      })}
      <details ref={moreRef} className="titlebar-navigation__more" hidden={visibleCount >= entries.length}
        data-overflow-active={overflowActive ? "true" : undefined}>
        <summary className="titlebar-navigation__item titlebar-navigation__more-trigger" aria-label="更多导航入口">
          <Ellipsis aria-hidden="true" /><span className="titlebar-navigation__label">更多</span>
        </summary>
        {/* 面板从触发器左缘向右展开：触发器左侧至少有四个常用操作键，右缘不会越出窗口；
            面板收纳所有被折叠入口，全名展示，当前页沿用同一高亮。 */}
        <div className="titlebar-navigation__menu">
          {entries.slice(visibleCount).map((entry) => {
            const active = isActive(entry);
            return <Link key={entry.label} to={entry.to} state={entry.state} title={entry.title}
              aria-current={active ? "page" : undefined}
              className={`titlebar-navigation__item titlebar-navigation__menu-item${active ? " titlebar-navigation__item--active" : ""}`}
              onClick={closeMoreMenu}>
              <entry.icon aria-hidden="true" /><span className="titlebar-navigation__label">{entry.label}</span>
              {entry.count && <span className="titlebar-navigation__count" aria-label={`${entry.label} ${entry.count} 项`}>{entry.count}</span>}
            </Link>;
          })}
        </div>
      </details>
    </nav>
  </div>;
}
