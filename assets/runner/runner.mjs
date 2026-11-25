import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyUnattendedCleanup } from './unattended-cleanup.mjs';
import { inspectBackgroundOwnership } from './background-ownership.mjs';
import { preflightRange } from './range-preflight.mjs';
import { probeLocalAuthentication } from './auth-readiness.mjs';
import { launchBackground, inspectBackground, stopBackground, latestBackground, backgroundLogs, publicProjection } from './background-control.mjs';
import { describeRun, acceptanceFailureDetails, writeCommandReport, startupIdentity, assertStartupIdentity, sessionFor, secureStatePath } from './unattended.mjs';
import { workerProgress } from './worker-progress.mjs';
import { redact, saveFailureReport } from './failure-report.mjs';
import { resultSchema, validateCompletion, validateWorkerResult, classifyFailure, retryDelayMs, transportRetryDelayMs } from './protocol.mjs';
import { providerEvidenceHashes, verifySavedProviderEvidence, restoreSavedProviderResult, permanentProviderFailure } from './provider-outcome.mjs';
import { captureHostValidation, verifyHostValidation, snapshotSource, snapshotDependencies } from './host-validation.mjs';
import { loadRecoveryPolicy, migrateRecoveryState, recoveryResultSchema, validateRecoveryDecision, snapshotRuntime, capturePhaseGuard, assertPhaseGuard, newPackageRecovery, recordNoProgress, recordProtocolRejection, clearProtocolFeedback, protocolCorrectionPrompt, verifyProtocolRejections, verifyAcceptanceRequests, currentAttentionReport } from './recovery.mjs';
import { runAutomaticHostValidation, reconcileAutomaticHostValidation } from './automatic-host-validation.mjs';
import { subdivisionArtifacts, verifySubdivisionArtifacts, subdivisionActor, compactCheckpoints } from './subdivision-state.mjs';
import { SUBDIVISION_DEFAULTS, classifyTokenPressure, plannerResultSchema, subtaskResultSchema, validatePlannerResult, validateSubtaskResult } from './subdivision.mjs';
import { prepareRuntimeUpgrade, applyRuntimeUpgrade, verifyRuntimeUpgradeHistory } from './runtime-reconciliation.mjs';
import { resolveAcceptanceProfile, acceptanceForPackage, verifyAcceptancePolicySources } from './acceptance-policy.mjs';
import { preflightAcceptanceCapabilities } from './acceptance-adapters.mjs';
import { ensureAcceptance, acceptanceMappingPath, acceptanceReviewSchema, acceptanceReviewPrompt, validateAcceptanceReview, compactAcceptance, acceptanceArtifacts, verifyAcceptanceArtifacts, acceptanceProgressInputs } from './acceptance-lifecycle.mjs';

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HELP = `Run a prepared software plan through Codex, one package at a time.

node run.mjs [start|resume|preflight|launch|status|logs|stop|dry-run|host-check|runtime-prepare|runtime-apply] [options]

  --step NN                  Run only this package (completed prerequisites required)
  --from NN --to NN          Bound the run; earlier prerequisites must be completed
  --fresh-session            With --step, discard only that unfinished step's session
  --host-validation PATH     With --step, use hash-bound host test evidence
  --runtime-review-note PATH With runtime-prepare, reviewed explanation inside repo
  --proposal PATH            With runtime-apply, immutable prepared proposal
  --proposal-sha256 HASH      With runtime-apply, exact reviewed proposal SHA-256
  --model NAME --profile NAME Optional Codex overrides; otherwise use CLI defaults
  --max-rate-retries N        Durable rate retry budget (default 8; 0 = unlimited)
  --tpm-threshold N          Explicit TPM failed attempts before subdivision (default 2)
  --max-session-rotations N  Fresh retry sessions inside subdivision (default 3)
  --no-recovery              Disable supervisor, transport and automatic host recovery
  --max-protocol-retries N   Durable malformed-output correction budget (default 2)
  --max-repair-retries N     Durable supervisor cycle budget (default 3)
  --max-transport-retries N  Durable transport retry budget (default 8)
  --max-evidence-refreshes N Durable stale host evidence refresh budget (default 2)
  --max-no-progress N        Stop after unchanged failures (default 2; minimum 1)
  --host-timeout-minutes N   Automatic host phase timeout (default 30)
  --retry-delay-seconds N     Initial rate-limit backoff (default 60)
  --max-delay-seconds N       Rate backoff ceiling (default 900; provider delay takes priority)
                             Transport: 10s base + jitter, 30s cap; smaller configured delays apply.
  --timeout-minutes N         Per-attempt timeout (default 120; 0 = disabled)
  --progress-seconds N        Progress heartbeat (default 15; 0 = disabled)
  --codex-bin PATH            Codex executable (default codex)
  --repo PATH                 Repository (default: current working directory)
  --manifest PATH             Manifest relative to repository (required)
  --session UUID             Select a background session (default latest)
  --json                     Machine-readable preflight/launch/status/stop output
  --help                     Show this help

launch preflights the whole range, then detaches an owned background run.
logs/status/stop inspect or cooperatively stop its recorded session.
No reboot service is installed; poweroff and closed-lid sleep remain limitations.
start and resume are identical: skip completed packages and resume the unfinished one.
Ctrl+C stops the worker and saves progress. Run the same command to continue.
Eligible failures recover automatically within durable budgets and reviewed host recipes.
Any manual:true package stops with exit 2; the requested range remains incomplete.
start/resume require manifest.ready === true. Workers cannot launch nested runners.
Runtime upgrades require runtime-prepare, review of the saved proposal, then runtime-apply.
These commands preserve package progress and never launch workers or host recipes.
status and dry-run neither invoke Codex nor create runner state.`;

