import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));

const fakeCodex = String.raw`#!/usr/bin/env node
if (process.argv.includes('login') && process.argv.includes('status')) { console.log('Logged in using ChatGPT'); process.exit(0); }
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { snapshotSource } from './codex-plan-runner/host-validation.mjs';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => { prompt += part; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2), arg = name => args[args.indexOf(name)+1];
  const marker = name => prompt.match(new RegExp('^'+name+': (.+)$','m'))?.[1];
  const schema = JSON.parse(fs.readFileSync(arg('--output-schema'),'utf8'));
  const role = schema.properties.classification ? 'supervisor' : marker('ROLE') || 'worker';
  const config = JSON.parse(fs.readFileSync('fake-config.json','utf8'));
  const manifest = JSON.parse(fs.readFileSync(config.manifest,'utf8'));
  const packageId = marker('PACKAGE_ID'), attemptId = marker('ATTEMPT_ID');
  const subdivisionId = marker('SUBDIVISION_ID'), subtaskId = marker('SUBTASK_ID');
  if (!packageId || !attemptId) throw new Error('Missing package/attempt identity');
  const step = manifest.steps.find(item => item.id === packageId);
  const prior = fs.existsSync('fake-calls.jsonl') ? fs.readFileSync('fake-calls.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const ordinal = prior.filter(call => call.role === role && call.packageId === packageId).length;
  const choices = Array.isArray(config[role]) ? config[role] : config[role]?.[packageId] || ['completed'];
  const action = choices[Math.min(ordinal,choices.length-1)];
  const threadId = args.includes('resume') ? args.at(-2) : '00000000-0000-4000-8000-'+String(prior.length+1).padStart(12,'0');
  const call = {role,action,args,prompt,packageId,attemptId,subdivisionId,subtaskId,threadId,pid:process.pid,schema,at:Date.now(),resultFile:arg('--output-last-message')};
  fs.appendFileSync('fake-calls.jsonl',JSON.stringify(call)+'\n');
  const event = value => process.stdout.write(JSON.stringify(value)+'\n');
  event({type:'thread.started',thread_id:threadId});
  const stateFile = '.codex-plan-runner/'+manifest.plan_id+'/state.json';
  const deadline=Date.now()+2000;
  while(Date.now()<deadline) {
    if(fs.existsSync(stateFile)&&fs.readFileSync(stateFile,'utf8').includes(threadId))break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
  }
  const emit = value => {fs.writeFileSync(call.resultFile,JSON.stringify(value));event({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})};
  const hash = value => createHash('sha256').update(value).digest('hex');
  const source = () => snapshotSource(process.cwd(),[step.validation,step.handoff,path.join(path.dirname(step.plan),'README.md')]).sha256;
  const tamper = target => {
    if(target==='receipt') {fs.mkdirSync(path.dirname(step.validation),{recursive:true});fs.writeFileSync(step.validation,'Forbidden planner/subtask receipt');}
    if(target==='readme')fs.appendFileSync(path.join(path.dirname(step.plan),'README.md'),'Forbidden planner index edit\n');
    if(target==='plan')fs.appendFileSync(step.plan,'\nForbidden scope expansion\n');
    if(target==='runtime')fs.appendFileSync('codex-plan-runner/protocol.mjs','\n// forbidden runtime edit\n');
    if(target==='accepted')fs.appendFileSync(manifest.steps[0].handoff,'\nForbidden accepted artifact edit\n');
    if(target==='state') {const value=JSON.parse(fs.readFileSync(stateFile));value.recovery.revision+=999;fs.writeFileSync(stateFile,JSON.stringify(value));}
    if(target==='checkpoint') {const priorTask=prior.find(call=>call.role==='subtask'&&call.action==='checkpoint');if(!priorTask)throw new Error('Expected accepted subtask');const file=priorTask.prompt.match(/^CHECKPOINT_FILE: (.+)$/m)[1];fs.appendFileSync(file,'\nForbidden checkpoint edit\n');}
  };
  if(action==='hang'||action==='effect-hang') {
    if(action==='effect-hang') {fs.writeFileSync('lib/partial.mjs','export const partial = true;\n');fs.appendFileSync('fake-effects.jsonl',JSON.stringify({role,subtaskId})+'\n');}
    fs.writeFileSync('fake-hanging.json',JSON.stringify(call));setInterval(()=>{},1000);return;
  }
  if(['tpm','tpm-reconnect','oversized','rpm','rate','transport','authentication','quota','configuration'].includes(action)) {
    const message = action.startsWith('tpm') ? 'Rate limit reached on tokens per min (TPM): Limit 1000, Used 900, Requested 300. Please try again.'
      : action==='oversized' ? 'Request too large for tokens per minute (TPM): Limit 1000, Requested 2000.'
      : action==='rpm' ? 'Rate limit reached on requests per min (RPM).'
      : action==='rate' ? '429: Too many requests'
      : action==='transport' ? 'stream disconnected: transport error'
      : action==='authentication' ? 'Invalid API key; authentication failed'
      : action==='quota' ? 'insufficient_quota: billing limit exhausted'
      : 'Invalid configuration: unsupported model';
    if(action==='tpm-reconnect')for(let i=0;i<4;i++)event({type:'error',message});
    event({type:'turn.failed',error:{message,code:action==='transport'?'transport_error':action==='oversized'?'request_too_large':'rate_limit_exceeded',retry_after_ms:config.cooldown}});
    process.exitCode=1;return;
  }
  if(role==='supervisor') {
    emit({schema_version:1,package_id:packageId,attempt_id:attemptId,classification:action==='host'?'environment':action==='resume'?'implementation':'external',action:action==='host'?'host-check':action==='resume'?'resume':'blocked',recipe_id:action==='host'?'npm-checks':null,summary:action==='host'?'Use approved synthetic checks.':'Stop for explicit external requirement.',changed_files:[],blockers:['host','resume'].includes(action)?[]:['Synthetic unresolved external requirement.']});return;
  }
  if(role==='planner') {
    const directory=marker('ARTIFACT_DIRECTORY');
    if(!directory||!subdivisionId)throw new Error('Planner lacks identity/artifact directory');
    const result={schema_version:1,package_id:packageId,attempt_id:attemptId,subdivision_id:subdivisionId,status:'planned',summary:'Two bounded synthetic source checks within unchanged original acceptance.',source_sha256:marker('SOURCE_SHA256'),subtasks:Array.from({length:config.taskCount||2},(_,index)=>String(index+1).padStart(2,'0')).map(id=>({id,title:'Synthetic source change '+id,instructions:'Inspect partial work, implement only source change '+id+' and verify syntax.',checks:['node --check lib/task-'+id+'.mjs'],checkpoint_file:directory+'/task-'+id+'.json'})),blockers:[]};
    if(action==='extra-provider')result.provider='forbidden-provider';
    if(action==='extra-model')result.model='forbidden-model';
    if(action==='command-injection')result.command='touch forbidden-planner-command';
    if(action==='path-escape')result.subtasks[0].checkpoint_file='../escaped.json';
    if(action==='stale-source')result.source_sha256='0'.repeat(64);
    if(action==='stale-attempt')result.attempt_id='old-attempt';
    if(action==='premature-completion')result.status='completed';
    if(action.startsWith('tamper-'))tamper(action.slice(7));
    emit(result);return;
  }
  if(role==='subtask') {
    const checkpointFile=marker('CHECKPOINT_FILE');
    if(!checkpointFile||!subtaskId||!subdivisionId)throw new Error('Subtask lacks identity/checkpoint file');
    const status=action==='blocked'?'blocked':action==='failed'?'failed':'checkpointed';
    const changed=['no-progress','blocked','failed'].includes(action)?[]:['lib/task-'+subtaskId+'.mjs'];
    for(const file of changed)fs.writeFileSync(file,'export const task = '+Number(subtaskId)+';\n');
    const command=changed.length?'node --check '+changed[0]:'node --check lib/dependency.mjs';
    execFileSync(process.execPath,['--check',changed[0]||'lib/dependency.mjs']);
    const checks=[{command,exit_code:0,passed:true}];
    const checkpoint={schema_version:1,package_id:packageId,attempt_id:attemptId,subdivision_id:subdivisionId,subtask_id:subtaskId,summary:status==='blocked'?'Synthetic environment requires approved host checks.':'Inspected partial effects and verified bounded synthetic source.',source_sha256:source(),changed_files:changed,checks,blockers:status==='blocked'?['Synthetic sandbox check requires approved host evidence.']:[],next_steps:['Continue remaining frozen package scope and original final acceptance.']};
    if(action==='stale-source')checkpoint.source_sha256='0'.repeat(64);
    if(action==='stale-attempt')checkpoint.attempt_id='old-attempt';
    fs.mkdirSync(path.dirname(checkpointFile),{recursive:true});fs.writeFileSync(checkpointFile,JSON.stringify(checkpoint));
    const result={...checkpoint,status,checkpoint_file:checkpointFile,checkpoint_sha256:hash(fs.readFileSync(checkpointFile))};delete result.next_steps;
    if(action==='hash-mismatch')result.checkpoint_sha256='0'.repeat(64);
    if(action==='premature-completion')result.status='completed';
    if(action==='path-escape')result.checkpoint_file='../escaped.json';
    if(action==='extra-provider')result.provider='forbidden-provider';
    if(action==='extra-model')result.model='forbidden-model';
    if(action.startsWith('tamper-'))tamper(action.slice(7));
    emit(result);return;
  }
  if(action.startsWith('tamper-'))tamper(action.slice(7));
  const git=(...argv)=>execFileSync('git',argv,{encoding:'utf8'}).trim();
  execFileSync(process.execPath,['--check','lib/dependency.mjs']);
  const receipt={schema_version:1,package_id:packageId,attempt_id:attemptId,status:'completed',source:{head:git('rev-parse','HEAD'),branch:git('branch','--show-current'),dirty:true},changed_files:[step.validation,step.handoff],checks:[{command:'node --check lib/dependency.mjs',exit_code:0,passed:true}],fixtures:[{id:'subdivision-integration',kind:'synthetic',location:'fake-config.json'}],blockers:[]};
  const hostFile=marker('HOST_VALIDATION_FILE'),hostSha=marker('HOST_VALIDATION_SHA256');
  if(hostFile&&action!=='omit-host-attribution'){const evidence=JSON.parse(fs.readFileSync(hostFile));receipt.host_validation={file:hostFile,sha256:hostSha};receipt.checks=evidence.checks.map(check=>({command:check.command,exit_code:check.exit_code,passed:check.passed,origin:'host-validation'}));}
  fs.mkdirSync(path.dirname(step.validation),{recursive:true});fs.mkdirSync(path.dirname(step.handoff),{recursive:true});
  fs.writeFileSync(step.validation,JSON.stringify(receipt,null,2)+'\n');fs.writeFileSync(step.handoff,'Original synthetic acceptance and receipt verified.\n');
  emit({schema_version:1,package_id:packageId,attempt_id:attemptId,status:'completed',summary:'Original acceptance passed in final package worker.',validation_file:step.validation,handoff_file:step.handoff,blockers:[]});
});
`;

