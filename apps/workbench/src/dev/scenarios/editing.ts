import type { RelayRunToolCall } from "../../api/dtos/assist";
import {
  MOCK, approvalReview, changeSets, commandResult, fileChange, frozenDiff, labRun, modelCallOf, runCall,
  runPreview, runPreviewFile, runProjection
} from "../scenarioFixtures";
import type { ScenarioWorld } from "../scenarioWorld";
import {
  attr, count, diffComponent, frame, gone, ledgerKey, make, notText, previewKey, runCallId, sel,
  text, runSummaryComponent, toggleDiffRow, toggleSummaryRow, visible
} from "./common";

/**
 * C 组 · 文件编辑与验证（矩阵 17 条 + 补充 8 条）。
 *
 * 这一组守的是**三种状态不许互相冒充**：
 *   * 预览（正在生成）—— 数字来自临时参数预览，行上永远带「预览」，不进总数；
 *   * 落盘（已修改）—— 只有逐文件账本 `fileChanges` 支持时才写；
 *   * 待核对 / 待应用 / 失败 —— 没有可核对的数字就省略数字，绝不画成 `+0 −0`。
 * 「已修改」也不等于「已验证通过」：这条链路上没有任何验证字段，因此场景直接断言界面没有
 * 把编辑说成验证结论（`notText "已验证"`）。
 *
 * 宿主只能是 Run 侧：会话账本既没有逐文件结果也没有 `result_ref`，把编辑行画在会话侧
 * 等于凭空加数（见 `localFileDiffRows` 的注释）。被拒与放弃同样**不产生局部行**（C11），
 * 因为那一侧既没有落盘事实也没有目标内容。
 */

const FILE = "src/lib/order.ts";
const SECOND = "src/lib/status.ts";
const PNG = "assets/mock/logo.png";

/** 逐行对齐用的 40 行基线：后 12 行被改写、末 3 行被删掉、再追加 4 行新代码。 */
const BASE_LINES = Array.from({ length: 40 }, (_, index) => `export const v${index} = ${index};`);
const EDITED_LINES = [
  ...BASE_LINES.slice(0, 28),
  ...BASE_LINES.slice(28).map((line) => line.replace(/;$/u, " * 2;")),
  ...Array.from({ length: 4 }, (_, index) => `export const extra${index} = true;`)
];
/** 前 28 行相同、12 行改写、3 行删除、4 行新增：对齐后正好 28 上下文 + 12 删 + 16 增。 */
const BASE_TEXT = `${BASE_LINES.join("\n")}\n`;
const EDITED_TEXT = `${EDITED_LINES.join("\n")}\n`;

/** 超过逐行对齐上限的长文：`alignedLines` 在这里返回 null，界面改按原文对照。 */
const LARGE_TEXT = Array.from({ length: 400 }, (_, index) => `export const n${index} = ${index};`).join("\n");

/** 写入意图（`arguments.changes` 原样保留的形状）。 */
const intent = (path: string, action: "CREATE" | "MODIFY" | "DELETE" = "MODIFY") =>
  ({ changes: [{ path, action }] });

/** 一条写入调用：这一组只看 apply_changeset，动作与意图固定，只换状态与账本。 */
function write(index: number, path: string, patch: Partial<RelayRunToolCall> = {}): RelayRunToolCall {
  return runCall(index, { toolName: "apply_changeset", args: intent(path), ...patch });
}

/** Run 侧一次写入的世界：调用行 + 可选的临时预览、审批记录与冻结正文。
 *  `runStatus` 走投影而不是世界：摘要与轨迹两处读的是同一份 `runToolCalls`，
 *  终态与否由它决定（在途三点与预览轮询都按 `TERMINAL_RUN` 收敛）。 */
function writes(calls: readonly RelayRunToolCall[], extra: Partial<ScenarioWorld> = {},
  projection: { readonly runStatus?: string; readonly waitReason?: string | null } = {}
): Partial<ScenarioWorld> {
  return { run: labRun(), runToolCalls: runProjection([calls], projection), ...extra };
}

/** 预览行的键（轮次 + 模型调用身份 + 序号 + 路径）。 */
const pkey = (path: string, ordinal = 0, round = 0): string =>
  previewKey(round, modelCallOf(round), ordinal, path);
/** 已落账与意图行的键（轮次 + 调用身份 + 路径）。 */
const lkey = (path: string, index = 0, round = 0): string => ledgerKey(round, runCallId(index), path);

