# 2026-09-25 产品补充实施记录（2026-09-27 开发自检）

本记录对应 [25 日工作包](../../prompts/product-supplement-2026-09-25.md)。原设计仍为 Proposed；下列实现、自检与待决定项不等于 M04/M05/M06 独立验收或 Windows 交付。

## 条目映射

| 设计条目 | 开工时已有事实 | 本次补齐或结论 | 证据与边界 |
|---|---|---|---|
| 目标托管：目标、当前事实、阻塞、下一步 | `ProjectResumeView` 已从 Project/State/Task/OPEN Review/Decision/已选用产物查询当前事实，State 下一步直达 Task；无上次查看基线 | 增加已关联 Goal 及来源、查询完成时间；任务/Goal/Review/Decision 单项读取失败分别显示缺口。继续只读，不触发 Task/Run | `projectResumeLive.spec.ts`；任务首分页或单读不证明项目任务全集，不声明“上次以来” |
| 已确认成果与来源 | State `completed_highlight_refs` 直达完成凭据，`selected_artifact_version_refs` 区分当前选用 | 从当前选用版本直达确切来源与正文比较；无法读取详情保留 Version ID 与缺口 | 完成凭据、选用、最新与本轮接受仍为不同事实；不从 State 引用推断验证已通过 |
| 成果共创：确切版本、差异与人工修订 | Artifact 不可变版本、CAS 保存、冲突保稿、响应不明原命令查回执、来源直接父边、旧验证不继承均已有实现 | 来源页按确切版本读取正文与同一 Artifact 的基线版本；同时核对基线来源、hash 和归属后展示差异。编辑器可显式载入最新人工版本为草稿，草稿已改动时禁止覆盖 | `artifactLineage.spec.ts`、`taskDetail.spec.ts`；差异为共同前后缀之外的完整变化行，不是语义变化判定；CRLF/LF 仅换行差异单列 |
| 变化影响：显式关系、可核对版本、缺口 | 原 lineage 仅支持 child→直接父；不存在完整下游图 | 增加用户主动调用的 `direct-uses` 只读查询，限已登记的 `DERIVED_FROM/REVISED_FROM` 直接反向边、前 100 项；不可读子身份隐藏，源正文不可读时不展示引用，`has_more` 提示截断，`complete=false` 恒保留未分析范围 | `artifact-direct-uses.integration.test.ts` 隔离 PostgreSQL 1/1；`artifactLineage.spec.ts`；空列表不得解释为“没有影响” |
| 局部改写、用户锁定、跨成果传播、监控提醒 | 需求补充明确这些仍待设计；现有 lineage 不构成完整引用网络 | 未新增自动写入、锁定或后台触发；待决定项见下 | 本次主动查询不改变权限、执行权或业务状态 |

## 设计原因与实现边界

当前恢复页组合多个只读端点，查询时间只能标注本次读取完成时刻，不是数据库原子快照或已保存的比较基线。Project 标题不冒充 Goal；只展示 Project Goal 关系中已有的目标。若可选来源失败，页面仍呈现已读到的 Project State，同时明确缺口。当前任务列表只有首分页，不能据此判断所有阻塞或待处理项。

成果正文由受授权的确切版本内容端点读取，服务端重新校验 SHA-256/大小。比较前再核对基线版本 ID、Artifact ID、hash、正文可读性与 lineage；版本切换时清除旧展示并忽略迟到响应。行差异以共同前缀/后缀分隔变化中段，长正文不做二次方复杂度的编辑距离计算，也不宣称这是最小 diff。编辑器仅能从本 Artifact 的最新人工版本载入草稿，读取期间若用户改动草稿则保留输入；后续保存仍沿用原 CAS 和同一命令回执规则。读取/比较/直接引用检查均只发 GET。

独立复核指出载入 v1 草稿后，其他入口推进 v2 时，页面刷新可能让保存命令悄悄换用 v2 的修订号。现已在草稿载入时冻结 Artifact ID、版本 ID、Artifact revision 和 Task revision；刷新发现基线变化就暂停保存并保留草稿。若服务端先发现冲突，提交仍使用冻结的旧 CAS，随后禁止重复提交；用户可查看最新版本差异，并显式确认新基线后继续编辑。确认会重读 Task 和 Artifact，保留草稿，成功保存或原命令回执确认后才更新基线。定向反例覆盖“v1 载稿 → 外部 v2 → 旧 CAS 冲突并保稿 → 刷新仍禁用保存 → 人工确认 v2 → 新 CAS 保存”。

