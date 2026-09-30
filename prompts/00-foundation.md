# P00：成熟实现研究、复用验证与工程基础

> 当前执行入口为 [M01–M07](stack-migration.md)。本文件保留原 P 阶段业务范围；模型统一 gpt-6-sol / ultra，UI 使用完整 React 迁移路线，技术选择按 ADR-010。不得按旧编号重建已存在工程或跳过当前模块验收。

前置：提供完整设计包和独立 PROJECT_ROOT。2026-09-20 后端开工请求从本文末尾的 Terra 接续提示词进入，先补已有 P00 的缺项；以下完整提示词保留作为范围依据。

```text
为 Personal Workflow OS 创建或完善独立工程。先读 AGENTS.md、prompts/README.md 公共约束、docs/architecture/技术选型.md、docs/frontend/workbench-design.md、docs/deployment/本机部署.md。核验当前目录属于本项目；若仍是 AI Manga Drama Studio，停止该目录写入，只询问独立工程位置。

先读 docs/architecture/复用策略.md 和 ADR-005。第一段研究 Codex App Server、DeepSeek Harness、Pi、LangChain、LangGraph 的相关源码，固定 tag/commit，记录具体模块/测试、许可证、维护与兼容限制。按职责区分直接依赖、协议集成、机制借鉴和必须自研；不要仅增加参考名单，也不要整仓照搬。
源码优先从 D:/Develop/Relay-Agent/.research 读取，路径和提交查 docs/research/p00-source-study.md 的本地源码清单；执行 prompts/README.md 的“本地源码参考要求”，按当前机制定位实现与测试，并交付采用差异和验证依据。

当前 TypeScript-first 推荐为 Proposed，先读 ADR-006 和测试计划第 6 节。在已有源码证据与实验上补 AI SDK/Kysely 等必要源码及兼容验证，不重做已有研究。完成三个 Spike：真实 PG 审批后跨进程恢复、外部成功但未落库的 UNKNOWN 核对、两个真实 Provider 的适配。Fake 只替代明确标注的模型/外部效果，不能证明真实 Provider 通过；不为 Spike 开放真实用户项目的 Git/CLI。补并发 Delegate、停止/完成竞争、迁移完整性及事务测试。统一工作量比较延迟、总 RSS、吞吐和事件循环延迟，性能预算在运行前明确；保留 Rust 对照，不把本地微基准当端到端结论。输出采用表、证据与未验证项，不默认重写通用框架。

同时读 ADR-007 和测试计划第 7 节，在隔离目录验证 Windows 桌面打包、随包 Node、loopback 引导/来源校验、单实例与退出；框架仍 Proposed，不以空壳性能替代完整组合。用户交付目标为可安装应用、独立窗口和启动入口。

仅在用户当前任务授权实施且第一段证据满足出口后，第二段再建立 pnpm workspace、apps/desktop、apps/api、apps/web 和开发说明。推荐组合、引入阶段与精确版本以 docs/architecture/技术选型.md 为准，验证后锁定；提示词不另维护依赖版本表。Kysely Migrator 候选须验证历史内容校验和并发迁移，JSON Schema 须验证 SDK/Provider 子集兼容。Python、pg-boss、专用 Agent Adapter 按需引入，实验依赖不自动成为生产依赖。不使用 latest/SNAPSHOT 可变依赖，已有兼容工程不重写。具体模型配置遵循 prompts/README.md 的当前用户指令。

人工阶段有桌面壳、API/web；执行阶段增加同仓同版本 apps/worker，通过共享应用用例和数据库协议执行，不新增微服务或领域 IPC。只有出现实际共享调用方才提取 packages，不生成完整空包树。同步进程健康、连接池/并发上限、取消、恢复和打包；Python 工具按需启动并验证子进程树取消。配置来自外部环境，data_root 与源码分离。加入 loopback、短期 Bearer、窄 IPC 启动握手及无敏感细节的 liveness；所有业务接口继承鉴权。发布 WebView 的显式来源与 Vite 开发代理分开验证，不加入团队登录、托盘、自启或多窗口。

只建立有当前用途的 application/domain/infrastructure/api 组织，暂不生成所有业务空类。提供可复制的配置示例但不写实际密钥。测试数据库必须显式独立，不能连接 Manga 或用户生产库。

验收：源码研究、采用表、PoC 与工程构建/类型检查/最小启动/未鉴权拒绝均有证据；若 PG/Docker 不可用明确记录，不捏造通过。README 写清实际启动/测试命令及依赖；当前阶段与缺口只更新 CODEX_NEXT_STEP.md，只有需要独立长期里程碑时才建立 ROADMAP。修订与选定框架重叠的 Run/Step/checkpoint 物理设计后再交 P01，不照原示例机械建表。交付源码与版本核验记录。
```

