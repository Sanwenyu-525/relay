# 上下文窗口与自动压缩配置重构实施报告（CONTEXT-WINDOW-0165）

日期：2026-11-15
范围：`D:\Develop\Relay-Agent` 的 API、Workbench、Desktop 白名单、迁移与测试
状态：**实施者自检通过；未独立验收，未 commit**
决策记录：[ADR-042](../decisions/ADR-042-model-context-vs-compaction-threshold.md)

## 1. 结论

本次把「模型真实上下文窗口」和「用户自动压缩阈值」彻底拆成两个参数：

- **模型窗口是能力参数**：只来自模型目录、高级能力声明 `context_window_tokens`、部署配置
  `RELAY_MODEL_CONTEXT_WINDOW`；都读不到时按 `262,144` 安全回退，并明确标
  `UNKNOWN_FALLBACK`，不冒充 1M。
- **压缩阈值是用户偏好**：默认 `350,000`，推荐 `256,000–400,000` 只是提示；模型窗口变大
  不会把用户阈值自动放大到 800K/900K。
- **系统负责安全保护**：有效窗口按十进制 `1,000,000` 收敛；实际生效阈值按模型安全输入
  预算收敛，但不改写用户保存值。
- 普通用户设置页不再有上下文窗口档位入口；只保留自动压缩开关、阈值输入/恢复默认。
  上下文浮层只读显示模型窗口与用户/生效阈值，并保留手动压缩。
- 旧会话、旧档位列与旧 `/context-budget` 端点为兼容保留；执行、压缩与审计不再读取它们。

最终实际运行结果：

| 检查 | 结果 |
|---|---|
| API TypeScript build（`tsc -p apps/api/tsconfig.json`） | exit 0 |
| API 上下文单元测试（4 个文件） | **49/49** |
| API 真实 PG18.6 集成测试（本轮最终批次） | **38/38**：`migration` 15/15、`context-compaction-threshold` 9/9、`context-budget-runtime` 5/5、`required-context-audit` 9/9 |
| API 真实 PG 回归（本轮前段） | `session-context-budget` **12/12** |
| Workbench TypeScript | exit 0 |
| Workbench build（一致性检查 + tsc + vite build） | exit 0 |
| Workbench 上下文 Vitest（6 个文件） | **50/50** |
| Workbench 真实 Chromium（设置 + 用量浮层） | **10/10** |
| 迁移 0165 专项断言 | 已加入 `migration`，随 15/15 通过 |

收尾复跑（文档写入后、未改代码）：API `tsc` exit 0 + 上下文单元 49/49；
Workbench `typecheck` exit 0 + 上下文 Vitest 50/50 + `build` exit 0。最终批次未重跑
`session-context-budget` 与 Chromium（代码未再变化，保留前段通过结果）。

## 2. 原有设计存在的问题

审查确认的根因不是「某个公式写错」，而是多个语义共用一个字段：

1. **会话档位同时充当模型能力、单次调用预算、压缩窗口和 UI 选择。**
   `assist_sessions.context_budget_tokens` 被压缩策略、记忆输入上限、执行预算共同读取。
   用户选 1M 会被误读成「模型支持 1M」；模型比档位小时又没有统一的真实窗口收敛点。
2. **模型窗口来源不一致。** 有的路径只读模型目录；有的路径读不到就按会话档位估算；
   部署配置和高级能力声明没有统一入口。模型切换后，预算与阈值可能仍沿用切换前的档位。
3. **普通用户被迫配置两个数。** 设置页有 `ContextBudgetCard` 三档（256K/512K/1024K），
   浮层里还有一份会话级三档与 CAS 保存；这些入口实际只影响压缩/预算，却看起来像
   「修改模型能力」。
4. **旧默认值会把默认阈值压到不可用。** 0143 的 `max_call_tokens=65,536` 会让默认 350K
   阈值在生效时被压到约 59K；如果不同时抬升连接默认，功能等于默认失效。
5. **快照丢失窗口来源。** `resolveBudgetCapacity` 只传 `modelWindowTokens`/
   `providerCallCapTokens`，漏传 `windowSource`；新快照即使来自部署配置，也会退化成
   `MODEL_CATALOG`。
