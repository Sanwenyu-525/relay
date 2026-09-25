# M01 独立验收记录

日期：2026-09-24。范围：现状基线与技术适配；不是生产 Runtime、React 页面迁移或 Windows 安装验收。当前模块状态仅维护在 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)。

## 文件基准与分工

实现、自检与修复由实际调用的 `gpt-6-sol / ultra` 执行者完成；本记录由协调 Agent 在其提交的冻结输入上独立核对并复跑。未创建初始 Git commit，不能用空 diff 证明无变更。

- 改造前基准：[489 文件 SHA-256 清单](../development/m01-source-baseline.sha256)。
- 独立检查输入：[240 文件 SHA-256 清单](../../experiments/m01-stack-adapter/results/independent-inputs.sha256)，清单 SHA-256 为 `5f2552a914851488f2d6b75e3ea56585bbcf50459ef15816a561fe88561227ae`。
- 执行者 READY 交付快照：[508 文件清单](../../experiments/m01-stack-adapter/results/m01-current-inputs.sha256)，SHA-256 为 `baaafa5a8b506a37654f4101f0d83c6c2f1eaae09dcf45f559827986b5edd231`；协调 Agent 在写入本次验收结论前逐项核对，508 项全部匹配。这是交付时点快照，之后的验收文档、状态更新和 M02 改动不回写历史快照。
- 223 个原有 `apps/` 输入核对中，唯一变化为 `apps/workbench/tests/screenshots/pages.spec.ts` 追加六项截图测试。原九项保留，业务源码、已有集成测试和十份 migration 均未改变。
- PG 实验运行器 SHA-256：`b783cb75047c9b05bb8e5162653b51ff20c20761a100c802ff96f0e51d63c1dc`；实验测试源码：`d42a37ce5025914658b8a8f9588cd249dfec719ffa75c8ba6e227a9da78d0b04`。其余确切输入由清单绑定。

## 独立复跑

环境：本机 Windows；显式使用项目便携 Node `24.21.0`、pnpm `9.15.9`、PostgreSQL `18.6`。数据库命令分别创建隔离临时集群，不连接用户数据库。Tauri 使用 Rust MSVC 工具链、VS Build Tools 与锁定 Cargo 依赖。

| 实际命令（仓库根目录，另注明者除外） | 退出码 / 结果 | 原始输出 |
|---|---|---|
| `powershell -NoProfile -ExecutionPolicy Bypass -File experiments/m01-stack-adapter/scripts/run-real-pg.ps1` | 0；3/3，无跳过 | [PG 适配](../../experiments/m01-stack-adapter/results/independent-real-pg.log) |
| `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile migration` | 0；7/7，无跳过 | [迁移](../../experiments/m01-stack-adapter/results/independent-migration.log) |
| `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile persistence` | 0；15/15，无跳过 | [持久化](../../experiments/m01-stack-adapter/results/independent-persistence.log) |
| 在实验目录，将便携 Node 目录前置 PATH，并运行 `D:/Develop/Relay-Agent/.research/runtime-cache/node-v24.21.0-win-x64/node.exe D:/Develop/Relay-Agent/.research/runtime-cache/node-v24.21.0-win-x64/node_modules/corepack/dist/corepack.js pnpm@9.15.9 run build:react` | 0；TypeScript 检查与 Vite 8.3.0 生产构建通过 | [React 样例构建](../../experiments/m01-stack-adapter/results/independent-react-build.log) |
| `powershell -NoProfile -ExecutionPolicy Bypass -File experiments/m01-stack-adapter/scripts/check-tauri.ps1` | 0；`cargo check --locked --target x86_64-pc-windows-msvc` 增量复验通过 | [Tauri 编译检查](../../experiments/m01-stack-adapter/results/independent-tauri-check.log) |
| `.research/runtime-cache/node-v24.21.0-win-x64/node.exe scripts/check-docs.mjs` | 0；70 Markdown、870 链接、865 锚点、126 token、29 对比度规则通过（放行前快照） | [文档检查](../../experiments/m01-stack-adapter/results/independent-docs-check.log) |

三次数据库运行均观察到测试退出 0、PG 停止退出 0 与临时集群删除成功。迁移/持久化包装器内的 TypeScript 构建、PG 启动也为 0。`initdb` 的中文 locale 文本搜索配置提示不影响这些测试，不能据此宣称中文全文检索通过。

## 反例与修复核对

1. 读取实际安装的官方 PostgresSaver `1.0.5` 源码：`setup()` 使用整数版本台账，DDL 与台账写入分开，没有 Relay 业务迁移的内容 SHA 校验与并发锁。实验使用固定 schema、安装身份单次初始化；生产接入必须保留独立迁移责任，不能由 Worker 调用 `setup()`。
2. 初稿给运行角色整个 checkpoint schema 的 DML，连带允许写 `checkpoint_migrations`。已交回执行者收窄为三个 checkpoint 数据表；独立复跑确认实际 DDL、台账更新均报 PG `42501`，恢复仍可成功。
3. PG 运行器初稿将 `pg_ctl start` 输出接管道，存在仓库旧脚本已记录的继承句柄等待问题。执行者移除该管道；独立运行的启动、测试与停止均正常返回。
4. 实验观察到中断节点恢复时重入，业务短事务已提交而图 checkpoint 未保存时业务节点也重放。两次节点执行仅留下一个稳定 `operation_id` 的业务效果；图重放本身不提供外部副作用 exactly-once。
5. 两个真实 PG 连接竞争 command/outbox，只有一个领取赢家；非占有者提交更新零行。同事务回滚不留下 command。既有持久化回归另外覆盖事务、约束、无损 bigint、回执与并发 payload 冲突。

## 证据边界与最终结论

结论：**ACCEPTED（仅 M01）**。现状/路由与 Owner 映射、原始源码和视觉基准、稳定依赖锁与发行/许可依据、真实 PG 事务/迁移/重放/领取排他、checkpoint 安装与保留决定、Windows 依赖方案和可复跑入口齐备。两个检查中发现的问题已由执行者修正并通过独立复验；M01 无未关闭的必需出口问题，可以推进 M02。

执行者全量旧基线为后端单测 57/57、真实 PG 集成 167/167、Vue 组件 110/110、Chromium 19/19、截图 15/15；已核对原始日志及输入摘要，未将这些自检结果冒充协调 Agent 全量复跑。独立复跑范围明确列于上表。[开发记录](../development/m01-stack-baseline.md)保存模块映射、许可证与上游依据；技术选型、部署、实验索引、复跑说明和当前状态已同步。

放行结论与导航更新后再次运行文档检查，退出 0；最终输出保存在 [放行后文档日志](../../experiments/m01-stack-adapter/results/independent-docs-final.log)。新增链接数量可与放行前快照不同，源码检查基准保持不变。

本实验以异常注入和重新建立 saver/graph 连接模拟恢复，没有强杀独立 Worker；M03 必须另以独立 API/Worker、Mock Provider 通过 G01–G08。probe schema 不是生产 Run/Task/Review 表，也不是第二套领域实现。React 最小样例与 Cargo check 不证明全部界面迁移、WebView 窗口、中文 IME、DPI、进程监管或安装升级通过。真实 Provider 未启用。
