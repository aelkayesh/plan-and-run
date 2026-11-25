import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';


// Verbatim historical payload; claims in its summary are fixture data, not current acceptance.
const capturedSupervisorDecision = {
  "schema_version": 1,
  "package_id": "01",
  "attempt_id": "15254b06-f4fd-4bfb-93bb-fa856ecb9377",
  "classification": "external",
  "action": "resume",
  "recipe_id": null,
  "summary": "Previous ownership and validation blockers are resolved. Verified all 81 current candidate source identities, parent-local-validation results (392/392 Site; 385/385 portable/generator; metadata passed), audit and independent review hashes. Protected files, retained artifacts and prior worker records remain unchanged. Resume saved worker 01a1d9d0-16f0-7ae1-bb5f-63004ec9c248 for its acceptance assessment and completion records. This supervisor made no corrections and did not complete the package.",
  "changed_files": [],
  "blockers": []
};

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));

// A separate executable models the CLI wire protocol. It never imports Codex,
// contacts a model, or accesses any original application data.
const fakeCodex = String.raw`#!/usr/bin/env node
if (process.argv.includes('login') && process.argv.includes('status')) { console.log('Logged in using ChatGPT'); process.exit(0); }
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => { prompt += part; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const argument = name => args[args.indexOf(name) + 1];
  const schema = JSON.parse(fs.readFileSync(argument('--output-schema'), 'utf8'));
  const role = schema.properties.classification ? 'supervisor' : 'worker';
  const config = JSON.parse(fs.readFileSync('fake-config.json', 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(config.manifest, 'utf8'));
  const packageId = prompt.match(/^PACKAGE_ID: (\d{2})$/m)?.[1];
  const attemptId = prompt.match(/^ATTEMPT_ID: ([^\s]+)$/m)?.[1];
  if (!packageId || !attemptId) throw new Error('Missing package/attempt identity');
  const step = manifest.steps.find(item => item.id === packageId);
  const oldCalls = fs.existsSync('fake-calls.jsonl') ? fs.readFileSync('fake-calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const ordinal = oldCalls.filter(call => call.role === role && call.packageId === packageId).length;
  const choices = config[role]?.[packageId] || [role === 'worker' ? 'completed' : 'resume'];
  const action = choices[Math.min(ordinal, choices.length - 1)];
  const threadId = args.includes('resume') ? args.at(-2) : '00000000-0000-4000-8000-' + String(oldCalls.length + 1).padStart(12, '0');
  const call = { role, action, args, prompt, packageId, attemptId, threadId, pid: process.pid, schema, at: Date.now(), resultFile: argument('--output-last-message') };
  fs.appendFileSync('fake-calls.jsonl', JSON.stringify(call) + '\n');
  const event = value => process.stdout.write(JSON.stringify(value) + '\n');
  event({type:'thread.started',thread_id:threadId});
  // Wait until the parent has journaled this conversation before modeling tools.
  const stateFile = '.codex-plan-runner/' + manifest.plan_id + '/state.json';
  const savedDeadline = Date.now() + 2000;
  while (Date.now() < savedDeadline) {
    if (fs.existsSync(stateFile) && fs.readFileSync(stateFile,'utf8').includes(threadId)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
  }
  const emit = value => {
    fs.writeFileSync(call.resultFile, JSON.stringify(value));
    event({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
  };
  const repair = () => {
    if (fs.readFileSync('lib/dependency.mjs', 'utf8').includes('BROKEN')) {
      fs.writeFileSync('lib/dependency.mjs', 'export const state = "REPAIRED";\n');
      fs.appendFileSync('fake-effects.jsonl', JSON.stringify({role, action, packageId}) + '\n');
    }
  };
  const tamper = target => {
    if (target === 'plan') fs.appendFileSync(manifest.source, '\nForbidden mutation\n');
    if (target === 'policy') { manifest.recovery.packages[packageId].recipes = []; fs.writeFileSync(config.manifest, JSON.stringify(manifest)); }
    if (target === 'recipe') { const packageFile = JSON.parse(fs.readFileSync('package.json','utf8')); packageFile.scripts.test = 'touch forbidden-host-command'; fs.writeFileSync('package.json',JSON.stringify(packageFile)); }
    if (target === 'current-receipt') { fs.appendFileSync(step.validation,'\nUnauthorized supervisor receipt change'); fs.appendFileSync(step.handoff,'\nUnauthorized supervisor handoff change'); }
    if (target === 'dependencies') { fs.mkdirSync('node_modules/forbidden-install',{recursive:true}); fs.writeFileSync('node_modules/forbidden-install/index.js','module.exports = 1;'); }
    if (target === 'runtime') fs.appendFileSync('codex-plan-runner/protocol.mjs', '\n// Forbidden mutation\n');
    if (target === 'accepted') fs.appendFileSync(manifest.steps[0].handoff, '\nForbidden accepted record mutation\n');
    if (target === 'state') {
      const file = '.codex-plan-runner/' + manifest.plan_id + '/state.json';
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.revision = (state.revision || 0) + 900;
      state.untrusted_change = true;
      fs.writeFileSync(file, JSON.stringify(state));
    }
  };
  if (action === 'missing-output') {
    fs.rmSync(call.resultFile, {force:true});
    event({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
    return;
  }
  if (action === 'malformed-json') {
    fs.writeFileSync(call.resultFile, '{ invalid JSON');
    event({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
    return;
  }
  if (action === 'contradictory-completion') {
    emit({schema_version:1,package_id:packageId,attempt_id:attemptId,status:'completed',summary:'Required SQL gate is missing.',validation_file:step.validation,handoff_file:step.handoff,blockers:['SQL evidence still missing.']});
    return;
  }
  if (action === 'hang' || action === 'repair-hang') {
    if (action === 'repair-hang') repair();
    fs.writeFileSync('fake-hanging.json', JSON.stringify(call));
    setInterval(() => {}, 1000);
    return;
  }
  if (['transport', 'transport-after', 'rate', 'missing-session', 'authentication'].includes(action)) {
    const message = action.startsWith('transport') ? 'stream disconnected: Transport error: network error'
      : action === 'rate' ? 'Token rate limit exceeded'
      : action === 'missing-session' ? 'Session not found: the saved conversation is unavailable'
      : 'Invalid API key; authentication failed';
    event({type:'turn.failed',error:{message,...(action === 'rate' ? {code:'rate_limit_exceeded',retry_after_ms:60} : action === 'transport-after' ? {retry_after_ms:120000} : {})}});
    process.exitCode = 1;
    return;
  }
  if (action.startsWith('blocked-plus-')) {
    const kind = action.slice('blocked-plus-'.length);
    fs.writeFileSync(call.resultFile, JSON.stringify({schema_version:1,package_id:packageId,attempt_id:attemptId,status:'blocked',summary:'Source work needs recovery.',validation_file:step.validation,handoff_file:step.handoff,blockers:['Try the recovery supervisor.']}));
    const message = kind === 'authentication' ? 'Invalid API key; authentication failed'
      : kind === 'quota' ? 'insufficient_quota: billing hard limit reached'
      : 'invalid configuration: unsupported model';
    event({type:'turn.failed',error:{message}});
    process.exitCode = 1;
    return;
  }
  if (role === 'supervisor') {
    const decision = {schema_version:1,package_id:packageId,attempt_id:attemptId,
      classification:action === 'repair' ? 'dependency' : 'implementation',action:'resume',recipe_id:null,
      summary:'Inspected partial effects; resume the same package.',changed_files:[],blockers:[]};
    if (action === 'captured-external-resume') {
      emit({...config.supervisorReplay,package_id:packageId,attempt_id:attemptId});
      return;
    }
    if (action === 'repair') { repair(); decision.changed_files = ['lib/dependency.mjs']; }
    if (action === 'external') {
      Object.assign(decision,{classification:'external',action:'blocked',summary:'An unavailable external approval is required.',blockers:['Obtain the named external approval before retrying.']});
    }
    if (action === 'service-unavailable') {
      if (!prompt.includes('Host checks failed:')) throw new Error('Expected preserved failed host evidence before reporting the unavailable service');
      Object.assign(decision,{classification:'external',action:'blocked',summary:'The approved synthetic fixture service is unavailable.',blockers:['Restore the approved synthetic fixture service, then start --step 01 --fresh-session.']});
    }
    if (action === 'host' || action === 'unknown-recipe' || action === 'command-injection') {
      Object.assign(decision,{classification:'environment',action:'host-check',recipe_id:action === 'unknown-recipe' ? 'unreviewed-shell' : 'npm-checks'});
      if (action === 'command-injection') decision.command = 'touch forbidden-host-command';
    }
    if (action === 'host-with-blockers') {
      Object.assign(decision,{classification:'environment',action:'host-check',recipe_id:'npm-checks',blockers:['Required SQL acceptance remains unresolved.']});
    }
    if (action.startsWith('tamper-')) tamper(action.slice('tamper-'.length));
    emit(decision);
    return;
  }
  const hostFile = prompt.match(/^HOST_VALIDATION_FILE: (.+)$/m)?.[1];
  const hostSha = prompt.match(/^HOST_VALIDATION_SHA256: (.+)$/m)?.[1];
  if (action === 'stale-host') fs.appendFileSync('lib/dependency.mjs', '// legitimate next correction\n');
  if (action === 'corrupt-host-evidence' || action === 'corrupt-host-log') {
    if (!hostFile) throw new Error('Expected verified host evidence before corruption');
    const evidence = JSON.parse(fs.readFileSync(hostFile,'utf8'));
    fs.appendFileSync(action === 'corrupt-host-evidence' ? hostFile : evidence.checks[0].log_file, '\nForbidden evidence mutation\n');
  }
  if (action === 'blocked' || action === 'environment' || action === 'stale-host' || action.startsWith('corrupt-host-') || (action === 'require-repair' && fs.readFileSync('lib/dependency.mjs','utf8').includes('BROKEN'))) {
    emit({schema_version:1,package_id:packageId,attempt_id:attemptId,status:'blocked',summary:action === 'environment' ? 'listen EPERM: local check denied by sandbox' : 'A source dependency needs in-scope correction.',validation_file:step.validation,handoff_file:step.handoff,blockers:['Inspect the diagnostic and existing partial effects.']});
    return;
  }
  if (action.startsWith('tamper-')) tamper(action.slice('tamper-'.length));
  const git = (...argv) => execFileSync('git', argv, {encoding:'utf8'}).trim();
  execFileSync(process.execPath,['--check','lib/dependency.mjs']);
  const receipt = {schema_version:1,package_id:packageId,attempt_id:attemptId,status:'completed',
    source:{head:git('rev-parse','HEAD'),branch:git('branch','--show-current'),dirty:true},changed_files:[step.validation,step.handoff],
    checks:[{command:'node --check lib/dependency.mjs',exit_code:0,passed:true}],
    fixtures:[{id:'recovery-integration',kind:'synthetic',location:'fake-config.json'}],blockers:[]};
  if (hostFile && action !== 'omit-host') {
    const evidence = JSON.parse(fs.readFileSync(hostFile,'utf8'));
    receipt.host_validation = {file:hostFile,sha256:hostSha};
    receipt.checks = evidence.checks.map(check=>({command:check.command,exit_code:check.exit_code,passed:check.passed,origin:'host-validation'}));
  }
  fs.mkdirSync(path.dirname(step.validation),{recursive:true});
  fs.mkdirSync(path.dirname(step.handoff),{recursive:true});
  fs.writeFileSync(step.validation,JSON.stringify(receipt,null,2)+'\n');
  fs.writeFileSync(step.handoff,'# Synthetic package '+packageId+'\nActual syntax check passed; any dependency correction belongs to this package.\n');
  emit({schema_version:1,package_id:packageId,attempt_id:attemptId,status:'completed',summary:'Synthetic package verified.',validation_file:step.validation,handoff_file:step.handoff,blockers:[]});
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
function fixture(t, { worker = {}, supervisor = {}, supervisorReplay = null, recipes = ['npm-checks'], policy = true, host = {}, ids = ['01','02','03','15'] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'runner recovery integration-')));
  const runners = new Set();
  const write = (relative, content) => { fs.mkdirSync(path.dirname(path.join(root,relative)),{recursive:true}); fs.writeFileSync(path.join(root,relative),content); };
  // Each test owns its runtime copy, permitting real runtime-tamper tests without
  // modifying another test, the implementation checkout, or its active runner.
  fs.cpSync(runtimeDirectory,path.join(root,'codex-plan-runner'),{recursive:true,filter:file=>!file.endsWith('.test.mjs')});
  write('run.mjs',"import { main } from './codex-plan-runner/runner.mjs';\nmain().then(code=>{process.exitCode=code}).catch(error=>{console.error(error.message);process.exitCode=1});\n");
  const manifestPath = 'plan/manifest.json', policyPath = 'plan/recovery-policy.json';
  const manifest = {schema_version:1,plan_id:'synthetic-recovery',source:'plan/source.md',contract:'plan/contract.md',worker_contract:'plan/worker-contract.md',ready:true,steps:ids.map((id,index)=>({id,title:'Synthetic '+id,plan:'plan/'+id+'.md',validation:'receipts/'+id+'.json',handoff:'handoffs/'+id+'.md',dependencies:index?[ids[index-1]]:[],manual:id==='15'}))};
  if (policy) manifest.recovery = {schema_version:1,packages:Object.fromEntries(ids.filter(id=>id!=='15').map(id=>[id,{local_repair:true,recipes}]))};
  write(manifestPath,JSON.stringify(manifest,null,2));
  for (const file of [manifest.source,manifest.contract,manifest.worker_contract,...manifest.steps.map(step=>step.plan)]) write(file,'Synthetic authorized local implementation with immutable acceptance.\n');
  write('AGENTS.md','Only synthetic fixtures; keep unrelated work and accepted artifacts.\n');
  write('.gitignore','.codex-plan-runner/\nfake-calls.jsonl\nfake-host-calls.jsonl\nfake-effects.jsonl\nfake-hanging.json\nfake-host-hanging.json\nnode_modules/\n');
  write('package.json',JSON.stringify({private:true,scripts:{test:'node --check lib/dependency.mjs',check:'node --check lib/dependency.mjs'}}));
  write('lib/dependency.mjs','export const state = "BROKEN";\n');
  write('unrelated.txt','User original content.\n');
  write('fake-config.json',JSON.stringify({manifest:manifestPath,policy:policyPath,worker,supervisor,supervisorReplay,host}));
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
function start(f, options=['--step','01'], command='start', delays=['--retry-delay-seconds','0.02','--max-delay-seconds','0.04']) {
  const child=spawn(process.execPath,[path.join(f.root,'run.mjs'),command,'--repo',f.root,'--manifest',f.manifestPath,'--codex-bin',path.join(f.root,'fake-codex.mjs'),
    '--progress-seconds','0','--timeout-minutes','0',...delays,...options],
  // Only this disposable fake parent is unmarked; production child guards stay active.
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
  assert.equal(call.args[call.args.indexOf('--sandbox')+1],'workspace-write');
  assert.equal(call.args[call.args.indexOf('-c')+1],'approval_policy="never"');
  assert.equal(call.args.includes('--dangerously-bypass-approvals-and-sandbox'),false);
  assert.equal(call.schema.additionalProperties,false);
}
async function waitFor(predicate) {const deadline=Date.now()+10000;while(Date.now()<deadline){const found=predicate();if(found)return found;await new Promise(resolve=>setTimeout(resolve,15));}assert.fail('Timed out waiting for durable recovery phase');}

test('package05 transcript corrects contradictory host decision then refreshes repaired source without replaying predecessors', async t => {
  const f=fixture(t,{ids:['01','02','03','04','05','15'],worker:{'05':['environment','stale-host','completed']},supervisor:{'05':['host-with-blockers','host','host']}});
  ok(await run(f,['--from','01','--to','04']));
  const accepted=structuredClone(state(f).steps);
  ok(await run(f,['--step','05']));
  const calls=rows(f).filter(call=>call.packageId==='05');
  assert.deepEqual(calls.map(call=>call.action),['environment','host-with-blockers','host','stale-host','host','completed']);
  assert.equal(calls[1].threadId,calls[2].threadId);
  assert.match(calls[2].prompt,/PROTOCOL_CORRECTION_REQUIRED/);
  assert.match(calls[2].prompt,/host-check contradicts unresolved blockers/);
  assert.equal(calls[0].threadId,calls[3].threadId);
  assert.equal(calls[0].threadId,calls[5].threadId);
  const recovery=state(f).steps['05'].recovery;
  assert.equal(recovery.protocol_retry_count,1);
  assert.equal(recovery.repair_count,2);
  assert.equal(recovery.evidence_refresh_count,1);
  assert.equal(recovery.decisions.length,2,'rejected decision never becomes executable authority');
  assert.equal(rows(f,'fake-host-calls.jsonl').length,4,'one initial npm/check gate and exactly one source refresh');
  for(const id of ['01','02','03','04']) assert.deepEqual(state(f).steps[id],accepted[id]);
  assert.equal(rows(f).filter(call=>call.packageId!=='05').length,4);
  assert.equal(state(f).steps['15'],undefined);
  const rejected=recovery.history.find(item=>item.action==='protocol-rejected');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,rejected.file),'utf8')).blockers.length,1);
  preserve(f);
});

test('malformed worker and supervisor output use separate durable protocol retries in their original sessions', async t => {
  const f=fixture(t,{worker:{'01':['malformed-json','environment','completed']},supervisor:{'01':['malformed-json','host']}});
  ok(await run(f));
  const calls=rows(f), workers=calls.filter(call=>call.role==='worker'), supervisors=calls.filter(call=>call.role==='supervisor');
  assert.equal(workers.length,3); assert.equal(supervisors.length,2);
  assert.ok(workers.every(call=>call.threadId===workers[0].threadId));
  assert.equal(supervisors[0].threadId,supervisors[1].threadId);
  assert.match(workers[1].prompt,/PROTOCOL_CORRECTION_REQUIRED/);
  assert.match(supervisors[1].prompt,/PROTOCOL_CORRECTION_REQUIRED/);
  assert.equal(state(f).steps['01'].recovery.protocol_retry_count,2);
  assert.equal(state(f).steps['01'].recovery.repair_count,1);
  assert.equal(rows(f,'fake-host-calls.jsonl').length,2);
  preserve(f);
});

test('protocol exhaustion survives restart and a larger budget preserves session, history and real external blockers', async t => {
  const f=fixture(t,{worker:{'01':['environment']},supervisor:{'01':['malformed-json','malformed-json','malformed-json','external']}});
  const first=await run(f);assert.notEqual(first.status,0);
  assert.equal(state(f).steps['01'].recovery.protocol_retry_count,2);
  assert.equal(rows(f).filter(call=>call.role==='supervisor').length,3);
  const count=rows(f).length;
  assert.notEqual((await run(f)).status,0);assert.equal(rows(f).length,count);
  assert.equal(rows(f,'fake-host-calls.jsonl').length,0);
  const larger=await run(f,['--step','01','--max-protocol-retries','3']);assert.notEqual(larger.status,0);
  const calls=rows(f).filter(call=>call.role==='supervisor');
  assert.equal(calls.length,4);assert.ok(calls.every(call=>call.threadId===calls[0].threadId));
  assert.equal(state(f).steps['01'].recovery.protocol_retry_count,3);
  assert.match(state(f).steps['01'].recovery.terminal_blocker,/external approval/);
  assert.equal(state(f).steps['01'].recovery.repair_count,1);
  assert.equal(rows(f,'fake-host-calls.jsonl').length,0);
  preserve(f);
});


test('recovered protocol failure is historical in read-only status while the report stays unchanged', async t => {
  const f=fixture(t,{worker:{'01':['environment','completed']},supervisor:{'01':['malformed-json','malformed-json','malformed-json','host']}});
  assert.notEqual((await run(f)).status,0);
  const report=path.join(f.stateDir,'needs-attention.json');
  const reportBytes=fs.readFileSync(report);
  ok(await run(f,['--step','01','--max-protocol-retries','3']));
  assert.equal(state(f).steps['01'].status,'completed');
  const stateBytes=fs.readFileSync(f.stateFile), count=rows(f).length;
  const result=await run(f,[],'status');ok(result);
  assert.match(result.stdout,/Historical needs-attention report \(not current package status\)/);
  assert.doesNotMatch(result.stdout,/Current needs-attention report:/);
  assert.deepEqual(fs.readFileSync(report),reportBytes);
  assert.deepEqual(fs.readFileSync(f.stateFile),stateBytes);
  assert.equal(rows(f).length,count);
  preserve(f);
});

// Core contract: a different supervisor conversation may correct an ordinary
// dependency defect, but only the original worker can finish the package.
test('automatic supervisor repairs a blocker and resumes the original worker session',async t=>{
  const f=fixture(t,{worker:{'01':['require-repair','require-repair']},supervisor:{'01':['repair']}});
  ok(await run(f));
  const calls=rows(f);assert.deepEqual(calls.map(call=>call.role),['worker','supervisor','worker']);
  assert.equal(calls[0].threadId,calls[2].threadId);assert.notEqual(calls[0].threadId,calls[1].threadId);
  assert.equal(calls[2].args.includes('resume'),true);assert.equal(calls[1].args.includes('resume'),false);
  calls.forEach(assertIsolation);assert.equal(state(f).steps['01'].status,'completed');
  assert.equal(rows(f,'fake-effects.jsonl').length,1);preserve(f);
});

test('compound prerequisite source correction and automatic host checks preserve accepted predecessor artifacts',async t=>{
  const f=fixture(t,{worker:{'02':['require-repair','environment','completed']},supervisor:{'02':['repair','host']}});
  ok(await run(f,['--step','01']));
  const accepted=state(f).steps['01'];
  const originals=[f.manifest.steps[0].validation,f.manifest.steps[0].handoff,accepted.last_attempt.result_file].map(file=>[file,fs.readFileSync(path.resolve(f.root,file))]);
  ok(await run(f,['--step','02']));
  for(const [file,content] of originals)assert.deepEqual(fs.readFileSync(path.resolve(f.root,file)),content);
  assert.deepEqual(state(f).steps['01'],accepted);
  assert.equal(rows(f).filter(call=>call.packageId==='01').length,1);
  assert.deepEqual(rows(f).filter(call=>call.packageId==='02').map(call=>call.role),['worker','supervisor','worker','supervisor','worker']);
  assert.equal(rows(f,'fake-host-calls.jsonl').length,2);
  const receipt=JSON.parse(fs.readFileSync(path.join(f.root,f.manifest.steps[1].validation),'utf8'));
  assert.ok(receipt.host_validation);assert.ok(receipt.checks.every(check=>check.origin==='host-validation'));
  preserve(f);
});

test('sandbox-restricted local checks automatically collect isolated host evidence and require explicit attribution',async t=>{
  const f=fixture(t,{worker:{'01':['environment','completed']},supervisor:{'01':['host']}});
  ok(await run(f));
  const host=rows(f,'fake-host-calls.jsonl');assert.deepEqual(host.map(call=>call.args),[['test'],['run','check']]);
  assert.ok(host.every(call=>call.key===undefined&&call.database===undefined));
  assert.equal(host[0].data,host[1].data);assert.equal(fs.existsSync(host[0].data),false);
  const workers=rows(f).filter(call=>call.role==='worker');assert.equal(workers[0].threadId,workers[1].threadId);
  assert.match(workers[1].prompt,/HOST_VALIDATION_SHA256:/);preserve(f);
});

for (const limit of [0, 1]) test(`same-recipe host requests cannot bypass evidence refresh limit ${limit} across restart or explicit increase`, async t => {
  const f = fixture(t, {
    worker: { '01': ['environment', ...Array(limit + 1).fill('stale-host'), 'completed'] },
    supervisor: { '01': ['host'] }
  });
  const options = ['--step', '01', '--max-evidence-refreshes', String(limit)];
  const first = await run(f, options);
  assert.equal(first.status, 75, first.stdout + '\n' + first.stderr);
  const before = state(f).steps['01'];
  const calls = rows(f), hostCalls = rows(f, 'fake-host-calls.jsonl');
  assert.equal(calls.filter(call => call.role === 'worker').length, limit + 2);
  assert.equal(calls.filter(call => call.role === 'supervisor').length, limit + 2);
  assert.equal(hostCalls.length, 2 * (limit + 1), 'only the initial host recipe and the permitted refreshes may execute');
  assert.equal(before.recovery.evidence_refresh_count, limit);
  assert.equal(before.recovery.phase, 'needs-attention');
  assert.equal(before.recovery.budget_kind, 'evidence');
  assert.match(before.recovery.budget_reason, /Host evidence refresh budget exhausted/);
  assert.ok(before.recovery.pending_evidence.file, 'the previous stale evidence must remain available for inspection');
  assert.equal(before.recovery.decisions.at(-1).action, 'host-check');
  const evidenceFiles = calls.filter(call => call.role === 'worker').slice(1)
    .map(call => call.prompt.match(/^HOST_VALIDATION_FILE: (.+)$/m)?.[1]);
  assert.ok(evidenceFiles.every(Boolean));
  assert.equal(new Set(evidenceFiles).size, limit + 1);
  const evidenceBytes = evidenceFiles.map(file => [file, fs.readFileSync(path.join(f.root, file))]);

  const restarted = await run(f, options);
  assert.equal(restarted.status, 75, restarted.stdout + '\n' + restarted.stderr);
  assert.deepEqual(rows(f), calls, 'restart cannot repeat the worker or completed supervisor');
  assert.deepEqual(rows(f, 'fake-host-calls.jsonl'), hostCalls, 'restart cannot collect evidence beyond the saved budget');
  const paused = state(f).steps['01'];
  assert.equal(paused.attempts, before.attempts);
  assert.equal(paused.recovery.repair_count, before.recovery.repair_count);
  assert.equal(paused.recovery.evidence_refresh_count, limit);
  assert.deepEqual(paused.recovery.pending_evidence, before.recovery.pending_evidence);
  assert.deepEqual(paused.recovery.decisions, before.recovery.decisions);

  ok(await run(f, ['--step', '01', '--max-evidence-refreshes', String(limit + 1)]));
  const completed = state(f).steps['01'], resumedCalls = rows(f);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.recovery.evidence_refresh_count, limit + 1);
  assert.equal(completed.recovery.history.filter(item => item.action === 'stale-evidence').length, limit + 1);
  assert.equal(rows(f, 'fake-host-calls.jsonl').length, hostCalls.length + 2);
  assert.equal(resumedCalls.length, calls.length + 1, 'an explicit budget increase must resume only the original worker');
  assert.equal(resumedCalls.at(-1).role, 'worker');
  assert.equal(resumedCalls.at(-1).args.includes('resume'), true);
  assert.ok(resumedCalls.filter(call => call.role === 'worker').every(call => call.threadId === calls[0].threadId));
  assert.deepEqual(completed.recovery.decisions, before.recovery.decisions, 'the completed supervisor request must not replay');
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, f.manifest.steps[0].validation), 'utf8'));
  assert.notEqual(receipt.host_validation.file, before.recovery.pending_evidence.file);
  for (const [file, bytes] of evidenceBytes) assert.deepEqual(fs.readFileSync(path.join(f.root, file)), bytes);
  preserve(f);
});

test('a repeated same-recipe request reuses valid prior evidence with zero refresh budget and no extra host work', async t => {
  const f = fixture(t, { worker: { '01': ['environment', 'blocked', 'completed'] }, supervisor: { '01': ['host'] } });
  ok(await run(f, ['--step', '01', '--max-evidence-refreshes', '0']));
  const calls = rows(f), workers = calls.filter(call => call.role === 'worker');
  assert.deepEqual(calls.map(call => call.role), ['worker', 'supervisor', 'worker', 'supervisor', 'worker']);
  assert.equal(rows(f, 'fake-host-calls.jsonl').length, 2);
  const identities = workers.slice(1).map(call => [
    call.prompt.match(/^HOST_VALIDATION_FILE: (.+)$/m)?.[1],
    call.prompt.match(/^HOST_VALIDATION_SHA256: (.+)$/m)?.[1]
  ]);
  assert.ok(identities[0].every(Boolean));
  assert.deepEqual(identities[0], identities[1]);
  assert.ok(workers.every(call => call.threadId === workers[0].threadId));
  assert.equal(state(f).steps['01'].recovery.evidence_refresh_count, 0);
  assert.equal(state(f).steps['01'].recovery.history.filter(item => item.action === 'stale-evidence').length, 0);
  preserve(f);
});

for (const target of ['evidence', 'log']) test(`a repeated same-recipe request cannot refresh corrupt prior host ${target} into success`, async t => {
  const f = fixture(t, { worker: { '01': ['environment', 'corrupt-host-' + target, 'completed'] }, supervisor: { '01': ['host'] } });
  const result = await run(f);
  assert.equal(result.status, 1, result.stdout + '\n' + result.stderr);
  assert.deepEqual(rows(f).map(call => call.role), ['worker', 'supervisor', 'worker', 'supervisor']);
  assert.equal(rows(f, 'fake-host-calls.jsonl').length, 2, 'integrity failure cannot trigger replacement host evidence');
  const recovery = state(f).steps['01'].recovery;
  assert.equal(recovery.evidence_refresh_count, 0);
  assert.equal(recovery.history.filter(item => item.action === 'stale-evidence').length, 0);
  assert.notEqual(state(f).steps['01'].status, 'completed');
  const report = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'needs-attention.json'), 'utf8'));
  assert.match(report.reason, target === 'evidence' ? /evidence changed before retry/ : /check log changed/);
  const evidenceFile = path.join(f.root, recovery.pending_evidence.file);
  const evidence = target === 'log' ? JSON.parse(fs.readFileSync(evidenceFile, 'utf8')) : null;
  assert.match(fs.readFileSync(target === 'evidence' ? evidenceFile : path.join(f.root, evidence.checks[0].log_file), 'utf8'), /Forbidden evidence mutation/);
  preserve(f);
});

test('synthetic unavailable host service produces actionable terminal needs-attention and preserves failed evidence', async t => {
  const f = fixture(t, { worker: { '01': ['environment', 'completed'] }, supervisor: { '01': ['host', 'service-unavailable'] }, host: { unavailable: true } });
  const result = await run(f, []);
  assert.equal(result.status, 2, result.stdout + '\n' + result.stderr);
  assert.deepEqual(rows(f).map(call => call.role), ['worker', 'supervisor', 'supervisor']);
  const hostCalls = rows(f, 'fake-host-calls.jsonl');
  assert.equal(hostCalls.length, 2);
  assert.ok(hostCalls.every(call => !fs.existsSync(call.data)), 'the failed synthetic service checks still clean their fixture');
  const entry = state(f).steps['01'];
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.recovery.phase, 'needs-attention');
  assert.equal(state(f).steps['02'], undefined);
  assert.match(entry.recovery.terminal_blocker, /Restore the approved synthetic fixture service/);
  const report = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'needs-attention.json'), 'utf8'));
  assert.match(report.reason, /Restore the approved synthetic fixture service/);
  assert.match(report.next_action, /--step 01 --fresh-session/);
  const failure = entry.recovery.history.find(item => item.action === 'host-failure');
  assert.ok(failure?.evidence);
  const evidence = JSON.parse(fs.readFileSync(path.join(f.root, failure.evidence), 'utf8'));
  assert.equal(evidence.passed, false);
  assert.equal(evidence.automatic.cleanup_verified, true);
  assert.ok(evidence.checks.every(check => check.exit_code === 1 && check.passed === false));
  for (const check of evidence.checks) assert.match(fs.readFileSync(path.join(f.root, check.log_file), 'utf8'), /ECONNREFUSED synthetic:\/\/approved-fixture-service/);
  const calls = rows(f);
  assert.equal((await run(f, [])).status, 2);
  assert.deepEqual(rows(f), calls);
  assert.deepEqual(rows(f, 'fake-host-calls.jsonl'), hostCalls);
  preserve(f);
});

test('a genuine external blocker produces durable needs-attention without starting another package',async t=>{
  const f=fixture(t,{worker:{'01':['blocked']},supervisor:{'01':['external']}});
  const result=await run(f,[]);assert.equal(result.status,2,result.stdout+'\n'+result.stderr);
  assert.deepEqual(rows(f).map(call=>call.role),['worker','supervisor']);
  assert.equal(state(f).steps['01'].status,'blocked');assert.equal(state(f).steps['02'],undefined);
  assert.match(JSON.stringify(state(f)),/external approval/i);assert.match(result.stdout,/attention|blocked/i);preserve(f);
});

for(const action of ['unknown-recipe','command-injection'])test(`${action} supervisor output cannot execute an unreviewed host command`,async t=>{
  const f=fixture(t,{worker:{'01':['environment']},supervisor:{'01':[action]}});
  const result=await run(f);assert.notEqual(result.status,0);
  assert.equal(rows(f,'fake-host-calls.jsonl').length,0);assert.equal(fs.existsSync(path.join(f.root,'forbidden-host-command')),false);
  assert.notEqual(state(f).steps['01'].status,'completed');preserve(f);
});

test('repeated unchanged failure exhausts a durable recovery budget and start does not reset it',async t=>{
  const f=fixture(t,{worker:{'01':['blocked']},supervisor:{'01':['resume']}});
  const first=await run(f);assert.notEqual(first.status,0);
  const count=rows(f).length;assert.ok(count<=7,'repair must be bounded');
  const before=JSON.stringify(state(f).steps['01']);
  const second=await run(f);assert.notEqual(second.status,0);assert.equal(rows(f).length,count);
  assert.match(before,/budget|progress|exhaust/i);preserve(f);
});

test('interruption during supervisor repair resumes its recorded conversation and never repeats a completed source effect',async t=>{
  const f=fixture(t,{worker:{'01':['require-repair','require-repair']},supervisor:{'01':['repair-hang','resume']}});
  const first=start(f);const hanging=await waitFor(()=>{const file=path.join(f.root,'fake-hanging.json');return fs.existsSync(file)&&JSON.parse(fs.readFileSync(file,'utf8'))});
  assert.equal(hanging.role,'supervisor');
  await waitFor(()=>JSON.stringify(state(f)).includes(hanging.threadId));
  first.child.kill('SIGTERM');const stopped=await first.done;assert.equal(stopped.status,143,stopped.stderr);
  ok(await run(f));
  assert.equal(rows(f,'fake-effects.jsonl').length,1);
  const supervisors=rows(f).filter(call=>call.role==='supervisor');assert.equal(supervisors.length,2);assert.equal(supervisors[0].threadId,supervisors[1].threadId);
  assert.equal(supervisors[1].args.includes('resume'),true);assert.equal(state(f).steps['01'].status,'completed');preserve(f);
});

for(const target of ['plan','policy','runtime','state','dependencies','recipe'])test(`worker ${target} tampering is detected before completion or recovery`,async t=>{
  const f=fixture(t,{worker:{'01':['tamper-'+target]}});
  const result=await run(f);assert.notEqual(result.status,0);
  assert.equal(rows(f).length,1);assert.notEqual(state(f).steps['01'].status,'completed');preserve(f);
});
for(const target of ['plan','policy','runtime','state','accepted','dependencies','recipe'])test(`supervisor ${target} tampering cannot become a repair or schedule another worker`,async t=>{
  const packageId=target==='accepted'?'02':'01';
  const f=fixture(t,{worker:{[packageId]:['blocked']},supervisor:{[packageId]:['tamper-'+target]}});
  if(packageId==='02')ok(await run(f,['--step','01']));
  const result=await run(f,['--step',packageId]);assert.notEqual(result.status,0);
  assert.deepEqual(rows(f).filter(call=>call.packageId===packageId).map(call=>call.role),['worker','supervisor']);
  assert.notEqual(state(f).steps[packageId].status,'completed');preserve(f);
});

test('transport retries use the same worker conversation without invoking recovery supervisor',async t=>{
  const f=fixture(t,{worker:{'01':['transport','completed']}});ok(await run(f));
  const calls=rows(f);assert.deepEqual(calls.map(call=>call.role),['worker','worker']);assert.equal(calls[0].threadId,calls[1].threadId);preserve(f);
});
for (const action of ['transport', 'transport-after']) test(`transport backoff stores a short worker delay and preserves provider minimum: ${action}`, async t => {
  const f = fixture(t, { worker: { '01': [action] } });
  // Exhaust immediately so the real CLI records its default delay without a timed wait.
  const result = await start(f, ['--step', '01', '--max-transport-retries', '0'], 'start', []).done;
  assert.equal(result.timedOut, false, result.stdout + result.stderr);
  assert.equal(result.status, 75, result.stdout + result.stderr);
  const entry = state(f).steps['01'], delay = Date.parse(entry.retry_at) - Date.parse(entry.last_attempt.finished_at);
  assert.equal(entry.recovery.transport_count, 1);
  assert.equal(entry.rate_limit_count, 0);
  assert.equal(entry.recovery.repair_count, 0);
  assert.equal(rows(f).length, 1);
  if (action === 'transport-after') assert.ok(delay >= 120000 && delay < 125000, `Provider minimum was shortened: ${delay}`);
  else assert.ok(delay >= 10000 && delay < 15000, `Expected a 10-second transport base plus jitter: ${delay}`);
  preserve(f);
});

test('authentication failure is a genuine stop and cannot be routed through source repair',async t=>{
  const f=fixture(t,{worker:{'01':['authentication','completed']}});const result=await run(f);assert.notEqual(result.status,0);assert.equal(rows(f).length,1);preserve(f);
});
for(const kind of ['authentication','quota','configuration'])test(`matching blocked prose cannot override a permanent ${kind} provider failure`,async t=>{
  const f=fixture(t,{worker:{'01':['blocked-plus-'+kind,'completed']},supervisor:{'01':['host']}});
  const result=await run(f);assert.notEqual(result.status,0);
  assert.equal(rows(f).length,1);assert.equal(state(f).steps['01'].recovery.repair_count,0);
  assert.match(state(f).steps['01'].recovery.terminal_blocker,new RegExp('Provider '+kind));
  assert.equal(fs.existsSync(path.join(f.root,'fake-host-calls.jsonl')),false);preserve(f);
});
test('recovery respects a selected package and the package 15 manual boundary',async t=>{
  const f=fixture(t,{worker:{'01':['require-repair','completed']},supervisor:{'01':['repair']}});
  ok(await run(f));assert.ok(rows(f).every(call=>call.packageId==='01'));assert.equal(state(f).steps['02'],undefined);
  const blocked=await run(f,['--step','15']);assert.equal(blocked.status,2);assert.ok(rows(f).every(call=>call.packageId==='01'));preserve(f);
});
test('generic plans without host selection retain automatic sandbox repairs but cannot run host recipes',async t=>{
  const f=fixture(t,{policy:false,worker:{'01':['require-repair','completed']},supervisor:{'01':['repair']}});
  ok(await run(f));assert.equal(rows(f,'fake-host-calls.jsonl').length,0);preserve(f);
});

test('an unavailable saved session gets only one fresh replacement and retains partial source work',async t=>{
  const f=fixture(t,{worker:{'01':['transport','missing-session','completed']}});
  ok(await run(f));
  const calls=rows(f);assert.equal(calls.length,3);assert.equal(calls[0].threadId,calls[1].threadId);assert.notEqual(calls[1].threadId,calls[2].threadId);
  assert.equal(calls[2].args.includes('resume'),false);assert.equal(state(f).steps['01'].recovery.session_replacement_count,1);
  assert.match(calls[2].prompt,/partial|preserv/i);preserve(f);
});

test('repeated missing sessions stop after the single persisted replacement even after restart',async t=>{
  const f=fixture(t,{worker:{'01':['transport','missing-session','missing-session']}});
  const first=await run(f);assert.notEqual(first.status,0);
  assert.equal(state(f).steps['01'].recovery.session_replacement_count,1);
  const count=rows(f).length;assert.ok(count<=3);
  const again=await run(f);assert.notEqual(again.status,0);assert.equal(rows(f).length,count);preserve(f);
});

test('explicit transport retry exhaustion persists across start invocations',async t=>{
  const f=fixture(t,{worker:{'01':['transport']}});
  const first=await run(f,['--step','01','--max-transport-retries','1']);assert.notEqual(first.status,0);
  const count=rows(f).length;assert.equal(count,2);
  const second=await run(f,['--step','01','--max-transport-retries','1']);assert.notEqual(second.status,0);assert.equal(rows(f).length,count);
  assert.ok(state(f).steps['01'].recovery.transport_count>=1);preserve(f);
});

test('finite provider rate retry budget and provider-aware cooldown persist across invocations',async t=>{
  const f=fixture(t,{worker:{'01':['rate']}});
  const first=await run(f,['--step','01','--max-rate-retries','1']);assert.equal(first.status,75,first.stderr);
  const calls=rows(f);assert.equal(calls.length,2);assert.ok(calls[1].at-calls[0].at>=60);
  const second=await run(f,['--step','01','--max-rate-retries','1']);assert.equal(second.status,75,second.stderr);assert.equal(rows(f).length,2);preserve(f);
});

test('explicit repair budget and recovery-disable options preserve the unfinished package',async t=>{
  const f=fixture(t,{worker:{'01':['blocked']},supervisor:{'01':['resume']}});
  const disabled=await run(f,['--step','01','--no-recovery']);assert.equal(disabled.status,2);assert.equal(rows(f).length,1);
  const bounded=await run(f,['--step','01','--max-repair-retries','1']);assert.notEqual(bounded.status,0);
  assert.equal(rows(f).filter(call=>call.role==='supervisor').length,1);
  const count=rows(f).length;const restarted=await run(f,['--step','01','--max-repair-retries','1']);assert.notEqual(restarted.status,0);assert.equal(rows(f).length,count);preserve(f);
});

test('successful host checks cannot replace missing worker host attribution',async t=>{
  const f=fixture(t,{worker:{'01':['environment','omit-host']},supervisor:{'01':['host','external']}});
  const result=await run(f);assert.notEqual(result.status,0);assert.notEqual(state(f).steps['01'].status,'completed');
  assert.equal(rows(f,'fake-host-calls.jsonl').length,2);assert.equal(state(f).steps['02'],undefined);preserve(f);
});

test('read-only status exposes phase and next action without resetting exhausted counters',async t=>{
  const f=fixture(t,{worker:{'01':['blocked']},supervisor:{'01':['resume']}});
  assert.notEqual((await run(f)).status,0);const before=fs.readFileSync(f.stateFile);const calls=rows(f).length;
  const status=await run(f,[], 'status');ok(status);assert.match(status.stdout,/phase|needs-attention/i);assert.match(status.stdout,/next|action/i);
  assert.deepEqual(fs.readFileSync(f.stateFile),before);assert.equal(rows(f).length,calls);preserve(f);
});

test('corrupt migrated state fails closed before any new worker or supervisor',async t=>{
  const f=fixture(t);ok(await run(f));const before=rows(f).length;
  const original=state(f);original.steps['01'].recovery.repair_count=-4;fs.writeFileSync(f.stateFile,JSON.stringify(original));
  const result=await run(f,[]);assert.notEqual(result.status,0);assert.equal(rows(f).length,before);preserve(f);
});

test('SIGTERM during automatic host checks cleans its owned fixture and resumes host recovery before the same worker',async t=>{
  const f=fixture(t,{worker:{'01':['environment','completed']},supervisor:{'01':['host']},host:{hang:'once'}});
  const first=start(f);const hanging=await waitFor(()=>{const file=path.join(f.root,'fake-host-hanging.json');return fs.existsSync(file)&&JSON.parse(fs.readFileSync(file,'utf8'))});
  await waitFor(()=>state(f)?.steps['01']?.recovery?.pending_evidence?.journal_file);
  first.child.kill('SIGTERM');const stopped=await first.done;assert.equal(stopped.status,143,stopped.stdout+'\n'+stopped.stderr);
  assert.equal(fs.existsSync(hanging.data),false);
  assert.throws(()=>process.kill(hanging.pid,0),error=>error.code==='ESRCH');
  const pending=state(f).steps['01'].recovery.pending_evidence;assert.ok(pending.journal_file);
  ok(await run(f));
  const calls=rows(f);assert.deepEqual(calls.map(call=>call.role),['worker','supervisor','worker']);
  assert.equal(calls[0].threadId,calls[2].threadId);assert.equal(rows(f,'fake-host-calls.jsonl').length,3);preserve(f);
});

test('host timeout is a recorded failure with bounded recovery, not an operator interruption that resets on restart',async t=>{
  const f=fixture(t,{worker:{'01':['environment']},supervisor:{'01':['host']},host:{hang:'always'}});
  const args=['--step','01','--host-timeout-minutes','0.01'];
  const first=await run(f,args);assert.notEqual(first.status,0);assert.notEqual(first.status,130);assert.notEqual(first.status,143);
  const count=rows(f,'fake-host-calls.jsonl').length;assert.ok(count<=3,'host timeout recovery must be bounded');
  const again=await run(f,args);assert.notEqual(again.status,0);assert.equal(rows(f,'fake-host-calls.jsonl').length,count);preserve(f);
});

for(const corruption of ['pending-recipe','decision-artifact'])test(`restart rejects ${corruption} corruption before replaying a recorded host action`,async t=>{
  const f=fixture(t,{worker:{'01':['environment','completed']},supervisor:{'01':['host']},host:{hang:'once'}});
  const running=start(f);await waitFor(()=>fs.existsSync(path.join(f.root,'fake-host-hanging.json')));
  await waitFor(()=>state(f)?.steps['01']?.recovery?.pending_evidence?.journal_file);
  running.child.kill('SIGTERM');assert.equal((await running.done).status,143);
  const saved=state(f);const recovery=saved.steps['01'].recovery;
  if(corruption==='pending-recipe') { recovery.pending_evidence.recipe_id='unreviewed-shell';fs.writeFileSync(f.stateFile,JSON.stringify(saved)); }
  else { const decision=path.join(f.root,recovery.decisions[0].file);fs.appendFileSync(decision,'\n'); }
  const calls=rows(f).length,hostCalls=rows(f,'fake-host-calls.jsonl').length;
  const result=await run(f);assert.notEqual(result.status,0);assert.equal(rows(f).length,calls);assert.equal(rows(f,'fake-host-calls.jsonl').length,hostCalls);preserve(f);
});

test('completed automatic host checks are reused after worker interruption without repeating host side effects',async t=>{
  const f=fixture(t,{worker:{'01':['environment','hang','completed']},supervisor:{'01':['host']}});
  const first=start(f);const hanging=await waitFor(()=>{const file=path.join(f.root,'fake-hanging.json');return fs.existsSync(file)&&JSON.parse(fs.readFileSync(file,'utf8'))});
  assert.equal(hanging.role,'worker');await waitFor(()=>state(f)?.steps['01']?.recovery?.pending_evidence?.file);
  const before=state(f).steps['01'].recovery.pending_evidence;const evidence=fs.readFileSync(path.join(f.root,before.file));
  first.child.kill('SIGTERM');assert.equal((await first.done).status,143);
  ok(await run(f));assert.equal(rows(f,'fake-host-calls.jsonl').length,2);
  assert.deepEqual(fs.readFileSync(path.join(f.root,before.file)),evidence);
  assert.equal(rows(f).filter(call=>call.role==='supervisor').length,1);preserve(f);
});

test('a hard parent crash during host validation reconciles the exact owned helper and restarts with a fresh fixture',async t=>{
  const f=fixture(t,{worker:{'01':['environment','completed']},supervisor:{'01':['host']},host:{hang:'once'}});
  const first=start(f);const hanging=await waitFor(()=>{const file=path.join(f.root,'fake-host-hanging.json');return fs.existsSync(file)&&JSON.parse(fs.readFileSync(file,'utf8'))});
  const pending=await waitFor(()=>state(f)?.steps['01']?.recovery?.pending_evidence?.journal_file&&state(f).steps['01'].recovery.pending_evidence);
  first.child.kill('SIGKILL');const crashed=await first.done;assert.equal(crashed.signal,'SIGKILL');
  // The durable journal is used for cleanup even if the test's restart fails.
  try {
    ok(await run(f));
    assert.equal(fs.existsSync(hanging.data),false);assert.throws(()=>process.kill(hanging.pid,0),error=>error.code==='ESRCH');
    assert.equal(rows(f,'fake-host-calls.jsonl').length,3);
    const calls=rows(f);assert.deepEqual(calls.map(call=>call.role),['worker','supervisor','worker']);assert.equal(calls[0].threadId,calls[2].threadId);preserve(f);
  } finally {
    const module=await import(pathToFileURL(path.join(f.root,'codex-plan-runner/automatic-host-validation.mjs')).href);
    await module.reconcileAutomaticHostValidation({root:f.root,journalFile:path.join(f.root,pending.journal_file)});
  }
});

test('a supervisor cannot rewrite the current worker receipt or handoff while repairing source',async t=>{
  const f=fixture(t,{worker:{'01':['blocked']},supervisor:{'01':['tamper-current-receipt']}});
  for(const file of [f.manifest.steps[0].validation,f.manifest.steps[0].handoff]) {
    fs.mkdirSync(path.dirname(path.join(f.root,file)),{recursive:true});fs.writeFileSync(path.join(f.root,file),'Unfinished worker record preserved for inspection.\n');
  }
  const result=await run(f);assert.notEqual(result.status,0);
  assert.deepEqual(rows(f).map(call=>call.role),['worker','supervisor']);assert.notEqual(state(f).steps['01'].status,'completed');preserve(f);
});

test('restart reconciles a saved successful worker completion before replaying any completed effects',async t=>{
  const f=fixture(t);ok(await run(f));const saved=state(f),entry=saved.steps['01'];
  assert.equal(entry.last_attempt.exit_code,0);assert.equal(entry.last_attempt.turn_completed,true);
  // Reproduce the durable window between recording a worker exit and accepting
  // its artifacts; the original success output/receipt/check all remain real.
  entry.status='running';delete entry.artifacts;delete entry.completed_at;
  entry.recovery.phase='worker';entry.recovery.next_action='await-worker';
  fs.writeFileSync(f.stateFile,JSON.stringify(saved));
  const restarted=await run(f);ok(restarted);assert.match(restarted.stdout,/reconciling saved completed worker/i);
  assert.equal(rows(f).length,1);assert.equal(state(f).steps['01'].attempts,1);assert.equal(state(f).steps['01'].status,'completed');preserve(f);
});

test('intervening source changes invalidate a saved successful worker outcome and require same-session revalidation', async t => {
  const f = fixture(t); ok(await run(f)); const saved = state(f), entry = saved.steps['01'];
  assert.ok(entry.last_attempt.outcome?.source_sha256);
  entry.status = 'running'; delete entry.artifacts; delete entry.completed_at;
  entry.recovery.phase = 'worker'; entry.recovery.next_action = 'await-worker';
  fs.writeFileSync(f.stateFile, JSON.stringify(saved));
  fs.appendFileSync(path.join(f.root, 'lib/dependency.mjs'), '\n// Legitimate intervening source correction.\n');
  ok(await run(f)); const calls = rows(f);
  assert.equal(calls.length, 2); assert.equal(calls[0].threadId, calls[1].threadId);
  assert.match(calls[1].prompt, /became stale|intervening source/);
  assert.equal(state(f).steps['01'].status, 'completed'); preserve(f);
});

test('corrupt legacy rate counters cannot reset or bypass retry budgets', async t => {
  const f = fixture(t); ok(await run(f)); const saved = state(f);
  saved.steps['01'].rate_limit_count = 'not-an-integer';
  fs.writeFileSync(f.stateFile, JSON.stringify(saved));
  const before = fs.readFileSync(f.stateFile); const result = await run(f);
  assert.notEqual(result.status, 0); assert.equal(rows(f).length, 1);
  assert.deepEqual(fs.readFileSync(f.stateFile), before); preserve(f);
});


test('missing worker and supervisor output files receive durable same-session protocol correction', async t => {
  const f=fixture(t,{worker:{'01':['missing-output','environment','completed']},supervisor:{'01':['missing-output','host']}});
  ok(await run(f));
  const calls=rows(f), workers=calls.filter(call=>call.role==='worker'), supervisors=calls.filter(call=>call.role==='supervisor');
  assert.equal(workers.length,3);assert.equal(supervisors.length,2);
  assert.equal(workers[0].threadId,workers[1].threadId);assert.equal(supervisors[0].threadId,supervisors[1].threadId);
  assert.match(workers[1].prompt,/PROTOCOL_CORRECTION_REQUIRED/);assert.match(supervisors[1].prompt,/PROTOCOL_CORRECTION_REQUIRED/);
  const recovery=state(f).steps['01'].recovery;
  assert.equal(recovery.protocol_retry_count,2);assert.equal(recovery.repair_count,1);
  for(const rejection of recovery.history.filter(item=>item.action==='protocol-rejected')) {
    const observation=JSON.parse(fs.readFileSync(path.join(f.root,rejection.file),'utf8'));
    assert.equal(observation.kind,'missing-protocol-output');assert.equal(fs.existsSync(path.join(f.root,observation.expected_file)),false);
  }
  assert.equal(rows(f,'fake-host-calls.jsonl').length,2);preserve(f);
});

test('captured external-resume supervisor output is corrected in one launch without another repair cycle', async t => {
  const f=fixture(t,{worker:{'01':['blocked','completed']},supervisor:{'01':['captured-external-resume','resume']}, supervisorReplay:capturedSupervisorDecision});
  ok(await run(f));
  const calls=rows(f), workers=calls.filter(call=>call.role==='worker'), supervisors=calls.filter(call=>call.role==='supervisor');
  assert.deepEqual(calls.map(call=>call.action),['blocked','captured-external-resume','resume','completed']);
  assert.equal(supervisors.length,2);
  assert.equal(supervisors[0].threadId,supervisors[1].threadId);
  assert.equal(supervisors[1].args.includes('resume'),true);
  assert.equal(workers[0].threadId,workers[1].threadId);
  assert.match(supervisors[1].prompt,/PROTOCOL_CORRECTION_REQUIRED/);
  assert.match(supervisors[1].prompt,/external classification cannot execute recovery/);
  const entry=state(f).steps['01'], recovery=entry.recovery;
  assert.equal(entry.status,'completed');
  assert.equal(recovery.protocol_retry_count,1);
  assert.equal(recovery.repair_count,1,'Protocol correction stays within the original source-repair cycle');
  assert.equal(recovery.transport_count,0);
  assert.equal(recovery.evidence_refresh_count,0);
  assert.equal(recovery.decisions.length,1);
  assert.equal(recovery.decisions[0].classification,'implementation');
  assert.equal(recovery.decisions[0].action,'resume');
  const rejected=recovery.history.filter(item=>item.action==='protocol-rejected');
  assert.equal(rejected.length,1);
  const rejectedBytes=fs.readFileSync(path.join(f.root,rejected[0].file));
  // Replay exact semantic payload; only the assigned wire identity changes per run.
  assert.deepEqual(JSON.parse(rejectedBytes),{...capturedSupervisorDecision,package_id:supervisors[0].packageId,attempt_id:supervisors[0].attemptId});
  assert.equal(rejected[0].sha256,createHash('sha256').update(rejectedBytes).digest('hex'));
  assert.equal(rows(f,'fake-host-calls.jsonl').length,0);
  assert.equal(rows(f,'fake-effects.jsonl').length,0);
  assert.equal(state(f).steps['02'],undefined);
  assert.equal(state(f).steps['15'],undefined);
  calls.forEach(assertIsolation);
  preserve(f);
});
