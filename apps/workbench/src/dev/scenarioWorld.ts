import type {
  RelayAssistLivePreview, RelayAssistMessage, RelayAssistMessageRecall,
  RelayRunToolCallPreview, RelayRunToolCalls, RelaySessionToolCalls,
} from "../api/dtos/assist";
import type { RelayFileWriteChangeSet, RelayFileWriteFrozenDiff } from "../api/dtos/artifacts";
import type { RelayReview, RelayRun } from "../api/dtos/run";
import type { ReplySettling } from "../views/AssistView";

/**
 * AI 回复场景实验室的模拟世界（仅开发构建可用）。
 *
 * 这里只有**呈现事实**，没有业务写入：所有对象都是真实 API 的 DTO 形状，
 * 由真实组件消费，因此「场景长什么样」与「产品长什么样」是同一份类型定义。
 *
 * 三条边界：
 *   * 不入库、不调模型、不执行命令、不碰用户文件——数据从这里到组件即终止。
 *   * 状态词表沿用真实契约（`RelaySessionToolCallStatus` / `RelayToolCallStatus`），
 *     实验室不自造第四种状态，也不把 UNKNOWN 画成完成。
 *   * 会话账本没有结果正文，因此会话侧场景不给 `resultText`；需要 stdout / 退出码的
 *     场景一律走 Run 侧宿主。这条由 `tools.ts` 的宿主选择体现，不是注释里的承诺。
 */

/** 预览宿主：决定中间预览区挂载哪一组真实产品组件。 */
export type LabHost =
  /** AssistMessageRow（含 SessionRoundTrace / ActivityRow / SafeMarkdown） */
  | "SESSION"
  /** ExecutionTrajectorySummary（Run 侧摘要 + 局部文件增删行） */
  | "RUN_SUMMARY"
  /** RunToolTrajectoryPanel（Run 侧逐轮全量轨迹 + 事件流/轮询降级） */
  | "RUN_TRAJECTORY"
  /** 关联视图：同一轮的消息行与其 Run 执行摘要同时在场（产品里 AssistView 就是这么并排挂的） */
  | "LINK"
  /** FileWriteFrozenDiffPanel（冻结计划文本差异） */
  | "DIFF";

/** 实验室会按需抛错的读取出口（与真实 client 方法名一一对应）。 */
export type LabMethod =
  | "getAssistSessionToolCalls"
  | "getAssistMessageRecall"
  | "getRunToolCalls"
  | "getRunToolCallPreviews"
  | "getRunReviews"
  | "readRunEvents"
  | "getFileWriteFrozenDiff"
  | "getFileWriteChangeSets";

/** 注入的读取结果。`mismatch` 只用于带身份字段的投影（Run 轨迹）。 */
export type ScenarioFailure =
  | { readonly kind: "http"; readonly status: number; readonly code: string; readonly detail: string }
  | { readonly kind: "transport"; readonly message?: string }
  | { readonly kind: "empty" }
  | { readonly kind: "mismatch" };

export interface PreviewReadError {
  readonly message: string;
  readonly lastSuccessAt: string | null;
}

export interface ScenarioWorld {
  readonly host: LabHost;
  /** 会话侧消息行（用户 + 助手）。SESSION 宿主逐条渲染。 */
  readonly messages: readonly RelayAssistMessage[];
  /** 助手消息的实时预览（流式草稿）。 */
  readonly preview: RelayAssistLivePreview | null;
  readonly previewError: PreviewReadError | null;
  /** 草稿 → 正文的交接呈现态（真实产品里的同一种本机态，不新造状态）。 */
  readonly settling: ReplySettling | null;
  readonly handover: boolean;
  /** 会话轮次账本，按消息身份存放（会话侧没有结果正文这一列）。 */
  readonly traces: Readonly<Record<string, RelaySessionToolCalls>>;
  readonly run: RelayRun | null;
  readonly runToolCalls: RelayRunToolCalls | null;
  readonly runPreviews: readonly RelayRunToolCallPreview[];
  readonly reviews: readonly RelayReview[];
  readonly frozenDiff: RelayFileWriteFrozenDiff | null;
  readonly changeSets: readonly RelayFileWriteChangeSet[];
  readonly personaLabel: string | null;
  readonly writeBlocked: boolean;
  readonly recallReceipt: RelayAssistMessageRecall | null;
  readonly recallDisabledReason: string | null;
  /** 人工审批演示（只改模拟状态，不提交真实审批）。 */
  readonly approvalChoices: Readonly<Record<string, "APPROVE" | "REJECT">>;
  readonly fail: Readonly<Partial<Record<LabMethod, ScenarioFailure>>>;
  /** SSE 不可用：真实 hook 因此降级为按 revision 轮询，界面上「实时」标记消失。 */
  readonly streamDown: boolean;
}

