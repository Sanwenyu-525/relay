# Relay 知识库系统专项升级验收报告

日期：2026-11-15
范围：`D:\Develop\Relay-Agent`
结论：**PARTIAL（代码、迁移、API、UI、定向测试与文档已完成；生产构建、全量回归、真实 Windows 桌面与部分治理能力未闭合）**
验证性质：实施者自检，未做独立验收，未 commit/push。

---

## 0. 执行摘要

本轮把原来「四类信息混排」的资料页改造成知识资产中心：

- `Knowledge` 只保留 `资料 / 决定 / 规则` 三类；`Memory` 回到独立 `/memory` 页面，V2 模型未合并、未删除。
- 工作空间与项目范围统一为：`WORKSPACE = 工作空间共享`，`PROJECT = 仅当前项目`，`ALL = 工作空间共享 + 当前项目`。
- 新增知识集合、标签、知识关联、服务端游标分页、概览、健康检查、文件导入、预览/提交分离、重复检测。
- `GET /knowledge` 旧语义保留，新页面改用 `GET /knowledge/page`，避免破坏其他调用方。
- Agent 检索从单纯标题匹配升级为多信号关键词检索，带作用域/状态/版本/权限过滤、Context 预算和来源引用。
- 已知 `knowledgeCaptureLayout`、`knowledgeSimplify` 失败已修复；新增 Agent 检索与 100/1000/10000 条性能测试。

未完成的关键项：

- Workbench 生产 `vite build` 未取得最终退出码；本轮末次尝试因本机内存耗尽、Shell 连接中断。
- 全量 Workbench Vitest 在最新修复后未重新完整通过；最近一次完整结果是 259 文件 / 238 通过、2652 用例 / 2542 通过，之后一次全量 OOM。
- 语义检索/Embedding 未引入（按计划仅在关键词阶段完成后评估）。
- 文件夹批量导入、网页 URL 抓取、OCR、原始文件持久化未实现或明确不支持。
- AI 治理只保留既有「候选 → 人工确认」链路；自动重复/冲突/过期建议未完整落地。

---

## 1. 架构变化

### 1.1 Knowledge 与 Memory 的最终边界

| 维度 | Knowledge | Memory |
|---|---|---|
| 定位 | 人和 Agent 共享、可管理、可复用的知识资产 | Agent 的长期个性化记忆 |
| 页面 | `/knowledge`（资料/决定/规则） | `/memory` 独立页面 |
| 数据模型 | `knowledge_items`、`knowledge_versions` + 0167 组织表 | 既有 Memory V2 模型，未合并 |
| 生命周期 | 版本、归档/恢复、来源追溯、知识集合/标签/关联 | 确认、置信度、重要性、有效期、固定/停用、修订历史、自动提取来源 |
| Agent 使用 | 按任务检索、排序、预算、引用 | 按记忆策略注入；可协同进入 Context，但不混淆领域模型 |

落地事实：

- `KnowledgeView` 的 `MEMORY` 页签已移除；`?kind=MEMORY` 回落为知识资料页。
- `MemoryView` 保留独立入口，并补了测试所需的 `memory-row`、`memory-edit`、`memory-form-text`、`memory-form-save` testid。
- 没有删除 Memory 数据，没有把 Memory 合并进 Knowledge 表。

### 1.2 知识库信息架构

页面结构：

1. 页头：标题、导入、新建、整理候选入口。
2. 轻量概览：知识总量、资料/决定/规则数量、最近新增/更新、健康提示；无真实数据不展示对应统计。
3. 常驻搜索：标题/正文/标签/集合/来源/项目等可检索字段。
4. 分类导航：`全部 / 资料 / 决定 / 规则`。
5. 范围与筛选：工作空间共享 / 当前项目 / 全部，状态、集合、标签、排序。
6. 知识列表：服务端分页、摘要、类型、范围、标签、来源、更新时间、版本。
7. 详情阅读器：Markdown 安全渲染、目录、纯文本、来源、历史版本、版本切换、关联、集合/标签。
8. 弹窗：导入、集合/标签管理、关系维护。

