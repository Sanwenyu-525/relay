# 输入框粘贴图片与消息附件全链路实施计划

> **For agentic workers:** 按任务序列逐项实施，每步先跑该步检查再进下一步。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** Assist 输入框支持 `Ctrl+V` 粘贴图片与拖拽图片文件，随消息发送，当前消息的图片以多模态 content parts 交给模型；其余文件类型明确拒绝并说明边界。

**Architecture:** 两阶段附件链路：新增暂存上传端点（PG `bytea`）→ 消息命令携带 `attachment_ids`（幂等命令不变）；会话组装时仅当前消息附件转为多模态 parts，历史消息附件降级为文本占位；模型目录 `capabilities` 增 `image_input` 闸门，未知/不具备一律拒绝，不冒充可用。

**Tech Stack:** Fastify 5.12.5（路由级 `bodyLimit`，零新依赖）、TypeScript 5.9、PostgreSQL（迁移 `0093`）、React 19、vitest（jsdom）+ Playwright（chromium）。

**Status:** 2026-10-16 用户按推荐决策开工（D1–D4 采纳）。**后端 T1–T4 源码已完成**（迁移 0093、上传端点、消息命令 attachment_ids、能力闸门、多模态组装），受影响单测 58/58 通过、`tsc --noEmit` 通过；**各步新增单测与 T5–T8 未做**（前端为并行实例热文件，按用户决定待热文件安静后接线）。文档同步见 HTTP §10.85 / 数据库 §91 / 工作台 §33 / 验收表 / CODEX_NEXT_STEP。

## 已定决策（含理由）

1. **附件持久化用 PG `bytea`（新表），不扩 ManagedContentStore 文件存储。**
   附件与消息同生命周期、需与消息同短事务提交（契约 04 的提交纪律）；`bytea` 没有「写了文件没写库」的中间态，也无孤儿文件。受管存储的不可变版本目录、防篡改核对是给 artifact（业务产物）的语义，附件是会话输入快照，不套用。单用户本机、有体积上限，DB 体量可控。代价：附件大时 DB 膨胀——由上限约束。
2. **传输先传后引，消息命令体保持小。**
   `POST /assist-sessions/:id/message-attachments` 收 JSON `{name, media_type, data_base64}`，路由级 `bodyLimit` 放宽到 4 MiB（Fastify 5 支持路由级覆盖，不影响其他端点；不引入 `@fastify/multipart`）。返回 `{attachment_id, byte_length, content_hash}`。消息命令只带 `attachment_ids`，`payload hash` 覆盖 ids（不含大字节），重放语义与既有命令一致。
3. **V1 媒体类型仅 `image/png`、`image/jpeg`、`image/gif`、`image/webp`。**
   理由：目录模型 `input_modalities` 的 image 是常见能力，PDF/文档输入在免费模型中极少支持。其他类型在上传端点明确拒绝，错误信息说明「当前版本仅支持图片」。文本类文件与更多格式留后续按需扩展。
4. **上限：每消息 ≤4 张、单张原始字节 ≤2 MiB、每消息总量 ≤6 MiB。**
   服务端为唯一准绳；前端用同值预检（两份常量，测试锁定一致）。
5. **多模态组装只带当前消息附件；历史消息附件降级为文本占位 `[图片：<name>]`。**
   免费模型上下文小，历史图片逐条回放成本高；是否回放最近 N 条留后续（D3）。
6. **模型能力闸门。**
   `parseCapabilities` 增 `image_input`（`architecture.input_modalities` 含 `'image'`，三态：true/false/null）。消息命令执行时读会话模型选择 → 目录快照：带附件且 `image_input !== true` → `validationFailed` 拒绝（unknown 不冒充可用）。前端发送前读既有 `GET /assist-sessions/:id/model-selection` 预检并提示。
7. **隔离与定位。**
   附件行带 `workspace_id` + `session_id`；绑定与读取均校验归属，跨会话/跨 workspace 引用按 `RESOURCE_NOT_FOUND`。上传端点定位为**暂存**而非幂等命令（不改变业务状态，返回简单 JSON）；消息命令仍是幂等命令。上传后未发送的附件行成为未引用行，V1 不自动清理，仅随会话查询可见性留接口。

