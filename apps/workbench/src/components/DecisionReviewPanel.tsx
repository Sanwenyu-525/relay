import { useEffect, useRef, useState } from "react";
import {
  createCommandId, RelayApiError, type RelayApiClient, type RelayDecision, type RelayDecisionPremise,
  type RelayDecisionReview, type RelayHypothesis, type RelayKnowledge
} from "../api/relayClient";
import { describeLiveError, needsReceiptCheck } from "../lib/liveErrors";
import "./DecisionReviewPanel.css";

/**
 * 决定依据与复核（HTTP 契约 §10.72）。
 *
 * 前端只做登记与判断，不复制服务端状态：
 * - 依据变化检测、候选去重、修订冲突和过期判断全部由服务端在命令事务内完成；
 * - 本面板只显示已读回的候选，并用用户明确理由提交处理。
 * 不自动处理任何候选，避免把「Agent 发现依据变了」当成「用户已批准决定仍成立」。
 */

type ReviewResolution = "KEEP_DECISION" | "DISMISS";

/** 提交时冻结的完整请求载荷；重试只能原样重放，不能从当前表单重新取值。 */
type PremiseDraft = {
  readonly decisionId: string;
  readonly expectedDecisionRevision: string;
  readonly statement: string;
  readonly source:
    | { readonly kind: "KNOWLEDGE"; readonly knowledgeId: string; readonly versionId: string; readonly versionLabel: string }
    | { readonly kind: "HYPOTHESIS"; readonly hypothesisId: string; readonly expectedRevision: string; readonly title: string };
};
type ResolveDraft = {
  readonly candidateId: string;
  readonly expectedRevision: string;
  readonly action: ReviewResolution;
  readonly reason: string;
};
type UnknownCommand =
  | { readonly kind: "PREMISE"; readonly id: string; readonly draft: PremiseDraft; readonly reason: string }
  | { readonly kind: "RESOLVE"; readonly id: string; readonly draft: ResolveDraft; readonly reason: string };
type SourceKind = "KNOWLEDGE" | "HYPOTHESIS";
type KnowledgeVersionChoice = { readonly knowledgeId: string; readonly versionId: string; readonly label: string };

const reviewStatusLabels: Record<RelayDecisionReview["status"], string> = {
  PENDING: "待判断",
  KEPT: "已确认依据仍支持决定",
  DISMISSED: "已忽略本次变化"
};

function commandFailure(commandId: string, caught: unknown): { message: string; uncertain: boolean } {
  const message = describeLiveError(caught).message;
  if (needsReceiptCheck(caught)) {
    return { message: `${message} 原 command_id：${commandId}；提交载荷已冻结，先查询回执，查不到时可用同一命令重试。`, uncertain: true };
  }
  return { message, uncertain: false };
}

function receiptText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function draftSummary(draft: PremiseDraft | ResolveDraft): string {
  if ("statement" in draft) {
    const source = draft.source.kind === "KNOWLEDGE"
      ? `资料版本 ${draft.source.versionLabel}`
      : `假设「${draft.source.title}」`;
    return `${source} · 决定修订 ${draft.expectedDecisionRevision} · 前提「${draft.statement.slice(0, 40)}${draft.statement.length > 40 ? "…" : ""}」`;
  }
  return `候选 ${draft.candidateId} · ${draft.action === "KEEP_DECISION" ? "依据仍支持决定" : "忽略本次变化"} · 修订 ${draft.expectedRevision}`;
}

/** 把来源快照压成可比较的阅读事实；不把原始 JSON 直接铺给用户。 */
function snapshotText(ref: Readonly<Record<string, unknown>>, label: string): string {
  const kind = ref.kind;
  if (kind === "KNOWLEDGE") {
    const version = ref.version === undefined ? "无" : String(ref.version);
    const status = ref.status === undefined ? "未知" : String(ref.status);
    const availability = ref.availability === undefined ? "未知" : String(ref.availability);
    return `${label}：资料 v${version} · ${status}/${availability}`;
  }
  if (kind === "HYPOTHESIS") {
    const version = ref.version === undefined ? "无" : String(ref.version);
    const applicable = ref.user_conclusion_applicable === true ? "用户结论仍适用" : "用户结论需重判";
    return `${label}：假设 v${version} · ${applicable}`;
  }
  return `${label}：${kind === undefined ? "无来源快照" : String(kind)}`;
}

