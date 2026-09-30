import { RelayApiError, RelayTransportError, type RelayFieldError } from "../api/relayClient";

export type LiveErrorKind =
  | "auth"
  | "origin"
  | "database"
  | "schema"
  | "conflict"
  | "reused"
  | "validation"
  | "transition"
  | "evidence"
  | "model"
  | "transport"
  | "unknown";

export interface LiveActionError {
  readonly kind: LiveErrorKind;
  readonly message: string;
  /** 422 的字段定位，供表单放回输入项；其他错误为空。 */
  readonly fieldErrors: readonly RelayFieldError[];
}

/**
 * 把真实 API 的错误映射为可操作的界面说明。
 * 服务端 detail 是英文契约文本，因此这里按 code 给出中文解释，并保留差异信息。
 */
export function describeLiveError(caught: unknown): LiveActionError {
  if (caught instanceof RelayTransportError) {
    return {
      kind: "transport",
      message:
        "请求响应丢失或无法核对，本次提交是否生效尚未确定。若刚提交命令，请用同一个 command ID 查询回执，不要换 ID 重新提交。",
      fieldErrors: []
    };
  }

  if (caught instanceof RelayApiError) {
    const problem = caught.problem;
    const base = { fieldErrors: problem.fieldErrors };

    switch (problem.code) {
      case "AUTH_REQUIRED":
        return { ...base, kind: "auth", message: "凭据未被接受：请核对 Bearer 令牌是否与 apps/api/.env 中的值一致。" };
      case "PERMISSION_DENIED":
        return {
          ...base,
          kind: "origin",
          message:
            "请求来源未被允许：请把当前前端地址（例如 http://127.0.0.1:5173）加入 RELAY_API_ALLOWED_ORIGINS 后重启 API。"
        };
      case "DATABASE_UNAVAILABLE":
        return {
          ...base,
          kind: "database",
          message: "数据库不可达：服务仍在监听，但读写不可用。请先启动本机 PostgreSQL 并确认 RELAY_DB_URL。"
        };
      case "SCHEMA_UNAVAILABLE":
        return {
          ...base,
          kind: "schema",
          message: "数据库可连接但 schema 不兼容：请先在 apps/api 运行迁移入口，再重试。"
        };
      case "REVISION_CONFLICT":
        return {
          ...base,
          kind: "conflict",
          message:
            problem.expectedRevision === null || problem.actualRevision === null
              ? "服务端版本已经变化：请重新读取后再提交，本次输入不会被覆盖。"
              : `服务端当前版本是 ${problem.actualRevision}，本次提交基于 ${problem.expectedRevision}。请重新读取后再提交，本次输入不会被覆盖。`
        };
      case "RULE_CONFLICT":
        return { ...base, kind: "conflict", message: `规则与现有 HARD 规则冲突：${problem.detail}` };
      case "RULE_ENFORCEMENT_UNAVAILABLE":
        return { ...base, kind: "validation", message: `规则所需检查路径不可用：${problem.detail}` };
      case "COMMAND_ID_REUSED":
        return {
          ...base,
          kind: "reused",
          message: "同一个 command ID 被用于不同内容：请先查询原回执，不要复用 ID 提交新内容。"
        };
      case "VALIDATION_FAILED":
        return {
          ...base,
          kind: "validation",
          message:
            problem.fieldErrors.length === 0
              ? "请求未通过服务端校验：请核对字段取值后重试。"
              : `请求未通过服务端校验：${problem.fieldErrors.map((item) => item.field).join("、")} 不符合契约。`
        };
      case "INVALID_TRANSITION":
        return { ...base, kind: "transition", message: `当前状态不允许这个操作：${problem.detail}` };
      case "ACCEPTANCE_STALE":
        return { ...base, kind: "transition", message: "这次提交依据的验收版本已经失效：请重新读取任务后再操作。" };
      case "EVIDENCE_UNAVAILABLE":
        return { ...base, kind: "evidence", message: "所需产物内容不可用：完成被拒绝，请核对产物版本后重试。" };
      case "MODEL_PORT_NOT_CONFIGURED":
        return {
          ...base,
          kind: "model",
          message:
            "当前服务实例没有配置真实模型端口：Assist 与 Run 生成不会调用真实模型（会走 Mock）。请在服务实例的环境配置里设置 RELAY_MODEL_PROVIDER / RELAY_MODEL_NAME / RELAY_MODEL_API_KEY 后重启该实例。"
        };
      case "MODEL_CONFIG_INVALID":
        return {
          ...base,
          kind: "model",
          message: `真实模型配置残缺，实例不会静默回退 Mock：${problem.detail}`
        };
      case "MODEL_VERIFY_IN_PROGRESS":
        return {
          ...base,
          kind: "model",
          message: "本实例已有一项模型连接验证在执行，请等它结束后再试；验证结果会写入调用账本。"
        };
      default:
        return { ...base, kind: "unknown", message: problem.detail };
    }
  }

  return {
    kind: "unknown",
    message: caught instanceof Error ? caught.message.trim() : "调用本机 API 时发生未知错误。",
    fieldErrors: []
  };
}
