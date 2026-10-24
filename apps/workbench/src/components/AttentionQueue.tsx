import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { RelayApiError, type RelayApiClient, type RelayInterventionItem, type RelayReview, type RelayRun, type RelayTaskSummary } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { interventionReasonText, reviewKindLabels, reviewReasonText, taskStatusLabels } from "../lib/labels";
import { controlLabels, runLabels } from "./RunControlPanel";
import { reviewDecisionLabels } from "./ReviewDecisionPanel";
import PageHeader from "./PageHeader";

interface AttentionSnapshot {
  readonly queriedAt: string;
  readonly reviews: readonly RelayReview[];
  readonly interventions: readonly RelayInterventionItem[];
  readonly tasks: readonly RelayTaskSummary[];
  readonly runs: readonly { readonly task: RelayTaskSummary; readonly run: RelayRun }[];
  /** 项目 ID → 服务端标题。读不到或不在本页时卡片改说「项目名称暂不可读取」。 */
  readonly projectTitles: ReadonlyMap<string, string>;
  readonly failures: readonly string[];
  readonly taskPagesComplete: boolean;
  readonly nextCursor: string | null;
  readonly seenCursors: ReadonlySet<string>;
  /**
   * 续页失败时保留失败页身份：原游标与失败说明。
   * 服务恢复后按这个游标重试这一页即可，不必把前面读过的页重读一遍（禅道 #131）。
   */
  readonly taskPageFailure: { readonly cursor: string; readonly message: string } | null;
}

function needsTaskAttention(task: RelayTaskSummary, reviewTaskIds: ReadonlySet<string>): boolean {
  if (task.status === "DONE" || task.status === "CANCELLED") return false;
  if (task.unresolvedBlockerIds.length || task.status === "BLOCKED") return true;
  if (reviewTaskIds.has(task.id)) return false;
  return task.executor === "HUMAN" && (task.status === "INBOX" || task.status === "READY") ||
    task.status === "WAITING" && task.waitingReason !== null;
}

/** 两条入口是否指向同一个对象：只比路径与 id，其余一概不当作「同一个」。 */
function targetKey(url: string): string {
  const [path, query = ""] = url.split("?");
  const id = new URLSearchParams(query).get("id");
  return id === null ? path : `${path}?id=${id}`;
}

/**
 * 续页失败的说法要分清两种情形：「暂时不可用」按原游标重试这一页即可，
 * 「已失权／不可见」重试同一页不会自己变好，得先核对作用域与权限。
 * 两者混同会让人把权限问题当成临时故障反复重试（禅道 #131）。
 */
function taskPageFailureText(caught: unknown): string {
  if (caught instanceof RelayApiError && (caught.problem.status === 403 || caught.problem.status === 404)) {
    return "这一页当前不可见或已无权读取：请先核对作用域与权限，恢复访问后再按原游标重试这一页。";
  }
  return describeLiveError(caught).message;
}