const fakeNpm = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync('fake-config.json','utf8'));
const prior = fs.existsSync('fake-host-calls.jsonl') ? fs.readFileSync('fake-host-calls.jsonl','utf8').trim().split('\\n').filter(Boolean).length : 0;
fs.appendFileSync('fake-host-calls.jsonl', JSON.stringify({args, data:process.env.CODEX_PLAN_DATA_DIR, key:process.env.OPENAI_API_KEY, database:process.env.DATABASE_URL, pid:process.pid})+'\\n');
fs.writeFileSync(path.join(process.env.CODEX_PLAN_DATA_DIR,'synthetic-test-data'),'synthetic only');
console.log('Synthetic fixed npm recipe: '+args.join(' '));
if (config.host?.unavailable) {
  console.error('Synthetic approved service unavailable: ECONNREFUSED synthetic://approved-fixture-service.');
  process.exitCode = 1;
}
if (config.host?.hang === 'always' || (config.host?.hang === 'once' && prior === 0)) {
  fs.writeFileSync('fake-host-hanging.json',JSON.stringify({pid:process.pid,data:process.env.CODEX_PLAN_DATA_DIR}));
  setInterval(()=>{},1000);
}
`;

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
function fixture(t, { worker = {'01':['tpm','tpm']}, supervisor = {}, planner = ['plan'], subtask = ['checkpoint'], finalizer = ['completed'], recipes = ['npm-checks'], policy = true, host = {}, cooldown = 60, taskCount = 2 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'runner subdivision integration-')));
  const runners = new Set();
  const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root,relative)),{recursive:true}); fs.writeFileSync(path.join(root,relative),content); };
  // Each test owns its runtime copy, permitting real runtime-tamper tests without
  // modifying another test, the implementation checkout, or its active runner.
  fs.cpSync(runtimeDirectory,path.join(root,'codex-plan-runner'),{recursive:true,filter:file=>!file.endsWith('.test.mjs')});
  write('run.mjs',"import { main } from './codex-plan-runner/runner.mjs';\nmain().then(code=>{process.exitCode=code}).catch(error=>{console.error(error.message);process.exitCode=1});\n");
  const manifestPath = 'plan/manifest.json', policyPath = 'plan/recovery-policy.json';
  const ids = ['01','02','03','15'];
  const manifest = {schema_version:1,plan_id:'synthetic-subdivision',ready:true,source:'plan/source.md',contract:'plan/contract.md',worker_contract:'plan/worker-contract.md',steps:ids.map((id,index)=>({id,title:'Synthetic '+id,plan:'plan/'+id+'.md',validation:'receipts/'+id+'.json',handoff:'handoffs/'+id+'.md',dependencies:index?[ids[index-1]]:[],manual:id==='15'}))};
  if (policy) manifest.recovery={schema_version:1,packages:Object.fromEntries(ids.filter(id=>id!=='15').map(id=>[id,{local_repair:true,recipes}]))};
  write(manifestPath,JSON.stringify(manifest,null,2));
  for (const file of [manifest.source,manifest.contract,manifest.worker_contract,...manifest.steps.map(step=>step.plan)]) write(file,'Synthetic authorized local implementation with immutable acceptance.\n');
  write('AGENTS.md','Only synthetic fixtures; keep unrelated work and accepted artifacts.\n');
  write('.gitignore','.codex-plan-runner/\nfake-config.json\nfake-calls.jsonl\nfake-host-calls.jsonl\nfake-effects.jsonl\nfake-hanging.json\nfake-host-hanging.json\nnode_modules/\n');
  write('package.json',JSON.stringify({private:true,scripts:{test:'node --check lib/dependency.mjs',check:'node --check lib/dependency.mjs'}}));
  write('lib/dependency.mjs','export const state = "BROKEN";\n');
  write('unrelated.txt','User original content.\n');
  write('fake-config.json',JSON.stringify({manifest:manifestPath,policy:policyPath,worker,supervisor,planner,subtask,finalizer,host,cooldown,taskCount}));
  write('fake-codex.mjs',fakeCodex);
  write('bin/npm',fakeNpm);
  fs.chmodSync(path.join(root,'fake-codex.mjs'),0o755);
  fs.chmodSync(path.join(root,'bin/npm'),0o755);
  git(root,'init','--quiet'); git(root,'config','user.name','Synthetic recovery fixture'); git(root,'config','user.email','fixture@example.invalid');
  git(root,'add','.'); git(root,'-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','commit','--quiet','-m','Synthetic baseline');
  write('unrelated.txt','Preserved dirty user content.\n');
  write('untracked-note.txt','Preserved untracked user content.\n');
  t.after(async()=>{
    for(const runner of runners) {
      if(runner.child.exitCode===null&&runner.child.signalCode===null) runner.child.kill('SIGTERM');
      await runner.done;
    }
    fs.rmSync(root,{recursive:true,force:true});
  });
  return {root,manifest,manifestPath,policyPath:policy?policyPath:null,runners,
    stateDir:path.join(root,'.codex-plan-runner',manifest.plan_id),stateFile:path.join(root,'.codex-plan-runner',manifest.plan_id,'state.json'),head:git(root,'rev-parse','HEAD')};
}
function rows(f,file='fake-calls.jsonl') {
  const full = path.join(f.root,file);
  return fs.existsSync(full)?fs.readFileSync(full,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
}
function state(f) {return fs.existsSync(f.stateFile)?JSON.parse(fs.readFileSync(f.stateFile,'utf8')):null;}
// Model a parent operator only in this test's disposable runtime/repository.
// The CLI launches the fixture's fake Codex; real worker restrictions stay intact.
function start(f, options=['--step','01'], command='start') {
  const child=spawn(process.execPath,[path.join(f.root,'run.mjs'),command,'--repo',f.root,'--manifest',f.manifestPath,'--codex-bin',path.join(f.root,'fake-codex.mjs'),
    '--progress-seconds','0','--timeout-minutes','0','--retry-delay-seconds','0.02','--max-delay-seconds','0.04',...options],
  {cwd:f.root,stdio:['ignore','pipe','pipe'],env:{...process.env,CODEX_HOME:path.join(f.root,'fake-auth'),CODEX_PLAN_WORKER:'0',CODEX_RECOVERY_SUPERVISOR:'0',PATH:path.join(f.root,'bin')+path.delimiter+process.env.PATH,OPENAI_API_KEY:'synthetic-should-be-scrubbed',DATABASE_URL:'synthetic-should-be-scrubbed'}});
  let stdout='',stderr='',timedOut=false,force;
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',data=>{stdout+=data});child.stderr.on('data',data=>{stderr+=data});
  const deadline=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');force=setTimeout(()=>child.kill('SIGKILL'),1000)},20000);
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(status,signal)=>{clearTimeout(deadline);clearTimeout(force);resolve({status,signal,stdout,stderr,timedOut})})});
  const runner={child,done};f.runners.add(runner);return runner;
}
async function run(f,options,command) {const result=await start(f,options,command).done;assert.equal(result.timedOut,false,result.stdout+'\n'+result.stderr);return result;}
function ok(result){assert.equal(result.status,0,result.stdout+'\n'+result.stderr);}
function preserve(f){assert.equal(fs.readFileSync(path.join(f.root,'unrelated.txt'),'utf8'),'Preserved dirty user content.\n');assert.equal(fs.readFileSync(path.join(f.root,'untracked-note.txt'),'utf8'),'Preserved untracked user content.\n');assert.equal(git(f.root,'rev-parse','HEAD'),f.head);}
function assertIsolation(call) {
  assert.equal(call.args[call.args.indexOf('--sandbox')+1],call.role==='planner'?'read-only':'workspace-write');
  assert.equal(call.args[call.args.indexOf('-c')+1],'approval_policy="never"');
  assert.equal(call.args.includes('--dangerously-bypass-approvals-and-sandbox'),false);
  assert.equal(call.schema.additionalProperties,false);
}
async function waitFor(predicate, { runner, timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let finished;
  if (runner) runner.done.then(result => { finished = result; });
  while (Date.now() < deadline) {
    const found = predicate(); if (found) return found;
    if (finished) assert.fail(`Runner exited before the expected durable phase (${finished.status}):\n${finished.stdout}\n${finished.stderr}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail('Timed out waiting for durable recovery phase');
}