export const EDITING = [
  make({
    id: "C07", title: "文件修改预览", host: "RUN_SUMMARY", stateKind: "写入",
    component: runSummaryComponent,
    steps: frame("REQUESTED 写入 + 临时预览（+3 −1）",
      writes([write(0, FILE, { status: "REQUESTED" })], {
        runPreviews: [runPreview(modelCallOf(0), 0, [runPreviewFile({ path: FILE, added: 3, removed: 1 })])]
      })),
    checks: [
      visible("编辑行在场", sel.diffRow(pkey(FILE))),
      text("状态词是正在生成", sel.diffRow(pkey(FILE)), "正在生成"),
      text("预览数字如实给出", sel.diffRow(pkey(FILE)), "+3"),
      attr("行被标为预览来源", sel.diffRow(pkey(FILE)), "data-preview", "true"),
      attr("相位是 generating", sel.diffRow(pkey(FILE)), "data-phase", "generating"),
      notText("预览不写已修改", sel.diffRow(pkey(FILE)), "已修改"),
      notText("预览不冒充验证结论", sel.diffRow(pkey(FILE)), "已验证"),
      notText("没结算就不计写入次数", sel.summary(), "写入 1 次"),
      text("在途按未决口径统计", sel.summary(), "1 项进行中或结果未决")
    ]
  }),

  make({
    id: "X11", title: "预览目标未收全：删除侧不给数字", host: "RUN_SUMMARY", stateKind: "写入",
    component: runSummaryComponent,
    steps: frame("预览里 targetComplete 为 false",
      writes([write(0, FILE, { status: "REQUESTED" })], {
        runPreviews: [runPreview(modelCallOf(0), 0,
          [runPreviewFile({ path: FILE, added: 2, removed: 7, targetComplete: false })])]
      })),
    checks: [
      visible("编辑行在场", sel.diffRow(pkey(FILE))),
      count("删除侧没有画数字", `${sel.diffRow(pkey(FILE))} [data-metric="removed"]`, 0),
      text("另说一句目标未收全", sel.diffRow(pkey(FILE)), "目标未收全"),
      notText("未收全不写已修改", sel.diffRow(pkey(FILE)), "已修改")
    ]
  }),

  make({
    id: "X12", title: "预览正文被截断：数字只是下界", host: "RUN_SUMMARY", stateKind: "边界",
    component: runSummaryComponent,
    steps: frame("预览带 truncated 标记",
      writes([write(0, FILE, { status: "REQUESTED" })], {
        runPreviews: [runPreview(modelCallOf(0), 0, [runPreviewFile({ path: FILE, added: 40, removed: 0 })],
          { truncated: true, revision: "12" })]
      })),
    checks: [
      text("标注预览已截断", sel.diffRow(pkey(FILE)), "预览已截断"),
      attr("截断不改相位：仍是 generating", sel.diffRow(pkey(FILE)), "data-phase", "generating"),
      notText("截断不写成完整结果", sel.diffRow(pkey(FILE)), "已修改")
    ]
  }),

  make({
    id: "C08", title: "等待写入审批", host: "RUN_SUMMARY", stateKind: "审批",
    component: runSummaryComponent,
    note: "审批按钮只操作模拟状态，不提交真实业务审批；链接仍指向原审批页既有路由形状。",
    steps: frame("WAITING_APPROVAL + 预览 + OPEN 审批记录",
      writes([write(0, FILE, { status: "WAITING_APPROVAL" })], {
        runPreviews: [runPreview(modelCallOf(0), 0, [runPreviewFile({ path: FILE, added: 6, removed: 2 })])],
        reviews: [approvalReview("mock-op-1")]
      })),
    checks: [
      visible("编辑行在场", sel.diffRow(pkey(FILE))),
      text("状态词是待应用", sel.diffRow(pkey(FILE)), "待应用"),
      attr("相位是 waitingApproval", sel.diffRow(pkey(FILE)), "data-phase", "waitingApproval"),
      notText("待批准不写已修改", sel.diffRow(pkey(FILE)), "已修改"),
      text("统计里单列等待批准", sel.summary(), "1 项等待你批准"),
      visible("给出通往原审批入口的链接", sel.summaryWaitingLink())
    ]
  }),

  make({
    id: "X13", title: "待批准且还没有预览：只列意图不给数字", host: "RUN_SUMMARY", stateKind: "审批",
    component: runSummaryComponent,
    steps: frame("WAITING_APPROVAL，预览尚未到达",
      writes([write(0, FILE, { status: "WAITING_APPROVAL" })], { reviews: [approvalReview("mock-op-1")] })),
    checks: [
      visible("意图行在场", sel.diffRow(lkey(FILE))),
      text("状态词是待应用", sel.diffRow(lkey(FILE)), "待应用"),
      count("没有任何加数", `${sel.diffRow(lkey(FILE))} [data-metric="added"]`, 0),
      count("没有任何减数", `${sel.diffRow(lkey(FILE))} [data-metric="removed"]`, 0),
      text("可访问名说清行数待核对", sel.diffRow(lkey(FILE)), "行数待核对")
    ],
    interactions: toggleDiffRow(lkey(FILE))
  }),

  make({
    id: "C01", title: "修改单个文件", host: "RUN_SUMMARY", stateKind: "写入",
    component: runSummaryComponent,
    note: "展开走既有只读入口：按原 operation_id 读冻结文本，不新造第二套历史。",
    steps: frame("SETTLED + 逐文件账本 +41 −8",
      writes([write(0, FILE, { fileChanges: [fileChange(FILE, "MODIFY", { added: 41, removed: 8 })] })], {
        frozenDiff: frozenDiff(FILE, "export const limit = 10;\n", "export const limit = 40;\n"),
        changeSets: changeSets("mock-op-1", FILE)
      })),
    checks: [
      visible("编辑行在场", sel.diffRow(lkey(FILE))),
      text("状态词是已修改", sel.diffRow(lkey(FILE)), "已修改"),
      text("加数逐字来自账本", sel.diffRow(lkey(FILE)), "+41"),
      text("减数逐字来自账本", sel.diffRow(lkey(FILE)), "−8"),
      attr("行不再带预览标记", sel.diffRow(lkey(FILE)), "data-preview", "false"),
      notText("已修改不等于已验证通过", sel.diffRow(lkey(FILE)), "已验证"),
      visible("展开入口在场", sel.diffToggle(lkey(FILE)))
    ],
    interactions: [
      { kind: "click", selector: sel.diffToggle(lkey(FILE)), label: "展开这次编辑的前后文本",
        then: [visible("正文区已挂载", sel.diffBody(lkey(FILE))),
          visible("按同一动作身份读回冻结差异", sel.frozenDiff()),
          text("差异标题说明仅描述计划", sel.frozenDiff(), "仅描述计划，不代表文件已应用"),
          text("账本状态一并显示", sel.frozenDiff(), "账本 APPLIED")] },
      { kind: "click", selector: sel.diffToggle(lkey(FILE)), label: "再点一次收起前后文本",
        then: [gone("正文区随收起移除", sel.diffBody(lkey(FILE))),
          attr("展开键回到未展开态", sel.diffToggle(lkey(FILE)), "aria-expanded", "false"),
          visible("收起后编辑行本身仍在", sel.diffRow(lkey(FILE)))] }
    ]
  }),

  make({
    id: "C06", title: "同一文件连续修改", host: "RUN_SUMMARY", stateKind: "写入",
    component: runSummaryComponent,
    note: "行按调用身份逐条产生，后来的编辑不重写旧行；身份去重又保证一次结算不会被算两遍。",
    steps: frame("三轮同一文件的写入账本", {
      run: labRun(),
      runToolCalls: runProjection([
        [write(0, FILE, { fileChanges: [fileChange(FILE, "MODIFY", { added: 2, removed: 0 })] })],
        [write(1, FILE, { round: 1, fileChanges: [fileChange(FILE, "MODIFY", { added: 5, removed: 2 })] })],
        [write(2, FILE, { round: 2, fileChanges: [fileChange(FILE, "MODIFY", { added: 1, removed: 9 })] })]
      ], { runStatus: "COMPLETED" })
    }),
    checks: [
      visible("第一次编辑仍是一行", sel.diffRow(lkey(FILE, 0, 0))),
      visible("第二次编辑另起一行", sel.diffRow(lkey(FILE, 1, 1))),
      visible("第三次编辑再起一行", sel.diffRow(lkey(FILE, 2, 2))),
      count("总共三行而不是被合并成一行", ".local-file-diff", 3),
      text("第三次的数字自己说话", sel.diffRow(lkey(FILE, 2, 2)), "−9")
    ]
  }),

  make({
    id: "C02", title: "新增文件", host: "RUN_SUMMARY", stateKind: "写入",
    component: runSummaryComponent,
    steps: frame("账本给出 CREATE 与行数",
      writes([write(0, SECOND, {
        args: intent(SECOND, "CREATE"),
        fileChanges: [fileChange(SECOND, "CREATE", { added: 18, removed: 0 })]
      })])),
    checks: [
      text("动作文案是已新增", sel.diffRow(lkey(SECOND)), "已新增"),
      text("加数在场", sel.diffRow(lkey(SECOND)), "+18"),
      attr("相位是 applied", sel.diffRow(lkey(SECOND)), "data-phase", "applied")
    ]
  }),

  make({
    id: "C03", title: "删除文件", host: "RUN_SUMMARY", stateKind: "写入",
    component: runSummaryComponent,
    steps: frame("账本给出 DELETE 与移除行数",
      writes([write(0, SECOND, {
        args: intent(SECOND, "DELETE"),
        fileChanges: [fileChange(SECOND, "DELETE", { added: 0, removed: 27 })]
      })])),
    checks: [
      text("动作文案是已删除", sel.diffRow(lkey(SECOND)), "已删除"),
      text("减数在场", sel.diffRow(lkey(SECOND)), "−27")
    ]
  }),

  make({
    id: "C10", title: "文件写入失败", host: "RUN_SUMMARY", stateKind: "失败",
    component: runSummaryComponent,
    steps: frame("逐文件账本 status FAILED",
      writes([write(0, FILE, {
        resultRef: { reason: "WRITE_FAILED", detail: "目标文件被外部程序占用" },
        fileChanges: [fileChange(FILE, "MODIFY", { status: "FAILED", added: 0, removed: 0 })]
      })])),
    checks: [
      text("状态词是写入未成功", sel.diffRow(lkey(FILE)), "写入未成功"),
      attr("相位是 failed", sel.diffRow(lkey(FILE)), "data-phase", "failed"),
      count("失败不画加数", `${sel.diffRow(lkey(FILE))} [data-metric="added"]`, 0),
      count("失败不画减数", `${sel.diffRow(lkey(FILE))} [data-metric="removed"]`, 0),
      notText("失败绝不写成已修改", sel.diffRow(lkey(FILE)), "已修改")
    ]
  }),

  make({
    id: "X14", title: "基线冲突（CONFLICT）", host: "RUN_SUMMARY", stateKind: "失败",
    component: runSummaryComponent,
    note: "磁盘在冻结之后被别人改过：这是写入未成功的一种，界面上不出现任何行数。",
    steps: frame("逐文件账本 status CONFLICT + 原因码",
      writes([write(0, FILE, {
        fileChanges: [fileChange(FILE, "MODIFY", { status: "CONFLICT", added: -1, removed: -1,
          unavailableReason: "BASELINE_SHA_MISMATCH" })]
      })])),
    checks: [
      text("状态词是写入未成功", sel.diffRow(lkey(FILE)), "写入未成功"),
      text("原因逐字翻译", sel.diffReason(lkey(FILE)), "不可统计")
    ],
    interactions: [{
      kind: "click", selector: sel.diffToggle(lkey(FILE)), label: "展开这次编辑前后（正文读不到）",
      then: [visible("正文区已挂载", sel.diffBody(lkey(FILE))),
        text("只说明读不到", sel.diffBody(lkey(FILE)), "当前读不到"),
        gone("读不到就不显示任何前后正文", sel.frozenDiff())]
    }]
  }),

  make({
    id: "C12", title: "文件变更结果未知", host: "RUN_SUMMARY", stateKind: "未知",
    component: runSummaryComponent,
    steps: frame("逐文件账本 status UNKNOWN，数字未落",
      writes([write(0, FILE, {
        resultRef: { reason: "RESULT_UNVERIFIED", detail: "结算响应在写入完成前中断" },
        fileChanges: [fileChange(FILE, "MODIFY", { status: "UNKNOWN", added: -1, removed: -1 })]
      })])),
    checks: [
      text("状态词是结果待核对", sel.diffRow(lkey(FILE)), "结果待核对"),
      text("原因说明不宣布已修改", sel.diffReason(lkey(FILE)), "不宣布已修改"),
      // 反证只看状态词那一个节点：整行文案里那句「不宣布已修改」本身含「已修改」三字。
      notText("状态词不写成已修改", `${sel.diffRow(lkey(FILE))} .local-file-diff-state`, "已修改"),
      count("待核对不画加数", `${sel.diffRow(lkey(FILE))} [data-metric="added"]`, 0),
      count("待核对不画减数", `${sel.diffRow(lkey(FILE))} [data-metric="removed"]`, 0)
    ]
  }),

  make({
    id: "X15", title: "二进制内容：不可统计就不给行数", host: "RUN_SUMMARY", stateKind: "边界",
    component: runSummaryComponent,
    steps: frame("APPLIED 但原因码 BINARY",
      writes([write(0, PNG, {
        fileChanges: [fileChange(PNG, "CREATE", { added: 0, removed: 0, unavailableReason: "BINARY" })]
      })])),
    checks: [
      text("说明这是不可统计", sel.diffReason(lkey(PNG)), "二进制内容，不统计行数"),
      count("没有加数", `${sel.diffRow(lkey(PNG))} [data-metric="added"]`, 0),
      attr("相位落到待核对而不是已修改", sel.diffRow(lkey(PNG)), "data-phase", "pendingVerify")
    ]
  }),

  make({
    id: "X16", title: "账本给 -1（待核对）：绝不折算成 +0 −0", host: "RUN_SUMMARY",
    stateKind: "未知", component: runSummaryComponent,
    note: "`-1` 是「没数出来」，不是「零行改动」。画成 +0 −0 会被读成一次真实的空改动。",
    steps: frame("APPLIED 但两侧计数都是 -1",
      writes([write(0, FILE, { fileChanges: [fileChange(FILE, "MODIFY", { added: -1, removed: -1 })] })])),
    checks: [
      count("一个加数都不画", `${sel.diffRow(lkey(FILE))} [data-metric="added"]`, 0),
      count("一个减数都不画", `${sel.diffRow(lkey(FILE))} [data-metric="removed"]`, 0),
      notText("不出现 +0", sel.diffRow(lkey(FILE)), "+0"),
      notText("不出现 −0", sel.diffRow(lkey(FILE)), "−0"),
      text("状态词是结果待核对", sel.diffRow(lkey(FILE)), "结果待核对")
    ]
  }),

  make({
    id: "X17", title: "已结算但没有逐文件账本：不编文件行", host: "RUN_SUMMARY", stateKind: "未知",
    component: runSummaryComponent,
    steps: frame("SETTLED 写入调用，fileChanges 为空",
      writes([write(0, FILE, { args: {}, resultRef: { content: "已写入" } })])),
    checks: [
      gone("没有逐文件行", sel.diffList()),
      text("统计仍如实报写入次数", sel.summary(), "写入 1 次"),
      notText("没有账本就不宣布已修改", sel.summary(), "已修改")
    ]
  }),

  make({
    id: "C13", title: "Diff 展开与折叠", host: "RUN_SUMMARY", stateKind: "写入",
    component: runSummaryComponent,
    note: "冻结正文是**按需读取**的第二层：默认整块不挂载，展开才按原 operation_id 回源，"
      + "收起后连正文一起撤下——但编辑行本身与展开入口不能跟着消失。",
    steps: frame("一条已落盘的写入，正文尚未展开", writes([write(0, FILE, {
      fileChanges: [fileChange(FILE, "MODIFY", { added: 41, removed: 8 })]
    })], {
      frozenDiff: frozenDiff(FILE, BASE_TEXT, EDITED_TEXT),
      changeSets: changeSets("mock-op-1", FILE)
    })),
    checks: [
      visible("编辑行在场", sel.diffRow(lkey(FILE))),
      count("默认不挂载冻结正文", sel.frozenDiff(), 0),
      count("默认不挂载正文区", sel.diffBody(lkey(FILE)), 0),
      visible("展开入口在场", sel.diffToggle(lkey(FILE))),
      attr("入口标着未展开", sel.diffToggle(lkey(FILE)), "aria-expanded", "false"),
      text("入口文案是查看这次编辑前后", sel.diffToggle(lkey(FILE)), "查看这次编辑前后")
    ],
    interactions: [
      { kind: "click", selector: sel.diffToggle(lkey(FILE)), label: "展开这次编辑的前后文本",
        then: [visible("正文区已挂载", sel.diffBody(lkey(FILE))),
          visible("按同一动作身份读回冻结差异", sel.frozenDiff()),
          text("差异标题说明仅描述计划", sel.frozenDiff(), "仅描述计划，不代表文件已应用"),
          attr("展开态标记正确", sel.diffToggle(lkey(FILE)), "aria-expanded", "true"),
          text("编辑行不被展开动作改写", sel.diffRow(lkey(FILE)), "已修改")] },
      { kind: "click", selector: sel.diffToggle(lkey(FILE)), label: "再点一次收起前后文本",
        then: [gone("正文区随收起移除", sel.diffBody(lkey(FILE))),
          gone("冻结差异也整块撤下", sel.frozenDiff()),
          attr("展开键回到未展开态", sel.diffToggle(lkey(FILE)), "aria-expanded", "false"),
          visible("收起后编辑行本身仍在", sel.diffRow(lkey(FILE)))] }
    ]
  }),

  make({
    id: "X18", title: "差异文本不可用：保留摘要，不补造基线", host: "DIFF", stateKind: "未知",
    component: diffComponent,
    steps: frame("availability UNAVAILABLE（缺可信原文）", {
      frozenDiff: frozenDiff(FILE, "", "", { availability: "UNAVAILABLE",
        unavailableReason: "BASELINE_SHA_MISMATCH", beforeText: null, afterText: null }),
      changeSets: changeSets(MOCK.operationId, FILE, "CONFLICT")
    }),
    checks: [
      visible("差异面板在场", sel.frozenDiff()),
      text("直说文本差异不可用", sel.frozenDiff(), "文本差异不可用"),
      text("原因逐字翻译", sel.frozenDiff(), "文件内容与冻结基线摘要不一致"),
      text("明确不补造旧基线", sel.frozenDiff(), "不从当前磁盘补造旧基线"),
      count("没有正文就不画差异行", ".file-write-frozen-diff__line", 0),
      text("账本状态原样透出", sel.frozenDiff(), "账本 CONFLICT")
    ]
  }),

  /* ---------------- 矩阵补齐：C04 / C05 / C09 / C11 / C14 / C15 / C16 / C17 ---------------- */

  make({
    id: "C04", title: "修改多行代码", host: "DIFF", stateKind: "写入",
    component: diffComponent,
    note: "多行改动必须逐行对得上：28 行上下文 + 12 行删除 + 16 行新增，行号与标记各占一个单元格。"
      + "这一条把行数钉成确切值，因为对齐算法是纯函数，同一份原文永远得到同一份行。",
    steps: frame("冻结基线 vs 冻结目标：后 12 行改写、末 3 行删除、追加 4 行", {
      frozenDiff: frozenDiff(FILE, BASE_TEXT, EDITED_TEXT),
      changeSets: changeSets(MOCK.operationId, FILE, "APPLIED")
    }),
    checks: [
      visible("差异面板在场", sel.frozenDiff()),
      count("逐行对齐共 56 行", ".file-write-frozen-diff__line", 56),
      count("上下文行 28 行", ".file-write-frozen-diff__line--context", 28),
      count("增行 16 行", ".file-write-frozen-diff__line--add", 16),
      count("删行 12 行", ".file-write-frozen-diff__line--remove", 12),
      text("增行用 + 标记", ".file-write-frozen-diff__line--add [aria-label=\"差异标记\"]", "+"),
      text("删行用 − 标记", ".file-write-frozen-diff__line--remove [aria-label=\"差异标记\"]", "−"),
      text("新增内容原样可见", ".file-write-frozen-diff__line--add", "export const extra0 = true;"),
      text("改写前的内容仍在删行里", ".file-write-frozen-diff__line--remove", "export const v28 = 28;"),
      attr("差异表有可访问名（行号与标记各有单元格）", ".file-write-frozen-diff__lines",
        "aria-label", `${FILE} 冻结计划文本差异`),
      text("标题说明仅描述计划", sel.frozenDiff(), "仅描述计划，不代表文件已应用")
    ]
  }),

  make({
    id: "C05", title: "多文件修改", host: "RUN_SUMMARY", stateKind: "写入",
    component: runSummaryComponent,
    note: "一次调用改三个文件仍然是**一次写入**：行数按文件逐条列，统计按调用算一次，两处不互相换算。",
    steps: frame("一条 apply_changeset 结算，逐文件账本给三个文件", writes([write(0, FILE, {
      resultRef: commandResult("已写入 3 个文件", 0),
      fileChanges: [
        fileChange(FILE, "MODIFY", { added: 12, removed: 3 }),
        fileChange(SECOND, "CREATE", { added: 18, removed: 0 }),
        fileChange(PNG, "DELETE", { added: 0, removed: 27 })
      ]
    })], {
      frozenDiff: frozenDiff(FILE, BASE_TEXT, EDITED_TEXT),
      changeSets: changeSets("mock-op-1", FILE)
    })),
    checks: [
      count("三个文件三行", ".local-file-diff", 3),
      text("第一行是已修改", sel.diffRow(lkey(FILE)), "已修改"),
      text("第二行是已新增", sel.diffRow(lkey(SECOND)), "已新增"),
      text("第三行是已删除", sel.diffRow(lkey(PNG)), "已删除"),
      text("每行只报自己的数字", sel.diffRow(lkey(SECOND)), "+18"),
      count("三行都来自落盘账本而不是预览", ".local-file-diff[data-preview=\"false\"]", 3),
      text("统计按调用只算一次写入", sel.summary(), "写入 1 次"),
      count("文件名各自成列（不被路径合并）", ".local-file-diff-name, .local-file-diff-path", 3)
    ],
    interactions: toggleDiffRow(lkey(FILE))
  }),

  make({
    id: "C09", title: "写入完成但验证尚未进行", host: "RUN_SUMMARY", stateKind: "写入",
    component: runSummaryComponent,
    note: "这一轮没有任何检查调用：界面因此不报检查次数，也不给任何验证结论。"
      + "「已修改」之后没有下文，本身就是这一段要钉住的状态。",
    steps: frame("只有写入账本，本轮没有 run_check", writes([write(0, FILE, {
      resultRef: commandResult("已写入 1 个文件", 0),
      fileChanges: [fileChange(FILE, "MODIFY", { added: 12, removed: 3 })]
    })])),
    checks: [
      visible("编辑行在场", sel.diffRow(lkey(FILE))),
      text("行说已修改", sel.diffRow(lkey(FILE)), "已修改"),
      text("写入次数照常报", sel.summary(), "写入 1 次"),
      count("本轮没有任何命令活动行", "[data-testid^=\"execution-activity-\"]", 0),
      notText("没有检查就不报检查次数", sel.summary(), "检查"),
      notText("已修改不等于验证通过", sel.summary(), "验证通过"),
      notText("也不给失败结论", sel.summary(), "失败")
    ]
  }),

  make({
    id: "C11", title: "修改被拒绝", host: "RUN_SUMMARY", stateKind: "审批",
    component: runSummaryComponent,
    note: "被拒不产生局部文件行：那一侧既没有落盘事实也没有目标内容，画一行数字等于凭空加数。"
      + "拒绝的完整呈现（审批栏、原样原因、参数仍可读）在轨迹侧的 E16。",
    steps: frame("apply_changeset 被拒：只有意图，没有账本", writes([write(0, FILE, {
      status: "REJECTED", resultRef: { reason: "USER_DENIED", detail: "不允许改动受管目录" }
    })], {
      reviews: [approvalReview("mock-op-1", { status: "DECIDED", target: { decision: "DENY" } })]
    })),
    checks: [
      gone("被拒不产生局部文件行", sel.diffList()),
      count("一条编辑行都没有", ".local-file-diff", 0),
      gone("没有行就没有展开入口", sel.diffToggle(lkey(FILE))),
      text("统计把它算进失败或未执行", sel.summary(), "1 项失败或未执行"),
      notText("被拒不进写入次数", sel.summary(), "写入 1 次"),
      notText("被拒绝不写成已修改", sel.summary(), "已修改"),
      count("也不再挂着等待批准的入口", sel.summaryWaitingApproval(), 0)
    ]
  }),

  make({
    id: "C14", title: "大型 Diff", host: "DIFF", stateKind: "边界",
    component: diffComponent,
    note: "超过逐行对齐的上限就退回原文对照，并且**明说没有逐行标注**："
      + "把 400 行硬画成行表会让读者以为对齐是可靠的，那才是假的完整。",
    steps: frame("400 行基线 vs 400 行目标：超出对齐上限", {
      frozenDiff: frozenDiff(FILE, LARGE_TEXT, LARGE_TEXT.replace("n0 = 0;", "n0 = 1;")),
      changeSets: changeSets(MOCK.operationId, FILE, "APPLIED")
    }),
    checks: [
      visible("差异面板在场", sel.frozenDiff()),
      count("超出上限就不画逐行表", ".file-write-frozen-diff__line", 0),
      text("改说原文对照", sel.frozenDiff(), "文本较长，按原文对照展示，未逐行标注。"),
      count("按原文对照给出两块", ".file-write-frozen-diff__compare pre", 2),
      text("左侧标题是冻结基线", ".file-write-frozen-diff__compare", "冻结基线"),
      text("右侧标题是冻结目标", ".file-write-frozen-diff__compare", "冻结目标"),
      text("文件路径与账本状态照常给出", sel.frozenDiff(), "账本 APPLIED"),
      attr("整块仍然只说计划", sel.frozenDiff(), "data-testid", "file-write-frozen-diff")
    ]
  }),

  make({
    id: "C15", title: "文件编辑后运行测试", host: "RUN_SUMMARY", stateKind: "工具",
    component: runSummaryComponent,
    note: "同一轮里两件事各说各的：写入按逐文件账本说「已修改」，检查按自己的回执成行。"
      + "命令行的 stdout 在聊天区原本没有出口，这一条同时钉住它。",
    steps: frame("先写一个文件，再跑一次检查", writes([
      write(0, FILE, { resultRef: commandResult("已写入 1 个文件", 0),
        fileChanges: [fileChange(FILE, "MODIFY", { added: 12, removed: 3 })] }),
      runCall(1, { toolName: "run_check", args: { check_id: "test" },
        resultRef: commandResult("Test Suites: 1 passed\nTests: 42 passed", 0) })
    ], {}, { runStatus: "COMPLETED" })),
    checks: [
      visible("编辑行在场", sel.diffRow(lkey(FILE))),
      text("编辑行说已修改", sel.diffRow(lkey(FILE)), "已修改"),
      visible("检查另起一行", sel.summaryActivity(runCallId(1))),
      text("检查状态词是已结算", sel.summaryActivity(runCallId(1)), "已结算"),
      text("统计里两处各计一次", sel.summary(), "写入 1 次"),
      text("检查次数一并给出", sel.summary(), "检查 1 次"),
      count("命令行不被并进局部 diff", ".local-file-diff", 1)
    ],
    interactions: toggleSummaryRow(runCallId(1), [
      visible("回执正文逐字来自 result_ref", sel.detailResult(runCallId(1))),
      text("正文里能看到测试计数", sel.detailResult(runCallId(1)), "Tests: 42 passed"),
      text("退出码一并给出", sel.detailMeta(runCallId(1)), "退出码 0")])
  }),

  make({
    id: "C16", title: "验证通过（界面只说已结算 + 退出码 0）", host: "RUN_SUMMARY", stateKind: "终态",
    component: runSummaryComponent,
    note: "产品没有任何字段把「检查退出码 0」升级成「验证通过」，因此这里钉的是**不出现**："
      + "没有通过徽章、没有 PASS，只有已结算与退出码两个事实。",
    steps: frame("检查结算，退出码 0，回执没有失败记录", writes([
      write(0, FILE, { resultRef: commandResult("已写入 1 个文件", 0),
        fileChanges: [fileChange(FILE, "MODIFY", { added: 12, removed: 3 })] }),
      runCall(1, { toolName: "run_check", args: { check_id: "test" },
        resultRef: commandResult("Tests: 42 passed", 0) })
    ], {}, { runStatus: "COMPLETED" })),
    checks: [
      text("检查行只说已结算", sel.summaryActivity(runCallId(1)), "已结算"),
      count("退出码 0 不带来失败标记", `${sel.summaryActivity(runCallId(1))}[data-failed]`, 0),
      text("统计报检查次数", sel.summary(), "检查 1 次"),
      notText("统计里没有失败或未执行", sel.summary(), "1 项失败或未执行"),
      notText("界面不写验证通过", sel.summary(), "验证通过"),
      notText("也不写 PASS", sel.summary(), "PASS"),
      notText("已结算不等于成功", sel.summaryActivity(runCallId(1)), "成功")
    ],
    interactions: toggleSummaryRow(runCallId(1), [
      text("退出码如实给 0", sel.detailMeta(runCallId(1)), "退出码 0"),
      visible("回执正文可读", sel.detailResult(runCallId(1)))])
  }),

  make({
    id: "C17", title: "验证失败", host: "RUN_SUMMARY", stateKind: "失败",
    component: runSummaryComponent,
    note: "验证失败改写检查那一行，**不改写编辑那一行**：文件确实已落盘，"
      + "把两件事混成「写入未成功」会掩盖真实发生的改动。",
    steps: frame("写入已落盘，随后的检查退出码 1", writes([
      write(0, FILE, { resultRef: commandResult("已写入 1 个文件", 0),
        fileChanges: [fileChange(FILE, "MODIFY", { added: 12, removed: 3 })] }),
      runCall(1, { toolName: "run_check", args: { check_id: "test" },
        resultRef: commandResult("FAIL src/lib/order.ts\nTests: 3 failed, 39 passed", 1,
          { outcome: "FAILED" }) })
    ], {}, { runStatus: "COMPLETED" })),
    checks: [
      text("检查行说已结算但失败", sel.summaryActivity(runCallId(1)), "已结算但失败"),
      attr("失败标记落在检查行上", sel.summaryActivity(runCallId(1)), "data-failed", "true"),
      text("统计单列失败或未执行", sel.summary(), "1 项失败或未执行"),
      text("检查次数仍照常报", sel.summary(), "检查 1 次"),
      text("编辑行不受验证结果改写", sel.diffRow(lkey(FILE)), "已修改"),
      notText("验证失败不把编辑说成未成功", sel.diffRow(lkey(FILE)), "写入未成功"),
      notText("失败不被说成通过", sel.summaryActivity(runCallId(1)), "通过")
    ],
    interactions: toggleSummaryRow(runCallId(1), [
      visible("失败回执正文可读", sel.detailResult(runCallId(1))),
      text("正文里能看到确切的失败计数", sel.detailResult(runCallId(1)), "3 failed"),
      text("退出码一并给出", sel.detailMeta(runCallId(1)), "退出码 1")])
  })
];
