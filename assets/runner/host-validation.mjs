import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const COMMANDS = [['npm', 'test'], ['npm', 'run', 'check']];
const HASH = /^[a-f0-9]{64}$/;
const KIND = 'codex-plan-host-validation';
const TIMEOUT_MS = 30 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const jsonDigest = value => digest(JSON.stringify(value));

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024
  });
}

function repository(root) {
  const real = fs.realpathSync(root);
  if (fs.realpathSync(git(real, 'rev-parse', '--show-toplevel').trim()) !== real) {
    throw new Error('Host validation requires the Git working-tree root.');
  }
  return real;
}

export function fileHash(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

// Resolve every existing component before creating or reading evidence. This
// rejects symlinks that leave the private state directory, including parents.
export function statePath(root, candidate, { existing = false } = {}) {
  if (typeof candidate !== 'string' || !candidate) throw new Error('Missing host validation artifact path.');
  const stateRoot = path.join(root, '.codex-plan-runner');
  const resolved = path.resolve(root, candidate);
  if (!resolved.startsWith(stateRoot + path.sep)) throw new Error('Host validation artifacts must be inside repository .codex-plan-runner.');
  for (let current = stateRoot; ; ) {
    if (fs.existsSync(current)) {
      const real = fs.realpathSync(current);
      if (!within(stateRoot, real)) throw new Error('Host validation artifact symlink escapes private runner state.');
    } else if (fs.lstatSync(current, { throwIfNoEntry: false })) {
      throw new Error('Host validation artifact contains a broken symlink.');
    }
    if (current === resolved) break;
    const next = path.relative(current, resolved).split(path.sep)[0];
    current = path.join(current, next);
  }
  if (existing && (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())) {
    throw new Error('Host validation artifact is missing or not a regular file.');
  }
  return resolved;
}

function identity(packageId, planHash) {
  if (typeof packageId !== 'string' || !/^\d{2}$/.test(packageId) || !HASH.test(planHash || '')) {
    throw new Error('Host validation requires a package ID and SHA-256 plan identity.');
  }
}

function exclusions(root, mutablePaths) {
  if (!Array.isArray(mutablePaths) || mutablePaths.some(file => typeof file !== 'string' || !file || path.isAbsolute(file))) {
    throw new Error('Mutable host validation paths must be repository-relative file paths.');
  }
  return [...new Set(mutablePaths.map(relative => {
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || fs.lstatSync(file, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('Mutable host validation paths must identify individual repository files.');
    }
    return path.relative(root, file).split(path.sep).join('/');
  }))].sort();
}

export function snapshotSource(root, mutablePaths = []) {
  root = repository(root);
  const excludedPaths = exclusions(root, mutablePaths);
  const paths = [...new Set(git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z')
    .split('\0').filter(file => file && !excludedPaths.includes(file)))];
  paths.sort();
  const files = paths.map(relative => {
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw new Error('Source inventory path escapes repository.');
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return { path: relative, kind: 'deleted', sha256: null };
    if (!within(root, fs.realpathSync(file))) throw new Error(`Source symlink escapes repository: ${relative}`);
    if (stat.isSymbolicLink()) {
      if (!fs.statSync(file).isFile()) throw new Error(`Unsupported source symlink: ${relative}`);
      return { path: relative, kind: 'symlink', target: fs.readlinkSync(file), sha256: fileHash(file) };
    }
    if (!stat.isFile()) throw new Error(`Unsupported source inventory entry: ${relative}`);
    return { path: relative, kind: 'file', mode: stat.mode & 0o777, sha256: fileHash(file) };
  });
  const source = { head: git(root, 'rev-parse', 'HEAD').trim(), branch: git(root, 'branch', '--show-current').trim(), excluded_paths: excludedPaths, files };
  return { ...source, sha256: jsonDigest(source) };
}

function npmCli() {
  const candidates = (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'npm'));
  candidates.push(path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js', '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js');
  for (const candidate of candidates) {
    try {
      const file = fs.realpathSync(candidate);
      if (!fs.statSync(file).isFile()) continue;
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(256);
      let length;
      try { length = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
      if (/\.[cm]?js$/.test(file) || /^#![^\n]*\bnode(?:\s|$)/.test(buffer.subarray(0, length).toString('utf8'))) return file;
    } catch { /* Try the next installed npm entrypoint. */ }
  }
  throw new Error('Cannot locate a Node-based npm CLI on PATH.');
}

export function isolatedEnvironment(dataDirectory) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:PG[A-Z0-9_]*)$/i.test(key) || /(?:DATABASE_URL|DIRECT_URL)/i.test(key)
      || /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|CONNECTION_STRING)/i.test(key)
      || /^(?:OPENAI|AZURE|ANTHROPIC|AWS|GOOGLE|GCP|GROQ|MISTRAL|COHERE|HUGGINGFACE|HF_)/i.test(key)) delete env[key];
  }
  delete env.NODE_OPTIONS;
  env.PATH = [path.dirname(process.execPath), process.env.PATH || ''].join(path.delimiter);
  env.CODEX_PLAN_DATA_DIR = dataDirectory;
  return env;
}

