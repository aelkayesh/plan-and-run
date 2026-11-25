import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {runAcceptanceGate,verifyAcceptanceGate,preflightAcceptanceCapabilities,acceptanceEnvironment,validateGateInputs,parseAcceptanceReport,verifyAcceptanceEvidenceArtifacts,reapOwnedAcceptanceGroup} from './acceptance-adapters.mjs';
const planHash='a'.repeat(64);
const packageId='06';
const gate={id:'npm',capability:'npm-checks'};
const mapping={gate_id:'npm',files:['tests/required.test.ts'],cases:['required passes','npm-test','npm-check']};
const fakeNpm=`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),config=JSON.parse(fs.readFileSync('fixture.json','utf8'));
if(config.hang){setInterval(()=>{},1000);}else if(args[0]==='test'){
 if(config.sourceMutation)fs.appendFileSync(config.sourceMutation,'// concurrent source edit');
 const file=args.find(x=>x.startsWith('--outputFile=')).slice('--outputFile='.length);
 const status=config.skipped?'pending':config.failed?'failed':'passed';
 fs.writeFileSync(file,JSON.stringify({success:!config.failed,numFailedTestSuites:config.failed?1:0,numTotalTests:1,numPassedTests:status==='passed'?1:0,numFailedTests:config.failed?1:0,numPendingTests:config.skipped?1:0,numTodoTests:0,testResults:[{name:path.join(process.cwd(),'tests/required.test.ts'),status:config.failed?'failed':'passed',assertionResults:[{fullName:'required passes',status,failureMessages:config.failed?['assertion required passes']:[]}]}]}));
 process.exitCode=config.failed?1:0;
}else if(args[0]==='run'&&args[1]==='check'){}else if(args[0]==='run'&&args[1]==='build'){
 fs.mkdirSync('.next',{recursive:true});for(const name of ['BUILD_ID','build-manifest.json','routes-manifest.json','prerender-manifest.json'])fs.writeFileSync('.next/'+name,'synthetic-build');
}else throw new Error('Unexpected fake npm command');
`;
const fakeVitest=`import fs from 'node:fs';import path from 'node:path';const args=process.argv.slice(2);if(args[0]!=='list')throw new Error('collection only');const config=JSON.parse(fs.readFileSync('fixture.json','utf8'));fs.writeFileSync(args[args.indexOf('--json')+1],JSON.stringify(config.skipped?[]:[{name:'required passes',file:path.join(process.cwd(),'tests/required.test.ts')}]))`;
function fixture(t,config={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'acceptance-adapter-')));
 for(const name of ['bin','tests','node_modules/vitest','node_modules/typescript/bin','node_modules/next/dist/bin'])fs.mkdirSync(path.join(root,name),{recursive:true});
 fs.writeFileSync(path.join(root,'.gitignore'),'.codex-plan-runner/\nnode_modules/\n');
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{test:'vitest run',check:'tsc --noEmit',build:'next build'}}));
 fs.writeFileSync(path.join(root,'fixture.json'),JSON.stringify(config));
 fs.writeFileSync(path.join(root,'tests/required.test.ts'),'// synthetic assertion fixture\n');
 fs.writeFileSync(path.join(root,'node_modules/vitest/vitest.mjs'),fakeVitest);
 fs.writeFileSync(path.join(root,'node_modules/typescript/bin/tsc'),'// installed synthetic typechecker');
 fs.writeFileSync(path.join(root,'node_modules/next/dist/bin/next'),'// installed synthetic entrypoint');
 fs.writeFileSync(path.join(root,'bin/npm'),fakeNpm,{mode:0o700});
 execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','add','.']);execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
 const prior=process.env.PATH;process.env.PATH=path.join(root,'bin')+path.delimiter+prior;
 t.after(()=>{process.env.PATH=prior;fs.rmSync(root,{recursive:true,force:true});});
 return {root,packageId,planHash,gate,mapping,outputDir:path.join(root,'.codex-plan-runner','test',randomUUID())};
}
test('fixed npm acceptance executes collection, full suite and check in owned checkout and verifies cleanup',async t=>{
 const input=fixture(t);const events=[];const result=await runAcceptanceGate({...input,onJournal:event=>events.push(event.phase)});
 assert.equal(result.evidence.passed,true,result.evidence.blockers.join('; '));assert.equal(result.evidence.cleanup_verified,true);assert.equal(fs.existsSync(result.evidence.checkout),false);
 assert.deepEqual(result.evidence.cases,mapping.cases);assert.deepEqual(result.evidence.checks.map(c=>c.id),['collect','npm-test','npm-check']);assert.ok(events.includes('running'));
 assert.equal(verifyAcceptanceGate({...input,file:result.file}).evidence.passed,true);
 const replay=await runAcceptanceGate({...input,journalFile:result.journalFile});assert.equal(replay.file,result.file);
});
test('failed assertions produce verified failed evidence, never successful completion',async t=>{
 const input=fixture(t,{failed:true});const result=await runAcceptanceGate(input);assert.equal(result.evidence.passed,false);assert.ok(result.evidence.failure_ids.includes('npm-test'));assert.ok(result.evidence.failure_ids.some(id=>id.includes('required passes')));
 assert.equal(verifyAcceptanceGate({...input,file:result.file}).evidence.passed,false);
});
test('required skips or absent collection cannot count as passing gates',async t=>{
 const input=fixture(t,{skipped:true});const result=await runAcceptanceGate(input);assert.equal(result.evidence.passed,false);assert.match(result.evidence.blockers.join(' '),/collection|required/);
});
test('source change requires fresh evidence and changing a captured artifact is tampering',async t=>{
 const input=fixture(t);const result=await runAcceptanceGate(input);
 fs.appendFileSync(path.join(input.root,'tests/required.test.ts'),'// repair\n');assert.throws(()=>verifyAcceptanceGate({...input,file:result.file}),/source snapshot is stale/);
 assert.equal(verifyAcceptanceGate({...input,file:result.file,checkSource:false}).evidence.passed,true);
 const fresh=await runAcceptanceGate({...input,outputDir:path.join(input.root,'.codex-plan-runner','test',randomUUID())});assert.equal(verifyAcceptanceGate({...input,file:fresh.file}).evidence.passed,true);
 fs.appendFileSync(path.join(input.root,fresh.evidence.artifacts[0].file),'tamper');assert.throws(()=>verifyAcceptanceGate({...input,file:fresh.file}),/artifact changed/);
});
test('unknown capabilities, injected argv and remote/traversal/symlink paths fail before execution',t=>{
 const input=fixture(t);assert.throws(()=>validateGateInputs({...input,gate:{...gate,command:'touch anything'}}),/unknown/);
 assert.throws(()=>preflightAcceptanceCapabilities({...input,gates:[{id:'unknown',capability:'network'}]}),/unknown/);
 for(const file of ['../outside.test.ts','https://example.invalid/test.ts','tests/../required.test.ts'])assert.throws(()=>validateGateInputs({...input,mapping:{...mapping,files:[file]}}));
 fs.symlinkSync(path.join(input.root,'tests/required.test.ts'),path.join(input.root,'tests/link.test.ts'));assert.throws(()=>validateGateInputs({...input,mapping:{...mapping,files:['tests/link.test.ts']}}),/symlink/);
});
test('interruption cleans the exact owned process and data before retry',async t=>{
 const input=fixture(t,{hang:true});const controller=new AbortController();let timer;
 const result=await runAcceptanceGate({...input,signal:controller.signal,onJournal:event=>{if(event.phase==='running')timer=setTimeout(()=>controller.abort(),200);}});clearTimeout(timer);
 assert.equal(result.evidence,null);assert.equal(result.cancelled,true);const journal=JSON.parse(fs.readFileSync(result.journalFile,'utf8'));assert.equal(journal.cleanup_verified,true);assert.equal(fs.existsSync(journal.data_directory),false);
 fs.writeFileSync(path.join(input.root,'fixture.json'),'{}');const retry=await runAcceptanceGate({...input,journalFile:result.journalFile,outputDir:path.join(input.root,'.codex-plan-runner','test',randomUUID())});assert.equal(retry.evidence.passed,true,retry.evidence.blockers.join(' '));
});
test('isolated production build requires retained build artifacts and does not use source checkout outputs',async t=>{
 const input=fixture(t);input.gate={id:'build',capability:'production-build'};input.mapping={gate_id:'build',files:[],cases:['production-build']};const result=await runAcceptanceGate(input);
 assert.equal(result.evidence.passed,true,result.evidence.blockers.join('; '));assert.equal(fs.existsSync(path.join(input.root,'.next')),false);assert.equal(verifyAcceptanceGate({...input,file:result.file}).evidence.passed,true);
 assert.equal(result.evidence.build.files.length,4);assert.ok(result.evidence.build.files.every(item=>fs.existsSync(path.join(input.root,item.file))));
 fs.appendFileSync(path.join(input.root,result.evidence.build.files[0].file),'tampered build');
 assert.throws(()=>verifyAcceptanceEvidenceArtifacts({root:input.root,file:result.file}),/artifact changed/);
});
test('clear inherited SQL opt-ins and provider credentials before selecting a fixture',()=>{
 const prior={...process.env};try{process.env.TRIALPROOF_ACCESS_TEST_PG='1';process.env.TRIALPROOF_PG_LOCAL_TEST='1';process.env.OPENAI_API_KEY='never-propagate';process.env.DATABASE_URL='postgres://remote';const env=acceptanceEnvironment('/owned');assert.equal(env.TRIALPROOF_ACCESS_TEST_PG,undefined);assert.equal(env.TRIALPROOF_PG_LOCAL_TEST,undefined);assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.DATABASE_URL,undefined);assert.equal(env.TRIALPROOF_ENABLE_AI,'0');}finally{for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);}
});

