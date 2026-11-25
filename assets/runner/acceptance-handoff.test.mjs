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
  const defaults = [['--max-no-progress', '2'], ['--retry-delay-seconds', '0.02'], ['--max-delay-seconds', '0.04']];
  const argv = (extra = []) => [path.join(root, 'run.mjs'), 'start', '--repo', root, '--manifest', 'plan/manifest.json', ...(fs.existsSync(path.join(runtime, 'site-recovery-policy.v1.json')) ? ['--recovery-policy', 'plan/recovery-policy.json'] : []), '--codex-bin', path.join(root, 'fake-codex.mjs'), '--step', '01', '--progress-seconds', '0', ...defaults.filter(([flag]) => !extra.includes(flag)).flat(), ...extra];
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

test('direct acceptance-ready with no final artifacts executes every configured capability then resumes original worker', t => {
  const f = fixture(t); ok(f.run());
  assert.equal(entry(f).status, 'completed');
  assert.deepEqual(f.gates().map(c => c.capability), ['npm-checks', 'synthetic-postgres', 'production-build', 'loopback-browser']);
  assert.equal(workers(f).length, 2); assert.equal(workers(f)[0].thread, workers(f)[1].thread);
  assert.equal(f.calls().some(c => c.role === 'supervisor'), false);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, 'receipts/01.json')));
  assert.equal(receipt.attempt_id, workers(f)[1].attempt); assert.equal(entry(f).last_attempt.attempt_id, workers(f)[1].attempt);
  assert.match(workers(f)[1].prompt, /Parent acceptance evidence/);
  assert.match(workers(f)[1].prompt, /evidence\.json/);
  const before = f.calls().length; ok(f.run()); assert.equal(f.calls().length, before);
});

test('truthful sandbox-blocked worker requires an explicit typed supervisor acceptance-check', t => {
  const f = fixture(t, { initialBlocked: true }); ok(f.run());
  assert.deepEqual(f.calls().map(c => c.role), ['worker', 'supervisor', 'acceptance-reviewer', 'acceptance-reviewer', 'worker']);
  assert.equal(workers(f)[0].thread, workers(f)[1].thread);
  assert.equal(entry(f).recovery.decisions[0].action, 'acceptance-check');
  assert.equal(entry(f).recovery.repair_count, 1); assert.equal(f.gates().length, 4);
});

for (const stage of ['mapping', 'evidence']) test(`interrupted ${stage} review resumes parent acceptance without repeating implementation or passing gates`, async t => {
  const f = fixture(t, { hangReview: stage }), running = f.start();
  await waitFor(f, () => fs.existsSync(path.join(f.root, '.codex-plan-runner/hanging.json')));
  const before = structuredClone(entry(f));
  assert.equal(before.recovery.phase, 'acceptance'); assert.notEqual(before.status, 'completed');
  assert.equal(fs.existsSync(path.join(f.root, 'receipts/01.json')), false);
  assert.equal(workers(f).length, 1);
  assert.equal(f.gates().length, stage === 'mapping' ? 0 : 4);
  running.child.kill('SIGTERM'); assert.equal((await running.done).status, 143);
  ok(f.run()); assert.equal(workers(f).length, 2); assert.equal(f.gates().length, 4);
  assert.equal(entry(f).recovery.repair_count, before.recovery.repair_count);
  assert.equal(entry(f).acceptance.refresh_count, before.acceptance.refresh_count);
  const reviews = f.calls().filter(c => c.role === 'acceptance-reviewer' && c.prompt.includes('STAGE: ' + stage));
  assert.equal(reviews.length, 2); assert.equal(reviews[0].thread, reviews[1].thread);
});

test('parent evidence alone never completes package while finalization is interrupted', async t => {
  const f = fixture(t, { hangFinalization: true }), running = f.start();
  await waitFor(f, () => fs.existsSync(path.join(f.root, '.codex-plan-runner/hanging.json')));
  assert.notEqual(entry(f).status, 'completed'); assert.ok(entry(f).acceptance.accepted_source_sha256);
  assert.equal(fs.existsSync(path.join(f.root, 'receipts/01.json')), false); assert.equal(f.gates().length, 4);
  const before = structuredClone(entry(f)); running.child.kill('SIGTERM'); assert.equal((await running.done).status, 143);
  ok(f.run()); assert.equal(f.gates().length, 4); assert.equal(workers(f).length, 3);
  assert.equal(workers(f)[1].thread, workers(f)[2].thread);
  assert.equal(entry(f).acceptance.refresh_count, before.acceptance.refresh_count);
});

