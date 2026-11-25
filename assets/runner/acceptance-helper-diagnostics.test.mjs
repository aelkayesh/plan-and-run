import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {runAcceptanceGate,verifyAcceptanceGate,preflightAcceptanceCapabilities,acceptanceEnvironment,validateGateInputs,parseAcceptanceReport,verifyAcceptanceEvidenceArtifacts,reapOwnedAcceptanceGroup} from './acceptance-adapters.mjs';
const planHash='a'.repeat(64);
const packageId='06';
const gate={id:'npm',capability:'npm-checks'};
const mapping={gate_id:'npm',files:['tests/required.test.ts'],cases:['required passes','npm-test','npm-check']};
const fakeNpm=`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),config=JSON.parse(fs.readFileSync('fixture.json','utf8'));
if(config.hang){setInterval(()=>{},1000);}else if(args[0]==='test'){
 if(config.sourceMutation)fs.appendFileSync(config.sourceMutation,'// concurrent source edit');
 const file=args.find(x=>x.startsWith('--outputFile=')).slice('--outputFile='.length);
 const status=config.skipped?'pending':config.failed?'failed':'passed';
 if(config.suiteError){fs.writeFileSync(file,JSON.stringify({success:false,numFailedTestSuites:1,numTotalTests:0,numPassedTests:0,numFailedTests:0,numPendingTests:0,numTodoTests:0,testResults:[{name:path.join(process.cwd(),'tests/required.test.ts'),status:'failed',message:'PDF extractor unavailable: spawn /isolated/.venv/bin/python ENOENT Bearer PRIVATE-HELPER-RESPONSE',assertionResults:[]}]}));process.exit(1);}
 fs.writeFileSync(file,JSON.stringify({success:!config.failed,numFailedTestSuites:config.failed?1:0,numTotalTests:1,numPassedTests:status==='passed'?1:0,numFailedTests:config.failed?1:0,numPendingTests:config.skipped?1:0,numTodoTests:0,testResults:[{name:path.join(process.cwd(),'tests/required.test.ts'),status:config.failed?'failed':'passed',assertionResults:[{fullName:'required passes',status,failureMessages:config.failed?['assertion required passes']:[]}]}]}));
 process.exitCode=config.failed?1:0;
}else if(args[0]==='run'&&args[1]==='check'){}else if(args[0]==='run'&&args[1]==='build'){
 fs.mkdirSync('.next',{recursive:true});for(const name of ['BUILD_ID','build-manifest.json','routes-manifest.json','prerender-manifest.json'])fs.writeFileSync('.next/'+name,'synthetic-build');
}else throw new Error('Unexpected fake npm command');
`;
const fakeVitest=`import fs from 'node:fs';import path from 'node:path';const args=process.argv.slice(2);if(args[0]!=='list')throw new Error('collection only');const config=JSON.parse(fs.readFileSync('fixture.json','utf8'));fs.writeFileSync(args[args.indexOf('--json')+1],JSON.stringify(config.skipped?[]:[{name:'required passes',file:path.join(process.cwd(),'tests/required.test.ts')}]))`;
function fixture(t,config={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'acceptance-adapter-')));
 for(const name of ['bin','tests','node_modules/vitest','node_modules/typescript/bin','node_modules/next/dist/bin'])fs.mkdirSync(path.join(root,name),{recursive:true});
 fs.writeFileSync(path.join(root,'.gitignore'),'.codex-plan-runner/\nnode_modules/\n');
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{test:'vitest run',check:'tsc --noEmit',build:'next build'}}));
 fs.writeFileSync(path.join(root,'fixture.json'),JSON.stringify(config));
 fs.writeFileSync(path.join(root,'tests/required.test.ts'),'// synthetic assertion fixture\n');
 fs.writeFileSync(path.join(root,'node_modules/vitest/vitest.mjs'),fakeVitest);
 fs.writeFileSync(path.join(root,'node_modules/typescript/bin/tsc'),'// installed synthetic typechecker');
 fs.writeFileSync(path.join(root,'node_modules/next/dist/bin/next'),'// installed synthetic entrypoint');
 fs.writeFileSync(path.join(root,'bin/npm'),fakeNpm,{mode:0o700});
 execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','add','.']);execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
 const prior=process.env.PATH;process.env.PATH=path.join(root,'bin')+path.delimiter+prior;
 t.after(()=>{process.env.PATH=prior;fs.rmSync(root,{recursive:true,force:true});});
 return {root,packageId,planHash,gate,mapping,outputDir:path.join(root,'.codex-plan-runner','test',randomUUID())};
}
test('actual isolated helper retains suite startup failure when no assertion runs',async t=>{
 const input=fixture(t,{suiteError:true});
 const result=await runAcceptanceGate(input);
 assert.equal(result.evidence.passed,false);
 assert.equal(result.evidence.cleanup_verified,true);
 assert.equal(result.evidence.source_unchanged,true);
 assert.equal(fs.existsSync(result.evidence.checkout),false);
 assert.deepEqual(result.evidence.failure_ids,['npm-test','suite:tests/required.test.ts']);
 assert.deepEqual(result.evidence.failed_suites,[{file:'tests/required.test.ts',failed_cases:0,error_codes:['ENOENT'],error_types:[]}]);
 assert.doesNotMatch(JSON.stringify({failure_ids:result.evidence.failure_ids,failed_suites:result.evidence.failed_suites}),/PRIVATE-HELPER-RESPONSE|Bearer|PDF extractor/);
 assert.equal(result.evidence.checks.find(check=>check.id==='npm-test').exit_code,1);
 assert.equal(verifyAcceptanceGate({...input,file:result.file}).evidence.passed,false);
});