// The initial package worker is the only resumed oversized thread. Planner,
// each subtask, and finalizer must begin in independent fresh conversations.
test('two explicit TPM attempts run a planner, two fresh subtasks and fresh original-package finalizer',async t=>{
  const f=fixture(t);ok(await run(f));
  const calls=rows(f);
  assert.deepEqual(calls.map(call=>call.role),['worker','worker','planner','subtask','subtask','finalizer']);
  assert.equal(calls[0].threadId,calls[1].threadId);
  assert.equal(new Set(calls.slice(1).map(call=>call.threadId)).size,5);
  calls.slice(2).forEach(call=>assert.equal(call.args.includes('resume'),false));
  calls.forEach(assertIsolation);
  const plannerCall=calls[2];
  assert.equal(plannerCall.args[plannerCall.args.indexOf('--output-last-message')+1],plannerCall.resultFile);
  assert.match(plannerCall.prompt,/CLI writes --output-last-message outside the tool sandbox/);
  assert.match(plannerCall.prompt,/Do not use a tool to write the result/);
  assert.match(plannerCall.prompt,/Do not write any runner-directory output/);
  assert.ok(calls[2].at-calls[1].at>=60,'planner honors the second provider cooldown');
  const entry=state(f).steps['01'];
  assert.equal(entry.status,'completed');assert.equal(entry.rate_limit_count,2);
  assert.equal(entry.recovery.subdivision.tasks.length,2);
  assert.equal(entry.recovery.subdivision.next_task,2);
  assert.ok(entry.recovery.subdivision.tasks.every(task=>task.accepted));
  assert.match(calls.at(-1).prompt,/original|acceptance/i);
  assert.match(calls.at(-1).prompt,/checkpoint/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,f.manifest.steps[0].validation))).attempt_id,calls.at(-1).attemptId);
  assert.equal(state(f).steps['02'],undefined);preserve(f);
});