export interface ScenarioStep {
  /** 1× 速度下的绝对时刻（毫秒）。确定性：不用随机网络延迟。 */
  readonly at: number;
  /** 事件说明，右侧「事件序列」逐条显示。 */
  readonly label: string;
  readonly set: (world: ScenarioWorld) => ScenarioWorld;
}

export interface ScenarioCheck {
  /** 人类可读的检查名，报告与界面同一份文案。 */
  readonly label: string;
  /** 稳定断言种类；见 `runChecks`。 */
  readonly kind:
    | "visible" | "visibleRow" | "gone" | "count" | "atLeast"
    | "text" | "notText" | "attr" | "noOverflow" | "motionCount" | "leftEdgeAligned"
    | "noDuplicateRows" | "scrollStable";
  readonly selector?: string;
  readonly equals?: number;
  readonly contains?: string;
  readonly name?: string;
  readonly value?: string;
}

/**
 * 交互检查：先执行一个真实动作，再跑一组断言。
 *
 * 「点击展开之后入口还在不在」「上滚之后位置稳不稳」这类问题只能靠真实交互回答，
 * 静态断言答不了。因此它们与静态检查一样是数据，界面运行器与 Playwright 跑同一份。
 */
export type ScenarioInteraction =
  | { readonly kind: "click"; readonly selector: string; readonly label: string;
      readonly then: readonly ScenarioCheck[] }
  | { readonly kind: "scrollUp"; readonly label: string; readonly then: readonly ScenarioCheck[] }
  /** 先就地看一眼：不推进、不点击，只在当前帧跑这一组断言。 */
  | { readonly kind: "inspect"; readonly label: string; readonly then: readonly ScenarioCheck[] }
  | { readonly kind: "advance"; readonly label: string; readonly then: readonly ScenarioCheck[] };

/** 场景需要的呈现条件：打开该场景时由控制器自动施加，离开时还原。 */
export interface ScenarioConditions {
  readonly viewport?: "narrow" | "phone" | "wide";
  /** 两档都要写出来：外壳上的 `data-motion` 记录的是「这一档生效了」，不是「有个开关」。 */
  readonly motion?: "on" | "off";
  readonly theme?: "light" | "dark";
  readonly density?: "concise" | "standard" | "detailed";
  readonly devicePixelRatio?: number;
}

/** 场景状态类型（目录第三列）：一句话说明这条在验哪一种状态。 */
export type ScenarioStateKind =
  | "在途" | "流式" | "终态" | "工具" | "写入" | "审批" | "失败" | "未知"
  | "取消" | "恢复" | "边界" | "呈现";

/** 验收状态（目录第四列）：实验室自己跑出来的结果，不代表业务验收账本。 */
export type ScenarioAcceptance = "unchecked" | "pass" | "fail" | "not-covered";

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly host: LabHost;
  readonly stateKind: ScenarioStateKind;
  /** 这条场景实际验哪一个组件出口；报告里的「组件位置」。 */
  readonly component: string;
  readonly note?: string;
  /** 无法覆盖时写明原因，目录与报告都直接显示，不改判成通过。 */
  readonly uncovered?: string;
  /**
   * 事件序列。**静态 `checks` 固定在最后一帧上跑**，`interactions` 则从第 0 帧重放后再执行动作，
   * `advance` 交互自己负责推进到下一帧，`inspect` 停在当前帧只看不推。
   * 多帧场景因此不能把「中途才成立的事实」写成静态检查。
   */
  readonly steps: readonly ScenarioStep[];
  readonly checks: readonly ScenarioCheck[];
  readonly interactions?: readonly ScenarioInteraction[];
  readonly conditions?: ScenarioConditions;
}

