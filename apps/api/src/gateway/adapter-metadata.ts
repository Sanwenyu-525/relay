import type { GatewayCapability } from '../infrastructure/database-schema.js';

export interface AdapterDescriptor {
  readonly capabilityKey: GatewayCapability;
  readonly adapterId: string;
  readonly version: string;
  readonly effectKind: 'READ' | 'WRITE';
  /** Whether the adapter can safely re-read or verify an outcome after a crash without blind re-execution */
  readonly resumable: boolean;
  /** Whether ongoing execution can be reliably terminated via AbortSignal or process tree tree-kill */
  readonly cancellable: boolean;
  /** Whether this adapter can bypass human approval (AUTO) when authorized by policy.
   * If false, automated write operations cannot bypass approval and must be ASK or DENY. */
  readonly approvalPassthrough: boolean;
  /** Whether execution is strictly isolated in an OS-level sandbox.
   * On Windows desktop host, child processes and file writes are NOT OS sandboxed,
   * so this is explicitly false. */
  readonly sandboxed: boolean;
}

export const ADAPTER_DESCRIPTORS: Readonly<Record<GatewayCapability, AdapterDescriptor>> = {
  FILE_READ: {
    capabilityKey: 'FILE_READ',
    adapterId: 'file-read-v1',
    version: '1.0.0',
    effectKind: 'READ',
    resumable: true,
    cancellable: true,
    approvalPassthrough: true,
    sandboxed: false,
  },
  FILE_WRITE: {
    capabilityKey: 'FILE_WRITE',
    adapterId: 'file-changeset-v1',
    version: '1.0.0',
    effectKind: 'WRITE',
    resumable: false, // Physical disk write cannot be blindly retried without baseline hash check
    cancellable: false, // Critical write section cannot be rolled back mid-flight
    approvalPassthrough: false, // Writing files requires explicit review approval or strict ASK
    sandboxed: false, // No OS sandbox on Windows desktop
  },
  FILE_QUERY: {
    capabilityKey: 'FILE_QUERY',
    adapterId: 'file-query-v1',
    version: '1.0.0',
    effectKind: 'READ',
    resumable: true, // Bounded directory/path/content queries can be safely re-read
    cancellable: true,
    approvalPassthrough: true, // Read-only queries have no external effect to review
    sandboxed: false,
  },
  WEB_FETCH: {
    capabilityKey: 'WEB_FETCH',
    adapterId: 'web-fetch-v1',
    version: '1.0.0',
    effectKind: 'READ',
    resumable: true,
    cancellable: true,
    approvalPassthrough: true,
    sandboxed: false,
  },
  GIT_READ: {
    capabilityKey: 'GIT_READ',
    adapterId: 'git-read-v1',
    version: '1.0.0',
    effectKind: 'READ',
    resumable: true,
    cancellable: true,
    approvalPassthrough: true,
    sandboxed: false,
  },
  GIT_WRITE: {
    capabilityKey: 'GIT_WRITE',
    adapterId: 'git-write-v1',
    version: '1.0.0',
    effectKind: 'WRITE',
    resumable: true, // Commit/push can be reconciled via commit sha or remote ref sha
    cancellable: true,
    approvalPassthrough: false, // Git write (commit, push) requires approval
    sandboxed: false,
  },
  CLI_RUN: {
    capabilityKey: 'CLI_RUN',
    adapterId: 'cli-process-v1',
    version: '1.0.0',
    effectKind: 'WRITE',
    resumable: false, // Arbitrary build/test CLI execution cannot be blindly replayed
    cancellable: true, // Windows process-tree cancellation
    approvalPassthrough: false, // CLI commands cannot bypass approval for arbitrary execution
    sandboxed: false, // Child process is not an OS sandbox
  },
  FAKE_WRITE: {
    capabilityKey: 'FAKE_WRITE',
    adapterId: 'fake-write-v1',
    version: '1.0.0',
    effectKind: 'WRITE',
    resumable: true,
    cancellable: true,
    approvalPassthrough: true,
    sandboxed: false,
  },
  FAKE_PUBLIC_READ: {
    capabilityKey: 'FAKE_PUBLIC_READ',
    adapterId: 'fake-public-read-v1',
    version: '1.0.0',
    effectKind: 'READ',
    resumable: true,
    cancellable: true,
    approvalPassthrough: true,
    sandboxed: false,
  },
  COMPUTER_READ: {
    capabilityKey: 'COMPUTER_READ',
    adapterId: 'computer-read-v1',
    version: '1.0.0',
    effectKind: 'READ',
    // 截图与窗口枚举是纯读取：崩溃后安全重取，不留下半应用动作。
    resumable: true,
    cancellable: true,
    // 只读没有可审批的外部效果；默认策略 AUTO 即可连续观察。
    approvalPassthrough: true,
    // 读取的是整台桌面，进程边界不是 OS 沙箱。
    sandboxed: false,
  },
  COMPUTER_INPUT: {
    capabilityKey: 'COMPUTER_INPUT',
    adapterId: 'computer-input-v1',
    version: '1.0.0',
    effectKind: 'WRITE',
    // 一次点击或一段文本已产生外部效果：不能盲目重放，UNKNOWN 必须人工核对。
    resumable: false,
    // 取消只解除等待，不终止进行中的输入（终止只会把未知变成更未知）。
    cancellable: true,
    // 与 CLI_RUN 同一纪律：桌面输入不可无人审批自动执行；「本次任务允许」走
    // 范围授权，「仅此一次」走单动作审批，「始终允许」V1 不开放。
    approvalPassthrough: false,
    sandboxed: false,
  },
  GITHUB_READ: {
    capabilityKey: 'GITHUB_READ',
    adapterId: 'github-read-v1',
    version: '1.0.0',
    effectKind: 'READ',
    // 只读查询没有外部效果：崩溃后按同一冻结参数安全重读，不需要 UNKNOWN 隔离。
    resumable: true,
    cancellable: true,
    // 读取不产生需要人工裁决的效果；默认策略仍由 Permission 版本决定，这里只声明可 AUTO。
    approvalPassthrough: true,
    // gh 会访问网络并在本机进程里运行，进程边界不是 OS 沙箱。
    sandboxed: false,
  },
};

export function getAdapterDescriptor(capability: GatewayCapability): AdapterDescriptor {
  const descriptor = ADAPTER_DESCRIPTORS[capability];
  if (!descriptor) {
    throw new Error(`Unknown gateway capability: ${capability}`);
  }
  return descriptor;
}
