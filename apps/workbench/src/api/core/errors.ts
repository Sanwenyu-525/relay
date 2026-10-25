export interface RelayFieldError {
  readonly field: string;
  readonly message: string;
}

export interface RelayProblem {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly retryable: boolean;
  readonly retryAction: string | null;
  /** 422 的字段定位；界面据此把错误放回对应输入项。 */
  readonly fieldErrors: readonly RelayFieldError[];
  /** 409 REVISION_CONFLICT 的版本差异；界面保留差异而不是直接覆盖。 */
  readonly expectedRevision: string | null;
  readonly actualRevision: string | null;
  readonly blockingReasons?: readonly string[];
  /** 409 GOAL_LINK_IN_USE 的当前受影响 Task 清单；界面据此重新展示并要求再次确认。 */
  readonly impactedTaskIds?: readonly string[];
  /**
   * 0132：撤回预检的逐路径阻断项（`路径｜状态｜原因`）。只在
   * `RECALL_PREFLIGHT_BLOCKED` 等 409 里出现；界面原样列出，不重新解释。
   */
  readonly recallPaths?: readonly string[];
}

export class RelayApiError extends Error {
  constructor(readonly problem: RelayProblem) {
    super(problem.detail);
    this.name = "RelayApiError";
  }
}

/** 已收到 2xx 但正文形状不符合已声明契约：不能当成已确认事实，须与网络失败和服务端状态错误区分。 */
export class RelayContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayContractError";
  }
}

/** 命令响应未能可靠核对时，提交是否已入库无法由浏览器判断。 */
export class RelayTransportError extends Error {
  constructor(message = "网络请求未获得服务端响应。") {
    super(message);
    this.name = "RelayTransportError";
  }
}

export class RelayRunEventHttpError extends Error {
  constructor(readonly status: number) {
    super(`执行事件订阅返回 HTTP ${status}。`);
    this.name = "RelayRunEventHttpError";
  }
}

export class RelayPreviewHttpError extends Error {
  constructor(readonly status: number) {
    super(`预览事件订阅返回 HTTP ${status}。`);
    this.name = "RelayPreviewHttpError";
  }
}
