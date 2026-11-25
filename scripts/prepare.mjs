#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateRecoveryConfiguration } from '../assets/runner/recovery.mjs';
import { validateAcceptanceProfile } from '../assets/runner/acceptance-policy.mjs';

const DEFAULT_SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_FILES = ['runner.mjs', 'protocol.mjs', 'provider-outcome.mjs', 'worker-progress.mjs', 'failure-report.mjs', 'run.mjs', 'recovery.mjs', 'host-validation.mjs', 'automatic-host-validation.mjs', 'host-validation-helper.mjs', 'runtime-reconciliation.mjs', 'runtime-artifacts.mjs', 'subdivision.mjs', 'subdivision-state.mjs', 'acceptance-policy.mjs', 'acceptance-lifecycle.mjs', 'acceptance-adapters.mjs', 'python-dependencies.mjs', 'acceptance-postgres.mjs', 'acceptance-helper.mjs', 'acceptance-fixtures.md', 'background-control.mjs', 'background-ownership.mjs', 'background-child.mjs', 'background-runner.mjs', 'owned-wake.mjs', 'range-preflight.mjs', 'auth-readiness.mjs', 'unattended.mjs', 'unattended-cleanup.mjs'];
const IGNORE_RULE = '/.codex-plan-runner/';

function fail(message) { throw new Error(message); }

async function statOrNull(filename) {
  try { return await fs.lstat(filename); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Reject symlinks at every existing component, including links back into the root.
async function safePath(root, filename, type) {
  const relative = path.relative(root, filename);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    fail(`Path escapes its root: ${filename}`);
  }
  const components = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    const stat = await statOrNull(current);
    if (!stat) return null;
    if (stat.isSymbolicLink()) fail(`Symlink paths are not allowed: ${current}`);
    const required = index < components.length - 1 ? 'directory' : type;
    if (required === 'directory' && !stat.isDirectory()) fail(`Expected a directory: ${current}`);
    if (required === 'file' && !stat.isFile()) fail(`Expected a regular file: ${current}`);
    if (index === components.length - 1) return stat;
  }
  return fs.lstat(root);
}

