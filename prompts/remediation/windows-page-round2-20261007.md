# 页面继续验收：CLI_RUN 配置缺口与聊天底栏几何

日期：2026-10-07。用户已明确授权继续验收并直接派发，不需再等执行确认。

执行模型为 `gpt-6-luna`，最高推理档 `max`。沿用已有执行者 `/root/page_remediation_luna`，已核对其实际运行上下文是此模型/强度，不能换模型或再派子代理。协调 Agent 独立验收与维护文档。

## 1. 目标、所有权和基准

你负责本轮两项前端问题的最小实现、回归和自检，交付代码而非方案。工作区 `D:/Develop/Relay-Agent`。你不是独自在代码库中工作；先读 `git status --short` 与相关 diff，保留既有修改及上轮四项修复，不恢复整文件，不覆盖他人工作。禁止 commit/push/reset/clean/stash、重装依赖、改锁文件或停用户服务。

代码所有权限于：

- `apps/workbench/src/views/ConnectionsView.tsx`，如适配确有必要可改同目录 `ConnectionsView.css`。
- `apps/workbench/src/views/AssistView.css` 的模式 chip/底栏相关选择器。
- `tests/connectionsSettings.spec.ts` 和直接相关连接组件测试。
- `tests/browser/uiOption2FirstSession.spec.ts` 的必要新增回归；允许一个边界清楚的连接配置 browser spec。

API/client/DTO/数据库/Provider/Worker/桌面 Rust/全局 tokens 原则上只读。本轮已有后端与 client 字段足够，不新增权限、不补通用 CLI 编辑器、不执行实际 CLI、不重做首条助手功能。若发现超出上述所有权的必需依赖，先向协调者报告最小原因，继续可独立完成部分。

文档由协调者持有：提示词、CODEX_NEXT_STEP、验收表、workbench-design、design-system 不交叉修改。交付给出必要规则变化，协调者同步。没有 API/数据库变化就写 Breaking Change：No，不为两项小修建 ADR。

本轮开始时 HEAD 为 `216a41b` 加大量未提交修改，开工重新核对。上轮四类问题已通过独立局部复验，不能回退。

## 2. 必读与确认

先读根 AGENTS、CODEX_NEXT_STEP 顶部、验收表顶部两轮页面及 API client 行；按范围读 docs/README 的事实源/验收输出规则、workbench-design 第 5 节中的连接权限段及第 18/25 节输入器、design-system 第 9 节、唯一 design-tokens.json。

再读：ConnectionsView 的创建/查询/冻结 PendingCommand/回执恢复；`src/api/resources/gateway.ts`、`src/api/parse/gateway.ts`、`src/api/dtos/gateway.ts`；后端 `gateway-api.ts`、`gateway-commands.ts` 的 resolveAllowedExecutables、`cli-executable-admission.ts` 的根内与根外准入。理解真实语义，不根据旧文案猜测。

协调者已在当前工作区重跑红例：

- `node node_modules/vitest/vitest.mjs run tests/connectionsSettings.spec.ts`：16/18，两条在98与125行因 `connection-executables` 不存在失败。
- `node node_modules/@playwright/test/cli.js test uiOption2FirstSession.spec.ts --grep "输入区不画分隔线"`：1/1失败，toolsHeight=40，painted=32，现断言469行。不要机械依赖行号。

## 3. A：CLI_RUN 允许可执行文件的输入与读回

现有后端接受可选 `allowed_executables`，client 已接受 `allowedExecutables`，查询 DTO 已暴露规范化后的 allowedExecutables；生产页面没有输入和列表显示。本轮闭合 UI 垂直切片，不改变服务端算法。

要求：

1. 只在创建能力为 CLI_RUN 时显示可选多行「允许的可执行文件」字段，保留 `connection-executables` testid；每行一个完整绝对文件路径。路径中空格、盘符和反斜杠是路径内容，不按空格/分号拆命令，不附加参数、不运行探针。用既有 field/hint 样式，不造新管理页。
2. 提交时按换行拆分、trim、移除空行；无有效项就省略参数，不能发空数组。其他能力即使有先前 CLI 草稿也不得发送此字段。不要自动填 node/npm/powershell、通配符或 PATH 发现值，不扩授权。是否保留切能力时的临时文本按既有表单习惯，但发送载荷必须与当前能力匹配。
3. 服务端限制最多32项、现存绝对文件、realpath规范化/去重；继续由服务端验证并原样呈现失败，不在前端伪造存在或规范化结果。输入提示须说明每行路径和服务端验证，别宣称这就是沙箱。无需另写 Windows 路径解析库。
4. 已查到的 CLI_RUN 连接显示服务端 allowedExecutables，提供 `connection-allowed-executables` testid。null/未配置如实显示「未配置」；语义是目录内可执行入口沿用既有准入，根外入口须显式点名，不能写成“全部允许”或“全部禁止”。非 CLI 项不显示无意义允许清单。服务端归一后的值与用户原输入不混淆。
5. 连接不是授权，动作仍受 Permission/Gateway 与撤销检查；原默认 DENY、停用、版本、健康读取及资源边界保持。
6. 在形成 PendingCommand 前冻结 capability/root/host/允许路径数组。响应不明、查询回执及同 ID 重试必须使用这份原载荷，不从编辑后的 textarea重新读取。不能以新ID绕过 unknown，也不能把业务422当待核对。
7. 在途时沿用 busy 禁用，归档/失权禁止新写，恢复入口按原命令保持。新增字段的loading/error语义复用当前表单，不重写整个恢复器。

