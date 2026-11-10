# 长期记忆与上下文连续性跑通任务书

日期：2026-11-09。状态：**待执行**。本文件是执行提示词，不是已实施记录；成绩只写[统一功能验收表](../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)。授权：允许为跑通本模块做**最小产品代码修复**；不 commit/push，不扩展功能，不引入向量库。

## 1. 目标与「跑通」定义

让同一会话在「记忆召回、来源标注、上下文压力、压缩续跑、档位切换」下保持事实连续、不串读、不改写历史：

> 用户消息 → 字面命中才召回记忆 → 自动/手选来源分组标注 → 装配上下文 → 压力超阈值先整理再把原消息回队 → 压缩发布后继续同一逻辑轮 → 最终回复与用量可核对。

「跑通」必须同时满足：

1. 自动召回只收字面命中，问候/无关消息不得带入旧记忆；
2. 自动召回明确标注「不是用户本轮选择、不是本轮指令」，与手选资料分组；
3. 历史来源被撤销后下一轮不再注入；已冻结的旧消息来源只读保留，不回头改写；
4. 上下文压力先整理再续跑，整理前不发起主模型调用；压缩后沿用同一 assistant 消息身份；
5. 档位改变只影响新调用，旧调用按冻结预算解释；
6. Token 用量只统计 `purpose='PRIMARY'`，辅助调用不混入。

## 2. 开工检查与必读事实源

1. 读根 `AGENTS.md`、[CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)；验收表搜索 `BUG-CHAT-CONTEXT-CROSS-TALK`、`AGENT-CORE-RELIABILITY-V2`、长短期记忆与上下文压缩、`AGENT-LIVE-TOKEN-USAGE`、上下文用量与档位。
2. 读 [ADR-028](../docs/decisions/ADR-028-memory-layers.md)、[ADR-030](../docs/decisions/ADR-030-zero-click-auto-memory.md)、[ADR-032](../docs/decisions/ADR-032-memory-source-kind.md)、[ADR-037](../docs/decisions/ADR-037-session-context-budget.md)、[HTTP §10.99/§10.105/§10.120/§10.130](../docs/api/http-command-contract/part-07.md)。
3. `git status` 有大量未提交改动；本链相关文件包括 `memory-recall.ts`、`memory-auto-capture.ts`、`assist-memory.ts`、`assist-memory-runner.ts`、`buildGenerationInput`（`assist-runner.ts`）、`assist-source-content.ts`、`assist-commands.ts`、`assist-model-snapshot.ts`、`assist-context-projection.ts`、用量投影与相关测试。逐文件读 diff，不覆盖、不回退。
4. 行号可能移动；下表入口先 `rg` 复核。
5. 高开销前查磁盘；D 盘低于 15 GiB 或分区 10% 先报告。

## 3. 当前实现地图

| 环节 | 当前入口 | 关键事实 |
|---|---|---|
| 召回 | `apps/api/src/application/memory-recall.ts:6-17/19-53/35-41/44-49` | 有界字面词项；只收 `literal_match`；冻结 `origin/source_kind/selection_basis` |
| 召回 SQL | `apps/api/src/information/information-repository.ts:73-94/87-90` | 撤回来源排除；人工确认/来源类别排序 |
| 自动捕获 | `apps/api/src/application/memory-auto-capture.ts:40-61/78-105/125-133/244-333` | 严格解析；逐字引用核验；结算后提取；失败吞掉不改回复 |
| 捕获触发 | `apps/api/src/application/assist-runner.ts:604-614/1415-1430` | 单次生成与主循环均在结算之后 |
| 上下文装配 | `assist-runner.ts:1790-1981` | 自动召回 `:1815`；来源分组 `:1839-1849`；「不是本轮指令」`:1857-1862`；注入压力 `:1940-1944` |
| 来源段 | `apps/api/src/application/assist-source-content.ts:139-151` | 自动召回标记与来源类别表头 |
| 档位 | `apps/api/src/application/assist-commands.ts:74-88/101-138/141-142/281-283` | 继承优先级；三档 256K/512K/1024K；创建事务内落库 |
| 预算 | `apps/api/src/application/assist-model-snapshot.ts:35-43/315-327` | `planAssistModelBudget`；旧键兼容 |
| 投影 | `apps/api/src/application/assist-context-projection.ts:66-105` | 当前档位、最近调用、`next_call` |
| 压缩 | `apps/api/src/application/assist-memory.ts:32-50/63-82/109-124/139-203/271-295` | checkpoint 有效性、父链、批次游标、失败不自动重试 |
| 压缩执行 | `apps/api/src/application/assist-memory-runner.ts:94-121/122-285` | 领取、父检查点校验、质量门、CAS 发布 |
| 压力续跑 | `assist-runner.ts:1762-1774`；`assist-repository.ts:1180-1185` | 先整理再把原消息回队 |
| 用量 | `assist-usage-projection.ts:60-73/96`；`assist-context-usage.ts:25-30/97/152`；`live-preview.ts:13-55` | 六类分项；500ms 节流；四态汇总 |
| 用量查询 | `assist-queries.ts:201-227`；`model-call-repository.ts:342-357` | 只取 `purpose='PRIMARY'` |

## 4. 已验收范围与未闭合项

