import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { launchBackground, inspectBackground, stopBackground, backgroundLogs, latestBackground, publicProjection, runBackgroundChild } from './background-control.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const handler = `import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function run({args,signal,ready}) {
 const file=path.join(args.root,'.codex-plan-runner/test/plan.lock'),token=randomUUID();
 try {fs.writeFileSync(file,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});}
 catch(e) {if(e.code==='EEXIST')return {code:2,accepted:false,cleanup_verified:true,summary:{duplicate:true}};throw e;}
 try {
  if(args.readyDelay)await delay(args.readyDelay);
  if(signal.aborted)return {code:130,accepted:false,cleanup_verified:true,summary:{checks:0}};
  await ready({file,token:args.badLock?randomUUID():token});
  if(args.manual)return {code:2,accepted:false,cleanup_verified:true,summary:{unfinished:1,packages:[{id:'02',status:'pending',manual:true}]}};
  fs.appendFileSync(path.join(args.root,'workers.txt'),process.pid+'\\n');
  if(args.wait) await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true})});
  else await delay(args.duration||50);
  return {code:signal.aborted?130:0,accepted:!signal.aborted&&!args.incomplete,cleanup_verified:!args.unknownCleanup,summary:{checks:args.incomplete?0:1}};
 }finally {
  if(args.rotateLock)fs.writeFileSync(file,JSON.stringify({pid:process.pid,token:randomUUID()}));
  else if(args.malformedLock)fs.writeFileSync(file,'{}');
  else if(!args.leakLock)fs.unlinkSync(file);
 }
}
`;
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'background package02 ')));
  fs.mkdirSync(path.join(root,'.codex-plan-runner/test'),{recursive:true});
  const moduleFile = path.join(root,'handler.mjs'); fs.writeFileSync(moduleFile,handler);
  const options = {root,stateDir:'.codex-plan-runner/test',moduleFile,identity:{plan_id:'test',selected:['01']}};
  const expectedFailedCleanup = new Set(), ownedChildren = new Set();
  const cleanup = async () => {
    if (!fs.existsSync(root)) return;
    for (const child of ownedChildren) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Owned fixture child did not exit; retained: ${root}`)), 10000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
      child.kill('SIGTERM'); // The original spawn handle, never a stored PID.
      await closed;
    }
    const directory = path.join(root, options.stateDir, 'background');
    if (fs.existsSync(directory)) for (const id of fs.readdirSync(directory)) {
      const sessionFile = path.join(directory, id, 'session.json'), spawnFile = path.join(directory, id, 'spawn.json');
      // Only launchBackground-created child sessions belong to this fixture.
      // Forged unknown-PID records and the in-process controller test have no spawn journal.
      if (!fs.existsSync(spawnFile)) continue;
      const spawned = JSON.parse(fs.readFileSync(spawnFile)), session = JSON.parse(fs.readFileSync(sessionFile));
      assert.equal(spawned.id, session.id); assert.equal(spawned.owner, session.owner);
      const resultFile = path.join(directory, id, 'result.json');
      const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile)) : null;
      if (result?.cleanup_verified === false && expectedFailedCleanup.has(sessionFile)) {
        // These negative tests use a fixed handler that creates only its plan
        // lock. Keep its failed result false; verify actual child/wake absence.
        await absent(spawned.pid, root);
      } else {
        const stopped = await stopBackground(sessionFile);
        assert.equal(stopped.cleanup_verified, true, `Fixture retained: ${root}`);
        assert.equal(stopped.leader_exit_verified, true);
      }
      const wakeFile = path.join(directory, id, 'wake.json');
      if (fs.existsSync(wakeFile)) {
        const wake = JSON.parse(fs.readFileSync(wakeFile));
        assert.equal(wake.cleanup_verified, true, `Wake cleanup unresolved; fixture retained: ${root}`);
        if (wake.pid) await absent(wake.pid, root);
      }
    }
    fs.rmSync(root,{recursive:true,force:true});
  };
  t.after(cleanup);
  return {root,options,cleanup,ownChild:child=>ownedChildren.add(child),allowFailedCleanup:file=>expectedFailedCleanup.add(file),launch:args=>launchBackground({...options,args:{root,...args}})};
}
async function absent(pid, root) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    assert.ok(Date.now() < deadline, `Owned child exit unverified; fixture retained: ${root}`);
    await delay(25);
  }
}

