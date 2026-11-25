import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const runtime = path.dirname(fileURLToPath(import.meta.url));
// The CLI and acceptance lifecycle are real. The adapter is a deterministic
// transport fixture; separate adapter tests cover its fixed host commands.
const adapter = String.raw`
import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import {snapshotSource} from './host-validation.mjs';
export function preflightAcceptanceCapabilities(){return {passed:true};}
export function acceptanceExecutionContext(){return {synthetic:true};}
export async function reconcileAcceptanceGate({root,journalFile}){fs.appendFileSync(path.join(root,'.codex-plan-runner/reconciled.jsonl'),JSON.stringify({journalFile})+'\n');return {cleanup_verified:true,journalFile};}
export function verifyAcceptanceEvidenceArtifacts({root,file}){const evidence=JSON.parse(fs.readFileSync(file));for(const item of evidence.artifacts||[]){if(createHash('sha256').update(fs.readFileSync(path.join(root,item.file))).digest('hex')!==item.sha256)throw Error('evidence artifact changed');}return evidence;}
export async function runAcceptanceGate({root,gate,mapping,outputDir,mutablePaths,packageId,planHash,onJournal}){
 fs.mkdirSync(outputDir,{recursive:true});const id=randomUUID(),source=snapshotSource(root,mutablePaths),journalFile=path.join(outputDir,'acceptance-'+id+'-journal.json');
 const journal={schema_version:1,kind:'acceptance-gate-journal',id,root,package_id:packageId,plan_hash:planHash,gate,source,phase:'interrupted',process:null,cleanup_verified:true,data_directory:path.join(outputDir,'data-'+id)};
 fs.writeFileSync(journalFile,JSON.stringify(journal));await onJournal({journalFile});
 const countFile=path.join(root,'.codex-plan-runner/gate-calls.jsonl');fs.appendFileSync(countFile,JSON.stringify({gate:gate.id,packageId})+'\n');
 const config=JSON.parse(fs.readFileSync(path.join(root,'fixture-config.json'))),gateCalls=fs.readFileSync(countFile,'utf8').trim().split('\n').map(JSON.parse).filter(call=>call.gate===gate.id).length;
 if(gate.id==='sql-b'&&gateCalls<=(config.timeoutAttempts||0))return {file:null,evidence:null,journalFile,timedOut:true,cleanup_verified:config.unknownCleanup!==true};
 const broken=fs.readFileSync(path.join(root,'lib/feature.mjs'),'utf8').includes('BROKEN');
 const nestedFile=path.join(outputDir,'assertions.json');fs.writeFileSync(nestedFile,JSON.stringify(mapping.cases));
 const evidence={schema_version:1,kind:'codex-plan-acceptance-gate',id,root,package_id:packageId,plan_hash:planHash,gate,cleanup_verified:true,passed:!(broken&&gate.id==='sql-b'),mapping,cases:mapping.cases,artifacts:[{file:path.relative(root,nestedFile),sha256:createHash('sha256').update(fs.readFileSync(nestedFile)).digest('hex')}],source,failure_ids:broken&&gate.id==='sql-b'?['sql-b:denied-write-rollback']:[]};
 const file=path.join(outputDir,'evidence.json');fs.writeFileSync(file,JSON.stringify(evidence));journal.evidence_file=file;journal.phase='completed';fs.writeFileSync(journalFile,JSON.stringify(journal));return {file,evidence,journalFile,summary:evidence.passed?'passed':'denied-write-rollback failed'};
}
export function verifyAcceptanceGate({root,file,mapping,mutablePaths,checkSource=true}){const evidence=JSON.parse(fs.readFileSync(file));if(JSON.stringify(evidence.mapping)!==JSON.stringify(mapping))throw Error('mapping/capability mismatch');if(checkSource&&evidence.source.sha256!==snapshotSource(root,mutablePaths).sha256)throw Error('source snapshot is stale');return {file,evidence,summary:evidence.passed?'passed':'denied-write-rollback failed'};}
`;
const worker = String.raw`#!/usr/bin/env node
if (process.argv.includes('login') && process.argv.includes('status')) { console.log('Logged in using ChatGPT'); process.exit(0); }
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash,randomUUID} from 'node:crypto';import {snapshotSource} from './runtime/host-validation.mjs';
let prompt='';process.stdin.on('data',v=>prompt+=v);process.stdin.on('end',()=>{
const args=process.argv.slice(2),out=args[args.indexOf('--output-last-message')+1],id=prompt.match(/^PACKAGE_ID: (.+)$/m)[1],attempt=prompt.match(/^ATTEMPT_ID: (.+)$/m)[1];
const role=process.env.CODEX_PLAN_ROLE,config=JSON.parse(fs.readFileSync('fixture-config.json')),manifest=JSON.parse(fs.readFileSync('plan/manifest.json')),step=manifest.steps.find(s=>s.id===id);
const callsFile='.codex-plan-runner/calls.jsonl',prior=fs.existsSync(callsFile)?fs.readFileSync(callsFile,'utf8').trim().split('\n').map(JSON.parse):[];
const thread=args.includes('resume')?args.at(-2):'10000000-0000-4000-8000-'+String(prior.length+1).padStart(12,'0');
fs.appendFileSync(callsFile,JSON.stringify({role,id,attempt,thread,args,prompt,at:Date.now()})+'\n');console.log(JSON.stringify({type:'thread.started',thread_id:thread}));
const emit=value=>{fs.writeFileSync(out,JSON.stringify(value));console.log(JSON.stringify({type:'turn.completed'}));};
if(config.strictSubdivision){
 const marker=name=>prompt.match(new RegExp('^'+name+': (.+)$','m'))?.[1];
 const subdivision=marker('SUBDIVISION_ID');
 if(role==='worker'){
  console.log(JSON.stringify({type:'turn.failed',error:{message:'Request too large for tokens per minute (TPM): Limit 1000, Requested 2000.',code:'request_too_large',retry_after_ms:30}}));process.exitCode=1;return;
 }
 if(role==='planner'){
  const directory=marker('ARTIFACT_DIRECTORY');
  emit({schema_version:1,package_id:id,attempt_id:attempt,subdivision_id:subdivision,status:'planned',summary:'Two bounded prerequisite syntax checks; original strict acceptance remains required.',source_sha256:marker('SOURCE_SHA256'),subtasks:['01','02'].map(task=>({id:task,title:'Verify prerequisite '+task,instructions:'Write and syntax-check only lib/checkpoint-'+task+'.mjs; preserve original strict acceptance.',checks:['node --check lib/checkpoint-'+task+'.mjs'],checkpoint_file:directory+'/task-'+task+'.json'})),blockers:[]});return;
 }
 if(role==='subtask'){
  const task=marker('SUBTASK_ID'),file=marker('CHECKPOINT_FILE'),changed='lib/checkpoint-'+task+'.mjs';
  fs.writeFileSync(changed,'export const prerequisite = '+Number(task)+';\n');
  execFileSync(process.execPath,['--check',changed]);
  const checkpoint={schema_version:1,package_id:id,attempt_id:attempt,subdivision_id:subdivision,subtask_id:task,summary:'Inspected partial work and syntax-checked the bounded prerequisite.',source_sha256:snapshotSource(process.cwd(),[step.validation,step.handoff,path.join(path.dirname(step.plan),'README.md')]).sha256,changed_files:[changed],checks:[{command:'node --check '+changed,exit_code:0,passed:true}],blockers:[],next_steps:['Preserve the checkpoint and require original strict gates in the finalizer.']};
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(checkpoint));
  const result={...checkpoint,status:'checkpointed',checkpoint_file:file,checkpoint_sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')};delete result.next_steps;emit(result);return;
 }
 if(role==='finalizer'&&!prior.some(call=>call.role==='finalizer')){
  fs.writeFileSync(out,'{malformed finalizer result');console.log(JSON.stringify({type:'turn.completed'}));return;
 }
}

if(role==='acceptance-reviewer'){
 if(config.reviewerFailureKind&&prompt.includes('STAGE: evidence')){
  const failures=prior.filter(c=>c.role===role&&c.prompt.includes('STAGE: evidence')).length;
  if(failures<(config.reviewerFailures||1)){
   const message=config.reviewerFailureKind==='rate-limit'?'Provider rate limit exceeded':config.reviewerFailureKind==='transport'?'Stream disconnected: network error':'Invalid API key';
   const retry_after_ms=failures+1===(config.reviewerFailures||1)?config.reviewerRetryAfterMs||0:0;
   console.log(JSON.stringify({type:'turn.failed',error:{message,retry_after_ms}}));process.exitCode=1;return;
  }
 }
 if(config.malformedReview&&!prior.some(c=>c.role===role)){fs.writeFileSync(out,'{bad');console.log(JSON.stringify({type:'turn.completed'}));return;}
 const packetFile=prompt.match(/parent evidence packet (\S+)\./)?.[1];
 const packet=JSON.parse(fs.readFileSync(packetFile));
 const denied=config.rejectReview;
 emit({schema_version:1,package_id:id,attempt_id:attempt,stage:prompt.match(/^STAGE: (.+)$/m)[1],binding_sha256:prompt.match(/^BINDING_SHA256: (.+)$/m)[1],verdict:denied?'rejected':'accepted',criteria:packet.criteria.map(c=>({id:c.id,satisfied:!denied,reason:denied?'Actual assertion does not cover criterion':'Inspected actual synthetic assertion and complete evidence.'})),blockers:[]});return;
}
if(role==='supervisor'){
 const repairs=prior.filter(c=>c.role==='supervisor').length+1;
 fs.writeFileSync('lib/feature.mjs','export const state = "'+(repairs<(config.repairsBeforePass||1)?'BROKEN_'+repairs:'REPAIRED')+'";\n');
 emit({schema_version:1,package_id:id,attempt_id:attempt,classification:'implementation',action:'resume',recipe_id:null,summary:'Repaired failed SQL rollback behavior after inspecting reports.',changed_files:['lib/feature.mjs'],blockers:[]});return;
}
const gate=(gid,files,cases)=>({gate_id:gid,files,cases});
const mapping={schema_version:1,package_id:id,gates:[gate('npm',['tests/feature.test.ts'],['npm-test','npm-check','allows authorized read']),gate('sql-a',['tests/acceptance/'+id+'/a.postgres.test.ts'],['persists authorized write']),gate('sql-b',['tests/acceptance/'+id+'/b.postgres.test.ts'],['denied write rolls back'])],criteria:[{criterion_id:'authorized-read',gate_id:'npm',test_ids:['allows authorized read']},{criterion_id:'authorized-write',gate_id:'sql-a',test_ids:['persists authorized write']},{criterion_id:'denied-write',gate_id:'sql-b',test_ids:['denied write rolls back']}]};
if(config.repairMapping&&prior.some(c=>c.role==='supervisor')){mapping.gates[2].cases=['denied write rolls back after repair'];mapping.criteria[2].test_ids=['denied write rolls back after repair'];}
if(config.omitCriterion)mapping.criteria.pop();
if(!config.omitMapping&&!(config.retainMapping&&fs.existsSync('plan/'+id+'-acceptance-mapping.json')))fs.writeFileSync('plan/'+id+'-acceptance-mapping.json',JSON.stringify(mapping));
if(config.forceSourceMutation&&prior.some(c=>c.role==='supervisor'))fs.appendFileSync('lib/feature.mjs','// next source revision\n');
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
fs.mkdirSync('receipts',{recursive:true});fs.writeFileSync(step.validation,JSON.stringify({schema_version:1,package_id:id,attempt_id:attempt,status:'completed',source:{head,branch:'fixture',dirty:true},changed_files:[],checks:[{command:'synthetic local assertion',exit_code:0,passed:true}],fixtures:[],blockers:[]}));fs.writeFileSync(step.handoff,'Synthetic handoff; actual parent gates required.');
emit({schema_version:1,package_id:id,attempt_id:attempt,status:'completed',summary:'Worker claims completion; parent must independently verify.',validation_file:step.validation,handoff_file:step.handoff,blockers:[]});
});`;

