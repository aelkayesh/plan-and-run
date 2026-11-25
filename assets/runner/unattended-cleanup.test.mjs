import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyUnattendedCleanup, sealAcceptanceCleanupJournal } from './unattended-cleanup.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t, { host = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup proof ')));
  const stateDir = path.join(root, '.codex-plan-runner/test');
  const id = randomUUID(), directory = path.join(stateDir, host ? 'host-checks' : 'acceptance/01', id);
  fs.mkdirSync(directory, { recursive: true });
  const gate = { id: 'npm', capability: 'npm-checks' };
  const entry = { status: 'interrupted', acceptance: { mode: 'strict', gates: {} }, recovery: {} };
  const plan = { root, stateDir, planHash: 'a'.repeat(64), manifest: { plan_id: 'test', steps: [{ id: '01' }] },
    state: { steps: { '01': entry } }, acceptanceProfile: { mode: 'strict', packages: { '01': { required_gates: [gate], criteria: [] } } },
    recoveryPolicy: { value: { packages: { '01': { recipes: ['npm-checks'] } } } } };
  const inventory = { head: 'a'.repeat(40), branch: 'test', excluded_paths: [], files: [] };
  const source = { ...inventory, sha256: hash(JSON.stringify(inventory)) };
  const journal = { schema_version: 1, kind: host ? 'automatic-host-validation' : 'acceptance-gate-journal',
    id, root, package_id: '01', plan_hash: plan.planHash, gate, source, phase: 'interrupted', process: null,
    cleanup_verified: true, data_directory: path.join(directory, `data-${id}`), ...(host ? { recipe_id: 'npm-checks' } : {}) };
  const file = path.join(directory, `${host ? 'host' : 'acceptance'}-${id}-journal.json`);
  const relative = path.relative(root, file);
  if (host) entry.recovery.pending_evidence = { recipe_id: 'npm-checks', journal_file: relative };
  else entry.acceptance.gates.npm = { journal_file: relative };
  const write = () => fs.writeFileSync(file, JSON.stringify(journal)); write();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stateDir, file, relative, plan, entry, journal, write, gate, source, directory };
}

