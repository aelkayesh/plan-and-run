import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { snapshotSource } from './host-validation.mjs';
import { acceptanceForPackage, validateAcceptanceMapping } from './acceptance-policy.mjs';
import { runAcceptanceGate, verifyAcceptanceGate, reconcileAcceptanceGate, verifyAcceptanceEvidenceArtifacts, acceptanceExecutionContext } from './acceptance-adapters.mjs';
import { sealAcceptanceCleanupJournal } from './unattended-cleanup.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const hashJson = value => digest(JSON.stringify(value));
export const acceptanceMappingPath = step => step.acceptance_mapping || path.join(path.dirname(step.plan), `${step.id}-acceptance-mapping.json`);

export function acceptancePath(root, relative, { existing = true } = {}) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid acceptance repository path');
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('Acceptance paths cannot contain symlinks');
  }
  if (existing && !fs.statSync(current).isFile()) throw new Error('Acceptance artifact is not a file');
  return current;
}

export const acceptanceReviewSchema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'package_id', 'attempt_id', 'stage', 'binding_sha256', 'verdict', 'criteria', 'blockers'],
  properties: {
    schema_version: { type: 'integer', const: 1 }, package_id: { type: 'string' }, attempt_id: { type: 'string' },
    stage: { type: 'string', enum: ['mapping', 'evidence'] }, binding_sha256: { type: 'string' },
    verdict: { type: 'string', enum: ['accepted', 'rejected', 'blocked'] },
    criteria: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'satisfied', 'reason'], properties: { id: { type: 'string' }, satisfied: { type: 'boolean' }, reason: { type: 'string' } } } },
    blockers: { type: 'array', items: { type: 'string' } }
  }
};

export function validateAcceptanceReview(value, { packageId, attemptId, stage, bindingHash, criteria }) {
  const keys = acceptanceReviewSchema.required;
  if (!value || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || value.schema_version !== 1 || value.package_id !== packageId || value.attempt_id !== attemptId || value.stage !== stage || value.binding_sha256 !== bindingHash) throw new Error('Acceptance review identity/schema mismatch');
  if (!['accepted', 'rejected', 'blocked'].includes(value.verdict) || !Array.isArray(value.blockers) || value.blockers.some(item => typeof item !== 'string' || !item.trim())) throw new Error('Invalid acceptance review verdict/blockers');
  if (!Array.isArray(value.criteria) || value.criteria.length !== criteria.length || new Set(value.criteria.map(item => item.id)).size !== criteria.length || value.criteria.some(item => !criteria.some(criterion => criterion.id === item.id) || Object.keys(item).sort().join(',') !== 'id,reason,satisfied' || typeof item.satisfied !== 'boolean' || typeof item.reason !== 'string' || !item.reason.trim())) throw new Error('Acceptance review omitted or duplicated required criteria');
  if (value.verdict === 'accepted' && (value.blockers.length || value.criteria.some(item => !item.satisfied))) throw new Error('Accepted review contradicts unsatisfied criteria/blockers');
  if (value.verdict === 'blocked' && !value.blockers.length) throw new Error('Blocked review requires an actionable blocker');
  if (value.verdict === 'rejected' && !value.criteria.some(item => !item.satisfied)) throw new Error('Rejected review must identify an unsatisfied criterion');
  return value;
}

export function acceptanceReviewPrompt({ plan, step, stage, bindingHash, packetFile, attemptId }) {
  return `CODEX_PLAN_WORKER=1\nROLE: acceptance-reviewer\nPACKAGE_ID: ${step.id}\nATTEMPT_ID: ${attemptId}\nSTAGE: ${stage}\nBINDING_SHA256: ${bindingHash}\nRepository: ${plan.root}\nYou are a fresh independent read-only acceptance reviewer, not the implementation worker. Read AGENTS.md, original source plan ${plan.manifest.source}, contract ${plan.manifest.contract}, package ${step.plan}, and parent evidence packet ${packetFile}. Inspect the source diff and actual assertions in every mapped test, including negative/failure cases and fixture cleanup. Compare each original criterion against its mapped tests and actual results. Mapping review must reject superficial, unrelated, missing or unsafe tests; evidence review must also inspect complete reports, assertion coverage, screenshots and current build/source identities. An unrelated smoke test cannot satisfy a new UI criterion. Review engineering semantics; do not claim proof of arbitrary correctness. All criteria must be independently assessed. Do not trust optimistic worker summaries or generated evidence prose. Do not modify files, execute mutating tests, start services, install, spend, message, deploy, or alter acceptance. Return ONLY the supplied JSON with per-criterion reasons and exact binding. A missing/weak implementation is rejected; genuinely absent external authority/service is blocked. This decision never schedules work or supplies commands.\n`;
}

