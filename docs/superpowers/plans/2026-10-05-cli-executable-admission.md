# CLI 可执行文件准入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「谁来决定跑哪个可执行文件」从解释模型手里交回给用户：冻结检查时，可执行文件必须位于受管根内，或位于用户在 CLI_RUN 连接上显式配置的允许清单内。

**Architecture:** 新增一个纯函数 `evaluateExecutableAdmission`，作为可执行文件准入的唯一判定，与既有 `evaluateScopeGrant` 同构——判定只用持久化事实（授权行 + 连接 config），prepare 与 admit 调用同一函数因此必然同结论。允许清单存在既有 `gateway_connections.config` JSONB 列（root-bound 连接当前是 `{ root_path }`），**不需要新迁移**。

**Tech Stack:** TypeScript、Kysely、PostgreSQL 18、Node 24.21.0（`.research/runtime-cache`）、`node:test`。

**Spec:** 本文件即规格来源。业务不变量归 `contracts/01-04`；设计归 `docs/architecture/tool-adapters.md`；HTTP 面归 `docs/api/http-command-contract.md`；验收结果只归 `docs/testing/overall-acceptance-2026-09-28.md`。

## Global Constraints

- 固定 Node **24.21.0**（`.research/runtime-cache/node-v24.21.0-win-x64/node.exe`），不是 PATH 上的 `node`。
- TypeScript 在 **`apps/api/node_modules/typescript/bin/tsc`**，不在仓库根。根目录下 `node_modules/typescript` 不存在。
- 项目级 `tsc -p apps/api/tsconfig.json` 当前为**红**（在途并行 Agent 的 `bot-profile-commands.ts`、`persona-bot-session.integration.test.ts`）。**不要去修它**（AGENTS.md：不覆盖他人未提交改动）。范围化验证用：
  ```
  & .research\runtime-cache\node-v24.21.0-win-x64\node.exe apps/api/node_modules/typescript/bin/tsc `
    --target ES2024 --lib ES2024 --module NodeNext --moduleResolution NodeNext `
    --typeRoots apps/api/node_modules/@types --types node --strict --noUncheckedIndexedAccess `
    --exactOptionalPropertyTypes --noImplicitOverride --noFallthroughCasesInSwitch `
    --useUnknownInCatchVariables --verbatimModuleSyntax --skipLibCheck `
    --rootDir apps/api --outDir $env:TEMP\relay-scoped-dist <本任务的 .ts 文件...>
  ```
  **注意**：只列本任务真正需要的文件。多列一个 `gateway-configuration.ts` 就会把 `kysely` 拖进依赖图，而输出目录在 `%TEMP%` 下解析不到 `node_modules`，运行会以 `ERR_MODULE_NOT_FOUND` 失败。
- 集成测试入口：`powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile <name> -UseCLocale`。**不得用管道 `| Select-Object -Last N` 观察退出码**——提前终止流水线会让外层报 1，即使脚本自身 `exit 0`。写文件再读 `$LASTEXITCODE`。
- 不新增依赖。不新增迁移（`config` 已是 JSONB）。
- 拒绝原因必须是**已登记的类型化码**，不得抛未分类异常。既有先例：SW-01 因 `GATEWAY_RUN_NOT_READY` 不在词表内，把人为暂停报成执行失败。
- 判定函数保持纯函数，不读文件、不查库；调用方负责取事实。
- 路径比较在 win32 下大小写不敏感（既有 `gateway-actions.ts:193` `containsPath` 同口径）。
- 每个任务先落 RED 反例、确认失败，再改实现。
- 本轮不碰 `complete-run.ts` / `verification-*`（S3 范围），避免与在途并行 Agent 撞车。

## Baseline

S0 冻结：434 文件（`apps/api/{src,test,migrations,sql}` + `contracts`），聚合 SHA-256 `ff3249c74a897224b7653b1491df5dfe55c1c18f2e45aeb72d43963ebd7e1fad`，清单 `%TEMP%\relay-baseline-20261005\baseline-manifest.txt`。每片完成后按清单核对差异范围。

## Review Focus

规格是设计文档不是代码，它没写到的输入不等于可以崩。下列是最可能咬人的五类，每条在所属任务里配测试：

1. **`npm.cmd` 与 `NPM.CMD` 大小写差异** — Windows 上同一文件，准入必须放行，不得因字符串比较而误拒。
2. **`allowed_executables` 配了但当前检查不在清单内** — 必须拒（配置了白名单不等于全放行），且原因要可区分于「未配置」。
3. **连接被改成 DISABLED 或 config 被换掉后重放已结算工具行** — 准入事实变了，但已结算行必须保持原结论，不得改写也不得二次执行。
4. **冻结期通过、派发期授权被撤销** — 两处判定都要看到撤销，派发不得执行。
5. **`allowed_executables` 含根内路径时的重复配置** — 应被接受（用户在显式声明自己项目里的脚本），不得因为「已在根内」而报冲突。

---

### Task 1: 可执行文件准入的纯判定

**Files:**
- Create: `apps/api/src/application/cli-executable-admission.ts`
- Test: `apps/api/test/unit/cli-executable-admission.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）。根内判定复用 `apps/api/src/application/gateway-actions.ts:193` 的口径，但**不复用那个函数**（它是模块私有的，且语义是文件严格包含）。本任务自带一个导出的 `isWithinRoot(root, target)`。
- Produces:
  ```ts
  export const EXECUTABLE_ADMISSION_REASON = {
    NOT_ALLOWED: 'EXECUTABLE_NOT_ALLOWED',
  } as const;

  export interface ExecutableAdmissionInput {
    readonly canonicalRoot: string;
    readonly frozenExecutable: string;      // 已 resolve 成绝对路径的冻结入口
    readonly allowedExecutables: readonly string[] | undefined; // 连接 config；undefined = 未配置
  }
  export type ExecutableAdmissionDecision =
    | { readonly covered: true }
    | { readonly covered: false; readonly reason: string };

  export function isWithinRoot(root: string, target: string): boolean;
  export function evaluateExecutableAdmission(
    input: ExecutableAdmissionInput): ExecutableAdmissionDecision;
  ```
  语义：`isWithinRoot(canonicalRoot, frozenExecutable)` 为真 → 放行；为假时 `allowedExecutables` 未配置或不含该入口（win32 下小写比较）→ `EXECUTABLE_NOT_ALLOWED`。
  **刻意不判根身份**：`evaluateScopeGrant` 已先于任何清单比对核对根物理身份（失效时返回 `SCOPE_GRANT_ROOT_CHANGED`）。同一规则实现两处会漂移。

