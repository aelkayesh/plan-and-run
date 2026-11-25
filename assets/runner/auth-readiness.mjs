import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const hash = value => createHash('sha256').update(value).digest('hex');
const ownObject = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const check = (value, message = 'Local authentication configuration cannot be resolved safely.') => { if (!value) throw new Error(message); };

// A bounded TOML reader for local auth configuration. It never evaluates a
// value or runs an auth command. Unsupported syntax fails closed rather than
// falling back to the default account. Strings/comments are lexed before
// looking at keys so provider-looking text inside prompts is never a setting.
function split(text, delimiter) {
  const items = []; let start = 0, quote = null, triple = false, escaped = false, depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && escaped) { escaped = false; continue; }
      if (quote === '"' && c === '\\') { escaped = true; continue; }
      if (c === quote && (!triple || text.slice(i, i + 3) === quote.repeat(3))) { if (triple) i += 2; quote = null; triple = false; }
      continue;
    }
    if (c === '"' || c === "'") { quote = c; triple = text.slice(i, i + 3) === c.repeat(3); if (triple) i += 2; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') { depth--; check(depth >= 0); }
    if (depth === 0 && c === delimiter) { items.push(text.slice(start, i)); start = i + 1; }
  }
  check(!quote && depth === 0);
  items.push(text.slice(start)); return items;
}
function withoutComments(text) {
  let result = '', quote = null, triple = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      result += c;
      if (quote === '"' && escaped) { escaped = false; continue; }
      if (quote === '"' && c === '\\') { escaped = true; continue; }
      if (c === quote && (!triple || text.slice(i, i + 3) === quote.repeat(3))) { if (triple) { result += text.slice(i + 1, i + 3); i += 2; } quote = null; triple = false; }
      continue;
    }
    if (c === '"' || c === "'") { quote = c; triple = text.slice(i, i + 3) === c.repeat(3); result += c; if (triple) { result += text.slice(i + 1, i + 3); i += 2; } continue; }
    if (c === '#') { while (i + 1 < text.length && text[i + 1] !== '\n') i++; continue; }
    result += c;
  }
  check(!quote); return result;
}
function stringValue(text) {
  const q = text[0], triple = text.startsWith(q.repeat(3));
  check((q === '"' || q === "'") && text.endsWith(triple ? q.repeat(3) : q));
  let value = text.slice(triple ? 3 : 1, triple ? -3 : -1);
  if (triple && value.startsWith('\n')) value = value.slice(1);
  if (q === "'") return value;
  value = value.replace(/\\\r?\n[ \t\r\n]*/g, '');
  return value.replace(/\\(u[\da-fA-F]{4}|U[\da-fA-F]{8}|[btnfr"\\])/g, (_, escape) => {
    if (escape[0] === 'u' || escape[0] === 'U') return String.fromCodePoint(parseInt(escape.slice(1), 16));
    return ({ b:'\b', t:'\t', n:'\n', f:'\f', r:'\r', '"':'"', '\\':'\\' })[escape];
  });
}
function keys(text) {
  const result = split(text, '.').map(part => {
    part = part.trim();
    if (part[0] === '"' || part[0] === "'") return stringValue(part);
    check(/^[\w-]+$/.test(part)); return part;
  });
  check(result.length && result.every(key => key && !['__proto__','constructor','prototype'].includes(key)));
  return result;
}
function assignment(text) {
  const parts = split(text, '='); check(parts.length >= 2);
  return [keys(parts.shift().trim()), value(parts.join('=').trim())];
}
function put(target, parts, item) {
  for (const part of parts.slice(0, -1)) { target[part] ??= Object.create(null); check(ownObject(target[part])); target = target[part]; }
  check(!Object.hasOwn(target, parts.at(-1))); target[parts.at(-1)] = item;
}
function value(text) {
  if (text[0] === '"' || text[0] === "'") return stringValue(text);
  if (text === 'true' || text === 'false') return text === 'true';
  if (text.startsWith('[')) { check(text.endsWith(']')); return split(text.slice(1, -1), ',').filter(x => x.trim()).map(x => value(x.trim())); }
  if (text.startsWith('{')) { check(text.endsWith('}')); const result = Object.create(null); for (const item of split(text.slice(1, -1), ',').filter(x => x.trim())) { const [parts, v] = assignment(item); put(result, parts, v); } return result; }
  check(/^[+\-\w.: ]+$/.test(text) && text.trim());
  return /^[+-]?\d[\d_]*$/.test(text) ? Number(text.replaceAll('_', '')) : text;
}
export function parseLocalAuthToml(text) {
  check(typeof text === 'string' && text.length <= 1024 * 1024);
  const result = Object.create(null); let table = [], arrayIndex = 0;
  for (const line of split(withoutComments(text), '\n').map(x => x.trim()).filter(Boolean)) {
    if (line.startsWith('[[')) {
      // Array tables are irrelevant to auth but must not absorb later keys.
      check(line.endsWith(']]')); const parts = keys(line.slice(2, -2));
      check(!['model_providers','profiles'].includes(parts[0])); table = ['_ignored_array_tables', String(arrayIndex++)]; continue;
    }
    if (line[0] === '[') {
      check(line.endsWith(']')); table = keys(line.slice(1, -1));
      let current = result; for (const part of table) { current[part] ??= Object.create(null); check(ownObject(current[part])); current = current[part]; }
      continue;
    }
    const [parts, v] = assignment(line); put(result, [...table, ...parts], v);
  }
  return result;
}
function merge(a, b) {
  const result = Object.assign(Object.create(null), a);
  for (const [key, v] of Object.entries(b)) result[key] = ownObject(v) && ownObject(result[key]) ? merge(result[key], v) : v;
  return result;
}
function executableIdentity(bin, root, env) {
  check(typeof bin === 'string' && bin && !bin.includes('\0'), 'A Codex executable is required for local authentication preflight.');
  const candidates = bin.includes(path.sep) ? [path.resolve(root, bin)] : (env.PATH || '').split(path.delimiter).map(dir => path.resolve(dir, bin));
  for (const file of candidates) {
    try { fs.accessSync(file, fs.constants.X_OK); if (!fs.statSync(file).isFile()) continue; const resolved = fs.realpathSync(file); return {path:resolved,sha256:hash(fs.readFileSync(resolved))}; } catch {}
  }
  throw new Error('The selected Codex executable is unavailable; install or select it outside this runner before retrying.');
}
function localConfiguration({root,profile,env,systemConfig}) {
  const home = path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const inventory = [], read = file => {
    const stat = fs.statSync(file, {throwIfNoEntry:false});
    if (!stat) { inventory.push({file,sha256:null}); return Object.create(null); }
    check(stat.isFile() && stat.size <= 1024 * 1024);
    const text = fs.readFileSync(file,'utf8'); inventory.push({file,sha256:hash(text)}); return parseLocalAuthToml(text);
  };
  const base = merge(read(systemConfig || '/etc/codex/config.toml'), read(path.join(home,'config.toml')));
  // Discover all repository layers before resolving a default/legacy profile.
  // File profiles layer over user configuration; legacy profile tables select
  // from the merged configuration. Never silently report a pre-repository
  // profile when a later layer changes its selection or authentication.
  const directories = []; let current = root;
  while (true) { directories.unshift(current); if (path.dirname(current) === current) break; current = path.dirname(current); }
  const layers = [];
  for (const directory of directories) {
    const file = path.join(directory,'.codex','config.toml');
    if (file !== path.join(home,'config.toml')) layers.push(read(file));
  }
  const merged = layers.reduce(merge, base);
  const selected = profile !== undefined ? profile : merged.profile;
  let config = base;
  if (selected !== undefined) {
    check(identifier(selected), 'The selected profile name cannot be resolved safely by local authentication preflight.');
    const file = path.join(home, `${selected}.config.toml`);
    const exists = fs.existsSync(file), layer = read(file);
    if (exists) config = layers.reduce(merge, merge(base, layer));
    else {
      check(ownObject(merged.profiles?.[selected]), 'The selected local profile is missing; preserve the selected profile and repair its configuration before retrying.');
      config = merge(merged, merged.profiles[selected]);
    }
  } else config = merged;
  // CLI versions differ in repository trust and profile support. Presence in a
  // repository file must never establish readiness for credentials that the
  // selected CLI may ignore. Auth-sensitive repository settings therefore
  // require separately reviewed effective-config parity; ordinary repository
  // instructions/sandbox settings do not affect this local auth probe.
  const authKeys = ['profile','profiles','model_provider','model_providers','cli_auth_credentials_store','forced_login_method'];
  check(!layers.some(layer => authKeys.some(key => Object.hasOwn(layer,key))),
    'Local authentication configuration has repository-specific provider or profile settings whose effective trust and precedence cannot be verified safely. Preserve the configuration and inspect it with the selected CLI before retrying.');
  return {config,profile:selected || null,config_sha256:hash(JSON.stringify(inventory))};
}

const AZURE_CLI_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const azureFailure = 'Local Azure CLI credential presence could not be established. Preserve the existing provider and inspect its local login/cache outside this runner.';
const guid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const present = value => typeof value === 'string' && value.trim().length > 0;

function localAzureFile(directory, name, maximum, optional = false) {
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file, {throwIfNoEntry:false});
  if (!stat && optional) return {text:'',sha256:null};
  check(stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maximum, azureFailure);
  const text = fs.readFileSync(file, 'utf8');
  return {text:text.replace(/^\uFEFF/,''),sha256:hash(text)};
}
function azureSettings(text) {
  const settings = Object.create(null); let section = '';
  for (const original of text.split(/\r?\n/)) {
    const line = original.trim(); if (!line || /^[#;]/.test(line)) continue;
    if (line.startsWith('[')) { check(/^\[[\w.-]+\]$/.test(line),azureFailure); section=line.slice(1,-1).toLowerCase(); continue; }
    const match = /^([\w.-]+)\s*=\s*(.*)$/.exec(line); check(match && section,azureFailure);
    const key=section+'.'+match[1].toLowerCase(); check(!Object.hasOwn(settings,key),azureFailure); settings[key]=match[2].trim();
  }
  return settings;
}

// Fixed read-only adapter for the configured Azure CLI user-token mechanism.
// It never invokes az/get-access-token, decrypts a store, writes a cache, refreshes
// credentials, or checks remote permission. A refresh credential may be expired
// or revoked: ready here means matching local inputs exist, not token validity.
function probeAzureCliCommandAuthentication({auth,root,env=process.env}) {
  check(ownObject(auth) && Object.keys(auth).every(key => ['command','args','timeout_ms','refresh_interval_ms'].includes(key)),
    'Local command authentication has no supported fixed readiness adapter. Preserve its configuration; do not execute arbitrary auth commands for preflight.');
  check(typeof auth.command === 'string' && path.basename(auth.command) === 'az' && !/\s/.test(auth.command),
    'Local command authentication has no supported fixed readiness adapter. Preserve its configuration; do not execute arbitrary auth commands for preflight.');
  check(Array.isArray(auth.args) && auth.args.length === 10 && auth.args.every(x=>typeof x==='string')
    && auth.args[0] === 'account' && auth.args[1] === 'get-access-token', azureFailure);
  const options=Object.create(null);
  for(let i=2;i<auth.args.length;i+=2){
    const key=auth.args[i]; check(['--resource','--subscription','--query','-o','--output'].includes(key),azureFailure);
    const normalized=key==='--output'?'-o':key;check(!Object.hasOwn(options,normalized),azureFailure);options[normalized]=auth.args[i+1];
  }
  check(Object.keys(options).length===4 && options['--query']==='accessToken' && options['-o']==='tsv' && guid(options['--subscription']),azureFailure);
  const resource=new URL(options['--resource']);check(resource.protocol==='https:' && !resource.username && !resource.password && !resource.search && !resource.hash,azureFailure);
  for(const key of ['timeout_ms','refresh_interval_ms']) if(auth[key]!==undefined)check(Number.isSafeInteger(auth[key]) && auth[key]>0,azureFailure);
  let helper;
  try { helper=executableIdentity(auth.command,root,env); } catch { throw new Error(azureFailure); }
  const configuredDirectory=path.resolve(root,env.AZURE_CONFIG_DIR || path.join(os.homedir(),'.azure'));
  check(fs.lstatSync(configuredDirectory).isDirectory(),azureFailure);
  // Canonicalize platform aliases such as macOS /var -> /private/var, while
  // refusing an explicitly symlinked cache directory or credential file.
  const directory=fs.realpathSync(configuredDirectory);
  const configFile=localAzureFile(directory,'config',1024*1024,true),cloudFile=localAzureFile(directory,'clouds.config',1024*1024,true);
  const settings=azureSettings(configFile.text),clouds=azureSettings(cloudFile.text);
  const encrypt=env.AZURE_CORE_ENCRYPT_TOKEN_CACHE ?? settings['core.encrypt_token_cache'] ?? (process.platform==='win32'?'true':'false');
  check(['false','no','0'].includes(String(encrypt).toLowerCase()),'Local Azure CLI encrypted credential stores require a separately reviewed local-only adapter. No store was decrypted or authentication command executed.');
  check((env.AZURE_CLOUD_NAME ?? settings['cloud.name'] ?? 'AzureCloud') === 'AzureCloud',azureFailure);
  check(!Object.keys(clouds).some(key=>key.startsWith('azurecloud.endpoint_')), 'Local Azure CLI customized cloud endpoints require a separately reviewed local-only adapter.');
  const profileFile=localAzureFile(directory,'azureProfile.json',4*1024*1024),cacheFile=localAzureFile(directory,'msal_token_cache.json',16*1024*1024);
  const profile=JSON.parse(profileFile.text),cache=JSON.parse(cacheFile.text);
  check(Array.isArray(profile.subscriptions) && ownObject(cache.Account) && ownObject(cache.RefreshToken),azureFailure);
  const subscriptions=profile.subscriptions.filter(s=>ownObject(s) && typeof s.id==='string' && s.id.toLowerCase()===options['--subscription'].toLowerCase());
  check(subscriptions.length===1,azureFailure);const subscription=subscriptions[0];
  check(subscription.environmentName==='AzureCloud' && subscription.state==='Enabled'
    && ownObject(subscription.user) && subscription.user.type==='user' && present(subscription.user.name),azureFailure);
  // Azure CLI UserCredential.get_accounts(username) intentionally permits a
  // different cached realm; guests/home-account flows are not tenant equality.
  const accounts=Object.values(cache.Account).filter(a=>ownObject(a) && present(a.username)
    && a.username.toLowerCase()===subscription.user.name.toLowerCase()
    && ['login.microsoftonline.com','login.windows.net'].includes(a.environment));
  check(accounts.length===1 && present(accounts[0].home_account_id),azureFailure);const account=accounts[0];
  const credential=Object.values(cache.RefreshToken).some(t=>ownObject(t) && t.credential_type==='RefreshToken'
    && t.home_account_id===account.home_account_id && t.environment===account.environment
    && t.client_id===AZURE_CLI_CLIENT_ID && present(t.secret));
  check(credential,azureFailure);
  return {ready:true,method:'azure-cli-local-cache-presence',readiness_scope:'configured-helper-and-matching-local-credential-presence',
    credential_present:true,credential_validity:'unverified',remote_verified:false,helper,
    local_inputs_sha256:hash(JSON.stringify([configFile.sha256,cloudFile.sha256,profileFile.sha256,cacheFile.sha256])),
    message:'The configured Azure CLI helper and a matching local user credential are present. Token validity and remote authorization are unverified; no authentication command or refresh ran.',
    next_action:'Continue with the unchanged selected provider; any remote authentication failure remains an explicit blocker.'};
}

/** Local presence/readiness only. It never proves remote permission, refreshes
 * tokens, invokes inference, prints configuration, or executes auth commands. */
export function probeLocalAuthentication({codexBin='codex',profile,root=process.cwd(),timeoutMs=10000,env=process.env,systemConfig} = {}) {
  const base = {schema_version:1,kind:'local-authentication',ready:false,remote_verified:false};
  try {
    root = fs.realpathSync(root);
    check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, 'Invalid local authentication probe timeout.');
    base.executable = executableIdentity(codexBin, root, env);
    const resolved = localConfiguration({root,profile,env,systemConfig});
    base.profile = resolved.profile; base.config_sha256 = resolved.config_sha256;
    const config = resolved.config, provider = config.model_provider ?? 'openai';
    check(identifier(provider), 'The selected provider identity is unsupported by local authentication preflight.'); base.provider = provider;
    check(config.model_providers === undefined || ownObject(config.model_providers));
    const definition = config.model_providers?.[provider];
    check((provider === 'openai' && definition === undefined) || ownObject(definition), 'The selected provider definition is missing or invalid; preserve the selected provider and repair its configuration.');
    if (definition?.env_http_headers) {
      check(ownObject(definition.env_http_headers));
      for (const key of Object.values(definition.env_http_headers)) {
        check(typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
        check(typeof env[key] === 'string' && env[key].trim(), 'The selected provider header environment variable is absent or empty. Restore it through the existing credential mechanism before retrying.');
      }
    }
    if (definition?.auth) {
      return {...base,...probeAzureCliCommandAuthentication({auth:definition.auth,root,env})};
    }
    if (definition?.env_key) {
      check(typeof definition.env_key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(definition.env_key));
      check(typeof env[definition.env_key] === 'string' && env[definition.env_key].trim(), 'The selected provider credential environment variable is absent or empty. Restore it through the existing credential mechanism before retrying.');
      return {...base,ready:true,method:'environment-presence',message:'The selected provider credential is present locally; remote authorization is unverified.',next_action:'Continue with the selected provider.'};
    }
    if (definition?.experimental_bearer_token) {
      check(typeof definition.experimental_bearer_token === 'string' && definition.experimental_bearer_token.trim());
      return {...base,ready:true,method:'configured-credential-presence',message:'The selected provider credential is configured locally; remote authorization is unverified.',next_action:'Continue with the selected provider.'};
    }
    check(provider === 'openai' || definition?.requires_openai_auth === true,
      'The selected provider has no supported local credential readiness probe. Preserve its configuration and implement a reviewed local-only probe before launch.');
    const args = ['login','status'];
    for (const [key, allowed] of [['cli_auth_credentials_store',['file','keyring','auto']],['forced_login_method',['chatgpt','api']]]) {
      if (config[key] === undefined) continue;
      check(allowed.includes(config[key]), 'The selected profile uses an unsupported local authentication storage or login method.'); args.push('-c',`${key}=${JSON.stringify(config[key])}`);
    }
    // --profile is rejected by login status on current Codex. Only the resolved
    // local auth storage/method settings are forwarded; no provider is changed.
    const result = spawnSync(base.executable.path,args,{cwd:root,env,encoding:'utf8',input:'',timeout:timeoutMs,maxBuffer:256*1024,stdio:['pipe','pipe','pipe']});
    check(!result.error && result.status === 0,
      result.error?.code === 'ETIMEDOUT' ? 'Local Codex login status timed out; inspect local authentication before retrying.' : 'Local Codex login status failed; inspect the selected authentication and CLI configuration before retrying.');
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    const method = /Logged in using ChatGPT/i.test(output) ? 'chatgpt' : /Logged in using (?:an? )?API key/i.test(output) ? 'api' : null;
    check(method && (!config.forced_login_method || config.forced_login_method === method), 'Local Codex login status did not confirm the selected authentication method.');
    return {...base,ready:true,method:`stored-${method}`,message:'Codex confirms local stored authentication; remote authorization is unverified.',next_action:'Continue with the selected provider.'};
  } catch (error) {
    // All expected messages are static. Never expose a parser fragment, raw
    // child output, exception path, env value, or credential-bearing config.
    const message = error.message.startsWith('Local ') || error.message.startsWith('The selected ') || error.message.startsWith('A Codex ') || error.message.startsWith('Invalid local ') ? error.message : 'Local authentication configuration could not be read safely.';
    return {...base,message,next_action:message};
  }
}