test('failed parent gate returns through source repair, preserves failed evidence and refreshes the changed source once', t => {
  const f = fixture(t, { broken: true }); ok(f.run());
  assert.equal(entry(f).recovery.repair_count, 1); assert.equal(entry(f).acceptance.refresh_count, 1);
  assert.deepEqual(f.gates().map(c => c.gate), ['npm', 'sql', 'npm', 'sql', 'build', 'browser']);
  assert.ok(entry(f).acceptance.history.some(h => h.passed === false));
  assert.equal(workers(f).length, 2); assert.equal(workers(f)[0].thread, workers(f)[1].thread);
});

test('source changed during finalization requires fresh parent gates before acceptance', t => {
  const f = fixture(t, { driftFinalization: true }); ok(f.run());
  assert.equal(entry(f).acceptance.refresh_count, 1); assert.equal(f.gates().length, 8);
  assert.equal(entry(f).status, 'completed'); assert.equal(workers(f).length, 3);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, 'receipts/01.json')));
  assert.equal(receipt.attempt_id, workers(f).at(-1).attempt);
});

test('missing final receipt cannot become accepted even after all parent gates pass', t => {
  const f = fixture(t, { omitFinalReceipt: true }), result = f.run('--max-no-progress', '1', '--max-repair-retries', '1');
  assert.notEqual(result.status, 0); assert.notEqual(entry(f).status, 'completed');
  assert.ok(entry(f).acceptance.accepted_source_sha256); assert.equal(f.gates().length, 4);
  assert.equal(fs.existsSync(path.join(f.root, 'receipts/01.json')), false);
});

for (const config of [
  { workerBlockers: ['External service is unavailable.'] },
  { workerExtra: true },
  { legacy: true },
  { noProfile: true },
  { initialBlocked: true, supervisorClassification: 'external' },
  { initialBlocked: true, supervisorBlockers: ['External service is unavailable.'] },
  { initialBlocked: true, supervisorRecipe: 'npm-checks' },
  { initialBlocked: true, supervisorExtra: true },
  { initialBlocked: true, legacy: true },
]) test('unauthorized handoff is rejected without parent gates: ' + JSON.stringify(config), t => {
  const f = fixture(t, config), result = f.run('--max-protocol-retries', '0');
  assert.notEqual(result.status, 0); assert.notEqual(entry(f).status, 'completed');
  assert.equal(f.gates().length, 0); assert.equal(fs.existsSync(path.join(f.root, 'forbidden-command')), false);
});

test('manual boundary cannot enter acceptance and legacy completion retains receipt semantics', t => {
  const manual = fixture(t, { manual: true }); assert.equal(manual.run().status, 2); assert.equal(manual.calls().length, 0); assert.equal(manual.gates().length, 0);
  const legacy = fixture(t, { legacy: true, legacyComplete: true }); ok(legacy.run()); assert.equal(entry(legacy).status, 'completed'); assert.equal(legacy.gates().length, 0); assert.equal(workers(legacy).length, 1);
});

test('arbitrary blocked prose never authorizes acceptance without explicit valid supervisor action', t => {
  const f = fixture(t, { alwaysBlocked: true, supervisorAction: 'blocked', supervisorClassification: 'external', supervisorBlockers: ['Genuine external approval required.'] });
  assert.notEqual(f.run().status, 0); assert.equal(f.gates().length, 0); assert.notEqual(entry(f).status, 'completed');
  assert.match(entry(f).recovery.terminal_blocker, /Genuine external approval/);
});

test('timeout budget remains finite across restart and does not replay implementation', t => {
  const f = fixture(t, { timeoutAttempts: 5 }), args = ['--max-evidence-refreshes', '1'];
  assert.equal(f.run(...args).status, 75); const before = structuredClone(entry(f)), callCount = f.calls().length, gateCount = f.gates().length;
  assert.equal(before.acceptance.timeout_retry_count, 1); assert.equal(workers(f).length, 1);
  assert.equal(f.run(...args).status, 75); assert.equal(f.calls().length, callCount); assert.equal(f.gates().length, gateCount);
  assert.equal(entry(f).acceptance.timeout_retry_count, 1); assert.notEqual(entry(f).status, 'completed');
});

test('source refresh budget exhaustion persists without rerunning accepted gates or worker implementation', t => {
  const f = fixture(t, { driftFinalization: true }), args = ['--max-evidence-refreshes', '0'];
  assert.equal(f.run(...args).status, 75); const count = f.calls().length, gates = f.gates().length;
  assert.equal(f.run(...args).status, 75); assert.equal(f.calls().length, count); assert.equal(f.gates().length, gates);
  assert.notEqual(entry(f).status, 'completed'); ok(f.run('--max-evidence-refreshes', '1'));
  assert.equal(entry(f).acceptance.refresh_count, 1); assert.equal(f.gates().length, 8);
});

