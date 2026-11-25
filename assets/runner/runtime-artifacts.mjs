import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acceptanceArtifacts, verifyAcceptanceArtifacts } from './acceptance-lifecycle.mjs';
import { verifyAcceptanceEvidenceArtifacts } from './acceptance-adapters.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const require = (condition, message) => { if (!condition) throw new Error(`Runtime artifacts: ${message}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function runtimeArtifact(root, value) {
  require(typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0'), 'invalid artifact path');
  const file = path.resolve(root, value), relative = path.relative(root, file);
  require(relative && !relative.startsWith('..') && !value.split('/').includes('..'), 'artifact escapes repository');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    require(!fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink(), 'artifact symlink is forbidden');
  }
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  require(stat?.isFile() && stat.nlink === 1, `missing or linked artifact: ${relative}`);
  return { file: relative, sha256: hash(fs.readFileSync(file)), mode: stat.mode & 0o777 };
}

/** Exact immutable strict evidence, including nested reports/logs/build/PNG
 * files. This deliberately does not compare historical source with HEAD. */
export function strictEntryArtifacts(root, entry) {
  const files = new Map();
  const add = value => { const item = runtimeArtifact(root, value); files.set(item.file, item); return item; };
  // A handoff can precede creation of acceptance state. Audit its immutable
  // originating result even while mapping review has not started.
  for (const request of [entry?.recovery?.acceptance_request, ...(entry?.recovery?.history || [])
    .filter(item => item.action === 'acceptance-request').map(item => item.request)].filter(Boolean)) {
    require(HASH.test(request.sha256 || '') && add(request.file).sha256 === request.sha256, 'acceptance request hash mismatch');
  }
  if (entry?.acceptance?.mode !== 'strict') return [...files.values()].sort((a, b) => a.file.localeCompare(b.file));
  verifyAcceptanceArtifacts(root, entry);
  for (const item of acceptanceArtifacts(entry)) {
    require(HASH.test(item.sha256 || '') && add(item.file).sha256 === item.sha256, 'strict artifact hash mismatch');
  }
  for (const item of [...(entry.acceptance.history || []), ...Object.values(entry.acceptance.gates || {})]) {
    if (!item.file || !item.sha256) continue;
    const evidence = verifyAcceptanceEvidenceArtifacts({ root, file: path.resolve(root, item.file) });
    for (const nested of evidence.artifacts || []) add(nested.file);
  }
  return [...files.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** Inventory owned tree membership as well as bytes. Directory additions and
 * removals are inputs too; unknown symlinks/devices/hardlinks are never followed. */
export function runtimeTreeArtifacts(plan, relative) {
  const directory = path.join(plan.stateDir, relative), files = [];
  const walk = file => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return;
    require(!stat.isSymbolicLink(), 'owned artifact tree contains a symlink');
    if (stat.isDirectory()) {
      require(fs.realpathSync(file) === file, 'owned artifact directory is not canonical');
      files.push({ file: path.relative(plan.root, file), kind: 'directory', mode: stat.mode & 0o777 });
      for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name));
    } else files.push({ ...runtimeArtifact(plan.root, file), kind: 'file' });
  };
  walk(directory);
  return files;
}

