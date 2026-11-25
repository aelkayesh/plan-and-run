import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateWorkerResult, validateCompletion, resultSchema } from './protocol.mjs';
import { validateAcceptanceProfile } from './acceptance-policy.mjs';
import { validateRecoveryDecision, recoveryResultSchema, validateAcceptanceRequest,
  verifyAcceptanceRequests, newPackageRecovery, validatePackageRecovery, migrateRecoveryState } from './recovery.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const attemptId = '00000000-0000-4000-8000-000000000001';
const step = { id: '06', manual: false, validation: 'plan/06-validation.json', handoff: 'plan/06-handoff.md' };
const profile = validateAcceptanceProfile({ schema_version: 1, mode: 'strict', packages: { '06': {
  required_gates: [{ id: 'npm', capability: 'npm-checks' }, { id: 'sql', capability: 'synthetic-postgres' }, { id: 'build', capability: 'production-build' }],
  criteria: [{ id: 'suite', type: 'suite', purpose: 'Run the full suite.', gate_ids: ['npm'] },
    { id: 'saved', type: 'persistence', purpose: 'Persist data correctly.', gate_ids: ['sql'] },
    { id: 'release', type: 'build', purpose: 'Build production source.', gate_ids: ['build'] }]
} } }, [step]);
const policy = { packages: { '06': { local_repair: true, recipes: [] } } };
const context = { step, attemptId, acceptanceProfile: profile };
const worker = extra => ({ schema_version: 1, package_id: step.id, attempt_id: attemptId,
  status: 'acceptance-ready', summary: 'Implementation and mapping are ready for configured parent checks.',
  validation_file: step.validation, handoff_file: step.handoff, blockers: [], ...extra });
const supervisor = extra => ({ schema_version: 1, package_id: step.id, attempt_id: attemptId,
  classification: 'environment', action: 'acceptance-check', recipe_id: null,
  summary: 'The remaining checks belong to the configured parent profile.', changed_files: [], blockers: [], ...extra });
const recoveryContext = { ...context, packageId: step.id, policy };
const request = extra => ({ schema_version: 1, package_id: step.id, attempt_id: attemptId,
  actor: 'worker', thread_id: '00000000-0000-4000-8000-000000000002', origin: 'worker',
  file: 'logs/request.json', sha256: hash('request'), profile_sha256: hash(JSON.stringify(profile.packages[step.id])), ...extra });

test('acceptance-ready is a strict noncompletion wire result with no required final receipt', () => {
  assert.ok(resultSchema.properties.status.enum.includes('acceptance-ready'));
  assert.equal(validateWorkerResult(worker(), context).status, 'acceptance-ready');
  assert.throws(() => validateCompletion({ result: worker(), receipt: undefined, handoff: undefined,
    step, attemptId, head: 'synthetic-head' }), /result status must be completed/);
});

test('worker handoff rejects legacy, absent, other-package and manual authority', () => {
  for (const supplied of [undefined, { schema_version: 1, mode: 'legacy', packages: {} },
    { ...profile, packages: { '07': profile.packages['06'] } }]) {
    assert.throws(() => validateWorkerResult(worker(), { ...context, acceptanceProfile: supplied }), /strict nonmanual package profile/);
  }
  assert.throws(() => validateWorkerResult(worker(), { ...context, step: { ...step, manual: true } }), /strict nonmanual package profile/);
});

test('worker handoff never strips external blockers or accepts arbitrary execution fields', () => {
  for (const value of [worker({ blockers: ['Required approval is absent.'] }), worker({ command: 'arbitrary' }),
    worker({ recipe_id: 'npm-checks' }), worker({ profile: profile }), worker({ validation_file: 'elsewhere.json' })]) {
    const before = structuredClone(value);
    assert.throws(() => validateWorkerResult(value, context), /Invalid worker result/);
    assert.deepEqual(value, before);
  }
  const blocked = worker({ status: 'blocked', blockers: ['Required approval is absent.'] });
  assert.equal(validateWorkerResult(blocked, context).status, 'blocked');
});

test('explicit supervisor acceptance-check uses strict capabilities without inventing legacy recipes', () => {
  assert.ok(recoveryResultSchema.properties.action.enum.includes('acceptance-check'));
  assert.equal(validateRecoveryDecision(supervisor(), recoveryContext).action, 'acceptance-check');
  assert.deepEqual(policy.packages['06'].recipes, []);
  assert.throws(() => validateRecoveryDecision(supervisor({ action: 'host-check', recipe_id: 'synthetic-postgres' }), recoveryContext), /unknown or unauthorized host recipe/);
});

