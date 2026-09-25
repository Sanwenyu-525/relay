# Findings & Decisions

## Requirements

- 用户要求“开始按提示词执行”。
- 当前执行入口为 `prompts/00-foundation.md` 的 P00 验证接续第一段。
- 必须保持 P00 与生产工程、P01、独立前端页面任务的边界。
- 所有结论、进度和交付说明使用中文；重要实现变更同步维护事实源文档。

## Research Findings

- `CODEX_NEXT_STEP.md` 记录：没有生产后端、正式 migration 或完整业务 PostgreSQL 验收；当前先完成 P00 缺口，再进入工程搭建。
- `experiments/` 是隔离验证证据，不是生产工程；真实 Provider 尚未配置。
- `apps/workbench/` 是独立前端 fixture 任务，不在本次 P00 后端修改范围内。
- 根目录 `task_plan.md`、`findings.md`、`progress.md` 是历史材料，当前阶段的主文档是 `CODEX_NEXT_STEP.md`。
- P00 第一段要求逐项核对 Spike 1、Spike 2、Spike 3、共同冻结门槛与最小桌面宿主；完整出口全部满足前，不得建立生产工程。
- 现有实验文档已明确：真实 Provider 未配置；恢复实验仍未覆盖主动作与资源/claim 联合提交、完整步骤/完成提交及真实数据库重启。
- Spike 1 当前有 24 场景的局部恢复证据，但完整的 Review/请求/响应跨进程保留、所有批准失效、双批准与双 Worker 的统一入口尚需逐项核验。
- Spike 2 当前有 UNKNOWN 的保守路径与退出收据局部证据；需核验部分写入、外部编辑、证据缺失和“证明未发生”是否实际覆盖，且不能把注入式 `resolve-unknown` 记作真实 Adapter 核对。
- Spike 3 因两个真实 Provider 端点未配置而处于外部条件阻塞，不能读取宿主凭据或伪造结果。
- 共同冻结门槛中的基础 PG（迁移/CAS/bigint/权限）和 Fastify/TypeBox/AI SDK fixture 已有局部通过证据；完整业务事务、完整控制/完成竞争和组合性能仍需核验。
- 最小桌面宿主已有 release 目录包、WebView 握手、单实例、错误 readiness 和强杀回收的局部证据；安装、服务重启轮换、IME/DPI、完整主 frame 准入和整机对照仍未完成。
- ADR-005 已接受“按职责复用/协议集成/机制借鉴”的实施原则；不要求 fork 或一次性引入全部候选框架。
- ADR-006 与 ADR-007 仍是 Proposed：P00 只能补证据，不能把 TypeScript 主栈或 Tauri+sidecar 静默改为 Accepted。
- 技术组合的关键边界是：Relay 保存业务身份与恢复事实，AI SDK 不得拥有业务完成权；工具调用不注册绕过 Gateway 的自动 `execute`。
- P00 性能只能在预算预先确定后报告原始测量；当前性能预算未确认，不能产出 SLO 通过结论。
- 源码审计确认当前主 Worker 的 `probe_runs`/`operations`/`invocations` 与控制模型的 `control_*` 表完全分离；因此不能把 B01/B03–B05 的控制证据当作动作-资源联合提交。
- 当前主 Worker 的一个独立可补缺口是：外部效果完成且 Worker 退出后，尚未实际停止并重启 PostgreSQL 再进行 reconciliation。该切片不需真实 Provider，也不改变生产架构。
- 已实现并验证：主 Worker 在 exit 73 后，父运行器用同一 data directory 和端口停止/启动真实 PostgreSQL；重连后新 Worker 按原 Invocation/effect 核对并将结果补记。最新运行有 25 个场景，新增场景的模型调用、工具调用、外部效果和证据记录均为 1，业务完成提交为 0。
- 当前操作没有创建 `apps/api`、正式 V001、业务 migration 或页面；修改范围限于 `experiments/recovery-p00` 和其事实源文档。
- 契约要求：动作准入前与调用前都必须核对 Task ownership epoch、Worker claim epoch、资源占有和控制请求；UNKNOWN 必须保持相关资源禁止新写，且租约到期不是旧外部进程停止的证据。
- 若做联合实验，最小可接受结构必须有一个协调入口，在同一短事务内锁定并条件更新 Task/Run/Resource/Operation/Invocation；不能让 worker 与 control harness 各自保有独立“当前真相”。
- 主 Worker 的当前竞争场景仅由 `Promise.all` 并发启动，没有锁等待证据；可安全地通过可选测试专用 barrier 在已锁定 Review 或 Operation 后暂停第一个子进程，并用 `pg_stat_activity` 观测第二个独立子进程进入 Lock 等待。
- 已实现并验证：批准 holder 锁定 Review、执行 holder 锁定 Operation/Run/Review 后分别进入 barrier；两个 waiter 均被 `pg_stat_activity.wait_event_type = 'Lock'` 观察到。释放后批准、模型、工具、效果证据各仍为一次。
- 联合资源切片的验收标准：同一规范化临时文件的第一个 Task 在 `DISPATCHING` 时建立 `HELD` claim，第二个 Task 不能进入 Adapter；第一个 Task 部分写入后恢复到 `UNKNOWN` 时 claim 变为 `QUARANTINED`，第二个 Task 仍不能进入 Adapter。所有检查在同一主 Worker 数据模型的短事务内完成。
- 该切片仍不实现业务 Task/Run 全状态机、Handoff、完成事务或生产 migration；其作用仅是让 P00 主动作不再与资源/claim 完全脱离。
- 真实 PG 基础实验最近记录为 13/13 通过，覆盖迁移完整性、并发锁、回滚、bigint、应用角色与 CAS；它不覆盖完整业务协议。
- AI SDK 离线联合 schema 实验最近记录为 8/8 通过，且工具未注册 `execute`；真实 Provider 仍未验证。
- recovery-p00 最新记录宣称 18 个主 Worker 场景和 6 个控制场景；其中控制模型与主动作 Worker 仍是分离协议，最可能的可独立 P00 缺口是其资源/claim/UNKNOWN 联合验证。
- desktop-p00 最新记录显示 release 目录包的单实例、错误 readiness、WebView 重载和强杀回收通过；它不满足安装、IME/DPI、服务重启凭据轮换或 Electron 对照出口。
- 本轮基线复验已启动最新 `recovery-p00` 运行；其 `latest.json` 记录 `PASSED`、24 个场景，且运行器结束后未发现带 `recovery-p00` 命令行的 Node 进程。后续仍须核对输入摘要与场景细节，不能仅据状态字段判断完整 Spike。

