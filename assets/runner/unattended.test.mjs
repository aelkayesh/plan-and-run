import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {writeCommandReport,secureStatePath} from './unattended.mjs';
import {redact} from './failure-report.mjs';
test('durable command JSON/text and human redactor remove credential URI and private fields',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'unattended report ')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const plan={root,stateDir:path.join(root,'.codex-plan-runner','report-fixture'),manifest:{plan_id:'report-fixture'}};
 const secret='synthetic-password-987654',uri='postgresql://fixture:'+secret+'@localhost/database';
 const report=writeCommandReport(plan,'blocked',{ready:false,selected:['06','07'],reason:'Bad URL '+uri,owner:'private-owner-token',authorization:'Bearer synthetic-private-token',nested:{password:secret}});
 for(const value of [JSON.stringify(report),fs.readFileSync(report.report_file,'utf8'),fs.readFileSync(report.report_file.replace('.json','.txt'),'utf8'),redact(uri)]){
  assert.ok(!value.includes(secret));assert.ok(!value.includes('private-owner-token'));assert.ok(!value.includes('synthetic-private-token'));
 }
 assert.deepEqual(report.selected,['06','07']);assert.equal(fs.statSync(report.report_file).mode&0o777,0o600);
});
test('command reports refuse late symlinked directories and preserve external sentinel',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'unattended report path '))),outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'unattended sentinel ')));
 t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
 fs.writeFileSync(path.join(outside,'sentinel'),'unchanged');fs.mkdirSync(path.join(root,'.codex-plan-runner'));
 fs.symlinkSync(outside,path.join(root,'.codex-plan-runner','fixture'));
 assert.throws(()=>writeCommandReport({root,stateDir:path.join(root,'.codex-plan-runner','fixture'),manifest:{plan_id:'fixture'}},'blocked',{}),/symlink/);
 assert.equal(fs.readFileSync(path.join(outside,'sentinel'),'utf8'),'unchanged');assert.equal(fs.readdirSync(outside).length,1);
 assert.throws(()=>secureStatePath(root,outside),/private runner state/);
});
