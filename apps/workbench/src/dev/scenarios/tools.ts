import type { RelaySessionToolCall } from "../../api/dtos/assist";
import {
  assistantMessage, labRun, LONG_CHECK_ID, readCall, runCall, runProjection, sessionCall, sessionTrace, pair
} from "../scenarioFixtures";
import type { ScenarioWorld } from "../scenarioWorld";
import {
  attr, at, chain, count, frame, gone, leftEdgeAligned, make, notText, noDuplicateRows, SESSION_ROW,
  patch, runCallId, sel, sessionCallId, sessionComponent, runPanelComponent, runSummaryComponent, text,
  toggleRow, toggleRunRow, toggleSummaryRow, visible, withTrace
} from "./common";

/**
 * B 组 · 工具调用（22 条）。
 *
 * 每条都验**折叠与展开两态**：折叠行只说「动作 · 对象 · 状态 · 耗时」，展开后才是参数与回执。
 *
 * 一条硬边界贯穿这一组：会话账本没有结果正文那一列，所以 SESSION 宿主的展开详情里
 * **不会出现「结果」块**，而是明说「这个账本不存」。要看 stdout、退出码、截断与超时，
 * 只能走 Run 侧宿主——这不是排版选择，是事实 Owner 的位置。
 *
 * 在途消息（RUNNING）默认展开并自动读取，因此这些行的静态断言可直接跑；终态消息
 * 首次展开才读，那类检查放在交互里（见 A 组与 E 组）。
 */

/** 一条在途助手消息 + 给定会话调用行：B 组会话侧的通用开局。 */
function live(...calls: readonly RelaySessionToolCall[]) {
  return (world: ScenarioWorld): ScenarioWorld => chain(
    patch({ messages: [pair({ status: "RUNNING", content: null })[0],
      assistantMessage({ status: "RUNNING", content: null })] }),
    withTrace(sessionTrace([calls])))(world);
}

/** 四十行量级的 stdout：比 F09 的 400 行小一档，用来验「大量但不是超长」的折叠口径。 */
const STDOUT_40_LINE = (index: number): string =>
  `[00:00:${String(index % 60).padStart(2, "0")}] suite=${Math.floor(index / 4) + 1} case=${index} ok`;
const STDOUT_40 = Array.from({ length: 40 }, (_, index) => STDOUT_40_LINE(index)).join("\n");

