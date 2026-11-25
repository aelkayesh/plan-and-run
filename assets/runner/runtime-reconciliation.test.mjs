import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPlan, parseOptions } from './runner.mjs';
import { loadRecoveryPolicy, newPackageRecovery, snapshotRuntime } from './recovery.mjs';
import { prepareRuntimeUpgrade, applyRuntimeUpgrade } from './runtime-reconciliation.mjs';

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const json = value => JSON.stringify(value, null, 2) + '\n';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime upgrade synthetic-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), bytes); };
  fs.cpSync(runtimeDirectory, path.join(root, 'codex-plan-runner'), { recursive: true, filter: file => !file.endsWith('.test.mjs') && !/[\/]\d{2}-evidence(?:[\/]|$)/.test(file) });
  write('run.mjs', "import {main} from './codex-plan-runner/runner.mjs'; main().then(code=>{process.exitCode=code}).catch(error=>{console.error(error.message);process.exitCode=1});\n");
  const manifest = { schema_version: 1, plan_id: 'runtime-upgrade-test', source: 'plan/source.md', contract: 'plan/contract.md', worker_contract: 'plan/worker-contract.md', ready: true,
    steps: ['01', '02'].map((id, index) => ({ id, title: `Synthetic ${id}`, plan: `plan/${id}.md`, validation: `receipts/${id}.json`, handoff: `receipts/${id}.md`, dependencies: index ? ['01'] : [], manual: false })) };
  write('plan/manifest.json', json(manifest));
  for (const file of [manifest.source, manifest.contract, manifest.worker_contract, ...manifest.steps.map(step => step.plan)]) write(file, 'Immutable synthetic acceptance.\n');
  write('.gitignore', '.codex-plan-runner/\n.env\nnode_modules/\n');
  write('review.md', 'Reviewed authorized runtime replacement; preserve all package work.\n');
  write('source.mjs', 'export const preserved = true;\n');
  write('receipts/01.json', json({ status: 'completed' })); write('receipts/01.md', 'Accepted predecessor.\n');
  write('receipts/02.json', json({ status: 'blocked' })); write('receipts/02.md', 'Saved partial work.\n');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '--quiet'); git('config', 'user.name', 'Synthetic fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Synthetic baseline');
  const options = parseOptions(['status', '--repo', root, '--manifest', 'plan/manifest.json']);
  const plan = loadPlan(options);
  const policy = loadRecoveryPolicy(root, manifest);
  const log = `.codex-plan-runner/${manifest.plan_id}/logs`;
  write(`${log}/01-result.json`, json({ status: 'completed' }));
  write(`${log}/02-result.json`, json({ status: 'blocked' }));
  write(`${log}/02.jsonl`, 'Historical failure evidence.\n');
  const completed = { status: 'completed', attempts: 2, last_attempt: { result_file: path.join(root, `${log}/01-result.json`) },
    artifacts: { validation_sha256: hash(fs.readFileSync(path.join(root, 'receipts/01.json'))), handoff_sha256: hash(fs.readFileSync(path.join(root, 'receipts/01.md'))), result_sha256: hash(fs.readFileSync(path.join(root, `${log}/01-result.json`))) } };
  const recovery = { ...newPackageRecovery(), repair_count: 2, transport_count: 3, evidence_refresh_count: 1, session_replacement_count: 1, no_progress_count: 1 };
  const unfinished = { status: 'failed', attempts: 4, rate_limit_count: 3, thread_id: '00000000-0000-4000-8000-000000000001', recovery,
    last_attempt: { result_file: path.join(root, `${log}/02-result.json`), log_file: path.join(root, `${log}/02.jsonl`) } };
  const state = { ...plan.state, steps: { '01': completed, '02': unfinished }, recovery: { schema_version: 1, revision: 17, runtime_hash: hash('reviewed old runtime'), policy_hash: policy.hash } };
  write(path.relative(root, plan.stateFile), json(state));
  // Model a parent only inside this disposable fixture, including when tests run in a worker.
  const command = (name, ...args) => spawnSync(process.execPath, [path.join(root, 'run.mjs'), name, '--repo', root, '--manifest', 'plan/manifest.json', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CODEX_PLAN_WORKER: '0', CODEX_RECOVERY_SUPERVISOR: '0' } });
  const prepare = () => {
    const result = command('runtime-prepare', '--runtime-review-note', 'review.md');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const file = result.stdout.match(/Runtime upgrade proposal: (.+)/)[1];
    const sha256 = result.stdout.match(/Proposal SHA-256: ([a-f0-9]{64})/)[1];
    return { file, sha256, result };
  };
  const apply = prepared => command('runtime-apply', '--proposal', prepared.file, '--proposal-sha256', prepared.sha256);
  return { root, write, plan, options, state, command, prepare, apply, stateFile: plan.stateFile, stateDir: plan.stateDir };
}

