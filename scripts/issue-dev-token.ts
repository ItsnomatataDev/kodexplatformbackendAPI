import { env } from '../src/config/env.js';
import { createDefaultAccessTokenService } from '../src/auth/defaults.js';
import { isUuid } from '../src/auth/uuid.js';
import { db } from '../src/db/pool.js';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readUserId(argv: string[]): string {
  const index = argv.indexOf('--user-id');

  if (index === -1 || !argv[index + 1]) {
    fail('Usage: npm run auth:issue-dev-token -- --user-id <identity.users.id>');
  }

  return argv[index + 1];
}

async function run() {
  if (env.appEnv !== 'development') {
    fail('Refusing to issue access tokens outside APP_ENV=development.');
  }

  const userId = readUserId(process.argv.slice(2));

  if (!isUuid(userId)) {
    fail('user-id must be a UUID from identity.users.id.');
  }

  const result = await db.query<{ id: string }>(
    `
      SELECT id
      FROM identity.users
      WHERE id = $1
    `,
    [userId],
  );

  if (result.rows.length === 0) {
    fail('No identity.users row exists for that id in this development database.');
  }

  const token = await createDefaultAccessTokenService().issue(userId);

  console.log(token);
}

run()
  .catch((error) => {
    console.error('Failed to issue development access token.');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await db.end();
  });
