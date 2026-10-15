import { sql } from 'kysely';
import { CANONICALIZATION_VERSION, PAYLOAD_HASH_ALGORITHM, } from './payload-hash.js';
import { requireRow } from '../shared/sql-rows.js';
/**
 * 命令回执仓储。唯一键为 (scope_key, command_id)；
 * 回执与业务事实在同一事务提交，重放先比摘要再返回原结果。
 */
export class CommandReceiptRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async findReceipt(key) {
        const result = await sql `
      select scope_key, command_id, command_type, payload_hash, payload_hash_algorithm,
             canonicalization_version, result_ref, created_at
      from command_receipts
      where scope_key = ${key.scopeKey} and command_id = ${key.commandId}
    `.execute(this.db);
        return result.rows[0];
    }
    async insertReceipt(receipt) {
        const result = await sql `
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
