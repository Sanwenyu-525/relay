# Assist 在途回复的停止控件设计

日期：2026-10-04
状态：已实施（第二轮修正 PENDING 显示语义）。组件测试 621/621、`tsc --noEmit`、生产构建、`check-docs` 通过；真实 Windows 窗口、真实 Provider 首字延迟、IME / DPI 未验
范围：`apps/workbench` 前端呈现层。服务端、API 契约、数据库不变。

## 0. 第二轮修正记录

第一轮把 `PENDING` 解释成「排队位置」，据此写下「队列是有在途时才存在的派生结果」。**这个推导是错的**：它只观察到「有 RUNNING 时 PENDING 才自然出现」这个相关性，没有读 `claimNextPendingMessage` 确认 PENDING 的写入路径。实际 `PENDING` 是落库初态，空闲发送也是 PENDING，于是界面把一条没有任何东西挡在它前面的消息渲染成「等待中 · 1 项」队列。

第二轮据实修正：显示语义按是否存在 `RUNNING` 分两种读法（见 3.2）。服务端状态机本身没有问题，worker 领取与生成都正常。

## 1. 问题

等待/生成中的 AI 回复目前这样呈现（`AssistView.tsx` 原 545–549 行）：

```
AI  18:33  正在生成
正在生成；此处不会把 202 回执当作完成。
┌──────────────────────────────────┐
│         取消这条回复              │
└──────────────────────────────────┘
```

三个问题：

1. 整宽 `secondary-button` 的视觉权重压过了它所控制的回复本身。
2. `此处不会把 202 回执当作完成` 把传输层词汇漏进用户读到的对话流。这是契约说明，属于代码注释与设计文档，不属于聊天文案。
3. 在途回复没有任何在途感；首字到达前消息体是空的。

## 2. 上游依据

参照 `.research/upstream/deepseek-harness/packages/client/ui-conversation`：

- `src/client/skeleton/InputBar.tsx:460-495`：运行中主按钮从发送箭头换成 `rect x=3 y=3 width=10 height=10 rx=3 fill=currentColor`，`aria-label` 取 `input.stop`（`停止生成`），tooltip 带 `Esc Esc`。按钮底色不变，只换字形。
- `src/client/locales.ts`：没有任何消息体级的「正在生成 / 等待生成」状态文案 key。`运行中` 只出现在 `detail.status.running`（工具/细节行）与队列区。
- `src/client/stop-shortcut.ts` + `stop-sequence.ts`：双次 Escape 的实现。

结论：上游把停止放在输入栏，消息体内不写说明，流式内容本身承担在途反馈。

**不抄的部分**：上游的 Queue / Steer（运行中按 Enter 变成排队/插话）。`docs/frontend/workbench-design.md:247` 明确禁止承诺未实现的发送行为。

## 3. 决策

### 3.1 按钮位置与二态

同一个 `.agent-chat-send` 位置，按钮在两种形态间切换。判定用既有的 `runningMessage`（原 1005 行），不新增派生状态。

| 条件 | type | 字形 | aria-label | disabled |
|---|---|---|---|---|
| `runningMessage !== null && !cancelRequested` | `button` | 内联 SVG 圆角方块 | `停止生成` | `busy \|\| pending \|\| writeBlocked` |
| 其余 | `submit` | `<Send/>` | 现 `sendLabel` | 现有条件 |

`runningMessage.cancelRequested === true` → 仍渲染停止形态但 `disabled`，`aria-label="正在停止生成"`，`title="正在停止，等待生成安全结束"`。对应 `workbench-design.md:237`。

### 3.2 状态机

**PENDING 的语义（第二轮修正）**：`PENDING` 是消息落库时的初态，含义是「已提交、Worker 尚未领取」。服务端 `claimNextPendingMessage`（`assist-repository.ts:121-130`）是它变成 `RUNNING` 的唯一通道，由 supervisor 每 250ms 轮询 `hasRunnableGeneration` 后拉起 worker。空闲时发出的一条也是 `PENDING`，此时没有任何东西排在它前面。因此是否渲染队列面板，判据是**是否存在 `RUNNING`**，不是 PENDING 的数量。

| 服务端事实 | 输入栏按钮 | 队列面板 | 消息行 |
|---|---|---|---|
| 无 RUNNING，无 PENDING | 发送 | 不渲染 | 无在途 |
| 无 RUNNING，有 PENDING | **停止** | **不渲染** | 等待生成 + 首字前三点 |
| 有 RUNNING，无 PENDING | 停止 | 不渲染 | 正在生成 + 首字前三点 |
| 有 RUNNING，有 PENDING | 停止 | 渲染 N 项 | 正在生成 + 队列各等待生成 |
| 在途且 cancelRequested | 停止形态，禁用 | 照旧 | 正在生成（正在取消）/ 等待生成（正在取消） |

