import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { CommandReceiptRow } from '../infrastructure/database-schema.js';
import type { JsonObject } from '../infrastructure/json.js';
import {
  CANONICALIZATION_VERSION,
  PAYLOAD_HASH_ALGORITHM,
} from './payload-hash.js';
import { requireRow } from '../shared/sql-rows.js';

export interface CommandReceiptKey {
  readonly scopeKey: string;
  readonly commandId: string;
}

export interface NewCommandReceipt extends CommandReceiptKey {
  readonly commandType: string;
  readonly payloadHash: Buffer;
  readonly result: JsonObject;
}

/**
 * 命令回执仓储。唯一键为 (scope_key, command_id)；
 * 回执与业务事实在同一事务提交，重放先比摘要再返回原结果。
 */
export class CommandReceiptRepository {
  private readonly db: DbExecutor;

  constructor(db: DbExecutor) {
    this.db = db;
  }

  async findReceipt(key: CommandReceiptKey): Promise<CommandReceiptRow | undefined> {
    const result = await sql<CommandReceiptRow>`
      select scope_key, command_id, command_type, payload_hash, payload_hash_algorithm,
             canonicalization_version, result_ref, created_at
      from command_receipts
      where scope_key = ${key.scopeKey} and command_id = ${key.commandId}
    `.execute(this.db);

    return result.rows[0];
  }

  async insertReceipt(receipt: NewCommandReceipt): Promise<CommandReceiptRow> {
    const result = await sql<CommandReceiptRow>`
      insert into command_receipts (
        scope_key, command_id, command_type, payload_hash,
        payload_hash_algorithm, canonicalization_version, result_ref
      )
      values (
        ${receipt.scopeKey}, ${receipt.commandId}, ${receipt.commandType}, ${receipt.payloadHash},
        ${PAYLOAD_HASH_ALGORITHM}, ${CANONICALIZATION_VERSION}, ${JSON.stringify(receipt.result)}::jsonb
      )
      returning scope_key, command_id, command_type, payload_hash, payload_hash_algorithm,
                canonicalization_version, result_ref, created_at
    `.execute(this.db);

    return requireRow(result.rows, 'insert into command_receipts');
  }
}