# 长短期记忆模块：前端开发任务书

2026-10-20。配套后端与验收边界以源码、[当前进度](../CODEX_NEXT_STEP.md)和[统一验收表](../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)为准。本任务书交付不代表前端已经实施，也不自动授权当前后端 Agent 开发前端。

将以下完整任务交给前端开发 Agent，或让其直接读取本文件执行。

~~~text
你在 D:/Develop/Relay-Agent 工作，所有说明用中文。请实际完成长短期记忆模块的前端接线、交互、测试与文档，不只输出方案或静态页面。不要 commit/push，不修改用户数据库，不自动调用收费 Provider，不回滚或覆盖共享工作树的并行修改。

一、先核对事实与范围

先读 AGENTS.md、CODEX_NEXT_STEP.md 和统一验收表的“完整长短期记忆后端”行，再读：
- docs/frontend/workbench-design.md §13.3、§40：产品交互。
- docs/api/http-command-contract.md §10.98–10.99：准确请求/响应/控制语义。
- docs/decisions/ADR-028-memory-layers.md、docs/development/memory-module.md：Owner 与边界。
- docs/frontend/design-system.md、design-tokens.json：沿用现有视觉规则。

先检查 git status 和目标文件 diff；当前工作树有大量并行改动。长期记忆的有效/过期/停用筛选、修订与恢复前端已存在，保留并复用。不要执行旧提示词重建已完成部分，也不要启动后端重构、模型选择、目录权限、Git 或聊天排版专项。

本任务只接新增记忆功能：Workspace 设置、消息明确保存、长期来源、短期窗口/整理/取消/清除/一次性模式、消息使用足迹，以及 /compact 的发送分支。普通 AGENT 自动召回已确认长期记忆；ASSISTANT/LEARNING 不自动升级到该链。

二、文件责任

主要修改 apps/workbench/src/api/dtos、parse、resources 下对应 assist/information 类型、解析和请求，以及 relayClient.ts facade。可新增范围明确的 memory 文件并复用现有 HTTP/错误/回执工具，不建立第二套客户端。

界面复用 views/SettingsView.tsx、AssistView.tsx、KnowledgeView.tsx 与现有消息/会话控制组件；仅新增必要的小组件和样式，不重排整个聊天页。/compact 还需检查 api/resources/chatControls.ts 与当前命令发送分支，不能只扩展类型而仍显示“未接通”。共享输入器、附件、流式消息和队列逻辑保持原语义。

三、后端已具备的接口

所有路径在 /api/v1/workspaces/{workspace_id} 下。详细形状只按 HTTP §10.99 和实际 schema 核对：

1. GET /memory-settings；POST 同路径，body={command_id,expected_revision,recall_enabled,automatic_compaction}。
   GET 缺配置时由服务端返回 revision="0"、两个开关 true。保存必须携带读回的另一开关值，不能盲写默认值。
2. POST /assist-sessions/{session_id}/messages/{message_id}/memories，body={command_id,expected_session_revision,content_sha256,project_id,title,text,confirmed:true,expires_at?}，201原Memory创建回执。
   SHA256取确切原消息正文的UTF-8，绝不是编辑后的记忆草稿；正文可编辑确认。范围只允许全局null或原会话Project，不能传当前页面碰巧选中的另一项目。
3. GET /memories/{id}/provenance → {memory_id,sources:[{memory_version,session_id,message_id,content_sha256}]}。
   手工创建可为空，不能补造来源；history version不冒充当前版本。
4. GET /assist-sessions/{id}/memory：窗口revision、session_revision、remember、cleared_through_seq、checkpoint与最近requests。
   checkpoint.available=false时summary=null，来源数组为空；不能从本地缓存重新显示旧摘要。
5. POST .../{id}/memory/compact，body={command_id,expected_revision}，此处修订是session_revision；202 {session_id,request_id,status:"PENDING"}。
6. POST .../{id}/memory/requests/{request_id}/cancel，body={command_id}，200回执含status与cancel_requested。
   RUNNING取消只持久化意图；等查询变为终态才能显示“已取消”。
7. POST .../{id}/memory/clear，body={command_id,expected_revision,expected_session_revision}。
8. POST .../{id}/memory/remember，同clear加remember:boolean。
   clear/remember的expected_revision是工作窗口修订；实际开关变化还推进session_revision。成功后重读会话和窗口，不能把两种revision混用。
9. GET /assist-sessions/{id}/messages/{message_id}/memory → {session_id,message_id,recorded,available,checkpoint_id,sources}。
   recorded=false表示未采集，不能显示“未使用记忆”；sources包含直接与传递的安全引用，不是正文。
10. 原POST /assist-sessions/{session_id}/chat-commands支持 /compact 与 /压缩，202 result={kind:"MEMORY_COMPACTION",system:"compact",session_id,request_id,status:"PENDING"}。
   它复用同一整理Owner；菜单选择只插入草稿，发送才执行。原 /clear 和 /new 仍是新建会话，不能改成清除工作记忆。

新接口严格解析字段、布尔值、UUID、十进制revision和枚举；未知/缺失不伪装成false、空数组或成功。命令信封核对原command_id、对象ID与合法修订；同命令同载荷可重放，同ID异载荷409。

