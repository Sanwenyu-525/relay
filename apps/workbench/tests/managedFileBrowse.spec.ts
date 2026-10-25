import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DevToolsPanel from "../src/components/DevToolsPanel";
import { RelayApiClient, RelayApiError, RelayTransportError,
  type RelayFileBrowseAction, type RelayManagedFileReadInput, type RelayRun } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

/**
 * 工具面板「文件」页签的目录浏览与文件读取接线（HTTP §10.112，迁移 0134）。
 *
 * 每条用例锁定一条交互事实或反例：显式点击才派发命令、截断显式、类型化失败不折叠成
 * 空目录/空正文、缺连接给指引、ASK 等待不携带结果字段、原命令身份保留。
 */

const resources = ["resource-1"].map((id) => ({ id, projectId: "project-1",
  canonicalRoot: "D:\\work\\relay", status: "ACTIVE", revision: "1", resourceEpoch: "1", fileWriteIdentityBound: false }));
const connections = [
  { id: "query-1", status: "ACTIVE", capabilities: ["FILE_QUERY"], allowedHost: null, allowedExecutables: null },
  { id: "read-1", status: "ACTIVE", capabilities: ["FILE_READ"], allowedHost: null, allowedExecutables: null },
];
const rootEntries = [
  { path: "src", kind: "directory", size: null },
  { path: "alpha.md", kind: "file", size: 12 },
];
const srcEntries = [
  { path: "main.ts", kind: "file", size: 240 },
];

function problem(code: string, status = 409): RelayApiError {
  return new RelayApiError({ status, code, detail: code, retryable: false, retryAction: "NONE",
    fieldErrors: [], expectedRevision: null, actualRevision: null });
}

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

function setup() {
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: "workspace-1", bearerToken: "test" });
  const loadResources = vi.spyOn(client, "getManagedResources").mockResolvedValue(resources);
  const loadConnections = vi.spyOn(client, "getGatewayConnections").mockResolvedValue(connections);
  const read = vi.spyOn(client, "readManagedFileState");
  const check = vi.spyOn(client, "getCommandReceipt").mockRejectedValue(problem("RESOURCE_NOT_FOUND", 404));
  const element = (projectId = "project-1", taskId = "task-1") => createElement(MemoryRouter, {},
    createElement(DevToolsPanel, { client, projectId, taskId, run: null,
      previewBridge: null, previewScope: "workspace:conversation", onClose: () => undefined }));
  return { client, loadResources, loadConnections, read, check, element };
}

/** 读取结果回执形态：按动作给出真实投影字段。 */
async function settle(input: RelayManagedFileReadInput, result: Record<string, unknown>,
  state = "SUCCEEDED"): Promise<{ commandId: string; committedAt: string; outcome: unknown }> {
  const { managedFileReadOutcomeFrom } = await import("../src/api/relayClient");
  const raw = { state, action_type: input.actionType, operation_id: `operation-${input.actionType}`,
    invocation_id: "invocation-1", result };
  return { commandId: input.commandId, committedAt: "2026-10-24T12:00:00Z",
    outcome: managedFileReadOutcomeFrom(raw, input.actionType) };
}

function listingResult(entries: readonly unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { directory: ".", entries, count: entries.length, limit: 200, truncated: false, skipped: 0, ...extra };
}

async function open(context: ReturnType<typeof setup>) {
  const view = await mountReact(context.element()); await flush();
  return view;
}

it("挂载只读登记配置；明确点击「读取根目录」才派发 LIST_DIRECTORY", async () => {
  const context = setup();
  context.read.mockImplementation(async (input) => input.actionType === "LIST_DIRECTORY"
    ? settle(input, listingResult(rootEntries)) : Promise.reject(new Error("unexpected")));
  const view = await open(context);
  try {
    expect(context.loadResources).toHaveBeenCalledWith("project-1");
    expect(context.loadConnections).toHaveBeenCalledWith("project-1");
    expect(context.read).not.toHaveBeenCalled();
    await view.wrapper.get('[data-testid="file-browse-open-root"]').trigger("click"); await flush();
    expect(context.read).toHaveBeenCalledTimes(1);
    expect(context.read.mock.calls[0]?.[0]).toEqual({ projectId: "project-1", resourceId: "resource-1",
      connectionId: "query-1", commandId: expect.any(String), actionType: "LIST_DIRECTORY" });
    expect(view.wrapper.get('[data-testid="file-browse-entries-root"]').text()).toContain("src");
    expect(view.wrapper.get('[data-testid="file-browse-entries-root"]').text()).toContain("alpha.md");
  } finally { view.unmount(); }
});

