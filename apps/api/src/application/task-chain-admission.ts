import { isDeepStrictEqual } from 'node:util';
import type { Repositories } from './unit-of-work.js';
import { invalidTransition } from './domain-error.js';
import { requireTaskChainExecutionCurrent,executionSignature } from './task-chain-execution.js';
export interface TaskChainBinding { chainId: string; itemId: string; runtimeId: string; executionSignature?:string }
export async function requireTaskChainAdmission(r: Repositories, binding: TaskChainBinding, workspaceId: string, taskId: string) {
 const chain = await r.taskChains.read(binding.chainId,true);
 const items = await r.taskChains.items(binding.chainId); const item = items.find((i)=>i.id===binding.itemId);
 if (chain?.workspace_id!==workspaceId || item?.task_id!==taskId || chain.status!=='ACTIVE' || chain.runtime_id!==binding.runtimeId || chain.expires_at===null || chain.expires_at<=await r.taskChains.now()) throw invalidTransition('任务链授权不再允许新准入。');
 if (items.find((i)=>i.status!=='COMPLETED')?.id!==item.id || item.run_id!==null || chain.task_reservations>=chain.max_tasks || chain.calls_started>=chain.max_model_calls || Number((await r.taskChains.usage(chain.id)).uncertain)>0) throw invalidTransition('任务链顺序、累计预算或未知用量禁止新准入。');
 const authority = await r.workspaces.lockAuthority(workspaceId,'share');
 const goals = (await r.projects.listProjectGoalLinks(chain.project_id)).map((g)=>({id:g.goal_id,revision:g.goal_revision.toString(),status:g.goal_status}));
 if (authority?.rule_revision.toString()!==chain.baseline.rule_revision || !isDeepStrictEqual(goals,chain.baseline.goals)) throw invalidTransition('任务链规则或目标依据已经变化，需要重新确认范围。');
 const task = await r.tasks.readTask(taskId);
 if (task?.revision!==item.task_revision || task.acceptance_revision!==item.acceptance_revision || task.project_id!==chain.project_id) throw invalidTransition('原任务版本已经变化，旧授权不能静默改写。');
 if(executionSignature(item.execution_spec)!==binding.executionSignature)throw invalidTransition('任务链执行规格与原绑定不匹配。');
 await requireTaskChainExecutionCurrent(r,workspaceId,chain.project_id,item.execution_spec,item.task_id);
 return {chain,item};
}