## Global Constraints

- 工作树内有 272 个未提交文件，目标热文件（`assist-api.ts`、`assist-commands`、`AssistView.tsx`、`ChatCommandInput.tsx`、`relayClient.ts` 等）均在其中：**只做外科式叠加编辑**；只 `git add` 本计划点名的文件，不得 `git add -A`、不得 `git checkout`/`stash` 他人改动。
- **无附件路径逐字不变**：既有消息命令的载荷、payload hash、重放、`turns` 形状不得因本计划改变。
- 附件不进入 `source_refs` 资料体系、不授予任何读取/执行权限；资料版本上限 10 的规则不受影响。
- 粘贴**纯文本**行为不变（照常进正文，不弹附件 chip）。
- 视觉一律引用现有 token（`--relay-*` / design-tokens.json），不新增色值、字号、圆角、间距；chip 参照既有资料 chip 的层级。
- 中文注释与文档；代码标识符与 commit message 英文。不 commit/push，除非用户指示。
- 测试命令：`apps/api`、`apps/workbench` 目录下 `pnpm exec vitest run <file>`；浏览器 `pnpm exec playwright test <file>`；类型 `pnpm run typecheck`（两包各跑）；文档检查仓库根 `node scripts/check-docs.mjs`。真实 PG 集成测试按项目规则**空载 `-TestFile` 单跑**，不与并行实例并发。
- 文档落点：协议归 HTTP 契约新增节；物理归数据库设计新增节；交互归工作台设计新增节；成绩归功能验收表新行；完成后 CODEX_NEXT_STEP 增条目。

## 任务序列

### T1 数据层：迁移 0093 + schema + 仓库
- [x] `apps/api/migrations/0093_assist_message_attachments.sql`：建表 `assist_message_attachments`（`id uuid pk`、`workspace_id`、`session_id` fk `assist_sessions`、`message_id` 可空 fk `assist_messages`、`name`、`media_type`、`byte_length int`、`content_hash bytea`、`content bytea`、`created_at`；CHECK 约束钉死媒体类型白名单与 `byte_length ≤ 2 MiB`；只授 `SELECT/INSERT/UPDATE` 不给 `DELETE`）。
- [x] `database-schema.ts` 增行类型与表映射。
- [x] `assist-repository.ts` 增附件五方法（insertAttachment / readAttachment / bindAttachments / listAttachmentsByMessage / listAttachmentsByMessages），全部带 workspace+session 隔离。
- [x] 数据库设计文档新增 §91（表结构、约束、与 artifact 受管存储的边界说明）。

### T2 上传端点
- [x] `assist-api.ts` 新增 `POST /assist-sessions/:id/message-attachments`，路由级 `bodyLimit: 4 MiB`；校验：会话存在且 ACTIVE、类型白名单、base64 解码后 ≤2 MiB、`name` 非空 ≤200 字符；落库返回 `{attachment_id, byte_length, content_hash}`。
- [ ] 单测：类型/大小/名称/归档会话/跨 workspace 拒绝；成功路径落库与回执形状。

### T3 消息命令扩展
- [x] `assist-commands.ts` `requestAssistMessage` 增可选 `attachment_ids`（≤4）：归属校验（同 workspace+session、未绑定他消息）、事务内 `bindAttachments` 落 `message_id`；`attachment_ids` 进 payload hash。
- [x] 重放语义：ids 进 payload hash，原回执重放不重复执行；附件行不可变（仓库层绑定入口唯一）。
- [x] `assist-api.ts` 接线请求体校验（TypeBox schema + 用例复检）。
- [ ] 单测：绑定、越权引用拒绝、重放幂等、无附件路径 payload 逐字不变。
- [x] HTTP 契约新增 §10.85。