test('multiple reconnect notices in one failed attempt do not trigger early subdivision',async t=>{
  const f=fixture(t,{worker:{'01':['tpm-reconnect','completed']}});ok(await run(f));
  assert.deepEqual(rows(f).map(call=>call.role),['worker','worker']);
  assert.equal(state(f).steps['01'].rate_limit_count,1);preserve(f);
});

for(const kind of ['rpm','rate'])test(`${kind} retries retain ordinary worker sessions without subdivision`,async t=>{
  const f=fixture(t,{worker:{'01':[kind,kind,'completed']}});ok(await run(f));
  const calls=rows(f);assert.ok(calls.every(call=>call.role==='worker'));assert.equal(new Set(calls.map(call=>call.threadId)).size,1);
  assert.equal(state(f).steps['01'].rate_limit_count,2);preserve(f);
});

for(const kind of ['authentication','quota','configuration'])test(`${kind} cannot trigger planner or change provider`,async t=>{
  const f=fixture(t,{worker:{'01':[kind]}});assert.notEqual((await run(f)).status,0);
  assert.equal(rows(f).length,1);assert.equal(rows(f)[0].role,'worker');preserve(f);
});

for(const action of ['extra-provider','extra-model','command-injection','path-escape','stale-source','stale-attempt','premature-completion','tamper-receipt','tamper-readme','tamper-plan','tamper-runtime','tamper-state'])test(`planner ${action} fails closed before any subtask`,async t=>{
  const f=fixture(t,{planner:[action]});const result=await run(f);assert.notEqual(result.status,0,result.stdout);
  const protocolFailure = !action.startsWith('tamper-');
  const calls = rows(f), planners = calls.filter(call => call.role === 'planner');
  assert.deepEqual(calls.map(call=>call.role), protocolFailure ? ['worker','worker','planner','planner','planner'] : ['worker','worker','planner']);
  if (protocolFailure) {
    assert.equal(new Set(planners.map(call => call.threadId)).size, 1);
    assert.match(planners[1].prompt, /PROTOCOL_CORRECTION_REQUIRED/);
    assert.equal(state(f).steps['01'].recovery.protocol_retry_count, 2);
    assert.equal(state(f).steps['01'].recovery.history.filter(item => item.action === 'protocol-rejected').length, 3);
  }
  assert.equal(state(f).steps['01'].recovery.subdivision.tasks.length, 0);
  assert.notEqual(state(f).steps['01'].status,'completed');assert.equal(fs.existsSync(path.join(f.root,'forbidden-planner-command')),false);preserve(f);
});

for(const action of ['extra-provider','extra-model','path-escape','stale-source','stale-attempt','hash-mismatch','premature-completion','tamper-receipt'])test(`subtask ${action} cannot become accepted package completion`,async t=>{
  const f=fixture(t,{subtask:[action]});const result=await run(f);assert.notEqual(result.status,0,result.stdout);
  const protocolFailure = !action.startsWith('tamper-');
  const calls = rows(f), subtasks = calls.filter(call => call.role === 'subtask');
  assert.deepEqual(calls.map(call=>call.role), protocolFailure ? ['worker','worker','planner','subtask','subtask','subtask'] : ['worker','worker','planner','subtask']);
  if (protocolFailure) {
    assert.equal(new Set(subtasks.map(call => call.threadId)).size, 1);
    assert.match(subtasks[1].prompt, /PROTOCOL_CORRECTION_REQUIRED/);
    assert.equal(state(f).steps['01'].recovery.protocol_retry_count, 2);
    assert.equal(state(f).steps['01'].recovery.history.filter(item => item.action === 'protocol-rejected').length, 3);
  }
  assert.equal(state(f).steps['01'].recovery.subdivision.tasks.some(task => task.accepted), false);
  assert.notEqual(state(f).steps['01'].status,'completed');assert.equal(state(f).steps['02'],undefined);preserve(f);
});

test('second subtask cannot mutate an accepted checkpoint or advance to finalizer',async t=>{
  const f=fixture(t,{subtask:['checkpoint','tamper-checkpoint']});assert.notEqual((await run(f)).status,0);
  assert.deepEqual(rows(f).map(call=>call.role),['worker','worker','planner','subtask','subtask']);
  assert.notEqual(state(f).steps['01'].status,'completed');preserve(f);
});

test('subdivision preserves predecessor receipts and selected range and manual boundary',async t=>{
  const f=fixture(t,{worker:{'01':['completed'],'02':['tpm','tpm']}});
  ok(await run(f,['--step','01']));const predecessor=state(f).steps['01'];
  const paths=[f.manifest.steps[0].validation,f.manifest.steps[0].handoff,predecessor.last_attempt.result_file];
  const originals=paths.map(file=>fs.readFileSync(path.resolve(f.root,file)));
  ok(await run(f,['--step','02']));paths.forEach((file,index)=>assert.deepEqual(fs.readFileSync(path.resolve(f.root,file)),originals[index]));
  assert.equal(state(f).steps['03'],undefined);
  const count=rows(f).length;assert.equal((await run(f,['--step','15'])).status,2);assert.equal(rows(f).length,count);preserve(f);
});

test('SIGTERM during TPM cooldown retains deadline and resumes planner after the wait',async t=>{
  const f=fixture(t,{cooldown:1000});const running=start(f);
  const before=await waitFor(()=>{const saved=state(f)?.steps['01'];return saved?.rate_limit_count===2&&saved.retry_at?saved:null});
  running.child.kill('SIGTERM');assert.equal((await running.done).status,143);
  assert.equal(state(f).steps['01'].retry_at,before.retry_at);
  assert.equal(rows(f).length,2);
  const status=await run(f,[],'status');ok(status);assert.match(status.stdout,/subdiv|planner|TPM/i);
  ok(await run(f));const calls=rows(f);
  assert.equal(calls[2].role,'planner');assert.ok(calls[2].at>=Date.parse(before.retry_at));
  assert.equal(state(f).steps['01'].rate_limit_count,2);preserve(f);
});

