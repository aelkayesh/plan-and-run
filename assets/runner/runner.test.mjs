import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseOptions } from './runner.mjs';

const script = fileURLToPath(new URL('./run.mjs', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('portable CLI requires a manifest and bounds rate, transport, repair and subdivision defaults', () => {
  assert.throws(() => parseOptions([]), /--manifest is required/);
  const options = parseOptions(['--manifest', 'plan/manifest.json']);
  assert.equal(options.repo, process.cwd());
  assert.equal(options.maxRateRetries, 8);
  assert.equal(options.tpmThreshold, 2);
  assert.equal(options.maxSessionRotations, 3);
  assert.equal(parseOptions(['--manifest', 'plan.json', '--max-rate-retries', '0']).maxRateRetries, 0);
  assert.equal(parseOptions(['--manifest', 'plan.json', '--max-session-rotations', '0']).maxSessionRotations, 0);
  assert.throws(() => parseOptions(['--manifest', 'plan.json', '--tpm-threshold', '0']), /must be positive/);
  assert.throws(() => parseOptions(['--manifest', 'plan.json', '--max-session-rotations', '101']), /cannot exceed 100/);
  assert.equal(options.maxTransportRetries, 8);
  assert.equal(options.maxRepairRetries, 3);
  assert.equal(parseOptions(['--manifest', 'plan.json', '--step', '0']).step, '00');
  assert.throws(() => parseOptions(['--manifest', 'plan.json', '--max-repair-retries', '1.5']), /Invalid retry/);
  assert.throws(() => parseOptions(['--manifest', 'plan.json', '--max-transport-retries', '-1']), /Invalid maxTransportRetries/);
});

// This fixture executable never loads Codex or contacts a provider. It models the
// CLI's JSONL events and final-message file independently of the runner's state.
const fakeCodex = String.raw`#!/usr/bin/env node
if (process.argv.includes('login') && process.argv.includes('status')) { console.log('Logged in using ChatGPT'); process.exit(0); }
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync('fake-config.json', 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(config.manifest, 'utf8'));
  const packageId = prompt.match(/^PACKAGE_ID: (\d{2})$/m)?.[1];
  const attemptId = prompt.match(/^ATTEMPT_ID: ([^\s]+)$/m)?.[1];
  const step = manifest.steps.find(candidate => candidate.id === packageId);
  if (!step || !attemptId) throw new Error('Fake worker received no package or attempt identity');
  const option = name => args[args.indexOf(name) + 1];
  const resultFile = option('--output-last-message');
  const schemaFile = option('--output-schema');
  const prior = fs.existsSync('fake-calls.jsonl')
    ? fs.readFileSync('fake-calls.jsonl', 'utf8').trim().split('\n').map(JSON.parse) : [];
  const supervisor = JSON.parse(fs.readFileSync(schemaFile, 'utf8')).properties.classification !== undefined;
  const ordinal = prior.filter(call => call.packageId === packageId && !call.supervisor).length;
  const actions = config.actions[packageId] || ['completed'];
  const action = actions[Math.min(ordinal, actions.length - 1)];
  const threadId = args.includes('resume') ? args.at(-2)
    : '00000000-0000-4000-8000-' + String(Number(packageId) * 100 + ordinal + 1).padStart(12, '0');
  const call = {
    supervisor, args, prompt, packageId, attemptId, threadId, action, pid: process.pid, at: Date.now(),
    schema: JSON.parse(fs.readFileSync(schemaFile, 'utf8')),
    resultFile, schemaFile, resultPrecreated: fs.existsSync(resultFile), workerEnv: process.env.CODEX_PLAN_WORKER
  };
  fs.appendFileSync('fake-calls.jsonl', JSON.stringify(call) + '\n');
  const event = value => process.stdout.write(JSON.stringify(value) + '\n');
  event({ type: 'thread.started', thread_id: threadId });
  fs.writeFileSync('fake-started-' + (prior.length + 1) + '.json', JSON.stringify(call));

  if (supervisor) {
    const blocked = actions[0] === 'blocked';
    fs.writeFileSync(resultFile, JSON.stringify({schema_version:1,package_id:packageId,attempt_id:attemptId,classification:blocked?'external':'implementation',action:blocked?'blocked':'resume',recipe_id:null,summary:'Inspected synthetic partial effects.',changed_files:[],blockers:blocked?['Required local service is unavailable.']:[]}));
    event({type:'turn.completed'});
    return;
  }
  if (action === 'hang') {
    fs.writeFileSync('partial-' + packageId + '.txt', 'Preserve this unfinished tool effect.\n');
    setInterval(() => {}, 1000);
    return;
  }
  if (action === 'signal-interruption') {
    fs.writeFileSync('partial-' + packageId + '.txt', 'Preserve this unfinished tool effect.\n');
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 10);
    return;
  }
  if (['recovered-provider-error', 'recovered-transient-error'].includes(action)) {
    event({ type: 'error', message: 'Token rate limit exceeded, retrying internally' });
    if (action === 'recovered-provider-error') event({ type: 'error', message: 'Authentication failed on fallback provider, retrying configured provider' });
  }
  if (action === 'corrupt-state') fs.writeFileSync('.codex-plan-runner/' + manifest.plan_id + '/state.json', '{ corrupted by worker');
  if (['rate-limit', 'rate-limit-changed-plan', 'authentication', 'quota', 'configuration', 'transport', 'missing-session'].includes(action)) {
    console.error('failed to refresh available models: failed to decode models response');
    if (action === 'rate-limit-changed-plan') fs.appendFileSync(manifest.source, '\nUnauthorized frozen-plan edit.\n');
    const error = action.startsWith('rate-limit')
      ? { message: 'Token rate limit exceeded', code: 'rate_limit_exceeded', retry_after_ms: config.retryAfterMs }
      : action === 'authentication'
        ? { message: 'Invalid API key; authentication failed', status_code: 401 }
        : action === 'quota' ? { message: 'insufficient_quota: credits exhausted' }
        : action === 'configuration' ? { message: 'unknown option --bad' }
        : action === 'missing-session'
          ? { message: 'Session not found: the saved conversation is unavailable' }
        : { message: 'stream disconnected before completion: Transport error: network error' };
    event({ type: 'turn.failed', error });
    process.exitCode = 1;
    return;
  }
  const git = (...values) => execFileSync('git', values, { encoding: 'utf8' }).trim();
  const result = {
    schema_version: 1, package_id: packageId, attempt_id: attemptId,
    status: ['blocked', 'failed', 'incomplete'].includes(action) ? action : 'completed', summary: 'Synthetic fixture check finished.',
    validation_file: step.validation, handoff_file: step.handoff,
    blockers: action === 'blocked' ? ['Required local service is unavailable.'] : []
  };
  const receipt = {
    schema_version: 1, package_id: packageId, attempt_id: attemptId, status: 'completed',
    source: { head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), dirty: true },
    changed_files: [step.validation, step.handoff],
    checks: [{ command: 'node --check fake-codex.mjs', exit_code: 0, passed: true }],
    fixtures: [{ id: 'fake-codex-' + packageId, kind: 'synthetic', location: 'fake-config.json' }], blockers: []
  };
  // A real, local check backs the receipt even though all implementation work is synthetic.
  execFileSync(process.execPath, ['--check', 'fake-codex.mjs']);
  if (action === 'failed-check') receipt.checks[0] = { command: 'synthetic failing check', exit_code: 1, passed: false };
  if (action === 'stale-receipt') receipt.attempt_id = 'stale-attempt';
  if (action === 'stale-result') result.attempt_id = 'stale-attempt';
  if (action === 'wrong-package') result.package_id = '99';
  if (action !== 'missing-receipt') {
    fs.mkdirSync(path.dirname(step.validation), { recursive: true });
    fs.writeFileSync(step.validation, JSON.stringify(receipt, null, 2) + '\n');
  }
  if (action !== 'missing-handoff') {
    fs.mkdirSync(path.dirname(step.handoff), { recursive: true });
    fs.writeFileSync(step.handoff, '# Package ' + packageId + '\nSynthetic check passed. Preserve unrelated files.\n');
  }
  if (action === 'malformed-json') fs.writeFileSync(resultFile, '{ not valid JSON');
  else if (action !== 'missing-result') fs.writeFileSync(resultFile, JSON.stringify(result));
  if (action === 'descendant-pipes') {
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
    fs.writeFileSync('fake-descendant.json', JSON.stringify({ pid: descendant.pid }));
    descendant.unref();
  }
  if (action === 'changed-plan') fs.appendFileSync(manifest.source, '\nUnauthorized frozen-plan edit.\n');
  if (action === 'turn-failed') event({ type: 'turn.failed', error: { message: 'Acceptance check failed' } });
  if (action !== 'missing-turn') event({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  if (action === 'nonzero-exit') process.exitCode = 1;
});
`;

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t, { actions = {}, retryAfterMs = 80, manualId = '15', ready = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'software plan runner test-')));
  const runners = new Set();
  t.after(async () => {
    for (const runner of runners) {
      if (runner.child.exitCode === null && runner.child.signalCode === null) runner.child.kill('SIGTERM');
      await runner.done;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const manifestPath = 'plan files/manifest.json';
  const ids = ['01', '02', '03', '15'];
  const manifest = {
    schema_version: 1, plan_id: 'integration-plan', ready, source: 'plan files/source.md', contract: 'plan files/contract.md', worker_contract: 'plan files/worker-contract.md',
    steps: ids.map((id, index) => ({
      id, title: `Fixture package ${id}`, plan: `plan files/${id}-plan.md`,
      validation: `receipts/${id}-validation.json`, handoff: `handoffs/${id}-handoff.md`,
      dependencies: index ? [ids[index - 1]] : [], manual: id === manualId
    }))
  };
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  write('fake-auth/fixture-profile.config.toml', 'model_provider = "openai"\n');
  write(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  for (const file of [manifest.source, manifest.contract, manifest.worker_contract, ...manifest.steps.map(step => step.plan)]) write(file, `Synthetic fixture: ${file}\n`);
  write('AGENTS.md', 'Preserve unrelated changes. Use synthetic local fixtures only.\n');
  write('.gitignore', '.codex-plan-runner/\nfake-calls.jsonl\nfake-started-*.json\n');
  write('unrelated.txt', 'Original tracked content.\n');
  write('fake-config.json', JSON.stringify({ manifest: manifestPath, actions, retryAfterMs }));
  write('fake-codex.mjs', fakeCodex);
  fs.chmodSync(path.join(root, 'fake-codex.mjs'), 0o755);
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'Runner integration fixture');
  git(root, 'add', '.');
  git(root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Initial synthetic fixture');
  write('unrelated.txt', 'User work present before the runner.\n');
  write('untracked-user-note.txt', 'Keep this untracked note byte for byte.\n');
  return {
    root, manifestPath, manifest, runners, head: git(root, 'rev-parse', 'HEAD'),
    stateDir: path.join(root, '.codex-plan-runner', manifest.plan_id),
    stateFile: path.join(root, '.codex-plan-runner', manifest.plan_id, 'state.json')
  };
}

function readState(f) {
  return fs.existsSync(f.stateFile) ? JSON.parse(fs.readFileSync(f.stateFile, 'utf8')) : null;
}

function calls(f) {
  const file = path.join(f.root, 'fake-calls.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

function startRunner(t, f, options = [], command = 'start', extraEnv = {}) {
  const defaults = ['--progress-seconds', '0', '--timeout-minutes', '0', '--retry-delay-seconds', '0.03', '--max-delay-seconds', '0.06'];
  const selectedDefaults = [];
  for (let index = 0; index < defaults.length; index += 2) {
    if (!options.includes(defaults[index])) selectedDefaults.push(defaults[index], defaults[index + 1]);
  }
  const child = spawn(process.execPath, [script, command, '--repo', f.root, '--manifest', f.manifestPath,
    '--codex-bin', path.join(f.root, 'fake-codex.mjs'), ...selectedDefaults, ...options],
  { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: path.join(f.root,'fake-auth'), CODEX_PLAN_WORKER: '0', CODEX_RECOVERY_SUPERVISOR: '0', NO_COLOR: '1', ...extraEnv } });
  let stdout = '', stderr = '', timedOut = false, forceKill;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const deadline = setTimeout(() => {
    timedOut = true; child.kill('SIGTERM');
    forceKill = setTimeout(() => child.kill('SIGKILL'), 1000);
  }, 12_000);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => {
      clearTimeout(deadline); clearTimeout(forceKill);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
  });
  const runner = { child, done, stdout: () => stdout, stderr: () => stderr };
  f.runners.add(runner);
  return runner;
}

async function run(t, f, options = [], command = 'start', extraEnv = {}) {
  const result = await startRunner(t, f, options, command, extraEnv).done;
  assert.equal(result.timedOut, false, `Runner timed out:\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.signal, null, `Runner terminated unexpectedly:\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function waitForWorker(f, number = 1) {
  return waitFor(() => {
    const started = path.join(f.root, `fake-started-${number}.json`);
    if (!fs.existsSync(started)) return false;
    const call = JSON.parse(fs.readFileSync(started, 'utf8'));
    const entry = readState(f)?.steps[call.packageId];
    return entry?.status === 'running' && entry.thread_id === call.threadId ? call : false;
  }, `worker ${number} to start and persist its session`);
}

function assertPreserved(f, { lockExists = false } = {}) {
  assert.equal(fs.readFileSync(path.join(f.root, 'unrelated.txt'), 'utf8'), 'User work present before the runner.\n');
  assert.equal(fs.readFileSync(path.join(f.root, 'untracked-user-note.txt'), 'utf8'), 'Keep this untracked note byte for byte.\n');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.head);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'runner.lock')), lockExists);
}

function deadProcessId() {
  const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  return pid;
}

function treeSnapshot(root, relative = '') {
  const result = {};
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!relative && entry.name === '.git') continue;
    const name = path.join(relative, entry.name), file = path.join(root, name), stat = fs.lstatSync(file);
    result[name] = { mode: stat.mode, mtime: stat.mtimeMs, content: entry.isFile() ? fs.readFileSync(file).toString('base64') : null };
    if (entry.isDirectory()) Object.assign(result, treeSnapshot(root, name));
  }
  return result;
}

