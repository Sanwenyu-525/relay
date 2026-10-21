/**
 * 当前聊天模型是否接受图片输入（HTTP §10.100）。
 *
 * 同一份判定有三个消费者：发送命令时的**闸门**（不接受就拒绝，VALIDATION_FAILED）、
 * 输入框的**提前说明**（`GET /model-port` 的 `image_input` 投影）、以及声明端点写入后的
 * 下一次读取。三处必须同源——否则会出现「界面说可以、发送被拒」或反过来。
 *
 * 规则只有四条，顺序不能换：
 * 1. 目录里有该模型条目 → 以目录的 `image_input` 为准（人的声明不能覆盖目录判定）。
 * 2. 目录里没有条目、但声明表里有该模型 → 用声明（2026-10-19，迁移 0121）。
 * 3. 目录与声明都没有、但运维用 `RELAY_MODEL_IMAGE_INPUT=true` 声明了当前连接 → 放行（兼容期）。
 * 4. 其余一律拒绝：未知不等于可用（fail-closed）。
 */

/** 判定结果。字符串形态直接用于 `/model-port` 的投影，避免界面再翻译一遍。 */
export type ChatImageInputState =
  /** 实例没有配置真实模型端口（Fake/Mock）：不存在「这个模型能不能读图」的问题。 */
  | 'NOT_CONFIGURED'
  /** 目录条目明确支持。 */
  | 'SUPPORTED'
  /** 目录里没有条目，但有人声明支持（声明表或环境变量）。 */
  | 'DECLARED'
  /** 明确不支持：目录说不能，或声明说不能。 */
  | 'MODEL_LACKS_IMAGE_INPUT'
  /** 目录里没有条目，也没有任何声明。 */
  | 'MODEL_NOT_IN_CATALOG';

/** 这次结论来自哪一层。界面用它区分「目录说可以」与「你声明的」。 */
export type ChatImageInputSource = 'CATALOG' | 'DECLARED' | 'ENV' | 'NONE';

export interface ChatImageInputDecision {
  readonly state: ChatImageInputState;
  readonly source: ChatImageInputSource;
}

export function decideChatImageInput(input: {
  readonly configured: boolean;
  /** 目录条目；`imageInput` 为 null 表示目录没有给出该能力。 */
  readonly catalogEntry?: { readonly imageInput: boolean | null } | undefined;
  /** 声明表里的记录（迁移 0121）。`undefined` 表示没有声明，不是「声明为不支持」。 */
  readonly declaration?: boolean | undefined;
  /** 环境变量 `RELAY_MODEL_IMAGE_INPUT`：兼容期只对当前配置的连接生效。 */
  readonly declared: boolean;
}): ChatImageInputDecision {
  if (!input.configured) return { state: 'NOT_CONFIGURED', source: 'NONE' };
  if (input.catalogEntry !== undefined) {
    return { state: input.catalogEntry.imageInput === true ? 'SUPPORTED' : 'MODEL_LACKS_IMAGE_INPUT',
      source: 'CATALOG' };
  }
  if (input.declaration !== undefined) {
    return { state: input.declaration ? 'DECLARED' : 'MODEL_LACKS_IMAGE_INPUT', source: 'DECLARED' };
  }
  if (input.declared) return { state: 'DECLARED', source: 'ENV' };
  return { state: 'MODEL_NOT_IN_CATALOG', source: 'NONE' };
}

/** 该状态是否允许发送图片。 */
export function chatImageInputAccepted(state: ChatImageInputState): boolean {
  return state === 'SUPPORTED' || state === 'DECLARED';
}

/** 拒绝时给用户的说明；放行状态返回 null。文案与闸门抛出的完全一致，界面直接复用。 */
export function chatImageInputRejection(state: ChatImageInputState): string | null {
  switch (state) {
    case 'MODEL_LACKS_IMAGE_INPUT':
      return '当前聊天模型不支持图片输入，不能发送图片附件。';
    case 'MODEL_NOT_IN_CATALOG':
      return '目录中没有当前聊天模型的条目，无法确认图片输入能力；请先同步模型目录、'
        + '或在服务端声明该模型接受图片输入（兼容期也可设置 RELAY_MODEL_IMAGE_INPUT=true），'
        + '或改发纯文本。';
    case 'NOT_CONFIGURED':
      return '当前服务实例没有配置真实模型端口，图片消息不会被接受；'
        + '请先配置模型连接，或改发纯文本。';
    default:
      return null;
  }
}
