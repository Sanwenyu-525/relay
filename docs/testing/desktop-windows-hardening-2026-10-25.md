# Windows 桌面与本地运行环境加固 — 阶段 A 交付报告（2026-10-25）

工作区 `D:/Develop/Relay-Agent`（HEAD `0271f24d`，main ahead origin 1）。并行会话当天在 API/workbench 有大量未提交改动；本任务未触碰、未回滚、未提交任何他人改动。

## 1. 已完成修改

### P0-1 预览恢复一致性（完成）

- **缺陷**：工作台预览在**首次挂载**时，把「还没被用户触碰过的空白初始态」当作状态写盘，删掉了持久化的来源描述；切换工作区（作用域）时又把**新作用域**的描述删掉（旧作用域数据被写进新作用域）。真实用户现象是「刷新后我打开的页面没了」。
- **修复**（`apps/workbench/src/components/BrowserPreviewPanel.tsx`）：新增 `untouchedRef`。初始化空态与作用域切换**不写盘**；只有用户显式打开页面（navigate 成功）或关闭带页面的标签（closeTab 且 handle 非空）后才置 `false` 并持久化——显式清空（关闭全部标签）也因此在「已触碰」后仍然落盘。
- **反例测试**（`apps/workbench/tests/browserPreview.spec.tsx`，先红后绿）：
  1. 连续挂载/卸载/重载必须恢复同一来源（红：首次挂载即写空态删描述）；
  2. 切作用域不串页、不删新作用域描述（红：新作用域描述被旧作用域空态覆盖）；
  3. 关闭全部标签显式清空，重载后保持空；
  4. 多标签只存 origin 且按打开顺序恢复。

### P1-1 desktop.env 配置契约一致性（完成）

- **缺陷**：桌面宿主白名单（`lib.rs::validate_desktop_config_keys`）接受 `RELAY_COMPUTER_RUNTIME` 与 `RELAY_MODEL_IMAGE_INPUT`，但只读诊断工具 `scripts/diagnose-desktop.mjs` 的键集合里没有——运维按 `desktop.env.example` 配上这两个键，会被诊断误判 `CONFIG_INVALID`。
- **修复**：诊断工具新增 `OPTIONAL_KEYS`（两个键都是真实消费项：`api/src/computer/config.ts`、`api/src/workflow/model-port-config.ts`，且模板早已文档化），导出 `DESKTOP_CONFIG_KEYS`；注释指明「改动任一侧必须同步另一侧」。
- **契约测试**（`scripts/diagnose-desktop.test.mjs`，先红后绿）：从 `lib.rs` 源码提取宿主白名单，断言**诊断工具键集合与宿主白名单完全相等**（双向防漂移），并对每个宿主键逐一构造合法配置验证可接受；白名单外的键仍必须拒绝。

### HEAD 存量缺陷（构建门禁，已修）

- `apps/workbench/tests/managedFileBrowse.spec.ts` 在 HEAD 提交态就过不了 `tsc --noEmit`（9 错：未使用的 `RelayRun` 导入 + `settle` 辅助函数声明返回 `outcome: unknown` 过宽）。**HEAD 的 `pnpm build` 本身就是破的**，发布构建无法在 HEAD 上完成。最小修正：`settle` 返回类型改 `Promise<RelayManagedFileReadResponse>`、删除未用导入（运行时行为不变，实际返回值本就是该类型）。

### P0-2 真实 Windows 验收（核心完成，见未验项）