- [ ] **Step 1: 写失败测试**

`apps/api/test/unit/cli-executable-admission.test.ts`，八例：
1. 根内脚本（`join(root,'check.ps1')`）→ 放行，`allowedExecutables` 传 `undefined` 也放行。
2. 根外入口（`join(sep,'Windows','System32','cmd.exe')`）且未配置 → `EXECUTABLE_NOT_ALLOWED`。
3. 同上但 `allowedExecutables` 含它 → 放行。
4. `allowedExecutables` 含别的入口 + 一个根内入口 → 仍拒（配了白名单不等于全放行）。**Review Focus 第 2 条。**
5. win32 大小写：`allowedExecutables: [join(sep,'TOOLS','NODE.EXE')]` 对小写入口 → win32 上放行，**非 win32 上必须仍拒**（两个不同路径）。用 `process.platform` 分支断言两边。
6. `allowedExecutables: []`（空数组）→ 根外仍拒。与 `undefined` 语义不同，必须显式锁住。
7. 根带尾部分隔符（`ROOT + sep`）时 `project-sibling` 不得被当成根内。
8. `isWithinRoot` 四种形状：真后代 `true`；等于根 `false`；兄弟目录 `false`；`join(root,'..','escaped')` `false`。

断言用 `assert.deepEqual(decision, { covered: false, reason: ... })` 一次锁两个字段。**不要写 `assert.equal(decision.covered, false)` 再读 `decision.reason`**——`assert.equal` 不是类型收窄守卫，`verbatimModuleSyntax` 下报 `TS2339: Property 'reason' does not exist`。

- [ ] **Step 2: 跑测试确认失败**

用 Global Constraints 的范围化 `tsc`，只列 `apps/api/test/unit/cli-executable-admission.test.ts`。
Expected: `EMIT_EXIT` 非 0，且错误**只有** `TS2307: Cannot find module '../../src/application/cli-executable-admission.js'`。
若同时出现别的错误，说明工作区有在途并行改动，如实记录但不要去修。

- [ ] **Step 3: 实现**

