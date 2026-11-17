import type { RelayCompactionTrigger, RelayContextCompaction,
  RelayContextUsageBreakdown, RelayContextUsageCall, RelayContextUsageCategory,
  RelaySessionContextUsage } from "../api/dtos/assist";

/**
 * 上下文用量面板的统一视图模型（2026-11-15 浮层重排）。
 *
 * 面板里的每一个派生数——占比、剩余、状态、分项份额、公式链——都只在这里算一次，
 * 组件只负责把这份快照画出来。三个「总量」在此显式分口径，不再混排：
 *   · `current.tokens`——会话级当前读数（Provider 真实基线 + 增量估算，或整份估算），
 *     核心区的分子，进度条分母是**实际生效压缩阈值**；
 *   · `window.used`——最近一次真实调用的 Provider 实报输入，窗口使用情况的分子，
 *     分母是**当前模型可用窗口**（与输入区圆环同一口径）；
 *   · `breakdown.estimatedTotal`——分项估算合计（请求文本字节 ÷ 3），与上面两者
 *     口径不同，不相加、不相等，界面必须把差额说成口径差异而不是丢项。
 * 三个口径各答一个问题：现在装了多少 / 那次调用占多大窗口 / 内容由什么组成。
 */

/** 分类的界面顺序；同一份数据两次打开时同一项在同一个位置，读数才可比。 */
export const CONTEXT_USAGE_CATEGORY_ORDER: readonly RelayContextUsageCategory[] =
  ["HISTORY", "SYSTEM", "TOOLS", "FILE_READS", "MEMORY", "OTHER"];

/** 分类名与口径说明。说明只描述服务端的真实归类规则（assist-context-usage.ts）。 */
export const CONTEXT_USAGE_CATEGORY_META: Readonly<Record<RelayContextUsageCategory,
  { readonly label: string; readonly description: string }>> = {
  HISTORY: { label: "历史消息", description: "对话双方的消息正文，以及会话中途插入的插话。" },
  SYSTEM: { label: "系统 / 指令",
    description: "系统提示词与指令：运行模式模板、能力事实块、插话规则与在途执行说明。" },
  TOOLS: { label: "工具调用",
    description: "工具规格声明、模型发出的调用参数、工具轮次的前置说明与推理内容。" },
  FILE_READS: { label: "文件读取",
    description: "文件类只读工具（文件查询 / 读取、Git 只读）返回的结果；与工具调用按工具能力二选一，同一段内容不会两边都算。" },
  MEMORY: { label: "记忆 / 资料",
    description: "装配方登记的注入段：压缩摘要、Skill 输入与依据、资料正文。" },
  OTHER: { label: "其他上下文",
    description: "确实发送给模型但不属于上述类别的内容（收尾指令、方法输入块等）。" },
};

/**
 * 窗口来源的界面说法。「自动识别」只给模型目录 / 能力声明；部署配置是运维显式声明；
 * 未知一律说未知，不因为回退值是 256K 就写成「自动识别为 256K」。
 */
export const WINDOW_SOURCE_LABELS: Readonly<Record<
  RelayContextCompaction["windowSource"], string>> = {
  MODEL_CATALOG: "自动识别 · 模型目录",
  CAPABILITY_DECLARATION: "高级能力声明",
  MODEL_CONFIG: "部署配置",
  UNKNOWN_FALLBACK: "未知 · 安全回退",
};

/** 压缩为什么发生 / 最近一次的终态（CONTEXT-COMPACTION-0162）。 */
export const COMPACTION_TRIGGER_LABELS: Readonly<Record<RelayCompactionTrigger, string>> = {
  MANUAL: "手动压缩",
  THRESHOLD: "达到阈值",
  OVERFLOW: "溢出保护",
};

/** 接近阈值的判定线：与圆环的高位阈值一致（生效阈值的 80%）。 */
export const CONTEXT_NEAR_THRESHOLD_RATIO = 0.8;

/** 顶部状态条的五种状态。正常用中性色；只有警告用黄橙、错误用红。 */
export type ContextUsageStatusKey = "NORMAL" | "NEAR_THRESHOLD" | "AT_THRESHOLD"
  | "COMPACTING" | "LAST_FAILED" | "DISABLED";
export type ContextUsageStatusTone = "neutral" | "warning" | "danger" | "running";

export interface ContextUsageStatus {
  readonly key: ContextUsageStatusKey;
  readonly label: string;
  readonly tone: ContextUsageStatusTone;
}

/** 面板引用的"最近一次记录"：一次真实调用，或（旧数据）一条消息上的用量。 */
export interface ContextUsageLastCall {
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheCreation: number | null;
  /** 缓存命中率读数；两个读数都可靠且读取量不超过输入时才有。 */
  readonly hitRateLabel: string | null;
  /** 那次调用冻结的单次预算；与当前可用窗口不同时面板要说明差异。 */
  readonly frozen: number | null;
  readonly settledAt: string | null;
}