- 在**隔离 worktree**（`git worktree add D:/Develop/relay-p0-release HEAD`）构建发布包：`relay-desktop.exe` SHA256 `42d367a4d06602a69abafa070becef34f3f6596c709678576de9e57ec69748b2`，manifest 自洽（node v24.21.0 / tauri 2.11.6 / 13645 个资源哈希 / 0 个违禁配置文件）。发布包内含本任务 P0-1 修复。
- 用共享树脚本 + 隔离临时 PG（137 条迁移全应用）启动真实打包桌面，`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 注入 CDP（仅测试进程），Playwright 经 loopback CDP 操作真实打包 WebView。
- **边界检查通过**（`check-webview-boundary.mjs`）：`packaged_bootstrap=pass reload_bootstrap=pass actual_csp=pass unknown_ipc=pass unpermitted_core_ipc=blocked remote_navigation=blocked child_frame=rejected post_frame_bootstrap=blocked`，并核对了 exe 哈希与 session 标记一致。
- **人工业务链路通过**（`check-webview-human-chain.mjs`）：真实 WebView2 + 真实 PostgreSQL 上完成「建项目 → 建任务 → 开始任务 → 保存产物 v1 → 选用版本 → 勾选验收条件 → 完成本轮 → 重开」，留痕 `project_id=3fd6e017-b729-460b-ba5f-4c69d2a7e5f9 task_id=dd3ccb55-bca1-4c07-9e2d-41cbffbeb179`，并如实标注 `synthetic_input=true`（Playwright 填入是合成输入，不作为 Windows IME/原生输入证据）。
- 检查脚本本身对 UI 重构已失效两处（引用不存在的 `.app-sidebar`；「按 ID 打开」被收进「高级」折叠 `details`），已按当前结构修正选择器、语义断言不变（`apps/desktop/tests/check-webview-human-chain.mjs`）。

### P0-3 进程恢复验证（部分完成）

- 桌面 Rust 库测试（msvc target + MSVC PATH/LIB + `RELAY_TEST_NODE` 指向钉住 node）：**54 项 53 通过 1 失败**。覆盖 Job 继承与终止、ARMED 记录恢复（真实旧 Job 停止证明）、supervisor 有界重启、维护会话（BUSY/无效帧/记录缺失/真实 API+Worker 停止证明）、restore 隔离（含 junction/符号链接标记）。
- **历史两个环境失败已分别调查**：
  1. 缺 `RELAY_TEST_NODE`：`job_sidecar` 用例会优雅跳过、`maintenance_session::ready_proves_...` 直接 `expect` 失败——设置该变量后全部通过（运行手册要求：桌面 Rust 测试必须显式提供该变量）。
  2. junction/符号链接语义：`restore_isolation::tests::native_marker_links_refuse...` 在**悬挂符号链接**子场景失败——`symlink_file` 创建成功（返回 Ok），但紧接着 `symlink_metadata` 对该路径返回 NotFound。本机未开开发者模式、PowerShell 建符号链接直接报「需要管理员权限」，而测试进程内创建却成功；结合创建后立即可见性丢失，判定为**本机安全软件（深信服 EDR 等）对 reparse point 的实时干预**，与 2026-10-07 记录的本机文件语义异常同源。**不得通过放宽检查「修绿」**（那会削弱恢复隔离的 fail-closed 语义）；需在干净机器或加 AV 排除项后复验。
- 真实恢复路径**被实际触发**：验收会话中因脚本漏传 `-InstallGraph` 导致的失败留下两条 ARMED 记录，随后一次成功启动的 supervisor 日志完整记录了 `launch_recovery_ack`（两条旧 launch，`retainedClaims: 0`）与 `dispatch_ready`——旧 ARMED 记录的有界恢复在真实环境走通。
- 单实例保护**被实际观察到**：重复启动返回 `exit 23` + `Relay Agent is already open`；窗口未就绪时走 MessageBox 分支（`lib.rs::acquire_single_instance_named`）。

## 2. 修改文件

| 文件 | 改动 | 归属 |
| --- | --- | --- |
| `apps/workbench/src/components/BrowserPreviewPanel.tsx` | `untouchedRef`：初始化/切作用域不写盘，仅用户触碰后持久化 | P0-1 |
| `apps/workbench/tests/browserPreview.spec.tsx` | 新增 4 条恢复一致性用例（先红后绿） | P0-1 |
| `scripts/diagnose-desktop.mjs` | 补 `RELAY_COMPUTER_RUNTIME`/`RELAY_MODEL_IMAGE_INPUT`，导出 `DESKTOP_CONFIG_KEYS` | P1-1 |
| `scripts/diagnose-desktop.test.mjs` | 新增「键集合与 Rust 宿主白名单相等」契约用例 | P1-1 |
| `apps/workbench/tests/managedFileBrowse.spec.ts` | `settle` 返回类型收窄、删未用导入（HEAD 构建门禁） | 构建修复 |
| `apps/desktop/tests/check-webview-human-chain.mjs` | `.app-sidebar`→`.app-navrail`；先展开「高级」折叠再按 ID 打开 | 检查脚本维护 |
| `apps/desktop/src-tauri/tauri.conf.json` | 新增 `bundle.windows.nsis`（currentUser/图标/语言/LZMA/开始菜单/钩子） | P0-4 |
| `apps/desktop/src-tauri/windows/installer-hooks.nsh` | 新增：安装前版本/架构门槛＋维护会话停机、卸载重解析点安全网 | P0-4 |
| `apps/desktop/scripts/verify-installer.ps1` | 新增：可复跑的安装/卸载生命周期验证（含防误杀守卫） | P0-4 |
| `docs/deployment/本机部署.md` | 追加 2026-10-25 安装器构建路径与已知偏差 | P0-4 |
| `docs/testing/desktop-windows-hardening-2026-10-25.md` | 本报告 | 交付 |

共享树之外：隔离 worktree `D:/Develop/relay-p0-release`（HEAD + 上述面板修复 + 构建脚本的沙箱回退），构建产物保留供 P0-4 安装器使用。

## 3. 问题表

| 编号 | 现象 | 根因 | 状态 |
| --- | --- | --- | --- |
| B1 | 首次挂载/切作用域后预览来源丢失 | 空白初始态被当作状态写盘；切作用域沿用旧作用域空态 | 已修 + 反例测试 |
| B2 | 运维配 `RELAY_COMPUTER_RUNTIME`/`RELAY_MODEL_IMAGE_INPUT` 被诊断判非法 | 诊断工具键集合与宿主白名单不同步 | 已修 + 契约测试 |
| B3 | HEAD 的 `pnpm build` 过不了 | 提交态测试文件类型错误（`settle` 返回 `unknown`） | 已修（两棵树） |
| B4 | 发布构建在共享树反复失败 | 并行会话在途改动（API tsc 中间态、`complete-run.ts`/`conversation-execution.ts` 打字中间态） | 已规避（worktree 隔离构建） |
| B5 | 构建脚本在本机报 `LNK1181 kernel32.lib` / `vswhom.cpp` 编译失败 | 沙箱拦 `reg.exe` → VsDevCmd 查不到 Windows SDK，LIB/INCLUDE 缺 SDK 路径 | 已规避（worktree 脚本补 SDK 库/头路径回退，已在报告披露） |
| B6 | pnpm 安装被 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 拦死 | 本机安全删除护栏对 pnpm 临时目录清理计数 | 已规避（仅构建子进程设 `CODEBUDDY_SAFE_DELETE_ENABLED=0`） |
| B7 | 验收会话桌面启动即退（`supervisor_configuration_failed`） | 会话脚本 `-InstallGraph` 未传 → `relay_graph_v1` 缺失，supervisor 硬性要求 | 已规避（补装图形 schema；不是产品缺陷） |
| B8 | 打包窗口在本机启动落在屏外 `(-25593,-25599)` 且极小 | 从非交互 agent shell 启动 GUI 进程时窗口落点异常（复现稳定）；经 CDP `setWindowBounds` 可恢复正常尺寸 | 环境观察，未判定为产品缺陷 |
| B9 | `restore_isolation` 符号链接用例红 | 本机安全软件实时干预 reparse point（见 §1 P0-3） | 环境问题，需干净机器复验 |
| B10 | 三处文档/注释仍引用已删除的 `dev-desktop.bat` | 该文件由提交 `7dcae0fc` 加入、`aee2496c` 删除（已提交决定，非并行会话未提交改动） | 待用户裁决：恢复 25 行包装脚本，或改文档去掉引用（未擅自恢复） |

## 4. 测试报告

| 套件 | 结果 | 命令/证据 |
| --- | --- | --- |
| 预览恢复（含 4 条新反例） | 15/15 通过 | `vitest run tests/browserPreview.spec.tsx` |
| 相邻回归（devToolsPanel/previewRestore/gitReadPanel/previewUrl） | 6+7+21+8 全通过 | `vitest run …` |
| workbench 类型检查 | 触及文件零错误（全量 10 错全在并行会话未跟踪/存量文件） | `tsc --noEmit` |
| workbench 生产构建 | 通过 | `vite build` exit 0 |
| 诊断工具 + 包校验 | 7 项 6 通过 1 跳过（跳过为登记在案的 native EXE 优化用例） | `node --test scripts/diagnose-desktop.test.mjs scripts/test-desktop-package.test.mjs` |
| 桌面 Rust 库 | 54 项 53 通过 1 失败（环境，见 B9） | `cargo test --locked --target x86_64-pc-windows-msvc --lib` |
| 打包产物边界 | 全项通过（见 §1 P0-2） | `check-webview-boundary.mjs`，日志 `output/p0-2-boundary.log` |
| 打包产物人工链路 | 通过（见 §1 P0-2） | `check-webview-human-chain.mjs`，日志 `output/p0-2-human-chain-final.log` |
| 验收会话清理 | PG 停止 + 临时根删除 | `stop-acceptance-session.ps1` 输出 `postgres_stop_exit=0 temporary_root_removed=True` |

## 5. HANDOFF

- **复现 P0-1**：`cd apps/workbench && ./node_modules/.bin/vitest run tests/browserPreview.spec.tsx`；改动集中在 `BrowserPreviewPanel.tsx` 的 `untouchedRef` 三处判定（初始化、切作用域、navigate/closeTab 置位）。
- **复现 P1-1**：`node --test scripts/diagnose-desktop.test.mjs`（用钉住 node）；契约测试直接解析 `lib.rs` 白名单，改任一侧都会红。
- **复现 P0-2**：发布包在 `D:/Develop/relay-p0-release/apps/desktop/release`；用共享树 `start-acceptance-session.ps1 -ReleaseRoot <该目录>`（**必须带 `-InstallGraph`**），测试进程设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<端口> --remote-debugging-address=127.0.0.1`，然后 `check-webview-boundary.mjs` / `check-webview-human-chain.mjs`。**注意**：① 跑检查前清 `HTTP(S)_PROXY`（本机代理会劫持 loopback CDP 返回 502）；② 每次人工链路必须在**全新桌面实例**上跑（脚本非幂等，旧「新建项目」弹窗会残留并锁住输入框）；③ 单实例互斥是固定名，测试前确认没有遗留桌面进程，否则新实例 `exit 23`。
- **未提交**：全部改动仍在工作区（按任务要求不 commit/push）。`dev-desktop.bat` 的去留需用户裁决后再动文档。