`apps/api/src/application/cli-executable-admission.ts` 写 `isWithinRoot` 与 `evaluateExecutableAdmission`。`isWithinRoot` 照 `gateway-actions.ts:193` 的 win32 小写 + `relative()` 判定，**等于根返回 false**。文件头注释写明：模型只是提出入口，准入由连接 config 与受管根决定；模型输出不得升级为授权；以及为什么根身份不在这里判。

- [ ] **Step 4: 跑测试确认通过**

同 Step 2 的 `tsc`（emit 到 `%TEMP%\relay-scoped-dist`），再 `& .research\runtime-cache\node-v24.21.0-win-x64\node.exe --test "$env:TEMP\relay-scoped-dist\test\unit\cli-executable-admission.test.js"`。
Expected: `EMIT_EXIT=0`、`TEST_EXIT=0`、8/8 PASS、0 失败。

- [ ] **Step 5: 提交**

```
git add apps/api/src/application/cli-executable-admission.ts apps/api/test/unit/cli-executable-admission.test.ts
git commit -m "feat(api): add pure executable admission decision"
```

---

### Task 2: CLI_RUN 连接上的允许清单

**Files:**
- Modify: `apps/api/src/application/gateway-commands.ts:32`（`createGatewayConnectionCommand` 签名）、`:62`（`resolveConnectionConfig`）
- Modify: `apps/api/src/api/gateway-api.ts:48`（`createConnectionBody` 加 `allowed_executables`，`:85` 处理函数透传）
- Modify: `apps/api/src/application/gateway-queries.ts:19`（`GatewayConnectionDto` 加 `allowed_executables`，`connectionDto` 填充）
- Test: `apps/api/test/unit/gateway-exec-allowlist.test.ts`（**新建**——仓库没有 `gateway-commands.test.ts`）

**Interfaces:**
- Consumes: Task 1 的 `isWithinRoot`（本任务只用 `realpath` + 形状校验，不调用准入判定）。
- Produces:
  ```ts
  export const ALLOWED_EXECUTABLES_MAX = 32;                       // gateway-commands.ts
  export async function resolveAllowedExecutables(
    capabilities: readonly GatewayCapability[],
    entries: readonly string[] | undefined): Promise<readonly string[] | undefined>;
  ```
  `createGatewayConnectionCommand` 新增可选入参 `allowedExecutables`；`resolveConnectionConfig` 在 `hasRootBound` 分支把它写成 `config.allowed_executables`，未配置时**不落该键**。

- [ ] **Step 0: 范围补正（本任务必须含 HTTP，否则功能不可用）**

计划的初稿只写了命令层，这是错的：**连接创建只经 HTTP**（`gateway-api.ts:87` 是唯一产品路径），不加 HTTP 字段则用户根本无法配置；且 HTTP 刻意不返回原始 `config`（见 `web-fetch.integration.test.ts:452`），所以不补读取投影就是**盲授权**——写进去读不回来。故本任务含三处：命令层校验、HTTP 请求体、连接读取 DTO。GET 端点未声明 response schema，DTO 直接流出，无需改 schema。

- [ ] **Step 1: 写失败测试**

`apps/api/test/unit/gateway-exec-allowlist.test.ts`，11 例，直接打 `resolveAllowedExecutables`（该函数导出是为了让校验逻辑不必经数据库即可测）：
1. 清单项按 **realpath** 存回——用户读到的是真正生效的那份。
2. 未传（`undefined`）→ 返回 `undefined`，既有连接行的 config 形状逐字不变。**不写空数组。**
3. `[]` → 拒。**空清单是没有意义的配置，存下来会让人以为「配过了」**；与 `undefined` 语义不同，必须显式区分。
4. `['FILE_WRITE']` + 清单 → 拒，`fieldErrors[0].field === 'allowed_executables'`。挂到别的能力上会让人误以为那项能力也受这份约束。
5. 相对路径 → 拒。这里没有受管根可依。
6. 不存在的路径 → 拒，**不信任到首次运行**。
7. 目录 → 拒（可执行项必须是可运行文件）。
8. 空白字符串 → 拒，不进 `realpath`。
9. 33 项 → **一次拒掉，不截断**。
10. 根内脚本可显式列入，且同一文件经 `tools/../x.ps1` 两种写法折叠为一项。**Review Focus 第 5 条。**
11. 根内 + 根外可在同一清单中共存。

**断言写法**：`fieldErrors[0].field`——`DomainError` 实例上的属性名是 `fieldErrors`，只有 HTTP 序列化后才变 `field_errors`。用 `assert.deepEqual` / 显式 `assert.equal` 都行，**不要写 `assert.rejects(promise)` 不带校验函数**，那会在拒绝时假通过。

