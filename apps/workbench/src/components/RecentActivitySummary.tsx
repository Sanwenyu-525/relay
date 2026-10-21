import { Link } from "react-router-dom";
import { Clock } from "lucide-react";
import type { RelayApiClient, RelayActivityItem } from "../api/relayClient";
import { useActivities } from "../lib/useActivities";
import {
  activityActorLabels, activityCategoryMeta, activityEventCategory, activityEventSummary,
  activityRefLabels, activityRefLinkLabels, activityRefTarget
} from "../lib/labels";
import "./RecentActivitySummary.css";

/** 相对时间：最近用「刚刚 / N 分钟前 / N 小时前 / N 天前」，更早回退到月日。 */
function relativeTime(utc: string): string {
  const then = Date.parse(utc);
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const minute = 60_000, hour = 60 * minute, day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(then));
}

/** 取第一个能直达的引用作为整行跳转目标（其余引用不展开，保持汇总紧凑）。 */
function primaryRef(item: RelayActivityItem): { readonly target: string; readonly label: string } | null {
  for (const ref of item.entityRefs) {
    const target = activityRefTarget(ref.kind, ref.id);
    if (target === null) continue;
    const label = activityRefLinkLabels[ref.kind] ?? `打开${activityRefLabels[ref.kind]}`;
    return { target, label };
  }
  return null;
}

export function RecentActivitySummary({ client }: { client: RelayApiClient }) {
  // 只取 4 条：两列排布正好 2×2，把纵向空间还给欢迎页的 logo 与快捷语；其余走「查看全部」。
  /**
   * 高度恒定（2026-10-20 用户截图指认「新建会话按钮页面也会抖一下」）：这个区块在新对话
   * 欢迎屏里位于输入卡正上方，旧实现加载中只有一行「加载中…」，4 条动态到达后长成两列列表，
   * 把细条与输入卡推着下移——用户读成页面抖一下。现在加载中即渲染与真实行同构的 2×2 骨架，
   * 数据到达原位替换、行数不足补等格占位，空态与错误态用居中覆层盖住骨架只换文案：
   * 三种状态同高，输入卡不再移动。
   */
  const { items, loading, error, stale, refresh } = useActivities(client, {}, 4);
  const hasItems = items.length > 0;

  return (
    <section className="recent-activity" data-testid="recent-activity">
      <header className="recent-activity-head">
        <Clock className="recent-activity-head-icon" aria-hidden="true" />
        <h2 className="recent-activity-title">最近动态</h2>
        {stale
          ? <button type="button" className="recent-activity-retry" onClick={refresh}>更新失败 · 重试</button>
          : hasItems ? <Link className="recent-activity-all" to="/activities">查看全部 ›</Link> : null}
      </header>

      <div className="recent-activity-body">
        {hasItems && (
          <ul className="recent-activity-list" data-testid="recent-activity-list">
            {items.map((item) => {
              const meta = activityCategoryMeta[activityEventCategory(item.eventType)];
              const ref = primaryRef(item);
              const body = (
                <>
                  <span className="recent-activity-dot" aria-hidden="true" />
                  <span className="recent-activity-kind">{meta.chipShort}</span>
                  <span className="recent-activity-copy">
                    <span className="recent-activity-label">{activityEventSummary(item)}</span>
                    <span className="recent-activity-time">
                      {activityActorLabels[item.actorKind]} · {relativeTime(item.createdAt)}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={item.id} className="recent-activity-row" data-testid="recent-activity-row" data-tone={meta.tone}>
                  {ref
                    ? <Link className="recent-activity-link" to={ref.target}
                        aria-label={`${activityEventSummary(item)}（${ref.label}）`}>{body}</Link>
                    : <span className="recent-activity-link recent-activity-link--static">{body}</span>}
                </li>
              );
            })}
            {/* 行数不足 4 时补等格占位：见组件头部注释——这个区块在输入卡正上方，
                加载中（2×2 骨架）→ 就绪之间的高度变化会把细条与输入卡推着走。 */}
            {Array.from({ length: Math.max(0, 4 - items.length) }, (_, index) => (
              <li key={`filler-${index}`} className="recent-activity-row" data-testid="recent-activity-filler" aria-hidden="true" />
            ))}
          </ul>
        )}

        {!hasItems && (
          <ul className="recent-activity-list recent-activity-list--skeleton" aria-hidden="true">
            {Array.from({ length: 4 }, (_, index) => (
              <li key={`skeleton-${index}`} className="recent-activity-row" data-testid="recent-activity-skeleton">
                <span className="recent-activity-link recent-activity-link--static">
                  <span className="recent-activity-dot recent-activity-dot--skeleton" />
                  <span className="recent-activity-kind recent-activity-kind--skeleton" />
                  <span className="recent-activity-copy">
                    <span className="recent-activity-label recent-activity-label--skeleton">占位</span>
                    <span className="recent-activity-time recent-activity-time--skeleton">占位</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {!hasItems && !loading && (
          <p className="recent-activity-note recent-activity-note--overlay">
            {error !== null ? <>
              最近动态读不到。
              <button type="button" className="recent-activity-retry" onClick={refresh}>重试</button>
            </> : "还没有动态。"}
          </p>
        )}
      </div>
    </section>
  );
}