async function final(file) {
  for(let n=0;n<200;n++) {
    const value=inspectBackground(file);
    if(['completed','failed','interrupted','incomplete'].includes(value.phase))return value;
    await delay(25);
  }
  throw new Error('Synthetic background run did not finish');
}

test('launch readiness requires the child plan lock and completion persists privately',async t=>{
  const f=fixture(t),s=await f.launch({duration:150});
  assert.equal(s.launched,true);assert.ok(s.ready_at);assert.equal(s.pid,JSON.parse(fs.readFileSync(s.lock.file)).pid);
  const r=await final(s.session_file);assert.equal(r.phase,'completed');assert.equal(r.accepted,true);assert.equal(r.cleanup_verified,true);
  for(const name of ['session.json','result.json','raw.log'])assert.equal(fs.statSync(path.join(path.dirname(s.session_file),name)).mode&0o777,0o600);
});

test('closed launcher stdio and unrelated cwd do not terminate the owned run',async t=>{
  const f=fixture(t),url=new URL('./background-control.mjs',import.meta.url).href;
  const script=`import {launchBackground} from ${JSON.stringify(url)};const r=await launchBackground(${JSON.stringify({...f.options,args:{root:f.root,duration:350}})});console.log(JSON.stringify(r));`;
  const output=execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:os.tmpdir(),encoding:'utf8',timeout:5000});
  const s=JSON.parse(output);assert.equal(s.launched,true);
  const r=await final(s.session_file);assert.equal(r.phase,'completed');assert.equal(fs.readFileSync(path.join(f.root,'workers.txt'),'utf8').trim().split('\n').length,1);
});

test('concurrent launches share the authoritative plan lock and only one worker starts',async t=>{
  const f=fixture(t),attempts=await Promise.allSettled([f.launch({wait:true}),f.launch({wait:true})]);
  const running=attempts.filter(s=>s.status==='fulfilled').map(s=>s.value);assert.equal(running.length,1);
  assert.equal(attempts.filter(s=>s.status==='rejected').length,1);
  assert.match(attempts.find(s=>s.status==='rejected').reason.message,/Background admission/);
  assert.equal(fs.readFileSync(path.join(f.root,'workers.txt'),'utf8').trim().split('\n').length,1);
  const stopped=await stopBackground(running[0].session_file);assert.equal(stopped.phase,'interrupted');assert.equal(stopped.cleanup_verified,true);
});

test('an invalid readiness lock never reports a launched or accepted run',async t=>{
  const f=fixture(t),s=await f.launch({badLock:true});assert.equal(s.launched,false);assert.equal(s.phase,'failed');assert.equal(s.accepted,false);assert.equal(s.cleanup_verified,false);f.allowFailedCleanup(s.session_file);
  assert.equal(fs.existsSync(path.join(f.root,'workers.txt')),false);
});

test('zero exit with unfinished criteria remains incomplete',async t=>{
  const f=fixture(t),s=await f.launch({incomplete:true});const r=await final(s.session_file);
  assert.equal(r.exit_code,0);assert.equal(r.phase,'incomplete');assert.equal(r.accepted,false);
});

test('readiness timeout leaves a durable controllable session instead of false running',async t=>{
  const f=fixture(t),s=await launchBackground({...f.options,args:{root:f.root,readyDelay:250,wait:true},readinessMs:50});
  assert.equal(s.launched,false);assert.equal(s.phase,'starting');assert.ok(fs.existsSync(s.session_file));
  const r=await stopBackground(s.session_file);assert.equal(r.phase,'interrupted');assert.equal(r.accepted,false);
});

test('an unrelated live PID and stale response cannot authorize a signal',async t=>{
  const f=fixture(t),child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});
  f.ownChild(child);
  const id=randomUUID(),owner=randomUUID(),dir=path.join(f.root,'.codex-plan-runner/test/background',id);fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'session.json');
  fs.writeFileSync(file,JSON.stringify({schema_version:1,id,owner,root:f.root,pid:child.pid,phase:'running'}));
  fs.writeFileSync(path.join(dir,'response.json'),JSON.stringify({id,owner,pid:child.pid,challenge:randomUUID(),action:'stop'}));
  await assert.rejects(stopBackground(file,{timeoutMs:100}),/fresh ownership challenge/);
  assert.equal(child.exitCode,null);assert.doesNotThrow(()=>process.kill(child.pid,0));
});