test('SIGTERM in a subtask preserves its thread, partial effects and accepted predecessor checkpoint',async t=>{
  const f=fixture(t,{subtask:['checkpoint','effect-hang','checkpoint']});const running=start(f);
  const hanging=await waitFor(()=>{const file=path.join(f.root,'fake-hanging.json');return fs.existsSync(file)&&JSON.parse(fs.readFileSync(file))});
  assert.equal(hanging.role,'subtask');assert.equal(hanging.subtaskId,'02');
  const saved=state(f).steps['01'].recovery.subdivision;
  const accepted=structuredClone(saved.tasks[0].accepted);
  running.child.kill('SIGTERM');assert.equal((await running.done).status,143);
  ok(await run(f));const calls=rows(f),subtasks=calls.filter(call=>call.role==='subtask');
  assert.equal(subtasks.length,3);assert.equal(subtasks[1].threadId,subtasks[2].threadId);
  assert.equal(subtasks[2].args.includes('resume'),true);
  assert.deepEqual(state(f).steps['01'].recovery.subdivision.tasks[0].accepted,accepted);
  assert.equal(rows(f,'fake-effects.jsonl').length,1);assert.equal(fs.readFileSync(path.join(f.root,'lib/partial.mjs'),'utf8'),'export const partial = true;\n');
  preserve(f);
});

test('bounded subtask TPM rotations never replan recursively or reset rate counts on restart',async t=>{
  const f=fixture(t,{subtask:['tpm']});const args=['--step','01','--max-session-rotations','1'];
  assert.notEqual((await run(f,args)).status,0);
  const calls=rows(f),saved=state(f).steps['01'];
  assert.equal(calls.filter(call=>call.role==='planner').length,1);
  assert.ok(saved.rate_limit_count>=4);assert.notEqual(saved.status,'completed');
  const count=calls.length;assert.notEqual((await run(f,args)).status,0);assert.equal(rows(f).length,count);
  const status=await run(f,[],'status');ok(status);assert.match(status.stdout,/rotat|budget|exhaust/i);preserve(f);
});

test('finite total rate budget remains exhausted across restart before subdivision side effects',async t=>{
  const f=fixture(t);const args=['--step','01','--max-rate-retries','1'];
  assert.equal((await run(f,args)).status,75);const count=rows(f).length;
  assert.equal(count,2);assert.equal((await run(f,args)).status,75);assert.equal(rows(f).length,count);preserve(f);
});

test('approved host recovery returns to the blocked subtask and preserves its fresh identity',async t=>{
  const f=fixture(t,{subtask:['checkpoint','blocked','checkpoint'],supervisor:{'01':['host']}});
  ok(await run(f));const calls=rows(f);
  assert.deepEqual(calls.map(call=>call.role),['worker','worker','planner','subtask','subtask','supervisor','subtask','finalizer']);
  const subtasks=calls.filter(call=>call.role==='subtask');assert.equal(subtasks[1].threadId,subtasks[2].threadId);
  assert.equal(subtasks[2].subtaskId,'02');assert.match(subtasks[2].prompt,/HOST_VALIDATION_FILE/);
  assert.ok(rows(f,'fake-host-calls.jsonl').length>=2);assert.equal(calls.filter(call=>call.role==='worker').length,2);preserve(f);
});

test('explicit oversized TPM request subdivides after its first honored cooldown',async t=>{
  const f=fixture(t,{worker:{'01':['oversized']}});ok(await run(f));
  const calls=rows(f);assert.deepEqual(calls.map(call=>call.role),['worker','planner','subtask','subtask','finalizer']);
  assert.ok(calls[1].at-calls[0].at>=60);assert.equal(state(f).steps['01'].rate_limit_count,1);preserve(f);
});

test('subtask transport cooldown resumes its own thread without touching oversized parent',async t=>{
  const f=fixture(t,{subtask:['transport','checkpoint','checkpoint']});ok(await run(f));
  const calls=rows(f);assert.deepEqual(calls.map(call=>call.role),['worker','worker','planner','subtask','subtask','subtask','finalizer']);
  assert.equal(calls[3].threadId,calls[4].threadId);assert.notEqual(calls[4].threadId,calls[5].threadId);
  assert.equal(state(f).steps['01'].recovery.transport_count,1);preserve(f);
});

test('planner TPM cooldown retries the planner role and retains original total counters',async t=>{
  const f=fixture(t,{planner:['tpm','plan']});ok(await run(f));
  const calls=rows(f);assert.deepEqual(calls.map(call=>call.role),['worker','worker','planner','planner','subtask','subtask','finalizer']);
  assert.equal(calls[2].threadId,calls[3].threadId);assert.ok(calls[3].at-calls[2].at>=60);
  assert.equal(state(f).steps['01'].rate_limit_count,3);preserve(f);
});

test('repeated unchanged subtask failures stop at the durable no-progress budget',async t=>{
  const f=fixture(t,{subtask:['failed'],supervisor:{'01':['resume']}});assert.notEqual((await run(f)).status,0);
  const saved=state(f).steps['01'];assert.notEqual(saved.status,'completed');assert.ok(saved.recovery.no_progress_count>=2);
  const count=rows(f).length;assert.notEqual((await run(f)).status,0);assert.equal(rows(f).length,count);preserve(f);
});

test('restart reconciles a saved successful subtask output before repeating accepted effects',async t=>{
  const f=fixture(t,{finalizer:['hang','completed']});const running=start(f);
  const hanging=await waitFor(()=>{const file=path.join(f.root,'fake-hanging.json');return fs.existsSync(file)&&JSON.parse(fs.readFileSync(file))});
  assert.equal(hanging.role,'finalizer');running.child.kill('SIGTERM');assert.equal((await running.done).status,143);
  // Reproduce only the parent-owned durable window after saving a successful
  // second subtask outcome, before accepting it. All real result bytes remain.
  const saved=state(f),r=saved.steps['01'].recovery,s=r.subdivision,accepted=s.tasks[1].accepted;
  assert.ok(s.tasks[1].actor.last_attempt.outcome);
  s.tasks[1].accepted=null;s.next_task=1;s.finalizer={attempts:0};
  s.artifacts=s.artifacts.filter(item=>![accepted.file,accepted.result_file].includes(item.file));
  r.phase='subtask';r.next_action='await-subtask';r.return_actor='subtask';
  fs.writeFileSync(f.stateFile,JSON.stringify(saved));
  ok(await run(f));assert.equal(rows(f).filter(call=>call.role==='subtask').length,2);
  assert.equal(state(f).steps['01'].status,'completed');preserve(f);
});

