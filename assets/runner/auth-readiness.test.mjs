import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeLocalAuthentication, parseLocalAuthToml } from './auth-readiness.mjs';

function fixture(t, {config='',profileConfig,output='Logged in using ChatGPT',exit=0,delay=0}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-local-auth-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'home'),codexBin=path.join(root,'fake codex'),capture=path.join(root,'args.json');fs.mkdirSync(home);
  fs.writeFileSync(path.join(home,'config.toml'),config);
  if(profileConfig!==undefined)fs.writeFileSync(path.join(home,'chosen.config.toml'),profileConfig);
  fs.writeFileSync(codexBin,`#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));\nsetTimeout(()=>{console.error(${JSON.stringify(output)});process.exit(${exit});},${delay});\n`,{mode:0o700});
  const env={PATH:process.env.PATH,CODEX_HOME:home};
  return {root,home,codexBin,capture,env,systemConfig:path.join(root,'system.toml')};
}
test('fixed local login probe recognizes success without returning raw output or credentials',t=>{
  const f=fixture(t,{output:'Logged in using ChatGPT\nBearer abc-secret-value'}),r=probeLocalAuthentication(f);
  assert.equal(r.ready,true);assert.equal(r.remote_verified,false);assert.equal(r.method,'stored-chatgpt');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.capture)),['login','status']);
  assert.match(r.config_sha256,/^[a-f0-9]{64}$/);assert.match(r.executable.sha256,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(r).includes('abc-secret-value'));
});
test('zero exit with unknown login output does not establish readiness',t=>{
  const f=fixture(t,{output:'all good'}),r=probeLocalAuthentication(f);assert.equal(r.ready,false);assert.match(r.message,/did not confirm/);
});
test('nonzero login and potentially secret error text remain static and redacted',t=>{
  const f=fixture(t,{output:'api_key=sk-this-is-a-fake-sensitive-provider-value',exit:1}),r=probeLocalAuthentication(f);
  assert.equal(r.ready,false);assert.ok(!JSON.stringify(r).includes('sk-this'));
});
test('selected profile environment provider is verified instead of unrelated stored login',t=>{
  const f=fixture(t,{profileConfig:'model_provider="custom"\n[model_providers.custom]\nenv_key="LOCAL_PROVIDER_KEY"\n'});
  const missing=probeLocalAuthentication({...f,profile:'chosen'});assert.equal(missing.ready,false);assert.ok(!fs.existsSync(f.capture));
  const r=probeLocalAuthentication({...f,profile:'chosen',env:{...f.env,LOCAL_PROVIDER_KEY:'secret-value-never-printed'}});
  assert.equal(r.ready,true);assert.equal(r.provider,'custom');assert.equal(r.method,'environment-presence');assert.ok(!JSON.stringify(r).includes('secret-value'));
});
test('selected profile cannot be silently ignored and legacy table remains supported',t=>{
  const f=fixture(t,{config:'[profiles.legacy]\n'});
  assert.equal(probeLocalAuthentication({...f,profile:'missing'}).ready,false);
  assert.equal(probeLocalAuthentication({...f,profile:'legacy'}).ready,true);
});
test('profile auth storage is forwarded as fixed config arguments, never unsupported --profile',t=>{
  const f=fixture(t,{profileConfig:'cli_auth_credentials_store="file"\nforced_login_method="api"',output:'Logged in using an API key: sk-secret-value-that-is-never-returned'});
  const r=probeLocalAuthentication({...f,profile:'chosen'});assert.equal(r.ready,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.capture)),['login','status','-c','cli_auth_credentials_store="file"','-c','forced_login_method="api"']);
  assert.ok(!JSON.stringify(r).includes('sk-secret'));
});
test('forced login method mismatch is blocked',t=>{
  const f=fixture(t,{config:'forced_login_method="api"'});assert.equal(probeLocalAuthentication(f).ready,false);
});
test('repository provider override must have its own local credentials',t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.root,'.codex'));fs.writeFileSync(path.join(f.root,'.codex','config.toml'),'model_provider="repo"\n[model_providers.repo]\nenv_key="REPO_KEY"');
  assert.equal(probeLocalAuthentication(f).ready,false);assert.ok(!fs.existsSync(f.capture));
});
test('command-based authentication never executes a configured token refresher',t=>{
  const f=fixture(t,{config:'model_provider="remote"\n[model_providers.remote]\nauth={command="credential-refresh-helper",args=["--remote"]}'});
  const r=probeLocalAuthentication(f);assert.equal(r.ready,false);assert.match(r.message,/no supported fixed readiness adapter/);assert.ok(!fs.existsSync(f.capture));assert.ok(!JSON.stringify(r).includes('credential-refresh-helper'));
});
test('unknown provider and malformed configuration fail closed without parser/config contents',t=>{
  const f=fixture(t,{config:'model_provider="missing"'});assert.equal(probeLocalAuthentication(f).ready,false);
  fs.writeFileSync(path.join(f.home,'config.toml'),'secret="sk-my-secret-token\n');const r=probeLocalAuthentication(f);assert.equal(r.ready,false);assert.ok(!JSON.stringify(r).includes('sk-my'));
});
test('missing executable fails before login and timeout remains bounded',t=>{
  const f=fixture(t,{delay:5000});assert.equal(probeLocalAuthentication({...f,codexBin:path.join(f.root,'missing')}).ready,false);
  const start=Date.now(),r=probeLocalAuthentication({...f,timeoutMs:40});assert.equal(r.ready,false);assert.match(r.message,/timed out/);assert.ok(Date.now()-start<3000);
});
test('auth configuration and executable drift change public identity hashes',t=>{
  const f=fixture(t),a=probeLocalAuthentication(f);fs.appendFileSync(path.join(f.home,'config.toml'),'\n# a new comment');const b=probeLocalAuthentication(f);
  assert.notEqual(a.config_sha256,b.config_sha256);fs.appendFileSync(f.codexBin,'\n// executable changed');const c=probeLocalAuthentication(f);assert.notEqual(b.executable.sha256,c.executable.sha256);
});
test('multiline instructions, comments and quoted tables do not forge provider settings',()=>{
  const r=parseLocalAuthToml('developer_instructions="""\nmodel_provider="forged"\n[model_providers.forged]\nenv_key="SECRET"\n"""\n# model_provider="fake"\nmodel_provider="actual"\n[model_providers."actual"]\nenv_key="ACTUAL_KEY"\nargs=["one",\n"two"]\n');
  assert.equal(r.model_provider,'actual');assert.equal(r.model_providers.actual.env_key,'ACTUAL_KEY');assert.equal(r.model_providers.forged,undefined);assert.deepEqual(r.model_providers.actual.args,['one','two']);
});
test('TOML inline tables, literal values and unrelated array tables are handled without evaluation',()=>{
  const r=parseLocalAuthToml("model_provider='custom'\nmodel_providers={ custom={env_key='KEY'} }\n[[tools]]\nname='one'\n[[tools]]\nname='two'\n");
  assert.equal(r.model_providers.custom.env_key,'KEY');assert.equal(r._ignored_array_tables['1'].name,'two');
});
test('missing provider header environment cannot hide behind successful stored login',t=>{
  const f=fixture(t,{config:'[model_providers.openai.env_http_headers]\nX-Account="MISSING_ACCOUNT"'});
  assert.equal(probeLocalAuthentication(f).ready,false);assert.ok(!fs.existsSync(f.capture));
});
for (const config of ['model_provider=""','model_provider=false','model_providers=[]','model_providers={openai="invalid"}']) test(`invalid provider configuration never falls back to default login: ${config}`,t=>{
 const f=fixture(t,{config});assert.equal(probeLocalAuthentication(f).ready,false);assert.ok(!fs.existsSync(f.capture));
});