export function compactAcceptance(entry) {
  const a = entry?.acceptance;
  if (!a) return 'No parent acceptance evidence yet.';
  return JSON.stringify({ mode: a.mode, mapping: a.mapping, gates: Object.entries(a.gates || {}).map(([id, gate]) => ({ id, file: gate.file, sha256: gate.sha256, passed: gate.passed, journal_file: gate.journal_file })), reviews: (a.reviews || []).map(review => ({ stage: review.stage, file: review.file, sha256: review.sha256, verdict: review.verdict })), timeout_retries: a.timeout_retry_count || 0, timeout_pending: a.timeout_pending || null, diagnostic: a.diagnostic || null });
}

export function acceptanceArtifacts(entry) {
  const a = entry?.acceptance;
  return [...(a?.packets || []), ...(a?.review_packet ? [a.review_packet] : []), ...(a?.reviews || []), ...(a?.history || []).filter(item => item.file && item.sha256 || item.journal_snapshot_file && item.journal_snapshot_sha256), ...Object.values(a?.gates || {}).filter(item => item.file && item.sha256)].flatMap(item => [
    ...(item.file && item.sha256 ? [{ file: item.file, sha256: item.sha256 }] : []), ...(item.packet_file ? [{ file: item.packet_file, sha256: item.packet_sha256 }] : []),
    ...(item.journal_snapshot_file ? [{ file: item.journal_snapshot_file, sha256: item.journal_snapshot_sha256 }] : [])
  ]);
}

export function verifyAcceptanceArtifacts(root, entry) {
  for (const item of acceptanceArtifacts(entry)) if (digest(fs.readFileSync(acceptancePath(root, item.file))) !== item.sha256) throw new Error('Parent acceptance evidence/review was modified');
  // Historical source may change after later packages, but the exact reports,
  // logs, build manifests and screenshots accepted by this parent must remain.
  const a = entry?.acceptance;
  for (const item of [...(a?.history || []), ...Object.values(a?.gates || {})]) {
    if (item.file && item.sha256) verifyAcceptanceEvidenceArtifacts({ root, file: acceptancePath(root, item.file) });
  }
}

export function acceptanceProgressInputs(root, entry, mutablePaths = []) {
  const inventory = snapshotSource(root, mutablePaths);
  // Generated documentation/receipts and model prose cannot reset no-progress.
  const inputs = inventory.files.filter(item => !item.path.startsWith('docs/') && !/\.(md|jsonl|log)$/.test(item.path));
  return { executionInputHash: hashJson(inputs), failureIds: entry.acceptance?.failure_ids?.length ? entry.acceptance.failure_ids : ['finalization:worker-acceptance-incomplete'], verifiedGates: Object.entries(entry.acceptance?.gates || {}).filter(([, gate]) => gate.passed).map(([id]) => id) };
}

function incomplete(message, ids = [], external = false) { const error = new Error(message); error.code = external ? 'ACCEPTANCE_EXTERNAL' : 'ACCEPTANCE_REPAIR'; error.failureIds = ids; return error; }

/** Invoked by the real completion path. Gates and reviews are parent-owned,
 * persisted separately from worker receipts, and never inferred from exit zero. */