export function parseOptions(argv) {
  const options = { command: 'start', repo: process.cwd(),
    codexBin: 'codex', maxRateRetries: SUBDIVISION_DEFAULTS.maxRateRetries, tpmThreshold: SUBDIVISION_DEFAULTS.threshold, maxSessionRotations: SUBDIVISION_DEFAULTS.maxRotations, retryDelaySeconds: 60, maxDelaySeconds: 900,
    timeoutMinutes: 120, progressSeconds: 15, recovery: true, maxRepairRetries: 3, maxProtocolRetries: 2, maxTransportRetries: 8, maxEvidenceRefreshes: 2, maxNoProgress: 2, hostTimeoutMinutes: 30 };
  const flags = { '--repo': 'repo', '--manifest': 'manifest', '--codex-bin': 'codexBin',
    '--model': 'model', '--profile': 'profile', '--step': 'step', '--from': 'from', '--to': 'to',
    '--tpm-threshold': 'tpmThreshold', '--max-session-rotations': 'maxSessionRotations',
    '--max-rate-retries': 'maxRateRetries', '--retry-delay-seconds': 'retryDelaySeconds',
    '--max-delay-seconds': 'maxDelaySeconds', '--timeout-minutes': 'timeoutMinutes',
    '--progress-seconds': 'progressSeconds', '--host-validation': 'hostValidation',
    '--max-repair-retries': 'maxRepairRetries', '--max-protocol-retries': 'maxProtocolRetries',
    '--max-transport-retries': 'maxTransportRetries', '--max-evidence-refreshes': 'maxEvidenceRefreshes',
    '--max-no-progress': 'maxNoProgress', '--host-timeout-minutes': 'hostTimeoutMinutes',
    '--session': 'session', '--runtime-review-note': 'runtimeReviewNote', '--proposal': 'proposal', '--proposal-sha256': 'proposalSha256' };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) options.command = args.shift();
  if (!['start', 'resume', 'preflight', 'launch', 'status', 'logs', 'stop', 'dry-run', 'host-check', 'runtime-prepare', 'runtime-apply'].includes(options.command)) throw new Error('Unknown command. Use --help.');
  const seen = new Set();
  while (args.length) {
    const flag = args.shift();
    if (flag === '--json' && !options.json) { options.json = true; continue; }
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--no-recovery' && options.recovery) { options.recovery = false; continue; }
    if (flag === '--fresh-session' && !options.freshSession) { options.freshSession = true; continue; }
    if (!flags[flag] || !args.length || args[0].startsWith('--') || seen.has(flag)) throw new Error(`Invalid or repeated option: ${flag}`);
    seen.add(flag);
    options[flags[flag]] = args.shift();
  }
  for (const key of ['tpmThreshold', 'maxSessionRotations', 'maxRateRetries', 'retryDelaySeconds', 'maxDelaySeconds', 'timeoutMinutes', 'progressSeconds', 'maxRepairRetries', 'maxProtocolRetries', 'maxTransportRetries', 'maxEvidenceRefreshes', 'maxNoProgress', 'hostTimeoutMinutes']) {
    options[key] = Number(options[key]);
    if (!Number.isFinite(options[key]) || options[key] < 0 || options[key] > 1e6) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(options.maxRateRetries) || !options.retryDelaySeconds || options.maxDelaySeconds < options.retryDelaySeconds) throw new Error('Invalid retry limits or delays.');
  for (const key of ['tpmThreshold', 'maxSessionRotations', 'maxRepairRetries', 'maxProtocolRetries', 'maxTransportRetries', 'maxEvidenceRefreshes', 'maxNoProgress']) {
    if (!Number.isInteger(options[key])) throw new Error(`Invalid retry limit: ${key}`);
  }
  if (options.maxSessionRotations > 100) throw new Error('Session rotation budget cannot exceed 100.');
  if (!options.tpmThreshold || !options.maxNoProgress || !options.hostTimeoutMinutes) throw new Error('Progress and host timeout limits must be positive.');
  for (const key of ['step', 'from', 'to']) {
    if (options[key] !== undefined) {
      if (!/^\d{1,2}$/.test(options[key])) throw new Error(`Invalid ${key}`);
      options[key] = options[key].padStart(2, '0');
    }
  }
  if (options.step && (options.from || options.to)) throw new Error('Use --step or --from/--to, not both.');
  if (options.freshSession && !options.step) throw new Error('--fresh-session requires an explicit --step.');
  if ((options.hostValidation || options.command === 'host-check') && !options.step) throw new Error('Host validation requires an explicit --step.');
  if (options.hostValidation && !['start', 'resume', 'launch', 'preflight', 'dry-run'].includes(options.command)) throw new Error('--host-validation is only valid with start, resume or dry-run.');
  if ((options.runtimeReviewNote || options.command === 'runtime-prepare') && (options.command !== 'runtime-prepare' || !options.runtimeReviewNote)) throw new Error('runtime-prepare requires --runtime-review-note.');
  if ((options.proposal || options.proposalSha256 || options.command === 'runtime-apply') && (options.command !== 'runtime-apply' || !options.proposal || !/^[a-f0-9]{64}$/.test(options.proposalSha256 || ''))) throw new Error('runtime-apply requires --proposal and the exact --proposal-sha256.');
  if (options.command.startsWith('runtime-') && (options.step || options.from || options.to || options.freshSession || options.hostValidation)) throw new Error('Runtime reconciliation applies to the runtime identity, not a package selection.');
  if (!options.manifest) throw new Error('--manifest is required. Prepare a plan or use its generated wrapper.');
  if (options.session && (!UUID.test(options.session) || !['status','logs','stop'].includes(options.command))) throw new Error('--session requires a UUID and status/logs/stop.');
  if (options.json && !['preflight','launch','status','stop'].includes(options.command)) throw new Error('--json is valid only with preflight/launch/status/stop.');
  return options;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sha(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
export function atomicJson(file, value, beforeReplace) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    // Building/fsyncing the next checkpoint can take time. Recheck the old
    // state immediately before replacement instead of trusting an earlier read.
    beforeReplace?.();
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (cleanup) { if (cleanup.code !== 'ENOENT') error.cleanup_error = cleanup.message; }
    throw error;
  }
  // Bind exactly the bytes this parent wrote. Re-reading the pathname here
  // could adopt an outside writer's mutation as the next expected checkpoint.
  return createHash('sha256').update(bytes).digest('hex');
}
function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error(`Expected a repository-relative path: ${relative}`);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) throw new Error(`Path escapes repository: ${relative}`);
  // Check the nearest existing ancestor as well, so symlink parents cannot escape.
  let ancestor = file;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const real = fs.realpathSync(ancestor);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`Symlink escapes repository: ${relative}`);
  return file;
}
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function source(root) { return { head: git(root, 'rev-parse', 'HEAD'), branch: git(root, 'branch', '--show-current'), dirty: Boolean(git(root, 'status', '--porcelain')) }; }
function alive(pid) {
  if (!Number.isInteger(pid) || pid === 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

export function loadPlan(options) {
  const root = fs.realpathSync(options.repo);
  if (fs.realpathSync(git(root, 'rev-parse', '--show-toplevel')) !== root) throw new Error('--repo must be the Git working-tree root.');
  const manifestFile = inside(root, options.manifest);
  const manifest = readJson(manifestFile);
  if (manifest.schema_version !== 1 || !/^[a-z0-9-]+$/.test(manifest.plan_id) || !Array.isArray(manifest.steps) || !manifest.steps.length) throw new Error('Invalid plan manifest.');
  const ids = new Set(), paths = new Set();
  for (const step of manifest.steps) {
    if (typeof step.id !== 'string' || !/^\d{2}$/.test(step.id) || ids.has(step.id) || typeof step.title !== 'string' || typeof step.manual !== 'boolean') throw new Error('Invalid or duplicate package.');
    if (!Array.isArray(step.dependencies) || step.dependencies.some(id => !ids.has(id))) throw new Error(`Package ${step.id} has unordered/missing dependencies.`);
    for (const key of ['plan', 'validation', 'handoff']) {
      inside(root, step[key]);
      if (paths.has(step[key])) throw new Error('Duplicate package artifact path.');
      paths.add(step[key]);
    }
    ids.add(step.id);
  }
  const inputs = [options.manifest, manifest.source, manifest.contract, manifest.worker_contract, ...manifest.steps.map(step => step.plan)];
  const fingerprint = () => createHash('sha256').update(JSON.stringify(inputs.map(file => [file, sha(inside(root, file))]))).digest('hex');
  const stateDir = inside(root, `.codex-plan-runner/${manifest.plan_id}`);
  const stateFile = path.join(stateDir, 'state.json');
  const planHash = fingerprint();
  const state = fs.existsSync(stateFile) ? readJson(stateFile) : { schema_version: 1, plan_id: manifest.plan_id, root, plan_hash: planHash, steps: {} };
  if (state.schema_version !== 1 || state.root !== root || state.plan_hash !== planHash || state.plan_id !== manifest.plan_id || !state.steps || typeof state.steps !== 'object' || Array.isArray(state.steps)) throw new Error('Runner state does not match this checkout/plan, or is invalid. Inspect it; it will not be reset automatically.');
  const statuses = ['pending', 'running', 'incomplete', 'completed', 'blocked', 'failed', 'interrupted', 'waiting-for-rate-limit', 'waiting-for-transport'];
  for (const [id, entry] of Object.entries(state.steps)) {
    if (!ids.has(id) || !entry || !statuses.includes(entry.status) || !Number.isInteger(entry.attempts) || entry.attempts < 0 || (entry.thread_id && !UUID.test(entry.thread_id))) throw new Error('Invalid package state.');
    if (entry.retry_at && !Number.isFinite(Date.parse(entry.retry_at))) throw new Error('Invalid saved retry deadline.');
    if (['rate_limit_count', 'transport_failure_count', 'repair_failure_count'].some(key => entry[key] !== undefined && (!Number.isInteger(entry[key]) || entry[key] < 0))) throw new Error('Invalid retry count in package state.');
  }
  return { root, manifest, stateDir, stateFile, state, planHash, fingerprint };
}

function withLockGuard(plan, action) {
  const guard = path.join(plan.stateDir, 'lock-guard');
  try { fs.mkdirSync(guard, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') throw new Error(`Another lock operation is active: ${guard}. If a hard crash left it behind, inspect processes before removing that empty directory.`); throw e; }
  try { return action(); } finally { fs.rmdirSync(guard); }
}
function acquireLock(plan, ownSession) {
  return withLockGuard(plan, () => {
    inspectBackgroundOwnership({ root: plan.root, stateDir: plan.stateDir, planId: plan.manifest.plan_id, ownSession });
    const file = path.join(plan.stateDir, 'runner.lock');
    if (fs.existsSync(file)) {
      const owner = readJson(file);
      if (owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || !owner.token) throw new Error(`Unrecognized lock; inspect ${file}`);
      if (alive(owner.pid) || alive(owner.worker_pid) || (owner.worker_pid && alive(-owner.worker_pid))) throw new Error(`Another runner or its worker is still active (runner ${owner.pid}, worker ${owner.worker_pid || 'none'}).`);
      fs.unlinkSync(file);
    }
    const owner = { pid: process.pid, worker_pid: null, hostname: os.hostname(), token: randomUUID(), runtime_directory: snapshotRuntime().directory };
    fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    return {
      file, token: owner.token,
      worker(pid) { owner.worker_pid = pid; atomicJson(file, owner); },
      release() { if (owner.worker_pid && (alive(owner.worker_pid) || alive(-owner.worker_pid))) throw new Error('Owned worker cleanup remains unresolved; preserving runner lock.'); withLockGuard(plan, () => { if (readJson(file).token !== owner.token) throw new Error('Lock ownership changed.'); fs.unlinkSync(file); }); }
    };
  });
}

export function codexArgs(options, { root, schemaFile, resultFile, threadId, role = 'worker' }) {
  const args = ['exec'];
  if (options.profile) args.push('--profile', options.profile);
  args.push('--sandbox', ['planner', 'acceptance-reviewer'].includes(role) ? 'read-only' : 'workspace-write', '-c', 'approval_policy="never"', '-C', root);
  if (threadId) args.push('resume');
  args.push('--json', '--output-schema', schemaFile, '--output-last-message', resultFile);
  if (options.model) args.push('--model', options.model);
  if (threadId) args.push(threadId);
  args.push('-');
  return args;
}

function acceptanceHandoffPrompt(plan, step, entry) {
  const profile = acceptanceForPackage(plan.acceptanceProfile, step.id);
  if (!profile) return '';
  return `\nSTRICT_PARENT_ACCEPTANCE_HANDOFF
The frozen strict profile already authorizes these parent-owned gates: ${JSON.stringify(profile.required_gates)}.
When implementation and ${acceptanceMappingPath(step)} are ready for parent review, return status "acceptance-ready" using the ordinary result schema, prescribed artifact paths and current attempt ID, with blockers: []. This is an explicit noncompletion request. It does not require a final validation receipt or handoff to exist; do not fabricate passing checks or claim completed before evidence exists. Preserve any truthful partial artifacts.
Sandbox restrictions on these configured gates are deferred parent checks, not external blockers. Missing implementation/tests/mapping still require in-scope work. Genuine absent service, permission, input or decision remains status blocked with precise blockers; never hide it in an acceptance-ready summary. The request supplies no commands, recipes, capability overrides or authority.
Finalization must reference retained parent evidence in place; do not copy its logs or reports into docs/NN-evidence. Only the prescribed final validation file, handoff file and package-directory README.md are excluded from the source generation. Source, mapping or additional evidence writes require fresh parent acceptance. Attribute reused strict checks with origin:"parent-acceptance" and exact retained evidence references. Do not set receipt.host_validation or origin:"host-validation" merely for strict parent evidence; those belong to the separate explicitly supplied legacy --host-validation path.
The parent durably resumes mapping review, fixed configured gates and independent evidence review, then returns to this original worker/finalizer conversation. Read the exact parent evidence references below and their logs. Attribute reused checks to parent execution, not your sandbox. Write current truthful completion artifacts only after the required checks pass. If source changes invalidate evidence, request acceptance-ready again for bounded refresh. Repeated handoff without finalization is bounded and never completes the package.
${entry.recovery?.acceptance_request ? `Saved handoff: ${JSON.stringify(entry.recovery.acceptance_request)}\nParent acceptance evidence: ${compactAcceptance(entry)}` : ''}\n`;
}

function makePrompt(plan, step, entry, attemptId) {
  return `CODEX_PLAN_WORKER=1
You are a worker executing exactly one assigned package of a prepared software plan.
PACKAGE_ID: ${step.id}
ATTEMPT_ID: ${attemptId}
Repository: ${plan.root}
Read applicable AGENTS.md instructions, ${plan.manifest.contract}, ${plan.manifest.worker_contract}, and ${step.plan}.
${acceptanceHandoffPrompt(plan, step, entry)}
Read previous handoffs: ${step.dependencies.map(id => plan.manifest.steps.find(s => s.id === id).handoff).join(', ') || 'none'}.
The source plan is ${plan.manifest.source}. Do not load sibling packages unless needed to understand a dependency.

${acceptanceForPackage(plan.acceptanceProfile || { mode: 'legacy', packages: {} }, step.id) ? `Strict parent acceptance requires ${acceptanceMappingPath(step)}. Read ${path.relative(plan.root, path.join(runtimeDirectory, 'acceptance-fixtures.md'))} and the frozen acceptance profile, then create complete criterion-to-test mappings using the required gate IDs and actual files/case names. Missing files are implementation deliverables. Parent executes only fixed capabilities after independent review. Profile: ${JSON.stringify(acceptanceForPackage(plan.acceptanceProfile, step.id))}` : 'Acceptance mode: legacy receipt verification; no stronger semantic guarantee is implied.'}
Complete only package ${step.id}. Keep all unrelated and pre-existing uncommitted work.
Never initialize another plan, install or prepare a runner, invoke a plan runner, or schedule another package.
If a plan-and-run skill instruction appears, this worker contract takes precedence: implement this assigned package directly.
Inspect existing files and unfinished tool effects before repeating operations, including on a resumed session.
Unknown external effects must be inspected and reconciled before any retry; never blindly repeat them.
Keep read-only work read-only and follow the task-specific authorization recorded in the shared contract.
Do not spend, call paid APIs, deploy, publish, send messages, or mutate live/external systems unless that specific action is authorized there.
Use local or synthetic validation where possible; preserve user data, unrelated worktrees and existing runtimes.
Do not edit the runner, its manifest/state/logs, the source plan, shared contract, worker contract or package specifications.
Only the outer runner decides scheduling.
Run the package's actual acceptance checks and applicable AGENTS.md checks. Never mark skipped, failed, or unknown acceptance gates passed.
If required services, permissions or a decision prevent completion, return blocked with a precise reason. Do not work around sandbox restrictions.
Attempt bounded in-scope source and prerequisite implementation reconciliation before reporting a blocker. Attribute corrections to this package; preserve accepted predecessor evidence. Never install dependencies, edit credentials or npm scripts, change frozen goals or weaken acceptance. A parent recovery supervisor may select only explicitly reviewed host recipe IDs.

${plan.hostValidation ? `
The parent has supplied independently executed and verified host checks for this package.
HOST_VALIDATION_FILE: ${plan.hostValidation.relativeFile}
HOST_VALIDATION_SHA256: ${plan.hostValidation.sha256}
Read this evidence and its logs. ${plan.hostValidation.summary}
The runner verified the exact source inventory, plan, package and log hashes before this attempt and will recheck before accepting completion.
You may reuse those actual host checks if their source inputs remain unchanged. Attribute them as host execution; do not claim you executed them in the worker sandbox. Record each reused check with origin:"host-validation" and add host_validation:{file:"${plan.hostValidation.relativeFile}",sha256:"${plan.hostValidation.sha256}"} to your validation receipt.
Run remaining package checks normally. If source changes are needed, preserve the change and return blocked requesting fresh host-check evidence; stale host evidence cannot complete this package. Only this package's validation receipt, handoff and package-index README may change without invalidating the tested source inventory. Frozen plan changes are still prohibited. Preserve the supplied source baseline, and distinguish intervening operator recovery changes from this worker's edits.
` : ''}

${entry.thread_id ? 'Resume this package in its saved conversation. This is not an exact tool replay; inspect partial changes and checkpoints first.' : 'Start a fresh conversation for this package; preserve any partial work already present.'}
Previous diagnostic: ${entry.diagnostic || 'none'}

Write ${step.validation} and ${step.handoff}. Read ${plan.manifest.worker_contract} for the receipt contract.
Receipt JSON must contain schema_version:1, package_id:"${step.id}", attempt_id:"${attemptId}", status,
source:{head:<current git HEAD>,branch:<current branch>,dirty:<boolean>}, changed_files:[<repository paths>],
checks:[{command:<actual check>,exit_code:<integer>,passed:<boolean>}], fixtures:[{id,kind,location}], blockers:[<strings>].
Successful completion requires at least one real passing check, all required checks passed, and no blockers.
The handoff must describe changed files, real results, fixture identities, remaining limitations, and exact next-package instruction.
Return ONLY the final JSON matching the supplied output schema, with validation_file:"${step.validation}" and handoff_file:"${step.handoff}".
Use this attempt ID in both the final result and receipt. Do not claim completed merely because the turn or token budget ends.
If work remains at the end of your turn, return incomplete or failed with truthful diagnostics; an explicit blocker must use blocked.
Stop after this package. Only the outer runner decides whether another attempt or package is authorized.
`;
}

async function runAttempt({ plan, options, step, entry, attemptId, lock, signal, save, log, role = 'worker', prompt }) {
  const prefix = path.join(plan.stateDir, 'logs', `${step.id}-${role === "worker" ? "" : role + "-"}${entry.attempts}-${attemptId}`);
  const resultFile = `${prefix}-result.json`, jsonlFile = `${prefix}.jsonl`, stderrFile = `${prefix}-stderr.log`;
  const schemaFile = path.join(plan.stateDir, role === 'acceptance-reviewer' ? 'acceptance-review-schema.json' : role === 'supervisor' ? 'recovery-result-schema.json' : ['planner', 'subtask'].includes(role) ? `${role}-result-schema.json` : 'result-schema.json');
  const args = codexArgs(options, { root: plan.root, schemaFile, resultFile, threadId: entry.thread_id, role });
  const outFd = fs.openSync(jsonlFile, 'wx', 0o600), errFd = fs.openSync(stderrFile, 'wx', 0o600);
  fs.writeFileSync(resultFile, '', { flag: 'wx', mode: 0o600 });
  entry.last_attempt = { role, attempt_id: attemptId, result_file: resultFile, log_file: jsonlFile, started_at: new Date().toISOString() };
  if (['worker', 'finalizer'].includes(role) && plan.state.steps[step.id]?.recovery?.acceptance_request) {
    entry.last_attempt.parent_acceptance_source_sha256 = plan.state.steps[step.id].acceptance?.accepted_source_sha256 || null;
  }
  save();
  const progress = workerProgress(step.id, { intervalSeconds: options.progressSeconds, log });
  let buffer = '', stdout = '', stderr = '', errors = [], turnFailed = false, turnCompleted = false, timedOut = false;
  const resumed = Boolean(entry.thread_id);
  const parseLine = line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'thread.started' && UUID.test(event.thread_id)) {
      const request = plan.state.steps[step.id]?.recovery?.acceptance_request;
      // Only an explicitly cleared actor may acquire a replacement binding.
      // Immutable request history retains the originating conversation.
      if (request?.actor === role && request.thread_id === null && !resumed) request.thread_id = event.thread_id;
      entry.thread_id = event.thread_id; save();
    }
    if (event.type === 'turn.completed') turnCompleted = true;
    if (event.type === 'turn.failed') turnFailed = true;
    if (event.type === 'error' || event.type === 'turn.failed') errors.push(event);
  };
  let child, killTimer, timeout, code = 1, exitSignal, spawnError, protectionError;
  const killGroup = sig => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, sig); } catch (e) { if (e.code !== 'ESRCH') child.kill(sig); }
  };
  const stop = () => { killGroup('SIGTERM'); if (!killTimer) killTimer = setTimeout(() => killGroup('SIGKILL'), 5000); };
  try {
    child = spawn(options.codexBin, args, { cwd: plan.root, env: { ...process.env, CODEX_PLAN_WORKER: '1', CODEX_PLAN_ROLE: role, ...(role === 'supervisor' ? { CODEX_RECOVERY_SUPERVISOR: '1' } : {}) }, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    lock.worker(child.pid || null);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    if (options.timeoutMinutes) timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMinutes * 60000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      fs.writeSync(outFd, chunk); progress.push(chunk);
      stdout = (stdout + chunk).slice(-2_000_000);
      buffer += chunk;
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        try { parseLine(line); } catch (error) { protectionError = error; stop(); break; }
      }
      if (buffer.length > 2_000_000) buffer = ''; // Keep logs; do not grow memory on malformed output.
    });
    child.stderr.on('data', chunk => { fs.writeSync(errFd, chunk); stderr = (stderr + chunk).slice(-200_000); });
    child.stdin.on('error', () => {}); // A rejected CLI invocation can close stdin before reading.
    const closed = new Promise(resolve => {
      child.on('error', error => { spawnError = error; });
      // A surviving grandchild can hold inherited pipes open after Codex exits.
      // Clean its group on exit, before waiting for the stdio 'close' event.
      child.on('exit', () => killGroup('SIGKILL'));
      child.on('close', (exitCode, signalName) => { exitSignal = signalName; resolve(exitCode ?? 1); });
    });
    const packageEntry = plan.state.steps[step.id] || entry;
    child.stdin.end((prompt || makePrompt(plan, step, entry, attemptId)) + `\nParent acceptance evidence: ${compactAcceptance(packageEntry)}\n` + protocolCorrectionPrompt(packageEntry.recovery || {}, role));
    code = await closed;
    if (buffer) parseLine(buffer);
  } finally {
    clearTimeout(timeout); clearTimeout(killTimer);
    signal.removeEventListener('abort', stop);
    // Stop surviving children in this worker's process group before another attempt.
    killGroup('SIGKILL');
    let cleanupError;
    try {
      if (child?.pid) {
        const deadline = Date.now() + 3000;
        while (alive(-child.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        if (alive(-child.pid)) throw new Error('Owned worker process group survived cleanup; inspect retained runner lock.');
      }
      lock.worker(null);
    } catch (error) { cleanupError = error; }
    finally { fs.closeSync(outFd); fs.closeSync(errFd); progress.stop(code); }
    if (cleanupError) throw cleanupError;
  }
  if (protectionError) throw protectionError;
  if (spawnError) stderr += `\n${spawnError.message}`;
  entry.last_attempt.exit_code = code;
  entry.last_attempt.turn_completed = turnCompleted;
  entry.last_attempt.turn_failed = turnFailed;
  entry.last_attempt.timed_out = timedOut;
  if (signal.aborted) entry.last_attempt.interrupted = true;
  entry.last_attempt.finished_at = new Date().toISOString();
  // Retain a timed-out wire snapshot so replay charges the same failure path.
  // Operator cancellation never produces a reusable completion snapshot.
  if (code === 0 && turnCompleted && !turnFailed && !signal.aborted) entry.last_attempt.outcome = { ...completedOutcome(plan, step, resultFile, role), ...providerEvidenceHashes(entry.last_attempt) };
  save();
  return { code, signal: exitSignal, stdout, stderr, errors, turnCompleted, turnFailed, timedOut, resultFile, jsonlFile, threadId: entry.thread_id, resumed };
}

function protocolRejectionArtifact(plan, resultFile) {
  // Preserve absent output as a parent observation, never a fabricated decision.
  let file = resultFile;
  if (!fs.existsSync(file)) {
    file = resultFile + '.missing.json';
    const observation = JSON.stringify({ schema_version: 1, kind: 'missing-protocol-output', expected_file: path.relative(plan.root, resultFile) }) + '\n';
    if (!fs.existsSync(file)) fs.writeFileSync(file, observation, { flag: 'wx', mode: 0o600 });
    else if (fs.readFileSync(file, 'utf8') !== observation) throw new Error('Missing output observation was modified');
  }
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Protocol output must be a regular file');
  return { file: path.relative(plan.root, file), sha256: sha(file) };
}

function completedOutcome(plan, step, resultFile, role = 'worker') {
  const optional = relative => { const file = inside(plan.root, relative); return fs.existsSync(file) ? sha(file) : null; };
  const outcome = { source_sha256: snapshotSource(plan.root, mutableHostPaths(step)).sha256, result_sha256: fs.existsSync(resultFile) ? sha(resultFile) : null };
  if (['worker', 'finalizer'].includes(role)) Object.assign(outcome, { validation_sha256: optional(step.validation), handoff_sha256: optional(step.handoff) });
  if (role === 'subtask') {
    let result; try { result = readJson(resultFile); } catch { /* Validation reports malformed output. */ }
    if (typeof result?.checkpoint_file === 'string') {
      // Untrusted checkpoint references are validated by the protocol layer.
      // Do not follow escapes/symlinks while recording the transport outcome.
      try {
        const target = inside(plan.root, result.checkpoint_file);
        outcome.checkpoint_sha256 = fs.lstatSync(target, { throwIfNoEntry: false })?.isFile() && fs.realpathSync(target) === target ? optional(result.checkpoint_file) : null;
      } catch { outcome.checkpoint_sha256 = null; }
    }
  }
  return outcome;
}
function savedOutcomeCurrent(plan, step, attempt) {
  if (!attempt?.outcome) return false;
  verifySavedProviderEvidence(attempt);
  const { log_sha256, stderr_sha256, ...outcome } = attempt.outcome;
  return JSON.stringify(outcome) === JSON.stringify(completedOutcome(plan, step, attempt.result_file, attempt.role || 'worker'));
}

function validateArtifacts(plan, step, entry, resultFile, attemptId) {
  const result = readJson(resultFile);
  if (result.status !== 'completed') {
    // Non-completion is handled separately; it can never advance the scheduler.
    throw new Error(`Worker reported ${result.status}: ${result.summary || ''}`);
  }
  const receipt = readJson(inside(plan.root, step.validation));
  const handoff = fs.readFileSync(inside(plan.root, step.handoff), 'utf8');
  validateCompletion({ result, receipt, handoff, step, attemptId, head: git(plan.root, 'rev-parse', 'HEAD') });
  const pending = entry.recovery?.pending_evidence;
  if (entry.recovery?.subdivision && pending?.file && (plan.hostValidation?.relativeFile !== pending.file || plan.hostValidation?.sha256 !== pending.sha256)) {
    throw new Error('Final package acceptance requires the current pending host validation evidence.');
  }
  if (plan.hostValidation) {
    const host = plan.hostValidation;
    if (sha(host.file) !== host.sha256) throw new Error('Host validation evidence changed during the worker attempt.');
    const verified = verifyHostValidation({ root: plan.root, packageId: step.id, planHash: plan.planHash, file: host.file, mutablePaths: mutableHostPaths(step) });
    if (receipt.host_validation?.file !== host.relativeFile || receipt.host_validation?.sha256 !== host.sha256) throw new Error('Receipt must explicitly cite the supplied host validation evidence.');
    for (const { command } of verified.evidence.checks) {
      if (!receipt.checks.some(check => check.command === command && check.origin === 'host-validation' && check.passed && check.exit_code === 0)) throw new Error(`Receipt must attribute ${command} to host-validation.`);
    }
    entry.host_validation = { file: host.relativeFile, sha256: host.sha256 };
  } else if (receipt.host_validation || receipt.checks.some(check => check.origin === 'host-validation')) {
    throw new Error('Host check attribution requires an explicit --host-validation argument for this invocation.');
  }
  if (plan.fingerprint() !== plan.planHash) throw new Error('Worker changed the frozen plan or manifest.');
  entry.artifacts = { validation_sha256: sha(inside(plan.root, step.validation)), handoff_sha256: sha(inside(plan.root, step.handoff)), result_sha256: fs.existsSync(resultFile) ? sha(resultFile) : null };
}
function verifyCompleted(plan, step) {
  const entry = plan.state.steps[step.id];
  if (entry?.status !== 'completed') return;
  verifyAcceptanceArtifacts(plan.root, entry);
  if (!entry.artifacts || entry.artifacts.validation_sha256 !== sha(inside(plan.root, step.validation)) || entry.artifacts.handoff_sha256 !== sha(inside(plan.root, step.handoff)) || entry.artifacts.result_sha256 !== sha(entry.last_attempt.result_file)) throw new Error(`Completed package ${step.id} artifacts changed or are missing. Inspect before continuing.`);
  if (entry.host_validation) {
    const file = inside(plan.root, entry.host_validation.file);
    if (sha(file) !== entry.host_validation.sha256) throw new Error(`Completed package ${step.id} host evidence changed or is missing.`);
    verifyHostValidation({ root: plan.root, packageId: step.id, planHash: plan.planHash, file, mutablePaths: mutableHostPaths(step), checkSource: false });
  }
}
function mutableHostPaths(step) {
  return [step.validation, step.handoff, path.join(path.dirname(step.plan), 'README.md')];
}
function selection(plan, options) {
  const ids = plan.manifest.steps.map(step => step.id);
  const from = options.step || options.from || ids[0], to = options.step || options.to || ids.at(-1);
  if (!ids.includes(from) || !ids.includes(to) || ids.indexOf(from) > ids.indexOf(to)) throw new Error('Unknown or reversed package range.');
  return plan.manifest.steps.slice(ids.indexOf(from), ids.indexOf(to) + 1);
}
async function waitUntil(time, signal) {
  while (!signal.aborted && Date.now() < time) {
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, Math.min(30_000, time - Date.now()));
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

function recipeConfiguration(root) {
  const file = path.join(root, 'package.json');
  const packageJson = fs.existsSync(file) ? readJson(file) : null;
  return createHash('sha256').update(JSON.stringify(packageJson ? { scripts: packageJson.scripts || {}, config: packageJson.config || {}, packageManager: packageJson.packageManager || null } : null)).digest('hex');
}

function supervisorPrompt(plan, step, entry, attemptId) {
  return `CODEX_PLAN_WORKER=1
RECOVERY_SUPERVISOR=1
PACKAGE_ID: ${step.id}
ATTEMPT_ID: ${attemptId}
Repository: ${plan.root}
You are the bounded recovery supervisor for this package, not its completion worker.
Read applicable AGENTS.md, ${plan.manifest.contract}, ${plan.manifest.worker_contract}, ${step.plan}, and the worker diagnostic below. Never initialize another plan or launch nested runners.
Inspect existing source, partial tool effects and previous handoffs before any retry. Unknown external effects require reconciliation, never blind repetition.
Diagnose implementation defects, necessary dependency implementation defects, environment restrictions or genuine external blockers. You may correct source/dependency implementation within the existing agreed goal and acceptance criteria. Attribute prerequisite corrections to this current package and additive recovery notes; never rewrite accepted receipts or rerun completed packages.
Do not edit frozen source plans/contracts/specifications, accepted artifacts, runner runtime, recovery policy, state, logs or scheduling. Do not finish this package, relax checks, install dependencies, change credentials/provider, deploy, send messages, spend, or mutate original databases/services. The worker/supervisor sandbox and approval policy remain unchanged.
Return the separate recovery result JSON. action resume requests the original worker; action host-check selects only a reviewed legacy recipe ID; action acceptance-check requests the existing strict parent acceptance profile only (classification environment, recipe_id null, blockers []). It is allowed only for this nonmanual strict package returning to its original worker/finalizer. It never selects commands, recipes, gates or overrides. action blocked reports genuine missing authority, input or service and next operator action; never erase an external blocker to request execution. Sandbox-only restrictions on already configured strict gates are deferred parent checks. Missing mapping/tests/source must be repaired or returned to the worker. Never supply a command or argv. Environment scrubbing is not a sandbox; no unsupported database/browser/deployment adapters exist.
Configured strict profile: ${JSON.stringify(acceptanceForPackage(plan.acceptanceProfile, step.id))}
Parent acceptance evidence: ${compactAcceptance(entry)}
Parent acceptance-check success resumes the saved worker/finalizer with exact evidence for current truthful final artifacts; the supervisor and parent gates cannot complete the package.
Allowed host recipes: ${JSON.stringify(plan.recoveryPolicy.value.packages[step.id]?.recipes || [])}
A host recipe runs only after this parent validates the decision, frozen inputs and source identity. It never constitutes package completion.
Worker diagnostic: ${entry.diagnostic || 'No diagnostic saved; inspect previous attempt files.'}
Previous attempt: ${JSON.stringify(entry.last_attempt || null)}
Recovery history: ${JSON.stringify(entry.recovery.history.slice(-8))}
Return actor: ${entry.recovery.return_actor || 'worker'}
Compact subdivision checkpoints and partial effects: ${compactCheckpoints(entry)}
Preserved worker session: ${entry.thread_id || 'none'}
Previous handoffs: ${step.dependencies.map(id => plan.manifest.steps.find(s => s.id === id).handoff).join(', ') || 'none'}
Return only JSON matching the supplied recovery schema, with package_id ${step.id} and attempt_id ${attemptId}.
`;
}

function subdivisionDirectory(plan, step, entry) {
  return path.relative(plan.root, path.join(plan.stateDir, 'subdivisions', `${step.id}-${entry.recovery.subdivision.id}`));
}
function boundedPrompt(plan, step, entry, attemptId, role, sourceHash) {
  const s = entry.recovery.subdivision;
  const directory = subdivisionDirectory(plan, step, entry);
  const task = role === 'subtask' ? s.tasks[s.next_task] : null;
  const identity = `CODEX_PLAN_WORKER=1\nROLE: ${role}\nPACKAGE_ID: ${step.id}\nATTEMPT_ID: ${attemptId}\nSUBDIVISION_ID: ${s.id}\nSOURCE_SHA256: ${sourceHash}\nARTIFACT_DIRECTORY: ${directory}`;
  if (role === 'finalizer') return `${makePrompt(plan, step, { ...entry, thread_id: s.finalizer.thread_id }, attemptId)}\n${identity}\nYou are the fresh original-package finalizer. Checkpoint acceptance never completes the package. Read the original contract and run ALL original acceptance checks; write the original final receipt and handoff only after they pass. For configured strict parent gates, use the explicit acceptance-ready handoff above when source/mapping are ready and evidence is pending; the parent resumes this same finalizer with exact evidence. Inspect unresolved diagnostics, checkpoint evidence and partial effects. Do not infer acceptance from a checkpoint.\nCompact checkpoints: ${compactCheckpoints(entry)}\n`;
  return `${identity}
Repository: ${plan.root}
Read applicable AGENTS.md, original contract ${plan.manifest.contract}, worker contract ${plan.manifest.worker_contract}, and original package ${step.plan}. These remain authoritative and unchanged. Do not load siblings or raw old conversations. Keep the original scope and every final acceptance gate.
${role === 'planner' ? `You are a read-only bounded planning worker. Propose 2-6 sequential small subtasks for only the remaining original scope. Use ids 01..06 in order and checkpoint paths ${directory}/01-checkpoint.json etc. Do not edit source or any files. Return your result only in the final JSON response; the CLI writes --output-last-message outside the tool sandbox. Do not use a tool to write the result. No commands or argv will be executed by the parent; checks are descriptions for the later sandbox worker. Return planned or blocked using the separate planner schema.` : `SUBTASK_ID: ${task.id}\nCHECKPOINT_FILE: ${task.checkpoint_file}\nImplement only this remaining-scope subtask: ${JSON.stringify({ id: task.id, title: task.title, instructions: task.instructions, checks: task.checks })}. The proposal is subordinate to the original package contract. Use a fresh independent session. Inspect partial changes and unknown tool effects before repeating any actions. Return checkpointed only with real passing local checks; otherwise return blocked or failed with truthful checks and blockers. Write the prescribed JSON checkpoint with schema_version,package_id,attempt_id,subdivision_id,subtask_id,summary,source_sha256,changed_files,checks,blockers,next_steps. These fields must match the result; next_steps is a bounded string array. Hash its bytes into checkpoint_sha256. Your source_sha256 must be the post-work snapshotSource(root, ${JSON.stringify(mutableHostPaths(step))}).sha256 from ${path.relative(plan.root, path.join(runtimeDirectory, 'host-validation.mjs'))}. This excludes ignored runner artifacts. The parent independently verifies it. Checkpoints do not complete a package.`}
Do not write final artifacts ${step.validation} or ${step.handoff}. Do not edit runner runtime, state, logs, accepted evidence, frozen contracts/plans, npm scripts/configuration, dependencies, credentials, provider or model. ${role === 'planner' ? 'Do not write any runner-directory output.' : 'The only permitted runner-directory output is your assigned checkpoint.'} Do not install, spend, call paid APIs, publish, commit, deploy, send messages or touch live systems. No nested planner/runner. Preserve unrelated work. Report legitimate environment restrictions; the bounded supervisor can select only existing approved host recipes, never arbitrary shell.
${plan.hostValidation ? `HOST_VALIDATION_FILE: ${plan.hostValidation.relativeFile}\nHOST_VALIDATION_SHA256: ${plan.hostValidation.sha256}\nVerified host evidence: ${plan.hostValidation.summary}. Inspect real logs; do not claim host checks as sandbox execution.` : ''}
Compact partial inventory and previous checkpoints: ${compactCheckpoints(entry)}
Current source identity: ${sourceHash}. Inspect the compact inventory file; do not replay unknown effects. Context size and provider TPM quota are separate. Provider/model switching is not implemented.
Return ONLY the separate ${role} JSON. It cannot mark the parent package completed.
`;
}

async function execute(argv, lifecycle = {}) {
  const options = parseOptions(argv);
  const output = value => console.log(publicProjection(value));
  if (options.help) { output(HELP); return 0; }
  if ((process.env.CODEX_PLAN_WORKER === '1' || process.env.CODEX_RECOVERY_SUPERVISOR === '1') && !['status', 'dry-run'].includes(options.command)) {
    throw new Error('Worker recursion denied: bounded workers and recovery supervisors may inspect status/dry-run only; runner execution, host recipes and runtime reconciliation belong to the parent operator.');
  }
  if (['logs','stop'].includes(options.command)) {
    const root = fs.realpathSync(options.repo), manifest = readJson(inside(root, options.manifest));
    if (!/^[a-z0-9-]+$/.test(manifest.plan_id)) throw new Error('Invalid plan identity.');
    const stateDir = secureStatePath(root, path.join(root, '.codex-plan-runner', manifest.plan_id));
    const file = sessionFor(root, stateDir, options.session, latestBackground);
    if (!file) throw new Error('No recorded background session.');
    if (options.command === 'logs') { output(backgroundLogs(file)); return 0; }
    const stopped = await stopBackground(file, {timeoutMs:15000});
    output(options.json ? JSON.stringify(publicProjection(stopped)) : `Background ${stopped.id}: ${stopped.phase}; cleanup verified; result ${stopped.result_file || file}`);
    return 0;
  }
  const plan = loadPlan(options);
  let selected = selection(plan, options);
  if (options.command === 'status' && !options.step && !options.from && !options.to) {
    const sessionFile = sessionFor(plan.root,plan.stateDir,options.session,latestBackground);
    if (sessionFile) { const ids=inspectBackground(sessionFile).identity.selected; selected=plan.manifest.steps.filter(step=>ids.includes(step.id)); }
  }
  const acceptancePolicyFile = path.join(runtimeDirectory, 'site-acceptance-policy.v1.json');
  const runtimeAcceptancePolicy = plan.manifest.plan_id === 'site-access-management-2026-11-12' && fs.existsSync(acceptancePolicyFile) ? readJson(acceptancePolicyFile) : undefined;
  if (runtimeAcceptancePolicy) verifyAcceptancePolicySources(plan.root, runtimeAcceptancePolicy);
  plan.acceptanceProfile = resolveAcceptanceProfile(plan.manifest, { runtimePolicy: runtimeAcceptancePolicy });
  plan.recoveryPolicy = loadRecoveryPolicy(plan.root, plan.manifest);
  const runtime = snapshotRuntime();
  // Validation is read-only here. Persist the additive migration only under the lock.
  const diagnostics = [];
  const inspect = action => { try { action(); } catch (error) { if (['status', 'dry-run'].includes(options.command)) diagnostics.push(error.message); else throw error; } };
  if (!options.command.startsWith('runtime-')) inspect(() => migrateRecoveryState(structuredClone(plan.state), { policyHash: plan.recoveryPolicy.hash, runtimeHash: runtime.hash }));
  inspect(() => verifyRuntimeUpgradeHistory(plan));
  const attachHost = (step, file, expectedHash, checkSource = true) => {
    file = inside(plan.root, path.isAbsolute(file) ? path.relative(plan.root, file) : file);
    if (expectedHash && sha(file) !== expectedHash) throw new Error('Host validation evidence changed before retry.');
    const verified = verifyHostValidation({ root: plan.root, packageId: step.id, planHash: plan.planHash, file, mutablePaths: mutableHostPaths(step), checkSource });
    plan.hostValidation = { ...verified, file, relativeFile: path.relative(plan.root, file), sha256: sha(file) };
  };
  if (options.hostValidation) {
    attachHost(selected[0], options.hostValidation);
    if (!options.json) output(`Verified host evidence for package ${options.step}: ${plan.hostValidation.summary}`);
  }
  for (const step of plan.manifest.steps) inspect(() => verifyCompleted(plan, step));
  if (['status', 'dry-run'].includes(options.command)) {
    const session = sessionFor(plan.root, plan.stateDir, options.session, latestBackground);
    const sessionSnapshot = session ? inspectBackground(session) : null;
    const statusOptions = sessionSnapshot?.identity?.options || options;
    const summary = describeRun(plan, selected, statusOptions, diagnostics);
    if (session) { try { summary.background = inspectBackground(session); } catch (error) { summary.background = {phase:'unresolved',diagnostic:redact(error.message)}; } }
    const attentionPath = path.join(plan.stateDir,'needs-attention.json');
    if (fs.existsSync(attentionPath)) {
      const previous = readJson(attentionPath);
      const current = currentAttentionReport(plan.state,previous) || !previous.package_id && (diagnostics.length>0 || !(Date.parse(plan.state.updated_at)>fs.statSync(attentionPath).mtimeMs));
      summary.attention_report = {file:attentionPath,classification:current?'current':'historical',reason:previous.reason,next_action:previous.next_action};
    }
    if (options.json) { output(JSON.stringify(publicProjection(summary))); return diagnostics.length ? 2 : 0; }
    if (summary.background) output(`Background: ${summary.background.id || 'unknown'}; phase=${summary.background.phase}; session=${session}`);
    output(`Criteria accepted: ${summary.criteria.accepted}/${summary.criteria.required}; unfinished packages: ${summary.unfinished.join(', ') || 'none'}`);
    output(`Plan: ${plan.manifest.plan_id}\nReady: ${plan.manifest.ready === true}\nRepository: ${plan.root}\nState: ${plan.stateFile}`);
    for (const step of selected) {
      const entry = plan.state.steps[step.id], r = entry?.recovery;
      const manual = step.manual;
      const missing = step.dependencies.filter(id => plan.state.steps[id]?.status !== 'completed');
      const label = manual ? 'manual approval boundary' : entry?.status || 'pending';
      output(`${step.id}  ${label}  ${step.title}${entry?.retry_at ? ` (retry ${entry.retry_at})` : ''}${missing.length ? ` [needs ${missing.join(', ')}]` : ''}`);
      if (r?.subdivision) output(`    subdivision=${r.subdivision.count}/1; phase=${r.phase}; subtasks=${r.subdivision.next_task}/${r.subdivision.tasks.length}; rotations=${r.subdivision.rotation_count}/${statusOptions.maxSessionRotations}; explicit-tpm-attempts=${r.tpm_failure_count || 0}; return-actor=${r.return_actor || 'worker'}`);
      const budgets = summary.packages.find(item => item.id === step.id).budgets;
      output(`    budgets: ${Object.entries(budgets).map(([kind, budget]) => `${kind}=${budget.used}/${kind === 'rate' && budget.limit === 0 ? 'unlimited' : budget.limit}`).join('; ')}`);
      if (r) output(`    phase=${r.phase}; attempts=${entry.attempts}; no-progress=${r.no_progress_count}/${statusOptions.maxNoProgress}; next=${r.next_action}`);
      if (entry?.acceptance?.mode === 'strict') output(`    acceptance=strict; refresh-generations=${entry.acceptance.refresh_count || 0}/${statusOptions.maxEvidenceRefreshes}; timeout-retries=${entry.acceptance.timeout_retry_count || 0}/${statusOptions.maxEvidenceRefreshes}; protocol-retries=${r?.protocol_retry_count || 0}/${statusOptions.maxProtocolRetries}; gates=${Object.entries(entry.acceptance.gates || {}).map(([id, gate]) => `${id}:${gate.passed ? 'passed' : 'pending-or-failed'}`).join(',')}`);
      if (r?.terminal_blocker || r?.budget_reason) output(`    needs attention: ${r.terminal_blocker || r.budget_reason}`);
      const failure = summary.packages.find(item => item.id === step.id).acceptance_failure;
      if (failure) {
        output(`    underlying failure: ${failure.summary}`);
        for (const suite of failure.failed_suites) output(`    failed suite: ${suite.file}; failed cases=${suite.failed_cases}; errors=${[...suite.error_codes, ...suite.error_types].join(', ') || 'inspect bound report'}`);
        output(`    failure IDs: ${failure.failure_ids.join('; ')}`);
        for (const evidence of failure.evidence) output(`    evidence: ${evidence.file}${evidence.report ? '; report=' + evidence.report.file : ''}`);
      }
    }
    const attentionFile = path.join(plan.stateDir, 'needs-attention.json');
    if (fs.existsSync(attentionFile)) { const saved = readJson(attentionFile); output(currentAttentionReport(plan.state, saved) ? `Current needs-attention report: ${saved.reason}; next=${saved.next_action}` : !saved.package_id && (diagnostics.length || !(Date.parse(plan.state.updated_at)>fs.statSync(attentionFile).mtimeMs)) ? `Unscoped needs-attention report; inspect guard diagnostics: ${saved.reason}` : `Historical needs-attention report (not current package status): ${saved.reason}`); }
    output(`Acceptance mode: ${plan.acceptanceProfile.mode}; historical completed packages retain their original receipts.`);
    for (const diagnostic of diagnostics) output(`Needs attention: ${diagnostic}`);
    if (plan.state.recovery && (plan.state.recovery.runtime_hash !== runtime.hash || plan.state.recovery.policy_hash !== plan.recoveryPolicy.hash)) {
      output(`Saved runtime: ${plan.state.recovery.runtime_hash}\nCurrent runtime: ${runtime.hash}\nSaved policy: ${plan.state.recovery.policy_hash}\nCurrent policy: ${plan.recoveryPolicy.hash}`);
      output('Inspect the authorized upgrade and saved work, then use runtime-prepare --runtime-review-note PATH and runtime-apply with the reviewed proposal SHA. Normal start remains blocked.');
    }
    output(options.command === 'dry-run' ? 'Preview only: no Codex worker or state changes.' : 'Read-only status. Use start to run or resume.');
    return 0;
  }
  if (plan.manifest.ready !== true && !options.command.startsWith('runtime-')) throw new Error('Plan is not ready: finish and review the prepared plan, shared contract and acceptance checks before setting manifest.ready to true.');
  const backgroundAdmission = () => inspectBackgroundOwnership({ root: plan.root, stateDir: plan.stateDir, planId: plan.manifest.plan_id, ownSession: lifecycle.ownSession });
  backgroundAdmission();
  const preflight = async () => {
    const requirements = Object.fromEntries(plan.manifest.steps.map(step => [step.id, acceptanceForPackage(plan.acceptanceProfile, step.id)]));
    const result = await preflightRange({manifest:plan.manifest,state:plan.state,options,requirements,
      isManual: step => step.manual,
      verifyCompleted: step => verifyCompleted(plan, step),
      capabilityProbe: request => { const probe=preflightAcceptanceCapabilities({root:plan.root,...request}); if (probe?.passed===false || probe?.ready===false || probe?.blockers?.length) throw new Error(`Fixed capability preflight failed: ${(probe.blockers || []).join('; ')}`); return {...probe,ready:true}; },
      authProbe: () => probeLocalAuthentication({codexBin:options.codexBin,profile:options.profile,root:plan.root})});
    const version=process.versions.node.split('.').map(Number);
    if (!['darwin','linux'].includes(process.platform) || version[0]<22 || version[0]===22 && version[1]<13) { result.errors.push({kind:'runtime',message:'Requires macOS/Linux and Node.js 22.13 or later.'}); result.ready=false; }
    if (plan.fingerprint() !== plan.planHash || snapshotRuntime().hash !== runtime.hash) throw new Error('Plan/runtime changed during preflight.');
    if (plan.state.recovery?.dependency_hash && snapshotDependencies(plan.root).sha256 !== plan.state.recovery.dependency_hash) throw new Error('Installed dependency identity changed since migration.');
    if (plan.state.recovery?.recipe_config_hash && recipeConfiguration(plan.root) !== plan.state.recovery.recipe_config_hash) throw new Error('Reviewed npm recipe script configuration changed since migration.');
    return result;
  };
  let readiness;
  if (['start','resume','launch','preflight'].includes(options.command)) {
    readiness = await preflight();
    if (options.command === 'preflight' || !readiness.ready) {
      const report = writeCommandReport(plan, 'preflight', {...readiness,next_action:readiness.errors.length ? 'Resolve the listed prerequisites, then repeat the same range.' : readiness.stops_at ? `Resolve the manual boundary at ${readiness.stops_at} separately.` : 'Launch the reviewed selected range.'});
      output(options.json ? JSON.stringify(publicProjection(report)) : `Preflight ${report.ready ? 'ready' : 'blocked'}: plan=${plan.manifest.plan_id}; range=${report.selected.join(',')}; capabilities=${report.capabilities.map(x=>x.capability).join(',') || 'legacy receipts'}; result=${report.report_file}\n${report.errors.map(x=>x.message).join('\n')}\nNext: ${report.next_action}`);
      return report.ready ? 0 : 2;
    }
    if (options.command === 'launch') {
      const identity = startupIdentity(plan, runtime, options, readiness.selected, readiness);
      const executionArgs = argv.filter(x => x !== '--json');
      if (executionArgs[0] === 'launch') executionArgs[0] = 'resume';
      const launched = await launchBackground({root:plan.root,stateDir:plan.stateDir,moduleFile:path.join(runtimeDirectory,'background-runner.mjs'),args:{argv:executionArgs},identity,readinessMs:120000});
      output(options.json ? JSON.stringify(publicProjection(launched)) : `Background ${launched.id}: ${launched.phase}; plan=${plan.manifest.plan_id}; range=${readiness.selected.join(',')}; capabilities=${readiness.capabilities.map(x=>x.capability).join(',') || 'legacy receipts'}; next=${launched.launched ? 'monitor status/results' : 'inspect startup diagnostic'}; session=${launched.session_file}; result=${launched.result_file || 'in session directory'}`);
      return launched.launched ? 0 : 2;
    }
  }
  if (options.command==='host-check' && (selected[0].manual)) { output(`Incomplete: stopped before package ${selected[0].id}, a manual approval boundary.`); return 2; }
  secureStatePath(plan.root, path.join(plan.stateDir, 'logs'));
  fs.mkdirSync(path.join(plan.stateDir, 'logs'), { recursive: true, mode: 0o700 });
  fs.chmodSync(plan.stateDir, 0o700);
  const lock = acquireLock(plan, lifecycle.ownSession);
  lifecycle.acquired?.();
  const historicalCompleted = Object.entries(plan.state.steps).filter(([,entry])=>entry.status==='completed').map(([id])=>id);
  if (options.command.startsWith('runtime-')) {
    try {
      plan.state = loadPlan(options).state;
      const common = { plan, runtime, recipeConfiguration, verifyCompleted };
      if (options.command === 'runtime-prepare') {
        const prepared = prepareRuntimeUpgrade({ ...common, reviewNote: options.runtimeReviewNote });
        output(`Runtime upgrade proposal: ${path.relative(plan.root, prepared.file)}\nProposal SHA-256: ${prepared.sha256}\nReview the bound inputs before runtime-apply --proposal PATH --proposal-sha256 HASH. Package state is unchanged.`);
      } else {
        const applied = applyRuntimeUpgrade({ ...common, proposalFile: options.proposal, proposalSha256: options.proposalSha256,
          reload: () => loadPlan(options), writeState: atomicJson });
        output(`Runtime upgrade ${applied.alreadyApplied ? 'already recorded' : 'reconciled'}: ${path.relative(plan.root, applied.file)}\nAll package entries, budgets, sessions and accepted artifacts are preserved. Resume the explicitly selected package separately.`);
      }
      return 0;
    } finally { lock.release(); }
  }
  if (options.command === 'host-check') {
    try {
      const step = selected[0];
      const missing = step.dependencies.filter(id => plan.state.steps[id]?.status !== 'completed');
      if (missing.length) throw new Error(`Package ${step.id} requires completed packages: ${missing.join(', ')}.`);
      const guard = capturePhaseGuard(plan, { runtime, extraProtectedPaths: ['.env', '.env.local', '.npmrc', '.codex/config.toml'] });
      const dependencies = snapshotDependencies(plan.root).sha256;
      const configuration = recipeConfiguration(plan.root);
      const stateHash = fs.existsSync(plan.stateFile) ? sha(plan.stateFile) : null;
      if (!plan.recoveryPolicy.value.packages[step.id]?.recipes.includes('npm-checks')) throw new Error('The frozen manifest does not authorize npm-checks for this package.');
      output(`Running the declared npm-checks recipe for package ${step.id}. No Codex worker is launched and runner progress is unchanged.`);
      const host = captureHostValidation({ root: plan.root, packageId: step.id, planHash: plan.planHash, mutablePaths: mutableHostPaths(step), outputDir: path.join(plan.stateDir, 'host-checks', `${step.id}-${randomUUID()}`), recipeId: 'npm-checks' });
      assertPhaseGuard(plan, guard);
      if (snapshotDependencies(plan.root).sha256 !== dependencies || recipeConfiguration(plan.root) !== configuration) throw new Error('Dependency or recipe configuration changed during explicit host validation.');
      if ((fs.existsSync(plan.stateFile) ? sha(plan.stateFile) : null) !== stateHash) throw new Error('Runner state changed during host phase.');
      output(host.summary);
      output(`Host evidence: ${path.relative(plan.root, host.file)}`);
      verifyHostValidation({ root: plan.root, packageId: step.id, planHash: plan.planHash, file: host.file, mutablePaths: mutableHostPaths(step) });
      return 0;
    } finally { lock.release(); }
  }
  const controller = new AbortController();
  let interruptedCode = 130, expectedStateHash;
  const log = message => {
    const line = `[${new Date().toISOString()}] ${redact(message)}`;
    output(line);
    fs.appendFileSync(path.join(plan.stateDir, 'runner.log'), line + '\n', { mode: 0o600 });
  };
  const stopInt = () => { interruptedCode = 130; controller.abort(); };
  const stopTerm = () => { interruptedCode = 143; controller.abort(); };
  process.on('SIGINT', stopInt); process.on('SIGTERM', stopTerm);
  lifecycle.signal?.addEventListener('abort', stopTerm, {once:true});
  if (lifecycle.signal?.aborted) stopTerm();
  const assertState = () => {
    if ((fs.existsSync(plan.stateFile) ? sha(plan.stateFile) : null) !== expectedStateHash) throw new Error('Runner state revision/content changed outside the parent; refusing to overwrite it.');
  };
  const save = () => {
    assertState();
    plan.state.recovery.revision++;
    plan.state.updated_at = new Date().toISOString();
    expectedStateHash = atomicJson(plan.stateFile, plan.state, assertState);
  };
  const beforePhase = (extraProtectedPaths = []) => {
    assertState();
    verifyRuntimeUpgradeHistory(plan);
    for (const entry of Object.values(plan.state.steps)) {
      verifyAcceptanceArtifacts(plan.root, entry);
      if (entry.recovery) { verifyProtocolRejections(plan.root, entry.recovery); verifyAcceptanceRequests(plan.root, entry.recovery); }
      verifySubdivisionArtifacts(plan.root, entry.recovery);
      for (const decision of entry.recovery?.decisions || []) {
        if (sha(inside(plan.root, decision.file)) !== decision.sha256) throw new Error('Recorded supervisor decision changed; inspect recovery history.');
      }
    }
    for (const step of plan.manifest.steps) verifyCompleted(plan, step);
    if (snapshotDependencies(plan.root).sha256 !== plan.state.recovery.dependency_hash) throw new Error('Installed dependency identity changed; dependency installation is not authorized.');
    if (recipeConfiguration(plan.root) !== plan.state.recovery.recipe_config_hash) throw new Error('Reviewed npm recipe script configuration changed; inspect before host execution.');
    const decisions = Object.values(plan.state.steps).flatMap(entry => [...(entry.recovery?.decisions || []).map(decision => decision.file), ...(entry.recovery?.acceptance_request ? [entry.recovery.acceptance_request.file] : []), ...(entry.recovery?.history || []).filter(item => item.action === 'acceptance-request').map(item => item.request.file)]);
    const guard = capturePhaseGuard(plan, { runtime, extraProtectedPaths: ['.env', '.env.local', '.npmrc', '.codex/config.toml', ...decisions, ...Object.values(plan.state.steps).flatMap(entry => acceptanceArtifacts(entry).map(item => item.file)), ...Object.values(plan.state.steps).flatMap(entry => (entry.recovery?.history || []).filter(item => item.action === 'protocol-rejected').map(item => item.file)), ...Object.values(plan.state.steps).flatMap(entry => subdivisionArtifacts(entry.recovery).map(item => item.file)), ...extraProtectedPaths] });
    guard.head = git(plan.root, 'rev-parse', 'HEAD');
    return guard;
  };
  const afterPhase = guard => { assertState(); assertPhaseGuard(plan, guard); verifyRuntimeUpgradeHistory(plan); if (snapshotDependencies(plan.root).sha256 !== plan.state.recovery.dependency_hash) throw new Error('Installed dependency identity changed during phase; dependency installation is not authorized.'); if (recipeConfiguration(plan.root) !== plan.state.recovery.recipe_config_hash) throw new Error('Reviewed npm recipe script configuration changed during phase.'); if (git(plan.root, 'rev-parse', 'HEAD') !== guard.head) throw new Error('Git HEAD changed during phase; commits are not authorized.'); for (const step of plan.manifest.steps) verifyCompleted(plan, step); };
  const attention = (step, entry, reason, code = 2, budget = false, budgetKind = null) => {
    if (code !== 75) entry.status = code === 1 ? 'failed' : 'blocked';
    else if (entry.status === 'running') entry.status = 'failed';
    if (entry.recovery.phase !== 'needs-attention') entry.recovery.resume_phase = entry.recovery.phase === 'waiting' ? entry.recovery.waiting_actor || 'worker' : entry.recovery.phase;
    entry.recovery.phase = 'needs-attention';
    entry.recovery.next_action = budget ? 'inspect-budget-or-explicitly-increase-limit' : 'resolve-blocker-then-start --step ' + step.id + ' --fresh-session';
    if (budget) { entry.recovery.budget_reason = reason; entry.recovery.budget_kind = budgetKind; }
    else {
      entry.recovery.terminal_blocker = reason;
      entry.recovery.history.push({ blocked_source: snapshotSource(plan.root, mutableHostPaths(step)).sha256 });
    }
    save();
    atomicJson(path.join(plan.stateDir, 'needs-attention.json'), publicProjection({ schema_version: 1, package_id: step.id, phase: entry.recovery.phase, reason, acceptance_failure: acceptanceFailureDetails(plan, step, entry), next_action: entry.recovery.next_action, recovery: entry.recovery, attempt: entry.attempts }));
    log(`Package ${step.id} needs attention: ${reason}. Next: ${entry.recovery.next_action}`);
    return code;
  };
  const canRecover = step => options.recovery && plan.recoveryPolicy.value.packages[step.id]?.local_repair === true;
  // Provider cooldown is package-owned, not tied to a replaceable review
  // binding. Lift historical actor-only waits before any resumed model call.
  const preserveReviewerCooldown = entry => {
    const retryAt = entry.acceptance?.review_actor?.retry_at;
    if (!retryAt) return;
    const deadline = Date.parse(retryAt), existing = entry.retry_at ? Date.parse(entry.retry_at) : 0;
    if (!Number.isFinite(deadline) || !Number.isFinite(existing)) throw new Error('Invalid saved acceptance reviewer retry deadline.');
    if (deadline > existing) { entry.retry_at = retryAt; save(); }
  };
  const fail = (step, entry, result, kind, reason) => {
    entry.status = kind === 'waiting-for-rate-limit' ? kind : kind === 'blocked' ? 'blocked' : kind === 'interrupted' ? kind : 'failed';
    entry.recovery.failure_kind = kind;
    entry.recovery.next_action = 'inspect-failure';
    const report = saveFailureReport({ taskId: step.id, attempt: entry.attempts, result, reason, kind, logFile: result.jsonlFile });
    entry.diagnostic = report.summary; save();
    log(`Package ${step.id}: ${kind}. ${reason}\nFailure report: ${report.markdownPath}`);
  };
  const retryProvider = (entry, failure, actor, attempt) => {
    const r = entry.recovery;
    // Persist consumption with the retry charge, so a saved wire outcome is
    // reconciled once even when interruption happens before the next actor.
    if (attempt) attempt.retry_accounted = true;
    if (failure.kind === 'rate-limit') {
      entry.rate_limit_count = (entry.rate_limit_count || 0) + 1;
      const delay = retryDelayMs({ attempt: entry.rate_limit_count, baseMs: options.retryDelaySeconds * 1000, maxMs: options.maxDelaySeconds * 1000, retryAfterMs: failure.retryAfterMs });
      entry.retry_at = new Date(Date.now() + delay).toISOString();
      r.next_action = `retry-${actor}`; r.waiting_actor = actor; r.phase = 'waiting'; save();
      return !options.maxRateRetries || entry.rate_limit_count <= options.maxRateRetries;
    }
    r.transport_count++;
    r.next_action = `retry-${actor}`; r.waiting_actor = actor; r.phase = 'waiting';
    entry.retry_at = new Date(Date.now() + transportRetryDelayMs({ attempt: r.transport_count, baseMs: options.retryDelaySeconds * 1000, maxMs: options.maxDelaySeconds * 1000, retryAfterMs: failure.retryAfterMs })).toISOString();
    save(); return r.transport_count <= options.maxTransportRetries;
  };
  const recoverPressure = (step, entry, failure, role, attemptId) => {
    const r = entry.recovery, pressure = classifyTokenPressure(failure);
    if (!canRecover(step) || !pressure.explicit) { r.tpm_streak = 0; return role; }
    if (r.last_tpm_attempt !== attemptId) {
      r.last_tpm_attempt = attemptId;
      r.tpm_failure_count = (r.tpm_failure_count || 0) + 1;
      r.tpm_streak = r.tpm_streak_actor === role ? (r.tpm_streak || 0) + 1 : 1;
      r.tpm_streak_actor = role;
    }
    if (!pressure.oversized && r.tpm_streak < options.tpmThreshold) return role;
    if (!r.subdivision && role === 'worker') {
      const id = randomUUID();
      const directory = path.join(plan.stateDir, 'subdivisions', `${step.id}-${id}`);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const inventory = snapshotSource(plan.root, mutableHostPaths(step));
      const dirtyPaths = new Set([git(plan.root, 'diff', '--name-only', 'HEAD', '-z'), git(plan.root, 'ls-files', '--others', '--exclude-standard', '-z')].flatMap(value => value.split('\0').filter(Boolean)));
      const partialFiles = inventory.files.filter(file => dirtyPaths.has(file.path));
      const file = path.join(directory, 'inventory.json');
      atomicJson(file, { schema_version: 1, package_id: step.id, subdivision_id: id, source_sha256: inventory.sha256,
        total_files: inventory.files.length, total_dirty_files: partialFiles.length, files: partialFiles.slice(0, 60), diagnostic: (entry.diagnostic || '').slice(-4000),
        previous_thread: entry.thread_id || null, last_attempt: entry.last_attempt ? path.relative(plan.root, entry.last_attempt.log_file) : null,
        instruction: 'Inspect current partial changes and unknown effects before any repeat. Inventory is a compact historical snapshot, not current acceptance. Uncommitted files may be pre-existing user work; inspect ownership and preserve them. More than 60 dirty files are truncated; inspect current Git status when needed.' });
      r.subdivision = { schema_version: 1, id, count: 1, rotation_count: 0, rotations: [], planner: { attempts: 0 }, tasks: [], next_task: 0, finalizer: { attempts: 0 },
        artifacts: [], inventory_file: path.relative(plan.root, file), inventory_sha256: sha(file), source_sha256: inventory.sha256 };
      r.tpm_streak = 0; r.return_actor = 'planner'; r.waiting_actor = 'planner';
      log(`Package ${step.id}: explicit TPM pressure; bounded subdivision 1/1 will start a fresh planner after cooldown.`);
      return 'planner';
    }
    if (r.subdivision) { r.rotate_pending = role; }
    return role;
  };
  const runAcceptanceReview = async (step, entry, request) => {
    const r = entry.recovery, a = entry.acceptance;
    preserveReviewerCooldown(entry);
    let actor = a.review_actor;
    if (!actor || actor.binding_sha256 !== request.bindingHash) actor = a.review_actor = { attempts: 0, binding_sha256: request.bindingHash };
    save();
    while (true) {
      if (controller.signal.aborted) throw Object.assign(new Error('Acceptance review interrupted'), { code: 'ACCEPTANCE_EXTERNAL' });
      if (actor.retry_at || entry.retry_at) {
        const deadline = Math.max(...[actor.retry_at, entry.retry_at].filter(Boolean).map(Date.parse));
        if (!Number.isFinite(deadline)) throw new Error('Invalid saved acceptance reviewer retry deadline.');
        await waitUntil(deadline, controller.signal);
        // An interrupted wait must retain the provider's minimum retry time.
        if (controller.signal.aborted) throw Object.assign(new Error('Acceptance review interrupted'), { code: 'ACCEPTANCE_EXTERNAL' });
        delete actor.retry_at; delete entry.retry_at; save();
      }
      const guard = beforePhase([step.validation, step.handoff, request.packetFile]);
      const inputSource = snapshotSource(plan.root, mutableHostPaths(step)).sha256;
      let result, attemptId;
      if (!actor.last_attempt?.retry_accounted && !actor.last_attempt?.interrupted && actor.last_attempt?.exit_code === 0 && actor.last_attempt.turn_completed && !actor.last_attempt.turn_failed && savedOutcomeCurrent(plan, step, actor.last_attempt)) {
        attemptId = actor.last_attempt.attempt_id;
        result = restoreSavedProviderResult(actor.last_attempt);
      } else {
        actor.attempts++; attemptId = randomUUID(); save();
        result = await runAttempt({ plan, options, step, entry: actor, attemptId, lock, signal: controller.signal, save, log, role: 'acceptance-reviewer', prompt: acceptanceReviewPrompt({ plan, step, ...request, attemptId }) });
      }
      afterPhase(guard);
      if (snapshotSource(plan.root, mutableHostPaths(step)).sha256 !== inputSource) throw new Error('Read-only acceptance review source changed');
      if (controller.signal.aborted) throw Object.assign(new Error('Acceptance review interrupted'), { code: 'ACCEPTANCE_EXTERNAL' });
      const permanent = permanentProviderFailure(result);
      if (permanent) throw Object.assign(new Error(`Acceptance reviewer ${permanent.kind}: ${permanent.message}`), { code: 'ACCEPTANCE_EXTERNAL' });
      if (result.code !== 0 || !result.turnCompleted || result.turnFailed || result.timedOut) {
        const failure = result.timedOut ? { kind: 'transport', message: 'Acceptance reviewer timeout' } : classifyFailure(result);
        if (['rate-limit', 'transport'].includes(failure.kind) && options.recovery) {
          const used = failure.kind === 'rate-limit' ? entry.rate_limit_count = (entry.rate_limit_count || 0) + 1 : ++r.transport_count;
          const limit = failure.kind === 'rate-limit' ? options.maxRateRetries : options.maxTransportRetries;
          actor.last_attempt.retry_accounted = true;
          // Save the final failure's cooldown even when its finite budget is
          // exhausted. Explicit budget increases must still honor Retry-After.
          const delay = failure.kind === 'transport' ? transportRetryDelayMs : retryDelayMs;
          actor.retry_at = new Date(Date.now() + delay({ attempt: used, baseMs: options.retryDelaySeconds * 1000, maxMs: options.maxDelaySeconds * 1000, retryAfterMs: failure.retryAfterMs })).toISOString(); preserveReviewerCooldown(entry); save();
          if (!(failure.kind === 'rate-limit' && limit === 0) && used > limit) throw Object.assign(new Error(`Acceptance reviewer ${failure.kind} retry budget exhausted`), { code: 'ACCEPTANCE_PROVIDER_BUDGET' });
          continue;
        }
        throw Object.assign(new Error(`Acceptance reviewer ${failure.kind}: ${failure.message}`), { code: 'ACCEPTANCE_EXTERNAL' });
      }
      try {
        const value = validateAcceptanceReview(readJson(result.resultFile), { packageId: step.id, attemptId, stage: request.stage, bindingHash: request.bindingHash, criteria: request.criteria });
        clearProtocolFeedback(r, 'acceptance-reviewer'); delete a.review_actor; save();
        return { value, file: result.resultFile, attemptId };
      } catch (error) {
        const retry = recordProtocolRejection(r, { actor: 'acceptance-reviewer', attemptId, ...protocolRejectionArtifact(plan, result.resultFile), error, maxRetries: options.maxProtocolRetries });
        delete actor.last_attempt; save();
        if (retry && options.recovery) continue;
        throw Object.assign(new Error(`Acceptance review protocol budget exhausted: ${error.message}`), { code: 'ACCEPTANCE_PROTOCOL' });
      }
    }
  };
  const performAcceptance = (step, entry) => ensureAcceptance({ plan, step, entry, profile: plan.acceptanceProfile,
    mutablePaths: mutableHostPaths(step), save, signal: controller.signal,
    timeoutMs: options.hostTimeoutMinutes * 60000, maxRefreshes: options.maxEvidenceRefreshes,
    guarded: async action => { const guard = beforePhase(); try { return await action(); } finally { afterPhase(guard); } },
    review: request => runAcceptanceReview(step, entry, request) });
  const acceptanceError = (step, entry, error) => {
    if (controller.signal.aborted) { entry.status = 'interrupted'; save(); return interruptedCode; }
    if (error.code === 'ACCEPTANCE_TIMEOUT_BUDGET') return attention(step, entry, error.message, 75, true, 'acceptance-timeout');
    if (error.code === 'ACCEPTANCE_REFRESH_BUDGET') return attention(step, entry, error.message, 75, true, 'acceptance-evidence');
    if (error.code === 'ACCEPTANCE_PROVIDER_BUDGET') return attention(step, entry, error.message, 75, true);
    if (error.code === 'ACCEPTANCE_EXTERNAL') return attention(step, entry, error.message);
    if (error.code === 'ACCEPTANCE_PROTOCOL') return attention(step, entry, error.message, 75, true, 'protocol');
    if (error.code !== 'ACCEPTANCE_REPAIR' && !/^Invalid completion:/.test(error.message) && /tamper|modified|changed|symlink|identity/i.test(error.message)) throw error;
    if (error.failureIds && entry.acceptance) entry.acceptance.failure_ids = error.failureIds;
    return null;
  };
  const requestAcceptance = (step, entry, { role, origin, attemptId, resultFile }) => {
    const r = entry.recovery, requirements = acceptanceForPackage(plan.acceptanceProfile, step.id);
    if (!requirements || step.manual || !['worker', 'finalizer'].includes(role)) throw new Error('Unauthorized parent acceptance request');
    const actor = subdivisionActor(entry, role);
    if (!actor) throw new Error('Parent acceptance request lost its original actor');
    const request = { schema_version: 1, package_id: step.id, attempt_id: attemptId, actor: role,
      thread_id: actor.thread_id || null, origin, file: path.relative(plan.root, resultFile), sha256: sha(resultFile),
      profile_sha256: createHash('sha256').update(JSON.stringify(requirements)).digest('hex') };
    r.acceptance_request = request;
    r.history.push({ action: 'acceptance-request', request: { ...request } });
    entry.status = 'incomplete'; r.return_actor = role; r.phase = 'acceptance'; r.next_action = 'run-parent-acceptance'; save();
  };
  try {
    plan.state = loadPlan(options).state;
    backgroundAdmission();
    const lockedReadiness = await preflight();
    if (lifecycle.identity) assertStartupIdentity(plan, runtime, options, lifecycle.identity, lockedReadiness);
    if (!lockedReadiness.ready) throw new Error(`Locked preflight failed: ${lockedReadiness.errors.map(x=>x.message).join('; ') || 'manual boundary'}`);
    expectedStateHash = fs.existsSync(plan.stateFile) ? sha(plan.stateFile) : null;
    migrateRecoveryState(plan.state, { policyHash: plan.recoveryPolicy.hash, runtimeHash: runtime.hash });
    const dependencies = snapshotDependencies(plan.root).sha256;
    if (plan.state.recovery.dependency_hash !== undefined && plan.state.recovery.dependency_hash !== dependencies) throw new Error('Installed dependency identity changed since migration; inspect unauthorized dependency changes.');
    plan.state.recovery.dependency_hash ??= dependencies;
    const recipeConfig = recipeConfiguration(plan.root);
    if (plan.state.recovery.recipe_config_hash !== undefined && plan.state.recovery.recipe_config_hash !== recipeConfig) throw new Error('Reviewed npm recipe script configuration changed since migration.');
    plan.state.recovery.recipe_config_hash ??= recipeConfig;
    if (!plan.state.initial_source) plan.state.initial_source = source(plan.root);
    atomicJson(path.join(plan.stateDir, 'result-schema.json'), resultSchema);
    atomicJson(path.join(plan.stateDir, 'recovery-result-schema.json'), recoveryResultSchema);
    atomicJson(path.join(plan.stateDir, 'planner-result-schema.json'), plannerResultSchema);
    atomicJson(path.join(plan.stateDir, 'subtask-result-schema.json'), subtaskResultSchema);
    atomicJson(path.join(plan.stateDir, 'acceptance-review-schema.json'), acceptanceReviewSchema);
    for (const step of plan.manifest.steps) verifyCompleted(plan, step);
    save();
    if (lifecycle.ready) await lifecycle.ready({file:lock.file,token:lock.token});
    backgroundAdmission();
    for (const step of selected) {
      if (controller.signal.aborted) return interruptedCode;
      if (step.manual) { log(`Incomplete: stopped before package ${step.id}, a manual approval boundary. Resolve its recorded approval and execution requirements separately.`); return 2; }
      let entry = plan.state.steps[step.id];
      if (entry?.status === 'completed') { log(`Skipping completed package ${step.id}.`); continue; }
      const missing = step.dependencies.filter(id => plan.state.steps[id]?.status !== 'completed');
      if (missing.length) throw new Error(`Package ${step.id} requires completed packages: ${missing.join(', ')}. Start from the first unfinished package.`);
      entry ??= plan.state.steps[step.id] = { status: 'pending', attempts: 0, rate_limit_count: 0 };
      const r = entry.recovery ??= newPackageRecovery();
      const acceptanceRequirements = acceptanceForPackage(plan.acceptanceProfile, step.id);
      preserveReviewerCooldown(entry);
      if (acceptanceRequirements) {
        try {
          const preflight = preflightAcceptanceCapabilities({ root: plan.root, packageId: step.id, gates: acceptanceRequirements.required_gates });
          if (preflight?.passed === false || preflight?.blockers?.length) return attention(step, entry, `Acceptance prerequisites: ${(preflight.blockers || []).join('; ')}`);
        } catch (error) { return attention(step, entry, `Acceptance prerequisites: ${error.message}`); }
      }
      if (!options.hostValidation) delete plan.hostValidation;
      else if (r.host_evidence_deferred) { r.host_evidence_deferred = false; save(); }
      if (options.freshSession) {
        const phase = r.phase === 'needs-attention' ? r.resume_phase || 'worker' : r.phase;
        const activeRole = phase === 'waiting' ? r.waiting_actor || 'worker'
          : phase === 'host' ? r.return_actor || 'worker' : phase === 'acceptance' ? r.acceptance_request?.actor : phase;
        const active = activeRole === 'supervisor' ? r.supervisor : subdivisionActor(entry, activeRole);
        r.history.push({ action: 'operator-fresh-session', role: activeRole, previous_thread: active?.thread_id || null,
          source_sha256: snapshotSource(plan.root, mutableHostPaths(step)).sha256,
          previous_attempt: active?.last_attempt || null });
        if (active) {
          delete active.thread_id;
          if (r.acceptance_request?.actor === activeRole) r.acceptance_request.thread_id = null;
          // Explicit operator replacement may retry an unaccepted/rejected result.
          // Preserve its immutable files and journal identity, never accepted tasks.
          if (active !== entry) delete active.last_attempt;
        }
        entry.diagnostic = `Operator requested a fresh session. Inspect existing partial work and checkpoints.\n${entry.diagnostic || ''}`.slice(0, 6000);
        // Explicit session replacement never resets repair or transport budgets.
        save();
      }
      if (canRecover(step) && ['blocked', 'failed'].includes(entry.status) && r.phase === 'worker') { r.phase = 'supervisor'; r.next_action = 'run-supervisor'; }
      while (true) {
        // Budgets are checked before every side effect, including across restarts.
        if (r.subdivision && !canRecover(step)) return attention(step, entry, 'Subdivision recovery is disabled; inspect preserved checkpoints and enable the existing reviewed recovery policy');
        if (options.maxRateRetries && (entry.rate_limit_count || 0) > options.maxRateRetries) return attention(step, entry, 'Rate retry budget exhausted; retain cooldown and increase --max-rate-retries explicitly to continue', 75, true);
        if (r.budget_kind === 'acceptance-timeout' && entry.acceptance.timeout_retry_count >= options.maxEvidenceRefreshes) return attention(step, entry, 'Acceptance timeout retry budget exhausted; increase --max-evidence-refreshes explicitly', 75, true, 'acceptance-timeout');
        if (r.budget_kind === 'acceptance-evidence' && entry.acceptance.refresh_count >= options.maxEvidenceRefreshes) return attention(step, entry, 'Acceptance evidence refresh budget exhausted; increase --max-evidence-refreshes explicitly', 75, true, 'acceptance-evidence');
        if (r.budget_kind === 'protocol' && r.protocol_retry_count >= options.maxProtocolRetries) return attention(step, entry, 'Protocol correction budget exhausted', 75, true, 'protocol');
        if ((canRecover(step) || acceptanceRequirements) && r.transport_count > options.maxTransportRetries) return attention(step, entry, 'Transport retry budget exhausted', 75, true);
        if ((canRecover(step) || acceptanceRequirements) && r.no_progress_count >= options.maxNoProgress) return attention(step, entry, 'Repeated unchanged failure reached no-progress limit', 75, true);
        if (canRecover(step) && r.budget_kind === 'evidence' && r.evidence_refresh_count >= options.maxEvidenceRefreshes) return attention(step, entry, r.budget_reason || 'Host evidence retry budget exhausted', 75, true, 'evidence');
        if (r.phase === 'needs-attention' && (canRecover(step) || acceptanceRequirements)) {
          if (r.budget_kind === 'protocol' && r.protocol_feedback) { const feedback = r.protocol_feedback; recordProtocolRejection(r, { actor: feedback.actor, attemptId: feedback.attempt_id, file: feedback.file, sha256: feedback.sha256, error: feedback.reason, maxRetries: options.maxProtocolRetries }); }
          if (r.terminal_blocker) {
            const current = snapshotSource(plan.root, mutableHostPaths(step)).sha256;
            if (!options.freshSession && r.history.at(-1)?.blocked_source === current) return attention(step, entry, r.terminal_blocker);
            r.terminal_blocker = null;
          }
          // A completed supervisor request must not be replayed merely because
          // its stale evidence needed an explicit budget increase.
          r.phase = r.pending_evidence && !r.pending_evidence.file ? 'host'
            : r.pending_evidence?.file && r.budget_kind === 'evidence' ? r.return_actor || 'worker' : r.resume_phase || 'supervisor';
          // A pending reviewer cooldown belongs to acceptance of the saved
          // worker result. Reconcile that result instead of repeating its work.
          const resumeAcceptance = ['acceptance-evidence', 'acceptance-timeout'].includes(r.budget_kind)
            || Boolean(r.budget_reason && entry.acceptance?.review_actor);
          r.next_action = resumeAcceptance ? `await-${r.phase}` : `run-${r.phase}`; r.budget_reason = null; r.budget_kind = null;

        }
        if (entry.retry_at) {
          const deadline = Date.parse(entry.retry_at);
          if (!Number.isFinite(deadline)) throw new Error('Invalid saved retry deadline.');
          if (deadline > Date.now()) { log(`Package ${step.id}: waiting until ${entry.retry_at}; Ctrl+C saves this wait.`); await waitUntil(deadline, controller.signal); }
        }
        if (controller.signal.aborted) { entry.status = 'interrupted'; save(); return interruptedCode; }
        if (r.phase === 'waiting') r.phase = r.waiting_actor || (r.next_action === 'retry-supervisor' ? 'supervisor' : 'worker');
        delete entry.retry_at;
        delete r.waiting_actor;
        if (r.rotate_pending) {
          if (r.subdivision.rotation_count >= options.maxSessionRotations) return attention(step, entry, 'Subdivision session rotation budget exhausted; inspect partial work and explicitly increase --max-session-rotations', 75, true, 'rotation');
          const role = r.rotate_pending, actor = role === 'supervisor' ? r.supervisor : subdivisionActor(entry, role);
          r.subdivision.rotations.push({ role, previous_thread: actor.thread_id || null, source_sha256: snapshotSource(plan.root, mutableHostPaths(step)).sha256, last_attempt: actor.last_attempt || null });
          r.subdivision.rotation_count++; delete actor.thread_id; delete actor.last_attempt;
          if (r.acceptance_request?.actor === role) r.acceptance_request.thread_id = null;
          r.tpm_streak = 0; delete r.rotate_pending; r.phase = role; r.next_action = `run-fresh-${role}`;
          entry.diagnostic = `Fresh bounded session after explicit TPM pressure. Inspect existing partial effects before repeating actions. ${(entry.diagnostic || '').slice(-4000)}`;
          save();
        }
        beforePhase();
        if (r.host_evidence_deferred) {
          // Earlier checks remain an immutable obligation while later subtasks
          // change source. Only source/context freshness may wait until finalization.
          const pending = r.pending_evidence;
          if (!pending?.file || r.phase === 'host') throw new Error('Cannot defer an unfinished host journal.');
          if (r.phase === 'finalizer') { r.host_evidence_deferred = false; save(); }
          else {
            try { attachHost(step, pending.file, pending.sha256); }
            catch (error) {
              if (!/^Invalid host validation: (source snapshot is stale|host dependency or environment identity is stale)$/.test(error.message)) throw error;
              attachHost(step, pending.file, pending.sha256, false);
            }
            delete plan.hostValidation;
          }
        }
        // Resume a journaled host phase before launching any model or fresh fixture.
        if (r.phase === 'host') {
          if (!canRecover(step)) return attention(step, entry, 'Automatic host recovery is disabled; pending host journal requires reconciliation');
          const pending = r.pending_evidence;
          if (!pending || !plan.recoveryPolicy.value.packages[step.id].recipes.includes(pending.recipe_id)) throw new Error('Unknown or unauthorized pending host recipe.');
          const guard = beforePhase();
          let host;
          try {
            const onJournal = journal => { pending.journal_file = path.relative(plan.root, journal.journalFile); save(); };
            if (pending.journal_file) host = await reconcileAutomaticHostValidation({ root: plan.root, journalFile: inside(plan.root, pending.journal_file), packageId: step.id, planHash: plan.planHash, recipeId: pending.recipe_id, onJournal });
            if (!host?.file) {
              if (pending.journal_file) {
                // Reconciled interrupted attempt is preserved; the next fixture has a new identity.
                pending.output_dir = path.relative(plan.root, path.join(plan.stateDir, 'host-checks', `${step.id}-${randomUUID()}`));
                pending.journal_file = null; save();
              }
              host = await runAutomaticHostValidation({ root: plan.root, packageId: step.id, planHash: plan.planHash, outputDir: inside(plan.root, pending.output_dir), mutablePaths: mutableHostPaths(step), recipeId: pending.recipe_id, signal: controller.signal, timeoutMs: options.hostTimeoutMinutes * 60000, onJournal });
            }
            afterPhase(guard);
            if (controller.signal.aborted || host.cancelled) { entry.status = 'interrupted'; save(); return interruptedCode; }
            if (host.timedOut) {
              if (r.evidence_refresh_count >= options.maxEvidenceRefreshes) return attention(step, entry, 'Host timeout retry/evidence refresh budget exhausted', 75, true, 'evidence');
              r.evidence_refresh_count++; r.next_action = 'retry-reconciled-host-timeout'; save(); continue;
            }
            if (!host.file) return attention(step, entry, `Host validation did not produce evidence: ${host.diagnostic || 'inspect the preserved ownership journal'}`);
            pending.file = path.relative(plan.root, host.file); pending.sha256 = sha(host.file); save();
            attachHost(step, host.file, pending.sha256);
            r.phase = r.return_actor || 'worker'; r.next_action = `resume-${r.phase}-with-host-evidence`;
            entry.diagnostic = `${entry.diagnostic || ''}\nVerified host evidence: ${pending.file}. Attribute every host check explicitly.`;
            save(); log(`Package ${step.id}: ${host.summary}`);
          } catch (error) {
            afterPhase(guard);
            if (controller.signal.aborted) { entry.status = 'interrupted'; save(); return interruptedCode; }
            r.history.push({ action: 'host-failure', reason: error.message, evidence: pending.file, journal: pending.journal_file });
            // Never forget unresolved resource ownership. Stop before any model retry.
            if (!pending.file) return attention(step, entry, `Host ownership/service reconciliation required: ${error.message}`);
            r.pending_evidence = null; delete plan.hostValidation;
            entry.diagnostic = `Host checks failed: ${error.message}. Inspect preserved evidence ${pending.file}; repair source only if in scope.`;
            r.phase = 'supervisor'; r.next_action = 'run-supervisor'; save();
          }
          continue;
        }
        if (r.phase === 'supervisor' && canRecover(step)) {
          const previous = r.supervisor;
          if (!previous && r.repair_count >= options.maxRepairRetries) return attention(step, entry, 'Repair/supervisor budget exhausted', 75, true);
          if (!r.supervisor) { r.repair_count++; r.supervisor = { attempts: 0 }; }
          const actor = r.supervisor;
          const guard = beforePhase([step.validation, step.handoff]);
          let result, decision, attemptId;
          if (!actor.last_attempt?.retry_accounted && !actor.last_attempt?.interrupted && actor.last_attempt?.exit_code === 0 && actor.last_attempt.turn_completed && !actor.last_attempt.turn_failed && savedOutcomeCurrent(plan, step, actor.last_attempt)) {
            attemptId = actor.last_attempt.attempt_id;
            result = restoreSavedProviderResult(actor.last_attempt);
          } else {
            actor.attempts++; attemptId = randomUUID(); r.next_action = 'await-supervisor'; save();
            log(`Package ${step.id}: ${actor.thread_id ? 'resuming' : 'starting'} recovery supervisor (cycle ${r.repair_count}).`);
            result = await runAttempt({ plan, options, step, entry: actor, attemptId, lock, signal: controller.signal, save, log, role: 'supervisor', prompt: supervisorPrompt(plan, step, entry, attemptId) });
          }
          afterPhase(guard);
          if (controller.signal.aborted) { entry.status = 'interrupted'; r.next_action = 'resume-supervisor'; save(); return interruptedCode; }
          const permanent = permanentProviderFailure(result);
          if (permanent) {
            fail(step, entry, result, permanent.kind, `Recovery supervisor: ${permanent.message}`);
            return attention(step, entry, `Provider ${permanent.kind} requires operator action: ${permanent.message}`, 1);
          }
          if (result.code !== 0 || result.turnFailed || !result.turnCompleted || result.timedOut) {
            let failure = result.timedOut ? { kind: 'transport', message: 'Recovery supervisor exceeded timeout', retryAfterMs: null } : classifyFailure(result);
            if (classifyTokenPressure(failure).explicit) failure = { ...failure, kind: 'rate-limit' };
            fail(step, entry, result, failure.kind, `Recovery supervisor: ${failure.message}`);
            if (['rate-limit', 'transport'].includes(failure.kind)) {
              const next = recoverPressure(step, entry, failure, 'supervisor', attemptId);
              if (retryProvider(entry, failure, next, actor.last_attempt)) continue;
              return attention(step, entry, `${failure.kind} retry budget exhausted`, 75, true);
            }
            return attention(step, entry, `Recovery supervisor failed (${failure.kind}): ${failure.message}`);
          }
          try {
            decision = validateRecoveryDecision(readJson(result.resultFile), { packageId: step.id, attemptId, policy: plan.recoveryPolicy, step, acceptanceProfile: plan.acceptanceProfile });
            if (decision.action === 'acceptance-check' && !['worker', 'finalizer'].includes(r.return_actor || 'worker')) throw new Error('acceptance-check requires the original worker or finalizer');
          }
          catch (error) {
            const retry = recordProtocolRejection(r, { actor: 'supervisor', attemptId, ...protocolRejectionArtifact(plan, result.resultFile), error, maxRetries: options.maxProtocolRetries });
            delete actor.last_attempt; save();
            if (retry && canRecover(step)) continue;
            return attention(step, entry, `Invalid supervisor decision: ${error.message}`, 75, true, 'protocol');
          }
          clearProtocolFeedback(r, 'supervisor');
          r.decisions.push({ file: path.relative(plan.root, result.resultFile), sha256: sha(result.resultFile), attempt_id: attemptId, action: decision.action, classification: decision.classification, summary: decision.summary });
          r.history.push({ action: decision.action, classification: decision.classification, changed_files: decision.changed_files, summary: decision.summary, worker_thread: entry.thread_id || null });
          delete r.supervisor;
          entry.diagnostic = `${entry.diagnostic || ''}\nSupervisor ${decision.classification}: ${decision.summary}\nCorrections attributed to package ${step.id}: ${decision.changed_files.join(', ') || 'none'}. Inspect partial effects before resuming.`;
          if (decision.action === 'blocked') {
            return attention(step, entry, decision.blockers.join('; '));
          }
          if (decision.action === 'acceptance-check') {
            requestAcceptance(step, entry, { role: r.return_actor || 'worker', origin: 'supervisor', attemptId, resultFile: result.resultFile });
            continue;
          }
          if (decision.action === 'host-check') {
            r.host_evidence_deferred = false;
            if (r.pending_evidence?.file) {
              // Revalidate before reuse or replacement. The shared verifier
              // below enforces integrity and the persisted refresh budget.
              r.phase = r.return_actor || 'worker'; r.next_action = 'revalidate-requested-host-evidence';
            } else {
              r.pending_evidence = { recipe_id: decision.recipe_id, output_dir: path.relative(plan.root, path.join(plan.stateDir, 'host-checks', `${step.id}-${randomUUID()}`)), journal_file: null, file: null, sha256: null };
              r.phase = 'host'; r.next_action = `run-host-recipe:${decision.recipe_id}`;
            }
          } else { r.phase = r.return_actor || 'worker'; r.next_action = `resume-${r.phase}`; }
          save(); continue;
        }
        if (r.pending_evidence?.file && canRecover(step) && !r.host_evidence_deferred) {
          const pending = r.pending_evidence;
          // The immutable decision retains the requested recipe across a budget
          // stop, including a request for a different authorized capability.
          const lastDecision = r.decisions.at(-1);
          const requestedRecipe = lastDecision?.action === 'host-check'
            ? readJson(inside(plan.root, lastDecision.file)).recipe_id : pending.recipe_id;
          try { attachHost(step, pending.file, pending.sha256); }
          catch (error) {
            // Integrity failures are never refreshed into apparent success.
            if (!/^Invalid host validation: (source snapshot is stale|host dependency or environment identity is stale)$/.test(error.message)) throw error;
            if (r.evidence_refresh_count >= options.maxEvidenceRefreshes) return attention(step, entry, `Host evidence refresh budget exhausted: ${error.message}`, 75, true, 'evidence');
            r.evidence_refresh_count++;
            r.history.push({ action: 'stale-evidence', file: pending.file, sha256: pending.sha256, recipe_id: pending.recipe_id, reason: error.message });
            pending.recipe_id = requestedRecipe; pending.file = null; pending.sha256 = null; pending.journal_file = null;
            pending.output_dir = path.relative(plan.root, path.join(plan.stateDir, 'host-checks', `${step.id}-${randomUUID()}`));
            delete plan.hostValidation; r.phase = 'host'; r.next_action = 'refresh-host-evidence'; save(); continue;
          }
          if (pending.recipe_id !== requestedRecipe) {
            // Valid evidence for another capability is preserved, not reused as
            // proof of this request. Its integrity was verified above.
            r.history.push({ action: 'host-recipe-change', file: pending.file, sha256: pending.sha256, recipe_id: pending.recipe_id, requested_recipe_id: requestedRecipe });
            r.pending_evidence = { recipe_id: requestedRecipe, output_dir: path.relative(plan.root, path.join(plan.stateDir, 'host-checks', `${step.id}-${randomUUID()}`)), journal_file: null, file: null, sha256: null };
            delete plan.hostValidation; r.phase = 'host'; r.next_action = `run-host-recipe:${requestedRecipe}`; save(); continue;
          }
        } else if (plan.hostValidation) attachHost(step, plan.hostValidation.file, plan.hostValidation.sha256);
        if (['planner', 'subtask'].includes(r.phase)) {
          const role = r.phase, s = r.subdivision, actor = subdivisionActor(entry, role);
          r.return_actor = role;
          const task = role === 'subtask' ? s.tasks[s.next_task] : null;
          const guard = beforePhase(role === 'planner' ? mutableHostPaths(step) : [step.validation, step.handoff]);
          const inputSource = snapshotSource(plan.root, mutableHostPaths(step)).sha256;
          let result, attemptId;
          if (!actor.last_attempt?.retry_accounted && !actor.last_attempt?.interrupted && actor.last_attempt?.exit_code === 0 && actor.last_attempt.turn_completed && !actor.last_attempt.turn_failed) {
            if (!savedOutcomeCurrent(plan, step, actor.last_attempt)) return attention(step, entry, `Saved ${role} result/checkpoint or source is stale; inspect unknown effects before retry`, 1);
            attemptId = actor.last_attempt.attempt_id;
            result = restoreSavedProviderResult(actor.last_attempt);
            log(`Package ${step.id}: reconciling saved successful ${role} output before any repeat.`);
          } else {
            actor.attempts++; actor.input_source_sha256 = inputSource; entry.attempts++; entry.status = 'running';
            attemptId = randomUUID(); r.next_action = `await-${role}`; save();
            result = await runAttempt({ plan, options, step, entry: actor, attemptId, lock, signal: controller.signal, save, log, role,
              prompt: boundedPrompt(plan, step, entry, attemptId, role, inputSource) });
          }
          afterPhase(guard);
          const currentSource = snapshotSource(plan.root, mutableHostPaths(step)).sha256;
          if (role === 'planner' && actor.input_source_sha256 !== currentSource) return attention(step, entry, 'Read-only planner input source changed; inspect partial effects before replay', 1);
          if (controller.signal.aborted) { entry.status = 'interrupted'; save(); return interruptedCode; }
          const permanent = permanentProviderFailure(result);
          if (permanent) {
            fail(step, entry, result, permanent.kind, `${role}: ${permanent.message}`);
            return attention(step, entry, `Provider ${permanent.kind} requires operator action: ${permanent.message}`, 1);
          }
          if (result.code !== 0 || result.turnFailed || !result.turnCompleted || result.timedOut) {
            let failure = result.timedOut ? { kind: 'transport', message: `${role} exceeded timeout`, retryAfterMs: null } : classifyFailure(result);
            if (classifyTokenPressure(failure).explicit) failure = { ...failure, kind: 'rate-limit' };
            fail(step, entry, result, failure.kind, `${role}: ${failure.message}`);
            if (['rate-limit', 'transport'].includes(failure.kind)) {
              const next = recoverPressure(step, entry, failure, role, attemptId);
              if (retryProvider(entry, failure, next, actor.last_attempt)) continue;
              return attention(step, entry, `${failure.kind} retry budget exhausted`, 75, true);
            }
            return attention(step, entry, `${role} failed (${failure.kind}): ${failure.message}`, 1);
          }
          let value;
          try {
            if (fs.statSync(result.resultFile).size > 64 * 1024) throw new Error('Result exceeds bounded size');
            const context = { root: plan.root, packageId: step.id, attemptId, subdivisionId: s.id, sourceHash: currentSource, artifactDirectory: subdivisionDirectory(plan, step, entry) };
            value = role === 'planner' ? validatePlannerResult(readJson(result.resultFile), context)
              : validateSubtaskResult(readJson(result.resultFile), { ...context, taskId: task.id, checkpointFile: task.checkpoint_file });
          } catch (error) {
            const retry = recordProtocolRejection(r, { actor: role, attemptId, ...protocolRejectionArtifact(plan, result.resultFile), error, maxRetries: options.maxProtocolRetries });
            delete actor.last_attempt; save();
            if (retry && canRecover(step)) continue;
            return attention(step, entry, `Invalid ${role} result/checkpoint: ${error.message}`, 75, true, 'protocol');
          }
          clearProtocolFeedback(r, role);
          if (role === 'planner') {
            if (value.status === 'blocked') return attention(step, entry, value.blockers.join('; '));
            s.artifacts.push({ file: path.relative(plan.root, result.resultFile), sha256: sha(result.resultFile) });
            s.tasks = value.subtasks.map(task => ({ ...task, actor: { attempts: 0 }, accepted: null }));
            r.phase = 'subtask'; r.return_actor = 'subtask'; r.next_action = 'run-fresh-subtask'; r.tpm_streak = 0; save(); continue;
          }
          if (value.status === 'checkpointed') {
            task.accepted = { file: value.checkpoint_file, sha256: value.checkpoint_sha256, result_file: path.relative(plan.root, result.resultFile), result_sha256: sha(result.resultFile), source_sha256: value.source_sha256, summary: value.summary };
            s.artifacts.push({ file: task.accepted.file, sha256: task.accepted.sha256 }, { file: task.accepted.result_file, sha256: task.accepted.result_sha256 });
            s.next_task++; r.tpm_streak = 0;
            r.host_evidence_deferred = Boolean(r.pending_evidence?.file && s.next_task < s.tasks.length);
            r.phase = s.next_task === s.tasks.length ? 'finalizer' : 'subtask'; r.return_actor = r.phase; r.next_action = `run-fresh-${r.phase}`;
            save(); log(`Package ${step.id}: accepted subtask ${task.id} checkpoint (${s.next_task}/${s.tasks.length}); original package acceptance remains pending.`); continue;
          }
          const reason = `${value.summary} ${value.blockers.join('; ')}`;
          fail(step, entry, result, value.status, reason);
          // A blocked checkpoint is historical evidence, never an accepted task or a final receipt.
          const archive = path.join(plan.root, subdivisionDirectory(plan, step, entry), `${attemptId}-unfinished.json`);
          fs.copyFileSync(inside(plan.root, value.checkpoint_file), archive, fs.constants.COPYFILE_EXCL);
          r.history.push({ action: 'subtask-unfinished', subtask_id: task.id, checkpoint: path.relative(plan.root, archive), sha256: sha(archive), blockers: value.blockers, summary: value.summary });
          delete actor.last_attempt; // The completed non-success was consumed, so supervisor return requires a new attempt.
          recordNoProgress(r, { diagnostic: reason, sourceHash: currentSource });
          r.phase = 'supervisor'; r.next_action = 'run-supervisor'; save(); continue;
        }
        // This parent phase does not depend on a completed receipt. Persist it
        // before review/gates so interruption resumes their existing journals.
        // Reverify before a resumed finalization, including intervening drift.
        if (r.phase === 'acceptance' || r.acceptance_request && r.next_action === `resume-${r.acceptance_request.actor}-with-acceptance-evidence`) {
          const request = r.acceptance_request;
          const expectedProfile = createHash('sha256').update(JSON.stringify(acceptanceRequirements)).digest('hex');
          const originalActor = request && subdivisionActor(entry, request.actor);
          if (!request || !acceptanceRequirements || request.package_id !== step.id || request.profile_sha256 !== expectedProfile
            || !originalActor || (originalActor.thread_id || null) !== request.thread_id) throw new Error('Parent acceptance request identity changed');
          verifyAcceptanceRequests(plan.root, r);
          r.phase = 'acceptance'; r.next_action = 'await-parent-acceptance'; save();
          try {
            await performAcceptance(step, entry);
            // A parent pass is evidence, never a completed worker or package.
            entry.status = 'incomplete'; r.phase = request.actor; r.return_actor = request.actor;
            r.next_action = `resume-${request.actor}-with-acceptance-evidence`; save();
          } catch (error) {
            const stopped = acceptanceError(step, entry, error);
            if (stopped !== null) return stopped;
            entry.status = 'failed'; entry.diagnostic = `Parent acceptance validation failed: ${error.message}`;
            r.failure_kind = 'failed';
            recordNoProgress(r, acceptanceProgressInputs(plan.root, entry, mutableHostPaths(step)));
            if (!canRecover(step)) return attention(step, entry, entry.diagnostic, 1);
            r.phase = 'supervisor'; r.next_action = 'run-supervisor'; save(); continue;
          }
        }
        const role = r.phase === 'finalizer' ? 'finalizer' : 'worker';
        const actor = subdivisionActor(entry, role);
        r.return_actor = role;
        const guard = beforePhase();
        let result, attemptId;
        if (r.next_action === `await-${role}` && !actor.last_attempt?.retry_accounted && !actor.last_attempt?.interrupted && actor.last_attempt?.exit_code === 0 && actor.last_attempt.turn_completed && !actor.last_attempt.turn_failed && savedOutcomeCurrent(plan, step, actor.last_attempt)) {
          // Parent may have died after a completed worker but before acceptance.
          // Reconcile that saved outcome rather than replaying completed side effects.
          attemptId = actor.last_attempt.attempt_id;
          result = restoreSavedProviderResult(actor.last_attempt);
          log(`Package ${step.id}: reconciling saved completed worker output before retry.`);
        } else {
          if (r.next_action === `await-${role}` && actor.last_attempt?.outcome) entry.diagnostic = 'Saved worker outcome became stale after interruption. Preserve completed effects, inspect intervening source/artifact changes and revalidate the package. ' + (entry.diagnostic || '');
          entry.status = 'running'; entry.attempts++; if (actor !== entry) actor.attempts++; r.phase = role; r.next_action = `await-${role}`;
          attemptId = randomUUID(); save();
          log(`${actor.thread_id ? 'Resuming' : 'Starting'} package ${step.id}: ${step.title} (attempt ${entry.attempts}).`);
          result = await runAttempt({ plan, options, step, entry: actor, attemptId, lock, signal: controller.signal, save, log, role, prompt: role === 'finalizer' ? boundedPrompt(plan, step, entry, attemptId, role, snapshotSource(plan.root, mutableHostPaths(step)).sha256) : undefined });
        }
        try { afterPhase(guard); }
        catch (error) { fail(step, entry, result, 'failed', `Protection check: ${error.message}`); throw error; }
        let reason, kind, provider;
        const permanent = permanentProviderFailure(result);
        if (!controller.signal.aborted && permanent) {
          fail(step, entry, result, permanent.kind, `${role}: ${permanent.message}`);
          return attention(step, entry, `Provider ${permanent.kind} requires operator action: ${permanent.message}`, 1);
        }
        if (controller.signal.aborted) { kind = 'interrupted'; reason = 'Interrupted by operator. Inspect unfinished tool effects before resuming.'; }
        else if (result.timedOut) { provider = { kind: 'transport', message: 'Worker exceeded the per-attempt timeout; inspect unfinished effects before continuing.' }; kind = 'transport'; reason = provider.message; }
        else {
          let final;
          try { final = readJson(result.resultFile); } catch { /* Incomplete output cannot complete a package. */ }
          let classified = result.code !== 0 || result.turnFailed || result.errors.length ? classifyFailure(result) : null;
          if (classifyTokenPressure(classified).explicit) classified = { ...classified, kind: 'rate-limit' };
          if (result.code === 0 && result.turnCompleted && !result.turnFailed) {
            try { validateWorkerResult(final, { step, attemptId, acceptanceProfile: plan.acceptanceProfile }); clearProtocolFeedback(r, role); }
            catch (error) {
              const retry = recordProtocolRejection(r, { actor: role, attemptId, ...protocolRejectionArtifact(plan, result.resultFile), error, maxRetries: canRecover(step) ? options.maxProtocolRetries : 0 });
              if (!canRecover(step)) { fail(step, entry, result, 'failed', error.message); return 1; }
              delete actor.last_attempt; save();
              if (retry) continue;
              return attention(step, entry, error.message, 75, true, 'protocol');
            }
          }
          if (result.code === 0 && result.turnCompleted && !result.turnFailed && final?.status === 'acceptance-ready'
            && !['authentication', 'quota', 'configuration'].includes(classified?.kind)) {
            // A worker that keeps handing back unchanged accepted source still
            // owes finalization; its loop consumes the existing finite budget.
            if (entry.acceptance?.accepted_source_sha256 === snapshotSource(plan.root, mutableHostPaths(step)).sha256) {
              recordNoProgress(r, { ...acceptanceProgressInputs(plan.root, entry, mutableHostPaths(step)), failureIds: ['finalization:acceptance-ready-without-completion'] });
            }
            requestAcceptance(step, entry, { role, origin: 'worker', attemptId, resultFile: result.resultFile });
            continue;
          }
          if (result.code === 0 && result.turnCompleted && !result.turnFailed && final?.status === 'completed') {
            try {
              validateArtifacts(plan, step, entry, result.resultFile, attemptId);
              const finalizedSource = actor.last_attempt?.parent_acceptance_source_sha256;
              await performAcceptance(step, entry);
              if (r.acceptance_request && finalizedSource !== entry.acceptance.accepted_source_sha256) {
                // New evidence produced after a source edit must be returned to
                // the original actor before its final artifacts can be accepted.
                entry.status = 'incomplete'; r.next_action = `resume-${role}-with-acceptance-evidence`; save(); continue;
              }
              validateArtifacts(plan, step, entry, result.resultFile, attemptId);
              entry.last_attempt = actor.last_attempt; entry.thread_id = actor.thread_id; entry.status = 'completed'; entry.completed_at = new Date().toISOString(); delete entry.diagnostic;
              r.phase = 'completed'; r.next_action = 'advance-selected-range'; save();
              log(`Completed package ${step.id}; receipt and handoff verified.`); break;
            } catch (error) {
              const stopped = acceptanceError(step, entry, error);
              if (stopped !== null) return stopped;
              kind = 'failed'; reason = `Completion validation failed: ${error.message}`;
            }
          } else if (classified && ['authentication', 'quota', 'configuration'].includes(classified.kind)) {
            // Non-completion prose cannot turn a permanent provider failure
            // into a source repair cycle or a request for host execution.
            provider = classified; kind = provider.kind; reason = `${provider.kind}: ${provider.message}`;
          } else if (['blocked', 'failed', 'incomplete'].includes(final?.status) && final.package_id === step.id && final.attempt_id === attemptId) {
            kind = final.status === 'blocked' ? 'blocked' : 'failed'; reason = `${final.summary || 'Worker reported unfinished work.'} ${(final.blockers || []).join('; ')}`;
          } else if (result.code !== 0 || result.turnFailed || result.errors.length) {
            provider = classified; kind = provider.kind === 'rate-limit' ? 'waiting-for-rate-limit' : provider.kind;
            reason = `${provider.kind}: ${provider.message}`;
          } else { kind = 'failed'; reason = 'Missing/invalid completion JSON or missing successful turn.completed event.'; }
        }
        fail(step, entry, result, kind, reason);
        if (kind === 'interrupted') return interruptedCode;
        if (provider?.kind === 'rate-limit' || (canRecover(step) && provider?.kind === 'transport')) {
          const next = recoverPressure(step, entry, provider, role, attemptId);
          if (retryProvider(entry, provider, next, actor.last_attempt)) continue;
          return attention(step, entry, `${provider.kind} retry budget exhausted`, 75, true);
        }
        if (!canRecover(step)) return kind === 'blocked' ? 2 : 1;
        if (provider && ['authentication', 'quota', 'configuration'].includes(provider.kind)) return attention(step, entry, `Provider ${provider.kind} requires operator action: ${provider.message}`, 1);
        if (provider?.kind === 'missing-session') {
          if (r.session_replacement_count >= 1) return attention(step, entry, 'Saved session is missing after the one allowed fresh replacement');
          const preserved = snapshotSource(plan.root, mutableHostPaths(step));
          r.history.push({ action: 'missing-session-replacement', previous_thread: actor.thread_id || null, source_sha256: preserved.sha256, files: preserved.files });
          r.session_replacement_count++; delete actor.thread_id;
          if (r.acceptance_request?.actor === role) r.acceptance_request.thread_id = null;
          entry.diagnostic += '\nOne fresh replacement authorized after preserving the partial source inventory. Inspect it before acting; credentials/provider remain unchanged.';
          r.phase = role; r.next_action = `run-fresh-${role}`; save(); continue;
        }
        recordNoProgress(r, acceptanceRequirements ? acceptanceProgressInputs(plan.root, entry, mutableHostPaths(step)) : { diagnostic: reason, sourceHash: snapshotSource(plan.root, mutableHostPaths(step)).sha256 });
        r.phase = 'supervisor'; r.next_action = 'run-supervisor'; save();
      }
    }
    log('Requested package range completed.');
    return 0;
  } catch (error) {
    // Preserve a corrupt/tampered scheduling file verbatim. This separate report
    // describes the required inspection without overwriting unknown state.
    atomicJson(path.join(plan.stateDir, 'needs-attention.json'), { schema_version: 1, phase: 'needs-attention', reason: redact(error.message), next_action: 'inspect-protected-inputs-and-state-before-resume; preserve-history' });
    log(`Runner needs attention: ${error.message}`);
    throw error;
  } finally {
    process.removeListener('SIGINT', stopInt); process.removeListener('SIGTERM', stopTerm);
    lifecycle.signal?.removeEventListener('abort', stopTerm);
    const closure = lifecycle.cleaned ? verifyUnattendedCleanup(plan,{historicalCompleted}) : null;
    lock.release();
    lifecycle.cleaned?.({...describeRun(plan, selected, options),resource_closure:closure});
  }
}

export async function main(argv = process.argv.slice(2), lifecycle = {}) {
  try { return await execute(argv, lifecycle); }
  catch (error) {
    // Keep diagnostics outside scheduling state, including pre-lock failures.
    try {
      const options = parseOptions(argv);
      if (options.command==='status' && options.json) { console.log(JSON.stringify(publicProjection({schema_version:1,phase:'needs-attention',reason:error.message,next_action:'Inspect saved identity and source without changing state.'}))); return 2; }
      if (['launch','preflight','start','resume','stop'].includes(options.command) && process.env.CODEX_PLAN_WORKER !== '1' && process.env.CODEX_RECOVERY_SUPERVISOR !== '1') {
        const root = fs.realpathSync(options.repo), manifest = readJson(inside(root,options.manifest));
        if (/^[a-z0-9-]+$/.test(manifest.plan_id)) {
          const report = writeCommandReport({root,manifest,stateDir:path.join(root,'.codex-plan-runner',manifest.plan_id)},'blocked',{ready:false,phase:'needs-attention',selected:selection({manifest},options).map(step=>step.id),requested:{step:options.step||null,from:options.from||null,to:options.to||null,session:options.session||null},capability_readiness:'not established; startup guard failed',reason:error.message,next_action:'Inspect the reported prerequisite or ownership mismatch; preserve saved work and repeat the same command.'});
          error.message = `${error.message}\nDurable report: ${report.report_file}`;
          if (options.json) { console.log(JSON.stringify(publicProjection(report))); return 2; }
        }
      }
    } catch { /* Never replace the original error with reporting failure. */ }
    throw new Error(publicProjection(error.message), {cause:error});
  }
}