export interface ContextUsageBreakdownEntry {
  readonly key: RelayContextUsageCategory;
  readonly tokens: number;
  /** 占估算合计的比例；合计为 0 时为 null（不显示 0% 冒充有分母）。 */
  readonly share: number | null;
}

export interface ContextUsageViewModel {
  readonly status: ContextUsageStatus;
  /** 这份读数在服务端生成的时间（ISO）；面板显示为「最近更新时间」。 */
  readonly measuredAt: string | null;
  /** 核心区：当前上下文 vs 实际生效阈值（进度条分母就是它，不是窗口）。 */
  readonly current: {
    readonly tokens: number;
    readonly threshold: number;
    readonly ratio: number;
    readonly percentLabel: string;
    /** 距离自动压缩还有多少 tokens；已超过时为负。 */
    readonly remaining: number;
    readonly source: "PROVIDER_USAGE" | "ESTIMATED";
  };
  /** 窗口区：最近一次调用相对当前模型可用窗口；尚无真实调用时为 null。 */
  readonly window: {
    readonly used: number;
    readonly effectiveWindow: number;
    readonly ratio: number;
    readonly percentLabel: string;
  } | null;
  readonly lastCall: ContextUsageLastCall | null;
  readonly compaction: {
    readonly enabled: boolean;
    /** 用户保存的阈值；null = 使用产品默认。 */
    readonly saved: number | null;
    readonly requested: number;
    readonly effective: number;
    readonly clamped: boolean;
    readonly usingDefault: boolean;
    readonly defaultThreshold: number;
    readonly recommendedMin: number;
    readonly recommendedMax: number;
    readonly postTarget: number;
    /**
     * 容量口径（会话级属性，与「最近一次调用」无关）：可用窗口、模型真实窗口、
     * 服务商单次上限与窗口来源。窗口/来源放这里而不是 `window`，因为没有调用
     * 时容量依然存在，高级容量区也依然要展示。
     */
    readonly effectiveWindow: number;
    readonly modelWindow: number | null;
    readonly windowSource: RelayContextCompaction["windowSource"];
    readonly providerCallCap: number | null;
    /** 生成阈值公式的全部中间量：生效阈值 = min(用户阈值, 安全输入 × 90%)。 */
    readonly reserves: {
      readonly output: number;
      readonly protocol: number;
      readonly safety: number;
      readonly safeInput: number;
    };
    readonly active: RelayContextCompaction["active"];
    readonly lastResult: RelayContextCompaction["lastResult"];
  };
  /** 上下文构成；没有分项统计（旧数据或非对话调用）时为 null。 */
  readonly breakdown: {
    readonly entries: readonly ContextUsageBreakdownEntry[];
    readonly estimatedTotal: number;
    /** Provider 实报输入（最近一次调用）；用于双口径差额说明。 */
    readonly providerInput: number | null;
    readonly imageParts: number;
  } | null;
}

/**
 * 由服务端投影派生整份视图快照。`usage === null`（还没读到 / 读取失败）返回 null，
 * 由面板自己决定 loading / 错误 / 无会话三种空态。
 */
export function buildContextUsageViewModel(usage: RelaySessionContextUsage | null):
ContextUsageViewModel | null {
  if (usage === null) return null;
  const compaction = usage.compaction;
  const threshold = compaction.effectiveThresholdTokens;
  const tokens = compaction.contextTokens;
  const ratio = threshold > 0 ? tokens / threshold : 0;
  const lastCall = usage.lastCall;
  const windowUsed = lastCall?.inputTokens ?? null;
  const window = windowUsed !== null
    ? {
      used: windowUsed,
      effectiveWindow: compaction.effectiveWindowTokens,
      ratio: compaction.effectiveWindowTokens > 0
        ? windowUsed / compaction.effectiveWindowTokens : 0,
      percentLabel: formatRatioPercent(compaction.effectiveWindowTokens > 0
        ? windowUsed / compaction.effectiveWindowTokens : 0),
    }
    : null;
  return {
    status: contextUsageStatus(compaction),
    measuredAt: compaction.measuredAt,
    current: {
      tokens,
      threshold,
      ratio,
      percentLabel: formatRatioPercent(ratio),
      remaining: compaction.distanceTokens,
      source: compaction.contextSource,
    },
    window,
    lastCall: lastCall === null ? null : {
      output: lastCall.outputTokens,
      cacheRead: lastCall.cacheReadTokens,
      cacheCreation: lastCall.cacheCreationTokens,
      hitRateLabel: cacheHitRateLabel(lastCall),
      frozen: lastCall.reservedTokens,
      settledAt: lastCall.settledAt,
    },
    compaction: {
      enabled: compaction.enabled,
      saved: compaction.thresholdTokens,
      requested: compaction.requestedThresholdTokens,
      effective: threshold,
      clamped: compaction.thresholdClamped,
      usingDefault: compaction.thresholdTokens === null,
      defaultThreshold: compaction.defaultThresholdTokens,
      recommendedMin: compaction.recommended.min,
      recommendedMax: compaction.recommended.max,
      postTarget: compaction.postCompactionTargetTokens,
      effectiveWindow: compaction.effectiveWindowTokens,
      modelWindow: compaction.modelWindowTokens,
      windowSource: compaction.windowSource,
      providerCallCap: compaction.providerCallCapTokens,
      reserves: {
        output: compaction.outputReserveTokens,
        protocol: compaction.protocolOverheadTokens,
        safety: compaction.safetyReserveTokens,
        safeInput: compaction.safeInputTokens,
      },
      active: compaction.active,
      lastResult: compaction.lastResult,
    },
    breakdown: contextBreakdown(lastCall?.breakdown ?? null,
      lastCall?.inputTokens ?? null),
  };
}

