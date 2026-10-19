import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { migrationBody, migrationIdentity, planMigrations } from '../src/db/migration-plan.js';
const files = readdirSync('migrations').filter(f => f.endsWith('.sql')).sort();
const early = files.slice(0,57).map(f => { const m = migrationIdentity(f); return {version:m.version,description:m.description}; });
test('both historical 0058 ledgers resolve without mutating rows or skipping the other migration', () => {
  for (const description of ['time_entry_auto_stop','media_platform']) {
    const rows = [...early,{version:'0058',description}];
    const before = JSON.stringify(rows);
    const pending = planMigrations(files,rows).map(m=>m.filename);
    assert.equal(JSON.stringify(rows),before);
    assert.equal(pending.includes('0058_media_platform.sql'),description !== 'media_platform');
    assert.equal(pending.includes('0060_time_entry_auto_stop.sql'),description !== 'time_entry_auto_stop');
    const completed = [...rows,...planMigrations(files,rows).map(m=>({version:m.filename,description:m.description}))];
    assert.deepEqual(planMigrations(files,completed),[]);
  }
});
test('fresh and VPS media histories have complete, consecutive plans', () => {
  assert.equal(planMigrations(files,[]).length,files.length);
  assert.deepEqual(planMigrations(files,[...early,{version:'0058',description:'media_platform'},
    {version:'0059',description:'media_job_leases'}]).map(m=>m.version),files.filter(f => f.slice(0,4) >= '0060').map(f => migrationIdentity(f).version));
});
test('unknown or ambiguous histories and duplicate versions fail closed', () => {
  assert.throws(()=>planMigrations(files,[{version:'0058',description:'unknown'}]));
  assert.throws(()=>planMigrations([...files,'0058_time_entry_auto_stop.sql'],[]));
});
test('runner strips only outer transaction wrappers, retaining inner SQL', () => {
  const sql = readFileSync('migrations/0058_media_platform.sql','utf8');
  assert.ok(!migrationBody(sql).trim().startsWith('BEGIN;'));
  assert.equal(migrationBody('DO $$ BEGIN NULL; END $$;'),'DO $$ BEGIN NULL; END $$;');
});
