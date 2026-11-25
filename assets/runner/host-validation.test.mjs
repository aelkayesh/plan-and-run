import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { snapshotSource, captureHostValidation, verifyHostValidation } from './host-validation.mjs';

const planHash = 'a'.repeat(64);
const mutablePaths = ['docs/receipt.md'];
const fakeNpm = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const settings = JSON.parse(fs.readFileSync('fake-behavior.json', 'utf8'));
const command = process.argv.slice(2).join(' ');
fs.writeFileSync(path.join(process.env.CODEX_PLAN_DATA_DIR, command.replaceAll(' ', '-') + '.json'), JSON.stringify({
  command, arch: process.arch, executable: process.execPath, db: process.env.DATABASE_URL,
  key: process.env.OPENAI_API_KEY, password: process.env.PGPASSWORD, azure: process.env.AZURE_SPEECH_KEY,
  options: process.env.NODE_OPTIONS
}));
if (settings.mutate && command === 'test') fs.appendFileSync('source.txt', 'changed during checks\\n');
console.log('Synthetic ' + command + ' check');
process.exitCode = settings.fail === command ? 7 : 0;
`;

function fixture(t, settings = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host validation test-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake npm bin-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.writeFileSync(path.join(root, '.gitignore'), '.codex-plan-runner/\nignored-data/\n');
  fs.writeFileSync(path.join(root, 'source.txt'), 'unchanged source\n');
  fs.writeFileSync(path.join(root, 'fake-behavior.json'), JSON.stringify(settings));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'receipt.md'), 'receipt draft\n');
  fs.writeFileSync(path.join(bin, 'npm'), fakeNpm, { mode: 0o700 });
  git('init', '--quiet');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Host validation fixture');
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Synthetic baseline');
  const prior = {};
  const environment = { PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`, DATABASE_URL: 'synthetic-private-db',
    OPENAI_API_KEY: 'synthetic-private-key', PGPASSWORD: 'synthetic-private-password', AZURE_SPEECH_KEY: 'synthetic-private-speech',
    NODE_OPTIONS: '--max-old-space-size=128' };
  for (const [key, value] of Object.entries(environment)) { prior[key] = process.env[key]; process.env[key] = value; }
  const dataDirectories = [];
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const directory of [root, bin, ...dataDirectories]) fs.rmSync(directory, { recursive: true, force: true });
  });
  const capture = (override = {}) => {
    const result = captureHostValidation({ root, packageId: '01', planHash, recipeId: 'npm-checks', outputDir: '.codex-plan-runner/fixture/host-validation', mutablePaths, ...override });
    dataDirectories.push(result.evidence.isolation.data_directory);
    return result;
  };
  const verify = (file, override = {}) => verifyHostValidation({ root, packageId: '01', planHash, file, mutablePaths, ...override });
  return { root, bin, git, capture, verify };
}

test('host checks use the current Node, isolated environment, private logs and verifiable evidence', t => {
  const f = fixture(t);
  const before = snapshotSource(f.root);
  const result = f.capture();
  assert.equal(result.evidence.passed, true);
  assert.match(result.summary, /npm test: exit 0; npm run check: exit 0/);
  assert.deepEqual(f.verify(result.file), result);
  assert.deepEqual(snapshotSource(f.root), before);
  assert.equal(fs.statSync(result.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(result.file)).mode & 0o777, 0o700);
  for (const command of ['test', 'run-check']) {
    const env = JSON.parse(fs.readFileSync(path.join(result.evidence.isolation.data_directory, command + '.json'), 'utf8'));
    assert.equal(env.arch, process.arch);
    assert.equal(env.executable, process.execPath);
    for (const key of ['db', 'key', 'password', 'azure', 'options']) assert.equal(env[key], undefined);
  }
  for (const check of result.evidence.checks) {
    assert.equal(fs.statSync(path.join(f.root, check.log_file)).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(path.join(f.root, check.log_file), 'utf8'), /synthetic-private/);
  }
  assert.equal(fs.existsSync(path.join(f.root, '.codex-plan-runner/fixture/state.json')), false);
});

test('source inventory includes modified, untracked and deleted files while excluding only declared receipt paths', t => {
  const f = fixture(t);
  const original = snapshotSource(f.root, mutablePaths);
  const withReceipt = snapshotSource(f.root);
  fs.appendFileSync(path.join(f.root, 'docs/receipt.md'), 'worker result\n');
  assert.equal(snapshotSource(f.root, mutablePaths).sha256, original.sha256);
  assert.notEqual(snapshotSource(f.root).sha256, withReceipt.sha256);
  assert.deepEqual(original.excluded_paths, mutablePaths);
  fs.writeFileSync(path.join(f.root, 'new-source.txt'), 'new source');
  assert.notEqual(snapshotSource(f.root, mutablePaths).sha256, original.sha256);
  fs.unlinkSync(path.join(f.root, 'new-source.txt'));
  assert.equal(snapshotSource(f.root, mutablePaths).sha256, original.sha256);
  fs.unlinkSync(path.join(f.root, 'source.txt'));
  const deleted = snapshotSource(f.root, mutablePaths);
  assert.deepEqual(deleted.files.find(file => file.path === 'source.txt'), { path: 'source.txt', kind: 'deleted', sha256: null });
  assert.deepEqual(snapshotSource(f.root, mutablePaths), deleted);
  assert.notEqual(deleted.sha256, original.sha256);
});

