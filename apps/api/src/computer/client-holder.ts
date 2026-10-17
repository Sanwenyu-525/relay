/**
 * Computer Runtime 的进程级客户端持有者。
 *
 * API 进程内共享一个客户端：Runtime 在会话生命周期内保持，空闲后回收，
 * 崩溃后由下一个请求透明重建。测试用 replaceComputerRuntimeClientForTest
 * 注入受控客户端，不触碰真实进程。
 */

import { ComputerRuntimeClient } from './runtime-client.js';

let shared: ComputerRuntimeClient | null = null;

export function getComputerRuntimeClient(): ComputerRuntimeClient {
  if (shared === null) shared = new ComputerRuntimeClient();
  return shared;
}

/** 仅测试与显式关闭使用：停机并丢弃共享客户端。 */
export function shutdownComputerRuntimeClient(): void {
  if (shared instanceof ComputerRuntimeClient) shared.dispose();
  shared = null;
}

/**
 * 用户请求退出电脑操控（Esc）时调用：立刻杀掉本进程持有的运行时。
 *
 * 没有运行时在跑就是无害空操作；有则保证已排队/在途的鼠标键盘输入立即停止。
 * 在途动作的效果按「未知」结算（见 runtime-client 的取消契约）。
 */
export function interruptComputerRuntime(): void {
  if (shared instanceof ComputerRuntimeClient) shared.interrupt();
}

/** 仅测试使用：替换共享客户端（测试替身可以不实现 dispose）。 */
export function replaceComputerRuntimeClientForTest(client: ComputerRuntimeClient | null): void {
  if (shared instanceof ComputerRuntimeClient) shared.dispose();
  shared = client;
}
