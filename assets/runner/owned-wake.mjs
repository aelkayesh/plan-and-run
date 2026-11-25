import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { backgroundProcessIdentity } from './background-ownership.mjs';

// A lease belongs to this live controller. Signals use only its ChildProcess.
const HELPER = '/usr/bin/caffeinate';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const copy = value => structuredClone(value);
const failure = (message, code) => Object.assign(new Error(message), { code });

function safePath(root, file) {
  file = path.resolve(root, file);
  if (!file.startsWith(path.join(root, '.codex-plan-runner') + path.sep)) throw failure('Wake journal must be within runner state.', 'WAKE_PATH');
  const directories = [];
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw failure('Wake journal symlink is forbidden.', 'WAKE_PATH');
    if (current !== file && stat) {
      if (!stat.isDirectory()) throw failure('Wake journal parent is not a directory.', 'WAKE_PATH');
      directories.push({ file: current, inode: stat.ino, device: stat.dev });
    }
  }
  return { file, directories };
}

function journalWriter(root, file, identity) {
  const baseline = safePath(root, file).directories;
  let previous, publishedIdentity;
  const parents = () => {
    const current = safePath(root, file).directories;
    if (JSON.stringify(current) !== JSON.stringify(baseline)) throw failure('Wake journal directory ownership changed.', 'WAKE_JOURNAL');
  };
  const verify = () => {
    parents();
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw failure('Wake journal is missing or is not a private unlinked regular file.', 'WAKE_JOURNAL');
    if (stat.ino !== publishedIdentity?.inode || stat.dev !== publishedIdentity?.device) throw failure('Wake journal file ownership changed.', 'WAKE_JOURNAL');
    const bytes = fs.readFileSync(file, 'utf8');
    const saved = JSON.parse(bytes);
    if (bytes !== previous || saved.id !== identity.id || saved.owner_pid !== identity.owner_pid || saved.kind !== identity.kind) throw failure('Wake journal lease ownership/content changed.', 'WAKE_JOURNAL');
  };
  return value => {
    if (previous === undefined) parents(); else verify();
    const bytes = JSON.stringify(value, null, 2) + '\n';
    const temporary = file + '.' + randomUUID() + '.tmp';
    let inode, device;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        const stat = fs.fstatSync(fd); inode = stat.ino; device = stat.dev;
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      if (previous === undefined) {
        parents();
        // Exclusive publication: an existing lease can never be replaced.
        fs.linkSync(temporary, file);
      } else {
        verify();
        fs.renameSync(temporary, file);
      }
      previous = bytes;
      publishedIdentity = { inode, device };
    } finally {
      // Never follow changed ancestry or delete an unknown replacement file.
      try {
        parents();
        const stat = fs.lstatSync(temporary, { throwIfNoEntry: false });
        if (stat?.isFile() && stat.ino === inode && stat.dev === device) fs.unlinkSync(temporary);
      } catch { /* Retain an uncertain temporary artifact for inspection. */ }
    }
  };
}

async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
  finally { clearTimeout(timer); }
}