test('unverified cleanup cannot become a successful stop report',async t=>{
  const f=fixture(t),s=await f.launch({wait:true,unknownCleanup:true});
  await assert.rejects(stopBackground(s.session_file),/unresolved cleanup/);
  const r=await final(s.session_file);assert.equal(r.accepted,false);assert.equal(r.cleanup_verified,false);f.allowFailedCleanup(s.session_file);
});

test('returned worker with a leaked plan lock cannot be accepted',async t=>{
  const f=fixture(t),s=await f.launch({leakLock:true});const r=await final(s.session_file);
  assert.equal(r.phase,'failed');assert.equal(r.accepted,false);assert.equal(r.cleanup_verified,false);assert.match(r.diagnostic,/before releasing/);f.allowFailedCleanup(s.session_file);
});

test('symlink control paths are rejected without writing to their target',async t=>{
  const f=fixture(t),s=await f.launch({wait:true}),victim=path.join(f.root,'victim.txt');fs.writeFileSync(victim,'keep');
  const control=path.join(path.dirname(s.session_file),'control.json');fs.symlinkSync(victim,control);
  await assert.rejects(stopBackground(s.session_file),/symlink/);assert.equal(fs.readFileSync(victim,'utf8'),'keep');
  fs.unlinkSync(control);await stopBackground(s.session_file);
});

test('a contradictory final completion record is rejected',async t=>{
  const f=fixture(t),s=await f.launch({incomplete:true});await final(s.session_file);
  const file=path.join(path.dirname(s.session_file),'result.json'),r=JSON.parse(fs.readFileSync(file));
  const original=fs.readFileSync(file);r.phase='completed';fs.writeFileSync(file,JSON.stringify(r));
  try { assert.throws(()=>inspectBackground(s.session_file),/completion mismatch/); }
  finally { fs.writeFileSync(file,original); }
});

for (const change of ['rotateLock','malformedLock']) test(`changed leaked lock still prevents completion (${change})`,async t=>{
  const f=fixture(t),s=await f.launch({[change]:true});const r=await final(s.session_file);
  assert.equal(r.phase,'failed');assert.equal(r.accepted,false);assert.equal(r.cleanup_verified,false);assert.match(r.diagnostic,/plan lock/);f.allowFailedCleanup(s.session_file);
});

test('failed status cannot retain accepted true in a forged final record',async t=>{
  const f=fixture(t),s=await f.launch({});await final(s.session_file);
  const file=path.join(path.dirname(s.session_file),'result.json'),r=JSON.parse(fs.readFileSync(file));
  const original=fs.readFileSync(file);r.phase='failed';r.exit_code=1;fs.writeFileSync(file,JSON.stringify(r));
  try { assert.throws(()=>inspectBackground(s.session_file),/completion mismatch/); }
  finally { fs.writeFileSync(file,original); }
});


test('presentation reports and log viewing omit secrets and ownership tokens',async t=>{
  const f=fixture(t),s=await f.launch({wait:true}),privateState=JSON.parse(fs.readFileSync(s.session_file));
  const secret='sk-background_secret_123456789012345';
  fs.appendFileSync(path.join(path.dirname(s.session_file),'raw.log'),`Bearer ${secret}\nowner=${privateState.owner}\nlock=${privateState.lock.token}\napi_key=${secret}\n`);
  const logs=backgroundLogs(s.session_file);
  for(const value of [secret,privateState.owner,privateState.lock.token])assert.equal(logs.includes(value),false);
  for(const value of [JSON.stringify(s),JSON.stringify(inspectBackground(s.session_file))]){
    assert.equal(value.includes(privateState.owner),false);assert.equal(value.includes(privateState.lock.token),false);assert.equal(value.includes('"args"'),false);
  }
  await stopBackground(s.session_file);
  for(const name of ['result.json','result.txt']){
    const output=fs.readFileSync(path.join(path.dirname(s.session_file),name),'utf8');
    assert.equal(output.includes(privateState.owner),false);assert.equal(output.includes(privateState.lock.token),false);
  }
});

test('source binding drift after spawn fails before handler imports and workers',async t=>{
  const f=fixture(t),bound=path.join(f.root,'frozen.txt');fs.writeFileSync(bound,'original');
  const sha256=createHash('sha256').update('original').digest('hex');
  const pending=launchBackground({...f.options,args:{root:f.root},identity:{...f.options.identity,binding_files:[{file:bound,sha256}]}});
  fs.writeFileSync(bound,'changed');
  const s=await pending;assert.equal(s.launched,false);assert.equal(s.accepted,false);assert.match(s.diagnostic,/binding changed/);assert.equal(s.cleanup_verified,false);f.allowFailedCleanup(s.session_file);
  assert.equal(fs.existsSync(path.join(f.root,'workers.txt')),false);
});