6. **响应 schema 读旧枚举导致 500。** 审计应用层已返回
   `MODEL_CONTEXT_WINDOW|UNKNOWN_FALLBACK`，路由 schema 仍只允许
   `SESSION|WORKSPACE_TIER|APPLICATION_DEFAULT`，Fastify 序列化抛错，审计接口全部 500。
7. **作用域预算用 `reservation * 3` 会突破配置上限。** 1M 目标下得到 3M，超过连接/部署
   `max_scope_tokens` 的硬上限。
8. **迁移清单存在并行演进。** 0165 专项测试依赖 0164/0166 同批存在；迁移清单若只补
   0165 会因 `deepEqual` 与真实库不一致而失败，测试需同时覆盖并行迁移，但这不改变
   0165 的语义。

项目现有代码中**没有**名为 `contextWindowOverride`、`maxContextTokens`、
`compressionThresholdPercent` 的用户配置字段；模型目录供应商返回的 `context_length`
已经由 `resolveCatalogEntry` 落为 `context_window`，属于模型能力来源，不是用户配置。
因此需要迁移的旧用户配置只有旧绝对档位 `context_budget_tokens`（256K/512K/1024K）和旧连接
预算默认，不存在「百分比阈值换算」这一步，也没有伪造一个不存在的迁移。

## 3. 最终语义与预算计算

### 3.1 模型容量

`apps/api/src/application/model-context-window.ts` 统一定义：

```text
目标容量 target            = 1,000,000（十进制，不是 1,048,576）
模型窗口 modelWindow       = 目录 / 高级能力声明 / 部署配置；都没有 = null
未知安全回退 fallback       = 262,144
服务商单次上限 providerCap = 连接或部署配置的 max_call_tokens
有效窗口 effectiveWindow   = min(target, modelWindow ?? fallback, providerCap ?? modelWindow ?? fallback)
```

窗口来源只有四值：

| 值 | 含义 |
|---|---|
| `MODEL_CATALOG` | 模型目录中的已验证窗口 |
| `CAPABILITY_DECLARATION` | `model_capability_declarations.context_window_tokens` |
| `MODEL_CONFIG` | 部署配置 `RELAY_MODEL_CONTEXT_WINDOW` |
| `UNKNOWN_FALLBACK` | 读不到，按 262,144 回退 |

每次解析记录 `model_context_window_resolved`（scope、model、窗口、来源、有效窗口、服务商
上限、是否回退）；目录/声明读取失败只 `warn`，不把观察失败升级成业务失败；部署配置校验
`16,384–4,000,000`。

### 3.2 自动压缩策略

`apps/api/src/application/assist-context-policy.ts`：

```text
用户阈值 requested = 保存值（合法 16,384–1,000,000）或默认 350,000
输出预留           = 连接/配置 max_output_tokens，缺省 8,192
协议/工具预留       = 8,192
安全预留           = ceil(effectiveWindow × 5%)
安全输入 safeInput  = max(1, effectiveWindow − 输出预留 − 协议预留 − 安全预留)

实际生效阈值 effectiveThreshold
  = max(1, min(requested, floor(safeInput × 0.9)))
压缩后目标 = min(100,000, floor(effectiveThreshold / 2))
```

`0.9` 是**触发余量**：让自动压缩先于硬上限发生；安全输入本身已经扣除输出、协议和 5%
预留，没有把同一笔输出重复扣两次。真正跳过阈值的极端输入由溢出保护处理：即使关闭普通
自动压缩，触及安全输入也必须先压缩；压不动时明确中止，不静默丢消息。

### 3.3 单次调用预算

`planAssistModelBudget` 使用与压缩同一个 `resolveEffectiveModelWindow`：

```text
callReservationTokens = effectiveWindow
scopeTokenLimit        = max(callReservationTokens, 配置 max_scope_tokens)
```

不再使用 `reservation × 3`。冻结快照中旧键 `context_budget_tokens` 保留，但语义改为
「本次实际申请容量」；新增 `model_context_window_tokens`、`provider_call_cap_tokens`、
`context_window_source`、`budget_basis`（`MODEL_CONTEXT_WINDOW` / `LEGACY_SESSION_TIER`）、
`fallback_applied`。旧快照缺 `budget_basis` 仍按 LEGACY 复核，避免升级前在途消息被误判为
配置改变。

### 3.4 压缩后的任务连续性

