import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { startOwnedWake } from './owned-wake.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'wake-draft-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('disabled wake is explicit and launches no helper',async t=>{
  const root=fixture(t),lease=await startOwnedWake({root,journalFile:'.codex-plan-runner/test/wake.json',enabled:false});
  assert.equal(lease.record.phase,'disabled');assert.equal(lease.record.pid,null);assert.equal((await lease.stop()).cleanup_verified,true);
});

test('macOS helper is owned, journaled and removed by explicit stop',async t=>{
  if(process.platform!=='darwin'){const root=fixture(t),lease=await startOwnedWake({root,journalFile:'.codex-plan-runner/test/wake.json'});assert.equal(lease.record.phase,'disabled');return;}
  const root=fixture(t),file='.codex-plan-runner/test/wake.json',lease=await startOwnedWake({root,journalFile:file});
  t.after(()=>lease.stop());assert.equal(lease.record.owner_pid,process.pid);assert.equal(lease.record.phase,'running');
  assert.equal(fs.statSync(path.join(root,file)).mode&0o777,0o600);assert.doesNotThrow(()=>process.kill(lease.record.pid,0));
  const stopped=await lease.stop();assert.equal(stopped.cleanup_verified,true);assert.equal(stopped.phase,'stopped');
  assert.throws(()=>process.kill(stopped.pid,0),{code:'ESRCH'});assert.deepEqual(await lease.stop(),stopped);
});

test('macOS helper releases when its original owner exits',async t=>{
  if(process.platform!=='darwin'){const root=fixture(t),lease=await startOwnedWake({root,journalFile:'.codex-plan-runner/test/wake.json'});assert.equal(lease.record.phase,'disabled');return;}
  const root=fixture(t),url=new URL('./owned-wake.mjs',import.meta.url).href;
  const code=`import {startOwnedWake} from ${JSON.stringify(url)};const l=await startOwnedWake(${JSON.stringify({root,journalFile:'.codex-plan-runner/test/wake.json'})});console.log(l.record.pid);process.exit(0);`;
  const pid=Number(execFileSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:5000}).trim());
  let absent=false;for(let n=0;n<100;n++){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH'){absent=true;break;}throw error;}await delay(25);}
  assert.equal(absent,true,'caffeinate -w must release when its original process exits');
});

test('wake journal cannot overwrite a prior lease or follow a symlink',async t=>{
  const root=fixture(t),file='.codex-plan-runner/test/wake.json';await startOwnedWake({root,journalFile:file,enabled:false});
  await assert.rejects(startOwnedWake({root,journalFile:file,enabled:false}),/prior wake journal/);
  fs.symlinkSync(path.join(root,file),path.join(root,'.codex-plan-runner/test/linked.json'));
  await assert.rejects(startOwnedWake({root,journalFile:'.codex-plan-runner/test/linked.json',enabled:false}),/symlink/);
});

