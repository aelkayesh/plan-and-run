import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { snapshotSource, snapshotDependencies } from './host-validation.mjs';
import { migrateRecoveryState, protectedArtifacts, snapshotRuntime } from './recovery.mjs';
import { strictPlanArtifacts, runtimeTreeArtifacts, runtimeArtifact } from './runtime-artifacts.mjs';
import { verifyUnattendedCleanup } from './unattended-cleanup.mjs';
import { inspectBackgroundOwnership } from './background-ownership.mjs';

const HASH = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const require = (condition, message) => { if (!condition) throw new Error(`Runtime reconciliation: ${message}`); };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const alive = pid => {
  if (!Number.isInteger(pid) || pid === 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

function repositoryFile(root, relative, { optional = false } = {}) {
  require(typeof relative === 'string' && relative.length > 0, 'missing artifact path');
  const file = path.resolve(root, relative);
  require(file.startsWith(root + path.sep), 'artifact escapes repository');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat && optional) return file;
  require(stat?.isFile() && fs.realpathSync(file).startsWith(root + path.sep), `artifact is missing or is not a regular repository file: ${relative}`);
  return file;
}
function artifact(root, file, optional = false) {
  file = repositoryFile(root, file, { optional });
  return { file: path.relative(root, file), sha256: fs.existsSync(file) ? digest(fs.readFileSync(file)) : null };
}
function privateDirectory(plan) {
  require(fs.realpathSync(plan.stateDir) === plan.stateDir, 'state directory must not be a symlink');
  const directory = path.join(plan.stateDir, 'runtime-upgrades');
  if (fs.existsSync(directory)) require(fs.lstatSync(directory).isDirectory() && fs.realpathSync(directory) === directory, 'upgrade directory must be a regular directory');
  else fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
}
function immutable(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function ensureImmutable(file, bytes) {
  if (fs.existsSync(file)) require(fs.lstatSync(file).isFile() && fs.readFileSync(file).equals(Buffer.from(bytes)), 'existing audit record differs; preserve it and inspect');
  else immutable(file, bytes);
}

/** Called with the plan lock held; observes ownership only. No stored PID is
 * signalled, no fixture is removed and no abandoned record is adopted. */
export function assertRuntimeIdle(plan, runtime) {
  const root = path.join(plan.root, '.codex-plan-runner'), plans = [];
  require(fs.realpathSync(root) === root, 'runner state root must not be a symlink');
  for (const name of fs.readdirSync(root).sort()) {
    const directory = path.join(root, name), stat = fs.lstatSync(directory);
    require(!stat.isSymbolicLink(), `runner state directory is a symlink: ${name}`);
    if (!stat.isDirectory()) continue;
    const file = path.join(directory, 'runner.lock');
    if (fs.existsSync(file) && directory !== plan.stateDir) {
      const owner = json(repositoryFile(plan.root, file));
      if (owner.runtime_directory && owner.runtime_directory !== runtime.directory) continue;
      require(owner.hostname === os.hostname() && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string', `unrecognized runner lock: ${file}`);
      require(!alive(owner.pid) && !alive(owner.worker_pid) && !alive(-owner.worker_pid), `another runner or worker may use this runtime: ${file}`);
    }
    // Controllers may own a runtime before its plan lock or state exists.
    const background = inspectBackgroundOwnership({ root: plan.root, stateDir: directory, planId: name });
    const stateFile = path.join(directory, 'state.json');
    const hasResources = ['acceptance', 'host-checks'].some(tree => fs.existsSync(path.join(directory, tree)));
    if (!fs.existsSync(stateFile)) {
      require(!hasResources, `owned resource tree has no verifiable plan state: ${name}`);
      if (background.files.length) plans.push({ plan_id: name, background });
      continue;
    }
    const state = json(repositoryFile(plan.root, stateFile));
    require(state.schema_version === 1 && state.root === plan.root && state.plan_id === name && HASH.test(state.plan_hash || '')
      && state.steps && typeof state.steps === 'object' && !Array.isArray(state.steps), `unrecognized saved plan identity: ${name}`);
    let ownedPlan;
    if (directory === plan.stateDir) {
      require(same(state, plan.state), 'state changed after load; reload it before inspecting runtime ownership');
      ownedPlan = plan;
    } else {
      // A foreign plan's frozen manifest need not be discoverable from its
      // state. These retained gate identities permit observation only; they
      // cannot authorize execution. Unknown packages/capabilities still refuse.
      const packages = {};
      const discover = folder => {
        if (!fs.existsSync(folder)) return;
        require(fs.lstatSync(folder).isDirectory() && fs.realpathSync(folder) === folder, 'foreign resource tree is not canonical');
        for (const entry of fs.readdirSync(folder).sort()) {
          const target = path.join(folder, entry), info = fs.lstatSync(target);
          require(!info.isSymbolicLink(), 'foreign resource tree contains a symlink');
          if (info.isDirectory()) discover(target);
          else if (entry.startsWith('acceptance-') && entry.endsWith('-journal.json')) {
            const journal = json(repositoryFile(plan.root, target)), id = journal.package_id, gate = journal.gate;
            require(state.steps[id]?.acceptance?.mode === 'strict' && gate && /^[a-z][a-z0-9-]{0,63}$/.test(gate.id || '')
              && ['npm-checks', 'production-build', 'synthetic-postgres', 'loopback-browser'].includes(gate.capability), 'foreign journal has unknown package or capability');
            const requirements = packages[id] ??= { required_gates: [], criteria: [] };
            const existing = requirements.required_gates.find(value => value.id === gate.id);
            require(!existing || same(existing, gate), 'foreign retained gate identities conflict');
            if (!existing) requirements.required_gates.push(gate);
          }
        }
      };
      discover(path.join(directory, 'acceptance'));
      ownedPlan = { root: plan.root, stateDir: directory, stateFile, state, planHash: state.plan_hash,
        manifest: { plan_id: name, steps: Object.keys(state.steps).map(id => ({ id })) },
        acceptanceProfile: { mode: 'strict', packages }, recoveryPolicy: { value: { packages: Object.fromEntries(Object.keys(state.steps).map(id => [id, { recipes: ['npm-checks', 'access-postgres', 'access-policy-postgres'] }])) } } };
    }
    const historicalCompleted = Object.entries(state.steps).filter(([, entry]) => entry.status === 'completed').map(([id]) => id);
    const strict = strictPlanArtifacts(ownedPlan);
    // Completion of a package does not make a newly discovered orphan old.
    // Only immutable, hash-verified retained evidence can exempt its original
    // journal from treating a possibly reused historical PID as current.
    const historicalStrictJournals = [];
    for (const id of historicalCompleted) {
      const acceptance = state.steps[id].acceptance;
      for (const record of [...Object.values(acceptance?.gates || {}), ...(acceptance?.history || [])]) {
        if (record.file && record.sha256 && record.journal_file) historicalStrictJournals.push(record.journal_file);
        if (record.journal_snapshot_file && record.journal_snapshot_sha256) {
          const snapshot = json(repositoryFile(plan.root, record.journal_snapshot_file));
          historicalStrictJournals.push(path.join(path.dirname(record.journal_snapshot_file), `acceptance-${snapshot.id}-journal.json`));
        }
      }
    }
    const cleanup = verifyUnattendedCleanup(ownedPlan, { historicalCompleted, historicalStrictJournals });
    const hostTree = runtimeTreeArtifacts(ownedPlan, 'host-checks');
    plans.push({ plan_id: name, ...(directory !== plan.stateDir ? { state: runtimeArtifact(plan.root, stateFile) } : {}), cleanup, strict, host_tree: hostTree, background });
  }
  return plans;
}

function historicalArtifacts(plan) {
  const artifacts = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    require(fs.lstatSync(directory).isDirectory() && fs.realpathSync(directory).startsWith(plan.stateDir + path.sep), 'historical log directory is not regular');
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isDirectory()) visit(file);
      else artifacts.push(artifact(plan.root, file));
    }
  };
  visit(path.join(plan.stateDir, 'logs'));
  for (const entry of Object.values(plan.state.steps)) {
    for (const decision of entry.recovery?.decisions || []) artifacts.push(artifact(plan.root, decision.file));
    const pending = entry.recovery?.pending_evidence;
    for (const file of [pending?.journal_file, pending?.file]) if (file) artifacts.push(artifact(plan.root, file));
  }
  return artifacts;
}

