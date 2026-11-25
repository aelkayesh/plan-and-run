import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const ACCEPTANCE_CAPABILITIES = Object.freeze(['npm-checks', 'production-build', 'synthetic-postgres', 'loopback-browser']);
export const ACCEPTANCE_CRITERION_TYPES = Object.freeze(['behavior', 'security', 'persistence', 'ui', 'build', 'suite']);
export const ACCEPTANCE_LEGACY_PRESETS = Object.freeze({
  'sites-legacy': ['tests/sites-postgres.test.ts'],
  'study-management': ['tests/sites-management-postgres.test.ts'],
  'access-storage': ['tests/access-storage-postgres.test.ts'],
  'access-policy': ['tests/access-policy-postgres.test.ts'],
  'access-adapters': ['tests/access-adapters-postgres.test.ts'],
  'sites-lifecycle': ['tests/sites-lifecycle-postgres.test.ts'],
  'operations': ['tests/operations-postgres.test.ts'],
  'benchmark-store': ['tests/benchmark-store.test.ts'],
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 12000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const id = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const caseId = value => text(value) && value.length < 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(`Invalid acceptance: ${message}`); };
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
const unique = values => new Set(values).size === values.length;
const list = (value, predicate, min = 1, max = 2048) => Array.isArray(value) && value.length >= min && value.length <= max && value.every(predicate) && unique(value);
export function acceptancePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !path.isAbsolute(value)
    && !value.includes('\\') && !value.includes(':') && !/[\x00-\x1f]/.test(value)
    && value.split('/').every(component => component && component !== '.' && component !== '..');
}

/** Frozen capability authority is independent of workers' mutable case mappings. */
export function validateAcceptanceProfile(profile, steps) {
  check(keys(profile, ['schema_version', 'mode', 'packages']) && profile.schema_version === 1 && ['strict', 'legacy'].includes(profile.mode) && object(profile.packages), 'profile schema is invalid');
  const known = new Map((steps || Object.keys(profile.packages).map(id => ({ id, manual: false }))).map(step => [step.id, step]));
  if (profile.mode === 'legacy') {
    check(Object.keys(profile.packages).length === 0, 'legacy receipt mode cannot claim strict packages');
    return profile;
  }
  check(Object.keys(profile.packages).length > 0 && Object.keys(profile.packages).length <= 99, 'strict profile must declare packages');
  for (const [packageId, value] of Object.entries(profile.packages)) {
    check(/^\d{2}$/.test(packageId) && known.has(packageId) && !known.get(packageId).manual, `unknown/manual package ${packageId}`);
    check(keys(value, ['required_gates', 'criteria']), `package ${packageId} schema is invalid`);
    check(Array.isArray(value.required_gates) && value.required_gates.length > 0 && value.required_gates.length <= 32, `package ${packageId} needs required gates`);
    const gates = new Map();
    for (const gate of value.required_gates) {
      check(keys(gate, ['id', 'capability'], ['preset']) && id(gate.id) && ACCEPTANCE_CAPABILITIES.includes(gate.capability), `unknown or invalid gate capability in package ${packageId}`);
      check(!gates.has(gate.id), `duplicate gate ${gate.id}`);
      if (gate.preset !== undefined) check(gate.capability === 'synthetic-postgres' && Object.hasOwn(ACCEPTANCE_LEGACY_PRESETS, gate.preset), `unknown or unauthorized preset ${gate.preset}`);
      gates.set(gate.id, gate);
    }
    check(Array.isArray(value.criteria) && value.criteria.length > 0 && value.criteria.length <= 512, `package ${packageId} needs required criteria`);
    const criterionIds = new Set(), used = new Set();
    for (const criterion of value.criteria) {
      check(keys(criterion, ['id', 'type', 'purpose', 'gate_ids']) && id(criterion.id) && ACCEPTANCE_CRITERION_TYPES.includes(criterion.type) && text(criterion.purpose), `invalid criterion in package ${packageId}`);
      check(!criterionIds.has(criterion.id), `duplicate criterion ${criterion.id}`);
      check(list(criterion.gate_ids, gate => gates.has(gate), 1, 32), `criterion ${criterion.id} references missing/duplicate gates`);
      if (criterion.type === 'build') check(criterion.gate_ids.some(gate => gates.get(gate).capability === 'production-build'), `build criterion ${criterion.id} needs build capability`);
      if (criterion.type === 'ui') check(criterion.gate_ids.some(gate => gates.get(gate).capability === 'loopback-browser'), `UI criterion ${criterion.id} needs browser capability`);
      if (criterion.type === 'persistence') check(criterion.gate_ids.some(gate => gates.get(gate).capability === 'synthetic-postgres'), `persistence criterion ${criterion.id} needs PostgreSQL capability`);
      criterionIds.add(criterion.id); criterion.gate_ids.forEach(gate => used.add(gate));
    }
    check(used.size === gates.size, `package ${packageId} contains a gate with no criterion`);
  }
  return profile;
}

