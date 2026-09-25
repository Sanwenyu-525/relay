# P00：源码研究、机制采用与实验记录

日期：2026-09-19。状态：研究与实验阶段，尚非生产选型。本记录保存当时研究约束：借鉴成熟机制，不要求搬入源码；语言是实现手段；同时重视延迟、吞吐和内存，Rust 是主要候选；具体代码使用 Luna xhigh。

## 1. 证据范围

后续文档评审已推荐 TypeScript-first，见 [ADR-006](../decisions/ADR-006-typescript-first.md)。下文固定提交、两个 Rust 方向与实验结果作为历史证据保留，不代表新组合已经验证；新增 Spike 以[测试计划](../testing/verification-plan.md#6-typescript-first-冻结前-spike)为准。

首批六个仓库固定提交见 [upstream-lock.json](upstream-lock.json)。以下链接指向该轮读取的固定提交；没有运行这些仓库的完整测试套件。本地源码位置及后续补充仓库见下方清单。

| 项目 | 源码入口与测试入口 | 实际读到的机制 | 对本项目的判断 |
|---|---|---|---|
| Codex，Apache-2.0 | [协议定义](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/app-server-protocol/src/protocol/common.rs)、[中断测试](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/app-server/tests/suite/v2/turn_interrupt.rs) | thread/resume、turn/interrupt、命令审批和 turn/completed 是不同协议消息 | 借鉴会话/轮次/事件分层。产品 Task 不能等同于线程，执行结束不能等同于验收完成；不直接复制整套 CLI |
| DeepSeek Harness，MIT | [Agent](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/agent/src/index.ts)、[工具准入](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/tools/src/index.ts)、[准入测试](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/tools/tests/tools.spec.ts) | 公共 Agent 与 driver 分离，scoped 插件生命周期；工具 pre-execute 可拒绝/请求审批，缺少审批支持时拒绝 | 借鉴职责分离和默认拒绝；V1 不需要照搬 Cordis 插件平台。其 workflow 是脚本与子 Agent 编排，不是本项目固定业务流程的直接替代 |
| Pi，MIT | [agent-loop](https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/agent/src/agent-loop.ts)、[类型/钩子](https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/agent/src/types.ts)、[loop 测试](https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/agent/test/agent-loop.test.ts) | Agent 消息到模型消息的转换，模型流与 loop 分离；工具钩子、AbortSignal、显式工具并发 | 借鉴有界 loop 与工具清单，Node 包可作实验/替代实现，不默认增加常驻进程。Agent Core 的取消不等于撤回外部效果 |
| LangChain，MIT | [agent factory](https://github.com/langchain-ai/langchain/blob/eba445b7563d1709427bd8072892975a6ea59fdc/libs/langchain_v1/langchain/agents/factory.py)、[HITL middleware](https://github.com/langchain-ai/langchain/blob/eba445b7563d1709427bd8072892975a6ea59fdc/libs/langchain_v1/langchain/agents/middleware/human_in_the_loop.py) | middleware 组合工具和模型路径，人工决策使用 LangGraph interrupt | 借鉴拦截位置与类型化返回；不用一个 middleware 代替业务审批有效期和执行准入 |
| LangGraph，MIT | [interrupt 实现](https://github.com/langchain-ai/langgraph/blob/aa742fb31e2827d569b843e3600aeda2e0528e4b/libs/langgraph/langgraph/types.py)、[恢复测试](https://github.com/langchain-ai/langgraph/blob/aa742fb31e2827d569b843e3600aeda2e0528e4b/libs/langgraph/tests/test_pregel.py)、[SQLiteSaver](https://github.com/langchain-ai/langgraph/blob/aa742fb31e2827d569b843e3600aeda2e0528e4b/libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/__init__.py) | interrupt 恢复从节点开始重放；checkpointer 保存执行位置，sync durability 可等待 checkpoint 写完 | 借鉴持久步骤、恢复位置与重放边界。真实磁盘实验用于证明这些边界，不因此决定生产采用 Python 或通用图引擎 |
| Rig，MIT | [Agent 入口](https://github.com/0xPlaygrounds/rig/blob/2d16c1b25f6749b3a2cd841beddf767106495069/crates/rig-agent/src/agent/mod.rs)、[AgentRun](https://github.com/0xPlaygrounds/rig/blob/2d16c1b25f6749b3a2cd841beddf767106495069/crates/rig-agent/src/run/mod.rs)、[Runner 测试](https://github.com/0xPlaygrounds/rig/blob/2d16c1b25f6749b3a2cd841beddf767106495069/crates/rig-agent/src/agent/runner/tests.rs) | AgentRunner 统一执行入口，AgentRun 把状态推进与 I/O 分开；当前源码有序列化状态 | Rust 原生候选，先验证发布包而非假定 Git HEAD 等于发布版本。状态可序列化不证明任意 future、工具效果或跨版本恢复安全 |

许可证以上游根目录为初查依据；若实际分发某包或改编源码，需保留适用的声明并核对第三方依赖。本轮没有把第三方源码改名后纳入产品。

### 1.1 本地源码对照清单（2026-09-20 核验）

用户要求克隆源码以便对照、参考。本次复用已有七个仓库，新增克隆 pg-boss 和 Vercel AI SDK；已核对九个仓库的 origin、HEAD、检出范围和工作树状态，工作树均无未提交变更。下列路径均相对项目根目录 `D:/Develop/Relay-Agent`，位于 `.gitignore` 排除的 `.research/` 中。

| 项目 | 本地目录 | 核验提交 / 版本依据 | 工作树范围 | 对照用途 |
|---|---|---|---|---|
| Codex | `.research/upstream/codex` | `78245b47af2a`；首批锁文件 | 稀疏检出 | 会话、轮次事件、审批和中断 |
| DeepSeek Harness | `.research/upstream/deepseek-harness` | `ddefc45fbc7f`；首批锁文件 | 稀疏检出 | 插件生命周期、Agent/driver 分离和工具准入 |
| Pi | `.research/upstream/pi` | `36b60d2e8985`；首批锁文件 | 稀疏检出 | Agent loop、消息转换、取消和工具钩子 |
| LangChain | `.research/upstream/langchain` | `eba445b7563d`；首批锁文件 | 稀疏检出 | Agent factory、middleware 和人工决策 |
| LangGraph | `.research/upstream/langgraph` | `aa742fb31e282`；首批锁文件 | 稀疏检出 | checkpoint、中断和重放恢复 |
| Rig | `.research/upstream/rig` | `2d16c1b25f67`；首批锁文件 | 稀疏检出 | Rust AgentRunner、状态与 I/O 分离 |
| Kysely | `.research/upstream/kysely` | `2fefd4c848cc3129281fac0632d2376c7a723ee4`；0.29.6 | 完整检出 | SQL、事务和 Migrator 锁处理 |
| pg-boss | `.research/upstream/pg-boss` | `4e05af1eeaad3a645b16e3dd6c389fb4610ee0e9`；本次克隆时默认分支 HEAD | 完整检出 | PostgreSQL 队列、领取与唤醒机制，待研究 |
| Vercel AI SDK | `.research/vercel-ai` | `08ae5ad05bc12`；`ai@7.0.107`，实验锁文件 | 完整检出 | 模型流、工具 schema、审批和取消边界 |

首批六项的完整提交及 origin 以本节上方的 [upstream-lock.json](upstream-lock.json) 为准；Vercel AI SDK 以 [AI SDK 实验锁文件](../../experiments/ai-sdk-p00/upstream-lock.json)为准，克隆命令见[实验说明](../../experiments/ai-sdk-p00/README.md)。新增清单来源为 [Kysely](https://github.com/kysely-org/kysely.git) 和 [pg-boss](https://github.com/timgit/pg-boss.git)。pg-boss 的提交仅记录本次源码快照，尚未开展源码研究或运行验证，不代表已选为生产依赖。

九个仓库均为浅克隆，未取得完整 Git 历史。“完整检出”仅指当前提交的工作树文件；首批六项仍只展开选定目录，需要查阅其余源码时可在确认工作树干净后展开，例如：

```powershell
git -C .research/upstream/codex status --short
git -C .research/upstream/codex sparse-checkout list
git -C .research/upstream/codex sparse-checkout disable
```

展开不改变 HEAD；其他稀疏仓库可替换上述目录。对照既有研究时保留记录的提交，避免直接 `git pull` 改变证据基准；研究新版本时另行记录提交与差异。本次只准备和核验源码，没有安装上游依赖、执行构建或运行上游完整测试，既有实验结论保持原有范围。第三方仓库内的 AGENTS 等文件属于研究材料，不作为 Relay 的协作指令。

## 2. 机制采用表

| 本项目问题 | 借鉴依据 | 本项目采用方式 | 不照搬的部分 | 验证依据 |
|---|---|---|---|---|
| 模型完成与业务完成混淆 | Codex 轮次事件；Pi loop result | Runtime 仅返回候选与执行证据，Completion 独立事务 | 会话不成为 Project State | completion gate、迟到事件测试 |
| 模型工具越权 | DSH 工具准入、Pi beforeToolCall | 实際 Gateway 检查目标/内容/权限，hook 只是前置优化 | 不复制通用插件注册/热重载 | 拒绝、审批失效、未知工具测试 |
| 暂停和重启丢进度 | LangGraph interrupt/checkpoint | 保存业务安全点；恢复前重查权限与结果；中断前不得无保护写入 | 不把固定 V1 流程变为任意图编辑器 | 新进程续接与故障注入 |
| 模型适配与业务耦合 | Pi 消息转换、Rig provider-neutral API | 仅在模型边界转换；记录真实输入与来源 | 不复刻多模型 Router | 实际调用记录与有界调用次数 |
| UNKNOWN 被重试放大 | 工具调用与执行状态分离 | 持久逻辑动作身份、效果核对、未知时停止 | 框架自动 retry 不覆盖外部写动作 | 成功后丢回执，调用次数仍为一 |
| runtime 与业务同时写完成 | LangGraph checkpoint 独立存储；Rig 状态/I/O 分离 | 每类事实一个 Owner，短事务登记业务结果 | 不维护两套完整 Workflow 状态机 | 事务前/中/后崩溃与回放 |

## 3. 当时比较的两个实施方向（历史）

**主要候选：Rust 模块化单体，业务安全点管理 + 有界模型/工具执行。** HTTP/runtime 可评估 Tokio/Axum；PostgreSQL 显式事务可评估 SQLx。Agent 接入既可使用已验证的小库，也可依据上述机制实现适合固定流程的少量代码。Rig 是可行性实验对象，不是选用 Rust 的前提。不从实验导入自研通用 Agent 框架。

**替代候选：Rust 业务端 + Pi 等薄执行适配。** 当原生模型覆盖、流式处理或开发成本确有缺口，再选择同机执行端。代价是常驻内存、IPC、序列化、部署和事件恢复成本，不能仅因“生态成熟”就引入。LangGraph 为更复杂持久图需求的参考/备选，现阶段不作为默认生产依赖。

两者都保留 PostgreSQL、不可变产物、业务短事务和 UNKNOWN 核对。Java/Spring 是早期推荐，现不作为开工约束。尚未决定生产语言和依赖的精确组合，不能把用户询问 Rust 记成已接受全部 Rust 技术选型。

## 4. 实验与结果边界

- [LangGraph 实验](../../experiments/langgraph-poc/workflow.py)：真实 StateGraph/SqliteSaver，确定性模型文本、受控效果账本、独立业务账本，15 项测试通过，见 [JUnit 结果](../../experiments/langgraph-poc/results.xml)。每个 CLI 调用启动新进程；故障点使用进程退出。测试的是单运行集成恢复，未证明 PostgreSQL 并发事务或生产服务安全性。
- [Pi 实验](../../experiments/runtime-bench/pi.mjs)：真实 agentLoop，Fake stream 与唯一可见工具，6 项测试通过。覆盖成功、拒绝、UNKNOWN 停止、未知工具、参数不合法、取消传递。未验证 Pi 的磁盘恢复或实际供应商取消。
- Rust/Rig 实验与统一性能观测在原计划中由 Luna xhigh 继续完成；本轮不重跑或重新验收，此处不提前填写通过或快慢结论。

LangGraph 的事件接收测试是本项目测试替身，不是现成网络传输实现；业务 SQLite 不是生产数据库选型。暂停测试是安全点暂停，不是中途终止真实 CLI。三类证据不可混用。

## 5. 性能判定方法

同时记录冷启动、常驻/峰值内存、串行 p50/p95、固定并发吞吐；使用 Release Rust、相同输入和模型/工具调用次数，至少三次独立进程。无持久化 loop 与磁盘 checkpoint 分开报告，流式/非流式差异明确列出。模拟延时只考察本地调度，不代表真实模型 API、网络、数据库和工具表现。

不把一个微基准的最快项当成整机体验保证。生产栈还需测真实 PostgreSQL 事务、API 分页/序列化、并发资源排他、长上下文与取消；当前缺少这些证据，不提供虚构 SLO 或“Rust 全面胜出”的结论。

## 6. 数据模型与下一阶段边界

保留 Task/Run/Review/Verification/Completion/Operation/Invocation 等业务身份和约束。Step/Attempt 只记录业务步骤，不复制框架内部每个 token/节点。暂不创建通用 checkpoint、插件平台或多 runtime 路由表；只有需要跨调用持久执行时才设计对应绑定和版本字段。

2026-09-19 当时环境为 Docker daemon 未运行，未发现 PostgreSQL 服务/命令；当时没有正式后端、数据库 migration、前端或真实模型集成。后续复测与准备见下节；生产工程入口仍需依据实验结果和数据库条件推进。

## 7. 后端开工前准备接续（2026-09-20）

用户授权：准备未完成则继续补齐，满足出口后开始后端编码，并指定 GPT-5.6 Terra 极高（`gpt-5.6-terra` / `xhigh`）。本次实际调用该配置执行隔离数据库与 AI SDK 边界实验；历史 Luna 实验记录保持不变。接续任务见 [P00 提示词](../../prompts/00-foundation.md#terra-后端开工接续提示词)，当前完成状态仍只在 CODEX_NEXT_STEP 维护。

开工复测：

| 检查 | 2026-09-20 实际观察 | 证据边界 |
|---|---|---|
| `node --version` / `pnpm --version` | v22.22.3 / 9.15.9 | 系统环境；不代表 Node 24 候选组合通过 |
| `docker info` / `Get-Service com.docker.service` | Docker pipe 不存在；服务 Stopped | 没有启动或修改系统 Docker 服务 |
| `Get-Command psql,pg_ctl` 与 PG 服务检查 | PATH/服务未发现 PostgreSQL | 不等同扫描整机所有安装位置 |
| Provider 环境变量名检查 | 存在 `DEEPSEEK_API_KEY`；未发现 `OPENAI_API_KEY` | 只查变量名，未读取或记录值；不能证明端点、余额、模型或权限可用 |
| Rust / Windows 构建前提 | GNU 为默认工具链，MSVC 工具链及 VS 2022 BuildTools 可见；WebView2 目录可见 | 未编译/打包 Tauri，未验证安装产物或真实窗口 |

真实模型仍缺明确的两个测试端点/模型配置；不借用 Codex 登录凭据或其他项目配置。性能预算尚未确认，实验测量不能据此标记生产 SLO 达成。隔离实验依赖与 SQL 不进入生产工程，不将基础数据库测试当作完整审批恢复、UNKNOWN 或 P01 验收。

### PostgreSQL 基础实验与依赖兼容

新增 [typescript-p00](../../experiments/typescript-p00/README.md)，使用项目内便携 Node 24 与真实 PostgreSQL 18。运行入口、固定版本、官方下载来源、校验边界及命令统一在实验 README；实际断言、运行版本与结果见 [latest.json](../../experiments/typescript-p00/results/latest.json)。没有创建生产数据库、V001 或业务后端。

核验发现：Kysely 内置迁移器会拒绝已应用文件缺失，但不校验同名文件的内容变化；实验补充单一 SHA-256 校验入口。摘要、迁移元数据与 DDL 需要同事务，因此锁也在同事务内取得，避免独立连接持锁后再争抢连接池；执行与摘要记录使用同一目录清单。该入口只用于验证机制，不作为生产迁移框架直接冻结。

首次使用 Kysely 0.28.17 时，Migrator 对已有 Transaction 仍调用 transaction()，实测报不支持嵌套事务；不能将其他版本源码中的分支误当已安装版本的能力。随后固定 Kysely 0.29.6 对应源码并重跑，验证其已有 Transaction 分支。具体提交、许可及文件入口见实验 README。该差异说明精确版本和真实事务测试均是必要证据，不可由类型检查替代。

进一步复现 Kysely 0.29.6 的已有事务失败边界：真正 SQL 错误使事务进入 aborted 状态，Migrator 在该事务中释放会话级 advisory lock 时报告 `25P02`；JavaScript 抛错不能覆盖此情形。实验入口为每次迁移建立专属连接，并在成功或失败后关闭，防止会话锁回到可复用业务连接池。代价是迁移单独建立连接，不适用于把此入口嵌入任意业务事务；DDL、元数据和摘要仍在迁移自身的同一事务内。回归核对真实 SQL 失败后的回滚、无残留锁及另一连接在 500ms lock_timeout 下可重新迁移。此项是实验验证出的兼容限制，不修改上游源码，也不据此冻结生产迁移方案。

基础验证覆盖重复/并发迁移、内容变更/缺失、迁移与一般事务回滚、无损 bigint、应用角色 DDL 拒绝及 revision CAS；未证明完整业务表约束、两个 Repository 的生产完成事务、B01/B03–B05、审批或 UNKNOWN 的跨进程恢复。实验运行器的失败与清理也必须如实报告，旧成功结果不能冒充新一次运行。

基础实验收尾：13 项断言通过。主 Agent 使用便携 Node 24 独立重跑 strict 类型检查和真实 PG 脚本，运行 `20260920T091918743Z-98065fd5` 退出码 0；报告在专属 PG 停止后才为 PASSED，随后 `pg_ctl status` 返回 3（无服务器运行）。运行器的失败回归 `20260920T091709090Z-d4b5943f` 保留为 FAILED，未沿用之前的成功结果；两种迁移并发均使用子进程 barrier 和数据库锁等待观测。逐次结果、10 个输入 SHA-256 与清理状态在实验 results 目录，不将单次测试耗时当性能验收。

### AI SDK 离线边界实验

新增 [ai-sdk-p00](../../experiments/ai-sdk-p00/README.md)，使用 AI SDK Core 7.0.107、官方 MockLanguageModelV4 与 TypeBox；精确源码提交、许可及读取文件见其 upstream-lock.json，依赖由 pnpm-lock.yaml 固定。工具未注册 execute，只返回完整且经校验的候选参数和消息身份，不执行外部工具。

Node 22.22.3 和便携 Node 24.21.0 均完成 strict 类型检查及 7/7 离线测试；主 Agent 另在 Node 24 独立完成类型检查、构建与 7/7 测试。覆盖完整文本/参数、JSON 往返、非法 JSON、schema 非法、多调用显式拒绝、截断参数、模型错误及在途 AbortSignal；原始输出与输入摘要见 [运行索引](../../experiments/ai-sdk-p00/results/ai-sdk-p00-20260920T085425Z.json)。

该实验验证实际 SDK 的协议处理，模型仍是官方替身。它没有运行真实 Provider、数据库审批恢复、UNKNOWN 核对或 Fastify/schema 联合兼容；不计为 Spike 1/2/3 或 37 项业务验收通过。候选 JSON 往返也不等于生产恢复器已经实现。

### 跨进程审批与 UNKNOWN 局部恢复实验

新增 [recovery-p00](../../experiments/recovery-p00/README.md)，使用独立 PostgreSQL 18 集群、便携 Node 24 子进程和同一真实 AI SDK 官方 Mock。每个操作只允许向自身临时目录中的固定文件发布新内容，审批和调用效果分开保存。等待批准时仅持久候选；批准与绑定重校验通过后才进入 PREPARED，外部调用在数据库事务之外。实验表的 probe phase 不是新增 Task 状态，ownership 快照也不冒充独立 Worker claim epoch。

实测范围包含审批后的新进程续接、PREPARED 后退出、外部效果后退出、证据缺失/截断/非对象 JSON、写后外部编辑、批准后目标基线变化、五类批准绑定失效及旧 ownership 结果拒绝。恢复核对原动作身份和参数、基线、内容摘要；缺证据不盲重写。效果成功只记录动作结果，不产生 PASS、CompletionRecord 或 Task DONE；协议短事务次数与业务完成次数分列。逐次输入摘要、子进程退出码、具体断言与计数见 [results/latest.json](../../experiments/recovery-p00/results/latest.json)。

运行器曾因 Windows 上 PostgreSQL 继承输出管道而等待不结束；已改为专属日志和启动输出处理，保留中断记录并回收自有实例。失败或中断不计为通过。双批准/双执行子进程使用并发启动，尚未观测确定的数据库锁等待，不能据此宣布完整并发验收通过。

主 Agent 使用便携 Node 24 独立完成严格类型检查、构建及运行器复验，运行 `recovery-p00-bd8b4107-2381-4c49-87a0-7d544b94149a` 为 PASSED：14 个场景、61 个子进程、无超时，pg_ctl stop 返回 0，临时集群目录清理为空。写后编辑场景单独保留此前已观测写入一次，同时记录当前内容不匹配；不把后续文件变化或日志缺失误计为此前没有效果。

这组证据只局部支撑 Spike 1/2。独立 claim epoch、仍存活旧进程的资源隔离、部分写入、准入后调用前崩溃、证明未发生后的恢复、控制/完成竞争、完整步骤与业务提交、数据库重启均未由此证明；两个真实 Provider 和联合 schema 兼容仍另需验证。

### 最小 Windows 桌面宿主实验

新增 [desktop-p00](../../experiments/desktop-p00/README.md)，固定 Tauri 2、Vue 和随包 Node 24，使用 MSVC 构建独立 release 可执行目录包。它包含静态验证页、loopback 服务和独立 Fake Worker，与并行 apps/workbench 页面任务分开。当前构建方式为 `tauri build --no-bundle`，不是 MSI/NSIS 安装包。

本机运行检查覆盖私有管道引导、动态 loopback 端口、内存 Bearer、真实 WebView 授权请求及重载，以及无 token/错误 Host/错误 Origin 拒绝；正常退出还检查随包 Node 无残留。跨源 Authorization 需要显式 OPTIONS 预检，不能用 Node 自检代替 WebView 请求。产物与输入摘要、进程记录、环境版本和本次结果统一见 [results/latest.json](../../experiments/desktop-p00/results/latest.json)。

主 Agent 独立运行 build-release（跳过重复安装，仍运行 vue-tsc、Vite 与 MSVC release 构建）及 run-release，运行 `fcecbf86ae0845ea9325eae361978870` 为 PASSED。实际环境为 Windows 11 10.0.22631 64 位、WebView2 153.0.4234.48；观测到原生窗口句柄与标题，WebView 重载后握手为真，401/421/403 负向请求符合预期，进程退出码 0、随包 Node 残留 0。没有原生截图或人工目视 UI 验收；窗口创建和自动握手证据不等于 IME/DPI/布局已验收。

这是宿主可行性局部证据，不是完整安全认证、窗口交互或正式安装交付。单实例、伪造 readiness、错误实例/非授权 frame、服务崩溃后的凭据轮换、强杀/孤儿、干净机安装、升级卸载、IME/DPI、业务恢复及 Electron 整机性能对照继续按测试计划验证；ADR-007 保持 Proposed。

## 8. Terra 验证接续与主 Agent 复验（2026-09-20）

用户明确由主 Agent 编写提示词、Terra 负责开发，并要求开始。本次实际使用两个 `gpt-5.6-terra / xhigh` 执行者，分别负责恢复/SDK 和桌面实验；主 Agent 核对契约、运行结果并维护汇总。用户随后确认两个真实 Provider 暂未配置，先完成其余验证；不读取宿主凭据，Spike 3 继续记为未运行。

### P00 接续缺口矩阵（本轮复核）

| 规格条目 | 实测状态 | 输入摘要与证据 | 未覆盖项 | 本轮动作 |
|---|---|---|---|---|
| PG 基础、迁移完整性、bigint、角色权限与 CAS | 已通过局部基础验证 | [typescript-p00 latest](../../experiments/typescript-p00/results/latest.json)：13 项，Node 24.21.0 / PostgreSQL 18.6 | 业务 Repository 完成事务及 37 项验收 | 复用现有通过记录，不重跑无关基础实验 |
| AI SDK / Fastify / TypeBox 离线 schema | 已通过局部协议验证 | [ai-sdk-p00-20260920T120324Z](../../experiments/ai-sdk-p00/results/ai-sdk-p00-20260920T120324Z.json)：8/8，官方 Mock、无 `execute` | 真实 Provider、网络断流/超时与持久化恢复 | 复用现有通过记录 |
| Spike 1：审批后跨进程恢复 | 局部通过 | [recovery-p00 latest](../../experiments/recovery-p00/results/latest.json)：候选/Review/原动作身份、锁内 barrier 的批准/准入竞争与恢复场景 | 完整 Workflow/步骤推进、完整业务事务 | 继续以主 Worker 的固定 WRITE_FILE 场景验证 |
| Spike 2：外部效果与 UNKNOWN 核对 | 局部通过 | 同一恢复记录：包含效果后 exit 73、证据缺失/截断/外部编辑及 PostgreSQL 重启后 reconciliation | 主动作与资源/claim 联合提交、生产 Adapter | 本轮新增真实 PostgreSQL 重启后的恢复场景 |
| B01、B03–B05 与资源/claim | 局部通过，且与主动作分离 | recovery-p00 的 6 个 control-worker 场景，使用真实 PG、子进程和 barrier | UNKNOWN 实际核对、主动作与资源/claim 同事务 | 保持为明确缺口，不把控制替身当作已联通实现 |
| Spike 3：两个真实 Provider | 外部条件阻塞，未运行 | 当前无两个用户配置的合法 Provider 端点；不读取宿主凭据 | 全部 Provider 兼容、真实取消与网络故障语义 | 待用户提供合法测试配置后执行 |
| P00 桌面宿主 | 局部通过 | [desktop-p00 latest](../../experiments/desktop-p00/results/latest.json)：release 目录包、真实 WebView、单实例、readiness 与强杀回收 | 安装、服务重启凭据轮换、IME/DPI、完整 frame 与 Electron 对照 | 保持隔离实验，后续按测试计划补齐 |
| 组合性能 | 未运行 | 性能预算尚未确认 | 固定工作量、分位延迟、总 RSS、吞吐与锁竞争 | 预算确定后先报告原始测量，不宣称 SLO |

### 恢复与控制的新增局部证据

[恢复实验说明](../../experiments/recovery-p00/README.md#2026-09-20-接续覆盖与边界)区分 19 个主动作 Worker 场景与 6 个独立控制模型场景。主动作新增 `DISPATCHING` 后调用前退出、按 Invocation 保存并绑定 operation/Invocation/effect/PID 的退出收据核对、旧 PID 仍存活时拒绝安全重试，以及部分文件写入后保持 UNKNOWN。双批准与双执行使用 holder/waiter 进程、锁内 barrier 及 `pg_stat_activity` 的实际 Lock 等待观测，不再用 `Promise.all` 作为竞争正确性证据。确认未发生时沿用原逻辑动作、候选与 Review，建立后续 Invocation；文件或调用日志不存在本身不作为旧进程已停止的证明。

控制模型以真实 PG、独立子进程、barrier 和锁等待观测验证 Delegate 竞争及完成/取消两种提交顺序，并覆盖持久 Pause、UNKNOWN 未决时拒绝 Handoff、租约过期而旧进程仍活时拒绝冲突资源领取、独立 claim epoch 的结果 fencing。它与主动作 Worker 的表和入口尚未联合；`resolve-unknown` 是注入式核对结果，不能当作真实 Adapter 核对或完整 B05/Spike 2 通过。接手编辑后 Task 保持 IN_PROGRESS，与 Stop AI 返回 READY 分开。

只读审查发现三项恢复缺陷：多次 Invocation 时可能拿到旧调用的 effect ID；仅绑定 operation/PID 的退出收据可能被新调用误用；控制模型未检查条件 UPDATE 的行数，可能把重复或 UNKNOWN 结果报为已接受。Terra 将核对与结果写入绑定当前 DISPATCHING Invocation，退出收据增加 Invocation/effect 身份，并仅在条件更新一行时接受结果。回归覆盖“确认未发生→安全重试→外部效果后退出→按新 Invocation 核对成功”、注入同 PID 的旧收据重放拒绝，以及重复/UNKNOWN 结果拒绝。旧 Invocation 和核对证据保留。

本轮在稳定输入上独立执行便携 Node 24 的类型检查、构建与真实 PG 运行器，最终运行 [recovery-p00-79ea8c62-f19c-4846-b49a-2745b3ede99d](../../experiments/recovery-p00/results/recovery-p00-79ea8c62-f19c-4846-b49a-2745b3ede99d.json) 为 PASSED：25 场景；批准和执行的第二个独立子进程均在 `pg_stat_activity` 中被观测为 Lock 等待，释放 barrier 后仍只有一次批准消费和一次外部效果。新增场景还在外部效果后将 PostgreSQL 以 `pg_ctl immediate` 停止并用相同数据目录重启，之后的新 Worker 只按原 Invocation/effect 身份核对成功，模型调用与工具调用仍各为 1。启动/停止均返回 0，临时集群目录清空，6 项输入摘要与当前文件一致。此前 25/24/23 场景记录保留为历史证据，不证明新回归通过。完整步骤推进、PASS/CompletionRecord、动作与资源/claim 联合提交当时仍未验证（恢复/提交部分已由下一小节的第三批证据补齐，端到端性能仍待测）；没有生产后端、正式 migration 或完整业务验收。

### 联合提交、步骤推进与业务完成（第三批证据，2026-09-20）

本轮由执行者扩展主恢复 Worker，补齐上一节当时未完成的四项：主动作与资源/claim 的联合提交、持久化步骤推进、PASS/CompletionRecord 业务完成短事务，以及控制意图与完成的两种确定提交顺序。实现、命令与逐场景断言见[恢复实验说明](../../experiments/recovery-p00/README.md#2026-09-20-联合提交步骤推进业务完成与控制竞争)。`control-worker` 的表与入口没有并入主 Worker，仍是独立的最小控制模型。

主 Agent 独立执行便携 Node 24 的类型检查、构建与真实 PG 运行器。首轮复跑为 PASSED 后，另一只读审查发现三处断言空转（`model_rounds_this_process` 是硬编码常量；结果事务的两个事件计数与"无 Invocation"写在注入点之前，因此恒为 0）、exit 77 的"有界收敛"观测不到中间态，以及租约存活只用 PID、锁等待未校核阻塞者身份。执行者据此把注入点移到各自短事务的全部写入之后、把进程内模型/工具计数改为真实上报、存活判据改为父进程持有的子进程句柄、锁等待补 `pg_blocking_pids` 校核，并做了两次故意破坏运行证明断言确实能失败（把回滚临时改成提交、把 holder 身份改成不存在的 `application_name`，两次都按规则写为 FAILED）。

主 Agent 在最终源码上复跑 [recovery-p00-48492df1-6452-4f22-82d5-102fb565c2cc](../../experiments/recovery-p00/results/recovery-p00-48492df1-6452-4f22-82d5-102fb565c2cc.json) 为 PASSED：39 个场景（33 主 Worker + 6 控制模型）、203 个子进程记录、0 超时、用时约 133 秒、`pg_ctl stop` 退出 0、临时集群目录无残留、6 项输入 SHA-256 与当前文件一致；子进程退出码分布为 0×181、72×2、73×9、74×3、75×3、76×3、77×1、79×1。FAILED 记录现在持久化 `failure` 的失败原因与已完成场景数（此前只截断在失败场景处），该字段用一次启动即失败的负向自检运行验证。更早的通过记录只适用于它们各自的输入摘要，不代表当前源码。

新增证据的要点：准入与 claim 取得在同一短事务，事务内注入失败与未提交断连两种回滚都不留 claim 残留；结果落库与 claim 释放或保持隔离同事务，旧 claim epoch 结果被拒绝且不改变 claim；两步位置持久化，exit 72 后新进程从 `step_index=1` 继续且模型调用仍为 1；完成短事务把 PASS 记录、CompletionRecord、Task DONE、State delta、命令回执与 Run COMPLETED 一起提交，注入失败整体回滚，提交后 exit 79 的同 ID 重放返回逐字段相同回执且不产生第二次业务完成；Pause/Cancel 先提交与完成先提交两种顺序均用 barrier 加 `pg_stat_activity` 锁等待观测，分别拒绝被越过的完成或不把已完成 Task 退回；租约强制过期但旧 Writer 子进程仍存活时，冲突资源领取继续被拒绝。

边界：业务完成仍只覆盖单一受控文件动作与固定两步计划，PASS 由实验内确定性检查器写入，没有多产物版本集合、人工 Review 审批链、Hard/Rule/Semantic 分类验证器、生产 Workflow 生命周期、预算/Retry 状态机、生产 Gateway 与权限判定；主 Worker 侧 UNKNOWN 只有转隔离并拒绝完成，人工处置入口仍缺，`control-worker` 的 UNKNOWN 结果核对仍是注入式替身。没有真实 Provider、生产文件适配器，也没有连接池耗尽、网络分区、时钟回拨、多 holder 竞争或锁升级。进程内模型/工具计数只能证明"该进程没有重跑"，跨进程全局次数仍由 `MODEL_CALL`/`TOOL_CALL` 审计事件给出；父进程自身崩溃后的存活判定未覆盖。本批补齐的是恢复/提交机制的局部证据，仍不等于 Spike 1/2 的完整形式通过、Spike 3 或 37 项验收。

### Fastify、TypeBox 与 AI SDK 联合 schema

[SDK 实验](../../experiments/ai-sdk-p00/README.md)新增实际 Fastify 路由校验，与原 TypeBox 定义和 AI SDK 官方 Mock 的工具解析使用同一批合法/缺字段/未知字段/数字代替字符串输入。显式关闭 Fastify 的 `coerceTypes` 和 `removeAdditional`，避免 HTTP 静默修正输入而模型边界拒绝；工具继续不注册自动 `execute`。这只证明已测 schema fixture 的联合校验，不证明任意 schema 或真实 Provider 子集兼容。

固定依赖、来源与输入摘要见 [ai-sdk-p00-20260920T120324Z](../../experiments/ai-sdk-p00/results/ai-sdk-p00-20260920T120324Z.json)。主 Agent 独立执行 Node 24 类型检查、构建和测试，8/8 通过、0 跳过。下载沿用实验记录的进程级官方 registry/代理处理，没有改变系统默认运行时或全局包配置。上述新增项不通过 Spike 3，也不改变 ADR-006 的 Proposed 状态。

### 桌面进程监管、实例与构建证据

[桌面实验](../../experiments/desktop-p00/README.md)新增 Windows Job Object 的关闭回收、命名互斥单实例、FakeWorker readiness 的实例 nonce 核验，以及 WebView2 对 child frame 导航的取消处理。主 Agent 独立运行 `build-release.ps1 -SkipInstall`、`run-release.ps1 -TestBuildManifestMismatch` 和 `run-release.ps1 -TimeoutSeconds 60`，均退出 0。

最终独立运行 [90fa9679deed4bd0a777b24629b94ac5](../../experiments/desktop-p00/results/90fa9679deed4bd0a777b24629b94ac5.json) 为 PASSED：真实 WebView 重载握手、正常退出与原有鉴权探针通过；错误 nonce/提前退出由实际 release 宿主拒绝；重复启动返回 23 且原服务 PID 未变；仅强杀宿主后，已记录的两个 Node PID 在测试脚本清理前自行消失，最终随包 Node 残留为 0。隐藏窗口只证明重复实例被拒绝及聚焦调用存在，不证明前景切换目视效果。

frame 证据限定为实际 `frame-probe.html` 导航被原生取消。另一个受控运行确认外部 CSP 脚本能执行、桥可用且已尝试 IPC，但没有调用完成回执；不能将这一观察写成 IPC 成功或明确授权拒绝，也不能推广到 `srcdoc`、`about:blank` 或任意同源 frame。早期测试曾因把脚本执行与 IPC 回执混为一谈失败，逐次失败结果保留，不计为通过。

只读审查发现原运行报告可能用当前源码摘要标注旧 EXE。现由构建入口在构建前采样输入、构建后核对未变，再记录 EXE 与随包资源摘要；运行入口核对清单后才允许启动并保存通过结果。[不匹配负向测试](../../experiments/desktop-p00/results/26072f41298443b188c1814d0fe971de.json)确认陈旧的 App.vue 摘要在启动前被拒绝。README 不作为编译输入；这些措施是本机实验的来源绑定，不是签名发布或防恶意篡改认证。仍未验证正式安装/升级、完整主 frame 准入、服务重启凭据轮换、业务恢复、IME/DPI 和整机性能，ADR-007 保持 Proposed。

## P07 实施时的本地源码对照（2026-09-23）

本轮核对 `.research/upstream` 的固定 HEAD：DeepSeek Harness `ddefc45fbc7f`、Pi `36b60d2e8985`、Codex `78245b47af2a`、LangChain `eba445b7563d`，均与 1.1 清单一致。只使用审批边界的机制，不引入它们的运行时或复制其业务模型。

| 本次需求 | 本地源码/对应测试 | 采用方式与 Relay 差异 | 本次开发自检 |
|---|---|---|---|
| 操作请求与默认拒绝 | DeepSeek Harness `packages/core/tools/src/index.ts` 的 `serviceAsk`；`packages/core/tools/tests/tools.spec.ts` 的 ask/无审批通道测试 | 借鉴无审批通道时不执行、区分拒绝与取消；Relay 将 Review 决定持久绑定 `operation_id`、目标 hash、时限。P09 才消费批准与建立 Invocation | 真实 PG 中 DENY 后 Run 保持等待且后续步骤不派发 |
| 工具钩子和审批不是业务提交 | Pi `packages/agent/src/types.ts` 的 `BeforeToolCallResult`/`BeforeToolCallContext`；`packages/agent/test/agent-loop.test.ts` | 借鉴调用前阻止；Relay 的 Review 与 Verification/Completion 分离，钩子不能直接写 Task DONE | 必需人工项未决阻止完成；ACCEPT 生成独立后继 PASS 才进入完成 Gate |
| 按具体动作请求批准 | Codex `codex-rs/app-server-protocol/src/protocol/common.rs` 的 `CommandExecutionRequestApproval`、`FileChangeRequestApproval` 协议项及相邻序列化测试 | 借鉴具体动作类型；Relay 额外要求操作身份、规范目标/内容摘要、有效期与数据库事务，协议消息本身不构成批准消费 | 目标 hash、revision 与版本变化拒绝，命令重放只返回同一决定 |
| 类型化人工决定 | LangChain `libs/langchain_v1/langchain/agents/middleware/human_in_the_loop.py` 的 `ReviewConfig`/`_process_decision`；`tests/unit_tests/agents/middleware/implementations/test_human_in_the_loop.py` 的 allowed_decisions/拒绝测试 | 借鉴每种请求限定决定和拒绝后不执行；Relay 不把 middleware interrupt 当作 State/Run/Task 事实，决定后在本地短事务完成领域效果 | State `base_revision` 冲突拒绝、预算 1–6 有界、同命令幂等 |

这些检查覆盖 P07 本地源码参考与有限自动化开发自检，不构成外部操作恢复、Windows 桌面或 P09 Gateway 验收。

## P09 开工前的本地源码对照（2026-09-23）

本轮只读核对 `.research/upstream`，四个缓存的 origin、干净工作树和 HEAD 均与[锁文件](upstream-lock.json)一致：DeepSeek Harness `ddefc45fbc7f8e46dd73185e68295696d1297887`、Pi `36b60d2e8985899743c4cf5bd5f8929832a3f05d`、Codex `78245b47af2a7aafcabe025828ceecca69db4df1`、LangChain `eba445b7563d1709427bd8072892975a6ea59fdc`。下列测试只定位到上游源码，**本轮没有运行上游测试**；“采用”是 P09 的机制参考，不表示 Gateway 已实现。

| P09 需求 | 固定提交下的源码符号 / 对应测试 | 拟采用方式 | Relay 差异 | 本轮待测 / 已有证据 |
|---|---|---|---|---|
| Prepare→Admit、缺审批通道默认拒绝 | DeepSeek Harness `packages/core/tools/src/index.ts`：`createExecution`、`prepareExecution`、`serviceAsk`、`restrict`；`packages/core/tools/tests/tools.spec.ts`：`lets a tools/pre-execute listener deny a call`、`an ask decision degrades to deny when no approval seam is mounted`、`skips dispatch when caller cancellation arrives while pre-execute awaits` | 借鉴分阶段准入、拒绝先于 dispatch、无审批通道时拒绝；每次执行前检查实际工具与参数 | `restrict` 只限定工具可见性，不是目录隔离；Relay 须在同一 authority 行串行化撤销与准入，持久化规范目标、批准占用、Invocation 和结果，不能用 hook 的允许结果替代权限事实 | 待测撤销/准入两个提交顺序与批准竞争；P07 已有“拒绝后不派发下一步”的局部 PG 自检，不能证明 P09 准入 |
| 工具钩子、动作身份与 UNKNOWN | Pi `packages/agent/src/agent-loop.ts`：`prepareToolCall`、`executePreparedToolCall`；`packages/agent/src/types.ts`：`BeforeToolCallResult`/`BeforeToolCallContext`；`packages/agent/test/agent-loop.test.ts`：`should stop after a blocked tool call when beforeToolCall sets terminate=true`、`should execute mutated beforeToolCall args without revalidation` | 借鉴调用前阻止与取消传递，把实际执行放在准入后 | Pi 测试表明 hook 可修改已校验参数且执行前不再校验；Relay 必须冻结并复核动作目标/参数，把持久 `operation_id` 与每次 `invocation_id` 分开，UNKNOWN 不得换 ID 或 Provider 再执行；`toolCall.id` 和取消信号都不能证明外部效果 | 待测 C03、D01–D03 的参数变更、丢回执与同一效果只调用一次；本轮无 P09 运行证据 |
| 审批中断与实际资源隔离 | Codex `codex-rs/app-server-protocol/src/protocol/common.rs`：`TurnInterrupt`、`CommandExecutionRequestApproval`；`codex-rs/app-server/tests/suite/v2/turn_interrupt.rs`：`turn_interrupt_resolves_pending_command_approval_request`；`codex-rs/app-server/tests/suite/v2/command_exec.rs`：`command_exec_enforces_managed_deny_read_requirements` | 借鉴审批请求与中断分别建模，以及把文件限制落实到执行端 | Codex 的中断只证明轮次/待审批请求被处理，不能证明旧进程停止；文件限制测试为 Unix 条件测试，不能证明 Relay 的 Windows 沙箱。Relay 须校验 Task、worker、resource 三类 token，并对重叠根实施 HELD/QUARANTINED 排他 | 待测 B07/B08、D07：跨 Task 根冲突、过期 claim 与旧进程未停止时拒发新写权；本轮无 Windows 隔离证据 |
| 人工决定及编辑后的再准入 | LangChain `libs/langchain_v1/langchain/agents/middleware/human_in_the_loop.py`：`ReviewConfig`、`_process_decision`、`interrupt`；`libs/langchain_v1/tests/unit_tests/agents/middleware/implementations/test_human_in_the_loop.py`：`test_human_in_the_loop_middleware_rejected_call_not_executed_and_stays_paired`、`test_human_in_the_loop_middleware_disallowed_action` | 借鉴按工具限制允许的决定、拒绝后不执行与决定数核对 | middleware 的 `edit` 可在执行时替换目标/参数，`respond` 可生成成功 ToolMessage；Relay 必须把编辑视为新动作重新 Prepare/Admit，批准固定原逻辑动作，消息成功不等于效果或业务提交 | 待测 C03/C09：目标变化使旧批准失效、重启后批准只关联一个逻辑动作；P07 的类型化决定自检不覆盖 P09 批准消费 |

这些只读对照为 P09 开发提供可追溯的机制输入。P09 仍须以自身 FakeAdapter、真实 PostgreSQL 并发/故障测试和实际执行边界核对上述待测项；不得从上游测试名称或 P07/P08 局部证据推断 Gateway、权限撤销、UNKNOWN 处置或资源隔离已完成。

## P11 开工前的 Context 源码对照（2026-09-23）

为下一段 Context Builder 定位接入边界，已只读核对 Pi `.research/upstream/pi` 的 origin、干净工作树、稀疏检出范围与固定提交 `36b60d2e8985899743c4cf5bd5f8929832a3f05d`，LangChain `.research/upstream/langchain` 的 origin、干净工作树与固定提交 `eba445b7563d1709427bd8072892975a6ea59fdc`，以及 Vercel AI SDK `.research/vercel-ai` 的 origin、干净工作树与 `ai@7.0.107` 对应提交 `08ae5ad05bc12496dd1ffcf64e34419e0831300d`；来源见[本地源码清单](#11-本地源码对照清单2026-09-20-核验)及[SDK 锁文件](../../experiments/ai-sdk-p00/upstream-lock.json)。只定位源码与测试，本轮没有运行上游测试，也没有实施 P11。

| P11 需求 | 固定提交下的源码符号 / 对应测试 | 拟采用方式 | Relay 差异与待测点 |
|---|---|---|---|
| Context 装配与模型消息转换分开 | Pi `packages/agent/src/agent-loop.ts` 的 `streamAssistantResponse` 先调用 `transformContext`，再调用 `convertToLlm`；`packages/agent/src/types.ts` 的 `AgentLoopConfig`；`packages/agent/test/agent-loop.test.ts` 的 `should handle custom message types via convertToLlm`、`should apply transformContext before convertToLlm` | 将 canonical facts、来源选择与模型输入转换分为明确步骤，UI 专用消息不直接充当模型事实 | Pi 的示例允许裁剪旧消息；Relay 必须先强制校验 Mandatory、权限、固定验收与预算，不允许通用裁剪丢掉 HARD Rule。待测必需内容超预算、来源更新和外部文本注入；P05 的固定 fixture 还不是 P11 Builder |
| UI 消息到模型消息的边界 | AI SDK `packages/ai/src/ui/convert-to-model-messages.ts` 的 `convertToModelMessages`；同目录 `convert-to-model-messages.test.ts` 的系统、用户、数据与工具结果转换用例 | 仅在模型端口需要时复用已验证的消息转换，不另造 Provider 格式转换器 | SDK 转换过滤未完成工具调用，数据片段需显式 converter；它不负责 Relay 的来源版本、实际送入片段、裁剪理由或准入。待测 Manifest 与实际输入一致、无权限来源不泄露、历史读取重新鉴权，且不能让 SDK 自动执行工具绕过 Gateway |
| 可选内容的预算裁剪 | LangChain `libs/langchain_v1/langchain/agents/middleware/context_editing.py` 的 `ClearToolUsesEdit.apply`、`ContextEditingMiddleware.wrap_model_call`；`tests/unit_tests/agents/middleware/implementations/test_context_editing.py` 的阈值、保留最后结果与自定义 token counter 用例 | 借鉴调用前基于阈值选择性裁剪，并区分估算与模型计数 | 上游对消息副本清理旧 Tool 输出；Relay 只能裁剪 Relevant，不得清除 Mandatory、固定验收或持久动作证据。裁剪前后实际片段及排除原因必须进入 Manifest；超预算时明确失败而非自动生成摘要冒充原件 |

P11 实现仍以[运行设计](../architecture/runtime-context.md#3-context-builder-管道)和四份契约为准；上述上游实现只是转换机制参考，不是缓存、权限或历史追溯的业务事实源。

## P12 开工前的模型端口源码对照（2026-09-23）

预先只读核对 `.research/vercel-ai` 的 origin、干净工作树及固定提交 `08ae5ad05bc12496dd1ffcf64e34419e0831300d`（`ai@7.0.107`，见[SDK 锁文件](../../experiments/ai-sdk-p00/upstream-lock.json)）；Pi 的转换边界见上节及固定提交 `36b60d2e8985899743c4cf5bd5f8929832a3f05d`。本节只定位 P12 将复用的机制与危险边界，**尚未安装生产 SDK、运行上游测试或实施 P12**；实际依赖版本和 API 兼容性须在 P12 开工时重新核对。

| P12 需求 | 固定提交下的源码符号 / 对应测试 | 拟采用方式 | Relay 差异与待测点 |
|---|---|---|---|
| 流式结果、取消与用量 | AI SDK `packages/ai/src/generate-text/stream-text.ts` 的 `streamText`、合并 AbortSignal、`responseMessages`/`usage`/`finishReason`；`stream-text.test.ts` 的 AbortController、流中断与不完整续步用例 | 模型端口可复用 SDK 的流式协议与 typed 结果，不重写 Provider 流解析 | 完整响应或合法候选持久化后才推进业务步骤；取消信号不证明已准入工具的外部效果未发生。请求身份、未知用量、错误类型和每次尝试须入 Relay 记录，待测超时/中断/半成品不执行 |
| 工具 schema 与执行分界 | `packages/ai/src/generate-text/parse-tool-call.ts` 的 `parseToolCall`、`execute-tool-call.ts` 的 `isExecutableTool`；`parse-tool-call.test.ts` 的无工具、未知工具与无效 JSON 用例，`stream-text.test.ts` 的失败尝试不执行工具用例 | 使用 SDK 解析/校验候选；不注册 `execute` 以免模型流自动调用工具，完整候选由 Relay Gateway Prepare/Admit | SDK 可把无效输入保留为带 `invalid` 的 tool-call，并有 `providerExecuted` 动态工具分支；Relay 必须显式拒绝无效/未知/供应商自执行写动作，不能把 SDK `toolCallId` 当持久 `operation_id`。待测 schema 错误、断流、重复 ID 与 Gateway 准入 |
| 审批请求 | `packages/ai/src/generate-text/collect-tool-approvals.ts`、`resolve-tool-approval.ts`；`generate-text.test.ts` 的 `needsApproval` 请求/响应用例及伪造响应用例 | 参考 SDK 的请求/响应形状，但保持 Relay 的 Review 决定、权限版本与 Gateway Invocation 为唯一业务准入 | SDK 审批消息或签名不是 Relay 的持久批准占用；批准必须绑定原逻辑动作、目标/参数/配置摘要并在当前 authority 下重校验。待测提案过期、批准竞争、撤销与 UNKNOWN 不重发 |

P12 是否接入一个真实 Provider 由实际配置决定；缺合法端点时可完成 ModelPort/Fake 故障开发自测，但真实调用与用量仍记未验证，不从上游单元测试推断本机连通。
