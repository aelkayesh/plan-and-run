#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateSpec } from './prepare.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'plan-and-run');
assert.equal(pkg.private, true, 'This repository is distributed as a skill, not an npm package.');
assert.equal(pkg.license, 'MIT');
assert.equal(pkg.engines.node, '>=22.13.0');
assert.equal(Object.keys(pkg.dependencies || {}).length, 0, 'The runner must retain its dependency-free installation.');

const skill = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8');
const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
assert.ok(frontmatter, 'SKILL.md needs YAML frontmatter.');
assert.match(frontmatter[1], /^name: plan-and-run$/m);
assert.match(frontmatter[1], /^description: \S.+$/m);
for (const filename of ['LICENSE', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'agents/openai.yaml']) {
  assert.ok((await fs.readFile(path.join(root, filename), 'utf8')).trim(), `${filename} is empty.`);
}

async function filesUnder(relative) {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected symlink in distributed skill: ${child}`);
    if (entry.isDirectory()) files.push(...await filesUnder(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

let checked = 0;
for (const relative of [...await filesUnder('scripts'), ...await filesUnder('assets')]) {
  if (!relative.endsWith('.mjs')) continue;
  const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${relative}: ${result.stderr || result.stdout}`);
  checked += 1;
}

let examples = 0;
for (const relative of [...await filesUnder('examples'), 'references/strict-acceptance-example.json']) {
  if (!relative.endsWith('.json')) continue;
  validateSpec(JSON.parse(await fs.readFile(path.join(root, relative), 'utf8')));
  examples += 1;
}
console.log(`Checked ${checked} JavaScript modules, ${examples} plan specifications, and package/skill metadata.`);