async function readAttention(client: RelayApiClient, active: () => boolean,
  previous: AttentionSnapshot | null): Promise<AttentionSnapshot> {
  const failures: string[] = [];
  let interventions: readonly RelayInterventionItem[] = [];
  try { interventions = await client.getInterventions(); }
  catch (caught) { failures.push(`必须介入事项未核对：${describeLiveError(caught).message}`); }
  let reviews: readonly RelayReview[] = [];
  try {
    const seen = new Set<string>();
    reviews = (await client.getReviews()).filter((review) => {
      if (review.status !== "OPEN" || seen.has(review.id)) return false;
      seen.add(review.id); return true;
    });
  } catch (caught) { failures.push(`Review 列表未核对：${describeLiveError(caught).message}`); }

  const tasks: RelayTaskSummary[] = [...(previous?.tasks ?? [])];
  const taskIds = new Set(tasks.map((task) => task.id));
  const cursors = new Set(previous?.seenCursors ?? []);
  let cursor: string | null = previous?.nextCursor ?? null;
  let taskPagesComplete = false;
  let nextCursor: string | null = null;
  let taskPageFailure: { readonly cursor: string; readonly message: string } | null = null;
  try {
    for (let pageNumber = 0; pageNumber < 10 && active(); pageNumber++) {
      const page = await client.getWorkspaceTasksPage(cursor);
      for (const task of page.items) {
        if (taskIds.has(task.id)) continue;
        taskIds.add(task.id); tasks.push(task);
      }
      if (page.nextCursor === null) { taskPagesComplete = true; nextCursor = null; break; }
      if (cursors.has(page.nextCursor)) throw new Error("任务游标重复，无法确认列表完整性。");
      cursors.add(page.nextCursor); cursor = page.nextCursor; nextCursor = cursor;
    }
  } catch (caught) {
    // 续页失败要保住失败页的身份：抛出时 cursor 仍是这一页的请求游标，
    // 恢复后按它重试这一页即可，不必把前面读过的页重读一遍（禅道 #131）。
    // 首读失败没有可保留的游标，仍按整块错误态呈现。
    if (previous !== null && cursor !== null) {
      nextCursor = cursor;
      taskPageFailure = { cursor, message: taskPageFailureText(caught) };
    } else {
      nextCursor = null;
      failures.push(`Task 列表未读完：${describeLiveError(caught).message}`);
    }
  }

  const runs: { task: RelayTaskSummary; run: RelayRun }[] = [];
  const runTasks = tasks.filter((task) => task.executorRunId !== null);
  for (let offset = 0; offset < runTasks.length && active(); offset += 4) {
    const batch = await Promise.allSettled(runTasks.slice(offset, offset + 4).map(async (task) => ({
      task, run: await client.getRun(task.executorRunId!)
    })));
    batch.forEach((result, index) => {
      const task = runTasks[offset + index]!;
      if (result.status === "rejected") {
        failures.push(`Task ${task.id} 的当前 Run ${task.executorRunId} 未核对：${describeLiveError(result.reason).message}`);
      } else if (result.value.run.id !== task.executorRunId || result.value.run.taskId !== task.id) {
        failures.push(`Task ${task.id} 的当前 Run 身份不匹配。`);
      } else runs.push(result.value);
    });
  }
  // 卡片要写项目名而不是 UUID。标题只是呈现用的只读事实：读不到就照说读不到，
  // 不把 ID 当名字，也不因此宣称整个待处理范围没核对完（计数口径不由它决定）。
  let projectTitles = new Map<string, string>();
  try {
    const page = await client.getProjectsPage("all", null);
    if (active()) projectTitles = new Map(page.items.map((project) => [project.id, project.title]));
  } catch { /* 名称缺失按「暂不可读取」呈现。 */ }

  return { queriedAt: new Date().toISOString(), reviews, interventions, tasks, runs,
    projectTitles, failures, taskPagesComplete, nextCursor, seenCursors: cursors, taskPageFailure };
}