## Technical Decisions

| Decision | Rationale |
|---|---|
| 先建立 P00 缺口矩阵 | 以验收出口而非测试数量判断是否可进入生产工程。 |
| 优先复用且核验已有实验 | 避免无意义重跑，并在输入变化或证据不足时再做定向复验。 |
| 先实现真实 PG 重启后 reconciliation 场景 | 最小化地覆盖一个明确未验证恢复裂缝，不虚构资源/claim 已联合。 |

## Issues Encountered

| Issue | Resolution |
|---|---|
| Skill 初始化脚本依赖不可用的 WSL Bash | 手工建立隔离计划目录，保留模板要求与进度记录。 |
| 提取指定文档行时 PowerShell 字符串插值失败 | 改为格式化字符串后重新读取，不影响工作区文件。 |
| 一次性读取所有实验结果的输出被截断 | 后续用 JSON 摘要和定向源代码范围读取，不将截断片段当完整证据。 |
| 恢复运行器超过首次 30 秒工具回传窗口 | 不重复启动；读取同一 `latest.json` 的最终状态并核对无残留运行器进程。 |

## Resources

- `prompts/00-foundation.md`
- `CODEX_NEXT_STEP.md`
- `docs/testing/verification-plan.md`
- `docs/research/p00-source-study.md`
- `experiments/README.md`