test('explicit file profile overrides base provider while ordinary repository settings remain supported',t=>{
  const f=fixture(t,{config:'model_provider="base"\n[model_providers.base]\nenv_key="BASE_KEY"',profileConfig:'model_provider="chosen"\n[model_providers.chosen]\nenv_key="CHOSEN_KEY"'});
  fs.mkdirSync(path.join(f.root,'.codex'));fs.writeFileSync(path.join(f.root,'.codex','config.toml'),'developer_instructions="repository instructions"');
  const r=probeLocalAuthentication({...f,profile:'chosen',env:{...f.env,CHOSEN_KEY:'synthetic-chosen-key'}});
  assert.equal(r.ready,true);assert.equal(r.profile,'chosen');assert.equal(r.provider,'chosen');assert.ok(!fs.existsSync(f.capture));
});
test('repository-selected default profile never falls through to unrelated stored login',t=>{
  const f=fixture(t,{profileConfig:'model_provider="chosen"\n[model_providers.chosen]\nenv_key="CHOSEN_KEY"'});
  fs.mkdirSync(path.join(f.root,'.codex'));fs.writeFileSync(path.join(f.root,'.codex','config.toml'),'profile="chosen"');
  const r=probeLocalAuthentication({...f,env:{...f.env,CHOSEN_KEY:'synthetic-chosen-key'}});
  assert.equal(r.ready,false);assert.match(r.message,/repository-specific/);assert.ok(!fs.existsSync(f.capture));
});
test('selected file profile plus repository auth override fails closed despite available credentials',t=>{
  const f=fixture(t,{profileConfig:'model_provider="chosen"\n[model_providers.chosen]\nenv_key="CHOSEN_KEY"'});
  fs.mkdirSync(path.join(f.root,'.codex'));fs.writeFileSync(path.join(f.root,'.codex','config.toml'),'model_provider="repository"\n[model_providers.repository]\nenv_key="REPO_KEY"');
  const r=probeLocalAuthentication({...f,profile:'chosen',env:{...f.env,CHOSEN_KEY:'synthetic-chosen-key',REPO_KEY:'synthetic-repo-key'}});
  assert.equal(r.ready,false);assert.match(r.message,/effective trust and precedence/);assert.ok(!fs.existsSync(f.capture));
});
test('legacy profile definitions in repository layers cannot supply unverifiable readiness',t=>{
  const f=fixture(t);
  fs.mkdirSync(path.join(f.root,'.codex'));fs.writeFileSync(path.join(f.root,'.codex','config.toml'),'[profiles.chosen]\nmodel_provider="repository"\n[model_providers.repository]\nenv_key="REPO_KEY"');
  const r=probeLocalAuthentication({...f,profile:'chosen',env:{...f.env,REPO_KEY:'synthetic-repo-key'}});
  assert.equal(r.ready,false);assert.match(r.message,/repository-specific/);assert.ok(!fs.existsSync(f.capture));
});
test('trusted and untrusted ancestor auth overrides both require established CLI config parity',t=>{
  const f=fixture(t),nested=path.join(f.root,'nested');fs.mkdirSync(nested);fs.mkdirSync(path.join(f.root,'.codex'));
  fs.writeFileSync(path.join(f.root,'.codex','config.toml'),'model_provider="repository"\n[model_providers.repository]\nenv_key="REPO_KEY"');
  for(const trust of ['trusted','untrusted']){
    fs.writeFileSync(path.join(f.home,'config.toml'),`[projects.${JSON.stringify(fs.realpathSync(f.root))}]\ntrust_level=${JSON.stringify(trust)}`);
    const r=probeLocalAuthentication({...f,root:nested,env:{...f.env,REPO_KEY:'synthetic-repo-key'}});
    assert.equal(r.ready,false);assert.match(r.message,/repository-specific/);assert.ok(!fs.existsSync(f.capture));
  }
});