export default function AttentionQueue({ client }: { readonly client: RelayApiClient }) {
  const [snapshot, setSnapshot] = useState<AttentionSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const version = useRef(0);
  async function load(continuePages = false) {
    const request = ++version.current;
    const previous = continuePages ? snapshot : null;
    setLoading(true); if (!continuePages) setSnapshot(null);
    const next = await readAttention(client, () => request === version.current, previous);
    if (request === version.current) { setSnapshot(next); setLoading(false); }
  }
  useEffect(() => { void load(); return () => { version.current++; }; }, [client]);
  const reviewTaskIds = new Set(snapshot?.reviews.map((review) => review.taskId).filter((id): id is string => id !== null));
  const taskItems = snapshot?.tasks.filter((task) => needsTaskAttention(task, reviewTaskIds)) ?? [];
  const runItems = snapshot?.runs.filter(({ run }) => run.unresolvedOperationIds.length > 0 ||
    run.pendingControlRequest !== null) ?? [];
  const complete = snapshot !== null && snapshot.failures.length === 0 && snapshot.taskPagesComplete;
  const titles = snapshot?.projectTitles ?? new Map<string, string>();
  // 名称只说服务端给过的事实：读不到就写「暂不可读取」，不拿 UUID 冒充名字。
  const projectName = (projectId: string | null) => projectId === null ? "未归入项目"
    : titles.get(projectId) ?? "项目名称暂不可读取";
  const taskName = (taskId: string | null) => taskId === null ? "未关联任务"
    : snapshot?.tasks.find((item) => item.id === taskId)?.title ?? "任务标题暂不可读取";
  const listed = new Map<string, string>();
  for (const review of snapshot?.reviews ?? []) {
    listed.set(targetKey(`/reviews?id=${review.id}`), "与下方「待判断 Review」列出的是同一条请求");
  }
  for (const { run } of runItems) {
    listed.set(targetKey(`/runs/${run.id}`), "与下方「当前 Run 待核对」列出的是同一次执行");
  }
  for (const task of taskItems) {
    listed.set(targetKey(`/tasks/${task.id}`), "与下方「人工任务与受阻 Task」列出的是同一个任务");
  }
  const attentionKeys = new Set(snapshot?.interventions.map((item) => targetKey(item.targetUrl)) ?? []);
  return <section className="skill-page page-primary" data-testid="attention-queue">
    <PageHeader testId="attention-page-head" title="需要你查看的事项" meta="跨项目人工待处理"
      lede="按 Review、当前 Run 与 Task 的服务端事实分组。每组保留原读取顺序，分组不表示紧急程度或截止时间。"
      actions={<button className="secondary-button" type="button" data-testid="attention-refresh" style={{ flexShrink: 0 }} disabled={loading}
        onClick={() => void load()}>刷新事实</button>} />
    <nav className="subnav" aria-label="任务范围"><Link className="subnav-item" to="/tasks">全部任务</Link>
      <Link className="subnav-item" to="/tasks?tab=inbox">未归属任务收件箱</Link>
      <Link className="subnav-item subnav-item--active" to="/tasks?tab=attention" aria-current="page">人工待处理</Link></nav>
    <p className="helper-text">只汇总已读取的开放 Review、工作空间任务及其当前 Run。历史上已脱离 Task 指针的 Run 不在本次范围内；处理决定请进入原入口核对版本。</p>
    {loading && <p className="loading-text" role="status">正在读取 Review、全部任务页及当前 Run，完成前不显示空队列结论…</p>}
    {snapshot && <>
      <p className="helper-text">本次读取完成于 <time dateTime={snapshot.queriedAt}>{new Date(snapshot.queriedAt).toLocaleString("zh-CN")}</time>；各项可能在读取后继续变化，处理前请到原入口核对。</p>
      {!complete && <div className="warning-callout" role="alert" data-testid="attention-incomplete"><strong>待处理范围未核对完整</strong>
        <p>已读取的事项仍可打开；不能据此判断其他项目或 Run 没有待办。</p>
        {snapshot.failures.length > 0 && <ul>{snapshot.failures.map((failure) => <li key={failure}>{failure}</li>)}</ul>}
        {snapshot.taskPageFailure && <p className="action-error" data-testid="attention-continuation-error">续页失败：{snapshot.taskPageFailure.message}；已保留前面加载的结果，可按同一游标重试这一页。</p>}
        {snapshot.nextCursor && <p>Task 分页每次最多读取 10 页，尚有后续页。<button className="secondary-button" type="button" data-testid="attention-continue-pages" disabled={loading} onClick={() => void load(true)}>继续读取后续页</button></p>}</div>}
      <section className="surface-panel" data-testid="required-interventions"><h2>必须介入 · {snapshot.interventions.length}</h2>
        <p className="helper-text">来自当前服务端事实；普通收件箱与 READY 任务不会因此主动通知。进入原入口后重新核对是否仍待处理。</p>
        {snapshot.interventions.length ? <ul>{snapshot.interventions.map((item) => <li key={`${item.itemKey}:${item.changeKey}`}
          data-testid={`attention-intervention-${item.itemKey}`}>
          <strong>{item.title}</strong><p>{interventionReasonText(item)}</p>
          {listed.has(targetKey(item.targetUrl)) && <p>这条提醒{listed.get(targetKey(item.targetUrl))}；处理仍在那一条的入口里做。</p>}
          <p>下一步：<Link className="inline-link" data-testid="attention-main-entry" to={item.targetUrl}>打开原处理入口</Link>。进入后按那条请求的当前事实再核对一次。</p>
          <details className="attention-identity"><summary>技术细节</summary>
            <p>事项类型 {item.kind} · 事项键 {item.itemKey} · 变化键 {item.changeKey}</p>
            <p>入口地址 {item.targetUrl}</p></details>
        </li>)}</ul> : <p className="helper-text">当前读取范围未发现必须介入事项。</p>}</section>
      {complete && snapshot.interventions.length === 0 && snapshot.reviews.length === 0 &&
        runItems.length === 0 && taskItems.length === 0 &&
        <p className="helper-text">当前读取范围内没有待处理项。历史 Run 与其他外部执行回执仍需从原入口核对。</p>}
      <section className="surface-panel"><h2>待判断 Review · {snapshot.reviews.length}</h2>
        <p className="helper-text">每条决定绑定独立目标与版本；进入 Review 后重新读取，不批量批准。</p>
        <ul>{snapshot.reviews.map((review) => <li key={review.id} data-testid={`attention-review-${review.id}`}>
          <strong>{reviewKindLabels[review.kind]} · {reviewReasonText(review.reason)}</strong>
          <p>{projectName(review.projectId)} · 任务「{taskName(review.taskId)}」</p>
          <p>你要做什么：{review.allowedDecisions.length
            ? `核对判断依据后，在${review.allowedDecisions.map((decision) => reviewDecisionLabels[decision]).join("、")}里选一个作决定。`
            : "打开这条请求核对当前状态；这次读取没有给出可用决定。"}</p>
          <p>下一步：<Link className="inline-link" data-testid="attention-main-entry" to={`/reviews?id=${encodeURIComponent(review.id)}`}>打开原 Review 决定入口</Link>。延后影响以该请求当前事实为准，尚未由此队列确定。</p>
          <details className="attention-identity"><summary>技术细节</summary>
            <p>Review {review.id} · Project {review.projectId ?? "未关联"} · Task {review.taskId ?? "未关联"} · Run {review.runId ?? "未关联"} · Review v{review.revision}</p>
            {attentionKeys.has(targetKey(`/reviews?id=${review.id}`)) &&
              <p>这条请求也出现在「必须介入」事项里，那里只是提醒，不改变它的版本，也不代替这里的判断。</p>}</details></li>)}</ul></section>
      <section className="surface-panel"><h2>当前 Run 待核对 · {runItems.length}</h2>
        <ul>{runItems.map(({ task, run }) => <li key={run.id} data-testid={`attention-run-${run.id}`}>
          <strong>{task.title} · {runLabels[run.status] ?? run.status}</strong>
          <p>{projectName(task.projectId)}</p>
          <p>你要做什么：{[
            run.unresolvedOperationIds.length ? `有 ${run.unresolvedOperationIds.length} 个动作的结果还没确定，要按原身份核对它是否已经生效。` : "",
            run.pendingControlRequest ? `有一个「${controlLabels[run.pendingControlRequest.type] ?? run.pendingControlRequest.type}」在等待处理。` : ""]
            .filter((line) => line !== "").join(" ")}</p>
          <p>下一步：<Link className="inline-link" data-testid="attention-main-entry" to={`/runs/${run.id}`}>打开原 Run 核对入口</Link>。切换视图不会完成控制或重试动作。</p>
          <details className="attention-identity"><summary>技术细节</summary>
            <p>Run {run.id} · 状态 {run.status} · Task {task.id} · 任务 v{task.revision}</p>
            {run.unresolvedOperationIds.length > 0 && <p>未决 Operation：{run.unresolvedOperationIds.join("、")}。状态或外部效果须按原身份核对。</p>}
            {run.pendingControlRequest !== null && <p>控制请求 {run.pendingControlRequest.id}：{run.pendingControlRequest.status}。</p>}
            {attentionKeys.has(targetKey(`/runs/${run.id}`)) &&
              <p>这次执行也出现在「必须介入」事项里，那里只是提醒，不代替这里的核对。</p>}</details></li>)}</ul></section>
      <section className="surface-panel"><h2>人工任务与受阻 Task · {taskItems.length}</h2>
        <ul>{taskItems.map((task) => <li key={task.id} data-testid={`attention-task-${task.id}`}>
          <strong>{task.title} · {taskStatusLabels[task.status]}</strong>
          <p>{projectName(task.projectId)}</p>
          <p>等待原因：{task.waitingReason ?? (task.unresolvedBlockerIds.length
            ? `有 ${task.unresolvedBlockerIds.length} 项未决阻塞（清单在技术细节里）` : "服务端未给出具体原因")}。未提供可证实的延后影响。</p>
          <p>下一步：<Link className="inline-link" data-testid="attention-main-entry" to={`/tasks/${task.id}`}>打开任务核对当前状态</Link>{task.executorRunId && <>；<Link to={`/runs/${task.executorRunId}`}>查看当前 Run</Link></>}。</p>
          <details className="attention-identity"><summary>技术细节</summary>
            <p>Task {task.id} · 任务 v{task.revision}{task.executorRunId ? ` · Run ${task.executorRunId}` : ""}</p>
            {task.unresolvedBlockerIds.length > 0 && <p>未决阻塞：{task.unresolvedBlockerIds.join("、")}</p>}
            {attentionKeys.has(targetKey(`/tasks/${task.id}`)) &&
              <p>这个任务也出现在「必须介入」事项里，那里只是提醒，不等于任务已经交给别人。</p>}</details></li>)}</ul></section>
    </>}
  </section>;
}
