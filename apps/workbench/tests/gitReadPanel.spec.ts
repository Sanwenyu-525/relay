import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DevToolsPanel from "../src/components/DevToolsPanel";
import { RelayApiClient, RelayApiError, RelayTransportError, type RelayManagedGitReadInput,
  type RelayManagedGitReadResponse, type RelayRun } from "../src/api/relayClient";
import { flush, mountReact } from "./mountApp";

const resources = ["resource-1", "resource-2"].map((id) => ({ id, projectId: "project-1",
  canonicalRoot: `D:\\${id}`, status: "ACTIVE", revision: "1", resourceEpoch: "1", fileWriteIdentityBound: false }));
const connections = [{ id: "read-1", status: "ACTIVE", capabilities: ["GIT_READ"], allowedHost: null,
  allowedExecutables: null }];
const statusResult = { branch: "feature/中文", head_commit: "a".repeat(40), staged: ["staged.ts"],
  unstaged: ["改动.ts"], untracked: ["new.md"], limit: 1, truncated: true,
  totals: { staged: 3, unstaged: 1, untracked: 2 } };
const receipt = (input: RelayManagedGitReadInput, overrides: Record<string, unknown> = {}) => ({
  command_id: input.commandId, committed_at: "2026-10-05T01:00:00Z",
  result: { state: "SUCCEEDED", action_type: input.actionType, operation_id: "operation-1",
    invocation_id: "invocation-1", result: input.actionType === "GIT_STATUS" ? statusResult : {
      diff: "+中文", limit_bytes: 262144, truncated: false, returned_bytes: 7, omitted_bytes: 0 }, ...overrides } });
const problem = (code: string, status = 409) => new RelayApiError({
  status, code, detail: code, retryable: false, retryAction: "NONE", fieldErrors: [],
  expectedRevision: null, actualRevision: null });

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

function setup() {
  const client = new RelayApiClient({ baseUrl: "http://127.0.0.1:8787", workspaceId: "workspace-1", bearerToken: "test" });
  const loadResources = vi.spyOn(client, "getManagedResources").mockResolvedValue(resources);
  const loadConnections = vi.spyOn(client, "getGatewayConnections").mockResolvedValue(connections);
  const read = vi.spyOn(client, "readManagedGitState").mockImplementation(async (input) => {
    const raw = receipt(input);
    const { managedGitReadOutcomeFrom } = await import("../src/api/relayClient");
    return { commandId: raw.command_id, committedAt: raw.committed_at,
      outcome: managedGitReadOutcomeFrom(raw.result, input.actionType) };
  });
  const check = vi.spyOn(client, "getCommandReceipt").mockRejectedValue(problem("RESOURCE_NOT_FOUND", 404));
  const element = (projectId = "project-1", taskId = "task-1") => createElement(MemoryRouter, {},
    createElement(DevToolsPanel, { client, projectId, taskId, run: null,
      previewBridge: null, previewScope: "workspace:conversation", onClose: () => undefined }));
  return { client, loadResources, loadConnections, read, check, element };
}

async function open(context: ReturnType<typeof setup>) {
  const view = await mountReact(context.element()); await flush();
  await view.wrapper.get('[data-testid="devtools-tab-GIT"]').trigger("click"); await flush();
  return view;
}

it("挂载与切页只读取登记配置；明确点击才派发 Git 命令", async () => {
  const context = setup(); const view = await open(context);
  try {
    expect(context.loadResources).toHaveBeenCalledWith("project-1");
    expect(context.loadConnections).toHaveBeenCalledWith("project-1");
    expect(context.read).not.toHaveBeenCalled();
    expect(view.wrapper.find('[data-testid="git-status-clean"]').exists()).toBe(false);
    await view.wrapper.get('[data-testid="git-read-status"]').trigger("click"); await flush();
    expect(context.read).toHaveBeenCalledTimes(1);
    expect(context.read.mock.calls[0]?.[0]).toEqual({ projectId: "project-1", resourceId: "resource-1",
      connectionId: "read-1", commandId: expect.any(String), actionType: "GIT_STATUS" });
    expect(view.wrapper.get('[data-testid="git-status-result"]').text()).toContain("feature/中文");
    expect(view.wrapper.get('[data-testid="git-status-result"]').text()).toContain("省略 2");
    expect(view.wrapper.get('[data-testid="git-read-identity"]').text()).toContain("operation-1");
    expect(view.wrapper.get('[data-testid="git-read-identity"]').text()).toContain("invocation-1");
  } finally { view.unmount(); }
});

