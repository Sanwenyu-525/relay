import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus, RotateCcw, Target } from "lucide-react";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import type { RelayApiClient, RelayGoalRecord } from "../api/relayClient";
import { RelayApiError } from "../api/relayClient";
import { goalStatusLabels } from "../lib/labels";
import { describeLiveError } from "../lib/liveErrors";
import { useRelayConnection } from "../lib/relayConnection";

/**
 * 正式 Goal 列表（Workspace 级事实）。
 *
 * 只读既有 `GET /goals`：不创建 Project/Task/Run，也不把列表里的数量当成全量结论。
 * ACTIVE / ARCHIVED / ALL 是服务端支持的三个范围；游标由服务端编码，客户端只原样回传。
 */

type GoalScope = "active" | "archived" | "all";
const scopes: readonly { readonly key: GoalScope; readonly label: string }[] = [
  { key: "active", label: "进行中" },
  { key: "archived", label: "已归档" },
  { key: "all", label: "全部" }
];

function scopeFromQuery(raw: string | null): GoalScope {
  return raw === "archived" || raw === "all" ? raw : "active";
}

function isScopeLost(caught: unknown): boolean {
  return caught instanceof RelayApiError &&
    (caught.problem.status === 401 || caught.problem.status === 403 || caught.problem.status === 404);
}

export default function GoalListView() {
  const [query] = useSearchParams();
  const scope = scopeFromQuery(query.get("scope"));
  const connection = useRelayConnection();
  return connection.client
    ? <LiveGoalList key={`${connection.epoch}:${scope}`} client={connection.client} scope={scope} />
    : <section className="page-state pv-page" data-testid="goal-list-fixture-gap">
      <p className="eyebrow"><Target aria-hidden="true" />Goals</p>
      <h1>示例模式没有正式 Goal 列表</h1>
      <p>Goal 是工作空间级事实，需要连接本机 API 才能读取。示例模式不生成目标、关联或进度。</p>
      <Link className="secondary-button" to="/projects">返回项目</Link>
    </section>;
}

