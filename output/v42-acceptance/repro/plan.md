# 成果版本正文读取失败·排查与修复记录（2026-10-15 本轮）

状态：Phase 1 完成，Phase 2/3 进行中。

## 已固定身份（relay_trial DB, 127.0.0.1:12525）

- Task: 2b50758f-dc84-4350-b342-5fe9edaa5a06（截图种子：完成与产物血缘（勿人工改））status=DONE
- CompletionRecord: 820ca548-60f9-469b-8fe3-6bff8d9081bb，state_delta.artifact_version_ids=[ecbe6fcf-5cbe-40fe-b31b-7be578f841fa]
- Artifact: 9a458b1f-767d-46b9-a7a7-987cd88db082（截图种子产物.md）
  - v1 b5dbf96f-d029-4468-aa87-500f13550894 size=62 sha256=f1ca1c99...9f992e050672ae304fbaec665
  - v2 ecbe6fcf-5cbe-40fe-b31b-7be578f841fa size=77 sha256=9e028123...6a7afb49b4b06fdcd00d2b
- workspace: b34f1735-63f4-4962-a2ea-dc340439b608（等于桌面试用 workspace）

## 读取链与断点

前端 selectedArtifact.version.artifactVersionId → getArtifactVersionContent → GET /api/v1/workspaces/{ws}/artifact-versions/{id}/content
→ readArtifactContent → readArtifactVersionInWorkspace（DB 行存在，元数据 OK）
→ storage.readWithHashCheck(.relay-test/data/artifacts/9a458b1f/<vid>/content.md)
→ 文件 ENOENT → status=MISSING → 503 EVIDENCE_UNAVAILABLE（detail=受管内容文件缺失）

## 存储事实

- 试用环境 data root：D:\Develop\Relay-Agent\.relay-test\data（由 scripts/test-desktop.ps1 设置 RELAY_DESKTOP_DATA_ROOT；运行中桌面 API sidecar PID 27376 → 127.0.0.1:8728）
- 种子 v1/v2 文件在该根下缺失。
- 同一字节内容存在于 D:\Relay-Agent-data\artifacts\9a458b1f-...\<vid>\content.md（dev 环境 apps/api/.env 的 RELAY_DATA_ROOT），size/hash 与 DB 登记值完全一致，mtime=2026-10-11 14:58:51（=建版同秒）。
- 结论候选：种子创建时经 dev 数据根发布，读取环境为试用根 → 环境/配置错配（类别 C），数据库行与前端均无缺陷。

## 同环境可读对照

- Artifact 0898fbbe-288a-493e-98ce-393ac4880ba9（截图种子：委托 Run（勿人工改）（候选），AI）
  version 6beab176-b7f7-471e-b830-ff7c7ef5fbad：size=2439 sha256=4915d4bc...
  文件存在于 .relay-test/data，hash/size 与登记一致 → 供真实 API 正常读取对照。

## TODO（下一步）

1. helper 写入探针（临时根）
2. 启动本轮复现 API（当前源码 dist；trial DB + trial root）→ 采集 ecbe6fcf 503 EVIDENCE_UNAVAILABLE 与 6beab176 200 的真实响应
3. 失败测试先行 → 修复判定（若无需产品修复则记录；如需修复走 TDD）
4. 浏览器验收（vite 4173 + 本 API）
5. 文档同步 + 收尾清理
