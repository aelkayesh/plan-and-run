import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const runtime=path.dirname(fileURLToPath(import.meta.url));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const worker=String.raw`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
if(process.argv.includes('login')){
 const config=JSON.parse(fs.readFileSync('fixture.json'));
 if(config.authDelayMs)await new Promise(resolve=>setTimeout(resolve,config.authDelayMs));
 console.log('Logged in using ChatGPT');process.exit(0);
}
let prompt='';process.stdin.on('data',v=>prompt+=v);process.stdin.on('end',async()=>{
 const config=JSON.parse(fs.readFileSync('fixture.json')),id=prompt.match(/^PACKAGE_ID: (.+)$/m)[1],attempt=prompt.match(/^ATTEMPT_ID: (.+)$/m)[1];
 const manifest=JSON.parse(fs.readFileSync('plan/manifest.json'));
 if(process.env.CODEX_PLAN_ROLE==='acceptance-reviewer'){const value={schema_version:1,package_id:id,attempt_id:attempt,stage:prompt.match(/^STAGE: (.+)$/m)[1],binding_sha256:prompt.match(/^BINDING_SHA256: (.+)$/m)[1],verdict:'accepted',criteria:manifest.acceptance.packages[id].criteria.map(c=>({id:c.id,satisfied:true,reason:'Synthetic reviewer for lifecycle fixture.'})),blockers:[]};fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify(value));console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000099'}));console.log(JSON.stringify({type:'turn.completed'}));return;}
 if(config.acceptanceHang)fs.writeFileSync('plan/'+id+'-acceptance-mapping.json',JSON.stringify({schema_version:1,package_id:id,gates:[{gate_id:'npm',files:['tests/required.test.ts'],cases:['required passes','npm-test','npm-check']}],criteria:[{criterion_id:'required',gate_id:'npm',test_ids:['required passes']}]}));
 const calls='.codex-plan-runner/calls.jsonl',prior=fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n'):[];
 fs.appendFileSync(calls,JSON.stringify({id,attempt,pid:process.pid,at:Date.now()})+'\n');
 console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000001'}));
 if(config.authFailure){console.log(JSON.stringify({type:'turn.failed',error:{message:'Authentication failed: '+config.authFailure,status_code:401}}));process.exitCode=1;return;}
 if(config.hang){setInterval(()=>{},1000);return;}
 if(config.rate&&!prior.length){console.log(JSON.stringify({type:'turn.failed',error:{message:'Rate limit exceeded',retry_after_ms:1200}}));process.exitCode=1;return;}
 await new Promise(r=>setTimeout(r,config.delay||50));
 const step=JSON.parse(fs.readFileSync('plan/manifest.json')).steps.find(x=>x.id===id);
 execFileSync(process.execPath,['--check','fake.mjs']);
 const receipt={schema_version:1,package_id:id,attempt_id:attempt,status:'completed',source:{head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),branch:'fixture',dirty:true},changed_files:[],checks:[{command:'node --check fake.mjs',exit_code:0,passed:true}],fixtures:[],blockers:[]};
 fs.writeFileSync(step.validation,JSON.stringify(receipt));fs.writeFileSync(step.handoff,'Actual local syntax check; fake execution only.');
 const result={schema_version:1,package_id:id,attempt_id:attempt,status:'completed',summary:'Synthetic checked package',validation_file:step.validation,handoff_file:step.handoff,blockers:[]};
 const out=process.argv[process.argv.indexOf('--output-last-message')+1];fs.writeFileSync(out,JSON.stringify(result));console.log(JSON.stringify({type:'turn.completed'}));
});`;
function fixture(t,{ids=['01'],manual=[],config={},strict=false}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'owned unattended integration ')));
 const write=(file,text)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);};
 fs.mkdirSync(path.join(root,'runtime'));for(const name of fs.readdirSync(runtime))if(/\.(mjs|json)$/.test(name)&&!name.endsWith('.test.mjs'))fs.copyFileSync(path.join(runtime,name),path.join(root,'runtime',name));
 if(fs.existsSync(path.join(runtime,'acceptance-fixtures.md')))fs.copyFileSync(path.join(runtime,'acceptance-fixtures.md'),path.join(root,'runtime/acceptance-fixtures.md'));
 write('run.mjs',"import {main} from './runtime/runner.mjs';main().then(c=>process.exitCode=c).catch(e=>{console.error(e.message);process.exitCode=1});");
 write('fake.mjs',worker);fs.chmodSync(path.join(root,'fake.mjs'),0o755);
 write('fixture.json',JSON.stringify(config));write('.gitignore','.codex-plan-runner/\nnode_modules/\n');write('user.txt','Preserve me');
 const manifest={schema_version:1,plan_id:'unattended-fixture',ready:true,source:'plan/source.md',contract:'plan/contract.md',worker_contract:'plan/worker.md',steps:ids.map((id,i)=>({id,title:'Synthetic '+id,manual:manual.includes(id),dependencies:i?[ids[i-1]]:[],plan:`plan/${id}.md`,validation:`plan/${id}-validation.json`,handoff:`plan/${id}-handoff.md`}))};
 if(strict)manifest.acceptance={schema_version:1,mode:'strict',packages:{[ids.at(-1)]:{required_gates:[{id:'browser',capability:'loopback-browser'}],criteria:[{id:'visible',type:'ui',purpose:'Visible synthetic state is asserted',gate_ids:['browser']}]}}};
 if(config.acceptanceHang) {
  manifest.acceptance={schema_version:1,mode:'strict',packages:{'01':{required_gates:[{id:'npm',capability:'npm-checks'}],criteria:[{id:'required',type:'behavior',purpose:'The synthetic assertion executes in the owned acceptance helper',gate_ids:['npm']}]}}};
  write('package.json',JSON.stringify({scripts:{test:'vitest run',check:'tsc --noEmit'}}));
  write('tests/required.test.ts','assert.equal(1+1,2);');
  write('node_modules/vitest/vitest.mjs',"import fs from 'node:fs';import path from 'node:path';const out=process.argv[process.argv.indexOf('--json')+1];fs.writeFileSync(out,JSON.stringify([{name:'required passes',file:path.join(process.cwd(),'tests/required.test.ts')}]));");
  write('node_modules/typescript/bin/tsc','// synthetic installed checker');
  write('bin/npm',"#!/usr/bin/env node\nif(process.argv[2]==='test')setInterval(()=>{},1000);\n");fs.chmodSync(path.join(root,'bin/npm'),0o755);
 }
 for(const name of [manifest.source,manifest.contract,manifest.worker_contract,...manifest.steps.map(s=>s.plan)])write(name,'Synthetic frozen contract.');
 write('plan/manifest.json',JSON.stringify(manifest));
 for(const args of [['init','-q'],['config','user.name','Synthetic'],['config','user.email','synthetic@example.invalid'],['add','.'],['-c','commit.gpgSign=false','-c','core.hooksPath=/dev/null','commit','-qm','fixture']])assert.equal(spawnSync('git',args,{cwd:root}).status,0);
 const env={...process.env,CODEX_PLAN_WORKER:'0',CODEX_RECOVERY_SUPERVISOR:'0',CODEX_HOME:path.join(root,'fake-auth'),PATH:path.join(root,'bin')+path.delimiter+process.env.PATH};
 const argv=(command,extra=[])=>[path.join(root,'run.mjs'),command,'--repo',root,'--manifest','plan/manifest.json','--codex-bin',path.join(root,'fake.mjs'),'--progress-seconds','0','--retry-delay-seconds','0.01','--max-delay-seconds','0.05',...extra];
 const cli=(command,...extra)=>spawnSync(process.execPath,argv(command,extra),{cwd:os.tmpdir(),env,encoding:'utf8',timeout:25000});
 const stateDir=path.join(root,'.codex-plan-runner/unattended-fixture');
 const sessions=()=>fs.existsSync(path.join(stateDir,'background'))?fs.readdirSync(path.join(stateDir,'background')).map(id=>path.join(stateDir,'background',id,'session.json')):[];
 const calls=()=>fs.existsSync(path.join(root,'.codex-plan-runner/calls.jsonl'))?fs.readFileSync(path.join(root,'.codex-plan-runner/calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[];
 const failedCleanupProofs=new Map();
 const cleanup=async()=>{
  if(!fs.existsSync(root))return;
  for(const file of sessions()){
   const session=JSON.parse(fs.readFileSync(file)),resultFile=path.join(path.dirname(file),'result.json');
   const result=fs.existsSync(resultFile)?JSON.parse(fs.readFileSync(resultFile)):null;
   if(result?.cleanup_verified===false&&failedCleanupProofs.has(session.id)){
    // A negative runtime cleanup result stays false. The test must separately
    // reconcile its intentionally corrupted fixture and prove all resources absent.
    await failedCleanupProofs.get(session.id)();
    await absent(session.pid,root);
    const wake=JSON.parse(fs.readFileSync(path.join(path.dirname(file),'wake.json')));
    assert.equal(wake.cleanup_verified,true,`Wake cleanup unresolved; fixture retained: ${root}`);
    if(wake.pid)await absent(wake.pid,root);
   }else{
    const stopped=cli('stop','--session',session.id,'--json');
    assert.equal(stopped.status,0,`Owned fixture retained because cleanup is unresolved: ${root}\n${stopped.stdout}\n${stopped.stderr}`);
    const proof=JSON.parse(stopped.stdout);assert.equal(proof.cleanup_verified,true);assert.equal(proof.leader_exit_verified,true);
   }
  }
  fs.rmSync(root,{recursive:true,force:true});
 };
 t.after(cleanup);
 return {root,write,cli,argv,env,stateDir,sessions,calls,cleanup,allowFailedCleanup:(id,proof)=>failedCleanupProofs.set(id,proof)};
}
async function absent(pid,root){await until(()=>{try{process.kill(pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}},10000).catch(error=>{throw new Error(`Owned child exit unverified; fixture retained: ${root}`,{cause:error});});}
async function until(fn,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const v=fn();if(v)return v;await delay(30);}throw Error('Timed out waiting for durable lifecycle observation');}
async function final(f,id){const file=path.join(f.stateDir,'background',id,'result.json');return until(()=>fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)));}
const parsed=result=>{assert.equal(result.status,0,result.stdout+result.stderr);return JSON.parse(result.stdout);};

