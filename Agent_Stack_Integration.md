# 个人工作流智能体：技术栈与接入规格

> 文档角色：2026-09-23 用户提供的原始参考规格，正文保留。后续用户明确要求全部既有界面迁移 React、交付 Windows 桌面，并按本项目现状挑选组件。当前实施取舍见 [ADR-010](docs/decisions/ADR-010-agent-stack-react-desktop.md) 与 [技术选型](docs/architecture/技术选型.md)：保留 Kysely/PG，分发优先 PG，Drizzle/Redis/BullMQ 不作为必装项。附件内的 React 已有、Linux 生产部署等假设不是仓库事实；内嵌执行提示词由 [当前提示词](prompts/README.md)接续。

**决策日期：2026-09-23**  
**目标：在同等任务成功率、恢复能力和权限边界下，优化端到端延迟、成功任务吞吐与资源占用。**  
**交付性质：架构及接入规格，不是已经在用户仓库中编译、运行或压测过的代码。**

## 1. 冻结的技术路线

采用 **TypeScript 主栈：Node.js 24 LTS + Fastify 5 + LangGraph.js + PostgreSQL + Redis/BullMQ**。

它是针对「个人工作流智能体 / Agent Workspace」的明确工程选型，不是跨语言性能冠军声明。当前没有相同业务负载下证明此方案全面胜过 Python 或 Rust 的实测结果。

适用范围是调用外部模型 API 或独立本地推理服务的应用层：项目、任务、上下文、Chat、Agent Run、审批、产物及工具执行。不在 Node.js 主进程中执行模型推理或训练。

| 层 | 选定技术 | 责任与边界 |
| --- | --- | --- |
| 前端 | 沿用 React + TypeScript；新建独立前端时使用 Vite | 保留已有页面、状态管理、路由和设计；本次不做前端重写 |
| 主运行时 | Node.js 24 LTS + TypeScript，ESM | API 与 Worker 使用同一主语言；生产运行编译后的 JavaScript |
| API | Fastify 5 | 鉴权、输入校验、创建 Run、查询、审批、SSE，不在请求生命周期执行长任务 |
| Agent 编排 | LangGraph.js 1.x | 唯一的通用 Agent 编排核心；有状态图、工具循环、检查点与人工介入 |
| 模型适配 | @langchain/core + 实际供应商对应的 Provider 包 | 默认从 @langchain/openai 适配器起步；按供应商能力决定 native adapter 或 compatible endpoint，不宣称各家协议完全一致 |
| 业务存储 | PostgreSQL 18，新服务使用独立 schema | Workspace/Project/Task/Run/Approval/Artifact 元数据及可靠事件 |
| 数据访问 | Drizzle ORM 稳定版 + pg，Drizzle Kit 迁移 | 显式 schema；复杂热点查询允许参数化 SQL；禁止自动采用文档中的 RC 依赖 |
| 检查点 | @langchain/langgraph-checkpoint-postgres | 使用官方 PostgresSaver；与业务表分开迁移和保留策略 |
| 排队与分发 | BullMQ + Redis | 排队、有限重试、分发、并发控制；不再创建第二套业务流程图 |
| 实时通信 | HTTP + SSE；终端交互单独 WebSocket | SSE 推送文本增量/运行状态/审批提示；写操作通过 HTTP |
| 知识检索 | PostgreSQL + pgvector | 检索模块出现后启用；不在首期强制部署独立向量数据库 |
| 工具 | ToolAdapter + 文件/Git/终端/Web 适配器 | 项目目录隔离、权限校验、有界并发、取消与超时 |
| 编程执行器 | 独立 CodingWorkerAdapter | 保留已有 Codex/Claude/Gemini CLI 接口；这些执行器不是整个产品的底座 |
| 产物 | 单机：受控持久化目录 + PostgreSQL 元数据 | 保存 artifact ID、相对位置、内容哈希与来源；跨机器部署前换统一对象存储适配器 |
| 日志与测试 | Fastify/Pino、Vitest、Playwright | 统一 run_id/step_id；服务端测试与端到端流程测试；禁记完整密钥 |
| 部署 | Linux + Docker Compose | 第一阶段 api、agent-worker、postgres、redis 四类服务；前端静态资源可由现有站点分发 |

