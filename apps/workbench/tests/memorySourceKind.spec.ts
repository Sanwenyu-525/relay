import { describe, expect, it } from "vitest";

import { memoryFrom } from "../src/api/parse/information";
import { memorySourceRefFrom } from "../src/api/parse/memory";

/**
 * DEV-0042：来源类别在客户端的读法。
 *
 * 旧服务端没有 `source_kind` 时按 UNKNOWN 读——旧数据没有经过来源核验，
 * 不能当成用户原话；出现未知取值则显式失败，不悄悄当成某一类。
 */

const memoryRow = {
  id: "11111111-1111-4111-8111-111111111111",
  project_id: null,
  title: "数据库选型",
  origin: "AUTO_CAPTURE",
  source_kind: "USER_STATEMENT",
  status: "ACTIVE",
  effective_status: "ACTIVE",
  revision: "0",
  current_version: "1",
  text: "唯一业务数据库用 PostgreSQL。",
  confirmed_by: "auto-capture",
  confirmed_at: "2026-10-21T00:00:00.000Z",
  expires_at: null,
  created_at: "2026-10-21T00:00:00.000Z",
  updated_at: "2026-10-21T00:00:00.000Z"
};

describe("记忆来源类别", () => {
  it("条目按服务端给的类别读", () => {
    expect(memoryFrom(memoryRow).sourceKind).toBe("USER_STATEMENT");
    expect(memoryFrom({ ...memoryRow, source_kind: "MODEL_OBSERVATION" }).sourceKind)
      .toBe("MODEL_OBSERVATION");
    expect(memoryFrom({ ...memoryRow, source_kind: "MANUAL" }).sourceKind).toBe("MANUAL");
  });

  it("旧服务端缺字段按 UNKNOWN 读，不当成用户原话", () => {
    const { source_kind: _omitted, ...legacy } = memoryRow;
    expect(memoryFrom(legacy).sourceKind).toBe("UNKNOWN");
  });

  it("未知取值显式失败，不悄悄归到某一类", () => {
    expect(() => memoryFrom({ ...memoryRow, source_kind: "ROBOT" })).toThrow();
  });

  it("消息来源里的类别同样读；非记忆来源没有类别", () => {
    const base = {
      status: "AVAILABLE", kind: "MEMORY", root_id: "22222222-2222-4222-8222-222222222222",
      version: "1", source_ref: "memory:22222222-2222-4222-8222-222222222222:v1"
    };
    expect(memorySourceRefFrom({ ...base, origin: "AUTO_CAPTURE", source_kind: "MODEL_OBSERVATION" })
      .sourceKind).toBe("MODEL_OBSERVATION");
    expect(memorySourceRefFrom(base).sourceKind).toBe("UNKNOWN");
    expect(memorySourceRefFrom({ ...base, kind: "KNOWLEDGE", source_kind: "USER_STATEMENT" })
      .sourceKind).toBeNull();
  });
});
