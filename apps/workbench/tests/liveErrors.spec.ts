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