### 1.3 新增/修改的数据模型

迁移 `apps/api/migrations/0167_knowledge_organization.sql`：

- `knowledge_items` 新增：
  - `summary`
  - `search_title_tokens`
  - `search_body_tokens`
- 新增表：
  - `knowledge_collections`
  - `knowledge_collection_items`
  - `knowledge_tags`
  - `knowledge_tag_links`
  - `knowledge_relations`
- 关系类型 5 种：`RELATES_TO`、`SUPERSEDES`、`DERIVED_FROM`、`CONSTRAINS`、`REFERENCES`。
- 关系禁止自关联；`target_version bigint` 通过复合外键指向 `knowledge_versions(knowledge_id, version)`，不伪造标题字符串关联。
- 集合采用 workspace 级 + project 级两套命名空间；project 集合不能收纳其他项目知识。

### 1.4 新增/修改的 API

均在 `:workspace_id` scope 内：

- `GET /knowledge/page`
  - `project_id`
  - `scope=ALL|WORKSPACE|PROJECT`
  - `status=ACTIVE|ARCHIVED|ALL`
  - `q`
  - `collection_id`
  - `tag_id`
  - `sort=UPDATED_DESC|CREATED_DESC|TITLE_ASC`
  - `limit=1..50`
  - `cursor`（keyset 游标）
- `GET /knowledge/overview`
- `GET /knowledge/health`
- `GET /knowledge/:id/organization`
- `GET/POST /knowledge-collections`
- `PATCH/DELETE /knowledge-collections/:id`
- `PUT /knowledge/:id/collections`
- `GET/POST /knowledge-tags`
- `PATCH/DELETE /knowledge-tags/:id`
- `PUT /knowledge/:id/tags`
- `POST /knowledge/:id/relations`
- `DELETE /knowledge-relations/:id`
- `POST /knowledge-import/preview`（200，不写库）
- `POST /knowledge-import`（201，命令回执）
- `POST /knowledge/reindex`

兼容策略：旧 `GET /knowledge` 保留；新增接口为加法变更；命令响应统一 `commandEnvelopeSchema`。

### 1.5 Agent 检索流程

1. 从任务上下文提取工作空间、项目、任务标题/描述、用户显式选择、标签与已有关系。
2. 生成中文双字词元与拉丁词元；去除常见停用噪声，做标题/正文/标签/集合/项目多信号加权。
3. 在仓储层先做权限与作用域过滤：
   - 当前工作空间；
   - 工作空间共享 + 当前项目；
   - 跨项目私有知识不得进入候选；
   - 归档/停用/失效版本不召回。
4. 按综合分排序，不按最近更新时间单一排序。
5. 进入 Context 前做预算：显式指定优先、高相关优先、单条截断/分块、相同内容去重。
6. 上下文保留知识 ID、版本 ID、来源；无法可靠记录 Agent 使用次数时不展示虚构次数。

关键代码：

- `apps/api/src/shared/search-tokens.ts`
- `apps/api/src/application/knowledge-model.ts`
- `apps/api/src/information/knowledge-repository.ts`
- `apps/api/src/application/knowledge-queries.ts`
- `apps/api/src/application/knowledge-retrieval.ts`
- `apps/api/src/application/knowledge-import.ts`
- `apps/api/src/application/knowledge-commands.ts`
- `apps/api/src/api/knowledge-api.ts`
- `apps/api/src/application/context-builder.ts`
- `apps/api/src/application/assist-context-policy.ts`
- `apps/api/src/application/assist-source-content.ts`

前端：

- `apps/workbench/src/views/KnowledgeView.tsx`
- `apps/workbench/src/views/KnowledgeView.css`
- `apps/workbench/src/components/KnowledgeReader.tsx`
- `apps/workbench/src/components/KnowledgeImportPanel.tsx`
- `apps/workbench/src/components/KnowledgeOrganizationPanel.tsx`
- `apps/workbench/src/components/KnowledgeFilters.tsx`
- `apps/workbench/src/components/KnowledgeKindTabs.tsx`
- `apps/workbench/src/api/dtos/knowledge.ts`
- `apps/workbench/src/api/parse/knowledge.ts`
- `apps/workbench/src/api/resources/knowledge.ts`
- `apps/workbench/src/api/relayClient.ts`