it("展开子目录按相对路径二次读取；刷新按钮用新 command_id 产生新读取事实", async () => {
  const context = setup();
  context.read.mockImplementation(async (input) => input.actionType === "LIST_DIRECTORY"
    ? settle(input, listingResult(input.relativePath === undefined ? rootEntries : srcEntries))
    : Promise.reject(new Error("unexpected")));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="file-browse-open-root"]').trigger("click"); await flush();
    await view.wrapper.get('[data-testid="file-browse-dir-src"]').trigger("click"); await flush();
    expect(context.read).toHaveBeenCalledTimes(2);
    expect(context.read.mock.calls[1]?.[0]).toMatchObject({ actionType: "LIST_DIRECTORY", relativePath: "src",
      connectionId: "query-1" });
    expect(view.wrapper.get('[data-testid="file-browse-entries-src"]').text()).toContain("main.ts");

    const firstCommandId = context.read.mock.calls[0]?.[0]?.commandId;
    await view.wrapper.get('[data-testid="file-browse-refresh-src"]').trigger("click"); await flush();
    expect(context.read).toHaveBeenCalledTimes(3);
    expect(context.read.mock.calls[2]?.[0]).toMatchObject({ relativePath: "src" });
    expect(context.read.mock.calls[2]?.[0]?.commandId).not.toBe(firstCommandId);
    // 收起再展开沿用已读快照，不追加命令。
    await view.wrapper.get('[data-testid="file-browse-dir-src"]').trigger("click"); await flush();
    await view.wrapper.get('[data-testid="file-browse-dir-src"]').trigger("click"); await flush();
    expect(context.read).toHaveBeenCalledTimes(3);
  } finally { view.unmount(); }
});

it("截断的目录列表显式标注，不能当作完整清单", async () => {
  const context = setup();
  context.read.mockImplementation(async (input) => settle(input,
    listingResult(rootEntries, { truncated: true, limit: 2, count: 5 })));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="file-browse-open-root"]').trigger("click"); await flush();
    const callout = view.wrapper.get('[data-testid="devtools-files"]').find(".warning-callout");
    expect(callout.text()).toContain("已截断");
    expect(callout.text()).toContain("上限 2");
  } finally { view.unmount(); }
});

it("点击文件用 FILE_READ 连接读取正文与 SHA-256；二进制按类型化失败呈现且不渲染正文", async () => {
  const context = setup();
  const sha256 = "a".repeat(64);
  context.read.mockImplementation(async (input) => input.actionType === "READ_FILE"
    ? settle(input, input.relativePath === "src/main.ts"
      ? { content: "中文正文\n", size: 13, sha256, truncated: false }
      : { reason: "FILE_BINARY_UNSUPPORTED" }, input.relativePath === "src/main.ts" ? "SUCCEEDED" : "FAILED")
    : settle(input, listingResult(input.relativePath === undefined ? rootEntries : srcEntries)));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="file-browse-open-root"]').trigger("click"); await flush();
    await view.wrapper.get('[data-testid="file-browse-dir-src"]').trigger("click"); await flush();
    await view.wrapper.get('[data-testid="file-browse-file-src/main.ts"]').trigger("click"); await flush();
    expect(context.read.mock.calls.at(-1)?.[0]).toMatchObject({ actionType: "READ_FILE",
      relativePath: "src/main.ts", connectionId: "read-1" });
    const preview = view.wrapper.get('[data-testid="file-preview"]');
    expect(preview.text()).toContain("中文正文");
    expect(preview.text()).toContain(sha256);

    await view.wrapper.get('[data-testid="file-browse-file-alpha.md"]').trigger("click"); await flush();
    const failed = view.wrapper.get('[data-testid="file-preview-error"]');
    expect(failed.text()).toContain("FILE_BINARY_UNSUPPORTED");
    expect(failed.text()).toContain("二进制");
  } finally { view.unmount(); }
});

