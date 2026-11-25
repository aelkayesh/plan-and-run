import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { classifyFailure } from './protocol.mjs';
import { validateSubdivisionRecovery, subdivisionArtifacts, verifySubdivisionArtifacts, subdivisionActor, compactCheckpoints } from './subdivision-state.mjs';
import { SUBDIVISION_DEFAULTS, classifyTokenPressure, plannerResultSchema, subtaskResultSchema, checkpointSchema,
  validatePlannerResult, validateSubtaskResult, validateCheckpoint, subdivisionPath } from './subdivision.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const attemptId = '12345678-1234-1234-1234-123456789abc';
const subdivisionId = '23456789-2345-2345-2345-23456789abcd';
const sourceHash = hash('current source inventory');
const artifactDirectory = '.codex-plan-runner/synthetic/subdivision';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'subdivision-protocol-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, packageId: '01', attemptId, subdivisionId, sourceHash, artifactDirectory };
}
const identity = () => ({ schema_version: 1, package_id: '01', attempt_id: attemptId, subdivision_id: subdivisionId });
const task = index => ({ id: String(index).padStart(2, '0'), title: `Bounded change ${index}`,
  instructions: 'Inspect partial effects and implement only this bounded prerequisite.', checks: ['Run the focused local check.'],
  checkpoint_file: `${artifactDirectory}/task-${index}.json` });
const planner = overrides => ({ ...identity(), status: 'planned', summary: 'Two sequential portions of the remaining scope.',
  source_sha256: sourceHash, subtasks: [task(1), task(2)], blockers: [], ...overrides });
