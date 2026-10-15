import assert from 'node:assert/strict';
import test from 'node:test';
import {executionSignature,taskChainDelegateExecution} from '../../src/application/task-chain-execution.js';
test('空旧规格不改变原命令摘要，读取规格按规范 JSON 绑定而不靠对象键顺序',()=>{
 assert.equal(executionSignature({}),undefined);
 assert.equal(executionSignature({file_read_action:{connection_id:'c',resource_id:'r',relative_target:'notes.md'}}),executionSignature({file_read_action:{relative_target:'notes.md',resource_id:'r',connection_id:'c'}}));
 assert.notEqual(executionSignature({tool_loop_action:{allowed_tools:['read_file'],resource_id:'r'}}),executionSignature({tool_loop_action:{allowed_tools:['list_directory'],resource_id:'r'}}));
});

test('每项范围授权不跨 Run，生效期限取本项与链期限的较早者且不改原规格',()=>{
 const spec={scope_grant:{resource_id:'r',allowed_actions:['CLI_RUN'],checks:[],expires_at:'2026-10-14T12:00:00Z'}};
 assert.equal(taskChainDelegateExecution(spec,new Date('2026-10-14T11:00:00Z')).scopeGrant?.expires_at,'2026-10-14T11:00:00.000Z');
 const grant=taskChainDelegateExecution(spec,new Date('2026-10-14T13:00:00Z')).scopeGrant!;
 assert.equal(grant.expires_at,'2026-10-14T12:00:00.000Z');assert.equal(grant.survives_run_terminal,false);assert.equal(spec.scope_grant.expires_at,'2026-10-14T12:00:00Z');
 assert.equal(taskChainDelegateExecution({scope_grant:{resource_id:'r',allowed_actions:['APPLY_CHANGESET'],checks:[]}},new Date('2026-10-14T11:00:00Z')).scopeGrant?.expires_at,'2026-10-14T11:00:00.000Z');
});