停止入口覆盖 `RUNNING ?? pendingMessages[0]`，两种在途都能停：服务端 `setCancelRequested` 对 `PENDING` 直接收敛为 `CANCELLED`，对 `RUNNING` 记录意图由生成方结算。

队列里的其余 `PENDING`（有 RUNNING 时）只能从队列面板逐条取消 —— 输入栏按钮覆盖不到它们，队列面板的取消入口保留不动。

### 3.3 停止快捷键的两处语义差异

Esc Esc 绑定在 `<section data-testid="assist-session">` 根，用 React `onKeyDown`，**不用 window 监听**。冒泡顺序天然解决优先级：`sendOptions` 的 `onKeyDown` 在内层 `<details>` 上先跑并 `preventDefault()`，本处理器随后看到 `defaultPrevented === true` 即 `reset()`。

守卫（任一不满足即 reset 并返回）：

| 条件 | 理由 |
|---|---|
| `key !== "Escape"` | — |
| `isComposing \|\| keyCode === 229` | 中文输入法组词 |
| `alt \|\| ctrl \|\| meta \|\| shift` | 带修饰的 Esc 是别的意思 |
| `defaultPrevented` | 内层处理器已接管 |
| 在途回复为 null | 没有在途就没有可停的 |
| 在途回复 `cancelRequested` | 不重复发取消命令 |

间隔 `stopSequenceMs = 800`，不加 token：`motion.duration.*` 是动效时长而非手势窗口；本文件既有 1500（消息轮询）、400（预览轮询）、32（滚动阈值）都是硬编码命名常量，沿用同一惯例。

与上游 `stop-sequence.ts` 的三处语义差异：

1. **第一次 Esc 不消费。** 上游 `input.consume()` 吞掉第一次。本项目单次 Esc 要留给资料面板关闭与焦点管理，故第一次只记时间戳，第二次才 `preventDefault()` + `stopPropagation()`。
2. **两次必须指向同一在途回复。** 比对在途回复 id。否则第一条恰好完成、下一条被提上来时，第二次 Esc 会停一条用户没打算停的回复。
3. **第二次 `stopPropagation`。** 否则外层全局 Escape 处理器会同时响应。

按钮标注：`aria-label="停止生成"` + `aria-keyshortcuts="Escape Escape"` + `title="停止生成 · 连按两次 Esc"`。可访问名保持干净，快捷键走 ARIA 专用属性。

### 3.4 消息体内

- 删除整宽取消按钮与那句契约说明文案。消息只剩 meta 行的状态标签，满足 `design-system.md:157` 的「等待生成、正在生成、生成失败和已取消必须显式表达」。
- 被删文案不是丢弃约束。`messageStatusLabels`（原 412–414 行）里 `COMPLETED: ""` 就是该约束的实现：完成前必有 PENDING/RUNNING 标签，完成后标签消失。约束归属挪到 `design-system.md`。

### 3.4 首字前的在途提示

`status` 为 `RUNNING` 或 `PENDING`、`content === null`、无 preview、且未请求取消时，在正文起始位置渲染三点提示（`space-1` 点径与间距、`color.border.control`、180ms 错峰、`motion.easing-standard`）。有正文即消失，不额外占高度。与 preview 互斥；已请求取消后消失，避免与「正在取消」并读。

依据 `workbench-design.md:249`「工具阶段无文本时仍正确反馈」。这不是照抄上游 —— 上游靠 composer 的方块当唯一信号，本项目另有预览轮询，且实测首字延迟可达 22 秒（同一模型相邻请求 3.2s / 22s）。

`prefers-reduced-motion: reduce` → 动画关闭，三点静止；状态文字始终存在，不靠动效传达信息（`workbench-design.md:247`）。

### 3.5 Esc Esc 停止快捷键

绑定在 `<section data-testid="assist-session">` 根，用 React `onKeyDown`，**不用 window 监听**。冒泡顺序天然解决优先级：`sendOptions` 的 `onKeyDown` 在内层 `<details>` 上先跑并 `preventDefault()`，本处理器随后看到 `defaultPrevented === true` 即 `reset()`。

守卫（任一不满足即 reset 并返回）：

| 条件 | 理由 |
|---|---|
| `key !== "Escape"` | — |
| `isComposing \|\| keyCode === 229` | 中文输入法组词 |
| `alt \|\| ctrl \|\| meta \|\| shift` | 带修饰的 Esc 是别的意思 |
| `defaultPrevented` | 内层处理器已接管 |
| 在途回复为 null | 没有在途就没有可停的 |
| 在途回复 `cancelRequested` | 不重复发取消命令 |

间隔 `stopSequenceMs = 800`，不加 token：`motion.duration.*` 是动效时长而非手势窗口；本文件既有 1500（消息轮询）、400（预览轮询）、32（滚动阈值）都是硬编码命名常量，沿用同一惯例。

与上游 `stop-sequence.ts` 的三处语义差异：

