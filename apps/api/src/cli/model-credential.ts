import { createInterface } from 'node:readline';

import { CredentialStoreError, isCredentialReference } from '../credentials/credential-store.js';
import { createDpapiCredentialStore, resolveCredentialHelperExecutable,
  resolveCredentialRootOrThrow } from '../credentials/dpapi-credential-store.js';
import { reportFailure } from './cli-support.js';

/**
 * 模型连接凭据的运维入口（P2 前置设施，ADR-036）：
 *
 *   node dist/src/cli/model-credential.js put <reference>     # 秘密从 stdin 读，不走命令行参数
 *   node dist/src/cli/model-credential.js status <reference>
 *   node dist/src/cli/model-credential.js check <reference>   # 只回「有没有、多长」，永不回显秘密
 *   node dist/src/cli/model-credential.js delete <reference>
 *
 * 秘密**只能**从 stdin 进入：命令行参数会出现在进程列表与 shell 历史里。
 * 存放根：`RELAY_CREDENTIAL_ROOT`，缺省 `<RELAY_DATA_ROOT>/credentials`。
 * helper：`RELAY_CREDENTIAL_HELPER`，缺省按进程目录推断 `relay-credential-helper.exe`。
 *
 * 这里没有任何「列出全部凭据」的能力，也不回读摘要——凭据只按引用解析。
 */

/** 从 stdin 读一行秘密；去掉行尾换行，但不 trim 内部内容（Key 可能有前后空白？不，去掉首尾空白更安全）。 */
async function readSecretFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('secret must be piped on stdin, not typed into a terminal');
  }
  const lines: string[] = [];
  const reader = createInterface({ input: process.stdin });
  for await (const line of reader) lines.push(line);
  reader.close();
  const secret = lines.join('\n').trim();
  if (secret === '') throw new Error('stdin did not contain a credential');
  return secret;
}

async function main(): Promise<void> {
  const [command, reference, ...rest] = process.argv.slice(2);
  if (command === undefined || reference === undefined || rest.length > 0) {
    process.stderr.write('usage: model-credential <put|status|check|delete> <reference>\n');
    process.exitCode = 2;
    return;
  }
  if (!isCredentialReference(reference)) {
    process.stderr.write('reference must be 8-64 characters of [A-Za-z0-9_-]\n');
    process.exitCode = 2;
    return;
  }
  const store = createDpapiCredentialStore({ root: resolveCredentialRootOrThrow(process.env),
    executable: resolveCredentialHelperExecutable(process.env) });
  switch (command) {
    case 'put': {
      const secret = await readSecretFromStdin();
      await store.put(reference, secret);
      process.stdout.write(JSON.stringify({ reference, stored: true }) + '\n');
      return;
    }
    case 'status': {
      process.stdout.write(JSON.stringify({ reference, present: await store.status(reference) })
        + '\n');
      return;
    }
    case 'check': {
      const secret = await store.resolve(reference);
      process.stdout.write(JSON.stringify({ reference, present: secret !== undefined,
        length: secret === undefined ? 0 : secret.length }) + '\n');
      return;
    }
    case 'delete': {
      await store.delete(reference);
      process.stdout.write(JSON.stringify({ reference, present: false }) + '\n');
      return;
    }
    default: {
      process.stderr.write(`unknown command: ${command}\n`);
      process.exitCode = 2;
    }
  }
}

main().catch((error: unknown) => {
  if (error instanceof CredentialStoreError) {
    process.stderr.write(`credential store failed: ${error.code}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = reportFailure(error);
});
