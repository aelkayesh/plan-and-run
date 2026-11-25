import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fileHash } from './host-validation.mjs';

const runtime=path.dirname(fileURLToPath(import.meta.url));
// Exercise the real helper, ownership journal, build/report/PNG verification
// and cancellation. Browser/CDP and build transport are deterministic fakes;
// this test makes no claim of actual rendered product UI acceptance.
async function fixture(t,{hang=false,noAssertion=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'acceptance-browser-')));
  const write=(file,value)=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);};
  for(const file of fs.readdirSync(runtime).filter(f=>f.endsWith('.mjs')&&!f.endsWith('.test.mjs')))write('runtime/'+file,fs.readFileSync(path.join(runtime,file)));
  // Socket readiness is a transport stub because restricted workers cannot
  // bind loopback. The owned server/browser children still run and are reaped.
  const helperFile=path.join(root,'runtime/acceptance-helper.mjs');
  let helper=fs.readFileSync(helperFile,'utf8');
  helper=helper.replace(/const port=await new Promise\(.*?\);\n/,"const port=19998;\n");
  helper=helper.replace('const response=await fetch(baseURL,{signal:AbortSignal.timeout(250)})','const response={status:200}');
  fs.writeFileSync(helperFile,helper);
  const adapterFile=path.join(root,'runtime/acceptance-adapters.mjs');
  const adapter=fs.readFileSync(adapterFile,'utf8');
  const begin=adapter.indexOf('export function acceptanceBrowser() {'),end=adapter.indexOf('export function preflightAcceptanceCapabilities',begin);
  fs.writeFileSync(adapterFile,adapter.slice(0,begin)+`export function acceptanceBrowser(){return ${JSON.stringify(path.join(root,'bin/owned-browser'))};}\n`+adapter.slice(end));
  write('.gitignore','.codex-plan-runner/\nnode_modules/\n');
  write('package.json',JSON.stringify({scripts:{build:'next build'}}));
  write('bin/npm',`#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.slice(2).join(' ')!=='run build')throw Error('unexpected argv');fs.mkdirSync('.next');for(const name of ['BUILD_ID','build-manifest.json','routes-manifest.json','prerender-manifest.json'])fs.writeFileSync('.next/'+name,'synthetic build manifest');`);
  write('node_modules/next/dist/bin/next',"const args=process.argv.slice(2);if(args[0]!=='start'||args[args.indexOf('--hostname')+1]!=='127.0.0.1')throw Error('not loopback');setInterval(()=>{},1000);");
  write('bin/owned-browser',`#!${process.execPath}\nprocess.stderr.write('DevTools listening on ws://127.0.0.1:19999/devtools/browser/synthetic\\n');setInterval(()=>{},1000);`);
  write('node_modules/playwright-core/index.mjs',`import fs from 'node:fs';export const chromium={async connectOverCDP(endpoint){if(endpoint!=='ws://127.0.0.1:19999/devtools/browser/synthetic')throw Error('endpoint');return{async newContext(options){if(options.serviceWorkers!=='block')throw Error('service workers enabled');return{async route(){},async newPage(){return{async goto(){},async screenshot({path}){fs.writeFileSync(path,Buffer.from('89504e470d0a1a0a00','hex'));}}},async close(){}}},async close(){}}}};`);
  write('tests/acceptance/06/admin.browser.mjs',`export const cases=[{id:'administration-role-scope',async run({page,baseURL,assert}){${hang?'await new Promise(()=>{});':noAssertion?'await page.goto(baseURL);':'await page.goto(baseURL);assert.equal(baseURL.startsWith("http://127.0.0.1:"),true);'}}}];`);
  for(const file of ['bin/npm','bin/owned-browser'])fs.chmodSync(path.join(root,file),0o700);
  for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','commit','-qm','fixture']])execFileSync('git',args,{cwd:root});
  const oldPath=process.env.PATH;process.env.PATH=path.join(root,'bin')+path.delimiter+oldPath;
  t.after(()=>{process.env.PATH=oldPath;fs.rmSync(root,{recursive:true,force:true});});
  const api=await import(pathToFileURL(adapterFile));
  return{...api,root,packageId:'06',planHash:'a'.repeat(64),gate:{id:'browser',capability:'loopback-browser'},mapping:{gate_id:'browser',files:['tests/acceptance/06/admin.browser.mjs'],cases:['administration-role-scope']},outputDir:path.join(root,'.codex-plan-runner/test')};
}

test('browser gate retains source-bound build, actual case report and unique PNG references',async t=>{
  const input=await fixture(t),result=await input.runAcceptanceGate(input);
  assert.equal(result.evidence.passed,true,result.evidence.blockers.join('; '));
  assert.equal(input.verifyAcceptanceGate({...input,file:result.file}).evidence.passed,true);
  assert.equal(result.evidence.browser.cases[0].assertions,1);
  assert.equal(result.evidence.browser.build.files.length,4);
  assert.equal(fs.existsSync(result.evidence.checkout),false);
  const evidence=result.evidence,report=path.join(input.root,evidence.browser_report_file);
  // Rehash a changed report to exercise semantic accounting beyond file hashes.
  evidence.browser.cases[0].assertions=0;
  fs.writeFileSync(report,JSON.stringify(evidence.browser));
  evidence.artifacts.find(item=>item.file===evidence.browser_report_file).sha256=fileHash(report);
  fs.writeFileSync(result.file,JSON.stringify(evidence));
  assert.throws(()=>input.verifyAcceptanceEvidenceArtifacts({root:input.root,file:result.file}),/assertions failed/);
});

test('browser cases without a harness assertion fail despite screenshots and zero build exit',async t=>{
  const input=await fixture(t,{noAssertion:true}),result=await input.runAcceptanceGate(input);
  assert.equal(result.evidence.passed,false);assert.deepEqual(result.evidence.failure_ids,['administration-role-scope']);
  assert.equal(input.verifyAcceptanceGate({...input,file:result.file}).evidence.passed,false);
});

test('browser cancellation removes browser/server in the exact owned helper group',async t=>{
  const input=await fixture(t,{hang:true}),controller=new AbortController();let poll,journalFile,children=[];
  const result=await input.runAcceptanceGate({...input,signal:controller.signal,onJournal:event=>{
    journalFile=event.journalFile;
    if(event.phase==='running')poll=setInterval(()=>{
      const journal=JSON.parse(fs.readFileSync(journalFile,'utf8'));
      if(journal.owned_children?.some(child=>child.kind==='browser')){children=journal.owned_children;clearInterval(poll);controller.abort();}
    },10);
  }});clearInterval(poll);
  assert.equal(result.cancelled,true);assert.equal(result.evidence,null);
  assert.equal(children.length,2);assert.ok(children.every(child=>child.pgid===children[0].pgid));
  const journal=JSON.parse(fs.readFileSync(journalFile,'utf8'));assert.equal(journal.cleanup_verified,true);assert.equal(fs.existsSync(journal.data_directory),false);
  for(const child of children)assert.throws(()=>process.kill(child.pid,0),error=>error.code==='ESRCH');
});
