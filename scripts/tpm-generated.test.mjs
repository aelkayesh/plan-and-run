import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

// Independent end-to-end consumer of prepare.mjs and the generated wrapper.
// All parent-role children, fake providers, Git commits and signals are confined
// to this test's disposable repositories. No actual model process is invoked.
const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = 'portable-tpm';
const bundlePath = `docs/implementation-plans/${slug}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const parentEnv = () => ({ ...process.env, CODEX_PLAN_WORKER: '0', CODEX_RECOVERY_SUPERVISOR: '0', GIT_OPTIONAL_LOCKS: '0' });

const fakeProvider = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { snapshotSource } from './docs/implementation-plans/portable-tpm/runner/host-validation.mjs';
if(process.argv.includes('login')&&process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  const marker = name => input.match(new RegExp('^' + name + ': (.+)$', 'm'))?.[1];
  const schema = JSON.parse(fs.readFileSync(option('--output-schema'), 'utf8'));
  const role = schema.properties.classification ? 'supervisor' : marker('ROLE') || 'worker';
  const config = JSON.parse(fs.readFileSync('fixture-config.json', 'utf8'));
  const manifest = JSON.parse(fs.readFileSync('docs/implementation-plans/portable-tpm/runner-manifest.json', 'utf8'));
  const packageId = marker('PACKAGE_ID'), attemptId = marker('ATTEMPT_ID');
  const subdivisionId = marker('SUBDIVISION_ID'), taskId = marker('SUBTASK_ID');
  const step = manifest.steps.find(item => item.id === packageId);
  const prior = fs.existsSync('provider-calls.jsonl') ? fs.readFileSync('provider-calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const threadId = args.includes('resume') ? args.at(-2) : randomUUID();
  const call = { role, packageId, attemptId, subdivisionId, taskId, threadId, args, prompt: input, at: Date.now() };
  fs.appendFileSync('provider-calls.jsonl', JSON.stringify(call) + '\n');
  const event = value => process.stdout.write(JSON.stringify(value) + '\n');
  event({ type: 'thread.started', thread_id: threadId });
  const stateFile = '.codex-plan-runner/portable-tpm/state.json';
  // Wait for the real parent to journal the session before the simulated crash.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fs.existsSync(stateFile) && fs.readFileSync(stateFile, 'utf8').includes(threadId)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const emit = value => {
    fs.writeFileSync(option('--output-last-message'), JSON.stringify(value));
    event({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  };
  const tpm = () => {
    event({ type: 'turn.failed', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached on tokens per minute (TPM): Limit 1000, Used 900, Requested 300. Please try again.', retry_after_ms: 70 } });
    process.exitCode = 1;
  };
  const source = () => snapshotSource(process.cwd(), [step.validation, step.handoff, path.join(path.dirname(step.plan), 'README.md')]).sha256;
  const check = (command, argv) => {
    const result = spawnSync(process.execPath, argv, { encoding: 'utf8' });
    if (result.error) throw result.error;
    fs.appendFileSync('actual-checks.jsonl', JSON.stringify({ role, taskId, command, status: result.status, stdout: result.stdout, stderr: result.stderr }) + '\n');
    return { command, exit_code: result.status, passed: result.status === 0 };
  };
  const partial = 'export const partial = "preserved first attempt";\n';
  assert.equal(fs.readFileSync('unrelated.txt', 'utf8'), 'Existing dirty user content.\n');
  if (role === 'worker' && packageId === '15') {
    if (!prior.some(row => row.role === 'worker')) {
      fs.writeFileSync('source/partial.mjs', partial);
      fs.appendFileSync('partial-effects.jsonl', JSON.stringify({ effect: 'first-worker', attemptId }) + '\n');
    }
    tpm(); return;
  }
  assert.equal(fs.readFileSync('source/partial.mjs', 'utf8'), partial);
  if (role === 'planner') {
    emit({ schema_version: 1, package_id: packageId, attempt_id: attemptId, subdivision_id: subdivisionId,
      status: 'planned', summary: 'Two small source changes; retain original aggregate acceptance.', source_sha256: marker('SOURCE_SHA256'),
      subtasks: ['01', '02'].map(id => ({ id, title: 'Source export ' + id, instructions: 'Preserve partial effects; write only source/task-' + id + '.mjs and check syntax.',
        checks: ['node --check source/task-' + id + '.mjs'], checkpoint_file: marker('ARTIFACT_DIRECTORY') + '/' + id + '-checkpoint.json' })), blockers: [] });
    return;
  }
  if (role === 'subtask') {
    if (config.subtaskTpm) { tpm(); return; }
    const previousSameTask = prior.filter(row => row.role === 'subtask' && row.taskId === taskId);
    if (config.interruptSecond && taskId === '02' && previousSameTask.length === 0) {
      fs.writeFileSync('source/second-partial.mjs', 'export const resumed = true;\n');
      fs.appendFileSync('partial-effects.jsonl', JSON.stringify({ effect: 'second-subtask', attemptId }) + '\n');
      fs.writeFileSync('waiting.json', JSON.stringify(call));
      setInterval(() => {}, 1000); return;
    }
    if (config.interruptSecond && taskId === '02') assert.equal(fs.readFileSync('source/second-partial.mjs', 'utf8'), 'export const resumed = true;\n');
    const file = 'source/task-' + taskId + '.mjs';
    fs.writeFileSync(file, 'export const value = ' + (config.failFinal && taskId === '02' ? 999 : Number(taskId)) + ';\n');
    const checks = [check('node --check ' + file, ['--check', file])];
    const checkpoint = { schema_version: 1, package_id: packageId, attempt_id: attemptId, subdivision_id: subdivisionId, subtask_id: taskId,
      summary: 'Partial effects inspected; source syntax passed.', source_sha256: source(), changed_files: [file], checks, blockers: [],
      next_steps: ['Run remaining source task and the original node acceptance.mjs check.'] };
    const checkpointFile = marker('CHECKPOINT_FILE');
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
    fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint));
    const result = { ...checkpoint, status: 'checkpointed', checkpoint_file: checkpointFile,
      checkpoint_sha256: createHash('sha256').update(fs.readFileSync(checkpointFile)).digest('hex') };
    delete result.next_steps; emit(result); return;
  }
  if (role === 'supervisor') {
    emit({ schema_version: 1, package_id: packageId, attempt_id: attemptId, classification: 'external', action: 'blocked', recipe_id: null,
      summary: 'Synthetic final acceptance failure requires explicit fixture decision.', changed_files: [], blockers: ['Original aggregate acceptance failed.'] });
    return;
  }
  const checks = [packageId === '15' ? check('node acceptance.mjs', ['acceptance.mjs']) : check('node --check source/partial.mjs', ['--check', 'source/partial.mjs'])];
  const git = (...argv) => spawnSync('git', argv, { encoding: 'utf8' }).stdout.trim();
  const passed = checks.every(item => item.passed), status = passed ? 'completed' : 'failed';
  const receipt = { schema_version: 1, package_id: packageId, attempt_id: attemptId, status,
    source: { head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), dirty: true }, changed_files: [], checks,
    fixtures: [{ id: 'independent-generated-tpm', kind: 'synthetic', location: 'acceptance.mjs' }], blockers: passed ? [] : ['Original aggregate acceptance failed.'] };
  fs.writeFileSync(step.validation, JSON.stringify(receipt));
  fs.writeFileSync(step.handoff, 'Original acceptance was executed: ' + status + '.\n');
  emit({ schema_version: 1, package_id: packageId, attempt_id: attemptId, status, summary: 'Actual original acceptance: ' + status,
    validation_file: step.validation, handoff_file: step.handoff, blockers: receipt.blockers });
});
`;

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { ...options, env: parentEnv(), encoding: 'utf8', timeout: 20000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  return result;
}

