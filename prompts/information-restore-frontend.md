# 资料、记忆与规则恢复：前端开发任务书

日期：2026-10-19。**同日已实施**：三接口 client、撤销条、永久恢复入口、异常回执核对与组件/类型检查均完成，成绩归[功能验收表](../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)「资料与记忆规则恢复前端」行，过程归 [CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)。未闭合：真实 API 浏览器链路（本机无运行中的 API/PG）、真实 Windows/WebView2 与安装态。原任务书保留切片与验收规格，接续时只做剩余项。

请在 `D:/Develop/Relay-Agent` 完成资料归档、记忆/规则停用的前端撤销与永久恢复入口，直接开发、测试并同步文档。所有汇报用中文，不 commit/push，不派子代理。

## 1. 事实源与边界

先读取 AGENTS.md、CODEX_NEXT_STEP.md、统一功能验收表「资料与记忆规则恢复后端」行，并阅读：

- [工作台 §13.2](../docs/frontend/workbench-design.md#132-危险操作的两条通道2026-10-18)
- [HTTP §10.97](../docs/api/http-command-contract.md#1097-资料归档与记忆规则停用的反向命令2026-10-19-后端实现)
- [信息与计划 §1.2](../docs/architecture/information-planning.md#12-生命周期恢复2026-10-19-后端实现)
- [测试计划 §38](../docs/testing/verification-plan.md#38-资料与记忆规则恢复2026-10-19)

三类后端反向命令已实现，不重做后端或数据库。不扩展到连接、资源、权限策略撤销、Decision 替代、会话物理删除或其他危险操作。权限策略撤销不开放撤销。本工作区存在并行未提交改动，先查 git status 与目标 diff，定点合并，不回退他人代码。

## 2. 文件责任与复用

三类信息共用 `apps/workbench/src/views/KnowledgeView.tsx`，不存在独立的 MemoryView/RulesView。本片主要维护该视图、`src/api/resources/information.ts` 及实际 client facade/类型/导出、相关测试；只在必要处小改既有组件。

复用 `src/components/Feedback.tsx` 的 openUndoFeedback/escalateFeedback/closeUndoFeedback，参考 ProjectsView、SessionRowMenu 的已实现撤销链。计时、悬停/焦点暂停、同键单条与升级 Notice 由现有宿主处理，不新建 toast 管理器、计时器或样式体系。数值取现有 token，不重构页面布局。

## 3. 已实现接口

路径前缀 `/workspaces/{workspace_id}`，均 POST，200 命令信封。请求统一为 `{command_id, expected_revision}`：

| 操作 | 路径 | command_type | result |
|---|---|---|---|
| 取消资料归档 | `/knowledge/{id}/unarchive` | UnarchiveKnowledge | `{knowledge_id, revision, status:"ACTIVE"}` |
| 恢复记忆 | `/memories/{id}/reactivate` | ReactivateMemory | `{memory_id, revision, status:"ACTIVE"}` |
| 恢复规则 | `/rules/{id}/reactivate` | ReactivateRule | `{rule_id, revision, status:"ACTIVE"}` |

跨 Workspace 返回 404，Project 已归档或 expected_revision 陈旧返回 409；同命令同载荷返回原回执，同命令异载荷拒绝。已 ACTIVE 且修订匹配返回当前事实，不递增修订。恢复仅改根状态与修订，不改正文版本、确认主体或 Memory 有效期，不删除已有决定复审候选，不恢复外部权限。规则/上下文修订仍递增，不能向用户承诺继续旧 Run 或撤回已发生效果。

## 4. 必须完成的交互

1. 为三个接口增加真实 API client 方法。沿现有命令封装核对 command_id、目标 ID、ACTIVE 状态与 revision；收到无法核对的信封不能当成功。命令结果不明保留原身份与载荷，使用现有回执核对机制，不换 ID 重发。
2. 三类正向操作遵循既有「单击即发→核对成功→撤销条」规则，不叠加确认框。正向回执明确成功后才显示「已归档资料 / 已停用记忆 / 已停用规则 · 撤销」。现有 submit() 如果吞掉回执，只为本片最小调整返回结果，保留其他调用者行为。
3. 撤销使用新的 command_id，expected_revision 必须取正向命令回执，禁止读取列表里的旧 revision。回调捕获准确的 API/Workspace、类型、对象 ID 与回执，不读取之后已变化的 selected。切换 API/Workspace 后不能把旧操作投影到新范围。
4. 正向传输失败或回执不明时不给撤销条，保留就地「无法核对」与原命令恢复入口。撤销失败或冲突时同一反馈升级为 Notice，说明结果并指向永久恢复入口；不能悄悄消失、自动覆盖陈旧基线或声称已恢复。
5. 给已归档资料、已停用记忆/规则提供永久可达的恢复操作。优先复用现有列表、筛选与详情；如果原列表没有呈现非活动项，补最小可达入口，不另建管理页。过了撤销条时限仍能恢复，不能误导为永久丢失。
6. 永久恢复使用当次读回对象修订，成功后定向重读列表/详情；冲突先刷新事实并要求用户重新决定，不自动覆盖。归档 Project、无 API、加载中、命令未决等状态沿既有写入守卫处理，不绕过限制。
7. 文案明确「只恢复状态」：资料归档产生的待核对候选仍保留；恢复 Memory 不延长有效期，过期项不能写成可供 Agent 使用；恢复规则不回退规则修订或自动续跑。后端查询到的真实可用性、有效期和规则状态仍是依据。
8. 保存草稿、未决命令、不可变版本阅读、来源提示、已有 Decision 行为均保持，不借本片修复其他功能或改权限体系。

## 5. 验证与交付

先补失败用例再实现，按实际文件组织测试：

- client：三条路径与命令体、回执 ID/目标/状态/修订核对，异常信封与结果未明。
- 三类正向成功才出现撤销；撤销为新命令且使用正向回执修订；重复点击不产生重复调用。
- 正向结果不明不给撤销；恢复冲突/网络不明升级 Notice，并保持原命令核对入口；永久入口在撤销条消失后可用。
- 切对象/API/Workspace 后准确定位原目标，迟到结果不写错范围；归档项目被拒；恢复后正确重读状态，原版本、有效期与待核对提示不丢。
- 回归现有 knowledge、knowledgeReading、knowledgeContentClient、feedback 与受影响 client/组件套件；Workbench typecheck、生产构建。
- 有可用环境时跑真实 API 浏览器链路，核对请求与磁盘/数据库事实；组件、真实 PG/HTTP、浏览器、Windows/WebView2 分开报告。后端历史成绩不能当作本轮 UI 验收。

同步所属主文档、统一验收表与 CODEX_NEXT_STEP，运行 `node scripts/check-docs.mjs`、`git diff --check`。不新建逐轮验收报告。接口与实际行为冲突时给出确切请求、响应和预期并报告，不自行改后端或降低权限边界。

完成标准：三类信息均可从正向回执撤销，也能通过永久入口恢复；异常结果可核对，不发生误目标、误修订或虚假成功。最终汇报改动、实际验证、文档同步与剩余限制。
