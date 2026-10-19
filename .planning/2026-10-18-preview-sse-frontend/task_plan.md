# 任务计划：前端接入「生成中预览」SSE 推送 + 补齐契约与端到端测试

创建时间：2026-10-18
状态：待执行（用户要求「先出计划，之后执行」）

## 0. 现状核实（已做，附证据）

后端流式端点**已经完整实现，且全部处于未提交状态**（另一条并行会话的工作）：

- `apps/api/src/api/preview-events-api.ts`（未追踪新文件，??）：泛型 `sendPreviewStream`（200ms 检测轮询 `DETECT_POLL_MS`、15s 心跳、每帧完整重授权读取、终态关流、背压复用 `writeRunEventFrame`），以及 `sendRunDraftPreviewStream`(:173) / `sendAssistLivePreviewStream`(:188)、`writePreviewFrame`、probe key 函数。
- 指纹函数已落到仓库：`run-repository.ts:245 readDraftPreviewFingerprint`、`assist-repository.ts:291 readLivePreviewFinger`（均为 M）。
- 路由已注册：`run-api.ts:157` → `GET /runs/:run_id/draft-preview/events`；`assist-api.ts:535` → `GET /assist-sessions/:id/messages/:message_id/live-preview/events`（均为 M）。
- 单测已存在：`apps/api/test/unit/preview-events-api.test.ts`（??）。

缺口（真正要做的）：

1. **前端未接线**：`apps/workbench/src/**` 中无任何 `draft-preview/events` / `live-preview/events` 引用；`relayClient.ts:755 getRunDraftPreview`、`:547 getAssistLivePreview` 仍是 GET 轮询；`useRunDraftPreview.ts` 每 400ms 轮询；`AssistView.tsx:2621-2663` 每 400ms 轮询预览。
2. **契约 §10.59 正文缺失**：代码中已引用 `§10.59`（`run-api.ts:156`、`preview-events-api.ts:14`），但 `docs/api/http-command-contract.md` 无此章节。
3. **端到端集成测试缺失**：仅有 unit 单测，未覆盖「真实 Worker 生成 → SSE 推送逐帧」的链路。

### ⚠️ 并行会话协调风险（最高优先级前置条件）

`git status` 显示以下文件均已处于**未提交修改（M）**，与本计划要改的文件高度重叠（记忆块已预警 `AssistView.tsx` 等同批文件常被并行改）：

- `apps/workbench/src/api/relayClient.ts` (M)
- `apps/workbench/src/views/AssistView.tsx` (M)
- `docs/api/http-command-contract.md` (M)
- `apps/api/src/api/run-api.ts` (M)、`assist-api.ts` (M)、`run-repository.ts` (M)、`assist-repository.ts` (M)

执行前**必须**先 `git diff` 这三个前端/文档文件，确认本次要新增的内容不与并行改动冲突；若并行会话也在接 streaming，优先复用或合并，绝不互相覆盖。

---

## 1. 范围与必须守住的不变式

- 预览文本每帧都来自一次**完整重新授权读取**（服务端已实现；前端只消费，不信任缓存）。
- 断线重连：预览 SSE **不支持 `after` / `Last-Event-ID`**，连接建立即推当前完整快照；前端重连 = 重读当前状态（去重按 identity + `preview_revision`，不做连续性断言）。
- 终态（Run 三终态 / Assist 消息非 PENDING|RUNNING）后服务端关流；前端须优雅降级到权威 GET（现有 `useRunDraftPreview` 的 `onSettled` 已处理终态）。
- 流不可用（网络/反代）须降级回既有轮询，界面如实说明（沿用 `useRunToolCalls.ts:102` 的 catch 注释口径）。

---

## 2. 执行步骤（分阶段，可灰度）

### 阶段 A — 前端 SSE 读取层（新增，不触碰既有 GET）

1. **新增 `apps/workbench/src/api/resources/previewStream.ts`**：
   - 通用解析器 `readJsonSseStream(body, signal, onFrame)`：解析 `id`/`event`/`data`，跳过 `:` 注释，带 `runEvents.ts` 同款行长度上限与 UTF-8 fatal 解码。
   - `readRunDraftPreviewStream(http, runId, signal, onPreview, onOpen)` → `GET /runs/:run_id/draft-preview/events`，`Accept: text/event-stream`，接收 `event: draft_preview` 完整 DTO。
   - `readAssistLivePreviewStream(http, sessionId, messageId, signal, onPreview, onOpen)` → `GET /assist-sessions/:id/messages/:message_id/live-preview/events`，`event: assist_preview`。
