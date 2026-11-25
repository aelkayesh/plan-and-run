import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { inspectBackgroundOwnership, publishBackgroundSession } from './background-ownership.mjs';

const HASH = 'a'.repeat(64), encode = value => JSON.stringify(value, null, 2) + '\n';
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'background-admission-03-'))), planId = 'synthetic';
  const stateDir = path.join(root, '.codex-plan-runner', planId); fs.mkdirSync(stateDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { root, stateDir, planId };
  const save = (file, value) => fs.writeFileSync(file, encode(value), { mode: 0o600 });
  const session = ({ pid = null, phase = 'failed', result = true, wake = false } = {}) => {
    const id = randomUUID(), owner = randomUUID(), directory = path.join(stateDir, 'background', id); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'session.json');
    const s = { schema_version: 1, id, owner, root, identity: { plan_id: planId, selected: ['01'] }, module_file: path.join(root, 'handler.mjs'),
      module_sha256: HASH, created_at: new Date().toISOString(), finished_at: new Date().toISOString(), pid, phase, process_identity: null };
    if (pid !== null) {
      save(path.join(directory, 'claim.json'), { id, owner, pid });
      save(path.join(directory, 'spawn.json'), { schema_version: 1, id, owner, pid });
    }
    if (wake) {
      s.wake = { id: randomUUID(), journal_file: path.join(directory, 'wake.json'), platform: 'linux', phase: 'disabled', cleanup_verified: true };
      save(s.wake.journal_file, { schema_version: 1, kind: 'background-wake', id: s.wake.id, owner_pid: pid, platform: 'linux', helper: '/usr/bin/caffeinate',
        args: ['-i', '-w', String(pid)], pid: null, phase: 'disabled', cleanup_verified: true });
    }
    save(file, s); fs.writeFileSync(path.join(directory, 'raw.log'), '', { mode: 0o600 });
    if (result) {
      save(path.join(directory, 'result.json'), { schema_version: 1, id, root, identity: s.identity, pid, phase, finished_at: s.finished_at,
        exit_code: 1, accepted: false, cleanup_verified: true });
      fs.writeFileSync(path.join(directory, 'result.txt'), 'failed synthetic fixture; no resource created\n', { mode: 0o600 });
    }
    return { s, file, directory, save: () => save(file, s) };
  };
  return { ...input, input, save, session, inspect: extra => inspectBackgroundOwnership({ ...input, ...extra }) };
}
function bytes(root) {
  const walk = directory => fs.readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name), st = fs.lstatSync(file);
    return st.isDirectory() ? [[path.relative(root, file), 'directory'], ...walk(file)] : [[path.relative(root, file), st.isSymbolicLink() ? fs.readlinkSync(file) : digest(fs.readFileSync(file))]];
  });
  return walk(root);
}

test('terminal cleanup inventory binds session receipts, logs and empty-directory membership', t => {
  const f = fixture(t), s = f.session(); const before = f.inspect();
  assert.equal(before.sessions.length, 1); assert.ok(before.files.some(x => x.file.endsWith('result.json')));
  fs.mkdirSync(path.join(s.directory, 'new-empty-artifact')); assert.notDeepEqual(f.inspect().files, before.files);
  fs.rmdirSync(path.join(s.directory, 'new-empty-artifact')); assert.deepEqual(f.inspect().files, before.files);
});

for (const phase of ['starting', 'running', 'stopping', 'failed']) test(`pre-lock ${phase} session without final receipt blocks read-only admission`, t => {
  const f = fixture(t); f.session({ phase, result: false }); const before = bytes(f.root);
  const original = process.kill.bind(process); t.mock.method(process, 'kill', (pid, signal) => { assert.equal(signal, 0); return original(pid, signal); });
  assert.throws(() => f.inspect(), /Background admission/); assert.deepEqual(bytes(f.root), before);
});

test('post-lock final receipt still blocks a live controller; no saved PID signal is sent', t => {
  const f = fixture(t); f.session({ pid: process.pid }); const before = bytes(f.root);
  t.mock.method(process, 'kill', (pid, signal) => { assert.equal(pid, process.pid); assert.equal(signal, 0); return true; });
  assert.throws(() => f.inspect(), /historical identity is unavailable/); assert.deepEqual(bytes(f.root), before);
});