function fixture(t, config = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance transcript ')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), value); };
  fs.cpSync(runtime, path.join(root, 'runtime'), { recursive: true, filter: file => !file.endsWith('.test.mjs') && !/\/\d{2}-evidence(?:\/|$)/.test(file) });
  write('runtime/acceptance-adapters.mjs', adapter);
  write('run.mjs', "import {main} from './runtime/runner.mjs';main().then(code=>process.exitCode=code).catch(e=>{console.error(e.stack);process.exitCode=1;});");
  write('fake-codex.mjs', worker); fs.chmodSync(path.join(root, 'fake-codex.mjs'), 0o755);
  write('fixture-config.json', JSON.stringify(config)); write('.gitignore', '.codex-plan-runner/\nnode_modules/\n');
  write('lib/feature.mjs', `export const state = "${config.broken ? 'BROKEN' : 'GOOD'}";\n`);
  write('tests/feature.test.ts', "assert.equal(authorizedRead(), true);\n");
  for (const id of ['01', '02']) for (const item of ['a', 'b']) write(`tests/acceptance/${id}/${item}.postgres.test.ts`, 'assert.equal(deniedWriteChanges(), 0);\n');
  const pkg = { required_gates: [{ id: 'npm', capability: 'npm-checks' }, { id: 'sql-a', capability: 'synthetic-postgres' }, { id: 'sql-b', capability: 'synthetic-postgres' }], criteria: [{ id: 'authorized-read', type: 'security', purpose: 'Authorized read uses scoped policy', gate_ids: ['npm'] }, { id: 'authorized-write', type: 'persistence', purpose: 'Authorized write persists', gate_ids: ['sql-a'] }, { id: 'denied-write', type: 'persistence', purpose: 'Denied write rolls back', gate_ids: ['sql-b'] }] };
  const manifest = { schema_version: 1, plan_id: 'acceptance-transcript', ready: true, source: 'plan/source.md', contract: 'plan/contract.md', worker_contract: 'plan/worker.md', recovery: { schema_version: 1, packages: { '01': { local_repair: config.localRepair !== false, recipes: [] }, '02': { local_repair: true, recipes: [] } } }, acceptance: { schema_version: 1, mode: 'strict', packages: { '01': pkg, '02': pkg } }, steps: ['01', '02'].map((id, i) => ({ id, title: `Synthetic ${id}`, manual: false, dependencies: i ? ['01'] : [], plan: `plan/${id}-plan.md`, validation: `receipts/${id}.json`, handoff: `receipts/${id}.md` })) };
  write('plan/manifest.json', JSON.stringify(manifest));
  // Both Site and portable runtimes must receive the exact fixture authority.
  write('plan/recovery-policy.json', JSON.stringify({ ...manifest.recovery, plan_id: manifest.plan_id }));
  for (const file of [manifest.source, manifest.contract, manifest.worker_contract, ...manifest.steps.map(s => s.plan)]) write(file, 'Required scoped reads, persisted authorized writes and denied-write rollback.');
  for (const args of [['init', '-q'], ['config', 'user.name', 'Synthetic'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic baseline']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  const run = (...extra) => spawnSync(process.execPath, [path.join(root, 'run.mjs'), 'start', '--repo', root, '--manifest', 'plan/manifest.json', ...(fs.existsSync(path.join(runtime, 'site-recovery-policy.v1.json')) ? ['--recovery-policy', 'plan/recovery-policy.json'] : []), '--codex-bin', path.join(root, 'fake-codex.mjs'), '--step', '01', '--progress-seconds', '0', '--max-no-progress', '2', ...extra], { cwd: root, env: { ...process.env, CODEX_HOME: path.join(root,'fake-auth'), CODEX_PLAN_WORKER: '', CODEX_RECOVERY_SUPERVISOR: '' }, encoding: 'utf8', timeout: 90000 });
  const state = () => JSON.parse(fs.readFileSync(path.join(root, '.codex-plan-runner/acceptance-transcript/state.json')));
  const calls = () => fs.readFileSync(path.join(root, '.codex-plan-runner/calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { root, write, run, state, calls };
}

test('strict parent lifecycle runs multiple npm/SQL gates, repairs source, refreshes evidence, independently reviews and skips accepted work', t => {
  const f = fixture(t, { broken: true, malformedReview: true, repairMapping: true });
  const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = f.state(), entry = state.steps['01'];
  assert.equal(entry.status, 'completed'); assert.equal(entry.recovery.protocol_retry_count, 1); assert.equal(entry.recovery.repair_count, 1);
  assert.equal(entry.acceptance.refresh_count, 1);
  assert.equal(entry.acceptance.history.filter(item => item.refresh_generation).length, 3);
  assert.ok(entry.acceptance.history.some(item => item.reason === 'stale-reviewed-mapping')); assert.equal(Object.keys(entry.acceptance.gates).length, 3);
  assert.ok(entry.acceptance.history.some(record => record.file && record.passed === false));
  for (const gate of [...Object.values(entry.acceptance.gates), ...entry.acceptance.history.filter(record => record.file)]) {
    assert.equal(typeof gate.journal_snapshot_file, 'string', 'all terminal gate histories retain sealed cleanup ownership');
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(f.root, gate.journal_snapshot_file))).digest('hex'), gate.journal_snapshot_sha256);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, gate.journal_snapshot_file))), JSON.parse(fs.readFileSync(path.join(f.root, gate.journal_file))));
  }
  assert.ok(entry.acceptance.reviews.some(item => item.stage === 'evidence' && item.verdict === 'accepted'));
  const calls = f.calls(), reviews = calls.filter(call => call.role === 'acceptance-reviewer');
  assert.equal(reviews[0].thread, reviews[1].thread); assert.match(reviews[1].prompt, /PROTOCOL_CORRECTION_REQUIRED/);
  assert.ok(reviews.every(call => call.args[call.args.indexOf('--sandbox') + 1] === 'read-only'));
  assert.notEqual(reviews[1].thread, reviews.at(-1).thread);
  const workers = calls.filter(call => call.role === 'worker'); assert.equal(workers.length, 2); assert.equal(workers[0].thread, workers[1].thread);
  assert.match(workers[1].prompt, /denied-write-rollback/);
  const again = f.run(); assert.equal(again.status, 0, again.stderr); assert.equal(f.calls().length, calls.length); assert.match(again.stdout, /Skipping completed package 01/);
});

