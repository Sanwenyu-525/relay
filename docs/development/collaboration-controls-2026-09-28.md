# 协作控制增量：锁定、手动影响检查、人工介入提醒

日期：2026-09-28。当前状态：**退回项修复完成，待协调侧独立复验**。下文“协调侧独立验收”保留修复前暂不通过的原始证据；其后的开发自检和 Windows 定向验证是修复侧复验，不代表独立验收或 M03–M07 整体通过。产品规则以 [工作台 10.1 与 11.5](../frontend/workbench-design.md) 为准。

## 设计与 Owner

- Artifact 仍拥有不可变版本。`artifact_text_locks` 存当前锁定原文、段落/章节选择器与绑定版本。选择器仅用于用户定位；服务端核对确切文本、唯一性及结构顺序。人工追加版本重新映射锁定文本；无法可靠映射时保留 `UNMAPPED` 并拒绝 AI 写入，直到人工核对/解锁。锁定与解锁按 Artifact revision CAS、命令回执执行。
- AI 修正轮 `PERSIST_CANDIDATE` 在实际版本写入前核对锁定。冲突只使依赖该候选的 Run 失败，原版本不变，并记录原 Run、Artifact、基线版本与原因；其他 Task 不因此停下。显式影响候选的应用也经同一锁定检查。Assist 接受仍创建独立产物，不绕过已有产物的锁定写入口。
- 影响检查只有手动点击才创建 `artifact_impact_checks`，冻结来源旧/新版本、Artifact revision、已登记直接引用与输入截断事实。页面先只读列出直接引用，用户逐项选择哪些目标摘录可进入模型输入；未选择目标仍展示为明确引用，不发送其正文。分析走既有 Assist/ModelPort、额度及 Worker，用 Fake 可控验证；模型输出仅为 AI 推测，不改产物。用户逐个选择处理目标并确认推测后，`artifact_impact_candidates` 冻结目标版本/revision；显式应用才经 Artifact Owner 生成 AI 来源新版本，重新核对来源、目标、执行权与锁定。不继承验证/接受结论。
- `attention_notification_receipts` 按事项身份与变化去重。开放 Review、保留原目标的锁冲突、当前 Run 失败及 UNKNOWN 动作组成必须介入投影；普通 HUMAN INBOX/READY 和成功进度不纳入主动通知。应用内列表总从业务事实重算，回执不拥有解决状态。窗口失焦时默认等待 **3 秒**聚合后认领并尝试 Windows 通知；这是实现默认值，不是用户指定数字。多项点击待处理列表，单项进入原入口。WebView2 Notification API 的投递/点击仍待真实安装宿主验证；当前仅有代码路径，不能称 Windows 能力已验收。

## 数据、API 与兼容

- 追加迁移 `0040`、`0041`、`0042`，不改历史迁移。既有 Artifact/Task/Run 表与已有版本不重写；新表为空起步。回滚若删表会丢失锁定、影响检查和通知回执，应先停写并保存审计快照。本地未发布接口的 Breaking Change：**否**。
- 新增 Artifact 锁定列表/锁定/解锁、旧来源版本影响检查及结果读取、逐目标候选生成/读取/应用、人工介入投影与通知认领/投递状态接口。锁定及候选应用仍要求原权限、执行权与 revision。通知认领属于传输回执，不修改业务 Review/Run/Task 状态。
- 模型不可用、取消、输出无效、输入截断、来源或目标变化均保留真实状态或拒绝旧候选。登记直接引用不等于需要修改；未登记与间接下游始终列为未分析范围。真实 Provider 门槛未变。

## 已运行验证

- Node 24 API/Workbench TypeScript 无错误；Markdown 锁定单测 3/3。
- 隔离 PostgreSQL 18.6 应用迁移 `0040–0042`，原 `api-artifacts` 18/18，专项 `collaboration-controls` 4/4：锁命令幂等/CAS、人工版本继承、Fake 影响检查不自动应用、锁定区候选应用拒绝、提醒跨请求去重及 Review 解决后消失、Run 失败释放 Task 执行指针后仍保留介入事项。
- Workbench `artifactLineage.spec.ts`、`taskDetail.spec.ts` 与 `interventionNotifications.spec.ts` 24/24，含默认 3 秒聚合的假时钟验证。浏览器/fixture 结果不代表 Windows 系统通知投递或点击成功。

