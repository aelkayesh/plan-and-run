import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {snapshotSource,snapshotDependencies} from './host-validation.mjs';
import {acceptanceForPackage} from './acceptance-policy.mjs';
import {acceptanceExecutionContext} from './acceptance-adapters.mjs';
import {publicProjection} from './background-control.mjs';
import {redact} from './failure-report.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const scrub = value => publicProjection(value);
export function secureStatePath(root,file) {
  file=path.resolve(file);
  if(!file.startsWith(path.join(root,'.codex-plan-runner')+path.sep)) throw new Error('Report path must remain inside private runner state.');
  let cursor=root;
  for(const part of path.relative(root,file).split(path.sep)) {
    cursor=path.join(cursor,part);
    if(fs.lstatSync(cursor,{throwIfNoEntry:false})?.isSymbolicLink()) throw new Error('Runner state/report paths may not contain symlinks.');
  }
  return file;
}
export function sessionFor(root,stateDir,id,latest) {
  if(!id) return latest(stateDir,root);
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error('Invalid session UUID.');
  return secureStatePath(root,path.join(stateDir,'background',id,'session.json'));
}
export function writeCommandReport(plan,kind,body) {
  const directory=secureStatePath(plan.root,path.join(plan.stateDir,'reports'));
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  for(const file of [path.join(plan.root,'.codex-plan-runner'),plan.stateDir,directory]) fs.chmodSync(file,0o700);
  const id=randomUUID(),file=path.join(directory,`${kind}-${id}.json`);
  const report=scrub({schema_version:1,id,kind,plan_id:plan.manifest.plan_id,recorded_at:new Date().toISOString(),...body,report_file:file});
  fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  fs.writeFileSync(file.replace(/\.json$/,'.txt'),`${plan.manifest.plan_id}: ${kind}\n${JSON.stringify(report,null,2)}\n`,{flag:'wx',mode:0o600});
  return report;
}
const executionOptions = options => Object.fromEntries(Object.entries({...options,command:'resume'}).filter(([key])=>!['json','session'].includes(key)).sort(([a],[b])=>a.localeCompare(b)));
export function startupIdentity(plan,runtime,options,selected,readiness=null) {
  const source=snapshotSource(plan.root);
  const bindingFiles=runtime.files.map(([file,sha256])=>({file:path.resolve(runtime.directory,file),sha256}));
  if(plan.recoveryPolicy.file) bindingFiles.push({file:plan.recoveryPolicy.file,sha256:plan.recoveryPolicy.hash});
  return {plan_id:plan.manifest.plan_id,root:plan.root,plan_hash:plan.planHash,runtime_hash:runtime.hash,policy_hash:plan.recoveryPolicy.hash,
    source_sha256:source.sha256,dependencies_sha256:snapshotDependencies(plan.root).sha256,
    state_sha256:fs.existsSync(plan.stateFile)?fileHash(plan.stateFile):null,
    options:executionOptions(options),selected,preflight:readiness,binding_files:bindingFiles};
}
export function assertStartupIdentity(plan,runtime,options,expected,readiness) {
  const current=startupIdentity(plan,runtime,options,expected.selected,readiness);
  if(JSON.stringify(current)!==JSON.stringify(expected)) throw new Error('Source/runtime/policy/state/options changed between launch preflight and acquired plan lock. Inspect and launch again.');
}
// Public failure details contain identities and allowlisted error categories,
// never assertion bodies, provider responses, stacks or arbitrary suite messages.
export function acceptanceReportFailures(report, checkout) {
  const failure_ids = [], failed_suites = [];
  for (const suite of Array.isArray(report?.testResults) ? report.testResults : []) {
    if (!suite || typeof suite !== 'object') continue;
    const relative = typeof suite.name === 'string' ? path.relative(checkout, path.resolve(checkout, suite.name)) : '';
    const file = relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)
      ? relative.replace(/[\r\n\x00-\x1f\x7f]/g, '').slice(0, 500) : '[unidentified suite]';
    const failed = (Array.isArray(suite.assertionResults) ? suite.assertionResults : []).filter(item => item?.status === 'failed');
    for (const item of failed) if (typeof item.fullName === 'string') failure_ids.push(`case:${file}:${item.fullName.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 1000)}`);
    if (suite.status !== 'failed' && failed.length === 0) continue;
    failure_ids.push(`suite:${file}`);
    const messages = [suite.message, ...(Array.isArray(suite.failureMessages) ? suite.failureMessages : []), ...failed.flatMap(item => Array.isArray(item.failureMessages) ? item.failureMessages : [])].filter(item => typeof item === 'string').join('\n');
    const error_codes = [...new Set(messages.match(/\b(?:ENOENT|EACCES|EPERM|ENOSPC|ENOEXEC|ENOTDIR|EISDIR|EMFILE|EADDRINUSE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b/g) || [])];
    const error_types = [...new Set(messages.match(/\b(?:SyntaxError|TypeError|ReferenceError|RangeError|AssertionError|ImportError|ModuleNotFoundError)\b/g) || [])];
    failed_suites.push({file, failed_cases: failed.length, error_codes, error_types});
  }
  return scrub({failure_ids: [...new Set(failure_ids)], failed_suites});
}

