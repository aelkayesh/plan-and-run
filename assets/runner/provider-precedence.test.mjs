import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
 if(config.hangGate===gate.id&&calls===1){fs.writeFileSync(path.join(root,'.codex-plan-runner/gate-hanging.json'),JSON.stringify({gate:gate.id,journalFile}));if(!signal?.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}
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
 const emitNow=v=>{
  if(config.innocuous){console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'Invalid API key; insufficient_quota; unsupported model',error:{message:'Invalid API key'}}}));if('summary' in v)v.summary='Tool fixture mentions invalid API key, insufficient quota and unsupported model; no provider failure.';}
  if(config.permanentRole===role){const message={authentication:'Invalid API key',quota:'insufficient_quota: billing credits exhausted',configuration:'Unsupported model; invalid configuration'}[config.permanentKind];if(config.stderrFailure)process.stderr.write(message+'\n');else console.log(JSON.stringify({type:'error',message}));}
  fs.writeFileSync(out,JSON.stringify(v));console.log(JSON.stringify({type:'turn.completed'}));};
 const emit=v=>{
  if(config.timeoutRole===role&&same.length===0){
   process.once('SIGTERM',()=>{emitNow(v);process.exit(0);});
   fs.writeFileSync('.codex-plan-runner/timeout-trap-ready.json',JSON.stringify({role,attempt}));
   setInterval(()=>{},1000);return;
  }
  emitNow(v);
 };

 const hang=kind=>{fs.writeFileSync('.codex-plan-runner/hanging.json',JSON.stringify({kind,role,thread}));setInterval(()=>{},1000);};
 if(role==='acceptance-reviewer'){
  const stage=marker('STAGE'),stages=same.filter(c=>c.prompt.includes('STAGE: '+stage));
  if(config.hangReview===stage&&!stages.length){hang('review-'+stage);return;}
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
 if(config.writeIndex)fs.writeFileSync('plan/README.md','Final package index, referencing parent evidence in place.\n');
 execFileSync(process.execPath,['--check','lib/feature.mjs']);const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 fs.mkdirSync(path.dirname(step.validation),{recursive:true});fs.writeFileSync(step.validation,JSON.stringify({schema_version:1,package_id:id,attempt_id:attempt,status:'completed',source:{head,branch:'fixture',dirty:true},changed_files:[],checks:[{command:'node --check lib/feature.mjs',exit_code:0,passed:true}],fixtures:[],blockers:[]}));fs.writeFileSync(step.handoff,'Synthetic source syntax check passed; parent retains separate acceptance evidence.');
 emit({...base,status:'completed',summary:'Current receipt finalized after parent acceptance evidence.'});
});
`;

function fixture(t, config = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-handoff-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), value); };
  fs.cpSync(runtime, path.join(root, 'runtime'), { recursive: true, filter: file => !file.endsWith('.test.mjs') && !/\/\d{2}-evidence(?:\/|$)/.test(file) });
  write('runtime/acceptance-adapters.mjs', adapter);
  write('run.mjs', String.raw`
