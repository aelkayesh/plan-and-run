import { redact } from './failure-report.mjs';

// Pure requested-range planning: no state writes and no worker invocation.
// The caller supplies frozen-policy verification and fixed local probes.
export async function preflightRange({ manifest, state, options = {}, requirements = {},
  verifyCompleted, capabilityProbe, authProbe, isManual = step => step.manual === true }) {
  const steps = manifest.steps, ids = steps.map(step => step.id);
  if (new Set(ids).size !== ids.length || !steps.length) throw new Error('Invalid plan sequence.');
  if (options.step && (options.from || options.to)) throw new Error('Choose a step or range.');
  const from = options.step || options.from || ids[0], to = options.step || options.to || ids.at(-1);
  if (!ids.includes(from) || !ids.includes(to) || ids.indexOf(from) > ids.indexOf(to)) throw new Error('Unknown or reversed selected range.');
  const selected = steps.slice(ids.indexOf(from), ids.indexOf(to) + 1);
  const errors = [], accepted = [], pending = [], executable = [], manual = [], capabilities = [];
  const checkedAccepted = new Set(), available = new Set(), seenGates = new Map();
  let boundary;
  const verify = async id => {
    if (checkedAccepted.has(id)) return available.has(id);
    checkedAccepted.add(id);
    try {
      if (typeof verifyCompleted !== 'function') throw new Error('Accepted evidence verification is unavailable.');
      const verdict = await verifyCompleted(steps.find(step => step.id === id), state.steps[id]);
      if (verdict === false || verdict?.passed === false || verdict?.verified === false) throw new Error('Accepted evidence verification failed.');
      available.add(id); return true;
    }
    catch (error) { errors.push({kind:'accepted-evidence',package_id:id,message:redact(error.message)});return false; }
  };
  // A valid completion is available even when it lies outside this selection.
  for (const step of steps) if (state.steps[step.id]?.status === 'completed') await verify(step.id);
  for (const step of selected) {
    if (state.steps[step.id]?.status === 'completed' && available.has(step.id)) { accepted.push(step.id); continue; }
    pending.push(step.id);
    if (isManual(step)) { manual.push(step.id); boundary ||= step.id; continue; }
    if (boundary) continue;
    executable.push(step.id);
    for (const dependency of step.dependencies || []) if (!available.has(dependency)) {
      errors.push({kind:'dependency',package_id:step.id,dependency,message:`Package ${step.id} requires ${dependency} before it can start.`});
    }
    // This package becomes a planned predecessor only after its position has
    // been visited; a later selected dependency cannot silently reorder work.
    available.add(step.id);
    for (const gate of requirements[step.id]?.required_gates || requirements[step.id]?.gates || []) {
      const key = JSON.stringify([gate.capability,gate.preset || null]);
      if (!seenGates.has(key)) seenGates.set(key,{gate,package_id:step.id,required_by:[]});
      seenGates.get(key).required_by.push({package_id:step.id,gate_id:gate.id});
    }
  }
  for (const item of seenGates.values()) {
    if (typeof capabilityProbe !== 'function') { errors.push({kind:'capability',required_by:item.required_by,message:'No fixed capability preflight is configured.'});continue; }
    try {
      const evidence = await capabilityProbe({packageId:item.package_id,gates:[item.gate]});
      if (evidence?.ready !== true) throw new Error('Fixed capability preflight did not establish readiness.');
      capabilities.push({capability:item.gate.capability,preset:item.gate.preset || null,required_by:item.required_by,evidence});
    }
    catch (error) { errors.push({kind:'capability',capability:item.gate.capability,required_by:item.required_by,message:redact(error.message)}); }
  }
  let authentication = null;
  if (executable.length) {
    try {
      if (typeof authProbe !== 'function') throw new Error('Local authentication preflight is unavailable.');
      authentication = await authProbe();
      if (authentication?.ready !== true) throw new Error(authentication?.message || 'Local authentication readiness was not established.');
    } catch (error) { errors.push({kind:'authentication',message:redact(error.message),next_action:authentication?.next_action || 'Inspect local authentication readiness without invoking a worker.'}); }
  }
  return {schema_version:1,plan_id:manifest.plan_id,selected:selected.map(step=>step.id),accepted,pending,executable,
    manual_boundaries:manual,stops_at:boundary || null,capabilities,authentication,errors,
    ready:errors.length===0&&(executable.length>0||pending.length===0),selected_complete:pending.length===0,
    next_action:errors.length?'Resolve the reported prerequisites, then repeat preflight.':pending.length===0?'Selected packages are already accepted.':executable.length?'Run the selected authorized prefix; retain any manual boundary.':`Package ${boundary} is a manual boundary; it remains unfinished.`};
}
