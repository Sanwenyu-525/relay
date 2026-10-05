import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Info, Target } from "lucide-react";
import { createCommandId, goalCreationFrom, RelayApiError, type RelayApiClient,
  type RelayGoalCreation } from "../api/relayClient";
import { describeLiveError } from "../lib/liveErrors";
import GoalProjectLinkPanel from "./GoalProjectLinkPanel";

/**
 * 轻量 Goal 创建入口（工作台 §18.7、总纲 §0.8、LC-01/LC-02）。
 *
 * 边界，按规格而不是按省步骤：
 * - 用户先表达想达到的结果，标题只是可修订的紧凑摘要，不要求先填整套表单。
 * - 保存走既有 CreateGoal 用例（Goal 的唯一 Owner），不新增端点、命令或第二套事实。
 * - 标题由输入确定性派生，用户可改；不调用模型编造期限、完成条件或授权。
 * - 创建 Goal **不隐式关联任何 Project**：关联是独立的 LinkProjectGoal 命令。
 *   本入口只登记作用域事实，不代替用户决定哪个 Project 属于这个 Goal。
 * - 响应丢失时按原 command_id 查回执，不换 ID 重建第二个 Goal。
 * - 这里不建立 Task、不改 Task 准入、不触碰权限或动作审批。
 */

type PendingGoalCommand = {
  readonly commandId: string;
  readonly title: string;
  readonly description: string;
};

/** 标题只是摘要：取首个非空行，限制在服务端允许的长度内，其余原话进 description。 */
function deriveTitle(input: string): string {
  const firstLine = input.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== "") ?? "";
  return firstLine.slice(0, 200);
}

/** 说明保存用户原话本身：不做摘要改写，也不丢掉首行之后的补充。 */
function deriveDescription(input: string): string {
  return input.trim().slice(0, 2000);
}

