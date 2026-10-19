# 本地目录：暂存产物同步与零配置浏览器闭环

日期：2026-10-18。执行者：继续复用本会话的 **GPT-6 Luna 子代理** `directory_access_fix_luna`。用户已授权验收发现问题后直接派发；不要发给原 Codex 会话，不需要用户搬运提示词。

## 1. 已闭合范围与本次缺口

协调者已独立重新构建并跑通 D1–D4：真实临时 PG 四套 **24/24**、Workbench 三文件 **32/32**、Workbench typecheck exit0。109 项迁移、Graph、PG 启停及新集群清理正常。四项修复在这个限定范围通过，不重做，不把新任务当作又一轮泛化审查。

本次仍有两项出口：

- **E1 已证实产物不同步**：当前 `apps/api/dist/src/application/local-directory-access.js` SHA256 为 `A6F9A4DF7FC74A2C668181454244C87127E5479F7576F2D6BEB7F47BA783C527`，`apps/desktop/src-tauri/resources/api/dist/src/application/local-directory-access.js` 为 `05D722D0664989139A27F6908E41EB96B96640008D2E8B9426369777A27520ED`。main.js 相同不能证明子模块已更新。debug/API 副本中该模块不存在；只读观察时有 debug relay-desktop 进程，不能宣称活动实例加载了新权限能力。
- **E2 零配置真实浏览器闭环未验**：目前只有真实 PG/HTTP/磁盘与组件证据，不能证明用户从浏览器目录入口到聊天写入不再需要手工建连接/策略。已有 `run-real-api-browser.ps1` 只提供 M02/FreeModels 场景，尚无本地目录场景。

工作区共享，你不是唯一执行者。你拥有本次新增的浏览器场景、受控 Provider fixture、必要 runner/config 的局部增量与自有 staging 检查；不得回退别人修改，不修改全站样式/浏览器自动化产品代码，不派下级子代理，不 commit/push。

## 2. E1：同步可交付暂存产物

1. 先查实际暂存与打包脚本的已有机制，确认来源和目标路径，按项目流程重新生成必要 API/Worker/前端暂存资源。不凭 main.js、worker/main.js 两个入口哈希宣布全包一致。
2. 定点核对本任务实际改动链：local-directory-access、gateway-repository、open-working-directory、权限 API/DTO、迁移0109、Workbench产物等依赖；保持已有真实包清单与依赖闭合规则，不另造全仓 SHA 报告。
3. 目标只在明确的 `resources/api` 等暂存根内；不能覆盖正在被进程加载的 debug/API 文件。读取用户活动实例可以，停止/重启用户窗口或绕过旧物理 Escape 的电脑接管不在授权内。必要时使用隔离的新自有 API/Worker/Vite 实例完成 E2，不依赖刷新旧窗口。
4. 先记录 mismatch，再按流程同步，最后核对关键子模块与迁移是否一致。若构建脚本本身遗漏复制模块，最小修脚本并补有意义的资源清单检查；不能只手工复制一份模块掩盖可复现的发布流程缺口。

## 3. E2：真实 API/Worker/PG/磁盘＋浏览器

读 `prompts/local-directory-access.md`、工作台§18.1.4和 LA-01–12；按需使用当前项目已有浏览器测试与真实 API runner。任务明确需要可重复的浏览器测试文件，可在既有 @playwright/test 基础上新增本地目录场景，不必建立第二套测试框架。

先给出最小场景设计，然后直接实施并运行：

1. 一次性 PG、随机端口、独立产物/受管临时目录和最小 workspace fixture；开始时基础文件连接/策略计数为0。不能测试 helper 先插权限，也不能 route.mock 业务 API 或直接写任务/Run 表冒充用户流程。
2. 从真实 Workbench 浏览器入口打开合成目录、看到默认只读和读取范围告知；取消选择零权限/绑定变化。通过普通消息读取随机标记文件并核对真实 session_tool_calls/原会话内容，零占位 Task/Run。
3. 通过实际目录档位界面改为自动或确认，不进入高级连接/策略页；经原消息→原候选/Apply→生产 Worker/图→Gateway→真实磁盘完成普通新建/修改，原会话能读到确切 Run 结果。至少完成一次真实编辑；若第一条读/写失败，先保留失败事实并最小修真实断点，不能改夹具让它跳过。
4. 尽量补 DELETE 的批准/拒绝 UI；若原 Task/Run 需要业务 HUMAN 接受才能发下一项，走既有真实入口或分开自有会话，不伪造完成/取消，也不移除同会话 Run 排他。完整 LA-12 未做到的步骤逐项列出，不能用 API 已通过成绩代替 UI。
5. 只将外部模型传输换为有界本机受控 Provider fixture，模型 schema、原候选、真实 Worker/图与工具协议照生产链运行；能复用现有 fixture/runner 就局部扩展，不用任意后门绕过权限。模型返回必须依实际读工具结果回应随机标记，不能把文件正文预塞回界面冒充读取。
6. 浏览器实际执行后查看必要截图、trace/错误与磁盘/账本断言；不能只写测试未运行。断言未访问 settings/connections，文件配置确由原用户目录/档位命令获得。

若测试暴露产品源代码缺陷，报告具体 RED/根因与最小涉及文件；在本地文件/会话接线授权范围内实际修复，不把临时 Fake 通路放进生产默认。共享热文件先核对 diff，无法安全合并时说明具体冲突，其他部分继续。

## 4. 附带核对与边界

`local-directory-access-review.integration.test.ts` 最后一项 managed-policy 撤销测试，撤销 managedRoot 的策略后当前又打开 `f.root`。将其定向修为重开真正的 managedRoot，并断言原 REVOKED ID 与无新 AUTO；这属于验收用例准确性，不据此编造新的产品缺陷或重写 D1。

不要反复外呼已超时的真实 Provider，不放大预算掩盖逻辑问题。本轮受控 Provider/Chromium、真实 Provider、Windows/WebView2、安装态分别报告。真实模型与旧桌面接管未验可保留限制，不能因此放弃 E1/E2 的隔离验证。

上一轮自有临时目录 `C:/Users/ASUS/AppData/Local/Temp/relay-api-integration-f425050cdb` 的删除已被自动审批拒绝，协调者只读确认目录仍在。**不要换工具/路径/脚本绕过原拒绝**；本轮新集群使用现有正常 runner 自清理。记录该已停止集群的遗留目录为清理限制，不操作任何用户 PG。

结果日志留 `output/acceptance-raw/local-directory-access-review-20261018/` 或本次同类忽略目录。更新统一验收表、CODEX_NEXT_STEP 与真正改变的规格/部署说明；四项独立验收结论不回退，不把自检新场景标成协调独立通过。运行必要 typecheck/构建及 `node scripts/check-docs.mjs`，不扩大无关全仓测试。

最终回报关键子模块同步的前后证据、实际浏览器/PG/文件结果、发现并修复的真实缺陷、用户活动实例状态与未验限制。你收到本提示词后立即接手执行，不仅给计划；协调者随后独立复核新产物。