function nonempty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be nonempty text.`);
  if (value.includes('\0')) fail(`${label} must not contain NUL characters.`);
  return value;
}

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('The spec must be a JSON object.');
  nonempty(spec.title, 'title');
  nonempty(spec.source, 'source Markdown');
  nonempty(spec.contract, 'contract Markdown');
  if (!Array.isArray(spec.steps) || spec.steps.length < 1 || spec.steps.length > 99) {
    fail('steps must contain between 1 and 99 authored steps.');
  }
  let previous = 0;
  for (const [index, step] of spec.steps.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) fail(`Step ${index + 1} must be an object.`);
    if (typeof step.id !== 'string' || !/^[0-9]{2}$/.test(step.id) || Number(step.id) <= previous) {
      fail('Step ids must be unique, increasing two-digit ids from 01 through 99.');
    }
    previous = Number(step.id);
    nonempty(step.title, `Step ${step.id} title`);
    nonempty(step.plan, `Step ${step.id} plan Markdown`);
    if (typeof step.manual !== 'boolean') fail(`Step ${step.id} manual must be a boolean.`);
  }
  if (spec.recovery !== undefined) validateRecoveryConfiguration(spec.recovery, spec.steps);
  if (spec.acceptance !== undefined) validateAcceptanceProfile(spec.acceptance, spec.steps);
  return spec;
}

async function canonicalRepo(input) {
  nonempty(input, '--repo');
  const repo = await fs.realpath(path.resolve(input));
  if (!(await fs.stat(repo)).isDirectory()) fail('--repo must name a Git repository root.');
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  const git = (...args) => execFileSync('git', ['-C', repo, 'rev-parse', ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    if (git('--is-inside-work-tree') !== 'true') fail('--repo must be a Git working-tree root.');
    if (await fs.realpath(git('--show-toplevel')) !== repo) fail('--repo must name the Git root, not a subdirectory.');
    git('--verify', 'HEAD^{commit}');
  } catch (error) {
    if (error.message.startsWith('--repo')) throw error;
    fail('--repo must be a Git working-tree root with an existing HEAD commit.');
  }
  return repo;
}

function tableText(value) { return value.trim().replaceAll('|', '\\|').replaceAll(/\r?\n/g, '<br>'); }
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

function wrapperSource() {
  return `#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './runner/runner.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg === '--repo' || arg.startsWith('--repo=') || arg === '--manifest' || arg.startsWith('--manifest='))) {
  console.error('This bundle pins --repo and --manifest; overrides are not allowed.');
  process.exitCode = 1;
} else {
  const bundle = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(bundle, '../../..');
  try {
    process.exitCode = await main([...args, '--repo', repo, '--manifest', path.relative(repo, path.join(bundle, 'runner-manifest.json'))]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
`;
}

function readmeSource(spec, slug, relativeBundle) {
  const command = `node ${shellQuote(`${relativeBundle}/run.mjs`)}`;
  const rows = spec.steps.map(step => `| ${step.id} | [${tableText(step.title)}](${step.id}-plan.md) | Pending | ${step.manual ? 'Manual' : 'Worker'} | \`${step.id}-validation.json\` | \`${step.id}-handoff.md\` |`).join('\n');
  return `# ${spec.title.trim()}

Plan id: \`${slug}\`

This bundle is initially prepared as an authored draft. The current readiness value in [runner-manifest.json](runner-manifest.json) and the runner's status output take precedence over this initial note. Review [the request](request.md), [the shared contract](shared-contract.md), every step plan, and [the worker contract](worker-contract.md). After resolving omissions and checking the manifest paths, set \`ready\` to \`true\`. Start, resume and launch refuse draft manifests. Plan prerequisites for the complete intended range, including all frozen acceptance capabilities, before execution.

| Step | Plan | Status | Execution | Validation receipt | Handoff |
| --- | --- | --- | --- | --- | --- |
${rows}

Steps depend on the preceding listed step. Validation and handoff files are produced during execution; no runner state or worker has been created by preparation. The runner's status and receipts are authoritative for execution progress; this table starts as a pending index.

Acceptance mode: **${spec.acceptance?.mode === 'strict' ? 'strict parent-owned acceptance' : 'legacy receipt verification'}**. ${spec.acceptance?.mode === 'strict' ? 'The authored manifest freezes required capabilities, criterion IDs/types/purposes and gate assignments. Workers propose case mappings; the parent verifies complete coverage, executes fixed gates, binds evidence to current source and obtains a fresh read-only semantic review before acceptance.' : 'Completion verifies receipt structure and declared checks. It does not independently establish that every original acceptance requirement has been executed. Author an explicit strict acceptance profile to require the stronger lifecycle.'}

Run from the repository root:

\`\`\`sh
${command} dry-run
${command} status
# After reviewing and marking the manifest ready:
${command} preflight --json
${command} start
${command} resume
# Only when unattended/background execution is requested:
${command} launch --json
${command} status --json
${command} logs
${command} stop --session SESSION_UUID --json
\`\`\`

Add \`--step NN\` or \`--from NN --to NN\` to preflight and execution to preserve the intended scope. Foreground \`start\` remains the default when the subcommand is omitted; \`resume\` uses the same execution path. Launch performs complete-range prerequisites and acknowledges only its durable owned session, not acceptance. Retain its UUID and result path; status distinguishes unfinished/manual work, current blockers and historical failures. Stop challenges the live owner, waits for cleanup and preserves accepted work, sessions, cooldowns and retry budgets. A repeated launch resumes from that saved progress.

The background runner survives closed terminal stdio. On macOS it confirms an owned idle-sleep assertion tied to its lifetime and verifies cleanup; unexpected assertion loss aborts work, and unresolved ownership or cleanup prevents a successful result. No service or reboot restart is installed, and poweroff/closed-lid survival is not promised. Local authentication readiness uses no inference and is not proof of remote authorization.

For the supported Azure CLI user-auth command, preflight inspects existing helper/profile/plaintext-cache identities and matching credential presence. It never executes an auth command or refreshes credentials; token validity remains unverified. Unknown mechanisms, unsupported stores and unresolved repository provider/profile precedence remain explicit blockers. The worker contract defines the supported local probe and its limits; preserve the selected provider and credential configuration.

The wrapper pins this repository and manifest. Its copied \`runner/\` modules travel with this directory, with no dependency on an installed skill. Runtime state belongs under the ignored \`.codex-plan-runner/${slug}/\` directory. Consult \`node ${shellQuote(`${relativeBundle}/run.mjs`)} --help\` and the worker contract for runner options and manual gates.
`;
}

async function snapshotIgnore(repo) {
  const filename = path.join(repo, '.gitignore');
  const stat = await safePath(repo, filename, 'file');
  return { filename, stat, bytes: stat ? await fs.readFile(filename) : null };
}

function sameFile(left, right) { return left && right && left.dev === right.dev && left.ino === right.ino; }

async function appendIgnore(repo, before) {
  const current = await snapshotIgnore(repo);
  if (Boolean(current.stat) !== Boolean(before.stat) || (current.stat && (!sameFile(current.stat, before.stat) || !current.bytes.equals(before.bytes)))) {
    fail('.gitignore changed during preparation; retry after reviewing the change.');
  }
  if (before.bytes?.toString('utf8').split(/\r?\n/).includes(IGNORE_RULE)) return null;
  const newline = before.bytes?.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  const suffix = Buffer.from(`${before.bytes?.length && before.bytes[before.bytes.length - 1] !== 10 ? newline : ''}${IGNORE_RULE}${newline}`);
  const flags = before.stat ? constants.O_WRONLY | constants.O_APPEND : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
  const handle = await fs.open(before.filename, flags | (constants.O_NOFOLLOW || 0), 0o644);
  let receipt;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (before.stat && !sameFile(stat, before.stat))) fail('.gitignore changed during preparation.');
    receipt = { ...before, stat, expected: Buffer.concat([before.bytes || Buffer.alloc(0), suffix]) };
    await handle.writeFile(suffix);
  } catch (error) {
    if (receipt) {
      // Restore only our own append, while the same descriptor is still open.
      const bytes = await fs.readFile(before.filename).catch(() => null);
      const original = before.bytes || Buffer.alloc(0);
      if (bytes && bytes.subarray(0, original.length).equals(original) && receipt.expected.subarray(0, bytes.length).equals(bytes)) {
        await handle.truncate(original.length);
        if (before.bytes === null && sameFile(await statOrNull(before.filename), receipt.stat)) await fs.unlink(before.filename);
      }
    }
    throw error;
  } finally {
    await handle.close();
  }
  return receipt;
}

