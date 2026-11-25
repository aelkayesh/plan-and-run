import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// This is an external consumer of the generated wrapper, including background
// children after the launcher exits. Every worker and credential is synthetic.
const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = 'portable-background';
const bundle = `docs/implementation-plans/${slug}`;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const fake = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
if(process.argv.includes('login')&&process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',async()=>{
 const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
 const id=input.match(/^PACKAGE_ID: (\d{2})$/m)[1],attempt=input.match(/^ATTEMPT_ID: (\S+)$/m)[1];
 const manifest=JSON.parse(fs.readFileSync('docs/implementation-plans/portable-background/runner-manifest.json'));
 const step=manifest.steps.find(s=>s.id===id),thread=args.includes('resume')?args.at(-2):randomUUID();
 const event=x=>console.log(JSON.stringify(x));
 fs.appendFileSync('worker-calls.jsonl',JSON.stringify({id,attempt,thread,resumed:args.includes('resume')})+'\n');
 event({type:'thread.started',thread_id:thread});
 event({type:'item.completed',item:{type:'agent_message',text:'OPENAI_API_KEY=synthetic-redaction-secret'}});
 if(!fs.existsSync('partial.txt'))fs.writeFileSync('partial.txt','owned partial effect retained\n');
 const wait=JSON.parse(fs.readFileSync('fixture-options.json')).wait;
 await new Promise(r=>setTimeout(r,wait));
 execFileSync(process.execPath,['--check','acceptance.mjs']);
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
 fs.writeFileSync(step.validation,JSON.stringify({schema_version:1,package_id:id,attempt_id:attempt,status:'completed',source:{head:git('rev-parse','HEAD'),branch:git('branch','--show-current'),dirty:true},changed_files:['partial.txt'],checks:[{command:'node --check acceptance.mjs',exit_code:0,passed:true}],fixtures:[{id:'generated-background-local-syntax',kind:'synthetic',location:'acceptance.mjs'}],blockers:[]}));
 fs.writeFileSync(step.handoff,'Actual syntax acceptance passed; partial effect retained. Manual successor remains unexecuted.\n');
 fs.writeFileSync(get('--output-last-message'),JSON.stringify({schema_version:1,package_id:id,attempt_id:attempt,status:'completed',summary:'Actual syntax acceptance passed.',validation_file:step.validation,handoff_file:step.handoff,blockers:[]}));
 event({type:'turn.completed'});
});
`;

function command(f, args, options = {}) {
  const result = spawnSync(process.execPath, [f.wrapper, ...args, '--codex-bin', f.fake, '--progress-seconds', '0'], {
    cwd: f.container, env: f.env, encoding: 'utf8', timeout: 25000, ...options,
  });
  if (result.error) throw result.error;
  return result;
}
function ok(result) { assert.equal(result.status, 0, String(result.stdout) + '\n' + String(result.stderr)); return result; }
async function until(action, description) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const result = action(); if (result) return result; await delay(25); }
  assert.fail(`Timed out: ${description}`);
}

function fixture(t, wait) {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'generated background ')));
  const original = path.join(container, 'original repo'), tool = path.join(container, 'temporary skill');
  const auth = path.join(container, 'empty-auth-home');
  fs.mkdirSync(original); fs.mkdirSync(auth); fs.cpSync(candidate, tool, {recursive:true});
  const env = {...process.env,CODEX_PLAN_WORKER:'0',CODEX_RECOVERY_SUPERVISOR:'0',CODEX_HOME:auth,GIT_OPTIONAL_LOCKS:'0'};
  for (const key of ['OPENAI_API_KEY','AZURE_OPENAI_API_KEY','CODEX_API_KEY']) delete env[key];
  const write = (file, data) => fs.writeFileSync(path.join(original, file), data);
  write('original.txt','user original content\n');
  write('acceptance.mjs','export const valid = true;\n');
  write('fake-codex.mjs',fake); fs.chmodSync(path.join(original,'fake-codex.mjs'),0o755);
  write('.gitignore','worker-calls.jsonl\nfixture-options.json\n');
  write('fixture-options.json',JSON.stringify({wait}));
  for (const args of [['init','--quiet'],['add','.'],['-c','user.name=Synthetic fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','commit','--quiet','-m','Synthetic baseline']]) {
    const result=spawnSync('git',args,{cwd:original,env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }
  const spec={title:'Portable background acceptance',source:'# Request\nFinish a synthetic local syntax check without a terminal.\n',contract:'# Contract\nOnly synthetic local work. Preserve original data. No inference or external effects.\n',
    steps:[{id:'15',title:'Ordinary package fifteen',manual:false,plan:'# Package 15\nRun node --check acceptance.mjs and retain partial work.\n'},
      {id:'45',title:'Manual follow-up decision',manual:true,plan:'# Manual\nStop for an explicit future decision.\n'}]};
  const specFile=path.join(container,'spec.json');fs.writeFileSync(specFile,JSON.stringify(spec));
  const generated=spawnSync(process.execPath,[path.join(tool,'scripts/prepare.mjs'),'--repo',original,'--slug',slug,'--spec',specFile],{cwd:container,env,encoding:'utf8',timeout:20000});
  assert.equal(generated.status,0,generated.stdout+generated.stderr);
  assert.equal(fs.existsSync(path.join(original,'worker-calls.jsonl')),false);
  const manifestFile=path.join(original,bundle,'runner-manifest.json'),manifest=read(manifestFile);manifest.ready=true;fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  write('original.txt','user dirty content preserved\n');
  const root=path.join(container,'moved repository');fs.renameSync(original,root);fs.rmSync(tool,{recursive:true,force:true});
  const f={container,root,env,wrapper:path.join(root,bundle,'run.mjs'),fake:path.join(root,'fake-codex.mjs'),manifest,
    state:path.join(root,'.codex-plan-runner',slug,'state.json'),sessions:path.join(root,'.codex-plan-runner',slug,'background')};
  t.after(async()=>{
    // Only the fresh challenged session can be stopped, never a remembered PID.
    if(fs.existsSync(f.sessions))for(const id of fs.readdirSync(f.sessions).filter(id=>/^[a-f0-9-]{36}$/.test(id))){
      const session=path.join(f.sessions,id,'session.json');if(!fs.existsSync(session))continue;
      const stopped=command(f,['stop','--session',id,'--json']);
      assert.equal(stopped.status,0,`Owned fixture retained because cleanup is unresolved: ${container}\n${stopped.stdout}\n${stopped.stderr}`);
      assert.equal(JSON.parse(stopped.stdout).cleanup_verified,true);
    }
    fs.rmSync(container,{recursive:true,force:true});
  });
  return f;
}
const calls = f => fs.existsSync(path.join(f.root,'worker-calls.jsonl')) ? fs.readFileSync(path.join(f.root,'worker-calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const sessions = f => fs.existsSync(f.sessions)?fs.readdirSync(f.sessions).filter(id=>/^[a-f0-9-]{36}$/.test(id)):[];

test('moved generated bundle detaches closed stdio and preserves ordinary fifteen/manual boundaries and redacted durable results', async t=>{
  const f=fixture(t,1500);
  const preflight=JSON.parse(ok(command(f,['preflight','--step','15','--json'])).stdout);
  assert.equal(preflight.ready,true);assert.deepEqual(preflight.selected,['15']);assert.equal(calls(f).length,0);
  ok(command(f,['launch','--step','15','--json'],{stdio:'ignore'}));
  const id=await until(()=>sessions(f)[0],'session after launcher exit');
  const report=await until(()=>{const p=path.join(f.sessions,id,'result.json');return fs.existsSync(p)&&read(p);},'detached completion');
  assert.equal(report.phase,'completed');assert.equal(report.accepted,true);
  assert.equal(read(f.state).steps['15'].status,'completed');assert.equal(read(f.state).steps['45'],undefined);
  assert.equal(fs.readFileSync(path.join(f.root,'original.txt'),'utf8'),'user dirty content preserved\n');
  const receiptFile=path.join(f.root,f.manifest.steps[0].validation),acceptedHash=hash(receiptFile);
  const status=JSON.parse(ok(command(f,['status','--step','15','--json','--session',id])).stdout);
  assert.equal(status.background.id,id);assert.equal(status.background.phase,'completed');
  assert.equal(JSON.stringify(status).includes('synthetic-redaction-secret'),false);
  assert.equal(JSON.stringify(status).includes('"token"'),false);
  const logs=ok(command(f,['logs','--session',id]));assert.equal(logs.stdout.includes('synthetic-redaction-secret'),false);
  const manual=command(f,['launch','--from','15','--to','45','--json']);assert.notEqual(manual.status,0);
  assert.equal(calls(f).length,1);assert.equal(hash(receiptFile),acceptedHash);assert.equal(read(f.state).steps['45'],undefined);
});

test('moved generated bundle stops its owned background worker and resumes saved partial work', async t=>{
  const f=fixture(t,15000);
  const launch=JSON.parse(ok(command(f,['launch','--step','15','--json'])).stdout);
  await until(()=>calls(f).length===1,'first synthetic worker');
  const before=await until(()=>{const entry=read(f.state).steps['15'];return entry?.thread_id&&entry;},'saved worker thread');
  const stopped=JSON.parse(ok(command(f,['stop','--session',launch.id,'--json'])).stdout);
  assert.equal(stopped.phase,'interrupted');assert.notEqual(read(f.state).steps['15'].status,'completed');
  assert.equal(fs.existsSync(path.join(f.root,'.codex-plan-runner',slug,'runner.lock')),false);
  assert.equal(fs.readFileSync(path.join(f.root,'partial.txt'),'utf8'),'owned partial effect retained\n');
  fs.writeFileSync(path.join(f.root,'fixture-options.json'),JSON.stringify({wait:20}));
  const resumed=JSON.parse(ok(command(f,['launch','--step','15','--json'])).stdout);
  assert.notEqual(resumed.id,launch.id);
  const report=await until(()=>{const p=path.join(f.sessions,resumed.id,'result.json');return fs.existsSync(p)&&read(p);},'resumed completion');
  assert.equal(report.phase,'completed');assert.equal(read(f.state).steps['15'].status,'completed');
  assert.equal(calls(f)[1].thread,before.thread_id);assert.equal(calls(f)[1].resumed,true);
  assert.equal(read(path.join(f.sessions,launch.id,'result.json')).phase,'interrupted');
  assert.equal(fs.readFileSync(path.join(f.root,'original.txt'),'utf8'),'user dirty content preserved\n');
});
