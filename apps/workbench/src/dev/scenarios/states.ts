import type { RelayRunToolCall } from "../../api/dtos/assist";
import {
  approvalReview, at as stamp, commandResult, fileChange, labRun, readCall, runCall, runProjection,
  sessionCall
} from "../scenarioFixtures";
import type { ScenarioWorld } from "../scenarioWorld";
import {
  at, attr, closedWorld, count, frame, gone, ledgerKey, leftEdgeAligned, linkedComponent, liveWorld, make,
  motionCount, noDuplicateRows, notText, openTrace, RUN_ROW, runCallId, runPanelComponent, runSummaryComponent,
  sel, SESSION_ROW, sessionCallId, sessionComponent, text, toggleRow, toggleRunRow, toggleSummaryRow, visible
} from "./common";

/**
 * D 组 · 执行状态（矩阵 16 条 + 补充 10 条）。
 *
 * 这一组只做一件事：**把真实状态词表逐档验一遍**，不自造第八种状态，也不把某一档说成别的意思。
 *
 *   * 会话侧词表：`REQUESTED / SETTLED / REJECTED / ABANDONED / UNKNOWN`（没有结果正文这一列）。
 *   * Run 侧词表：`REQUESTED / PREPARED / WAITING_APPROVAL / SETTLED / REJECTED / ABANDONED`
 *     （没有 UNKNOWN——未知是会话账本的既有档）。
 *
 * 两侧对同一档的措辞不同是有意的：会话侧的 REQUESTED 已经在派发了，Run 侧的 REQUESTED 还没连上
 * 动作身份，所以一个是「尚未结算」，一个是「尚未派发」。D04 与 X19 直接把两套措辞各自钉住，
 * 这样将来有人把两处合并成一句话时会立刻失败。
 *
 * 三条不许越界的口径：`SETTLED` 不等于成功、`REJECTED/ABANDONED` 不等于执行失败、
 * `UNKNOWN` 既不成功也不失败；审批四态（待批/过期/已批/读不到）都不说「已执行」。
 */

const PATH = "apps/workbench/package.json";
const WRITE_PATH = "src/lib/order.ts";

/** Run 侧一次调用的世界：轨迹面板与摘要面板读的是同一份事实。 */
function runWorld(call: RelayRunToolCall, extra: Partial<ScenarioWorld> = {}): Partial<ScenarioWorld> {
  return { run: labRun(), runToolCalls: runProjection([[call]]), ...extra };
}