test('runtime mismatch stays diagnostic and read-only while normal start fails closed', t => {
  const f = fixture(t), before = fs.readFileSync(f.stateFile), files = fs.readdirSync(f.stateDir);
  const result = f.command('status');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /02  failed/);
  assert.match(result.stdout, /Saved runtime:.*\nCurrent runtime:/);
  assert.match(result.stdout, /Normal start remains blocked/);
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
  assert.deepEqual(fs.readdirSync(f.stateDir), files);
  assert.equal(f.command('start', '--step', '02', '--codex-bin', '/must-not-run').status, 1);
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

test('reviewed two-step upgrade preserves packages, sessions, budgets, artifacts and immutable evidence', t => {
  const f = fixture(t), before = fs.readFileSync(f.stateFile);
  const prepared = f.prepare();
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
  const proposal = read(path.join(f.root, prepared.file));
  assert.equal(proposal.binding.state_sha256, hash(before));
  assert.equal(proposal.binding.accepted.files.length, 3);
  assert.equal(proposal.binding.history.length, 3);
  assert.ok(proposal.binding.next.runtime_files.length > 5);
  assert.equal(proposal.review_rationale, fs.readFileSync(path.join(f.root, 'review.md'), 'utf8'));
  const applied = f.apply(prepared);
  assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  const state = read(f.stateFile);
  assert.deepEqual(state.steps, f.state.steps);
  assert.equal(state.recovery.revision, 18);
  assert.equal(state.recovery.runtime_hash, proposal.binding.next.runtime_hash);
  assert.equal(state.recovery.runtime_upgrades.length, 1);
  const audit = read(path.join(f.root, state.recovery.runtime_upgrades[0].record_file));
  assert.deepEqual(fs.readFileSync(path.join(f.root, audit.before_state.file)), before);
  assert.equal(f.command('status').stdout.includes('Normal start remains blocked'), false);
  const after = fs.readFileSync(f.stateFile);
  const repeated = f.apply(prepared);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /already recorded/);
  assert.deepEqual(fs.readFileSync(f.stateFile), after);
  // The editable source note may evolve, while the reviewed rationale remains
  // preserved in the hash-bound immutable proposal.
  f.write('review.md', 'Later operator notes.\n');
  assert.equal(read(path.join(f.root, prepared.file)).review_rationale, proposal.review_rationale);
  assert.equal(f.command('status').stdout.includes('audit changed'), false);
});

for (const mutation of ['source', 'runtime', 'note', 'accepted', 'history', 'state', 'ignored-config', 'dependencies', 'proposal']) {
  test(`runtime apply rejects ${mutation} changed after review without altering progress`, t => {
    const f = fixture(t), prepared = f.prepare();
    if (mutation === 'source') f.write('source.mjs', 'export const changed = true;\n');
    if (mutation === 'runtime') fs.appendFileSync(path.join(f.root, 'codex-plan-runner/protocol.mjs'), '\n// Changed after review\n');
    if (mutation === 'note') f.write('review.md', 'Different scope.\n');
    if (mutation === 'accepted') f.write('receipts/01.md', 'Changed accepted handoff.\n');
    if (mutation === 'history') fs.appendFileSync(path.join(f.stateDir, 'logs/02.jsonl'), 'Changed failure history.\n');
    if (mutation === 'state') { const state = read(f.stateFile); state.steps['02'].attempts++; fs.writeFileSync(f.stateFile, json(state)); }
    if (mutation === 'ignored-config') f.write('.env', 'SYNTHETIC_CONFIGURATION=changed\n');
    if (mutation === 'dependencies') f.write('node_modules/synthetic-dependency/index.js', 'module.exports = 1;\n');
    if (mutation === 'proposal') fs.appendFileSync(path.join(f.root, prepared.file), '\n');
    const before = fs.readFileSync(f.stateFile);
    assert.equal(f.apply(prepared).status, 1);
    assert.deepEqual(fs.readFileSync(f.stateFile), before);
  });
}

test('runtime preparation refuses an active plan lock and a shared-runtime worker', t => {
  const f = fixture(t), owner = { pid: process.pid, worker_pid: null, hostname: os.hostname(), token: 'synthetic-owner' };
  fs.writeFileSync(path.join(f.stateDir, 'runner.lock'), json(owner));
  assert.match(f.command('runtime-prepare', '--runtime-review-note', 'review.md').stderr, /still active/);
  fs.unlinkSync(path.join(f.stateDir, 'runner.lock'));
  f.write('.codex-plan-runner/another-plan/runner.lock', json({ ...owner, runtime_directory: path.join(f.root, 'codex-plan-runner') }));
  assert.match(f.command('runtime-prepare', '--runtime-review-note', 'review.md').stderr, /another runner or worker/);
  assert.deepEqual(read(f.stateFile), f.state);
});

