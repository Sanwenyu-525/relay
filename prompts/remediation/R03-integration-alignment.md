# R03：前后端接入前的契约与能力对齐

状态：已执行（2026-09-21）；依赖 R01/R02 的修复结果。本任务只完成已有边界对齐，不自动实现缺失 API、完整 P04 或真实联调。

执行结果：前端 `InteractionMode` 已从 `HUMAN` 对齐为 API `ME`，`executor_kind=HUMAN` 保持独立；Task 与验收 revision 改为十进制字符串，并新增超过 `2^53` 的比较/递增回归。页面到真实 API 的精简映射、未接入能力和 schema readiness 前置见[前端预览记录](../../docs/development/ui-preview-acceptance.md#7-r03接入前契约与能力对齐)。所有页面仍调用内存 `fixtureAdapter`，未写入 Bearer、未接真实 API，不能称为联调通过。

```text
请在 D:/Develop/Relay-Agent 完成真实接入前的契约对齐与缺口确认。
先读 AGENTS、CODEX_NEXT_STEP、本轮验收报告 INT-01–03、HTTP 契约第 10 节、
apps/api/src/api 的真实 schema/路由，以及 apps/workbench 的 types/fixtureAdapter。
原开发提示词只作背景，不能当接口已实现的证据。

一、逐项核对已有页面需要的能力。
在现有前端验收文档中维护一张精简映射表：页面动作→真实路由/DTO→当前可用性→缺口。
至少核对项目列表、创建、归档、资料导入、全空间/项目/Inbox 任务查询、创建/ready/start、
依赖、interaction-mode、四项 Skill、命令回执。读实际代码，不按按钮名称发明 endpoint。
现有 API 的列表过滤/分页范围与前端全部任务不同，不能通过忽略筛选假装对齐。

二、消除已知类型歧义。
Task.mode 的人工模式按 API 使用 ME；executor_kind 的 HUMAN 保持独立。
前端可保留“人工执行”的中文标签，不能把两个枚举混为同一事实。
API revision/acceptance_revision 为十进制字符串，前端不得转 Number 丢精度；
补 >2^53 的往返/比较用例。只在已有消费边界转换，不造第二套 schema。
fixture 专用 ID 可以保留，但不得直接当生产 UUID 提交。
标明 INBOX/READY/IN_PROGRESS 等真实当前状态与 WAITING/BLOCKED 示例状态的能力差异。

三、明确不能接通的动作。
缺失接口继续标注 fixture/待接入或禁用，并解释原因；不自动补 archive、导入、
Skill 后端、Run、Review 或全局任务 API，也不让页面只写内存却宣称保存到数据库。
真实 Bearer 不能写入源码、fixture、截图、日志或持久化浏览器存储。
列出最小联调前置和可验收路径；不要仅把 dev-stack 两个服务启动算作联调成功。

四、核对 schema readiness 的接入前置。
当前 /health/ready 只 ping DB，未验证迁移兼容，这是已记录限制。
先明确本阶段如何区分 DB 可连接与业务 schema 可用，并给出最小兼容检查方案与验收条件。
若本次只被授权契约对齐，保持此项为独立待实施项；不要偷偷修改启动策略或自动运行 migration。
后续实施至少覆盖空库、缺最新迁移、正确 schema、未知新版本，并保留 live/ready 区分。
任何新增响应/错误语义都要同步 HTTP 文档，标注 Breaking Change/兼容策略。

验证真实存在的 DTO 映射、精度与能力判断；若未连接真实 API，明确写“未联调”。
本任务新增代码只限现有前端类型/映射/能力显示所需最小改动，不写空壳客户端。
更新既有事实源和 CODEX_NEXT_STEP，运行相关前端测试、构建及 node scripts/check-docs.mjs。
最终交付：已对齐项、仍缺接口、可进入联调的最小范围、尚需另行实施的工作。
```
