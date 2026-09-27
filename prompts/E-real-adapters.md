# E：真实 Files、Web、Git 与受控 CLI

> 当前执行入口为 [M01–M07](stack-migration.md)。本文件保留原 P 阶段业务范围；模型统一 gpt-6-sol / ultra，UI 使用完整 React 迁移路线，技术选择按 ADR-010。不得按旧编号重建工程；前置与验收按公共契约及当前授权执行，后置不等于通过。

## P16：Files 与变化集

```text
执行 P16，前置 P09/P15。读 AGENTS.md、prompts/README.md、docs/architecture/tool-adapters.md、contracts/04-recovery-and-commit.md、docs/frontend/workbench-design.md。
源码对照：按公共“本地源码参考要求”从 .research 的 Codex/Pi/DeepSeek Harness 定位相关文件工具与错误处理，记录适用机制及 Relay 变化集、资源排他和部分成功核对的差异。
范围：受管读取、工作根读取、隔离候选变化集、逐文件显式应用和 diff UI。全部通过 Gateway，规范根与链接/重叠检查，保护应用配置/凭据/DB 目录；不接受任意绝对路径。Task 排他不能代替资源排他。
保存每文件基线与目标 hash、动作及应用结果。对外部编辑冲突保留候选，不覆盖；多文件部分成功进入核对，不用 DB 回滚假装文件撤销。对自由编辑仓库准确说明无跨编辑器绝对隔离。
接续工作台第 10/11 节的成果共创：本次变化说明须关联修改范围、来源/目标版本及未处理部分，旧验证不转移给新内容。局部锁定、依赖传播和跨成果影响仍先确认设计，不能以已有逐文件 diff 宣称完整共创已交付；范围外与并发修改不得覆盖。
用临时目录测试 D07/D09/D10：链接逃逸、别名、重叠、基线变更、部分写入中断、旧 claim、非法删除。核对真实内容与证据，再连接 Development 页面；未通过的写能力禁用且明确未完成。
```

## P17：公共 Web 与 Knowledge 导入

```text
执行 P17，前置 P09/P10/P15。读 AGENTS.md、prompts/README.md、docs/architecture/tool-adapters.md、docs/api/module-api.md、docs/architecture/information-planning.md。
源码对照：按公共“本地源码参考要求”检索 .research 中相关网络工具的边界与测试；没有满足本项目公共 Web 准入的实现时记录检索范围和缺口，不把普通 fetch 包装视为已满足 SSRF 防护。
范围：受控公共 GET/HEAD、URL 导入 job、正文提取/版本证据。RUN 和 USER_IMPORT 均用类型化作用域与权限；后者不伪造 Run，也不是免检查。每跳检查协议/目的地址、将解析校验与实际连接绑定、限制超时/解压后大小；不转发凭据或执行网页 JS。
保存原/最终 URL、时间、hash、提取器与可用性；重抓新版本。登录/付费正文不可得明确未验证，DOI 可解析不等于论断支持。
验证 D11/C05/A06：重定向私网、DNS 变化、响应过大、坏编码、断网、页面变化、正文不足。网络测试用 Fake/受控服务，不能关闭生产策略过测试。联调资料导入与 Context 来源，补文档和真实测试证据。
```

## P18：Git 适配器

```text
执行 P18，前置 P16。读 AGENTS.md、prompts/README.md、docs/architecture/tool-adapters.md、contracts/03-verification-and-approval.md、contracts/04-recovery-and-commit.md。
源码对照：按公共“本地源码参考要求”检索 .research 中相关仓库操作、命令准入及失败处理；明确上游工具与 Relay 固定 Git 动作、批准绑定及 reconcile 的差异，不照搬任意 Shell 能力。
范围：受控 status/diff/log、隔离 worktree/分支、指定文件暂存、commit/push 审批与 reconcile。使用固定可信 Git、结构化参数与实际仓库配置检查，禁外部 diff 等非必要执行路径；hooks/filter/helper 信任明确。不开放任意 git args、强推、reset --hard/clean。
commit 绑定 parent/tree/message/config，push 绑定 remote/ref/commit 和远端预期；目标变化原批准失效。外部成功响应丢失先核对，不能再做一次；worktree 共享元数据仍需资源锁。
产品补充核对：隔离分支不是组合正确性的证明。任务成果组合后的 tree/commit 与各自受验版本分别记录，原分支测试不自动成为合并版本证据；本次未包含真实合并流程时如实保留该缺口，不擅自新增自动合并或跨项目写权限。
测试 C03/C09/D02/D03/D09：审批内容变更、重复动作、remote 变化、hooks 变化、失败状态和恢复。只操作一次性测试仓库及本地测试 remote，不向用户真实远端推送。连接 Review/Development UI，交付实际执行证据。
```

## P19：受信 CLI 与进程恢复

```text
执行 P19，前置 P18。读 AGENTS.md、prompts/README.md、docs/architecture/tool-adapters.md、docs/deployment/local-deployment.md、docs/testing/verification-plan.md。
源码对照：按公共“本地源码参考要求”核对 .research 中相关执行器的取消、超时、输出限制和进程管理测试，并结合 desktop-p00 已有证据；非 Windows 机制不能直接当作本机进程树回收证明。
范围：固定 RUN_BUILD/RUN_TEST 模板、ExecutionConfig 信任、最小环境、时间/输出上限、进程树控制、核对恢复。先验证目标 Windows 上的进程组封装；ProcessBuilder/cwd/白名单不称为沙箱。只支持明确受信项目，未知代码保持 DENY。
执行文件/参数/脚本/构建配置变化重新校验。记录基线、测试集合/配置 hash、实际 argv、exit code 和输出；测试被删/跳过不能算 required 通过。取消核对整个受管进程树，PID 复用不误杀；不能证明旧进程停止时保留 QUARANTINED。
按工作台第 11.3/11.4 节交付重要要求到实际检查证据的映射及未覆盖项；外部执行自报完成不替代命令回执/受验产物身份，测试退出 0 不证明需求完整覆盖。首个外部 Coding 执行入口未选定时先明确能力与回执契约，不从受控 CLI 自动扩成多个 Agent Connector；组合版本需要对应检查记录，缺失则标未验证。
在一次性工程验证 D07–D10/C06：孙进程、超时、输出过量、改脚本、环境凭据、不合法参数、重启后迟到结果。接通 Development 固定 workflow，运行 E 阶段真实验收并列出能力限制，不虚构隔离保证。
```