it("diff 点击绑定选择的目录、连接、相对路径与 cached，显示真实截断字节", async () => {
  const context = setup(); context.read.mockImplementation(async (input) => ({ commandId: input.commandId,
    committedAt: "2026-10-05T01:00:00Z", outcome: { state: "SUCCEEDED", actionType: "GIT_DIFF",
      operationId: "operation-diff", invocationId: "invocation-diff", result: { kind: "DIFF", diff: "+中文",
        truncated: true, limitBytes: 8, returnedBytes: 7, omittedBytes: 50 } } }));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="git-read-resource"]').setValue("resource-2");
    await view.wrapper.get('[data-testid="git-read-path"]').setValue("src/中文.ts");
    await view.wrapper.get('[data-testid="git-read-cached"]').setValue(true);
    await view.wrapper.get('[data-testid="git-read-diff"]').trigger("click"); await flush();
    expect(context.read.mock.calls[0]?.[0]).toMatchObject({ resourceId: "resource-2", connectionId: "read-1",
      actionType: "GIT_DIFF", relativePath: "src/中文.ts", cached: true });
    expect(view.wrapper.get('[data-testid="git-diff-result"]').text()).toContain("+中文");
    expect(view.wrapper.get('[data-testid="git-diff-result"]').text()).toContain("省略 50 字节");
    expect(view.wrapper.get('[data-testid="git-read-identity"]').text()).toContain("src/中文.ts");
  } finally { view.unmount(); }
});

it("只有 ACTIVE 目录和 ACTIVE GIT_READ 连接可选，配置读取失败也不允许命令", async () => {
  const context = setup(); context.loadResources.mockResolvedValue([...resources,
    { ...resources[0]!, id: "disabled", status: "DISABLED" }, { ...resources[0]!, id: "foreign", projectId: "project-2" }]);
  context.loadConnections.mockResolvedValue([...connections,
    { ...connections[0]!, id: "write-only", capabilities: ["GIT_WRITE"] }, { ...connections[0]!, id: "inactive", status: "DISABLED" }]);
  const view = await open(context);
  try {
    expect(view.wrapper.get('[data-testid="git-read-resource"]').findAll("option").map((item) => item.attributes("value"))).toEqual(["resource-1", "resource-2"]);
    expect(view.wrapper.get('[data-testid="git-read-connection"]').findAll("option").map((item) => item.attributes("value"))).toEqual(["read-1"]);
  } finally { view.unmount(); }
  context.loadConnections.mockRejectedValue(new RelayTransportError("offline"));
  const failed = await open(context);
  try {
    expect(failed.wrapper.get('[data-testid="git-read-status"]').attributes("disabled")).toBeDefined();
    await failed.wrapper.get('[data-testid="git-read-status"]').trigger("click");
    expect(context.read).not.toHaveBeenCalled();
  } finally { failed.unmount(); }
});

it.each(["../outside", "..\\outside", "C:\\repo\\file", "/absolute"])("diff 路径 %s 拒绝本地派发", async (path) => {
  const context = setup(); const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="git-read-path"]').setValue(path);
    expect(view.wrapper.get('[data-testid="git-read-diff"]').attributes("disabled")).toBeDefined();
    await view.wrapper.get('[data-testid="git-read-diff"]').trigger("click");
    expect(context.read).not.toHaveBeenCalled();
  } finally { view.unmount(); }
});