复用 0162 已有的检查点与质量门，不改压缩摘要的职责边界：

- 保留最近原文与检查点；摘要固定分段包含当前目标/范围、有效约束、项目约束、已确认决策、
  已完成工作与修改文件、已验证进展、未完成事项与下一步、未决/失败/UNKNOWN、执行状态、
  Git 工作区、来源引用。
- 工具调用与结果之间的关联由既有检查点消息结构保持；摘要只保留必要引用与路径，不把
  工具正文扩散成第二份事实。
- 摘要失败/无候选轮次时保留原文并明确中止，不伪造「压缩完成」。

## 4. 修改与新增文件

### API

- 新增 `apps/api/src/application/model-context-window.ts`：常量、来源类型、有效窗口解析、
  会话/连接/按模型容量读取、日志。
- 新增迁移 `apps/api/migrations/0165_model_context_window_capacity.sql`。
- 预算/快照/压缩：`assist-context-policy.ts`、`assist-model-snapshot.ts`、
  `assist-context-projection.ts`、`assist-memory.ts`、`assist-memory-runner.ts`、
  `required-context-files.ts`。
- 模型与连接：`model-connection-runtime.ts`、`run-model-port.ts`、`model-connections.ts`、
  `workflow/model-port-config.ts`、`model/model-capability-repository.ts`、`api/model-api.ts`。
- 设置与旧入口：`memory-settings.ts`、`api/assist-api.ts`（旧 `/context-budget` 保留，
  不再影响预算）。
- API 响应：`api/required-context-api.ts`（`call_budget_source` 新枚举）。
- 数据库类型：`infrastructure/database-schema.ts` 的 `context_window_tokens` 列。

### Desktop

- `apps/desktop/src-tauri/src/lib.rs`：环境变量白名单加入 `RELAY_MODEL_CONTEXT_WINDOW`。

### Workbench

- `ContextUsagePanel.tsx` / `.css`：去掉三档单选与 CAS 保存；改为只读窗口/阈值/距离/
  压缩结果；增加无会话最小态；圆环分母改为 `effectiveWindowTokens`。
- `SettingsView.tsx`：移除 `ContextBudgetCard` 引用；`ContextBudgetCard.tsx` 与
  `ContextBudgetCard.css` 一并删除（无其他引用）。
- `MemorySettingsCard.tsx` / `.css`：文案改为「自动上下文压缩」「自动压缩阈值」，说明默认
  350K、推荐区间仅提示、超安全容量时生效值收敛且不改写保存值。
- `ContextRiskNotice.tsx`：显示「实际可用窗口」，不再用旧档位。
- `AssistView.tsx`：圆环分母改为 `compaction.effectiveWindowTokens`，移除 `onSaved` 与
  `contextBudgetTokens` 依赖。
- API 层：`api/dtos/assist.ts`、`api/parse/assist.ts`、`api/resources/requiredContext.ts`。

### 测试

- 新增 `apps/api/test/unit/model-context-window.test.ts`。
- 改：`context-compaction-policy.test.ts`、`assist-model-budget.test.ts`、
  `required-context-files.test.ts`、`session-context-budget.integration.test.ts`、
  `context-compaction-threshold.integration.test.ts`、`context-budget-runtime.integration.test.ts`、
  `required-context-audit.integration.test.ts`、`migration.integration.test.ts`。
- Workbench 改：`contextUsageFixture.ts`、`contextUsagePanel.spec.tsx`、
  `contextCompactionPanel.spec.tsx`、`contextBudgetInheritance.spec.tsx`、
  `contextBudgetSourceEdgeCases.spec.tsx`、`contextRiskNotice.spec.tsx`、
  `uiLayers.spec.tsx`；删除 `contextBudget.spec.tsx`、
  `contextBudgetP0Boundaries.spec.tsx`、`contextBudgetPendingIdempotency.spec.tsx`（三档功能已删）。
- 浏览器：重写 `tests/browser/contextBudget.spec.ts`、
  `tests/browser/contextUsagePanel.spec.ts`，不再测已删除的三档。

## 5. 迁移与旧配置

`0165_model_context_window_capacity.sql`：

1. `model_capability_declarations` 新增 `context_window_tokens integer` + CHECK
   `16,384–4,000,000` + COMMENT；NULL = 未声明。
