import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  RECOVERY_DEFAULTS, newPackageRecovery, validatePackageRecovery, migrateRecoveryState,
  validateRecoveryDecision, recordProtocolRejection, clearProtocolFeedback,
  protocolCorrectionPrompt, verifyProtocolRejections, currentAttentionReport, recordNoProgress
} from './recovery.mjs';
import { validateWorkerResult } from './protocol.mjs';
import { redact } from './failure-report.mjs';


// Verbatim historical payload; claims in its summary are fixture data, not current acceptance.
const capturedSupervisorDecision = {
  "schema_version": 1,
  "package_id": "01",
  "attempt_id": "15254b06-f4fd-4bfb-93bb-fa856ecb9377",
  "classification": "external",
  "action": "resume",
  "recipe_id": null,
  "summary": "Previous ownership and validation blockers are resolved. Verified all 81 current candidate source identities, parent-local-validation results (392/392 Site; 385/385 portable/generator; metadata passed), audit and independent review hashes. Protected files, retained artifacts and prior worker records remain unchanged. Resume saved worker 01a1d9d0-16f0-7ae1-bb5f-63004ec9c248 for its acceptance assessment and completion records. This supervisor made no corrections and did not complete the package.",
  "changed_files": [],
  "blockers": []
};

const hash = value => createHash('sha256').update(value).digest('hex');
const policy = { packages: { '05': { local_repair: true, recipes: ['npm-checks'] } } };
const step = { id: '05', validation: 'plan/05-validation.json', handoff: 'plan/05-handoff.md' };
const decision = extra => ({ schema_version: 1, package_id: '05', attempt_id: 'attempt-1',
  classification: 'environment', action: 'host-check', recipe_id: 'npm-checks',
  summary: 'Run approved checks.', changed_files: [], blockers: [], ...extra });
const worker = extra => ({ schema_version: 1, package_id: '05', attempt_id: 'attempt-1',
  status: 'completed', summary: 'Actual checks recorded.', validation_file: step.validation,
  handoff_file: step.handoff, blockers: [], ...extra });
const reject = (recovery, n, extra = {}) => recordProtocolRejection(recovery, {
  actor: 'supervisor', attemptId: `attempt-${n}`, file: `logs/rejected-${n}.json`,
  sha256: hash(`rejected-${n}`), error: new Error('host-check contradicts unresolved blockers'), ...extra
});

test('package05 host-check with SQL blockers is rejected without normalizing it', () => {
  const value = decision({ blockers: ['Required SQL acceptance has not run.'] });
  const original = structuredClone(value);
  assert.throws(() => validateRecoveryDecision(value, { packageId: '05', attemptId: 'attempt-1', policy }), /host-check contradicts unresolved blockers/);
  assert.deepEqual(value, original);
  const blocked = decision({ action: 'blocked', recipe_id: null, classification: 'external', blockers: ['The approved service is absent.'] });
  assert.equal(validateRecoveryDecision(blocked, { packageId: '05', attemptId: 'attempt-1', policy }), blocked);
  assert.throws(() => validateRecoveryDecision(decision({ recipe_id: 'unknown-authority' }), { packageId: '05', attemptId: 'attempt-1', policy }), /unknown or unauthorized/);
  assert.throws(() => validateRecoveryDecision(decision({ command: 'arbitrary shell' }), { packageId: '05', attemptId: 'attempt-1', policy }), /exactly/);
});

test('two durable same-actor corrections preserve other budgets and stop at exhaustion', () => {
  assert.equal(RECOVERY_DEFAULTS.maxProtocolRetries, 2);
  let recovery = newPackageRecovery();
  Object.assign(recovery, { phase: 'supervisor', repair_count: 1, transport_count: 3, no_progress_count: 1,
    supervisor: { attempts: 1, thread_id: '00000000-0000-4000-8000-000000000001' } });
  const savedActor = structuredClone(recovery.supervisor);
  assert.equal(reject(recovery, 1), true);
  assert.equal(reject(recovery, 1), true);
  assert.equal(recovery.protocol_retry_count, 1);
  assert.equal(recovery.history.length, 1);
  assert.deepEqual(recovery.supervisor, savedActor);
  assert.equal(recovery.repair_count, 1);
  assert.equal(recovery.transport_count, 3);
  assert.equal(recovery.no_progress_count, 1);
  recovery = JSON.parse(JSON.stringify(recovery));
  validatePackageRecovery(recovery);
  assert.equal(reject(recovery, 2), true);
  assert.equal(reject(recovery, 3), false);
  assert.equal(recovery.protocol_retry_count, 2);
  assert.equal(reject(recovery, 3), false);
  assert.equal(recovery.history.length, 3);
  // Explicit budget increase schedules the same preserved rejection; it never resets usage.
  assert.equal(reject(recovery, 3, { maxRetries: 3 }), true);
  assert.equal(recovery.protocol_retry_count, 3);
  assert.equal(recovery.history.length, 4);
  assert.equal(recovery.history[2].retry_scheduled, false);
  assert.equal(recovery.history[3].retry_scheduled, true);
});

