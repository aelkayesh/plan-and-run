import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareRuntimeUpgrade, applyRuntimeUpgrade, assertRuntimeIdle } from './runtime-reconciliation.mjs';
import { strictPlanArtifacts } from './runtime-artifacts.mjs';
import { snapshotRuntime, protectedArtifacts, newPackageRecovery } from './recovery.mjs';
import { atomicJson } from './runner.mjs';
import { sealAcceptanceCleanupJournal } from './unattended-cleanup.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const read = file => JSON.parse(fs.readFileSync(file));

function fixture(t, origin = 'current') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'strict runtime upgrade ')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => { const file = path.resolve(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : encode(value)); return file; };
  write('.gitignore', '.codex-plan-runner/\n'); write('review.md', 'Exact synthetic candidate review.\n'); write('source.mjs', 'export const version = 1;\n');
  const runtimeDir = path.join(root, 'runtime'); write('runtime/runner.mjs', '// Synthetic runtime identity only; never executed.\n');
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','commit','-qm','Synthetic']]) execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const stateDir = path.join(root, '.codex-plan-runner/strict-upgrade'), stateFile = path.join(stateDir, 'state.json');
  const gate = { id: 'npm', capability: 'npm-checks' }, requirements = { required_gates: [gate], criteria: [{ id: 'covered', type: 'suite', purpose: 'Required actual fixture check', gate_ids: ['npm'] }] };
  const entry = { status: 'waiting-for-rate-limit', attempts: 4, thread_id: randomUUID(), retry_at: '2099-01-01T00:00:00Z', rate_limit_count: 2,
    recovery: { ...newPackageRecovery(), repair_count: 2, transport_count: 3, protocol_retry_count: 1, evidence_refresh_count: 1, no_progress_count: 1 },
    acceptance: { schema_version: 1, mode: 'strict', gates: {}, reviews: [], history: [], refresh_count: 1, timeout_retry_count: 2,
      review_actor: { attempts: 2, thread_id: randomUUID(), retry_at: '2099-01-01T00:00:00Z', transport_count: 1, rate_limit_count: 2 } } };
  const plan = { root, stateDir, stateFile, planHash: hash('frozen strict plan'), fingerprint: () => hash('frozen strict plan'),
    manifest: { plan_id: 'strict-upgrade', steps: [{ id: '01', validation: 'validation.json', handoff: 'handoff.md' }] },
    acceptanceProfile: { schema_version: 1, mode: 'strict', packages: { '01': requirements } }, recoveryPolicy: { hash: hash('policy'), value: { packages: { '01': { recipes: ['npm-checks'] } } } } };
  plan.state = { schema_version: 1, plan_id: plan.manifest.plan_id, root, plan_hash: plan.planHash, steps: { '01': entry }, recovery: { schema_version: 1, revision: 12, runtime_hash: hash('old'), policy_hash: plan.recoveryPolicy.hash } };
  const id = randomUUID(), directory = path.join(stateDir, 'acceptance/01', id), file = path.join(directory, `acceptance-${id}-journal.json`), relative = path.relative(root, file);
  const inventory = { head: 'a'.repeat(40), branch: 'historical', excluded_paths: [], files: [] }, source = { ...inventory, sha256: hash(JSON.stringify(inventory)) };
  const journal = { schema_version: 1, kind: 'acceptance-gate-journal', id, root, plan_hash: plan.planHash, package_id: '01', gate, source,
    phase: 'interrupted', cleanup_verified: true, process: null, data_directory: path.join(directory, `data-${id}`) };
  if (origin === 'current') entry.acceptance.gates.npm = { journal_file: relative };
  if (origin === 'timeout') entry.acceptance.timeout_pending = { gate_id: 'npm', journal_file: relative };
  if (origin === 'history') entry.acceptance.history.push({ gate_id: 'npm', journal_file: relative });
  write(file, journal);
  const save = () => write(stateFile, plan.state); save();
  const runtime = snapshotRuntime(runtimeDir);
  const common = { plan, runtime, recipeConfiguration: () => hash('recipes'), verifyCompleted: () => {} };
  const prepare = () => prepareRuntimeUpgrade({ ...common, reviewNote: 'review.md' });
  const apply = (proposal, extra = {}) => applyRuntimeUpgrade({ ...common, proposalFile: proposal.file, proposalSha256: proposal.sha256,
    reload: () => ({ ...plan, state: read(stateFile) }), writeState: (file, value) => write(file, value), ...extra });
  return { root, write, stateDir, stateFile, plan, entry, gate, requirements, source, journal, file, relative, directory, save, runtime, prepare, apply };
}

