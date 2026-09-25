# M01 技术适配实验

本目录是隔离实验，不是生产 React 入口、Worker 或桌面安装包。2026-09-23 至 2026-09-24 的开发自检记录见 [M01 开发记录](../../docs/development/m01-stack-baseline.md)；原始输出在 [results](results/)。固定输入为本目录的 `package.json`、`pnpm-lock.yaml`、`tauri-smoke/src-tauri/Cargo.toml`、`Cargo.lock` 与实验源码。根工作区的 Vue、API、既有 migration 均未迁成新栈。

## Windows 复跑

在仓库根目录运行 PowerShell。项目已经备有便携 Node 24.21.0、PostgreSQL 18.6；不要让 PATH 上的 Node 22 代替 Node 24。实验的 PG 脚本自建只绑定 loopback 的临时集群，创建独立随机数据库及 `relay_migrator` / `relay_app` 角色，结束时停止并删除**本次新建**的临时集群；输出 `temporary_cluster_removed=True` 才算清理成功。实验不连接用户数据库、真实模型或外部工具。

```powershell
Set-Location D:\Develop\Relay-Agent
$nodeBin = (Resolve-Path .research/runtime-cache/node-v24.21.0-win-x64).Path
$env:Path = "$nodeBin;$env:Path"
node --version
Set-Location experiments/m01-stack-adapter
pnpm install --ignore-workspace --frozen-lockfile
pnpm build:react
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-real-pg.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-tauri.ps1
```

预期为 Node `v24.21.0`，四个命令退出码均为 0；PG 测试 3/3，`pg_ctl` 停止退出 0、临时集群删除 `True`。`check-tauri.ps1` 使用 VS 2022 BuildTools 的 `VsDevCmd.bat` 和 `stable-x86_64-pc-windows-msvc`，对固定的 Rust core `2.11.6` / `tauri-build` `2.6.3` 执行 `cargo check --locked`。`tauri --version` 只证明 CLI `2.11.5` 可运行；`cargo check` 只证明最小宿主可编译，不是 WebView 窗口或安装验收。

旧工程同一便携 Node 环境可复跑：

```powershell
Set-Location D:\Develop\Relay-Agent\apps\api
pnpm test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-integration.ps1
Set-Location D:\Develop\Relay-Agent\apps\workbench
pnpm test
pnpm test:browser
pnpm build
pnpm screenshots
Set-Location D:\Develop\Relay-Agent
node scripts/check-docs.mjs
```

`apps/api/scripts/run-integration.ps1` 同样使用项目便携 PG 并汇报启停、构建与清理结果。浏览器和截图命令需要本项目已安装的 Playwright Chromium。旧页面的 15 张实际 Vue 截图、SHA 清单与测试输出在 `results/vue-screenshots/`、`results/vue-screenshots.sha256`、`results/legacy-workbench-screenshots.log`，供 M02 逐页对照；截图是 fixture/浏览器视觉基线，不是 Windows WebView、IME 或 DPI 验收。

## 验证的边界

- 官方 `PostgresSaver` 由**固定受信 schema** 的安装身份单次 `setup()`；运行身份只获三个 checkpoint 数据表 DML，实际 DDL 与 `checkpoint_migrations` 写入都被 PG `42501` 拒绝。其整数版本台账不继承 Relay 显式 SQL 的 SHA-256、事务和并发保护，正式接入需独立、串行的升级入口与兼容性检查。
- 官方 LangGraph 1.x 的 `interrupt` 在相同 `thread_id` 下恢复；中断节点之前的代码重入。业务事务提交后、图 checkpoint 之前注入错误，再重建 saver/graph 重放，固定 `operation_id` 的业务效果仅有一行。这里模拟异常及重新建连接，**没有强杀独立 Worker 进程**；生产进程恢复与外部效果 `UNKNOWN` 留给 M03。
- probe schema 中的 command 与 outbox 同事务提交/回滚；两个连接并发执行 `FOR UPDATE SKIP LOCKED` 仅一方领取，迟到/非 Owner 的条件更新为零行。probe 表不是领域表或将来的生产 schema；M03 须连现有 Run/Task/应用命令与领域 Owner。

上游参考 `pg-boss` 的固定源码位于 `.research/upstream/pg-boss`，锁定提交 `4e05af1eeaad3a645b16e3dd6c389fb4610ee0e9`。本实验对照其 `src/plans.ts` 的 `fetchNextJob`/`FOR UPDATE SKIP LOCKED`，采用 PG 领取机制而未引入 `pg-boss` 包或它的业务状态 Owner。准确采用关系见开发记录。