版本规则：Node.js 固定 24 LTS 分支；Fastify 固定 5.x；LangGraph 固定 1.x。其余依赖采用实现时验证相互兼容的正式稳定版本并精确锁定，不安装 beta/RC，不从仓库 main 分支的 package.json 推断已发布版本。提交 pnpm-lock.yaml；镜像固定补丁版本或 digest。已存在受支持的 PostgreSQL 主版本时，不为新增 Agent 模块强行升级或搬迁原业务库。

## 2. 保留与排除

保留 Workspace、Project State、Task/Next Action、上下文 Chat、Artifact、Review/Approval、专属任务 Workbench 与页面路由。不把 React Router 的页面路由和 Agent Router 的执行路由混成同一机制。

V1 工具优先 Files、Git、Terminal、Web。MCP 只保留 Adapter 边界，按此前范围放在 V1.5；没有 MCP 也必须跑通主链路。API Worker 不得自动获得用户 Windows 主机的全部文件或已登录浏览器权限；本机权限交给显式授权的本地适配器，未实现时功能标记不可用。

本期不添加 Rust 网关、Python 常驻微服务、Kafka、Kubernetes、Temporal、第二套全局 Agent Runtime 或独立向量数据库。不是判定这些技术性能较差，而是本方案不需要它们。已有且工作的专业执行器保留，不因为本选型删除。

通用运行图选 LangGraph.js。不同时将 Pi、DeepSeek Harness、Codex Harness 等叠加为全局规划/重试/恢复的多个所有者。专业 Runtime 可以经 Adapter 被调用，但审批、取消和可靠性边界必须能传递到内部工具；不支持这些能力的适配器不得承担需审批的自动写操作。

## 3. 进程与数据流

```text
现有 React 前端 / 现有站点
        │ HTTP + SSE
        ▼
Fastify API
        │ 事务：Run + command + outbox
        ▼
PostgreSQL ── Outbox Dispatcher ──► BullMQ / Redis
                                      │
                                      ▼
                             独立 Agent Worker
                                      │
                           LangGraph.js 状态图
                           ├─ ModelProvider Adapter
                           ├─ ToolAdapter / CodingWorkerAdapter
                           └─ PostgresSaver
                                      │
                            可靠事件 + 输出分块
                                      ▼
                            PostgreSQL / 通知通道
                                      │
                                      ▼
                              API SSE → 前端
```

Outbox Dispatcher 初期可以与 Worker 同一个部署单元，不必另设服务。API 不等待模型完成；只在 Run 与待分发命令可靠写入后返回 202。API 可以重启，前端可以断线，已接受的任务不因此自动取消。

BullMQ 的工作单位是一次 **run command**：start、resume 或 recovery。LangGraph 的工作单位是任务内部步骤。一次审批中断应将 Run 标记为 WAITING_APPROVAL，然后结束这次队列任务并释放执行槽位；审批后创建新的 resume command，而不是让一个 Promise 一直等待用户。

## 4. 目录映射

下面是建议的模块边界，不是必须重排现有仓库的物理目录。

```text
apps/
  web/                       # 现有前端；优先仅修改 API 接入
  api/                       # Fastify HTTP / SSE
  agent-worker/              # BullMQ 消费、运行租约、编排入口
packages/
  contracts/                 # HTTP DTO / 事件 / 能力描述
  agent-runtime/             # LangGraph 图与节点
  model-adapters/             # 供应商原生与兼容接口
  tool-adapters/              # Files / Git / Terminal / Web
  coding-adapters/            # CLI Runtime 的可替换适配
  persistence/               # schema、事务、查询、迁移
  permissions/               # AUTO / ASK / DENY、审批绑定
infra/
  compose.yaml
```

已有主后端时，由既有入口代理 `/api/agent/*` 到新增 Fastify 服务；复用项目已有身份体系，不能因为分服务而绕过 workspace/project 的访问控制。不要为了这次接入同时重写用户系统、项目 CRUD 和 UI。

## 5. 最小 HTTP 契约

以下是本项目建议接口，不是 LangGraph 或 BullMQ 自带端点。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | /api/agent/runs | 校验权限、输入与预算，事务创建 Run/command/outbox，返回 202 + runId |
| GET | /api/agent/runs/:runId | 当前状态、等待原因、结果/产物引用、最后可靠事件序号 |
| GET | /api/agent/runs/:runId/events | SSE，支持 Last-Event-ID；首次进入可使用 after 游标 |
| POST | /api/agent/runs/:runId/approvals/:approvalId | 对具体待批动作批准/拒绝，校验版本，创建 resume command |
| POST | /api/agent/runs/:runId/cancel | 持久化取消请求并通知实际执行 Worker |
| POST | /api/agent/runs/:runId/resume | 从允许的暂停/可恢复失败状态继续；不能绕过审批或复活已取消任务 |
| GET | /api/agent/runs/:runId/artifacts | 仅返回当前身份有权查看的产物引用 |

