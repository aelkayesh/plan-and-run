import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redact } from './failure-report.mjs';
import { startOwnedWake } from './owned-wake.mjs';
import { backgroundProcessIdentity, publishBackgroundSession } from './background-ownership.mjs';

const ownDirectory = path.dirname(fileURLToPath(import.meta.url));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const digest = file => createHash('sha256').update(privateBytes(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const terminal = new Set(['completed', 'incomplete', 'interrupted', 'failed', 'blocked']);

function contained(root, file) {
  file = path.resolve(file);
  if (!file.startsWith(root + path.sep)) throw new Error('Background path escapes repository.');
  let next = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    next = path.join(next, part);
    const item = fs.lstatSync(next, { throwIfNoEntry: false });
    if (item?.isSymbolicLink()) throw new Error('Background paths may not contain symlinks.');
  }
  return file;
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Background artifacts must be private regular files, not links.');
  return file;
}
function privateBytes(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    // A concurrent atomic rename can unlink this already opened inode. Its
    // complete snapshot stays valid; hard links and non-files never do.
    if (!stat.isFile() || stat.nlink > 1) throw new Error('Background artifacts must be private regular files, not links.');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function atomic(file, value) {
  const marker = path.sep + '.codex-plan-runner' + path.sep;
  const offset = file.indexOf(marker);
  if (offset < 1) throw new Error('Background writes require an owned runner state path.');
  contained(file.slice(0, offset), file);
  if (fs.existsSync(file)) regular(file);
  const temporary = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
function read(file) { return JSON.parse(privateBytes(file).toString('utf8')); }
function exists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function paths(sessionFile) {
  sessionFile = path.resolve(sessionFile);
  const session = read(sessionFile);
  if (!uuid.test(session.id || '') || !uuid.test(session.owner || '') || session.schema_version !== 1) throw new Error('Invalid background identity.');
  const root = fs.realpathSync(session.root);
  if (root !== session.root || path.basename(path.dirname(sessionFile)) !== session.id || path.basename(sessionFile) !== 'session.json') throw new Error('Background session location mismatch.');
  contained(root, sessionFile);
  const directory = path.dirname(sessionFile);
  if (!directory.startsWith(path.join(root, '.codex-plan-runner') + path.sep)) throw new Error('Background session is outside runner state.');
  for (const name of ['control.json', 'response.json', 'result.json', 'result.txt', 'raw.log', 'wake.json', 'claim.json', 'spawn.json']) contained(root, path.join(directory, name));
  return { session, directory, file: sessionFile, control: path.join(directory, 'control.json'), response: path.join(directory, 'response.json'), result: path.join(directory, 'result.json') };
}

// Only presentation surfaces use this projection. Ownership journals remain
// private and are never returned by status/logs/launch/stop.
export function publicProjection(value, secrets = []) {
  const clean = item => {
    if (typeof item === 'string') {
      let text = redact(item).replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
      for (const secret of secrets) if (secret) text = text.split(secret).join('[private ownership]');
      return text;
    }
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .filter(([key]) => !['owner', 'token', 'args', 'binding_files', 'module_file', 'module_sha256'].includes(key)
        && !/(?:password|secret|api[_-]?key|(?:^|_)token$|challenge|authorization)/i.test(key))
      .map(([key, child]) => [key, clean(child)]));
    return item;
  };
  return clean(value);
}
function project(session, extra = {}) {
  const { id, root, identity, pid, phase, created_at, ready_at, finished_at, lock, wake } = session;
  return publicProjection({ schema_version: 1, id, root, identity, pid, phase, created_at, ready_at, finished_at,
    lock: lock ? { file: lock.file } : null, wake, ...extra }, [session.owner, session.lock?.token]);
}

function trackedPid(p) {
  const file = path.join(p.directory, 'spawn.json');
  if (!fs.existsSync(file)) return p.session.pid;
  const spawned = read(file);
  if (spawned.id !== p.session.id || spawned.owner !== p.session.owner || !Number.isSafeInteger(spawned.pid) || spawned.pid < 1
      || (p.session.pid !== null && p.session.pid !== spawned.pid)) throw new Error('Background spawn ownership mismatch.');
  return spawned.pid;
}

export function inspectBackground(sessionFile) {
  const p = paths(sessionFile), s = p.session;
  if (fs.existsSync(p.result)) {
    const result = read(p.result);
    if (result.id !== s.id || !terminal.has(result.phase)
        || !Number.isInteger(result.exit_code) || typeof result.accepted !== 'boolean' || typeof result.cleanup_verified !== 'boolean'
        || result.accepted !== (result.phase === 'completed')
        || (result.accepted && (result.exit_code !== 0 || !result.cleanup_verified || !s.ready_at || !uuid.test(s.lock?.token || '')))
        || result.pid !== s.pid) throw new Error('Background final result identity or completion mismatch.');
    return project(s, { ...result, session_file: p.file, result_file: p.result, report_file: path.join(p.directory, 'result.txt') });
  }
  const pid = trackedPid(p), live = exists(pid);
  return project(s, { pid, phase: live ? (terminal.has(s.phase) ? 'finalizing' : s.phase) : 'unresolved', process_alive: live, ownership_verified: false,
    diagnostic: live ? null : 'No final receipt and no live recorded leader; inspect owned lock and descendants before resuming.',
    session_file: p.file, result_file: p.result, report_file: path.join(p.directory, 'result.txt') });
}

export function latestBackground(stateDir, root) {
  root = fs.realpathSync(root); stateDir = contained(root, path.resolve(root, stateDir));
  const directory = contained(root, path.join(stateDir, 'background'));
  if (!fs.existsSync(directory)) return null;
  const sessions = fs.readdirSync(directory).filter(name => uuid.test(name)).map(name => {
    const file = contained(root, path.join(directory, name, 'session.json'));
    const p = paths(file);
    return { file, created: p.session.created_at, active: !fs.existsSync(p.result) && exists(trackedPid(p)), ready: Boolean(p.session.ready_at) };
  });
  sessions.sort((a, b) => Number(b.active) - Number(a.active) || String(b.created).localeCompare(String(a.created)) || Number(b.ready) - Number(a.ready));
  return sessions[0]?.file || null;
}

export function backgroundLogs(sessionFile, { tailLines = 100 } = {}) {
  if (!Number.isInteger(tailLines) || tailLines < 1 || tailLines > 10000) throw new Error('Log tail must be between 1 and 10000 lines.');
  const p = paths(sessionFile), logFile = contained(p.session.root, path.join(p.directory, 'raw.log'));
  const text = fs.existsSync(logFile) ? privateBytes(logFile).toString('utf8') : '';
  // Redact before tailing so multiline quotes/credential fragments retain context.
  return publicProjection(text, [p.session.owner, p.session.lock?.token]).split('\n').slice(-tailLines).join('\n');
}

function validateBinding(identity) {
  if (!identity || typeof identity.plan_id !== 'string' || !Array.isArray(identity.selected)) throw new Error('Background plan identity required.');
  for (const item of identity.binding_files || []) {
    if (!item || typeof item.file !== 'string' || !path.isAbsolute(item.file) || !hashPattern.test(item.sha256 || '')) throw new Error('Malformed background source/runtime binding.');
    if (digest(regular(item.file)) !== item.sha256) throw new Error(`Background source/runtime binding changed: ${item.file}`);
  }
}

export async function launchBackground({ root, stateDir, moduleFile, args = {}, identity, readinessMs = 5000 }) {
  root = fs.realpathSync(root);
  stateDir = contained(root, path.resolve(root, stateDir));
  if (!stateDir.startsWith(path.join(root, '.codex-plan-runner') + path.sep)) throw new Error('Background state must be under runner state.');
  moduleFile = contained(root, path.resolve(root, moduleFile)); regular(moduleFile);
  validateBinding(identity);
  if (!Number.isFinite(readinessMs) || readinessMs <= 0) throw new Error('Readiness deadline must be positive.');
  const id = randomUUID(), owner = randomUUID(), directory = path.join(stateDir, 'background', id);
  contained(root, directory);
  const sessionFile = path.join(directory, 'session.json');
  const session = { schema_version: 1, id, owner, root, identity, module_file: moduleFile, module_sha256: digest(moduleFile),
    args, phase: 'starting', pid: null, created_at: new Date().toISOString() };
  publishBackgroundSession({ root, stateDir, planId: identity.plan_id }, () => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomic(sessionFile, session);
  });
  const output = fs.openSync(path.join(directory, 'raw.log'), 'wx', 0o600);
  const child = spawn(process.execPath, [path.join(ownDirectory, 'background-child.mjs'), sessionFile],
    { cwd: root, env: process.env, detached: true, stdio: ['ignore', output, output] });
  fs.closeSync(output);
  try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
  catch (error) {
    session.phase = 'failed'; session.finished_at = new Date().toISOString(); atomic(sessionFile, session);
    writeFinal(directory, session, { phase: 'failed', exit_code: 1, accepted: false, cleanup_verified: true, diagnostic: error.message });
    return { launched: false, ...inspectBackground(sessionFile) };
  }
  // Persist the actual spawn handle before acknowledgment, even if importing
  // the child takes longer than the startup deadline. Never signal this PID.
  atomic(path.join(directory, 'spawn.json'), { schema_version: 1, id, owner, pid: child.pid });
  // Launcher never writes the session again. Child owns readiness and finality.
  child.unref();
  const until = Date.now() + readinessMs;
  while (Date.now() < until) {
    const current = read(sessionFile);
    if (fs.existsSync(path.join(directory, 'result.json'))) { const result = inspectBackground(sessionFile); return { launched: Boolean(current.ready_at), ...result }; }
    if (current.ready_at) return { launched: true, ...inspectBackground(sessionFile) };
    await delay(25);
  }
  const observation = { ...inspectBackground(sessionFile), launched: false,
    diagnostic: 'Readiness was not confirmed; session is retained. Inspect or stop its owned controller before another launch.' };
  atomic(path.join(directory, 'startup-observation.json'), observation);
  return observation;
}

async function challenge(sessionFile, action, timeoutMs) {
  let p = paths(sessionFile); const id = randomUUID(), claimDeadline = Date.now() + timeoutMs;
  // An acknowledged spawn can precede the child's claim. Wait boundedly for
  // that claim instead of confusing slow import with an absent process.
  while (p.session.pid === null && exists(trackedPid(p)) && Date.now() < claimDeadline) { await delay(25); p = paths(sessionFile); }
  if (terminal.has(p.session.phase) || fs.existsSync(p.result)) return inspectBackground(sessionFile);
  if (!exists(p.session.pid)) throw new Error('Background leader is absent or has not claimed ownership; refusing unknown cleanup.');
  atomic(p.control, { schema_version: 1, id: p.session.id, owner: p.session.owner, challenge: id, action });
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fs.existsSync(p.result)) return inspectBackground(sessionFile);
    if (fs.existsSync(p.response)) {
      const response = read(p.response);
      if (response.id === p.session.id && response.owner === p.session.owner && response.challenge === id
          && response.pid === p.session.pid && response.action === action) return publicProjection(response, [p.session.owner]);
    }
    if (!exists(p.session.pid)) throw new Error('Background leader vanished before ownership was verified.');
    await delay(25);
  }
  throw new Error('Background process did not answer fresh ownership challenge; no signal was sent.');
}

