# B · 任务卡片版｜Tauri 桌面图标素材包

第二张图：暂停任务卡片、完成任务卡片，保留完整的任务场景。

这是你指定的现有图片的格式转换和资源导出包，不是新生成的第三种设计，也不是完整的 Tauri 项目。每套 ICO、PNG、ICNS 都来自本套同一张图，A、B 不混用。

## 立即接入

1. 先备份项目中会被替换的同名图标文件。将本包 `src-tauri/icons/` 内的文件复制到实际 Tauri 项目的 `src-tauri/icons/`。保留项目原有的自定义托盘图标等其他文件，不需要删除整个目录。
2. 打开项目的 `src-tauri/tauri.conf.json`，只合并下面的 `bundle.icon` 字段。**不要用配置片段覆盖整个配置文件**，不要改动 identifier、窗口配置、权限或业务逻辑。相对路径按实际 Tauri 配置文件所在目录解析。[1][2]

```json
{
  "bundle": {
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

3. 检查平台配置 `tauri.windows.conf.json` 或构建时附加配置是否覆盖图标；检查已有 `setIcon` / `set_icon` / 自定义窗口 icon 引用是否仍指向旧文件。不要为了本素材包新增不必要的运行时图标代码。
4. 关闭旧应用和正在运行的 Tauri 开发进程。在项目根目录，使用已有包管理器构建，例如项目已定义 `"tauri": "tauri"` 脚本时：[3]

```bash
npm run tauri -- build
```

使用 pnpm 且项目已有相应脚本时：

```bash
pnpm tauri build
```

5. 启动新构建的**应用本体**，不要把安装器的图标当作运行时图标。验证桌面快捷方式、运行时任务栏、固定项所指向的程序是否是同一版本。资源已统一但固定项仍显示旧图时，取消旧固定项并从新版本重新固定，再判断缓存。

包内文件已经生成完毕，**接入时不需要再执行 `tauri icon`**。重复生成会重写本包的尺寸配置。图标更新需要重新构建桌面应用，单独刷新 React 页面不能检验新程序资源。

## 文件说明

| 文件或目录 | 内容 |
|---|---|
| `source/original.png` | 原始上传图片，保留原始文件字节，未重画 |
| `assets/app-icon.png` | 1024×1024 透明 RGBA 导出母版 |
| `src-tauri/icons/icon.ico` | Windows 多尺寸图标，共 10 个 32 位 RGBA 图层 |
| `src-tauri/icons/*.png` | 14 个透明 PNG 文件；含 Tauri 常用名称及额外尺寸 |
| `src-tauri/icons/icon.icns` | macOS 图标资源，10 个图像层；包含 16～1024 物理像素层 |
| `config/tauri.bundle-icon.fragment.json` | 仅 `bundle.icon` 配置片段 |
| `config/tauri.nsis-icons.optional.fragment.json` | 可选 NSIS 安装器/卸载器图标配置，不必无条件加入 |
| `preview/index.html` | 本地打开查看浅色、深色背景上的各尺寸效果 |
| `preview/native-sizes.png` | 直接使用导出 PNG 制作的多尺寸预览，不是重新生图 |
| `verification/report.json` | PNG、ICO、ICNS 及配置引用的检查记录 |
| `SHA256SUMS.txt` | 本包其他文件的 SHA-256 校验值 |
| `CODEX_INTEGRATION.md` | 交给代码助手的接入与验收说明 |
| `tools/rebuild_icons.py` | 可选复现脚本；接入现有文件无需运行 |

PNG 的独立尺寸为：**16、20、24、32、40、48、64、96、128、256、512、1024**。
另外 `128x128@2x.png` 实际为 **256×256**，`icon.png` 实际为 **512×512**。

ICO 内部真实目录顺序为：

```text
32 → 16 → 20 → 24 → 40 → 48 → 64 → 96 → 128 → 256
```

首层为 32×32；每个尺寸都保留本套完整图案，不会小尺寸换成 A、大尺寸换成 B。Tauri 官方要求的 16、24、32、48、64、256 层已全部包含，32 像素首层也按其建议设置。[1]

## 对原图进行了什么处理

原图自带透明通道，外部显示为黑色的区域不是本包加上的黑底。这里没有新增圆角底板，没有变更配色、机器人形象或任务符号。

只清除了 alpha 值不高于 3/255 的几乎不可见杂点，按可见图案边界居中，并给长边保留约 4% 安全边距；然后直接从同一 1024 像素母版导出每个尺寸。采用预乘透明度的 Lanczos 缩放，避免透明边缘混入隐藏的背景颜色。未进行 AI 重绘、矢量化、锐化或小尺寸重设计。

**两套都保留原始构图。16～24 像素下复杂细节仍可能难以辨认；多尺寸导出不能让完整插画在极小尺寸上保留全部细节。** 本包解决资源格式、尺寸和同源性问题，不承诺完全消除图案本身的辨识限制。

## 校验范围

已检查：PNG 为正方形、RGBA、每通道 8 位；ICO 层尺寸、顺序、透明度和逐层像素；ICNS 各层可解码及逐层像素；配置引用文件存在。ICO 每层经 Pillow 读回后与对应 PNG 像素一致，并通过 ImageMagick 独立识别。

**未执行：你的项目构建、Windows 桌面/任务栏实际显示验收、macOS Dock 显示验收。** 当前没有你的仓库或对应桌面环境，不能把“文件结构校验通过”写成“已在你的项目中接入成功”。

预览 HTML 按 CSS 像素显示，建议浏览器缩放设为 100%；屏幕 DPI、浏览器和系统图标渲染机制仍可能导致与实际任务栏不同。

## 可选：以后重新导出

直接使用包内资源不需要安装 Python。仅在需要复现导出时使用 Python 3.10+，在本包根目录执行：

```bash
python -m pip install -r tools/requirements.txt
python tools/rebuild_icons.py
```

脚本会重新生成导出母版、PNG、ICO、ICNS、配置片段和 JSON 校验报告。源图保存在 `source/original.png`。预览、ImageMagick 外部检查日志和 SHA256SUMS 属于本次交付的快照，重导出后须另行刷新；不要将旧快照当作新文件的校验结果。

## 官方依据

[1] Tauri App Icons（格式、必需尺寸和首层建议）：https://v2.tauri.app/develop/icons/

[2] Tauri Configuration（bundle.icon 与可选 NSIS 字段）：https://v2.tauri.app/reference/config/

[3] Tauri Windows Installer（桌面构建命令）：https://v2.tauri.app/distribute/windows-installer/

文档核对日期：2026-09-25。