所有写接口应支持 Idempotency-Key，并在数据库中建立唯一约束。相同身份/端点/Key 携带不同请求内容时返回冲突，不能静默复用旧结果。

建议 Run 状态：QUEUED、RUNNING、WAITING_APPROVAL、PAUSED、CANCEL_REQUESTED、CANCELLED、SUCCEEDED、FAILED。失败另存 retryable/reason；审批拒绝通常进入受控拒绝分支或 CANCELLED，不伪造成功。

建议事件：run.queued、run.started、step.started、message.delta、tool.started、tool.completed、approval.required、run.paused、run.resumed、artifact.created、run.completed、run.failed、run.cancelled。

## 6. 任务标识与恢复语义

定义三个不同 ID：

- run_id：用户看到的一次任务运行。
- command_id：一次 start/resume/recovery 指令；作为 BullMQ jobId 使用 UUID，不在 ID 中拼接冒号。
- execution_thread_id：映射到 LangGraph configurable.thread_id；同一 Run 的暂停、审批和失败恢复沿用它。

同一 execution_thread_id 同时只允许一个有效的 graph invocation。数据库维护带到期时间的执行租约及递增 fencing token，Worker 续租；所有业务状态变更校验 token。租约失效或无法续租时停止新的工具操作。不能只在 API 进程内使用 Map 锁。

BullMQ 去重不替代数据库幂等，也不提供外部副作用的 exactly-once 保证。外部 API 支持幂等键时传递稳定的逻辑 operation_id；文件修改采用版本前置条件/内容哈希；不能幂等且执行结果不明时进入人工核对，不盲目重试。

PostgresSaver 保存的是图状态，不是正在运行的内存栈或外部进程。恢复可能重放节点。将审批节点与执行副作用节点分开，审批前不执行写操作；审批绑定工具名称、规范化参数、目标、内容哈希和权限策略版本，参数变化需重新审批。

PostgresSaver 与业务事务不天然原子提交。用稳定 step/operation 标识、状态对账和幂等工具调用处理两者间的崩溃窗口；不能承诺安装 checkpointer 就自动解决所有一致性问题。

## 7. 可靠事件与 SSE

Run 的权威状态、审批记录和完成产物引用保存在 PostgreSQL。关键状态事件与业务状态在同一事务提交。Redis 通知只用于唤醒推送端，不作为唯一可恢复历史。

SSE 输出 `id`、`event`、`data`，前端按照事件标识去重。可靠事件使用单调序号；服务端按 run_id + seq 建联合唯一约束。不要直接用普通全局自增序号配合并发提交顺序假定所有已分配的更小 ID 都已经可见；应在单 Run 事件序列上串行分配/提交。

Token 增量合并后推送，默认窗口 30ms 是起始调优值，不是最优结论。检查点不按 token 保存。可恢复文本流按较大分块持久化；进程崩溃时允许丢失尚未落盘的尾部增量，前端应以恢复后的快照/最终消息为准。仅给可重放的数据分配持久化 SSE ID，避免以易失 token ID 越过可靠事件游标。

断线重连先补可靠历史，再无缝接实时流；实现订阅与补历史之间的竞态处理及周期性补查。浏览器断线仅关闭订阅，不取消 Run。用户主动取消才写入取消指令。

复用现有身份体系：同源 HttpOnly Cookie 需配合写操作 CSRF 防护；Bearer 模式可使用 fetch 流读取 SSE。密钥不得放在 URL 查询字符串中。

## 8. 模型与工具边界

ModelProvider 配置至少包含 provider、base_url（可选）、model、secret_ref、支持流式/工具调用/结构化输出的能力标记。API Key 不下发浏览器。默认不强制 LiteLLM 或其他额外代理服务，也不默认全量安装所有供应商 SDK。

不要把所有兼容接口视为完全相同。逐模型测试工具参数、结构化输出、token 用量、取消、错误码、长输出及多轮工具消息。base_url 可配置时应限制可访问目标，避免服务端请求伪造和误访问内网元数据接口。

