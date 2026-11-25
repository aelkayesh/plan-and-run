import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { snapshotSource, snapshotDependencies, isolatedEnvironment, statePath, fileHash } from './host-validation.mjs';
import { writeHostJournal } from './automatic-host-validation.mjs';
import { preflightAcceptancePostgres, reconcileAcceptancePostgres, legacyPostgresPreset } from './acceptance-postgres.mjs';
import { capturePythonPrerequisite, pythonAcceptanceEnvironment } from './python-dependencies.mjs';

export const ACCEPTANCE_CAPABILITIES = Object.freeze(['npm-checks', 'production-build', 'synthetic-postgres', 'loopback-browser']);
const HELPER = fileURLToPath(new URL('./acceptance-helper.mjs', import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const acceptanceHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const require = (condition, text) => { if (!condition) throw new Error(`Invalid acceptance gate: ${text}`); };
const sorted = a => [...a].sort();
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

export function acceptancePath(root, relative, { existing = true } = {}) {
  require(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) && !relative.includes('\\')
    && !relative.includes('\0') && relative.split('/').every(part => part && !['.', '..'].includes(part)), 'path must be canonical and repository-relative');
  const full = path.join(root, relative);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    require(!stat?.isSymbolicLink(), 'symlink paths are forbidden');
  }
  if (existing) require(fs.lstatSync(full, { throwIfNoEntry: false })?.isFile(), `required mapping file missing: ${relative}`);
  return full;
}
export function validateGateInputs({root,packageId,planHash,gate,mapping}) {
  require(/^\d{2}$/.test(packageId || '') && HASH.test(planHash || ''), 'package and plan identities required');
  require(gate && Object.keys(gate).every(key=>['id','capability','preset'].includes(key)) && /^[a-z][a-z0-9-]{0,63}$/.test(gate.id || '') && ACCEPTANCE_CAPABILITIES.includes(gate.capability), 'unknown capability or gate field');
  require(!gate.preset || gate.capability === 'synthetic-postgres', 'preset only applies to PostgreSQL');
  const preset = legacyPostgresPreset(gate.preset);
  require(mapping && Object.keys(mapping).every(key=>['gate_id','files','cases'].includes(key)) && mapping.gate_id === gate.id
    && Array.isArray(mapping.files) && Array.isArray(mapping.cases) && mapping.cases.every(x=>typeof x==='string' && x.trim() && x.length<1000)
    && new Set(mapping.files).size === mapping.files.length && new Set(mapping.cases).size === mapping.cases.length, 'invalid file/case mapping');
  for (const file of mapping.files) {
    acceptancePath(root,file);
    const valid = gate.capability === 'synthetic-postgres' ? preset ? preset.files.includes(file) : new RegExp(`^tests/acceptance/${packageId}/[^/]+\\.postgres\\.test\\.ts$`).test(file)
      : gate.capability === 'loopback-browser' ? new RegExp(`^tests/acceptance/${packageId}/[^/]+\\.browser\\.mjs$`).test(file)
      : gate.capability === 'npm-checks' ? /^tests\/.*\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/.test(file) : false;
    require(valid, `file is outside the fixed capability convention: ${file}`);
  }
  if (preset) require(same(sorted(mapping.files), sorted(preset.files)), 'legacy preset requires its complete fixed suite');
  if (['synthetic-postgres','loopback-browser'].includes(gate.capability)) require(mapping.files.length > 0 && mapping.cases.length > 0, 'required suite mapping is missing');
  if (gate.capability==='production-build') require(mapping.files.length===0 && same(mapping.cases,['production-build']), 'build mapping must contain only production-build');
  return {gate,mapping,preset};
}
function executableOnPath(name) {
  for (const directory of (process.env.PATH||'').split(path.delimiter)) {
    const file=path.join(directory,name);
    try { fs.accessSync(file,fs.constants.X_OK); return fs.realpathSync(file); } catch {}
  }
  throw new Error(`Installed prerequisite unavailable: ${name}`);
}
export function acceptanceBrowser() {
  const paths=process.platform==='darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium'] : ['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'];
  const browser=paths.find(file=>fs.existsSync(file)&&fs.statSync(file).isFile());
  if (!browser) throw new Error('Installed prerequisite unavailable: supported local Chromium browser (no download permitted)');
  return browser;
}
export function preflightAcceptanceCapabilities({root,packageId,gates}) {
  require(/^\d{2}$/.test(packageId||'') && Array.isArray(gates), 'preflight identity/gates invalid');
  const pkgFile=acceptancePath(root,'package.json'); const pkg=JSON.parse(fs.readFileSync(pkgFile,'utf8'));
  const prerequisites=[];
  for (const gate of gates) require(gate && ACCEPTANCE_CAPABILITIES.includes(gate.capability), 'unknown capability');
  const python = gates.length ? capturePythonPrerequisite(root) : null;
  for(const gate of gates){
    require(gate && ACCEPTANCE_CAPABILITIES.includes(gate.capability), 'unknown capability');
    const prerequisite={gate_id:gate.id,capability:gate.capability,...(python ? {python} : {})};
    if (['npm-checks','synthetic-postgres'].includes(gate.capability)) {
      require(pkg.scripts?.test==='vitest run','strict test capability requires existing vitest run script');
      prerequisite.vitest=acceptancePath(root,'node_modules/vitest/vitest.mjs');
    }
    if (gate.capability==='npm-checks') { require(pkg.scripts?.check==='tsc --noEmit','strict check capability requires existing tsc --noEmit script'); prerequisite.typescript=acceptancePath(root,'node_modules/typescript/bin/tsc'); }
    if(['production-build','loopback-browser'].includes(gate.capability)){
      require(pkg.scripts?.build==='next build','strict build capability requires existing next build script');
      prerequisite.next=acceptancePath(root,'node_modules/next/dist/bin/next');
    }
    prerequisite.npm=executableOnPath('npm');
    if(gate.capability==='synthetic-postgres') {legacyPostgresPreset(gate.preset); prerequisite.postgres=preflightAcceptancePostgres();}
    if(gate.capability==='loopback-browser'){
      prerequisite.playwright=acceptancePath(root,'node_modules/playwright-core/index.mjs'); prerequisite.browser=acceptanceBrowser();
    }
    prerequisites.push(prerequisite);
  }
  return {schema_version:1,package_id:packageId,prerequisites};
}
export function acceptanceEnvironment(dataDirectory, python = null) {
  const env=isolatedEnvironment(dataDirectory);
  for(const key of Object.keys(env)) if (/^(?:PG[A-Z0-9_]*|CODEX_PLAN_TEST_DATABASE_URL|CODEX_PLAN_FIXTURE_ID|CODEX_PLAN_PACKAGE_ID)$/i.test(key)
    || /(?:TEST_PG|PG_LOCAL_TEST|TEST_DATABASE|DATABASE_URL|DIRECT_URL)/i.test(key) || /^(?:npm_config_|NPM_CONFIG_|PYTHON)/.test(key) || ['TRIALPROOF_PYTHON','TIKTOKEN_CACHE_DIR','DATA_GYM_CACHE_DIR','VIRTUAL_ENV','VIRTUAL_ENV_PROMPT'].includes(key)) delete env[key];
  Object.assign(env,{TRIALPROOF_STORAGE:'local',TRIALPROOF_ENABLE_AI:'0',TRIALPROOF_BENCHMARK_PAID_APPROVED:'0',TRIALPROOF_REAL_INVITATIONS:'0',TRIALPROOF_INVITATION_TRANSPORT:'disabled',NEXT_TELEMETRY_DISABLED:'1',CI:'1',npm_config_offline:'true',npm_config_ignore_scripts:'true'},pythonAcceptanceEnvironment(python));
  return env;
}
export function acceptanceExecutionContext(root) {
  const npm=executableOnPath('npm'),python=capturePythonPrerequisite(root);
  const selected=Object.fromEntries(Object.entries(acceptanceEnvironment('<owned-data>',python)).filter(([key])=>/^(PATH|LANG|LC_.*|TZ|NODE_ENV|TRIALPROOF_.*|PYTHON.*|TIKTOKEN_CACHE_DIR|npm_config_.*)$/.test(key)).sort(([a],[b])=>a.localeCompare(b)));
  return {node:process.execPath,node_version:process.version,node_arch:process.arch,npm,npm_sha256:fileHash(npm),dependencies_sha256:snapshotDependencies(root).sha256,environment_sha256:acceptanceHash(selected),...(python ? {python} : {})};
}
const context = acceptanceExecutionContext;
export function parseAcceptanceReport({report,collected,root,files,cases,capability}) {
  require(report && Array.isArray(report.testResults) && report.testResults.length>0 && Array.isArray(collected) && collected.length>0, 'full report and collection are required');
  require(report.numFailedTests===0 && report.numFailedTestSuites===0 && report.success===true && !report.snapshot?.failure, 'suite contains failures');
  const reported=report.testResults.flatMap(suite=>{
    require(typeof suite.name==='string' && Array.isArray(suite.assertionResults),'malformed suite');
    const file=path.relative(root,suite.name).split(path.sep).join('/');
    require(!file.startsWith('../') && !path.isAbsolute(file),'report names outside owned checkout');
    return suite.assertionResults.map(test=>{
      require(test && typeof test.fullName==='string' && test.fullName.length>0,'malformed assertion identity');
      const structured=Object.hasOwn(test,'ancestorTitles')||Object.hasOwn(test,'title');
      // Vitest JSON fullName joins hierarchy with spaces, while list names use
      // " > ". Rebuild only from structured titles: separators may be literal.
      if(structured) {
        require(Array.isArray(test.ancestorTitles) && test.ancestorTitles.every(title=>typeof title==='string') && typeof test.title==='string','malformed assertion title hierarchy');
        require(test.fullName===(test.title?[...test.ancestorTitles,test.title]:test.ancestorTitles).join(' '),'assertion full name differs from title hierarchy');
      }
      const collection_name=structured?[...test.ancestorTitles,test.title].join(' > '):test.fullName;
      return {file,id:test.fullName,status:test.status,failure_messages:test.failureMessages||[],collection_name};
    });
  });
  const results=reported.map(({collection_name,...result})=>result);
  require(results.length===report.numTotalTests,'report counts are inconsistent');
  const active=results.filter(x=>!['pending','skipped','todo','disabled'].includes(x.status));
  require(active.every(x=>x.status==='passed'&&x.failure_messages.length===0),'an executed case did not pass');
  const normalized=collected.map(x=>{
    require(x && typeof x.file==='string' && typeof x.name==='string','malformed collection identity');
    const file=path.relative(root,x.file).split(path.sep).join('/');
    require(!file.startsWith('../') && !path.isAbsolute(file),'collection names outside owned checkout');
    return file+'\0'+x.name;
  });
  const expected=reported.filter(x=>!['pending','skipped','todo','disabled'].includes(x.status)).map(x=>x.file+'\0'+x.collection_name);
  // Parameterized tests outside the required mapping may share display/full
  // names. Compare the entire multiset so extra or missing instances still fail.
  require(same(sorted(normalized),sorted(expected)),'collection and execution case identities differ');
  const required=files.length?results.filter(x=>files.includes(x.file)):results;
  require(required.length>0 && files.every(file=>required.some(x=>x.file===file)),'required suite omitted');
  require(required.every(x=>x.status==='passed'&&x.failure_messages.length===0),'required suite has skipped, todo, missing or failed cases');
  const ids=required.map(x=>x.id);
  require(new Set(ids).size===ids.length,'ambiguous full test names across required files');
  const requiredNames=reported.filter(x=>!files.length||files.includes(x.file)).map(x=>x.file+'\0'+x.collection_name);
  require(new Set(requiredNames).size===requiredNames.length,'ambiguous collection case identities in required files');
  const reserved=capability==='npm-checks'?['npm-test','npm-check']:[];
  require(same(sorted(cases),sorted([...ids,...reserved])),'mapping must enumerate every required case exactly');
  return {cases:[...ids,...reserved],counts:{total:results.length,passed:active.length,skipped:results.length-active.length,required:required.length,required_skipped:0},assertions:required};
}
function journalRead(root,journalFile) {
  journalFile=statePath(root,journalFile,{existing:true}); const journal=JSON.parse(fs.readFileSync(journalFile,'utf8'));
  require(journal.kind==='acceptance-gate-journal'&&journal.schema_version===1&&journal.root===root&&UUID.test(journal.id||'')
    &&path.basename(journalFile)===`acceptance-${journal.id}-journal.json`&&journal.data_directory===path.join(path.dirname(journalFile),`data-${journal.id}`),'ownership journal invalid');
  return {journal,journalFile};
}
async function acceptanceGroupExists(pid,deadline=Date.now()+1000){
  // Darwin may report EPERM for a group containing only terminating zombies.
  // Probe only: ESRCH is the sole proof of absence. Never signal an EPERM group.
  while(true){
    try{process.kill(-pid,0);return true;}
    catch(error){if(error.code==='ESRCH')return false;if(error.code!=='EPERM'||Date.now()>=deadline)throw error;}
    await sleep(25);
  }
}
export async function reapOwnedAcceptanceGroup(pid){
  require(Number.isInteger(pid)&&pid>1,'owned process group identity invalid');
  if(!await acceptanceGroupExists(pid))return;
  try{process.kill(-pid,'SIGKILL');}
  catch(error){
    if(error.code==='ESRCH')return;
    // The group may have exited between its read-only probe and the signal.
    // A persistent permission error is not cleanup and must remain a refusal.
    if(error.code==='EPERM'&&!await acceptanceGroupExists(pid))return;
    throw error;
  }
  const deadline=Date.now()+1000;
  while(await acceptanceGroupExists(pid,deadline)){
    if(Date.now()>=deadline)throw new Error('Owned acceptance process group remains; inspect before retry');
    await sleep(25);
  }
}
async function stopOwned(journal,journalFile){
  if(!journal.process)return;
  const proc=journal.process;
  require(proc.helper===HELPER&&proc.pid===proc.pgid&&Number.isInteger(proc.pid)&&proc.pid>1&&proc.id===journal.id,'process identity invalid');
  let exists=true;try{process.kill(proc.pid,0);}catch(e){if(e.code==='ESRCH')exists=false;else throw e;}
  if(exists){
    const challenge=randomUUID();writeHostJournal(journalFile+'.control-request.json',{id:journal.id,challenge});
    let verified=false;
    for(let i=0;i<60;i++){
      try{const reply=JSON.parse(fs.readFileSync(journalFile+'.control-response.json','utf8'));if(reply.id===journal.id&&reply.challenge===challenge&&reply.pid===proc.pid){verified=true;break;}}catch(e){if(e.code!=='ENOENT')throw e;}
      await sleep(25);
    }
    require(verified,'process did not answer ownership challenge; inspect before retry');
    try{process.kill(-proc.pgid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
    await sleep(100);await reapOwnedAcceptanceGroup(proc.pgid);return;
  }
  require(!await acceptanceGroupExists(proc.pgid),'orphan acceptance group has no verifiable leader; inspect before retry');
}
function cleanData(journal){
  const stat=fs.lstatSync(journal.data_directory,{throwIfNoEntry:false});if(!stat)return;
  require(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.ino===journal.data?.inode&&stat.dev===journal.data?.device,'unknown data ownership');
  const marker=path.join(journal.data_directory,'.owner.json');
  require(fs.lstatSync(marker).isFile()&&!fs.lstatSync(marker).isSymbolicLink()&&JSON.parse(fs.readFileSync(marker,'utf8')).id===journal.id,'unknown data marker');
  fs.rmSync(journal.data_directory,{recursive:true});require(!fs.existsSync(journal.data_directory),'data cleanup failed');
}
export async function reconcileAcceptanceGate({root,journalFile,packageId,planHash,gate,onJournal=()=>{}}){
  root=fs.realpathSync(root);const loaded=journalRead(root,journalFile);let {journal}=loaded;journalFile=loaded.journalFile;
  require(journal.package_id===packageId&&journal.plan_hash===planHash&&same(journal.gate,gate),'journal identity mismatch');
  if(!['completed','failed','interrupted'].includes(journal.phase))await stopOwned(journal,journalFile);
  if(journal.fixture&&!journal.fixture_cleanup?.verified_absent){journal.fixture_cleanup=reconcileAcceptancePostgres(journal.fixture);writeHostJournal(journalFile,journal);}
  cleanData(journal);journal.cleanup_verified=true;
  if(journal.evidence_file){
    const file=statePath(root,journal.evidence_file,{existing:true});const evidence=JSON.parse(fs.readFileSync(file,'utf8'));
    require(evidence.id===journal.id&&evidence.package_id===packageId&&same(evidence.gate,gate),'journal/evidence mismatch');
    if(!['completed','failed'].includes(journal.phase)){
      evidence.cleanup_verified=true;evidence.fixture_cleanup=journal.fixture_cleanup||null;
      if(context(root).dependencies_sha256!==journal.context.dependencies_sha256||acceptanceHash(context(root))!==acceptanceHash(journal.context)){evidence.passed=false;evidence.blockers.push('Source/configuration environment or installed dependencies changed during execution');}
      evidence.context_unchanged=acceptanceHash(context(root))===acceptanceHash(journal.context);
      writeHostJournal(file,evidence);
    }
    journal.phase=evidence.passed?'completed':'failed';writeHostJournal(journalFile,journal);await onJournal({journalFile,...journal});
    return {file,evidence,summary:`Gate ${gate.id}: ${evidence.passed?'passed':'failed'}`,journalFile};
  }
  journal.phase='interrupted';writeHostJournal(journalFile,journal);await onJournal({journalFile,...journal});
  return {file:null,evidence:null,journalFile,interrupted:true,cleanup_verified:true};
}
export async function runAcceptanceGate({root,packageId,planHash,gate,mapping,outputDir,mutablePaths=[],signal,onJournal=()=>{},timeoutMs=30*60*1000,journalFile:previousJournal}){
  root=fs.realpathSync(root);validateGateInputs({root,packageId,planHash,gate,mapping});
  if(previousJournal){const prior=await reconcileAcceptanceGate({root,journalFile:previousJournal,packageId,planHash,gate,onJournal});if(prior.file)return prior;}
  preflightAcceptanceCapabilities({root,packageId,gates:[gate]});
  require(Number.isFinite(timeoutMs)&&timeoutMs>0,'timeout must be positive');
  outputDir=statePath(root,outputDir);fs.mkdirSync(outputDir,{recursive:true,mode:0o700});
  const id=randomUUID(),journalFile=path.join(outputDir,`acceptance-${id}-journal.json`);
  const journal={schema_version:1,kind:'acceptance-gate-journal',id,root,package_id:packageId,plan_hash:planHash,gate,mapping,mutable_paths:mutablePaths,
    source:snapshotSource(root,mutablePaths),context:context(root),data_directory:path.join(outputDir,`data-${id}`),phase:'planned',process:null,created_at:new Date().toISOString()};
  writeHostJournal(journalFile,journal);await onJournal({journalFile,...journal});
  if(signal?.aborted)return reconcileAcceptanceGate({root,journalFile,packageId,planHash,gate,onJournal});
  // Establish ownership before a cancellable child exists. A hard crash during
  // this synchronous creation still fails closed on an unmarked directory.
  fs.mkdirSync(journal.data_directory,{mode:0o700});
  fs.writeFileSync(path.join(journal.data_directory,'.owner.json'),JSON.stringify({id}),{flag:'wx',mode:0o600});
  const dataStat=fs.statSync(journal.data_directory);
  journal.data={inode:dataStat.ino,device:dataStat.dev,id};
  writeHostJournal(journalFile,journal);
  const fd=fs.openSync(path.join(outputDir,`acceptance-${id}-helper.log`),'wx',0o600);
  const child=spawn(process.execPath,[HELPER,journalFile,id],{cwd:root,env:acceptanceEnvironment('<helper>',journal.context.python),detached:true,shell:false,stdio:['ignore',fd,fd,'ipc']});fs.closeSync(fd);
  let cancelled=false,forceTimer;
  const abort=()=>{cancelled=true;if(child.pid){try{process.kill(-child.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}forceTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},250);}};
  const timer=setTimeout(abort,timeoutMs);signal?.addEventListener('abort',abort,{once:true});
  const ended=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('close',(code,sig)=>resolve({code,signal:sig}));});
  child.once('spawn',()=>{journal.process={pid:child.pid,pgid:child.pid,helper:HELPER,id};journal.phase='running';writeHostJournal(journalFile,journal);Promise.resolve(onJournal({journalFile,...journal})).then(()=>{if(!cancelled&&child.connected)child.send({start:true});}).catch(abort);});
  if(signal?.aborted)abort();const result=await ended;clearTimeout(timer);clearTimeout(forceTimer);signal?.removeEventListener('abort',abort);
  if(child.pid)await reapOwnedAcceptanceGroup(child.pid);
  const current=JSON.parse(fs.readFileSync(journalFile,'utf8'));current.process=null;current.interruption=cancelled?'cancelled':result.error?.code||result.signal||null;writeHostJournal(journalFile,current);
  const reconciled=await reconcileAcceptanceGate({root,journalFile,packageId,planHash,gate,onJournal});
  return {...reconciled,cancelled:signal?.aborted===true,timedOut:cancelled&&!signal?.aborted};
}
// Independent artifact verification is also used for historical completed
// gates. It deliberately does not compare current source after successors edit it.
export function verifyAcceptanceEvidenceArtifacts({root,file}) {
  root=fs.realpathSync(root);
  const canonical=(value)=>{const relative=path.isAbsolute(value)?path.relative(root,value).split(path.sep).join('/'):value;acceptancePath(root,relative);return statePath(root,relative,{existing:true});};
  file=canonical(file);const evidence=JSON.parse(fs.readFileSync(file,'utf8'));
  require(evidence?.schema_version===1&&evidence.kind==='codex-plan-acceptance-gate'&&evidence.root===root,'artifact evidence identity mismatch');
  require(Array.isArray(evidence.artifacts)&&new Set(evidence.artifacts.map(a=>a?.file)).size===evidence.artifacts.length,'artifact inventory is missing or duplicated');
  for(const item of evidence.artifacts){require(item&&typeof item.file==='string'&&!path.isAbsolute(item.file)&&HASH.test(item.sha256||''),'invalid artifact reference');const target=canonical(item.file);require(path.dirname(target)===path.dirname(file)&&fileHash(target)===item.sha256,'evidence artifact changed');}
  const retained=(ref)=>ref&&evidence.artifacts.some(a=>a.file===ref.file&&a.sha256===ref.sha256);
  const build=(value)=>{const names=['BUILD_ID','build-manifest.json','routes-manifest.json','prerender-manifest.json'];require(value&&Array.isArray(value.files)&&same(value.files.map(x=>x.name),names)&&value.files.every(retained)&&acceptanceHash(value.files)===value.sha256,'retained build artifacts are missing or inconsistent');};
  if(evidence.passed&&evidence.gate?.capability==='production-build')build(evidence.build);
  if(evidence.passed&&evidence.gate?.capability==='loopback-browser'){
    const browser=evidence.browser,mapping=evidence.mapping;
    require(evidence.artifacts.some(a=>a.file===evidence.browser_report_file),'browser report hash missing');
    const report=JSON.parse(fs.readFileSync(canonical(evidence.browser_report_file),'utf8'));
    require(same(browser,report),'browser report accounting mismatch');build(browser?.build);
    require(browser.build_sha256===browser.build.sha256&&browser.source_sha256===evidence.source?.sha256,'browser build or source identity mismatch');
    const origin=new URL(browser.origin);require(origin.protocol==='http:'&&origin.hostname==='127.0.0.1'&&/^\d+$/.test(origin.port)&&origin.pathname==='/'&&!origin.search&&!origin.hash&&!origin.username&&!origin.password,'browser origin is not owned loopback');
    require(Array.isArray(browser.cases)&&Array.isArray(browser.screenshots)&&Array.isArray(mapping?.cases),'browser cases missing');
    require(same(sorted(browser.cases.map(c=>c.id)),sorted(mapping.cases))&&browser.cases.every(c=>c.passed===true&&Number.isInteger(c.assertions)&&c.assertions>0&&c.failure===null),'browser case assertions failed, skipped or omitted');
    require(same(sorted(browser.screenshots.map(c=>c.case_id)),sorted(mapping.cases))&&browser.screenshots.every(retained),'browser screenshots missing or duplicated');
    for(const screenshot of browser.screenshots){const bytes=fs.readFileSync(canonical(screenshot.file));require(bytes.length>8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'browser screenshot is not PNG evidence');}
  }
  return evidence;
}
export function verifyAcceptanceGate({root,packageId,planHash,gate,mapping,file,mutablePaths=[],checkSource=true}){
  root=fs.realpathSync(root);validateGateInputs({root,packageId,planHash,gate,mapping});file=statePath(root,file,{existing:true});
  const evidence=verifyAcceptanceEvidenceArtifacts({root,file});
  require(evidence.schema_version===1&&evidence.kind==='codex-plan-acceptance-gate'&&UUID.test(evidence.id||'')&&evidence.root===root&&evidence.package_id===packageId&&evidence.plan_hash===planHash,'evidence identity mismatch');
  require(same(evidence.gate,gate)&&same(evidence.mapping,mapping)&&evidence.mapping_sha256===acceptanceHash(mapping),'mapping/capability mismatch');
  require(typeof evidence.passed==='boolean'&&Array.isArray(evidence.blockers)&&evidence.cleanup_verified===true,'cleanup unverified or status invalid');
  require(!evidence.passed||(evidence.blockers.length===0&&evidence.source_unchanged===true&&evidence.context_unchanged===true),'passing evidence has failures or changed inputs');
  require(Array.isArray(evidence.checks)&&evidence.checks.every(x=>Number.isInteger(x.exit_code)&&typeof x.passed==='boolean'),'invalid check result');
  require(!evidence.passed||(evidence.checks.length>0&&evidence.checks.every(x=>x.exit_code===0&&x.passed===true)),'a required check did not pass');
  const {sha256,...inventory}=evidence.source;require(acceptanceHash(inventory)===sha256,'source inventory hash mismatch');
  require(!evidence.passed||evidence.source_after_sha256===sha256,'source changed in a passing gate');
  require(same(evidence.source.excluded_paths,sorted([...new Set(mutablePaths)])),'source exclusions mismatch');
  for(const artifact of evidence.artifacts){const target=statePath(root,artifact.file,{existing:true});require(path.dirname(target)===path.dirname(file)&&fileHash(target)===artifact.sha256,'evidence artifact changed');}
  require(evidence.checks.every(check=>evidence.artifacts.some(a=>a.file===check.log_file&&a.sha256===check.log_sha256)),'check log hashes missing');
  require(Array.isArray(evidence.cases)&&(!evidence.passed||same(sorted(evidence.cases),sorted(mapping.cases))),'required cases missing from evidence');
  const commands=evidence.checks.map(check=>check.argv);
  const expectedCommands=gate.capability==='production-build'||gate.capability==='loopback-browser'?[[process.execPath,evidence.context.npm,'run','build']]:[[process.execPath,path.join(root,'node_modules/vitest/vitest.mjs'),'list',...(gate.capability==='synthetic-postgres'?mapping.files:[]),'--json',path.join(path.dirname(file),`${evidence.id}-collection.json`)],[process.execPath,evidence.context.npm,'test','--',...(gate.capability==='synthetic-postgres'?mapping.files:[]),'--reporter=json',`--outputFile=${path.join(path.dirname(file),`${evidence.id}-report.json`)}`],...(gate.capability==='npm-checks'?[[process.execPath,evidence.context.npm,'run','check']]:[])];
  require(commands.every((argv,index)=>same(argv,expectedCommands[index]))&&(!evidence.passed||commands.length===expectedCommands.length),'check argv is not the fixed adapter command');
  if(evidence.passed&&gate.capability==='synthetic-postgres')require(evidence.fixture?.marker_verified===true&&evidence.fixture.package_id===packageId&&evidence.fixture.plan_hash===planHash&&evidence.fixture_cleanup?.verified_absent===true&&evidence.fixture_cleanup.container_id===evidence.fixture.container_id,'PostgreSQL marker or cleanup invalid');
  if(evidence.passed&&['npm-checks','synthetic-postgres'].includes(gate.capability)){
    require(evidence.artifacts.some(a=>a.file===evidence.report_file)&&evidence.artifacts.some(a=>a.file===evidence.collection_file),'report hashes missing');
    const report=JSON.parse(fs.readFileSync(statePath(root,evidence.report_file,{existing:true}),'utf8'));
    const collected=JSON.parse(fs.readFileSync(statePath(root,evidence.collection_file,{existing:true}),'utf8'));
    const parsed=parseAcceptanceReport({report,collected,root:evidence.checkout,files:mapping.files,cases:mapping.cases,capability:gate.capability});require(same(parsed,evidence.results),'test report accounting mismatch');
  }
  if(evidence.passed&&gate.capability==='loopback-browser')require(evidence.browser?.source_sha256===sha256&&HASH.test(evidence.browser.build_sha256||'')&&evidence.browser.screenshots.length===mapping.cases.length&&evidence.browser.screenshots.every(s=>mapping.cases.includes(s.case_id)&&evidence.artifacts.some(a=>a.file===s.file&&a.sha256===s.sha256)),'browser case/build/screenshot evidence missing');
  if(checkSource){require(snapshotSource(root,mutablePaths).sha256===sha256,'source snapshot is stale');require(same(context(root),evidence.context),'dependency or environment identity is stale');}
  return {file,evidence,summary:`Gate ${gate.id}: ${evidence.passed?'passed':'failed'}; ${evidence.cases.length} required case IDs`,journalFile:evidence.journal_file};
}