for (const mutation of ['modify', 'add', 'delete']) {
  test(`verification rejects stale ${mutation} source`, t => {
    const f = fixture(t);
    const { file } = f.capture();
    if (mutation === 'modify') fs.appendFileSync(path.join(f.root, 'source.txt'), 'changed');
    if (mutation === 'add') fs.writeFileSync(path.join(f.root, 'new.txt'), 'new');
    if (mutation === 'delete') fs.unlinkSync(path.join(f.root, 'source.txt'));
    assert.throws(() => f.verify(file), /source snapshot is stale/);
  });
}

test('tracked and newly added documentation source invalidate evidence', t => {
  const f = fixture(t);
  const documentationCode = path.join(f.root, 'docs/example.ts');
  fs.writeFileSync(documentationCode, 'export const example = 1;\n');
  f.git('add', 'docs/example.ts');
  const captured = f.capture();
  fs.appendFileSync(documentationCode, 'export const changed = true;\n');
  assert.throws(() => f.verify(captured.file), /source snapshot is stale/);
  fs.writeFileSync(documentationCode, 'export const example = 1;\n');
  assert.equal(f.verify(captured.file).evidence.passed, true);
  fs.writeFileSync(path.join(f.root, 'docs/new-example.ts'), 'export const added = true;\n');
  assert.throws(() => f.verify(captured.file), /source snapshot is stale/);
});

test('historical verification still checks identity, exclusions and logs without requiring current source', t => {
  const f = fixture(t);
  const captured = f.capture();
  fs.appendFileSync(path.join(f.root, 'source.txt'), 'later package implementation\n');
  assert.throws(() => f.verify(captured.file), /source snapshot is stale/);
  assert.equal(f.verify(captured.file, { checkSource: false }).evidence.passed, true);
  assert.throws(() => f.verify(captured.file, { checkSource: false, mutablePaths: [] }), /exclusions do not match/);
  assert.throws(() => f.verify(captured.file, { checkSource: false, packageId: '02' }), /identity does not match/);
  fs.appendFileSync(path.join(f.root, captured.evidence.checks[0].log_file), 'changed');
  assert.throws(() => f.verify(captured.file, { checkSource: false }), /check log changed/);
});

test('failed checks and source changes during checks remain saved failures', t => {
  const f = fixture(t, { fail: 'test', mutate: true });
  const { file, evidence } = f.capture();
  assert.equal(evidence.passed, false);
  assert.equal(evidence.checks[0].exit_code, 7);
  assert.equal(evidence.checks[1].passed, true);
  assert.equal(evidence.source_unchanged, false);
  assert.equal(fs.existsSync(file), true);
  assert.throws(() => f.verify(file), /host checks failed or source changed/);
});

test('verification rejects wrong package, plan or repository identity', t => {
  const f = fixture(t);
  const { file, evidence } = f.capture();
  assert.throws(() => f.verify(file, { packageId: '02' }), /identity does not match/);
  assert.throws(() => f.verify(file, { planHash: 'b'.repeat(64) }), /identity does not match/);
  fs.writeFileSync(file, JSON.stringify({ ...evidence, root: f.bin }));
  assert.throws(() => f.verify(file), /identity does not match/);
});

test('verification rejects malformed receipts, commands, source inventories and missing checks', t => {
  const f = fixture(t);
  const { file, evidence } = f.capture();
  fs.writeFileSync(file, '{ invalid json');
  assert.throws(() => f.verify(file));
  const mutations = [
    value => { value.schema_version = 2; },
    value => { value.checks = []; },
    value => { value.checks[0].command = 'npm run deploy'; },
    value => { value.checks[0].argv = ['npm', 'run', 'deploy']; },
    value => { value.checks[0].exit_code = 1; },
    value => { value.source.files = []; }
  ];
  for (const mutate of mutations) {
    const value = structuredClone(evidence);
    mutate(value);
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => f.verify(file), /Invalid host validation/);
  }
});

test('verification rejects altered or missing logs', t => {
  const f = fixture(t);
  const { file, evidence } = f.capture();
  const log = path.join(f.root, evidence.checks[0].log_file);
  fs.appendFileSync(log, 'altered evidence');
  assert.throws(() => f.verify(file), /check log changed/);
  fs.unlinkSync(log);
  assert.throws(() => f.verify(file), /missing or not a regular file/);
});

test('artifact paths cannot escape private state through traversal or symlinks', t => {
  const f = fixture(t);
  assert.throws(() => captureHostValidation({ root: f.root, packageId: '01', planHash, recipeId: 'npm-checks', outputDir: '../outside' }), /inside repository/);
  fs.mkdirSync(path.join(f.root, '.codex-plan-runner'), { recursive: true });
  fs.symlinkSync(f.bin, path.join(f.root, '.codex-plan-runner/escape'));
  assert.throws(() => captureHostValidation({ root: f.root, packageId: '01', planHash, recipeId: 'npm-checks', outputDir: '.codex-plan-runner/escape/nested' }), /symlink escapes/);
  const { file, evidence } = f.capture();
  const log = path.join(f.root, evidence.checks[0].log_file);
  fs.copyFileSync(log, path.join(f.bin, 'copied.log'));
  fs.unlinkSync(log);
  fs.symlinkSync(path.join(f.bin, 'copied.log'), log);
  assert.throws(() => f.verify(file), /symlink escapes/);
});


test('capture requires the explicit fixed npm recipe for any valid package ID', t => {
  const f = fixture(t);
  for (const recipeId of [undefined, 'deploy', 'npm-checks; touch /tmp/unowned', ['npm-checks'], {id:'npm-checks'}]) {
    assert.throws(() => f.capture({recipeId}), /Unknown or unauthorized/);
  }
  assert.equal(fs.existsSync(path.join(f.root, '.codex-plan-runner')), false);
  const captured = f.capture({packageId:'99'});
  assert.equal(f.verify(captured.file, {packageId:'99'}).evidence.recipe_id, 'npm-checks');
});
