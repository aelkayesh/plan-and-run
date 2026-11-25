import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateSpec } from './prepare.mjs';

const script = fileURLToPath(new URL('./prepare.mjs', import.meta.url));
const runtimeNames = ['runner.mjs', 'protocol.mjs', 'provider-outcome.mjs', 'worker-progress.mjs', 'failure-report.mjs', 'run.mjs', 'recovery.mjs', 'host-validation.mjs', 'automatic-host-validation.mjs', 'host-validation-helper.mjs', 'runtime-reconciliation.mjs', 'runtime-artifacts.mjs', 'subdivision.mjs', 'subdivision-state.mjs', 'acceptance-policy.mjs', 'acceptance-lifecycle.mjs', 'acceptance-adapters.mjs', 'python-dependencies.mjs', 'acceptance-postgres.mjs', 'acceptance-helper.mjs', 'acceptance-fixtures.md', 'background-control.mjs', 'background-ownership.mjs', 'background-child.mjs', 'background-runner.mjs', 'owned-wake.mjs', 'range-preflight.mjs', 'auth-readiness.mjs', 'unattended.mjs', 'unattended-cleanup.mjs', 'LICENSE'];
const spec = {
  title: 'Restore bounded request processing',
  source: '# Request\n\nReject oversized requests before they enter processing, and explain the supported input limit.\n',
  contract: '# Shared contract\n\nUse the existing request limit. Preserve accepted request behavior and avoid network calls in validation.\n',
  steps: [
    { id: '01', title: 'Enforce request admission', plan: '# Enforce request admission\n\nApply the existing limit at admission. Validate the boundary with a local request fixture and preserve unrelated errors.\n', manual: false },
    { id: '02', title: 'Review user guidance', plan: '# Review user guidance\n\nInspect the visible input-limit explanation and record a manual accessibility check. Do not publish changes.\n', manual: true },
  ],
};

function run(command, args, options = {}) {
  // These children model the parent operator only inside disposable fixtures.
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', env: {
    ...process.env, CODEX_PLAN_WORKER: '0', CODEX_RECOVERY_SUPERVISOR: '0',
    GIT_OPTIONAL_LOCKS: '0', ...options.env,
  } });
  if (result.error) throw result.error;
  return result;
}


// Keep generator unit calls out of this marked test process. The child exercises
// the real API against a registered disposable fixture, including rollback faults.
const fixtureRoots = new Set();
const prepareFixtureSource = String.raw`
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { script, options, failure } = JSON.parse(readFileSync(0, 'utf8'));
const { prepareBundle } = await import(pathToFileURL(script));
const originalRename = fs.rename, originalOpen = fs.open;
const injectedError = () => Object.assign(new Error('Injected ' + failure + ' failure'), { code: 'EIO' });
if (failure === 'publish') {
  fs.rename = async (source, destination) => {
    if (path.basename(source).startsWith('.prepare-' + options.slug + '-')) throw injectedError();
    return originalRename(source, destination);
  };
} else if (failure === 'ignore-write') {
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] !== path.join(options.repo, '.gitignore')) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'writeFile') return async bytes => { await target.writeFile(bytes.subarray(0, 4)); throw injectedError(); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
} else if (failure !== null) throw new Error('Unknown synthetic failure');
try {
  const result = await prepareBundle(options);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error.message, code: error.code }));
} finally {
  fs.rename = originalRename;
  fs.open = originalOpen;
}
`;

async function prepareBundle(options, failure = null) {
  assert.ok(fixtureRoots.has(options.root), 'Generator subprocess requires a registered disposable fixture');
  const result = run(process.execPath, ['--input-type=module', '-e', prepareFixtureSource], {
    cwd: options.root, timeout: 20000, input: JSON.stringify({ script, options, failure }),
  });
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  if (!outcome.ok) throw Object.assign(new Error(outcome.message), { code: outcome.code });
  return outcome.result;
}