function fixture(t, name, config = {}) {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'generated TPM bundle-')));
  let initialized = false;
  // Setup can fail before a runner exists. Register that cleanup immediately;
  // the later hook owns normal cleanup after all child processes have settled.
  t.after(() => { if (!initialized) fs.rmSync(container, { recursive: true, force: true }); });
  const original = path.join(container, 'original repo'), tool = path.join(container, 'temporary skill');
  fs.mkdirSync(path.join(container, 'empty-auth-home'));
  let root = original;
  const write = (file, content) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); };
  fs.mkdirSync(root); fs.cpSync(candidate, tool, { recursive: true });
  write('unrelated.txt', 'Committed original user content.\n');
  write('source/partial.mjs', 'export const partial = "unfinished";\n');
  write('acceptance.mjs', 'import assert from "node:assert/strict";\nimport {partial} from "./source/partial.mjs";\nimport {value as first} from "./source/task-01.mjs";\nimport {value as second} from "./source/task-02.mjs";\nassert.equal(partial, "preserved first attempt");\nassert.equal(first + second, 3);\nconsole.log("Original aggregate acceptance passed");\n');
  write('fake-codex.mjs', fakeProvider); fs.chmodSync(path.join(root, 'fake-codex.mjs'), 0o755);
  write('.gitignore', 'provider-calls.jsonl\nactual-checks.jsonl\npartial-effects.jsonl\nwaiting.json\nfixture-config.json\nsentinel-called\n');
  write('fixture-config.json', JSON.stringify(config));
  command('git', ['init', '--quiet'], { cwd: root });
  command('git', ['config', 'user.name', 'Independent synthetic test'], { cwd: root });
  command('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  command('git', ['add', '.'], { cwd: root });
  command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Synthetic baseline'], { cwd: root });
  const spec = {
    title: 'Portable generated TPM acceptance', source: '# Request\nPreserve partial source and complete two small exports.\n',
    contract: '# Contract\nOnly synthetic local source edits. Preserve original aggregate acceptance; never call a live provider.\n',
    recovery: { schema_version: 1, packages: { '15': { local_repair: true, recipes: [] }, '21': { local_repair: true, recipes: [] } } },
    steps: [
      { id: '15', title: 'Ordinary package fifteen', manual: false, plan: '# Original package\nPreserve source/partial.mjs. Implement task-01 and task-02; final acceptance MUST run node acceptance.mjs. Syntax-only checkpoints never pass this final gate.\n' },
      { id: '21', title: 'Range successor', manual: false, plan: '# Successor\nRun node --check source/partial.mjs.\n' },
      { id: '45', title: 'Manual decision', manual: true, plan: '# Manual boundary\nAn operator decision is required before further work.\n' },
    ],
  };
  const specFile = path.join(container, 'spec.json'); fs.writeFileSync(specFile, JSON.stringify(spec));
  const sentinelBin = path.join(container, 'sentinel-bin'); fs.mkdirSync(sentinelBin);
  fs.writeFileSync(path.join(sentinelBin, 'codex'), '#!/bin/sh\ntouch sentinel-called\nexit 91\n', { mode: 0o755 });
  const generated = spawnSync(process.execPath, [path.join(tool, 'scripts/prepare.mjs'), '--repo', root, '--slug', slug, '--spec', specFile], {
    cwd: root, encoding: 'utf8', timeout: 20000, env: { ...parentEnv(), PATH: sentinelBin + path.delimiter + process.env.PATH },
  });
  if (generated.error) throw generated.error;
  assert.equal(generated.status, 0, generated.stdout + '\n' + generated.stderr);
  assert.equal(fs.existsSync(path.join(root, 'sentinel-called')), false);
  assert.equal(fs.existsSync(path.join(root, 'provider-calls.jsonl')), false);
  assert.equal(fs.existsSync(path.join(root, '.codex-plan-runner')), false);
  const manifest = readJson(path.join(root, bundlePath, 'runner-manifest.json'));
  assert.equal(manifest.ready, false);
  assert.deepEqual(manifest.recovery, spec.recovery);
  manifest.ready = true; write(`${bundlePath}/runner-manifest.json`, JSON.stringify(manifest));
  write('unrelated.txt', 'Existing dirty user content.\n');
  write('untracked-note.txt', 'Untracked user evidence.\n');
  const originalHead = command('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  root = path.join(container, 'relocated repo'); fs.renameSync(original, root);
  fs.rmSync(tool, { recursive: true, force: true });
  assert.equal(fs.existsSync(original), false); assert.equal(fs.existsSync(tool), false);
  // Resolve the copied runtime's complete static import graph inside the bundle;
  // a missing or absolute personal-skill import cannot hide behind this machine's
  // still-installed skill when the relocated fixture executes.
  const runtime = path.join(root, bundlePath, 'runner');
  for (const file of fs.readdirSync(runtime).filter(file => file.endsWith('.mjs'))) {
    const bytes = fs.readFileSync(path.join(runtime, file), 'utf8');
    for (const match of bytes.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const dependency = match[1];
      if (dependency.startsWith('node:')) continue;
      assert.ok(dependency.startsWith('./'), `Runtime dependency must be bundled: ${file}: ${dependency}`);
      assert.ok(fs.statSync(path.resolve(runtime, dependency)).isFile(), `Missing bundled module: ${dependency}`);
    }
    assert.equal(bytes.includes(candidate), false);
    assert.equal(bytes.includes(tool), false);
  }
  const runners = new Set(), results = [];
  const f = { root, container, manifest, originalHead, runners, results, name, generated,
    stateFile: path.join(root, '.codex-plan-runner', slug, 'state.json') };
  t.after(async () => {
    for (const running of runners) {
      if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGTERM');
      await running.done;
    }
    let evidence, evidenceFile;
    try {
      if (process.env.CODEX_TPM_TEST_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.CODEX_TPM_TEST_EVIDENCE_DIR, { recursive: true });
        const identities = ['fake-codex.mjs', 'acceptance.mjs', `${bundlePath}/runner-manifest.json`,
          ...fs.readdirSync(runtime).map(file => `${bundlePath}/runner/${file}`)]
          .map(file => ({ file, sha256: hash(fs.readFileSync(path.join(root, file))) }));
        evidence = { schema_version: 1, name, temporary_repository: root, removed_after_capture: false, identities,
          generator: { status: generated.status, stdout: generated.stdout, stderr: generated.stderr }, runs: results,
          calls: rows(f), actual_checks: rows(f, 'actual-checks.jsonl'), effects: rows(f, 'partial-effects.jsonl'), state: state(f) };
        evidenceFile = path.join(process.env.CODEX_TPM_TEST_EVIDENCE_DIR, `generated-${name}-${hash(root).slice(0, 12)}.json`);
      }
    } finally {
      let cleanupError;
      try {
        fs.rmSync(container, { recursive: true, force: true });
        assert.equal(fs.existsSync(container), false, 'Synthetic fixture cleanup must remove its container');
        if (evidence) evidence.removed_after_capture = true;
      } catch (error) {
        cleanupError = error;
        if (evidence) evidence.cleanup_error = String(error.stack || error);
      }
      if (evidence) fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
      if (cleanupError) throw cleanupError;
    }
  });
  initialized = true;
  return f;
}

