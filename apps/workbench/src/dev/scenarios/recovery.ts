import {
  at as stamp, approvalReview, changeSets, draftOf, fileChange, frozenDiff, labRun, livePreview,
  MARKDOWN_RICH, MOCK, modelCallOf, pair, readCall, runCall, runPreview, runPreviewFile, runProjection,
  sessionCall, sessionTrace
} from "../scenarioFixtures";
import type { ScenarioWorld } from "../scenarioWorld";
import {
  at, atLeast, attr, closedWorld, count, frame, gone, inspect, ledgerKey, liveWorld, make, noDuplicateRows,
  notText, openTrace, previewKey, RUN_ROW, runCallId, runPanelComponent, runSummaryComponent, sel,
  sessionCallId, sessionComponent, text, toggleDiffRow, toggleRunRow, visible
} from "./common";

/**
 * E 组 · 异常与恢复（17 条）。
 *
 * 这一组守的是**失败必须被说成失败**：
 *   * 读不到 ≠ 没有：过程读取失败显示原因与重读入口，绝不退化成「本轮没有调用工具」；
 *   * 终态零记录 ≠ 读失败：确认没有工具时才说「本轮没有调用工具」，入口仍然留在原地（历史 P0）；
 *   * 失败不盖绿标：截断、超时、取消、冲突各自原样透出，界面不补出「已通过」。
 *
 * 恢复一律走产品自己那两条路：终态首次展开读一次、失败后由「重新读取」显式回源。
 * 实验室不额外自动重试，因此「服务恢复了但界面还没重读」这件事也被如实钉住（E02）。
 */

const PATH = "apps/workbench/package.json";
const FILE = "src/lib/order.ts";

/** 会话侧读取失败的两种真实来处：HTTP 拒绝与传输丢失（错误类型与线上同构）。 */
const DB_DOWN = { kind: "http", status: 503, code: "DATABASE_UNAVAILABLE",
  detail: "数据库当前不可达。" } as const;
const LOST = { kind: "transport" } as const;
const NOT_FOUND = { kind: "http", status: 404, code: "RESOURCE_NOT_FOUND",
  detail: "模拟：这一轮的过程账本不存在（消息身份已被回收）。" } as const;

/** Run 侧一次写入的世界（E07/E12/E13 复用）：账本、预览与冻结正文各按参数给。 */
function writeWorld(call: ReturnType<typeof runCall>, extra: Partial<ScenarioWorld> = {}): Partial<ScenarioWorld> {
  return { run: labRun(), runToolCalls: runProjection([[call]]), ...extra };
}

