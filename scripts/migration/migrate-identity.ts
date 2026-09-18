import fs from 'node:fs';
import path from 'node:path';
import { db } from '../../src/db/pool.js';
import { applyKodeRoleModel } from '../../src/organizations/role-model.js';
import type { PoolClient } from 'pg';


type LegacyRow = Record<string, string | null>;

const DEFAULT_SOURCE = path.resolve(
  process.env.LEGACY_EXPORT ??
    `${process.env.HOME}/Desktop/devprojects/POSTGRES-SERVER/backups/public-data-20260826T071806Z.sql`,
);

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');

function log(message: string) {
  console.log(`[identity-migration] ${message}`);
}

function fail(message: string): never {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

function decodeCopyValue(value: string): string | null {
  if (value === '\\N') {
    return null;
  }

  let output = '';

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];

    if (char !== '\\') {
      output += char;
      continue;
    }

    const next = value[i + 1];

    if (next === undefined) {
      output += '\\';
      continue;
    }

    switch (next) {
      case 't':
        output += '\t';
        i += 1;
        break;
      case 'n':
        output += '\n';
        i += 1;
        break;
      case 'r':
        output += '\r';
        i += 1;
        break;
      case 'b':
        output += '\b';
        i += 1;
        break;
      case 'f':
        output += '\f';
        i += 1;
        break;
      case 'v':
        output += '\v';
        i += 1;
        break;
      case '\\':
        output += '\\';
        i += 1;
        break;
      default:
        output += next;
        i += 1;
        break;
    }
  }

  return output;
}

function extractCopyRows(
  sql: string,
  tableName: string,
): LegacyRow[] {
  const lines = sql.split(/\r?\n/);

  const headerIndex = lines.findIndex((line) =>
    line.startsWith(`COPY public.${tableName} (`),
  );

  if (headerIndex === -1) {
    throw new Error(`COPY block not found for public.${tableName}`);
  }

  const header = lines[headerIndex];

  const match = header.match(
    new RegExp(
      `^COPY public\\.${tableName} \\((.+)\\) FROM stdin;$`,
    ),
  );

  if (!match) {
    throw new Error(
      `Unable to parse COPY header for public.${tableName}`,
    );
  }

  const columns = match[1]
    .split(',')
    .map((column) => column.trim());

  const rows: LegacyRow[] = [];

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];

    if (line === '\\.') {
      break;
    }

    if (!line) {
      continue;
    }

    const values = line.split('\t');

    if (values.length !== columns.length) {
      throw new Error(
        `Column mismatch in public.${tableName} at source line ${
          i + 1
        }: expected ${columns.length}, got ${values.length}`,
      );
    }

    const row: LegacyRow = {};

    columns.forEach((column, index) => {
      row[column] = decodeCopyValue(values[index]);
    });

    rows.push(row);
  }

  return rows;
}

function jsonOrDefault(
  value: string | null,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);

    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return parsed;
    }

    return fallback;
  } catch {
    return fallback;
  }
}

function booleanValue(value: string | null, fallback = false) {
  if (value === null) {
    return fallback;
  }

  return value === 't' || value === 'true';
}

function normalizeEmail(email: string | null) {
  return email?.trim().toLowerCase() || null;
}

function normalizeUsername(username: string | null) {
  return username?.trim().toLowerCase() || null;
}

function normalizeRoleKey(role: string | null) {
  return role?.trim() || null;
}

function countDuplicates(
  rows: LegacyRow[],
  key: (row: LegacyRow) => string | null,
) {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const value = key(row);

    if (!value) {
      continue;
    }

    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()].filter(([, count]) => count > 1);
}

