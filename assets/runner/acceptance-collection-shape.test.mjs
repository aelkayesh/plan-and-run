import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseAcceptanceReport } from './acceptance-adapters.mjs';

const root=path.resolve('/owned/checkout');
const file='tests/benchmark-store.test.ts';
const nested={
  ancestorTitles:['benchmark project permissions and immutable publication'],
  fullName:'benchmark project permissions and immutable publication separates contributors, maintainers, release managers and platform administration',
  status:'passed',
  title:'separates contributors, maintainers, release managers and platform administration',
  duration:31.41904199999999,
  failureMessages:[],
  meta:{},
  tags:[],
};
const nestedDisplay='benchmark project permissions and immutable publication > separates contributors, maintainers, release managers and platform administration';
const topLevel={
  ancestorTitles:[],
  fullName:'validates the package-04 PostgreSQL assignment fixture locally before SQL acceptance',
  status:'passed',
  title:'validates the package-04 PostgreSQL assignment fixture locally before SQL acceptance',
  duration:1,
  failureMessages:[],
  meta:{},
  tags:[],
};
function input(assertions=[nested,topLevel],names=[nestedDisplay,topLevel.fullName]) {
  return {
    root,files:[file],cases:assertions.map(t=>t.fullName),capability:'synthetic-postgres',
    report:{
      success:true,numFailedTests:0,numFailedTestSuites:0,
      numTotalTests:assertions.length,numPassedTests:assertions.length,
      numPendingTests:0,numTodoTests:0,snapshot:{failure:false},
      testResults:[{name:path.join(root,file),status:'passed',assertionResults:structuredClone(assertions)}],
    },
    collected:names.map(name=>({name,file:path.join(root,file)})),
  };
}
function parse(value) { return parseAcceptanceReport(value); }

test('Vitest 4 list display names match report hierarchy while canonical fullName IDs are retained',()=>{
  const value=input();
  const result=parse(value);
  assert.deepEqual(result.cases,[nested.fullName,topLevel.fullName]);
  assert.deepEqual(result.assertions,[
    {file,id:nested.fullName,status:'passed',failure_messages:[]},
    {file,id:topLevel.fullName,status:'passed',failure_messages:[]},
  ]);
  assert.deepEqual(result.counts,{total:2,passed:2,skipped:0,required:2,required_skipped:0});
  assert.equal(value.report.testResults[0].assertionResults[0].fullName,nested.fullName);
});

test('literal hierarchy separators in suite and test titles are preserved without replacement',()=>{
  const assertion={...nested,ancestorTitles:['literal > suite'],title:'keeps x > y',fullName:'literal > suite keeps x > y'};
  const value=input([assertion],['literal > suite > keeps x > y']);
  assert.deepEqual(parse(value).cases,['literal > suite keeps x > y']);
  value.collected[0].name='literal suite keeps x y';
  assert.throws(()=>parse(value),/collection and execution case identities differ/);
});

test('modern structured reports cannot fall back to collection using canonical fullName',()=>{
  const value=input();
  value.collected[0].name=nested.fullName;
  assert.throws(()=>parse(value),/collection and execution case identities differ/);
});

test('extra and omitted collected tests each fail the complete execution comparison',()=>{
  const extra=input();extra.collected.push({file:path.join(root,file),name:'unexecuted test'});
  assert.throws(()=>parse(extra),/collection and execution case identities differ/);
  const omitted=input();omitted.collected.pop();
  assert.throws(()=>parse(omitted),/collection and execution case identities differ/);
});

test('duplicate list entries cannot conceal an omitted executed test',()=>{
  const value=input();value.collected[1]={...value.collected[0]};
  assert.throws(()=>parse(value),/collection and execution case identities differ/);
});

test('distinct title hierarchies with the same display name are rejected as ambiguous',()=>{
  const first={...nested,ancestorTitles:['outer > inner'],title:'case',fullName:'outer > inner case'};
  const second={...nested,ancestorTitles:['outer','inner'],title:'case',fullName:'outer inner case'};
  const value=input([first,second],['outer > inner > case','outer > inner > case']);
  assert.throws(()=>parse(value),/ambiguous collection case identities/);
});

test('duplicate mapped canonical report IDs remain rejected even when total counts match',()=>{
  const value=input([nested,nested],[nestedDisplay,nestedDisplay]);
  assert.throws(()=>parse(value),/ambiguous full test names across required files/);
});

