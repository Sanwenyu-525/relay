import { afterEach, expect, it, vi } from "vitest";
import { RelayContractError } from "../src/api/core/errors";
import { RelayApiClient } from "../src/api/relayClient";

const baseUrl = "http://127.0.0.1:8787";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "77777777-7777-4777-8777-777777777777";
const memoryId = "33333333-3333-4333-8333-333333333333";
const root = `${baseUrl}/api/v1/workspaces/${workspaceId}`;
const client = new RelayApiClient({ baseUrl, workspaceId, bearerToken: "test-bearer-token-0123456789abcdef" });

afterEach(() => vi.unstubAllGlobals());

function memory(overrides: Record<string, unknown> = {}) {
  return { id: memoryId, project_id: null, title: "约定", status: "ACTIVE", revision: "1",
    current_version: "1", text: "需要留存的事实", confirmed_by: "local-user",
    confirmed_at: "2026-10-01T00:00:00.000Z", expires_at: null,
    created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z", ...overrides };
}

function stub(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedUrl(fetchMock: ReturnType<typeof vi.fn>, index = 0): string {
  return String((fetchMock.mock.calls[index] as [RequestInfo | URL])[0]);
}

it("默认与 ALL 不发送 effective_status，四个枚举各自落到查询参数，并能与 project_id 组合", async () => {
  const cases = [
    { call: () => client.getMemories(), url: `${root}/memories` },
    { call: () => client.getMemories(null), url: `${root}/memories` },
    { call: () => client.getMemories(null, "ALL"), url: `${root}/memories` },
    { call: () => client.getMemories(projectId), url: `${root}/memories?project_id=${projectId}` },
    { call: () => client.getMemories(null, "ACTIVE"), url: `${root}/memories?effective_status=ACTIVE` },
    { call: () => client.getMemories(null, "EXPIRED"), url: `${root}/memories?effective_status=EXPIRED` },
    { call: () => client.getMemories(projectId, "RETIRED"),
      url: `${root}/memories?project_id=${projectId}&effective_status=RETIRED` }
  ] as const;
  for (const item of cases) {
    const fetchMock = stub([]);
    await item.call();
    expect(requestedUrl(fetchMock)).toBe(item.url);
    // 读列表只发 GET：筛选由服务端裁决，不写命令。
    expect((fetchMock.mock.calls[0]![1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  }
});

it("三态按已知枚举解析，旧服务端缺字段落为未知并保留原状态与有效期", async () => {
  stub([
    memory({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", effective_status: "ACTIVE" }),
    memory({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "ACTIVE",
      effective_status: "EXPIRED", expires_at: "2020-01-01T00:00:00.000Z" }),
    memory({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "RETIRED",
      effective_status: "RETIRED", expires_at: "2020-01-01T00:00:00.000Z" }),
    memory({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", expires_at: "2030-01-01T00:00:00.000Z" })
  ]);
  const rows = await client.getMemories();
  expect(rows.map((row) => row.effectiveStatus)).toEqual(["ACTIVE", "EXPIRED", "RETIRED", null]);
  // 未知不等于有效：原持久状态与到期信息照旧保留，供界面如实展示。
  expect(rows[3]).toMatchObject({ status: "ACTIVE", expiresAt: "2030-01-01T00:00:00.000Z" });
  expect(rows[2]).toMatchObject({ status: "RETIRED" });
});

it("未知枚举与显式 null 明确失败，不静默当成未知状态", async () => {
  for (const value of ["UNKNOWN", null, 1]) {
    stub([memory({ effective_status: value })]);
    await expect(client.getMemories()).rejects.toBeInstanceOf(RelayContractError);
  }
});

it("详情解析有效状态；历史修订保持不可变形状，不附加当前动态状态", async () => {
  stub(memory({ effective_status: "EXPIRED", status: "ACTIVE", expires_at: "2020-01-01T00:00:00.000Z" }));
  const detail = await client.getMemory(memoryId);
  expect(detail).toMatchObject({ status: "ACTIVE", effectiveStatus: "EXPIRED",
    expiresAt: "2020-01-01T00:00:00.000Z" });

  stub([{ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", memory_id: memoryId, version: "1",
    title: "约定", text: "历史正文", confirmed_by: "local-user",
    confirmed_at: "2026-10-01T00:00:00.000Z", expires_at: "2020-01-01T00:00:00.000Z",
    created_at: "2026-10-01T00:00:00.000Z",
    // 即使服务端误把动态状态塞进历史，也不能被当成这条修订的当前状态。
    effective_status: "ACTIVE" }]);
  const revisions = await client.getMemoryRevisions(memoryId);
  expect("effectiveStatus" in revisions[0]!).toBe(false);
  expect(revisions[0]).toMatchObject({ version: "1", expiresAt: "2020-01-01T00:00:00.000Z" });
});