function taskResult(context, overrides = {}, checkpointOverrides = {}) {
  const value = { ...identity(), subtask_id: '01', status: 'checkpointed', summary: 'Inspected existing effects and checked the bounded source change.',
    source_sha256: sourceHash, changed_files: ['lib/synthetic.mjs'], checks: [{ command: 'node --test focused.test.mjs', exit_code: 0, passed: true }],
    checkpoint_file: task(1).checkpoint_file, checkpoint_sha256: hash('pending'), blockers: [], ...overrides };
  const checkpoint = Object.fromEntries(checkpointSchema.required.map(key => [key, key === 'next_steps' ? ['Perform the second bounded change.'] : value[key]]));
  Object.assign(checkpoint, checkpointOverrides);
  const file = path.join(context.root, value.checkpoint_file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = JSON.stringify(checkpoint);
  fs.writeFileSync(file, bytes);
  value.checkpoint_sha256 = hash(bytes);
  return value;
}
const taskContext = context => ({ ...context, taskId: '01', checkpointFile: task(1).checkpoint_file });

test('explicit per-minute token pressure is separate from generic token, RPM, configuration and billing diagnostics', () => {
  const message = 'Reconnecting... 2/5 (rate limit exceeded: Rate limit reached on tokens per min (TPM): Limit 1000000, Used 956049, Requested 73584. Please try again in 1.778s)';
  const failure = classifyFailure({ errors: [{ type: 'error', message }] });
  assert.deepEqual(classifyTokenPressure(failure), { explicit: true, oversized: false });
  for (const message of ['Too many requests: 429 requests per minute', 'Token rate limit exceeded', 'Rate limit reached; try later',
    'Invalid API key; tokens per minute (TPM)', 'Billing credit limit exceeded; TPM', 'Unsupported model TPM configuration']) {
    assert.deepEqual(classifyTokenPressure(classifyFailure({ stderr: message })), { explicit: false, oversized: false }, message);
  }
  assert.deepEqual(classifyTokenPressure({ kind: 'rate-limit', message: 'token/min limit reached' }), { explicit: true, oversized: false });
  assert.deepEqual(classifyTokenPressure({ kind: 'transport', message: 'TPM stream disconnected' }), { explicit: false, oversized: false });
  assert.deepEqual(classifyTokenPressure(), { explicit: false, oversized: false });
});

test('one explicit request exceeding its TPM ceiling is oversized but accumulated usage is not', () => {
  for (const message of ['Request too large for tokens per min (TPM): Limit 1000000, Requested 1200000',
    'rate limit exceeded on TPM: Limit 1,000,000; Requested 1,200,000']) {
    assert.deepEqual(classifyTokenPressure(classifyFailure({ stderr: message })), { explicit: true, oversized: true });
  }
  assert.deepEqual(classifyTokenPressure({ kind: 'rate-limit', message: 'tokens per minute: Limit 1000000, Used 990000, Requested 73584' }), { explicit: true, oversized: false });
  assert.deepEqual(classifyTokenPressure({ kind: 'configuration', message: 'Request too large for TPM: Limit 1 Requested 2' }), { explicit: false, oversized: false });
  assert.deepEqual(classifyTokenPressure({ kind: 'failure', message: 'Request too large for context window' }), { explicit: false, oversized: false });
});

test('subdivision defaults bound rate retries, planning and fresh thread rotations', () => {
  assert.deepEqual(SUBDIVISION_DEFAULTS, { threshold: 2, maxSubdivisions: 1, maxRotations: 3, maxRateRetries: 8 });
  assert.equal(Object.isFrozen(SUBDIVISION_DEFAULTS), true);
});

test('planner schema accepts only two to six sequential bounded tasks with frozen identities', t => {
  const context = fixture(t);
  assert.equal(plannerResultSchema.additionalProperties, false);
  assert.equal(validatePlannerResult(planner(), context).subtasks.length, 2);
  assert.equal(validatePlannerResult(planner({ subtasks: Array.from({ length: 6 }, (_, index) => task(index + 1)) }), context).subtasks.length, 6);
  const blocked = planner({ status: 'blocked', subtasks: [], blockers: ['Contract does not permit the required external mutation.'] });
  assert.equal(validatePlannerResult(blocked, context).status, 'blocked');
  for (const invalid of [planner({ subtasks: [] }), planner({ subtasks: [task(1)] }), planner({ subtasks: Array.from({ length: 7 }, (_, index) => task(index + 1)) }),
    planner({ package_id: '02' }), planner({ attempt_id: 'stale' }), planner({ subdivision_id: attemptId }), planner({ source_sha256: hash('old source') }),
    planner({ status: 'completed' }), planner({ status: 'blocked' }), planner({ blockers: ['Unknown result'] }), planner({ summary: ' '.repeat(20) }),
    planner({ summary: 'x'.repeat(4001) }), planner({ subtasks: [task(2), task(1)] }), planner({ subtasks: [task(1), task(1)] }),
    planner({ subtasks: [{ ...task(1), instructions: 'x'.repeat(6001) }, task(2)] }), planner({ subtasks: [{ ...task(1), checks: [] }, task(2)] })]) {
    assert.throws(() => validatePlannerResult(invalid, context), /Invalid subdivision/);
  }
});

test('planner cannot add commands, model/provider overrides or final package fields', t => {
  const context = fixture(t);
  for (const extra of [{ command: 'sh arbitrary' }, { model: 'larger' }, { provider: 'azure' }, { validation_file: 'final.json' }, { acceptance: [] }]) {
    assert.throws(() => validatePlannerResult(planner(extra), context), /exactly the planner schema keys/);
    assert.throws(() => validatePlannerResult(planner({ subtasks: [{ ...task(1), ...extra }, task(2)] }), context), /subtask plan keys/);
  }
});

test('artifact paths reject traversal, absolute paths, aliases, control characters and symlinks', t => {
  const context = fixture(t);
  for (const checkpoint_file of ['../outside.json', '/tmp/outside.json', 'C:\\escape.json', './same.json', 'dir//same.json', 'dir/../same.json', 'dir/./same.json', 'dir/bad\n.json', 'unrelated/final.json']) {
    assert.throws(() => validatePlannerResult(planner({ subtasks: [{ ...task(1), checkpoint_file }, task(2)] }), context), /Invalid subdivision/);
  }
  fs.mkdirSync(path.join(context.root, artifactDirectory), { recursive: true });
  fs.symlinkSync(os.tmpdir(), path.join(context.root, artifactDirectory, 'escaped'));
  assert.throws(() => subdivisionPath(context.root, `${artifactDirectory}/escaped/file.json`), /symlink/);
  fs.symlinkSync(path.join(context.root, 'missing'), path.join(context.root, artifactDirectory, 'broken'));
  assert.throws(() => subdivisionPath(context.root, `${artifactDirectory}/broken/file.json`), /symlink/);
  fs.mkdirSync(path.join(context.root, 'actual'));
  fs.symlinkSync(path.join(context.root, 'actual'), path.join(context.root, artifactDirectory, 'inside'));
  assert.throws(() => subdivisionPath(context.root, `${artifactDirectory}/inside/file.json`), /symlink/);
});

test('checkpoint evidence is hash-bound, source-bound and cannot complete its parent', t => {
  const context = fixture(t), validate = value => validateSubtaskResult(value, taskContext(context));
  const value = taskResult(context);
  assert.equal(subtaskResultSchema.additionalProperties, false);
  assert.equal(validate(value).status, 'checkpointed');
  for (const overrides of [{ status: 'completed' }, { subtask_id: '02' }, { attempt_id: subdivisionId }, { source_sha256: hash('old source') },
    { checks: [] }, { blockers: ['Unresolved result'] }, { changed_files: ['../outside'] }, { changed_files: ['lib/x', 'lib/x'] },
    { checks: [{ command: 'node focused.mjs', exit_code: 1, passed: true }] }, { checks: [{ command: 'node focused.mjs', exit_code: 1, passed: false }] },
    { checks: [{ command: 'node focused.mjs', exit_code: 0, passed: true, origin: 'invented' }] }, { checkpoint_sha256: hash('wrong') },
    { provider: 'azure' }, { model: 'larger' }, { validation_file: 'original-final.json' }]) {
    assert.throws(() => validate({ ...value, ...overrides }), /Invalid subdivision/);
  }
  fs.appendFileSync(path.join(context.root, value.checkpoint_file), '\n ');
  assert.throws(() => validate(value), /checkpoint hash mismatch/);
});

test('legitimate blocked subtasks carry check and checkpoint evidence without a completion claim', t => {
  const context = fixture(t);
  const value = taskResult(context, { status: 'blocked', blockers: ['Sandbox cannot bind localhost.'], checks: [{ command: 'node local-check.mjs', exit_code: 1, passed: false }] });
  assert.equal(validateSubtaskResult(value, taskContext(context)).status, 'blocked');
  assert.throws(() => validateSubtaskResult(taskResult(context, { status: 'blocked', blockers: [] }), taskContext(context)), /must identify blockers/);
  assert.equal(validateSubtaskResult(taskResult(context, { status: 'failed', checks: [] }), taskContext(context)).status, 'failed');
});

test('checkpoint JSON must match result identities, evidence, bounded next steps and planned location', t => {
  const context = fixture(t), validate = value => validateSubtaskResult(value, taskContext(context));
  for (const checkpointOverride of [{ source_sha256: hash('stale') }, { attempt_id: subdivisionId }, { summary: 'Different summary' },
    { changed_files: [] }, { checks: [] }, { blockers: ['Missing permission'] }, { next_steps: Array(13).fill('More work') }, { command: 'sh arbitrary' }]) {
    assert.throws(() => validate(taskResult(context, {}, checkpointOverride)), /Invalid subdivision/);
  }
  assert.throws(() => validate(taskResult(context, { checkpoint_file: `${artifactDirectory}/another.json` })), /planned path/);
  const value = taskResult(context), file = path.join(context.root, value.checkpoint_file);
  fs.writeFileSync(file, 'malformed'); value.checkpoint_sha256 = hash('malformed');
  assert.throws(() => validate(value), /not valid JSON/);
  fs.writeFileSync(file, 'x'.repeat(33 * 1024)); value.checkpoint_sha256 = hash(fs.readFileSync(file));
  assert.throws(() => validate(value), /bounded size/);
});

test('historical checkpoints validate their recorded source identity rather than later source', t => {
  const context = fixture(t), value = taskResult(context);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(context.root, value.checkpoint_file), 'utf8'));
  assert.equal(validateCheckpoint(checkpoint, taskContext(context)), checkpoint);
  assert.throws(() => validateCheckpoint(checkpoint, { ...taskContext(context), sourceHash: hash('later accepted task source') }), /stale/);
  // Parent verifies the saved result/checkpoint hashes and uses its recorded source here;
  // only the latest accepted task is compared with current source before continuing.
  assert.equal(validateSubtaskResult(value, taskContext(context)), value);
});

