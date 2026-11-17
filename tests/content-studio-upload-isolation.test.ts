import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('upload part claims lock per user, not the whole organization', () => {
  const source = readFileSync(
    join(root, 'src/content/resumable/postgres-repository.ts'),
    'utf8',
  );
  assert.match(source, /upload-part-quota:\$\{organizationId\}:\$\{createdBy\}/);
  assert.doesNotMatch(source, /upload-part-quota-org:/);
});

test('VPS compose isolates Content Studio uploads on port 3002', () => {
  const source = readFileSync(join(root, 'docker-compose.vps.yml'), 'utf8');
  assert.match(source, /container_name: kode-vps-api-uploads/);
  assert.match(source, /PORT: 3002/);
  assert.match(source, /KODE_PROCESS_ROLE: uploads/);
});