/** 读取失败与命令结果未知是两种语义：读取不涉及 command ID，不能提示「按原命令核对」。 */
function readFailureText(caught: unknown): string {
  if (caught instanceof RelayApiError) return caught.problem.detail;
  return "读取请求未完成（网络或服务暂不可用），请重新读取。";
}

export default function DecisionReviewPanel({ client, projectId, decision }:
  { readonly client: RelayApiClient; readonly projectId: string; readonly decision: RelayDecision }) {
  const [premises, setPremises] = useState<readonly RelayDecisionPremise[]>([]);
  const [reviews, setReviews] = useState<readonly RelayDecisionReview[]>([]);
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<UnknownCommand | null>(null);
  const [checking, setChecking] = useState(false);
  const [receiptNote, setReceiptNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const readVersion = useRef(0);
  const sourceVersion = useRef(0);
  const sourceListVersion = useRef(0);
  const knowledgeIdRef = useRef("");
  const disposed = useRef(false);

  const [formOpen, setFormOpen] = useState(false);
  const [sourceKind, setSourceKind] = useState<SourceKind>("KNOWLEDGE");
  const [knowledgeItems, setKnowledgeItems] = useState<readonly RelayKnowledge[] | null>(null);
  const [knowledgeId, setKnowledgeId] = useState("");
  const [knowledgeVersion, setKnowledgeVersion] = useState<KnowledgeVersionChoice | null>(null);
  const [hypothesisItems, setHypothesisItems] = useState<readonly RelayHypothesis[] | null>(null);
  const [hypothesisId, setHypothesisId] = useState("");
  const [statement, setStatement] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      // 卸载或切换工作空间后，任何在途来源请求都不得再落状态。
      sourceVersion.current += 1;
      sourceListVersion.current += 1;
    };
  }, []);

  async function load(): Promise<void> {
    const version = ++readVersion.current;
    setReading(true);
    setReadError(null);
    try {
      const [premiseResult, reviewResult] = await Promise.all([
        client.getDecisionPremises(decision.id),
        client.getProjectDecisionReviews(projectId)
      ]);
      if (version !== readVersion.current) return;
      setPremises(premiseResult.items);
      setReviews(reviewResult.items.filter((item) => item.decisionId === decision.id));
    } catch (caught) {
      if (version === readVersion.current) setReadError(readFailureText(caught));
    } finally {
      if (version === readVersion.current) setReading(false);
    }
  }

  useEffect(() => {
    setPremises([]);
    setReviews([]);
    setPending(null);
    setReceiptNote(null);
    setNotice(null);
    setActionError(null);
    setFormOpen(false);
    setStatement("");
    setConfirmed(false);
    setKnowledgeId("");
    knowledgeIdRef.current = "";
    setKnowledgeVersion(null);
    setHypothesisId("");
    setReasons({});
    sourceVersion.current += 1;
    sourceListVersion.current += 1;
    void load();
    // load 只依赖这两个身份；decision 修订等变化由服务端校验，不在前端复制基线。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId, decision.id]);

  function resetPremiseForm(): void {
    setFormOpen(false);
    setStatement("");
    setConfirmed(false);
    setKnowledgeId("");
    knowledgeIdRef.current = "";
    setKnowledgeVersion(null);
    setHypothesisId("");
  }

  async function openForm(): Promise<void> {
    if (formOpen) return;
    setFormOpen(true);
    setActionError(null);
    setNotice(null);
    const request = ++sourceListVersion.current;
    setSourceBusy(true);
    try {
      const [knowledge, hypothesisResult] = await Promise.all([
        client.getKnowledge(projectId),
        client.getProjectHypotheses(projectId)
      ]);
      if (disposed.current || request !== sourceListVersion.current) return;
      setKnowledgeItems(knowledge.filter((item) => item.status === "ACTIVE"));
      setHypothesisItems(hypothesisResult.items);
    } catch (caught) {
      if (disposed.current || request !== sourceListVersion.current) return;
      setActionError(`读取可登记依据失败：${describeLiveError(caught).message}`);
    } finally {
      if (!disposed.current && request === sourceListVersion.current) setSourceBusy(false);
    }
  }

  async function chooseKnowledge(id: string): Promise<void> {
    const request = ++sourceVersion.current;
    knowledgeIdRef.current = id;
    setKnowledgeId(id);
    // 切换资料立即作废旧版本；旧响应即使晚到也不能再写回。
    setKnowledgeVersion(null);
    setReceiptNote(null);
    if (!id) return;
    setSourceBusy(true);
    setActionError(null);
    try {
      const versions = await client.getKnowledgeVersions(id);
      if (disposed.current || request !== sourceVersion.current || knowledgeIdRef.current !== id) return;
      const current = knowledgeItems?.find((item) => item.id === id);
      const version = versions.find((item) => item.version === current?.currentVersion) ?? versions.at(-1);
      if (version === undefined) throw new Error("该资料没有可登记版本。");
      if (version.knowledgeId !== id) throw new Error("资料版本与当前资料的标识不一致，已拒绝使用。");
      setKnowledgeVersion({ knowledgeId: id, versionId: version.id, label: `v${version.version}` });
    } catch (caught) {
      if (disposed.current || request !== sourceVersion.current || knowledgeIdRef.current !== id) return;
      setActionError(`读取资料版本失败：${describeLiveError(caught).message}`);
    } finally {
      if (!disposed.current && request === sourceVersion.current) setSourceBusy(false);
    }
  }

  async function submitPremise(): Promise<void> {
    if (busy || pending !== null || !confirmed) return;
    const trimmed = statement.trim();
    if (trimmed.length === 0 || trimmed.length > 4000) {
      setActionError("前提说明需要 1–4000 字。");
      return;
    }
    if (sourceKind === "KNOWLEDGE") {
      if (knowledgeId === "" || knowledgeVersion === null) {
        setActionError("请选择一条当前可读的资料版本作为依据。");
        return;
      }
      if (knowledgeVersion.knowledgeId !== knowledgeId) {
        setActionError("资料版本与当前选中的资料不一致，请重新选择。");
        return;
      }
    }
    const hypothesis = hypothesisItems?.find((item) => item.hypothesisId === hypothesisId);
    if (sourceKind === "HYPOTHESIS" && hypothesis === undefined) {
      setActionError("请选择一条当前项目假设作为依据。");
      return;
    }
    const commandId = createCommandId();
    setBusy(true);
    setActionError(null);
    setNotice(null);
    setReceiptNote(null);
    try {
      // 基准修订必须来自服务端当前事实：登记前提不推进决定修订，但决定可能已被其它命令改变。
      const fresh = await client.getDecision(decision.id);
      if (disposed.current) return;
      if (fresh.status !== "ACTIVE") throw new Error("只为当前有效的决定登记前提。");
      const draft: PremiseDraft = {
        decisionId: decision.id,
        expectedDecisionRevision: fresh.revision,
        statement: trimmed,
        source: sourceKind === "KNOWLEDGE"
          ? { kind: "KNOWLEDGE", knowledgeId, versionId: knowledgeVersion!.versionId, versionLabel: knowledgeVersion!.label }
          : { kind: "HYPOTHESIS", hypothesisId: hypothesis!.hypothesisId,
            expectedRevision: hypothesis!.revision, title: hypothesis!.title }
      };
      // 从这里开始，command_id 与业务参数一起冻结；重试只能重放这份 draft。
      await sendPremise(commandId, draft);
    } catch (caught) {
      if (!disposed.current) setActionError(describeLiveError(caught).message);
    } finally {
      if (!disposed.current) setBusy(false);
    }
  }

  async function sendPremise(commandId: string, draft: PremiseDraft): Promise<void> {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    setReceiptNote(null);
    try {
      await client.registerDecisionPremise({
        decisionId: draft.decisionId, commandId, expectedDecisionRevision: draft.expectedDecisionRevision,
        confirmed: true, statement: draft.statement,
        ...(draft.source.kind === "KNOWLEDGE"
          ? { knowledgeVersionId: draft.source.versionId }
          : { hypothesisId: draft.source.hypothesisId, expectedHypothesisRevision: draft.source.expectedRevision })
      });
      if (disposed.current) return;
      setPending(null);
      setNotice("已登记依据。来源版本或假设变化后，服务端会生成复核候选，不会自动改变决定。");
      resetPremiseForm();
      await load();
    } catch (caught) {
      if (disposed.current) return;
      const failure = commandFailure(commandId, caught);
      if (!failure.uncertain) {
        setPending(null);
        setActionError(failure.message);
        return;
      }
      const unknown: UnknownCommand = { kind: "PREMISE", id: commandId, draft, reason: failure.message };
      setPending(unknown);
      await checkReceipt(unknown);
    } finally {
      if (!disposed.current) setBusy(false);
    }
  }

  async function resolve(review: RelayDecisionReview, action: ReviewResolution): Promise<void> {
    if (busy || pending !== null) return;
    const reason = (reasons[review.id] ?? "").trim();
    if (reason.length === 0 || reason.length > 4000) {
      setActionError("处理复核需要 1–4000 字的理由。");
      return;
    }
    const draft: ResolveDraft = { candidateId: review.id, expectedRevision: review.revision, action, reason };
    await sendResolve(createCommandId(), draft);
  }

  async function sendResolve(commandId: string, draft: ResolveDraft): Promise<void> {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    setReceiptNote(null);
    try {
      await client.resolveDecisionReview({ candidateId: draft.candidateId, commandId,
        expectedRevision: draft.expectedRevision, action: draft.action, reason: draft.reason });
      if (disposed.current) return;
      setPending(null);
      setNotice(draft.action === "KEEP_DECISION"
        ? "已确认依据仍支持决定；核对基线推进到本次来源。"
        : "已忽略本次变化；决定本身未被修改。");
      await load();
    } catch (caught) {
      if (disposed.current) return;
      const failure = commandFailure(commandId, caught);
      if (!failure.uncertain) {
        setPending(null);
        setActionError(failure.message);
        return;
      }
      const unknown: UnknownCommand = { kind: "RESOLVE", id: commandId, draft, reason: failure.message };
      setPending(unknown);
      await checkReceipt(unknown);
    } finally {
      if (!disposed.current) setBusy(false);
    }
  }

  /**
   * 未知结果优先核对回执。回执里的命令类型和业务身份必须同时对上，
   * 否则不能把另一条命令的结果当成本次提交已生效。
   */
  async function checkReceipt(target: UnknownCommand): Promise<void> {
    if (checking) return;
    setChecking(true);
    setReceiptNote(null);
    setActionError(null);
    try {
      const receipt = await client.getCommandReceipt(target.id);
      if (disposed.current) return;
      if (receipt.commandId !== target.id) {
        setReceiptNote("原命令回执的 command_id 不一致，不能当作本次提交已生效。");
        return;
      }
      if (target.kind === "PREMISE") {
        if (receipt.commandType !== "RegisterDecisionPremise") {
          setReceiptNote(`原命令回执的类型是 ${receipt.commandType}，不是登记决定前提；不能当作本次登记已生效。`);
          return;
        }
        const decisionId = receiptText(receipt.result.decision_id);
        const resultProjectId = receiptText(receipt.result.project_id);
        if (decisionId !== target.draft.decisionId || resultProjectId !== projectId) {
          setReceiptNote("原命令回执属于另一个决定或项目，不能当作本次登记已生效。");
          return;
        }
        setPending(null);
        setNotice("原命令回执已核对：依据已登记，服务端后续会按来源变化生成复核候选。");
        resetPremiseForm();
        await load();
        return;
      }
      if (receipt.commandType !== "ResolveDecisionReview") {
        setReceiptNote(`原命令回执的类型是 ${receipt.commandType}，不是处理决定复核；不能当作本次处理已生效。`);
        return;
      }
      const candidateId = receiptText(receipt.result.candidate_id);
      const resultProjectId = receiptText(receipt.result.project_id);
      const expectedStatus = target.draft.action === "KEEP_DECISION" ? "KEPT" : "DISMISSED";
      if (candidateId !== target.draft.candidateId || resultProjectId !== projectId
        || receipt.result.status !== expectedStatus) {
        setReceiptNote("原命令回执与本次候选或处理动作不一致，不能当作本次处理已生效。");
        return;
      }
      setPending(null);
      setNotice(target.draft.action === "KEEP_DECISION"
        ? "原命令回执已核对：依据仍支持决定，核对基线已推进。"
        : "原命令回执已核对：本次变化已忽略，决定未被修改。");
      await load();
    } catch (caught) {
      if (disposed.current) return;
      if (caught instanceof RelayApiError && caught.problem.status === 404) {
        setReceiptNote("原命令回执尚查不到（可能仍在提交或尚未可见）。这不证明命令没有提交；可继续查询，或用同一 command_id 与冻结载荷重试。");
      } else {
        setReceiptNote(`回执查询未完成：${describeLiveError(caught).message}`);
      }
    } finally {
      if (!disposed.current) setChecking(false);
    }
  }

  function retryPending(): void {
    if (busy || checking || pending === null) return;
    if (pending.kind === "PREMISE") void sendPremise(pending.id, pending.draft);
    else void sendResolve(pending.id, pending.draft);
  }

  /** 明确放弃核对时，下一次提交会生成新 command_id；界面先把可能的重复风险说清楚。 */
  function abandonPending(): void {
    if (busy || checking || pending === null) return;
    setPending(null);
    setReceiptNote(null);
    setNotice("已放弃核对原命令；原命令仍可能已在服务端提交。下一次提交会生成新的 command_id，请先确认不会因此重复登记前提或重复处理候选。");
  }

  const pendingReviews = reviews.filter((review) => review.status === "PENDING");
  const applicableReviews = pendingReviews.filter((review) => review.applicable);
  const handledReviews = reviews.filter((review) => review.status !== "PENDING");
  const premiseSource = (premise: RelayDecisionPremise) => premise.knowledgeId !== null
    ? `资料 ${premise.knowledgeId}`
    : premise.hypothesisId !== null ? `假设 ${premise.hypothesisId}` : "无来源";

  return <section className="decision-review" data-testid="decision-review-panel" aria-label="决定依据与复核">
    <header className="decision-review__heading">
      <div>
        <h3>决定依据与复核</h3>
        <p className="helper-text">依据变化只生成复核候选，不自动改写决定、任务或验收。</p>
      </div>
      <span className="decision-review__badge" data-testid="decision-review-pending-count">
        {applicableReviews.length} 项待判断
      </span>
    </header>

    {readError && <p className="action-error" role="alert" data-testid="decision-review-read-error">
      读取决定依据失败：{readError} <button type="button" className="text-button" onClick={() => { void load(); }}>重新读取</button>
    </p>}
    {reading && <p className="helper-text" role="status">正在读取决定依据与复核候选…</p>}
    {actionError && <p className="action-error" role="alert" data-testid="decision-review-action-error">{actionError}</p>}
    {notice && <p className="receipt-message" role="status" data-testid="decision-review-notice">{notice}</p>}
    {pending && <div className="decision-review__pending warning-callout" data-testid="decision-review-pending">
      <p>提交结果未知：<strong>原 command_id {pending.id}</strong> 已冻结提交载荷（{draftSummary(pending.draft)}）。</p>
      <p className="helper-text">
        先查回执；查不到时只能用同一命令与冻结载荷重试。修改下方表单只会影响之后的新请求，
        不会改变本次重试发送的载荷。
      </p>
      <div className="knowledge-actions">
        <button type="button" className="secondary-button" disabled={busy || checking}
          data-testid="decision-review-receipt"
          onClick={() => { void checkReceipt(pending); }}>{checking ? "正在查询回执" : "查询原命令回执"}</button>
        <button type="button" className="primary-button" disabled={busy || checking}
          data-testid="decision-review-retry" onClick={retryPending}>按原命令重试（冻结载荷）</button>
        <button type="button" className="text-button" disabled={busy || checking}
          data-testid="decision-review-abandon" onClick={abandonPending}>放弃核对，按当前表单新建请求</button>
      </div>
      {receiptNote && <p className="helper-text" role="status" data-testid="decision-review-receipt-note">{receiptNote}</p>}
    </div>}

    {!reading && !readError && <>
      <section className="decision-review__premises">
        <div className="decision-review__section-head">
          <h4>已登记依据 · {premises.length}</h4>
          {decision.status === "ACTIVE" && <button type="button" className="secondary-button"
            data-testid="decision-premise-open" disabled={busy} onClick={() => { void openForm(); }}>
            {formOpen ? "收起登记" : "登记依据"}
          </button>}
        </div>
        {premises.length === 0
          ? <p className="helper-text" data-testid="decision-premise-empty">还没有登记依据；未登记时无法识别依据变化。</p>
          : <ul className="decision-review__list">{premises.map((premise) => <li key={premise.id} className="decision-review__item"
            data-testid={`decision-premise-${premise.id}`}>
            <p>{premise.statement}</p>
            <p className="helper-text">{premiseSource(premise)} · 登记时决定修订 {premise.decisionRevision}</p>
          </li>)}</ul>}
      </section>

      {formOpen && decision.status === "ACTIVE" && <section className="decision-review__form" data-testid="decision-premise-form">
        <p className="helper-text" data-testid="decision-premise-source-state">
          {sourceBusy ? "正在读取当前项目的可登记来源…"
            : `可登记：${knowledgeItems?.length ?? 0} 份当前资料 · ${hypothesisItems?.length ?? 0} 条项目假设。`}
        </p>
        <div className="decision-review__source-toggle" role="group" aria-label="依据来源类型">
          <button type="button" className={sourceKind === "KNOWLEDGE" ? "primary-button" : "secondary-button"}
            data-testid="decision-premise-source-knowledge" disabled={busy}
            onClick={() => { setSourceKind("KNOWLEDGE"); setHypothesisId(""); }}>资料版本</button>
          <button type="button" className={sourceKind === "HYPOTHESIS" ? "primary-button" : "secondary-button"}
            data-testid="decision-premise-source-hypothesis" disabled={busy}
            onClick={() => {
              // 来源类型切换后，旧资料的版本选择及其在途响应都不再适用。
              sourceVersion.current += 1;
              knowledgeIdRef.current = "";
              setSourceKind("HYPOTHESIS");
              setKnowledgeId("");
              setKnowledgeVersion(null);
              setSourceBusy(false);
            }}>项目假设</button>
        </div>
        <label className="field"><span className="field-label">前提说明</span>
          <textarea value={statement} rows={3} maxLength={4000} disabled={busy}
            data-testid="decision-premise-statement"
            onChange={(event) => setStatement(event.target.value)} />
        </label>
        {sourceKind === "KNOWLEDGE"
          ? <>
            <label className="field"><span className="field-label">依据资料</span>
              <select value={knowledgeId} disabled={busy || sourceBusy}
                data-testid="decision-premise-knowledge"
                onChange={(event) => { void chooseKnowledge(event.target.value); }}>
                <option value="">选择当前项目资料</option>
                {knowledgeItems?.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
            <p className="helper-text" data-testid="decision-premise-version">
              {knowledgeVersion === null ? "选择资料后读取其当前版本。" : `已读取确切版本 ${knowledgeVersion.label}，提交前请核对。`}
            </p>
          </>
          : <label className="field"><span className="field-label">依据假设</span>
            <select value={hypothesisId} disabled={busy || sourceBusy} data-testid="decision-premise-hypothesis"
              onChange={(event) => setHypothesisId(event.target.value)}>
              <option value="">选择当前项目假设</option>
              {hypothesisItems?.map((item) => <option key={item.hypothesisId} value={item.hypothesisId}>
                {item.title} · v{item.version}
              </option>)}
            </select>
          </label>}
        <label className="knowledge-check"><input type="checkbox" checked={confirmed} disabled={busy}
          data-testid="decision-premise-confirmed"
          onChange={(event) => setConfirmed(event.target.checked)} />我已核对这条依据，确认以它作为决定前提</label>
        <div className="knowledge-actions">
          <button type="button" className="primary-button" disabled={busy || !confirmed || pending !== null}
            data-testid="decision-premise-submit"
            onClick={() => { void submitPremise(); }}>登记依据</button>
          <button type="button" className="secondary-button" disabled={busy}
            onClick={() => { setFormOpen(false); setActionError(null); }}>取消</button>
        </div>
      </section>}

      <section className="decision-review__reviews">
        <h4>待判断复核 · {applicableReviews.length}</h4>
        {pendingReviews.length === 0
          ? <p className="helper-text" data-testid="decision-review-empty">没有待判断的复核候选。</p>
          : <ul className="decision-review__list">{pendingReviews.map((review) => {
            const key = review.id;
            const reason = reasons[key] ?? "";
            return <li key={key} className="decision-review__item" data-testid={`decision-review-${key}`}
              data-applicable={review.applicable}>
              <strong>依据发生变化</strong>
              <p className="helper-text">{snapshotText(review.beforeRef, "登记时")} → {snapshotText(review.afterRef, "当前")}</p>
              <p>{review.question}</p>
              {review.applicable
                ? <>
                  <label className="field"><span className="field-label">处理理由（必填）</span>
                    <textarea value={reason} rows={2} maxLength={4000} disabled={busy}
                      data-testid={`decision-review-reason-${key}`}
                      onChange={(event) => setReasons((old) => ({ ...old, [key]: event.target.value }))} />
                  </label>
                  <div className="knowledge-actions">
                    <button type="button" className="primary-button" disabled={busy || pending !== null || reason.trim().length === 0}
                      data-testid={`decision-review-keep-${key}`}
                      onClick={() => { void resolve(review, "KEEP_DECISION"); }}>依据仍支持决定</button>
                    <button type="button" className="secondary-button" disabled={busy || pending !== null || reason.trim().length === 0}
                      data-testid={`decision-review-dismiss-${key}`}
                      onClick={() => { void resolve(review, "DISMISS"); }}>忽略本次变化</button>
                  </div>
                </>
                : <p className="helper-text" data-testid={`decision-review-stale-${key}`}>
                  依据已再次变化，当前候选不能处理；请按最新来源重新判断。刷新后会读取新候选。
                  <button type="button" className="text-button" disabled={busy} onClick={() => { void load(); }}>刷新</button>
                </p>}
            </li>;
          })}</ul>}
      </section>

      {handledReviews.length > 0 && <details className="decision-review__history" data-testid="decision-review-history">
        <summary>已处理的复核 · {handledReviews.length}</summary>
        <ul className="decision-review__list">{handledReviews.map((review) => <li key={review.id} className="decision-review__item">
          <strong>{reviewStatusLabels[review.status]}</strong>
          <p className="helper-text">{snapshotText(review.beforeRef, "当时")} → {snapshotText(review.afterRef, "变化")}</p>
          {review.reason && <p>理由：{review.reason}</p>}
          {review.resolvedAt && <p className="helper-text">处理时间 {review.resolvedAt}</p>}
        </li>)}</ul>
      </details>}
    </>}
  </section>;
}