function summary(evidence) {
  return `Host validation package ${evidence.package_id}: ${evidence.passed ? 'passed' : 'failed'}; `
    + evidence.checks.map(check => `${check.command}: exit ${check.exit_code}${check.signal ? ` (${check.signal})` : ''}`).join('; ')
    + `. Source ${evidence.source.sha256.slice(0, 12)}.`;
}

export function captureHostValidation({ root, packageId, planHash, outputDir, mutablePaths = [], recipeId, automatic = null, onJournal = () => {} }) {
  root = repository(root);
  identity(packageId, planHash);
  if (recipeId !== 'npm-checks') throw new Error('Unknown or unauthorized host recipe.');
  if (automatic && automatic.recipeId !== recipeId) throw new Error('Automatic host recipe does not match capture recipe.');
  outputDir = statePath(root, outputDir);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const npm = npmCli();
  const source = snapshotSource(root, mutablePaths);
  const createdAt = new Date().toISOString();
  const prefix = `${packageId}-${Date.now()}-${randomUUID()}`;
  const dataDirectory = automatic?.dataDirectory || fs.mkdtempSync(path.join(os.tmpdir(), `codex-plan-host-${packageId}-`));
  if (automatic) {
    const stat = fs.lstatSync(dataDirectory);
    const marker = path.join(dataDirectory, '.owner.json');
    if (!stat.isDirectory() || stat.isSymbolicLink() || !automatic.data
        || stat.ino !== automatic.data.inode || stat.dev !== automatic.data.device
        || automatic.data.directory !== dataDirectory || automatic.data.id !== automatic.id
        || !fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink()
        || JSON.parse(fs.readFileSync(marker, 'utf8')).id !== automatic.id) {
      throw new Error('Automatic host data ownership was not established by the parent.');
    }
    onJournal({ data: automatic.data });
  }
  fs.chmodSync(dataDirectory, 0o700);
  const hostContext = automatic ? snapshotHostContext(root) : null;
  const env = isolatedEnvironment(dataDirectory);
  const run = (argv, index, environment = env) => {
    const logFile = statePath(root, path.join(outputDir, `${prefix}-${index + 1}.log`));
    const fd = fs.openSync(logFile, 'wx', 0o600);
    onJournal({ check: { index, argv, log_file: path.relative(root, logFile), phase: 'pending' } });
    let result;
    try {
      result = spawnSync(process.execPath, [npm, ...argv.slice(1)], {
        cwd: root, env: environment, shell: false, detached: !automatic, stdio: ['ignore', fd, fd], timeout: TIMEOUT_MS, killSignal: 'SIGKILL'
      });
      // npm scripts may create test workers. Clean the isolated process group
      // after exit/timeout so surviving descendants cannot affect later checks.
      if (result.pid && !automatic) {
        try { process.kill(-result.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      if (result.error) fs.writeSync(fd, `\nHost validation process error: ${result.error.code || 'UNKNOWN'}\n`);
    } finally { fs.closeSync(fd); }
    return { command: argv.join(' '), argv: [...argv], exit_code: Number.isInteger(result.status) ? result.status : null,
      signal: result.signal || null, passed: result.status === 0 && !result.error && !result.signal,
      log_file: path.relative(root, logFile), log_sha256: fileHash(logFile),
      ...(result.error ? { error_code: result.error.code || 'UNKNOWN' } : {}) };
  };
  const checks = COMMANDS.map((argv, index) => run(argv, index));
  let after, sourceError;
  try { after = snapshotSource(root, mutablePaths); } catch (error) { sourceError = error.message; }
  const sourceUnchanged = after?.sha256 === source.sha256;
  const blockers = checks.filter(check => !check.passed).map(check => `${check.command} did not pass.`);
  if (hostContext && snapshotHostContext(root).sha256 !== hostContext.sha256) blockers.push('Host dependency or environment identity changed during validation.');
  if (!sourceUnchanged) blockers.push(sourceError ? `Source revalidation failed: ${sourceError}` : 'Source files changed during host validation.');
  const evidence = { schema_version: 1, kind: KIND, root, package_id: packageId, plan_hash: planHash,
    recipe_id: recipeId, created_at: createdAt, finished_at: new Date().toISOString(), source, source_after_sha256: after?.sha256 || null,
    source_unchanged: sourceUnchanged, passed: blockers.length === 0, blockers,
    runtime: { node_version: process.version, node_arch: process.arch, node_executable: process.execPath, npm_cli: npm },
    isolation: { data_directory: dataDirectory, credentials: 'database and provider credential environment variables removed' }, checks,
    ...(hostContext ? { host_context: hostContext, automatic: { id: automatic.id, recipe_id: automatic.recipeId, cleanup_verified: false } } : {}) };
  const file = statePath(root, path.join(outputDir, `${prefix}-host-validation.json`));
  if (automatic) onJournal({ phase: 'evidence_pending', evidence_file: file });
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { file, evidence, summary: summary(evidence) };
}

export function verifyHostValidation({ root, packageId, planHash, file, mutablePaths = [], recipeId = 'npm-checks', checkSource = true }) {
  root = repository(root);
  identity(packageId, planHash);
  file = statePath(root, file, { existing: true });
  const evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
  const require = (condition, message) => { if (!condition) throw new Error(`Invalid host validation: ${message}`); };
  require(evidence && typeof evidence === 'object' && !Array.isArray(evidence), 'receipt must be an object');
  require(evidence.schema_version === 1 && evidence.kind === KIND, 'unsupported receipt schema');
  require(recipeId === 'npm-checks' && evidence.recipe_id === recipeId, 'unknown or mismatched fixed host recipe');
  require(evidence.root === root && evidence.package_id === packageId && evidence.plan_hash === planHash, 'repository, package or plan identity does not match');
  require(evidence.passed === true && evidence.source_unchanged === true && Array.isArray(evidence.blockers) && evidence.blockers.length === 0, 'host checks failed or source changed');
  require(evidence.source && typeof evidence.source === 'object' && HASH.test(evidence.source.sha256 || ''), 'missing source snapshot');
  require(JSON.stringify(evidence.source.excluded_paths) === JSON.stringify(exclusions(root, mutablePaths)), 'mutable source exclusions do not match');
  require(typeof checkSource === 'boolean', 'checkSource must be a boolean');
  require(evidence.source_after_sha256 === evidence.source.sha256, 'source changed during host checks');
  const { sha256, ...source } = evidence.source;
  require(jsonDigest(source) === sha256, 'source inventory hash does not match');
  const commands = [...COMMANDS];
  require(Array.isArray(evidence.checks) && evidence.checks.length === commands.length, 'required allowlisted host checks are missing or additional checks were supplied');
  evidence.checks.forEach((check, index) => {
    const argv = commands[index];
    require(check && check.command === argv.join(' ') && JSON.stringify(check.argv) === JSON.stringify(argv), 'check command is not allowlisted');
    require(check.exit_code === 0 && check.passed === true && check.signal === null && !check.error_code, 'a check did not pass');
    require(typeof check.log_file === 'string' && !path.isAbsolute(check.log_file) && HASH.test(check.log_sha256 || ''), 'invalid log identity');
    const logFile = statePath(root, check.log_file, { existing: true });
    require(path.dirname(logFile) === path.dirname(file), 'log must be beside its host receipt');
    require(fileHash(logFile) === check.log_sha256, 'check log changed');
  });
  if (evidence.automatic) {
    require(evidence.automatic.recipe_id === recipeId && evidence.automatic.cleanup_verified === true, 'automatic host cleanup is unverified');
    require(evidence.host_context && HASH.test(evidence.host_context.sha256 || ''), 'host context identity missing');
    const { sha256: contextHash, ...context } = evidence.host_context;
    require(jsonDigest(context) === contextHash, 'host context hash does not match');
    if (checkSource) require(snapshotHostContext(root).sha256 === contextHash, 'host dependency or environment identity is stale');
  }
  if (checkSource) require(snapshotSource(root, mutablePaths).sha256 === sha256, 'source snapshot is stale');
  return { file, evidence, summary: summary(evidence) };
}

/** Detect dependency installations/edits and relevant host configuration changes.
 * Metadata includes ctime as well as mtime, size and inode so an untracked edit
 * invalidates evidence even if the source Git inventory is unchanged. This is
 * provenance under the local-user trust boundary, not a security sandbox. */
export function snapshotDependencies(root) {
  const files = [];
  const visited = new Set();
  const caches = new Set(['.cache', '.vite', '.vite-temp']);
  const visit = (file, relative) => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return;
    const entry = { path: relative, mode: stat.mode, inode: stat.ino };
    const real = fs.realpathSync(file);
    const target = stat.isSymbolicLink() ? fs.statSync(real) : stat;
    if (!target.isDirectory()) Object.assign(entry, { size: stat.size, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs });
    if (stat.isSymbolicLink()) { entry.target = fs.readlinkSync(file); entry.target_metadata = [real, target.mode, target.ino, ...(target.isDirectory() ? [] : [target.size, target.mtimeMs, target.ctimeMs])]; }
    files.push(entry);
    if (target.isDirectory() && !visited.has(real)) {
      visited.add(real);
      for (const name of fs.readdirSync(file).sort()) if (!caches.has(name)) visit(path.join(file, name), `${relative}/${name}`);
    }
  };
  visit(path.join(root, 'node_modules'), 'node_modules');
  return { schema_version: 1, sha256: jsonDigest(files) };
}

export function snapshotHostContext(root) {
  const environment = isolatedEnvironment('<isolated-data>');
  const selected = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    /^(PATH|NODE_ENV|LANG|LC_.*|TZ|npm_config_.*|NPM_CONFIG_.*|CODEX_PLAN_DATA_DIR)$/.test(key)).sort(([a], [b]) => a.localeCompare(b)));
  const npm = npmCli();
  const context = { schema_version: 1, node_version: process.version, node_arch: process.arch,
    node_executable: process.execPath, npm_cli: npm, npm_sha256: fileHash(npm),
    environment_sha256: jsonDigest(selected), dependencies_sha256: snapshotDependencies(root).sha256 };
  return { ...context, sha256: jsonDigest(context) };
}