function git(repo, ...args) {
  const result = run('git', ['-C', repo, ...args]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t, { ignore = '*.log\n', commit = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plan-prepare-test-')));
  fixtureRoots.add(root);
  t.after(async () => { fixtureRoots.delete(root); await fs.rm(root, { recursive: true, force: true }); });
  const repo = path.join(root, 'repository');
  const codexHome = path.join(root, 'empty-auth-home'); await fs.mkdir(codexHome);
  const skillRoot = path.join(root, 'skill');
  await fs.mkdir(repo);
  await fs.mkdir(path.join(skillRoot, 'assets', 'runner'), { recursive: true });
  await fs.mkdir(path.join(skillRoot, 'references'));
  await fs.mkdir(path.join(skillRoot, 'scripts'));
  await fs.copyFile(script, path.join(skillRoot, 'scripts', 'prepare.mjs'));
  await fs.writeFile(path.join(skillRoot, 'references', 'runner-contract.md'), '# Worker contract\n\nUse one step at a time and leave receipts.\n');
  // Exercise the real transitive generator imports. Only the routing adapter
  // below is stubbed, so CLI-only fixtures cannot launch a worker.
  for (const name of runtimeNames) {
    await fs.copyFile(fileURLToPath(new URL('../assets/runner/' + name, import.meta.url)), path.join(skillRoot, 'assets/runner', name));
  }
  // A minimal adapter makes wrapper routing observable without any worker process.
  await fs.writeFile(path.join(skillRoot, 'assets', 'runner', 'runner.mjs'), `import fs from 'node:fs/promises';
import path from 'node:path';
export async function main(args) {
  const repo = args[args.indexOf('--repo') + 1];
  const manifestPath = args[args.indexOf('--manifest') + 1];
  const manifest = JSON.parse(await fs.readFile(path.resolve(repo, manifestPath), 'utf8'));
  if (['start', 'resume'].includes(args[0]) && !manifest.ready) throw new Error('Manifest is a draft; ready must be true.');
  console.log(JSON.stringify({ args, repo, manifestPath, plan_id: manifest.plan_id }));
  return 0;
}
`);
  await fs.writeFile(path.join(skillRoot, 'assets', 'runner', 'runner.test.mjs'), 'throw new Error("Do not copy tests");\n');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'committed source\n');
  if (ignore !== null) await fs.writeFile(path.join(repo, '.gitignore'), ignore);
  git(repo, 'init', '-q');
  if (commit) {
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=Plan Generator Test', '-c', 'user.email=plan-generator@example.invalid', 'commit', '-qm', 'Initial fixture');
  }
  const specPath = path.join(root, 'spec.json');
  await fs.writeFile(specPath, JSON.stringify(spec));
  return { root, repo, skillRoot, specPath, codexHome, slug: 'bounded-requests' };
}

async function exists(filename) {
  try { await fs.lstat(filename); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function tree(root) {
  const result = {};
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (prefix === '' && entry.name === '.git') continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { result[name] = 'directory'; await visit(filename, name); }
      else if (entry.isSymbolicLink()) result[name] = { symlink: await fs.readlink(filename) };
      else result[name] = (await fs.readFile(filename)).toString('base64');
    }
  }
  await visit(root);
  return result;
}

test('an implementation worker cannot prepare a nested plan or change the repository', async t => {
  const f = await fixture(t);
  const before = await tree(f.repo);
  const result = run(process.execPath, [script, '--repo', f.repo, '--slug', f.slug, '--spec', f.specPath], {
    env: { CODEX_PLAN_WORKER: '1' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Worker recursion denied/);
  assert.deepEqual(await tree(f.repo), before);
});

test('creates a complete draft bundle, preserves source edits, and copies only runtime files', async t => {
  const f = await fixture(t, { ignore: '# Existing rules\r\n*.log' });
  await fs.writeFile(path.join(f.repo, 'tracked.txt'), 'user in-progress source edit\n');
  await fs.writeFile(path.join(f.repo, 'untracked.txt'), 'private untracked source\n');
  const beforeHead = git(f.repo, 'rev-parse', 'HEAD');
  const result = await prepareBundle(f);
  assert.equal(result.repo, await fs.realpath(f.repo));
  assert.equal(result.bundle, path.join(f.repo, 'docs', 'implementation-plans', f.slug));
  assert.equal(await fs.readFile(path.join(f.repo, 'tracked.txt'), 'utf8'), 'user in-progress source edit\n');
  assert.equal(await fs.readFile(path.join(f.repo, 'untracked.txt'), 'utf8'), 'private untracked source\n');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(await fs.readFile(path.join(f.repo, '.gitignore'), 'utf8'), '# Existing rules\r\n*.log\r\n/.codex-plan-runner/\r\n');
  assert.equal(await exists(path.join(f.repo, '.codex-plan-runner')), false);
  assert.equal(await fs.readFile(path.join(result.bundle, 'request.md'), 'utf8'), spec.source);
  assert.equal(await fs.readFile(path.join(result.bundle, 'shared-contract.md'), 'utf8'), spec.contract);
  assert.equal(await fs.readFile(path.join(result.bundle, 'worker-contract.md'), 'utf8'), await fs.readFile(path.join(f.skillRoot, 'references', 'runner-contract.md'), 'utf8'));
  assert.deepEqual((await fs.readdir(path.join(result.bundle, 'runner'))).sort(), [...runtimeNames].sort());
  for (const name of runtimeNames) assert.deepEqual(await fs.readFile(path.join(result.bundle, 'runner', name)), await fs.readFile(path.join(f.skillRoot, 'assets', 'runner', name)));
  assert.equal(await fs.readFile(path.join(result.bundle, 'runner', 'LICENSE'), 'utf8'), await fs.readFile(fileURLToPath(new URL('../LICENSE', import.meta.url)), 'utf8'), 'Generated runtime must retain the distribution license notice');
  const manifest = JSON.parse(await fs.readFile(path.join(result.bundle, 'runner-manifest.json'), 'utf8'));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.plan_id, f.slug);
  assert.equal(manifest.ready, false);
  assert.deepEqual(manifest.acceptance, { schema_version: 1, mode: 'legacy', packages: {} });
  assert.equal(manifest.source, `${result.relativeBundle}/request.md`);
  assert.equal(manifest.contract, `${result.relativeBundle}/shared-contract.md`);
  assert.equal(manifest.worker_contract, `${result.relativeBundle}/worker-contract.md`);
  for (const [index, step] of manifest.steps.entries()) {
    assert.deepEqual(step, {
      id: spec.steps[index].id,
      title: spec.steps[index].title,
      plan: `${result.relativeBundle}/${step.id}-plan.md`,
      validation: `${result.relativeBundle}/${step.id}-validation.json`,
      handoff: `${result.relativeBundle}/${step.id}-handoff.md`,
      dependencies: index ? [manifest.steps[index - 1].id] : [],
      manual: spec.steps[index].manual,
    });
    assert.equal(await fs.readFile(path.join(f.repo, step.plan), 'utf8'), spec.steps[index].plan);
    assert.equal(await exists(path.join(f.repo, step.validation)), false);
    assert.equal(await exists(path.join(f.repo, step.handoff)), false);
  }
  const readme = await fs.readFile(path.join(result.bundle, 'README.md'), 'utf8');
  assert.match(readme, /\[Enforce request admission\]\(01-plan\.md\) \| Pending/);
  assert.match(readme, /\[Review user guidance\]\(02-plan\.md\) \| Pending \| Manual/);
  for (const command of ['preflight --json', 'launch --json', 'status --json', 'logs', 'stop --session SESSION_UUID --json']) assert.ok(readme.includes(command), command);
  assert.match(readme, /Foreground `start` remains the default when the subcommand is omitted/);
  assert.match(readme, /acknowledges only its durable owned session, not acceptance/);
  assert.match(readme, /No service or reboot restart/);
  assert.deepEqual(await fs.readdir(path.dirname(result.bundle)), [f.slug]);
});

test('wrapper remains portable after moving the repo and removing the skill; read-only commands create no state', async t => {
  const f = await fixture(t);
  await prepareBundle(f);
  const movedRepo = path.join(f.root, 'moved repository');
  await fs.rename(f.repo, movedRepo);
  await fs.rm(f.skillRoot, { recursive: true });
  const wrapper = path.join(movedRepo, 'docs', 'implementation-plans', f.slug, 'run.mjs');
  const before = await tree(movedRepo);
  for (const args of [['dry-run'], ['status']]) {
    const result = run(process.execPath, [wrapper, ...args], { cwd: f.root });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.repo, movedRepo);
    assert.equal(report.manifestPath, path.relative(movedRepo, path.join(path.dirname(wrapper), 'runner-manifest.json')));
    assert.deepEqual(report.args.slice(0, args.length), args);
    assert.equal(report.plan_id, f.slug);
  }
  for (const command of ['start', 'resume']) {
    const result = run(process.execPath, [wrapper, command], { cwd: f.root });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /draft/);
  }
  for (const args of [['status', '--repo', f.root], ['status', `--repo=${f.root}`], ['status', '--manifest', 'other.json'], ['status', '--manifest=other.json']]) {
    const result = run(process.execPath, [wrapper, ...args], { cwd: f.root });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /overrides are not allowed/);
  }
  assert.deepEqual(await tree(movedRepo), before);
  for (const filename of [wrapper, ...runtimeNames.map(name => path.join(path.dirname(wrapper), 'runner', name))]) {
    const content = await fs.readFile(filename, 'utf8');
    assert.equal(content.includes(f.skillRoot), false);
    assert.equal(content.includes('/.codex/skills/'), false);
  }
});

