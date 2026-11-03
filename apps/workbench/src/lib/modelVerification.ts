import type { RelayModelPortStatus, RelayModelVerificationState,
  RelayModelVerifyErrorCategory, RelayVerifyTargetState } from "../api/relayClient";

/** 验证错误分类的中文短名；原枚举保留在 chip 的 title 供核对。 */
export const verifyErrorCategoryLabels: Record<RelayModelVerifyErrorCategory, string> = {
  AUTH: "认证失败",
  RATE_LIMIT: "限流",
  TIMEOUT: "超时",
  STREAM_BROKEN: "流中断",
  PROTOCOL: "协议或模型无效",
  NETWORK: "网络不可达"
};

/**
 * 模型验证态：互斥，各自回答不同问题，绝不互相冒充。
 *
 * P1-6：服务端给出目标级 13 态时以它为准（`verification.state`），前端不再用
 * 「last + matches」猜——目录过期、资格失效、账户冷却期间上一行是 ok 也不显示「验证通过」。
 * 旧服务端没有 `state` 时退回原推导，不谎报。
 */
export type ModelVerificationStateKind =
  | "UNCONFIGURED"       // 未配置
  | "CONFIG_INCOMPLETE"  // 配置残缺
  | "UNVERIFIED"         // 已配置未验证
  | "VERIFYING"          // 验证中
  | "VERIFIED"           // 验证通过
  | "VERIFY_FAILED"      // 验证失败（未分类）
  | "AUTH_FAILED"        // 认证/权限失败
  | "MODEL_NOT_FOUND"    // 型号不存在
  | "CREDENTIAL_CHANGED" // 换过 Key，旧结论失效
  | "CATALOG_STALE"      // 目录过期，资格无法确认
  | "NOT_ELIGIBLE"       // 不在免费目录 / 能力不足
  | "ACCOUNT_COOLDOWN"   // 账户级限流冷却中
  | "BUDGET_EXHAUSTED"   // 调用预算不足
  | "UNAVAILABLE";       // 当前不可用

export const serverStateToKind: Record<RelayVerifyTargetState, ModelVerificationStateKind> = {
  NOT_CONFIGURED: "UNCONFIGURED",
  CONFIG_INCOMPLETE: "CONFIG_INCOMPLETE",
  UNVERIFIED: "UNVERIFIED",
  VERIFIED: "VERIFIED",
  CREDENTIAL_CHANGED: "CREDENTIAL_CHANGED",
  AUTH_FAILED: "AUTH_FAILED",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  CATALOG_STALE: "CATALOG_STALE",
  CAPABILITY_INSUFFICIENT: "NOT_ELIGIBLE",
  FREE_INELIGIBLE: "NOT_ELIGIBLE",
  ACCOUNT_COOLDOWN: "ACCOUNT_COOLDOWN",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  UNKNOWN: "VERIFY_FAILED"
};

export function serverVerificationKind(state: RelayVerifyTargetState | null): ModelVerificationStateKind | null {
  return state === null ? null : serverStateToKind[state];
}

export function resolveVerificationState(input: {
  readonly status: RelayModelPortStatus | null;
  readonly verification: RelayModelVerificationState | null;
  readonly verifying: boolean;
}): ModelVerificationStateKind {
  if (input.verifying) return "VERIFYING";
  const serverState = input.verification?.state ?? null;
  if (serverState !== null) return serverStateToKind[serverState];
  if (input.status === null) return "UNAVAILABLE";
  if (input.status.provider === "invalid") return "UNAVAILABLE";
  if (input.status.provider === "fake" || !input.status.configured) return "UNCONFIGURED";
  const last = input.verification?.last ?? null;
  const matches = input.verification?.matchesCurrentConfig === true;
  if (last !== null && matches) return last.ok ? "VERIFIED" : "VERIFY_FAILED";
  return "UNVERIFIED";
}

export interface VerificationLabel {
  readonly chip: string;
  readonly tone: "success" | "warning" | "danger" | "neutral";
  readonly detail: string;
}

export const verificationLabels: Record<ModelVerificationStateKind, VerificationLabel> = {
  UNCONFIGURED: {
    chip: "未配置",
    tone: "neutral",
    detail: "当前服务实例使用 Mock 端口，没有真实模型可验证。这不是故障。"
  },
  UNVERIFIED: {
    chip: "已配置未验证",
    tone: "warning",
    detail: "服务端已读到配置，但还没有与当前配置匹配的验证记录。配置格式通过不等于网络调用成功；"
      + "配置变更后旧验证结果自动失效。"
  },
  VERIFYING: {
    chip: "验证中",
    tone: "neutral",
    detail: "正在调用当前配置的端点。"
  },
  VERIFIED: {
    chip: "验证通过",
    tone: "success",
    detail: "最近一次连接验证成功。"
  },
  VERIFY_FAILED: {
    chip: "验证失败",
    tone: "danger",
    detail: "最近一次连接验证未通过。按错误分类核对 API Key、配额、网络或端点后重新验证。"
  },
  UNAVAILABLE: {
    chip: "当前不可用",
    tone: "danger",
    detail: "真实模型配置残缺或服务状态无法读取；生产进程会拒绝残缺配置，不会静默回退。"
  },
  CONFIG_INCOMPLETE: {
    chip: "配置残缺",
    tone: "danger",
    detail: "Provider 声明缺少必需字段（例如 API Key 或模型名），补齐后再验证。"
  },
  AUTH_FAILED: {
    chip: "认证失败",
    tone: "danger",
    detail: "Provider 拒绝了这次调用的认证或权限（401/403）。请核对 API Key 与该型号的权限。"
  },
  MODEL_NOT_FOUND: {
    chip: "型号不存在",
    tone: "danger",
    detail: "Provider 返回 404：这个确切型号在当前账户或端点下不存在。"
  },
  CREDENTIAL_CHANGED: {
    chip: "凭据已更换",
    tone: "warning",
    detail: "最近一次验证用的是另一份凭据；旧结论不代表当前连接可执行，请重新验证。"
  },
  CATALOG_STALE: {
    chip: "目录已过期",
    tone: "warning",
    detail: "免费目录快照已过期，无法确认这个型号此刻是否仍可调用。"
  },
  NOT_ELIGIBLE: {
    chip: "型号不可调用",
    tone: "warning",
    detail: "这个型号不在当前免费目录里，或缺少文本输入/输出能力。"
  },
  ACCOUNT_COOLDOWN: {
    chip: "账户冷却中",
    tone: "warning",
    detail: "这个账户近期被平台或上游限流，冷却期内不发起调用。"
  },
  BUDGET_EXHAUSTED: {
    chip: "预算不足",
    tone: "warning",
    detail: "这次调用超出已冻结的单次或作用域预算，调整预算档位后再验证。"
  }
};
