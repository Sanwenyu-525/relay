import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * 把 UI 静态守卫接进默认 Vitest 套件（UI-UNIFY-02）。
 *
 * 此前只有人记得跑 `node scripts/check-ui-conventions.mjs` 才会发现裸色值、px 字号、
 * 第二套 token 或共享件重复定义；现在任何一次 `vitest run`（以及 `pnpm build`，见
 * apps/workbench/package.json）都会执行同一条检查。仓库没有 CI 工作流，构建入口就是
 * 本机事实上的 CI 门。
 */

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("UI 一致性守卫", () => {
  it("现状通过：无裸色值、无新增 px 字号、无第二套 token、无共享件重复定义", async () => {
    try {
      const { stdout } = await exec(process.execPath, ["scripts/check-ui-conventions.mjs"], { cwd: repoRoot, timeout: 60_000 });
      expect(stdout).toContain("UI 一致性检查通过");
      // 守卫真的跑了：组件层文件数与豁免登记都要在输出里，避免脚本空转也判过。
      expect(stdout).toContain("组件层文件：");
      expect(stdout).toContain("已登记豁免：");
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message: string };
      throw new Error(`check-ui-conventions 未通过：\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}\n${failure.message}`);
    }
  }, 60_000);
});
