import { Compass, Target } from "lucide-react";

import type { RelayChatMode, RelayGoalStatus } from "../api/relayClient";

/**
 * 聊天模式状态徽标（工作台 §44.1、0127；2026-10-22 DEV-0105 收口）。
 *
 * 与「会话身份」那个下拉（普通 Agent / 人设助手 / 学习）是两件事：
 *   * 身份在建会话时冻结，切身份等于换一条会话；
 *   * 模式只是这段对话接下来怎么处理，可随时切换，不改变身份与权限。
 *
 * 模式不再做成输入器里的下拉框（2026-10-22 用户指认）：`/plan`、`/goal` 已经在「+ → 命令」
 * 里，命令本身会把模式与正文一次提交；再摆一个三档下拉，等于把同一入口摊成两种控件，
 * 还把「当前是哪一档」和「可以切成哪几档」混在一起。现在卡里只表达**当前事实**：
 *   * 普通模式不渲染任何东西——默认态不占位，输入卡保持原样；
 *   * 计划/目标模式显示一枚只读徽标，右侧「退出」回到普通模式；
 *   * 进入模式走「+ → 命令」或直接输入 `/plan 内容`、`/goal 内容`。
 *
 * 退出仍是命令：值只来自服务端读回的 `chat_mode`，回执到达后才重读投影，
 * 本地不在请求前抢先改显示。在途（生成或命令未结算）时退出键禁用，原因放 `title`。
 */
const LABELS: Record<RelayChatMode, string> = {
  CHAT: "讨论",
  PLAN: "计划",
  GOAL: "目标",
};

export default function ChatModeSwitch({ mode, disabled, busy, lockedReason, onChange }: {
  mode: RelayChatMode;
  disabled: boolean;
  /** 命令在途：禁用控件但不是禁用语义，避免看起来「不能用」。 */
  busy: boolean;
  /** 不能切换的具体原因（例如活动目标正在安全停止）；只放 title，不占一行。 */
  lockedReason: string | null;
  onChange: (next: RelayChatMode) => void;
}) {
  if (mode === "CHAT") return null;
  const label = LABELS[mode];
  const blocked = disabled || busy;
  const hint = lockedReason ?? (mode === "GOAL"
    ? "当前为目标模式；退出会先安全暂停在途目标，回到讨论模式。"
    : "当前为计划模式；退出后回到讨论模式。");
  return <div className="agent-chat-mode agent-chat-chat-mode" data-testid="chat-mode-badge"
    data-mode={mode} title={hint}>
    <span className="agent-chat-mode-state">
      {mode === "GOAL"
        ? <Target aria-hidden="true" />
        : <Compass aria-hidden="true" />}
      {label}模式
    </span>
    <button className="agent-chat-mode-exit" type="button" data-testid="chat-mode-exit"
      disabled={blocked} title={blocked ? hint : `退出${label}模式，回到讨论`}
      aria-label={`退出${label}模式，回到讨论`}
      onClick={() => onChange("CHAT")}>退出</button>
  </div>;
}

export function chatModeLabel(mode: RelayChatMode): string {
  return LABELS[mode];
}

/**
 * 模式说明行（卡外，和档位说明同一列）。
 *
 * 只说「这个模式会怎样」，不重复权限：计划模式的只读由工具准入保证，
 * 这里写一句是让人知道为什么模型不动文件。
 *
 * 停止中的目标按服务端目标状态投影（DEV-0105 退回项修复，2026-10-24）：`goalStatus`
 * 是 `PAUSING`/`CANCELLING` 时说明「正在安全停止」，不按会话模式宣称停下后进入哪一档——
 * 服务端切走 GOAL 时会话模式立即落 CHAT/PLAN、目标才慢慢停下，此前按模式写
 * 「停下后才会进入计划模式」在退出到普通模式时是错的。文案只说目标事实
 * （暂停可恢复／取消不推进），当前在哪一档由徽标承担。
 */
export function ChatModeHint({ mode, goalStatus }: {
  mode: RelayChatMode; goalStatus: RelayGoalStatus | null;
}) {
  if (goalStatus === "PAUSING") {
    return <p className="helper-text" data-testid="chat-mode-hint">
      目标正在安全停止在途行动，停下后目标进入暂停，可从目标卡恢复。</p>;
  }
  if (goalStatus === "CANCELLING") {
    return <p className="helper-text" data-testid="chat-mode-hint">
      目标正在取消，等在途行动安全停下后目标终止，不再推进。</p>;
  }
  if (mode === "PLAN") {
    return <p className="helper-text" data-testid="chat-mode-hint">
      计划模式：只调查、读取与比较方案，不改项目；形成计划后可以按某一版执行。</p>;
  }
  if (mode === "GOAL") {
    return <p className="helper-text" data-testid="chat-mode-hint">
      目标模式：说明目标后会持续推进，直到完成、你暂停或需要你决定。</p>;
  }
  return null;
}