test('missing mappings and omitted criteria cannot be satisfied by a misleading completed receipt', t => {
  for (const config of [{ omitMapping: true }, { omitCriterion: true }]) {
    const f = fixture(t, config), result = f.run(); assert.notEqual(result.status, 0);
    assert.notEqual(f.state().steps['01'].status, 'completed'); assert.ok(!fs.existsSync(path.join(f.root, '.codex-plan-runner/gate-calls.jsonl')));
  }
});

test('independent review rejection blocks parent commands and preserves bounded no-progress', t => {
  const f = fixture(t, { rejectReview: true }), result = f.run(); assert.notEqual(result.status, 0);
  assert.notEqual(f.state().steps['01'].status, 'completed'); assert.ok(!fs.existsSync(path.join(f.root, '.codex-plan-runner/gate-calls.jsonl')));
  assert.ok(f.state().steps['01'].recovery.no_progress_count >= 2);
});

test('accepted parent evidence tampering fails closed on restart without rerunning the predecessor', t => {
  const f = fixture(t), first = f.run(); assert.equal(first.status, 0, first.stdout + first.stderr);
  const state = f.state(), count = f.calls().length, artifact = state.steps['01'].acceptance.gates['sql-a'];
  fs.appendFileSync(path.join(f.root, artifact.file), '\n');
  const second = f.run(); assert.notEqual(second.status, 0); assert.match(second.stderr, /acceptance evidence\/review was modified/); assert.equal(f.calls().length, count);
});