---

## 2. 功能完成情况

状态说明：`已完成` = 代码 + 定向验证；`部分完成` = 有真实实现但边界/验证未闭合；`未完成` = 未落地；`受阻` = 环境阻塞。

| 功能 | 原有状态 | 本次改造 | 最终状态 | 对应代码 | 对应测试 |
|---|---|---|---|---|---|
| Knowledge/Memory 入口解耦 | Knowledge 页含 MEMORY 页签 | 移除页签；Memory 独立；旧 query 回落 | 已完成 | `KnowledgeView.tsx`、`MemoryView.tsx`、路由/导航 | `knowledgeTypedErrorPending.spec.tsx`、知识页测试 |
| 工作空间/项目范围语义 | 查询 `project_id IS NULL OR = 当前`，提示文字不一致 | `ALL/WORKSPACE/PROJECT` 明确定义；UI 标注共享/当前项目 | 已完成 | `information-repository.ts`、`knowledge-repository.ts`、`KnowledgeView.tsx` | `knowledge-organization`、`knowledge.spec` 范围断言 |
| 概览统计 | 无 | 真实数据库聚合计数量、最近新增/更新、健康摘要 | 已完成 | `knowledge-queries.ts`、`KnowledgeView.tsx` | `knowledge.spec`、视觉截图 |
| 常驻搜索 | `details` 折叠/弱入口 | 常驻输入、清空、分页、匹配字段、摘要 | 部分完成 | `KnowledgeView.tsx`、`knowledge-queries.ts` | `knowledge.spec`、中文搜索测试 |
| 中文关键词检索 | PostgreSQL `ILIKE` | 双字词元 + 多信号排序 + 索引 | 已完成 | `search-tokens.ts`、`knowledge-repository.ts` | `knowledge-agent-retrieval`、性能测试 |
| 搜索高亮 | 无 | 摘要与命中字段已有，正文高亮未完整实现 | 部分完成 | `KnowledgeView.tsx` | `knowledge.spec` |
| 类型/状态/集合/标签筛选 | 仅类型 | 服务端过滤、前端 chips、可清空 | 已完成 | `KnowledgeFilters.tsx`、`knowledge-queries.ts` | `knowledge.spec` |
| 服务端游标分页 | 一次性读取 | keyset、稳定排序、加载更多、分页恢复 | 已完成 | `knowledge-repository.ts`、`KnowledgeView.tsx` | `knowledgeViewPaginationRecovery.spec.tsx` |
| 知识列表信息密度 | 只显示标题为主 | 摘要、类型、范围、标签、来源、更新时间、版本 | 已完成 | `KnowledgeView.tsx`、`KnowledgeView.css` | `knowledgeCaptureLayout.spec.ts`、视觉截图 |
| 详情阅读器 | 已有 Markdown/目录/版本 | 保留并加宽详情列、加集合/标签/关联/范围 | 已完成 | `KnowledgeReader.tsx` | `knowledgeReading.spec.ts` |
| 知识集合 | 无 | workspace/project 两级集合、成员整体替换、重名拒绝 | 已完成 | `knowledge-model.ts`、`knowledge-commands.ts`、`KnowledgeOrganizationPanel.tsx` | `knowledge-organization.integration.test.ts` 5/5 |
| 标签 | 无 | 多标签、规范化、增删改、筛选、去重 | 已完成 | 同上 | 同上、`knowledge.spec.ts` |
| 知识关联 | 无 | 5 类关系、真实 ID/版本、自关联拒绝、删除 | 已完成 | 同上 | 同上 |
| 文件导入 Markdown/TXT | 仅有候选/网页导入能力 | 选择文件、base64、服务端预览、提交、版本 | 已完成 | `knowledge-import.ts`、`KnowledgeImportPanel.tsx` | `knowledge-import.test.ts` 9/9、集成 4/4 |
| PDF/DOCX/HTML 正文提取 | 无或能力不明 | 真实解析正文，扫描 PDF 明确 `NO_TEXT` | 已完成 | `knowledge-import.ts` | 导入单测/集成 |
| 批量导入 | 无 | 多选 ≤20 个、单个 ≤10MB，逐文件设置 | 部分完成 | `KnowledgeImportPanel.tsx` | 组件测试；真实多文件未全验 |
| 文件夹批量导入/网页 URL | 无 | 未实现 | 未完成 | — | — |
| 重复检测 | 无 | SHA-256 内容哈希、来源重复；SKIP/NEW_VERSION/独立收录 | 部分完成 | `knowledge-import.ts` | 导入单测/集成 |
| 标题相似提示 | 无 | 未实现 | 未完成 | — | — |
| 导入预览不写库 | 无 | preview 只读校验/提正文，commit 才写 | 已完成 | `knowledge-api.ts`、`KnowledgeImportPanel.tsx` | 导入集成测试 |
| 导入安全 | 仅扩展名信任风险 | MIME/大小/路径/编码/XSS 基本校验 | 部分完成 | `knowledge-import.ts` | 单测；恶意文件矩阵未验 |
| AI 知识候选 | `KnowledgeCurationPanel` 从 ArtifactVersion 生成 | 保留候选/接受/拒绝/来源版本校验 | 已完成（沿用） | `KnowledgeCurationPanel.tsx`、相关命令 | 既有测试 |
| 重复/冲突/过期自动建议 | 无 | 健康接口提供信号；自动 AI 建议未完整落地 | 部分完成 | `knowledge-queries.ts`、`KnowledgeView.tsx` | 健康接口测试/视觉 |
| Agent 检索排序 | 主要标题/ILIKE | 多信号加权、显式指定、项目/标签/状态 | 已完成 | `knowledge-retrieval.ts` | `knowledge-agent-retrieval` 3/3 |
| Context 预算 | 已有预算/压缩机制 | 知识候选截断、去重、显式优先 | 已完成（复用） | `context-builder.ts`、`assist-context-policy.ts` | `context.integration.test.ts` 13/13 |
| 来源与版本引用 | 部分 | 保留 knowledge/version 引用；不伪造使用次数 | 部分完成 | `context-builder.ts`、`KnowledgeView.tsx` | context 集成 |
| Agent 使用记录 | 无可靠记录 | 只显示空态/真实记录，不展示推测次数 | 部分完成 | `knowledge-queries.ts`、`KnowledgeOrganizationPanel.tsx` | 组件测试 |
| AI 语义检索/Embedding | 无 | 未引入；按计划待关键词阶段评测后决定 | 未完成（暂缓） | — | — |
| 空状态 | 只有「还没有资料」 | 新建笔记/导入文件/导入网页/创建集合，仅真实入口 | 已完成 | `KnowledgeView.tsx` | `knowledge.spec.ts`、截图 |
| 响应式 | 未知 | 四档视口无横向溢出，列表/阅读器独立宽度 | 部分完成 | `KnowledgeView.css` | Chromium 四档截图 |
| 独立 Agent 验收 | 无 | 未做 | 未完成 | — | — |
| 生产构建 | 未执行 | 本轮尝试，因内存耗尽未取得退出码 | 受阻 | — | — |