2. 仅当 `max_call_tokens=65,536` 且 `max_scope_tokens=262,144` 时，把连接抬到
   `1,048,576`；两列的默认也改为 `1,048,576`。这是连接硬上限的出厂上界，真正产品目标
   `1,000,000` 由解析时 `min(target, ...)` 表达；任何被用户显式改过的列不被回填。
3. 给 `assist_sessions.context_budget_tokens/context_budget_revision` 与
   `workspace_default_directories.context_budget_tokens` 加 `LEGACY（0165）` 注释。
4. 不删列、不把旧档位值转成压缩阈值；旧客户端读写仍兼容。

旧设置 `workspace_memory_settings.compaction_threshold_tokens` 保持原值/默认；旧绝对阈值
优先保留。没有百分比字段，因此没有可执行的百分比换算。

## 6. 日志

统一走 `context-compaction`：

- 窗口识别：`model_context_window_resolved`、`context_window_config_invalid`、
  `context_window_catalog_lookup_failed`、`context_window_declaration_lookup_failed`。
- 压缩：`context_compaction`/请求生命周期事件记录 `requested`、`effective`、`tokens_before`、
  `tokens_after`、`success`、`threshold_clamped`、`budget_unmet` 等；只写身份、触发方式、
  模型与 token 读数，不写摘要正文、对话正文或凭据。

## 7. 实际测试记录

### 7.1 API

```powershell
node .research/runtime-cache/node-v24.21.0-win-x64/node.exe \
  apps/api/node_modules/typescript/bin/tsc -p apps/api/tsconfig.json
# exit 0

node .research/runtime-cache/node-v24.21.0-win-x64/node.exe --test \
  apps/api/dist/test/unit/model-context-window.test.js \
  apps/api/dist/test/unit/context-compaction-policy.test.js \
  apps/api/dist/test/unit/assist-model-budget.test.js \
  apps/api/dist/test/unit/required-context-files.test.js
# tests 49, pass 49, fail 0
```

真实 PG18.6（一次性临时集群，`relay_migrator`/`relay_app` 非超级用户）：

```powershell
pwsh -NoProfile -File apps/api/scripts/run-integration.ps1 -SkipBuild \
  -TestFile 'migration,context-compaction-threshold,context-budget-runtime,required-context-audit'
# status: PASSED
# migration 15/15, context-compaction-threshold 9/9,
# context-budget-runtime 5/5, required-context-audit 9/9
```

本轮前段同一环境已跑 `session-context-budget` **12/12**；最终批次未重复该文件。

### 7.2 Workbench

```powershell
corepack pnpm --dir apps/workbench run typecheck   # exit 0
corepack pnpm --dir apps/workbench run build       # exit 0
corepack pnpm --dir apps/workbench exec vitest run \
  tests/contextUsagePanel.spec.tsx tests/contextCompactionPanel.spec.tsx \
  tests/contextBudgetInheritance.spec.tsx tests/contextBudgetSourceEdgeCases.spec.tsx \
  tests/contextRiskNotice.spec.tsx tests/uiLayers.spec.tsx --maxWorkers=1
# Test Files 6 passed, Tests 50 passed
```

真实 Chromium：

```powershell
corepack pnpm --dir apps/workbench exec playwright test \
  tests/browser/contextBudget.spec.ts tests/browser/contextUsagePanel.spec.ts \
  --workers=1 --reporter=list
# 10 条用例均输出 ok；本机 webServer 子进程未自动退出，人工停止后收尾
```

浏览器覆盖：阈值默认/400K 保存/恢复默认/非法输入；无窗口编辑入口；模型窗口只读与来源；
未知窗口 262,144 回退；无档位单选；560px 几何；与模型下拉互斥/Esc/点外；手动压缩受理
与禁重；空白新会话无圆环；六类分项颜色与中性文本。

### 7.3 文档一致性

`node scripts/check-docs.mjs`：Markdown 333 个、链接 7838 个、标题锚点 5821 个；**exit 1，
25 个错误全部是既有历史证据文件缺失**（`m02-react-migration`、旧前端预览截图、
2026-10-01 UI review、2026-10-18 本地目录访问、frontend-backend-acceptance、m03 证据），
本轮新增/修改的 ADR-042、实施报告、验收表、HTTP §10.137 与工作台 §40.3 **0 新增错误**。
未删除或改写历史检查来取得通过。

