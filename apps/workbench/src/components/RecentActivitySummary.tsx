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

      {loading && !hasItems && <p className="recent-activity-note">加载中…</p>}

      {error !== null && !hasItems && (
        <p className="recent-activity-note">
          最近动态读不到。
          <button type="button" className="recent-activity-retry" onClick={refresh}>重试</button>
        </p>
      )}

      {!loading && error === null && !hasItems && <p className="recent-activity-note">还没有动态。</p>}

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
              <li key={item.id} className="recent-activity-row" data-tone={meta.tone}>
                {ref
                  ? <Link className="recent-activity-link" to={ref.target}
                      aria-label={`${activityEventSummary(item)}（${ref.label}）`}>{body}</Link>
                  : <span className="recent-activity-link recent-activity-link--static">{body}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
