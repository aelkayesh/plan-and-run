import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  loadRecoveryPolicy, validateRecoveryPolicy, validateRecoveryDecision, recoveryResultSchema,
  newPackageRecovery, migrateRecoveryState, validatePackageRecovery, snapshotRuntime,
  capturePhaseGuard, assertPhaseGuard, recordNoProgress
} from './recovery.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const manifest = { plan_id: 'synthetic-recovery', steps: [
  { id: '01', manual: false, validation: '01-validation.json', handoff: '01-handoff.md' },
  { id: '02', manual: false, validation: '02-validation.json', handoff: '02-handoff.md' },
  { id: '15', manual: true, validation: '15-validation.json', handoff: '15-handoff.md' }
] };
const policy = { schema_version: 1, plan_id: manifest.plan_id, packages: {
  '01': { local_repair: true, recipes: ['npm-checks'] },
  '02': { local_repair: true, recipes: ['npm-checks'] }
} };
const decision = overrides => ({ schema_version: 1, package_id: '01', attempt_id: 'synthetic-attempt',
  classification: 'implementation', action: 'resume', recipe_id: null, summary: 'Inspected partial work and repaired source.', changed_files: ['lib/source.mjs'], blockers: [], ...overrides });
const validate = result => validateRecoveryDecision(result, { packageId: '01', attemptId: 'synthetic-attempt', policy });

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recovery protocol-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; };
  return { root, write };
}

test('manifest selection authorizes only fixed recipes and every nonmanual package is ordinary', t => {
  const { root } = fixture(t);
  const generic = { ...manifest, steps: manifest.steps.map(step => ({...step, manual:false})), recovery: {schema_version:1, packages:{'15':{local_repair:true,recipes:['npm-checks']}}} };
  const loaded = loadRecoveryPolicy(root, generic);
  assert.deepEqual(loaded.value.packages['15'], {local_repair:true,recipes:['npm-checks']});
  assert.equal(loaded.file, null);
  assert.equal(validateRecoveryDecision(decision({package_id:'15',action:'host-check',classification:'environment',recipe_id:'npm-checks'}), {packageId:'15',attemptId:'synthetic-attempt',policy:loaded}).action,'host-check');
  assert.equal(fs.readdirSync(root).length,0);
});

test('default policy enables sandbox repair but no unreviewed host recipe', t => {
  const {root}=fixture(t), loaded=loadRecoveryPolicy(root,manifest);
  assert.deepEqual(loaded.value.packages['01'],{local_repair:true,recipes:[]});
  assert.equal(loaded.value.packages['15'],undefined);
  assert.throws(()=>validateRecoveryDecision(decision({action:'host-check',classification:'environment',recipe_id:'npm-checks'}),{packageId:'01',attemptId:'synthetic-attempt',policy:loaded}),/unauthorized host recipe/);
});

test('policy rejects unknown recipes, arbitrary commands, wrong plans and manual packages', () => {
  assert.equal(validateRecoveryPolicy(policy, manifest), policy);
  for (const invalid of [
    { ...policy, command: 'touch arbitrary' },
    { ...policy, plan_id: 'other' },
    { ...policy, packages: { '01': { local_repair: true, recipes: ['npm test; arbitrary'] } } },
    { ...policy, packages: { '01': { local_repair: true, recipes: ['unsupported-database'] } } },
    { ...policy, packages: { '15': { local_repair: true, recipes: [] } } },
    { ...policy, packages: { '01': { local_repair: false, recipes: ['npm-checks'] } } }
  ]) assert.throws(() => validateRecoveryPolicy(invalid, manifest), /Invalid recovery/);
});

test('supervisor has a distinct strict schema and can only resume, request allowlisted checks or block', () => {
  assert.equal(recoveryResultSchema.additionalProperties, false);
  assert.equal(validate(decision()).action, 'resume');
  assert.equal(validate(decision({ classification: 'dependency' })).classification, 'dependency');
  assert.equal(validate(decision({ action: 'host-check', classification: 'environment', recipe_id: 'npm-checks' })).action, 'host-check');
  assert.equal(validate(decision({ action: 'blocked', classification: 'external', changed_files: [], blockers: ['Required approval is unavailable.'] })).action, 'blocked');
  for (const invalid of [
    decision({ command: 'sh -c arbitrary' }), decision({ action: 'completed' }), decision({ package_id: '02' }),
    decision({ attempt_id: 'stale' }), decision({ recipe_id: 'npm-checks' }), decision({ classification: 'external' }),
    decision({ action: 'host-check', classification: 'environment', recipe_id: 'unknown' }),
    decision({ action: 'host-check', classification: 'dependency', recipe_id: 'npm-checks' }),
    decision({ action: 'blocked' }), decision({ blockers: ['Unresolved permission'] }),
    decision({ changed_files: ['../outside'] }), decision({ changed_files: ['/absolute'] })
  ]) assert.throws(() => validate(invalid), /Invalid recovery/);
});