- [ ] **Step 2: 跑测试确认失败**

```
& .research\runtime-cache\node-v24.21.0-win-x64\node.exe apps/api/node_modules/typescript/bin/tsc -p apps/api/tsconfig.json
```
Expected: `TSC_EXIT=1`，且只有 `TS2305: Module '.../gateway-commands.js' has no exported member 'resolveAllowedExecutables'`。
若出现别的错误，说明有在途并行改动，如实记录但不要去修。

- [ ] **Step 3: 实现**

命令层加 `resolveAllowedExecutables` 与 `ALLOWED_EXECUTABLES_MAX`；`resolveConnectionConfig` 的 `hasRootBound` 分支在写 `root_path` 的同时附加清单键。**两个原本直接 `return` 的分支（无边界、WEB_FETCH）也必须调用一次**——否则 `['WEB_FETCH'] + 清单` 会被静默丢弃，变成谁也读不到的死配置。

- [ ] **Step 4: 跑测试确认通过**

单元定向，然后全量单元（**必须设 `RELAY_FILE_IO_HELPER` 绝对路径**，否则 `content-freeze`/`managed-content-store` 会假红 8 例），再跑真实 PG `gateway`、`web-fetch`、`tool-loop`。

Expected（**已实跑**）：定向 11/11 exit 0；全量单元 440 / 439 通过 / 0 失败 / 1 跳过 exit 0；`gateway` 30/30、`web-fetch` 19/19、`tool-loop` 36/36，均 exit 0。

- [ ] **Step 5: 提交**

只提交本任务的四个文件——工作区常有并行 Agent 的 `bot-profile-*`、`assist-*`、新迁移，**不得一并 add**：
```
git add apps/api/src/application/gateway-commands.ts apps/api/src/application/gateway-queries.ts apps/api/src/api/gateway-api.ts apps/api/test/unit/gateway-exec-allowlist.test.ts
git commit -m "feat(api): allow configured executables on CLI_RUN connections"
```

---

### Task 3: 冻结期拒绝未准入的检查入口

**Files:**
- Modify: `apps/api/src/application/conversation-execution.ts:96`（`ConversationExecutionRequest.check` 不变）、`:653`（`freezeConversationCheck`）、`:627`（`requireConnection` 调用点需带回连接 config）
- Test: `apps/api/test/unit/conversation-execution.test.ts`（既有）

**Interfaces:**
- Consumes: Task 1 的 `evaluateExecutableAdmission(input: ExecutableAdmissionInput)`；Task 2 让 `findConnection` 能取回连接 `config`。
- Produces: `freezeConversationCheck` 新增第二参数 `allowedExecutables: readonly string[] | undefined`；未准入时抛 `invalidTransition`，消息含可执行文件名与两条可操作出路（移进受管根 / 在 CLI_RUN 连接上加入允许清单）。既有「无法冻结内容摘要」那条失败路径**逐字保留**。

- [ ] **Step 1: 写失败测试**

1. 解释模型给出根内 `check.ps1` → 候选正常冻结，`check-1` 的 `executable` 是该绝对路径。
2. 解释模型给出根外绝对路径（如临时目录外的 `node.exe`），且该 CLI_RUN 连接未配 `allowed_executables` → 抛 `invalidTransition`，消息提到该文件名与允许清单。**这是本任务的核心 RED 反例。**
3. 同一根外路径，但连接 `config.allowed_executables` 含它 → 冻结成功。
4. 既有失败路径保留：根内路径指向不存在的文件 → 仍是「无法冻结检查程序 … 的内容摘要」，不是新的准入消息。**这条防串味，必须断言消息前缀。**

- [ ] **Step 2: 跑测试确认失败**

Expected: 例 2 FAIL（当前实现会接受根外绝对路径并哈希它）。

- [ ] **Step 3: 实现**

`findConnection` 增加一个返回 `{ connectionId, config }` 的变体（或让既有函数附带 `config`）。`freezeConversationCheck(canonicalRoot, check, allowedExecutables, rootIdentity)`：先按既有逻辑解析出 `absolute` 并实测摘要（**保留原顺序与原失败消息**），再调 `evaluateExecutableAdmission`，未覆盖则抛 `invalidTransition`。调用点 `:630` 传入该连接的 `allowed_executables`。