function rows(f, file = 'provider-calls.jsonl') {
  const full = path.join(f.root, file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
function state(f) { return fs.existsSync(f.stateFile) ? readJson(f.stateFile) : null; }
function start(f, options = ['--step', '15'], action = 'start') {
  const child = spawn(process.execPath, [path.join(f.root, bundlePath, 'run.mjs'), action, '--codex-bin', path.join(f.root, 'fake-codex.mjs'),
    '--progress-seconds', '0', '--timeout-minutes', '0', '--retry-delay-seconds', '0.02', '--max-delay-seconds', '0.04', ...options],
  { cwd: f.container, env: {...parentEnv(), CODEX_HOME:path.join(f.container, 'empty-auth-home')}, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false, killTimer;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); }, 25000);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      const result = { action, options, status, signal, stdout, stderr, timedOut }; f.results.push(result); resolve(result);
    });
  });
  const running = { child, done }; f.runners.add(running); return running;
}
async function run(f, options, action) { const result = await start(f, options, action).done; assert.equal(result.timedOut, false, result.stdout + result.stderr); return result; }
function ok(result) { assert.equal(result.status, 0, result.stdout + '\n' + result.stderr); }
async function waitFor(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.fail('Timed out waiting for the independent fake fixture');
}
function preserved(f) {
  assert.equal(fs.readFileSync(path.join(f.root, 'unrelated.txt'), 'utf8'), 'Existing dirty user content.\n');
  assert.equal(fs.readFileSync(path.join(f.root, 'untracked-note.txt'), 'utf8'), 'Untracked user evidence.\n');
  assert.equal(command('git', ['rev-parse', 'HEAD'], { cwd: f.root }).stdout.trim(), f.originalHead);
}