function withUnmappedDuplicates() {
  const value=input();
  const otherFile='tests/parameterized.test.ts';
  const assertion={...nested,ancestorTitles:['parameterized'],title:'same display',fullName:'parameterized same display'};
  value.report.testResults.push({name:path.join(root,otherFile),status:'passed',assertionResults:[structuredClone(assertion),structuredClone(assertion)]});
  value.report.numTotalTests+=2;value.report.numPassedTests+=2;
  value.collected.push(...[1,2].map(()=>({file:path.join(root,otherFile),name:'parameterized > same display'})));
  return value;
}

test('duplicate unrelated parameterized names pass only with matching collection multiplicity',()=>{
  const value=withUnmappedDuplicates();
  const result=parse(value);
  assert.deepEqual(result.cases,[nested.fullName,topLevel.fullName]);
  assert.deepEqual(result.counts,{total:4,passed:4,skipped:0,required:2,required_skipped:0});
});

test('unmapped title hierarchies may share display names when every instance ran',()=>{
  const value=withUnmappedDuplicates();
  value.report.testResults[1].assertionResults=[
    {...nested,ancestorTitles:['outer > inner'],title:'case',fullName:'outer > inner case'},
    {...nested,ancestorTitles:['outer','inner'],title:'case',fullName:'outer inner case'},
  ];
  value.collected[2].name=value.collected[3].name='outer > inner > case';
  assert.equal(parse(value).counts.passed,4);
});

test('extra or omitted instances of an unmapped duplicate fail multiset accounting',()=>{
  const extra=withUnmappedDuplicates();extra.collected.push({...extra.collected.at(-1)});
  assert.throws(()=>parse(extra),/collection and execution case identities differ/);
  const missing=withUnmappedDuplicates();missing.collected.pop();
  assert.throws(()=>parse(missing),/collection and execution case identities differ/);
  const sameCount=withUnmappedDuplicates();sameCount.collected[2].name='another instance';
  assert.throws(()=>parse(sameCount),/collection and execution case identities differ/);
});

test('duplicate unrelated names still fail if any executed instance did not pass',()=>{
  const value=withUnmappedDuplicates();
  value.report.testResults[1].assertionResults[1].status='failed';
  assert.throws(()=>parse(value),/an executed case did not pass/);
});

test('canonical fullName mappings still reject extra, omitted or display-form IDs',()=>{
  for(const cases of [[nested.fullName],[nested.fullName,topLevel.fullName,'extra'],[nestedDisplay,topLevel.fullName]]) {
    assert.throws(()=>parse({...input(),cases}),/mapping must enumerate every required case exactly/);
  }
});

test('legacy reports without title hierarchy preserve exact-name compatibility only',()=>{
  const legacy={fullName:'legacy > literal title',status:'passed',failureMessages:[]};
  const value=input([legacy],[legacy.fullName]);
  assert.deepEqual(parse(value).cases,[legacy.fullName]);
  value.collected[0].name='legacy literal title';
  assert.throws(()=>parse(value),/collection and execution case identities differ/);
});

test('partial or invalid structured identities are rejected instead of using legacy fallback',()=>{
  for(const change of [
    {ancestorTitles:undefined},
    {title:undefined},
    {ancestorTitles:['suite',null]},
    {title:42},
    {fullName:'unrelated mapping identity'},
  ]) {
    const value=input();Object.assign(value.report.testResults[0].assertionResults[0],change);
    assert.throws(()=>parse(value),/malformed assertion title hierarchy|assertion full name differs from title hierarchy/);
  }
});

test('collected identities outside the owned checkout or with malformed fields are rejected',()=>{
  for(const change of [{file:path.join(root,'..','outside.test.ts')},{file:null},{name:null}]) {
    const value=input();Object.assign(value.collected[0],change);
    assert.throws(()=>parse(value),/collection names outside owned checkout|malformed collection identity/);
  }
});

test('unrelated opt-in skips remain visible while required skips cannot pass',()=>{
  const value=input();
  const disabledFile='tests/disabled-postgres.test.ts';
  const pending={...nested,ancestorTitles:['disabled SQL'],title:'required SQL case',fullName:'disabled SQL required SQL case',status:'pending'};
  value.report.testResults.push({name:path.join(root,disabledFile),status:'passed',assertionResults:[pending]});
  value.report.numTotalTests++;value.report.numPendingTests++;
  value.capability='npm-checks';value.cases.push('npm-test','npm-check');
  assert.deepEqual(parse(value).counts,{total:3,passed:2,skipped:1,required:2,required_skipped:0});
  value.files.push(disabledFile);value.cases.push(pending.fullName);
  assert.throws(()=>parse(value),/required suite has skipped, todo, missing or failed cases/);
});