## 8. 未解决问题与风险

1. **真实 Provider / 真实分词器未验。** 本轮 token 读数仍是「Provider 实报基线 +
   UTF-8 字节 ÷ 3 增量」；真实窗口声明、超长窗口模型与真实 API 的 `input_tokens` 语义需
   另行复验。受控 Fake/固定 usage 不能替代真实 Provider 证明。
2. **未知窗口的安全回退会压低默认阈值。** 262,144 窗口中，默认 350K 会被收敛到约 209K；
   这是安全预算的预期结果，不是 bug，但界面必须持续显示「实际生效 / 原因」。
3. **迁移只回填完全等于旧双默认的连接。** 只改过一列的用户保持原值，可能仍低于 1M；
   这是为了保护显式配置，不能静默放大。
4. **DB 连接默认是 1,048,576，不是 1,000,000。** 产品目标由 `MODEL_CONTEXT_TARGET_TOKENS`
   在解析时 `min` 到 1M，因此有效窗口不越界；但两处数字并存需要后续用注释/迁移进一步
   收敛，避免读者误以为默认目标就是二进制 MiB。
5. **按模型审计的 provider 默认值。** `readModelContextCapacityByModel` 默认
   `openai-compatible`；OpenRouter/Anthropic 的高级声明在未传 provider 的调用点可能不命中。
   当前主要路径（会话/连接）已带 provider，风险局限于按模型审计。
6. **无会话且无进程配置时依赖 `modelHint`。** 部分 API 路由没有传 `modelHint`，会走未知
   回退；这是保守行为，但会降低默认阈值的可用范围。
7. **旧 `/context-budget` 与旧档位继承仍可写但不影响预算。** 设置页已删除入口，但新建
   会话从来源会话继承旧档位字段的兼容路径仍在（只存值，不参与执行/压缩/审计）；为避免
   破坏旧客户端保留，需后续标 Deprecated 并确认没有调用方继续把它当窗口设置。
8. **Workbench 全量单测不能作干净基线。** 当前工作树有大量并行未提交改动，全量并行运行
   出现过与本任务无关的超时/act 失败；本报告只用定点 50/50 与 build/typecheck 证据，不把
   全量结果冒充通过。
9. **Playwright 运行器收尾问题。** 10 条断言全部通过，但本机 Playwright webServer 子进程
   未自动退出，需人工停止；未归因为产品缺陷，但会影响 CI 收尾，建议后续把 webServer
   命令改为直接 node/vite 并单独验证退出码。
10. **未独立验收、未 commit。** 本轮是实施者自检；真实 Windows/WebView2、安装态、
   真实 Provider、独立验收均未做。

## 9. 基线修复与验证缺口

- 修复的真实缺陷：`resolveBudgetCapacity` 漏传 `windowSource`（CB-03 从错误的
  `MODEL_CATALOG` 改为 `MODEL_CONFIG`）；`required-context-api` 旧枚举导致 500；
  `scopeTokenLimit=reservation*3` 突破上限；`ALL_MIGRATIONS` 清单过期。
- 测试侧修正：`context-budget-runtime` 的 280K 用例补传 1M `modelEnv`；
  `context-compaction-threshold` 的「压后仍超预算」夹具原来只有 7 条已完成大正文，
  实际约 100.8 万 tokens 才真正超过 933,616 安全输入，已按真实预算重写并复跑。
- 浏览器测试夹具原来的 camelCase DTO 直接塞进 `json()` 会被解析器读成缺字段；新增
  `contextCompactionWireFixture` 明确线上 snake_case 形状，避免测试误判。

## 10. 后续建议

1. 用真实 Provider（至少一个 128K、一个 1M、一个窗口未知模型）复验窗口解析、阈值收敛与
   分词器计数。
2. 收敛 DB 连接默认值与产品目标常量，或在 0167 中明确 `1,048,576` 只是硬上限、不是目标。
3. 给旧 `/context-budget` 标 Deprecated，并检查前端/脚本是否仍有调用。
4. 修复 Playwright webServer 退出，纳入 CI 验证。
5. 在真实 Windows/WebView2 安装态验证设置页、浮层、手动压缩与重启恢复。
6. 做一次独立验收；本报告只能作为实施者自检证据。
