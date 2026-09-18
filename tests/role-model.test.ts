import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { hasPermission } from '../src/authorization/permissions.js';
import {
  applyKodeRoleModel,
  isKodeLegacyRoleKey,
  isKodeOperatingRoleKey,
  KODE_LEGACY_ROLE_KEYS,
  KODE_OPERATING_ROLE_KEYS,
} from '../src/organizations/role-model.js';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/0008_kode_operating_roles.sql',
);

test('Kode operating and legacy role keys are disjoint and complete', () => {
  assert.deepEqual([...KODE_OPERATING_ROLE_KEYS], [
    'admin',
    'manager',
    'it',
    'media_team',
    'social_media',
    'seo_specialist',
  ]);
  assert.deepEqual([...KODE_LEGACY_ROLE_KEYS], [
    'activity_coordinator',
    'driver',
    'employee',
    'finance',
    'fleet_coordinator',
    'guest_relations',
    'reservations_agent',
    'tour_guide',
    'tourism_operations_manager',
  ]);

  const overlap = KODE_OPERATING_ROLE_KEYS.filter((key) =>
    isKodeLegacyRoleKey(key),
  );
  assert.deepEqual(overlap, []);
  assert.equal(isKodeOperatingRoleKey('admin'), true);
  assert.equal(isKodeOperatingRoleKey('employee'), false);
  assert.equal(isKodeLegacyRoleKey('employee'), true);
  assert.equal(isKodeLegacyRoleKey('media_team'), false);
});

test('role-model migration deprecates legacy keys without deleting role rows', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  assert.match(sql, /ROLE CLEANUP BLOCKED/);
  assert.match(sql, /is_active = TRUE/);
  assert.match(sql, /is_active = FALSE/);
  assert.match(sql, /is_default_signup_role = FALSE/);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+organizations\.roles/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/i);

  for (const key of KODE_OPERATING_ROLE_KEYS) {
    assert.match(sql, new RegExp(`'${key}'`));
  }

  for (const key of KODE_LEGACY_ROLE_KEYS) {
    assert.match(sql, new RegExp(`'${key}'`));
  }

  assert.doesNotMatch(sql, /permissions\s*=/);
  assert.doesNotMatch(sql, /is_admin_role\s*=/);
  assert.doesNotMatch(sql, /work\.\*/);
});

test('work permission migration grants nested work keys without using all as a wildcard', () => {
  const sql = fs.readFileSync(
    path.resolve(process.cwd(), 'migrations/0010_work_operating_permissions.sql'),
    'utf8',
  );

  assert.match(sql, /"work"/);
  assert.match(sql, /"boards"/);
  assert.match(sql, /"cards"/);
  assert.doesNotMatch(sql, /"all": true/);
  assert.doesNotMatch(sql, /work\.\*/);
});

test('attachment permission migration grants nested attachment and submission keys', () => {
  const sql = fs.readFileSync(
    path.resolve(process.cwd(), 'migrations/0011_work_attachment_permissions.sql'),
    'utf8',
  );

  assert.match(sql, /"attachments"/);
  assert.match(sql, /"submissions"/);
  assert.doesNotMatch(sql, /"all": true/);
  assert.doesNotMatch(sql, /work\.\*/);
});

test('checklist migration grants nested checklist keys without using all as a wildcard', () => {
  const sql = fs.readFileSync(
    path.resolve(process.cwd(), 'migrations/0012_work_checklists.sql'),
    'utf8',
  );

  assert.match(sql, /work\.card_checklists/);
  assert.match(sql, /work\.card_checklist_items/);
  assert.match(sql, /"checklists"/);
  assert.match(sql, /jsonb_set/);
  assert.match(sql, /permissions->'work'/);
  assert.doesNotMatch(sql, /"all": true/);
  assert.doesNotMatch(sql, /work\.\*/);
});

test('applyKodeRoleModel only toggles activity flags for the two role classes', async () => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  await applyKodeRoleModel({
    query: async (sql, params = []) => {
      statements.push({ sql, params });
    },
  });

  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /is_active = TRUE/);
  assert.deepEqual(statements[0].params[0], [...KODE_OPERATING_ROLE_KEYS]);
  assert.match(statements[1].sql, /is_active = FALSE/);
  assert.match(statements[1].sql, /is_default_signup_role = FALSE/);
  assert.deepEqual(statements[1].params[0], [...KODE_LEGACY_ROLE_KEYS]);
});

test('role cleanup does not treat {all:true} as a Work wildcard', () => {
  assert.equal(hasPermission({ all: true }, 'work.boards.read'), false);
  assert.equal(
    hasPermission(
      { content_assets: true, media_dashboard: true },
      'work.boards.read',
    ),
    false,
  );
});

test('nested work permissions grant board and card actions', () => {
  const permissions = {
    work: {
      boards: { read: true, create: true, update: true },
      cards: { read: true, create: true, update: true },
    },
  };

  assert.equal(hasPermission(permissions, 'work.boards.read'), true);
  assert.equal(hasPermission(permissions, 'work.cards.create'), true);
  assert.equal(hasPermission(permissions, 'work.cards.delete'), false);
});