function verifyPacket(plan, item) {
  const bytes = fs.readFileSync(path.join(plan.root, item.file));
  let packet;
  try { packet = JSON.parse(bytes); } catch { require(false, 'malformed acceptance review packet'); }
  const binding = packet?.binding, packageId = binding?.package_id;
  require(packet?.schema_version === 1 && HASH.test(binding?.source_sha256 || '') && binding.plan_hash === plan.planHash
    && ['mapping', 'evidence'].includes(binding.stage) && /^\d{2}$/.test(packageId || '')
    && path.basename(item.file) === `${binding.stage}-${hash(JSON.stringify(binding))}-packet.json`, 'review packet binding or identity changed');
  const entry = plan.state.steps[packageId];
  require(entry?.acceptance?.mode === 'strict', 'review packet belongs to an unknown strict package');
  const references = acceptanceArtifacts(entry).filter(ref => ref.file === item.file);
  if (references.length) { require(references.every(ref => ref.sha256 === item.sha256), 'review packet hash changed'); return; }
  // Compatibility for pre-sealing reviewer cooldowns. Reconstruct exactly from
  // the unchanged recorded mapping and frozen criteria, never bless arbitrary
  // packet bytes merely because no reviewer result exists yet.
  require(entry.acceptance.review_actor?.binding_sha256 === hash(JSON.stringify(binding)), 'unsealed review packet has no current reviewer ownership');
  const requirements = plan.acceptanceProfile?.packages?.[packageId];
  require(requirements && hash(JSON.stringify(requirements)) === binding.profile_sha256, 'unsealed packet frozen profile changed');
  const mappingRef = entry.acceptance.mapping;
  require(mappingRef?.sha256 === binding.mapping_sha256 && runtimeArtifact(plan.root, mappingRef.file).sha256 === mappingRef.sha256, 'unsealed packet mapping cannot be independently reconstructed');
  const source = packet.source_inventory, { sha256, ...inventory } = source || {};
  require(sha256 === binding.source_sha256 && hash(JSON.stringify(inventory)) === sha256, 'review packet source inventory changed');
  const gates = entry.acceptance.gates || {};
  const expectedEvidence = binding.stage === 'evidence' ? Object.entries(gates).map(([id, gate]) => ({ id, file: gate.file, sha256: gate.sha256 })) : [];
  require(same(binding.evidence, expectedEvidence), 'review packet gate binding changed');
  const expected = { schema_version: 1, binding, criteria: requirements.criteria, required_gates: requirements.required_gates,
    mapping: JSON.parse(fs.readFileSync(path.resolve(plan.root, mappingRef.file))), source_inventory: source, gates };
  require(bytes.equals(Buffer.from(JSON.stringify(expected, null, 2) + '\n')), 'unsealed review packet bytes changed');
}

export function strictPlanArtifacts(plan) {
  const immutable = [];
  for (const entry of Object.values(plan.state.steps || {})) {
    immutable.push(...strictEntryArtifacts(plan.root, entry));
    if (entry?.acceptance?.mode !== 'strict') continue;
    const a = entry.acceptance;
    for (const record of [...Object.values(a.gates || {}), ...(a.history || []).filter(item => item.gate_id)]) {
      if (record.file) {
        require(typeof record.journal_file === 'string' || typeof record.journal_snapshot_file === 'string', 'strict gate evidence has no ownership journal reference');
        if (record.journal_file) runtimeArtifact(plan.root, record.journal_file);
      }
      if (record.journal_snapshot_file) {
        const snapshot = JSON.parse(fs.readFileSync(path.resolve(plan.root, record.journal_snapshot_file)));
        require(typeof snapshot.id === 'string', 'timeout snapshot has no journal identity');
        runtimeArtifact(plan.root, path.join(path.dirname(record.journal_snapshot_file), `acceptance-${snapshot.id}-journal.json`));
      }
    }
  }
  const tree = runtimeTreeArtifacts(plan, 'acceptance');
  for (const item of tree) {
    if (item.kind !== 'file') continue;
    if (item.file.endsWith('-packet.json')) verifyPacket(plan, item);
    if (path.basename(item.file).startsWith('acceptance-') && item.file.endsWith('-journal.json')) {
      const journal = JSON.parse(fs.readFileSync(path.join(plan.root, item.file)));
      if (journal.evidence_file) {
        // Losing the state pointer does not exempt a retained gate's nested
        // reports from verification. Ownership is separately checked below.
        const evidence = verifyAcceptanceEvidenceArtifacts({ root: plan.root, file: path.resolve(plan.root, journal.evidence_file) });
        immutable.push(runtimeArtifact(plan.root, journal.evidence_file));
        for (const nested of evidence.artifacts || []) immutable.push(runtimeArtifact(plan.root, nested.file));
      }
    }
  }
  return { immutable: [...new Map(immutable.map(item => [item.file, item])).values()].sort((a,b) => a.file.localeCompare(b.file)), tree };
}