it("ASK 只导航既有 Review，继续时先查回执并完整复用原请求", async () => {
  const context = setup();
  context.read.mockImplementationOnce(async (input) => ({ commandId: input.commandId, committedAt: "2026-10-05T01:00:00Z",
    outcome: { state: "WAITING_APPROVAL", actionType: "GIT_DIFF", operationId: "operation-1", reviewId: "review-1", reason: "ACTION_APPROVAL_REQUIRED" } }));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="git-read-path"]').setValue("src/中文.ts");
    await view.wrapper.get('[data-testid="git-read-diff"]').trigger("click"); await flush();
    expect(view.wrapper.get('[data-testid="git-read-review"]').attributes("href")).toBe("/reviews?id=review-1");
    expect(view.wrapper.find('[data-testid="git-status-clean"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="git-read-path"]').attributes("disabled")).toBeDefined();
    expect(view.wrapper.findAll("button").some((button) => button.text() === "批准")).toBe(false);
    await view.wrapper.get('[data-testid="git-read-continue"]').trigger("click"); await flush();
    expect(context.check.mock.invocationCallOrder[0]).toBeLessThan(context.read.mock.invocationCallOrder[1]!);
    expect(context.read.mock.calls[1]?.[0]).toEqual(context.read.mock.calls[0]?.[0]);
    expect(view.wrapper.find('[data-testid="git-read-pending"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="git-diff-result"]').exists()).toBe(true);
  } finally { view.unmount(); }
});

it("响应丢失先查原回执；查不到保持身份并禁止新请求，关闭重开仍可核对", async () => {
  const context = setup(); context.read.mockRejectedValue(new RelayTransportError("lost"));
  const view = await open(context);
  await view.wrapper.get('[data-testid="git-read-status"]').trigger("click"); await flush();
  const original = context.read.mock.calls[0]![0];
  expect(context.check).toHaveBeenCalledWith(original.commandId);
  expect(view.wrapper.get('[data-testid="git-read-pending"]').text()).toContain(original.commandId);
  expect(view.wrapper.get('[data-testid="git-read-status"]').attributes("disabled")).toBeDefined();
  view.unmount();
  const reopened = await open(context);
  try {
    expect(reopened.wrapper.get('[data-testid="git-read-pending"]').text()).toContain(original.commandId);
    await reopened.wrapper.get('[data-testid="git-read-check-receipt"]').trigger("click"); await flush();
    expect(context.check).toHaveBeenLastCalledWith(original.commandId);
    expect(context.read).toHaveBeenCalledTimes(1);
  } finally { reopened.unmount(); }
});

it("成功回执恢复原动作；错误类型或 command_id 回执不释放原命令", async () => {
  const context = setup(); context.read.mockRejectedValue(new RelayTransportError("lost"));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="git-read-status"]').trigger("click"); await flush();
    const original = context.read.mock.calls[0]![0]; const raw = receipt(original);
    context.check.mockResolvedValue({ commandId: "wrong", commandType: "ReadManagedGitState", committedAt: raw.committed_at, result: raw.result });
    await view.wrapper.get('[data-testid="git-read-check-receipt"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="git-read-pending"]').exists()).toBe(true);
    context.check.mockResolvedValue({ commandId: original.commandId, commandType: "DifferentCommand", committedAt: raw.committed_at, result: raw.result });
    await view.wrapper.get('[data-testid="git-read-check-receipt"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="git-read-pending"]').exists()).toBe(true);
    context.check.mockResolvedValue({ commandId: original.commandId, commandType: "ReadManagedGitState", committedAt: raw.committed_at, result: raw.result });
    await view.wrapper.get('[data-testid="git-read-check-receipt"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="git-read-pending"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="git-status-result"]').exists()).toBe(true);
    expect(context.read).toHaveBeenCalledTimes(1);
  } finally { view.unmount(); }
});

it("UNKNOWN 只核对回执，不补发；资源切换保留原请求且不带入旧结果", async () => {
  const context = setup(); context.read.mockImplementationOnce(async (input) => ({ commandId: input.commandId,
    committedAt: "2026-10-05T01:00:00Z", outcome: { state: "UNRESOLVED", actionType: "GIT_STATUS",
      operationId: "operation-1", reviewId: null, reason: "GATEWAY_RESULT_UNRESOLVED" } }));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="git-read-status"]').trigger("click"); await flush();
    const original = context.read.mock.calls[0]![0];
    expect(view.wrapper.find('[data-testid="git-read-continue"]').exists()).toBe(false);
    await view.wrapper.get('[data-testid="git-read-resource"]').setValue("resource-2");
    expect(view.wrapper.find('[data-testid="git-read-pending"]').exists()).toBe(false);
    await view.wrapper.get('[data-testid="git-read-status"]').trigger("click"); await flush();
    expect(context.read.mock.calls[1]?.[0].resourceId).toBe("resource-2");
    await view.wrapper.get('[data-testid="git-read-resource"]').setValue("resource-1");
    expect(view.wrapper.get('[data-testid="git-read-pending"]').text()).toContain(original.commandId);
    expect(view.wrapper.find('[data-testid="git-status-result"]').exists()).toBe(false);
  } finally { view.unmount(); }
});

