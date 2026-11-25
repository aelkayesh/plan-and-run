import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { runAutomaticHostValidation, reconcileAutomaticHostValidation, writeHostJournal } from './automatic-host-validation.mjs';
import { verifyHostValidation } from './host-validation.mjs';

const planHash = 'a'.repeat(64);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fakeNpm = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const settings = JSON.parse(fs.readFileSync('behavior.json', 'utf8'));
const command = process.argv.slice(2).join(' ');
console.log('fake check ' + command);
if (process.env.DATABASE_URL || process.env.OPENAI_API_KEY || process.env.PGPASSWORD) process.exit(99);
if (settings.wait === 'test' && command === 'test') setInterval(() => {}, 1000);
else process.exitCode = settings.fail ? 4 : 0;
`;
function fixture(t, behavior = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-host-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-npm-'));
  fs.writeFileSync(path.join(root, '.gitignore'), '.codex-plan-runner/\nnode_modules/\n');
  fs.writeFileSync(path.join(root, 'source.txt'), 'source');
  fs.writeFileSync(path.join(root, 'behavior.json'), JSON.stringify(behavior));
  fs.writeFileSync(path.join(bin, 'npm'), fakeNpm, {mode: 0o700});
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {stdio: 'pipe'});
  git('init', '-q'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'baseline');
  const prior = {PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, OPENAI_API_KEY: process.env.OPENAI_API_KEY};
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.DATABASE_URL = 'synthetic-secret'; process.env.OPENAI_API_KEY = 'synthetic-key';
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(root, {recursive:true, force:true}); fs.rmSync(bin, {recursive:true, force:true}); });
  const options = {root, packageId:'01', planHash, outputDir:'.codex-plan-runner/test/host', recipeId:'npm-checks'};
  return {root, options, run: (extra = {}) => runAutomaticHostValidation({...options, ...extra}), verify: (file, extra = {}) => verifyHostValidation({root, packageId:'01', planHash, file, ...extra})};
}
async function until(predicate) {
  for (let i=0; i<300; i++) { const value = predicate(); if(value) return value; await delay(20); }
  throw new Error('Timed out waiting for synthetic fixture phase.');
}

test('automatic fixed recipes journal ownership before execution, scrub credentials and clean isolated data', async t => {
  const f = fixture(t);
  const events = [];
  const result = await f.run({onJournal: event => { events.push(event); if(event.phase === 'planned') assert.equal(event.process, null); }});
  assert.ok(result.evidence, JSON.stringify(JSON.parse(fs.readFileSync(result.journalFile))) + fs.readFileSync(result.journalFile.replace('-journal.json','-helper.log'),'utf8'));
  assert.equal(result.evidence.passed, true, JSON.stringify(result.evidence));
  assert.equal(result.evidence.automatic.cleanup_verified, true);
  assert.equal(fs.existsSync(result.evidence.isolation.data_directory), false);
  assert.equal(events[0].phase, 'planned');
  assert.equal(events[1].phase, 'running');
  assert.equal(f.verify(result.file).evidence.passed, true);
  const old = fs.readFileSync(result.file);
  const reconciled = await reconcileAutomaticHostValidation({root:f.root, journalFile:result.journalFile});
  assert.deepEqual(fs.readFileSync(result.file), old);
  assert.equal(reconciled.file, result.file);
});

test('unknown recipe and host command injection are rejected before any host phase', async t => {
  const f = fixture(t);
  for (const recipeId of ['npm-checks; touch /tmp/unowned', 'deploy', ['npm-checks'], undefined, {id:'npm-checks'}, 'custom-command']) {
    await assert.rejects(f.run({recipeId}), /Unknown or unauthorized/);
  }
  assert.equal(fs.existsSync(path.join(f.root, '.codex-plan-runner')), false);
});

test('automatic host failure preserves logs and receipt while cleaning owned data', async t => {
  const f = fixture(t, {fail:true});
  const result = await f.run();
  assert.equal(result.evidence.passed, false);
  assert.equal(result.evidence.checks[0].exit_code, 4);
  assert.equal(fs.existsSync(path.join(f.root, result.evidence.checks[0].log_file)), true);
  assert.equal(fs.existsSync(result.evidence.isolation.data_directory), false);
});

test('new evidence rejects ignored dependency and relevant environment changes', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'node_modules'));
  const dep = path.join(f.root, 'node_modules', 'synthetic.js'); fs.writeFileSync(dep, 'one');
  const result = await f.run();
  assert.equal(f.verify(result.file).evidence.passed, true);
  fs.writeFileSync(dep, 'two');
  assert.throws(() => f.verify(result.file), /dependency or environment identity is stale/);
  const next = await f.run();
  const old = process.env.NODE_ENV; process.env.NODE_ENV = 'changed-context';
  try { assert.throws(() => f.verify(next.file), /dependency or environment identity is stale/); }
  finally { if(old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=old; }
});

for (const mode of ['abort', 'timeout']) test(`${mode} cleans the owned host process group and temporary data`, async t => {
  const f = fixture(t, {wait:'test'});
  const controller = new AbortController(); let journalFile;
  const pending = f.run({signal:controller.signal, timeoutMs:mode === 'timeout' ? 500 : 10_000, onJournal:event => { journalFile=event.journalFile; }});
  if(mode === 'abort') { await until(() => journalFile && JSON.parse(fs.readFileSync(journalFile)).check); controller.abort(); }
  const result = await pending;
  assert.equal(result.interrupted, true);
  assert.equal(result.timedOut, mode === 'timeout');
  assert.equal(result.cancelled, mode === 'abort');
  const journal = JSON.parse(fs.readFileSync(result.journalFile));
  assert.equal(journal.cleanup_verified, true);
  assert.equal(fs.existsSync(journal.data_directory), false);
  assert.throws(() => process.kill(journal.process.pid, 0), {code:'ESRCH'});
});

test('crashed parent is reconciled by exact helper identity without replaying the unfinished check', async t => {
  const f = fixture(t, {wait:'test'});
  const moduleUrl = new URL('./automatic-host-validation.mjs', import.meta.url).href;
  const script = `import {runAutomaticHostValidation} from ${JSON.stringify(moduleUrl)}; await runAutomaticHostValidation(${JSON.stringify(f.options)});`;
  const driver = spawn(process.execPath, ['--input-type=module', '-e', script], {cwd:f.root, stdio:'ignore', env:process.env});
  let journalFile;
  await until(() => {
    const dir=path.join(f.root, f.options.outputDir); if(!fs.existsSync(dir)) return false;
    const candidate=fs.readdirSync(dir).find(name=>name.endsWith('-journal.json')); if(!candidate) return false;
    journalFile=path.join(dir,candidate); return JSON.parse(fs.readFileSync(journalFile)).check;
  });
  driver.kill('SIGKILL'); await new Promise(resolve => driver.once('close',resolve));
  const result = await reconcileAutomaticHostValidation({root:f.root,journalFile});
  assert.equal(result.interrupted,true);
  const journal=JSON.parse(fs.readFileSync(journalFile));
  assert.equal(journal.cleanup_verified,true);
  assert.equal(fs.existsSync(journal.data_directory),false);
});

test('regenerable dependency caches do not invalidate unchanged installed dependencies', async t => {
  const f=fixture(t); fs.mkdirSync(path.join(f.root,'node_modules'));
  const result=await f.run();
  fs.mkdirSync(path.join(f.root,'node_modules','.vite'));
  fs.writeFileSync(path.join(f.root,'node_modules','.vite','test-results.json'),'cache');
  assert.equal(f.verify(result.file).evidence.passed,true);
});

test('reconciliation refuses unknown process identity without signalling it', async t => {
  const f=fixture(t); const result=await f.run();
  const journal=JSON.parse(fs.readFileSync(result.journalFile));
  journal.phase='running'; journal.process={pid:process.pid,pgid:process.pid,helper:'/unrelated/program',id:journal.id};
  writeHostJournal(result.journalFile,journal);
  await assert.rejects(reconcileAutomaticHostValidation({root:f.root,journalFile:result.journalFile}),/identity changed/);
  assert.doesNotThrow(()=>process.kill(process.pid,0));
});

test('reconciliation refuses replacement data directories with unknown ownership', async t => {
  const f=fixture(t); const result=await f.run();
  const journal=JSON.parse(fs.readFileSync(result.journalFile));
  fs.mkdirSync(journal.data_directory); fs.writeFileSync(path.join(journal.data_directory,'unrelated.txt'),'preserve');
  await assert.rejects(reconcileAutomaticHostValidation({root:f.root,journalFile:result.journalFile}),/ownership is unknown/);
  assert.equal(fs.readFileSync(path.join(journal.data_directory,'unrelated.txt'),'utf8'),'preserve');
});

test('journal package, plan and recipe bindings are checked before reconciliation', async t => {
  const f=fixture(t); const result=await f.run();
  for (const expected of [{packageId:'02'}, {planHash:'b'.repeat(64)}, {recipeId:'custom-command'}]) {
    await assert.rejects(reconcileAutomaticHostValidation({root:f.root,journalFile:result.journalFile,...expected}),/expected package, plan or recipe/);
  }
  await assert.rejects(f.run({packageId:'100'}),/Unknown or unauthorized/);
});

test('restart after captured evidence finalizes cleanup without rerunning checks', async t => {
  const f=fixture(t); const result=await f.run();
  const journal=JSON.parse(fs.readFileSync(result.journalFile));
  journal.phase='evidence_pending';
  const evidence=JSON.parse(fs.readFileSync(result.file)); evidence.automatic.cleanup_verified=false;
  writeHostJournal(result.file,evidence); writeHostJournal(result.journalFile,journal);
  const logs=evidence.checks.map(check=>fs.readFileSync(path.join(f.root,check.log_file)));
  const resumed=await reconcileAutomaticHostValidation({root:f.root,journalFile:result.journalFile});
  assert.equal(resumed.file,result.file);
  assert.equal(resumed.evidence.automatic.cleanup_verified,true);
  evidence.checks.forEach((check,index)=>assert.deepEqual(fs.readFileSync(path.join(f.root,check.log_file)),logs[index]));
});

for (const phase of ['planned', 'running']) test(`abort at ${phase} acknowledgement never starts checks`, async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const result = await f.run({signal: controller.signal, onJournal: event => {
    if (event.phase === phase) controller.abort();
  }});
  const journal = JSON.parse(fs.readFileSync(result.journalFile));
  assert.equal(result.cancelled, true);
  assert.equal(result.cleanup_verified, true);
  assert.equal(journal.check, undefined);
  assert.equal(fs.existsSync(journal.data_directory), false);
  if (journal.process) assert.throws(() => process.kill(journal.process.pid, 0), {code:'ESRCH'});
});

test('failed durable running acknowledgement stops the helper before checks', async t => {
  const f = fixture(t);
  const result = await f.run({onJournal: event => {
    if (event.phase === 'running') throw new Error('synthetic state persistence failure');
  }});
  const journal = JSON.parse(fs.readFileSync(result.journalFile));
  assert.equal(result.interrupted, true);
  assert.equal(journal.interruption_reason, 'journal-error');
  assert.equal(journal.check, undefined);
  assert.equal(fs.existsSync(journal.data_directory), false);
  assert.throws(() => process.kill(journal.process.pid, 0), {code:'ESRCH'});
});

test('crashed parent before start acknowledgement leaves no idle helper or executed check', async t => {
  const f = fixture(t);
  const moduleUrl = new URL('./automatic-host-validation.mjs', import.meta.url).href;
  const script = `import {runAutomaticHostValidation} from ${JSON.stringify(moduleUrl)};
    await runAutomaticHostValidation({...${JSON.stringify(f.options)}, onJournal: async event => {
      if (event.phase === 'running') await new Promise(() => {});
    }});`;
  const driver = spawn(process.execPath, ['--input-type=module', '-e', script], {cwd:f.root, stdio:'ignore', env:process.env});
  let journalFile;
  await until(() => {
    const dir = path.join(f.root, f.options.outputDir);
    if (!fs.existsSync(dir)) return false;
    const file = fs.readdirSync(dir).find(name => name.endsWith('-journal.json'));
    if (!file) return false;
    journalFile = path.join(dir, file);
    return JSON.parse(fs.readFileSync(journalFile)).phase === 'running';
  });
  driver.kill('SIGKILL');
  await new Promise(resolve => driver.once('close', resolve));
  const journal = JSON.parse(fs.readFileSync(journalFile));
  await until(() => {
    try { process.kill(journal.process.pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  });
  const result = await reconcileAutomaticHostValidation({root:f.root, journalFile});
  assert.equal(result.interrupted, true);
  assert.equal(journal.check, undefined);
  assert.equal(fs.existsSync(journal.data_directory), false);
});

test('reconciliation binds evidence to the journal package, plan, root and recipe', async t => {
  const f = fixture(t);
  const result = await f.run();
  const evidence = JSON.parse(fs.readFileSync(result.file));
  for (const patch of [{package_id:'02'}, {plan_hash:'b'.repeat(64)}, {root:'/unrelated'}, {recipe_id:'custom-command'}]) {
    writeHostJournal(result.file, {...evidence, ...patch});
    await assert.rejects(reconcileAutomaticHostValidation({root:f.root, journalFile:result.journalFile}), /ownership or identity differs/);
  }
  writeHostJournal(result.file, {...evidence, automatic:{...evidence.automatic, cleanup_verified:false}});
  await assert.rejects(reconcileAutomaticHostValidation({root:f.root, journalFile:result.journalFile}), /inconsistent cleanup state/);
});

test('reconciliation refuses a symlinked owner marker without removing data', async t => {
  const f = fixture(t);
  const result = await f.run();
  const journal = JSON.parse(fs.readFileSync(result.journalFile));
  fs.mkdirSync(journal.data_directory);
  const stat = fs.statSync(journal.data_directory);
  journal.data = {directory:journal.data_directory, id:journal.id, device:stat.dev, inode:stat.ino};
  writeHostJournal(result.journalFile, journal);
  const marker = path.join(f.root, '.codex-plan-runner', 'unrelated-owner.json');
  fs.writeFileSync(marker, JSON.stringify({id:journal.id}));
  fs.symlinkSync(marker, path.join(journal.data_directory, '.owner.json'));
  await assert.rejects(reconcileAutomaticHostValidation({root:f.root, journalFile:result.journalFile}), /ownership is unknown/);
  assert.equal(fs.existsSync(journal.data_directory), true);
  assert.equal(fs.existsSync(marker), true);
});

test('invalid cancellation and identity values are rejected before helper creation', async t => {
  const f = fixture(t);
  await assert.rejects(f.run({signal:{aborted:false}}), /AbortSignal/);
  await assert.rejects(f.run({packageId:12}), /Unknown or unauthorized/);
  assert.equal(fs.existsSync(path.join(f.root, '.codex-plan-runner')), false);
});


test('transient EPERM group probes require later verified absence before cleanup', async t => {
  const f=fixture(t), originalKill=process.kill.bind(process), events=[];
  let pgid, pending=2;
  t.mock.method(process,'kill',(pid,signal)=>{
    if(pid===-pgid){
      events.push(signal);
      if(signal===0&&pending>0){pending--;throw Object.assign(new Error('Synthetic zombie-only group'),{code:'EPERM'});}
    }
    return originalKill(pid,signal);
  });
  const result=await f.run({onJournal:event=>{if(event.process)pgid=event.process.pgid;}});
  assert.equal(pending,0);
  assert.equal(result.evidence.automatic.cleanup_verified,true);
  assert.equal(fs.existsSync(result.evidence.isolation.data_directory),false);
  assert.ok(events.length>=3);
  assert.ok(events.every(signal=>signal===0),'Permission uncertainty must not cause a signal');
});

test('persistent EPERM group probes fail closed and preserve the owned fixture', async t => {
  const f=fixture(t), originalKill=process.kill.bind(process), events=[];
  let pgid,journalFile;
  t.mock.method(process,'kill',(pid,signal)=>{
    if(pid===-pgid){events.push(signal);if(signal===0)throw Object.assign(new Error('Synthetic permission denial'),{code:'EPERM'});}
    return originalKill(pid,signal);
  });
  await assert.rejects(f.run({onJournal:event=>{journalFile=event.journalFile;if(event.process)pgid=event.process.pgid;}}),{code:'EPERM'});
  const journal=JSON.parse(fs.readFileSync(journalFile));
  assert.equal(journal.cleanup_verified,undefined);
  assert.equal(fs.existsSync(journal.data_directory),true);
  assert.ok(events.length>1);
  assert.ok(events.every(signal=>signal===0),'No signal is allowed while group ownership/absence is uncertain');
});

for (const persistent of [false, true]) test(`post-exit group permission race requires verified absence (persistent=${persistent})`, async t => {
  const f = fixture(t, {wait:'test'});
  const originalKill = process.kill.bind(process);
  let group, journalFile, terminated = false, probeInjected = false, denied = false, absenceObserved = false;
  const mocked = t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === group && signal === 'SIGTERM') terminated = true;
    if (pid === group && terminated && signal === 0 && !probeInjected) { probeInjected = true; return true; }
    if (pid === group && probeInjected && signal === 'SIGKILL') {
      denied = true; throw Object.assign(new Error('simulated post-exit permission race'), {code:'EPERM'});
    }
    if (pid === group && denied && persistent && signal === 0) return true;
    try { return originalKill(pid, signal); }
    catch (error) { if (pid === group && denied && signal === 0 && error.code === 'ESRCH') absenceObserved = true; throw error; }
  });
  const pending = f.run({timeoutMs:500, onJournal:event => {
    journalFile = event.journalFile;
    if (event.process) group = -event.process.pgid;
  }});
  if (persistent) {
    await assert.rejects(pending, {code:'EPERM'});
    const journal = JSON.parse(fs.readFileSync(journalFile));
    assert.notEqual(journal.cleanup_verified, true);
    assert.equal(fs.existsSync(journal.data_directory), true, 'unknown group must preserve data and pending journal');
    assert.equal(absenceObserved, false);
  } else {
    const result = await pending;
    assert.equal(result.interrupted, true); assert.equal(result.timedOut, true);
    assert.equal(result.cleanup_verified, true); assert.equal(absenceObserved, true);
  }
  assert.equal(probeInjected, true); assert.equal(denied, true);
  mocked.mock.restore();
  // The real helper received SIGTERM; after the synthetic uncertain probe is
  // removed, reconcile it normally so the negative case leaves no fixture.
  if (persistent) {
    const recovered = await reconcileAutomaticHostValidation({root:f.root, journalFile});
    assert.equal(recovered.cleanup_verified, true);
  }
});