## Terra 后端开工接续提示词

更新：2026-09-20。主 Agent 编写任务与验收要求，Terra 负责开发、测试和修复。下列两段分别交接，均遵循本节共同约束；先验证、再建工程，最后交接 P01。提示词不将未验证的组合改为 Accepted，也不把独立数据库实验等同 P00 全部通过。

共同约束：

- 工作区固定为 D:/Develop/Relay-Agent；执行模型为 GPT-5.6 Terra，reasoning_effort=xhigh。实际模型由执行环境配置，提示词不能自行切换；不可用时如实报告，不冒称已调用。
- 所有解释中文。先读 AGENTS.md、CODEX_NEXT_STEP.md、prompts/README.md 及本文完整 P00 范围。检查 git status、未跟踪文件和实际目录，不能因 git diff 为空判定没有既有内容。
- Terra 负责本段相关实验/工程、测试与受影响文档；主 Agent 负责提示词与证据核对。你不是唯一开发者，不回退或覆盖他人改动。apps/workbench 及其进程属于独立前端任务；不修改、不重建第二套业务页面。需要共享根配置时先核对兼容影响。
- 依赖复用已有研究、源码与锁文件；精确版本只在相应事实源维护。不改变系统默认运行时，不借用其他项目数据库，不读取宿主登录凭据。测试数据和清理限定在本次独立测试库、目录和进程。
- 两段均执行 prompts/README.md 的“本地源码参考要求”：先按 P00 本地清单定位 D:/Develop/Relay-Agent/.research 内与本次改动相关的实现和测试，核对提交与依赖版本；交付引用具体文件/符号、Relay 适配差异和验证依据。缺少源码时报告缺项，不用摘要代替源码核对；已有有效研究与实验不重复开展。
- 研究取舍和必要实验指标只更新相应既有事实源；验收短摘要由协调方并入统一功能验收表，不复制多份逐次结果或保存重复全量输出，遵守 prompts/README.md 的输出保留规则。当前进度只更新 CODEX_NEXT_STEP.md。同步实际受影响的数据库/API/部署文档，接口变化注明 Breaking Change。不自动接受 ADR，不伪造 commit、测试、性能或桌面验收。
- 每段交付改动清单、运行命令与退出结果、输入 commit 或文件摘要、证据路径、验收映射、未覆盖项及下一段资格。失败、未运行、外部条件阻塞分别列明；涉及外部缺项先完成其余独立工作。

### 第一段：补齐 P00 验证