- **BUG-CHAT-CONTEXT-CROSS-TALK**（`CODEX_NEXT_STEP.md:31`）：实施者自检；真实 PG/HTTP `memory-auto-capture` 13/13、`memory-module` 11/11、`assist` 50/50；真实 Provider 是否仍误述未复验。
- **AGENT-CORE-RELIABILITY-V2**（`:20`）：已本地 commit、未独立验收；真实 PG + 真实文件 I/O `assist-file-context-v3` 4/4；真实 Provider 无有效凭据。
- **长短期记忆与上下文压缩**（验收表第 180 行）：实施者自检；真实 PG `assist-memory` 27/27、`context-budget-runtime` 5/5；真实 Provider 摘要/提取质量与成本未验；单个完整轮次装不下仍明确失败。
- **AGENT-LIVE-TOKEN-USAGE**（第 48 行）：自检；真实 PG/HTTP `assist-live-preview` 17/17；真实 Provider/Windows 未验；估算不等于计费。
- **上下文用量与档位**（第 62 行）：自检；迁移 0153 尚未应用到用户真实库；欢迎页移除圆环后真实 Chromium 未重跑；真实 Provider 多轮工具分项未复跑。
- 未闭合：历史来源撤销后的独立验收、记忆捕获超时专项、压缩恢复窗口真实 Provider、档位继承真实浏览器、独立验收。

## 5. 范围与非目标

**范围内**

- 字面召回、来源标注、自动捕获、上下文压力先整理再续跑、压缩后同一消息续跑、档位切换、PRIMARY 用量。
- 真实 PG/HTTP 与真实浏览器读回。

**范围外**

- 聊天工具循环、Task/Run 业务链、Provider 连接。
- 向量库/新检索系统、摘要协议重写、压缩算法重写、记忆 UI 重做。
- 用真实 Provider 质量结论替代受控测试；用估算值声明计费。
- 新表/迁移（除非先说明并获授权）。

## 6. 实施顺序

1. 真实 PG + 真实 API；先复跑 S1 字面召回与 S2 来源标注，确认不串读。
2. 依次跑 S3 自动捕获、S4 压力续跑、S5 压缩续跑、S6 档位切换、S7 用量投影。
3. 每个失败先定位到「召回 SQL/装配/来源冻结/压力判定/压缩发布/投影」哪一层；只改阻断点。
4. 每次修改重跑同一场景 + `memory-module`、`memory-auto-capture`、`assist-memory`、`session-context-budget`、`assist-live-preview` 定向用例。

## 7. 验收场景

### S1 字面召回（P0）

- 问候/无关消息：不得自动带入旧记忆；相关消息：只召回字面命中项。
- 断言：实际模型输入包含/不包含对应来源，不以「最近更新」冒充相关性。

### S2 来源标注（P0）

- 自动召回与手选资料同轮出现；断言分数组、分表头，自动召回带 `AUTO_MEMORY`、`selection_basis`、`origin`、`source_kind`，并写明「不是用户选择、不是本轮指令」。

### S3 自动捕获（P0）

- 一轮回复完成后提取；断言只读上一条 USER 原文 + 本轮助手正文；逐字引用核验；超限/解析失败放弃本轮，不改写回复。

### S4 压力续跑（P0）

- 注入资料超过 80% 阈值；断言先建自动整理请求并把原消息回队，整理前不发起主模型调用；整理完成后同一逻辑轮继续。

### S5 压缩续跑（P0）

- 触发压缩并发布 checkpoint；断言沿用同一 assistant message id/seq，不新建消息、不重放工具；父检查点/批次游标正确。

### S6 档位切换（P0）

- 256K→1024K；断言新调用按新档位冻结，旧调用/历史按原预算解释；改档不推进会话总修订。

### S7 用量投影（P0）

- 一轮多工具调用；断言只统计 `purpose='PRIMARY'`，辅助调用不混入；生成中估算与结算后账本不重复累计；四态标注正确。

## 8. 修复边界

- 记忆不是本轮指令；旧记忆不冒充用户选择。
- 历史只读：checkpoint 只切换工作窗口，原文保留。
- 不改写已冻结来源；缺 `origin/source_kind` 读为 `null/UNKNOWN`，不按记忆根回填。
- 失效/超限必须失败关闭；不截断工具协议、不重放动作。
- 不引入向量库；不改摘要协议；不用估算值声明计费。
- 不删除/弱化失败测试；不 commit/push。

## 9. 环境与证据

- PG：一次性临时集群；记录迁移版本（0125/0137/0145/0153/0155/0157/0159 等）。
- API：真实进程；记录端口、PID、构建来源。
- 证据目录：`tmp/MEMORY-CONTEXT-20261109/`；保存实际模型输入片段（脱敏）、来源元数据、压缩前后消息身份、用量账本。
- 真实 Provider 摘要/提取质量单独标注；受控模型证据不能替代。

## 10. 完成定义

1. S1–S7 在真实 PG/HTTP 通过；真实 Provider 质量项明确结果或 BLOCKED。
2. 定向回归：`memory-module`、`memory-auto-capture`、`assist-memory`、`session-context-budget`、`assist-live-preview`、`assist` 相关套件；`apps/api` 类型检查通过。
3. 没有改写历史来源、没有串读、没有把辅助调用混入本轮用量。
4. 验收表更新一行；`CODEX_NEXT_STEP` 只写当前状态与剩余限制。
5. 报告区分自检、独立验收、真实 Provider、Windows/安装态。

## 11. 已知基线与坑

- 自动记忆/标题是辅助调用，超时不影响主回复；不要把它算主链失败。
- 单个完整轮次装不下时明确失败是设计，不是可静默截断的缺陷。
- 迁移 0153/0159 可能尚未应用到用户真实库；用隔离库验证，不擅自升级用户库。
- 真实 Provider 的摘要/提取质量与成本没有证据，不要凭规则单测宣称产品级。
- 全量 Vitest 并行级联失败先做基线归因；13 条既有单元失败不是本轮引入。