const client='04b07795-8ddb-461a-bbee-02f9e1bf7b46',subscription='11111111-1111-1111-1111-111111111111';
function azureFixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'azure-auth-readonly-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'codex-home'),azure=path.join(root,'azure-home');fs.mkdirSync(home);fs.mkdirSync(azure);
 const marker=path.join(root,'executed'),az=path.join(root,'az'),codexBin=path.join(root,'codex');
 for(const file of [az,codexBin])fs.writeFileSync(file,`#!/bin/sh\nprintf invoked > '${marker}'\nexit 99\n`,{mode:0o700});
 const auth={command:az,args:['account','get-access-token','--resource','https://cognitiveservices.azure.com/','--subscription',subscription,'--query','accessToken','-o','tsv'],timeout_ms:1000,refresh_interval_ms:60000};
 const profile={subscriptions:[{id:subscription,state:'Enabled',environmentName:'AzureCloud',tenantId:'tenant-one',user:{type:'user',name:'person@example.test'}}]};
 const cache={Account:{one:{username:'person@example.test',home_account_id:'home-id',environment:'login.microsoftonline.com',realm:'different-guest-realm'}},RefreshToken:{one:{credential_type:'RefreshToken',home_account_id:'home-id',environment:'login.microsoftonline.com',client_id:client,secret:'synthetic-private-refresh-value'}}};
 const write=(name,value)=>fs.writeFileSync(path.join(azure,name),JSON.stringify(value),{mode:0o600});
 const configure=()=>fs.writeFileSync(path.join(home,'config.toml'),`model_provider="azure"\n[model_providers.azure]\nauth={command=${JSON.stringify(auth.command)},args=${JSON.stringify(auth.args)},timeout_ms=1000,refresh_interval_ms=60000}\n`);
 write('azureProfile.json',profile);write('msal_token_cache.json',cache);configure();
 const env={PATH:process.env.PATH,CODEX_HOME:home,AZURE_CONFIG_DIR:azure};
 const probe=()=>probeLocalAuthentication({root,codexBin,env,systemConfig:path.join(root,'system.toml')});
 assert.equal(probe().ready,true,'Every negative scenario starts from established matching local readiness.');
 return {root,home,azure,marker,az,auth,profile,cache,write,configure,env,probe};
}
test('Azure command auth reads matched local inputs without invoking helper or Codex',t=>{
 const f=azureFixture(t),before=fs.readFileSync(path.join(f.azure,'msal_token_cache.json')),result=f.probe();
 assert.equal(result.ready,true);assert.equal(result.method,'azure-cli-local-cache-presence');assert.equal(result.remote_verified,false);assert.equal(result.credential_validity,'unverified');assert.equal(result.credential_present,true);
 assert.equal(fs.existsSync(f.marker),false);assert.deepEqual(fs.readFileSync(path.join(f.azure,'msal_token_cache.json')),before);
 for(const secret of ['synthetic-private-refresh-value','person@example.test',subscription,'home-id'])assert.equal(JSON.stringify(result).includes(secret),false);
});
test('missing helper or cache fails without invoking the configured command',t=>{
 const f=azureFixture(t);fs.unlinkSync(f.az);assert.equal(f.probe().ready,false);fs.writeFileSync(f.az,'#!/bin/sh\nexit 99',{mode:0o700});fs.unlinkSync(path.join(f.azure,'msal_token_cache.json'));assert.equal(f.probe().ready,false);assert.equal(fs.existsSync(f.marker),false);
});
test('unknown command and extra command arguments remain unsupported',t=>{
 const f=azureFixture(t);f.auth.args.push('--debug');f.configure();assert.equal(f.probe().ready,false);f.auth.args.pop();f.auth.command='/bin/sh';f.configure();assert.equal(f.probe().ready,false);assert.equal(fs.existsSync(f.marker),false);
});
test('known Azure options may be reordered or use --output while duplicates fail closed',t=>{
 const f=azureFixture(t);
 f.auth.args=['account','get-access-token','--output','tsv','--query','accessToken','--subscription',subscription,'--resource','https://cognitiveservices.azure.com/'];f.configure();assert.equal(f.probe().ready,true);
 f.auth.args=['account','get-access-token','-o','tsv','--output','tsv','--subscription',subscription,'--resource','https://cognitiveservices.azure.com/'];f.configure();assert.equal(f.probe().ready,false);assert.equal(fs.existsSync(f.marker),false);
});
test('invalid resource cannot establish Azure readiness',t=>{
 const f=azureFixture(t),original=[...f.auth.args];
 for(const value of ['http://example.test/','https://user:pass@example.test/','https://example.test/?key=synthetic-private-value','invalid-url']){
  f.auth.args=[...original];f.auth.args[3]=value;f.configure();const r=f.probe();assert.equal(r.ready,false);assert.equal(JSON.stringify(r).includes('synthetic-private-value'),false);
 }
 assert.equal(fs.existsSync(f.marker),false);
});
test('other subscription, username, home-account, environment or client cannot supply readiness',t=>{
 const f=azureFixture(t),original=structuredClone(f.cache);
 for(const mutate of [c=>c.Account.one.username='other@example.test',c=>c.RefreshToken.one.home_account_id='other',c=>c.RefreshToken.one.environment='elsewhere',c=>c.RefreshToken.one.client_id='wrong',c=>c.RefreshToken.one.secret='']){
  const cache=structuredClone(original);mutate(cache);f.write('msal_token_cache.json',cache);assert.equal(f.probe().ready,false);
 }
 f.write('msal_token_cache.json',original);f.profile.subscriptions[0].id='22222222-2222-2222-2222-222222222222';f.write('azureProfile.json',f.profile);assert.equal(f.probe().ready,false);
});
test('ambiguous account/subscription and service principals are not silently adopted',t=>{
 const f=azureFixture(t);f.cache.Account.two={...f.cache.Account.one};f.write('msal_token_cache.json',f.cache);assert.equal(f.probe().ready,false);delete f.cache.Account.two;f.write('msal_token_cache.json',f.cache);
 f.profile.subscriptions.push({...f.profile.subscriptions[0]});f.write('azureProfile.json',f.profile);assert.equal(f.probe().ready,false);f.profile.subscriptions.pop();f.profile.subscriptions[0].user.type='servicePrincipal';f.write('azureProfile.json',f.profile);assert.equal(f.probe().ready,false);
});
test('encrypted cache and customized cloud settings cannot hide behind stale JSON',t=>{
 const f=azureFixture(t);f.env.AZURE_CORE_ENCRYPT_TOKEN_CACHE='true';assert.equal(f.probe().ready,false);delete f.env.AZURE_CORE_ENCRYPT_TOKEN_CACHE;
 fs.writeFileSync(path.join(f.azure,'config'),'[cloud]\nname=AzureChinaCloud\n');assert.equal(f.probe().ready,false);fs.writeFileSync(path.join(f.azure,'config'),'[cloud]\nname=AzureCloud\n');
 fs.writeFileSync(path.join(f.azure,'clouds.config'),'[AzureCloud]\nendpoint_active_directory=https://custom.invalid\n');assert.equal(f.probe().ready,false);
});
test('symlinked or malformed caches fail with static messages and no token output',t=>{
 const f=azureFixture(t),cache=path.join(f.azure,'msal_token_cache.json'),saved=path.join(f.azure,'other.json');fs.renameSync(cache,saved);fs.symlinkSync(saved,cache);assert.equal(f.probe().ready,false);fs.unlinkSync(cache);fs.writeFileSync(cache,'synthetic-private-refresh-value');const result=f.probe();assert.equal(result.ready,false);assert.equal(JSON.stringify(result).includes('synthetic-private-refresh-value'),false);
});
test('symlinked directory, linked cache, oversized and missing account files are refused',t=>{
 const f=azureFixture(t),cache=path.join(f.azure,'msal_token_cache.json'),link=path.join(f.root,'linked-azure');
 fs.symlinkSync(f.azure,link);f.env.AZURE_CONFIG_DIR=link;assert.equal(f.probe().ready,false);f.env.AZURE_CONFIG_DIR=f.azure;
 const hardlink=path.join(f.root,'linked-cache');fs.linkSync(cache,hardlink);assert.equal(f.probe().ready,false);fs.unlinkSync(hardlink);
 fs.truncateSync(cache,16*1024*1024+1);assert.equal(f.probe().ready,false);f.write('msal_token_cache.json',f.cache);
 fs.unlinkSync(path.join(f.azure,'azureProfile.json'));assert.equal(f.probe().ready,false);assert.equal(fs.existsSync(f.marker),false);
});
test('config/helper/cache drift produces new presence identities without mutating cache',t=>{
 const f=azureFixture(t),a=f.probe();fs.appendFileSync(f.az,'\n# drift');const b=f.probe();assert.notEqual(a.helper.sha256,b.helper.sha256);f.cache.RefreshToken.one.secret='new-private-refresh-value';f.write('msal_token_cache.json',f.cache);const c=f.probe();assert.notEqual(b.local_inputs_sha256,c.local_inputs_sha256);assert.equal(JSON.stringify(c).includes('new-private-refresh-value'),false);assert.equal(fs.existsSync(f.marker),false);
});
