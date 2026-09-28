# 四项 Skill 页面实施提示词

> 历史前端交接：当前由 [M02 React 全量迁移](stack-migration.md#m02完整-react-工作台与-windows-桌面基础)接续。本文页面业务/视觉要求可参考，旧 Terra/Vue 配置不再执行；实际开发使用 gpt-6-sol / ultra。

日期：2026-09-20（2026-09-21 契约词汇勘误）。用户要求：由 GPT-5.6 Terra 极高推理档开发，主 Agent 验收。本轮实际调度 `gpt-5.6-terra / xhigh`，不把模型配置作为产品技术栈。
范围假设：用户在四张新图后要求开发页面，先实现 UI-30–33 与必要共享页壳；全部33页不在本次默认范围。主 Agent 若收到范围澄清再补充。

## 任务与所有权

在 D:/Develop/Relay-Agent 实现可运行的 Vue 3 + TypeScript + Vite 前端，目录 apps/workbench/。该目录含组件、路由、明确开发用途的 fixture adapter、测试、配置及 README，由你负责。不创建生产后端、数据库迁移、桌面壳或任意新的平台抽象。
你不是唯一开发者；主 Agent 维护根文档/验收记录，其他工作可能正在修改后端准备文档。不要覆盖、回退或删除任何他人改动。仓库当前全为未跟踪文件，不能据 git diff 空白推断无内容。不要修改根 package.json、AGENTS.md、CODEX_NEXT_STEP.md 或技术 ADR；需要根文档变化向主 Agent报告。

先读根 AGENTS.md、CODEX_NEXT_STEP.md、README.md、docs/frontend/page-development-prompts.md 公共约束及 UI-30–33、design-system.md、design-tokens.json、workbench-design.md，以及 docs/architecture/relay-skills.md 第4、5、7、8.2节。理解 复用策略.md / ADR-005；页面层直接复用 Vue、Vue Router 与合适的成熟图标库，不研究无关后端框架。你应使用工具直接查看四张原图，不仅阅读文案：
docs/frontend/mockups/2026-09-19/extensions/project-blueprint.png
docs/frontend/mockups/2026-09-19/extensions/task-definition.png
docs/frontend/mockups/2026-09-19/extensions/verification-plan.png
docs/frontend/mockups/2026-09-19/extensions/project-resume.png

## 视觉要求

忠实实现原图，真实可选中中文 DOM，不贴整张截图。暖白画布、暖灰侧栏、墨绿操作、中文宋体标题、细分隔线与宽留白；主尺寸以1487×1058图像对照，兼容1280×800、960×720及窄屏重排。保留 Workflow OS 示例品牌，左导航今日/项目/任务/知识/动态/待审、底部连接/设置。当前范围外入口应诚实提示未接入，不产生空白页或虚假功能。
数值复用现有 design-tokens.json，通过简洁脚本或运行时生成 CSS custom properties 解析引用，不复制第二套色值；布局参照203px侧栏/65px顶栏，右栏按图。已有 token 实现推荐优先于生成图微纹理。图标用合适的成熟图标库；不用emoji。不得照搬另一套通用SaaS仪表盘，禁止大渐变或大圆角彩卡。
全局入口不增加 Skill 一级导航。可在项目/任务局部导航之间访问四个状态，用现有 /projects/:id、/tasks/:id 配合 query/tab 表达，浏览器返回与直接链接正常工作。示例数据标识简洁常驻，避免工程术语占据主体。初次进入蓝图页，能自然访问其他三页。

## 行为与边界

构建明确隔离的内存 fixture adapter（不使用 localStorage 作业务事实），提供必要异步响应以及可测试的加载/错误/冲突。默认页面正常，失败场景只通过开发/测试入口注入，不把测试控制台塞进用户流程。若没有真实API，所有成功反馈说明“本次演示”或“示例”，不能冒充真实保存/执行。可在页面常驻“交互预览 · 示例数据，刷新后重置”；交互结果再适量明确。
1. 蓝图：当前/建议差异；接受只在 fixture 中应用本次蓝图（新任务 `INBOX` / `ME`，`executor=HUMAN`，不开始任务）；后续配置单列且不随之生效。修改建议可编辑并形成新候选再预览；拒绝保留项目；重复点防重；提交冲突保持输入并能重新核对。
2. 任务定义：原始意图、目标、预期结果、验收条件、来源、建议模式。可编辑建议；接受形成新修订的演示回执，不开始或委托任务；拒绝保持当前事实。
3. 验收方案：按图默认缺少语义检查器，应用按钮 disabled 且原因可见；修改/保存待确认建议可操作。不能删除必需检查，不能把未运行变为通过；不得伪造可用检查器以解锁。如支持选择人工方式需有明确契约依据，否则保留未解决状态。
4. 恢复摘要：当前进展/风险/建议、来源、更新时间、无基线说明。查看来源/完成依据/待审产物应打开有内容的只读详情面板或已有相关页面；刷新产生 loading 并更新摘要时间，不启动Run、不改变Task。只展示获准示例来源，不展示模型私有推理。
共享对话框/抽屉有关闭、Esc、焦点限制及回落；离开未保存编辑有保留或丢弃的处理；迟到异步结果不得污染新目标。不要为未来范围建立通用DSL或空模块。

## 验证与交付

先核对依赖当前兼容性及Node环境，使用npm锁文件固定实装版本；不要无理由换React或安装大型组件库。实现必要的有意义测试：禁用应用、编辑后预览、拒绝保留项目、接受不自动启动、重复提交、冲突保稿、来源面板、键盘/Esc与窄视口不遮挡主操作。合理采用 Playwright/组件测试，脚本须方便主 Agent重跑。
运行 npm run typecheck、npm run build 和实际交互测试。起本地服务仅绑定127.0.0.1，保持运行并报告URL/进程。Windows后台进程用隐藏窗口。
交付目录 README 说明安装/启动/构建/测试、fixture重置与API缺口。报告修改清单、真实执行命令及结果、运行URL、截图位置、已知限制。不要把浏览器测试叫桌面验收，不宣称后端、AI或生产持久化已实现。
主 Agent独立验收；收到其问题后继续修复，不自行跳过检查或降低验收标准。