LangGraph 编排只保留任务需要的节点：上下文构建、规划（仅必要时）、执行、验证、审批。简单任务不强制 Planner/Worker/Verifier 三轮模型请求；确定性校验优先使用程序完成。

同一轮选择通用工具循环或者委派完整 Coding Worker，不要让多个 Agent Runtime 反复重规划同一个步骤。Coding Adapter 显式报告 resumable、cancellable、approval_passthrough、sandboxed 等能力；不支持就不能伪装支持。

工具遵循既定权限：

- 允许范围内读取：AUTO。
- 项目目录内低风险、可逆写入：AUTO，仍需记录审计。
- 对外发送、推送，以及删除、覆盖或危险命令：ASK 或 DENY。

工具适配器收到 AbortSignal、deadline、allowed_roots、operation_id。CPU 重计算、浏览器及 CLI 执行不放在 API 主事件循环。启动命令使用明确的可执行文件和参数数组；不把未经验证的模型字符串直接拼进 shell。

子进程与 worker_threads 只是执行隔离，不是安全沙箱。不可信代码必须进入受限容器或更强隔离环境；不挂载 Docker socket、不授予 privileged、不暴露全盘与全部宿主密钥，设置 CPU/内存/运行时限与网络边界。Windows 主机适配器与 Linux 容器的路径/进程取消语义需单独测试。

## 9. 初始性能控制

下面是**需要由本项目实现的配置项**，不是相应第三方库天然识别的环境变量。数值仅为压测起点，不代表硬件容量或最佳参数。

```dotenv
RUN_CONCURRENCY_PER_WORKER=4
TOOL_IO_CONCURRENCY_PER_RUN=4
CPU_TASK_CONCURRENCY_PER_WORKER=1
MAX_INFLIGHT_PER_THREAD=1
SSE_FLUSH_INTERVAL_MS=30
RUN_MAX_MODEL_STEPS=12
```

先将模型调用和工具执行分设信号量；再设置供应商级共享 RPM/TPM 限制及总 token/调用预算。多个 Worker 的本地并发限制相加，不会天然构成全局限流。

只并行无数据依赖、且没有同一文件/资源写冲突的步骤。限制模型总轮次、工具输出体积、每个步骤超时、总运行预算与单工作区占用，避免一个超长任务耗尽资源。

复用模型 HTTP 连接、数据库连接池和可复用工具进程。连接池按 API、Worker、checkpointer 的进程总量预算，不能每增加 Worker 就忽略数据库最大连接数。

不在图状态里堆积完整大文件、大图、全部历史和无限日志；只保存必要上下文与产物引用。检查点和事件分开设置保留策略，保留审批及关键审计，定期清理可清理的大体积历史。

## 10. Redis 与部署约束

BullMQ 使用专用 Redis 实例或至少专门的运维容量预算：

```conf
appendonly yes
appendfsync everysec
maxmemory-policy noeviction
```

AOF 每秒同步不是零丢失承诺。Run 与 command 已在 PostgreSQL/outbox 中持久化，队列消息丢失后通过对账再分发。noeviction 也不表示内存无限；必须监控使用率、设置容量和对已完成作业的保留/清理策略。队列 Redis 不与采用 LRU 淘汰策略的普通缓存混用。

第一阶段 Compose：api、agent-worker、postgres、redis；工具执行容器按任务边界建立。所有数据库/Redis 只在内部网络暴露。运行镜像使用非 root 用户和受控环境变量。Windows 开发可使用 WSL2/容器，但不假定容器可以直接操作用户全部宿主环境。

单机产物保存在持久卷中。Worker 扩展到不同机器前，统一产物存储和工作区同步方案；不能把仅本机可见的绝对文件路径当作跨机器产物地址。

## 11. 接入顺序与验收

**阶段 A：执行闭环。** 保留旧入口，增加 AgentRuntime 接口、Fastify Run API、Worker 与数据库。用 Mock Model 验证创建 Run → SSE → 成功/失败，不消耗真实模型预算。

**阶段 B：真实工具与恢复。** 接一个真实 Provider 和 Files/Web 低风险工具；加入 PostgresSaver、审批、取消、幂等与 Worker 崩溃恢复。再接已有 CLI Coding Adapter。

**阶段 C：界面连接与压测。** Chat/任务详情使用 Run API；Review Inbox 使用审批接口；Artifact 显示产物引用；Workbench 页面继续由产品层路由，不让模型任意注入可执行前端代码。

必须通过的验收：

