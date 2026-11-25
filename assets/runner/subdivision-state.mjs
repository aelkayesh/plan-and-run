import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { subdivisionPath, validatePlannerResult, validateSubtaskResult } from './subdivision.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
export const actors = ['worker', 'supervisor', 'planner', 'subtask', 'finalizer'];
const boundedActors = ['planner', 'subtask', 'finalizer', 'supervisor'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const require = (condition, message) => { if (!condition) throw new Error(`Invalid subdivision state: ${message}`); };
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e6;
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !value.includes('\0');
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
const relative = value => text(value, 512) && !path.isAbsolute(value) && !/[\\:\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
const absolute = value => text(value, 4096) && path.isAbsolute(value) && path.normalize(value) === value && !/[\\\x00-\x1f\x7f]/.test(value);
const timestamp = value => text(value, 64) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));

function lastAttempt(value, role) {
  require(keys(value, ['role', 'attempt_id', 'result_file', 'log_file', 'started_at'], ['exit_code', 'turn_completed', 'turn_failed', 'timed_out', 'interrupted', 'retry_accounted', 'finished_at', 'outcome', ...(['worker', 'finalizer'].includes(role) ? ['parent_acceptance_source_sha256'] : [])]), 'invalid saved attempt keys');
  require(value.role === role && actors.includes(role) && UUID.test(value.attempt_id), 'invalid saved attempt role or identity');
  require(absolute(value.result_file) && absolute(value.log_file) && path.dirname(value.result_file) === path.dirname(value.log_file)
    && value.result_file !== value.log_file && value.result_file.endsWith('.json') && value.log_file.endsWith('.jsonl'), 'invalid saved attempt artifact paths');
  require(timestamp(value.started_at), 'invalid saved attempt timestamp');
  if (value.parent_acceptance_source_sha256 !== undefined) require(value.parent_acceptance_source_sha256 === null || typeof value.parent_acceptance_source_sha256 === 'string' && HASH.test(value.parent_acceptance_source_sha256), 'invalid saved parent acceptance source');
  for (const key of ['turn_completed', 'turn_failed', 'timed_out', 'interrupted', 'retry_accounted']) if (value[key] !== undefined) require(typeof value[key] === 'boolean', `invalid saved attempt ${key}`);
  if (value.exit_code !== undefined) require(Number.isInteger(value.exit_code) && value.exit_code >= -1 && value.exit_code <= 255, 'invalid saved attempt exit code');
  if (value.finished_at !== undefined) require(timestamp(value.finished_at), 'invalid saved attempt finish timestamp');
  if (value.outcome !== undefined) {
    const outcome = value.outcome;
    const optional = role === 'subtask' ? ['checkpoint_sha256'] : ['worker', 'finalizer'].includes(role) ? ['validation_sha256', 'handoff_sha256'] : [];
    require(keys(outcome, ['source_sha256', 'result_sha256'], [...optional, 'log_sha256', 'stderr_sha256']) && HASH.test(outcome.source_sha256) && HASH.test(outcome.result_sha256), 'invalid saved attempt outcome');
    for (const key of optional) if (outcome[key] !== undefined) require(outcome[key] === null || HASH.test(outcome[key]), `invalid saved attempt ${key}`);
    if (outcome.log_sha256 !== undefined || outcome.stderr_sha256 !== undefined) require(typeof outcome.log_sha256 === 'string' && HASH.test(outcome.log_sha256) && typeof outcome.stderr_sha256 === 'string' && HASH.test(outcome.stderr_sha256), 'invalid saved provider diagnostic hashes');
    require(value.exit_code === 0 && value.turn_completed === true && value.turn_failed === false && value.interrupted !== true && timestamp(value.finished_at), 'outcome lacks a successful finished attempt');
  }
}
function actor(value, role) {
  require(keys(value, ['attempts'], ['thread_id', 'last_attempt', 'input_source_sha256']) && count(value.attempts), 'invalid actor attempts or keys');
  require(value.thread_id === undefined || value.thread_id === null || UUID.test(value.thread_id), 'invalid actor thread');
  if (value.last_attempt !== undefined) { require(value.attempts > 0, 'saved attempt requires a positive attempt count'); lastAttempt(value.last_attempt, role); }
  if (value.input_source_sha256 !== undefined) require(HASH.test(value.input_source_sha256), 'invalid actor input source');
}

