# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## 本原型的已选方向与边界

- 2026-10-02 选定 Product Design 展示顺序中的方案 2。确切视觉稿为 `C:/Users/ASUS/.codex/generated_images/01a0faa7-688f-7260-8681-1d327cc55e09/exec-dced2695-d433-474f-aedc-7a408ffe4302.png`，尺寸 1721×914；不得静默换用同批次其他方案。
- 保持浅暖白、森林绿、细图标导航、近期任务列、紧凑任务页头、宽消息区和独立底部输入器。任务完整标题最多一行省略，可用键盘打开详情；详情侧抽屉不增加页头高度，消息不被输入器遮挡。
- 本轮仅实现聊天页面原型。工作台、项目、待处理、资料等全站入口仅展示对应路由和布局适配说明，不表示其他业务页已实现。
- 任务、会话、资料和回复均为页面内示例。不得调用 API 或真实模型，不得把输入、资料或会话写入 `localStorage` 等持久存储。已取消任务允许普通讨论，讨论不重启任务；委托条件仅允许 READY，原型不启动真实执行。
- 配色快照 `src/palette.json` 只提取现有 `docs/frontend/design-tokens.json` 的原始 palette 值，不修改生产 token。字体和许可位于 `public/fonts/`，复用现有 OFL Noto Sans SC。保持原型独立，不编辑生产应用或项目主文档。
- 需覆盖 1721×914、1280×720、960×640、390×844 视口；中文输入法组合输入时 Enter 不发送，Shift+Enter 换行，用户上翻后新回复不抢滚动位置，Escape 关闭浮层并归还焦点。