function recoveryFixture(context, { populated = false } = {}) {
  const write = (file, value) => {
    const absolute = path.join(context.root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, value);
    return { file, sha256: hash(value) };
  };
  const inventory = write(`${artifactDirectory}/inventory.json`, JSON.stringify({ source_sha256: sourceHash }));
  const r = { phase: 'planner', return_actor: 'planner', tpm_failure_count: 2, tpm_streak: 0, last_tpm_attempt: attemptId,
    subdivision: { schema_version: 1, id: subdivisionId, count: 1, rotation_count: 0, rotations: [],
      inventory_file: inventory.file, inventory_sha256: inventory.sha256, source_sha256: sourceHash,
      planner: { attempts: 0 }, finalizer: { attempts: 0 }, tasks: [], next_task: 0, artifacts: [] } };
  const attempt = (role, result, extra = {}) => {
    const prefix = `.codex-plan-runner/synthetic/logs/${role}-${attemptId}`;
    const evidence = write(`${prefix}-result.json`, JSON.stringify(result));
    const log = write(`${prefix}.jsonl`, '{"type":"turn.completed"}\n');
    return { role, attempt_id: attemptId, result_file: path.join(context.root, evidence.file), log_file: path.join(context.root, log.file),
      started_at: '2026-11-13T10:00:00.000Z', exit_code: 0, turn_completed: true, turn_failed: false, finished_at: '2026-11-13T10:00:01.000Z',
      outcome: { source_sha256: sourceHash, result_sha256: evidence.sha256, ...extra } };
  };
  if (populated) {
    const value = planner(), s = r.subdivision;
    s.planner = { attempts: 1, input_source_sha256: sourceHash, thread_id: attemptId, last_attempt: attempt('planner', value) };
    s.artifacts.push({ file: path.relative(context.root, s.planner.last_attempt.result_file), sha256: s.planner.last_attempt.outcome.result_sha256 });
    s.tasks = value.subtasks.map(task => ({ ...task, actor: { attempts: 0 }, accepted: null }));
    const result = taskResult(context), task = s.tasks[0];
    task.actor = { attempts: 1, thread_id: subdivisionId, input_source_sha256: sourceHash, last_attempt: attempt('subtask', result, { checkpoint_sha256: result.checkpoint_sha256 }) };
    task.accepted = { file: result.checkpoint_file, sha256: result.checkpoint_sha256, result_file: path.relative(context.root, task.actor.last_attempt.result_file),
      result_sha256: task.actor.last_attempt.outcome.result_sha256, source_sha256: sourceHash, summary: result.summary };
    s.next_task = 1; r.phase = 'subtask'; r.return_actor = 'subtask';
  }
  return r;
}