test('exact correction feedback preserves genuine blockers and is scoped to the actor', () => {
  const recovery = newPackageRecovery();
  reject(recovery, 1);
  const prompt = protocolCorrectionPrompt(recovery, 'supervisor');
  assert.match(prompt, /Rejected output: logs\/rejected-1.json/);
  assert.ok(prompt.includes(hash('rejected-1')));
  assert.match(prompt, /host-check contradicts unresolved blockers/);
  assert.match(prompt, /same conversation/);
  assert.match(prompt, /Preserve genuine blockers/);
  assert.equal(protocolCorrectionPrompt(recovery, 'worker'), '');
  clearProtocolFeedback(recovery, 'worker');
  assert.ok(recovery.protocol_feedback);
  clearProtocolFeedback(recovery, 'supervisor');
  assert.equal(protocolCorrectionPrompt(recovery, 'supervisor'), '');
  assert.equal(recovery.protocol_retry_count, 1);
  assert.equal(recovery.history.length, 1);
});

test('rejected-output hashes survive serialization and tampering fails closed', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-rejected-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(root, 'logs/rejected-1.json'), 'rejected-1');
  const recovery = newPackageRecovery();
  reject(recovery, 1);
  assert.equal(verifyProtocolRejections(root, JSON.parse(JSON.stringify(recovery))), true);
  fs.appendFileSync(path.join(root, 'logs/rejected-1.json'), 'changed');
  assert.throws(() => verifyProtocolRejections(root, recovery), /changed or is missing/);
  fs.rmSync(path.join(root, 'logs/rejected-1.json'));
  assert.throws(() => verifyProtocolRejections(root, recovery), /changed or is missing/);
  assert.throws(() => reject(recovery, 2, { file: '../outside.json' }), /identity is invalid/);
});

test('migration adds protocol count only to unfinished entries and preserves completed records', () => {
  const oldRecovery = newPackageRecovery(); delete oldRecovery.protocol_retry_count;
  const completed = { status: 'completed', attempts: 2, recovery: structuredClone(oldRecovery) };
  const state = { steps: { '04': completed, '05': { status: 'blocked', attempts: 3, recovery: structuredClone(oldRecovery) } } };
  const before = JSON.stringify(completed);
  migrateRecoveryState(state, { policyHash: hash('policy'), runtimeHash: hash('runtime') });
  assert.equal(JSON.stringify(state.steps['04']), before);
  assert.equal(state.steps['05'].recovery.protocol_retry_count, 0);
  for (const invalid of [-1, 0.5, '1', null]) assert.throws(() => validatePackageRecovery({ ...newPackageRecovery(), protocol_retry_count: invalid }), /protocol_retry_count/);
  assert.doesNotThrow(() => validatePackageRecovery({ ...newPackageRecovery(), budget_kind: 'protocol' }));
});

test('parent-derived failure IDs and actual gate progress determine strict no-progress', () => {
  let recovery = newPackageRecovery();
  const inputs = { failureIds: ['sql:revocation', 'sql:admission'], executionInputHash: hash('executable-source'),
    verifiedGates: [{ id: 'npm', sha256: hash('npm-evidence') }] };
  assert.equal(recordNoProgress(recovery, inputs), 1);
  recovery = JSON.parse(JSON.stringify(recovery));
  assert.equal(recordNoProgress(recovery, { ...inputs, failureIds: [...inputs.failureIds].reverse(), diagnostic: 'optimistic changed summary', sourceHash: hash('new generated evidence docs') }), 2);
  assert.equal(recordNoProgress(recovery, { ...inputs, verifiedGates: [{ id: 'npm', sha256: hash('same gate refreshed timestamp') }] }), 3);
  assert.equal(recordNoProgress(recovery, { ...inputs, verifiedGates: [...inputs.verifiedGates, { id: 'build', sha256: hash('build-evidence') }] }), 1);
  assert.equal(recordNoProgress(recovery, { ...inputs, executionInputHash: hash('repaired-executable-source') }), 1);
  assert.throws(() => recordNoProgress(recovery, { diagnostic: 'model claims progress', executionInputHash: inputs.executionInputHash, verifiedGates: [] }), /parent-derived/);
});

test('legacy no-progress fingerprint remains compatible with saved recovery counters', () => {
  const diagnostic = 'unchanged failure', sourceHash = hash('source');
  const recovery = { ...newPackageRecovery(), no_progress_count: 1,
    last_failure_fingerprint: hash(JSON.stringify([diagnostic, sourceHash])) };
  assert.equal(recordNoProgress(recovery, { diagnostic, sourceHash }), 2);
});

