# 测试、故障注入与发布出口

日期：2026-09-19。状态：生产测试设计，尚未执行生产验收。业务场景编号以[契约包](../../contracts/README.md)的 A01–A09、B01–B08、C01–C09、D01–D11 为准，共 37 项。P00 已另行运行隔离实验，范围和结果见[实验记录](../research/p00-source-study.md)，不能据此将这 37 项标为通过。

## 1. 分层证据

| 层 | 方法 | 证明范围 |
|---|---|---|
| 领域 | 确定性单元测试 | 转移、验收条件、规则合并、资格判断 |
| 持久化 | 与部署同大版本 PG，独立 test DB | FK/唯一/CAS/锁、真正回滚、并发顺序 |
| 恢复 | Fake Adapter + 可控闩锁/断点 + 重启执行器 | durable 意图、UNKNOWN、迟到结果、幂等推进 |
| HTTP | 实际应用路由 + 测试身份 | schema、Problem Details、command replay、作用域 |
| UI | 组件测试 + 真实桌面壳与后端 E2E | Loading/冲突/接手/版本、重载恢复、窗口/DPI |
| Adapter | 临时仓库、模拟网络、受控进程 | 平台边界、执行证据与取消；不碰用户项目 |
| 发布 | 清洁环境安装/升级/备份还原 | 可运行交付与数据可恢复 |

Mock DB 不替代事务测试；固定 sleep 不作为并发顺序证明，使用 barrier/latch 控制两个连接的提交时序。可用 Testcontainers，也可显式测试 PG；不能自动连接生产 DB 或把缺环境的测试静默跳过后宣称全绿。

## 2. 37 项责任映射

| 验收编号 | 主要提示词 | 验证方法 |
|---|---|---|
| A01、A02 | P02、P07、P12 | 类型化 State 命令、过期提案与同 ID 重放 |
| A03 | P02、P03、P10、P11 | 重开/替代后投影和 Context 失效，历史保留 |
| A04 | P06、P10、P11 | HARD 交集、偏好覆盖和冲突 |
| A05 | P04、P14 | 切换 kind 前后 Run contract hash 不变 |
| A06 | P10、P11、P17 | 更新网页/文件后可定位旧实际片段 |
| A07 | P13 | 时区/午夜/Later 重启，Pin 不越权 |
| A08、A09 | P02、P05 | Inbox 人工可用，Delegate 无 Project 拒绝，Goal 子集 |
| B01 | P05 | 两 DB 连接竞争 Delegate，最多一个 live Run |
| B02 | P07 | Review 决定不改变 executor |
| B03、B04 | P08 | 控制持久化、控制/完成双提交次序 |
| B05 | P08、P16、P19 | 旧写入结束/核对前不 Handoff |
| B06 | P05、P08 | 终态再试新 Run、retry_of 正确 |
| B07、B08 | P08、P09 | 跨 Task 资源争用、旧 epoch 提交拒绝 |
| C01、C02 | P03、P06、P07 | 换验收/版本不继承 PASS/批准 |
| C03、C09 | P07、P09、P18 | 目标变更和批准重放、占用恢复 |
| C04 | P06、P07 | required HUMAN 未决不完成 |
| C05、C06、C07 | P06、P17、P19 | 论断无支持、测试删减、checker ERROR、HARD 不可豁免 |
| C08 | P11、P15 | 证据版本不被当前正文替换 |
| D01、D02、D03 | P08、P09 | PREPARED/DISPATCHING/SUCCEEDED 各断点恢复 |
| D04、D05、D06 | P03、P06、P08 | PASS 后崩溃、完成事务注入失败、响应丢失 |
| D07 | P09、P19 | 租约过期仍有进程，不授予新冲突写权 |
| D08、D09 | P16、P19 | 脚本变更、链接/环境/参数范围 |
| D10 | P16 | 外部编辑与多文件部分应用 |
| D11 | P17 | 重定向/DNS 指向受限网络 |

## 3. 故障点接口

仅测试 profile 注入：BEFORE_INTENT_COMMIT、AFTER_PREPARED_COMMIT、AFTER_DISPATCH_ADMIT、AFTER_EXTERNAL_EFFECT、AFTER_OUTCOME_COMMIT、AFTER_PASS_COMMIT、DURING_COMPLETION_TX、AFTER_COMPLETION_COMMIT。生产构建不开放 HTTP 触发故障的接口。

Fake Adapter 用独立持久效果日志表达“外部已发生”，不能与业务 DB 同事务回滚，否则无法模拟真实裂缝。计数器证明调用次数；证据记录证明恢复不是靠重新执行得到结果。杀进程类测试记录退出点与恢复数据库，不能只抛异常充当所有崩溃场景。

数据库约束测试必须尝试真实错误写入，包括 NULL 绕 CHECK、跨 Task FK、延迟 FK 在 COMMIT 失败、重复周期完成、QUARANTINED 占用、双批准消费。

## 4. 额外产品与安全验收

桌面 UI 与受控测试客户端同时编辑（不要求产品多窗口）；HTTP 超时后查回执；旧查询结果不能覆盖新数据；无 Project 的人工事项；纯展示切换；Review 页面加载后目标过期；Assist 切页后迟到响应；明文凭据不进入日志/Trace/产物。

中文基础搜索、信息版本和 Decision 替代、Goal 显式空集、Focus 无候选、产物 Lineage 循环拒绝均需对应单测/集成测试。来源不可用必须清晰错误，不用假数据填补。

2026-09-26 M05/P13 后端开发自检：`apps/api/test/integration/today.integration.test.ts` 使用隔离 PostgreSQL 与真实 HTTP 覆盖 Task 计划元数据、Workspace 级选择版本、跨午夜与 DST 的 Later、进程重启/命令重放、阻塞 Pin、Goal 显式空集、不同保存时区 Focus、同项目多 Task 排序及跨 Workspace 拒绝，6/6 通过；迁移 7/7、CLI 5/5，API TypeScript 构建和文档检查通过。该证据只覆盖后端开发自检，不代表 M05 独立验收或 Windows 桌面验收。