function binding(plan, runtime, recipeConfiguration, verifyCompleted) {
  const stateBytes = fs.readFileSync(plan.stateFile);
  require(same(JSON.parse(stateBytes.toString('utf8')), plan.state), 'state changed after load; reload it before preparing or applying an upgrade');
  require(plan.state.recovery, 'state has no previous runtime identity; normal start performs its initial migration');
  require(HASH.test(plan.state.recovery.runtime_hash) && HASH.test(plan.state.recovery.policy_hash), 'previous runtime/policy identity is invalid');
  migrateRecoveryState(structuredClone(plan.state), { runtimeHash: plan.state.recovery.runtime_hash, policyHash: plan.state.recovery.policy_hash });
  require(plan.fingerprint() === plan.planHash, 'frozen plan changed');
  require(snapshotRuntime(runtime.directory).hash === runtime.hash, 'runtime changed while preparing reconciliation');
  if (plan.recoveryPolicy.file) require(digest(fs.readFileSync(plan.recoveryPolicy.file)) === plan.recoveryPolicy.hash, 'policy changed while preparing reconciliation');
  for (const step of plan.manifest.steps) verifyCompleted(plan, step);
  verifyRuntimeUpgradeHistory(plan);
  const dependencyHash = snapshotDependencies(plan.root).sha256;
  const recipeHash = recipeConfiguration(plan.root);
  require(plan.state.recovery.dependency_hash === undefined || dependencyHash === plan.state.recovery.dependency_hash, 'installed dependencies changed; runtime reconciliation cannot approve dependency installation');
  require(plan.state.recovery.recipe_config_hash === undefined || recipeHash === plan.state.recovery.recipe_config_hash, 'npm recipe configuration changed; runtime reconciliation cannot approve new shell recipes');
  const result = {
    root: plan.root, plan_id: plan.manifest.plan_id, plan_hash: plan.planHash,
    state_sha256: digest(stateBytes), state_revision: plan.state.recovery.revision,
    previous: { runtime_hash: plan.state.recovery.runtime_hash, policy_hash: plan.state.recovery.policy_hash },
    next: { runtime_hash: runtime.hash, policy_hash: plan.recoveryPolicy.hash, runtime_files: runtime.files,
      runtime_directory: runtime.directory, policy_file: plan.recoveryPolicy.file ? path.relative(plan.root, plan.recoveryPolicy.file) : null },
    source: snapshotSource(plan.root), dependency_hash: dependencyHash, recipe_config_hash: recipeHash,
    protected_configuration: ['.env', '.env.local', '.npmrc', '.codex/config.toml'].map(file => artifact(plan.root, file, true)),
    accepted: protectedArtifacts(plan), history: historicalArtifacts(plan), ownership: assertRuntimeIdle(plan, runtime)
  };
  require(fs.readFileSync(plan.stateFile).equals(stateBytes), 'state changed while binding the reviewed inputs');
  return result;
}

