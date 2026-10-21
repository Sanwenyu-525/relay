import { expect, it } from "vitest";
import { RelayApiError, RelayTransportError } from "../src/api/relayClient";
import { describeLiveError } from "../src/lib/liveErrors";

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
