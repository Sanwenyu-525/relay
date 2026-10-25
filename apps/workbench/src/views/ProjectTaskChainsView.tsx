import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { createCommandId, RelayApiError, type RelayApiClient, type RelayTaskChain,
  type RelayTaskChainAuthorization, type RelayTaskChainControl, type RelayTaskChainCreate,
  type RelayProjectState, type RelayReview, type RelayTaskDetail, type RelayTaskSummary } from "../api/relayClient";
import ProjectNav from "../components/ProjectNav";
import PageHeader from "../components/PageHeader";
import { describeLiveError } from "../lib/liveErrors";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
import { useProjectTaskPages } from "../lib/useProjectTaskPages";
import { useRelayConnection } from "../lib/relayConnection";
import "./ProjectTaskChainsView.css";

type ChainIntent =
  | { readonly kind: "CREATE"; readonly input: RelayTaskChainCreate }
  | { readonly kind: "AUTHORIZE"; readonly input: RelayTaskChainAuthorization }
  | { readonly kind: "STOP"; readonly input: RelayTaskChainControl };

const chainLabels: Record<string, string> = { DRAFT: "草稿", ACTIVE: "已授权执行", WAITING_RESUME: "等待明确继续",
  PAUSING: "正在安全停止", PAUSED: "已暂停", REVOKED: "已撤销", EXPIRED: "已到期", BLOCKED: "阻塞", COMPLETED: "已完成" };
const itemLabels: Record<string, string> = { READY: "待准入", RESERVED: "已预留", RUNNING: "Run 进行中", DELEGATED: "已委托", WAITING: "等待中",
  REVIEW: "等待 Review", COMPLETED: "已完成", FAILED: "失败", CANCELLED: "已取消", BLOCKED: "阻塞", PAUSED: "暂停" };

function recoveryKey(client: RelayApiClient, projectId: string) {
  return `relay:task-chain-command:${client.baseUrl}:${client.workspaceId}:${projectId}`;
}
function readPending(client: RelayApiClient, projectId: string): ChainIntent | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(recoveryKey(client, projectId)) ?? "null");
    if (typeof parsed !== "object" || parsed === null || !("kind" in parsed) || !("input" in parsed) ||
      !["CREATE", "AUTHORIZE", "STOP"].includes(String((parsed as { kind?: unknown }).kind))) return null;
    const input = (parsed as { input?: unknown }).input;
    return typeof input === "object" && input !== null && "commandId" in input &&
      typeof (input as { commandId?: unknown }).commandId === "string" ? parsed as ChainIntent : null;
  } catch { return null; }
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
function resultField(result: Record<string, unknown>, camel: string, snake: string): unknown {
  return result[camel] ?? result[snake];
}
function resultString(result: Record<string, unknown>, camel: string, snake: string): string {
  const value = resultField(result, camel, snake);
  if (typeof value !== "string" || value === "") throw new Error(`任务链回执缺少 ${camel} 身份。`);
  return value;
}
function declaredOutputKinds(outputs: Readonly<Record<string, unknown>> | null): readonly string[] | null {
  if (outputs === null || !Array.isArray(outputs.artifacts) || outputs.artifacts.length === 0 ||
    outputs.artifacts.some((kind) => kind !== "MARKDOWN_DOCUMENT")) return null;
  return outputs.artifacts as string[];
}
function usageValue(value: unknown): string {
  if (value === null || value === undefined) return "未知";
  return String(value);
}

export default function ProjectTaskChainsView() {
  const { id = "" } = useParams();
  const connection = useRelayConnection();
  if (!connection.client) return <section className="page-state"><p className="eyebrow">有限任务链</p>
    <h1>需要连接本机 API</h1><p>任务链必须读取真实任务、验收版本和执行记录；示例数据不会模拟授权或运行状态。</p>
    <Link className="text-link" to="/settings/connections">连接工作空间</Link></section>;
  return <LiveTaskChains key={`${connection.epoch}:${id}`} client={connection.client} projectId={id} />;
}