test('additive migration preserves accepted state and budgets on a second start', () => {
  const accepted = { status: 'completed', attempts: 2, artifacts: { validation_sha256: hash('receipt') } };
  const state = { schema_version: 1, steps: { '01': structuredClone(accepted), '02': { status: 'blocked', attempts: 1 } } };
  const identities = { policyHash: hash('policy'), runtimeHash: hash('runtime') };
  migrateRecoveryState(state, identities);
  assert.deepEqual(state.steps['01'], accepted);
  state.recovery.revision = 7;
  state.steps['02'].recovery.repair_count = 3;
  state.steps['02'].recovery.transport_count = 8;
  state.steps['02'].recovery.evidence_refresh_count = 2;
  state.steps['02'].recovery.no_progress_count = 2;
  const previous = structuredClone(state);
  migrateRecoveryState(state, identities);
  assert.deepEqual(state, previous);
  assert.throws(() => migrateRecoveryState(state, { ...identities, runtimeHash: hash('changed') }), /runtime changed/);
  state.recovery.revision = -1;
  assert.throws(() => migrateRecoveryState(state, identities), /corrupt/);
});

test('corrupt recovery phase, counters, history and pending evidence fail closed', () => {
  for (const invalid of [
    { phase: 'skip-acceptance' }, { repair_count: -1 }, { transport_count: 1.5 }, { evidence_refresh_count: '0' },
    { session_replacement_count: Number.MAX_SAFE_INTEGER + 1 }, { no_progress_count: null },
    { last_failure_fingerprint: 'not-a-hash' }, { decisions: 'ignore' }, { pending_evidence: 'arbitrary command' },
    { next_action: '' }, { history: [null] }
  ]) assert.throws(() => validatePackageRecovery({ ...newPackageRecovery(), ...invalid }), /Invalid recovery/);
});

test('unchanged diagnostic/source failures accumulate across serialized recovery state', () => {
  let recovery = newPackageRecovery();
  const input = { diagnostic: 'same implementation failure', sourceHash: hash('source') };
  assert.equal(recordNoProgress(recovery, input), 1);
  recovery = JSON.parse(JSON.stringify(recovery));
  assert.equal(recordNoProgress(recovery, input), 2);
  assert.equal(recordNoProgress(recovery, { ...input, sourceHash: hash('repaired source') }), 1);
});

test('phase guards detect plan/runtime/policy/accepted evidence and state tampering', t => {
  const { root, write } = fixture(t);
  const runtimeDir = path.join(root, 'runtime');
  write('runtime/runner.mjs', 'export const version = 1;\n');
  write('policy.json', JSON.stringify(policy));
  write('01-validation.json', 'accepted receipt'); write('01-handoff.md', 'accepted handoff');
  write('state/result.json', 'accepted result'); write('state/host.log', 'actual host output');
  write('state/host.json', JSON.stringify({ checks: [{ log_file: 'state/host.log' }] }));
  const plan = { root, manifest, planHash: hash('plan'), fingerprint: () => hash('plan'),
    state: { steps: { '01': { status: 'completed', attempts: 2, last_attempt: { result_file: path.join(root, 'state/result.json') }, host_validation: { file: 'state/host.json' } } } } };
  const capturedPolicy = { hash: hash(fs.readFileSync(path.join(root, 'policy.json'))), file: path.join(root, 'policy.json') };
  const guard = capturePhaseGuard(plan, { runtime: snapshotRuntime(runtimeDir), policy: capturedPolicy });
  assertPhaseGuard(plan, guard);
  for (const file of ['runtime/runner.mjs', 'policy.json', '01-validation.json', '01-handoff.md', 'state/result.json', 'state/host.log']) {
    const absolute = path.join(root, file), original = fs.readFileSync(absolute);
    fs.appendFileSync(absolute, '\nchanged');
    assert.throws(() => assertPhaseGuard(plan, guard), /changed|JSON/);
    fs.writeFileSync(absolute, original);
  }
  plan.state.steps['01'].attempts++;
  assert.throws(() => assertPhaseGuard(plan, guard), /accepted package/);
  plan.state.steps['01'].attempts--;
  plan.fingerprint = () => hash('changed plan');
  assert.throws(() => assertPhaseGuard(plan, guard), /frozen plan/);
});

test('supervisor guards can preserve current receipts, including their prior absence', t => {
  const { root, write } = fixture(t);
  write('runtime/runner.mjs', 'export {};');
  const plan = { root, manifest, planHash: hash('plan'), fingerprint: () => hash('plan'), state: { steps: {} } };
  const policy = loadRecoveryPolicy(root, manifest);
  const guard = capturePhaseGuard(plan, { runtime: snapshotRuntime(path.join(root, 'runtime')), policy, extraProtectedPaths: ['02-validation.json', '02-handoff.md'] });
  write('02-validation.json', '{"status":"completed"}');
  assert.throws(() => assertPhaseGuard(plan, guard), /protected artifacts/);
});

test('migration retains legacy generic transport and repair usage instead of resetting budgets', () => {
  const state = { steps: { '01': {status:'failed',attempts:7,transport_failure_count:4,repair_failure_count:3} } };
  migrateRecoveryState(state,{policyHash:hash('policy'),runtimeHash:hash('runtime')});
  assert.equal(state.steps['01'].recovery.transport_count,4);
  assert.equal(state.steps['01'].recovery.repair_count,3);
  const before=structuredClone(state);
  migrateRecoveryState(state,{policyHash:hash('policy'),runtimeHash:hash('runtime')});
  assert.deepEqual(state,before);
});