export default function CreateGoalView({ client, onCancel }: {
  client: RelayApiClient; onCancel: () => void }) {
  const [input, setInput] = useState("");
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [created, setCreated] = useState<RelayGoalCreation | null>(null);
  const [pending, setPending] = useState<PendingGoalCommand | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mayRetry, setMayRetry] = useState(false);
  const busyRef = useRef(false);
  const disposed = useRef(false);
  const scope = useRef(0);

  useEffect(() => () => { disposed.current = true; scope.current++; }, []);

  // 标题未被人改过时跟随输入派生；一旦改写就不再被输入覆盖。
  const effectiveTitle = titleTouched ? title.trim() : deriveTitle(input);
  const description = deriveDescription(input);
  const canSubmit = effectiveTitle !== "" && description !== "" && !busy;

  const finish = useCallback(async (creation: RelayGoalCreation, request: number, title: string) => {
    if (disposed.current || request !== scope.current) return;
    setPending(null); setMayRetry(false); setError(null); setBusy(false);
    // 标题取本次命令的原载荷，不回读 Goal：回执本身不带标题，凭空补值会变成编造事实。
    setCreated({ ...creation, title });
  }, []);

  /** 回执核对：只按原 command_id 读，不猜结果、不换 ID 重建。 */
  const checkReceipt = useCallback(async (command: PendingGoalCommand, request: number) => {
    try {
      const receipt = await client.getCommandReceipt(command.commandId);
      if (disposed.current || request !== scope.current) return;
      if (receipt.commandId !== command.commandId || receipt.commandType !== "CreateGoal") {
        throw new Error("原回执不是本次 CreateGoal。");
      }
      await finish(goalCreationFrom(receipt.result), request, command.title);
    } catch (caught) {
      if (disposed.current || request !== scope.current) return;
      if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
        setMayRetry(true);
        setError("服务端明确未找到原命令；只能用原 command ID 与原载荷重试。");
      } else setError(`Goal 回执仍不可核对；请保留原 command_id，不能创建第二个 Goal。${describeLiveError(caught).message}`);
    } finally {
      if (!disposed.current && request === scope.current) setBusy(false);
    }
  }, [client, finish]);

  const send = useCallback(async (command: PendingGoalCommand, request: number) => {
    if (disposed.current || request !== scope.current) return;
    setError(null); setMayRetry(false); setBusy(true);
    try {
      const creation = await client.createGoal({ commandId: command.commandId,
        title: command.title, description: command.description });
      await finish(creation, request, command.title);
    } catch (caught) {
      if (disposed.current || request !== scope.current) return;
      // 明确的业务拒绝可以改载荷重试；传输/5xx/冲突一律先核对，不换 ID 重建。
      if (caught instanceof RelayApiError && caught.problem.status < 500 &&
          caught.problem.status !== 409 && caught.problem.code !== "COMMAND_ID_REUSED") {
        setPending(null); setBusy(false); setError(describeLiveError(caught).message);
      } else {
        setError("Goal 提交结果不明；正在查询原 command_id 回执，不能换 ID 创建第二个 Goal。");
        await checkReceipt(command, request);
      }
    }
  }, [client, checkReceipt, finish]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // 同步闸：busy 状态在同一 tick 内尚未生效，靠它防不住双击提交出两条命令。
    if (busyRef.current || !canSubmit) return;
    busyRef.current = true;
    const request = ++scope.current;
    const command: PendingGoalCommand = { commandId: createCommandId(),
      title: effectiveTitle, description };
    setPending(command); setBusy(true);
    void send(command, request).finally(() => { busyRef.current = false; });
  }

  if (created !== null) return <section className="page-state" data-testid="goal-created">
    <p className="eyebrow">目标</p>
    <h1>已保存 Goal {created.goalId}</h1>
    <div className="goal-created-body">
      <p>状态 {created.status} · 修订 v{created.revision}。Goal 是工作空间级事实，
        目前还没有关联任何项目——关联是独立命令，由你在下面明确选择。</p>
    </div>
    <GoalProjectLinkPanel client={client} goalId={created.goalId} goalTitle={created.title} />
    <div className="form-actions">
      <button className="secondary-button" type="button" data-testid="goal-create-again"
        onClick={() => { setCreated(null); setInput(""); setTitle(""); setTitleTouched(false); }}>再记录一个目标</button>
      <button className="secondary-button" type="button" data-testid="goal-create-close" onClick={onCancel}>返回项目</button>
    </div>
  </section>;

  return <section className="skill-page" data-testid="goal-create-view">
    <div className="page-layout"><div className="page-primary">
      <header className="page-head">
        <p className="eyebrow"><Target aria-hidden="true" />目标</p>
        <h1>想达到什么结果？</h1>
        <p className="page-lede">先用一句话说明想达到的结果。标题只是可修订的摘要，
          不会替你编造期限、完成条件或授权。</p>
      </header>
      <form className="stack" data-testid="goal-form" onSubmit={submit}>
        <label className="field"><span className="field-label">这次想达到的结果</span>
          <textarea name="goal-intent" data-testid="goal-intent" rows={5} maxLength={2000} required
            value={input} disabled={busy}
            placeholder="例如：把毕业论文的实验部分跑通并整理成可提交的初稿"
            onChange={(event) => setInput(event.target.value)} /></label>
        <label className="field"><span className="field-label">标题（可改）</span>
          <input name="goal-title" data-testid="goal-title" maxLength={200} required
            value={effectiveTitle} disabled={busy}
            onChange={(event) => { setTitleTouched(true); setTitle(event.target.value); }} />
          <small className="helper-text">默认取你输入的首行。改写后不再被输入覆盖。</small></label>
        <p className="helper-text" data-testid="goal-scope-note"><Info aria-hidden="true" />
          保存只登记这个目标本身。关联项目、建立任务、交给 AI 执行都是各自的独立步骤，
          不会被这一步顺带完成。</p>
        <div className="form-actions">
          <button className="primary-button" type="submit" data-testid="goal-submit"
            disabled={!canSubmit}>{busy ? "正在保存" : "保存这个目标"}</button>
          <button className="secondary-button" type="button" data-testid="goal-cancel"
            disabled={busy} onClick={onCancel}>取消</button>
        </div>
      </form>
      {error && <p className="action-error" role="alert" data-testid="goal-error">{error}</p>}
      {pending !== null && <div className="warning-callout" data-testid="goal-pending">
        <strong>Goal 命令待核对</strong>
        <p>原 command ID：{pending.commandId}。核对前不会创建另一个 Goal。</p>
        <button className="secondary-button" type="button" data-testid="goal-receipt" disabled={busy}
          onClick={() => { const request = scope.current; setBusy(true); void checkReceipt(pending, request); }}>查询原命令回执</button>
        {mayRetry && <button className="secondary-button" type="button" data-testid="goal-retry" disabled={busy}
          onClick={() => { const request = ++scope.current; setBusy(true); void send(pending, request); }}>用原 ID 和原载荷重试</button>}
      </div>}
    </div>
    <div className="page-rail"><div className="rail-content">
      <h2 className="rail-heading">为什么先不填完整表单</h2>
      <p className="rail-intro">内部必须保存的结构化信息，不等于必须由你逐字段填写。
        这里只保存目标的标题与说明；完整 Task 表单仍是详细编辑入口。</p>
      <p className="helper-text"><Link className="inline-link" to="/projects">返回项目</Link></p>
    </div></div>
    </div>
  </section>;
}
