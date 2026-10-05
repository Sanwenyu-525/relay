# 讨论轮次的只读取证能力（list_directory）

日期：2026-10-05。状态：设计已批准，待实施。

## 1. 问题

用户在文件夹会话里问「现在在哪个目录?」，模型回答：

> 我无法访问本地文件系统，因此不知道您当前在哪个目录。
> 我运行在 Relay 工作台的对话环境中，没有 shell 访问权限，无法执行 pwd 或浏览您的磁盘路径。

经源码核对，这个回答是**准确的**，不是幻觉。缺陷在上游：系统没给模型任何知道目录的途径。

### 1.1 两个独立成因

**成因一：这条消息走讨论路径，不走执行路径。**

`AssistView.tsx:921` 只对普通讨论消息发起解释请求；`conversation-execution.ts` 的 `interpretConversationMessage` 调模型时使用 `INTERPRETATION_SYSTEM_PROMPT`，该提示词第 44 行规定「不执行任何动作、不调用工具」。「现在在哪个目录?」是问题而非执行请求，因此停在讨论层，不创建 Run。

**成因二：工作目录的绝对路径从未进入任何提示词。**

`canonical_root` 流经模型的每一处都已核对：

| 位置 | 是否把路径交给模型 |
|---|---|
| `context-builder.ts` | 否。对 directory / working directory / canonical_root **零提及** |
| `INTERPRETATION_SYSTEM_PROMPT`（`conversation-execution.ts:46`） | 否。原句「本次输入只有原用户消息，**没有目录内容**或读取结果」 |
| `draftToolSystemPrompt`（`openai-compatible-model-port.ts:50`） | 否。只按能力生成「工具只读 / 可以请求修改」，不给路径 |
| `conversation-execution.ts:317` `rootPath` | 否。写入请求行，仅供服务端解析与证据核对 |
| `gateway-actions.ts` / `file-query.ts` 等 | 否。服务端解析与校验路径 |

`declaredToolSpecs` 只在 `tool-loop.ts:67` 被调用，而工具循环要求 Run 冻结了 `tool_loop_action` 信封并绑定受管资源。讨论轮次没有 Run，因此一个工具都不会声明。

模型没有假装拥有权限。核心提示词要求「仅请求本次真实暴露的工具」「没有某项能力时，指出具体缺口及可行下一步」（`agent-system-prompt.ts`）。零工具、上下文无路径时，如实报告才是被鼓励的行为。

### 1.2 为什么「只打开文件夹」不够

回答「我在哪」需要**两个条件同时成立**：

1. 会话绑定了受管资源（经 `open-working-directory` 连过文件夹）；
2. 模型调用被声明了可回答该问题的工具。

只满足第 1 条——文件夹已打开，但用户问的是问题——**照样失败**，因为讨论轮次不声明任何工具。

另需注意：截图所示界面是空态夹具（左栏「已加载 10 项」）。该状态下没有真实连接，任何消息都不可能有工具循环，与是否选择工作区无关。

## 2. 已确认的前提

- 「现在在哪个目录?」在语义上是 `DISCUSS`。`INTERPRETATION_SYSTEM_PROMPT` 第 59 行规定「只是讨论、提问或表达可能性时用 DISCUSS」。把它升级为执行请求会违反 AGENTS.md「纯讨论不创建正式执行任务」与核心提示词「纯讨论不创建正式执行任务」。
- `list_directory` 缺省 `relative_path` 即表示受管根本身（`tool-catalog.ts:39`），单次调用即可同时回答「我在哪」与「根下有什么」。
- 只读动作的现行免审批口径：`gateway-actions.ts` 的 `READ_*` / `FILE_QUERY` 类动作不经 `ACTION_APPROVAL` 栅栏；该栅栏针对写入类动作（`APPLY_CHANGESET` / `CLI_RUN` / `GIT_WRITE`）。
- 本增量**不是**「自主执行」：不建 Task/Run、不冻结执行信封、不动预算、不改执行权、不产生业务副作用。只是让模型能查一个只读事实。

## 3. 方案

### 3.1 范围

讨论轮次新增**一个**工具：`list_directory`。不新增其余只读工具，不新增任何写入类工具。

| 能力 | 讨论轮次 |
|---|---|
| `list_directory` | 是 |
| `read_file` / `find_paths` / `search_text` | 否（保持现状） |
| `apply_changeset` / `run_check` / `git_*` | 否，永不 |

### 3.2 改动面

全部在 `apps/api`，前端零改动。

**（1）轻量工具循环。** 在 `conversation-execution.ts` 内给解释调用加一层：当 `resourceId` 有效且该资源具备 `FILE_QUERY` 连接时，向模型声明 `list_directory`；模型若请求它，执行一次 `LIST_DIRECTORY` 查询（复用 `files/file-query.ts` 与 `gateway-actions.ts` 既有的只读路径），把结果作为下一条消息回灌。轮次上限见 §3.4。

**（2）提示词与能力一致。** 按本次实际授予的能力生成解释提示词，复用 `draftToolSystemPrompt(canWrite)` 的既有模式：

- 有工具时：说明可以通过 `list_directory` 确认当前受管根，并删除第 46 行「没有目录内容」那句断言。
- 无工具时：保持现提示词逐字不变。