test('completed parent acceptance retains nested report hashes without repeating predecessor work', t => {
  const f = fixture(t), first = f.run(); assert.equal(first.status, 0, first.stdout + first.stderr);
  const entry = f.state().steps['01'], count = f.calls().length;
  const evidence = JSON.parse(fs.readFileSync(path.join(f.root, entry.acceptance.gates['sql-a'].file)));
  fs.appendFileSync(path.join(f.root, evidence.artifacts[0].file), '\n');
  const second = f.run(); assert.notEqual(second.status, 0); assert.match(second.stderr, /evidence artifact changed/); assert.equal(f.calls().length, count);
});


test('refresh generations retain their finite budget across restart and explicit increase', t => {
  const f = fixture(t, { broken: true, repairsBeforePass: 3 });
  const first = f.run(); assert.notEqual(first.status, 0);
  let entry = f.state().steps['01']; assert.equal(entry.acceptance.refresh_count, 2);
  assert.equal(entry.recovery.budget_kind, 'acceptance-evidence');
  const count = f.calls().length, workers = f.calls().filter(call => call.role === 'worker').length;
  const receipt = fs.readFileSync(path.join(f.root, 'receipts/01.json'), 'utf8'), finalAttempt = entry.last_attempt.attempt_id;
  const restart = f.run(); assert.notEqual(restart.status, 0); assert.equal(f.calls().length, count);
  assert.equal(f.state().steps['01'].acceptance.refresh_count, 2);
  const increased = f.run('--max-evidence-refreshes', '3'); assert.equal(increased.status, 0, increased.stdout + increased.stderr);
  entry = f.state().steps['01']; assert.equal(entry.status, 'completed'); assert.equal(entry.acceptance.refresh_count, 3);
  assert.equal(entry.acceptance.history.filter(item => item.refresh_generation).length, 9);
  assert.equal(f.calls().filter(call => call.role === 'worker').length, workers);
  assert.equal(entry.last_attempt.attempt_id, finalAttempt);
  assert.equal(fs.readFileSync(path.join(f.root, 'receipts/01.json'), 'utf8'), receipt);
});