test('launch closes all launcher stdio, owns plan lock, completes later and redacts durable status/log surfaces',async t=>{
 const f=fixture(t,{config:{delay:350}});
 const child=spawn(process.execPath,f.argv('launch',['--json','--max-repair-retries','7','--max-rate-retries','9','--max-transport-retries','11','--max-protocol-retries','5','--max-evidence-refreshes','6','--max-no-progress','4']),{cwd:os.tmpdir(),env:f.env,stdio:'ignore'});
 assert.equal(await new Promise(resolve=>child.on('exit',resolve)),0);
 const file=f.sessions()[0],s=JSON.parse(fs.readFileSync(file));
 const result=await final(f,s.id);assert.equal(result.accepted,true);assert.equal(result.cleanup_verified,true);assert.equal(result.summary.criteria.required,0);
 assert.equal(f.calls().length,1);assert.equal(fs.existsSync(path.join(f.stateDir,'runner.lock')),false);
 const status=parsed(f.cli('status','--json'));assert.equal(status.accepted,true);assert.equal(status.background.id,s.id);assert.equal(status.packages[0].budgets.repair.limit,7);assert.doesNotMatch(JSON.stringify(status),new RegExp(s.owner));
 const human=f.cli('status');assert.equal(human.status,0,human.stderr);
 assert.match(human.stdout,/budgets: rate=0\/9; transport=0\/11; repair=0\/7; protocol=0\/5; evidence=0\/6/);
 assert.match(human.stdout,/no-progress=0\/4/);
 assert.equal(f.cli('logs').status,0);assert.equal(fs.readFileSync(path.join(f.root,'user.txt'),'utf8'),'Preserve me');
});
test('launch waits for verified child readiness beyond fifteen seconds without starting another worker',async t=>{
 const f=fixture(t,{config:{authDelayMs:8250,delay:100}});
 // Each local authentication probe remains below its own ten-second limit.
 // The child's independent and locked preflights together exceed fifteen seconds.
 const command=spawnSync(process.execPath,f.argv('launch',['--json']),{cwd:os.tmpdir(),env:f.env,encoding:'utf8',timeout:60000});
 const launched=parsed(command);
 assert.equal(launched.launched,true);
 assert.ok(launched.ready_at);
 assert.ok(Date.parse(launched.ready_at)-Date.parse(launched.created_at)>15000);
 assert.equal(f.sessions().length,1);
 const result=await final(f,launched.id);
 assert.equal(result.accepted,true);assert.equal(result.cleanup_verified,true);assert.equal(result.exit_code,0);
 assert.equal(f.calls().length,1);
 assert.equal(fs.existsSync(path.join(f.stateDir,'runner.lock')),false);
 assert.equal(fs.readFileSync(path.join(f.root,'user.txt'),'utf8'),'Preserve me');
});
test('actual needs-attention report redacts reason and recovery while preserving raw internal state',async t=>{
 const secret='synthetic-report-password-928374',uri=`postgresql://fixture:${secret}@localhost/database`;
 const f=fixture(t,{config:{authFailure:uri}}),launch=parsed(f.cli('launch','--json'));
 const result=await final(f,launch.id);assert.equal(result.accepted,false);assert.equal(result.cleanup_verified,true);assert.equal(result.exit_code,1);
 const stateFile=path.join(f.stateDir,'state.json'),state=JSON.parse(fs.readFileSync(stateFile)),reportFile=path.join(f.stateDir,'needs-attention.json'),report=JSON.parse(fs.readFileSync(reportFile));
 assert.ok(state.steps['01'].recovery.terminal_blocker.includes(uri),'Internal recovery evidence remains unchanged.');
 assert.equal(report.package_id,'01');assert.equal(report.phase,'needs-attention');assert.ok(report.recovery.terminal_blocker.includes('[redacted]'));
 const privateSession=fs.readFileSync(f.sessions()[0]),stateBytes=fs.readFileSync(stateFile);
 const human=f.cli('status'),json=parsed(f.cli('status','--json'));assert.equal(human.status,0,human.stderr);assert.equal(json.attention_report.classification,'current');
 for(const text of [JSON.stringify(report),JSON.stringify(result),fs.readFileSync(path.join(path.dirname(f.sessions()[0]),'result.txt'),'utf8'),human.stdout,JSON.stringify(json)])assert.equal(text.includes(secret),false);
 assert.deepEqual(fs.readFileSync(stateFile),stateBytes);assert.deepEqual(fs.readFileSync(f.sessions()[0]),privateSession);
});
test('duplicate background launch and foreground conflict create exactly one worker; owned stop preserves interruption then resume completes',async t=>{
 const f=fixture(t,{config:{hang:true}});const launched=parsed(f.cli('launch','--json'));await until(()=>f.calls().length===1);
 const duplicate=f.cli('launch','--json');assert.notEqual(duplicate.status,0);const foreground=f.cli('start');assert.notEqual(foreground.status,0);assert.equal(f.calls().length,1);
 const stopped=parsed(f.cli('stop','--session',launched.id,'--json'));assert.equal(stopped.phase,'interrupted');assert.equal(stopped.cleanup_verified,true);
 const saved=JSON.parse(fs.readFileSync(path.join(f.stateDir,'state.json')));assert.equal(saved.steps['01'].status,'interrupted');
 f.write('fixture.json','{}');const resumed=parsed(f.cli('launch','--json'));assert.notEqual(resumed.id,launched.id);assert.equal((await final(f,resumed.id)).accepted,true);assert.equal(f.calls().length,2);
});
test('simultaneous launch contenders share the foreground lock',async t=>{
 const f=fixture(t,{config:{hang:true}});
 const run=()=>new Promise(resolve=>{const c=spawn(process.execPath,f.argv('launch',['--json']),{cwd:f.root,env:f.env});let output='';c.stdout.on('data',v=>output+=v);c.stderr.on('data',v=>output+=v);c.on('exit',code=>resolve({code,output}));});
 const outcomes=await Promise.all([run(),run()]);assert.equal(outcomes.filter(x=>x.code===0).length,1,JSON.stringify(outcomes));await until(()=>f.calls().length===1);
});
test('entire selected range checks later capabilities before any first worker and retains explicit report',t=>{
 const f=fixture(t,{ids:['01','02'],strict:true});const r=f.cli('launch','--json');assert.notEqual(r.status,0);assert.equal(f.calls().length,0);assert.equal(fs.existsSync(path.join(f.stateDir,'state.json')),false);
 const report=JSON.parse(r.stdout);assert.equal(report.ready,false);assert.deepEqual(report.selected,['01','02']);assert.ok(report.errors.some(e=>e.kind==='capability'&&e.required_by.some(x=>x.package_id==='02')));assert.ok(fs.existsSync(report.report_file));
});
test('missing outside-range dependency fails before worker; earlier selected dependency is allowed; manual range remains incomplete',async t=>{
 const f=fixture(t,{ids:['01','02','03'],manual:['03']});const blocked=f.cli('launch','--from','02','--json');assert.notEqual(blocked.status,0);assert.equal(f.calls().length,0);
 const launched=parsed(f.cli('launch','--json'));const result=await final(f,launched.id);assert.equal(result.accepted,false);assert.equal(result.exit_code,2);assert.deepEqual(result.summary.unfinished,['03']);assert.deepEqual(f.calls().map(c=>c.id),['01','02']);
 const before=JSON.parse(fs.readFileSync(path.join(f.stateDir,'state.json'))).steps['01'];const retry=parsed(f.cli('launch','--to','02','--json'));assert.equal((await final(f,retry.id)).accepted,true);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.stateDir,'state.json'))).steps['01'],before);assert.equal(f.calls().length,2);
});
test('stop during provider cooldown preserves durable retry deadline and counts on background resume',async t=>{
 const f=fixture(t,{config:{rate:true}});const launched=parsed(f.cli('launch','--json','--max-rate-retries','9'));
 const saved=await until(()=>{const p=path.join(f.stateDir,'state.json');if(!fs.existsSync(p))return false;const s=JSON.parse(fs.readFileSync(p));return s.steps['01']?.retry_at?s:false;});
 const deadline=saved.steps['01'].retry_at;parsed(f.cli('stop','--session',launched.id,'--json'));
 const after=JSON.parse(fs.readFileSync(path.join(f.stateDir,'state.json')));assert.equal(after.steps['01'].retry_at,deadline);assert.equal(after.steps['01'].rate_limit_count,1);
 const stoppedStatus=parsed(f.cli('status','--json'));assert.equal(stoppedStatus.packages[0].budgets.rate.used,1);assert.equal(stoppedStatus.packages[0].budgets.rate.limit,9);
 const human=f.cli('status');assert.equal(human.status,0,human.stderr);assert.match(human.stdout,/budgets: rate=1\/9;/);
 const again=parsed(f.cli('launch','--json'));assert.equal((await final(f,again.id)).accepted,true);assert.equal(f.calls().length,2);assert.ok(f.calls()[1].at>=Date.parse(deadline)-10);
});