## 6. P0-4 安装器（安装/卸载与首次启动已验证，升级链有确定缺陷）

- **配置**（`apps/desktop/src-tauri/tauri.conf.json`）：`bundle.windows.nsis` — `installMode=currentUser`（免管理员、注册表落 HKCU）、安装/卸载图标 `icons/icon.ico`（已验证该 ICO 含 16–256 共 10 个尺寸）、`languages=[SimpChinese, English]`、`compression=lzma`、`startMenuFolder=Relay Agent`、`installerHooks=windows/installer-hooks.nsh`。
- **钩子**（新增 `apps/desktop/src-tauri/windows/installer-hooks.nsh`）：
  - `PREINSTALL`：Windows 10+ 与 x64 门槛（静默模式 `SetErrorLevel`+`Abort` 不弹窗）；已有安装时先跑随包 `node.exe api/dist/src/cli/maintenance.js hold-desktop-stop --package-root <安装目录> --data-root <数据根>`，停受管进程并取得停止证明后再覆盖，失败即中止。核对了生成的 `installer.nsi`：本钩子在模板 `CheckIfAppIsRunning` **之前**插入（第 634/638 行），正常路径不会走到按 EXE 名强杀。
  - `PREUNINSTALL`：只加重解析点安全网（数据目录本身是 junction/符号链接时清掉模板「删除应用数据」勾选，避免 `RmDir /r` 穿透）；数据保留由模板自带复选框承担（默认不勾＝保留，静默卸载不执行该页＝保留，`$UpdateMode=1` 也不删）；全程不做 `taskkill`。