test('subdivision state validation is additive for legacy entries and accepts bounded actor checkpoints', t => {
  const legacy = { phase: 'worker' }, saved = structuredClone(legacy);
  validateSubdivisionRecovery(legacy);
  assert.deepEqual(legacy, saved);
  const context = fixture(t), r = recoveryFixture(context, { populated: true });
  validateSubdivisionRecovery(r); verifySubdivisionArtifacts(context.root, r);
  assert.equal(subdivisionArtifacts(r).length, 4, 'inventory, planner result and both accepted checkpoint artifacts are protected');
  assert.equal(subdivisionActor({ recovery: r }, 'subtask'), r.subdivision.tasks[1].actor);
  const compact = JSON.parse(compactCheckpoints({ recovery: r, diagnostic: 'x'.repeat(5000) }));
  assert.equal(compact.accepted.length, 1); assert.equal(compact.diagnostic.length, 4000);
  assert.equal(compact.accepted[0].source_sha256, sourceHash);
});

test('state bounds task scope, checks, summaries, counters, identities and actor records', t => {
  const context = fixture(t), base = recoveryFixture(context, { populated: true });
  const valid = structuredClone(base);
  valid.subdivision.tasks[1].instructions = 'x'.repeat(6000);
  validateSubdivisionRecovery(valid);
  const mutations = [
    r => { r.return_actor = 'supervisor'; }, r => { r.waiting_actor = 'host'; }, r => { r.rotate_pending = 'worker'; },
    r => { r.tpm_streak_actor = 'host'; }, r => { r.last_tpm_attempt = 'stale'; }, r => { r.tpm_failure_count = -1; },
    r => { r.subdivision.count = 2; }, r => { r.subdivision.id = 'stale'; }, r => { r.subdivision.provider = 'azure'; },
    r => { r.subdivision.next_task = 2; }, r => { r.subdivision.tasks[1].instructions = 'x'.repeat(6001); },
    r => { r.subdivision.tasks[1].checks = []; }, r => { r.subdivision.tasks[1].checks = ['x'.repeat(1001)]; },
    r => { r.subdivision.tasks[1].checks = [{ command: 'arbitrary parent shell' }]; }, r => { r.subdivision.tasks[1].title = ' '; },
    r => { r.subdivision.tasks[1].checkpoint_file = r.subdivision.tasks[0].checkpoint_file; },
    r => { r.subdivision.tasks[0].accepted.summary = 'x'.repeat(4001); }, r => { r.subdivision.tasks[0].accepted.file = 'other/checkpoint.json'; },
    r => { r.subdivision.planner.model = 'larger'; }, r => { r.subdivision.planner.thread_id = 'stale'; },
    r => { r.subdivision.planner.attempts = 0; }, r => { r.subdivision.planner.input_source_sha256 = 'invalid'; },
    r => { r.subdivision.planner.last_attempt.role = 'worker'; }, r => { r.subdivision.planner.last_attempt.attempt_id = 'stale'; },
    r => { r.subdivision.planner.last_attempt.result_file = '../outside.json'; }, r => { r.subdivision.planner.last_attempt.started_at = 'today'; },
    r => { r.subdivision.planner.last_attempt.outcome.source_sha256 = 'invalid'; }, r => { r.subdivision.planner.last_attempt.turn_completed = false; },
    r => { r.subdivision.planner.last_attempt.outcome.handoff_sha256 = hash('forbidden planner completion'); },
    r => { r.subdivision.tasks[0].actor.last_attempt.outcome.checkpoint_sha256 = 'invalid'; },
    r => { r.subdivision.artifacts[0].file = 'dir\\escaped'; }, r => { r.subdivision.artifacts.push({ ...r.subdivision.artifacts[0], sha256: hash('conflict') }); }
  ];
  for (const mutate of mutations) {
    const r = structuredClone(base); mutate(r);
    assert.throws(() => validateSubdivisionRecovery(r), /Invalid subdivision state/);
  }
  const oversized = structuredClone(base); oversized.subdivision.tasks[0].instructions = 'x'.repeat(257 * 1024);
  assert.throws(() => validateSubdivisionRecovery(oversized), /bounded size/);
});

