import { describe, expect, it } from "vitest";
import { compareDecimalRevisions, incrementDecimalRevision } from "../src/lib/decimalRevision";

describe("十进制 revision", () => {
  it("超过 Number 安全整数范围时仍能精确比较与递增", () => {
    const current = "9007199254740992";
    const next = "9007199254740993";

    expect(compareDecimalRevisions(next, current)).toBe(1);
    expect(compareDecimalRevisions(current, next)).toBe(-1);
    expect(incrementDecimalRevision(current)).toBe(next);
  });
});
