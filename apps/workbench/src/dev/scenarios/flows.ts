import type { RelayRunToolCall, RelaySessionToolCall } from "../../api/dtos/assist";
import {
  MARKDOWN_RICH, approvalReview, assistantMessage, changeSets, commandResult, draftOf, fileChange,
  frozenDiff, labRun, livePreview, modelCallOf, readCall, runCall, runPreview, runPreviewFile,
  runProjection, sessionCall, sessionTrace, pair
} from "../scenarioFixtures";
import type { ScenarioWorld } from "../scenarioWorld";
import {
  attr, at, count, gone, inspect, ledgerKey, make, notText, previewKey, runCallId,
  RUN_ROW, sel, sessionCallId, linkedComponent, runPanelComponent, runSummaryComponent,
  sessionComponent, text, toggleDiffRow, visible
} from "./common";

/**
 * G 组 · 组合流程（6 条可播放序列）。
 *
 * 矩阵里每一行问的是**一个状态**；这一组问的是**一条链**：状态之间怎么过渡，过渡的中间帧
 * 界面上写什么。因此六条都是多帧场景，帧的时刻由场景给定，不含任何随机网络延迟——
 * 同一份场景播放第 37 次与第 1 次逐帧一致，暂停、单步、重置都落在同一批读数上。
 *
 * 三条口径：
 *   * 静态 `checks` 只在**最后一帧**跑；中途才成立的事实全部写成 `advance` 交互，
 *     这样「过渡」是被一步步验出来的，不是靠最后一帧反推。
 *   * 会话侧与 Run 侧同时在场时（LINK 宿主），两份账本各自推进：会话侧只有请求与结算，
 *     结果正文与逐文件账本只在 Run 侧。任何一步都不许两侧互相补数。
 *   * 审批与「批准」只推进模拟状态：走的是真实读取（`getRunReviews`），不提交业务审批，
 *     也不生成执行凭证。
 */

const FILE = "src/lib/order.ts";
const READS = [
  "apps/workbench/src/lib/order.ts",
  "apps/workbench/src/components/ExecutionTrajectorySummary.tsx",
  "pnpm-workspace.yaml"
];

/** 一问一答的世界补丁：只换助手消息的状态，消息身份保持不变。 */
const qa = (assistantPatch: Parameters<typeof pair>[0] = {}): Partial<ScenarioWorld> =>
  ({ messages: pair(assistantPatch) });

/** Run 侧一条已结算读取：带 `result_ref`，因此既能进计数也能进「本次读取结果」。 */
const runRead = (index: number, path: string): RelayRunToolCall =>
  runCall(index, {
    toolName: "read_file", args: { relative_path: path },
    resultRef: { content: `// 模拟回执：${path} 的前三行` }
  });

/** 会话侧同一条读取：这个账本没有结果正文那一列，因此只给状态与参数。 */
const sessionRead = (index: number, path: string,
  patchValue: Partial<RelaySessionToolCall> = {}): RelaySessionToolCall =>
  readCall(index, path, patchValue);

/** 某一轮的已结算读取（长任务流程用）：身份按轮次错开，跨轮不撞 `call.id`。 */
function roundReads(round: number, countValue: number, unsettledFrom: number | null):
  RelayRunToolCall[] {
  return Array.from({ length: countValue }, (_, index) =>
    runCall(round * 10 + index, {
      round, toolName: "read_file",
      args: { relative_path: `src/dev/scenarios/long-${round}-${index}.ts` },
      status: unsettledFrom !== null && index >= unsettledFrom ? "REQUESTED" : "SETTLED",
      resultRef: unsettledFrom !== null && index >= unsettledFrom ? null
        : { content: `// 第 ${round} 轮第 ${index} 项读取的回执` }
    }));
}

/** 会话账本的世界补丁：按轮次给出，身份始终是那条助手消息。 */
const sessionLedger = (rounds: readonly (readonly RelaySessionToolCall[])[]): Partial<ScenarioWorld> =>
  ({ traces: { [MARK_ASSISTANT]: sessionTrace(rounds) } });

