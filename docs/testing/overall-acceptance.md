
## 2026-10-30 上下文压力预警（定向修复）验收记录

真实命令与结果（Windows 主机 LAPTOP-RTUVXZ-G，仓库 `D:\Develop\Relay-Agent`，HEAD `c13e729`，工作树含其他 Agent 未提交改动；Node v22.22.3，低于 engines 要求 >=24，已实际观察：注入的测试与 TypeScript 均能正常运行）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| API 类型检查 | `pnpm run typecheck`（apps/api） | 退出码 0 |
| Workbench 类型检查 | `npx tsc --noEmit`（apps/workbench） | 退出码 0 |
| 必读审计单测 | `npx tsc -p tsconfig.json` + `node --test dist/test/unit/required-context-files.test.js` | 16 通过 / 0 失败，退出码 0 |

新增用例（本轮）：

- `父目录是指向根外的链接：声明文件不得被读入（父链接 / Junction 越界）` — 通过；
- `声明文件自身是根外链接：不读，并留下可解释的原因` — 通过。

未验证边界（不得当作已通过）：

- 浏览器端交互（发送前确认条的出现/取消/继续、首条消息预警的渲染）未跑 `tests/browser`；
- 需要 PostgreSQL 的审计 API 集成用例未跑；
- P1-D（受控 READ_FILE 工具调用路径）未接通，因此无验收结论。