function LiveGoalList({ client, scope }: { client: RelayApiClient; scope: GoalScope }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<readonly RelayGoalRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const disposed = useRef(false);
  const busy = useRef(false);

  const loadPage = useCallback(async (cursor: string | null) => {
    if (busy.current) return;
    busy.current = true;
    const request = ++requestVersion.current;
    if (cursor === null) { setLoading(true); setError(null); setMoreError(null); }
    else { setLoadingMore(true); setMoreError(null); }
    try {
      const page = await client.listGoals(scope, cursor);
      if (disposed.current || request !== requestVersion.current) return;
      if (cursor === null) setItems(page.items);
      else setItems((current) => [...current,
        ...page.items.filter((item) => !current.some((seen) => seen.id === item.id))]);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (caught) {
      if (disposed.current || request !== requestVersion.current) return;
      if (cursor === null || isScopeLost(caught)) {
        // 首读失败或确认失权：没有任何可继续展示的当前事实。
        setItems([]); setNextCursor(null);
        setError(isScopeLost(caught)
          ? "目标列表当前不可读：权限或作用域已失效，已清除之前读到的目标。请核对访问权限后重新读取。"
          : `目标列表本次读取失败：${describeLiveError(caught).message}`);
      } else {
        // 暂态续页失败：已读项与原游标保留，按原游标重试。
        setMoreError(`后续目标读取失败：${describeLiveError(caught).message}`);
      }
    } finally {
      if (!disposed.current && request === requestVersion.current) {
        busy.current = false; setLoading(false); setLoadingMore(false);
      }
    }
  }, [client, scope]);

  useEffect(() => {
    disposed.current = false;
    void loadPage(null);
    return () => { disposed.current = true; requestVersion.current++; };
  }, [loadPage]);

  return <section className="skill-page projects-page pv-page" data-testid="goal-list-live">
    <div className="projects-inner">
      <PageHeader title="目标" testId="goal-list-head" overline="Goals"
        lede="目标定义预期结果、验收条件和可追溯证据；它与聊天里的自主执行目标是两套事实。"
        actions={<>
          <Link className="secondary-button" to="/projects" data-testid="goal-list-back-projects">返回项目</Link>
          <Link className="primary-button" to="/projects?view=goal" data-testid="goal-list-create"><Plus aria-hidden="true" />记录目标</Link>
        </>} />
      <nav className="skill-tabs pv-inline-filter" aria-label="目标范围">
        {scopes.map((item) => <Link key={item.key}
          className={`pv-filter skill-tab${item.key === scope ? " active skill-tab--active" : ""}`}
          aria-current={item.key === scope ? "page" : undefined}
          to={item.key === "active" ? "/goals" : `/goals?scope=${item.key}`}
          data-testid={`goal-list-scope-${item.key}`}>{item.label}</Link>)}
      </nav>
      <p className="helper-text" data-testid="goal-list-scope-note">
        当前范围：{scopes.find((item) => item.key === scope)?.label ?? scope}。
        归档保留原 Goal、项目关联与历史引用，只停止新增关联。
      </p>
      {loading ? <section className="page-state" role="status"><p>正在读取目标列表…</p></section>
        : error ? <section className="page-state page-state--error" role="alert">
          <p>{error}</p>
          <button className="secondary-button" type="button" data-testid="goal-list-reload"
            onClick={() => void loadPage(null)}><RotateCcw aria-hidden="true" />重新读取</button>
        </section>
          : items.length === 0
            ? <EmptyState icon={Target} as="h2"
              testId="goal-list-empty"
              title={scope === "archived" ? "这个范围还没有已归档的目标" : "还没有正式目标"}
              description={scope === "archived"
                ? "归档不会删除目标；没有目标归档过时，这个范围就是空的。"
                : "目标可以先独立存在，之后再关联到一个或多个项目。创建目标与建项目是两条独立命令。"}
              actions={<>
                <Link className="primary-button" to="/projects?view=goal">记录第一个目标</Link>
                <Link className="secondary-button" to="/projects">先看项目</Link>
              </>} />
            : <>
              <p className="list-footer-note" data-testid="goal-list-count">
                已加载 {items.length} 个目标{nextCursor ? " · 仍有后续页，未读部分不计入任何结论" : " · 已到列表末页"}。
              </p>
              {/* V5.28 原型目标卡：两列网格，kicker 状态 + 标题 + 说明 + 页脚时间与入口。
                  列表接口没有验收标准计数，进度行不造假数据。 */}
              <div className="pv-grid" data-testid="goal-list-items">
                {items.map((goal) => <article className="pv-goal-card" key={goal.id}
                  data-testid={`goal-list-item-${goal.id}`}>
                  <div className="pv-goal-card__top">
                    <span className={`pv-chip${goal.status === "ARCHIVED" ? " muted" : ""}`}>
                      {goalStatusLabels[goal.status] ?? goal.status}</span>
                    <small className="pv-goal-card__rev">v{goal.revision}</small>
                  </div>
                  <Link className="pv-goal-card__title" to={`/goals/${goal.id}`} data-testid={`goal-open-${goal.id}`}>
                    {goal.title}</Link>
                  <p className="pv-goal-card__desc">{goal.description || "（没有说明）"}</p>
                  <div className="pv-goal-card__footer">
                    <small>更新于 {new Date(goal.updatedAt).toLocaleString("zh-CN")}</small>
                    <Link className="pv-goal-card__open" to={`/goals/${goal.id}`}>查看目标 →</Link>
                  </div>
                </article>)}
              </div>
              {moreError && <p className="action-error" role="alert" data-testid="goal-list-more-error">
                {moreError}；已读目标与原游标保留。
                <button className="text-button" type="button" data-testid="goal-list-more-retry"
                  disabled={loadingMore} onClick={() => void loadPage(nextCursor)}>按原游标重试</button>
              </p>}
              {nextCursor && <button className="secondary-button" type="button" data-testid="goal-list-more"
                disabled={loadingMore} onClick={() => void loadPage(nextCursor)}>
                {loadingMore ? "正在加载" : "加载更多目标"}</button>}
            </>}
      <details className="page-explanation"><summary>目标与项目的关系</summary>
        <p className="helper-text">一个 Goal 可以关联多个 Project；关联与解除都是独立命令。
          关联不代表任何 Task 自动对齐该 Goal，也不改变项目阶段、执行权限或审批。</p>
      </details>
      <p className="metadata-row"><button className="text-button" type="button"
        onClick={() => navigate("/projects")}>返回项目列表</button></p>
    </div>
  </section>;
}