test('durable rotations validate role, thread, source, attempt and finite budget', t => {
  const context = fixture(t), base = recoveryFixture(context, { populated: true });
  const rotation = { role: 'planner', previous_thread: attemptId, source_sha256: sourceHash, last_attempt: base.subdivision.planner.last_attempt };
  base.rotate_pending = 'supervisor'; base.tpm_streak_actor = 'supervisor'; base.waiting_actor = 'supervisor';
  base.subdivision.rotations = [rotation]; base.subdivision.rotation_count = 1;
  validateSubdivisionRecovery(base);
  for (const change of [{ role: 'worker' }, { previous_thread: 'unknown' }, { source_sha256: 'unknown' }, { last_attempt: { role: 'planner' } }, { provider: 'azure' }]) {
    const r = structuredClone(base); Object.assign(r.subdivision.rotations[0], change);
    assert.throws(() => validateSubdivisionRecovery(r), /Invalid subdivision state/);
  }
  const mismatch = structuredClone(base); mismatch.subdivision.rotation_count = 2;
  assert.throws(() => validateSubdivisionRecovery(mismatch), /rotation history/);
  const exhausted = structuredClone(base); exhausted.subdivision.rotation_count = 101;
  exhausted.subdivision.rotations = Array.from({ length: 101 }, () => ({ role: 'planner', previous_thread: null, source_sha256: sourceHash, last_attempt: null }));
  assert.throws(() => validateSubdivisionRecovery(exhausted), /rotation history/);
});