export async function stopBackground(sessionFile, { timeoutMs = 10000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Stop deadline must be positive.');
  const finished = async result => {
    if (!result.cleanup_verified) throw new Error('Final result has unresolved cleanup; inspect owned resources.');
    const deadline = Date.now() + timeoutMs;
    while (exists(result.pid) && Date.now() < deadline) await delay(25);
    if (exists(result.pid)) throw new Error('Final cleanup is recorded but leader exit remains unverified.');
    return { ...result, leader_exit_verified: true };
  };
  const response = await challenge(sessionFile, 'stop', Math.min(timeoutMs, 1500));
  if (terminal.has(response.phase)) return finished(response);
  // A challenged controller aborts itself. No saved PID ever authorizes kill.
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const current = inspectBackground(sessionFile);
    if (terminal.has(current.phase)) return finished(current);
    if (!current.process_alive) throw new Error('Stopped leader has no final cleanup receipt; inspect owned descendants.');
    await delay(25);
  }
  throw new Error('Owned runner has not confirmed final cleanup; stop remains pending.');
}

function writeFinal(directory, session, fields) {
  const final = project(session, { pid: session.pid, ...fields, finished_at: new Date().toISOString() });
  atomic(path.join(directory, 'result.txt'), [
    `Plan ${final.identity?.plan_id || 'unknown'}; session ${final.id}: ${final.phase}.`,
    `Selected packages: ${(final.identity?.selected || []).join(', ') || 'none'}.`,
    `Accepted: ${final.accepted}; exit: ${final.exit_code}; cleanup verified: ${final.cleanup_verified}.`,
    final.diagnostic || '', JSON.stringify(final.summary || {}, null, 2),
    `JSON result: ${path.join(directory, 'result.json')}`, ''
  ].filter(Boolean).join('\n') + '\n');
  session.phase = final.phase; session.finished_at = final.finished_at;
  atomic(path.join(directory, 'session.json'), session);
  // Result is the final commit marker; no later session/report writes race readers.
  atomic(path.join(directory, 'result.json'), final);
  return final;
}

