import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAcceptancePostgres, reconcileAcceptancePostgres, preflightAcceptancePostgres, legacyPostgresPreset } from './acceptance-postgres.mjs';
import { createHash } from 'node:crypto';

const IMAGE = `sha256:${'a'.repeat(64)}`;
const CONTAINER = 'b'.repeat(64);
const PLAN = 'c'.repeat(64);
const OWNER = 'com.trialproof.access-test-fixture';
const PURPOSE = 'com.trialproof.fixture-purpose';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// Every Docker/psql interaction is intercepted by this executable in an owned
// temporary PATH. It never forwards commands to Docker, a socket or a database.
const fakeDocker = String.raw`
const fs=require('node:fs');
const file=process.env.SYNTHETIC_ACCEPTANCE_DOCKER_STATE;
const state=JSON.parse(fs.readFileSync(file,'utf8')),args=process.argv.slice(2),mode=state.mode;
state.commands.push(args);
const done=(value='',status=0)=>{fs.writeFileSync(file,JSON.stringify(state));if(value)process.stdout.write(value);process.exit(status);};
const option=name=>args[args.indexOf(name)+1];
if(args[0]==='context')done(JSON.stringify(mode==='remote-context'?'ssh://foreign.invalid/docker':'unix:///tmp/codex-acceptance-fake.sock'));
if(args[0]==='image'){
 if(mode==='missing-image')done('synthetic-private-daemon-secret',1);
 done(JSON.stringify(mode==='malformed-image'?'unreviewed:latest':'sha256:'+'a'.repeat(64)));
}
if(args[0]==='info')done(JSON.stringify('synthetic-daemon'));
if(args[0]==='container'&&args[1]==='create'){
 state.name=option('--name');state.image=args.at(-1);state.labels={};
 for(let i=0;i<args.length;i++)if(args[i]==='--label'){const v=args[++i],j=v.indexOf('=');state.labels[v.slice(0,j)]=v.slice(j+1);}
 state.database=args.find(x=>x.startsWith('POSTGRES_DB=')).slice('POSTGRES_DB='.length);
 state.user=args.find(x=>x.startsWith('POSTGRES_USER=')).slice('POSTGRES_USER='.length);
 state.password=process.env.POSTGRES_PASSWORD;state.created=true;
 state.port=option('--publish').split(':')[1]||'15432';
 if(mode==='create-failed-response'||mode==='create-foreign-identity'||mode==='create-missing-identity')done('',1);
 done(mode==='create-malformed-response'?'unconfirmed':'b'.repeat(64));
}
if(args[0]==='container'&&args[1]==='inspect'){
 if(mode==='create-missing-identity')done('',1);
 const labels={...state.labels};
 if(mode==='foreign-owner'||mode==='create-foreign-identity')labels['com.trialproof.access-test-fixture']='foreign-fixture';
 if(mode==='foreign-purpose')labels['com.trialproof.fixture-purpose']='package-99';
 const ports={'5432/tcp':[{HostIp:mode==='wildcard-port'?'0.0.0.0':'127.0.0.1',HostPort:mode==='wrong-fixed-port'?'15555':state.port}]};
 done(['b'.repeat(64),'/'+state.name,mode==='foreign-image'?'sha256:'+'f'.repeat(64):state.image,labels,ports,[{Type:mode==='host-storage'?'bind':'tmpfs'}]].map(JSON.stringify).join('|'));
}
if(args[0]==='container'&&args[1]==='start'){if(mode==='start-fails')done('',1);done(args.at(-1));}
if(args[0]==='container'&&args[1]==='rm'){state.removed=mode!=='cleanup-remains';done(args.at(-1));}
if(args[0]==='container'&&args[1]==='ls'){
 if(mode==='inventory-fails')done('',1);
 if(mode==='ambiguous-inventory')done('b'.repeat(64)+'\n'+'e'.repeat(64));
 done(state.created&&!state.removed?'b'.repeat(64):'');
}
if(args[0]==='exec'&&args.includes('pg_isready'))done('ready');
if(args[0]==='exec'&&args.includes('psql')){
 const sql=fs.readFileSync(0,'utf8');(state.sql_commands??=[]).push(sql);
 if(sql.startsWith('CREATE ROLE "trialproof-runtime" NOLOGIN;')){state.setup_sql=sql;if(mode==='setup-fails')done('',1);state.setup_applied=true;done();}
 if(sql.includes("'records', to_regclass"))done(JSON.stringify({records:state.setup_applied===true,schema:state.setup_applied===true,immutable:mode!=='wrong-schema-marker'}));
 state.sql=sql;
 const match=state.sql.match(/INSERT INTO public\.codex_plan_fixture VALUES \('([^']+)', '([^']+)', '([^']+)', true, '([^']+)'\)/);
 if(!match)done('No universal marker insert',2);
 const marker={fixture_id:match[1],plan_hash:match[2],package_id:match[3],synthetic:true,purpose:match[4]};
 if(mode==='wrong-fixture-marker')marker.fixture_id='foreign-fixture';
 if(mode==='wrong-plan-marker')marker.plan_hash='d'.repeat(64);
 if(mode==='wrong-package-marker')marker.package_id='99';
 if(mode==='nonsynthetic-marker')marker.synthetic=false;
 if(mode==='wrong-purpose-marker')marker.purpose='foreign-purpose';
 done(JSON.stringify({database:mode==='wrong-database-marker'?'foreign_database':state.database,server_version:'17.synthetic',markers:mode==='extra-marker'?[marker,marker]:[marker]}));
}
done('Unexpected synthetic command',2);
`;

