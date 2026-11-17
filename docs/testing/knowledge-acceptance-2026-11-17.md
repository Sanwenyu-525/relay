# Relay 知识库第二轮专项验收报告（独立复核）

日期：2026-11-17  
仓库：`D:\Develop\Relay-Agent`  
审计基线：`bb6a6a8c7d6396aaff31146134566278bf5fc8f6`  
本轮代码修复提交：`778893de32299ba725d658e5c03b9191d23f8b19`  
验证性质：第二轮独立复核与缺陷修复；不采信上一轮实施者自检结论  
最终结论：**PARTIAL**

> 结论边界：P0 的三个确定性缺陷已经修复并有真实 PostgreSQL / HTTP 证据；但 P1 的“全部知识”聚合、批量提交闭环、使用记录到回答引用的追溯仍未完成，全量 Workbench 回归没有取得完整汇总，Windows 原生宿主与缩放验收也未执行。因此不给予 PASS，也不判定为 FAIL/BLOCKED。

---

## 1. 工作树与版本

- 审计开始时 HEAD 为 `bb6a6a8`，工作树包含大量并行未暂存/未跟踪改动；本轮未执行 `git reset --hard`、`git clean -fd` 或任何现场清理。
- 本轮只对以下知识链路文件做定点修改，并提交为 `778893d`：
  - `apps/api/src/application/knowledge-retrieval.ts`
  - `apps/api/src/application/context-builder.ts`
  - `apps/api/src/api/knowledge-api.ts`
  - `apps/api/src/application/knowledge-import.ts`
  - `apps/api/test/unit/knowledge-import.test.ts`
  - `apps/api/test/integration/knowledge-agent-retrieval.integration.test.ts`
  - `apps/api/test/integration/knowledge-import.integration.test.ts`
  - `apps/workbench/src/views/KnowledgeView.tsx`
  - `apps/workbench/src/views/KnowledgeView.css`
- 并行改动（assist、model、MemoryView、TasksView、api-harness、文档等）仍保留在工作树，没有被本轮提交覆盖或回退。
- 上轮报告 `docs/testing/knowledge-acceptance-2026-11-15.md` 已按定时任务要求重新下载并校验；备份为同目录 `knowledge-acceptance-2026-11-15.md.bak-20261115`，下载文件 27,861 字节，包含标题“Relay 知识库系统专项升级验收报告”。

## 2. 验收矩阵

