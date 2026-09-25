# ADR-007：Windows 桌面交付与本机服务边界

> 2026-09-23 接续：用户明确完整迁移现有界面至 React，窗口内容相关的 Vue 描述已更新。Windows 安装交付继续有效，Tauri 2 + Node sidecar 为优先实施方案，框架实测/安装门槛仍须完成，见 [ADR-010](ADR-010-agent-stack-react-desktop.md)。

## 状态与日期

2026-09-19。交付范围已由用户明确确认：Windows 可安装应用，有独立窗口和启动入口。以下框架、打包和生命周期细节仍为 **Proposed**。2026-09-20 已有隔离最小宿主的局部实现与实测记录，范围及限制见 [P00 研究记录](../research/p00-source-study.md#最小-windows-桌面宿主实验)；不代表生产桌面、安装交付或本 ADR 全部出口通过。替代 [ADR-003](ADR-003-browser-workbench.md) 的浏览器交付提案；不改变 [ADR-006](ADR-006-typescript-first.md) 的 TypeScript 业务主栈建议。

## 背景

原提案假设无需原生窗口，因此选择同机浏览器。用户已明确安装应用的目标，需要由应用管理窗口、本机服务启动、连接凭据与退出。现有四张图继续作为客户端内容区的视觉依据，不重做产品风格。业务事实、权限与恢复仍归原领域和应用用例所有。

## 候选与推荐

| 方案 | 适配理由 | 代价与待验证项 |
|---|---|---|
| Tauri 2 + Node sidecar | 承载 React 与 TypeScript API/Worker；Windows 使用 WebView2，值得优先验证整体资源占用 | 增加薄 Rust 壳、Node 运行时分发、WebView2 前提与跨进程监管；不保证总内存一定更低 |
| Electron + Node 业务进程 | 与 TypeScript/Node 工具链衔接直接，渲染运行时随应用分发 | Chromium 与多进程资源成本需实测；内置 Node 不自动等于后端候选版本 |
| 同机浏览器 | 分发简单，可作开发调试入口 | 不满足用户确认的独立安装应用交付，退出候选 |

推荐先验证 **Tauri 2 + Node sidecar**，Electron 保留对照。在相同 React 页面、API/Worker、PG 数据量和工作负载下比较冷启动、整棵进程树 RSS、API p95/吞吐、安装体积与维护成本；PG 占用单列并计入整机总量。框架宣传或空壳测量不能证明 Relay 整体性能。若 sidecar 打包、资源收益或可靠性不满足预算，再用同一协议评估 Electron；冻结前记录结果与取舍。

能力依据：[Tauri 外部二进制](https://v2.tauri.app/develop/sidecar/)、[Windows WebView2](https://v2.tauri.app/reference/webview-versions/)、[Tauri capability 边界](https://v2.tauri.app/security/capabilities/)、[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)。这些文档证明框架机制存在，不证明本项目组合已通过。

## 进程、通信与权限

```text
Windows 启动入口 → 桌面壳 → 单个 React 窗口（随包静态 UI）
                       → Node API + 独立 Worker（阶段 B 起）
React → 已鉴权 loopback HTTP → Application / Domain / Gateway → PG / 工具
```

桌面壳只负责窗口、受控启动、连接引导与进程生命周期。Rust 不承载第二套 Workflow/领域业务；Node 业务进程保持短事务与原恢复协议。Renderer 不直连 PG，不持有 DB/Provider 密钥，不获得通用 shell、文件系统或任意 IPC 调用权。

保留 Fastify HTTP 命令、幂等键和回执，不另建第二套领域 IPC。窄 IPC 只向受信本地窗口交付当前实例的连接信息和受限生命周期操作；校验调用窗口、主 frame、载荷与实例归属，远程内容无此能力。当前实例的短期 Bearer 可以进入 renderer 内存，不能写入 URL、持久存储或日志；其权限仍由后端逐请求校验。启动握手、CORS/CSP 和刷新重连详见[部署设计](../deployment/local-deployment.md)，不以“桌面应用”替代鉴权。

## 生命周期与安装

推荐 V1 单窗口、单实例；重复启动聚焦已有窗口。关闭窗口表示退出应用，最小化仍可执行；不隐含托盘驻留、开机自启、自动更新、多窗口或跨设备功能。此行为是待桌面验证的推荐，不是用户已逐项接受的交互。

退出先处理未保存草稿，再停止新命令/领取，让已在途工作进入有界安全结束；超时不能伪造成功、取消或安全释放。强杀、壳崩溃与系统关机依靠已持久化意图恢复，不能假定退出回调一定运行。Windows 进程树终止与孤儿进程检测必须实测；无法证明旧写进程结束时继续隔离资源。重启先核对旧 claim、控制请求和 UNKNOWN，再允许相应工作恢复。

安装包随附应用所需 Node 运行时和前端，不要求用户手动启动终端或浏览器。本机 PG 仍为独立安装并运行的前提；推荐安装器不捆绑、不静默安装/卸载 PG。WebView2 引导、签名与目标 Windows/CPU 支持矩阵待验证。安装目录与用户数据分离，升级经过安全停机与 schema 检查，卸载默认保留业务数据。

## 影响与后续

影响需求交付形态、桌面宿主、前端来源、启动凭据、部署、UI 适配、P00/P04/P20 和验收。HTTP 路径/业务 DTO、数据库模型和 Task/Run 状态不变，业务 API Breaking Change：No。未发布的部署/连接方案改变，不声称兼容旧浏览器启动体验。

先完成[桌面验证出口](../testing/verification-plan.md#7-windows-桌面交付验证)，再锁定壳框架与安装方式。与 ADR-006 的三个业务 Spike 分别报告；能安装并打开窗口不代表业务闭环或恢复验收通过。