function synthetic(t, behavior = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const realKill = process.kill.bind(process), children = [], signals = [], probes = [];
  let denyAbsence = false;
  t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    assert.equal(executable, '/usr/bin/caffeinate');
    assert.deepEqual(args, ['-i', '-w', String(process.pid)]);
    assert.deepEqual(options, { stdio: 'ignore' });
    if (behavior.throwSpawn) throw Object.assign(new Error('synthetic spawn failure'), { code: 'EACCES' });
    const child = new EventEmitter();
    Object.assign(child, { pid: 2146000000 + children.length, exitCode: null, signalCode: null, unref: () => { child.unreferenced = true; } });
    child.finish = (code = 0, signal = null) => {
      if (child.finished) return;
      child.finished = true; child.exitCode = code; child.signalCode = signal; child.emit('close', code, signal);
    };
    child.kill = signal => {
      signals.push({ pid: child.pid, signal });
      if (behavior.signalError) throw Object.assign(new Error('synthetic signal permission refusal'), { code: 'EPERM' });
      if (behavior.ignoreAll || (behavior.ignoreTerm && signal === 'SIGTERM')) return true;
      queueMicrotask(() => child.finish(null, signal)); return true;
    };
    children.push(child);
    queueMicrotask(() => {
      if (behavior.spawnError) child.emit('error', Object.assign(new Error('synthetic missing helper'), { code: 'ENOENT' }));
      else { child.emit('spawn'); if (behavior.earlyExit !== undefined) child.finish(behavior.earlyExit); }
    });
    return child;
  });
  t.mock.method(process, 'kill', (pid, signal) => {
    const child = children.find(item => item.pid === pid);
    if (!child) return realKill(pid, signal);
    probes.push({ pid, signal }); assert.equal(signal, 0, 'synthetic persisted PIDs must never receive signals');
    if (child.finished && !denyAbsence) throw Object.assign(new Error('synthetic absent PID'), { code: 'ESRCH' });
    if (child.finished && denyAbsence === 'EPERM') throw Object.assign(new Error('synthetic unknown PID'), { code: 'EPERM' });
    return true;
  });
  return { children, signals, probes, denyAbsence: value => { denyAbsence = value; } };
}
const journalName = '.codex-plan-runner/test/wake.json';
const readRecord = root => JSON.parse(fs.readFileSync(path.join(root, journalName), 'utf8'));
const renameFault = (t, root, predicate) => {
  const rename = fs.renameSync.bind(fs), file = path.join(root, journalName);
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file && predicate(JSON.parse(fs.readFileSync(from, 'utf8')))) throw Object.assign(new Error('synthetic journal storage failure'), { code: 'ENOSPC' });
    return rename(from, to);
  });
};

for (const mode of ['throwSpawn', 'spawnError']) test('spawn failure keeps a truthful private receipt: ' + mode, async t => {
  const root = fixture(t), fake = synthetic(t, { [mode]: true });
  await assert.rejects(startOwnedWake({ root, journalFile: journalName }), error => {
    assert.equal(error.cleanup_verified, true); assert.equal(error.wake_record.pid, null); return true;
  });
  const record = readRecord(root); assert.equal(record.phase, 'failed'); assert.equal(record.cleanup_verified, true);
  assert.equal(fake.signals.length, 0);
});

for (const earlyExit of [0, 7]) test('helper exit during startup is not readiness: ' + earlyExit, async t => {
  const root = fixture(t), fake = synthetic(t, { earlyExit });
  await assert.rejects(startOwnedWake({ root, journalFile: journalName }), error => error.code === 'WAKE_STARTUP' && error.cleanup_verified);
  assert.equal(readRecord(root).phase, 'failed'); assert.equal(readRecord(root).ready_at, undefined); assert.equal(fake.signals.length, 0);
});

test('unexpected helper loss is journaled and delivered once without hiding failure on stop', async t => {
  const root = fixture(t), fake = synthetic(t), observed = [];
  const lease = await startOwnedWake({ root, journalFile: journalName, onUnexpectedExit: event => observed.push(event) });
  fake.children[0].finish(9);
  const loss = await lease.lost; await delay(0);
  assert.equal(loss.phase, 'failed'); assert.equal(loss.unexpected_exit, true); assert.equal(loss.exit.code, 9);
  assert.equal(loss.cleanup_verified, true); assert.equal(observed.length, 1); assert.equal(readRecord(root).phase, 'failed');
  const stopped = await lease.stop(); assert.equal(stopped.phase, 'failed'); assert.equal(stopped.cleanup_verified, true); assert.equal(fake.signals.length, 0);
});

test('a hanging loss observer cannot prevent explicit cleanup', async t => {
  const root = fixture(t), fake = synthetic(t);
  const lease = await startOwnedWake({ root, journalFile: journalName, onUnexpectedExit: () => new Promise(() => {}) });
  fake.children[0].finish(3); await lease.lost;
  const stopped = await lease.stop(); assert.equal(stopped.cleanup_verified, true); assert.equal(stopped.phase, 'failed');
});

