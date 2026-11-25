import fs from 'node:fs';
import { acceptanceForPackage, acceptancePath, checkedAcceptanceFile } from './acceptance-policy.mjs';
import { strictEntryArtifacts } from './runtime-artifacts.mjs';
import { redact } from './failure-report.mjs';
import { validateSubdivisionRecovery } from './subdivision-state.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const relativePath = value => nonempty(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') && !value.includes('\0');
const require = (condition, message) => { if (!condition) throw new Error(`Invalid recovery: ${message}`); };

export const RECOVERY_DEFAULTS = Object.freeze({
  maxRepairRetries: 3, maxTransportRetries: 8, maxEvidenceRefreshes: 2,
  maxNoProgress: 2, maxSessionReplacements: 1, maxProtocolRetries: 2
});
export const RECOVERY_RECIPES = Object.freeze(['npm-checks']);

/** A recovery decision is never a package completion receipt or a host command. */
export const recoveryResultSchema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'package_id', 'attempt_id', 'classification', 'action', 'recipe_id', 'summary', 'changed_files', 'blockers'],
  properties: {
    schema_version: { type: 'integer', const: 1 },
    package_id: { type: 'string', pattern: '^[0-9]{2}$' },
    attempt_id: { type: 'string', minLength: 1 },
    classification: { type: 'string', enum: ['implementation', 'dependency', 'environment', 'external'] },
    action: { type: 'string', enum: ['resume', 'host-check', 'acceptance-check', 'blocked'] },
    recipe_id: { type: ['string', 'null'] },
    summary: { type: 'string', minLength: 1 },
    changed_files: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } }
  }
};

export function validateRecoveryConfiguration(value, steps) {
  require(exactKeys(value, ['schema_version', 'packages']) && value.schema_version === 1 && object(value.packages), 'configuration schema is invalid');
  const configured = new Map(steps.map(step => [step.id, step]));
  for (const [id, entry] of Object.entries(value.packages)) {
    require(configured.has(id) && !configured.get(id).manual, `configuration cannot authorize missing/manual package ${id}`);
    require(exactKeys(entry, ['local_repair', 'recipes']) && typeof entry.local_repair === 'boolean' && Array.isArray(entry.recipes), `invalid package ${id} configuration`);
    require(entry.recipes.every(recipe => RECOVERY_RECIPES.includes(recipe)) && new Set(entry.recipes).size === entry.recipes.length, `unknown or duplicate host recipe for package ${id}`);
    require(entry.local_repair || !entry.recipes.length, 'host recipes require enabled recovery');
  }
  return value;
}

export function validateRecoveryPolicy(value, manifest) {
  require(exactKeys(value, ['schema_version', 'plan_id', 'packages']) && value.plan_id === manifest.plan_id, 'policy identity is invalid');
  validateRecoveryConfiguration({ schema_version: value.schema_version, packages: value.packages }, manifest.steps);
  return value;
}

/** Authority is authored explicitly and frozen with the generic manifest.
 * Omitted configuration enables ordinary sandbox repairs, with no host recipes. */
export function loadRecoveryPolicy(_root, manifest) {
  const config = manifest.recovery ?? { schema_version: 1, packages: Object.fromEntries(manifest.steps.filter(step => !step.manual).map(step => [step.id, { local_repair: true, recipes: [] }])) };
  validateRecoveryConfiguration(config, manifest.steps);
  const value = validateRecoveryPolicy({ ...config, plan_id: manifest.plan_id }, manifest);
  return { value, hash: hash(JSON.stringify(value)), file: null };
}