test('source-independent artifact verification rejects state symlinks and missing build metadata',async t=>{
 const input=fixture(t);input.gate={id:'build',capability:'production-build'};input.mapping={gate_id:'build',files:[],cases:['production-build']};
 const result=await runAcceptanceGate(input);const saved=fs.readFileSync(result.file,'utf8');
 const evidence=JSON.parse(saved);delete evidence.build;fs.writeFileSync(result.file,JSON.stringify(evidence));assert.throws(()=>verifyAcceptanceEvidenceArtifacts({root:input.root,file:result.file}),/build artifacts/);
 fs.writeFileSync(result.file,saved);const item=evidence.artifacts[0],artifact=path.join(input.root,item.file),copy=artifact+'.copy';fs.renameSync(artifact,copy);fs.symlinkSync(copy,artifact);
 assert.throws(()=>verifyAcceptanceEvidenceArtifacts({root:input.root,file:result.file}),/symlink/);
});

test('source mutation during a passing command is recorded as failed evidence',async t=>{
 const input=fixture(t);fs.writeFileSync(path.join(input.root,'fixture.json'),JSON.stringify({sourceMutation:path.join(input.root,'tests/required.test.ts')}));
 const result=await runAcceptanceGate(input);assert.equal(result.evidence.passed,false);assert.equal(result.evidence.source_unchanged,false);assert.ok(result.evidence.failure_ids.includes('source-mutation'));
 assert.equal(verifyAcceptanceGate({...input,file:result.file,checkSource:false}).evidence.passed,false);
});

