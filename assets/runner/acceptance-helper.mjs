import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileHash, snapshotSource } from './host-validation.mjs';
import { writeHostJournal } from './automatic-host-validation.mjs';
import { acceptanceEnvironment, acceptanceHash, acceptanceBrowser, parseAcceptanceReport } from './acceptance-adapters.mjs';
import { createAcceptancePostgres } from './acceptance-postgres.mjs';
import { preparePythonAcceptanceEnvironment } from './python-dependencies.mjs';
import { acceptanceReportFailures } from './unattended.mjs';

const [journalFile,id]=process.argv.slice(2);
const initial=JSON.parse(fs.readFileSync(journalFile,'utf8'));
if(initial.id!==id||initial.kind!=='acceptance-gate-journal'||initial.root!==process.cwd())throw new Error('Acceptance helper identity mismatch');
const update=values=>{const journal=JSON.parse(fs.readFileSync(journalFile,'utf8'));Object.assign(journal,values);writeHostJournal(journalFile,journal);return journal;};
const control=setInterval(()=>{
  try{const request=JSON.parse(fs.readFileSync(journalFile+'.control-request.json','utf8'));if(request.id===id&&typeof request.challenge==='string')writeHostJournal(journalFile+'.control-response.json',{id,pid:process.pid,challenge:request.challenge});}catch(e){if(e.code!=='ENOENT')process.stderr.write('Ownership control request invalid\n');}
},50);
let started=false;
process.on('message',async message=>{
  if(started||message?.start!==true)return;started=true;
  try{await execute();}catch(error){update({phase:'helper_failed',diagnostic:error.message});process.exitCode=1;}
  finally{clearInterval(control);process.disconnect();}
});