test('stale saved subtask output stops for reconciliation after intervening source edits',async t=>{
  const f=fixture(t,{finalizer:['hang','completed']});const running=start(f);
  await waitFor(()=>fs.existsSync(path.join(f.root,'fake-hanging.json')));running.child.kill('SIGTERM');assert.equal((await running.done).status,143);
  const saved=state(f),r=saved.steps['01'].recovery,s=r.subdivision,accepted=s.tasks[1].accepted;
  s.tasks[1].accepted=null;s.next_task=1;s.finalizer={attempts:0};
  s.artifacts=s.artifacts.filter(item=>![accepted.file,accepted.result_file].includes(item.file));
  r.phase='subtask';r.next_action='await-subtask';r.return_actor='subtask';fs.writeFileSync(f.stateFile,JSON.stringify(saved));
  fs.appendFileSync(path.join(f.root,'lib/dependency.mjs'),'\n// Legitimate intervening source correction.\n');
  const result=await run(f);assert.notEqual(result.status,0);
  assert.match(result.stdout+'\n'+result.stderr,/stale|unknown effects|reconcil/i);
  assert.equal(rows(f).filter(call=>call.role==='subtask').length,2);
  assert.notEqual(state(f).steps['01'].status,'completed');preserve(f);
});

test('supervisor cooldown retains the blocked subtask return actor through approved host recovery',async t=>{
  const f=fixture(t,{subtask:['checkpoint','blocked','checkpoint'],supervisor:{'01':['tpm','host']}});
  ok(await run(f));const calls=rows(f),supervisors=calls.filter(call=>call.role==='supervisor'),subtasks=calls.filter(call=>call.role==='subtask');
  assert.equal(supervisors.length,2);assert.equal(supervisors[0].threadId,supervisors[1].threadId);
  assert.ok(supervisors[1].at-supervisors[0].at>=60);
  assert.equal(subtasks.length,3);assert.equal(subtasks[1].threadId,subtasks[2].threadId);
  assert.equal(calls.filter(call=>call.role==='worker').length,2);assert.equal(state(f).steps['01'].rate_limit_count,3);preserve(f);
});

test('finalizer rate cooldown resumes fresh finalizer instead of the oversized original thread',async t=>{
  const f=fixture(t,{finalizer:['tpm','completed']});ok(await run(f));const calls=rows(f),finalizers=calls.filter(call=>call.role==='finalizer');
  assert.equal(finalizers.length,2);assert.equal(finalizers[0].threadId,finalizers[1].threadId);
  assert.notEqual(finalizers[0].threadId,calls[0].threadId);assert.equal(calls.filter(call=>call.role==='worker').length,2);
  assert.equal(state(f).steps['01'].rate_limit_count,3);preserve(f);
});

test('explicit fresh session during supervisor interruption replaces only supervisor and preserves returning subtask',async t=>{
  const f=fixture(t,{subtask:['checkpoint','blocked','checkpoint'],supervisor:{'01':['hang','host']}});
  const running=start(f);
  const hanging=await waitFor(()=>{const file=path.join(f.root,'fake-hanging.json');return fs.existsSync(file)&&JSON.parse(fs.readFileSync(file))});
  assert.equal(hanging.role,'supervisor');
  const before=state(f).steps['01'],subtaskThread=before.recovery.subdivision.tasks[1].actor.thread_id;
  const accepted=structuredClone(before.recovery.subdivision.tasks[0].accepted);
  running.child.kill('SIGTERM');assert.equal((await running.done).status,143);
  ok(await run(f,['--step','01','--fresh-session']));
  const calls=rows(f),supervisors=calls.filter(call=>call.role==='supervisor'),subtasks=calls.filter(call=>call.role==='subtask');
  assert.equal(supervisors.length,2);assert.notEqual(supervisors[0].threadId,supervisors[1].threadId);
  assert.equal(supervisors[1].args.includes('resume'),false);
  assert.equal(subtasks.length,3);assert.equal(subtasks[2].threadId,subtaskThread);
  assert.equal(subtasks[2].args.includes('resume'),true);
  assert.deepEqual(state(f).steps['01'].recovery.subdivision.tasks[0].accepted,accepted);
  assert.equal(state(f).steps['01'].rate_limit_count,before.rate_limit_count);
  assert.equal(state(f).steps['01'].recovery.repair_count,before.recovery.repair_count);
  assert.equal(calls.filter(call=>call.role==='worker').length,2);preserve(f);
});

test('explicit fresh session archives a rejected planner outcome and retries only planner without resetting counters',async t=>{
  const f=fixture(t,{planner:['extra-provider','plan']});assert.notEqual((await run(f,['--step','01','--max-protocol-retries','0'])).status,0);
  const before=state(f).steps['01'],rejected=rows(f).find(call=>call.role==='planner');
  const original=fs.readFileSync(rejected.resultFile);
  assert.equal(before.recovery.subdivision.tasks.length,0);
  ok(await run(f,['--step','01','--fresh-session','--max-protocol-retries','1']));
  const calls=rows(f),planners=calls.filter(call=>call.role==='planner'),after=state(f).steps['01'];
  assert.equal(planners.length,2);assert.notEqual(planners[0].threadId,planners[1].threadId);
  assert.equal(planners[1].args.includes('resume'),false);assert.equal(planners[0].subdivisionId,planners[1].subdivisionId);
  assert.deepEqual(fs.readFileSync(rejected.resultFile),original);
  assert.ok(after.recovery.history.some(item=>JSON.stringify(item).includes(rejected.attemptId)),'rejected attempt must remain referenced in durable history');
  assert.equal(after.rate_limit_count,before.rate_limit_count);assert.equal(after.recovery.tpm_failure_count,before.recovery.tpm_failure_count);
  assert.equal(after.recovery.subdivision.count,1);assert.equal(calls.filter(call=>call.role==='worker').length,2);preserve(f);
});

// The planner needs partial work, even when clean source sorts before it.
test('compact planner inventory retains dirty partial work in a repository with many clean files', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'aa-clean'));
  for (let index = 0; index < 70; index++) fs.writeFileSync(path.join(f.root, 'aa-clean', `${index}.txt`), 'Untouched source fixture.\n');
  git(f.root, 'add', 'aa-clean');
  git(f.root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Clean source inventory');
  f.head = git(f.root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(f.root, 'zz-partial-work.mjs'), 'export const partial = true;\n');
  ok(await run(f));
  const inventory = JSON.parse(fs.readFileSync(path.join(f.root, state(f).steps['01'].recovery.subdivision.inventory_file), 'utf8'));
  assert.ok(inventory.total_files > 70);
  assert.ok(inventory.files.some(file => file.path === 'zz-partial-work.mjs'));
  assert.ok(inventory.files.some(file => file.path === 'unrelated.txt'));
  assert.ok(inventory.files.every(file => !file.path.startsWith('aa-clean/')));
  assert.ok(inventory.files.length <= 60);
  assert.match(inventory.instruction, /pre-existing user work/);
  preserve(f);
});