/** Prepare is an inventory, not authorization to start workers or accept a package. */
export function prepareRuntimeUpgrade({ plan, runtime, reviewNote, recipeConfiguration, verifyCompleted }) {
  assertRuntimeIdle(plan, runtime);
  const note = artifact(plan.root, reviewNote);
  const rationaleBytes = fs.readFileSync(path.join(plan.root, note.file));
  const rationale = rationaleBytes.toString('utf8');
  require(rationale.trim().length > 0 && Buffer.from(rationale).equals(rationaleBytes), 'operator review note must be nonempty UTF-8 text');
  require(digest(rationaleBytes) === note.sha256, 'operator review note changed during preparation');
  const inputs = binding(plan, runtime, recipeConfiguration, verifyCompleted);
  require(inputs.previous.runtime_hash !== inputs.next.runtime_hash || inputs.previous.policy_hash !== inputs.next.policy_hash, 'runtime and policy identities already match; no upgrade is required');
  const directory = privateDirectory(plan);
  const proposal = { schema_version: 1, kind: 'reviewed-runtime-upgrade-proposal', id: randomUUID(), prepared_at: new Date().toISOString(),
    review_note: note, review_rationale: rationale, binding: inputs,
    mutation: 'Update only recovery runtime/policy identities, append the audit reference, and increment the state revision. Preserve every package entry, budget, session and historical artifact. No worker is launched.' };
  const file = path.join(directory, `${proposal.id}-proposal.json`);
  immutable(file, encode(proposal));
  require(same(inputs, binding(plan, runtime, recipeConfiguration, verifyCompleted)), 'inputs changed during proposal preparation; discard this proposal and prepare again');
  assertRuntimeIdle(plan, runtime);
  return { file, sha256: digest(fs.readFileSync(file)), proposal };
}