export const STATES = [
  make({
    id: "D04", title: "工具已请求但未结算", host: "SESSION", stateKind: "在途",
    component: sessionComponent,
    note: "在途整块只有一个主进度动效：转动的行优先，标题图标在该行不存在时才转。",
    steps: frame("一条还没结算的 read_file 请求", liveWorld(sessionCall(0, {
      toolName: "read_file", args: { relative_path: PATH }, status: "REQUESTED" }))),
    checks: [
      visible("调用行在场", sel.call(sessionCallId(0))),
      text("状态词是已请求尚未结算", sel.call(sessionCallId(0)), "已请求，尚未结算"),
      attr("状态原样透出", `${sel.call(sessionCallId(0))} .activity-item-state`, "data-status", "REQUESTED"),
      attr("视觉档是在途", sel.call(sessionCallId(0)), "data-tone", "active"),
      attr("这一行是此刻正在做的那一件", sel.call(sessionCallId(0)), "data-current", "true"),
      count("没结算就不报耗时", `${sel.call(sessionCallId(0))} .activity-item-elapsed`, 0),
      motionCount("全场只有一个转动的主进度动效", 1),
      text("在途标题不宣布结束", sel.traceActivity(), "正在执行"),
      noDuplicateRows
    ]
  }),

  make({
    id: "X19", title: "工具已请求（Run 侧措辞与会话侧不同）", host: "RUN_TRAJECTORY", stateKind: "在途",
    component: runPanelComponent,
    note: "与 D04 的措辞差别是有意的：Run 侧这一档还没绑定动作身份，说「正在执行」会夸大。",
    steps: frame("一条尚未派发的 Run 工具请求", runWorld(runCall(0, {
      toolName: "read_file", args: { relative_path: PATH }, status: "REQUESTED", operationId: null }))),
    checks: [
      visible("调用卡片在场", sel.runCall(runCallId(0))),
      text("状态词是尚未派发", `${sel.runCall(runCallId(0))} .trajectory-status`, "已请求，尚未派发"),
      attr("状态原样透出", `${sel.runCall(runCallId(0))} .trajectory-status`, "data-status", "REQUESTED"),
      text("统计把它算进未决而不是已结算", sel.runCounts(), "正在执行或结果未决 1"),
      text("已结算数如实为零", sel.runCounts(), "已结算 0"),
      visible("归入「没有结算结果」这一类", sel.runFailure(runCallId(0))),
      text("既不宣布成功也不宣布失败", sel.runFailure(runCallId(0)), "不能当成成功或失败"),
      visible("证据未绑定的开发注记常驻", sel.runEvidenceNote()),
      notText("轨迹里绝不出现验证通过", sel.runPanel(), "验证通过")
    ],
    interactions: toggleRunRow(runCallId(0), [
      text("没有结果正文就明说", sel.runNoResult(runCallId(0)), "不能据此推断成功或失败")])
  }),

  make({
    id: "D05", title: "工具已准备但未执行", host: "RUN_TRAJECTORY", stateKind: "在途",
    component: runPanelComponent,
    steps: frame("检查已派发，等待回执", runWorld(runCall(0, {
      toolName: "run_check", args: { check_id: "typecheck" }, status: "PREPARED" }))),
    checks: [
      visible("调用卡片在场", sel.runCall(runCallId(0))),
      text("状态词是执行中或结果未决", `${sel.runCall(runCallId(0))} .trajectory-status`,
        "执行中或结果未决，尚无结算结果"),
      attr("状态原样透出", `${sel.runCall(runCallId(0))} .trajectory-status`, "data-status", "PREPARED"),
      text("仍算未决而不是已结算", sel.runCounts(), "正在执行或结果未决 1"),
      notText("已派发不等于已结算", sel.runCounts(), "已结算 1")
    ],
    interactions: toggleRunRow(runCallId(0), [
      text("动作身份逐字来自账本", sel.runCall(runCallId(0)), "mock-op-1"),
      text("没有结果就说不推断", sel.runNoResult(runCallId(0)), "这次调用没有结果内容")])
  }),

  make({
    id: "D06", title: "工具等待审批", host: "RUN_TRAJECTORY", stateKind: "审批",
    component: runPanelComponent,
    note: "审批按 operation_id 对齐既有 ACTION_APPROVAL 记录；实验室只显示状态，不提交任何决定。",
    steps: frame("写入动作等待人工批准（OPEN 审批记录）", runWorld(
      runCall(0, { toolName: "apply_changeset",
        args: { changes: [{ path: WRITE_PATH, action: "MODIFY" }] },
        status: "WAITING_APPROVAL" }),
      { reviews: [approvalReview("mock-op-1")] })),
    checks: [
      text("状态词是等待你批准", `${sel.runCall(runCallId(0))} .trajectory-status`, "等待你批准"),
      attr("状态原样透出", `${sel.runCall(runCallId(0))} .trajectory-status`, "data-status", "WAITING_APPROVAL"),
      visible("审批一栏在场", sel.runApproval(runCallId(0))),
      text("审批说清等待并对齐到具体 Review", sel.runApproval(runCallId(0)), "Review mock-review-mock-op-1"),
      text("同时给出绑定目标摘要", sel.runApproval(runCallId(0)), "绑定目标摘要"),
      notText("待批绝不写成已批准", sel.runApproval(runCallId(0)), "已批准"),
      text("统计单列等待批准", sel.runCounts(), "等待批准 1"),
      text("这一档不进已结算", sel.runCounts(), "已结算 0")
    ],
    interactions: [{
      kind: "click", selector: sel.runExpand(runCallId(0)), label: "展开这次待批调用的参数与回执",
      then: [visible("参数已挂载", sel.runArgs(runCallId(0))),
        text("参数里能看到要改的确切路径", sel.runArgs(runCallId(0)), "src/lib/order.ts"),
        visible("审批说明在展开后仍在", sel.runApproval(runCallId(0)))] }
    ]
  }),

  make({
    id: "X20", title: "工具等待审批（摘要侧给去原审批的入口）",
    host: "RUN_SUMMARY", stateKind: "审批", component: runSummaryComponent,
    steps: frame("摘要统计把等待批准单独标出来", runWorld(
      runCall(0, { toolName: "apply_changeset",
        args: { changes: [{ path: WRITE_PATH, action: "MODIFY" }] },
        status: "WAITING_APPROVAL" }),
      { reviews: [approvalReview("mock-op-1")] })),
    checks: [
      text("统计单列一项等待批准", sel.summary(), "1 项等待你批准"),
      count("等待批准单独占一枚标签", ".execution-count[data-tone=\"attention\"]", 1),
      visible("给出批准入口链接", sel.summaryWaitingLink()),
      attr("链接精确指向我方这条 Review", sel.summaryWaitingLink(), "href", "/reviews?id=mock-review-mock-op-1"),
      text("编辑行停在待应用", sel.diffRow(ledgerKey(0, runCallId(0), WRITE_PATH)), "待应用"),
      notText("等待批准不写成已修改", sel.summary(), "已修改")
    ]
  }),

  make({
    id: "X21", title: "工具已结算（会话侧只说已结算，不说成功）", host: "SESSION", stateKind: "终态",
    component: sessionComponent,
    note: "终态消息的过程账本首次展开才读一次，因此行级断言全部放在展开交互里。",
    steps: frame("一条已结算的读取，消息已进入终态", closedWorld(sessionCall(0, {
      toolName: "read_file", args: { relative_path: PATH } }))),
    checks: [
      attr("未读取前相位是 IDLE", sel.trace(), "data-phase", "IDLE"),
      text("未读取前只说展开查看", sel.traceActivity(), "展开查看"),
      visible("入口对终态消息恒在", sel.traceToggle())
    ],
    interactions: openTrace(undefined, [
      visible("首次展开后调用行出现", sel.call(sessionCallId(0))),
      text("状态词是已结算", sel.call(sessionCallId(0)), "已结算"),
      attr("视觉档是中性的 settled", sel.call(sessionCallId(0)), "data-tone", "neutral"),
      count("结清了就不再有当前行动效", ".activity-item[data-current=\"true\"]", 0),
      notText("已结算绝不被写成成功", sel.call(sessionCallId(0)), "成功"),
      text("标题只报规模与结清", sel.traceActivity(), "1 项操作 · 已结束"),
      attr("终态相位落到 settled", sel.trace(), "data-phase", "SETTLED"),
      leftEdgeAligned]),
  }),

  make({
    id: "D10", title: "工具已结算但成功性未知", host: "RUN_SUMMARY", stateKind: "未知",
    component: runSummaryComponent,
    note: "结算了但没有 result_ref：这一项进「结果未提供」，不进读取/写入/检查任何一栏。",
    steps: frame("run_check 结算，回执为空", runWorld(runCall(0, {
      toolName: "run_check", args: { check_id: "typecheck" }, resultRef: null }))),
    checks: [
      visible("活动行在场", sel.summaryActivity(runCallId(0))),
      text("状态词是结果未提供", sel.summaryActivity(runCallId(0)), "已结算，结果未提供"),
      attr("状态仍是 SETTLED（不降格也不升格）", sel.summaryActivity(runCallId(0)), "data-state", "SETTLED"),
      text("统计单列未提供", sel.summary(), "1 项结果未提供"),
      notText("没有回执就不报检查通过", sel.summary(), "检查 1 次"),
      count("没有正文就不摆结果区块", sel.detailResult(runCallId(0)), 0)
    ],
    interactions: toggleSummaryRow(runCallId(0), [
      visible("参数仍然如实展开", sel.detailArgs(runCallId(0))),
      text("详情里给出动作身份", sel.summaryActivityDetail(runCallId(0)), "mock-op-1")])
  }),

  make({
    id: "D11", title: "工具实际执行失败", host: "RUN_SUMMARY", stateKind: "失败",
    component: runSummaryComponent,
    steps: frame("run_check 结算，退出码 2 + outcome FAILED", runWorld(runCall(0, {
      toolName: "run_check", args: { check_id: "typecheck" },
      resultRef: commandResult("error TS2345: 参数类型不匹配", 2, { outcome: "FAILED" }) }))),
    checks: [
      text("状态词是已结算但失败", sel.summaryActivity(runCallId(0)), "已结算但失败"),
      attr("失败标记如实落到行上", sel.summaryActivity(runCallId(0)), "data-failed", "true"),
      attr("已结算的视觉档仍是 neutral（失败由图标与标记说，不另造一档）",
        sel.summaryActivity(runCallId(0)), "data-tone", "neutral"),
      text("统计里有失败或未执行一项", sel.summary(), "1 项失败或未执行"),
      text("检查次数照常报出", sel.summary(), "检查 1 次"),
      notText("失败绝不写成通过", sel.summaryActivity(runCallId(0)), "通过")
    ],
    interactions: toggleSummaryRow(runCallId(0), [
      visible("回执正文逐字来自 result_ref", sel.detailResult(runCallId(0))),
      text("正文里能看到确切的报错", sel.detailResult(runCallId(0)), "error TS2345"),
      text("退出码一并给出", sel.detailMeta(runCallId(0)), "退出码 2")])
  }),

  make({
    id: "D07", title: "工具审批被拒绝", host: "SESSION", stateKind: "失败",
    component: sessionComponent,
    note: "服务端给的原因常显，不需要展开就能读到——它本身就是风险信息。",
    steps: frame("一次读取被准入拒绝，原因随账本落库", liveWorld(
      sessionCall(0, { toolName: "read_file", args: { relative_path: PATH } }),
      sessionCall(1, { toolName: "list_directory", args: { path: "../outside" },
        status: "REJECTED", rejectionReason: "目录不在受管范围内",
        rejectionDetail: "路径解析后位于工作区之外" }))),
    checks: [
      visible("被拒的行在场", sel.call(sessionCallId(1))),
      text("状态词是被拒绝没有执行", sel.call(sessionCallId(1)), "被拒绝，没有执行"),
      attr("视觉档是 negative", sel.call(sessionCallId(1)), "data-tone", "negative"),
      attr("状态原样透出", sel.call(sessionCallId(1)), "data-state", "REJECTED"),
      text("原因不展开就能读到", sel.callReason(sessionCallId(1)), "目录不在受管范围内"),
      text("原因里的细节一并给出", sel.callReason(sessionCallId(1)), "路径解析后位于工作区之外"),
      notText("被拒绝不写成已执行", sel.call(sessionCallId(1)), "已结算"),
      text("在途标题仍按已结算数报", sel.traceActivity(), "已结算 1 项 · 正在执行"),
      leftEdgeAligned, noDuplicateRows
    ],
    interactions: toggleRow(sessionCallId(1), [
      text("详情里重复一次未执行原因", sel.callDetail(sessionCallId(1)), "未执行原因"),
      text("详情里给出原因细节", sel.callDetail(sessionCallId(1)), "路径解析后位于工作区之外")])
  }),

  make({
    id: "X22", title: "工具审批被拒绝（Run 轨迹侧措辞与活动行不一致）", host: "RUN_TRAJECTORY",
    stateKind: "失败", component: runPanelComponent,
    note: "轨迹侧这一档的措辞与会话行不同（「被准入拒绝」vs「被拒绝」）。两处都各按自己的场景钉住，"
      + "合并措辞会立刻失败；这条分歧已作为待确认项列出。",
    steps: frame("检查动作在准入阶段被拒", runWorld(runCall(0, {
      toolName: "run_check", args: { check_id: "test" }, status: "REJECTED",
      resultRef: { reason: "ADMISSION_DENIED", detail: "命令不在白名单内" } }))),
    checks: [
      text("状态词是被准入拒绝", `${sel.runCall(runCallId(0))} .trajectory-status`, "被准入拒绝，没有执行"),
      attr("状态原样透出", `${sel.runCall(runCallId(0))} .trajectory-status`, "data-status", "REJECTED"),
      visible("归入「没有执行」这一类", sel.runFailure(runCallId(0))),
      text("类标题说清这里没有任何执行结果", sel.runFailure(runCallId(0)), "这里没有任何执行结果"),
      text("服务端原因原样透出", sel.runFailure(runCallId(0)), "原样原因：ADMISSION_DENIED"),
      text("统计计入被拒或已放弃", sel.runCounts(), "被拒或已放弃 1"),
      notText("被拒不进已结算计数", sel.runCounts(), "已结算 1")
    ]
  }),

  make({
    id: "D08", title: "工具已放弃", host: "SESSION", stateKind: "取消",
    component: sessionComponent,
    steps: frame("一条已结算、一条被放弃（没有任何结果）", liveWorld(
      sessionCall(0, { toolName: "read_file", args: { relative_path: PATH } }),
      sessionCall(1, { toolName: "search_text", args: { query: "compareDecimalRevisions" },
        status: "ABANDONED" }))),
    checks: [
      text("状态词是已放弃", sel.call(sessionCallId(1)), "已放弃，没有结算结果"),
      attr("视觉档是 negative", sel.call(sessionCallId(1)), "data-tone", "negative"),
      attr("状态原样透出", sel.call(sessionCallId(1)), "data-state", "ABANDONED"),
      count("被放弃的行不带 current 动效", ".activity-item[data-current=\"true\"]", 0),
      motionCount("列表里没有当前行时才轮到标题转动", 1),
      notText("放弃不写成失败", sel.call(sessionCallId(1)), "失败")
    ],
    interactions: toggleRow(sessionCallId(1))
  }),

  make({
    id: "D09", title: "工具结果未知", host: "SESSION", stateKind: "未知",
    component: sessionComponent,
    note: "UNKNOWN 只存在于会话账本这一侧；Run 侧没有这一档，因此这里也不假装 Run 报了未知。",
    steps: frame("一次结算响应中断，结果未知", liveWorld(sessionCall(0, {
      toolName: "apply_changeset", args: { changes: [{ path: WRITE_PATH, action: "MODIFY" }] },
      status: "UNKNOWN" }))),
    checks: [
      text("状态词是结果未知需核对", sel.call(sessionCallId(0)), "结果未知，需核对"),
      attr("状态原样透出", sel.call(sessionCallId(0)), "data-state", "UNKNOWN"),
      attr("视觉档是 negative（不给成功样式）", sel.call(sessionCallId(0)), "data-tone", "negative"),
      count("未知不带 data-failed（它不是失败）", `${sel.call(sessionCallId(0))}[data-failed]`, 0),
      notText("未知绝不写成已修改", sel.call(sessionCallId(0)), "已修改"),
      notText("未知绝不写成已结算", sel.call(sessionCallId(0)), "已结算"),
      visible("展开入口仍在（未知也要能核对参数）", sel.callToggle(sessionCallId(0)))
    ],
    interactions: toggleRow(sessionCallId(0), [
      visible("参数逐字可读", sel.detailArgs(sessionCallId(0)))])
  }),

  make({
    id: "X23", title: "审批已过期：未执行，不沿用旧批准", host: "RUN_TRAJECTORY", stateKind: "审批",
    component: runPanelComponent,
    steps: frame("调用仍在等批准，对应 Review 已 EXPIRED", runWorld(
      runCall(0, { toolName: "apply_changeset",
        args: { changes: [{ path: WRITE_PATH, action: "MODIFY" }] },
        status: "WAITING_APPROVAL" }),
      { reviews: [approvalReview("mock-op-1", { status: "EXPIRED", decidedAt: stamp(300) })] })),
    checks: [
      text("审批说清已过期未执行", sel.runApproval(runCallId(0)), "审批已过期，未执行"),
      text("过期也带决定时间", sel.runApproval(runCallId(0)), "决定时间"),
      notText("过期不被说成已批准", sel.runApproval(runCallId(0)), "已批准这只动作"),
      attr("调用状态仍是等待批准（不改写账本）",
        `${sel.runCall(runCallId(0))} .trajectory-status`, "data-status", "WAITING_APPROVAL")
    ]
  }),

  make({
    id: "X24", title: "批准之后：已批准也不代表已执行", host: "RUN_TRAJECTORY", stateKind: "审批",
    component: runPanelComponent,
    steps: frame("Review 已批准，调用进入 PREPARED 但还没有回执", runWorld(
      runCall(0, { toolName: "apply_changeset",
        args: { changes: [{ path: WRITE_PATH, action: "MODIFY" }] },
        status: "PREPARED" }),
      { reviews: [approvalReview("mock-op-1", { status: "APPROVED", decidedAt: stamp(120),
        reason: "人工批准这次写入" })] })),
    checks: [
      visible("审批一栏在场", sel.runApproval(runCallId(0))),
      text("只承认批准这件事", sel.runApproval(runCallId(0)), "已批准这只动作，不代表它已执行"),
      text("同时给出批准身份与时间", sel.runApproval(runCallId(0)), "决定时间"),
      text("动作本身仍是未决", `${sel.runCall(runCallId(0))} .trajectory-status`, "尚无结算结果"),
      notText("批准不被折算成执行结果", sel.runCounts(), "已结算 1")
    ]
  }),

  make({
    id: "X25", title: "审批记录读不到：说无法确认，不显示已批准", host: "RUN_TRAJECTORY",
    stateKind: "失败", component: runPanelComponent,
    note: "「读不到」与「没有这条审批」是两件事；这里注入真实读取失败，界面必须落在前者。",
    steps: frame("Review 读取返回 503", runWorld(
      runCall(0, { toolName: "apply_changeset",
        args: { changes: [{ path: WRITE_PATH, action: "MODIFY" }] },
        status: "WAITING_APPROVAL" }),
      { fail: { getRunReviews: { kind: "http", status: 503, code: "UPSTREAM_UNAVAILABLE",
        detail: "审批服务暂时不可用" } } })),
    checks: [
      visible("面板级说明审批记录读不到", sel.runReviewsUnreadable()),
      text("说明里承诺不会显示已批准", sel.runReviewsUnreadable(), "不会显示「已批准」"),
      visible("这一行的审批栏仍在", sel.runApproval(runCallId(0))),
      text("审批栏落到无法确认这一支", sel.runApproval(runCallId(0)), "无法确认"),
      notText("读不到绝不被当成没有审批", sel.runApproval(runCallId(0)), "已批准")
    ]
  }),

  make({
    id: "X26", title: "Run 终态但仍有未结算调用", host: "RUN_TRAJECTORY", stateKind: "未知",
    component: runPanelComponent,
    note: "终态之后不会再有结算，但界面不因此猜这次调用「执行过」或「没执行」——按动作记录单独核对。",
    steps: frame("Run 已 COMPLETED，一条请求仍停在 REQUESTED", {
      run: labRun({ status: "COMPLETED" }),
      runToolCalls: runProjection([[runCall(0, { toolName: "read_file",
        args: { relative_path: PATH }, status: "REQUESTED", operationId: null })]],
        { runStatus: "COMPLETED" }) }),
    checks: [
      visible("未结算告警在场", sel.runUnsettled(runCallId(0))),
      text("告警拒绝两种猜测", sel.runUnsettled(runCallId(0)), "既不能认定它执行过，也不能认定它没执行"),
      text("来源行说明此后不再有结算", sel.runSourceRun(), "终态；此后不会再有新的工具结算"),
      attr("调用状态不被界面改写", `${sel.runCall(runCallId(0))} .trajectory-status`,
        "data-status", "REQUESTED"),
      notText("终态不宣布已结算", sel.runCounts(), "已结算 1")
    ]
  }),

  /* ---------------- 矩阵新增：整轮、多工具与跨侧关联 ---------------- */

  make({
    id: "D01", title: "正在执行第一项工具", host: "RUN_TRAJECTORY", stateKind: "在途",
    component: runPanelComponent,
    note: "「还没有任何工具请求」与「第一项正在执行」是同一块面板的两个读数：推进只换行，不重装整块。",
    steps: [
      at(0, "Run 已在跑，工具账本里还没有任何请求", { run: labRun(), runToolCalls: runProjection([]) }),
      at(1_200, "第一项 read_file 被请求，还没有结算", {
        runToolCalls: runProjection([[runCall(0, { toolName: "read_file", args: { relative_path: PATH },
          status: "REQUESTED", operationId: null })]])
      })
    ],
    checks: [
      visible("面板仍在原位（状态推进不卸载整块）", sel.runPanel()),
      count("第一项工具只渲染一行", RUN_ROW, 1),
      text("状态词是已请求尚未派发", `${sel.runCall(runCallId(0))} .trajectory-status`, "已请求，尚未派发"),
      text("没结算就计入正在执行或结果未决", sel.runCounts(), "正在执行或结果未决 1"),
      text("已结算照常报零", sel.runCounts(), "已结算 0"),
      gone("有了真实行就不再是空账本", sel.runEmpty()),
      notText("第一项在跑不等于 Run 已进入终态", sel.runSourceRun(), "终态")
    ],
    interactions: [{
      kind: "advance", label: "从「还没有请求」推进到第一项被请求",
      then: [visible("来源 Run 那一行还在", sel.runSourceRun()),
        visible("刷新入口一直在", sel.runRefresh()),
        count("推进后正好一行", RUN_ROW, 1)]
    }]
  }),

  make({
    id: "D02", title: "连续执行多个工具", host: "SESSION", stateKind: "工具",
    component: sessionComponent,
    note: "四个动作词各不相同，因此「按请求顺序排」与「同一身份只渲染一行」能同时验到；"
      + "标题只报已结算数量，因为总数此刻本来就不未知。",
    steps: frame("同一轮里连续四项读取，前三项已结算，第四项仍在途", liveWorld(
      readCall(0, PATH),
      sessionCall(1, { toolName: "list_directory", args: { path: "src/lib" } }),
      sessionCall(2, { toolName: "search_text", args: { query: "compareDecimalRevisions" } }),
      sessionCall(3, { toolName: "git_status", args: {}, status: "REQUESTED" }))),
    checks: [
      count("四项各占一行，不合并成一条", SESSION_ROW, 4),
      text("标题只报已结算数量", sel.traceActivity(), "已结算 3 项 · 正在执行"),
      count("全场只有一行是当前动作", ".activity-item[data-current=\"true\"]", 1),
      attr("当前那一行是仍在途的第四项", sel.call(sessionCallId(3)), "data-current", "true"),
      motionCount("因此只有一个主进度动效", 1),
      text("第一项仍排在最前", sel.call(sessionCallId(0)), PATH),
      text("第二行的对象逐字来自参数", sel.call(sessionCallId(1)), "src/lib"),
      noDuplicateRows
    ],
    interactions: toggleRow(sessionCallId(1), [
      visible("参数逐字可读", sel.detailArgs(sessionCallId(1))),
      text("会话侧不补结果正文", sel.callDetail(sessionCallId(1)), "不保存工具结果正文")])
  }),

  make({
    id: "D03", title: "已结算部分，工具仍在执行", host: "RUN_TRAJECTORY", stateKind: "在途",
    component: runPanelComponent,
    note: "同一块面板里三档并存：已结算、执行中、等待批准各说各的，统计三项各计一次，不合并成一个「进行中」。",
    steps: frame("一项读取已结算、一项检查仍在执行、一项写入等待批准", {
      run: labRun(),
      runToolCalls: runProjection([[
        runCall(0, { toolName: "read_file", args: { relative_path: PATH },
          resultRef: commandResult("export const rate = 1;", 0) }),
        runCall(1, { toolName: "run_check", args: { check_id: "typecheck" }, status: "PREPARED" }),
        runCall(2, { toolName: "apply_changeset", status: "WAITING_APPROVAL",
          args: { changes: [{ path: WRITE_PATH, action: "MODIFY" }] } })
      ]])
    }),
    checks: [
      count("三档并存，各占一张卡片", RUN_ROW, 3),
      text("已结算那一档单独计数", sel.runCounts(), "已结算 1"),
      text("执行中那一档计入未决", sel.runCounts(), "正在执行或结果未决 1"),
      text("等待批准另开一栏", sel.runCounts(), "等待批准 1"),
      notText("部分结算绝不写成全部结清", sel.runCounts(), "已结算 3"),
      text("已结算行给出回执正文", `${sel.runCall(runCallId(0))} .trajectory-status`, "已结算"),
      text("执行中行仍说没有结算结果", `${sel.runCall(runCallId(1))} .trajectory-status`,
        "尚无结算结果"),
      visible("只有等待批准那一行挂审批栏", sel.runApproval(runCallId(2))),
      count("两行没有结算结果，各挂一条说明", "[data-testid^=\"trajectory-failure-\"]", 2)
    ],
    interactions: toggleRunRow(runCallId(0), [
      visible("已结算那行的正文可读", sel.runResult(runCallId(0))),
      text("正文逐字来自 result_ref", sel.runResult(runCallId(0)), "export const rate = 1;")])
  }),

  make({
    id: "D12", title: "整轮执行已结束", host: "RUN_TRAJECTORY", stateKind: "终态",
    component: runPanelComponent,
    note: "「都结清了」不等于「成功了」：终态 + 全部结算只换来 settled 一档，验证证据仍按开发注记说无法确认。",
    steps: frame("Run 已完成，三项调用全部结算", {
      run: labRun({ status: "COMPLETED" }),
      runToolCalls: runProjection([[
        runCall(0, { toolName: "read_file", args: { relative_path: PATH },
          resultRef: commandResult("export const rate = 1;", 0) }),
        runCall(1, { toolName: "search_text", args: { query: "compareDecimalRevisions" },
          resultRef: commandResult("src/lib/order.ts:41", 0) }),
        runCall(2, { toolName: "run_check", args: { check_id: "typecheck" },
          resultRef: commandResult("tsc --noEmit: OK", 0) })
      ]], { runStatus: "COMPLETED" })
    }),
    checks: [
      text("来源 Run 报的是已完成终态", sel.runSourceRun(), "Run 状态 已完成（终态；此后不会再有新的工具结算）"),
      text("已结算按实际数量报", sel.runCounts(), "已结算 3"),
      text("没有任何未决项", sel.runCounts(), "正在执行或结果未决 0"),
      count("终态且全部结算：不出现未结算告警", "[data-testid^=\"trajectory-unsettled-at-terminal-\"]", 0),
      visible("证据注记仍在原位（结清不等于通过验证）", sel.runEvidenceNote()),
      notText("整轮结束绝不写成验证通过", sel.runPanel(), "验证通过"),
      notText("也不写成本轮没有调用工具", sel.runPanel(), "没有工具请求"),
      count("三行各自一条，不重复合并", RUN_ROW, 3)
    ],
    interactions: toggleRunRow(runCallId(2), [
      text("检查回执逐字可读", sel.runResult(runCallId(2)), "tsc --noEmit: OK"),
      text("退出码一并给出", sel.runExecSummary(runCallId(2)), "退出码 0")])
  }),

  make({
    id: "D13", title: "Run 执行失败", host: "RUN_TRAJECTORY", stateKind: "失败",
    component: runPanelComponent,
    note: "Run 的失败与那一行的失败是两处事实：这里都按服务端给的原样透出，界面不合并成一句「已结束」。",
    steps: frame("Run 已进入 FAILED：一项检查回执失败，一项请求还没派发", {
      run: labRun({ status: "FAILED" }),
      runToolCalls: runProjection([[
        runCall(0, { toolName: "run_check", args: { check_id: "test" },
          resultRef: commandResult("1 failed, 42 passed", 1,
            { outcome: "FAILED", reason: "CHECK_FAILED" }) }),
        runCall(1, { toolName: "read_file", args: { relative_path: WRITE_PATH },
          status: "REQUESTED", operationId: null })
      ]], { runStatus: "FAILED" })
    }),
    checks: [
      text("来源 Run 报的是失败终态", sel.runSourceRun(), "Run 状态 失败（终态；此后不会再有新的工具结算）"),
      notText("失败不被说成就完成", sel.runSourceRun(), "Run 状态 已完成"),
      visible("失败那一行挂已结算但失败", sel.runFailure(runCallId(0))),
      text("类标题把结论留给运行", sel.runFailure(runCallId(0)), "能否修正以运行为准"),
      text("回执里的原因原样透出", sel.runFailure(runCallId(0)), "原样原因：CHECK_FAILED"),
      visible("没派发的那行另有未结算告警", sel.runUnsettled(runCallId(1))),
      text("未结算告警拒绝两种猜测", sel.runUnsettled(runCallId(1)), "既不能认定它执行过"),
      text("统计各计一次", sel.runCounts(), "已结算 1"),
      text("没派发的那项进未决", sel.runCounts(), "正在执行或结果未决 1"),
      notText("失败不被盖成验证通过", sel.runPanel(), "验证通过")
    ],
    interactions: toggleRunRow(runCallId(0), [
      visible("失败回执正文逐字可读", sel.runResult(runCallId(0))),
      text("正文里能看到确切的计数", sel.runResult(runCallId(0)), "1 failed, 42 passed"),
      text("退出码一并给出", sel.runExecSummary(runCallId(0)), "退出码 1")])
  }),

  make({
    id: "D14", title: "Run 已取消", host: "RUN_TRAJECTORY", stateKind: "取消",
    component: runPanelComponent,
    note: "被停止打断的两种行不同：已放弃在账本意义上已结清（它说清了没有执行），"
      + "仍在途的请求则永远等不到结算，因此只有后者挂未结算告警。这条钉的是面板现行的分类。",
    steps: frame("Run 已停止：一项已结算、一项被放弃、一项还没派发", {
      run: labRun({ status: "CANCELLED" }),
      runToolCalls: runProjection([[
        runCall(0, { toolName: "read_file", args: { relative_path: PATH },
          resultRef: commandResult("export const rate = 1;", 0) }),
        runCall(1, { toolName: "run_check", args: { check_id: "test" }, status: "ABANDONED" }),
        runCall(2, { toolName: "apply_changeset", args: { changes: [{ path: WRITE_PATH, action: "MODIFY" }] },
          status: "REQUESTED" })
      ]], { runStatus: "CANCELLED" })
    }),
    checks: [
      text("来源 Run 报的是已停止终态", sel.runSourceRun(), "Run 状态 已停止（终态；此后不会再有新的工具结算）"),
      text("被放弃那行说没有结算结果", `${sel.runCall(runCallId(1))} .trajectory-status`, "已放弃，没有结算结果"),
      visible("被放弃归入「没有执行」", sel.runFailure(runCallId(1))),
      text("这里没有任何执行结果", sel.runFailure(runCallId(1)), "这里没有任何执行结果"),
      text("已结算只算那一行读取", sel.runCounts(), "已结算 1"),
      text("被放弃计入被拒或已放弃", sel.runCounts(), "被拒或已放弃 1"),
      count("未结算告警只挂在还没派发的那一行", "[data-testid^=\"trajectory-unsettled-at-terminal-\"]", 1),
      visible("被打断的请求有单独说明", sel.runUnsettled(runCallId(2))),
      text("统计按状态说没有等待批准项", sel.runCounts(), "等待批准 0"),
      visible("这一行的审批栏仍按动作身份出现（与统计不同档，见注）", sel.runApproval(runCallId(2))),
      notText("取消不写成成功", sel.runPanel(), "验证通过"),
      notText("也不写成已完成", sel.runSourceRun(), "Run 状态 已完成")
    ],
    interactions: toggleRunRow(runCallId(1), [
      visible("参数仍如实可读", sel.runArgs(runCallId(1))),
      text("没有正文就说不推断", sel.runNoResult(runCallId(1)), "不能据此推断成功或失败")])
  }),

  make({
    id: "D15", title: "工具轨迹跨多个轮次", host: "RUN_TRAJECTORY", stateKind: "工具",
    component: runPanelComponent,
    note: "轮次的权威边界是服务端给的 `rounds[i]` 那一层，不是行上的 `round` 读数。"
      + "这里故意让两个字段矛盾，验渲染跟的是分组而不是字段。",
    steps: frame("三轮各一项调用，行上的 round 字段与外层分组不一致", {
      run: labRun({ status: "COMPLETED" }),
      runToolCalls: runProjection([
        [runCall(0, { toolName: "read_file", args: { relative_path: PATH }, round: 0,
          resultRef: commandResult("export const rate = 1;", 0) })],
        [runCall(1, { toolName: "search_text", args: { query: "compareDecimalRevisions" }, round: 0,
          resultRef: commandResult("src/lib/order.ts:41", 0) })],
        [runCall(2, { toolName: "run_check", args: { check_id: "typecheck" }, round: 9,
          resultRef: commandResult("tsc --noEmit: OK", 0) })]
      ], { runStatus: "COMPLETED" })
    }),
    checks: [
      count("三轮各自成段", "[data-testid^=\"trajectory-round-\"]", 3),
      text("轮次标题按服务端分组", sel.runRound(1), "第 1 轮"),
      count("第 0 轮里只有它那一项", "[data-testid=\"trajectory-round-0\"] .trajectory-call", 1),
      count("第 2 轮里只有它那一项", "[data-testid=\"trajectory-round-2\"] .trajectory-call", 1),
      count("行不被自己的 round 字段带进第 9 轮", "[data-testid=\"trajectory-round-9\"]", 0),
      text("跨轮总数照常累加", sel.runCounts(), "已结算 3"),
      text("第二行的对象逐字来自参数", sel.runCall(runCallId(1)), "compareDecimalRevisions"),
      noDuplicateRows
    ],
    interactions: toggleRunRow(runCallId(2), [
      text("最后一轮的回执可读", sel.runResult(runCallId(2)), "tsc --noEmit: OK")])
  }),

  make({
    id: "D16", title: "Run 与会话的关联轨迹", host: "LINK", stateKind: "工具",
    component: linkedComponent,
    note: "同一轮在两侧各有一份投影：会话账本只有请求与结算，结果正文与逐文件账本在那个 Run 的轨迹里。"
      + "两处同时在场时，谁都不能替对方补内容。「查看逐步轨迹」是产品自己的回调入口，"
      + "实验室不在场景中途换宿主，因此只验它在位与文案。",
    steps: frame("一条写入：会话侧已结算，Run 侧给出逐文件账本", {
      ...closedWorld(sessionCall(0, { toolName: "apply_changeset",
        args: { changes: [{ path: WRITE_PATH, action: "MODIFY" }] } })),
      run: labRun({ status: "COMPLETED" }),
      runToolCalls: runProjection([[runCall(0, { toolName: "apply_changeset",
        args: { changes: [{ path: WRITE_PATH, action: "MODIFY" }] },
        // 有回执才谈得上「写入 1 次」：结果未提供的结算走另一档计数（见「结果未提供」一族）。
        resultRef: commandResult("已写入 1 个文件", 0),
        fileChanges: [fileChange(WRITE_PATH, "MODIFY", { added: 4, removed: 1 })] })]],
      { runStatus: "COMPLETED" })
    }),
    checks: [
      visible("会话侧过程入口在场", sel.trace()),
      visible("Run 侧执行摘要同时在场", sel.summary()),
      text("摘要按同一份账本报写入次数", sel.summary(), "写入 1 次"),
      visible("局部增删行按落盘账本显示", sel.diffRow(ledgerKey(0, runCallId(0), WRITE_PATH))),
      text("已落盘的这一行说已修改", sel.diffRow(ledgerKey(0, runCallId(0), WRITE_PATH)), "已修改"),
      visible("给出通往逐步轨迹的入口", sel.summaryOpen()),
      text("入口文案是逐步轨迹", sel.summaryOpen(), "查看逐步轨迹"),
      notText("会话侧不替 Run 报正文", sel.trace(), "已结算但失败")
    ],
    interactions: [{
      kind: "click", selector: sel.traceToggle(), label: "展开会话侧的执行过程",
      then: [visible("同一轮在会话侧只有一行", sel.call(sessionCallId(0))),
        text("状态词是已结算", sel.call(sessionCallId(0)), "已结算"),
        count("会话侧不渲染结果正文块", sel.detailResult(sessionCallId(0)), 0),
        visible("展开控件仍在", sel.callToggle(sessionCallId(0)))]
    }, {
      kind: "click", selector: sel.callToggle(sessionCallId(0)), label: "展开这条会话侧调用",
      then: [visible("参数逐字可读", sel.detailArgs(sessionCallId(0))),
        text("详情说清结果正文不在这个账本里", sel.callDetail(sessionCallId(0)),
          "会话账本只记录请求与结算"),
        text("并指回该 Run 的轨迹按动作身份核对", sel.callDetail(sessionCallId(0)), "该 Run 的工具轨迹")]
    }]
  })
];