// Recreate the parent-owned window after successful planner output is durable
// but before its proposed task list has been accepted. The source baseline must
// come from the saved actor, even when the result/output hash is still current.
for (const mismatch of [false, true]) test(`saved successful planner replay ${mismatch ? 'rejects a changed input baseline' : 'uses the original input baseline without rerunning'}`, async t => {
  const f=fixture(t,{subtask:['hang','checkpoint']});const running=start(f);
  const hanging=await waitFor(()=>{const file=path.join(f.root,'fake-hanging.json');return fs.existsSync(file)&&JSON.parse(fs.readFileSync(file))});
  assert.equal(hanging.role,'subtask');running.child.kill('SIGTERM');assert.equal((await running.done).status,143);
  const saved=state(f),r=saved.steps['01'].recovery,s=r.subdivision;
  assert.ok(s.planner.last_attempt.outcome);
  s.tasks=[];s.next_task=0;s.artifacts=[];
  r.phase='planner';r.return_actor='planner';r.next_action='await-planner';
  if(mismatch)s.planner.input_source_sha256='0'.repeat(64);
  fs.writeFileSync(f.stateFile,JSON.stringify(saved));
  const result=await run(f);
  if(mismatch){
    assert.notEqual(result.status,0,result.stdout);
    assert.match(result.stdout+'\n'+result.stderr,/planner input source changed/i);
    assert.equal(rows(f).filter(call=>call.role==='subtask').length,1);
    assert.notEqual(state(f).steps['01'].status,'completed');
  }else{ok(result);assert.equal(state(f).steps['01'].status,'completed');}
  assert.equal(rows(f).filter(call=>call.role==='planner').length,1);preserve(f);
});

test('six changing subtasks defer early host freshness until one final refresh',async t=>{
  const f=fixture(t,{taskCount:6,subtask:['blocked','checkpoint'],supervisor:{'01':['host']}});
  ok(await run(f));const calls=rows(f),entry=state(f).steps['01'],r=entry.recovery;
  assert.equal(r.subdivision.next_task,6);assert.equal(r.evidence_refresh_count,1);
  assert.equal(rows(f,'fake-host-calls.jsonl').length,4,'one initial two-command recipe plus one final refresh');
  assert.equal(calls.filter(call=>call.role==='subtask').length,7);
  const subtasks=calls.filter(call=>call.role==='subtask');
  assert.match(subtasks[1].prompt,/HOST_VALIDATION_FILE/);
  subtasks.slice(2).forEach(call=>assert.doesNotMatch(call.prompt,/^HOST_VALIDATION_FILE:/m));
  assert.match(calls.at(-1).prompt,/^HOST_VALIDATION_FILE:/m);assert.equal(calls.at(-1).role,'finalizer');
  assert.equal(r.host_evidence_deferred,false);assert.ok(r.pending_evidence.file);
  assert.equal(r.history.filter(item=>item.action==='stale-evidence').length,1);
  const receipt=JSON.parse(fs.readFileSync(path.join(f.root,f.manifest.steps[0].validation)));
  assert.deepEqual(receipt.host_validation,{file:r.pending_evidence.file,sha256:r.pending_evidence.sha256});
  assert.ok(receipt.checks.every(check=>check.origin==='host-validation'));preserve(f);
});

test('interruption preserves deferred evidence and budgets through remaining subtasks',async t=>{
  const f=fixture(t,{taskCount:6,subtask:['blocked','checkpoint','hang','checkpoint'],supervisor:{'01':['host']}});
  const running=start(f);const hanging=await waitFor(()=>{const file=path.join(f.root,'fake-hanging.json');return fs.existsSync(file)&&JSON.parse(fs.readFileSync(file))});
  assert.equal(hanging.subtaskId,'02');running.child.kill('SIGTERM');assert.equal((await running.done).status,143);
  const before=structuredClone(state(f).steps['01']),r=before.recovery;
  assert.equal(r.host_evidence_deferred,true);assert.equal(r.evidence_refresh_count,0);assert.ok(r.pending_evidence.file);
  const evidence=fs.readFileSync(path.join(f.root,r.pending_evidence.file));
  ok(await run(f,[],'status'));assert.deepEqual(state(f).steps['01'],before);
  ok(await run(f));const after=state(f).steps['01'];
  assert.equal(after.recovery.evidence_refresh_count,1);assert.equal(after.rate_limit_count,before.rate_limit_count);
  assert.equal(after.recovery.repair_count,r.repair_count);assert.equal(after.recovery.transport_count,r.transport_count);
  assert.deepEqual(after.recovery.subdivision.tasks[0].accepted,r.subdivision.tasks[0].accepted);
  assert.deepEqual(fs.readFileSync(path.join(f.root,r.pending_evidence.file)),evidence);
  const resumed=rows(f).filter(call=>call.role==='subtask'&&call.subtaskId==='02');
  assert.equal(resumed.length,2);assert.equal(resumed[0].threadId,resumed[1].threadId);
  assert.equal(rows(f,'fake-host-calls.jsonl').length,4);preserve(f);
});

test('corrupt deferred host logs fail before another subtask or host refresh',async t=>{
  const f=fixture(t,{taskCount:6,subtask:['blocked','checkpoint','hang','checkpoint'],supervisor:{'01':['host']}});
  const running=start(f);await waitFor(()=>fs.existsSync(path.join(f.root,'fake-hanging.json')));
  running.child.kill('SIGTERM');assert.equal((await running.done).status,143);
  const before=state(f).steps['01'].recovery,callCount=rows(f).length,hostCount=rows(f,'fake-host-calls.jsonl').length;
  assert.equal(before.host_evidence_deferred,true);
  const evidence=JSON.parse(fs.readFileSync(path.join(f.root,before.pending_evidence.file)));
  fs.appendFileSync(path.join(f.root,evidence.checks[0].log_file),'Corrupted deferred log.\n');
  const result=await run(f);assert.notEqual(result.status,0);assert.match(result.stderr+'\n'+result.stdout,/check log changed/);
  assert.equal(rows(f).length,callCount);assert.equal(rows(f,'fake-host-calls.jsonl').length,hostCount);
  assert.deepEqual(state(f).steps['01'].recovery.pending_evidence,before.pending_evidence);
  assert.equal(state(f).steps['01'].recovery.evidence_refresh_count,0);preserve(f);
});

test('finalizer cannot omit original host attribution after deferred evidence refresh',async t=>{
  const f=fixture(t,{taskCount:6,subtask:['blocked','checkpoint'],supervisor:{'01':['host','blocked']},finalizer:['omit-host-attribution']});
  const result=await run(f);assert.notEqual(result.status,0);
  const calls=rows(f),finalizer=calls.find(call=>call.role==='finalizer');assert.ok(finalizer);
  assert.match(finalizer.prompt,/^HOST_VALIDATION_FILE:/m);
  assert.match(result.stdout+'\n'+result.stderr,/Receipt must explicitly cite the supplied host validation evidence/);
  assert.notEqual(state(f).steps['01'].status,'completed');assert.equal(state(f).steps['01'].recovery.evidence_refresh_count,1);
  assert.equal(rows(f,'fake-host-calls.jsonl').length,4);preserve(f);
});

