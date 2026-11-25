import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateAcceptanceProfile, resolveAcceptanceProfile, acceptanceForPackage, validateAcceptanceMapping, checkedAcceptanceFile, verifyAcceptancePolicySources, ACCEPTANCE_LEGACY_PRESETS } from './acceptance-policy.mjs';

const steps = [{ id: '01', manual: false }, { id: '02', manual: true }];
const profile = () => ({ schema_version: 1, mode: 'strict', packages: { '01': {
  required_gates: [{ id: 'npm', capability: 'npm-checks' }, { id: 'sql', capability: 'synthetic-postgres' }, { id: 'build', capability: 'production-build' }, { id: 'browser', capability: 'loopback-browser' }],
  criteria: [{ id: 'denies-stale-write', type: 'persistence', purpose: 'Reject stale writes on SQLite and PostgreSQL.', gate_ids: ['npm', 'sql'] }, { id: 'production-build', type: 'build', purpose: 'Build application.', gate_ids: ['build'] }, { id: 'revoked-dialog', type: 'ui', purpose: 'Clear revoked protected dialog content.', gate_ids: ['browser'] }],
} } });
const mapping = () => ({ schema_version: 1, package_id: '01', gates: [
  { gate_id: 'npm', files: ['tests/write.test.ts'], cases: ['npm-test', 'npm-check', 'write denies stale revision'] },
  { gate_id: 'sql', files: ['tests/acceptance/01/write.postgres.test.ts'], cases: ['write denies stale revision'] },
  { gate_id: 'build', files: [], cases: ['production-build'] },
  { gate_id: 'browser', files: ['tests/acceptance/01/revoked.browser.mjs'], cases: ['revoked dialog clears detail'] },
], criteria: [
  { criterion_id: 'denies-stale-write', gate_id: 'npm', test_ids: ['write denies stale revision'] },
  { criterion_id: 'denies-stale-write', gate_id: 'sql', test_ids: ['write denies stale revision'] },
  { criterion_id: 'production-build', gate_id: 'build', test_ids: ['production-build'] },
  { criterion_id: 'revoked-dialog', gate_id: 'browser', test_ids: ['revoked dialog clears detail'] },
] });

test('legacy manifests explicitly retain receipt-only mode without new historical requirements', () => {
  const value = resolveAcceptanceProfile({ steps });
  assert.deepEqual(value, { schema_version: 1, mode: 'legacy', packages: {} });
  assert.equal(acceptanceForPackage(value, '01'), null);
  assert.equal(acceptanceForPackage(profile(), '02'), null);
});

test('strict mapping accounts for every criterion/gate and refuses arbitrary executable fields', () => {
  const value = validateAcceptanceProfile(profile(), steps);
  assert.deepEqual(validateAcceptanceMapping(value.packages['01'], mapping(), { packageId: '01' }), mapping());
  for (const mutation of [
    m => m.criteria.pop(), m => m.gates.pop(), m => m.criteria.push(m.criteria[0]),
    m => m.gates[0].argv = ['sh', '-c', 'bad'], m => m.gates[0].env = { DATABASE_URL: 'remote' },
    m => m.gates[3].url = 'https://remote.invalid', m => m.criteria[0].test_ids = ['made-up-case'],
    m => m.criteria[0].test_ids = ['npm-test'], m => m.gates[0].cases = ['npm-test'],
    m => m.package_id = '03', m => m.criteria[0].gate_id = 'missing',
  ]) {
    const proposal = mapping(); mutation(proposal);
    assert.throws(() => validateAcceptanceMapping(value.packages['01'], proposal, { packageId: '01' }), /Invalid acceptance/);
  }
});

test('strict profile refuses unknown capabilities, manual authority, missing purposes and unaccounted gates', () => {
  for (const mutation of [
    p => p.packages['01'].required_gates[0].capability = 'arbitrary-shell',
    p => p.packages['02'] = p.packages['01'],
    p => p.packages['01'].criteria[0].purpose = '',
    p => p.packages['01'].criteria[0].gate_ids = ['npm'],
    p => p.packages['01'].required_gates.push({ id: 'extra', capability: 'npm-checks' }),
    p => p.packages['01'].required_gates[1].preset = 'unreviewed',
    p => p.packages['01'].required_gates[0].command = 'npm install',
    p => p.packages['01'].criteria[2].gate_ids = ['npm'],
    p => p.packages['01'].criteria.push(p.packages['01'].criteria[0]),
  ]) { const value = profile(); mutation(value); assert.throws(() => validateAcceptanceProfile(value, steps), /Invalid acceptance/); }
});