## 待复核与限制

- Windows 安装宿主的系统通知许可、失焦投递、点击回原事项和已解决后点击，尚无真实运行证据。WebView2 接受通知请求也不证明系统已显示。
- 候选应用锁冲突保留旧目标与处理入口，但当前候选页只显示拒绝原因，需独立体验复核。锁定冲突来源于已执行 AI 修正轮时才会被发现；不会自动扫描所有内容影响。
- `artifact_text_locks` 保守映射可能拒绝结构大幅变化后的 AI 写入；由用户重新核对原文并解锁/锁定处理，不猜测匹配。
- 复核中发现最初提醒投影依赖 `Task.executor_run_id`，而失败路径会释放该指针，导致真实失败 Run 被漏掉。现改为按同一 Task 的最新 Run、未完成 Task 与失败状态判断；专项真实 PG 反例已通过。

## 协调侧独立验收（2026-09-28）

结论：**暂不通过**。范围是本工作包的未提交实现及其集成点；不重验或覆盖 M06 发布包。执行者确认未执行 `git add/commit`，但没有保存严格的开工快照；当前索引差异用于定位已跟踪代码，新增文件单独检查，共享文档按本包变更区分。

独立实际运行：

- Node 24 重编 API，并用 `apps/api/scripts/run-integration.ps1 -UseCLocale -TestFile collaboration-controls` 新建隔离 PostgreSQL：42 条迁移、图存储安装和专项 **4/4** 通过，临时 PG 停止且目录清理成功。
- 从本轮重编后的 API dist 执行 `markdown-locks.test.js`，既有单测 **3/3** 通过。
- Workbench `artifactLineage`、`taskDetail`、`interventionNotifications`、`assist-flow`、`assist-target` 五文件 **32/32**，Workbench TypeScript 检查通过。
- 额外直接调用当前源码的锁定判断，两个反例未满足原文保护：章节末尾 `原文  \n` 改为 `原文\n`、段落内部 CRLF 改为 LF，`protectedTextConflict` 都返回 `null`。这些是已复现的失败，不能被既有 3/3 掩盖。
- 为独立审查发现补充持久回归：`collaboration-controls.integration.test.ts` 新增空白候选拒绝场景，专项变为 **4 通过 / 1 失败**；`interventionNotifications.spec.ts` 新增必须介入事项的空态场景，**1 通过 / 1 失败**。保留失败断言供修复复验，没有删除或放宽它们。
- 补跑受影响的 `productSupplement26.spec.ts` 为 **7 通过 / 1 失败**：首个队列用例的旧 client fixture 未提供新增 `getInterventions`，因此进入“不完整”提示。属于集成测试适配遗漏，应补有效 mock 后保留原断言重新运行，不能据此新增一个产品缺陷结论。

退回项：

1. **P1：Windows 通知所需宿主权限未接通。** `InterventionNotifications.tsx` 在排入聚合计时器前调用 `isFocused()`，点击通知时调用 `show()`/`setFocus()`；唯一 capability `apps/desktop/src-tauri/capabilities/default.json` 只授予事件监听/取消监听和窗口销毁，缺少对应的 `core:window:allow-is-focused`、`allow-show`、`allow-set-focus`。已与本地生成的 ACL manifest 对应命令核对。这使真实宿主在通知创建前就有权限阻断；现有组件测试把窗口 API 全部 mock 成成功，未覆盖该边界。修复后必须用包含本增量的确切 Windows 宿主验证失焦投递、点击回窗及权限拒绝路径。
2. **P2：锁定比较使用规范化文本，未保护确切原文。** `markdown-locks.ts` 先将 CRLF 转成 LF，章节还使用 `trimEnd()`；实际版本保存保留输入字节，因此可在不解锁的情况下保存上述不同正文。应按确切原文跨度比较，显示用的整理不得成为写入保护依据，并补上述反例及正常相邻编辑回归。
3. **P2：无效影响候选仍可从 API 应用。** `artifact-impact-checks.ts` 的读取路径把 `{"markdown":"   "}` 标为 `FAILED / OUTPUT_SCHEMA_INVALID`，应用路径却只核对字段类型，且通用正文校验允许空白。真实 PG 反例在读取失败状态后直接调用原 apply API，返回 **200 而非 409，目标 latest_version_id 实际变更为新版本**。服务端需要复用一致的候选输出校验，不能只依赖前端隐藏按钮。归 Standards 轴的输出/写入契约违反。
4. **P2：同屏显示必须介入事项与空队列结论。** `AttentionQueue.tsx` 的空态条件遗漏 `snapshot.interventions.length`。最新失败 Run 的 Task 已人工接手、旧 Review/Run/Task 分组为空时，页面同时显示“必须介入 · 1”和“当前读取范围内没有待处理项”。新增组件反例已复现，须统一空态判断。与前两项一起归 Spec 轴的确定需求偏差。

