# Relay 协作对话原型 · 方案 2

这是 2026-10-02 用户选定 Product Design 第二张视觉稿后创建的独立交互原型。它使用插件默认 `prototype` 模板，代码与资源均保存在本目录，不接入生产应用。

## 范围

本轮只呈现聊天页面：近期任务与搜索、会话切换、新对话、任务详情侧抽屉、资料选择、讨论意图和模拟回复。工作台、项目、待处理、资料等全站入口只展示路由与后续布局适配说明，不代表对应业务页面已经实现。

任务、会话、资料和模型回复均为浏览器内示例；输入与资料不写入持久存储，刷新页面会清空本轮修改。不调用 API、真实模型或执行器。已取消任务保持“当前无执行”，普通讨论不会重启任务；READY 示例仅用于展示委托条件，不启动真实执行。

## 视觉与资源来源

- 选定稿：`C:/Users/ASUS/.codex/generated_images/01a0faa7-688f-7260-8681-1d327cc55e09/exec-dced2695-d433-474f-aedc-7a408ffe4302.png`，1721×914，按最终显示顺序选择方案 2。
- 布局：浅暖白森林绿、细图标导航与近期任务列、紧凑任务页头、宽消息区、独立输入器。浏览器原型不模拟 Windows 系统窗口控制。
- 配色：从 [现有设计 token](../../docs/frontend/design-tokens.json) 提取 10 项原始 palette 值至 [palette.json](src/palette.json)，作为原型的只读视觉快照；不修改生产 token，也不将生成图片的像素视为生产 CSS 真值。
- 字体：[Noto Sans SC](public/fonts/noto-sans-sc-variable.woff2) 复用现有应用的本地可变字体，许可见 [OFL.txt](public/fonts/OFL.txt)，来源记录见 [现有字体 provenance](../../apps/workbench/src/assets/fonts/provenance.json)。字体加载无需外部网络。
- 图标：公开的 `@phosphor-icons/react`，采用与参考稿接近的线性图标。

## 运行

```powershell
npm install --prefer-offline --no-audit --no-fund
npm run dev -- --host 127.0.0.1 --port 4192 --strictPort
```

## 构建与验证边界

```powershell
npm run build
```

模板保留 Sites 构建结构，输出为 `dist/client`、`dist/server/index.js` 和 `dist/.openai/hosting.json`。本轮不发布站点。

构建成功只证明源码可编译。浏览器视觉对比与交互验收由协调 Agent 独立执行；本文件不记录未运行的验收结论。该原型不能作为真实 API、模型、Windows 窗口、安装或业务流程验收证据。