test('mapping rejects traversal, symlinks, remote paths and unrelated browser/SQL suites', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-policy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tests')); fs.writeFileSync(path.join(root, 'tests', 'a.test.ts'), 'test');
  fs.symlinkSync('a.test.ts', path.join(root, 'tests', 'link.test.ts'));
  assert.equal(checkedAcceptanceFile(root, 'tests/a.test.ts'), path.join(root, 'tests', 'a.test.ts'));
  assert.throws(() => checkedAcceptanceFile(root, 'tests/link.test.ts'), /symlink/);
  assert.equal(checkedAcceptanceFile(root, 'tests/future.test.ts', { required: false }), path.join(root, 'tests', 'future.test.ts'));
  assert.throws(() => checkedAcceptanceFile(root, 'tests/future.test.ts'), /absent/);
  for (const file of ['../escape.test.ts', 'tests/../a.test.ts', 'tests//a.test.ts', '/tmp/a.test.ts', 'https://example.test/a.ts', 'tests\\a.test.ts']) {
    assert.throws(() => checkedAcceptanceFile(root, file), /invalid repository-relative/);
  }
  for (const [gateIndex, file] of [[1, 'tests/acceptance/02/write.postgres.test.ts'], [3, 'scripts/study-management-ui-smoke.mjs'], [3, 'tests/acceptance/02/a.browser.mjs']]) {
    const value = mapping(); value.gates[gateIndex].files = [file];
    assert.throws(() => validateAcceptanceMapping(profile().packages['01'], value), /mapping/);
  }
});

test('reviewed legacy presets pin exact files and cannot widen authority', () => {
  for (const [preset, files] of Object.entries(ACCEPTANCE_LEGACY_PRESETS)) {
    const value = profile(); value.packages['01'].required_gates[1].preset = preset;
    const proposed = mapping(); proposed.gates[1].files = [...files];
    validateAcceptanceProfile(value, steps); validateAcceptanceMapping(value.packages['01'], proposed);
    proposed.gates[1].files.push('tests/unreviewed-postgres.test.ts');
    assert.throws(() => validateAcceptanceMapping(value.packages['01'], proposed), /preset/);
    proposed.gates[1].files = ['tests/acceptance/01/substitute.postgres.test.ts'];
    assert.throws(() => validateAcceptanceMapping(value.packages['01'], proposed), /preset/);
  }
});

test('runtime acceptance authority binds immutable plan source and rejects dual policy', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-source-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'contract.md'), 'original acceptance');
  const runtimePolicy = { schema_version: 1, plan_id: 'fixture', source_documents: [{ path: 'contract.md', sha256: createHash('sha256').update('original acceptance').digest('hex') }], acceptance: profile() };
  const manifest = { plan_id: 'fixture', steps };
  assert.deepEqual(resolveAcceptanceProfile(manifest, { runtimePolicy }), profile());
  assert.equal(verifyAcceptancePolicySources(root, runtimePolicy), true);
  assert.throws(() => resolveAcceptanceProfile({ ...manifest, acceptance: profile() }, { runtimePolicy }), /conflicting/);
  assert.throws(() => resolveAcceptanceProfile({ ...manifest, plan_id: 'different' }, { runtimePolicy }), /identity/);
  fs.appendFileSync(path.join(root, 'contract.md'), ' weakened');
  assert.throws(() => verifyAcceptancePolicySources(root, runtimePolicy), /source changed/);
});


test('policy matches fixed adapter ID, case and package file boundaries before host execution', () => {
  const value = profile(), gate = value.packages['01'].required_gates[0], criterion = value.packages['01'].criteria[0];
  gate.id = 'n'.repeat(64); criterion.gate_ids[0] = gate.id;
  assert.doesNotThrow(() => validateAcceptanceProfile(value, steps));
  gate.id += 'n'; criterion.gate_ids[0] = gate.id;
  assert.throws(() => validateAcceptanceProfile(value, steps), /invalid gate/);
  const valid = mapping(); valid.gates[0].cases.push('a'.repeat(999));
  assert.doesNotThrow(() => validateAcceptanceMapping(profile().packages['01'], valid));
  for (const mutation of [
    m => m.gates[0].cases.push('a'.repeat(1000)),
    m => m.gates[0].files = ['tests/write.test.cjs'],
    m => m.gates[1].files = ['tests/acceptance/01/nested/write.postgres.test.ts'],
    m => m.gates[3].files = ['tests/acceptance/01/nested/revoked.browser.mjs'],
  ]) {
    const proposal = mapping(); mutation(proposal);
    assert.throws(() => validateAcceptanceMapping(profile().packages['01'], proposal), /Invalid acceptance/);
  }
});