it("缺 FILE_QUERY 连接给配置指引且不派发命令；只有浏览连接时打开文件给出明确提示", async () => {
  const context = setup();
  context.loadConnections.mockResolvedValue([connections[1]!]);
  context.read.mockImplementation(async (input) => settle(input, listingResult(rootEntries)));
  const view = await open(context);
  try {
    expect(view.wrapper.get('[data-testid="file-browse-blocked"]').text())
      .toContain("没有可用的 FILE_QUERY 连接");
    // blocked 下不提供可点击的浏览入口，也不派发任何命令。
    expect(view.wrapper.find('[data-testid="file-browse-open-root"]').exists()).toBe(false);
    expect(context.read).not.toHaveBeenCalled();
  } finally { view.unmount(); }

  const browseOnly = setup();
  browseOnly.loadConnections.mockResolvedValue([connections[0]!]);
  browseOnly.read.mockImplementation(async (input) => settle(input, listingResult(rootEntries)));
  const second = await open(browseOnly);
  try {
    await second.wrapper.get('[data-testid="file-browse-open-root"]').trigger("click"); await flush();
    await second.wrapper.get('[data-testid="file-browse-file-alpha.md"]').trigger("click"); await flush();
    expect(browseOnly.read).toHaveBeenCalledTimes(1);
    expect(second.wrapper.get('[data-testid="file-preview-error"]').text()).toContain("FILE_READ 连接");
  } finally { second.unmount(); }
});

it("目录读取失败按类型化原因呈现，不折叠成空目录", async () => {
  const context = setup();
  context.read.mockImplementation(async (input) => input.relativePath === undefined
    ? settle(input, listingResult(rootEntries))
    : settle(input, { reason: "FILE_QUERY_DIRECTORY_UNREADABLE" }, "FAILED"));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="file-browse-open-root"]').trigger("click"); await flush();
    await view.wrapper.get('[data-testid="file-browse-dir-src"]').trigger("click"); await flush();
    const error = view.wrapper.get('[data-testid="file-browse-error-src"]');
    expect(error.text()).toContain("FILE_QUERY_DIRECTORY_UNREADABLE");
    expect(error.text()).toContain("不等于目录为空");
  } finally { view.unmount(); }
});

it("ASK 策略停在等待确认：不携带任何结果字段，保留原命令与 Review 入口", async () => {
  const context = setup();
  context.read.mockImplementation(async (input) => ({ commandId: input.commandId,
    committedAt: "2026-10-24T12:00:00Z", outcome: { state: "WAITING_APPROVAL",
      actionType: input.actionType as RelayFileBrowseAction, operationId: "operation-ask",
      reviewId: "review-1", reason: "ACTION_APPROVAL_REQUIRED" } }));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="file-browse-open-root"]').trigger("click"); await flush();
    const pending = view.wrapper.get('[data-testid="file-browse-pending"]');
    expect(pending.text()).toContain("等待动作批准");
    expect(pending.text()).toContain("ACTION_APPROVAL_REQUIRED");
    // 等待确认时不得渲染任何条目列表或正文冒充已读到内容。
    expect(view.wrapper.findAll('[data-testid^="file-browse-entries-"]').length).toBe(0);
    expect(view.wrapper.find("pre").exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="file-browse-review"]').attributes("href")).toContain("review-1");
    // 等待期间不得再派发新命令。
    await view.wrapper.get('[data-testid="file-browse-open-root"]').trigger("click");
    expect(context.read).toHaveBeenCalledTimes(1);
  } finally { view.unmount(); }
});

it("明确拒绝按类型化文案呈现并清 pending；传输失败保留原命令供核对", async () => {
  const context = setup();
  context.read.mockRejectedValueOnce(problem("GATEWAY_PERMISSION_DENIED"))
    .mockRejectedValueOnce(new RelayTransportError("offline"));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="file-browse-open-root"]').trigger("click"); await flush();
    const error = view.wrapper.get('[data-testid="file-browse-error-root"]');
    expect(error.text()).toContain("GATEWAY_PERMISSION_DENIED");
    expect(view.wrapper.find('[data-testid="file-browse-pending"]').exists()).toBe(false);

    await view.wrapper.get('[data-testid="file-browse-open-root"]').trigger("click"); await flush();
    const pending = view.wrapper.get('[data-testid="file-browse-pending"]');
    expect(pending.text()).toContain("原 command_id");
    expect(view.wrapper.get('[data-testid="file-browse-check-receipt"]')).toBeDefined();
  } finally { view.unmount(); }
});
