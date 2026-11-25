import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const runtime = path.dirname(fileURLToPath(import.meta.url));
// Real CLI, state guards, protocol, recovery and acceptance lifecycle. Only
// provider transport and fixed capability execution are synthetic adapters.
const adapter = String.raw`
import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {snapshotSource} from './host-validation.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
export function preflightAcceptanceCapabilities(){return {passed:true};}
export function acceptanceExecutionContext(){return {synthetic:true};}
export async function reconcileAcceptanceGate({root,journalFile}){fs.appendFileSync(path.join(root,'.codex-plan-runner/reconciled.jsonl'),JSON.stringify({journalFile})+'\n');return {cleanup_verified:true,journalFile};}
export function verifyAcceptanceEvidenceArtifacts({root,file}){const e=JSON.parse(fs.readFileSync(file));for(const a of e.artifacts||[])if(hash(fs.readFileSync(path.join(root,a.file)))!==a.sha256)throw Error('evidence artifact changed');return e;}
export async function runAcceptanceGate({root,gate,mapping,outputDir,mutablePaths,packageId,planHash,onJournal,journalFile:resumeJournalFile,signal}){
 if(resumeJournalFile&&fs.existsSync(resumeJournalFile)){const prior=JSON.parse(fs.readFileSync(resumeJournalFile));if(prior.evidence_file){const evidence=JSON.parse(fs.readFileSync(prior.evidence_file));return {file:prior.evidence_file,evidence,journalFile:resumeJournalFile,summary:evidence.passed?'passed':'denied-write-rollback failed'};}}
 fs.mkdirSync(outputDir,{recursive:true});const id=randomUUID(),source=snapshotSource(root,mutablePaths),journalFile=path.join(outputDir,'acceptance-'+id+'-journal.json');
 const journal={schema_version:1,kind:'acceptance-gate-journal',id,root,package_id:packageId,plan_hash:planHash,gate,source,phase:'interrupted',process:null,cleanup_verified:true,data_directory:path.join(outputDir,'data-'+id)};
 fs.writeFileSync(journalFile,JSON.stringify(journal));await onJournal({journalFile});
 const countFile=path.join(root,'.codex-plan-runner/gate-calls.jsonl');fs.appendFileSync(countFile,JSON.stringify({gate:gate.id,capability:gate.capability,packageId})+'\n');
 const config=JSON.parse(fs.readFileSync(path.join(root,'fixture-config.json'))),calls=fs.readFileSync(countFile,'utf8').trim().split('\n').map(JSON.parse).filter(c=>c.gate===gate.id).length;
 if(gate.id==='sql'&&calls<=(config.timeoutAttempts||0))return {file:null,evidence:null,journalFile,timedOut:true,cleanup_verified:config.unknownCleanup!==true};
 const broken=fs.readFileSync(path.join(root,'lib/feature.mjs'),'utf8').includes('BROKEN');
 const nestedFile=path.join(outputDir,'assertions.json');fs.writeFileSync(nestedFile,JSON.stringify(mapping.cases));
 const e={schema_version:1,kind:'codex-plan-acceptance-gate',id,root,package_id:packageId,plan_hash:planHash,gate,cleanup_verified:true,passed:!(broken&&gate.id==='sql'),mapping,cases:mapping.cases,artifacts:[{file:path.relative(root,nestedFile),sha256:hash(fs.readFileSync(nestedFile))}],source,failure_ids:broken&&gate.id==='sql'?['sql:denied-write-rollback']:[]};
 const file=path.join(outputDir,'evidence.json');fs.writeFileSync(file,JSON.stringify(e));journal.evidence_file=file;journal.phase='completed';fs.writeFileSync(journalFile,JSON.stringify(journal));
 if(config.hangGate===gate.id&&calls===1){fs.writeFileSync(path.join(root,'.codex-plan-runner/gate-hanging.json'),JSON.stringify({gate:gate.id,journalFile}));if(!signal?.aborted){const keepAlive=setInterval(()=>{},1000);try{await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}finally{clearInterval(keepAlive);}}}
 return {file,evidence:e,journalFile,summary:e.passed?'passed':'denied-write-rollback failed'};
}
export function verifyAcceptanceGate({root,file,mapping,mutablePaths,checkSource=true}){const e=JSON.parse(fs.readFileSync(file));if(JSON.stringify(e.mapping)!==JSON.stringify(mapping))throw Error('mapping/capability mismatch');if(checkSource&&e.source.sha256!==snapshotSource(root,mutablePaths).sha256)throw Error('source snapshot is stale');return {file,evidence:e,summary:e.passed?'passed':'denied-write-rollback failed'};}
`;
const worker = String.raw`#!/usr/bin/env node
if(process.argv.includes('login')&&process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {snapshotSource} from './runtime/host-validation.mjs';
let prompt='';process.stdin.on('data',v=>prompt+=v);process.stdin.on('end',()=>{
 const marker=n=>prompt.match(new RegExp('^'+n+': (.+)$','m'))?.[1],args=process.argv.slice(2),out=args[args.indexOf('--output-last-message')+1],id=marker('PACKAGE_ID'),attempt=marker('ATTEMPT_ID');
 const role=process.env.CODEX_PLAN_ROLE,config=JSON.parse(fs.readFileSync('fixture-config.json')),manifest=JSON.parse(fs.readFileSync('plan/manifest.json')),step=manifest.steps.find(s=>s.id===id);
 const callsFile='.codex-plan-runner/calls.jsonl',prior=fs.existsSync(callsFile)?fs.readFileSync(callsFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[],same=prior.filter(c=>c.role===role);
 const thread=args.includes('resume')?args.at(-2):'10000000-0000-4000-8000-'+String(prior.length+1).padStart(12,'0');
 fs.appendFileSync(callsFile,JSON.stringify({role,id,attempt,thread,args,prompt,at:Date.now()})+'\n');console.log(JSON.stringify({type:'thread.started',thread_id:thread}));
 const emit=v=>{fs.writeFileSync(out,JSON.stringify(v));console.log(JSON.stringify({type:'turn.completed'}));};
 const hang=kind=>{fs.writeFileSync('.codex-plan-runner/hanging.json',JSON.stringify({kind,role,thread}));setInterval(()=>{},1000);};
 if(role==='acceptance-reviewer'){
  const stage=marker('STAGE'),stages=same.filter(c=>c.prompt.includes('STAGE: '+stage));
  if(config.hangReview===stage&&!stages.length||config.hangRefreshReview===stage&&stages.length===1){hang('review-'+stage);return;}
  if(config.providerFailure&&stage==='evidence'&&stages.length<(config.providerFailures||1)){
   console.log(JSON.stringify({type:'turn.failed',error:{message:config.providerFailure==='authentication'?'Invalid API key':'Provider rate limit exceeded',retry_after_ms:20}}));process.exitCode=1;return;
  }
  const packet=JSON.parse(fs.readFileSync(prompt.match(/parent evidence packet (\S+)\./)[1]));
  emit({schema_version:1,package_id:id,attempt_id:attempt,stage,binding_sha256:marker('BINDING_SHA256'),verdict:config.rejectReview?'rejected':'accepted',criteria:packet.criteria.map(c=>({id:c.id,satisfied:!config.rejectReview,reason:config.rejectReview?'Synthetic assertion does not cover requirement':'Inspected synthetic assertions and bound evidence.'})),blockers:[]});return;
 }
 if(config.subdivision){
  const subdivision=marker('SUBDIVISION_ID');
  if(role==='worker'){console.log(JSON.stringify({type:'turn.failed',error:{message:'Request too large for tokens per minute (TPM): Limit 1000, Requested 2000.',code:'request_too_large',retry_after_ms:20}}));process.exitCode=1;return;}
  if(role==='planner'){const directory=marker('ARTIFACT_DIRECTORY');emit({schema_version:1,package_id:id,attempt_id:attempt,subdivision_id:subdivision,status:'planned',summary:'Two bounded prerequisite checks; original acceptance remains required.',source_sha256:marker('SOURCE_SHA256'),subtasks:['01','02'].map(task=>({id:task,title:'Check prerequisite '+task,instructions:'Syntax-check only lib/checkpoint-'+task+'.mjs.',checks:['node --check lib/checkpoint-'+task+'.mjs'],checkpoint_file:directory+'/task-'+task+'.json'})),blockers:[]});return;}
  if(role==='subtask'){
   const task=marker('SUBTASK_ID'),file=marker('CHECKPOINT_FILE'),changed='lib/checkpoint-'+task+'.mjs';fs.writeFileSync(changed,'export const prerequisite = '+Number(task)+';\n');execFileSync(process.execPath,['--check',changed]);
   const checkpoint={schema_version:1,package_id:id,attempt_id:attempt,subdivision_id:subdivision,subtask_id:task,summary:'Syntax-checked assigned prerequisite.',source_sha256:snapshotSource(process.cwd(),[step.validation,step.handoff,path.join(path.dirname(step.plan),'README.md')]).sha256,changed_files:[changed],checks:[{command:'node --check '+changed,exit_code:0,passed:true}],blockers:[],next_steps:['Require original strict acceptance.']};
   fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(checkpoint));const result={...checkpoint,status:'checkpointed',checkpoint_file:file,checkpoint_sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')};delete result.next_steps;emit(result);return;
  }
 }
 if(role==='supervisor'){
  const repair=config.broken&&!config.noRepair,classification=config.supervisorClassification||'environment',action=config.supervisorAction||'acceptance-check';
  if(repair)fs.writeFileSync('lib/feature.mjs','export const state = "REPAIRED";\n');
  const result={schema_version:1,package_id:id,attempt_id:attempt,classification,action,recipe_id:config.supervisorRecipe||null,summary:repair?'Repaired rollback; request configured parent acceptance.':'Parent-owned sandbox gates are deferred; request configured acceptance.',changed_files:repair?['lib/feature.mjs']:[],blockers:config.supervisorBlockers||[]};
  if(config.supervisorExtra)result.command='touch forbidden-command';emit(result);return;
 }
 const mapping={schema_version:1,package_id:id,gates:[{gate_id:'npm',files:['tests/feature.test.ts'],cases:['npm-test','npm-check','scoped read']},{gate_id:'sql',files:['tests/acceptance/'+id+'/feature.postgres.test.ts'],cases:['denied write rolls back']},{gate_id:'build',files:[],cases:['production-build']},{gate_id:'browser',files:['tests/acceptance/'+id+'/feature.browser.mjs'],cases:['admin page accessible']}],criteria:[{criterion_id:'read',gate_id:'npm',test_ids:['scoped read']},{criterion_id:'write',gate_id:'sql',test_ids:['denied write rolls back']},{criterion_id:'build',gate_id:'build',test_ids:['production-build']},{criterion_id:'ui',gate_id:'browser',test_ids:['admin page accessible']}]};
 if(!config.omitMapping&&!fs.existsSync('plan/'+id+'-acceptance-mapping.json'))fs.writeFileSync('plan/'+id+'-acceptance-mapping.json',JSON.stringify(mapping));
 const state=JSON.parse(fs.readFileSync('.codex-plan-runner/'+manifest.plan_id+'/state.json')),entry=state.steps[id];
 const accepted=Boolean(entry.acceptance?.accepted_source_sha256);
 const first=same.length===0;
 if(config.missingFinalSession&&accepted&&args.includes('resume')&&!fs.existsSync('.codex-plan-runner/missing-session-once')){
  fs.writeFileSync('.codex-plan-runner/missing-session-once','1');console.log(JSON.stringify({type:'turn.failed',error:{message:'Saved session not found'}}));process.exitCode=1;return;
 }
 if((config.hangFinalization&&accepted&&!prior.some(c=>c.role===role&&c.prompt.includes('SYNTHETIC_HANG_CONSUMED')))&&!fs.existsSync('.codex-plan-runner/finalization-hung')){
  fs.writeFileSync('.codex-plan-runner/finalization-hung','1');hang('finalization');return;
 }
 const base={schema_version:1,package_id:id,attempt_id:attempt,status:'acceptance-ready',summary:'Implementation and mapping ready; configured parent gates await execution.',validation_file:step.validation,handoff_file:step.handoff,blockers:[]};
 if(config.workerExtra)base.command='touch forbidden-command';
 if(config.workerBlockers)base.blockers=config.workerBlockers;
 if((config.initialBlocked&&first)||config.alwaysBlocked){emit({...base,status:'blocked',summary:'SQL and loopback checks cannot run in this sandbox.',blockers:['Configured parent SQL and browser gates remain deferred.']});return;}
 if(config.alwaysReady||(!accepted&&!config.legacyComplete)){emit(base);return;}
 if(config.driftFinalization&&!fs.existsSync('.codex-plan-runner/drifted')){fs.appendFileSync('lib/feature.mjs','// repaired during finalization\n');fs.writeFileSync('.codex-plan-runner/drifted','1');}
 if(config.omitFinalReceipt){emit({...base,status:'completed',summary:'No receipt intentionally supplied.'});return;}
 execFileSync(process.execPath,['--check','lib/feature.mjs']);const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 fs.mkdirSync(path.dirname(step.validation),{recursive:true});fs.writeFileSync(step.validation,JSON.stringify({schema_version:1,package_id:id,attempt_id:attempt,status:'completed',source:{head,branch:'fixture',dirty:true},changed_files:[],checks:[{command:'node --check lib/feature.mjs',exit_code:0,passed:true}],fixtures:[],blockers:[]}));fs.writeFileSync(step.handoff,'Synthetic source syntax check passed; parent retains separate acceptance evidence.');
 emit({...base,status:'completed',summary:'Current receipt finalized after parent acceptance evidence.'});
});
`;