/** Additive: legacy recovery entries without subdivision fields remain unchanged. */
export function validateSubdivisionRecovery(r) {
  require(object(r), 'missing recovery state');
  const roleFields = {
    return_actor: ['worker', 'planner', 'subtask', 'finalizer'], waiting_actor: actors,
    resume_phase: [...actors, 'host', 'acceptance'], rotate_pending: boundedActors, tpm_streak_actor: actors
  };
  for (const [key, allowed] of Object.entries(roleFields)) if (r[key] !== undefined && r[key] !== null) require(allowed.includes(r[key]), `invalid ${key}`);
  for (const key of ['tpm_failure_count', 'tpm_streak']) if (r[key] !== undefined) require(count(r[key]), `invalid ${key}`);
  if (r.last_tpm_attempt !== undefined && r.last_tpm_attempt !== null) require(UUID.test(r.last_tpm_attempt), 'invalid last TPM attempt');
  if (r.host_evidence_deferred !== undefined) require(typeof r.host_evidence_deferred === 'boolean', 'invalid host evidence deferral');
  if (r.host_evidence_deferred) require(object(r.subdivision) && r.pending_evidence?.file && r.pending_evidence?.sha256
    && !['host', 'finalizer', 'completed'].includes(r.phase), 'host evidence deferral requires completed evidence and remaining subtasks');
  if (r.subdivision === undefined) return;
  const s = r.subdivision;
  if (r.host_evidence_deferred) require(Array.isArray(s.tasks) && s.next_task > 0 && s.next_task < s.tasks.length,
    'host evidence deferral requires completed evidence and remaining subtasks');
  require(keys(s, ['schema_version', 'id', 'count', 'rotation_count', 'rotations', 'inventory_file', 'inventory_sha256', 'source_sha256', 'planner', 'finalizer', 'tasks', 'next_task', 'artifacts'])
    && s.schema_version === 1 && UUID.test(s.id) && s.count === 1, 'invalid identity or subdivision budget');
  require(Buffer.byteLength(JSON.stringify(s)) <= 256 * 1024, 'subdivision state exceeds bounded size');
  require(count(s.rotation_count) && s.rotation_count <= 100 && Array.isArray(s.rotations) && s.rotations.length === s.rotation_count, 'invalid rotation history');
  for (const rotation of s.rotations) {
    require(keys(rotation, ['role', 'previous_thread', 'source_sha256', 'last_attempt']) && boundedActors.includes(rotation.role)
      && (rotation.previous_thread === null || UUID.test(rotation.previous_thread)) && HASH.test(rotation.source_sha256), 'invalid rotation identity');
    if (rotation.last_attempt !== null) lastAttempt(rotation.last_attempt, rotation.role);
  }
  require(relative(s.inventory_file) && HASH.test(s.inventory_sha256) && HASH.test(s.source_sha256), 'invalid partial inventory');
  actor(s.planner, 'planner'); actor(s.finalizer, 'finalizer');
  require(Array.isArray(s.tasks) && (s.tasks.length === 0 || (s.tasks.length >= 2 && s.tasks.length <= 6)), 'invalid task count');
  require(count(s.next_task) && s.next_task <= s.tasks.length, 'invalid task cursor');
  require(Array.isArray(s.artifacts) && s.artifacts.length <= 16, 'invalid artifact count');
  for (const file of s.artifacts) require(keys(file, ['file', 'sha256']) && relative(file.file) && HASH.test(file.sha256), 'invalid evidence identity');
  const checkpoints = new Set();
  for (let index = 0; index < s.tasks.length; index++) {
    const task = s.tasks[index];
    require(keys(task, ['id', 'title', 'instructions', 'checks', 'checkpoint_file', 'actor'], ['accepted'])
      && task.id === String(index + 1).padStart(2, '0') && relative(task.checkpoint_file) && !checkpoints.has(task.checkpoint_file), 'invalid task identity');
    checkpoints.add(task.checkpoint_file);
    require(text(task.title, 160) && text(task.instructions, 6000) && Array.isArray(task.checks) && task.checks.length >= 1
      && task.checks.length <= 12 && task.checks.every(check => text(check, 1000)), 'invalid task scope');
    actor(task.actor, 'subtask');
    require((index < s.next_task) === Boolean(task.accepted), 'non-sequential accepted tasks');
    if (task.accepted) require(keys(task.accepted, ['file', 'sha256', 'result_file', 'result_sha256', 'source_sha256', 'summary'])
      && task.accepted.file === task.checkpoint_file && HASH.test(task.accepted.sha256) && relative(task.accepted.result_file)
      && HASH.test(task.accepted.result_sha256) && HASH.test(task.accepted.source_sha256) && text(task.accepted.summary, 4000)
      && Boolean(task.actor.last_attempt?.outcome), 'invalid accepted checkpoint');
  }
  subdivisionArtifacts(r); // Also reject conflicting evidence identities at load time.
}
export function subdivisionArtifacts(r) {
  const s = r?.subdivision;
  if (!s) return [];
  const files = [{ file: s.inventory_file, sha256: s.inventory_sha256 }, ...s.artifacts];
  for (const task of s.tasks) if (task.accepted) files.push({ file: task.accepted.file, sha256: task.accepted.sha256 }, { file: task.accepted.result_file, sha256: task.accepted.result_sha256 });
  const byPath = new Map();
  for (const artifact of files) {
    require(!byPath.has(artifact.file) || byPath.get(artifact.file) === artifact.sha256, 'conflicting accepted evidence identities');
    byPath.set(artifact.file, artifact.sha256);
  }
  return [...byPath].map(([file, sha256]) => ({ file, sha256 }));
}
export function verifySubdivisionArtifacts(root, r) {
  if (!r?.subdivision) return;
  validateSubdivisionRecovery(r);
  for (const artifact of subdivisionArtifacts(r)) {
    const file = subdivisionPath(root, artifact.file, { mustExist: true });
    require(createHash('sha256').update(fs.readFileSync(file)).digest('hex') === artifact.sha256, 'accepted checkpoint or planner evidence changed');
  }
  const s = r.subdivision;
  const attempts = [s.planner.last_attempt, s.finalizer.last_attempt, ...s.tasks.map(task => task.actor.last_attempt), ...s.rotations.map(rotation => rotation.last_attempt)].filter(Boolean);
  for (const attempt of attempts) for (const key of ['result_file', 'log_file']) {
    require(attempt[key].startsWith(fs.realpathSync(root) + path.sep), 'saved attempt path escapes repository');
    subdivisionPath(root, path.relative(fs.realpathSync(root), attempt[key]), { mustExist: true });
  }
  if (s.tasks.length) {
    const attempt = s.planner.last_attempt;
    require(attempt?.outcome && attempt.outcome.result_sha256 === createHash('sha256').update(fs.readFileSync(attempt.result_file)).digest('hex'), 'planner attempt does not bind its saved result');
    const value = JSON.parse(fs.readFileSync(attempt.result_file, 'utf8'));
    validatePlannerResult(value, { root, packageId: value.package_id, attemptId: attempt.attempt_id, subdivisionId: s.id,
      sourceHash: s.planner.input_source_sha256 || attempt.outcome.source_sha256, artifactDirectory: path.dirname(s.inventory_file) });
    require(value.status === 'planned' && value.subtasks.length === s.tasks.length, 'saved planner task count changed');
    for (const [index, task] of s.tasks.entries()) {
      for (const key of ['id', 'title', 'instructions', 'checks', 'checkpoint_file']) require(JSON.stringify(task[key]) === JSON.stringify(value.subtasks[index][key]), 'saved subtask scope differs from accepted planner output');
    }
  }
  for (const task of s.tasks) if (task.accepted) {
    const attempt = task.actor.last_attempt;
    require(path.relative(fs.realpathSync(root), attempt.result_file) === task.accepted.result_file
      && attempt.outcome.result_sha256 === task.accepted.result_sha256 && attempt.outcome.source_sha256 === task.accepted.source_sha256,
    'accepted checkpoint does not match its saved attempt');
    const value = JSON.parse(fs.readFileSync(attempt.result_file, 'utf8'));
    validateSubtaskResult(value, { root, packageId: value.package_id, attemptId: attempt.attempt_id, subdivisionId: s.id, taskId: task.id,
      sourceHash: task.accepted.source_sha256, checkpointFile: task.checkpoint_file, artifactDirectory: path.dirname(s.inventory_file), historical: true });
    require(value.status === 'checkpointed' && value.summary === task.accepted.summary && value.checkpoint_sha256 === task.accepted.sha256,
      'accepted checkpoint metadata differs from recorded evidence');
  }
}
export function subdivisionActor(entry, role) {
  const s = entry.recovery.subdivision;
  if (role === 'planner') return s.planner;
  if (role === 'subtask') return s.tasks[s.next_task].actor;
  if (role === 'finalizer') return s.finalizer;
  return entry;
}
export function compactCheckpoints(entry) {
  const s = entry.recovery.subdivision;
  if (!s) return '';
  const pointer = value => {
    if (!value) return null;
    const marker = '/.codex-plan-runner/';
    const index = value.indexOf(marker);
    return index < 0 ? value : value.slice(index + 1);
  };
  const actorSummary = (role, value, taskId = null) => ({ role, subtask_id: taskId, attempts: value.attempts,
    thread_id: value.thread_id || null, input_source_sha256: value.input_source_sha256 || null,
    last_attempt: value.last_attempt ? { attempt_id: value.last_attempt.attempt_id,
      result_file: pointer(value.last_attempt.result_file), log_file: pointer(value.last_attempt.log_file),
      exit_code: value.last_attempt.exit_code ?? null, finished_at: value.last_attempt.finished_at || null,
      inspect_unknown_effects: !value.last_attempt.finished_at || value.last_attempt.turn_completed !== true || value.last_attempt.turn_failed === true || value.last_attempt.timed_out === true || value.last_attempt.interrupted === true } : null });
  const current = s.tasks[s.next_task];
  return JSON.stringify({ subdivision_id: s.id, partial_inventory: s.inventory_file,
    accepted: s.tasks.slice(0, s.next_task).map(task => ({ id: task.id, summary: task.accepted.summary.slice(0, 1000), checkpoint: task.accepted.file, sha256: task.accepted.sha256, source_sha256: task.accepted.source_sha256 })),
    actors: [actorSummary('planner', s.planner), ...(current ? [actorSummary('subtask', current.actor, current.id)] : []), actorSummary('finalizer', s.finalizer)],
    historical_blockers: (entry.recovery.history || []).filter(record => Array.isArray(record.blockers) && record.blockers.length).slice(-3)
      .map(record => ({ subtask_id: typeof record.subtask_id === 'string' ? record.subtask_id.slice(0, 2) : null,
        summary: String(record.summary || '').slice(0, 1000), blockers: record.blockers.slice(0, 3).map(value => String(value).slice(0, 1000)) })),
    diagnostic: (entry.diagnostic || '').slice(-4000) });
}
