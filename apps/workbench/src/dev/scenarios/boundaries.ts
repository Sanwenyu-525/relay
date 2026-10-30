import type { RelayRunToolCall, RelaySessionToolCall } from "../../api/dtos/assist";
import {
  assistantMessage, changeSets, draftOf, fileChange, frozenDiff, labRun, livePreview, LONG_CHECK_ID, LONG_PATH,
  LONG_STDOUT, MARKDOWN_LONG, MARKDOWN_RICH, MIXED_CJK, MOCK, pair, readCall, runCall, runProjection,
  sessionCall, sessionTrace, TABLE_WIDE, userMessage
} from "../scenarioFixtures";
import type { ScenarioWorld } from "../scenarioWorld";
import {
  at, attr, closedWorld, count, frame, gone, headTailPreview, inspect, ledgerKey, leftEdgeAligned, liveWorld, make,
  motionCount, noDuplicateRows, notText, RUN_ROW, runCallId, runPanelComponent, runSummaryComponent,
  scrollStable, sel, sessionCallId, sessionComponent, text, toggleRow, visible, visibleRow
} from "./common";

/**
 * F 组 · 长任务与边界（20 条）。
 *
 * 这一组问的是**规模与形状会不会把界面压垮**，而不是功能有没有：
 *   * 会话侧长轮次会收敛（前 6 项 + 全部例外项），Run 侧轨迹是全量只读账本，两边规则不同，
 *     各自钉住：F01/F02 验收敛后仍报真实规模，F03/F04 验不收敛时也不重复、不横向溢出。
 *   * 超长内容（路径、命令、输出、正文、宽表格）必须由**自己那一层**消化：截断或框内滚动，
 *     不许把整份回复的阅读列顶宽（`noOverflow` 每条自动附加）。
 *   * 交互边界（上滚后位置、展开时来新事件、刷新历史、快速切会话、快速连点开合）只能用真实
 *     交互验，所以全部落在 `interactions` 里，而不是静态断言。
 *   * 呈现条件（窄窗 + 高倍屏、动效关闭、明暗两套）由控制器的 `conditions` 施加，
 *     场景数据本身不变——同一条事实换了外壳不该改口径。
 *
 * 一处不装：F04 的「300 行仍然跟手」是**帧率与长任务**问题，DOM 断言答不了它；
 * 那条由 `tests/browser/assistScenarioLab.spec.ts` 里的计时断言负责，这里只声明结构事实。
 */

const PATH = "apps/workbench/package.json";

/** 会话侧一批中性已结算读取：用来把长轮次填满，不掺状态差异。 */
function reads(count: number): RelaySessionToolCall[] {
  return Array.from({ length: count }, (_, index) =>
    readCall(index, `apps/workbench/src/dev/scenarios/chunk-${index}.ts`));
}

/** Run 侧一批已结算读取：轨迹面板不收敛，因此行数＝调用数。 */
function runReads(count: number): RelayRunToolCall[] {
  return Array.from({ length: count }, (_, index) =>
    runCall(index, { toolName: "read_file", args: { relative_path: `src/dev/chunk-${index}.ts` } }));
}

/**
 * 某一轮的已结算读取：路径里带轮号，跨轮归属才能在 DOM 上验出来。
 * 身份按 `round * 10 + index` 递增，保证三轮之间不撞 `call.id`（撞了就会被 `dedupeCalls` 合行）。
 */
function roundReads(round: number, count: number): RelayRunToolCall[] {
  return Array.from({ length: count }, (_, index) =>
    runCall(round * 10 + index, {
      round, toolName: "read_file", args: { relative_path: `src/round-${round}/chunk-${index}.ts` }
    }));
}

/** `LONG_STDOUT` 那一行的构造规则（与夹具同一公式）：折叠态的头尾必须逐字对得上。 */
const stdoutLine = (index: number): string =>
  `[2026-10-30T09:00:${String(index % 60).padStart(2, "0")}] worker=${index % 8} stage=verify ` +
  `line=${index} status=ok payload=${"x".repeat(24)}`;

/** 折叠预览的确切内容：与产品同一规则（头 4 + 省略标记 + 尾 4），逐字比对而不是「差不多」。 */
const FOLDED_PREVIEW = headTailPreview(400, 8, stdoutLine).join("\n");

/** 一条独立会话：自己的消息身份与自己的账本；快速切换时不得串到别的会话上。 */
function sessionOf(which: "a" | "b", calls: readonly RelaySessionToolCall[]): Partial<ScenarioWorld> {
  const sessionId = which === "a" ? MOCK.sessionId : "mock-session-b";
  const messageId = which === "a" ? MOCK.assistantMessageId : `${MOCK.assistantMessageId}-b`;
  const userId = which === "a" ? MOCK.userMessageId : `${MOCK.userMessageId}-b`;
  return {
    messages: [userMessage(`会话${which === "a" ? "甲" : "乙"}的问题`, { id: userId, sessionId }),
      assistantMessage({ id: messageId, sessionId, status: "RUNNING", content: null })],
    traces: { [messageId]: sessionTrace([calls], messageId) }
  };
}