另有两项静态审查疑点保留后续核对，不按已复现缺陷计数：影响输入复制到 Assist `content` 且 `sources` 为空，需补入队后来源失效/撤权及模型发送时证据核对；冻结旧版本本身不是错误，应用前已有 revision/latest 检查。候选完成后停止轮询可能导致按钮展示滞后，但服务端仍拒绝过期应用，当前未发现覆盖新版本。不能把这些疑点表述成已证实的越权外发或数据覆盖。

文档影响检查：本轮更新本记录、当前进度、工作台实施状态与测试计划的验收状态，并在既有 API/组件测试文件各保留一个失败回归；没有需求、架构、API 或数据库设计变更。`node scripts/check-docs.mjs` 和 `git diff --check` 通过。本轮没有修改生产实现、替换 Windows 发布包或开启真实 Provider。上述退回项修复及重新验收前，不将本包标记完成。

## 退回项修复与开发自检（2026-09-28，待协调侧独立复验）

本节追加在原失败证据之后，不改写上方协调侧的 **4 通过 / 1 失败**、**1 通过 / 1 失败** 和确切原文反例。开工前以 SHA-256 记录目标文件基线；当时 `CODEX_NEXT_STEP.md`、`AttentionQueue.tsx` 和多处共享文件已有未提交改动，`test-release` EXE/API、`.relay-test` PostgreSQL 正在运行。未停止这些进程、替换发布包或清理他人临时目录。主要基线如下：

| 文件 | 开工 SHA-256 |
|---|---|
| `apps/api/src/artifact/markdown-locks.ts` | `64f9ee6e24c8c70c0cef3461ac045ef73b9d8a3b11bff04aaeb6ad46b7ca9d1e` |
| `apps/api/src/application/artifact-impact-checks.ts` | `09e023a4dd39b0d467c73e2d10aafb5036841698e07cc0715a602f9fdebe20e98` |
| `apps/api/test/integration/collaboration-controls.integration.test.ts` | `f40a42a7c02ecb06ef558347577d7c83e28935a5697b30498cf804485a050cc5` |
| `apps/workbench/src/components/AttentionQueue.tsx` | `13e38b532a6fbecfe1e670a250ed3112bb20fd796bf273d0d4c831d9a77858af` |
| `apps/workbench/src/components/InterventionNotifications.tsx` | `39b7262d4348aa52a49b8662143cb9e63aa4ed081b914b280a846ebc2dc6b901` |
| `apps/desktop/src-tauri/capabilities/default.json` | `f0ee4641e97f95834ae30357714bbc28f2292bd5be0f38e5a7ab29a3c80d5a34` |
| `apps/workbench/tests/productSupplement26.spec.ts` | `7ffec4a2d7f51ae7a708321ebd64841da9ba8b3b2fad0ed7e75fa174b978f8b5` |

根因与局部修改：

