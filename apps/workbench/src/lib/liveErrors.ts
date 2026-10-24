import { RelayApiError, RelayTransportError, type RelayFieldError } from "../api/relayClient";

export type LiveErrorKind =
  | "auth"
  | "origin"
  | "database"
  | "schema"
  | "maintenance"
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
  /**
   * 409 `SESSION_DELETE_BLOCKED` 的中文阻断原因（ADR-027）。单条删除只读 `message`；
   * 批量删除按它聚合——同一原因写一次、标题并列，不把「这条讨论还不能删除…」重复成 N 段。
   */
  readonly blockedReasons?: readonly string[];
  /** 422 的字段定位，供表单放回输入项；其他错误为空。 */
  readonly fieldErrors: readonly RelayFieldError[];
}

/** 删除阻断项的中文说明（ADR-027）；未知代码原样保留，避免新阻断被静默吞掉。 */
const sessionDeleteBlockerLabels: Record<string, string> = {
  FORK_CHILDREN: "有分叉出去的讨论",
  TASK_ACCEPTANCE_CITED: "被任务验收观察引用",
  HYPOTHESIS_CITED: "被项目假设引用",
  WORK_SEGMENT_CITED: "被工作片段引用",
  BLUEPRINT_CITED: "被项目蓝图提案引用",
  EXECUTION_REQUESTS: "发起过执行请求",
  LEARNING_RECORDS: "有学习记录",
  ARTIFACT_IMPACT_COMMITTED: "影响检查已进入组合检查",
  PROVIDER_COOLDOWN_ACTIVE: "云模型仍在冷却",
};

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
      case "MAINTENANCE_DRAINING":
        return {
          ...base,
          kind: "maintenance",
          message: "应用正在维护，暂不接受新的操作。你仍可查看已有内容，并请求取消已开始的工作。"
        };
      case "MAINTENANCE_UNAVAILABLE":
        return {
          ...base,
          kind: "maintenance",
          message: "暂时无法确认维护状态，新的操作不可用。请核对服务状态后再试。"
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
      case "RECALL_PREFLIGHT_BLOCKED": {
        // 0132：预检阻断时一个文件都没写；逐路径原因必须原样露出，否则用户只看到
        // 「预检未通过」却不知道该先处理哪一项。
        const paths = (problem.recallPaths ?? []).filter((path) => path.trim() !== "");
        return { ...base, kind: "conflict",
          message: `${problem.detail}${paths.length === 0 ? ""
            : ` 阻断项：${paths.join("；")}`}` };
      }
      case "RECALL_IN_PROGRESS":
        return { ...base, kind: "transition",
          message: `${problem.detail} 请按原回执读取实际进展，不要重复发起。` };
      case "RECALL_EFFECT_UNCERTAIN":
      case "RECALL_MULTIPLE_ROOTS":
      case "RECALL_ROOT_UNAVAILABLE":
      case "RECALL_ROOT_CHANGED":
        return { ...base, kind: "conflict", message: problem.detail };
      case "VALIDATION_FAILED": {
        // 服务端每条字段错误都带一句可执行说明（例如「当前聊天模型不支持图片输入」或
        // 「目录中没有当前聊天模型的条目…请声明 RELAY_MODEL_IMAGE_INPUT=true」）。
        // 只报字段名会把原因吞掉：用户看到「attachment_ids 不符合契约」也无从下手。
        const fields = [...new Set(problem.fieldErrors.map((item) => item.field))].join("、");
        const details = [...new Set(problem.fieldErrors
          .map((item) => item.message.trim()).filter((message) => message !== ""))];
        return {
          ...base,
          kind: "validation",
          message:
            problem.fieldErrors.length === 0
              ? "请求未通过服务端校验：请核对字段取值后重试。"
              : `请求未通过服务端校验（${fields}）：${details.length > 0
                ? details.join("；") : "请核对字段取值后重试。"}`
        };
      }
      case "INVALID_TRANSITION":
        return { ...base, kind: "transition", message: `当前状态不允许这个操作：${problem.detail}` };
      case "SESSION_DELETE_BLOCKED": {
        // 阻断项单独留成结构化标签：单条删除读整句，批量删除按原因聚合，不必把同一句
        // 「这条讨论还不能删除…先改为归档…」按条数重复（2026-10-20 用户截图指认）。
        const blockedReasons = (problem.blockingReasons ?? [])
          .map((reason) => sessionDeleteBlockerLabels[reason] ?? reason);
        return {
          ...base,
          kind: "transition",
          blockedReasons,
          message: `这条讨论还不能删除：${blockedReasons.join("、") || "仍被其它对象引用"}。先改为归档，或在原对象解除引用后再删除。`
        };
      }
      case "ACCEPTANCE_STALE":
        return { ...base, kind: "transition", message: "这次提交依据的验收版本已经失效：请重新读取任务后再操作。" };
      case "EVIDENCE_UNAVAILABLE":
        return { ...base, kind: "evidence", message: "所需产物内容不可用：完成被拒绝，请核对产物版本后重试。" };
      case "RESOURCE_NOT_FOUND":
        // 2026-10-22 DEV-0089：404 的服务端 detail 是「请求的路径在当前服务上不存在。」——
        // 用户看到的原句是「过程读取失败：请求的路径在当前服务上不存在。」，既不知道
        // 「路径」指什么，也不知道下一步做什么。404 只有两种常见来处：内容真的不在了，
        // 或它属于别的项目/目录（切换后旧地址失效）。按这个口径给一句可操作说明。
        // 只收 404：其它状态带同一个代码时（如失权）服务端 detail 才是有效信息，不能盖掉。
        if (problem.status !== 404) break;
        return {
          ...base,
          kind: "unknown",
          message:
            "要查看的内容不存在：它可能已被删除，也可能已不属于当前项目或目录（切换后旧地址会失效）。请返回列表刷新后重试；持续失败请核对当前项目选择。"
        };
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

/**
 * 提交结果是否无法由浏览器判定，需要先按原 command ID 核对回执（工作台 §37）。
 * 只有服务端明确业务拒绝（422、409 版本冲突等）才说明意图没有落库，可以修正后换新命令重发；
 * 5xx、`CHECK_RECEIPT_THEN_RETRY`、传输失败与正文不合契约都分不清「没写进去」和
 * 「写进去但响应失败」。不能改用 `describeLiveError` 的 `kind` 判——5xx 归在 `unknown` 里。
 */
export function needsReceiptCheck(caught: unknown): boolean {
  if (caught instanceof RelayApiError) {
    return caught.problem.status >= 500 || caught.problem.retryAction === "CHECK_RECEIPT_THEN_RETRY";
  }
  return true;
}