export function validateRecoveryDecision(result, { packageId, attemptId, policy, step, acceptanceProfile }) {
  require(exactKeys(result, recoveryResultSchema.required), 'decision must contain exactly the recovery schema keys');
  require(result.schema_version === 1 && result.package_id === packageId && result.attempt_id === attemptId && nonempty(attemptId), 'decision identity mismatch');
  require(recoveryResultSchema.properties.classification.enum.includes(result.classification), 'unknown classification');
  require(recoveryResultSchema.properties.action.enum.includes(result.action), 'unknown recovery action');
  require(result.recipe_id === null || nonempty(result.recipe_id), 'invalid recipe identity');
  require(nonempty(result.summary) && Array.isArray(result.changed_files) && result.changed_files.every(relativePath), 'invalid recovery summary or changed paths');
  require(new Set(result.changed_files).size === result.changed_files.length, 'duplicate changed paths');
  require(Array.isArray(result.blockers) && result.blockers.every(nonempty), 'invalid blockers');
  const configured = (policy?.value || policy)?.packages?.[packageId];
  if (result.action === 'blocked') {
    require(result.recipe_id === null && result.blockers.length > 0, 'blocked recovery requires actionable blockers and no recipe');
  } else if (result.action === 'acceptance-check') {
    require(object(step) && step.id === packageId && !step.manual && acceptanceForPackage(acceptanceProfile, packageId), 'acceptance-check requires an existing strict nonmanual package profile');
    require(result.blockers.length === 0, 'acceptance-check contradicts unresolved blockers; preserve genuine blockers and return action blocked');
    require(result.classification === 'environment' && result.recipe_id === null, 'acceptance-check requires environment classification and no recipe; external blockers cannot request parent acceptance');
  } else {
    require(configured?.local_repair === true, 'recovery is unauthorized for this package');
    require(result.blockers.length === 0, `${result.action} contradicts unresolved blockers; preserve genuine blockers and return action blocked with recipe_id null, or explain resolved prerequisites before requesting an authorized action`);
    require(result.classification !== 'external', 'external classification cannot execute recovery; return action blocked and preserve the required external decision/service');
    if (result.action === 'host-check') {
      require(result.classification === 'environment' && configured.recipes.includes(result.recipe_id) && RECOVERY_RECIPES.includes(result.recipe_id), 'unknown or unauthorized host recipe');
    } else require(result.recipe_id === null, 'resume cannot contain a host recipe');
  }
  return result;
}

/** The parent binds this request to an existing profile and original actor. */
export function validateAcceptanceRequest(request) {
  require(exactKeys(request, ['schema_version', 'package_id', 'attempt_id', 'actor', 'thread_id', 'origin', 'file', 'sha256', 'profile_sha256'])
    && request.schema_version === 1 && /^[0-9]{2}$/.test(request.package_id) && UUID.test(request.attempt_id)
    && ['worker', 'finalizer'].includes(request.actor) && (request.thread_id === null || UUID.test(request.thread_id))
    && ['worker', 'supervisor'].includes(request.origin) && acceptancePath(request.file)
    && HASH.test(request.sha256) && HASH.test(request.profile_sha256), 'invalid persisted acceptance request');
  return request;
}

/** Keep every consumed handoff hash-bound across interruption and finalization. */
export function verifyAcceptanceRequests(root, recovery) {
  const requests = [recovery.acceptance_request, ...(recovery.history || [])
    .filter(item => item.action === 'acceptance-request').map(item => item.request)].filter(Boolean);
  for (const request of requests) {
    validateAcceptanceRequest(request);
    const file = checkedAcceptanceFile(root, request.file);
    require(hash(fs.readFileSync(file)) === request.sha256, 'acceptance request output changed or is missing');
  }
  return true;
}

export function newPackageRecovery() {
  return {
    schema_version: 1, phase: 'worker', repair_count: 0, transport_count: 0, protocol_retry_count: 0,
    evidence_refresh_count: 0, session_replacement_count: 0, no_progress_count: 0,
    last_failure_fingerprint: null, pending_evidence: null, decisions: [], history: [], next_action: 'run-worker'
  };
}