---

## 3. 数据库变化

### 3.1 迁移

- `apps/api/migrations/0167_knowledge_organization.sql`

已在真实 PostgreSQL 18.6 隔离库验证：

- 全量执行成功；
- 二次执行 `applied: []`（幂等）；
- 14 项 schema/约束/权限校验通过。

### 3.2 新增表与主要约束

| 表 | 作用 | 关键约束 |
|---|---|---|
| `knowledge_collections` | 知识集合 | `uq_knowledge_collection_workspace_name`、`uq_knowledge_collection_project_name`、`ix_knowledge_collections_scope` |
| `knowledge_collection_items` | 集合成员 | 知识/集合外键，按知识整体替换 |
| `knowledge_tags` | 标签 | 规范化名称，workspace 内去重 |
| `knowledge_tag_links` | 知识-标签 | 多对多，删除知识时清理 |
| `knowledge_relations` | 知识关系 | `fk_knowledge_relation_version`、`fk_knowledge_relation_from/to`、`ck_knowledge_relation_not_self`、`uq_knowledge_relation` |

索引：

- `ix_knowledge_relations_from/to`
- `ix_knowledge_items_list_updated/created/title`
- `ix_knowledge_items_fts`
- `ix_assist_messages_sources_gin`

### 3.3 数据兼容