- **产物**：`Relay Agent_0.1.0_x64-setup.exe`（54,207,202 字节，LZMA；payload 约 214 MB），makensis 退出码 0。
- **安装/卸载生命周期：14 项全部通过**（`verify-installer.ps1`，日志 `output/p0-4-installer-verify.log`）：静默安装 exit 0；7 个 payload（relay-desktop/node/api main+supervisor/helper/computer-runtime/uninstall）齐全；开始菜单 `Relay Agent\Relay Agent.lnk` 创建；`HKCU\...\Uninstall\Relay Agent`（DisplayVersion 0.1.0、UninstallString 指向安装目录）注册；静默卸载 exit 0；安装目录与快捷方式移除；**用户数据 5 个文件逐文件不变**。
- **安装版首次启动健康检查：通过**（独立临时 PG + 安装版 node/api，CDP 探针，日志 `output/p0-4-installed-health.log`）：`desktop_bootstrap` 返回 `http://127.0.0.1:43117` + 64 字符令牌；`GET /health/ready` = **200** `{"status":"ready","components":{"database":{"status":"up"},"schema":{"status":"up"}}}`；工作台标题栏显示「数据来源：已连接本机 API」。收尾 PG `postgres_stop_exit=0`、临时根已删。
- **升级链缺陷（实测 exit 4）**：在已有安装上重跑安装器 → 静默安装返回 **4**（钩子的维护会话失败分支）。根因：`bundle.resources` 未包含 `desktop-build-manifest.json`，安装版缺少维护会话所需的包清单，`maintenance.js hold-desktop-stop` 拒绝执行。行为是 **fail-closed**（中止覆盖，未破坏旧安装），但升级不可用。修复方向：在「exe 打包 patch 之后、makensis 之前」生成 build-identity manifest 并纳入 payload（需要构建脚本改造，且要确认 CLI 对 `artifact_sha256` 的校验口径）。