function LiveTaskChains({ client, projectId }: { readonly client: RelayApiClient; readonly projectId: string }) {
  const [query] = useSearchParams();
  const fromPlanId = query.get("from-plan");
  const taskPages = useProjectTaskPages(client, projectId, true, `${client.workspaceId}:${projectId}`, 20);
  const [projectTitle, setProjectTitle] = useState("");
  const [archived, setArchived] = useState(false);
  const [chains, setChains] = useState<readonly RelayTaskChain[]>([]);
  const [projectState, setProjectState] = useState<RelayProjectState | null>(null);
  const [blockerReadError, setBlockerReadError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<readonly RelayReview[]>([]);
  const [reviewsError, setReviewsError] = useState<string | null>(null);
  const [selectedChainId, setSelectedChainId] = useState("");
  const [selectedTaskIds, setSelectedTaskIds] = useState<readonly string[]>([]);
  const [taskDetails, setTaskDetails] = useState<ReadonlyMap<string, RelayTaskDetail>>(new Map());
  const [detailError, setDetailError] = useState<string | null>(null);
  const [fromPlanMessage, setFromPlanMessage] = useState<string | null>(null);
  const [chainTitle, setChainTitle] = useState("有限任务链");
  const [maxTasks, setMaxTasks] = useState("1");
  const [maxModelCalls, setMaxModelCalls] = useState("3");
  const [expiresAt, setExpiresAt] = useState(() => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString().slice(0, 16));
  const [stopReason, setStopReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<ChainIntent | null>(() => readPending(client, projectId));
  const [pendingAbsent, setPendingAbsent] = useState(false);
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const scopeVersion = useRef(0);
  const key = useMemo(() => recoveryKey(client, projectId), [client, projectId]);
  const formDraft = { chainTitle, selectedTaskIds };
  const formDraftRef = useRef(formDraft); formDraftRef.current = formDraft;
  const cleanDraft = useRef(JSON.stringify({ chainTitle: "有限任务链", selectedTaskIds: [] }));
  const guard = useRef<DraftGuard>({
    hasUnsavedChanges: () => pendingRef.current !== null || JSON.stringify(formDraftRef.current) !== cleanDraft.current,
    discard: () => { if (!pendingRef.current) { setChainTitle("有限任务链"); setSelectedTaskIds([]); } },
    pendingCommandId: () => pendingRef.current?.input.commandId ?? null,
    pendingRecoversAfterLeave: () => true
  });

  const refresh = useCallback(async () => {
    const token = ++scopeVersion.current; setError(null);
    try {
      const [project, next] = await Promise.all([client.getProject(projectId), client.getProjectTaskChains(projectId)]);
      if (token !== scopeVersion.current) return;
      setProjectTitle(project.title); setArchived(project.archivedAt !== null); setChains(next.items);
      setSelectedChainId((current) => next.items.some((chain) => chain.chainId === current) ? current : next.items[0]?.chainId ?? "");
      void client.getReviews().then((items) => { if (token === scopeVersion.current) { setReviews(items); setReviewsError(null); } })
        .catch((caught: unknown) => { if (token === scopeVersion.current) { setReviews([]); setReviewsError(describeLiveError(caught).message); } });
    } catch (caught) { if (token === scopeVersion.current) setError(describeLiveError(caught).message); }
    finally { if (token === scopeVersion.current) setLoading(false); }
  }, [client, projectId]);

  useEffect(() => { setDraftGuard(guard.current); void refresh(); return () => {
    scopeVersion.current++; clearDraftGuard(guard.current);
  }; }, [refresh]);

  useEffect(() => {
    let active = true;
    setProjectState(null); setBlockerReadError(null);
    void client.getProjectState(projectId).then((state) => {
      if (active && state.projectId === projectId) setProjectState(state);
      else if (active) setBlockerReadError("项目状态读回身份不匹配。");
    }).catch((caught: unknown) => { if (active) setBlockerReadError(describeLiveError(caught).message); });
    return () => { active = false; };
  }, [client, projectId]);

  useEffect(() => {
    let active = true;
    if (!fromPlanId) return () => { active = false; };
    void client.getPeriodPlan(fromPlanId).then((plan) => {
      if (!active) return;
      if (plan.projectId !== projectId) { setFromPlanMessage("该计划不属于当前项目，未预选任何任务。"); return; }
      const ids = plan.items.filter((item) => item.status === "ACCEPTED" && item.kind !== "DEFERRED")
        .map((item) => item.createdTaskId ?? item.taskId);
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length === 0) setFromPlanMessage("该计划没有已接受的任务项；没有自动创建或授权任务链。");
      else {
        setSelectedTaskIds(uniqueIds);
        setFromPlanMessage(`已从计划 v${plan.revision} 预选 ${uniqueIds.length} 个已接受任务。请重新核对任务、顺序及验收版本，再单独创建任务链。`);
      }
    }).catch((caught: unknown) => { if (active) setFromPlanMessage(`读取来源计划失败：${describeLiveError(caught).message}`); });
    return () => { active = false; };
  }, [client, projectId, fromPlanId]);

  useEffect(() => {
    let active = true;
    const ids = [...selectedTaskIds];
    if (ids.length === 0) { setTaskDetails(new Map()); setDetailError(null); return () => { active = false; }; }
    setDetailError(null);
    void Promise.all(ids.map(async (taskId) => [taskId, await client.getTask(taskId)] as const)).then((rows) => {
      if (active) setTaskDetails(new Map(rows));
    }).catch((caught: unknown) => { if (active) { setTaskDetails(new Map()); setDetailError(describeLiveError(caught).message); } });
    return () => { active = false; };
  }, [client, selectedTaskIds]);

  const selectedChain = chains.find((chain) => chain.chainId === selectedChainId) ?? null;
  useEffect(() => {
    if (!selectedChain) return;
    setMaxTasks(String(Math.max(1, selectedChain.taskReservations, selectedChain.items.length)));
    setMaxModelCalls(String(Math.max(3, selectedChain.callsStarted + 1, selectedChain.maxModelCalls, selectedChain.items.length)));
  }, [selectedChainId]);
  const selectedTasks = selectedTaskIds.map((id) => taskDetails.get(id)).filter((task): task is RelayTaskDetail => task !== undefined);
  const selectedTasksReady = selectedTaskIds.length > 0 && selectedTaskIds.length <= 16 &&
    projectState?.projectId === projectId && selectedTasks.length === selectedTaskIds.length && selectedTasks.every((task) => task.projectId === projectId &&
      ["INBOX", "READY"].includes(task.status) && task.executor === "HUMAN" &&
      task.acceptance.criteria.some((criterion) => criterion.required) && declaredOutputKinds(task.acceptance.expectedOutputs) !== null &&
      task.unresolvedBlockerIds.length === 0);
  const missingPrerequisite = selectedTasks.some((task, index) => task.dependencies.some((dependency) =>
    dependency.dependencyKind === "BLOCKS" && dependency.status !== "DONE" &&
    !selectedTaskIds.slice(0, index).includes(dependency.taskId)));
  const unresolvedBlockers = selectedTasks.flatMap((task) => task.unresolvedBlockerIds.map((id) => ({ task, id,
    reason: projectState?.blockers.find((blocker) => blocker.blockerId === id && blocker.resolvedAt === null)?.reason ?? "阻塞原因暂不可读" })));

  function setStored(intent: ChainIntent) {
    try { sessionStorage.setItem(key, JSON.stringify(intent)); }
    catch { setActionError("无法在本机暂存原命令；为保证可恢复，本次没有发送。"); return false; }
    pendingRef.current = intent; setPending(intent); setPendingAbsent(false); return true;
  }
  function clearStored() {
    try { sessionStorage.removeItem(key); } catch { /* Keep the in-memory resolution visible. */ }
    pendingRef.current = null; setPending(null); setPendingAbsent(false);
  }
  async function applyVerifiedResult(intent: ChainIntent, rawResult: unknown) {
    const result = record(rawResult);
    const chainId = resultString(result, "chainId", "chain_id");
    const resultProjectId = resultString(result, "projectId", "project_id");
    const status = resultString(result, "status", "status");
    const revision = resultString(result, "revision", "revision");
    if (resultProjectId !== projectId || (intent.kind !== "CREATE" && chainId !== intent.input.chainId))
      throw new Error("任务链回执身份与原请求不匹配。");
    const allowedStatuses = intent.kind === "CREATE" ? ["DRAFT"]
      : intent.kind === "AUTHORIZE" ? ["ACTIVE", "WAITING_RESUME"]
      : intent.input.action === "REVOKE" ? ["REVOKED"] : ["PAUSED", "PAUSING"];
    if (!allowedStatuses.includes(status)) throw new Error("任务链回执状态与原命令不匹配。");
    const [detail, list] = await Promise.all([client.getTaskChain(chainId), client.getProjectTaskChains(projectId)]);
    const listed = list.items.find((item) => item.chainId === chainId);
    if (detail.chainId !== chainId || detail.projectId !== projectId || detail.status !== status || detail.revision !== revision ||
      !listed || listed.projectId !== projectId || listed.status !== status || listed.revision !== revision)
      throw new Error("任务链详情与项目列表读回的身份、状态或修订不一致；命令仍待核对。");
    setChains(list.items); setSelectedChainId(chainId);
    return intent.kind === "CREATE" ? "新建任务链已核对并选中。" : "任务链命令已核对，已重读当前状态。";
  }
  async function execute(intent: ChainIntent) {
    if (busy || (intent === pendingRef.current ? false : pendingRef.current !== null)) return;
    if (intent !== pendingRef.current && !setStored(intent)) return;
    setBusy(true); setActionError(null); setNotice(null);
    let commandResponseReceived = false;
    try {
      const result = intent.kind === "CREATE" ? await client.createTaskChain(intent.input)
        : intent.kind === "AUTHORIZE" ? await client.authorizeTaskChain(intent.input) : await client.stopTaskChain(intent.input);
      commandResponseReceived = true;
      const confirmation = await applyVerifiedResult(intent, result);
      clearStored(); setNotice(confirmation);
      if (intent.kind === "CREATE") {
        setSelectedTaskIds([]); setChainTitle("有限任务链"); setConfirmed(false);
        cleanDraft.current = JSON.stringify({ chainTitle: "有限任务链", selectedTaskIds: [] });
      } else { setConfirmed(false); }
    } catch (caught) {
      const definitive = !commandResponseReceived && caught instanceof RelayApiError && caught.problem.status < 500;
      if (definitive) clearStored();
      setActionError(`${commandResponseReceived ? "命令已响应但读回仍待核对，原 ID 与载荷已保留" : definitive ? "命令被服务端拒绝" : "命令结果待核对，原 ID 与载荷已保留"}：${describeLiveError(caught).message}`);
      if (definitive) await refresh();
    } finally { setBusy(false); }
  }
  async function recover() {
    if (!pending || busy) return;
    setBusy(true); setActionError(null); setPendingAbsent(false);
    try {
      let receipt;
      try { receipt = await client.getCommandReceipt(pending.input.commandId); }
      catch (caught) {
        if (caught instanceof RelayApiError && caught.problem.status === 404) {
          setPendingAbsent(true); setActionError("服务端尚未找到该命令回执。原 ID 与载荷仍保留，可明确选择用同一 ID 重试。");
          return;
        }
        throw caught;
      }
      const expected = pending.kind === "CREATE" ? "CreateTaskChain" : pending.kind === "AUTHORIZE" ? "AuthorizeTaskChain" : "StopTaskChain";
      if (receipt.commandId !== pending.input.commandId || receipt.commandType !== expected)
        throw new Error("回执身份或命令类型不匹配；原请求仍保留供核对。");
      const confirmation = await applyVerifiedResult(pending, receipt.result);
      clearStored(); setNotice(`${confirmation} 已使用原回执恢复，没有再次提交。`);
    } catch (caught) {
      setActionError(`回执或服务端读回暂时无法核对，原请求仍保留：${describeLiveError(caught).message}`);
    } finally { setBusy(false); }
  }

  function toggleTask(task: RelayTaskSummary) {
    setSelectedTaskIds((current) => current.includes(task.id) ? current.filter((id) => id !== task.id)
      : current.length >= 16 ? current : [...current, task.id]);
  }
  function reorder(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= selectedTaskIds.length) return;
    setSelectedTaskIds((current) => { const next = [...current]; [next[index], next[target]] = [next[target]!, next[index]!]; return next; });
  }
  const usage = selectedChain?.modelUsage ?? {};
  const uncertainCalls = usage.uncertain_calls === undefined ? Number.NaN : Number(usage.uncertain_calls);
  const canAuthorize = selectedChain !== null && (selectedChain.status === "DRAFT" || selectedChain.status === "WAITING_RESUME" || selectedChain.status === "PAUSED")
    && !archived && uncertainCalls === 0;

  if (loading) return <section className="page-state" role="status"><h1>正在读取有限任务链…</h1></section>;
  if (error && projectTitle === "") return <section className="page-state page-state--error" role="alert"><h1>暂时无法读取项目任务链</h1>
    <p>{error}</p><button className="secondary-button" type="button" onClick={() => void refresh()}>重新读取</button></section>;

  return <section className="skill-page task-chain-page"><div className="page-layout"><main className="page-primary">
    <PageHeader title="有限任务链" meta={projectTitle} lede="先固定任务顺序，再单独确认预算与授权期限。创建草稿不会启动任务。" />
    <ProjectNav projectId={projectId} active="chains" />
    {archived && <p className="action-error" role="status">项目已归档；任务链不能创建或授权。</p>}
    {pending && <section className="surface-panel task-chain-pending" data-testid="task-chain-pending">
      <h2>命令结果待核对</h2><p>原 command ID：<code>{pending.input.commandId}</code>。原请求已保存在本机此工作区，不会自动更换 ID。</p>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => void recover()}>查询原命令回执</button>
      {pendingAbsent && <button className="secondary-button" type="button" disabled={busy} onClick={() => void execute(pending)}>用原 ID 与原载荷重试</button>}
    </section>}
    {error && <p className="action-error" role="alert">刷新失败：{error}；已保留本地已读任务链。</p>}
    {actionError && <p className="action-error" role="alert">{actionError}</p>}
    {notice && <p className="receipt-message" role="status">{notice}</p>}
    {fromPlanMessage && <p className="helper-text" role="status" data-testid="task-chain-plan-source">{fromPlanMessage}</p>}

    <section className="surface-panel task-chain-create" aria-label="创建固定任务链">
      <h2>固定任务顺序</h2>
      <p className="helper-text">仅选择本项目 1–16 个 INBOX/READY 且执行权为 HUMAN 的任务。未完成的 BLOCKS 前置必须排在前面；任务链只处理 Relay 内置 Markdown 成果，不附加文件或命令范围。</p>
      <label className="field"><span className="field-label">任务链名称</span><input value={chainTitle} maxLength={200}
        disabled={pending !== null} onChange={(event) => setChainTitle(event.target.value)} /></label>
      {taskPages.error && <div className="action-error" role="alert">已保留已加载任务与原游标：{taskPages.error}
        <button className="text-button" type="button" disabled={taskPages.loading || taskPages.loadingMore} onClick={taskPages.retry}>重试任务列表</button></div>}
      <p className="helper-text">已加载 {taskPages.items.length} 项{taskPages.nextCursor === null ? "，任务列表已到末页。" : "，任务列表仍有后续页。"}</p>
      <div className="task-chain-task-list">{taskPages.items.map((task) => <label key={task.id} className="planning-check">
        <input type="checkbox" checked={selectedTaskIds.includes(task.id)} disabled={pending !== null ||
          (!selectedTaskIds.includes(task.id) && selectedTaskIds.length >= 16)} onChange={() => toggleTask(task)} />
        <span>{task.title}<small>{task.status} · {task.executor} · Task 修订 v{task.revision}</small></span>
      </label>)}</div>
      {taskPages.nextCursor !== null && <button className="secondary-button" type="button" disabled={taskPages.loading || taskPages.loadingMore}
        onClick={taskPages.loadMore}>{taskPages.loadingMore ? "正在读取后续任务…" : "加载更多任务"}</button>}
      {selectedTaskIds.length > 0 && <ol className="task-chain-order">{selectedTaskIds.map((taskId, index) => {
        const task = taskDetails.get(taskId);
        return <li key={taskId}><div><strong>{task?.title ?? taskId}</strong><span>{task ? `${task.status} · ${task.executor} · 验收 v${task.acceptance.acceptanceRevision}` : "正在读取当前验收与依赖…"}</span>
          {task && (declaredOutputKinds(task.acceptance.expectedOutputs) === null
            ? <span className="action-error">验收没有可由任务链支持的预期产物（需要 MARKDOWN_DOCUMENT）</span>
            : <span>预期产物：{declaredOutputKinds(task.acceptance.expectedOutputs)!.join("、")}</span>)}
          {task && !task.acceptance.criteria.some((criterion) => criterion.required) && <span className="action-error">缺少必需验收条件</span>}
          {task?.acceptance.criteria.map((criterion) => <span key={criterion.criterionId}>{criterion.required ? "必需" : "可选"} · {criterion.statement}</span>)}
          {task?.dependencies.map((dependency) => <span className="helper-text" key={dependency.taskId}>
            {dependency.dependencyKind === "BLOCKS" ? "阻塞前置" : "依赖"}：{dependency.title} · {dependency.status}
          </span>)}
          {task?.unresolvedBlockerIds.map((id) => <span className="action-error" key={id}>
            未解除 blocker {id}：{projectState?.blockers.find((blocker) => blocker.blockerId === id && blocker.resolvedAt === null)?.reason ?? "阻塞原因暂不可读"}
          </span>)}
        </div><div className="task-chain-order-actions"><button className="text-button" type="button" disabled={pending !== null || index === 0} onClick={() => reorder(index, -1)}>上移</button>
          <button className="text-button" type="button" disabled={pending !== null || index === selectedTaskIds.length - 1} onClick={() => reorder(index, 1)}>下移</button></div></li>;
      })}</ol>}
      {detailError && <p className="action-error" role="alert">任务详情或验收版本读取失败：{detailError}。确认权限恢复后可重新选择任务再读取。</p>}
      {blockerReadError && <p className="action-error" role="alert">项目阻塞事实读取失败：{blockerReadError}；任务链创建已禁用。</p>}
      {missingPrerequisite && <p className="action-error" role="alert">所选顺序没有把全部未完成的必要前置排在依赖任务之前。</p>}
      {unresolvedBlockers.length > 0 && <p className="action-error" role="alert">存在无法通过本任务链顺序解决的 blocker；先解除后才能创建草稿。</p>}
      <button className="primary-button" type="button" data-testid="task-chain-create" disabled={busy || pending !== null || archived ||
        !selectedTasksReady || missingPrerequisite || detailError !== null || blockerReadError !== null || chainTitle.trim() === ""}
        onClick={() => void execute({ kind: "CREATE", input: { commandId: createCommandId(), projectId, title: chainTitle.trim(), confirmed: true,
          tasks: selectedTasks.map((task) => ({ taskId: task.id, expectedRevision: task.revision,
            expectedAcceptanceRevision: task.acceptance.acceptanceRevision })) } })}>创建任务链草稿</button>
    </section>

    <section className="surface-panel task-chain-history" aria-label="任务链历史">
      <div className="task-chain-section-head"><h2>任务链与运行事实</h2><button className="text-button" type="button" onClick={() => void refresh()}>重新读取</button></div>
      {chains.length === 0 ? <p className="helper-text">本项目还没有任务链。</p> : <label className="field"><span className="field-label">选择任务链</span>
        <select value={selectedChainId} onChange={(event) => setSelectedChainId(event.target.value)}>
          {chains.map((chain) => <option key={chain.chainId} value={chain.chainId}>{chain.title} · {chainLabels[chain.status] ?? chain.status} · v{chain.revision}</option>)}
        </select></label>}
      {selectedChain && <ChainDetail chain={selectedChain} reviews={reviews} reviewsError={reviewsError}
        uncertainCalls={uncertainCalls} usage={usage}
        canAuthorize={canAuthorize} busy={busy || pending !== null} archived={archived}
        maxTasks={maxTasks} setMaxTasks={setMaxTasks} maxModelCalls={maxModelCalls} setMaxModelCalls={setMaxModelCalls}
        expiresAt={expiresAt} setExpiresAt={setExpiresAt} stopReason={stopReason} setStopReason={setStopReason}
        confirmed={confirmed} setConfirmed={setConfirmed}
        onAuthorize={() => {
          const expires = new Date(expiresAt);
          if (!selectedChain || !Number.isFinite(expires.getTime())) return;
          void execute({ kind: "AUTHORIZE", input: { commandId: createCommandId(), chainId: selectedChain.chainId,
            expectedRevision: selectedChain.revision, confirmed: true, maxTasks: Number(maxTasks),
            maxModelCalls: Number(maxModelCalls), expiresAt: expires.toISOString() } });
        }}
        onStop={(action) => selectedChain && void execute({ kind: "STOP", input: { commandId: createCommandId(),
          chainId: selectedChain.chainId, expectedRevision: selectedChain.revision, action, reason: stopReason.trim() } })} />}
    </section>
  </main></div></section>;
}