- 新列可空/有默认，不回写历史正文；旧知识仍可读。
- 旧 `GET /knowledge` 语义保持不变。
- 未删除、未合并 Memory 表；未改 `knowledge_versions` 版本语义。
- 0167 对既有知识做摘要/分词回填，属于派生字段，可重建。

### 3.4 回滚方案

```sql
DROP TABLE IF EXISTS knowledge_relations;
DROP TABLE IF EXISTS knowledge_tag_links;
DROP TABLE IF EXISTS knowledge_tags;
DROP TABLE IF EXISTS knowledge_collection_items;
DROP TABLE IF EXISTS knowledge_collections;
ALTER TABLE knowledge_items
  DROP COLUMN IF EXISTS summary,
  DROP COLUMN IF EXISTS search_title_tokens,
  DROP COLUMN IF EXISTS search_body_tokens;
```

说明：回滚会丢失知识组织数据（集合/标签/关系），但不会丢失知识正文与版本；派生搜索列可重建。未在非空历史库上单独演练 0167 回填，是残余风险。

---

## 4. UI 变化

### 4.1 页面结构

- 双栏：左侧知识列表，右侧详情阅读器；不再使用大卡片网格作为默认布局。
- 顶部轻量概览，不占列表主要空间；不堆统计卡片。
- 搜索常驻；类型页签 + 范围/集合/标签/状态/排序筛选。
- 空态提供真实入口：新建笔记、导入文件、创建知识集合；未实现的入口不显示。

### 4.2 导航

- 知识库只保留 `全部 / 资料 / 决定 / 规则`。
- MEMORY 从知识库导航移除，独立 `/memory` 保留。
- 详情范围文案改为「当前项目（同时可见工作空间共享知识）」/「工作空间共享」，不再显示原始 UUID。

### 4.3 列表与阅读器

- 列表：标题、摘要、类型、范围、标签、来源、更新时间、版本；服务端分页「加载更多」。
- 阅读器：保留 Markdown 安全渲染、目录、纯文本、来源、历史版本、版本切换；正文最大阅读宽度受控，列表列更宽。
- 详情新增：集合、标签、关联、来源与版本、Agent 使用记录（仅真实记录，空态不造次数）。

### 4.4 导入体验

- 多文件选择 → 客户端读取 → 服务端预览 → 逐文件标题/标签/集合/重复策略 → 提交 → 回执校验。
- `REJECTED` 文件不出现提交按钮；扫描 PDF 明确提示无 OCR/无法提正文，不伪装成功。
- 导入弹窗与组织弹窗在 1440×900 下截图验证。

### 4.5 不同分辨率实测

| 视口 | 页面横向溢出 | 列表宽度 | 阅读器宽度 |
|---|---|---|---|
| 1280×800 | 0 | 约 927.2px | 约 925.2px |
| 1440×900 | 0 | 约 1061.6px | 约 1059.6px |
| 1660×895 | 0 | 约 1160px | 约 1158px |
| 1920×1080 | 0 | 约 1160px | 约 1158px |

`documentElement.scrollWidth === clientWidth`；截图 22 张，位于：

`docs/testing/evidence/knowledge-acceptance-2026-11-15/`

（4 档各 5 张：overview/search/detail/decision/rule；1440 另加 import-dialog、organize-dialog。）

### 4.6 UI 规范

`node scripts/check-ui-conventions.mjs` 通过：