export function acceptanceFailureDetails(plan, step, entry) {
  const a = entry?.acceptance;
  if (!a?.failure_ids?.length || entry.status === 'completed' || !['failed', 'blocked', 'incomplete'].includes(entry.status)
    || !/^(?:Parent acceptance validation failed:|Completion validation failed:)/.test(entry.diagnostic || '')) return null;
  const readBound = reference => {
    if (!reference || typeof reference.file !== 'string' || !/^[a-f0-9]{64}$/.test(reference.sha256 || '')) return null;
    const file = secureStatePath(plan.root, path.resolve(plan.root, reference.file));
    if (!fs.lstatSync(file).isFile()) return null;
    const bytes = fs.readFileSync(file);
    return hash(bytes) === reference.sha256 ? JSON.parse(bytes) : null;
  };
  try {
    const source = snapshotSource(plan.root, [step.validation, step.handoff, path.join(path.dirname(step.plan), 'README.md')]).sha256;
    const context = acceptanceExecutionContext(plan.root);
    const failureIds = new Set(a.failure_ids), evidence = [], failed_suites = [], gate_ids = [];
    for (const [gateId, record] of Object.entries(a.gates || {})) {
      if (record.passed !== false) continue;
      const value = readBound(record);
      if (!value || value.passed !== false || value.package_id !== step.id || value.gate?.id !== gateId || value.source?.sha256 !== source
        || JSON.stringify(value.context) !== JSON.stringify(context)
        || !(value.failure_ids || []).some(id => failureIds.has(id))) continue;
      const reportRef = (value.artifacts || []).find(item => item.file === value.report_file);
      const report = reportRef && readBound(reportRef);
      const details = report ? acceptanceReportFailures(report, value.checkout || plan.root) : {failure_ids: [], failed_suites: []};
      for (const id of details.failure_ids) failureIds.add(id);
      failed_suites.push(...details.failed_suites.map(suite => ({gate_id: gateId, ...suite})));
      gate_ids.push(gateId);
      evidence.push({gate_id: gateId, file: record.file, sha256: record.sha256, ...(reportRef ? {report: {file: reportRef.file, sha256: reportRef.sha256}} : {})});
    }
    if (!gate_ids.length) return null;
    return scrub({summary: `Acceptance gate${gate_ids.length === 1 ? '' : 's'} ${gate_ids.join(', ')} failed`, gate_ids,
      failure_ids: [...failureIds], failed_suites, evidence});
  } catch {
    // Ordinary artifact guards report invalid/unreadable evidence. Presentation
    // must not turn unverified or stale details into a current diagnosis.
    return null;
  }
}

export function describeRun(plan,selected,options,diagnostics=[]) {
  let required=0,accepted=0;
  const packages=selected.map(step=>{
    const entry=plan.state.steps[step.id],r=entry?.recovery;
    const requirements=acceptanceForPackage(plan.acceptanceProfile,step.id);
    const count=requirements?.criteria.length || 0;required+=count;
    // Historical gate files alone are not acceptance of changed source.
    const complete=entry?.status==='completed' && !diagnostics.length;
    if(complete) accepted+=count;
    return {id:step.id,status:entry?.status||'pending',manual:step.manual===true,
      acceptance_mode:requirements?'strict':'legacy',criteria_required:count,criteria_accepted:complete?count:0,
      gates:(requirements?.required_gates||[]).map(gate=>({id:gate.id,capability:gate.capability,accepted:complete&&entry?.acceptance?.gates?.[gate.id]?.passed===true,recorded_passed:entry?.acceptance?.gates?.[gate.id]?.passed===true})),
      actor:r?.phase||null,session:entry?.thread_id||null,retry_at:entry?.retry_at||null,
      budgets:{rate:{used:entry?.rate_limit_count||0,limit:options.maxRateRetries},transport:{used:r?.transport_count||0,limit:options.maxTransportRetries},repair:{used:r?.repair_count||0,limit:options.maxRepairRetries},protocol:{used:r?.protocol_retry_count||0,limit:options.maxProtocolRetries},evidence:{used:r?.evidence_refresh_count||0,limit:options.maxEvidenceRefreshes}},
      blocker:r?.terminal_blocker||r?.budget_reason||(['blocked','failed'].includes(entry?.status)?entry?.diagnostic:null)||null,
      acceptance_failure: diagnostics.length ? null : acceptanceFailureDetails(plan,step,entry),
      next_action:complete?'accepted':step.manual?'resolve-manual-boundary-separately':r?.next_action||'run-worker',
      validation_file:step.validation,handoff_file:step.handoff};
  });
  const unfinished=packages.filter(x=>x.status!=='completed'||diagnostics.length).map(x=>x.id);
  const first=packages.find(x=>unfinished.includes(x.id));
  return scrub({schema_version:1,plan_id:plan.manifest.plan_id,repository:plan.root,state_file:plan.stateFile,selected:packages.map(x=>x.id),
    accepted:!unfinished.length,unfinished,criteria:{accepted,required},packages,diagnostics,
    blocker:diagnostics[0]||first?.blocker||null,acceptance_failure:first?.acceptance_failure||null,next_action:diagnostics.length?'inspect-protected-inputs-before-resume':first?.next_action||'selected-range-complete'});
}
