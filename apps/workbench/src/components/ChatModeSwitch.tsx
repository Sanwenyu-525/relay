import { ChevronDown } from "lucide-react";

import type { RelayChatMode } from "../api/relayClient";

/**
 * 聊天模式选择（工作台 §44.1、0127）。
 *
 * 与「会话身份」那个下拉（普通 Agent / 人设助手 / 学习）是两件事：
 *   * 身份在建会话时冻结，切身份等于换一条会话；
 *   * 模式只是这段对话接下来怎么处理，可随时切换，不改变身份与权限。
 *
 * 因此这里只渲染一枚原生 select：模式只有「当前是哪一档」这一个事实，
 * 不需要把三个候选一直摊在脸上；长说明一律不放进来（见 ConversationModeSwitch 文件头
 * 关于 `.agent-chat-mode` 自动宽容器的记录——那一课对这里同样成立）。
 *
 * select 只是**提交入口**：值来自服务端读回的 `chat_mode`，用户改选才发命令。
 * 本地不保存运行状态，也不在回执到达前抢先显示新模式。
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
  return <label className="agent-chat-mode-select-field agent-chat-chat-mode">
    <span className="visually-hidden">聊天模式</span>
    <select className="agent-chat-mode-select" data-testid="chat-mode-select"
      value={mode} disabled={disabled || busy}
      title={lockedReason ?? "聊天模式：讨论 / 计划（只读规划）/ 目标（持续执行）。"
        + "切换模式本身不会开始执行。"}
      onChange={(event) => onChange(event.target.value as RelayChatMode)}>
      <option value="CHAT">{LABELS.CHAT}</option>
      <option value="PLAN">{LABELS.PLAN}</option>
      <option value="GOAL">{LABELS.GOAL}</option>
    </select>
    <ChevronDown aria-hidden="true" className="agent-chat-chip-chevron" />
  </label>;
}

export function chatModeLabel(mode: RelayChatMode): string {
  return LABELS[mode];
}

/**
 * 模式说明行（卡外，和档位说明同一列）。
 *
 * 只说「这个模式会怎样」，不重复权限：计划模式的只读由工具准入保证，
 * 这里写一句是让人知道为什么模型不动文件。
 */
export function ChatModeHint({ mode, goalStopping }: {
  mode: RelayChatMode; goalStopping: boolean;
}) {
  if (goalStopping) {
    return <p className="helper-text" data-testid="chat-mode-hint">
      正在安全停止在途行动，停下后才会进入计划模式。</p>;
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
