# 缓存命中率与上下文占用的诚实舍入

日期：2026-10-04。状态：设计已批准，待实施。

## 1. 问题

输入区底栏 `ContextMeter`（`apps/workbench/src/views/AssistView.tsx:438`）用 `Math.round` 输出两个百分比。命中率一处在第 445 行，上下文占用一处在第 440 行。

`Math.round(hitRate * 100)` 会把 `inputTokens=1000, cacheReadTokens=996` 显示成「缓存命中 100%」。实际有 4 个 token 未命中，显示 100% 是错的，且方向最坏：读者以为前缀复用完美，实际不是。这违反 AGENTS.md「缓存与推断须可追溯，不能冒充已确认事实」。

同一表达式还允许 `cacheReadTokens > inputTokens` 时显示 `105%`，即显示一个分母之外的比率。

## 2. 已确认的前提

分母语义经源码核对，不是推测：

- `apps/api/src/workflow/model-port-verify.ts:198` 读 `usage.prompt_tokens`；LangChain 路径读 `usage_metadata.input_tokens`（`openai-compatible-model-port.ts:232`）。两者都**包含** cached 部分。
- 迁移 `0049_m04_model_call_cache_usage.sql:8-11` 的 `ck_model_calls_cache_within_input` 约束 `cache_read + cache_creation <= input_tokens`，与子集语义一致。

因此 `inputTokens` 是正确分母。

上游 deepseek-harness 的 `formatCacheHitPercent`（`packages/client/ui-chat/src/client/chat/token-format.ts:67`）分母是 `uncachedInput + cacheRead + cacheWrite` 三桶之和。该式在 DSH 成立是因为 DeepSeek 原生 API 的 cache 与 input 互斥，与 Relay 的子集语义相反。**不照抄其分母**，只借鉴「不让部分命中显示成 100」这个意图。

Codex（`e7ea5f4a`）只有 `cached_input_tokens` 计数，无任何比率计算，TUI 用 `(8.1K cached)` 括号形式。无参考价值。

## 3. 方案

在 `AssistView.tsx` 内加一个模块级纯函数，不新建文件（只有这一处调用；AGENTS.md 禁止无当前调用方的占位模块）。

```
formatUsagePercent(value: number, limit: number): string
```

行为：

| 条件 | 返回 |
|---|---|
| `value === limit` | `"100"` |
| 整数百分比 < 100 | 整数字符串（`75` → `"75"`），现有展示不变 |
| 整数百分比会进位到 100 但未满 | 追加小数位至不显示 100（`99.6` → `"99.6"`，`99.96` → `"99.96"`），最多 2 位 |
| `value > limit` | `"100"` |

内部辅助函数用整数运算求「不溢出的最小小数位数」，避免浮点边界问题。

调用点两处：

- 命中率：`cacheReadTokens / inputTokens`。
- 上下文占用：已有 `ratio`。保留 `Math.min(1, ...)` 钳制 —— 它钳的是 `strokeDasharray` 绘制比例（弧长不能超过整圈），不是文案。

现有 null 语义不变：Provider 未上报显示「缓存未采集」，无调用显示「尚无模型调用」，`inputTokens` 为 0 或 null 时命中率不计算。

## 4. 语义不对称（有意保留）

上下文占用同样用诚实舍进，但两者语义不同：命中率 100% 意味着前缀复用完美；占用 100% 意味着上下文将满。占用显示 `99.6%` 的额外信息量有限，`100%` 更能表达「快满了」。

用户已确认两处都要改，故统一处理。该不对称记在此处，不在代码注释里解释推理。

## 5. 不改动

- `apps/workbench/src/components/CollaborationSplitter.tsx:45` 的 `Math.round(ratio * 100)` —— 拖拽布局比例，不是模型用量指标。
- API、数据库、Provider 适配、命令 Owner、权限。缓存用量早已入库（迁移 0049）并经 `assist-api.ts:57-58` 透传。
- `design-tokens.json` 不新增数值 —— 只改算法，不改视觉。
- `assist-cache-hit` 的 `data-testid` 与现有文案形态。

**Breaking Change：No** —— HTTP 契约不变，无字段增删。

## 6. 测试

`apps/workbench/tests/collaborationWorkspace.spec.ts` 场景表（现第 536-548 行）加两条：

1. 假 100% 反例：`input_tokens: 1000, cache_read_tokens: 996` → 断言 `缓存命中 99.6%`。先写测试确认在当前实现下失败，再改实现。这是本轮唯一行为差异点。
2. 上限钳制反例：`input_tokens: 1000, cache_read_tokens: 1200` → 断言 `缓存命中 100%`。

现有四条场景（`75%`、`未采集` ×2、`尚无模型调用`）在诚实舍入下结果不变，作为回归保护不动。

## 7. 验证出口

- typecheck exit0
- 组件回归（固定 Node v24.21.0、单 worker；见 CODEX_NEXT_STEP 第 52 行的复跑口径）
- 生产构建通过

真实 Windows 窗口观感、浏览器验证、真实 Provider 读数本轮不做。成绩归 `docs/testing/overall-acceptance-2026-09-28.md`，规则归 `docs/frontend/workbench-design.md`，本设计不登记通过结论。