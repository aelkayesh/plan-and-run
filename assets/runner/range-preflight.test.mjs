import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightRange } from './range-preflight.mjs';

const plan = {plan_id:'synthetic',steps:[
  {id:'01',dependencies:[],manual:false},{id:'02',dependencies:['01'],manual:false},
  {id:'03',dependencies:['02'],manual:false},{id:'15',dependencies:['03'],manual:false}
]};
const requirements = {'01':{gates:[{id:'test',capability:'npm-checks'}]},'02':{gates:[{id:'test2',capability:'npm-checks'}]},
  '03':{gates:[{id:'browser',capability:'loopback-browser'}]},'15':{gates:[{id:'sql',capability:'synthetic-postgres'}]}};
const options = extra=>({manifest:plan,state:{steps:{}},requirements,verifyCompleted:()=>{},authProbe:()=>({ready:true,kind:'local-only'}),capabilityProbe:()=>({ready:true,available:true}),...extra});

test('a later missing capability blocks the whole requested range before execution',async()=>{
  const probes=[],state={steps:{}},before=JSON.stringify(state);
  const r=await preflightRange(options({state,options:{to:'03'},capabilityProbe:x=>{
    probes.push(x.gates[0].capability);if(x.gates[0].capability==='loopback-browser')throw new Error('Missing installed browser');return {ready:true,available:true};
  }}));
  assert.equal(r.ready,false);assert.deepEqual(probes,['npm-checks','loopback-browser']);assert.deepEqual(r.errors[0].required_by,[{package_id:'03',gate_id:'browser'}]);
  assert.equal(JSON.stringify(state),before);assert.deepEqual(r.executable,['01','02','03']);
});
test('in-range predecessors are planned; unfinished prerequisites before from are blockers',async()=>{
  const full=await preflightRange(options({options:{to:'03'}}));assert.equal(full.ready,true);
  const missing=await preflightRange(options({options:{from:'02',to:'03'}}));assert.equal(missing.ready,false);assert.equal(missing.errors[0].dependency,'01');
});
test('completed packages retain verified evidence and do not trigger their tool requirements',async()=>{
  const checked=[],probes=[],r=await preflightRange(options({state:{steps:{'01':{status:'completed'},'02':{status:'completed'}}},options:{to:'03'},
    verifyCompleted:step=>checked.push(step.id),capabilityProbe:x=>{probes.push(x.gates[0].capability);return {ready:true,available:true}}}));
  assert.equal(r.ready,true);assert.deepEqual(checked,['01','02']);assert.deepEqual(probes,['loopback-browser']);assert.deepEqual(r.accepted,['01','02']);
});
test('invalid historical evidence blocks launch even with a completed state label',async()=>{
  const r=await preflightRange(options({state:{steps:{'01':{status:'completed'}}},verifyCompleted:()=>{throw new Error('receipt changed')}}));
  assert.equal(r.ready,false);assert.equal(r.errors[0].kind,'accepted-evidence');
});
test('generic ordinary15 is runnable while an explicit manual boundary remains unfinished',async()=>{
  const generic=await preflightRange(options({}));assert.equal(generic.ready,true);assert.ok(generic.executable.includes('15'));
  const site=await preflightRange(options({isManual:step=>step.manual||step.id==='15'}));
  assert.equal(site.ready,true);assert.equal(site.selected_complete,false);assert.equal(site.stops_at,'15');assert.ok(!site.executable.includes('15'));
  const manualOnly=await preflightRange(options({options:{step:'15'},isManual:step=>step.id==='15'}));assert.equal(manualOnly.ready,false);
});
test('all-complete selection needs neither auth nor capability probe',async()=>{
  const r=await preflightRange(options({state:{steps:Object.fromEntries(plan.steps.map(s=>[s.id,{status:'completed'}]))},authProbe:()=>{throw new Error('must not probe')},capabilityProbe:()=>{throw new Error('must not probe')}}));
  assert.equal(r.ready,true);assert.equal(r.selected_complete,true);assert.deepEqual(r.capabilities,[]);
});
test('capability and local-auth failures are collected together',async()=>{
  const r=await preflightRange(options({capabilityProbe:()=>{throw new Error('missing')},authProbe:()=>({ready:false,message:'Local login required'})}));
  assert.equal(r.ready,false);assert.equal(r.errors.filter(e=>e.kind==='capability').length,3);assert.equal(r.errors.at(-1).kind,'authentication');
});
test('later dependencies and reversed ranges never silently reorder execution',async()=>{
  const changed=structuredClone(plan);changed.steps[0].dependencies=['03'];
  const r=await preflightRange(options({manifest:changed}));assert.equal(r.ready,false);assert.equal(r.errors[0].dependency,'03');
  await assert.rejects(preflightRange(options({options:{from:'03',to:'01'}})),/reversed/);
});

for (const verdict of [false, {passed:false}, {verified:false}]) test(`explicit rejected historical verdict blocks readiness ${JSON.stringify(verdict)}`,async()=>{
 const r=await preflightRange(options({state:{steps:{'01':{status:'completed'}}},verifyCompleted:async()=>verdict}));
 assert.equal(r.ready,false);assert.equal(r.errors[0].kind,'accepted-evidence');
});
test('async rejected historical verification is awaited before readiness',async()=>{
 const r=await preflightRange(options({state:{steps:{'01':{status:'completed'}}},verifyCompleted:async()=>{await Promise.resolve();throw new Error('async stale evidence')}}));
 assert.equal(r.ready,false);assert.match(r.errors[0].message,/async stale/);
});
for (const verdict of [{passed:false},{available:false},undefined]) test(`nonthrowing capability refusal blocks readiness ${JSON.stringify(verdict)}`,async()=>{
 const r=await preflightRange(options({capabilityProbe:()=>verdict}));assert.equal(r.ready,false);assert.equal(r.errors[0].kind,'capability');
});
test('frozen required_gates are collected across the entire executable prefix with attribution',async()=>{
 const policy=Object.fromEntries(Object.entries(requirements).map(([id,p])=>[id,{required_gates:p.gates}]));
 const r=await preflightRange(options({requirements:policy,options:{to:'03'}}));
 assert.equal(r.ready,true);assert.equal(r.capabilities.length,2);
 assert.deepEqual(r.capabilities[0].required_by,[{package_id:'01',gate_id:'test'},{package_id:'02',gate_id:'test2'}]);
});
test('manual boundary excludes all later prerequisites but never completes the selected range',async()=>{
 const changed=structuredClone(plan);changed.steps[1].manual=true;const probes=[];
 const r=await preflightRange(options({manifest:changed,capabilityProbe:x=>{probes.push(x.gates[0].capability);return {ready:true}}}));
 assert.equal(r.ready,true);assert.equal(r.selected_complete,false);assert.deepEqual(r.executable,['01']);assert.deepEqual(probes,['npm-checks']);assert.deepEqual(r.pending,['01','02','03','15']);
});
test('secret-shaped prerequisite errors are redacted in durable-facing range output',async()=>{
 const r=await preflightRange(options({capabilityProbe:()=>{throw new Error('password=private-value Bearer private-access-token')}}));
 assert.equal(r.ready,false);assert.ok(!JSON.stringify(r).includes('private-value'));assert.ok(!JSON.stringify(r).includes('private-access-token'));
});