| 需求 | 代码位置 | 实际实现 | 测试/证据 | 风险 | 状态 |
|---|---|---|---|---|---|
| 来源命中进入 Agent 候选 | `apps/api/src/application/knowledge-retrieval.ts:88-131` | `sourceHit` SQL 片段同时进入 select、候选 WHERE 与排序分 | `knowledge-agent-retrieval` 7/7；来源 URI、文件名、标签、集合用例 | 低；未单独覆盖跨工作空间来源 | 已修复 |
| 标题/正文/标签/集合/来源一致 | 同上，评分 `:133-137` | 统一 token 与 `exists`；排序稳定为分数、`project_match`、`version desc,id` | 7 个真实 PG 用例 | 低 | 已修复 |
| 显式引用只有一个 Owner | `knowledge-retrieval.ts:44-47`；`context-builder.ts:140` | 删除 `explicitIds`；显式引用统一由 `readContextSources(contract.frozen_snapshot)` 先处理 | Context 定向用例 12/13；显式冻结、失权用例通过 | 中；13 项中 1 项启动超时 | 已修复，部分验证 |
| 任务目标/验收要求成为有界信号 | `knowledge-retrieval.ts:35-60`；`context-builder.ts:75,147-148` | 仅取 `task_acceptances.objective` 与 required criteria；标题 240、目标 300、最多 6 条×120、项目标题 120 | 检索集成中的“标题+正文+验收目标”用例 | 中；任务模型无 description，未凭空补字段 | 已修复 |
| PDF/DOCX 资源上限 | `knowledge-import.ts:31-46,277-357,420-488` | ZIP 条目/单条/总解压、PDF 流/单流/总输出/文本/超时；`RESOURCE_LIMIT` | 导入单测 22/22；导入 HTTP 集成 6/6 | 中；未做压缩比专项与 20 文件提交批次 | 已修复 |
| ZIP 结构/PDF 流可靠性 | 同上 `:277-357`、`:420-488` | EOCD、分卷/ZIP64/加密、中央目录边界、NUL/反斜杠、局部头一致、CRC；PDF 逐流、Flate 固定输出、截断/畸形拒绝、`findPdfStreamKeyword` | 单测覆盖损坏 DOCX、声明大小不一致、截断 ZIP、PDF 单流/累计/流数超限 | 中；自研解析器长期维护性风险 | 已修复并有边界 |
| 导入 commit 体积限制 | `apps/api/src/api/knowledge-api.ts:356,371` | commit 的 `bodyLimit` 移到 Fastify route options；预览 80MB、提交 20MB | 1.2MB PDF 请求提交 201；此前 413 不再出现；导入集成 6/6 | 低 | 已修复 |
| 全部知识聚合视图 | `apps/workbench/src/views/KnowledgeView.tsx:69-73` | `kinds` 仍只有 KNOWLEDGE/DECISION/RULE，没有“全部” | 源码核对；无聚合测试 | 高；P1 必需项缺失 | 未实现 |
| 决定/规则分页 | 仍走旧未分页列表端点；未新增服务端分页 | 资料走 `knowledge/page`，决定/规则仍一次性读取 | 未取得容量/分页证据 | 中；大数据量读取风险 | 未完成 |
| 多文件批量提交闭环 | commit 路由仍为单文件 `file`；预览有 20 文件上限 | 只验证预览部分失败；未验证 commit 全成功/部分成功/回执不确定 | 导入集成 6/6 中无批量 commit 用例 | 中；P1 闭环缺口 | 未完成 |
| 集合/标签/关系治理 | `knowledge-organization` 集成 | 5/5：范围隔离、整体替换、自关联/缺版本/跨范围拒绝、删除只解除关系 | 真实 PG 集成 5/5 | 中；循环、历史版本、失权、SUPERSEDES 语义未全覆盖 | 部分完成 |
| Agent 使用记录与来源追溯 | Context Manifest / Assist sources 现有链路 | 只能证明候选进入检索与 Context；未独立证明“模型实际使用/回答明确引用” | 未建立使用与引用分离的验收 | 高；追溯仍不闭合 | 未完成 |
| 生产构建 | API/Workbench | API typecheck 0、API build 0；Workbench typecheck 0、Vite build 0（13.87s） | 日志 `tmp/api-*-20261117b`、`tmp/workbench-build-20261117b` | 低；存在 chunk>500KB 警告 | 通过 |
| 全量回归 | API/Workbench | API 1323 项：1286 pass/35 fail/2 skip；Workbench 全量未取得汇总 | 见第 6、7 节 | 高；不能作为整体放行依据 | 部分验证 |
| Windows 原生宿主/缩放 | — | 未执行；截图来自 Windows 上的 Chromium 浏览器 | 仅浏览器截图 | 高 | 未完成 |

## 3. P0：Agent 知识检索

### 3.1 来源匹配

原实现计算了 `source_hit` 与分数，但候选 `WHERE` 只允许标题/正文/标签/集合命中；仅来源 URI 或文件名命中时，合法候选在候选阶段就被排除。修复后：

- `sourceHit` 是同一个 SQL 片段，同时用于 `select`、`WHERE` 和得分；
- 排序仍是 `title_hits*3 + body_hits + tag_hits*2 + collection_hits + source_hit`，再按项目匹配、版本倒序和 ID 稳定排序；
- 查询仍限定当前项目或共享知识、当前版本、`ACTIVE`、`AVAILABLE`，未放宽权限。

证据：`knowledge-agent-retrieval.integration.test.ts` 7/7，在真实 PostgreSQL 上覆盖：
1. 项目架构文档+共享规范，跨项目私有知识不进入候选；
2. 归档知识不召回、低相关查询无噪音；
3. 同名新版本只返回当前版本；
4. 仅来源 URI 命中；
5. 仅来源文件名命中；
6. 仅标签命中与仅集合命中；
7. 标题+正文同时命中，验收目标作为有界信号。

限制：没有独立的跨工作空间、`UNAVAILABLE` 单独用例；这些条件由同一 SQL 谓词覆盖但没有单独断言。

### 3.2 显式引用

