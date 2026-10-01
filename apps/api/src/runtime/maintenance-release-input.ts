import type { Readable } from 'node:stream';

export class MaintenanceReleaseInputError extends Error {
  override readonly name = 'MaintenanceReleaseInputError';
  constructor() { super('invalid maintenance release input'); }
}

/** Private terminal input shared by the two trusted maintenance hold CLIs. */
export function readMaintenanceReleaseInput(input: Readable): {
  readonly requested: Promise<void>; requestBySignal(): void; assertValid(): void; dispose(): void;
} {
  let bytes = Buffer.alloc(0);
  let terminal = false;
  let failure: MaintenanceReleaseInputError | undefined;
  let requestBySignal!: () => void;
  let rejectInput!: (error: Error) => void;
  const fail = () => {
    failure ??= new MaintenanceReleaseInputError();
    rejectInput(failure);
  };
  const onBytes = (chunk: Buffer | string) => {
    if (Buffer.byteLength(chunk) === 0) return;
    if (terminal || failure !== undefined) return fail();
    bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
    if (bytes.length > 256) return fail();
    if (bytes.includes(10)) {
      if (!bytes.equals(Buffer.from('release\n')) && !bytes.equals(Buffer.from('release\r\n'))) return fail();
      terminal = true;
      requestBySignal();
    }
  };
  const onEnd = () => bytes.length !== 0 && !terminal ? fail() : requestBySignal();
  const requested = new Promise<void>((resolve, reject) => {
    requestBySignal = resolve;
    rejectInput = reject;
    input.on('data', onBytes);
    input.once('end', onEnd);
    input.once('error', fail);
    if (input.readableEnded) onEnd();
  });
  return { requested, requestBySignal, assertValid: () => { if (failure !== undefined) throw failure; },
    dispose: () => { input.off('data', onBytes); input.off('end', onEnd); input.off('error', fail); input.pause(); } };
}