test('post-exit cleanup waits for transient EPERM then ESRCH without signalling',async t=>{
 const calls=[],responses=['EPERM','EPERM','ESRCH'];
 t.mock.method(process,'kill',(pid,signal)=>{calls.push({pid,signal});const error=new Error('synthetic '+responses[0]);error.code=responses.shift();throw error;});
 await reapOwnedAcceptanceGroup(12345);
 assert.deepEqual(calls,[{pid:-12345,signal:0},{pid:-12345,signal:0},{pid:-12345,signal:0}]);
});
test('post-exit cleanup refuses persistent EPERM and never signals unknown group',async t=>{
 const calls=[];t.mock.method(process,'kill',(pid,signal)=>{calls.push({pid,signal});const error=new Error('synthetic permission refusal');error.code='EPERM';throw error;});
 await assert.rejects(()=>reapOwnedAcceptanceGroup(12345),error=>error.code==='EPERM');
 assert.ok(calls.length>1);assert.ok(calls.every(call=>call.pid===-12345&&call.signal===0));
});
test('post-exit cleanup handles a probe-to-signal exit race without repeating signal',async t=>{
 const calls=[],responses=[null,'EPERM','EPERM','ESRCH'];
 t.mock.method(process,'kill',(pid,signal)=>{calls.push({pid,signal});const code=responses.shift();if(code){const error=new Error('synthetic '+code);error.code=code;throw error;}return true;});
 await reapOwnedAcceptanceGroup(12345);
 assert.deepEqual(calls.map(call=>call.signal),[0,'SIGKILL',0,0]);
});

test('whole-range npm prerequisite rejects missing installed TypeScript before a worker',t=>{
 const input=fixture(t);fs.unlinkSync(path.join(input.root,'node_modules/typescript/bin/tsc'));
 assert.throws(()=>preflightAcceptanceCapabilities({...input,gates:[gate]}),/typescript/);
 assert.equal(fs.existsSync(input.outputDir),false);
});