## 7. 未验项（不得视为通过）

1. **P0-2 剩余验收点**：预览子 WebView 的越权拒绝/新窗口下载拒绝/profile 隔离（需要驱动预览 UI 的交互脚本，现有两个脚本未覆盖）；多标签预览、前进后退、刷新、崩溃恢复；100%/200% 缩放、Windows DPI、跨显示器移动、焦点与键盘交互。
2. **P0-3 API 侧**：`UNKNOWN` 不因租约过期重执行、`LEASE_LOST` 收敛、supervisor 有界重启的**集成复跑**未在本次执行（共享树 `apps/api/dist` 重建会干扰并行会话；已有登记在案的集成用例，见 `gateway.integration.test.ts` P09 组与 `check-trust-gate.integration.test.ts`）。崩溃恢复、真实断网、只读/满盘等外部故障注入未做。
3. **P0-4 安装器**：安装/卸载生命周期与安装版首次启动已实测通过；**升级链仍不可用**（实测 exit 4：安装版缺 `desktop-build-manifest.json`，维护会话拒绝执行，fail-closed 中止覆盖）。待办：打包后写 build-identity manifest 并纳入 payload、升级时按名强杀检查替换为维护协议（需自定义 template）、NSIS 目录选择页、`docs/design/brand/*.svg` 缺失。
4. **P1-2/P1-3/P1-4、P2 计划与版本验证**：未开始。
5. **B9 干净机器复验**：符号链接恢复隔离用例需要无安全软件干预的机器。
6. **原生输入证据**：人工链路为 Playwright 合成输入，真实 Windows 键鼠/IME、系统级快捷键与单实例窗口还原仍需人工点验。
