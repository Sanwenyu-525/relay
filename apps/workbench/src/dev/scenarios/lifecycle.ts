import type { RelayAssistMessage } from "../../api/dtos/assist";
import {
  MARKDOWN_RICH, assistantMessage, draftOf, livePreview, pair, readCall, recallReceipt,
  recallSummary, sessionTrace, sourceOf, userMessage
} from "../scenarioFixtures";
import type { ScenarioWorld } from "../scenarioWorld";
import {
  attr, at, chain, count, frame, gone, make, notText, patch, sel, sessionCallId, sessionComponent,
  text, visible, withTrace
} from "./common";

/**
 * A 组 · AI 回复生命周期（16 条）。
 *
 * 验的是**一条助手消息从提交到落定的呈现链**：在途、流式草稿、草稿读取失败、
 * 草稿→正文交接、终态正文、失败与取消、空正文、过程未结清、多轮、撤回、来源与用量。
 *
 * 三条口径来自产品而不是实验室：
 *   * 权威状态只有 `message.status`；`settling` 与 `handover` 是呈现档，不改写状态。
 *   * 草稿是纯文本，不提前渲染 Markdown，也不冒充完整消息。
 *   * 终态消息的过程账本**首次展开才读**，所以开局是「展开查看」而不是「本轮没有调用工具」。
 */

/** 会话世界：只换消息数组，其余保持默认空值。 */
const msgs = (messages: readonly RelayAssistMessage[]): Partial<ScenarioWorld> => ({ messages });

/** 一问一答 + 指定助手终态：绝大多数生命周期场景的开局。 */
const qa = (assistantPatch: Partial<RelayAssistMessage> = {}): Partial<ScenarioWorld> =>
  msgs(pair(assistantPatch));

/** 六段纯文本：只验分段排版，不掺任何 Markdown 结构语法。 */
const MULTI_PARA = [
  "这次没有改任何业务契约，只把呈现层的口径收了一遍。",
  "先说清事实来源：会话账本只记录请求与结算，它没有保存工具结果正文的那一列。",
  "所以界面上任何「输出内容」都必须来自 Run 侧的回执，而不是会话侧补出来的。",
  "第二段范围是草稿到正文的交接：交接期间草稿留在原位，正文读回后同一位置替换，不留空白帧。",
  "第三段范围是失败与取消：这两档按终态清掉草稿，界面上不留一个解释不清的进度点。",
  "以上就是本轮的全部范围，其余文件保持原样。"
].join("\n\n");

/** 一小段可复制的代码：内容无害，只用来量代码块与复制入口。 */
const CODE_SNIPPET = [
  "import { compareDecimalRevisions } from \"./decimalRevision\";",
  "",
  "export function isNewer(left: string, right: string): boolean {",
  "  return compareDecimalRevisions(left, right) > 0;",
  "}"
].join("\n");

/** 窄表格（3 列 × 4 行）：A09 只验表格渲染本身，宽度交给 F12。 */
const SMALL_TABLE = [
  "## 检查结果",
  "",
  "| 检查 | 结果 | 耗时 |",
  "| --- | --- | --- |",
  "| typecheck | 通过 | 8.4s |",
  "| test | 通过 | 21.2s |",
  "| docs | 2 条链接待修 | 1.1s |",
  "| build | 未运行 | — |"
].join("\n");