test('owned stop aborts an actual separate acceptance helper group and verifies its journal/data cleanup',async t=>{
 const f=fixture(t,{config:{acceptanceHang:true}}),launch=parsed(f.cli('launch','--json'));
 const journal=await until(()=>{const file=path.join(f.stateDir,'state.json');if(!fs.existsSync(file))return false;const s=JSON.parse(fs.readFileSync(file)),rel=s.steps['01']?.acceptance?.gates?.npm?.journal_file;if(!rel)return false;const j=JSON.parse(fs.readFileSync(path.join(f.root,rel)));return j.active_check==='npm-test'?j:false;});
 assert.ok(journal.process.pid>1);assert.ok(fs.existsSync(journal.data_directory));
 const stopped=parsed(f.cli('stop','--session',launch.id,'--json'));assert.equal(stopped.cleanup_verified,true);assert.equal(stopped.accepted,false);assert.equal(fs.existsSync(journal.data_directory),false);
 assert.throws(()=>process.kill(-journal.process.pgid,0),e=>e.code==='ESRCH');
 const state=JSON.parse(fs.readFileSync(path.join(f.stateDir,'state.json')));assert.equal(state.steps['01'].status,'interrupted');
});

test('actual background cleanup bridge refuses unknown owned-data marker and preserves unresolved journal/resource',async t=>{
 const f=fixture(t,{config:{acceptanceHang:true}}),launch=parsed(f.cli('launch','--json'));
 const pending=await until(()=>{const file=path.join(f.stateDir,'state.json');if(!fs.existsSync(file))return false;const s=JSON.parse(fs.readFileSync(file)),rel=s.steps['01']?.acceptance?.gates?.npm?.journal_file;if(!rel)return false;const j=JSON.parse(fs.readFileSync(path.join(f.root,rel)));return j.active_check==='npm-test'?{j,file:path.join(f.root,rel)}:false;});
 const marker=path.join(pending.j.data_directory,'.owner.json'),original=fs.readFileSync(marker);
 fs.writeFileSync(marker,JSON.stringify({id:'unrecognized-owned-fixture'}));
 try {
  const stop=f.cli('stop','--session',launch.id,'--json');assert.notEqual(stop.status,0);
  const result=await final(f,launch.id);assert.equal(result.accepted,false);assert.equal(result.cleanup_verified,false);
  assert.ok(fs.existsSync(pending.j.data_directory));assert.ok(fs.existsSync(path.join(f.stateDir,'runner.lock')));
  assert.match(JSON.stringify(result),/cleanup|ownership|data/i);
 } finally {
  // The harness restores only its intentionally corrupted synthetic marker,
  // then uses the fixed owned-fixture reconciler. Runner reports remain false.
  fs.writeFileSync(marker,original);
  const adapter=await import(pathToFileURL(path.join(f.root,'runtime/acceptance-adapters.mjs')).href);
  const reconciled=await adapter.reconcileAcceptanceGate({root:f.root,journalFile:pending.file,packageId:'01',planHash:pending.j.plan_hash,gate:pending.j.gate});
  assert.equal(reconciled.cleanup_verified || reconciled.evidence?.cleanup_verified,true);
  assert.equal(fs.existsSync(pending.j.data_directory),false);
  f.allowFailedCleanup(launch.id,()=>{
   const retained=JSON.parse(fs.readFileSync(path.join(f.stateDir,'background',launch.id,'result.json')));
   assert.equal(retained.cleanup_verified,false);assert.equal(retained.accepted,false);
   assert.equal(fs.existsSync(pending.j.data_directory),false);
   assert.throws(()=>process.kill(-pending.j.process.pgid,0),error=>error.code==='ESRCH');
   assert.equal(JSON.parse(fs.readFileSync(pending.file)).cleanup_verified,true);
  });
 }
});


test('integration fixture teardown stops an unfinished background worker before removing ownership records',async t=>{
 const f=fixture(t,{config:{hang:true}}),launch=parsed(f.cli('launch','--json'));
 await until(()=>f.calls().length===1);
 const workerPid=f.calls()[0].pid;
 await f.cleanup();
 assert.equal(fs.existsSync(f.root),false);
 assert.throws(()=>process.kill(launch.pid,0),error=>error.code==='ESRCH');
 assert.throws(()=>process.kill(workerPid,0),error=>error.code==='ESRCH');
});