test('post-spawn journal failure verifies cleanup and preserves helper identity', async t => {
  const root = fixture(t), fake = synthetic(t); let once = true;
  renameFault(t, root, record => record.phase === 'starting' && once && !(once = false));
  await assert.rejects(startOwnedWake({ root, journalFile: journalName }), error => {
    assert.equal(error.code, 'ENOSPC'); assert.equal(error.cleanup_verified, true); assert.equal(error.wake_record.pid, fake.children[0].pid); return true;
  });
  assert.deepEqual(fake.signals.map(item => item.signal), ['SIGTERM']);
  const record = readRecord(root); assert.equal(record.phase, 'failed'); assert.equal(record.pid, fake.children[0].pid); assert.equal(record.cleanup_verified, true);
});

test('post-spawn storage and cleanup failures retain an actionable unresolved identity', async t => {
  const root = fixture(t), fake = synthetic(t, { ignoreAll: true });
  renameFault(t, root, () => true);
  await assert.rejects(startOwnedWake({ root, journalFile: journalName }), error => {
    assert.equal(error.code, 'WAKE_UNRESOLVED'); assert.equal(error.cleanup_verified, false);
    assert.equal(error.wake_record.pid, fake.children[0].pid); assert.equal(error.wake_record.phase, 'unresolved');
    assert.equal(error.journal_file, path.join(root, journalName)); assert.match(error.message, /Cleanup/); return true;
  });
  assert.deepEqual(fake.signals.map(item => item.signal), ['SIGTERM', 'SIGKILL']);
  assert.equal(readRecord(root).pid, null, 'failed storage must not be mistaken for a durable PID update');
  fake.children[0].finish(null, 'SIGKILL'); // Synthetic EventEmitter only; no OS process exists.
});

test('owned cleanup escalates a stubborn live handle and confirms absence', async t => {
  const root = fixture(t), fake = synthetic(t, { ignoreTerm: true });
  const lease = await startOwnedWake({ root, journalFile: journalName });
  const result = await lease.stop(); assert.equal(result.cleanup_verified, true);
  assert.deepEqual(fake.signals.map(item => item.signal), ['SIGTERM', 'SIGKILL']);
});

test('failed owned signaling remains unresolved without claiming cleanup', async t => {
  const root = fixture(t), fake = synthetic(t, { signalError: true });
  const lease = await startOwnedWake({ root, journalFile: journalName });
  await assert.rejects(lease.stop(), error => error.code === 'WAKE_UNRESOLVED' && !error.cleanup_verified);
  assert.equal(readRecord(root).phase, 'unresolved'); assert.equal(readRecord(root).cleanup_verified, false);
  fake.children[0].finish();
  const stopped = await lease.stop(); assert.equal(stopped.cleanup_verified, true);
  assert.equal(fake.signals.length, 2, 'a closed handle must not be signaled on retry');
});

for (const denial of [true, 'EPERM']) test('an unknown final PID blocks cleanup without receiving signals: ' + denial, async t => {
  const root = fixture(t), fake = synthetic(t), lease = await startOwnedWake({ root, journalFile: journalName });
  fake.denyAbsence(denial);
  await assert.rejects(lease.stop(), error => error.code === 'WAKE_UNRESOLVED' && !error.cleanup_verified);
  assert.equal(readRecord(root).cleanup_verified, false); assert.deepEqual(fake.signals.map(item => item.signal), ['SIGTERM']);
  fake.denyAbsence(false);
  assert.equal((await lease.stop()).cleanup_verified, true); assert.equal(fake.signals.length, 1);
});

test('late journal ancestry symlink cannot redirect cleanup writes', async t => {
  const root = fixture(t), fake = synthetic(t), lease = await startOwnedWake({ root, journalFile: journalName });
  const external = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wake-external-sentinel-')));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  const parent = path.join(root, '.codex-plan-runner/test');
  fs.renameSync(parent, parent + '-retained'); fs.writeFileSync(path.join(external, 'wake.json'), 'preserve external sentinel'); fs.symlinkSync(external, parent);
  await assert.rejects(lease.stop(), error => error.code === 'WAKE_JOURNAL' && error.cleanup_verified);
  assert.equal(fs.readFileSync(path.join(external, 'wake.json'), 'utf8'), 'preserve external sentinel');
  assert.deepEqual(fs.readdirSync(external), ['wake.json']); assert.equal(fake.signals.length, 1);
});