async function execute(){
  const journal=JSON.parse(fs.readFileSync(journalFile,'utf8'));
  const root=journal.root,outputDir=path.dirname(journalFile),directory=journal.data_directory;
  const stat=fs.lstatSync(directory),owner=JSON.parse(fs.readFileSync(path.join(directory,'.owner.json'),'utf8'));
  if(!stat.isDirectory()||stat.isSymbolicLink()||owner.id!==id||stat.ino!==journal.data?.inode||stat.dev!==journal.data?.device)throw new Error('Acceptance data ownership is unknown');
  update({phase:'preparing'});
  const checkout=path.join(directory,'checkout');fs.mkdirSync(checkout,{mode:0o700});
  for(const item of journal.source.files){
    if(item.kind==='deleted'||/^(?:\.env(?:\.|$)|\.npmrc$|\.codex\/|\.aws\/)/.test(item.path))continue;
    if(item.kind!=='file')throw new Error('Isolated acceptance copy refuses source symlinks');
    const dest=path.join(checkout,item.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,item.path),dest,fs.constants.COPYFILE_EXCL);fs.chmodSync(dest,item.mode);
  }
  fs.symlinkSync(path.join(root,'node_modules'),path.join(checkout,'node_modules'),'dir');
  const env={...acceptanceEnvironment(directory,journal.context.python),...preparePythonAcceptanceEnvironment(root,journal.context.python,directory),CODEX_PLAN_PACKAGE_ID:journal.package_id,CODEX_PLAN_PLAN_HASH:journal.plan_hash,CODEX_PLAN_ACCEPTANCE_SOURCE_SHA256:journal.source.sha256};
  const evidence={schema_version:1,kind:'codex-plan-acceptance-gate',id,root,package_id:journal.package_id,plan_hash:journal.plan_hash,gate:journal.gate,mapping:journal.mapping,
    mapping_sha256:acceptanceHash(journal.mapping),source:journal.source,context:journal.context,context_unchanged:false,source_unchanged:false,
    source_after_sha256:null,checkout,journal_file:path.relative(root,journalFile),created_at:new Date().toISOString(),checks:[],artifacts:[],cases:[],failure_ids:[],blockers:[],passed:false,cleanup_verified:false};
  const relative=file=>path.relative(root,file);
  const artifact=file=>{const ref={file:relative(file),sha256:fileHash(file)};evidence.artifacts.push(ref);return ref;};
  const run=async(argv,label,environment=env)=>{
    const logFile=path.join(outputDir,`${id}-${label}.log`);const fd=fs.openSync(logFile,'wx',0o600);
    update({phase:'checking',active_check:label});
    const child=spawn(argv[0],argv.slice(1),{cwd:checkout,env:environment,shell:false,detached:false,stdio:['ignore',fd,fd]});fs.closeSync(fd);
    let err;const result=await new Promise(resolve=>{child.once('error',error=>{err=error;});child.once('close',(code,signal)=>resolve({code,signal}));});
    const check={id:label,command:argv.join(' '),argv,exit_code:Number.isInteger(result.code)?result.code:1,signal:result.signal||null,passed:result.code===0&&!result.signal&&!err,...(err?{error_code:err.code}:{}),log_file:relative(logFile),log_sha256:fileHash(logFile)};
    evidence.checks.push(check);artifact(logFile);
    if(!check.passed){evidence.failure_ids.push(label);throw new Error(`Required check ${label} failed (${check.error_code||check.signal||check.exit_code})`);}
    return check;
  };
  let fixture;
  try{
    const capability=journal.gate.capability;
    if(capability==='synthetic-postgres'){
      fixture=createAcceptancePostgres({packageId:journal.package_id,planHash:journal.plan_hash,preset:journal.gate.preset,onJournal:event=>update({fixture:event.fixture,...(event.cleanup?{fixture_cleanup:event.cleanup}:{}),fixture_phase:event.phase})});
      evidence.fixture=fixture.evidence;Object.assign(env,fixture.environment);
    }
    if(['npm-checks','synthetic-postgres'].includes(capability)){
      const collection=path.join(outputDir,`${id}-collection.json`),report=path.join(outputDir,`${id}-report.json`);
      const filters=capability==='synthetic-postgres'?journal.mapping.files:[];
      await run([process.execPath,path.join(root,'node_modules/vitest/vitest.mjs'),'list',...filters,'--json',collection],'collect',env);
      artifact(collection);evidence.collection_file=relative(collection);
      try{await run([process.execPath,journal.context.npm,'test','--',...filters,'--reporter=json',`--outputFile=${report}`],'npm-test',env);}
      finally{if(fs.existsSync(report)){
        artifact(report);evidence.report_file=relative(report);
        try{const failures=acceptanceReportFailures(JSON.parse(fs.readFileSync(report,'utf8')),checkout);evidence.failure_ids.push(...failures.failure_ids);evidence.failed_suites=failures.failed_suites;}catch{/* Invalid reports fail the required parser or check; preserve raw report. */}
      }}
      if(capability==='npm-checks')await run([process.execPath,journal.context.npm,'run','check'],'npm-check',env);
      evidence.results=parseAcceptanceReport({report:JSON.parse(fs.readFileSync(report,'utf8')),collected:JSON.parse(fs.readFileSync(collection,'utf8')),root:checkout,files:journal.mapping.files,cases:journal.mapping.cases,capability});evidence.cases=evidence.results.cases;
    }else if(capability==='production-build'){
      await run([process.execPath,journal.context.npm,'run','build'],'production-build');
      evidence.build=buildArtifacts(checkout,{outputDir,id,artifact});evidence.cases=['production-build'];
    }else if(capability==='loopback-browser'){
      await run([process.execPath,journal.context.npm,'run','build'],'production-build');
      const build=buildArtifacts(checkout,{outputDir,id,artifact});const browserReport=await browserChecks({root,checkout,journal,env,outputDir,build,artifact,run});
      evidence.browser=browserReport;evidence.cases=browserReport.cases.map(c=>c.id);
      const report=path.join(outputDir,`${id}-browser-report.json`);fs.writeFileSync(report,JSON.stringify(browserReport,null,2)+'\n',{flag:'wx',mode:0o600});artifact(report);evidence.browser_report_file=relative(report);
      if(browserReport.cases.some(c=>!c.passed)){evidence.failure_ids.push(...browserReport.cases.filter(c=>!c.passed).map(c=>c.id));throw new Error('Browser assertions failed');}
    }else throw new Error('Unknown fixed acceptance capability');
  }catch(error){
    evidence.blockers.push(error.message);
    if(error.fixtureEvidence){evidence.fixture=error.fixtureEvidence;update({fixture:error.fixtureEvidence,fixture_cleanup:error.fixtureEvidence.cleanup});}
    if(!evidence.failure_ids.length)evidence.failure_ids.push(`gate:${journal.gate.id}:evidence`);
  }finally{
    if(fixture){try{evidence.fixture_cleanup=fixture.dispose();update({fixture_cleanup:evidence.fixture_cleanup});}catch(error){evidence.blockers.push(error.message);evidence.failure_ids.push('fixture-cleanup');}}
  }
  const after=snapshotSource(root,journal.mutable_paths);evidence.source_after_sha256=after.sha256;evidence.source_unchanged=after.sha256===journal.source.sha256;
  if(!evidence.source_unchanged){evidence.blockers.push('Source changed during acceptance');evidence.failure_ids.push('source-mutation');}
  evidence.passed=evidence.blockers.length===0;evidence.finished_at=new Date().toISOString();
  const file=path.join(outputDir,`${id}-acceptance-evidence.json`);writeHostJournal(file,evidence);update({phase:'evidence_pending',evidence_file:file});
}
function buildArtifacts(checkout,{outputDir,id,artifact}){
  const root=path.join(checkout,'.next');const files=[];
  for(const name of ['BUILD_ID','build-manifest.json','routes-manifest.json','prerender-manifest.json']){
    const file=path.join(root,name);if(!fs.lstatSync(file,{throwIfNoEntry:false})?.isFile())throw new Error(`Required production build artifact missing: ${name}`);
    const retained=path.join(outputDir,`${id}-build-${name}`);fs.copyFileSync(file,retained,fs.constants.COPYFILE_EXCL);
    files.push({name,...artifact(retained)});
  }
  return {files,sha256:acceptanceHash(files)};
}
async function browserChecks({root,checkout,journal,env,outputDir,build,artifact}){
  const modules=[];
  for(const file of journal.mapping.files){const mod=await import(pathToFileURL(path.join(checkout,file)));if(!Array.isArray(mod.cases))throw new Error('Browser module must export cases array');modules.push(...mod.cases);}
  if(modules.some(c=>!c||typeof c.id!=='string'||typeof c.run!=='function')||new Set(modules.map(c=>c.id)).size!==modules.length||JSON.stringify(modules.map(c=>c.id).sort())!==JSON.stringify([...journal.mapping.cases].sort()))throw new Error('Browser declared cases do not match every required mapping case');
  const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
  const baseURL=`http://127.0.0.1:${port}`;
  const log=path.join(outputDir,`${journal.id}-server.log`),fd=fs.openSync(log,'wx',0o600);
  const server=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:checkout,env,detached:false,shell:false,stdio:['ignore',fd,fd]});fs.closeSync(fd);
  update({owned_children:[{kind:'server',pid:server.pid,pgid:process.pid}]});
  let browser,browserChild,browserLog;
  const result={source_sha256:journal.source.sha256,build_sha256:build.sha256,build,origin:baseURL,cases:[],screenshots:[]};
  try{
    let ready=false;
    for(let i=0;i<200;i++){if(server.exitCode!==null)throw new Error('Owned loopback server exited before readiness');try{const response=await fetch(baseURL,{signal:AbortSignal.timeout(250)});if(response.status<500){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    if(!ready)throw new Error('Owned loopback server did not become ready');
    const {chromium}=await import(pathToFileURL(path.join(root,'node_modules/playwright-core/index.mjs')));
    // Spawn Chromium in the helper's already journaled process group. The
    // default Playwright launch creates a detached group outside that journal.
    browserLog=path.join(outputDir,`${journal.id}-browser-process.log`);
    const browserFd=fs.openSync(browserLog,'wx',0o600);
    const browserExecutable=acceptanceBrowser();
    browserChild=spawn(browserExecutable,['--headless=new','--no-first-run','--disable-background-networking','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${path.join(journal.data_directory,'browser-profile')}`,'about:blank'],{cwd:checkout,env,detached:false,shell:false,stdio:['ignore',browserFd,'pipe']});
    fs.closeSync(browserFd);
    update({owned_children:[{kind:'server',pid:server.pid,pgid:process.pid},{kind:'browser',pid:browserChild.pid,pgid:process.pid,executable:browserExecutable}]});
    const endpoint=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(new Error('Owned browser startup timed out')),15000);
      browserChild.once('error',error=>{clearTimeout(timer);reject(error);});
      browserChild.once('close',()=>{clearTimeout(timer);reject(new Error('Owned browser exited before readiness'));});
      browserChild.stderr.on('data',chunk=>{fs.appendFileSync(browserLog,chunk);output=(output+chunk).slice(-16000);const match=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);const url=new URL(match[1]);if(url.hostname!=='127.0.0.1'||url.protocol!=='ws:'||!url.port||url.username||url.password)reject(new Error('Browser debugger endpoint is not owned loopback'));else resolve(match[1]);}});
    });
    browser=await chromium.connectOverCDP(endpoint);
    for(let index=0;index<modules.length;index++){
      const item=modules[index],context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',route=>new URL(route.request().url()).origin===baseURL?route.continue():route.abort());
      const page=await context.newPage();let assertions=0,failure=null;
      const checks=Object.freeze({equal:(a,b,message)=>{assertions++;assert.equal(a,b,message);},deepEqual:(a,b,message)=>{assertions++;assert.deepEqual(a,b,message);},ok:(value,message)=>{assertions++;assert.ok(value,message);},rejects:async(fn,expected)=>{assertions++;await assert.rejects(fn,expected);}});
      try{await item.run(Object.freeze({page,baseURL,assert:checks}));if(assertions===0)throw new Error('Browser case invoked no harness assertion');}catch(error){failure=String(error.message).slice(0,2000);}
      const file=path.join(outputDir,`${journal.id}-browser-${index+1}.png`);await page.screenshot({path:file,fullPage:true});const ref=artifact(file);result.screenshots.push({case_id:item.id,...ref});result.cases.push({id:item.id,passed:failure===null,assertions,failure});await context.close();
    }
  }finally{
    if(browser)await browser.close();
    for(const child of [browserChild,server].filter(Boolean)){
      if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();const timer=setTimeout(()=>{child.kill('SIGKILL');},1000);child.once('close',()=>{clearTimeout(timer);resolve();});});}
    }
    artifact(log);if(browserLog)artifact(browserLog);
  }
  return result;
}
