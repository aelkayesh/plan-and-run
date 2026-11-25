import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const IMAGE_REF = 'pgvector/pgvector:pg17';
const OWNER_LABEL = 'com.trialproof.access-test-fixture';
const PURPOSE_LABEL = 'com.trialproof.fixture-purpose';
const PACKAGE = /^\d{2}$/;
const HASH = /^[a-f0-9]{64}$/;

const ID = /^[a-f0-9]{64}$/;
const INSPECT_FORMAT = '{{json .Id}}|{{json .Name}}|{{json .Image}}|{{json .Config.Labels}}|{{json .NetworkSettings.Ports}}|{{json .Mounts}}';

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], shell: false, ...options,
  });
  if (result.error || result.signal || result.status !== 0) {
    // Docker errors may contain environment or connection details. Keep the
    // diagnostic useful without persisting credentials or raw daemon output.
    throw new Error(`Disposable PostgreSQL docker ${args.slice(0, 2).join(' ')} failed (${result.error?.code || result.signal || `exit ${result.status}`}).`);
  }
  return result.stdout.trim();
}

function inspect(container) {
  const fields = docker(['container', 'inspect', '--format', INSPECT_FORMAT, container]).split('|');
  if (fields.length !== 6) throw new Error('Disposable PostgreSQL container inspection was malformed.');
  const [id, name, image, labels, ports, mounts] = fields.map(value => JSON.parse(value));
  return { id, name, image, labels, ports, mounts };
}

function assertOwned(info, expected) {
  if (info.id !== expected.container_id || info.name !== `/${expected.container_name}`
      || info.image !== expected.image_id || info.labels?.[OWNER_LABEL] !== expected.id
      || info.labels?.[PURPOSE_LABEL] !== (expected.purpose ?? 'package-02')) {
    throw new Error('Disposable PostgreSQL container ownership identity does not match; refusing to mutate it.');
  }
}