`KnowledgeRetrievalInput.explicitIds` 已删除。 显式引用不再由检索模块处理，而由 `context-builder.ts` 读取冻结快照中的 `readContextSources(contract.frozen_snapshot)`；这样不会出现检索模块与 Context Builder 两套优先级/权限校验。显式来源仍绑定冻结版本；来源失权后历史 Manifest 读取按当前权限重新验证，而不是泄露正文。

证据：Context 集成 13 项中 12 项通过，包含显式来源冻结、未知/已退役来源拒绝、冻结后失权排除；唯一失败是 API 启动超时，见第 7 节。

### 3.3 任务上下文信号

当前任务模型没有 description 字段，因此没有把整段长描述展开。实际输入只来自：

- `task_acceptances.objective`（最多 300 字符）；
- required acceptance criteria（最多 6 条，每条 120 字符）；
- 任务标题 240 字符、项目标题 120 字符；
- 最终仍由 `knowledgeQueryTokens` 截到 500 字符 / 24 词元。

没有引入未授权字段，也没有把项目标题设为压倒性权重。

### 3.4 检索质量评测

本轮新增的是固定真实 PG 检索用例，不是 Precision@K / Recall@K / MRR 评测集；因此“中文双字词元误命中、常用词召回、高相关知识被挤出候选”只有定向用例证据，没有量化指标。Embedding 与语义检索未在本轮引入，属于后续增强，不作为 P0 放行条件。

## 4. P0：PDF / DOCX 导入安全

`knowledge-import.ts` 现有自研 ZIP/DOCX/PDF 解析器，审计后增加了固定资源上限，不信任文件声明的未压缩大小：

- ZIP：条目 2000、单条解压 8MB、总解压 16MB；EOCD、分卷/ZIP64/加密、中央目录边界、文件名 NUL/反斜杠、局部头与中央目录一致、CRC32；
- PDF：流 1000、单流 8MB、总输出 16MB、文本 4MB、解析 3000ms；逐流处理 Flate，固定输出上限，截断/畸形流拒绝；
- 修复 `indexOf('stream')` 会命中 `endstream` 的缺陷，改为 `findPdfStreamKeyword`；
- `ImportFailure` 增加 `RESOURCE_LIMIT`，资源超限是可读拒绝，不会伪装成成功。

验证：
- `knowledge-import.test.ts` 22/22：格式由魔数判定、BOM/GB18030、恶意 HTML、损坏 DOCX、声明大小与实际不一致、CRC 损坏、截断 ZIP、PDF 单流/累计/流数超限、截断 PDF、恶意数字实体；
- `knowledge-import.integration.test.ts` 6/6：超过 1MB 的预览与提交到达处理器、20 文件预览上限与单坏文件、Markdown 提交、重复内容 SKIP/NEW_VERSION、扫描 PDF `NO_TEXT`、HTML 去脚本、DOCX 段落、扫描 PDF 422 不残留知识行；
- 1.2MB PDF 提交返回 201；此前 commit 使用默认 1MB 的 413 已复现并修复。

边界与风险：
- 没有新增“压缩比”专项用例；当前依靠固定输出上限抵御 ZIP Bomb，而不是只检查声明大小。
- 没有验证 20 文件的 **commit** 批处理；只有预览层的 20 文件上限与部分失败。
- 自研解析器仍未证明对复杂 DOCX 表格/文本框/页眉页脚、特殊字体 PDF 的完整支持；扫描 PDF 标记 `NO_TEXT` 是正确边界，不等于 OCR 能力。

## 5. 数据库迁移

在隔离的非空历史库 `relay_k0167_round2` 上执行：

- 先复制 0001–0166 并迁移到 167 条 ledger；
- 插入历史工作空间/项目/知识根/版本，正文 `# 历史架构资料\n\n迁移前正文。`，sha 为 64 位十六进制；
- 执行全量迁移，只应用 `0167_knowledge_organization`、`0168_memory_capture_tasks`、`0169_assist_skill_invocations`，ledger 170；
- 验证：旧标题、`current_version`、正文、sha 未变；`summary` 回填为正文前 200 字符；新表存在但为空；4 个关键索引存在；
- 第二次迁移 `applied=[]`，ledger 仍 170，幂等通过。

限制：没有在大量历史数据上做迁移耗时/锁竞争验收；本轮只证明语义与小规模非空库正确。

## 6. 前端与 UI 验收

本轮新增 `docs/testing/evidence/knowledge-acceptance-2026-11-17/` 共 38 张浏览器截图：960×720、1024×800、1280×800、1440×900、1660×895、1920×1080，各含 overview/search/search-empty/detail/decision/rule；1440 另有 import 与 organize 弹窗。