- 裸色值 0（基线 0）
- px 字号 22（基线 32）
- 组件层文件 19
- 开发路由隔离通过

新增样式均使用既有 token；筛选条/类型页签抽成共享组件，未另起 CSS 体系。

---

## 5. Agent 能力变化

### 5.1 知识如何被发现

- 用户显式选择的知识；
- 任务标题/描述/目标；
- 当前工作空间、当前项目；
- 标签、集合、已有知识关联；
- 关键词检索（中文双字、拉丁词）；
- 语义相似度未启用。

### 5.2 如何排序

综合信号：

- 显式指定；
- 标题匹配；
- 正文匹配；
- 标签匹配；
- 项目关联；
- 知识有效状态/版本有效性；
- 关键词相关性。

不是单纯按更新时间排序；最近创建的无关知识不会压过高相关技术规范。

### 5.3 如何进入 Context

- 先过滤权限/作用域/归档状态；
- 再截断候选、按预算选择；
- 显式知识优先；
- 单条知识限制长度，长文可分块；
- 去重，避免同内容重复注入；
- 保留 knowledge ID、version ID、来源。

### 5.4 如何追溯来源

- Context 来源引用保留知识 ID + 版本 ID；
- 阅读器显示来源与当前版本；
- Agent 使用记录只在有可靠记录时展示；无记录显示空态，不展示虚构次数。

### 5.5 如何防权限泄露

- 仓储层在查询阶段过滤工作空间/项目；
- 组织读取要求 `requireKnowledgeRoot`，跨工作空间返回 404；
- 归档/停用/失效知识不进入候选；
- 不允许“阅读权限”自动扩大为“Agent 注入权限”；
- 现有来源访问权限仍优先。

### 5.6 Agent 场景测试结果

`apps/api/test/integration/knowledge-agent-retrieval.integration.test.ts` 3/3：

- 能找到项目技术架构文档；
- 能使用工作空间共享规范；
- 其他项目私有知识不进入候选；
- 已归档知识不召回；
- 低相关查询返回空；
- 同名知识产生新版本后，检索只返回当前版本。

未覆盖：完整 Agent 输出引用展示、Memory 不被当作 Knowledge 的端到端断言、低相关 Context 体积上限的量化断言。

---

## 6. 测试结果

### 6.1 构建与类型检查

| 检查 | 结果 | 说明 |
|---|---|---|
| `apps/api npx tsc -p tsconfig.json` | 最后一次成功 exit 0 | 代码完成后通过；本轮末次复跑因本机内存耗尽未取得退出码 |
| `apps/workbench npx tsc --noEmit -p tsconfig.json` | 最后一次成功 exit 0 | 同上 |
| `apps/workbench vite build` | 未完成/受阻 | 本轮未取得生产构建退出码；视觉验收使用 Vite dev server |
| UI 一致性 | 通过 | 裸色值 0、px 字号 22/32 |
| 文档检查 | 失败（既有） | 25 个既有缺失历史证据链接；本轮新增链接未报错 |
| 功能地图 | 失败（既有） | 本轮 5 条知识验收关联已能解析；剩 14 条既有失效关联（任务/项目/短事务等） |

### 6.2 后端单元测试

- `knowledge-model.test.ts` 8/8
- `knowledge-import.test.ts` 9/9
- 合计 17/17

### 6.3 真实 PostgreSQL / HTTP 集成测试

| 套件 | 结果 |
|---|---|
| `knowledge-organization.integration.test.ts` | 5/5 |
| `knowledge-import.integration.test.ts` | 4/4 |
| `knowledge-agent-retrieval.integration.test.ts` | 3/3 |
| `knowledge-performance.integration.test.ts` | 1/1 |
| `context.integration.test.ts` | 13/13 |

迁移验证：`0167` 在真实 PG 18.6 隔离库全量成功、二次 `applied: []`、14/14 校验通过。

### 6.4 前端定向测试