test('verified-clean host timeout retries autonomously without repeating its worker or passed gates', t => {
  const f = fixture(t, { timeoutAttempts: 1 }), result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
  const entry = f.state().steps['01']; assert.equal(entry.acceptance.timeout_retry_count, 1); assert.equal(entry.acceptance.refresh_count, 0);
  assert.equal(f.calls().filter(call => call.role === 'worker').length, 1);
  const gates = fs.readFileSync(path.join(f.root, '.codex-plan-runner/gate-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(gates.filter(gate => gate.gate === 'npm').length, 1); assert.equal(gates.filter(gate => gate.gate === 'sql-a').length, 1); assert.equal(gates.filter(gate => gate.gate === 'sql-b').length, 2);
  assert.ok(fs.existsSync(path.join(f.root, '.codex-plan-runner/reconciled.jsonl')));
  assert.equal(entry.acceptance.history.filter(item => item.reason === 'verified-owned-host-timeout').length, 1);
});

test('host timeout exhaustion persists and increasing its budget resumes without a new worker', t => {
  const f = fixture(t, { timeoutAttempts: 3 }), first = f.run(); assert.notEqual(first.status, 0);
  let entry = f.state().steps['01']; assert.equal(entry.acceptance.timeout_retry_count, 2); assert.equal(entry.recovery.budget_kind, 'acceptance-timeout');
  const count = f.calls().length, attempt = entry.last_attempt.attempt_id;
  const restart = f.run(); assert.notEqual(restart.status, 0); assert.equal(f.calls().length, count);
  const increase = f.run('--max-evidence-refreshes', '3'); assert.equal(increase.status, 0, increase.stdout + increase.stderr);
  entry = f.state().steps['01']; assert.equal(entry.acceptance.timeout_retry_count, 3); assert.equal(entry.acceptance.refresh_count, 0);
  assert.equal(entry.last_attempt.attempt_id, attempt); assert.equal(f.calls().filter(call => call.role === 'worker').length, 1);
});

test('unknown timeout cleanup stays blocked and cannot authorize a retry', t => {
  const f = fixture(t, { timeoutAttempts: 1, unknownCleanup: true }), result = f.run(); assert.notEqual(result.status, 0);
  const entry = f.state().steps['01']; assert.notEqual(entry.status, 'completed'); assert.match(entry.recovery.terminal_blocker, /cleanup remains unverified/);
  assert.equal(entry.acceptance.timeout_retry_count, 0); assert.ok(!fs.existsSync(path.join(f.root, '.codex-plan-runner/reconciled.jsonl')));
});

test('transport backoff stores a short reviewer delay without rerunning passed gates', t => {
  const f = fixture(t, { reviewerFailureKind: 'transport' });
  // A zero transport retry budget records the first failure and exits before waiting.
  const result = f.run('--max-transport-retries', '0');
  assert.equal(result.status, 75, result.stdout + result.stderr);
  const entry = f.state().steps['01'], actor = entry.acceptance.review_actor;
  const delay = Date.parse(actor.retry_at) - Date.parse(actor.last_attempt.finished_at);
  assert.ok(delay >= 10000 && delay < 15000, `Expected a 10-second transport base plus jitter: ${delay}`);
  assert.equal(entry.retry_at, actor.retry_at);
  assert.equal(entry.recovery.transport_count, 1);
  assert.equal(entry.rate_limit_count, 0);
  assert.equal(entry.recovery.repair_count, 0);
  assert.ok(Object.values(entry.acceptance.gates).every(gate => gate.passed));
  assert.equal(f.calls().filter(call => call.role === 'worker').length, 1);
  assert.equal(f.calls().filter(call => call.role === 'acceptance-reviewer').length, 2);
  assert.equal(fs.readFileSync(path.join(f.root, '.codex-plan-runner/gate-calls.jsonl'), 'utf8').trim().split('\n').length, 3);
});

for (const localRepair of [true, false]) for (const kind of ['rate-limit', 'transport']) test(`acceptance reviewer ${kind} exhaustion retains cooldown and increased budget resumes the same review with local repair ${localRepair}`, t => {
  const f = fixture(t, { localRepair, reviewerFailureKind: kind, reviewerFailures: 2, reviewerRetryAfterMs: 1200 });
  const flag = kind === 'rate-limit' ? '--max-rate-retries' : '--max-transport-retries';
  const delays = ['--retry-delay-seconds', '0.01', '--max-delay-seconds', '0.01'];
  const first = f.run(flag, '1', ...delays); assert.equal(first.status, 75, first.stdout + first.stderr);
  let entry = f.state().steps['01'];
  assert.equal(entry.recovery.phase, 'needs-attention'); assert.ok(!entry.recovery.terminal_blocker);
  assert.match(entry.recovery.budget_reason, /Acceptance reviewer .* retry budget exhausted/);
  const cooldown = entry.acceptance.review_actor.retry_at, deadline = Date.parse(cooldown), count = f.calls().length;
  assert.ok(Number.isFinite(deadline) && deadline > Date.now(), 'exhausted reviewer must preserve its final provider cooldown');
  const previousReview = f.calls().at(-1), attempt = entry.last_attempt.attempt_id;
  assert.ok(deadline >= previousReview.at + 1200, 'Retry-After must not be shortened');
  const receipt = fs.readFileSync(path.join(f.root, 'receipts/01.json'), 'utf8');
  const gates = fs.readFileSync(path.join(f.root, '.codex-plan-runner/gate-calls.jsonl'), 'utf8');
  const restart = f.run(flag, '1', ...delays); assert.equal(restart.status, 75, restart.stdout + restart.stderr);
  assert.equal(f.calls().length, count); assert.equal(f.state().steps['01'].acceptance.review_actor.retry_at, cooldown);
  const increase = f.run(flag, '2', ...delays); assert.equal(increase.status, 0, increase.stdout + increase.stderr);
  entry = f.state().steps['01']; assert.equal(entry.status, 'completed');
  assert.equal(kind === 'rate-limit' ? entry.rate_limit_count : entry.recovery.transport_count, 2);
  assert.equal(entry.recovery.repair_count, 0); assert.equal(entry.recovery.protocol_retry_count, 0);
  assert.equal(f.calls().length, count + 1); assert.equal(f.calls().at(-1).thread, previousReview.thread);
  assert.ok(f.calls().at(-1).at >= deadline, 'resumed reviewer must wait for the saved provider cooldown');
  assert.equal(entry.last_attempt.attempt_id, attempt); assert.equal(f.calls().filter(call => call.role === 'worker').length, 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'receipts/01.json'), 'utf8'), receipt);
  assert.equal(fs.readFileSync(path.join(f.root, '.codex-plan-runner/gate-calls.jsonl'), 'utf8'), gates);
});