/**
 * 顶部状态判定。优先级：压缩中 > 最近失败 > 已关闭 > 已达阈值 > 接近阈值 > 正常。
 * 「已关闭」压过「已达阈值」：阈值不会触发整理，把它标成警告会让读者以为马上要压。
 */
export function contextUsageStatus(compaction: RelayContextCompaction): ContextUsageStatus {
  if (compaction.active !== null) {
    return { key: "COMPACTING", label: "正在压缩", tone: "running" };
  }
  if (compaction.lastResult?.status === "FAILED") {
    return { key: "LAST_FAILED", label: "压缩失败", tone: "danger" };
  }
  if (!compaction.enabled) {
    return { key: "DISABLED", label: "自动压缩已关闭", tone: "neutral" };
  }
  if (compaction.distanceTokens <= 0) {
    return { key: "AT_THRESHOLD", label: "已达压缩阈值", tone: "warning" };
  }
  if (compaction.effectiveThresholdTokens > 0 &&
      compaction.contextTokens >=
        compaction.effectiveThresholdTokens * CONTEXT_NEAR_THRESHOLD_RATIO) {
    return { key: "NEAR_THRESHOLD", label: "接近压缩阈值", tone: "warning" };
  }
  return { key: "NORMAL", label: "正常", tone: "neutral" };
}

/**
 * 分项构成：固定顺序、零值不显示、份额以估算合计为分母。
 * 分项与 Provider 实报本来就不是一个口径（估算按请求文本字节 ÷ 3），
 * 差额交给界面的双口径说明，不在这里强行凑平。
 */
function contextBreakdown(breakdown: RelayContextUsageBreakdown | null,
  providerInput: number | null): ContextUsageViewModel["breakdown"] {
  if (breakdown === null) return null;
  const byKey = new Map(breakdown.categories.map((entry) => [entry.key, entry]));
  const total = breakdown.estimatedTotalTokens;
  return {
    entries: CONTEXT_USAGE_CATEGORY_ORDER.flatMap((key) => {
      const entry = byKey.get(key);
      if (entry === undefined || entry.tokens <= 0) return [];
      return [{ key, tokens: entry.tokens, share: total > 0 ? entry.tokens / total : null }];
    }),
    estimatedTotal: total,
    providerInput,
    imageParts: breakdown.imageParts,
  };
}

/** 命中率只在两个读数都可靠、且读取量不超过输入量时才有分母。 */
function cacheHitRateLabel(call: RelayContextUsageCall): string | null {
  const input = call.inputTokens;
  const cacheRead = call.cacheReadTokens;
  if (input === null || cacheRead === null || input <= 0 || cacheRead > input) return null;
  return formatSharePercent(cacheRead / input);
}

/**
 * 比例读数：未满但会进位成 100% 时保留小数，够了就是 100%，超出后给出真实比例
 * （`100.0` 也保留，免得把刚超出的读数说回 100%）。与圆环共用同一套读法。
 */
export function formatRatioPercent(ratio: number): string {
  const rounded = Math.round(ratio * 100);
  if (ratio < 1) {
    if (rounded < 100) return String(rounded);
    const tenths = Math.floor(ratio * 1000) / 10;
    return tenths >= 100 ? "99.9" : tenths.toFixed(1);
  }
  if (ratio === 1) return "100";
  const tenths = Math.round(ratio * 1000) / 10;
  if (tenths === 100) return "100.0";
  return Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
}

/** 份额读数（缓存命中率、分项占比）：以 1 为分母的比例，超出钳到 100%。 */
export function formatSharePercent(ratio: number): string {
  if (ratio >= 1) return "100";
  const whole = Math.round(ratio * 100);
  if (whole < 100) return String(whole);
  return (Math.floor(ratio * 1000) / 10).toFixed(1);
}