已确认并修复的前端问题：
- 1280 宽下列表占满首屏，选中行后详情区完全在视口外；现在在详情区位于视口下方时自动 `scrollIntoView`，1280/1440 截图已重拍并验证阅读区可见。
- 列表行原先让摘要 `nowrap` 挤压标题，长标题逐字换行；改为标题可截断、摘要 flex 截断、元信息与徽标自然宽度。1280/1440/1660/1920 截图无水平溢出。

未完成/未通过：
- 没有“全部”聚合视图；`kinds` 只有资料/决定/规则。
- 资料列表有服务端分页；决定/规则仍走旧未分页列表，未取得容量证据。
- `KnowledgeView` 仍保留 MEMORY 死分支与旧路由解析；虽然 Memory 已独立页面，但清理未完成。
- 没有 1000 条知识的前端列表截图；性能集成只覆盖 API 列表/搜索/概览/检索的 100/1000/10000 条。
- 960/1024 更窄窗口仍以列表优先，详情需要手动滚动；未做 125%/150%/200% 显示缩放验收。
- 未验证超长 Markdown、代码块、表格、历史版本、来源失效、权限拒绝的独立截图；部分由知识定向测试覆盖，但不是四档视觉证据。
- 截图来自 Windows 上的 Chromium 浏览器，不是 Windows 原生桌面宿主验收。

UI 规范检查：`node scripts/check-ui-conventions.mjs` 退出 0；裸色值 0、px 字号 22（基线 32）、组件层 19、无 `__dev` 路由残留。

## 7. 构建、测试与失败归因

### 7.1 构建

| 检查 | 命令 | 结果 |
|---|---|---|
| API typecheck | `tsc --noEmit -p apps/api/tsconfig.json` | 0 |
| API build | `tsc -p apps/api/tsconfig.json` | 0 |
| Workbench typecheck | `tsc --noEmit -p apps/workbench/tsconfig.json` | 0 |
| Workbench Vite build | `npm --prefix apps/workbench run build` | 0，`✓ built in 13.87s` |
| UI 规范 | `node scripts/check-ui-conventions.mjs` | 0 |
| 文档检查 | `node scripts/check-docs.mjs` | 1（25 个既有缺失链接） |
| 功能地图 | `node scripts/feature-map.mjs --check` | 1（14 条旧验收关联失效） |

文档与功能地图的失败均为工作空间/项目/任务/产物等既有引用，不是本轮知识文档新增；但没有修复，故不写成“全绿”。

### 7.2 知识链路测试

| 范围 | 结果 | 证据 |
|---|---|---|
| 知识导入单测 | 22/22 | `tmp/api-unit-20261117.log` 中知识用例 |
| Agent 检索真实 PG 集成 | 7/7 | `knowledge-agent-retrieval` |
| 导入 HTTP 集成 | 6/6 | `knowledge-import` |
| 组织/范围/关系真实 PG 集成 | 5/5 | `knowledge-organization` |
| 性能集成 | 1/1 | 100/1000/10000 条均有界；10000 列表 62.6ms、搜索 189ms、概览 120.8ms、检索 128.5ms |
| Context 集成 | 12/13 | 唯一失败为 API 启动 60s 超时：`connect ECONNREFUSED 127.0.0.1:5149`，pid 存活、470 次探测；属并行构建争用/环境超时，未复现为产品断言失败 |
| Workbench 知识定向 | 48/48（7 文件） | `tmp/workbench-knowledge-20261117d.log`；含分页恢复、草稿保护、Memory 独立、占位符、类型切换 |
| Workbench 全量 | 无完整汇总 | 日志 `tmp/workbench-full-20261117.log` 532,517 字节，最后写入 11:20:03，止于测试中途，无 `Test Files` 汇总；观察到 assistantModeSwitch、folderFirstConversation、scenarioLabMatrix 等多文件失败，不能当作通过 |

### 7.3 API 全量单测失败归因

`tmp/api-unit-20261117.log`：1323 项，1286 通过、35 失败、2 跳过。按失败用例名称初分：

