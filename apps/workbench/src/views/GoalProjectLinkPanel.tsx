import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Info, Link2 } from "lucide-react";
import { createCommandId, RelayApiError, type RelayApiClient,
  type RelayProjectGoalLink, type RelayProjectListItem } from "../api/relayClient";
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

export default function GoalProjectLinkPanel({ client, goalId, goalTitle, onLinked }: {
  client: RelayApiClient; goalId: string; goalTitle: string;
  /** 关联成功后把新的 Project 修订与 Goal 集合交回调用方。 */
  onLinked?: (link: RelayProjectGoalLink) => void }) {
  const [projects, setProjects] = useState<readonly RelayProjectListItem[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [link, setLink] = useState<RelayProjectGoalLink | null>(null);
  const [pending, setPending] = useState<PendingLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mayRetry, setMayRetry] = useState(false);
  const busyRef = useRef(false);
  const disposed = useRef(false);
  const scope = useRef(0);

  useEffect(() => () => { disposed.current = true; scope.current++; }, []);

  /**
   * 重新读取项目列表。默认会清空既有错误；冲突路径要在读取后继续显示
   * 「修订已变化」的原因，因此提供 keepError，避免刚写好的原因被自己抹掉。
   */
  const load = useCallback(async (keepError = false) => {
    const request = scope.current;
    if (!keepError) setError(null);
    try {
      const page = await client.getProjectsPage("active", null);
      if (disposed.current || request !== scope.current) return;
      setProjects(page.items);
    } catch (caught) {
      if (disposed.current || request !== scope.current) return;
      setProjects(null);
      setError(`项目列表本次读取失败，不能据此关联：${describeLiveError(caught).message}`);
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  /** 回执核对：只按原 command_id 读，不猜结果。 */
  const checkReceipt = useCallback(async (record: PendingLink, request: number) => {
    try {
      const receipt = await client.getCommandReceipt(record.commandId);
      if (disposed.current || request !== scope.current) return;
      if (receipt.commandId !== record.commandId || receipt.commandType !== "LinkProjectGoal") {
        throw new Error("原回执不是本次 LinkProjectGoal。");
      }
      const raw = receipt.result.goal_ids;
      if (receipt.result.project_id !== record.projectId || !Array.isArray(raw) ||
          raw.some((id) => typeof id !== "string") || typeof receipt.result.revision !== "string") {
        throw new Error("关联回执与原命令不匹配。");
      }
      const next: RelayProjectGoalLink = { projectId: receipt.result.project_id,
        revision: receipt.result.revision, goalIds: raw as string[] };
      setPending(null); setMayRetry(false); setBusy(false); setError(null);
      setLink(next); onLinked?.(next);
    } catch (caught) {
      if (disposed.current || request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(true);
        setError("服务端明确未找到原命令；只能用原 command ID、原 Project 与原修订重试。");
      } else setError(`关联结果仍不可核对；请保留原 command_id，不能重复关联。${describeLiveError(caught).message}`);
    } finally {
      if (!disposed.current && request === scope.current) setBusy(false);
    }
  }, [client, onLinked]);

  const send = useCallback(async (record: PendingLink, request: number) => {
    if (disposed.current || request !== scope.current) return;
    setError(null); setMayRetry(false); setBusy(true);
    try {
      const result = await client.linkProjectGoal({ projectId: record.projectId,
        commandId: record.commandId, expectedRevision: record.expectedRevision, goalId: record.goalId });
      setPending(null); setBusy(false); setLink(result); onLinked?.(result);
    } catch (caught) {
      if (disposed.current || request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "REVISION_CONFLICT") {
        // Project 修订变了：重新读取，让用户按新事实重新确认，不覆盖他人变更。
        setPending(null); setBusy(false);
        setError(`Project 修订已变化${caught.problem.actualRevision ? `（当前 v${caught.problem.actualRevision}）` : ""}；已重新读取项目，请再次确认关联。`);
        await load(true);
        return;
      }
      // 明确的业务拒绝可以直接再发起：INVALID_TRANSITION 与 REVISION_CONFLICT 都是 409，
      // 不能一并当成「结果不明」——那会让用户以为关联命令待核对，而实际上什么都没关联。
      if (caught instanceof RelayApiError && caught.problem.code === "INVALID_TRANSITION") {
        setPending(null); setBusy(false);
        setError(describeLiveError(caught).message);
        return;
      }
      if (caught instanceof RelayApiError && caught.problem.status < 500 &&
          caught.problem.code !== "COMMAND_ID_REUSED") {
        setPending(null); setBusy(false);
        setError(describeLiveError(caught).message);
      } else {
        setError("关联提交结果不明；正在查询原 command_id 回执，不能重复关联。");
        await checkReceipt(record, request);
      }
    }
  }, [checkReceipt, client, load, onLinked]);

  async function submit() {
    // 同步闸：busy 状态在同一 tick 内尚未生效，靠它防不住双击提交出两条命令。
    if (busyRef.current || selectedId === "" || projects === null) return;
    const project = projects.find((item) => item.id === selectedId);
    if (project === undefined) return;
    busyRef.current = true;
    const request = ++scope.current;
    const record: PendingLink = { commandId: createCommandId(), projectId: project.id,
      expectedRevision: project.revision, goalId };
    setPending(record); setBusy(true); setLink(null);
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