test('only this process with the original session capability may pass its own pre-lock admission', t => {
  const f = fixture(t), s = f.session({ pid: process.pid, phase: 'starting', result: false });
  const ownSession = { file: s.file, id: s.s.id, owner: s.s.owner, pid: process.pid };
  assert.equal(f.inspect({ ownSession }).sessions[0].own, true);
  assert.throws(() => f.inspect({ ownSession: { ...ownSession, owner: randomUUID() } }), /capability/);
  const other = f.session({ phase: 'starting', result: false });
  assert.throws(() => f.inspect({ ownSession }), /missing or linked ownership artifact/);
  assert.equal(fs.existsSync(other.file), true);
});

for (const change of ['missing-session','wrong-root','wrong-plan','bad-claim','missing-wake','wake-owner','wake-unresolved','wake-contradiction','symlink','missing-report']) test(`malformed ownership refuses admission without side effects: ${change}`, t => {
  const f = fixture(t), s = f.session({ pid: 2146000999, wake: true });
  if (change === 'missing-session') fs.unlinkSync(s.file);
  if (change === 'wrong-root') { s.s.root += '-other'; s.save(); }
  if (change === 'wrong-plan') { s.s.identity.plan_id = 'other'; s.save(); }
  if (change === 'bad-claim') f.save(path.join(s.directory, 'claim.json'), { id: s.s.id, owner: randomUUID(), pid: s.s.pid });
  if (change === 'missing-wake') fs.unlinkSync(s.s.wake.journal_file);
  if (change === 'wake-owner' || change === 'wake-unresolved') {
    const w = JSON.parse(fs.readFileSync(s.s.wake.journal_file));
    if (change === 'wake-owner') w.owner_pid++;
    else { w.phase = 'running'; w.cleanup_verified = false; }
    f.save(s.s.wake.journal_file, w);
  }
  if (change === 'wake-contradiction') { s.s.wake.cleanup_verified = false; s.save(); }
  if (change === 'symlink') fs.symlinkSync(s.file, path.join(s.directory, 'unexpected-linked-artifact'));
  if (change === 'missing-report') fs.unlinkSync(path.join(s.directory, 'result.txt'));
  const before = bytes(f.root); assert.throws(() => f.inspect(), /Background admission/); assert.deepEqual(bytes(f.root), before);
});

test('dead controller with a real detached helper remains blocked until explicit owned fixture teardown', async t => {
  const f = fixture(t), s = f.session({ pid: 2146000999, phase: 'failed', wake: true });
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    const w = JSON.parse(fs.readFileSync(s.s.wake.journal_file)); w.platform = 'darwin'; w.phase = 'unresolved'; w.pid = child.pid; w.cleanup_verified = false;
    s.s.wake.platform = 'darwin'; s.s.wake.phase = 'unresolved'; s.s.wake.cleanup_verified = false; s.save(); f.save(s.s.wake.journal_file, w);
    const before = bytes(f.root); assert.throws(() => f.inspect(), /wake cleanup remains unresolved/); assert.deepEqual(bytes(f.root), before);
    assert.equal(child.exitCode, null); assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally { child.kill('SIGTERM'); await closed; }
  assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
});

test('launcher publication shares lock guard and never publishes during runtime lock ownership', t => {
  const f = fixture(t); let invoked = 0;
  const publish = () => { invoked++; };
  fs.mkdirSync(path.join(f.stateDir, 'lock-guard'));
  assert.throws(() => publishBackgroundSession(f.input, publish), /another lock/); assert.equal(invoked, 0);
  fs.rmdirSync(path.join(f.stateDir, 'lock-guard'));
  f.save(path.join(f.stateDir, 'runner.lock'), { hostname: os.hostname(), pid: process.pid, worker_pid: null, token: randomUUID() });
  const before = bytes(f.root); assert.throws(() => publishBackgroundSession(f.input, publish), /runner lock is active/);
  assert.deepEqual(bytes(f.root), before); assert.equal(invoked, 0);
  fs.unlinkSync(path.join(f.stateDir, 'runner.lock'));
  publishBackgroundSession(f.input, publish); assert.equal(invoked, 1);
});

test('a controller appearing after the first admission is refused by the locked recheck', t => {
  const f = fixture(t); assert.equal(f.inspect().sessions.length, 0);
  f.session({ phase: 'starting', result: false }); const before = bytes(f.root);
  assert.throws(() => f.inspect(), /missing or linked ownership artifact/); assert.deepEqual(bytes(f.root), before);
});
