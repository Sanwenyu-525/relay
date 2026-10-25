import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Info, Target } from "lucide-react";
import { createCommandId, goalCreationFrom, RelayApiError, type RelayApiClient,
  type RelayGoalCreation } from "../api/relayClient";
import { clearDraftGuard, setDraftGuard, type DraftGuard } from "../lib/draftGuard";
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

/** 待核对命令按 API/Workspace 作用域暂存：整页重开后仍能继续核对原 ID（#20）。 */
function goalPendingKey(client: RelayApiClient): string {
  return `relay:create-goal:${client.baseUrl}:${client.workspaceId}`;
}

function readGoalPending(key: string): PendingGoalCommand | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    if (typeof row.commandId !== "string" || row.commandId === "" ||
      typeof row.title !== "string" || typeof row.description !== "string") return null;
    return { commandId: row.commandId, title: row.title, description: row.description };
  } catch { return null; }
}

function saveGoalPending(key: string, pending: PendingGoalCommand | null): void {
  try {
    if (pending) sessionStorage.setItem(key, JSON.stringify(pending));
    else sessionStorage.removeItem(key);
  } catch { /* 会话存储不可用只影响整页重开后的恢复；页内待核对状态不受影响。 */ }
}

/** 标题只是摘要：取首个非空行，限制在服务端允许的长度内，其余原话进 description。 */
function deriveTitle(input: string): string {
  const firstLine = input.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== "") ?? "";
  return firstLine.slice(0, 200);
}

/** 说明保存用户原话本身：不做摘要改写，也不丢掉首行之后的补充。 */
function deriveDescription(input: string): string {
  return input.trim().slice(0, 2000);
}

/** 2xx 只说明服务端回了一个响应；回执身份与新建语义仍要逐项和冻结命令对齐。 */
class GoalCreationMismatch extends Error {}

function verifiedGoalCreation(command: PendingGoalCommand,
  envelope: { readonly commandId: string; readonly result: Readonly<Record<string, unknown>> }): RelayGoalCreation {
  if (envelope.commandId !== command.commandId) {
    throw new GoalCreationMismatch("回执 command_id 与原命令不一致。");
  }
  const creation = goalCreationFrom(envelope.result);
  if (creation.status !== "ACTIVE") {
    throw new GoalCreationMismatch(`回执状态为 ${creation.status}，不是新建 Goal 的 ACTIVE。`);
  }
  // `goals.revision` 的数据库默认值是 0；新建回执不是 v0 说明它不属于这次新建。
  if (creation.revision !== "0") {
    throw new GoalCreationMismatch(`回执修订 v${creation.revision}，不是新建 Goal 的 v0。`);
  }
  return creation;
}

export default function CreateGoalView({ client, onCancel }: {
  client: RelayApiClient; onCancel: () => void }) {
  const [input, setInput] = useState("");
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [created, setCreated] = useState<RelayGoalCreation | null>(null);
  const [pending, setPending] = useState<PendingGoalCommand | null>(null);
  const pendingRef = useRef<PendingGoalCommand | null>(null);
  const holdPending = useCallback((next: PendingGoalCommand | null) => {
    pendingRef.current = next; setPending(next);
    saveGoalPending(goalPendingKey(client), next);
  }, [client]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mayRetry, setMayRetry] = useState(false);
  const busyRef = useRef(false);
  const disposed = useRef(false);
  const scope = useRef(0);

  useEffect(() => () => { disposed.current = true; scope.current++; }, []);

  // 待核对命令无法靠「丢弃」收口：只能核对回执或明确拒绝后解除；但原 ID 已按
  // API/Workspace 作用域暂存（#20），离开后回本页仍可核对，守卫弹层据此提供离开出口。
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

  // 整页重开或父页重新挂载后，按当前 API/Workspace 作用域恢复原待核对命令。
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const stored = readGoalPending(goalPendingKey(client));
    if (stored !== null && pendingRef.current === null) {
      pendingRef.current = stored; setPending(stored);
    }
  }, [client]);

  // 标题未被人改过时跟随输入派生；一旦改写就不再被输入覆盖。
  const effectiveTitle = titleTouched ? title.trim() : deriveTitle(input);
  const description = deriveDescription(input);
  const canSubmit = effectiveTitle !== "" && description !== "" && !busy;

  const finish = useCallback(async (creation: RelayGoalCreation, request: number, title: string) => {
    if (disposed.current || request !== scope.current) return;
    holdPending(null); setMayRetry(false); setError(null); setBusy(false);
    // 标题取本次命令的原载荷，不回读 Goal：回执本身不带标题，凭空补值会变成编造事实。
    setCreated({ ...creation, title });
  }, [holdPending]);

  /** 回执核对：只按原 command_id 读，不猜结果、不换 ID 重建。 */
  const checkReceipt = useCallback(async (command: PendingGoalCommand, request: number) => {
    try {
      const receipt = await client.getCommandReceipt(command.commandId);
      if (disposed.current || request !== scope.current) return;
      if (receipt.commandType !== "CreateGoal") {
        throw new GoalCreationMismatch("原回执不是本次 CreateGoal。");
      }
      await finish(verifiedGoalCreation(command, receipt), request, command.title);
    } catch (caught) {
      if (disposed.current || request !== scope.current) return;
      if (caught instanceof GoalCreationMismatch) {
        setError(`Goal 回执与本次命令不匹配：${caught.message}已保留原 command_id，不能创建第二个 Goal。`);
      } else if (caught instanceof RelayApiError && caught.problem.code === "COMMAND_NOT_FOUND") {
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
      const envelope = await client.createGoal({ commandId: command.commandId,
        title: command.title, description: command.description });
      await finish(verifiedGoalCreation(command, envelope), request, command.title);
    } catch (caught) {
      if (disposed.current || request !== scope.current) return;
      // 响应与冻结命令错配时不宣布成功、不清 pending，也不自动换 ID 重建。
      if (caught instanceof GoalCreationMismatch) {
        setBusy(false);
        setError(`Goal 创建响应与本次命令不匹配：${caught.message}已保留原 command_id，不能创建第二个 Goal。`);
        return;
      }
      // 明确的业务拒绝可以改载荷重试；传输/5xx/冲突一律先核对，不换 ID 重建。
      if (caught instanceof RelayApiError && caught.problem.status < 500 &&
          caught.problem.status !== 409 && caught.problem.code !== "COMMAND_ID_REUSED") {
        holdPending(null); setBusy(false); setError(describeLiveError(caught).message);
      } else {
        setError("Goal 提交结果不明；正在查询原 command_id 回执，不能换 ID 创建第二个 Goal。");
        await checkReceipt(command, request);
      }
    }
  }, [client, checkReceipt, finish]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // 原命令未收口前，普通提交不得开始新命令（#20）：先按原 pending 拒绝，
    // 按钮保持可用是为了让「保存」的拒绝发生在 handler，而不是只靠置灰外观。
    if (pendingRef.current !== null) {
      setError("已有待核对的 Goal 命令（见下方原 command ID）；核对回执或原样重试收口前，不会创建第二个 Goal。");
      return;
    }
    // 同步闸：busy 状态在同一 tick 内尚未生效，靠它防不住双击提交出两条命令。
    if (busyRef.current || !canSubmit) return;
    busyRef.current = true;
    const request = ++scope.current;
    const command: PendingGoalCommand = { commandId: createCommandId(),
      title: effectiveTitle, description };
    holdPending(command); setBusy(true);
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
