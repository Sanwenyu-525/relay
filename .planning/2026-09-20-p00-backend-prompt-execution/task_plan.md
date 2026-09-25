# Task Plan: 执行 P00 后端验证接续

## Goal

依据 `prompts/00-foundation.md` 的第一段，补齐或准确界定 P00 验证缺口，交付可复验的代码、测试与文档证据；不越过未满足的门槛进入 P01。

## Current Phase

Phase 3：P00 定向实现与测试

## Phases

### Phase 1：证据与缺口核对

- [x] 阅读 P00 提示词、当前状态、测试计划和已有关联实验。
- [x] 将每个 P00 出口映射到现有证据、缺口与可执行动作。
- [x] 记录外部前置条件与不应伪造的通过结论。
- **Status:** complete

### Phase 2：基线复验与最小诊断

- [x] 仅重跑与当前缺口相关的已有检查。
- [x] 核对输入摘要、测试结果和源代码是否一致。
- [x] 为失败项定位最小修复范围。
- **Status:** complete

### Phase 3：P00 定向实现与测试

- [x] 增加“外部效果后、结果写入前，真实 PostgreSQL 重启后恢复”的隔离场景。
- [x] 将主 Worker 的双批准/双执行竞争从 `Promise.all` 改为锁内 barrier 与 `pg_stat_activity` 锁等待观测。
- [x] 评估主 Worker 与资源/claim 联合协议是否需要单独更大切片，不把控制替身误写成已联通。
- [ ] 在主 Worker 的 P00 schema 内实现 Task/Run/资源/claim 的最小联合准入与恢复场景。
- [ ] 不创建生产 `apps/api`、正式 V001 或业务页面。
- [x] 每项修改都有相应可执行验证。
- **Status:** in_progress

### Phase 4：验证与文档同步

- [ ] 运行相关类型检查、测试和文档检查。
- [ ] 更新 P00 研究记录和当前状态，仅陈述已实测事实。
- [ ] 记录未运行的真实 Provider、性能或桌面前置。
- **Status:** pending

### Phase 5：P00 交接判断

- [ ] 判断 P00 工程搭建是否可以开始；否则列出精确阻塞项。
- [ ] 汇总改动、命令、结果、验收映射与剩余风险。
- **Status:** pending

## Decisions Made

| Decision | Rationale |
|---|---|
| 从 P00 第一段开始 | `CODEX_NEXT_STEP.md` 明确生产后端和 P00 出口尚未完成，P01 不能前置。 |
| 使用独立 `.planning/` 目录 | 根目录三份规划文件是历史研究材料，不能覆盖。 |
| 不将隔离实验视为产品后端 | 项目 README、实验说明和当前状态均明确限定其证据边界。 |
| 先补真实 PostgreSQL 重启恢复 | 这是现有 recovery-p00 明确列出的独立缺口，能在没有 Provider 凭据的前提下用最小实验切片验证；资源/claim 联合协议仍需更大且独立的设计切片。 |
| 不合并主 Worker 与 control-worker | 两者当前是分离的 P00 harness；为制造“已联合”的表面结果而跨切片拼接，会误导关于生产资源排他的结论。 |
| 若扩展联合实验，采用单独的最小整合入口 | 契约要求同一准入提交同时校验 ownership、claim、资源和控制请求；把两个既有临时表简单互相查询会制造双 Owner，而不是验证正确的单一协议。 |
| 先强化主 Worker 的并发证明 | 现有主 Worker 的双批准/双执行只用 `Promise.all`，不满足 P00 对 barrier/latch 与独立连接的明确要求；锁内 barrier 可在不改变业务模型的前提下补强证据。 |
| 测试 barrier 仅由显式环境变量启用 | 正常 Worker 运行不等待测试文件；测试运行器为 holder/waiter 进程分别注入 barrier 路径、阶段和 application name。 |
| 联合资源测试使用现有主 Worker schema 的最小扩展 | 每个现有操作默认映射到独占受管文件；仅新场景显式让两个 Task 指向同一个隔离临时文件，以验证真实规范化目标的排他。 |

## Errors Encountered

| Error | Attempt | Resolution |
|---|---:|---|
| Windows WSL `bash.exe` 无 Linux 发行版，无法运行 skill 的 `init-session.sh` | 1 | 使用独立 `.planning/` 目录与等效模板结构，不重复相同命令。 |
| PowerShell `New-Item` 不支持使用的 `-LiteralPath` 参数 | 1 | 改为固定绝对路径的 `-Path` 后成功创建计划目录。 |
| PowerShell 字符串插值把 `$Path:` 解析为非法变量引用 | 1 | 改用格式化字符串输出文件范围，不重复原插值写法。 |