UI 视觉、组件状态与可访问性按[设计系统验收](../frontend/design-system.md#8-验证与交付边界)核对；token 的纯色组合检查只是静态证据，不能代替桌面 WebView 字体、窗口/DPI、键盘与辅助技术验收。

能力配置中 AUTO 不代表任意调用免检查。测试应覆盖连接存在但 DENY、批准已给但权限被撤销、配置更新使旧脚本授权失效，以及伪造外部文本要求扩大权限。

Schema readiness 使用真实 PostgreSQL + 应用角色 HTTP 测试：`/health/live` 在空库仍为 200；`/health/ready` 维持 Bearer 边界，并分别覆盖空库、缺最新迁移、完整当前清单、数据库账本出现未知未来迁移、已应用摘要不匹配，以及 schema 查询失败后数据库已断开的复核。数据库不可连必须是 `DATABASE_UNAVAILABLE`（`schema=unknown`）；数据库可连但兼容检查失败必须是 `SCHEMA_UNAVAILABLE`（`schema=down`）。检查不得执行 migration，应用角色直读台账仍须返回 42501，只允许读取受限兼容视图。

## 5. 阶段出口

- A：人工闭环真实 PG/API/桌面窗口可运行，启动连接、版本/完成/重开/幂等通过；浏览器页面不能单独代替交付。
- B：Fake Worker、验证、Review 完整走通；没有真实工具副作用。
- C：控制/恢复/Gateway/资源互斥与关键故障点通过，才能接真实执行。
- D：真实模型、Context、长期信息、Today、三套工作台与审计；首批 Skill、最小第一方 Pack、基础 Eval 与轻量来源视图按第 8–9 节验收；模型失败路径同样通过。
- E：四类适配器在受信边界内真实验证；禁用的承诺功能计为未完成，不静默缩小 V1。
- F：OpenAPI/实现一致、安装/升级/备份还原演练、全部 required 场景证据齐全；研究实验另行报告。

每份报告写 commit、依赖/DB 版本、运行命令、通过/失败/跳过原因与证据路径。失败或未运行仍是未完成；不要以测试数量取代对应不变量证明。

## 6. TypeScript-first 冻结前 Spike

状态：完整出口尚未通过。本节为 [ADR-006](../decisions/ADR-006-typescript-first.md) 的验证规格，不是完成成绩；2026-09-20 起补齐的独立准备实验及实际覆盖范围见 [P00 研究记录](../research/p00-source-study.md)。原有 Pi/LangGraph/Rig 实验不能证明 TypeScript + AI SDK + PostgreSQL 组合通过。

### Spike 1：审批后跨进程恢复

使用真实 PostgreSQL、AI SDK 边界和可控模型/WRITE_FILE Adapter。完整工具请求及规范化参数、逻辑动作 ID、Review 绑定保存后退出 Worker；重启 API/Worker，批准原 Review，由新 Worker 继续原步骤。

通过条件：

- Review、原模型请求/响应与待执行动作可恢复；不重跑已完成模型轮次来重新生成工具参数。
- 两个批准请求/两个 Worker 竞争时，批准最多消费一次、领取唯一；正常已知结果路径只产生一个效果。
- 参数、目标基线、权限、验收或执行权变化后拒绝旧批准；消费后但执行前崩溃能按原身份核对恢复。
- 批准消费与效果落库之间各断点转入 Spike 2 协议；不以“批准已消费”推断工具成功。

映射：B02、B08、C01–C03、C09、D01–D03。真实 PG 验证事务；模型 Fake 的范围必须单列。

### Spike 2：外部成功但结果未落库

受管临时文件写入已成功，在 AFTER_EXTERNAL_EFFECT 强制退出进程，保留独立效果日志；新 Worker 从持久化 Invocation 恢复。可在后续安全准入完成后扩展临时 Git 仓库，不为 Spike 提前开放真实项目 Git/CLI。

通过条件：

- UNKNOWN 先核对原动作 ID、资源、目标基线和效果证据，不再次执行、不更换 Adapter/动作 ID。
- 已证明成功只补记结果；能证明未发生才允许按契约恢复；证据不足转 Review/暂停等待人工，不能标记 COMPLETED。
- “目标内容相同”不足以证明本次动作造成该结果；覆盖外部编辑、部分写入、冲突和证据缺失。
- 租约过期但旧 Worker/子进程仍可能写入时保持资源隔离；旧 epoch 结果不能覆盖新执行者。

映射：B07–B08、D01–D07、D10。报告分别记录调用次数、效果次数和业务提交次数，不用队列投递语义宣称任意外部效果 exactly-once。

### Spike 3：Provider 可替换性

相同 Task、Context、工具 schema 和验收条件，分别接入 OpenAI 与另一 Provider/本地兼容模型。两个端点都真实运行才证明适配性；缺少端点或凭据记未验证，Fake 只证明协议逻辑，不在文档保存凭据。

通过条件：

- Domain/Workflow 不因 Provider 更换而修改；转换和特殊能力只在 Adapter；用相同工具语义验证，不要求生成内容完全相同。
- 流式文本、完整工具参数及输出校验正常；半截参数、断流、非法 JSON/引用、拒绝、超时、取消均进入有界 typed failure/既定恢复路径。
- 结构化输出失败不执行工具、不误报 PASS；新模型尝试独立记账，不重新执行已有未知动作。
- 两 Provider 的 schema 子集、用量缺失、调用 ID 与必要恢复元数据有明确映射；不承诺等待中的 Run 可随意换 Provider。

映射：A06、C05–C08，并补充 ModelPort 兼容测试。

### 共同冻结门槛

三个 Spike 是必要证据，仍须补真实 PG 的 B01 并发 Delegate、B03–B05 控制/完成竞争、迁移并发及历史内容校验、应用角色权限、bigint 无损映射、schema 兼容和同事务 Repository 测试。SSE 引入时验证鉴权、断流/背压和 GET 重建；中文搜索使用短词和混合文本样本。

性能报告按[技术选型](../architecture/技术选型.md)同时列 API/审批分位延迟、事件循环延迟、整体 RSS、吞吐及数据库竞争；测试前明确工作量和预算，当前预算数值待确认。API/Worker 分进程须比较总资源，不只报告其中一个进程。新包版本以锁文件记录；没有 Git commit 时记录输入文件摘要，不伪造提交号。

## 7. Windows 桌面交付验证

状态：完整出口尚未通过；2026-09-20 的最小宿主局部实测见 [P00 研究记录](../research/p00-source-study.md#最小-windows-桌面宿主实验)。依据 [ADR-007](../decisions/ADR-007-windows-desktop.md)；这组验证补充交付和宿主边界，不替代上面的三个业务 Spike 或 37 项验收。

P00 先做隔离最小桌面 Spike：随包 Vue、Node API 与 Fake Worker，从打包产物验证启动/鉴权/退出，不等待 P20 才发现运行时无法分发。真实安装、签名及最终业务回归在 P20 完成；Fake Worker 不证明业务恢复正确。框架版本、Node 打包方式、Windows/CPU 与 WebView2 版本写入证据。

| 场景 | 必须证明 |
|---|---|
| 安装与运行前提 | 干净 Windows 能安装并从入口打开独立窗口；无开发 Node/Rust 环境仍运行；WebView2/PG 缺失有明确引导 |
| 启动身份 | 端口冲突、伪造 readiness、错误实例、重复启动不会连接陌生服务；短期 token 不出现在日志/URL/持久存储 |
| IPC 与 HTTP | 未授权窗口/frame、远程导航、非法 IPC、错误 Host/Origin 与无令牌请求被拒；生产 CORS/CSP 在真实 WebView 中成立 |
| 重载与服务失败 | 窗口重载重新取得连接；服务退出/重启显示错误并轮换凭据，保留原命令回执查询，不重复执行 |
| 退出与恢复 | 有草稿、有在途写入、停机超时、壳/Worker 强杀与系统退出路径；不误记完成/取消，不因旧进程租约到期释放资源 |
  | 窗口交互 | 自定义标题栏左侧无历史禁用、应用内后退/前进、Ctrl+K 搜索复用、项目上下文新建任务及草稿离开保护；中间空白拖动/双击、右侧按钮最小化/最大化/还原/关闭及草稿关闭保护；贴边、边框缩放、窄工作区、多屏/DPI、200% 内容缩放、中文输入法和键盘焦点。浏览器辅助链接默认不可见且不可命中，Tab 显示、Enter 聚焦主内容 |
| 性能对照 | 相同 UI/工作量下比较 Tauri+Node 与 Electron；列冷启动、总进程树 RSS、PG 占用、API p95/吞吐、安装大小，不仅测空壳 |
| 升级与卸载 | 运行中升级先安全退出；schema 不兼容停止；卸载保留独立 PG/用户数据；备份可恢复 |

Windows 进程树终止、孤儿检测、支持版本、签名与杀毒软件影响均须实际记录。未测平台不宣称支持，未签名测试包不宣称正式签名发布。截图或 Vite 开发服务器成功不能替代安装产物证据。

## 8. Relay Skill 与蓝图应用验收

2026-09-20，待执行的补充规格。依据 [Skill 专题](../architecture/relay-skills.md)，在 D 阶段验证 F24；不修改既有 37 项编号，也不把新增场景称为已通过。V1.5 Page Schema 与第三方包不纳入 V1 实现测试。

| 场景 | 必须证明 | 证据方法 / 关联 |
|---|---|---|
| Onboarding 与目标歧义 | 无模型可手工创建；歧义有澄清；拒绝/失败保留最小项目；不创建虚假 Run | Assist Fake + UI；A08 |
| 输出与模板边界 | 错误 schema、未知页面/筛选、脚本/SQL/远程引用、非法阶段被拒；合法内置模板可预览 | schema/registry 单元测试 + HTTP |
| 作用域与指令注入 | 非授权资料不可读；资料/Skill 不能删 Mandatory、授予权限；Preview 不发工具动作或加载候选 URL | Context/Gateway 测试；A04、A06、D11 回归 |
| 预览与分别接受 | 预览零业务写入；显示配置应用不启用 Rules、不改活动 Run contract；后续 Rule 接受仍触发原失效协议 | UI + 真实 API；A01、A05、C01–C03 |
| 修改与过期 | 改候选/选中项后旧 hash 不可接受；State/View/Goal/资料/规则变化使旧提案拒绝；切页迟到结果不落新项目 | HTTP + PG 竞争；A02、C08 |
| 原子应用 | 在新 Task、State、View 与回执写入之间注入失败，所有效果均回滚；Next Action 引用正确创建的 Task | 真实 PG 故障注入；D05 |
| 并发与重放 | 相同/不同 command_id 竞争同提案只应用一次；人工编辑/归档与接受竞争不丢更新；响应丢失查回执不重复创建任务 | 两 DB 连接 + barrier；D06 |
| 版本与追溯 | v1 应用后发布 v2 不改旧项目/Run；同标签不同内容拒绝；旧定义缺失或禁用明确报错；来源可追溯到候选、Manifest 与效果 | 注册表/存储集成；A03、C08 |
| 验证与执行边界 | 结构通过不算 Task PASS；Worker 不能改有效 CheckPlan；Skill 升级不绕过原 UNKNOWN 核对 | Verification/恢复 Fake；C06、C07、D01–D03 |

P12/P14 实施报告必须附真实 schema/OpenAPI/迁移版本与上述证据。输出大小上限、历史定义存储及锁落点尚待冻结；文档链接/token 检查只能证明静态文档通过，不能替代本表。

### 首批闭环 Skill 的补充场景

依据[首批目录](../architecture/relay-skills.md#7-首批闭环能力与后续目录)，以下均待执行。首批四项在 D 阶段交付；修复、交接、状态提交复用 B/C 阶段核心测试再回归，不能推迟既有核心安全出口。

| 场景 | 必须证明 | 对应依据 |
|---|---|---|
| 契约与验收准备 | 提案未接受不得充当有效契约；未知 checker、缺必需能力、删 HARD 或接受过期验收均被拒；检查方案在 Delegate 前确认冻结 | A04、C01、C06–C07；P06/P12 |
| 组合确认与委托 | 提案接受成功而 Delegate 冲突时显示真实状态；命令重放不重复应用或创建 Run | B01、D06；P05/P12/P14 |
| 项目恢复 | 重开 Task、已替代 Decision、撤销验证不再算当前有效；来源不可用可见；无比较基线不编造变化；摘要不写状态或自动启动 | A03、A06、C08；P11/P12/P15 |
| 定向修复 | 固定失败项和产物/验收版本，保护用户修改；新版本不能自动继承旧 PASS；ERROR 重试 checker，耗尽预算进入原 Review | B06、C01–C02、C06–C07；P05/P06/P12 |
| 交接包与执行权 | UNKNOWN/旧进程未停止不显示已接手；模型说明失败仍可完成安全控制并提供事实包；Review 不转 Owner；接手后重新 Delegate 新建 Run | B02、B05、B08、D07；P08/P12/P14 |
| State 更新 | 模型自称 deterministic 的补丁不直写；PASS 未业务提交不显示已完成；完成事务失败无部分 delta，重放不重复；阶段/风险推断单独确认 | A01–A02、D04–D06；P03/P06/P12 |

P07 开发自检使用真实 PostgreSQL 与 API 进程，新增针对 Review 的 C02/C04/C09、A02 局部用例：同版本人工证据生成后继 PASS、旧会话保留、切换当前候选后拒绝旧决定、预算上调有界且供 VERIFY 使用、State 提案基线冲突及与类型化 State 命令争同一 revision、操作拒绝后不派发下一步；真实 API 进程重启后仍可读取并决定原 Review。P07 当时尚无 P08 安全控制与 P09 实际批准消费；当前 P08 的开发自检见下段，完整桌面验收仍需单独执行。

P08 开发自检在 `apps/api/test/integration/recovery.integration.test.ts` 使用真实 PostgreSQL、真实 API 子进程及独立 Worker 子进程：控制意图先 PENDING、冲突/显式 supersede、PAUSE/Resume 与 Task WAITING 对齐、AI CancelTask 202 与人工 cancel 200、控制在 Fake 发布派发前后到达、控制与完成两种提交顺序、旧 epoch 拒绝、未决 UNKNOWN 阻止 Handoff。故障点覆盖派发后无目标、发布成功后步骤未提交、fence 已提交而核对前再次退出，以及成功日志对应目标文件丢失/损坏；恢复必须持有旧进程已停止的可信依据，检查持久 fence/attempt 身份，并复用原 operation_id。独立 API 进程重启后仍能读取 PENDING；旧 Worker 子进程退出后，新 Worker 子进程扫描并处理原动作。HANDOFF 测试分别核对有候选版本和无候选版本的确定性事实引用。`pnpm --filter @relay-agent/api run test:integration` 在临时 PG 18.6 上为 137/137，构建/PG 启停与临时目录清理均成功；这是开发自检，不是正式验收。

P08 批次效果适配器仅为同机受管 Markdown 文件发布，不能以这些 P08 用例声称真实模型、Gateway、权限撤销或通用跨 Task 工作目录资源排他（B07/D07 的全量场景）已通过。扫描是内部显式调用，没有生产调度器；旧进程停机依据由内部调用方提供，没有生产进程管理器自动证明任意进程已经退出。目录项断电持久性、孤儿文件自动报告/清理和 Windows 桌面端到端行为仍需各自验证。

P09 的 `gateway.integration.test.ts` 在真实临时 PostgreSQL 上覆盖：Connection/Capability/Permission 分离，默认无权，AUTO 与 ASK，Review 两次并发决定、批准后新 Worker epoch 和旧 Worker 拒绝，USER_IMPORT 的真实 Job 来源与 ASK 决定；authority 撤销和 Admit 两种提交顺序，跨 Workspace 的父子资源根争用恰一方持有；直接 SQL 非法来源、跨 Project 引用、claim token、Review/Operation 错配和 Fake 配置含凭据均被约束拒绝。Fake 效果在 Admit 后崩溃、PREPARED 停机后同 ID 重试、DISPATCHING 目标缺失保持 UNKNOWN、内容篡改隔离、控制先到抢占、RUN/USER_IMPORT 换 intent 绕行阻断均有定向用例。真实 API 子进程覆盖配置命令回执/重放/版本冲突/404 隔离、资源目录移除后原命令重放和两次 Invocation 历史读取。P09 阶段定向 13/13、API 单元 57/57、完整 PG 集成 150/150；构建、PG 启停、临时目录清理及文档检查通过。此为开发自检；不代表 B07/D07 对任意外部进程、junction/别名、真实 Web/Git/CLI 或正式桌面验收已通过。

P10 开发自检在 `information.integration.test.ts` 的真实 PostgreSQL 上覆盖四类类型化事实与不可变版本、Memory 显式确认、Decision 替代历史/环和跨范围拒绝、ArtifactVersion 提升并发幂等与直接 SQL 跨范围约束；HARD Rule 冻结到 Delegate/CheckPlan、上层冲突、同层 PREFERENCE 冲突、缺失 PRE_ACTION 与 Fake SEMANTIC 路径拒绝，以及 Rule mutation/Delegate 两种 authority 锁提交顺序。受管效果已发生后 Rule 更新仍登记原结果，下一步被栅栏阻止；Gateway 已准入 Invocation 的结果也可登记，新动作拒绝。中文 1–2 字、`%` 字面查询、Workspace/Project 范围和排序游标分页使用真实查询；API 子进程覆盖命令回执重放与范围隔离。定向 P10 7/7、Gateway 回归 14/14，完整真实 PG 集成 158/158，API 单元 57/57；构建、类型检查、PG 启停、临时目录清理和文档检查通过。`rule_revision` 为 Workspace 级保守栅栏，无关 Project 更新也可使旧 Run stale。P10 当时 Knowledge/Memory/Decision 尚未成为自动 Context 输入；P11 已另以 `context_revision` 接入，不能把旧 P10 数字当作 P11 结果。URL/PDF/向量、真实语义检查器与大数据量搜索性能留后续验证。

P11 `context.integration.test.ts` 使用真实临时 PostgreSQL 和受管 Artifact 文件：覆盖中文标题字面命中与同范围最近资料补位、实际片段与全文 hash/UTF-8 范围（包括 surrogate 边界）、Fake DRAFT 消费；必需 Context 超预算不写成功 Manifest、可选来源按预算裁剪并记录原因；信息版本变化、Project 修订及装配/提交竞争不提交过期快照，DRAFT 前重建，旧 Manifest 留作历史；Memory 到期、Knowledge 归档、Decision 替代、跨 Project 请求和受管文件损坏在历史读取时重新过滤。已发布候选的 VERIFY/COMPLETE 沿冻结契约和当前 Gate 判定，资料或 Task 修订不抹掉真实效果证据；修正回路重新 BUILD_CONTEXT。定向 P11 9/9、Verification 回归 24/24、既有 Run Steps 6/6；完整真实 PG 集成 167/167、API 单元 57/57，构建、类型检查、PG 启停、临时目录清理与文档检查通过。这些是开发自检，不是正式验收。`selection_reason` 区分标题字面命中与最近资料补位；补位上限 3，总 Relevant 上限 10，均是确定性有界降级，不是语义相关性。P12 接真实 Provider 前需补显式选择并复核最小必要输入，避免将无关近期资料外发。当前未运行真实模型、Assist、Skill 注册表或真实 token 计量，不能据 Fake 路径推断这些能力已验证。

`apps/api/scripts/run-integration.ps1` 在单个临时 PostgreSQL 数据库内串行运行测试文件：并行文件共享数据库，而已有并发回归用例会临时全局切换 `tasks` 的 RLS 策略；文件并行会让无关用例短时看不到 Task。这只隔离测试文件，不改变产品运行时的并发假设；各用例内部的双命令竞争仍并发执行。

后续候选落地时另验证：AI 生成的 Decision 理由不编造来源；Next Action 不绕过资格或虚构时长；Artifact 的智能提升建议后置不影响已有显式提升幂等测试。P10 已覆盖用户显式 Decision 替代无环和 ArtifactVersion 显式提升幂等；未实施候选不作为本轮功能成绩。

## 9. 扩展组合与版本评测

2026-09-20，待执行。依据[扩展模型](../architecture/relay-skills.md#8-可组合扩展模型)。V1 为实际交付的 Skill 和第一方 Pack 提供工程回归用例，不依赖可选论文任务 P22，也不建设通用评测平台。现有 B/C 核心测试继续作为前置，不以 Pack 演示取代它们。

| 层次 | 最低验证 | 证据要求 |
|---|---|---|
| Contract Eval | 输出 schema、注册引用、版本完整性、模板/检查器兼容 | 固定样例覆盖合法、缺字段、未知引用、循环依赖、同 ID/version 不同摘要、不兼容宿主与超预算；错误不得改 current 绑定 |
| Behavior Eval | Permission、Scope、Mandatory、领域 Owner、应用及恢复边界 | 选择 Pack 不授权/激活规则；Profile 不删约束；Projection 不改 Today 资格；模型输出不触发隐式应用；真实 PG 验证必要原子性与重放 |
| Outcome Eval | 质量、错误接受/拒绝、首轮及最终完成率、修正/人工介入、耗时和用量 | 固定独立 rubric/案例版本；区分内部 Verification 结论与独立评价，保留失败、超时、缺失用量及分母 |

每次版本比较固定输入/资料快照、案例/rubric、模型/工具配置、执行预算和比较条件；记录 Skill/Pack/Profile/Recipe/检查器版本及摘要、实际 Manifest、尝试与结果。为隔离修改效果尽量保持其他变量一致；若改了评价标准，旧新结果不可直接比较，需用同一标准重新评价。随机模型按预先确定的重复次数报告分布，阈值/样本量在运行前确定，当前尚未冻结；不能运行后挑成功样例或宣称已证明“没有退化”。

候选包携带的 Eval Cases 是测试输入，不是自我认证：发布方控制必要的独立基准，Skill/Worker 不能删改；导入的用例不能执行任意脚本或绕过 Gateway。程序性安全/契约失败阻止受影响定义启用；质量退化按预先标准处理，证据不足标未验证。Fake 只证明流程/边界；真实模型回归在独立测试项目与受控资料上进行，缺合法端点时明确未执行，不用 synthetic 成绩冒充结果。

2026-09-26 第一段开发自检：`apps/api/test/unit/first-party-skills.test.ts` 覆盖定义依赖内容摘要、未知 Pack 成员、三类输出的严格字段/大小/引用/检查器边界；`apps/api/test/integration/assist.integration.test.ts` 在隔离真实 PostgreSQL 覆盖普通 Assist 回归、Skill 冻结/命令重放/首次结算、生成本身不写 Task、跨 Workspace/来源撤销、历史读时脱敏、Project Resume 新鲜 revision 与撤销/旧验收 Verification 排除。该批当时只属于首批三项 Skill 与两份只读最小 Pack；第二段 Task Owner 接受见下段，Blueprint/Pack 应用、真实模型质量和独立验收仍未覆盖。

2026-09-26 蓝图开发自检补充：`apps/api/test/integration/view-configuration.integration.test.ts` 检查独立 View CAS/重放/跨范围/页面解析；`apps/api/test/integration/project-blueprint.integration.test.ts` 在隔离真实 PostgreSQL 检查 USER_DRAFT 候选的 Goal/Task/State/View 同事务效果和映射、重复接受、跨 Workspace、未知字段/零效果、View stale 无局部提交，`goal-to-project-blueprint` Assist Skill 的冻结来源、同候选 Apply、生成基线竞争 typed FAILED、取消零候选、来源归档后 GET 隐藏与 Apply 拒绝。定向复跑结果：Blueprint 5/5、Assist 29/29、migration 8/8、CLI 5/5、Skill 单测 5/5；0024 View 1/1 在 0025 后的真实 PG 迁移链上通过。类型检查、API 构建、Graph 安装与文档检查通过，临时 PostgreSQL 均已清理。这些开发自检不构成独立模块、真实 Provider 或 Windows 桌面验收。Pack 1.3.0 只作精确来源清单，不能将选择等同配置效果。

2026-09-26 M04 Provider 开发自检补充：`model-endpoint-policy`/`openai-compatible-model-port` 单测用受控 SSE transport 覆盖 endpoint 解析、同源/路径、DNS 复核、重定向、完整 `[DONE]`、片段合并、结构化 JSON、usage 缺失、取消、超时、断流与单次预算；`model-call-budget.integration.test.ts` 在隔离真实 PostgreSQL 覆盖 Run DRAFT/SEMANTIC 共享额度、AssistSession 双 Worker 竞争、STARTED 与历史未知用量、实际用量超预留、网络调用在短事务外、额度耗尽时 Run 明确失败。Context 定向回归区分 Mock 最近来源补位与真实模型排除，并由模型端口拒绝升级前旧 Manifest 的该来源。定向结果：Provider/配置单测 10/10、预算 PG 5/5、Context PG 13/13、迁移 PG 8/8、CLI PG 5/5、Mock Run Steps PG 8/8、Assist PG 29/29；API 类型/构建、Graph 安装与文档检查通过，临时 PG 均清理。本片未连接获授权真实 Provider，也未证明 socket 与 DNS 预解析同地址、兼容端点全部 schema、前端首 token 反馈延迟或全 M04 出口。

第二段开发自检针对 0023：真实 PostgreSQL 定向回归 Task/acceptance 双版本 CAS、同命令回放与并发不同命令、仅人工持有及活动 Run/历史 UNKNOWN 阻断、跨 Workspace 与撤销来源、已确认 required criterion 和 Expected Result 原约束保留、新描述受控合并、旧验证适用性撤销与非 Run OPEN Review 过期、审计故障下业务/提案/回执整体回滚；HTTP 回归预览、缺 CAS 拒绝、接受最终结果与 replay。纯输出测试涵盖 Task Definition 1.1.0 的描述约束、Verification Plan 1.1.0 只追加检查，原版本摘要保留。CheckPlan GET 只核对当前准入预览的来源 revision/hash，不能当成冻结 Run 或执行过的 PASS。仍需独立模块与 Windows 桌面验收，且不据 Fake 模型回归宣称真实 Provider 质量。

额外组合验收：

- 第一方 Thesis/Development Pack 只引用已交付成员；清单全部可解析，缺能力清楚显示，不产生假成功。
- 旧版已应用且用户手改后，新模板预览能识别冲突；拒绝更新保留原配置；不同包的 HARD/DENY 不被加载顺序覆盖。
- 配置/规则应用按真实事务边界报告结果；规则变化影响活动 Run 时走原失效控制，不能展示无影响；响应丢失使用原回执。
- 历史定义保留及旧记录无 Pack 来源可读取；包/模板升级不改历史 Run/Manifest，不用新版顶替旧依赖。
- 来源视图取实际输入，读取时鉴权；无权对象的名称/ID/数量不可见，撤销权限后历史正文不可读，缺失证据不由新正文替代。
- 配置恢复走新 revision 和当前合法性检查，不恢复审批/PASS/执行权；重放在隔离环境进行，不重发真实已完成或 UNKNOWN 副作用。

V1.5 Importer、自动 Trigger、完整 Inspector 与 Project Checkpoint 的运行验证随对应功能另补：特别覆盖仓库指令不执行、重复触发去重和检查点恢复冲突。当前记录设计边界，不计为 V1 已实现或已验证。P12/P14/P15 提交基础证据，P21 核对实际交付版本及上述回归；论文扩展仍按[实验协议](../research/评价协议.md)独立确认。


## 10. 技术栈改造的大模块验收

日期：2026-09-23。角色：M01–M07 的验收规格；本节没有测试通过结论。执行包见 [大模块提示词](../../prompts/stack-migration.md)，目标技术取舍见 [ADR-010](../decisions/ADR-010-agent-stack-react-desktop.md)，当前状态只维护在 [CODEX_NEXT_STEP](../../CODEX_NEXT_STEP.md)。

### 10.1 模块状态与独立验收

状态为 NOT_STARTED → IN_PROGRESS → READY_FOR_ACCEPTANCE → ACCEPTED；问题进入 CHANGES_REQUESTED，缺必需外部条件记 BLOCKED。修复后重新提交验收，不保留已失效的通过结论。这是项目文档状态，与 Codex goal 工具状态无关。

具体代码、测试和修复由执行者完成。协调 Agent 在执行者自检之后独立核对当前输入文件基准、运行结果和关键反例，复跑必要检查，不能复制执行者总结充当验收。每个模块通过后才推进依赖它的模块；普通出口通过自动继续，不另设例行用户审批。必须关闭所有影响模块要求的缺陷；范围外问题明确登记，不能用低优先级标签掩盖必需能力缺失。

每次验收记录模块/范围、文件摘要或 commit、确切命令/退出码、运行环境与依赖版本、证据位置、失败及修复、未运行项和结论。当前仓库无初始 commit 时使用清单与 SHA-256 绑定文件。证据写入对应测试记录，本页不复制测试成绩。数据库测试使用隔离实例/数据，保留清理结果；历史成绩不自动覆盖本次代码。

### 10.2 M03 必需可靠性场景

| 编号 | 触发与反例 | 必须观察的结果 |
|---|---|---|
| G01 | Mock 创建 Task/Run 后关闭页面/API 重启，再查询与订阅；同 Key 同/异载荷 | 已受理任务不丢失；同载荷回执一致、异载荷冲突；可靠事件连续重放且客户端去重 |
| G02 | 审批暂停、重复批准、参数/目标/hash/权限版本变化 | 等待无 Worker/模型槽占用；新 resume command；副作用不重复，过期批准拒绝且不能绕过恢复 |
| G03 | 工具效果完成后、检查点/业务结果提交前强杀 Worker | 使用原 operation_id 核对；不能幂等且结果不明时保持 UNKNOWN 和资源隔离，不自动换 ID 重发 |
| G04 | API/分发器/Worker 重启、领取后通知丢失、重复分发 | PG 的 command/outbox 找回未完成指令；数据库幂等裁决，不依赖进程 Map 或通知唯一历史 |
| G05 | 同 thread 双 Worker、租约过期/续租失败、旧 Worker 迟到 | 最多一个有效 invocation；fencing 拒绝旧写，新效果停止；旧进程停机未知时资源不能假释放 |
| G06 | 用户取消、取消与完成竞争、在途模型/子进程 | 意图持久化并传到真实执行端，停止后续步骤、收敛状态可测；已发生效果保留，取消终态不可复活 |
| G07 | 无 Bearer、错误 Host/Origin、跨 workspace/project ID | Run/SSE/审批/产物/文件均不可越权；无客户端 actor 冒充，无密钥 URL、日志或持久前端存储 |
| G08 | SSE 补历史/实时竞态、跨提交事件顺序、大输出、失败与预算耗尽 | 每 Run seq 与提交顺序一致；漏通知仍补查；只有持久数据拥有可靠 ID；快照/最终消息可校正尾部增量 |

0013 Review/RESUME 顺序片的定向反例还须拆开两种旧 START 竞跑：审批在 VERIFY 等待安全点与旧投递结清之间提交，以及旧 Worker 在写出 Review 后、结清前退出并由监督器重排原 START。两者都必须观察旧 START 不执行审批后的 COMPLETE；新 RESUME 仅在前驱 DONE 和 invocation IDLE 后领取。另验证 ordinal 前驱阻塞、Review/业务状态/RESUME/outbox/回执故障回滚、同 `command_id` 重放唯一决定、过期或拒绝不入队、ACTION_APPROVAL 在正式图/Gateway 节点接入前被固定 Worker 排除。该片通过也只覆盖 G02/G04/G05 的这些运输边界；图检查点、在途取消、真实工具与完整 G01–G08 仍需后续独立反例。

0013 独立审查补充：已批准的 ACTION_APPROVAL 在 PAUSE 后被拒绝，原 deferred RESUME 必须与 operation/Run/control 同事务撤回，Review/operation 身份留存；故障注入 outbox 更新时全部业务变化回滚，后续手工 RESUME 不受旧 ordinal 阻塞。旧 START 遇批准后紧接 PAUSE/CANCEL/HANDOFF，待处理控制必须先于 `COMMAND_SUPERSEDED` 获得安全点。批准到期、Connection 停用、Permission 版本变化在 Gateway claim 前拒绝；claim 后至 Admit 前撤权，若未创建 Invocation/效果则释放同 epoch Worker claim，控制可撤回原投递；DISPATCHING/UNKNOWN 保持隔离，不把 lease 或拒绝错误当旧动作停止证据。以上均需真实隔离 PG 反例，拒收前日志与新修复日志分别冻结。

LangGraph/PostgresSaver 分片须从独立 migrator 安装后才允许 Worker 领取：缺 schema、损坏 Saver 列或错误版本应在 claim 前失败；runtime 不获 DDL/台账写权，两个安装进程串行。固定图的每个 `advance` 节点只调用一次业务步骤；仅 OPEN 验证 Review 可保存 interrupt，原决定 RESUME 才唤醒，终态恰在预算边界不能误标 BLOCKED。真实 PG/独立 Worker 故障点分别覆盖 WAITING_APPROVAL 业务提交后且 interrupt 前退出、interrupt 已持久但旧 START 未结清、RESUME claim 后且恢复 checkpoint 前退出，以及受管效果业务提交后且图 checkpoint 前退出；恢复保留原 command/Review/attempt/operation 身份并核对 Artifact 版本唯一。PAUSE→恢复等待→批准的旧 START 仍须先结清，不能让后继 RESUME 越序或由旧 START 执行获批步骤。旧 epoch 在业务节点提交后、写正常 checkpoint 前失效时不能继续写正常后继 checkpoint。该片证据不替代 G06 在途取消、ACTION_APPROVAL 工具节点、任意外部效果或 Windows 组合验收。

后续固定 Mock Gateway 图动作片须用真实 PG 与独立 Worker 分别证明：可选 Delegate 工具意图只在 DRAFT 后/PERSIST 前进 Gateway；ASK 的旧 START 在批准前和快速批准竞跑时只结清，只有原 Review/operation 绑定的 RESUME 派 `WRITE_MARKER`；DENY、到期或准入前 Connection/Permission 撤销不派效果且 Run/Task 明确收敛。旧 P07 预留 operation ID 的 APPROVE/DENY 和 P09 直接 Gateway 仍保留原决定/直接动作，但无冻结 Mock 意图就不能产生固定图无法消费的 RESUME；同 Run 另一 operation ID 即使配上重算的 Review 目标/hash，也不能冒充冻结动作。批准后效果前、Fake 写入后而数据库结算前、Admit 后目标缺失、业务效果提交后而图 checkpoint 前各窗口按原 operation/Invocation 身份核对，UNKNOWN 不换 ID 重发；旧 ACTION RESUME 不得唤醒后继 CRITERION Review。内层 Gateway claim 的租约与外层 invocation 分别验证：用真实 PG 的短租约在 Admit 后阻止 adapter，在 Fake 写入后失租则原 Invocation UNKNOWN、资源 claim QUARANTINED；两者都不能因外层 heartbeat 仍活跃而误记 SUCCEEDED。PAUSE/CANCEL/HANDOFF 与权限拒绝竞争以已持久控制优先；外层 invocation ACTIVE 时控制保持 PENDING，结清后自动应用，结清与应用间退出由重启 supervisor 的 PG 扫描补偿；双 Worker 只能有一个有效外层/内层 Invocation。冻结 Mock APPROVE 后控制撤销的 outbox 故障注入必须使 operation/Run/control 同事务回滚，不能用无图命令的直接 Gateway 用例代替。重复 `command_id`、并发不同决定、目标/参数/hash/策略版本、批准到期、受管目标损坏和 Workspace 隔离仍应结合既有 P09/0013 与本片反例核对，不能凭直接 Gateway 单测宣称图组合通过。后续 G03 查询片已将 Gateway UNKNOWN 原 ID 投影到 `readRunById.unresolved_operation_ids`，仍须核对刷新后的用户可见性；G06 在途模型取消与完成竞争不由本片覆盖。

固定 Mock 图还须区分 Task 状态修订与 Context 输入变化：ACTION 审批/RESUME 只改状态时，已成功 BUILD_CONTEXT/DRAFT 的 Attempt ID、key 与 Manifest 保持不变；标题、验收版本、Project 或长期来源在 ASK 等待期间变化时，Gateway Admit 在 Fake 写入前拒绝旧操作并保留原 `operation_id`；效果成功后、候选发布前来源变化不得重做草稿。直接 P09 Gateway 不以 M03 固定图 Manifest 作为准入前提。

G01–G08 必须使用真实 PostgreSQL、实际独立 API/Worker 和可控 Mock Model/工具。所选方案为 PG 分发，因此本阶段不虚构 Redis 断线测试；未来若引入 Redis/BullMQ，必须另加 Redis 停机/丢消息后由 PG 重分发的实测出口。测试还须覆盖既有 A01–D11 中受改造影响的不变量。新增场景不得代替旧业务回归。

M03 Task 产物历史增量另以真实隔离 PG 核对：空 Task 为确切空列表，跨 Workspace Task 404，同 Workspace 跨 Task 不串数据；同 Task 多个 Artifact 各自 v1、同 Artifact 不可变版本与 revision、当前完成指针接受旧版而最新为新版、重开后仅当前接受集合清空。无 Bearer 拒绝读取。浏览器刷新后重新建立内存连接，从服务端恢复既有版本并向原 Artifact 追加版本；项目“当前选用”与 Task“本轮接受”分别标注，刷新不自动勾选最新版作为待接受版本。查询失败时保留草稿并阻止 create/complete。该增量的开发自检见 [任务产物证据](../../apps/workbench/results/m03-task-artifacts-evidence.txt)，不替代真实 Windows 发行包或完整 G01–G08 验收。

### 10.3 前端、真实模型与最终交付

M02 按旧→新路由/组件/真实交互覆盖表验收全部 React 迁移。组件和 Chromium 结果只证明各自层次；Windows 真窗口需运行真实 API 人工闭环、中文 IME、键盘、长文本、DPI/缩放、鉴权引导、单实例和进程生命周期。M07 才将安装、升级/卸载、干净环境、强杀恢复与数据保留纳入最终放行；能打开开发窗口不等于安装通过。

M04 在 M03 独立验收后才启用真实 Provider；记录模型/配置、实际来源选择、工具/结构化输出能力、用量与未知用量、错误和取消。至少一个实际获授权 Provider 的真实闭环是模块必要出口；历史两 Provider 对照要求保持单列，不用一次成功宣称全部协议兼容。缺凭据为未验证，不能以 Mock 顶替。

M04 FILE_READ/WEB_FETCH 模型输入切片的定向自测还需分别核对：AUTO 在 DRAFT 前取得原 `SUCCEEDED` Invocation，模型调用记录的 `input_sha256` 与原 operation/invocation 身份可重建；ASK 等待时零 DRAFT Attempt/模型调用，原 Review 的 RESUME 仅执行一次；读取后、图 checkpoint 前崩溃沿原动作核对并复用成功证据；默认 DENY/撤权/Context 失效、控制意图或 UNKNOWN 均不把正文交模型。文件超限与网页非 2xx 等类型化 `FAILED` 应保留原 Invocation/operation 失败证据、停止 DRAFT 模型调用，并将 Run 及 Task 安全收敛。长 UTF-8 文本既要按完整字符限 16 KiB，也须计入 Manifest 总预算和输出预留，超预算时缩小读片段或停止 DRAFT，不能绕开预算。升级前已成功 DRAFT 且原读 Review 待续的 Run 应保持原 DRAFT/operation 绑定、不重做模型。Mock/隔离 PostgreSQL 定向通过仍不替代真实 Provider、Windows 会话或 M04 独立验收。

M05/P15 后端定向回归覆盖：0021 对 Workspace 初始化、Goal 创建及清空 Focus 的历史审计归属回填，孤立行使迁移整体回滚；Activity 按 Workspace/Project/Task/Run 和时间过滤、`(created_at,id)` 游标续页、跨域 ID 隐藏、命令重放不新增审计、业务回滚不留事件、自由字段/凭据不出 DTO；Trace 只展示原 Step/Attempt/模型调用/Manifest/验证/Review/Gateway/效果证据，当前来源权限变化后失效，不泄露原正文或越权引用，批准和效果状态保持分离；Lineage 的自环、跨域、版本环及错误 typed 关系由数据库拒绝，重复写只留一条，源缺失时保留不可用状态而不替换历史父版本。对应真实隔离 PostgreSQL 自动化仅证明开发切片，M05 独立与 Windows 工作台验收另行执行。

完成凭据详情增量在既有人工完成与自动验证测试中补充定向反例：真实 API 对 HUMAN 完成返回原验收版本、人工判断和原接受产物，不把同 Artifact 新版替代旧版；重开后凭据仍可读但 `is_current=false`；跨 Workspace ID 为 404、错误 Bearer 为 401；受管内容删除后原版本项标 `UNAVAILABLE` 且隐藏 ID/hash。自动 PASS 的真实 PostgreSQL 完成闭环从同一 CompletionRecord 读取原 Run/VerificationSession、verdict、适用性和原产物。读取不写业务事实；异常引用只可显式不可用，不推断当前完成。此增量仍需 M05 独立及 Windows 工作台验收。

M05/P14 Workspace 列表后端定向回归覆盖：Project `active/archived/all` 默认与显式过滤、State 阶段/Next Action 确切投影、全 Workspace Task 对 Project/Inbox/终态的覆盖、跨项目 blocker 不串值、跨 Workspace 不泄漏、缺省 Task 过滤仍拒绝、混用过滤拒绝、limit 上界与游标绑定。对相邻 PostgreSQL 微秒时间的项目和任务逐页检查无重复/漏项；换 Workspace 或状态复用游标返回 `INVALID_CURSOR`。`api-lists.integration.test.ts` 走隔离 PostgreSQL 和真实 HTTP；开发自检不替代 M05 独立或 Windows 工作台验收。归档写命令及归档后写权限协议另片设计。

M05/P14 归档写保护 A 段以 `project-archive-gate.integration.test.ts` 在真实隔离 PostgreSQL/HTTP 验证：手工设置归档字段的夹具下，各类关联写命令返回 `PROJECT_ARCHIVED`、跨 Workspace 继续隐藏，Workspace Rule 和历史读取不受单个 Project 影响；Project `FOR UPDATE` 先到时并发 Task 写等待后拒绝，业务写 `FOR KEY SHARE` 先到时归档行锁等待其提交；Artifact 请求在受管文件发布之前被拒，未登记版本，也不留下文件。B 段 `project-archive.integration.test.ts` 以真实归档 HTTP/PG 反例覆盖作用域/CAS/回执与审计单次、历史可读/新写拒绝、HUMAN 与 AI Run、未决 Gateway/UNKNOWN/资源 claim、Import/Assist/STARTED 模型调用/OPEN Review，以及写者先持栅栏、归档先持排他锁两种次序。模型预约补测 Project 栅栏与 STARTED 插入相对归档的两种顺序，并让旧终态 Run/Step 路径确认不能在归档后外呼 Provider。两段定向通过仍只是开发自检；独立与 Windows 桌面验收后置，涉及旧包升级、故障后核对的真实会话仍须另验。

M04 Assist `DISCUSS` 临时草稿的开发自检使用 `assist-live-preview.integration.test.ts` 的隔离 PostgreSQL 和独立 API 进程：首片段在完整消息结算前可读，累计 revision 支持重读；Workspace/Session/Message 与 Bearer 作用域不能串读；取消、Provider 失败、来源撤销、租约过期隐藏并清理暂存；结构化提案不暴露未校验 JSON，完成仍回到原消息投影。`assist-live-preview.test.ts` 核对 16 KiB UTF-8 完整字符截取、拆开的 surrogate 与更新节流；模型端口单测证实普通 DISCUSS 在 SSE 完成前回调片段、结构化 Assist 不回调。首次 PG 用例因夹具把 Project 会话误用 TASK 专属 `PROPOSE_CANDIDATE` 而 4/5，修正为合法 `PROPOSE_TASK` 后定向复跑 5/5；新增失败/取消竞态反例后最终定向 6/6、既有 Assist 回归 29/29、草稿与端口单测 6/6，类型检查与构建通过。上述只证明受控 Fake/transport 的开发路径，真实 Provider 网络、前端轮询首字延迟、Windows 桌面及独立验收仍待运行。

M04 Run DRAFT 临时草稿的开发自检使用 `run-draft-preview.integration.test.ts` 的隔离真实 PostgreSQL、受控 Fake 生成与独立 API 进程：DRAFT 完整候选提交前可读首批 Markdown，重读保持 Attempt/claim/model call/revision 身份；尚未生成 Artifact；跨 Workspace 和错误 Bearer 拒绝；成功结算删除草稿。fence 旧 Worker 后迟到写入被拒，新领取只能以新 claim/model call 发布。待处理控制、Task Context 变化或已选 Knowledge 退役时，读取立即遮蔽前缀且不回显来源 ID。实际 AUTO FILE_READ/WEB_FETCH 图链在 DRAFT 模型 STARTED 时分别证明原读证据仍可授权预览，FILE_READ Policy 随后撤销时 GET 即时隐藏；读动作先将 Run 置 RUNNING 的情况现在由原 Run CAS 把 current_step_id 推进 DRAFT。共用 `AssistLivePreviewPublisher` 的单元测试覆盖 16 KiB UTF-8 安全截取及节流；端口受控 SSE 单测覆盖完整输出前 DRAFT 片段回调。定向结果为预览 PG/HTTP 5/5、实际读链补测 2/2、撤权 1/1、Run Steps 8/8、完整 Run Graph 53/53、相关单测 7/7；项目 Node24 类型检查/构建、29 个迁移、Graph 安装、PG 启停与临时目录清理、文档检查通过。首轮新增来源测试 3/4 是把只读遮蔽误断言为业务 STALE_RESULT 的测试错误，修正后 4/4；首轮 Graph 47/53 的 6 个读链失败已由上述 Run 位置修复并复跑 53/53。真实 Provider 网络首字延迟、桌面流畅度、独立验收仍待运行；Run SSE 仍仅是事实提示，文字预览走单独 GET。

性能分别报告 Mock 自身开销与真实模型端到端指标。固定任务、输入/输出规模、工具行为、并发、权限、检查点和持久化语义，报告接受/排队/首输出/完成 P50/P95/P99、成功吞吐、重试、取消收敛、事件循环、CPU/RSS、数据库/分发等待及每成功任务的调用/token 成本；样本不足和未知值明确说明。不得靠降低成功率、关闭 checkpoint 或取消准入来制造改善。

M07 按 V1 范围 F01–F22/F24、A01–D11 和 G01–G08 汇总，所有必需能力及真实桌面安装出口通过才能完成总目标。P22 研究和 V1.5 保持可选，不扩大默认 goal。未来执行中的凭据/环境阻塞可允许独立工作继续，但不能将受阻模块标记 ACCEPTED。

## 11. AI 并行开发体验验证提案

2026-09-26，Proposed，尚未执行。用于评价[产品目标](../../Personal_Workflow_OS_Master_Spec.md#04-ai-并行开发中的注意力与验收依据)与[候选交互](../frontend/workbench-design.md#11-ai-并行开发的注意力与验收体验)，不追加当前 M01–M07 必需出口，也不以本节替代既有业务、恢复及 Windows 验收。具体实验协议与通过阈值须在实现排期前讨论。

### 11.1 场景与反例

候选主场景：两个项目、多个并行任务，开发者中途离开后返回，处理决定、复验和验收；首轮复用一个真实执行入口。至少准备以下可判定情况，预先固定要求与预期结果：

| 情况 | 需要观察的结果 |
|---|---|
| 正常推进、重复事件、用户暂缓查看 | 无需逐个翻阅执行日志；同一事项不重复打断，必需待办与阻塞仍可找到 |
| 缺少关键决定、冲突或预算耗尽 | 能理解等待原因及下一步；不把静音、Focus 或延后当作执行授权 |
| 无上次查看基线、摘要生成后事实又变化 | 区分当前快照与变化；过期摘要不能提交旧决定，引用可核对 |
| 现有测试通过但遗漏已声明的重要行为 | 明示覆盖缺口；不因通过数或代码覆盖率较高宣称完整验收 |
| 测试被删改、跳过或检查器出错 | 受保护基准和缺口可见，原必需条件不能被自评或笼统接受绕过 |
| 两个任务各自通过，组合版本出现接口或数据冲突 | 独立成绩不成为组合版本证据；按组合对象复验并保留失败原因 |
| 外部执行失联、回执缺失或迟到、重复 | 不从聊天或超时推断完成；按原身份核对，不重复应用成果 |

### 11.2 指标与证据限制

| 评价问题 | 候选测量方式 |
|---|---|
| 回来后能否更快接手？ | 从打开项目到正确说明当前状态、关键缺口并完成首个有效操作的时间；同时记录判断错误，不能只计点击速度 |
| 注意力是否更集中？ | 任务期间实际打断及上下文切换次数，同时记录遗漏的关键待办与处理延迟；提醒少不能单独算改善 |
| 验收是否更容易且可靠？ | 接受/退回成果所需时间、已知缺陷发现率、误报与漏报；已知缺陷可由固定缺陷集或人工注入构成，不能推广为全部真实缺陷覆盖率 |
| 人工积压是否减少？ | 待决定/待验收事项数量、等待时长及完成量；结合总交付时长与质量判断，不能仅靠停止所有执行改善积压 |

对照候选为现有逐任务查看聊天/日志/测试结果的方式；待选定后固定任务难度、代码与需求基线、执行入口、模型/工具配置和缺陷集合。记录参与者对项目的熟悉程度、任务顺序与学习效应，避免仅因重复做同一任务得到更短时间。先做小规模可用性观察，保留原始证据、失败案例和样本限制，再决定是否形成正式研究协议；不预填改善比例或实验成绩。

文档检查、fixture 演示和人工注入反例仅证明各自范围。真实工作流中的注意力负担、恢复理解与验收质量需要实际使用证据，不能由页面存在、Agent 数、生成代码量或测试数量代替。

执行接续：[公共产品映射](../../prompts/README.md#产品补充的执行映射)分配本节候选到相关模块与页面，[P21/P22 提示词](../../prompts/F-release-research.md)区分本次工程交付结论和可选研究。仅实施已选定范围的相应检查，未选定项保留状态与原因；正式研究候选衔接[研究协议](../research/评价协议.md#与并行开发体验评价的边界)，不自动同时启动原四组策略实验与新体验实验。

## 12. 共享知识库的阅读与来源验证

实施接续：下述表格保留最初验收规格，并不表示每项均已运行。本轮按 [27 日执行包](../../prompts/product-supplement-2026-09-27.md)补齐定向检查；实际结果须关联开发记录，真实 Windows 阅读与项目理解效果仍须单独验证。25、26 日补充的已运行场景和范围分别见 [恢复与成果记录](../development/product-supplement-2026-09-25.md)、[人工待处理与验收记录](../development/product-supplement-2026-09-26.md)，不将工程测试折算为本计划第 10–12 节的体验实验成绩。

2026-09-27，规格补充，尚未运行。对应[工作台第 12 节](../frontend/workbench-design.md#12-人和-ai-共用的知识库体验)和 F10/F15 的已有阅读/版本义务；候选导读与沉淀按本次实际选定范围验证，不以本文新增场景改变现有模块验收状态。

| 场景 | 应有证据 |
|---|---|
| 用户不发起 AI 对话，从项目/搜索打开长 Markdown 或纯文本 | 可读完整受管正文而非仅摘录；目录适用时可定位，缺段明确提示；键盘、长中文和桌面缩放下可读 |
| Provider 关闭或外网断开，本机 API 与保存内容可用 | 浏览、搜索、读取已保存版本不依赖模型或外部原件；请求记录没有因阅读而新增模型调用/正文外发 |
| 当前 v2、历史引用 v1；切换版本或并发更新 | 展示所选确切正文及来源；迟到响应不串版本，旧引用不偷换，新内容不会继承旧验证 |
| 原件变化、来源不可访问、正文缺失或读取失败 | 可读快照与当前原件区别清楚；未知、不支持、错误分别可辨，无最新正文兜底冒充历史 |
| 人与 AI 使用同一份资料 | 人可核对 AI 实际采用的确切版本/片段和来源；按既有预算裁剪可解释，不另有无来源正文；失权与跨项目访问仍受限制 |
| 笔记修订、原件引用或 Artifact 提升 | 修订产生新版本且冲突保稿；提升绑定原版本，原件/产物未被暗中修改；重复命令不重复收录 |
| 外部导入、AI 整理建议和人工确认 | 导入不显示为已验证；保存前的建议与已收录分开；确认含义及证据可查，缺能力时不制造确认状态 |
| 选定项目导读体验后，由未参与编码的人接手 | 能从已有引用找到项目目标、关键决定及其原因、重要验收要求，并指出资料缺口；无资料时不生成虚假的完整说明 |

核对类型/作用域、来源、不可变版本和命令时复用现有自动化测试，涉及持久化/回执使用真实数据库；阅读交互需真实 API 与 Windows 窗口证据。项目理解效果另记录任务、参与者熟悉程度、答案依据及错误，不能仅因“找到页面”或模型回答正确就判定人已理解。无本轮运行记录时保持未验证，不预填测试成绩或改善比例。

## 13. 锁定影响检查与提醒的已确认规则验收

2026-09-28，产品规则已确认。以下仍是**完整验收规格**；协调侧独立验收原发现的无效候选、空态与确切原文失败证据保留在[本轮验收记录](../development/collaboration-controls-2026-09-28.md#协调侧独立验收2026-09-28)。退回项已完成开发修复自检：锁定单测 6/6、隔离真实 PG 专项 6/6 与原 Artifact 保存回归 18/18、指定 Workbench 六文件 43/43。隔离 Windows EXE 已[实测原生通知、点击和回窗](evidence/collaboration-controls-windows-notifications.txt)；故障路径使用定向注入。这些都不是协调侧独立复验，**独立验收仍待复跑**，也不能把定向通过数当作本表全部通过。依据为[工作台 10.1](../frontend/workbench-design.md#101-已确认的锁定与影响检查规则)与[11.5](../frontend/workbench-design.md#115-已确认的人工介入提醒规则)。

| 场景 | 必须核对的行为 |
|---|---|
| 章节/段落锁定后 AI 修改相邻内容 | 锁定原文未变；AI 可以提示问题或提出候选，但未由用户解锁时不能应用到受保护区域。区域删除、移动、拆分/合并须有服务端反例，防止绕过保护。 |
| 用户直接修改锁定段落 | 保存为新版本后仍保持锁定，保护新原文；并发 AI 候选不得按旧基线覆盖人工修改。 |
| 锁定结论与新数据冲突 | 原文不变、冲突可见；仅依赖冲突的工作暂停，独立工作可继续；未解决事项不被整体完成声明隐藏。 |
| 连续修改后才点击检查影响 | 未点击时不自动启动影响分析；检查显示来源版本、明确引用、推测和未分析范围，不把未检查状态说成无影响。 |
| 明确引用与 AI 语义推测并存 | 分组展示依据，引用存在不自动等于必须修改；推测项未确认不能进入处理范围；用户选范围前不生成修改候选，不自动应用。 |
| Provider 不可用或无外发授权 | 不绕过现有门槛进行 AI 推测；不能将未完成的推测展示成完整清单或无影响。 |
| 必须介入、普通进度和成功完成同时出现 | 仅必须介入事项主动通知；成功后需要人工验收时保留独立待验收事项。 |
| Relay 前台、非前台、退出与系统拒绝通知 | 运行时应用内保留事项，窗口非前台才额外发系统通知；退出后的投递不属本次承诺；系统通知未显示不能抹掉待处理事实。 |
| 同一事项重复事件、刷新、重查或重启 | 按冻结的事项/变化身份去重，不因为重复信号再次催促；跨重启的实现方式在工程契约中给出。新的必须介入变化可产生一次新提醒。 |
| 短时多个事项与单个事项 | 在选定聚合窗口内合并通知、数量可核对；合并入口到待处理列表，单项到原事项，原因与业务身份不被合并丢失。 |
| 通知生成后事项已解决或版本改变 | 打开时核对当前事实，不复活旧事项、不据过期通知批准；应用内仍保留其他未解决项。 |

定向测试已覆盖部分身份、版本、锁定继承、无效候选拒绝、持久去重和默认 3 秒聚合边界；包含本次修复的确切隔离 Windows 宿主已验证焦点、原生系统通知、点击、重启与受控拒绝/失败路径，详见上方证据。3 秒是实现默认值，并非用户指定。安装包、协调侧复验及通知效果与真实注意力改善仍需各自证据。

## 14. V1 后续长期协作验收提案

2026-09-28，Proposed，以下均未执行。只适用于未来明确授权的[后续 N 工作包](../requirements/post-v1-roadmap.md)，不增加当前 M01–M07 必需出口，不替代第 11–13 节或既有 A–D/G 验证。PV 为后续规格引用，不是成绩或发布状态。

| 编号 / 工作包 | 正向路径 | 必须包含的反例 | 证据层次 |
|---|---|---|---|
| PV00 / N00 | 同一固定任务集测量受理、领取、首内容、持久化、总时间及人工返工 | 错误、超时、取消与未知用量保留分母；样本太少不报告可靠分位数；Mock 与真模型分开 | 可复跑脚本、配置/样本基准和真实使用记录；瓶颈修复再定向回归 |
| PV01 / N01 | 保存接续点，隔日返回比较并查到变化来源 | 捕获同时人工修改/Run 完成；读快照不能混合不同时间事实；删除/失权/跨项目、摘要迟到；开页面不改基线 | 真实 PG 快照/回执/权限测试；真实 API 与 Windows 接续路径 |
| PV02 / N02 | 一个来源变化生成多项候选，选择后产生新版本并验组合 | 锁定/人工编辑冲突、来源过期、缺失依赖、环/截断、应用部分成功、响应丢失与重复提交；单项 PASS 不冒充组合 PASS | 真实 PG 与故障点；确切源/目标/组合版本和 Windows 差异审阅 |
| PV03 / N03 | 人工组织导读，接受有来源的知识候选，再显式用于任务 | 重复收录、并发编辑、失权/缺正文、旧候选、相似条目误合并；保存知识不调用模型；未批准不改 Rule/Decision | 真实 PG/HTTP 与 Windows 人工阅读；模型实测仅用获授权资料 |
| PV04 / N04 | 手动生成周期计划，解释变化并逐项接受 | 任务/目标 revision 变化、依赖环、容量不足、重复提交、活动 Run 契约受影响；接受后零自动 Delegate | 真实 PG 幂等/冲突及 UI 请求观察；Windows 查看依赖与缺口 |
| PV05 / N05 | 用户启用一种时间触发，运行期生成一次候选并通知 | 双领取、禁用竞争、提交后崩溃、模型回执不明、时钟前后跳/夏令时、关闭重启漏触发、通知失败/旧点击 | 可控时钟单测、真实 PG/进程故障和 Windows 生命周期；不以真实等待时间代替确定性时钟测试 |
| PV06 / N06 | 一个明确授权的短任务链逐项经原验证/完成后推进，人工 Review 可暂停链 | 撤销/Delegate/完成竞争、预算双预留、未知用量、过期配置、未决 UNKNOWN、回执丢失、旧 Worker 与重启；无授权新任务零准入 | 真实 PG/进程故障先行，再用确切模型/工具/Windows 包验证；记录原 command/operation 身份 |
| PV07 / N07 | 编辑一个受限配置，Eval 后启用新版本，旧 Run 保持原绑定 | 恶意代码/SQL/schema、扩大权限、依赖缺失、过期预览、并发启用、Eval 失败、回退误复活批准 | schema/规则单测、真实 PG 版本/回执与实际配置 Eval、Windows 编辑使用 |
| PV08 / 所选批次 | 未参与实现的人完成接续、共创、知识复用或有限委托路径 | 分不清事实/推测、找不到依据、错误接受、过量提醒、停止状态误判；将失败和人工兜底纳入报告 | 确切 Windows 包与真实业务/模型条件；单列用户体验记录，不由工程测试推导收益 |

### 14.1 使用效果的可复核口径

- 接续理解：从打开项目到能正确指出当前目标、上次以来的关键变化、未决事项和下一步的时间；答案须由事实源核对，同时记录错误数，不能以点击速度代替理解。
- 共创：预埋或人工标注关键影响，记录漏检、误报、错误接受和人工修订量；标注不直接采用执行模型的自评。检查范围不完整时报告分母限制。
- 知识复用：能否找到确切依据、成功引用所需步骤与耗时、重复收录及错用旧版本次数；搜索命中不等于知识正确。
- 有限委托：记录完成/失败/人工接管率、每个成功任务的主动操作次数、错误接受、预算越界与停止收敛；更少审批不自动等于更好体验。
- 性能：记录固定规模与配置下的各段延迟、取消收敛、冷启动、全进程内存和空闲 CPU。新旧方案保持模型/来源/权限/持久化语义可比。

N00 先确定任务集与基线，再在对比运行前冻结阈值、样本数量和判定方法；不在看到结果后改成功标准。任何新增范围中的越权写、锁定绕过、重复副作用或已知不满足契约的完成均阻止相应包放行，不以平均体验提升抵消。产品试用属于工程/体验证据，P22 的研究样本、对照与统计仍需单独确认，不宣称已证明普遍收益。

### 14.2 每包放行材料

记录确切代码/构建、迁移、配置、模型/权限和输入版本；列出规格→实现→测试/人工证据→未覆盖项。运行时证据与文档检查分开；没有真实模型或 Windows 条件时可以交自检，但相应最终出口保持未验证。关闭应用后常驻执行、外部执行器、PDF/OCR 或新索引不因主线通过自动放行，须补各自所选场景。

## 15. 交互状态与反馈验收

2026-09-29 新增设计验收场景；本次仅维护规范与状态图，下表均未在本轮运行。规则来源为[工作台第13节](../frontend/workbench-design.md#13-交互反馈与业务状态绑定)及[控件状态](../frontend/design-system.md#61-交互状态的统一表达2026-09-29)。不替代原业务不变量、数据库和 Windows 出口。

| 编号 | 场景与期望 | 所需证据层 |
|---|---|---|
| UXI-01 | 同一控件分别用指针、Tab、Enter/Space 激活；hover 不等于选中，focus 独立可见，按下不显示成功，不重复提交 | 组件事件计数＋键盘实测 |
| UXI-02 | 禁用仍有可读原因；菜单和任务行互不误触；浮层关闭正确回焦，Esc 不丢草稿 | 组件＋实际页面 |
| UXI-03 | 保存失败保留输入，冲突不覆盖；回执丢失后按原命令核对，不生成重复版本 | 真实 API/数据库＋UI |
| UXI-04 | 查看旧版本不改变当前选用；接受时依据变化或权限撤销阻止提交，不继承 PASS | 业务集成＋UI |
| UXI-05 | 接受请求受理但提交未确认时不显示完成；成功回执绑定确切完成记录；未知回执可恢复 | 故障注入＋数据库＋UI |
| UXI-06 | 暂停/取消/接手请求等待中保持真实执行者；暂停后不可冒充人工；接手确认后才允许编辑 | Fake 在途动作＋真实持久化＋UI |
| UXI-07 | 外部 UNKNOWN 仅有契约允许的核对/处置入口；刷新、重启不换动作身份，结清不伪装成功 | 恢复集成＋桌面 |
| UXI-08 | 切 Task/Project/Workspace 时注入旧响应；无错对象数据/通知/重放，失权清理受限内容 | UI＋真实鉴权 |
| UXI-09 | 标题栏按钮不触发拖动，无历史时前进/后退不可用；窗口控制与业务加载独立，搜索仅展示支持范围 | Windows 原生窗口实测 |
| UXI-10 | 减少动态效果、键盘阅读、缩放与错误长文下仍能辨识状态与操作；关键状态播报不逐 token 重复 | 页面＋辅助技术人工检查 |
| UXI-11 | 阅读知识不选入 Context；显式选择绑定确切来源版本；锁定/影响检查和介入提醒不因普通控件激活绕过既定条件 | 对应业务集成＋UI |

每份证据标出代码/构建、测试数据、输入版本、触发步骤、预期与实际结果，以及未覆盖项。静态 PNG 只能证明所示状态的视觉方向；组件 Mock 不能证明持久化、执行权交接或 Windows 行为。

## 16. Agent 协作主线验收提案

2026-09-29，用户已选方向 1「对话主轴 · 双页工作桌」，以下验收仍为 Proposed，本轮均未运行。来源为[工作台第 14 节](../frontend/workbench-design.md#14-以目标协作为中心的工作台改造)和[视觉层级](../frontend/design-system.md#51-协作工作区的视觉层级)，视觉参考使用[完整窗口修订图](../frontend/mockups/2026-09-29/collaboration-dialogue-window.png)。本轮只深化设计，不调整既有 M01–M07 通过结论或将此提案自动加入已授权实现。

| 编号 | 场景与验收预期 | 所需证据 |
|---|---|---|
| AGUX-01 | 首次进入无需理解模块目录即可找到表达目标或人工工作的入口；打开页面不产生业务对象或模型调用；新目标发送前可辨识并确认归属 | 页面走查＋请求/数据库记录 |
| AGUX-02 | 从近期工作恢复同一 Project/Task、实际进展、产物和待判断项；无变化基线不制造“上次之后”的比较，失权清除内容 | 真实 API＋切换/重新进入反例 |
| AGUX-03 | 同一工作完成讨论、明确范围、显式委托、查看进展、判断、验收；用户无需手动往返多个管理页拼合当前工作，确认动作仍完整 | 连续操作记录＋持久事实核对 |
| AGUX-04 | 执行中能阅读产物和访问停止/暂停；草稿与不可变版本分开，控制请求中、已暂停与可编辑不混同 | 可控执行＋UI＋真实持久化 |
| AGUX-05 | 判断显示确切对象、影响、版本和证据；条件改变后失效；完成绑定确切产物和验收，不把回复结束/批准/检查 PASS 当完成 | Review/完成集成＋过期反例 |
| AGUX-06 | 执行失败、普通查询失败与外部 UNKNOWN 可区分；保留可读成果并提供协议允许的恢复入口；不盲重试或换身份 | 故障注入＋恢复集成 |
| AGUX-07 | 模型不可用时，业务服务支持的人工阅读/编辑仍可达；旧列表、知识、搜索、设置与深链接没有因重排消失 | 真实服务＋无模型路径回归 |
| AGUX-08 | 窄窗、中文输入、键盘与 DPI 下，目标、正文、判断和控制可达；新进展不抢焦点，长文不被输入区遮挡 | 真实 Windows 窗口＋键盘/DPI 记录 |
| AGUX-09 | 切会话/目标保护未提交输入并隔离迟到响应；重新进入按原命令恢复，窗口关闭后的恢复限制明确 | 草稿/回执反例＋桌面生命周期 |
| AGUX-10 | 完整窗口包含共享 Windows 标题栏与独立上下文栏；后退/前进、搜索、新建任务、拖动/双击、最小化/最大化还原/关闭各自命中正确；业务按钮不在拖动区，未提交输入受保护 | 真实 Windows 窗口＋键盘/鼠标操作＋关闭反例 |
| AGUX-11 | 开发工具绑定确切项目和受管目录；Git 状态/diff 不把他人改动归因给 Agent，非 Git/读错不显示干净；接受、暂存、提交、推送各自明确 | 真实仓库＋混合来源改动＋权限/基线变化反例；接口未接入时记待验证 |
| AGUX-12 | 终端与执行输出分开；打开工具不执行命令、关闭面板不停止进程、切项目不重绑旧终端；底部面板不遮挡输入/证据；交互终端缺协议时无可执行入口 | 面板操作＋作用域切换；终端协议设计后另补进程/资源排他/审计/停止恢复测试，本轮未运行 |

方向 1 的设计走查与后续运行验收采用以下状态样本；静态稿只检查信息与动作是否表达正确，运行证据在另获实现授权后提交。

| 状态样本 | 重点反例与观察点 |
|---|---|
| 首次 / 空态 | 页面 GET 不创建对象或外呼；输入归属未确认不能发送；人工入口可达，无虚构近期工作 |
| 恢复 / 局部失败 | 保持同一 Project/Task/会话与版本，不拿最新会话替代；某区域失败不渲染为无数据；失权清除内容 |
| 范围 / 显式委托 | 聊天中的“开始”不触发 Delegate；采用提案、委托命令与 Run 创建逐项核对，重复提交仍绑定原命令 |
| 执行 / 生成草稿 | 草稿不会显示已保存/已接受；新增预览不抢焦点；查看旧版本不改变 Run；在途输入不能暗示修改执行合同 |
| 暂停 / 接手 | 请求受理不显示 PAUSED；等待判断不显示暂停；PAUSED 仍不解锁编辑，取得执行权后才允许保存 |
| 判断 / 完成 | Review 版本或条件改变使操作失效；批准只确认判断；完成提交绑定确切产物与验收，回执不明不显示成功 |
| 失败 / UNKNOWN | 普通读错不变成外部未知；原动作证据可查；缺核对接口不造可点击成功按钮，不切换身份重试 |
| 长文 / diff / 窄窗 | 在含标题栏的 1280×800、960×640 客户区及规定 DPI/内容缩放检查重排；输入、证据与末尾按钮不遮挡；独立阅读返回保持位置 |
| 窗口 / 草稿 | 标题栏前进后退、关闭、还原后的草稿保护；跨窗口恢复如未支持须明确限制，不以当前组件内保护代替宿主生命周期验证 |

检查记录分别标明“设计提案”“用户已选方向”“代码实现”“开发自检”“真实 Windows 验收”；方向选择及图片修订只能更新前两项。无新 API/schema 变更，缺接口项先记录设计/接入工作，不能用 fixture 消除阻塞。

体验对照使用相同任务、数据与初始状态，记录完成核心路径的页面切换、重复录入、找到下一步的耗时及误判状态的次数。目标是减少寻找与重复操作，同时保留必要确认；不得通过删除审批、验收或人工路径改善数字。量化阈值和参与人数待基线采集后确定，不伪造“提升百分比”。设计稿只能验证所画信息层级；完整体验仍需实现后的端到端与真实 Windows 证据。