`GET /artifact-versions/{id}/direct-uses` 为新增只读接口，**Breaking Change: No**。源版本先按 Workspace 校验，源正文不可用时返回 `source_content_availability=UNAVAILABLE` 和空引用；每条已登记边逐项校验子版本/Artifact 的 Workspace 与正文可读性。子正文缺失时保留关系但隐藏子身份；不在本 Workspace 的子对象不返回。`scope=RECORDED_DIRECT_ONLY`、`complete=false` 表示本接口既不穷尽未登记引用，也不判断间接或语义影响。新接口不增加数据库迁移或业务写入。

## 实际自检

- `apps/api`: `npm run typecheck` 通过；`scripts/run-integration.ps1 -TestFile artifact-direct-uses -UseCLocale`：隔离 PostgreSQL 1/1，通过真实 API、迁移、内容缺失和跨 Workspace 源读取反例；构建、迁移、图安装、PG 启停均退出 0，临时集群已删除。
- `apps/workbench`: `npm run typecheck` 通过；定向 Vitest `artifactLineage.spec.ts`、`projectResumeLive.spec.ts`、`resume.spec.ts`、`taskDetail.spec.ts` 31/31 通过。既有修订并发/响应不明回执反例仍在该组内；本次新增的修订入口、长正文、同版本、CRLF/LF、迟到响应、直接引用与部分读取也在该组内。
- 独立复核后的草稿基线修复：`taskDetail.spec.ts` 18/18；未重跑 API dist 或 PostgreSQL（此次仅改前端草稿 CAS 基线）。
- 尚未运行真实 Windows/WebView2 人工交互、桌面发布包、真实 Provider 或完整项目业务验收；fixture 与定向 API 结果不替代这些出口。

## 尚待产品决定

1. **锁定粒度与 Owner**：建议首版只定义 Artifact 内稳定块 ID 的人工锁定，由 Artifact 领域入口持久化、版本化并用 CAS 更新；应确认是块、段落还是文件级，锁定是否作用于人工编辑，谁能解除。当前 Markdown 版本没有稳定块身份，不能靠行号暗中实现。
2. **自动局部改写范围**：建议先限定用户选择的一个 Artifact、一个来源版本、一个目标版本和预算，产生候选新版本而不直接替换当前选用。需确认批准点、失效后重提案和未选择区域的比较规则；现有直接边不足以判定全部下游。
3. **跨成果引用与影响传播**：建议先由用户确认“子版本引用父版本”的显式关系，再按一跳列出“确定直接引用”；未登记/间接/语义推测单列。需确认关系创建与更正入口、删除/失效规则，以及能否声明扫描范围完整。
4. **监控与提醒**：仍属 V1.5 触发/自动化边界；需另定授权范围、去重键、提醒阈值和暂停语义。本次没有后台轮询或通知。

共享交互、API、测试计划和当前进度由协调 Agent 统一更新；本记录只保存本工作包的实施依据与验证边界。

## 协调侧独立复核

2026-09-27：协调侧复查源码与本轮前快照，发现载入 v1 起草后刷新到 v2 可能自动采用新 CAS 的问题，退回执行代理修复。修复后冻结起草基线，冲突/刷新保稿且禁止暗换基线；显式确认前再次读取版本，确认期间再变更则要求重新核对。协调侧复跑 `artifactLineage.spec.ts`、`projectResumeLive.spec.ts`、`taskDetail.spec.ts`、`artifactDirectUsesClient.spec.ts`：29/29 通过，含新并发反例。

协调侧另独立执行 `powershell -NoProfile -ExecutionPolicy Bypass -File apps/api/scripts/run-integration.ps1 -UseCLocale -TestFile artifact-direct-uses`：1/1 通过，API 构建、37 条迁移、图安装、PG 启停均成功，临时集群已删除。该结论限本记录列明的代码与场景，不包含待定自动化、Windows 交互或整体模块验收。