- Spark 模型快照 / assist-skill 脱敏：2 项；
- 包导出/注册表边界：3 项；
- 浏览器扩展与 CDP/Chrome 工具：17 项；
- 原生文件发布/restore 隔离：5 项；
- 发布内容目录与不可覆盖：3 项；
- 记忆写入裁决：1 项；
- 模型连接/隔离：2 项；
- 其他（computer_type 常量等）：2 项。

没有任何知识命名的用例失败；但上述 35 项没有逐项复现和归属到具体并行提交，因此只能写“初分且未证明与本轮知识改动相关”，不能把它们全部宣称为“其他模块的问题”。

### 7.4 结论

- API/Workbench 类型检查、生产构建通过。
- 知识定向 22 + 7 + 6 + 5 + 1 + 48 项通过；Context 12/13。
- 全量 Workbench 回归未完成；API 全量仍有 35 个未逐项归因失败。
- 不能以定向测试替代跨模块回归，也不能以浏览器截图替代 Windows 原生宿主验收。

## 8. 仍未完成的产品能力与 P1 缺口

- “全部知识”聚合视图（只读跨类型 UNION / 专用 aggregate endpoint 未拍板）。
- 决定/规则的服务端分页或明确容量约束。
- 多文件 commit 的全成功/部分成功/全失败/重复提交/超时/回执不确定闭环。
- Agent 使用记录中“已提供给模型”与“回答明确引用”的分离；来源失权后的历史展示仍需独立验收。
- 关系环、自关联、跨项目/跨空间、历史版本绑定、目标删除、来源失权、`SUPERSEDES` 与 Decision 自身替代语义的完整矩阵。
- 文件夹导入、网页 URL 抓取、OCR、语义/Embedding、AI 自动治理；这些均未在本轮实现，不应当作已交付能力。
- 1000 条知识前端列表、超长 Markdown/代码/表格/历史版本/权限拒绝的专门 UI 验收。
- 125%/150%/200% 缩放、Windows 原生桌面宿主验收。
- 文档检查 25 条、功能地图 14 条既有失效引用。

## 9. 剩余风险

1. **Context 启动超时**：在并行 Tauri/Cargo 构建占用资源时，API 启动 60 秒仍可能超时；这会掩盖真实 Context 回归，需在低负载窗口复跑。
2. **全量 Workbench 无最终汇总**：已观察到多个文件失败，未能区分共享 jsdom 状态、Tauri mock 缺失与真实产品回归；不能用知识定向 48/48 代替。
3. **导入解析器长期维护**：自研 ZIP/PDF/DOCX 解析已加硬上限，但没有成熟解析组件的格式覆盖；复杂 DOCX 表格/文本框、特殊字体 PDF 仍是已知边界。
4. **P1 信息架构缺口**：没有“全部”视图，决定/规则仍可能一次性读取；数据量增长后体验与容量风险未量化。
5. **来源追溯不闭合**：候选命中与 Context 注入已有证据，但“模型实际使用哪段正文、回答是否明确引用”没有独立验证。

## 10. 最终放行结论

**PARTIAL**

- P0 的三个确定性缺陷（来源命中候选、commit bodyLimit、PDF/DOCX 资源限制）已完成修复，并取得真实 PostgreSQL/HTTP/资源上限证据；这部分可以进入后续复验。
- 但“全部知识”聚合、决定/规则分页、批量 commit 闭环、使用记录追溯、全量 Workbench 回归、Windows 原生宿主与缩放验收未满足 PASS 条件。
- 未发现新的阻断性缺陷，因此不判 FAIL；本轮具备真实代码、PG、HTTP 与浏览器证据，不判 BLOCKED。
- 放行建议：允许以“P0 修复候选版本”继续复验，不批准作为“知识库完整链路生产 PASS”。

---

### 附：本轮产物

- 代码修复提交：`778893d`（9 个文件，515 insertions / 92 deletions）。
- 新证据目录：`docs/testing/evidence/knowledge-acceptance-2026-11-17/`（38 张 PNG）。
- 上轮报告及备份：`docs/testing/knowledge-acceptance-2026-11-15.md`、`.bak-20261115`。
- 关键日志：`tmp/api-unit-20261117.log`、`tmp/workbench-knowledge-20261117d.log`、`tmp/workbench-build-20261117b.log`、`tmp/integration-knowledge-extra-20261117d.out.log`、`tmp/workbench-full-20261117.log`、`tmp/knowledge-migration-20261117/`。

**报告生成时间：2026-11-17（Asia/Shanghai）**