function assertInvocation(f, call, { resumed = false, profile, model } = {}) {
  const { args } = call;
  assert.equal(args[0], 'exec');
  assert.equal(args.at(-1), '-');
  assert.equal(args.includes('resume'), resumed);
  assert.equal(args[args.indexOf('-C') + 1], f.root);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(args[args.indexOf('-c') + 1], 'approval_policy="never"');
  assert.equal(args.includes('--yolo'), false);
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.ok(uuid.test(call.attemptId));
  assert.ok(uuid.test(call.threadId));
  assert.equal(call.resultPrecreated, true);
  assert.equal(call.schemaFile, path.join(f.stateDir, 'result-schema.json'));
  assert.equal(path.dirname(call.resultFile), path.join(f.stateDir, 'logs'));
  assert.equal(call.schema.additionalProperties, false);
  assert.equal(call.schema.properties.schema_version.const, 1);
  assert.deepEqual([...call.schema.required].sort(), ['schema_version', 'package_id', 'attempt_id', 'status', 'summary', 'validation_file', 'handoff_file', 'blockers'].sort());
  assert.match(call.prompt, /Keep all unrelated and pre-existing uncommitted work/);
  assert.equal(call.workerEnv, '1');
  assert.match(call.prompt, /^CODEX_PLAN_WORKER=1/m);
  assert.match(call.prompt, /Never initialize another plan/);
  assert.ok(call.prompt.includes(f.manifest.worker_contract));
  if (profile) assert.equal(args[args.indexOf('--profile') + 1], profile);
  if (model) assert.equal(args[args.indexOf('--model') + 1], model);
  if (resumed) {
    const position = args.indexOf('resume');
    for (const name of ['--sandbox', '-c', '-C', ...(profile ? ['--profile'] : [])]) {
      assert.ok(args.indexOf(name) < position, `${name} must be an exec option before resume`);
    }
    assert.ok(args.indexOf('--json') > position);
    assert.ok(args.indexOf('--output-schema') > position);
    assert.ok(args.indexOf('--output-last-message') > position);
    assert.equal(args.at(-2), call.threadId);
    assert.match(call.prompt, /Resume this package in its saved conversation/);
  } else {
    assert.match(call.prompt, /Start a fresh conversation for this package/);
  }
}

