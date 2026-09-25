# R02：前端对象隔离与创建流程修复

状态：已执行（2026-09-21）。适用已实现的 9 个 fixture 页面；修复未扩建页面，未接真实后端。

```text
请在 D:/Develop/Relay-Agent 修复独立验收中的 FE-01、FE-02、FE-03、FE-04。
先读 AGENTS.md、CODEX_NEXT_STEP.md、docs/testing/frontend-backend-acceptance-2026-09-21.md、
docs/development/ui-preview-acceptance.md、docs/frontend/design-system.md 和现有页面代码。
这些是独立修复项，不重跑原开发提示词、不重写布局、不更换技术栈。

负责范围：apps/workbench 的 fixtureAdapter、受影响视图/草稿导航及相关测试。
保留他人的改动；不修改 apps/api，不增加生产 API、桌面壳或通用状态管理框架。

先修 FE-01：
loadProject 当前忽略对象 ID，Skill 写入固定作用于 homeProject/projectTask。
动态复现：创建任务→打开新任务→正文仍是“确定实验评价指标”→接受定义改了示例任务。
让查询、接受、拒绝、蓝图应用、恢复摘要和来源都绑定明确对象和版本。
未提供 Skill fixture 的对象显示明确未提供/未接入状态，不能回退到其他对象；
允许最小方案仅开放已具备数据的对象，不要求生成每个对象的 Skill 提案。
未知 ID、另一个已知 ID、新建项目/任务、跨项目导航均不能读写固定示例对象。
路由 ID、面包屑、正文、来源、按钮目标必须一致，迟到响应不得覆盖新目标。
不要借此实现缺失的完整任务详情 UI-10。

再修 FE-02：
创建任务成功后保留表单且允许再次保存，现会生成两个 Task。
为同一创建意图保留提交身份，成功后进入明确结果/已有任务流程；
新建另一项必须是显式动作，而不是再次保存同一表单。
create 成功而 ready 失败时保留已创建 Task，后续只能修订/继续该 Task，不能重新创建。
submitting 防重入不等于幂等。按最小 fixture 范围模拟 command_id 与回执：
覆盖已提交丢响应、未提交、仍未知；查询使用原 ID，重试也不能换 ID 绕过不确定结果。
不要保留 lookupReceipt() 无参数且永远“未找到”的假核对流程。
同一提交响应后再次点保存、Enter、连续点击，都不能意外增加业务对象。

修 FE-03：
切换所属项目时清空不再合法的 dependencyId，UI 可见值和提交值一致。
fixtureAdapter 在写入任何 Task 前校验目标项目、依赖归属与已知基本约束；
拒绝跨项目依赖不能先 push Task 再报错。覆盖 A→B→无项目切换。
从项目任务页进入创建时带上当前项目，允许用户明确修改，并按新范围重算依赖。
fixture 应模拟契约，不能给未来接入留下“前端已通过、后端必拒绝”的假成功。

修 FE-04：
两个创建页接入已有草稿保护机制，覆盖返回列表、侧栏、浏览器前后退、同路由 query 切换。
有修改时允许继续编辑或明确放弃；保存成功后可正常离开，不能永远拦截。
刷新/关闭至少有未保存提示。只保存 UI 草稿，不在 localStorage 建业务事实数据库。
复用现有对话框焦点与 Esc 规则，不叠加浮层。

每个缺陷先补能失败的针对性组件/浏览器用例，再最小修改；
尤其验证修改错误对象没有发生、重复创建数量、被拒请求没有部分写入、草稿确实保留。
不要仅断言出现成功文案，也不要删减原测试。
运行 npm run build、npm run test、npm run test:browser，必要截图覆盖宽/窄窗口。
仍使用唯一 design-tokens.json；本修复不做新主题、字体下载或大范围 CSS 改写。

同步 docs/development/ui-preview-acceptance.md 和本轮验收状态，只对有新证据的编号标修复。
运行 node scripts/check-docs.mjs。交付时逐项说明 FE 编号、证据、未覆盖场景。
全部 fixture 测试通过也不能声明真实 API、数据库联调或 Windows WebView 已验收。
```

## 执行结果

- FE-01：`fixtureAdapter` 分离 `loadProject(projectId)` 与 `loadTask(taskId)`；蓝图、恢复摘要、任务定义和验收建议的读写都接收路由对象 ID。没有对应 Skill fixture 的项目或任务显示“尚未提供”状态，不读取或写入 home fixture。
- FE-02：项目和任务创建均保留原 `commandId`；fixture 回执可表达已应用、未提交和仍未知，`response-lost` 用于模拟已提交但响应丢失。任务成功后进入不可重复提交的结果态；新建另一项必须显式重置创建意图。
- FE-03：切换项目会清除失效依赖；adapter 在写前校验项目存在、未归档以及依赖同项目，拒绝时不写入 Task。项目任务页新建入口带当前项目 query 预填。
- FE-04：创建项目和任务注册全局草稿守卫，覆盖返回、侧栏、浏览器导航及同路由 query 切换；`beforeunload` 提示未保存草稿。成功结果可正常离开，未将业务事实写入 localStorage。

执行检查：`npm run typecheck`、`npm run test`（66 项）、`npm run build`、`npm run test:browser`（16 项）通过。`tests/remediation.spec.ts` 的 7 项测试覆盖 FE-01–04 反例、回执三态和跨项目依赖原子拒绝。

限制：所有结果仍是内存 fixture；未验证真实 API、数据库幂等、真实桌面 WebView、IME 或 DPI。