export function verifyRuntimeUpgradeHistory(plan) {
  const records = plan.state.recovery?.runtime_upgrades;
  if (records === undefined) return;
  require(Array.isArray(records), 'invalid runtime upgrade history');
  const ids = new Set();
  for (const entry of records) {
    require(entry && typeof entry.id === 'string' && !ids.has(entry.id), 'duplicate or invalid runtime upgrade audit identity');
    ids.add(entry.id);
    for (const prefix of ['proposal', 'record']) {
      require(HASH.test(entry[`${prefix}_sha256`]), 'invalid audit hash');
      require(artifact(plan.root, entry[`${prefix}_file`]).sha256 === entry[`${prefix}_sha256`], 'runtime upgrade audit changed or is missing');
    }
    const record = json(path.resolve(plan.root, entry.record_file));
    require(record.kind === 'reviewed-runtime-upgrade-authorization' && record.id === entry.id && record.proposal_sha256 === entry.proposal_sha256
      && record.plan_id === plan.manifest.plan_id && record.plan_hash === plan.planHash && record.root === plan.root, 'runtime upgrade audit identity differs');
    require(artifact(plan.root, record.before_state.file).sha256 === record.before_state.sha256, 'runtime upgrade before-state archive changed');
  }
}

/** The caller must hold the runner lock. The supplied SHA is the operator's
 * explicit review of this exact immutable proposal, not a model decision. */
