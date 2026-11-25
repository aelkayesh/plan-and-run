#!/usr/bin/env node
// A synthetic consumer demo. Only the embedded fake worker is ever invoked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = 'resume-demo';
const bundle = `docs/implementation-plans/${slug}`;
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const sha256 = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

const fakeWorker = String.raw`#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

if (process.argv.includes('login') && process.argv.includes('status')) {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => { prompt += value; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  const packageId = prompt.match(/^PACKAGE_ID: (\d{2})$/m)?.[1];
  const attemptId = prompt.match(/^ATTEMPT_ID: ([^\s]+)$/m)?.[1];
  assert.ok(attemptId, 'The real runner must supply an attempt identity');
  assert.ok(['01', '02'].includes(packageId), 'Only known synthetic tasks are supported');
  const manifest = JSON.parse(fs.readFileSync('docs/implementation-plans/resume-demo/runner-manifest.json', 'utf8'));
  const step = manifest.steps.find(item => item.id === packageId);
  const event = value => process.stdout.write(JSON.stringify(value) + '\n');
  event({ type: 'thread.started', thread_id: randomUUID() });
  fs.appendFileSync('worker-calls.jsonl', JSON.stringify({ package_id: packageId }) + '\n');
  // These deterministic changes simulate a worker; no AI implementation occurs.
  const source = packageId === '01' ? 'add.mjs' : 'double.mjs';
  fs.writeFileSync(source, packageId === '01'
    ? 'export const add = (left, right) => left + right;\n'
    : "import { add } from './add.mjs';\nexport const double = value => add(value, value);\n");
  const check = 'checks/package-' + packageId + '.mjs';
  execFileSync(process.execPath, [check], { stdio: 'pipe' });
  const git = (...argv) => execFileSync('git', argv, { encoding: 'utf8' }).trim();
  const receipt = {
    schema_version: 1, package_id: packageId, attempt_id: attemptId, status: 'completed',
    source: { head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), dirty: true },
    changed_files: [source], checks: [{ command: 'node ' + check, exit_code: 0, passed: true }],
    fixtures: [{ id: 'synthetic-resume-demo', kind: 'synthetic', location: check }], blockers: []
  };
  fs.writeFileSync(step.validation, JSON.stringify(receipt, null, 2) + '\n');
  fs.writeFileSync(step.handoff, '# Synthetic package ' + packageId + '\n\nExecuted node ' + check + '. No model calls.\n');
  fs.writeFileSync(option('--output-last-message'), JSON.stringify({
    schema_version: 1, package_id: packageId, attempt_id: attemptId, status: 'completed',
    summary: 'Synthetic implementation and real local assertions passed.',
    validation_file: step.validation, handoff_file: step.handoff, blockers: []
  }));
  event({ type: 'turn.completed' });
});
`;