export async function runBackgroundChild(sessionFile) {
  const p = paths(sessionFile), s = p.session;
  if (s.phase !== 'starting' || s.pid !== null || fs.existsSync(p.result)) throw new Error('Background session already claimed.');
  const claim = contained(s.root, path.join(p.directory, 'claim.json'));
  fs.writeFileSync(claim, JSON.stringify({ id: s.id, owner: s.owner, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  const controller = new AbortController();
  let requestId, ready = false, stopped = false, controlError, wake, wakeError, wakeStartupCleanup = true;
  s.pid = process.pid; s.process_identity = backgroundProcessIdentity(process.pid); s.phase = 'starting'; atomic(p.file, s);
  const stop = () => { stopped = true; controller.abort(); };
  const ignoreHup = () => {};
  process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('SIGHUP', ignoreHup);
  const poll = setInterval(() => {
    try {
      if (!fs.existsSync(p.control)) return;
      contained(s.root, p.control); const request = read(p.control);
      if (request.id !== s.id || request.owner !== s.owner || !uuid.test(request.challenge || '')
          || !['ping', 'stop'].includes(request.action) || request.challenge === requestId) return;
      requestId = request.challenge;
      atomic(p.response, { id: s.id, owner: s.owner, challenge: requestId, action: request.action, pid: process.pid, phase: s.phase });
      if (request.action === 'stop') { s.phase = 'stopping'; atomic(p.file, s); stop(); }
    } catch (error) { controlError = error; stop(); }
  }, 25);
  let code = 1, accepted = false, cleanupVerified = false, summary = {}, error;
  try {
    if (digest(contained(s.root, s.module_file)) !== s.module_sha256) throw new Error('Reviewed background entry changed.');
    validateBinding(s.identity);
    const module = await import(pathToFileURL(s.module_file).href);
    const result = await module.run({ args: s.args, signal: controller.signal, identity: s.identity, sessionDirectory: p.directory,
      ownSession: { file: p.file, id: s.id, owner: s.owner, pid: process.pid },
      ready: async lock => {
        if (ready || controller.signal.aborted) throw new Error('Background readiness is repeated or cancelled.');
        const file = contained(s.root, path.resolve(s.root, lock.file));
        const actual = read(file);
        if (actual.pid !== process.pid || actual.token !== lock.token || !uuid.test(lock.token || '')) throw new Error('Background readiness requires the owned plan lock.');
        ready = true; s.lock = { file, token: lock.token };
        // Journal ownership before spawning an inhibitor; never use a saved PID
        // to clean up a lease from an earlier process.
        try {
          wake = await startOwnedWake({ root: s.root, journalFile: path.join(p.directory, 'wake.json'), onUnexpectedExit: event => {
            wakeError = new Error(event.diagnostic || 'Owned idle-sleep helper became unavailable.');
            s.wake = { ...s.wake, phase: event.phase, cleanup_verified: event.cleanup_verified, unexpected_exit: true };
            controller.abort();
            try { atomic(p.file, s); } catch (caught) { controlError = caught; }
          } });
        } catch (caught) {
          wakeStartupCleanup = caught.cleanup_verified === true;
          if (caught.wake_record) s.wake = { journal_file: caught.journal_file, id: caught.wake_record.id,
            platform: caught.wake_record.platform, phase: caught.wake_record.phase, cleanup_verified: caught.cleanup_verified === true,
            pid: caught.wake_record.pid, diagnostic: caught.wake_record.diagnostic };
          throw caught;
        }
        s.wake = { journal_file: path.join(p.directory, 'wake.json'), id: wake.record.id, platform: wake.record.platform, phase: wake.record.phase };
        if (controller.signal.aborted) throw new Error('Background startup was stopped before readiness.');
        s.phase = 'running'; s.ready_at = new Date().toISOString(); atomic(p.file, s);
      } });
    if (!Number.isInteger(result?.code) || typeof result?.accepted !== 'boolean') throw new Error('Background runner returned no explicit completion status.');
    code = result.code; accepted = result.accepted; summary = result.summary || {}; error = result.diagnostic || null;
    if (accepted && (code !== 0 || !ready)) throw new Error('Completion requires ready ownership, accepted criteria and zero exit.');
    if (s.lock && fs.existsSync(s.lock.file)) {
      const remaining = read(s.lock.file);
      if (!Number.isSafeInteger(remaining.pid) || remaining.pid < 1 || !uuid.test(remaining.token || '')
          || remaining.pid === process.pid || remaining.token === s.lock.token) throw new Error('Runner returned before releasing its owned plan lock, or remaining lock ownership is malformed.');
    }
    cleanupVerified = result.cleanup_verified === true && wakeStartupCleanup;
    if (!cleanupVerified) throw new Error('Runner did not verify resource cleanup.');
    if (controlError) throw controlError;
    if (wakeError) throw wakeError;
  } catch (caught) { error = caught.message; code = 1; accepted = false; }
  finally {
    if (wake) try {
      const ended = await wake.stop(); s.wake.phase = ended.phase; s.wake.cleanup_verified = ended.cleanup_verified;
      cleanupVerified = cleanupVerified && ended.cleanup_verified === true;
      if (ended.unexpected_exit) {
        accepted = false; code = 1;
        error = error || ended.diagnostic || 'Owned idle-sleep helper became unavailable.';
      }
    }
    catch (caught) { cleanupVerified = false; accepted = false; code = 1; error = `${error ? error + '; ' : ''}${caught.message}`; }
    clearInterval(poll); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); process.removeListener('SIGHUP', ignoreHup);
  }
  const manualBoundary = code === 2 && !error && Array.isArray(summary.packages)
    && summary.packages.some(item => item.manual && item.status !== 'completed');
  const phase = stopped ? 'interrupted' : accepted ? 'completed' : code === 0 || manualBoundary ? 'incomplete' : 'failed';
  const final = writeFinal(p.directory, s, { phase, exit_code: code, accepted: !stopped && accepted, cleanup_verified: cleanupVerified, summary, diagnostic: error || null });
  return code;
}