export async function startOwnedWake({ root, journalFile, enabled = process.platform === 'darwin', onUnexpectedExit = () => {} }) {
  if (typeof enabled !== 'boolean' || typeof onUnexpectedExit !== 'function') throw new TypeError('Wake enabled and loss observer must have explicit boolean/function types.');
  root = fs.realpathSync(root); journalFile = safePath(root, journalFile).file;
  if (enabled && process.platform !== 'darwin') throw new Error('Native idle-sleep inhibition is available here only on macOS.');
  fs.mkdirSync(path.dirname(journalFile), { recursive: true, mode: 0o700 });
  const record = { schema_version: 1, kind: 'background-wake', id: randomUUID(), owner_pid: process.pid,
    platform: process.platform, helper: HELPER, args: ['-i', '-w', String(process.pid)], phase: enabled ? 'planned' : 'disabled',
    pid: null, created_at: new Date().toISOString(), cleanup_verified: !enabled };
  const publish = journalWriter(root, journalFile, record);
  try { publish(record); }
  catch (error) { if (error.code === 'EEXIST') throw failure('Preserve the prior wake journal; each lease needs a new path.', 'WAKE_JOURNAL'); throw error; }
  let resolveLost;
  const lost = new Promise(resolve => { resolveLost = resolve; });
  if (!enabled) return { get record() { return copy(record); }, lost, stop: async () => copy(record) };

  let child, closeOutcome, closeResolve, spawned = false, stopping = false, returned = false, unexpected = false, stopPromise;
  let lossNotified = false, lossTask, signalError;
  const closed = new Promise(resolve => { closeResolve = resolve; });
  const attach = error => Object.assign(error, { wake_record: copy(record), journal_file: journalFile, cleanup_verified: record.cleanup_verified === true });
  const saveOrRecordError = () => {
    try { publish(record); return null; }
    catch (error) { record.journal_error = error.message; return error; }
  };
  const verifyAbsence = async () => {
    if (!Number.isSafeInteger(record.pid) || record.pid < 1) {
      if (!spawned) return;
      throw failure('Owned wake helper PID is unavailable.', 'WAKE_UNRESOLVED');
    }
    const until = Date.now() + 300;
    while (true) {
      try { process.kill(record.pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') return;
        if (error.code !== 'EPERM') throw error;
      }
      if (Date.now() >= until) throw failure('Owned wake PID absence is unverified; no recovered PID was signaled.', 'WAKE_UNRESOLVED');
      await sleep(25);
    }
  };
  const signalOwnChild = signal => {
    if (closeOutcome || !child || !spawned) return;
    try { if (!child.kill(signal)) signalError = failure('Owned wake signal was not delivered: ' + signal, 'WAKE_SIGNAL'); }
    catch (error) { signalError = error; }
  };
  const settleOwned = async () => {
    stopping = true;
    if (!child && !spawned) { record.cleanup_verified = true; return; }
    if (!closeOutcome) {
      signalOwnChild('SIGTERM');
      if (!await bounded(closed, 1000)) {
        signalOwnChild('SIGKILL');
        if (!await bounded(closed, 1000)) throw failure('Owned wake helper exit was not confirmed.' + (signalError ? ' ' + signalError.message : ''), 'WAKE_UNRESOLVED');
      }
    }
    await verifyAbsence();
    record.cleanup_verified = true;
    record.exit = { code: closeOutcome?.code ?? null, signal: closeOutcome?.signal ?? null };
  };
  const notifyLoss = async () => {
    if (lossNotified) return;
    lossNotified = true;
    record.phase = 'failed'; record.unexpected_exit = true;
    record.diagnostic = 'Owned wake helper exited while its owner remained active.';
    try { await verifyAbsence(); record.cleanup_verified = true; }
    catch (error) { record.phase = 'unresolved'; record.cleanup_verified = false; record.diagnostic += ' ' + error.message; }
    record.exit = { code: closeOutcome?.code ?? null, signal: closeOutcome?.signal ?? null };
    const saveError = saveOrRecordError();
    if (saveError) record.phase = 'unresolved';
    const event = copy(record); resolveLost(event);
    // An observer cannot delay owned-resource cleanup or create an unhandled rejection.
    Promise.resolve().then(() => onUnexpectedExit(event)).catch(error => {
      record.observer_error = error.message; saveOrRecordError();
    });
  };
  try {
    child = childProcess.spawn(HELPER, record.args, { stdio: 'ignore' });
    const started = new Promise((resolve, reject) => {
      child.once('spawn', () => { spawned = true; resolve(); });
      child.on('error', error => {
        signalError = error;
        if (!spawned) { closeOutcome = { error }; closeResolve(closeOutcome); reject(error); }
      });
    });
    child.once('close', (code, signal) => {
      closeOutcome = { code, signal }; closeResolve(closeOutcome);
      if (!stopping) {
        unexpected = true;
        if (returned) lossTask = notifyLoss();
      }
    });
    await started;
    child.unref(); // -w observes owner exit; the helper cannot keep its owner alive.
    record.pid = child.pid;
    // A missing OS identity never authorizes later PID-based cleanup. The live
    // ChildProcess still owns this lease; admission will conservatively refuse
    // a live historical PID if its birth identity could not be observed.
    try { record.process_identity = backgroundProcessIdentity(child.pid); } catch { record.process_identity = null; }
    record.phase = 'starting'; publish(record);
    const exitedDuringStartup = await bounded(closed, 50);
    if (exitedDuringStartup || closeOutcome) throw failure('Owned wake helper exited during startup.', 'WAKE_STARTUP');
    // Live-child liveness only; recovered PIDs are never used to send signals.
    process.kill(record.pid, 0);
    record.phase = 'running'; record.ready_at = new Date().toISOString(); publish(record);
    returned = true;
  } catch (error) {
    // Retain the live handle even when publishing its PID failed.
    if (spawned && record.pid === null) record.pid = child.pid;
    let cleanupError;
    try { await settleOwned(); }
    catch (caught) { cleanupError = caught; record.cleanup_verified = false; }
    record.phase = cleanupError ? 'unresolved' : 'failed';
    record.diagnostic = error.message + (cleanupError ? ' Cleanup: ' + cleanupError.message : '');
    saveOrRecordError();
    throw attach(failure(record.diagnostic, cleanupError ? 'WAKE_UNRESOLVED' : error.code || 'WAKE_STARTUP'));
  }
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      if (lossTask) await lossTask;
      record.phase = 'stopping';
      const firstSaveError = saveOrRecordError();
      try { await settleOwned(); }
      catch (error) {
        record.phase = 'unresolved'; record.cleanup_verified = false; record.diagnostic = error.message;
        saveOrRecordError(); throw attach(error);
      }
      record.phase = unexpected ? 'failed' : 'stopped';
      record.stopped_at = new Date().toISOString();
      const finalSaveError = saveOrRecordError();
      if (firstSaveError || finalSaveError) {
        record.phase = 'unresolved';
        throw attach(failure('Wake cleanup completed but its journal could not be safely updated: ' + (finalSaveError || firstSaveError).message, 'WAKE_JOURNAL'));
      }
      return copy(record);
    })();
    // Successful stops are idempotent; uncertain cleanup can be retried safely.
    stopPromise.catch(() => { stopPromise = undefined; });
    return stopPromise;
  };
  return { get record() { return copy(record); }, lost, stop };
}