```text
你是负责开发的 Terra。在 D:/Develop/Relay-Agent 执行 P00 验证接续，先读取 prompts/00-foundation.md 的共同约束。本段范围仅为补齐实验、测试及证据，不创建生产 apps/api、正式 V001 或业务页面。不要只回复计划，直接完成当前条件下可运行的验证与修复。

1. 建立缺口表，再执行。
读取 docs/research/p00-source-study.md、docs/architecture/复用策略.md、docs/architecture/技术选型.md、ADR-005/006/007、docs/testing/verification-plan.md 第6/7节，以及 experiments/typescript-p00、ai-sdk-p00、recovery-p00、desktop-p00 的 README、输入锁定和逐次结果。
按“规格条目 / 实测状态 / 输入摘要与证据 / 未覆盖项 / 本次动作”列出缺口。核对后复用有效的基础 PG、SDK 离线、恢复和真实 WebView 局部证据；输入变化或证据不充分才重跑相关检查。不重做已有六仓研究，不重复搭建环境，不把测试数量当完整 Spike 通过。

2. 补真实 PG 恢复、并发与事务缺口。
继续现有隔离实验，使用真实 PostgreSQL、实际 AI SDK 边界及明确标注的 Fake 模型/文件效果。按四份 contracts 与 verification-plan 细化断言，重点补：
- Spike 1：完整请求/响应、规范化参数、Review 与原动作身份跨进程保留；双批准、双 Worker 竞争；全部批准失效条件；批准消费后、DISPATCHING 准入后但调用前崩溃。恢复不重调已完成模型轮次，不凭消费标记推断成功。
- Spike 2：外部效果成功但未落库后强制退出，新进程按原身份核对；部分写入、外部编辑、证据缺失、能证明未发生时的安全恢复；不能以内容相同证明本次动作成功，不能换 Adapter/动作 ID 盲重发。
- 资源和执行权：跨 Task 冲突、租约过期但旧进程仍存活、Worker claim epoch 与业务执行权的区别、旧结果拒绝；旧写入未安全处理前不释放冲突资源或宣称 Handoff 完成。
- B01、B03–B05：并发 Delegate 最多一个 live Run；控制意图持久化；控制先提交/完成先提交两种确定顺序；接手必须等待安全边界。实验中的 PASS/完成记录如为替身须明确，不能冒充生产 Verification 通过。
- 核对迁移重复/并发、历史文件变更/缺失、共享事务回滚、bigint 无损、应用角色权限和 CAS 的既有覆盖，补实际缺项。
并发时序使用 barrier/latch 和独立连接/进程，不以固定 sleep 或仅 Promise.all 证明锁竞争。崩溃场景记录实际退出点与恢复进程；分别报告模型调用、工具调用、外部效果及业务提交次数。实验 schema 不冒充正式 migration。

3. 补 SDK/schema、真实 Provider 与性能证据。
验证实际 SDK、运行时 schema 校验及两 Provider 子集的联合兼容，覆盖合法输出、半截参数、非法 JSON、拒绝、断流、超时和取消；结构失败不得执行工具。两 Provider 各使用用户合法配置的真实端点，Domain/Workflow 不因更换 Provider 改写。工具不通过 SDK execute 绕过 Relay 的持久准入。
缺端点时只保留该项阻塞，继续离线和数据库工作；不索取明文密钥入文档、不读取宿主凭据。网络调用证据须脱敏；Mock 不证明 Spike 3。
测量前固定工作量、重复次数、版本与环境；按技术选型报告分位延迟、吞吐、事件循环延迟、API/Worker/PG 总资源和锁竞争。性能预算未确认时可交原始测量，不能自设阈值宣称产品 SLO 通过，不能用微基准替代组合性能。

4. 补最小桌面宿主验证。
按 ADR-007 和测试计划第7节，复用 desktop-p00 已有 release 目录包、随包 Node、真实 WebView 握手/重载及正常退出证据，补单实例、伪造 readiness/错误实例、来源与 frame 准入、异常退出和孤儿进程等 P00 宿主缺口。保持隔离验证，不接入业务页面或真实用户工具。正式安装/升级完整回归仍按 P20，不提前要求整个产品完成，也不能把目录包称为 MSI/NSIS 交付。真实窗口无法验证的部分如实列为未运行。

5. 收尾与交接。
运行变更相关的类型检查、测试、构建及 node scripts/check-docs.mjs。必要实验指标更新原实验说明，研究取舍更新 P00 研究记录，验收结果并入统一功能验收表，阶段更新 CODEX_NEXT_STEP.md；保留既有历史，不为普通复跑另存完整输出或新建报告。
交付逐项出口表：通过/失败/未运行/外部条件阻塞，关联规范与证据；结论明确“P00 工程搭建可开始”或“尚缺哪些前置”。完整 Spike、共同冻结门槛或 P00 宿主必要项未满足时，不进入生产工程，不自行放宽门槛。本条的默认门槛不覆盖用户已记录的范围决定：2026-09-20 用户确认在保留挂账项的前提下放行进入第二段，条件与挂账清单见下方第二段开头；放行不等于挂账项已通过。完成可独立工作后带具体缺项交回主 Agent，不反复空跑。本段不自动进入下一段。
```