export function applyRuntimeUpgrade({ plan, runtime, proposalFile, proposalSha256, recipeConfiguration, verifyCompleted, reload, writeState }) {
  require(HASH.test(proposalSha256 || ''), 'apply requires the exact reviewed proposal SHA-256');
  const directory = privateDirectory(plan);
  proposalFile = repositoryFile(plan.root, proposalFile);
  require(path.dirname(proposalFile) === directory && digest(fs.readFileSync(proposalFile)) === proposalSha256, 'proposal path/hash differs from the reviewed proposal');
  const proposal = json(proposalFile);
  require(proposal.schema_version === 1 && proposal.kind === 'reviewed-runtime-upgrade-proposal'
    && /^[a-f0-9-]{36}$/.test(proposal.id || '') && path.basename(proposalFile) === `${proposal.id}-proposal.json`, 'invalid proposal');
  const inputs = proposal.binding;
  require(inputs.root === plan.root && inputs.plan_id === plan.manifest.plan_id && inputs.plan_hash === plan.planHash, 'proposal is for another checkout or plan');
  assertRuntimeIdle(plan, runtime);
  verifyRuntimeUpgradeHistory(plan);
  const existing = plan.state.recovery?.runtime_upgrades?.find(entry => entry.id === proposal.id);
  if (existing) {
    require(existing.proposal_sha256 === proposalSha256 && plan.state.recovery.runtime_hash === runtime.hash && plan.state.recovery.policy_hash === plan.recoveryPolicy.hash, 'already-applied proposal no longer matches the active runtime');
    // Later legitimate package/source progress need not equal the old proposal,
    // but all currently retained immutable history must still verify.
    for (const step of plan.manifest.steps) verifyCompleted(plan, step);
    strictPlanArtifacts(plan);
    assertRuntimeIdle(plan, runtime);
    return { alreadyApplied: true, file: path.resolve(plan.root, existing.record_file) };
  }
  require(same(proposal.review_note, artifact(plan.root, proposal.review_note.file)), 'operator review note changed');
  require(same(inputs, binding(plan, runtime, recipeConfiguration, verifyCompleted)), 'reviewed inputs changed; inspect and prepare a new proposal');
  const beforeBytes = fs.readFileSync(plan.stateFile);
  const beforeFile = path.join(directory, `${proposal.id}-state-before.json`);
  ensureImmutable(beforeFile, beforeBytes);
  const recordFile = path.join(directory, `${proposal.id}-authorization.json`);
  const recordedAt = fs.existsSync(recordFile) ? json(repositoryFile(plan.root, recordFile)).recorded_at : new Date().toISOString();
  const record = { schema_version: 1, kind: 'reviewed-runtime-upgrade-authorization', id: proposal.id,
    root: plan.root, plan_id: plan.manifest.plan_id, plan_hash: plan.planHash, recorded_at: recordedAt,
    proposal_file: path.relative(plan.root, proposalFile), proposal_sha256: proposalSha256,
    before_state: { file: path.relative(plan.root, beforeFile), sha256: inputs.state_sha256 },
    previous: inputs.previous, next: inputs.next, previous_revision: inputs.state_revision, next_revision: inputs.state_revision + 1 };
  ensureImmutable(recordFile, encode(record));
  // Archive first. A crash before the atomic state write leaves the original
  // state and the same immutable authorization safely reusable on retry.
  const next = JSON.parse(beforeBytes.toString('utf8'));
  next.recovery.runtime_hash = runtime.hash;
  next.recovery.policy_hash = plan.recoveryPolicy.hash;
  next.recovery.revision++;
  next.recovery.runtime_upgrades ??= [];
  next.recovery.runtime_upgrades.push({ id: proposal.id, proposal_file: record.proposal_file, proposal_sha256: proposalSha256,
    record_file: path.relative(plan.root, recordFile), record_sha256: digest(fs.readFileSync(recordFile)) });
  next.updated_at = recordedAt;
  const current = reload();
  current.recoveryPolicy = plan.recoveryPolicy;
  current.acceptanceProfile = plan.acceptanceProfile;
  require(same(inputs, binding(current, runtime, recipeConfiguration, verifyCompleted)), 'reviewed inputs changed before the atomic state write');
  assertRuntimeIdle(plan, runtime);
  require(fs.readFileSync(plan.stateFile).equals(beforeBytes), 'state changed before atomic replacement; refusing to overwrite it');
  // The writer invokes this after serializing/fsyncing its temporary file,
  // immediately before rename. Cooperative lock publication cannot enter here;
  // observable outside changes still fail closed. This is an optimistic guard,
  // not portable compare-and-swap against arbitrary same-user writers.
  const beforeReplace = () => {
    require(fs.readFileSync(plan.stateFile).equals(beforeBytes), 'state changed during atomic write; refusing to overwrite it');
    const final = reload();
    final.recoveryPolicy = plan.recoveryPolicy;
    final.acceptanceProfile = plan.acceptanceProfile;
    require(same(inputs, binding(final, runtime, recipeConfiguration, verifyCompleted)), 'reviewed inputs changed during atomic write');
    assertRuntimeIdle(final, runtime);
    require(fs.readFileSync(plan.stateFile).equals(beforeBytes), 'state changed before atomic replacement; refusing to overwrite it');
  };
  writeState(plan.stateFile, next, beforeReplace);
  require(fs.readFileSync(plan.stateFile).equals(Buffer.from(encode(next))), 'state differs after atomic replacement; preserve all records and inspect');
  plan.state = next;
  verifyRuntimeUpgradeHistory(plan);
  return { alreadyApplied: false, file: recordFile };
}