test('a launch entry changed after spawn fails before module import',async t=>{
  const f=fixture(t),pending=f.launch({});fs.appendFileSync(f.options.moduleFile,'\n// changed after launch\n');
  const s=await pending;assert.equal(s.launched,false);assert.match(s.diagnostic,/entry changed/);assert.equal(s.cleanup_verified,false);f.allowFailedCleanup(s.session_file);
  assert.equal(fs.existsSync(path.join(f.root,'workers.txt')),false);
});

test('SIGHUP cannot terminate a detached owned controller',async t=>{
  const f=fixture(t),s=await f.launch({wait:true});process.kill(s.pid,'SIGHUP');await delay(80);
  assert.equal(inspectBackground(s.session_file).phase,'running');
  const result=await stopBackground(s.session_file);assert.equal(result.phase,'interrupted');assert.equal(result.cleanup_verified,true);
});

test('latest session prefers the active owner over a losing duplicate',async t=>{
  const f=fixture(t),s=await f.launch({wait:true});await assert.rejects(f.launch({}),/Background admission/);
  assert.equal(latestBackground(f.options.stateDir,f.root),s.session_file);
  await stopBackground(s.session_file);
  const next=await f.launch({});await final(next.session_file);
  assert.equal(latestBackground(f.options.stateDir,f.root),next.session_file);
});

test('background completion includes a cleaned owned wake journal',async t=>{
  const f=fixture(t),s=await f.launch({});const result=await final(s.session_file);
  const wake=JSON.parse(fs.readFileSync(path.join(path.dirname(s.session_file),'wake.json')));
  assert.equal(wake.cleanup_verified,true);assert.equal(result.wake.cleanup_verified,true);
  if(process.platform==='darwin')assert.throws(()=>process.kill(wake.pid,0),{code:'ESRCH'});
  else assert.equal(wake.phase,'disabled');
});

test('unsafe session and log paths cannot disclose symlink targets',async t=>{
  const f=fixture(t),s=await f.launch({});await final(s.session_file);
  const log=path.join(path.dirname(s.session_file),'raw.log'),victim=path.join(f.root,'private.txt');fs.writeFileSync(victim,'private data');
  const original=fs.readFileSync(log);fs.unlinkSync(log);fs.symlinkSync(victim,log);
  try { assert.throws(()=>backgroundLogs(s.session_file),/symlink/); }
  finally { fs.unlinkSync(log);fs.writeFileSync(log,original); }
});


test('nested summaries redact credential URIs and remove alternate ownership token fields',()=>{
 const output=JSON.stringify(publicProjection({next_action:'inspect postgres://private:password@example.test/db',nested:{ownership_token:'private-token',lock_token:'another-token'},retry:{token_pressure:2}}));
 assert.equal(output.includes('private:password'),false);assert.equal(output.includes('private-token'),false);assert.equal(output.includes('another-token'),false);
 assert.match(output,/token_pressure/);
});

test('a manual boundary with code two is incomplete and never accepted', async t => {
  const f = fixture(t), s = await f.launch({ manual: true }), result = await final(s.session_file);
  assert.equal(result.phase, 'incomplete'); assert.equal(result.exit_code, 2);
  assert.equal(result.accepted, false); assert.equal(result.cleanup_verified, true);
});

