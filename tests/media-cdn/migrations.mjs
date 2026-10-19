import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { applyMigrations } from '../../dist/db/migrate.js';
import { migrationIdentity, migrationBody, planMigrations } from '../../dist/db/migration-plan.js';

// Exact legacy ledger shapes, in disposable databases. No production history is edited.
const config={host:'127.0.0.1',user:'fixture',password:'fixture-password'};
const admin=new pg.Client({...config,database:'kode_cdn_test'});
await admin.connect();
const files=(await readdir('/app/migrations')).filter(f=>f.endsWith('.sql')).sort();
try {
  for(const history of ['media','time']) {
    const database=`kode_history_${history}`;
    await admin.query(`CREATE DATABASE ${database}`);
    const client=new pg.Client({...config,database});
    const concurrent=new pg.Client({...config,database});
    await client.connect(); await concurrent.connect();
    try {
      await client.query(`CREATE SCHEMA organizations; CREATE SCHEMA identity; CREATE SCHEMA work; CREATE SCHEMA platform;
        CREATE TABLE organizations.organizations(id uuid PRIMARY KEY);
        CREATE TABLE identity.users(id uuid PRIMARY KEY);
        CREATE TABLE work.time_entries(organization_id uuid,started_at timestamptz,ended_at timestamptz,deleted_at timestamptz);
        CREATE TABLE platform.schema_migrations(version varchar(255) PRIMARY KEY,description text NOT NULL,applied_at timestamptz DEFAULT now());`);
      for(const filename of files.slice(0,57)) {
        const m=migrationIdentity(filename);
        await client.query("INSERT INTO platform.schema_migrations VALUES($1,$2,'2020-01-01')",[m.version,m.description]);
      }
      const existing=history==='media' ? ['0058_media_platform.sql','0059_media_job_leases.sql'] : ['0060_time_entry_auto_stop.sql'];
      for(const filename of existing) {
        await client.query(migrationBody(await readFile(`/app/migrations/${filename}`,'utf8')));
        const m=migrationIdentity(filename);
        await client.query("INSERT INTO platform.schema_migrations VALUES($1,$2,'2020-01-01')",[history==='time'?'0058':m.version,m.description]);
      }
      const before=await client.query('SELECT * FROM platform.schema_migrations ORDER BY version');
      // Exercise the operator inspection SQL in its READ ONLY transaction.
      const inspection=(await readFile('/app/scripts/media-platform/inspect-ledger.sql','utf8')).replace(/^\\set.*$/gm,'');
      const inspected=await client.query(inspection);
      const report=inspected.find(result=>result.rows[0]?.json_build_object)?.rows[0].json_build_object;
      assert.ok(report);
      const scratch=await mkdtemp('/tmp/ledger-inspection-');
      try {
        await writeFile(`${scratch}/ledger.json`,JSON.stringify(report));
        const checked=JSON.parse(execFileSync(process.execPath,['scripts/media-platform/check-ledger.mjs',`${scratch}/ledger.json`],{encoding:'utf8'}));
        assert.equal(checked.recognizedHistory,true);
        assert.equal(checked.productionCompatibilityVerified,false);
        assert.equal(checked.pending.length,history==='media'?2:3);
      } finally {await rm(scratch,{recursive:true,force:true});}

      assert.equal(planMigrations(files,report.ledger).length,history==='media'?2:3);
      assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'off','inspection transaction closed');
      assert.deepEqual((await client.query('SELECT * FROM platform.schema_migrations ORDER BY version')).rows,before.rows,'read-only inspection leaves ledger unchanged');
      const results=await Promise.all([applyMigrations(client,'/app/migrations'),applyMigrations(concurrent,'/app/migrations')]);
      const newlyApplied=results.flat();
      assert.equal(newlyApplied.length,history==='media'?2:3,'concurrent runners apply each pending identity once');
      const after=await client.query("SELECT * FROM platform.schema_migrations WHERE version ~ '^[0-9]{4}$' ORDER BY version");
      assert.deepEqual(after.rows,before.rows,'legacy versions, descriptions and timestamps preserved exactly');
      assert.deepEqual(await applyMigrations(client,'/app/migrations'),[],'second run is idempotent');
      const column=await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='work' AND table_name='time_entries' AND column_name='auto_stopped_at'");
      assert.equal(column.rowCount,1);
      assert.equal((await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='media_platform' AND table_name='jobs' AND column_name='fencing_token'")).rowCount,1);
    } finally { await concurrent.end(); await client.end(); }
  }
  console.log('Both legacy 0058 histories: real migration execution, concurrent runners, ledger preservation and repeat execution passed');
} finally { await admin.end(); }