for (const origin of ['current', 'timeout', 'history', 'orphan']) for (const problem of ['live-helper', 'unverified-cleanup', 'unknown-fixture-create']) {
  test(`prepare/apply reject ${origin} ${problem} with no runner lock or mutation`, t => {
    const f = fixture(t, origin), proposal = f.prepare();
    const signals = []; t.mock.method(process, 'kill', (pid, signal) => { signals.push(signal); return true; });
    if (problem === 'live-helper') f.journal.process = { id: f.journal.id, pid: 2146000000, pgid: 2146000000, helper: fileURLToPath(new URL('./acceptance-helper.mjs', import.meta.url)) };
    if (problem === 'unverified-cleanup') f.journal.cleanup_verified = false;
    if (problem === 'unknown-fixture-create') { f.gate.capability = 'synthetic-postgres'; f.journal.fixture_phase = 'create_pending'; }
    f.write(f.file, f.journal); const state = fs.readFileSync(f.stateFile), bytes = fs.readFileSync(f.file);
    assert.throws(f.prepare, /cleanup|present|fixture/i); assert.throws(() => f.apply(proposal), /cleanup|present|fixture/i);
    assert.deepEqual(fs.readFileSync(f.stateFile), state); assert.deepEqual(fs.readFileSync(f.file), bytes); assert.ok(signals.every(signal => signal === 0));
  });
}