export function validatePackageRecovery(value) {
  require(object(value) && value.schema_version === 1, 'invalid package recovery schema');
  require(['worker', 'supervisor', 'planner', 'subtask', 'finalizer', 'host', 'acceptance', 'waiting', 'needs-attention', 'completed'].includes(value.phase), 'unknown recovery phase');
  for (const key of ['repair_count', 'transport_count', 'evidence_refresh_count', 'session_replacement_count', 'no_progress_count']) {
    require(Number.isSafeInteger(value[key]) && value[key] >= 0, `invalid persisted ${key}`);
  }
  // Old accepted receipts/state remain valid and are not rewritten during migration.
  require(value.protocol_retry_count === undefined || Number.isSafeInteger(value.protocol_retry_count) && value.protocol_retry_count >= 0, 'invalid persisted protocol_retry_count');
  if (value.protocol_feedback !== undefined && value.protocol_feedback !== null) {
    const feedback = value.protocol_feedback;
    require(exactKeys(feedback, ['actor', 'attempt_id', 'file', 'sha256', 'reason'])
      && /^[a-z][a-z0-9-]{0,63}$/.test(feedback.actor) && nonempty(feedback.attempt_id)
      && relativePath(feedback.file) && HASH.test(feedback.sha256) && nonempty(feedback.reason), 'invalid persisted protocol feedback');
  }
  require(value.last_failure_fingerprint === null || HASH.test(value.last_failure_fingerprint), 'invalid failure fingerprint');
  if (value.pending_evidence !== null) {
    const pending = value.pending_evidence;
    require(exactKeys(pending, ['recipe_id', 'output_dir', 'journal_file', 'file', 'sha256']) && RECOVERY_RECIPES.includes(pending.recipe_id)
      && nonempty(pending.output_dir) && (pending.journal_file === null || nonempty(pending.journal_file))
      && (pending.file === null || nonempty(pending.file)) && (pending.sha256 === null || HASH.test(pending.sha256))
      && (pending.file === null) === (pending.sha256 === null), 'invalid pending host evidence');
  }
  require(Array.isArray(value.decisions) && value.decisions.every(decision => exactKeys(decision, ['file', 'sha256', 'attempt_id', 'action', 'classification', 'summary'])
    && nonempty(decision.file) && HASH.test(decision.sha256) && nonempty(decision.attempt_id)
    && recoveryResultSchema.properties.action.enum.includes(decision.action)
    && recoveryResultSchema.properties.classification.enum.includes(decision.classification) && nonempty(decision.summary)), 'invalid recorded supervisor decisions');
  require(Array.isArray(value.history) && value.history.every(object), 'invalid recovery history');
  if (value.acceptance_request !== undefined && value.acceptance_request !== null) validateAcceptanceRequest(value.acceptance_request);
  require(![value.phase, value.resume_phase].includes('acceptance') || object(value.acceptance_request), 'acceptance phase requires a saved request');
  for (const item of value.history) if (item.action === 'acceptance-request') validateAcceptanceRequest(item.request);
  if (value.supervisor !== undefined) {
    require(object(value.supervisor) && Number.isSafeInteger(value.supervisor.attempts) && value.supervisor.attempts >= 0
      && (value.supervisor.thread_id === undefined || value.supervisor.thread_id === null || UUID.test(value.supervisor.thread_id))
      && (value.supervisor.last_attempt === undefined || object(value.supervisor.last_attempt)), 'invalid saved supervisor session');
  }
  for (const key of ['failure_kind', 'budget_reason', 'terminal_blocker']) {
    require(value[key] === undefined || value[key] === null || nonempty(value[key]), `invalid ${key}`);
  }
  require(value.budget_kind === undefined || value.budget_kind === null || ['evidence', 'acceptance-evidence', 'acceptance-timeout', 'rotation', 'protocol'].includes(value.budget_kind), 'invalid persisted budget kind');
  validateSubdivisionRecovery(value);
  require(nonempty(value.next_action), 'missing next action');
  return value;
}

/** Additive migration; callers persist only under the runner lock after validation. */
export function migrateRecoveryState(state, { policyHash, runtimeHash }) {
  require(HASH.test(policyHash) && HASH.test(runtimeHash), 'migration requires policy/runtime identities');
  if (state.recovery === undefined) state.recovery = { schema_version: 1, revision: 0, policy_hash: policyHash, runtime_hash: runtimeHash };
  require(object(state.recovery) && state.recovery.schema_version === 1 && Number.isSafeInteger(state.recovery.revision) && state.recovery.revision >= 0, 'corrupt recovery state/revision');
  require(state.recovery.policy_hash === policyHash && state.recovery.runtime_hash === runtimeHash, 'recovery policy or runtime changed since migration; inspect before continuing');
  for (const key of ['dependency_hash', 'recipe_config_hash']) if (state.recovery[key] !== undefined) require(HASH.test(state.recovery[key]), `invalid persisted ${key}`);
  for (const entry of Object.values(state.steps)) {
    if (entry.recovery !== undefined) {
      validatePackageRecovery(entry.recovery);
      if (entry.status !== 'completed' && entry.recovery.protocol_retry_count === undefined) entry.recovery.protocol_retry_count = 0;
    }
    else if (entry.status !== 'completed') {
      entry.recovery = newPackageRecovery();
      // Preserve legacy generic retry usage during the additive migration.
      for (const [legacy, current] of [['transport_failure_count', 'transport_count'], ['repair_failure_count', 'repair_count']]) {
        require(entry[legacy] === undefined || Number.isSafeInteger(entry[legacy]) && entry[legacy] >= 0, `invalid legacy ${legacy}`);
        entry.recovery[current] = entry[legacy] || 0;
      }
    }
  }
  return state;
}

/** Runtime identity is separate from the immutable plan and worker-contract hash algorithm. */
export function snapshotRuntime(directory = runtimeDirectory) {
  const files = fs.readdirSync(directory).filter(name => (/\.(?:mjs|json)$/.test(name) && !name.endsWith('.test.mjs')) || name === 'acceptance-fixtures.md').sort().map(name => path.join(directory, name));
  const wrapper = path.resolve(directory, '../run.mjs');
  if (fs.existsSync(wrapper)) files.push(wrapper);
  const inventory = files.map(file => {
    require(fs.lstatSync(file).isFile(), `runtime file is not a regular file: ${file}`);
    return [path.relative(directory, file), hash(fs.readFileSync(file)), fs.statSync(file).mode & 0o777];
  });
  return { hash: hash(JSON.stringify(inventory)), files: inventory, directory };
}