1. `markdown-locks.ts` 过去先统一换行、再截去章节尾部空白，保护依据不等于保存的原文。现按原输入拆行，保留块内部 CRLF 与章节尾部字符；人工继承锁时先核对旧选区与锁记录。旧记录若基线不一致，保留锁事实为 `UNMAPPED`，AI 写入返回冲突提示；不猜测恢复、也不重写历史正文。`markdown-locks.test.ts` 和真实 PG 专项补章节尾空格、段落内部 CRLF、相邻编辑、人工新版本继续锁定及旧记录保守拒绝；原删除、移动、拆分/合并用例保留。
2. `artifact-impact-checks.ts` 原读取与应用分别解析候选，应用漏掉空白及上限。两路径现共用 Markdown 候选校验，格式错误、空白或超过 256 KiB 时读取为 `FAILED/OUTPUT_SCHEMA_INVALID`、应用返回 409；原 CAS、锁检查、幂等路径保留。原失败回归扩展为三类无效输出，并核对目标版本数、`latest_version_id`、`applied_version_id` 和本次命令的成功活动事实均不变。
3. `AttentionQueue.tsx` 空态漏计必须介入投影，现仅在 interventions、Review、Run 和 Task 组均为空且读取完整时显示。`productSupplement26.spec.ts` 的三处旧队列 fixture 补空 `getInterventions`，保留原业务断言。
4. 本轮在 `capabilities/default.json` 仅补提醒调用需要的 `isFocused`、`show`、`setFocus` 三项；文件中的其他窗口命令来自并行标题栏工作，未开放整组窗口权限。`interventionNotifications.spec.ts` 增前台不认领、单项点击、两项聚合入口及拒绝后应用内仍可见的定向用例。[WebView2 通知权限说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2permissionkind?view=webview2-winrt-1.0.3912.50)指出通知请求须由宿主处理，且不会出现浏览器权限提示；因此在既有 `lib.rs` WebView2 初始化回调中，仅允许受信任 `http://tauri.localhost` 页面请求通知，其他来源明确拒绝。宿主未接管投递时按[WebView2 默认通知 UI](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2notificationreceivedeventargs?view=webview2-1.0.3912.50)处理，实际投递与点击仍以本机运行证据为准。Rust 来源限制单测 1/1。

实际开发自检：API 与 Workbench `tsc --noEmit` 均通过；Node 24 重编 API 后 `node --test apps/api/dist/test/unit/markdown-locks.test.js` **6/6**。`run-integration.ps1 -UseCLocale -TestFile collaboration-controls` 首轮因新测试的章节范围取错及 bigint 断言类型而 **4/6**，修正测试数据与断言后隔离 PostgreSQL 18.6、42 条迁移、图存储安装和专项 **6/6**；第二个隔离集群 `-SkipBuild -TestFile api-artifacts` 原保存路径 **18/18**，两次 PG 均正常停止且临时目录清理。Workbench 六个指定文件首轮 **41/41**，新增通知场景后 `interventionNotifications.spec.ts` **4/4**，最终六文件结果须在下方补录。未使用真实 Provider。

隔离桌面构建：API `dist` 经进程命令行核对无人使用；现有 `test-release` 的 EXE、Node 和 `.relay-test` PG 独立运行，不触碰。Workbench Vite 输出至 `%TEMP%/relay-notification-repair-20260928/workbench`；并行编辑的 `DesktopTitleBar.tsx` 尚未落盘时一次构建失败，文件就位后重跑成功。Tauri 用独立 `CARGO_TARGET_DIR` 和该前端输出完成 `--no-bundle` Windows release 构建；首次 EXE SHA-256 `fd5faee1356567b69970bc53e6a7e3726bc5ab0f57b4eeb3d286c22631506975`，增加受限 WebView2 通知权限回调后重新构建的确切 EXE SHA-256 `0fcf478f7c7fb8128ca568bb91b8c1a6a0e329fed4b5267177377771d565013b`。打包 API 锁保护与影响候选模块 SHA-256 分别为 `2d0e051d5fb04569ce9f07ab46eb129e91132d9c9db6c4ce20c27fc6b1dc7aee`、`39706a123383b2a96622037456b606d59809ad849c94511526756e62ad2079bb`。构建与 Rust 来源限制单测只证明宿主代码可编译，不证明 Windows 通知显示或点击。原 `test-release` 已退出，但并行标题栏试验宿主仍占用单实例互斥量；用户表示会自行关闭并通知，之后对本隔离 EXE 运行通知定向验证。未将此自检写作协调侧独立验收或 M03–M07 总通过。

