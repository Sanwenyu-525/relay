# Windows DPI 取证结论（2026-09-29）

## 1. 原值记录（硬性要求第 4a 步）

- 证据：`dpi-original.json`（08:36:06 采集）
- 原值事实：`HKCU\Control Panel\Desktop\WindowMetrics\AppliedDPI = 120`（**系统当前本就是 125%**）；`LogPixels` 不存在；`Win8DpiScaling = 0`；`DpiScalingVer = 4096`（每显示器缩放时代）；物理屏 1920×1080；`GetDpiForSystem`（感知后）= 120。
- 说明：任务交接假设"原值 100%，需切 125%"，实际原值即 125%。125% 轮因此=原值态真实取证，无需切换。

## 2. 桌面窗口 125% 真实行为（行为取证）

- `window-dpi-baseline.json`：桌面窗口 `GetDpiForWindow = 120`（125%），外框物理 1468×985，DWM 内容边界 1452×977 ≈ 逻辑 1160×780 × 1.25（Tauri `inner_size(1160, 780)` 正确按物理缩放）。
- WebView 内部（CDP）：`devicePixelRatio = 1.25`，`screen = 1536x864`（= 1920×1080 ÷ 1.25），内容区 1160×780 CSS。
- 结论：桌面壳与 WebView2 在 125% 下按每显示器 DPI 感知正确缩放；文字渲染清晰、无裁剪/重叠（九页 PrintWindow 全窗口截图为证）。

## 3. 125% 轮九页真实窗口截图（PrintWindow，物理像素，含标题栏）

目录 `dpi/125/`（窗口内容区 1160×780 CSS，物理 1468×985）：
01-today / 02-projects / 03-tasks / 04-task-detail / 05-knowledge / 06-activities / 07-reviews / 08-settings / 09-connections。
检查结论：文字渲染正常、布局无裁剪/重叠、控件可用（九页 DOM 检查横向溢出均 false、无 action-error）。

## 4. 150% 程序化切换尝试（如实记录，D3）

依次尝试并全部无效（系统有效 DPI 始终 120）：

1. `WindowMetrics\AppliedDPI = 1440` + `WM_SETTINGCHANGE` 广播 → `GetDpiForSystem` 仍 120（`dpi-set-150-registry.json`）。
2. `Win8DpiScaling = 1` + `LogPixels = 144` + 广播 → 仍 120（`dpi-set-150-logpixels.json`）。
3. 按任务指引重启桌面进程（第四会话全新进程）→ 新进程 `GetDpiForWindow` 仍 120。

结论：Windows 10/11 每显示器缩放无公开 API；注册表遗留键对本会话有效缩放不生效，须系统设置 UI 或注销会话。**150% 真实取证在本会话内不可行**，按任务要求停止，改用替代并说明限制（见第 6 节），未用浏览器缩放冒充。

## 5. 恢复（硬性要求第 4e 步）

- 已恢复：`AppliedDPI = 120`、`Win8DpiScaling = 0`、`LogPixels` 删除（回原状），广播并验证。
- 证据：`dpi-restore-verify.json`（08:52:06）：AppliedDPI=120、Win8DpiScaling=0、LogPixels 不存在、GetDpiForSystem=120、GDI LogPixelsY=120——与原值完全一致。
- 恢复后桌面复验：`restore-verify/restore-01-today.png`、`restore-04-task-detail.png`（第四会话正常渲染；supervisor 存活）。

## 6. 限制与替代说明

- 150% 未能真实取证：本会话程序化手段不可达（见第 4 节）。已完成的替代：
  - 125%（原值）全链路行为取证（九页 PrintWindow + DOM 检查）；
  - EXE 内嵌 manifest 核对：**未声明** dpiAware/dpiAwareness（`desktop-exe-manifest-dpi.xml`），感知行为来自运行时 API（Tauri/wry/WebView2 每显示器 v2）——已登记缺陷 D4（低，登记不修改）；
  - DPI 数值与窗口/WebView 实测关系链完整（AppliedDPI ↔ GetDpiForWindow ↔ devicePixelRatio ↔ 物理尺寸），可据此推断 WebView2 内容在 150% 下将按 dpr=1.5 缩放，但该推断不等价于 150% 真实运行证据。
- 残余限制：150% 下文字渲染/布局适配需在系统设置 UI 手动切换后另行取证。
