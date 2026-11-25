import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadPlan, parseOptions, atomicJson } from './runner.mjs';
import { loadRecoveryPolicy, newPackageRecovery, snapshotRuntime } from './recovery.mjs';
import { prepareRuntimeUpgrade, applyRuntimeUpgrade } from './runtime-reconciliation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex'), encode = value => JSON.stringify(value, null, 2) + '\n';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'background-upgrade-03-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => { file = path.resolve(root, file); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : encode(value), { mode: 0o600 }); };
  const manifest = { schema_version: 1, plan_id: 'background-upgrade', source: 'plan/source.md', contract: 'plan/contract.md', worker_contract: 'plan/worker-contract.md', ready: true, steps: [
    { id: '01', title: 'Synthetic unfinished acceptance', plan: 'plan/01.md', validation: 'receipts/01.json', handoff: 'receipts/01.md', dependencies: [], manual: false }
  ] };
  write('plan/manifest.json', manifest);
  for (const file of [manifest.source, manifest.contract, manifest.worker_contract, manifest.steps[0].plan]) write(file, 'Frozen synthetic plan.\n');
  write('.gitignore', '.codex-plan-runner/\n'); write('review.md', 'Reviewed local runtime change; preserve all entries.\n');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '--quiet'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'fixture@example.invalid'); git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Synthetic background upgrade');
  const options = parseOptions(['status', '--repo', root, '--manifest', 'plan/manifest.json']);
  const plan = loadPlan(options); plan.acceptanceProfile = { mode: 'legacy', packages: {} }; plan.recoveryPolicy = loadRecoveryPolicy(root, manifest);
  plan.state.steps = { '01': { status: 'failed', attempts: 2, thread_id: randomUUID(), retry_at: '2030-01-01T00:00:00.000Z',
    recovery: { ...newPackageRecovery(), repair_count: 1, protocol_retry_count: 2 } } };
  plan.state.recovery = { schema_version: 1, revision: 4, runtime_hash: hash('old runtime'), policy_hash: plan.recoveryPolicy.hash };
  write(plan.stateFile, plan.state);
  const runtime = snapshotRuntime(), common = { plan, runtime, reviewNote: 'review.md', recipeConfiguration: () => hash('fixed recipes'), verifyCompleted: () => {} };
  const session = ({ planId = manifest.plan_id, phase = 'failed', result = true, pid = null, wake = false } = {}) => {
    const id = randomUUID(), owner = randomUUID(), directory = path.join(root, '.codex-plan-runner', planId, 'background', id), file = path.join(directory, 'session.json');
    const s = { schema_version: 1, id, owner, root, identity: { plan_id: planId, selected: ['01'] }, module_file: path.join(root, 'handler.mjs'), module_sha256: hash('handler'),
      pid, phase, process_identity: null, created_at: new Date().toISOString(), finished_at: new Date().toISOString() };
    if (pid !== null) { write(path.join(directory, 'claim.json'), { id, owner, pid }); write(path.join(directory, 'spawn.json'), { schema_version: 1, id, owner, pid }); }
    if (wake) {
      s.wake = { id: randomUUID(), platform: 'darwin', phase: 'unresolved', cleanup_verified: false, journal_file: path.join(directory, 'wake.json') };
      write(s.wake.journal_file, { schema_version: 1, kind: 'background-wake', id: s.wake.id, owner_pid: pid, pid: null, platform: 'darwin', helper: '/usr/bin/caffeinate',
        args: ['-i', '-w', String(pid)], phase: 'unresolved', cleanup_verified: false });
    }
    write(file, s); write(path.join(directory, 'raw.log'), 'Synthetic retained controller log.\n');
    if (result) { write(path.join(directory, 'result.json'), { schema_version: 1, id, root, identity: s.identity, pid, phase,
      exit_code: 1, accepted: false, cleanup_verified: true, finished_at: s.finished_at }); write(path.join(directory, 'result.txt'), 'Synthetic terminal report.\n'); }
    return { file, directory, s };
  };
  const prepare = () => prepareRuntimeUpgrade(common);
  const apply = (prepared, extra = {}) => applyRuntimeUpgrade({ ...common, proposalFile: prepared.file, proposalSha256: prepared.sha256,
    reload: () => loadPlan(options), writeState: atomicJson, ...extra });
  return { root, plan, write, session, prepare, apply };
}

