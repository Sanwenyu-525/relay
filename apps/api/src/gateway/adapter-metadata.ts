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
};

export function getAdapterDescriptor(capability: GatewayCapability): AdapterDescriptor {
  const descriptor = ADAPTER_DESCRIPTORS[capability];
  if (!descriptor) {
    throw new Error(`Unknown gateway capability: ${capability}`);
  }
  return descriptor;
}