export const LIFECYCLE = [
  make({
    id: "A05", title: "只有一行短回复", host: "SESSION", stateKind: "终态",
    component: sessionComponent,
    note: "无工具时正文与执行过程入口互不遮挡：入口恒在，展开后如实说没调用工具。",
    steps: frame("用户提问 + 助手已完成正文", qa({
      content: "这次没有动任何文件，只把结论说清楚：顺序问题出在依赖声明上。",
      status: "COMPLETED"
    })),
    checks: [
      visible("最终正文区块在场", sel.replyFinal()),
      text("正文逐字呈现", sel.replyFinal(), "顺序问题出在依赖声明上"),
      visible("执行过程入口仍在（终态也不消失）", sel.trace()),
      attr("开局相位是 IDLE（还没读）", sel.trace(), "data-phase", "IDLE"),
      text("开局只说展开查看", sel.traceActivity(), "展开查看"),
      gone("终态不画在途三点", sel.inflight()),
      gone("没有草稿区", sel.replyDraft()),
      visible("复制入口在场", sel.copy())
    ],
    interactions: [{
      kind: "click", selector: sel.traceToggle(), label: "展开执行过程（终态首次读取）",
      then: [attr("读完后相位换成 EMPTY", sel.trace(), "data-phase", "EMPTY"),
        visible("空状态说明在场", sel.traceEmpty()),
        text("空状态文案", sel.traceActivity(), "本轮没有调用工具"),
        visible("展开后入口仍在", sel.trace())]
    }]
  }),

  make({
    id: "A01", title: "新会话首次发送", host: "SESSION", stateKind: "在途",
    component: sessionComponent,
    note: "PENDING 比「正在执行」更早一档：meta 行不写状态词，进度由三点与「等待处理」表达。",
    steps: frame("PENDING 且还没有任何草稿", qa({ status: "PENDING", content: null })),
    checks: [
      visible("在途三点在场", sel.inflight()),
      attr("三点给出可访问名", sel.inflight(), "aria-label", "已提交，等待处理，正在生成"),
      gone("PENDING 不在 meta 行标状态词", sel.status()),
      attr("过程相位是 RUNNING_NO_TOOLS", sel.trace(), "data-phase", "RUNNING_NO_TOOLS"),
      text("零记录时只说等待处理", sel.traceActivity(), "等待处理"),
      gone("还没有正文块", sel.replyFinal())
    ]
  }),

  make({
    id: "A03", title: "AI 正在处理，尚未调用工具", host: "SESSION", stateKind: "在途",
    component: sessionComponent,
    note: "在途且零记录只能说「正在执行」：这一档还没有任何结算事实，界面不许提前写成"
      + "「本轮没有调用工具」（那是 EMPTY 相位，属于终态）。",
    uncovered: "「正在读取这一轮的过程…」这一支没有记为通过：模拟读数按调用那一刻立即返回，"
      + "稳定帧上必然已经读完，loading 节点在这个 harness 里挂不住。要拍到它需要真实的挂起读数。",
    steps: frame("RUNNING 无草稿无工具", qa({ status: "RUNNING", content: null })),
    checks: [
      visible("在途三点在场", sel.inflight()),
      attr("在途默认把过程展开", sel.trace(), "data-state", "active"),
      text("零记录只报正在执行", sel.traceActivity(), "正在执行"),
      notText("在途不提前宣布本轮没有工具", sel.traceActivity(), "本轮没有调用工具"),
      gone("零记录时不画任何调用行", sel.call(sessionCallId(0))),
      text("状态词是正在生成", sel.status(), "正在生成")
    ]
  }),

  make({
    id: "A04", title: "AI 开始流式输出", host: "SESSION", stateKind: "流式",
    component: sessionComponent,
    note: "三帧的时刻与内容都由场景给定，不依赖真实网络抖动：同一份场景重放第 37 次与第 1 次一致。",
    steps: [
      at(0, "首帧草稿（v1，15%）", { ...qa({ status: "RUNNING", content: null }),
        preview: livePreview({ previewAvailable: true, previewRevision: "1", previewText: draftOf(MARKDOWN_RICH, 0.15) }) }),
      at(1_400, "草稿推进（v4，55%）", { ...qa({ status: "RUNNING", content: null }),
        preview: livePreview({ previewAvailable: true, previewRevision: "4", previewText: draftOf(MARKDOWN_RICH, 0.55) }) }),
      at(2_900, "草稿推进（v9，92%）", { ...qa({ status: "RUNNING", content: null }),
        preview: livePreview({ previewAvailable: true, previewRevision: "9", previewText: draftOf(MARKDOWN_RICH, 0.92) }) })
    ],
    checks: [
      visible("草稿块在场", sel.replyDraft()),
      attr("呈现档是 draft", sel.replyBlock(), "data-state", "draft"),
      text("草稿标注不是完整消息", sel.replyNote(), "不是完整消息或已接受产物"),
      text("草稿修订号如实报出", sel.replyNote(), "v9"),
      gone("草稿期没有最终正文块", sel.replyFinal()),
      visible("在途三点与草稿并存", sel.inflight())
    ]
  }),

  make({
    id: "X01", title: "草稿被服务端截断", host: "SESSION", stateKind: "流式",
    component: sessionComponent,
    steps: frame("预览 truncated 为真", { ...qa({ status: "RUNNING", content: null }),
      preview: livePreview({ previewAvailable: true, previewTruncated: true,
        previewRevision: "6", previewText: draftOf(MARKDOWN_RICH, 0.4) }) }),
    checks: [
      visible("草稿块在场", sel.replyDraft()),
      text("截断另行说明", sel.replyNote(), "预览已截断")
    ]
  }),

  make({
    id: "X02", title: "草稿读取失败（不影响消息状态）", host: "SESSION", stateKind: "失败",
    component: sessionComponent,
    steps: frame("预览读取抛错", { ...qa({ status: "RUNNING", content: null }),
      previewError: { message: "模拟：预览连续三次读取超时。", lastSuccessAt: null } }),
    checks: [
      visible("预览错误区在场", sel.previewError()),
      text("错误原因逐字透出", sel.previewError(), "预览连续三次读取超时"),
      text("说明后台回复仍以消息为准", sel.previewError(), "后台回复状态仍以消息为准"),
      text("没成功过就说没成功", sel.previewError(), "尚未成功读取预览"),
      gone("失败预览不编出正文块", sel.replyFinal())
    ]
  }),

  make({
    id: "A11", title: "正在核对最终回复", host: "SESSION", stateKind: "在途",
    component: sessionComponent,
    steps: frame("预览已判终态、正文尚未读回", { ...qa({ status: "COMPLETED", content: null }),
      settling: { text: draftOf(MARKDOWN_RICH, 0.9), revision: "9", truncated: false,
        outcome: "COMPLETED", stage: "SETTLING" },
      handover: true }),
    checks: [
      visible("核对中的回复块在场", sel.replyVerify()),
      attr("核对档标为 settling", sel.replyBlock(), "data-verify", "settling"),
      text("说明仍是草稿", sel.replyNote(), "以下仍是草稿 · 正在核对最终正文"),
      attr("交接淡入标记在场", sel.replyBlock(), "data-handover", "true"),
      text("播报一次粗粒度状态", sel.announce(), "正在核对最终正文")
    ]
  }),

  make({
    id: "A12", title: "最终回复读取失败", host: "SESSION", stateKind: "未知",
    component: sessionComponent,
    note: "重读失败不能画成已完成：这一档给恢复入口，且播报「状态待核对」。",
    steps: frame("核对失败，草稿留在原位", { ...qa({ status: "COMPLETED", content: null }),
      settling: { text: draftOf(MARKDOWN_RICH, 0.9), revision: "9", truncated: false,
        outcome: "COMPLETED", stage: "UNVERIFIED" } }),
    checks: [
      attr("核对档标为 unverified", sel.replyBlock(), "data-verify", "unverified"),
      text("明确状态待核对", sel.replyNote(), "最终正文尚未读回"),
      visible("重读最终回复入口在场", sel.verifyFinal()),
      text("播报里说的是待核对", sel.announce(), "状态待核对"),
      notText("不播报成已完成", sel.announce(), "回复已完成")
    ]
  }),

  make({
    id: "A10", title: "流式草稿转换为正式回复", host: "SESSION", stateKind: "终态",
    component: sessionComponent,
    note: "先有核对中的草稿位，再同一位置换成 Markdown 正文：中间不能出现两帧之间的空白。",
    steps: [
      at(0, "草稿留在原位（SETTLING）", { ...qa({ status: "COMPLETED", content: null }),
        settling: { text: draftOf(MARKDOWN_RICH, 0.9), revision: "9", truncated: false,
          outcome: "COMPLETED", stage: "SETTLING" }, handover: true }),
      at(1_200, "正文读回，同一位置落定", { ...qa({ status: "COMPLETED", content: MARKDOWN_RICH }), handover: false })
    ],
    checks: [
      visible("最终正文块在场", sel.replyFinal()),
      text("标题按 Markdown 渲染", sel.replyFinal(), "这一轮做了什么"),
      gone("正文落定后草稿块撤下", sel.replyDraft()),
      gone("交接标记不留给历史消息", sel.replyVerify()),
      visible("用量行在场", sel.usage()),
      visible("复制入口在场", sel.copy())
    ]
  }),

  make({
    id: "A14", title: "AI 生成失败", host: "SESSION", stateKind: "失败",
    component: sessionComponent,
    steps: frame("服务端给出失败终态", qa({ status: "FAILED", content: null,
      errorCode: "MODEL_TIMEOUT", providerErrorKind: "TIMEOUT" })),
    checks: [
      text("状态词是生成失败", sel.status(), "生成失败"),
      text("错误码逐字透出", sel.message(), "MODEL_TIMEOUT"),
      visible("模型服务分类说明在场", sel.providerError()),
      gone("失败不画成完成正文", sel.replyFinal())
    ]
  }),

  make({
    id: "A15", title: "AI 回复被取消", host: "SESSION", stateKind: "取消",
    component: sessionComponent,
    note: "取消是终态：草稿按终态要求清掉，界面不留一个解释不清的进度点。",
    steps: frame("停止生效后的终态", qa({ status: "CANCELLED", content: null, cancelRequested: false })),
    checks: [
      text("状态词是已取消", sel.status(), "已取消"),
      gone("取消后不画在途三点", sel.inflight()),
      gone("取消后不画正文块", sel.replyFinal()),
      gone("取消后不画草稿块", sel.replyDraft())
    ]
  }),

  make({
    id: "A13", title: "已完成但无正文", host: "SESSION", stateKind: "边界",
    component: sessionComponent,
    steps: frame("COMPLETED 且正文是空串", qa({ status: "COMPLETED", content: "" })),
    checks: [
      visible("空回复说明在场", sel.emptyReply()),
      text("说明不留模糊空白", sel.emptyReply(), "没有可显示的正文"),
      gone("空正文不渲染成正文块", sel.replyFinal())
    ]
  }),

  make({
    id: "X03", title: "正文已结束、过程却有一项没结算", host: "SESSION", stateKind: "未知",
    component: sessionComponent,
    note: "故意把两种事实放在一起：正文落定不等于工具都结清了。行内必须留住「已请求，尚未结算」，"
      + "标题也不许把它盖成「全部完成 / 成功」一类结论。"
      + "已发现的产品口径问题（单列进报告，不在此判通过）：标题写「1 项操作 · 已结束」，"
      + "「结束」指的是这一轮不再推进，读起来却像所有事项都结清了。",
    steps: [{ at: 0, label: "正文 COMPLETED + 一行 REQUESTED 未结算",
      set: chain(patch(qa({ status: "COMPLETED", content: "先说结论：这一步还没结清。" })),
        withTrace(sessionTrace([[readCall(0, "package.json", { status: "REQUESTED", settledAt: null })]]))) }],
    checks: [
      visible("终态消息的过程入口在场", sel.trace()),
      text("未读时只说展开查看", sel.traceActivity(), "展开查看")
    ],
    interactions: [{ kind: "click", selector: sel.traceToggle(), label: "展开过程核对未结清行",
      then: [visible("未结算的行在场", sel.call(sessionCallId(0))),
        visible("展开后行仍在", sel.call(sessionCallId(0))),
        visible("入口本身不消失", sel.trace()),
        text("行内如实说尚未结算", sel.call(sessionCallId(0)), "已请求，尚未结算"),
        attr("未结算的行是在途档而不是完成档", sel.call(sessionCallId(0)), "data-tone", "active"),
        notText("行内不写成已结算", sel.call(sessionCallId(0)), "已结算"),
        notText("标题不把未结清盖成全部完成", sel.traceActivity(), "全部完成"),
        notText("标题不写成功结论", sel.traceActivity(), "成功"),
        notText("标题不写都已结清", sel.traceActivity(), "都已结清")] }]
  }),

  make({
    id: "A16", title: "用户查看历史消息后继续生成", host: "SESSION", stateKind: "呈现",
    component: sessionComponent,
    note: "两条助手消息各有各的账本：一条读过文件，一条确实没调用工具。",
    steps: [{ at: 0, label: "第一轮在途有读取，第二轮已终态纯文本", set: (world) => {
      const first = assistantMessage({ id: "mock-msg-a1", seq: "2", status: "RUNNING", content: null });
      const second = assistantMessage({ id: "mock-msg-a2", seq: "4", status: "COMPLETED",
        content: "第二轮只回答，没动手。" });
      const followUp = userMessage("再问一次", { id: "mock-msg-u2", seq: "3" });
      return withTrace(sessionTrace([[readCall(0, "package.json"), readCall(1, "pnpm-workspace.yaml")]], "mock-msg-a1"),
        "mock-msg-a1")(patch({ messages: [userMessage("把这次的改动过程说清楚"),
          first, followUp, second] })(world));
    } }],
    checks: [
      count("两条助手消息各一行", sel.role("ASSISTANT"), 2),
      visible("第一条的过程入口在场", sel.trace("mock-msg-a1")),
      visible("第二条的过程入口在场", sel.trace("mock-msg-a2")),
      visible("在途那条确实有读取行", sel.call(sessionCallId(0))),
      count("读取行只挂在第一条下面", `${sel.traceRoundList("mock-msg-a1")} .activity-item`, 2),
      text("终态那条还没读，只说展开查看", sel.trace("mock-msg-a2"), "展开查看")
    ]
  }),

  make({
    id: "X04", title: "撤回回执（逐文件回退结果）", host: "SESSION", stateKind: "恢复",
    component: sessionComponent,
    steps: [{ at: 0, label: "用户消息带已完成的撤回回执", set: patch({
      messages: [
        userMessage("把刚才那轮撤回", { recall: recallSummary() }),
        assistantMessage({ status: "COMPLETED", content: "那一轮改过两个文件。" })],
      recallReceipt: recallReceipt() }) }],
    checks: [
      visible("回执摘要在场", sel.recallNote("mock-recall")),
      text("摘要给出回退数量", sel.recallNote("mock-recall"), "已回退 2 个文件"),
      visible("正文与回执同时存在", sel.replyFinal())
    ]
  }),

  make({
    id: "X05", title: "来源、用量与人设标签", host: "SESSION", stateKind: "呈现",
    component: sessionComponent,
    steps: [{ at: 0, label: "带三份来源与用量的终态回复", set: patch({
      personaLabel: "学习搭档 · v3",
      ...qa({ status: "COMPLETED", content: "结论来自这三份资料。",
        sources: [sourceOf("docs/frontend/workbench-design.md"), sourceOf("docs/frontend/design-system.md"),
          sourceOf("已删除的历史快照", "UNAVAILABLE", "来源条目已不存在")],
        usage: { inputTokens: 48210, outputTokens: 913, cacheReadTokens: 32768, cacheCreationTokens: null } }) }) }],
    checks: [
      visible("来源条在场", sel.sources()),
      text("来源数量如实统计", sel.sources(), "已读取 3 份资料"),
      text("不可用的来源照样说明", sel.sources(), "来源不可用"),
      visible("用量行在场", sel.usage()),
      text("用量报上下文 tokens", sel.usage(), "48210"),
      visible("助手档显示冻结人设", sel.persona())
    ]
  }),

  /* ---------------- 矩阵补齐：A02 / A06 / A07 / A08 / A09 ---------------- */

  make({
    id: "A02", title: "消息已提交，等待处理", host: "SESSION", stateKind: "在途",
    component: sessionComponent,
    note: "与 A01 的差别是**会话不是新的**：上一轮问答仍在原地可读，新的这一轮刚提交、Worker 还没领取。"
      + "历史正文不能因为新的一轮在途而被改写或撤下。",
    steps: frame("历史一轮已完成 + 新一轮 PENDING", { messages: [
      userMessage("先看下依赖顺序", { id: "mock-msg-u1", seq: "1" }),
      assistantMessage({ id: "mock-msg-a1", seq: "2", status: "COMPLETED",
        content: "上一轮的结论：顺序问题在依赖声明上。" }),
      userMessage("再确认一次构建产物", { id: "mock-msg-u2", seq: "3" }),
      assistantMessage({ id: "mock-msg-a2", seq: "4", status: "PENDING", content: null }) ] }),
    checks: [
      count("两条助手消息各一行", sel.role("ASSISTANT"), 2),
      visible("在途三点挂在新的那条上", sel.inflight("mock-msg-a2")),
      gone("历史那条终态不画在途三点", sel.inflight("mock-msg-a1")),
      text("历史正文原样可读", sel.replyFinal("mock-msg-a1"), "顺序问题在依赖声明上"),
      gone("PENDING 不在 meta 行标状态词", `${sel.message("mock-msg-a2")} .agent-message-status`),
      text("新一年的过程开局只说等待处理", sel.trace("mock-msg-a2"), "等待处理"),
      gone("新一轮还没有正文块", sel.replyFinal("mock-msg-a2"))
    ]
  }),

  make({
    id: "A06", title: "多段长文本回复", host: "SESSION", stateKind: "终态",
    component: sessionComponent,
    note: "纯段落、无结构：验的是长正文的分段排版与「正文完整」这件事，不掺 Markdown 语法。",
    steps: frame("六段纯文本正文落定", qa({ status: "COMPLETED", content: MULTI_PARA })),
    checks: [
      visible("最终正文区块在场", sel.replyFinal()),
      text("第一段逐字呈现", sel.replyFinal(), "这次没有改任何业务契约"),
      text("最后一段没有被裁掉", sel.replyFinal(), "以上就是本轮的全部范围"),
      visible("正文按 Markdown 根渲染", sel.markdown()),
      count("段落数与夹具一致", `${sel.markdown()} p`, 6),
      visible("复制入口在场", sel.copy()),
      visible("用量行在场", sel.usage())
    ]
  }),

  make({
    id: "A07", title: "Markdown 标题、列表、引用", host: "SESSION", stateKind: "呈现",
    component: sessionComponent,
    note: "SafeMarkdown 把 `##`/`###` 一律降级成 `h3`/`h4`（`SafeMarkdown.tsx:187-189`），"
      + "真实层级放在 `data-heading-level` 上——消息体不跟页面标题抢层级。"
      + "因此这里按 `data-heading-level` 断言，不按标签名断言。",
    steps: frame("含标题 / 有序列表 / 引用块的正文", qa({ status: "COMPLETED", content: MARKDOWN_RICH })),
    checks: [
      visible("正文按 Markdown 渲染", sel.markdown()),
      text("二级标题文字在场", sel.markdown(), "这一轮做了什么"),
      text("三级标题文字在场", sel.markdown(), "读取"),
      count("两级标题各成一块", `${sel.markdown()} [data-heading-level]`, 2),
      attr("来源层级如实标在块上（## → 2）", `${sel.markdown()} [data-heading-level="2"]`,
        "data-heading-level", "2"),
      attr("来源层级如实标在块上（### → 3）", `${sel.markdown()} [data-heading-level="3"]`,
        "data-heading-level", "3"),
      count("有序列表三项", `${sel.markdown()} ol li`, 3),
      count("结尾无序列表两项", `${sel.markdown()} ul li`, 2),
      visible("引用块在场", `${sel.markdown()} blockquote`),
      text("引用文字逐字呈现", sel.markdown(), "顺序问题只出在 workbench 自己的依赖声明上")
    ]
  }),

  make({
    id: "A08", title: "代码块与复制", host: "SESSION", stateKind: "呈现",
    component: sessionComponent,
    note: "复制入口只做**存在与可达名**检查：实验室不自动按下它，因为那会写入用户真实的系统剪贴板——"
      + "这是开发工具不该有的外部副作用，人工检查时再点。",
    steps: frame("含一段带语言标注的代码块的正文", qa({ status: "COMPLETED",
      content: ["这轮改动只落在一处：" , "", "```ts", CODE_SNIPPET, "```", "", "其余文件保持原样。"].join("\n") })),
    checks: [
      visible("代码块外壳在场", sel.codeBlock()),
      text("代码块标注语言", sel.codeBlock(), "ts"),
      visible("代码正文按整块呈现", `${sel.codeBlock()} pre`),
      text("代码内容逐字透出", sel.codeBlock(), "compareDecimalRevisions"),
      visible("复制这段代码的入口在场", sel.codeCopy()),
      attr("代码块初始是未复制态", sel.codeBlock(), "data-copy-state", "idle"),
      notText("未按下前不谎报已复制", sel.codeBlock(), "已复制")
    ]
  }),

  make({
    id: "A09", title: "Markdown 表格", host: "SESSION", stateKind: "呈现",
    component: sessionComponent,
    steps: frame("含表格的正文", qa({ status: "COMPLETED", content: SMALL_TABLE })),
    checks: [
      visible("表格在场", `${sel.markdown()} table`),
      count("表头三列", `${sel.markdown()} thead th`, 3),
      count("四行数据", `${sel.markdown()} tbody tr`, 4),
      text("单元格文字逐字呈现", sel.markdown(), "typecheck"),
      visible("宽时可横向滚动的容器在场", sel.tableScroll()),
      attr("滚动容器可聚焦（键盘可达）", sel.tableScroll(), "tabindex", "0")
    ]
  })
];
