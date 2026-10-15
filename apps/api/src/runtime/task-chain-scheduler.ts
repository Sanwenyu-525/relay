import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RelayDatabase } from '../infrastructure/database.js';
import type { SchemaReadinessChecker } from '../infrastructure/schema-readiness.js';
import { withTransaction } from '../application/unit-of-work.js';
import { readAdmission } from '../application/maintenance-admission.js';
import { tickTaskChains } from '../application/task-chains.js';
export function registerTaskChainScheduler(app:FastifyInstance,d:{database:RelayDatabase;schemaReadiness:SchemaReadinessChecker}) {
 const runtimeId=randomUUID();let active=false;let initialized=false;let timer:NodeJS.Timeout|undefined;let inFlight:Promise<void>=Promise.resolve();let failed=false;
 const tick=async()=>{try {
  const ready=await d.database.checkReadiness(d.schemaReadiness);if(!active || ready.database!=='up' || ready.schema!=='up')return;
  if(!initialized) initialized=await withTransaction(d.database.executor,async r=>{if((await readAdmission(r,'share')).mode!=='NORMAL')return false;await r.taskChains.requireResume(runtimeId);return true;});
  if(initialized) await tickTaskChains(d.database.executor,runtimeId);failed=false;
 }catch{if(!failed)app.log.warn({code:'TASK_CHAIN_TICK_FAILED'},'task_chain_tick_failed');failed=true;}
 finally{if(active){timer=setTimeout(()=>{inFlight=tick();},500);timer.unref();}}};
 app.addHook('onReady',async()=>{active=true;inFlight=tick();await inFlight;});
 app.addHook('onClose',async()=>{active=false;if(timer!==undefined)clearTimeout(timer);await inFlight;});return runtimeId;
}