### T4 能力闸门与多模态组装
- [x] `model-catalog-pricing.ts` `parseCapabilities` 增 `image_input`（三态）。
- [x] 消息命令执行时：带附件 → 按 `RELAY_MODEL_NAME` 查目录条目（聊天恒走默认连接；C-2b 接线后改读冻结快照），`image_input !== true` 或无条目 → 422 拒绝（明确文案）。
- [x] `AssistTurn` 增可选 `parts`（`AssistContentPart`）；`buildGenerationInput`：当前消息有已绑定附件 → 末条 user turn 用 parts（图片在前、正文收尾）；历史消息附件 → 文本占位。
- [x] `openai-compatible-model-port.ts`：turns → `HumanMessage` 支持内容数组（LangChain 1.2 标准块 `{type:'image', source_type:'base64', data, mimeType}`）；无 parts 路径仍是 string、请求逐字不变。
- [ ] 单测：Fake port 捕获请求形状（parts 正确转换）、闸门拒绝（false/null）、历史占位、无附件回归。

### T5 前端粘贴/拖拽捕获
- [ ] `ChatCommandInput.tsx` 增可选 `onPasteAttachments` / `onDropAttachments`（`DataTransfer` 机械提取抽为纯函数模块，可测）；拖拽悬停高亮（现有 token）。
- [ ] 单测：剪贴板图片、多文件、图片+文件混合、纯文本不触发、拖拽提取。

### T6 前端附件状态与发送链路
- [ ] `AssistView.tsx` 首条与会话两处 composer 的附件状态（与 draft 同 Owner）：chip 列表（缩略图 `URL.createObjectURL`、名称、大小、移除）、上传中/失败/重试、前端预检（类型/大小/数量/总量）。
- [ ] 发送：附件串行上传拿 ids → 带入消息命令；失败保留附件与明确错误；能力预检（`model-selection` 读到 `image_input` 非 true 时提示并阻止）。
- [ ] 草稿守卫：未发送附件计入未保存保护（与 sources/skillInput 同列）；重挂载后附件丢失属已知限制，UI 明示。
- [ ] 单测：chip 渲染/移除、预检拒绝、上传失败保留、守卫覆盖附件。

### T7 浏览器规格
- [ ] 真实 `paste` 事件（`dispatchEvent` + `DataTransfer`）→ chip → mock API 捕获请求体含 `attachment_ids`；drop 高亮；发送后 chip 清空。
- [ ] 既有浏览器回归不红（并发抖动按设计系统 §9.11 惯例记录，不算本片失败）。

### T8 集成与收尾
- [ ] 真实 PG 集成测试（落库/绑定/重放/隔离/闸门/CHECK 约束 `expectSqlState('23514')`），空载 `-TestFile` 单跑。
- [ ] `apps/api` + `apps/workbench` 全量 `tsc --noEmit`；`check-docs.mjs`。
- [ ] 工作台设计新增交互节（粘贴/拖拽/chip/错误与边界）、功能验收表新行、CODEX_NEXT_STEP 条目。

## 待确认项

- **D1 附件存 `bytea`**（推荐，见决策 1）；如倾向复用受管存储需改 T1。
- **D2 V1 仅图片**（推荐）；文本/PDF 类文件后续扩展。
- **D3 历史图片回放策略**（推荐仅当前消息；可改为回放最近 N 条带图消息）。
- **D4 上限值**（推荐 4 张 / 2 MiB / 6 MiB）。
- **D5 并行实例状态**：`AssistView.tsx` 2026-10-16 21:59 有未提交修改（树内共 272 个未提交文件）；需确认无并行实例正在编辑 composer/assist 热文件后开工，避免抢改。

## Review Focus

- 无附件的既有消息行为**逐字不变**（载荷、hash、重放、turns）。
- 附件不进资料体系、不授权限；跨会话/跨 workspace 引用一律拒绝。
- 纯文本粘贴行为不变。
- 能力闸门 `image_input` 为 `null`（未知）时拒绝，不冒充可用。
- 上传端点不得绕过会话准入（归档/只读会话拒绝）。