async function createIngestionJob(
  sourceReference: string,
  statistics: Record<string, unknown>,
) {
  const sourceResult = await db.query(
    `
      INSERT INTO ingestion.sources (
        name,
        source_type,
        description,
        configuration
      )
      VALUES (
        $1,
        'legacy_export',
        $2,
        $3
      )
      RETURNING id
    `,
    [
      'legacy-supabase-public-data',
      'Legacy Supabase PostgreSQL public-data export',
      JSON.stringify({
        source_system: 'supabase',
        export_file: sourceReference,
      }),
    ],
  );

  const sourceId = sourceResult.rows[0].id;

  const jobResult = await db.query(
    `
      INSERT INTO ingestion.jobs (
        source_id,
        job_type,
        status,
        source_reference,
        input_filename,
        input_mime_type,
        input_size_bytes,
        mapping_version,
        configuration,
        statistics
      )
      VALUES (
        $1,
        'migration',
        'processing',
        $2,
        $3,
        'application/sql',
        $4,
        'identity-v1',
        $5,
        $6
      )
      RETURNING id
    `,
    [
      sourceId,
      sourceReference,
      path.basename(sourceReference),
      fs.statSync(sourceReference).size,
      JSON.stringify({
        tables: [
          'organizations',
          'profiles',
          'organization_roles',
          'organization_members',
        ],
        mode: apply ? 'apply' : 'dry-run',
      }),
      JSON.stringify(statistics),
    ],
  );

  return {
    sourceId,
    jobId: jobResult.rows[0].id as string,
  };
}

async function finishJob(
  jobId: string,
  status: 'completed' | 'failed' | 'partial',
  statistics: Record<string, unknown>,
) {
  await db.query(
    `
      UPDATE ingestion.jobs
      SET
        status = $2,
        statistics = $3,
        completed_at = NOW()
      WHERE id = $1
    `,
    [jobId, status, JSON.stringify(statistics)],
  );
}

async function recordIssue(
  jobId: string,
  issueType: string,
  severity: 'warning' | 'error' | 'critical',
  description: string,
  suggestedValue?: unknown,
) {
  await db.query(
    `
      INSERT INTO ingestion.quality_issues (
        job_id,
        issue_type,
        severity,
        description,
        suggested_value
      )
      VALUES ($1, $2, $3, $4, $5)
    `,
    [
      jobId,
      issueType,
      severity,
      description,
      suggestedValue === undefined
        ? null
        : JSON.stringify(suggestedValue),
    ],
  );
}

async function insertOrganizations(
 client: PoolClient,
 rows: LegacyRow[],
) {
  for (const row of rows) {
    await client.query(
      `
        INSERT INTO organizations.organizations (
          id,
          name,
          slug,
          timezone,
          is_active,
          settings,
          created_at,
          updated_at,
          social_media_enabled,
          social_media_settings,
          leave_settings,
          is_system_organization,
          access_status,
          suspended_reason,
          suspended_at,
          suspended_by,
          logo_url,
          primary_color,
          secondary_color,
          custom_domain,
          subdomain,
          status,
          is_system_owner,
          legacy_source,
          legacy_id
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
          $16,$17,$18,$19,$20,$21,$22,$23,'supabase',$1
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          slug = EXCLUDED.slug,
          timezone = EXCLUDED.timezone,
          is_active = EXCLUDED.is_active,
          settings = EXCLUDED.settings,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.id,
        row.name,
        row.slug,
        row.timezone,
        booleanValue(row.is_active, true),
        JSON.stringify(jsonOrDefault(row.settings)),
        row.created_at,
        row.updated_at,
        booleanValue(row.social_media_enabled),
        JSON.stringify(jsonOrDefault(row.social_media_settings)),
        JSON.stringify(jsonOrDefault(row.leave_settings)),
        booleanValue(row.is_system_organization),
        row.access_status ?? 'active',
        row.suspended_reason,
        row.suspended_at,
        row.suspended_by,
        row.logo_url,
        row.primary_color,
        row.secondary_color,
        row.custom_domain,
        row.subdomain,
        row.status ?? 'active',
        booleanValue(row.is_system_owner),
      ],
    );
  }
}

async function insertUsers(
  client: PoolClient,
  rows: LegacyRow[],
) {
  for (const row of rows) {
    const email = row.email;
    const emailNormalized = normalizeEmail(email);

    await client.query(
      `
        INSERT INTO identity.users (
          id,
          email,
          email_normalized,
          created_at,
          updated_at,
          is_active,
          account_status,
          deleted_at,
          legacy_source,
          legacy_id
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,'supabase',$1
        )
        ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email,
          email_normalized = EXCLUDED.email_normalized,
          is_active = EXCLUDED.is_active,
          account_status = EXCLUDED.account_status,
          deleted_at = EXCLUDED.deleted_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.id,
        email,
        emailNormalized,
        row.created_at,
        row.updated_at,
        booleanValue(row.is_active, true),
        row.account_status ?? 'pending',
        row.deleted_at,
      ],
    );
  }
}