2. **`relayClient.ts`（紧跟 `readRunEvents` :796）** 新增两个薄封装 `readRunDraftPreviewStream` / `readAssistLivePreviewStream`（⚠️ 该文件正被并行会话修改，先 diff）。

   借鉴上游说明：本仓既有 `readRunEvents` / `useRunToolCalls.ts:97-108` 的 SSE 订阅循环（连接断开 → 1s 退避 → 重建）就是规范模式，直接复用其结构；上游 `codex`/`pi` 的 SSE 客户端（`fetch` + `ReadableStream` 解析）与其一致，无需另起炉灶。上游仓库（见 `docs/research/upstream-lock.json`：codex、deepseek-harness、pi、langchain、langgraph、rig）本机未检出，仅 lock 文件，故以本仓既定模式为准。

### 阶段 B — 两个消费点切换为流式（含降级）

3. **`useRunDraftPreview.ts`**：把 400ms 轮询改为「订阅 SSE；`onPreview` 复用现有 identity + `preview_revision` 去重逻辑（`BigInt(next.previewRevision) >= BigInt(previewRef.current.previewRevision)`）；`onClose`/异常 → 降级回 `getRunDraftPreview` 轮询」。保留 `onSettled` 终态回调。RunView 调用点 `RunView.tsx:109` 无需改。
4. **`AssistView.tsx:2621-2663`**（`previewIds` 的 useEffect）：内部 `getAssistLivePreview` 轮询换成 `readAssistLivePreviewStream` 订阅；同一 `messageId` 一流一连；异常降级回轮询。

### 阶段 C — 契约与文档（§10.59，正被并行修改，先协调）

5. 在 `docs/api/http-command-contract.md` 补 **§10.59**：两个 SSE 端点、`draft_preview` / `assist_preview` 事件名、完整 DTO 帧体、每帧重授权、终态关流、无 `after`/`Last-Event-ID` 的快照语义；并注明 §10.38/§10.39 的「短轮询」增加流式可选通道（Breaking Change: No）。⚠️ 该文件已 M，先 diff 再落笔，避免覆盖并行改动。

### 阶段 D — 端到端测试（补齐验证，同时校验后端）

6. **新增 `apps/api/test/integration/preview-events.integration.test.ts`**：复用 `run-events.integration.test.ts` 的 harness（`startTestApi`、worker entry `src/worker/main.js`、`delegatedRun`/`createWorkspace`）。覆盖：
   - Run DRAFT：委托真实 Run → 打开 `/runs/:id/draft-preview/events` → 断言收到 `preview_revision` 递增的 `draft_preview` 帧（含首帧全量快照、终态帧后关流）。
   - Assist DISCUSS：发普通无 Skill 的 DISCUSS → 断言 `assist_preview` 帧。
   - 跨 workspace 404、重连得当前快照（二次连接应推当前完整态）。

### 阶段 E — 验收与手动核对

7. `apps/api` 跑单测 + 集成测试；workbench 跑 `tsc` / build。
8. 可选 Playwright 手动核对：RunView「生成中草稿」面板、Assist 对话预览均渐进渲染；断网/关流后降级正常。

---

## 3. 风险与前置条件

- **并行会话（最高风险）**：`relayClient.ts` / `AssistView.tsx` / `http-command-contract.md` 未提交修改中。执行前 `git diff` 三者，确认无冲突；若并行会话也在接 streaming，优先复用/合并。
- 后端未提交且**仅 unit 单测覆盖**，阶段 D 的集成测试也是对后端的一次端到端校验。
- 上游源码本机未检出，计划以本仓 `readRunEvents` 规范为准。

## 4. 暂不做的（边界）

- 不动后端 `preview-events-api.ts`（已实现）；不动 100ms flush 节流与 16KiB 上限。
- 不做 Worker→API 管道直传 token（撞「预览须重授权、可重连补读」不变式，前轮已否）。
- 不把 run-events 的 `run_hint` 用于预览唤醒（预览行不写 run_events，且 1s 轮询更慢）。

## 5. 验收口径（done 标准）

- [ ] 前端 `useRunDraftPreview` 与 AssistView 预览改为 SSE 订阅，保留 `onSettled` 与降级路径。
- [ ] 断网/流失败自动降级回轮询，界面无报错。
- [ ] `docs/api/http-command-contract.md` 含 §10.59，且不与并行修改冲突。
- [ ] `apps/api/test/integration/preview-events.integration.test.ts` 全绿（Run + Assist 两路）。
- [ ] `apps/api` 单测 + 集成、`workbench` typecheck/build 全绿。