test('generated relocated bundle preserves partial work, fresh roles, restart checkpoints, original acceptance and boundaries', async t => {
  const f = fixture(t, 'relocation-restart', { interruptSecond: true });
  ok(await run(f, [], 'dry-run')); ok(await run(f, [], 'status'));
  assert.equal(state(f), null); assert.equal(rows(f).length, 0);
  const running = start(f);
  const waiting = await waitFor(() => fs.existsSync(path.join(f.root, 'waiting.json')) && readJson(path.join(f.root, 'waiting.json')));
  assert.equal(waiting.taskId, '02');
  const entryBefore = state(f).steps['15'];
  assert.equal(entryBefore.recovery.subdivision.next_task, 1);
  const accepted = structuredClone(entryBefore.recovery.subdivision.tasks[0].accepted);
  assert.equal(fs.existsSync(path.join(f.root, f.manifest.steps[0].validation)), false, 'A checkpoint is not a package receipt');
  running.child.kill('SIGTERM'); assert.equal((await running.done).status, 143);
  ok(await run(f));
  const calls = rows(f), tasks = calls.filter(call => call.role === 'subtask');
  assert.deepEqual(calls.map(call => call.role), ['worker', 'worker', 'planner', 'subtask', 'subtask', 'subtask', 'finalizer']);
  assert.equal(calls[0].threadId, calls[1].threadId);
  assert.ok(calls[2].at - calls[1].at >= 70, 'Provider cooldown precedes subdivision');
  assert.equal(tasks.filter(call => call.taskId === '01').length, 1);
  assert.equal(tasks[1].threadId, tasks[2].threadId); assert.equal(tasks[2].args.includes('resume'), true);
  const fresh = [calls[2], tasks[0], tasks[1], calls.at(-1)];
  assert.equal(new Set([calls[0], ...fresh].map(call => call.threadId)).size, 5);
  for (const call of fresh) assert.equal(call.args.includes('resume'), false);
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf('--sandbox') + 1], call.role === 'planner' ? 'read-only' : 'workspace-write');
    assert.equal(call.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
    assert.equal(call.args.includes('--model'), false); assert.equal(call.args.includes('--profile'), false);
  }
  assert.deepEqual(state(f).steps['15'].recovery.subdivision.tasks[0].accepted, accepted);
  assert.equal(state(f).steps['15'].status, 'completed'); assert.equal(state(f).steps['21'], undefined);
  assert.deepEqual(rows(f, 'partial-effects.jsonl').map(row => row.effect), ['first-worker', 'second-subtask']);
  const actual = rows(f, 'actual-checks.jsonl');
  assert.equal(actual.filter(row => row.command === 'node acceptance.mjs').length, 1);
  assert.equal(actual.at(-1).role, 'finalizer'); assert.equal(actual.at(-1).status, 0);
  assert.match(actual.at(-1).stdout, /Original aggregate acceptance passed/);
  const receiptFile = path.join(f.root, f.manifest.steps[0].validation), receiptHash = hash(fs.readFileSync(receiptFile));
  assert.equal(readJson(receiptFile).attempt_id, calls.at(-1).attemptId);
  ok(await run(f)); assert.equal(rows(f).length, calls.length, 'Completed package does not repeat');
  ok(await run(f, ['--from', '15', '--to', '21'])); assert.equal(state(f).steps['21'].status, 'completed');
  assert.equal(state(f).steps['45'], undefined);
  const beforeManual = rows(f).length;
  assert.equal((await run(f, ['--from', '15', '--to', '45'])).status, 2);
  assert.equal(rows(f).length, beforeManual); assert.equal(hash(fs.readFileSync(receiptFile)), receiptHash); preserved(f);
});