test('acceptance reviewer provider budget cannot be erased by a new worker handoff', t => {
  const f = fixture(t, { providerFailure: 'rate-limit', providerFailures: 5 }), args = ['--max-rate-retries', '1'];
  assert.equal(f.run(...args).status, 75); const before = structuredClone(entry(f)), calls = f.calls().length;
  assert.equal(workers(f).length, 1); assert.equal(f.gates().length, 4); assert.equal(before.rate_limit_count, 2);
  assert.equal(f.run(...args).status, 75); assert.equal(f.calls().length, calls); assert.equal(entry(f).rate_limit_count, 2);
  assert.notEqual(entry(f).status, 'completed');
});

test('TPM subdivision finalizer handoff resumes the same finalizer after strict acceptance', t => {
  const f = fixture(t, { subdivision: true }); ok(f.run());
  const finalizers = f.calls().filter(c => c.role === 'finalizer');
  assert.equal(finalizers.length, 2); assert.equal(finalizers[0].thread, finalizers[1].thread);
  assert.equal(f.calls().filter(c => c.role === 'worker').length, 1);
  assert.equal(f.calls().filter(c => c.role === 'subtask').length, 2); assert.equal(f.gates().length, 4);
  assert.equal(entry(f).recovery.subdivision.next_task, 2); assert.equal(entry(f).status, 'completed');
});


test('repeated unchanged acceptance-ready after parent success exhausts no-progress without rerunning gates', t => {
  const f = fixture(t, { alwaysReady: true }), args = ['--max-no-progress', '2'];
  assert.equal(f.run(...args).status, 75); const count = f.calls().length;
  assert.notEqual(entry(f).status, 'completed'); assert.equal(f.gates().length, 4);
  assert.ok(entry(f).recovery.no_progress_count >= 2); assert.ok(workers(f).length <= 4);
  assert.equal(f.run(...args).status, 75); assert.equal(f.calls().length, count); assert.equal(f.gates().length, 4);
});

test('unknown gate cleanup blocks acceptance handoff before finalization or retry', t => {
  const f = fixture(t, { timeoutAttempts: 1, unknownCleanup: true });
  assert.notEqual(f.run().status, 0); assert.notEqual(entry(f).status, 'completed');
  assert.equal(workers(f).length, 1); assert.equal(f.gates().length, 2);
  assert.match(entry(f).recovery.terminal_blocker, /cleanup remains unverified/);
});


for (const initialBlocked of [false, true]) test(`hard-stopped incomplete acceptance checkpoint resumes ${initialBlocked ? 'supervisor' : 'worker'} handoff without replay`, async t => {
  const f = fixture(t, { initialBlocked, hangGate: 'sql' }), running = f.start();
  await waitFor(f, () => fs.existsSync(path.join(f.root, '.codex-plan-runner/gate-hanging.json')));
  const stateFile = path.join(f.root, '.codex-plan-runner/acceptance-handoff/state.json');
  const checkpoint = fs.readFileSync(stateFile), before = JSON.parse(checkpoint).steps['01'];
  assert.equal(before.status, 'incomplete'); assert.equal(before.recovery.phase, 'acceptance');
  assert.equal(before.recovery.next_action, 'await-parent-acceptance');
  assert.equal(before.recovery.acceptance_request.origin, initialBlocked ? 'supervisor' : 'worker');
  assert.equal(before.recovery.repair_count, initialBlocked ? 1 : 0);
  assert.equal(before.recovery.no_progress_count, initialBlocked ? 1 : 0);
  assert.equal(fs.existsSync(path.join(f.root, 'receipts/01.json')), false);
  assert.deepEqual(f.gates().map(c => c.gate), ['npm', 'sql']);
  // The synthetic gate waits in the parent: no worker can be orphaned by this
  // hard stop, and no graceful handler may rewrite the checkpoint to interrupted.
  const lock = JSON.parse(fs.readFileSync(path.join(f.root, '.codex-plan-runner/acceptance-handoff/runner.lock')));
  assert.equal(lock.pid, running.child.pid); assert.equal(lock.worker_pid, null);
  running.child.kill('SIGKILL'); await running.done;
  assert.equal(running.child.signalCode, 'SIGKILL');
  assert.deepEqual(fs.readFileSync(stateFile), checkpoint, 'Hard stop must preserve the exact saved incomplete state');

  ok(f.run()); const after = entry(f);
  assert.equal(after.status, 'completed');
  assert.deepEqual(f.gates().map(c => c.gate), ['npm', 'sql', 'build', 'browser']);
  assert.equal(workers(f).length, 2); assert.equal(workers(f)[0].thread, workers(f)[1].thread);
  assert.deepEqual(after.recovery.acceptance_request, before.recovery.acceptance_request);
  for (const key of ['repair_count', 'transport_count', 'protocol_retry_count', 'evidence_refresh_count', 'no_progress_count']) {
    assert.equal(after.recovery[key], before.recovery[key], `${key} must survive restart`);
  }
  assert.equal(after.acceptance.refresh_count, before.acceptance.refresh_count);
  assert.equal(after.acceptance.timeout_retry_count, before.acceptance.timeout_retry_count);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, 'receipts/01.json')));
  assert.equal(receipt.attempt_id, workers(f)[1].attempt);
});