export const TOOLS = [
  make({
    id: "B01", title: "读取单个文件", host: "SESSION", stateKind: "工具",
    component: sessionComponent,
    steps: [{ at: 0, label: "请求并结算一次 read_file", set: live(readCall(0, "apps/workbench/package.json")) }],
    checks: [
      visible("调用行在场", sel.call(sessionCallId(0))),
      text("动作词是读取文件", sel.call(sessionCallId(0)), "读取文件"),
      text("折叠行点名对象", sel.call(sessionCallId(0)), "package.json"),
      text("状态词是已结算", sel.call(sessionCallId(0)), "已结算"),
      attr("行身份与来源如实标注", sel.call(sessionCallId(0)), "data-source", "SESSION_TOOL_CALL")
    ],
    interactions: toggleRow(sessionCallId(0), [
      visible("参数逐字展开", sel.detailArgs(sessionCallId(0))),
      text("参数里能看到确切路径", sel.detailArgs(sessionCallId(0)), "apps/workbench/package.json"),
      gone("会话侧不编结果正文", sel.detailResult(sessionCallId(0))),
      text("改为明说这个账本不存正文", sel.callDetail(sessionCallId(0)), "会话账本只记录请求与结算")])
  }),

  make({
    id: "B03", title: "列出目录", host: "SESSION", stateKind: "工具",
    component: sessionComponent,
    steps: [{ at: 0, label: "list_directory 结算", set: live(sessionCall(0, {
      toolName: "list_directory", args: { path: "apps/workbench/src" } })) }],
    checks: [
      visible("调用行在场", sel.call(sessionCallId(0))),
      text("动作词是列目录", sel.call(sessionCallId(0)), "列目录"),
      attr("类别按工具名归类", sel.call(sessionCallId(0)), "data-category", "LIST")
    ],
    interactions: toggleRow(sessionCallId(0), [visible("参数已展开", sel.detailArgs(sessionCallId(0)))])
  }),

  make({
    id: "B04", title: "搜索文件", host: "SESSION", stateKind: "工具",
    component: sessionComponent,
    steps: [{ at: 0, label: "find_paths 结算", set: live(sessionCall(0, {
      toolName: "find_paths", args: { pattern: "**/activityPresentation*" } })) }],
    checks: [
      visible("调用行在场", sel.call(sessionCallId(0))),
      text("动作词是查找文件", sel.call(sessionCallId(0)), "查找文件"),
      attr("类别是检索", sel.call(sessionCallId(0)), "data-category", "SEARCH")
    ],
    interactions: toggleRow(sessionCallId(0))
  }),

  make({
    id: "B05", title: "搜索文件内容", host: "SESSION", stateKind: "工具",
    component: sessionComponent,
    note: "`search_text` 的真实参数是 `query`（字面查询串）+ 可选 `relative_path`。"
      + "折叠行的对象位取的是「动的是哪里」这一项（目录），查询串留在第三层参数里逐字给——"
      + "行上同时铺两个字符串就把紧凑行变成参数转储。",
    steps: [{ at: 0, label: "search_text 结算", set: live(sessionCall(0, {
      toolName: "search_text", args: { query: "activityHeaderState", relative_path: "apps/workbench/src" } })) }],
    checks: [
      visible("调用行在场", sel.call(sessionCallId(0))),
      text("动作词是搜索内容", sel.call(sessionCallId(0)), "搜索内容"),
      text("折叠行点名检索范围", sel.call(sessionCallId(0)), "apps/workbench/src"),
      notText("折叠行不把查询串当对象", sel.call(sessionCallId(0)), "activityHeaderState")
    ],
    interactions: toggleRow(sessionCallId(0), [
      text("查询串在参数里逐字给出", sel.detailArgs(sessionCallId(0)), "activityHeaderState")])
  }),

  make({
    id: "X06", title: "读取变更集（独立的读类动作词）", host: "SESSION", stateKind: "工具",
    component: sessionComponent,
    note: "read_change_set 属读类：动作词单独一条，不与「读取文件」混称。",
    steps: [{ at: 0, label: "read_change_set 结算", set: live(sessionCall(0, {
      toolName: "read_change_set", args: { operation_id: "mock-op-1" } })) }],
    checks: [
      visible("调用行在场", sel.call(sessionCallId(0))),
      text("动作词是读取变更集", sel.call(sessionCallId(0)), "读取变更集"),
      text("对象取 operation_id", sel.call(sessionCallId(0)), "mock-op-1")
    ],
    interactions: toggleRow(sessionCallId(0))
  }),

  make({
    id: "B06", title: "Git 状态查询", host: "RUN_TRAJECTORY", stateKind: "工具",
    component: runPanelComponent,
    note: "Git 结果由模型这次调用产生，界面上明说它不是你可以点开的 Git 入口。",
    steps: frame("git_status 结算", {
      run: labRun(), runToolCalls: runProjection([[runCall(0, { toolName: "git_status", args: {},
        resultRef: { content: "M apps/workbench/src/App.tsx\n?? output/lab.log" } })]]) }),
    checks: [
      visible("轨迹面板在场", sel.runPanel()),
      visible("调用行在场", sel.runCall(runCallId(0))),
      text("状态词是已结算", sel.runCall(runCallId(0)), "已结算"),
      visible("Git 来源说明在场", sel.runGitNote(runCallId(0)))
    ],
    interactions: toggleRunRow(runCallId(0))
  }),

  make({
    id: "B07", title: "Git Diff 查询", host: "RUN_TRAJECTORY", stateKind: "工具",
    component: runPanelComponent,
    note: "`git_diff` 的可选限定是 `path`。Run 卡片的头行只认 `relative_path`/`check_id`/`query` 三个键，"
      + "因此这里路径不在头行点名，完整参数在展开后逐字可见（这条差异已记入实验室发现）。",
    steps: frame("git_diff 结算", {
      run: labRun(), runToolCalls: runProjection([[runCall(0, { toolName: "git_diff",
        args: { path: "apps/workbench/src/App.tsx" },
        resultRef: { content: "--- a/App.tsx\n+++ b/App.tsx\n@@ -1,3 +1,4 @@\n+import x from \"y\";" } })]]) }),
    checks: [
      visible("调用行在场", sel.runCall(runCallId(0))),
      text("头行点名工具本身", sel.runCall(runCallId(0)), "git_diff"),
      visible("Git 来源说明在场", sel.runGitNote(runCallId(0))),
      text("差异正文逐字来自 result_ref", sel.runPreview(runCallId(0)), "+import x from \"y\";")
    ],
    interactions: toggleRunRow(runCallId(0), [
      text("展开后参数点名目标路径", sel.runArgs(runCallId(0)), "apps/workbench/src/App.tsx"),
      text("展开后仍是同一份差异正文", sel.runResult(runCallId(0)), "--- a/App.tsx")])
  }),

  make({
    id: "B08", title: "Git 历史查询", host: "RUN_TRAJECTORY", stateKind: "工具",
    component: runPanelComponent,
    steps: frame("git_log 结算", {
      run: labRun(), runToolCalls: runProjection([[runCall(0, { toolName: "git_log", args: { limit: 5 },
        resultRef: { content: "e2af9480 feat: 插件芯片与运行态指示落地" } })]]) }),
    checks: [visible("调用行在场", sel.runCall(runCallId(0)))],
    interactions: toggleRunRow(runCallId(0))
  }),

  make({
    id: "B09", title: "运行简单命令", host: "RUN_SUMMARY", stateKind: "工具",
    component: runSummaryComponent,
    note: "命令的 stdout 与退出码在聊天区原本没有出口，只存在于右栏；这里验的就是这一处补齐。",
    steps: frame("run_check 结算，退出码 0", {
      run: labRun(), runToolCalls: runProjection([[runCall(0, { toolName: "run_check",
        args: { check_id: "typecheck" },
        resultRef: { stdout: "tsc --noEmit 通过，0 errors", exit_code: 0 } })]]) }),
    checks: [
      visible("摘要区在场", sel.summary()),
      visible("命令行进入聊天区", sel.summaryActivity(runCallId(0))),
      text("统计里报检查次数", sel.summary(), "检查 1 次"),
      count("命令行只有一条", sel.summaryActivities() + " .activity-item", 1)
    ],
    interactions: toggleSummaryRow(runCallId(0), [
      visible("参数逐字展开", sel.detailArgs(runCallId(0))),
      visible("回执正文展开", sel.detailResult(runCallId(0))),
      text("正文逐字来自 result_ref", sel.detailResult(runCallId(0)), "tsc --noEmit 通过"),
      text("详情里报退出码", sel.detailMeta(runCallId(0)), "退出码 0")])
  }),

  make({
    id: "B14", title: "命令非零退出码", host: "RUN_SUMMARY", stateKind: "失败",
    component: runSummaryComponent,
    note: "失败分三类：这一类是「已结算但失败」，与「没有执行」「没有结算结果」不混用。",
    steps: frame("run_check 结算，退出码 2 且带原因", {
      run: labRun(), runToolCalls: runProjection([[runCall(0, { toolName: "run_check",
        args: { check_id: "test" },
        resultRef: { stdout: "3 failed, 218 passed", exit_code: 2, outcome: "FAILED",
          reason: "CHECK_FAILED", detail: "3 个用例断言不成立" } })]]) }),
    checks: [
      visible("命令行在场", sel.summaryActivity(runCallId(0))),
      text("状态词是已结算但失败", sel.summaryActivity(runCallId(0)), "已结算但失败"),
      attr("行内状态仍是 SETTLED（失败不改写状态）", sel.summaryActivity(runCallId(0)), "data-state", "SETTLED"),
      attr("视觉档是 negative 而不是结清的灰", sel.summaryActivity(runCallId(0)), "data-failed", "true"),
      text("统计里失败单独成项", sel.summary(), "1 项失败或未执行")
    ],
    interactions: toggleSummaryRow(runCallId(0), [
      text("回执原因逐字透出", sel.detailResult(runCallId(0)), "3 failed, 218 passed"),
      text("详情里报退出码 2", sel.detailMeta(runCallId(0)), "退出码 2")])
  }),

  make({
    id: "B17", title: "命令输出截断", host: "RUN_TRAJECTORY", stateKind: "边界",
    component: runPanelComponent,
    steps: frame("run_check 结算，truncated 且给出省略量", {
      run: labRun(), runToolCalls: runProjection([[runCall(0, { toolName: "run_check",
        args: { check_id: "build" },
        resultRef: { stdout: "vite build 输出……", exit_code: 0, truncated: true, omitted_bytes: 48_576 } })]]) }),
    checks: [
      visible("截断说明在场", sel.runTruncated(runCallId(0))),
      text("按服务端给的省略量说", sel.runTruncated(runCallId(0)), "省略 48576 字节"),
      text("折叠区的执行元数据同样报截断", sel.runExecSummary(runCallId(0)), "结果被服务端截断")
    ],
    interactions: toggleRunRow(runCallId(0))
  }),

  make({
    id: "B15", title: "命令超时", host: "RUN_SUMMARY", stateKind: "失败",
    component: runSummaryComponent,
    steps: frame("run_check 结算且 timed_out 为真", {
      run: labRun(), runToolCalls: runProjection([[runCall(0, { toolName: "run_check",
        args: { check_id: "e2e" },
        resultRef: { stdout: "", exit_code: null, timed_out: true, reason: "DEADLINE_EXCEEDED" } })]]) }),
    checks: [
      visible("命令行在场", sel.summaryActivity(runCallId(0))),
      text("状态词不写成功", sel.summaryActivity(runCallId(0)), "已结算")
    ],
    interactions: toggleSummaryRow(runCallId(0), [
      visible("执行元数据在场", sel.detailMeta(runCallId(0))),
      text("如实说服务端记录为超时", sel.detailMeta(runCallId(0)), "服务端记录为超时"),
      notText("退出码没记就不报退出码", sel.detailMeta(runCallId(0)), "退出码 0")])
  }),

  make({
    id: "B16", title: "命令取消", host: "RUN_SUMMARY", stateKind: "取消",
    component: runSummaryComponent,
    steps: frame("run_check 结算且 cancelled 为真", {
      run: labRun({ status: "CANCELLED" }),
      runToolCalls: runProjection([[runCall(0, { toolName: "run_check", args: { check_id: "test" },
        resultRef: { stdout: "中断于 12 个用例后", exit_code: null, cancelled: true } })]],
        { runStatus: "CANCELLED" }) }),
    checks: [visible("命令行在场", sel.summaryActivity(runCallId(0)))],
    interactions: toggleSummaryRow(runCallId(0), [
      text("如实说服务端记录为已取消", sel.detailMeta(runCallId(0)), "服务端记录为已取消")])
  }),

  make({
    id: "B19", title: "桌面工具调用", host: "SESSION", stateKind: "工具",
    component: sessionComponent,
    steps: [{ at: 0, label: "computer_screenshot 结算", set: live(sessionCall(0, {
      toolName: "computer_screenshot", args: { display: "main" } })) }],
    checks: [
      attr("类别归到桌面", sel.call(sessionCallId(0)), "data-category", "DESKTOP"),
      text("动作词是截屏", sel.call(sessionCallId(0)), "截屏")
    ],
    interactions: toggleRow(sessionCallId(0))
  }),

  make({
    id: "X07", title: "枚举窗口（没有对象参数）", host: "SESSION", stateKind: "工具",
    component: sessionComponent,
    steps: [{ at: 0, label: "computer_get_windows 结算", set: live(sessionCall(0, {
      toolName: "computer_get_windows", args: {} })) }],
    checks: [
      attr("类别归到桌面", sel.call(sessionCallId(0)), "data-category", "DESKTOP"),
      text("动作词是枚举窗口", sel.call(sessionCallId(0)), "枚举窗口"),
      count("没有对象参数就不渲染对象段", `${sel.call(sessionCallId(0))} .activity-item-target`, 0)
    ],
    interactions: toggleRow(sessionCallId(0), [visible("空参数也如实展开", sel.detailArgs(sessionCallId(0)))])
  }),

  make({
    id: "B21", title: "未知或未适配的工具类型", host: "SESSION",
    stateKind: "边界", component: sessionComponent,
    steps: [{ at: 0, label: "computer_drag_window 尚未结算", set: live(sessionCall(0, {
      toolName: "computer_drag_window", args: { window_id: "mock-window" },
      status: "REQUESTED", settledAt: null })) }],
    checks: [
      attr("前缀仍归到桌面类", sel.call(sessionCallId(0)), "data-category", "DESKTOP"),
      text("动作词回退到桌面操作", sel.call(sessionCallId(0)), "桌面操作"),
      text("状态词如实说尚未结算", sel.call(sessionCallId(0)), "已请求，尚未结算"),
      attr("在途行是 active 档", sel.call(sessionCallId(0)), "data-tone", "active")
    ],
    interactions: toggleRow(sessionCallId(0), [
      text("详情里给出确切工具名", sel.callDetail(sessionCallId(0)), "computer_drag_window"),
      text("时间只报已落账的那一侧", sel.callDetail(sessionCallId(0)), "尚无结算时刻")])
  }),

  make({
    id: "B18", title: "浏览器工具调用", host: "SESSION", stateKind: "工具",
    component: sessionComponent,
    steps: [{ at: 0, label: "browser_read_page 结算", set: live(sessionCall(0, {
      toolName: "browser_read_page", args: { url: "https://example.invalid/docs" } })) }],
    checks: [
      attr("类别归到浏览器", sel.call(sessionCallId(0)), "data-category", "BROWSER"),
      text("动作词是读取网页", sel.call(sessionCallId(0)), "读取网页")
    ],
    interactions: toggleRow(sessionCallId(0))
  }),

  make({
    id: "X08", title: "未登记的浏览器动作", host: "SESSION", stateKind: "边界",
    component: sessionComponent,
    steps: [{ at: 0, label: "browser_wait_for_selector 结算", set: live(sessionCall(0, {
      toolName: "browser_wait_for_selector", args: { selector: "[data-testid=lab-root]" } })) }],
    checks: [
      attr("前缀归到浏览器类", sel.call(sessionCallId(0)), "data-category", "BROWSER"),
      text("动作词回退到浏览器操作", sel.call(sessionCallId(0)), "浏览器操作")
    ],
    interactions: toggleRow(sessionCallId(0))
  }),

  make({
    id: "B20", title: "GitHub/MCP 工具调用", host: "SESSION", stateKind: "工具",
    component: sessionComponent,
    steps: [{ at: 0, label: "github_pr_view 结算", set: live(sessionCall(0, {
      toolName: "github_pr_view", args: { number: 412 } })) }],
    checks: [
      text("动作词是查看 PR", sel.call(sessionCallId(0)), "查看 PR"),
      attr("类别按外部查询归类", sel.call(sessionCallId(0)), "data-category", "OTHER")
    ],
    interactions: toggleRow(sessionCallId(0))
  }),

  make({
    id: "B22", title: "多工具交替调用", host: "SESSION",
    stateKind: "工具", component: sessionComponent,
    note: "折叠摘要按动作词合并计数；未知 MCP 名原样回显，不编中文动作。",
    steps: [{ at: 0, label: "四种工具在同一轮里依次结算", set: live(
      readCall(0, "package.json"),
      sessionCall(1, { toolName: "search_text", args: { query: "activation" } }),
      sessionCall(2, { toolName: "run_check", args: { check_id: "docs" } }),
      sessionCall(3, { toolName: "mcp__figma__get_node", args: { node_id: "12:34" } })) }],
    checks: [
      count("四行按服务端顺序列出", `${sel.traceRoundList()} .activity-item`, 4),
      text("在途标题只报已结算数", sel.traceActivity(), "已结算 4 项 · 正在执行"),
      notText("在途不宣布结束", sel.traceActivity(), "已结束"),
      visible("未知 MCP 行在场", sel.call(sessionCallId(3))),
      text("未知工具名原样显示", sel.call(sessionCallId(3)), "mcp__figma__get_node"),
      notText("不给未知工具编动作词", sel.call(sessionCallId(3)), "读取文件"),
      noDuplicateRows,
      leftEdgeAligned
    ],
    interactions: toggleRow(sessionCallId(2))
  }),

  make({
    id: "X09", title: "简洁档：正常完成行收起，风险项保留", host: "SESSION",
    stateKind: "呈现", component: sessionComponent,
    conditions: { density: "concise" },
    note: "密度只改「先看什么」：正常结算的行折起来，例外在任何档位都必须可见。",
    steps: [{ at: 0, label: "两条已结算 + 一条被拒 + 一条结果未知", set: live(
      readCall(0, "package.json"), readCall(1, "pnpm-workspace.yaml"),
      sessionCall(2, { toolName: "run_check", args: { check_id: "test" }, status: "REJECTED",
        rejectionReason: "不在白名单", rejectionDetail: "命令 run_check 未被登记" }),
      sessionCall(3, { toolName: "apply_changeset", args: { path: "src/a.ts" }, status: "UNKNOWN" })) }],
    checks: [
      count("简洁档只保留两项风险行", `${sel.traceRoundList()} .activity-item`, 2),
      visible("被拒的行仍可见", sel.call(sessionCallId(2))),
      visible("结果未知的行仍可见", sel.call(sessionCallId(3))),
      text("被拒原因常显在行下方", sel.callReason(sessionCallId(2)), "不在白名单 · 命令 run_check 未被登记"),
      attr("被拒行是 negative 档", sel.call(sessionCallId(2)), "data-tone", "negative"),
      attr("未知行是 negative 档", sel.call(sessionCallId(3)), "data-tone", "negative"),
      text("标题仍在途：结清两项，其余没有结论", sel.traceActivity(), "已结算 2 项 · 正在执行"),
      notText("在途不写已结束", sel.traceActivity(), "已结束")
    ]
  }),

  make({
    id: "X10", title: "详细档：第三层技术详情默认展开", host: "SESSION",
    stateKind: "呈现", component: sessionComponent,
    conditions: { density: "detailed" },
    steps: [{ at: 0, label: "两条已结算调用", set: live(readCall(0, "package.json"), readCall(1, "docs/README.md")) }],
    checks: [
      count("全部行都列出", `${sel.traceRoundList()} .activity-item`, 2),
      visible("第一行详情默认已展开", sel.callDetail(sessionCallId(0))),
      visible("第二行详情默认已展开", sel.callDetail(sessionCallId(1))),
      visible("参数块默认在场", sel.detailArgs(sessionCallId(1))),
      attr("展开键标记正确", sel.callToggle(sessionCallId(0)), "aria-expanded", "true")
    ]
  }),

  /* ---------------- 矩阵补齐：B02 / B10 / B11 / B12 / B13 ---------------- */

  make({
    id: "B02", title: "连续读取多个文件", host: "SESSION", stateKind: "工具",
    component: sessionComponent,
    note: "同一轮里三次读取 = 三行，不合并成一行「读取了若干文件」；每条对象各自点名。",
    steps: [{ at: 0, label: "同一轮连续三次 read_file",
      set: live(readCall(0, "apps/workbench/package.json"), readCall(1, "pnpm-workspace.yaml"),
        readCall(2, "docs/frontend/design-system.md")) }],
    checks: [
      count("三行各占一条", SESSION_ROW, 3),
      visible("第一行在场", sel.call(sessionCallId(0))),
      visible("第二行在场", sel.call(sessionCallId(1))),
      visible("第三行在场", sel.call(sessionCallId(2))),
      text("第二行点名自己的对象", sel.call(sessionCallId(1)), "pnpm-workspace.yaml"),
      text("第三行点名自己的对象", sel.call(sessionCallId(2)), "design-system.md"),
      text("标题按三项统计", sel.traceActivity(), "已结算 3 项 · 正在执行"),
      noDuplicateRows
    ],
    interactions: [
      ...toggleRow(sessionCallId(1), [text("第二行的参数是它自己的路径",
        sel.detailArgs(sessionCallId(1)), "pnpm-workspace.yaml")]),
      ...toggleRow(sessionCallId(2), [text("第三行的参数是它自己的路径",
        sel.detailArgs(sessionCallId(2)), "docs/frontend/design-system.md")])]
  }),

  make({
    id: "B10", title: "运行较长命令", host: "RUN_TRAJECTORY", stateKind: "工具",
    component: runPanelComponent,
    note: "`run_check` 按契约只收 `check_id`（模型不能提交任意 shell），所以「命令很长」"
      + "在真实语义里是一条**很长的已配置检查标识**。折叠行的对象位取 `args.check_id` 原串，"
      + "既不裁中段也不换行改写，展开后的参数逐字保留。",
    steps: frame("run_check 点名一条标识很长的检查", {
      run: labRun(), runToolCalls: runProjection([[runCall(0, { toolName: "run_check",
        args: { check_id: LONG_CHECK_ID },
        resultRef: { stdout: "build finished", exit_code: 0 } })]]) }),
    checks: [
      visible("命令行在场", sel.runCall(runCallId(0))),
      text("折叠行带上检查标识本身", sel.runCall(runCallId(0)), "integration:e2e:nightly"),
      text("折叠行不裁掉中段", sel.runCall(runCallId(0)), "empty-out-dir"),
      text("折叠行不裁掉尾段", sel.runCall(runCallId(0)), "MARKERMARKER"),
      attr("状态词按真实状态标为 SETTLED", `${sel.runCall(runCallId(0))} .trajectory-status`,
        "data-status", "SETTLED"),
      visible("退出码在折叠态就可见", sel.runExecSummary(runCallId(0))),
      text("折叠态报退出码 0", sel.runExecSummary(runCallId(0)), "退出码 0")
    ],
    interactions: [
      ...toggleRunRow(runCallId(0), [
        text("展开后的参数是完整原串", sel.runArgs(runCallId(0)), "sourcemap-off"),
        text("结果正文逐字来自 result_ref", sel.runResult(runCallId(0)), "build finished")])],
    conditions: { viewport: "narrow" }
  }),

  make({
    id: "B11", title: "命令实时输出", host: "RUN_TRAJECTORY", stateKind: "在途",
    component: runPanelComponent,
    note: "这一条验的是**执行中不能编出输出**：产品的 `result_ref` 只在结算那一次落到账本，"
      + "没有逐 token 的 stdout 流，所以界面在 PREPARED 这一档既不该有结果正文，"
      + "也不该写成「没有输出」这种像结论的话——它只能说是没有结算结果。"
      + "把在途命令画成打字机效果就是替模型提前下结论。",
    steps: [
      at(0, "命令已请求（REQUESTED）", { run: labRun(),
        runToolCalls: runProjection([[runCall(0, { toolName: "run_check",
          args: { check_id: "test" }, status: "REQUESTED", resultRef: null })]]) }),
      at(2_000, "命令已派发、正在执行（PREPARED）", { run: labRun(),
        runToolCalls: runProjection([[runCall(0, { toolName: "run_check",
          args: { check_id: "test" }, status: "PREPARED", resultRef: null })]]) })
    ],
    checks: [
      visible("命令行在场", sel.runCall(runCallId(0))),
      text("状态词说执行中或结果未决", sel.runCall(runCallId(0)), "执行中或结果未决"),
      attr("状态词按真实状态标为 PREPARED", `${sel.runCall(runCallId(0))} .trajectory-status`,
        "data-status", "PREPARED"),
      gone("在途不摆结果正文", sel.runPreview(runCallId(0))),
      gone("在途没有退出码可报，因此不摆执行元数据", sel.runExecSummary(runCallId(0))),
      text("分类标题说明这是没有结算结果", sel.runFailure(runCallId(0)), "没有结算结果"),
      notText("在途不写成失败", sel.runFailure(runCallId(0)), "已结算但失败"),
      text("统计把它算进未决一项", sel.runCounts(), "正在执行或结果未决 1")
    ]
  }),

  make({
    id: "B12", title: "命令大量 stdout", host: "RUN_TRAJECTORY", stateKind: "边界",
    component: runPanelComponent,
    note: "四十行输出折叠时只显示头 4 与尾 4，省略量写在行上；展开后才给完整正文。",
    steps: frame("run_check 结算，stdout 40 行", {
      run: labRun(), runToolCalls: runProjection([[runCall(0, { toolName: "run_check",
        args: { check_id: "test" }, resultRef: { stdout: STDOUT_40, exit_code: 0 } })]]) }),
    checks: [
      visible("命令行在场", sel.runCall(runCallId(0))),
      visible("折叠预览在场", sel.runPreview(runCallId(0))),
      text("折叠预览给第一行", sel.runPreview(runCallId(0)), STDOUT_40_LINE(0)),
      text("折叠预览给最后一行", sel.runPreview(runCallId(0)), STDOUT_40_LINE(39)),
      notText("折叠预览不铺中段", sel.runPreview(runCallId(0)), STDOUT_40_LINE(19)),
      text("省略量按真实数报出", sel.runHidden(runCallId(0)), "省略 32 行"),
      text("说明头尾各四行", sel.runHidden(runCallId(0)), "只显示头 4 行与尾 4 行"),
      text("展开入口按完整行数报出", sel.runExpand(runCallId(0)), "展开结果（40 行）")
    ],
    interactions: [
      { kind: "click", selector: sel.runExpand(runCallId(0)), label: "展开完整 40 行",
        then: [visible("完整正文已挂载", sel.runResult(runCallId(0))),
          text("中段行在展开后可见", sel.runResult(runCallId(0)), STDOUT_40_LINE(19)),
          gone("折叠预览让位给完整正文", sel.runPreview(runCallId(0))),
          attr("展开态标记正确", sel.runExpand(runCallId(0)), "aria-expanded", "true")] }],
    conditions: { viewport: "narrow" }
  }),

  make({
    id: "B13", title: "命令包含 stderr", host: "RUN_TRAJECTORY", stateKind: "失败",
    component: runPanelComponent,
    note: "这条同时暴露一个真实产品问题：`resultText` 优先取 `content`，其次取 `stdout`，"
      + "两者都没有才按 JSON 原样展开。因此**同时带 stdout 与 stderr 的回执里，stderr 不会出现在界面上**。"
      + "这里故意不给 stdout 键，让回执按 JSON 展开，stderr 才逐字可见；"
      + "退出码与失败分类仍各自按落到的键报，不从 stderr 推断。",
    steps: frame("run_check 结算，只有 stderr 与退出码", {
      run: labRun(), runToolCalls: runProjection([[runCall(0, { toolName: "run_check",
        args: { check_id: "lint" }, resultRef: { exit_code: 1, outcome: "FAILED",
          reason: "LINT_FAILED", stderr: "6: 'x' is declared but its value is never read." } })]]) }),
    checks: [
      visible("命令行在场", sel.runCall(runCallId(0))),
      text("stderr 文字逐字可见", sel.runPreview(runCallId(0)), "is declared but its value is never read"),
      text("退出码在折叠态可见", sel.runExecSummary(runCallId(0)), "退出码 1"),
      visible("失败分类是「已结算但失败」", sel.runFailure(runCallId(0))),
      text("失败分类标题", sel.runFailure(runCallId(0)), "已结算但失败"),
      text("原因原样透出", sel.runFailure(runCallId(0)), "LINT_FAILED"),
      attr("状态仍是 SETTLED，失败不改写状态词", `${sel.runCall(runCallId(0))} .trajectory-status`,
        "data-status", "SETTLED")
    ],
    interactions: toggleRunRow(runCallId(0), [
      text("展开后仍能看到 stderr", sel.runResult(runCallId(0)), "stderr")])
  })
];