async function insertProfiles(
  client: PoolClient,
  rows: LegacyRow[],
) {
  for (const row of rows) {
    await client.query(
      `
        INSERT INTO identity.user_profiles (
          user_id,
          full_name,
          phone,
          avatar_url,
          job_title,
          department,
          employee_code,
          username,
          office_id,
          primary_role_key,
          metadata,
          email_preferences,
          last_seen_at,
          is_suspended,
          suspended_at,
          suspended_by,
          suspension_reason,
          leave_days_total,
          leave_days_remaining,
          manager_pin_hash,
          manager_pin_set_at,
          manager_pin_last_changed_at,
          approved_at,
          approved_by,
          rejected_at,
          rejected_by,
          rejection_reason,
          deleted_at,
          deleted_by,
          deletion_reason,
          created_at,
          updated_at,
          legacy_source,
          legacy_id
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
          $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,
          $29,$30,$31,$32,'supabase',$1
        )
        ON CONFLICT (user_id) DO UPDATE SET
          full_name = EXCLUDED.full_name,
          phone = EXCLUDED.phone,
          avatar_url = EXCLUDED.avatar_url,
          job_title = EXCLUDED.job_title,
          department = EXCLUDED.department,
          employee_code = EXCLUDED.employee_code,
          username = EXCLUDED.username,
          office_id = EXCLUDED.office_id,
          primary_role_key = EXCLUDED.primary_role_key,
          metadata = EXCLUDED.metadata,
          email_preferences = EXCLUDED.email_preferences,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.id,
        row.full_name,
        row.phone,
        row.avatar_url,
        row.job_title,
        row.department,
        row.employee_code,
        normalizeUsername(row.username),
        row.office_id,
        normalizeRoleKey(row.organization_role_key),
        JSON.stringify(jsonOrDefault(row.metadata)),
        JSON.stringify(jsonOrDefault(row.email_preferences)),
        row.last_seen_at,
        booleanValue(row.is_suspended),
        row.suspended_at,
        row.suspended_by,
        row.suspension_reason,
        row.leave_days_total
          ? Number(row.leave_days_total)
          : 22,
        row.leave_days_remaining
          ? Number(row.leave_days_remaining)
          : 22,
        row.manager_pin_hash,
        row.manager_pin_set_at,
        row.manager_pin_last_changed_at,
        row.approved_at,
        row.approved_by,
        row.rejected_at,
        row.rejected_by,
        row.rejection_reason,
        row.deleted_at,
        row.deleted_by,
        row.deletion_reason,
        row.created_at,
        row.updated_at,
      ],
    );
  }
}

async function insertRoles(
  client: PoolClient,
  rows: LegacyRow[],
) {
  for (const row of rows) {
    await client.query(
      `
        INSERT INTO organizations.roles (
          id,
          organization_id,
          role_key,
          role_label,
          description,
          department,
          is_admin_role,
          is_manager_role,
          is_default_signup_role,
          requires_approval,
          is_active,
          permissions,
          created_by,
          created_at,
          updated_at,
          onboarding_config,
          department_access,
          updated_by,
          legacy_source,
          legacy_id
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
          $16,$17,$18,'supabase',$1
        )
        ON CONFLICT (id) DO UPDATE SET
          role_label = EXCLUDED.role_label,
          description = EXCLUDED.description,
          department = EXCLUDED.department,
          permissions = EXCLUDED.permissions,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.id,
        row.organization_id,
        row.role_key,
        row.role_label,
        row.description,
        row.department,
        booleanValue(row.is_admin_role),
        booleanValue(row.is_manager_role),
        booleanValue(row.is_default_signup_role),
        booleanValue(row.requires_approval, true),
        booleanValue(row.is_active, true),
        JSON.stringify(jsonOrDefault(row.permissions)),
        row.created_by,
        row.created_at,
        row.updated_at,
        JSON.stringify(jsonOrDefault(row.onboarding_config)),
        JSON.stringify(jsonOrDefault(row.department_access)),
        row.updated_by,
      ],
    );
  }
}