test('interruption after a later gate writes evidence resumes its journal without repeating any capability', async t => {
  const f = fixture(t, { hangGate: 'sql' }), running = f.start();
  await waitFor(f, () => fs.existsSync(path.join(f.root, '.codex-plan-runner/gate-hanging.json')));
  assert.equal(entry(f).recovery.phase, 'acceptance'); assert.equal(f.gates().length, 2);
  assert.ok(entry(f).acceptance.gates.npm.file); assert.ok(entry(f).acceptance.gates.sql.journal_file);
  running.child.kill('SIGTERM'); assert.equal((await running.done).status, 143);
  const before = structuredClone(entry(f)); ok(f.run());
  assert.deepEqual(f.gates().map(c => c.gate), ['npm', 'sql', 'build', 'browser']);
  assert.equal(workers(f).length, 2); assert.equal(entry(f).acceptance.refresh_count, before.acceptance.refresh_count);
  assert.equal(entry(f).recovery.repair_count, before.recovery.repair_count);
});

test('strict direct handoff needs no legacy repair recipe and remains available with source recovery disabled', t => {
  const f = fixture(t, { localRepair: false }); ok(f.run('--no-recovery'));
  assert.equal(entry(f).status, 'completed'); assert.equal(f.gates().length, 4);
  assert.equal(f.calls().some(c => c.role === 'supervisor'), false); assert.equal(workers(f).length, 2);
});


for (const subdivision of [false, true]) test(`explicit fresh-session after interrupted ${subdivision ? 'finalizer' : 'worker'} retains return actor through source refresh`, async t => {
  const f = fixture(t, { hangFinalization: true, driftFinalization: true, subdivision }), running = f.start();
  await waitFor(f, () => fs.existsSync(path.join(f.root, '.codex-plan-runner/hanging.json')));
  const role = subdivision ? 'finalizer' : 'worker';
  const actors = () => f.calls().filter(c => c.role === role);
  const originalThread = actors().at(-1).thread;
  assert.notEqual(entry(f).status, 'completed'); assert.equal(f.gates().length, 4);
  running.child.kill('SIGTERM'); assert.equal((await running.done).status, 143);
  ok(f.run('--fresh-session'));
  assert.equal(entry(f).status, 'completed'); assert.equal(f.gates().length, 8);
  assert.equal(entry(f).acceptance.refresh_count, 1); assert.equal(actors().length, 4);
  assert.notEqual(actors()[2].thread, originalThread); assert.equal(actors()[2].thread, actors()[3].thread);
  assert.equal(entry(f).recovery.acceptance_request.thread_id, actors()[3].thread);
  const requestHistory = entry(f).recovery.history.filter(item => item.action === 'acceptance-request');
  assert.equal(requestHistory[0].request.thread_id, originalThread);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, 'receipts/01.json')));
  assert.equal(receipt.attempt_id, actors()[3].attempt);
});

for (const stage of ['mapping', 'evidence']) test(`interrupted ${stage} refresh after finalization drift still requires a new final receipt`, async t => {
  const f = fixture(t, { driftFinalization: true, hangRefreshReview: stage }), running = f.start();
  await waitFor(f, () => fs.existsSync(path.join(f.root, '.codex-plan-runner/hanging.json')));
  assert.equal(workers(f).length, 2); assert.notEqual(entry(f).status, 'completed');
  const priorAttempt = JSON.parse(fs.readFileSync(path.join(f.root, 'receipts/01.json'))).attempt_id;
  running.child.kill('SIGTERM'); assert.equal((await running.done).status, 143);
  ok(f.run()); assert.equal(workers(f).length, 3); assert.equal(f.gates().length, 8);
  assert.equal(entry(f).acceptance.refresh_count, 1); assert.equal(entry(f).status, 'completed');
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, 'receipts/01.json')));
  assert.notEqual(receipt.attempt_id, priorAttempt); assert.equal(receipt.attempt_id, workers(f).at(-1).attempt);
});

test('missing finalization session replacement retains handoff through later source refresh', t => {
  const f = fixture(t, { missingFinalSession: true, driftFinalization: true }); ok(f.run());
  assert.equal(entry(f).status, 'completed'); assert.equal(entry(f).recovery.session_replacement_count, 1);
  assert.equal(f.gates().length, 8); assert.equal(workers(f).length, 4);
  assert.equal(entry(f).recovery.acceptance_request.thread_id, workers(f).at(-1).thread);
  assert.notEqual(workers(f)[1].thread, workers(f)[2].thread);
});