1. **第一次 Esc 不消费。** 上游 `input.consume()` 吞掉第一次。本项目单次 Esc 要留给资料面板关闭与焦点管理，故第一次只记时间戳，第二次才 `preventDefault()` + `stopPropagation()`。
2. **两次必须指向同一在途回复。** 比对在途回复 id。否则第一条恰好完成、下一条被提上来时，第二次 Esc 会停一条用户没打算停的回复。
3. **第二次 `stopPropagation`。** 否则外层全局 Escape 处理器会同时响应。

按钮标注：`aria-label="停止生成"` + `aria-keyshortcuts="Escape Escape"` + `title="停止生成 · 连按两次 Esc"`。可访问名保持干净，快捷键走 ARIA 专用属性。

## 4. 不变量

- 服务端零改动：`cancelAssistMessage` 签名、202 回执、`cancel_requested`、取消竞态结算全不动（`apps/api/test/integration/assist.integration.test.ts:571`、`:601` 已覆盖）。
- `design-tokens.json` 不动：无新色值、无新时长、无新曲线、无新圆角。
- `.agent-chat-send` 的几何（`2 × radius.composer` 正圆、贴卡片右下角）不动，只换字形。
- 队列面板的取消入口本身不动（每条一项、只影响这一条）。渲染条件有两处变化：一是**形态**从「仅独立形态」放宽为两种形态都渲染（`?skill=assist` 嵌入子页没有图标停止键，队列项的逐条取消只能在这里）；二是**是否渲染**从「有 PENDING」改为「有 RUNNING 且有 PENDING」，因为空闲时那一条 PENDING 不是队列。
- 服务端状态机零改动：PENDING → RUNNING 仍只由 `claimNextPendingMessage` 推进。
- preview 契约不变：草稿仍标「生成中草稿 · 仅当前预览 v{n}」。

## 5. 受影响文件

源文件：

- `apps/workbench/src/views/AssistView.tsx` — 删消息内取消块；主按钮二态（独立形态图标键 + 嵌入形态文字键，后者是子页唯一的停止入口）；首字前三点；队列面板放宽到嵌入形态；`AssistMessageRow` 的 `onCancel`/`busy`/`pending` 参数与调用处；section 根 `onKeyDown`
- `apps/workbench/src/views/AssistView.css` — 新增 `.assist-inflight-dots` 及 reduced-motion 静止回退
- `apps/workbench/tests/mountApp.tsx` — `DomWrapper.trigger` 原本丢弃第二个参数并派发普通 `Event`，键盘处理器读到的 `key` 是 `undefined`；键盘事件改为派发 `KeyboardEvent`，否则 `Esc Esc` 无法被组件测试覆盖

`tests/assist-flow.spec.ts` 的 `message()` 辅助函数本轮未改；`createdAt` 缺失时 `messageTime` 返回空串、界面不显示时间，是既有行为，本轮不涉及。

测试：

- `apps/workbench/tests/assist-flow.spec.ts` — 原 88 行失去对象（该场景是 PENDING 无 RUNNING，输入栏是发送形态，87 行已断言 `assist-send` 禁用），改为构造 RUNNING 消息断言停止键在归档时禁用；原 251 行改点 `assist-stop`
- `apps/workbench/tests/assist-preview.spec.ts` — 三处「正在生成」断言不受影响，状态标签保留
- 新增「空闲时发出的 PENDING 不显示成等待队列，且仍可从输入栏停止」用例：断言无 `assist-queue`、无「第 1 项」、有「等待生成」标签、三点提示存在、输入栏为可用的 `assist-stop`，点击后发出该消息的取消命令
- Esc Esc 用例扩展为同时带一条额外 PENDING：断言有 RUNNING 时队列面板出现（`等待中 · 1 项，当前回复生成中`、`assist-queue-item-1`、`assist-queue-cancel-1`）；单次 Esc 不 preventDefault；间隔内第二次且在途回复 id 未变才发 POST；id 变了则第二次不生效；停止后按钮为 `stopping` 态且重复按键不再发命令
- 三点提示按消息 id 定位（`assist-inflight-<id>`），用于断言被停止的那条不再显示

输出脚本（不在测试套件内）按各自停的是哪条回复改：停排队回复用 `assist-queue-cancel-1`（`agent-functional.mjs`、`agent-scroll.mjs`），停在途回复用 `assist-stop`（`agent-recovery.mjs`，其场景在回执核对后已转为 RUNNING）

文档：`docs/frontend/design-system.md:157` 补停止控件位置约定与被删文案归属；`docs/frontend/workbench-design.md` 对话区补停止入口位置。

## 6. 验证

- `vitest run apps/workbench/tests/assist-flow.spec.ts apps/workbench/tests/assist-preview.spec.ts`
- workbench 全量、`tsc --noEmit`、生产构建
- `node scripts/check-docs.mjs`
- 视觉核对（首字前三点、reduced-motion 静止态、停止键两态、队列面板并存）归 `design-qa.md`

不宣称：真实 Windows 窗口、真实 Provider 首字延迟、IME / DPI 未验。
