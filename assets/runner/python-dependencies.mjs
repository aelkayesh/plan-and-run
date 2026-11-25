import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const fail = message => { throw new Error(`Installed Python prerequisite unavailable: ${message}`); };
const within = (root, file) => file === root || file.startsWith(root + path.sep);
const ENCODINGS = Object.freeze([
  { name: 'o200k_base', url: 'https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken', sha256: '446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d' },
]);

// These are existing project dependency declarations, not a new host recipe.
// Parse only local requirements and package/version names; never invoke pip or
// execute requirement-file options, URLs, editable projects or marker code.
export function declaredPythonRequirements(root) {
  const files = [], packages = new Map(), visited = new Set();
  const read = relative => {
    if (visited.has(relative)) return;
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) fail('requirements include must be a canonical repository file');
    const file = path.join(root, relative), stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || !within(root, fs.realpathSync(file)) || stat.size > 1024 * 1024) fail(`invalid requirements file ${relative}`);
    visited.add(relative);
    const bytes = fs.readFileSync(file); files.push({ file: relative, sha256: hash(bytes) });
    for (const original of bytes.toString('utf8').split(/\r?\n/)) {
      const line = original.replace(/\s+#.*$/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const include = line.match(/^(?:-r\s+|--requirement(?:=|\s+))([^\s]+)$/);
      if (include) { read(path.posix.join(path.posix.dirname(relative), include[1])); continue; }
      const pkg = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9_,.-]+\])?(?:==([A-Za-z0-9][A-Za-z0-9.!+_-]*))?$/);
      if (!pkg) fail(`unsupported dependency declaration in ${relative}; only local includes and exact package pins are supported`);
      const name = pkg[1].toLowerCase().replace(/[-_.]+/g, '-'), version = pkg[2] || null;
      if (packages.has(name) && packages.get(name) !== version) fail(`conflicting requirement for ${name}`);
      packages.set(name, version);
    }
  };
  for (const relative of ['requirements.txt', 'requirements-protocol.txt']) if (fs.existsSync(path.join(root, relative))) read(relative);
  if (!files.length) return null;
  return { files: files.sort((a,b) => a.file.localeCompare(b.file)), packages: [...packages].sort(([a],[b]) => a.localeCompare(b)).map(([name,version]) => ({name,version})) };
}

function regularFile(file, label) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label} must be an existing regular file`);
  return { file, sha256: hash(fs.readFileSync(file)) };
}
function tokenizerCache(requirements, environment) {
  if (!requirements.packages.some(p => p.name === 'tiktoken')) return null;
  const directory = environment.TIKTOKEN_CACHE_DIR ?? environment.DATA_GYM_CACHE_DIR ?? path.join(os.tmpdir(), 'data-gym-cache');
  if (!directory || !path.isAbsolute(directory)) fail('tokenizer cache must be an existing absolute local directory; downloads are disabled');
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('local tokenizer cache is missing; downloads are disabled');
  const canonical = fs.realpathSync(directory);
  return { directory: canonical, files: ENCODINGS.map(encoding => {
    const filename = createHash('sha1').update(encoding.url).digest('hex');
    const item = regularFile(path.join(canonical, filename), `cached tokenizer ${encoding.name}`);
    if (item.sha256 !== encoding.sha256) fail(`cached tokenizer ${encoding.name} has an unexpected hash; downloads are disabled`);
    return { name: encoding.name, filename, sha256: item.sha256 };
  }) };
}

const PROBE = String.raw`import sys, json, os, site, platform, importlib.metadata
request = json.load(sys.stdin)
def audit(event, args):
    if event in ('socket.connect', 'socket.connect_ex', 'socket.getaddrinfo', 'subprocess.Popen', 'os.system', 'os.remove', 'os.rename', 'os.mkdir', 'os.rmdir'):
        raise RuntimeError('offline read-only prerequisite probe')
    if event == 'open':
        mode = args[1]
        if (isinstance(mode, str) and any(c in mode for c in 'wax+')) or (len(args) > 2 and isinstance(args[2], int) and args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)):
            raise RuntimeError('read-only prerequisite probe')
sys.addaudithook(audit)
try:
    versions = []
    for item in request['packages']:
        name = item['name']
        version = importlib.metadata.version(name)
        if item['version'] is not None and version != item['version']:
            print(json.dumps({'error': 'version-mismatch', 'package': name})); sys.exit(2)
        versions.append({'name': name, 'version': version})
    names = {item['name'] for item in request['packages']}
    if 'pymupdf' in names:
        import pymupdf
    encodings = []
    if 'tiktoken' in names:
        import tiktoken
        for name in ('o200k_base',):
            assert len(tiktoken.get_encoding(name).encode('local acceptance prerequisite', disallowed_special=())) > 0
            encodings.append(name)
    print(json.dumps({'version': platform.python_version(), 'machine': platform.machine(), 'executable': sys.executable, 'prefix': sys.prefix, 'base_prefix': sys.base_prefix, 'sites': site.getsitepackages(), 'packages': versions, 'encodings': encodings}))