- [ ] **Step 4: 跑测试确认通过**

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```
git add apps/api/src/application/conversation-execution.ts apps/api/test/unit/conversation-execution.test.ts
git commit -m "fix(api): refuse freezing a check outside the managed root"
```

---

### Task 4: 授权准入纳入可执行文件判定

**Files:**
- Modify: `apps/api/src/application/run-scope-grant.ts:121`（`EvaluateScopeGrantInput`）、`:156`（`CLI_RUN` 分支）
- Modify: `apps/api/src/worker/tool-loop-action.ts:160`、`:230`（两处调用点补传事实）
- Test: `apps/api/test/unit/tool-loop.test.ts`（既有）；`apps/api/test/integration/tool-loop.integration.test.ts`（既有，追加真实 PG 反例）

**Interfaces:**
- Consumes: Task 1 的 `evaluateExecutableAdmission`。
- Produces: `EvaluateScopeGrantInput` 新增 `readonly allowedExecutables: readonly string[] | undefined`；`evaluateScopeGrant` 在既有 `SCOPE_GRANT_CHECK_CHANGED` 判定**之后**追加准入判定，未覆盖时返回 `{ covered:false, reason:'EXECUTABLE_NOT_ALLOWED' }`。

- [ ] **Step 1: 写失败测试**

单元（`tool-loop.test.ts`）：
1. 授权内、`check.executable` 在根内 → `covered:true`（既有 36 例的默认形状不得退化）。
2. 授权内、`check.executable` 在根外、`allowedExecutables` 未传 → `covered:false`、`reason === 'EXECUTABLE_NOT_ALLOWED'`。**核心 RED。**
3. 同上但 `allowedExecutables` 含它 → `covered:true`。
4. 顺序：入口摘要已变（`SCOPE_GRANT_CHECK_CHANGED`）**且**未准入 → 返回 `SCOPE_GRANT_CHECK_CHANGED`（先到先得，行为可预测）。
5. 撤权 / 过期 / 根身份变更三个既有原因**优先于**准入判定。

集成（`tool-loop.integration.test.ts`，真实 PG）：
6. 授权冻结时入口在根内，随后把该脚本移出根（重算根身份不可能，故改为：授权里 `allowed_executables` 未含根外入口）→ `run_check` 按类型化拒绝结算，**无 Invocation、无子进程、磁盘未动**。
7. 已 `SETTLED` 的写/检查行在连接 config 变化后重放 → 保持原结论，不二次执行（Review Focus 第 3 条）。
8. 授权撤销后派发 → 不执行（Review Focus 第 4 条；与既有 SW-01 暂停用例形状不同，需独立断言）。

- [ ] **Step 2: 跑测试确认失败**

Expected: 单元例 2、集成例 6 FAIL。

- [ ] **Step 3: 实现**

`run-scope-grant.ts`：`CLI_RUN` 分支内，摘要比对通过后追加 `evaluateExecutableAdmission({ canonicalRoot: input.canonicalRoot, frozenExecutable: input.check.executable, grantRootIdentity: input.canonicalRoot, allowedExecutables: input.allowedExecutables })`。
⚠️ 若 `EvaluateScopeGrantInput` 当前没有 `canonicalRoot`，需新增该字段并在两处调用点补传；**`grantRootIdentity` 取授权行的 `root_identity`，不是当前 root**——否则根身份变更那条既有判定会先短路，准入判定永远看不到真实情况。
`tool-loop-action.ts:160` 与 `:230`：解析出 `check` 的同一次调用里取回连接的 `allowed_executables` 并传入。**两处必须同源**，否则 prepare 与 admit 可能不同结论（这正是 SW-01 那类缺陷的成因）。

- [ ] **Step 4: 跑测试确认通过**

单元后跑真实 PG 全套：
```
powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -TestFile tool-loop -UseCLocale *> $env:TEMP\relay-tool-loop.log
$LASTEXITCODE   # 必须为 0；tool-loop 期望 36+ 例、0 失败
```
Expected: exit 0、0 失败。既有 36 例一条不得删。

- [ ] **Step 5: 提交**

```
git add apps/api/src/application/run-scope-grant.ts apps/api/src/worker/tool-loop-action.ts apps/api/test/unit/tool-loop.test.ts apps/api/test/integration/tool-loop.integration.test.ts
git commit -m "fix(api): gate check execution on configured executables"
```

---

### Task 5: 类型化拒绝进入模型可见词表

