import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const boundedText = (value, max, allowEmpty = false) => typeof value === 'string' && value.length <= max && !value.includes('\0') && (allowEmpty || value.trim().length > 0);
const canonicalRelative = value => boundedText(value, 512) && !path.isAbsolute(value) && !/[\\:\x00-\x1f\x7f]/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..');
const require = (condition, message) => { if (!condition) throw new Error(`Invalid subdivision: ${message}`); };
const sha = value => createHash('sha256').update(value).digest('hex');
const textSchema = maxLength => ({ type: 'string', minLength: 1, maxLength });
const strictObject = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const textArray = (maxItems, maxLength) => ({ type: 'array', maxItems, items: textSchema(maxLength) });
const identity = {
  schema_version: { type: 'integer', const: 1 },
  package_id: { type: 'string', pattern: '^[0-9]{2}$' },
  attempt_id: { type: 'string', pattern: UUID.source },
  subdivision_id: { type: 'string', pattern: UUID.source }
};
const source = { type: 'string', pattern: HASH.source };
const checkSchema = strictObject({ command: textSchema(2000), exit_code: { type: 'integer', minimum: -1, maximum: 255 }, passed: { type: 'boolean' } });
const checkList = { type: 'array', maxItems: 20, items: checkSchema };

export const SUBDIVISION_DEFAULTS = Object.freeze({ threshold: 2, maxSubdivisions: 1, maxRotations: 3, maxRateRetries: 8 });

/** Consume one classified attempt, never reconnect notice counts or tool output. */
export function classifyTokenPressure(failure) {
  if (!object(failure) || !['rate-limit', 'failure'].includes(failure.kind)) return { explicit: false, oversized: false };
  const message = String(failure.message || '');
  const perMinute = /\bTPM\b|\btokens?\s+per\s+(?:min(?:ute)?s?)\b|\btokens?\s*\/\s*(?:min(?:ute)?s?)\b/i.test(message);
  if (!perMinute) return { explicit: false, oversized: false };
  const requested = message.match(/\brequested\s*[:=]?\s*([\d,]+(?:\.\d+)?)/i);
  const limit = message.match(/\blimit\s*[:=]?\s*([\d,]+(?:\.\d+)?)/i);
  const number = match => match ? Number(match[1].replace(/,/g, '')) : null;
  const amount = number(requested), ceiling = number(limit);
  const oversized = /\brequest(?:ed)?\b.{0,100}\btoo\s+large\b|\btoo\s+many\s+tokens\s+(?:requested|in\s+(?:one|a\s+single)\s+request)\b/i.test(message)
    || (amount !== null && ceiling !== null && ceiling > 0 && amount > ceiling);
  return { explicit: failure.kind === 'rate-limit' || oversized, oversized };
}

export const plannerResultSchema = strictObject({
  ...identity,
  status: { type: 'string', enum: ['planned', 'blocked'] },
  summary: textSchema(4000), source_sha256: source,
  subtasks: { type: 'array', maxItems: 6, items: strictObject({
    id: { type: 'string', pattern: '^0[1-6]$' }, title: textSchema(160), instructions: textSchema(6000),
    checks: { ...textArray(12, 1000), minItems: 1 }, checkpoint_file: textSchema(512)
  }) },
  blockers: textArray(12, 2000)
});

export const checkpointSchema = strictObject({
  ...identity,
  subtask_id: { type: 'string', pattern: '^0[1-6]$' },
  summary: textSchema(4000), source_sha256: source,
  changed_files: textArray(100, 512), checks: checkList, blockers: textArray(12, 2000), next_steps: textArray(12, 2000)
});

export const subtaskResultSchema = strictObject({
  ...identity,
  subtask_id: { type: 'string', pattern: '^0[1-6]$' },
  status: { type: 'string', enum: ['checkpointed', 'blocked', 'failed'] },
  summary: textSchema(4000), source_sha256: source,
  changed_files: textArray(100, 512), checks: checkList,
  checkpoint_file: textSchema(512), checkpoint_sha256: source,
  blockers: textArray(12, 2000)
});

function validateIdentity(value, { packageId, attemptId, subdivisionId, taskId, sourceHash }) {
  require(value.schema_version === 1 && /^[0-9]{2}$/.test(packageId) && value.package_id === packageId, 'package identity mismatch');
  require(UUID.test(attemptId) && value.attempt_id === attemptId, 'attempt identity mismatch');
  require(UUID.test(subdivisionId) && value.subdivision_id === subdivisionId, 'subdivision identity mismatch');
  require(HASH.test(sourceHash) && value.source_sha256 === sourceHash, 'stale or invalid source identity');
  if (taskId !== undefined) require(/^0[1-6]$/.test(taskId) && value.subtask_id === taskId, 'subtask identity mismatch');
}

function validateTextArray(value, maxItems, maxLength, label, { minItems = 0 } = {}) {
  require(Array.isArray(value) && value.length >= minItems && value.length <= maxItems && value.every(item => boundedText(item, maxLength)), `invalid ${label}`);
}

/** Reject noncanonical and symlinked paths, even for artifacts not yet created. */
export function subdivisionPath(root, relative, { artifactDirectory, mustExist = false } = {}) {
  require(canonicalRelative(relative), 'artifact path must be canonical and repository-relative');
  if (artifactDirectory !== undefined) {
    require(canonicalRelative(artifactDirectory), 'invalid artifact directory');
    require(relative.startsWith(artifactDirectory + '/'), 'artifact path is outside its subdivision directory');
  }
  require(typeof root === 'string' && fs.existsSync(root) && fs.statSync(root).isDirectory(), 'missing repository root');
  const realRoot = fs.realpathSync(root);
  let cursor = realRoot;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      require(!stat.isSymbolicLink(), 'symlinked subdivision artifact path');
      if (cursor !== path.join(realRoot, relative)) require(stat.isDirectory(), 'artifact parent is not a directory');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (mustExist) require(fs.existsSync(cursor) && fs.lstatSync(cursor).isFile(), 'checkpoint is not a regular file');
  return cursor;
}

