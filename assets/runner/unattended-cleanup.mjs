import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { acceptanceForPackage } from './acceptance-policy.mjs';
import { legacyPostgresPreset, localDockerEndpoint } from './acceptance-postgres.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const HOST_EVIDENCE_KIND = 'site-plan-host-validation';
const terminal = new Set(['completed', 'failed', 'interrupted']);
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function require(value, message) {
  if (!value) throw Object.assign(new Error(`Unattended cleanup unverified: ${message}`), { code: 'UNATTENDED_CLEANUP_UNVERIFIED' });
}
function statePath(plan, value) {
  require(typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.split(path.sep).includes('..'), 'invalid journal path');
  const full = path.isAbsolute(value) ? value : path.resolve(plan.root, value);
  require(full.startsWith(plan.stateDir + path.sep), 'journal or data path escapes this plan state');
  let current = plan.root;
  for (const part of path.relative(plan.root, full).split(path.sep)) {
    require(part !== '..', 'journal path traversal'); current = path.join(current, part);
    require(!fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink(), 'journal/data symlink is forbidden');
  }
  return full;
}
function read(plan, file) {
  file = statePath(plan, file);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  require(stat?.isFile() && stat.nlink === 1, `missing or linked ownership journal: ${file}`);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { require(false, `malformed ownership journal: ${file}`); }
  require(value && typeof value === 'object' && !Array.isArray(value), 'journal must be an object');
  return { file, value };
}
function source(value) {
  require(value && HASH.test(value.sha256 || '') && typeof value.head === 'string' && typeof value.branch === 'string'
    && Array.isArray(value.files) && Array.isArray(value.excluded_paths), 'missing source identity in ownership evidence');
  const { sha256, ...inventory } = value;
  require(hash(JSON.stringify(inventory)) === sha256, 'ownership evidence source inventory hash mismatch');
  return sha256;
}
function absent(pid) {
  try { process.kill(pid, 0); require(false, 'recorded process or process group is still present; inspect without signalling a saved PID'); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    if (error.code === 'UNATTENDED_CLEANUP_UNVERIFIED') throw error;
    require(false, `process absence could not be established (${error.code || 'unknown'}); no signal was sent`);
  }
}
function processAbsent(record, journal, helper, historical = false) {
  if (record === null || record === undefined) return;
  require(Number.isSafeInteger(record.pid) && record.pid > 1 && record.pgid === record.pid
    && record.id === journal.id && record.helper === helper, 'saved process ownership identity mismatch');
  // Terminal historical receipts predate this run. Their PIDs may be reused;
  // never convert those saved numbers into claims about current ownership.
  if (!historical) for (const pid of [record.pid, -record.pgid]) absent(pid);
}
function childrenAbsent(journal, historical) {
  if (journal.owned_children === undefined) return;
  require(Array.isArray(journal.owned_children) && journal.gate?.capability === 'loopback-browser', 'owned children exist outside the browser capability');
  const groups = new Set();
  for (const child of journal.owned_children) {
    require(child && ['server', 'browser'].includes(child.kind) && Number.isSafeInteger(child.pid) && child.pid > 1
      && Number.isSafeInteger(child.pgid) && child.pgid > 1 && (!journal.process || child.pgid === journal.process.pgid),
    'owned child process identity is malformed');
    groups.add(child.pgid); if (!historical) absent(child.pid);
  }
  require(groups.size <= 1, 'owned browser children have mismatched helper groups');
  if (!historical) for (const group of groups) absent(-group);
}
function fixtureClean(fixture, cleanup, { kind, packageId, planHash, purpose, historical = false }) {
  if (!fixture) { require(!cleanup, 'cleanup record has no owned fixture'); return; }
  require(fixture.kind === kind && UUID.test(fixture.id || '') && HASH.test(fixture.container_id || '')
    && fixture.container_name === `${kind === 'disposable-postgresql' ? 'tp-access-test-' : 'codex-plan-test-'}${fixture.id.replaceAll('-', '')}`
    && /^sha256:[a-f0-9]{64}$/.test(fixture.image_id || '') && fixture.purpose === purpose,
  'owned PostgreSQL fixture identity is missing or malformed');
  if (kind === 'codex-plan-postgresql') require(fixture.package_id === packageId && fixture.plan_hash === planHash, 'PostgreSQL fixture belongs to another package or plan');
  require(cleanup?.verified_absent === true && cleanup.removed === true && cleanup.container_id === fixture.container_id,
    'owned PostgreSQL fixture lacks matching verified absence evidence');
  if (historical) return;
  let endpoint;
  try { endpoint = localDockerEndpoint(); } catch { require(false, 'local Docker endpoint is unavailable for current fixture absence inspection'); }
  require(typeof fixture.docker_endpoint === 'string' && endpoint === fixture.docker_endpoint, 'current fixture Docker endpoint ownership changed');
  // Fixed read-only inventory only. A failed daemon query is never absence.
  const result = childProcess.spawnSync('docker', ['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${fixture.container_id}`],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  require(!result.error && !result.signal && result.status === 0 && typeof result.stdout === 'string', 'current fixture absence inspection failed; no resources were changed');
  require(result.stdout.trim() === '', 'owned PostgreSQL fixture remains in current Docker inventory');
}
function common(plan, file, journal, packageId, prefix, kind) {
  require(journal.schema_version === 1 && journal.kind === kind && UUID.test(journal.id || '')
    && journal.root === plan.root && journal.package_id === packageId && journal.plan_hash === plan.planHash
    && path.basename(file) === `${prefix}-${journal.id}-journal.json`, 'ownership journal plan/package/schema identity mismatch');
  const tree = path.join(plan.stateDir, prefix === 'acceptance' ? `acceptance/${packageId}` : 'host-checks');
  require(file.startsWith(tree + path.sep), 'ownership journal is outside its package resource tree');
  require(journal.data_directory === path.join(path.dirname(file), `data-${journal.id}`), 'ownership journal data identity mismatch');
  const data = statePath(plan, journal.data_directory);
  require(terminal.has(journal.phase) && journal.cleanup_verified === true, `journal ${path.basename(file)} has no terminal verified cleanup`);
  require(!fs.lstatSync(data, { throwIfNoEntry: false }), 'owned data directory or unknown replacement still exists');
}
function cleanupOwnership(journal) {
  return { schema_version: journal.schema_version, kind: journal.kind, id: journal.id, root: journal.root,
    package_id: journal.package_id, plan_hash: journal.plan_hash, gate: journal.gate, source_sha256: journal.source?.sha256,
    process: journal.process ?? null, owned_children: journal.owned_children ?? [], data_directory: journal.data_directory,
    data: journal.data ?? null, fixture: journal.fixture ?? null, fixture_cleanup: journal.fixture_cleanup ?? null,
    fixture_phase: journal.fixture_phase ?? null, evidence_file: journal.evidence_file ?? null };
}
function gateJournal(plan, ref, packageId, gate, acceptedSource, expectedRecord, historical = false, snapshots = []) {
  const { file, value: journal } = read(plan, ref);
  common(plan, file, journal, packageId, 'acceptance', 'acceptance-gate-journal');
  for (const record of snapshots) {
    const { file: snapshotFile, value: snapshot } = read(plan, record.journal_snapshot_file);
    require(HASH.test(record.journal_snapshot_sha256 || '') && hash(fs.readFileSync(snapshotFile)) === record.journal_snapshot_sha256,
      'cleanup journal snapshot hash changed');
    require(terminal.has(snapshot.phase) && snapshot.cleanup_verified === true
      && same(cleanupOwnership(snapshot), cleanupOwnership(journal)), 'sealed cleanup ownership changed');
  }
  // Accepted prose/evidence without sealed resource identities cannot exempt
  // mutable PID/container fields. Legacy strict records remain read-only and
  // must establish current absence; nothing is adopted or signalled.
  historical = historical && snapshots.length > 0;
  require(same(journal.gate, gate), 'strict journal capability/gate identity mismatch');
  const sourceHash = source(journal.source);
  if (acceptedSource) require(sourceHash === acceptedSource, 'accepted package and cleanup journal source identities differ');
  processAbsent(journal.process, journal, fileURLToPath(new URL('./acceptance-helper.mjs', import.meta.url)), historical);
  childrenAbsent(journal, historical);
  require(!journal.fixture || gate.capability === 'synthetic-postgres', 'fixture exists outside its strict PostgreSQL capability');
  require(journal.fixture_phase === undefined || journal.fixture, 'fixture creation phase lacks a verifiable owned fixture identity');
  fixtureClean(journal.fixture, journal.fixture_cleanup, { kind: 'codex-plan-postgresql', packageId, planHash: plan.planHash,
    purpose: legacyPostgresPreset(gate.preset)?.purpose || `package-${packageId}`, historical });
  require(!expectedRecord?.file || journal.evidence_file, 'recorded strict evidence is absent from cleanup journal');
  if (journal.evidence_file) {
    const { file: evidenceFile, value: evidence } = read(plan, journal.evidence_file);
    if (expectedRecord?.file) require(statePath(plan, expectedRecord.file) === evidenceFile && HASH.test(expectedRecord.sha256 || '') && hash(fs.readFileSync(evidenceFile)) === expectedRecord.sha256, 'recorded strict evidence hash or location mismatch');
    require(path.dirname(file) === path.dirname(evidenceFile) && evidence.schema_version === 1 && evidence.kind === 'codex-plan-acceptance-gate'
      && evidence.id === journal.id && evidence.root === plan.root && evidence.package_id === packageId && evidence.plan_hash === plan.planHash
      && same(evidence.gate, gate) && evidence.cleanup_verified === true && source(evidence.source) === sourceHash,
    'strict journal/evidence cleanup or source identity mismatch');
  }
  return { file: path.relative(plan.root, file), sha256: hash(fs.readFileSync(file)), package_id: packageId, kind: journal.kind };
}

/** Seal identities only after observing current closure. This runs in the
 * owning acceptance lifecycle, never in read-only runtime reconciliation. */
export function sealAcceptanceCleanupJournal(plan, packageId, gate, record) {
  const { file } = read(plan, record.journal_file), bytes = fs.readFileSync(file);
  gateJournal(plan, record.journal_file, packageId, gate, null, record);
  require(fs.readFileSync(file).equals(bytes), 'cleanup journal changed while sealing verified ownership');
  const sha256 = hash(bytes), snapshotFile = path.join(path.dirname(file), `cleanup-${sha256}-snapshot.json`);
  if (fs.existsSync(snapshotFile)) {
    read(plan, snapshotFile);
    require(fs.readFileSync(snapshotFile).equals(bytes), 'existing cleanup snapshot differs');
  } else fs.writeFileSync(snapshotFile, bytes, { flag: 'wx', mode: 0o600 });
  return { journal_snapshot_file: path.relative(plan.root, snapshotFile), journal_snapshot_sha256: sha256 };
}
function hostJournal(plan, pending, packageId, historical = false) {
  const { file, value: journal } = read(plan, pending.journal_file);
  common(plan, file, journal, packageId, 'host', 'automatic-host-validation');
  require(journal.recipe_id === pending.recipe_id && (historical || plan.recoveryPolicy?.value?.packages?.[packageId]?.recipes?.includes(journal.recipe_id)),
    'host cleanup recipe is not the pending reviewed capability');
  const purpose = { 'access-postgres': 'package-02', 'access-policy-postgres': 'package-03' }[journal.recipe_id];
  require(journal.recipe_id === 'npm-checks' || purpose === `package-${packageId}`, 'host cleanup recipe/package mismatch');
  processAbsent(journal.process, journal, fileURLToPath(new URL('./host-validation-helper.mjs', import.meta.url)), historical);
  require(journal.owned_children === undefined, 'legacy host journal contains unknown owned children');
  require(!journal.postgresql?.fixture || purpose, 'PostgreSQL fixture exists outside its host recipe');
  fixtureClean(journal.postgresql?.fixture, journal.postgresql?.cleanup, { kind: 'disposable-postgresql', purpose, historical });
  require(!pending.file || journal.evidence_file, 'pending host evidence is absent from cleanup journal');
  if (journal.evidence_file) {
    const { file: evidenceFile, value: evidence } = read(plan, journal.evidence_file);
    require(path.dirname(file) === path.dirname(evidenceFile) && evidence.schema_version === 1 && evidence.kind === HOST_EVIDENCE_KIND
      && evidence.root === plan.root && evidence.package_id === packageId && evidence.plan_hash === plan.planHash
      && evidence.automatic?.id === journal.id && evidence.automatic?.recipe_id === journal.recipe_id && evidence.automatic?.cleanup_verified === true,
    'host journal/evidence ownership or cleanup mismatch');
    source(evidence.source);
    if (pending.file) require(statePath(plan, pending.file) === evidenceFile && HASH.test(pending.sha256 || '') && hash(fs.readFileSync(evidenceFile)) === pending.sha256,
      'pending host evidence hash or location mismatch');
  }
  return { file: path.relative(plan.root, file), sha256: hash(fs.readFileSync(file)), package_id: packageId, kind: journal.kind };
}

// This is a read-only completion gate, not reconciliation. The running parent
// owns cancellation. A failed/unknown observation preserves its lock and files.
export function verifyUnattendedCleanup(plan, { historicalCompleted = [], historicalStrictJournals } = {}) {
  require(plan && fs.realpathSync(plan.root) === plan.root && HASH.test(plan.planHash || '')
    && plan.stateDir === path.join(plan.root, '.codex-plan-runner', plan.manifest.plan_id), 'cleanup plan identity mismatch');
  const historicalRefs = historicalStrictJournals === undefined ? null : new Set(historicalStrictJournals.map(ref => statePath(plan, ref)));
  const historical = new Set(historicalCompleted), journals = [], seen = new Map(), skipped = [];
  const snapshots = new Map();
  for (const entry of Object.values(plan.state.steps || {})) {
    for (const record of [...(entry.acceptance?.history || []), ...Object.values(entry.acceptance?.gates || {})]) {
      if (!record.journal_snapshot_file) continue;
      const { file, value } = read(plan, record.journal_snapshot_file);
      require(HASH.test(record.journal_snapshot_sha256 || '') && hash(fs.readFileSync(file)) === record.journal_snapshot_sha256,
        'cleanup journal snapshot hash changed');
      const journalFile = record.journal_file ? statePath(plan, record.journal_file)
        : statePath(plan, path.join(path.dirname(file), `acceptance-${value.id}-journal.json`));
      read(plan, journalFile); // A retained snapshot cannot hide a missing live journal.
      const records = snapshots.get(journalFile) || []; records.push(record); snapshots.set(journalFile, records);
    }
  }
  const steps = new Map(plan.manifest.steps.map(step => [step.id, step]));
  const isHistorical = id => historical.has(id) && plan.state.steps[id]?.status === 'completed';
  const gatesFor = id => acceptanceForPackage(plan.acceptanceProfile || { mode: 'legacy', packages: {} }, id)?.required_gates || [];
  const reviewedGate = (id, gateId, ref) => {
    const gate = gatesFor(id).find(item => item.id === gateId);
    if (gate && !isHistorical(id)) return gate;
    if (isHistorical(id)) {
      const saved = read(plan, ref).value.gate;
      require(saved && saved.id === gateId && /^[a-z][a-z0-9-]{0,63}$/.test(saved.id)
        && ['npm-checks', 'production-build', 'synthetic-postgres', 'loopback-browser'].includes(saved.capability),
      'historical strict journal has an unknown capability');
      return saved;
    }
    require(false, 'journal references an unknown strict gate');
  };
  const add = (ref, signature, verify) => {
    const file = statePath(plan, ref);
    if (seen.has(file)) { require(seen.get(file) === signature, 'journal reused across different gates/packages'); return; }
    seen.set(file, signature); journals.push(verify());
  };
  const addGate = (ref, packageId, gateId, expectedRecord, current = false) => {
    const entry = plan.state.steps[packageId], old = isHistorical(packageId) && (historicalRefs === null || historicalRefs.has(statePath(plan, ref)));
    require(steps.has(packageId), 'journal belongs to an unknown package');
    const gate = reviewedGate(packageId, gateId, ref);
    add(ref, `${packageId}:gate:${gateId}`, () => gateJournal(plan, ref, packageId, gate,
      current && !old && entry?.status === 'completed' ? entry.acceptance?.accepted_source_sha256 : null, expectedRecord, old,
      snapshots.get(statePath(plan, ref)) || []));
  };
  const addHost = (pending, packageId) => {
    require(steps.has(packageId), 'host journal belongs to an unknown package');
    add(pending.journal_file, `${packageId}:host:${pending.recipe_id}`, () => hostJournal(plan, pending, packageId, isHistorical(packageId)));
  };
  for (const step of plan.manifest.steps) {
    const entry = plan.state.steps[step.id];
    if (!entry) continue;
    if (isHistorical(step.id)) skipped.push(step.id);
    const acceptance = entry.acceptance;
    for (const [gateId, record] of Object.entries(acceptance?.gates || {})) {
      if (!record?.journal_file) continue;
      require(acceptance.mode === 'strict', 'journal references a non-strict gate');
      addGate(record.journal_file, step.id, gateId, record, true);
    }
    for (const record of acceptance?.history || []) if (record?.journal_file) addGate(record.journal_file, step.id, record.gate_id, record);
    if (acceptance?.timeout_pending) {
      const pending = acceptance.timeout_pending;
      require(typeof pending.journal_file === 'string', 'timeout journal references an unknown strict gate');
      addGate(pending.journal_file, step.id, pending.gate_id);
    }
    const pending = entry.recovery?.pending_evidence;
    if (pending?.journal_file) addHost(pending, step.id);
    for (const record of entry.recovery?.history || []) {
      const ref = record?.journal_file || record?.journal;
      if (!ref) continue;
      const saved = read(plan, ref).value;
      addHost({ journal_file: ref, recipe_id: record.recipe_id || saved.recipe_id }, step.id);
    }
  }
  // Refreshes and interrupted state writes can drop the latest pointer. Inspect
  // the whole owned resource tree, not only records reachable from current state.
  const walk = (directory, prefix) => {
    directory = statePath(plan, directory);
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) return;
    require(stat.isDirectory() && !stat.isSymbolicLink(), 'owned resource tree is not a regular directory');
    for (const name of fs.readdirSync(directory).sort()) {
      const file = statePath(plan, path.join(directory, name)), item = fs.lstatSync(file);
      require(!item.isSymbolicLink(), 'owned resource tree contains a symlink');
      require(!name.startsWith('data-'), 'owned data directory or unknown replacement still exists');
      if (item.isDirectory()) { walk(file, prefix); continue; }
      if (!name.endsWith('-journal.json')) continue;
      require(name.startsWith(prefix + '-'), 'unknown ownership journal in resource tree');
      const saved = read(plan, file).value;
      if (prefix === 'acceptance') addGate(file, saved.package_id, saved.gate?.id);
      else addHost({ journal_file: file, recipe_id: saved.recipe_id }, saved.package_id);
    }
  };
  walk(path.join(plan.stateDir, 'acceptance'), 'acceptance');
  walk(path.join(plan.stateDir, 'host-checks'), 'host');
  return { cleanup_verified: true, journals, skipped_historical: skipped };
}