test('terminal interrupted strict cleanup is checked without mutating its journal', t => {
  const f = fixture(t), before = fs.readFileSync(f.file);
  const proof = verifyUnattendedCleanup(f.plan);
  assert.equal(proof.cleanup_verified, true); assert.equal(proof.journals.length, 1);
  assert.equal(proof.journals[0].sha256, hash(before)); assert.deepEqual(fs.readFileSync(f.file), before);
});
for (const phase of ['planned', 'running', 'captured', 'helper_failed']) test(`nonterminal ${phase} cannot claim cleanup`, t => {
  const f = fixture(t); f.journal.phase = phase; f.write();
  assert.throws(() => verifyUnattendedCleanup(f.plan), /terminal verified cleanup/);
});
test('terminal status requires explicit cleanup and actual owned data absence', t => {
  const f = fixture(t); f.journal.cleanup_verified = false; f.write();
  assert.throws(() => verifyUnattendedCleanup(f.plan), /terminal verified cleanup/);
  f.journal.cleanup_verified = true; f.write(); fs.mkdirSync(f.journal.data_directory);
  fs.writeFileSync(path.join(f.journal.data_directory, '.owner.json'), JSON.stringify({ id: f.journal.id }));
  assert.throws(() => verifyUnattendedCleanup(f.plan), /data directory.*exists/);
  assert.equal(fs.existsSync(f.journal.data_directory), true);
});
test('unknown live process is inspected but never signalled', async t => {
  const f = fixture(t), child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  t.after(async () => { child.kill('SIGTERM'); await new Promise(resolve => child.once('close', resolve)); });
  f.journal.process = { pid: child.pid, pgid: child.pid, id: f.journal.id, helper: fileURLToPath(new URL('./acceptance-helper.mjs', import.meta.url)) }; f.write();
  assert.throws(() => verifyUnattendedCleanup(f.plan), /still present/);
  assert.equal(child.exitCode, null); assert.doesNotThrow(() => process.kill(child.pid, 0));
});
test('historical completed resources require terminal proof but do not probe reused PIDs', t => {
  const f = fixture(t); f.entry.status = 'completed'; f.journal.process = { pid: process.pid, pgid: process.pid, id: f.journal.id,
    helper: fileURLToPath(new URL('./acceptance-helper.mjs', import.meta.url)) }; f.write();
  const probe = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  Object.assign(f.entry.acceptance.gates.npm, sealAcceptanceCleanupJournal(f.plan, '01', f.gate, f.entry.acceptance.gates.npm)); probe.mock.restore();
  assert.equal(verifyUnattendedCleanup(f.plan, { historicalCompleted: ['01'] }).journals.length, 1);
  f.journal.cleanup_verified = false; f.write();
  assert.throws(() => verifyUnattendedCleanup(f.plan, { historicalCompleted: ['01'] }), /terminal verified cleanup/);
  f.journal.cleanup_verified = true; f.write();
  assert.throws(() => verifyUnattendedCleanup(f.plan), /still present/);
});
test('a once-completed baseline entry made unfinished is not skipped', t => {
  const f = fixture(t); f.journal.cleanup_verified = false; f.write();
  assert.throws(() => verifyUnattendedCleanup(f.plan, { historicalCompleted: ['01'] }), /terminal verified cleanup/);
});
for (const change of ['package', 'plan', 'gate', 'source', 'data', 'schema']) test(`mismatched ${change} journal cannot establish cleanup`, t => {
  const f = fixture(t);
  if (change === 'package') f.journal.package_id = '02';
  if (change === 'plan') f.journal.plan_hash = 'b'.repeat(64);
  if (change === 'gate') f.journal.gate = { id: 'npm', capability: 'production-build' };
  if (change === 'source') f.journal.source.branch = 'forged';
  if (change === 'data') f.journal.data_directory = path.join(f.root, 'user-data');
  if (change === 'schema') f.journal.schema_version = 99;
  f.write(); assert.throws(() => verifyUnattendedCleanup(f.plan), /identity|hash mismatch/);
});
test('malformed, symlinked, linked or missing journal refuses cleanup without modifying targets', t => {
  const f = fixture(t), original = fs.readFileSync(f.file), target = path.join(f.root, 'target.json'); fs.writeFileSync(target, original);
  fs.writeFileSync(f.file, '{'); assert.throws(() => verifyUnattendedCleanup(f.plan), /malformed/);
  fs.unlinkSync(f.file); assert.throws(() => verifyUnattendedCleanup(f.plan), /missing/);
  fs.symlinkSync(target, f.file); assert.throws(() => verifyUnattendedCleanup(f.plan), /symlink/);
  fs.unlinkSync(f.file); fs.linkSync(target, f.file); assert.throws(() => verifyUnattendedCleanup(f.plan), /linked/);
  assert.deepEqual(fs.readFileSync(target), original);
});
test('timeout pending journal is verified and deduplicated with its current gate', t => {
  const f = fixture(t); f.entry.acceptance.timeout_pending = { gate_id: 'npm', journal_file: f.relative };
  assert.equal(verifyUnattendedCleanup(f.plan).journals.length, 1);
  f.entry.acceptance.gates = {}; f.journal.cleanup_verified = false; f.write();
  assert.throws(() => verifyUnattendedCleanup(f.plan), /terminal verified cleanup/);
});
test('strict PostgreSQL cleanup requires exact owned fixture and verified absence', t => {
  const f = fixture(t), fixtureId = randomUUID(), containerId = 'b'.repeat(64); f.gate.capability = 'synthetic-postgres';
  docker(t);
  f.journal.fixture = { kind: 'codex-plan-postgresql', id: fixtureId, container_id: containerId,
    container_name: `codex-plan-test-${fixtureId.replaceAll('-', '')}`, image_id: `sha256:${'c'.repeat(64)}`,
    purpose: 'package-01', package_id: '01', plan_hash: f.plan.planHash, docker_endpoint: 'unix:///synthetic-cleanup.sock' };
  f.write(); assert.throws(() => verifyUnattendedCleanup(f.plan), /verified absence/);
  f.journal.fixture_cleanup = { removed: true, verified_absent: true, container_id: containerId }; f.write();
  assert.equal(verifyUnattendedCleanup(f.plan).cleanup_verified, true);
  f.journal.fixture_cleanup.container_id = 'd'.repeat(64); f.write(); assert.throws(() => verifyUnattendedCleanup(f.plan), /verified absence/);
});
test('strict evidence and accepted source must match cleanup journal ownership', t => {
  const f = fixture(t), evidenceFile = path.join(f.directory, 'evidence.json');
  const evidence = { schema_version: 1, kind: 'codex-plan-acceptance-gate', id: f.journal.id, root: f.root, package_id: '01',
    plan_hash: f.plan.planHash, gate: f.gate, source: f.source, cleanup_verified: true };
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence)); f.journal.evidence_file = evidenceFile; f.write();
  assert.equal(verifyUnattendedCleanup(f.plan).cleanup_verified, true);
  f.entry.status = 'completed'; f.entry.acceptance.accepted_source_sha256 = 'b'.repeat(64);
  assert.throws(() => verifyUnattendedCleanup(f.plan), /source identities differ/);
  f.entry.status = 'interrupted'; evidence.id = randomUUID(); fs.writeFileSync(evidenceFile, JSON.stringify(evidence));
  assert.throws(() => verifyUnattendedCleanup(f.plan), /journal\/evidence/);
});
test('legacy host cleanup verifies recipe authority, terminal state and owned data absence', t => {
  const f = fixture(t, { host: true }); assert.equal(verifyUnattendedCleanup(f.plan).cleanup_verified, true);
  f.plan.recoveryPolicy.value.packages['01'].recipes = []; assert.throws(() => verifyUnattendedCleanup(f.plan), /reviewed capability/);
  f.plan.recoveryPolicy.value.packages['01'].recipes = ['npm-checks']; fs.mkdirSync(f.journal.data_directory);
  assert.throws(() => verifyUnattendedCleanup(f.plan), /data directory.*exists/);
});
test('legacy host evidence cleanup is hash-bound to pending evidence and source', t => {
  const f = fixture(t, { host: true }), evidenceFile = path.join(f.directory, 'host-evidence.json');
  const evidence = { schema_version: 1, kind: 'site-plan-host-validation', root: f.root, package_id: '01', plan_hash: f.plan.planHash,
    source: f.source, automatic: { id: f.journal.id, recipe_id: 'npm-checks', cleanup_verified: true } };
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence)); f.journal.evidence_file = evidenceFile; f.write();
  f.entry.recovery.pending_evidence.file = path.relative(f.root, evidenceFile); f.entry.recovery.pending_evidence.sha256 = hash(fs.readFileSync(evidenceFile));
  assert.equal(verifyUnattendedCleanup(f.plan).cleanup_verified, true);
  evidence.automatic.cleanup_verified = false; fs.writeFileSync(evidenceFile, JSON.stringify(evidence));
  assert.throws(() => verifyUnattendedCleanup(f.plan), /ownership or cleanup/);
});

