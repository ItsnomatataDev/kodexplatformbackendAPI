export type AppliedMigration = { version: string; description: string };

export function migrationIdentity(filename: string) {
  const match = /^(\d{4})_([\w-]+)\.sql$/.exec(filename);
  if (!match) throw new Error(`Invalid migration filename: ${filename}`);
  return { filename, version: match[1], description: match[2] };
}

/** Resolve identities, never rewrite legacy ledger rows. Unknown history fails closed. */
export function planMigrations(files: string[], applied: AppliedMigration[]) {
  const migrations = [...files].sort().map(migrationIdentity);
  migrations.forEach((migration, index) => {
    if (migration.version !== String(index + 1).padStart(4, '0')) {
      throw new Error(`Migration versions must be consecutive and unique: ${migration.filename}`);
    }
  });
  const completed = new Set<string>();
  for (const row of applied) {
    // The time-entry migration collided with the VPS media migration at 0058.
    // Its SQL is unchanged at 0060. Either legacy history is supported.
    const filename = row.version === '0058' && row.description === 'time_entry_auto_stop'
      ? '0060_time_entry_auto_stop.sql'
      : /^\d{4}$/.test(row.version)
        ? `${row.version}_${row.description}.sql`
        : row.version;
    const known = migrations.find(m => m.filename === filename && m.description === row.description);
    if (!known) throw new Error(`Unrecognized migration history: ${row.version}`);
    completed.add(filename);
  }
  return migrations.filter(m => !completed.has(m.filename));
}

/** The runner owns the transaction, including its ledger insert. */
export function migrationBody(sql: string): string {
  return sql.replace(/^\s*BEGIN\s*;([\s\S]*)COMMIT\s*;\s*$/i, '$1');
}
