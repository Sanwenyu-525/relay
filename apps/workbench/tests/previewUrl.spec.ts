import { describe, expect, it } from "vitest";
import { checkPreviewUrl, previewDisplayUrl, previewOriginOf } from "../src/lib/previewUrl";

/**
 * 地址预检的规则表。
 *
 * 这些断言锁的是**产品规则**，不是字符串拼接：原生宿主 `PreviewUrlPolicy` 用同一套规则
 * 在创建容器和每一次导航（含重定向）时再判一次。两处必须一起改，否则用户会看到
 * 「前端放行、宿主拒绝」这种自相矛盾的反馈。
 */

describe("内置网页预览的地址预检", () => {
  it("接受普通公网与本机自建服务地址", () => {
    for (const address of [
      "https://example.com/a/b?c=d#e",
      "http://example.com",
      "https://例子.中国/路径",
      "http://127.0.0.1:3000/",
      "http://localhost:8080/dashboard",
      "  https://example.com  "
    ]) {
      expect(checkPreviewUrl(address).ok, address).toBe(true);
    }
  });

  it("拒绝非 http/https 协议与应用私有来源", () => {
    const cases: [string, string][] = [
      ["file:///C:/Windows/System32/drivers/etc/hosts", "UNSUPPORTED_SCHEME"],
      ["javascript:alert(1)", "UNSUPPORTED_SCHEME"],
      ["data:text/html,<script>alert(1)</script>", "UNSUPPORTED_SCHEME"],
      ["about:blank", "UNSUPPORTED_SCHEME"],
      ["http://tauri.localhost/", "APPLICATION_ORIGIN"],
      ["http://ipc.localhost/ipc", "APPLICATION_ORIGIN"]
    ];
    for (const [address, problem] of cases) {
      const checked = checkPreviewUrl(address);
      expect(checked.ok, address).toBe(false);
      if (!checked.ok) expect(checked.problem, address).toBe(problem);
    }
  });

  it("拒绝工作台前端开发服务器来源（它出现在桌面 capability 白名单里）", () => {
    for (const address of ["http://127.0.0.1:5173/", "http://localhost:5173/agent?x=1", "HTTP://127.0.0.1:5173/"]) {
      const checked = checkPreviewUrl(address);
      expect(checked.ok, address).toBe(false);
      if (!checked.ok) expect(checked.problem, address).toBe("WORKBENCH_ORIGIN");
    }
  });

  it("拒绝带用户名或密码的地址与残缺输入", () => {
    const cases: [string, string][] = [
      ["", "EMPTY"],
      ["   ", "EMPTY"],
      ["example.com", "MALFORMED"],
      ["http://user:pass@example.com/", "EMBEDDED_CREDENTIALS"],
      ["http://user@example.com/", "EMBEDDED_CREDENTIALS"]
    ];
    for (const [address, problem] of cases) {
      const checked = checkPreviewUrl(address);
      expect(checked.ok, address).toBe(false);
      if (!checked.ok) expect(checked.problem, address).toBe(problem);
    }
  });

  it("不把任意文本当搜索词，也不自动补协议", () => {
    // 首版只接受完整地址：猜错协议比让用户补三个字符更糟，且不做搜索引擎跳转。
    const checked = checkPreviewUrl("relay agent 文档");
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problem).toBe("MALFORMED");
  });

  it("接受时给出只含来源的安全描述，不保留 path 与 query", () => {
    const checked = checkPreviewUrl("https://example.com/patients/42?token=secret#x");
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.origin).toBe("https://example.com");
      expect(checked.origin.includes("token")).toBe(false);
      // 交给宿主导航的仍是完整地址：用户就是要打开那一页。
      expect(checked.url).toContain("/patients/42");
    }
  });

  it("来源提取对残缺或非 http 输入返回 null", () => {
    expect(previewOriginOf("https://example.com:8443/a?b=1")).toBe("https://example.com:8443");
    expect(previewOriginOf("https://example.com:443/a")).toBe("https://example.com");
    expect(previewOriginOf("javascript:alert(1)")).toBeNull();
    expect(previewOriginOf("http://user:pass@example.com/")).toBeNull();
    expect(previewOriginOf("")).toBeNull();
  });

  it("地址栏展示只去掉尾部斜杠", () => {
    expect(previewDisplayUrl("https://example.com/")).toBe("https://example.com");
    expect(previewDisplayUrl("https://example.com/a/")).toBe("https://example.com/a/");
    expect(previewDisplayUrl("/")).toBe("/");
  });
});