/** 一条只有正文的终态消息（超长正文类场景的通用开局）。 */
function contentWorld(content: string): Partial<ScenarioWorld> {
  return {
    messages: [userMessage("把这一轮的结论写清楚"),
      assistantMessage({ status: "COMPLETED", content })]
  };
}

export const BOUNDARIES = [
  make({
    id: "F01", title: "20 次工具调用", host: "SESSION",
    stateKind: "边界", component: sessionComponent, conditions: { density: "standard" },
    note: "折叠时铺出来的是 6 行，报出来的必须是 20 项——把当前行数当成整轮规模是另一种谎。",
    steps: frame("一条在途消息 + 20 条已结算的读取", liveWorld(...reads(20))),
    checks: [
      count("折叠态只铺前 6 行", ".activity-panel-list .activity-item", 6),
      visibleRow("第 1 行确实看得见", sessionCallId(0)),
      text("轮次标题按真实规模报数", sel.traceRound(0), "20 项"),
      text("折叠入口报出还差多少", sel.traceMore(0), "展开其余 14 项"),
      text("顶栏继续按已结算数报", sel.traceActivity(), "已结算 20 项 · 正在执行"),
      gone("第 7 行此刻根本不在 DOM 里", sel.call(sessionCallId(6))),
      noDuplicateRows, leftEdgeAligned
    ],
    interactions: [
      { kind: "click", selector: sel.traceMore(0), label: "展开这一轮的其余项",
        then: [count("20 行全部铺出来", ".activity-panel-list .activity-item", 20),
          visible("给出收起入口", sel.traceLess(0)),
          text("收起入口文案", sel.traceLess(0), "收起这一轮"),
          gone("折叠入口让位（不会两个都在）", sel.traceMore(0)),
          noDuplicateRows] },
      { kind: "click", selector: sel.traceLess(0), label: "再收起这一轮",
        then: [count("回到只铺前 6 行", ".activity-panel-list .activity-item", 6),
          visible("折叠入口回到原位", sel.traceMore(0)),
          text("规模读数不变", sel.traceRound(0), "20 项")] }
    ]
  }),

  make({
    id: "F02", title: "50 次工具调用", host: "SESSION",
    stateKind: "边界", component: sessionComponent, conditions: { density: "standard" },
    note: "第 24 项待核对、第 42 项未执行，都排在头部 6 行之后；收敛把它们留在折叠区里，" +
      "简洁档就成了「一切顺利」的假象。例外项无条件保留是这条验的东西。",
    steps: frame("50 条已结算 + 1 条 UNKNOWN + 1 条 REJECTED", liveWorld(...Array.from(
      { length: 50 },
      (_, index) => index === 23
        ? sessionCall(index, { toolName: "search_text", args: { query: "activityHeaderState" },
          status: "UNKNOWN" })
        : index === 41
          ? sessionCall(index, { toolName: "read_file", args: { relative_path: "src/dev/missing.ts" },
            status: "REJECTED", rejectionReason: "ADMISSION_DENIED" })
          : readCall(index, `apps/workbench/src/dev/scenarios/chunk-${index}.ts`)))),
    checks: [
      count("头部 6 行 + 两条例外行 = 8 行", ".activity-panel-list .activity-item", 8),
      visible("第 24 项（待核对）仍在折叠区外", sel.call(sessionCallId(23))),
      visible("第 42 项（未执行）仍在折叠区外", sel.call(sessionCallId(41))),
      gone("第 21 项（普通已结算）被收起来了", sel.call(sessionCallId(20))),
      text("规模按 50 项报而不是按铺出的 8 行报", sel.traceRound(0), "50 项"),
      text("折叠入口报出真实缺口", sel.traceMore(0), "展开其余 42 项"),
      text("顶栏已结算数不含那两条例外", sel.traceActivity(), "已结算 48 项 · 正在执行")
    ],
    interactions: [{
      kind: "click", selector: sel.traceMore(0), label: "展开全部 50 项",
      then: [count("50 行全部铺出来", ".activity-panel-list .activity-item", 50),
        visible("先前被收起的第 21 项回来了", sel.call(sessionCallId(20))),
        attr("待核对那行的视觉档仍是负向", sel.call(sessionCallId(23)), "data-tone", "negative"),
        attr("未执行那行的视觉档仍是负向", sel.call(sessionCallId(41)), "data-tone", "negative"),
        noDuplicateRows] }
    ]
  }),

  make({
    id: "F03", title: "100 次工具调用", host: "RUN_TRAJECTORY",
    stateKind: "边界", component: runPanelComponent,
    note: "轨迹面板是只读全量账本，不做头尾收敛：100 行就渲染 100 行。「刷新一下多出一倍」" +
      "是重放类 Bug 的典型形状，这里用同一次读取里点刷新来钉住它。",
    steps: frame("一轮 100 条已结算读取", { run: labRun(), runToolCalls: runProjection([runReads(100)]) }),
    checks: [
      count("100 张调用卡片全部在场", RUN_ROW, 100),
      text("计数按真实结算数报", sel.runCounts(), "已结算 100"),
      text("没有正在执行的行就不虚报", sel.runCounts(), "正在执行或结果未决 0"),
      visible("轨迹面板与证据注记在场", sel.runEvidenceNote()),
      notText("100 行不等于已通过验证", sel.runCounts(), "已通过"),
      noDuplicateRows
    ],
    interactions: [{
      kind: "click", selector: sel.runRefresh(), label: "点刷新：重读同一份事实",
      then: [count("重读不会把 100 行变成 200 行", RUN_ROW, 100),
        text("计数仍是 100", sel.runCounts(), "已结算 100"),
        noDuplicateRows] }
    ]
  }),

  make({
    id: "F04", title: "300 次工具调用", host: "RUN_TRAJECTORY",
    stateKind: "边界", component: runPanelComponent,
    note: "300 行的**跟手程度**（帧率、长任务）不是 DOM 断言能回答的，由 Playwright 那条计时" +
      "断言负责；这一条只声明结构事实：行数对得上、身份不重复、阅读列不撑宽。",
    steps: frame("一轮 300 条已结算读取", { run: labRun(), runToolCalls: runProjection([runReads(300)]) }),
    checks: [
      count("300 张调用卡片", RUN_ROW, 300),
      text("计数按 300 报", sel.runCounts(), "已结算 300"),
      visible("第一张卡片在场", sel.runCall(runCallId(0))),
      visible("最后一张卡片也在场（不是只渲染前若干条）", sel.runCall(runCallId(299))),
      visible("面板自己带滚动容器", sel.runPanel()),
      noDuplicateRows
    ]
  }),

  make({
    id: "F05", title: "多轮工具执行", host: "RUN_TRAJECTORY",
    stateKind: "边界", component: runPanelComponent,
    note: "轮次分组只认服务端 `rounds` 的顺序与归属：界面不重排、不按工具名合并，"
      + "也不把跨轮的两次读取算成同一件事。标题里的轮号就是 `round.round` 本身，"
      + "因此夹具从 0 起就会显示「第 0 轮」——这是产品事实，实验室不改口。",
    steps: frame("三轮 3 + 4 + 2 条已结算读取", {
      run: labRun(),
      runToolCalls: runProjection([roundReads(0, 3), roundReads(1, 4), roundReads(2, 2)],
        { runStatus: "COMPLETED" })
    }),
    checks: [
      count("三轮各有一个分组容器", ".trajectory-round", 3),
      visible("第 0 轮在场", sel.runRound(0)),
      visible("第 1 轮在场", sel.runRound(1)),
      visible("第 2 轮在场", sel.runRound(2)),
      text("轮号原样来自服务端字段", sel.runRound(1), "第 1 轮"),
      count("卡片总数＝三轮之和", RUN_ROW, 9),
      text("第 0 轮里是它自己的调用", sel.runRound(0), "src/round-0/chunk-2.ts"),
      notText("第 0 轮不吞进别的轮次", sel.runRound(0), "round-1"),
      text("第 1 轮条数更多也不越界", sel.runRound(1), "src/round-1/chunk-3.ts"),
      text("最后一轮只有两条也在场", sel.runRound(2), "src/round-2/chunk-1.ts"),
      text("计数跨轮汇总而不是按轮各算一次", sel.runCounts(), "已结算 9"),
      visible("终态 Run 的证据注记仍在", sel.runEvidenceNote()),
      noDuplicateRows
    ],
    interactions: [{
      kind: "click", selector: sel.runRefresh(), label: "刷新：重读同一份多轮事实",
      then: [count("分组仍是三轮", ".trajectory-round", 3),
        count("卡片仍是一张不多", RUN_ROW, 9), noDuplicateRows]
    }]
  }),

  make({
    id: "F07", title: "超长文件路径", host: "SESSION",
    stateKind: "边界", component: sessionComponent, conditions: { viewport: "narrow" },
    note: "折叠行的对象取自参数（这一版逐字给出，不做末段截短），超长串只能靠不撑宽阅读列来消化；" +
      "展开后的参数必须是服务端那一条原样值。",
    steps: frame("读取一个极深的路径", liveWorld(readCall(0, LONG_PATH))),
    checks: [
      visible("调用行在场", sel.call(sessionCallId(0))),
      text("折叠行逐字给出对象值", sel.call(sessionCallId(0)), "ActivityRowPresentationProbe.tsx"),
      leftEdgeAligned, noDuplicateRows
    ],
    interactions: toggleRow(sessionCallId(0), [
      visible("参数区在场", sel.detailArgs(sessionCallId(0))),
      text("参数区给完整路径头部", sel.detailArgs(sessionCallId(0)), "apps/workbench/src/components/activityPresentation"),
      text("参数区给完整路径末段", sel.detailArgs(sessionCallId(0)), "ActivityRowPresentationProbe.tsx"),
      noDuplicateRows])
  }),

  make({
    id: "F08", title: "超长命令", host: "RUN_SUMMARY",
    stateKind: "边界", component: runSummaryComponent,
    note: "命令这一侧的长内容是**已配置检查标识**（`run_check` 只收 `check_id`）：摘要行可以把对象收窄，"
      + "展开后的参数不许重写或省略中段。",
    steps: frame("一条 run_check，命令极长", {
      run: labRun(),
      runToolCalls: runProjection([[runCall(0, { toolName: "run_check", args: { check_id: LONG_CHECK_ID },
        resultRef: { stdout: "build ok", exit_code: 0 } })]])
    }),
    checks: [
      visible("摘要行在场", sel.summaryActivity(runCallId(0))),
      text("折叠行给出检查标识的开头", sel.summaryActivity(runCallId(0)), "integration:e2e:nightly"),
      text("统计把它算进命令次数", sel.summary(), "检查 1 次"),
      noDuplicateRows
    ],
    interactions: [{
      kind: "click", selector: sel.summaryActivityToggle(runCallId(0)), label: "展开这条命令的参数",
      then: [visible("参数区在场", sel.detailArgs(runCallId(0))),
        text("中段逐字可见", sel.detailArgs(runCallId(0)), "empty-out-dir"),
        text("尾部逐字可见", sel.detailArgs(runCallId(0)), "MARKERMARKER"),
        visible("回执入口仍在（展开后不消失）", sel.summaryActivity(runCallId(0))),
        noDuplicateRows] }
    ]
  }),

  make({
    id: "F09", title: "超长终端输出", host: "RUN_TRAJECTORY",
    stateKind: "边界", component: runPanelComponent,
    note: "折叠态必须真把头尾两段画出来：文案说「只显示头 4 行与尾 4 行」时，那 8 行就在 DOM 里，" +
      "省略中段的那一行也在这儿。错误通常在尾部，所以保留尾部不是排版偏好。",
    steps: frame("一条 run_check，stdout 共 400 行", {
      run: labRun(),
      runToolCalls: runProjection([[runCall(0, { toolName: "run_check", args: { check_id: "test" },
        resultRef: { stdout: LONG_STDOUT, exit_code: 0 } })]])
    }),
    checks: [
      visible("折叠预览块在场", sel.runPreview(runCallId(0))),
      text("折叠预览逐字等于头 4 + 省略标记 + 尾 4", sel.runPreview(runCallId(0)), FOLDED_PREVIEW),
      text("折叠预览的第一行是输出首行", sel.runPreview(runCallId(0)), stdoutLine(0)),
      text("折叠预览的末行是输出末行", sel.runPreview(runCallId(0)), stdoutLine(399)),
      text("中段以省略标记呈现", sel.runPreview(runCallId(0)), "… 省略 392 行 …"),
      text("省略量与头尾行数一并说明", sel.runHidden(runCallId(0)), "省略 392 行（只显示头 4 行与尾 4 行）"),
      text("展开按钮报出总行数", sel.runExpand(runCallId(0)), "展开结果（400 行）"),
      count("折叠预览只有一个正文块（不会头尾各挂一份）", sel.runPreview(runCallId(0)), 1),
      gone("没展开时不渲染完整正文块", sel.runResult(runCallId(0))),
      noDuplicateRows
    ],
    interactions: [
      { kind: "click", selector: sel.runExpand(runCallId(0)), label: "展开完整 400 行",
        then: [visible("完整正文块挂载", sel.runResult(runCallId(0))),
          text("被省略过的中段现在读得到", sel.runResult(runCallId(0)), stdoutLine(200)),
          gone("折叠预览让位，不与完整正文重复", sel.runPreview(runCallId(0))),
          gone("省略说明随之消失", sel.runHidden(runCallId(0))),
          count("同一身份仍是一张卡片", RUN_ROW, 1)] },
      { kind: "click", selector: sel.runExpand(runCallId(0)), label: "再收起",
        then: [visible("回到头尾两段的折叠预览", sel.runPreview(runCallId(0))),
          text("省略量重新报出", sel.runHidden(runCallId(0)), "省略 392 行"),
          gone("完整正文块卸载", sel.runResult(runCallId(0))),
          text("按钮文案换回展开", sel.runExpand(runCallId(0)), "展开结果（400 行）")] }
    ]
  }),

  make({
    id: "F10", title: "超长 Markdown", host: "SESSION",
    stateKind: "边界", component: sessionComponent,
    steps: frame("终态消息带一段极长的 Markdown", { ...contentWorld(MARKDOWN_LONG) }),
    checks: [
      visible("正文块在场", sel.replyFinal()),
      visible("Markdown 根在场", sel.markdown()),
      text("第一段可读出", sel.markdown(), "1. 段落"),
      text("最后一段没有被裁掉", sel.markdown(), "24. 段落"),
      text("中段内容仍在同一块里", sel.markdown(), "12. 段落"),
      gone("终态正文不挂草稿块", sel.replyDraft())
    ]
  }),

  make({
    id: "F11", title: "中文和英文混排", host: "SESSION",
    stateKind: "边界", component: sessionComponent, conditions: { viewport: "narrow" },
    note: "全角标点、书名号、`D:/Develop/Relay-Agent` 这类不带空格的长串是最容易把列顶宽的字符；" +
      "溢出检查（自动附加的 noOverflow）在这一条里最严格。",
    steps: frame("终态正文：中英混排与长路径", { ...contentWorld(MIXED_CJK) }),
    checks: [
      visible("Markdown 根在场", sel.markdown()),
      text("拉丁技术名逐字保留", sel.markdown(), "TypeScript / React / PostgreSQL"),
      text("全角书名号不被吞", sel.markdown(), "《》"),
      text("行内代码里的长路径可读", sel.markdown(), "apps/workbench/src/dev/scenarioWorld.ts"),
      text("代码块内容原样呈现", sel.markdown(), "pnpm --filter relay-workbench-fixture run test"),
      text("最后一句仍在这块正文里", sel.markdown(), "不出现行内代码把行高顶开")
    ]
  }),

  make({
    id: "F12", title: "表格与代码块混排", host: "SESSION",
    stateKind: "边界", component: sessionComponent, conditions: { viewport: "narrow" },
    note: "宽内容是表格自己的事：给它一个可聚焦的滚动区域，而不是把整条回复推成横向滚动页面。",
    steps: frame("终态正文：一张很宽的表", { ...contentWorld(TABLE_WIDE) }),
    checks: [
      visible("表格滚动容器在场", sel.tableScroll()),
      attr("容器可聚焦（键盘也能滚）", sel.tableScroll(), "tabindex", "0"),
      // 可访问名在 region 的 aria-label 上（SafeMarkdown.tsx:193-194），不是文本节点，
      // 因此按属性断言；用文本断言会把整张表的内容当成「名字」。
      attr("滚动区域有明确的可访问名", sel.tableScroll(), "aria-label", "Markdown 表格，较宽时可横向滚动"),
      visible("表格本体在自己的滚动区里", `${sel.tableScroll()} table`),
      text("末行内容完整", sel.markdown(), "第 14 条宽表格行"),
      visible("表格之外的正文块仍在同一列里", sel.markdown())
    ]
  }),

  make({
    id: "F13", title: "用户向上滚动时继续生成", host: "SESSION",
    stateKind: "流式", component: sessionComponent,
    note: "用户在流式过程中往上翻是很自然的动作。追加的内容只在草稿尾部，" +
      "不该改动他已经站稳的阅读位置——这条必须先跑 scrollUp，否则判失败而不是判通过。",
    steps: [
      at(0, "草稿出一段（约 35%）", {
        messages: pair({ status: "RUNNING", content: null }),
        preview: livePreview({ previewAvailable: true, previewRevision: "1",
          previewText: draftOf(MARKDOWN_RICH, 0.35) })
      }),
      at(1_200, "草稿续出（约 70%：同一块，只是更长）", {
        preview: livePreview({ previewAvailable: true, previewRevision: "2",
          previewText: draftOf(MARKDOWN_RICH, 0.7) })
      })
    ],
    checks: [
      visible("草稿块在场", sel.replyDraft()),
      text("草稿标注它不是完整消息", sel.replyNote(), "不是完整消息或已接受产物")
    ],
    interactions: [
      { kind: "scrollUp", label: "把阅读位置往上滚一段（此刻还在生成）",
        then: [visible("滚上去之后草稿块仍在这个宿主里", sel.replyDraft()),
          scrollStable] },
      { kind: "advance", label: "推进到草稿变长的那一帧",
        then: [scrollStable,
          visible("草稿没有整块被换成新节点", sel.replyDraft()),
          text("新追加的内容确实到了同一块里", sel.replyDraft(), "结论：顺序问题只出在"),
          gone("流式中不出现终态正文块", sel.replyFinal())] }
    ]
  }),

  make({
    id: "F14", title: "展开详情后继续更新", host: "RUN_TRAJECTORY",
    stateKind: "在途", component: runPanelComponent,
    note: "展开状态 keyed 在调用身份上：新事件只加卡片，不该把用户正在读的那张合上或整体卸载。",
    steps: [
      at(0, "两条已结算调用", {
        run: labRun(),
        runToolCalls: runProjection([[runCall(0, { toolName: "read_file", args: { relative_path: PATH } }),
          runCall(1, { toolName: "list_directory", args: { path: "apps/workbench/src" } })]])
      }),
      at(2_000, "第三条落账（前两条身份不变）", {
        run: labRun(),
        runToolCalls: runProjection([[runCall(0, { toolName: "read_file", args: { relative_path: PATH } }),
          runCall(1, { toolName: "list_directory", args: { path: "apps/workbench/src" } }),
          runCall(2, { toolName: "search_text", args: { query: "activityHeaderState" } })]])
      })
    ],
    checks: [count("最后一帧三张卡片", RUN_ROW, 3), text("计数三条已结算", sel.runCounts(), "已结算 3")],
    interactions: [
      // 「开局两张」是第 0 帧的事实，静态断言跑在最后一帧，因此用 inspect 就地钉。
      inspect("第 0 帧：两张卡片", count("卡片两张", RUN_ROW, 2),
        text("计数两条已结算", sel.runCounts(), "已结算 2")),
      { kind: "click", selector: sel.runExpand(runCallId(0)), label: "展开第一张卡片的结果",
        then: [visible("参数区挂载", sel.runArgs(runCallId(0))),
          attr("展开态标记正确", sel.runExpand(runCallId(0)), "aria-expanded", "true")] },
      { kind: "advance", label: "推进到第三条落账的那一帧",
        then: [visible("先前展开的参数区没被新事件收回", sel.runArgs(runCallId(0))),
          count("新卡片照常追加，总数三张", RUN_ROW, 3),
          text("计数升到三条", sel.runCounts(), "已结算 3"),
          attr("第一张仍标着展开", sel.runExpand(runCallId(0)), "aria-expanded", "true"),
          gone("第三张没有被顺手展开", sel.runArgs(runCallId(2))),
          noDuplicateRows] }
    ]
  }),

  make({
    id: "F15", title: "历史消息刷新恢复", host: "SESSION",
    stateKind: "恢复", component: sessionComponent,
    note: "刷新走的是「按同一身份重读」，不是「再挂一份」。这里用同一份账本换一个新对象身份重放，" +
      "验的是身份 keyed 的开合状态与去重，不是网络。",
    steps: [
      at(0, "终态消息：两条已结算", closedWorld(readCall(0, PATH),
        sessionCall(1, { toolName: "list_directory", args: { path: "apps/workbench/src" } }))),
      at(2_000, "刷新历史：按同一身份重读，得到同样两条", closedWorld(readCall(0, PATH),
        sessionCall(1, { toolName: "list_directory", args: { path: "apps/workbench/src" } })))
    ],
    checks: [visible("过程入口在场", sel.traceToggle())],
    interactions: [
      { kind: "click", selector: sel.traceToggle(), label: "展开执行过程（首次读取）",
        then: [count("两行", ".activity-panel-list .activity-item", 2),
          attr("面板展开态标记正确", sel.traceToggle(), "aria-expanded", "true")] },
      { kind: "click", selector: sel.callToggle(sessionCallId(0)), label: "展开第一行详情",
        then: [visible("详情挂载", sel.callDetail(sessionCallId(0)))] },
      { kind: "advance", label: "推进到「刷新后重读」的那一帧",
        then: [count("重读没有把两行变成四行", ".activity-panel-list .activity-item", 2),
          noDuplicateRows,
          attr("面板仍处在我打开的状态", sel.traceToggle(), "aria-expanded", "true"),
          visible("我展开的那一行详情没被刷新收回", sel.callDetail(sessionCallId(0))),
          text("规模读数仍是两条", sel.traceActivity(), "2 项操作 · 已结束"),
          visible("正文不受刷新影响", sel.replyFinal())] }
    ]
  }),

  make({
    id: "F16", title: "快速切换会话", host: "SESSION",
    stateKind: "边界", component: sessionComponent,
    note: "甲有两条、乙有一条且行身份不同。停在乙时甲的行必须不在——把上一个会话的行留在原地，" +
      "就是「看着像串了数据」那个用户可见症状。",
    steps: [
      at(0, "会话甲：两条已结算", sessionOf("a", [readCall(0, PATH),
        sessionCall(1, { toolName: "list_directory", args: { path: "apps/workbench/src" } })])),
      at(150, "切到会话乙：一条不同的调用", sessionOf("b", [
        sessionCall(10, { toolName: "search_text", args: { query: "activityHeaderState" } })])),
      at(300, "立刻切回甲", sessionOf("a", [readCall(0, PATH),
        sessionCall(1, { toolName: "list_directory", args: { path: "apps/workbench/src" } })])),
      at(450, "再切到乙（连续快速切换，最后停在乙）", sessionOf("b", [
        sessionCall(10, { toolName: "search_text", args: { query: "activityHeaderState" } })]))
    ],
    checks: [
      visible("停在乙：面板身份跟着消息走", sel.trace(`${MOCK.assistantMessageId}-b`)),
      visible("只有乙的那一行", sel.call(sessionCallId(10))),
      gone("甲的第一行没有跟过来", sel.call(sessionCallId(0))),
      gone("甲的第二行也没有跟过来", sel.call(sessionCallId(1))),
      count("整屏只有一行工具调用", ".activity-panel-list .activity-item", 1),
      text("规模按乙报", sel.traceRound(0), "1 项"),
      noDuplicateRows
    ]
  }),

  make({
    id: "F17", title: "快速展开/收起", host: "SESSION",
    stateKind: "呈现", component: sessionComponent,
    note: "连点四次是偶数次：详情必须回到「关」，入口必须还在。停在半开或整个消失都是状态机错了。",
    steps: frame("一条已结算的读取", liveWorld(readCall(0, PATH))),
    checks: [visible("调用行在场", sel.call(sessionCallId(0))), count("开局一行", ".activity-panel-list .activity-item", 1)],
    interactions: [
      { kind: "click", selector: sel.callToggle(sessionCallId(0)), label: "第 1 次点击：展开",
        then: [visible("详情挂载", sel.callDetail(sessionCallId(0))),
          attr("展开态标记为 true", sel.callToggle(sessionCallId(0)), "aria-expanded", "true")] },
      { kind: "click", selector: sel.callToggle(sessionCallId(0)), label: "第 2 次点击：收起",
        then: [gone("详情卸载", sel.callDetail(sessionCallId(0))),
          attr("收起态标记为 false", sel.callToggle(sessionCallId(0)), "aria-expanded", "false"),
          visible("入口还在", sel.call(sessionCallId(0)))] },
      { kind: "click", selector: sel.callToggle(sessionCallId(0)), label: "第 3 次点击：再展开",
        then: [visible("详情又挂载了（不是只响应首两次）", sel.callDetail(sessionCallId(0))),
          count("同一身份仍是一行", ".activity-panel-list .activity-item", 1)] },
      { kind: "click", selector: sel.callToggle(sessionCallId(0)), label: "第 4 次点击：收起（偶数次）",
        then: [gone("停在关闭态", sel.callDetail(sessionCallId(0))),
          visible("行本身没被开合点掉", sel.call(sessionCallId(0))),
          attr("标记与视觉一致", sel.callToggle(sessionCallId(0)), "aria-expanded", "false"),
          noDuplicateRows] }
    ]
  }),

  make({
    id: "F18", title: "小窗口与高 DPI", host: "SESSION",
    stateKind: "边界", component: sessionComponent,
    conditions: { viewport: "phone", devicePixelRatio: 2 },
    note: "小窗高倍屏最容易暴露「图标挤掉文字」与「数字掉到第二行」；这一条把两行超长内容与草稿同时压上。",
    steps: frame("手机宽度 + 2 倍像素比：两行调用 + 一段草稿", {
      ...liveWorld(readCall(0, LONG_PATH),
        sessionCall(1, { toolName: "run_check", args: { check_id: LONG_CHECK_ID } })),
      preview: livePreview({ previewAvailable: true, previewRevision: "3",
        previewText: draftOf(MARKDOWN_RICH, 0.5) })
    }),
    checks: [
      count("两行仍在同一列表里", ".activity-panel-list .activity-item", 2),
      visible("长路径那行的行首图标在场", `${sel.call(sessionCallId(0))} .activity-item-status`),
      visible("长命令那行的动作词在场", `${sel.call(sessionCallId(1))} .activity-item-verb`),
      visible("草稿块与过程面板共存", sel.replyDraft()),
      leftEdgeAligned, noDuplicateRows
    ]
  }),

  make({
    id: "F19", title: "reduced-motion", host: "SESSION",
    stateKind: "呈现", component: sessionComponent, conditions: { motion: "off" },
    note: "动效开关只关视觉，不关信息：状态词、在途标记、耗时缺位这些口径必须原样成立。",
    steps: frame("一条在途请求（本来会转）", liveWorld(sessionCall(0, {
      toolName: "read_file", args: { relative_path: PATH }, status: "REQUESTED" }))),
    checks: [
      motionCount("关闭动效后没有任何受控动画在跑", 0),
      text("状态词照常说尚未结算", sel.call(sessionCallId(0)), "已请求，尚未结算"),
      attr("视觉档仍是在途", sel.call(sessionCallId(0)), "data-tone", "active"),
      attr("这一行仍标着此刻在做", sel.call(sessionCallId(0)), "data-current", "true"),
      count("没结算仍不报耗时", `${sel.call(sessionCallId(0))} .activity-item-elapsed`, 0),
      visible("顶栏与行仍共用同一套骨架", sel.traceActivity())
    ]
  }),

  make({
    id: "F20", title: "深色/浅色主题", host: "SESSION",
    stateKind: "呈现", component: sessionComponent, conditions: { theme: "dark" },
    note: "这一条（与 F19）只证明同一份事实在暗底上结构一个不少；对比度与色值是像素判断，" +
      "由截图批次体现，不在 DOM 断言里冒充测过。",
    steps: frame("暗色：终态正文 + 两条已结算调用", {
      ...closedWorld(readCall(0, PATH),
        sessionCall(1, { toolName: "list_directory", args: { path: "apps/workbench/src" } })),
      messages: [userMessage("把这一轮的过程说清楚"),
        assistantMessage({ status: "COMPLETED", content: MARKDOWN_RICH })]
    }),
    checks: [
      attr("控制器把暗色施加在预览宿主上", sel.previewRoot(), "data-theme", "dark"),
      visible("正文块在场", sel.replyFinal()),
      visible("Markdown 结构完整", sel.markdown()),
      text("表格段落仍在同一块里", sel.markdown(), "typecheck"),
      visible("过程入口在场", sel.traceToggle()),
      noDuplicateRows
    ]
  }),

  
  make({
    id: "F06", title: "多文件变更摘要", host: "RUN_SUMMARY",
    stateKind: "边界", component: runSummaryComponent,
    note: "长任务的逐文件记录会几十条起步。超过 10 条时限高滚动，而不是把消息列撑成几屏长；" +
      "「14 行都在 DOM 里」与「一次看得见一截」是两件事，前者这里断言，后者由截图批次体现。",
    steps: frame("一次写入改动 14 个文件", {
      run: labRun(),
      runToolCalls: runProjection([[runCall(0, { toolName: "apply_changeset",
        args: { changes: Array.from({ length: 14 }, (_, index) => ({
          path: `src/dev/module-${index}/order.ts`, action: "MODIFY" })) },
        fileChanges: Array.from({ length: 14 }, (_, index) =>
          fileChange(`src/dev/module-${index}/order.ts`, "MODIFY", { added: 12, removed: 3 })) })]]),
      frozenDiff: frozenDiff("src/dev/module-0/order.ts", "export const limit = 10;\n",
        "export const limit = 40;\n"),
      changeSets: changeSets("mock-op-1", "src/dev/module-0/order.ts")
    }),
    checks: [
      visible("超过 10 条时给出限高说明", sel.diffCapped()),
      text("说明报出真实条数", sel.diffCapped(), "共 14 条编辑记录"),
      attr("列表自己进入可聚焦的滚动容器", sel.diffList(), "tabindex", "0"),
      attr("列表标记自己是限高态", sel.diffList(), "data-capped", "true"),
      count("14 行都在（滚动不是裁剪）", ".local-file-diff", 14),
      text("每行都是已修改", sel.diffRow(ledgerKey(0, runCallId(0), "src/dev/module-13/order.ts")), "已修改"),
      text("数字逐行来自账本", sel.diffRow(ledgerKey(0, runCallId(0), "src/dev/module-13/order.ts")), "+12"),
      noDuplicateRows
    ],
    interactions: [{
      kind: "click", selector: sel.diffToggle(ledgerKey(0, runCallId(0), "src/dev/module-0/order.ts")),
      label: "展开第一条的前后文本",
      then: [visible("正文区挂载", sel.diffBody(ledgerKey(0, runCallId(0), "src/dev/module-0/order.ts"))),
        visible("冻结差异面板在场", sel.frozenDiff()),
        count("展开一条不会把列表变成 15 行", ".local-file-diff", 14),
        noDuplicateRows] }
    ]
  })
];