export const RECOVERY = [
  make({
    id: "E01", title: "工具轨迹读取 404", host: "SESSION",
    stateKind: "失败", component: sessionComponent,
    note: "读取失败与本轮没有工具是两个不同的答案；混起来用户会以为模型什么都没做。",
    steps: frame("终态消息 + 过程账本返回 404",
      { ...closedWorld(readCall(0, PATH)), fail: { getAssistSessionToolCalls: NOT_FOUND } }),
    checks: [
      attr("未展开前仍是 IDLE（没读就不预判）", sel.trace(), "data-phase", "IDLE"),
      visible("入口对终态消息恒在", sel.traceToggle())
    ],
    interactions: [
      { kind: "click", selector: sel.traceToggle(), label: "展开执行过程（读失败）",
        then: [attr("相位换成 ERROR", sel.trace(), "data-phase", "ERROR"),
          text("标题只说过程读取失败", sel.traceActivity(), "过程读取失败"),
          visible("错误说明在场", sel.traceError()),
          text("404 走产品自己那句可操作说明", sel.traceError(), "要查看的内容不存在"),
          visible("给出重新读取入口", sel.traceRetry()),
          gone("没有把失败画成空状态", sel.traceEmpty()),
          count("读不到就不画任何工具行", ".activity-item", 0),
          visible("正文与消息状态不受影响", sel.replyFinal())] },
      { kind: "click", selector: sel.traceError(), label: "错误块里的说明不会自己消失",
        then: [visible("错误说明仍在", sel.traceError()),
          text("仍然说读不到而不是没有工具", sel.traceActivity(), "过程读取失败")] }
    ]
  }),

  make({
    id: "E14", title: "重试读取成功", host: "SESSION",
    stateKind: "恢复", component: sessionComponent,
    note: "终态账本只在首次展开时读一次；恢复不会自己发生，界面保留显式重读入口。",
    steps: [
      at(0, "过程读取失败（503）", { ...closedWorld(readCall(0, PATH)),
        fail: { getAssistSessionToolCalls: DB_DOWN } }),
      at(4_000, "服务恢复：同一条账本现在能读到", { ...closedWorld(readCall(0, PATH)), fail: {} })
    ],
    checks: [
      attr("开局仍是 IDLE", sel.trace(), "data-phase", "IDLE")
    ],
    interactions: [
      { kind: "click", selector: sel.traceToggle(), label: "展开：这一次读失败",
        then: [visible("错误说明在场", sel.traceError()),
          count("没有工具行可画", ".activity-item", 0)] },
      { kind: "advance", label: "推进到服务恢复的那一帧",
        then: [visible("界面没有自己修好：错误说明仍在原位", sel.traceError()),
          visible("重读入口仍然可用", sel.traceRetry())] },
      { kind: "click", selector: sel.traceRetry(), label: "点击重新读取",
        then: [gone("错误说明随成功读取移除", sel.traceError()),
          visible("已落账的调用行补回来了", sel.call(sessionCallId(0))),
          text("状态词是已结算", sel.call(sessionCallId(0)), "已结算"),
          attr("相位换成 SETTLED", sel.trace(), "data-phase", "SETTLED"),
          text("标题改报实际规模", sel.traceActivity(), "1 项操作 · 已结束")] }
    ]
  }),

  make({
    id: "E03", title: "网络请求超时", host: "SESSION",
    stateKind: "失败", component: sessionComponent,
    note: "这条同时记录一个真实问题：`describeLiveError` 的传输分支是面向「提交」的文案，"
      + "被只读的过程账本复用时会出现「本次提交是否生效尚未确定」这种与读取不相干的句子。",
    steps: frame("终态消息 + 过程账本没有拿到响应",
      { ...closedWorld(readCall(0, PATH)), fail: { getAssistSessionToolCalls: LOST } }),
    checks: [attr("开局 IDLE", sel.trace(), "data-phase", "IDLE")],
    interactions: [{
      kind: "click", selector: sel.traceToggle(), label: "展开执行过程（传输丢失）",
      then: [attr("相位是 ERROR", sel.trace(), "data-phase", "ERROR"),
        visible("错误说明在场", sel.traceError()),
        text("逐字使用线上同一套传输说明", sel.traceError(), "请求响应丢失或无法核对"),
        gone("没有把传输丢失说成没有工具", sel.traceEmpty()),
        count("没有读到就不画行", ".activity-item", 0)]
    }]
  }),

  make({
    id: "X27", title: "生成预览读取失败（草稿留在原位）", host: "SESSION",
    stateKind: "流式", component: sessionComponent,
    note: "预览是可丢弃的临时证据：读失败只撤掉预览这一块，在途与草稿形状都不改写消息状态。"
      + "这一族的错误块由世界给定（等价于产品自己的「上一次读取失败」状态），"
      + "所以点「重新读取」之后**世界没变就仍然显示**——只有下一次成功读数那一帧才撤掉。",
    steps: [
      at(0, "草稿已有 60%，预览读取失败", {
        messages: pair({ status: "RUNNING", content: null }),
        preview: livePreview({ previewAvailable: true, previewRevision: "5",
          previewText: draftOf(MARKDOWN_RICH, 0.6) }),
        previewError: { message: "模拟：预览响应在途中断", lastSuccessAt: stamp(20) }
      }),
      at(1_800, "重新读取成功：错误撤掉，草稿继续", {
        previewError: null,
        preview: livePreview({ previewAvailable: true, previewRevision: "6",
          previewText: draftOf(MARKDOWN_RICH, 0.72) })
      })
    ],
    checks: [
      gone("下一次成功读数后错误块撤掉", sel.previewError()),
      visible("草稿回到原位并继续", sel.replyDraft()),
      text("修订号如实换成下一次读数", sel.replyNote(), "v6"),
      text("草稿继续标注不是完整消息", sel.replyNote(), "不是完整消息或已接受产物"),
      visible("在途信号不受影响", sel.inflight()),
      gone("预览失败不等于正文到了", sel.replyFinal())
    ],
    interactions: [
      inspect("失败那一帧：说明在场且草稿没被抹掉",
        visible("预览失败说明在场", sel.previewError()),
        text("说明点名是预览读取失败", sel.previewError(), "生成预览读取失败"),
        text("给出最近一次成功读取的时刻", sel.previewError(), "最近成功读取"),
        visible("已拿到的草稿仍留在原位", sel.replyDraft()),
        gone("失败期间不出现正文块", sel.replyFinal())),
      { kind: "click", selector: sel.previewRetry(), label: "点击重新读取预览（世界未变化时不假装成功）",
        then: [visible("世界还是失败读数：说明仍在", sel.previewError()),
          visible("草稿块没有因为重读而整块移除", sel.replyDraft()),
          visible("重读入口点了不会消失", sel.previewRetry()),
          gone("按下重读不会直接编出正文", sel.replyFinal())] },
      { kind: "advance", label: "推进到重新读取成功那一帧",
        then: [gone("失败说明随成功读数撤掉", sel.previewError()),
          visible("草稿块仍在同一位置", sel.replyDraft()),
          noDuplicateRows] }
    ]
  }),

  make({
    id: "E10", title: "返回身份不匹配：整份丢弃", host: "RUN_TRAJECTORY",
    stateKind: "失败", component: runPanelComponent,
    steps: frame("投影自称属于另一个 Run", {
      ...writeWorld(runCall(0, { toolName: "read_file", args: { relative_path: PATH } })),
      fail: { getRunToolCalls: { kind: "mismatch" } }
    }),
    checks: [
      visible("给出读取失败说明", sel.runError()),
      text("点明两侧身份", sel.runError(), "与请求的 Run mock-run 不一致"),
      text("说明丢弃原因", sel.runError(), "不会按位置猜它属于哪次执行"),
      visible("同时说明本页不显示任何参数与输出", sel.runSourceUnavailable()),
      gone("身份不符时不画任何统计", sel.runCounts()),
      gone("也不画逐轮轨迹", sel.runRound(0)),
      notText("绝不把别人的清单算进来", sel.previewRoot(), "已结算 1")
    ]
  }),

  make({
    id: "E04", title: "SSE 中断", host: "RUN_TRAJECTORY",
    stateKind: "恢复", component: runPanelComponent,
    steps: frame("SSE 断开，轨迹改走轮询", {
      ...writeWorld(runCall(0, { toolName: "read_file", args: { relative_path: PATH } })),
      streamDown: true
    }),
    checks: [
      visible("降级说明在场", sel.runStreamNote()),
      text("说明事件流不可用", sel.runStreamNote(), "执行事件流当前不可用"),
      text("给出上次读取时间而不是假装实时", sel.runStreamNote(), "上次读取"),
      visible("统计照常可读", sel.runCounts()),
      text("已结算照常报出", sel.runCounts(), "已结算 1"),
      gone("没有错误就没有红色告警", sel.runError())
    ]
  }),

  make({
    id: "E09", title: "迟到的旧响应", host: "RUN_SUMMARY",
    stateKind: "终态", component: runSummaryComponent,
    note: "预览只在 Run 非终态时轮询；这一条同时验两道：hook 停轮询 + 已结算调用不再产生预览行。",
    steps: frame("Run 已 COMPLETED，账本 +41 −8，仍收到一份迟到预览", {
      run: labRun(),
      runToolCalls: runProjection([[runCall(0, { toolName: "apply_changeset",
        args: { changes: [{ path: FILE, action: "MODIFY" }] },
        fileChanges: [fileChange(FILE, "MODIFY", { added: 41, removed: 8 })] })]],
        { runStatus: "COMPLETED" }),
      runPreviews: [runPreview(modelCallOf(0), 0,
        [runPreviewFile({ path: FILE, added: 99, removed: 99 })])],
      frozenDiff: frozenDiff(FILE, "export const limit = 10;\n", "export const limit = 40;\n"),
      changeSets: changeSets("mock-op-1", FILE)
    }),
    checks: [
      count("只剩账本支持的那一行", ".local-file-diff", 1),
      gone("迟到预览没有生成第二行", sel.diffRow(previewKey(0, modelCallOf(0), 0, FILE))),
      text("状态词是已修改", sel.diffRow(ledgerKey(0, runCallId(0), FILE)), "已修改"),
      text("数字逐字来自账本而不是预览", sel.diffRow(ledgerKey(0, runCallId(0), FILE)), "+41"),
      notText("整块不再出现正在生成", sel.previewRoot(), "正在生成"),
      count("没有预览标签残留", ".local-file-diff-tag", 0)
    ],
    interactions: toggleDiffRow(ledgerKey(0, runCallId(0), FILE))
  }),

  
  make({
    id: "X28", title: "读到空轮次不抹掉已经见过的步骤", host: "SESSION", stateKind: "恢复",
    component: sessionComponent,
    note: "空响应可能只是落在两次写入之间：真实发生过的步骤不能因为后一次返回空就消失。",
    steps: [
      at(0, "两条已结算的调用", liveWorld(readCall(0, PATH),
        sessionCall(1, { toolName: "list_directory", args: { path: "apps/workbench/src" } }))),
      at(2_500, "轮询读到零条（服务端并发清理）",
        { ...liveWorld(), traces: { [MOCK.assistantMessageId]: sessionTrace([]) } })
    ],
    checks: [
      visible("第一次的读取行还在", sel.call(sessionCallId(0))),
      visible("第二次的列目录行还在", sel.call(sessionCallId(1))),
      count("两行仍然成两行", ".activity-panel-list .activity-item", 2),
      text("标题读数不因空响应归零", sel.traceActivity(), "已结算 2 项 · 正在执行"),
      atLeast("空响应没有抹掉步骤：入口与两行都还在原地", ".activity-item", 2)
    ]
  }),

  make({
    id: "E11", title: "空工具轨迹", host: "SESSION",
    stateKind: "终态", component: sessionComponent,
    note: "这是 V2 的 P0 回归：终态 + 读回零条时整块消失，用户点开就没反应。现在入口恒在并给空状态。",
    steps: frame("终态消息 + 服务端确认零轮次",
      { ...closedWorld(), fail: { getAssistSessionToolCalls: { kind: "empty" } } }),
    checks: [
      visible("入口恒在", sel.traceToggle()),
      attr("未读取前不预判", sel.trace(), "data-phase", "IDLE")
    ],
    interactions: openTrace(undefined, [
      attr("读回零条后相位是 EMPTY", sel.trace(), "data-phase", "EMPTY"),
      text("标题说本轮没有调用工具", sel.traceActivity(), "本轮没有调用工具"),
      visible("空状态说明在场", sel.traceEmpty()),
      gone("零记录不是读取失败", sel.traceError()),
      count("不制造假的工具行", ".activity-item", 0),
      visible("正文照常显示", sel.replyFinal())
    ])
  }),

  make({
    id: "X29", title: "Run 摘要读取失败：说读不到，不说没调用工具", host: "RUN_SUMMARY",
    stateKind: "失败", component: runSummaryComponent,
    steps: frame("摘要所在的工具投影返回 503", {
      ...writeWorld(runCall(0, { toolName: "read_file", args: { relative_path: PATH } })),
      fail: { getRunToolCalls: DB_DOWN }
    }),
    checks: [
      visible("摘要位置给出读取失败说明", sel.summaryError()),
      text("说明点明 Run 事实不受影响", sel.summaryError(), "Run 与成果事实不受影响"),
      gone("读不到时不画统计与编辑行", sel.summary()),
      gone("也不画局部增删行", sel.diffList()),
      notText("绝不退化成没有调用工具", sel.previewRoot(), "这次执行没有调用工具")
    ]
  }),

  make({
    id: "X30", title: "冻结正文读不到（失权）：不补造正文", host: "RUN_SUMMARY",
    stateKind: "失败", component: runSummaryComponent,
    steps: frame("账本 +41 −8 可读，冻结正文 403", {
      ...writeWorld(runCall(0, { toolName: "apply_changeset",
        args: { changes: [{ path: FILE, action: "MODIFY" }] },
        fileChanges: [fileChange(FILE, "MODIFY", { added: 41, removed: 8 })] })),
      frozenDiff: frozenDiff(FILE, "export const limit = 10;\n", "export const limit = 40;\n"),
      changeSets: changeSets("mock-op-1", FILE),
      fail: { getFileWriteFrozenDiff: { kind: "http", status: 403, code: "PERMISSION_DENIED",
        detail: "来源目录已不可访问。" } }
    }),
    checks: [
      text("编辑行照常是已修改", sel.diffRow(ledgerKey(0, runCallId(0), FILE)), "已修改"),
      text("账本数字不受正文读取影响", sel.diffRow(ledgerKey(0, runCallId(0), FILE)), "+41"),
      visible("展开入口仍在", sel.diffToggle(ledgerKey(0, runCallId(0), FILE)))
    ],
    interactions: [{
      kind: "click", selector: sel.diffToggle(ledgerKey(0, runCallId(0), FILE)),
      label: "展开前后正文（读取被拒）",
      then: [visible("正文区已挂载", sel.diffBody(ledgerKey(0, runCallId(0), FILE))),
        text("只说读不到", sel.diffBody(ledgerKey(0, runCallId(0), FILE)), "前后正文当前读不到"),
        gone("失权时不显示任何前后文本", sel.frozenDiff()),
        text("编辑行仍保留账本数字", sel.diffRow(ledgerKey(0, runCallId(0), FILE)), "+41")]
    }]
  }),

  make({
    id: "X31", title: "预览读取失败：保留上一次数字，不闪回零", host: "RUN_SUMMARY",
    stateKind: "在途", component: runSummaryComponent,
    note: "落账后由 fileChanges 的实际数字替换预览，因此这里的容错不影响事实，只影响观感。",
    steps: [
      at(0, "REQUESTED 写入 + 预览 +3 −1", writeWorld(
        runCall(0, { toolName: "apply_changeset",
          args: { changes: [{ path: FILE, action: "MODIFY" }] }, status: "REQUESTED" }),
        { runPreviews: [runPreview(modelCallOf(0), 0,
          [runPreviewFile({ path: FILE, added: 3, removed: 1 })])] })),
      at(3_000, "预览读取中断（传输失败）", writeWorld(
        runCall(0, { toolName: "apply_changeset",
          args: { changes: [{ path: FILE, action: "MODIFY" }] }, status: "REQUESTED" }),
        { runPreviews: [runPreview(modelCallOf(0), 0,
          [runPreviewFile({ path: FILE, added: 3, removed: 1 })])],
          fail: { getRunToolCallPreviews: LOST } }))
    ],
    checks: [
      visible("预览行仍在原位", sel.diffRow(previewKey(0, modelCallOf(0), 0, FILE))),
      text("加数保持上一次的读数", sel.diffRow(previewKey(0, modelCallOf(0), 0, FILE)), "+3"),
      attr("相位仍是 generating", sel.diffRow(previewKey(0, modelCallOf(0), 0, FILE)),
        "data-phase", "generating"),
      notText("中断不写成已修改", sel.diffRow(previewKey(0, modelCallOf(0), 0, FILE)), "已修改")
    ]
  }),

  
  
  
  make({
    id: "E07", title: "重复事件：同一身份只渲染一行", host: "RUN_TRAJECTORY",
    stateKind: "未知", component: runPanelComponent,
    note: "行身份就是调用 id：同 id 出现两次是一次请求被重放，不是两次调用；不一致时不替服务端挑一条。",
    steps: frame("一次读取里同时返回 SETTLED 与 REQUESTED 两份同身份记录", {
      run: labRun(),
      runToolCalls: runProjection([[
        runCall(0, { toolName: "read_file", args: { relative_path: PATH } }),
        runCall(0, { toolName: "read_file", args: { relative_path: PATH }, status: "REQUESTED",
          updatedAt: stamp(9) })
      ]])
    }),
    checks: [
      count("同身份只渲染一行", RUN_ROW, 1),
      visible("重放冲突说明在场", sel.runReplayConflict(runCallId(0))),
      text("说明不挑一条当作当前", sel.runReplayConflict(runCallId(0)), "无法确认哪一条是最新状态"),
      text("计数按去重后的一次算", sel.runCounts(), "已结算 1"),
      notText("重放不会被算成两次调用", sel.runCounts(), "正在执行或结果未决 1")
    ]
  }),

  /* ---------------- 矩阵补齐：E02 / E05 / E06 / E08 / E12 / E13 / E15 / E16 / E17 ---------------- */

  make({
    id: "E02", title: "工具轨迹读取 500", host: "RUN_TRAJECTORY", stateKind: "失败",
    component: runPanelComponent,
    note: "503 的 DATABASE_UNAVAILABLE 不逐字透出 detail：产品按**错误码**换成可操作说明"
      + "（`liveErrors.ts:75`），这里因此断言那一句说明而不是服务端原文。"
      + "读不到时整块轨迹撤下，但不许退化成「本次 Run 没有工具请求」。",
    steps: frame("轨迹读取返回 503", { run: labRun(), fail: { getRunToolCalls: DB_DOWN } }),
    checks: [
      visible("轨迹面板外壳在场", sel.runPanel()),
      visible("错误说明在场", sel.runError()),
      text("按错误码给出可操作说明", sel.runError(), "数据库不可达"),
      text("说明里带下一步", sel.runError(), "RELAY_DB_URL"),
      visible("来源不可用说明在场", sel.runSourceUnavailable()),
      text("说明这一屏不给任何参数与输出", sel.runSourceUnavailable(), "不显示任何调用参数或输出"),
      count("读不到就不画任何调用行", RUN_ROW, 0),
      gone("不把它写成「没有工具请求」", sel.runEmpty()),
      gone("没有上一次成功读数留下来冒充当前", sel.runCounts())
    ]
  }),

  make({
    id: "E05", title: "SSE 恢复", host: "RUN_TRAJECTORY", stateKind: "恢复",
    component: runPanelComponent,
    note: "事件流恢复后「实时」标记要回来、降级说明要走——但只在读数真的变了之后。"
      + "这一条把「恢复」和「界面自己假装恢复」区分开：恢复那一帧由场景推进给出。",
    steps: [
      at(0, "事件流不可用（降级中）", { run: labRun(), streamDown: true,
        runToolCalls: runProjection([[runCall(0, { toolName: "read_file",
          args: { relative_path: PATH } })]]) }),
      at(3_000, "事件流恢复", { run: labRun(), streamDown: false,
        runToolCalls: runProjection([[runCall(0, { toolName: "read_file",
          args: { relative_path: PATH } }), runCall(1, { toolName: "search_text",
          args: { query: "order" } })]]) })
    ],
    checks: [
      count("恢复后轨迹按最新读数给出两行", RUN_ROW, 2),
      gone("降级说明随事件流恢复撤下", sel.runStreamNote()),
      noDuplicateRows
    ],
    interactions: [
      { kind: "click", selector: sel.runRefresh(), label: "中断期间手动刷新：降级说明仍在",
        then: [visible("中断说明还在原位", sel.runStreamNote()),
          text("说明报上次读取时刻", sel.runStreamNote(), "上次读取"),
          count("中断期只有一行", RUN_ROW, 1)] },
      { kind: "advance", label: "推进到事件流恢复的那一帧",
        then: [gone("恢复后降级说明撤下", sel.runStreamNote()),
          count("恢复后按新读数补到两行", RUN_ROW, 2)] }
    ]
  }),

  make({
    id: "E06", title: "轮询回退", host: "RUN_TRAJECTORY", stateKind: "恢复",
    component: runPanelComponent,
    note: "回退不等于停摆：SSE 不可用时 hook 仍按 Run 事实重读，新结算靠重读到达而不是靠推送。"
      + "界面上「实时」消失、降级说明出现，这两件事必须同时成立。",
    steps: [
      at(0, "回退为轮询：两项已结算", { run: labRun(), streamDown: true,
        runToolCalls: runProjection([[runCall(0, { toolName: "read_file", args: { relative_path: PATH } }),
          runCall(1, { toolName: "list_directory", args: { path: "apps/workbench/src" } })]]) }),
      at(4_000, "回退期间重读到第三项结算", { run: labRun(), streamDown: true,
        runToolCalls: runProjection([[runCall(0, { toolName: "read_file", args: { relative_path: PATH } }),
          runCall(1, { toolName: "list_directory", args: { path: "apps/workbench/src" } }),
          runCall(2, { toolName: "search_text", args: { query: "order" } })]]) })
    ],
    checks: [
      visible("降级说明在场", sel.runStreamNote()),
      text("说明写明按 Run 事实更新", sel.runStreamNote(), "轨迹只在 Run 事实变化时更新"),
      count("回退期间靠重读拿到三行", RUN_ROW, 3),
      text("计数跟着最新读数走", sel.runCounts(), "已结算 3"),
      noDuplicateRows
    ],
    interactions: [
      { kind: "advance", label: "推进到回退期间重读到第三项的那一帧",
        then: [count("回退期间靠重读拿到三行", RUN_ROW, 3),
          text("计数跟着最新读数走", sel.runCounts(), "已结算 3"),
          visible("降级说明仍在（没有假装恢复）", sel.runStreamNote())] },
      { kind: "click", selector: sel.runRefresh(), label: "回退期间的一次手动重读",
        then: [count("重读不翻倍", RUN_ROW, 3), text("计数不重复累加", sel.runCounts(), "已结算 3"),
          noDuplicateRows] }
    ]
  }),

  make({
    id: "E08", title: "事件乱序", host: "RUN_TRAJECTORY", stateKind: "未知",
    component: runPanelComponent,
    note: "乱序到达时界面按服务端给的那一份整体呈现，不重排、不按时间把旧的盖成新的："
      + "后到的低序号读数不会把已结算行改回在途，已放弃行也不会被后到的结算盖成成功。"
      + "Run 侧词表没有 UNKNOWN（那是会话账本独有的档），因此这里用真实存在的三档验乱序。",
    steps: frame("同一轮里三份到达顺序与时间戳互相矛盾", {
      run: labRun(), runToolCalls: runProjection([[
        runCall(0, { toolName: "read_file", args: { relative_path: PATH }, status: "SETTLED",
          updatedAt: stamp(30) }),
        runCall(1, { toolName: "list_directory", args: { path: "apps/workbench/src" },
          status: "PREPARED", updatedAt: stamp(4) }),
        runCall(2, { toolName: "search_text", args: { query: "order" }, status: "ABANDONED",
          updatedAt: stamp(2) })
      ]]) }),
    checks: [
      count("三行都按到达顺序在场", RUN_ROW, 3),
      text("先结算的那行仍是已结算", `${sel.runCall(runCallId(0))} .trajectory-status`, "已结算"),
      text("迟到的低序号行保持执行中", `${sel.runCall(runCallId(1))} .trajectory-status`,
        "执行中或结果未决"),
      text("时间戳最旧的那行保持已放弃", `${sel.runCall(runCallId(2))} .trajectory-status`, "已放弃"),
      text("计数按各行自己的档分别算", sel.runCounts(), "已结算 1"),
      text("未决那项不被折掉", sel.runCounts(), "正在执行或结果未决 1"),
      text("计数把放弃算进被拒一项", sel.runCounts(), "被拒或已放弃 1"),
      visible("未决行给没有结算结果的分类说明", sel.runFailure(runCallId(1))),
      notText("未决不被后到的读数并成已结算", sel.runCall(runCallId(1)), "已结算")
    ],
    interactions: toggleRunRow(runCallId(1))
  }),

  make({
    id: "E12", title: "工具轨迹部分可用", host: "RUN_SUMMARY", stateKind: "未知",
    component: runSummaryComponent,
    note: "已落盘的账本读得到、生成中的预览这一路 503：摘要必须继续给真实数字，只是不摆预览行。"
      + "**真实产品在这里不给任何降级说明**（预览读失败是静默降级），"
      + "因此这条只钉「落盘数字不受影响 + 不编预览」，缺一条说明这件事单独报为产品问题。",
    steps: frame("账本可读、预览读取失败", {
      run: labRun(), fail: { getRunToolCallPreviews: DB_DOWN },
      runPreviews: [runPreview(modelCallOf(0), 0, [runPreviewFile({ path: "src/lib/preview-only.ts",
        added: 3, removed: 0 })])],
      runToolCalls: runProjection([[runCall(0, { toolName: "apply_changeset",
        args: { operation_id: `${MOCK.operationId}-1` },
        fileChanges: [fileChange("src/lib/order.ts", "MODIFY", { added: 6, removed: 2 })],
        resultRef: { content: "已写入 1 个文件", exit_code: 0 } })]]) }),
    checks: [
      visible("摘要主体在场", sel.summary()),
      visible("已落盘的行照常给出", sel.diffRow(ledgerKey(0, runCallId(0), FILE))),
      text("落盘行报真实增删", sel.diffRow(ledgerKey(0, runCallId(0), FILE)), "+6"),
      gone("预览读不到时不编预览行",
        sel.diffRow(previewKey(0, modelCallOf(0), 0, "src/lib/preview-only.ts"))),
      gone("摘要没有因为预览失败而整体撤下", sel.summaryError())
    ]
  }),

  make({
    id: "E13", title: "最终正文重读失败", host: "SESSION", stateKind: "未知",
    component: sessionComponent,
    note: "与 A12 的分工：A12 钉住「读不回来时怎么标」，这一条钉住**恢复路径**——"
      + "重读入口留在原位，正文回来后在同一位置落定，不留第二个回复块。",
    steps: [
      at(0, "终态已到、正文重读失败（UNVERIFIED）", {
        messages: pair({ status: "COMPLETED", content: null }),
        settling: { text: draftOf(MARKDOWN_RICH, 0.9), revision: "9", truncated: false,
          outcome: "COMPLETED", stage: "UNVERIFIED" } }),
      at(2_000, "点击重读：正文读回", { messages: pair({ status: "COMPLETED", content: MARKDOWN_RICH }),
        settling: null })
    ],
    checks: [
      visible("正文最终在同一位置落定", sel.replyFinal()),
      gone("落定后不留核对中的块", sel.replyVerify()),
      gone("落定后不留草稿块", sel.replyDraft()),
      attr("消息已终态：过程面板按终态档标 settled", sel.trace(), "data-state", "settled")
    ],
    interactions: [
      { kind: "click", selector: sel.verifyFinal(), label: "失败帧里按重读入口",
        then: [visible("重读入口在场", sel.verifyFinal()),
          text("说明写明尚未读回", sel.replyNote(), "最终正文尚未读回"),
          attr("档位是 unverified", sel.replyBlock(), "data-verify", "unverified")] },
      { kind: "advance", label: "推进到正文读回的那一帧",
        then: [visible("正文块出现", sel.replyFinal()),
          text("正文按 Markdown 渲染", sel.replyFinal(), "这一轮做了什么")] }
    ]
  }),

  make({
    id: "E15", title: "取消请求待确认", host: "SESSION", stateKind: "在途",
    component: sessionComponent,
    note: "取消已发出但还没生效：状态词要写「正在生成（正在取消）」，三点按产品要求撤掉，"
      + "过程入口与已结算的行不能因为一次取消请求就消失。",
    steps: frame("用户按下停止，Worker 尚未结清", {
      messages: pair({ status: "RUNNING", content: null, cancelRequested: true }),
      traces: {
        [MOCK.assistantMessageId]: sessionTrace([[
          readCall(0, PATH),
          readCall(1, "pnpm-workspace.yaml", { status: "REQUESTED", settledAt: null })
        ]])
      }
    }),
    checks: [
      text("状态词写正在生成（正在取消）", sel.status(), "正在生成（正在取消）"),
      gone("取消中撤掉在途三点", sel.inflight()),
      visible("过程入口不撤", sel.trace()),
      text("已结算与未结算都在标题里算清", sel.traceActivity(), "已结算 1 项 · 正在执行"),
      visible("已结算那一行还在", sel.call(sessionCallId(0))),
      visible("未结算那一行也还在", sel.call(sessionCallId(1))),
      text("未结算行如实说尚未结算", sel.call(sessionCallId(1)), "已请求，尚未结算")
    ]
  }),

  make({
    id: "E16", title: "用户拒绝审批", host: "RUN_TRAJECTORY", stateKind: "审批",
    component: runPanelComponent,
    note: "实验室里的批准与拒绝**只改这份模拟世界的状态**，不提交真实业务审批、不创建执行凭证。"
      + "拒绝之后：这次调用是「没有执行」，参数仍可读，但没有结果正文，也不给本地文件行。",
    steps: [
      at(0, "等待批准（Review 开着）", { run: labRun(),
        runToolCalls: runProjection([[runCall(0, { toolName: "apply_changeset",
          args: { changes: [{ path: FILE, action: "MODIFY" }] },
          status: "WAITING_APPROVAL", resultRef: null })]]),
        reviews: [approvalReview(`${MOCK.operationId}-1`, { target: { relative_path: FILE } })] }),
      at(2_000, "人工拒绝：Review 已决定，调用未执行", { run: labRun(),
        runToolCalls: runProjection([[runCall(0, { toolName: "apply_changeset",
          args: { changes: [{ path: FILE, action: "MODIFY" }] },
          status: "REJECTED",
          resultRef: { reason: "USER_DENIED", detail: "不允许改动受管目录" } })]]),
        reviews: [approvalReview(`${MOCK.operationId}-1`, { status: "DECIDED", decidedAt: stamp(120),
          target: { relative_path: FILE, decision: "DENY" } })] })
    ],
    checks: [
      text("审批栏说被拒，没有执行", sel.runApproval(runCallId(0)), "被拒，没有执行"),
      text("决定时间原样透出", sel.runApproval(runCallId(0)), "决定时间"),
      attr("状态词是 REJECTED", `${sel.runCall(runCallId(0))} .trajectory-status`,
        "data-status", "REJECTED"),
      visible("失败分类是「没有执行」", sel.runFailure(runCallId(0))),
      text("分类标题", sel.runFailure(runCallId(0)), "没有执行：工具未被准入或已被放弃"),
      text("拒绝原因逐字透出", sel.runFailure(runCallId(0)), "原样原因：USER_DENIED"),
      text("细节一并给出", sel.runFailure(runCallId(0)), "不允许改动受管目录"),
      count("没有执行就不给本地文件行", ".local-file-diff-list", 0),
      text("计数算进被拒或已放弃", sel.runCounts(), "被拒或已放弃 1")
    ],
    interactions: [
      // 展开要发生在「拒绝之后」那一帧：起点帧上这次调用还在等批准，本来就没有回执可读。
      { kind: "advance", label: "推进到人工拒绝那一帧",
        then: [visible("行没有整块卸载", sel.runCall(runCallId(0))),
          attr("状态词换成 REJECTED", `${sel.runCall(runCallId(0))} .trajectory-status`,
            "data-status", "REJECTED")] },
      ...toggleRunRow(runCallId(0), [
        text("即使没执行，参数仍逐字可读", sel.runArgs(runCallId(0)), "src/lib/order.ts"),
        text("回执里记录的原因原样可见", sel.runResult(runCallId(0)), "USER_DENIED"),
        visible("失败分类在展开后仍在", sel.runFailure(runCallId(0))),
        notText("被拒不因为读到回执就升格", `${sel.runCall(runCallId(0))} .trajectory-status`, "已结算")])
    ]
  }),

  make({
    id: "E17", title: "等待审批期间刷新页面", host: "RUN_TRAJECTORY", stateKind: "审批",
    component: runPanelComponent,
    note: "刷新只重读事实，不替用户做决定：等待批准这一档在刷新前后是同一份读数，"
      + "既不显示「已批准」，也不因为重新读取而自动往下执行。",
    steps: [
      at(0, "首次进入：等待你批准", { run: labRun({ status: "WAITING", waitReason: "ACTION_APPROVAL" }),
        runToolCalls: runProjection([[runCall(0, { toolName: "apply_changeset",
          args: { changes: [{ path: FILE, action: "MODIFY" }] }, status: "WAITING_APPROVAL", resultRef: null })]],
        { runStatus: "WAITING", waitReason: "ACTION_APPROVAL" }),
        reviews: [approvalReview(`${MOCK.operationId}-1`, { target: { relative_path: FILE } })] }),
      at(1_500, "刷新后按同一身份重读：还是等待你批准", {
        run: labRun({ status: "WAITING", waitReason: "ACTION_APPROVAL" }),
        runToolCalls: runProjection([[runCall(0, { toolName: "apply_changeset",
          args: { changes: [{ path: FILE, action: "MODIFY" }] }, status: "WAITING_APPROVAL", resultRef: null })]],
        { runStatus: "WAITING", waitReason: "ACTION_APPROVAL" }),
        reviews: [approvalReview(`${MOCK.operationId}-1`, { target: { relative_path: FILE } })] })
    ],
    checks: [
      text("刷新后仍是等待你批准", sel.runApproval(runCallId(0)), "等待你批准"),
      notText("刷新不会自动写成已批准", sel.runApproval(runCallId(0)), "已批准这只动作"),
      attr("状态词仍是 WAITING_APPROVAL", `${sel.runCall(runCallId(0))} .trajectory-status`,
        "data-status", "WAITING_APPROVAL"),
      text("计数把它算进等待批准一项", sel.runCounts(), "等待批准 1"),
      text("Run 等待原因如实报出", sel.runCounts(), "Run 等待原因")
    ],
    interactions: [{ kind: "click", selector: sel.runRefresh(), label: "刷新：轨迹重读但状态不变",
      then: [count("重读后仍只有一行", RUN_ROW, 1),
        text("状态没被刷新改写", sel.runApproval(runCallId(0)), "等待你批准"),
        noDuplicateRows] }]
  })
];
