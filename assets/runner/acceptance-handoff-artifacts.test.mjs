import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { strictEntryArtifacts, strictPlanArtifacts } from './runtime-artifacts.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-audit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'current.json'), 'current handoff', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'prior.json'), 'prior handoff', { mode: 0o600 });
  const current = { file: 'current.json', sha256: hash('current handoff') };
  const prior = { file: 'prior.json', sha256: hash('prior handoff') };
  const entry = { recovery: { acceptance_request: current, history: [{ action: 'acceptance-request', request: prior }] } };
  return { root, entry, plan: { root, stateDir: path.join(root, 'state'), state: { steps: { '01': entry } } } };
}

test('runtime audit binds pending handoff and historical requests before acceptance state exists', t => {
  const f = fixture(t);
  assert.deepEqual(strictEntryArtifacts(f.root, f.entry).map(x => x.file), ['current.json', 'prior.json']);
  assert.deepEqual(strictPlanArtifacts(f.plan).immutable, strictEntryArtifacts(f.root, f.entry));
  const before = strictPlanArtifacts(f.plan);
  fs.chmodSync(path.join(f.root, 'current.json'), 0o644);
  assert.notDeepEqual(strictPlanArtifacts(f.plan), before, 'a reviewed upgrade proposal must change when request mode changes');
});

for (const name of ['current.json', 'prior.json']) test(`runtime audit rejects changed ${name} handoff bytes`, t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.root, name), 'tampered');
  assert.throws(() => strictPlanArtifacts(f.plan), /request hash mismatch/);
});

test('runtime audit rejects linked or missing handoff request artifacts', t => {
  const f = fixture(t), file = path.join(f.root, 'current.json');
  fs.unlinkSync(file);
  assert.throws(() => strictPlanArtifacts(f.plan), /missing or linked artifact/);
  fs.symlinkSync(path.join(f.root, 'prior.json'), file);
  assert.throws(() => strictPlanArtifacts(f.plan), /symlink/);
});