test('generated bundle retains an exhausted finite rate budget across restarts', async t => {
  const f = fixture(t, 'rate-budget');
  const options = ['--step', '15', '--max-rate-retries', '1'];
  assert.equal((await run(f, options)).status, 75);
  const count = rows(f).length, before = state(f).steps['15'];
  assert.equal(before.rate_limit_count, 2); assert.ok(rows(f).every(call => call.role === 'worker'));
  assert.equal(before.recovery.phase, 'needs-attention');
  assert.match(before.recovery.budget_reason, /rate.*budget.*exhaust/i);
  assert.equal((await run(f, options)).status, 75); assert.equal(rows(f).length, count);
  assert.equal(state(f).steps['15'].rate_limit_count, before.rate_limit_count);
  assert.equal(state(f).steps['15'].recovery.phase, 'needs-attention');
  assert.match(state(f).steps['15'].recovery.budget_reason, /rate.*budget.*exhaust/i);
  assert.notEqual(state(f).steps['15'].status, 'completed'); preserved(f);
});

test('generated bundle retains exhausted fresh-session rotations without recursive subdivision', async t => {
  const f = fixture(t, 'rotation-budget', { subtaskTpm: true });
  const options = ['--step', '15', '--max-session-rotations', '1'];
  assert.equal((await run(f, options)).status, 75);
  const calls = rows(f), before = state(f).steps['15'];
  assert.equal(calls.filter(call => call.role === 'planner').length, 1);
  const tasks = calls.filter(call => call.role === 'subtask');
  assert.equal(tasks.length, 4, 'Two explicit TPM failures precede each fresh-session rotation');
  assert.equal(new Set(tasks.map(call => call.threadId)).size, 2);
  assert.deepEqual(tasks.map(call => call.args.includes('resume')), [false, true, false, true]);
  assert.equal(before.recovery.subdivision.rotation_count, 1);
  assert.equal(before.rate_limit_count, 6);
  assert.equal(before.recovery.phase, 'needs-attention'); assert.equal(before.recovery.budget_kind, 'rotation');
  assert.match(before.recovery.budget_reason, /rotation budget exhausted/i);
  assert.equal((await run(f, options)).status, 75); assert.equal(rows(f).length, calls.length);
  assert.equal(state(f).steps['15'].rate_limit_count, before.rate_limit_count);
  assert.equal(state(f).steps['15'].recovery.subdivision.rotation_count, 1);
  assert.equal(state(f).steps['15'].recovery.budget_reason, before.recovery.budget_reason);
  assert.notEqual(state(f).steps['15'].status, 'completed'); preserved(f);
});

test('generated subtask syntax checkpoints cannot pass failing original aggregate acceptance', async t => {
  const f = fixture(t, 'original-acceptance', { failFinal: true });
  assert.notEqual((await run(f)).status, 0);
  const entry = state(f).steps['15'], checks = rows(f, 'actual-checks.jsonl');
  assert.equal(entry.recovery.subdivision.next_task, 2);
  assert.ok(entry.recovery.subdivision.tasks.every(task => task.accepted));
  assert.ok(checks.filter(check => check.role === 'subtask').every(check => check.status === 0));
  assert.equal(checks.find(check => check.command === 'node acceptance.mjs').status, 1);
  assert.notEqual(entry.status, 'completed'); assert.equal(state(f).steps['21'], undefined); preserved(f);
});