**Files:**
- Modify: 检查 `isAuthorizationRefusal` / 拒绝码词表所在文件（`tool-loop-action.ts` 引用的那处），把 `EXECUTABLE_NOT_ALLOWED` 与 `EXECUTABLE_ROOT_IDENTITY_CHANGED` 登记进去
- Test: `apps/api/test/unit/tool-loop.test.ts` 追加一例——准入拒绝必须作为**模型可见的类型化原因**回到下一轮，而不是抛 Worker 异常

**Interfaces:**
- Consumes: Task 3/4 的两个码。
- Produces: 模型在下一轮看到这两个码，可据此改用根内脚本或请用户加白名单。

- [ ] **Step 1: 写失败测试**

断言：准入被拒时该轮 `run_tool_calls` 行按既有拒绝形状结算（不留 `REQUESTED` 悬挂——只有控制意图才保留，见 SW-01），且拒绝码出现在回给模型的文本里。

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL，码未被识别为授权类拒绝。

- [ ] **Step 3: 实现**

只在既有词表里加两个码，**不新增异常类型、不改结算分支形状**。若发现现有词表是按前缀而非枚举登记，改为枚举登记并断言既有码全部仍被识别。

- [ ] **Step 4: 跑测试确认通过 + 全量单元**

```
& .research\runtime-cache\node-v24.21.0-win-x64\node.exe node_modules/typescript/bin/tsc -p apps/api/tsconfig.json
& .research\runtime-cache\node-v24.21.0-win-x64\node.exe --test apps/api/dist/test/unit/**/*.test.js
```
Expected: `tsc` exit 0；单元 0 失败（既有基线 412 通过 / 1 跳过）。

- [ ] **Step 5: 提交**

```
git add apps/api/src apps/api/test/unit/tool-loop.test.ts
git commit -m "feat(api): surface executable admission refusals to the model"
```

---

### Task 6: 回归、文档与验收记录

**Files:**
- Modify: `docs/testing/verification-plan.md`（新增 §20.10）、`docs/testing/overall-acceptance-2026-09-28.md`（新增一行）、`docs/architecture/tool-adapters.md`、`docs/api/http-command-contract.md`

- [ ] **Step 1: 跑受影响集成套件**

`tool-loop`、`folder-first-conversation`、`gateway`、`real-tools-gateway`、`agent-check-graph`、`migration`。逐个 `-TestFile` 跑，每次单独取 `$LASTEXITCODE`。Expected: 全部 0。

- [ ] **Step 2: 跑真实 Provider 定向探针**

按 CR-04 口径注入 `apps/api/.env` 的 `RELAY_MODEL_*`（**必须与调用同进程注入**，`run-integration.ps1` 不读 `.env`；不注入则整文件被 skip 且 exit 0——**skip 不算通过**），`-TestFile real-model-tool-loop`。Expected: 3/3、0 跳过。

- [ ] **Step 3: 反向撤销确认**

逐个撤销 Task 1–4 的实现，确认对应 RED 反例确实转红，再按 SHA-256 校验还原。记录哪些用例红了、红了几个。

- [ ] **Step 4: 文档**

`verification-plan.md` §20.10 写场景表（EX-01…）；`tool-adapters.md` 写准入规则与「模型只提出入口、准入由连接 config 与受管根决定」；`http-command-contract.md` 写 `allowed_executables` 请求/响应形状与 Breaking Change（**Yes，语义**：既有根外入口配置的会话将被拒）。
验收表新增一行，结论按实际跑出的数字填，**不得引用本计划或旧行**。

- [ ] **Step 5: 文档检查**

```
node scripts/check-docs.mjs
```
Expected: exit 0。

- [ ] **Step 6: 核对基准差异**

按 S0 清单核对改动文件集合，确认没有计划外文件被动过（尤其 `complete-run.ts`、`verification-*`、新迁移文件——那些是 S3 与并行 Agent 的范围）。

---

## 不在本计划范围

- **S3 检查证据与产物版本绑定** —— 碰 `complete-run.ts` 与 `verification-*`，需新迁移，单独出计划，且必须在本计划落地后基于新的授权形状来做。
- **Apply 时 UI 呈现 executable + args** —— 前端。`AssistView.tsx` 至今不渲染，CODEX_NEXT_STEP 已记为遗留。本计划只做后端准入，**不宣称用户已看得见实际执行的命令**。
- **Job Object 进程树边界** —— 本轮不做，改为已知限制记录。
- **多 Agent、安装/升级/卸载、指定模型独立验收** —— 不做。