test('accepted historical evidence remains valid after later source edits but not metadata or artifact tampering', t => {
  const context = fixture(t), base = recoveryFixture(context, { populated: true });
  fs.writeFileSync(path.join(context.root, 'later-source.mjs'), 'export const later = true;');
  verifySubdivisionArtifacts(context.root, base);
  const summary = structuredClone(base); summary.subdivision.tasks[0].accepted.summary = 'Invented checkpoint summary';
  assert.throws(() => verifySubdivisionArtifacts(context.root, summary), /metadata differs/);
  const staleSource = structuredClone(base); staleSource.subdivision.tasks[0].accepted.source_sha256 = hash('changed historical source');
  assert.throws(() => verifySubdivisionArtifacts(context.root, staleSource), /saved attempt/);
  const scope = structuredClone(base); scope.subdivision.tasks[1].instructions = 'Change the original package acceptance.';
  assert.throws(() => verifySubdivisionArtifacts(context.root, scope), /scope differs/);
  const outside = structuredClone(base); outside.subdivision.planner.last_attempt.result_file = '/tmp/foreign-result.json';
  outside.subdivision.planner.last_attempt.log_file = '/tmp/foreign-log.jsonl';
  assert.throws(() => verifySubdivisionArtifacts(context.root, outside), /path escapes repository/);
  const file = path.join(context.root, base.subdivision.tasks[0].accepted.file);
  fs.appendFileSync(file, '\n ');
  assert.throws(() => verifySubdivisionArtifacts(context.root, base), /evidence changed/);
});

test('accepted artifact verification rejects symlink aliases inside the repository', t => {
  const context = fixture(t), r = recoveryFixture(context);
  const file = path.join(context.root, r.subdivision.inventory_file), target = file + '.original';
  fs.renameSync(file, target); fs.symlinkSync(target, file);
  assert.throws(() => verifySubdivisionArtifacts(context.root, r), /symlink/);
});