export function validatePlannerResult(value, context) {
  require(exact(value, plannerResultSchema.required), 'planner result must contain exactly the planner schema keys');
  require(JSON.stringify(value).length <= 64 * 1024, 'planner result exceeds bounded size');
  validateIdentity(value, context);
  require(['planned', 'blocked'].includes(value.status) && boundedText(value.summary, 4000), 'invalid planner status or summary');
  validateTextArray(value.blockers, 12, 2000, 'planner blockers');
  require(Array.isArray(value.subtasks) && value.subtasks.length <= 6, 'invalid planner subtask count');
  if (value.status === 'blocked') require(value.blockers.length > 0 && value.subtasks.length === 0, 'blocked planner must identify blockers and have no scheduled subtasks');
  else require(value.blockers.length === 0 && value.subtasks.length >= 2, 'planned subdivision requires 2-6 subtasks and no blockers');
  const paths = new Set();
  for (const [index, task] of value.subtasks.entries()) {
    require(exact(task, plannerResultSchema.properties.subtasks.items.required), 'invalid subtask plan keys');
    require(task.id === String(index + 1).padStart(2, '0'), 'subtask IDs must be sequential and unique');
    require(boundedText(task.title, 160) && boundedText(task.instructions, 6000), 'invalid subtask title or instructions');
    validateTextArray(task.checks, 12, 1000, 'subtask checks', { minItems: 1 });
    subdivisionPath(context.root, task.checkpoint_file, { artifactDirectory: context.artifactDirectory });
    require(!paths.has(task.checkpoint_file), 'duplicate checkpoint path');
    paths.add(task.checkpoint_file);
  }
  return value;
}

function validateChecks(checks) {
  require(Array.isArray(checks) && checks.length <= 20, 'invalid checkpoint checks');
  for (const check of checks) require(exact(check, checkSchema.required) && boundedText(check.command, 2000)
    && Number.isInteger(check.exit_code) && check.exit_code >= -1 && check.exit_code <= 255
    && typeof check.passed === 'boolean' && check.passed === (check.exit_code === 0), 'invalid or inconsistent check evidence');
}

function validateEvidenceFields(value, context) {
  require(boundedText(value.summary, 4000), 'invalid checkpoint summary');
  validateTextArray(value.changed_files, 100, 512, 'changed files');
  require(new Set(value.changed_files).size === value.changed_files.length, 'duplicate changed file');
  for (const file of value.changed_files) {
    // A later accepted task may replace or remove this historical source path.
    // It is metadata, not an artifact read: validate its spelling without making
    // claims about the current filesystem. Checkpoint/result paths stay strict.
    if (context.historical === true) require(canonicalRelative(file), 'changed file path must be canonical and repository-relative');
    else subdivisionPath(context.root, file);
  }
  validateChecks(value.checks);
  validateTextArray(value.blockers, 12, 2000, 'checkpoint blockers');
}

export function validateCheckpoint(value, context) {
  require(exact(value, checkpointSchema.required), 'checkpoint must contain exactly the checkpoint schema keys');
  require(JSON.stringify(value).length <= 32 * 1024, 'checkpoint exceeds bounded size');
  validateIdentity(value, context);
  validateEvidenceFields(value, context);
  validateTextArray(value.next_steps, 12, 2000, 'checkpoint next steps');
  return value;
}

/** The runner uses this evidence; it never executes any reported check command. */
export function validateSubtaskResult(value, context) {
  require(exact(value, subtaskResultSchema.required), 'subtask result must contain exactly the subtask schema keys');
  require(JSON.stringify(value).length <= 32 * 1024, 'subtask result exceeds bounded size');
  validateIdentity(value, context);
  validateEvidenceFields(value, context);
  require(['checkpointed', 'blocked', 'failed'].includes(value.status), 'subtask cannot complete its parent package');
  if (value.status === 'checkpointed') require(value.blockers.length === 0 && value.checks.length > 0 && value.checks.every(check => check.passed), 'checkpointed subtask requires passing checks and no blockers');
  if (value.status === 'blocked') require(value.blockers.length > 0, 'blocked subtask must identify blockers');
  require(HASH.test(value.checkpoint_sha256), 'invalid checkpoint hash');
  if (context.checkpointFile !== undefined) require(value.checkpoint_file === context.checkpointFile, 'checkpoint does not match its planned path');
  const file = subdivisionPath(context.root, value.checkpoint_file, { artifactDirectory: context.artifactDirectory, mustExist: true });
  require(fs.statSync(file).size > 0 && fs.statSync(file).size <= 32 * 1024, 'checkpoint file exceeds bounded size or is empty');
  const bytes = fs.readFileSync(file);
  require(sha(bytes) === value.checkpoint_sha256, 'checkpoint hash mismatch');
  let checkpoint;
  try { checkpoint = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid subdivision: checkpoint is not valid JSON'); }
  validateCheckpoint(checkpoint, context);
  for (const key of checkpointSchema.required.filter(key => key !== 'next_steps')) require(JSON.stringify(checkpoint[key]) === JSON.stringify(value[key]), `checkpoint ${key} does not match subtask result`);
  return value;
}