function artifact(root, candidate) {
  const file = path.resolve(root, candidate);
  require(file.startsWith(root + path.sep), 'protected artifact escapes repository');
  if (!fs.existsSync(file)) return [file, null];
  require(fs.realpathSync(file).startsWith(root + path.sep) && fs.statSync(file).isFile(), 'protected artifact is not a repository file');
  return [file, hash(fs.readFileSync(file))];
}

export function protectedArtifacts(plan, extraProtectedPaths = []) {
  const files = [...extraProtectedPaths], entries = [];
  for (const step of plan.manifest.steps) {
    const entry = plan.state.steps[step.id];
    if (entry?.status !== 'completed') continue;
    entries.push([step.id, entry]);
    files.push(step.validation, step.handoff, entry.last_attempt.result_file);
    for (const item of strictEntryArtifacts(plan.root, entry)) files.push(item.file);
    if (entry.host_validation) {
      files.push(entry.host_validation.file);
      const evidence = JSON.parse(fs.readFileSync(path.resolve(plan.root, entry.host_validation.file), 'utf8'));
      for (const check of evidence.checks || []) if (check.log_file) files.push(check.log_file);
    }
  }
  return { entries: hash(JSON.stringify(entries)), files: [...new Set(files)].sort().map(file => artifact(plan.root, file)) };
}

/** The optimistic state guard is owned by runner.save(); this protects other phase inputs.
 * It is not a portable filesystem compare-and-swap against hostile writers. */
export function capturePhaseGuard(plan, { runtime = snapshotRuntime(), policy = plan.recoveryPolicy, extraProtectedPaths = [] } = {}) {
  require(plan.fingerprint() === plan.planHash, 'frozen plan or manifest changed before phase');
  require(snapshotRuntime(runtime.directory).hash === runtime.hash, 'runner runtime changed before phase');
  if (policy.file) require(hash(fs.readFileSync(policy.file)) === policy.hash, 'recovery policy changed before phase');
  const protectedState = protectedArtifacts(plan, extraProtectedPaths);
  return { planHash: plan.planHash, runtime, policyHash: policy.hash, policyFile: policy.file, protectedState, extraProtectedPaths };
}

export function assertPhaseGuard(plan, guard) {
  require(plan.fingerprint() === guard.planHash, 'frozen plan or manifest changed during phase');
  require(snapshotRuntime(guard.runtime.directory).hash === guard.runtime.hash, 'runner runtime changed during phase');
  if (guard.policyFile) require(hash(fs.readFileSync(guard.policyFile)) === guard.policyHash, 'recovery policy changed during phase');
  require(JSON.stringify(protectedArtifacts(plan, guard.extraProtectedPaths)) === JSON.stringify(guard.protectedState), 'accepted package state or protected artifacts changed during phase');
}

/** Source identity is supplied by the runner and excludes only mutable receipts. */
export function recordNoProgress(recovery, { diagnostic, sourceHash, failureIds, executionInputHash, verifiedGates }) {
  let inputs;
  if (failureIds !== undefined || executionInputHash !== undefined || verifiedGates !== undefined) {
    require(Array.isArray(failureIds) && failureIds.length > 0 && failureIds.every(nonempty) && HASH.test(executionInputHash), 'no-progress tracking requires parent-derived failure IDs and execution identity');
    require(Array.isArray(verifiedGates) && verifiedGates.every(gate => nonempty(gate)
      || exactKeys(gate, ['id', 'sha256']) && nonempty(gate.id) && HASH.test(gate.sha256)), 'invalid verified gate progress');
    // Fresh timestamps, fixture IDs or re-serialized evidence cannot make an
    // already verified gate into new progress. Source changes have their own
    // parent execution identity; evidence hashes remain verified elsewhere.
    const gates = [...new Set(verifiedGates.map(gate => typeof gate === 'string' ? gate : gate.id))].sort();
    inputs = ['parent-acceptance-v1', [...new Set(failureIds)].sort(), executionInputHash, gates];
  } else {
    // Historical/simple manifests keep their original receipt-verification mode.
    require(HASH.test(sourceHash) && nonempty(diagnostic), 'no-progress tracking requires diagnostic and source identity');
    inputs = [diagnostic, sourceHash];
  }
  const fingerprint = hash(JSON.stringify(inputs));
  recovery.no_progress_count = recovery.last_failure_fingerprint === fingerprint ? recovery.no_progress_count + 1 : 1;
  recovery.last_failure_fingerprint = fingerprint;
  return recovery.no_progress_count;
}