for (const localRepair of [true, false]) test(`genuine acceptance reviewer authentication failure stays terminal when retry budgets increase with local repair ${localRepair}`, t => {
  const f = fixture(t, { localRepair, reviewerFailureKind: 'authentication' }), first = f.run(); assert.equal(first.status, 2, first.stdout + first.stderr);
  const entry = f.state().steps['01'], count = f.calls().length;
  assert.match(entry.recovery.terminal_blocker, /Acceptance reviewer authentication/);
  assert.equal(entry.rate_limit_count, 0); assert.equal(entry.recovery.transport_count, 0);
  const increased = f.run('--max-rate-retries', '20', '--max-transport-retries', '20'); assert.equal(increased.status, 2);
  assert.equal(f.calls().length, count); assert.notEqual(f.state().steps['01'].status, 'completed');
});


for (const mutation of ['source', 'mapping']) test(`reviewer cooldown survives ${mutation} binding change before any new worker or reviewer`, t => {
  const f = fixture(t, { localRepair: false, retainMapping: true, reviewerFailureKind: 'rate-limit', reviewerFailures: 2, reviewerRetryAfterMs: 1600 });
  const delays = ['--retry-delay-seconds', '0.01', '--max-delay-seconds', '0.01'];
  const first = f.run('--max-rate-retries', '1', ...delays); assert.equal(first.status, 75, first.stdout + first.stderr);
  const before = f.state().steps['01'], count = f.calls().length, oldReview = f.calls().at(-1);
  const deadline = Date.parse(before.acceptance.review_actor.retry_at);
  assert.equal(before.retry_at, before.acceptance.review_actor.retry_at);
  if (mutation === 'source') fs.appendFileSync(path.join(f.root, 'lib/feature.mjs'), '// Changed implementation input during cooldown\n');
  else {
    const file = path.join(f.root, 'plan/01-acceptance-mapping.json'), mapping = JSON.parse(fs.readFileSync(file));
    mapping.gates[2].cases = ['denied write rolls back on changed binding'];
    mapping.criteria[2].test_ids = mapping.gates[2].cases;
    fs.writeFileSync(file, JSON.stringify(mapping));
  }
  // Exercise backward compatibility with saved actor-only deadlines too.
  const stateFile = path.join(f.root, '.codex-plan-runner/acceptance-transcript/state.json'), saved = f.state();
  delete saved.steps['01'].retry_at; fs.writeFileSync(stateFile, JSON.stringify(saved));
  assert.ok(deadline > Date.now(), 'binding-change resume must exercise an unexpired provider cooldown');
  const resumed = f.run('--max-rate-retries', '2', ...delays); assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const after = f.state().steps['01'], nextCalls = f.calls().slice(count);
  assert.equal(after.status, 'completed'); assert.equal(after.rate_limit_count, 2);
  assert.equal(after.recovery.repair_count, 0); assert.equal(after.recovery.protocol_retry_count, 0);
  assert.ok(nextCalls.length > 1); assert.ok(nextCalls.every(call => call.at >= deadline), 'no actor may run before the inherited provider cooldown');
  assert.equal(nextCalls[0].role, 'worker'); assert.notEqual(after.last_attempt.attempt_id, before.last_attempt.attempt_id);
  assert.equal(f.calls().filter(call => call.role === 'supervisor').length, 0);
  const newReview = nextCalls.find(call => call.role === 'acceptance-reviewer');
  assert.notEqual(newReview.thread, oldReview.thread); assert.notEqual(newReview.prompt.match(/^BINDING_SHA256: (.+)$/m)[1], oldReview.prompt.match(/^BINDING_SHA256: (.+)$/m)[1]);
  assert.ok(after.acceptance.refresh_count > 0, 'changed source/mapping must refresh acceptance evidence');
});