function ChainDetail({ chain, reviews, reviewsError, uncertainCalls, usage, canAuthorize, busy, archived, maxTasks, setMaxTasks,
  maxModelCalls, setMaxModelCalls, expiresAt, setExpiresAt, stopReason, setStopReason, confirmed, setConfirmed,
  onAuthorize, onStop }: { readonly chain: RelayTaskChain; readonly reviews: readonly RelayReview[];
  readonly reviewsError: string | null; readonly uncertainCalls: number; readonly usage: Record<string, unknown>;
  readonly canAuthorize: boolean; readonly busy: boolean; readonly archived: boolean; readonly maxTasks: string;
  readonly setMaxTasks: (value: string) => void; readonly maxModelCalls: string; readonly setMaxModelCalls: (value: string) => void;
  readonly expiresAt: string; readonly setExpiresAt: (value: string) => void; readonly stopReason: string;
  readonly setStopReason: (value: string) => void; readonly confirmed: boolean; readonly setConfirmed: (value: boolean) => void;
  readonly onAuthorize: () => void; readonly onStop: (action: "PAUSE" | "REVOKE") => void }) {
  const details = chain.items.map((raw) => record(raw));
  const expiryMs = new Date(expiresAt).getTime();
  const timeValid = Number.isFinite(expiryMs) && expiryMs > Date.now() && expiryMs <= Date.now() + 24 * 60 * 60 * 1000;
  const budgetsValid = Number.isInteger(Number(maxTasks)) && Number(maxTasks) >= Math.max(1, chain.taskReservations) && Number(maxTasks) <= 16 &&
    Number.isInteger(Number(maxModelCalls)) && Number(maxModelCalls) > chain.callsStarted && Number(maxModelCalls) <= 100;
  const baseline = record(chain.baseline);
  return <div className="task-chain-detail" data-testid="task-chain-detail">
    <div className="planning-facts"><span>{chainLabels[chain.status] ?? chain.status}</span><span>链修订 v{chain.revision}</span>
      <span>任务预留 {chain.taskReservations}/{chain.maxTasks}</span><span>已开始调用 {chain.callsStarted}/{chain.maxModelCalls}</span>
      <span>授权截止 {chain.expiresAt ?? "尚未授权"}</span></div>
    {chain.status === "PAUSING" && <p className="action-error" role="status">停止请求正在通过原控制机制安全处理，尚未确认暂停或撤销完成。</p>}
    {chain.reason && <p className="helper-text">最近控制原因：{chain.reason}</p>}
    <p>执行来源：固定 Task 顺序 · {(typeof baseline.tool_scope === "string" && baseline.tool_scope === "INTERNAL_MARKDOWN_ARTIFACTS_ONLY")
      ? "仅 Relay 内置 Markdown 成果"
      : typeof baseline.tool_scope === "string" ? baseline.tool_scope : "按冻结来源读取"}</p>
    <p>累计用量：记录调用 {usageValue(usage.recorded_calls)} · 未知调用 {usageValue(usage.uncertain_calls)} · 输入 token {usageValue(usage.known_input_tokens)} · 输出 token {usageValue(usage.known_output_tokens)} · 总 token {usageValue(usage.total_tokens)} · 费用未提供</p>
    {uncertainCalls !== 0 && <p className="action-error" role="alert">{Number.isFinite(uncertainCalls)
      ? "存在未知调用结果；不把 UNKNOWN 当作成功或零消耗，当前不能恢复授权。"
      : "调用计量读取不完整；按未知处理，当前不能新增或恢复授权。"}</p>}
    <h3>固定项</h3>
    <ol className="task-chain-items">{details.map((item) => {
      const runId = typeof item.run_id === "string" ? item.run_id : null;
      const openReviews = runId === null ? [] : reviews.filter((review) => review.runId === runId);
      const reviewStatus = reviewsError !== null ? `读取失败：${reviewsError}`
        : openReviews.length > 0 ? `有 ${openReviews.length} 条 OPEN Review`
        : "当前未见 OPEN Review（历史判断见原 Run）";
      return <li key={String(item.item_id)}>
      <div><strong>{String(record(item.baseline).title ?? item.task_id)}</strong><span>{itemLabels[String(item.status)] ?? String(item.status)}</span></div>
      <p>Task：{String(item.current_task_status ?? "未知")} · Run：{String(item.current_run_status ?? "尚未启动")} · Review：{reviewStatus} · Completion：{item.completion_id ? String(item.completion_id) : "尚无完成凭据"}</p>
      <p className="helper-text">Task 修订 v{String(item.task_revision)} · 验收修订 v{String(item.acceptance_revision)} · Run ID：{item.run_id ? String(item.run_id) : "尚未分配"}</p>
      <ExecutionScope value={item.execution_spec} />
      {runId !== null && <Link to={`/runs/${encodeURIComponent(runId)}`}>打开原 Run 与 Review 事实</Link>}
      {typeof item.task_id === "string" && <Link to={`/tasks/${encodeURIComponent(item.task_id)}`}>打开原 Task 与完成记录</Link>}
    </li>;
    })}</ol>
    {chain.authorizationHistory.length > 0 && <details><summary>授权历史（{chain.authorizationHistory.length} 条）</summary>
      <ol>{chain.authorizationHistory.map((authorization, index) => <li key={index}>
        任务上限 {String(authorization.max_tasks ?? "未知")} · 调用上限 {String(authorization.max_model_calls ?? "未知")} · 截止 {String(authorization.expires_at ?? "未知")}
      </li>)}</ol></details>}
    {canAuthorize && <section className="task-chain-authorization" aria-label="明确任务链授权">
      <h3>{chain.status === "DRAFT" ? "单独授予执行授权" : "确认恢复并继续"}</h3>
      <p className="planning-boundary">授权期限独立于 N04 计划窗口。重新打开任务链不会自动继续；UNKNOWN 用量未收口时不能重新授权，预算必须覆盖累计预留与已开始调用。</p>
      <div className="task-chain-budget-fields">
        <label className="field"><span className="field-label">任务总数上限（已预留 {chain.taskReservations}）</span>
          <input type="number" min={Math.max(1, chain.taskReservations)} max="16" value={maxTasks} onChange={(event) => setMaxTasks(event.target.value)} /></label>
        <label className="field"><span className="field-label">模型调用累计上限（已开始 {chain.callsStarted}）</span>
          <input type="number" min={chain.callsStarted + 1} max="100" value={maxModelCalls} onChange={(event) => setMaxModelCalls(event.target.value)} /></label>
        <label className="field"><span className="field-label">授权截止时间（未来 24 小时内）</span><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
      </div>
      <label className="planning-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>我已核对这条固定任务链、累计预算和到期时间，并明确授权（最多 24 小时）。</span></label>
      <button className="primary-button" type="button" data-testid="task-chain-authorize" disabled={busy || archived || !confirmed || !timeValid || !budgetsValid || uncertainCalls > 0}
        onClick={onAuthorize}>{chain.status === "DRAFT" ? "明确授权并启动受限准入" : "明确恢复并继续"}</button>
    </section>}
    {chain.status === "ACTIVE" && <section className="task-chain-stop" aria-label="暂停或撤销任务链">
      <h3>控制当前执行</h3><label className="field"><span className="field-label">停止理由</span><input value={stopReason} maxLength={4000} onChange={(event) => setStopReason(event.target.value)} /></label>
      <button className="secondary-button" type="button" disabled={busy || archived || stopReason.trim() === ""} onClick={() => onStop("PAUSE")}>请求安全暂停</button>
      <button className="danger-button" type="button" disabled={busy || stopReason.trim() === ""} onClick={() => onStop("REVOKE")}>撤销任务链授权</button>
    </section>}
  </div>;
}

function ExecutionScope({ value }: { readonly value: unknown }) {
  const spec = record(value);
  const sources: string[] = [];
  if (spec.file_read_action) sources.push("受限文件读取");
  if (spec.tool_loop_action) sources.push("固定工具循环");
  if (spec.scope_grant) sources.push("显式范围授权");
  if (spec.context_sources) sources.push("冻结上下文来源");
  return <p className="helper-text">执行来源与资源范围：{sources.length === 0 ? "Relay 内置 Markdown 成果，无外部目录或命令准入" : sources.join("、")}</p>;
}