test('runtime application audit is restartable if interrupted before state replacement', t => {
  const f = fixture(t);
  let plan = loadPlan(f.options);
  plan.recoveryPolicy = loadRecoveryPolicy(f.root, plan.manifest);
  const runtime = snapshotRuntime(path.join(f.root, 'codex-plan-runner'));
  const common = { plan, runtime, recipeConfiguration: () => hash('synthetic recipe config'), verifyCompleted: () => {} };
  const prepared = prepareRuntimeUpgrade({ ...common, reviewNote: 'review.md' });
  const options = { ...common, proposalFile: prepared.file, proposalSha256: prepared.sha256, reload: () => loadPlan(f.options) };
  assert.throws(() => applyRuntimeUpgrade({ ...options, writeState: () => { throw new Error('Simulated crash before atomic replacement'); } }), /Simulated crash/);
  assert.deepEqual(read(f.stateFile), f.state);
  const before = fs.readdirSync(path.join(f.stateDir, 'runtime-upgrades'));
  const result = applyRuntimeUpgrade({ ...options, writeState: (file, value) => fs.writeFileSync(file, json(value)) });
  assert.equal(result.alreadyApplied, false);
  assert.deepEqual(fs.readdirSync(path.join(f.stateDir, 'runtime-upgrades')), before);
  assert.deepEqual(read(f.stateFile).steps, f.state.steps);
});

test('a stale in-memory plan cannot bind newer disk state or overwrite unfinished progress', t => {
  const f = fixture(t);
  const plan = loadPlan(f.options);
  plan.recoveryPolicy = loadRecoveryPolicy(f.root, plan.manifest);
  const common = { plan, runtime: snapshotRuntime(path.join(f.root, 'codex-plan-runner')),
    recipeConfiguration: () => hash('synthetic recipe config'), verifyCompleted: () => {} };
  const prepared = prepareRuntimeUpgrade({ ...common, reviewNote: 'review.md' });
  const newer = read(f.stateFile);
  newer.steps['02'].attempts++;
  fs.writeFileSync(f.stateFile, json(newer));
  const before = fs.readFileSync(f.stateFile);
  const files = fs.readdirSync(path.join(f.stateDir, 'runtime-upgrades'));
  assert.throws(() => prepareRuntimeUpgrade({ ...common, reviewNote: 'review.md' }), /state changed after load/);
  assert.throws(() => applyRuntimeUpgrade({ ...common, proposalFile: prepared.file, proposalSha256: prepared.sha256,
    reload: () => loadPlan(f.options), writeState: () => { throw new Error('must not write'); } }), /state changed after load/);
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
  assert.deepEqual(fs.readdirSync(path.join(f.stateDir, 'runtime-upgrades')), files);
});

test('accepted runtime audit cannot be rewritten to hide its authorization history', t => {
  const f = fixture(t), prepared = f.prepare();
  assert.equal(f.apply(prepared).status, 0);
  const state = read(f.stateFile);
  fs.appendFileSync(path.join(f.root, state.recovery.runtime_upgrades[0].record_file), '\n');
  const before = fs.readFileSync(f.stateFile);
  assert.match(f.command('status').stdout, /audit changed/);
  assert.equal(f.command('start', '--step', '02', '--codex-bin', '/must-not-run').status, 1);
  assert.deepEqual(fs.readFileSync(f.stateFile), before);
});

test('runtime commands demand explicit note and SHA and cannot imply feature execution', () => {
  assert.throws(() => parseOptions(['runtime-prepare']), /review-note/);
  assert.throws(() => parseOptions(['runtime-apply', '--proposal', 'proposal.json']), /SHA|sha256/);
  assert.throws(() => parseOptions(['start', '--proposal', 'proposal.json', '--proposal-sha256', 'a'.repeat(64)]), /runtime-apply/);
  assert.throws(() => parseOptions(['runtime-prepare', '--runtime-review-note', 'review.md', '--step', '02']), /not a package selection/);
  assert.equal(parseOptions(['host-check', '--step', '03', '--manifest', 'plan.json']).command, 'host-check');
  assert.throws(() => parseOptions(['host-check', '--step', '02', '--database']), /Invalid or repeated option/);
});

for (const marker of ['CODEX_PLAN_WORKER', 'CODEX_RECOVERY_SUPERVISOR']) test(`${marker} cannot execute or approve parent operations and can inspect read-only status`, t => {
  const f = fixture(t);
  // A never-started plan makes any state-directory creation observable too.
  fs.rmSync(f.stateDir, { recursive: true });
  const invoke = args => spawnSync(process.execPath, [path.join(f.root, 'run.mjs'), ...args, '--repo', f.root, '--manifest', 'plan/manifest.json'], {
    cwd: f.root, encoding: 'utf8', env: { ...process.env, CODEX_PLAN_WORKER: '0', CODEX_RECOVERY_SUPERVISOR: '0', [marker]: '1' }
  });
  for (const args of [
    ['start'], ['resume'], ['host-check', '--step', '02'],
    ['runtime-prepare', '--runtime-review-note', 'review.md'],
    ['runtime-apply', '--proposal', 'does-not-exist.json', '--proposal-sha256', 'a'.repeat(64)]
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /parent operator/);
    assert.equal(fs.existsSync(f.stateDir), false);
  }
  for (const command of ['status', 'dry-run', '--help']) {
    const result = invoke([command]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(f.stateDir), false);
  }
});