test('exhausted deferred evidence refresh budget blocks before finalizer and survives restart',async t=>{
  const f=fixture(t,{taskCount:6,subtask:['blocked','checkpoint'],supervisor:{'01':['host']}});
  const args=['--step','01','--max-evidence-refreshes','0'];
  const result=await run(f,args);assert.equal(result.status,75);assert.match(result.stdout+'\n'+result.stderr,/Host evidence refresh budget exhausted/);
  const before=state(f).steps['01'],calls=rows(f).length;
  assert.equal(before.recovery.subdivision.next_task,6);assert.equal(before.recovery.host_evidence_deferred,false);
  assert.equal(before.recovery.evidence_refresh_count,0);assert.ok(before.recovery.pending_evidence.file);
  assert.equal(rows(f,'fake-host-calls.jsonl').length,2);assert.equal(rows(f).some(call=>call.role==='finalizer'),false);
  assert.equal((await run(f,args)).status,75);assert.equal(rows(f).length,calls);
  assert.deepEqual(state(f).steps['01'].recovery.pending_evidence,before.recovery.pending_evidence);
  ok(await run(f,['--step','01','--max-evidence-refreshes','1']));
  assert.equal(rows(f).filter(call=>call.role==='finalizer').length,1);assert.equal(rows(f,'fake-host-calls.jsonl').length,4);
  assert.equal(state(f).steps['01'].recovery.evidence_refresh_count,1);preserve(f);
});

test('explicit later supervisor host request ends deferral before returning to its subtask',async t=>{
  const f=fixture(t,{taskCount:6,subtask:['blocked','checkpoint','blocked','checkpoint'],supervisor:{'01':['host']}});
  ok(await run(f));const calls=rows(f),subtasks=calls.filter(call=>call.role==='subtask');
  assert.equal(calls.filter(call=>call.role==='supervisor').length,2);
  assert.doesNotMatch(subtasks[2].prompt,/^HOST_VALIDATION_FILE:/m);assert.match(subtasks[3].prompt,/^HOST_VALIDATION_FILE:/m);
  assert.equal(subtasks[2].threadId,subtasks[3].threadId);
  assert.equal(state(f).steps['01'].recovery.evidence_refresh_count,2);assert.equal(rows(f,'fake-host-calls.jsonl').length,6);preserve(f);
});

test('request_too_large supervisor TPM rotates once and preserves returning subtask',async t=>{
  const f=fixture(t,{subtask:['checkpoint','blocked','checkpoint'],supervisor:{'01':['oversized','host']}});
  ok(await run(f));const calls=rows(f),supervisors=calls.filter(call=>call.role==='supervisor'),subtasks=calls.filter(call=>call.role==='subtask');
  assert.equal(supervisors.length,2);assert.notEqual(supervisors[0].threadId,supervisors[1].threadId);
  assert.equal(supervisors[1].args.includes('resume'),false);assert.ok(supervisors[1].at-supervisors[0].at>=60);
  assert.equal(subtasks[1].subtaskId,'02');assert.equal(subtasks[1].threadId,subtasks[2].threadId);
  const r=state(f).steps['01'].recovery;assert.equal(r.subdivision.rotation_count,1);
  assert.equal(r.subdivision.rotations[0].role,'supervisor');assert.equal(r.return_actor,'finalizer');
  assert.equal(r.repair_count,1);assert.equal(state(f).steps['01'].rate_limit_count,3);preserve(f);
});

test('request_too_large supervisor rotation budget stays exhausted across restart',async t=>{
  const f=fixture(t,{subtask:['checkpoint','blocked','checkpoint'],supervisor:{'01':['oversized']}});
  const args=['--step','01','--max-session-rotations','1'];const result=await run(f,args);
  assert.equal(result.status,75);assert.match(result.stdout+'\n'+result.stderr,/rotation budget exhausted/);
  const before=state(f).steps['01'],calls=rows(f).length;
  assert.equal(before.recovery.subdivision.rotation_count,1);assert.equal(before.recovery.return_actor,'subtask');
  assert.equal(rows(f).filter(call=>call.role==='supervisor').length,2);assert.equal(rows(f).some(call=>call.role==='finalizer'),false);
  assert.equal((await run(f,args)).status,75);assert.equal(rows(f).length,calls);
  assert.equal(state(f).steps['01'].rate_limit_count,before.rate_limit_count);
  assert.deepEqual(state(f).steps['01'].recovery.subdivision.tasks,before.recovery.subdivision.tasks);preserve(f);
});


test('no-recovery cannot bypass pending host evidence after finalizer interruption',async t=>{
  const f=fixture(t,{taskCount:6,subtask:['blocked','checkpoint'],supervisor:{'01':['host']},finalizer:['hang','completed']});
  const running=start(f);const hanging=await waitFor(()=>{const file=path.join(f.root,'fake-hanging.json');return fs.existsSync(file)&&JSON.parse(fs.readFileSync(file))}, { runner: running, timeoutMs: 18000 });
  assert.equal(hanging.role,'finalizer');running.child.kill('SIGTERM');assert.equal((await running.done).status,143);
  const before=structuredClone(state(f).steps['01']),count=rows(f).length;
  assert.ok(before.recovery.pending_evidence.file);assert.equal(before.recovery.host_evidence_deferred,false);
  const result=await run(f,['--step','01','--no-recovery']);assert.notEqual(result.status,0);
  assert.match(result.stdout+'\n'+result.stderr,/Subdivision recovery is disabled/);
  assert.equal(rows(f).length,count);assert.notEqual(state(f).steps['01'].status,'completed');
  assert.deepEqual(state(f).steps['01'].recovery.pending_evidence,before.recovery.pending_evidence);
  ok(await run(f,['--step','01','--fresh-session']));assert.equal(state(f).steps['01'].status,'completed');
  assert.equal(state(f).steps['01'].recovery.evidence_refresh_count,before.recovery.evidence_refresh_count);preserve(f);
});


for (const role of ['planner', 'subtask']) test(`corrected ${role} protocol resumes the same session without a source-repair cycle`, async t => {
  const f = fixture(t, { [role]: ['extra-provider', role === 'planner' ? 'plan' : 'checkpoint'] });
  ok(await run(f));
  const calls = rows(f), actorCalls = calls.filter(call => call.role === role);
  assert.equal(actorCalls[0].threadId, actorCalls[1].threadId);
  assert.equal(actorCalls[1].args.includes('resume'), true);
  assert.match(actorCalls[1].prompt, /PROTOCOL_CORRECTION_REQUIRED/);
  assert.equal(calls.some(call => call.role === 'supervisor'), false);
  const entry = state(f).steps['01'];
  assert.equal(entry.status, 'completed'); assert.equal(entry.recovery.protocol_retry_count, 1);
  assert.equal(entry.recovery.repair_count, 0);
  const rejected = entry.recovery.history.filter(item => item.action === 'protocol-rejected');
  assert.equal(rejected.length, 1); assert.equal(rejected[0].actor, role);
  assert.equal(fs.existsSync(path.join(f.root, 'forbidden-planner-command')), false);
  preserve(f);
});