test('recovered package state makes old attention historical without deleting reports', () => {
  const report = { package_id: '05', attempt: 1, reason: 'bad supervisor JSON' };
  const state = { steps: { '05': { status: 'blocked', attempts: 1,
    recovery: { phase: 'needs-attention', terminal_blocker: report.reason } } } };
  const original = structuredClone(report);
  assert.equal(currentAttentionReport(state, report), true);
  state.steps['05'].attempts = 2;
  assert.equal(currentAttentionReport(state, report), false);
  state.steps['05'] = { status: 'completed', attempts: 2 };
  assert.equal(currentAttentionReport(state, report), false);
  assert.deepEqual(report, original);
  assert.equal(currentAttentionReport(state, { reason: 'unscoped historical guard error' }), false);
});

test('redacted attention matches current raw recovery evidence without changing history', () => {
  for (const field of ['terminal_blocker', 'budget_reason']) {
    const reason = 'Provider authentication: postgresql://fixture:synthetic-report-secret@localhost/database';
    const state = { steps: { '05': { status: 'failed', attempts: 2,
      recovery: { phase: 'needs-attention', [field]: reason } } } };
    const report = { package_id: '05', attempt: 2, reason: redact(reason) };
    const original = structuredClone({ state, report });
    assert.notEqual(report.reason, reason);
    assert.equal(currentAttentionReport(state, report), true);
    assert.equal(currentAttentionReport(state, { ...report, reason }), true, 'Legacy raw reports remain readable');
    assert.equal(currentAttentionReport(state, { ...report, reason: 'Different unresolved failure' }), false);
    assert.equal(currentAttentionReport(state, { ...report, attempt: 1 }), false);
    assert.deepEqual({ state, report }, original);
    state.steps['05'].recovery.phase = 'worker';
    assert.equal(currentAttentionReport(state, report), false);
    state.steps['05'].recovery.phase = 'needs-attention';
    state.steps['05'].status = 'completed';
    assert.equal(currentAttentionReport(state, report), false);
  }
});

test('worker wire validation distinguishes legitimate noncompletion from protocol errors', () => {
  const context = { step, attemptId: 'attempt-1' };
  assert.equal(validateWorkerResult(worker(), context).status, 'completed');
  assert.equal(validateWorkerResult(worker({ status: 'blocked', blockers: ['Approved fixture is unavailable.'] }), context).status, 'blocked');
  assert.equal(validateWorkerResult(worker({ status: 'incomplete' }), context).status, 'incomplete');
  for (const value of [null, [], 'text', worker({ extra: true }), worker({ attempt_id: 'old-attempt' }),
    worker({ status: 'completed', blockers: ['SQL has not run.'] }), worker({ status: 'blocked' }),
    worker({ blockers: 'wrong-type' }), worker({ validation_file: '../other.json' })]) {
    assert.throws(() => validateWorkerResult(value, context), /Invalid worker result:/);
  }
});

test('captured external-resume decision keeps exact bytes and corrects only through the original actor budget', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'captured-supervisor-replay-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'logs'));
  const original = JSON.stringify(capturedSupervisorDecision);
  fs.writeFileSync(path.join(root, 'logs/rejected.json'), original);
  const context = { packageId: capturedSupervisorDecision.package_id, attemptId: capturedSupervisorDecision.attempt_id,
    policy: { packages: { '01': { local_repair: true, recipes: ['npm-checks'] } } } };
  let rejection;
  assert.throws(() => { try { validateRecoveryDecision(capturedSupervisorDecision, context); } catch (error) { rejection = error; throw error; } }, /external classification cannot execute recovery/);
  let recovery = newPackageRecovery();
  Object.assign(recovery, { phase: 'supervisor', repair_count: 1, transport_count: 3,
    evidence_refresh_count: 1, no_progress_count: 1,
    supervisor: { attempts: 1, thread_id: '00000000-0000-4000-8000-000000000001' } });
  const saved = structuredClone(recovery);
  assert.equal(recordProtocolRejection(recovery, { actor: 'supervisor', attemptId: context.attemptId,
    file: 'logs/rejected.json', sha256: hash(original), error: rejection }), true);
  recovery = JSON.parse(JSON.stringify(recovery));
  validatePackageRecovery(recovery);
  assert.equal(verifyProtocolRejections(root, recovery), true);
  assert.equal(recovery.protocol_retry_count, 1);
  for (const field of ['repair_count', 'transport_count', 'evidence_refresh_count', 'no_progress_count', 'supervisor']) assert.deepEqual(recovery[field], saved[field]);
  assert.equal(recovery.decisions.length, 0, 'Rejected output never becomes executable authority');
  assert.match(protocolCorrectionPrompt(recovery, 'supervisor'), /external classification cannot execute recovery/);
  const corrected = { ...capturedSupervisorDecision, classification: 'implementation' };
  assert.equal(validateRecoveryDecision(corrected, context), corrected);
  clearProtocolFeedback(recovery, 'supervisor');
  assert.equal(recovery.protocol_retry_count, 1);
  assert.equal(recovery.repair_count, 1);
  assert.equal(fs.readFileSync(path.join(root, 'logs/rejected.json'), 'utf8'), original);
  assert.equal(JSON.stringify(capturedSupervisorDecision), original);
});
