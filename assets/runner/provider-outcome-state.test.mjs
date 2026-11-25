import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restoreSavedProviderResult } from './provider-outcome.mjs';
import { validateSubdivisionRecovery } from './subdivision-state.mjs';
const hash = 'a'.repeat(64), id = '10000000-0000-4000-8000-000000000001';
function recovery(role = 'finalizer') {
 const attempt = {role, attempt_id:id, result_file:'/tmp/provider-fixture/result.json', log_file:'/tmp/provider-fixture/events.jsonl', started_at:'2026-11-14T00:00:00.000Z', finished_at:'2026-11-14T00:00:01.000Z', exit_code:0, turn_completed:true, turn_failed:false, outcome:{source_sha256:hash,result_sha256:hash}};
 return {subdivision:{schema_version:1,id,count:1,rotation_count:0,rotations:[],inventory_file:'.codex-plan-runner/fixture/inventory.json',inventory_sha256:hash,source_sha256:hash,planner:{attempts:0},finalizer:{attempts:0},tasks:[],next_task:0,artifacts:[],[role]:{attempts:1,last_attempt:attempt}}};
}
test('finalizer parent acceptance generation accepts legacy absent, null and exact hashes',()=>{
 for(const value of [undefined,null,hash]) {const r=recovery();if(value!==undefined)r.subdivision.finalizer.last_attempt.parent_acceptance_source_sha256=value;assert.doesNotThrow(()=>validateSubdivisionRecovery(r));}
});
test('finalizer generation rejects malformed hashes and unexpected attempt keys',()=>{
 for(const value of ['', 'g'.repeat(64), 'a'.repeat(63), [hash], 1, {}]) {const r=recovery();r.subdivision.finalizer.last_attempt.parent_acceptance_source_sha256=value;assert.throws(()=>validateSubdivisionRecovery(r),/parent acceptance source/);}
 const r=recovery();r.subdivision.finalizer.last_attempt.unrecognized=true;assert.throws(()=>validateSubdivisionRecovery(r),/saved attempt keys/);
});
test('parent acceptance generation remains forbidden on planner attempts',()=>{
 const r=recovery('planner');r.subdivision.planner.last_attempt.parent_acceptance_source_sha256=hash;assert.throws(()=>validateSubdivisionRecovery(r),/saved attempt keys/);
});
test('provider diagnostic hashes are an optional exact pair',()=>{
 for(const extra of [{},{log_sha256:hash,stderr_sha256:hash}]){const r=recovery();Object.assign(r.subdivision.finalizer.last_attempt.outcome,extra);assert.doesNotThrow(()=>validateSubdivisionRecovery(r));}
 for(const extra of [{log_sha256:hash},{stderr_sha256:hash},{log_sha256:[hash],stderr_sha256:hash},{log_sha256:hash,stderr_sha256:'invalid'}]){const r=recovery();Object.assign(r.subdivision.finalizer.last_attempt.outcome,extra);assert.throws(()=>validateSubdivisionRecovery(r),/provider diagnostic hashes/);}
});

// A successful wire event may follow the timeout signal; transport outcome stays distinct.
test('saved timeout flags remain optional booleans and preserve replayable wire outcomes',()=>{
 for(const role of ['planner','finalizer'])for(const value of [undefined,false,true]){const r=recovery(role);if(value!==undefined)r.subdivision[role].last_attempt.timed_out=value;assert.doesNotThrow(()=>validateSubdivisionRecovery(r));}
 for(const value of [null,0,1,'true',{},[]]){const r=recovery();r.subdivision.finalizer.last_attempt.timed_out=value;assert.throws(()=>validateSubdivisionRecovery(r),/saved attempt timed_out/);}
 const cancelled=recovery();cancelled.subdivision.finalizer.last_attempt.interrupted=true;assert.throws(()=>validateSubdivisionRecovery(cancelled),/outcome lacks/);delete cancelled.subdivision.finalizer.last_attempt.outcome;assert.doesNotThrow(()=>validateSubdivisionRecovery(cancelled));
});
test('provider replay retains timeout and legacy absent flag stays compatible',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'provider-timeout-state-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const log=path.join(directory,'attempt.jsonl');fs.writeFileSync(log,JSON.stringify({type:'turn.completed'})+'\n');fs.writeFileSync(path.join(directory,'attempt-stderr.log'),'');
 for(const value of [undefined,false,true]){const attempt={log_file:log,result_file:path.join(directory,'result.json'),exit_code:0,turn_completed:true,turn_failed:false};if(value!==undefined)attempt.timed_out=value;const result=restoreSavedProviderResult(attempt);assert.equal(result.timedOut,value===true);assert.equal(result.code,0);assert.equal(result.turnCompleted,true);}
});

test('saved retry accounting flags are optional booleans',()=>{
 for(const role of ['planner','finalizer'])for(const value of [undefined,false,true]){const r=recovery(role);if(value!==undefined)r.subdivision[role].last_attempt.retry_accounted=value;assert.doesNotThrow(()=>validateSubdivisionRecovery(r));}
 for(const role of ['planner','finalizer'])for(const value of [null,0,1,'true',{},[]]){const r=recovery(role);r.subdivision[role].last_attempt.retry_accounted=value;assert.throws(()=>validateSubdivisionRecovery(r),/saved attempt retry_accounted/);}
});