test('duplicate preparation refuses to overwrite any bundle content', async t => {
  const f = await fixture(t);
  const result = await prepareBundle(f);
  await fs.writeFile(path.join(result.bundle, '01-plan.md'), '# User revised the plan\n');
  const before = await tree(f.repo);
  await assert.rejects(prepareBundle(f), /overwrite existing plan bundle/);
  assert.deepEqual(await tree(f.repo), before);
});

test('existing runner state blocks setup before creating any files', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.repo, '.codex-plan-runner', f.slug), { recursive: true });
  await fs.writeFile(path.join(f.repo, '.codex-plan-runner', f.slug, 'sentinel.json'), '{"keep":true}\n');
  const before = await tree(f.repo);
  await assert.rejects(prepareBundle(f), /existing runner state/);
  assert.deepEqual(await tree(f.repo), before);
});

test('invalid specs and slugs fail without changing repository files', async t => {
  const f = await fixture(t);
  const before = await tree(f.repo);
  const invalidSpecs = [
    null,
    { ...spec, title: '  ' },
    { ...spec, source: '' },
    { ...spec, contract: null },
    { ...spec, steps: [] },
    { ...spec, steps: [{ ...spec.steps[0], id: '../' }] },
    { ...spec, steps: [{ ...spec.steps[0], id: '00' }] },
    { ...spec, steps: [{ ...spec.steps[0], id: '1' }] },
    { ...spec, steps: [spec.steps[0], { ...spec.steps[1], id: '01' }] },
    { ...spec, steps: [...spec.steps].reverse() },
    { ...spec, steps: [{ ...spec.steps[0], manual: undefined }] },
    { ...spec, steps: [{ ...spec.steps[0], manual: 'false' }] },
    { ...spec, steps: [{ ...spec.steps[0], title: '' }] },
    { ...spec, steps: [{ ...spec.steps[0], plan: '\n ' }] },
  ];
  for (const invalid of invalidSpecs) {
    await fs.writeFile(f.specPath, JSON.stringify(invalid));
    await assert.rejects(prepareBundle(f));
    assert.deepEqual(await tree(f.repo), before);
  }
  await fs.writeFile(f.specPath, '{invalid-json');
  await assert.rejects(prepareBundle(f), /Cannot read JSON spec/);
  await fs.writeFile(f.specPath, JSON.stringify(spec));
  for (const slug of ['../escape', 'Uppercase', '-prefix', 'suffix-', 'two--hyphens', 'under_score', 'a'.repeat(64)]) {
    await assert.rejects(prepareBundle({ ...f, slug }), /--slug/);
    assert.deepEqual(await tree(f.repo), before);
  }
});