export function localDockerEndpoint() {
  // DOCKER_CONTEXT takes precedence over DOCKER_HOST in the Docker CLI. With
  // neither override, context inspect resolves the user's active context.
  const endpoint = !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
    ? process.env.DOCKER_HOST
    : JSON.parse(docker(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']));
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Disposable PostgreSQL requires a local Docker endpoint.'); }
  const localSocket = ['unix:', 'npipe:'].includes(url.protocol) && !url.hostname && url.pathname.startsWith('/');
  const localTcp = url.protocol === 'tcp:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!localSocket && !localTcp) || url.username || url.password || url.search || url.hash) {
    throw new Error('Disposable PostgreSQL refuses a remote or overridden Docker endpoint.');
  }
  return endpoint;
}

/** Provision only a new local, labeled, tmpfs PostgreSQL fixture. Never pulls an
 * image, reads application DB credentials, reuses a container, or attaches any
 * existing database/storage. The returned URL is an ephemeral secret; persist
 * evidence, not environment. Call dispose() in a finally block.
 */
export function preflightAcceptancePostgres() {
  const endpoint = localDockerEndpoint();
  const imageId = JSON.parse(docker(['image', 'inspect', IMAGE_REF, '--format', '{{json .Id}}']));
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Disposable PostgreSQL requires a locally installed image identity.');
  docker(['info', '--format', '{{json .ServerVersion}}']);
  return { endpoint, image_id: imageId, image_ref: IMAGE_REF };
}

export function createAcceptancePostgres({ packageId, planHash, preset = null, root = process.cwd(), onJournal = () => {} } = {}) {
  if (!PACKAGE.test(packageId || '') || !HASH.test(planHash || '')) throw new Error('PostgreSQL requires exact package and plan identities.');
  const legacy = legacyPostgresPreset(preset);
  // Existing benchmark tests select the managed PostgreSQL store but do not
  // create its schema. Only this reviewed fixture preset may apply this fixed
  // repository migration, and only after verifying the fresh fixture marker.
  const setup = legacy?.setup_file ? readFixtureSetup(root, legacy.setup_file) : null;
  const requestedPort = legacy?.database ? legacy.port ?? 55443 : null;
  const purpose = legacy?.purpose || `package-${packageId}`;
  const managed = Boolean(legacy?.database || legacy?.managed);
  const USER = managed ? 'postgres' : 'codex_plan_fixture';
  const dockerEndpoint = localDockerEndpoint();
  const imageId = JSON.parse(docker(['image', 'inspect', IMAGE_REF, '--format', '{{json .Id}}']));
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Disposable PostgreSQL requires a locally installed image identity.');
  const fixtureId = randomUUID();
  const suffix = fixtureId.replaceAll('-', '');
  const name = `codex-plan-test-${suffix}`;
  const database = legacy?.database || `tp_access_test_${suffix}`;
  const password = managed ? 'synthetic-local-only' : randomBytes(32).toString('hex');
  const evidence = { id: fixtureId, kind: 'codex-plan-postgresql', package_id: packageId, plan_hash: planHash, preset, purpose, image_id: imageId,
    image_ref: IMAGE_REF, container_id: null, container_name: name, database,
    loopback_port: null, marker_verified: false, storage: 'fresh-tmpfs', docker_endpoint: dockerEndpoint,
    created_at: new Date().toISOString() };
  let disposed;
  const dispose = () => {
    if (disposed) return disposed;
    if (!evidence.container_id) throw new Error('Disposable PostgreSQL container identity is unavailable for cleanup.');
    assertOwned(inspect(evidence.container_id), evidence);
    onJournal({ phase: 'cleanup_pending', fixture: evidence });
    docker(['container', 'rm', '--force', '--volumes', evidence.container_id]);
    const remaining = docker(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${evidence.container_id}`]);
    if (remaining) throw new Error('Disposable PostgreSQL owned container remains after cleanup.');
    disposed = { container_id: evidence.container_id, removed: true, verified_absent: true, removed_at: new Date().toISOString() };
    onJournal({ phase: 'cleaned', fixture: evidence, cleanup: disposed });
    return disposed;
  };
  try {
    // Persist the random identity before creation: an interrupted create may
    // have taken effect without returning its container ID.
    onJournal({ phase: 'create_pending', fixture: evidence });
    const created = docker(['container', 'create', '--pull', 'never', '--name', name,
      '--label', `${OWNER_LABEL}=${fixtureId}`, '--label', `${PURPOSE_LABEL}=${purpose}`,
      '--publish', requestedPort ? `127.0.0.1:${requestedPort}:5432` : '127.0.0.1::5432', '--network', 'bridge',
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=268435456',
      '--tmpfs', '/var/run/postgresql:rw,nosuid,size=16777216',
      '--security-opt', 'no-new-privileges',
      '--env', `POSTGRES_DB=${database}`, '--env', `POSTGRES_USER=${USER}`,
      '--env', 'POSTGRES_PASSWORD', imageId], { env: { ...process.env, POSTGRES_PASSWORD: password } });
    if (!ID.test(created)) throw new Error('Disposable PostgreSQL create did not return an exact container identity.');
    evidence.container_id = created;
    onJournal({ phase: 'created', fixture: evidence });
    let info = inspect(created);
    assertOwned(info, evidence);
    if (!Array.isArray(info.mounts) || info.mounts.some(mount => mount.Type !== 'tmpfs')) {
      throw new Error('Disposable PostgreSQL refuses persistent or host-backed storage.');
    }
    onJournal({ phase: 'start_pending', fixture: evidence });
    docker(['container', 'start', created]);
    info = inspect(created);
    assertOwned(info, evidence);
    const ports = info.ports?.['5432/tcp'];
    if (!Array.isArray(ports) || ports.length !== 1 || ports[0].HostIp !== '127.0.0.1'
        || !/^\d+$/.test(ports[0].HostPort) || Number(ports[0].HostPort) < 1 || Number(ports[0].HostPort) > 65535) {
      throw new Error('Disposable PostgreSQL requires exactly one explicit loopback port binding.');
    }
    evidence.loopback_port = Number(ports[0].HostPort);
    if (requestedPort && evidence.loopback_port !== requestedPort) throw new Error('Disposable PostgreSQL fixed preset port does not match its binding.');
    const deadline = Date.now() + 45_000;
    while (true) {
      try {
        docker(['exec', created, 'pg_isready', '--host', '127.0.0.1', '--port', '5432', '--username', USER, '--dbname', database, '--timeout', '1']);
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
    const sql = `CREATE TABLE public.codex_plan_fixture (fixture_id text NOT NULL, plan_hash text NOT NULL, package_id text NOT NULL, synthetic boolean NOT NULL, purpose text NOT NULL);\n`
      + `INSERT INTO public.codex_plan_fixture VALUES ('${fixtureId}', '${planHash}', '${packageId}', true, '${purpose}');\n`
      + (legacy ? `CREATE TABLE public.trialproof_access_test_fixture (fixture_id text NOT NULL, synthetic boolean NOT NULL, purpose text NOT NULL); INSERT INTO public.trialproof_access_test_fixture VALUES ('${fixtureId}', true, '${purpose}');\n` : '')
      + (legacy?.database_marker ? `COMMENT ON DATABASE ${database} IS '${legacy.database_marker}:${fixtureId}';\n` : '')
      + `SELECT json_build_object('database', current_database(), 'server_version', current_setting('server_version'), 'markers', (SELECT json_agg(row_to_json(m)) FROM public.codex_plan_fixture m));\n`;
    const marker = JSON.parse(docker(['exec', '-i', created, 'psql', '-X', '--quiet', '--tuples-only', '--no-align',
      '--set', 'ON_ERROR_STOP=1', '--username', USER, '--dbname', database], { input: sql }));
    if (marker.database !== database || JSON.stringify(marker.markers) !== JSON.stringify([
      { fixture_id: fixtureId, plan_hash: planHash, package_id: packageId, synthetic: true, purpose },
    ])) throw new Error('Disposable PostgreSQL marker or database identity verification failed.');
    evidence.marker_verified = true;
    evidence.server_version = marker.server_version;
    if (setup) {
      evidence.setup = { file: setup.file, sha256: setup.sha256, verified: false };
      onJournal({ phase: 'schema_pending', fixture: evidence });
      assertOwned(inspect(created), evidence);
      // This NOLOGIN role exists only inside the newly owned container and is
      // required by the real migration's grants. No managed identity is used.
      docker(['exec', '-i', created, 'psql', '-X', '--quiet', '--set', 'ON_ERROR_STOP=1',
        '--username', USER, '--dbname', database], { input: 'CREATE ROLE "trialproof-runtime" NOLOGIN;\n' + setup.sql });
      const schema = JSON.parse(docker(['exec', '-i', created, 'psql', '-X', '--quiet', '--tuples-only', '--no-align',
        '--set', 'ON_ERROR_STOP=1', '--username', USER, '--dbname', database], {
        input: "SELECT json_build_object('records', to_regclass('public.benchmark_records') IS NOT NULL, 'schema', EXISTS(SELECT 1 FROM public.benchmark_schema WHERE version=1), 'immutable', EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.benchmark_records'::regclass AND tgname='benchmark_records_immutable'));\n",
      }));
      if (schema.records !== true || schema.schema !== true || schema.immutable !== true) throw new Error('Disposable benchmark PostgreSQL schema verification failed.');
      evidence.setup.verified = true;
      onJournal({ phase: 'schema_ready', fixture: evidence });
    }
    onJournal({ phase: 'ready', fixture: evidence });
    const url = `postgresql://${USER}:${password}@127.0.0.1:${evidence.loopback_port}/${database}`;
    return { evidence, environment: { CODEX_PLAN_TEST_DATABASE_URL: url, CODEX_PLAN_FIXTURE_ID: fixtureId,
      CODEX_PLAN_PACKAGE_ID: packageId, CODEX_PLAN_PLAN_HASH: planHash,
      ...(legacy ? { [legacy.flag]: '1', [legacy.url]: url, TRIALPROOF_ACCESS_TEST_DATABASE_URL: url,
        TRIALPROOF_ACCESS_TEST_FIXTURE_ID: fixtureId, ...(managed ? { PGHOST: '127.0.0.1', PGPORT: String(evidence.loopback_port), PGDATABASE: database, PGUSER: USER, PGPASSWORD: password, TRIALPROOF_PG_LOCAL_TEST: '1', TRIALPROOF_STORAGE: 'azure', TRIALPROOF_PG_FIXTURE_TOKEN: fixtureId } : {}) } : {}) }, dispose };

  } catch (error) {
    try {
      // A failed/timed-out create can still have taken effect. Recover by our
      // random name, but adopt an ID only after verifying every ownership field.
      // Missing or foreign identity remains unresolved and is never removed.
      if (!evidence.container_id) {
        const recovered = inspect(name);
        if (!ID.test(recovered.id || '')) throw new Error('Disposable PostgreSQL created container identity remains unresolved.');
        assertOwned(recovered, { ...evidence, container_id: recovered.id });
        evidence.container_id = recovered.id;
      }
      evidence.cleanup = dispose();
    } catch (cleanupError) { evidence.cleanup = { removed: false, error: cleanupError.message }; }
    error.fixtureEvidence = evidence;
    throw error;
  }
}

/** Reconcile only the exact journal-owned identity. A failed daemon request
 * never counts as proof that the container is absent. */
export function reconcileAcceptancePostgres(evidence, { onJournal = () => {} } = {}) {
  if (!evidence || !/^[a-f0-9-]{36}$/.test(evidence.id || '')
      || evidence.container_name !== `codex-plan-test-${evidence.id.replaceAll('-', '')}`
      || !/^sha256:[a-f0-9]{64}$/.test(evidence.image_id || '')
      || (evidence.container_id !== null && !ID.test(evidence.container_id || ''))
      || !PACKAGE.test(evidence.package_id || '') || !HASH.test(evidence.plan_hash || '')
      || evidence.purpose !== (legacyPostgresPreset(evidence.preset)?.purpose || `package-${evidence.package_id}`)
      || evidence.kind !== 'codex-plan-postgresql') throw new Error('Invalid PostgreSQL ownership journal; refusing cleanup.');
  if (localDockerEndpoint() !== evidence.docker_endpoint) throw new Error('Docker endpoint changed; cannot reconcile the owned fixture.');
  const selector = evidence.container_id ? `id=${evidence.container_id}` : `name=^/${evidence.container_name}$`;
  const ids = docker(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', selector]).split(/\s+/).filter(Boolean);
  if (!ids.length) {
    if (!evidence.container_id) throw new Error('PostgreSQL create outcome remains unknown; no exact container ID was recorded. Inspect the local daemon before retrying.');
    return { container_id: evidence.container_id, removed: true, verified_absent: true, reconciled: true };
  }
  if (ids.length !== 1 || !ID.test(ids[0])) throw new Error('PostgreSQL owned fixture inventory is ambiguous; refusing cleanup.');
  if (evidence.container_id && ids[0] !== evidence.container_id) throw new Error('PostgreSQL exact container identity changed; refusing cleanup.');
  const owned = { ...evidence, container_id: ids[0] };
  assertOwned(inspect(ids[0]), owned);
  onJournal({ phase: 'cleanup_pending', fixture: owned });
  docker(['container', 'rm', '--force', '--volumes', ids[0]]);
  if (docker(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${ids[0]}`])) throw new Error('PostgreSQL owned fixture remains after recovery cleanup.');
  const cleanup = { container_id: ids[0], removed: true, verified_absent: true, reconciled: true };
  onJournal({ phase: 'cleaned', fixture: owned, cleanup });
  return cleanup;
}

// Runtime-owned presets, never arbitrary agent flags or database names. These
// run historical suites as newly owned fixtures; they do not rerun old packages.
export const LEGACY_POSTGRES_PRESETS = Object.freeze({
  'sites-legacy': { purpose: 'sites-legacy-regression', flag: 'TRIALPROOF_SITES_TEST_PG', url: 'CODEX_PLAN_TEST_DATABASE_URL', database: 'section3_test', files: ['tests/sites-postgres.test.ts'] },
  'study-management': { purpose: 'study-management-regression', flag: 'TRIALPROOF_SITES_MANAGEMENT_TEST_PG', url: 'CODEX_PLAN_TEST_DATABASE_URL', database: 'study_management_47_test', database_marker: 'study-management-4.7', files: ['tests/sites-management-postgres.test.ts'] },
  'access-storage': { purpose: 'package-02', flag: 'TRIALPROOF_ACCESS_TEST_PG', url: 'TRIALPROOF_ACCESS_TEST_DATABASE_URL', files: ['tests/access-storage-postgres.test.ts'] },
  'access-policy': { purpose: 'package-03', flag: 'TRIALPROOF_ACCESS_POLICY_TEST_PG', url: 'TRIALPROOF_ACCESS_TEST_DATABASE_URL', files: ['tests/access-policy-postgres.test.ts'] },
  'access-adapters': { purpose: 'package-04', flag: 'TRIALPROOF_ACCESS_ADAPTERS_TEST_PG', url: 'TRIALPROOF_ACCESS_TEST_DATABASE_URL', files: ['tests/access-adapters-postgres.test.ts'] },
  'sites-lifecycle': { purpose: 'package-05', flag: 'TRIALPROOF_SITE_LIFECYCLE_TEST_PG', url: 'TRIALPROOF_ACCESS_TEST_DATABASE_URL', files: ['tests/sites-lifecycle-postgres.test.ts'] },
  'operations': { purpose: 'operations-regression', flag: 'TRIALPROOF_OPERATIONS_TEST_PG', url: 'CODEX_PLAN_TEST_DATABASE_URL', database: 'section4_test', port: 55444, files: ['tests/operations-postgres.test.ts'] },
  'benchmark-store': { purpose: 'benchmark-storage-regression', flag: 'TRIALPROOF_BENCHMARK_TEST_PG', url: 'CODEX_PLAN_TEST_DATABASE_URL', managed: true, setup_file: 'deploy/managed/benchmark-migration.sql', files: ['tests/benchmark-store.test.ts'] },
});
export function legacyPostgresPreset(id) {
  if (id == null) return null;
  if (typeof id !== 'string' || !Object.hasOwn(LEGACY_POSTGRES_PRESETS, id)) throw new Error('Unknown PostgreSQL fixture preset.');
  return LEGACY_POSTGRES_PRESETS[id];
}

function readFixtureSetup(root, relative) {
  // Callers select a preset, never a path or SQL string. Refuse symlinks in the
  // exact repository-owned migration before provisioning any container.
  if (relative !== 'deploy/managed/benchmark-migration.sql') throw new Error('Unknown PostgreSQL fixture setup.');
  let current = fs.realpathSync(root);
  for (const [index, part] of relative.split('/').entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index === 2 ? !stat.isFile() : !stat.isDirectory())) throw new Error('PostgreSQL fixture setup must be a regular repository file without symlinks.');
  }
  const sql = fs.readFileSync(current, 'utf8');
  return { file: relative, sql, sha256: createHash('sha256').update(sql).digest('hex') };
}
