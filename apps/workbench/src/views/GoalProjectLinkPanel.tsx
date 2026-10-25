import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Info, Link2 } from "lucide-react";
import { createCommandId, projectGoalLinkFrom, RelayApiError, type RelayApiClient,
  type RelayProjectGoalLink, type RelayProjectListItem } from "../api/relayClient";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { describeLiveError } from "../lib/liveErrors";

/**
 * Goal↔Project 关联入口（工作台 §18.7、总纲 §0.8、LC-02）。
 *
 * 关联是**独立命令** LinkProjectGoal，不是 CreateGoal 的隐式后续：
 * 上一轮已明确「创建 Goal 不隐式关联任何 Project」，这里补的是用户想关联时的入口，
 * 不改变创建语义，也不代替用户决定哪个 Project 属于这个 Goal。
 *
 * 边界：
 * - 用既有 Project 列表与 Project 当前修订；服务端按修订做 CAS，冲突时重新读取再确认，
 *   不覆盖别人的关联变更。
 * - 已关联的 Goal 不重复提交；重复关联由服务端拒绝，前端不假装成功。
 * - 响应丢失按原 command_id 查回执，不换 ID 重发第二次关联。
 * - 关联只改 Project↔Goal 关系事实：不建 Task、不改 Project State、不触碰权限或审批。
 */

type PendingLink = {
  readonly commandId: string;
  readonly projectId: string;
  readonly expectedRevision: string;
  readonly goalId: string;
};

/** 待核对关联按 API/Workspace/Goal 作用域暂存：整页重开后仍能继续核对原 ID（#20）。 */
function linkPendingKey(client: RelayApiClient, goalId: string): string {
  return `relay:link-goal:${client.baseUrl}:${client.workspaceId}:${goalId}`;
}

function readLinkPending(key: string): PendingLink | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (typeof row.commandId !== "string" || row.commandId === "" ||
      typeof row.projectId !== "string" || row.projectId === "" ||
      typeof row.expectedRevision !== "string" || row.expectedRevision === "" ||
      typeof row.goalId !== "string" || row.goalId === "") return null;
    return { commandId: row.commandId, projectId: row.projectId,
      expectedRevision: row.expectedRevision, goalId: row.goalId };
  } catch { return null; }
}

function saveLinkPending(key: string, pending: PendingLink | null): void {
  try {
    if (pending) sessionStorage.setItem(key, JSON.stringify(pending));
    else sessionStorage.removeItem(key);
  } catch { /* 会话存储不可用只影响整页重开后的恢复；页内待核对状态不受影响。 */ }
}

/** 2xx 与回执都只说明服务端返回了一份响应；仍需和冻结的关联命令逐项对齐。 */
class LinkResponseMismatch extends Error {}

/** 401/403/404 是已确认失权或对象不存在：受保护的旧项目数据必须撤下。 */
function isScopeLost(caught: unknown): boolean {
  return caught instanceof RelayApiError &&
    (caught.problem.status === 401 || caught.problem.status === 403 || caught.problem.status === 404);
}

function verifiedLink(record: PendingLink,
  envelope: { readonly commandId: string; readonly result: Readonly<Record<string, unknown>> }): RelayProjectGoalLink {
  if (envelope.commandId !== record.commandId) {
    throw new LinkResponseMismatch("回执 command_id 与原命令不一致。");
  }
  let result: RelayProjectGoalLink;
  try { result = projectGoalLinkFrom(envelope.result); }
  catch (caught) {
    throw new LinkResponseMismatch(caught instanceof Error ? caught.message : "回执结构无效。");
  }
  if (result.projectId !== record.projectId) {
    throw new LinkResponseMismatch(`回执 Project ${result.projectId} 不是冻结的 Project ${record.projectId}。`);
  }
  if (!result.goalIds.includes(record.goalId)) {
    throw new LinkResponseMismatch(`回执关联集合不含冻结的 Goal ${record.goalId}。`);
  }
  let expectedNext: bigint | null = null;
  try { expectedNext = BigInt(record.expectedRevision) + 1n; } catch { expectedNext = null; }
  let actual: bigint | null = null;
  try { actual = BigInt(result.revision); } catch { actual = null; }
  if (expectedNext === null || actual === null || actual !== expectedNext) {
    throw new LinkResponseMismatch(`回执修订 v${result.revision} 不是原修订 v${record.expectedRevision} 推进后的下一版。`);
  }
  return result;
}