test('one scoped step is accepted and ordered nonconsecutive ids remain explicit', async t => {
  const f = await fixture(t);
  const small = { ...spec, steps: [spec.steps[0]] };
  await fs.writeFile(f.specPath, JSON.stringify(small));
  const result = await prepareBundle(f);
  assert.deepEqual(result.manifest.steps[0].dependencies, []);
  assert.equal(result.manifest.steps.length, 1);
  assert.equal(validateSpec({ ...spec, steps: [spec.steps[0], { ...spec.steps[1], id: '04' }] }).steps[1].id, '04');
});

test('ignore rule is appended once across different plans and existing bytes are preserved', async t => {
  const f = await fixture(t, { ignore: '# keep this comment\n/.codex-plan-runner/\n*.cache' });
  const before = await fs.readFile(path.join(f.repo, '.gitignore'));
  await prepareBundle(f);
  await prepareBundle({ ...f, slug: 'second-scope' });
  assert.deepEqual(await fs.readFile(path.join(f.repo, '.gitignore')), before);
  const missing = await fixture(t, { ignore: null });
  await prepareBundle(missing);
  await prepareBundle({ ...missing, slug: 'second-scope' });
  assert.equal(await fs.readFile(path.join(missing.repo, '.gitignore'), 'utf8'), '/.codex-plan-runner/\n');
});

test('rejects symlinked output, state, ignore and copied sources without changing either target', async t => {
  for (const kind of ['docs', 'implementation-plans', 'bundle', 'state', 'gitignore', 'runtime-directory', 'runtime-file', 'worker-contract']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      const outside = path.join(f.root, 'outside');
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, 'keep.txt'), 'outside content\n');
      let link;
      let target = outside;
      if (kind === 'docs') link = path.join(f.repo, 'docs');
      if (kind === 'implementation-plans') { await fs.mkdir(path.join(f.repo, 'docs')); link = path.join(f.repo, 'docs', 'implementation-plans'); }
      if (kind === 'bundle') { await fs.mkdir(path.join(f.repo, 'docs', 'implementation-plans'), { recursive: true }); link = path.join(f.repo, 'docs', 'implementation-plans', f.slug); }
      if (kind === 'state') link = path.join(f.repo, '.codex-plan-runner');
      if (kind === 'gitignore') { link = path.join(f.repo, '.gitignore'); target = path.join(outside, 'keep.txt'); await fs.unlink(link); }
      if (kind === 'runtime-directory') { link = path.join(f.skillRoot, 'assets', 'runner'); await fs.rm(link, { recursive: true }); }
      if (kind === 'runtime-file') { link = path.join(f.skillRoot, 'assets', 'runner', 'protocol.mjs'); target = path.join(outside, 'keep.txt'); await fs.unlink(link); }
      if (kind === 'worker-contract') { link = path.join(f.skillRoot, 'references', 'runner-contract.md'); target = path.join(outside, 'keep.txt'); await fs.unlink(link); }
      await fs.symlink(target, link);
      const before = await tree(f.repo);
      const outsideBefore = await tree(outside);
      await assert.rejects(prepareBundle(f), /Symlink paths are not allowed/);
      assert.deepEqual(await tree(f.repo), before);
      assert.deepEqual(await tree(outside), outsideBefore);
    });
  }
});