1. 提交后页面关闭，Run 仍有权威状态；重新打开可以查询与续接事件。
2. 审批暂停后无持续占用模型调用槽位；重复批准不会重复执行副作用。
3. Worker 在工具完成但检查点尚未提交时崩溃，恢复不会盲目重复非幂等写操作。
4. Redis 断线或重启后，通过 outbox/reconciliation 找回未完成指令。
5. 同一 execution_thread_id 不被两个有效 Worker 同时推进；租约失效停止新的副作用。
6. 用户取消后停止后续步骤，并把信号送到实际模型客户端/子进程；取消不宣称撤销已经发生的外部操作。
7. 未授权用户无法读取别人的 SSE、审批、产物或工作区文件。
8. Mock Provider 测出自身开销；真实 Provider 测出端到端效果，二者不混为同一跑分。

验收指标：受理延迟、排队等待、模型首 token、首个可见输出、完整任务 P50/P95/P99、成功任务数/分钟、重试率、取消收敛时间、事件循环延迟、CPU/RSS、数据库和队列等待、每成功任务 token/模型调用次数。

压测必须固定任务集、模型、输入输出长度、工具行为、并发、权限和持久化语义；不能以减少任务成功率或关闭必要检查点制造性能提升。暂不承诺具体 QPS 或百分比提速。

## 12. 可直接交给 Codex 的执行提示词

> 在当前仓库中增量接入 Agent Runtime，按照本文实施，不做整仓重写。
>
> 先检查 package.json、前后端入口、路由、鉴权、数据库迁移和已有 Agent/CLI 适配器，再把本规格的模块边界映射到现有目录。以实际代码为准，不假定仓库已经有某个框架或功能。
>
> 目标技术栈固定为 Node.js 24 LTS + TypeScript + Fastify 5 + LangGraph.js 1.x + PostgreSQL + PostgresSaver + Redis/BullMQ。数据库访问使用 Drizzle 稳定版 + pg；不得自动安装 RC。已有受支持数据库不强制迁移主版本。保留现有 React 界面、项目/任务/Workspace、设计系统、鉴权和数据。
>
> API 与 Worker 必须分进程。API 事务创建 run/command/outbox 后返回 202；Worker 从队列执行 LangGraph；前端通过 SSE 订阅。BullMQ 仅负责运行指令分发；LangGraph 是唯一通用流程执行器。审批中断释放 Worker 槽位，批准后创建新的 resume command。
>
> 实现本文的标识、状态机、权限、幂等、租约、取消、检查点与事件重放规则。不要把 queue jobId 去重或 PostgresSaver 描述为外部副作用的 exactly-once。MCP 不作为 V1 前提，先接 Files/Web，再保留或连接 Git/Terminal/已有 Coding Adapter。
>
> 按阶段 A→B→C 完成。先完成 Mock Model 的端到端测试，再使用环境变量指定真实模型和密钥。不要写死供应商模型名称，不要假装不同 compatible API 的能力完全相同。
>
> 提交数据库迁移、锁文件、环境变量样例、Compose 配置、Mock 测试、审批/取消/恢复的集成测试、最小压测脚本和 README。输出实际修改文件、实际执行命令、已通过测试与未验证项目；没有执行的测试不得标为已通过。

## 13. 官方依据

以下资料核对组件能力；本文的组合、边界、数值起点和实施规则属于工程设计，不是官方整体性能排名。

1. Node.js Release Schedule / LTS：`https://nodejs.org/en/about/previous-releases`
2. Fastify LTS：`https://fastify.dev/docs/latest/Reference/LTS/`
3. LangGraph.js 概览：`https://docs.langchain.com/oss/javascript/langgraph/overview`
4. LangGraph Checkpointers：`https://docs.langchain.com/oss/javascript/langgraph/checkpointers`
5. LangGraph Interrupts：`https://docs.langchain.com/oss/javascript/langgraph/interrupts`
6. LangChain JS 模型集成：`https://docs.langchain.com/oss/javascript/integrations/chat`
7. BullMQ 并发：`https://docs.bullmq.io/guide/workers/concurrency`
8. BullMQ 生产部署：`https://docs.bullmq.io/guide/going-to-production`
9. Drizzle PostgreSQL：`https://orm.drizzle.team/docs/get-started-postgresql`
10. pgvector：`https://github.com/pgvector/pgvector`
11. Node.js 事件循环：`https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop`
12. SSE：`https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events`
13. PostgreSQL 版本政策：`https://www.postgresql.org/support/versioning/`
