/**
 * Computer Runtime 的进程与模式配置。
 *
 * 解析顺序与 relay-file-io-helper 先例一致：显式环境变量优先，否则取 Node 可执行
 * 文件同目录的 `relay-computer-runtime.exe`。桌面打包版把运行时随 node.exe 放在资源
 * 目录，默认路径即可命中；需要换位置时在 desktop.env 里写 RELAY_COMPUTER_RUNTIME
 *（自行启动 API 时直接设同名环境变量）。模式开关 COMPUTER_RUNTIME_MODE=mock 只用于
 * UI 与 Agent 流程测试：mock 数据永远带 `mock: true` 标记，生产默认真实 Windows 运行时。
 */

import { dirname, join } from 'node:path';

export type ComputerRuntimeMode = 'real' | 'mock';

/** 读取运行模式。未设置或无法识别时按真实模式处理（失败关闭，不悄悄降级）。 */
export function computerRuntimeMode(): ComputerRuntimeMode {
  const value = process.env.COMPUTER_RUNTIME_MODE;
  return value !== undefined && value.toLowerCase() === 'mock' ? 'mock' : 'real';
}

/** 解析运行时可执行文件路径。 */
export function computerRuntimeExecutable(): string {
  return process.env.RELAY_COMPUTER_RUNTIME ??
    join(dirname(process.execPath), 'relay-computer-runtime.exe');
}

/** 运行时不可用时（非 Windows 且真实模式）的默认说明。 */
export function computerRuntimeUnavailableReason(): string {
  return process.platform === 'win32'
    ? 'Computer Runtime 可执行文件缺失或无法启动'
    : '真实 Computer Runtime 需要 Windows；当前平台不支持';
}