test('missing assets, invalid repository roots and absent HEAD fail before writes', async t => {
  const f = await fixture(t);
  const before = await tree(f.repo);
  await fs.unlink(path.join(f.skillRoot, 'assets', 'runner', 'protocol.mjs'));
  await assert.rejects(prepareBundle(f), /Missing runner asset/);
  assert.deepEqual(await tree(f.repo), before);
  const empty = await fixture(t, { commit: false });
  const emptyBefore = await tree(empty.repo);
  await assert.rejects(prepareBundle(empty), /existing HEAD/);
  assert.deepEqual(await tree(empty.repo), emptyBefore);
  const nested = path.join(empty.repo, 'subdirectory');
  await fs.mkdir(nested);
  await assert.rejects(prepareBundle({ ...empty, repo: nested }), /Git root, not a subdirectory/);
  const notGit = path.join(f.root, 'not-git');
  await fs.mkdir(notGit);
  await assert.rejects(prepareBundle({ ...f, repo: notGit }), /Git working-tree root/);
  assert.deepEqual(await fs.readdir(notGit), []);
});

test('CLI resolves repository aliases, prints next commands and never runs a worker', async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'repo-alias');
  await fs.symlink(f.repo, alias);
  const result = run(process.execPath, [path.join(f.skillRoot, 'scripts', 'prepare.mjs'), '--repo', alias, '--slug', f.slug, '--spec', f.specPath], { cwd: f.root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prepared draft plan:/);
  assert.match(result.stdout, /dry-run/);
  assert.match(result.stdout, /resume/);
  assert.equal(await exists(path.join(f.repo, '.codex-plan-runner')), false);
  const before = await tree(f.repo);
  for (const args of [[], ['--repo', f.repo], ['--unknown', 'value'], ['--repo', f.repo, '--repo', f.repo, '--slug', 'x', '--spec', f.specPath]]) {
    const invalid = run(process.execPath, [path.join(f.skillRoot, 'scripts', 'prepare.mjs'), ...args]);
    assert.notEqual(invalid.status, 0);
    assert.deepEqual(await tree(f.repo), before);
  }
});

test('CLI launched through a skill directory alias actually prepares the plan', async t => {
  for (const nodeFlags of [[], ['--preserve-symlinks-main']]) {
    const f = await fixture(t);
    const alias = path.join(f.root, 'skill-alias');
    await fs.symlink(f.skillRoot, alias);
    const result = run(process.execPath, [...nodeFlags, path.join(alias, 'scripts', 'prepare.mjs'), '--repo', f.repo, '--slug', f.slug, '--spec', f.specPath], { cwd: f.root });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Prepared draft plan:/);
    const manifest = JSON.parse(await fs.readFile(path.join(f.repo, 'docs', 'implementation-plans', f.slug, 'runner-manifest.json'), 'utf8'));
    assert.equal(manifest.ready, false);
    assert.equal(manifest.steps.length, 2);
    assert.equal(await exists(path.join(f.repo, '.codex-plan-runner')), false);
  }
});

test('actual copied runtime previews and reports draft plans after relocation without starting workers', async t => {
  const f = await fixture(t);
  const actualSkillRoot = path.resolve(path.dirname(script), '..');
  await prepareBundle({ ...f, skillRoot: actualSkillRoot });
  const movedRepo = path.join(f.root, 'portable actual repository');
  await fs.rename(f.repo, movedRepo);
  const wrapper = path.join(movedRepo, 'docs', 'implementation-plans', f.slug, 'run.mjs');
  const before = await tree(movedRepo);
  // A nonexistent executable makes any unintended worker launch fail visibly.
  const noWorker = path.join(f.root, 'never-invoke-codex');
  for (const command of ['dry-run', 'status']) {
    const result = run(process.execPath, [wrapper, command, '--codex-bin', noWorker], { cwd: f.root });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Ready: false/);
    assert.match(result.stdout, /01\s+pending/);
    assert.match(result.stdout, /02\s+manual approval boundary/);
  }
  for (const command of ['start', 'resume']) {
    const result = run(process.execPath, [wrapper, command, '--codex-bin', noWorker], { cwd: f.root });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Plan is not ready/);
  }
  const outsideReports = values => Object.fromEntries(Object.entries(values).filter(([name]) => name !== '.codex-plan-runner' && !name.startsWith('.codex-plan-runner/')));
  assert.deepEqual(outsideReports(await tree(movedRepo)), outsideReports(before));
  assert.equal(await exists(path.join(movedRepo, '.codex-plan-runner', f.slug, 'state.json')), false, 'Draft failure reports must not create scheduling progress');
  const manifestPath = path.join(path.dirname(wrapper), 'runner-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.ready = true;
  manifest.steps[0].manual = true;
  delete manifest.recovery.packages[manifest.steps[0].id];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const manualBefore = await tree(movedRepo);
  for (const command of ['start', 'resume']) {
    const result = run(process.execPath, [wrapper, command, '--codex-bin', noWorker], { cwd: f.root });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout + result.stderr, /manual (?:approval )?boundary/);
  }
  assert.deepEqual(outsideReports(await tree(movedRepo)), outsideReports(manualBefore));
  assert.equal(await exists(path.join(movedRepo, '.codex-plan-runner', f.slug, 'state.json')), false, 'Manual preflight may save reports but must not create progress or a worker');
});