function docker(t, behavior = {}) {
  const priorHost = process.env.DOCKER_HOST, priorContext = process.env.DOCKER_CONTEXT;
  process.env.DOCKER_HOST = 'unix:///synthetic-cleanup.sock'; delete process.env.DOCKER_CONTEXT;
  t.after(() => {
    if (priorHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = priorHost;
    if (priorContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = priorContext;
  });
  const calls = [];
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    calls.push({ command, args }); assert.equal(command, 'docker');
    assert.deepEqual(args.slice(0, 6), ['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter']);
    assert.match(args[6], /^id=[a-f0-9]{64}$/); assert.equal(args.length, 7); assert.equal(options.shell, false);
    return { status: behavior.failed ? 1 : 0, stdout: behavior.present ? 'b'.repeat(64) : '' };
  });
  return calls;
}
function postgres(f) {
  const id = randomUUID(); f.gate.capability = 'synthetic-postgres';
  f.journal.fixture = { kind: 'codex-plan-postgresql', id, container_id: 'b'.repeat(64),
    container_name: `codex-plan-test-${id.replaceAll('-', '')}`, image_id: `sha256:${'c'.repeat(64)}`,
    purpose: 'package-01', package_id: '01', plan_hash: f.plan.planHash, docker_endpoint: 'unix:///synthetic-cleanup.sock' };
  f.journal.fixture_cleanup = { removed: true, verified_absent: true, container_id: 'b'.repeat(64) }; f.write();
}
for (const kind of ['strict', 'legacy']) test(`${kind} orphan current journal cannot evade cleanup by losing its state pointer`, t => {
  const f = fixture(t, { host: kind === 'legacy' });
  if (kind === 'legacy') f.entry.recovery.pending_evidence = null; else f.entry.acceptance.gates = {};
  f.journal.cleanup_verified = false; f.write();
  const before = fs.readFileSync(f.file);
  assert.throws(() => verifyUnattendedCleanup(f.plan), /terminal verified cleanup/);
  assert.deepEqual(fs.readFileSync(f.file), before);
  f.journal.cleanup_verified = true; f.write();
  assert.equal(verifyUnattendedCleanup(f.plan).journals.length, 1);
});