test('packages run sequentially in fresh sessions; completed packages are verified and skipped', async t => {
  const f = fixture(t, { manualId: null });
  const first = await run(t, f);
  assert.equal(first.status, 0, first.stderr);
  const invoked = calls(f), state = readState(f);
  assert.deepEqual(invoked.map(call => call.packageId), ['01', '02', '03', '15']);
  assert.equal(new Set(invoked.map(call => call.threadId)).size, 4);
  assert.equal(new Set(invoked.map(call => call.attemptId)).size, 4);
  for (const call of invoked) {
    assertInvocation(f, call);
    const entry = state.steps[call.packageId], step = f.manifest.steps.find(step => step.id === call.packageId);
    assert.equal(entry.status, 'completed');
    assert.equal(entry.attempts, 1);
    assert.equal(entry.thread_id, call.threadId);
    assert.equal(entry.last_attempt.attempt_id, call.attemptId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, step.validation))).attempt_id, call.attemptId);
    assert.match(entry.artifacts.validation_sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(state.steps['15'].status, 'completed');
  assert.match(first.stdout, /Requested package range completed/);
  const second = await run(t, f, [], 'resume');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(calls(f).length, 4);
  for (const id of ['01', '02', '03', '15']) assert.match(second.stdout, new RegExp(`Skipping completed package ${id}`));
  assertPreserved(f);
});