| 套件 | 结果 |
|---|---|
| 知识相关 10 文件联合 | 10/10 文件，61/61 用例 |
| `knowledge.spec.ts` | 18/18 |
| `knowledgeReading.spec.ts` | 9/9 |
| `knowledgeViewPaginationRecovery.spec.tsx` | 6/6 |
| `informationRestore.spec.ts` | 10/10 |
| `uiRemediation20260928.spec.ts` | 2/2 |
| `knowledgeTypedErrorPending.spec.tsx` | 3/3 |
| `knowledgeCaptureLayout.spec.ts` | 已修复并通过 |
| `knowledgeSimplify.spec.ts` | 已修复并通过 |

### 6.5 全量 Workbench Vitest

最近一次完整结果：

- 259 文件：238 通过 / 21 失败
- 2652 用例：2542 通过 / 110 失败

之后一次全量因系统可用内存约 3.6GB/16GB 触发 `Fatal process out of memory: Zone`，未完成。

失败集中于并行改动域（`useSendRiskGate`、`assistantModeSwitch`、`folderFirstConversation`、`scenarioLabMatrix`、`saveMemory` 等）；知识相关文件单独复跑全绿。**不能宣称全量通过。**

### 6.6 性能测试（真实 PG，独立临时库）

| 知识条数 | page | search | overview | retrieve |
|---|---:|---:|---:|---:|
| 100 | 56.6ms | 15.1ms | 18.3ms | 34.3ms |
| 1000 | 15.2ms | 35.1ms | 23.5ms | 19.7ms |
| 10000 | 74.2ms | 282.0ms | 219.2ms | 209.9ms |

批量插入在单一事务内先 root 后 version，解决 `fk_knowledge_current_version` 延迟外键在单语句插入时立即检查的问题。

### 6.7 视觉验收

真实 API + Vite + 真实 Chromium，独立数据库 `relay_visual_knowledge`：

- 写入 3 条知识、1 条决定、1 条规则、2 个集合、3 个标签；
- 四种视口截图，页面无横向溢出；
- 发现并修复详情「来源与版本」显示原始 UUID → 显示「当前项目/工作空间共享」；
- 导入弹窗、组织管理弹窗在 1440×900 下截图。

未逐项做长标题、超长正文、极窄窗、弹窗视口溢出与滚动容器冲突矩阵。

---

## 7. 遗留问题

### 7.1 未实现/受限能力

1. **语义检索/Embedding 未引入**：按计划先完成关键词阶段；引入前需分块、chunk 版本关联、权限过滤、旧版本失效、评测集。
2. **文件夹批量导入、网页 URL 抓取未实现**：当前只支持多文件（≤20）逐一导入。
3. **OCR 不支持**：扫描型 PDF 返回 `NO_TEXT`，明确提示无正文，不伪装成功。
4. **原始文件不持久化**：只保存提取正文 + 来源元数据；需要原文件审计时后续应补存储。
5. **标题相似重复提示未实现**：目前只有内容哈希/来源重复。
6. **正文搜索高亮未完整实现**：有摘要与命中字段。
7. **AI 重复/冲突/过期建议未完整自动化**：健康接口提供信号，候选仍需人工确认；AI 不能自动转正式知识。
8. **Agent 使用记录无完整账本**：仅展示真实记录或空态，不展示推测次数。
9. **关系类型 5 种**是否覆盖全部业务仍待产品确认。
10. **项目集合跨项目共享**未开放：当前是 workspace 级 + project 级两套命名空间。

### 7.2 已知 Bug / 测试问题

- 全量 Workbench Vitest 110 例失败，未逐条归因；知识相关文件全绿。
- `proto-visual-mocks.spec.ts` 仍保留旧 `kind:"MEMORY"` fixture，未按新页面 API 改造。
- `docs/testing/overall-acceptance-2026-09-28.md` 第 110 行原有「首条消息」行缺一列，已做最小补列；`feature-map --check` 仍有 14 条既有失效验收关联。
- `check-docs.mjs` 25 个错误均为既有缺失历史证据文件（`apps/workbench/artifacts/*`、`output/acceptance-raw/*`）。
- 0167 未在非空历史库演练回填；隔离库迁移前为空。