/** Preserve rejected wire output and schedule only a bounded correction of the
 * same actor. This cannot authorize or normalize the rejected action. The caller
 * must keep the actor thread and clear only its cached last_attempt after save. */
export function recordProtocolRejection(recovery, { actor, attemptId, file, sha256, error, maxRetries = RECOVERY_DEFAULTS.maxProtocolRetries }) {
  require(/^[a-z][a-z0-9-]{0,63}$/.test(actor) && nonempty(attemptId) && relativePath(file) && HASH.test(sha256), 'protocol rejection identity is invalid');
  require(Number.isSafeInteger(maxRetries) && maxRetries >= 0, 'invalid protocol retry budget');
  const reason = error instanceof Error ? error.message : error;
  require(nonempty(reason), 'protocol correction requires the exact validation diagnostic');
  validatePackageRecovery(recovery);
  recovery.protocol_retry_count ??= 0;
  const previous = recovery.history.findLast(item => item.action === 'protocol-rejected' && item.actor === actor && item.attempt_id === attemptId && item.sha256 === sha256);
  // Reconciliation is idempotent after a scheduled correction. An explicit
  // larger operator budget may schedule a formerly exhausted correction while
  // retaining the original rejected record and its counter.
  if (previous?.retry_scheduled) return true;
  if (previous && recovery.protocol_retry_count >= maxRetries) return false;
  const retry = recovery.protocol_retry_count < maxRetries;
  if (retry) recovery.protocol_retry_count++;
  recovery.protocol_feedback = { actor, attempt_id: attemptId, file, sha256, reason };
  recovery.history.push({ action: 'protocol-rejected', ...recovery.protocol_feedback, retry_scheduled: retry, protocol_retry_count: recovery.protocol_retry_count });
  recovery.next_action = retry ? `correct-${actor}-protocol` : `inspect-${actor}-protocol-budget`;
  return retry;
}

export function clearProtocolFeedback(recovery, actor) {
  if (recovery.protocol_feedback?.actor === actor) delete recovery.protocol_feedback;
}

/** Compact exact rejection feedback; original output stays in the immutable log. */
export function protocolCorrectionPrompt(recovery, actor) {
  const feedback = recovery.protocol_feedback;
  if (!feedback || feedback.actor !== actor) return '';
  return `\nPROTOCOL_CORRECTION_REQUIRED\nRejected output: ${feedback.file}\nRejected SHA256: ${feedback.sha256}\nValidation failure: ${feedback.reason}\nThe rejected decision was not executed. Inspect partial effects before continuing in this same conversation. Return a corrected result for the current ATTEMPT_ID using exactly the supplied schema. Preserve genuine blockers; do not remove them merely to make an execution action valid. Do not change protected inputs, acceptance, permissions, source-repair budgets or prior evidence to fix output format. Protocol retries used: ${recovery.protocol_retry_count}.\n`;
}

export function verifyProtocolRejections(root, recovery) {
  const resolvedRoot = fs.realpathSync(root);
  for (const item of recovery.history || []) {
    if (item.action !== 'protocol-rejected') continue;
    require(relativePath(item.file) && HASH.test(item.sha256), 'invalid rejected-output reference');
    const file = path.resolve(resolvedRoot, item.file);
    require(file.startsWith(resolvedRoot + path.sep) && fs.existsSync(file) && fs.lstatSync(file).isFile()
      && fs.realpathSync(file) === file && hash(fs.readFileSync(file)) === item.sha256, 'rejected protocol output changed or is missing');
  }
  return true;
}

/** Read-only display classification. Keep old reports on disk; only a matching
 * unfinished state may establish a current package failure. Unscoped historical
 * guard reports need inspection, but cannot overrule a recovered package state. */
export function currentAttentionReport(state, report) {
  if (!object(report) || !nonempty(report.package_id)) return false;
  const entry = state.steps?.[report.package_id];
  const recovery = entry?.recovery;
  if (!entry || entry.status === 'completed' || recovery?.phase !== 'needs-attention') return false;
  if (report.attempt !== undefined && report.attempt !== entry.attempts) return false;
  // Durable reports are presentation-safe; recovery state retains the original
  // evidence. Compare the same projection without rewriting either artifact.
  return nonempty(report.reason) && [recovery.terminal_blocker, recovery.budget_reason]
    .filter(nonempty).some(reason => redact(reason) === redact(report.reason));
}
