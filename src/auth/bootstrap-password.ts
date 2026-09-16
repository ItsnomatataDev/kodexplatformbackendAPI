import { ConflictError, NotFoundError } from '../http/errors.js';
import type { TransactionClient } from '../db/transaction.js';
import { isUuid } from './uuid.js';
import { hashPassword, validatePassword } from './passwords.js';
import type { AuthStore } from './store.js';

export type BootstrapPasswordInput = {
  appEnv: string;
  userId: string;
  password: string;
  force?: boolean;
  store: AuthStore;
  withTransaction?: <T>(
    work: (client: TransactionClient) => Promise<T>,
  ) => Promise<T>;
};

export type BootstrapPasswordResult = {
  userId: string;
  email: string | null;
  replaced: boolean;
};

const forbiddenPasswordFlags = [
  '--password',
  '-p',
  '--pass',
  '--passwd',
  '--new-password',
  '--secret',
];

export function assertDevelopmentBootstrap(appEnv: string): void {
  if (appEnv !== 'development') {
    throw new Error(
      'Refusing to bootstrap passwords outside APP_ENV=development.',
    );
  }
}

export function parseBootstrapCommandLine(argv: string[]): {
  userId: string;
  force: boolean;
} {
  for (const arg of argv) {
    const name = arg.split('=')[0];

    if (
      forbiddenPasswordFlags.includes(name) ||
      name.startsWith('--password')
    ) {
      throw new Error(
        'Passwords cannot be passed as command-line arguments. Use the interactive prompt.',
      );
    }
  }

  let userId: string | undefined;
  let force = false;
  const unknown: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--force') {
      force = true;
      continue;
    }

    if (arg === '--user-id') {
      userId = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--user-id=')) {
      userId = arg.slice('--user-id='.length);
      continue;
    }

    unknown.push(arg);
  }

  if (unknown.length > 0) {
    throw new Error(
      'Usage: npm run auth:bootstrap-password -- --user-id <identity.users.id> [--force]',
    );
  }

  if (!userId || !isUuid(userId)) {
    throw new Error('user-id must be a UUID from identity.users.id.');
  }

  return { userId, force };
}

export async function bootstrapDevelopmentPassword(
  input: BootstrapPasswordInput,
): Promise<BootstrapPasswordResult> {
  assertDevelopmentBootstrap(input.appEnv);

  if (!isUuid(input.userId)) {
    throw new Error('user-id must be a UUID from identity.users.id.');
  }

  const identity = await input.store.findLoginIdentityById(input.userId);

  if (!identity) {
    throw new NotFoundError(
      'IDENTITY_NOT_FOUND',
      'No identity.users row exists for that id.',
    );
  }

  const replaced = Boolean(identity.passwordHash);

  if (replaced && !input.force) {
    throw new ConflictError(
      'PASSWORD_CREDENTIAL_EXISTS',
      'A password credential already exists. Re-run with --force to replace it.',
    );
  }

  validatePassword(input.password, identity.email);
  const passwordHash = await hashPassword(input.password);

  if (input.withTransaction) {
    await input.withTransaction(async (client) => {
      await input.store.upsertPasswordHash(
        identity.userId,
        passwordHash,
        client,
      );
    });
  } else {
    await input.store.upsertPasswordHash(identity.userId, passwordHash);
  }

  return {
    userId: identity.userId,
    email: identity.email,
    replaced,
  };
}