test('unexpected wake loss aborts the actual controller and cannot become accepted completion', async t => {
  const f = fixture(t), id = randomUUID(), owner = randomUUID(), directory = path.join(f.root, '.codex-plan-runner/test/background', id);
  fs.mkdirSync(directory, { recursive: true });
  const sessionFile = path.join(directory, 'session.json');
  fs.writeFileSync(sessionFile, JSON.stringify({ schema_version: 1, id, owner, root: f.root, identity: f.options.identity,
    module_file: f.options.moduleFile, module_sha256: createHash('sha256').update(fs.readFileSync(f.options.moduleFile)).digest('hex'),
    args: { root: f.root, wait: true }, pid: null, phase: 'starting', created_at: new Date().toISOString() }));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const child = new EventEmitter(); let finished = false, timer;
  Object.assign(child, { pid: 2146000999, unref() {}, kill() { assert.fail('an already lost helper must not receive signals'); } });
  t.mock.method(childProcess, 'spawn', (file, args) => {
    assert.equal(file, '/usr/bin/caffeinate'); assert.deepEqual(args, ['-i', '-w', String(process.pid)]);
    queueMicrotask(() => child.emit('spawn'));
    timer = setTimeout(() => { finished = true; child.emit('close', 9, null); }, 150);
    return child;
  });
  t.after(() => clearTimeout(timer));
  const kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid !== child.pid) return kill(pid, signal);
    assert.equal(signal, 0); if (finished) throw Object.assign(new Error('absent synthetic child'), { code: 'ESRCH' }); return true;
  });
  assert.equal(await runBackgroundChild(sessionFile), 1);
  const result = inspectBackground(sessionFile), wake = JSON.parse(fs.readFileSync(path.join(directory, 'wake.json')));
  assert.equal(result.phase, 'failed'); assert.equal(result.accepted, false); assert.equal(result.cleanup_verified, true);
  assert.equal(result.wake.unexpected_exit, true); assert.equal(wake.phase, 'failed'); assert.equal(wake.exit.code, 9);
  assert.match(result.diagnostic, /exited while its owner/); assert.equal(fs.existsSync(path.join(f.root, '.codex-plan-runner/test/plan.lock')), false);
});

test('session reads retain a complete opened snapshot during atomic pathname replacement', async t => {
  const f = fixture(t), s = await f.launch({}); await final(s.session_file);
  const original = fs.readFileSync(s.session_file), open = fs.openSync.bind(fs); let replaced = false, openedLinks;
  t.mock.method(fs, 'openSync', (file, flags, mode) => {
    const fd = open(file, flags, mode);
    if (file === s.session_file && !replaced && typeof flags === 'number') {
      replaced = true;
      const next = file + '.replacement'; fs.writeFileSync(next, original, { flag: 'wx', mode: 0o600 }); fs.renameSync(next, file);
      openedLinks = fs.fstatSync(fd).nlink;
    }
    return fd;
  });
  const result = inspectBackground(s.session_file);
  assert.equal(replaced, true); assert.equal(openedLinks, 0, 'the opened old snapshot was unlinked by atomic replacement');
  assert.equal(result.phase, 'completed'); assert.equal(result.accepted, true);
});

test('opened session snapshots still reject hard links and final symlinks', async t => {
  const f = fixture(t), s = await f.launch({}); await final(s.session_file);
  const bytes = fs.readFileSync(s.session_file), linked = path.join(f.root, 'retained-session.json'); fs.linkSync(s.session_file, linked);
  assert.throws(() => inspectBackground(s.session_file), /private regular files/);
  fs.unlinkSync(s.session_file); fs.symlinkSync(linked, s.session_file);
  assert.throws(() => inspectBackground(s.session_file), error => error.code === 'ELOOP');
  assert.deepEqual(fs.readFileSync(linked), bytes);
  fs.unlinkSync(s.session_file);fs.unlinkSync(linked);fs.writeFileSync(s.session_file,bytes,{mode:0o600});
});


test('fixture teardown stops an unfinished controller and verifies exit before deleting its directory', async t => {
  const f = fixture(t), session = await f.launch({ wait: true });
  assert.equal(inspectBackground(session.session_file).phase, 'running');
  await f.cleanup();
  assert.equal(fs.existsSync(f.root), false);
  assert.throws(() => process.kill(session.pid, 0), error => error.code === 'ESRCH');
});

test('fixture teardown retains ownership records when cooperative stop fails', async t => {
  const f = fixture(t), session = await f.launch({ wait: true });
  const target = path.join(f.root, 'synthetic-control-target'), control = path.join(path.dirname(session.session_file), 'control.json');
  fs.writeFileSync(target, 'preserve');fs.symlinkSync(target, control);
  try {
    await assert.rejects(f.cleanup(), /symlink/);
    assert.equal(fs.existsSync(session.session_file), true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
    assert.doesNotThrow(() => process.kill(session.pid, 0));
  } finally {
    fs.unlinkSync(control);
    await f.cleanup();
  }
  assert.equal(fs.existsSync(f.root), false);
  assert.throws(() => process.kill(session.pid, 0), error => error.code === 'ESRCH');
});