function main() {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('This demo supports macOS and Linux.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Node.js 22.13 or later is required.');
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-and-run-demo-')));
  let root = path.join(container, 'original-project');
  const temporarySkill = path.join(container, 'temporary-skill');
  const authHome = path.join(container, 'empty-codex-config');
  // Keep credentials and custom auth helpers out of this fake-worker fixture.
  const env = {
    PATH: process.env.PATH,
    LANG: 'C',
    CODEX_HOME: authHome,
    CODEX_PLAN_WORKER: '0',
    CODEX_RECOVERY_SUPERVISOR: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const command = (executable, args, cwd = root) => {
    const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${path.basename(executable)} ${args[0]} failed:\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const write = (filename, content) => {
    const full = path.join(root, filename);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  console.log('Synthetic resume demo — no model calls or live authentication.');
  try {
    fs.mkdirSync(root);
    fs.mkdirSync(authHome);
    fs.mkdirSync(path.join(temporarySkill, 'scripts'), { recursive: true });
    fs.cpSync(path.join(skillRoot, 'assets'), path.join(temporarySkill, 'assets'), { recursive: true });
    fs.cpSync(path.join(skillRoot, 'references'), path.join(temporarySkill, 'references'), { recursive: true });
    fs.copyFileSync(path.join(skillRoot, 'scripts/prepare.mjs'), path.join(temporarySkill, 'scripts/prepare.mjs'));
    write('.gitignore', 'worker-calls.jsonl\n');
    write('fake-codex.mjs', fakeWorker);
    fs.chmodSync(path.join(root, 'fake-codex.mjs'), 0o755);
    write('checks/package-01.mjs', "import assert from 'node:assert/strict';\nimport { add } from '../add.mjs';\nassert.equal(add(2, 3), 5);\nassert.equal(add(-2, 2), 0);\n");
    write('checks/package-02.mjs', "import assert from 'node:assert/strict';\nimport { double } from '../double.mjs';\nassert.equal(double(4), 8);\nassert.equal(double(-3), -6);\n");
    command('git', ['init', '--quiet', '-b', 'main']);
    command('git', ['add', '.']);
    command('git', ['-c', 'user.name=Synthetic demo', '-c', 'user.email=demo@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Synthetic baseline']);
    const spec = {
      title: 'Synthetic resume demonstration',
      source: '# Request\n\nBuild two tiny arithmetic exports in a disposable repository.\n',
      contract: '# Contract\n\nSynthetic local work only. Use the supplied fake worker, preserve accepted receipts and run the package assertions. No external services or inference.\n',
      recovery: { schema_version: 1, packages: {
        '01': { local_repair: false, recipes: [] },
        '02': { local_repair: false, recipes: [] },
      } },
      steps: [
        { id: '01', title: 'Add two numbers', manual: false, plan: '# Package 01\n\nImplement add.mjs. Acceptance: node checks/package-01.mjs. Save the validation receipt and handoff.\n' },
        { id: '02', title: 'Double with the accepted addition export', manual: false, plan: '# Package 02\n\nInspect the previous receipt, preserve add.mjs and implement double.mjs. Acceptance: node checks/package-02.mjs. Save the validation receipt and handoff.\n' },
      ],
    };
    const specFile = path.join(container, 'spec.json');
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
    command(process.execPath, [path.join(temporarySkill, 'scripts/prepare.mjs'), '--repo', root, '--slug', slug, '--spec', specFile]);
    assert.equal(fs.existsSync(path.join(root, 'worker-calls.jsonl')), false);
    const manifestFile = path.join(root, bundle, 'runner-manifest.json');
    const manifest = readJson(manifestFile);
    assert.equal(manifest.ready, false);
    manifest.ready = true;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    const relocated = path.join(container, 'relocated-project');
    fs.renameSync(root, relocated);
    root = relocated;
    fs.rmSync(temporarySkill, { recursive: true });
    console.log('1. Generated a plan, relocated it before execution, and removed its temporary skill copy.');
    const runner = (action, args) => command(process.execPath, [
      path.join(root, bundle, 'run.mjs'), action, ...args,
      '--codex-bin', path.join(root, 'fake-codex.mjs'), '--progress-seconds', '0',
    ], container);
    runner('dry-run', []);
    const preflight = JSON.parse(runner('preflight', ['--from', '01', '--to', '02', '--json']));
    assert.equal(preflight.ready, true);
    assert.equal(fs.existsSync(path.join(root, 'worker-calls.jsonl')), false);
    console.log('2. Dry-run and preflight passed without starting a worker.');
    runner('start', ['--step', '01']);
    const stateFile = path.join(root, '.codex-plan-runner', slug, 'state.json');
    const firstState = readJson(stateFile);
    assert.equal(firstState.steps['01'].status, 'completed');
    assert.equal(firstState.steps['02'], undefined);
    const receiptFile = path.join(root, manifest.steps[0].validation);
    const receiptHash = sha256(receiptFile);
    const firstAttempt = firstState.steps['01'].last_attempt.attempt_id;
    assert.equal(typeof firstAttempt, 'string');
    assert.equal(firstState.steps['01'].attempts, 1);
    console.log('3. First run accepted package 01; package 02 was outside the selected range.');
    runner('resume', ['--from', '01', '--to', '02']);
    const finalState = readJson(stateFile);
    assert.equal(finalState.steps['01'].status, 'completed');
    assert.equal(finalState.steps['02'].status, 'completed');
    assert.equal(finalState.steps['01'].last_attempt.attempt_id, firstAttempt);
    assert.equal(finalState.steps['01'].attempts, 1);
    assert.equal(sha256(receiptFile), receiptHash);
    const calls = fs.readFileSync(path.join(root, 'worker-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(call => call.package_id), ['01', '02']);
    command(process.execPath, ['checks/package-01.mjs']);
    command(process.execPath, ['checks/package-02.mjs']);
    console.log('4. Resume skipped package 01 and ran package 02 only; the original receipt stayed unchanged.');
    console.log('5. Both arithmetic checks passed again against the final files.');
  } finally {
    const lock = path.join(root, '.codex-plan-runner', slug, 'runner.lock');
    if (fs.existsSync(lock)) {
      throw new Error(`Fixture retained because runner ownership is unresolved: ${container}`);
    }
    fs.rmSync(container, { recursive: true, force: true });
    assert.equal(fs.existsSync(container), false, 'Temporary fixture cleanup must succeed');
    console.log('6. Temporary repository and configuration removed.');
  }
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