export default function GoalProjectLinkPanel({ client, goalId, goalTitle, onLinked }: {
  client: RelayApiClient; goalId: string; goalTitle: string;
  /** 关联成功后把新的 Project 修订与 Goal 集合交回调用方。 */
  onLinked?: (link: RelayProjectGoalLink) => void }) {
  const [projects, setProjects] = useState<readonly RelayProjectListItem[] | null>(null);
  /** 下一页游标（禅道 #19，DEV-0141）：来自最近一次成功读取；null 表示已读到最后。 */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [link, setLink] = useState<RelayProjectGoalLink | null>(null);
  const [pending, setPending] = useState<PendingLink | null>(null);
  const pendingRef = useRef<PendingLink | null>(null);
  const holdPending = useCallback((next: PendingLink | null) => {
    pendingRef.current = next; setPending(next);
    saveLinkPending(linkPendingKey(client, goalId), next);
  }, [client, goalId]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mayRetry, setMayRetry] = useState(false);
  const busyRef = useRef(false);
  const disposed = useRef(false);
  const scope = useRef(0);
  /** 读取代次：刷新与续页互相使对方的在途响应失效，迟到页不得串入新范围。 */
  const readToken = useRef(0);
  const moreBusyRef = useRef(false);

  useEffect(() => () => { disposed.current = true; scope.current++; }, []);

  // 待核对关联不能靠离页丢弃收口；原 ID 已按 Goal 作用域暂存（#20），离开后
  // 回到关联区仍可核对，守卫弹层据此提供离开出口。
  const guard = useRef<DraftGuard>({
    hasUnsavedChanges: () => pendingRef.current !== null,
    discard: () => {},
    pendingCommandId: () => pendingRef.current?.commandId ?? null,
    pendingRecoversAfterLeave: () => pendingRef.current !== null
  });
  useEffect(() => {
    setDraftGuard(guard.current);
    return () => clearDraftGuard(guard.current);
  }, []);

  // 整页重开或父页重新挂载后，按当前作用域恢复原待核对关联命令。
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const stored = readLinkPending(linkPendingKey(client, goalId));
    if (stored !== null && pendingRef.current === null) {
      pendingRef.current = stored; setPending(stored);
    }
  }, [client, goalId]);

  /**
   * 重新读取项目列表（首分页）。刷新会清空已加载范围与剩余游标，重读第一页；
   * 在途续页响应因读取代次变化被隔离，不得串入刷新后的列表。
   * 冲突路径要在读取后继续显示「修订已变化」的原因，因此提供 keepError。
   */
  const load = useCallback(async (keepError = false) => {
    const request = ++readToken.current;
    const scopeId = scope.current;
    if (!keepError) setError(null);
    setMoreError(null);
    try {
      const page = await client.getProjectsPage("active", null);
      if (disposed.current || scopeId !== scope.current || request !== readToken.current) return;
      setProjects(page.items);
      setNextCursor(page.nextCursor);
      moreBusyRef.current = false;
      setLoadingMore(false);
    } catch (caught) {
      if (disposed.current || scopeId !== scope.current || request !== readToken.current) return;
      setProjects(null);
      setNextCursor(null);
      moreBusyRef.current = false;
      setLoadingMore(false);
      setError(isScopeLost(caught)
        ? "项目列表当前不可读：权限或作用域已失效，不能据此关联。请核对当前工作空间与访问权限后重新读取。"
        : `项目列表本次读取失败，不能据此关联：${describeLiveError(caught).message}`);
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  /**
   * 读取后续分页（#19）：复用 getProjectsPage 既有 cursor/nextCursor，不自动循环拉全量。
   * 合并去重（按 Project id）；暂态失败保留已读列表与原游标，可在原游标重试；
   * 只读不改关联事实，待核对关联门槛不受影响；归档项目仍不在 active 列表里。
   */
  const loadMore = useCallback(async () => {
    if (projects === null || nextCursor === null || moreBusyRef.current) return;
    moreBusyRef.current = true;
    const request = ++readToken.current;
    const scopeId = scope.current;
    setLoadingMore(true); setMoreError(null);
    try {
      const page = await client.getProjectsPage("active", nextCursor);
      if (disposed.current || scopeId !== scope.current || request !== readToken.current) return;
      setProjects((current) => {
        if (current === null) return page.items;
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (disposed.current || scopeId !== scope.current || request !== readToken.current) return;
      if (isScopeLost(caught)) {
        // 失权后已读项目不再是可提交的当前事实：撤下列表与游标，提交入口随之消失。
        setProjects(null); setNextCursor(null); setMoreError(null);
        setError("项目列表当前不可读：权限或作用域已失效，已清除之前读到的项目。请核对当前工作空间与访问权限后重新读取。");
      } else setMoreError(`后续项目读取失败：${describeLiveError(caught).message}；已读项目与原游标保留，可重试。`);
    } finally {
      moreBusyRef.current = false;
      if (!disposed.current) setLoadingMore(false);
    }
  }, [client, nextCursor, projects]);

  /** 回执核对：只按原 command_id 读，不猜结果。 */
  const checkReceipt = useCallback(async (record: PendingLink, request: number) => {
    try {
      const receipt = await client.getCommandReceipt(record.commandId);
      if (disposed.current || request !== scope.current) return;
      if (receipt.commandType !== "LinkProjectGoal") {
        throw new LinkResponseMismatch("原回执不是本次 LinkProjectGoal。");
      }
      const next = verifiedLink(record, receipt);
      holdPending(null); setMayRetry(false); setBusy(false); setError(null);
      setLink(next); onLinked?.(next);
    } catch (caught) {
      if (disposed.current || request !== scope.current) return;
      if (caught instanceof LinkResponseMismatch) {
        setError(`关联回执与冻结请求不匹配：${caught.message}已保留原 command_id，不宣布成功。`);
      } else if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        // 回执 404 是「原命令未找到」，不是项目列表失权；已读项目必须保留，才可按原 ID 原样重试。
        setMayRetry(true);
        setError("服务端明确未找到原命令；只能用原 command ID、原 Project 与原修订重试。");
      } else if (isScopeLost(caught)) {
        // 回执读取本身失权时，已读项目同样不再可信；原待核对命令必须保留，不能换 ID 重发。
        setProjects(null); setNextCursor(null);
        setError("关联回执当前不可读：权限或作用域已失效，已清除之前读到的项目；待核对命令仍保留原 command_id。");
      } else setError(`关联结果仍不可核对；请保留原 command_id，不能重复关联。${describeLiveError(caught).message}`);
    } finally {
      if (!disposed.current && request === scope.current) setBusy(false);
    }
  }, [client, holdPending, onLinked]);

  const send = useCallback(async (record: PendingLink, request: number) => {
    if (disposed.current || request !== scope.current) return;
    setError(null); setMayRetry(false); setBusy(true);
    try {
      const envelope = await client.linkProjectGoal({ projectId: record.projectId,
        commandId: record.commandId, expectedRevision: record.expectedRevision, goalId: record.goalId });
      const result = verifiedLink(record, envelope);
      holdPending(null); setBusy(false); setLink(result); onLinked?.(result);
    } catch (caught) {
      if (disposed.current || request !== scope.current) return;
      if (caught instanceof LinkResponseMismatch) {
        // 错配不宣布成功、不清 pending、不自动重发；只能由用户按原 ID 查回执或原样重试。
        setBusy(false);
        setError(`关联响应与冻结请求不匹配：${caught.message}已保留原 command_id，不宣布成功。`);
        return;
      }
      if (caught instanceof RelayApiError && caught.problem.code === "REVISION_CONFLICT") {
        // Project 修订变了：重新读取，让用户按新事实重新确认，不覆盖他人变更。
        holdPending(null); setBusy(false);
        setError(`Project 修订已变化${caught.problem.actualRevision ? `（当前 v${caught.problem.actualRevision}）` : ""}；已重新读取项目，请再次确认关联。`);
        await load(true);
        return;
      }
      // 明确的业务拒绝可以直接再发起：INVALID_TRANSITION 与 REVISION_CONFLICT 都是 409，
      // 不能一并当成「结果不明」——那会让用户以为关联命令待核对，而实际上什么都没关联。
      if (caught instanceof RelayApiError && caught.problem.code === "INVALID_TRANSITION") {
        holdPending(null); setBusy(false);
        setError(describeLiveError(caught).message);
        return;
      }
      if (caught instanceof RelayApiError && caught.problem.status < 500 &&
          caught.problem.code !== "COMMAND_ID_REUSED") {
        holdPending(null); setBusy(false);
        setError(describeLiveError(caught).message);
      } else {
        setError("关联提交结果不明；正在查询原 command_id 回执，不能重复关联。");
        await checkReceipt(record, request);
      }
    }
  }, [checkReceipt, client, holdPending, load, onLinked]);

  async function submit() {
    // 原关联命令未收口前，普通确认不得开始新命令（#20）：拒绝发生在 handler，
    // 按钮保持可用（不置灰），冻结的原 ID/原 Project/原修订不受改选影响。
    if (pendingRef.current !== null) {
      setError("已有待核对的关联命令（见下方原 command ID）；核对回执或原样重试收口前，不会发出第二条关联命令。");
      return;
    }
    // 同步闸：busy 状态在同一 tick 内尚未生效，靠它防不住双击提交出两条命令。
    if (busyRef.current || selectedId === "" || projects === null) return;
    const project = projects.find((item) => item.id === selectedId);
    if (project === undefined) return;
    busyRef.current = true;
    const request = ++scope.current;
    const record: PendingLink = { commandId: createCommandId(), projectId: project.id,
      expectedRevision: project.revision, goalId };
    holdPending(record); setBusy(true); setLink(null);
    try { await send(record, request); } finally { busyRef.current = false; }
  }

  if (link !== null) return <section className="surface-panel" data-testid="goal-link-result">
    <h2><Link2 aria-hidden="true" />已关联</h2>
    <p data-testid="goal-link-receipt">Goal {goalId}（{goalTitle}）已关联到 Project {link.projectId}
      ，Project 修订 v{link.revision}，该 Project 当前关联 {link.goalIds.length} 个 Goal。</p>
    <p className="helper-text"><Info aria-hidden="true" />关联只登记 Project↔Goal 关系；
      它不会建立任务、改变 Project State，也不会替你决定下一步。</p>
    <div className="form-actions">
      <Link className="primary-button" data-testid="goal-link-open-project" to={`/projects/${link.projectId}`}>打开项目</Link>
      <button className="secondary-button" type="button" data-testid="goal-link-another"
        onClick={() => { setLink(null); setSelectedId(""); }}>再关联一个项目</button>
    </div>
  </section>;

  return <section className="surface-panel" data-testid="goal-link-panel">
    <h2><Link2 aria-hidden="true" />把这个目标关联到项目</h2>
    <p className="helper-text">关联是独立命令，单独确认。Goal 可以先存在而不属于任何项目；
      只有你在这里选定后，Project 才会把这个目标计入自己的范围。</p>
    {projects === null ? <p className="warning-callout" data-testid="goal-link-projects-failed">
      项目列表本次读取失败，不能据此关联。<button className="secondary-button" type="button"
        data-testid="goal-link-reload" onClick={() => void load()}>重新读取</button></p> : <>
      <label className="field"><span className="field-label">选择项目</span>
        <select name="goal-link-project" data-testid="goal-link-project" value={selectedId} disabled={busy}
          onChange={(event) => setSelectedId(event.target.value)}>
          <option value="">选择要关联的项目</option>
          {projects.map((project) => <option key={project.id} value={project.id}>
            {project.title} · 修订 v{project.revision}</option>)}
        </select>
        <small className="helper-text">只列进行中的项目；已归档项目不在这里关联。</small></label>
      <div className="form-actions">
        <button className="primary-button" type="button" data-testid="goal-link-submit"
          disabled={busy || selectedId === ""} onClick={() => void submit()}>{busy ? "正在关联" : "确认关联"}</button>
        <button className="secondary-button" type="button" data-testid="goal-link-refresh"
          disabled={busy} onClick={() => void load()}>刷新项目列表</button>
      </div>
      {nextCursor !== null && <div className="form-actions">
        <button className="secondary-button" type="button" data-testid="goal-link-more" disabled={loadingMore}
          onClick={() => void loadMore()}>{loadingMore ? "正在读取后续项目" : "加载更多项目"}</button>
        <small className="helper-text">还有未读的进行中项目；逐页读取，不自动拉全量。</small>
      </div>}
      {moreError && <p className="action-error" role="alert" data-testid="goal-link-more-error">{moreError}</p>}
      <p className="helper-text" data-testid="goal-link-page-state">
        {nextCursor !== null
          ? `已列出前 ${projects.length} 个进行中的项目，仍有后续页未读。`
          : `已列出全部 ${projects.length} 个进行中的项目。`}
        只列进行中的项目；已归档项目不在这里关联。
      </p>
    </>}
    {error && <p className="action-error" role="alert" data-testid="goal-link-error">{error}</p>}
    {pending !== null && <div className="warning-callout" data-testid="goal-link-pending">
      <strong>关联命令待核对</strong>
      <p>原 command ID：{pending.commandId} · Project {pending.projectId} · 基于修订 v{pending.expectedRevision}。核对前不会发出第二条关联命令。</p>
      <button className="secondary-button" type="button" data-testid="goal-link-receipt" disabled={busy}
        onClick={() => { const request = scope.current; setBusy(true); void checkReceipt(pending, request); }}>查询原命令回执</button>
      {mayRetry && <button className="secondary-button" type="button" data-testid="goal-link-retry" disabled={busy}
        onClick={() => { const request = ++scope.current; setBusy(true); void send(pending, request); }}>用原 ID 和原修订重试</button>}
    </div>}
  </section>;
}