验证至少包含：原两条红例变绿；非CLI无输入/不带该字段；多行CRLF、空行、路径内空格；服务端读回规范化值；422错误不是成功；传输失败后改临时状态仍按原ID/同数组恢复；初次读取或写失权不提供可提交新命令。新增 tests 用真实 DTO/Envelope，不造错误结构让解析绕过。不实际创建用户连接或授予权限，浏览器 fixture 可拦截 API。

## 4. B：模式 chip 不再撑高普通聊天底栏

`AssistView.css` 的 `.agent-chat-mode-option` min-height 取 control.height（40px），其普通模式两枚 radio 作为composer-tools子元素，将已有32px单行撑到40px。发送键直径与底栏单行高度从 `2 * radius.composer` 推导，tokens为既定契约，不能改 token 或断言去迁就缺陷。

要求：

1. 针对普通单行模式chip做最小CSS修复，与资料/讨论chip使用相同底栏尺寸推导，保留原生radio、可见标签、键盘方向键与focus。
2. 修复后现有几何红例原样通过：工具行和发送键同高、中心差≤1px、发送键与卡片圆角圆心重合、目标大小满足现有token。不得增加容差、skip、隐藏模式控件或减小可点击目标。
3. 助手档会展开选择器/说明/新建表单，不能强制整个展开区域固定32px导致截断。仅单行模式chip与既有普通底栏对齐；加载/错误/空助手提示和首条门禁保持可读，不伪造“所有助手状态都单行”。
4. 保留首条与已有会话、普通/助手、禁用在途、中文草稿与输入事件。短窗能滚达必要操作，窄窗允许合理换行、不横向溢出、不盖发送键。
5. 不重做发送键定位/卡片圆角/上下文圆环/全站控制高度，不扩展动效。

浏览器验证：原几何例不改通过；完整 uiOption2FirstSession 套件一次；代表843×782、1162×782、2048×1104、843×600检查普通档模式控件、发送键可达无覆盖/溢出，助手空态可读且不可发送；至少检查radio焦点与方向键仍能切换，草稿保留。新建与已有会话不要只测一种。

## 5. 执行与检查

先给简短计划，再实施A/B；你已有协调者当前红例证据，不必为重复红例耗时。新增捕捉实际问题的回归后最小修复；不能删失败检查或将HTTP夹具全改成成功。

使用项目包实体调用，`.bin`缺失时不要安装依赖：

- `node node_modules/typescript/bin/tsc --noEmit`
- `node node_modules/vitest/vitest.mjs run tests/connectionsSettings.spec.ts` 加直接受影响spec。
- `node node_modules/@playwright/test/cli.js test ...`
- `node node_modules/vite/bin/vite.js build`
- 前端全量Vitest一次，报告真实计数与失败。

协调者已启动独立4173 Vite供本轮浏览器检查，session归协调者维护，你直接复用配置reuseExistingServer。用户5173真实窗口保持运行。不要停止服务、改依赖、读密钥或发真实Provider/CLI动作。

完成后先交付可复验代码与本轮定向绿例，再给typecheck/build/全量。上轮768/770不是本轮成绩，不直接复制；run-events若出现时序失败单独分类，不盲扩scope。浏览器全量可能暴露新问题，报告具体断言及归属，不擅自重做其他页。

## 6. 交付与验收边界

给协调者：改动文件、两项根因/最终行为、准确命令与计数、原红例是否原样绿、恢复载荷测试、未测范围和文档规则建议。不要贴完整输出或造长报告；原始输出放忽略目录即可。

协调者独立复跑关键组件/几何、审查freeze/omit字段、用computer-use复验真实Windows已有空工作空间的输入器。若真实项目连接页没有可进入对象，明确当前真实窗口数据条件，不拿fixture/截图冒充真实API+PG或Windows配置命令闭环。后续有数据业务路径另按隔离验收入口处理，不写用户权限配置。

完成定义：两项既有红例修复、相关回归通过、类型/构建通过、全量结果如实分类、协调独立验证和相关文档一致。本轮不推进其他M/N模块，不声称完整桌面或安装交付。