### 7.3 性能风险

- 10000 条时 search 282ms、overview 219ms；仍在阈值内，但 `ILIKE`/倒排混合检索对更长正文的增长曲线未测。
- 全量 jsdom 套件在本机低内存下容易 OOM，需降 worker 或增加内存。
- 知识列表服务端分页已解决一次性加载，但概览聚合在大库上的索引覆盖仍需持续观察。

### 7.4 架构限制

- 未引入独立向量库，优先评估 PostgreSQL 现有能力。
- 旧 `GET /knowledge` 保持旧语义，新页面用 `/knowledge/page`，存在两套读口但未破坏调用方。
- 知识组织表是加法模型，不替代版本/来源/权限体系。
- AI 候选不能自动成为正式知识，不能自动覆盖已有知识。

### 7.5 后续建议

1. 先建立中文搜索评测集，再决定是否引入 Embedding。
2. 补文件夹导入与网页 URL 抓取，复用现有 `WebImportPanel`/来源基础设施。
3. 补 Agent 使用记录账本（知识 ID + 版本 ID + 任务/回答 ID），再做真实引用展示。
4. 在非空历史库演练 0167 回填与回滚。
5. 修复全量测试中与知识链路无关的并行失败，或明确基线。
6. 在真实 Windows/WebView2 上做多 DPI、长文、极窄窗验收。

---

## 8. 主要修复记录

- 命令响应 schema 统一 `commandEnvelopeSchema`：修复 `POST /knowledge-collections` 500。
- `replaceCollectionItems` 参数/语义修正：按 knowledge_id 删除、从集合表选 collection_id 插入。
- 列表 SQL 补 `WHERE true`：避免 cursor 请求 501/42601。
- `listRelations`/`usageRecords` 改 snake_case：对齐 API/前端。
- `ImportKnowledge` 加入 `CREATED_COMMAND_TYPES`：提交返回 201。
- `retrieveKnowledge` 移除 CTE `q`：修复 PostgreSQL `42P01`，改用 `tokenArray` + `unnest`。
- `readKnowledgeOrganization` 增加 `requireKnowledgeRoot`：跨工作空间 404。
- 详情范围从 UUID 改为人类可读范围。
- `knowledgeCaptureLayout`、`knowledgeSimplify` 失败修复；`knowledgeTypedErrorPending` 的 MEMORY 用例迁移到独立 `/memory`。
- 并行工作树事故：补回 `project-repository.ts` 丢失的 `insertProjectState` 方法签名，保留他人新增方法，未回退并行改动。

---

## 9. 证据索引

- 迁移：`apps/api/migrations/0167_knowledge_organization.sql`
- 集成测试：`apps/api/test/integration/knowledge-*.integration.test.ts`、`context.integration.test.ts`
- 前端测试：`apps/workbench/tests/knowledge*.spec.*`、`informationRestore.spec.ts`、`uiRemediation20260928.spec.ts`
- 截图：`docs/testing/evidence/knowledge-acceptance-2026-11-15/`
- 架构文档：`docs/architecture/information-planning.md` §1.5
- 前端文档：`docs/frontend/workbench-design/part-03.md` §12、§12.5、§13.3
- 测试计划：`docs/testing/verification-plan/part-02.md` §12.1
- 功能地图：`docs/feature-map/catalog.json`
- 验收表：`docs/testing/overall-acceptance-2026-09-28.md`

---

## 10. 最终判断

**知识库的核心闭环已经落地：知识进入 → 版本 → 组织（集合/标签/关联）→ 检索 → 阅读 → 来源追溯 → Agent 上下文使用。**

但以下事实不能写成「已全部完成」：

- 生产构建未取得最终退出码；
- 全量 Workbench 测试未通过，失败未全部归因；
- 语义检索、文件夹/网页导入、OCR、AI 自动治理、Agent 使用账本未完成；
- 未做独立验收、未 commit/push、未做真实 Windows/WebView2。

因此本轮结论为 **PARTIAL（实施者自检）**，不是最终生产验收通过。