### Windows 宿主定向复验与最终状态

上述 `0fcf…` 是进入真实宿主前的构建时点记录，非最终产物。首次使用绝对路径 `frontendDist` 的隔离 EXE 在 WebView2 显示 `asset not found: index.html`；改用仓库内独立 `.notification-acceptance-dist` 相对路径重建后正常加载。真实通知单项点击揭示一项同一退回项内的遗漏：`show()` 加 `setFocus()` 可导航，却不能把最小化窗口恢复，Win32 `IsIconic=1`、Tauri `isFocused=false`。因此 `InterventionNotifications.tsx` 点击处理补 `unminimize()`，capability 仅再补 `core:window:allow-unminimize`，组件回归核对调用。未打开整个窗口权限集合；共享 capability 中标题栏的其他单项权限属于并行工作，未回退。最终隔离 EXE SHA-256：`a5bac1b61c2c04a4b7d49377915892c3f438a3b5326d4fcbf8bcd1a1b5eb684a`。

最终宿主使用私有 PostgreSQL 18.6（端口 8051）、独立数据根、隔离 `CARGO_TARGET_DIR` 和 `--no-bundle` EXE，明确标记测试 Review。WebView2 `Notification.permission` 经宿主许可由 `default` 变为 `granted`。真实窗口前台维持 14 秒时新增介入事项在应用内显示，但通知回执为 0；最小化后 Windows 原生通知显示。单项点击进入确切 `/reviews?id=…`，并证实 `IsIconic=0`、`isFocused=true`；两项同批投递仅一条“2 个事项需要你处理”，点击进入 `/tasks?tab=attention`，两项均为 `DISPATCHED`。在仍可点击的通知产生后先把对应 Review 改为 `DECIDED`，点击旧通知只打开历史入口，下一轮介入数下降，不复活 Review。持续轮询后重启同一最终 SHA 的宿主，回执前后均为 `13` 条（`DISPATCHED=11`、`DENIED=1`、`FAILED=1`），未重复认领。

拒绝路径以持续 CDP 权限覆盖使 `Notification.permission=denied`，回执为 `DENIED`，刷新应用列表仍见原事项；一次断开 CDP 后的覆盖未保持，故该次 `DISPATCHED` 不能算拒绝证据。失败路径在真实 WebView2 页面定向注入会抛错的 `Notification` 构造器，回执为 `FAILED`，应用内事项仍在。这两项是受控拒绝/故障注入，不冒充 Windows 设置策略或自然发生的系统故障。原生通知的局部截图、事项 ID、回执与命令边界保存在[Windows 定向证据](../testing/evidence/collaboration-controls-windows-notifications.txt)，截图只含通知区域，不包含其他桌面内容。测试 Review 的 `STATE_PROPOSAL` 是隔离通知投影夹具，未把其判断页当成业务审批验收。

最终复跑：Workbench 指定六文件 `vitest run tests/artifactLineage.spec.ts tests/taskDetail.spec.ts tests/interventionNotifications.spec.ts tests/productSupplement26.spec.ts tests/assist-flow.spec.ts tests/assist-target.spec.ts` **43/43**，其中新增失败通知仍保留应用内事项断言；其他 API/PG/Rust 结果见上段。本轮状态：**修复完成，待协调侧独立复验**。真实 Windows 开发自检已覆盖本轮通知定向要求；安装包、协调侧独立复验、M03–M07 总出口和真实 Provider 门槛未由此宣布通过。

收尾复查：API 与 Workbench `tsc --noEmit` 均退出 0；`node scripts/check-docs.mjs` 检查 91 个 Markdown、1699 个链接并通过；`git diff --check` 退出 0（仅 Git 给出原有 LF/CRLF 工作区提示）。定向 Windows 私有 PostgreSQL 经会话停止脚本正常关闭并删除会话根；证据截图和文本留在 `docs/testing/evidence`。未提交或 push。