function fixture(t, mode = 'normal') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-postgres-')));
  const stateFile = path.join(root, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ mode, commands: [] }));
  fs.writeFileSync(path.join(root, 'docker'), `#!${process.execPath}\n${fakeDocker}`, { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'deploy/managed'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deploy/managed/benchmark-migration.sql'), 'BEGIN;\n-- Synthetic migration transport fixture\nCOMMIT;\n');
  const keys = ['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'SYNTHETIC_ACCEPTANCE_DOCKER_STATE'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PATH = root;
  process.env.SYNTHETIC_ACCEPTANCE_DOCKER_STATE = stateFile;
  delete process.env.DOCKER_HOST; delete process.env.DOCKER_CONTEXT;
  t.after(() => {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return { root, state, update: values => fs.writeFileSync(stateFile, JSON.stringify({ ...state(), ...values })) };
}
const create = options => createAcceptancePostgres({ packageId: '06', planHash: PLAN, ...options });
const mutations = fake => fake.state().commands.filter(args => args[0] === 'container' && ['create','start','rm'].includes(args[1]));

test('universal PostgreSQL fixture binds UUID, plan, package and synthetic marker before exposure, then cleans once', t => {
  const fake = fixture(t), events = [];
  const live = create({ onJournal: event => {
    events.push(structuredClone(event));
    if (event.phase === 'create_pending') {
      assert.equal(mutations(fake).length, 0);
      assert.equal(event.fixture.container_id, null);
    }
  } });
  assert.match(live.evidence.id, UUID);
  assert.equal(live.evidence.plan_hash, PLAN); assert.equal(live.evidence.package_id, '06');
  assert.equal(live.evidence.purpose, 'package-06'); assert.equal(live.evidence.marker_verified, true);
  assert.equal(live.evidence.image_id, IMAGE); assert.equal(live.evidence.container_id, CONTAINER);
  const url = new URL(live.environment.CODEX_PLAN_TEST_DATABASE_URL), state = fake.state();
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '15432');
  assert.equal(url.username, 'codex_plan_fixture'); assert.equal(url.password, state.password);
  assert.equal(url.pathname, '/' + live.evidence.database);
  assert.equal(live.environment.CODEX_PLAN_FIXTURE_ID, live.evidence.id);
  assert.equal(live.environment.CODEX_PLAN_PACKAGE_ID, '06'); assert.equal(live.environment.CODEX_PLAN_PLAN_HASH, PLAN);
  assert.deepEqual(Object.keys(live.environment).sort(), ['CODEX_PLAN_FIXTURE_ID','CODEX_PLAN_PACKAGE_ID','CODEX_PLAN_PLAN_HASH','CODEX_PLAN_TEST_DATABASE_URL']);
  const argv = state.commands.find(args => args[1] === 'create');
  assert.equal(argv[argv.indexOf('--pull') + 1], 'never'); assert.equal(argv.at(-1), IMAGE);
  assert.equal(argv[argv.indexOf('--publish') + 1], '127.0.0.1::5432');
  assert.equal(argv.includes('--volume'), false); assert.equal(argv.filter(x => x === '--tmpfs').length, 2);
  assert.equal(state.labels[OWNER], live.evidence.id); assert.equal(state.labels[PURPOSE], 'package-06');
  assert.ok(state.sql.includes(`'${live.evidence.id}', '${PLAN}', '06', true, 'package-06'`));
  assert.doesNotMatch(state.sql, /trialproof_access_test_fixture/);
  assert.equal(JSON.stringify(live.evidence).includes(state.password), false);
  assert.equal(JSON.stringify(argv).includes(state.password), false);
  const cleanup = live.dispose(); assert.equal(cleanup.verified_absent, true); assert.deepEqual(live.dispose(), cleanup);
  assert.equal(fake.state().commands.filter(args => args[1] === 'rm').length, 1);
  assert.deepEqual(events.map(event => event.phase), ['create_pending','created','start_pending','ready','cleanup_pending','cleaned']);
});

test('PostgreSQL preflight inspects only local daemon and exact installed image; invalid authority never creates', t => {
  const fake = fixture(t);
  const result = preflightAcceptancePostgres();
  assert.equal(result.image_ref, 'pgvector/pgvector:pg17'); assert.equal(result.image_id, IMAGE);
  assert.equal(result.endpoint, 'unix:///tmp/codex-acceptance-fake.sock');
  assert.deepEqual(fake.state().commands.map(args => args.slice(0, 2)), [['context','inspect'],['image','inspect'],['info','--format']]);
  const before = fake.state().commands.length;
  for (const invalid of [{packageId:'6'}, {packageId:'06;rm'}, {planHash:'unknown'}, {preset:'arbitrary-database'}]) assert.throws(() => create(invalid), /identities|Unknown PostgreSQL/);
  assert.equal(fake.state().commands.length, before); assert.equal(mutations(fake).length, 0);
});

for (const mode of ['missing-image','malformed-image','remote-context']) test(`PostgreSQL ${mode} fails closed without image pull or container mutation`, t => {
  const fake = fixture(t, mode);
  assert.throws(() => preflightAcceptancePostgres(), error => { assert.doesNotMatch(error.message, /synthetic-private/); return true; });
  assert.equal(mutations(fake).length, 0);
  assert.equal(fake.state().commands.some(args => args.includes('pull')), false);
});

test('remote Docker host is refused, while explicit context precedence matches Docker', t => {
  const fake = fixture(t);
  process.env.DOCKER_HOST = 'tcp://remote.invalid:2375';
  assert.throws(() => preflightAcceptancePostgres(), /remote or overridden/); assert.equal(fake.state().commands.length, 0);
  process.env.DOCKER_CONTEXT = 'owned-synthetic-context';
  assert.equal(preflightAcceptancePostgres().endpoint, 'unix:///tmp/codex-acceptance-fake.sock');
});

const presets = [
  ['sites-legacy','sites-legacy-regression','TRIALPROOF_SITES_TEST_PG','section3_test',null],
  ['study-management','study-management-regression','TRIALPROOF_SITES_MANAGEMENT_TEST_PG','study_management_47_test','study-management-4.7'],
  ['access-storage','package-02','TRIALPROOF_ACCESS_TEST_PG',null,null],
  ['access-policy','package-03','TRIALPROOF_ACCESS_POLICY_TEST_PG',null,null],
  ['access-adapters','package-04','TRIALPROOF_ACCESS_ADAPTERS_TEST_PG',null,null],
  ['sites-lifecycle','package-05','TRIALPROOF_SITE_LIFECYCLE_TEST_PG',null,null],
  ['operations','operations-regression','TRIALPROOF_OPERATIONS_TEST_PG','section4_test',null,55444],
  ['benchmark-store','benchmark-storage-regression','TRIALPROOF_BENCHMARK_TEST_PG',null,null,null,true],
];
for (const [preset,purpose,flag,database,comment,port=55443,managed=false] of presets) test(`reviewed ${preset} preset adds only its known flags/legacy marker to current package ownership`, t => {
  const fake = fixture(t), live = create({ preset, root: fake.root }), state = fake.state();
  assert.equal(legacyPostgresPreset(preset).purpose, purpose);
  assert.equal(live.evidence.purpose, purpose); assert.equal(live.evidence.package_id, '06'); assert.equal(live.evidence.plan_hash, PLAN);
  assert.equal(live.environment[flag], '1');
  for (const [, , otherFlag] of presets) if (otherFlag !== flag) assert.equal(live.environment[otherFlag], undefined);
  assert.match(state.sql, /CREATE TABLE public\.codex_plan_fixture/); assert.match(state.sql, /CREATE TABLE public\.trialproof_access_test_fixture/);
  assert.equal(state.labels[PURPOSE], purpose);
  if (database) {
    assert.equal(live.evidence.database, database); assert.equal(live.environment.PGDATABASE, database);
    assert.equal(live.environment.PGPORT, String(port)); assert.equal(live.environment.TRIALPROOF_PG_LOCAL_TEST, '1');
  } else {
    assert.match(live.evidence.database, /^tp_access_test_[a-f0-9]{32}$/);
    assert.equal(live.environment.TRIALPROOF_PG_LOCAL_TEST, managed ? '1' : undefined);
    assert.equal(live.environment.PGPASSWORD, managed ? 'synthetic-local-only' : undefined);
    if (managed) { assert.equal(live.environment.PGPORT, '15432'); assert.equal(live.environment.PGDATABASE, live.evidence.database); }
  }
  if (managed) {
    const migration = fs.readFileSync(path.join(fake.root, 'deploy/managed/benchmark-migration.sql'), 'utf8');
    assert.equal(state.setup_sql, 'CREATE ROLE "trialproof-runtime" NOLOGIN;\n' + migration);
    assert.ok(state.sql_commands[0].includes('INSERT INTO public.codex_plan_fixture'));
    assert.ok(state.sql_commands[1].startsWith('CREATE ROLE'));
    assert.equal(live.evidence.setup.verified, true);
    assert.equal(live.evidence.setup.sha256, createHash('sha256').update(migration).digest('hex'));
  }
  if (comment) assert.ok(state.sql.includes(`COMMENT ON DATABASE ${database} IS '${comment}:${live.evidence.id}'`));
  assert.equal(live.dispose().verified_absent, true);
});

test('fixed operations port must match the verified Docker binding', t => {
  const fake = fixture(t, 'wrong-fixed-port');
  assert.throws(() => create({ preset: 'operations', root: fake.root }), /fixed preset port/);
  assert.equal(fake.state().removed, true);
});

for (const mode of ['setup-fails', 'wrong-schema-marker']) test(`benchmark ${mode} never exposes an unprepared fixture and cleans its container`, t => {
  const fake = fixture(t, mode), phases = [];
  assert.throws(() => create({ preset: 'benchmark-store', root: fake.root, onJournal: event => phases.push(event.phase) }), error => {
    assert.equal(error.fixtureEvidence.setup.verified, false);
    assert.equal(error.fixtureEvidence.cleanup.verified_absent, true);
    return true;
  });
  assert.equal(phases.includes('ready'), false);
  assert.equal(fake.state().removed, true);
});

test('benchmark setup refuses absent or symlinked migration before any container operation', t => {
  const fake = fixture(t), migration = path.join(fake.root, 'deploy/managed/benchmark-migration.sql');
  fs.unlinkSync(migration);
  assert.throws(() => create({ preset: 'benchmark-store', root: fake.root }), /ENOENT/);
  fs.writeFileSync(path.join(fake.root, 'outside.sql'), 'SELECT 1;');
  fs.symlinkSync(path.join(fake.root, 'outside.sql'), migration);
  assert.throws(() => create({ preset: 'benchmark-store', root: fake.root }), /without symlinks/);
  assert.equal(fake.state().commands.length, 0);
});

for (const mode of ['wrong-fixture-marker','wrong-plan-marker','wrong-package-marker','nonsynthetic-marker','wrong-purpose-marker','wrong-database-marker','extra-marker']) test(`universal ${mode} prevents ready/exposure and disposes only its labeled fixture`, t => {
  const fake = fixture(t, mode), events = [];
  assert.throws(() => create({ onJournal: event => events.push(event.phase) }), error => {
    assert.match(error.message, /marker or database identity/); assert.equal(error.fixtureEvidence.marker_verified, false);
    assert.equal(error.fixtureEvidence.cleanup.verified_absent, true); return true;
  });
  assert.equal(events.includes('ready'), false);
  assert.equal(fake.state().commands.find(args => args[1] === 'rm').at(-1), CONTAINER);
});

for (const mode of ['foreign-owner','foreign-purpose','foreign-image']) test(`${mode} never starts or removes an unverified container`, t => {
  const fake = fixture(t, mode);
  assert.throws(() => create(), error => { assert.match(error.message, /ownership identity/); assert.equal(error.fixtureEvidence.cleanup.removed, false); return true; });
  assert.equal(fake.state().commands.some(args => ['start','rm'].includes(args[1])), false);
});

for (const mode of ['create-failed-response','create-malformed-response']) test(`${mode} reconciles random name to verified identity before cleanup`, t => {
  const fake = fixture(t, mode);
  assert.throws(() => create(), error => {
    assert.equal(error.fixtureEvidence.container_id, CONTAINER); assert.equal(error.fixtureEvidence.cleanup.verified_absent, true); return true;
  });
  const state = fake.state(), inspections = state.commands.filter(args => args[0] === 'container' && args[1] === 'inspect');
  assert.equal(inspections[0].at(-1), state.name); assert.equal(inspections[1].at(-1), CONTAINER);
  assert.equal(state.commands.some(args => args[1] === 'start'), false);
});

for (const mode of ['create-missing-identity','create-foreign-identity']) test(`${mode} records unknown cleanup without starting or deleting anything`, t => {
  const fake = fixture(t, mode);
  assert.throws(() => create(), error => { assert.equal(error.fixtureEvidence.container_id, null); assert.equal(error.fixtureEvidence.cleanup.removed, false); return true; });
  assert.equal(fake.state().commands.some(args => ['start','rm'].includes(args[1])), false);
});

test('crash reconciliation removes only exact journal ownership and never calls failed daemon listing absence', t => {
  const fake = fixture(t), live = create();
  for (const update of [{package_id:'07'}, {plan_hash:'not-a-hash'}, {image_id:'sha256:'+'f'.repeat(64)}, {container_name:'foreign'}, {id:'foreign'}]) {
    assert.throws(() => reconcileAcceptancePostgres({ ...live.evidence, ...update }), /journal|ownership identity/);
  }
  assert.equal(fake.state().commands.some(args => args[1] === 'rm'), false);
  fake.update({mode:'inventory-fails'});
  assert.throws(() => reconcileAcceptancePostgres(live.evidence), /container ls failed/);
  fake.update({mode:'ambiguous-inventory'});
  assert.throws(() => reconcileAcceptancePostgres(live.evidence), /inventory is ambiguous/);
  fake.update({mode:'normal'});
  assert.equal(reconcileAcceptancePostgres(live.evidence).verified_absent, true);
  assert.equal(reconcileAcceptancePostgres(live.evidence).verified_absent, true);
  assert.equal(fake.state().commands.filter(args => args[1] === 'rm').length, 1);
});

test('crash reconciliation without a known ID refuses absent create outcome and safely adopts matching owned name', t => {
  const fake = fixture(t), live = create(), pending = { ...live.evidence, container_id: null };
  fake.update({removed:true});
  assert.throws(() => reconcileAcceptancePostgres(pending), /create outcome remains unknown/);
  assert.equal(fake.state().commands.some(args => args[1] === 'rm'), false);
  fake.update({removed:false});
  const events=[];
  assert.equal(reconcileAcceptancePostgres(pending, {onJournal: event => events.push(structuredClone(event))}).verified_absent, true);
  assert.equal(events[0].fixture.container_id, CONTAINER);
  assert.deepEqual(events.map(event => event.phase), ['cleanup_pending','cleaned']);
});

test('cleanup verifies absence and refuses to mutate after Docker endpoint changes', t => {
  const fake = fixture(t), live = create();
  process.env.DOCKER_HOST = 'unix:///tmp/another-synthetic.sock';
  assert.throws(() => reconcileAcceptancePostgres(live.evidence), /endpoint changed/);
  assert.equal(fake.state().commands.some(args => args[1] === 'rm'), false);
  delete process.env.DOCKER_HOST;
  fake.update({mode:'cleanup-remains'});
  assert.throws(() => live.dispose(), /remains after cleanup/);
  fake.update({mode:'normal'});
  assert.equal(reconcileAcceptancePostgres(live.evidence).verified_absent, true);
});


for (const [mode,diagnostic] of [['host-storage',/persistent or host-backed/],['wildcard-port',/explicit loopback port/],['start-fails',/container start failed/]]) test(`${mode} cannot expose a database and cleans only its own container`, t => {
  const fake = fixture(t, mode);
  assert.throws(() => create(), error => {
    assert.match(error.message, diagnostic); assert.equal(error.fixtureEvidence.cleanup.verified_absent, true); return true;
  });
  assert.equal(fake.state().commands.find(args => args[1] === 'rm').at(-1), CONTAINER);
  assert.equal(fake.state().commands.some(args => args.includes('psql')), false);
});