for (const planId of ['background-upgrade', 'other-same-runtime']) for (const phase of ['pre-lock', 'post-lock', 'lost-leader-wake']) {
  test(`prepare refuses ${phase} ownership in ${planId}, with no lock or side effects`, t => {
    const f = fixture(t), before = fs.readFileSync(f.plan.stateFile);
    f.session({ planId, phase: phase === 'pre-lock' ? 'starting' : 'failed', result: phase !== 'pre-lock', pid: phase === 'post-lock' ? process.pid : phase === 'lost-leader-wake' ? 2146000999 : null, wake: phase === 'lost-leader-wake' });
    t.mock.method(process, 'kill', (pid, signal) => { assert.equal(signal, 0); if (pid === process.pid) return true; throw Object.assign(new Error('absent synthetic process'), { code: 'ESRCH' }); });
    assert.throws(f.prepare, /Background admission/); assert.deepEqual(fs.readFileSync(f.plan.stateFile), before);
  });
}

test('clean terminal background histories survive apply/idempotence and remain bound after success', t => {
  const f = fixture(t), s = f.session(), beforeSteps = structuredClone(f.plan.state.steps), report = fs.readFileSync(path.join(s.directory, 'result.json'));
  const prepared = f.prepare(); assert.ok(prepared.proposal.binding.owned_runtime_plans || prepared.proposal.binding.runtime_ownership || JSON.stringify(prepared.proposal.binding).includes(s.s.id));
  assert.equal(f.apply(prepared).alreadyApplied, false); assert.deepEqual(f.plan.state.steps, beforeSteps); assert.deepEqual(fs.readFileSync(path.join(s.directory, 'result.json')), report);
  assert.equal(f.apply(prepared).alreadyApplied, true);
  const record = JSON.parse(report); record.cleanup_verified = false; f.write(path.join(s.directory, 'result.json'), record);
  const after = fs.readFileSync(f.plan.stateFile); assert.throws(() => f.apply(prepared), /Background admission/); assert.deepEqual(fs.readFileSync(f.plan.stateFile), after);
});

for (const mutation of ['new-controller','new-other-plan','new-clean-history','new-empty-directory','changed-history-log']) test(`apply rejects background drift after preparation: ${mutation}`, t => {
  const f = fixture(t), s = f.session(), prepared = f.prepare(), before = fs.readFileSync(f.plan.stateFile);
  if (mutation === 'new-controller') f.session({ phase: 'starting', result: false });
  if (mutation === 'new-other-plan') f.session({ planId: 'other-same-runtime', phase: 'starting', result: false });
  if (mutation === 'new-clean-history') f.session();
  if (mutation === 'new-empty-directory') fs.mkdirSync(path.join(s.directory, 'new-artifact'));
  if (mutation === 'changed-history-log') fs.appendFileSync(path.join(s.directory, 'raw.log'), 'changed');
  assert.throws(() => f.apply(prepared), /Background admission|reviewed inputs changed/); assert.deepEqual(fs.readFileSync(f.plan.stateFile), before);
});

test('new background owner during the actual state fsync is rejected before replacement', t => {
  const f = fixture(t), prepared = f.prepare(), before = fs.readFileSync(f.plan.stateFile);
  let injected = false, stateFd;
  const open = fs.openSync.bind(fs), sync = fs.fsyncSync.bind(fs);
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = open(file, ...args);
    if (typeof file === 'string' && file.startsWith(f.plan.stateFile + '.') && file.endsWith('.tmp')) stateFd = fd;
    return fd;
  });
  t.mock.method(fs, 'fsyncSync', fd => {
    sync(fd);
    if (fd === stateFd && !injected) { injected = true; f.session({ phase: 'starting', result: false }); }
  });
  assert.throws(() => f.apply(prepared), /Background admission/);
  assert.equal(injected, true); assert.deepEqual(fs.readFileSync(f.plan.stateFile), before);
  assert.equal(fs.readdirSync(f.plan.stateDir).some(name => name.startsWith('state.json.') && name.endsWith('.tmp')), false);
});