function fixture(t, config = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-handoff-')));
  const children = new Map();
  t.after(async () => {
    for (const [child, done] of children) {
      child.kill('SIGTERM');
      let timer;
      try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned fake runner cleanup remains unresolved; fixture retained: ' + root)), 15000); })]); }
      finally { clearTimeout(timer); }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (file, value) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), value); };
  fs.cpSync(runtime, path.join(root, 'runtime'), { recursive: true, filter: file => !file.endsWith('.test.mjs') && !/\/\d{2}-evidence(?:\/|$)/.test(file) });
  write('runtime/acceptance-adapters.mjs', adapter);
  write('run.mjs', "import {main} from './runtime/runner.mjs';main().then(code=>process.exitCode=code).catch(e=>{console.error(e.stack);process.exitCode=1;});");
  write('fake-codex.mjs', worker); fs.chmodSync(path.join(root, 'fake-codex.mjs'), 0o755);
  write('fixture-config.json', JSON.stringify(config)); write('.gitignore', '.codex-plan-runner/\nnode_modules/\n');
  write('lib/feature.mjs', `export const state = "${config.broken ? 'BROKEN' : 'GOOD'}";\n`);
  write('tests/feature.test.ts', 'assert.equal(authorizedRead(), true);\n');
  for (const id of ['01', '02']) {
    write(`tests/acceptance/${id}/feature.postgres.test.ts`, 'assert.equal(deniedWriteChanges(), 0);\n');
    write(`tests/acceptance/${id}/feature.browser.mjs`, 'assert.equal(adminPage.accessible, true);\n');
  }
  const pkg = { required_gates: [{ id: 'npm', capability: 'npm-checks' }, { id: 'sql', capability: 'synthetic-postgres' }, { id: 'build', capability: 'production-build' }, { id: 'browser', capability: 'loopback-browser' }], criteria: [{ id: 'read', type: 'security', purpose: 'Read uses scoped policy', gate_ids: ['npm'] }, { id: 'write', type: 'persistence', purpose: 'Denied writes roll back', gate_ids: ['sql'] }, { id: 'build', type: 'build', purpose: 'Production build succeeds', gate_ids: ['build'] }, { id: 'ui', type: 'ui', purpose: 'Administration page is accessible', gate_ids: ['browser'] }] };
  const manifest = { schema_version: 1, plan_id: 'acceptance-handoff', ready: true, source: 'plan/source.md', contract: 'plan/contract.md', worker_contract: 'plan/worker.md', recovery: { schema_version: 1, packages: Object.fromEntries(['01', '02'].map(id => [id, { local_repair: config.localRepair !== false, recipes: [] }])) }, steps: ['01', '02'].map((id, i) => ({ id, title: `Synthetic ${id}`, manual: config.manual === true && id === '01', dependencies: i ? ['01'] : [], plan: `plan/${id}-plan.md`, validation: `receipts/${id}.json`, handoff: `receipts/${id}.md` })) };
  if (!config.legacy) manifest.acceptance = { schema_version: 1, mode: 'strict', packages: config.noProfile ? { '02': pkg } : { '01': pkg, '02': pkg } };
  if (config.manual) { delete manifest.acceptance; delete manifest.recovery.packages['01']; }
  write('plan/manifest.json', JSON.stringify(manifest));
  write('plan/recovery-policy.json', JSON.stringify({ ...manifest.recovery, plan_id: manifest.plan_id }));
  for (const file of [manifest.source, manifest.contract, manifest.worker_contract, ...manifest.steps.map(s => s.plan)]) write(file, 'Required scoped reads, rollback, production build and accessible administration UI.');
  for (const args of [['init', '-q'], ['config', 'user.name', 'Synthetic'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic baseline']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  const argv = (extra = []) => [path.join(root, 'run.mjs'), 'start', '--repo', root, '--manifest', 'plan/manifest.json', ...(fs.existsSync(path.join(runtime, 'site-recovery-policy.v1.json')) ? ['--recovery-policy', 'plan/recovery-policy.json'] : []), '--codex-bin', path.join(root, 'fake-codex.mjs'), '--step', '01', '--progress-seconds', '0', '--max-no-progress', '2', ...extra];
  const env = { ...process.env, CODEX_HOME: path.join(root, 'fake-auth'), CODEX_PLAN_WORKER: '', CODEX_RECOVERY_SUPERVISOR: '' };
  const run = (...extra) => spawnSync(process.execPath, argv(extra), { cwd: root, env, encoding: 'utf8', timeout: 90000 });
  const start = (...extra) => {
    const child = spawn(process.execPath, argv(extra), { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const done = new Promise(resolve => child.on('close', status => { children.delete(child); resolve({ status, stdout, stderr }); }));
    children.set(child, done);
    return { child, done };
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(root, '.codex-plan-runner/acceptance-handoff/state.json')));
  const rows = file => { const f = path.join(root, '.codex-plan-runner', file); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; };
  return { root, write, run, start, state, calls: () => rows('calls.jsonl'), gates: () => rows('gate-calls.jsonl') };
}
const ok = result => assert.equal(result.status, 0, result.stdout + result.stderr);
const entry = f => f.state().steps['01'];
const workers = f => f.calls().filter(c => c.role === 'worker' || c.role === 'finalizer');
async function waitFor(f, predicate) {
  const until = Date.now() + 20000;
  while (Date.now() < until) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Timed out waiting for fake child; calls: ' + JSON.stringify(f.calls().map(c => [c.role, c.attempt])));
}


// Exercise the real strict runner/lifecycle with synthetic fixed adapters only.
// The interrupted journal owns finished evidence whose state pointer is not yet saved.
const hash = value => createHash('sha256').update(value).digest('hex');
async function interruptAfterEvidence(t, gate='sql') {
 const f=fixture(t,{hangGate:gate,localRepair:false}),running=f.start('--no-recovery');
 t.after(()=>{if(running.child.exitCode===null)running.child.kill('SIGTERM');});
 await waitFor(f,()=>fs.existsSync(path.join(f.root,'.codex-plan-runner/gate-hanging.json')));
 running.child.kill('SIGTERM');assert.equal((await running.done).status,143);
 const record=entry(f).acceptance.gates[gate];assert.ok(record.journal_file);assert.equal(record.file,undefined);
 const journal=JSON.parse(fs.readFileSync(path.join(f.root,record.journal_file))),file=journal.evidence_file,evidence=JSON.parse(fs.readFileSync(file));
 return {f,gate,file,evidence,sha256:hash(fs.readFileSync(file)),mappingHash:hash(JSON.stringify(evidence.mapping)),journalFile:record.journal_file};
}
function assertReusedHistory(ctx, expectedReason) {
 const {f,gate,file,evidence,sha256,mappingHash}=ctx,history=entry(f).acceptance.history.filter(item=>item.file===path.relative(f.root,file));
 assert.equal(history.length,1);assert.equal(history[0].gate_id,gate);assert.equal(history[0].reason,expectedReason);
 assert.equal(history[0].mapping_sha256,mappingHash);assert.equal(history[0].sha256,sha256);assert.equal(hash(fs.readFileSync(file)),sha256);
 assert.deepEqual(JSON.parse(fs.readFileSync(file)).mapping,evidence.mapping);
 const snapshot=JSON.parse(fs.readFileSync(path.join(f.root,history[0].journal_snapshot_file)));
 assert.equal(snapshot.cleanup_verified,true);assert.equal(snapshot.source.sha256,evidence.source.sha256);
 assert.equal(hash(fs.readFileSync(path.join(f.root,history[0].journal_snapshot_file))),history[0].journal_snapshot_sha256);
 assert.equal(entry(f).acceptance.refresh_count,1);assert.equal(entry(f).recovery.repair_count,0);assert.equal(entry(f).recovery.no_progress_count,0);
 assert.equal(f.calls().some(call=>call.role==='supervisor'),false);assert.equal(entry(f).status,'completed');assert.equal(workers(f).length,2);
}
test('source drift after journal evidence refreshes one generation without source recovery',async t=>{
 const ctx=await interruptAfterEvidence(t),{f}=ctx;f.write('lib/feature.mjs','export const state = "SOURCE_REFRESHED";\n');
 ok(f.run('--no-recovery'));assertReusedHistory(ctx,'stale-source-or-context');
 assert.deepEqual(f.gates().map(call=>call.gate),['npm','sql','npm','sql','build','browser']);
 assert.equal(new Set(entry(f).acceptance.history.filter(item=>item.refresh_generation).map(item=>item.refresh_generation)).size,1);
});
test('mapping drift preserves recovered evidence mapping and refreshes without source recovery',async t=>{
 const ctx=await interruptAfterEvidence(t),{f}=ctx,mapping=JSON.parse(fs.readFileSync(path.join(f.root,'plan/01-acceptance-mapping.json')));
 const sql=mapping.gates.find(item=>item.gate_id==='sql');sql.cases.push('second rollback assertion');mapping.criteria.find(item=>item.criterion_id==='write').test_ids.push('second rollback assertion');
 f.write('tests/acceptance/01/feature.postgres.test.ts','assert.equal(deniedWriteChanges(), 0);\nassert.equal(secondDeniedWriteChanges(), 0);\n');f.write('plan/01-acceptance-mapping.json',JSON.stringify(mapping));
 ok(f.run('--no-recovery'));assertReusedHistory(ctx,'stale-reviewed-mapping');
 assert.notEqual(entry(f).acceptance.gates.sql.mapping_sha256,ctx.mappingHash);
 assert.equal(entry(f).acceptance.gates.sql.mapping_sha256,hash(JSON.stringify(sql)));
 assert.deepEqual(f.gates().map(call=>call.gate),['npm','sql','npm','sql','build','browser']);
});
test('recovered stale evidence obeys refresh budget and retains its original sealed identity',async t=>{
 const ctx=await interruptAfterEvidence(t,'npm'),{f}=ctx;f.write('lib/feature.mjs','export const state = "BUDGET_REFRESH";\n');
 const first=f.run('--no-recovery','--max-evidence-refreshes','0');assert.equal(first.status,75,first.stdout+first.stderr);
 const retained=entry(f).acceptance.gates.npm;assert.equal(retained.mapping_sha256,ctx.mappingHash);assert.equal(retained.sha256,ctx.sha256);assert.ok(retained.journal_snapshot_file);assert.equal(f.gates().length,1);
 const calls=f.calls().length;assert.equal(f.run('--no-recovery','--max-evidence-refreshes','0').status,75);assert.equal(f.calls().length,calls);assert.equal(f.gates().length,1);
 ok(f.run('--no-recovery','--max-evidence-refreshes','1'));assertReusedHistory(ctx,'stale-source-or-context');assert.equal(f.gates().length,5);
});
test('unchanged recovered evidence is reused without any refresh or duplicated capability',async t=>{
 const ctx=await interruptAfterEvidence(t),{f}=ctx;ok(f.run('--no-recovery'));assert.equal(entry(f).status,'completed');assert.equal(entry(f).acceptance.refresh_count,0);assert.equal(entry(f).acceptance.history.length,0);
 assert.equal(entry(f).acceptance.gates.sql.sha256,ctx.sha256);assert.equal(entry(f).acceptance.gates.sql.mapping_sha256,ctx.mappingHash);assert.ok(entry(f).acceptance.gates.sql.journal_snapshot_file);
 assert.deepEqual(f.gates().map(call=>call.gate),['npm','sql','build','browser']);assert.equal(workers(f).length,2);
});
test('recovered nested artifact tampering cannot be hidden by a mapping refresh',async t=>{
 const ctx=await interruptAfterEvidence(t,'npm'),{f}=ctx,mapping=JSON.parse(fs.readFileSync(path.join(f.root,'plan/01-acceptance-mapping.json')));mapping.gates.find(item=>item.gate_id==='npm').cases.push('another scoped read');f.write('plan/01-acceptance-mapping.json',JSON.stringify(mapping));
 fs.appendFileSync(path.join(f.root,ctx.evidence.artifacts[0].file),'tampered');const result=f.run('--no-recovery');assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/evidence artifact changed/);assert.notEqual(entry(f).status,'completed');assert.equal(f.gates().length,1);assert.equal(entry(f).acceptance.refresh_count,0);
});