/** 助手消息身份：`pair` 与 `assistantMessage` 默认都用它。 */
const MARK_ASSISTANT = assistantMessage().id;

export const FLOWS = [
  make({
    id: "G01", title: "正常开发任务（读 → 改 → 验证 → 回复）", host: "LINK",
    stateKind: "工具", component: linkedComponent,
    note: "六帧走完一次真实协作：先读三处，再改一个文件，跑一次检查，最后落正文。"
      + "中途的口径每一帧都单独钉：在途不计入写入次数、预览行随结算换成账本行、"
      + "终态撤掉在途指示。",
    steps: [
      at(0, "提交：还没有任何工具调用", {
        ...qa({ status: "RUNNING", content: null }),
        ...sessionLedger([[]]),
        run: labRun(), runToolCalls: runProjection([[]])
      }),
      at(1_400, "第 1 项读取结算", {
        ...qa({ status: "RUNNING", content: null }),
        ...sessionLedger([[sessionRead(0, READS[0])]]),
        run: labRun(), runToolCalls: runProjection([[runRead(0, READS[0])]])
      }),
      at(2_800, "第 2 项结算，第 3 项刚请求出去", {
        ...qa({ status: "RUNNING", content: null }),
        ...sessionLedger([[sessionRead(0, READS[0]), sessionRead(1, READS[1]),
          sessionRead(2, READS[2], { status: "REQUESTED", settledAt: null })]]),
        run: labRun(),
        runToolCalls: runProjection([[runRead(0, READS[0]), runRead(1, READS[1]),
          runCall(2, { toolName: "read_file", args: { relative_path: READS[2] }, status: "REQUESTED" })]])
      }),
      at(4_200, "三处读完，写入参数还在流式生成（临时预览）", {
        ...sessionLedger([[sessionRead(0, READS[0]), sessionRead(1, READS[1]), sessionRead(2, READS[2]),
          sessionCall(3, { toolName: "apply_changeset",
            args: { changes: [{ path: FILE, action: "MODIFY" }] }, status: "REQUESTED" })]]),
        runToolCalls: runProjection([[runRead(0, READS[0]), runRead(1, READS[1]), runRead(2, READS[2]),
          runCall(3, { toolName: "apply_changeset",
            args: { changes: [{ path: FILE, action: "MODIFY" }] }, status: "REQUESTED" })]]),
        runPreviews: [runPreview(modelCallOf(0), 3, [runPreviewFile({ path: FILE, added: 41, removed: 8 })])]
      }),
      at(5_600, "写入结算：预览行换成落账行，临时预览清空", {
        ...sessionLedger([[sessionRead(0, READS[0]), sessionRead(1, READS[1]), sessionRead(2, READS[2]),
          sessionCall(3, { toolName: "apply_changeset",
            args: { changes: [{ path: FILE, action: "MODIFY" }] } })]]),
        runToolCalls: runProjection([[runRead(0, READS[0]), runRead(1, READS[1]), runRead(2, READS[2]),
          runCall(3, { toolName: "apply_changeset",
            args: { changes: [{ path: FILE, action: "MODIFY" }] },
            resultRef: commandResult("已写入 1 个文件", 0),
            fileChanges: [fileChange(FILE, "MODIFY", { added: 41, removed: 8 })] })]]),
        runPreviews: [],
        frozenDiff: frozenDiff(FILE, "export const limit = 10;\n", "export const limit = 40;\n"),
        changeSets: changeSets("mock-op-4", FILE, "APPLIED")
      }),
      at(7_000, "检查结算，正文落定", {
        ...qa({ status: "COMPLETED", content: "改完了：把上限从 10 提到 40，测试 42 项全过。" }),
        ...sessionLedger([[sessionRead(0, READS[0]), sessionRead(1, READS[1]), sessionRead(2, READS[2]),
          sessionCall(3, { toolName: "apply_changeset",
            args: { changes: [{ path: FILE, action: "MODIFY" }] } }),
          sessionCall(4, { toolName: "run_check", args: { check_id: "test" } })]]),
        runToolCalls: runProjection([[runRead(0, READS[0]), runRead(1, READS[1]), runRead(2, READS[2]),
          runCall(3, { toolName: "apply_changeset",
            args: { changes: [{ path: FILE, action: "MODIFY" }] },
            resultRef: commandResult("已写入 1 个文件", 0),
            fileChanges: [fileChange(FILE, "MODIFY", { added: 41, removed: 8 })] }),
          runCall(4, { toolName: "run_check", args: { check_id: "test" },
            resultRef: commandResult("Test Suites: 1 passed\nTests: 42 passed", 0) })]]),
        run: labRun({ status: "COMPLETED" })
      })
    ],
    checks: [
      visible("最终正文在场", sel.replyFinal()),
      text("正文逐字呈现", sel.replyFinal(), "上限从 10 提到 40"),
      gone("终态撤掉在途三点", sel.inflight()),
      visible("执行过程入口不随终态消失", sel.trace()),
      text("统计里三处读取各算一次", sel.summary(), "读取/检索 3 次"),
      text("写入按调用算一次", sel.summary(), "写入 1 次"),
      text("检查按回执算一次", sel.summary(), "检查 1 次"),
      count("没有未决项就不画进行中标签", ".execution-count", 3),
      count("局部文件行只剩落账那一条", ".local-file-diff", 1),
      text("落账行说已修改", sel.diffRow(ledgerKey(0, runCallId(3), FILE)), "已修改"),
      count("命令类活动行只有检查那一条", sel.summaryRows(), 1),
      notText("统计里没有失败或未执行", sel.summary(), "失败或未执行"),
      notText("界面不把退出码 0 说成验证通过", sel.summary(), "验证通过")
    ],
    interactions: [
      { kind: "advance", label: "推进到第 1 项读取结算",
        then: [visible("会话侧出现这一行", sel.call(sessionCallId(0))),
          text("标题按已结算与在途两档说", sel.traceActivity(), "已结算 1 项 · 正在执行"),
          text("Run 侧计数同步", sel.summary(), "读取/检索 1 次")] },
      { kind: "advance", label: "推进到第 3 项刚请求出去",
        then: [visible("未结算那一行也在场", sel.call(sessionCallId(2))),
          text("会话侧说尚未结算", sel.call(sessionCallId(2)), "已请求，尚未结算"),
          text("在途不进读取次数", sel.summary(), "1 项进行中或结果未决")] },
      { kind: "advance", label: "推进到写入参数还在生成",
        then: [visible("预览行在场", sel.diffRow(previewKey(0, modelCallOf(0), 3, FILE))),
          text("预览行说正在生成", sel.diffRow(previewKey(0, modelCallOf(0), 3, FILE)), "正在生成"),
          attr("来源标成预览", sel.diffRow(previewKey(0, modelCallOf(0), 3, FILE)), "data-preview", "true"),
          notText("预览不写已修改", sel.diffRow(previewKey(0, modelCallOf(0), 3, FILE)), "已修改"),
          notText("写入未结算就不计写入次数", sel.summary(), "写入 1 次")] },
      { kind: "advance", label: "推进到写入结算",
        then: [gone("预览行随结算退场", sel.diffRow(previewKey(0, modelCallOf(0), 3, FILE))),
          visible("同一文件换成落账行", sel.diffRow(ledgerKey(0, runCallId(3), FILE))),
          text("落账行说已修改", sel.diffRow(ledgerKey(0, runCallId(3), FILE)), "已修改"),
          text("行数逐字来自账本", sel.diffRow(ledgerKey(0, runCallId(3), FILE)), "+41"),
          count("仍然只有一条局部行", ".local-file-diff", 1)] },
      { kind: "advance", label: "推进到检查结算与正文落定",
        then: [visible("检查行出现在摘要里", sel.summaryActivity(runCallId(4))),
          text("检查状态词是已结算", sel.summaryActivity(runCallId(4)), "已结算"),
          text("统计给出检查次数", sel.summary(), "检查 1 次"),
          gone("正文落定后不再有在途指示", sel.inflight())] },
      ...toggleDiffRow(ledgerKey(0, runCallId(3), FILE))
    ]
  }),

  make({
    id: "G02", title: "命令失败并如实停在失败", host: "LINK",
    stateKind: "失败", component: linkedComponent,
    note: "四帧：请求命令 → 回执退出码 1 → Run 因反复失败停下 → 正文只说停在哪儿。"
      + "这一条钉的是**失败不会被后面的话盖绿**：退出码非零既进检查次数也进失败计数，"
      + "Run 等待原因单独成句，界面上不出现「通过」。",
    steps: [
      at(0, "命令请求已发出", {
        ...qa({ status: "RUNNING", content: null }),
        ...sessionLedger([[sessionCall(0, { toolName: "run_check", args: { check_id: "test" },
          status: "REQUESTED" })]]),
        run: labRun(),
        runToolCalls: runProjection([[runCall(0, { toolName: "run_check", args: { check_id: "test" },
          status: "REQUESTED" })]])
      }),
      at(2_000, "回执：退出码 1，三条用例没过", {
        ...sessionLedger([[sessionCall(0, { toolName: "run_check", args: { check_id: "test" } })]]),
        runToolCalls: runProjection([[runCall(0, { toolName: "run_check", args: { check_id: "test" },
          resultRef: commandResult("FAIL src/lib/order.ts\nTests: 3 failed, 39 passed", 1,
            { outcome: "FAILED" }) })]])
      }),
      at(3_600, "再跑一次仍失败，Run 停下等人工决定", {
        ...sessionLedger([[sessionCall(0, { toolName: "run_check", args: { check_id: "test" } }),
          sessionCall(1, { toolName: "run_check", args: { check_id: "test" } })]]),
        runToolCalls: runProjection([[runCall(0, { toolName: "run_check", args: { check_id: "test" },
          resultRef: commandResult("FAIL src/lib/order.ts\nTests: 3 failed, 39 passed", 1,
            { outcome: "FAILED" }) }),
          runCall(1, { toolName: "run_check", args: { check_id: "test" },
            resultRef: commandResult("FAIL src/lib/order.ts\nTests: 3 failed, 39 passed", 1,
              { outcome: "FAILED" }) })]], { runStatus: "WAITING", waitReason: "REPEATED_FAILURE" }),
        run: labRun({ status: "WAITING", waitReason: "REPEATED_FAILURE" })
      }),
      at(5_000, "正文说明停在哪里", {
        ...qa({ status: "COMPLETED", content: "测试没过：order.ts 三条用例失败，我停在这里等你决定。" })
      })
    ],
    checks: [
      visible("最终正文在场", sel.replyFinal()),
      text("正文直说没通过", sel.replyFinal(), "测试没过"),
      count("两次检查各成一行", sel.summaryRows(), 2),
      text("检查次数按实际跑过报", sel.summary(), "检查 2 次"),
      text("失败单独成标签", sel.summary(), "2 项失败或未执行"),
      text("等待原因逐字翻译", sel.summary(), "反复失败已停下，需要你决定"),
      attr("失败活动行带失败档", sel.summaryActivity(runCallId(0)), "data-failed", "true"),
      notText("失败不被说成通过", sel.summary(), "通过"),
      notText("也没有验证通过字样", sel.summary(), "验证通过"),
      gone("终态撤掉在途三点", sel.inflight())
    ],
    interactions: [
      // 第 0 帧（命令刚请求出去）不是「推进之后」才出现，它是重放的起点：
      // 中途才成立的事实要用 inspect 就地钉，推进一次就错过了。
      inspect("起点：命令刚请求出去",
        text("在途不计入检查次数", sel.summary(), "1 项进行中或结果未决"),
        notText("没回执就不报失败", sel.summary(), "1 项失败或未执行"),
        count("摘要里这一条已经成行", sel.summaryRows(), 1)),
      { kind: "advance", label: "推进到失败回执落账",
        then: [text("检查次数成立", sel.summary(), "检查 1 次"),
          text("失败计数同时成立", sel.summary(), "1 项失败或未执行"),
          text("活动行状态词是已结算但失败", sel.summaryActivity(runCallId(0)), "已结算但失败")] },
      { kind: "advance", label: "推进到 Run 停下等决定",
        then: [text("两次都算失败", sel.summary(), "2 项失败或未执行"),
          count("两行都标成失败", sel.summaryFailedRows(), 2)] },
      { kind: "click", selector: sel.summaryActivityToggle(runCallId(0)),
        label: "展开这次检查看原样回执",
        then: [visible("回执正文可读", sel.detailResult(runCallId(0))),
          text("正文里是确切的失败计数", sel.detailResult(runCallId(0)), "3 failed"),
          text("退出码一并给出", sel.detailMeta(runCallId(0)), "退出码 1")] }
    ]
  }),

  make({
    id: "G03", title: "审批等待与批准", host: "RUN_SUMMARY",
    stateKind: "审批", component: runSummaryComponent,
    note: "写入从「参数生成」到「等你批准」再到「落盘」，中间那一档必须一眼看得出轮到用户动手："
      + "状态词是待应用、统计单列等待你批准、并给出通往原审批页的链接。"
      + "这里的批准只推进模拟状态，不提交真实 ACTION_APPROVAL。",
    steps: [
      at(0, "写入参数还在生成", {
        run: labRun(),
        runToolCalls: runProjection([[runCall(0, { toolName: "apply_changeset",
          args: { changes: [{ path: FILE, action: "MODIFY" }] }, status: "REQUESTED" })]])
      }),
      at(1_600, "冻结完成，等待你批准", {
        runToolCalls: runProjection([[runCall(0, { toolName: "apply_changeset",
          args: { changes: [{ path: FILE, action: "MODIFY" }] }, status: "WAITING_APPROVAL" })]],
        { runStatus: "WAITING", waitReason: "HUMAN_TOOL" }),
        run: labRun({ status: "WAITING", waitReason: "HUMAN_TOOL" }),
        runPreviews: [runPreview(modelCallOf(0), 0, [runPreviewFile({ path: FILE, added: 12, removed: 3 })])],
        reviews: [approvalReview("mock-op-1")]
      }),
      at(3_400, "批准之后落盘", {
        runToolCalls: runProjection([[runCall(0, { toolName: "apply_changeset",
          args: { changes: [{ path: FILE, action: "MODIFY" }] },
          resultRef: commandResult("已写入 1 个文件", 0),
          fileChanges: [fileChange(FILE, "MODIFY", { added: 12, removed: 3 })] })]])
          ,
        run: labRun(),
        runPreviews: [],
        reviews: [approvalReview("mock-op-1", { status: "DECIDED", target: { decision: "APPROVE" } })],
        frozenDiff: frozenDiff(FILE, "export const limit = 10;\n", "export const limit = 40;\n"),
        changeSets: changeSets("mock-op-1", FILE, "APPLIED")
      })
    ],
    checks: [
      count("批准后才有一条落账行", ".local-file-diff", 1),
      text("这一行说已修改", sel.diffRow(ledgerKey(0, runCallId(0), FILE)), "已修改"),
      text("行数逐字来自账本", sel.diffRow(ledgerKey(0, runCallId(0), FILE)), "+12"),
      text("写入次数只在结算后出现", sel.summary(), "写入 1 次"),
      count("没有等待项就不再挂审批入口", sel.summaryWaitingApproval(), 0),
      notText("落盘后不说待应用", sel.summary(), "等待你批准"),
      visible("展开入口在场", sel.diffToggle(ledgerKey(0, runCallId(0), FILE)))
    ],
    interactions: [
      // 起点是「参数还在生成」那一帧：意图行按调用身份成行、没有数字，也没有前后文本入口
      // （LocalDiffBody 在 generating 档直接返回 null）。
      inspect("起点：写入参数还在生成",
        visible("意图行先在场", sel.diffRow(ledgerKey(0, runCallId(0), FILE))),
        text("状态词是正在生成", sel.diffRow(ledgerKey(0, runCallId(0), FILE)), "正在生成"),
        count("没有数字就不画加数",
          `${sel.diffRow(ledgerKey(0, runCallId(0), FILE))} [data-metric="added"]`, 0),
        gone("生成中不给前后文本入口", sel.diffToggle(ledgerKey(0, runCallId(0), FILE)))),
      { kind: "advance", label: "推进到等待批准",
        then: [visible("预览行换成本地行", sel.diffRow(previewKey(0, modelCallOf(0), 0, FILE))),
          text("状态词是待应用", sel.diffRow(previewKey(0, modelCallOf(0), 0, FILE)), "待应用"),
          attr("相位是 waitingApproval", sel.diffRow(previewKey(0, modelCallOf(0), 0, FILE)),
            "data-phase", "waitingApproval"),
          text("统计单列等待你批准", sel.summary(), "1 项等待你批准"),
          visible("给出通往原审批页的链接", sel.summaryWaitingLink()),
          notText("待批准不写已修改", sel.diffRow(previewKey(0, modelCallOf(0), 0, FILE)), "已修改")] },
      { kind: "advance", label: "推进到批准并落盘",
        then: [gone("待批准的预览行退场", sel.diffRow(previewKey(0, modelCallOf(0), 0, FILE))),
          visible("落账行接管同一个文件", sel.diffRow(ledgerKey(0, runCallId(0), FILE))),
          count("审批入口随等待结束收起", sel.summaryWaitingApproval(), 0)] },
      ...toggleDiffRow(ledgerKey(0, runCallId(0), FILE))
    ]
  }),

  make({
    id: "G04", title: "网络中断与恢复", host: "SESSION",
    stateKind: "恢复", component: sessionComponent,
    note: "草稿读不到时界面要说「读不到」，而不是把已经显示的那一屏悄悄抹掉；恢复之后草稿回到原位，"
      + "正文仍以消息为准。这一条的关键是**没有编造**：失败期间不出现正文块，恢复也不补中间帧。",
    steps: [
      at(0, "草稿正常推进（v3，40%）", {
        ...qa({ status: "RUNNING", content: null }),
        preview: livePreview({ previewAvailable: true, previewRevision: "3",
          previewText: draftOf(MARKDOWN_RICH, 0.4) })
      }),
      at(1_400, "预览读取连续失败", {
        previewError: { message: "模拟：预览读取中断，最后一次成功已有草稿。",
          lastSuccessAt: "2026-10-30T09:02:00.000Z" }
      }),
      at(3_200, "恢复：草稿回到原位并继续增长（v8，75%）", {
        previewError: null,
        preview: livePreview({ previewAvailable: true, previewRevision: "8",
          previewText: draftOf(MARKDOWN_RICH, 0.75) })
      }),
      at(4_800, "正文读回，同一位置落定", {
        ...qa({ status: "COMPLETED", content: MARKDOWN_RICH }), preview: null, handover: false
      })
    ],
    checks: [
      visible("最终正文在场", sel.replyFinal()),
      text("正文逐字来自服务端", sel.replyFinal(), "结论"),
      gone("恢复后错误块撤掉", sel.previewError()),
      gone("终态没有草稿块", sel.replyDraft()),
      gone("终态撤掉在途三点", sel.inflight()),
      visible("执行过程入口仍在", sel.trace())
    ],
    interactions: [
      { kind: "advance", label: "推进到中断那一帧",
        then: [visible("失败说明在场", sel.previewError()),
          text("原因逐字透出", sel.previewError(), "预览读取中断"),
          // 只断言「给出了最近一次成功读取」这一事实：时刻按查看者所在时区渲染，
          // 把某台机器上的钟点写进断言会变成环境依赖。
          text("给出上次成功读取的时刻", sel.previewError(), "最近成功读取"),
          visible("已显示的那一屏不被抹掉", sel.replyDraft()),
          gone("失败期间不编出正文块", sel.replyFinal())] },
      { kind: "advance", label: "推进到恢复那一帧",
        then: [gone("错误块随成功读取撤掉", sel.previewError()),
          attr("草稿修订号继续往上走", sel.replyBlock(), "data-state", "draft"),
          text("修订号如实报出", sel.replyNote(), "v8")] },
      { kind: "advance", label: "推进到正文落定",
        then: [visible("正文块在场", sel.replyFinal()), gone("草稿块让位给正文", sel.replyDraft())] }
    ]
  }),

  make({
    id: "G05", title: "长任务（多轮、逐项落账）", host: "RUN_TRAJECTORY",
    stateKind: "工具", component: runPanelComponent,
    note: "同一份账本一轮一轮长起来：每一帧的行数、计数与轮次分组都要对得上，"
      + "重放不能把一次调用说成两次。终态那一帧额外钉「没有未结算行」，"
      + "因为 Run 已结束却还有未决调用是真实的脏状态。",
    steps: [
      at(0, "第 0 轮三项读完", {
        run: labRun(), runToolCalls: runProjection([roundReads(0, 3, null)])
      }),
      at(2_400, "第 1 轮开始：四项里两项已结算", {
        runToolCalls: runProjection([roundReads(0, 3, null), roundReads(1, 4, 2)])
      }),
      at(4_800, "第 1 轮收尾，第 2 轮五项全部结算", {
        runToolCalls: runProjection([roundReads(0, 3, null), roundReads(1, 4, null),
          roundReads(2, 5, null)])
      }),
      at(6_600, "Run 进入终态", {
        run: labRun({ status: "COMPLETED" }),
        runToolCalls: runProjection([roundReads(0, 3, null), roundReads(1, 4, null),
          roundReads(2, 5, null)], { runStatus: "COMPLETED" })
      })
    ],
    checks: [
      count("三轮各一个分组容器", ".trajectory-round", 3),
      count("卡片总数＝3+4+5", RUN_ROW, 12),
      text("计数按真实结算数报", sel.runCounts(), "已结算 12"),
      text("没有未决行就不虚报", sel.runCounts(), "正在执行或结果未决 0"),
      count("终态下没有未结算警告", "[data-testid^=\"trajectory-unsettled-at-terminal-\"]", 0),
      visible("证据注记在场", sel.runEvidenceNote()),
      count("会话侧不在这块出现", ".activity-item", 0)
    ],
    interactions: [
      { kind: "advance", label: "推进到第 1 轮进行中",
        then: [count("两个轮次分组", ".trajectory-round", 2),
          count("卡片随账本增长", RUN_ROW, 7),
          text("未结算的两项单列", sel.runCounts(), "正在执行或结果未决 2"),
          count("未结算警告此时还不该出现（Run 未终态）",
            "[data-testid^=\"trajectory-unsettled-at-terminal-\"]", 0)] },
      { kind: "advance", label: "推进到第 1 轮收尾并进入第 2 轮",
        then: [count("三轮分组", ".trajectory-round", 3), count("卡片十二张", RUN_ROW, 12),
          text("计数换成十二项已结算", sel.runCounts(), "已结算 12")] },
      { kind: "advance", label: "推进到 Run 终态",
        then: [text("标题说明这是终态读数", sel.runSourceRun(), "此后不会再有新的工具结算")] },
      { kind: "click", selector: sel.runRefresh(), label: "刷新：重读同一份长账本",
        then: [count("分组仍是三轮", ".trajectory-round", 3), count("卡片仍是一张不多", RUN_ROW, 12)] }
    ]
  }),

  make({
    id: "G06", title: "纯文本回复（无工具、无空白交接帧）", host: "SESSION",
    stateKind: "流式", component: sessionComponent,
    note: "整条链没有任何工具调用，因此这一族要钉的是**过渡本身**：PENDING 说等待处理、"
      + "草稿逐帧增长且标注不是完整消息、交接那一帧草稿留在原位、落定后入口仍在并如实说没调用工具。"
      + "开局 IDLE（终态首次展开才读）不在这里断言：这一条的第 0 帧是在途，账本已经被读过，"
      + "IDLE 由单帧终态场景（A05 / D01 / E01 一族）负责。",
    steps: [
      at(0, "刚提交（PENDING）", qa({ status: "PENDING", content: null })),
      at(900, "开始流式输出（v1，20%）", {
        ...qa({ status: "RUNNING", content: null }),
        preview: livePreview({ previewAvailable: true, previewRevision: "1",
          previewText: draftOf(MARKDOWN_RICH, 0.2) })
      }),
      at(2_400, "草稿继续（v5，60%）", {
        preview: livePreview({ previewAvailable: true, previewRevision: "5",
          previewText: draftOf(MARKDOWN_RICH, 0.6) })
      }),
      at(3_800, "预览判终态、正文还没读回（SETTLING）", {
        ...qa({ status: "COMPLETED", content: null }),
        settling: { text: draftOf(MARKDOWN_RICH, 0.6), revision: "5", truncated: false,
          outcome: "COMPLETED", stage: "SETTLING" },
        handover: true
      }),
      at(5_000, "正文读回，同一位置落定", {
        ...qa({ status: "COMPLETED", content: MARKDOWN_RICH }),
        settling: null, handover: false, preview: null
      })
    ],
    checks: [
      visible("最终正文在场", sel.replyFinal()),
      gone("落定后没有草稿块", sel.replyDraft()),
      gone("终态撤掉在途三点", sel.inflight()),
      attr("落定后整块换成 final 档（data-verify 只在核对中挂上）", sel.replyBlock(), "data-state", "final"),
      // 草稿说明块在 final 档整块不渲染：这里能证明「不再自称核对中」的正是它不在场。
      gone("落定后草稿说明块撤掉", sel.replyNote()),
      visible("执行过程入口不消失", sel.trace()),
      visible("复制入口在场", sel.copy())
    ],
    interactions: [
      { kind: "advance", label: "推进到首帧草稿",
        then: [visible("草稿块在场", sel.replyDraft()),
          attr("呈现档是 draft", sel.replyBlock(), "data-state", "draft"),
          text("说明草稿不是完整消息", sel.replyNote(), "不是完整消息或已接受产物"),
          visible("在途三点在场", sel.inflight())] },
      { kind: "advance", label: "推进到草稿继续增长",
        then: [text("修订号如实换成 v5", sel.replyNote(), "v5"),
          count("同一轮只有一条消息行", ".agent-message[data-role=\"ASSISTANT\"]", 1)] },
      { kind: "advance", label: "推进到交接那一帧",
        then: [visible("核对中的回复块仍在同一位置", sel.replyVerify()),
          attr("核对档标为 settling", sel.replyBlock(), "data-verify", "settling"),
          text("说明仍是草稿", sel.replyNote(), "以下仍是草稿 · 正在核对最终正文"),
          gone("交接不留空白帧", sel.replyFinal())] },
      { kind: "advance", label: "推进到正文落定",
        then: [visible("正文块在场", sel.replyFinal()), gone("核对块让位给正文", sel.replyVerify())] },
      { kind: "click", selector: sel.traceToggle(), label: "展开执行过程（首次读取）",
        then: [attr("相位换成 EMPTY", sel.trace(), "data-phase", "EMPTY"),
          visible("空状态说明在场", sel.traceEmpty()),
          text("如实说本轮没有调用工具", sel.traceActivity(), "本轮没有调用工具"),
          visible("展开后入口仍在", sel.trace())] }
    ]
  })
];