import fs from 'node:fs';
// Stop at the real persisted-attempt boundary after worker-group cleanup. The
// hook writes only synthetic private state; production runtime stays untouched.
const rename = fs.renameSync;
fs.renameSync = function(from, to, ...args) {
 const result = rename.call(this, from, to, ...args);
 const config=JSON.parse(fs.readFileSync('fixture-config.json'));
 if((config.crashAfterAttempt||config.crashAfterCharge)&&String(to).endsWith('/state.json')&&!fs.existsSync('.codex-plan-runner/timeout-crash-once')){
  const state=JSON.parse(fs.readFileSync(to)),entry=state.steps?.['01'],subdivision=entry?.recovery?.subdivision;
  const actor=config.timeoutRole==='supervisor'?entry?.recovery?.supervisor:config.timeoutRole==='acceptance-reviewer'?entry?.acceptance?.review_actor:config.timeoutRole==='planner'?subdivision?.planner:config.timeoutRole==='subtask'?subdivision?.tasks[subdivision.next_task]?.actor:config.timeoutRole==='finalizer'?subdivision?.finalizer:entry;
  const charged=actor?.last_attempt?.timed_out===true&&actor.last_attempt.retry_accounted===true&&entry.recovery.transport_count===1;
  if((!config.crashAfterCharge||charged)&&actor?.last_attempt?.role===config.timeoutRole&&actor.last_attempt.finished_at&&actor.last_attempt.exit_code===0&&actor.last_attempt.turn_completed&&fs.existsSync('.codex-plan-runner/timeout-trap-ready.json')){
   fs.writeFileSync('.codex-plan-runner/timeout-crash-once','1');process.kill(process.pid,'SIGKILL');
  }
 }
 return result;
};
const {main}=await import('./runtime/runner.mjs');main().then(code=>process.exitCode=code).catch(e=>{console.error(e.stack);process.exitCode=1;});
`);
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
  const argv = (extra = []) => [path.join(root, 'run.mjs'), 'start', '--repo', root, '--manifest', 'plan/manifest.json', ...(fs.existsSync(path.join(runtime, 'site-recovery-policy.v1.json')) ? ['--recovery-policy', 'plan/recovery-policy.json'] : []), '--codex-bin', path.join(root, 'fake-codex.mjs'), '--step', '01', '--progress-seconds', '0', '--max-no-progress', '2', '--retry-delay-seconds', '0.02', '--max-delay-seconds', '0.04', ...extra];
  const env = { ...process.env, CODEX_HOME: path.join(root, 'fake-auth'), CODEX_PLAN_WORKER: '', CODEX_RECOVERY_SUPERVISOR: '' };
  const run = (...extra) => spawnSync(process.execPath, argv(extra), { cwd: root, env, encoding: 'utf8', timeout: 90000 });
  const start = (...extra) => {
    const child = spawn(process.execPath, argv(extra), { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const done = new Promise(resolve => child.on('close', status => resolve({ status, stdout, stderr })));
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


const counters = recovery => ({repair:recovery.repair_count,protocol:recovery.protocol_retry_count,transport:recovery.transport_count,refresh:recovery.evidence_refresh_count,noProgress:recovery.no_progress_count});
function permanentConfig(shape, kind, extra={}) {
  return { permanentRole: shape==='supervisor'?'supervisor':'worker', permanentKind:kind,
    ...(shape==='completed'?{legacyComplete:true}:{}), ...(shape==='supervisor'?{initialBlocked:true}:{}), ...extra };
}
function assertPermanent(f, result, kind, shape) {
  assert.ok([1,2].includes(result.status),result.stdout+result.stderr);
  assert.match(entry(f).recovery.terminal_blocker,new RegExp('Provider '+kind));
  assert.notEqual(entry(f).status,'completed');assert.equal(f.gates().length,0);
  assert.equal(entry(f).recovery.protocol_retry_count,0);assert.equal(entry(f).recovery.transport_count,0);
  assert.equal(entry(f).recovery.no_progress_count,shape==='supervisor'?1:0,'Only the preceding blocked worker is counted');assert.equal(entry(f).recovery.evidence_refresh_count,0);
  assert.equal(entry(f).recovery.repair_count,shape==='supervisor'?1:0,'Only the already-started supervisor cycle is charged');
  assert.equal(f.calls().filter(c=>c.role==='acceptance-reviewer').length,0);
}
for(const kind of ['authentication','quota','configuration'])for(const shape of ['ready','completed','supervisor']) {
  test(`live ${shape} output cannot override provider ${kind}`,t=>{
    const f=fixture(t,permanentConfig(shape,kind));assertPermanent(f,f.run(),kind,shape);
    const count=f.calls().length,before=counters(entry(f).recovery);
    assertPermanent(f,f.run(),kind,shape);assert.equal(f.calls().length,count);assert.deepEqual(counters(entry(f).recovery),before);
  });
  test(`cached ${shape} output retains provider ${kind}`,t=>{
    const f=fixture(t,permanentConfig(shape,kind));assertPermanent(f,f.run(),kind,shape);
    const state=f.state(),saved=state.steps['01'],actor=shape==='supervisor'?saved.recovery.supervisor:saved;
    assert.match(actor.last_attempt.outcome.log_sha256,/^[a-f0-9]{64}$/);assert.match(actor.last_attempt.outcome.stderr_sha256,/^[a-f0-9]{64}$/);
    const count=f.calls().length,before=counters(saved.recovery);
    saved.status='running';saved.recovery.phase=shape==='supervisor'?'supervisor':'worker';saved.recovery.next_action='await-'+saved.recovery.phase;
    delete saved.recovery.terminal_blocker;delete saved.recovery.resume_phase;
    fs.writeFileSync(path.join(f.root,'.codex-plan-runner/acceptance-handoff/state.json'),JSON.stringify(state));
    assertPermanent(f,f.run(),kind,shape);assert.equal(f.calls().length,count);assert.deepEqual(counters(entry(f).recovery),before);
  });
}
for(const shape of ['ready','completed','supervisor'])test(`legacy cached ${shape} reads retained errors and seals diagnostic hashes`,t=>{
  const f=fixture(t,permanentConfig(shape,'authentication'));assertPermanent(f,f.run(),'authentication',shape);
  const state=f.state(),saved=state.steps['01'],actor=shape==='supervisor'?saved.recovery.supervisor:saved;
  delete actor.last_attempt.outcome.log_sha256;delete actor.last_attempt.outcome.stderr_sha256;
  saved.status='running';saved.recovery.phase=shape==='supervisor'?'supervisor':'worker';saved.recovery.next_action='await-'+saved.recovery.phase;
  delete saved.recovery.terminal_blocker;delete saved.recovery.resume_phase;
  fs.writeFileSync(path.join(f.root,'.codex-plan-runner/acceptance-handoff/state.json'),JSON.stringify(state));const count=f.calls().length;
  assertPermanent(f,f.run(),'authentication',shape);assert.equal(f.calls().length,count);
  const resumed=shape==='supervisor'?entry(f).recovery.supervisor:entry(f);assert.match(resumed.last_attempt.outcome.log_sha256,/^[a-f0-9]{64}$/);
});
for(const shape of ['ready','completed','supervisor'])test(`innocuous ${shape} prose and tool payloads remain excluded`,t=>{
  const f=fixture(t,{innocuous:true,...(shape==='completed'?{legacyComplete:true}:{}),...(shape==='supervisor'?{initialBlocked:true}:{})});ok(f.run());assert.equal(entry(f).status,'completed');assert.equal(f.gates().length,4);
});
for(const field of ['log','stderr'])test(`cached ${field} tampering cannot erase a permanent failure`,t=>{
  const f=fixture(t,permanentConfig('ready','authentication',{stderrFailure:field==='stderr'}));assertPermanent(f,f.run(),'authentication','ready');
  const state=f.state(),saved=state.steps['01'];saved.status='running';saved.recovery.phase='worker';saved.recovery.next_action='await-worker';delete saved.recovery.terminal_blocker;delete saved.recovery.resume_phase;
  fs.writeFileSync(path.join(f.root,'.codex-plan-runner/acceptance-handoff/state.json'),JSON.stringify(state));
  fs.appendFileSync(field==='log'?saved.last_attempt.log_file:saved.last_attempt.log_file.slice(0,-6)+'-stderr.log','\n');const count=f.calls().length,result=f.run();
  assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/Saved provider diagnostic evidence changed/);assert.equal(f.calls().length,count);assert.equal(f.gates().length,0);
});
test('permanent provider failure precedes malformed worker protocol without charging corrections',t=>{
  const f=fixture(t,permanentConfig('ready','configuration',{workerExtra:true}));assertPermanent(f,f.run(),'configuration','ready');
});
test('receipt handoff and index finalization reuse one source generation and parent review',t=>{
  const f=fixture(t,{writeIndex:true,localRepair:false});ok(f.run('--no-recovery'));assert.equal(entry(f).status,'completed');assert.equal(workers(f).length,2);assert.equal(f.gates().length,4);assert.equal(entry(f).acceptance.refresh_count,0);
  assert.deepEqual(f.calls().filter(c=>c.role==='acceptance-reviewer').map(c=>c.prompt.match(/^STAGE: (.+)$/m)[1]),['mapping','evidence']);assert.ok(fs.existsSync(path.join(f.root,'plan/README.md')));
});
test('missing final receipt uses bounded recovery with accepted gates reused',t=>{
  const f=fixture(t,{omitFinalReceipt:true}),result=f.run('--max-repair-retries','2');assert.notEqual(result.status,0);assert.notEqual(entry(f).status,'completed');assert.equal(f.gates().length,4);assert.ok(entry(f).acceptance.accepted_source_sha256);
  assert.doesNotMatch(result.stdout+result.stderr,/no-progress tracking requires/);assert.match(result.stdout+result.stderr,/no-progress limit|Repair\/supervisor budget exhausted/);assert.ok(entry(f).recovery.no_progress_count>0);assert.ok(f.calls().some(c=>c.role==='supervisor'));
});

const timeoutOptions = (role, retries=0) => ['--timeout-minutes','0.03','--max-transport-retries',String(retries),'--max-repair-retries',role==='supervisor'?'1':'0'];
const actorFor = (value, role) => role==='supervisor'?value.recovery.supervisor:role==='acceptance-reviewer'?value.acceptance.review_actor:role==='planner'?value.recovery.subdivision.planner:role==='subtask'?value.recovery.subdivision.tasks[value.recovery.subdivision.next_task].actor:role==='finalizer'?value.recovery.subdivision.finalizer:value;
const timeoutConfig = role => ({timeoutRole:role,...(role==='supervisor'?{initialBlocked:true}:{}),...(['planner','subtask','finalizer'].includes(role)?{subdivision:true}:{})});

for (const role of ['worker','supervisor','acceptance-reviewer','finalizer']) test(`live timed-out ${role} cannot consume successful wire output`,t=>{
 const f=fixture(t,timeoutConfig(role)),result=f.run(...timeoutOptions(role));
 assert.notEqual(result.status,0,result.stdout+result.stderr);
 const saved=entry(f),actor=actorFor(saved,role);
 assert.notEqual(saved.status,'completed');assert.equal(f.gates().length,0);
 assert.equal(actor.last_attempt.exit_code,0);assert.equal(actor.last_attempt.turn_completed,true);
 assert.equal(actor.last_attempt.timed_out,true);
 assert.match(saved.diagnostic||saved.recovery.budget_reason||saved.recovery.terminal_blocker||'',role==='acceptance-reviewer'?/transport retry budget exhausted/:/timeout|exceeded/i);
 if(role==='supervisor'||role==='acceptance-reviewer')assert.equal(saved.recovery.transport_count,1);
});

for (const role of ['worker','supervisor','acceptance-reviewer','finalizer']) test(`hard-stop replays timed-out ${role} as timeout without new calls or acceptance`,t=>{
 const f=fixture(t,{...timeoutConfig(role),crashAfterAttempt:true}),args=timeoutOptions(role),first=f.run(...args);
 assert.equal(first.signal,'SIGKILL',first.stdout+first.stderr);
 const before=entry(f),actor=actorFor(before,role);
 assert.equal(actor.last_attempt.exit_code,0);assert.equal(actor.last_attempt.turn_completed,true);
 assert.ok(actor.last_attempt.outcome);
 const calls=f.calls().length,result=f.run(...args);
 assert.notEqual(result.status,0,result.stdout+result.stderr);
 assert.equal(f.calls().length,calls,'The finished timeout must be classified before a new model call');
 assert.equal(f.gates().length,0);assert.notEqual(entry(f).status,'completed');
 if(role==='supervisor'||role==='acceptance-reviewer')assert.equal(entry(f).recovery.transport_count,1);
 const failed=structuredClone(entry(f));const again=f.run(...args);
 assert.notEqual(again.status,0);assert.equal(f.calls().length,calls);assert.equal(f.gates().length,0);
 for(const key of ['transport_count','repair_count','protocol_retry_count'])assert.equal(entry(f).recovery[key],failed.recovery[key]);
});

const retryRoles = ['supervisor','acceptance-reviewer','planner','subtask'];
function assertRetriedOnce(f, role) {
 const saved=entry(f),calls=f.calls().filter(call=>call.role===role);
 assert.equal(saved.status,'completed');assert.equal(saved.recovery.transport_count,1,'One physical timeout charges exactly one transport retry');
 assert.equal(calls.length,role==='acceptance-reviewer'||role==='subtask'?3:2,'The saved timeout must be consumed before a new invocation');
 assert.notEqual(calls[0].attempt,calls[1].attempt,'Retry starts a new physical attempt');
 assert.equal(calls[0].thread,calls[1].thread,'Transport retry resumes the existing provider conversation');
 assert.ok(calls[1].args.includes('resume'));
 if(role==='acceptance-reviewer')assert.deepEqual(calls.map(call=>call.prompt.match(/^STAGE: (.+)$/m)[1]),['mapping','mapping','evidence']);
 if(role==='subtask')assert.deepEqual(calls.map(call=>call.prompt.match(/^SUBTASK_ID: (.+)$/m)[1]),['01','01','02']);
 assert.equal(f.gates().length,4);assert.equal(saved.recovery.protocol_retry_count,0);
}
for(const role of retryRoles)test(`one timed-out ${role} consumes one retry and invokes the provider again`,t=>{
 const f=fixture(t,timeoutConfig(role));ok(f.run(...timeoutOptions(role,1)));assertRetriedOnce(f,role);
});
for(const role of retryRoles)test(`hard-stop after charged ${role} timeout resumes without charging it twice`,t=>{
 const f=fixture(t,{...timeoutConfig(role),crashAfterCharge:true}),args=timeoutOptions(role,1),first=f.run(...args);
 assert.equal(first.signal,'SIGKILL',first.stdout+first.stderr);
 const saved=entry(f),actor=actorFor(saved,role),calls=f.calls().length;
 assert.equal(actor.last_attempt.timed_out,true);assert.equal(actor.last_attempt.retry_accounted,true);
 assert.equal(actor.last_attempt.exit_code,0);assert.equal(actor.last_attempt.turn_completed,true);assert.ok(actor.last_attempt.outcome);
 assert.equal(saved.recovery.transport_count,1);assert.equal(f.calls().filter(call=>call.role===role).length,1);
 assert.equal(f.gates().length,0);assert.notEqual(saved.status,'completed');
 ok(f.run(...args));assertRetriedOnce(f,role);assert.ok(f.calls().length>calls);
 const completedCalls=f.calls().length;ok(f.run(...args));assert.equal(f.calls().length,completedCalls);assert.equal(entry(f).recovery.transport_count,1);
});

for (const role of ['worker','planner','subtask','finalizer']) test(`operator-cancelled ${role} zero-exit output has no reusable outcome`,async t=>{
 const f=fixture(t,timeoutConfig(role)),running=f.start('--timeout-minutes','0');
 let closed=false;
 try {
  const deadline=Date.now()+20000;
  while(!fs.existsSync(path.join(f.root,'.codex-plan-runner/timeout-trap-ready.json'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30));
  assert.ok(fs.existsSync(path.join(f.root,'.codex-plan-runner/timeout-trap-ready.json')));
  running.child.kill('SIGTERM');const result=await running.done;closed=true;
  assert.equal(result.status,143,result.stdout+result.stderr);
  const saved=entry(f),actor=actorFor(saved,role);assert.equal(saved.status,'interrupted');
  assert.equal(actor.last_attempt.exit_code,0);assert.equal(actor.last_attempt.turn_completed,true);
  assert.equal(actor.last_attempt.outcome,undefined);assert.equal(actor.last_attempt.interrupted,true);
  assert.equal(f.gates().length,0);const calls=f.calls().length;
  const resumed=f.run('--timeout-minutes','0');ok(resumed);assert.equal(entry(f).status,'completed');
  assert.doesNotMatch(resumed.stdout+resumed.stderr,/Saved (planner|subtask) result\/checkpoint or source is stale/);
  assert.equal(f.calls().filter(call=>call.role===role).length,role==='planner'?2:3);
  assert.ok(f.calls().length>calls);assert.equal(f.gates().length,4);
 } finally { if(!closed){running.child.kill('SIGTERM');await running.done;} }
});
