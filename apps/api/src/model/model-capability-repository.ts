import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { ModelCapabilityDeclarationRow } from '../infrastructure/database-schema.js';

/**
 * 模型能力声明的独占 SQL Owner（迁移 0121，2026-10-19）。
 *
 * 与模型目录分开：目录是公开价格快照（只覆盖目录里的模型），这里是**人对某个模型
 * 能力的主张**，按 `(provider, source_model_id)` 存档。一个模型一条，重复声明是覆盖，
 * 撤销是删除——不保留历史版本（没有修订语义，`updated_at` 足够回答「什么时候改的」）。
 *
 * 用例负责开事务并绑定同一个执行器；本仓库不自开 transaction()/commit()。
 * 不发外呼、不写 model_calls、不建 Task/Run。
 */
export class ModelCapabilityRepository {
  constructor(private readonly db: DbExecutor) {}

  async readDeclaration(provider: string, sourceModelId: string):
  Promise<ModelCapabilityDeclarationRow | undefined> {
    return (await sql<ModelCapabilityDeclarationRow>`
      select * from model_capability_declarations
      where provider = ${provider} and source_model_id = ${sourceModelId}`.execute(this.db))
      .rows[0];
  }

  async listDeclarations(): Promise<readonly ModelCapabilityDeclarationRow[]> {
    return (await sql<ModelCapabilityDeclarationRow>`
      select * from model_capability_declarations
      order by provider, source_model_id`.execute(this.db)).rows;
  }

  /** 覆盖写入：同 `(provider, model)` 再声明一次就是改口，不追加第二行。 */
  async writeDeclaration(input: { readonly provider: string; readonly sourceModelId: string;
    readonly imageInput: boolean; readonly note: string | null }): Promise<ModelCapabilityDeclarationRow> {
    return (await sql<ModelCapabilityDeclarationRow>`
      insert into model_capability_declarations (provider, source_model_id, image_input, note)
      values (${input.provider}, ${input.sourceModelId}, ${input.imageInput}, ${input.note})
      on conflict (provider, source_model_id) do update
        set image_input = excluded.image_input, note = excluded.note, updated_at = now()
      returning *`.execute(this.db)).rows[0]!;
  }

  /** 撤销声明：回到「未声明」，而不是记成「不支持」。返回是否真的删掉了一行。 */
  async deleteDeclaration(provider: string, sourceModelId: string): Promise<boolean> {
    const result = await sql<{ provider: string }>`
      delete from model_capability_declarations
      where provider = ${provider} and source_model_id = ${sourceModelId}
      returning provider`.execute(this.db);
    return result.rows.length > 0;
  }
}