test('a replaced journal lease is retained while only the live owned helper is stopped', async t => {
  const root = fixture(t), fake = synthetic(t), lease = await startOwnedWake({ root, journalFile: journalName });
  const replacement = { ...readRecord(root), id: 'unrelated-lease' }, bytes = JSON.stringify(replacement);
  fs.writeFileSync(path.join(root, journalName), bytes);
  await assert.rejects(lease.stop(), error => error.code === 'WAKE_JOURNAL' && error.cleanup_verified);
  assert.equal(fs.readFileSync(path.join(root, journalName), 'utf8'), bytes); assert.equal(fake.signals.length, 1);
});

test('competing initial publication cannot overwrite another lease or spawn a helper', async t => {
  const root = fixture(t), fake = synthetic(t), link = fs.linkSync.bind(fs), file = path.join(root, journalName), bytes = '{"foreign":"keep"}';
  t.mock.method(fs, 'linkSync', (from, to) => { if (to === file) fs.writeFileSync(to, bytes, { flag: 'wx', mode: 0o600 }); return link(from, to); });
  await assert.rejects(startOwnedWake({ root, journalFile: journalName }), /prior wake journal/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.equal(fake.children.length, 0);
});

test('returned record snapshots cannot retarget the owned helper', async t => {
  const root = fixture(t), fake = synthetic(t), lease = await startOwnedWake({ root, journalFile: journalName });
  lease.record.pid = process.pid; lease.record.id = 'changed';
  assert.equal((await lease.stop()).pid, fake.children[0].pid); assert.equal(fake.signals[0].pid, fake.children[0].pid);
});

test('native owner exits naturally without being retained by its wake helper', async t => {
  if (process.platform !== 'darwin') return;
  const root = fixture(t), url = new URL('./owned-wake.mjs', import.meta.url).href;
  const code = 'import {startOwnedWake} from ' + JSON.stringify(url) + ';const l=await startOwnedWake(' + JSON.stringify({ root, journalFile: journalName }) + ');console.log(l.record.pid);';
  const pid = Number(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 5000 }).trim());
  let absent = false;
  for (let n = 0; n < 100; n++) { try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { absent = true; break; } throw error; } await delay(25); }
  assert.equal(absent, true); assert.equal(readRecord(root).cleanup_verified, false, 'owner death does not forge a final cleanup receipt');
});

test('hard-linked wake journals cannot transfer write ownership', async t => {
  const root = fixture(t), fake = synthetic(t), lease = await startOwnedWake({ root, journalFile: journalName });
  const retained = path.join(root, 'retained.json'); fs.linkSync(path.join(root, journalName), retained);
  const before = fs.readFileSync(retained);
  await assert.rejects(lease.stop(), error => error.code === 'WAKE_JOURNAL' && error.cleanup_verified);
  assert.deepEqual(fs.readFileSync(retained), before); assert.deepEqual(fs.readFileSync(path.join(root, journalName)), before);
  assert.equal(fake.signals.length, 1);
});

test('replaced regular parent directory cannot inherit a live lease', async t => {
  const root = fixture(t), fake = synthetic(t), lease = await startOwnedWake({ root, journalFile: journalName });
  const parent = path.dirname(path.join(root, journalName)), before = fs.readFileSync(path.join(root, journalName));
  fs.renameSync(parent, parent + '-retained'); fs.mkdirSync(parent); fs.writeFileSync(path.join(parent, 'wake.json'), before, { mode: 0o600 });
  await assert.rejects(lease.stop(), error => error.code === 'WAKE_JOURNAL' && error.cleanup_verified);
  assert.deepEqual(fs.readFileSync(path.join(parent, 'wake.json')), before); assert.equal(fake.signals.length, 1);
});

test('a same-content replacement journal cannot inherit file ownership', async t => {
  const root = fixture(t), fake = synthetic(t), lease = await startOwnedWake({ root, journalFile: journalName });
  const file = path.join(root, journalName), before = fs.readFileSync(file);
  fs.renameSync(file, file + '.retained'); fs.writeFileSync(file, before, { mode: 0o600 });
  await assert.rejects(lease.stop(), error => error.code === 'WAKE_JOURNAL' && error.cleanup_verified);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(fake.signals.length, 1);
});