export function resolveAcceptanceProfile(manifest, { runtimePolicy } = {}) {
  if (runtimePolicy !== undefined) {
    check(keys(runtimePolicy, ['schema_version', 'plan_id', 'source_documents', 'acceptance']) && runtimePolicy.schema_version === 1 && runtimePolicy.plan_id === manifest.plan_id, 'runtime policy identity is invalid');
    check(Array.isArray(runtimePolicy.source_documents) && runtimePolicy.source_documents.length > 0 && runtimePolicy.source_documents.every(item => keys(item, ['path', 'sha256']) && acceptancePath(item.path) && /^[a-f0-9]{64}$/.test(item.sha256)) && unique(runtimePolicy.source_documents.map(item => item.path)), 'runtime policy source identities are invalid');
    check(manifest.acceptance === undefined, 'manifest and runtime cannot supply conflicting acceptance authorities');
    return validateAcceptanceProfile(runtimePolicy.acceptance, manifest.steps);
  }
  return validateAcceptanceProfile(manifest.acceptance ?? { schema_version: 1, mode: 'legacy', packages: {} }, manifest.steps);
}

export function verifyAcceptancePolicySources(root, runtimePolicy) {
  for (const item of runtimePolicy.source_documents) {
    const file = checkedAcceptanceFile(root, item.path);
    check(hash(fs.readFileSync(file)) === item.sha256, `frozen acceptance source changed: ${item.path}`);
  }
  return true;
}

export function acceptanceForPackage(profile, packageId) {
  return profile?.mode === 'strict' ? profile.packages[packageId] || null : null;
}

/** Check canonical path syntax and every component, including internal symlinks. */
export function checkedAcceptanceFile(root, relative, { required = true } = {}) {
  check(acceptancePath(relative), `invalid repository-relative path ${String(relative)}`);
  root = fs.realpathSync(root);
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) { check(!required, `required mapping/test file is absent: ${relative}`); return path.join(root, relative); }
    check(!stat.isSymbolicLink(), `symlink is forbidden: ${relative}`);
    check(index === parts.length - 1 ? stat.isFile() : stat.isDirectory(), `path is not a regular file: ${relative}`);
  }
  return current;
}

export function validateAcceptanceMapping(profilePackage, mapping, { packageId } = {}) {
  check(profilePackage && Array.isArray(profilePackage.required_gates), 'mapping requires a strict package profile');
  check(keys(mapping, ['schema_version', 'package_id', 'gates', 'criteria']) && mapping.schema_version === 1 && /^\d{2}$/.test(mapping.package_id) && (!packageId || packageId === mapping.package_id), 'mapping identity/schema is invalid');
  const frozenGates = new Map(profilePackage.required_gates.map(gate => [gate.id, gate]));
  check(Array.isArray(mapping.gates) && mapping.gates.length === frozenGates.size, 'required gate mapping is missing or extra');
  const proposed = new Map();
  for (const gate of mapping.gates) {
    check(keys(gate, ['gate_id', 'files', 'cases']) && frozenGates.has(gate.gate_id) && !proposed.has(gate.gate_id), 'unknown/duplicate gate mapping');
    const frozen = frozenGates.get(gate.gate_id);
    check(list(gate.files, acceptancePath, 0, 512) && list(gate.cases, caseId, 1, 20000), `invalid files/cases for ${gate.gate_id}`);
    if (frozen.capability === 'production-build') check(gate.files.length === 0 && JSON.stringify(gate.cases) === JSON.stringify(['production-build']), 'build uses only the fixed production-build case');
    else if (frozen.capability === 'synthetic-postgres') {
      const preset = frozen.preset && ACCEPTANCE_LEGACY_PRESETS[frozen.preset];
      check(gate.files.length > 0 && (preset ? JSON.stringify(gate.files) === JSON.stringify(preset) : gate.files.every(file => new RegExp(`^tests/acceptance/${mapping.package_id}/[^/]+\\.postgres\\.test\\.ts$`).test(file))), `SQL mapping escapes owned package/preset ${gate.gate_id}`);
    } else if (frozen.capability === 'loopback-browser') {
      check(gate.files.length === 1 && new RegExp(`^tests/acceptance/${mapping.package_id}/[^/]+\\.browser\\.mjs$`).test(gate.files[0]), 'browser mapping must name one package-specific browser harness');
    } else {
      check(gate.files.every(file => file.startsWith('tests/') && /\.(?:test|spec)\.(?:mjs|js|ts|tsx)$/.test(file)), 'npm mapping must name test suites only');
      check(gate.cases.includes('npm-test') && gate.cases.includes('npm-check'), 'npm mapping must include both fixed checks');
    }
    proposed.set(gate.gate_id, gate);
  }
  const requiredPairs = new Map(profilePackage.criteria.flatMap(criterion => criterion.gate_ids.map(gate => [`${criterion.id}:${gate}`, criterion])));
  check(Array.isArray(mapping.criteria) && mapping.criteria.length === requiredPairs.size, 'required criterion/gate coverage is missing or extra');
  const seen = new Set(), commandCases = new Set(['npm-test', 'npm-check', 'production-build']);
  for (const criterion of mapping.criteria) {
    check(keys(criterion, ['criterion_id', 'gate_id', 'test_ids']), 'criterion mapping must not contain commands or extra fields');
    const pair = `${criterion.criterion_id}:${criterion.gate_id}`, required = requiredPairs.get(pair), gate = proposed.get(criterion.gate_id);
    check(required && !seen.has(pair) && gate, `unknown/duplicate criterion mapping ${pair}`);
    check(list(criterion.test_ids, value => text(value) && gate.cases.includes(value), 1, 20000), `criterion ${pair} lacks mapped cases`);
    if (!['build', 'suite'].includes(required.type) && frozenGates.get(criterion.gate_id).capability !== 'production-build') {
      check(criterion.test_ids.some(value => !commandCases.has(value)), `semantic criterion ${pair} needs an actual assertion case`);
    }
    seen.add(pair);
  }
  return mapping;
}