test('rate limits retry the saved session with fresh attempt identities and valid resume arguments', async t => {
  const f = fixture(t, { actions: { '01': ['rate-limit', 'completed'] }, retryAfterMs: 100 });
  const result = await run(t, f, ['--to', '02', '--model', 'fixture-model', '--profile', 'fixture-profile']);
  assert.equal(result.status, 0, result.stderr);
  const invoked = calls(f);
  assert.deepEqual(invoked.map(call => call.packageId), ['01', '01', '02']);
  assert.equal(invoked[0].threadId, invoked[1].threadId);
  assert.notEqual(invoked[0].attemptId, invoked[1].attemptId);
  assert.notEqual(invoked[0].resultFile, invoked[1].resultFile);
  assert.ok(invoked[1].at - invoked[0].at >= 100);
  invoked.forEach((call, index) => assertInvocation(f, call, { resumed: index === 1, model: 'fixture-model', profile: 'fixture-profile' }));
  assert.match(invoked[1].prompt, /Token rate limit exceeded/);
  assert.equal(readState(f).steps['01'].rate_limit_count, 1);
  assertPreserved(f);
});

test('a saved provider cooldown survives interruption and restart before the same session resumes', async t => {
  const f = fixture(t, { actions: { '01': ['rate-limit', 'completed'] }, retryAfterMs: 1800 });
  const first = startRunner(t, f, ['--step', '01']);
  const waiting = await waitFor(() => {
    const entry = readState(f)?.steps['01'];
    return entry?.status === 'waiting-for-rate-limit' && entry.retry_at ? entry : false;
  }, 'saved provider cooldown');
  const deadline = Date.parse(waiting.retry_at);
  first.child.kill('SIGTERM');
  const stopped = await first.done;
  assert.equal(stopped.status, 143, stopped.stderr);
  assert.equal(calls(f).length, 1);
  const saved = readState(f).steps['01'];
  assert.equal(saved.retry_at, waiting.retry_at);
  assert.equal(saved.thread_id, calls(f)[0].threadId);
  const restarted = await run(t, f, ['--step', '01'], 'resume');
  assert.equal(restarted.status, 0, restarted.stderr);
  const invoked = calls(f);
  assert.equal(invoked.length, 2);
  assert.ok(invoked[1].at >= deadline, `Worker restarted at ${invoked[1].at}, before saved deadline ${deadline}`);
  assertInvocation(f, invoked[1], { resumed: true });
  assert.equal(readState(f).steps['01'].retry_at, undefined);
  assertPreserved(f);
});