四、必须完成的用户路径

A. 设置：独立的自动使用已确认记忆、自动整理历史开关；读中/失败/有效/保存中可分辨。409重读并说明冲突，由用户决定；不自动覆盖。关闭整理仍可手动整理，关闭召回也不能沿旧摘要匿名使用旧记忆。

B. 保存：已完成的普通会话消息提供“保存为长期记忆”。读确切来源→显示可编辑标题/内容及全局/项目选择→明确确认→保存→展示服务端新Memory与来源。未完成、正文不可用、来源失效和范围改变不能保存；失败保留草稿。不要自动提取、确认或保存长期事实，也不要用浏览器时钟替代effective_status。

C. 短期：显示无摘要、有效摘要、摘要失效、读取失败；显示整理排队/运行/取消中/完成/失败。202后按request_id读回，适度轮询并在终态停止；切走立即停止旧读取，迟到响应不得污染新会话或Workspace。模型预算/来源/范围/Worker丢失等错误给可读原因，保留原历史，不自动换模型或重复收费调用。

2026-10-30 批次语义接续：后端整理现按有界完整轮次批次提交，一个 request 的 COMPLETED 只表示该次 `through_seq` 范围提交成功。自动链可能继续产生后续批次，原助手消息在此期间保持 PENDING；不要把一批完成显示成「全部上下文整理完毕」或 Task 完成，也不要由前端自动补发整理命令。继续从现有 memory GET 读取当前检查点与 requests，`source_message_ids` 仍为累计来源列表。普通 Agent 工具容量紧张时会停止声明新工具并收尾，装不下完整活动上下文时返回既有 MEMORY_CONTEXT_TOO_LARGE；保留工具账本，不提示用户盲重试或宣称动作已经回滚。接口结构未变；实现责任、兼容与验证边界以 HTTP §10.99 和统一验收条目093为准。

D. 清除与一次性：明确说明只改变后续模型窗口，不删除聊天、工具历史或长期事实。remember=false有可辨识的一次性状态；重新开启从新边界开始，不把关闭期间轮次并回。有在途消息或整理时展示服务端拒绝，指向等待或取消，不能靠UI清空宣称成功。不要把这个控制与新会话、删除会话混用。

E. 来源：长期详情能读保存来源；消息能查看本轮直接/传递记忆引用、确切版本、检查点与可用性。来源失效、未采集、合法为空和请求失败分开；不凭推断标“已确认/已使用/已成功”。摘要不允许直接改写成业务状态或权限，不提供“接受摘要就完成Task”。

F. 不确定命令：传输失败保留原command_id和载荷，复用getCommandReceipt核对原Owner回执，未知结果不能换ID重发；/compact的底层回执可能是RequestMemoryCompaction结果，不要要求服务端回执额外带前端包装kind。明确失败后才能由用户重新操作。重放、冲突、取消竞争与刷新后恢复都需走真实状态。

五、测试与交付

先用当前接口建立新增反例，记录有意义的红→绿；不写只镜像实现或无实际输入断言的测试。至少覆盖：
- client请求路径/两类revision/原文hash/confirmed/范围/202分支/回执身份；畸形响应严格失败。
- 设置关闭与CAS，切Workspace、迟到响应和未决命令核对。
- 保存成功/用户编辑/来源失效/hash冲突/失败保留草稿；旧三态与恢复不回归。
- 摘要无/有效/失效/读取失败，PENDING→RUNNING→终态，取消意图与终态分离。
- 清除与一次性开关的提示/修订/在途拒绝，/compact只在发送执行，/clear仍建新会话。
- recorded=false与available=false不能假装“没有使用记忆”；不回显缓存的失效摘要。

运行受影响的Workbench单元/组件测试、tsc与构建，保留发送、附件、流式、队列、命令菜单和Knowledge既有回归。共享红项先核对归属，不删除断言，也不回退他人改动。

随后在一次性测试Workspace与临时PG上跑真实API浏览器链：明确保存→详情来源→设置关闭→整理状态→重启/刷新读回→取消/失效→清除/一次性。真实Provider语义与缓存收益不由fixture证明；真实API/浏览器、Windows/WebView2与安装态分开报告，无环境就明确未验。不要为取证修改用户数据库。

按AGENTS做独立验收；派发时显式使用gpt-6.1-sol并给出只读/文件所有权，无法使用时如实说明，不能换模型或把自检改称独立验收。

更新工作台§40的实际接线状态、CODEX_NEXT_STEP与统一验收表，只更新受影响事实；结果只在验收表维护。运行node scripts/check-docs.mjs，检查事实源与链接。不要复制API整份契约到第二份文档。

完成标准：上述用户路径实际接到后端，状态/错误/未知结果真实，必要测试通过，独立验收问题修复复验，文档一致。遇到后端真实缺陷、不可安全合并的并行冲突或缺失授权，报告确切阻塞；不要制造假接口、关闭检查或悄悄扩大后端范围。最终说明修改文件、测试证据、真实环境已验/未验、文档同步与剩余限制。
~~~