async function insertMemberships(
  client: PoolClient,
  rows: LegacyRow[],
) {
  for (const row of rows) {
    const roleKey = normalizeRoleKey(row.role);

    await client.query(
      `
        INSERT INTO organizations.memberships (
          id,
          organization_id,
          user_id,
          role_id,
          role_key,
          status,
          joined_at,
          invited_by,
          notes,
          removed_at,
          removed_by,
          created_at,
          updated_at,
          legacy_source,
          legacy_id
        )
        VALUES (
          $1,
          $2,
          $3,
          (
            SELECT id
            FROM organizations.roles
            WHERE organization_id = $2
              AND role_key = $4
            LIMIT 1
          ),
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          'supabase',
          $1
        )
        ON CONFLICT (id) DO UPDATE SET
          role_id = EXCLUDED.role_id,
          role_key = EXCLUDED.role_key,
          status = EXCLUDED.status,
          notes = EXCLUDED.notes,
          removed_at = EXCLUDED.removed_at,
          removed_by = EXCLUDED.removed_by,
          updated_at = EXCLUDED.updated_at
      `,
      [
        row.id,
        row.organization_id,
        row.user_id,
        roleKey,
        row.status ?? 'active',
        row.joined_at,
        row.invited_by,
        row.notes,
        row.removed_at,
        row.removed_by,
        row.created_at,
        row.updated_at,
      ],
    );
  }
}

type IdentityReconciliation = {
  organizations: number;
  users: number;
  profiles: number;
  roles: number;
  memberships: number;
  organizations_with_legacy_trace: number;
  users_with_legacy_trace: number;
  profiles_with_legacy_trace: number;
  roles_with_legacy_trace: number;
  memberships_with_legacy_trace: number;
};

async function reconcileIdentity(
  client: PoolClient,
): Promise<IdentityReconciliation> {
  const result = await client.query<IdentityReconciliation>(`
    SELECT
      (SELECT COUNT(*)::int FROM organizations.organizations) AS organizations,
      (SELECT COUNT(*)::int FROM identity.users) AS users,
      (SELECT COUNT(*)::int FROM identity.user_profiles) AS profiles,
      (SELECT COUNT(*)::int FROM organizations.roles) AS roles,
      (SELECT COUNT(*)::int FROM organizations.memberships) AS memberships,
      (
        SELECT COUNT(*)::int
        FROM organizations.organizations
        WHERE legacy_source = 'supabase' AND legacy_id = id
      ) AS organizations_with_legacy_trace,
      (
        SELECT COUNT(*)::int
        FROM identity.users
        WHERE legacy_source = 'supabase' AND legacy_id = id
      ) AS users_with_legacy_trace,
      (
        SELECT COUNT(*)::int
        FROM identity.user_profiles
        WHERE legacy_source = 'supabase' AND legacy_id = user_id
      ) AS profiles_with_legacy_trace,
      (
        SELECT COUNT(*)::int
        FROM organizations.roles
        WHERE legacy_source = 'supabase' AND legacy_id = id
      ) AS roles_with_legacy_trace,
      (
        SELECT COUNT(*)::int
        FROM organizations.memberships
        WHERE legacy_source = 'supabase' AND legacy_id = id
      ) AS memberships_with_legacy_trace
  `);

  return result.rows[0];
}