export const CATEGORY_META = {
  A: { title: "AI 回复生命周期", detail: "提交、处理中、流式、交接、终态与失败" },
  B: { title: "工具调用", detail: "读取、检索、命令、桌面、浏览器、MCP 与未知工具" },
  C: { title: "文件编辑与验证", detail: "预览、落盘、审批、失败、未知与差异" },
  D: { title: "执行状态", detail: "真实状态词表的七档与整轮/整 Run 结算" },
  E: { title: "异常与恢复", detail: "读取失败、中断、乱序、迟到、身份不符与重读" },
  F: { title: "长任务与边界", detail: "规模、超长内容、滚动、刷新、窗口与动效" },
  G: { title: "组合流程", detail: "完整可播放的事件序列" },
  /** 矩阵之外的补充场景：同一批组件的其它真实分支，不参与 108 条矩阵的完整性判定。 */
  X: { title: "补充场景", detail: "矩阵未列出、但产品里确实存在且值得钉住的分支" }
} as const;

export type ScenarioCategory = keyof typeof CATEGORY_META;

/** 场景目录按类别分组后的展示单元。 */
export interface ScenarioGroup {
  readonly category: ScenarioCategory;
  readonly scenarios: readonly Scenario[];
}

/** 空白世界：每条场景从这一步开始，之后的 step 只做必要改动。 */
export function emptyWorld(host: LabHost): ScenarioWorld {
  return {
    host,
    messages: [],
    preview: null,
    previewError: null,
    settling: null,
    handover: false,
    traces: {},
    run: null,
    runToolCalls: null,
    runPreviews: [],
    reviews: [],
    frozenDiff: null,
    changeSets: [],
    personaLabel: null,
    writeBlocked: false,
    recallReceipt: null,
    recallDisabledReason: null,
    approvalChoices: {},
    fail: {},
    streamDown: false
  };
}

/** step 的简写：`step(1200, "读取 package.json", w => ({ ...w, trace: … }))`。 */
export function step(at: number, label: string, set: (world: ScenarioWorld) => ScenarioWorld): ScenarioStep {
  return { at, label, set };
}

export function scenario(input: Scenario): Scenario {
  return input;
}

/**
 * 场景回放器：从空白世界起，**按索引纯重放** steps。
 *
 * 纯重放（而不是累积可变状态）保证：单步、跳转、循环、重置得到完全相同的界面，
 * 反复跑第 37 次与第 1 次没有差别——这是「验收可复现」的前提。
 */
export class ScenarioRunner {
  readonly scenario: Scenario;
  private worldValue: ScenarioWorld;
  private indexValue = 0;
  private seqValue = 0;
  private readonly listeners = new Set<() => void>();

  constructor(scenario: Scenario) {
    this.scenario = scenario;
    this.worldValue = emptyWorld(scenario.host);
    this.apply(0);
  }

  get world(): ScenarioWorld { return this.worldValue; }

  get index(): number { return this.indexValue; }

  /** 每次状态推进自增；fake client 用它判断是否需要重新供给数据。 */
  get seq(): number { return this.seqValue; }

  get steps(): readonly ScenarioStep[] { return this.scenario.steps; }

  get totalMs(): number { return this.scenario.steps.at(-1)?.at ?? 0; }

  /** 虚拟时刻对应的最后一帧索引；播放时钟只算时间，不猜网络。 */
  indexAt(timeMs: number): number {
    let found = 0;
    for (let index = 0; index < this.scenario.steps.length; index += 1) {
      if (this.scenario.steps[index].at <= timeMs) found = index;
      else break;
    }
    return found;
  }

  seek(index: number): void {
    const clamped = Math.max(0, Math.min(this.scenario.steps.length - 1, index));
    if (clamped === this.indexValue && this.seqValue > 0) return;
    this.apply(clamped);
  }

  next(): void { this.seek(this.indexValue + 1); }

  prev(): void { this.seek(this.indexValue - 1); }

  reset(): void {
    this.indexValue = 0;
    this.apply(0);
  }

  /** 等待下一次状态推进（fake client 的长轮询出口）。 */
  wait(afterSeq: number, maxMs: number): Promise<void> {
    if (this.seqValue > afterSeq) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        window.clearTimeout(timer);
        this.listeners.delete(onChange);
        resolve();
      };
      const timer = window.setTimeout(finish, maxMs);
      const onChange = () => { if (this.seqValue > afterSeq) finish(); };
      this.listeners.add(onChange);
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private apply(index: number): void {
    let world = emptyWorld(this.scenario.host);
    for (let position = 0; position <= index; position += 1) {
      world = this.scenario.steps[position].set(world);
    }
    this.indexValue = index;
    this.worldValue = world;
    this.seqValue += 1;
    for (const listener of [...this.listeners]) listener();
  }
}
