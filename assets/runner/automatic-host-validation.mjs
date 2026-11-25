import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { statePath, isolatedEnvironment } from './host-validation.mjs';

const HELPER = fileURLToPath(new URL('./host-validation-helper.mjs', import.meta.url));
const RECIPES = new Set(['npm-checks']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function writeHostJournal(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

async function verifyHelperIdentity(journal, journalFile) {
  const expected = journal.process;
  if (!Number.isInteger(expected.pid) || expected.pid < 1 || expected.pid !== expected.pgid || expected.helper !== HELPER || expected.id !== journal.id) {
    throw new Error('Host process identity changed; refusing to signal an unrelated process.');
  }
  try { process.kill(expected.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  const challenge = randomUUID();
  const request = journalFile.replace('-journal.json', '-control-request.json');
  const response = journalFile.replace('-journal.json', '-control-response.json');
  writeHostJournal(request, { id: journal.id, challenge });
  for (let index = 0; index < 60; index++) {
    try {
      const reply = JSON.parse(fs.readFileSync(response, 'utf8'));
      if (reply.id === journal.id && reply.challenge === challenge && reply.pid === expected.pid) return true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { process.kill(expected.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    await sleep(25);
  }
  throw new Error('Host process did not answer its ownership challenge; refusing to signal an unknown process.');
}

async function groupExists(pid) {
  // Darwin can report EPERM while a terminated group contains only zombies.
  // Re-probe without signalling: only ESRCH proves absence. A persistent
  // permission error or a still-live orphan group remains a hard stop.
  const deadline = Date.now() + 1000;
  while (true) {
    try { process.kill(-pid, 0); return true; }
    catch (error) {
      if (error.code === 'ESRCH') return false;
      if (error.code !== 'EPERM' || Date.now() >= deadline) throw error;
    }
    await sleep(25);
  }
}

async function signalExitedHelperGroup(pid) {
  if (!await groupExists(pid)) return;
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    if (error.code !== 'EPERM') throw error;
    // A terminated group can become unsignalable while Darwin reaps its last
    // members. Permission denial is not absence: require a later ESRCH probe.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (!await groupExists(pid)) return;
      await sleep(25);
    }
    throw error;
  }
  for (let index = 0; index < 40 && await groupExists(pid); index++) await sleep(25);
  if (await groupExists(pid)) throw new Error('Owned host process group remains after helper exit.');
}

async function stopOwnedProcess(journal, journalFile) {
  if (!journal.process) return;
  const expected = journal.process;
  if (!await verifyHelperIdentity(journal, journalFile)) {
    if (await groupExists(expected.pgid)) throw new Error('Orphan host process group has no verifiable leader; inspect it before resuming.');
    return;
  }
  try { process.kill(-expected.pgid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await sleep(150);
  try { process.kill(-expected.pgid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (let index = 0; index < 40 && await groupExists(expected.pgid); index++) await sleep(25);
  if (await groupExists(expected.pgid)) throw new Error('Owned host process group remains after cancellation.');
}

function validateJournal(root, file) {
  file = statePath(root, file, { existing: true });
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (journal.schema_version !== 1 || journal.kind !== 'automatic-host-validation' || journal.root !== root
      || !UUID.test(journal.id || '') || !RECIPES.has(journal.recipe_id)
      || !/^\d{2}$/.test(journal.package_id) || !/^[a-f0-9]{64}$/.test(journal.plan_hash || '')
      || path.basename(file) !== `host-${journal.id}-journal.json`
      || journal.data_directory !== path.join(path.dirname(file), `data-${journal.id}`)) {
    throw new Error('Invalid automatic host ownership journal.');
  }
  return { file, journal };
}

function cleanData(journal) {
  const directory = journal.data_directory;
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return;
  const marker = path.join(directory, '.owner.json');
  const markerStat = stat.isDirectory() && !stat.isSymbolicLink() ? fs.lstatSync(marker, { throwIfNoEntry: false }) : null;
  let owner;
  if (markerStat?.isFile() && !markerStat.isSymbolicLink()) {
    try { owner = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { /* An unreadable marker is not ownership proof. */ }
  }
  if (!journal.data || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== journal.data.device || stat.ino !== journal.data.inode
      || journal.data.directory !== directory || journal.data.id !== journal.id
      || owner?.id !== journal.id) {
    throw new Error('Host data directory ownership is unknown; refusing to remove it.');
  }
  fs.rmSync(directory, { recursive: true });
  if (fs.existsSync(directory)) throw new Error('Owned host data directory remains after cleanup.');
}

/** Reconcile before retrying. Completed evidence is returned without executing
 * checks again. Unknown process or directory identity fails closed. */
export async function reconcileAutomaticHostValidation({ root, journalFile, packageId, planHash, recipeId, onJournal = () => {} }) {
  root = fs.realpathSync(root);
  const { file, journal } = validateJournal(root, journalFile);
  if ((packageId !== undefined && journal.package_id !== packageId) || (planHash !== undefined && journal.plan_hash !== planHash)
      || (recipeId !== undefined && journal.recipe_id !== recipeId)) throw new Error('Host journal does not match the expected package, plan or recipe.');
  if (!['completed', 'failed', 'interrupted'].includes(journal.phase)) await stopOwnedProcess(journal, file);
  cleanData(journal);
  journal.cleanup_verified = true;
  if (journal.evidence_file && fs.existsSync(statePath(root, journal.evidence_file))) {
    const evidenceFile = statePath(root, journal.evidence_file, { existing: true });
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    if (evidence.automatic?.id !== journal.id || evidence.automatic?.recipe_id !== journal.recipe_id
        || evidence.recipe_id !== journal.recipe_id || evidence.root !== root || evidence.package_id !== journal.package_id
        || evidence.plan_hash !== journal.plan_hash || evidence.schema_version !== 1 || evidence.kind !== 'codex-plan-host-validation'
        || typeof evidence.passed !== 'boolean' || path.dirname(evidenceFile) !== path.dirname(file)
        || !evidenceFile.endsWith('-host-validation.json')) throw new Error('Host evidence ownership or identity differs from journal.');
    if (['completed', 'failed'].includes(journal.phase) && evidence.automatic.cleanup_verified !== true) {
      throw new Error('Finished host evidence has inconsistent cleanup state.');
    }
    evidence.automatic.cleanup_verified = true;
    // Finalize cleanup once. Keep finished evidence stable across restarts.
    if (journal.phase !== 'completed' && journal.phase !== 'failed') writeHostJournal(evidenceFile, evidence);
    journal.phase = evidence.passed ? 'completed' : 'failed';
    writeHostJournal(file, journal); await onJournal({ journalFile: file, ...journal });
    return { file: evidenceFile, evidence, summary: `Automatic host recipe ${journal.recipe_id}: ${evidence.passed ? 'passed' : 'failed'}.`, journalFile: file };
  }
  journal.phase = journal.phase === 'helper_failed' ? 'failed' : 'interrupted';
  journal.diagnostic ||= 'Host phase interrupted before producing complete evidence; owned resources reconciled.';
  writeHostJournal(file, journal); await onJournal({ journalFile: file, ...journal });
  return { file: null, evidence: null, journalFile: file, interrupted: journal.phase === 'interrupted', failed: journal.phase === 'failed',
    timedOut: journal.interruption_reason === 'timeout', cancelled: journal.interruption_reason === 'signal', diagnostic: journal.diagnostic, cleanup_verified: true };
}

export async function runAutomaticHostValidation({ root, packageId, planHash, outputDir, mutablePaths = [], recipeId, signal, onJournal = () => {}, timeoutMs = 65 * 60 * 1000 }) {
  root = fs.realpathSync(root);
  if (!RECIPES.has(recipeId) || typeof packageId !== 'string' || !/^\d{2}$/.test(packageId)
      || typeof planHash !== 'string' || !/^[a-f0-9]{64}$/.test(planHash)) throw new Error('Unknown or unauthorized automatic host recipe.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Automatic host timeout must be positive.');
  if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function')) throw new Error('Automatic host cancellation requires an AbortSignal.');
  outputDir = statePath(root, outputDir);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const journalFile = statePath(root, path.join(outputDir, `host-${id}-journal.json`));
  const journal = { schema_version: 1, kind: 'automatic-host-validation', id, root, package_id: packageId,
    plan_hash: planHash, recipe_id: recipeId, phase: 'planned', mutable_paths: mutablePaths,
    data_directory: path.join(outputDir, `data-${id}`), created_at: new Date().toISOString(), process: null };
  writeHostJournal(journalFile, journal);
  // This event must be durable in runner state before even the gated helper is spawned.
  await onJournal({ journalFile, ...journal });
  if (signal?.aborted) { journal.interruption_reason = 'signal'; writeHostJournal(journalFile, journal); return reconcileAutomaticHostValidation({ root, journalFile, onJournal }); }
  // Persist directory ownership before a cancellable helper can mutate it.
  // A hard crash during these synchronous journal writes stays fail-closed.
  fs.mkdirSync(journal.data_directory, { mode: 0o700 });
  fs.writeFileSync(path.join(journal.data_directory, '.owner.json'), JSON.stringify({ id }), { flag: 'wx', mode: 0o600 });
  const dataStat = fs.lstatSync(journal.data_directory);
  journal.data = { directory: journal.data_directory, id, device: dataStat.dev, inode: dataStat.ino };
  writeHostJournal(journalFile, journal);
  const log = fs.openSync(path.join(outputDir, `host-${id}-helper.log`), 'wx', 0o600);
  const child = spawn(process.execPath, [HELPER, journalFile, id], {
    cwd: root, env: { ...isolatedEnvironment('<host-helper>'), PATH: process.env.PATH }, detached: true, shell: false,
    stdio: ['ignore', log, log, 'ipc'],
  });
  fs.closeSync(log);
  const ended = new Promise(resolve => { child.once('error', error => resolve({ error })); child.once('close', (code, childSignal) => resolve({ code, signal: childSignal })); });
  let cancellation, signalFailure, forceTimer;
  const signalGroup = childSignal => {
    if (!Number.isInteger(child.pid) || child.pid < 1) return;
    try { process.kill(-child.pid, childSignal); }
    catch (error) { if (error.code !== 'ESRCH') signalFailure ||= error; }
  };
  const abort = reason => {
    cancellation ||= reason;
    signalGroup('SIGTERM');
    forceTimer ||= setTimeout(() => signalGroup('SIGKILL'), 200);
  };
  const onAbort = () => abort('signal');
  const timer = setTimeout(() => abort('timeout'), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  child.once('spawn', () => {
    try {
      journal.process = { pid: child.pid, pgid: child.pid, helper: HELPER, id };
      if (!Number.isInteger(child.pid)) throw new Error('Host helper process group identity unavailable.');
      journal.phase = 'running'; writeHostJournal(journalFile, journal);
      Promise.resolve().then(() => onJournal({ journalFile, ...journal })).then(() => {
        if (!cancellation && child.connected) child.send({ start: true }, error => { if (error) abort('ipc-error'); });
      }).catch(() => abort('journal-error'));
    } catch { abort('identity-error'); }
  });
  // An abort between the pre-spawn check and listener registration must still
  // cancel the gated helper before it is allowed to execute a command.
  if (signal?.aborted) onAbort();
  const result = await ended;
  clearTimeout(timer); clearTimeout(forceTimer);
  signal?.removeEventListener('abort', onAbort);
  // No descendants may survive a host helper. Its still-owned group is killed
  // immediately after exit, before any chance of restarting another helper.
  if (child.pid) await signalExitedHelperGroup(child.pid);
  const saved = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  if (cancellation || result.error || result.code !== 0) {
    saved.interruption_reason = cancellation || null;
    saved.diagnostic = cancellation ? `Host helper cancelled (${cancellation}).` : saved.diagnostic || `Host helper failed (${result.error?.code || result.signal || result.code}).`;
    writeHostJournal(journalFile, saved);
  }
  // A transient permission failure is resolved only by the verified absence above.
  if (signalFailure && signalFailure.code !== 'EPERM') throw new Error(`Could not stop the owned host process group (${signalFailure.code || 'UNKNOWN'}).`);
  const reconciled = await reconcileAutomaticHostValidation({ root, journalFile, onJournal });
  return reconciled;
}