test('compact prompts carry bounded pending-attempt pointers and blocker history without transcript replay', t => {
  const context = fixture(t), r = recoveryFixture(context, { populated: true });
  r.subdivision.tasks[1].actor = { attempts: 1, thread_id: attemptId, input_source_sha256: sourceHash,
    last_attempt: { role: 'subtask', attempt_id: attemptId, result_file: `${context.root}/.codex-plan-runner/synthetic/logs/pending-result.json`,
      log_file: `${context.root}/.codex-plan-runner/synthetic/logs/pending.jsonl`, started_at: '2026-11-13T10:00:00.000Z' } };
  r.history = Array.from({ length: 5 }, (_, index) => ({ subtask_id: '02', summary: `Prior restriction ${index}`, blockers: ['x'.repeat(2000)] }));
  const compact = JSON.parse(compactCheckpoints({ recovery: r, diagnostic: 'Inspect the unfinished tool effects.' }));
  const pending = compact.actors.find(actor => actor.role === 'subtask');
  assert.equal(pending.subtask_id, '02'); assert.equal(pending.thread_id, attemptId);
  assert.equal(pending.input_source_sha256, sourceHash); assert.equal(pending.last_attempt.attempt_id, attemptId);
  assert.equal(pending.last_attempt.inspect_unknown_effects, true);
  assert.equal(pending.last_attempt.log_file, '.codex-plan-runner/synthetic/logs/pending.jsonl');
  assert.equal(pending.last_attempt.result_file, '.codex-plan-runner/synthetic/logs/pending-result.json');
  assert.equal(compact.historical_blockers.length, 3);
  assert.equal(compact.historical_blockers[0].summary, 'Prior restriction 2');
  assert.equal(compact.historical_blockers[0].blockers[0].length, 1000);
  assert.equal(Object.hasOwn(pending.last_attempt, 'stdout'), false);
});

test('historical changed-file metadata survives later source symlinks while checkpoint symlinks remain forbidden', t => {
  const context = fixture(t), r = recoveryFixture(context, { populated: true });
  const accepted = r.subdivision.tasks[0].accepted;
  const result = JSON.parse(fs.readFileSync(path.join(context.root, accepted.result_file), 'utf8'));
  const sourceFile = path.join(context.root, result.changed_files[0]);
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'export const before = true;');
  verifySubdivisionArtifacts(context.root, r);
  const laterSource = path.join(context.root, 'later-source.mjs');
  fs.writeFileSync(laterSource, 'export const after = true;');
  fs.unlinkSync(sourceFile);
  fs.symlinkSync(laterSource, sourceFile);
  assert.equal(fs.lstatSync(sourceFile).isSymbolicLink(), true);
  assert.throws(() => validateSubtaskResult(result, taskContext(context)), /symlink/, 'new result validation still inspects current changed paths');
  verifySubdivisionArtifacts(context.root, r);
  assert.throws(() => validateSubtaskResult({ ...result, changed_files: ['../outside'] }, { ...taskContext(context), historical: true }), /canonical/, 'historical metadata still rejects lexical escapes');
  const checkpoint = path.join(context.root, accepted.file), retained = checkpoint + '.retained';
  fs.renameSync(checkpoint, retained);
  fs.symlinkSync(retained, checkpoint);
  assert.throws(() => verifySubdivisionArtifacts(context.root, r), /symlink/, 'hash-equivalent checkpoint aliases remain forbidden');
});


test('host evidence deferral is typed and only valid for completed evidence between subtasks', t => {
  const context = fixture(t), base = recoveryFixture(context, { populated: true });
  base.pending_evidence = { file: '.codex-plan-runner/host/evidence.json', sha256: sourceHash };
  base.host_evidence_deferred = true;
  validateSubdivisionRecovery(base);
  for (const change of [r => { r.host_evidence_deferred = 'true'; }, r => { r.pending_evidence.file = null; },
    r => { delete r.subdivision; }, r => { r.phase = 'host'; }, r => { r.phase = 'finalizer'; },
    r => { r.subdivision.next_task = 0; }, r => { r.subdivision.next_task = r.subdivision.tasks.length; }]) {
    const r = structuredClone(base); change(r); assert.throws(() => validateSubdivisionRecovery(r), /host evidence deferral/);
  }
  validateSubdivisionRecovery({ phase: 'worker', host_evidence_deferred: false });
});
