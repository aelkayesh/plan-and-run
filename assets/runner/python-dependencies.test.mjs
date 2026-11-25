import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { declaredPythonRequirements, capturePythonPrerequisite, preparePythonAcceptanceEnvironment } from './python-dependencies.mjs';
import { acceptanceEnvironment, preflightAcceptanceCapabilities, runAcceptanceGate, verifyAcceptanceGate } from './acceptance-adapters.mjs';

const gate = {id:'npm',capability:'npm-checks'};
const mapping = {gate_id:'npm',files:['tests/required.test.ts'],cases:['required passes','npm-test','npm-check']};
const python = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const executable=process.argv[1],prefix=path.dirname(path.dirname(executable));
if(process.argv.includes('-I')){
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 if(process.env.OPENAI_API_KEY||process.env.PYTHONPATH||process.env.AZURE_CLIENT_SECRET)throw Error('unscrubbed probe');
 console.log(JSON.stringify({version:'3.12.0',machine:'fixture',executable,prefix,base_prefix:prefix,sites:[path.join(prefix,'lib/site-packages')],packages:input.packages.map(x=>({name:x.name,version:x.version||'1.0'})),encodings:[]}));
}else{
 if(fs.existsSync('.venv'))throw Error('venv should not be copied');
 if(fs.readFileSync('python/fixture.py','utf8')!=='copied source')throw Error('source not copied');
 if(process.env.PYTHONDONTWRITEBYTECODE!=='1'||process.env.PYTHONNOUSERSITE!=='1'||process.env.PYTHONPATH||process.env.OPENAI_API_KEY||process.env.TRIALPROOF_BENCHMARK_PAID_APPROVED!=='0')throw Error('unsafe acceptance environment');
 console.log('local Python source passed');
}
`;
const npm = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const args=process.argv.slice(2);
if(args[0]==='test'){
 if(!path.isAbsolute(process.env.TRIALPROOF_PYTHON||''))throw Error('Python missing in isolated gate');
 const result=cp.spawnSync(process.env.TRIALPROOF_PYTHON,['python/fixture.py'],{encoding:'utf8',env:process.env});
 if(result.status!==0)throw Error(result.stderr||'Python failed');
 const config=JSON.parse(fs.readFileSync('fixture.json','utf8'));if(config.mutate)fs.appendFileSync(config.mutate,'changed');
 const output=args.find(x=>x.startsWith('--outputFile=')).slice('--outputFile='.length);
 fs.writeFileSync(output,JSON.stringify({success:true,numFailedTestSuites:0,numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0,testResults:[{name:path.join(process.cwd(),'tests/required.test.ts'),status:'passed',assertionResults:[{fullName:'required passes',title:'required passes',ancestorTitles:[],status:'passed',failureMessages:[]}]}]}));
}else if(args[0]==='run'&&args[1]==='check'){}else throw Error('unexpected command');
`;
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'python-acceptance-')));
  const write=(relative,value,mode=0o600)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value,{mode});return file;};
  write('.gitignore','.codex-plan-runner/\nnode_modules/\n.venv/\n');
  write('package.json',JSON.stringify({scripts:{test:'vitest run',check:'tsc --noEmit'}}));
  write('requirements.txt','fixture-dependency==1.0\n');write('fixture.json','{}');
  write('python/fixture.py','copied source');write('tests/required.test.ts','// isolated check\n');
  write('.venv/lib/site-packages/fixture.py','installed dependency');write('.venv/pyvenv.cfg','fixture virtual environment');
  write('.venv/bin/python-fixture',python,0o700);fs.symlinkSync('python-fixture',path.join(root,'.venv/bin/python'));
  write('bin/npm',npm,0o700);write('node_modules/typescript/bin/tsc','// installed');
  write('node_modules/vitest/vitest.mjs',"import fs from 'node:fs';import path from 'node:path';fs.writeFileSync(process.argv.at(-1),JSON.stringify([{name:'required passes',file:path.join(process.cwd(),'tests/required.test.ts')}]))");
  execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'add','.']);execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
  const prior={...process.env};
  for(const key of ['TRIALPROOF_PYTHON','TIKTOKEN_CACHE_DIR','DATA_GYM_CACHE_DIR','PYTHONPATH','PYTHONHOME'])delete process.env[key];
  process.env.PATH=path.join(root,'bin')+path.delimiter+prior.PATH;
  t.after(()=>{for(const key of Object.keys(process.env))if(!(key in prior))delete process.env[key];Object.assign(process.env,prior);fs.rmSync(root,{recursive:true,force:true});});
  return {root,write,packageId:'06',planHash:'a'.repeat(64),gate,mapping,outputDir:path.join(root,'.codex-plan-runner/test',randomUUID())};
}

