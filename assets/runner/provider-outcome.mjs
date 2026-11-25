import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { classifyFailure } from './protocol.mjs';

const permanent = new Set(['authentication', 'quota', 'configuration']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function diagnostics(attempt) {
  if (typeof attempt?.log_file !== 'string' || !attempt.log_file.endsWith('.jsonl')) throw new Error('Saved provider log identity is invalid');
  const logFile = attempt.log_file, stderrFile = logFile.slice(0, -6) + '-stderr.log';
  const read = file => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('Saved provider diagnostic is missing or linked');
    return fs.readFileSync(file);
  };
  const log = read(logFile), stderr = read(stderrFile);
  return { log, stderr, hashes: { log_sha256: hash(log), stderr_sha256: hash(stderr) } };
}
export function providerEvidenceHashes(attempt) { return diagnostics(attempt).hashes; }
export function verifySavedProviderEvidence(attempt) {
  const outcome = attempt?.outcome;
  if (!outcome || outcome.log_sha256 === undefined && outcome.stderr_sha256 === undefined) return;
  const { hashes } = diagnostics(attempt);
  if (outcome.log_sha256 !== hashes.log_sha256 || outcome.stderr_sha256 !== hashes.stderr_sha256)
    throw new Error('Saved provider diagnostic evidence changed');
}
/** Older outcomes have no diagnostic hashes. Read their retained transport logs,
 * then bind those exact bytes before consuming the cached result. Never infer
 * transport success from a wire result or discard a retained provider error. */
export function restoreSavedProviderResult(attempt) {
  verifySavedProviderEvidence(attempt);
  const { log, stderr, hashes } = diagnostics(attempt), errors = [];
  let turnFailed = attempt.turn_failed === true;
  for (const line of log.toString('utf8').split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'error' || event?.type === 'turn.failed') errors.push(event);
    if (event?.type === 'turn.failed') turnFailed = true;
  }
  if (attempt.outcome) Object.assign(attempt.outcome, hashes);
  return { code: attempt.exit_code, turnCompleted: attempt.turn_completed === true,
    turnFailed, errors, stderr: stderr.toString('utf8').slice(-200_000),
    stdout: log.toString('utf8').slice(-2_000_000), resultFile: attempt.result_file,
    jsonlFile: attempt.log_file, timedOut: attempt.timed_out === true };
}
/** classifyFailure inspects only top-level provider events and CLI stderr. Its
 * existing exclusions keep worker prose, tool payloads and catalog warnings out. */
export function permanentProviderFailure(result) {
  const failure = classifyFailure(result);
  return permanent.has(failure.kind) ? failure : null;
}