test('live strict browser group and another plan resource block without any destructive signal', t => {
  const f = fixture(t); f.gate.capability = 'loopback-browser'; f.journal.owned_children = [{ kind: 'server', pid: 2146000001, pgid: 2146000000 }]; f.write(f.file, f.journal);
  const probes = []; t.mock.method(process, 'kill', (pid, signal) => { probes.push({ pid, signal }); if (pid < 0) return true; throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  assert.throws(f.prepare, /still present/); assert.ok(probes.every(item => item.signal === 0));
  delete f.journal.owned_children; f.write(f.file, f.journal);
  const otherStateDir = path.join(f.root, '.codex-plan-runner/another-plan'), otherFile = f.file.replace(f.stateDir, otherStateDir);
  const otherState = structuredClone(f.plan.state); otherState.plan_id = 'another-plan'; otherState.steps['01'].acceptance.gates.npm.journal_file = path.relative(f.root, otherFile);
  f.write(path.join(otherStateDir, 'state.json'), otherState); f.write(otherFile, { ...f.journal, cleanup_verified: false, data_directory: f.journal.data_directory.replace(f.stateDir, otherStateDir) });
  assert.throws(f.prepare, /cleanup/);
});

for (const change of ['missing', 'malformed', 'root', 'package', 'gate', 'symlink', 'data-marker', 'contradictory-fixture']) test(`strict ${change} ownership refuses while fully reconciled idle ownership passes`, t => {
  const f = fixture(t); assert.doesNotThrow(() => assertRuntimeIdle(f.plan, f.runtime));
  const original = fs.readFileSync(f.file);
  if (change === 'missing') fs.unlinkSync(f.file);
  else if (change === 'malformed') f.write(f.file, '{');
  else if (change === 'symlink') { const target = f.write('outside-owned-tree.json', original); fs.unlinkSync(f.file); fs.symlinkSync(target, f.file); }
  else if (change === 'data-marker') f.write(path.join(f.journal.data_directory, '.owner.json'), { id: randomUUID(), preserve: true });
  else {
    if (change === 'root') f.journal.root = path.dirname(f.root);
    if (change === 'package') f.journal.package_id = '99';
    if (change === 'gate') f.journal.gate = { id: 'npm', capability: 'production-build' };
    if (change === 'contradictory-fixture') { f.gate.capability = 'synthetic-postgres'; const id = randomUUID(); f.journal.fixture = { kind: 'codex-plan-postgresql', id, container_id: 'b'.repeat(64), container_name: 'codex-plan-test-'+id.replaceAll('-',''), image_id: 'sha256:'+'c'.repeat(64), purpose: 'package-01', package_id: '01', plan_hash: f.plan.planHash }; f.journal.fixture_cleanup = { removed: true, verified_absent: true, container_id: 'd'.repeat(64) }; }
    f.write(f.file, f.journal);
  }
  const state = fs.readFileSync(f.stateFile); assert.throws(f.prepare); assert.deepEqual(fs.readFileSync(f.stateFile), state);
});

function evidence(f) {
  const nested = ['report.json', 'check.log', 'screenshot.png', 'build-manifest.json'].map(name => {
    const file = f.write(path.join(f.directory, name), name.endsWith('.png') ? Buffer.from([137,80,78,71,13,10,26,10,1]) : '{}\n');
    return { file: path.relative(f.root, file), sha256: hash(fs.readFileSync(file)) };
  });
  const value = { schema_version: 1, kind: 'codex-plan-acceptance-gate', id: f.journal.id, root: f.root, plan_hash: f.plan.planHash, package_id: '01', gate: f.gate, source: f.source, cleanup_verified: true, passed: true, artifacts: nested };
  const file = f.write(path.join(f.directory, 'evidence.json'), value), ref = { file: path.relative(f.root, file), sha256: hash(fs.readFileSync(file)), journal_file: f.relative };
  f.entry.acceptance.gates.npm = ref; f.journal.evidence_file = file; f.write(f.file, f.journal); f.save(); return { file, ref, value, nested };
}
function packet(f) {
  const mapping = { schema_version: 1, package_id: '01', gates: [], criteria: [] };
  const mappingFile = f.write('mapping.json', mapping); f.entry.acceptance.mapping = { file: 'mapping.json', sha256: hash(fs.readFileSync(mappingFile)) };
  const binding = { package_id: '01', plan_hash: f.plan.planHash, profile_sha256: hash(JSON.stringify(f.requirements)), mapping_sha256: f.entry.acceptance.mapping.sha256, source_sha256: f.source.sha256, stage: 'evidence', evidence: Object.entries(f.entry.acceptance.gates).map(([id, gate]) => ({ id, file: gate.file, sha256: gate.sha256 })) };
  const value = { schema_version: 1, binding, criteria: f.requirements.criteria, required_gates: f.requirements.required_gates, mapping, source_inventory: f.source, gates: f.entry.acceptance.gates };
  const file = f.write(path.join(f.stateDir, 'acceptance/01', `evidence-${hash(JSON.stringify(binding))}-packet.json`), value);
  const ref = { file: path.relative(f.root, file), sha256: hash(fs.readFileSync(file)), binding_sha256: hash(JSON.stringify(binding)) };
  f.entry.acceptance.review_packet = ref; f.entry.acceptance.packets = [ref]; f.entry.acceptance.review_actor.binding_sha256 = ref.binding_sha256; f.save(); return { file, ref, value };
}

for (const kind of ['evidence', 'report', 'log', 'PNG', 'build-manifest', 'pending-packet', 'timeout-snapshot']) test(`unfinished ${kind} tampering fails before prepare and between prepare/apply`, t => {
  const f = fixture(t), e = evidence(f), p = packet(f);
  const snapshot = f.write(path.join(f.directory, 'timeout-journal-0.json'), f.journal);
  f.entry.acceptance.history.push({ gate_id: 'npm', journal_snapshot_file: path.relative(f.root, snapshot), journal_snapshot_sha256: hash(fs.readFileSync(snapshot)) }); f.save();
  const target = kind === 'evidence' ? e.file : kind === 'pending-packet' ? p.file : kind === 'timeout-snapshot' ? snapshot : path.join(f.root, e.nested[['report','log','PNG','build-manifest'].indexOf(kind)].file);
  const proposal = f.prepare(), state = fs.readFileSync(f.stateFile); fs.appendFileSync(target, '\n');
  assert.throws(f.prepare, /modified|changed|hash/); assert.throws(() => f.apply(proposal), /modified|changed|hash/); assert.deepEqual(fs.readFileSync(f.stateFile), state);
});

for (const change of ['add', 'remove', 'new-journal']) test(`owned acceptance tree ${change} after preparation invalidates proposal`, t => {
  const f = fixture(t); const extra = f.write(path.join(f.directory, 'retained-diagnostic.txt'), 'Retained.'); const proposal = f.prepare();
  if (change === 'add') f.write(path.join(f.directory, 'new-diagnostic.txt'), 'New.');
  if (change === 'remove') fs.unlinkSync(extra);
  if (change === 'new-journal') { const id = randomUUID(), file = path.join(f.directory, `acceptance-${id}-journal.json`); f.write(file, { ...f.journal, id, data_directory: path.join(f.directory, `data-${id}`) }); }
  const before = fs.readFileSync(f.stateFile); assert.throws(() => f.apply(proposal), /inputs changed/); assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

test('completed strict artifacts remain protected when successor source changes', t => {
  const f = fixture(t), e = evidence(f); packet(f); f.entry.status = 'completed';
  f.write('validation.json', '{}'); f.write('handoff.md', 'Accepted historical receipt.'); const result = f.write(path.join(f.stateDir, 'logs/result.json'), '{}'); f.entry.last_attempt = { result_file: result }; f.save();
  f.write('source.mjs', 'export const version = 2;\n');
  assert.doesNotThrow(f.prepare); const protectedFiles = protectedArtifacts(f.plan).files.map(([file]) => file);
  assert.ok(e.nested.every(item => protectedFiles.includes(path.join(f.root, item.file))));
  fs.appendFileSync(path.join(f.root, e.nested[0].file), 'tamper'); assert.throws(f.prepare, /changed/);
});

test('idle reviewer cooldown and cleaned timeout gates preserve every field; repeated apply verifies unfinished history', t => {
  const f = fixture(t, 'timeout'), e = evidence(f); packet(f); const before = structuredClone(f.plan.state.steps), bytes = fs.readFileSync(e.file);
  const prepared = f.prepare(); assert.equal(f.apply(prepared).alreadyApplied, false); assert.deepEqual(f.plan.state.steps, before); assert.deepEqual(fs.readFileSync(e.file), bytes);
  assert.equal(f.apply(prepared).alreadyApplied, true);
  f.write('source.mjs', 'export const legitimateSuccessor = true;\n'); assert.equal(f.apply(prepared).alreadyApplied, true);
  fs.appendFileSync(path.join(f.root, e.nested[0].file), 'tamper'); const state = fs.readFileSync(f.stateFile); assert.throws(() => f.apply(prepared), /changed/); assert.deepEqual(fs.readFileSync(f.stateFile), state);
});

test('strict proposal survives interruption before atomic replacement and detects final-check journal arrival', t => {
  const f = fixture(t); evidence(f); packet(f); const prepared = f.prepare(), before = fs.readFileSync(f.stateFile);
  assert.throws(() => f.apply(prepared, { writeState: () => { throw Error('interrupted write'); } }), /interrupted write/); assert.deepEqual(fs.readFileSync(f.stateFile), before);
  assert.throws(() => f.apply(prepared, { reload: () => { const id = randomUUID(); f.write(path.join(f.directory, `acceptance-${id}-journal.json`), { ...f.journal, id, evidence_file: undefined, cleanup_verified: false, data_directory: path.join(f.directory, `data-${id}`) }); return { ...f.plan, state: read(f.stateFile) }; } }), /cleanup/);
  const orphan = fs.readdirSync(f.directory).find(name => name.startsWith('acceptance-') && path.join(f.directory, name) !== f.file); fs.unlinkSync(path.join(f.directory, orphan));
  assert.equal(f.apply(prepared).alreadyApplied, false);
});

test('legacy pending review packet requires exact reconstructable bytes and reviewer binding', t => {
  const f = fixture(t); evidence(f); const p = packet(f); delete f.entry.acceptance.review_packet; delete f.entry.acceptance.packets; f.save();
  assert.doesNotThrow(() => strictPlanArtifacts(f.plan)); fs.appendFileSync(p.file, '\n'); assert.throws(f.prepare, /packet bytes changed/);
});

for (const origin of ['current', 'history']) test(`strict ${origin} evidence cannot drop its ownership pointer and journal`, t => {
  const f = fixture(t), e = evidence(f);
  if (origin === 'history') { f.entry.acceptance.history.push({ ...e.ref, gate_id: 'npm' }); f.entry.acceptance.gates = {}; delete f.entry.acceptance.history[0].journal_file; }
  else delete f.entry.acceptance.gates.npm.journal_file;
  fs.unlinkSync(f.file); f.save(); const state = fs.readFileSync(f.stateFile);
  assert.throws(f.prepare, /ownership journal reference/); assert.deepEqual(fs.readFileSync(f.stateFile), state);
});

for (const mutation of ['strict-journal', 'background-controller', 'state']) test(`atomic fsync ${mutation} arrival is rejected before replacement and remains inspectable`, t => {
  const f = fixture(t); evidence(f); packet(f); const proposal = f.prepare(), originalState = fs.readFileSync(f.stateFile);
  let publishing = false, injected = false, observedState = originalState, extra;
  const originalFsync = fs.fsyncSync.bind(fs);
  t.mock.method(fs, 'fsyncSync', fd => {
    originalFsync(fd);
    if (!publishing || injected) return;
    injected = true;
    if (mutation === 'strict-journal') {
      const id = randomUUID(); extra = f.write(path.join(f.directory, `acceptance-${id}-journal.json`), { ...f.journal, id, evidence_file: undefined, cleanup_verified: false, data_directory: path.join(f.directory, `data-${id}`) });
    } else if (mutation === 'background-controller') {
      const id = randomUUID(), directory = path.join(f.stateDir, 'background', id); extra = path.join(f.stateDir, 'background');
      f.write(path.join(directory, 'session.json'), { schema_version: 1, id, owner: randomUUID(), root: f.root, identity: { plan_id: f.plan.manifest.plan_id, selected: ['01'] }, module_file: path.join(f.root, 'handler.mjs'), module_sha256: hash('module'), created_at: new Date().toISOString(), pid: null, phase: 'starting', process_identity: null });
    } else { const state = read(f.stateFile); state.steps['01'].attempts++; f.write(f.stateFile, state); observedState = fs.readFileSync(f.stateFile); }
  });
  assert.throws(() => f.apply(proposal, { writeState: (...args) => { publishing = true; return atomicJson(...args); } }), /cleanup|Background admission|state changed/);
  assert.equal(injected, true); assert.deepEqual(fs.readFileSync(f.stateFile), observedState);
  assert.equal(fs.readdirSync(f.stateDir).some(name => name.endsWith('.tmp')), false);
  if (extra) { assert.equal(fs.existsSync(extra), true); fs.rmSync(extra, { recursive: true }); }
  else f.write(f.stateFile, originalState);
  publishing = false;
  assert.equal(f.apply(proposal, { writeState: atomicJson }).alreadyApplied, false);
});

test('completed package cannot exempt a newly discovered orphan live helper as historical', t => {
  const f = fixture(t); evidence(f); f.entry.status = 'completed';
  f.write('validation.json', '{}'); f.write('handoff.md', 'Accepted.'); f.entry.last_attempt = { result_file: f.write(path.join(f.stateDir, 'logs/result.json'), '{}') }; f.save();
  // Seal the original ownership only after observing absence. A later PID
  // reuse does not change that proof; an orphan has no such accepted link.
  f.journal.process = { id: f.journal.id, pid: process.pid, pgid: process.pid, helper: fileURLToPath(new URL('./acceptance-helper.mjs', import.meta.url)) }; f.write(f.file, f.journal);
  const probe = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  Object.assign(f.entry.acceptance.gates.npm, sealAcceptanceCleanupJournal(f.plan, '01', f.gate, f.entry.acceptance.gates.npm)); f.save(); probe.mock.restore();
  assert.doesNotThrow(f.prepare); const proposal = f.prepare();
  const id = randomUUID(), orphan = f.write(path.join(f.directory, `acceptance-${id}-journal.json`), { ...f.journal, id, evidence_file: undefined, process: { ...f.journal.process, id }, data_directory: path.join(f.directory, `data-${id}`) });
  const signals = []; t.mock.method(process, 'kill', (pid, signal) => { signals.push(signal); return true; });
  assert.throws(f.prepare, /still present/); assert.throws(() => f.apply(proposal), /still present/); assert.deepEqual(signals, [0, 0]); assert.equal(fs.existsSync(orphan), true);
});

test('post-rename outside state mutation is detected and preserved without claiming success', t => {
  const f = fixture(t), proposal = f.prepare(), rename = fs.renameSync.bind(fs); let observed;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (to === f.stateFile) { const state = read(to); state.steps['01'].attempts++; f.write(to, state); observed = fs.readFileSync(to); }
  });
  assert.throws(() => f.apply(proposal, { writeState: atomicJson }), /state differs after atomic replacement/);
  assert.deepEqual(fs.readFileSync(f.stateFile), observed); assert.equal(f.plan.state.recovery.revision, 12);
});

test('orphan journal retains nested artifact verification after its state pointer is lost', t => {
  const f = fixture(t), e = evidence(f); f.entry.acceptance.gates = {}; f.save(); assert.doesNotThrow(f.prepare);
  fs.appendFileSync(path.join(f.root, e.nested[0].file), 'altered report');
  const before = fs.readFileSync(f.stateFile); assert.throws(f.prepare, /artifact changed/); assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

for (const field of ['process', 'owned_children', 'fixture', 'data']) test(`sealed historical ${field} cannot change before prepare or apply`, t => {
  const f = fixture(t); evidence(f);
  Object.assign(f.entry.acceptance.gates.npm, sealAcceptanceCleanupJournal(f.plan, '01', f.gate, f.entry.acceptance.gates.npm));
  f.entry.status = 'completed'; f.write('validation.json', '{}'); f.write('handoff.md', 'Accepted.');
  f.entry.last_attempt = { result_file: f.write(path.join(f.stateDir, 'logs/result.json'), '{}') }; f.save();
  const proposal = f.prepare(), before = fs.readFileSync(f.stateFile);
  if (field === 'process') f.journal.process = { id: f.journal.id, pid: process.pid, pgid: process.pid, helper: fileURLToPath(new URL('./acceptance-helper.mjs', import.meta.url)) };
  if (field === 'owned_children') f.journal.owned_children = [{ kind: 'server', pid: process.pid, pgid: process.pid }];
  if (field === 'fixture') f.journal.fixture = { id: randomUUID(), container_id: 'b'.repeat(64) };
  if (field === 'data') f.journal.data = { owner: randomUUID() };
  f.write(f.file, f.journal); const journal = fs.readFileSync(f.file);
  t.mock.method(process, 'kill', () => assert.fail('changed ownership must refuse before any process probe'));
  assert.throws(f.prepare, /sealed cleanup ownership changed/);
  assert.throws(() => f.apply(proposal), /sealed cleanup ownership changed/);
  assert.deepEqual(fs.readFileSync(f.stateFile), before); assert.deepEqual(fs.readFileSync(f.file), journal);
});

test('unsealed completed strict evidence cannot exempt a live saved process', t => {
  const f = fixture(t); evidence(f); f.entry.status = 'completed';
  f.write('validation.json', '{}'); f.write('handoff.md', 'Accepted.'); f.entry.last_attempt = { result_file: f.write(path.join(f.stateDir, 'logs/result.json'), '{}') }; f.save();
  assert.doesNotThrow(f.prepare);
  f.journal.process = { id: f.journal.id, pid: process.pid, pgid: process.pid, helper: fileURLToPath(new URL('./acceptance-helper.mjs', import.meta.url)) }; f.write(f.file, f.journal);
  const before = fs.readFileSync(f.stateFile), signals = [];
  t.mock.method(process, 'kill', (pid, signal) => { signals.push(signal); return true; });
  assert.throws(f.prepare, /still present/); assert.deepEqual(signals, [0]); assert.deepEqual(fs.readFileSync(f.stateFile), before);
});
