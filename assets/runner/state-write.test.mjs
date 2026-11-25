import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson } from './runner.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-state-write-'));
  const file = path.join(root, 'state.json');
  fs.writeFileSync(file, '{"revision":1}\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file };
}

test('outside mutation during checkpoint fsync is preserved instead of overwritten', t => {
  const { root, file } = fixture(t), before = hash(fs.readFileSync(file));
  const original = fs.fsyncSync;
  fs.fsyncSync = fd => {
    original(fd);
    fs.writeFileSync(file, '{ corrupted during checkpoint preparation');
  };
  try {
    assert.throws(() => atomicJson(file, { revision: 2 }, () => {
      if (hash(fs.readFileSync(file)) !== before) throw new Error('State changed outside the parent');
    }), /State changed outside the parent/);
  } finally { fs.fsyncSync = original; }
  assert.equal(fs.readFileSync(file, 'utf8'), '{ corrupted during checkpoint preparation');
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});

test('outside mutation immediately after publication never becomes the expected checkpoint hash', t => {
  const { file } = fixture(t), value = { revision: 2 };
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    original(from, to);
    if (to === file) fs.writeFileSync(file, '{ corrupted after checkpoint publication');
  };
  let expected;
  try { expected = atomicJson(file, value); }
  finally { fs.renameSync = original; }
  assert.equal(expected, hash(JSON.stringify(value, null, 2) + '\n'));
  assert.notEqual(expected, hash(fs.readFileSync(file)));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ corrupted after checkpoint publication');
});