提示词与能力必须一致，否则要么模型遵守提示不取证、要么调用工具却被告知本次不允许，两种错位都会让真实链路走不通——这与 `CODEX_NEXT_STEP.md` 记录的 DRAFT 提示词错位是同一类缺陷。

**（3）审批与留痕。** 按「无副作用」口径：`list_directory` 免审批，不弹确认、不落 `ACTION_APPROVAL`。但**记一条只读工具调用事件**供回看，与 C 片工具轨迹的呈现口径一致：记录工具名、参数、结果摘要与是否截断。讨论轮次不建 Run，因此该事件挂在会话消息上，不进 `run_tool_calls`，不参与 Run 事件流刷新。

### 3.3 数据流

```
用户消息 → interpretConversationMessage
  ├─ 落请求行（事务内，短事务）
  ├─ 组装能力：有 resourceId + FILE_QUERY ? 声明 list_directory : 不声明
  ├─ 调模型
  │    ├─ 模型请求 list_directory
  │    │    → LIST_DIRECTORY 查询（免审批，只读）
  │    │    → 结果回灌为下一条消息
  │    │    → 回到「调模型」，累计轮次
  │    └─ 模型输出候选 → 落候选（沿用既有 settle 逻辑）
  └─ 返回既有形状的候选投影
```

事务边界不变：请求行与候选落库仍是短事务；模型调用与目录查询都在事务外。

### 3.4 轮次上限

工具轮次上限 **2 轮工具往返**。计数口径：第一次调模型**不计入**，只有「模型请求工具 → 回灌结果 → 再调模型」这一整个往返计 1 轮。因此模型最多被调用 3 次（首发 1 次 + 2 次往返后的收尾），最多执行 2 次 `list_directory`。

选 2 而不是 1：`list_directory` 一次即可回答「我在哪 / 根下有什么」，但模型可能需要第二次调用才把目录事实写进候选正文。选 2 而不是更多：讨论轮次的职责是整理意图，不是取证调查。

超限行为：达到上限时若模型仍请求工具，**不再执行该工具**，按既有终止语义收尾，并在候选依据里如实写明「已达讨论轮次的工具往返上限，未继续取证」。不静默丢弃、不假装工具不存在。

上限存在的理由与 `tool-loop.ts` 的预算终止一致：没有终止条件的循环会把真实原因掩盖成终态失败。

## 4. 边界守护

以下三条是本增量的硬约束，实现时以测试固定：

1. **讨论轮次永不声明写入类工具。** `apply_changeset` / `run_check` / `git_*` / 任何 `FILE_WRITE`、`GIT_READ`、`GIT_WRITE`、`CLI_RUN` 能力均不得进入讨论轮次的工具清单。
2. **无资源或无连接时行为逐字不变。** `resourceId` 为空、连接不具备 `FILE_QUERY`、或资源非 `ACTIVE` 时，不声明工具、提示词保持原句、调用次数与返回形状与改动前完全一致。
3. **不产生业务副作用。** 不建 Task/Run、不写执行信封、不动预算与执行权、不改任何业务事实。目录查询只读且有界。

## 5. 测试

| 层次 | 用例 | 目的 |
|---|---|---|
| 单元 | 模型请求 `list_directory` → 工具被调用、结果回灌、候选正常 settle | 主路径 |
| 单元 | 无 `resourceId` → 工具**未**声明，提示词仍是原句 | 回归门（边界守护 2） |
| 单元 | 连接不具备 `FILE_QUERY` → 同上 | 回归门（边界守护 2） |
| 单元 | 讨论轮次的工具清单只含 `list_directory`，不含任何写入类 | 回归门（边界守护 1） |
| 单元 | 模型连跑超 2 轮往返 → 按上限收尾，第 3 次工具请求被拒且候选说明原因 | 终止条件 |
| 集成（真实 PG） | 文件夹会话讨论「我在哪」→ 真实目录列表进入候选依据，且不产生第二个 Task/Run | 真实链路 + 边界守护 3 |

红灯先行：每条用例先落 RED 反例再改实现。

## 6. 不做

- 不把工作目录路径写进提示词（用户已选能力层而非提示词层）。绝对路径不进入每次提示词。
- 不给讨论轮次 `read_file` / `find_paths` / `search_text`。取证能力留给 Run 内的执行路径。
- 不改前端任何文件。
- 不给只读动作弹审批（已确认按无副作用口径）。
- 不动 `CODEX_NEXT_STEP.md` 记录的既有结论与 M04–M07、N 阶段状态。

## 7. 文档归属

| 内容 | 归属 |
|---|---|
| 产品规则、讨论轮次能力边界 | [工作台 §18.2](../../frontend/workbench-design.md) |
| 工具执行与只读免审批口径 | [工具适配器 §1](../../architecture/tool-adapters.md) |
| HTTP 契约与响应形状 | [命令契约 §10.53](../../api/http-command-contract.md) |
| 验收规格 | [测试计划 §17](../../testing/verification-plan.md) |

验收结果只维护在[功能验收表](../../testing/overall-acceptance-2026-09-28.md)，本文件不记录成绩。