it.each(["GIT_REPOSITORY_UNAVAILABLE", "GIT_STATUS_RESULT_MISSING"])("失败 %s 不显示干净或旧结果", async (reason) => {
  const context = setup(); const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="git-read-status"]').trigger("click"); await flush();
    context.read.mockImplementation(async (input) => ({ commandId: input.commandId, committedAt: "2026-10-05T01:00:00Z",
      outcome: { state: "FAILED", actionType: "GIT_STATUS", operationId: "operation-failed", invocationId: "invocation-failed",
        result: { kind: "FAILURE", reason, detail: "读取失败" } } }));
    await view.wrapper.get('[data-testid="git-read-status"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="git-status-clean"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="git-status-result"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="git-read-error"]').text()).toContain(reason);
  } finally { view.unmount(); }
});

it("权限拒绝保留错误及原身份，不显示旧的干净结论", async () => {
  const context = setup(); context.read.mockRejectedValue(problem("GATEWAY_PERMISSION_DENIED"));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="git-read-status"]').trigger("click"); await flush();
    expect(view.wrapper.get('[data-testid="git-read-error"]').text()).toContain("GATEWAY_PERMISSION_DENIED");
    expect(view.wrapper.get('[data-testid="git-read-identity"]').text()).toContain(context.read.mock.calls[0]![0].commandId);
    expect(view.wrapper.find('[data-testid="git-status-clean"]').exists()).toBe(false);
  } finally { view.unmount(); }
});

it("只有完整且所有真实计数为零的状态读取显示干净，空 diff 不推断干净", async () => {
  const context = setup(); context.read.mockImplementation(async (input) => ({ commandId: input.commandId,
    committedAt: "2026-10-05T01:00:00Z", outcome: { state: "SUCCEEDED", actionType: input.actionType,
      operationId: "operation-1", invocationId: "invocation-1", result: input.actionType === "GIT_STATUS"
        ? { kind: "STATUS", branch: "main", headCommit: null, staged: [], unstaged: [], untracked: [],
          limit: 200, truncated: false, totals: { staged: 0, unstaged: 0, untracked: 0 } }
        : { kind: "DIFF", diff: "", limitBytes: 262144, truncated: false, returnedBytes: 0, omittedBytes: 0 } } }));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="git-read-status"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="git-status-clean"]').exists()).toBe(true);
    await view.wrapper.get('[data-testid="git-read-diff"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="git-status-clean"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="git-diff-result"]').text()).toContain("不能据此判断目录干净");
  } finally { view.unmount(); }
});

it("同一项目切换任务重新读取目录；失效资源的原命令仍可核对但不能新读", async () => {
  const context = setup(); context.read.mockRejectedValue(new RelayTransportError("lost"));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="git-read-status"]').trigger("click"); await flush();
    const original = context.read.mock.calls[0]![0];
    context.loadResources.mockResolvedValue([]);
    await view.rerender(context.element("project-1", "task-2")); await flush();
    await view.wrapper.get('[data-testid="devtools-tab-GIT"]').trigger("click"); await flush();
    expect(context.loadResources).toHaveBeenCalledTimes(2);
    expect(view.wrapper.get('[data-testid="git-read-pending"]').text()).toContain(original.commandId);
    expect(view.wrapper.get('[data-testid="git-read-status"]').attributes("disabled")).toBeDefined();
    await view.wrapper.get('[data-testid="git-read-check-receipt"]').trigger("click"); await flush();
    expect(context.check).toHaveBeenLastCalledWith(original.commandId);
    expect(context.read).toHaveBeenCalledTimes(1);
  } finally { view.unmount(); }
});

