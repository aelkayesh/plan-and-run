import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const terminal = new Set(['completed', 'incomplete', 'interrupted', 'failed', 'blocked']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const require = (ok, message) => { if (!ok) throw Object.assign(new Error(`Background admission: ${message}`), { code: 'BACKGROUND_OWNERSHIP_UNRESOLVED' }); };
function safe(root, file) {
  file = path.resolve(file);
  require(file.startsWith(path.join(root, '.codex-plan-runner') + path.sep), 'ownership path escapes runner state');
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part);
    require(!fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink(), 'ownership path contains a symlink');
  }
  return file;
}
function read(root, file) {
  safe(root, file);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  require(stat?.isFile() && stat.nlink === 1, `missing or linked ownership artifact: ${file}`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { require(false, `malformed ownership artifact: ${file}`); }
}
function alive(pid) {
  require(Number.isSafeInteger(pid) && pid > 1, 'invalid saved process identity');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; require(false, `process absence is unknown (${error.code}); no signal was sent`); }
}
// This is a fixed, read-only OS observation. The start time and full command
// distinguish a still-finalizing owner from reuse of a historical PID.
export function backgroundProcessIdentity(pid) {
  if (!alive(pid)) return null;
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', shell: false, timeout: 3000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 1 && !result.error && !result.signal && !alive(pid)) return null;
  if (result.error || result.signal || result.status !== 0 || !result.stdout.trim()) return null;
  return hash(result.stdout.trim());
}
function closedProcess(pid, identity, label) {
  if (pid === null || pid === undefined) return;
  if (!alive(pid)) return;
  require(HASH.test(identity || ''), `${label} remains live or its historical identity is unavailable; inspect without signalling`);
  const current = backgroundProcessIdentity(pid);
  require(current !== null && current !== identity, `${label} has live or unresolved ownership after its final receipt`);
}
function validateWake(root, directory, session, own) {
  const file = path.join(directory, 'wake.json');
  if (!fs.existsSync(file)) { require(!session.wake, 'session references a missing wake journal'); return; }
  const wake = read(root, file);
  require(wake?.schema_version === 1 && wake.kind === 'background-wake' && UUID.test(wake.id || '')
    && wake.owner_pid === session.pid && wake.helper === '/usr/bin/caffeinate'
    && JSON.stringify(wake.args) === JSON.stringify(['-i', '-w', String(session.pid)])
    && ['darwin', 'linux'].includes(wake.platform), 'wake owner/helper identity mismatch');
  require(session.wake?.id === wake.id && session.wake.journal_file === file && session.wake.platform === wake.platform, 'session/wake journal binding differs');
  if (own) return;
  require(wake.cleanup_verified === true && ['stopped', 'disabled', 'failed'].includes(wake.phase), 'wake cleanup remains unresolved');
  require(session.wake.cleanup_verified === true && session.wake.phase === wake.phase, 'session/wake cleanup receipts contradict');
  if (wake.phase === 'disabled') require(wake.pid === null && wake.platform !== 'darwin', 'disabled wake journal records an owned helper');
  else if (wake.pid !== null) {
    require(wake.exit && (wake.exit.code === null || Number.isInteger(wake.exit.code)) && (wake.exit.signal === null || typeof wake.exit.signal === 'string'), 'wake helper lacks an exit receipt');
    closedProcess(wake.pid, wake.process_identity, 'wake helper');
  }
}

