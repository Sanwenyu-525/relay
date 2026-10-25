# Relay / Personal Workflow OS

> 当前阶段、授权与下一步只看 [CODEX_NEXT_STEP](CODEX_NEXT_STEP.md)，已验证范围与剩余出口只看[功能验收表](docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)。取舍见 [ADR-010](docs/decisions/ADR-010-agent-stack-react-desktop.md)，工作包见 [M01–M07](prompts/stack-migration.md)。

当前已确认的产品主线是“用户表达意图 → Agent 推进工作并维护项目事实 → UI 展示变化、成果和必要决定”，减少重复填表、登记和衔接状态的操作。完整规则归[总纲 §0.8.1](Personal_Workflow_OS_Master_Spec.md#081-自然语言维护项目状态)；已有工程切片与完整产品目标分别核定，当前可用范围以功能验收表为准。

面向长期项目的人与 AI 协作工作系统，交付目标为 Windows 可安装应用，具有独立窗口和启动入口。仓库包含产品设计、业务契约、研究实验、UI 视觉规范、Fastify/Kysely/PostgreSQL 后端、React 工作台与 Tauri 桌面宿主。显式连接本机 API 后可走人工路径——创建项目 → 创建任务（含 ready）→ 开始 → 任务详情 → 保存 Markdown 产物版本 → 选择接受版本 → 完成 → 重开（[前端预览记录第 9、10 节](docs/development/前端预览实施与验收.md#10-ui-10-任务详情与-ui-11-产物编辑2026-09-21)），也可在待审页处理 Review、在 Run 页查看控制和追溯、在资料页管理 Knowledge/Memory/Decision/Rule。仓库还提供 Mock Runtime、模型端口、Context、Assist/首批 Skill 与蓝图、Today、内置工作台及文件/Git/CLI 的实现；实现与验收边界由上述功能验收表限定。后端接口见 [HTTP 契约第 10 节](docs/api/http-command-contract.md)。本项目与 AI Manga Drama Studio 独立。

当前工作区为 D:/Develop/Relay-Agent。阶段、已有证据、缺口及下一步统一见 [CODEX_NEXT_STEP](CODEX_NEXT_STEP.md)；旧迁入路径与变更经过见[交付审计](docs/development/design-audit.md)，不作为当前启动位置。

产品目标补充（2026-09-26）：降低并行委托 AI 时的注意力切换与上下文恢复成本，让开发者依据关键行为的验证证据接受成果。问题定义与目标见[产品总纲第 0.4 节](Personal_Workflow_OS_Master_Spec.md#04-ai-并行开发中的注意力与验收依据)；统一待处理队列、恢复摘要和面向需求的验收视图仍是待细化的体验方案，不表示现有功能已解决上述问题，也不自动改变当前开发范围。

P10 开发自检：后端真实 PostgreSQL 全量 158/158、P10 定向 7/7、Gateway 14/14、单测 57/57；前端 P10 定向组件 7/7，双方类型检查、构建及文档检查通过。四类信息有类型化根/版本、HTTP 命令与查询、真实资料页和有界字面搜索；Rule 在 Delegate 时冻结到执行契约，版本变化阻止旧 Run 继续准入。现阶段仍使用 Fake Runtime 与 Fake Gateway，生产进程停机证明、真实 Web/Git/CLI 与宿主外进程隔离尚未实现；这些开发自检不构成正式验收。下一段按 [P11 提示词](prompts/D-context-product.md#p11context-builder)接入 Context Builder。


<!-- DOC-ROUTER -->

> 本文件现为专题路由。完整正文已按原章节迁入下列分册，原章节标题与锚点保留为跳转入口；不要把路由文件当作完整规格读取，也不要在此追加实现正文。

## 分册导航

先按标题定位；命中后读取对应正文及其必要的公共规则。新内容修改所属分册，新增章节同步本路由；跨章依赖不因拆分而消失。

| 分册 | 章节范围 |
|---|---|
| [分册 01](docs/deployment/development/part-01.md) | 阅读入口 → workspace 与嵌套目录 |

## 原章节路由

以下仅保留兼容锚点，具体规则只在链接的正文维护。

## 阅读入口

[读取正文](docs/deployment/development/part-01.md#阅读入口)

## 当前可运行内容

[读取正文](docs/deployment/development/part-01.md#当前可运行内容)

## Windows 桌面开发包（M02）

[读取正文](docs/deployment/development/part-01.md#windows-桌面开发包m02)

### 临时试用固定 Mock Agent

[读取正文](docs/deployment/development/part-01.md#临时试用固定-mock-agent)

## 后端工程（apps/api）

[读取正文](docs/deployment/development/part-01.md#后端工程appsapi)

### V001/V002 持久化与 Workspace 初始化（P01/P02）

[读取正文](docs/deployment/development/part-01.md#v001v002-持久化与-workspace-初始化p01p02)

### 人工闭环 API（P02/P03）

[读取正文](docs/deployment/development/part-01.md#人工闭环-apip02p03)

## workspace 与嵌套目录

[读取正文](docs/deployment/development/part-01.md#workspace-与嵌套目录)