it("执行输出的并行读取不会丢弃尚在途的受管目录配置", async () => {
  const context = setup(); let finish: (value: typeof resources) => void = () => undefined;
  context.loadResources.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  vi.spyOn(context.client, "getRunGatewayOperations").mockResolvedValue([]);
  const view = await mountReact(createElement(MemoryRouter, {}, createElement(DevToolsPanel, { client: context.client,
    projectId: "project-1", taskId: "task-1", run: { id: "run-1" } as RelayRun,
    previewBridge: null, previewScope: "workspace:conversation", onClose: () => undefined })));
  try {
    await view.wrapper.get('[data-testid="devtools-tab-OUTPUT"]').trigger("click"); await flush();
    await act(async () => finish(resources));
    await view.wrapper.get('[data-testid="devtools-tab-GIT"]').trigger("click"); await flush();
    expect(view.wrapper.get('[data-testid="git-read-resource"]').findAll("option")).toHaveLength(2);
    expect(view.wrapper.get('[data-testid="git-read-status"]').attributes("disabled")).toBeUndefined();
    expect(context.read).not.toHaveBeenCalled();
  } finally { view.unmount(); }
});

it("延迟结果属于原资源，切页不派发，切换项目后旧结果不污染新范围", async () => {
  const context = setup(); let finish: (value: RelayManagedGitReadResponse) => void = () => undefined;
  context.read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="git-read-status"]').trigger("click");
    expect(view.wrapper.get('[data-testid="git-read-pending"]').text()).toContain("正在读取");
    await view.wrapper.get('[data-testid="git-read-resource"]').setValue("resource-2");
    await act(async () => finish({ commandId: context.read.mock.calls[0]![0].commandId,
      committedAt: "2026-10-05T01:00:00Z", outcome: { state: "SUCCEEDED", actionType: "GIT_STATUS",
        operationId: "operation-1", invocationId: "invocation-1", result: { kind: "STATUS", branch: "old-branch",
          headCommit: null, staged: [], unstaged: [], untracked: [], limit: 200, truncated: false,
          totals: { staged: 0, unstaged: 0, untracked: 0 } } } }));
    expect(view.wrapper.find('[data-testid="git-status-result"]').exists()).toBe(false);
    await view.wrapper.get('[data-testid="devtools-tab-FILES"]').trigger("click");
    await view.wrapper.get('[data-testid="devtools-tab-GIT"]').trigger("click");
    expect(context.read).toHaveBeenCalledTimes(1);
    await view.rerender(context.element("project-2", "task-2")); await flush();
    await view.wrapper.get('[data-testid="devtools-tab-GIT"]').trigger("click"); await flush();
    expect(view.wrapper.find('[data-testid="git-status-result"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="git-read-pending"]').exists()).toBe(false);
  } finally { view.unmount(); }
});

it("只提供状态与差异只读入口，不含提交/推送/检出/重置/清理或自动解决冲突", async () => {
  const context = setup(); const view = await open(context);
  try {
    const labels = Array.from(view.wrapper.element?.querySelectorAll("button") ?? [])
      .map((button) => button.textContent ?? "");
    for (const forbidden of ["提交", "推送", "检出", "重置", "清理", "合并", "解决冲突", "回滚", "暂存"]) {
      expect(labels.some((label) => label.includes(forbidden))).toBe(false);
    }
    expect(labels).toContain("读取状态");
    expect(labels).toContain("读取差异");
  } finally { view.unmount(); }
});

it("含空格的相对路径不被本地拒绝，按原样派发差异读取", async () => {
  const context = setup(); const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="git-read-path"]').setValue("src/my file.ts");
    expect(view.wrapper.get('[data-testid="git-read-diff"]').attributes("disabled")).toBeUndefined();
    await view.wrapper.get('[data-testid="git-read-diff"]').trigger("click"); await flush();
    expect(context.read.mock.calls[0]?.[0]).toMatchObject({ actionType: "GIT_DIFF", relativePath: "src/my file.ts" });
  } finally { view.unmount(); }
});

it("受管目录在窗口打开后发生变化时如实反馈，不静默改读新根", async () => {
  const context = setup(); context.read.mockRejectedValue(problem("GATEWAY_RESOURCE_ROOT_CHANGED"));
  const view = await open(context);
  try {
    await view.wrapper.get('[data-testid="git-read-status"]').trigger("click"); await flush();
    const error = view.wrapper.get('[data-testid="git-read-error"]').text();
    expect(error).toContain("GATEWAY_RESOURCE_ROOT_CHANGED");
    expect(error).toContain("目录发生变化");
    expect(view.wrapper.find('[data-testid="git-status-clean"]').exists()).toBe(false);
  } finally { view.unmount(); }
});