except Exception:
    print(json.dumps({'error': 'module-or-cache-unavailable'})); sys.exit(2)
`;

function dependencyInventory(directories) {
  const files = [], visited = new Set();
  const walk = (file, relative) => {
    const stat = fs.lstatSync(file), real = fs.realpathSync(file);
    const target = stat.isSymbolicLink() ? fs.statSync(file) : stat;
    const item = { path: relative, mode: stat.mode, inode: stat.ino };
    if (!target.isDirectory()) Object.assign(item, { size: stat.size, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs });
    if (stat.isSymbolicLink()) Object.assign(item, { target: fs.readlinkSync(file), target_metadata: [real, target.mode, target.ino, ...(target.isDirectory() ? [] : [target.size, target.mtimeMs, target.ctimeMs])] });
    files.push(item);
    if (target.isDirectory() && !visited.has(real)) {
      visited.add(real);
      // -B disables writes, but Python can still execute existing bytecode.
      for (const name of fs.readdirSync(file).sort()) walk(path.join(file,name),`${relative}/${name}`);
    }
  };
  for (const directory of directories) walk(directory, directory);
  return digest(files);
}

export function capturePythonPrerequisite(root, { environment = process.env } = {}) {
  root = fs.realpathSync(root);
  const requirements = declaredPythonRequirements(root);
  if (!requirements) return null;
  const executable = environment.TRIALPROOF_PYTHON || path.join(root, '.venv', 'bin', 'python');
  if (!path.isAbsolute(executable)) fail('TRIALPROOF_PYTHON must name an absolute installed interpreter');
  let target;
  try { fs.accessSync(executable, fs.constants.X_OK); target = fs.realpathSync(executable); if (!fs.statSync(target).isFile()) throw new Error(); }
  catch { fail('existing project interpreter is missing or not executable (.venv/bin/python or TRIALPROOF_PYTHON)'); }
  const cache = tokenizerCache(requirements, environment);
  const env = { PATH: path.dirname(executable), LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', TMPDIR: os.tmpdir(), ...(cache ? { TIKTOKEN_CACHE_DIR: cache.directory } : {}) };
  // Keep the invoked venv path: replacing it by realpath can select base Python
  // and silently drop the virtual environment. Record both identities instead.
  const result = spawnSync(executable, ['-I', '-B', '-c', PROBE], { cwd: root, env, input: JSON.stringify({ packages: requirements.packages }), encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
  let probe; try { probe = JSON.parse(result.stdout || ''); } catch {}
  if (result.error || result.signal || result.status !== 0 || probe?.error) fail(probe?.error === 'version-mismatch' ? `installed version differs from pinned requirement ${probe.package}` : 'fixed offline module/tokenizer probe failed; inspect the installed environment (no download or install was attempted)');
  if (!probe || !['version','machine','executable','prefix','base_prefix'].every(k => typeof probe[k] === 'string' && probe[k]) || !Array.isArray(probe.sites) || !probe.sites.length || !probe.sites.every(p => typeof p === 'string' && path.isAbsolute(p) && fs.statSync(p).isDirectory()) || !Array.isArray(probe.packages)) fail('interpreter probe returned invalid dependency identity');
  const configuration = path.join(probe.prefix, 'pyvenv.cfg');
  const binding = { schema_version: 1, executable, executable_realpath: target, executable_sha256: hash(fs.readFileSync(target)), requirements, probe,
    venv_config: fs.existsSync(configuration) ? regularFile(configuration, 'virtual environment configuration') : null,
    dependencies_sha256: dependencyInventory([...new Set(probe.sites)].sort()), tokenizer_cache: cache };
  return { ...binding, sha256: digest(binding) };
}

export function pythonAcceptanceEnvironment(binding) {
  if (!binding) return {};
  return { TRIALPROOF_PYTHON: binding.executable, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', ...(binding.tokenizer_cache ? { TIKTOKEN_CACHE_DIR: binding.tokenizer_cache.directory } : {}) };
}

export function preparePythonAcceptanceEnvironment(root, binding, directory) {
  if (!binding) return {};
  const current = capturePythonPrerequisite(root);
  if (!current || current.sha256 !== binding.sha256) throw new Error('Python dependency identity changed before isolated acceptance');
  const env = pythonAcceptanceEnvironment(binding);
  if (binding.tokenizer_cache) {
    const cache = path.join(directory, 'tokenizer-cache'); fs.mkdirSync(cache, { mode: 0o700 });
    for (const item of binding.tokenizer_cache.files) {
      const source = path.join(binding.tokenizer_cache.directory, item.filename), dest = path.join(cache, item.filename);
      if (regularFile(source, 'cached tokenizer').sha256 !== item.sha256) throw new Error('Python tokenizer cache changed before isolated acceptance');
      fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL); fs.chmodSync(dest, 0o400);
    }
    env.TIKTOKEN_CACHE_DIR = cache;
  }
  return env;
}
