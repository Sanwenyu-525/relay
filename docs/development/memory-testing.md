# 长期记忆系统 V2：测试报告

本文记录 2026-11-15 本轮实际执行的测试与限制。测试通过只证明对应范围，不自动推广到真实 Provider、Windows、桌面安装或全量回归。

## 1. 运行方法

```powershell
# API 类型检查
cd D:\Develop\Relay-Agent\apps\api
pnpm run typecheck

# V2 单元测试（先构建）
pnpm exec tsc -p tsconfig.json
node --test dist/test/unit/memory-system-v2.test.js

# V2 真实 PG 集成测试（脚本会 build + 起临时 PG + 跑迁移 + 停库清理）
cd D:\Develop\Relay-Agent
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile memory-system-v2

# 既有长期记忆回归
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile memory-module

# Workbench 类型检查/定向测试（避免并行 worker 崩溃）
cd D:\Develop\Relay-Agent\apps\workbench
pnpm run typecheck
pnpm exec vitest run --no-file-parallelism tests/memoryStatus.spec.ts tests/memorySettings.spec.tsx tests/memoryStatusClient.spec.ts tests/memoryOrigin.spec.ts tests/memorySourceKind.spec.ts tests/memoryClient.spec.ts tests/memoryView.spec.tsx
```

## 2. 本轮实际结果

| 检查 | 结果 | 说明 |
|---|---|---|
| API `typecheck` | **PASS** | `tsc --noEmit` exit 0 |
| V2 单元 `memory-system-v2.test.ts` | **11/11 PASS** | 分词/tsquery、类型归一、key、hash、敏感、有效状态、置信度、类型提示、Jaccard、写前裁决 |
| V2 集成 `memory-system-v2.integration.test.ts` | **9/9 PASS** | 真实 PG18.6、临时集群，迁移含 0164/0166；含固定记忆不受 topK 截断、删除后召回为 0 |
| 既有 `memory-module.integration.test.ts` | **11/11 PASS** | 真实模型输入、关闭、作用域、来源撤销、问候不召回、短期隔离 |
| `memory-auto-capture.integration.test.ts` | **13/14 PASS** | 唯一失败 `ASSIST_FREE_MODEL_NO_LONGER_ELIGIBLE`：OpenRouter 测试条目被当前并行模型目录资格逻辑拒绝，与本轮记忆写入无关 |
| `context-compaction-threshold.integration.test.ts` | **7/9 PASS** | 2 条失败为并行 0165 上下文改造中的 `THRESHOLD→OVERFLOW`、`SESSION_TIER→UNKNOWN_FALLBACK` 期望变化，与本轮记忆代码无关 |
| Workbench `typecheck` | **PASS** | UI 改动后 exit 0 |
| 记忆相关 Workbench Vitest | **60/60 PASS** | 7 个文件，使用 `--no-file-parallelism` 避开 worker exit 134 |
| 导航 Vitest | **19/19 PASS** | `navigation.spec.ts` + `navigationPlacement.spec.tsx` |
| Workbench `build` | **PASS** | UI 一致性检查 + `tsc --noEmit` + Vite build exit 0；首次因 Node 堆不足 OOM，`NODE_OPTIONS=--max-old-space-size=8192` 后通过 |
| 全量 API 单元 | **不作为干净基线** | 本轮曾运行 1288 项，1264 通过、22 失败；其中 V2 的 3 条已修复，但全量未在最终代码重跑。不能宣称全量通过 |
| 全量 Workbench `pnpm test` | 未通过干净基线 | 并发 worker `exit 134`，非断言失败；定向 7 文件串行通过 |
| 浏览器 E2E / 截图 | 未运行 | 无明暗主题、窄窗、长内容视觉证据 |
| 性能基线 / 大数据检索 | 未运行 | 无延迟分布、Recall@K/Precision@K、GIN EXPLAIN |
| 文档检查 | 既有失败，无本轮新增 | `check-docs` exit 1：25 条历史证据链接缺失；Memory/ADR-041 新文档无缺失链接 |

## 3. 已覆盖场景

- 写入：显式创建、同内容重复拒绝、同键替代链、低可信冲突、敏感凭证拒绝、固定/取消固定、人工验证、修订不继承旧验证且清除旧陈旧标记；
- 作用域：项目隔离、工作空间记忆对项目可见、Task 不存在拒绝、Task 存在进入 TASK；
- 设置：新字段持久化、预算裁剪、topK、HYBRID 降级记录；
- 整理：确定性去重/同键合并、陈旧标记、索引回填、`memory_maintenance_runs` 真实运行；
- 数据：导出/导入、真实删除后列表/统计与召回均为 0；
- UI：列表/统计真实加载、筛选发起真实 GET、新建提交真实 POST、设置卡与导航；
- 既有：记忆进入真实模型输入、关闭后不召回、来源撤回、问候不误召回。

## 4. 未覆盖场景与已知限制

- 语义检索：没有 Embedding Provider 适配；`HYBRID` 当前只验证降级，不验证真实语义召回。
- Agent 作用域：只有数据库列与约束，无多 Agent 身份/共享模型，UI 不创建。
- 上下文压缩前的真实模型候选提取：未做真实 Provider 质量/成本测试；仅既有压缩链与记忆模块回归。
- 任务恢复：依赖既有 Checkpoint；未新增“记忆摘要替代工具状态”的反例测试。
- 并发压力：写入 advisory lock、多进程整理、索引重建中的并发未压测；`array_agg`/复合外键/`numAffectedRows` 未做专项数据库契约测试。
- 性能：无 10k/100k 记忆量下的检索延迟、索引计划与 Token 成本基线；不声称性能数字。
- 全量 UI：未验证暗色主题（产品当前无）、125%/150%/200% DPI、窄窗、长内容、浏览器 E2E 删除/导入/导出回执。
- 导入：本轮新增 task_id 保留与 UUID/作用域校验，但未补 Task 往返集成用例；项目/工作空间既有导入用例通过。
- 跨进程崩溃：未注入“根写入成功、索引失败”“进程退出 midway”“导入中断”等故障；依赖事务回滚，无专门恢复测试。
- 真实 Provider：无有效外部凭据，自动提取与压缩质量 BLOCKED；不把受控 Fake 当 Provider 验收。

## 5. 已知失败与归因

1. `memory-auto-capture` 的 OpenRouter 用例：当前模型目录资格逻辑在测试条目上返回 `ASSIST_FREE_MODEL_NO_LONGER_ELIGIBLE`。该用例是既有冻结路由回归，非 V2 记忆写入；本轮未改模型目录代码。
2. `context-compaction-threshold` 两条：期望 `THRESHOLD`/`SESSION_TIER`，实际 `OVERFLOW`/`UNKNOWN_FALLBACK`，与并行 0165 上下文改造同时间窗；本轮未改压缩代码。
3. 全量 Workbench 测试 worker `exit 134` 是运行环境/并发问题，定向串行 60/60 通过；不能据此说全量通过。
4. 全量 API 单元曾 22 失败；V2 相关 3 条已修，但其余未逐项复核，不能把 1264/1288 当作最终干净基线。

## 6. 证据边界

- “PASS”只对应表中命令与文件，不替代独立验收、桌面安装、真实 Provider 或全量回归。
- 真实 PG 集成测试的临时集群跑完即停并删除；迁移 `0164/0166` 已在该集群应用。
- 真实 UI 未启动浏览器；`MemoryView` 的两条 Vitest 使用真实客户端解析与 DOM，但 API 由请求桩提供，不替代真实 HTTP/浏览器。