export async function ensureAcceptance({ plan, step, entry, profile, mutablePaths, save, review, guarded, signal, timeoutMs, maxRefreshes = 2, adapters = { runAcceptanceGate, verifyAcceptanceGate, reconcileAcceptanceGate } }) {
  const requirements = acceptanceForPackage(profile, step.id);
  if (!requirements) { entry.acceptance ??= { mode: 'legacy-receipt' }; return; }
  const a = entry.acceptance ??= { schema_version: 1, mode: 'strict', gates: {}, reviews: [], history: [], refresh_count: 0 };
  if (a.mode !== 'strict' || !a.gates || !Array.isArray(a.reviews) || !Array.isArray(a.history) || !Number.isSafeInteger(a.refresh_count)) throw new Error('Invalid saved acceptance state');
  a.timeout_retry_count ??= 0;
  if (!Number.isSafeInteger(a.timeout_retry_count) || a.timeout_retry_count < 0) throw new Error('Invalid saved acceptance timeout retry count');
  verifyAcceptanceArtifacts(plan.root, entry);
  const mappingFile = acceptanceMappingPath(step);
  let mapping;
  try { mapping = JSON.parse(fs.readFileSync(acceptancePath(plan.root, mappingFile), 'utf8')); validateAcceptanceMapping(requirements, mapping); }
  catch (error) { a.failure_ids = ['mapping:missing-or-invalid']; a.diagnostic = error.message; save(); throw incomplete(`Required acceptance mapping ${mappingFile}: ${error.message}`, a.failure_ids); }
  if (mapping.package_id !== step.id) throw incomplete('Acceptance mapping package identity mismatch', ['mapping:identity']);
  for (const gate of mapping.gates) for (const file of gate.files) {
    try { acceptancePath(plan.root, file); } catch (error) { throw incomplete(`Required acceptance file ${file}: ${error.message}`, [`mapping:file:${file}`]); }
  }
  const source = snapshotSource(plan.root, mutablePaths);
  const binding = { package_id: step.id, plan_hash: plan.planHash, profile_sha256: hashJson(requirements), mapping_sha256: digest(fs.readFileSync(acceptancePath(plan.root, mappingFile))), source_sha256: source.sha256 };
  a.mapping = { file: mappingFile, sha256: binding.mapping_sha256 };
  const directory = path.join(plan.stateDir, 'acceptance', step.id); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const reviewStage = async stage => {
    const currentBinding = { ...binding, stage, evidence: stage === 'evidence' ? Object.entries(a.gates).map(([id, gate]) => ({ id, file: gate.file, sha256: gate.sha256 })) : [] };
    const bindingHash = hashJson(currentBinding);
    if (a.reviews.some(item => item.binding_sha256 === bindingHash && item.verdict === 'accepted')) return;
    const packet = { schema_version: 1, binding: currentBinding, criteria: requirements.criteria, required_gates: requirements.required_gates, mapping, source_inventory: source, gates: a.gates };
    const packetFile = path.join(directory, `${stage}-${bindingHash}-packet.json`);
    if (!fs.existsSync(packetFile)) fs.writeFileSync(packetFile, JSON.stringify(packet, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    else if (fs.readFileSync(packetFile, 'utf8') !== JSON.stringify(packet, null, 2) + '\n') throw new Error('Acceptance packet changed');
    const packetRef = { file: path.relative(plan.root, packetFile), sha256: digest(fs.readFileSync(packetFile)), binding_sha256: bindingHash };
    a.packets ??= [];
    const retainedPacket = a.packets.find(item => item.file === packetRef.file);
    if (retainedPacket && retainedPacket.sha256 !== packetRef.sha256) throw new Error('Acceptance packet changed');
    if (!retainedPacket) a.packets.push(packetRef);
    a.review_packet = packetRef; save();
    const before = snapshotSource(plan.root, mutablePaths).sha256;
    const result = await review({ stage, bindingHash, packetFile: path.relative(plan.root, packetFile), criteria: requirements.criteria });
    if (snapshotSource(plan.root, mutablePaths).sha256 !== before) throw new Error('Read-only acceptance reviewer changed source');
    const value = validateAcceptanceReview(result.value, { packageId: step.id, attemptId: result.attemptId, stage, bindingHash, criteria: requirements.criteria });
    a.reviews.push({ stage, binding_sha256: bindingHash, file: path.relative(plan.root, result.file), sha256: digest(fs.readFileSync(result.file)), packet_file: path.relative(plan.root, packetFile), packet_sha256: digest(fs.readFileSync(packetFile)), verdict: value.verdict }); save();
    if (value.verdict !== 'accepted') { a.failure_ids = value.criteria.filter(item => !item.satisfied).map(item => `criterion:${item.id}`); a.diagnostic = JSON.stringify(value); save(); throw incomplete(`Independent ${stage} review ${value.verdict}: ${value.criteria.filter(item => !item.satisfied).map(item => `${item.id}: ${item.reason}`).join('; ')} ${value.blockers.join('; ')}`, a.failure_ids, value.verdict === 'blocked'); }
  };
  await reviewStage('mapping');
  // A source/mapping/environment generation can invalidate every gate at once.
  // Charge the cumulative retry budget once for that execution generation,
  // including across interruptions, rather than once per required gate.
  const refreshGeneration = hashJson({ ...binding, context_sha256: hashJson(acceptanceExecutionContext(plan.root)) });
  // Failure and refresh history needs the same original resource proof as a
  // passing gate; old child PIDs may be reused after a later repair succeeds.
  const sealCleanup = (gate, record) => {
    if (record?.journal_file && !record.journal_snapshot_file) {
      Object.assign(record, sealAcceptanceCleanupJournal(plan, step.id, gate, record));
      save();
    }
  };
  const refresh = (gate, saved, reason) => {
    sealCleanup(gate, saved);
    if (a.refresh_generation !== refreshGeneration) {
      if (a.refresh_count >= maxRefreshes) throw Object.assign(incomplete('Acceptance evidence refresh budget exhausted', [`gate:${gate.id}:stale-budget`]), { code: 'ACCEPTANCE_REFRESH_BUDGET' });
      a.refresh_count++; a.refresh_generation = refreshGeneration;
    }
    a.history.push({ ...saved, gate_id: gate.id, reason, refresh_generation: refreshGeneration });
    delete a.gates[gate.id]; save();
  };
  for (const gate of requirements.required_gates) {
    const proposal = mapping.gates.find(item => item.gate_id === gate.id);
    const common = { root: plan.root, packageId: step.id, planHash: plan.planHash, gate, mapping: proposal, mutablePaths };
    let saved = a.gates[gate.id], verified;
    if (saved?.file) {
      const evidenceFile = acceptancePath(plan.root, saved.file);
      // Mapping proposals are mutable implementation deliverables. Their exact
      // prior evidence is already hash-verified, and the new mapping has passed
      // independent review above. A changed mapping requires fresh execution.
      const priorEvidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
      const priorMappingHash = saved.mapping_sha256 ?? priorEvidence.mapping_sha256
        ?? (priorEvidence.mapping ? hashJson(priorEvidence.mapping) : null);
      if (priorMappingHash && priorMappingHash !== hashJson(proposal)) {
        refresh(gate, saved, 'stale-reviewed-mapping'); saved = null;
      } else {
        try { verified = adapters.verifyAcceptanceGate({ ...common, file: evidenceFile }); }
        catch (error) {
          if (!/stale/i.test(error.message)) throw error;
          refresh(gate, saved, 'stale-source-or-context'); saved = null;
        }
      }
      if (verified) sealCleanup(gate, saved);
      if (verified && !verified.evidence.passed) { a.history.push({ ...saved, gate_id: gate.id, reason: 'failed-evidence' }); delete a.gates[gate.id]; saved = null; verified = null; save(); }
    }
    while (!verified) {
      if (a.timeout_pending?.gate_id === gate.id) {
        if (a.timeout_retry_count >= maxRefreshes) throw Object.assign(incomplete('Acceptance host timeout retry budget exhausted', [`gate:${gate.id}:timeout-budget`]), { code: 'ACCEPTANCE_TIMEOUT_BUDGET' });
        const reconciled = await guarded(() => adapters.reconcileAcceptanceGate({ ...common, journalFile: acceptancePath(plan.root, a.timeout_pending.journal_file) }));
        if (reconciled.cleanup_verified !== true && reconciled.evidence?.cleanup_verified !== true) throw incomplete(`Gate ${gate.id} timeout cleanup remains unverified`, [`gate:${gate.id}:cleanup`], true);
        a.timeout_retry_count++; delete a.timeout_pending; a.gates[gate.id] = {}; saved = null; save();
      }
      const recoveringJournal = Boolean(saved?.journal_file);
      const outputDir = path.join(directory, `${gate.id}-${a.history.length}-${Date.now()}`);
      const result = await guarded(() => adapters.runAcceptanceGate({ ...common, outputDir, signal, timeoutMs,
        journalFile: saved?.journal_file ? acceptancePath(plan.root, saved.journal_file) : undefined,
        onJournal: journal => { a.gates[gate.id] = { ...(a.gates[gate.id] || {}), journal_file: path.relative(plan.root, journal.journalFile) }; save(); } }));
      if (signal?.aborted) throw Object.assign(new Error(`Gate ${gate.id} interrupted; ownership journal retained`), { code: 'ACCEPTANCE_INTERRUPTED' });
      if (result?.timedOut) {
        if (result.cleanup_verified !== true && result.evidence?.cleanup_verified !== true) throw incomplete(`Gate ${gate.id} timeout cleanup remains unverified`, [`gate:${gate.id}:cleanup`], true);
        const journalFile = acceptancePath(plan.root, path.relative(plan.root, result.journalFile));
        const snapshotFile = path.join(path.dirname(journalFile), `timeout-journal-${a.history.length}.json`);
        fs.copyFileSync(journalFile, snapshotFile, fs.constants.COPYFILE_EXCL);
        a.history.push({ gate_id: gate.id, reason: 'verified-owned-host-timeout',
          ...(result.file ? { file: path.relative(plan.root, result.file), sha256: digest(fs.readFileSync(result.file)) } : {}),
          journal_snapshot_file: path.relative(plan.root, snapshotFile), journal_snapshot_sha256: digest(fs.readFileSync(snapshotFile)) });
        a.gates[gate.id] = { journal_file: path.relative(plan.root, journalFile) };
        a.timeout_pending = { gate_id: gate.id, journal_file: path.relative(plan.root, journalFile) }; save();
        continue;
      }
      if (!result?.file) throw incomplete(`Gate ${gate.id} produced no evidence; inspect its ownership journal`, [`gate:${gate.id}:missing-evidence`], true);
      // A recovered journal can return evidence from before an intervening
      // source/mapping edit. Bind its original evidence identity before deciding
      // whether the same bounded generation refresh is needed.
      const evidence = verifyAcceptanceEvidenceArtifacts({ root: plan.root, file: result.file });
      const evidenceMappingHash = evidence.mapping_sha256 ?? (evidence.mapping ? hashJson(evidence.mapping) : null);
      saved = a.gates[gate.id] = { file: path.relative(plan.root, result.file), sha256: digest(fs.readFileSync(result.file)), mapping_sha256: evidenceMappingHash, passed: evidence.passed, journal_file: result.journalFile ? path.relative(plan.root, result.journalFile) : null }; save();
      if (recoveringJournal && evidenceMappingHash && evidenceMappingHash !== hashJson(proposal)) {
        refresh(gate, saved, 'stale-reviewed-mapping'); saved = null; continue;
      }
      try { verified = adapters.verifyAcceptanceGate({ ...common, file: result.file }); }
      catch (error) {
        if (!recoveringJournal || !/stale/i.test(error.message)) throw error;
        refresh(gate, saved, 'stale-source-or-context'); saved = null; continue;
      }
      sealCleanup(gate, saved);
    }
    if (!verified.evidence.passed) { a.failure_ids = verified.evidence.failure_ids || [`gate:${gate.id}:failed`]; a.diagnostic = verified.summary; save(); throw incomplete(`Gate ${gate.id} failed: ${verified.summary}`, a.failure_ids); }
    const cases = new Set((verified.evidence.cases || []).map(item => typeof item === 'string' ? item : item.id || item.fullName || item.name));
    for (const criterion of mapping.criteria.filter(item => item.gate_id === gate.id)) for (const id of criterion.test_ids) if (!cases.has(id)) throw incomplete(`Criterion ${criterion.criterion_id} references missing case ${id}`, [`criterion:${criterion.criterion_id}:missing-case`]);
  }
  if (snapshotSource(plan.root, mutablePaths).sha256 !== binding.source_sha256) throw new Error('Acceptance source changed during gates');
  await reviewStage('evidence');
  a.failure_ids = []; a.diagnostic = null; a.accepted_source_sha256 = source.sha256; a.accepted_at = new Date().toISOString(); save();
}