test('Node-only projects need no Python prerequisite',t=>{
  const input=fixture(t);fs.unlinkSync(path.join(input.root,'requirements.txt'));
  assert.equal(capturePythonPrerequisite(input.root),null);
});
test('requirements include local exact pins without executing options or URLs',t=>{
  const input=fixture(t);input.write('requirements-protocol.txt','-r requirements.txt\nExtra_Dependency[feature]==2.0\n');
  assert.deepEqual(declaredPythonRequirements(input.root).packages,[{name:'extra-dependency',version:'2.0'},{name:'fixture-dependency',version:'1.0'}]);
  input.write('requirements-protocol.txt','--index-url https://example.invalid/private\n');
  assert.throws(()=>declaredPythonRequirements(input.root),/unsupported dependency declaration/);
  input.write('requirements-protocol.txt','-r ../outside.txt\n');assert.throws(()=>declaredPythonRequirements(input.root),/canonical repository file/);
});
test('missing declared Python stops preflight before any acceptance helper or worker',async t=>{
  const input=fixture(t);fs.unlinkSync(path.join(input.root,'.venv/bin/python'));
  assert.throws(()=>preflightAcceptanceCapabilities({...input,gates:[gate]}),/existing project interpreter is missing/);
  await assert.rejects(()=>runAcceptanceGate(input),/existing project interpreter is missing/);
  assert.equal(fs.existsSync(input.outputDir),false);
});
test('unknown capabilities are rejected before probing declared Python',t=>{
  const input=fixture(t);fs.unlinkSync(path.join(input.root,'.venv/bin/python'));
  assert.throws(()=>preflightAcceptanceCapabilities({...input,gates:[{id:'unknown',capability:'network'}]}),/unknown capability/);
});
test('venv launch path stays bound and ignored dependency changes invalidate identity',t=>{
  const input=fixture(t),first=capturePythonPrerequisite(input.root);
  assert.equal(first.executable,path.join(input.root,'.venv/bin/python'));
  assert.equal(first.executable_realpath,path.join(input.root,'.venv/bin/python-fixture'));
  assert.equal(first.sha256,capturePythonPrerequisite(input.root).sha256);
  input.write('.venv/lib/site-packages/fixture.py','changed dependency');
  assert.notEqual(first.sha256,capturePythonPrerequisite(input.root).sha256);
  assert.throws(()=>preparePythonAcceptanceEnvironment(input.root,first,input.outputDir),/Python dependency identity changed/);
});
test('existing executable bytecode and later bytecode changes remain bound',t=>{
  const input=fixture(t);
  input.write('.venv/lib/site-packages/__pycache__/fixture.pyc','original executable bytecode');
  const first=capturePythonPrerequisite(input.root);
  assert.equal(first.sha256,capturePythonPrerequisite(input.root).sha256);
  input.write('.venv/lib/site-packages/__pycache__/fixture.pyc','modified executable bytecode');
  assert.notEqual(first.sha256,capturePythonPrerequisite(input.root).sha256);
  assert.throws(()=>preparePythonAcceptanceEnvironment(input.root,first,input.outputDir),/Python dependency identity changed/);
});
test('missing local tokenizer data stops without creating cache or downloading',t=>{
  const input=fixture(t);input.write('requirements.txt','tiktoken==0.12.0\n');
  const missing=path.join(input.root,'missing-cache');process.env.TIKTOKEN_CACHE_DIR=missing;
  assert.throws(()=>capturePythonPrerequisite(input.root),/tokenizer cache is missing; downloads are disabled/);
  assert.equal(fs.existsSync(missing),false);
  fs.mkdirSync(missing);assert.throws(()=>capturePythonPrerequisite(input.root),/cached tokenizer o200k_base/);
  assert.deepEqual(fs.readdirSync(missing),[]);
});
test('fixed probe and isolated gate scrub Python injections, credentials and paid benchmark flags',async t=>{
  const input=fixture(t);process.env.OPENAI_API_KEY='synthetic-secret';process.env.AZURE_CLIENT_SECRET='synthetic-secret';process.env.PYTHONPATH='/injected';process.env.TRIALPROOF_BENCHMARK_PAID_APPROVED='1';
  const binding=capturePythonPrerequisite(input.root),env=acceptanceEnvironment('/owned',binding);
  assert.equal(env.TRIALPROOF_PYTHON,binding.executable);assert.equal(env.PYTHONPATH,undefined);assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.TRIALPROOF_BENCHMARK_PAID_APPROVED,'0');
  const result=await runAcceptanceGate(input);
  assert.equal(result.evidence.passed,true,result.evidence.blockers.join('; '));
  assert.equal(result.evidence.context.python.executable,binding.executable);assert.equal(result.evidence.cleanup_verified,true);
  assert.equal(fs.existsSync(result.evidence.checkout),false);assert.equal(verifyAcceptanceGate({...input,file:result.file}).evidence.passed,true);
  input.write('.venv/lib/site-packages/fixture.py','later dependency change');
  assert.throws(()=>verifyAcceptanceGate({...input,file:result.file}),/dependency or environment identity is stale/);
  assert.equal(verifyAcceptanceGate({...input,file:result.file,checkSource:false}).evidence.passed,true,'historical evidence remains verifiable');
});
test('dependency mutation during a gate becomes failed evidence despite passing tests',async t=>{
  const input=fixture(t);input.write('fixture.json',JSON.stringify({mutate:path.join(input.root,'.venv/lib/site-packages/fixture.py')}));
  const result=await runAcceptanceGate(input);
  assert.equal(result.evidence.passed,false);assert.equal(result.evidence.context_unchanged,false);assert.match(result.evidence.blockers.join(' '),/environment|dependenc/i);assert.equal(result.evidence.cleanup_verified,true);
});