test('publication and ignore-write failures restore the original tree and remove staging directories', async t => {
  for (const ignore of [null, '# keep existing bytes\n*.log']) {
    for (const failure of ['publish', 'ignore-write']) {
      await t.test(`${failure}, ignore ${ignore === null ? 'absent' : 'present'}`, async t => {
        const f = await fixture(t, { ignore });
        const before = await tree(f.repo);
        await assert.rejects(prepareBundle(f, failure), new RegExp(`Injected ${failure} failure`));
        assert.deepEqual(await tree(f.repo), before);
      });
    }
  }
});

test('explicit recovery recipe selection is validated before writes and frozen in the manifest', async t => {
  const f = await fixture(t);
  const recovery = { schema_version: 1, packages: { '01': { local_repair: true, recipes: ['npm-checks'] } } };
  await fs.writeFile(f.specPath, JSON.stringify({ ...spec, recovery }));
  const generated = await prepareBundle(f);
  const manifest = JSON.parse(await fs.readFile(path.join(generated.bundle, 'runner-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.recovery, recovery);
  for (const invalid of [
    { ...recovery, command: 'touch arbitrary' },
    { schema_version: 1, packages: { '01': { local_repair: true, recipes: ['unknown'] } } },
    { schema_version: 1, packages: { '01': { local_repair: true, recipes: ['npm-checks'], argv: ['npm', 'install'] } } },
    { schema_version: 1, packages: { '02': { local_repair: true, recipes: [] } } },
    { schema_version: 1, packages: { '99': { local_repair: true, recipes: [] } } }
  ]) {
    const other = await fixture(t), before = await tree(other.repo);
    await fs.writeFile(other.specPath, JSON.stringify({ ...spec, recovery: invalid }));
    await assert.rejects(prepareBundle(other), /Invalid recovery/);
    assert.deepEqual(await tree(other.repo), before);
  }
});

test('strict acceptance authoring freezes capability and semantic criteria while leaving mappings as deliverables', async t => {
  const f = await fixture(t);
  const acceptance = { schema_version: 1, mode: 'strict', packages: { '01': {
    required_gates: [{ id: 'npm', capability: 'npm-checks' }],
    criteria: [{ id: 'request-boundary', type: 'behavior', purpose: 'Reject oversized requests while accepting the exact existing limit.', gate_ids: ['npm'] }],
  } } };
  await fs.writeFile(f.specPath, JSON.stringify({ ...spec, acceptance }));
  const result = await prepareBundle(f);
  assert.deepEqual(result.manifest.acceptance, acceptance);
  assert.equal(result.manifest.steps[0].acceptance_mapping, `${result.relativeBundle}/01-acceptance-mapping.json`);
  assert.equal(result.manifest.steps[1].acceptance_mapping, undefined);
  assert.equal(await exists(path.join(result.bundle, '01-acceptance-mapping.json')), false);
  assert.match(await fs.readFile(path.join(result.bundle, 'README.md'), 'utf8'), /strict parent-owned acceptance/);
  assert.deepEqual((await fs.readdir(path.join(result.bundle, 'runner'))).sort(), [...runtimeNames].sort());
});

test('invalid strict acceptance is rejected before any preparation writes', async t => {
  for (const acceptance of [
    { schema_version: 1, mode: 'strict', packages: {} },
    { schema_version: 1, mode: 'strict', packages: { '02': { required_gates: [{ id: 'npm', capability: 'npm-checks' }], criteria: [{ id: 'case', type: 'suite', purpose: 'Tests', gate_ids: ['npm'] }] } } },
    { schema_version: 1, mode: 'strict', packages: { '01': { required_gates: [{ id: 'shell', capability: 'shell' }], criteria: [{ id: 'case', type: 'suite', purpose: 'Tests', gate_ids: ['shell'] }] } } },
  ]) {
    const f = await fixture(t); const before = await tree(f.repo);
    await fs.writeFile(f.specPath, JSON.stringify({ ...spec, acceptance }));
    await assert.rejects(prepareBundle(f), /Invalid acceptance/);
    assert.deepEqual(await tree(f.repo), before);
  }
});

const portableRecoveryWorker = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
if(process.argv.includes('login')&&process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{
 const args=process.argv.slice(2),get=key=>args[args.indexOf(key)+1];
 const schema=JSON.parse(fs.readFileSync(get('--output-schema'),'utf8'));
 const supervisor=Boolean(schema.properties.classification),config=JSON.parse(fs.readFileSync('fake-config.json','utf8'));
 const manifest=JSON.parse(fs.readFileSync(config.manifest,'utf8')),id=prompt.match(/^PACKAGE_ID: (\d{2})$/m)[1],attempt=prompt.match(/^ATTEMPT_ID: (\S+)$/m)[1];
 const step=manifest.steps.find(s=>s.id===id),thread=args.includes('resume')?args.at(-2):supervisor?'00000000-0000-4000-8000-000000000002':'00000000-0000-4000-8000-000000000001';
 fs.appendFileSync('fake-calls.jsonl',JSON.stringify({supervisor,thread,prompt})+'\n');
 const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');emit({type:'thread.started',thread_id:thread});
 const finish=value=>{fs.writeFileSync(get('--output-last-message'),JSON.stringify(value));emit({type:'turn.completed'});};
 if(supervisor){if(config.mode==='repair')fs.writeFileSync('source.mjs','export const repaired=true;\n');finish({schema_version:1,package_id:id,attempt_id:attempt,classification:config.mode==='host'?'environment':'implementation',action:config.mode==='host'?'host-check':'resume',recipe_id:config.mode==='host'?'npm-checks':null,summary:'Inspected and recovered bounded synthetic work.',changed_files:config.mode==='repair'?['source.mjs']:[],blockers:[]});return;}
 const host=prompt.match(/^HOST_VALIDATION_FILE: (.+)$/m)?.[1],sha=prompt.match(/^HOST_VALIDATION_SHA256: (.+)$/m)?.[1];
 const result={schema_version:1,package_id:id,attempt_id:attempt,status:'completed',summary:'Real syntax check passed.',validation_file:step.validation,handoff_file:step.handoff,blockers:[]};
 if(config.mode==='repair'&&fs.readFileSync('source.mjs','utf8').includes('BROKEN')||config.mode==='host'&&!host){finish({...result,status:'blocked',summary:'Bounded recovery required.',blockers:['Inspect source or the declared local check restriction.']});return;}
 execFileSync(process.execPath,['--check','source.mjs']);
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim(),receipt={schema_version:1,package_id:id,attempt_id:attempt,status:'completed',source:{head:git('rev-parse','HEAD'),branch:git('branch','--show-current'),dirty:true},changed_files:[],checks:[{command:'node --check source.mjs',exit_code:0,passed:true}],fixtures:[],blockers:[]};
 if(host){const evidence=JSON.parse(fs.readFileSync(host,'utf8'));receipt.host_validation={file:host,sha256:sha};receipt.checks=evidence.checks.map(c=>({command:c.command,exit_code:c.exit_code,passed:c.passed,origin:'host-validation'}));}
 fs.writeFileSync(step.validation,JSON.stringify(receipt));fs.writeFileSync(step.handoff,'Verified bounded local synthetic package.\n');finish(result);
});
`;

for (const mode of ['repair', 'host']) test(`generated relocated ready bundle performs automatic ${mode} recovery after its skill copy is removed`, async t => {
  const f = await fixture(t);
  const actualSkillRoot = path.resolve(path.dirname(script), '..');
  await fs.rm(f.skillRoot, { recursive: true });
  await fs.cp(actualSkillRoot, f.skillRoot, { recursive: true });
  const authored = { ...spec, steps: [{ ...spec.steps[0], id: '15', manual: false }],
    recovery: { schema_version: 1, packages: { '15': { local_repair: true, recipes: mode === 'host' ? ['npm-checks'] : [] } } } };
  await fs.writeFile(f.specPath, JSON.stringify(authored));
  const prepared = await prepareBundle(f);
  const manifestFile = path.join(prepared.bundle, 'runner-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); manifest.ready = true;
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  await fs.appendFile(path.join(f.repo, '.gitignore'), '\nfake-calls.jsonl\nfake-host-calls.jsonl\n');
  await fs.writeFile(path.join(f.repo, 'source.mjs'), 'export const state="BROKEN";\n');
  await fs.writeFile(path.join(f.repo, 'package.json'), JSON.stringify({ private:true, scripts:{test:'node --check source.mjs',check:'node --check source.mjs'} }));
  await fs.writeFile(path.join(f.repo, 'fake-config.json'), JSON.stringify({ mode, manifest:path.relative(f.repo, manifestFile) }));
  await fs.writeFile(path.join(f.repo, 'fake-codex.mjs'), portableRecoveryWorker, { mode:0o755 });
  await fs.mkdir(path.join(f.repo,'bin'));
  await fs.writeFile(path.join(f.repo,'bin/npm'), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync('fake-host-calls.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');if(!process.env.CODEX_PLAN_DATA_DIR||process.env.OPENAI_API_KEY)process.exit(1);console.log('Synthetic fixed argv accepted');\n`, {mode:0o755});
  const relocated = path.join(f.root, 'relocated ready repository');
  await fs.rename(f.repo, relocated); await fs.rm(f.skillRoot, {recursive:true});
  const wrapper = path.join(relocated, prepared.relativeBundle, 'run.mjs');
  const result = run(process.execPath, [wrapper,'start','--step','15','--codex-bin',path.join(relocated,'fake-codex.mjs'),'--progress-seconds','0'], {
    cwd:f.root, timeout:20000, env:{PATH:path.join(relocated,'bin')+path.delimiter+process.env.PATH,OPENAI_API_KEY:'synthetic-scrub-me',CODEX_HOME:f.codexHome}
  });
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  const calls=(await fs.readFile(path.join(relocated,'fake-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(c=>c.supervisor),[false,true,false]);assert.equal(calls[0].thread,calls[2].thread);
  const state=JSON.parse(await fs.readFile(path.join(relocated,'.codex-plan-runner',f.slug,'state.json'),'utf8'));
  assert.equal(state.steps['15'].status,'completed');assert.equal(await exists(f.skillRoot),false);
  if(mode==='host')assert.deepEqual((await fs.readFile(path.join(relocated,'fake-host-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),[['test'],['run','check']]);
});

test('relocated strict bundle loads its real acceptance runtime after the source skill is removed', async t => {
  const f = await fixture(t);
  const actualSkillRoot = path.resolve(path.dirname(script), '..');
  await fs.rm(f.skillRoot, { recursive: true });
  await fs.cp(actualSkillRoot, f.skillRoot, { recursive: true });
  const acceptance = { schema_version: 1, mode: 'strict', packages: { '01': {
    required_gates: [{ id: 'npm', capability: 'npm-checks' }],
    criteria: [{ id: 'request-boundary', type: 'behavior', purpose: 'Reject oversized requests at the configured boundary.', gate_ids: ['npm'] }],
  } } };
  await fs.writeFile(f.specPath, JSON.stringify({ ...spec, acceptance }));
  const prepared = await prepareBundle(f);
  const expectedModules = new Map();
  for (const name of runtimeNames) expectedModules.set(name, await fs.readFile(path.join(f.skillRoot, 'assets/runner', name)));
  const relocated = path.join(f.root, 'relocated strict repository');
  await fs.rename(f.repo, relocated);
  await fs.rm(f.skillRoot, { recursive: true });
  const bundle = path.join(relocated, prepared.relativeBundle);
  const manifest = JSON.parse(await fs.readFile(path.join(bundle, 'runner-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.acceptance, acceptance);
  assert.equal(manifest.steps[0].acceptance_mapping, `${prepared.relativeBundle}/01-acceptance-mapping.json`);
  for (const [name, expected] of expectedModules) assert.deepEqual(await fs.readFile(path.join(bundle, 'runner', name)), expected, name);
  for (const command of ['dry-run', 'status']) {
    const result = run(process.execPath, [path.join(bundle, 'run.mjs'), command], { cwd: f.root, timeout: 20000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Acceptance mode: strict/);
    assert.ok(result.stdout.includes(relocated));
  }
  assert.equal(await exists(f.skillRoot), false);
  assert.equal(await exists(path.join(relocated, '.codex-plan-runner')), false, 'Read-only relocation validation must not create progress state');
});

test('complete strict authoring example freezes meaningful capabilities, criteria and explicit manual boundaries', async () => {
  const example = JSON.parse(await fs.readFile(new URL('../references/strict-acceptance-example.json', import.meta.url), 'utf8'));
  assert.equal(validateSpec(example), example);
  assert.equal(example.steps.find(step => step.id === '15').manual, false);
  assert.equal(example.steps.find(step => step.id === '45').manual, true);
  assert.deepEqual([...new Set(Object.values(example.acceptance.packages).flatMap(pkg => pkg.required_gates.map(gate => gate.capability)))].sort(), ['loopback-browser', 'npm-checks', 'production-build', 'synthetic-postgres']);
  assert.match(example.contract, /Before work, preflight/);
  assert.match(example.contract, /Future mapping files and SQL\/browser tests are implementation deliverables/);
});
