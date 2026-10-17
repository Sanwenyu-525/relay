/**
 * Computer Control 会话状态的唯一持久化位置（migration 0096）。
 *
 * 为什么是一张单行表：电脑操控在 Worker 进程执行（Run 工具循环），而读取方是
 * 桌面壳（Tauri 宿主经 API 轮询）。三个进程只共享 PostgreSQL，「Relay 是否正在
 * 操控电脑」必须是库里的展示事实，不能是任何进程的内存单例。本表不参与审批、
 * 不参与结算；输入效果的真实记账仍在 logical_operations / run_control_requests。
 *
 * 生命周期：
 *   * Worker 派发 COMPUTER_INPUT（以及 RUN 内的 COMPUTER_READ 刷新）→ RUNNING；
 *   * 用户按 Esc → STOP_REQUESTED（同时走 run_control_requests 既有取消通道）；
 *   * 空闲（updated_at 超过 COMPUTER_CONTROL_IDLE_MS 无刷新）→ 读取方惰性落 STOPPED。
 * Worker 不留后台定时器；过期判定由读取路径完成。
 */

import { sql } from 'kysely';

import type { DbExecutor } from '../infrastructure/database.js';
import type { JsonObject } from '../infrastructure/json.js';
import { requireRow } from '../shared/sql-rows.js';

export type ComputerControlSessionState = 'RUNNING' | 'STOP_REQUESTED' | 'STOPPED';

/** 操控会话空闲阈值：超过该时长没有任何 Computer 动作即视为已停止。 */
export const COMPUTER_CONTROL_IDLE_MS = 15_000;

const STATE_COLUMNS = sql.raw('id, run_id, workspace_id, state, action_type, action_label, started_at, updated_at');

export interface ComputerControlStateRow {
  readonly id: number;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly state: ComputerControlSessionState;
  readonly action_type: string;
  readonly action_label: string;
  readonly started_at: Date;
  readonly updated_at: Date;
}

export class ComputerControlStateRepository {
  constructor(private readonly db: DbExecutor) {}

  /** 输入类动作开始/刷新会话：单行 upsert，新会话覆盖旧会话。 */
  async markRunning(input: {
    readonly runId: string; readonly workspaceId: string;
    readonly actionType: string; readonly actionLabel: string;
  }): Promise<ComputerControlStateRow> {
    const result = await sql<ComputerControlStateRow>`
      insert into computer_control_state (id, run_id, workspace_id, state, action_type, action_label)
      values (1, ${input.runId}, ${input.workspaceId}, 'RUNNING',
        ${input.actionType}, ${input.actionLabel})
      on conflict (id) do update set
        run_id = excluded.run_id,
        workspace_id = excluded.workspace_id, state = 'RUNNING',
        action_type = excluded.action_type, action_label = excluded.action_label,
        started_at = case when computer_control_state.run_id = excluded.run_id
          then computer_control_state.started_at else now() end,
        updated_at = now()
      returning ${STATE_COLUMNS}
    `.execute(this.db);
    return requireRow(result.rows, 'mark computer control running');
  }

  /** 只读动作不开启会话，但同一 Run 的会话仍因它而保持活跃并刷新文案。 */
  async refreshRunning(input: {
    readonly runId: string; readonly actionType: string; readonly actionLabel: string;
  }): Promise<void> {
    await sql`
      update computer_control_state set state = 'RUNNING',
        action_type = ${input.actionType}, action_label = ${input.actionLabel}, updated_at = now()
      where state = 'RUNNING' and run_id = ${input.runId}
    `.execute(this.db);
  }

  /** Esc 之后的确认位；只允许从 RUNNING 推进，重复请求幂等。 */
  async markStopRequested(runId: string): Promise<boolean> {
    const result = await sql<ComputerControlStateRow>`
      update computer_control_state set state = 'STOP_REQUESTED', updated_at = now()
      where id = 1 and state = 'RUNNING' and run_id = ${runId}
      returning ${STATE_COLUMNS}
    `.execute(this.db);
    return result.rows.length > 0;
  }

  async readLatest(): Promise<ComputerControlStateRow | undefined> {
    const result = await sql<ComputerControlStateRow>`
      select ${STATE_COLUMNS} from computer_control_state where id = 1
    `.execute(this.db);
    return result.rows[0];
  }

  /** 过期惰性落库：RUNNING 但长时间未刷新 → STOPPED。幂等。 */
  async expireIfIdle(): Promise<void> {
    await sql`
      update computer_control_state set state = 'STOPPED', updated_at = now()
      where id = 1 and state = 'RUNNING'
        and updated_at < now() - ${sql.raw(`interval '${Math.floor(COMPUTER_CONTROL_IDLE_MS / 1000)} seconds'`)}
    `.execute(this.db);
  }
}

/** 读取方的有效状态：行缺失、跨工作空间、已过期都按 STOPPED 投影。 */
export interface ComputerControlSessionDto {
  readonly state: ComputerControlSessionState;
  readonly action_type: string | null;
  readonly action_label: string | null;
  readonly run_id: string | null;
  readonly started_at: string | null;
  readonly updated_at: string | null;
}

const STOPPED_DTO: ComputerControlSessionDto = {
  state: 'STOPPED', action_type: null, action_label: null,
  run_id: null, started_at: null, updated_at: null,
};

export async function readComputerControlSession(db: DbExecutor, workspaceId: string):
Promise<ComputerControlSessionDto> {
  const repository = new ComputerControlStateRepository(db);
  await repository.expireIfIdle();
  const row = await repository.readLatest();
  if (row === undefined || row.workspace_id !== workspaceId) return STOPPED_DTO;
  if (row.state === 'STOPPED') return STOPPED_DTO;
  return {
    state: row.state,
    action_type: row.action_type === '' ? null : row.action_type,
    action_label: row.action_label === '' ? null : row.action_label,
    run_id: row.run_id,
    started_at: row.started_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** Worker 派发路径的会上报：COMPUTER_INPUT 开启/刷新会话，COMPUTER_READ 只刷新。 */
export async function reportComputerControlActivity(db: DbExecutor, input: {
  readonly runId: string; readonly workspaceId: string;
  readonly actionType: string; readonly actionLabel: string; readonly isInput: boolean;
}): Promise<void> {
  const repository = new ComputerControlStateRepository(db);
  if (input.isInput) {
    await repository.markRunning({
      runId: input.runId, workspaceId: input.workspaceId,
      actionType: input.actionType, actionLabel: input.actionLabel,
    });
    return;
  }
  await repository.refreshRunning({
    runId: input.runId, actionType: input.actionType, actionLabel: input.actionLabel,
  });
}

export function isComputerControlRow(value: unknown): value is ComputerControlStateRow {
  return typeof value === 'object' && value !== null && 'state' in value &&
    typeof (value as JsonObject).state === 'string';
}
