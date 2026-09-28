import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RelayApiClient, RelayInterventionItem, RelayReview, RelayRun, RelayTaskSummary } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import { taskStatusLabels } from "../lib/labels";

interface AttentionSnapshot {
  readonly queriedAt: string;
  readonly reviews: readonly RelayReview[];
  readonly interventions: readonly RelayInterventionItem[];
  readonly tasks: readonly RelayTaskSummary[];
  readonly runs: readonly { readonly task: RelayTaskSummary; readonly run: RelayRun }[];
  readonly failures: readonly string[];
  readonly taskPagesComplete: boolean;
  readonly nextCursor: string | null;
  readonly seenCursors: ReadonlySet<string>;
}

function needsTaskAttention(task: RelayTaskSummary, reviewTaskIds: ReadonlySet<string>): boolean {
  if (task.status === "DONE" || task.status === "CANCELLED") return false;
  if (task.unresolvedBlockerIds.length || task.status === "BLOCKED") return true;
  if (reviewTaskIds.has(task.id)) return false;
  return task.executor === "HUMAN" && (task.status === "INBOX" || task.status === "READY") ||
    task.status === "WAITING" && task.waitingReason !== null;
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
  } catch (caught) { nextCursor = null; failures.push(`Task 列表未读完：${describeLiveError(caught).message}`); }

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
  return { queriedAt: new Date().toISOString(), reviews, interventions, tasks, runs,
    failures, taskPagesComplete, nextCursor, seenCursors: cursors };
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
  return <section className="skill-page" data-testid="attention-queue">
    <div className="list-header"><div><p className="eyebrow">跨项目人工待处理</p><h1>需要你查看的事项</h1>
      <p className="page-lede">按 Review、当前 Run 与 Task 的服务端事实分组。每组保留原读取顺序，分组不表示紧急程度或截止时间。</p></div>
      <button className="secondary-button" type="button" disabled={loading} onClick={() => void load()}>刷新事实</button></div>
    <nav className="subnav" aria-label="任务范围"><Link className="subnav-item" to="/tasks">全部任务</Link>
      <Link className="subnav-item" to="/tasks?tab=inbox">未归属任务收件箱</Link>
      <Link className="subnav-item subnav-item--active" to="/tasks?tab=attention" aria-current="page">人工待处理</Link></nav>
    <p className="helper-text">只汇总已读取的开放 Review、工作空间任务及其当前 Run。历史上已脱离 Task 指针的 Run 不在本次范围内；处理决定请进入原入口核对版本。</p>
    {loading && <p role="status">正在读取 Review、全部任务页及当前 Run，完成前不显示空队列结论…</p>}
    {snapshot && <>
      <p className="helper-text">本次读取完成于 <time dateTime={snapshot.queriedAt}>{new Date(snapshot.queriedAt).toLocaleString("zh-CN")}</time>；各项可能在读取后继续变化，处理前请到原入口核对。</p>
      {!complete && <div className="warning-callout" role="alert" data-testid="attention-incomplete"><strong>待处理范围未核对完整</strong>
        <p>已读取的事项仍可打开；不能据此判断其他项目或 Run 没有待办。</p>
        <ul>{snapshot.failures.map((failure) => <li key={failure}>{failure}</li>)}</ul>
        {snapshot.nextCursor && <p>Task 分页每次最多读取 10 页，尚有后续页。<button className="secondary-button" type="button" disabled={loading} onClick={() => void load(true)}>继续读取后续页</button></p>}</div>}
      <section className="surface-panel" data-testid="required-interventions"><h2>必须介入 · {snapshot.interventions.length}</h2>
        <p className="helper-text">来自当前服务端事实；普通收件箱与 READY 任务不会因此主动通知。进入原入口后重新核对是否仍待处理。</p>
        {snapshot.interventions.length ? <ul>{snapshot.interventions.map((item) => <li key={`${item.itemKey}:${item.changeKey}`}>
          <strong>{item.title}</strong><p>{item.reason}</p><p><Link to={item.targetUrl}>打开原处理入口</Link></p>
        </li>)}</ul> : <p className="helper-text">当前读取范围未发现必须介入事项。</p>}</section>
      {complete && snapshot.interventions.length === 0 && snapshot.reviews.length === 0 &&
        runItems.length === 0 && taskItems.length === 0 &&
        <p className="helper-text">当前读取范围内没有待处理项。历史 Run 与其他外部执行回执仍需从原入口核对。</p>}
      <section className="surface-panel"><h2>待判断 Review · {snapshot.reviews.length}</h2>
        <p className="helper-text">每条决定绑定独立目标与版本；进入 Review 后重新读取，不批量批准。</p>
        <ul>{snapshot.reviews.map((review) => <li key={review.id} data-testid={`attention-review-${review.id}`}>
          <strong>{review.kind} · {review.reason}</strong>
          <p>Project {review.projectId ?? "未关联"} · Task {review.taskId ?? "未关联"} · Run {review.runId ?? "未关联"} · Review v{review.revision}</p>
          <p>下一步：<Link to={`/reviews?id=${encodeURIComponent(review.id)}`}>打开原 Review 决定入口</Link>。延后影响以该请求当前事实为准，尚未由此队列确定。</p></li>)}</ul></section>
      <section className="surface-panel"><h2>当前 Run 待核对 · {runItems.length}</h2>
        <ul>{runItems.map(({ task, run }) => <li key={run.id} data-testid={`attention-run-${run.id}`}>
          <strong>{task.title} · Run {run.status}</strong>
          <p>Project {task.projectId ?? "未关联"} · Task {task.id} · Run {run.id}</p>
          <p>{run.unresolvedOperationIds.length ? `未决 Operation：${run.unresolvedOperationIds.join("、")}。状态或外部效果须按原身份核对。` : ""}
            {run.pendingControlRequest ? `控制请求 ${run.pendingControlRequest.id}：${run.pendingControlRequest.status}。` : ""}</p>
          <p>下一步：<Link to={`/runs/${run.id}`}>打开原 Run 核对入口</Link>。切换视图不会完成控制或重试动作。</p></li>)}</ul></section>
      <section className="surface-panel"><h2>人工任务与受阻 Task · {taskItems.length}</h2>
        <ul>{taskItems.map((task) => <li key={task.id} data-testid={`attention-task-${task.id}`}>
          <strong>{task.title} · {taskStatusLabels[task.status]}</strong>
          <p>Project {task.projectId ?? "未归属"} · Task {task.id} · 任务 v{task.revision}</p>
          <p>等待原因：{task.waitingReason ?? (task.unresolvedBlockerIds.length ? `未决阻塞 ${task.unresolvedBlockerIds.join("、")}` : "服务端未给出具体原因")}。未提供可证实的延后影响。</p>
          <p>下一步：<Link to={`/tasks/${task.id}`}>打开任务核对当前状态</Link>{task.executorRunId && <>；<Link to={`/runs/${task.executorRunId}`}>查看当前 Run</Link></>}。</p></li>)}</ul></section>
    </>}
  </section>;
}