function assertReconciliation(
  reconciliation: IdentityReconciliation,
  sourceCounts: {
    organizations: number;
    profiles: number;
    roles: number;
    memberships: number;
  },
) {
  const expected = {
    organizations: sourceCounts.organizations,
    users: sourceCounts.profiles,
    profiles: sourceCounts.profiles,
    roles: sourceCounts.roles,
    memberships: sourceCounts.memberships,
    organizations_with_legacy_trace: sourceCounts.organizations,
    users_with_legacy_trace: sourceCounts.profiles,
    profiles_with_legacy_trace: sourceCounts.profiles,
    roles_with_legacy_trace: sourceCounts.roles,
    memberships_with_legacy_trace: sourceCounts.memberships,
  };

  const mismatches = Object.entries(expected).filter(
    ([key, value]) =>
      reconciliation[key as keyof IdentityReconciliation] !== value,
  );

  if (mismatches.length) {
    throw new Error(
      `Target reconciliation failed: ${mismatches
        .map(
          ([key, value]) =>
            `${key} expected ${value}, got ${
              reconciliation[key as keyof IdentityReconciliation]
            }`,
        )
        .join('; ')}`,
    );
  }
}

async function main() {
  log(`Source: ${DEFAULT_SOURCE}`);
  log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);

  if (!fs.existsSync(DEFAULT_SOURCE)) {
    fail(`Legacy export does not exist: ${DEFAULT_SOURCE}`);
  }

  const sql = fs.readFileSync(DEFAULT_SOURCE, 'utf8');

  log('Extracting legacy COPY blocks...');

  const organizations = extractCopyRows(sql, 'organizations');
  const profiles = extractCopyRows(sql, 'profiles');
  const members = extractCopyRows(
    sql,
    'organization_members',
  );
  const roles = extractCopyRows(
    sql,
    'organization_roles',
  );

  const orgIds = new Set(
    organizations
      .map((row) => row.id)
      .filter((id): id is string => Boolean(id)),
  );

  const profileIds = new Set(
    profiles
      .map((row) => row.id)
      .filter((id): id is string => Boolean(id)),
  );

  const duplicateOrganizations = countDuplicates(
    organizations,
    (row) => row.id,
  );

  const duplicateProfiles = countDuplicates(
    profiles,
    (row) => row.id,
  );

  const duplicateMembers = countDuplicates(
    members,
    (row) => row.id,
  );

  const duplicateRoles = countDuplicates(
    roles,
    (row) => row.id,
  );

  const orphanProfiles = profiles.filter(
    (row) =>
      row.organization_id !== null &&
      !orgIds.has(row.organization_id),
  );

  const orphanMembers = members.filter(
    (row) =>
      !orgIds.has(row.organization_id ?? '') ||
      !profileIds.has(row.user_id ?? ''),
  );

  const roleOrphans = roles.filter(
    (row) => !orgIds.has(row.organization_id ?? ''),
  );

  const statistics = {
    source_file: DEFAULT_SOURCE,
    mode: apply ? 'apply' : 'dry-run',
    source_counts: {
      organizations: organizations.length,
      profiles: profiles.length,
      organization_roles: roles.length,
      organization_members: members.length,
    },
    validation: {
      duplicate_organizations: duplicateOrganizations.length,
      duplicate_profiles: duplicateProfiles.length,
      duplicate_memberships: duplicateMembers.length,
      duplicate_roles: duplicateRoles.length,
      orphan_profiles: orphanProfiles.length,
      orphan_memberships: orphanMembers.length,
      orphan_roles: roleOrphans.length,
    },
  };

  const { jobId } = await createIngestionJob(
    DEFAULT_SOURCE,
    statistics,
  );

  try {
    for (const row of orphanProfiles) {
      await recordIssue(
        jobId,
        'orphan_profile_organization',
        'error',
        `Profile ${row.id} references missing organization ${row.organization_id}.`,
      );
    }

    for (const row of orphanMembers) {
      await recordIssue(
        jobId,
        'orphan_membership_reference',
        'error',
        `Membership ${row.id} references missing organization or user.`,
      );
    }

    for (const row of roleOrphans) {
      await recordIssue(
        jobId,
        'orphan_role_organization',
        'error',
        `Role ${row.id} references missing organization ${row.organization_id}.`,
      );
    }

    console.log('\n========================================');
    console.log('IDENTITY MIGRATION');
    console.log('========================================');
    console.log(`Organizations:       ${organizations.length}`);
    console.log(`Profiles:            ${profiles.length}`);
    console.log(`Roles:               ${roles.length}`);
    console.log(`Memberships:         ${members.length}`);
    console.log('----------------------------------------');
    console.log(
      `Duplicate orgs:      ${duplicateOrganizations.length}`,
    );
    console.log(
      `Duplicate profiles:  ${duplicateProfiles.length}`,
    );
    console.log(
      `Duplicate roles:     ${duplicateRoles.length}`,
    );
    console.log(
      `Duplicate members:   ${duplicateMembers.length}`,
    );
    console.log(
      `Orphan profiles:     ${orphanProfiles.length}`,
    );
    console.log(
      `Orphan memberships:  ${orphanMembers.length}`,
    );
    console.log(
      `Orphan roles:        ${roleOrphans.length}`,
    );
    console.log('========================================\n');

    if (!apply) {
      await finishJob(jobId, 'completed', {
        ...statistics,
        result: 'dry-run-no-target-data-written',
      });

      log('Dry run complete. No target data was written.');
      return;
    }

    if (
      duplicateOrganizations.length ||
      duplicateProfiles.length ||
      duplicateMembers.length ||
      duplicateRoles.length ||
      orphanProfiles.length ||
      orphanMembers.length ||
      roleOrphans.length
    ) {
      await finishJob(jobId, 'partial', {
        ...statistics,
        result: 'blocked-by-validation-issues',
      });

      fail(
        'Validation issues exist. Fix/review them before using --apply.',
      );
    }

    log('Beginning transactional import...');

    const client = await db.connect();

    try {
      await client.query('BEGIN');

      await insertOrganizations(client, organizations);
      log('Organizations imported.');

      await insertUsers(client, profiles);
      log('Users imported.');

      await insertProfiles(client, profiles);
      log('User profiles imported.');

      await insertRoles(client, roles);
      log('Roles imported.');

      await applyKodeRoleModel(client);
      log('Kode operating role model applied.');

      await insertMemberships(client, members);
      log('Memberships imported.');

      const reconciliation = await reconcileIdentity(client);

      assertReconciliation(reconciliation, {
        organizations: organizations.length,
        profiles: profiles.length,
        roles: roles.length,
        memberships: members.length,
      });

      log(`Target reconciliation passed: ${JSON.stringify(reconciliation)}`);

      await client.query('COMMIT');

      await finishJob(jobId, 'completed', {
        ...statistics,
        result: 'imported',
        reconciliation,
      });

      log('Identity migration completed successfully.');
    } catch (error) {
      await client.query('ROLLBACK');

      await finishJob(jobId, 'failed', {
        ...statistics,
        result: 'rolled-back',
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });

      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    console.error(error.message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\nMigration failed:', error);
  process.exit(1);
});
