import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 生产构建的预览服务（只给 `playwright.prod.config.ts` 当 webServer 用）。
 *
 * 浏览器级隔离复验必须打真正的生产产物：开发服务器里 DEV 恒为真，怎么点都进得了实验室，
 * 拿它验「生产进不去」等于没验。所以这里先按 `NODE_ENV=production` 出一份产物，
 * 再用 `vite preview` 用产品自己的 SPA 回退规则端出来——路由落到哪个兜底页也和真实部署一致。
 *
 * 为什么不让 Playwright 直接写 `NODE_ENV=production vite build && vite preview`：
 * Windows 上 webServer 走的是 cmd，`VAR=value cmd` 前缀不生效，环境变量只能由 Node 自己设。
 */

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = join(appDir, "node_modules", "vite", "bin", "vite.js");
const outDir = join("node_modules", ".tmp", "scenario-lab-prod-web");
// 端口避开常用的 4173–4175：这台机器上并行跑着别的验收服务器，撞上了只会报「端口被占」，
// 分不清是自己的还是别人的。
const port = process.env.SCENARIO_LAB_PROD_PORT ?? "4180";

console.log("[prod-preview] 构建生产产物…");
const built = spawnSync(process.execPath, [viteBin, "build", "--mode", "production",
  "--outDir", outDir, "--emptyOutDir", "--logLevel", "warn"],
{ cwd: appDir, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } });
if (built.status !== 0) {
  console.error(`[prod-preview] 生产构建失败（退出码 ${String(built.status)}），预览无从谈起。`);
  process.exit(built.status ?? 2);
}

console.log(`[prod-preview] 在 127.0.0.1:${port} 预览 ${outDir}`);
const preview = spawn(process.execPath, [viteBin, "preview", "--outDir", outDir,
  "--host", "127.0.0.1", "--port", port, "--strictPort", "--logLevel", "warn"],
{ cwd: appDir, stdio: "inherit" });

// Playwright 结束时按进程树收尾；这里只把收到的停止信号转给 preview，别让构建脚本先退出留下孤儿端口。
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => preview.kill(signal));
preview.on("exit", (code) => process.exit(code ?? 0));