/** Read-only. Never signals, deletes, adopts, repairs or starts any resource. */
export function inspectBackgroundOwnership({ root, stateDir, planId = path.basename(stateDir), ownSession } = {}) {
  root = fs.realpathSync(root); stateDir = safe(root, path.resolve(root, stateDir));
  require(typeof planId === 'string' && /^[a-z0-9-]+$/.test(planId), 'invalid plan identity');
  const tree = safe(root, path.join(stateDir, 'background')), files = [], sessions = [];
  if (!fs.existsSync(tree)) { require(!ownSession, 'own controller session is missing'); return { files, sessions }; }
  require(fs.lstatSync(tree).isDirectory(), 'background tree is not a directory');
  const inventory = directory => {
    files.push({ file: path.relative(root, directory), kind: 'directory', mode: fs.lstatSync(directory).mode & 0o777 });
    for (const name of fs.readdirSync(directory).sort()) {
      const file = safe(root, path.join(directory, name)), stat = fs.lstatSync(file);
      if (stat.isDirectory()) { inventory(file); continue; }
      require(stat.isFile() && stat.nlink === 1, 'background tree contains a nonregular or linked artifact');
      files.push({ file: path.relative(root, file), sha256: hash(fs.readFileSync(file)), mode: stat.mode & 0o777 });
    }
  };
  files.push({ file: path.relative(root, tree), kind: 'directory', mode: fs.lstatSync(tree).mode & 0o777 });
  let ownSeen = false;
  for (const id of fs.readdirSync(tree).sort()) {
    require(UUID.test(id), 'unknown artifact in background ownership tree');
    const directory = safe(root, path.join(tree, id)); require(fs.lstatSync(directory).isDirectory(), 'session is not a directory');
    const file = path.join(directory, 'session.json'), s = read(root, file);
    require(s?.schema_version === 1 && s.id === id && UUID.test(s.owner || '') && s.root === root
      && s.identity?.plan_id === planId && Array.isArray(s.identity.selected)
      && typeof s.module_file === 'string' && path.isAbsolute(s.module_file) && s.module_file.startsWith(root + path.sep)
      && HASH.test(s.module_sha256 || '') && Number.isFinite(Date.parse(s.created_at)), 'session root/plan/module identity mismatch');
    require(s.pid === null || Number.isSafeInteger(s.pid) && s.pid > 1, 'invalid controller PID');
    const own = ownSession?.file === file;
    if (own) {
      require(!ownSeen && ownSession.id === id && ownSession.owner === s.owner && ownSession.pid === process.pid && s.pid === process.pid
        && (s.process_identity === null || HASH.test(s.process_identity || '')), 'own controller capability does not match this live process');
      ownSeen = true;
    }
    let spawn;
    if (fs.existsSync(path.join(directory, 'spawn.json'))) {
      spawn = read(root, path.join(directory, 'spawn.json'));
      require(spawn.schema_version === 1 && spawn.id === id && spawn.owner === s.owner && Number.isSafeInteger(spawn.pid) && spawn.pid > 1
        && (s.pid === null || spawn.pid === s.pid), 'spawn journal contradicts controller ownership');
    }
    if (s.pid !== null) {
      const claim = read(root, path.join(directory, 'claim.json'));
      require(claim.id === id && claim.owner === s.owner && claim.pid === s.pid, 'controller claim contradicts session');
    }
    validateWake(root, directory, s, own);
    const resultFile = path.join(directory, 'result.json');
    if (own) {
      require(!fs.existsSync(resultFile) && ['starting', 'running', 'stopping'].includes(s.phase), 'own controller is already finalized');
    } else {
      const r = read(root, resultFile);
      require(terminal.has(s.phase) && r?.schema_version === 1 && r.id === id && r.root === root && r.pid === s.pid
        && r.identity?.plan_id === planId && JSON.stringify(r.identity.selected) === JSON.stringify(s.identity.selected)
        && r.phase === s.phase && r.finished_at === s.finished_at && Number.isFinite(Date.parse(r.finished_at))
        && Number.isInteger(r.exit_code) && r.cleanup_verified === true && typeof r.accepted === 'boolean'
        && r.accepted === (r.phase === 'completed') && (!r.accepted || r.exit_code === 0 && s.ready_at && UUID.test(s.lock?.token || '')),
      'controller has no consistent terminal cleanup receipt');
      require(fs.lstatSync(path.join(directory, 'result.txt'), { throwIfNoEntry: false })?.isFile(), 'final controller report is missing');
      if (s.pid === null) require(!spawn && !s.wake && !s.ready_at, 'unclaimed session contains possible child effects');
      else closedProcess(s.pid, s.process_identity, 'background controller');
    }
    inventory(directory);
    sessions.push({ id, phase: s.phase, own, session_file: path.relative(root, file) });
  }
  require(!ownSession || ownSeen, 'own controller is absent from admission inventory');
  return { files, sessions };
}

/** Serialize publication with the same guard used by foreground lock changes. */
export function publishBackgroundSession({ root, stateDir, planId }, publish) {
  root = fs.realpathSync(root); stateDir = safe(root, path.resolve(root, stateDir));
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const guard = safe(root, path.join(stateDir, 'lock-guard'));
  try { fs.mkdirSync(guard, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') require(false, 'another lock/admission operation is active'); throw error; }
  try {
    inspectBackgroundOwnership({ root, stateDir, planId });
    const lockFile = path.join(stateDir, 'runner.lock');
    if (fs.existsSync(lockFile)) {
      const lock = read(root, lockFile);
      require(lock.hostname === os.hostname() && UUID.test(lock.token || '') && Number.isSafeInteger(lock.pid) && lock.pid > 1, 'runner lock ownership is malformed');
      require(!alive(lock.pid) && (!lock.worker_pid || !alive(lock.worker_pid)), 'runner lock is active; background publication is forbidden');
      if (lock.worker_pid) { try { process.kill(-lock.worker_pid, 0); require(false, 'runner worker group is still active'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    }
    return publish();
  } finally { fs.rmdirSync(guard); }
}
