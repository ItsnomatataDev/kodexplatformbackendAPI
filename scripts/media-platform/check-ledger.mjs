// Offline only: imports neither the database pool nor environment configuration.
import { readFile, readdir } from 'node:fs/promises';
import { planMigrations } from '../../dist/db/migration-plan.js';
const filename = process.argv[2];
if (!filename) throw new Error('Usage: node scripts/media-platform/check-ledger.mjs ledger.json');
const report = JSON.parse(await readFile(filename, 'utf8'));
if (!Array.isArray(report.ledger)) throw new Error('Expected inspect-ledger.sql JSON report');
const pending = planMigrations((await readdir(new URL('../../migrations/', import.meta.url))).filter(f => f.endsWith('.sql')), report.ledger);
console.log(JSON.stringify({recognizedHistory: true, pending: pending.map(m => m.filename),
  schemaReviewRequired: true, productionCompatibilityVerified: false}, null, 2));