test('retained strict history journal is checked after the gate is replaced', t => {
  const f = fixture(t); f.entry.acceptance.history = [{ gate_id: 'npm', journal_file: f.relative }]; f.entry.acceptance.gates = {};
  f.journal.cleanup_verified = false; f.write(); assert.throws(() => verifyUnattendedCleanup(f.plan), /terminal verified cleanup/);
  fs.unlinkSync(f.file); assert.throws(() => verifyUnattendedCleanup(f.plan), /missing/);
});

test('legacy history keeps missing host journals visible after pending evidence is cleared', t => {
  const f = fixture(t, { host: true }); f.entry.recovery.history = [{ action: 'host-failure', journal: f.relative }];
  f.entry.recovery.pending_evidence = null; fs.unlinkSync(f.file);
  assert.throws(() => verifyUnattendedCleanup(f.plan), /missing/);
});

test('orphan data with no journal blocks finality and remains untouched', t => {
  const f = fixture(t), directory = path.join(f.directory, `data-${randomUUID()}`);
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'keep.txt'), 'preserve');
  assert.throws(() => verifyUnattendedCleanup(f.plan), /data directory.*exists/);
  assert.equal(fs.readFileSync(path.join(directory, 'keep.txt'), 'utf8'), 'preserve');
});

test('unreferenced malformed and symlinked ownership journals fail closed', t => {
  const f = fixture(t); f.entry.acceptance.gates = {}; fs.writeFileSync(f.file, '{');
  assert.throws(() => verifyUnattendedCleanup(f.plan), /malformed/);
  fs.unlinkSync(f.file); const target = path.join(f.root, 'private.json'); fs.writeFileSync(target, 'preserve'); fs.symlinkSync(target, f.file);
  assert.throws(() => verifyUnattendedCleanup(f.plan), /symlink/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
});

test('strict owned browser children remain checked after the helper process is cleared', t => {
  const f = fixture(t); f.gate.capability = 'loopback-browser';
  f.journal.owned_children = [{ kind: 'server', pid: process.pid, pgid: process.pid }]; f.journal.process = null; f.write();
  const probes = []; t.mock.method(process, 'kill', (pid, signal) => { probes.push({ pid, signal }); return true; });
  assert.throws(() => verifyUnattendedCleanup(f.plan), /still present/);
  assert.deepEqual(probes, [{ pid: process.pid, signal: 0 }]);
});

test('owned browser group absence is required even when both children exited', t => {
  const f = fixture(t); f.gate.capability = 'loopback-browser';
  f.journal.owned_children = [{ kind: 'server', pid: 2146000001, pgid: 2146000000 }, { kind: 'browser', pid: 2146000002, pgid: 2146000000 }]; f.write();
  const probes = []; t.mock.method(process, 'kill', (pid, signal) => {
    probes.push({ pid, signal }); if (pid < 0) return true;
    throw Object.assign(new Error('absent'), { code: 'ESRCH' });
  });
  assert.throws(() => verifyUnattendedCleanup(f.plan), /still present/);
  assert.deepEqual(probes.map(item => item.signal), [0, 0, 0]); assert.equal(probes.at(-1).pid, -2146000000);
});

for (const behavior of [{ present: true }, { failed: true }]) test('current fixture cleanup needs live read-only absence: ' + JSON.stringify(behavior), t => {
  const f = fixture(t); postgres(f); const calls = docker(t, behavior), before = fs.readFileSync(f.file);
  assert.throws(() => verifyUnattendedCleanup(f.plan), /current Docker inventory|absence inspection failed/);
  assert.equal(calls.length, 1); assert.deepEqual(fs.readFileSync(f.file), before);
});

test('historical fixture closure does not require Docker or new acceptance metadata', t => {
  const f = fixture(t); postgres(f); docker(t);
  Object.assign(f.entry.acceptance.gates.npm, sealAcceptanceCleanupJournal(f.plan, '01', f.gate, f.entry.acceptance.gates.npm));
  f.entry.status = 'completed'; f.plan.acceptanceProfile = { mode: 'legacy', packages: {} };
  t.mock.method(childProcess, 'spawnSync', () => assert.fail('historical closure must not depend on current Docker'));
  assert.equal(verifyUnattendedCleanup(f.plan, { historicalCompleted: ['01'] }).cleanup_verified, true);
  f.journal.fixture_cleanup.verified_absent = false; f.write();
  assert.throws(() => verifyUnattendedCleanup(f.plan, { historicalCompleted: ['01'] }), /sealed cleanup ownership changed/);
});

test('current fixture endpoint drift refuses inspection of another daemon', t => {
  const f = fixture(t); postgres(f); const calls = docker(t); f.journal.fixture.docker_endpoint = 'unix:///different.sock'; f.write();
  assert.throws(() => verifyUnattendedCleanup(f.plan), /endpoint ownership changed/); assert.equal(calls.length, 0);
});

test('current fixture create without exact container identity remains unresolved', t => {
  const f = fixture(t); postgres(f); f.journal.fixture.container_id = null; f.write();
  t.mock.method(childProcess, 'spawnSync', () => assert.fail('unknown create outcome cannot authorize inspection or cleanup by guessed ID'));
  assert.throws(() => verifyUnattendedCleanup(f.plan), /fixture identity/);
});

for (const observation of ['present', 'unknown']) test(`cleanup sealing refuses ${observation} ownership without publishing a snapshot`, t => {
  const f = fixture(t); f.journal.process = { pid: process.pid, pgid: process.pid, id: f.journal.id, helper: fileURLToPath(new URL('./acceptance-helper.mjs', import.meta.url)) }; f.write();
  const before = fs.readFileSync(f.file), signals = [];
  t.mock.method(process, 'kill', (pid, signal) => { signals.push(signal); if (observation === 'unknown') throw Object.assign(new Error('denied'), { code: 'EPERM' }); return true; });
  assert.throws(() => sealAcceptanceCleanupJournal(f.plan, '01', f.gate, f.entry.acceptance.gates.npm), /still present|absence could not be established/);
  assert.deepEqual(signals, [0]); assert.deepEqual(fs.readdirSync(f.directory), [path.basename(f.file)]); assert.deepEqual(fs.readFileSync(f.file), before);
});

test('sealed timeout closure permits later terminal control metadata without changing ownership', t => {
  const f = fixture(t), seal = sealAcceptanceCleanupJournal(f.plan, '01', f.gate, f.entry.acceptance.gates.npm);
  f.entry.acceptance.history = [{ gate_id: 'npm', ...seal }]; f.entry.acceptance.gates = {};
  f.journal.phase = 'failed'; f.journal.interruption = 'reconciled'; f.write();
  assert.equal(verifyUnattendedCleanup(f.plan).cleanup_verified, true);
  fs.appendFileSync(path.join(f.root, seal.journal_snapshot_file), '\n');
  assert.throws(() => verifyUnattendedCleanup(f.plan), /snapshot hash changed/);
});

test('retained snapshot cannot hide a removed ownership journal after its gate pointer is cleared', t => {
  const f = fixture(t), seal = sealAcceptanceCleanupJournal(f.plan, '01', f.gate, f.entry.acceptance.gates.npm);
  f.entry.acceptance.history = [{ gate_id: 'npm', ...seal }]; f.entry.acceptance.gates = {};
  fs.unlinkSync(f.file); const snapshot = fs.readFileSync(path.join(f.root, seal.journal_snapshot_file));
  assert.throws(() => verifyUnattendedCleanup(f.plan), /missing or linked ownership journal/);
  assert.deepEqual(fs.readFileSync(path.join(f.root, seal.journal_snapshot_file)), snapshot);
});
