# Windows 桌面应用与安装交付跑通任务书

日期：2026-11-09。状态：**待执行**。本文件是执行提示词，不是已实施记录；成绩只写[统一功能验收表](../docs/testing/overall-acceptance-2026-09-28.md#当前功能验收表)。授权：允许为跑通本模块做**最小产品代码修复**；不 commit/push，不重写桌面壳，不新增第二后端。

## 1. 目标与「跑通」定义

让用户从 Windows 安装包启动，得到可用窗口与真实后端，并在重启、升级、卸载、备份后仍可解释：

> 安装包 → 冷启动 → 单实例窗口 → 随包 Node/API/Worker/Supervisor → 真实 PG + 真实聊天可用 → 关闭重开/重启恢复 → 升级/卸载 → 数据根与备份可用。

「跑通」必须同时满足：

1. 安装态冷启动成功，窗口可见，API readiness 通过，聊天能用真实 Provider；
2. 重复启动聚焦已有窗口，不产生第二套 API/Worker/DB；
3. 随包 Node、supervisor 标记、API 构建 manifest/资源清单与当前源码一致，不跑旧暂存 API；
4. 安装、升级、卸载各有一次真实证据；升级失败 fail-closed，不破坏现有安装；
5. 数据根符合默认或显式绝对本地路径规则；备份/隔离还原不修改源根；
6. 文件 helper 与凭据 helper 在安装态可用；缺失时明确失败，不回落明文。

## 2. 开工检查与必读事实源

1. 读根 `AGENTS.md`、[CODEX_NEXT_STEP](../CODEX_NEXT_STEP.md)；验收表搜索桌面 P00、Windows/WebView2、安装态、单实例、API 版本偏差。
2. 读 [ADR-007](../docs/decisions/ADR-007-windows-desktop.md)、[本机部署](../docs/deployment/本机部署.md)、[Windows 加固记录](../docs/testing/desktop-windows-hardening-2026-10-25.md)、[验证计划 §Windows](../docs/testing/verification-plan/part-01.md)、[M07 备份恢复](../docs/development/m07-backup-recovery.md)。
3. `git status` 有大量未提交改动；本链相关文件包括 `apps/desktop/src-tauri/**`、`apps/desktop/scripts/**`、`apps/api/src/main.ts`、`config.ts`、`credential-env.ts`、`apps/api/src/cli/backup.ts|restore.ts` 及相关测试。逐文件读 diff，不覆盖、不回退。
4. **构建前必须查磁盘**：`Get-PSDrive` 看剩余空间；低于 15 GiB 或分区 10% 先报告并处理安全范围内的冗余产物。Tauri/Cargo/NSIS 构建属高开销操作。
5. 单实例固定互斥体是验收约束：需要真实窗口验收时先确认已有实例归属；不得杀陌生进程或改名绕过。维护会话/关闭现有实例前先取得授权。
6. 行号可能移动；下表入口先 `rg` 复核。

## 3. 当前实现地图

| 环节 | 当前入口 | 关键事实 |
|---|---|---|
| Tauri 配置 | `apps/desktop/src-tauri/tauri.conf.json:3-8/18-23/28-40`；`tauri.installer.conf.json` | Tauri 2.11.6、WebView2、NSIS；resources 含 node/file-io-helper/computer-runtime/extension/api |
| Rust 入口 | `apps/desktop/src-tauri/src/main.rs:1-5` → `lib.rs:1191-1253` | 宿主模块 `lib.rs:18-28` |
| 单实例 | `lib.rs:96-98/294-330` | `Local\RelayAgentDesktopSingleInstance`；重复启动 exit 23 |
| 主窗口 | `lib.rs:1080-1113`；关闭 `:1238-1241` | 关闭主窗口即停止宿主 |
| API/Worker | `lib.rs:830-921` | 资源存在性、supervisor 协议、Node 版本、API 子进程、readiness、有界重启 |
| API 握手 | `apps/api/src/main.ts:102/220-233` | 桌面端握手/readiness |
| 开发入口 | `apps/desktop/scripts/dev-desktop.ps1`；`scripts/desktop-dev.ps1`；`apps/desktop/scripts/stage-api.ps1` | 暂存按内容指纹；`-SkipApiRefresh` 可跳过刷新 |
| 构建/安装 | `apps/desktop/scripts/build-release.ps1:41/53-80/229-233/321/355-397` | 双次输入指纹、manifest、payload、POSTINSTALL seal |
| 安装验证 | `apps/desktop/scripts/verify-installer.ps1:45-121` | 含静默升级与 manifest 绑定检查 |
| 数据根 | `lib.rs:847-859`；`apps/api/src/config/config.ts:126-160` | 绝对本地路径、非 UNC、非盘根、不在源码仓库内 |
| 备份/还原 | `apps/api/src/cli/backup.ts`、`restore.ts`、`restore-check.ts` | 停机备份、隔离还原、源根不变 |
| helper | `lib.rs:875-876/892-893`；`tauri.conf.json` resources | 文件 helper 随包；**凭据 helper 未出现在 resources/构建拷贝清单** |

## 4. 已验收范围与未闭合项

- **P00 桌面宿主**：局部通过（目录包、真实 WebView、单实例、readiness 拒绝、强杀回收）；安装、服务重启凭据轮换、IME/DPI、完整 frame、Electron 对照未验。
- **真实窗口/WebView2**：2026-10-25 打包边界与人工链通过，但输入为 Playwright 合成；多 DPI/原生 IME/多屏未验；10-22、10-26 独立验收为未通过/BLOCKED。
- **安装/卸载**：历史 14/14 通过；**升级曾实测 exit 4**。代码后续已加 manifest payload 与 POSTINSTALL `seal-install`，验证脚本已含静默升级，但未找到修复后的实跑日志。
- **单实例**：已实现并被观察到；固定互斥体使并行验收被旧窗口阻塞。
- **API 一致性**：构建期有内容指纹/manifest；**冷启动运行期只查资源存在、supervisor 协议、Node 版本，不读 manifest**，历史上出现过旧 API 继续跑。
- **数据根/备份**：校验已实现；安装态数据根、junction/重解析点、满盘、备份后隔离还原未形成闭环。
- **凭据 helper**：`relay-credential-helper.exe` 未出现在 `tauri.conf.json` resources 与 `build-release.ps1` 拷贝清单；API 缺省在同目录找它，安装态 DPAPI 凭据链存在静态缺口。

## 5. 范围与非目标

**范围内**

- 安装态冷启动、窗口、API/Worker/readiness、真实聊天。
- 重启/重复启动、单实例、旧实例/维护停机。
- 构建 manifest 与运行期一致性、Node/supervisor 版本。
- 安装、静默升级、卸载；数据根、备份、隔离还原；文件/凭据 helper。

**范围外**

- 业务功能正确性（聊天/Task/Run 另有任务书）。
- 重写 Tauri 壳、Electron 方案、代码签名、自动更新、多窗口、托盘/自启。
- 新后端/领域 IPC；所有业务仍走 HTTP 命令与回执。
- 用浏览器、Vite dev 页面或 `dev-desktop.ps1` 替代安装态证据。
- 未获授权时关闭他人窗口/进程、删除安装目录或用户数据。

## 6. 实施顺序

1. **先读现有安装产物与日志**：确认当前安装版本、manifest、Node 版本、helper 清单；不要先重建。
2. 查磁盘；空间不足先报告并清理可再生产物（保留发布包、验收基线、用户数据、DB、他人产物）。
3. 跑 S1 冷启动 → S2 单实例/重启 → S3 版本一致性；再跑 S4 安装/升级/卸载 → S5 数据根/备份 → S6 helper。
4. 每个失败先定位到「Tauri 配置/宿主启动/资源清单/manifest/安装钩子/数据根/helper」哪一层；只改阻断点。
5. 修改后重跑同一场景；涉及构建时记录输入指纹与产物摘要，避免旧包冒充新包。

## 7. 验收场景

### S1 安装态冷启动（P0）

- 从安装包安装 → 启动 → 窗口可见 → `desktop_bootstrap`/readiness 通过 → 真实 PG/API/Worker 下聊天可用。
- 断言：不是 dev 页面、不是旧暂存 API、不是浏览器窗口。

### S2 单实例/重启（P0）

- 重复启动聚焦已有窗口（exit 23/提示）；关闭主窗口后 API/Worker 停止；重开正常；无重复 DB/端口占用。

### S3 版本一致性（P0）

- 校验随包 Node 版本、supervisor 协议标记、API 构建 manifest/资源清单与当前源码一致；`/health/ready` 通过。
- 断言：运行期能发现/拒绝明显陈旧 API，或至少给出可核对指纹。

### S4 安装/升级/卸载（P0）

- 静默安装 → payload 完整 → 运行中升级走维护停机 → 失败 fail-closed → 卸载默认保留数据。
- 断言：升级后 manifest 重新封签且与安装 EXE 一致；exit 4 类失败不再出现或如实保留失败证据。

### S5 数据根/备份（P0）

- 默认 `%APPDATA%\dev.relay.agent\data` 与显式绝对本地根；非法路径拒绝；备份创建、隔离还原、源根不变。

### S6 helper（P0）

- 文件 helper 随包可用；凭据 helper 存在时 DPAPI put/check/resolve 正常；缺失时明确失败，不回落明文。

## 8. 修复边界

- 宿主只负责窗口、受控启动、连接引导和进程生命周期；Rust 不复制 Workflow/领域规则。
- 不绕过单实例：不改名、不杀进程、不并行强开。
- 不把 dev 脚本/浏览器当安装验收；Vite/浏览器成功不能替代真实窗口或安装产物。
- 不新增第二后端或通用 IPC；保留 HTTP 命令、幂等键与回执。
- 不削弱 restore isolation、不删用户数据、不杀陌生进程；安装/卸载/恢复失败保持 fail-closed。
- 构建前查磁盘；未处理预警不得继续堆积 Cargo/Tauri 构建。
- 不删除/弱化失败测试；不 commit/push。

## 9. 环境与证据

- 记录 Windows 版本、WebView2 版本、安装包路径/摘要、Node 版本、manifest、数据根。
- 真实窗口证据：截图/窗口句柄/readiness；合成输入与原生键鼠/IME 分开报告。
- 证据目录：`tmp/WINDOWS-DESKTOP-20261109/`；保存安装/升级/卸载日志、截图、manifest、helper 清单。
- 高开销构建记录前后磁盘空间；未清理产物说明原因。

## 10. 完成定义

1. S1–S6 全部有真实安装态证据；无法执行的项（如签名/多 DPI）明确标注未验。
2. 安装/升级/卸载至少各一次真实运行；升级修复有修复后证据，不再引用旧日志。
3. 没有绕过单实例、没有把 dev/浏览器当安装态、没有密钥或用户数据泄露。
4. 验收表更新一行；`CODEX_NEXT_STEP` 只写当前状态与剩余限制。
5. 报告区分开发窗口、真实 WebView2、安装态、升级、备份恢复；未做独立验收明确标注。

## 11. 已知基线与坑

- 固定单实例互斥体：并行验收会互相阻塞；先确认已有实例归属，必要时走维护停机协议。
- 旧安装包/旧 API 产物可能早于当前源码；不要用旧日志证明新代码。
- 升级曾 exit 4；代码修复不等于安装态通过，必须有修复后的实跑证据。
- 凭据 helper 可能未随包；API 缺省在同目录找 `relay-credential-helper.exe`，缺失时会失败而不是明文回落。
- 磁盘低于阈值先报告；不要为了跑构建清理他人产物、数据库或发布包。
- 浏览器/Playwright 证据不能替代真实窗口、原生输入、多 DPI 与安装态。
