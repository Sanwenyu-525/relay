import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import test from 'node:test';

import {
  assistPreviewProbeKey,
  isAssistPreviewTerminal,
  isRunDraftTerminal,
  runDraftProbeKey,
  writePreviewFrame,
  type AssistPreviewProbe,
  type RunDraftPreviewProbe,
} from '../../src/api/preview-events-api.js';
import type { RunDraftPreviewDto } from '../../src/application/run-draft-preview.js';

class ControlledResponse extends EventEmitter {
  readonly frames: string[] = [];

  write(frame: string): boolean {
    this.frames.push(frame);
    return true;
  }

  asServerResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

function runProbe(overrides: Partial<RunDraftPreviewProbe> = {}): RunDraftPreviewProbe {
  return { revision: 1n, step_attempt_id: 'attempt-1', attempt_claim_epoch: 1n,
    run_worker_epoch: 3n, model_call_id: 'call-1', truncated: false, ...overrides };
}

test('Run draft probe key separates generations that reset revision to one', () => {
  assert.equal(runDraftProbeKey(undefined), '\u0000none');
  assert.equal(runDraftProbeKey(runProbe()), runDraftProbeKey(runProbe()));
  // 换 attempt/模型调用时 revision 同样从 1 开始，键必须能把新旧世代分开。
  assert.notEqual(runDraftProbeKey(runProbe()),
    runDraftProbeKey(runProbe({ model_call_id: 'call-2' })));
  assert.notEqual(runDraftProbeKey(runProbe()),
    runDraftProbeKey(runProbe({ attempt_claim_epoch: 2n })));
  assert.notEqual(runDraftProbeKey(runProbe()),
    runDraftProbeKey(runProbe({ run_worker_epoch: 4n })));
  assert.notEqual(runDraftProbeKey(runProbe()),
    runDraftProbeKey(runProbe({ revision: 2n })));
  assert.notEqual(runDraftProbeKey(runProbe()),
    runDraftProbeKey(runProbe({ truncated: true })));
});

test('Assist preview probe key tracks revision and truncation only', () => {
  assert.equal(assistPreviewProbeKey(undefined), '\u0000none');
  const probe: AssistPreviewProbe = { revision: 4n, truncated: false };
  assert.equal(assistPreviewProbeKey(probe), assistPreviewProbeKey({ ...probe }));
  assert.notEqual(assistPreviewProbeKey(probe),
    assistPreviewProbeKey({ revision: 5n, truncated: false }));
  assert.notEqual(assistPreviewProbeKey(probe),
    assistPreviewProbeKey({ revision: 4n, truncated: true }));
});

test('Preview terminal predicates match the client hook exit semantics', () => {
  const runDto = (run_status: string): RunDraftPreviewDto =>
    ({ run_status }) as unknown as RunDraftPreviewDto;
  for (const status of ['COMPLETED', 'FAILED', 'CANCELLED']) {
    assert.equal(isRunDraftTerminal(runDto(status)), true, status);
  }
  for (const status of ['CREATED', 'RUNNING', 'PAUSED', 'WAITING_APPROVAL']) {
    assert.equal(isRunDraftTerminal(runDto(status)), false, status);
  }
  for (const status of ['PENDING', 'RUNNING']) {
    assert.equal(isAssistPreviewTerminal({ status }), false, status);
  }
  for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'DISCARDED']) {
    assert.equal(isAssistPreviewTerminal({ status }), true, status);
  }
});

test('Preview frames carry the full DTO under the revision id', async () => {
  const response = new ControlledResponse();
  const dto = { run_id: 'run', run_status: 'RUNNING', step_attempt_id: 'attempt',
    attempt_claim_epoch: '1', model_call_id: 'call', preview_revision: '7',
    preview_text: '# 标题\n\n正文', preview_truncated: false, preview_available: true };
  assert.equal(await writePreviewFrame(response.asServerResponse(), 'draft_preview',
    dto.preview_revision, dto, new AbortController().signal), true);
  assert.equal(response.frames.length, 1);
  const frame = response.frames[0]!;
  assert.equal(frame.endsWith('\n\n'), true);
  const [idLine, eventLine, dataLine] = frame.slice(0, -2).split('\n');
  assert.ok(idLine === 'id: 7');
  assert.ok(eventLine === 'event: draft_preview');
  assert.ok(dataLine !== undefined && dataLine.startsWith('data: '));
  assert.deepEqual(JSON.parse(dataLine.slice(6)), dto);
});