test('supervisor acceptance-check rejects external, arbitrary and contradictory requests unchanged', () => {
  for (const value of [supervisor({ classification: 'external' }), supervisor({ classification: 'implementation' }),
    supervisor({ blockers: ['Missing required service.'] }), supervisor({ recipe_id: 'npm-checks' }),
    supervisor({ command: 'arbitrary' }), supervisor({ argv: ['npm', 'install'] }), supervisor({ profile }),
    supervisor({ package_id: '07' }), supervisor({ attempt_id: 'stale' })]) {
    const before = structuredClone(value);
    assert.throws(() => validateRecoveryDecision(value, recoveryContext), /Invalid recovery/);
    assert.deepEqual(value, before);
  }
  assert.equal(validateRecoveryDecision(supervisor({ action: 'blocked', classification: 'external', blockers: ['Missing service.'] }), recoveryContext).action, 'blocked');
});

test('supervisor acceptance-check cannot borrow legacy, missing, mismatched or manual authority', () => {
  for (const extra of [{ acceptanceProfile: undefined }, { acceptanceProfile: { mode: 'legacy', packages: {} } },
    { acceptanceProfile: { ...profile, packages: {} } }, { step: undefined },
    { step: { ...step, id: '07' } }, { step: { ...step, manual: true } }]) {
    assert.throws(() => validateRecoveryDecision(supervisor(), { ...recoveryContext, ...extra }), /strict nonmanual package profile/);
  }
});

test('durable parent request retains original actor and finite budgets across serialization', () => {
  const recovery = { ...newPackageRecovery(), phase: 'acceptance', acceptance_request: request(),
    repair_count: 2, transport_count: 3, protocol_retry_count: 1, evidence_refresh_count: 2,
    no_progress_count: 1, resume_phase: 'acceptance', return_actor: 'worker',
    history: [{ action: 'acceptance-request', request: request({ origin: 'supervisor' }) }] };
  const state = { steps: { '06': { status: 'running', attempts: 2, recovery } } };
  const identities = { policyHash: hash('policy'), runtimeHash: hash('runtime') };
  migrateRecoveryState(state, identities);
  const serialized = JSON.parse(JSON.stringify(state));
  migrateRecoveryState(serialized, identities);
  assert.deepEqual(serialized, state);
  assert.equal(validateAcceptanceRequest(request({ actor: 'finalizer', origin: 'supervisor', thread_id: null })).actor, 'finalizer');
});

test('request state fails closed for malformed identity, actor, paths, commands and absent request', () => {
  for (const extra of [{ schema_version: 2 }, { package_id: '6' }, { attempt_id: 'old' }, { actor: 'subtask' },
    { thread_id: 'unknown' }, { origin: 'external' }, { file: '../outside' }, { file: '/absolute' },
    { file: 'logs//request.json' }, { file: 'logs/./request.json' }, { sha256: 'missing' },
    { profile_sha256: 'unbound' }, { recipe_id: 'npm-checks' }, { command: 'arbitrary' }]) {
    assert.throws(() => validateAcceptanceRequest(request(extra)), /invalid persisted acceptance request/);
  }
  assert.throws(() => validatePackageRecovery({ ...newPackageRecovery(), phase: 'acceptance' }), /saved request/);
  assert.throws(() => validatePackageRecovery({ ...newPackageRecovery(), phase: 'needs-attention', resume_phase: 'acceptance' }), /saved request/);
  assert.throws(() => validatePackageRecovery({ ...newPackageRecovery(), history: [{ action: 'acceptance-request' }] }), /invalid persisted acceptance request/);
});

test('current and historical handoff bytes remain verified after serialization', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-request-protocol-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'logs'));
  fs.writeFileSync(path.join(root, 'logs/request.json'), 'request');
  fs.writeFileSync(path.join(root, 'logs/previous.json'), 'previous');
  const recovery = { ...newPackageRecovery(), phase: 'acceptance', acceptance_request: request(),
    history: [{ action: 'acceptance-request', request: request({ file: 'logs/previous.json', sha256: hash('previous') }) }] };
  assert.equal(verifyAcceptanceRequests(root, JSON.parse(JSON.stringify(recovery))), true);
  fs.appendFileSync(path.join(root, 'logs/previous.json'), 'tamper');
  assert.throws(() => verifyAcceptanceRequests(root, recovery), /acceptance request output changed/);
  fs.writeFileSync(path.join(root, 'logs/previous.json'), 'previous');
  fs.unlinkSync(path.join(root, 'logs/request.json'));
  fs.symlinkSync('previous.json', path.join(root, 'logs/request.json'));
  assert.throws(() => verifyAcceptanceRequests(root, recovery), /symlink is forbidden/);
});