test('strict acceptance failure without local repair never launches a source repair supervisor', t => {
  const f = fixture(t, { localRepair: false, broken: true }), result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(f.calls().filter(call => call.role === 'supervisor').length, 0);
  assert.equal(f.state().steps['01'].recovery.repair_count, 0);
  assert.notEqual(f.state().steps['01'].status, 'completed');
});


test('one launch subdivides TPM work then a fresh finalizer repairs and satisfies original strict acceptance', t => {
  const f=fixture(t,{strictSubdivision:true,broken:true,malformedReview:true,repairMapping:true});
  const result=f.run('--retry-delay-seconds','0.01','--max-delay-seconds','0.01');
  assert.equal(result.status,0,result.stdout+result.stderr);
  const saved=f.state(),entry=saved.steps['01'],recovery=entry.recovery,split=recovery.subdivision,calls=f.calls();
  const workers=calls.filter(call=>call.role==='worker'),planners=calls.filter(call=>call.role==='planner'),subtasks=calls.filter(call=>call.role==='subtask'),finalizers=calls.filter(call=>call.role==='finalizer'),supervisors=calls.filter(call=>call.role==='supervisor'),reviewers=calls.filter(call=>call.role==='acceptance-reviewer');
  assert.equal(workers.length,1);assert.equal(planners.length,1);assert.equal(subtasks.length,2);assert.equal(finalizers.length,3);assert.equal(supervisors.length,1);
  assert.deepEqual(calls.slice(0,5).map(call=>call.role),['worker','planner','subtask','subtask','finalizer']);
  assert.equal(new Set([workers[0].thread,planners[0].thread,...subtasks.map(call=>call.thread),finalizers[0].thread]).size,5);
  assert.ok(finalizers.every(call=>call.thread===finalizers[0].thread));
  assert.match(finalizers[1].prompt,/PROTOCOL_CORRECTION_REQUIRED/);
  assert.match(finalizers[2].prompt,/denied-write-rollback/);
  assert.match(finalizers[0].prompt,/checkpoint/i);assert.match(finalizers[0].prompt,/original.*acceptance/i);
  assert.ok(planners[0].at>=workers[0].at+30,'Fresh planner honors the explicit provider cooldown');
  assert.equal(recovery.subdivision.count,1);assert.equal(split.next_task,2);assert.ok(split.tasks.every(task=>task.accepted));
  for(const task of split.tasks){const bytes=fs.readFileSync(path.join(f.root,task.accepted.file));assert.equal(createHash('sha256').update(bytes).digest('hex'),task.accepted.sha256);const checkpoint=JSON.parse(bytes);assert.equal(checkpoint.checks.length,1);assert.equal(checkpoint.checks[0].passed,true);assert.equal(checkpoint.checks[0].exit_code,0);}
  assert.equal(entry.rate_limit_count,1);assert.equal(recovery.protocol_retry_count,2);assert.equal(recovery.repair_count,1);assert.equal(entry.acceptance.refresh_count,1);
  assert.equal(entry.status,'completed');assert.equal(recovery.phase,'completed');
  assert.ok(Object.values(entry.acceptance.gates).every(gate=>gate.passed));
  assert.equal(Object.keys(entry.acceptance.gates).length,3);
  assert.ok(entry.acceptance.history.some(item=>item.reason==='stale-reviewed-mapping'));
  assert.equal(entry.acceptance.history.filter(item=>item.refresh_generation).length,3);
  const gateCalls=fs.readFileSync(path.join(f.root,'.codex-plan-runner/gate-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  for(const id of ['npm','sql-a','sql-b'])assert.equal(gateCalls.filter(call=>call.gate===id).length,2,'Initial and refreshed required gate '+id);
  assert.ok(reviewers.every(call=>call.args[call.args.indexOf('--sandbox')+1]==='read-only'));
  assert.equal(reviewers[0].thread,reviewers[1].thread);assert.match(reviewers[1].prompt,/PROTOCOL_CORRECTION_REQUIRED/);
  assert.notEqual(reviewers.at(-1).thread,reviewers[1].thread);
  assert.equal(entry.acceptance.reviews.at(-1).stage,'evidence');assert.equal(entry.acceptance.reviews.at(-1).verdict,'accepted');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'receipts/01.json'))).attempt_id,finalizers.at(-1).attempt);
  assert.equal(saved.steps['02'],undefined,'Selected range never starts the successor');
  const stateBytes=fs.readFileSync(path.join(f.root,'.codex-plan-runner/acceptance-transcript/state.json')),checkpointBytes=split.tasks.map(task=>fs.readFileSync(path.join(f.root,task.accepted.file)));
  const again=f.run();assert.equal(again.status,0,again.stdout+again.stderr);assert.equal(f.calls().length,calls.length);assert.match(again.stdout,/Skipping completed package 01/);
  split.tasks.forEach((task,index)=>assert.deepEqual(fs.readFileSync(path.join(f.root,task.accepted.file)),checkpointBytes[index]));
  assert.deepEqual(f.state().steps['01'],entry);assert.ok(stateBytes.length>0);
});