async function restoreIgnore(repo, receipt) {
  if (!receipt) return;
  const current = await snapshotIgnore(repo);
  if (!sameFile(current.stat, receipt.stat) || !current.bytes.equals(receipt.expected)) {
    fail('Could not roll back .gitignore because it changed concurrently.');
  }
  if (receipt.bytes === null) await fs.unlink(receipt.filename);
  else await fs.truncate(receipt.filename, receipt.bytes.length);
}

async function createParents(repo, parent, created) {
  const parts = path.relative(repo, parent).split(path.sep);
  let current = repo;
  for (const part of parts) {
    current = path.join(current, part);
    if (await safePath(repo, current, 'directory')) continue;
    await fs.mkdir(current);
    created.push(current);
  }
}

export async function prepareBundle({ repo: repoInput, slug, specPath, skillRoot = DEFAULT_SKILL_ROOT }) {
  if (process.env.CODEX_PLAN_WORKER === '1') {
    fail('Worker recursion denied: execute the assigned package; do not prepare a nested plan.');
  }
  if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 63) {
    fail('--slug must be 1-63 lowercase letters/digits separated by single hyphens.');
  }
  nonempty(specPath, '--spec');
  const specStat = await fs.lstat(path.resolve(specPath));
  if (!specStat.isFile() || specStat.isSymbolicLink()) fail('--spec must be a regular JSON file, not a symlink.');
  let spec;
  try { spec = JSON.parse(await fs.readFile(path.resolve(specPath), 'utf8')); } catch (error) { fail(`Cannot read JSON spec: ${error.message}`); }
  validateSpec(spec);
  const repo = await canonicalRepo(repoInput);
  const relativeBundle = `docs/implementation-plans/${slug}`;
  const bundle = path.join(repo, relativeBundle);
  const parent = path.dirname(bundle);
  const state = path.join(repo, '.codex-plan-runner', slug);
  if (await safePath(repo, bundle, 'directory')) fail(`Refusing to overwrite existing plan bundle: ${bundle}`);
  if (await safePath(repo, state)) fail(`Refusing to reuse existing runner state: ${state}`);
  const ignore = await snapshotIgnore(repo);

  // Load every bundled dependency before making any repository changes.
  const assetRoot = await fs.realpath(skillRoot);
  const sources = new Map();
  for (const name of RUNTIME_FILES) {
    const source = path.join(assetRoot, 'assets', 'runner', name);
    if (!await safePath(assetRoot, source, 'file')) fail(`Missing runner asset: ${name}`);
    const bytes = await fs.readFile(source);
    if (!bytes.length) fail(`Empty runner asset: ${name}`);
    sources.set(`runner/${name}`, bytes);
  }
  const workerSource = path.join(assetRoot, 'references', 'runner-contract.md');
  if (!await safePath(assetRoot, workerSource, 'file')) fail('Missing references/runner-contract.md.');
  const workerContract = await fs.readFile(workerSource, 'utf8');
  nonempty(workerContract, 'Worker contract');
  const manifest = {
    schema_version: 1,
    plan_id: slug,
    source: `${relativeBundle}/request.md`,
    contract: `${relativeBundle}/shared-contract.md`,
    worker_contract: `${relativeBundle}/worker-contract.md`,
    ready: false,
    recovery: spec.recovery ?? { schema_version: 1, packages: Object.fromEntries(spec.steps.filter(step => !step.manual).map(step => [step.id, { local_repair: true, recipes: [] }])) },
    acceptance: spec.acceptance ?? { schema_version: 1, mode: 'legacy', packages: {} },
    steps: spec.steps.map((step, index) => ({
      id: step.id,
      title: step.title,
      plan: `${relativeBundle}/${step.id}-plan.md`,
      validation: `${relativeBundle}/${step.id}-validation.json`,
      handoff: `${relativeBundle}/${step.id}-handoff.md`,
      dependencies: index ? [spec.steps[index - 1].id] : [],
      manual: step.manual,
      ...(spec.acceptance?.mode === 'strict' && spec.acceptance.packages[step.id] ? { acceptance_mapping: `${relativeBundle}/${step.id}-acceptance-mapping.json` } : {}),
    })),
  };
  sources.set('request.md', spec.source);
  sources.set('shared-contract.md', spec.contract);
  sources.set('worker-contract.md', workerContract);
  sources.set('README.md', readmeSource(spec, slug, relativeBundle));
  sources.set('runner-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  sources.set('run.mjs', wrapperSource());
  for (const step of spec.steps) sources.set(`${step.id}-plan.md`, step.plan);

  const createdParents = [];
  let staging;
  let ignoreReceipt;
  try {
    await createParents(repo, parent, createdParents);
    staging = await fs.mkdtemp(path.join(parent, `.prepare-${slug}-`));
    await fs.mkdir(path.join(staging, 'runner'));
    for (const [name, content] of sources) await fs.writeFile(path.join(staging, name), content, { flag: 'wx', mode: 0o644 });
    // Recheck all existing ancestors and reserved paths immediately before publishing.
    await safePath(repo, parent, 'directory');
    if (await safePath(repo, bundle, 'directory')) fail(`Refusing to overwrite existing plan bundle: ${bundle}`);
    if (await safePath(repo, state)) fail(`Refusing to reuse existing runner state: ${state}`);
    ignoreReceipt = await appendIgnore(repo, ignore);
    await fs.rename(staging, bundle);
    staging = null;
  } catch (error) {
    const cleanupErrors = [];
    try { await restoreIgnore(repo, ignoreReceipt); } catch (cleanupError) { cleanupErrors.push(cleanupError.message); }
    if (staging) {
      try { await fs.rm(staging, { recursive: true, force: true }); } catch (cleanupError) { cleanupErrors.push(cleanupError.message); }
    }
    for (const directory of createdParents.reverse()) {
      try { await fs.rmdir(directory); } catch (cleanupError) {
        if (!['ENOENT', 'ENOTEMPTY'].includes(cleanupError.code)) cleanupErrors.push(cleanupError.message);
      }
    }
    if (cleanupErrors.length) error.message += ` Cleanup: ${cleanupErrors.join('; ')}`;
    throw error;
  }
  return { repo, bundle, manifest, relativeBundle };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('Usage: node prepare.mjs --repo PATH --slug lowercase-hyphen-name --spec PATH');
    return;
  }
  const options = {};
  const names = new Map([['--repo', 'repo'], ['--slug', 'slug'], ['--spec', 'specPath']]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    if (!name || options[name] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) fail(`Invalid argument: ${argv[index] || '(missing)'}`);
    options[name] = argv[index + 1];
  }
  if (Object.keys(options).length !== names.size) fail('Usage: node prepare.mjs --repo PATH --slug lowercase-hyphen-name --spec PATH');
  const result = await prepareBundle(options);
  const command = `node ${shellQuote(`${result.relativeBundle}/run.mjs`)}`;
  console.log(`Prepared draft plan: ${result.bundle}\nReview its documents and set runner-manifest.json ready to true when complete.\nNext commands (from ${result.repo}):\n  ${command} dry-run\n  ${command} status\nAfter review:\n  ${command} preflight --json\n  ${command} start\n  ${command} resume\nFor requested unattended execution:\n  ${command} launch --json\n  ${command} status --json\n  ${command} logs\n  ${command} stop --session SESSION_UUID --json`);
}

// Node normally resolves the module through symlinks, while argv keeps the
// invocation spelling (for example macOS /tmp versus /private/tmp).
const invokedFile = process.argv[1] ? await fs.realpath(path.resolve(process.argv[1])).catch(() => null) : null;
if (invokedFile && invokedFile === await fs.realpath(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(`prepare: ${error.message}`); process.exitCode = 1; });
}
