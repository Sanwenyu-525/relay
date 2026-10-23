import { expect, it } from "vitest";
import { RelayApiError, RelayTransportError } from "../src/api/relayClient";
import { RelayContractError } from "../src/api/core/errors";
import { describeLiveError, needsReceiptCheck } from "../src/lib/liveErrors";

it.each([
  ["MAINTENANCE_DRAINING", "应用正在维护，暂不接受新的操作。你仍可查看已有内容，并请求取消已开始的工作。"],
  ["MAINTENANCE_UNAVAILABLE", "暂时无法确认维护状态，新的操作不可用。请核对服务状态后再试。"]
])("维护错误 %s 显示中文说明且不暴露服务端明细", (code, message) => {
  const fieldErrors = [{ field: "maintenance", message: "synthetic field error" }];
  const described = describeLiveError(new RelayApiError({
    status: 503, code, detail: "synthetic-private-database-detail", retryable: false,
    retryAction: "NONE", fieldErrors, expectedRevision: null, actualRevision: null
  }));
  expect(described).toEqual({ kind: "maintenance", message, fieldErrors });
  expect(described.message).not.toContain("synthetic-private-database-detail");
});

it("响应丢失仍要求核对原回执，不归因为维护拒绝", () => {
  const described = describeLiveError(new RelayTransportError());
  expect(described.kind).toBe("transport");
  expect(described.message).toContain("同一个 command ID 查询回执");
});

it("校验失败保留服务端给出的原因，不只报字段名", () => {
  // 图片附件的模型能力闸门就是这条：只显示「attachment_ids 不符合契约」时，
  // 用户既看不出是模型不支持图片，也不知道该去声明 RELAY_MODEL_IMAGE_INPUT。
  const withReason = describeLiveError(new RelayApiError({
    status: 422, code: "VALIDATION_FAILED", detail: "validation failed", retryable: false,
    retryAction: "NONE",
    fieldErrors: [{ field: "attachment_ids",
      message: "当前聊天模型不支持图片输入，不能发送图片附件。" }],
    expectedRevision: null, actualRevision: null
  }));
  expect(withReason.kind).toBe("validation");
  expect(withReason.message).toContain("attachment_ids");
  expect(withReason.message).toContain("当前聊天模型不支持图片输入，不能发送图片附件。");
  // 同字段多条、重复说明只留一份，避免把同一句话连读三遍。
  const deduped = describeLiveError(new RelayApiError({
    status: 422, code: "VALIDATION_FAILED", detail: "validation failed", retryable: false,
    retryAction: "NONE",
    fieldErrors: [{ field: "title", message: "不能为空" }, { field: "title", message: "不能为空" },
      { field: "goal", message: "过长" }],
    expectedRevision: null, actualRevision: null
  }));
  expect(deduped.message).toBe("请求未通过服务端校验（title、goal）：不能为空；过长");
  // 服务端没给说明时退回字段名，不拼出一个空括号。
  const bare = describeLiveError(new RelayApiError({
    status: 422, code: "VALIDATION_FAILED", detail: "validation failed", retryable: false,
    retryAction: "NONE", fieldErrors: [{ field: "attachment_ids", message: "" }],
    expectedRevision: null, actualRevision: null
  }));
  expect(bare.message).toBe("请求未通过服务端校验（attachment_ids）：请核对字段取值后重试。");
});

it("404 换成可操作说明，不把服务端「路径不存在」原句抛给用户（2026-10-22 DEV-0089）", () => {
  // 截图复现：过程区红字是「过程读取失败：请求的路径在当前服务上不存在。」——
  // 用户既不知道「路径」指什么，也不知道下一步做什么。404 的常见来路只有两种：
  // 内容真的不在了，或它属于别的项目/目录（切换后旧地址失效）。
  const described = describeLiveError(new RelayApiError({
    status: 404, code: "RESOURCE_NOT_FOUND", detail: "请求的路径在当前服务上不存在。",
    retryable: false, retryAction: "NONE", fieldErrors: [],
    expectedRevision: null, actualRevision: null
  }));
  expect(described.message).toContain("要查看的内容不存在");
  expect(described.message).toContain("返回列表刷新后重试");
  expect(described.message).not.toContain("请求的路径在当前服务上不存在");
});

it("只有服务端明确业务拒绝才解除结果未知；5xx 与 CHECK_RECEIPT_THEN_RETRY 先核对回执（工作台 §37）", () => {
  const apiError = (status: number, code: string, retryAction: string | null = "NONE") => new RelayApiError({
    status, code, detail: code, retryable: false, retryAction, fieldErrors: [],
    expectedRevision: null, actualRevision: null
  });
  expect(needsReceiptCheck(new RelayTransportError())).toBe(true);
  expect(needsReceiptCheck(apiError(500, "INTERNAL_ERROR"))).toBe(true);
  expect(needsReceiptCheck(apiError(409, "COMMAND_STATE_UNCERTAIN", "CHECK_RECEIPT_THEN_RETRY"))).toBe(true);
  expect(needsReceiptCheck(apiError(409, "REVISION_CONFLICT"))).toBe(false);
  expect(needsReceiptCheck(apiError(422, "VALIDATION_FAILED"))).toBe(false);
  // 2xx 但正文不合契约、以及其它本地异常都没有服务端认定，不能按「明确拒绝」放行重新提交。
  expect(needsReceiptCheck(new RelayContractError("回执正文不合契约"))).toBe(true);
  expect(needsReceiptCheck(new Error("boom"))).toBe(true);
});