### 第二段：建立最小生产工程

```text
你是负责开发的 Terra。在 D:/Develop/Relay-Agent 执行 P00 工程搭建，先读取 prompts/00-foundation.md 的共同约束和第一段交付证据。默认前置是测试计划第6节及第7节 P00 对应出口已经满足；独立实验通过、口头总结或缺端点跳过均不能替代。本次开工按用户已记录的范围决定执行：2026-09-20 用户在保留挂账项的前提下放行进入工程搭建（依据 CODEX_NEXT_STEP.md 第 7、43 行，第三批证据见 P00 研究记录），因此不因下列挂账项未补齐而拒绝本段开工。

挂账项必须作为未覆盖项随交付保留，不得记为通过、不得删除、不得据其冻结 ADR-006/007：Spike 3（缺两个真实 Provider 端点）、多产物版本集合与人工处置链、生产权限/Gateway、桌面宿主剩余必要安全边界、固定工作量性能预算。放行只覆盖本段最小工程范围，不覆盖 P01；若核对发现第一段结论与该记录不符，报告差异并回到对应验证，不自行扩大放行范围或降低本段验收要求。

读取 docs/architecture/技术选型.md、docs/development/first-human-slice.md、docs/deployment/本机部署.md、docs/database/physical-design-postgresql.md 及 ADR-006/007。先核对现有 apps 和锁文件，按已验证组合搭最小 pnpm workspace、API 与必要桌面启动边界；复用现有前端工程，不因旧提示词写 apps/web 就复制 apps/workbench。需要共享配置时保持其既有命令可用，业务页面由独立前端任务负责。

只建立当前可运行调用链需要的目录、配置和接口。配置外置，data_root 与源码分离；loopback 绑定、短期 Bearer、窄 IPC 引导、精确 Host/Origin、无敏感信息的 liveness 及退出处理符合既有部署契约。健康检查不伪装成业务功能。暂不建立生产 Worker 平台、Python 常驻服务、通用 DSL、Skill/Pack 或未来空模块，实验依赖不自动转成生产依赖。

核验后锁定实际依赖和运行时版本，记录来源及必要差异；基于 P00 采用结论核对 Run/Step/checkpoint 物理设计，避免两个恢复所有者。只同步实际受影响的设计，不机械搬入实验 SQL。本段不实现正式 V001、人工应用用例或 P02。

验收必须有实际命令和证据：锁文件安装、类型检查、构建、最小启动、未鉴权拒绝、错误 Host/Origin 拒绝、配置缺失明确失败、停止后本次服务退出。桌面连接从真实打包产物验证，开发浏览器结果单列。共享配置改变时重跑受影响的现有前端命令。

在 README 写入实际可复制的安装/启动/测试命令与配置示例，在 CODEX_NEXT_STEP.md 更新实际阶段，运行 node scripts/check-docs.mjs。报告已实现的边界、未实现的业务能力、本次挂账项的当前状态及 P01 前置是否满足，交回主 Agent；不把工程可启动称为人工闭环或安装交付，不自动执行 P01。挂账项不因本段完成而消失，只更新其状态。
```
