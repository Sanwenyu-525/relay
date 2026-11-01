import { afterEach, expect, it, vi } from "vitest";
import { RelayApiClient, RelayApiError } from "../src/api/relayClient";
import { RelayContractError } from "../src/api/core/errors";
import { describeLiveRead } from "../src/lib/liveErrors";

/**
 * 会话导出这一发的读取侧（`GET /assist-sessions/:id/export`，任务书 §三、§四、§五）。
 *
 * 这里守的是「什么才算一份能拿去分析的导出」：
 *   1. **只认服务端文档。** 客户端不重拼、不精简，落盘的正文与读回来的投影同一份。
 *   2. **四件必须成立的事**（format、schema_version、会话身份、消息段落）缺一样就失败，
 *      不把一份来历不明的 JSON 存成会话证据；其余十九个段落**不做客户端校验**，
 *      否则服务端每加一列都得先改前端。
 *   3. **残缺要说出来。** 服务端在 `completeness` 里自己声明截断时，客户端只负责把它读成
 *      `partial`，界面上那句「部分导出」才有着落。
 *   4. **失败不冒充成功。** 404 有两种来处，说清是哪一种；任何失败都不产生文件（那一半由
 *      菜单用例核对）。
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "33333333-3333-4333-8333-000000000007";

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

function client(): RelayApiClient {
  return new RelayApiClient({ baseUrl: "http://127.0.0.1:8794", workspaceId, bearerToken: "test-only" });
}

/** 一份合规文档的最小形状：只带界面会核对的那几列。 */
const exportDocument = (over: Record<string, unknown> = {}) => ({
  format: "relay-session-export", schema_version: "1.0",
  exported_at: "2026-11-01T12:00:00.000Z",
  session: { id: sessionId, title: "要复盘的这段讨论", status: "ARCHIVED", revision: "9" },
  messages: [{ id: "message-1", role: "USER" }],
  ...over
});

afterEach(() => { vi.unstubAllGlobals(); });

it("原样交出服务端文档：正文一字不改，段落数与部分导出标记读自文档自身", async () => {
  const body = exportDocument({
    completeness: { messages: { truncated: true, exported: 2000, limit: 2000 } },
    tool_calls: [{ id: "call-1", status: "REJECTED", rejection_reason: "BUDGET_EXCEEDED" }]
  });
  vi.stubGlobal("fetch", vi.fn(async () => json(body)));
  const read = await client().exportAssistSessionDocument(sessionId);

  expect(read.schemaVersion).toBe("1.0");
  expect(read.sessionId).toBe(sessionId);
  expect(read.title).toBe("要复盘的这段讨论");
  expect(read.exportedAt.getTime()).toBe(new Date("2026-11-01T12:00:00.000Z").getTime());
  expect(read.messageCount).toBe(1);
  expect(read.partial).toBe(true);
  // 落盘正文 = 服务端投影本身：工具状态、拒绝原因这些证据一个字都不在界面上重拼。
  expect(JSON.parse(read.text)).toEqual(body);
  expect(read.text.endsWith("\n")).toBe(true);
});

it("空会话也是合法事实：messages 为空数组照样导出，不当成失败", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json(exportDocument({ messages: [] }))));
  const read = await client().exportAssistSessionDocument(sessionId);
  expect(read.messageCount).toBe(0);
  expect(read.partial).toBe(false);
  expect(JSON.parse(read.text).messages).toEqual([]);
});

it("来历不明的 JSON 一律不落盘：format／版本／会话身份／消息段落缺一即失败", async () => {
  const cases: readonly Record<string, unknown>[] = [
    { ...exportDocument(), format: "something-else" },
    { ...exportDocument(), schema_version: "" },
    { ...exportDocument(), schema_version: undefined },
    { ...exportDocument(), session: { id: "44444444-4444-4444-8444-444444444444", title: "别的会话" } },
    { ...exportDocument(), messages: undefined },
    { ...exportDocument(), exported_at: "不是时刻" },
    { detail: "会话不存在" }
  ];
  for (const caseBody of cases) {
    vi.stubGlobal("fetch", vi.fn(async () => json(caseBody)));
    await expect(client().exportAssistSessionDocument(sessionId)).rejects.toBeInstanceOf(RelayContractError);
    vi.unstubAllGlobals();
  }
});

it("未注册路由的 404 说清两种可能，会话不可见的 404 保留服务端原因", async () => {
  // 这一发没有任何 Relay code：Fastify 没匹配到路由，客户端只能看到裸 HTTP_ERROR。
  vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "请求的路径在当前服务上不存在。" }, 404)));
  const unregistered = await client().exportAssistSessionDocument(sessionId)
    .then(() => null).catch((caught: unknown) => caught);
  expect(unregistered).toBeInstanceOf(RelayContractError);
  const unregisteredText = (unregistered as RelayContractError).message;
  expect(unregisteredText).toContain("未注册路由的 404");
  // 分不清就不断言：两种可能一并写出来，并说明本次没有产生文件。
  expect(unregisteredText).toContain("导出没有产生任何文件");
  expect(describeLiveRead(unregistered)).toContain("未注册路由的 404");

  // 那一种：服务端认识这条路由，只是这个 Workspace 下读不到该会话——原因归服务端说。
  vi.stubGlobal("fetch", vi.fn(async () => json({ code: "RESOURCE_NOT_FOUND",
    detail: "会话在当前工作区不可见。" }, 404)));
  const notFound = await client().exportAssistSessionDocument(sessionId)
    .then(() => null).catch((caught: unknown) => caught);
  expect(notFound).toBeInstanceOf(RelayApiError);
});

it("只读失败的说法不提命令与回执：那是命令提交才有的东西", async () => {
  const cases: readonly { readonly body: unknown; readonly status: number }[] = [
    { status: 500, body: { code: "INTERNAL_ERROR", detail: "请求未能完成。", request_id: "req-export-1" } },
    { status: 503, body: { code: "DATABASE_UNAVAILABLE", detail: "数据库不可达。" } }
  ];
  for (const item of cases) {
    vi.stubGlobal("fetch", vi.fn(async () => json(item.body, item.status)));
    const caught = await client().exportAssistSessionDocument(sessionId)
      .then(() => null).catch((error: unknown) => error);
    const text = describeLiveRead(caught);
    expect(text).not.toMatch(/command|回执/u);
    vi.unstubAllGlobals();
  }
  // 数据库不可达这类原因本来就带「该做什么」，只读说法不把它抹平。
  vi.stubGlobal("fetch", vi.fn(async () => json(cases[1]?.body, 503)));
  const databaseDown = await client().exportAssistSessionDocument(sessionId)
    .then(() => null).catch((error: unknown) => error);
  expect(describeLiveRead(databaseDown)).toContain("RELAY_DB_URL");
});
