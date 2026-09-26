import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTER_DESCRIPTORS,
  getAdapterDescriptor,
} from '../../src/gateway/adapter-metadata.js';
import type { GatewayCapability } from '../../src/infrastructure/database-schema.js';

test('all required capabilities have explicit adapter descriptors', () => {
  const requiredCapabilities: GatewayCapability[] = [
    'FILE_READ',
    'FILE_WRITE',
    'WEB_FETCH',
    'GIT_READ',
    'GIT_WRITE',
    'CLI_RUN',
    'FAKE_WRITE',
    'FAKE_PUBLIC_READ',
  ];

  for (const cap of requiredCapabilities) {
    const desc = getAdapterDescriptor(cap);
    assert.ok(desc, `Descriptor for ${cap} must exist`);
    assert.equal(desc.capabilityKey, cap);
    assert.equal(typeof desc.adapterId, 'string');
    assert.equal(typeof desc.version, 'string');
    assert.ok(desc.effectKind === 'READ' || desc.effectKind === 'WRITE');
    assert.equal(typeof desc.resumable, 'boolean');
    assert.equal(typeof desc.cancellable, 'boolean');
    assert.equal(typeof desc.approvalPassthrough, 'boolean');
    assert.equal(typeof desc.sandboxed, 'boolean');
  }
});

test('subprocesses and write tools do not claim to be sandboxed', () => {
  // ADR-010 and verification plan: child processes and physical disk operations
  // on Windows are not OS sandboxes and must explicitly declare sandboxed: false.
  const unisolatedCaps: GatewayCapability[] = [
    'FILE_WRITE',
    'GIT_READ',
    'GIT_WRITE',
    'CLI_RUN',
  ];

  for (const cap of unisolatedCaps) {
    const desc = getAdapterDescriptor(cap);
    assert.equal(desc.sandboxed, false, `${cap} must explicitly declare sandboxed: false`);
  }
});

test('automated write operations without approval passthrough require human approval', () => {
  // Verification requirement: executors without approval passthrough must not
  // carry out automated writes; they must enforce ASK or DENY.
  const strictApprovalCaps: GatewayCapability[] = [
    'FILE_WRITE',
    'GIT_WRITE',
    'CLI_RUN',
  ];

  for (const cap of strictApprovalCaps) {
    const desc = getAdapterDescriptor(cap);
    assert.equal(
      desc.approvalPassthrough,
      false,
      `${cap} must have approvalPassthrough: false to prevent bypassing human review`,
    );
  }
});

test('read-only adapters declare effectKind READ and resumable true', () => {
  const readCaps: GatewayCapability[] = ['FILE_READ', 'WEB_FETCH', 'GIT_READ'];

  for (const cap of readCaps) {
    const desc = getAdapterDescriptor(cap);
    assert.equal(desc.effectKind, 'READ');
    assert.equal(desc.resumable, true, `${cap} must be safely resumable/re-readable`);
  }
});