test('finite rate retry budget stops with the next retry deadline and preserved session', async t => {
  const f = fixture(t, { actions: { '01': ['rate-limit'] }, retryAfterMs: 40 });
  const result = await run(t, f, ['--step', '01', '--max-rate-retries', '1']);
  assert.equal(result.status, 75, result.stderr);
  assert.equal(calls(f).length, 2);
  const entry = readState(f).steps['01'];
  assert.equal(entry.status, 'waiting-for-rate-limit');
  assert.equal(entry.rate_limit_count, 2);
  assert.equal(entry.attempts, 2);
  assert.ok(Number.isFinite(Date.parse(entry.retry_at)));
  assert.equal(entry.thread_id, calls(f)[0].threadId);
  assertPreserved(f);
});

for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} stops the worker and resumes the same package without losing partial or unrelated files`, async t => {
    const f = fixture(t, { actions: { '01': ['hang', 'completed'] } });
    const first = startRunner(t, f, ['--step', '01']);
    const initial = await waitForWorker(f);
    first.child.kill(signal);
    const result = await first.done;
    assert.equal(result.status, expectedCode, result.stderr);
    assert.equal(readState(f).steps['01'].status, 'interrupted');
    assert.equal(readState(f).steps['01'].thread_id, initial.threadId);
    assert.equal(fs.existsSync(path.join(f.stateDir, 'runner.lock')), false);
    assert.throws(() => process.kill(initial.pid, 0), error => error.code === 'ESRCH');
    const resumed = await run(t, f, ['--step', '01'], 'resume');
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(calls(f).map(call => call.packageId), ['01', '01']);
    assertInvocation(f, calls(f)[1], { resumed: true });
    assert.equal(fs.readFileSync(path.join(f.root, 'partial-01.txt'), 'utf8'), 'Preserve this unfinished tool effect.\n');
    assertPreserved(f);
  });
}

for (const action of ['malformed-json', 'missing-result', 'missing-receipt', 'missing-handoff', 'failed-check',
  'stale-result', 'stale-receipt', 'wrong-package', 'missing-turn', 'turn-failed', 'nonzero-exit', 'changed-plan']) {
  test(`${action} cannot falsely complete a package or start its successor`, async t => {
    const f = fixture(t, { actions: { '01': [action] } });
    const result = await run(t, f, ['--max-repair-retries', '0']);
    assert.ok([1,75].includes(result.status), result.stderr);
    const protocolFailure = ['malformed-json', 'missing-result', 'stale-result', 'wrong-package'].includes(action);
    const invoked = calls(f);
    assert.deepEqual(invoked.map(call => call.packageId), protocolFailure ? ['01','01','01'] : ['01']);
    const state = readState(f);
    assert.equal(state.steps['01'].status, 'failed');
    assert.equal(state.steps['02'], undefined);
    if (protocolFailure) {
      assert.equal(new Set(invoked.map(call => call.threadId)).size, 1);
      assert.equal(invoked.some(call => call.supervisor), false);
      assert.match(invoked[1].prompt, /PROTOCOL_CORRECTION_REQUIRED/);
      const recovery = state.steps['01'].recovery;
      assert.equal(recovery.protocol_retry_count, 2);
      assert.equal(recovery.repair_count, 0);
      assert.equal(recovery.phase, 'needs-attention');
      assert.equal(recovery.budget_kind, 'protocol');
      const rejected = recovery.history.filter(item => item.action === 'protocol-rejected');
      assert.equal(rejected.length, 3);
      assert.ok(rejected.every(item => fs.existsSync(path.join(f.root, item.file))));
    } else {
      assert.match(result.stdout, /Failure report:/);
      assert.ok(fs.readdirSync(path.join(f.stateDir, 'logs')).some(name => name.endsWith('-failure.json')));
    }
    assertPreserved(f);
  });
}

test('an explicit blocker stops with a blocker state and does not schedule the next package', async t => {
  const f = fixture(t, { actions: { '01': ['blocked'] } });
  const result = await run(t, f);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(readState(f).steps['01'].status, 'blocked');
  assert.equal(calls(f).length, 2);
  assert.equal(calls(f)[1].supervisor, true);
  assert.match(result.stdout, /Required local service is unavailable/);
  assertPreserved(f);
});

for (const action of ['authentication', 'quota', 'configuration']) {
  test(`${action} errors stop without automatic retries`, async t => {
    const f = fixture(t, { actions: { '01': [action, 'completed'] } });
    const result = await run(t, f);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(calls(f).length, 1);
    const entry = readState(f).steps['01'];
    assert.equal(entry.status, 'failed');
    assert.equal(entry.retry_at, undefined);
    assert.equal(entry.rate_limit_count, 0);
    assert.match(result.stdout, new RegExp(`Provider ${action} requires operator action:`));
    assertPreserved(f);
  });
}

test('a concurrent runner cannot invoke another worker or overwrite active state', async t => {
  const f = fixture(t, { actions: { '01': ['hang'] } });
  const owner = startRunner(t, f, ['--step', '01']);
  await waitForWorker(f);
  const before = fs.readFileSync(f.stateFile, 'utf8');
  const contender = await run(t, f, ['--step', '01']);
  assert.equal(contender.status, 1);
  assert.match(contender.stderr, /Another runner or its worker is still active/);
  assert.equal(calls(f).length, 1);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  owner.child.kill('SIGTERM');
  assert.equal((await owner.done).status, 143);
  assertPreserved(f);
});

test('selecting a package with missing prerequisites stops before any worker invocation', async t => {
  const f = fixture(t);
  const result = await run(t, f, ['--step', '02']);
  assert.equal(result.status, 2);
  assert.match(result.stdout + result.stderr, /Package 02 requires 01/);
  assert.deepEqual(calls(f), []);
  assert.equal(fs.existsSync(f.stateFile), false);
  assertPreserved(f);
});

for (const manualId of ['03', '15']) {
  test(`manual package ${manualId} stops at an incomplete boundary`, async t => {
    const f = fixture(t, { manualId });
    const direct = await run(t, f, ['--step', manualId]);
    assert.equal(direct.status, 2);
    assert.match(direct.stdout + direct.stderr, /manual boundary/);
    assert.deepEqual(calls(f), []);
    assert.equal(fs.existsSync(f.stateFile), false);
    const full = await run(t, f);
    assert.equal(full.status, 2, full.stderr);
    const completed = manualId === '03' ? ['01', '02'] : ['01', '02', '03'];
    assert.deepEqual(calls(f).map(call => call.packageId), completed);
    assert.equal(readState(f).steps[manualId], undefined);
    assert.match(full.stdout, new RegExp(`Incomplete: stopped before package ${manualId}`));
    assert.doesNotMatch(full.stdout, /Requested package range completed/);
    assertPreserved(f);
  });
}

test('status and dry-run are read-only before a run and with existing completed state', async t => {
  const f = fixture(t);
  const before = treeSnapshot(f.root);
  for (const command of ['status', 'dry-run']) {
    const result = await run(t, f, [], command);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /manual approval boundary/);
    assert.match(result.stdout, /02  pending.*\[needs 01\]/);
    assert.deepEqual(treeSnapshot(f.root), before);
    assert.equal(fs.existsSync(f.stateDir), false);
  }
  assert.equal((await run(t, f, ['--step', '01'])).status, 0);
  const after = treeSnapshot(f.root);
  for (const command of ['status', 'dry-run']) {
    const result = await run(t, f, [], command);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /01  completed/);
    assert.deepEqual(treeSnapshot(f.root), after);
  }
  assert.equal(calls(f).length, 1);
  assertPreserved(f);
});

test('changed completed receipts stop a restart before another package is invoked', async t => {
  const f = fixture(t);
  assert.equal((await run(t, f, ['--step', '01'])).status, 0);
  fs.appendFileSync(path.join(f.root, f.manifest.steps[0].validation), '\n');
  const result = await run(t, f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Completed package 01 artifacts changed or are missing/);
  assert.equal(calls(f).length, 1);
  assert.equal(readState(f).steps['02'], undefined);
  assertPreserved(f);
});

test('worker descendants holding inherited output pipes are stopped when their parent exits', async t => {
  const f = fixture(t, { actions: { '01': ['descendant-pipes'] } });
  const started = Date.now();
  const result = await run(t, f, ['--step', '01', '--timeout-minutes', '0.1']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(Date.now() - started < 6000, 'Inherited pipes must close before the worker timeout');
  const { pid } = JSON.parse(fs.readFileSync(path.join(f.root, 'fake-descendant.json'), 'utf8'));
  await waitFor(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, 'the inherited-pipe descendant to exit');
  assert.equal(readState(f).steps['01'].status, 'completed');
  assertPreserved(f);
});

test('a missing saved session receives one recorded fresh replacement', async t => {
  const f = fixture(t, { actions: { '01': ['rate-limit', 'missing-session', 'completed'] }, retryAfterMs: 40 });
  const recovered = await run(t,f,['--step','01']);
  assert.equal(recovered.status,0,recovered.stderr);
  const invoked=calls(f); assert.equal(invoked.length,3);
  assertInvocation(f,invoked[1],{resumed:true});assertInvocation(f,invoked[2]);
  assert.notEqual(invoked[2].threadId,invoked[1].threadId);
  assert.equal(readState(f).steps['01'].recovery.session_replacement_count,1);
  assert.equal(readState(f).steps['01'].status,'completed');assertPreserved(f);
});

test('frozen plan changes during a rate-limited attempt stop before another worker starts', async t => {
  const f = fixture(t, { actions: { '01': ['rate-limit-changed-plan', 'completed'] }, retryAfterMs: 40 });
  const result = await run(t, f, ['--step', '01']);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /(?:frozen plan|plan.*changed|plan.*match)/i);
  assert.equal(calls(f).length, 1);
  assert.notEqual(readState(f).steps['01'].status, 'completed');
  assertPreserved(f);
});

test('a stale lock from a confirmed exited owner is recovered before running a package', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.stateDir, { recursive: true });
  fs.writeFileSync(path.join(f.stateDir, 'runner.lock'), JSON.stringify({
    pid: deadProcessId(), worker_pid: null, hostname: os.hostname(), token: 'stale-lock-fixture'
  }));
  const result = await run(t, f, ['--step', '01']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls(f).length, 1);
  assert.equal(readState(f).steps['01'].status, 'completed');
  assertPreserved(f);
});

test('a live orphan worker preserves its lock and prevents a replacement worker from starting', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.stateDir, { recursive: true });
  const lockFile = path.join(f.stateDir, 'runner.lock');
  const lock = JSON.stringify({
    pid: deadProcessId(), worker_pid: process.pid, hostname: os.hostname(), token: 'live-worker-fixture'
  });
  fs.writeFileSync(lockFile, lock);
  const result = await run(t, f, ['--step', '01']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Another runner or its worker is still active/);
  assert.deepEqual(calls(f), []);
  assert.equal(readState(f), null);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), lock);
  assert.equal(process.kill(process.pid, 0), true);
  assertPreserved(f, { lockExists: true });
});

test('corrupt state JSON is preserved and rejected without invoking a worker', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.stateDir, { recursive: true });
  const corruptState = '{ "schema_version": 1, "steps": ';
  fs.writeFileSync(f.stateFile, corruptState);
  const before = treeSnapshot(f.root);
  const result = await run(t, f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /JSON|Unexpected|position/i);
  assert.deepEqual(calls(f), []);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), corruptState);
  const outsideState = snapshot => Object.fromEntries(Object.entries(snapshot).filter(([file]) => !file.startsWith('.codex-plan-runner')));
  assert.deepEqual(outsideState(treeSnapshot(f.root)), outsideState(before));
  assert.ok(fs.readdirSync(path.join(f.stateDir,'reports')).some(name=>name.endsWith('.json')));
  assertPreserved(f);
});

test('transport interruptions automatically continue the saved session', async t => {
  const f = fixture(t, { actions: { '01': ['transport', 'completed'] } });
  const result = await run(t, f, ['--to', '02']);
  assert.equal(result.status, 0, result.stderr);
  const invoked = calls(f);
  assert.deepEqual(invoked.map(call => call.packageId), ['01', '01', '02']);
  assert.equal(invoked[0].threadId, invoked[1].threadId);
  assertInvocation(f, invoked[1], { resumed: true });
  assert.match(invoked[1].prompt, /stream disconnected/);
  assert.match(invoked[1].prompt, /Unknown external effects must be inspected and reconciled/);
  assert.equal(readState(f).steps['01'].recovery.transport_count, 1);
  assert.equal(readState(f).steps['01'].retry_at, undefined);
  assertPreserved(f);
});

test('an attempt timeout continues the saved session after inspecting partial work', async t => {
  const f = fixture(t, { actions: { '01': ['hang', 'completed'] } });
  const result = await run(t, f, ['--step', '01', '--timeout-minutes', '0.02']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(calls(f).length, 2);
  assertInvocation(f, calls(f)[1], { resumed: true });
  assert.match(calls(f)[1].prompt, /timeout/);
  assert.equal(fs.readFileSync(path.join(f.root, 'partial-01.txt'), 'utf8'), 'Preserve this unfinished tool effect.\n');
  assertPreserved(f);
});

for (const limit of [0, 1]) {
  test(`transport retry limit ${limit} is finite and saves its cooldown`, async t => {
    const f = fixture(t, { actions: { '01': ['transport'] } });
    const result = await run(t, f, ['--max-transport-retries', String(limit)]);
    assert.equal(result.status, 75, result.stderr);
    assert.equal(calls(f).length, limit + 1);
    const entry = readState(f).steps['01'];
    assert.equal(entry.status, 'failed');
    assert.equal(entry.recovery.failure_kind, 'transport');
    assert.equal(entry.recovery.phase, 'needs-attention');
    assert.ok(Number.isFinite(Date.parse(entry.retry_at)));
    assert.equal(readState(f).steps['02'], undefined);
    assertPreserved(f);
  });
}

for (const action of ['incomplete', 'failed', 'failed-check']) {
  test(`${action} is supervised before the saved worker resumes and a successor runs`, async t => {
    const f = fixture(t,{actions:{'01':[action,'completed']}});
    const result=await run(t,f,['--to','02']);assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
    const invoked=calls(f);assert.deepEqual(invoked.map(call=>call.packageId),['01','01','01','02']);
    assert.equal(invoked[1].supervisor,true);assert.equal(invoked[0].threadId,invoked[2].threadId);
    assertInvocation(f,invoked[2],{resumed:true});assert.equal(readState(f).steps['01'].recovery.repair_count,1);
    assert.equal(readState(f).steps['01'].status,'completed');assertPreserved(f);
  });
}

test('malformed worker output is corrected in the same session before its successor runs', async t => {
  const f = fixture(t, { actions: { '01': ['malformed-json', 'completed'] } });
  const result = await run(t, f, ['--to', '02']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const invoked = calls(f);
  assert.deepEqual(invoked.map(call => call.packageId), ['01','01','02']);
  assert.equal(invoked.some(call => call.supervisor), false);
  assert.equal(invoked[0].threadId, invoked[1].threadId);
  assertInvocation(f, invoked[1], { resumed: true });
  assert.match(invoked[1].prompt, /PROTOCOL_CORRECTION_REQUIRED/);
  const recovery = readState(f).steps['01'].recovery;
  assert.equal(recovery.protocol_retry_count, 1); assert.equal(recovery.repair_count, 0);
  assert.equal(recovery.history.filter(item => item.action === 'protocol-rejected').length, 1);
  assert.equal(readState(f).steps['01'].status, 'completed'); assertPreserved(f);
});

test('default no-progress budget stops repeated unchanged incomplete work', async t => {
  const f=fixture(t,{actions:{'01':['incomplete']}});const result=await run(t,f);
  assert.equal(result.status,75,result.stderr);assert.equal(calls(f).length,3);
  assert.equal(readState(f).steps['01'].recovery.no_progress_count,2);
  assert.equal(readState(f).steps['02'],undefined);assert.match(result.stdout,/no-progress limit/);
  const again=await run(t,f);assert.equal(again.status,75);assert.equal(calls(f).length,3);assertPreserved(f);
});

test('plan corruption is never retried even when repair retries are enabled', async t => {
  const f = fixture(t, { actions: { '01': ['changed-plan', 'completed'] } });
  const result = await run(t, f);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(calls(f).length, 1);
  assert.match(result.stdout, /frozen plan.*changed/i);
  assertPreserved(f);
});

test('worker-contract changes invalidate saved state before another invocation', async t => {
  const f = fixture(t);
  assert.equal((await run(t, f, ['--step', '01'])).status, 0);
  fs.appendFileSync(path.join(f.root, f.manifest.worker_contract), 'Changed contract.\n');
  const result = await run(t, f);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /state does not match/);
  assert.equal(calls(f).length, 1);
  assertPreserved(f);
});

test('an unready scaffold permits read-only previews and refuses execution', async t => {
  const f = fixture(t, { ready: false });
  const before = treeSnapshot(f.root);
  for (const command of ['status', 'dry-run', 'start', 'resume']) {
    const result = await run(t, f, [], command);
    if (['start', 'resume'].includes(command)) {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Plan is not ready/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Ready: false/);
    }
    const outsideState = snapshot => Object.fromEntries(Object.entries(snapshot).filter(([file]) => !file.startsWith('.codex-plan-runner')));
    assert.deepEqual(outsideState(treeSnapshot(f.root)), outsideState(before));
  }
  assert.deepEqual(calls(f), []);
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('workers cannot start or resume nested runners but can inspect status', async t => {
  const f = fixture(t);
  const before = treeSnapshot(f.root);
  for (const command of ['start', 'resume', 'status', 'dry-run']) {
    const result = await run(t, f, [], command, { CODEX_PLAN_WORKER: '1' });
    if (['start', 'resume'].includes(command)) {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Worker recursion denied/);
    } else assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(treeSnapshot(f.root), before);
  }
  assert.deepEqual(calls(f), []);
  assert.equal(fs.existsSync(f.stateDir), false);
});

test('permanent provider failure prevents completion despite a same-invocation completion result', async t => {
  const f = fixture(t, { actions: { '01': ['recovered-provider-error'] } });
  const result = await run(t, f, ['--step', '01']);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(calls(f).length, 1);
  const entry = readState(f).steps['01'];
  assert.equal(entry.status, 'failed');
  assert.equal(entry.rate_limit_count, 0);
  assert.equal(entry.retry_at, undefined);
  assert.equal(entry.artifacts, undefined);
  assert.match(result.stdout, /Provider authentication requires operator action:/);
  assertPreserved(f);
});

test('verified completion wins over transient provider errors recovered within the same invocation', async t => {
  const f = fixture(t, { actions: { '01': ['recovered-transient-error'] } });
  const result = await run(t, f, ['--step', '01']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(calls(f).length, 1);
  assert.equal(readState(f).steps['01'].status, 'completed');
  assert.equal(readState(f).steps['01'].rate_limit_count, 0);
  assertPreserved(f);
});

test('an unexpectedly terminated worker resumes as a transient transport interruption', async t => {
  const f = fixture(t, { actions: { '01': ['signal-interruption', 'completed'] } });
  const result = await run(t, f, ['--step', '01']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(calls(f).length, 2);
  assertInvocation(f, calls(f)[1], { resumed: true });
  assert.equal(readState(f).steps['01'].recovery.transport_count, 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'partial-01.txt'), 'utf8'), 'Preserve this unfinished tool effect.\n');
  assertPreserved(f);
});

test('state corruption during a worker is preserved and never automatically retried', async t => {
  const f = fixture(t, { actions: { '01': ['corrupt-state', 'completed'] } });
  const result = await run(t, f);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /state revision.content changed/);
  assert.equal(calls(f).length, 1);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), '{ corrupted by worker');
  assertPreserved(f);
});
